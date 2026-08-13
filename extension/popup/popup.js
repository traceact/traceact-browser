// The popup: track or untrack the current site in one click, and show
// relay state with a way back up when it's down.

import { normalizeSitePattern } from '../lib.js';

const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type: 'popup', ...message }, resolve));

const el = (id) => document.getElementById(id);

function sitePatternFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return normalizeSitePattern(u.host);
  } catch { return null; }
}

async function render() {
  const status = await send({ op: 'status' });
  const pattern = sitePatternFromUrl(status.url);
  const siteLine = el('site-line');
  const toggle = el('toggle');

  if (!pattern) {
    siteLine.textContent = 'This page can\'t be tracked (not an http(s) site).';
  } else if (status.settings.captureAll) {
    siteLine.innerHTML = `<span class="site">${pattern}</span> is tracked — ` +
      '"capture all sites" is on.';
  } else {
    const tracked = status.tracked;
    siteLine.innerHTML = `<span class="site">${pattern}</span> is ` +
      (tracked ? '<b>being tracked</b>.' : 'not tracked.');
    toggle.hidden = false;
    toggle.textContent = tracked ? 'Stop tracking this site' : 'Track this site';
    toggle.className = tracked ? 'stop' : 'primary';
    toggle.onclick = async () => {
      await send({ op: 'toggle-site', pattern, add: !tracked });
      render();
    };
  }

  const relay = el('relay');
  relay.hidden = false;
  if (status.relay.ok) {
    relay.className = 'status';
    relay.innerHTML = `Relay running on port ${status.relay.port}.<br>` +
      `<span class="muted">Traces: <code>${status.relay.dataFile || ''}</code></span>`;
  } else {
    relay.className = 'status bad';
    relay.innerHTML = 'Relay isn\'t running, so nothing is being saved.<br>';
    const restart = document.createElement('button');
    restart.textContent = 'Start the relay';
    restart.onclick = async () => {
      restart.textContent = 'Starting…';
      restart.disabled = true;
      const reply = await send({ op: 'restart-relay' });
      if (reply.ok) { render(); return; }
      restart.remove();
      const fallback = document.createElement('div');
      fallback.innerHTML = 'Couldn\'t start it from here. Run this in a terminal: ' +
        `<code>${status.startCommand}</code> ` +
        '<button id="copy-cmd">Copy</button>';
      relay.appendChild(fallback);
      document.getElementById('copy-cmd').onclick = () => {
        navigator.clipboard.writeText(status.startCommand);
        document.getElementById('copy-cmd').textContent = 'Copied';
      };
    };
    relay.appendChild(restart);
  }
}

el('options-link').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
render();
