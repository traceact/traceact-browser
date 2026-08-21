// Background service worker: the one place that decides what's tracked,
// builds traceact records, talks to the relay, and answers commands
// (focus a tab, snapshot a DOM).

import {
  DEFAULT_SETTINGS, RELAY_PORT_START, RELAY_PORT_ATTEMPTS,
  urlIsTracked, buildRecord, redactUrl, projectForUrl
} from './lib.js';

const FLUSH_MS = 2000;
const MAX_QUEUE = 2000;
const NATIVE_HOST = 'com.traceact.browser';

let settings = { ...DEFAULT_SETTINGS };
let identity = { clientId: '', label: '' };
let relayPort = 0;          // 0 until probed
let relayOk = false;
let queue = [];
let polling = false;

// ---- settings and identity ----

async function loadState() {
  const stored = await chrome.storage.local.get(['settings', 'clientId']);
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  let clientId = stored.clientId;
  if (!clientId) {
    clientId = 'cli_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    await chrome.storage.local.set({ clientId });
  }
  identity = { clientId, label: settings.browserLabel || (await detectBrowserLabel()) };
}

async function detectBrowserLabel() {
  // Brave ships the Brave brand in userAgentData; plain Chrome doesn't.
  try {
    const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
    if (brands.some((b) => /brave/i.test(b))) return 'Brave';
    if (brands.some((b) => /chromium/i.test(b)) && !brands.some((b) => /chrome/i.test(b))) return 'Chromium';
  } catch {}
  return 'Chrome';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    identity.label = settings.browserLabel || identity.label;
    refreshAllBadges();
  }
});

// ---- relay discovery and delivery ----

async function probeRelay() {
  const start = settings.relayPort || RELAY_PORT_START;
  const attempts = settings.relayPort ? 1 : RELAY_PORT_ATTEMPTS;
  for (let port = start; port < start + attempts; port++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`,
        { signal: AbortSignal.timeout(700) });
      const health = await resp.json();
      if (health.app === 'traceact-browser') {
        relayPort = port;
        relayOk = true;
        return true;
      }
    } catch {}
  }
  relayOk = false;
  return false;
}

async function flushQueue() {
  if (!queue.length) return;
  if (!relayOk && !(await probeRelay())) return; // keep buffering, capped below
  const batch = queue;
  queue = [];
  try {
    const resp = await fetch(`http://127.0.0.1:${relayPort}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch })
    });
    if (!resp.ok) throw new Error('ingest ' + resp.status);
  } catch {
    relayOk = false;
    queue = batch.concat(queue).slice(-MAX_QUEUE); // keep the newest on overflow
  }
}

function enqueue(record) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(record);
}

// ---- capture: events from content scripts ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'tab-events' && sender.tab) {
    const tab = sender.tab;
    if (urlIsTracked(tab.url || '', settings)) {
      for (const event of message.events) {
        enqueue(buildRecord(event, tab, identity, settings));
      }
    }
    sendResponse({});
    return false;
  }
  if (message?.type === 'is-tracked') {
    // content.js asks so page.js can skip capture work on untracked pages.
    // The gate here (onMessage above, and the flush) stays authoritative;
    // this is only an optimization hint.
    sendResponse({ tracked: urlIsTracked(sender.tab?.url || '', settings) });
    return false;
  }
  if (message?.type === 'popup') {
    handlePopup(message).then(sendResponse);
    return true; // async response
  }
  return false;
});

// ---- capture: webRequest metadata for everything page.js can't wrap ----
// fetch and XHR already arrive with timing and bodies from the page world,
// so their webRequest type (xmlhttprequest) is skipped to avoid doubles.

const WEB_REQUEST_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script',
  'image', 'font', 'media', 'websocket', 'other'];
const requestStarts = new Map();

chrome.webRequest.onBeforeRequest.addListener((details) => {
  requestStarts.set(details.requestId, details.timeStamp);
  if (requestStarts.size > 5000) requestStarts.clear(); // stale-entry safety valve
}, { urls: ['<all_urls>'], types: WEB_REQUEST_TYPES });

