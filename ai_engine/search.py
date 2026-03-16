from __future__ import annotations

import logging
import time
from collections import OrderedDict

from rapidfuzz import fuzz

from embedder import get_embedding
from query_parser import parse_query
import db

logger = logging.getLogger(__name__)

_embedding_cache: OrderedDict[str, tuple] = OrderedDict()
_CACHE_MAX = 200


def _get_cached_embedding(query: str):
    key = query.strip().lower()
    if key in _embedding_cache:
        vec, ts = _embedding_cache[key]
        _embedding_cache.move_to_end(key)
        return vec
    return None


def _cache_embedding(query: str, vec):
    key = query.strip().lower()
    _embedding_cache[key] = (vec, time.time())
    if len(_embedding_cache) > _CACHE_MAX:
        _embedding_cache.popitem(last=False)


def _recency_score(file_modified: float) -> float:
    if not file_modified:
        return 0.0
    age_days = (time.time() - file_modified) / 86400
    if age_days <= 1:
        return 1.0
    if age_days <= 7:
        return 0.8
    if age_days <= 30:
        return 0.5
    if age_days <= 90:
        return 0.3
    return 0.1


def _name_and_path_match(query_words: list[str], file_name: str, file_path: str) -> float:
    """Combined fuzzy + keyword match on file name and path. Returns 0-1."""
    if not query_words:
        return 0.0

    name_lower = file_name.lower()
    path_lower = file_path.lower().replace("\\", "/")
    query_joined = " ".join(query_words)

    fuzzy_name = fuzz.partial_ratio(query_joined, name_lower) / 100.0
    fuzzy_path = fuzz.partial_ratio(query_joined, path_lower) / 100.0

    keyword_hits = 0
    for w in query_words:
        if w in name_lower:
            keyword_hits += 2
        elif w in path_lower:
            keyword_hits += 1
    keyword_score = min(1.0, keyword_hits / max(len(query_words), 1))

    return max(fuzzy_name * 0.8, fuzzy_path * 0.5, keyword_score)


_file_index_cache: list[dict] | None = None
_file_index_cache_time: float = 0
_FILE_INDEX_TTL = 30


def _get_file_index() -> list[dict]:
    """Cached list of unique indexed files with metadata."""
    global _file_index_cache, _file_index_cache_time
    now = time.time()
    if _file_index_cache is not None and (now - _file_index_cache_time) < _FILE_INDEX_TTL:
        return _file_index_cache

    try:
        table = db.get_table()
        cols = ["file_name", "file_path", "text", "chunk_index"]
        for c in ("file_ext", "file_size", "file_modified", "line_start", "line_end"):
            cols.append(c)
        df = table.to_pandas(columns=cols)
    except Exception:
        return []

    if len(df) == 0:
        return []

    first_chunks = df.sort_values("chunk_index").drop_duplicates(subset=["file_path"], keep="first")
    entries = []
    for _, row in first_chunks.iterrows():
        raw_text = str(row.get("text", ""))
        if raw_text.startswith("[File:"):
            nl_idx = raw_text.find("\n")
            snippet = raw_text[nl_idx + 1:nl_idx + 301].strip() if nl_idx != -1 else raw_text[:300]
        else:
            snippet = raw_text[:300]

        entries.append({
            "fileName": str(row.get("file_name", "")),
            "filePath": str(row.get("file_path", "")),
            "snippet": snippet,
            "chunkIndex": 0,
            "lineStart": int(row.get("line_start", 0) or 0),
            "lineEnd": int(row.get("line_end", 0) or 0),
            "fileExt": str(row.get("file_ext", "") or ""),
            "fileSize": int(row.get("file_size", 0) or 0),
            "fileModified": float(row.get("file_modified", 0) or 0),
        })

    _file_index_cache = entries
    _file_index_cache_time = now
    return entries


def invalidate_file_index_cache():
    global _file_index_cache
    _file_index_cache = None


def _get_db_filename_matches(query_words: list[str], limit: int = 10) -> list[dict]:
    """Search indexed files by name/path matching from the DB directly."""
    if not query_words:
        return []

    entries = _get_file_index()
    if not entries:
        return []

    scored = []
    for entry in entries:
        name_score = _name_and_path_match(query_words, entry["fileName"], entry["filePath"])
        if name_score >= 0.35:
            result = dict(entry)
            result["score"] = round(name_score, 4)
            scored.append(result)

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]


def _merge_results(vector_results: list[dict], name_results: list[dict], limit: int) -> list[dict]:
    """Merge vector search results with filename match results, deduplicating by file path."""
    seen: dict[str, dict] = {}

    for r in name_results:
        fp = r["filePath"]
        r["_name_score"] = r["score"]
        r["_vec_score"] = 0.0
        seen[fp] = r

    for r in vector_results:
        fp = r["filePath"]
        if fp in seen:
            seen[fp]["_vec_score"] = max(seen[fp].get("_vec_score", 0), r["score"])
            if r.get("score", 0) > seen[fp].get("score", 0) * 0.8:
                seen[fp]["snippet"] = r["snippet"]
        else:
            r["_name_score"] = 0.0
            r["_vec_score"] = r["score"]
            seen[fp] = r

    for fp, r in seen.items():
        vec_s = r.get("_vec_score", 0)
        name_s = r.get("_name_score", 0)
        recency = _recency_score(r.get("fileModified", 0))

        r["score"] = round(
            0.45 * max(vec_s, 0) +
            0.40 * max(name_s, 0) +
            0.10 * recency +
            0.05 * 0.5,
            4,
        )

    merged = sorted(seen.values(), key=lambda x: x["score"], reverse=True)

    for r in merged:
        r.pop("_name_score", None)
        r.pop("_vec_score", None)

    return merged[:limit]


def semantic_search(query: str, limit: int = 15) -> list[dict]:
    parsed = parse_query(query)
    search_text = parsed.text if parsed.text else query

    query_words = [w.lower() for w in search_text.split() if len(w) >= 2]

    vec = _get_cached_embedding(search_text)
    if vec is None:
        vec = get_embedding(search_text)
        _cache_embedding(search_text, vec)

    vector_results = db.search_vectors(vec, limit=limit * 2, where_clause=parsed.where)

    name_results = _get_db_filename_matches(query_words, limit=limit)

    return _merge_results(vector_results, name_results, limit)
