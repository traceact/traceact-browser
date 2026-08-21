// Options page: hot-saves every change straight into chrome.storage.

import { DEFAULT_SETTINGS, normalizeSitePattern } from '../lib.js';

const el = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };

async function save() {
  await chrome.storage.local.set({ settings });
  const saved = el('saved');
  saved.style.visibility = 'visible';
  setTimeout(() => { saved.style.visibility = 'hidden'; }, 1200);
}

// Everything that only means something while capture runs greys out when
// capture is off; the master switch itself and this-browser settings stay live.
const CAPTURE_DEPENDENT = ['capture-all', 'redact-inputs', 'bodies', 'add-input'];

function applyEnabledState() {
  const off = !settings.enabled;
  for (const id of CAPTURE_DEPENDENT) el(id).disabled = off;
  for (const button of document.querySelectorAll('#allowlist button, #add-form button')) {
    button.disabled = off;
  }
  for (const section of document.querySelectorAll('.capture-dependent')) {
    section.style.opacity = off ? '0.45' : '';
  }
}

function renderAllowlist() {
  const list = el('allowlist');
  list.textContent = '';
  if (!settings.allowlist.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing tracked yet — add a site below.';
    list.appendChild(li);
  }
  for (const pattern of settings.allowlist) {
    const li = document.createElement('li');
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.onclick = async () => {
      settings.allowlist = settings.allowlist.filter((p) => p !== pattern);
      renderAllowlist();
      await save();
    };
    const span = document.createElement('span');
    span.textContent = pattern;
    li.append(remove, span);
    list.appendChild(li);
  }
  applyEnabledState();
}

function renderAll() {
  renderAllowlist();
  el('capture-all').checked = settings.captureAll;
  el('enabled').checked = settings.enabled;
  el('redact-inputs').checked = settings.redactInputValues;
  el('bodies').value = settings.captureBodies;
  el('label').value = settings.browserLabel;
  el('relay-port').value = settings.relayPort;
  applyEnabledState();
}

el('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pattern = normalizeSitePattern(el('add-input').value);
  if (!pattern) {
    el('add-input').setCustomValidity('That doesn\'t look like a domain.');
    el('add-input').reportValidity();
    return;
  }
  el('add-input').setCustomValidity('');
  if (!settings.allowlist.includes(pattern)) settings.allowlist.push(pattern);
  el('add-input').value = '';
  renderAllowlist();
  await save();
});

const bind = (id, key, prop = 'checked') => {
  el(id).addEventListener('change', async () => {
    let value = el(id)[prop];
    if (id === 'relay-port') value = Math.max(0, parseInt(value, 10) || 0);
    settings = { ...settings, [key]: value };
    applyEnabledState();
    await save();
  });
};
bind('capture-all', 'captureAll');
bind('enabled', 'enabled');
bind('redact-inputs', 'redactInputValues');
bind('bodies', 'captureBodies', 'value');
bind('label', 'browserLabel', 'value');
bind('relay-port', 'relayPort', 'value');

el('reset').onclick = async () => {
  settings = { ...DEFAULT_SETTINGS, allowlist: [...DEFAULT_SETTINGS.allowlist] };
  renderAll();
  await save();
};

chrome.storage.local.get('settings').then((stored) => {
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  renderAll();
});

// ---- trace file location and clearing ----

const sendToBackground = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type: 'popup', ...message }, resolve));

async function refreshTracePath() {
  const status = await sendToBackground({ op: 'status' });
  const path = status?.relay?.ok ? status.relay.dataFile : null;
  el('trace-path').textContent = path || 'relay not running — start it, then reopen this page';
  el('copy-path').disabled = !path;
  el('copy-path').onclick = () => {
    if (!path) return;
    navigator.clipboard.writeText(path);
    el('copy-path').textContent = 'Copied';
    setTimeout(() => { el('copy-path').textContent = 'Copy path'; }, 1200);
  };
}

let clearArmed = false;
el('clear-traces').onclick = async () => {
  if (!clearArmed) {
    clearArmed = true;
    el('clear-traces').textContent = 'Click again to confirm';
    el('clear-status').textContent = 'This deletes the trace file.';
    return;
  }
  el('clear-traces').disabled = true;
  const reply = await sendToBackground({ op: 'clear-traces' });
  el('clear-traces').disabled = false;
  clearArmed = false;
  el('clear-traces').textContent = 'Clear all traces';
  el('clear-status').textContent = reply?.ok ? 'Cleared.' : `Couldn't clear (${reply?.error || 'relay down'}).`;
  setTimeout(() => { el('clear-status').textContent = ''; }, 2500);
};

refreshTracePath();
