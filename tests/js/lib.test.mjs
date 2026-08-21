// Node tests for the extension's pure functions. Adversarial cases first.
// Run: node --test tests/js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, normalizeSitePattern, patternMatchesUrl, urlIsTracked,
  projectForUrl, redactUrl, redactString, deepRedact, bodiesAllowedFor,
  redactBody, keyIsSensitive, fieldIsSensitive, buildRecord
} from '../../extension/lib.js';

const settings = (over = {}) => ({
  ...DEFAULT_SETTINGS, allowlist: [...DEFAULT_SETTINGS.allowlist], ...over
});

// ---- normalizeSitePattern: hostile and sloppy input ----

test('normalize strips scheme, path, query, case, userinfo', () => {
  assert.equal(normalizeSitePattern('HTTPS://App.Example.COM/x?y=1#z'), 'app.example.com');
  assert.equal(normalizeSitePattern('user:pass@example.com/x'), 'example.com');
  assert.equal(normalizeSitePattern('  domain.com  '), 'domain.com');
  assert.equal(normalizeSitePattern('127.0.0.1:3000'), '127.0.0.1:3000');
  assert.equal(normalizeSitePattern('ftp://files.example.com'), 'files.example.com');
});

test('normalize refuses junk', () => {
  assert.equal(normalizeSitePattern(''), null);
  assert.equal(normalizeSitePattern('   '), null);
  assert.equal(normalizeSitePattern('not a domain'), null);
  assert.equal(normalizeSitePattern('https://'), null);
  assert.equal(normalizeSitePattern(null), null);
  assert.equal(normalizeSitePattern(42), null);
  assert.equal(normalizeSitePattern('<script>alert(1)</script>'), null);
});

// ---- pattern matching ----

test('bare domain matches subdomains and any port, never lookalikes', () => {
  assert.ok(patternMatchesUrl('example.com', 'https://example.com/'));
  assert.ok(patternMatchesUrl('example.com', 'https://app.example.com/x'));
  assert.ok(patternMatchesUrl('example.com', 'http://example.com:8080/'));
  assert.ok(!patternMatchesUrl('example.com', 'https://badexample.com/'));
  assert.ok(!patternMatchesUrl('example.com', 'https://example.com.evil.io/'));
});

test('host:port pattern pins the exact app', () => {
  assert.ok(patternMatchesUrl('127.0.0.1:3000', 'http://127.0.0.1:3000/api'));
  assert.ok(!patternMatchesUrl('127.0.0.1:3000', 'http://127.0.0.1:8080/api'));
  assert.ok(!patternMatchesUrl('127.0.0.1:3000', 'http://127.0.0.1/api'));
});

test('non-http schemes and garbage URLs never match', () => {
  assert.ok(!patternMatchesUrl('example.com', 'chrome://extensions'));
  assert.ok(!patternMatchesUrl('example.com', 'file:///tmp/example.com'));
  assert.ok(!patternMatchesUrl('example.com', 'not a url'));
  assert.ok(!urlIsTracked('about:blank', settings()));
});

test('tracking honors enabled, captureAll, and defaults', () => {
  assert.ok(urlIsTracked('http://localhost:5173/', settings()));
  assert.ok(urlIsTracked('http://127.0.0.1:8631/demo', settings()));
  assert.ok(!urlIsTracked('https://example.com/', settings()));
  assert.ok(urlIsTracked('https://example.com/', settings({ captureAll: true })));
  assert.ok(!urlIsTracked('http://localhost:5173/', settings({ enabled: false })));
  assert.ok(!urlIsTracked('https://example.com/', settings({ captureAll: true, enabled: false })));
});

test('project key keeps the port so localhost apps stay separate', () => {
  assert.equal(projectForUrl('http://127.0.0.1:3000/x'), '127.0.0.1:3000');
  assert.equal(projectForUrl('https://example.com/x'), 'example.com');
  assert.equal(projectForUrl('nonsense'), 'unknown');
});

// ---- redaction: byte-exactness for survivors, masking for the rest ----

