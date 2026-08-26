"""LocalMind AI Engine - FastAPI sidecar server."""
from __future__ import annotations

import os
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TRANSFORMERS_NO_TF"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "true"

import logging
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db
import embedder
import settings as engine_settings
from indexer import index_files, rebuild_index, index_state
from search import semantic_search
from file_search import fuzzy_file_search, refresh_file_cache
from app_launcher import search_apps
from evaluator import evaluate_quick_query
from watcher import FileWatcher
from extractor import SUPPORTED_EXTENSIONS, extract_text

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("localmind")

app = FastAPI(title="LocalMind AI Engine", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_watcher: FileWatcher | None = None
_index_thread: threading.Thread | None = None
_current_folders: list[str] = []
_current_exclude: list[str] = []
_model_ready = threading.Event()


def _load_model_background():
    try:
        embedder.load_model()
        # Only now is the vector space known for certain: a requested int8
        # conversion can fall back to fp32, and the migration check has to
        # compare the stored index against what is really loaded. Running it
        # before the load meant comparing against the requested precision.
        _check_model_migration()
        _trim_memory()
        logger.info("Model ready (%s)", embedder.model_signature())
    except Exception as e:
        logger.error("Failed to load model: %s", e)
    finally:
        _model_ready.set()


# Watcher events are collected here and applied in batches by a single worker
# thread, so a burst of saves (a build, a git checkout) costs one flush instead
# of one delete + embed round-trip per file on the watchdog thread.
_pending_changes: dict[str, str] = {}
_pending_lock = threading.Lock()
_pending_event = threading.Event()
_CHANGE_FLUSH_DELAY = 3.0
_CHANGE_CHUNK_BATCH = 512


def _on_file_change(path: str, event_type: str):
    if not _model_ready.is_set():
        return
    with _pending_lock:
        # A later delete supersedes an earlier upsert and vice versa.
        _pending_changes[path] = event_type
    _pending_event.set()


def _change_worker():
    """Apply queued file changes in batches."""
    from chunker import chunk_text_with_lines
    from indexer import context_header, file_hash

    while True:
        _pending_event.wait()
        time.sleep(_CHANGE_FLUSH_DELAY)  # let a burst settle
        with _pending_lock:
            batch = dict(_pending_changes)
            _pending_changes.clear()
            _pending_event.clear()
        if not batch:
            continue

        if _index_thread is not None and _index_thread.is_alive():
            # A full index run is already rewriting these rows.
            continue

        try:
            # One delete statement covers the whole batch, including the
            # re-indexed files whose old chunks must go first.
            db.remove_files_chunks(list(batch))

            metas: list[dict] = []
            texts: list[str] = []
            for path, event_type in batch.items():
                if event_type == "deleted":
                    continue
                try:
                    st = os.stat(path)
                except OSError:
                    continue

                text = extract_text(path)
                if not text:
                    continue
                chunks = chunk_text_with_lines(text)
                if not chunks:
                    continue

                fname = os.path.basename(path)
                fhash = file_hash(path, st.st_size, st.st_mtime)
                file_context = context_header(path, fname)
                for idx, (chunk, line_start, line_end) in enumerate(chunks):
                    texts.append(file_context + chunk)
                    metas.append({
                        "text": "",
                        "file_path": path,
                        "file_name": fname,
                        "chunk_index": idx,
                        "file_hash": fhash,
                        "indexed_at": time.time(),
                        "file_ext": Path(path).suffix.lower(),
                        "file_size": st.st_size,
                        "file_modified": st.st_mtime,
                        "line_start": line_start,
                        "line_end": line_end,
                    })

            if texts:
                stamp = time.time()
                for meta, text in zip(metas, texts):
                    meta["text"] = text
                    meta["indexed_at"] = stamp
                # A burst -- a git checkout, a build -- can queue thousands of
                # chunks. Embedding and writing them in slices keeps the peak
                # allocation bounded instead of scaling with the burst.
                for start in range(0, len(texts), _CHANGE_CHUNK_BATCH):
                    part_texts = texts[start : start + _CHANGE_CHUNK_BATCH]
                    part_metas = metas[start : start + _CHANGE_CHUNK_BATCH]
                    db.add_records_arrow(part_metas, embedder.get_embeddings(part_texts))
                logger.info("Applied %d file changes (%d chunks)", len(batch), len(texts))
        except Exception as e:
            logger.warning("Failed to apply file changes: %s", e)


# --- Request/Response models ---

class SearchRequest(BaseModel):
    query: str
    type: str = "all"  # "all" | "apps" | "files" | "content" | "actions"
    limit: int = 20

class SearchResponse(BaseModel):
    results: list[dict]
    query: str
    type: str

class IndexStartRequest(BaseModel):
    folders: list[str]
    max_file_size: float = 50
    exclude_patterns: list[str] = []

class FoldersRequest(BaseModel):
    folders: list[str]

class SimilarRequest(BaseModel):
    file_path: str
    limit: int = 10


# --- Endpoints ---

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "pid": os.getpid(),
        "model_ready": _model_ready.is_set(),
        "indexed": db.count_rows(),
    }


