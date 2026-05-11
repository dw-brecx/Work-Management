// ─────────────────────────────────────────────────────────────────────────────
// Per-space chat drawer.
//
// Exposes window.SpaceChat = { open(spaceId, opts) }. Slides in from the
// right, polls /api/spaces/<id>/chat for new messages every 4 s while open,
// posts via /api/spaces/<id>/chat. Drops back out on close.
//
// Kept as its own file per the file-per-feature convention. Loaded via
// <script defer src="/space-chat.js"> in index.html.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  let panel = null;
  let overlay = null;
  let bodyEl = null;
  let composerHost = null;
  let pollTimer = null;
  let lastId = 0;
  let spaceId = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) err = j.error; } catch {}
      throw new Error(err);
    }
    return r.json();
  }

  function ensureMount() {
    if (panel) return;
    overlay = document.createElement('div');
    overlay.className = 'sc-overlay';
    overlay.onclick = close;
    panel = document.createElement('aside');
    panel.className = 'sc-panel';
    panel.innerHTML = `
      <header class="sc-head">
        <div style="flex:1;min-width:0">
          <div class="sc-head-title">💬 Space chat</div>
          <div class="sc-head-sub">Everyone with access can read and reply</div>
        </div>
        <button class="sc-close" aria-label="Close">×</button>
      </header>
      <div class="sc-body" data-sc-body></div>
      <div data-sc-composer></div>
    `;
    panel.querySelector('.sc-close').onclick = close;
    bodyEl = panel.querySelector('[data-sc-body]');
    composerHost = panel.querySelector('[data-sc-composer]');
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    document.addEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (ev.key === 'Escape' && panel && panel.classList.contains('is-open')) close();
  }

  function renderEmpty() {
    bodyEl.innerHTML = `
      <div class="sc-empty">
        <div class="sc-empty-emoji">💭</div>
        <div>Start the conversation — say hi!</div>
      </div>
    `;
  }

  function renderComposer() {
    composerHost.innerHTML = `
      <form class="sc-composer" data-sc-form>
        <textarea data-sc-input rows="1" placeholder="Write a message…" maxlength="2000"></textarea>
        <button type="submit" class="sc-send" data-sc-send>Send</button>
      </form>
    `;
    const form = composerHost.querySelector('[data-sc-form]');
    const input = composerHost.querySelector('[data-sc-input]');
    const send = composerHost.querySelector('[data-sc-send]');
    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
    });
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        const msg = await api('POST', '/api/spaces/' + spaceId + '/chat', { body });
        appendMessage(msg);
        lastId = Math.max(lastId, msg.id || 0);
        input.value = ''; autosize();
        scrollToBottom();
      } catch (e) {
        try { if (typeof settingsToast === 'function') settingsToast(e.message || 'Failed to send'); } catch {}
      } finally {
        send.disabled = false;
        input.focus();
      }
    };
    setTimeout(() => input.focus(), 60);
  }

  function appendMessage(m) {
    const me = window.CURRENT_USER || {};
    const isMe = m.user_id === me.id;
    // If empty-state placeholder is showing, clear it.
    const placeholder = bodyEl.querySelector('.sc-empty');
    if (placeholder) bodyEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'sc-msg' + (isMe ? ' is-me' : '');
    // Always show the sender's actual name — never anonymise. Easier to
    // follow a thread when every line is signed.
    const name = m.user_name || (isMe ? (me.name || 'You') : 'Someone');
    div.innerHTML = `
      <div class="sc-msg-meta">${esc(name)} · ${esc(fmtTime(m.created_at))}</div>
      <div class="sc-msg-bubble">${esc(m.body || '')}</div>
    `;
    bodyEl.appendChild(div);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { bodyEl.scrollTop = bodyEl.scrollHeight; });
  }

  async function poll() {
    if (!spaceId) return;
    try {
      const rows = await api('GET', '/api/spaces/' + spaceId + '/chat?since=' + lastId);
      if (!Array.isArray(rows) || rows.length === 0) return;
      for (const m of rows) {
        appendMessage(m);
        if (m.id > lastId) lastId = m.id;
      }
      scrollToBottom();
    } catch {
      // Silent — network blips shouldn't pop a toast every 4 s.
    }
  }

  async function open(id /*, opts */) {
    ensureMount();
    spaceId = Number(id);
    lastId = 0;
    bodyEl.innerHTML = '<div class="sc-empty"><div class="sc-empty-emoji">⏳</div><div>Loading messages…</div></div>';
    renderComposer();
    // Slide in
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      panel.classList.add('is-open');
    });
    // Initial load
    try {
      const rows = await api('GET', '/api/spaces/' + spaceId + '/chat');
      if (!Array.isArray(rows) || rows.length === 0) {
        renderEmpty();
      } else {
        bodyEl.innerHTML = '';
        for (const m of rows) {
          appendMessage(m);
          if (m.id > lastId) lastId = m.id;
        }
        scrollToBottom();
      }
    } catch (e) {
      bodyEl.innerHTML = `<div class="sc-empty">Failed to load: ${esc(e.message || 'unknown')}</div>`;
    }
    // Polling
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, 4000);
  }

  function close() {
    if (!panel) return;
    overlay.classList.remove('is-open');
    panel.classList.remove('is-open');
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    spaceId = null;
  }

  window.SpaceChat = { open, close };
})();
