# TraceAct Browser — Architecture

## Project structure

```
traceact-browser/
├── extension/            # MV3 extension, vanilla JS, loaded unpacked as-is
│   ├── manifest.json     # permissions, stable key, two content-script worlds
│   ├── page.js           # MAIN world: console/error/fetch/XHR/interaction capture
│   ├── content.js        # ISOLATED world: page → background bridge
│   ├── background.js     # tracking decisions, record building, relay client, commands
│   ├── lib.js            # pure functions (allowlist, redaction, record shape)
│   ├── popup/            # one-click track/untrack, relay state
│   └── options/          # allowlist, redaction, labels
├── relay/                # pip package `traceact-browser`, stdlib only
│   └── traceact_browser/
│       ├── server.py     # HTTP routes on 127.0.0.1
│       ├── store.py      # JSONL append
│       ├── commands.py   # per-client queues, pending results
│       ├── cli.py        # serve, register-native-host
│       ├── native_host.py# popup's Start button, over Chrome native messaging
│       └── demo.html     # the self-tracing demo page
├── tests/                # pytest (relay, schema round-trip) + node --test (lib.js)
└── launch.command / .sh / .bat
```

## System diagram

```
┌─ Browser (Chrome, Brave — one client each) ─────────────────┐
│  page.js (MAIN)                                             │
│    console/errors/fetch/XHR/clicks/SPA-nav/mutations        │
│        │ postMessage batches                                │
│  content.js (ISOLATED)                                      │
│        │ runtime message                                    │
│  background.js ── tracked? ── buildRecord ── redact         │
│        │ POST /ingest (batched)      ▲ GET /pull (long-poll)│
└────────┼─────────────────────────────┼──────────────────────┘
         ▼                             │ focus / snapshot commands
┌─ Relay (127.0.0.1:8631, stdlib) ─────┴─────────┐
│  /ingest → store.append → traces.jsonl         │
│  /snapshot, /focus → command hub → extension   │
│  /health, /demo, /                             │
└───────────────┬────────────────────────────────┘
                ▼ tails the file            ┌ POST /focus ┐
        traceact view --map --focus-hook ───┘  (per click)
```

## Core components and contracts

**page.js** captures on every page and never decides anything: tracking policy lives in one place (background). Events buffer in a 500-entry ring flushed every 400 ms; a burst past the cap drops oldest and says so in a warning event. Serialization is depth-capped (3), string-capped (2 KB), circular-safe, and never throws into the page. Wrapped primitives (console, fetch, XHR, history) always call through to the originals; capture failure can't change page behaviour.

**content.js** forwards one message shape and nothing else. The page can't reach `chrome.*`; the bridge can't be driven by other windows (source-checked).

**background.js** is the single decision point: it drops events from untracked sites, builds full traceact records, applies redaction, batches to `/ingest` every 2 s (2000-record buffer, newest kept on overflow), and answers relay commands. webRequest supplies metadata for request types the page wrap can't see; the `xmlhttprequest` type is skipped there because the page wrap already reports fetch/XHR with bodies and timing.

**The relay** owns the disk. One append-only JSONL file, one write call per ingest batch, under a lock. Extension-origin posts only (a web page's fetch carries an http(s) Origin and is refused); body cap 8 MB; localhost bind, port 8631 with +1 probing for 20 ports. The command hub holds per-client queues; `/focus` waits 3 s for the browser's answer, `/snapshot` 10 s.

**Records** match traceact 1.0.0's JSONL shape field for field, verified in the test suite by reading them back through `TraceLog`. Identity rides in `meta` (browser label, client, window, tab, page load); the page visit id doubles as `correlation_id`.

## Data stores

One: `~/.traceact-browser/traces.jsonl` (path configurable via `serve --file`). The relay also writes `relay.log` and `native-host.sh` beside it. Extension settings live in `chrome.storage.local` per browser profile.

## External integrations

- **traceact** (PyPI): the viewer and `TraceLog` consume the trace file; `--focus-hook` posts records back to the relay. The relay itself doesn't import traceact.
- **Chrome native messaging**: `register-native-host` writes the host manifest for Chrome, Brave, and Chromium so the popup's Start button can launch the relay. Without it the popup falls back to a copy-paste command.

## Security considerations

- The relay binds `127.0.0.1` only and refuses web-page origins on write routes.
- Redaction happens in the extension, so credentials are masked before they cross the extension/relay boundary: sensitive query parameters, JWT/Bearer patterns, credential-named keys, password fields.
- Snapshots strip script contents and redact form values; untracked tabs refuse to snapshot.
- The extension's `key` field pins its id, so the native-messaging allowlist can't be claimed by a different unpacked extension.
- `/focus` and `/snapshot` are reachable by any local process, same trust model as the trace file itself: the machine's user.

## Development and testing

```bash
python3 -m venv .venv && .venv/bin/pip install -e ./relay traceact pytest
.venv/bin/pytest tests -q          # relay behaviour + schema round-trip
node --test tests/js/*.test.mjs    # extension pure functions
```

CI runs both suites plus mypy on pushes and pull requests. The extension loads unpacked from `extension/` with no build step, so edit → reload extension → reload tab is the whole loop.

## Future considerations

Known debt, not a roadmap: service-worker suspension can delay command handling by up to the 30 s heartbeat when no long-poll is in flight; worker-initiated fetches aren't captured; Windows native-host registration isn't wired into the launcher.

Built by Mo Shehu — mohammedshehu.com
