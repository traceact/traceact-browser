// Shared pure functions for background, popup, and options.
// Kept dependency-free and side-effect-free so they can be unit-tested
// under Node directly.

export const DEFAULT_SETTINGS = {
  enabled: true,
  captureAll: false,
  allowlist: ['localhost', '127.0.0.1'],
  redactInputValues: true,
  captureBodies: 'localhost', // 'localhost' | 'never' | 'always'
  browserLabel: '',
  relayPort: 0 // 0 means probe the default range
};

export const RELAY_PORT_START = 8631;
export const RELAY_PORT_ATTEMPTS = 20;

// Turns whatever a person pastes into a bare host[:port] pattern:
// "https://App.Example.com/path?q=1" -> "app.example.com".
// Returns null when nothing usable remains.
export function normalizeSitePattern(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^@/]*@/, '');                // userinfo
  s = s.split(/[/?#]/)[0];                      // path, query, fragment
  if (!s || /\s/.test(s)) return null;
  // host[:port] only; refuse anything else early rather than store junk.
  if (!/^[a-z0-9.:\-\[\]]+$/.test(s)) return null;
  return s;
}

// Does a URL's host[:port] match one allowlist pattern?
// A pattern with an explicit port matches that exact host:port.
// A pattern without one matches the hostname on any port, subdomains included.
export function patternMatchesUrl(pattern, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  const host = parsed.host.toLowerCase(); // includes :port only when explicit
  if (pattern.includes(':') && !pattern.startsWith('[')) {
    return host === pattern;
  }
  return hostname === pattern || hostname.endsWith('.' + pattern);
}

export function urlIsTracked(url, settings) {
  if (!settings.enabled) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (settings.captureAll) return true;
  return settings.allowlist.some((p) => patternMatchesUrl(p, url));
}

// The viewer's project filter separates apps, so the project key must too:
// three localhost apps on three ports are three projects.
export function projectForUrl(url) {
  try { return new URL(url).host || 'unknown'; } catch { return 'unknown'; }
}

const SENSITIVE_PARAM =
  /((?:^|[?&])[^=&#\s]*(?:token|key|secret|password|passwd|auth|session|signature|sig|credential|code)[^=&#\s]*=)[^&#\s]*/gi;

// Masks credential-looking query values in place, then masks value-shaped
// secrets (JWT/Bearer/provider keys) anywhere in the string — including the
// path, so a token in `/reset/<jwt>` is caught, not just `?token=`. The rest
// passes through byte for byte; nothing is parsed and re-serialized.
// (redactString is a hoisted function declaration below, callable here.)
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  return redactString(url.replace(SENSITIVE_PARAM, '$1[redacted]'));
}

// Value-shape patterns use a `(?<![A-Za-z0-9])` lead-in rather than `\b`.
// `\b` treats `_` as a word character, so a key glued after an underscore
// (`cat_sk-live-…`, `prefix_sk_live_…`) would slip through; the lookbehind
// treats `_` as a separator and catches it, while still refusing to match a
// key prefix that's actually part of a word (`risk-management-…`). Masking
// runs wherever these appear in a captured string — JSON and non-JSON bodies,
// console args, and URL paths. This is a backstop; key-name masking is primary.
const NB = '(?<![A-Za-z0-9])';
const JWT_RE = new RegExp(`${NB}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`, 'g');
const BEARER_RE = new RegExp(`${NB}(Bearer\\s+)[A-Za-z0-9._~+/-]{16,}=*`, 'gi');
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PROVIDER_KEY_RES = [
  new RegExp(`${NB}sk-[A-Za-z0-9_-]{16,}`, 'g'),          // OpenAI (sk-, sk-proj-), Anthropic (sk-ant-)
  new RegExp(`${NB}AIza[0-9A-Za-z_-]{30,}`, 'g'),         // Google API keys
  new RegExp(`${NB}ya29\\.[0-9A-Za-z_-]{20,}`, 'g'),      // Google OAuth access tokens
  new RegExp(`${NB}gh[pousr]_[A-Za-z0-9]{30,}`, 'g'),     // GitHub tokens
  new RegExp(`${NB}github_pat_[A-Za-z0-9_]{30,}`, 'g'),   // GitHub fine-grained PATs
  new RegExp(`${NB}xox[a-z]-[A-Za-z0-9-]{10,}`, 'g'),     // Slack tokens
  new RegExp(`${NB}pplx-[A-Za-z0-9]{16,}`, 'g'),          // Perplexity keys
  new RegExp(`${NB}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`, 'g'), // Stripe secret/restricted keys
  new RegExp(`${NB}AKIA[0-9A-Z]{16}`, 'g'),               // AWS access key ids
  new RegExp(`${NB}ASIA[0-9A-Z]{16}`, 'g')                // AWS temporary access key ids
];

export function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s.replace(PEM_RE, '[redacted-private-key]')
    .replace(JWT_RE, '[redacted-jwt]').replace(BEARER_RE, '$1[redacted]');
  for (const re of PROVIDER_KEY_RES) out = out.replace(re, '[redacted-key]');
  return out;
}

// Whole credential words. Matching is word-aware, not substring: a field is
// sensitive when one of its camelCase/snake/kebab-split words is in this set,
// so `access_key`, `apiKey`, and `privateKey` all mask while `monkey`,
// `keyboard`, and `shipping` (which merely contain these letters) do not.
const SENSITIVE_WORDS = new Set([
  'token', 'secret', 'password', 'passwd', 'pwd', 'passphrase',
  'credential', 'credentials', 'key', 'apikey', 'auth', 'authorization',
  'session', 'cookie', 'bearer', 'pin', 'otp', 'mfa', 'signature', 'sig'
]);

export function keyIsSensitive(name) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .split(/[^A-Za-z0-9]+/)                 // split snake/kebab and separators
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  if (SENSITIVE_WORDS.has(words.join(''))) return true; // apiKey -> "apikey"
  return words.some((w) => SENSITIVE_WORDS.has(w));
}

