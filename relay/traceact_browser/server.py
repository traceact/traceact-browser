"""The relay's HTTP server. Localhost only, stdlib only.

Routes:
    GET  /            status page (what this is, where data goes, who's connected)
    GET  /health      JSON status for tools and the launcher
    POST /ingest      record batches from the extension
    GET  /pull        long-poll command channel for the extension
    POST /result      command results from the extension
    POST /focus       focus-hook target for `traceact view --focus-hook`
    GET  /snapshot    DOM snapshot of a tracked tab, optionally selector-scoped
    GET  /demo        bundled demo page that traces itself
"""

import json
import socket
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from traceact_browser.commands import CommandHub
from traceact_browser.store import TraceStore

DEFAULT_PORT = 8631
PORT_ATTEMPTS = 20
MAX_BODY_BYTES = 8_000_000
FOCUS_TIMEOUT_S = 3.0
SNAPSHOT_TIMEOUT_S = 10.0
APP_NAME = "traceact-browser"
_PARSE_FAILED = object()


def _version() -> str:
    from traceact_browser import __version__
    return __version__


def find_running_relay(start_port: int = DEFAULT_PORT,
                       attempts: int = PORT_ATTEMPTS) -> Optional[Tuple[int, Dict[str, Any]]]:
    """Probe the port range for a relay that's already running.

    Returns (port, health payload) when one answers as this app, else None.
    """
    for port in range(start_port, start_port + attempts):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            if payload.get("app") == APP_NAME:
                return port, payload
        except Exception:
            continue
    return None


