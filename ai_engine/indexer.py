from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Callable, Optional

from extractor import SUPPORTED_EXTENSIONS, extract_text
from chunker import chunk_text_with_lines
from embedder import get_embeddings
import db

logger = logging.getLogger(__name__)

SKIP_DIRS = frozenset({
    "node_modules", "__pycache__", ".git", "venv", ".venv",
    ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
    ".next", ".nuxt", "target", ".cargo", "vendor",
})


class IndexState:
    def __init__(self):
        self.status: str = "idle"
        self.progress: float = 0
        self.total: int = 0
        self.indexed: int = 0
        self.error: Optional[str] = None
        self._stop_requested: bool = False

    def request_stop(self):
        self._stop_requested = True

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "progress": self.progress,
            "total": self.total,
            "indexed": self.indexed,
            "error": self.error,
        }


index_state = IndexState()


def file_hash(path: str) -> str:
    h = hashlib.md5(usedforsecurity=False)
    h.update(path.encode())
    h.update(str(os.path.getmtime(path)).encode())
    h.update(str(os.path.getsize(path)).encode())
    return h.hexdigest()


def scan_files(
    folders: list[str],
    max_size_mb: float = 50,
    exclude_patterns: list[str] | None = None,
) -> list[str]:
    import fnmatch

    files = []
    max_bytes = int(max_size_mb * 1024 * 1024)
    excl = exclude_patterns or []

    for folder in folders:
        folder_path = Path(folder)
        if not folder_path.exists():
            continue
        for root, dirs, filenames in os.walk(folder_path):
            dirs[:] = [
                d for d in dirs
                if d not in SKIP_DIRS
                and not d.startswith(".")
                and not any(fnmatch.fnmatch(d, p) for p in excl)
            ]

            for fname in filenames:
                if any(fnmatch.fnmatch(fname, p) for p in excl):
                    continue
                ext = Path(fname).suffix.lower()
                if ext not in SUPPORTED_EXTENSIONS:
                    continue
                fpath = os.path.join(root, fname)
                try:
                    if os.path.getsize(fpath) <= max_bytes:
                        files.append(fpath)
                except OSError:
                    continue
    return files


def index_files(
    folders: list[str],
    max_file_size: float = 50,
    on_progress: Optional[Callable[[float, int, int], None]] = None,
    exclude_patterns: list[str] | None = None,
) -> None:
    global index_state
    index_state = IndexState()
    index_state.status = "indexing"

    try:
        logger.info("Scanning folders: %s", folders)
        files = scan_files(folders, max_file_size, exclude_patterns)
        index_state.total = len(files)
        logger.info("Found %d files to process", len(files))

        batch_texts: list[str] = []
        batch_meta: list[dict] = []
        BATCH_SIZE = 256
        skipped = 0

        for i, fpath in enumerate(files):
            if index_state._stop_requested:
                index_state.status = "idle"
                return

            try:
                fhash = file_hash(fpath)
            except OSError:
                index_state.indexed += 1
                continue

            if db.file_exists_with_hash(fpath, fhash):
                skipped += 1
                index_state.indexed += 1
                index_state.progress = (index_state.indexed / index_state.total) * 100 if index_state.total else 0
                continue

            db.remove_file_chunks(fpath)

            text = extract_text(fpath, max_file_size)
            if not text:
                index_state.indexed += 1
                index_state.progress = (index_state.indexed / index_state.total) * 100 if index_state.total else 0
                continue

            fname = os.path.basename(fpath)
            ext = Path(fpath).suffix.lower()

            try:
                stat = os.stat(fpath)
                fsize = stat.st_size
                fmod = stat.st_mtime
            except OSError:
                fsize = 0
                fmod = 0.0

            path_hint = fpath.replace("\\", "/")
            file_context = f"[File: {fname} | Path: {path_hint}]\n"

            chunks_with_lines = chunk_text_with_lines(text)
            for chunk_text_str, line_start, line_end in chunks_with_lines:
                batch_texts.append(file_context + chunk_text_str)
                batch_meta.append({
                    "file_path": fpath,
                    "file_name": fname,
                    "file_hash": fhash,
                    "file_ext": ext,
                    "file_size": fsize,
                    "file_modified": fmod,
                    "line_start": line_start,
                    "line_end": line_end,
                })

            if len(batch_texts) >= BATCH_SIZE:
                _flush_batch(batch_texts, batch_meta)
                batch_texts.clear()
                batch_meta.clear()

            index_state.indexed += 1
            index_state.progress = (index_state.indexed / index_state.total) * 100 if index_state.total else 0

            if on_progress:
                on_progress(index_state.progress, index_state.indexed, index_state.total)

        if batch_texts:
            _flush_batch(batch_texts, batch_meta)

        index_state.status = "complete"
        index_state.progress = 100
        logger.info("Indexing complete: %d files, %d skipped (unchanged)", index_state.indexed, skipped)

        try:
            from search import invalidate_file_index_cache
            invalidate_file_index_cache()
        except ImportError:
            pass

    except Exception as e:
        logger.error("Indexing error: %s", e)
        index_state.status = "error"
        index_state.error = str(e)


# Track per-file chunk index for correct numbering across batches
_file_chunk_counters: dict[str, int] = {}


def _flush_batch(texts: list[str], metas: list[dict]) -> None:
    global _file_chunk_counters
    if not texts:
        return

    vectors = get_embeddings(texts)
    timestamp = time.time()

    records = []
    for idx, (text, meta) in enumerate(zip(texts, metas)):
        fp = meta["file_path"]
        chunk_idx = _file_chunk_counters.get(fp, 0)
        _file_chunk_counters[fp] = chunk_idx + 1

        records.append({
            "text": text,
            "file_path": fp,
            "file_name": meta["file_name"],
            "chunk_index": chunk_idx,
            "file_hash": meta["file_hash"],
            "indexed_at": timestamp,
            "file_ext": meta.get("file_ext", ""),
            "file_size": meta.get("file_size", 0),
            "file_modified": meta.get("file_modified", 0.0),
            "line_start": meta.get("line_start", 0),
            "line_end": meta.get("line_end", 0),
            "vector": vectors[idx].tolist(),
        })

    db.add_chunks_bulk(records)


def rebuild_index(folders: list[str], max_file_size: float = 50, exclude_patterns: list[str] | None = None) -> None:
    global _file_chunk_counters
    _file_chunk_counters.clear()
    db.drop_all()
    index_files(folders, max_file_size, exclude_patterns=exclude_patterns)
