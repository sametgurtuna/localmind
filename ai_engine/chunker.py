from __future__ import annotations


def _split_bounds(text: str, chunk_size: int, overlap: int) -> list[tuple[int, int]]:
    """Compute (start, end) character offsets for overlapping chunks."""
    n = len(text)
    bounds: list[tuple[int, int]] = []
    start = 0
    half = chunk_size // 2

    while start < n:
        end = start + chunk_size

        if end < n:
            nl = text.rfind("\n", start + half, end + 1)
            if nl != -1:
                end = nl + 1
            else:
                sp = text.rfind(" ", start + half, end + 1)
                if sp != -1:
                    end = sp + 1
        else:
            end = n

        bounds.append((start, end))

        nxt = end - overlap
        if nxt <= start:  # guard against zero/negative progress
            nxt = end
        start = nxt

    return bounds


def chunk_text(
    text: str,
    chunk_size: int = 500,
    overlap: int = 50,
) -> list[str]:
    """Split text into overlapping chunks by character count, respecting line boundaries."""
    if not text or not text.strip():
        return []

    if len(text) <= chunk_size:
        return [text.strip()]

    chunks: list[str] = []
    for start, end in _split_bounds(text, chunk_size, overlap):
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
    return chunks


def chunk_text_with_lines(
    text: str,
    chunk_size: int = 500,
    overlap: int = 50,
) -> list[tuple[str, int, int]]:
    """Split text into chunks and return (chunk_text, line_start, line_end) tuples.

    line_start and line_end are 1-indexed line numbers. Line numbers are derived
    with str.count(), which runs at C speed, instead of walking the text in Python.
    """
    if not text or not text.strip():
        return []

    if len(text) <= chunk_size:
        return [(text.strip(), 1, text.count("\n") + 1)]

    results: list[tuple[str, int, int]] = []

    # Cursor tracking the last offset whose line number we already know, so each
    # chunk only counts the newlines between the previous chunk start and this one.
    cursor_pos = 0
    cursor_line = 1

    for start, end in _split_bounds(text, chunk_size, overlap):
        chunk = text[start:end].strip()
        if not chunk:
            continue

        if start >= cursor_pos:
            ls = cursor_line + text.count("\n", cursor_pos, start)
        else:
            ls = cursor_line - text.count("\n", start, cursor_pos)
        cursor_pos, cursor_line = start, ls

        le = ls + text.count("\n", start, end)
        results.append((chunk, ls, le))

    return results
