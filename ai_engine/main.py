"""LocalMind AI Engine - FastAPI sidecar server."""
from __future__ import annotations

import os
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TRANSFORMERS_NO_TF"] = "1"
os.environ["USE_TORCH"] = "1"
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
        logger.info("Model ready")
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
                vectors = embedder.get_embeddings(texts)
                for meta, text in zip(metas, texts):
                    meta["text"] = text
                db.add_records_arrow(metas, vectors)
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
        "model_ready": _model_ready.is_set(),
        "indexed": db.count_rows(),
    }


# Shared executor for parallel search — 3 workers is enough for apps/files/semantic
# Shared executor for high-speed parallel search
_search_executor = ThreadPoolExecutor(max_workers=6, thread_name_prefix="search")


def _unified_omnisearch(query: str, limit: int = 20) -> list[dict]:
    """High-speed omnichannel search aggregating Quick Actions/Math, Apps, Files, and Semantic Content.

    Optimized Strategy:
    1. Quick Math / System Actions execute synchronously in < 0.2ms.
    2. Apps + In-Memory Files execute concurrently in < 25ms.
    3. Early-Exit: If top match is strong (>= 0.85) on short query (e.g. app/file name),
       return immediately without waiting for semantic search.
    4. Semantic vector search is invoked only for multi-word or non-exact queries.
    """
    q = query.strip()
    if not q:
        return []

    combined: list[dict] = []

    # 1. Quick Math / System Actions — instant (<0.2ms)
    quick_items = evaluate_quick_query(q)
    if quick_items:
        if any(it.get("category") == "calc" for it in quick_items):
            return quick_items[:limit]
        combined.extend(quick_items)

    # 2+3. Apps + Files in parallel
    apps_future = _search_executor.submit(search_apps, q, 6)
    files_future = _search_executor.submit(fuzzy_file_search, q, _current_folders, 15)

    apps: list[dict] = []
    files: list[dict] = []
    try:
        apps = apps_future.result(timeout=0.35)
    except Exception as e:
        logger.debug("App search error or timeout: %s", e)
    try:
        files = files_future.result(timeout=0.40)
    except Exception as e:
        logger.debug("File search error or timeout: %s", e)

    combined.extend(apps)

    # Deduplicate files that might be same as apps
    app_targets = {a["filePath"].lower() for a in apps}
    for f in files:
        if f["filePath"].lower() not in app_targets:
            combined.append(f)

    # Sort fast results by score so top matches appear first
    combined.sort(key=lambda x: x.get("score", 0), reverse=True)

    # 4. Early-Exit Optimization:
    # If we have an exact/near-exact app or filename match on a 1-2 word query, return instantly!
    best_fast_score = max((r.get("score", 0) for r in combined), default=0)
    num_words = len(q.split())
    is_short_query = num_words <= 2

    if best_fast_score >= 0.85 and is_short_query:
        return combined[:limit]

    # 5. Semantic search for multi-word, descriptive, or unanswered queries
    should_run_semantic = (
        _model_ready.is_set()
        and len(q) >= 3
        and (best_fast_score < 0.85 or num_words >= 3)
    )

    if should_run_semantic:
        try:
            semantic_items = semantic_search(q, limit=6)
            existing_paths = {c["filePath"].lower() for c in combined}
            for s in semantic_items:
                if s["filePath"].lower() not in existing_paths:
                    combined.append(s)
        except Exception as e:
            logger.debug("Semantic search error in omnisearch: %s", e)

    # Final sort so high scoring semantic matches or exact file matches are ranked correctly
    combined.sort(key=lambda x: x.get("score", 0), reverse=True)
    return combined[:limit]


@app.post("/search", response_model=SearchResponse)
def search_endpoint(req: SearchRequest):
    """Synchronous FastAPI handler executed in worker threadpool to prevent event-loop blocking."""
    q = req.query.strip()
    search_type = req.type.lower()

    if not q:
        return SearchResponse(results=[], query=req.query, type=req.type)

    if search_type in ("all", "unified"):
        results = _unified_omnisearch(q, limit=req.limit)
    elif search_type == "apps":
        results = search_apps(q, limit=req.limit)
    elif search_type == "files":
        results = fuzzy_file_search(q, _current_folders, limit=req.limit)
    elif search_type in ("content", "semantic"):
        if not _model_ready.is_set():
            results = fuzzy_file_search(q, _current_folders, limit=req.limit)
        else:
            results = semantic_search(q, limit=req.limit)
    elif search_type == "actions":
        results = evaluate_quick_query(q)
    else:
        results = _unified_omnisearch(q, limit=req.limit)

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


@app.get("/engine/settings")
async def get_engine_settings():
    data = engine_settings.load()
    data["indexing"] = bool(_index_thread and _index_thread.is_alive())
    return data


@app.post("/engine/settings")
async def set_engine_settings(req: EngineSettingsRequest):
    """Update engine settings and report what the change costs.

    Turning quantization on or off moves every vector to a different space, so
    the index has to be rebuilt; enabling OCR only means images that were
    skipped can now be read, which is a rebuild worth suggesting but not forcing.
    """
    before = engine_settings.load()
    changes = {k: v for k, v in req.model_dump().items() if v is not None}
    after = engine_settings.update(changes)

    quantize_changed = before.get("quantize") != after.get("quantize")
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
        **after,
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
    try:
        p = _port_file_path()
        if os.path.exists(p):
            os.remove(p)
    except Exception:
        pass


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


def _prewarm_caches():
    """Pre-populate file and app caches so first search is instant."""
    try:
        from app_launcher import _refresh_cache as refresh_apps
        refresh_apps()
        logger.info("App cache pre-warmed")
    except Exception as e:
        logger.warning("App cache pre-warm failed: %s", e)

    try:
        from file_search import refresh_file_cache, _get_default_system_folders
        default_folders = _get_default_system_folders()
        if default_folders:
            refresh_file_cache(default_folders, force=True)
            logger.info("File cache pre-warmed with %d locations", len(default_folders))
    except Exception as e:
        logger.warning("File cache pre-warm failed: %s", e)


def main():
    import atexit
    port = find_free_port()
    _write_port_file(port)
    atexit.register(_remove_port_file)

    print(f"PORT={port}", flush=True)
    logger.info("Starting LocalMind AI Engine on port %d", port)

    _check_model_migration()
    db.get_table()

    logger.info("Loading embedding model in background...")
    model_thread = threading.Thread(target=_load_model_background, daemon=True)
    model_thread.start()

    # Pre-warm file and app caches in background so first search is instant
    prewarm_thread = threading.Thread(target=_prewarm_caches, daemon=True)
    prewarm_thread.start()

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
