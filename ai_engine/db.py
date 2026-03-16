from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

import lancedb
import numpy as np
import pyarrow as pa

from embedder import EMBEDDING_DIM

logger = logging.getLogger(__name__)

DB_DIR = os.path.join(str(Path.home()), ".localmind", "db")
TABLE_NAME = "file_chunks"

_db: Optional[lancedb.DBConnection] = None
_table = None

SCHEMA = pa.schema([
    pa.field("text", pa.utf8()),
    pa.field("file_path", pa.utf8()),
    pa.field("file_name", pa.utf8()),
    pa.field("chunk_index", pa.int32()),
    pa.field("file_hash", pa.utf8()),
    pa.field("indexed_at", pa.float64()),
    pa.field("file_ext", pa.utf8()),
    pa.field("file_size", pa.int64()),
    pa.field("file_modified", pa.float64()),
    pa.field("line_start", pa.int32()),
    pa.field("line_end", pa.int32()),
    pa.field("vector", pa.list_(pa.float32(), EMBEDDING_DIM)),
])

_hash_cache: dict[str, str] = {}
_hash_cache_loaded = False


def get_db() -> lancedb.DBConnection:
    global _db
    if _db is None:
        os.makedirs(DB_DIR, exist_ok=True)
        _db = lancedb.connect(DB_DIR)
    return _db


def get_table():
    global _table
    if _table is not None:
        return _table
    db = get_db()
    try:
        _table = db.open_table(TABLE_NAME)
    except Exception:
        _table = db.create_table(TABLE_NAME, schema=SCHEMA)
    return _table


def _load_hash_cache() -> None:
    global _hash_cache, _hash_cache_loaded
    if _hash_cache_loaded:
        return
    try:
        table = get_table()
        df = table.to_pandas(columns=["file_path", "file_hash"])
        if len(df) > 0:
            for _, row in df.drop_duplicates(subset=["file_path"]).iterrows():
                _hash_cache[row["file_path"]] = row["file_hash"]
        logger.info("Hash cache loaded: %d files", len(_hash_cache))
    except Exception:
        pass
    _hash_cache_loaded = True


def add_chunks(
    texts: list[str],
    file_path: str,
    file_name: str,
    file_hash: str,
    vectors: np.ndarray,
    timestamp: float,
    file_ext: str = "",
    file_size: int = 0,
    file_modified: float = 0.0,
    line_ranges: list[tuple[int, int]] | None = None,
) -> None:
    table = get_table()
    records = []
    for i, (text, vec) in enumerate(zip(texts, vectors)):
        ls, le = (line_ranges[i] if line_ranges and i < len(line_ranges) else (0, 0))
        records.append({
            "text": text,
            "file_path": file_path,
            "file_name": file_name,
            "chunk_index": i,
            "file_hash": file_hash,
            "indexed_at": timestamp,
            "file_ext": file_ext,
            "file_size": file_size,
            "file_modified": file_modified,
            "line_start": ls,
            "line_end": le,
            "vector": vec.tolist(),
        })
    if records:
        table.add(records)
        _hash_cache[file_path] = file_hash


def add_chunks_bulk(all_records: list[dict]) -> None:
    if not all_records:
        return
    table = get_table()
    table.add(all_records)
    for r in all_records:
        _hash_cache[r["file_path"]] = r["file_hash"]


