from __future__ import annotations

import fnmatch
import gc
import hashlib
import logging
import os
import time
from collections import deque
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

_CPU = os.cpu_count() or 4

# Files are extracted in parallel (mostly I/O plus C-level parsers) while the
# main thread owns the embedding model. The two compete for the same cores, so
# extraction takes half of them and ONNX Runtime (see embedder.load_model)
# takes the other half. Handing extraction every core, as before, meant the
# threads spent their time preempting the model rather than feeding it.
EXTRACT_WORKERS = int(os.environ.get("LOCALMIND_EXTRACT_WORKERS", "0")) or max(2, min(6, _CPU // 2))
# How many files are held in flight at once. Bounds peak RAM: only this many
# extracted documents exist in memory at any moment.
WINDOW = int(os.environ.get("LOCALMIND_INDEX_WINDOW", "24"))
# Chunks handed to the embedder in one call. The embedder sorts them by length
# and splits them into model batches internally, so a larger pool here gives it
# more to group and wastes less padding.
BATCH_SIZE = int(os.environ.get("LOCALMIND_EMBED_POOL", "128"))
# Rows buffered before a LanceDB write. Each write creates a dataset fragment;
# batching them keeps the fragment count (and the end-of-run compaction) small.
DB_FLUSH_ROWS = int(os.environ.get("LOCALMIND_DB_FLUSH_ROWS", "1000"))
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


def iter_files(
    folders: list[str],
    max_size_mb: float = 50,
    exclude_patterns: list[str] | None = None,
    seen: set[str] | None = None,
) -> Iterator[FileEntry]:
    """Yield candidate files across folders, skipping paths already yielded.

    A generator rather than a list: on a re-index most files are unchanged, and
    materializing a FileEntry for every one of them held hundreds of megabytes
    of tuples and strings for the whole run. Callers that need the full path
    set pass their own `seen`, which costs one string per file instead.
    """
    max_bytes = int(max_size_mb * 1024 * 1024)
    excl = exclude_patterns or []
    if seen is None:
        seen = set()

    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for entry in _walk(folder, max_bytes, excl):
            if entry.path not in seen:
                seen.add(entry.path)
                yield entry


def scan_files(
    folders: list[str],
    max_size_mb: float = 50,
    exclude_patterns: list[str] | None = None,
) -> list[FileEntry]:
    """List form of `iter_files`, kept for callers that want the whole set."""
    return list(iter_files(folders, max_size_mb, exclude_patterns))


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

    writer = db.BulkWriter(DB_FLUSH_ROWS)
    try:
        logger.info("Scanning folders: %s", folders)
        t0 = time.time()

        # Decide what actually needs work before touching any file content.
        # The scan streams, so only changed files and the bare path set are
        # held; unchanged files cost one string each rather than a full entry.
        known = db.known_hashes()
        present: set[str] = set()
        pending: list[tuple[FileEntry, str]] = []
        for e in iter_files(folders, max_file_size, exclude_patterns, present):
            fhash = file_hash(e.path, e.size, e.mtime)
            if known.get(e.path) == fhash:
                continue
            pending.append((e, fhash))

        total = len(present)
        logger.info("Scanned %d candidate files in %.2fs", total, time.time() - t0)

        # Prioritize PDFs, Documents, and Notes first
        pending.sort(key=_file_priority)

        state.total = total
        state.skipped = total - len(pending)
        state.indexed = state.skipped
        logger.info("%d files changed, %d unchanged", len(pending), state.skipped)

        # Drop stale rows for files that disappeared or are being re-indexed,
        # in a handful of statements rather than one delete per file.
        stale = [e.path for e, _ in pending if e.path in known]
        if prune_missing:
            stale.extend(p for p in known if p not in present)
        if stale:
            logger.info("Removing stale chunks for %d files", len(stale))
            db.remove_files_chunks(stale)
        present.clear()

        batch_texts: list[str] = []
        batch_meta: list[dict] = []
        stopped = False

        # Extraction runs continuously rather than in lockstep windows: as soon
        # as one file's result is consumed, the next is submitted. The previous
        # code drained a whole window before submitting the next, so every
        # worker sat idle waiting on the slowest file in the window while the
        # main thread embedded. At most WINDOW files are in flight, which is
        # what bounds peak memory.
        with ThreadPoolExecutor(max_workers=EXTRACT_WORKERS, thread_name_prefix="extract") as pool:
            queue: deque = deque()
            upcoming = iter(pending)

            def submit_next() -> bool:
                item = next(upcoming, None)
                if item is None:
                    return False
                entry, fhash = item
                queue.append((fhash, pool.submit(_extract_one, entry, max_file_size)))
                return True

            for _ in range(WINDOW):
                if not submit_next():
                    break

            while queue:
                if state._stop_requested:
                    stopped = True
                    for _, fut in queue:
                        fut.cancel()
                    queue.clear()
                    break

                fhash, future = queue.popleft()
                entry, chunks = future.result()
                submit_next()

                state.current = entry.name
                state.indexed += 1
                _update_progress(state)
                if on_progress:
                    on_progress(state.progress, state.indexed, state.total)

                if not chunks:
                    continue

                file_context = context_header(entry.path, entry.name)
                for idx, (chunk, line_start, line_end) in enumerate(chunks):
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
                    _flush_batch(batch_texts[:BATCH_SIZE], batch_meta[:BATCH_SIZE], writer)
                    del batch_texts[:BATCH_SIZE]
                    del batch_meta[:BATCH_SIZE]

        if batch_texts:
            _flush_batch(batch_texts, batch_meta, writer)
            batch_texts.clear()
            batch_meta.clear()

        # Whatever was embedded before a stop still belongs in the index.
        writer.flush()

        if stopped:
            state.status = "idle"
            state.current = ""
            _release_resources()
            return

        state.status = "complete"
        state.progress = 100
        state.current = ""
        elapsed = time.time() - state._started_at
        logger.info(
            "Indexing complete in %.1fs: %d files (%d unchanged)",
            elapsed, state.total, state.skipped,
        )

        if writer.written or stale:
            db.optimize()

        # The run is over and the user is looking at the result, so the next
        # /index/stats call recounts instead of serving the rate-limited rollup.
        db.reset_stats_cache()
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
        try:
            writer.flush()
        except Exception:
            logger.debug("Could not flush pending rows after error")
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


def _trim_working_set() -> None:
    """Trigger OS-level memory working set trimming on Windows to drop unneeded pages."""
    gc.collect()
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.psapi.EmptyWorkingSet(ctypes.windll.kernel32.GetCurrentProcess())
        except Exception:
            pass


def _release_resources() -> None:
    """Give back the memory the indexing run needed but searching does not."""
    try:
        from extractor import release_ocr_reader
        release_ocr_reader()
    except Exception:
        pass
    # The path -> hash map is only consulted while indexing; on a large index
    # it was the single biggest thing the idle process kept alive.
    try:
        db.release_hash_cache()
    except Exception:
        pass
    _trim_working_set()


def _flush_batch(texts: list[str], metas: list[dict], writer: "db.BulkWriter") -> None:
    if not texts:
        return

    vectors = get_embeddings(texts)
    timestamp = time.time()

    for text, meta in zip(texts, metas):
        meta["text"] = text
        meta["indexed_at"] = timestamp

    writer.add(metas, np.asarray(vectors, dtype=np.float32))


def rebuild_index(folders: list[str], max_file_size: float = 50, exclude_patterns: list[str] | None = None) -> None:
    db.drop_all()
    index_files(folders, max_file_size, exclude_patterns=exclude_patterns, prune_missing=False)
