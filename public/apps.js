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
    view: 'list',   // 'list' | 'detail'
    apps: [],
    app: null,        // currently loaded app (with .pages)
    selectedPageId: null,
    pageDetail: null, // currently loaded page with html_content
    tab: 'preview',   // 'preview' | 'blueprint' | 'qa' | 'functions'
    comments: [],
    functions: [],
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
      render();
      try {
        await loadApp(route.appId);
      } catch (e) {
        state.error = e.message;
        render();
        return;
      }
    }
    // Choose page: explicit hash > first page > none
    const pickPageId = route.pageId
      || (state.app.pages && state.app.pages[0] && state.app.pages[0].id)
      || null;
    if (pickPageId && pickPageId !== state.selectedPageId) {
      await selectPage(pickPageId);
    } else {
      render();
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
    state.selectedPageId = pageId;
    state.pageDetail = null;
    state.comments = [];
    state.functions = [];
    render();
    try {
      const [page, comments, fns] = await Promise.all([
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId),
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId + '/comments'),
        api('GET', '/api/apps/' + state.app.id + '/pages/' + pageId + '/functions'),
      ]);
      state.pageDetail = page;
      state.comments = comments || [];
      state.functions = fns || [];
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
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
    const pageList = (a.pages || []).map(p => {
      const isActive = p.id === state.selectedPageId;
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
              ${pageList || '<div style="padding:8px 14px;font-size:12px;color:#94a3b8">No pages yet</div>'}
              <div class="ap-add-page-btn" id="ap-add-page">+ Add page</div>
            </div>
          </aside>
          <section class="ap-page-pane">
            ${renderPagePane()}
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
        <div class="ap-tab ${t === 'preview' ? 'active' : ''}" data-tab="preview">Preview</div>
        <div class="ap-tab ${t === 'blueprint' ? 'active' : ''}" data-tab="blueprint">Blueprint</div>
        <div class="ap-tab ${t === 'qa' ? 'active' : ''}" data-tab="qa">Q&amp;A <span class="ap-tab-count">${state.comments.length}</span></div>
        <div class="ap-tab ${t === 'functions' ? 'active' : ''}" data-tab="functions">Functions <span class="ap-tab-count">${state.functions.length}</span></div>
      </div>
      <div class="ap-tab-body">
        ${t === 'preview' ? renderPreviewTab(p) : ''}
        ${t === 'blueprint' ? renderBlueprintTab(p) : ''}
        ${t === 'qa' ? renderQATab() : ''}
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
    return `
      <div class="ap-preview-toolbar">
        <span>Sandboxed preview of <strong>${escapeHtml(p.file_name || p.name)}</strong>${p.html_content ? ` · ${(p.html_content.length / 1024).toFixed(1)} KB` : ''}</span>
        <a href="${previewUrl}" target="_blank" rel="noopener" class="btn btn-ghost btn-small">Open in new tab ↗</a>
      </div>
      <div class="ap-preview-wrap">
        <iframe class="ap-preview-frame" src="${previewUrl}" sandbox="allow-same-origin" title="Page preview"></iframe>
      </div>
    `;
  }

  function renderBlueprintTab(p) {
    return `
      <div class="ap-blueprint-wrap">
        <div class="ap-blueprint-label">
          <div>
            <h3>Page blueprint</h3>
            <p>Plain-English description for the developer: what the page does, the main sections, the interactions, and the data it needs.</p>
          </div>
        </div>
        <textarea class="ap-blueprint-textarea" id="ap-blueprint-textarea" placeholder="Describe what this page does, the regions, interactions, and data needs.">${escapeHtml(p.blueprint || '')}</textarea>
        <div class="ap-blueprint-actions">
          <button class="btn btn-primary btn-small" id="ap-blueprint-save">Save</button>
          <button class="btn btn-secondary btn-small" id="ap-blueprint-ai">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>
            AI assist
          </button>
          <span class="ap-blueprint-saved" id="ap-blueprint-saved">Saved ✓</span>
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
      el.onclick = () => navigate('/' + state.app.id + '/p/' + el.getAttribute('data-page-id'));
    });

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
  }

  function bindBlueprintEvents() {
    const ta = document.getElementById('ap-blueprint-textarea');
    const saveBtn = document.getElementById('ap-blueprint-save');
    const aiBtn = document.getElementById('ap-blueprint-ai');
    const savedFlag = document.getElementById('ap-blueprint-saved');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        try {
          await api('PATCH', '/api/apps/' + state.app.id + '/pages/' + state.pageDetail.id, { blueprint: ta.value });
          state.pageDetail.blueprint = ta.value;
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
            // If the box already has content, append the AI draft so the
            // user's existing notes aren't destroyed. Otherwise just set.
            const cur = ta.value.trim();
            ta.value = cur ? (cur + '\n\n— AI draft —\n' + r.draft) : r.draft;
            toast('AI draft generated', 'ok');
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
