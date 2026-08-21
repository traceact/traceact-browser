"""Relay tests: hostile input first, then the happy path, then the
traceact schema round-trip."""

import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from traceact_browser.server import RelayServer, find_running_relay


@pytest.fixture()
def relay(tmp_path):
    server = RelayServer(tmp_path / "traces.jsonl", port=18631)
    server.bind()
    server.serve_in_thread()
    yield server
    server.shutdown()


def _url(relay: RelayServer, path: str) -> str:
    return f"http://127.0.0.1:{relay.port}{path}"


def _post(relay, path, body: bytes, headers=None):
    req = urllib.request.Request(_url(relay, path), data=body,
                                 headers=headers or {"Content-Type": "application/json"})
    return urllib.request.urlopen(req)


def _post_status(relay, path, body: bytes, headers=None) -> int:
    try:
        return _post(relay, path, body, headers).status
    except urllib.error.HTTPError as err:
        return err.code


def _raw_request(port, method, path, headers=None, body=b""):
    """Send a request with exactly the headers given, so Host can be forged
    the way a DNS-rebinding attacker's browser would."""
    base = {"Host": f"127.0.0.1:{port}", "Connection": "close"}
    base.update(headers or {})
    if body:
        base.setdefault("Content-Length", str(len(body)))
    lines = [f"{method} {path} HTTP/1.1"] + [f"{k}: {v}" for k, v in base.items()]
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode() + body
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(raw)
        resp = b""
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
    return int(resp.split(b"\r\n", 1)[0].split()[1])


def _record(**over):
    """A full traceact-shaped record, the same shape buildRecord emits."""
    rec = {
        "trace_id": "trc_0123456789ab", "root_trace_id": "trc_0123456789ab",
        "parent_trace_id": None, "upstream_trace_id": None,
        "correlation_id": None, "project": "127.0.0.1:3000",
        "action": "console.log", "kind": "browser", "actor": "page",
        "status": "completed", "budget_hit": False, "sampled_out": False,
        "started_at": "2026-08-13T16:00:00.000Z",
        "ended_at": "2026-08-13T16:00:00.000Z", "duration_ms": 0,
        "inputs": {}, "steps": [], "events": [], "touches": [],
        "outputs": {}, "errors": [], "child_summaries": [],
        "meta": {"tab_id": 7, "client_id": "cli_x"},
    }
    rec.update(over)
    if "trace_id" in over and "root_trace_id" not in over:
        rec["root_trace_id"] = over["trace_id"]
    return rec


# ---- H1: DNS-rebinding and web-page CSRF defenses ----

def test_foreign_host_header_rejected_on_every_route(relay):
    """A non-loopback Host (what a DNS-rebound page sends) is refused
    everywhere, before any handler logic runs."""
    routes = [("GET", "/health"), ("GET", "/snapshot"), ("GET", "/pull?client=x"),
              ("GET", "/"), ("GET", "/demo"),
              ("POST", "/ingest"), ("POST", "/focus"), ("POST", "/result")]
    for method, path in routes:
        body = b'{"records":[]}' if method == "POST" else b""
        code = _raw_request(relay.port, method, path,
                            headers={"Host": "attacker.example"}, body=body)
        assert code == 403, f"{method} {path} accepted a foreign Host"


def test_loopback_host_variants_accepted(relay):
    """The legitimate loopback names all pass the Host gate."""
    for host in (f"127.0.0.1:{relay.port}", f"localhost:{relay.port}", "localhost"):
        code = _raw_request(relay.port, "GET", "/health", headers={"Host": host})
        assert code == 200, f"Host {host!r} was rejected"


def test_missing_host_header_rejected(relay):
    code = _raw_request(relay.port, "GET", "/health", headers={"Host": ""})
    assert code == 403


def test_web_page_origin_refused_on_focus_snapshot_health(relay):
    """A site's http(s) Origin can't drive the local-tool endpoints, even
    with a valid loopback Host (the plain-CSRF case, no rebinding)."""
    for method, path, body in [("GET", "/health", b""),
                               ("GET", "/snapshot", b""),
                               ("POST", "/focus", b'{"project":"x:1"}')]:
        code = _raw_request(relay.port, method, path,
                            headers={"Origin": "https://evil.example.com",
                                     "Content-Type": "application/json"},
                            body=body)
        assert code == 403, f"{method} {path} accepted a web-page Origin"


