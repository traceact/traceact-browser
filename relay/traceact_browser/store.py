"""Append-only JSONL store for browser trace records."""

import json
import threading
from pathlib import Path
from typing import Any, Dict, List


class TraceStore:
    """Appends trace records to one JSONL file, one record per line.

    Writes are batched: a whole ingest payload becomes a single write call,
    so concurrent tabs can't interleave partial lines and the disk sees one
    operation per batch rather than one per record.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

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
        return len(records)
