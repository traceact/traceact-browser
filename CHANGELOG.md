# Changelog

All notable changes to traceact-browser are documented here.

## [1.1.0] — 2026-08-13

### Added

- **Project-scoped addressing**: `GET /snapshot?project=host:port` and `POST /focus` with `{"project": "host:port"}` target the tab most recently seen producing traces for that app, resolved across browsers — no tab, window, or client ids needed. The relay learns the mapping from ingested records; unknown projects answer 404 with the list of known ones, and `/health` now reports every project seen with its age.
- **Python client helpers**: `from traceact_browser import snapshot, focus, health` — thin wrappers over the relay's endpoints that find the running relay automatically, for app launchers and agents.
- **TraceAct logo** on the extension icon, popup, and settings-page favicon.

### Changed

- The settings page greys out every capture-dependent control (allowlist, capture-all, redaction, bodies) while "Capture is on" is unticked, so what's inert reads as inert.

## [1.0.0] — 2026-08-13

First release: a Chrome/Brave extension plus a local, zero-dependency Python relay that capture what happens in the browser and write it as traceact-format JSONL to one file on your machine.

### Added

- **Capture**: console output (all levels), uncaught errors and unhandled rejections, network activity (fetch/XHR with timing and gated bodies, plus request metadata for scripts, images, frames, and websockets), user interactions (clicks, submits, debounced inputs), SPA navigation (pushState/replaceState/popstate/hashchange), and DOM mutation summaries.
- **Allowlist tracking**: sites are untracked until allowed; `localhost` and `127.0.0.1` ship tracked. One-click track/untrack in the popup; bare-domain entry (`myapp.com`, `127.0.0.1:3000`) in options; a capture-all toggle; a per-tab ON badge.
- **Redaction before disk**: credential-shaped query parameters masked byte-preservingly, JWT and Bearer patterns masked in strings, credential-named keys masked at depth, password fields never captured, typed input recorded as a length by default, bodies localhost-only by default.
- **traceact-format records**: full 1.0.0 field set, `project` = `host[:port]`, page visit as `correlation_id`, identity (browser label, window, tab, page load, client) in `meta`. Verified in the suite by reading captured records back through traceact's `TraceLog`.
- **The relay** (`pip install traceact-browser`): localhost HTTP server writing one JSONL file; `/health`, `/ingest`, `/snapshot`, `/focus`, a long-poll command channel, and a self-tracing `/demo` page. Port 8631 with automatic probing on both sides.
- **Snapshots**: `GET /snapshot` returns the current DOM of a tracked tab — whole page, a selector-scoped subtree, or a bare match count — scripts stripped, values redacted, size-capped.
- **Click-to-focus**: `POST /focus` accepts a trace record from `traceact view --focus-hook` and fronts the window and tab that produced it, routed by client across browsers.
- **Native-messaging host**: `traceact-browser register-native-host` lets the popup's Start button launch the relay; without it the popup offers the command with a copy button.
- **Launchers** for macOS, Linux, and Windows: environment setup, relay, viewer with focus hook, demo page, and a clipboard-assisted extension install.
