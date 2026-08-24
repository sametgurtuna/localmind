from __future__ import annotations

import fnmatch
import gc
import hashlib
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Iterator, NamedTuple, Optional

import numpy as np

from extractor import SUPPORTED_EXTENSIONS, extract_text, is_junk_file
from chunker import chunk_text_with_lines
from embedder import get_embeddings
import db

logger = logging.getLogger(__name__)

SKIP_DIRS = frozenset({
    "node_modules", "__pycache__", ".git", "venv", ".venv",
    ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
    ".next", ".nuxt", "target", ".cargo", "vendor",
    "Library", "PackageCache", "Temp", "bin", "obj",
    ".vs", ".idea", ".gradle", ".cache", ".turbo",
    "site-packages", ".dotnet", ".nuget", ".rustup",
    "AppData", "LocalLow",
    "models", "snapshots", "checkpoints", "weights", "whisper",
    "huggingface", "transformers",
})

# Files are extracted in parallel (mostly I/O plus C-level parsers) while the
# main thread owns the embedding model.
EXTRACT_WORKERS = int(os.environ.get("LOCALMIND_EXTRACT_WORKERS", "0")) or min(8, (os.cpu_count() or 4))
# How many files are held in flight at once. Bounds peak RAM: only this many
# extracted documents exist in memory at any moment.
WINDOW = int(os.environ.get("LOCALMIND_INDEX_WINDOW", "64"))
# Chunks are embedded in batches of this size.
BATCH_SIZE = int(os.environ.get("LOCALMIND_EMBED_BATCH", "128"))
# Guards against a single huge document monopolizing the run.
MAX_TEXT_CHARS = int(os.environ.get("LOCALMIND_MAX_TEXT_CHARS", "500000"))
MAX_CHUNKS_PER_FILE = int(os.environ.get("LOCALMIND_MAX_CHUNKS_PER_FILE", "200"))


class FileEntry(NamedTuple):
    path: str
    name: str
    ext: str
    size: int
    mtime: float


class IndexState:
    def __init__(self):
        self.reset()

    def reset(self) -> None:
        """Clear counters in place.

        Rebinding the module-level `index_state` used to leave main.py holding
        the previous object, so /index/status reported a permanently idle run
        and the progress UI never moved.
        """
        self.status: str = "idle"
        self.progress: float = 0
        self.total: int = 0
        self.indexed: int = 0
        self.skipped: int = 0
        self.current: str = ""
        self.eta_seconds: float = 0
        self.error: Optional[str] = None
        self._stop_requested: bool = False
        self._started_at: float = 0

    def request_stop(self):
        self._stop_requested = True

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "progress": self.progress,
            "total": self.total,
            "indexed": self.indexed,
            "skipped": self.skipped,
            "current": self.current,
            "eta_seconds": round(self.eta_seconds, 1),
            "error": self.error,
        }


index_state = IndexState()


def context_header(path: str, name: str) -> str:
    """Short provenance line prepended to every chunk before embedding.

    The full path used to cost ~42 tokens of a ~150-token budget, which both
    wasted a third of the compute and pushed the tail of each chunk past the
    sequence limit. The folder name carries nearly all of the useful signal.
    """
    parent = os.path.basename(os.path.dirname(path))
    return f"[{name} in {parent}]\n" if parent else f"[{name}]\n"


def file_hash(path: str, size: int | None = None, mtime: float | None = None) -> str:
    """Cheap identity hash. Callers that already have stat data pass it in so
    the file is never stat-ed twice."""
    if size is None or mtime is None:
        st = os.stat(path)
        size, mtime = st.st_size, st.st_mtime
    h = hashlib.md5(usedforsecurity=False)
    h.update(path.encode("utf-8", "replace"))
    h.update(str(mtime).encode())
    h.update(str(size).encode())
    return h.hexdigest()


