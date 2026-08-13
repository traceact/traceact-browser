// Isolated-world bridge: receives event batches page.js posts on the
// window and forwards them to the background worker. Nothing else runs
// here; the page can't reach chrome.* and this script can't be reached
// by the page beyond the one message shape it accepts.
(() => {
  'use strict';
  const MARKER = 'traceact-browser:v1';

  addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.__tab !== MARKER || !Array.isArray(data.events)) return;
    try {
      chrome.runtime.sendMessage({ type: 'tab-events', events: data.events }, () => {
        // An orphaned content script (extension reloaded underneath it)
        // surfaces here; swallowing it beats a console error on every page.
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context gone; nothing to forward to.
    }
  });
})();