@app.post("/shutdown")
async def shutdown_endpoint():
    """Graceful shutdown triggered by parent process."""
    def _delayed_exit():
        time.sleep(0.15)
        _clean_exit()

    threading.Thread(target=_delayed_exit, daemon=True).start()
    return {"status": "shutting_down"}


def _trim_memory() -> None:
    """Explicitly run garbage collection and Windows working set trimming."""
    import gc
    gc.collect()
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.psapi.EmptyWorkingSet(ctypes.windll.kernel32.GetCurrentProcess())
        except Exception:
            pass


def _background_memory_trimmer():
    """Periodically trim memory working set to keep idle memory under 150MB."""
    while True:
        time.sleep(30)
        if _index_thread is None or not _index_thread.is_alive():
            _trim_memory()


@app.post("/search", response_model=SearchResponse)
def search_endpoint(req: SearchRequest):
    """FastAPI search endpoint. Pure semantic search delegate since Rust MFT handles files & apps."""
    q = req.query.strip()
    search_type = req.type.lower()

    if not q:
        return SearchResponse(results=[], query=req.query, type=req.type)

    results: list[dict] = []

    if search_type in ("all", "content", "semantic", "unified"):
        if _model_ready.is_set():
            try:
                results = semantic_search(q, limit=req.limit)
            except Exception as e:
                logger.debug("Semantic search error: %s", e)
    elif search_type == "files":
        results = fuzzy_file_search(q, _current_folders, limit=req.limit)
    elif search_type == "apps":
        results = search_apps(q, limit=req.limit)
    elif search_type == "actions":
        results = evaluate_quick_query(q)

    return SearchResponse(results=results, query=req.query, type=req.type)


@app.post("/similar")
async def similar_endpoint(req: SimilarRequest):
    """Find files similar to the given file using averaged embeddings."""
    if not _model_ready.is_set():
        return {"results": []}

    vectors = db.get_file_embeddings(req.file_path)
    if not vectors:
        return {"results": []}

    avg_vec = np.mean(vectors, axis=0)
    avg_vec = avg_vec / (np.linalg.norm(avg_vec) + 1e-10)

    results = db.search_vectors(avg_vec, limit=req.limit + 10)
    # Deduplicate by file and exclude the source file
    seen = set()
    filtered = []
    for r in results:
        fp = r["filePath"]
        if fp == req.file_path or fp in seen:
            continue
        seen.add(fp)
        filtered.append(r)
        if len(filtered) >= req.limit:
            break

    return {"results": filtered}