def test_extension_origin_still_reaches_focus_and_snapshot(relay):
    """A chrome-extension Origin passes the new gates (503/no-tab, not 403)."""
    assert _raw_request(relay.port, "GET", "/health",
                        headers={"Origin": "chrome-extension://abcdef"}) == 200
    code = _raw_request(relay.port, "POST", "/focus",
                        headers={"Origin": "chrome-extension://abcdef",
                                 "Content-Type": "application/json"},
                        body=json.dumps(_record()).encode())
    assert code == 503  # reached the handler; no browser connected


def test_local_tool_no_origin_still_reaches_health_and_focus(relay):
    """The viewer's focus hook and Python client send no Origin — they pass."""
    assert json.loads(urllib.request.urlopen(_url(relay, "/health")).read())["app"] \
        == "traceact-browser"
    assert _post_status(relay, "/focus", json.dumps(_record()).encode()) == 503


# ---- hostile input ----

def _store_is_empty(relay) -> bool:
    """No records written. The file itself exists from store construction
    (created owner-only up front), so emptiness is what a rejected write means."""
    return relay.store.path.read_text() == ""


def test_ingest_rejects_malformed_json(relay):
    assert _post_status(relay, "/ingest", b"{not json") == 400
    assert _store_is_empty(relay)


def test_ingest_rejects_wrong_shapes(relay):
    for body in (b"[]", b'{"records": "no"}', b'{"records": [1, 2]}',
                 b'{"records": [{"no_trace_id": true}]}', b'"a string"', b"null"):
        assert _post_status(relay, "/ingest", body) == 400, body
    assert _store_is_empty(relay)


def test_ingest_rejects_oversized_and_missing_length(relay):
    huge = str(9_000_000)
    req = urllib.request.Request(_url(relay, "/ingest"), data=b"x",
                                 headers={"Content-Length": huge})
    try:
        urllib.request.urlopen(req)
        code = 200
    except urllib.error.HTTPError as err:
        code = err.code
    assert code == 413


def test_ingest_refuses_web_page_origins(relay):
    body = json.dumps({"records": [_record()]}).encode()
    assert _post_status(relay, "/ingest", body,
                        {"Content-Type": "application/json",
                         "Origin": "https://evil.example.com"}) == 403
    assert _post_status(relay, "/ingest", body,
                        {"Content-Type": "application/json",
                         "Origin": "chrome-extension://abcdef"}) == 200


def test_pull_requires_client_and_refuses_page_origins(relay):
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(_url(relay, "/pull?wait=0"))
    assert err.value.code == 400
    req = urllib.request.Request(_url(relay, "/pull?client=c&wait=0"),
                                 headers={"Origin": "https://evil.example.com"})
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(req)
    assert err.value.code == 403


def test_result_with_unknown_id_is_404(relay):
    assert _post_status(relay, "/result", b'{"id": "cmd_nope", "ok": true}') == 404


def test_focus_with_no_browser_connected_is_503(relay):
    assert _post_status(relay, "/focus", json.dumps(_record()).encode()) == 503


def test_focus_rejects_non_object_bodies(relay):
    assert _post_status(relay, "/focus", b"[1,2,3]") == 400
    assert _post_status(relay, "/focus", b"{bad") == 400


def test_snapshot_with_no_browser_is_503_and_bad_tab_is_400(relay):
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(_url(relay, "/snapshot"))
    assert err.value.code == 503
    # Connect a fake client so the tab validation is what's being tested.
    urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=T&wait=0"))
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(_url(relay, "/snapshot?client=cli_x&tab=NaN"))
    assert err.value.code == 400


def test_unknown_routes_404(relay):
    for path in ("/nope", "/ingest/extra"):
        with pytest.raises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(_url(relay, path))
        assert err.value.code == 404


# ---- L1: the index page escapes the client-supplied label ----

def test_index_escapes_malicious_browser_label(relay):
    # A client registers with a script-tag label (labels come from /pull).
    urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=%3Cscript%3Ealert(1)%3C/script%3E&wait=0"))
    body = urllib.request.urlopen(_url(relay, "/")).read().decode("utf-8")
    assert "<script>alert(1)</script>" not in body, "label rendered unescaped"
    assert "&lt;script&gt;" in body, "label not present in escaped form"


