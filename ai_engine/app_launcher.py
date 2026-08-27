"""Windows application & tool launcher - comprehensive discovery & fast fuzzy search."""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from rapidfuzz import fuzz

logger = logging.getLogger(__name__)

_app_cache: list[dict] = []
_cache_time: float = 0
_CACHE_TTL = 900  # 15 minutes (installed apps rarely change)

# Built-in Windows tools and UWP apps with rich aliases
_BUILTIN_TOOLS = [
    {
        "name": "Calculator",
        "aliases": ["calc", "hesap", "hesap makinesi", "math"],
        "target": "calc.exe",
        "type": "executable",
        "description": "Windows Calculator",
    },
    {
        "name": "Windows Terminal",
        "aliases": ["wt", "term", "terminal", "console", "bash"],
        "target": "wt.exe",
        "type": "executable",
        "description": "Windows Terminal",
    },
    {
        "name": "Command Prompt",
        "aliases": ["cmd", "command", "prompt", "terminal", "cli"],
        "target": "cmd.exe",
        "type": "executable",
        "description": "Command Prompt",
    },
    {
        "name": "PowerShell",
        "aliases": ["ps", "pwsh", "powershell", "posh"],
        "target": "powershell.exe",
        "type": "executable",
        "description": "Windows PowerShell",
    },
    {
        "name": "Task Manager",
        "aliases": ["taskmgr", "task", "tm", "görev yöneticisi", "processes"],
        "target": "taskmgr.exe",
        "type": "executable",
        "description": "Task Manager",
    },
    {
        "name": "Notepad",
        "aliases": ["not", "notepad", "note", "metin belgesi", "text"],
        "target": "notepad.exe",
        "type": "executable",
        "description": "Windows Notepad",
    },
    {
        "name": "Snipping Tool",
        "aliases": ["snip", "snippingtool", "ekran alıntısı", "screenshot", "capture"],
        "target": "snippingtool.exe",
        "type": "executable",
        "description": "Snipping Tool & Screen Sketch",
    },
    {
        "name": "Settings",
        "aliases": ["ms-settings", "settings", "ayarlar", "config", "preferences"],
        "target": "ms-settings:",
        "type": "uwp",
        "description": "Windows Settings",
    },
    {
        "name": "File Explorer",
        "aliases": ["explorer", "dosya gezgini", "files", "folder"],
        "target": "explorer.exe",
        "type": "executable",
        "description": "File Explorer",
    },
    {
        "name": "Control Panel",
        "aliases": ["control", "denetim masası", "cpl"],
        "target": "control.exe",
        "type": "executable",
        "description": "Control Panel",
    },
    {
        "name": "Registry Editor",
        "aliases": ["regedit", "registry", "kayıt defteri"],
        "target": "regedit.exe",
        "type": "executable",
        "description": "Registry Editor",
    },
    {
        "name": "Paint",
        "aliases": ["mspaint", "paint", "çizim"],
        "target": "mspaint.exe",
        "type": "executable",
        "description": "Paint",
    },
    {
        "name": "Remote Desktop Connection",
        "aliases": ["mstsc", "rdp", "remote desktop", "uzak masaüstü"],
        "target": "mstsc.exe",
        "type": "executable",
        "description": "Remote Desktop Connection",
    },
    {
        "name": "Device Manager",
        "aliases": ["devmgmt", "device", "aygıt yöneticisi"],
        "target": "devmgmt.msc",
        "type": "executable",
        "description": "Device Manager",
    },
    {
        "name": "Services",
        "aliases": ["services", "hizmetler"],
        "target": "services.msc",
        "type": "executable",
        "description": "Windows Services Management",
    },
    {
        "name": "Disk Cleanup",
        "aliases": ["cleanmgr", "disk cleanup", "disk temizleme"],
        "target": "cleanmgr.exe",
        "type": "executable",
        "description": "Disk Cleanup Utility",
    },
]


def _get_start_menu_dirs() -> list[str]:
    dirs = []
    program_data = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
    app_data = os.environ.get("APPDATA", "")
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    public_dir = os.environ.get("PUBLIC", r"C:\Users\Public")
    user_profile = os.environ.get("USERPROFILE", "")

    # Common & User Start Menus
    dirs.append(os.path.join(program_data, "Microsoft", "Windows", "Start Menu", "Programs"))
    if app_data:
        dirs.append(os.path.join(app_data, "Microsoft", "Windows", "Start Menu", "Programs"))

    # Common & User Desktops
    dirs.append(os.path.join(public_dir, "Desktop"))
    if user_profile:
        dirs.append(os.path.join(user_profile, "Desktop"))

    # LocalAppData Programs (VS Code, Chrome, etc.)
    if local_app_data:
        dirs.append(os.path.join(local_app_data, "Programs"))

    return [d for d in dirs if os.path.exists(d)]


def _resolve_lnk(lnk_path: str) -> str | None:
    """Try to resolve a .lnk shortcut to its target path."""
    try:
        import struct
        with open(lnk_path, "rb") as f:
            content = f.read()

        if len(content) < 76 or content[0:4] != b"\x4c\x00\x00\x00":
            return None

        flags = struct.unpack("<I", content[20:24])[0]
        has_link_target = flags & 0x01
        has_link_info = flags & 0x02

        pos = 76
        if has_link_target:
            if pos + 2 > len(content):
                return None
            id_list_size = struct.unpack("<H", content[pos:pos + 2])[0]
            pos += 2 + id_list_size

        if has_link_info:
            if pos + 4 > len(content):
                return None
            link_info_header_size = struct.unpack("<I", content[pos + 4:pos + 8])[0]
            if link_info_header_size >= 28:
                local_base_path_offset = struct.unpack("<I", content[pos + 16:pos + 20])[0]
                if local_base_path_offset > 0:
                    path_start = pos + local_base_path_offset
                    path_end = content.find(b"\x00", path_start)
                    if path_end != -1:
                        target = content[path_start:path_end].decode("ascii", errors="ignore")
                        if target and os.path.exists(target):
                            return target
        return None
    except Exception:
        return None


