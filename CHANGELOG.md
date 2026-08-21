# Changelog

All notable changes to traceact-browser are documented here.

## [1.2.0] — 2026-08-21

A security review of the whole library. If you captured provider keys with 1.0.0 or 1.1.0 (testing a settings page on a localhost app is the likely path), treat them as exposed to your local disk: rotate them, then wipe the trace file with `traceact-browser clear`.

### Added

- **`traceact-browser clear`** deletes the trace file and its rotated generation in one command.
- **Automatic size-cap rotation.** The trace file rotates to a single `.jsonl.1` generation once it passes a cap (20 MB by default, set with `serve --max-bytes`), so captured data can't accumulate on disk without bound; total stays under ~2x the cap.
- **`fieldIsSensitive` / `keyIsSensitive`** are exported from the extension's `lib.js` for reuse and testing.

### Security

- **DNS-rebinding and CSRF defenses on the relay.** `/focus`, `/snapshot`, and `/health` previously had no origin check, so a web page could drive them (front tabs, trigger snapshots) and a DNS-rebound page could read the snapshot and project list. Every route now requires a loopback `Host` header (defeats rebinding) and the local-tool routes reject browser `Origin`s (defeats plain CSRF). Local tools and the extension are unaffected.
- **Request/response bodies now mask credentials.** JSON bodies are parsed and masked by key name at depth; a clean body keeps its original bytes; unparseable bodies get pattern masking. This closes the case where `{"api_key": "sk-…"}` reached disk in plaintext.
- **Key-name matching is word-aware, not substring.** `access_key`, `private_key`, and `signing_key` now mask (they were missed before), while `monkey`, `keyboard`, and `shipping` no longer over-mask.
- **Value-shape masking broadened and applied to URL paths.** OpenAI/Anthropic/Google/GitHub/Slack/Perplexity keys plus AWS ids, Stripe secret keys, Google OAuth tokens, and PEM private keys are masked wherever they appear in a captured string — including a secret embedded in a URL path (`/reset/<jwt>`), not just query parameters.
- **The trace file and its directory are owner-only** (`0600` / `0700`), so other local accounts can't read captured data. An already-loose file from an older release is tightened when the relay next starts.
- **Sensitive fields aren't captured even with "record only length" off.** Passwords, card numbers, one-time codes, and credential-named fields are never recorded; passwords are blanked at the source before crossing the extension's internal bridge.
- **The relay index page escapes the browser label**, closing a self-XSS from a script-tag label.
- **The project key anchors to the trusted tab URL**, so a tracked page can no longer forge records attributed to another app's `host:port`.
- **Capture is gated on a tracked signal**, so an untracked page does no capture work and never emits over the internal bridge; the background remains the authoritative gate.

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
