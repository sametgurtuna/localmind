from __future__ import annotations

import os
import time
from pathlib import Path

from rapidfuzz import fuzz

# Cache scanned file list to avoid re-walking filesystem every search
_file_cache: list[tuple[str, str]] = []  # (filename, full_path)
_cache_folders: list[str] = []
_cache_time: float = 0
_CACHE_TTL = 60  # refresh every 60 seconds

SKIP_DIRS = frozenset({
    "node_modules", "__pycache__", ".git", "venv", ".venv",
    ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
    ".next", ".nuxt", "target", ".cargo", "vendor",
})


def _refresh_cache(folders: list[str], supported_extensions: set[str] | None):
    global _file_cache, _cache_folders, _cache_time
    now = time.time()
    if _file_cache and _cache_folders == folders and (now - _cache_time) < _CACHE_TTL:
        return

    files: list[tuple[str, str]] = []
    for folder in folders:
        folder_path = Path(folder)
        if not folder_path.exists():
            continue
        for root, dirs, filenames in os.walk(folder_path):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            for fname in filenames:
                if supported_extensions:
                    ext = Path(fname).suffix.lower()
                    if ext not in supported_extensions:
                        continue
                files.append((fname, os.path.join(root, fname)))

    _file_cache = files
    _cache_folders = list(folders)
    _cache_time = now


def fuzzy_file_search(
    query: str,
    folders: list[str],
    limit: int = 15,
    supported_extensions: set[str] | None = None,
) -> list[dict]:
    if not query.strip():
        return []

    _refresh_cache(folders, supported_extensions)

    query_lower = query.lower()
    scored: list[tuple[str, str, float]] = []

    for fname, fpath in _file_cache:
        fname_lower = fname.lower()

        # Quick pre-filter: skip if no character overlap
        if not any(c in fname_lower for c in query_lower.split()[0][:3]):
            continue

        score = fuzz.partial_ratio(query_lower, fname_lower)
        if score >= 45:
            scored.append((fname, fpath, score))

    scored.sort(key=lambda x: x[2], reverse=True)

    return [
        {
            "fileName": fname,
            "filePath": fpath,
            "snippet": fpath,
            "score": round(score / 100.0, 3),
        }
        for fname, fpath, score in scored[:limit]
    ]