// Walks a serialized value and masks anything credential-shaped: sensitive
// key names entirely, and value patterns (JWT/Bearer/provider keys, URL query
// values) inside strings. Depth-capped because the input is depth-capped upstream.
export function deepRedact(value, depth = 6) {
  if (depth <= 0) return value;
  if (typeof value === 'string') return redactUrl(value);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth - 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = keyIsSensitive(k) ? '[redacted]' : deepRedact(v, depth - 1);
    }
    return out;
  }
  return value;
}

// Redacts a captured request/response body. Bodies arrive as strings, so
// key-name masking can't see into them until they're parsed: JSON-looking
// bodies are parsed, walked with deepRedact, and re-serialized — but only
// when redaction changed something, so a clean body keeps its original
// bytes. Anything unparseable falls back to pattern masking, which the
// provider-key patterns above still cover.
export function redactBody(body) {
  if (typeof body !== 'string') return body;
  const head = body.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      const masked = deepRedact(parsed, 12);
      const maskedText = JSON.stringify(masked);
      return maskedText === JSON.stringify(parsed) ? body : maskedText;
    } catch {
      // Truncated or malformed JSON; the string path below still masks
      // key-shaped values.
    }
  }
  return redactString(redactUrl(body));
}

const SENSITIVE_AUTOCOMPLETE =
  /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(?:-month|-year)?)/i;
// `\bkey\b` matches a field literally named "key" but not "monkey"/"hotkey"
// (no word boundary before "key" there); the api-key/card/otp families are
// explicit. Governs whether a typed value is captured at all when the
// "record only length" toggle is off.
const SENSITIVE_FIELD_NAME =
  /(pass(?:word|wd|phrase)?|secret|token|api[_-]?key|\bkey\b|credential|cvv|cvc|ssn|social.?security|card.?number|\botp\b|\bmfa\b|\bpin\b)/i;

export function fieldIsSensitive(field) {
  if (!field || typeof field !== 'object') return false;
  if ((field.type || '').toLowerCase() === 'password') return true;
  if (SENSITIVE_AUTOCOMPLETE.test(field.autocomplete || '')) return true;
  return SENSITIVE_FIELD_NAME.test(`${field.name || ''} ${field.id || ''}`);
}

export function bodiesAllowedFor(url, settings) {
  if (settings.captureBodies === 'always') return true;
  if (settings.captureBodies === 'never') return false;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
  } catch { return false; }
}

