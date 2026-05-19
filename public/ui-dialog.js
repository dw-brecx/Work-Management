// ============================================================
// ui-dialog.js — shared "nice popup" helpers
//
// Replaces the browser's native alert / confirm / prompt with
// centered, animated modals that match the rest of the app.
// Loaded by every page that has an HTML shell (index.html and
// every standalone page under /public/*.html).
//
// Public API (Promise-based — `await` them):
//   window.uiAlert(message, opts?)          → Promise<void>
//   window.uiConfirm(message, opts?)        → Promise<boolean>
//   window.uiPrompt(message, opts?)         → Promise<string|null>
//
// `window.alert` is monkey-patched to call uiAlert so every
// existing fire-and-forget alert() call instantly looks nice
// without touching the callsite. `window.confirm` and
// `window.prompt` are NOT patched because the natives return
// synchronously and code like `if (confirm(...)) {}` would
// silently break if we replaced them with promises. Callers
// who want the nice version migrate to `await uiConfirm` /
// `await uiPrompt` explicitly.
//
// Options (all dialogs):
//   title       string  — header text (defaults vary by kind)
//   okText      string  — primary-button label (default "OK")
//   cancelText  string  — cancel-button label (default "Cancel")
//   danger      bool    — render primary button in red (use for
//                         destructive confirms like Delete)
// uiPrompt also supports:
//   defaultValue string — pre-filled input value
//   placeholder  string — input placeholder
//   inputType    string — 'text' (default) or 'password'
// ============================================================

(function () {
  'use strict';

  if (window.uiAlert && window.uiConfirm && window.uiPrompt) {
    // Already loaded on this page (some shells include both
    // index.html and a standalone HTML script tag). Bail out
    // so we don't redefine and re-patch alert twice.
    return;
  }

  // Stash the real alert so we have an escape hatch if something
  // catastrophic happens before the DOM is ready.
  const nativeAlert = window.alert.bind(window);

  // Internal: build the modal DOM and wire focus/keyboard handling.
  // Resolves the returned promise based on which path the user takes.
  function showDialog({ kind, message, title, okText, cancelText, danger, defaultValue, placeholder, inputType }) {
    return new Promise((resolve) => {
      // Build DOM
      const overlay = document.createElement('div');
      overlay.className = 'ui-dlg-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      const card = document.createElement('div');
      card.className = 'ui-dlg-card';

      if (title) {
        const h = document.createElement('div');
        h.className = 'ui-dlg-title';
        h.textContent = title;
        card.appendChild(h);
      }

      if (message != null) {
        const p = document.createElement('div');
        p.className = 'ui-dlg-message';
        p.textContent = String(message);
        card.appendChild(p);
      }

      let input = null;
      if (kind === 'prompt') {
        input = document.createElement('input');
        input.className = 'ui-dlg-input';
        input.type = inputType === 'password' ? 'password' : 'text';
        input.value = defaultValue == null ? '' : String(defaultValue);
        if (placeholder) input.placeholder = String(placeholder);
        card.appendChild(input);
      }

      const actions = document.createElement('div');
      actions.className = 'ui-dlg-actions';

      // Cleanup helper — removes the modal and frees the ESC handler.
      function cleanup(result) {
        document.removeEventListener('keydown', onKey);
        // The overlay fades out via animation-reverse if we wanted, but
        // a clean remove is simpler and avoids visual jank when many
        // dialogs queue up.
        try { document.body.removeChild(overlay); } catch {}
        resolve(result);
      }

      // Cancel button for confirm/prompt only — alert has just OK.
      let cancelBtn = null;
      if (kind === 'confirm' || kind === 'prompt') {
        cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'ui-dlg-btn ui-dlg-btn-cancel';
        cancelBtn.textContent = cancelText || 'Cancel';
        cancelBtn.addEventListener('click', () => {
          cleanup(kind === 'confirm' ? false : null);
        });
        actions.appendChild(cancelBtn);
      }

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'ui-dlg-btn ' + (danger ? 'ui-dlg-btn-danger' : 'ui-dlg-btn-primary');
      okBtn.textContent = okText || 'OK';
      okBtn.addEventListener('click', () => {
        if (kind === 'prompt')      cleanup(input.value);
        else if (kind === 'confirm') cleanup(true);
        else                          cleanup(undefined);
      });
      actions.appendChild(okBtn);

      card.appendChild(actions);
      overlay.appendChild(card);

      // Backdrop click = cancel for confirm/prompt, dismiss for alert.
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          if (kind === 'confirm')      cleanup(false);
          else if (kind === 'prompt')  cleanup(null);
          else                          cleanup(undefined);
        }
      });

      // Keyboard: ESC cancels/dismisses, Enter submits (unless the
      // focus is inside a multi-line input — irrelevant here since
      // we only use single-line <input> for prompt).
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (kind === 'confirm')      cleanup(false);
          else if (kind === 'prompt')  cleanup(null);
          else                          cleanup(undefined);
        } else if (e.key === 'Enter') {
          // Don't double-fire if focus is already on a button — the
          // browser's default Enter activates it naturally.
          const t = e.target;
          if (t && t.tagName === 'BUTTON') return;
          e.preventDefault();
          if (kind === 'prompt')      cleanup(input.value);
          else if (kind === 'confirm') cleanup(true);
          else                          cleanup(undefined);
        }
      }
      document.addEventListener('keydown', onKey);

      document.body.appendChild(overlay);

      // Initial focus — input for prompt, OK button otherwise. setTimeout
      // gives the browser one frame to paint so the focus ring is visible
      // and the input animation doesn't fight with autofocus.
      setTimeout(() => {
        if (input) { input.focus(); input.select(); }
        else okBtn.focus();
      }, 50);
    });
  }

  // Public alerts ─ resolves immediately when user clicks OK / hits Enter.
  window.uiAlert = function (message, opts) {
    opts = opts || {};
    // If the document isn't ready yet (this is rare — ui-dialog loads at
    // top of <head>), fall back to the native so the message isn't lost.
    if (!document.body) { nativeAlert(message); return Promise.resolve(); }
    return showDialog({
      kind: 'alert',
      message,
      title: opts.title || 'Heads up',
      okText: opts.okText || 'OK',
      danger: !!opts.danger,
    });
  };

  window.uiConfirm = function (message, opts) {
    opts = opts || {};
    if (!document.body) return Promise.resolve(false);
    return showDialog({
      kind: 'confirm',
      message,
      title: opts.title || 'Are you sure?',
      okText: opts.okText || 'Confirm',
      cancelText: opts.cancelText || 'Cancel',
      danger: !!opts.danger,
    });
  };

  window.uiPrompt = function (message, opts) {
    opts = opts || {};
    if (!document.body) return Promise.resolve(null);
    return showDialog({
      kind: 'prompt',
      message,
      title: opts.title || 'Please enter',
      okText: opts.okText || 'OK',
      cancelText: opts.cancelText || 'Cancel',
      defaultValue: opts.defaultValue,
      placeholder: opts.placeholder,
      inputType: opts.inputType,
    });
  };

  // Drop-in replacement for window.alert. The original alert is
  // synchronous-blocking; ours isn't, but no production code actually
  // depends on alert blocking the JS loop — it's a fire-and-forget API
  // in practice. Returning undefined preserves the same signature.
  window.alert = function (message) {
    window.uiAlert(message);
  };
})();
