/* Tickets Live — read-only, auto-refreshing responsiveness board.
   Personal mode: the signed-in user's own open tickets, what's waiting on
   their reply, and their reply/close speed. Team mode (Admin/Manager, no
   ?user param): one row per workspace user. Nothing on this page mutates
   anything — it only polls GET /api/tickets-live. */
(() => {
  'use strict';

  const REFRESH_MS = 30000;
  const $app = document.getElementById('tl-app');
  // ?board=<token> = one user's board, ?team=<token> = the whole team view.
  // Either token opens the page WITHOUT a login session — the token is the
  // credential and the page stays read-only.
  const PUBLIC_TOKEN = new URLSearchParams(location.search).get('board');
  const TEAM_TOKEN = new URLSearchParams(location.search).get('team');
  const NO_LOGIN = !!(PUBLIC_TOKEN || TEAM_TOKEN);
  let data = null;         // last /api/tickets-live payload
  let links = null;        // userId → share URL
  let teamLink = null;     // team-board share URL (admins only)
  let skewMs = 0;          // server clock minus client clock
  let lastFetch = 0;

  // ── helpers ────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(p, opts) {
    const r = await fetch(p, Object.assign({ credentials: 'same-origin' }, opts));
    if (r.status === 401 && !NO_LOGIN) { location.href = '/login.html'; throw new Error('unauthorized'); }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || ('HTTP ' + r.status));
    }
    return r.json();
  }
  const apiGet = (p) => api(p);
  const apiPost = (p) => api(p, { method: 'POST' });

  // DB timestamps are UTC "YYYY-MM-DD HH:MM:SS" text.
  const parseUtc = (s) => {
    if (!s) return null;
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? null : d;
  };
  // Ticket due dates are human strings like "May 19, 2026".
  const parseDue = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d) ? null : d;
  };
  const serverNow = () => Date.now() + skewMs;

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
  // Stat formatting for averages (input in hours / days).
  function fmtHoursStat(h) {
    if (h == null) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
    if (h < 48) return (Math.round(h * 10) / 10) + 'h';
    return (Math.round((h / 24) * 10) / 10) + 'd';
  }
  function fmtDaysStat(d) {
    if (d == null) return '—';
    if (d < 1) return fmtHoursStat(d * 24);
    return (Math.round(d * 10) / 10) + 'd';
  }

  const initials = (name) => String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  function avatar(u) {
    if (u.avatarUrl) return `<span class="tl-av"><img src="${esc(u.avatarUrl)}" alt=""/></span>`;
    return `<span class="tl-av" style="background:${esc(u.color || '#2563eb')}">${esc(initials(u.name))}</span>`;
  }

  // A live-ticking duration span. data-epoch = the moment waiting started.
  const timerSpan = (dateObj, cls) => {
    if (!dateObj) return '—';
    return `<span class="${cls || ''}" data-epoch="${dateObj.getTime()}">${fmtDur(serverNow() - dateObj.getTime())}</span>`;
  };

  function waitReasonBadges(t) {
    const b = [];
    if (t.updateRequestedAt) b.push('<span class="tl-badge b-update">📩 Update requested</span>');
    if (t.newCommentSince)   b.push('<span class="tl-badge b-comment">💬 New comment</span>');
    if (t.overdue)           b.push('<span class="tl-badge b-overdue">⏰ Overdue</span>');
    if (t.snoozed)           b.push('<span class="tl-badge b-snoozed">💤 Snoozed</span>');
    return b.join(' ');
  }

  function dueBits(t) {
    const due = parseDue(t.due);
    if (!due) return t.due ? `<span class="due">due ${esc(t.due)}</span>` : '';
    if (t.overdue || due.getTime() < serverNow()) {
      return `<span class="due">⏰ past due ${esc(t.due)} — waiting ${timerSpan(due)}</span>`;
    }
    return `<span class="due">due ${esc(t.due)}</span>`;
  }

  // ── personal board ─────────────────────────────────────────────────────
  function renderUserBoard(u) {
    const waiting = u.tickets.filter(t => t.needsReply)
      .sort((a, b) => String(a.waitingSince).localeCompare(String(b.waitingSince)));
    const others = u.tickets.filter(t => !t.needsReply)
      .sort((a, b) => Number(b.overdue) - Number(a.overdue));

    const waitRows = waiting.map(t => {
      const since = parseUtc(t.waitingSince);
      const due = parseDue(t.due);
      const pastDue = due && (t.overdue || due.getTime() < serverNow());
      // A pending update request blinks red until the user replies.
      return `
      <div class="tl-row ${t.updateRequestedAt ? 'urgent' : ''}">
        <div class="tl-row-main">
          <div class="tl-row-title"><span class="tid">${esc(t.id)}</span>${esc(t.title)}</div>
          <div class="tl-row-meta">${waitReasonBadges(t)}
            <span class="tl-badge b-prio">${esc(t.priority)}</span>
            ${t.due ? `<span class="due">${pastDue ? '⏰ was due' : 'due'} ${esc(t.due)}</span>` : ''}
          </div>
        </div>
        <div class="tl-wait">
          <div class="tl-wait-timer ${pastDue ? 'crit' : ''}">${timerSpan(since)}</div>
          <div class="tl-wait-sub">waiting for your reply${pastDue && due ? ` · ${timerSpan(due)} past due` : ''}</div>
        </div>
      </div>`;
    }).join('');

    const otherRows = others.map(t => `
      <div class="tl-row">
        <div class="tl-row-main">
          <div class="tl-row-title"><span class="tid">${esc(t.id)}</span>${esc(t.title)}</div>
          <div class="tl-row-meta">
            ${t.overdue ? '<span class="tl-badge b-overdue">⏰ Overdue</span>' : ''}
            ${t.snoozed ? '<span class="tl-badge b-snoozed">💤 Snoozed</span>' : ''}
            <span class="tl-badge b-prio">${esc(t.priority)}</span>
            ${dueBits(t)}
          </div>
        </div>
      </div>`).join('');

    const prioOrder = ['Urgent', 'High', 'Medium', 'Low'];
    const prioChips = prioOrder
      .map(p => [p, u.tickets.filter(t => t.priority === p).length])
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `<span class="tl-chip">${esc(p)} <b>${n}</b></span>`).join('');

    const responded = Math.max(0, u.openCount - u.needsReplyCount);
    const pct = u.openCount ? Math.round((responded / u.openCount) * 100) : 100;

    return `
    <div class="tl-grid">
      <div class="tl-left">
        <div class="tl-tile t-serious">
          <div class="tl-tile-label">⏳ Waiting on your reply</div>
          <div class="tl-tile-big">${u.needsReplyCount}</div>
          <div class="tl-chips">
            <span class="tl-chip c-warning">📩 Update requested <b>${u.updateRequestedCount}</b></span>
            <span class="tl-chip">💬 New comment <b>${u.newCommentCount}</b></span>
            <span class="tl-chip c-critical">⏰ Overdue <b>${u.overdueCount}</b></span>
          </div>
          <div class="tl-tile-foot">tickets where teammates are waiting for you</div>
        </div>
        <div class="tl-tile t-neutral">
          <div class="tl-tile-label">🗂 Open tickets</div>
          <div class="tl-tile-big">${u.openCount}</div>
          <div class="tl-chips">${prioChips || '<span class="tl-chip">none 🎉</span>'}</div>
          <div class="tl-tile-foot">assigned to ${esc(u.name)}, not closed</div>
        </div>
        <div class="tl-speed-row">
          <div class="tl-tile tl-speed">
            <div class="tl-tile-label">↩️ Avg time to reply</div>
            <div class="tl-speed-big">${fmtHoursStat(u.avgReplyHours30)}</div>
            <div class="tl-speed-sub">last 30 days (${u.repliesCount30} ${u.repliesCount30 === 1 ? 'reply' : 'replies'}) · all-time ${fmtHoursStat(u.avgReplyHoursAll)}</div>
          </div>
          <div class="tl-tile tl-speed">
            <div class="tl-tile-label">✅ Avg time to close</div>
            <div class="tl-speed-big">${fmtDaysStat(u.avgCloseDays30)}</div>
            <div class="tl-speed-sub">last 30 days (${u.closedCount30} closed) · all-time ${fmtDaysStat(u.avgCloseDaysAll)}</div>
          </div>
        </div>
      </div>
      <div class="tl-right">
        <div class="tl-panel">
          <div class="tl-panel-title">🔥 Needs your reply <span class="cnt">${waiting.length}</span></div>
          ${waitRows || '<div class="tl-empty">🎉 Nothing is waiting on you — all caught up.</div>'}
        </div>
        <div class="tl-panel">
          <div class="tl-panel-title">📋 Other open tickets <span class="cnt">${others.length}</span></div>
          ${otherRows || '<div class="tl-empty">No other open tickets.</div>'}
        </div>
        <div class="tl-progress">
          <div class="tl-progress-top"><span>Replied / up to date</span><span class="pct">${pct}%</span></div>
          <div class="tl-bar"><div class="tl-bar-fill" style="width:${pct}%"></div></div>
          <div class="tl-progress-sub">${responded} of ${u.openCount} open tickets are not waiting on your reply · ${u.needsReplyCount} to go</div>
        </div>
      </div>
    </div>`;
  }

  // ── team board (Admin/Manager, no ?user) ───────────────────────────────
  function longestWait(u) {
    const w = u.tickets.filter(t => t.needsReply && t.waitingSince).map(t => t.waitingSince).sort();
    return w.length ? parseUtc(w[0]) : null;
  }

  function renderTeamBoard(users) {
    const sum = (k) => users.reduce((a, u) => a + (u[k] || 0), 0);
    // Longest wait = earliest waitingSince → smaller epoch sorts first.
    const lwEpoch = (u) => { const d = longestWait(u); return d ? d.getTime() : Infinity; };
    const ranked = users.slice().sort((a, b) =>
      (b.needsReplyCount - a.needsReplyCount)
      || (lwEpoch(a) - lwEpoch(b))
      || (b.overdueCount - a.overdueCount)
      || (b.openCount - a.openCount));

    const rows = ranked.map((u, i) => {
      const lw = longestWait(u);
      // Row links use the user's secret board token (same URL as the share
      // link) instead of a guessable ?user=<id>. Until the links map has
      // loaded there's nothing safe to link to, so the row is inert.
      const href = links && links[u.id] ? esc(links[u.id]) : '#';
      return `
      <a class="tl-trow" href="${href}">
        <div class="tl-rank">${i + 1}</div>
        <div class="tl-user">${avatar(u)}<div style="min-width:0"><div class="nm">${esc(u.name)}</div><div class="rl">${esc(u.role || u.dept || '')}</div></div>
          ${!data.public && links && links[u.id] ? `<span class="tl-rowacts">
            <button class="tl-iconbtn tl-copy" data-url="${esc(links[u.id])}" title="Copy ${esc(u.name)}'s board link (opens without login)">🔗</button>
            <button class="tl-iconbtn tl-rotate" data-user="${u.id}" title="Reset link (old link stops working)">↻</button>
          </span>` : ''}
        </div>
        <div><div class="num ${u.needsReplyCount ? 'n-serious' : 'n-zero'}">${u.needsReplyCount}${u.updateRequestedCount ? '<span class="tl-reddot" title="Update requested — still no reply"></span>' : ''}</div><div class="sub">waiting</div></div>
        <div>${lw ? `<span class="tl-team-timer" data-epoch="${lw.getTime()}">${fmtDur(serverNow() - lw.getTime())}</span>` : '<span class="num n-zero">—</span>'}<div class="sub">longest wait</div></div>
        <div class="hide-sm"><div class="num">${u.openCount}</div><div class="sub">open</div></div>
        <div class="hide-sm"><div class="num ${u.overdueCount ? 'n-critical' : 'n-zero'}">${u.overdueCount}</div><div class="sub">overdue</div></div>
        <div class="hide-sm"><div class="num">${fmtHoursStat(u.avgReplyHours30)}</div><div class="sub">avg reply · 30d</div></div>
        <div class="hide-sm"><div class="num">${fmtDaysStat(u.avgCloseDays30)}</div><div class="sub">avg close · 30d</div></div>
      </a>`;
    }).join('');

    return `
    <div class="tl-team-tiles">
      <div class="tl-tile t-serious">
        <div class="tl-tile-label">⏳ Waiting for a reply</div>
        <div class="tl-tile-big">${sum('needsReplyCount')}</div>
        <div class="tl-tile-foot">update requests + unanswered comments, team-wide</div>
      </div>
      <div class="tl-tile t-neutral">
        <div class="tl-tile-label">🗂 Open tickets</div>
        <div class="tl-tile-big">${sum('openCount')}</div>
        <div class="tl-tile-foot">across ${users.length} users</div>
      </div>
      <div class="tl-tile t-critical">
        <div class="tl-tile-label">⏰ Overdue</div>
        <div class="tl-tile-big">${sum('overdueCount')}</div>
        <div class="tl-tile-foot">open tickets past their due date</div>
      </div>
    </div>
    <div class="tl-panel">
      <div class="tl-panel-title">🏆 Response board <span class="cnt">${users.length} users</span></div>
      <div class="tl-thead">
        <div>#</div><div>User</div><div>Waiting</div><div>Longest wait</div>
        <div class="hide-sm">Open</div><div class="hide-sm">Overdue</div>
        <div class="hide-sm">Avg reply</div><div class="hide-sm">Avg close</div>
      </div>
      ${rows}
    </div>`;
  }

  // ── shell ──────────────────────────────────────────────────────────────
  function render() {
    if (!data) return;
    const single = data.mode === 'user';
    const board = single ? data.users[0] : null;
    const backLink = (single && data.viewer?.isAdmin)
      ? `<a href="/tickets-live.html" style="color:var(--ink-3);font-size:13px;text-decoration:none">← All users</a>` : '';
    const sub = data.public
      ? (single ? `${esc(board.name)}'s live board` : 'Team live board')
      : (single ? 'Your ticket response board' : 'Team ticket response board');
    let shareBtns = '';
    if (!data.public && single && links && links[board.id]) {
      shareBtns = `
          <span class="tl-share">
            <button class="tl-linkbtn tl-copy" data-url="${esc(links[board.id])}" title="${esc(links[board.id])}">🔗 Copy board link</button>
            ${data.viewer?.isAdmin ? `<button class="tl-iconbtn tl-rotate" data-user="${board.id}" title="Reset this link (old link stops working)">↻</button>` : ''}
          </span>`;
    } else if (!data.public && !single && data.viewer?.isAdmin && teamLink) {
      shareBtns = `
          <span class="tl-share">
            <button class="tl-linkbtn tl-copy" data-url="${esc(teamLink)}" title="${esc(teamLink)}">🔗 Copy team board link</button>
            <button class="tl-iconbtn tl-rotate" data-team="1" title="Reset the team link (old link stops working)">↻</button>
          </span>`;
    }

    $app.innerHTML = `
      <div class="tl-header">
        <div class="tl-brand">S</div>
        <div>
          <div class="tl-title">Tickets Live <span class="tl-live"><span class="tl-live-dot"></span>LIVE</span></div>
          <div class="tl-sub">${sub} · refreshes every ${REFRESH_MS / 1000}s ${backLink}</div>
        </div>
        <div class="tl-header-right">
          ${shareBtns}
          ${board ? `<span class="tl-who">${avatar(board)} ${esc(board.name)}</span>` : ''}
          <div class="tl-clock" id="tl-clock"></div>
          <button class="tl-fs" id="tl-fs" title="Fullscreen">⛶</button>
        </div>
      </div>
      ${single ? renderUserBoard(board) : renderTeamBoard(data.users)}
      <div class="tl-note" id="tl-note"></div>`;

    document.getElementById('tl-fs').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    };
    tick();
  }

  // Update the clock and every live timer once a second.
  function tick() {
    const now = serverNow();
    const clock = document.getElementById('tl-clock');
    if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    document.querySelectorAll('[data-epoch]').forEach(el => {
      el.textContent = fmtDur(now - Number(el.dataset.epoch));
    });
    const note = document.getElementById('tl-note');
    if (note && lastFetch) note.textContent = `Read-only board · last updated ${Math.max(0, Math.round((Date.now() - lastFetch) / 1000))}s ago`;
  }

  async function load() {
    const qs = new URLSearchParams(location.search);
    let url;
    if (PUBLIC_TOKEN)      url = '/api/tickets-live/board/' + encodeURIComponent(PUBLIC_TOKEN);
    else if (TEAM_TOKEN)   url = '/api/tickets-live/team/' + encodeURIComponent(TEAM_TOKEN);
    else                   url = '/api/tickets-live' + (qs.get('user') ? ('?user=' + encodeURIComponent(qs.get('user'))) : '');
    const payload = await apiGet(url);
    const sv = parseUtc(payload.now);
    if (sv) skewMs = sv.getTime() - Date.now();
    data = payload;
    // The public team payload ships each user's board URL so rows stay
    // clickable without a session.
    if (payload.links) links = payload.links;
    lastFetch = Date.now();
    render();
  }

  // Share links: members get their own, Admin/Manager gets everyone's
  // plus the team-board link.
  async function loadLinks() {
    if (NO_LOGIN || !data?.viewer) return;
    const map = {};
    if (data.viewer.isAdmin) {
      (await apiGet('/api/tickets-live/links')).forEach(l => { map[l.id] = l.url; });
      teamLink = (await apiGet('/api/tickets-live/team-link')).url;
    } else {
      const l = await apiGet('/api/tickets-live/my-link');
      map[l.userId] = l.url;
    }
    links = map;
  }

  function flash(btn, text) {
    const prev = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = prev; }, 1400);
  }

  async function onAction(e) {
    const copy = e.target.closest('.tl-copy');
    const rotate = e.target.closest('.tl-rotate');
    if (!copy && !rotate) return;
    e.preventDefault();
    e.stopPropagation();
    if (copy) {
      const url = copy.dataset.url;
      try { await navigator.clipboard.writeText(url); flash(copy, copy.classList.contains('tl-linkbtn') ? '✓ Copied' : '✓'); }
      catch { window.prompt('Copy this link:', url); }
    } else if (rotate) {
      if (!window.confirm('Reset this board link? The old link will stop working immediately.')) return;
      try {
        if (rotate.dataset.team) {
          teamLink = (await apiPost('/api/tickets-live/team-link/rotate')).url;
        } else {
          const r = await apiPost('/api/tickets-live/links/' + encodeURIComponent(rotate.dataset.user) + '/rotate');
          if (links) links[Number(rotate.dataset.user)] = r.url;
        }
        render();
      } catch (err) { window.alert('Could not reset the link: ' + err.message); }
    }
  }

  async function boot() {
    try {
      if (!NO_LOGIN) await apiGet('/api/auth/me');   // 401 → redirected to /login.html
      await load();
      if (!NO_LOGIN) { await loadLinks().catch(() => {}); render(); }
      $app.addEventListener('click', onAction);
      setInterval(() => load().catch(() => {}), REFRESH_MS);
      setInterval(tick, 1000);
    } catch (e) {
      const msg = NO_LOGIN
        ? 'This board link is invalid or has been reset — ask your admin for a new one.'
        : `Couldn't load the live board: ${esc(e.message)}`;
      if ($app) $app.innerHTML = `<div class="tl-error">${msg}</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