async function webRequestRecord(details, error) {
  if (details.tabId < 0) return;
  let tab;
  try { tab = await chrome.tabs.get(details.tabId); } catch { return; }
  // For the page load itself, tab.url can still be the previous page when
  // onCompleted fires; the request's own URL is the one being navigated to.
  const gateUrl = details.type === 'main_frame' ? details.url : (tab.url || details.url);
  if (!urlIsTracked(gateUrl, settings)) return;
  const t0 = requestStarts.get(details.requestId) ?? details.timeStamp;
  requestStarts.delete(details.requestId);
  const event = {
    type: 'net', via: 'webRequest:' + details.type,
    method: details.method, reqUrl: details.url,
    status: details.statusCode, error,
    t0, t1: details.timeStamp,
    // For the page load itself, tab.url can still be blank; the request's
    // own URL is what names the project correctly.
    url: tab.url || details.url, pageLoadId: null
  };
  enqueue(buildRecord(event, tab, identity, settings));
}

chrome.webRequest.onCompleted.addListener(
  (d) => { webRequestRecord(d); },
  { urls: ['<all_urls>'], types: WEB_REQUEST_TYPES });
chrome.webRequest.onErrorOccurred.addListener(
  (d) => { webRequestRecord(d, d.error); },
  { urls: ['<all_urls>'], types: WEB_REQUEST_TYPES });

// ---- badge: per-tab recording state, always visible ----

async function refreshBadge(tabId, url) {
  const tracked = urlIsTracked(url || '', settings);
  try {
    await chrome.action.setBadgeText({ tabId, text: tracked ? 'ON' : '' });
    if (tracked) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' });
    }
  } catch {}
}

async function refreshAllBadges() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) refreshBadge(tab.id, tab.url);
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'loading') refreshBadge(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const tab = await chrome.tabs.get(tabId); refreshBadge(tabId, tab.url); } catch {}
});

// ---- command channel: long-poll the relay, run focus and snapshot ----

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (relayOk || (await probeRelay())) {
      let payload;
      try {
        const resp = await fetch(
          `http://127.0.0.1:${relayPort}/pull?client=${identity.clientId}` +
          `&label=${encodeURIComponent(identity.label)}&wait=25`,
          { signal: AbortSignal.timeout(30000) });
        payload = await resp.json();
      } catch {
        relayOk = false;
        break;
      }
      for (const command of payload.commands || []) {
        runCommand(command); // deliberately not awaited; results post independently
      }
    }
  } finally {
    polling = false;
  }
}

