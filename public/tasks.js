/* Tasks — instant "do this now" requests between office and warehouse.
   Create a task for someone, watch the clock run until it's Closed.
   Statuses: Open → Checking → Closed. Optionally linked to a ticket. */
(() => {
  'use strict';

  const REFRESH_MS = 15000;
  const $app = document.getElementById('qt-app');
  let me = null;
  let team = [];
  let tasks = [];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(p, opts) {
    const r = await fetch(p, Object.assign({ credentials: 'same-origin' }, opts));
    if (r.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  const apiGet = (p) => api(p);
  const apiSend = (p, method, body) => api(p, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });

  const parseUtc = (s) => {
    if (!s) return null;
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? null : d;
  };
  function fmtDur(ms) {
    if (ms == null || ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d >= 1) return `${d}d ${h}h`;
    if (h >= 1) return `${h}h ${m}m`;
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  }

  const isAdmin = () => ['Admin', 'Manager'].includes(me?.permRole);
  const canAct = (t) => isAdmin() || t.creator.id === me?.id || t.assignee.id === me?.id;

  function taskCard(t) {
    const active = t.status !== 'Closed';
    const started = parseUtc(t.createdAt);
    const closed = parseUtc(t.closedAt);
    const timer = active
      ? `<span class="qt-timer" data-epoch="${started ? started.getTime() : Date.now()}">…</span>
         <div class="qt-timer-sub">${t.status === 'Checking' ? 'being checked' : 'waiting'} since creation</div>`
      : `<span class="qt-timer">${closed && started ? fmtDur(closed - started) : '—'}</span>
         <div class="qt-timer-sub">total time to close</div>`;
    const badge = { Open: '<span class="qt-badge b-open">⚡ Open</span>',
                    Checking: '<span class="qt-badge b-checking">👀 Checking</span>',
                    Closed: '<span class="qt-badge b-closed">✅ Closed</span>' }[t.status] || '';
    const btns = [];
    if (canAct(t)) {
      if (t.status === 'Open') btns.push(`<button class="qt-btn" data-act="Checking" data-id="${t.id}">👀 I'm checking</button>`);
      if (t.status !== 'Closed') btns.push(`<button class="qt-btn b-done" data-act="Closed" data-id="${t.id}">✅ Done</button>`);
      if (t.status === 'Closed') btns.push(`<button class="qt-btn" data-act="Open" data-id="${t.id}">↩ Reopen</button>`);
    }
    return `
    <div class="qt-card s-${t.status.toLowerCase()}">
      <div class="qt-main">
        <div class="qt-card-title">${esc(t.title)}</div>
        ${t.description ? `<div class="qt-desc">${esc(t.description)}</div>` : ''}
        <div class="qt-meta">
          ${badge}
          <span>${esc(t.creator.name || '?')} → <b style="color:var(--ink-2)">${esc(t.assignee.name || '?')}</b></span>
          ${t.ticketId ? `<a class="qt-ticket-chip" href="/tickets/${encodeURIComponent(t.ticketId)}">🎫 ${esc(t.ticketId)}${t.ticketTitle ? ' · ' + esc(t.ticketTitle) : ''}</a>` : ''}
        </div>
      </div>
      <div class="qt-side">${timer}<div class="qt-actions">${btns.join('')}</div></div>
    </div>`;
  }

  function render() {
    const active = tasks.filter(t => t.status !== 'Closed');
    const closed = tasks.filter(t => t.status === 'Closed');
    const options = team
      .map(u => `<option value="${u.id}" ${u.id === me.id ? '' : ''}>${esc(u.name)}</option>`).join('');
    $app.innerHTML = `
      <div class="qt-header">
        <div class="qt-brand">⚡</div>
        <div>
          <div class="qt-title">Tasks</div>
          <div class="qt-sub">"Do this now" requests — the clock runs until it's closed</div>
        </div>
        <a href="/tickets-live.html">📺 Live board →</a>
      </div>

      <div class="qt-new">
        <div class="qt-new-title">⚡ New task</div>
        <div class="qt-row">
          <div style="flex:2"><label>What needs to happen right now?</label>
            <input id="qt-title" type="text" maxlength="200" placeholder="e.g. Please open the door for the truck"/></div>
          <div><label>Who</label><select id="qt-assignee"><option value="">Pick a person…</option>${options}</select></div>
        </div>
        <div class="qt-row">
          <div style="flex:2"><label>Details (optional)</label>
            <textarea id="qt-desc" rows="2" maxlength="2000" placeholder="Anything they need to know"></textarea></div>
          <div><label>Link a ticket (optional)</label>
            <input id="qt-ticket" type="text" placeholder="TKT-123"/></div>
        </div>
        <button class="qt-send" id="qt-send">Send task</button>
        <div class="qt-msg" id="qt-msg"></div>
      </div>

      <div class="qt-section">🔥 Active <span class="cnt">${active.length}</span></div>
      ${active.map(taskCard).join('') || '<div class="qt-empty">Nothing to do right now 🎉</div>'}

      <div class="qt-section">✅ Closed in the last 24h <span class="cnt">${closed.length}</span></div>
      ${closed.map(taskCard).join('') || '<div class="qt-empty">Nothing closed yet.</div>'}`;

    document.getElementById('qt-send').onclick = createTask;
    document.getElementById('qt-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') createTask(); });
    tick();
  }

  const msg = (t, bad) => {
    const m = document.getElementById('qt-msg');
    if (m) { m.textContent = t; m.style.color = bad ? '#e66767' : '#0ca30c'; }
  };

  async function createTask() {
    const btn = document.getElementById('qt-send');
    const body = {
      title: document.getElementById('qt-title').value.trim(),
      description: document.getElementById('qt-desc').value.trim(),
      assigneeUserId: Number(document.getElementById('qt-assignee').value) || 0,
      ticketId: document.getElementById('qt-ticket').value.trim(),
    };
    if (!body.title) { msg('Write what needs to happen.', true); return; }
    if (!body.assigneeUserId) { msg('Pick who should do it.', true); return; }
    btn.disabled = true;
    try {
      await apiSend('/api/quick-tasks', 'POST', body);
      await load();
      msg('Task sent ⚡');
    } catch (e) { msg(e.message, true); }
    btn.disabled = false;
  }

  async function onAction(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try {
      await apiSend('/api/quick-tasks/' + b.dataset.id + '/status', 'PUT', { status: b.dataset.act });
      await load();
    } catch (err) { window.alert(err.message); }
  }

  function tick() {
    const now = Date.now();
    document.querySelectorAll('[data-epoch]').forEach(el => {
      el.textContent = fmtDur(now - Number(el.dataset.epoch));
    });
  }

  async function load() {
    tasks = await apiGet('/api/quick-tasks');
    render();
  }

  async function boot() {
    try {
      me = await apiGet('/api/auth/me');
      team = await apiGet('/api/team');
      await load();
      $app.addEventListener('click', onAction);
      setInterval(() => load().catch(() => {}), REFRESH_MS);
      setInterval(tick, 1000);
    } catch (e) {
      if ($app) $app.innerHTML = `<div class="qt-error">Couldn't load tasks: ${esc(e.message)}</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
