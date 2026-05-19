// Email-to-Ticket setup page. Auth-gate via /api/auth/me (redirects to
// /login.html on 401), then renders the user's API tokens and the two
// Apps Script snippets the user needs to paste into Google Apps Script.

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const APP_URL = window.location.origin;

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }, opts || {}));
    if (r.status === 401) {
      window.location.href = '/login.html?next=' + encodeURIComponent('/email-to-ticket.html');
      throw new Error('unauthenticated');
    }
    if (!r.ok) {
      let msg = 'Request failed (' + r.status + ')';
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    return r.json();
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function fmtDate(s) {
    if (!s) return 'never';
    try {
      const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
      if (isNaN(d)) return s;
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (_) { return s; }
  }

  async function loadTokens() {
    const list = $('#tokenList');
    list.innerHTML = '';
    const rows = await api('/api/api-tokens');
    if (!rows.length) {
      list.appendChild(el('div', { class: 'empty' }, 'No tokens yet. Generate one above to get started.'));
      return;
    }
    for (const t of rows) {
      const meta = el('div', { class: 'meta' },
        el('span', { class: 'name', text: t.name || 'API token' }),
        el('span', { class: 'sub', text: `${t.token_prefix}…  ·  created ${fmtDate(t.created_at)}  ·  last used ${fmtDate(t.last_used_at)}` })
      );
      const revoke = el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!await uiConfirm('Revoke this token? Any add-on using it will stop working.')) return;
          revoke.disabled = true;
          try { await api('/api/api-tokens/' + t.id, { method: 'DELETE' }); await loadTokens(); }
          catch (e) { alert(e.message); revoke.disabled = false; }
        },
      }, 'Revoke');
      list.appendChild(el('div', { class: 'token-row' }, meta, revoke));
    }
  }

  async function generateToken() {
    const btn = $('#genBtn');
    const nameInput = $('#tokenName');
    const name = (nameInput.value || '').trim() || 'Gmail add-on';
    btn.disabled = true;
    try {
      const res = await api('/api/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name, source: 'gmail-addon' }),
      });
      $('#freshTokenVal').textContent = res.token;
      $('#freshToken').style.display = 'block';
      nameInput.value = '';
      await loadTokens();
      window.scrollTo({ top: $('#freshToken').offsetTop - 40, behavior: 'smooth' });
    } catch (e) {
      alert(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function wireCopyButtons() {
    document.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-copy-target]');
      if (!btn) return;
      const targetSel = btn.getAttribute('data-copy-target');
      const node = document.querySelector(targetSel);
      if (!node) return;
      const text = node.textContent;
      try { await navigator.clipboard.writeText(text); }
      catch (_) {
        // Fallback for older browsers: select + execCommand.
        const r = document.createRange(); r.selectNode(node);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
        try { document.execCommand('copy'); } catch (__) {}
        window.getSelection().removeAllRanges();
      }
      // Show a small "Copied" flash next to the button.
      const fb = btn.parentElement.querySelector('.copy-feedback');
      if (fb) { fb.classList.add('show'); setTimeout(() => fb.classList.remove('show'), 1200); }
    });
  }

  function renderSnippets() {
    $('#appUrl').textContent = APP_URL;

    // The Apps Script Code.gs source. Embedded so the user can copy/paste
    // without leaving the page. The {{APP_URL_DEFAULT}} placeholder is
    // substituted with the live origin so the default is sensible — the
    // user can still override it from the add-on's Settings page.
    const codeGs = (window.__GMAIL_ADDON_CODE_GS__ || '')
      .replace(/\{\{APP_URL_DEFAULT\}\}/g, APP_URL);
    $('#codeGsSnippet').textContent = codeGs || 'Snippet not loaded — see gmail-addon/Code.gs in the repo.';

    const manifest = window.__GMAIL_ADDON_MANIFEST__ || '';
    $('#manifestSnippet').textContent = manifest || 'Snippet not loaded — see gmail-addon/appsscript.json in the repo.';
  }

  async function init() {
    try {
      const me = await api('/api/auth/me');
      $('#who').textContent = `Signed in as ${me.email}`;
    } catch (_) { return; /* redirect already happened */ }

    // Fetch the add-on source from /gmail-addon-snippets so we always show
    // the canonical version that lives in the repo. Falls back silently if
    // the route isn't available (then the user just refers to the repo
    // files directly).
    try {
      const r = await fetch('/api/gmail-addon-snippets', { credentials: 'same-origin' });
      if (r.ok) {
        const j = await r.json();
        window.__GMAIL_ADDON_CODE_GS__  = j.codeGs || '';
        window.__GMAIL_ADDON_MANIFEST__ = j.manifest || '';
      }
    } catch (_) {}

    renderSnippets();
    wireCopyButtons();
    $('#genBtn').addEventListener('click', generateToken);
    await loadTokens();
  }

  init();
})();
