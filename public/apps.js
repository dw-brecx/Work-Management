// ─────────────────────────────────────────────────────────────────────────────
// Apps — design-to-dev handoff UI
//
// Standalone single-page app served from /apps.html. Manages a list of
// design apps (HTML pages dropped by a designer), per-page blueprints,
// a per-page Q&A thread, and a function checklist. Talks to
// /api/apps/* — see routes/apps.js for the server side.
//
// Two top-level views, switched by location.hash:
//   #/            → list of apps (cards)
//   #/:id         → app detail (sidebar of pages + selected-page pane)
//   #/:id/p/:pid  → app detail with a specific page open
//
// No framework — vanilla DOM rendering. State lives in plain objects on
// `state`; render() rewrites the DOM from state on each change. Fast
// enough at the scale we expect (dozens of apps, dozens of pages).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const root = document.getElementById('ap-app');
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1'];

  const state = {
    me: null,
    team: [],
    view: 'list',     // 'list' | 'detail'
    apps: [],
    app: null,        // currently loaded app (with .pages)
    pageView: 'dashboard', // 'dashboard' (app overview) | 'page' | 'ticket'
    sidebarSection: 'pages', // 'pages' | 'tickets' | 'items'
    selectedPageId: null,
    pageDetail: null, // currently loaded page with html_content
    tab: 'preview',   // 'preview' | 'blueprint' | 'qa' | 'todos' | 'functions'
    comments: [],
    functions: [],
    todos: [],
    annotations: [],
    annotateMode: false,
    interactiveMode: false, // run scripts in the preview iframe (off by default)
    penMode: false,        // pen tool active (overrides click-to-pin)
    penStrokes: [],        // [[{x,y},...], ...] currently-drawn strokes
    penBgImage: null,      // HTMLCanvasElement returned by html2canvas — the design snapshot taken when pen mode activates. Drawn as the bottom layer so the canvas can be exported as a single image (no SVG-foreignObject taint).
    penSnapshotInflight: false,
    penColor: '#ef4444',
    penWidth: 3,
    pendingPin: null, // { x_pct, y_pct, snippetBlob? } while the new-annotation popover is open
    pendingAttachments: [], // [{ name, blob, mime, kind: 'image'|'audio'|'video'|'file' }] queued for upload after save
    blueprintLang: 'en', // 'en' | 'bn'
    blueprintBn: '', // cached BN translation, fetched on demand
    dashboard: null,  // loaded by loadDashboard
    dashAllTab: 'comments',
    // Tickets — per-app ticket system, surfaced on the sidebar.
    tickets: [],
    ticketFilter: 'all', // 'all' | 'open' | 'closed'
    selectedTicketId: null,
    ticketDetail: null, // loaded ticket with comments
    // Items — flat feed of every Q&A comment, pin annotation, and todo
    // across the whole app, surfaced in the sidebar. Hydrated from the
    // dashboard payload (which already aggregates the same data) so we
    // don't need a second round-trip.
    itemsFilter: 'all', // 'all' | 'qa' | 'pins' | 'todos'
    loading: false,
    error: null,
  };

  // Active recordings keyed by kind ('audio' | 'screen') so the UI can
  // surface a running timer + stop button. Each entry holds the
  // MediaRecorder, the destination stream, accumulated chunks, and the
  // started-at timestamp.
  const activeRecorders = { audio: null, screen: null };

  // ── API helpers ────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    if (r.status === 401) { window.location.href = '/login.html'; throw new Error('Not signed in'); }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await r.json() : await r.text();
    if (!r.ok) {
      const msg = (data && data.error) ? data.error : ('HTTP ' + r.status);
      throw new Error(msg);
    }
    return data;
  }

  // ── Toast ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    let el = document.getElementById('ap-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ap-toast';
      document.body.appendChild(el);
    }
    el.className = kind === 'err' ? 'show err' : (kind === 'ok' ? 'show ok' : 'show');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = el.className.replace('show', '').trim(); }, 2800);
  }

  // ── Routing (path-based, using History API) ──────────────────────────
  // URLs the user sees in the address bar:
  //   /apps               → list
  //   /apps/:id           → app detail (dashboard)
  //   /apps/:id/p/:pid    → page within an app
  //   /apps/:id/t/:tid    → ticket within an app
  //
  // Old hash-based routes (#/1/p/2) on /apps.html still work — the boot
  // code below transparently rewrites them to the new path form before
  // first render.
  function parsePath() {
    let path = window.location.pathname || '/';
    // Strip the /apps prefix. If we're on /apps.html (legacy) treat the
    // hash as the route source instead.
    let rest;
    if (path === '/apps' || path.startsWith('/apps/')) {
      rest = path.slice('/apps'.length);
    } else if (path === '/apps.html') {
      rest = (window.location.hash || '').replace(/^#/, '');
    } else {
      // Direct hit on apps.js without /apps — treat as list root.
      rest = '';
    }
    const parts = rest.split('/').filter(Boolean);
    if (parts.length === 0) return { view: 'list' };
    const appId = Number(parts[0]);
    if (!Number.isFinite(appId)) return { view: 'list' };
    let pageId = null, ticketId = null;
    if (parts[1] === 'p' && parts[2]) {
      const n = Number(parts[2]); if (Number.isFinite(n)) pageId = n;
    } else if (parts[1] === 't' && parts[2]) {
      const n = Number(parts[2]); if (Number.isFinite(n)) ticketId = n;
    }
    return { view: 'detail', appId, pageId, ticketId };
  }
  // Backwards-compat alias so the rest of the file can keep calling
  // parseHash(). The shape of the returned object is unchanged.
  const parseHash = parsePath;

  // Navigate to a new view. `subPath` looks like '/', '/1', '/1/p/2'.
  // We use pushState so each view has a real URL the user can copy,
  // bookmark, or hit refresh on without losing context.
  function navigate(subPath) {
    const path = '/apps' + (subPath === '/' || !subPath ? '' : subPath);
    if (window.location.pathname + window.location.hash === path) {
      handleRoute();
      return;
    }
    try {
      window.history.pushState(null, '', path);
    } catch {
      // Some embeds disable pushState — fall back to a full nav.
      window.location.href = path;
      return;
    }
    handleRoute();
  }

  async function handleRoute() {
    const route = parseHash();
    if (route.view === 'list') {
      state.view = 'list';
      state.app = null;
      state.pageDetail = null;
      render();
      await loadApps();
      return;
    }
    state.view = 'detail';
    if (!state.app || state.app.id !== route.appId) {
      state.app = null;
      state.pageDetail = null;
      state.selectedPageId = null;
      state.dashboard = null;
      state.tickets = [];
      state.ticketDetail = null;
      state.selectedTicketId = null;
      render();
      try {
        await loadApp(route.appId);
        // Eager-load tickets so the sidebar count badge is accurate even
        // before the user flips to the Tickets section.
        loadTickets().catch(() => {});
      } catch (e) {
        state.error = e.message;
        render();
        return;
      }
    }
    // Route precedence: ticket > page > dashboard.
    if (route.ticketId) {
      state.pageView = 'ticket';
      state.sidebarSection = 'tickets';
      if (route.ticketId !== state.selectedTicketId) {
        await selectTicket(route.ticketId);
        return;
      }
      render();
    } else if (route.pageId) {
      state.pageView = 'page';
      state.sidebarSection = 'pages';
      if (route.pageId !== state.selectedPageId) {
        await selectPage(route.pageId);
        return;
      }
      render();
    } else {
      state.pageView = 'dashboard';
      state.selectedPageId = null;
      state.selectedTicketId = null;
      render();
      loadDashboard().catch(e => toast(e.message, 'err'));
    }
  }

  // ── Loaders ────────────────────────────────────────────────────────────
  async function loadMe() {
    try {
      // /api/auth/me is the standard endpoint in this codebase; if the
      // session is dead this throws and we redirect from api() above.
      const me = await api('GET', '/api/auth/me');
      state.me = me;
    } catch (e) { /* unauthenticated handler in api() will redirect */ }
  }
  async function loadTeam() {
    try {
      state.team = await api('GET', '/api/team') || [];
    } catch (e) { state.team = []; }
  }
  async function loadApps() {
    state.loading = true; render();
    try {
      state.apps = await api('GET', '/api/apps') || [];
      state.error = null;
    } catch (e) {
      state.error = e.message;
    } finally {
      state.loading = false;
      render();
    }
  }
  async function loadApp(id) {
    state.loading = true;
    state.app = await api('GET', '/api/apps/' + id);
    state.loading = false;
  }
  async function selectPage(pageId) {
    state.pageView = 'page';
    state.selectedPageId = pageId;
    state.pageDetail = null;
    state.comments = [];
    state.functions = [];
    state.todos = [];
    state.annotations = [];
    state.blueprintBn = '';
    state.blueprintLang = 'en';
    state.annotateMode = false;
    state.pendingPin = null;
    render();
    try {
      const [page, comments, fns, todos, annotations] = await Promise.all([
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId),
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId + '/comments'),
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId + '/functions'),
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId + '/todos'),
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId + '/annotations'),
      ]);
      state.pageDetail = page;
      state.comments = comments || [];
      state.functions = fns || [];
      state.todos = todos || [];
      state.annotations = annotations || [];
      render();
      // If the blueprint is empty and the page was just created, the
      // server is likely still drafting one in the background. Poll up to
      // 6 times (every 5s = 30s total) so the draft appears without a
      // manual refresh. Stops as soon as we get something.
      maybePollForBlueprint(page);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function loadDashboard() {
    if (!state.app) return;
    try {
      const d = await api('GET', '/api/apps/' + state.app.id + '/dashboard');
      state.dashboard = d;
      render();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadTickets() {
    if (!state.app) return;
    try {
      const qs = state.ticketFilter && state.ticketFilter !== 'all' ? ('?status=' + state.ticketFilter) : '';
      state.tickets = await api('GET', '/api/apps/' + state.app.id + '/tickets' + qs) || [];
      render();
    } catch (e) { /* sidebar quietly shows empty list */ }
  }

  async function selectTicket(ticketId) {
    state.pageView = 'ticket';
    state.selectedTicketId = ticketId;
    state.ticketDetail = null;
    state.sidebarSection = 'tickets';
    render();
    try {
      const t = await api('GET', '/api/apps/' + state.app.id + '/tickets/' + ticketId);
      state.ticketDetail = t;
      // Make sure the list entry is in sync.
      const idx = state.tickets.findIndex(x => x.id === ticketId);
      if (idx >= 0) state.tickets[idx] = Object.assign({}, state.tickets[idx], t);
      else state.tickets.unshift(t);
      render();
    } catch (e) { toast(e.message, 'err'); }
  }

  // Poll for the auto-generated blueprint after page creation. Only runs
  // when the page is new (created within the last 90 seconds) and the
  // blueprint is still blank — anything older is assumed to have already
  // been handled (or the AI is disabled).
  let blueprintPollTimer = null;
  function maybePollForBlueprint(page) {
    if (blueprintPollTimer) { clearTimeout(blueprintPollTimer); blueprintPollTimer = null; }
    if (!page || (page.blueprint && page.blueprint.trim())) return;
    const created = new Date((page.created_at || '').replace(' ', 'T') + 'Z');
    if (isNaN(created.getTime())) return;
    if (Date.now() - created.getTime() > 90 * 1000) return;
    let tries = 0;
    const tick = async () => {
      tries++;
      if (!state.pageDetail || state.pageDetail.id !== page.id) return;
      if (state.pageDetail.blueprint && state.pageDetail.blueprint.trim()) return;
      try {
        const fresh = await api('GET', '/api/apps/' + state.app.id + '/pages/' + page.id);
        if (fresh.blueprint && fresh.blueprint.trim()) {
          state.pageDetail.blueprint = fresh.blueprint;
          // Refresh the sidebar list entry too so the indicator clears.
          const p = state.app.pages && state.app.pages.find(x => x.id === page.id);
          if (p) p.has_blueprint = true;
          render();
          return;
        }
      } catch (e) { /* ignore — keep polling */ }
      if (tries < 6) blueprintPollTimer = setTimeout(tick, 5000);
    };
    blueprintPollTimer = setTimeout(tick, 5000);
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function render() {
    if (state.view === 'list') return renderList();
    return renderDetail();
  }

  // Build the topbar. `crumbs` is an array of { label, path } — every
  // crumb except the last is a clickable back link. `path` is the
  // sub-route under /apps (e.g. '/' for the list, '/3' for app 3).
  // Two always-on affordances:
  //   * "Back to Syruvia" on the far left — full nav to the main app
  //   * "Apps" crumb — back to the apps list, even when deep in an app
  // so the user always has at least one way back at every level.
  function topbar(crumbs, actions) {
    const list = Array.isArray(crumbs) ? crumbs : [];
    // Accept legacy callers that passed an array of strings: convert
    // them to { label } objects so the breadcrumb still renders.
    const norm = list.map(c => (typeof c === 'string' ? { label: c } : c));
    // Always lead with an "Apps" crumb that links to the list — gives
    // the user a one-click back path no matter how deep they are.
    if (norm.length === 0 || norm[0].label !== 'Apps') {
      norm.unshift({ label: 'Apps', path: '/' });
    }
    const crumbsHtml = norm.map((c, i) => {
      const isLast = i === norm.length - 1;
      if (!isLast && c.path !== undefined) {
        return `<a class="ap-crumb-link" href="/apps${c.path === '/' ? '' : c.path}" data-nav-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</a>`;
      }
      return `<span class="ap-crumb-current">${escapeHtml(c.label)}</span>`;
    }).join('<span class="ap-crumb-sep">›</span>');
    return `
      <div class="ap-topbar">
        <a class="ap-back" href="/" title="Back to Syruvia / Tickets">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          <span>Back to Syruvia</span>
        </a>
        <span class="ap-crumb-sep">›</span>
        <div class="ap-crumbs">${crumbsHtml}</div>
        <div class="ap-spacer"></div>
        ${actions || ''}
        ${state.me ? `<div class="ap-me">${escapeHtml(state.me.name || state.me.email || '')}</div>` : ''}
      </div>
    `;
  }

  // Wire breadcrumb crumbs to client-side navigation so back clicks
  // pushState (no full page reload) like the rest of the app.
  function bindTopbarEvents() {
    document.querySelectorAll('.ap-crumb-link[data-nav-path]').forEach(a => {
      a.onclick = (e) => {
        e.preventDefault();
        navigate(a.getAttribute('data-nav-path') || '/');
      };
    });
  }

  function renderList() {
    const errBlock = state.error
      ? `<div class="ap-card-empty"><h3>Couldn't load apps</h3><p>${escapeHtml(state.error)}</p></div>`
      : '';
    const emptyBlock = (!state.loading && state.apps.length === 0 && !state.error) ? `
      <div class="ap-card-empty">
        <h3>No apps yet</h3>
        <p>Click <strong>New app</strong> to create your first one. Drop in HTML files from a Claude design, then assign a manager and a developer to take it through to launch.</p>
      </div>` : '';
    const cards = state.apps.map(a => {
      const fnTotal = a.fn_total || 0;
      const fnDone = a.fn_working || 0;
      const pct = fnTotal > 0 ? Math.round((fnDone / fnTotal) * 100) : 0;
      return `
        <div class="ap-card" data-app-id="${a.id}">
          <div class="ap-card-cover" style="background:${escapeHtml(a.cover_color || '#3b82f6')}">
            ${escapeHtml((a.name || '?').slice(0, 2).toUpperCase())}
          </div>
          <div class="ap-card-body">
            <div class="ap-card-title">${escapeHtml(a.name)}</div>
            <div class="ap-card-desc">${escapeHtml(a.description) || '<em style="color:#cbd5e1">No description</em>'}</div>
            <div class="ap-card-meta">
              <span class="ap-status-pill ap-status-${escapeHtml(a.status || 'design')}">${escapeHtml(a.status || 'design')}</span>
              <span class="ap-card-meta-chip" title="Pages">📄 ${a.page_count || 0}</span>
              <span class="ap-card-meta-chip" title="Working functions">✓ ${fnDone}/${fnTotal}${fnTotal ? ' · ' + pct + '%' : ''}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
    root.innerHTML = `
      ${topbar([], `<button class="btn btn-primary" id="ap-new-app">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        New app
      </button>`)}
      <div class="ap-main">
        <div class="ap-list-header">
          <div>
            <h2>App management</h2>
            <p>Track design apps from Claude — assign designer, manager, developer; review every page; verify functions before launch.</p>
          </div>
        </div>
        <div class="ap-grid">
          ${state.loading ? '<div class="ap-card-empty">Loading…</div>' : (errBlock || emptyBlock || cards)}
        </div>
      </div>
    `;
    const newBtn = document.getElementById('ap-new-app');
    if (newBtn) newBtn.onclick = () => openAppModal(null);
    root.querySelectorAll('.ap-card').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-app-id');
        navigate('/' + id);
      });
    });
    bindTopbarEvents();
  }

  function renderDetail() {
    if (state.loading && !state.app) {
      root.innerHTML = topbar([{ label: 'Loading…' }]) + '<div class="ap-boot">Loading app…</div>';
      bindTopbarEvents();
      return;
    }
    if (state.error) {
      root.innerHTML = topbar([{ label: 'Error' }]) + `<div class="ap-main"><div class="ap-card-empty"><h3>Couldn't open app</h3><p>${escapeHtml(state.error)}</p></div></div>`;
      bindTopbarEvents();
      return;
    }
    if (!state.app) return;
    const a = state.app;
    // Build crumbs based on the current view. Always: Apps › App name › …
    // The middle (App name) crumb is a link back to the app's dashboard
    // whenever we're inside a page or ticket; the last crumb is the
    // current location, not clickable.
    const detailCrumbs = [{ label: a.name, path: '/' + a.id }];
    if (state.pageView === 'dashboard') {
      // Just App name (last crumb, not clickable).
      detailCrumbs[detailCrumbs.length - 1] = { label: a.name };
    } else if (state.pageView === 'page' && state.pageDetail) {
      detailCrumbs.push({ label: state.pageDetail.name });
    } else if (state.pageView === 'ticket' && state.ticketDetail) {
      detailCrumbs.push({ label: '#' + state.ticketDetail.id + ' ' + state.ticketDetail.title });
    }
    const dashActive = state.pageView === 'dashboard';
    const pageList = (a.pages || []).map(p => {
      const isActive = state.pageView === 'page' && p.id === state.selectedPageId;
      const meta = [];
      if (p.fn_total) meta.push(`${p.fn_working}/${p.fn_total} fn`);
      if (p.comment_count) meta.push(`${p.comment_count} 💬`);
      // Provenance badge: 🔗 = synced from GitHub, ⚠ = file deleted in repo.
      const ghBadge = p.source === 'github'
        ? (p.repo_removed
            ? '<span class="ap-page-src ap-page-src-removed" title="File removed from repo">⚠</span>'
            : '<span class="ap-page-src ap-page-src-github" title="Synced from GitHub">🔗</span>')
        : '';
      return `
        <div class="ap-page-item ${isActive ? 'active' : ''} ${p.repo_removed ? 'removed' : ''}" data-page-id="${p.id}">
          <span class="ap-page-item-dot ${escapeHtml(p.status || 'pending')}" title="${escapeHtml(p.status || 'pending')}"></span>
          <div class="ap-page-item-text">
            <div class="ap-page-item-title">${ghBadge}${escapeHtml(p.name)}</div>
            <div class="ap-page-item-meta">${escapeHtml(meta.join(' · '))}</div>
          </div>
        </div>
      `;
    }).join('');

    root.innerHTML = `
      ${topbar(detailCrumbs, `
        <button class="btn btn-secondary btn-small" id="ap-edit-app" title="Edit app settings">
          <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Settings
        </button>
      `)}
      <div class="ap-main">
        <div class="ap-detail">
          <aside class="ap-sidebar">
            <div class="ap-sidebar-head">
              <h3>
                <span class="ap-color-dot" style="background:${escapeHtml(a.cover_color || '#3b82f6')}"></span>
                ${escapeHtml(a.name)}
              </h3>
              <p>${escapeHtml(a.description) || '<em style="color:#cbd5e1">No description yet</em>'}</p>
              <div style="margin-top:10px"><span class="ap-status-pill ap-status-${escapeHtml(a.status || 'design')}">${escapeHtml(a.status || 'design')}</span></div>
            </div>
            <div class="ap-assignees">
              ${assigneeRow('Designer', a.designer_name)}
              ${assigneeRow('Manager', a.manager_name)}
              ${assigneeRow('Developer', a.developer_name)}
            </div>
            <div class="ap-sb-toggle">
              <button class="ap-sb-toggle-btn ${state.sidebarSection === 'pages' ? 'active' : ''}" data-section="pages">Pages (${a.pages ? a.pages.length : 0})</button>
              <button class="ap-sb-toggle-btn ${state.sidebarSection === 'tickets' ? 'active' : ''}" data-section="tickets">Tickets (${state.tickets.length})</button>
              <button class="ap-sb-toggle-btn ${state.sidebarSection === 'items' ? 'active' : ''}" data-section="items">Items${itemsCountBadge()}</button>
            </div>
            ${state.sidebarSection === 'items' ? renderItemsFilters() : ''}
            <div class="ap-pages-list">
              <div class="ap-page-item ${dashActive ? 'active' : ''}" data-dash="1">
                <span class="ap-page-item-dot" style="background:#0ea5e9"></span>
                <div class="ap-page-item-text">
                  <div class="ap-page-item-title">📊 Dashboard</div>
                  <div class="ap-page-item-meta">Overview &amp; all items</div>
                </div>
              </div>
              ${state.sidebarSection === 'pages'
                ? (pageList || '<div style="padding:8px 14px;font-size:12px;color:#94a3b8">No pages yet</div>')
                : state.sidebarSection === 'tickets'
                  ? renderTicketsSidebar()
                  : renderItemsSidebar()}
              ${state.sidebarSection === 'pages'
                ? '<div class="ap-add-page-btn" id="ap-add-page">+ Add page</div>'
                : state.sidebarSection === 'tickets'
                  ? '<div class="ap-add-page-btn" id="ap-add-ticket">+ New ticket</div>'
                  : ''}
            </div>
          </aside>
          <section class="ap-page-pane">
            ${state.pageView === 'dashboard' ? renderDashboardPane()
              : state.pageView === 'ticket' ? renderTicketPane()
              : renderPagePane()}
          </section>
        </div>
      </div>
    `;
    bindDetailEvents();
    bindTopbarEvents();
  }

  function assigneeRow(role, name) {
    return `
      <div class="ap-assignee-row">
        <span class="ap-assignee-role">${escapeHtml(role)}</span>
        <span class="ap-assignee-name${name ? '' : ' unassigned'}">${escapeHtml(name || 'Unassigned')}</span>
      </div>
    `;
  }

  function renderPagePane() {
    if (!state.selectedPageId) {
      return `
        <div style="flex:1;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:13px;padding:40px;text-align:center">
          ${(state.app.pages && state.app.pages.length === 0)
            ? '<div><p style="margin-bottom:10px">No pages yet.</p><p style="font-size:12px">Use <strong>+ Add page</strong> to drop in HTML from Claude.</p></div>'
            : 'Pick a page on the left to see its preview, blueprint, Q&A, and function checklist.'}
        </div>
      `;
    }
    const p = state.pageDetail;
    if (!p) {
      return '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:13px">Loading page…</div>';
    }
    const t = state.tab;
    return `
      <div class="ap-page-head">
        <input class="ap-page-title-input" id="ap-page-title" value="${escapeHtml(p.name)}" placeholder="Page name"/>
        <select class="ap-page-status-select" id="ap-page-status">
          ${['pending', 'in_review', 'working', 'broken', 'done'].map(s =>
            `<option value="${s}"${p.status === s ? ' selected' : ''}>${prettyStatus(s)}</option>`).join('')}
        </select>
        <button class="btn btn-danger btn-small" id="ap-page-delete" title="Delete page">Delete</button>
      </div>
      <div class="ap-tabs">
        <div class="ap-tab ${t === 'preview' ? 'active' : ''}" data-tab="preview">Preview ${state.annotations.length ? `<span class="ap-tab-count">${state.annotations.length}</span>` : ''}</div>
        <div class="ap-tab ${t === 'blueprint' ? 'active' : ''}" data-tab="blueprint">Blueprint</div>
        <div class="ap-tab ${t === 'qa' ? 'active' : ''}" data-tab="qa">Q&amp;A <span class="ap-tab-count">${state.comments.length}</span></div>
        <div class="ap-tab ${t === 'todos' ? 'active' : ''}" data-tab="todos">To-dos <span class="ap-tab-count">${state.todos.filter(x => !x.done).length}/${state.todos.length}</span></div>
        <div class="ap-tab ${t === 'functions' ? 'active' : ''}" data-tab="functions">Functions <span class="ap-tab-count">${state.functions.length}</span></div>
      </div>
      <div class="ap-tab-body">
        ${t === 'preview' ? renderPreviewTab(p) : ''}
        ${t === 'blueprint' ? renderBlueprintTab(p) : ''}
        ${t === 'qa' ? renderQATab() : ''}
        ${t === 'todos' ? renderTodosTab() : ''}
        ${t === 'functions' ? renderFunctionsTab() : ''}
      </div>
    `;
  }

  function prettyStatus(s) {
    switch (s) {
      case 'pending': return 'Pending';
      case 'in_review': return 'In review';
      case 'working': return 'Working';
      case 'broken': return 'Broken';
      case 'done': return 'Done';
      default: return s;
    }
  }

  function renderPreviewTab(p) {
    // ?ts= keeps the URL stable per HTML revision so the browser can
    // cache, see /preview headers. ?interactive=1 flips the server-side
    // CSP to allow scripts and pairs with the sandbox attr below.
    const cacheBust = p.updated_at || '';
    const previewUrl = '/api/apps/' + state.app.id + '/pages/' + p.id + '/preview?ts=' + encodeURIComponent(cacheBust) + (state.interactiveMode ? '&interactive=1' : '');
    // Sandbox: with interactiveMode on we add allow-scripts so inline
    // scripts and event handlers run. allow-same-origin is kept so the
    // page can call back to /api/* with the user's session — which is
    // typically what an in-house app needs to be testable. The combo
    // is intentionally opt-in; warn the user before flipping it on.
    const sandbox = state.interactiveMode
      ? 'allow-scripts allow-same-origin allow-forms allow-popups'
      : 'allow-same-origin';
    const pins = state.annotations.map((a, i) => {
      return `
        <div class="ap-pin ap-pin-${escapeHtml(a.type)} ${a.status === 'resolved' ? 'resolved' : ''}"
             style="left:${a.x_pct}%;top:${a.y_pct}%"
             data-act="open-pin" data-aid="${a.id}"
             title="${escapeHtml(a.text)}">
          ${i + 1}
        </div>
      `;
    }).join('');
    return `
      <div class="ap-preview-toolbar">
        <span>Sandboxed preview of <strong>${escapeHtml(p.file_name || p.name)}</strong>${p.html_size ? ` · ${(p.html_size / 1024).toFixed(1)} KB` : ''}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn ${state.interactiveMode ? 'btn-primary' : 'btn-secondary'} btn-small" id="ap-interactive-toggle" title="${state.interactiveMode ? 'Scripts and buttons are active. Click to disable.' : 'Run the page JavaScript so buttons and form handlers work. Only enable for pages you trust.'}">
            ${state.interactiveMode ? '▶ Interactive' : '⏸ Static'}
          </button>
          <button class="btn ${state.annotateMode ? 'btn-primary' : 'btn-secondary'} btn-small" id="ap-annotate-toggle" title="Click on the design to drop a pin">
            ${state.annotateMode ? '✓ Annotating' : 'Annotate'}
          </button>
          <button class="btn ${state.penMode ? 'btn-primary' : 'btn-secondary'} btn-small" id="ap-pen-toggle" title="Draw on the design. Save the markup as a snippet attached to a new pin. Also visible during screen recording.">
            ${state.penMode ? '✓ Pen' : '🖊 Pen'}
          </button>
          <a href="${previewUrl}" target="_blank" rel="noopener" class="btn btn-ghost btn-small">Open in new tab ↗</a>
        </div>
      </div>
      <div class="ap-preview-layout">
        <div class="ap-preview-wrap" id="ap-preview-wrap">
          <div class="ap-preview-loading" id="ap-preview-loading">
            <div class="ap-spinner"></div>
            <span>Loading design…</span>
          </div>
          <iframe class="ap-preview-frame" src="${previewUrl}" sandbox="${sandbox}" title="Page preview" onload="(function(f){var l=document.getElementById('ap-preview-loading');if(l)l.style.display='none';})(this)"></iframe>
          <div class="ap-pin-overlay ${state.annotateMode && !state.penMode ? 'active' : ''}" id="ap-pin-overlay">
            ${pins}
            ${state.pendingPin ? `<div class="ap-pin ap-pin-pending" style="left:${state.pendingPin.x_pct}%;top:${state.pendingPin.y_pct}%">+</div>` : ''}
          </div>
          ${state.penMode ? renderPenLayer() : ''}
          ${state.pendingPin ? renderNewPinPopup() : ''}
        </div>
        <aside class="ap-pins-panel">
          <div class="ap-pins-panel-head">
            Pins (${state.annotations.length})
            <span style="color:#94a3b8;font-weight:400;font-size:11px;margin-left:6px">Click "Annotate" then click the design</span>
          </div>
          <div class="ap-pins-list">
            ${state.annotations.length === 0
              ? '<div class="ap-qa-empty" style="padding:16px 8px">No pins yet. Toggle <strong>Annotate</strong> and click any spot on the design to drop a question, issue, or note.</div>'
              : state.annotations.map((a, i) => renderPinRow(a, i)).join('')}
          </div>
        </aside>
      </div>
    `;
  }

  function renderPinRow(a, i) {
    const atts = (a.attachments || []).map(att => renderAttachmentThumb(a.id, att, state.me && a.author_id === state.me.id)).join('');
    return `
      <div class="ap-pin-row ${a.status === 'resolved' ? 'resolved' : ''}" data-aid="${a.id}">
        <div class="ap-pin-row-head">
          <span class="ap-pin-dot ap-pin-${escapeHtml(a.type)}">${i + 1}</span>
          <span class="ap-pin-row-type">${escapeHtml(prettyAnnotationType(a.type))}</span>
          <span class="ap-pin-row-author">${escapeHtml(a.author_name || '')}</span>
          <span class="ap-pin-row-time">${escapeHtml(formatTime(a.created_at))}</span>
        </div>
        <div class="ap-pin-row-body">${escapeHtml(a.text)}</div>
        ${atts}
        <div class="ap-pin-row-actions">
          <span class="ap-comment-action-btn" data-act="add-att" data-aid="${a.id}">+ Attach</span>
          <span class="ap-comment-action-btn resolve-btn" data-act="toggle-pin-resolve" data-aid="${a.id}">${a.status === 'resolved' ? 'Reopen' : 'Resolve'}</span>
          ${(state.me && a.author_id === state.me.id) ? `<span class="ap-comment-action-btn" data-act="delete-pin" data-aid="${a.id}">Delete</span>` : ''}
        </div>
      </div>
    `;
  }

  function renderAttachmentThumb(annId, att, canDelete) {
    const m = att.mime_type || '';
    const isImg = m.startsWith('image/');
    const isAud = m.startsWith('audio/');
    const isVid = m.startsWith('video/');
    const inner = isImg ? `<a href="${escapeHtml(att.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name)}"/></a>`
      : isAud ? `<audio controls preload="metadata" src="${escapeHtml(att.url)}"></audio>`
      : isVid ? `<video controls preload="metadata" src="${escapeHtml(att.url)}" style="max-height:160px;width:100%"></video>`
      : `<a href="${escapeHtml(att.url)}" target="_blank" rel="noopener">📎 ${escapeHtml(att.name)}</a>`;
    return `
      <div class="ap-att-thumb">
        ${inner}
        ${canDelete ? `<div style="text-align:right;padding:2px 6px"><span class="ap-comment-action-btn" data-act="rm-att" data-aid="${annId}" data-att="${att.id}">Remove</span></div>` : ''}
      </div>
    `;
  }

  function prettyAnnotationType(t) {
    return ({ question: 'Question', issue: 'Issue', broken: 'Broken', note: 'Note' })[t] || t;
  }

  function renderPenLayer() {
    const colors = ['#ef4444', '#2563eb', '#16a34a', '#facc15', '#0f172a'];
    return `
      <canvas class="ap-pen-canvas" id="ap-pen-canvas"></canvas>
      <div class="ap-pen-controls">
        <span style="opacity:.7;font-size:11px">Pen</span>
        ${colors.map(c => `<span class="ap-pen-color ${c === state.penColor ? 'active' : ''}" data-pen-color="${c}" style="background:${c}"></span>`).join('')}
        <input type="range" id="ap-pen-width" min="1" max="20" value="${state.penWidth}" style="width:80px"/>
        <button id="ap-pen-clear">Clear</button>
        <button id="ap-pen-cancel">Cancel</button>
        <button class="primary" id="ap-pen-save">💾 Save snippet</button>
      </div>
    `;
  }

  function renderNewPinPopup() {
    const pp = state.pendingPin;
    // Position the popup near the pin — use percentages so it scales.
    const left = pp.x_pct > 60 ? 'right:5%' : `left:${Math.min(pp.x_pct + 3, 70)}%`;
    const top = `top:${Math.min(pp.y_pct + 2, 75)}%`;
    const audioRec = activeRecorders.audio;
    const screenRec = activeRecorders.screen;
    return `
      <div class="ap-pin-popup" style="${left};${top}">
        <div class="ap-pin-popup-head">New pin</div>
        <select id="ap-pin-type">
          <option value="question">❔ Question</option>
          <option value="issue">⚠️ Issue</option>
          <option value="broken">✗ Not working / broken</option>
          <option value="note">✎ Note</option>
        </select>
        <textarea id="ap-pin-text" placeholder="What's this? Describe — or paste an image directly here." rows="3"></textarea>
        <div class="ap-att-bar">
          <button class="ap-att-btn" data-att-act="file" title="Attach a file">📎 File</button>
          <button class="ap-att-btn" data-att-act="paste" title="Paste from clipboard (or just paste into the text box)">📋 Paste</button>
          <button class="ap-att-btn ${audioRec ? 'recording' : ''}" data-att-act="voice" title="Record a voice note">
            ${audioRec ? `⏹ Stop (${recDuration(audioRec)})` : '🎤 Voice'}
          </button>
          <button class="ap-att-btn ${screenRec ? 'recording' : ''}" data-att-act="screen" title="Record your screen">
            ${screenRec ? `⏹ Stop (${recDuration(screenRec)})` : '🎥 Screen'}
          </button>
        </div>
        <div class="ap-att-list" id="ap-att-list">
          ${state.pendingAttachments.map((a, i) => `
            <div class="ap-att-item">
              ${a.kind === 'image' ? `<img src="${a.previewUrl}" alt=""/>` : ''}
              ${a.kind === 'audio' ? `<span style="font-size:14px">🎤</span>` : ''}
              ${a.kind === 'video' ? `<span style="font-size:14px">🎥</span>` : ''}
              ${a.kind === 'file' ? `<span style="font-size:14px">📎</span>` : ''}
              <span class="ap-att-name">${escapeHtml(a.name)} · ${humanSize(a.blob.size)}</span>
              <span class="ap-att-del" data-att-rm="${i}">✕</span>
            </div>
          `).join('')}
        </div>
        <div class="ap-pin-popup-foot">
          <button class="btn btn-ghost btn-small" id="ap-pin-cancel">Cancel</button>
          <button class="btn btn-primary btn-small" id="ap-pin-save">Drop pin</button>
        </div>
        <input type="file" id="ap-pin-file" style="display:none"/>
      </div>
    `;
  }

  function humanSize(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Live timer for the recording label. Returns mm:ss since the recorder
  // started; called from the popup HTML on each refresh.
  function recDuration(rec) {
    if (!rec || !rec.startedAt) return '0:00';
    const s = Math.max(0, Math.floor((Date.now() - rec.startedAt) / 1000));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function renderBlueprintTab(p) {
    const isBn = state.blueprintLang === 'bn';
    const isEmpty = !(p.blueprint && p.blueprint.trim());
    const draftingHint = isEmpty
      ? '<div class="ap-blueprint-pending">AI is drafting a blueprint from the HTML… this usually takes 5–15 seconds after upload. <button class="btn btn-ghost btn-small" id="ap-blueprint-refresh">Refresh</button></div>'
      : '';
    const bnView = isBn
      ? (state.blueprintBn
        ? `<div class="ap-blueprint-readonly" lang="bn">${escapeHtml(state.blueprintBn).replace(/\n/g, '<br/>')}</div>`
        : '<div class="ap-blueprint-readonly ap-blueprint-loading">Translating to বাংলা…</div>')
      : '';
    return `
      <div class="ap-blueprint-wrap">
        <div class="ap-blueprint-label">
          <div>
            <h3>Page blueprint</h3>
            <p>Plain-English description for the developer: what the page does, the main sections, the interactions, and the data it needs.</p>
          </div>
          <div class="ap-lang-toggle">
            <button class="ap-lang-btn ${!isBn ? 'active' : ''}" data-lang="en">EN</button>
            <button class="ap-lang-btn ${isBn ? 'active' : ''}" data-lang="bn">বাংলা</button>
          </div>
        </div>
        ${draftingHint}
        ${isBn ? bnView : `<textarea class="ap-blueprint-textarea" id="ap-blueprint-textarea" placeholder="Describe what this page does, the regions, interactions, and data needs.">${escapeHtml(p.blueprint || '')}</textarea>`}
        <div class="ap-blueprint-actions">
          ${isBn
            ? `<span style="font-size:12px;color:#64748b">Switch to <strong>EN</strong> to edit. Bengali is auto-translated from your English source.</span>`
            : `<button class="btn btn-primary btn-small" id="ap-blueprint-save">Save</button>
               <button class="btn btn-secondary btn-small" id="ap-blueprint-ai">
                 <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>
                 ${isEmpty ? 'Generate with AI' : 'Re-generate with AI'}
               </button>
               <span class="ap-blueprint-saved" id="ap-blueprint-saved">Saved ✓</span>`}
        </div>
      </div>
    `;
  }

  function renderQATab() {
    const byParent = new Map();
    for (const c of state.comments) {
      const p = c.parent_id || 0;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(c);
    }
    function renderThread(parentId) {
      const list = byParent.get(parentId) || [];
      return list.map(c => `
        <div class="ap-comment ${c.resolved ? 'resolved' : ''}" data-cid="${c.id}">
          <div class="ap-comment-head">
            <span class="ap-comment-author">${escapeHtml(c.author_name || 'Unknown')}</span>
            <span class="ap-comment-time">${escapeHtml(formatTime(c.created_at))}</span>
            <div class="ap-comment-actions">
              <span class="ap-comment-action-btn resolve-btn" data-act="toggle-resolve" data-cid="${c.id}">${c.resolved ? 'Reopen' : 'Resolve'}</span>
              ${(state.me && c.author_id === state.me.id) ? `<span class="ap-comment-action-btn" data-act="delete" data-cid="${c.id}">Delete</span>` : ''}
              <span class="ap-comment-action-btn" data-act="reply" data-cid="${c.id}">Reply</span>
            </div>
          </div>
          <div class="ap-comment-body">${escapeHtml(c.text)}</div>
          <div class="ap-comment-replies">${renderThread(c.id)}</div>
        </div>
      `).join('');
    }
    const top = renderThread(0);
    return `
      <div class="ap-qa-wrap">
        ${top || '<div class="ap-qa-empty">No questions or comments yet. Start the thread below.</div>'}
        <div class="ap-qa-composer">
          <textarea id="ap-qa-input" placeholder="Ask a question or leave a note about this page…"></textarea>
          <div class="ap-qa-composer-actions">
            <button class="btn btn-primary btn-small" id="ap-qa-send">Post</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderFunctionsTab() {
    const total = state.functions.length;
    const working = state.functions.filter(f => f.status === 'working').length;
    const pct = total > 0 ? Math.round((working / total) * 100) : 0;
    const rows = state.functions.map(f => `
      <div class="ap-fn-row" data-fid="${f.id}">
        <div class="ap-fn-status-chip ${escapeHtml(f.status)}" data-act="cycle-status" data-fid="${f.id}" title="Click to cycle status">
          ${fnStatusIcon(f.status)} ${prettyFnStatus(f.status)}
        </div>
        <input class="ap-fn-title-input" data-act="edit-title" data-fid="${f.id}" value="${escapeHtml(f.title)}"/>
        <span class="ap-fn-delete" data-act="delete-fn" data-fid="${f.id}" title="Delete">✕</span>
      </div>
    `).join('');
    return `
      <div class="ap-fn-wrap">
        <div class="ap-fn-summary">
          <span><strong>${working}</strong> of <strong>${total}</strong> functions working</span>
          <div class="ap-fn-progress"><div class="ap-fn-progress-bar" style="width:${pct}%"></div></div>
          <span>${pct}%</span>
        </div>
        ${rows || '<div class="ap-qa-empty" style="padding:18px 0">No functions tracked yet. Add the first one below.</div>'}
        <div class="ap-fn-add-form">
          <input id="ap-fn-new-title" placeholder="New function (e.g. 'Login button calls /api/auth/login')"/>
          <button class="btn btn-primary btn-small" id="ap-fn-add">Add</button>
        </div>
      </div>
    `;
  }
  function prettyFnStatus(s) { return ({ pending: 'Pending', working: 'Working', broken: 'Broken', na: 'N/A' })[s] || s; }
  function fnStatusIcon(s) {
    return ({
      pending: '○',
      working: '✓',
      broken: '✗',
      na: '–',
    })[s] || '○';
  }

  function renderTodosTab() {
    const total = state.todos.length;
    const done = state.todos.filter(t => t.done).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const rows = state.todos.map(t => `
      <div class="ap-todo-row ${t.done ? 'done' : ''}" data-tid="${t.id}">
        <input type="checkbox" class="ap-todo-check" data-act="toggle-todo" data-tid="${t.id}" ${t.done ? 'checked' : ''}/>
        <div class="ap-todo-body">
          <div class="ap-todo-text">${escapeHtml(t.text)}</div>
          <div class="ap-todo-meta">
            ${t.created_by_name ? `by ${escapeHtml(t.created_by_name)}` : ''}
            ${t.done && t.done_by_name ? ` · done by ${escapeHtml(t.done_by_name)} ${escapeHtml(formatTime(t.done_at))}` : ''}
          </div>
        </div>
        <span class="ap-fn-delete" data-act="delete-todo" data-tid="${t.id}" title="Delete">✕</span>
      </div>
    `).join('');
    return `
      <div class="ap-fn-wrap">
        <div class="ap-fn-summary">
          <span><strong>${done}</strong> of <strong>${total}</strong> to-dos done</span>
          <div class="ap-fn-progress"><div class="ap-fn-progress-bar" style="width:${pct}%"></div></div>
          <span>${pct}%</span>
        </div>
        <div style="font-size:12px;color:#64748b;margin-bottom:10px">Manager adds the list; developer ticks each off as it's built.</div>
        ${rows || '<div class="ap-qa-empty" style="padding:18px 0">No to-dos yet. Add the first one below.</div>'}
        <div class="ap-fn-add-form">
          <input id="ap-todo-new-text" placeholder="New to-do (e.g. 'Wire login button to /api/auth/login')"/>
          <button class="btn btn-primary btn-small" id="ap-todo-add">Add</button>
        </div>
      </div>
    `;
  }

  // Small GitHub-sync chip shown on the dashboard head. Hidden when no
  // repo is configured. Click "Sync now" → manual pull. The last-sync
  // timestamp updates live whenever the user runs Sync.
  function renderGithubChip() {
    const a = state.app;
    if (!a || !a.repo_url) {
      return `
        <div class="ap-gh-chip ap-gh-chip-off">
          <span>🔗 No GitHub repo connected</span>
          <button class="btn btn-secondary btn-small" id="ap-gh-connect">Connect…</button>
        </div>
      `;
    }
    const last = a.repo_last_sync ? formatTime(a.repo_last_sync) : 'never';
    const statusOk = !a.repo_last_status || a.repo_last_status === 'ok' || a.repo_last_status.startsWith('ok ');
    return `
      <div class="ap-gh-chip ${statusOk ? '' : 'ap-gh-chip-err'}">
        <span title="${escapeHtml(a.repo_url)}">🔗 ${escapeHtml(parseRepoUrlForUi(a.repo_url))} @ ${escapeHtml(a.repo_branch || 'main')}</span>
        <span class="ap-gh-chip-meta">${a.repo_auto_sync ? 'auto-sync · ' : ''}last sync ${escapeHtml(last)}${statusOk ? '' : ' · ⚠ ' + escapeHtml(a.repo_last_status || '')}</span>
        <button class="btn btn-primary btn-small" id="ap-gh-sync">Sync now</button>
      </div>
    `;
  }
  function parseRepoUrlForUi(url) {
    const m = String(url || '').match(/github\.com[\/:]([^\/]+\/[^\/\.?#\s]+)/i);
    return m ? m[1] : url;
  }

  // Dashboard view — replaces the page detail pane when no page is
  // selected. Renders rolled-up stats, per-page progress, recent activity,
  // and a flat list of every comment / annotation / todo across the app.
  function renderDashboardPane() {
    if (!state.dashboard) {
      return '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:13px">Loading dashboard…</div>';
    }
    const d = state.dashboard;
    const t = d.totals || {};
    const stats = [
      { label: 'Pages',       value: t.pages || 0 },
      { label: 'Functions',   value: `${t.fn_working || 0}/${t.fn_total || 0}`, hint: 'working' },
      { label: 'To-dos',      value: `${t.todo_done || 0}/${t.todo_total || 0}`, hint: 'done' },
      { label: 'Q&A',         value: `${t.comments_open || 0}/${t.comments_total || 0}`, hint: 'open' },
      { label: 'Pins',        value: `${t.annotations_open || 0}/${t.annotations_total || 0}`, hint: 'open' },
    ];
    const statCards = stats.map(s => `
      <div class="ap-stat-card">
        <div class="ap-stat-value">${escapeHtml(String(s.value))}</div>
        <div class="ap-stat-label">${escapeHtml(s.label)}${s.hint ? ` <span class="ap-stat-hint">${escapeHtml(s.hint)}</span>` : ''}</div>
      </div>
    `).join('');
    const perPage = (d.per_page || []).map(p => {
      const fnPct = p.fn_total > 0 ? Math.round((p.fn_working / p.fn_total) * 100) : 0;
      const todoPct = p.todo_total > 0 ? Math.round((p.todo_done / p.todo_total) * 100) : 0;
      return `
        <div class="ap-perpage-row" data-page-id="${p.id}">
          <div class="ap-perpage-head">
            <span class="ap-page-item-dot ${escapeHtml(p.status || 'pending')}"></span>
            <strong>${escapeHtml(p.name)}</strong>
            <span class="ap-status-pill ap-status-${escapeHtml(p.status || 'pending')}" style="margin-left:8px;font-size:9.5px">${escapeHtml(p.status || 'pending')}</span>
            ${p.has_blueprint ? '<span class="ap-stat-hint" style="margin-left:6px">✓ blueprint</span>' : '<span class="ap-stat-hint" style="margin-left:6px;color:#f59e0b">blueprint pending</span>'}
          </div>
          <div class="ap-perpage-bars">
            <div class="ap-perpage-bar" title="Functions working / total">
              <span>FN ${p.fn_working || 0}/${p.fn_total || 0}</span>
              <div class="ap-perpage-track"><div class="ap-perpage-fill" style="width:${fnPct}%;background:#22c55e"></div></div>
            </div>
            <div class="ap-perpage-bar" title="To-dos done / total">
              <span>TD ${p.todo_done || 0}/${p.todo_total || 0}</span>
              <div class="ap-perpage-track"><div class="ap-perpage-fill" style="width:${todoPct}%;background:#2563eb"></div></div>
            </div>
            <div class="ap-perpage-bar"><span>Q&amp;A ${p.comments_open || 0}/${p.comments_total || 0}</span></div>
            <div class="ap-perpage-bar"><span>Pins ${p.annotations_open || 0}/${p.annotations_total || 0}</span></div>
          </div>
        </div>
      `;
    }).join('');
    const recent = (d.recent_activity || []).slice(0, 12).map(ev => {
      const icon = ev.kind === 'comment' ? '💬' : (ev.type === 'broken' ? '✗' : ev.type === 'issue' ? '⚠️' : '📍');
      return `
        <div class="ap-activity-row" data-page-id="${ev.page_id}">
          <span class="ap-activity-icon">${icon}</span>
          <div class="ap-activity-body">
            <div class="ap-activity-text"><strong>${escapeHtml(ev.author || '?')}</strong> on <em>${escapeHtml(ev.page_name || '?')}</em>: ${escapeHtml((ev.text || '').slice(0, 140))}</div>
            <div class="ap-activity-meta">${escapeHtml(ev.kind === 'comment' ? 'Q&A' : prettyAnnotationType(ev.type || 'note'))} · ${escapeHtml(formatTime(ev.at))}</div>
          </div>
        </div>
      `;
    }).join('');
    const allTab = state.dashAllTab;
    const allBody = allTab === 'comments'
      ? renderAllItems(d.all_comments, 'comment')
      : allTab === 'annotations'
        ? renderAllItems(d.all_annotations, 'annotation')
        : renderAllItems(d.all_todos, 'todo');
    return `
      <div class="ap-dash-head">
        <div style="flex:1;min-width:0">
          <h2>${escapeHtml(state.app.name)}</h2>
          <span style="color:#64748b;font-size:13px">${escapeHtml(state.app.description || 'No description')}</span>
        </div>
        ${renderGithubChip()}
      </div>
      <div class="ap-dash-body">
        <div class="ap-stat-grid">${statCards}</div>

        <div class="ap-section">
          <h3>Per-page progress</h3>
          ${perPage || '<div class="ap-qa-empty">No pages yet</div>'}
        </div>

        <div class="ap-section">
          <h3>Recent activity</h3>
          <div class="ap-activity-list">
            ${recent || '<div class="ap-qa-empty">No activity yet</div>'}
          </div>
        </div>

        <div class="ap-section">
          <div style="display:flex;justify-content:space-between;align-items:flex-end">
            <h3>All items under this app</h3>
            <div class="ap-source-tabs" style="margin-bottom:0">
              <div class="ap-source-tab ${allTab === 'comments' ? 'active' : ''}" data-all-tab="comments">Q&amp;A (${(d.all_comments || []).length})</div>
              <div class="ap-source-tab ${allTab === 'annotations' ? 'active' : ''}" data-all-tab="annotations">Pins (${(d.all_annotations || []).length})</div>
              <div class="ap-source-tab ${allTab === 'todos' ? 'active' : ''}" data-all-tab="todos">To-dos (${(d.all_todos || []).length})</div>
            </div>
          </div>
          ${allBody}
        </div>
      </div>
    `;
  }

  function renderAllItems(items, kind) {
    if (!items || items.length === 0) return '<div class="ap-qa-empty">Nothing here yet</div>';
    return `
      <div class="ap-all-list">
        ${items.map(it => `
          <div class="ap-all-row" data-page-id="${it.page_id}">
            <div class="ap-all-row-head">
              <span class="ap-all-row-page">${escapeHtml(it.page_name || '?')}</span>
              ${kind === 'annotation' ? `<span class="ap-all-row-type ap-pin-${escapeHtml(it.type)}">${escapeHtml(prettyAnnotationType(it.type))}</span>` : ''}
              ${kind === 'todo' ? `<span class="ap-all-row-type" style="background:${it.done ? '#dcfce7' : '#f1f5f9'};color:${it.done ? '#166534' : '#475569'}">${it.done ? 'Done' : 'Open'}</span>` : ''}
              ${kind === 'comment' ? `<span class="ap-all-row-type" style="background:${it.resolved ? '#dcfce7' : '#fee2e2'};color:${it.resolved ? '#166534' : '#991b1b'}">${it.resolved ? 'Resolved' : 'Open'}</span>` : ''}
              <span class="ap-all-row-author">${escapeHtml(it.author_name || '')}</span>
              <span class="ap-all-row-time">${escapeHtml(formatTime(it.created_at || it.at))}</span>
            </div>
            <div class="ap-all-row-body">${escapeHtml(it.text || '')}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // ── Tickets sidebar list ─────────────────────────────────────────────
  function renderTicketsSidebar() {
    if (state.tickets.length === 0) {
      return '<div style="padding:8px 14px;font-size:12px;color:#94a3b8">No tickets yet</div>';
    }
    return state.tickets.map(t => {
      const isActive = state.pageView === 'ticket' && t.id === state.selectedTicketId;
      const closed = (t.status === 'closed' || t.status === 'resolved');
      const dot = closed ? '#10b981' : (t.status === 'in_progress' ? '#f59e0b' : (t.status === 'review' ? '#8b5cf6' : '#64748b'));
      const prio = t.priority && t.priority !== 'normal'
        ? `<span class="ap-prio-pill ap-prio-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>` : '';
      return `
        <div class="ap-page-item ${isActive ? 'active' : ''} ${closed ? 'closed' : ''}" data-ticket-id="${t.id}">
          <span class="ap-page-item-dot" style="background:${dot}" title="${escapeHtml(t.status)}"></span>
          <div class="ap-page-item-text">
            <div class="ap-page-item-title">#${t.id} ${escapeHtml(t.title)}</div>
            <div class="ap-page-item-meta">
              ${escapeHtml(prettyTicketStatus(t.status))}${t.comment_count ? ` · 💬 ${t.comment_count}` : ''}${t.page_name ? ` · ${escapeHtml(t.page_name)}` : ''}
              ${prio}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function prettyTicketStatus(s) {
    return ({ open: 'Open', in_progress: 'In progress', review: 'In review', resolved: 'Resolved', closed: 'Closed' })[s] || s;
  }

  // ── Items sidebar (Q&A + pins + todos in one feed) ───────────────────
  function itemsCountBadge() {
    if (!state.dashboard) return '';
    const d = state.dashboard;
    const total = (d.all_comments || []).length + (d.all_annotations || []).length + (d.all_todos || []).length;
    return ' (' + total + ')';
  }

  function renderItemsFilters() {
    const f = state.itemsFilter;
    const chip = (key, label) => `<span class="ap-items-chip ${f === key ? 'active' : ''}" data-items-filter="${key}">${escapeHtml(label)}</span>`;
    return `
      <div class="ap-items-filters">
        ${chip('all', 'All')}
        ${chip('qa', 'Q&A')}
        ${chip('pins', 'Pins')}
        ${chip('todos', 'To-dos')}
      </div>
    `;
  }

  function renderItemsSidebar() {
    if (!state.dashboard) {
      return '<div style="padding:8px 14px;font-size:12px;color:#94a3b8">Loading items…</div>';
    }
    const d = state.dashboard;
    const f = state.itemsFilter;
    // Merge into one feed with a `kind` tag so the row renderer can pick
    // an icon and the right click-target tab.
    const items = [];
    if (f === 'all' || f === 'qa') {
      for (const c of (d.all_comments || [])) items.push({ kind: 'comment', tab: 'qa', ...c });
    }
    if (f === 'all' || f === 'pins') {
      for (const a of (d.all_annotations || [])) items.push({ kind: 'annotation', tab: 'preview', ...a });
    }
    if (f === 'all' || f === 'todos') {
      for (const t of (d.all_todos || [])) items.push({ kind: 'todo', tab: 'todos', ...t });
    }
    // Newest first; created_at is "YYYY-MM-DD HH:MM:SS" so lexical sort works.
    items.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (items.length === 0) {
      return '<div style="padding:8px 14px;font-size:12px;color:#94a3b8">No items yet</div>';
    }
    return items.map(it => {
      const icon = it.kind === 'comment' ? '💬'
        : it.kind === 'annotation' ? (it.type === 'broken' ? '✗' : it.type === 'issue' ? '⚠️' : it.type === 'note' ? '✎' : '❔')
        : (it.done ? '☑' : '☐');
      const closed = (it.kind === 'comment' && it.resolved)
        || (it.kind === 'annotation' && it.status === 'resolved')
        || (it.kind === 'todo' && it.done);
      const text = String(it.text || '').slice(0, 80);
      const author = it.author_name || it.created_by_name || '';
      return `
        <div class="ap-item-row ${closed ? 'closed' : ''}" data-item-page="${it.page_id}" data-item-tab="${it.tab}">
          <span class="ap-item-icon ap-item-${it.kind}">${icon}</span>
          <div class="ap-item-body">
            <div class="ap-item-text">${escapeHtml(text)}</div>
            <div class="ap-item-meta">
              <strong>${escapeHtml(it.page_name || '?')}</strong>
              ${author ? ' · ' + escapeHtml(author) : ''}
              · ${escapeHtml(formatTime(it.created_at))}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ── Ticket detail pane ────────────────────────────────────────────────
  function renderTicketPane() {
    const t = state.ticketDetail;
    if (!t) {
      return '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:13px">Loading ticket…</div>';
    }
    const closed = (t.status === 'closed' || t.status === 'resolved');
    const assigneeOpts = `<option value="">— Unassigned —</option>` +
      (state.team || []).map(u => `<option value="${u.id}"${u.id === t.assignee_id ? ' selected' : ''}>${escapeHtml(u.name)}</option>`).join('');
    const pageOpts = `<option value="">— No page —</option>` +
      ((state.app.pages || []).map(p => `<option value="${p.id}"${p.id === t.page_id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join(''));
    const commentRows = (t.comments || []).map(c => {
      if (c.kind === 'status') {
        return `<div class="ap-ticket-event"><span>${escapeHtml(c.author_name || 'System')}</span> · ${escapeHtml(c.text)} · ${escapeHtml(formatTime(c.created_at))}</div>`;
      }
      return `
        <div class="ap-comment" data-cid="${c.id}">
          <div class="ap-comment-head">
            <span class="ap-comment-author">${escapeHtml(c.author_name || 'Unknown')}</span>
            <span class="ap-comment-time">${escapeHtml(formatTime(c.created_at))}</span>
            <div class="ap-comment-actions">
              ${(state.me && c.author_id === state.me.id) ? `<span class="ap-comment-action-btn" data-act="del-tc" data-cid="${c.id}">Delete</span>` : ''}
            </div>
          </div>
          <div class="ap-comment-body">${escapeHtml(c.text)}</div>
        </div>
      `;
    }).join('');
    return `
      <div class="ap-page-head">
        <input class="ap-page-title-input" id="ap-ticket-title" value="${escapeHtml(t.title)}" placeholder="Ticket title"/>
        <select class="ap-page-status-select" id="ap-ticket-status">
          ${['open', 'in_progress', 'review', 'resolved', 'closed'].map(s =>
            `<option value="${s}"${t.status === s ? ' selected' : ''}>${prettyTicketStatus(s)}</option>`).join('')}
        </select>
        <select class="ap-page-status-select" id="ap-ticket-priority">
          ${['low', 'normal', 'high', 'urgent'].map(p =>
            `<option value="${p}"${t.priority === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        ${closed
          ? '<button class="btn btn-secondary btn-small" id="ap-ticket-reopen">Re-open</button>'
          : '<button class="btn btn-secondary btn-small" id="ap-ticket-close">Close ticket</button>'}
        <button class="btn btn-danger btn-small" id="ap-ticket-delete">Delete</button>
      </div>
      <div class="ap-tab-body">
        <div style="max-width:780px">
          <div class="ap-fn-summary" style="margin-bottom:14px">
            <span>
              <strong>#${t.id}</strong>
              · ${escapeHtml(prettyTicketStatus(t.status))}
              · by ${escapeHtml(t.created_by_name || '?')}
              · ${escapeHtml(formatTime(t.created_at))}
              ${t.closed_at ? ` · closed by ${escapeHtml(t.closed_by_name || '?')} ${escapeHtml(formatTime(t.closed_at))}` : ''}
            </span>
          </div>
          <div class="ap-field-row">
            <div class="ap-field"><label>Assignee</label><select id="ap-ticket-assignee">${assigneeOpts}</select></div>
            <div class="ap-field"><label>Linked page</label><select id="ap-ticket-page">${pageOpts}</select></div>
          </div>
          <div class="ap-field">
            <label>Description</label>
            <textarea id="ap-ticket-desc" rows="5" placeholder="Describe the issue, request, or note…">${escapeHtml(t.description || '')}</textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <button class="btn btn-primary btn-small" id="ap-ticket-save">Save changes</button>
            <span class="ap-blueprint-saved" id="ap-ticket-saved">Saved ✓</span>
          </div>

          <h3 style="margin:24px 0 12px;font-size:14px;color:#0f172a">Activity</h3>
          ${commentRows || '<div class="ap-qa-empty" style="padding:14px 0">No activity yet</div>'}

          <div class="ap-qa-composer">
            <textarea id="ap-ticket-comment-input" placeholder="Add a comment…"></textarea>
            <div class="ap-qa-composer-actions">
              <button class="btn btn-primary btn-small" id="ap-ticket-comment-send">Comment</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function formatTime(ts) {
    if (!ts) return '';
    // ts is "YYYY-MM-DD HH:MM:SS" UTC string from the server.
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return ts;
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString();
  }

  // ── Event wiring (detail view) ─────────────────────────────────────────
  function bindDetailEvents() {
    const editBtn = document.getElementById('ap-edit-app');
    if (editBtn) editBtn.onclick = () => openAppModal(state.app);
    const addBtn = document.getElementById('ap-add-page');
    if (addBtn) addBtn.onclick = () => openAddPageModal();
    const addTicketBtn = document.getElementById('ap-add-ticket');
    if (addTicketBtn) addTicketBtn.onclick = () => openTicketModal(null);

    // Sidebar section toggle (Pages | Tickets | Items).
    root.querySelectorAll('[data-section]').forEach(el => {
      el.onclick = () => {
        state.sidebarSection = el.getAttribute('data-section');
        // Lazy-load on demand the first time each section is opened.
        if (state.sidebarSection === 'tickets' && (state.tickets.length === 0 || !state.tickets._loaded)) {
          loadTickets();
        } else if (state.sidebarSection === 'items' && !state.dashboard) {
          loadDashboard();
        } else {
          render();
        }
      };
    });

    root.querySelectorAll('.ap-page-item').forEach(el => {
      el.onclick = () => {
        if (el.getAttribute('data-dash')) navigate('/' + state.app.id);
        else if (el.getAttribute('data-ticket-id')) navigate('/' + state.app.id + '/t/' + el.getAttribute('data-ticket-id'));
        else navigate('/' + state.app.id + '/p/' + el.getAttribute('data-page-id'));
      };
    });

    // Items section: filter chips + row clicks.
    root.querySelectorAll('[data-items-filter]').forEach(el => {
      el.onclick = () => {
        state.itemsFilter = el.getAttribute('data-items-filter');
        render();
      };
    });
    root.querySelectorAll('[data-item-page]').forEach(el => {
      el.onclick = () => {
        const pid = el.getAttribute('data-item-page');
        const tab = el.getAttribute('data-item-tab');
        if (tab) state.tab = tab;
        navigate('/' + state.app.id + '/p/' + pid);
      };
    });

    // Dashboard / ticket panes have their own event binders.
    if (state.pageView === 'dashboard') {
      bindDashboardEvents();
      return;
    }
    if (state.pageView === 'ticket') {
      bindTicketEvents();
      return;
    }

    // Page header
    const titleInput = document.getElementById('ap-page-title');
    if (titleInput) {
      titleInput.onblur = async () => {
        const v = titleInput.value.trim();
        if (!v || v === state.pageDetail.name) return;
        try {
          await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id, { name: v });
          state.pageDetail.name = v;
          const p = state.app.pages.find(x => x.id === state.pageDetail.id);
          if (p) p.name = v;
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    const statusSel = document.getElementById('ap-page-status');
    if (statusSel) {
      statusSel.onchange = async () => {
        try {
          await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id, { status: statusSel.value });
          state.pageDetail.status = statusSel.value;
          const p = state.app.pages.find(x => x.id === state.pageDetail.id);
          if (p) p.status = statusSel.value;
          toast('Status updated', 'ok');
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    const delBtn = document.getElementById('ap-page-delete');
    if (delBtn) {
      delBtn.onclick = async () => {
        if (!await uiConfirm('Delete this page? Comments and functions on it will be removed too.')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id);
          state.app.pages = state.app.pages.filter(p => p.id !== state.pageDetail.id);
          state.pageDetail = null;
          state.selectedPageId = null;
          const next = state.app.pages[0];
          if (next) navigate('/' + state.app.id + '/p/' + next.id);
          else navigate('/' + state.app.id);
        } catch (e) { toast(e.message, 'err'); }
      };
    }

    // Tabs
    root.querySelectorAll('.ap-tab').forEach(t => {
      t.onclick = () => {
        state.tab = t.getAttribute('data-tab');
        render();
      };
    });

    bindBlueprintEvents();
    bindQAEvents();
    bindFunctionsEvents();
    bindTodosEvents();
    bindPreviewEvents();
  }

  function bindDashboardEvents() {
    // Scope to the dashboard pane so we don't re-bind sidebar entries
    // (those use the same data-page-id attribute but were already bound
    // by the parent bindDetailEvents).
    const pane = root.querySelector('.ap-page-pane');
    if (!pane) return;
    pane.querySelectorAll('[data-page-id]').forEach(el => {
      el.onclick = () => {
        const pid = el.getAttribute('data-page-id');
        if (pid) navigate('/' + state.app.id + '/p/' + pid);
      };
    });
    pane.querySelectorAll('[data-all-tab]').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        state.dashAllTab = el.getAttribute('data-all-tab');
        render();
      };
    });
    // GitHub sync chip.
    const connectBtn = document.getElementById('ap-gh-connect');
    if (connectBtn) connectBtn.onclick = () => openAppModal(state.app);
    const syncBtn = document.getElementById('ap-gh-sync');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        syncBtn.disabled = true; syncBtn.textContent = 'Syncing…';
        try {
          const r = await api('POST', '/api/apps/' + state.app.id + '/github/sync');
          const a = r.assets || {};
          const assetSummary = (a.added || a.updated || a.removed)
            ? ` · assets: +${a.added || 0}/${a.updated || 0} updated`
            : '';
          toast(
            `Pages: +${r.added || 0} added, ${r.updated || 0} updated, ${r.unchanged || 0} unchanged${r.removed ? ', ' + r.removed + ' removed' : ''}${assetSummary}`,
            'ok'
          );
          // Reload app + dashboard so the new pages + last_sync timestamp appear.
          const fresh = await api('GET', '/api/apps/' + state.app.id);
          state.app = fresh;
          await loadDashboard();
        } catch (e) {
          toast('Sync failed: ' + e.message, 'err');
          syncBtn.disabled = false;
          syncBtn.textContent = 'Sync now';
        }
      };
    }
  }

  // Targeted refresh: only updates the overlay + side panel + popup so the
  // iframe element is preserved across annotation state changes. Calling
  // render() instead would replace root.innerHTML and force the iframe to
  // re-fetch — losing the user's scroll position inside the design.
  function refreshAnnotationOverlay() {
    if (state.pageView !== 'page' || state.tab !== 'preview' || !state.pageDetail) return;
    const overlay = document.getElementById('ap-pin-overlay');
    const panel = root.querySelector('.ap-pins-list');
    const wrap = document.getElementById('ap-preview-wrap');
    if (!overlay || !panel || !wrap) { render(); return; }
    // Toggle overlay active state without re-fetching the iframe.
    overlay.classList.toggle('active', !!state.annotateMode && !state.penMode);
    const toggleBtn = document.getElementById('ap-annotate-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = state.annotateMode ? '✓ Annotating' : 'Annotate';
      toggleBtn.classList.toggle('btn-primary', !!state.annotateMode);
      toggleBtn.classList.toggle('btn-secondary', !state.annotateMode);
    }
    // Rebuild the pin markers from current state.
    const pinsHtml = state.annotations.map((a, i) => `
      <div class="ap-pin ap-pin-${escapeHtml(a.type)} ${a.status === 'resolved' ? 'resolved' : ''}"
           style="left:${a.x_pct}%;top:${a.y_pct}%"
           data-act="open-pin" data-aid="${a.id}"
           title="${escapeHtml(a.text)}">${i + 1}</div>
    `).join('') + (state.pendingPin ? `<div class="ap-pin ap-pin-pending" style="left:${state.pendingPin.x_pct}%;top:${state.pendingPin.y_pct}%">+</div>` : '');
    overlay.innerHTML = pinsHtml;
    // Side panel.
    panel.innerHTML = state.annotations.length === 0
      ? '<div class="ap-qa-empty" style="padding:16px 8px">No pins yet. Toggle <strong>Annotate</strong> and click any spot on the design to drop a question, issue, or note.</div>'
      : state.annotations.map((a, i) => renderPinRow(a, i)).join('');
    // Replace any existing pin popup (or remove it).
    const oldPopup = wrap.querySelector('.ap-pin-popup');
    if (oldPopup) oldPopup.remove();
    if (state.pendingPin) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderNewPinPopup();
      wrap.appendChild(wrapper.firstElementChild);
    }
    // Update the Preview tab count badge.
    const previewTab = root.querySelector('.ap-tab[data-tab="preview"]');
    if (previewTab) {
      previewTab.innerHTML = 'Preview ' + (state.annotations.length ? `<span class="ap-tab-count">${state.annotations.length}</span>` : '');
    }
    // Re-bind handlers since the DOM nodes were replaced.
    bindPreviewEvents();
  }

  // Pen-mode wiring.
  //
  // Approach: when pen mode activates we use html2canvas to snapshot the
  // current iframe content into an HTMLCanvasElement (state.penBgImage).
  // That snapshot is drawn as the bottom layer of the pen canvas; strokes
  // accumulate on top. The final canvas can be exported via toBlob with
  // no taint issues — html2canvas renders directly to canvas without
  // going through SVG/foreignObject, which is what caused the previous
  // version to silently fail on export.
  //
  // If html2canvas isn't available, or snapshotting fails (cross-origin
  // assets in the design, unusual CSS, etc.), we toast a warning and the
  // user draws on a transparent canvas as the fallback.
  function bindPenEvents() {
    const canvas = document.getElementById('ap-pen-canvas');
    if (!canvas) return;
    const wrap = document.getElementById('ap-preview-wrap');
    // Size the canvas to the wrap, accounting for devicePixelRatio so
    // strokes render crisp at native pixel density.
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    function redraw() {
      ctx.clearRect(0, 0, w, h);
      // White base — covers the iframe behind so cancel/redraw doesn't
      // briefly show a transparent flash through to the live design.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      // Background snapshot (if we have it) sits below the strokes.
      if (state.penBgImage) {
        try { ctx.drawImage(state.penBgImage, 0, 0, w, h); } catch {}
      }
      for (const stroke of state.penStrokes) {
        if (!stroke.points || stroke.points.length === 0) continue;
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }
    }
    redraw();

    // Kick off (or skip) the design snapshot. Async — strokes work
    // immediately on the transparent canvas; the bg fills in when ready.
    if (!state.penBgImage && !state.penSnapshotInflight) {
      capturePenBackground(redraw);
    }

    let active = null;
    const point = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      active = { color: state.penColor, width: state.penWidth, points: [point(e)] };
      state.penStrokes.push(active);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!active) return;
      const p = point(e);
      active.points.push(p);
      // Draw the new segment incrementally so the line keeps up with the
      // pointer without a full redraw each frame.
      ctx.strokeStyle = active.color;
      ctx.lineWidth = active.width;
      const prev = active.points[active.points.length - 2];
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    const endStroke = () => { active = null; };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);
    canvas.addEventListener('pointerleave', () => { /* allow drag back in */ });

    // Toolbar controls.
    root.querySelectorAll('[data-pen-color]').forEach(el => {
      el.onclick = () => {
        state.penColor = el.getAttribute('data-pen-color');
        root.querySelectorAll('[data-pen-color]').forEach(x => x.classList.toggle('active', x === el));
      };
    });
    const widthEl = document.getElementById('ap-pen-width');
    if (widthEl) widthEl.oninput = () => { state.penWidth = Number(widthEl.value) || 3; };
    const clearBtn = document.getElementById('ap-pen-clear');
    if (clearBtn) clearBtn.onclick = () => { state.penStrokes = []; redraw(); };
    const cancelBtn = document.getElementById('ap-pen-cancel');
    if (cancelBtn) cancelBtn.onclick = () => {
      state.penMode = false;
      state.penStrokes = [];
      render();
    };
    const saveBtn = document.getElementById('ap-pen-save');
    if (saveBtn) saveBtn.onclick = () => savePenSnippet(canvas, w, h);
  }

  // Resolve once the iframe is fully loaded and has at least one body
  // child — or reject after a generous timeout. Handles three cases:
  //   * iframe already loaded with content (resolves immediately)
  //   * iframe still loading (waits for the `load` event)
  //   * 404'ing subresources delaying `load` (polls readyState as a
  //     fallback so we don't sit forever)
  async function waitForIframeReady(iframe) {
    const isReady = () => {
      try {
        const d = iframe.contentDocument;
        return !!(d && d.readyState === 'complete' && d.body && d.body.children.length > 0);
      } catch { return false; }
    };
    if (isReady()) return;
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearInterval(poll); clearTimeout(timer); iframe.removeEventListener('load', finish); resolve(); } };
      const fail = (msg) => { if (!done) { done = true; clearInterval(poll); clearTimeout(timer); iframe.removeEventListener('load', finish); reject(new Error(msg)); } };
      iframe.addEventListener('load', finish, { once: true });
      // Poll as a safety net — `load` can be delayed by failing
      // subresource fetches, and on a re-rendered iframe the load
      // event may have already fired by the time we attach.
      const poll = setInterval(() => { if (isReady()) finish(); }, 100);
      const timer = setTimeout(() => fail('iframe load timed out (10s)'), 10000);
    });
    // One extra tick after the document reports "complete" so any
    // post-load layout / font rendering settles before html2canvas
    // walks the DOM.
    await new Promise(r => setTimeout(r, 120));
  }

  // Snapshot the iframe contents into state.penBgImage using html2canvas.
  // Runs in the background after pen mode activates so the user can
  // start drawing immediately on a transparent canvas — the bg fills in
  // when ready. We swap a status pill into the pen toolbar so it's
  // obvious whether the capture worked or fell back to strokes-only.
  async function capturePenBackground(redrawFn) {
    state.penSnapshotInflight = true;
    const ctrls = root.querySelector('.ap-pen-controls');
    const setStatus = (text, color) => {
      if (!ctrls) return;
      let el = ctrls.querySelector('.ap-pen-status');
      if (!el) {
        el = document.createElement('span');
        el.className = 'ap-pen-status';
        el.style.cssText = 'font-size:11px;margin-right:4px';
        ctrls.insertBefore(el, ctrls.firstChild);
      }
      el.style.color = color;
      el.textContent = text;
    };
    setStatus('⏳ Capturing…', '#fde68a');

    try {
      const iframe = root.querySelector('.ap-preview-frame');
      if (!iframe) throw new Error('Preview iframe not found');
      if (!window.html2canvas) throw new Error('html2canvas not loaded — check /vendor/html2canvas.min.js');

      // Toggling pen mode re-renders the preview pane, which destroys
      // and recreates the iframe — meaning the iframe is freshly
      // loading when we get here and its body is empty. Wait for the
      // load event (or until the body actually has content) before
      // letting html2canvas walk it. Without this guard, captures
      // come back as a blank canvas because the design hasn't
      // populated yet.
      await waitForIframeReady(iframe);

      const doc = iframe.contentDocument;
      if (!doc || !doc.body) throw new Error('Cannot access iframe content');

      console.log('[apps] capturing iframe',
        iframe.clientWidth + 'x' + iframe.clientHeight,
        'body has', doc.body.children.length, 'children');

      // Pass the full <html> element rather than just the body. With the
      // body alone html2canvas drops any styling that's attached at the
      // <html>/<head> level and the capture can come out blank — most
      // visibly when a Claude-designed page uses a single <style> block
      // in the head.
      const target = doc.documentElement || doc.body;
      const captured = await window.html2canvas(target, {
        backgroundColor: '#ffffff',
        useCORS: true,
        allowTaint: false,
        scale: window.devicePixelRatio || 1,
        width: iframe.clientWidth,
        height: iframe.clientHeight,
        windowWidth: iframe.clientWidth,
        windowHeight: iframe.clientHeight,
        logging: false,
        // Force the painter renderer — foreignObject rendering would
        // re-introduce the SVG taint we just got rid of.
        foreignObjectRendering: false,
        // Skip <script> and <iframe> elements in the clone. Scripts
        // can't run in the offscreen context anyway, and nested iframes
        // would need their own clone pipeline.
        ignoreElements: (el) => el.tagName === 'SCRIPT' || el.tagName === 'IFRAME',
      });

      // Sanity check: if html2canvas returned a canvas with 0 size or all
      // transparent pixels, treat that as a soft failure so the user
      // sees a clear status rather than an invisible "success".
      if (!captured || !captured.width || !captured.height) {
        throw new Error('html2canvas produced an empty canvas');
      }
      // Cheap check for "all transparent / all white" — sample 9 points
      // across the canvas. If none have a coloured pixel, the capture
      // probably didn't render the design (e.g. external stylesheet
      // didn't load in the clone).
      try {
        const ctx2 = captured.getContext('2d');
        const samples = [
          [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
          [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
          [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
        ];
        let coloured = 0;
        for (const [sx, sy] of samples) {
          const px = ctx2.getImageData(Math.floor(captured.width * sx), Math.floor(captured.height * sy), 1, 1).data;
          // Anything not white (255,255,255) or transparent counts.
          if (px[3] > 0 && !(px[0] > 245 && px[1] > 245 && px[2] > 245)) coloured++;
        }
        console.log('[apps] capture sample: ' + coloured + '/9 coloured points,', captured.width + 'x' + captured.height);
        if (coloured === 0) {
          // Still set the bg (white with whatever was captured), but warn.
          state.penBgImage = captured;
          if (typeof redrawFn === 'function') redrawFn();
          setStatus('⚠ Design captured blank — check console', '#fca5a5');
          return;
        }
      } catch (samplingErr) {
        // getImageData can fail if the canvas is somehow tainted — fall
        // through and trust the captured canvas anyway.
        console.warn('[apps] sample check failed:', samplingErr && samplingErr.message);
      }

      state.penBgImage = captured;
      if (typeof redrawFn === 'function') redrawFn();
      setStatus('✓ Design captured', '#86efac');
    } catch (e) {
      console.warn('[apps] pen background snapshot failed:', e && e.message);
      toast('Could not capture the design — drawing on transparent overlay', 'err');
      setStatus('⚠ Capture failed: ' + (e && e.message || 'unknown'), '#fca5a5');
    } finally {
      state.penSnapshotInflight = false;
    }
  }

  // The pen canvas already has the bg snapshot + strokes baked in — no
  // post-compositing needed. We just toBlob and queue the result as a
  // new-pin attachment. The button always resets on failure so it can't
  // get stuck.
  async function savePenSnippet(canvas, displayW, displayH) {
    if (state.penStrokes.length === 0) { toast('Draw something first', 'err'); return; }
    const saveBtn = document.getElementById('ap-pen-save');
    const setBtnState = (text, disabled) => {
      if (saveBtn) { saveBtn.disabled = disabled; saveBtn.textContent = text; }
    };
    setBtnState('Saving…', true);

    try {
      const blob = await canvasToBlob(canvas);
      // Centroid of strokes → pin position (% of on-screen canvas).
      let sx = 0, sy = 0, n = 0;
      for (const stroke of state.penStrokes) {
        for (const p of stroke.points) { sx += p.x; sy += p.y; n++; }
      }
      const cx = n > 0 ? (sx / n) / displayW * 100 : 50;
      const cy = n > 0 ? (sy / n) / displayH * 100 : 50;

      const file = new File([blob], 'snippet-' + Date.now() + '.png', { type: 'image/png' });
      state.pendingPin = { x_pct: cx, y_pct: cy };
      state.pendingAttachments.push({
        name: file.name, blob: file, mime: 'image/png', kind: 'image',
        previewUrl: URL.createObjectURL(file),
      });
      state.penMode = false;
      state.penStrokes = [];
      state.penBgImage = null;
      // render() replaces the pen controls with the new-pin popup —
      // no need to manually reset the button text on this success path.
      render();
    } catch (e) {
      console.warn('[apps] snippet save error:', e);
      toast('Snippet save failed: ' + (e && e.message || 'unknown'), 'err');
      setBtnState('💾 Save snippet', false);
    }
  }

  // Promise wrapper around canvas.toBlob. Rejects when the underlying
  // call returns null (typically a tainted canvas) so the caller can
  // fall back to a different source instead of hanging.
  function canvasToBlob(canvas, type) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('Canvas export blocked (tainted by cross-origin content)'));
        }, type || 'image/png');
      } catch (e) { reject(e); }
    });
  }

  // Capture the iframe's current rendered content into a canvas.
  //
  // Implementation: serialise the iframe's <html> into an SVG
  // foreignObject, load it via an <img> (which forces the browser to
  // rasterise the HTML/CSS), then drawImage onto a 2D canvas at
  // devicePixelRatio resolution.
  //
  // Limitations worth being explicit about:
  //   * cross-origin images / fonts won't load inside the SVG snapshot —
  //     the page renders without them
  //   * a handful of CSS features (filter-backdrop, some pseudo-elements)
  //     render imperfectly
  //   * Safari historically has more foreignObject quirks than Chromium
  //
  // For typical Claude-designed pages (self-contained, inline <style>,
  // inline SVG icons) it produces a faithful screenshot with no external
  // dependency. Failures bubble up so savePenSnippet can fall back to
  // strokes-only.
  async function snapshotIframe(iframe) {
    const doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) throw new Error('Cannot access iframe content');
    const w = iframe.clientWidth;
    const h = iframe.clientHeight;
    if (!w || !h) throw new Error('Iframe has no size');

    // Match what the user sees on screen — including scroll position,
    // not just the top of the page.
    const win = iframe.contentWindow;
    const scrollY = (win && win.scrollY) || doc.documentElement.scrollTop || 0;
    const scrollX = (win && win.scrollX) || doc.documentElement.scrollLeft || 0;

    // We inject a small style override that translates <body> by the
    // negative scroll offset and clips overflow, so the SVG's fixed
    // viewport (w × h) shows the same region as the visible iframe.
    // Cloning lets us mutate without disturbing the live document.
    const root = doc.documentElement.cloneNode(true);
    // Scripts don't run inside the SVG snapshot anyway (data/blob URL
    // context). Strip them up-front: arbitrary JS contents are a common
    // source of XML-serialisation failures, since unescaped <, >, & in
    // script bodies turn into malformed markup.
    root.querySelectorAll('script').forEach(s => s.remove());
    let head = root.querySelector('head');
    if (!head) { head = doc.createElement('head'); root.insertBefore(head, root.firstChild); }
    const styleEl = doc.createElement('style');
    styleEl.textContent =
      `html{background:#fff;overflow:hidden;width:${w}px;height:${h}px}` +
      `body{margin:0;transform:translate(${-scrollX}px,${-scrollY}px);transform-origin:0 0}`;
    head.appendChild(styleEl);

    // Serialise. XMLSerializer outputs XHTML-compatible markup (self-
    // closing tags, properly escaped attributes) so the SVG parser
    // accepts it inside foreignObject.
    let xml = new XMLSerializer().serializeToString(root);
    // Belt-and-braces: ensure the xhtml namespace is on <html>. Without
    // it, the foreignObject treats the contents as the SVG namespace
    // and nothing renders.
    if (!/xmlns=["']http:\/\/www\.w3\.org\/1999\/xhtml["']/.test(xml)) {
      xml = xml.replace(/^<html\b/i, '<html xmlns="http://www.w3.org/1999/xhtml"');
    }

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
        `<foreignObject width="100%" height="100%">` +
          xml +
        `</foreignObject>` +
      `</svg>`;

    // Blob URL — survives the size limits some browsers impose on
    // percent-encoded data: URLs for large pages.
    const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('SVG snapshot failed to render'));
        img.src = blobUrl;
        // Belt-and-braces timeout — if the browser silently stalls
        // (typically because of a cross-origin font load), don't hang
        // the UI forever.
        setTimeout(() => reject(new Error('SVG snapshot timed out')), 8000);
      });

      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // Preview tab — annotation overlay, pin clicks, new-pin popup.
  function bindPreviewEvents() {
    const interactiveBtn = document.getElementById('ap-interactive-toggle');
    if (interactiveBtn) {
      interactiveBtn.onclick = () => {
        // Confirm before flipping ON — running unknown scripts in the
        // preview iframe gives them access to the user's session
        // cookie (because the iframe is served from the same origin).
        // First-time confirm only, gated by sessionStorage so it isn't
        // spammed every toggle.
        if (!state.interactiveMode) {
          const acked = (function(){ try { return sessionStorage.getItem('ap-interactive-ack') === '1'; } catch { return false; } })();
          if (!acked) {
            const ok = confirm(
              'Interactive mode runs the design\'s JavaScript and lets it call back to /api/...\n\n' +
              'Only enable this for designs you trust (your own apps, vetted templates). A malicious page could read or modify your data.\n\n' +
              'Enable interactive mode?'
            );
            if (!ok) return;
            try { sessionStorage.setItem('ap-interactive-ack', '1'); } catch {}
          }
        }
        state.interactiveMode = !state.interactiveMode;
        // Drop annotate/pen overlays — they only make sense in static
        // preview mode (the iframe is interactive now, so clicks should
        // go to it, not to our annotation layer).
        if (state.interactiveMode) {
          state.annotateMode = false;
          state.penMode = false;
          state.pendingPin = null;
        }
        render();
      };
    }
    const toggleBtn = document.getElementById('ap-annotate-toggle');
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        state.annotateMode = !state.annotateMode;
        state.pendingPin = null;
        // Pen + Annotate are mutually exclusive — enabling one clears the other.
        if (state.annotateMode) state.penMode = false;
        refreshAnnotationOverlay();
      };
    }
    const penToggle = document.getElementById('ap-pen-toggle');
    if (penToggle) {
      penToggle.onclick = () => {
        state.penMode = !state.penMode;
        if (state.penMode) {
          state.annotateMode = false;
          state.pendingPin = null;
          state.penStrokes = [];
          // Force a fresh snapshot — the user may have scrolled the
          // design since the last activation.
          state.penBgImage = null;
        }
        render();
      };
    }
    if (state.penMode) bindPenEvents();
    const overlay = document.getElementById('ap-pin-overlay');
    if (overlay) {
      // Click anywhere on the overlay (when annotate mode is on) to drop a
      // pin. Clicks on existing pins are handled separately below via
      // data-act; we stop propagation there so this generic handler
      // doesn't fire too.
      overlay.onclick = (e) => {
        if (!state.annotateMode) return;
        if (e.target !== overlay) return; // pin clicks bubble up; we'd already handle them
        const rect = overlay.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        state.pendingPin = { x_pct: x, y_pct: y };
        refreshAnnotationOverlay();
      };
    }
    root.querySelectorAll('[data-act="open-pin"]').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const aid = Number(el.getAttribute('data-aid'));
        // Scroll the matching row into view in the side panel.
        const row = root.querySelector('.ap-pin-row[data-aid="' + aid + '"]');
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('highlight');
          setTimeout(() => row.classList.remove('highlight'), 1400);
        }
      };
    });
    root.querySelectorAll('[data-act="toggle-pin-resolve"]').forEach(el => {
      el.onclick = async () => {
        const aid = Number(el.getAttribute('data-aid'));
        const a = state.annotations.find(x => x.id === aid);
        if (!a) return;
        try {
          const r = await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/annotations/' + aid, { status: a.status === 'resolved' ? 'open' : 'resolved' });
          Object.assign(a, r);
          refreshAnnotationOverlay();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    root.querySelectorAll('[data-act="delete-pin"]').forEach(el => {
      el.onclick = async () => {
        const aid = Number(el.getAttribute('data-aid'));
        if (!await uiConfirm('Delete this pin?')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/annotations/' + aid);
          state.annotations = state.annotations.filter(x => x.id !== aid);
          refreshAnnotationOverlay();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    // Attach a file/voice/video to an existing pin via a small floating
    // file picker — keeps the per-row UI tight.
    root.querySelectorAll('[data-act="add-att"]').forEach(el => {
      el.onclick = () => {
        const aid = Number(el.getAttribute('data-aid'));
        openAttachMenu(el, aid);
      };
    });
    root.querySelectorAll('[data-act="rm-att"]').forEach(el => {
      el.onclick = async () => {
        const aid = Number(el.getAttribute('data-aid'));
        const att = Number(el.getAttribute('data-att'));
        if (!await uiConfirm('Remove this attachment?')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/annotations/' + aid + '/attachments/' + att);
          const ann = state.annotations.find(x => x.id === aid);
          if (ann) ann.attachments = (ann.attachments || []).filter(x => x.id !== att);
          refreshAnnotationOverlay();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    // New-pin popup
    const cancelBtn = document.getElementById('ap-pin-cancel');
    const saveBtn = document.getElementById('ap-pin-save');
    if (cancelBtn) {
      cancelBtn.onclick = () => { state.pendingPin = null; refreshAnnotationOverlay(); };
    }
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const type = document.getElementById('ap-pin-type').value;
        const text = document.getElementById('ap-pin-text').value.trim();
        if (!text && state.pendingAttachments.length === 0) {
          toast('Describe the pin or attach something', 'err');
          return;
        }
        saveBtn.disabled = true;
        try {
          const created = await api('POST', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/annotations', {
            x_pct: state.pendingPin.x_pct,
            y_pct: state.pendingPin.y_pct,
            type, text: text || '(see attached)',
          });
          // Upload each queued attachment in series — small count, simpler
          // than juggling parallel uploads + error aggregation.
          for (const a of state.pendingAttachments) {
            try {
              const att = await uploadAttachment(created.id, a);
              created.attachments = (created.attachments || []).concat([att]);
            } catch (err) {
              toast('Attachment "' + a.name + '" failed: ' + err.message, 'err');
            }
          }
          state.annotations.push(created);
          state.pendingPin = null;
          state.pendingAttachments = [];
          refreshAnnotationOverlay();
        } catch (e) { toast(e.message, 'err'); }
        saveBtn.disabled = false;
      };
    }

    // Attachment buttons inside the new-pin popup.
    const popup = root.querySelector('.ap-pin-popup');
    if (popup) {
      // File picker (hidden input).
      popup.querySelector('#ap-pin-file').onchange = (e) => {
        const f = (e.target.files || [])[0];
        if (f) queuePendingAttachment(f, kindForMime(f.type));
        e.target.value = '';
      };
      // Paste image directly into the textarea (or anywhere on the popup).
      const textArea = popup.querySelector('#ap-pin-text');
      const handlePaste = (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        for (const it of items) {
          if (it.kind === 'file' && it.type.startsWith('image/')) {
            e.preventDefault();
            const blob = it.getAsFile();
            const ext = blob.type.split('/')[1] || 'png';
            const file = new File([blob], 'pasted-' + Date.now() + '.' + ext, { type: blob.type });
            queuePendingAttachment(file, 'image');
            return;
          }
        }
      };
      if (textArea) textArea.addEventListener('paste', handlePaste);
      popup.addEventListener('paste', handlePaste);

      popup.querySelectorAll('[data-att-act]').forEach(btn => {
        btn.onclick = async () => {
          const act = btn.getAttribute('data-att-act');
          if (act === 'file') popup.querySelector('#ap-pin-file').click();
          else if (act === 'paste') toast('Paste an image with ⌘V / Ctrl+V into the text box', 'ok');
          else if (act === 'voice') toggleRecording('audio');
          else if (act === 'screen') toggleRecording('screen');
        };
      });
      popup.querySelectorAll('[data-att-rm]').forEach(btn => {
        btn.onclick = () => {
          const i = Number(btn.getAttribute('data-att-rm'));
          const a = state.pendingAttachments[i];
          if (a && a.previewUrl) URL.revokeObjectURL(a.previewUrl);
          state.pendingAttachments.splice(i, 1);
          refreshAnnotationOverlay();
        };
      });
    }
  }

  // ── Recording lifecycle ────────────────────────────────────────────────
  // Voice & screen recordings share the same flow: getUserMedia (or
  // getDisplayMedia) → MediaRecorder → on stop, concat the chunks into a
  // Blob and push it onto the pending-attachments list. A 1Hz ticker
  // keeps the running timer label in sync.
  async function toggleRecording(kind) {
    const existing = activeRecorders[kind];
    if (existing) {
      try { existing.recorder.stop(); } catch {}
      return;
    }
    try {
      let stream, mime;
      if (kind === 'audio') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mime = pickMimeType(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']);
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 24 },
          audio: true,
        });
        mime = pickMimeType(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
      }
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || (kind === 'audio' ? 'audio/webm' : 'video/webm') });
        // getDisplayMedia leaves the share indicator running until we
        // explicitly stop every track on the stream.
        try { stream.getTracks().forEach(tr => tr.stop()); } catch {}
        activeRecorders[kind] = null;
        if (recTimer) { clearInterval(recTimer); recTimer = null; }
        const ext = (recorder.mimeType || '').includes('mp4') ? (kind === 'audio' ? 'm4a' : 'mp4') : 'webm';
        const file = new File([blob], (kind === 'audio' ? 'voice-' : 'screen-') + Date.now() + '.' + ext, { type: recorder.mimeType || blob.type });
        queuePendingAttachment(file, kind === 'audio' ? 'audio' : 'video');
      };
      // If the user clicks the browser's "Stop sharing" button (screen
      // capture) rather than ours, the video track ends — mirror that to
      // a clean recorder.stop().
      stream.getTracks().forEach(tr => {
        tr.addEventListener('ended', () => { try { recorder.stop(); } catch {} });
      });
      recorder.start();
      activeRecorders[kind] = { recorder, stream, chunks, startedAt: Date.now() };
      // Refresh the popup every second so the running timer updates.
      if (recTimer) clearInterval(recTimer);
      recTimer = setInterval(() => {
        if (!activeRecorders.audio && !activeRecorders.screen) {
          clearInterval(recTimer); recTimer = null; return;
        }
        // Only update the buttons' labels, not the whole DOM.
        const popup = root.querySelector('.ap-pin-popup');
        if (!popup) return;
        popup.querySelectorAll('[data-att-act]').forEach(b => {
          const a = b.getAttribute('data-att-act');
          if (a === 'voice' && activeRecorders.audio) b.innerHTML = `⏹ Stop (${recDuration(activeRecorders.audio)})`;
          if (a === 'screen' && activeRecorders.screen) b.innerHTML = `⏹ Stop (${recDuration(activeRecorders.screen)})`;
        });
      }, 1000);
      refreshAnnotationOverlay();
    } catch (e) {
      toast(e.message || 'Recording failed', 'err');
    }
  }
  let recTimer = null;

  function pickMimeType(candidates) {
    for (const c of candidates) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; } catch {}
    }
    return null;
  }

  function kindForMime(m) {
    if (!m) return 'file';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('video/')) return 'video';
    return 'file';
  }

  function queuePendingAttachment(fileOrBlob, kind) {
    // Generate an object URL for image previews so we can show a thumbnail
    // immediately. Revoked when the attachment is removed or saved.
    const name = fileOrBlob.name || ('attachment-' + Date.now());
    const entry = {
      name,
      blob: fileOrBlob,
      mime: fileOrBlob.type,
      kind: kind || kindForMime(fileOrBlob.type),
      previewUrl: kind === 'image' ? URL.createObjectURL(fileOrBlob) : null,
    };
    state.pendingAttachments.push(entry);
    refreshAnnotationOverlay();
  }

  // Small floating menu for adding attachments to an *existing* pin. The
  // new-pin popup has its own inline attachment bar; this is for pins
  // that were already created. Triggered from the "+ Attach" link in
  // the side-panel pin row.
  function openAttachMenu(anchor, annotationId) {
    const existing = document.getElementById('ap-att-menu');
    if (existing) existing.remove();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'ap-att-menu';
    Object.assign(menu.style, {
      position: 'fixed', top: (rect.bottom + 4) + 'px', left: (rect.left - 40) + 'px',
      background: '#fff', border: '1px solid #dbe5ef', borderRadius: '8px',
      boxShadow: '0 12px 28px rgba(15,23,42,.18)', padding: '6px', zIndex: 50,
      display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '160px',
    });
    menu.innerHTML = `
      <button class="ap-att-btn" data-do="file">📎 File…</button>
      <button class="ap-att-btn" data-do="voice">🎤 Voice note</button>
      <button class="ap-att-btn" data-do="screen">🎥 Screen recording</button>
      <input type="file" id="ap-att-file" style="display:none"/>
    `;
    document.body.appendChild(menu);
    // Click-outside closes the menu.
    setTimeout(() => {
      const off = (e) => {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', off); }
      };
      document.addEventListener('click', off);
    }, 0);
    const fileIn = menu.querySelector('#ap-att-file');
    fileIn.onchange = async (e) => {
      const f = (e.target.files || [])[0];
      menu.remove();
      if (!f) return;
      try {
        const att = await uploadAttachment(annotationId, { name: f.name, blob: f, mime: f.type, kind: kindForMime(f.type) });
        const ann = state.annotations.find(x => x.id === annotationId);
        if (ann) ann.attachments = (ann.attachments || []).concat([att]);
        refreshAnnotationOverlay();
      } catch (err) { toast(err.message, 'err'); }
    };
    menu.querySelectorAll('[data-do]').forEach(b => {
      b.onclick = async () => {
        const act = b.getAttribute('data-do');
        if (act === 'file') { fileIn.click(); return; }
        menu.remove();
        try {
          let stream, mime;
          if (act === 'voice') {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mime = pickMimeType(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
          } else {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 24 }, audio: true });
            mime = pickMimeType(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
          }
          await recordAndAttachToExistingPin(annotationId, stream, mime, act === 'voice' ? 'audio' : 'video');
        } catch (e) { toast(e.message || 'Recording failed', 'err'); }
      };
    });
  }

  // Record straight into an existing pin — uses a tiny floating Stop bar
  // so the user can end the recording without juggling the pin popup.
  async function recordAndAttachToExistingPin(annotationId, stream, mime, kind) {
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const bar = document.createElement('div');
    bar.className = 'ap-pen-controls';
    bar.style.top = '14px';
    bar.innerHTML = `<span style="color:#fca5a5">● REC</span> <span id="ap-rec-time">0:00</span> <button class="primary" id="ap-rec-stop">⏹ Stop</button>`;
    document.body.appendChild(bar);
    const startedAt = Date.now();
    const timeEl = bar.querySelector('#ap-rec-time');
    const interval = setInterval(() => {
      timeEl.textContent = recDuration({ startedAt });
    }, 1000);
    bar.querySelector('#ap-rec-stop').onclick = () => recorder.stop();
    stream.getTracks().forEach(tr => tr.addEventListener('ended', () => { try { recorder.stop(); } catch {} }));
    recorder.onstop = async () => {
      clearInterval(interval);
      bar.remove();
      try { stream.getTracks().forEach(tr => tr.stop()); } catch {}
      const blob = new Blob(chunks, { type: recorder.mimeType || (kind === 'audio' ? 'audio/webm' : 'video/webm') });
      const ext = (recorder.mimeType || '').includes('mp4') ? (kind === 'audio' ? 'm4a' : 'mp4') : 'webm';
      const file = new File([blob], (kind === 'audio' ? 'voice-' : 'screen-') + Date.now() + '.' + ext, { type: recorder.mimeType || blob.type });
      try {
        const att = await uploadAttachment(annotationId, { name: file.name, blob: file, mime: file.type, kind });
        const ann = state.annotations.find(x => x.id === annotationId);
        if (ann) ann.attachments = (ann.attachments || []).concat([att]);
        refreshAnnotationOverlay();
      } catch (e) { toast(e.message, 'err'); }
    };
    recorder.start();
  }

  async function uploadAttachment(annotationId, entry) {
    const fd = new FormData();
    fd.append('file', entry.blob, entry.name);
    const r = await fetch('/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/annotations/' + annotationId + '/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    return data;
  }

  function bindTodosEvents() {
    const addBtn = document.getElementById('ap-todo-add');
    const titleIn = document.getElementById('ap-todo-new-text');
    if (addBtn && titleIn) {
      const submit = async () => {
        const v = titleIn.value.trim();
        if (!v) return;
        try {
          const t = await api('POST', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/todos', { text: v });
          state.todos.push(t);
          titleIn.value = '';
          render();
          const newIn = document.getElementById('ap-todo-new-text');
          if (newIn) newIn.focus();
        } catch (e) { toast(e.message, 'err'); }
      };
      addBtn.onclick = submit;
      titleIn.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    }
    root.querySelectorAll('[data-act="toggle-todo"]').forEach(el => {
      el.onchange = async () => {
        const tid = Number(el.getAttribute('data-tid'));
        const t = state.todos.find(x => x.id === tid);
        if (!t) return;
        try {
          const r = await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/todos/' + tid, { done: el.checked });
          Object.assign(t, r);
          render();
        } catch (e) { toast(e.message, 'err'); el.checked = !el.checked; }
      };
    });
    root.querySelectorAll('[data-act="delete-todo"]').forEach(el => {
      el.onclick = async () => {
        const tid = Number(el.getAttribute('data-tid'));
        if (!await uiConfirm('Delete this to-do?')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/todos/' + tid);
          state.todos = state.todos.filter(x => x.id !== tid);
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  function bindTicketEvents() {
    const t = state.ticketDetail;
    if (!t) return;
    const patch = async (body) => {
      try {
        const updated = await api('PATCH', '/api/apps/' + state.app.id + '/tickets/' + t.id, body);
        // Server may have appended a system comment for status changes —
        // re-fetch the full ticket to grab the updated comment list.
        const full = await api('GET', '/api/apps/' + state.app.id + '/tickets/' + t.id);
        state.ticketDetail = full;
        const idx = state.tickets.findIndex(x => x.id === t.id);
        if (idx >= 0) state.tickets[idx] = Object.assign({}, state.tickets[idx], updated);
        render();
      } catch (e) { toast(e.message, 'err'); }
    };
    const titleIn = document.getElementById('ap-ticket-title');
    if (titleIn) {
      titleIn.onblur = () => {
        const v = titleIn.value.trim();
        if (v && v !== t.title) patch({ title: v });
      };
    }
    const statusSel = document.getElementById('ap-ticket-status');
    if (statusSel) statusSel.onchange = () => patch({ status: statusSel.value });
    const prioSel = document.getElementById('ap-ticket-priority');
    if (prioSel) prioSel.onchange = () => patch({ priority: prioSel.value });
    const assignSel = document.getElementById('ap-ticket-assignee');
    if (assignSel) assignSel.onchange = () => patch({ assignee_id: assignSel.value || null });
    const pageSel = document.getElementById('ap-ticket-page');
    if (pageSel) pageSel.onchange = () => patch({ page_id: pageSel.value || null });
    const closeBtn = document.getElementById('ap-ticket-close');
    if (closeBtn) closeBtn.onclick = () => patch({ status: 'closed' });
    const reopenBtn = document.getElementById('ap-ticket-reopen');
    if (reopenBtn) reopenBtn.onclick = () => patch({ status: 'open' });
    const delBtn = document.getElementById('ap-ticket-delete');
    if (delBtn) {
      delBtn.onclick = async () => {
        if (!await uiConfirm('Delete this ticket? All comments will be removed too.')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/tickets/' + t.id);
          state.tickets = state.tickets.filter(x => x.id !== t.id);
          state.ticketDetail = null;
          state.selectedTicketId = null;
          navigate('/' + state.app.id);
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    const saveBtn = document.getElementById('ap-ticket-save');
    const savedFlag = document.getElementById('ap-ticket-saved');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const desc = document.getElementById('ap-ticket-desc').value;
        try {
          await api('PATCH', '/api/apps/' + state.app.id + '/tickets/' + t.id, { description: desc });
          t.description = desc;
          if (savedFlag) {
            savedFlag.classList.add('visible');
            setTimeout(() => savedFlag.classList.remove('visible'), 1600);
          }
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    const sendBtn = document.getElementById('ap-ticket-comment-send');
    const commentInput = document.getElementById('ap-ticket-comment-input');
    if (sendBtn && commentInput) {
      sendBtn.onclick = async () => {
        const text = commentInput.value.trim();
        if (!text) return;
        try {
          const c = await api('POST', '/api/apps/' + state.app.id + '/tickets/' + t.id + '/comments', { text });
          state.ticketDetail.comments = (state.ticketDetail.comments || []).concat([c]);
          state.ticketDetail.comment_count = (state.ticketDetail.comment_count || 0) + 1;
          const idx = state.tickets.findIndex(x => x.id === t.id);
          if (idx >= 0) state.tickets[idx].comment_count = state.ticketDetail.comment_count;
          commentInput.value = '';
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    root.querySelectorAll('[data-act="del-tc"]').forEach(el => {
      el.onclick = async () => {
        const cid = Number(el.getAttribute('data-cid'));
        if (!await uiConfirm('Delete this comment?')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/tickets/' + t.id + '/comments/' + cid);
          state.ticketDetail.comments = state.ticketDetail.comments.filter(x => x.id !== cid);
          state.ticketDetail.comment_count = Math.max(0, (state.ticketDetail.comment_count || 1) - 1);
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  function openTicketModal(prefill) {
    const initial = prefill || { title: '', description: '', priority: 'normal', assignee_id: '', page_id: '' };
    const userOpts = '<option value="">— Unassigned —</option>' +
      (state.team || []).map(u => `<option value="${u.id}"${u.id === initial.assignee_id ? ' selected' : ''}>${escapeHtml(u.name)}</option>`).join('');
    const pageOpts = '<option value="">— No page —</option>' +
      ((state.app.pages || []).map(p => `<option value="${p.id}"${p.id === initial.page_id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join(''));
    const modal = document.createElement('div');
    modal.id = 'ap-modal-back';
    modal.className = 'ap-modal-back';
    modal.innerHTML = `
      <div class="ap-modal">
        <div class="ap-modal-head"><h3>New ticket</h3><span class="ap-modal-close" id="ap-modal-close">×</span></div>
        <div class="ap-modal-body">
          <div class="ap-field"><label>Title</label><input id="t-title" value="${escapeHtml(initial.title || '')}" placeholder="Short summary"/></div>
          <div class="ap-field"><label>Description</label><textarea id="t-desc" rows="4" placeholder="Details, repro steps, screenshots, etc.">${escapeHtml(initial.description || '')}</textarea></div>
          <div class="ap-field-row">
            <div class="ap-field"><label>Priority</label>
              <select id="t-priority">
                ${['low', 'normal', 'high', 'urgent'].map(p => `<option value="${p}"${p === (initial.priority || 'normal') ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
              </select>
            </div>
            <div class="ap-field"><label>Assignee</label><select id="t-assignee">${userOpts}</select></div>
          </div>
          <div class="ap-field"><label>Linked page (optional)</label><select id="t-page">${pageOpts}</select></div>
        </div>
        <div class="ap-modal-foot">
          <button class="btn btn-ghost" id="t-cancel">Cancel</button>
          <button class="btn btn-primary" id="t-save">Create ticket</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    document.getElementById('ap-modal-close').onclick = close;
    document.getElementById('t-cancel').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    document.getElementById('t-save').onclick = async () => {
      const title = document.getElementById('t-title').value.trim();
      if (!title) { toast('Title is required', 'err'); return; }
      const body = {
        title,
        description: document.getElementById('t-desc').value.trim(),
        priority: document.getElementById('t-priority').value,
        assignee_id: document.getElementById('t-assignee').value || null,
        page_id: document.getElementById('t-page').value || null,
      };
      try {
        const created = await api('POST', '/api/apps/' + state.app.id + '/tickets', body);
        state.tickets.unshift(created);
        state.sidebarSection = 'tickets';
        close();
        navigate('/' + state.app.id + '/t/' + created.id);
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function bindBlueprintEvents() {
    const ta = document.getElementById('ap-blueprint-textarea');
    const saveBtn = document.getElementById('ap-blueprint-save');
    const aiBtn = document.getElementById('ap-blueprint-ai');
    const refreshBtn = document.getElementById('ap-blueprint-refresh');
    const savedFlag = document.getElementById('ap-blueprint-saved');

    // Language toggle — EN edits the source, BN shows a cached translation.
    root.querySelectorAll('[data-lang]').forEach(btn => {
      btn.onclick = async () => {
        const lang = btn.getAttribute('data-lang');
        if (lang === state.blueprintLang) return;
        state.blueprintLang = lang;
        if (lang === 'bn') {
          state.blueprintBn = '';
          render();
          // Skip the call if source is empty — nothing to translate.
          if (!state.pageDetail.blueprint || !state.pageDetail.blueprint.trim()) {
            toast('Blueprint is empty — nothing to translate yet', 'err');
            state.blueprintLang = 'en';
            render();
            return;
          }
          try {
            const r = await api('POST', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/blueprint/translate', { lang: 'bn' });
            state.blueprintBn = r.translated || '';
            render();
          } catch (e) {
            toast(e.message, 'err');
            state.blueprintLang = 'en';
            render();
          }
        } else {
          render();
        }
      };
    });

    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        try {
          const fresh = await api('GET', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id);
          state.pageDetail = fresh;
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    if (saveBtn) {
      saveBtn.onclick = async () => {
        try {
          await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id, { blueprint: ta.value });
          state.pageDetail.blueprint = ta.value;
          // English changed — invalidate any cached BN translation client-side too.
          state.blueprintBn = '';
          if (savedFlag) {
            savedFlag.classList.add('visible');
            setTimeout(() => savedFlag.classList.remove('visible'), 2000);
          }
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    if (aiBtn) {
      aiBtn.onclick = async () => {
        aiBtn.disabled = true;
        const orig = aiBtn.innerHTML;
        aiBtn.innerHTML = 'Generating…';
        try {
          const r = await api('POST', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/blueprint/generate');
          if (r && r.draft) {
            const cur = ta.value.trim();
            ta.value = cur ? (cur + '\n\n— AI draft —\n' + r.draft) : r.draft;
            toast('AI draft generated — click Save to keep it', 'ok');
          }
        } catch (e) { toast(e.message, 'err'); }
        aiBtn.disabled = false;
        aiBtn.innerHTML = orig;
      };
    }
  }

  let replyTo = null;
  function bindQAEvents() {
    const ta = document.getElementById('ap-qa-input');
    const send = document.getElementById('ap-qa-send');
    if (send && ta) {
      send.onclick = async () => {
        const text = ta.value.trim();
        if (!text) return;
        try {
          const body = { text };
          if (replyTo) body.parent_id = replyTo;
          const c = await api('POST', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/comments', body);
          state.comments.push(c);
          replyTo = null;
          ta.value = '';
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    root.querySelectorAll('[data-act]').forEach(el => {
      const act = el.getAttribute('data-act');
      const cid = el.getAttribute('data-cid');
      if (!cid) return;
      if (act === 'toggle-resolve') {
        el.onclick = async () => {
          const c = state.comments.find(x => x.id === Number(cid));
          if (!c) return;
          try {
            const r = await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/comments/' + cid, { resolved: !c.resolved });
            Object.assign(c, r);
            render();
          } catch (e) { toast(e.message, 'err'); }
        };
      } else if (act === 'delete') {
        el.onclick = async () => {
          if (!await uiConfirm('Delete this comment?')) return;
          try {
            await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/comments/' + cid);
            state.comments = state.comments.filter(x => x.id !== Number(cid));
            render();
          } catch (e) { toast(e.message, 'err'); }
        };
      } else if (act === 'reply') {
        el.onclick = () => {
          replyTo = Number(cid);
          const ta = document.getElementById('ap-qa-input');
          if (ta) {
            ta.focus();
            ta.placeholder = 'Replying… (Esc to cancel)';
            ta.addEventListener('keydown', function once(ev) {
              if (ev.key === 'Escape') {
                replyTo = null;
                ta.placeholder = 'Ask a question or leave a note about this page…';
                ta.removeEventListener('keydown', once);
              }
            });
          }
          toast('Replying to comment', 'ok');
        };
      }
    });
  }

  function bindFunctionsEvents() {
    const addBtn = document.getElementById('ap-fn-add');
    const titleIn = document.getElementById('ap-fn-new-title');
    if (addBtn && titleIn) {
      const submit = async () => {
        const v = titleIn.value.trim();
        if (!v) return;
        try {
          const f = await api('POST', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/functions', { title: v });
          state.functions.push(f);
          titleIn.value = '';
          render();
          // Re-focus the input so the user can keep adding.
          const newIn = document.getElementById('ap-fn-new-title');
          if (newIn) newIn.focus();
        } catch (e) { toast(e.message, 'err'); }
      };
      addBtn.onclick = submit;
      titleIn.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    }
    root.querySelectorAll('[data-act="cycle-status"]').forEach(el => {
      el.onclick = async () => {
        const fid = Number(el.getAttribute('data-fid'));
        const f = state.functions.find(x => x.id === fid);
        if (!f) return;
        const cycle = { pending: 'working', working: 'broken', broken: 'na', na: 'pending' };
        const next = cycle[f.status] || 'pending';
        try {
          const r = await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/functions/' + fid, { status: next });
          Object.assign(f, r);
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    root.querySelectorAll('[data-act="edit-title"]').forEach(el => {
      el.onblur = async () => {
        const fid = Number(el.getAttribute('data-fid'));
        const f = state.functions.find(x => x.id === fid);
        const v = el.value.trim();
        if (!f || !v || v === f.title) return;
        try {
          const r = await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/functions/' + fid, { title: v });
          Object.assign(f, r);
        } catch (e) { toast(e.message, 'err'); el.value = f.title; }
      };
    });
    root.querySelectorAll('[data-act="delete-fn"]').forEach(el => {
      el.onclick = async () => {
        const fid = Number(el.getAttribute('data-fid'));
        if (!await uiConfirm('Delete this function?')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/functions/' + fid);
          state.functions = state.functions.filter(x => x.id !== fid);
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  // ── Modals ─────────────────────────────────────────────────────────────
  function closeModal() {
    const m = document.getElementById('ap-modal-back');
    if (m) m.remove();
  }

  function openAppModal(existing) {
    const editing = !!existing;
    const a = existing || { name: '', description: '', cover_color: COLORS[0], designer_id: state.me ? state.me.id : null, manager_id: null, developer_id: null, status: 'design', repo_url: '', deploy_url: '' };
    const userOpts = (selected) => {
      const blank = `<option value="">— Unassigned —</option>`;
      const list = (state.team || []).map(u => `<option value="${u.id}"${u.id === selected ? ' selected' : ''}>${escapeHtml(u.name)}</option>`).join('');
      return blank + list;
    };
    const swatches = COLORS.map(c => `<span class="ap-color-swatch${c === a.cover_color ? ' active' : ''}" data-color="${c}" style="background:${c}"></span>`).join('');
    const modal = document.createElement('div');
    modal.id = 'ap-modal-back';
    modal.className = 'ap-modal-back';
    modal.innerHTML = `
      <div class="ap-modal" id="ap-modal">
        <div class="ap-modal-head">
          <h3>${editing ? 'Edit app' : 'New app'}</h3>
          <span class="ap-modal-close" id="ap-modal-close">×</span>
        </div>
        <div class="ap-modal-body">
          <div class="ap-field">
            <label>Name</label>
            <input id="m-name" value="${escapeHtml(a.name)}" placeholder="e.g. Customer Portal"/>
          </div>
          <div class="ap-field">
            <label>Description</label>
            <textarea id="m-desc" placeholder="What this app does…">${escapeHtml(a.description)}</textarea>
          </div>
          <div class="ap-field">
            <label>Cover colour</label>
            <div class="ap-color-swatches" id="m-colors">${swatches}</div>
          </div>
          <div class="ap-field-row">
            <div class="ap-field"><label>Designer</label><select id="m-designer">${userOpts(a.designer_id)}</select></div>
            <div class="ap-field"><label>Status</label>
              <select id="m-status">
                ${['design', 'dev', 'review', 'live', 'archived'].map(s => `<option value="${s}"${a.status === s ? ' selected' : ''}>${prettyAppStatus(s)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="ap-field-row">
            <div class="ap-field"><label>Manager</label><select id="m-manager">${userOpts(a.manager_id)}</select></div>
            <div class="ap-field"><label>Developer</label><select id="m-developer">${userOpts(a.developer_id)}</select></div>
          </div>
          <div class="ap-field-row">
            <div class="ap-field"><label>Repo URL</label><input id="m-repo" value="${escapeHtml(a.repo_url || '')}" placeholder="https://github.com/owner/repo"/></div>
            <div class="ap-field"><label>Deploy URL</label><input id="m-deploy" value="${escapeHtml(a.deploy_url || '')}" placeholder="https://…"/></div>
          </div>

          <div class="ap-gh-section">
            <div class="ap-gh-section-head">
              <span>🔗 GitHub sync</span>
              <span style="font-size:11px;color:#94a3b8;font-weight:400">Pull HTML pages from your repo automatically</span>
            </div>
            <div class="ap-field-row">
              <div class="ap-field"><label>Branch</label><input id="m-repo-branch" value="${escapeHtml(a.repo_branch || 'main')}" placeholder="main"/></div>
              <div class="ap-field"><label>Folder (optional)</label><input id="m-repo-path" value="${escapeHtml(a.repo_path || '')}" placeholder="e.g. designs/"/></div>
            </div>
            <div class="ap-field">
              <label>Personal Access Token (for private repos)</label>
              <input id="m-repo-token" type="password" value="" placeholder="${a.repo_token_set ? '••••••••• (saved — leave blank to keep)' : 'ghp_... (leave blank for public repos)'}" autocomplete="new-password"/>
            </div>
            <div class="ap-field" style="display:flex;align-items:center;gap:8px;margin-top:4px">
              <label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:#1e293b;cursor:pointer;text-transform:none;letter-spacing:0">
                <input type="checkbox" id="m-repo-auto" ${a.repo_auto_sync ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;accent-color:#22c55e"/>
                Auto-sync every 5 minutes
              </label>
            </div>
            ${editing ? `
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:flex-start">
              <button type="button" class="btn btn-secondary btn-small" id="m-repo-test">Test connection</button>
              <button type="button" class="btn btn-secondary btn-small" id="m-repo-sync">Sync now</button>
              <span id="m-repo-status" style="font-size:12px;color:#64748b;white-space:pre-wrap;line-height:1.5;flex:1;min-width:200px"></span>
            </div>` : ''}
          </div>
        </div>
        <div class="ap-modal-foot">
          ${editing ? '<button class="btn btn-danger" id="m-delete" style="margin-right:auto">Delete app</button>' : ''}
          <button class="btn btn-ghost" id="m-cancel">Cancel</button>
          <button class="btn btn-primary" id="m-save">${editing ? 'Save' : 'Create'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    let pickedColor = a.cover_color;
    modal.querySelectorAll('.ap-color-swatch').forEach(s => {
      s.onclick = () => {
        pickedColor = s.getAttribute('data-color');
        modal.querySelectorAll('.ap-color-swatch').forEach(x => x.classList.remove('active'));
        s.classList.add('active');
      };
    });
    document.getElementById('ap-modal-close').onclick = closeModal;
    document.getElementById('m-cancel').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    if (editing) {
      document.getElementById('m-delete').onclick = async () => {
        if (!await uiConfirm('Delete this app? This soft-deletes it and hides all pages, comments, and functions.')) return;
        try {
          await api('DELETE', '/api/apps/' + existing.id);
          closeModal();
          navigate('/');
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    // Helper to build the payload from the form — used by both the Save
    // button and the GitHub Test/Sync buttons so the user gets feedback
    // against whatever they've typed in, not the last-saved values.
    const buildPayload = () => {
      const p = {
        name: document.getElementById('m-name').value.trim(),
        description: document.getElementById('m-desc').value.trim(),
        cover_color: pickedColor,
        designer_id: document.getElementById('m-designer').value || null,
        manager_id: document.getElementById('m-manager').value || null,
        developer_id: document.getElementById('m-developer').value || null,
        repo_url: document.getElementById('m-repo').value.trim(),
        deploy_url: document.getElementById('m-deploy').value.trim(),
        status: document.getElementById('m-status').value,
        repo_branch: (document.getElementById('m-repo-branch').value.trim() || 'main'),
        repo_path: document.getElementById('m-repo-path').value.trim(),
        repo_auto_sync: document.getElementById('m-repo-auto').checked,
      };
      // Only send repo_token when the user typed something — otherwise
      // omit so the server keeps the existing value (write-only field).
      const tokenVal = document.getElementById('m-repo-token').value;
      if (tokenVal !== '') p.repo_token = tokenVal;
      return p;
    };

    // GitHub: Test connection + Sync now (only present when editing).
    const testBtn = document.getElementById('m-repo-test');
    const syncBtn = document.getElementById('m-repo-sync');
    const statusEl = document.getElementById('m-repo-status');
    const setRepoStatus = (text, color) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.style.color = color || '#64748b';
    };
    if (testBtn) {
      testBtn.onclick = async () => {
        const p = buildPayload();
        if (!p.repo_url) { toast('Add a repo URL first', 'err'); return; }
        testBtn.disabled = true; setRepoStatus('Testing…');
        try {
          const r = await api('POST', '/api/apps/' + existing.id + '/github/test', p);
          setRepoStatus(`✓ ${r.owner}/${r.repo} @ ${r.branch} — ${r.file_count} HTML file${r.file_count === 1 ? '' : 's'}`, '#16a34a');
        } catch (e) { setRepoStatus('✗ ' + e.message, '#dc2626'); }
        testBtn.disabled = false;
      };
    }
    if (syncBtn) {
      syncBtn.onclick = async () => {
        const p = buildPayload();
        if (!p.repo_url) { toast('Add a repo URL first', 'err'); return; }
        syncBtn.disabled = true; setRepoStatus('Saving config + syncing…');
        try {
          // Save first so the sync uses the freshest config (URL, branch,
          // path, token, auto-sync toggle).
          await api('PATCH', '/api/apps/' + existing.id, p);
          const r = await api('POST', '/api/apps/' + existing.id + '/github/sync');
          // Log the full response so the user can paste it back if
          // something doesn't look right (e.g. assets staying at 0).
          console.log('[apps/github] sync result:', r);
          const a = r.assets || {};
          const pageParts = [`+${r.added || 0} added`, `${r.updated || 0} updated`, `${r.unchanged || 0} unchanged`];
          if (r.removed) pageParts.push(`${r.removed} removed`);
          const assetParts = [`+${a.added || 0} added`, `${a.updated || 0} updated`, `${a.unchanged || 0} unchanged`];
          if (a.removed) assetParts.push(`${a.removed} removed`);
          if (a.skipped) assetParts.push(`${a.skipped} skipped (>5MB)`);
          const assetCountTotal = (a.added || 0) + (a.updated || 0) + (a.unchanged || 0);
          const assetLine = a.total === undefined
            ? '  (assets: deploy may still be running the old sync code)'
            : `  assets: ${assetParts.join(' · ')} of ${a.total} total`;
          setRepoStatus(
            `✓ pages: ${pageParts.join(' · ')}\n${assetLine}`,
            '#16a34a'
          );
          if (a.total === 0) {
            // Nothing under the configured folder matched the asset
            // allowlist — flag it explicitly so the user knows why the
            // preview is still missing styles/scripts.
            setRepoStatus(
              `✓ pages: ${pageParts.join(' · ')}\n  ⚠ no supporting assets (css/js/img) found in this folder — check the Folder setting (e.g. "public/")`,
              '#b45309'
            );
          }
          // Refresh the local app + pages so the new pages show up
          // immediately in the sidebar.
          const fresh = await api('GET', '/api/apps/' + existing.id);
          state.app = fresh;
        } catch (e) { setRepoStatus('✗ ' + e.message, '#dc2626'); }
        syncBtn.disabled = false;
      };
    }

    document.getElementById('m-save').onclick = async () => {
      const payload = buildPayload();
      if (!payload.name) { toast('Name is required', 'err'); return; }
      try {
        if (editing) {
          const updated = await api('PATCH', '/api/apps/' + existing.id, payload);
          Object.assign(state.app, updated);
          toast('App updated', 'ok');
          closeModal();
          render();
        } else {
          const created = await api('POST', '/api/apps', payload);
          closeModal();
          navigate('/' + created.id);
        }
      } catch (e) { toast(e.message, 'err'); }
    };
  }
  function prettyAppStatus(s) { return ({ design: 'Design', dev: 'In development', review: 'In review', live: 'Live', archived: 'Archived' })[s] || s; }

  function openAddPageModal() {
    const modal = document.createElement('div');
    modal.id = 'ap-modal-back';
    modal.className = 'ap-modal-back';
    modal.innerHTML = `
      <div class="ap-modal" id="ap-modal">
        <div class="ap-modal-head">
          <h3>Add page${state.app ? ' to ' + escapeHtml(state.app.name) : ''}</h3>
          <span class="ap-modal-close" id="ap-modal-close">×</span>
        </div>
        <div class="ap-modal-body">
          <div class="ap-source-tabs">
            <div class="ap-source-tab active" data-src="upload">Upload HTML file(s)</div>
            <div class="ap-source-tab" data-src="paste">Paste HTML</div>
          </div>
          <div id="ap-src-upload">
            <div class="ap-file-drop" id="ap-file-drop">
              <strong>Drop .html files here</strong>
              <div>or click to choose — one or many</div>
              <div class="ap-file-hint">Each file becomes one page. Filename is used as the page name.</div>
              <input type="file" id="ap-file-input" accept=".html,.htm,text/html" multiple style="display:none"/>
            </div>
            <div class="ap-file-list" id="ap-file-list"></div>
          </div>
          <div id="ap-src-paste" style="display:none">
            <div class="ap-field"><label>Page name</label><input id="m-paste-name" placeholder="e.g. Login page"/></div>
            <div class="ap-field">
              <label>HTML</label>
              <textarea id="m-paste-html" style="min-height:240px;font-family:Menlo,Consolas,monospace;font-size:12px" placeholder="<!doctype html>&#10;<html>&#10;…"></textarea>
            </div>
          </div>
        </div>
        <div class="ap-modal-foot">
          <button class="btn btn-ghost" id="m-cancel">Cancel</button>
          <button class="btn btn-primary" id="m-paste-save" style="display:none">Add page</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('ap-modal-close').onclick = closeModal;
    document.getElementById('m-cancel').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    modal.querySelectorAll('.ap-source-tab').forEach(t => {
      t.onclick = () => {
        modal.querySelectorAll('.ap-source-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        const src = t.getAttribute('data-src');
        document.getElementById('ap-src-upload').style.display = src === 'upload' ? '' : 'none';
        document.getElementById('ap-src-paste').style.display = src === 'paste' ? '' : 'none';
        document.getElementById('m-paste-save').style.display = src === 'paste' ? '' : 'none';
      };
    });

    // Upload flow
    const drop = document.getElementById('ap-file-drop');
    const input = document.getElementById('ap-file-input');
    const list = document.getElementById('ap-file-list');
    drop.onclick = () => input.click();
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer.files || []);
      handleFiles(files);
    });
    input.onchange = () => {
      handleFiles(Array.from(input.files || []));
    };
    async function handleFiles(files) {
      const html = files.filter(f => /\.html?$/i.test(f.name) || f.type === 'text/html');
      if (html.length === 0) {
        toast('No HTML files in selection', 'err');
        return;
      }
      list.innerHTML = '';
      for (const f of html) {
        const row = document.createElement('div');
        row.className = 'ap-file-row';
        row.innerHTML = `<span class="ap-file-name">${escapeHtml(f.name)}</span><span class="ap-file-status">Uploading…</span>`;
        list.appendChild(row);
        try {
          const text = await f.text();
          // Derive a friendlier page name from the filename (drop .html, replace dashes/underscores with spaces).
          const baseName = f.name.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
          const created = await api('POST', '/api/apps/' + state.app.id + '/pages', {
            name: baseName || f.name,
            file_name: f.name,
            html_content: text,
          });
          if (!state.app.pages) state.app.pages = [];
          state.app.pages.push(Object.assign({}, created, { comment_count: 0, fn_total: 0, fn_working: 0 }));
          row.classList.add('ok');
          row.querySelector('.ap-file-status').textContent = 'Added';
        } catch (e) {
          row.classList.add('err');
          row.querySelector('.ap-file-status').textContent = e.message;
        }
      }
      // Refresh sidebar; close modal after a short delay so the user sees outcomes.
      setTimeout(() => {
        closeModal();
        render();
        const last = state.app.pages[state.app.pages.length - 1];
        if (last) navigate('/' + state.app.id + '/p/' + last.id);
      }, 600);
    }

    // Paste flow
    document.getElementById('m-paste-save').onclick = async () => {
      const name = document.getElementById('m-paste-name').value.trim();
      const html = document.getElementById('m-paste-html').value;
      if (!name) { toast('Page name required', 'err'); return; }
      if (!html.trim()) { toast('Paste some HTML', 'err'); return; }
      try {
        const created = await api('POST', '/api/apps/' + state.app.id + '/pages', { name, html_content: html });
        if (!state.app.pages) state.app.pages = [];
        state.app.pages.push(Object.assign({}, created, { comment_count: 0, fn_total: 0, fn_working: 0 }));
        closeModal();
        navigate('/' + state.app.id + '/p/' + created.id);
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  window.addEventListener('popstate', handleRoute);
  // Back-compat: anyone who still has an old #-route bookmarked (e.g.
  // /apps.html#/1/p/2) lands on the legacy URL — quietly rewrite to the
  // new /apps/1/p/2 form so the address bar matches what the SPA renders.
  if (window.location.pathname === '/apps.html') {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const cleanHash = (hash === '/' || hash === '') ? '' : hash;
    try { window.history.replaceState(null, '', '/apps' + cleanHash); } catch {}
  }
  (async () => {
    // Version stamp + html2canvas availability check, logged on every
    // load so it's easy to confirm the right build is running when
    // diagnosing pen-snippet issues from the browser console.
    console.log('[apps] build 2026-05-18.6 — html2canvas:', !!window.html2canvas);
    await Promise.all([loadMe(), loadTeam()]);
    handleRoute();
  })();
})();