# ---- happy path ----

def test_ingest_appends_jsonl_lines(relay):
    records = [_record(trace_id=f"trc_{i:012x}") for i in range(3)]
    resp = _post(relay, "/ingest", json.dumps({"records": records}).encode())
    assert json.loads(resp.read())["written"] == 3
    lines = relay.store.path.read_text().strip().splitlines()
    assert len(lines) == 3
    assert [json.loads(l)["trace_id"] for l in lines] == [r["trace_id"] for r in records]


def test_concurrent_ingest_never_interleaves_lines(relay):
    def blast(n):
        body = json.dumps({"records": [_record(trace_id=f"trc_{n}{i:011x}")
                                       for i in range(50)]}).encode()
        _post(relay, "/ingest", body)
    threads = [threading.Thread(target=blast, args=(n,)) for n in range(8)]
    for t in threads: t.start()
    for t in threads: t.join()
    lines = relay.store.path.read_text().strip().splitlines()
    assert len(lines) == 400
    for line in lines:
        json.loads(line)  # every line parses whole


def test_health_and_discovery(relay):
    health = json.loads(urllib.request.urlopen(_url(relay, "/health")).read())
    assert health["app"] == "traceact-browser"
    assert health["port"] == relay.port
    found = find_running_relay(relay.port, attempts=1)
    assert found is not None and found[0] == relay.port


def test_command_round_trip_focus(relay):
    """A fake extension long-polls, receives the focus command, posts the
    result, and the /focus caller gets a 200."""
    results = {}

    def fake_extension():
        resp = urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=10"))
        commands = json.loads(resp.read())["commands"]
        results["commands"] = commands
        _post(relay, "/result",
              json.dumps({"id": commands[0]["id"], "ok": True}).encode())

    urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=0"))
    ext = threading.Thread(target=fake_extension)
    ext.start()
    time.sleep(0.2)
    resp = _post(relay, "/focus", json.dumps(_record()).encode())
    ext.join()
    assert resp.status == 200
    assert results["commands"][0]["type"] == "focus"
    assert results["commands"][0]["tab_id"] == 7


def test_snapshot_round_trip_with_selector(relay):
    def fake_extension():
        resp = urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=10"))
        commands = json.loads(resp.read())["commands"]
        cmd = commands[0]
        assert cmd["type"] == "snapshot" and cmd["selector"] == "#app"
        _post(relay, "/result", json.dumps(
            {"id": cmd["id"], "ok": True, "matches": 1, "html": ["<div id=app></div>"]}).encode())

    urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=0"))
    ext = threading.Thread(target=fake_extension)
    ext.start()
    time.sleep(0.2)
    resp = urllib.request.urlopen(_url(relay, "/snapshot?selector=%23app"))
    ext.join()
    payload = json.loads(resp.read())
    assert payload["matches"] == 1
    assert payload["html"] == ["<div id=app></div>"]


def test_demo_page_serves_with_no_store(relay):
    resp = urllib.request.urlopen(_url(relay, "/demo"))
    assert resp.headers["Cache-Control"] == "no-store"
    assert b"traceact-browser demo" in resp.read()


# ---- M1: the trace file and its directory are owner-only ----

@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_new_store_is_owner_only(tmp_path):
    from traceact_browser.store import TraceStore
    data = tmp_path / "nested" / "traces.jsonl"
    store = TraceStore(data)
    store.append([_record()])
    assert (data.stat().st_mode & 0o777) == 0o600, "trace file is not 0600"
    assert (data.parent.stat().st_mode & 0o777) == 0o700, "data dir is not 0700"


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_existing_world_readable_file_is_tightened_on_init(tmp_path):
    """A file left 0644 by an older release is locked down when the relay
    next starts, so upgrading closes the exposure without a manual step."""
    from traceact_browser.store import TraceStore
    data = tmp_path / "traces.jsonl"
    data.write_text('{"trace_id":"trc_old"}\n', encoding="utf-8")
    os.chmod(data, 0o644)
    os.chmod(tmp_path, 0o755)
    TraceStore(data)  # construction alone must tighten both
    assert (data.stat().st_mode & 0o777) == 0o600
    assert (tmp_path.stat().st_mode & 0o777) == 0o700


