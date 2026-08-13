"""Native messaging host: lets the extension's Restart button start the relay.

Chrome launches this over stdio when the popup calls sendNativeMessage.
Protocol: a 4-byte little-endian length prefix, then a JSON message. One
request in ({"action": "start"}), one response out, then exit.
"""

import json
import struct
import subprocess
import sys
import time
from typing import Any, Dict

from traceact_browser.cli import DEFAULT_DATA_DIR
from traceact_browser.server import find_running_relay


def _read_message() -> Dict[str, Any]:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return {}
    (length,) = struct.unpack("<I", raw_length)
    if length > 65536:
        return {}
    try:
        return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _write_message(payload: Dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
    sys.stdout.buffer.flush()


def main() -> int:
    message = _read_message()
    if message.get("action") != "start":
        _write_message({"ok": False, "error": "unknown action"})
        return 0

    running = find_running_relay()
    if running is not None:
        _write_message({"ok": True, "port": running[0], "already_running": True})
        return 0

    DEFAULT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    log = open(DEFAULT_DATA_DIR / "relay.log", "ab")
    subprocess.Popen(
        [sys.executable, "-m", "traceact_browser.cli", "serve"],
        stdout=log, stderr=log, stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(25):
        time.sleep(0.2)
        running = find_running_relay()
        if running is not None:
            _write_message({"ok": True, "port": running[0], "already_running": False})
            return 0
    _write_message({"ok": False, "error": "relay didn't come up within 5s; check relay.log"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
