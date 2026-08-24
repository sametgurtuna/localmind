"""Engine settings persisted outside the UI's localStorage.

The indexing pipeline needs these before any window exists (the sidecar starts
first), so they live in a small JSON file next to the database. Environment
variables still win, which keeps the documented LOCALMIND_* knobs working.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

SETTINGS_PATH = os.path.join(str(Path.home()), ".localmind", "engine.json")

DEFAULTS: dict = {
    # OCR costs ~500MB of models and seconds per image; off unless asked for.
    "ocr": False,
    # int8 dynamic quantization: about 2x faster indexing, slightly different
    # embeddings. Switching it invalidates the index.
    "quantize": False,
}

_lock = threading.Lock()
_cache: dict | None = None


def _env_override(key: str, value):
    env_name = {"ocr": "LOCALMIND_OCR", "quantize": "LOCALMIND_QUANTIZE"}.get(key)
    if not env_name:
        return value
    raw = os.environ.get(env_name)
    if raw is None:
        return value
    return raw.lower() in ("1", "true", "yes")


def load() -> dict:
    global _cache
    with _lock:
        if _cache is None:
            data = dict(DEFAULTS)
            try:
                with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                    stored = json.load(f)
                for k in DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
            except FileNotFoundError:
                pass
            except Exception as e:
                logger.warning("Could not read %s: %s", SETTINGS_PATH, e)
            _cache = {k: _env_override(k, v) for k, v in data.items()}
        return dict(_cache)


def get(key: str):
    return load().get(key, DEFAULTS.get(key))


def update(changes: dict) -> dict:
    """Persist the given keys and return the full settings."""
    global _cache
    with _lock:
        current = dict(_cache) if _cache is not None else None
    if current is None:
        current = load()

    applied = dict(current)
    for k, v in changes.items():
        if k in DEFAULTS:
            applied[k] = bool(v)

    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(applied, f, indent=2)
    os.replace(tmp, SETTINGS_PATH)

    with _lock:
        _cache = applied
    logger.info("Engine settings updated: %s", applied)
    return dict(applied)