# ---- M2: bounded growth via rotation, and the clear command ----

def test_store_rotates_past_the_cap_and_bounds_total(tmp_path):
    from traceact_browser.store import TraceStore
    data = tmp_path / "traces.jsonl"
    store = TraceStore(data, max_bytes=400)  # tiny cap to trigger fast
    rec = _record()
    for _ in range(200):
        store.append([rec])
    prev = data.with_name("traces.jsonl.1")
    assert prev.exists(), "no rotation happened past the cap"
    # One generation only: each file stays within a batch of the cap.
    assert data.stat().st_size < 400 * 3
    assert prev.stat().st_size < 400 * 3


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_rotated_generation_is_also_owner_only(tmp_path):
    from traceact_browser.store import TraceStore
    data = tmp_path / "traces.jsonl"
    store = TraceStore(data, max_bytes=300)
    for _ in range(200):
        store.append([_record()])
    prev = data.with_name("traces.jsonl.1")
    assert prev.exists()
    assert (prev.stat().st_mode & 0o777) == 0o600, "rotated file leaked to 0644"
    assert (data.stat().st_mode & 0o777) == 0o600, "fresh file after rotation not 0600"


def test_second_rotation_overwrites_the_first_generation(tmp_path):
    """Growth is bounded because .1 is a single slot, not an ever-growing pile."""
    from traceact_browser.store import TraceStore
    data = tmp_path / "traces.jsonl"
    store = TraceStore(data, max_bytes=300)
    for _ in range(600):
        store.append([_record()])
    # No .2, .3, … generations accumulate.
    assert not data.with_name("traces.jsonl.2").exists()
    assert not data.with_name("traces.jsonl.1.1").exists()


def test_store_clear_empties_file_and_removes_rotation(tmp_path):
    from traceact_browser.store import TraceStore
    data = tmp_path / "traces.jsonl"
    store = TraceStore(data, max_bytes=300)
    for _ in range(200):
        store.append([_record()])
    assert data.with_name("traces.jsonl.1").exists()
    removed = store.clear()
    assert removed >= 1
    assert data.exists() and data.read_text() == ""  # recreated empty
    assert not data.with_name("traces.jsonl.1").exists()
    # The recreated file is still owner-only.
    if os.name == "posix":
        assert (data.stat().st_mode & 0o777) == 0o600


def test_clear_endpoint_wipes_and_is_origin_gated(relay):
    relay.store.append([_record(), _record(trace_id="trc_222222222222")])
    assert relay.store.path.read_text() != ""
    # A web-page Origin is refused.
    assert _raw_request(relay.port, "POST", "/clear",
                        headers={"Origin": "https://evil.example.com"}) == 403
    # A local-tool call (no Origin) clears it.
    resp = _post(relay, "/clear", b"")
    assert resp.status == 200
    assert relay.store.path.read_text() == ""


def test_clear_removes_current_and_rotated(tmp_path):
    from traceact_browser.cli import clear
    data = tmp_path / "traces.jsonl"
    data.write_text("{}\n", encoding="utf-8")
    prev = data.with_name("traces.jsonl.1")
    prev.write_text("{}\n", encoding="utf-8")
    assert clear(data) == 0
    assert not data.exists()
    assert not prev.exists()
    # Clearing an already-clean path is not an error.
    assert clear(data) == 0


# ---- project-scoped addressing ----

def test_snapshot_by_unknown_project_is_404_with_known_list(relay):
    _post(relay, "/ingest", json.dumps({"records": [_record()]}).encode())
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(_url(relay, "/snapshot?project=nope:1"))
    assert err.value.code == 404
    body = json.loads(err.value.read())
    assert "127.0.0.1:3000" in body["projects"]


