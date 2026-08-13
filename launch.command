#!/bin/bash
# One double-click: venv, relay, native host, viewer, demo page, and a guided
# extension install for the one step Chrome keeps to itself.
cd "$(dirname "$0")" || exit 1

echo "traceact-browser launcher"
echo "========================="

# --- venv: create, protect from sync clients, validate before reuse ---
if [ -d .venv ] && ! .venv/bin/python --version >/dev/null 2>&1; then
  echo "Existing .venv is broken; rebuilding it."
  rm -rf .venv
fi
if [ ! -d .venv ]; then
  echo "Creating a Python environment…"
  python3 -m venv .venv || { echo "python3 is required."; exit 1; }
fi
xattr -w com.dropbox.ignored 1 .venv 2>/dev/null || true
.venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 || true

echo "Installing the relay and traceact…"
.venv/bin/python -m pip install -q -e ./relay
.venv/bin/python -m pip install -q traceact

# --- native host, so the popup's Start button works ---
.venv/bin/traceact-browser register-native-host >/dev/null

# --- relay: start it unless one is already up ---
DATA_DIR="$HOME/.traceact-browser"
mkdir -p "$DATA_DIR"
PORT=$(.venv/bin/python - <<'EOF'
from traceact_browser.server import find_running_relay
found = find_running_relay()
print(found[0] if found else "")
EOF
)
if [ -z "$PORT" ]; then
  nohup .venv/bin/traceact-browser serve >> "$DATA_DIR/relay.log" 2>&1 &
  for _ in $(seq 1 25); do
    sleep 0.2
    PORT=$(.venv/bin/python - <<'EOF'
from traceact_browser.server import find_running_relay
found = find_running_relay()
print(found[0] if found else "")
EOF
)
    [ -n "$PORT" ] && break
  done
fi
if [ -z "$PORT" ]; then
  echo "The relay didn't start; see $DATA_DIR/relay.log"; exit 1
fi
echo "Relay running on http://127.0.0.1:$PORT"
echo "Traces: $DATA_DIR/traces.jsonl"

# --- extension: the one manual step, made as short as possible ---
EXT_DIR="$(pwd)/extension"
NEEDS_EXTENSION=$(.venv/bin/python - "$PORT" <<'EOF'
import json, sys, urllib.request
health = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=2).read())
print("no" if health.get("clients") else "yes")
EOF
)
if [ "$NEEDS_EXTENSION" = "yes" ]; then
  printf '%s' "$EXT_DIR" | pbcopy 2>/dev/null || true
  echo ""
  echo "One step left (Chrome only lets you do this by hand):"
  echo "  1. On the extensions page that just opened, turn on 'Developer mode' (top right)."
  echo "  2. Click 'Load unpacked' and paste — the folder path is already on your clipboard:"
  echo "     $EXT_DIR"
  open -a "Google Chrome" "chrome://extensions/" 2>/dev/null \
    || open -a "Brave Browser" "brave://extensions/" 2>/dev/null \
    || echo "  (Open chrome://extensions yourself — no Chrome or Brave found to open it for you.)"
else
  echo "Extension already connected."
fi

# --- viewer and demo ---
nohup .venv/bin/traceact view "$DATA_DIR/traces.jsonl" --map \
  --focus-hook "http://127.0.0.1:$PORT/focus" >> "$DATA_DIR/viewer.log" 2>&1 &
sleep 1
open "http://127.0.0.1:$PORT/demo" 2>/dev/null || true
echo ""
echo "The demo page just opened; once the extension is loaded, its traces"
echo "appear live in the viewer tab. Localhost is tracked out of the box."