export function newTraceId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'trc_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Builds one traceact record from one captured browser event.
// The shape mirrors traceact 1.0.0's JSONL records field for field; our
// identity fields ride in meta, and correlation_id groups a page visit.
export function buildRecord(event, tab, identity, settings) {
  const startedAt = new Date(event.t0 || event.t || Date.now()).toISOString();
  const endedAt = new Date(event.t1 || event.t || Date.now()).toISOString();
  // The project keys the viewer's per-app filter, so it must anchor to a URL
  // the page can't forge. Page-sourced events carry a page-supplied `url`; use
  // the trusted top-frame `tab.url` (from sender.tab) for them instead. Only
  // webRequest events, emitted by the background itself, keep event.url — there
  // tab.url can be the previous page mid-navigation.
  const fromWebRequest = typeof event.via === 'string' && event.via.startsWith('webRequest');
  const projectUrl = fromWebRequest ? (event.url || tab.url) : (tab.url || event.url);
  const base = {
    trace_id: newTraceId(),
    root_trace_id: null,
    parent_trace_id: null,
    upstream_trace_id: null,
    correlation_id: event.pageLoadId || null,
    project: projectForUrl(projectUrl),
    action: '',
    kind: 'browser',
    actor: 'page',
    status: 'completed',
    budget_hit: false,
    sampled_out: false,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: event.t1 && event.t0 ? Math.max(0, event.t1 - event.t0) : 0,
    inputs: {},
    steps: [],
    events: [],
    touches: [],
    outputs: {},
    errors: [],
    child_summaries: [],
    meta: {
      source: 'traceact-browser',
      browser: identity.label,
      client_id: identity.clientId,
      window_id: tab.windowId ?? null,
      tab_id: tab.id ?? null,
      tab_title: tab.title || '',
      url: redactUrl(event.url || tab.url || ''),
      page_load_id: event.pageLoadId || null
    }
  };
  base.root_trace_id = base.trace_id;

  switch (event.type) {
    case 'console':
      base.action = 'console.' + event.level;
      base.inputs = { args: deepRedact(event.args) };
      if (event.level === 'error') base.status = 'failed';
      break;
    case 'page.error':
    case 'page.rejection':
      base.action = event.type;
      base.status = 'failed';
      base.errors = [{
        type: event.errorType || 'Error',
        message: redactString(String(event.message || '')).slice(0, 2000),
        stack: redactString(String(event.stack || '')).slice(0, 4000)
      }];
      break;
    case 'net': {
      base.action = 'net.request';
      const failed = event.error || (event.status && event.status >= 400);
      base.status = failed ? 'failed' : 'completed';
      // A relative request URL (fetch('/api')) resolves against the page,
      // so body gating and the recorded URL see the full address.
      let reqUrl = event.reqUrl;
      try { reqUrl = new URL(event.reqUrl, event.url || tab.url).href; } catch {}
      base.inputs = { method: event.method, url: redactUrl(reqUrl), via: event.via };
      if (event.reqBody !== undefined && bodiesAllowedFor(reqUrl, settings)) {
        base.inputs.request_body = redactBody(event.reqBody);
      }
      base.outputs = { status: event.status ?? null };
      if (event.resBody !== undefined && bodiesAllowedFor(reqUrl, settings)) {
        base.outputs.response_body = redactBody(event.resBody);
      }
      if (event.error) base.errors = [{ type: 'NetworkError', message: String(event.error).slice(0, 500) }];
      base.events = [{
        event_id: 'evt_' + newTraceId().slice(4),
        parent_event_id: null,
        kind: 'net',
        action: 'net.request',
        operation: event.method,
        target: redactUrl(reqUrl),
        status: event.status ?? null,
        started_at: startedAt,
        ended_at: endedAt,
        duration_ms: base.duration_ms,
        input: null,
        result: null,
        error: event.error ? String(event.error).slice(0, 500) : null,
        depth: 0
      }];
      break;
    }
    case 'dom.click':
    case 'dom.submit':
      base.action = event.type;
      base.actor = 'user';
      base.inputs = { selector: event.selector, text: (event.text || '').slice(0, 120) };
      break;
    case 'dom.input':
      base.action = 'dom.input';
      base.actor = 'user';
      if (settings.redactInputValues) {
        base.inputs = { selector: event.selector, value_length: event.valueLength ?? 0 };
      } else if (fieldIsSensitive(event.field)) {
        // "Record only length" is off, but this field is a password, card,
        // one-time-code, or credential-named input — never capture its value.
        base.inputs = { selector: event.selector, value: '[redacted]',
                        value_length: event.valueLength ?? 0 };
      } else {
        base.inputs = { selector: event.selector,
                        value: redactString(String(event.value ?? '')) };
      }
      break;
    case 'nav.spa':
      base.action = 'nav.spa';
      base.inputs = { from: redactUrl(event.from), to: redactUrl(event.to), mechanism: event.mechanism };
      break;
    case 'dom.mutation':
      base.action = 'dom.mutation';
      base.inputs = { nodes_added: event.added, nodes_removed: event.removed, window_ms: event.windowMs };
      break;
    default:
      base.action = 'browser.' + String(event.type);
      base.inputs = deepRedact(event.detail || {});
  }
  return base;
}
