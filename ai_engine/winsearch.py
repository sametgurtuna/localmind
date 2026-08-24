"""Windows Search Indexer Integration via OLE DB (Search.CollatorDSO).

Provides ultra-fast (<100ms) whole-PC file searching across all indexed drives and folders.
Uses a dedicated worker thread with persistent ADODB.Connection for maximum throughput.
"""
from __future__ import annotations

import logging
import os
import queue
import re
import sys
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

# Cache connection status
_winsearch_available: bool | None = None

STOP_WORDS = frozenset({
    "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with",
    "by", "from", "is", "it", "this", "that", "ve", "veya", "ile", "icin", "bir",
    "bu", "su", "o", "da", "de", "mi", "mu",
})

NOISE_PATH_SUBSTRINGS = (
    "\\appdata\\local\\temp\\",
    "\\$recycle.bin\\",
    "\\windows\\wer\\",
    "\\.git\\",
    "\\node_modules\\",
    "\\__pycache__\\",
)


def normalize_query_tokens(raw_query: str) -> list[str]:
    """Extract clean, alphanumeric search tokens from raw query with normalization."""
    if not raw_query:
        return []
    q = raw_query.lower()
    q = q.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("`", "'")
    q = re.sub(r"['']s\b", "s", q)  # gamer's -> gamers
    q = q.replace("'", "")
    q = re.sub(r"[-_./\\:;,()\[\]{}|#+*~]", " ", q)
    tokens = [w for w in q.split() if w and len(w) >= 1]
    return tokens


def is_winsearch_available() -> bool:
    """Check if Windows Search service & ADODB provider are available."""
    global _winsearch_available
    if sys.platform != "win32":
        return False
    if _winsearch_available is not None:
        return _winsearch_available

    try:
        import pythoncom
        import win32com.client

        pythoncom.CoInitialize()
        try:
            conn = win32com.client.Dispatch("ADODB.Connection")
            conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
            conn.Close()
            _winsearch_available = True
            logger.info("Windows Search provider (Search.CollatorDSO) is available.")
        finally:
            pythoncom.CoUninitialize()
    except Exception as e:
        logger.warning("Windows Search provider not available: %s", e)
        _winsearch_available = False

    return _winsearch_available


class _WinSearchWorker:
    """Dedicated background worker thread holding a persistent ADODB connection."""

    def __init__(self):
        self._req_queue: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def _ensure_started(self):
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._worker_loop, daemon=True, name="WinSearchWorker")
                self._thread.start()

    def _worker_loop(self):
        if sys.platform != "win32":
            return
        try:
            import pythoncom
            import win32com.client
        except ImportError:
            return

        pythoncom.CoInitialize()
        conn = None
        try:
            try:
                conn = win32com.client.Dispatch("ADODB.Connection")
                conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
            except Exception as e:
                logger.warning("Failed to open persistent ADODB connection: %s", e)
                conn = None

            while True:
                req = self._req_queue.get()
                if req is None:
                    break

                sql, resp_event, resp_container = req
                if conn is None:
                    try:
                        conn = win32com.client.Dispatch("ADODB.Connection")
                        conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
                    except Exception as e:
                        logger.warning("Re-open ADODB failed: %s", e)
                        resp_container.append([])
                        resp_event.set()
                        continue

                results = []
                try:
                    rs = win32com.client.Dispatch("ADODB.Recordset")
                    rs.Open(sql, conn)
                    while not rs.EOF:
                        name = rs.Fields(0).Value or ""
                        path = rs.Fields(1).Value or ""
                        size = rs.Fields(2).Value or 0
                        mtime_raw = rs.Fields(3).Value
                        ext = rs.Fields(4).Value or os.path.splitext(name)[1].lower()

                        mtime = 0.0
                        try:
                            if mtime_raw:
                                mtime = float(mtime_raw.timestamp())
                        except Exception:
                            pass

                        if name and path:
                            path_lower = path.lower()
                            if not any(noise in path_lower for noise in NOISE_PATH_SUBSTRINGS):
                                clean_ext = ext if ext.startswith(".") else f".{ext}" if ext else ""
                                clean_size = int(size) if size else 0
                                results.append({
                                    "fileName": name,
                                    "filePath": path,
                                    "fileSize": clean_size,
                                    "fileModified": mtime,
                                    "fileExt": clean_ext.lower(),
                                })
                        rs.MoveNext()
                    rs.Close()
                except Exception as e:
                    logger.warning("ADODB query execution error: %s", e)
                    try:
                        if conn:
                            conn.Close()
                    except Exception:
                        pass
                    conn = None

                resp_container.append(results)
                resp_event.set()

        finally:
            if conn:
                try:
                    conn.Close()
                except Exception:
                    pass
            pythoncom.CoUninitialize()

    def execute_sql(self, sql: str, timeout: float = 0.25) -> list[dict]:
        self._ensure_started()
        resp_event = threading.Event()
        resp_container: list[Any] = []
        self._req_queue.put((sql, resp_event, resp_container))
        if resp_event.wait(timeout=timeout):
            return resp_container[0] if resp_container else []
        return []


_worker = _WinSearchWorker()
# Start worker thread immediately on import so ADODB connection is ready when search is called
if sys.platform == "win32":
    _worker._ensure_started()


def query_windows_search(query: str, limit: int = 30) -> list[dict]:
    """Execute a high-speed SQL query against the Windows Search Indexer.

    Returns a list of dicts:
    [{'fileName': str, 'filePath': str, 'fileSize': int, 'fileModified': float, 'fileExt': str}]
    """
    if sys.platform != "win32":
        return []

    q = query.strip()
    if not q:
        return []

    tokens = normalize_query_tokens(q)
    if not tokens:
        return []

    # Fast B-Tree conditions on System.ItemName
    token_conds = []
    for t in tokens:
        t_safe = t.replace("'", "''")
        root = t_safe[:-1] if (t_safe.endswith("s") and len(t_safe) > 3) else t_safe
        token_conds.append(f"System.ItemName LIKE '%{root}%'")

    where_clause = " AND ".join(token_conds)

    sql = f"""
    SELECT TOP {limit} System.ItemName, System.ItemPathDisplay, System.Size, System.DateModified, System.FileExtension
    FROM SystemIndex
    WHERE {where_clause}
    """

    return _worker.execute_sql(sql, timeout=0.20)