test('redactUrl masks credential params and only those, byte for byte', () => {
  const url = 'https://x.com/cb?state=a%20b&access_token=SECRET&flag&next=%2Fhome';
  const out = redactUrl(url);
  assert.equal(out, 'https://x.com/cb?state=a%20b&access_token=[redacted]&flag&next=%2Fhome');
  const clean = 'https://x.com/a?q=hello%20world&page=2';
  assert.equal(redactUrl(clean), clean); // untouched input returns byte-identical
});

test('redactUrl covers api_key, session, password, signature spellings', () => {
  assert.equal(redactUrl('https://x.com/?api_key=abc123'), 'https://x.com/?api_key=[redacted]');
  assert.equal(redactUrl('https://x.com/?SESSION=xyz'), 'https://x.com/?SESSION=[redacted]');
  assert.equal(redactUrl('https://x.com/?password=p'), 'https://x.com/?password=[redacted]');
  assert.equal(redactUrl('https://x.com/?X-Sig=abc'), 'https://x.com/?X-Sig=[redacted]');
});

test('redactString masks JWTs and Bearer tokens inside prose', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P';
  assert.equal(redactString(`saw ${jwt} in a log`), 'saw [redacted-jwt] in a log');
  assert.match(redactString('Authorization: Bearer abcdefghijklmnop1234'), /Bearer \[redacted\]/);
  assert.equal(redactString('plain text stays'), 'plain text stays');
});

test('deepRedact masks sensitive keys at any depth and inside arrays', () => {
  const out = deepRedact({
    user: 'mo', password: 'hunter2',
    nested: { api_key: 'k', list: [{ token: 't', ok: 1 }] }
  });
  assert.equal(out.user, 'mo');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.nested.api_key, '[redacted]');
  assert.equal(out.nested.list[0].token, '[redacted]');
  assert.equal(out.nested.list[0].ok, 1);
});

// ---- H2: key-name matching is word-aware, not substring ----

test('credential key-name families mask, including the ones the old list missed', () => {
  for (const name of ['key', 'api_key', 'apiKey', 'access_key', 'accessKey',
    'private_key', 'privateKey', 'signing_key', 'secret_key', 'session_id',
    'refresh_token', 'client_secret', 'X-Api-Key', 'PASSWORD', 'passphrase',
    'otp', 'mfa_code', 'pin']) {
    assert.ok(keyIsSensitive(name), `${name} should be sensitive`);
  }
});

test('innocent names that merely contain credential letters do NOT mask', () => {
  // These contain credential *letters* but no credential *word*, so they stay.
  for (const name of ['monkey', 'keyboard', 'hotkey', 'keyword', 'donkey',
    'shipping', 'mapping', 'spinner', 'options', 'description', 'signal',
    'keynote', 'turnkey', 'authored']) {
    assert.ok(!keyIsSensitive(name), `${name} should NOT be masked`);
  }
});

test('deepRedact masks access_key/private_key, which the old substring list leaked', () => {
  const out = deepRedact({
    access_key: 'AKIAIOSFODNN7EXAMPLE',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
    signing_key: 'whatever', monkey: 'business'
  });
  assert.equal(out.access_key, '[redacted]');
  assert.equal(out.private_key, '[redacted]');
  assert.equal(out.signing_key, '[redacted]');
  assert.equal(out.monkey, 'business'); // not over-redacted
});

// ---- H2: value-shape masking, in strings and URL paths ----

test('redactString masks AWS, Stripe, Google-OAuth, and PEM shapes', () => {
  assert.match(redactString('id AKIAIOSFODNN7EXAMPLE here'), /\[redacted-key\]/);
  assert.match(redactString('sk_live_abcdef1234567890ABCD'), /\[redacted-key\]/);
  assert.match(redactString('rk_test_abcdef1234567890ABCD'), /\[redacted-key\]/);
  assert.match(redactString('token ya29.a0AfabcdefghijklmnopQRST'), /\[redacted-key\]/);
  assert.equal(redactString('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'),
    '[redacted-private-key]');
  assert.equal(redactString('an aws region us-east-1 stays'), 'an aws region us-east-1 stays');
});