@app.get("/preview")
async def preview_endpoint(
    path: str = Query(...),
    line: int = Query(0),
    context: int = Query(60),
):
    """Return rich file preview data (images, code/text with line numbers, metadata) for PowerToys Peek style view."""
    p = Path(path)
    if not p.exists() or not p.is_file():
        return {"content": "", "total_lines": 0, "start_line": 0, "type": "unknown"}

    ext = p.suffix.lower()
    stat = p.stat()
    file_size_bytes = stat.st_size
    mtime = stat.st_mtime

    # 1. Image Files
    image_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
    if ext in image_exts:
        try:
            import base64
            mime = "image/svg+xml" if ext == ".svg" else f"image/{ext.lstrip('.')}"
            if ext in (".jpg", ".jpeg"):
                mime = "image/jpeg"
            raw_bytes = p.read_bytes()
            if len(raw_bytes) <= 15 * 1024 * 1024:  # Max 15MB preview
                b64 = base64.b64encode(raw_bytes).decode("utf-8")
                return {
                    "type": "image",
                    "content": f"data:{mime};base64,{b64}",
                    "file_ext": ext,
                    "file_size": file_size_bytes,
                    "modified": mtime,
                    "total_lines": 0,
                    "start_line": 0,
                }
        except Exception as e:
            logger.error("Image preview error: %s", e)

    # 2. PDF Files (PyMuPDF high-res page 1 render + text extraction)
    if ext == ".pdf":
        try:
            import base64
            import pymupdf
            doc = pymupdf.open(str(p))
            num_pages = len(doc)
            pdf_image = None
            if num_pages > 0:
                page = doc[0]
                pix = page.get_pixmap(dpi=150)
                img_bytes = pix.tobytes("png")
                b64 = base64.b64encode(img_bytes).decode("utf-8")
                pdf_image = f"data:image/png;base64,{b64}"

            texts = []
            for idx in range(min(num_pages, 10)):
                t = doc[idx].get_text()
                if t and t.strip():
                    texts.append(f"--- [ Sayfa {idx + 1} / {num_pages} ] ---\n{t.strip()}")
            doc.close()
            full_text = "\n\n".join(texts).strip()

            return {
                "type": "pdf",
                "content": full_text or "Bu PDF taranmış veya salt görsel içeriyor.",
                "pdf_image": pdf_image,
                "page_count": num_pages,
                "total_lines": len(full_text.splitlines()) if full_text else 0,
                "start_line": 1,
                "file_ext": ext,
                "file_size": file_size_bytes,
                "modified": mtime,
            }
        except Exception as e:
            logger.warning("PyMuPDF preview fallback for %s: %s", path, e)

    # 3. Text & Document Files
    try:
        text = extract_text(path)
        if not text:
            for enc in ("utf-8", "latin-1", "cp1252"):
                try:
                    text = p.read_text(encoding=enc)
                    break
                except (UnicodeDecodeError, ValueError):
                    continue

        if not text:
            return {
                "type": "binary",
                "content": "",
                "total_lines": 0,
                "start_line": 0,
                "file_ext": ext,
                "file_size": file_size_bytes,
                "modified": mtime,
            }

        lines = text.split("\n")
        total = len(lines)

        if line > 0:
            start = max(0, line - context // 2)
            end = min(total, start + context)
        else:
            start = 0
            end = min(total, 350)

        content = "\n".join(lines[start:end])
        return {
            "type": "text",
            "content": content,
            "total_lines": total,
            "start_line": start + 1,
            "file_ext": ext,
            "file_size": file_size_bytes,
            "modified": mtime,
        }
    except Exception as e:
        logger.error("Preview error: %s", e)
        return {
            "type": "unknown",
            "content": "",
            "total_lines": 0,
            "start_line": 0,
            "file_ext": ext,
            "file_size": file_size_bytes,
            "modified": mtime,
        }


@app.post("/index/start")
async def start_indexing(req: IndexStartRequest):
    global _index_thread, _current_folders, _current_exclude
    _current_folders = req.folders
    _current_exclude = req.exclude_patterns

    if not _model_ready.is_set():
        return {"status": "model_loading"}

    if _index_thread and _index_thread.is_alive():
        return {"status": "already_running"}

    _index_thread = threading.Thread(
        target=index_files,
        args=(req.folders, req.max_file_size),
        kwargs={"exclude_patterns": req.exclude_patterns},
        daemon=True,
    )
    _index_thread.start()

    global _watcher
    if _watcher:
        _watcher.stop()
    _watcher = FileWatcher(_on_file_change)
    _watcher.start(req.folders)

    return {"status": "started"}


@app.get("/index/status")
async def get_index_status():
    d = index_state.to_dict()
    d["model_ready"] = _model_ready.is_set()
    return d


@app.get("/index/stats")
async def get_index_stats():
    return db.get_index_stats()


class RebuildRequest(BaseModel):
    folders: list[str] = []
    max_file_size: float = 50
    exclude_patterns: list[str] = []


@app.post("/index/rebuild")
async def rebuild_index_endpoint(req: RebuildRequest | None = None):
    if not _model_ready.is_set():
        return {"status": "model_loading"}

    global _index_thread, _current_folders, _current_exclude
    if _index_thread and _index_thread.is_alive():
        index_state.request_stop()
        _index_thread.join(timeout=10)

    folders = (req.folders if req and req.folders else _current_folders) or []
    excl = (req.exclude_patterns if req and req.exclude_patterns else _current_exclude) or []
    max_size = req.max_file_size if req else 50

    if folders:
        _current_folders = folders
        _current_exclude = excl

    if not folders:
        return {"status": "no_folders"}

    _index_thread = threading.Thread(
        target=rebuild_index,
        args=(folders, max_size),
        kwargs={"exclude_patterns": excl},
        daemon=True,
    )
    _index_thread.start()
    return {"status": "rebuilding"}


@app.post("/index/stop")
async def stop_indexing():
    index_state.request_stop()
    return {"status": "stopping"}


class EngineSettingsRequest(BaseModel):
    ocr: bool | None = None
    quantize: bool | None = None


def _with_resolved_quantize(data: dict) -> dict:
    """Report the precision actually in effect, not the raw stored value.

    `quantize` is tri-state: None means "decide from the hardware". The UI
    renders it as a switch, so it needs the resolved boolean or the toggle
    would read Off on a CPU-only machine that is in fact running int8.
    """
    data = dict(data)
    data["quantize_auto"] = data.get("quantize") is None
    data["quantize"] = embedder.quantize_enabled()
    data["gpu"] = embedder.gpu_available()
    return data


@app.get("/engine/settings")
async def get_engine_settings():
    data = _with_resolved_quantize(engine_settings.load())
    data["indexing"] = bool(_index_thread and _index_thread.is_alive())
    return data


@app.post("/engine/settings")
async def set_engine_settings(req: EngineSettingsRequest):
    """Update engine settings and report what the change costs.

    Turning quantization on or off moves every vector to a different space, so
    the index has to be rebuilt; enabling OCR only means images that were
    skipped can now be read, which is a rebuild worth suggesting but not forcing.
    """
    # Compare resolved precision, not the stored value: switching from "auto"
    # to the same precision auto had already picked changes nothing and must
    # not force a rebuild.
    before_quantized = embedder.quantize_enabled()
    before = engine_settings.load()
    changes = {k: v for k, v in req.model_dump().items() if v is not None}
    after = engine_settings.update(changes)

    quantize_changed = embedder.quantize_enabled() != before_quantized
    ocr_changed = before.get("ocr") != after.get("ocr")

    if quantize_changed:
        def _swap_model():
            try:
                embedder.reload_model()
                # Record the new vector space now. Without this the startup
                # migration check would see a stale marker on the next launch
                # and silently drop the index the user just rebuilt.
                _write_model_marker()
                logger.info("Embedding model reloaded (%s)", embedder.model_signature())
            except Exception as e:
                logger.error("Model reload failed: %s", e)
        threading.Thread(target=_swap_model, daemon=True).start()

    return {
        **_with_resolved_quantize(after),
        "rebuild_required": quantize_changed,
        "rebuild_suggested": ocr_changed and after.get("ocr", False),
    }


@app.get("/index/folders")
async def get_folders():
    return {"folders": _current_folders}


@app.post("/index/folders")
async def set_folders(req: FoldersRequest):
    global _current_folders
    _current_folders = req.folders
    return {"folders": _current_folders}


def find_free_port() -> int:
    env_port = os.environ.get("LOCALMIND_PORT")
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            pass
    # Try default preferred port first for predictable dev/browser connection
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 56789))
            return 56789
    except OSError:
        pass
    # Fallback to any free ephemeral port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _port_file_path() -> str:
    return os.path.join(str(Path.home()), ".localmind", "sidecar.port")


