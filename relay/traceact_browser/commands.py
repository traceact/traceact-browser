"""Command channel between the relay and connected extension instances.

The extension long-polls `GET /pull`; the relay enqueues commands (focus a
tab, snapshot a DOM) and waits for the matching `POST /result`. One relay
serves any number of browser instances (Chrome and Brave side by side);
each identifies itself with a client id and a human label.
"""

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional

CLIENT_STALE_S = 90.0


@dataclass
class Client:
    """One connected extension instance (one browser profile)."""

    client_id: str
    label: str
    last_seen: float = field(default_factory=time.monotonic)
    queue: Deque[Dict[str, Any]] = field(default_factory=deque)


class CommandHub:
    """Per-client command queues plus pending-result bookkeeping."""

    def __init__(self) -> None:
        self._lock = threading.Condition()
        self._clients: Dict[str, Client] = {}
        self._projects: Dict[str, Dict[str, Any]] = {}
        self._results: Dict[str, Any] = {}
        self._result_events: Dict[str, threading.Event] = {}

    def note_records(self, records: List[Dict[str, Any]]) -> None:
        """Learn project → tab targets from ingested records.

        Lets callers address a tab by the one thing an app already knows,
        its own host:port, instead of tab and client ids. Most recent
        record per project wins, so the target follows the user's activity.
        """
        with self._lock:
            for rec in records:
                project = rec.get("project")
                meta = rec.get("meta") or {}
                if (not project or project == "unknown"
                        or not isinstance(meta, dict) or meta.get("tab_id") is None):
                    continue
                self._projects[project] = {
                    "client_id": meta.get("client_id"),
                    "tab_id": meta.get("tab_id"),
                    "window_id": meta.get("window_id"),
                    "seen": time.monotonic(),
                }

    def project_target(self, project: str) -> Optional[Dict[str, Any]]:
        """The most recently seen tab for a project, or None."""
        with self._lock:
            return dict(self._projects[project]) if project in self._projects else None

    def projects(self) -> Dict[str, float]:
        """Known projects and how many seconds ago each was last seen."""
        now = time.monotonic()
        with self._lock:
            return {p: round(now - t["seen"], 1) for p, t in self._projects.items()}

    def touch(self, client_id: str, label: str) -> None:
        """Register or refresh a client from a poll request."""
        with self._lock:
            client = self._clients.get(client_id)
            if client is None:
                self._clients[client_id] = Client(client_id=client_id, label=label)
            else:
                client.last_seen = time.monotonic()
                if label:
                    client.label = label

    def clients(self) -> List[Dict[str, Any]]:
        """Currently connected clients (seen within the staleness window)."""
        now = time.monotonic()
        with self._lock:
            return [
                {"client_id": c.client_id, "label": c.label,
                 "seen_s_ago": round(now - c.last_seen, 1)}
                for c in self._clients.values()
                if now - c.last_seen < CLIENT_STALE_S
            ]

    def resolve_client(self, client_id: Optional[str]) -> Optional[str]:
        """Pick the target client: an explicit id, or the only one connected."""
        live = self.clients()
        if client_id:
            return client_id if any(c["client_id"] == client_id for c in live) else None
        if len(live) == 1:
            return live[0]["client_id"]
        return None

    def enqueue(self, client_id: str, command: Dict[str, Any]) -> str:
        """Queue a command for a client. Returns the command id."""
        cmd_id = "cmd_" + uuid.uuid4().hex[:12]
        command = dict(command, id=cmd_id)
        with self._lock:
            client = self._clients.get(client_id)
            if client is None:
                client = Client(client_id=client_id, label="")
                self._clients[client_id] = client
            client.queue.append(command)
            self._result_events[cmd_id] = threading.Event()
            self._lock.notify_all()
        return cmd_id

    def pull(self, client_id: str, label: str, wait_s: float) -> List[Dict[str, Any]]:
        """Long-poll: return queued commands, waiting up to wait_s for one."""
        deadline = time.monotonic() + max(0.0, min(wait_s, 30.0))
        self.touch(client_id, label)
        with self._lock:
            while True:
                client = self._clients[client_id]
                client.last_seen = time.monotonic()
                if client.queue:
                    commands = list(client.queue)
                    client.queue.clear()
                    return commands
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return []
                self._lock.wait(timeout=min(remaining, 5.0))

    def post_result(self, cmd_id: str, result: Any) -> bool:
        """Record a command's result. Returns False for an unknown id."""
        with self._lock:
            event = self._result_events.get(cmd_id)
            if event is None:
                return False
            self._results[cmd_id] = result
        event.set()
        return True

    def wait_result(self, cmd_id: str, timeout_s: float) -> Optional[Any]:
        """Block until the command's result arrives, or return None on timeout."""
        event = self._result_events.get(cmd_id)
        if event is None:
            return None
        arrived = event.wait(timeout=timeout_s)
        with self._lock:
            self._result_events.pop(cmd_id, None)
            return self._results.pop(cmd_id, None) if arrived else None