test('provider keys mask when glued to preceding text via _ or -, not just whole-string', () => {
  // A key hidden inside a larger string, glued after an underscore, must mask.
  assert.match(redactString('johnny at a cat_sk-live-123ABD456xyzBesides drank juice'),
    /cat_\[redacted-key\]/);
  assert.match(redactString('prefix_sk_live_123ABD456xyzABCDEFGH suffix'), /\[redacted-key\]/);
  assert.match(redactString('x-AKIAIOSFODNN7EXAMPLE-y'), /\[redacted-key\]/);
  // Under a completely random field name, the value shape still masks it.
  assert.equal(deepRedact({ cat_food: 'sk_live_123ABD456xyzABCDEFGH' }).cat_food, '[redacted-key]');
  assert.equal(deepRedact({ whatever: 'AKIAIOSFODNN7EXAMPLE' }).whatever, '[redacted-key]');
});

test('the lookbehind does not false-positive on words ending in a key prefix', () => {
  for (const s of ['risk-management-team-lead-2024-planning',
    'a brisk-walk-in-the-park-today-felt-good', 'taskkey-rotation-schedule-weekly']) {
    assert.equal(redactString(s), s, `${s} was wrongly redacted`);
  }
});

test('redactUrl masks a secret in the PATH, not just the query', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P';
  assert.equal(redactUrl(`https://app.test/reset/${jwt}`), 'https://app.test/reset/[redacted-jwt]');
  assert.match(redactUrl('https://app.test/callback/sk-abcdef1234567890abcd'), /\[redacted-key\]/);
  const clean = 'https://app.test/orders/12345?page=2';
  assert.equal(redactUrl(clean), clean); // ordinary path ids untouched
});

// ---- body redaction: the exact leak class is JSON bodies carrying keys ----

test('JSON request bodies mask credential-named fields at any depth', () => {
  const body = JSON.stringify({
    provider: 'openai', api_key: 'sk-proj-abcdef1234567890abcdef',
    nested: { config: { secret: 'hunter2' }, list: [{ token: 't0k3n' }] }
  });
  const out = JSON.parse(redactBody(body));
  assert.equal(out.api_key, '[redacted]');
  assert.equal(out.nested.config.secret, '[redacted]');
  assert.equal(out.nested.list[0].token, '[redacted]');
  assert.equal(out.provider, 'openai');
});

test('provider-shaped key values are masked even under innocent field names', () => {
  const out = JSON.parse(redactBody(JSON.stringify(
    { value: 'sk-ant-api03-abcdef1234567890', note: 'AIzaSyA1234567890abcdefghijklmnopqrs' })));
  assert.equal(out.value, '[redacted-key]');
  assert.equal(out.note, '[redacted-key]');
});

test('truncated JSON and form-encoded bodies still mask key shapes', () => {
  const truncated = '{"api_key": "sk-abcdef1234567890abcd", "more": "…[+900 chars]';
  assert.ok(!redactBody(truncated).includes('sk-abcdef'), 'truncated JSON leaked');
  const form = 'api_key=sk-abcdef1234567890abcd&user=mo';
  const out = redactBody(form);
  assert.ok(!out.includes('sk-abcdef'), 'form body leaked');
  assert.ok(out.includes('user=mo'), 'unrelated field rewritten');
});

test('a clean JSON body passes through byte-identical', () => {
  const clean = '{"query":  "hello",\n "page": 2}'; // odd spacing survives untouched
  assert.equal(redactBody(clean), clean);
  const plain = 'just some text';
  assert.equal(redactBody(plain), plain);
});

test('bodies flow through redactBody in net records end to end', () => {
  const rec = buildRecord({ type: 'net', via: 'fetch', method: 'POST',
    reqUrl: 'http://127.0.0.1:3000/api/settings/models', status: 200,
    reqBody: '{"provider":"anthropic","api_key":"sk-ant-abcdef1234567890"}',
    resBody: '{"ok":true,"models":["a"]}',
    t0: 1, t1: 2, url: 'http://127.0.0.1:3000/' }, tab, identity, settings());
  assert.ok(!JSON.stringify(rec).includes('sk-ant-abcdef'), 'key reached the record');
  assert.equal(JSON.parse(rec.inputs.request_body).api_key, '[redacted]');
  assert.equal(rec.outputs.response_body, '{"ok":true,"models":["a"]}');
});

