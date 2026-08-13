# TraceAct Browser

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

X-ray vision for your browser.

traceact-browser captures console output, page errors, network activity, and interactions from allowlisted sites in your own browser, and writes them as [traceact](https://github.com/traceact/traceact)-format JSONL to one file on your machine. Any coding agent can read that file; `traceact view` renders it live. Nothing leaves the machine, public sites aren't captured until you allow them, and both halves are plain inspectable source: a load-unpacked Chrome/Brave extension and a zero-dependency Python relay.

Built for debugging with AI agents: instead of opening DevTools and describing what you see, your agent tails the trace file and sees it first-hand — every console line, failed request, click, and route change, plus DOM snapshots on request.

## Install

```bash
git clone https://github.com/traceact/traceact-browser.git
cd traceact-browser
./launch.command        # macOS — double-clicking it in Finder works too
# ./launch.sh           # Linux
# launch.bat            # Windows
```

The launcher sets up a Python environment, installs the relay and traceact, starts both, and opens two tabs: the extensions page (with the extension folder already on your clipboard for the one manual step, "Load unpacked" → paste) and a demo page that logs, fetches, and errors on purpose. The moment the extension is loaded, the demo's traces stream into the viewer.

To set things up by hand instead:

```bash
pip install traceact-browser traceact
traceact-browser                 # starts the relay, prints where everything is
```

```
traceact-browser relay on http://127.0.0.1:8631
Trace file: /Users/you/.traceact-browser/traces.jsonl
Demo page:  http://127.0.0.1:8631/demo
View:       traceact view /Users/you/.traceact-browser/traces.jsonl --map --focus-hook http://127.0.0.1:8631/focus
```

Then load the extension: `chrome://extensions` → Developer mode on → Load unpacked → pick this repo's `extension/` folder.

## What gets captured

| Record | When | What's in it |
|---|---|---|
| `console.log` / `.info` / `.warn` / `.error` / `.debug` | every console call | serialized arguments, depth- and size-capped |
| `page.error`, `page.rejection` | uncaught errors, unhandled promise rejections | type, message, stack |
| `net.request` | every request: fetch, XHR, scripts, images, iframes | method, URL, status, timing; JSON/text bodies for localhost apps |
| `dom.click`, `dom.submit`, `dom.input` | user interactions | a CSS selector for the target; typed values redacted to their length |
| `nav.spa` | pushState, replaceState, popstate, hashchange | from, to, mechanism |
| `dom.mutation` | the page changed shape | nodes added/removed per 2-second window |

Every record carries the site as its `project` (`127.0.0.1:3000` and `127.0.0.1:8000` are two projects, so the viewer's filter separates your apps), and identity fields in `meta`: which browser, window, tab, and page visit produced it.

## Asking the page questions

Agents don't have to read the whole stream. The relay answers scoped questions about a tracked tab, live:

```bash
curl 'http://127.0.0.1:8631/snapshot?selector=%23notice-area'   # just that subtree
curl 'http://127.0.0.1:8631/snapshot?selector=.modal&exists=1'  # only a match count
curl 'http://127.0.0.1:8631/snapshot'                           # the whole DOM, capped
```

Snapshots come back with scripts stripped and form values redacted.

## Click-to-focus

Start the viewer with `--focus-hook http://127.0.0.1:8631/focus` (the launcher does) and every trace row gets a Focus button: click one and the browser tab that produced the trace fronts itself, across windows, in whichever browser it lives.

## Privacy defaults

- Public sites aren't captured until you allow them. `localhost` and `127.0.0.1` are tracked out of the box, since local apps are what this tool is for.
- The popup tracks or untracks the current site in one click; allowlist entries are bare domains (`myapp.com`, `127.0.0.1:3000`), no scheme needed.
- Credential-shaped values — tokens, keys, JWTs, password fields, sensitive query parameters — are masked before anything reaches disk.
- Typed input is recorded as a length, never as text, unless you turn that off.
- Request/response bodies are captured for localhost apps only by default.
- The toolbar badge shows ON whenever the current tab is being recorded.
- One output file, localhost-only relay, no analytics, no network egress.

## Documentation

- [USAGE.md](https://github.com/traceact/traceact-browser/blob/main/USAGE.md) — the full manual
- [ARCHITECTURE.md](https://github.com/traceact/traceact-browser/blob/main/ARCHITECTURE.md) — how the pieces fit
- [CHANGELOG.md](https://github.com/traceact/traceact-browser/blob/main/CHANGELOG.md) — what shipped when

## License

MIT. Contributions welcome; the [CLA](https://github.com/traceact/traceact-browser/blob/main/CLA.md) applies.

Built by Mo Shehu — mohammedshehu.com
