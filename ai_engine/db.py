from __future__ import annotations

import logging
import math
import os
import threading
from pathlib import Path
from typing import Iterator, Optional

import lancedb
import numpy as np
import pyarrow as pa

from embedder import EMBEDDING_DIM

logger = logging.getLogger(__name__)

DB_DIR = os.path.join(str(Path.home()), ".localmind", "db")
TABLE_NAME = "file_chunks"

# Build an ANN index once the table is large enough that a flat scan hurts.
ANN_MIN_ROWS = int(os.environ.get("LOCALMIND_ANN_MIN_ROWS", "30000"))

# Columns needed to render a result. The `vector` column is deliberately excluded:
# fetching 384 floats per candidate row dominated search latency.
RESULT_COLUMNS = [
    "text", "file_path", "file_name", "chunk_index",
    "file_ext", "file_size", "file_modified", "line_start", "line_end",
]

_db: Optional[lancedb.DBConnection] = None
_table = None
_table_lock = threading.Lock()

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

_stats_cache: dict | None = None
_stats_cache_rows: int = -1

_has_ann_index: bool | None = None


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
    with _table_lock:
        if _table is not None:
            return _table
        db = get_db()
        try:
            _table = db.open_table(TABLE_NAME)
        except Exception:
            _table = db.create_table(TABLE_NAME, schema=SCHEMA)
    return _table


def _scan_columns(columns: list[str], batch_size: int = 50000) -> Iterator[pa.Table]:
    """Stream selected columns without materializing the whole table.

    Replaces the old `to_pandas()` calls, which pulled every row (and pandas
    itself) into memory just to read two string columns.
    """
    table = get_table()
    offset = 0
    while True:
        batch = (
            table.search()
            .select(columns)
            .limit(batch_size)
            .offset(offset)
            .to_arrow()
        )
        if len(batch) == 0:
            return
        yield batch
        offset += len(batch)


def _load_hash_cache() -> None:
    global _hash_cache_loaded
    if _hash_cache_loaded:
        return
    try:
        for batch in _scan_columns(["file_path", "file_hash"]):
            paths = batch.column("file_path").to_pylist()
            hashes = batch.column("file_hash").to_pylist()
            for p, h in zip(paths, hashes):
                _hash_cache[p] = h
        logger.info("Hash cache loaded: %d files", len(_hash_cache))
    except Exception as e:
        logger.debug("Hash cache load skipped: %s", e)
    _hash_cache_loaded = True


def strip_context_header(raw_text: str) -> str:
    """Remove the leading `[name in folder]` provenance line added at index time.

    Older indexes used a `[File: ... | Path: ...]` header; both shapes start
    with a bracketed first line, so one rule covers them.
    """
    if not raw_text.startswith("["):
        return raw_text
    nl = raw_text.find("\n")
    if nl == -1 or "]" not in raw_text[:nl]:
        return raw_text
    return raw_text[nl + 1:].lstrip()


def _escape(value: str) -> str:
    """Quote a value for a LanceDB (DataFusion) SQL filter.

    Only the single quote is special: doubling it is the escape. The previous
    code also doubled backslashes, which meant no Windows path ever matched --
    so deletes silently affected zero rows and stale chunks piled up on every
    re-index.
    """
    return value.replace("'", "''")