test('bodies default to localhost apps only', () => {
  const s = settings();
  assert.ok(bodiesAllowedFor('http://localhost:3000/api', s));
  assert.ok(bodiesAllowedFor('http://127.0.0.1:8000/api', s));
  assert.ok(!bodiesAllowedFor('https://example.com/api', s));
  assert.ok(bodiesAllowedFor('https://example.com/api', settings({ captureBodies: 'always' })));
  assert.ok(!bodiesAllowedFor('http://localhost:3000/api', settings({ captureBodies: 'never' })));
});

// ---- record building against the traceact 1.0.0 shape ----

const tab = { id: 7, windowId: 2, title: 'My app', url: 'http://127.0.0.1:3000/' };
const identity = { clientId: 'cli_abc', label: 'Chrome' };

const REQUIRED_FIELDS = [
  'trace_id', 'root_trace_id', 'parent_trace_id', 'upstream_trace_id',
  'correlation_id', 'project', 'action', 'kind', 'actor', 'status',
  'budget_hit', 'sampled_out', 'started_at', 'ended_at', 'duration_ms',
  'inputs', 'steps', 'events', 'touches', 'outputs', 'errors',
  'child_summaries', 'meta'
];

test('every record carries the full traceact field set and identity meta', () => {
  const rec = buildRecord({ type: 'console', level: 'log', args: ['hi'],
    t: Date.now(), url: tab.url, pageLoadId: 'pl_1' }, tab, identity, settings());
  for (const field of REQUIRED_FIELDS) assert.ok(field in rec, `missing ${field}`);
  assert.match(rec.trace_id, /^trc_[0-9a-f]{12}$/);
  assert.equal(rec.root_trace_id, rec.trace_id);
  assert.equal(rec.project, '127.0.0.1:3000');
  assert.equal(rec.correlation_id, 'pl_1');
  assert.equal(rec.meta.tab_id, 7);
  assert.equal(rec.meta.window_id, 2);
  assert.equal(rec.meta.browser, 'Chrome');
  assert.equal(rec.meta.page_load_id, 'pl_1');
});

test('project anchors to the trusted tab url, not a page-forged event url', () => {
  // A hostile page posts an event claiming to belong to another app.
  const forged = buildRecord({ type: 'console', level: 'log', args: ['x'],
    url: 'http://127.0.0.1:9999/', t: 1 }, tab, identity, settings());
  assert.equal(forged.project, '127.0.0.1:3000'); // tab.url wins, not event.url
  // A webRequest event (background-emitted) legitimately uses event.url.
  const nav = buildRecord({ type: 'net', via: 'webRequest:main_frame', method: 'GET',
    reqUrl: 'http://127.0.0.1:5173/app', status: 200,
    url: 'http://127.0.0.1:5173/app', t0: 1, t1: 2 },
    { ...tab, url: '' }, identity, settings());
  assert.equal(nav.project, '127.0.0.1:5173');
});

test('console.error and page errors report failed status', () => {
  const err = buildRecord({ type: 'console', level: 'error', args: ['x'], t: 1 },
    tab, identity, settings());
  assert.equal(err.status, 'failed');
  const pageErr = buildRecord({ type: 'page.error', message: 'boom',
    stack: 'Error: boom\n  at x', errorType: 'TypeError', t: 1 }, tab, identity, settings());
  assert.equal(pageErr.status, 'failed');
  assert.equal(pageErr.errors[0].type, 'TypeError');
});

test('net records carry status, one net event, and gated bodies', () => {
  const local = buildRecord({ type: 'net', via: 'fetch', method: 'POST',
    reqUrl: 'http://127.0.0.1:3000/api?token=s', status: 404,
    reqBody: '{"password":"p"}', resBody: '{"err":1}',
    t0: 1000, t1: 1250 }, tab, identity, settings());
  assert.equal(local.status, 'failed');
  assert.equal(local.duration_ms, 250);
  assert.equal(local.inputs.url, 'http://127.0.0.1:3000/api?token=[redacted]');
  assert.equal(local.inputs.request_body, '{"password":"[redacted]"}'); // JSON bodies get key-name masking
  assert.equal(local.events.length, 1);
  assert.equal(local.events[0].kind, 'net');
  assert.equal(local.events[0].status, 404);

  const remote = buildRecord({ type: 'net', via: 'fetch', method: 'GET',
    reqUrl: 'https://example.com/api', status: 200, resBody: '{"a":1}',
    t0: 1, t1: 2, url: 'https://example.com/' }, tab, identity, settings());
  assert.ok(!('response_body' in remote.outputs)); // public site, bodies off by default
});

