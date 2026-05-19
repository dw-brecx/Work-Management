// ============================================================
// Recurring Tasks — standalone page
//
// Two views, hash-routed inside the same HTML shell:
//
//   #/         → LIST view (cards for each recurring schedule)
//   #/<id>     → DETAIL view (one schedule + its ticket templates, the
//                "open it and add tickets like a project" surface)
//
// The schedule modal only captures name / description / start-date /
// recurrence. Ticket templates are managed from the detail view via a
// full-featured ticket modal (multi-assignee, reporter, tags,
// checklist, due-offset-days, priority, dept, description) — feature
// parity with the SPA's create-ticket modal, so when the cron fires it
// can spawn a fully-featured regular ticket from each row.
// ============================================================

(() => {
  'use strict';

  const $  = (id)  => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
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
    if (!el) { el = document.createElement('div'); el.id = 'rt-toast'; document.body.appendChild(el); }
    el.className = 'show ' + (kind === 'err' ? 'err' : (kind === 'ok' ? 'ok' : ''));
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = el.className.replace('show', '').trim(); }, 2800);
  }

  // ── Page state ─────────────────────────────────────────────────────────────
  let RECURRING = [];   // List of schedules with their items
  let TEAM = [];        // Workspace users (for assignee / reporter dropdowns)
  let CURRENT_DETAIL = null; // The schedule object being shown in detail view

  // Working state for the template modal — accumulates the chips/checklist
  // entries between renders so we don't have to re-parse the DOM constantly.
  let TPL_DRAFT = { assignees: [], tags: [], checklist: [] };
  let EDITING_TEMPLATE_ID = null;

  // ── Recurrence labels (mirror server's rules) ──────────────────────────────
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

  // ── Router ─────────────────────────────────────────────────────────────────
  function currentRoute() {
    const h = (location.hash || '').replace(/^#/, '');
    const m = /^\/(\d+)$/.exec(h);
    if (m) return { view: 'detail', id: Number(m[1]) };
    return { view: 'list' };
  }
  function goto(hash) { location.hash = hash; }
  window.addEventListener('hashchange', renderRoute);

  // ── Page skeleton (shared chrome — both views render inside #rt-app) ──────
  function renderShell() {
    $('rt-app').innerHTML = `
      <div class="rt-page" id="rt-page"></div>
      ${scheduleModalHtml()}
      ${templateModalHtml()}
    `;
    wireScheduleModal();
    wireTemplateModal();
  }

  function renderRoute() {
    const r = currentRoute();
    if (r.view === 'detail') {
      const rt = RECURRING.find(x => x.id === r.id);
      if (!rt) {
        // Page reload landing directly on #/<id> — fetch the one and show it
        apiGet('/api/recurring-tasks/' + r.id).then(t => {
          // Replace the matching entry (or insert) so the list is consistent
          const i = RECURRING.findIndex(x => x.id === t.id);
          if (i >= 0) RECURRING[i] = t; else RECURRING.push(t);
          CURRENT_DETAIL = t;
          renderDetailView();
        }).catch(() => {
          toast('That recurring task no longer exists.', 'err');
          goto('#/');
        });
        return;
      }
      CURRENT_DETAIL = rt;
      renderDetailView();
    } else {
      CURRENT_DETAIL = null;
      renderListView();
    }
  }

  // ── LIST view ──────────────────────────────────────────────────────────────
  function renderListView() {
    const page = $('rt-page');
    page.innerHTML = `
      <div class="rt-header">
        <a class="rt-back" href="/tickets">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          Back to app
        </a>
        <h1 class="rt-title">Recurring Tasks</h1>
        <button class="btn-primary" id="rt-new-btn">+ New Recurring Task</button>
      </div>
      <p class="rt-lede">
        Set up a task that should fire on a schedule — every month on a specific date, once a week, or every N days.
        Save the schedule first, then open it and add tickets the same way you'd add sub-tickets to a project.
        Each ticket is a full regular ticket (assignees, reporter, tags, checklist, due date offset) and the cron clones it into the main ticket queue every time the schedule fires.
      </p>
      <div id="rt-list" class="rt-list"></div>
      <div id="rt-empty" class="rt-empty" style="display:none">
        No recurring tasks yet. Click <strong>+ New Recurring Task</strong> to set one up.
      </div>
    `;
    $('rt-new-btn').addEventListener('click', () => openScheduleModal());
    renderList();
  }

  function renderList() {
    const list = $('rt-list');
    const empty = $('rt-empty');
    if (!list) return;
    if (!RECURRING.length) {
      list.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = RECURRING.map(rt => {
      const items = rt.items || [];
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
              <button class="btn-primary" data-action="open"   data-id="${rt.id}">Open</button>
              <button class="btn-sec"     data-action="toggle" data-id="${rt.id}">${rt.active ? 'Pause' : 'Resume'}</button>
              <button class="btn-sec"     data-action="run"    data-id="${rt.id}">Run now</button>
              <button class="btn-sec btn-danger" data-action="delete" data-id="${rt.id}">Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if      (action === 'open')   goto('#/' + id);
        else if (action === 'toggle') toggleActive(id);
        else if (action === 'run')    runNow(id);
        else if (action === 'delete') deleteSchedule(id);
      });
    });
  }

  // ── DETAIL view ────────────────────────────────────────────────────────────
  function renderDetailView() {
    const rt = CURRENT_DETAIL;
    if (!rt) return;
    const items = rt.items || [];
    const page = $('rt-page');
    page.innerHTML = `
      <div class="rt-header">
        <a class="rt-back" href="#/" id="rt-back-list">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          Back to list
        </a>
        <h1 class="rt-title">${escapeHtml(rt.name || '(untitled)')}</h1>
        <button class="btn-sec"     id="rt-edit-schedule">Edit schedule</button>
        <button class="btn-primary" id="rt-add-ticket">+ New Ticket</button>
      </div>

      <div class="rt-detail-meta">
        <div class="rt-detail-meta-row">
          <span class="rt-pill ${rt.active ? 'active' : 'paused'}">${rt.active ? 'Active' : 'Paused'}</span>
          <span class="rt-meta-chip">${escapeHtml(describe(rt))}</span>
          <span class="rt-meta-chip">Next run: <strong>${escapeHtml(rt.next_run_date || '—')}</strong></span>
          ${rt.last_run_date ? `<span class="rt-meta-chip">Last run: ${escapeHtml(rt.last_run_date)}</span>` : ''}
          <span class="rt-meta-chip">First start: ${escapeHtml(rt.start_date || '—')}</span>
        </div>
        ${rt.description ? `<div class="rt-detail-desc">${escapeHtml(rt.description)}</div>` : ''}
        <div class="rt-detail-actions">
          <button class="btn-sec" id="rt-detail-toggle">${rt.active ? 'Pause schedule' : 'Resume schedule'}</button>
          <button class="btn-sec" id="rt-detail-run">Run now</button>
          <button class="btn-sec btn-danger" id="rt-detail-delete">Delete schedule</button>
        </div>
      </div>

      <div class="rt-section-divider">
        <span class="rt-section-divider-label">Tickets in this recurring task</span>
        <span class="rt-section-divider-hint">${items.length} ticket${items.length === 1 ? '' : 's'} per run</span>
      </div>

      <div id="rt-tpl-list" class="rt-tpl-list"></div>
      <div id="rt-tpl-empty" class="rt-empty" style="display:none">
        No tickets yet. Click <strong>+ New Ticket</strong> above to add one — same options as a regular ticket.
      </div>
    `;

    $('rt-edit-schedule').addEventListener('click', () => openScheduleModal(rt.id));
    $('rt-add-ticket').addEventListener('click', () => openTemplateModal());
    $('rt-detail-toggle').addEventListener('click', () => toggleActive(rt.id));
    $('rt-detail-run').addEventListener('click', () => runNow(rt.id));
    $('rt-detail-delete').addEventListener('click', () => deleteSchedule(rt.id, /*goBack=*/true));

    renderTemplateList();
  }

  function renderTemplateList() {
    const rt = CURRENT_DETAIL;
    if (!rt) return;
    const list = $('rt-tpl-list');
    const empty = $('rt-tpl-empty');
    const items = rt.items || [];
    if (!items.length) {
      list.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = items.map(it => {
      const assignees = (it.assignees && it.assignees.length) ? it.assignees : (it.assignee ? [it.assignee] : []);
      const tags = it.tags || [];
      const checklist = it.checklist || [];
      return `
        <div class="rt-tpl-card" data-item-id="${it.id}">
          <div class="rt-tpl-head">
            <div style="flex:1;min-width:0">
              <div class="rt-tpl-title">${escapeHtml(it.title || '(untitled)')}</div>
              <div class="rt-tpl-line">
                <span class="rt-pill prio-${escapeHtml(it.priority || 'Medium')}">${escapeHtml(it.priority || 'Medium')}</span>
                ${assignees.length
                  ? '<span class="rt-tpl-meta">Assignees: ' + assignees.map(a => `<span class="rt-chip rt-chip-static">${escapeHtml(a)}</span>`).join('') + '</span>'
                  : '<span class="rt-tpl-meta rt-muted">No assignees</span>'}
                ${it.dept ? `<span class="rt-tpl-meta">Dept: ${escapeHtml(it.dept)}</span>` : ''}
                <span class="rt-tpl-meta">Due: today + ${escapeHtml(String(it.due_offset_days || 0))} day${(it.due_offset_days || 0) === 1 ? '' : 's'}</span>
                ${it.reporter ? `<span class="rt-tpl-meta">Reporter: ${escapeHtml(it.reporter)}</span>` : ''}
              </div>
              ${it.description ? `<div class="rt-tpl-desc">${escapeHtml(it.description)}</div>` : ''}
              ${tags.length ? `<div class="rt-tpl-tags">${tags.map(t => `<span class="rt-chip rt-chip-tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
              ${checklist.length ? `
                <ul class="rt-tpl-checklist">
                  ${checklist.map(c => `<li>${escapeHtml(typeof c === 'string' ? c : (c.text || ''))}</li>`).join('')}
                </ul>` : ''}
            </div>
            <div class="rt-tpl-actions">
              <button class="btn-sec" data-tpl-action="edit"   data-id="${it.id}">Edit</button>
              <button class="btn-sec btn-danger" data-tpl-action="delete" data-id="${it.id}">Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('button[data-tpl-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const action = btn.dataset.tplAction;
        if (action === 'edit')   openTemplateModal(id);
        if (action === 'delete') deleteTemplate(id);
      });
    });
  }

  // ── Schedule modal (name / description / start / recurrence ONLY) ─────────
  function scheduleModalHtml() {
    return `
      <div id="rt-sched-modal" class="modal-overlay">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title" id="rt-sched-title">New Recurring Task</span>
            <button class="modal-close" id="rt-sched-close">×</button>
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
            <div class="rt-hint">If the month has fewer days (e.g. day 31 in February) it will fire on the last day of that month.</div>
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
          <div class="rt-callout">
            Save first, then open the recurring task to add tickets — each one is a full regular ticket with assignees, tags, checklist, and a due-date offset.
          </div>
          <div class="rt-modal-actions">
            <button class="btn-sec"     id="rt-sched-cancel">Cancel</button>
            <button class="btn-primary" id="rt-sched-save">Save Recurring Task</button>
          </div>
        </div>
      </div>`;
  }

  function wireScheduleModal() {
    $('rt-sched-close').addEventListener('click', closeScheduleModal);
    $('rt-sched-cancel').addEventListener('click', closeScheduleModal);
    $('rt-sched-save').addEventListener('click', saveSchedule);
    $('rt-recur-type').addEventListener('change', updateRecurOptions);
    $('rt-sched-modal').addEventListener('click', (e) => {
      if (e.target.id === 'rt-sched-modal') closeScheduleModal();
    });
  }

  function updateRecurOptions() {
    const t = $('rt-recur-type').value;
    $('rt-opt-monthly-day').style.display = (t === 'monthly_day')   ? '' : 'none';
    $('rt-opt-weekly').style.display      = (t === 'weekly')        ? '' : 'none';
    $('rt-opt-every-n').style.display     = (t === 'every_n_days')  ? '' : 'none';
  }

  function openScheduleModal(id) {
    const titleEl = $('rt-sched-title');
    $('rt-id').value = '';
    $('rt-name').value = '';
    $('rt-desc').value = '';
    $('rt-start').value = new Date().toISOString().slice(0, 10);
    $('rt-recur-type').value = 'monthly_same';
    $('rt-recur-day').value = '';
    $('rt-recur-weekday').value = '1';
    $('rt-recur-interval').value = '';
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
      }
    } else {
      titleEl.textContent = 'New Recurring Task';
    }
    $('rt-sched-modal').classList.add('open');
  }
  function closeScheduleModal() { $('rt-sched-modal').classList.remove('open'); }

  async function saveSchedule() {
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
    };
    if (recurType === 'monthly_day' && (!payload.recur_day || payload.recur_day < 1 || payload.recur_day > 31)) {
      toast('Pick a day between 1 and 31.', 'err'); return;
    }
    if (recurType === 'every_n_days' && (!payload.recur_interval || payload.recur_interval < 1)) {
      toast('Enter how many days between runs.', 'err'); return;
    }
    const btn = $('rt-sched-save');
    btn.disabled = true;
    try {
      let saved;
      if (id) saved = await apiPut('/api/recurring-tasks/' + id, payload);
      else    saved = await apiPost('/api/recurring-tasks', payload);
      closeScheduleModal();
      await reload();
      toast(id ? 'Updated' : 'Created', 'ok');
      // First-time create: jump straight to the detail view so the user
      // can start adding tickets right away — that's the documented flow.
      if (!id && saved && saved.id) goto('#/' + saved.id);
    } catch (e) {
      toast('Could not save: ' + (e.message || 'unknown error'), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ── Template modal (full regular-ticket fields) ───────────────────────────
  function templateModalHtml() {
    return `
      <div id="rt-tpl-modal" class="modal-overlay">
        <div class="modal modal-wide">
          <div class="modal-header">
            <span class="modal-title" id="rt-tpl-title">New Ticket</span>
            <button class="modal-close" id="rt-tpl-close">×</button>
          </div>
          <input type="hidden" id="rt-tpl-id" value=""/>
          <div class="form-row"><label>Title *</label><input type="text" id="rt-tpl-it-title" placeholder="e.g. Run monthly inventory audit"/></div>
          <div class="form-row"><label>Description</label><textarea id="rt-tpl-it-desc" placeholder="Details for this ticket…"></textarea></div>

          <div class="form-grid">
            <div class="form-row">
              <label>Assignees *</label>
              <div class="rt-chips-input">
                <div class="rt-chips-area" id="rt-tpl-asgn-chips"></div>
                <div class="rt-chips-add">
                  <button type="button" class="btn-sec" id="rt-tpl-asgn-add">+ Add assignee</button>
                  <div class="rt-popover" id="rt-tpl-asgn-popover" style="display:none">
                    <input type="text" id="rt-tpl-asgn-search" placeholder="Search team…"/>
                    <div class="rt-popover-list" id="rt-tpl-asgn-list"></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="form-row">
              <label>Reporter <span class="rt-muted">(optional)</span></label>
              <select id="rt-tpl-it-reporter"><option value="">— None —</option></select>
            </div>
            <div class="form-row">
              <label>Priority</label>
              <select id="rt-tpl-it-priority">
                <option>Urgent</option><option>High</option><option selected>Medium</option><option>Low</option>
              </select>
            </div>
            <div class="form-row">
              <label>Department</label>
              <input type="text" id="rt-tpl-it-dept" placeholder="e.g. Engineering"/>
            </div>
            <div class="form-row">
              <label>Due date — days after each run</label>
              <input type="number" id="rt-tpl-it-offset" min="0" max="3650" value="7"/>
              <div class="rt-hint">When the schedule fires, the ticket's due date is set to <strong>that day + this many days</strong>.</div>
            </div>
          </div>

          <div class="form-row">
            <label>Tags <span class="rt-muted">(press Enter or comma to add)</span></label>
            <div class="rt-chips-input">
              <div class="rt-chips-area" id="rt-tpl-tags-chips"></div>
              <input type="text" id="rt-tpl-tags-input" class="rt-chips-textbox" placeholder="Add a tag…"/>
            </div>
          </div>

          <div class="form-row">
            <label>Checklist <span class="rt-muted">(optional)</span></label>
            <div id="rt-tpl-checklist"></div>
            <button type="button" class="rt-add-item-btn" id="rt-tpl-checklist-add">+ Add checklist item</button>
          </div>

          <div class="rt-modal-actions">
            <button class="btn-sec"     id="rt-tpl-cancel">Cancel</button>
            <button class="btn-primary" id="rt-tpl-save">Save Ticket</button>
          </div>
        </div>
      </div>`;
  }

  function wireTemplateModal() {
    $('rt-tpl-close').addEventListener('click', closeTemplateModal);
    $('rt-tpl-cancel').addEventListener('click', closeTemplateModal);
    $('rt-tpl-save').addEventListener('click', saveTemplate);
    $('rt-tpl-modal').addEventListener('click', (e) => {
      if (e.target.id === 'rt-tpl-modal') closeTemplateModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('rt-tpl-modal').classList.contains('open')) closeTemplateModal();
        else if ($('rt-sched-modal').classList.contains('open')) closeScheduleModal();
      }
    });

    // Assignee picker
    const addBtn   = $('rt-tpl-asgn-add');
    const popover  = $('rt-tpl-asgn-popover');
    const searchEl = $('rt-tpl-asgn-search');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = popover.style.display !== 'none';
      popover.style.display = open ? 'none' : 'block';
      if (!open) {
        searchEl.value = '';
        renderAssigneeList('');
        setTimeout(() => searchEl.focus(), 30);
      }
    });
    searchEl.addEventListener('input', () => renderAssigneeList(searchEl.value));
    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && e.target !== addBtn) popover.style.display = 'none';
    });

    // Tags
    const tagsInput = $('rt-tpl-tags-input');
    tagsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = tagsInput.value.trim().replace(/,$/, '');
        if (v && !TPL_DRAFT.tags.includes(v)) {
          TPL_DRAFT.tags.push(v);
          renderTags();
        }
        tagsInput.value = '';
      } else if (e.key === 'Backspace' && !tagsInput.value && TPL_DRAFT.tags.length) {
        TPL_DRAFT.tags.pop();
        renderTags();
      }
    });
    tagsInput.addEventListener('blur', () => {
      const v = tagsInput.value.trim();
      if (v && !TPL_DRAFT.tags.includes(v)) {
        TPL_DRAFT.tags.push(v);
        renderTags();
        tagsInput.value = '';
      }
    });

    // Checklist
    $('rt-tpl-checklist-add').addEventListener('click', () => {
      TPL_DRAFT.checklist.push({ text: '', done: false });
      renderChecklist();
      // Focus the new last input for fast successive entry
      const inputs = $('rt-tpl-checklist').querySelectorAll('input[type=text]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
  }

  function renderAssigneeList(query) {
    const q = (query || '').toLowerCase();
    const list = $('rt-tpl-asgn-list');
    const remaining = TEAM
      .filter(m => !TPL_DRAFT.assignees.includes(m.name))
      .filter(m => !q || m.name.toLowerCase().includes(q));
    if (!remaining.length) {
      list.innerHTML = '<div class="rt-popover-empty">No more matches.</div>';
      return;
    }
    list.innerHTML = remaining.map(m =>
      `<div class="rt-popover-item" data-name="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>`
    ).join('');
    list.querySelectorAll('.rt-popover-item').forEach(el => {
      el.addEventListener('click', () => {
        TPL_DRAFT.assignees.push(el.dataset.name);
        renderAssigneeChips();
        renderAssigneeList($('rt-tpl-asgn-search').value);
      });
    });
  }

  function renderAssigneeChips() {
    const wrap = $('rt-tpl-asgn-chips');
    if (!TPL_DRAFT.assignees.length) {
      wrap.innerHTML = '<span class="rt-muted rt-empty-chips">No assignees yet</span>';
      return;
    }
    wrap.innerHTML = TPL_DRAFT.assignees.map((name, idx) =>
      `<span class="rt-chip">${escapeHtml(name)}<button type="button" class="rt-chip-x" data-rm-asgn="${idx}">×</button></span>`
    ).join('');
    wrap.querySelectorAll('[data-rm-asgn]').forEach(btn => {
      btn.addEventListener('click', () => {
        TPL_DRAFT.assignees.splice(Number(btn.dataset.rmAsgn), 1);
        renderAssigneeChips();
      });
    });
  }

  function renderTags() {
    const wrap = $('rt-tpl-tags-chips');
    if (!TPL_DRAFT.tags.length) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = TPL_DRAFT.tags.map((t, idx) =>
      `<span class="rt-chip rt-chip-tag">#${escapeHtml(t)}<button type="button" class="rt-chip-x" data-rm-tag="${idx}">×</button></span>`
    ).join('');
    wrap.querySelectorAll('[data-rm-tag]').forEach(btn => {
      btn.addEventListener('click', () => {
        TPL_DRAFT.tags.splice(Number(btn.dataset.rmTag), 1);
        renderTags();
      });
    });
  }

  function renderChecklist() {
    const wrap = $('rt-tpl-checklist');
    if (!TPL_DRAFT.checklist.length) {
      wrap.innerHTML = '<div class="rt-muted rt-empty-chips">No checklist items yet</div>';
      return;
    }
    wrap.innerHTML = TPL_DRAFT.checklist.map((c, idx) => `
      <div class="rt-checklist-row">
        <input type="text" data-cl-idx="${idx}" value="${escapeHtml(c.text || '')}" placeholder="Checklist item"/>
        <button type="button" class="rt-item-remove" data-cl-rm="${idx}">×</button>
      </div>`).join('');
    wrap.querySelectorAll('input[data-cl-idx]').forEach(inp => {
      inp.addEventListener('input', () => {
        TPL_DRAFT.checklist[Number(inp.dataset.clIdx)].text = inp.value;
      });
    });
    wrap.querySelectorAll('[data-cl-rm]').forEach(btn => {
      btn.addEventListener('click', () => {
        TPL_DRAFT.checklist.splice(Number(btn.dataset.clRm), 1);
        renderChecklist();
      });
    });
  }

  function fillReporterOptions(selected) {
    const sel = $('rt-tpl-it-reporter');
    sel.innerHTML = '<option value="">— None —</option>' +
      TEAM.map(m => `<option value="${escapeHtml(m.name)}" ${m.name === selected ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('');
  }

  function openTemplateModal(itemId) {
    EDITING_TEMPLATE_ID = itemId || null;
    const titleEl = $('rt-tpl-title');
    const item = itemId
      ? (CURRENT_DETAIL && (CURRENT_DETAIL.items || []).find(x => x.id === itemId))
      : null;

    // Reset draft state
    TPL_DRAFT = { assignees: [], tags: [], checklist: [] };
    $('rt-tpl-id').value = '';
    $('rt-tpl-it-title').value = '';
    $('rt-tpl-it-desc').value = '';
    $('rt-tpl-it-priority').value = 'Medium';
    $('rt-tpl-it-dept').value = '';
    $('rt-tpl-it-offset').value = '7';

    if (item) {
      titleEl.textContent = 'Edit Ticket';
      $('rt-tpl-id').value = item.id;
      $('rt-tpl-it-title').value = item.title || '';
      $('rt-tpl-it-desc').value = item.description || '';
      $('rt-tpl-it-priority').value = item.priority || 'Medium';
      $('rt-tpl-it-dept').value = item.dept || '';
      $('rt-tpl-it-offset').value = String(item.due_offset_days == null ? 7 : item.due_offset_days);
      TPL_DRAFT.assignees = Array.isArray(item.assignees) && item.assignees.length
        ? item.assignees.slice()
        : (item.assignee ? [item.assignee] : []);
      TPL_DRAFT.tags = Array.isArray(item.tags) ? item.tags.slice() : [];
      TPL_DRAFT.checklist = Array.isArray(item.checklist)
        ? item.checklist.map(c => typeof c === 'string' ? { text: c, done: false } : { text: c.text || '', done: !!c.done })
        : [];
      fillReporterOptions(item.reporter || '');
    } else {
      titleEl.textContent = 'New Ticket';
      fillReporterOptions('');
    }
    renderAssigneeChips();
    renderTags();
    renderChecklist();
    $('rt-tpl-asgn-popover').style.display = 'none';
    $('rt-tpl-modal').classList.add('open');
    setTimeout(() => $('rt-tpl-it-title').focus(), 60);
  }

  function closeTemplateModal() {
    $('rt-tpl-modal').classList.remove('open');
    EDITING_TEMPLATE_ID = null;
  }

  async function saveTemplate() {
    if (!CURRENT_DETAIL) return;
    const title = $('rt-tpl-it-title').value.trim();
    if (!title) { toast('Please enter a title.', 'err'); return; }
    if (!TPL_DRAFT.assignees.length) { toast('Please add at least one assignee.', 'err'); return; }
    const offsetRaw = parseInt($('rt-tpl-it-offset').value, 10);
    const due_offset_days = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 7;

    // Sweep any tag still typed but not yet committed into a chip
    const pendingTag = $('rt-tpl-tags-input').value.trim();
    if (pendingTag && !TPL_DRAFT.tags.includes(pendingTag)) {
      TPL_DRAFT.tags.push(pendingTag);
      $('rt-tpl-tags-input').value = '';
    }

    const payload = {
      title,
      description: $('rt-tpl-it-desc').value.trim(),
      assignees: TPL_DRAFT.assignees.slice(),
      reporter: $('rt-tpl-it-reporter').value || '',
      priority: $('rt-tpl-it-priority').value || 'Medium',
      dept: $('rt-tpl-it-dept').value.trim(),
      tags: TPL_DRAFT.tags.slice(),
      checklist: TPL_DRAFT.checklist.filter(c => c.text && c.text.trim()),
      due_offset_days,
    };

    const btn = $('rt-tpl-save');
    btn.disabled = true;
    try {
      const base = '/api/recurring-tasks/' + CURRENT_DETAIL.id + '/items';
      if (EDITING_TEMPLATE_ID) await apiPut(base + '/' + EDITING_TEMPLATE_ID, payload);
      else                     await apiPost(base, payload);
      closeTemplateModal();
      // Refresh the one schedule we're viewing, then re-render the list.
      const fresh = await apiGet('/api/recurring-tasks/' + CURRENT_DETAIL.id);
      const i = RECURRING.findIndex(x => x.id === fresh.id);
      if (i >= 0) RECURRING[i] = fresh;
      CURRENT_DETAIL = fresh;
      renderDetailView();
      toast(EDITING_TEMPLATE_ID ? 'Ticket updated' : 'Ticket added', 'ok');
    } catch (e) {
      toast('Could not save: ' + (e.message || 'unknown error'), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteTemplate(itemId) {
    if (!CURRENT_DETAIL) return;
    if (!confirm('Remove this ticket from the recurring task?')) return;
    try {
      await apiDel('/api/recurring-tasks/' + CURRENT_DETAIL.id + '/items/' + itemId);
      const fresh = await apiGet('/api/recurring-tasks/' + CURRENT_DETAIL.id);
      const i = RECURRING.findIndex(x => x.id === fresh.id);
      if (i >= 0) RECURRING[i] = fresh;
      CURRENT_DETAIL = fresh;
      renderDetailView();
      toast('Removed', 'ok');
    } catch { toast('Could not remove.', 'err'); }
  }

  // ── Schedule-level actions (toggle / run / delete) ─────────────────────────
  async function toggleActive(id) {
    const rt = RECURRING.find(x => x.id === id);
    if (!rt) return;
    try {
      await apiPut('/api/recurring-tasks/' + id, { active: rt.active ? 0 : 1 });
      await reload();
      renderRoute();
    } catch { toast('Could not update.', 'err'); }
  }

  async function runNow(id) {
    if (!confirm('Run this recurring task now? Tickets will be created immediately.')) return;
    try {
      const r = await apiPost('/api/recurring-tasks/' + id + '/run-now', {});
      toast('Created ' + (r.created || 0) + ' ticket(s).', 'ok');
      await reload();
      renderRoute();
    } catch { toast('Could not run now.', 'err'); }
  }

  async function deleteSchedule(id, goBackAfter) {
    if (!confirm('Delete this recurring task? Already-created tickets will remain.')) return;
    try {
      await apiDel('/api/recurring-tasks/' + id);
      await reload();
      if (goBackAfter) goto('#/');
      else renderRoute();
      toast('Deleted', 'ok');
    } catch { toast('Could not delete.', 'err'); }
  }

  async function reload() {
    RECURRING = await apiGet('/api/recurring-tasks');
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      await apiGet('/api/auth/me');
      try { TEAM = await apiGet('/api/team'); } catch { TEAM = []; }
      renderShell();
      await reload();
      renderRoute();
    } catch (e) {
      const root = $('rt-app');
      if (root) root.innerHTML = '<div class="rt-boot" style="color:#dc2626">Failed to load. Please refresh.</div>';
      console.error('[recurring] boot failed:', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