def _vectors_to_arrow(vectors: np.ndarray) -> pa.FixedSizeListArray:
    """Wrap an (n, dim) float32 array as an Arrow fixed-size list, zero-copy.

    Going through `.tolist()` allocated one Python float per dimension --
    ~100k short-lived objects per batch.
    """
    arr = np.ascontiguousarray(vectors, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[1] != EMBEDDING_DIM:
        raise ValueError(f"Expected (n, {EMBEDDING_DIM}) vectors, got {arr.shape}")
    flat = pa.array(arr.reshape(-1))
    return pa.FixedSizeListArray.from_arrays(flat, EMBEDDING_DIM)


def add_records_arrow(metas: list[dict], vectors: np.ndarray) -> None:
    """Append chunk rows built directly as Arrow columns."""
    if not metas:
        return

    columns = {
        "text": pa.array([m["text"] for m in metas], pa.utf8()),
        "file_path": pa.array([m["file_path"] for m in metas], pa.utf8()),
        "file_name": pa.array([m["file_name"] for m in metas], pa.utf8()),
        "chunk_index": pa.array([m["chunk_index"] for m in metas], pa.int32()),
        "file_hash": pa.array([m["file_hash"] for m in metas], pa.utf8()),
        "indexed_at": pa.array([m["indexed_at"] for m in metas], pa.float64()),
        "file_ext": pa.array([m.get("file_ext", "") for m in metas], pa.utf8()),
        "file_size": pa.array([m.get("file_size", 0) for m in metas], pa.int64()),
        "file_modified": pa.array([m.get("file_modified", 0.0) for m in metas], pa.float64()),
        "line_start": pa.array([m.get("line_start", 0) for m in metas], pa.int32()),
        "line_end": pa.array([m.get("line_end", 0) for m in metas], pa.int32()),
        "vector": _vectors_to_arrow(vectors),
    }
    batch = pa.table([columns[f.name] for f in SCHEMA], schema=SCHEMA)

    get_table().add(batch)
    for m in metas:
        _hash_cache[m["file_path"]] = m["file_hash"]
    _invalidate_stats()


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
    metas = []
    for i, text in enumerate(texts):
        ls, le = (line_ranges[i] if line_ranges and i < len(line_ranges) else (0, 0))
        metas.append({
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
        })
    add_records_arrow(metas, np.asarray(vectors))


def add_chunks_bulk(all_records: list[dict]) -> None:
    """Compatibility path for records carrying an inline `vector` list."""
    if not all_records:
        return
    vectors = np.asarray([r.pop("vector") for r in all_records], dtype=np.float32)
    add_records_arrow(all_records, vectors)


def search_vectors(
    query_vector: np.ndarray,
    limit: int = 20,
    where_clause: str | None = None,
) -> list[dict]:
    try:
        table = get_table()
        fetch_limit = limit * 4
        q = (
            table.search(np.asarray(query_vector, dtype=np.float32))
            .metric("cosine")
            .select(RESULT_COLUMNS)
        )
        if _ann_index_ready():
            try:
                q = q.nprobes(20).refine_factor(2)
            except Exception:
                pass

        if where_clause:
            try:
                results = q.where(where_clause, prefilter=True).limit(fetch_limit).to_arrow()
            except Exception:
                logger.warning("Where clause failed, searching without filter")
                results = q.limit(fetch_limit).to_arrow()
        else:
            results = q.limit(fetch_limit).to_arrow()

        return _rows_from_arrow(results, limit)
    except Exception as e:
        logger.error("Search error: %s", e)
        return []


def _rows_from_arrow(results: pa.Table, limit: int) -> list[dict]:
    """Convert Arrow results to dicts with one bulk conversion per column."""
    n = len(results)
    if n == 0:
        return []

    names = set(results.column_names)

    def col(name, default=None):
        return results.column(name).to_pylist() if name in names else [default] * n

    file_paths = col("file_path", "")
    file_names = col("file_name", "")
    texts = col("text", "")
    chunk_idxs = col("chunk_index", 0)
    dists = col("_distance", 0.0)
    line_starts = col("line_start", 0)
    line_ends = col("line_end", 0)
    exts = col("file_ext", "")
    sizes = col("file_size", 0)
    mods = col("file_modified", 0.0)

    items: list[dict] = []
    seen_files: dict[str, int] = {}
    MAX_CHUNKS_PER_FILE = 3

    for i in range(n):
        fp = file_paths[i]
        seen_count = seen_files.get(fp, 0)
        if seen_count >= MAX_CHUNKS_PER_FILE:
            continue
        seen_files[fp] = seen_count + 1

        score = round(max(0.0, 1.0 - (dists[i] or 0.0)), 4)

        raw_text = strip_context_header(texts[i] or "")
        snippet = raw_text[:300]

        items.append({
            "fileName": file_names[i],
            "filePath": fp,
            "snippet": snippet,
            "score": score,
            "chunkIndex": chunk_idxs[i],
            "lineStart": line_starts[i],
            "lineEnd": line_ends[i],
            "fileExt": exts[i],
            "fileSize": sizes[i],
            "fileModified": mods[i],
        })

        if len(items) >= limit:
            break

    return items


def get_file_embeddings(file_path: str) -> list[list[float]]:
    """Get all chunk embeddings for a specific file."""
    try:
        results = (
            get_table()
            .search()
            .where(f"file_path = '{_escape(file_path)}'")
            .select(["vector"])
            .limit(1000)
            .to_arrow()
        )
        return results.column("vector").to_pylist()
    except Exception as e:
        logger.error("get_file_embeddings error: %s", e)
        return []


def _invalidate_stats() -> None:
    global _stats_cache
    _stats_cache = None


def get_index_stats() -> dict:
    """Return indexing statistics by streaming columns (no pandas materialization)."""
    global _stats_cache, _stats_cache_rows
    try:
        total_chunks = get_table().count_rows()
        if _stats_cache is not None and _stats_cache_rows == total_chunks:
            return _stats_cache

        seen: dict[str, tuple[str, int]] = {}
        last_indexed = 0.0
        for batch in _scan_columns(["file_path", "file_ext", "file_size", "indexed_at"]):
            paths = batch.column("file_path").to_pylist()
            exts = batch.column("file_ext").to_pylist()
            sizes = batch.column("file_size").to_pylist()
            times = batch.column("indexed_at").to_pylist()
            for p, e, s, t in zip(paths, exts, sizes, times):
                if p not in seen:
                    seen[p] = (e or "", int(s or 0))
                if t and t > last_indexed:
                    last_indexed = t

        ext_counts: dict[str, int] = {}
        total_size = 0
        for ext, size in seen.values():
            total_size += size
            ext_counts[ext] = ext_counts.get(ext, 0) + 1

        stats = {
            "total_files": len(seen),
            "total_chunks": total_chunks,
            "total_size": total_size,
            "last_indexed": last_indexed,
            "file_types": ext_counts,
        }
        _stats_cache = stats
        _stats_cache_rows = total_chunks
        return stats
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
    remove_files_chunks([file_path])


def remove_files_chunks(file_paths: list[str], batch: int = 200) -> None:
    """Delete chunks for many files in a few statements.

    Deleting one path at a time made LanceDB rewrite fragments per file, which
    was a large part of re-index time.
    """
    if not file_paths:
        return
    table = get_table()
    for i in range(0, len(file_paths), batch):
        group = file_paths[i:i + batch]
        joined = ", ".join(f"'{_escape(p)}'" for p in group)
        try:
            table.delete(f"file_path IN ({joined})")
        except Exception as e:
            logger.warning("Batch delete failed (%d paths): %s", len(group), e)
        for p in group:
            _hash_cache.pop(p, None)
    _invalidate_stats()


def file_exists_with_hash(file_path: str, file_hash: str) -> bool:
    _load_hash_cache()
    return _hash_cache.get(file_path) == file_hash


def known_hashes() -> dict[str, str]:
    _load_hash_cache()
    return _hash_cache


def _ann_index_ready() -> bool:
    global _has_ann_index
    if _has_ann_index is None:
        try:
            _has_ann_index = any(
                "vector" in str(getattr(idx, "columns", idx))
                for idx in get_table().list_indices()
            )
        except Exception:
            _has_ann_index = False
    return bool(_has_ann_index)


def optimize(build_ann: bool = True) -> None:
    """Compact fragments and (re)build indices after a bulk index run."""
    global _has_ann_index
    table = get_table()

    try:
        table.optimize()
        logger.info("Table compacted")
    except Exception as e:
        logger.debug("Compaction skipped: %s", e)

    try:
        table.create_scalar_index("file_path", index_type="BTREE", replace=True)
        logger.info("Scalar index on file_path ready")
    except Exception as e:
        logger.debug("Scalar index skipped: %s", e)

    if not build_ann:
        return

    try:
        rows = table.count_rows()
        if rows < ANN_MIN_ROWS:
            logger.info("Skipping ANN index (%d rows < %d)", rows, ANN_MIN_ROWS)
            return
        partitions = max(1, min(512, int(math.sqrt(rows))))
        table.create_index(
            metric="cosine",
            num_partitions=partitions,
            num_sub_vectors=48,  # 384 dims / 48 = 8 dims per sub-vector
            vector_column_name="vector",
            replace=True,
        )
        _has_ann_index = True
        logger.info("ANN index built (%d rows, %d partitions)", rows, partitions)
    except Exception as e:
        logger.warning("ANN index build failed: %s", e)


def drop_all() -> None:
    global _table, _hash_cache_loaded, _has_ann_index
    db = get_db()
    try:
        db.drop_table(TABLE_NAME)
    except Exception:
        pass
    _table = None
    _hash_cache.clear()
    _hash_cache_loaded = False
    _has_ann_index = None
    _invalidate_stats()


def count_rows() -> int:
    try:
        return get_table().count_rows()
    except Exception:
        return 0