test('relative request URLs resolve against the page before gating and recording', () => {
  const rec = buildRecord({ type: 'net', via: 'fetch', method: 'GET',
    reqUrl: '/api/ok', status: 200, resBody: '{"ok":true}',
    t0: 1, t1: 2, url: 'http://127.0.0.1:3000/page' }, tab, identity, settings());
  assert.equal(rec.inputs.url, 'http://127.0.0.1:3000/api/ok');
  assert.equal(rec.outputs.response_body, '{"ok":true}'); // localhost gate sees the resolved URL
  assert.equal(rec.events[0].target, 'http://127.0.0.1:3000/api/ok');
});

// ---- M3: sensitive fields aren't captured even with length-only off ----

test('fieldIsSensitive flags password, card, otp, and credential-named fields', () => {
  assert.ok(fieldIsSensitive({ type: 'password' }));
  assert.ok(fieldIsSensitive({ autocomplete: 'current-password' }));
  assert.ok(fieldIsSensitive({ autocomplete: 'one-time-code' }));
  assert.ok(fieldIsSensitive({ autocomplete: 'cc-number' }));
  assert.ok(fieldIsSensitive({ name: 'api_key' }));
  assert.ok(fieldIsSensitive({ id: 'user-ssn' }));
  assert.ok(fieldIsSensitive({ name: 'card_number' }));
  assert.ok(fieldIsSensitive({ id: 'otp' }));
});

test('fieldIsSensitive leaves ordinary fields alone', () => {
  for (const f of [{ type: 'text', name: 'search' }, { type: 'email', name: 'email' },
    { name: 'monkey' }, { id: 'keyboard-shortcut' }, { name: 'message' },
    { type: 'text', name: 'city' }, {}]) {
    assert.ok(!fieldIsSensitive(f), JSON.stringify(f));
  }
});

test('length-only OFF still redacts a credential-named field value', () => {
  const s = settings({ redactInputValues: false });
  const secret = buildRecord({ type: 'dom.input', selector: '#k', value: 'sk-live-xyz',
    valueLength: 11, field: { type: 'text', name: 'api_key' }, t: 1 }, tab, identity, s);
  assert.equal(secret.inputs.value, '[redacted]');
  const card = buildRecord({ type: 'dom.input', selector: '#c', value: '4111111111111111',
    valueLength: 16, field: { autocomplete: 'cc-number' }, t: 1 }, tab, identity, s);
  assert.equal(card.inputs.value, '[redacted]');
  const ordinary = buildRecord({ type: 'dom.input', selector: '#q', value: 'hello world',
    valueLength: 11, field: { type: 'text', name: 'search' }, t: 1 }, tab, identity, s);
  assert.equal(ordinary.inputs.value, 'hello world'); // captured, as the toggle intends
});

test('input records respect the redaction toggle', () => {
  const redacted = buildRecord({ type: 'dom.input', selector: '#email',
    value: 'mo@example.com', valueLength: 14, t: 1 }, tab, identity, settings());
  assert.deepEqual(redacted.inputs, { selector: '#email', value_length: 14 });
  const open = buildRecord({ type: 'dom.input', selector: '#email',
    value: 'mo@example.com', valueLength: 14, t: 1 }, tab, identity,
    settings({ redactInputValues: false }));
  assert.equal(open.inputs.value, 'mo@example.com');
});

test('interactions are user-actor; unknown types degrade, never throw', () => {
  const click = buildRecord({ type: 'dom.click', selector: 'button.save',
    text: 'Save', t: 1 }, tab, identity, settings());
  assert.equal(click.actor, 'user');
  const odd = buildRecord({ type: 'mystery', detail: { a: 1 }, t: 1 },
    tab, identity, settings());
  assert.equal(odd.action, 'browser.mystery');
});
