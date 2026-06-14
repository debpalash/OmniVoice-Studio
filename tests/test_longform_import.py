"""Text / EPUB import → chapter-delimited script.

Pure helpers, tested without a server. The EPUB case builds a minimal valid
EPUB zip in memory (no fixture file, no new dep).
"""
from __future__ import annotations

import io
import zipfile

import pytest

from services.longform_import import (
    chapterize_plaintext,
    epub_to_chapter_script,
    pdf_to_chapter_script,
)
from services.audiobook import parse_audiobook_script


# ── PDF fixture builder ───────────────────────────────────────────────────
# A minimal hand-built single-page PDF with a Helvetica text layer, so the PDF
# tests need no PDF-authoring dependency (mirrors the in-memory-EPUB approach).

def _make_pdf(lines: list[str], *, content_override: bytes | None = None) -> bytes:
    if content_override is not None:
        content = content_override
    else:
        show = "BT /F1 12 Tf 72 720 Td 16 TL\n"
        for ln in lines:
            esc = ln.replace("\\", "\\\\").replace("(", r"\(").replace(")", r"\)")
            show += f"({esc}) Tj T*\n"
        show += "ET"
        content = show.encode("latin-1")

    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
    xref_pos = out.tell()
    n = len(objs) + 1
    out.write(f"xref\n0 {n}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF".encode())
    return out.getvalue()


# ── plain text ──────────────────────────────────────────────────────────────

def test_plaintext_leaves_existing_h1_untouched():
    src = "# One\nhello\n\n# Two\nworld"
    assert chapterize_plaintext(src) == src


def test_plaintext_promotes_chapter_lines():
    src = "Chapter 1\nOnce upon a time.\n\nChapter 2\nThe end."
    out = chapterize_plaintext(src)
    assert "# Chapter 1" in out
    assert "# Chapter 2" in out
    # And it parses into two chapters.
    assert len(parse_audiobook_script(out).chapters) == 2


def test_plaintext_ignores_sentences_starting_with_keyword():
    # A long line beginning with "Chapter" is prose, not a heading.
    src = "Chapter books were her favorite thing in the whole wide world to read."
    out = chapterize_plaintext(src)
    assert not out.startswith("# ")


def test_plaintext_promotes_prologue_and_part():
    out = chapterize_plaintext("Prologue\nhi\n\nPart One\nthere")
    assert "# Prologue" in out and "# Part One" in out


def test_plaintext_no_breaks_is_single_chapter():
    out = chapterize_plaintext("just a flat blob of narration with no headings")
    assert len(parse_audiobook_script(out).chapters) == 1


# ── EPUB ────────────────────────────────────────────────────────────────────

def _make_epub(chapters: list[tuple[str, str]]) -> bytes:
    """Build a minimal EPUB: container.xml → content.opf (manifest+spine) →
    one XHTML per chapter."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?>'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        items, refs = [], []
        for i, (title, _body) in enumerate(chapters):
            items.append(f'<item id="c{i}" href="ch{i}.xhtml" media-type="application/xhtml+xml"/>')
            refs.append(f'<itemref idref="c{i}"/>')
        opf = (
            '<?xml version="1.0"?>'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
            f'<manifest>{"".join(items)}</manifest>'
            f'<spine>{"".join(refs)}</spine></package>'
        )
        z.writestr("OEBPS/content.opf", opf)
        for i, (title, body) in enumerate(chapters):
            z.writestr(
                f"OEBPS/ch{i}.xhtml",
                f"<html><head><title>{title}</title></head><body>"
                f"<h1>{title}</h1><p>{body}</p></body></html>",
            )
    return buf.getvalue()


def test_epub_extracts_chapters_in_spine_order():
    data = _make_epub([("Intro", "Welcome aboard."), ("Finale", "Goodbye now.")])
    script = epub_to_chapter_script(data)
    assert "# Intro" in script and "# Finale" in script
    assert "Welcome aboard." in script and "Goodbye now." in script
    assert script.index("Intro") < script.index("Finale")
    plan = parse_audiobook_script(script)
    assert len(plan.chapters) == 2


def test_epub_skips_empty_documents():
    data = _make_epub([("Real", "Has text."), ("Blank", "")])
    plan = parse_audiobook_script(epub_to_chapter_script(data))
    assert len(plan.chapters) == 1


def test_epub_strips_html_tags():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>'
                   '</rootfiles></container>')
        z.writestr("content.opf",
                   '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
                   '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>'
                   '<spine><itemref idref="a"/></spine></package>')
        z.writestr("a.xhtml",
                   "<html><body><h1>T</h1><p>Hello <b>bold</b> "
                   "<script>ignore()</script>world.</p></body></html>")
    script = epub_to_chapter_script(buf.getvalue())
    assert "ignore()" not in script
    assert "<b>" not in script
    assert "Hello" in script and "world." in script


def test_epub_bad_zip_raises_valueerror():
    with pytest.raises(ValueError):
        epub_to_chapter_script(b"not a zip at all")


def test_epub_total_size_cap_truncates():
    # Cap sits between one and two chapter docs (~1.1 KB uncompressed each), so
    # the first is read and the rest skipped. Caps passed directly (no
    # monkeypatch) so the bound holds regardless of module import path.
    data = _make_epub([("One", "x" * 1000), ("Two", "y" * 1000), ("Three", "z" * 1000)])
    plan = parse_audiobook_script(epub_to_chapter_script(data, max_total_bytes=1500))
    assert 1 <= len(plan.chapters) < 3  # capped before reading all three


def test_epub_oversize_entry_skipped():
    data = _make_epub([("Big", "x" * 500)])
    with pytest.raises(ValueError):  # the one entry exceeds the cap → all skipped
        epub_to_chapter_script(data, max_entry_bytes=50)


# ── PDF ──────────────────────────────────────────────────────────────────

def test_pdf_extracts_and_chapterizes():
    data = _make_pdf(["Chapter 1", "Once upon a time.", "Chapter 2", "The end."])
    script = pdf_to_chapter_script(data)
    # Chapter-keyword lines from the extracted text become headings …
    assert "# Chapter 1" in script
    assert "# Chapter 2" in script
    # … and the body survives.
    assert "Once upon a time." in script
    # And it parses into two chapters via the shared grammar.
    assert len(parse_audiobook_script(script).chapters) == 2


def test_pdf_without_chapter_markers_is_single_chapter():
    data = _make_pdf(["Just some flowing prose.", "With no chapter headings at all."])
    script = pdf_to_chapter_script(data)
    assert "With no chapter headings" in script
    assert len(parse_audiobook_script(script).chapters) == 1


def test_pdf_corrupt_raises_valueerror():
    with pytest.raises(ValueError):
        pdf_to_chapter_script(b"this is definitely not a pdf")


def test_pdf_image_only_raises_actionable_error():
    # A valid PDF whose page has no text-showing operators → nothing to extract.
    data = _make_pdf([], content_override=b"q Q")  # graphics-only, no BT/Tj
    with pytest.raises(ValueError, match="scanned or image-only"):
        pdf_to_chapter_script(data)


def test_pdf_too_many_pages_guard():
    data = _make_pdf(["Chapter 1", "Hi."])
    with pytest.raises(ValueError, match="too many pages"):
        pdf_to_chapter_script(data, max_pages=0)
