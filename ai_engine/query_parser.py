"""Parse search queries with smart filters and natural language patterns.

Supports:
  type:pdf, type:py          -> file extension filter
  modified:today/week/month  -> modification time filter
  size:>1mb, size:<100kb     -> file size filter
  folder:Desktop             -> path contains filter

Natural language (TR/EN):
  "gecen hafta duzenledigim python dosyalari"
  "pdf files about budget"
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field


@dataclass
class ParsedQuery:
    text: str = ""
    where_clauses: list[str] = field(default_factory=list)

    @property
    def where(self) -> str | None:
        if not self.where_clauses:
            return None
        return " AND ".join(self.where_clauses)


_SIZE_UNITS = {"b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3}

_TYPE_FILTER = re.compile(r'\btype:(\w+)', re.IGNORECASE)
_MODIFIED_FILTER = re.compile(r'\bmodified:(\w+)', re.IGNORECASE)
_SIZE_FILTER = re.compile(r'\bsize:([<>])(\d+(?:\.\d+)?)(b|kb|mb|gb)\b', re.IGNORECASE)
_FOLDER_FILTER = re.compile(r'\bfolder:(\S+)', re.IGNORECASE)

# Natural language patterns (TR + EN)
_NL_TYPE_PATTERNS = [
    (re.compile(r'\bpython\s+dosya(?:lar[ıi]?)?\b', re.IGNORECASE), ".py"),
    (re.compile(r'\bpython\s+files?\b', re.IGNORECASE), ".py"),
    (re.compile(r"\bpdf['']?(?:ler|s)?\b", re.IGNORECASE), ".pdf"),
    (re.compile(r'\bword\s+(?:dosya|belge|doc)', re.IGNORECASE), ".docx"),
    (re.compile(r'\bexcel\s+(?:dosya|belge|file)', re.IGNORECASE), ".xlsx"),
    (re.compile(r'\bjson\s+dosya', re.IGNORECASE), ".json"),
    (re.compile(r'\bhtml\s+dosya', re.IGNORECASE), ".html"),
    (re.compile(r'\bjavascript\s+(?:dosya|file)', re.IGNORECASE), ".js"),
    (re.compile(r'\btypescript\s+(?:dosya|file)', re.IGNORECASE), ".ts"),
    (re.compile(r'\brust\s+(?:dosya|file)', re.IGNORECASE), ".rs"),
    (re.compile(r'\bmarkdown\s+(?:dosya|file)', re.IGNORECASE), ".md"),
]

_NL_TIME_PATTERNS = [
    (re.compile(r'\bgecen\s+hafta\b|\blast\s+week\b|\bge[cç]en\s+hafta\b', re.IGNORECASE), "week"),
    (re.compile(r'\bbu\s+hafta\b|\bthis\s+week\b', re.IGNORECASE), "week"),
    (re.compile(r'\bgecen\s+ay\b|\blast\s+month\b|\bge[cç]en\s+ay\b', re.IGNORECASE), "month"),
    (re.compile(r'\bbu\s+ay\b|\bthis\s+month\b', re.IGNORECASE), "month"),
    (re.compile(r'\bbugun\b|\bbug[uü]n\b|\btoday\b', re.IGNORECASE), "today"),
    (re.compile(r'\bdun\b|\bd[uü]n\b|\byesterday\b', re.IGNORECASE), "yesterday"),
]

# Words to strip from the final query text
_FILLER_WORDS = re.compile(
    r'\b(?:ile\s+ilgili|hakkinda|hakk[ıi]nda|about|related\s+to|'
    r'duzenledigim|d[uü]zenledi[gğ]im|edited|modified|'
    r'dosyalar[ıi]?|files?|belgeler[ıi]?|documents?)\b',
    re.IGNORECASE,
)


def _time_threshold(period: str) -> float:
    now = time.time()
    deltas = {
        "today": 86400,
        "yesterday": 172800,
        "week": 7 * 86400,
        "month": 30 * 86400,
    }
    return now - deltas.get(period, 7 * 86400)


def parse_query(raw: str) -> ParsedQuery:
    result = ParsedQuery()
    text = raw.strip()

    # Extract explicit filters
    for m in _TYPE_FILTER.finditer(text):
        ext = m.group(1).lower()
        if not ext.startswith("."):
            ext = f".{ext}"
        result.where_clauses.append(f"file_ext = '{ext}'")
    text = _TYPE_FILTER.sub("", text)

    for m in _MODIFIED_FILTER.finditer(text):
        period = m.group(1).lower()
        ts = _time_threshold(period)
        result.where_clauses.append(f"file_modified >= {ts}")
    text = _MODIFIED_FILTER.sub("", text)

    for m in _SIZE_FILTER.finditer(text):
        op = m.group(1)
        val = float(m.group(2))
        unit = m.group(3).lower()
        bytes_val = int(val * _SIZE_UNITS.get(unit, 1))
        result.where_clauses.append(f"file_size {'>' if op == '>' else '<'} {bytes_val}")
    text = _SIZE_FILTER.sub("", text)

    for m in _FOLDER_FILTER.finditer(text):
        folder = m.group(1)
        escaped = folder.replace("\\", "\\\\").replace("'", "\\'")
        result.where_clauses.append(f"file_path LIKE '%{escaped}%'")
    text = _FOLDER_FILTER.sub("", text)

    # Natural language patterns
    for pattern, ext in _NL_TYPE_PATTERNS:
        if pattern.search(text):
            already = any(f"file_ext = '{ext}'" in c for c in result.where_clauses)
            if not already:
                result.where_clauses.append(f"file_ext = '{ext}'")
            text = pattern.sub("", text)
            break

    for pattern, period in _NL_TIME_PATTERNS:
        if pattern.search(text):
            ts = _time_threshold(period)
            already = any("file_modified >=" in c for c in result.where_clauses)
            if not already:
                result.where_clauses.append(f"file_modified >= {ts}")
            text = pattern.sub("", text)
            break

    # Clean up filler words
    text = _FILLER_WORDS.sub("", text)
    text = re.sub(r'\s+', ' ', text).strip()

    result.text = text
    return result
