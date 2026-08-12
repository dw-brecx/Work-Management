// ─────────────────────────────────────────────────────────────────────────────
// API Keys — standalone page (public/api-keys.html)
//
// Mint / list / revoke personal API keys for the external read API
// (/api/v1/tickets…). The plaintext key is shown exactly once, right after
// creation — after that only its prefix survives, so the reveal banner is
// the user's one chance to copy it.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const state = {
    keys: [],
    newKey: null,   // { id, name, key } — plaintext, held only until dismissed
    creating: false,
    error: '',
  };

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    try {
      const r = await fetch('/api/auth/me');
      if (r.status === 401) { location.href = '/login.html'; return; }
      await loadKeys();
      render();
    } catch (e) {
      $('#ak-app').innerHTML = `<div class="ak-boot">Could not load API keys. ${esc(e.message || '')}</div>`;
    }
  }

  async function loadKeys() {
    const r = await fetch('/api/api-keys');
    if (!r.ok) throw new Error('Failed to load keys');
    state.keys = await r.json();
  }

  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function render() {
    const origin = location.origin;
    $('#ak-app').innerHTML = `
    <div class="ak-page">
      <div class="ak-header">
        <a class="ak-back" href="/">← Back to app</a>
        <h1>API Keys</h1>
        <button class="ak-btn" id="ak-new-btn">＋ New key</button>
      </div>
      <p class="ak-sub">
        Personal keys that let another app read your tickets over HTTP.
        A key sees exactly the tickets <em>you</em> can see, and is read-only.
        Keep keys secret — anyone holding one can read your tickets.
      </p>

      ${state.newKey ? `
      <div class="ak-card ak-reveal">
        <h2>“${esc(state.newKey.name)}” created — copy your key now</h2>
        <p class="ak-reveal-note">
          This is the <strong>only time</strong> the full key is shown.
          Store it somewhere safe (an env var or secrets manager in the other app).
        </p>
        <div class="ak-keybox">
          <code id="ak-new-key">${esc(state.newKey.key)}</code>
          <button class="ak-btn ghost" id="ak-copy-btn">Copy</button>
          <button class="ak-btn ghost" id="ak-dismiss-btn">Done</button>
        </div>
      </div>` : ''}

      <div class="ak-card">
        <h2>Your keys</h2>
        ${state.keys.length ? `
        <table class="ak-table">
          <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            ${state.keys.map((k) => `
            <tr>
              <td>${esc(k.name)}</td>
              <td><code>${esc(k.keyPrefix)}</code></td>
              <td>${esc(fmtDate(k.createdAt))}</td>
              <td>${esc(fmtDate(k.lastUsedAt))}</td>
              <td style="text-align:right">
                <button class="ak-btn danger" data-revoke="${k.id}" data-name="${esc(k.name)}">Revoke</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div class="ak-empty">No API keys yet. Create one to connect another app.</div>`}
        ${state.error ? `<p class="ak-error">${esc(state.error)}</p>` : ''}
      </div>

      <div class="ak-card ak-docs">
        <h2>How to use the API</h2>
        <p>Send the key on every request, either as a Bearer token or an <code class="inline">X-API-Key</code> header:</p>
        <pre>curl -H "Authorization: Bearer wm_live_…" \\
  ${esc(origin)}/api/v1/tickets</pre>
        <p><code class="inline">GET /api/v1/tickets</code> lists the tickets the key can see
        (add <code class="inline">?status=Open</code> to filter). Then fetch <strong>everything</strong>
        about one ticket — details, comments, timeline, subtasks, attachments — in a single call:</p>
        <pre>curl -H "Authorization: Bearer wm_live_…" \\
  ${esc(origin)}/api/v1/tickets/TKT-1001</pre>
        <p>The response contains <code class="inline">ticket</code>, <code class="inline">details</code>
        (description + checklist), <code class="inline">comments</code> (with attachment links),
        <code class="inline">timeline</code>, <code class="inline">subtasks</code> and
        <code class="inline">attachments</code>. The API is read-only.</p>
      </div>
    </div>`;

    $('#ak-new-btn').onclick = onCreate;
    if (state.newKey) {
      $('#ak-copy-btn').onclick = async () => {
        try {
          await navigator.clipboard.writeText(state.newKey.key);
          $('#ak-copy-btn').textContent = 'Copied ✓';
          setTimeout(() => { const b = $('#ak-copy-btn'); if (b) b.textContent = 'Copy'; }, 1600);
        } catch { window.uiAlert('Copy failed — select the key text and copy manually.'); }
      };
      $('#ak-dismiss-btn').onclick = () => { state.newKey = null; render(); };
    }
    document.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.onclick = () => onRevoke(btn.dataset.revoke, btn.dataset.name);
    });
  }

  async function onCreate() {
    if (state.creating) return;
    const name = await window.uiPrompt('Name this key (e.g. the app that will use it):', { placeholder: 'e.g. Inventory dashboard' });
    if (name === null) return;
    if (!String(name).trim()) { window.uiAlert('A name is required.'); return; }
    state.creating = true; state.error = '';
    try {
      const r = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: String(name).trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to create key');
      state.newKey = { id: data.id, name: data.name, key: data.key };
      await loadKeys();
    } catch (e) {
      state.error = e.message || 'Failed to create key';
    }
    state.creating = false;
    render();
  }

  async function onRevoke(id, name) {
    const ok = await window.uiConfirm(
      `Revoke “${name}”? Any app using this key will immediately lose access. This cannot be undone.`,
      { danger: true, okText: 'Revoke' }
    );
    if (!ok) return;
    state.error = '';
    try {
      const r = await fetch('/api/api-keys/' + encodeURIComponent(id), { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to revoke key');
      if (state.newKey && String(state.newKey.id) === String(id)) state.newKey = null;
      await loadKeys();
    } catch (e) {
      state.error = e.message || 'Failed to revoke key';
    }
    render();
  }
})();
