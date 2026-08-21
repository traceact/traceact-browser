"""Append-only JSONL store for browser trace records."""

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_MAX_BYTES = 20 * 1024 * 1024  # 20 MB per generation (tens of thousands of records)


def _restrict(path: Path, mode: int) -> None:
    """Best-effort chmod. POSIX only; a no-op where chmod isn't meaningful."""
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def _create_owner_only(path: Path) -> None:
    """Create the file if absent, owner-only, then enforce 0600 either way."""
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
        os.close(fd)
    _restrict(path, 0o600)


class TraceStore:
    """Appends trace records to one JSONL file, one record per line.

    Writes are batched: a whole ingest payload becomes a single write call,
    so concurrent tabs can't interleave partial lines and the disk sees one
    operation per batch rather than one per record.

    The file holds captured browser data — redacted, but never guaranteed
    clean — so it's created owner-only (0600) inside an owner-only directory
    (0700), and an already-loose file from an older release is tightened on
    startup. This keeps other local accounts from reading it.
    """

    def __init__(self, path: Path, max_bytes: int = DEFAULT_MAX_BYTES) -> None:
        self.path = path
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _restrict(self.path.parent, 0o700)
        _create_owner_only(self.path)

    def append(self, records: List[Dict[str, Any]]) -> int:
        """Append records as JSONL lines. Returns the number written."""
        if not records:
            return 0
        payload = "".join(
            json.dumps(rec, separators=(",", ":"), ensure_ascii=False) + "\n"
            for rec in records
        ).encode("utf-8")
        with self._lock:
            with open(self.path, "ab") as fh:
                fh.write(payload)
                fh.flush()
            self._rotate_if_needed()
        return len(records)

    def clear(self) -> int:
        """Delete the trace file and its rotated generation, then recreate an
        empty owner-only current file. Returns how many files were removed."""
        removed = 0
        with self._lock:
            for target in (self.path, self.path.with_name(self.path.name + ".1")):
                try:
                    target.unlink()
                    removed += 1
                except FileNotFoundError:
                    pass
            _create_owner_only(self.path)
        return removed

    def _rotate_if_needed(self) -> None:
        """Bound growth: once the file passes the cap, move it aside to a
        single `.1` generation and start a fresh owner-only file. One
        generation is kept, so total on disk stays under ~2x the cap and
        captured data can't accumulate without limit. Call under the lock.
        """
        if self.max_bytes <= 0:
            return
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if size < self.max_bytes:
            return
        prev = self.path.with_name(self.path.name + ".1")
        os.replace(self.path, prev)  # atomic; overwrites any older .1
        _restrict(prev, 0o600)
        _create_owner_only(self.path)
