// ============================================================
// Flavor Reviews — standalone page
//
// Hash-routed inside the same HTML shell:
//
//   #/                  → Dashboard (today's queue + AI priority + stats)
//   #/flavors           → All flavors (catalog, filter, search)
//   #/flavor/:id        → Flavor detail (overview, sell-links)
//   #/flavor/:id/reviews→ Reviews tab
//   #/flavor/:id/issues → Issues tab
//   #/issue/:id         → Issue detail (fix / ignore / merge)
//   #/calendar          → Calendar of scheduled review cycles
//   #/calendar/:yyyy-mm → Specific month
//   #/bulk-import       → Paste CSV/TSV to add many flavors
//   #/settings          → Cadence, default reviewer, AI threshold
//
// Every non-dashboard view has a back-to-dashboard link AND a breadcrumb.
// ============================================================

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const escapeAttr = escapeHtml;

  // ── API helpers ────────────────────────────────────────────────────────
  async function apiGet(p) {
    const r = await fetch(p, { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    if (!r.ok) {
      let msg = 'GET ' + p + ' failed';
      try { const j = await r.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
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
  const apiPost  = (p, b) => apiSend('POST', p, b);
  const apiPatch = (p, b) => apiSend('PATCH', p, b);
  const apiDel   = (p)    => apiSend('DELETE', p);

  // ── Toast ─────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    let el = $('fr-toast');
    if (!el) { el = document.createElement('div'); el.id = 'fr-toast'; document.body.appendChild(el); }
    el.className = 'show ' + (kind === 'err' ? 'err' : (kind === 'ok' ? 'ok' : ''));
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = el.className.replace('show', '').trim(); }, 2800);
  }

  // ── State ──────────────────────────────────────────────────────────────
  let CURRENT_USER = null;
  let SETTINGS_CACHE = null;

  // ── Auth on boot ──────────────────────────────────────────────────────
  async function checkAuth() {
    try {
      const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!me.ok) { location.href = '/login.html'; return false; }
      CURRENT_USER = await me.json();
      return true;
    } catch {
      location.href = '/login.html'; return false;
    }
  }

  // ── Router ─────────────────────────────────────────────────────────────
  function currentRoute() {
    const h = (location.hash || '').replace(/^#/, '');
    if (!h || h === '/') return { view: 'dashboard' };
    const m1 = /^\/flavors\/?$/.exec(h);             if (m1) return { view: 'flavors' };
    const m2 = /^\/flavor\/(\d+)\/?$/.exec(h);       if (m2) return { view: 'flavor', id: Number(m2[1]), tab: 'overview' };
    const m3 = /^\/flavor\/(\d+)\/reviews\/?$/.exec(h); if (m3) return { view: 'flavor', id: Number(m3[1]), tab: 'reviews' };
    const m4 = /^\/flavor\/(\d+)\/issues\/?$/.exec(h);  if (m4) return { view: 'flavor', id: Number(m4[1]), tab: 'issues' };
    const m5 = /^\/issue\/(\d+)\/?$/.exec(h);        if (m5) return { view: 'issue', id: Number(m5[1]) };
    const m6 = /^\/calendar\/?$/.exec(h);            if (m6) return { view: 'calendar' };
    const m7 = /^\/calendar\/(\d{4}-\d{2})\/?$/.exec(h); if (m7) return { view: 'calendar', month: m7[1] };
    if (h === '/bulk-import') return { view: 'bulk-import' };
    if (h === '/import')      return { view: 'import' };
    if (h === '/settings')    return { view: 'settings' };
    const m8 = /^\/flavor\/(\d+)\/reviews-import\/?$/.exec(h);
    if (m8) return { view: 'reviews-import', id: Number(m8[1]) };
    return { view: 'dashboard' };
  }
  function goto(hash) { location.hash = hash; }
  window.addEventListener('hashchange', () => renderRoute());

  // ── Shared chrome ──────────────────────────────────────────────────────
  function backChip(href, label) {
    return `<a class="fr-back" onclick="window.location.hash='${href}'">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      ${escapeHtml(label || 'Dashboard')}
    </a>`;
  }
  function breadcrumb(parts) {
    return `<div class="fr-breadcrumb">${parts.map((p, i) => {
      const sep = i > 0 ? '<span class="sep">›</span>' : '';
      if (p.href) return `${sep}<a onclick="window.location.hash='${p.href}'">${escapeHtml(p.label)}</a>`;
      return `${sep}<span>${escapeHtml(p.label)}</span>`;
    }).join('')}</div>`;
  }

  function pageShell(innerHtml) {
    $('fr-app').innerHTML = `<div class="fr-page">${innerHtml}</div>`;
  }

  function loadingShell() {
    pageShell(`<div class="fr-loading">Loading…</div>`);
  }

  // ── Dashboard ──────────────────────────────────────────────────────────
  async function renderDashboard() {
    loadingShell();
    let data;
    try { data = await apiGet('/api/flavor-reviews/dashboard'); }
    catch (e) { pageShell(`<div class="empty-state"><div class="es-emoji">⚠️</div><div class="es-title">Couldn't load dashboard</div><div>${escapeHtml(e.message)}</div></div>`); return; }

    const totals = data.totals;
    const tQueue = data.today_queue;
    const ai = data.ai_priority;
    const ri = data.recent_issues;

    const queueHtml = tQueue.length ? tQueue.map(c => {
      const score = (c.priority || 3) + (c.ai_priority_bump || 0);
      const pcls = score >= 5 ? 'p5' : score >= 4 ? 'p4' : '';
      const overdue = c.scheduled_for < todayUtc();
      const bump = c.ai_priority_bump ? `<span class="ai-bump" title="AI bumped priority because of recent bad reviews">✨ AI +${c.ai_priority_bump}</span>` : '';
      return `
        <div class="queue-item" onclick="window.location.hash='/flavor/${c.flavor_id}'">
          <div class="prio ${pcls}">${score}</div>
          <div>
            <div class="name">
              ${escapeHtml(c.flavor_name)}
              <span class="pill kind-${escapeAttr(c.flavor_kind || 'other')}">${escapeHtml(c.flavor_kind || 'other')}</span>
              <span class="pill variant-${escapeAttr(c.flavor_variant || 'regular')}">${escapeHtml((c.flavor_variant || '').replace('_', '-'))}</span>
              ${bump}
            </div>
            <div class="meta">
              <span class="${overdue ? 'due-overdue' : ''}">Due ${escapeHtml(prettyDate(c.scheduled_for))}${overdue ? ' (overdue)' : ''}</span>
              ${c.assignee_name ? `<span>Assigned to ${escapeHtml(c.assignee_name)}</span>` : '<span>Unassigned</span>'}
            </div>
          </div>
          <div>
            <button class="btn-sec" onclick="event.stopPropagation(); FR.startCycle(${c.id})">Start</button>
          </div>
        </div>`;
    }).join('') : `<div class="dash-empty">Nothing due today. ${totals.flavors === 0 ? 'Add some flavors to get started.' : 'You\'re ahead — check the calendar for what\'s next.'}</div>`;

    const aiHtml = ai.length ? ai.map(p => `
      <div class="prio-flavor" onclick="window.location.hash='/flavor/${p.id}'">
        <div>
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="kind">${escapeHtml(p.kind)} · ${escapeHtml((p.variant || '').replace('_', '-'))}</div>
        </div>
        <span class="badge-bad">${p.bad_count} bad</span>
      </div>
    `).join('') : `<div class="dash-empty" style="padding:18px">No flavors with open bad reviews right now. 🎉</div>`;

    const recentIssuesHtml = ri.length ? ri.map(i => `
      <div class="issue-row" onclick="window.location.hash='/issue/${i.id}'">
        <span class="pill sev-${escapeAttr(i.severity)}">${escapeHtml(i.severity)}</span>
        <div>
          <div class="ir-title">${escapeHtml(i.title)}</div>
          <div class="ir-meta">
            <span>${escapeHtml(i.flavor_name || '')}</span>
            <span>${i.review_count} review${i.review_count === 1 ? '' : 's'}</span>
            <span>Updated ${escapeHtml(prettyDate(i.updated_at))}</span>
          </div>
        </div>
        <span class="pill status-${escapeAttr(i.status)}">${escapeHtml(i.status)}</span>
      </div>
    `).join('') : `<div class="dash-empty" style="padding:18px">No open issues. Bad reviews can be turned into issues from the flavor detail page.</div>`;

    pageShell(`
      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title"><span class="fr-emoji">🫙</span> Flavor Reviews</h1>
          <p class="fr-lede">Track customer reviews across every channel, fix what needs fixing, and stay on top of a regular review cycle for every flavor. The dashboard shows what's due today and what AI thinks deserves a closer look.</p>
        </div>
        <div class="fr-header-actions">
          <button class="btn-sec" onclick="window.location.hash='/calendar'">📅 Calendar</button>
          <button class="btn-sec" onclick="window.location.hash='/flavors'">All flavors</button>
          ${data.ai_enabled ? `<button class="btn-sec btn-ai" id="dash-refresh-ai">✨ Refresh AI priority</button>` : ''}
          ${data.ai_enabled ? `<button class="btn-sec btn-ai" onclick="window.location.hash='/import'">✨ Import from Amazon URL</button>` : ''}
          <button class="btn-primary" onclick="window.location.hash='/bulk-import'">+ Add flavors</button>
        </div>
      </div>

      <div class="fr-stats">
        <div class="fr-stat">
          <div class="lbl">Flavors tracked</div>
          <div class="val">${totals.flavors}</div>
          <div class="delta"><a onclick="window.location.hash='/flavors'" style="color:var(--accent);cursor:pointer">View all →</a></div>
        </div>
        <div class="fr-stat ${totals.cycles_due > 0 ? 'warn' : ''}">
          <div class="lbl">Cycles due</div>
          <div class="val">${totals.cycles_due}</div>
          <div class="delta">Review work waiting for you</div>
        </div>
        <div class="fr-stat ${totals.open_bad_reviews > 0 ? 'alert' : ''}">
          <div class="lbl">Open bad reviews</div>
          <div class="val">${totals.open_bad_reviews}</div>
          <div class="delta">1–2★ reviews not yet addressed</div>
        </div>
        <div class="fr-stat ${totals.open_issues > 0 ? 'warn' : 'ok'}">
          <div class="lbl">Open issues</div>
          <div class="val">${totals.open_issues}</div>
          <div class="delta">${totals.open_issues > 0 ? 'In flight or needs attention' : 'All clear'}</div>
        </div>
      </div>

      <div class="fr-dash-grid">
        <div class="card">
          <div class="card-head">
            <h3>Today's queue</h3>
            <a onclick="window.location.hash='/calendar'" style="font-size:11.5px;color:var(--accent);cursor:pointer">Full calendar →</a>
          </div>
          ${queueHtml}
        </div>
        <div>
          <div class="card">
            <div class="card-head">
              <h3>AI priority watchlist</h3>
              ${data.ai_enabled ? '<span class="ai-bump">✨ AI</span>' : ''}
            </div>
            ${aiHtml}
          </div>
          <div class="card" style="margin-top:14px">
            <div class="card-head"><h3>Recent open issues</h3></div>
            ${recentIssuesHtml}
          </div>
          <div class="card" style="margin-top:14px">
            <div class="card-head"><h3>Settings</h3></div>
            <p style="font-size:12px;color:var(--text2);margin:0 0 10px">Cadence, default reviewer, and how aggressively AI bumps priority.</p>
            <button class="btn-sec" onclick="window.location.hash='/settings'">Open settings</button>
          </div>
        </div>
      </div>
    `);

    if (data.ai_enabled) {
      $('dash-refresh-ai').addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = '✨ Asking AI…';
        try {
          const r = await apiPost('/api/flavor-reviews/ai/refresh-priority');
          toast(`AI updated ${r.updated} cycle${r.updated === 1 ? '' : 's'}`, 'ok');
          renderDashboard();
        } catch (e) {
          toast(e.message, 'err');
          ev.target.disabled = false;
          ev.target.textContent = '✨ Refresh AI priority';
        }
      });
    }
  }

  // ── Flavors list ───────────────────────────────────────────────────────
  let FLAVORS_CACHE = [];
  let FLAVORS_FILTER = { search: '', kind: 'all', variant: 'all', status: 'active' };

  async function renderFlavors() {
    loadingShell();
    try { FLAVORS_CACHE = await apiGet('/api/flavor-reviews/flavors'); }
    catch (e) { pageShell(`<div class="empty-state">${escapeHtml(e.message)}</div>`); return; }

    pageShell(`
      <div class="fr-topbar">
        ${backChip('/', 'Dashboard')}
        ${breadcrumb([{ label: 'Dashboard', href: '/' }, { label: 'Flavors' }])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title"><span class="fr-emoji">🍓</span> Flavors</h1>
          <p class="fr-lede">Your in-market flavor catalog. Click into one to log a new review, open an issue, or see the history.</p>
        </div>
        <div class="fr-header-actions">
          <button class="btn-sec btn-ai" onclick="window.location.hash='/import'">✨ Import from Amazon URL</button>
          <button class="btn-sec" onclick="window.location.hash='/bulk-import'">+ Bulk paste</button>
          <button class="btn-primary" id="fl-add">+ Add flavor</button>
        </div>
      </div>

      <div class="fr-toolbar">
        <input type="text" id="fl-search" placeholder="Search by name…" value="${escapeAttr(FLAVORS_FILTER.search)}">
        <select id="fl-kind">
          <option value="all">All kinds</option>
          ${['coffee','cocktail','fruit','tea','latte','smoothie','unique','other'].map(k =>
            `<option value="${k}" ${FLAVORS_FILTER.kind === k ? 'selected' : ''}>${cap(k)}</option>`
          ).join('')}
        </select>
        <select id="fl-variant">
          <option value="all">Regular + Sugar-free</option>
          <option value="regular"     ${FLAVORS_FILTER.variant === 'regular' ? 'selected' : ''}>Regular only</option>
          <option value="sugar_free"  ${FLAVORS_FILTER.variant === 'sugar_free' ? 'selected' : ''}>Sugar-free only</option>
        </select>
        <select id="fl-status">
          <option value="active"       ${FLAVORS_FILTER.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="discontinued" ${FLAVORS_FILTER.status === 'discontinued' ? 'selected' : ''}>Discontinued</option>
          <option value="all"          ${FLAVORS_FILTER.status === 'all' ? 'selected' : ''}>All</option>
        </select>
        <div class="spacer"></div>
        <span style="font-size:11.5px;color:var(--text3)" id="fl-count"></span>
      </div>

      <div id="fl-grid"></div>
    `);

    $('fl-add').addEventListener('click', () => openFlavorModal());
    ['fl-search','fl-kind','fl-variant','fl-status'].forEach(id => {
      $(id).addEventListener('input', () => {
        FLAVORS_FILTER = {
          search: $('fl-search').value,
          kind: $('fl-kind').value,
          variant: $('fl-variant').value,
          status: $('fl-status').value,
        };
        renderFlavorGrid();
      });
    });

    renderFlavorGrid();
  }

  function renderFlavorGrid() {
    const q = (FLAVORS_FILTER.search || '').trim().toLowerCase();
    const rows = FLAVORS_CACHE.filter(f => {
      if (FLAVORS_FILTER.kind !== 'all' && f.kind !== FLAVORS_FILTER.kind) return false;
      if (FLAVORS_FILTER.variant !== 'all' && f.variant !== FLAVORS_FILTER.variant) return false;
      if (FLAVORS_FILTER.status !== 'all' && f.status !== FLAVORS_FILTER.status) return false;
      if (q && !f.name.toLowerCase().includes(q)) return false;
      return true;
    });

    const grid = $('fl-grid');
    $('fl-count').textContent = `${rows.length} flavor${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      grid.innerHTML = `<div class="empty-state"><div class="es-emoji">🫥</div><div class="es-title">No flavors match.</div><div>Adjust the filters or bulk-import your catalog.</div></div>`;
      return;
    }
    grid.innerHTML = `<div class="flavor-grid">${rows.map(f => {
      const overdue = f.next_cycle && f.next_cycle < todayUtc();
      return `
        <div class="flavor-card" onclick="window.location.hash='/flavor/${f.id}'">
          <div class="fc-name">${escapeHtml(f.name)}</div>
          <div class="fc-tags">
            <span class="pill kind-${escapeAttr(f.kind)}">${escapeHtml(cap(f.kind))}</span>
            <span class="pill variant-${escapeAttr(f.variant)}">${escapeHtml(f.variant.replace('_','-'))}</span>
            ${f.status !== 'active' ? `<span class="pill status-${escapeAttr(f.status)}">${escapeHtml(f.status)}</span>` : ''}
          </div>
          <div class="fc-stat-row">
            ${f.open_bad > 0   ? `<span class="fc-mini bad">${f.open_bad} bad reviews</span>` : ''}
            ${f.open_issues > 0 ? `<span class="fc-mini issue">${f.open_issues} open issue${f.open_issues === 1 ? '' : 's'}</span>` : ''}
            ${f.next_cycle ? `<span class="fc-mini due ${overdue ? 'bad' : ''}">${overdue ? 'Overdue ' : 'Next '}${escapeHtml(prettyDate(f.next_cycle))}</span>` : '<span class="fc-mini">Not scheduled</span>'}
            ${f.link_count ? `<span class="fc-mini">${f.link_count} sell-link${f.link_count === 1 ? '' : 's'}</span>` : ''}
            ${f.total_reviews ? `<span class="fc-mini">${f.total_reviews} review${f.total_reviews === 1 ? '' : 's'} logged</span>` : ''}
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  // ── Flavor detail ──────────────────────────────────────────────────────
  let CURRENT_FLAVOR = null;
  let CURRENT_FLAVOR_TAB = 'overview';
  let AI_SUMMARY_CACHE = {}; // keyed by flavor id

  async function renderFlavor(id, tab) {
    CURRENT_FLAVOR_TAB = tab || 'overview';
    loadingShell();
    try { CURRENT_FLAVOR = await apiGet('/api/flavor-reviews/flavors/' + id); }
    catch (e) { pageShell(`<div class="empty-state">${escapeHtml(e.message)}</div>`); return; }
    const f = CURRENT_FLAVOR;
    const openIssues = f.issues.filter(i => i.status === 'open');
    const reviews = f.reviews;
    const openBad = reviews.filter(r => r.rating > 0 && r.rating <= 2 && r.status === 'open');
    const tabs = ['overview', 'reviews', 'issues'];
    const tabCounts = {
      overview: '',
      reviews: ` <span class="count">${reviews.length}</span>`,
      issues: openIssues.length ? ` <span class="count">${openIssues.length}</span>` : ` <span class="count">${f.issues.length}</span>`,
    };

    pageShell(`
      <div class="fr-topbar">
        ${backChip('/', 'Dashboard')}
        ${breadcrumb([{ label: 'Dashboard', href: '/' }, { label: 'Flavors', href: '/flavors' }, { label: f.name }])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title">
            <span class="fr-emoji">${kindEmoji(f.kind)}</span>
            ${escapeHtml(f.name)}
          </h1>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <span class="pill kind-${escapeAttr(f.kind)}">${escapeHtml(cap(f.kind))}</span>
            <span class="pill variant-${escapeAttr(f.variant)}">${escapeHtml(f.variant.replace('_','-'))}</span>
            <span class="pill status-${escapeAttr(f.status)}">${escapeHtml(f.status)}</span>
          </div>
        </div>
        <div class="fr-header-actions">
          <button class="btn-sec" id="fd-edit">Edit flavor</button>
          <button class="btn-sec" id="fd-add-link">+ Sell-link</button>
          <button class="btn-sec btn-ai" onclick="window.location.hash='/flavor/${f.id}/reviews-import'">✨ Import reviews</button>
          <button class="btn-sec" id="fd-add-review">+ Log one</button>
          <button class="btn-primary" id="fd-new-issue">+ New issue</button>
        </div>
      </div>

      <div class="fr-tabs">
        ${tabs.map(t => `<div class="fr-tab ${CURRENT_FLAVOR_TAB === t ? 'active' : ''}" data-tab="${t}">${cap(t)}${tabCounts[t]}</div>`).join('')}
      </div>

      <div id="fd-tab-body"></div>
    `);

    document.querySelectorAll('.fr-tab').forEach(el => {
      el.addEventListener('click', () => {
        const t = el.dataset.tab;
        const base = '/flavor/' + f.id;
        goto(t === 'overview' ? base : base + '/' + t);
      });
    });
    $('fd-edit').addEventListener('click', () => openFlavorModal(f));
    $('fd-add-link').addEventListener('click', () => openLinkModal(f.id));
    $('fd-add-review').addEventListener('click', () => openReviewModal(f.id));
    $('fd-new-issue').addEventListener('click', () => openIssueModal(f.id, openBad));

    renderFlavorTab();
  }

  function renderFlavorTab() {
    const f = CURRENT_FLAVOR;
    if (!f) return;
    const body = $('fd-tab-body');
    if (CURRENT_FLAVOR_TAB === 'overview')      body.innerHTML = renderOverview(f);
    else if (CURRENT_FLAVOR_TAB === 'reviews')  body.innerHTML = renderReviewsTab(f);
    else if (CURRENT_FLAVOR_TAB === 'issues')   body.innerHTML = renderIssuesTab(f);
    wireFlavorTab();
  }

  function renderOverview(f) {
    const recentReviews = f.reviews.slice(0, 5);
    const openIssues = f.issues.filter(i => i.status === 'open');
    const aiSummary = AI_SUMMARY_CACHE[f.id];
    const aiBlock = `
      <div class="ai-panel">
        <h4><svg class="ai-spark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> AI take</h4>
        ${aiSummary
          ? `<div class="ai-body">${escapeHtml(aiSummary)}</div>`
          : `<div class="ai-body ai-empty">No AI summary yet. Click below to ask Claude to read every review and recommend what (if anything) to do.</div>`}
        <div style="margin-top:10px"><button class="btn-sec btn-ai" id="ai-summary-btn">✨ ${aiSummary ? 'Re-analyse' : 'Get AI take'}</button></div>
      </div>`;
    return `
      <div class="detail-layout">
        <div>
          ${aiBlock}
          <div class="card">
            <div class="card-head">
              <h3>Notes</h3>
              <button class="btn-tiny" id="fd-edit-notes">Edit</button>
            </div>
            <div id="fd-notes-body" style="font-size:12.5px;color:var(--text2);white-space:pre-wrap;min-height:30px">${f.notes ? escapeHtml(f.notes) : '<span style="color:var(--text3)">No notes. Click Edit to add context (formula notes, known issues, marketing angle, etc.).</span>'}</div>
          </div>

          <div class="card">
            <div class="card-head">
              <h3>Recent reviews <span style="font-weight:400;color:var(--text3);font-size:11px">${f.reviews.length} total</span></h3>
              <a onclick="window.location.hash='/flavor/${f.id}/reviews'" style="font-size:11.5px;color:var(--accent);cursor:pointer">See all →</a>
            </div>
            ${recentReviews.length ? recentReviews.map(reviewRow).join('') : '<div class="dash-empty" style="padding:18px">No reviews logged yet. Click "+ Log review" to add one from a marketplace.</div>'}
          </div>

          <div class="card">
            <div class="card-head">
              <h3>Open issues</h3>
              <a onclick="window.location.hash='/flavor/${f.id}/issues'" style="font-size:11.5px;color:var(--accent);cursor:pointer">See all →</a>
            </div>
            ${openIssues.length ? openIssues.map(issueRow).join('') : '<div class="dash-empty" style="padding:18px">No open issues. 🎉</div>'}
          </div>
        </div>

        <div>
          ${f.image_url ? `<div class="side-card" style="padding:0;overflow:hidden"><img src="${escapeAttr(f.image_url)}" alt="${escapeAttr(f.name)}" style="width:100%;display:block" referrerpolicy="no-referrer" onerror="this.parentElement.style.display='none'"></div>` : ''}
          <div class="side-card">
            <h4>Sell-links${f.amazon_asin ? ` · <span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--text3);text-transform:none;letter-spacing:0">ASIN ${escapeHtml(f.amazon_asin)}</span>` : ''}</h4>
            ${f.links.length ? f.links.map(linkRow).join('') : '<div style="font-size:12px;color:var(--text3)">No sell-links yet. Add the URLs where this flavor is sold (Amazon, Walmart, etc.) so the reviewer can pull up the page.</div>'}
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
              <button class="btn-tiny" onclick="FR.openLinkModal(${f.id})">+ Add link</button>
              <button class="btn-tiny" onclick="window.location.hash='/import'">✨ Add via URL</button>
            </div>
          </div>

          <div class="side-card">
            <h4>Schedule</h4>
            ${f.cycles.length === 0 ? '<div style="font-size:12px;color:var(--text3)">No review cycles yet.</div>' : f.cycles.map(c => `
              <div class="side-row">
                <span>${escapeHtml(prettyDate(c.scheduled_for))}</span>
                <span class="v"><span class="pill status-${escapeAttr(c.status)}">${escapeHtml(c.status)}</span></span>
              </div>
            `).join('')}
            <button class="btn-tiny" style="margin-top:8px" id="add-cycle-btn">+ Schedule cycle</button>
          </div>

          <div class="side-card">
            <h4>Stats</h4>
            <div class="side-row"><span>Total reviews</span><span class="v">${f.reviews.length}</span></div>
            <div class="side-row"><span>Open bad reviews</span><span class="v">${f.reviews.filter(r => r.rating > 0 && r.rating <= 2 && r.status === 'open').length}</span></div>
            <div class="side-row"><span>Open issues</span><span class="v">${f.issues.filter(i => i.status === 'open').length}</span></div>
            <div class="side-row"><span>Fixed issues</span><span class="v">${f.issues.filter(i => i.status === 'fixed').length}</span></div>
            <div class="side-row"><span>Added</span><span class="v">${escapeHtml(prettyDate(f.created_at))}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  function renderReviewsTab(f) {
    if (!f.reviews.length) return `<div class="empty-state"><div class="es-emoji">📝</div><div class="es-title">No reviews logged yet</div><div>Click "+ Log review" above to add reviews you read on Amazon, Walmart, or anywhere else.</div></div>`;
    return `<div class="card"><div class="card-head"><h3>All reviews (${f.reviews.length})</h3></div>${f.reviews.map(reviewRow).join('')}</div>`;
  }

  function renderIssuesTab(f) {
    if (!f.issues.length) return `<div class="empty-state"><div class="es-emoji">✅</div><div class="es-title">No issues — all clear</div><div>If a bad review needs action, open it and click "Create issue".</div></div>`;
    const groups = {
      open: f.issues.filter(i => i.status === 'open'),
      merged: f.issues.filter(i => i.status === 'merged'),
      fixed: f.issues.filter(i => i.status === 'fixed'),
      ignored: f.issues.filter(i => i.status === 'ignored'),
    };
    return ['open','merged','fixed','ignored'].map(g => {
      if (!groups[g].length) return '';
      return `<div class="card"><div class="card-head"><h3>${cap(g)} (${groups[g].length})</h3></div>${groups[g].map(issueRow).join('')}</div>`;
    }).join('');
  }

  function wireFlavorTab() {
    const ai = $('ai-summary-btn');
    if (ai) ai.addEventListener('click', async () => {
      ai.disabled = true; ai.textContent = '✨ Asking AI…';
      try {
        const r = await apiPost('/api/flavor-reviews/flavors/' + CURRENT_FLAVOR.id + '/ai/summary');
        AI_SUMMARY_CACHE[CURRENT_FLAVOR.id] = r.summary;
        renderFlavorTab();
      } catch (e) {
        toast(e.message, 'err');
        ai.disabled = false; ai.textContent = '✨ Get AI take';
      }
    });
    const en = $('fd-edit-notes');
    if (en) en.addEventListener('click', () => openNotesModal(CURRENT_FLAVOR));
    const ac = $('add-cycle-btn');
    if (ac) ac.addEventListener('click', () => openCycleModal(CURRENT_FLAVOR.id));
  }

  function reviewRow(r) {
    const stars = '★'.repeat(r.rating || 0) + '☆'.repeat(5 - (r.rating || 0));
    return `
      <div class="review-row" id="review-${r.id}">
        <div>
          <div class="stars">${stars}</div>
          <div class="pill sentiment-${escapeAttr(r.sentiment || 'neutral')}" style="margin-top:6px">${escapeHtml(r.sentiment || '—')}</div>
        </div>
        <div>
          <div class="rt-title">${escapeHtml(r.title || '(no title)')}</div>
          <div class="rt-body">${escapeHtml(r.body || '')}</div>
          <div class="rt-meta">
            <span>${escapeHtml(r.source)}</span>
            ${r.reviewer_name ? `<span>${escapeHtml(r.reviewer_name)}</span>` : ''}
            ${r.posted_at ? `<span>${escapeHtml(prettyDate(r.posted_at))}</span>` : ''}
            ${r.url ? `<a href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Open ↗</a>` : ''}
            ${r.issue_id ? `<a onclick="window.location.hash='/issue/${r.issue_id}'" style="color:var(--accent);cursor:pointer">Issue: ${escapeHtml(r.issue_title || 'open')}</a>` : ''}
          </div>
        </div>
        <div class="rt-actions">
          <span class="pill status-${escapeAttr(r.status)}">${escapeHtml(r.status)}</span>
          ${r.status === 'open' && r.rating > 0 && r.rating <= 2
            ? `<button class="btn-tiny" onclick="FR.attachReviewToIssue(${r.id})">Attach to issue</button>
               <button class="btn-tiny" onclick="FR.aiFindDuplicates(${r.id})">✨ Find duplicates</button>`
            : ''}
          ${r.status === 'open'
            ? `<button class="btn-tiny" onclick="FR.markReview(${r.id}, 'ignored')">Ignore</button>`
            : `<button class="btn-tiny" onclick="FR.markReview(${r.id}, 'open')">Re-open</button>`}
        </div>
      </div>`;
  }

  function issueRow(i) {
    return `
      <div class="issue-row" onclick="window.location.hash='/issue/${i.id}'">
        <span class="pill sev-${escapeAttr(i.severity)}">${escapeHtml(i.severity)}</span>
        <div>
          <div class="ir-title">${escapeHtml(i.title)}</div>
          ${i.summary ? `<div class="ir-summary">${escapeHtml(i.summary.slice(0, 200))}${i.summary.length > 200 ? '…' : ''}</div>` : ''}
          <div class="ir-meta">
            <span>${i.review_count} review${i.review_count === 1 ? '' : 's'}</span>
            ${i.fixed_at ? `<span>Fixed ${escapeHtml(prettyDate(i.fixed_at))}</span>` : ''}
            ${i.merged_into_id ? `<span>Merged into #${i.merged_into_id}</span>` : ''}
            <span>Updated ${escapeHtml(prettyDate(i.updated_at))}</span>
          </div>
        </div>
        <span class="pill status-${escapeAttr(i.status)}">${escapeHtml(i.status)}</span>
      </div>`;
  }

  function linkRow(l) {
    const ltLabel = ({ single: 'Single', with_pump: '+Pump', '4_pack': '4-pack', '6_pack': '6-pack', other: 'Other' })[l.listing_type] || l.listing_type;
    return `<div class="link-row" id="link-${l.id}">
      ${l.image_url ? `<img src="${escapeAttr(l.image_url)}" alt="" referrerpolicy="no-referrer" style="width:34px;height:34px;border-radius:6px;object-fit:cover;background:var(--bg2)" onerror="this.style.display='none'">` : ''}
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="channel">${escapeHtml(l.channel)}</span>
          <span class="pill" style="background:var(--bg2);color:var(--text2);text-transform:none;letter-spacing:0">${escapeHtml(ltLabel)}</span>
          ${l.asin ? `<span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--text3)">${escapeHtml(l.asin)}</span>` : ''}
        </div>
        <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">${escapeHtml(l.url)}</a>
      </div>
      <button class="btn-tiny" onclick="FR.editLink(${l.id})">✎</button>
      <button class="btn-tiny btn-danger" onclick="FR.deleteLink(${l.id})">×</button>
    </div>`;
  }

  // ── Issue detail ───────────────────────────────────────────────────────
  let CURRENT_ISSUE = null;

  async function renderIssue(id) {
    loadingShell();
    try { CURRENT_ISSUE = await apiGet('/api/flavor-reviews/issues/' + id); }
    catch (e) { pageShell(`<div class="empty-state">${escapeHtml(e.message)}</div>`); return; }
    const i = CURRENT_ISSUE;

    const isResolved = ['fixed', 'ignored', 'merged'].includes(i.status);

    pageShell(`
      <div class="fr-topbar">
        ${backChip('/', 'Dashboard')}
        ${breadcrumb([
          { label: 'Dashboard', href: '/' },
          { label: 'Flavors', href: '/flavors' },
          { label: i.flavor_name || '(flavor)', href: '/flavor/' + i.flavor_id },
          { label: 'Issue #' + i.id }
        ])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title" style="font-size:21px">
            <span class="pill sev-${escapeAttr(i.severity)}">${escapeHtml(i.severity)}</span>
            ${escapeHtml(i.title)}
          </h1>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center">
            <span class="pill status-${escapeAttr(i.status)}">${escapeHtml(i.status)}</span>
            <span style="font-size:11.5px;color:var(--text3)">Flavor: <a onclick="window.location.hash='/flavor/${i.flavor_id}'" style="color:var(--accent);cursor:pointer">${escapeHtml(i.flavor_name)}</a></span>
            <span style="font-size:11.5px;color:var(--text3)">Created ${escapeHtml(prettyDate(i.created_at))}</span>
            <span style="font-size:11.5px;color:var(--text3)">${i.review_count} review${i.review_count === 1 ? '' : 's'} attached</span>
          </div>
        </div>
        <div class="fr-header-actions">
          <button class="btn-sec" id="iss-edit">Edit</button>
          ${i.status === 'open' ? `
            <button class="btn-sec" id="iss-merge">↪ Merge into…</button>
            <button class="btn-sec" id="iss-ignore">Ignore</button>
            <button class="btn-primary" id="iss-fix">✓ Mark fixed</button>
          ` : `
            <button class="btn-sec" id="iss-reopen">Re-open</button>
          `}
        </div>
      </div>

      ${i.status === 'fixed' ? `
        <div class="resolution-card">
          <h4>What was done</h4>
          <div class="body">${escapeHtml(i.resolution)}</div>
          <div class="meta">Fixed ${escapeHtml(prettyDate(i.fixed_at))}</div>
        </div>` : ''}
      ${i.status === 'ignored' ? `
        <div class="card" style="background:var(--bg2)">
          <div style="font-size:11.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Ignored ${escapeHtml(prettyDate(i.ignored_at))}</div>
          ${i.ignored_reason ? `<div style="font-size:12.5px;color:var(--text2)">${escapeHtml(i.ignored_reason)}</div>` : ''}
        </div>` : ''}
      ${i.status === 'merged' && i.merged_into_id ? `
        <div class="card">
          <div style="font-size:11.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Merged</div>
          <div style="font-size:12.5px;color:var(--text2)">All reviews moved to <a onclick="window.location.hash='/issue/${i.merged_into_id}'" style="color:var(--accent);cursor:pointer">issue #${i.merged_into_id}</a>.</div>
        </div>` : ''}

      <div class="card">
        <div class="card-head"><h3>Summary</h3></div>
        <div style="font-size:12.5px;color:var(--text2);white-space:pre-wrap;line-height:1.55">${i.summary ? escapeHtml(i.summary) : '<span style="color:var(--text3)">No summary yet — click Edit to describe the underlying problem.</span>'}</div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Attached reviews (${i.reviews.length})</h3></div>
        ${i.reviews.length ? i.reviews.map(reviewRow).join('') : '<div class="dash-empty" style="padding:18px">No reviews attached yet.</div>'}
      </div>
    `);

    $('iss-edit').addEventListener('click', () => openIssueEditModal(i));
    if (i.status === 'open') {
      $('iss-fix').addEventListener('click',    () => openFixModal(i));
      $('iss-ignore').addEventListener('click', () => openIgnoreModal(i));
      $('iss-merge').addEventListener('click',  () => openMergeModal(i));
    } else {
      $('iss-reopen').addEventListener('click', async () => {
        try { await apiPatch('/api/flavor-reviews/issues/' + i.id, { status: 'open' }); toast('Re-opened', 'ok'); renderIssue(i.id); }
        catch (e) { toast(e.message, 'err'); }
      });
    }
  }

  // ── Calendar ───────────────────────────────────────────────────────────
  async function renderCalendar(monthIso) {
    const today = todayUtc();
    const month = (monthIso && /^\d{4}-\d{2}$/.test(monthIso)) ? monthIso : today.slice(0, 7);
    loadingShell();
    let cycles;
    try { cycles = await apiGet('/api/flavor-reviews/cycles?month=' + month); }
    catch (e) { pageShell(`<div class="empty-state">${escapeHtml(e.message)}</div>`); return; }

    const [y, m] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startDow = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;

    const byDay = new Map();
    for (const c of cycles) {
      const k = c.scheduled_for;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(c);
    }

    const monthName = first.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    let cells = '';
    for (let i = 0; i < startDow; i++) cells += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateIso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = dateIso === today;
      const list = byDay.get(dateIso) || [];
      const chips = list.slice(0, 4).map(c => {
        const score = (c.priority || 3) + (c.ai_priority_bump || 0);
        const cls = c.status === 'done' ? 'done' : (score >= 5 ? 'urgent' : (score >= 4 ? 'warn' : ''));
        return `<div class="chip ${cls}" title="${escapeAttr(c.flavor_name)} — ${escapeHtml(c.status)}" onclick="event.stopPropagation();window.location.hash='/flavor/${c.flavor_id}'">${escapeHtml(c.flavor_name)}</div>`;
      }).join('');
      const more = list.length > 4 ? `<div class="chip" style="background:var(--bg2);color:var(--text2)">+${list.length - 4} more</div>` : '';
      cells += `<div class="cal-cell ${isToday ? 'today' : ''}">
        <div class="d"><span>${d}</span>${list.length ? `<span style="font-size:10px;color:var(--text3)">${list.length}</span>` : ''}</div>
        ${chips}${more}
      </div>`;
    }

    pageShell(`
      <div class="fr-topbar">
        ${backChip('/', 'Dashboard')}
        ${breadcrumb([{ label: 'Dashboard', href: '/' }, { label: 'Calendar' }])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title"><span class="fr-emoji">📅</span> Review calendar</h1>
          <p class="fr-lede">Every scheduled review cycle. Click a flavor chip to jump straight into its detail page. AI-bumped cycles get highlighted in orange or red so you don't miss the urgent ones.</p>
        </div>
      </div>

      <div class="cal-shell">
        <div class="cal-head">
          <h3>${escapeHtml(monthName)}</h3>
          <div class="nav">
            <button class="btn-sec" onclick="window.location.hash='/calendar/${prevMonth}'">← Prev</button>
            <button class="btn-sec" onclick="window.location.hash='/calendar/${today.slice(0, 7)}'">Today</button>
            <button class="btn-sec" onclick="window.location.hash='/calendar/${nextMonth}'">Next →</button>
          </div>
        </div>
        <div class="cal-grid">
          ${dows.map(d => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells}
        </div>
      </div>
    `);
  }

  // ── Bulk import ────────────────────────────────────────────────────────
  function renderBulkImport() {
    pageShell(`
      <div class="fr-topbar">
        ${backChip('/', 'Dashboard')}
        ${breadcrumb([{ label: 'Dashboard', href: '/' }, { label: 'Bulk import' }])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title"><span class="fr-emoji">📥</span> Bulk import flavors</h1>
          <p class="fr-lede">Paste rows from Google Sheets or Excel. The first row must be a header. Columns we recognise: <code>name</code>, <code>kind</code>, <code>variant</code>, <code>notes</code>, <code>links</code>. Anything else is ignored. <code>links</code> is "Channel|URL" pairs separated by semicolons.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Paste here</h3>
          <button class="btn-tiny" id="bi-sample">Insert sample</button>
        </div>
        <textarea id="bi-text" placeholder="name&#9;kind&#9;variant&#9;notes&#9;links&#10;Vanilla&#9;coffee&#9;regular&#9;classic flavor&#9;Amazon|https://amazon.com/...;Walmart|https://walmart.com/..." style="min-height:200px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px"></textarea>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn-sec" id="bi-preview">Preview</button>
          <button class="btn-primary" id="bi-import" disabled>Import</button>
        </div>
        <div id="bi-preview-out" style="margin-top:14px"></div>
        <div id="bi-result-out"></div>
      </div>
    `);

    $('bi-sample').addEventListener('click', () => {
      $('bi-text').value =
`name	kind	variant	notes	links
Vanilla	coffee	regular	Classic, evergreen seller	Amazon|https://amazon.com/vanilla-syrup;Walmart|https://walmart.com/vanilla-syrup
Caramel	coffee	regular	Best-seller	Amazon|https://amazon.com/caramel-syrup
Vanilla	coffee	sugar_free	SF variant of Vanilla	Amazon|https://amazon.com/vanilla-sf
Strawberry	fruit	regular	Summer push planned	Amazon|https://amazon.com/strawberry-syrup`;
      $('bi-preview').click();
    });

    $('bi-preview').addEventListener('click', () => {
      const raw = $('bi-text').value;
      const previewOut = $('bi-preview-out');
      $('bi-import').disabled = true;
      if (!raw.trim()) { previewOut.innerHTML = '<div class="empty-state">Paste some rows first.</div>'; return; }
      const lines = raw.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length);
      if (lines.length < 2) { previewOut.innerHTML = '<div class="empty-state">Need at least a header row and one data row.</div>'; return; }
      const delim = lines[0].includes('\t') ? '\t' : ',';
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const headers = lines[0].split(delim).map(norm);
      const validKinds = new Set(['coffee','cocktail','fruit','tea','latte','smoothie','unique','other']);
      const validVariants = new Set(['regular','sugar_free']);
      const rows = lines.slice(1).map((line, idx) => {
        const parts = line.split(delim);
        const row = {};
        headers.forEach((h, i) => row[h] = (parts[i] || '').trim());
        row._row = idx + 2;
        row._badName = !row.name;
        row._badKind = row.kind && !validKinds.has(row.kind);
        row._badVariant = row.variant && !validVariants.has(row.variant);
        return row;
      });
      const validRows = rows.filter(r => !r._badName).length;
      previewOut.innerHTML = `
        <div style="font-size:12.5px;color:var(--text2);margin-bottom:8px">${rows.length} rows parsed, ${validRows} look valid${rows.length - validRows ? ', ' + (rows.length - validRows) + ' will be skipped' : ''}. <strong>Unknown</strong> kinds become "other", unknown variants become "regular".</div>
        <div class="bulk-preview"><table>
          <thead><tr><th>#</th><th>Name</th><th>Kind</th><th>Variant</th><th>Notes</th><th>Links</th></tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td>${r._row}</td>
              <td class="${r._badName ? 'bad' : ''}">${escapeHtml(r.name || '(missing)')}</td>
              <td class="${r._badKind ? 'bad' : ''}">${escapeHtml(r.kind || 'other')}</td>
              <td class="${r._badVariant ? 'bad' : ''}">${escapeHtml(r.variant || 'regular')}</td>
              <td>${escapeHtml((r.notes || '').slice(0, 60))}${(r.notes || '').length > 60 ? '…' : ''}</td>
              <td>${escapeHtml((r.links || '').slice(0, 60))}${(r.links || '').length > 60 ? '…' : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
      $('bi-import').disabled = validRows === 0;
    });

    $('bi-import').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = 'Importing…';
      try {
        const r = await apiPost('/api/flavor-reviews/flavors/bulk-import', { text: $('bi-text').value });
        $('bi-result-out').innerHTML = `
          <div class="import-result">
            <div class="pill-stat" style="border-color:#bbf7d0;background:var(--ok-bg)"><div class="v" style="color:var(--ok)">${r.created.length}</div><div class="l" style="color:#166534">Imported</div></div>
            <div class="pill-stat" style="border-color:#fde68a;background:var(--warn-bg)"><div class="v" style="color:var(--warn)">${r.skipped.length}</div><div class="l">Skipped (already exists)</div></div>
            <div class="pill-stat" style="border-color:#fecaca;background:var(--danger-bg)"><div class="v" style="color:var(--danger)">${r.errors.length}</div><div class="l">Errors</div></div>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px">
            <button class="btn-primary" onclick="window.location.hash='/flavors'">View all flavors →</button>
            <button class="btn-sec" onclick="window.location.hash='/'">Back to dashboard</button>
          </div>
        `;
        toast(`Imported ${r.created.length} flavor${r.created.length === 1 ? '' : 's'}`, 'ok');
      } catch (e) {
        toast(e.message, 'err');
        ev.target.disabled = false;
        ev.target.textContent = 'Import';
      }
    });
  }

  // ── Import from Amazon URL (AI-driven) ─────────────────────────────────
  // Multi-step wizard:
  //   1. Paste URL → server tries Claude web_fetch, then server-side fetch.
  //      On success → proposal. On failure → flip to "paste page content".
  //   2. Render extracted variations as cards. Each card has:
  //        • image preview, ASIN, listing_type pill, flavor_name (editable),
  //        • action: "Create new" / "Add to existing X" / "Skip"
  //      Match suggestions come from /match-batch.
  //   3. Submit → /confirm creates flavors + links, shows result summary.
  let IMPORT_STATE = null;

  async function renderImport() {
    IMPORT_STATE = null;
    pageShell(`
      <div class="fr-topbar">
        ${backChip('/', 'Dashboard')}
        ${breadcrumb([{ label: 'Dashboard', href: '/' }, { label: 'Import from URL' }])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title"><span class="fr-emoji">✨</span> Import from Amazon URL</h1>
          <p class="fr-lede">Paste an Amazon product URL. AI extracts every flavor variation it finds (ASIN, title, flavor name, image, pack size) so you can approve them in one go. If the URL is for a single listing with no variations, you'll see one entry and can either create a new flavor or link it to an existing one (e.g. add a <em>with-pump</em> variant to an existing Vanilla).</p>
        </div>
      </div>

      <div id="imp-inbox" style="max-width:760px;margin-bottom:14px"></div>

      <div id="imp-step-1" class="card" style="max-width:760px">
        <div class="card-head"><h3>Step 1 — Paste the URL</h3></div>
        <div class="form-row">
          <label class="fr-label">Amazon product URL</label>
          <input type="url" id="imp-url" placeholder="https://www.amazon.com/dp/B0XXXXXXXX/…">
          <div style="font-size:11px;color:var(--text3);margin-top:5px">Tip: paste the canonical product page URL (the one with all the flavor variation buttons), not the search-results URL.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-primary" id="imp-fetch">✨ Fetch &amp; extract</button>
          <button class="btn-sec" id="imp-paste-mode">Or paste page content</button>
          <button class="btn-sec" onclick="window.location.hash='/settings'">📥 Set up bookmarklet</button>
        </div>
        <div id="imp-paste-block" style="display:none;margin-top:14px">
          <label class="fr-label">Paste page content</label>
          <textarea id="imp-paste-content" placeholder="Open the Amazon product page in your browser, Cmd+A to select all, Cmd+C to copy, then paste here. Claude will parse the same way as auto-fetch." style="min-height:200px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px"></textarea>
          <div style="margin-top:8px"><button class="btn-primary" id="imp-paste-go">Extract from pasted content</button></div>
        </div>
        <div id="imp-fetch-status"></div>
      </div>

      <div id="imp-step-2" style="display:none"></div>
      <div id="imp-step-3" style="display:none"></div>
    `);

    $('imp-fetch').addEventListener('click', () => doImportFetch());
    $('imp-paste-mode').addEventListener('click', () => {
      $('imp-paste-block').style.display = '';
      $('imp-paste-mode').style.display = 'none';
    });
    $('imp-paste-go').addEventListener('click', () => doImportPaste());
    renderInboxPanel('imp-inbox', 'product');
  }

  // Render an "inbox picker" inside an existing import page. Used by both
  // /import (kind=product) and /flavor/:id/reviews-import (kind=reviews).
  async function renderInboxPanel(hostId, kind) {
    const host = $(hostId);
    if (!host) return;
    try {
      const { items } = await apiGet('/api/flavor-reviews/scraper/inbox?kind=' + kind);
      if (!items.length) {
        host.innerHTML = `
          <div class="card" style="border-style:dashed;background:transparent">
            <div style="display:flex;gap:10px;align-items:center">
              <div style="font-size:22px">📥</div>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:650">No bookmarklet captures yet</div>
                <div style="font-size:11.5px;color:var(--text3);margin-top:2px">Set up the bookmarklet in <a onclick="window.location.hash='/settings'" style="color:var(--accent);cursor:pointer">Settings</a> to scrape Amazon pages from your own browser — bypasses every bot wall.</div>
              </div>
            </div>
          </div>`;
        return;
      }
      host.innerHTML = `
        <div class="card" style="background:linear-gradient(135deg,#faf5ff,#fff);border-color:#e9d5ff">
          <div class="card-head" style="border-bottom:1px solid #e9d5ff;padding-bottom:8px;margin-bottom:10px">
            <h3>📥 Bookmarklet inbox · ${items.length} capture${items.length === 1 ? '' : 's'}</h3>
            <div style="font-size:11px;color:var(--text3)">Click one to parse + start the approval flow.</div>
          </div>
          ${items.map(it => `
            <div style="display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px;background:white">
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.page_title || it.source_url || '(no title)')}</div>
                <div style="font-size:10.5px;color:var(--text3)">${escapeHtml(prettyDate(it.created_at))} · ${(it.bytes / 1024).toFixed(0)} KB${it.page_count > 1 ? ' · ' + it.page_count + ' pages' : ''}${it.status === 'parsed' ? ' · already parsed (free)' : ''}</div>
              </div>
              <button class="btn-tiny btn-primary" onclick="FR.pickInbox(${it.id}, '${kind}')">${it.status === 'parsed' ? 'Use →' : '✨ Parse →'}</button>
              <button class="btn-tiny btn-danger" onclick="FR.deleteInbox(${it.id});setTimeout(()=>FR.refreshInbox('${hostId}','${kind}'),300)">×</button>
            </div>`).join('')}
        </div>`;
    } catch (e) {
      host.innerHTML = `<div class="card" style="color:var(--danger)">${escapeHtml(e.message)}</div>`;
    }
  }

  async function doImportFetch() {
    const url = $('imp-url').value.trim();
    if (!url) return toast('Paste a URL first', 'err');
    const status = $('imp-fetch-status');
    status.innerHTML = `<div class="ai-panel" style="margin-top:12px"><div class="ai-body">✨ Asking Claude to fetch and read the page… this can take 20–40 seconds for Amazon.</div></div>`;
    $('imp-fetch').disabled = true;
    try {
      const r = await apiPost('/api/flavor-reviews/import/amazon-url', { url });
      if (r.ok) return finishExtract(r);
      // needs_paste
      status.innerHTML = `<div class="card" style="border-color:#fde68a;background:var(--warn-bg);margin-top:12px">
        <strong>Amazon blocked the auto-fetch.</strong> This happens. Open the URL in your browser, select-all (Cmd+A), copy, and paste below — Claude will extract the same way.
      </div>`;
      $('imp-paste-block').style.display = '';
      $('imp-paste-mode').style.display = 'none';
      $('imp-fetch').disabled = false;
    } catch (e) {
      status.innerHTML = `<div class="card" style="border-color:#fecaca;background:var(--danger-bg);margin-top:12px;color:var(--danger)">${escapeHtml(e.message)}</div>`;
      $('imp-fetch').disabled = false;
    }
  }

  async function doImportPaste() {
    const url = $('imp-url').value.trim();
    const content = $('imp-paste-content').value;
    if (!content.trim()) return toast('Paste the page content first', 'err');
    const status = $('imp-fetch-status');
    status.innerHTML = `<div class="ai-panel" style="margin-top:12px"><div class="ai-body">✨ Claude is parsing… ~10 seconds.</div></div>`;
    $('imp-paste-go').disabled = true;
    try {
      const r = await apiPost('/api/flavor-reviews/import/amazon-paste', { url, content });
      if (r.ok) return finishExtract(r);
      status.innerHTML = `<div class="card" style="border-color:#fecaca;background:var(--danger-bg);margin-top:12px;color:var(--danger)">${escapeHtml(r.error || 'No variations found in that content.')}</div>`;
      $('imp-paste-go').disabled = false;
    } catch (e) {
      status.innerHTML = `<div class="card" style="border-color:#fecaca;background:var(--danger-bg);margin-top:12px;color:var(--danger)">${escapeHtml(e.message)}</div>`;
      $('imp-paste-go').disabled = false;
    }
  }

  async function finishExtract(r) {
    IMPORT_STATE = {
      source_url: r.source_url || $('imp-url').value.trim(),
      page_summary: r.page_summary,
      variations: r.variations.map(v => ({ ...v, action: 'create', kind: 'coffee', variant: 'regular' })),
      fetched_via: r.fetched_via,
    };
    // Ask the server to suggest matches against existing flavors.
    try {
      const m = await apiPost('/api/flavor-reviews/import/match-batch', { variations: IMPORT_STATE.variations });
      for (const match of m.matches || []) {
        const v = IMPORT_STATE.variations[match.variation_index];
        if (v && match.suggested_flavor_id) {
          v.suggested_flavor_id = match.suggested_flavor_id;
          v.suggested_flavor_name = match.suggested_flavor_name;
          v.confidence = match.confidence;
          v.action = 'link';
          v.existing_flavor_id = match.suggested_flavor_id;
        }
      }
    } catch (e) {
      console.warn('match-batch failed:', e.message);
    }
    // Need the flavor list for the "link to existing" selector.
    try { IMPORT_STATE.all_flavors = await apiGet('/api/flavor-reviews/flavors'); }
    catch { IMPORT_STATE.all_flavors = []; }
    $('imp-step-1').style.display = 'none';
    renderImportReview();
  }

  function renderImportReview() {
    const s = IMPORT_STATE;
    const step2 = $('imp-step-2');
    step2.style.display = '';
    step2.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Step 2 — Review ${s.variations.length} extracted variation${s.variations.length === 1 ? '' : 's'}</h3>
          <div style="font-size:11.5px;color:var(--text3)">Fetched via ${escapeHtml(s.fetched_via || '?')}</div>
        </div>
        ${s.page_summary ? `<div class="ai-panel"><h4>✨ AI summary</h4><div class="ai-body">${escapeHtml(s.page_summary)}</div></div>` : ''}
        <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
          <button class="btn-tiny" id="imp-all-create">All → Create new</button>
          <button class="btn-tiny" id="imp-all-skip">All → Skip</button>
          <span class="spacer" style="flex:1"></span>
          <button class="btn-tiny" id="imp-set-kind">Set kind for all…</button>
        </div>
        <div id="imp-cards"></div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button class="btn-sec" onclick="window.location.hash='/import';location.reload()">Cancel</button>
          <button class="btn-primary" id="imp-confirm">Import selected</button>
        </div>
      </div>
    `;
    renderImportCards();
    $('imp-all-create').addEventListener('click', () => {
      s.variations.forEach(v => { v.action = 'create'; });
      renderImportCards();
    });
    $('imp-all-skip').addEventListener('click', () => {
      s.variations.forEach(v => { v.action = 'skip'; });
      renderImportCards();
    });
    $('imp-set-kind').addEventListener('click', () => {
      const k = prompt('Set kind for ALL (coffee / cocktail / fruit / tea / latte / smoothie / unique / other):', 'coffee');
      if (k && ['coffee','cocktail','fruit','tea','latte','smoothie','unique','other'].includes(k.trim())) {
        s.variations.forEach(v => { v.kind = k.trim(); });
        renderImportCards();
      }
    });
    $('imp-confirm').addEventListener('click', confirmImport);
  }

  function renderImportCards() {
    const s = IMPORT_STATE;
    const flavors = s.all_flavors || [];
    const cards = $('imp-cards');
    cards.innerHTML = s.variations.map((v, idx) => {
      const ltLabel = ({ single: 'Single', with_pump: 'Single + Pump', '4_pack': '4-pack', '6_pack': '6-pack', other: 'Other' })[v.listing_type] || v.listing_type;
      const matchHint = v.suggested_flavor_name
        ? `<div style="margin-top:6px;font-size:11.5px;color:#7c3aed;font-weight:600">✨ AI suggests linking to: ${escapeHtml(v.suggested_flavor_name)}</div>`
        : '';
      return `
        <div class="import-card" data-idx="${idx}" style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:10px;display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:flex-start;background:var(--card-soft)">
          ${v.image_url ? `<img src="${escapeAttr(v.image_url)}" alt="" referrerpolicy="no-referrer" style="width:64px;height:64px;border-radius:8px;object-fit:cover;background:var(--bg2)" onerror="this.style.display='none'">` : `<div style="width:64px;height:64px;border-radius:8px;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:22px">${kindEmoji(v.kind)}</div>`}
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:650">${escapeHtml(v.flavor_name || '(no flavor name)')}</div>
            <div style="font-size:11px;color:var(--text2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.title || '')}</div>
            <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;font-size:10px">
              <span class="pill" style="background:var(--bg2);color:var(--text2);text-transform:none;letter-spacing:0">${escapeHtml(ltLabel)}</span>
              ${v.asin ? `<span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--text3)">${escapeHtml(v.asin)}</span>` : '<span style="color:var(--danger);font-size:10px">(no ASIN)</span>'}
              <span style="color:var(--text3)">pack ${v.pack_size}</span>
            </div>
            ${matchHint}
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
              <input type="text" data-bind="flavor_name" value="${escapeAttr(v.flavor_name || '')}" placeholder="Flavor name (Vanilla…)" style="font-size:12px">
              <select data-bind="kind" style="font-size:12px">
                ${['coffee','cocktail','fruit','tea','latte','smoothie','unique','other'].map(k => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${cap(k)}</option>`).join('')}
              </select>
              <select data-bind="variant" style="font-size:12px">
                <option value="regular"    ${v.variant === 'regular' ? 'selected' : ''}>Regular</option>
                <option value="sugar_free" ${v.variant === 'sugar_free' ? 'selected' : ''}>Sugar-free</option>
              </select>
              <select data-bind="listing_type" style="font-size:12px">
                ${['single','with_pump','4_pack','6_pack','other'].map(t => `<option value="${t}" ${v.listing_type === t ? 'selected' : ''}>${t === 'single' ? 'Single' : t === 'with_pump' ? 'Single + Pump' : t === '4_pack' ? '4-pack' : t === '6_pack' ? '6-pack' : 'Other'}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            <select data-bind="action" style="font-size:11.5px;width:160px">
              <option value="create" ${v.action === 'create' ? 'selected' : ''}>+ Create new flavor</option>
              <option value="link"   ${v.action === 'link'   ? 'selected' : ''}>↳ Add as link to…</option>
              <option value="skip"   ${v.action === 'skip'   ? 'selected' : ''}>× Skip</option>
            </select>
            <select data-bind="existing_flavor_id" style="font-size:11.5px;width:160px;display:${v.action === 'link' ? 'block' : 'none'}">
              <option value="">— pick a flavor —</option>
              ${flavors.map(f => `<option value="${f.id}" ${v.existing_flavor_id == f.id ? 'selected' : ''}>${escapeHtml(f.name)} (${escapeHtml(f.variant.replace('_','-'))})</option>`).join('')}
            </select>
          </div>
        </div>`;
    }).join('');
    // Wire inputs to mutate IMPORT_STATE
    cards.querySelectorAll('.import-card').forEach(card => {
      const idx = Number(card.dataset.idx);
      card.querySelectorAll('[data-bind]').forEach(el => {
        el.addEventListener('change', () => {
          const key = el.dataset.bind;
          IMPORT_STATE.variations[idx][key] = el.value;
          if (key === 'action') {
            const existSel = card.querySelector('[data-bind="existing_flavor_id"]');
            if (existSel) existSel.style.display = (el.value === 'link') ? 'block' : 'none';
          }
        });
        if (el.tagName === 'INPUT') el.addEventListener('input', () => {
          IMPORT_STATE.variations[idx][el.dataset.bind] = el.value;
        });
      });
    });
  }

  async function confirmImport() {
    const items = IMPORT_STATE.variations.map(v => ({
      action: v.action,
      name: v.flavor_name,
      kind: v.kind,
      variant: v.variant,
      asin: v.asin,
      title: v.title,
      image_url: v.image_url,
      listing_type: v.listing_type,
      pack_size: v.pack_size,
      channel: 'Amazon',
      url: IMPORT_STATE.source_url,
      existing_flavor_id: v.action === 'link' ? Number(v.existing_flavor_id) : undefined,
    }));
    const bad = items.find(it => it.action === 'link' && !Number.isFinite(it.existing_flavor_id));
    if (bad) return toast('Pick a target flavor for every "Add as link" row.', 'err');

    $('imp-confirm').disabled = true;
    $('imp-confirm').textContent = 'Importing…';
    try {
      const r = await apiPost('/api/flavor-reviews/import/confirm', {
        source_url: IMPORT_STATE.source_url,
        items,
      });
      $('imp-step-2').style.display = 'none';
      const step3 = $('imp-step-3');
      step3.style.display = '';
      step3.innerHTML = `
        <div class="card">
          <div class="card-head"><h3>Step 3 — Done</h3></div>
          <div class="import-result">
            <div class="pill-stat" style="border-color:#bbf7d0;background:var(--ok-bg)"><div class="v" style="color:var(--ok)">${r.created.length}</div><div class="l">Created</div></div>
            <div class="pill-stat" style="border-color:#dbeafe;background:var(--info-bg)"><div class="v" style="color:var(--info)">${r.linked.length}</div><div class="l">Linked to existing</div></div>
            <div class="pill-stat" style="border-color:#fecaca;background:var(--danger-bg)"><div class="v" style="color:var(--danger)">${r.errors.length}</div><div class="l">Errors</div></div>
          </div>
          ${r.errors.length ? `<details style="margin-top:14px"><summary style="cursor:pointer;font-size:12px;color:var(--danger)">View ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}</summary><div style="margin-top:8px;font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--bg2);padding:10px;border-radius:8px;white-space:pre-wrap">${escapeHtml(JSON.stringify(r.errors, null, 2))}</div></details>` : ''}
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn-primary" onclick="window.location.hash='/flavors'">View all flavors →</button>
            <button class="btn-sec" onclick="window.location.hash='/import';location.reload()">Import another URL</button>
          </div>
        </div>
      `;
      toast(`Imported ${r.created.length} new, linked ${r.linked.length}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
      $('imp-confirm').disabled = false;
      $('imp-confirm').textContent = 'Import selected';
    }
  }

  // ── Reviews import (fetch URL or paste) ────────────────────────────────
  let RVI_STATE = null;

  async function renderReviewsImport(flavorId) {
    RVI_STATE = { flavor_id: flavorId, reviews: [] };
    loadingShell();
    let flavor;
    try { flavor = await apiGet('/api/flavor-reviews/flavors/' + flavorId); }
    catch (e) { pageShell(`<div class="empty-state">${escapeHtml(e.message)}</div>`); return; }

    pageShell(`
      <div class="fr-topbar">
        ${backChip('/flavor/' + flavorId, 'Back to flavor')}
        ${breadcrumb([
          { label: 'Dashboard', href: '/' },
          { label: 'Flavors', href: '/flavors' },
          { label: flavor.name, href: '/flavor/' + flavorId },
          { label: 'Import reviews' }
        ])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title"><span class="fr-emoji">✨</span> Import reviews for ${escapeHtml(flavor.name)}</h1>
          <p class="fr-lede">Paste a reviews page URL (Amazon's <code>/product-reviews/&lt;ASIN&gt;</code>, a Walmart product page, a TikTok video) and Claude will try to fetch + parse. If the source blocks scrapers (Amazon often does), you can paste the visible reviews text and it'll parse that the same way.</p>
        </div>
      </div>

      <div id="rvi-inbox" style="max-width:760px;margin-bottom:14px"></div>

      <div id="rvi-step-1" class="card" style="max-width:760px">
        <div class="form-grid">
          <div class="form-row">
            <label class="fr-label">Source</label>
            <select id="rvi-source">
              <option value="Amazon">Amazon</option>
              <option value="Walmart">Walmart</option>
              <option value="TikTok">TikTok</option>
              <option value="Website">Website</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div class="form-row">
            <label class="fr-label">URL (optional for paste mode)</label>
            <input type="url" id="rvi-url" placeholder="https://www.amazon.com/product-reviews/B0…">
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-primary" id="rvi-fetch">✨ Fetch &amp; parse</button>
          <button class="btn-sec" id="rvi-paste-mode">Or paste review text</button>
          <button class="btn-sec" onclick="window.location.hash='/settings'">📥 Set up bookmarklet</button>
        </div>
        <div id="rvi-paste-block" style="display:none;margin-top:14px">
          <label class="fr-label">Paste the reviews</label>
          <textarea id="rvi-paste-content" placeholder="Paste anything: copied review text, the visible portion of a TikTok comment thread, a screenshot's OCR — Claude will extract every distinct review." style="min-height:200px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px"></textarea>
          <div style="margin-top:8px"><button class="btn-primary" id="rvi-paste-go">Parse pasted content</button></div>
        </div>
        <div id="rvi-status"></div>
      </div>

      <div id="rvi-step-2" style="display:none"></div>
      <div id="rvi-step-3" style="display:none"></div>
    `);

    $('rvi-fetch').addEventListener('click', () => doReviewsFetch());
    $('rvi-paste-mode').addEventListener('click', () => {
      $('rvi-paste-block').style.display = '';
      $('rvi-paste-mode').style.display = 'none';
    });
    $('rvi-paste-go').addEventListener('click', () => doReviewsPaste());
    renderInboxPanel('rvi-inbox', 'reviews');
  }

  async function doReviewsFetch() {
    const url = $('rvi-url').value.trim();
    if (!url) return toast('Paste a URL first (or use paste mode)', 'err');
    const status = $('rvi-status');
    status.innerHTML = `<div class="ai-panel" style="margin-top:12px"><div class="ai-body">✨ Fetching and parsing… 20–60 seconds.</div></div>`;
    $('rvi-fetch').disabled = true;
    try {
      const r = await apiPost('/api/flavor-reviews/import/reviews-fetch', { url });
      if (r.ok && r.reviews.length) return finishReviewsExtract(r.reviews, url);
      status.innerHTML = `<div class="card" style="border-color:#fde68a;background:var(--warn-bg);margin-top:12px">
        <strong>Couldn't auto-fetch reviews.</strong> The source probably blocked the scrape (Amazon does this most of the time). Open the URL in your browser, select the visible reviews, copy + paste below.
      </div>`;
      $('rvi-paste-block').style.display = '';
      $('rvi-paste-mode').style.display = 'none';
      $('rvi-fetch').disabled = false;
    } catch (e) {
      status.innerHTML = `<div class="card" style="border-color:#fecaca;background:var(--danger-bg);margin-top:12px;color:var(--danger)">${escapeHtml(e.message)}</div>`;
      $('rvi-fetch').disabled = false;
    }
  }

  async function doReviewsPaste() {
    const content = $('rvi-paste-content').value;
    if (!content.trim()) return toast('Paste the review text first', 'err');
    const status = $('rvi-status');
    status.innerHTML = `<div class="ai-panel" style="margin-top:12px"><div class="ai-body">✨ Claude is parsing…</div></div>`;
    $('rvi-paste-go').disabled = true;
    try {
      const r = await apiPost('/api/flavor-reviews/import/reviews-paste', { content });
      if (r.ok && r.reviews.length) return finishReviewsExtract(r.reviews, $('rvi-url').value.trim());
      status.innerHTML = `<div class="card" style="border-color:#fecaca;background:var(--danger-bg);margin-top:12px;color:var(--danger)">${escapeHtml(r.error || 'No reviews found in that content.')}</div>`;
      $('rvi-paste-go').disabled = false;
    } catch (e) {
      status.innerHTML = `<div class="card" style="border-color:#fecaca;background:var(--danger-bg);margin-top:12px;color:var(--danger)">${escapeHtml(e.message)}</div>`;
      $('rvi-paste-go').disabled = false;
    }
  }

  function finishReviewsExtract(reviews, url) {
    RVI_STATE.reviews = reviews.map(r => ({ ...r, include: true }));
    RVI_STATE.url = url;
    RVI_STATE.source = $('rvi-source').value;
    $('rvi-step-1').style.display = 'none';
    const step2 = $('rvi-step-2');
    step2.style.display = '';
    renderReviewsImportReview();
  }

  function renderReviewsImportReview() {
    const s = RVI_STATE;
    $('rvi-step-2').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Step 2 — ${s.reviews.length} review${s.reviews.length === 1 ? '' : 's'} extracted</h3>
          <div style="font-size:11.5px;color:var(--text3)">Source: ${escapeHtml(s.source)}</div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn-tiny" id="rvi-all-on">Select all</button>
          <button class="btn-tiny" id="rvi-all-off">Select none</button>
        </div>
        <div id="rvi-list"></div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button class="btn-sec" onclick="window.location.hash='/flavor/${s.flavor_id}/reviews-import';location.reload()">Start over</button>
          <button class="btn-primary" id="rvi-save">Save selected</button>
        </div>
      </div>
    `;
    renderReviewsImportList();
    $('rvi-all-on').addEventListener('click', () => { s.reviews.forEach(r => r.include = true); renderReviewsImportList(); });
    $('rvi-all-off').addEventListener('click', () => { s.reviews.forEach(r => r.include = false); renderReviewsImportList(); });
    $('rvi-save').addEventListener('click', confirmReviewsImport);
  }

  function renderReviewsImportList() {
    const s = RVI_STATE;
    $('rvi-list').innerHTML = s.reviews.map((r, idx) => {
      const stars = '★'.repeat(r.rating || 0) + '☆'.repeat(5 - (r.rating || 0));
      return `<label style="display:grid;grid-template-columns:auto 1fr;gap:12px;padding:11px;border:1px solid var(--border);border-radius:10px;margin-bottom:7px;background:var(--card);cursor:pointer">
        <input type="checkbox" class="rvi-cb" data-idx="${idx}" ${r.include ? 'checked' : ''}>
        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span style="color:#facc15;font-size:13px">${stars}</span>
            <span class="pill sentiment-${r.rating >= 4 ? 'positive' : r.rating <= 2 ? 'negative' : 'neutral'}">${r.rating ? r.rating + '★' : 'no rating'}</span>
            ${r.verified ? '<span class="pill" style="background:var(--ok-bg);color:var(--ok)">verified</span>' : ''}
            ${r.posted_at ? `<span style="font-size:10.5px;color:var(--text3)">${escapeHtml(prettyDate(r.posted_at))}</span>` : ''}
            ${r.reviewer_name ? `<span style="font-size:10.5px;color:var(--text3)">— ${escapeHtml(r.reviewer_name)}</span>` : ''}
          </div>
          ${r.title ? `<div style="font-size:12.5px;font-weight:650;margin-top:4px">${escapeHtml(r.title)}</div>` : ''}
          <div style="font-size:12px;color:var(--text2);margin-top:3px;line-height:1.5;white-space:pre-wrap">${escapeHtml((r.body || '').slice(0, 600))}${(r.body || '').length > 600 ? '…' : ''}</div>
        </div>
      </label>`;
    }).join('');
    $('rvi-list').querySelectorAll('.rvi-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = Number(cb.dataset.idx);
        s.reviews[idx].include = cb.checked;
      });
    });
  }

  async function confirmReviewsImport() {
    const s = RVI_STATE;
    const chosen = s.reviews.filter(r => r.include);
    if (!chosen.length) return toast('Pick at least one review to save', 'err');
    $('rvi-save').disabled = true;
    $('rvi-save').textContent = 'Saving…';
    try {
      const r = await apiPost('/api/flavor-reviews/import/reviews-confirm', {
        flavor_id: s.flavor_id,
        source: s.source,
        url: s.url,
        reviews: chosen,
      });
      $('rvi-step-2').style.display = 'none';
      const step3 = $('rvi-step-3');
      step3.style.display = '';
      step3.innerHTML = `
        <div class="card">
          <div class="card-head"><h3>Done</h3></div>
          <div class="import-result">
            <div class="pill-stat" style="border-color:#bbf7d0;background:var(--ok-bg)"><div class="v" style="color:var(--ok)">${r.created.length}</div><div class="l">Saved</div></div>
            <div class="pill-stat" style="border-color:#fde68a;background:var(--warn-bg)"><div class="v" style="color:var(--warn)">${r.skipped.length}</div><div class="l">Skipped (duplicate)</div></div>
            <div class="pill-stat" style="border-color:#fecaca;background:var(--danger-bg)"><div class="v" style="color:var(--danger)">${r.errors.length}</div><div class="l">Errors</div></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn-primary" onclick="window.location.hash='/flavor/${s.flavor_id}/reviews'">View reviews →</button>
            <button class="btn-sec" onclick="window.location.hash='/flavor/${s.flavor_id}/reviews-import';location.reload()">Import more</button>
          </div>
        </div>
      `;
      toast(`Saved ${r.created.length} review${r.created.length === 1 ? '' : 's'}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
      $('rvi-save').disabled = false;
      $('rvi-save').textContent = 'Save selected';
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────
  async function renderSettings() {
    loadingShell();
    let s;
    try { s = await apiGet('/api/flavor-reviews/settings'); SETTINGS_CACHE = s; }
    catch (e) { pageShell(`<div class="empty-state">${escapeHtml(e.message)}</div>`); return; }

    pageShell(`
      <div class="fr-topbar">
        ${backChip('/', 'Dashboard')}
        ${breadcrumb([{ label: 'Dashboard', href: '/' }, { label: 'Settings' }])}
      </div>

      <div class="fr-header">
        <div class="fr-title-block">
          <h1 class="fr-title"><span class="fr-emoji">⚙️</span> Settings</h1>
          <p class="fr-lede">Tune the review cadence, the default reviewer, and how aggressively AI bumps priority when bad reviews start piling up.</p>
        </div>
      </div>

      <div class="card" style="max-width:640px">
        <div class="form-grid">
          <div class="form-row">
            <label class="fr-label">Review cadence</label>
            <select id="set-cadence">
              ${[1,2,3,4,6,9,12].map(n => `<option value="${n}" ${s.cadence_months === n ? 'selected' : ''}>Every ${n} month${n === 1 ? '' : 's'}</option>`).join('')}
            </select>
            <div style="font-size:11px;color:var(--text3);margin-top:5px">When a cycle is marked done, the next one auto-schedules this far out.</div>
          </div>
          <div class="form-row">
            <label class="fr-label">Default reviewer</label>
            <select id="set-reviewer">
              <option value="">(unassigned)</option>
              ${(s.team || []).map(u => `<option value="${u.id}" ${s.default_reviewer_id === u.id ? 'selected' : ''}>${escapeHtml(u.name)} (${escapeHtml(u.email)})</option>`).join('')}
            </select>
            <div style="font-size:11px;color:var(--text3);margin-top:5px">Who newly auto-scheduled cycles get assigned to.</div>
          </div>
          <div class="form-row">
            <label class="fr-label">Bad-review threshold</label>
            <input type="number" id="set-threshold" min="1" max="20" value="${s.bad_review_threshold}">
            <div style="font-size:11px;color:var(--text3);margin-top:5px">When this many open bad reviews land in 30d, AI auto-bumps the cycle's priority and pulls in the date.</div>
          </div>
          <div class="form-row">
            <label class="fr-label">Auto-schedule</label>
            <select id="set-auto">
              <option value="1" ${s.auto_schedule ? 'selected' : ''}>On — schedule next cycle when one is completed</option>
              <option value="0" ${!s.auto_schedule ? 'selected' : ''}>Off — only manual scheduling</option>
            </select>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="btn-primary" id="set-save">Save</button>
          <button class="btn-sec" onclick="window.location.hash='/'">Cancel</button>
        </div>
      </div>

      <div class="card" style="max-width:760px;margin-top:16px">
        <div class="card-head">
          <h3>📥 Scraper bookmarklet</h3>
        </div>
        <p style="font-size:12.5px;color:var(--text2);line-height:1.55;margin:0 0 12px">
          Amazon blocks most automated scrapes. The bookmarklet sidesteps that by running inside <em>your</em> browser
          tab — your real Amazon session does the work. One click captures the rendered page (including JS-injected
          variations and reviews) and sends it here, then Claude parses it on demand.
        </p>
        <div id="scr-setup-body" style="min-height:80px;font-size:12px;color:var(--text3)">Loading…</div>
      </div>
    `);

    $('set-save').addEventListener('click', async () => {
      try {
        const payload = {
          cadence_months: Number($('set-cadence').value),
          default_reviewer_id: $('set-reviewer').value ? Number($('set-reviewer').value) : null,
          bad_review_threshold: Number($('set-threshold').value),
          auto_schedule: $('set-auto').value === '1',
        };
        await apiPatch('/api/flavor-reviews/settings', payload);
        toast('Settings saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    loadScraperSetup();
  }

  async function loadScraperSetup() {
    const host = $('scr-setup-body');
    if (!host) return;
    try {
      const c = await apiGet('/api/flavor-reviews/scraper/config');
      renderScraperSetup(c);
    } catch (e) {
      host.innerHTML = `<div style="color:var(--danger)">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderScraperSetup(c) {
    const host = $('scr-setup-body');
    // We render the bookmarklet as an <a href="javascript:..."> — the
    // backend has already URI-encoded the JS body, so the browser treats
    // the whole thing as a draggable link. The visible label is what the
    // user will see in their bookmark bar.
    host.innerHTML = `
      <ol style="padding-left:18px;margin:0 0 10px;line-height:1.7;font-size:12.5px;color:var(--text2)">
        <li>Show your browser's bookmark bar if it's hidden (View → Show Bookmarks Bar in most browsers).</li>
        <li><strong>Drag</strong> the button below onto your bookmark bar. (Right-clicking → "Bookmark this link" also works.)</li>
        <li>Go to any Amazon product or reviews page and click the bookmark. A floating "✓ Sent to Syruvia" appears when it lands.</li>
        <li>Come back here to <a onclick="window.location.hash='/import'" style="color:var(--accent);cursor:pointer">Import</a> (for products) or to a flavor's <em>Import reviews</em> (for reviews) — your capture is at the top of the inbox.</li>
      </ol>

      ${c.origin.startsWith('http://') && !c.origin.includes('localhost') ? `
        <div class="card" style="border-color:#fde68a;background:var(--warn-bg);padding:11px;margin:10px 0;font-size:11.5px">
          ⚠️ Your app origin is <code>${escapeHtml(c.origin)}</code> (plain HTTP). Amazon is HTTPS, so the browser will block the bookmarklet's POST as mixed content. Serve the app over HTTPS for the bookmarklet to work from amazon.com.
        </div>` : ''}

      <div style="background:var(--bg2);padding:14px;border-radius:10px;margin:14px 0 8px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <a href="${c.bookmarklet}" id="scr-drag"
           style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:white;padding:10px 16px;border-radius:8px;font-weight:650;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;cursor:grab"
           draggable="true"
           onclick="event.preventDefault();alert('Drag this link to your browser bookmark bar — don\\'t click it here.')"
          >📥 Send to Syruvia</a>
        <div style="font-size:11.5px;color:var(--text3);flex:1;min-width:200px">
          ↑ Drag this purple button to your bookmark bar. Clicking it here won't do anything useful — it's meant to live on the bookmark bar so it can run on amazon.com.
        </div>
      </div>

      <details style="margin-top:8px">
        <summary style="cursor:pointer;font-size:12px;color:var(--text3)">Bookmarklet not working? Show the raw URL / token</summary>
        <div style="margin-top:10px;font-size:11.5px;color:var(--text2)">
          <div style="margin-bottom:6px"><strong>Origin:</strong> <code>${escapeHtml(c.origin)}</code></div>
          <div style="margin-bottom:6px"><strong>Token:</strong> <code style="font-family:ui-monospace,Menlo,monospace">${escapeHtml(c.token)}</code></div>
          <div style="margin-bottom:10px">If you ever paste your token somewhere insecure, rotate it. The old bookmarklet stops working immediately and the new one needs to be re-dragged.</div>
          <button class="btn-sec btn-tiny" id="scr-rotate">Rotate token (invalidates current bookmarklet)</button>
        </div>
      </details>

      <details style="margin-top:8px">
        <summary style="cursor:pointer;font-size:12px;color:var(--text3)">Recent inbox captures</summary>
        <div id="scr-inbox" style="margin-top:10px;font-size:12px">Loading…</div>
      </details>
    `;
    const rot = $('scr-rotate');
    if (rot) rot.addEventListener('click', async () => {
      if (!confirm('Rotate the workspace scraper token? The current bookmarklet will stop working until you re-drag the new one.')) return;
      try {
        const c2 = await apiPost('/api/flavor-reviews/scraper/rotate-token', {});
        renderScraperSetup(c2);
        toast('Token rotated. Re-drag the bookmarklet.', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    loadScraperInbox();
  }

  async function loadScraperInbox() {
    const host = $('scr-inbox');
    if (!host) return;
    try {
      const { items } = await apiGet('/api/flavor-reviews/scraper/inbox');
      if (!items.length) { host.innerHTML = '<em style="color:var(--text3)">Nothing in the inbox yet. Click your bookmarklet on an Amazon page to send the first capture.</em>'; return; }
      host.innerHTML = items.map(it => `
        <div style="display:flex;gap:10px;align-items:center;padding:9px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
          <span class="pill" style="background:${it.kind === 'reviews' ? 'var(--info-bg)' : 'var(--ok-bg)'};color:${it.kind === 'reviews' ? 'var(--info)' : 'var(--ok)'}">${it.kind}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.page_title || it.source_url || '(no title)')}</div>
            <div style="font-size:10.5px;color:var(--text3)">${escapeHtml(prettyDate(it.created_at))} · ${(it.bytes / 1024).toFixed(1)} KB · ${it.page_count} page${it.page_count === 1 ? '' : 's'} · ${escapeHtml(it.status)}</div>
          </div>
          <button class="btn-tiny btn-danger" onclick="FR.deleteInbox(${it.id})">×</button>
        </div>
      `).join('');
    } catch (e) {
      host.innerHTML = `<div style="color:var(--danger)">${escapeHtml(e.message)}</div>`;
    }
  }

  // ── Modals ─────────────────────────────────────────────────────────────
  function modal(html) {
    const bg = document.createElement('div');
    bg.className = 'fr-modal-bg show';
    bg.innerHTML = `<div class="fr-modal">${html}</div>`;
    document.body.appendChild(bg);
    bg.addEventListener('click', (ev) => { if (ev.target === bg) close(); });
    function close() { bg.remove(); }
    return { el: bg, close };
  }

  function openFlavorModal(existing) {
    const isEdit = !!existing;
    const m = modal(`
      <h3>${isEdit ? 'Edit flavor' : 'Add flavor'}</h3>
      <div class="form-row">
        <label class="fr-label">Name</label>
        <input type="text" id="m-name" value="${escapeAttr(existing?.name || '')}">
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="fr-label">Kind</label>
          <select id="m-kind">
            ${['coffee','cocktail','fruit','tea','latte','smoothie','unique','other'].map(k => `<option value="${k}" ${(existing?.kind || 'coffee') === k ? 'selected' : ''}>${cap(k)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label class="fr-label">Variant</label>
          <select id="m-variant">
            <option value="regular"    ${(existing?.variant || 'regular') === 'regular' ? 'selected' : ''}>Regular</option>
            <option value="sugar_free" ${existing?.variant === 'sugar_free' ? 'selected' : ''}>Sugar-free</option>
          </select>
        </div>
      </div>
      ${isEdit ? `
      <div class="form-row">
        <label class="fr-label">Status</label>
        <select id="m-status">
          <option value="active"       ${existing?.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="discontinued" ${existing?.status === 'discontinued' ? 'selected' : ''}>Discontinued</option>
        </select>
      </div>` : ''}
      <div class="form-row">
        <label class="fr-label">Notes</label>
        <textarea id="m-notes">${escapeHtml(existing?.notes || '')}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">${isEdit ? 'Save' : 'Add flavor'}</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      const payload = {
        name: m.el.querySelector('#m-name').value.trim(),
        kind: m.el.querySelector('#m-kind').value,
        variant: m.el.querySelector('#m-variant').value,
        notes: m.el.querySelector('#m-notes').value,
      };
      if (isEdit) payload.status = m.el.querySelector('#m-status').value;
      if (!payload.name) return toast('Name required', 'err');
      try {
        if (isEdit) {
          await apiPatch('/api/flavor-reviews/flavors/' + existing.id, payload);
          m.close();
          renderFlavor(existing.id, CURRENT_FLAVOR_TAB);
        } else {
          const r = await apiPost('/api/flavor-reviews/flavors', payload);
          m.close();
          toast('Flavor added', 'ok');
          goto('/flavor/' + r.id);
        }
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openNotesModal(f) {
    const m = modal(`
      <h3>Notes for ${escapeHtml(f.name)}</h3>
      <div class="form-row">
        <textarea id="m-notes" style="min-height:180px">${escapeHtml(f.notes || '')}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Save</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      try {
        await apiPatch('/api/flavor-reviews/flavors/' + f.id, { notes: m.el.querySelector('#m-notes').value });
        m.close();
        renderFlavor(f.id, CURRENT_FLAVOR_TAB);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openLinkModal(flavorId, existing) {
    const isEdit = !!existing;
    const m = modal(`
      <h3>${isEdit ? 'Edit sell-link' : 'Add sell-link'}</h3>
      <div class="form-row">
        <label class="fr-label">Channel</label>
        <input type="text" id="m-channel" placeholder="Amazon, Walmart, Website…" value="${escapeAttr(existing?.channel || '')}">
      </div>
      <div class="form-row">
        <label class="fr-label">URL</label>
        <input type="url" id="m-url" placeholder="https://…" value="${escapeAttr(existing?.url || '')}">
      </div>
      <div class="form-row">
        <label class="fr-label">Notes (optional)</label>
        <input type="text" id="m-notes" placeholder="e.g. main listing, pump variant, etc." value="${escapeAttr(existing?.notes || '')}">
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">${isEdit ? 'Save' : 'Add'}</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      const payload = {
        channel: m.el.querySelector('#m-channel').value.trim(),
        url: m.el.querySelector('#m-url').value.trim(),
        notes: m.el.querySelector('#m-notes').value,
      };
      if (!payload.channel || !payload.url) return toast('Channel and URL required', 'err');
      try {
        if (isEdit) await apiPatch('/api/flavor-reviews/links/' + existing.id, payload);
        else        await apiPost('/api/flavor-reviews/flavors/' + flavorId + '/links', payload);
        m.close();
        if (CURRENT_FLAVOR) renderFlavor(flavorId, CURRENT_FLAVOR_TAB);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openReviewModal(flavorId) {
    const m = modal(`
      <h3>Log a review</h3>
      <div class="form-grid">
        <div class="form-row">
          <label class="fr-label">Source</label>
          <input type="text" id="m-source" placeholder="Amazon, Walmart, Website, …">
        </div>
        <div class="form-row">
          <label class="fr-label">Rating (0–5)</label>
          <select id="m-rating">
            ${[5,4,3,2,1,0].map(n => `<option value="${n}">${n}★${n === 0 ? ' (unknown)' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label class="fr-label">Reviewer name</label>
          <input type="text" id="m-name">
        </div>
        <div class="form-row">
          <label class="fr-label">Posted date</label>
          <input type="date" id="m-posted">
        </div>
      </div>
      <div class="form-row">
        <label class="fr-label">Title</label>
        <input type="text" id="m-title">
      </div>
      <div class="form-row">
        <label class="fr-label">Body</label>
        <textarea id="m-body" style="min-height:120px"></textarea>
      </div>
      <div class="form-row">
        <label class="fr-label">URL (optional)</label>
        <input type="url" id="m-url">
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Log review</button>
      </div>
    `);
    m.el.querySelector('#m-rating').value = '3';
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      const payload = {
        source: m.el.querySelector('#m-source').value.trim(),
        rating: Number(m.el.querySelector('#m-rating').value),
        reviewer_name: m.el.querySelector('#m-name').value.trim(),
        title: m.el.querySelector('#m-title').value.trim(),
        body: m.el.querySelector('#m-body').value,
        url: m.el.querySelector('#m-url').value.trim(),
        posted_at: m.el.querySelector('#m-posted').value,
      };
      if (!payload.source) return toast('Source required (e.g. Amazon)', 'err');
      try {
        await apiPost('/api/flavor-reviews/flavors/' + flavorId + '/reviews', payload);
        m.close();
        toast('Review logged', 'ok');
        renderFlavor(flavorId, CURRENT_FLAVOR_TAB);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openIssueModal(flavorId, suggestedReviews) {
    const m = modal(`
      <h3>Create issue</h3>
      <div class="form-row">
        <label class="fr-label">Title</label>
        <input type="text" id="m-title" placeholder="e.g. Bottle leaks during shipping">
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="fr-label">Severity</label>
          <select id="m-severity">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div class="form-row" style="align-self:end">
          <div style="font-size:11px;color:var(--text3)">${suggestedReviews.length} open bad review${suggestedReviews.length === 1 ? '' : 's'} on this flavor — pick the ones this issue covers.</div>
        </div>
      </div>
      <div class="form-row">
        <label class="fr-label">Summary</label>
        <textarea id="m-summary" placeholder="What's the underlying problem? What might fix it?"></textarea>
      </div>
      ${suggestedReviews.length ? `
      <div class="form-row">
        <label class="fr-label">Attach reviews</label>
        <div class="merge-list">
          ${suggestedReviews.map(r => `
            <label class="merge-row" style="cursor:pointer">
              <span style="display:flex;align-items:center;gap:10px">
                <input type="checkbox" value="${r.id}" class="m-review-cb" checked>
                <span>
                  <strong style="font-size:12px">${escapeHtml(r.title || '(no title)')}</strong>
                  <span style="font-size:11px;color:var(--text3);display:block">${'★'.repeat(r.rating)} ${escapeHtml(r.source)} · ${escapeHtml((r.body || '').slice(0, 100))}…</span>
                </span>
              </span>
            </label>`).join('')}
        </div>
      </div>` : ''}
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Create issue</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      const title = m.el.querySelector('#m-title').value.trim();
      if (!title) return toast('Title required', 'err');
      const reviewIds = [].slice.call(m.el.querySelectorAll('.m-review-cb'))
        .filter(cb => cb.checked).map(cb => Number(cb.value));
      try {
        const r = await apiPost('/api/flavor-reviews/flavors/' + flavorId + '/issues', {
          title,
          severity: m.el.querySelector('#m-severity').value,
          summary: m.el.querySelector('#m-summary').value,
          from_review_ids: reviewIds,
        });
        m.close();
        toast('Issue created', 'ok');
        goto('/issue/' + r.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openIssueEditModal(issue) {
    const m = modal(`
      <h3>Edit issue</h3>
      <div class="form-row">
        <label class="fr-label">Title</label>
        <input type="text" id="m-title" value="${escapeAttr(issue.title)}">
      </div>
      <div class="form-row">
        <label class="fr-label">Severity</label>
        <select id="m-severity">
          ${['low','medium','high','critical'].map(s => `<option value="${s}" ${issue.severity === s ? 'selected' : ''}>${cap(s)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label class="fr-label">Summary</label>
        <textarea id="m-summary" style="min-height:140px">${escapeHtml(issue.summary)}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Save</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      try {
        await apiPatch('/api/flavor-reviews/issues/' + issue.id, {
          title: m.el.querySelector('#m-title').value,
          severity: m.el.querySelector('#m-severity').value,
          summary: m.el.querySelector('#m-summary').value,
        });
        m.close();
        renderIssue(issue.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openFixModal(issue) {
    const m = modal(`
      <h3>Mark "${escapeHtml(issue.title)}" fixed</h3>
      <p style="font-size:12.5px;color:var(--text2);margin-top:0">Write what was actually done. Future duplicate-detection uses this resolution, so be specific.</p>
      <div class="form-row">
        <label class="fr-label">What was done?</label>
        <textarea id="m-resolution" style="min-height:140px" placeholder="e.g. Switched to thicker PE bottle (vendor X, SKU Y). Started shipping new batch on 2026-04-10."></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Mark fixed</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      const resolution = m.el.querySelector('#m-resolution').value.trim();
      if (!resolution) return toast('Tell us what was done', 'err');
      try {
        await apiPatch('/api/flavor-reviews/issues/' + issue.id, { status: 'fixed', resolution });
        m.close();
        toast('Marked fixed', 'ok');
        renderIssue(issue.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openIgnoreModal(issue) {
    const m = modal(`
      <h3>Ignore "${escapeHtml(issue.title)}"</h3>
      <p style="font-size:12.5px;color:var(--text2);margin-top:0">Optional reason — helps future-you remember why this wasn't worth chasing.</p>
      <div class="form-row">
        <textarea id="m-reason" style="min-height:100px"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Ignore</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      try {
        await apiPatch('/api/flavor-reviews/issues/' + issue.id, {
          status: 'ignored',
          ignored_reason: m.el.querySelector('#m-reason').value,
        });
        m.close();
        renderIssue(issue.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function openMergeModal(issue) {
    const cands = issue.merge_candidates || [];
    if (!cands.length) {
      toast('No other open issues on this flavor to merge into.', 'err');
      return;
    }
    let selected = null;
    const m = modal(`
      <h3>Merge "${escapeHtml(issue.title)}" into another open issue</h3>
      <p style="font-size:12.5px;color:var(--text2);margin-top:0">Use this when the same complaint keeps arriving while your fix is in flight. All reviews attached here will move to the target issue.</p>
      <div class="merge-list">
        ${cands.map(c => `
          <div class="merge-row" data-id="${c.id}">
            <div>
              <div style="font-weight:600">${escapeHtml(c.title)}</div>
              <div style="font-size:10.5px;color:var(--text3);margin-top:2px">Created ${escapeHtml(prettyDate(c.created_at))}</div>
            </div>
            <span class="pill sev-${escapeAttr(c.severity)}">${escapeHtml(c.severity)}</span>
          </div>
        `).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save" disabled>Merge</button>
      </div>
    `);
    m.el.querySelectorAll('.merge-row').forEach(r => {
      r.addEventListener('click', () => {
        m.el.querySelectorAll('.merge-row').forEach(x => x.classList.remove('selected'));
        r.classList.add('selected');
        selected = Number(r.dataset.id);
        m.el.querySelector('#m-save').disabled = false;
      });
    });
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      if (!selected) return;
      try {
        await apiPatch('/api/flavor-reviews/issues/' + issue.id, { status: 'merged', merged_into_id: selected });
        m.close();
        toast('Merged', 'ok');
        renderIssue(issue.id);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function openCycleModal(flavorId) {
    if (!SETTINGS_CACHE) SETTINGS_CACHE = await apiGet('/api/flavor-reviews/settings').catch(() => null);
    const team = SETTINGS_CACHE?.team || [];
    const tomorrow = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })();
    const m = modal(`
      <h3>Schedule a review cycle</h3>
      <div class="form-grid">
        <div class="form-row">
          <label class="fr-label">Date</label>
          <input type="date" id="m-date" value="${tomorrow}">
        </div>
        <div class="form-row">
          <label class="fr-label">Priority</label>
          <select id="m-prio">
            ${[1,2,3,4,5].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} ${n === 5 ? '(critical)' : n === 1 ? '(low)' : ''}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <label class="fr-label">Assignee</label>
        <select id="m-assignee">
          <option value="">(unassigned)</option>
          ${team.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn-sec" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Schedule</button>
      </div>
    `);
    m.el.querySelector('#m-cancel').addEventListener('click', m.close);
    m.el.querySelector('#m-save').addEventListener('click', async () => {
      try {
        await apiPost('/api/flavor-reviews/flavors/' + flavorId + '/cycles', {
          scheduled_for: m.el.querySelector('#m-date').value,
          assigned_to: m.el.querySelector('#m-assignee').value || null,
          priority: Number(m.el.querySelector('#m-prio').value),
        });
        m.close();
        toast('Scheduled', 'ok');
        renderFlavor(flavorId, CURRENT_FLAVOR_TAB);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function cap(s) { return String(s || '').replace(/\b\w/g, c => c.toUpperCase()).replace(/_/g, ' '); }
  function todayUtc() { return new Date().toISOString().slice(0, 10); }
  function prettyDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date((iso.length === 10 ? iso + 'T00:00:00Z' : iso));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    } catch { return iso; }
  }
  function kindEmoji(k) {
    const map = { coffee: '☕', cocktail: '🍸', fruit: '🍓', tea: '🍵', latte: '🥛', smoothie: '🥤', unique: '✨', other: '🫙' };
    return map[k] || '🫙';
  }

  // ── Public hooks (used by inline handlers in row HTML) ─────────────────
  window.FR = {
    openLinkModal,
    async deleteInbox(id) {
      if (!confirm('Delete this capture from the inbox?')) return;
      try {
        await apiDel('/api/flavor-reviews/scraper/inbox/' + id);
        // Re-render whichever inbox view is open right now.
        if (document.getElementById('scr-inbox')) loadScraperInbox();
      } catch (e) { toast(e.message, 'err'); }
    },
    refreshInbox(hostId, kind) { renderInboxPanel(hostId, kind); },
    async pickInbox(id, kind) {
      // Called from inside the /import or /flavor/:id/reviews-import flow.
      // Parse the capture, then jump into the same approval grid as paste-mode.
      try {
        toast('Parsing capture with Claude…', 'ok');
        const r = await apiPost('/api/flavor-reviews/scraper/parse/' + id, {});
        if (kind === 'reviews') {
          if (!r.reviews || !r.reviews.length) { toast('No reviews parsed from that capture.', 'err'); return; }
          await apiPost('/api/flavor-reviews/scraper/inbox/' + id + '/consume', {});
          finishReviewsExtract(r.reviews, r.source_url);
        } else {
          if (!r.variations || !r.variations.length) { toast('No variations parsed from that capture.', 'err'); return; }
          await apiPost('/api/flavor-reviews/scraper/inbox/' + id + '/consume', {});
          finishExtract({ ok: true, ...r });
        }
      } catch (e) { toast(e.message, 'err'); }
    },
    async editLink(id) {
      const link = CURRENT_FLAVOR.links.find(l => l.id === id);
      if (link) openLinkModal(CURRENT_FLAVOR.id, link);
    },
    async deleteLink(id) {
      if (!confirm('Delete this sell-link?')) return;
      try { await apiDel('/api/flavor-reviews/links/' + id); renderFlavor(CURRENT_FLAVOR.id, CURRENT_FLAVOR_TAB); }
      catch (e) { toast(e.message, 'err'); }
    },
    async markReview(id, status) {
      try { await apiPatch('/api/flavor-reviews/reviews/' + id, { status }); renderFlavor(CURRENT_FLAVOR.id, CURRENT_FLAVOR_TAB); }
      catch (e) { toast(e.message, 'err'); }
    },
    async attachReviewToIssue(reviewId) {
      const openIssues = CURRENT_FLAVOR.issues.filter(i => i.status === 'open');
      if (!openIssues.length) {
        if (confirm('No open issues yet. Create a new issue for this review?')) {
          const r = CURRENT_FLAVOR.reviews.find(x => x.id === reviewId);
          openIssueModal(CURRENT_FLAVOR.id, [r]);
        }
        return;
      }
      let html = `<h3>Attach this review to which issue?</h3><div class="merge-list">`;
      for (const i of openIssues) {
        html += `<div class="merge-row" data-id="${i.id}"><div><div style="font-weight:600">${escapeHtml(i.title)}</div><div style="font-size:10.5px;color:var(--text3);margin-top:2px">${i.review_count} review${i.review_count === 1 ? '' : 's'}, updated ${escapeHtml(prettyDate(i.updated_at))}</div></div><span class="pill sev-${escapeAttr(i.severity)}">${escapeHtml(i.severity)}</span></div>`;
      }
      html += `</div><div class="modal-actions"><button class="btn-sec" id="m-cancel">Cancel</button><button class="btn-sec" id="m-new" style="background:linear-gradient(135deg,#faf5ff,#fdf4ff);color:#7c3aed;border-color:#e9d5ff">+ New issue instead</button></div>`;
      const m = modal(html);
      let chosen = null;
      m.el.querySelectorAll('.merge-row').forEach(r => {
        r.addEventListener('click', async () => {
          chosen = Number(r.dataset.id);
          try { await apiPatch('/api/flavor-reviews/reviews/' + reviewId, { issue_id: chosen }); m.close(); toast('Attached', 'ok'); renderFlavor(CURRENT_FLAVOR.id, CURRENT_FLAVOR_TAB); }
          catch (e) { toast(e.message, 'err'); }
        });
      });
      m.el.querySelector('#m-cancel').addEventListener('click', m.close);
      m.el.querySelector('#m-new').addEventListener('click', () => {
        m.close();
        const r = CURRENT_FLAVOR.reviews.find(x => x.id === reviewId);
        openIssueModal(CURRENT_FLAVOR.id, [r]);
      });
    },
    async aiFindDuplicates(reviewId) {
      try {
        toast('✨ Asking AI…');
        const r = await apiPost('/api/flavor-reviews/reviews/' + reviewId + '/ai/find-duplicates');
        if (!r.matches.length) {
          toast('No duplicates found', 'ok');
          return;
        }
        let html = `<h3>✨ AI thinks these might be the same complaint</h3><p style="font-size:12px;color:var(--text2)">If one of these already fixed it, you can mark this review addressed and skip making a new issue. If a fix is still in flight, attach this review to that issue.</p><div class="merge-list">`;
        for (const i of r.matches) {
          html += `<div class="merge-row" data-id="${i.id}"><div><div style="font-weight:600">${escapeHtml(i.title)}</div>${i.resolution ? `<div style="font-size:11px;color:var(--ok);margin-top:2px">Fixed: ${escapeHtml(i.resolution.slice(0, 140))}</div>` : ''}${i.summary ? `<div style="font-size:10.5px;color:var(--text3);margin-top:2px">${escapeHtml(i.summary.slice(0, 140))}</div>` : ''}</div><span class="pill status-${escapeAttr(i.status)}">${escapeHtml(i.status)}</span></div>`;
        }
        html += `</div><div class="modal-actions"><button class="btn-sec" id="m-cancel">Close</button></div>`;
        const m = modal(html);
        m.el.querySelectorAll('.merge-row').forEach(row => {
          row.addEventListener('click', async () => {
            const id = Number(row.dataset.id);
            const issue = r.matches.find(x => x.id === id);
            if (issue.status === 'open') {
              try { await apiPatch('/api/flavor-reviews/reviews/' + reviewId, { issue_id: id }); m.close(); toast('Attached to existing issue', 'ok'); renderFlavor(CURRENT_FLAVOR.id, CURRENT_FLAVOR_TAB); }
              catch (e) { toast(e.message, 'err'); }
            } else {
              // Fixed/merged/ignored — mark this review addressed without creating a new issue.
              try { await apiPatch('/api/flavor-reviews/reviews/' + reviewId, { issue_id: id, status: 'addressed' }); m.close(); toast('Marked addressed — same as issue #' + id, 'ok'); renderFlavor(CURRENT_FLAVOR.id, CURRENT_FLAVOR_TAB); }
              catch (e) { toast(e.message, 'err'); }
            }
          });
        });
        m.el.querySelector('#m-cancel').addEventListener('click', m.close);
      } catch (e) { toast(e.message, 'err'); }
    },
    async startCycle(cycleId) {
      try { await apiPatch('/api/flavor-reviews/cycles/' + cycleId, { status: 'in_progress' }); renderDashboard(); }
      catch (e) { toast(e.message, 'err'); }
    },
  };

  // ── Route dispatcher ───────────────────────────────────────────────────
  function renderRoute() {
    const r = currentRoute();
    if (r.view === 'dashboard')      return renderDashboard();
    if (r.view === 'flavors')        return renderFlavors();
    if (r.view === 'flavor')         return renderFlavor(r.id, r.tab);
    if (r.view === 'issue')          return renderIssue(r.id);
    if (r.view === 'calendar')       return renderCalendar(r.month);
    if (r.view === 'bulk-import')    return renderBulkImport();
    if (r.view === 'import')         return renderImport();
    if (r.view === 'reviews-import') return renderReviewsImport(r.id);
    if (r.view === 'settings')       return renderSettings();
    return renderDashboard();
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  (async function boot() {
    const ok = await checkAuth();
    if (!ok) return;
    renderRoute();
  })();

})();
