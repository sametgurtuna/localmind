from __future__ import annotations

import logging
import time
import threading
from pathlib import Path
from typing import Callable, Optional

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent

from extractor import SUPPORTED_EXTENSIONS

logger = logging.getLogger(__name__)


class FileChangeHandler(FileSystemEventHandler):
    """Collects file change events and triggers re-indexing."""

    def __init__(self, callback: Callable[[str, str], None]):
        super().__init__()
        self._callback = callback
        self._debounce: dict[str, float] = {}
        self._lock = threading.Lock()

    def _should_process(self, path: str) -> bool:
        ext = Path(path).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            return False
        parts = Path(path).parts
        if any(p.startswith(".") or p in ("node_modules", "__pycache__", ".git", "venv", ".venv") for p in parts):
            return False
        return True

    def _debounced_callback(self, path: str, event_type: str):
        with self._lock:
            now = time.time()
            last = self._debounce.get(path, 0)
            if now - last < 2.0:
                return
            self._debounce[path] = now
        self._callback(path, event_type)

    def on_created(self, event: FileSystemEvent):
        if not event.is_directory and self._should_process(event.src_path):
            self._debounced_callback(event.src_path, "created")

    def on_modified(self, event: FileSystemEvent):
        if not event.is_directory and self._should_process(event.src_path):
            self._debounced_callback(event.src_path, "modified")

    def on_deleted(self, event: FileSystemEvent):
        if not event.is_directory and self._should_process(event.src_path):
            self._debounced_callback(event.src_path, "deleted")


class FileWatcher:
    def __init__(self, callback: Callable[[str, str], None]):
        self._observer: Optional[Observer] = None
        self._callback = callback
        self._handler = FileChangeHandler(callback)

    def start(self, folders: list[str]):
        self.stop()
        self._observer = Observer()
        for folder in folders:
            if Path(folder).exists():
                self._observer.schedule(self._handler, folder, recursive=True)
                logger.info("Watching folder: %s", folder)
        self._observer.start()

    def stop(self):
        if self._observer:
            self._observer.stop()
            self._observer.join(timeout=5)
            self._observer = None