def _write_port_file(port: int) -> None:
    try:
        os.makedirs(os.path.join(str(Path.home()), ".localmind"), exist_ok=True)
        with open(_port_file_path(), "w") as f:
            f.write(str(port))
    except Exception as e:
        logger.debug("Failed to write sidecar.port file: %s", e)


def _remove_port_file() -> None:
    """Delete the port handshake file so a stale port is never reused.

    This was referenced from `_clean_exit`, the atexit hook and the uvicorn
    teardown but never defined, so every one of those paths raised NameError
    and the file survived the process -- leaving the next launch to try a port
    nothing was listening on.
    """
    try:
        os.remove(_port_file_path())
    except OSError:
        pass


def _clean_exit() -> None:
    """Clean up port file and exit immediately."""
    _remove_port_file()
    os._exit(0)


def _start_parent_watchdog(parent_pid: int | None = None) -> None:
    """Monitor parent process and terminate sidecar immediately if parent dies."""
    if parent_pid is None or parent_pid <= 0:
        try:
            parent_pid = os.getppid()
        except Exception:
            parent_pid = None

    if not parent_pid or parent_pid <= 1:
        logger.info("Parent PID watchdog disabled (no parent PID supplied)")
        return

    logger.info("Parent PID watchdog active (monitoring parent PID: %d)", parent_pid)

    def _watch():
        if sys.platform == "win32":
            import ctypes
            SYNCHRONIZE = 0x00100000
            kernel32 = ctypes.windll.kernel32
            while True:
                time.sleep(1.0)
                handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
                if not handle:
                    logger.warning("Parent process %d is no longer reachable. Terminating sidecar.", parent_pid)
                    _clean_exit()
                    break
                wait_res = kernel32.WaitForSingleObject(handle, 0)
                kernel32.CloseHandle(handle)
                if wait_res == 0:  # WAIT_OBJECT_0: parent process terminated
                    logger.warning("Parent process %d terminated. Terminating sidecar.", parent_pid)
                    _clean_exit()
                    break
        else:
            while True:
                time.sleep(1.0)
                try:
                    os.kill(parent_pid, 0)
                except (OSError, ProcessLookupError):
                    logger.warning("Parent process %d terminated. Terminating sidecar.", parent_pid)
                    _clean_exit()
                    break

    threading.Thread(target=_watch, daemon=True, name="parent-watchdog").start()


