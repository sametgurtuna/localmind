"""Windows application launcher - scans Start Menu for .lnk files."""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_app_cache: list[dict] = []
_cache_time: float = 0
_CACHE_TTL = 300  # refresh every 5 minutes

_START_MENU_DIRS = [
    os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
                 "Microsoft", "Windows", "Start Menu", "Programs"),
    os.path.join(os.environ.get("APPDATA", ""),
                 "Microsoft", "Windows", "Start Menu", "Programs"),
]


def _resolve_lnk(lnk_path: str) -> str | None:
    """Try to resolve a .lnk shortcut to its target path."""
    try:
        import struct
        with open(lnk_path, "rb") as f:
            content = f.read()

        # Windows Shell Link Binary format
        # Header is 76 bytes, check magic
        if len(content) < 76:
            return None
        if content[0:4] != b"\x4c\x00\x00\x00":
            return None

        flags = struct.unpack("<I", content[20:24])[0]
        has_link_target = flags & 0x01
        has_link_info = flags & 0x02

        pos = 76

        # Skip LinkTargetIDList if present
        if has_link_target:
            if pos + 2 > len(content):
                return None
            id_list_size = struct.unpack("<H", content[pos:pos + 2])[0]
            pos += 2 + id_list_size

        # Parse LinkInfo if present
        if has_link_info:
            if pos + 4 > len(content):
                return None
            link_info_size = struct.unpack("<I", content[pos:pos + 4])[0]
            link_info_header_size = struct.unpack("<I", content[pos + 4:pos + 8])[0]

            if link_info_header_size >= 28:
                local_base_path_offset = struct.unpack("<I", content[pos + 16:pos + 20])[0]
                if local_base_path_offset > 0:
                    path_start = pos + local_base_path_offset
                    path_end = content.index(b"\x00", path_start)
                    target = content[path_start:path_end].decode("ascii", errors="ignore")
                    if target and os.path.exists(target):
                        return target

        return None
    except Exception:
        return None


def _scan_apps() -> list[dict]:
    """Scan Start Menu directories for applications."""
    apps = []
    seen_names = set()

    for start_dir in _START_MENU_DIRS:
        if not os.path.exists(start_dir):
            continue

        for root, _dirs, files in os.walk(start_dir):
            for fname in files:
                if not fname.lower().endswith(".lnk"):
                    continue

                name = fname[:-4]  # Remove .lnk
                name_lower = name.lower()

                if name_lower in seen_names:
                    continue
                if name_lower.startswith("uninstall"):
                    continue

                fpath = os.path.join(root, fname)
                target = _resolve_lnk(fpath)

                apps.append({
                    "name": name,
                    "path": fpath,
                    "target": target or fpath,
                })
                seen_names.add(name_lower)

    apps.sort(key=lambda a: a["name"].lower())
    return apps


def _refresh_cache():
    global _app_cache, _cache_time
    now = time.time()
    if _app_cache and (now - _cache_time) < _CACHE_TTL:
        return
    _app_cache = _scan_apps()
    _cache_time = now
    logger.info("App cache refreshed: %d apps", len(_app_cache))


def search_apps(query: str, limit: int = 10) -> list[dict]:
    """Fuzzy search for installed applications."""
    if not query.strip():
        return []

    _refresh_cache()

    from rapidfuzz import fuzz

    query_lower = query.lower()
    scored = []

    for app in _app_cache:
        name_lower = app["name"].lower()
        if query_lower in name_lower:
            score = 95
        else:
            score = fuzz.partial_ratio(query_lower, name_lower)

        if score >= 40:
            scored.append({
                "fileName": app["name"],
                "filePath": app["target"],
                "snippet": app["path"],
                "score": score / 100.0,
            })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]