def _walk(
    folder: str,
    max_bytes: int,
    excl: list[str],
) -> Iterator[FileEntry]:
    """Walk a folder with os.scandir, reusing the stat data the OS already
    returned for each directory entry (os.walk + getsize cost 2-3 extra
    syscalls per file)."""
    stack = [folder]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            name = entry.name
                            if name in SKIP_DIRS or name.startswith("."):
                                continue
                            if any(fnmatch.fnmatch(name, p) for p in excl):
                                continue
                            stack.append(entry.path)
                            continue

                        name = entry.name
                        if is_junk_file(name):
                            continue
                        ext = os.path.splitext(name)[1].lower()
                        if ext not in SUPPORTED_EXTENSIONS:
                            continue
                        if any(fnmatch.fnmatch(name, p) for p in excl):
                            continue

                        st = entry.stat(follow_symlinks=False)
                        if st.st_size > max_bytes:
                            continue
                        yield FileEntry(entry.path, name, ext, st.st_size, st.st_mtime)
                    except OSError:
                        continue
        except OSError:
            continue


def scan_files(
    folders: list[str],
    max_size_mb: float = 50,
    exclude_patterns: list[str] | None = None,
) -> list[FileEntry]:
    max_bytes = int(max_size_mb * 1024 * 1024)
    excl = exclude_patterns or []
    entries: list[FileEntry] = []
    seen: set[str] = set()

    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for entry in _walk(folder, max_bytes, excl):
            if entry.path not in seen:
                seen.add(entry.path)
                entries.append(entry)
    return entries


def _extract_one(entry: FileEntry, max_file_size: float) -> tuple[FileEntry, list[tuple[str, int, int]]]:
    """Extract and chunk one file. Runs on a worker thread."""
    try:
        text = extract_text(entry.path, max_file_size)
    except Exception as e:
        logger.debug("Extraction failed for %s: %s", entry.path, e)
        return entry, []

    if not text:
        return entry, []

    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS]

    chunks = chunk_text_with_lines(text)
    if len(chunks) > MAX_CHUNKS_PER_FILE:
        chunks = chunks[:MAX_CHUNKS_PER_FILE]
    return entry, chunks


DOC_PRIORITY_EXTS = frozenset({
    ".pdf", ".docx", ".txt", ".md", ".epub", ".pptx", ".xlsx", ".rtf",
})


def _file_priority(item: tuple[FileEntry, str]) -> int:
    """Prioritize user documents & books so they get indexed in the first seconds."""
    entry = item[0]
    return 0 if entry.ext in DOC_PRIORITY_EXTS else 1