def _get_acronym(text: str) -> str:
    """Extract acronym from words (e.g. 'Visual Studio Code' -> 'vsc')."""
    words = [w for w in text.split() if w]
    if len(words) > 1:
        return "".join(w[0].lower() for w in words)
    return ""


def _scan_installed_apps() -> list[dict]:
    apps: list[dict] = []
    seen_names = set()

    # 1. Add built-in tools first
    for tool in _BUILTIN_TOOLS:
        name_lower = tool["name"].lower()
        acronym = _get_acronym(tool["name"])
        apps.append({
            "name": tool["name"],
            "path": tool["target"],
            "target": tool["target"],
            "aliases": tool.get("aliases", []),
            "acronym": acronym,
            "description": tool.get("description", "Application"),
            "category": "app",
        })
        seen_names.add(name_lower)

    # 2. Scan Start Menu and Shortcuts
    for start_dir in _get_start_menu_dirs():
        for root, _dirs, files in os.walk(start_dir):
            for fname in files:
                fname_lower = fname.lower()
                if not (fname_lower.endswith(".lnk") or fname_lower.endswith(".exe") or fname_lower.endswith(".url")):
                    continue

                name = os.path.splitext(fname)[0]
                name_clean = name.strip()
                name_key = name_clean.lower()

                if name_key in seen_names:
                    continue
                if name_key.startswith("uninstall") or name_key.startswith("kaldır") or "help" in name_key:
                    continue

                fpath = os.path.join(root, fname)
                target = _resolve_lnk(fpath) if fname_lower.endswith(".lnk") else fpath

                acronym = _get_acronym(name_clean)
                aliases = []
                if "visual studio code" in name_key:
                    aliases.extend(["vsc", "code", "vs code"])
                elif "chrome" in name_key:
                    aliases.extend(["browser", "google chrome"])
                elif "spotify" in name_key:
                    aliases.extend(["music", "muzik"])
                elif "discord" in name_key:
                    aliases.extend(["dc", "chat"])
                elif "postman" in name_key:
                    aliases.extend(["api", "http"])
                elif "steam" in name_key:
                    aliases.extend(["games", "oyun"])

                apps.append({
                    "name": name_clean,
                    "path": fpath,
                    "target": target or fpath,
                    "aliases": aliases,
                    "acronym": acronym,
                    "description": target or fpath,
                    "category": "app",
                })
                seen_names.add(name_key)

    apps.sort(key=lambda a: a["name"].lower())
    return apps


_scanning_lock = threading.Lock()
_is_scanning = False


def _refresh_cache():
    global _app_cache, _cache_time, _is_scanning
    now = time.time()
    if _app_cache and (now - _cache_time) < _CACHE_TTL:
        return
    with _scanning_lock:
        if _is_scanning:
            return
        _is_scanning = True
    try:
        scanned = _scan_installed_apps()
        _app_cache = scanned
        _cache_time = now
        logger.info("Scanned %d applications", len(_app_cache))
    finally:
        with _scanning_lock:
            _is_scanning = False


# Initial pre-warm in background daemon thread
threading.Thread(target=_refresh_cache, daemon=True, name="AppCachePrewarm").start()


def search_apps(query: str, limit: int = 10) -> list[dict]:
    """Smart fuzzy & alias search for installed applications."""
    q = query.strip()
    if not q:
        return []

    _refresh_cache()

    q_lower = q.lower()
    scored = []

    for app in _app_cache:
        name_lower = app["name"].lower()
        acronym = app.get("acronym", "")
        aliases = app.get("aliases", [])

        score = 0.0

        # 1. Exact name match
        if q_lower == name_lower:
            score = 1.0
        # 2. Exact alias or acronym match (e.g. 'calc' -> Calculator, 'vsc' -> VS Code)
        elif q_lower in aliases or (acronym and q_lower == acronym):
            score = 0.98
        # 3. Prefix match on name (e.g. 'cal' -> Calculator)
        elif name_lower.startswith(q_lower):
            score = 0.95
        # 4. Word boundary match (e.g. 'code' in 'Visual Studio Code')
        elif any(w.startswith(q_lower) for w in name_lower.split()):
            score = 0.90
        # 5. Alias starts with query
        elif any(a.startswith(q_lower) for a in aliases):
            score = 0.88
        # 6. Substring in name
        elif q_lower in name_lower:
            score = 0.82
        # 7. Fuzzy matching
        else:
            fuzzy_ratio = fuzz.ratio(q_lower, name_lower)
            partial_ratio = fuzz.partial_ratio(q_lower, name_lower)
            best_fuzzy = max(fuzzy_ratio, partial_ratio * 0.85)
            if best_fuzzy >= 55:
                score = (best_fuzzy / 100.0) * 0.78

        if score >= 0.45:
            scored.append((app, score))

    scored.sort(key=lambda x: x[1], reverse=True)

    results = []
    for app, score in scored[:limit]:
        results.append({
            "fileName": app["name"],
            "filePath": app["target"],
            "snippet": app.get("description", app["target"]),
            "score": round(score, 3),
            "category": "app",
            "action": "launch_app",
            "actionTitle": "Launch App",
        })

    return results
