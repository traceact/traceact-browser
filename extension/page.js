// Runs in the page's own world (MAIN) so it can see what the page sees:
// console calls, uncaught errors, fetch/XHR, interactions, SPA navigation.
// It buffers events in a capped ring and posts batches to content.js, which
// forwards them to the background worker. It never touches the network or
// storage itself, and it captures on every page; the background worker is
// the one place that decides whether a site is tracked and drops the rest.
(() => {
  'use strict';
  if (window.__traceactBrowserPage) return;
  window.__traceactBrowserPage = true;

  const MARKER = 'traceact-browser:v1';
  const MAX_PENDING = 500;
  const FLUSH_MS = 400;
  const MAX_STR = 2000;
  const MAX_BODY = 65536;

  const pageLoadId = 'pl_' + Math.random().toString(16).slice(2, 14);
  let pending = [];
  let dropped = 0;

  const push = (event) => {
    if (pending.length >= MAX_PENDING) { dropped++; return; }
    event.pageLoadId = pageLoadId;
    event.url = location.href;
    if (event.t === undefined && event.t0 === undefined) event.t = Date.now();
    pending.push(event);
  };

  const flush = () => {
    if (!pending.length) return;
    if (dropped) {
      pending.push({ type: 'console', level: 'warn', t: Date.now(),
                     args: [`traceact-browser: ${dropped} events dropped (burst over ${MAX_PENDING})`],
                     pageLoadId, url: location.href });
      dropped = 0;
    }
    const batch = pending;
    pending = [];
    window.postMessage({ __tab: MARKER, events: batch }, location.origin);
  };
  setInterval(flush, FLUSH_MS);
  addEventListener('pagehide', flush);

  // ---- serialization: bounded, circular-safe, page-value tolerant ----

  const serialize = (value, depth = 3, seen = new WeakSet()) => {
    const t = typeof value;
    if (value === null || t === 'number' || t === 'boolean') return value;
    if (t === 'string') return value.length > MAX_STR ? value.slice(0, MAX_STR) + '…' : value;
    if (t === 'undefined') return '[undefined]';
    if (t === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (t === 'symbol' || t === 'bigint') return String(value);
    if (value instanceof Error) {
      return { __error: value.name, message: serialize(value.message, 1),
               stack: String(value.stack || '').slice(0, MAX_STR) };
    }
    if (value instanceof Node) {
      return '[node ' + (value.nodeName || '?').toLowerCase() +
             (value.id ? '#' + value.id : '') + ']';
    }
    if (depth <= 0) return Array.isArray(value) ? '[array]' : '[object]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const out = value.slice(0, 20).map((v) => serialize(v, depth - 1, seen));
        if (value.length > 20) out.push(`[+${value.length - 20} more]`);
        return out;
      }
      const out = {};
      let n = 0;
      for (const k of Object.keys(value)) {
        if (++n > 20) { out['…'] = '[more keys]'; break; }
        out[k] = serialize(value[k], depth - 1, seen);
      }
      return out;
    } catch {
      return '[unserializable]';
    } finally {
      seen.delete(value);
    }
  };

  const selectorFor = (el) => {
    if (!(el instanceof Element)) return '(not an element)';
    const parts = [];
    let node = el;
    for (let i = 0; node && node instanceof Element && i < 4; i++) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      let part = node.tagName.toLowerCase();
      const cls = (node.className && typeof node.className === 'string')
        ? node.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      if (cls) part += '.' + cls;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  // ---- console ----

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try { push({ type: 'console', level, args: args.map((a) => serialize(a)) }); } catch {}
      return original(...args);
    };
  }

  // ---- errors ----

  addEventListener('error', (e) => {
    // Resource load errors (a broken <img>) also fire 'error'; only script
    // errors carry a message.
    if (!e.message && !(e.error instanceof Error)) return;
    push({ type: 'page.error',
           errorType: e.error && e.error.name ? e.error.name : 'Error',
           message: e.message || (e.error && e.error.message) || '',
           stack: e.error && e.error.stack ? e.error.stack : '' });
  }, true);

  addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    push({ type: 'page.rejection',
           errorType: reason && reason.name ? reason.name : 'UnhandledRejection',
           message: reason && reason.message ? reason.message : String(reason).slice(0, MAX_STR),
           stack: reason && reason.stack ? reason.stack : '' });
  });

  // ---- fetch and XHR, with bodies capped and content-type gated ----

  const textIsh = (ct) => /json|text|xml|x-www-form-urlencoded/i.test(ct || '');
  const capBody = (s) => (typeof s === 'string' && s.length > MAX_BODY)
    ? s.slice(0, MAX_BODY) + `…[+${s.length - MAX_BODY} chars]` : s;

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const t0 = Date.now();
    let reqUrl = typeof input === 'string' ? input
      : (input instanceof Request ? input.url : String(input));
    try { reqUrl = new URL(reqUrl, location.href).href; } catch {}
    const method = ((init && init.method) ||
      (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let reqBody;
    if (init && typeof init.body === 'string') reqBody = capBody(init.body);
    try {
      const response = await origFetch(input, init);
      let resBody;
      try {
        if (textIsh(response.headers.get('content-type'))) {
          resBody = capBody(await response.clone().text());
        }
      } catch {} // an opaque or locked body stays uncaptured, never breaks the page
      push({ type: 'net', via: 'fetch', method, reqUrl, reqBody, resBody,
             status: response.status, t0, t1: Date.now() });
      return response;
    } catch (err) {
      push({ type: 'net', via: 'fetch', method, reqUrl, reqBody,
             error: err && err.message ? err.message : String(err), t0, t1: Date.now() });
      throw err;
    }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    let absolute = String(url);
    try { absolute = new URL(absolute, location.href).href; } catch {}
    this.__tab = { method: String(method).toUpperCase(), reqUrl: absolute };
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__tab;
    if (info) {
      info.t0 = Date.now();
      if (typeof body === 'string') info.reqBody = capBody(body);
      this.addEventListener('loadend', () => {
        let resBody;
        try {
          if (textIsh(this.getResponseHeader('content-type')) &&
              (this.responseType === '' || this.responseType === 'text')) {
            resBody = capBody(this.responseText);
          }
        } catch {}
        push({ type: 'net', via: 'xhr', method: info.method, reqUrl: info.reqUrl,
               reqBody: info.reqBody, resBody,
               status: this.status || undefined,
               error: this.status === 0 ? 'network error or aborted' : undefined,
               t0: info.t0, t1: Date.now() });
      });
    }
    return origSend.call(this, body);
  };

  // ---- interactions ----

  addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('a,button,[role=button],input,label,select,summary') || e.target : e.target;
    push({ type: 'dom.click', selector: selectorFor(el),
           text: el instanceof Element ? (el.textContent || '').trim().slice(0, 120) : '' });
  }, true);

  addEventListener('submit', (e) => {
    push({ type: 'dom.submit', selector: selectorFor(e.target) });
  }, true);

  // Inputs are debounced per element so typing a sentence is one event,
  // not one per keystroke. The value ships too; the background worker
  // drops it unless the person turned redaction off.
  const inputTimers = new WeakMap();
  addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(() => {
      const value = el.type === 'password' ? '' : String(el.value);
      push({ type: 'dom.input', selector: selectorFor(el),
             valueLength: el.value.length, value });
    }, 600));
  }, true);

  // ---- SPA navigation ----

  let lastHref = location.href;
  const navEvent = (mechanism) => {
    if (location.href === lastHref) return;
    push({ type: 'nav.spa', from: lastHref, to: location.href, mechanism });
    lastHref = location.href;
  };
  const origPush = history.pushState.bind(history);
  history.pushState = (...a) => { const r = origPush(...a); navEvent('pushState'); return r; };
  const origReplace = history.replaceState.bind(history);
  history.replaceState = (...a) => { const r = origReplace(...a); navEvent('replaceState'); return r; };
  addEventListener('popstate', () => navEvent('popstate'));
  addEventListener('hashchange', () => navEvent('hashchange'));

  // ---- DOM mutation summaries: counts per window, never node contents ----

  let added = 0, removed = 0, windowStart = 0;
  const observer = new MutationObserver((mutations) => {
    if (!windowStart) windowStart = Date.now();
    for (const m of mutations) {
      added += m.addedNodes.length;
      removed += m.removedNodes.length;
    }
  });
  const startObserver = () => {
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  };
  startObserver();
  document.addEventListener('DOMContentLoaded', startObserver);
  setInterval(() => {
    if (!added && !removed) return;
    push({ type: 'dom.mutation', added, removed,
           windowMs: Date.now() - windowStart });
    added = 0; removed = 0; windowStart = 0;
  }, 2000);
})();
