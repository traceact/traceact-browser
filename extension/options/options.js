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
}

function renderAll() {
  renderAllowlist();
  el('capture-all').checked = settings.captureAll;
  el('enabled').checked = settings.enabled;
  el('redact-inputs').checked = settings.redactInputValues;
  el('bodies').value = settings.captureBodies;
  el('label').value = settings.browserLabel;
  el('relay-port').value = settings.relayPort;
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
