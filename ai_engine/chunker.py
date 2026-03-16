from __future__ import annotations


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
    start = 0

    while start < len(text):
        end = start + chunk_size

        if end < len(text):
            nl = text.rfind("\n", start + chunk_size // 2, end + 1)
            if nl != -1:
                end = nl + 1
            else:
                sp = text.rfind(" ", start + chunk_size // 2, end + 1)
                if sp != -1:
                    end = sp + 1

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        start = end - overlap
        if start >= len(text):
            break

    return chunks


def chunk_text_with_lines(
    text: str,
    chunk_size: int = 500,
    overlap: int = 50,
) -> list[tuple[str, int, int]]:
    """Split text into chunks and return (chunk_text, line_start, line_end) tuples.

    line_start and line_end are 1-indexed line numbers.
    """
    if not text or not text.strip():
        return []

    # Pre-compute character offset -> line number mapping
    line_starts: list[int] = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            line_starts.append(i + 1)

    def char_to_line(pos: int) -> int:
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= pos:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1  # 1-indexed

    if len(text) <= chunk_size:
        total_lines = text.count("\n") + 1
        return [(text.strip(), 1, total_lines)]

    results: list[tuple[str, int, int]] = []
    start = 0

    while start < len(text):
        end = start + chunk_size

        if end < len(text):
            nl = text.rfind("\n", start + chunk_size // 2, end + 1)
            if nl != -1:
                end = nl + 1
            else:
                sp = text.rfind(" ", start + chunk_size // 2, end + 1)
                if sp != -1:
                    end = sp + 1

        chunk = text[start:end].strip()
        if chunk:
            ls = char_to_line(start)
            le = char_to_line(min(end - 1, len(text) - 1))
            results.append((chunk, ls, le))

        start = end - overlap
        if start >= len(text):
            break

    return results