def index_files(
    folders: list[str],
    max_file_size: float = 50,
    on_progress: Optional[Callable[[float, int, int], None]] = None,
    exclude_patterns: list[str] | None = None,
    prune_missing: bool = True,
) -> None:
    state = index_state
    state.reset()
    state.status = "indexing"
    state._started_at = time.time()

    try:
        logger.info("Scanning folders: %s", folders)
        t0 = time.time()
        entries = scan_files(folders, max_file_size, exclude_patterns)
        logger.info("Scanned %d candidate files in %.2fs", len(entries), time.time() - t0)

        # Decide what actually needs work before touching any file content.
        known = db.known_hashes()
        pending: list[tuple[FileEntry, str]] = []
        for e in entries:
            fhash = file_hash(e.path, e.size, e.mtime)
            if known.get(e.path) == fhash:
                continue
            pending.append((e, fhash))

        # Prioritize PDFs, Documents, and Notes first
        pending.sort(key=_file_priority)

        state.total = len(entries)
        state.skipped = len(entries) - len(pending)
        state.indexed = state.skipped
        logger.info("%d files changed, %d unchanged", len(pending), state.skipped)

        # Drop stale rows for files that disappeared or are being re-indexed,
        # in a handful of statements rather than one delete per file.
        stale = [e.path for e, _ in pending if e.path in known]
        if prune_missing:
            present = {e.path for e in entries}
            stale.extend(p for p in known if p not in present)
        if stale:
            logger.info("Removing stale chunks for %d files", len(stale))
            db.remove_files_chunks(stale)

        batch_texts: list[str] = []
        batch_meta: list[dict] = []
        chunk_counters: dict[str, int] = {}
        wrote_anything = False

        with ThreadPoolExecutor(max_workers=EXTRACT_WORKERS, thread_name_prefix="extract") as pool:
            for i in range(0, len(pending), WINDOW):
                if state._stop_requested:
                    state.status = "idle"
                    return

                window = pending[i:i + WINDOW]
                hashes = {e.path: h for e, h in window}
                extracted = pool.map(
                    lambda item: _extract_one(item[0], max_file_size),
                    window,
                )

                for entry, chunks in extracted:
                    state.current = entry.name
                    state.indexed += 1
                    _update_progress(state)
                    if on_progress:
                        on_progress(state.progress, state.indexed, state.total)

                    if not chunks:
                        continue

                    fhash = hashes[entry.path]
                    file_context = context_header(entry.path, entry.name)

                    for chunk, line_start, line_end in chunks:
                        idx = chunk_counters.get(entry.path, 0)
                        chunk_counters[entry.path] = idx + 1
                        batch_texts.append(file_context + chunk)
                        batch_meta.append({
                            "text": "",  # filled in at flush time
                            "file_path": entry.path,
                            "file_name": entry.name,
                            "chunk_index": idx,
                            "file_hash": fhash,
                            "file_ext": entry.ext,
                            "file_size": entry.size,
                            "file_modified": entry.mtime,
                            "line_start": line_start,
                            "line_end": line_end,
                        })

                    while len(batch_texts) >= BATCH_SIZE:
                        _flush_batch(batch_texts[:BATCH_SIZE], batch_meta[:BATCH_SIZE])
                        del batch_texts[:BATCH_SIZE]
                        del batch_meta[:BATCH_SIZE]
                        wrote_anything = True

        if batch_texts:
            _flush_batch(batch_texts, batch_meta)
            batch_texts.clear()
            batch_meta.clear()
            wrote_anything = True

        state.status = "complete"
        state.progress = 100
        state.current = ""
        elapsed = time.time() - state._started_at
        logger.info(
            "Indexing complete in %.1fs: %d files (%d unchanged)",
            elapsed, state.total, state.skipped,
        )

        if wrote_anything or stale:
            db.optimize()

        _release_resources()

        try:
            from search import invalidate_file_index_cache
            invalidate_file_index_cache()
        except (ImportError, AttributeError):
            pass

    except Exception as e:
        logger.exception("Indexing error: %s", e)
        state.status = "error"
        state.error = str(e)
        _release_resources()


def _update_progress(state: IndexState) -> None:
    if not state.total:
        state.progress = 0
        return
    state.progress = (state.indexed / state.total) * 100
    done = state.indexed - state.skipped
    if done > 5:
        elapsed = time.time() - state._started_at
        rate = done / elapsed if elapsed > 0 else 0
        remaining = state.total - state.indexed
        state.eta_seconds = remaining / rate if rate > 0 else 0


def _release_resources() -> None:
    """Give back the memory the indexing run needed but searching does not."""
    try:
        from extractor import release_ocr_reader
        release_ocr_reader()
    except Exception:
        pass
    gc.collect()


def _flush_batch(texts: list[str], metas: list[dict]) -> None:
    if not texts:
        return

    vectors = get_embeddings(texts)
    timestamp = time.time()

    for text, meta in zip(texts, metas):
        meta["text"] = text
        meta["indexed_at"] = timestamp

    db.add_records_arrow(metas, np.asarray(vectors, dtype=np.float32))


def rebuild_index(folders: list[str], max_file_size: float = 50, exclude_patterns: list[str] | None = None) -> None:
    db.drop_all()
    index_files(folders, max_file_size, exclude_patterns=exclude_patterns, prune_missing=False)
