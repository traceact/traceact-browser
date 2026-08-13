"""The traceact-browser command line.

`traceact-browser` with no arguments starts the relay (or reports the one
already running). `register-native-host` wires up the popup's Restart
button by telling Chrome and Brave where the relay's helper lives.
"""

import argparse
import sys
from pathlib import Path
from typing import List, Optional

from traceact_browser.server import DEFAULT_PORT, RelayServer, find_running_relay

DEFAULT_DATA_DIR = Path.home() / ".traceact-browser"
DEFAULT_DATA_FILE = DEFAULT_DATA_DIR / "traces.jsonl"
NATIVE_HOST_NAME = "com.traceact.browser"
EXTENSION_ID = "mbfbdjhbdbfecboaemmajhfnakcahdfc"

# Per-browser NativeMessagingHosts locations, macOS then Linux.
_HOST_DIRS = [
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    "Library/Application Support/Chromium/NativeMessagingHosts",
    ".config/google-chrome/NativeMessagingHosts",
    ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ".config/chromium/NativeMessagingHosts",
]


def serve(data_file: Path, port: int) -> int:
    """Start the relay, or report the one already running on the port range."""
    running = find_running_relay(port)
    if running is not None:
        found_port, health = running
        print(f"traceact-browser relay already running on http://127.0.0.1:{found_port}")
        print(f"Trace file: {health.get('data_file')}")
        return 0
    relay = RelayServer(data_file, port=port)
    bound = relay.bind()
    print(f"traceact-browser relay on http://127.0.0.1:{bound}")
    print(f"Trace file: {data_file}")
    print(f"Demo page:  http://127.0.0.1:{bound}/demo")
    print(f"View:       traceact view {data_file} --map --focus-hook http://127.0.0.1:{bound}/focus")
    try:
        relay.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


def register_native_host(quiet: bool = False) -> int:
    """Register the native messaging host with every browser found.

    Writes a small wrapper script that starts the relay with this exact
    interpreter, then drops the host manifest into each browser's
    NativeMessagingHosts directory that exists on this machine. Harmless
    to run again; it overwrites its own files only.
    """
    import json

    DEFAULT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    wrapper = DEFAULT_DATA_DIR / "native-host.sh"
    wrapper.write_text(
        "#!/bin/sh\n"
        f'exec "{sys.executable}" -m traceact_browser.native_host\n',
        encoding="utf-8",
    )
    wrapper.chmod(0o755)

    manifest = {
        "name": NATIVE_HOST_NAME,
        "description": "Starts the traceact-browser relay for the extension's Restart button.",
        "path": str(wrapper),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }
    registered = 0
    for rel in _HOST_DIRS:
        host_dir = Path.home() / rel
        if not host_dir.parent.exists():
            continue
        host_dir.mkdir(parents=True, exist_ok=True)
        (host_dir / f"{NATIVE_HOST_NAME}.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
        registered += 1
        if not quiet:
            print(f"Registered native host for {host_dir}")
    if registered == 0 and not quiet:
        print("No Chrome, Brave, or Chromium profile directories found; nothing registered.")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="traceact-browser",
        description="Local relay for the traceact-browser extension. "
                    "Run with no arguments to start it.",
    )
    from traceact_browser import __version__
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command")

    serve_p = sub.add_parser("serve", help="Start the relay (the default).")
    serve_p.add_argument("--file", type=Path, default=DEFAULT_DATA_FILE,
                         help=f"Trace file to append to (default {DEFAULT_DATA_FILE}).")
    serve_p.add_argument("--port", type=int, default=DEFAULT_PORT,
                         help=f"First port to try (default {DEFAULT_PORT}).")

    sub.add_parser("register-native-host",
                   help="Let the extension's Restart button start the relay.")

    args = parser.parse_args(argv)
    if args.command == "register-native-host":
        return register_native_host()
    if args.command == "serve":
        return serve(args.file, args.port)
    return serve(DEFAULT_DATA_FILE, DEFAULT_PORT)


if __name__ == "__main__":
    raise SystemExit(main())
