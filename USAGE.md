# TraceAct Browser — Usage

The full manual. For the quick start, see the [README](https://github.com/traceact/traceact-browser/blob/main/README.md).

## Installation

Two halves, installed once each:

1. **The relay** (writes traces to disk, answers questions):

   ```bash
   pip install traceact-browser
   ```

2. **The extension** (captures in the browser): clone the repo, open `chrome://extensions` (or `brave://extensions`), turn on Developer mode, click **Load unpacked**, and pick the repo's `extension/` folder. What you read in that folder is byte for byte what runs; there's no build step.

The repo's launcher (`launch.command` / `launch.sh` / `launch.bat`) does all of this plus starts the viewer and a demo page.

## Quickstart

```bash
traceact-browser
```

```
traceact-browser relay on http://127.0.0.1:8631
Trace file: /Users/you/.traceact-browser/traces.jsonl
Demo page:  http://127.0.0.1:8631/demo
View:       traceact view /Users/you/.traceact-browser/traces.jsonl --map --focus-hook http://127.0.0.1:8631/focus
```

Open the demo page with the extension loaded: it logs, fetches, 404s, and errors on purpose, and each of those appears in the trace file within a couple of seconds. Run the `traceact view` line to watch them arrive live.

## Choosing what gets tracked

Capture runs per site. A site is tracked when it matches the allowlist, or when "capture all sites" is on.

- **One click:** open the extension popup on any page and press **Track this site** / **Stop tracking this site**.
- **The list:** the options page holds the full allowlist. Type domains the way you'd say them — no scheme, no path:

  | You type | It matches |
  |---|---|
  | `myapp.com` | `myapp.com` and every subdomain, on any port |
  | `app.myapp.com` | that subdomain (and its own subdomains) |
  | `127.0.0.1:3000` | that exact host and port — one app |
  | `localhost` | every localhost port |

- **Defaults:** `localhost` and `127.0.0.1` ship tracked; everything else ships untracked.
- **Capture all sites** (options page) ignores the list entirely. The badge still shows ON per tab so you always know.

The toolbar badge is the recording indicator: green ON when the current tab's site is tracked, blank when it isn't.

## The trace file

Every capture becomes one traceact-format JSONL record in `~/.traceact-browser/traces.jsonl`. Fields shared by all records:

| Field | Value |
|---|---|
| `project` | the site as `host` or `host:port` — the viewer's project filter separates apps |
| `action` | what happened (`console.error`, `net.request`, `dom.click`, …) |
| `kind` / `actor` | `browser` / `page`, or `user` for interactions |
| `status` | `completed`, or `failed` for errors and 4xx/5xx responses |
| `correlation_id` | the page visit — one id per load, so a visit's records group together |
| `meta` | `browser` label, `window_id`, `tab_id`, `tab_title`, `url`, `page_load_id`, `client_id` |

Per-action payloads:

| `action` | `inputs` | `outputs` / `errors` |
|---|---|---|
| `console.*` | `args`: serialized arguments | `console.error` reports `status: failed` |
| `page.error`, `page.rejection` | — | `errors`: type, message, stack |
| `net.request` | `method`, `url`, `via`, `request_body`* | `status`; `response_body`*; a `net` event with timing |
| `dom.click`, `dom.submit` | `selector`, `text` | — |
| `dom.input` | `selector`, `value_length` (or `value` if redaction is off) | — |
| `nav.spa` | `from`, `to`, `mechanism` | — |
| `dom.mutation` | `nodes_added`, `nodes_removed`, `window_ms` | — |

\* Bodies are captured for JSON/text content types, size-capped at 64 KB, and only where the bodies setting allows (localhost apps by default). Fetches made from web workers aren't captured; requests the page's own code didn't make (scripts, images, iframes) arrive as metadata without bodies.

Agents read the file directly:

```bash
grep '"status":"failed"' ~/.traceact-browser/traces.jsonl | tail -5
```

or through traceact's `TraceLog` API, or in the viewer:

```bash
traceact view ~/.traceact-browser/traces.jsonl --map
```

## Snapshots: asking a tab what it looks like now

The relay exposes `GET /snapshot`, answered live by the extension from the tracked tab:

| Parameter | Meaning |
|---|---|
| `project` | address the tab by the app's own `host:port` — the relay targets the tab most recently seen producing traces for it, in whichever browser |
| `selector` | return only the matching subtree(s), up to 5 matches, with a match count |
| `exists=1` | return only the match count, no HTML |
| `tab` | a `tab_id` from any trace record's `meta`; defaults to the active tab |
| `client` | which browser instance, when more than one is connected (`client_id` from `meta`, or see `/health`) |

`project` is the parameter apps and agents should reach for first: an app already knows its own address, so no ids need discovering. From Python, the installed package wraps this:

```python
from traceact_browser import snapshot, focus

snapshot("127.0.0.1:8765", selector="#results")   # the app's own host:port
snapshot("127.0.0.1:8765", selector=".modal", exists=True)
focus("127.0.0.1:8765")                           # front the app's tab
```

`/health` lists every `project` the relay has seen and how long ago, so an agent can check its app is being tracked before asking for snapshots.

```bash
curl 'http://127.0.0.1:8631/snapshot?selector=%23checkout&exists=1'
# {"ok": true, "matches": 1, "tab_id": 812, "url": "...", "project": "127.0.0.1:3000"}
```

Snapshots are size-capped at 200 KB, scripts are stripped, and input values are redacted. A tab on an untracked site refuses to snapshot.

## Click-to-focus

```bash
traceact view ~/.traceact-browser/traces.jsonl --focus-hook http://127.0.0.1:8631/focus
```

Each trace row in the viewer gains a **Focus** button. Clicking one sends the record to the relay, which tells the owning browser to front that window and tab. With Chrome and Brave both connected, the record's `client_id` routes the request to the right one.

`POST /focus` also accepts the minimal body `{"project": "host:port"}`, fronting the tab most recently seen for that app — the same addressing the snapshot endpoint and the Python `focus()` helper use.

## Several browsers, windows, and agents at once

- Each browser profile with the extension loaded is one client, labelled automatically (Chrome, Brave) or by hand in options. All clients post to the same relay and the same file.
- `meta.window_id` / `meta.tab_id` / `meta.page_load_id` tell tabs and visits apart; `project` tells apps apart.
- Any number of agents can tail the one file concurrently, each filtering by the `project` it's working on.
- `GET /health` lists connected clients:

  ```bash
  curl http://127.0.0.1:8631/health
  ```

## Redaction

Applied in the extension, before anything reaches the relay or disk, in every mode:

- Query-string values whose parameter name looks credential-shaped (`token`, `key`, `secret`, `password`, `auth`, `session`, `signature`, `code`, …) are masked in every captured URL. The rest of the URL passes through byte for byte.
- JWTs and `Bearer` tokens are masked inside strings wherever they appear.
- Object keys named like credentials are masked at any depth in console arguments and bodies.
- Password fields are never captured. Other typed input is recorded as a length unless the options page says otherwise.
- Request headers aren't captured at all.

## The relay CLI

| Command | What it does |
|---|---|
| `traceact-browser` | starts the relay (or reports the one already running) |
| `traceact-browser serve --file PATH --port N` | choose the trace file and the first port to try |
| `traceact-browser register-native-host` | lets the popup's Start button launch the relay |
| `traceact-browser --version` | prints the version |

The relay binds `127.0.0.1` only, on port 8631 by default, trying the next 19 ports when it's taken; the extension probes the same range, so they find each other without configuration. The popup shows a **Start the relay** button when the relay is down — it works once `register-native-host` has run (the launcher runs it), and otherwise shows the start command with a copy button.

## What isn't captured

- **Other extensions' own pages** (`chrome-extension://` popups, options, editors). Chrome doesn't let one extension inject into another's pages or observe another extension's requests, so these can't be tracked from outside. An extension that wants its activity in the trace file can write it itself: the relay accepts `POST /ingest` from any extension origin, so posting traceact-shaped records (any `project` string you choose) puts them in the same file and viewer.
- **Fetches made from web workers** — the page-context wrap doesn't reach workers; requests the page's own code didn't make (scripts, images, frames) still arrive as metadata via webRequest.

## Troubleshooting

| Symptom | Check |
|---|---|
| Popup says the relay isn't running | press **Start the relay**, or run `traceact-browser` in a terminal |
| No traces from a site | is the badge ON for that tab? Track the site from the popup |
| No traces from anything | options → "Capture is on"; then reload the tab (capture hooks attach at page load) |
| Bodies missing on a public site | that's the default; options → bodies → "every tracked site" |
| Two relays after a port change | the relay refuses to double-start; `curl http://127.0.0.1:8631/health` shows which one answered |
| Extension loaded but nothing arrives | reload the extension after updating the repo, then reload the tab |

Built by Mo Shehu — mohammedshehu.com