async function runCommand(command) {
  let result;
  try {
    if (command.type === 'focus') result = await doFocus(command);
    else if (command.type === 'snapshot') result = await doSnapshot(command);
    else result = { ok: false, error: 'unknown command type' };
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  try {
    await fetch(`http://127.0.0.1:${relayPort}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: command.id, ...result })
    });
  } catch {}
}

async function doFocus(command) {
  if (typeof command.tab_id !== 'number') return { ok: false, error: 'no tab_id on record' };
  await chrome.tabs.update(command.tab_id, { active: true });
  if (typeof command.window_id === 'number') {
    await chrome.windows.update(command.window_id, { focused: true });
  }
  return { ok: true };
}

async function doSnapshot(command) {
  let tabId = command.tab_id;
  if (typeof tabId !== 'number') {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active) return { ok: false, error: 'no active tab' };
    tabId = active.id;
  }
  const tab = await chrome.tabs.get(tabId);
  if (!urlIsTracked(tab.url || '', settings)) {
    return { ok: false, error: 'tab isn\'t tracked; allow its site first' };
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: snapshotInPage,
    args: [command.selector || null, !!command.exists, settings.redactInputValues]
  });
  const value = injection?.result;
  if (!value) return { ok: false, error: 'snapshot script returned nothing' };
  return { ok: true, tab_id: tabId, url: redactUrl(tab.url || ''),
           project: projectForUrl(tab.url || ''), ...value };
}

// Serialized into the tab; must stay self-contained.
function snapshotInPage(selector, existsOnly, redactValues) {
  const MAX_TOTAL = 200000;
  const cleanClone = (el) => {
    const clone = el.cloneNode(true);
    const scrub = (root) => {
      root.querySelectorAll('script').forEach((s) => { s.textContent = ''; });
      if (redactValues) {
        root.querySelectorAll('input, textarea').forEach((i) => {
          if (i.value) i.setAttribute('value', '[redacted]');
          if (i.tagName === 'TEXTAREA') i.textContent = '[redacted]';
        });
      }
    };
    scrub(clone);
    return clone.outerHTML;
  };
  if (selector) {
    let nodes;
    try { nodes = document.querySelectorAll(selector); }
    catch { return { ok: false, error: 'selector didn\'t parse' }; }
    if (existsOnly) return { ok: true, matches: nodes.length };
    const html = [];
    let total = 0;
    for (const node of Array.from(nodes).slice(0, 5)) {
      const s = cleanClone(node);
      total += s.length;
      if (total > MAX_TOTAL) { html.push('[truncated: size cap]'); break; }
      html.push(s);
    }
    return { ok: true, matches: nodes.length, html };
  }
  if (existsOnly) return { ok: true, matches: document.documentElement ? 1 : 0 };
  let full = cleanClone(document.documentElement);
  if (full.length > MAX_TOTAL) full = full.slice(0, MAX_TOTAL) + '…[truncated]';
  return { ok: true, matches: 1, html: [full] };
}

// ---- popup API ----

async function handlePopup(message) {
  if (message.op === 'status') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!relayOk) await probeRelay();
    let health = null;
    if (relayOk) {
      try {
        health = await (await fetch(`http://127.0.0.1:${relayPort}/health`,
          { signal: AbortSignal.timeout(700) })).json();
      } catch { relayOk = false; }
    }
    return {
      url: tab?.url || '', tabId: tab?.id,
      tracked: urlIsTracked(tab?.url || '', settings),
      settings,
      relay: relayOk ? { ok: true, port: relayPort, dataFile: health?.data_file } : { ok: false },
      startCommand: 'traceact-browser'
    };
  }
  if (message.op === 'toggle-site') {
    const { pattern, add } = message;
    const list = settings.allowlist.filter((p) => p !== pattern);
    if (add) list.push(pattern);
    settings = { ...settings, allowlist: list };
    await chrome.storage.local.set({ settings });
    refreshAllBadges();
    return { ok: true, allowlist: list };
  }
  if (message.op === 'clear-traces') {
    if (!relayOk && !(await probeRelay())) return { ok: false, error: 'relay not running' };
    try {
      const resp = await fetch(`http://127.0.0.1:${relayPort}/clear`, { method: 'POST' });
      return await resp.json();
    } catch {
      relayOk = false;
      return { ok: false, error: 'relay not reachable' };
    }
  }
  if (message.op === 'restart-relay') {
    return new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'start' }, (reply) => {
        if (chrome.runtime.lastError || !reply) {
          resolve({ ok: false, error: 'native host not registered' });
          return;
        }
        if (reply.ok) { probeRelay().then(() => pollLoop()); }
        resolve(reply);
      });
    });
  }
  return { ok: false, error: 'unknown op' };
}

// ---- lifecycle ----

async function boot() {
  await loadState();
  await probeRelay();
  refreshAllBadges();
  pollLoop();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();

// The alarm keeps the flush and the poll loop alive across service-worker
// suspensions; an in-flight long-poll usually holds the worker up, and the
// alarm restarts everything when it doesn't.
chrome.alarms.create('tab-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tab-heartbeat') {
    flushQueue();
    pollLoop();
  }
});
setInterval(flushQueue, FLUSH_MS);
