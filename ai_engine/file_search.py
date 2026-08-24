"""High-Performance Hybrid File Search Engine with Compact In-Memory Cache & Windows Search.

Features:
- Low RAM footprint: filenames live in a single blob string plus an offset array.
- Windows Search Indexer (OLE DB) real-time provider for instant whole-PC disk searching.
- Zero-stat directory crawler for user library locations.
- Robust Unicode, Turkish char, and punctuation normalization (handles ', ’, ", -, _, Turkish chars, etc.).
- Multi-tier scoring (Exact > Full Substring > Prefix > Multi-token Match).
- Lazy metadata stat lookup on matched results only for instant responsiveness.
"""
from __future__ import annotations

import logging
import os
import re
import string
import sys
import threading
import time
from array import array
from bisect import bisect_right

try:
    from winsearch import query_windows_search, is_winsearch_available
except ImportError:
    from .winsearch import query_windows_search, is_winsearch_available

logger = logging.getLogger(__name__)


class FileIndex:
    """Filename index stored as one blob plus parallel arrays.

    Holding a 4-string tuple per file cost ~250 bytes of Python object overhead
    each; at a few hundred thousand files that dominated the process RSS. All
    normalized names now live in a single string, matched with str.find (C
    speed) instead of a Python-level loop over every entry.
    """

    __slots__ = ("blob", "offsets", "paths")

    def __init__(self, names: list[str] | None = None, paths: list[str] | None = None):
        names = names or []
        self.paths: list[str] = paths or []
        self.offsets = array("q", [0]) if names else array("q")
        parts = []
        pos = 0
        for n in names:
            parts.append(n)
            pos += len(n) + 1
            self.offsets.append(pos)
        self.blob = "\n".join(parts) + ("\n" if parts else "")

    def __len__(self) -> int:
        return len(self.paths)

    def name_at(self, i: int) -> str:
        return self.blob[self.offsets[i]:self.offsets[i + 1] - 1]

    def candidates(self, token: str, cap: int) -> list[int]:
        """Indices of entries whose normalized name contains `token`."""
        out: list[int] = []
        blob = self.blob
        offsets = self.offsets
        pos = blob.find(token)
        last = -1
        while pos != -1:
            i = bisect_right(offsets, pos) - 1
            if i != last:
                out.append(i)
                last = i
                if len(out) >= cap:
                    break
            pos = blob.find(token, pos + 1)
        return out


# Hard ceiling on cached entries so a huge drive cannot grow the index without bound.
MAX_CACHE_ENTRIES = int(os.environ.get("LOCALMIND_MAX_FILE_CACHE", "300000"))
# Upper bound on candidates examined per query token.
MAX_CANDIDATES = 4000

_file_index = FileIndex()
_cache_folders: list[str] = []
_cache_time: float = 0
_CACHE_TTL = 600  # 10 minutes cache TTL
_cache_lock = threading.Lock()
_refresh_thread: threading.Thread | None = None

# Directories to skip to prevent scanning temporary, build, game assets or system junk
SKIP_DIRS = frozenset({
    "node_modules", "__pycache__", ".git", "venv", ".venv", "env",
    ".tox", ".mypy_cache", ".pytest_cache", "dist", "build", "out",
    ".next", ".nuxt", "target", ".cargo", "vendor", "AppData", "LocalLow",
    "$Recycle.Bin", "$RECYCLE.BIN", "System Volume Information",
    "Windows", "ProgramData", "PerfLogs", "steamapps", "SteamLibrary",
    "Steam", "Riot Games", "Epic Games", "Ubisoft Game Launcher", "Ubisoft",
    "GOG Galaxy", "Origin Games", "EA Desktop", "Battle.net", "Saved Games",
    "Package Cache", "PackageCache", "$SysReset", "Config.Msi", "Recovery",
    ".gemini", ".antigravity", ".antigravity-ide", ".gradle", ".cache",
    ".rustup", ".dotnet", ".nuget", ".vscode\\extensions", "site-packages",
    "Library", "Temp", "bin", "obj", ".vs", ".idea", ".turbo",
    "models", "snapshots", "checkpoints", "weights", "whisper", "huggingface", "transformers",
})

