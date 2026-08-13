"""Tiny client for apps and agents that want to talk to the relay.

An app only needs its own address — the `project` key is the app's
host:port as the browser sees it (`127.0.0.1:8765`). The relay maps that
to the tab most recently seen producing traces for it.

    from traceact_browser.client import focus, snapshot

    snapshot("127.0.0.1:8765", selector="#results")
    focus("127.0.0.1:8765")
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from traceact_browser.server import find_running_relay


class RelayNotRunning(RuntimeError):
    """No relay answered on the probe range."""


def relay_url() -> str:
    """Base URL of the running relay, probing the default port range."""
    found = find_running_relay()
    if found is None:
        raise RelayNotRunning(
            "no traceact-browser relay is running; start one with: traceact-browser"
        )
    return f"http://127.0.0.1:{found[0]}"


def _request(url: str, data: Optional[bytes] = None, timeout: float = 15.0) -> Dict[str, Any]:
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            return json.loads(err.read().decode("utf-8"))
        except Exception:
            return {"error": f"HTTP {err.code}"}


def snapshot(project: str, selector: Optional[str] = None,
             exists: bool = False, base_url: Optional[str] = None) -> Dict[str, Any]:
    """Snapshot the DOM of the tab most recently seen for `project`.

    Returns the relay's JSON: `matches` plus `html` (unless exists=True),
    or an `error` key when nothing has been seen for the project yet.
    """
    params: Dict[str, str] = {"project": project}
    if selector:
        params["selector"] = selector
    if exists:
        params["exists"] = "1"
    base = base_url or relay_url()
    return _request(f"{base}/snapshot?{urllib.parse.urlencode(params)}")


def focus(project: str, base_url: Optional[str] = None) -> Dict[str, Any]:
    """Front the browser tab most recently seen for `project`."""
    base = base_url or relay_url()
    return _request(f"{base}/focus", data=json.dumps({"project": project}).encode("utf-8"))


def health(base_url: Optional[str] = None) -> Dict[str, Any]:
    """The relay's health payload: version, data file, clients, projects."""
    base = base_url or relay_url()
    return _request(f"{base}/health")
