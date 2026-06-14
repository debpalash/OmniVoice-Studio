"""Import plain text / EPUB into the chapter-delimited script the audiobook
parser understands.

Both helpers are pure (bytes/str in, script-str out) so they're unit-tested
without a server. EPUB parsing is **stdlib only** (zipfile + ElementTree +
html.parser) — no new dependency, no network, consistent with the local-first
guarantee. The output is the same ``# Heading`` + body grammar
:func:`services.audiobook.parse_audiobook_script` already consumes, so import is
just a front door onto the existing pipeline.
"""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

# A line that *starts* with a chapter keyword and is short enough to be a title
# (not a sentence that happens to begin with "Chapter"). Anchored, no ambiguous
# quantifiers → ReDoS-safe and applied per-line (short input) anyway.
_CH_RE = re.compile(r"^(?:chapter|part|book|prologue|epilogue|section)\b", re.IGNORECASE)
# Already-present Markdown H1 — if the text has any, we leave it untouched.
_H1_RE = re.compile(r"^[ \t]*#[ \t]+\S", re.MULTILINE)
_CHAPTER_TITLE_MAX = 60
# Zip-bomb / OOM guards for EPUB ingestion: per-entry and cumulative caps on
# *uncompressed* bytes read from the archive.
_EPUB_MAX_ENTRY_BYTES = 25 * 1024 * 1024
_EPUB_MAX_TOTAL_BYTES = 300 * 1024 * 1024


def chapterize_plaintext(text: str) -> str:
    """Insert ``# `` headings ahead of obvious chapter-title lines.

    No-op if the text already has Markdown H1 headings (the user has structured
    it). Otherwise short standalone lines beginning with a chapter keyword
    (``Chapter 3``, ``Prologue`` …) become headings; everything else is left
    verbatim. Text with no detectable breaks falls through as a single chapter.
    """
    text = text or ""
    if _H1_RE.search(text):
        return text
    out = []
    for line in text.split("\n"):
        s = line.strip()
        if s and len(s) <= _CHAPTER_TITLE_MAX and _CH_RE.match(s):
            out.append(f"# {s}")
        else:
            out.append(line)
    return "\n".join(out)