# Extension blacklist for pure binary / cache / internal noise
SKIP_EXTENSIONS = frozenset({
    ".tmp", ".bak", ".log", ".cab", ".msi", ".dll", ".sys", ".cat",
    ".dat", ".pak", ".rpak", ".vpk", ".asset", ".assets", ".bundle",
    ".unityweb", ".obb", ".cache", ".idx", ".bin", ".meta",
})


def normalize_text(text: str) -> str:
    """Normalize text by replacing special quotes, apostrophes, and punctuation with spaces."""
    if not text:
        return ""
    t = text.lower()
    t = t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("`", "'")
    t = re.sub(r"['']s\b", "s", t)  # gamer's -> gamers
    t = t.replace("'", "")
    t = re.sub(r"[-_./\\:;,()\[\]{}|#+*~]", " ", t)
    t = re.sub(r"[^\w\s]", " ", t)
    return " ".join(t.split())


def extract_tokens(text: str) -> list[str]:
    """Extract individual search tokens from normalized text."""
    norm = normalize_text(text)
    tokens = [w for w in norm.split() if w]
    return tokens


def get_available_drives() -> list[str]:
    """Detect all fixed & available drive roots on Windows (e.g. C:\\, D:\\)."""
    drives = []
    if sys.platform == "win32":
        try:
            import ctypes
            bitmask = ctypes.windll.kernel32.GetLogicalDrives()
            for letter in string.ascii_uppercase:
                if bitmask & 1:
                    drive_path = f"{letter}:\\"
                    if os.path.exists(drive_path):
                        drives.append(drive_path)
                bitmask >>= 1
        except Exception:
            for letter in ["C", "D", "E", "F"]:
                p = f"{letter}:\\"
                if os.path.exists(p):
                    drives.append(p)
    return drives


def _get_default_system_folders() -> list[str]:
    """Retrieve standard user library folders and non-system drive top folders."""
    folders = []
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        # High-priority user library folders
        for name in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "Projects", "Code", "Workspace", "repos"):
            p = os.path.join(user_profile, name)
            if os.path.exists(p) and p not in folders:
                folders.append(p)

    # For secondary drives (D:\, E:\, etc.), scan their top-level user directories
    for d in get_available_drives():
        if d.upper() != "C:\\":
            try:
                for entry in os.scandir(d):
                    if entry.is_dir() and entry.name not in SKIP_DIRS and not entry.name.startswith("."):
                        folders.append(entry.path)
            except Exception:
                folders.append(d)

    return folders


def _scan_folder(folder: str, names: list[str], paths: list[str], max_depth: int = 8) -> None:
    """Zero-stat folder walk appending into shared name/path lists.

    Results are appended in place rather than returned as tuples, so the walk
    never builds a second full copy of the listing.
    """
    if not os.path.isdir(folder):
        return

    folder_str = os.path.normpath(folder)
    is_drive_root = (len(folder_str) <= 3 and folder_str.endswith(":\\"))
    effective_max_depth = 4 if is_drive_root else max_depth
    root_depth = folder_str.count(os.sep)
    remaining = MAX_CACHE_ENTRIES - len(paths)
    if remaining <= 0:
        return

    try:
        for root, dirs, filenames in os.walk(folder_str, topdown=True, onerror=None):
            current_depth = root.count(os.sep) - root_depth
            if current_depth >= effective_max_depth:
                dirs.clear()
                continue

            dirs[:] = [
                d for d in dirs
                if d not in SKIP_DIRS
                and not d.startswith(".")
                and not d.startswith("$")
                and not (root.endswith(":\\") and d in ("Windows", "$Recycle.Bin", "System Volume Information", "PerfLogs", "ProgramData"))
            ]

            for fname in filenames:
                if os.path.splitext(fname)[1].lower() in SKIP_EXTENSIONS:
                    continue
                names.append(normalize_text(fname))
                paths.append(os.path.join(root, fname))
                remaining -= 1
                if remaining <= 0:
                    logger.warning("File cache cap of %d entries reached", MAX_CACHE_ENTRIES)
                    dirs.clear()
                    return
    except Exception as e:
        logger.warning("Error scanning %s: %s", folder, e)