class RelayServer:
    """Owns the HTTP server, the trace store, and the command hub."""

    def __init__(self, data_file: Path, port: int = DEFAULT_PORT) -> None:
        self.store = TraceStore(data_file)
        self.hub = CommandHub()
        self.requested_port = port
        self.port: int = 0
        self._httpd: Optional[ThreadingHTTPServer] = None

    def bind(self) -> int:
        """Bind the first free port in the range. Returns the bound port.

        A port held by a different process is skipped rather than fought
        over; a relay already running is the caller's job to detect first
        with find_running_relay().
        """
        last_error: Optional[Exception] = None
        for candidate in range(self.requested_port, self.requested_port + PORT_ATTEMPTS):
            try:
                self._httpd = ThreadingHTTPServer(("127.0.0.1", candidate), _make_handler(self))
                self.port = candidate
                return candidate
            except OSError as exc:
                last_error = exc
        raise OSError(
            f"no free port in {self.requested_port}-{self.requested_port + PORT_ATTEMPTS - 1}"
        ) from last_error

    def serve_forever(self) -> None:
        if self._httpd is None:
            self.bind()
        assert self._httpd is not None
        self._httpd.serve_forever()

    def serve_in_thread(self) -> threading.Thread:
        """Start serving on a daemon thread (used by tests)."""
        if self._httpd is None:
            self.bind()
        thread = threading.Thread(target=self.serve_forever, daemon=True)
        thread.start()
        return thread

    def shutdown(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()


def _make_handler(relay: RelayServer) -> type:
    """Build the request handler class bound to one RelayServer."""

    class Handler(BaseHTTPRequestHandler):
        server_version = f"{APP_NAME}/{_version()}"
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            pass  # per-request logging would flood the terminal the demo page writes to

        # ---- helpers ----

        def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_html(self, status: int, html: str) -> None:
            body = html.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self) -> Optional[bytes]:
            """Read the request body, enforcing the size cap. None on refusal."""
            length_header = self.headers.get("Content-Length")
            if length_header is None:
                self._send_json(411, {"error": "Content-Length required"})
                return None
            try:
                length = int(length_header)
            except ValueError:
                self._send_json(400, {"error": "invalid Content-Length"})
                return None
            if length < 0 or length > MAX_BODY_BYTES:
                self._send_json(413, {"error": f"body over {MAX_BODY_BYTES} bytes"})
                return None
            return self.rfile.read(length)

        def _extension_origin_ok(self) -> bool:
            """Only browser extensions (or origin-less local tools) may post.

            A web page's fetch to localhost carries an http(s) Origin; that
            gets refused so an arbitrary site can't write into the trace file
            or read commands.
            """
            origin = self.headers.get("Origin")
            if origin is None:
                return True
            return origin.startswith("chrome-extension://") or origin.startswith("moz-extension://")

        def _parse_json_body(self, raw: bytes) -> Any:
            """Parse the body, or answer 400 and return the failure sentinel.

            A sentinel rather than None, because `null` is valid JSON that
            parses to None and still deserves a shape-check response.
            """
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": "body isn't valid JSON"})
                return _PARSE_FAILED

        # ---- routes ----

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            route = parsed.path.rstrip("/") or "/"
            if route == "/":
                self._get_index()
            elif route == "/health":
                self._get_health()
            elif route == "/pull":
                self._get_pull(parse_qs(parsed.query))
            elif route == "/snapshot":
                self._get_snapshot(parse_qs(parsed.query))
            elif route == "/demo":
                self._get_demo()
            elif route == "/demo/api/ok":
                self._send_json(200, {"ok": True, "message": "the demo API answered"})
            elif route == "/demo/api/missing":
                self._send_json(404, {"error": "the demo API has nothing here, on purpose"})
            else:
                self._send_json(404, {"error": "unknown route"})

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            route = parsed.path.rstrip("/")
            if route == "/ingest":
                self._post_ingest()
            elif route == "/result":
                self._post_result()
            elif route == "/focus":
                self._post_focus()
            else:
                self._send_json(404, {"error": "unknown route"})

        def _get_index(self) -> None:
            clients = relay.hub.clients()
            rows = "".join(
                f"<li><code>{c['label'] or c['client_id']}</code> "
                f"(seen {c['seen_s_ago']}s ago)</li>"
                for c in clients
            ) or "<li>none yet — load the extension and allow a site</li>"
            self._send_html(200, f"""<!doctype html><meta charset="utf-8">
<title>traceact-browser relay</title>
<body style="font-family: system-ui; max-width: 42rem; margin: 3rem auto; line-height: 1.5">
<h1>traceact-browser relay</h1>
<p>This is the local relay for the traceact-browser extension. It receives
browser traces and appends them to one file on this machine. Nothing is
sent anywhere else.</p>
<p><b>Trace file:</b> <code>{relay.store.path}</code></p>
<p><b>Connected browsers:</b></p><ul>{rows}</ul>
<p><b>Try it:</b> open the <a href="/demo">demo page</a> — it logs, fetches,
and errors on purpose so you can watch traces arrive.</p>
<p>View traces: <code>traceact view {relay.store.path} --map</code></p>
</body>""")

        def _get_health(self) -> None:
            self._send_json(200, {
                "app": APP_NAME,
                "version": _version(),
                "port": relay.port,
                "data_file": str(relay.store.path),
                "clients": relay.hub.clients(),
                "projects": relay.hub.projects(),
            })

        def _get_pull(self, query: Dict[str, List[str]]) -> None:
            if not self._extension_origin_ok():
                self._send_json(403, {"error": "extension origins only"})
                return
            client_id = (query.get("client") or [""])[0]
            if not client_id:
                self._send_json(400, {"error": "client parameter required"})
                return
            label = (query.get("label") or [""])[0]
            try:
                wait_s = float((query.get("wait") or ["25"])[0])
            except ValueError:
                wait_s = 25.0
            commands = relay.hub.pull(client_id, label, wait_s)
            self._send_json(200, {"commands": commands})

        def _post_ingest(self) -> None:
            if not self._extension_origin_ok():
                self._send_json(403, {"error": "extension origins only"})
                return
            raw = self._read_body()
            if raw is None:
                return
            payload = self._parse_json_body(raw)
            if payload is _PARSE_FAILED:
                return
            records = payload.get("records") if isinstance(payload, dict) else None
            if not isinstance(records, list) or not all(
                isinstance(r, dict) and isinstance(r.get("trace_id"), str) for r in records
            ):
                self._send_json(400, {"error": "expected {records: [objects with trace_id]}"})
                return
            written = relay.store.append(records)
            relay.hub.note_records(records)
            self._send_json(200, {"ok": True, "written": written})

        def _post_result(self) -> None:
            if not self._extension_origin_ok():
                self._send_json(403, {"error": "extension origins only"})
                return
            raw = self._read_body()
            if raw is None:
                return
            payload = self._parse_json_body(raw)
            if payload is _PARSE_FAILED:
                return
            if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
                self._send_json(400, {"error": "expected {id, ...result fields}"})
                return
            known = relay.hub.post_result(payload["id"], payload)
            self._send_json(200 if known else 404,
                            {"ok": known} if known else {"error": "unknown command id"})

        def _post_focus(self) -> None:
            raw = self._read_body()
            if raw is None:
                return
            record = self._parse_json_body(raw)
            if record is _PARSE_FAILED:
                return
            if not isinstance(record, dict):
                self._send_json(400, {"error": "expected a trace record object"})
                return
            # Two accepted shapes: a full trace record (what the viewer's
            # Focus button sends), or {"project": "host:port"} from an app
            # that only knows its own address.
            meta = record.get("meta") or {}
            if not meta.get("tab_id") and record.get("project"):
                target = relay.hub.project_target(record["project"])
                if target is None:
                    self._send_json(404, {
                        "error": f"no tab seen for project {record['project']!r} yet",
                        "projects": relay.hub.projects(),
                    })
                    return
                meta = {**target}
            client_id = relay.hub.resolve_client(meta.get("client_id"))
            if client_id is None:
                self._send_json(503, {
                    "error": "no matching browser connected",
                    "clients": relay.hub.clients(),
                })
                return
            cmd_id = relay.hub.enqueue(client_id, {
                "type": "focus",
                "tab_id": meta.get("tab_id"),
                "window_id": meta.get("window_id"),
            })
            result = relay.hub.wait_result(cmd_id, FOCUS_TIMEOUT_S)
            if result is None:
                self._send_json(504, {"error": "browser didn't answer in time"})
            elif result.get("ok"):
                self._send_json(200, {"ok": True})
            else:
                self._send_json(502, {"error": result.get("error", "focus failed")})

        def _get_snapshot(self, query: Dict[str, List[str]]) -> None:
            requested_client = (query.get("client") or [""])[0] or None
            tab_raw = (query.get("tab") or [""])[0] or None
            project = (query.get("project") or [""])[0] or None
            # ?project= resolves both the tab and the owning browser from
            # the most recent record that project produced.
            if project is not None and tab_raw is None:
                target = relay.hub.project_target(project)
                if target is None:
                    self._send_json(404, {
                        "error": f"no tab seen for project {project!r} yet",
                        "projects": relay.hub.projects(),
                    })
                    return
                tab_raw = str(target["tab_id"])
                requested_client = requested_client or target.get("client_id")
            client_id = relay.hub.resolve_client(requested_client)
            if client_id is None:
                self._send_json(503, {
                    "error": "no browser connected, or several — pass ?client=",
                    "clients": relay.hub.clients(),
                })
                return
            tab_id: Optional[int] = None
            if tab_raw is not None:
                try:
                    tab_id = int(tab_raw)
                except ValueError:
                    self._send_json(400, {"error": "tab must be an integer id"})
                    return
            cmd_id = relay.hub.enqueue(client_id, {
                "type": "snapshot",
                "tab_id": tab_id,
                "selector": (query.get("selector") or [""])[0] or None,
                "exists": (query.get("exists") or ["0"])[0] in ("1", "true"),
            })
            result = relay.hub.wait_result(cmd_id, SNAPSHOT_TIMEOUT_S)
            if result is None:
                self._send_json(504, {"error": "browser didn't answer in time"})
            elif result.get("ok"):
                self._send_json(200, {k: v for k, v in result.items() if k != "id"})
            else:
                self._send_json(502, {"error": result.get("error", "snapshot failed")})

        def _get_demo(self) -> None:
            demo_path = Path(__file__).parent / "demo.html"
            self._send_html(200, demo_path.read_text(encoding="utf-8"))

    return Handler
