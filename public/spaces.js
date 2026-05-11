// ─────────────────────────────────────────────────────────────────────────────
// Spaces — workspace canvas (vanilla port of the React syruvia-lab feature)
//
// Self-contained module. Exposes a tiny `window.Spaces` API:
//   Spaces.openListView()       — show the list of spaces
//   Spaces.openSpace(id)        — show the canvas for one space
//   Spaces.mountPublic(token)   — bootstrap the unauthenticated viewer
//
// All state lives inside the module (closure-private). The list view and
// canvas view share a single #page-spaces container — we re-render its
// inner HTML each time. Cheap and matches the way the rest of the app
// works (renderTickets / renderKanban / etc.).
//
// Why one file: this is one feature. Keep the seams aligned with the
// feature boundary, not arbitrary file splits. ~1,500 lines is the cost
// of porting all the canvas + drag-resize + recording + share + public
// viewer logic from a React codebase to vanilla DOM.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const STICKY_COLORS = ['#FFE082', '#FFAB91', '#A5D6A7', '#90CAF9', '#CE93D8', '#FFCC80'];
  const COVER_COLORS  = ['#bf7325', '#1a559a', '#1e6e4a', '#8f4500', '#6b1e1e', '#4e4200', '#5a5a5a', '#7a3030'];

  // Size defaults per item type — keeps newly-added cards reasonable.
  function sizeFor(type) {
    return ({
      sticky:   { width: 220, height: 200 },
      note:     { width: 280, height: 200 },
      document: { width: 360, height: 320 },
      image:    { width: 280, height: 240 },
      video:    { width: 360, height: 260 },
      voice:    { width: 280, height: 120 },
      file:     { width: 260, height: 140 },
      link:     { width: 280, height: 140 },
      ticket:   { width: 280, height: 200 },
    })[type] || { width: 280, height: 200 };
  }

  // ── State (module-local) ───────────────────────────────────────────────
  const state = {
    spaces: [],          // list view rows
    space:  null,        // active space (canvas view)
    items:  [],          // active space items
    members: [],         // active space members
    role:   'viewer',
    activeSpaceId: null,
    publicToken: null,   // set when mounted via mountPublic()
    publicCanEdit: false,
    profiles: [],        // cached user directory for invites
  };

  // ── Helpers ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function attr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function toast(msg) {
    if (typeof settingsToast === 'function') { settingsToast(msg); return; }
    // Lightweight fallback when settingsToast isn't loaded (public viewer).
    let host = document.getElementById('sp-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'sp-toast-host';
      host.style.cssText = 'position:fixed;top:18px;right:18px;z-index:99999;display:flex;flex-direction:column;gap:6px;pointer-events:none';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.style.cssText = 'background:#0f172a;color:#fff;padding:8px 14px;border-radius:8px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;transform:translateY(-6px);transition:opacity .18s,transform .18s';
    el.textContent = msg;
    host.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-6px)'; setTimeout(() => el.remove(), 220); }, 2400);
  }

  function fmtDuration(secs) {
    const s = Math.max(0, Math.floor(secs || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtBytes(bytes) {
    const b = Number(bytes || 0);
    if (b < 1024) return b + ' B';
    const kb = b / 1024;
    if (kb < 1024) return kb.toFixed(0) + ' KB';
    return (kb / 1024).toFixed(1) + ' MB';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }
  function readFileAsDataURL(f) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error('Read failed'));
      r.readAsDataURL(f);
    });
  }

  // ── API client ─────────────────────────────────────────────────────────
  // In normal "authenticated" mode every call routes through /api/spaces/...
  // In public mode (mounted via /p/:token) item-edit requests go through
  // /api/spaces/public/:token/items/:itemId — set via state.publicToken.
  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) err = j.error; } catch {}
      throw new Error(err);
    }
    const ct = r.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) return r.json();
    return r.text();
  }

  // ── CRUD wrappers — match the lib/db.ts surface of the original ──────
  const db = {
    getSpaces:        ()       => api('GET',  '/api/spaces'),
    createSpace:      (input)  => api('POST', '/api/spaces', input),
    getSpace:         (id)     => api('GET',  '/api/spaces/' + id),
    updateSpace:      (id, p)  => api('PATCH','/api/spaces/' + id, p),
    deleteSpace:      (id)     => api('DELETE','/api/spaces/' + id),
    createSpaceItem:  (id, i)  => api('POST', '/api/spaces/' + id + '/items', i),
    updateSpaceItem:  (id, it, p) => api('PATCH', '/api/spaces/' + id + '/items/' + it, p),
    deleteSpaceItem:  (id, it) => api('DELETE', '/api/spaces/' + id + '/items/' + it),
    addSpaceMember:   (id, user_id, role) => api('POST', '/api/spaces/' + id + '/members', { user_id, role }),
    removeSpaceMember:(id, uid)=> api('DELETE','/api/spaces/' + id + '/members/' + uid),
    updateShareLink:  (id, p)  => api('PATCH','/api/spaces/' + id + '/share-link', p),
    getPublicSpace:   (tok)    => api('GET',  '/api/spaces/public/' + tok),
    updatePublicItem: (tok, it, p) => api('PATCH','/api/spaces/public/' + tok + '/items/' + it, p),
  };

  // Patch an item — uses the authenticated route normally, falls back to
  // the public route when the page is mounted via /p/:token.
  function patchItem(itemId, updates) {
    if (state.publicToken) return db.updatePublicItem(state.publicToken, itemId, updates);
    return db.updateSpaceItem(state.activeSpaceId, itemId, updates);
  }

  // ── Modal helper (vanilla, no React's Modal) ─────────────────────────
  // Reuses the existing .modal-overlay pattern from the main app so styles
  // and ESC-to-close keep working without extra wiring.
  function openModal({ title, body, footer, maxWidth }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:20000;display:flex;align-items:center;justify-content:center;padding:18px';
    overlay.innerHTML = `
      <div class="modal" style="background:#fff;border-radius:14px;padding:0;max-width:${maxWidth || 520}px;width:100%;max-height:90vh;display:flex;flex-direction:column;border:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:600">${esc(title || '')}</div>
          <button type="button" aria-label="Close" style="background:none;border:0;font-size:20px;cursor:pointer;color:var(--text3);line-height:1">×</button>
        </div>
        <div class="sp-modal-body" style="padding:16px 18px;overflow-y:auto;flex:1"></div>
        ${footer ? `<div class="sp-modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--border)"></div>` : ''}
      </div>
    `;
    const bodyEl = overlay.querySelector('.sp-modal-body');
    const footEl = overlay.querySelector('.sp-modal-footer');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);
    if (footer && footEl) {
      if (typeof footer === 'string') footEl.innerHTML = footer;
      else if (footer instanceof Node) footEl.appendChild(footer);
    }
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    overlay.querySelector('button[aria-label=Close]').onclick = close;
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return { overlay, bodyEl, footEl, close };
  }

  // ── List view ──────────────────────────────────────────────────────────
  async function openListView() {
    state.activeSpaceId = null;
    state.space = null;
    state.items = [];
    state.members = [];
    const host = document.getElementById('page-spaces');
    if (!host) return;
    host.innerHTML = `
      <div style="max-width:1200px;margin:0 auto">
        <div class="sp-header">
          <div>
            <h1>Spaces</h1>
            <p class="sp-sub">Workspaces for projects — gather tickets, notes, files, recordings on a freeform canvas.</p>
          </div>
          <button class="btn-primary" id="sp-new-btn" style="font-size:13px;padding:8px 14px;font-weight:600">+ New space</button>
        </div>
        <div id="sp-list-host"></div>
      </div>
    `;
    host.querySelector('#sp-new-btn').onclick = openCreateModal;
    const list = host.querySelector('#sp-list-host');
    list.innerHTML = '<div style="color:var(--text3);padding:24px">Loading…</div>';
    try {
      state.spaces = await db.getSpaces();
    } catch (e) {
      list.innerHTML = `<div style="color:#dc2626;padding:24px">Failed to load: ${esc(e.message)}</div>`;
      return;
    }
    if (!state.spaces.length) {
      list.innerHTML = `
        <div class="sp-empty">
          <div class="sp-empty-msg">You don't have any spaces yet.</div>
          <button class="btn-primary" id="sp-empty-create" style="font-size:13px;padding:8px 14px;font-weight:600">Create your first space</button>
        </div>
      `;
      list.querySelector('#sp-empty-create').onclick = openCreateModal;
      return;
    }
    list.innerHTML = `<div class="sp-grid">${state.spaces.map(renderSpaceCard).join('')}</div>`;
    // Wire each card's click + delete button
    list.querySelectorAll('.sp-card').forEach(card => {
      const id = Number(card.dataset.spaceId);
      card.onclick = (ev) => {
        if (ev.target.closest('.sp-card-delete')) return;
        openSpace(id);
      };
      const del = card.querySelector('.sp-card-delete');
      if (del) del.onclick = async (ev) => {
        ev.stopPropagation();
        const sp = state.spaces.find(s => s.id === id);
        if (!sp) return;
        if (!confirm(`Delete "${sp.name}"? This removes all items and cannot be undone.`)) return;
        try { await db.deleteSpace(id); toast('Space deleted'); openListView(); }
        catch (e) { toast(e.message || 'Delete failed'); }
      };
    });
  }

  function renderSpaceCard(s) {
    const me = window.CURRENT_USER || {};
    const isOwner = s.owner_id === me.id;
    return `
      <div class="sp-card" data-space-id="${s.id}">
        <div class="sp-card-cover" style="background:${attr(s.cover_color || '#bf7325')}">
          <span class="sp-card-role">${esc(isOwner ? 'Owner' : (s.role || 'Shared'))}</span>
          ${s.is_public ? `<span class="sp-card-pill" title="Public link enabled">LINK</span>` : ''}
        </div>
        <div class="sp-card-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="flex:1;min-width:0">
              <div class="sp-card-title">${esc(s.name)}</div>
              ${s.description ? `<div class="sp-card-desc">${esc(s.description)}</div>` : ''}
            </div>
            ${isOwner ? `<button class="sp-card-delete" title="Delete space" aria-label="Delete">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>` : ''}
          </div>
          <div class="sp-card-meta">
            <span>${s.item_count || 0} item${(s.item_count || 0) === 1 ? '' : 's'}</span>
            <span>•</span>
            <span>${esc(fmtDate(s.updated_at))}</span>
          </div>
        </div>
      </div>
    `;
  }

  function openCreateModal() {
    let name = ''; let description = ''; let color = COVER_COLORS[0]; let busy = false;
    const m = openModal({
      title: 'New space', maxWidth: 480,
      body: `
        <div style="display:flex;flex-direction:column;gap:14px">
          <label><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Name</div>
            <input type="text" id="sp-c-name" autofocus placeholder="Project Phoenix"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>
          </label>
          <label><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Description (optional)</div>
            <textarea id="sp-c-desc" rows="3" placeholder="What's this space for?"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;resize:vertical;font-family:inherit"></textarea>
          </label>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Cover colour</div>
            <div id="sp-c-colors" style="display:flex;gap:6px;flex-wrap:wrap">
              ${COVER_COLORS.map((c, i) => `
                <button type="button" data-color="${attr(c)}"
                  style="width:28px;height:28px;border-radius:50%;background:${attr(c)};border:${i === 0 ? '3px solid var(--text)' : '2px solid var(--border)'};cursor:pointer;padding:0"></button>
              `).join('')}
            </div>
          </div>
        </div>
      `,
      footer: `
        <button id="sp-c-cancel" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Cancel</button>
        <button id="sp-c-submit" class="btn-primary" style="padding:8px 14px;font-size:12.5px">Create space</button>
      `,
    });
    const nameEl = m.bodyEl.querySelector('#sp-c-name');
    const descEl = m.bodyEl.querySelector('#sp-c-desc');
    const submit = m.footEl.querySelector('#sp-c-submit');
    m.footEl.querySelector('#sp-c-cancel').onclick = m.close;
    m.bodyEl.querySelectorAll('#sp-c-colors button').forEach(btn => {
      btn.onclick = () => {
        color = btn.dataset.color;
        m.bodyEl.querySelectorAll('#sp-c-colors button').forEach(b => {
          b.style.border = b.dataset.color === color ? '3px solid var(--text)' : '2px solid var(--border)';
        });
      };
    });
    submit.onclick = async () => {
      if (busy) return;
      name = nameEl.value.trim();
      description = descEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      busy = true; submit.disabled = true; submit.textContent = 'Creating…';
      try {
        const created = await db.createSpace({ name, description: description || null, cover_color: color });
        m.close();
        openSpace(created.id);
      } catch (e) {
        toast(e.message || 'Failed to create space');
        busy = false; submit.disabled = false; submit.textContent = 'Create space';
      }
    };
    setTimeout(() => nameEl.focus(), 30);
  }

  // ── Canvas view ─────────────────────────────────────────────────────────
  async function openSpace(id) {
    state.activeSpaceId = id;
    const host = document.getElementById('page-spaces');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text3);padding:24px">Loading…</div>';
    try {
      const data = await db.getSpace(id);
      state.space = data;
      state.items = data.items || [];
      state.members = data.members || [];
      state.role = data.role || 'viewer';
    } catch (e) {
      host.innerHTML = `<div style="color:#dc2626;padding:24px">${esc(e.message || 'Failed to load space')}</div>`;
      return;
    }
    renderCanvasShell();
  }

  function canEdit() {
    if (state.publicToken) return state.publicCanEdit;
    if (!state.space) return false;
    const me = window.CURRENT_USER || {};
    if (state.space.owner_id === me.id) return true;
    return state.role === 'editor' || state.role === 'owner';
  }
  function isOwner() {
    if (state.publicToken) return false;
    if (!state.space) return false;
    const me = window.CURRENT_USER || {};
    return state.space.owner_id === me.id;
  }

  function renderCanvasShell() {
    const host = state.publicToken
      ? document.getElementById('public-space-root')
      : document.getElementById('page-spaces');
    if (!host) return;
    const space = state.space;
    if (state.publicToken) {
      host.innerHTML = `
        <div class="sp-public-shell">
          <div class="sp-public-header">
            <img src="/syruvia-logo.svg" alt="Syruvia" onerror="this.style.display='none'"/>
            <div class="sp-color-strip" style="background:${attr(space.cover_color || '#bf7325')};width:8px;height:22px;border-radius:3px"></div>
            <div class="sp-title-block">
              <div class="sp-title" style="font-size:14.5px;font-weight:600">${esc(space.name)}</div>
              <div style="font-size:11.5px;color:var(--text2)">Shared by ${esc(space.owner_name || 'a Syruvia user')} • ${canEdit() ? 'Editable link' : 'View-only'}</div>
            </div>
          </div>
          <div id="sp-canvas-host" class="sp-canvas"><div class="sp-canvas-inner" id="sp-canvas-inner"></div></div>
        </div>
      `;
    } else {
      host.innerHTML = `
        <div class="sp-canvas-shell">
          <div class="sp-canvas-toolbar" style="position:relative">
            <button class="sp-back" id="sp-back-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              Spaces
            </button>
            <div class="sp-color-strip" style="background:${attr(space.cover_color || '#bf7325')}"></div>
            <div class="sp-title-block">
              <div class="sp-title">${esc(space.name)}</div>
              ${space.description ? `<div class="sp-subtitle">${esc(space.description)}</div>` : ''}
            </div>
            ${!canEdit() ? `<span class="sp-view-only">View-only</span>` : ''}
            ${isOwner() ? `<button class="btn-sec" id="sp-edit-btn" style="font-size:12px;padding:6px 12px">Edit</button>` : ''}
            ${isOwner() ? `<button class="btn-sec" id="sp-share-btn" style="font-size:12px;padding:6px 12px">Share${space.is_public ? ' • Link on' : ''}</button>` : ''}
            ${canEdit() ? `<div style="position:relative">
              <button class="btn-primary" id="sp-add-btn" style="font-size:12px;padding:6px 14px">+ Add</button>
            </div>` : ''}
          </div>
          <div id="sp-canvas-host" class="sp-canvas"><div class="sp-canvas-inner" id="sp-canvas-inner"></div></div>
        </div>
      `;
      const back = host.querySelector('#sp-back-btn');
      if (back) back.onclick = openListView;
      const edit = host.querySelector('#sp-edit-btn');
      if (edit) edit.onclick = openEditModal;
      const share = host.querySelector('#sp-share-btn');
      if (share) share.onclick = openShareModal;
      const add = host.querySelector('#sp-add-btn');
      if (add) add.onclick = (ev) => { ev.stopPropagation(); toggleAddMenu(add); };
    }
    renderItems();
  }

  function renderItems() {
    const canvas = document.getElementById('sp-canvas-inner');
    if (!canvas) return;
    let html = '';
    if (state.items.length === 0 && !state.publicToken) {
      html += `
        <div class="sp-empty-canvas">
          <div class="ec-title">This space is empty.</div>
          <div class="ec-body">${canEdit() ? 'Click "+ Add" to drop in tickets, notes, files, recordings, and more.' : 'No items have been added yet.'}</div>
        </div>
      `;
    }
    for (const item of state.items) html += renderItemCard(item);
    canvas.innerHTML = html;
    // Wire each item's events
    for (const item of state.items) wireItem(item);
  }

  // ── Item card rendering ────────────────────────────────────────────────
  function labelFor(t) {
    return ({
      sticky: 'Sticky', note: 'Note', document: 'Document', image: 'Image',
      video: 'Video', voice: 'Voice', file: 'File', link: 'Link', ticket: 'Ticket',
    })[t] || 'Item';
  }
  function typeIcon(t) {
    const s = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    const path = ({
      sticky:   `<rect x="4" y="4" width="16" height="16" rx="2" ${s}/>`,
      note:     `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" ${s}/><polyline points="14 2 14 8 20 8" ${s}/>`,
      document: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" ${s}/><polyline points="14 2 14 8 20 8" ${s}/><line x1="8" y1="13" x2="16" y2="13" ${s}/><line x1="8" y1="17" x2="16" y2="17" ${s}/>`,
      image:    `<rect x="3" y="3" width="18" height="18" rx="2" ${s}/><circle cx="9" cy="9" r="2" ${s}/><polyline points="21 15 16 10 5 21" ${s}/>`,
      video:    `<polygon points="23 7 16 12 23 17 23 7" ${s}/><rect x="1" y="5" width="15" height="14" rx="2" ${s}/>`,
      voice:    `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" ${s}/><path d="M19 10v2a7 7 0 0 1-14 0v-2" ${s}/><line x1="12" y1="19" x2="12" y2="23" ${s}/>`,
      file:     `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" ${s}/><polyline points="7 10 12 15 17 10" ${s}/><line x1="12" y1="15" x2="12" y2="3" ${s}/>`,
      link:     `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" ${s}/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" ${s}/>`,
      ticket:   `<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" ${s}/><line x1="13" y1="5" x2="13" y2="19" ${s}/>`,
    })[t] || '';
    return `<svg width="12" height="12" viewBox="0 0 24 24">${path}</svg>`;
  }

  function renderItemCard(item) {
    const isSticky = item.type === 'sticky';
    const bg = isSticky ? (item.color || STICKY_COLORS[0]) : '#fff';
    const fg = isSticky ? '#222' : 'var(--text)';
    const cls = ['sp-item'];
    if (isSticky) cls.push('sp-item-sticky');
    return `
      <div class="${cls.join(' ')}" data-item-id="${item.id}"
           style="left:${item.position_x}px;top:${item.position_y}px;width:${item.width}px;height:${item.height}px;background:${attr(bg)};color:${fg};z-index:${item.z_index || 0}">
        <div class="sp-item-head" data-drag-handle="1">
          <div class="sp-item-label">${typeIcon(item.type)} ${esc(labelFor(item.type))}</div>
          ${canEdit() ? `<div style="position:relative">
            <button class="sp-item-more" data-more-btn="1" title="More">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
            </button>
          </div>` : ''}
        </div>
        <div class="sp-item-body">${renderItemBody(item)}</div>
        ${canEdit() ? `<div class="sp-resize-handle" data-resize-handle="1" title="Resize"></div>` : ''}
      </div>
    `;
  }

  function renderItemBody(item) {
    switch (item.type) {
      case 'sticky':
        return `<textarea class="sp-textarea" data-field="text" ${canEdit() ? '' : 'readonly'} placeholder="Write a note…">${esc(item.text || '')}</textarea>`;
      case 'note':
        return `
          <div class="sp-note-body">
            <input class="sp-input sp-title-input" data-field="title" value="${attr(item.title || '')}" placeholder="Title" ${canEdit() ? '' : 'readonly'}/>
            <textarea class="sp-textarea" data-field="text" ${canEdit() ? '' : 'readonly'} placeholder="Note body…">${esc(item.text || '')}</textarea>
          </div>
        `;
      case 'document':
        return `
          <div class="sp-doc-body">
            <input class="sp-input sp-title-input" data-field="title" value="${attr(item.title || '')}" placeholder="Document title" ${canEdit() ? '' : 'readonly'}/>
            <textarea class="sp-textarea" data-field="text" ${canEdit() ? '' : 'readonly'} placeholder="Start writing…">${esc(item.text || '')}</textarea>
          </div>
        `;
      case 'image':
        if (!item.data) return '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12px">No image data</div>';
        return `<div class="sp-media-img"><img src="${attr(item.data)}" alt="${attr(item.title || '')}"/>${item.title ? `<div class="sp-media-caption">${esc(item.title)}</div>` : ''}</div>`;
      case 'video':
        if (!item.data) return '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12px">No video data</div>';
        return `<div class="sp-media-video"><video src="${attr(item.data)}" controls></video><div class="sp-media-caption">${esc(item.title || 'Recording')}${item.duration ? ' • ' + fmtDuration(item.duration) : ''}</div></div>`;
      case 'voice':
        if (!item.data) return '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12px">No audio data</div>';
        return `<div class="sp-voice-body"><div style="font-size:12.5px;font-weight:600;color:var(--text)">${esc(item.title || 'Voice note')}</div><audio src="${attr(item.data)}" controls></audio>${item.duration ? `<div style="font-size:11px;color:var(--text2)">${fmtDuration(item.duration)}</div>` : ''}</div>`;
      case 'file':
        if (!item.data) return '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12px">No file</div>';
        return `
          <div class="sp-file-body" style="justify-content:space-between">
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--text);word-break:break-all">${esc(item.title || 'File')}</div>
              <div class="sp-file-meta">${esc(item.mime_type || 'application/octet-stream')} • ${esc(fmtBytes(item.size))}</div>
            </div>
            <a class="sp-download-btn" href="${attr(item.data)}" download="${attr(item.title || 'download')}">Download</a>
          </div>
        `;
      case 'link': {
        const safeUrl = (item.url || '#').startsWith('http') ? item.url : '#';
        return `
          <div class="sp-link-body">
            <input class="sp-input sp-title-input" data-field="title" value="${attr(item.title || '')}" placeholder="Link title" ${canEdit() ? '' : 'readonly'}/>
            <a href="${attr(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(item.url || '')}</a>
          </div>
        `;
      }
      case 'ticket': {
        let meta = {};
        if (item.ticket_meta) {
          if (typeof item.ticket_meta === 'string') {
            try { meta = JSON.parse(item.ticket_meta); } catch {}
          } else {
            meta = item.ticket_meta;
          }
        }
        const isExternal = meta.source === 'external';
        const status = meta.status || 'todo';
        const statusBg = ({ todo: '#f1f5f9', in_progress: '#e8f0fb', blocked: '#fdf0f0', done: '#e8f6ef' })[status] || '#f1f5f9';
        const statusFg = ({ todo: '#475569', in_progress: '#1a559a', blocked: '#6b1e1e', done: '#1e6e4a' })[status] || '#475569';
        const statusLabel = ({ todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' })[status] || status;
        return `
          <div class="sp-ticket-body">
            <div class="sp-ticket-statusrow">
              <span class="sp-ticket-statuspill" style="background:${attr(statusBg)};color:${attr(statusFg)}">${esc(statusLabel)}</span>
              ${isExternal && item.ticket_ref ? `<span class="sp-ticket-ref">${esc(item.ticket_ref)}</span>` : ''}
            </div>
            <input class="sp-input sp-title-input" data-field="title" value="${attr(item.title || '')}" placeholder="Ticket title" ${canEdit() ? '' : 'readonly'}/>
            ${!isExternal ? `<div style="display:flex;gap:6px"><select class="sp-ticket-status-select" data-ticket-status ${canEdit() ? '' : 'disabled'}>
              <option value="todo"${status === 'todo' ? ' selected' : ''}>To do</option>
              <option value="in_progress"${status === 'in_progress' ? ' selected' : ''}>In progress</option>
              <option value="blocked"${status === 'blocked' ? ' selected' : ''}>Blocked</option>
              <option value="done"${status === 'done' ? ' selected' : ''}>Done</option>
            </select></div>` : ''}
            ${meta.assignee ? `<div style="font-size:11.5px;color:var(--text2)">Assigned: ${esc(meta.assignee)}</div>` : ''}
            ${isExternal && item.ticket_ref && item.ticket_ref.startsWith('http') ? `<a class="sp-download-btn" href="${attr(item.ticket_ref)}" target="_blank" rel="noopener noreferrer">Open ticket</a>` : ''}
            ${isExternal && item.ticket_ref && !item.ticket_ref.startsWith('http') ? `<button class="sp-download-btn" data-open-ticket="${attr(item.ticket_ref)}" style="border:0;cursor:pointer">Open ticket</button>` : ''}
          </div>
        `;
      }
    }
    return '';
  }

  // ── Wire per-item events (drag, resize, inline edit) ───────────────────
  function wireItem(item) {
    const el = document.querySelector(`.sp-item[data-item-id="${item.id}"]`);
    if (!el) return;

    // Drag (from head)
    const head = el.querySelector('.sp-item-head');
    if (head && canEdit()) {
      head.addEventListener('mousedown', (ev) => {
        // Ignore drags that originated on the "more" button.
        if (ev.target.closest('[data-more-btn]')) return;
        ev.preventDefault();
        const rect = el.getBoundingClientRect();
        const canvas = el.parentElement.getBoundingClientRect();
        const ox = ev.clientX - rect.left;
        const oy = ev.clientY - rect.top;
        const startX = item.position_x; const startY = item.position_y;
        let dx = 0, dy = 0;
        el.classList.add('is-dragging');
        function onMove(e2) {
          dx = (e2.clientX - canvas.left) - ox - startX;
          dy = (e2.clientY - canvas.top) - oy - startY;
          el.style.left = Math.max(0, startX + dx) + 'px';
          el.style.top  = Math.max(0, startY + dy) + 'px';
        }
        function onUp() {
          el.classList.remove('is-dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          item.position_x = Math.max(0, startX + dx);
          item.position_y = Math.max(0, startY + dy);
          patchItem(item.id, { position_x: item.position_x, position_y: item.position_y })
            .catch(err => toast(err.message || 'Update failed'));
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // Resize (bottom-right corner)
    const handle = el.querySelector('[data-resize-handle]');
    if (handle && canEdit()) {
      handle.addEventListener('mousedown', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const startW = item.width; const startH = item.height;
        const sx = ev.clientX; const sy = ev.clientY;
        let nw = startW, nh = startH;
        el.classList.add('is-resizing');
        function onMove(e2) {
          nw = Math.max(160, startW + (e2.clientX - sx));
          nh = Math.max(100, startH + (e2.clientY - sy));
          el.style.width = nw + 'px';
          el.style.height = nh + 'px';
        }
        function onUp() {
          el.classList.remove('is-resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          item.width = nw; item.height = nh;
          patchItem(item.id, { width: nw, height: nh })
            .catch(err => toast(err.message || 'Update failed'));
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // More-menu
    const moreBtn = el.querySelector('[data-more-btn]');
    if (moreBtn && canEdit()) {
      moreBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showItemMenu(item, moreBtn);
      });
    }

    // Inline field commits (debounced).
    el.querySelectorAll('[data-field]').forEach(inp => {
      const field = inp.dataset.field;
      let last = inp.value;
      let timer = null;
      inp.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const val = inp.value;
          if (val === last) return;
          last = val;
          item[field] = val;
          patchItem(item.id, { [field]: val }).catch(err => toast(err.message || 'Update failed'));
        }, 500);
      });
    });

    // Ticket status select
    const tStatus = el.querySelector('[data-ticket-status]');
    if (tStatus) {
      tStatus.addEventListener('change', () => {
        let meta = {};
        if (item.ticket_meta && typeof item.ticket_meta === 'object') meta = { ...item.ticket_meta };
        else if (item.ticket_meta) { try { meta = JSON.parse(item.ticket_meta); } catch {} }
        meta.status = tStatus.value;
        item.ticket_meta = meta;
        patchItem(item.id, { ticket_meta: meta }).then(() => {
          // Repaint the status pill
          const el2 = document.querySelector(`.sp-item[data-item-id="${item.id}"] .sp-item-body`);
          if (el2) el2.innerHTML = renderItemBody(item);
          wireItem(item);
        }).catch(err => toast(err.message || 'Update failed'));
      });
    }

    // External-ticket "Open ticket" button — deep links into the local
    // ticket detail when the ref matches a TKT-#### pattern.
    const openTkt = el.querySelector('[data-open-ticket]');
    if (openTkt) {
      openTkt.addEventListener('click', () => {
        const ref = openTkt.dataset.openTicket;
        if (/^TKT-\d+/i.test(ref) && typeof openTicketDetail === 'function') openTicketDetail(ref.toUpperCase());
        else if (ref.startsWith('http')) window.open(ref, '_blank', 'noopener,noreferrer');
        else toast('Unknown ticket reference');
      });
    }
  }

  function showItemMenu(item, anchorBtn) {
    closeAllMenus();
    const menu = document.createElement('div');
    menu.className = 'sp-item-menu';
    menu.innerHTML = `
      ${item.type === 'sticky' ? `
        <div class="sp-item-sticky-swatches">
          ${STICKY_COLORS.map(c => `<button class="sp-item-swatch ${item.color === c ? 'active' : ''}" data-color="${attr(c)}" style="background:${attr(c)}" aria-label="${attr(c)}"></button>`).join('')}
        </div>
      ` : ''}
      <button class="sp-item-menu-btn danger" data-action="delete">Delete</button>
    `;
    anchorBtn.parentElement.appendChild(menu);
    menu.querySelectorAll('[data-color]').forEach(b => {
      b.onclick = () => {
        const c = b.dataset.color;
        item.color = c;
        patchItem(item.id, { color: c }).then(() => {
          const el = document.querySelector(`.sp-item[data-item-id="${item.id}"]`);
          if (el) el.style.background = c;
        }).catch(err => toast(err.message));
        menu.remove();
      };
    });
    menu.querySelector('[data-action=delete]').onclick = async () => {
      menu.remove();
      if (!confirm('Delete this item?')) return;
      try {
        await db.deleteSpaceItem(state.activeSpaceId, item.id);
        state.items = state.items.filter(i => i.id !== item.id);
        renderItems();
      } catch (e) { toast(e.message || 'Delete failed'); }
    };
    // Click-outside to close
    setTimeout(() => {
      document.addEventListener('click', function onClickAway(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', onClickAway); }
      });
    }, 30);
  }
  function closeAllMenus() {
    document.querySelectorAll('.sp-item-menu, .sp-add-menu').forEach(m => m.remove());
  }

  // ── Add menu + item creators ───────────────────────────────────────────
  function toggleAddMenu(anchor) {
    const existing = document.querySelector('.sp-add-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'sp-add-menu';
    const items = [
      { id: 'ticket',   label: 'Ticket',        desc: 'New or existing' },
      { id: 'sticky',   label: 'Sticky note',   desc: 'Quick reminder' },
      { id: 'note',     label: 'Text note',     desc: 'Plain note' },
      { id: 'document', label: 'Document',      desc: 'Long-form text' },
      { id: 'image',    label: 'Image',         desc: 'Upload picture' },
      { id: 'file',     label: 'File',          desc: 'Any file (≤25 MB)' },
      { id: 'voice',    label: 'Voice note',    desc: 'Record audio' },
      { id: 'video',    label: 'Screen video',  desc: 'Record screen' },
      { id: 'link',     label: 'Link',          desc: 'URL with title' },
    ];
    menu.innerHTML = items.map(it => `
      <button class="sp-add-item" data-add-type="${it.id}">
        <div class="ai-label">${esc(it.label)}</div>
        <div class="ai-desc">${esc(it.desc)}</div>
      </button>
    `).join('');
    anchor.parentElement.appendChild(menu);
    menu.querySelectorAll('[data-add-type]').forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const t = btn.dataset.addType;
        menu.remove();
        handleAdd(t);
      };
    });
    setTimeout(() => {
      document.addEventListener('click', function away(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', away); }
      });
    }, 30);
  }

  function nextPosition() {
    const n = state.items.length;
    return { x: 40 + ((n * 30) % 400), y: 80 + ((n * 30) % 300) };
  }

  async function handleAdd(type) {
    if (type === 'sticky') return doAdd({ type, text: '', color: STICKY_COLORS[0] });
    if (type === 'note') return doAdd({ type, title: 'Note', text: '' });
    if (type === 'document') return doAdd({ type, title: 'Untitled document', text: '' });
    if (type === 'link') return openLinkModal();
    if (type === 'ticket') return openTicketModal();
    if (type === 'image' || type === 'file') return openFilePicker(type);
    if (type === 'voice' || type === 'video') return openRecorderModal(type);
  }

  async function doAdd(input) {
    if (!canEdit()) return;
    const pos = nextPosition();
    const size = sizeFor(input.type);
    try {
      const created = await db.createSpaceItem(state.activeSpaceId, {
        position_x: pos.x, position_y: pos.y, width: size.width, height: size.height, ...input,
      });
      state.items.push(created);
      renderItems();
    } catch (e) { toast(e.message || 'Failed to add item'); }
  }

  function openFilePicker(type) {
    const inp = document.createElement('input');
    inp.type = 'file';
    if (type === 'image') inp.accept = 'image/*';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return;
      if (f.size > 25 * 1024 * 1024) { toast('Files must be under 25 MB.'); return; }
      try {
        const data = await readFileAsDataURL(f);
        await doAdd({ type, title: f.name, data, mime_type: f.type, size: f.size });
      } catch (e) { toast(e.message || 'Failed to read file'); }
    };
    inp.click();
  }

  function openLinkModal() {
    const m = openModal({
      title: 'Add link', maxWidth: 480,
      body: `
        <div style="display:flex;flex-direction:column;gap:10px">
          <label><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">URL</div>
            <input id="sp-l-url" type="url" autofocus placeholder="https://…" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>
          </label>
          <label><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Title (optional)</div>
            <input id="sp-l-title" type="text" placeholder="Display title" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>
          </label>
        </div>
      `,
      footer: `
        <button id="sp-l-cancel" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Cancel</button>
        <button id="sp-l-submit" class="btn-primary" style="padding:8px 14px;font-size:12.5px">Add link</button>
      `,
    });
    m.footEl.querySelector('#sp-l-cancel').onclick = m.close;
    m.footEl.querySelector('#sp-l-submit').onclick = async () => {
      const url = m.bodyEl.querySelector('#sp-l-url').value.trim();
      const title = m.bodyEl.querySelector('#sp-l-title').value.trim();
      if (!url) return;
      m.close();
      doAdd({ type: 'link', url, title: title || url });
    };
  }

  function openTicketModal() {
    let tab = 'new';
    const m = openModal({
      title: 'Add ticket', maxWidth: 520,
      body: `
        <div style="display:flex;gap:6px;margin-bottom:14px">
          <button class="btn-primary" data-tab="new" style="padding:6px 12px;font-size:12px">New ticket</button>
          <button class="btn-sec" data-tab="existing" style="padding:6px 12px;font-size:12px">Existing ticket</button>
        </div>
        <div id="sp-t-tab"></div>
      `,
      footer: `
        <button id="sp-t-cancel" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Cancel</button>
        <button id="sp-t-submit" class="btn-primary" style="padding:8px 14px;font-size:12.5px">Add ticket</button>
      `,
    });
    function fieldHtml(name, body, type) {
      return `<label style="display:block"><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">${esc(name)}</div>${body}</label>`;
    }
    function renderTab() {
      const host = m.bodyEl.querySelector('#sp-t-tab');
      m.bodyEl.querySelectorAll('[data-tab]').forEach(b => {
        b.className = b.dataset.tab === tab ? 'btn-primary' : 'btn-sec';
      });
      if (tab === 'new') {
        host.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:10px">
            ${fieldHtml('Title', `<input id="sp-t-title" autofocus placeholder="What's the work?" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>`)}
            ${fieldHtml('Status', `<select id="sp-t-status" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:#fff">
              <option value="todo">To do</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option>
            </select>`)}
            ${fieldHtml('Assignee (optional)', `<input id="sp-t-assignee" placeholder="Name" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>`)}
          </div>
        `;
      } else {
        host.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:10px">
            ${fieldHtml('Existing ticket ID or URL', `<input id="sp-t-extid" autofocus placeholder="TKT-1042 or https://…" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>`)}
            ${fieldHtml('Display title', `<input id="sp-t-exttitle" placeholder="Title shown on the card" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>`)}
            <div style="font-size:11.5px;color:var(--text2)">We'll store the reference; you can deep-link out from the card.</div>
          </div>
        `;
      }
    }
    m.bodyEl.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderTab(); });
    renderTab();
    m.footEl.querySelector('#sp-t-cancel').onclick = m.close;
    m.footEl.querySelector('#sp-t-submit').onclick = async () => {
      if (tab === 'new') {
        const title = m.bodyEl.querySelector('#sp-t-title').value.trim();
        if (!title) return;
        const status = m.bodyEl.querySelector('#sp-t-status').value;
        const assignee = m.bodyEl.querySelector('#sp-t-assignee').value.trim();
        m.close();
        doAdd({ type: 'ticket', title, ticket_meta: { status, assignee: assignee || null, source: 'inline' } });
      } else {
        const extId = m.bodyEl.querySelector('#sp-t-extid').value.trim();
        const extTitle = m.bodyEl.querySelector('#sp-t-exttitle').value.trim();
        if (!extId && !extTitle) return;
        m.close();
        doAdd({ type: 'ticket', title: extTitle || extId, ticket_ref: extId || null, ticket_meta: { source: 'external' } });
      }
    };
  }

  // ── Recording modal (voice + screen) ───────────────────────────────────
  function openRecorderModal(mode) {
    let recorder = null, stream = null;
    let chunks = [];
    let startedAt = 0;
    let elapsed = 0;
    let timer = null;
    let previewBlob = null;
    let previewUrl = null;
    let phase = 'idle';  // idle | recording | preview

    const m = openModal({
      title: mode === 'voice' ? 'Voice note' : 'Screen recording',
      maxWidth: 520,
      body: `<div id="sp-rec-body"></div>`,
      footer: `<div id="sp-rec-footer"></div>`,
    });

    function paint() {
      const body = m.bodyEl.querySelector('#sp-rec-body');
      const foot = m.footEl.querySelector('#sp-rec-footer');
      if (phase === 'recording') {
        body.innerHTML = `<div class="sp-rec-state"><div class="sp-rec-badge"><span class="sp-rec-dot"></span>Recording • ${fmtDuration(elapsed)}</div></div>`;
        foot.innerHTML = `<button id="sp-rec-cancel" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Cancel</button>
                         <button id="sp-rec-stop" class="btn-primary" style="padding:8px 14px;font-size:12.5px">Stop</button>`;
        foot.querySelector('#sp-rec-cancel').onclick = () => { cancel(); m.close(); };
        foot.querySelector('#sp-rec-stop').onclick = stop;
      } else if (phase === 'preview') {
        body.innerHTML = `<div class="sp-rec-preview">${mode === 'voice'
          ? `<audio src="${attr(previewUrl)}" controls></audio>`
          : `<video src="${attr(previewUrl)}" controls></video>`
        }<div class="sp-rec-meta">Duration ${fmtDuration(elapsed)} • ${((previewBlob && previewBlob.size) ? (previewBlob.size / 1024 / 1024).toFixed(2) : '0')} MB</div></div>`;
        foot.innerHTML = `<button id="sp-rec-retake" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Retake</button>
                         <button id="sp-rec-save" class="btn-primary" style="padding:8px 14px;font-size:12.5px">Save to space</button>`;
        foot.querySelector('#sp-rec-retake').onclick = () => { cleanupPreview(); phase = 'idle'; start(); };
        foot.querySelector('#sp-rec-save').onclick = save;
      } else {
        body.innerHTML = `<div style="color:var(--text2);font-size:13px;padding:6px">Requesting permission…</div>`;
        foot.innerHTML = `<button id="sp-rec-cancel" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Cancel</button>`;
        foot.querySelector('#sp-rec-cancel').onclick = m.close;
      }
    }

    async function start() {
      phase = 'idle'; chunks = []; elapsed = 0;
      paint();
      try {
        stream = mode === 'voice'
          ? await navigator.mediaDevices.getUserMedia({ audio: true })
          : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
        recorder.onstop = () => {
          previewBlob = new Blob(chunks, { type: recorder.mimeType || (mode === 'voice' ? 'audio/webm' : 'video/webm') });
          previewUrl = URL.createObjectURL(previewBlob);
          phase = 'preview';
          if (stream) stream.getTracks().forEach(t => t.stop());
          paint();
        };
        // If screen-share is stopped by browser UI, end the recording.
        stream.getVideoTracks().forEach(t => { t.onended = () => { if (recorder && recorder.state === 'recording') recorder.stop(); }; });
        recorder.start();
        startedAt = Date.now();
        timer = setInterval(() => { elapsed = Math.floor((Date.now() - startedAt) / 1000); paint(); }, 500);
        phase = 'recording'; paint();
      } catch (e) {
        body && (body.innerHTML = '');
        m.bodyEl.querySelector('#sp-rec-body').innerHTML = `<div style="color:#dc2626;padding:6px;font-size:13px">Could not start recording: ${esc(e.message || 'permission denied')}</div>`;
      }
    }

    function stop() {
      if (recorder && recorder.state === 'recording') recorder.stop();
      if (timer) { clearInterval(timer); timer = null; }
    }

    function cancel() {
      if (recorder && recorder.state === 'recording') { recorder.stop(); }
      if (timer) clearInterval(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      cleanupPreview();
    }
    function cleanupPreview() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null; previewBlob = null;
    }

    async function save() {
      if (!previewBlob) return;
      if (previewBlob.size > 25 * 1024 * 1024) { toast('Recording exceeds 25 MB — try a shorter capture.'); return; }
      let data;
      try {
        data = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(new Error('Read failed'));
          r.readAsDataURL(previewBlob);
        });
      } catch (e) { toast(e.message || 'Read failed'); return; }
      m.close();
      cleanupPreview();
      await doAdd({
        type: mode,
        title: mode === 'voice' ? 'Voice note' : 'Screen recording',
        data, mime_type: previewBlob.type, size: previewBlob.size, duration: elapsed,
      });
    }

    start();
  }

  // ── Edit-meta modal ────────────────────────────────────────────────────
  function openEditModal() {
    if (!state.space) return;
    let name = state.space.name;
    let description = state.space.description || '';
    let color = state.space.cover_color || COVER_COLORS[0];
    const m = openModal({
      title: 'Edit space', maxWidth: 480,
      body: `
        <div style="display:flex;flex-direction:column;gap:12px">
          <label><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Name</div>
            <input id="sp-e-name" value="${attr(name)}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px"/>
          </label>
          <label><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Description</div>
            <textarea id="sp-e-desc" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;resize:vertical;font-family:inherit">${esc(description)}</textarea>
          </label>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Cover colour</div>
            <div id="sp-e-colors" style="display:flex;gap:6px;flex-wrap:wrap">
              ${COVER_COLORS.map(c => `<button type="button" data-color="${attr(c)}"
                style="width:28px;height:28px;border-radius:50%;background:${attr(c)};border:${color === c ? '3px solid var(--text)' : '2px solid var(--border)'};cursor:pointer;padding:0"></button>`).join('')}
            </div>
          </div>
        </div>
      `,
      footer: `
        <button id="sp-e-cancel" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Cancel</button>
        <button id="sp-e-save" class="btn-primary" style="padding:8px 14px;font-size:12.5px">Save</button>
      `,
    });
    m.bodyEl.querySelectorAll('#sp-e-colors button').forEach(b => {
      b.onclick = () => {
        color = b.dataset.color;
        m.bodyEl.querySelectorAll('#sp-e-colors button').forEach(x => {
          x.style.border = x.dataset.color === color ? '3px solid var(--text)' : '2px solid var(--border)';
        });
      };
    });
    m.footEl.querySelector('#sp-e-cancel').onclick = m.close;
    m.footEl.querySelector('#sp-e-save').onclick = async () => {
      name = m.bodyEl.querySelector('#sp-e-name').value.trim();
      description = m.bodyEl.querySelector('#sp-e-desc').value.trim();
      if (!name) return;
      try {
        const updated = await db.updateSpace(state.space.id, { name, description: description || null, cover_color: color });
        Object.assign(state.space, updated);
        m.close();
        renderCanvasShell();
      } catch (e) { toast(e.message || 'Failed to save'); }
    };
  }

  // ── Share modal (per-user invites + public link) ───────────────────────
  async function openShareModal() {
    if (!state.space) return;
    // Make sure we have a fresh profiles list for the invite dropdown.
    // Reuses the existing /api/team workspace directory.
    if (!state.profiles.length) {
      try {
        const rows = await api('GET', '/api/team');
        state.profiles = (Array.isArray(rows) ? rows : []).map(r => ({
          id: r.id, name: r.name, email: r.email,
        }));
      } catch {}
    }
    const m = openModal({
      title: 'Share space', maxWidth: 620,
      body: `<div id="sp-share-body"></div>`,
    });
    function repaint() {
      const me = window.CURRENT_USER || {};
      const sp = state.space;
      const members = state.members || [];
      const memberIds = new Set(members.map(x => x.user_id));
      const candidates = (state.profiles || []).filter(p => p.id !== me.id && !memberIds.has(p.id));
      const linkUrl = sp.public_token ? (location.origin + '/p/' + sp.public_token) : null;
      m.bodyEl.querySelector('#sp-share-body').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:18px">
          <section class="sp-share-section">
            <h3>People with access</h3>
            <div class="sp-share-roster">
              <div class="sr-row"><div><div class="sr-label">${esc(sp.owner_name || 'Owner')}</div><div class="sr-sub">Owner</div></div></div>
              ${members.map(mb => `<div class="sr-row" data-uid="${mb.user_id}">
                <div><div class="sr-label">${esc(mb.user_name || mb.user_id)}</div><div class="sr-sub">${esc(mb.role === 'editor' ? 'Editor' : 'Viewer')}</div></div>
                <button class="btn-sec sp-remove" style="font-size:12px;padding:5px 12px">Remove</button>
              </div>`).join('')}
              ${members.length === 0 ? '<div style="padding:10px;font-size:12px;color:var(--text3)">Only you have access.</div>' : ''}
            </div>
            <div class="sp-share-invite">
              <select id="sp-invite-id">
                <option value="">Invite a user…</option>
                ${candidates.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.email || '')})</option>`).join('')}
              </select>
              <select id="sp-invite-role" style="width:110px;font-size:12.5px;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:#fff">
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button id="sp-invite-btn" class="btn-primary" style="font-size:12px;padding:6px 12px">Invite</button>
            </div>
          </section>
          <section class="sp-share-section">
            <h3>Public link</h3>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text)">
              <input type="checkbox" id="sp-pub-enable" ${sp.is_public ? 'checked' : ''}/>
              Anyone with the link can view this space
            </label>
            ${sp.is_public ? `
              <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--text)">
                <input type="checkbox" id="sp-pub-edit" ${sp.public_can_edit ? 'checked' : ''}/>
                Allow link viewers to edit
              </label>
              ${linkUrl ? `<div class="sp-share-link">
                <input id="sp-pub-link" readonly value="${attr(linkUrl)}"/>
                <button id="sp-pub-copy" class="btn-sec" style="font-size:11.5px;padding:5px 12px">Copy</button>
                <button id="sp-pub-regen" class="btn-sec" style="font-size:11.5px;padding:5px 12px">Regenerate</button>
              </div>` : ''}
            ` : ''}
          </section>
        </div>
      `;
      m.bodyEl.querySelectorAll('.sp-remove').forEach(btn => {
        btn.onclick = async () => {
          const uid = Number(btn.closest('[data-uid]').dataset.uid);
          try {
            await db.removeSpaceMember(state.space.id, uid);
            state.members = state.members.filter(x => x.user_id !== uid);
            repaint();
          } catch (e) { toast(e.message || 'Failed to remove'); }
        };
      });
      m.bodyEl.querySelector('#sp-invite-btn').onclick = async () => {
        const userId = Number(m.bodyEl.querySelector('#sp-invite-id').value);
        const role = m.bodyEl.querySelector('#sp-invite-role').value;
        if (!userId) return;
        try {
          const member = await db.addSpaceMember(state.space.id, userId, role);
          // Replace any existing member entry for this user
          state.members = state.members.filter(x => x.user_id !== userId).concat(member);
          repaint();
        } catch (e) { toast(e.message || 'Failed to invite'); }
      };
      const enable = m.bodyEl.querySelector('#sp-pub-enable');
      if (enable) {
        enable.onchange = async () => {
          try {
            const updated = await db.updateShareLink(state.space.id, { enabled: enable.checked });
            Object.assign(state.space, updated);
            repaint();
            renderCanvasShell();
          } catch (e) { toast(e.message || 'Failed to update link'); }
        };
      }
      const pubEdit = m.bodyEl.querySelector('#sp-pub-edit');
      if (pubEdit) {
        pubEdit.onchange = async () => {
          try {
            const updated = await db.updateShareLink(state.space.id, { can_edit: pubEdit.checked });
            Object.assign(state.space, updated);
            repaint();
          } catch (e) { toast(e.message || 'Failed to update link'); }
        };
      }
      const copyBtn = m.bodyEl.querySelector('#sp-pub-copy');
      if (copyBtn) copyBtn.onclick = () => {
        const link = m.bodyEl.querySelector('#sp-pub-link');
        link.select();
        try { navigator.clipboard.writeText(link.value); toast('Link copied'); } catch { document.execCommand('copy'); toast('Link copied'); }
      };
      const regen = m.bodyEl.querySelector('#sp-pub-regen');
      if (regen) regen.onclick = async () => {
        if (!confirm('Regenerate link? The current link will stop working.')) return;
        try {
          const updated = await db.updateShareLink(state.space.id, { enabled: true, regenerate: true });
          Object.assign(state.space, updated);
          repaint();
          renderCanvasShell();
        } catch (e) { toast(e.message || 'Failed to regenerate'); }
      };
    }
    repaint();
  }

  // ── Public-viewer bootstrap ────────────────────────────────────────────
  async function mountPublic(token) {
    state.publicToken = token;
    const root = document.getElementById('public-space-root');
    if (!root) return;
    root.innerHTML = '<div class="sp-public-fullpage">Loading…</div>';
    try {
      const data = await db.getPublicSpace(token);
      state.space = data;
      state.items = data.items || [];
      state.publicCanEdit = !!data.public_can_edit;
      renderCanvasShell();
    } catch (e) {
      root.innerHTML = '<div class="sp-public-fullpage">This space is not available.</div>';
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.Spaces = {
    openListView,
    openSpace,
    mountPublic,
  };
})();