def test_snapshot_by_project_resolves_tab_and_client(relay):
    _post(relay, "/ingest", json.dumps({"records": [
        _record(trace_id="trc_aaaaaaaaaaa1",
                meta={"tab_id": 7, "window_id": 2, "client_id": "cli_x"}),
        _record(trace_id="trc_aaaaaaaaaaa2", project="other:1",
                meta={"tab_id": 99, "window_id": 3, "client_id": "cli_x"}),
    ]}).encode())

    def fake_extension():
        resp = urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=10"))
        cmd = json.loads(resp.read())["commands"][0]
        assert cmd["type"] == "snapshot" and cmd["tab_id"] == 7
        _post(relay, "/result", json.dumps(
            {"id": cmd["id"], "ok": True, "matches": 2}).encode())

    urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=0"))
    ext = threading.Thread(target=fake_extension)
    ext.start()
    time.sleep(0.2)
    resp = urllib.request.urlopen(
        _url(relay, "/snapshot?project=127.0.0.1%3A3000&exists=1"))
    ext.join()
    assert json.loads(resp.read())["matches"] == 2


def test_focus_by_project_body(relay):
    _post(relay, "/ingest", json.dumps({"records": [
        _record(meta={"tab_id": 41, "window_id": 5, "client_id": "cli_x"}),
    ]}).encode())

    def fake_extension():
        resp = urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=10"))
        cmd = json.loads(resp.read())["commands"][0]
        assert cmd["type"] == "focus" and cmd["tab_id"] == 41 and cmd["window_id"] == 5
        _post(relay, "/result", json.dumps({"id": cmd["id"], "ok": True}).encode())

    urllib.request.urlopen(_url(relay, "/pull?client=cli_x&label=Chrome&wait=0"))
    ext = threading.Thread(target=fake_extension)
    ext.start()
    time.sleep(0.2)
    resp = _post(relay, "/focus", json.dumps({"project": "127.0.0.1:3000"}).encode())
    ext.join()
    assert resp.status == 200


def test_focus_by_unknown_project_is_404(relay):
    assert _post_status(relay, "/focus", b'{"project": "ghost:9"}') == 404


def test_newest_record_wins_the_project_target(relay):
    _post(relay, "/ingest", json.dumps({"records": [
        _record(trace_id="trc_aaaaaaaaaaa1", meta={"tab_id": 1, "client_id": "cli_x"}),
    ]}).encode())
    _post(relay, "/ingest", json.dumps({"records": [
        _record(trace_id="trc_aaaaaaaaaaa2", meta={"tab_id": 2, "client_id": "cli_x"}),
    ]}).encode())
    assert relay.hub.project_target("127.0.0.1:3000")["tab_id"] == 2


def test_health_reports_projects(relay):
    _post(relay, "/ingest", json.dumps({"records": [_record()]}).encode())
    health = json.loads(urllib.request.urlopen(_url(relay, "/health")).read())
    assert "127.0.0.1:3000" in health["projects"]


def test_client_module_snapshot_and_focus_paths(relay):
    from traceact_browser import client
    base = f"http://127.0.0.1:{relay.port}"
    out = client.snapshot("ghost:9", selector="#x", base_url=base)
    assert "error" in out
    out = client.focus("ghost:9", base_url=base)
    assert "error" in out
    out = client.health(base_url=base)
    assert out["app"] == "traceact-browser"


# ---- the schema round-trip: our records through traceact itself ----

def test_records_read_back_through_tracelog(relay, tmp_path):
    from traceact import TraceLog

    records = [
        _record(trace_id="trc_aaaaaaaaaaaa", status="completed",
                action="console.log", correlation_id="pl_1"),
        _record(trace_id="trc_bbbbbbbbbbbb", status="failed", action="page.error",
                errors=[{"type": "TypeError", "message": "boom", "stack": "at x"}],
                meta={"tab_id": 9, "window_id": 2, "client_id": "cli_x",
                      "browser": "Brave", "page_load_id": "pl_1"}),
    ]
    _post(relay, "/ingest", json.dumps({"records": records}).encode())

    log = TraceLog(str(relay.store.path))
    loaded = list(log.all())
    assert len(loaded) == 2
    by_id = {t["trace_id"]: t for t in loaded}
    # Identity fields survive the round trip untouched (pinned upstream too).
    failed = by_id["trc_bbbbbbbbbbbb"]
    assert failed["meta"]["browser"] == "Brave"
    assert failed["meta"]["tab_id"] == 9
    assert failed["errors"][0]["stack"] == "at x"
    failures = [t for t in loaded if t["status"] == "failed"]
    assert [t["trace_id"] for t in failures] == ["trc_bbbbbbbbbbbb"]
