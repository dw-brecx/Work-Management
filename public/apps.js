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
    pageView: 'dashboard', // 'dashboard' (app overview) | 'page' (specific page detail)
    selectedPageId: null,
    pageDetail: null, // currently loaded page with html_content
    tab: 'preview',   // 'preview' | 'blueprint' | 'qa' | 'todos' | 'functions'
    comments: [],
    functions: [],
    todos: [],
    annotations: [],
    annotateMode: false,
    pendingPin: null, // { x_pct, y_pct } while the new-annotation popover is open
    blueprintLang: 'en', // 'en' | 'bn'
    blueprintBn: '', // cached BN translation, fetched on demand
    dashboard: null,  // loaded by loadDashboard
    dashAllTab: 'comments', // which "all items" sub-tab on the dashboard
    loading: false,
    error: null,
  };

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

  // ── Routing ────────────────────────────────────────────────────────────
  function parseHash() {
    const h = (window.location.hash || '').replace(/^#/, '');
    const parts = h.split('/').filter(Boolean);
    if (parts.length === 0) return { view: 'list' };
    const appId = Number(parts[0]);
    if (!Number.isFinite(appId)) return { view: 'list' };
    let pageId = null;
    if (parts[1] === 'p' && parts[2]) {
      const n = Number(parts[2]);
      if (Number.isFinite(n)) pageId = n;
    }
    return { view: 'detail', appId, pageId };
  }
  function navigate(hash) { window.location.hash = hash; }

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
      render();
      try {
        await loadApp(route.appId);
      } catch (e) {
        state.error = e.message;
        render();
        return;
      }
    }
    // Dashboard is the default landing when no specific page is in the
    // hash. The user clicks a page in the sidebar to drop into page mode.
    if (route.pageId) {
      state.pageView = 'page';
      if (route.pageId !== state.selectedPageId) {
        await selectPage(route.pageId);
        return;
      }
      render();
    } else {
      state.pageView = 'dashboard';
      state.selectedPageId = null;
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

  function topbar(crumbs, actions) {
    const safeCrumbs = (crumbs || []).map(c => escapeHtml(c)).join('<span class="ap-crumb">&nbsp;/&nbsp;</span>');
    return `
      <div class="ap-topbar">
        <a class="ap-back" href="/" title="Back to Syruvia">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Syruvia
        </a>
        <span class="ap-crumb">/</span>
        <h1>${safeCrumbs || 'Apps'}</h1>
        <div class="ap-spacer"></div>
        ${actions || ''}
        ${state.me ? `<div class="ap-me">${escapeHtml(state.me.name || state.me.email || '')}</div>` : ''}
      </div>
    `;
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
  }

  function renderDetail() {
    if (state.loading && !state.app) {
      root.innerHTML = topbar(['Loading…']) + '<div class="ap-boot">Loading app…</div>';
      return;
    }
    if (state.error) {
      root.innerHTML = topbar(['Error']) + `<div class="ap-main"><div class="ap-card-empty"><h3>Couldn't open app</h3><p>${escapeHtml(state.error)}</p></div></div>`;
      return;
    }
    if (!state.app) return;
    const a = state.app;
    const dashActive = state.pageView === 'dashboard';
    const pageList = (a.pages || []).map(p => {
      const isActive = state.pageView === 'page' && p.id === state.selectedPageId;
      const meta = [];
      if (p.fn_total) meta.push(`${p.fn_working}/${p.fn_total} fn`);
      if (p.comment_count) meta.push(`${p.comment_count} 💬`);
      return `
        <div class="ap-page-item ${isActive ? 'active' : ''}" data-page-id="${p.id}">
          <span class="ap-page-item-dot ${escapeHtml(p.status || 'pending')}" title="${escapeHtml(p.status || 'pending')}"></span>
          <div class="ap-page-item-text">
            <div class="ap-page-item-title">${escapeHtml(p.name)}</div>
            <div class="ap-page-item-meta">${escapeHtml(meta.join(' · '))}</div>
          </div>
        </div>
      `;
    }).join('');

    root.innerHTML = `
      ${topbar([a.name], `
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
            <div class="ap-pages-list-head">
              <h4>Pages (${a.pages ? a.pages.length : 0})</h4>
            </div>
            <div class="ap-pages-list">
              <div class="ap-page-item ${dashActive ? 'active' : ''}" data-dash="1">
                <span class="ap-page-item-dot" style="background:#0ea5e9"></span>
                <div class="ap-page-item-text">
                  <div class="ap-page-item-title">📊 Dashboard</div>
                  <div class="ap-page-item-meta">Overview &amp; all items</div>
                </div>
              </div>
              ${pageList || '<div style="padding:8px 14px;font-size:12px;color:#94a3b8">No pages yet</div>'}
              <div class="ap-add-page-btn" id="ap-add-page">+ Add page</div>
            </div>
          </aside>
          <section class="ap-page-pane">
            ${state.pageView === 'dashboard' ? renderDashboardPane() : renderPagePane()}
          </section>
        </div>
      </div>
    `;
    bindDetailEvents();
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
    const previewUrl = '/api/apps/' + state.app.id + '/pages/' + p.id + '/preview?ts=' + (p.updated_at || '');
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
        <span>Sandboxed preview of <strong>${escapeHtml(p.file_name || p.name)}</strong>${p.html_content ? ` · ${(p.html_content.length / 1024).toFixed(1)} KB` : ''}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn ${state.annotateMode ? 'btn-primary' : 'btn-secondary'} btn-small" id="ap-annotate-toggle" title="Click on the design to drop a pin">
            ${state.annotateMode ? '✓ Annotating' : 'Annotate'}
          </button>
          <a href="${previewUrl}" target="_blank" rel="noopener" class="btn btn-ghost btn-small">Open in new tab ↗</a>
        </div>
      </div>
      <div class="ap-preview-layout">
        <div class="ap-preview-wrap" id="ap-preview-wrap">
          <iframe class="ap-preview-frame" src="${previewUrl}" sandbox="allow-same-origin" title="Page preview"></iframe>
          <div class="ap-pin-overlay ${state.annotateMode ? 'active' : ''}" id="ap-pin-overlay">
            ${pins}
            ${state.pendingPin ? `<div class="ap-pin ap-pin-pending" style="left:${state.pendingPin.x_pct}%;top:${state.pendingPin.y_pct}%">+</div>` : ''}
          </div>
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
    return `
      <div class="ap-pin-row ${a.status === 'resolved' ? 'resolved' : ''}" data-aid="${a.id}">
        <div class="ap-pin-row-head">
          <span class="ap-pin-dot ap-pin-${escapeHtml(a.type)}">${i + 1}</span>
          <span class="ap-pin-row-type">${escapeHtml(prettyAnnotationType(a.type))}</span>
          <span class="ap-pin-row-author">${escapeHtml(a.author_name || '')}</span>
          <span class="ap-pin-row-time">${escapeHtml(formatTime(a.created_at))}</span>
        </div>
        <div class="ap-pin-row-body">${escapeHtml(a.text)}</div>
        <div class="ap-pin-row-actions">
          <span class="ap-comment-action-btn resolve-btn" data-act="toggle-pin-resolve" data-aid="${a.id}">${a.status === 'resolved' ? 'Reopen' : 'Resolve'}</span>
          ${(state.me && a.author_id === state.me.id) ? `<span class="ap-comment-action-btn" data-act="delete-pin" data-aid="${a.id}">Delete</span>` : ''}
        </div>
      </div>
    `;
  }

  function prettyAnnotationType(t) {
    return ({ question: 'Question', issue: 'Issue', broken: 'Broken', note: 'Note' })[t] || t;
  }

  function renderNewPinPopup() {
    const pp = state.pendingPin;
    // Position the popup near the pin — use percentages so it scales.
    const left = pp.x_pct > 60 ? 'right:5%' : `left:${Math.min(pp.x_pct + 3, 70)}%`;
    const top = `top:${Math.min(pp.y_pct + 2, 75)}%`;
    return `
      <div class="ap-pin-popup" style="${left};${top}">
        <div class="ap-pin-popup-head">New pin</div>
        <select id="ap-pin-type">
          <option value="question">❔ Question</option>
          <option value="issue">⚠️ Issue</option>
          <option value="broken">✗ Not working / broken</option>
          <option value="note">✎ Note</option>
        </select>
        <textarea id="ap-pin-text" placeholder="What's this? Describe the question or issue…" rows="3"></textarea>
        <div class="ap-pin-popup-foot">
          <button class="btn btn-ghost btn-small" id="ap-pin-cancel">Cancel</button>
          <button class="btn btn-primary btn-small" id="ap-pin-save">Drop pin</button>
        </div>
      </div>
    `;
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
        <h2>${escapeHtml(state.app.name)}</h2>
        <span style="color:#64748b;font-size:13px">${escapeHtml(state.app.description || 'No description')}</span>
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

    root.querySelectorAll('.ap-page-item').forEach(el => {
      el.onclick = () => {
        if (el.getAttribute('data-dash')) navigate('/' + state.app.id);
        else navigate('/' + state.app.id + '/p/' + el.getAttribute('data-page-id'));
      };
    });

    // Dashboard pane interactions — only present when pageView is dashboard.
    if (state.pageView === 'dashboard') {
      bindDashboardEvents();
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
        if (!confirm('Delete this page? Comments and functions on it will be removed too.')) return;
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
    overlay.classList.toggle('active', !!state.annotateMode);
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

  // Preview tab — annotation overlay, pin clicks, new-pin popup.
  function bindPreviewEvents() {
    const toggleBtn = document.getElementById('ap-annotate-toggle');
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        state.annotateMode = !state.annotateMode;
        state.pendingPin = null;
        refreshAnnotationOverlay();
      };
    }
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
        if (!confirm('Delete this pin?')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/annotations/' + aid);
          state.annotations = state.annotations.filter(x => x.id !== aid);
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
        if (!text) { toast('Describe the pin first', 'err'); return; }
        try {
          const created = await api('POST', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/annotations', {
            x_pct: state.pendingPin.x_pct,
            y_pct: state.pendingPin.y_pct,
            type, text,
          });
          state.annotations.push(created);
          state.pendingPin = null;
          refreshAnnotationOverlay();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
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
        if (!confirm('Delete this to-do?')) return;
        try {
          await api('DELETE', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id + '/todos/' + tid);
          state.todos = state.todos.filter(x => x.id !== tid);
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
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
          if (!confirm('Delete this comment?')) return;
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
        if (!confirm('Delete this function?')) return;
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
            <div class="ap-field"><label>Repo URL</label><input id="m-repo" value="${escapeHtml(a.repo_url || '')}" placeholder="https://github.com/…"/></div>
            <div class="ap-field"><label>Deploy URL</label><input id="m-deploy" value="${escapeHtml(a.deploy_url || '')}" placeholder="https://…"/></div>
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
        if (!confirm('Delete this app? This soft-deletes it and hides all pages, comments, and functions.')) return;
        try {
          await api('DELETE', '/api/apps/' + existing.id);
          closeModal();
          navigate('/');
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    document.getElementById('m-save').onclick = async () => {
      const payload = {
        name: document.getElementById('m-name').value.trim(),
        description: document.getElementById('m-desc').value.trim(),
        cover_color: pickedColor,
        designer_id: document.getElementById('m-designer').value || null,
        manager_id: document.getElementById('m-manager').value || null,
        developer_id: document.getElementById('m-developer').value || null,
        repo_url: document.getElementById('m-repo').value.trim(),
        deploy_url: document.getElementById('m-deploy').value.trim(),
        status: document.getElementById('m-status').value,
      };
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
  window.addEventListener('hashchange', handleRoute);
  (async () => {
    await Promise.all([loadMe(), loadTeam()]);
    handleRoute();
  })();
})();
