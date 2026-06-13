"""Text / EPUB import → chapter-delimited script.

Pure helpers, tested without a server. The EPUB case builds a minimal valid
EPUB zip in memory (no fixture file, no new dep).
"""
from __future__ import annotations

import io
import zipfile

import pytest

from services.longform_import import chapterize_plaintext, epub_to_chapter_script
from services.audiobook import parse_audiobook_script


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
