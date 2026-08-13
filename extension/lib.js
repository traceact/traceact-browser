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
  /([?&][^=&#]*(?:token|key|secret|password|passwd|auth|session|signature|sig|credential|code)[^=&#]*=)[^&#]*/gi;

// Masks credential-looking query values in place. The rest of the URL passes
// through byte for byte; nothing is parsed and re-serialized.
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(SENSITIVE_PARAM, '$1[redacted]');
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi;

export function redactString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(JWT_RE, '[redacted-jwt]').replace(BEARER_RE, '$1[redacted]');
}

const SENSITIVE_KEY =
  /(token|secret|password|passwd|credential|api[_-]?key|auth|session|cookie)/i;

// Walks a serialized value and masks anything credential-shaped: sensitive
// key names entirely, JWT/Bearer patterns inside strings, and URLs' query
// values. Depth-capped because the input is already depth-capped upstream.
export function deepRedact(value, depth = 6) {
  if (depth <= 0) return value;
  if (typeof value === 'string') return redactString(redactUrl(value));
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth - 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : deepRedact(v, depth - 1);
    }
    return out;
  }
  return value;
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
  const base = {
    trace_id: newTraceId(),
    root_trace_id: null,
    parent_trace_id: null,
    upstream_trace_id: null,
    correlation_id: event.pageLoadId || null,
    project: projectForUrl(event.url || tab.url),
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
        base.inputs.request_body = deepRedact(event.reqBody);
      }
      base.outputs = { status: event.status ?? null };
      if (event.resBody !== undefined && bodiesAllowedFor(reqUrl, settings)) {
        base.outputs.response_body = deepRedact(event.resBody);
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
      base.inputs = settings.redactInputValues
        ? { selector: event.selector, value_length: event.valueLength ?? 0 }
        : { selector: event.selector, value: redactString(String(event.value ?? '')) };
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