_first_scan_event = threading.Event()


def _publish_index(names: list[str], paths: list[str], folders: list[str]) -> None:
    global _file_index, _cache_folders, _cache_time
    index = FileIndex(names, paths)
    with _cache_lock:
        _file_index = index
        _cache_folders = list(folders)
        _cache_time = time.time()
    _first_scan_event.set()


def _background_scan_worker(folders: list[str]) -> None:
    """Run prioritized scan in a background daemon thread and update cache incrementally."""
    global _refresh_thread
    try:
        names: list[str] = []
        paths: list[str] = []

        user_folders = []
        drive_roots = []
        for f in folders:
            if len(f) <= 3 and f.endswith(":\\"):
                drive_roots.append(f)
            else:
                user_folders.append(f)

        # Fast scan of user folders, published immediately per folder so search works in <50ms.
        for uf in user_folders:
            _scan_folder(uf, names, paths, max_depth=8)
            _publish_index(names, paths, folders)

        # Then the shallower sweep of drive roots.
        if drive_roots:
            for d in drive_roots:
                _scan_folder(d, names, paths, max_depth=4)
                _publish_index(names, paths, folders)

        logger.info(
            "File cache populated with %d files (%.1f MB blob)",
            len(paths), (len(_file_index.blob) * 2) / 1e6,
        )

    except Exception as e:
        logger.error("Background file cache refresh failed: %s", e)
    finally:
        _refresh_thread = None


def refresh_file_cache(folders: list[str] | None = None, force: bool = False) -> None:
    """Ensure file cache is populated asynchronously; never blocks searches."""
    global _refresh_thread
    target_folders = list(folders) if folders else []
    if not target_folders:
        target_folders = _get_default_system_folders()

    now = time.time()
    with _cache_lock:
        cache_valid = (
            len(_file_index) > 0
            and _cache_folders == target_folders
            and (now - _cache_time) < _CACHE_TTL
        )

    if not force and cache_valid:
        return

    if _refresh_thread is None or not _refresh_thread.is_alive():
        _refresh_thread = threading.Thread(
            target=_background_scan_worker,
            args=(target_folders,),
            daemon=True,
        )
        _refresh_thread.start()


def _calculate_recency_boost(file_modified: float) -> float:
    """Calculate ranking boost based on last modified time."""
    if not file_modified:
        return 0.0
    age_days = (time.time() - file_modified) / 86400.0
    if age_days <= 1:
        return 0.05
    if age_days <= 7:
        return 0.03
    if age_days <= 30:
        return 0.01
    return 0.0


def _get_file_stat_lazy(fpath: str) -> tuple[int, float]:
    """Fetch file size and modified timestamp on demand for top matched results."""
    try:
        st = os.stat(fpath)
        return st.st_size, st.st_mtime
    except OSError:
        return 0, 0.0