def search_vectors(
    query_vector: np.ndarray,
    limit: int = 20,
    where_clause: str | None = None,
) -> list[dict]:
    table = get_table()
    try:
        fetch_limit = limit * 4
        q = table.search(query_vector.tolist()).metric("cosine")
        if where_clause:
            try:
                results = q.where(where_clause).limit(fetch_limit).to_arrow()
            except Exception:
                logger.warning("Where clause failed, searching without filter")
                results = q.limit(fetch_limit).to_arrow()
        else:
            results = q.limit(fetch_limit).to_arrow()

        has_line = "line_start" in results.column_names
        has_ext = "file_ext" in results.column_names
        has_size = "file_size" in results.column_names
        has_modified = "file_modified" in results.column_names

        items = []
        seen_files: dict[str, int] = {}
        MAX_CHUNKS_PER_FILE = 3

        for i in range(len(results)):
            fp = results.column("file_path")[i].as_py()
            seen_count = seen_files.get(fp, 0)
            if seen_count >= MAX_CHUNKS_PER_FILE:
                continue
            seen_files[fp] = seen_count + 1

            dist = results.column("_distance")[i].as_py() or 0.0
            score = round(max(0.0, 1.0 - dist), 4)

            raw_text = results.column("text")[i].as_py()
            if raw_text.startswith("[File:"):
                nl_idx = raw_text.find("\n")
                snippet = raw_text[nl_idx + 1:nl_idx + 301].strip() if nl_idx != -1 else raw_text[:300]
            else:
                snippet = raw_text[:300]

            item = {
                "fileName": results.column("file_name")[i].as_py(),
                "filePath": fp,
                "snippet": snippet,
                "score": score,
                "chunkIndex": results.column("chunk_index")[i].as_py(),
            }
            if has_line:
                item["lineStart"] = results.column("line_start")[i].as_py()
                item["lineEnd"] = results.column("line_end")[i].as_py()
            if has_ext:
                item["fileExt"] = results.column("file_ext")[i].as_py()
            if has_size:
                item["fileSize"] = results.column("file_size")[i].as_py()
            if has_modified:
                item["fileModified"] = results.column("file_modified")[i].as_py()
            items.append(item)

            if len(items) >= limit:
                break

        return items
    except Exception as e:
        logger.error("Search error: %s", e)
        return []


def get_file_embeddings(file_path: str) -> list[list[float]]:
    """Get all chunk embeddings for a specific file."""
    table = get_table()
    try:
        escaped = file_path.replace("\\", "\\\\").replace("'", "\\'")
        results = table.search().where(f"file_path = '{escaped}'").limit(1000).to_arrow()
        vectors = []
        for i in range(len(results)):
            vectors.append(results.column("vector")[i].as_py())
        return vectors
    except Exception as e:
        logger.error("get_file_embeddings error: %s", e)
        return []


def get_index_stats() -> dict:
    """Return indexing statistics."""
    try:
        table = get_table()
        total_chunks = table.count_rows()
        df = table.to_pandas(columns=["file_path", "file_ext", "file_size", "indexed_at"])
        unique_files = df.drop_duplicates(subset=["file_path"])
        total_files = len(unique_files)
        total_size = int(unique_files["file_size"].sum()) if "file_size" in unique_files.columns else 0
        last_indexed = float(df["indexed_at"].max()) if len(df) > 0 else 0

        ext_counts = {}
        if "file_ext" in unique_files.columns:
            for ext, count in unique_files["file_ext"].value_counts().items():
                ext_counts[ext] = int(count)

        return {
            "total_files": total_files,
            "total_chunks": total_chunks,
            "total_size": total_size,
            "last_indexed": last_indexed,
            "file_types": ext_counts,
        }
    except Exception as e:
        logger.error("get_index_stats error: %s", e)
        return {
            "total_files": 0,
            "total_chunks": 0,
            "total_size": 0,
            "last_indexed": 0,
            "file_types": {},
        }


def remove_file_chunks(file_path: str) -> None:
    table = get_table()
    try:
        escaped = file_path.replace("\\", "\\\\").replace("'", "\\'")
        table.delete(f"file_path = '{escaped}'")
        _hash_cache.pop(file_path, None)
    except Exception as e:
        logger.warning("Failed to remove chunks for %s: %s", file_path, e)


def file_exists_with_hash(file_path: str, file_hash: str) -> bool:
    _load_hash_cache()
    return _hash_cache.get(file_path) == file_hash


def drop_all() -> None:
    global _table, _hash_cache, _hash_cache_loaded
    db = get_db()
    try:
        db.drop_table(TABLE_NAME)
    except Exception:
        pass
    _table = None
    _hash_cache.clear()
    _hash_cache_loaded = False


def count_rows() -> int:
    try:
        table = get_table()
        return table.count_rows()
    except Exception:
        return 0