class _TextExtractor(HTMLParser):
    """Collect visible text from XHTML, dropping script/style and collapsing
    whitespace. First <h1>/<h2>/<title> seen is kept as the chapter title."""

    _SKIP = {"script", "style", "head"}
    _BREAK = {"p", "br", "div", "h1", "h2", "h3", "li", "tr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False
        self.title = ""

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        if tag in ("h1", "h2", "title") and not self.title:
            self._in_title = True
        if tag in self._BREAK:
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        if tag in ("h1", "h2", "title"):
            self._in_title = False

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._in_title:
            # The first heading becomes the chapter's `# Title` (metadata, not
            # narrated) — capture it but keep it out of the body. Later headings
            # (title already set) fall through and are narrated as subheadings.
            if not self.title:
                self.title = data.strip()
            return
        self._parts.append(data)

    def text(self) -> str:
        raw = "".join(self._parts)
        # Collapse runs of blank lines / trailing spaces into tidy paragraphs.
        lines = [ln.strip() for ln in raw.split("\n")]
        out: list[str] = []
        for ln in lines:
            if ln or (out and out[-1]):
                out.append(ln)
        return "\n".join(out).strip()


def _html_to_title_body(xhtml: str) -> tuple[str, str]:
    p = _TextExtractor()
    try:
        p.feed(xhtml)
    except Exception:
        pass
    return p.title, p.text()


_OPF_NS = {"opf": "http://www.idpf.org/2007/opf", "c": "urn:oasis:names:tc:opendocument:xmlns:container"}


def _opf_path(zf: zipfile.ZipFile) -> str:
    container = zf.read("META-INF/container.xml")
    # The EPUB is a local file the user chose to import (not a remote/untrusted
    # surface); stdlib ElementTree doesn't expand external entities by default.
    root = ET.fromstring(container)  # nosec B314
    rootfile = root.find(".//c:rootfiles/c:rootfile", _OPF_NS)
    if rootfile is None or not rootfile.get("full-path"):
        raise ValueError("EPUB container.xml has no rootfile")
    return rootfile.get("full-path")


def epub_to_chapter_script(
    data: bytes,
    *,
    max_entry_bytes: int = _EPUB_MAX_ENTRY_BYTES,
    max_total_bytes: int = _EPUB_MAX_TOTAL_BYTES,
) -> str:
    """Convert EPUB bytes into a ``# Chapter`` / body script in spine order.

    Reads the OPF manifest + spine (the publisher's reading order), extracts
    each document's title + visible text, and emits one ``# Title`` block per
    document with renderable text. ``max_entry_bytes`` / ``max_total_bytes``
    bound the *uncompressed* bytes read (zip-bomb guard). Raises ``ValueError``
    on a malformed EPUB.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ValueError(f"not a valid EPUB (zip) file: {e}") from e

    opf_path = _opf_path(zf)
    opf = ET.fromstring(zf.read(opf_path))  # nosec B314 — local user EPUB; see _opf_path
    base = posixpath.dirname(opf_path)

    manifest: dict[str, str] = {}
    for item in opf.findall(".//opf:manifest/opf:item", _OPF_NS):
        iid, href = item.get("id"), item.get("href")
        if iid and href:
            manifest[iid] = href

    blocks: list[str] = []
    names = set(zf.namelist())
    total = 0  # cumulative uncompressed bytes read — zip-bomb guard
    for ref in opf.findall(".//opf:spine/opf:itemref", _OPF_NS):
        href = manifest.get(ref.get("idref") or "")
        if not href:
            continue
        full = posixpath.normpath(posixpath.join(base, href)) if base else href
        if full not in names:
            continue
        # Bound decompression: skip an absurdly large entry, and stop once the
        # cumulative uncompressed size crosses the ceiling (defends against a
        # zip bomb / a maliciously huge chapter exhausting memory).
        try:
            info = zf.getinfo(full)
        except KeyError:
            continue
        if info.file_size > max_entry_bytes:
            continue
        if total + info.file_size > max_total_bytes:
            break
        try:
            raw = zf.read(full)
        except KeyError:
            continue
        total += len(raw)
        title, body = _html_to_title_body(raw.decode("utf-8", "ignore"))
        if not body.strip():
            continue  # nav docs, empty pages
        title = title or f"Chapter {len(blocks) + 1}"
        blocks.append(f"# {title}\n\n{body}")

    if not blocks:
        raise ValueError("no readable chapters found in the EPUB")
    return "\n\n".join(blocks)


# Page-count ceiling for PDF ingestion — a defence against a pathological
# document tying up the worker. 5000 pages comfortably covers any real book.
_PDF_MAX_PAGES = 5000


def pdf_to_chapter_script(data: bytes, *, max_pages: int = _PDF_MAX_PAGES) -> str:
    """Convert PDF bytes into a ``# Chapter`` / body script.

    Extracts the embedded text layer page-by-page (in page order), joins it,
    and runs it through :func:`chapterize_plaintext` so ``Chapter N`` /
    ``Prologue`` lines become headings — same grammar EPUB and plaintext emit.
    Unlike EPUB this needs a real parser (``pypdf``, pure-Python, no native
    deps → identical on every platform).

    Limitations surfaced as ``ValueError`` (the route maps these to a 400 with
    the message, so the user gets actionable feedback rather than a silent
    empty import):

    * **Scanned / image-only PDFs** have no text layer — there's nothing to
      extract without OCR, so we raise rather than return an empty script.
    * **Password-protected PDFs** that don't open with an empty password can't
      be read.
    """
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
    except (PdfReadError, OSError, ValueError) as e:
        raise ValueError(f"not a valid PDF file: {e}") from e

    if reader.is_encrypted:
        # Many PDFs are encrypted with an empty user password (owner-locked but
        # freely readable). Try that; a real password we can't supply.
        try:
            if reader.decrypt("") == 0:  # 0 == wrong password
                raise ValueError("PDF is password-protected")
        except (NotImplementedError, PdfReadError) as e:
            raise ValueError(f"can't read this encrypted PDF: {e}") from e

    pages = reader.pages
    if len(pages) > max_pages:
        raise ValueError(f"PDF has too many pages (max {max_pages})")

    parts: list[str] = []
    for page in pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 — one bad page shouldn't kill the import
            continue
        if text.strip():
            parts.append(text)

    if not parts:
        raise ValueError(
            "no extractable text — this looks like a scanned or image-only PDF")
    return chapterize_plaintext("\n\n".join(parts))
