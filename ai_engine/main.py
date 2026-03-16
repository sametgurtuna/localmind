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
from indexer import index_files, rebuild_index, index_state
from search import semantic_search
from file_search import fuzzy_file_search
from app_launcher import search_apps
from watcher import FileWatcher
from extractor import SUPPORTED_EXTENSIONS, extract_text

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("localmind")

app = FastAPI(title="LocalMind AI Engine", version="0.2.0")

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


def _on_file_change(path: str, event_type: str):
    if not _model_ready.is_set():
        return
    logger.info("File %s: %s", event_type, path)
    if event_type == "deleted":
        db.remove_file_chunks(path)
    elif event_type in ("created", "modified"):
        from chunker import chunk_text_with_lines
        from indexer import file_hash

        db.remove_file_chunks(path)
        text = extract_text(path)
        if text:
            chunks_with_lines = chunk_text_with_lines(text)
            if chunks_with_lines:
                fname = os.path.basename(path)
                path_hint = path.replace("\\", "/")
                file_context = f"[File: {fname} | Path: {path_hint}]\n"
                texts = [file_context + c[0] for c in chunks_with_lines]
                vectors = embedder.get_embeddings(texts)
                ext = Path(path).suffix.lower()
                try:
                    stat = os.stat(path)
                    fsize = stat.st_size
                    fmod = stat.st_mtime
                except OSError:
                    fsize = 0
                    fmod = 0.0
                line_ranges = [(c[1], c[2]) for c in chunks_with_lines]
                db.add_chunks(
                    texts=texts,
                    file_path=path,
                    file_name=os.path.basename(path),
                    file_hash=file_hash(path),
                    vectors=vectors,
                    timestamp=time.time(),
                    file_ext=ext,
                    file_size=fsize,
                    file_modified=fmod,
                    line_ranges=line_ranges,
                )


# --- Request/Response models ---

class SearchRequest(BaseModel):
    query: str
    type: str = "semantic"
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


@app.post("/search", response_model=SearchResponse)
async def search_endpoint(req: SearchRequest):
    if req.type == "files":
        results = fuzzy_file_search(
            req.query,
            _current_folders,
            limit=req.limit,
            supported_extensions=SUPPORTED_EXTENSIONS,
        )
    elif req.type == "apps":
        results = search_apps(req.query, limit=req.limit)
    else:
        if not _model_ready.is_set():
            return SearchResponse(results=[], query=req.query, type=req.type)
        results = semantic_search(req.query, limit=req.limit)
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
    context: int = Query(50),
):
    """Return file content around a specific line for preview."""
    p = Path(path)
    if not p.exists() or not p.is_file():
        return {"content": "", "total_lines": 0, "start_line": 0}

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
            return {"content": "", "total_lines": 0, "start_line": 0}

        lines = text.split("\n")
        total = len(lines)

        if line > 0:
            start = max(0, line - context // 2)
            end = min(total, start + context)
        else:
            start = 0
            end = min(total, 200)

        content = "\n".join(lines[start:end])
        return {
            "content": content,
            "total_lines": total,
            "start_line": start + 1,
            "file_ext": p.suffix.lower(),
        }
    except Exception as e:
        logger.error("Preview error: %s", e)
        return {"content": "", "total_lines": 0, "start_line": 0}


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


@app.get("/index/folders")
async def get_folders():
    return {"folders": _current_folders}


@app.post("/index/folders")
async def set_folders(req: FoldersRequest):
    global _current_folders
    _current_folders = req.folders
    return {"folders": _current_folders}


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _check_model_migration():
    """Drop DB if embedding model changed since last index."""
    marker = os.path.join(db.DB_DIR, ".model_name")
    current_model = embedder._model_name
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
                os.makedirs(db.DB_DIR, exist_ok=True)
                with open(marker, "w") as f:
                    f.write(current_model)
                return
        db.drop_all()
    except Exception as e:
        logger.error("Model migration check error: %s", e)
    os.makedirs(db.DB_DIR, exist_ok=True)
    with open(marker, "w") as f:
        f.write(current_model)


def main():
    port = find_free_port()
    print(f"PORT={port}", flush=True)
    logger.info("Starting LocalMind AI Engine on port %d", port)

    _check_model_migration()
    db.get_table()

    logger.info("Loading embedding model in background...")
    model_thread = threading.Thread(target=_load_model_background, daemon=True)
    model_thread.start()

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
