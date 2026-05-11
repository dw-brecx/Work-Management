// ─────────────────────────────────────────────────────────────────────────────
// Spaces — workspace canvas (vanilla port of the React syruvia-lab feature)
//
// Self-contained module. Exposes a tiny `window.Spaces` API:
//   Spaces.openListView()       — show the list of spaces
//   Spaces.openSpace(id)        — show the canvas for one space
//   Spaces.mountPublic(token)   — bootstrap the unauthenticated viewer
//
// Per-space URLs: openSpace pushes /spaces/<id>; openListView pushes /spaces.
// The router IIFE in index.html resolves /spaces/<id> back to openSpace(id).
//
// Companion modules:
//   /space-chat.js — per-space chat drawer (window.SpaceChat). Opened from
//   the "💬 Chat" button in the canvas toolbar.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Sticky-note paper colours.
  const STICKY_COLORS = [
    '#FFE082', '#FFAB91', '#A5D6A7', '#90CAF9', '#CE93D8', '#FFCC80',
    '#F8BBD0', '#B2EBF2', '#DCE775',
  ];
  // Vivid cover gradients for list-view cards. JS picks one per space (by id).
  const COVER_COLORS = [
    '#bf7325', '#1a559a', '#1e6e4a', '#8f4500', '#6b1e1e', '#4e4200',
    '#5a5a5a', '#7a3030', '#7c3aed', '#0891b2', '#db2777',
  ];

  // Cover gradient pair lookups — keys are the eight legacy COVER_COLORS so
  // older spaces keep visual continuity.
  const COVER_GRADIENT = {
    '#bf7325': ['#f59e0b', '#dc2626'],
    '#1a559a': ['#0ea5e9', '#6366f1'],
    '#1e6e4a': ['#10b981', '#0891b2'],
    '#8f4500': ['#fb923c', '#b45309'],
    '#6b1e1e': ['#f43f5e', '#7c2d12'],
    '#4e4200': ['#eab308', '#65a30d'],
    '#5a5a5a': ['#64748b', '#1e293b'],
    '#7a3030': ['#ef4444', '#831843'],
    '#7c3aed': ['#a855f7', '#ec4899'],
    '#0891b2': ['#22d3ee', '#1d4ed8'],
    '#db2777': ['#f472b6', '#a21caf'],
  };

  // Per-type colour + emoji + nice label. Drives:
  //   - the left-edge accent ribbon on each card
  //   - the rounded type-label chip in the card head
  //   - the icon shown in the "+ Add" menu
  const ITEM_PALETTE = {
    sticky:   { emoji: '🟡', label: 'Sticky',   accent: '#f59e0b', accentSoft: '#fef3c7', accentDark: '#92400e' },
    note:     { emoji: '📝', label: 'Note',     accent: '#fb923c', accentSoft: '#ffedd5', accentDark: '#9a3412' },
    document: { emoji: '📄', label: 'Document', accent: '#10b981', accentSoft: '#d1fae5', accentDark: '#065f46' },
    image:    { emoji: '🖼️', label: 'Image',    accent: '#0ea5e9', accentSoft: '#e0f2fe', accentDark: '#075985' },
    video:    { emoji: '🎬', label: 'Video',    accent: '#8b5cf6', accentSoft: '#ede9fe', accentDark: '#5b21b6' },
    voice:    { emoji: '🎙️', label: 'Voice',    accent: '#ef4444', accentSoft: '#fee2e2', accentDark: '#991b1b' },
    file:     { emoji: '📎', label: 'File',     accent: '#eab308', accentSoft: '#fef9c3', accentDark: '#854d0e' },
    link:     { emoji: '🔗', label: 'Link',     accent: '#14b8a6', accentSoft: '#ccfbf1', accentDark: '#0f766e' },
    ticket:   { emoji: '🎟️', label: 'Ticket',   accent: '#ec4899', accentSoft: '#fce7f3', accentDark: '#9d174d' },
  };

  function paletteFor(type) {
    return ITEM_PALETTE[type] || ITEM_PALETTE.note;
  }

  // Deterministic tilt for sticky notes — same id always gets the same tilt
  // so they don't jump on refresh. ±2.5 degrees feels playful but not chaotic.
  function tiltForId(id) {
    const n = Number(id) || 0;
    return (((n * 37) % 11) - 5) * 0.5;  // -2.5° … +2.5° in 0.5° steps
  }

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
    spaces: [],
    space:  null,
    items:  [],
    members: [],
    role:   'viewer',
    activeSpaceId: null,
    publicToken: null,
    publicCanEdit: false,
    profiles: [],
    ticketsCache: null,    // [{id,title,status,priority,assignee}] — loaded on first ticket-picker open
    // Whiteboard (freeform pen-drawing layer on top of the canvas).
    strokes: [],           // [{id, color, width, points: [[x,y],...]}, ...]
    penMode: false,
    penColor: '#111111',
    penWidth: 3,
    activeStrokePoints: null, // in-progress stroke during mousedown→up
  };

  // ── Helpers ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function attr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function toast(msg) {
    if (typeof settingsToast === 'function') { settingsToast(msg); return; }
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

  // Push the per-space URL so each space gets a shareable address.
  function pushSpaceUrl(id) {
    try {
      const path = id ? ('/spaces/' + id) : '/spaces';
      if (location.pathname === path) return;
      history.pushState({ page: 'spaces', spaceId: id || null }, '', path);
    } catch {}
  }

  // ── API client ─────────────────────────────────────────────────────────
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
    getTicketPicker:  ()       => api('GET',  '/api/spaces-ticket-picker'),
    saveWhiteboard:   (id, strokes) => api('PATCH', '/api/spaces/' + id + '/whiteboard', { strokes }),
  };

  function patchItem(itemId, updates) {
    if (state.publicToken) return db.updatePublicItem(state.publicToken, itemId, updates);
    return db.updateSpaceItem(state.activeSpaceId, itemId, updates);
  }

  // ── Modal helper ──────────────────────────────────────────────────────
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
    pushSpaceUrl(null);
    const host = document.getElementById('page-spaces');
    if (!host) return;
    host.innerHTML = `
      <div style="max-width:1200px;margin:0 auto">
        <div class="sp-header">
          <div>
            <h1>Spaces</h1>
            <p class="sp-sub">Drop tickets, notes, files, recordings — anything — onto a freeform canvas.</p>
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
          <div class="sp-empty-emoji">✨</div>
          <div class="sp-empty-msg">No spaces yet. Make your first one!</div>
          <button class="btn-primary" id="sp-empty-create" style="font-size:13px;padding:8px 14px;font-weight:600">Create your first space</button>
        </div>
      `;
      list.querySelector('#sp-empty-create').onclick = openCreateModal;
      return;
    }
    list.innerHTML = `<div class="sp-grid">${state.spaces.map(renderSpaceCard).join('')}</div>`;
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

  function coverGradient(cover) {
    const pair = COVER_GRADIENT[cover] || ['#7c3aed', '#ec4899'];
    return `linear-gradient(135deg, ${pair[0]} 0%, ${pair[1]} 100%)`;
  }
  // Fun emoji for each space — picked from a small bag indexed by id so it's
  // stable across refresh. Keeps the list view visually distinct.
  const SPACE_EMOJIS = ['🚀', '✨', '🌟', '🎨', '🎯', '🌈', '🔥', '💎', '🌸', '🍀', '🌊', '⚡'];
  function emojiForSpace(s) { return SPACE_EMOJIS[(Number(s.id) || 0) % SPACE_EMOJIS.length]; }

  function renderSpaceCard(s) {
    const me = window.CURRENT_USER || {};
    const isOwner = s.owner_id === me.id;
    return `
      <div class="sp-card" data-space-id="${s.id}">
        <div class="sp-card-cover" style="background:${coverGradient(s.cover_color || '#bf7325')}">
          <span class="sp-card-role">${esc(isOwner ? 'Owner' : (s.role || 'Shared'))}</span>
          ${s.is_public ? `<span class="sp-card-pill" title="Public link enabled">LINK</span>` : ''}
          <span class="sp-card-cover-emoji" aria-hidden="true">${emojiForSpace(s)}</span>
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
    let name = ''; let description = ''; let color = COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)]; let busy = false;
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
            <div id="sp-c-colors" style="display:flex;gap:8px;flex-wrap:wrap">
              ${COVER_COLORS.map(c => `
                <button type="button" data-color="${attr(c)}"
                  style="width:30px;height:30px;border-radius:50%;background:${coverGradient(c)};border:${c === color ? '3px solid var(--text)' : '2px solid var(--border)'};cursor:pointer;padding:0"></button>
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
    pushSpaceUrl(id);
    const host = document.getElementById('page-spaces');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text3);padding:24px">Loading…</div>';
    try {
      const data = await db.getSpace(id);
      state.space = data;
      state.items = data.items || [];
      state.members = data.members || [];
      state.role = data.role || 'viewer';
      state.strokes = Array.isArray(data.whiteboard_strokes) ? data.whiteboard_strokes : [];
      state.penMode = false;
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
            <div class="sp-color-strip" style="background:${coverGradient(space.cover_color || '#bf7325')};width:10px;height:24px;border-radius:4px"></div>
            <div class="sp-title-block">
              <div class="sp-title" style="font-size:15px;font-weight:700">${esc(space.name)}</div>
              <div style="font-size:11.5px;color:var(--text2)">Shared by ${esc(space.owner_name || 'a Syruvia user')} • ${canEdit() ? 'Editable link' : 'View-only'}</div>
            </div>
          </div>
          <div id="sp-canvas-host" class="sp-canvas">
            <div class="sp-canvas-inner" id="sp-canvas-inner">
              <svg id="sp-whiteboard" class="sp-whiteboard" width="3200" height="2400" viewBox="0 0 3200 2400" xmlns="http://www.w3.org/2000/svg"></svg>
            </div>
          </div>
        </div>
      `;
    } else {
      host.innerHTML = `
        <div class="sp-canvas-shell${state.penMode ? ' is-pen-mode' : ''}" id="sp-canvas-shell">
          <div class="sp-canvas-toolbar" style="position:relative">
            <button class="sp-back" id="sp-back-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              Spaces
            </button>
            <div class="sp-color-strip" style="background:${coverGradient(space.cover_color || '#bf7325')}"></div>
            <div class="sp-title-block">
              <div class="sp-title">${esc(space.name)}</div>
              ${space.description ? `<div class="sp-subtitle">${esc(space.description)}</div>` : ''}
            </div>
            ${!canEdit() ? `<span class="sp-view-only">View-only</span>` : ''}
            <button class="btn-sec" id="sp-chat-btn" style="font-size:12px;padding:6px 12px">💬 Chat</button>
            ${canEdit() ? `<button class="btn-sec${state.penMode ? ' is-active' : ''}" id="sp-pen-btn" style="font-size:12px;padding:6px 12px">✏️ Pen</button>` : ''}
            <button class="btn-sec" id="sp-copy-link-btn" title="Copy a link to this space" style="font-size:12px;padding:6px 12px">🔗 Copy link</button>
            ${isOwner() ? `<button class="btn-sec" id="sp-edit-btn" style="font-size:12px;padding:6px 12px">Edit</button>` : ''}
            ${isOwner() ? `<button class="btn-sec" id="sp-share-btn" style="font-size:12px;padding:6px 12px">Share</button>` : ''}
            ${canEdit() ? `<div style="position:relative">
              <button class="btn-primary" id="sp-add-btn" style="font-size:12px;padding:6px 14px">+ Add</button>
            </div>` : ''}
          </div>
          <div id="sp-canvas-host" class="sp-canvas">
            <div class="sp-canvas-inner" id="sp-canvas-inner">
              <svg id="sp-whiteboard" class="sp-whiteboard" width="3200" height="2400" viewBox="0 0 3200 2400" xmlns="http://www.w3.org/2000/svg"></svg>
            </div>
          </div>
          ${canEdit() ? renderPenToolbar() : ''}
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
      const chatBtn = host.querySelector('#sp-chat-btn');
      if (chatBtn) chatBtn.onclick = () => {
        if (window.SpaceChat) window.SpaceChat.open(state.activeSpaceId);
        else toast('Chat module not loaded yet — try refreshing.');
      };
      const copyBtn = host.querySelector('#sp-copy-link-btn');
      if (copyBtn) copyBtn.onclick = () => {
        const url = location.origin + '/spaces/' + state.activeSpaceId;
        try { navigator.clipboard.writeText(url); toast('Space link copied'); }
        catch { toast(url); }
      };
      const penBtn = host.querySelector('#sp-pen-btn');
      if (penBtn) penBtn.onclick = () => togglePenMode();
    }
    renderItems();
    wirePenToolbar();
    wireWhiteboardDrawing();
  }

  function renderItems() {
    const canvas = document.getElementById('sp-canvas-inner');
    if (!canvas) return;
    // Preserve the whiteboard SVG across re-renders — innerHTML would
    // otherwise blow away strokes mid-session.
    const svg = canvas.querySelector('#sp-whiteboard');
    let html = '';
    if (state.items.length === 0 && !state.publicToken) {
      html += `
        <div class="sp-empty-canvas">
          <div class="ec-emoji">🪄</div>
          <div class="ec-title">A blank canvas — let's fill it.</div>
          <div class="ec-body">${canEdit() ? 'Click <strong>+ Add</strong> to drop in tickets, sticky notes, files, voice notes, screen recordings, and more. Press <strong>✏️ Pen</strong> to scribble freehand on top, and paste images straight from the clipboard.' : 'No items have been added yet.'}</div>
        </div>
      `;
    }
    for (const item of state.items) html += renderItemCard(item);
    canvas.innerHTML = html;
    if (svg) canvas.appendChild(svg);
    for (const item of state.items) wireItem(item);
    renderStrokes();
  }

  // ── Whiteboard ─────────────────────────────────────────────────────────
  // Drawings live in an SVG layer that sits inside the same 3200×2400 canvas
  // as item cards. Each stroke is one <path>. We re-render all strokes on
  // every change — cheap, and avoids juggling references.
  const PEN_COLORS = ['#111111', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];
  const PEN_WIDTHS = [
    { label: 'Thin', value: 2 },
    { label: 'Med',  value: 4 },
    { label: 'Thick', value: 8 },
  ];

  function renderPenToolbar() {
    if (!state.penMode) return '';
    return `
      <div class="sp-pen-toolbar" id="sp-pen-toolbar">
        <div class="sp-pen-swatches">
          ${PEN_COLORS.map(c => `<button class="sp-pen-swatch${c === state.penColor ? ' is-active' : ''}" data-pen-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
        </div>
        <div class="sp-pen-widths">
          ${PEN_WIDTHS.map(w => `<button class="sp-pen-width${w.value === state.penWidth ? ' is-active' : ''}" data-pen-width="${w.value}">${w.label}</button>`).join('')}
        </div>
        <button class="sp-pen-action" data-pen-action="undo" title="Undo last stroke">↶ Undo</button>
        <button class="sp-pen-action" data-pen-action="clear" title="Erase the whole board">Clear</button>
        <button class="sp-pen-action sp-pen-exit" data-pen-action="exit" title="Leave pen mode">Done</button>
      </div>
    `;
  }

  function strokesToSvgPath(points) {
    if (!points || points.length === 0) return '';
    let d = 'M ' + points[0][0] + ' ' + points[0][1];
    for (let i = 1; i < points.length; i++) d += ' L ' + points[i][0] + ' ' + points[i][1];
    return d;
  }

  function renderStrokes() {
    const svg = document.getElementById('sp-whiteboard');
    if (!svg) return;
    let html = '';
    for (const s of (state.strokes || [])) {
      html += `<path d="${attr(strokesToSvgPath(s.points))}" stroke="${attr(s.color || '#111')}" stroke-width="${Number(s.width) || 3}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    }
    // Append the in-progress stroke (not yet saved) so it shows as the user drags.
    if (state.activeStrokePoints && state.activeStrokePoints.length) {
      html += `<path d="${attr(strokesToSvgPath(state.activeStrokePoints))}" stroke="${attr(state.penColor)}" stroke-width="${state.penWidth}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    }
    svg.innerHTML = html;
  }

  function wirePenToolbar() {
    const tb = document.getElementById('sp-pen-toolbar');
    if (!tb) return;
    tb.querySelectorAll('[data-pen-color]').forEach(b => {
      b.onclick = () => {
        state.penColor = b.dataset.penColor;
        tb.querySelectorAll('[data-pen-color]').forEach(x => x.classList.toggle('is-active', x.dataset.penColor === state.penColor));
      };
    });
    tb.querySelectorAll('[data-pen-width]').forEach(b => {
      b.onclick = () => {
        state.penWidth = Number(b.dataset.penWidth) || 4;
        tb.querySelectorAll('[data-pen-width]').forEach(x => x.classList.toggle('is-active', Number(x.dataset.penWidth) === state.penWidth));
      };
    });
    tb.querySelector('[data-pen-action=undo]').onclick = async () => {
      if (!state.strokes.length) return;
      state.strokes.pop();
      renderStrokes();
      saveWhiteboard();
    };
    tb.querySelector('[data-pen-action=clear]').onclick = async () => {
      if (!state.strokes.length) return;
      if (!confirm('Erase the whole whiteboard?')) return;
      state.strokes = [];
      renderStrokes();
      saveWhiteboard();
    };
    tb.querySelector('[data-pen-action=exit]').onclick = () => togglePenMode(false);
  }

  function togglePenMode(force) {
    const next = (typeof force === 'boolean') ? force : !state.penMode;
    state.penMode = next;
    // Re-render the canvas shell so the toolbar + the is-pen-mode class
    // flip together. Cheaper than fiddling individual classes.
    renderCanvasShell();
  }

  // Save the current stroke list to the server. Debounced so rapid undos
  // don't fire a request per click.
  let _whiteboardSaveTimer = null;
  function saveWhiteboard() {
    if (state.publicToken) return; // public viewer can't save (no auth)
    clearTimeout(_whiteboardSaveTimer);
    _whiteboardSaveTimer = setTimeout(async () => {
      try { await db.saveWhiteboard(state.activeSpaceId, state.strokes); }
      catch (e) { toast('Whiteboard save failed: ' + (e.message || 'unknown')); }
    }, 300);
  }

  function wireWhiteboardDrawing() {
    const svg = document.getElementById('sp-whiteboard');
    if (!svg) return;
    if (!state.penMode || !canEdit()) return;
    svg.addEventListener('mousedown', onPenDown);
    function onPenDown(ev) {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const startX = ev.clientX - rect.left;
      const startY = ev.clientY - rect.top;
      state.activeStrokePoints = [[startX, startY]];
      renderStrokes();
      function onMove(e2) {
        const r2 = svg.getBoundingClientRect();
        const x = e2.clientX - r2.left;
        const y = e2.clientY - r2.top;
        const pts = state.activeStrokePoints;
        const last = pts[pts.length - 1];
        // Skip near-duplicate points so the path stays small.
        if (Math.abs(last[0] - x) < 1 && Math.abs(last[1] - y) < 1) return;
        pts.push([x, y]);
        renderStrokes();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const pts = state.activeStrokePoints || [];
        state.activeStrokePoints = null;
        if (pts.length < 2) { renderStrokes(); return; } // ignore taps
        state.strokes.push({
          id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          color: state.penColor,
          width: state.penWidth,
          points: pts,
        });
        renderStrokes();
        saveWhiteboard();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
  }

  // ── Item card rendering ────────────────────────────────────────────────
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
    return `<svg width="11" height="11" viewBox="0 0 24 24">${path}</svg>`;
  }

  function renderItemCard(item) {
    const isSticky = item.type === 'sticky';
    const p = paletteFor(item.type);
    const cls = ['sp-item'];
    if (isSticky) cls.push('sp-item-sticky');
    // Sticky background = user-chosen colour (or default). Other types keep
    // white unless the user explicitly set a colour in the menu.
    let bg, fg;
    if (isSticky) {
      bg = item.color || STICKY_COLORS[0];
      fg = '#222';
    } else if (item.color) {
      bg = item.color; fg = 'var(--text)';
    } else {
      bg = '#fff'; fg = 'var(--text)';
    }
    const tilt = isSticky ? tiltForId(item.id) : 0;
    const styleVars = [
      `--sp-accent:${p.accent}`,
      `--sp-accent-soft:${p.accentSoft}`,
      `--sp-accent-dark:${p.accentDark}`,
      isSticky ? `--sp-tilt:${tilt}deg` : '',
    ].filter(Boolean).join(';');
    return `
      <div class="${cls.join(' ')}" data-item-id="${item.id}"
           style="left:${item.position_x}px;top:${item.position_y}px;width:${item.width}px;height:${item.height}px;background:${attr(bg)};color:${fg};z-index:${item.z_index || 0};${styleVars}">
        <div class="sp-item-head" data-drag-handle="1">
          <div class="sp-item-label">${typeIcon(item.type)} ${esc(p.label)}</div>
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
        return `<textarea class="sp-textarea" data-field="text" ${canEdit() ? '' : 'readonly'} placeholder="Write something…">${esc(item.text || '')}</textarea>`;
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

  // ── Wire per-item events ───────────────────────────────────────────────
  function wireItem(item) {
    const el = document.querySelector(`.sp-item[data-item-id="${item.id}"]`);
    if (!el) return;

    const head = el.querySelector('.sp-item-head');
    if (head && canEdit()) {
      head.addEventListener('mousedown', (ev) => {
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

    const moreBtn = el.querySelector('[data-more-btn]');
    if (moreBtn && canEdit()) {
      moreBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showItemMenu(item, moreBtn);
      });
    }

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

    const tStatus = el.querySelector('[data-ticket-status]');
    if (tStatus) {
      tStatus.addEventListener('change', () => {
        let meta = {};
        if (item.ticket_meta && typeof item.ticket_meta === 'object') meta = { ...item.ticket_meta };
        else if (item.ticket_meta) { try { meta = JSON.parse(item.ticket_meta); } catch {} }
        meta.status = tStatus.value;
        item.ticket_meta = meta;
        patchItem(item.id, { ticket_meta: meta }).then(() => {
          const el2 = document.querySelector(`.sp-item[data-item-id="${item.id}"] .sp-item-body`);
          if (el2) el2.innerHTML = renderItemBody(item);
          wireItem(item);
        }).catch(err => toast(err.message || 'Update failed'));
      });
    }

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
    const p = paletteFor(item.type);
    // Colour picker shows: type accent + sticky palette + white reset.
    const colours = item.type === 'sticky'
      ? STICKY_COLORS
      : [p.accentSoft, '#fef9c3', '#fee2e2', '#e0f2fe', '#d1fae5', '#ede9fe', '#fce7f3', '#ffffff'];
    const menu = document.createElement('div');
    menu.className = 'sp-item-menu';
    menu.innerHTML = `
      <div class="sp-item-menu-section">Colour</div>
      <div class="sp-item-sticky-swatches">
        ${colours.map(c => `<button class="sp-item-swatch ${item.color === c ? 'active' : ''}" data-color="${attr(c)}" style="background:${attr(c)}" aria-label="${attr(c)}"></button>`).join('')}
      </div>
      <button class="sp-item-menu-btn danger" data-action="delete">Delete</button>
    `;
    anchorBtn.parentElement.appendChild(menu);
    menu.querySelectorAll('[data-color]').forEach(b => {
      b.onclick = () => {
        const c = b.dataset.color;
        item.color = c;
        patchItem(item.id, { color: c }).then(() => {
          const elc = document.querySelector(`.sp-item[data-item-id="${item.id}"]`);
          if (elc) elc.style.background = c;
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
      { id: 'ticket',   label: 'Ticket',        desc: 'New or pick existing' },
      { id: 'sticky',   label: 'Sticky note',   desc: 'Hand-written reminder' },
      { id: 'note',     label: 'Text note',     desc: 'Plain note' },
      { id: 'document', label: 'Document',      desc: 'Long-form text' },
      { id: 'image',    label: 'Image',         desc: 'Upload picture' },
      { id: 'file',     label: 'File',          desc: 'Any file (≤25 MB)' },
      { id: 'voice',    label: 'Voice note',    desc: 'Record audio' },
      { id: 'video',    label: 'Screen video',  desc: 'Record screen' },
      { id: 'link',     label: 'Link',          desc: 'URL with title' },
    ];
    menu.innerHTML = items.map(it => {
      const p = paletteFor(it.id);
      return `
        <button class="sp-add-item" data-add-type="${it.id}" style="--sp-accent-soft:${p.accentSoft}">
          <span class="ai-emoji">${p.emoji}</span>
          <span class="ai-text"><span class="ai-label">${esc(it.label)}</span><span class="ai-desc">${esc(it.desc)}</span></span>
        </button>
      `;
    }).join('');
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
    if (type === 'sticky') return doAdd({ type, text: '', color: STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)] });
    if (type === 'note') return doAdd({ type, title: 'Note', text: '' });
    if (type === 'document') return doAdd({ type, title: 'Untitled document', text: '' });
    if (type === 'link') return openLinkModal();
    if (type === 'ticket') return openTicketModal();
    if (type === 'image' || type === 'file') return openFilePicker(type);
    if (type === 'voice' || type === 'video') return openRecorderModal(type);
  }

  async function doAdd(input) {
    if (!canEdit()) return;
    const spaceId = Number(state.activeSpaceId);
    if (!Number.isFinite(spaceId)) {
      const msg = 'No active space — try reopening the space first.';
      toast(msg);
      throw new Error(msg);
    }
    const pos = nextPosition();
    const size = sizeFor(input.type);
    // Strip non-finite numerics from the payload so pg never sees a JS NaN
    // (which it stringifies as "NaN" and then can't cast to integer).
    const cleaned = { ...input };
    for (const k of ['size', 'duration', 'position_x', 'position_y', 'width', 'height', 'z_index']) {
      if (k in cleaned) {
        const n = Number(cleaned[k]);
        if (!Number.isFinite(n)) delete cleaned[k];
        else cleaned[k] = n;
      }
    }
    try {
      const created = await db.createSpaceItem(spaceId, {
        position_x: pos.x, position_y: pos.y, width: size.width, height: size.height, ...cleaned,
      });
      state.items.push(created);
      renderItems();
      return created;
    } catch (e) { toast(e.message || 'Failed to add item'); throw e; }
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
      title: 'Add ticket', maxWidth: 560,
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
    let selectedTicket = null;
    function fieldHtml(name, body) {
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
        const submitBtn = m.footEl.querySelector('#sp-t-submit');
        if (submitBtn) submitBtn.textContent = 'Add ticket';
      } else {
        host.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px">
            <input id="sp-tp-search" class="sp-tp-search" type="search" autofocus placeholder="Search by title, ID, status, assignee…"/>
            <div id="sp-tp-list" class="sp-tp-list"><div class="sp-tp-empty">Loading tickets…</div></div>
            <div style="font-size:11px;color:var(--text3)">Pick one to add it as a ticket card.</div>
          </div>
        `;
        const submitBtn = m.footEl.querySelector('#sp-t-submit');
        if (submitBtn) submitBtn.textContent = 'Add selected';
        loadAndRenderTickets();
      }
    }
    async function loadAndRenderTickets() {
      const listEl = m.bodyEl.querySelector('#sp-tp-list');
      const searchEl = m.bodyEl.querySelector('#sp-tp-search');
      if (!state.ticketsCache) {
        try {
          state.ticketsCache = await db.getTicketPicker();
        } catch (e) {
          listEl.innerHTML = `<div class="sp-tp-empty">Failed to load tickets: ${esc(e.message || 'unknown')}</div>`;
          return;
        }
      }
      function renderRows(filter) {
        const q = (filter || '').toLowerCase().trim();
        const rows = (state.ticketsCache || []).filter(t => {
          if (!q) return true;
          return (
            String(t.id || '').toLowerCase().includes(q) ||
            String(t.title || '').toLowerCase().includes(q) ||
            String(t.status || '').toLowerCase().includes(q) ||
            String(t.assignee || '').toLowerCase().includes(q)
          );
        }).slice(0, 200);
        if (!rows.length) {
          listEl.innerHTML = '<div class="sp-tp-empty">No tickets match.</div>';
          return;
        }
        listEl.innerHTML = rows.map(t => `
          <div class="sp-tp-row${selectedTicket && selectedTicket.id === t.id ? ' is-active' : ''}" data-tid="${attr(t.id)}">
            <span class="sp-tp-id">${esc(t.id)}</span>
            <span class="sp-tp-title">${esc(t.title || '(no title)')}</span>
            <span class="sp-tp-meta">${esc(t.status || '')}${t.assignee ? ' • ' + esc(t.assignee) : ''}</span>
          </div>
        `).join('');
        listEl.querySelectorAll('.sp-tp-row').forEach(row => {
          row.onclick = () => {
            const tid = row.dataset.tid;
            selectedTicket = (state.ticketsCache || []).find(x => x.id === tid) || null;
            listEl.querySelectorAll('.sp-tp-row').forEach(r => r.classList.toggle('is-active', r.dataset.tid === tid));
          };
          row.ondblclick = () => {
            const tid = row.dataset.tid;
            selectedTicket = (state.ticketsCache || []).find(x => x.id === tid) || null;
            doSubmit();
          };
        });
      }
      renderRows('');
      searchEl.oninput = () => renderRows(searchEl.value);
      searchEl.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); doSubmit(); }
      };
    }
    function statusToInternal(s) {
      const v = String(s || '').toLowerCase();
      if (v.includes('progress')) return 'in_progress';
      if (v.includes('block') || v.includes('hold')) return 'blocked';
      if (v.includes('clos') || v.includes('done')) return 'done';
      return 'todo';
    }
    async function doSubmit() {
      if (tab === 'new') {
        const title = m.bodyEl.querySelector('#sp-t-title').value.trim();
        if (!title) return;
        const status = m.bodyEl.querySelector('#sp-t-status').value;
        const assignee = m.bodyEl.querySelector('#sp-t-assignee').value.trim();
        m.close();
        doAdd({ type: 'ticket', title, ticket_meta: { status, assignee: assignee || null, source: 'inline' } });
      } else {
        if (!selectedTicket) { toast('Pick a ticket from the list first.'); return; }
        const t = selectedTicket;
        m.close();
        doAdd({
          type: 'ticket',
          title: t.title || t.id,
          ticket_ref: t.id,
          ticket_meta: {
            source: 'external',
            status: statusToInternal(t.status),
            assignee: t.assignee || null,
            origStatus: t.status || null,
          },
        });
      }
    }
    m.bodyEl.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderTab(); });
    renderTab();
    m.footEl.querySelector('#sp-t-cancel').onclick = m.close;
    m.footEl.querySelector('#sp-t-submit').onclick = doSubmit;
  }

  // ── Recording modal (voice + screen) ───────────────────────────────────
  // Picks a MIME type the browser actually supports (Safari and some Android
  // builds reject `new MediaRecorder(stream)` with default opts), forces a
  // 1-second timeslice so a fast click→stop still produces chunks, and shows
  // an explicit saving state during the upload.
  function pickRecorderMime(mode) {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = mode === 'voice'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const c of candidates) {
      try { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c; } catch {}
    }
    return null;
  }

  function openRecorderModal(mode) {
    let recorder = null, stream = null;
    let chunks = [];
    let startedAt = 0;
    let elapsed = 0;
    let timer = null;
    let previewBlob = null;
    let previewUrl = null;
    let phase = 'idle';  // idle | recording | preview | saving | error

    const m = openModal({
      title: mode === 'voice' ? 'Voice note' : 'Screen recording',
      maxWidth: 520,
      body: `<div id="sp-rec-body"></div>`,
      footer: `<div id="sp-rec-footer" style="display:flex;gap:8px;justify-content:flex-end"></div>`,
    });

    function paint() {
      const body = m.bodyEl.querySelector('#sp-rec-body');
      const foot = m.footEl.querySelector('#sp-rec-footer');
      if (!body || !foot) return;
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
      } else if (phase === 'saving') {
        body.innerHTML = `<div class="sp-rec-busy">⏳ Saving to space…</div>`;
        foot.innerHTML = '';
      } else if (phase === 'error') {
        // Body retains the error message set by start()/save() — don't overwrite.
        foot.innerHTML = `<button id="sp-rec-cancel" class="btn-sec" style="padding:8px 14px;font-size:12.5px">Close</button>`;
        foot.querySelector('#sp-rec-cancel').onclick = m.close;
      } else {
        body.innerHTML = `<div class="sp-rec-busy">⏳ Requesting permission…</div>`;
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
        const mime = pickRecorderMime(mode);
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
        recorder.onerror = (ev) => {
          try { console.error('[spaces] MediaRecorder error:', ev.error || ev); } catch {}
          showError('Recording error: ' + ((ev.error && ev.error.message) || 'unknown'));
        };
        recorder.onstop = () => {
          try {
            const type = recorder.mimeType || mime || (mode === 'voice' ? 'audio/webm' : 'video/webm');
            previewBlob = new Blob(chunks, { type });
            if (!previewBlob.size) {
              showError('Recording came out empty. Try again — and hold Stop only after you’ve spoken.');
              return;
            }
            previewUrl = URL.createObjectURL(previewBlob);
            phase = 'preview';
          } finally {
            if (stream) stream.getTracks().forEach(t => t.stop());
            paint();
          }
        };
        stream.getVideoTracks().forEach(t => { t.onended = () => { if (recorder && recorder.state === 'recording') recorder.stop(); }; });
        // Timeslice forces dataavailable events every second. Without this,
        // some browsers emit a single chunk only after stop — and if anything
        // goes wrong in between, you lose the whole take.
        recorder.start(1000);
        startedAt = Date.now();
        timer = setInterval(() => { elapsed = Math.floor((Date.now() - startedAt) / 1000); paint(); }, 500);
        phase = 'recording'; paint();
      } catch (e) {
        showError('Could not start recording: ' + esc(e.message || 'permission denied'));
      }
    }

    function showError(msg) {
      phase = 'error';
      const body = m.bodyEl.querySelector('#sp-rec-body');
      if (body) body.innerHTML = `<div style="color:#dc2626;padding:14px;font-size:13px;line-height:1.5">${msg}</div>`;
      paint();
    }

    function stop() {
      if (recorder && recorder.state === 'recording') recorder.stop();
      if (timer) { clearInterval(timer); timer = null; }
    }

    function cancel() {
      try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch {}
      if (timer) clearInterval(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      cleanupPreview();
    }
    function cleanupPreview() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null; previewBlob = null;
    }

    async function save() {
      if (!previewBlob) { showError('Nothing recorded yet.'); return; }
      if (previewBlob.size > 25 * 1024 * 1024) {
        showError('Recording exceeds 25 MB — try a shorter capture.');
        return;
      }
      phase = 'saving'; paint();
      let data;
      try {
        data = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(new Error('Could not read recording'));
          r.readAsDataURL(previewBlob);
        });
      } catch (e) { showError(e.message || 'Could not read recording'); return; }
      try {
        await doAdd({
          type: mode,
          title: mode === 'voice' ? 'Voice note' : 'Screen recording',
          data, mime_type: previewBlob.type || (mode === 'voice' ? 'audio/webm' : 'video/webm'),
          size: previewBlob.size, duration: elapsed,
        });
      } catch (e) {
        showError('Could not save to space: ' + (e.message || 'server rejected the upload'));
        return;
      }
      m.close();
      cleanupPreview();
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
            <div id="sp-e-colors" style="display:flex;gap:8px;flex-wrap:wrap">
              ${COVER_COLORS.map(c => `<button type="button" data-color="${attr(c)}"
                style="width:30px;height:30px;border-radius:50%;background:${coverGradient(c)};border:${color === c ? '3px solid var(--text)' : '2px solid var(--border)'};cursor:pointer;padding:0"></button>`).join('')}
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
      const spaceUrl = location.origin + '/spaces/' + sp.id;
      m.bodyEl.querySelector('#sp-share-body').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:18px">
          <section class="sp-share-section">
            <h3>This space's URL</h3>
            <div class="sp-share-link">
              <input id="sp-self-link" readonly value="${attr(spaceUrl)}"/>
              <button id="sp-self-copy" class="btn-sec" style="font-size:11.5px;padding:5px 12px">Copy</button>
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:6px">Sign-in required — works for anyone you've invited below.</div>
          </section>
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
        </div>
      `;
      m.bodyEl.querySelector('#sp-self-copy').onclick = () => {
        const link = m.bodyEl.querySelector('#sp-self-link');
        link.select();
        try { navigator.clipboard.writeText(link.value); toast('Space link copied'); } catch { document.execCommand('copy'); toast('Space link copied'); }
      };
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
          state.members = state.members.filter(x => x.user_id !== userId).concat(member);
          repaint();
        } catch (e) { toast(e.message || 'Failed to invite'); }
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
      state.strokes = Array.isArray(data.whiteboard_strokes) ? data.whiteboard_strokes : [];
      state.penMode = false;
      renderCanvasShell();
    } catch (e) {
      root.innerHTML = '<div class="sp-public-fullpage">This space is not available.</div>';
    }
  }

  // ── Paste-image support ───────────────────────────────────────────────
  // Listen for paste events while a space is open and the user has edit
  // rights. If the clipboard contains an image, drop it as an image card.
  // Skips when the paste target is a text input (so pasting inside a note
  // textarea still works normally).
  document.addEventListener('paste', async (ev) => {
    if (!state.activeSpaceId && !state.publicToken) return;
    if (!canEdit()) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t.isContentEditable))) return;
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items || !items.length) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        ev.preventDefault();
        const file = it.getAsFile();
        if (!file) return;
        if (file.size > 25 * 1024 * 1024) { toast('Pasted image is over 25 MB.'); return; }
        try {
          const data = await readFileAsDataURL(file);
          await doAdd({ type: 'image', title: file.name || 'Pasted image', data, mime_type: file.type, size: file.size });
          toast('Image pasted');
        } catch (e) { toast('Paste failed: ' + (e.message || 'unknown')); }
        return;
      }
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────
  window.Spaces = {
    openListView,
    openSpace,
    mountPublic,
  };
})();
