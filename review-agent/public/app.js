'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
let es = null;

function logLine(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `\n[${t}] ${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}

fetch('/api/health').then(r => r.json()).then(h => {
  $('claude-state').textContent = h.claude
    ? 'Claude clean-up: ON (reviews get tidied + type-tagged).'
    : 'Claude clean-up: OFF — set ANTHROPIC_API_KEY to enable. Gathering still works.';
}).catch(() => {});

$('go').addEventListener('click', () => {
  const url = $('url').value.trim();
  if (!url) { logLine('Paste an Amazon link first.'); return; }
  if (es) { es.close(); es = null; }

  $('go').disabled = true;
  $('go').textContent = 'Gathering…';
  $('download').style.display = 'none';
  logEl.textContent = 'Starting…';

  const params = new URLSearchParams({
    url,
    maxPages: $('maxPages').value || '10',
    flavorName: $('flavor').value.trim(),
    variant: $('variant').value,
    headless: $('headless').checked ? '1' : '0',
  });

  es = new EventSource('/api/gather?' + params.toString());

  es.addEventListener('progress', (e) => logLine(JSON.parse(e.data).msg));

  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    logLine(`✅ Captured ${d.count} review(s). File: ${d.file}`);
    const dl = $('download');
    dl.href = d.downloadUrl;
    dl.setAttribute('download', d.file);
    dl.style.display = 'inline-flex';
    reset();
  });

  es.addEventListener('error', (e) => {
    let msg = 'Connection lost.';
    try { if (e.data) msg = JSON.parse(e.data).msg; } catch {}
    logLine('⚠️ ' + msg);
    reset();
  });

  function reset() {
    $('go').disabled = false;
    $('go').textContent = 'Gather reviews';
    if (es) { es.close(); es = null; }
  }
});
