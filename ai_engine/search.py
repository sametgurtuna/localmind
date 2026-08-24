"""Hybrid Semantic & Keyword Content Search Engine with Contextual Snippet Extraction."""
from __future__ import annotations

import logging
import re
import time
from collections import OrderedDict
from rapidfuzz import fuzz

from embedder import get_embedding
from query_parser import parse_query
import db

logger = logging.getLogger(__name__)

_embedding_cache: OrderedDict[str, tuple] = OrderedDict()
_CACHE_MAX = 250


def _get_cached_embedding(query: str):
    key = query.strip().lower()
    if key in _embedding_cache:
        vec, _ts = _embedding_cache[key]
        _embedding_cache.move_to_end(key)
        return vec
    return None


def _cache_embedding(query: str, vec):
    key = query.strip().lower()
    _embedding_cache[key] = (vec, time.time())
    if len(_embedding_cache) > _CACHE_MAX:
        _embedding_cache.popitem(last=False)


def _extract_clean_snippet(raw_text: str, query_words: list[str], max_len: int = 240) -> str:
    """Extract clean context snippet stripped of header and centered on matched query terms."""
    if not raw_text:
        return ""

    text = db.strip_context_header(raw_text)

    if not query_words:
        return text[:max_len].strip()

    text_lower = text.lower()
    best_pos = -1
    for w in query_words:
        pos = text_lower.find(w)
        if pos != -1:
            if best_pos == -1 or pos < best_pos:
                best_pos = pos

    if best_pos == -1:
        return text[:max_len].strip()

    # Center snippet around best match
    half = max_len // 2
    start = max(0, best_pos - half)
    end = min(len(text), start + max_len)

    snippet = text[start:end].strip()
    if start > 0:
        snippet = "..." + snippet
    if end < len(text):
        snippet = snippet + "..."
    return snippet


def semantic_search(query: str, limit: int = 15) -> list[dict]:
    """Perform hybrid dense vector + keyword content search over LanceDB chunks."""
    q = query.strip()
    if not q:
        return []

    parsed = parse_query(q)
    search_text = parsed.text if parsed.text else q
    query_words = [w.lower() for w in re.findall(r"\w+", search_text) if len(w) >= 2]

    vec = _get_cached_embedding(search_text)
    if vec is None:
        try:
            vec = get_embedding(search_text)
            _cache_embedding(search_text, vec)
        except Exception as e:
            logger.error("Failed to generate query embedding: %s", e)
            return []

    try:
        vector_results = db.search_vectors(vec, limit=limit * 2, where_clause=parsed.where)
    except Exception as e:
        logger.error("Vector search failed: %s", e)
        vector_results = []

    results = []
    seen_files = set()

    for item in vector_results:
        fpath = item["filePath"]
        # Deduplicate multiple chunks from the same file to diversify results
        if fpath in seen_files:
            continue
        seen_files.add(fpath)

        snippet = _extract_clean_snippet(item.get("snippet", ""), query_words)
        score = item.get("score", 0.0)

        # Keyword boost if exact terms appear in snippet or file name
        fname_lower = item.get("fileName", "").lower()
        snippet_lower = snippet.lower()
        if query_words and all(w in fname_lower or w in snippet_lower for w in query_words):
            score = min(1.0, score + 0.15)
        elif query_words and any(w in snippet_lower for w in query_words):
            score = min(1.0, score + 0.08)

        results.append({
            "fileName": item.get("fileName", ""),
            "filePath": fpath,
            "snippet": snippet,
            "score": round(score, 3),
            "chunkIndex": item.get("chunkIndex", 0),
            "lineStart": item.get("lineStart", 0),
            "lineEnd": item.get("lineEnd", 0),
            "fileExt": item.get("fileExt", ""),
            "fileSize": item.get("fileSize", 0),
            "fileModified": item.get("fileModified", 0),
            "category": "content",
            "action": "open_file",
            "actionTitle": "Open File",
        })

        if len(results) >= limit:
            break

    return results
