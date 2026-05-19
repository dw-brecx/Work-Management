// ============================================================
// Recurring Tasks — standalone page
//
// This file is the entire client for /recurring.html. It does its own
// auth check, fetches /api/team for the assignee dropdown, then renders
// the list of recurring tasks. The CRUD modal lives inside this page
// (no SPA shell) so index.html stays small.
// ============================================================

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── API helpers ────────────────────────────────────────────────────────────
  async function apiGet(p) {
    const r = await fetch(p, { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    if (!r.ok) throw new Error('GET ' + p + ' failed (' + r.status + ')');
    return r.json();
  }
  async function apiSend(method, p, body) {
    const r = await fetch(p, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data.error || (method + ' ' + p + ' failed'));
    return data;
  }
  const apiPost = (p, b) => apiSend('POST', p, b);
  const apiPut  = (p, b) => apiSend('PUT',  p, b);
  const apiDel  = (p)    => apiSend('DELETE', p);

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    let el = $('rt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rt-toast';
      document.body.appendChild(el);
    }
    el.className = 'show ' + (kind === 'err' ? 'err' : (kind === 'ok' ? 'ok' : ''));
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = el.className.replace('show', '').trim(); }, 2800);
  }

  // ── Page state ─────────────────────────────────────────────────────────────
  let RECURRING = [];
  let TEAM = [];

  // ── Recurrence description (matches server-side rules in server.js) ────────
  const WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function describe(rt) {
    if (rt.recur_type === 'monthly_same') {
      const d = rt.start_date ? new Date(rt.start_date + 'T00:00:00').getDate() : '?';
      return 'Every month on day ' + d;
    }
    if (rt.recur_type === 'monthly_day') return 'Every month on day ' + (rt.recur_day || '—');
    if (rt.recur_type === 'weekly')      return 'Every ' + (WEEKDAY_NAMES[rt.recur_weekday] || '—');
    if (rt.recur_type === 'every_n_days') {
      const n = rt.recur_interval || 0;
      return 'Every ' + n + ' day' + (n === 1 ? '' : 's');
    }
    return rt.recur_type || '';
  }

  // ── Page skeleton ──────────────────────────────────────────────────────────
  function renderShell() {
    const root = $('rt-app');
    root.innerHTML = `
      <div class="rt-page">
        <div class="rt-header">
          <a class="rt-back" href="/tickets">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Back to app
          </a>
          <h1 class="rt-title">Recurring Tasks</h1>
          <button class="btn-primary" id="rt-new-btn">+ New Recurring Task</button>
        </div>
        <p class="rt-lede">
          Set up a task that should fire on a schedule — every month on a specific date, once a week, or every N days. Each recurring task can hold one or many ticket templates; when the schedule fires, every template is created as a fresh ticket, each routed to its own assignee.
        </p>
        <div id="rt-list" class="rt-list"></div>
        <div id="rt-empty" class="rt-empty" style="display:none">
          No recurring tasks yet. Click <strong>+ New Recurring Task</strong> to set one up.
        </div>
      </div>
      ${modalHtml()}
    `;
    $('rt-new-btn').addEventListener('click', () => openModal());
    wireModalEvents();
  }

  // ── List render ────────────────────────────────────────────────────────────
  function renderList() {
    const list = $('rt-list');
    const empty = $('rt-empty');
    if (!RECURRING.length) {
      list.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = RECURRING.map(rt => {
      const items = rt.items || [];
      const itemsHtml = items.length
        ? items.map(it => `
            <div class="rt-item-row">
              <span class="rt-item-title">${escapeHtml(it.title || '(untitled ticket)')}</span>
              <span class="rt-item-assignee">${escapeHtml(it.assignee || '— unassigned')}</span>
              <span class="rt-pill prio-${escapeHtml(it.priority || 'Medium')}">${escapeHtml(it.priority || 'Medium')}</span>
            </div>`).join('')
        : '<div style="color:var(--text3);font-size:11.5px;padding:8px 0">No ticket templates yet — edit to add some.</div>';
      const stateBadge = rt.active
        ? '<span class="rt-pill active">Active</span>'
        : '<span class="rt-pill paused">Paused</span>';
      return `
        <div class="rt-card">
          <div class="rt-card-head">
            <div style="flex:1;min-width:240px">
              <div class="rt-card-title">
                <span class="rt-card-name">${escapeHtml(rt.name || '(untitled)')}</span>
                ${stateBadge}
              </div>
              ${rt.description ? `<div class="rt-card-desc">${escapeHtml(rt.description)}</div>` : ''}
              <div class="rt-card-meta">
                ${escapeHtml(describe(rt))} ·
                Next: <strong>${escapeHtml(rt.next_run_date || '—')}</strong>
                ${rt.last_run_date ? ' · Last: ' + escapeHtml(rt.last_run_date) : ''}
                · ${items.length} ticket${items.length === 1 ? '' : 's'} per run
              </div>
            </div>
            <div class="rt-card-actions">
              <button class="btn-sec" data-action="toggle" data-id="${rt.id}">${rt.active ? 'Pause' : 'Resume'}</button>
              <button class="btn-sec" data-action="run"    data-id="${rt.id}">Run now</button>
              <button class="btn-sec" data-action="edit"   data-id="${rt.id}">Edit</button>
              <button class="btn-sec btn-danger" data-action="delete" data-id="${rt.id}">Delete</button>
            </div>
          </div>
          <div class="rt-items-list">${itemsHtml}</div>
        </div>`;
    }).join('');

    // Wire row buttons via event delegation (cheaper than per-button listeners
    // and survives every re-render automatically).
    list.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if (action === 'toggle') toggleActive(id);
        else if (action === 'run')    runNow(id);
        else if (action === 'edit')   openModal(id);
        else if (action === 'delete') deleteOne(id);
      });
    });
  }

  // ── Modal markup + behaviour ───────────────────────────────────────────────
  function modalHtml() {
    return `
      <div id="rt-modal" class="modal-overlay">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title" id="rt-modal-title">New Recurring Task</span>
            <button class="modal-close" id="rt-modal-close">×</button>
          </div>
          <input type="hidden" id="rt-id" value=""/>
          <div class="form-row"><label>Name *</label><input type="text" id="rt-name" placeholder="e.g. Monthly inventory check"/></div>
          <div class="form-row"><label>Description</label><textarea id="rt-desc" placeholder="What does this recurring task cover?"></textarea></div>
          <div class="form-grid">
            <div class="form-row"><label>First start date *</label><input type="date" id="rt-start"/></div>
            <div class="form-row">
              <label>Recurrence *</label>
              <select id="rt-recur-type">
                <option value="monthly_same">Every month on the start-date's day</option>
                <option value="monthly_day">Every month on a specific day</option>
                <option value="weekly">Once a week</option>
                <option value="every_n_days">Every N days</option>
              </select>
            </div>
          </div>
          <div class="form-row" id="rt-opt-monthly-day" style="display:none">
            <label>Day of the month (1–31)</label>
            <input type="number" id="rt-recur-day" min="1" max="31" placeholder="e.g. 15"/>
            <div style="font-size:10.5px;color:var(--text3);margin-top:4px">If the month has fewer days (e.g. day 31 in February) it will fire on the last day of that month.</div>
          </div>
          <div class="form-row" id="rt-opt-weekly" style="display:none">
            <label>Weekday</label>
            <select id="rt-recur-weekday">
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
            </select>
          </div>
          <div class="form-row" id="rt-opt-every-n" style="display:none">
            <label>Every (days)</label>
            <input type="number" id="rt-recur-interval" min="1" max="365" placeholder="e.g. 3"/>
          </div>

          <div class="rt-section-head">
            <span class="rt-section-title">Tickets to create on each run</span>
            <span class="rt-section-hint">Add as many as you need</span>
          </div>
          <div id="rt-items"></div>
          <button type="button" class="rt-add-item-btn" id="rt-add-item">+ Add another ticket</button>

          <div class="rt-modal-actions">
            <button class="btn-sec"     id="rt-cancel-btn">Cancel</button>
            <button class="btn-primary" id="rt-save-btn">Save Recurring Task</button>
          </div>
        </div>
      </div>`;
  }

  function wireModalEvents() {
    $('rt-modal-close').addEventListener('click', closeModal);
    $('rt-cancel-btn').addEventListener('click', closeModal);
    $('rt-save-btn').addEventListener('click', saveTask);
    $('rt-add-item').addEventListener('click', () => addItem());
    $('rt-recur-type').addEventListener('change', updateRecurOptions);
    // Backdrop click closes
    $('rt-modal').addEventListener('click', (e) => {
      if (e.target.id === 'rt-modal') closeModal();
    });
    // ESC closes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('rt-modal').classList.contains('open')) closeModal();
    });
  }

  function updateRecurOptions() {
    const t = $('rt-recur-type').value;
    $('rt-opt-monthly-day').style.display = (t === 'monthly_day')   ? '' : 'none';
    $('rt-opt-weekly').style.display      = (t === 'weekly')        ? '' : 'none';
    $('rt-opt-every-n').style.display     = (t === 'every_n_days')  ? '' : 'none';
  }

  function itemRowHtml(item) {
    item = item || {};
    const teamOpts = TEAM.map(m =>
      `<option value="${escapeHtml(m.name)}" ${m.name === item.assignee ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
    ).join('');
    const prio = item.priority || 'Medium';
    const prioOpt = (v) => `<option value="${v}" ${prio === v ? 'selected' : ''}>${v}</option>`;
    return `
      <div class="rt-item-edit">
        <div class="rt-item-edit-head">
          <span class="rt-item-edit-label">Ticket template</span>
          <button type="button" class="rt-item-remove" data-remove>×</button>
        </div>
        <div class="form-row"><label>Title *</label><input type="text" class="rt-it-title" placeholder="e.g. Run monthly inventory audit" value="${escapeHtml(item.title || '')}"/></div>
        <div class="form-grid">
          <div class="form-row">
            <label>Assignee *</label>
            <select class="rt-it-assignee"><option value="">— Select —</option>${teamOpts}</select>
          </div>
          <div class="form-row">
            <label>Priority</label>
            <select class="rt-it-priority">
              ${prioOpt('Urgent')}${prioOpt('High')}${prioOpt('Medium')}${prioOpt('Low')}
            </select>
          </div>
        </div>
        <div class="form-row"><label>Department</label><input type="text" class="rt-it-dept" placeholder="e.g. Engineering" value="${escapeHtml(item.dept || '')}"/></div>
        <div class="form-row"><label>Description</label><textarea class="rt-it-desc" placeholder="Details for this ticket…">${escapeHtml(item.description || '')}</textarea></div>
      </div>`;
  }

  function addItem(item) {
    const wrap = $('rt-items');
    wrap.insertAdjacentHTML('beforeend', itemRowHtml(item));
    const row = wrap.lastElementChild;
    row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  }

  function openModal(id) {
    const modal = $('rt-modal');
    const titleEl = $('rt-modal-title');
    $('rt-id').value = '';
    $('rt-name').value = '';
    $('rt-desc').value = '';
    $('rt-start').value = new Date().toISOString().slice(0, 10);
    $('rt-recur-type').value = 'monthly_same';
    $('rt-recur-day').value = '';
    $('rt-recur-weekday').value = '1';
    $('rt-recur-interval').value = '';
    $('rt-items').innerHTML = '';
    updateRecurOptions();

    if (id) {
      const rt = RECURRING.find(x => x.id === id);
      if (rt) {
        titleEl.textContent = 'Edit Recurring Task';
        $('rt-id').value = rt.id;
        $('rt-name').value = rt.name || '';
        $('rt-desc').value = rt.description || '';
        $('rt-start').value = rt.start_date || '';
        $('rt-recur-type').value = rt.recur_type || 'monthly_same';
        if (rt.recur_day != null)      $('rt-recur-day').value = rt.recur_day;
        if (rt.recur_weekday != null)  $('rt-recur-weekday').value = String(rt.recur_weekday);
        if (rt.recur_interval != null) $('rt-recur-interval').value = rt.recur_interval;
        updateRecurOptions();
        (rt.items || []).forEach(addItem);
      }
    } else {
      titleEl.textContent = 'New Recurring Task';
    }
    if (!$('rt-items').children.length) addItem();
    modal.classList.add('open');
  }
  function closeModal() { $('rt-modal').classList.remove('open'); }

  async function saveTask() {
    const id = $('rt-id').value || null;
    const name = $('rt-name').value.trim();
    if (!name) { toast('Please enter a name.', 'err'); return; }
    const startDate = $('rt-start').value;
    if (!startDate) { toast('Please pick a first start date.', 'err'); return; }
    const recurType = $('rt-recur-type').value;

    const payload = {
      name,
      description: $('rt-desc').value.trim(),
      start_date: startDate,
      recur_type: recurType,
      recur_day:      recurType === 'monthly_day'  ? parseInt($('rt-recur-day').value, 10) : null,
      recur_weekday:  recurType === 'weekly'        ? parseInt($('rt-recur-weekday').value, 10) : null,
      recur_interval: recurType === 'every_n_days'  ? parseInt($('rt-recur-interval').value, 10) : null,
      items: [],
    };
    if (recurType === 'monthly_day' && (!payload.recur_day || payload.recur_day < 1 || payload.recur_day > 31)) {
      toast('Pick a day between 1 and 31.', 'err'); return;
    }
    if (recurType === 'every_n_days' && (!payload.recur_interval || payload.recur_interval < 1)) {
      toast('Enter how many days between runs.', 'err'); return;
    }

    const rows = $('rt-items').querySelectorAll('.rt-item-edit');
    for (const row of rows) {
      const title    = row.querySelector('.rt-it-title').value.trim();
      const assignee = row.querySelector('.rt-it-assignee').value;
      if (!title)    { toast('Every ticket template needs a title.', 'err'); return; }
      if (!assignee) { toast('Every ticket template needs an assignee.', 'err'); return; }
      payload.items.push({
        title,
        assignee,
        priority:    row.querySelector('.rt-it-priority').value || 'Medium',
        dept:        row.querySelector('.rt-it-dept').value.trim() || '',
        description: row.querySelector('.rt-it-desc').value.trim() || '',
      });
    }
    if (!payload.items.length) { toast('Add at least one ticket template.', 'err'); return; }

    const saveBtn = $('rt-save-btn');
    saveBtn.disabled = true;
    try {
      if (id) await apiPut('/api/recurring-tasks/' + id, payload);
      else    await apiPost('/api/recurring-tasks', payload);
      closeModal();
      await reload();
      toast(id ? 'Updated' : 'Created', 'ok');
    } catch (e) {
      toast('Could not save: ' + (e.message || 'unknown error'), 'err');
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function toggleActive(id) {
    const rt = RECURRING.find(x => x.id === id);
    if (!rt) return;
    try {
      await apiPut('/api/recurring-tasks/' + id, { active: rt.active ? 0 : 1 });
      await reload();
    } catch { toast('Could not update.', 'err'); }
  }

  async function runNow(id) {
    if (!confirm('Run this recurring task now? Tickets will be created immediately.')) return;
    try {
      const r = await apiPost('/api/recurring-tasks/' + id + '/run-now', {});
      toast('Created ' + (r.created || 0) + ' ticket(s).', 'ok');
      await reload();
    } catch { toast('Could not run now.', 'err'); }
  }

  async function deleteOne(id) {
    if (!confirm('Delete this recurring task? Already-created tickets will remain.')) return;
    try {
      await apiDel('/api/recurring-tasks/' + id);
      await reload();
      toast('Deleted', 'ok');
    } catch { toast('Could not delete.', 'err'); }
  }

  async function reload() {
    RECURRING = await apiGet('/api/recurring-tasks');
    renderList();
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      // /api/auth/me 401s on logout and the helper auto-redirects. Doing it
      // first ensures we never render a half-page for a signed-out visitor.
      await apiGet('/api/auth/me');
      // Team needs to load before the first modal opens; preload it here so
      // the assignee dropdown is ready immediately.
      try { TEAM = await apiGet('/api/team'); } catch { TEAM = []; }
      renderShell();
      await reload();
    } catch (e) {
      // 401s already redirect inside apiGet; this catches genuine errors.
      const root = $('rt-app');
      if (root) {
        root.innerHTML = '<div class="rt-boot" style="color:#dc2626">Failed to load. Please refresh.</div>';
      }
      console.error('[recurring] boot failed:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
