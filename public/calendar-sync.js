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
  const SOURCES = [
    { key: 'events',    name: 'Calendar events',          desc: 'Meetings, tasks, and deadlines you create on the Calendar page.' },
    { key: 'tickets',   name: 'My ticket due dates',      desc: 'All-day items in Google Calendar for tickets where you\'re the assignee, requester, or creator (open tickets only).' },
    { key: 'reminders', name: 'My Reminders',             desc: 'One-shot and daily personal reminders from the My Reminders page, surfaced at the reminder time.' },
    { key: 'recurring', name: 'Recurring task next runs', desc: 'For each active recurring task you own, an all-day marker on the next date it\'s scheduled to fire.' },
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
          ${SOURCES.map(s => `
            <div class="cs-source-row">
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