def parse_args():
    import argparse
    parser = argparse.ArgumentParser(description="LocalMind AI Engine")
    parser.add_argument("--port", type=int, default=None, help="Port to listen on")
    parser.add_argument("--parent-pid", type=int, default=None, help="Parent process ID to monitor")
    args, _ = parser.parse_known_args()
    return args


def _model_marker_path() -> str:
    return os.path.join(db.DB_DIR, ".model_name")


def _write_model_marker() -> None:
    """Record the vector space the stored index belongs to."""
    os.makedirs(db.DB_DIR, exist_ok=True)
    with open(_model_marker_path(), "w") as f:
        f.write(embedder.model_signature())


def _check_model_migration():
    """Drop DB if embedding model changed since last index."""
    marker = _model_marker_path()
    current_model = embedder.model_signature()
    try:
        if os.path.exists(marker):
            with open(marker, "r") as f:
                stored = f.read().strip()
            if stored == current_model:
                return
            logger.warning("Model changed (%s -> %s), dropping old index", stored, current_model)
        else:
            if db.count_rows() > 0:
                logger.warning("No model marker found but index exists, dropping for safety")
            else:
                _write_model_marker()
                return
        db.drop_all()
    except Exception as e:
        logger.error("Model migration check error: %s", e)
    _write_model_marker()


def main():
    import atexit
    args = parse_args()

    port = args.port or find_free_port()
    _write_port_file(port)
    atexit.register(_remove_port_file)

    parent_pid = args.parent_pid or int(os.environ.get("LOCALMIND_PARENT_PID", "0") or 0) or None
    _start_parent_watchdog(parent_pid)

    print(f"PORT={port}", flush=True)
    logger.info("Starting LocalMind AI Engine on port %d (parent PID: %s)", port, parent_pid)

    db.get_table()

    # The migration check runs on the model thread, once the loaded precision
    # is known -- see _load_model_background.
    logger.info("Loading embedding model in background...")
    model_thread = threading.Thread(target=_load_model_background, daemon=True)
    model_thread.start()

    # Background memory trimmer keeps idle working set under 150MB
    threading.Thread(target=_background_memory_trimmer, daemon=True, name="mem-trimmer").start()

    threading.Thread(target=_change_worker, daemon=True, name="change-worker").start()

    try:
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
        )
    finally:
        _remove_port_file()


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    main()