def fuzzy_file_search(
    query: str,
    folders: list[str] | None = None,
    limit: int = 15,
    supported_extensions: set[str] | None = None,
) -> list[dict]:
    """High-speed hybrid multi-tier file search across all disks and Windows Search."""
    q = query.strip()
    if not q:
        return []

    # Non-blocking cache warm-up
    refresh_file_cache(folders)

    q_norm = normalize_text(q)
    q_tokens = [w for w in q_norm.split() if w]
    if not q_tokens:
        return []

    scored_items: dict[str, tuple[dict, float]] = {}

    # 1. In-memory index FIRST: locate candidates with a C-level blob scan (0.5 - 2 ms)
    with _cache_lock:
        index = _file_index

    if len(index) == 0:
        _first_scan_event.wait(timeout=0.25)
        with _cache_lock:
            index = _file_index

    if len(index):
        # Probe with the longest tokens first (most selective)
        probes = sorted(set(q_tokens), key=len, reverse=True)[:3]
        candidate_ids: set[int] = set()
        for probe in probes:
            candidate_ids.update(index.candidates(probe, MAX_CANDIDATES))
            if len(candidate_ids) >= MAX_CANDIDATES:
                break

        for i in candidate_ids:
            fpath = index.paths[i]
            ext = os.path.splitext(fpath)[1].lower()
            if supported_extensions and ext not in supported_extensions:
                continue

            fname_norm = index.name_at(i)
            score = 0.0
            if q_norm == fname_norm:
                score = 1.0
            elif q_norm in fname_norm:
                score = 0.98
            elif fname_norm.startswith(q_norm):
                score = 0.96
            else:
                matched = sum(1 for tok in q_tokens if tok in fname_norm)
                ratio = matched / len(q_tokens)
                if ratio >= 1.0:
                    score = 0.94
                elif ratio >= 0.5:
                    score = 0.65 + (ratio * 0.25)
                else:
                    continue

            if score >= 0.45:
                fpath_key = fpath.lower()
                if fpath_key in scored_items and scored_items[fpath_key][1] >= score:
                    continue
                item = {
                    "fileName": os.path.basename(fpath),
                    "filePath": fpath,
                    "snippet": fpath,
                    "score": round(score, 3),
                    "fileExt": ext,
                    "fileSize": 0,
                    "fileModified": 0.0,
                    "category": "file",
                    "action": "open_file",
                    "actionTitle": "Open File",
                }
                scored_items[fpath_key] = (item, score)

    # 2. Only query Windows Search if in-memory index found very few results (< 5)
    best_mem_score = max((score for _, score in scored_items.values()), default=0.0)
    if len(scored_items) < 5 or best_mem_score < 0.80:
        try:
            win_results = query_windows_search(q, limit=limit)
            for item in win_results:
                fpath = item["filePath"]
                fpath_key = fpath.lower()
                if fpath_key in scored_items:
                    continue
                fname = item["fileName"]
                fname_norm = normalize_text(fname)

                score = 0.0
                if q_norm == fname_norm:
                    score = 1.0
                elif q_norm in fname_norm:
                    score = 0.98
                elif fname_norm.startswith(q_norm):
                    score = 0.96
                else:
                    matched = sum(1 for tok in q_tokens if tok in fname_norm)
                    ratio = matched / len(q_tokens)
                    if ratio >= 1.0:
                        score = 0.95
                    elif ratio >= 0.5:
                        score = 0.70 + (ratio * 0.20)
                    else:
                        score = 0.45 * ratio

                score += _calculate_recency_boost(item.get("fileModified", 0.0))
                score = min(1.0, score)

                result_entry = {
                    "fileName": fname,
                    "filePath": fpath,
                    "snippet": fpath,
                    "score": round(score, 3),
                    "fileExt": item.get("fileExt", os.path.splitext(fname)[1].lower()),
                    "fileSize": item.get("fileSize", 0),
                    "fileModified": item.get("fileModified", 0.0),
                    "category": "file",
                    "action": "open_file",
                    "actionTitle": "Open File",
                }
                scored_items[fpath_key] = (result_entry, score)
        except Exception as e:
            logger.debug("Windows search fallback error: %s", e)

    results_list = [item for item, _ in scored_items.values()]
    results_list.sort(key=lambda x: x["score"], reverse=True)
    top_results = results_list[:limit]

    # Fill metadata lazily only for the top results to keep latency sub-10ms
    for r in top_results:
        if not r.get("fileSize") and not r.get("fileModified"):
            fsize, fmod = _get_file_stat_lazy(r["filePath"])
            r["fileSize"] = fsize
            r["fileModified"] = fmod

    return top_results
