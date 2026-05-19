// ============================================================
// Calendar Sync (Google / Apple / Outlook / Notion)
//
// One-way export from this workspace to any external calendar that
// supports "Subscribe by URL". The user picks which sources to
// include, then pastes the URL into Google Calendar.
//
// Backed by:
//   GET  /api/calendar/sync-info        — token + current toggles
//   POST /api/calendar/sync-settings    — save toggles
//   POST /api/calendar/sync-regenerate  — rotate the URL
//   GET  /api/calendar/feed/<token>.ics — the public feed
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
  async function apiPost(p, body) {
    const r = await fetch(p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data.error || ('POST ' + p + ' failed'));
    return data;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    let el = $('cs-toast');
    if (!el) { el = document.createElement('div'); el.id = 'cs-toast'; document.body.appendChild(el); }
    el.className = 'show ' + (kind === 'err' ? 'err' : (kind === 'ok' ? 'ok' : ''));
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = el.className.replace('show','').trim(); }, 2800);
  }

  // ── Sources ────────────────────────────────────────────────────────────────
  // Each calendar-event subtype is its own toggle — most users only want
  // their meetings to land in a shared external calendar and prefer to
  // keep personal tasks / private deadlines out of it. Tickets,
  // reminders, and recurring tasks stay as single toggles since they're
  // already a single category each.
  const SOURCES = [
    { key: 'meetings',  group: 'Calendar events', name: 'Meetings',                desc: 'Meetings you create on the Calendar page (including any video link from the Location field).' },
    { key: 'tasks',     group: 'Calendar events', name: 'Tasks',                   desc: 'Calendar tasks you assign to yourself or others — handy if your external calendar is also your to-do list.' },
    { key: 'deadlines', group: 'Calendar events', name: 'Deadlines',               desc: 'Calendar deadlines you set on the calendar page (independent of ticket due dates).' },
    { key: 'tickets',   group: 'Other',           name: 'My ticket due dates',     desc: 'All-day items for tickets where you\'re the assignee, requester, or creator (open tickets only).' },
    { key: 'reminders', group: 'Other',           name: 'My Reminders',            desc: 'One-shot and daily personal reminders from the My Reminders page, at the reminder time.' },
    { key: 'recurring', group: 'Other',           name: 'Recurring task next runs', desc: 'For each active recurring task you own, an all-day marker on the next date it\'s scheduled to fire.' },
  ];

  let STATE = { url: '', token: '', sources: {} };

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const root = $('cs-app');
    root.innerHTML = `
      <div class="cs-page">
        <div class="cs-header">
          <a class="cs-back" href="/calendar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Back to calendar
          </a>
          <h1 class="cs-title">Sync to Google Calendar</h1>
        </div>
        <p class="cs-lede">
          Subscribe Google Calendar (or any other calendar app — Apple Calendar, Outlook, Fantastical, Notion) to this URL and your Syruvia activity shows up alongside the rest of your schedule. The feed updates live; Google polls it on its own clock, typically every few hours. Two-way sync (events you create in Google flowing into Syruvia) will come later as a separate Google account connection.
        </p>

        <div class="cs-card">
          <div class="cs-card-head">
            <span class="cs-card-title">Your subscribe URL</span>
            <span class="cs-card-hint">Keep this private — anyone with the URL can read your events</span>
          </div>
          <div class="cs-url-row">
            <input class="cs-url-input" id="cs-url" type="text" readonly value="${escapeHtml(STATE.url)}"/>
            <button class="btn btn-primary" id="cs-copy">Copy URL</button>
            <button class="btn btn-danger" id="cs-regenerate" title="Generate a new URL — the old one will stop working">Regenerate</button>
          </div>
        </div>

        <div class="cs-card">
          <div class="cs-card-head">
            <span class="cs-card-title">What to include</span>
            <span class="cs-card-hint">Toggles apply on the next Google poll</span>
          </div>
          ${renderSourceGroups()}
        </div>

        <div class="cs-card">
          <div class="cs-card-head">
            <span class="cs-card-title">How to add it to Google Calendar</span>
          </div>
          <ol class="cs-steps">
            <li>Open <a href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" target="_blank" rel="noopener"><strong>Google Calendar → Settings → Add calendar → From URL</strong></a>.</li>
            <li>Paste the URL above into the <code>URL of calendar</code> field.</li>
            <li>Click <strong>Add calendar</strong>. It will appear under <em>Other calendars</em>.</li>
            <li>It may take Google a few minutes to do the first pull, and after that it usually polls every 4–12 hours — that's Google's clock, not ours.</li>
          </ol>
          <div class="cs-callout">
            Tip: Apple Calendar (<strong>File → New Calendar Subscription</strong>) and Outlook (<strong>Add calendar → Subscribe from web</strong>) accept the same URL. Outlook even lets you set the refresh interval yourself.
          </div>
        </div>
      </div>
    `;

    $('cs-copy').addEventListener('click', onCopy);
    $('cs-regenerate').addEventListener('click', onRegenerate);
    document.querySelectorAll('input[data-source]').forEach(el => {
      el.addEventListener('change', onSourceToggle);
    });
    document.querySelectorAll('button[data-bulk]').forEach(el => {
      el.addEventListener('click', onBulkClick);
    });
  }

  // Render the source rows grouped by their `group` field, with a small
  // group-level heading and "All / None" shortcuts for the multi-row
  // groups (right now only "Calendar events"). Keeps the toggles
  // visually organised without changing how individual rows are saved.
  function renderSourceGroups() {
    const groups = {};
    for (const s of SOURCES) {
      if (!groups[s.group]) groups[s.group] = [];
      groups[s.group].push(s);
    }
    return Object.entries(groups).map(([groupName, items]) => `
      <div class="cs-group">
        <div class="cs-group-head">
          <span class="cs-group-title">${escapeHtml(groupName)}</span>
          ${items.length > 1
            ? `<span class="cs-group-bulk">
                 <button class="cs-bulk-btn" data-bulk="all"  data-group="${escapeHtml(groupName)}" type="button">All</button>
                 <button class="cs-bulk-btn" data-bulk="none" data-group="${escapeHtml(groupName)}" type="button">None</button>
               </span>`
            : ''}
        </div>
        ${items.map(s => `
          <div class="cs-source-row" data-source-group="${escapeHtml(groupName)}">
            <label>
              <input type="checkbox" data-source="${s.key}" ${STATE.sources[s.key] ? 'checked' : ''}/>
              <div>
                <div class="cs-source-name">${escapeHtml(s.name)}</div>
                <div class="cs-source-desc">${escapeHtml(s.desc)}</div>
              </div>
            </label>
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  // "All" / "None" shortcut inside one group. Sets every checkbox in the
  // group, then sends one combined PATCH instead of triggering N saves.
  async function onBulkClick(e) {
    const group = e.target.dataset.group;
    const want = e.target.dataset.bulk === 'all';
    const rows = document.querySelectorAll(`.cs-source-row[data-source-group="${CSS.escape(group)}"] input[data-source]`);
    const changed = [];
    rows.forEach(r => {
      if (r.checked !== want) {
        r.checked = want;
        STATE.sources[r.dataset.source] = want;
        changed.push(r.dataset.source);
      }
    });
    if (!changed.length) return;
    try {
      await apiPost('/api/calendar/sync-settings', STATE.sources);
      toast(want ? `Including all ${group.toLowerCase()}` : `Skipping all ${group.toLowerCase()}`, 'ok');
    } catch {
      // Roll back the UI on failure so the user sees the truth.
      rows.forEach(r => { r.checked = !want; STATE.sources[r.dataset.source] = !want; });
      toast('Could not save', 'err');
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function onCopy() {
    const input = $('cs-url');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('URL copied to clipboard', 'ok');
    } catch {
      // Fallback for older browsers / non-HTTPS contexts.
      input.select();
      try { document.execCommand('copy'); toast('URL copied', 'ok'); }
      catch { toast('Couldn\'t copy automatically — please select and copy manually.', 'err'); }
    }
  }

  async function onRegenerate() {
    const ok = await uiConfirm(
      'Generating a new URL will immediately break the old one — Google Calendar will stop syncing until you paste the new URL into its calendar settings. Continue?',
      { title: 'Regenerate subscribe URL', okText: 'Regenerate', cancelText: 'Keep current', danger: true }
    );
    if (!ok) return;
    try {
      const r = await apiPost('/api/calendar/sync-regenerate', {});
      STATE.url = r.url;
      STATE.token = r.token;
      $('cs-url').value = r.url;
      toast('New URL generated — update your Google Calendar subscription.', 'ok');
    } catch (e) {
      toast('Could not regenerate: ' + (e.message || ''), 'err');
    }
  }

  async function onSourceToggle(e) {
    const key = e.target.dataset.source;
    STATE.sources[key] = !!e.target.checked;
    try {
      await apiPost('/api/calendar/sync-settings', STATE.sources);
      toast('Saved', 'ok');
    } catch {
      // Roll back the UI on failure so the user sees the truth.
      e.target.checked = !e.target.checked;
      STATE.sources[key] = !!e.target.checked;
      toast('Could not save toggle', 'err');
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      const info = await apiGet('/api/calendar/sync-info');
      STATE = {
        url: info.url || '',
        token: info.token || '',
        sources: info.sources || {},
      };
      render();
    } catch (e) {
      const root = $('cs-app');
      if (root) root.innerHTML = '<div class="cs-boot" style="color:#dc2626">Failed to load sync info. Please refresh.</div>';
      console.error('[calendar-sync] boot failed:', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
