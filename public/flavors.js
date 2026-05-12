// ─────────────────────────────────────────────────────────────────────────────
// Flavors v2 — standalone-page client.
//
// Renders three views on /flavors.html: list of flavors, the create wizard,
// and per-flavor detail with the bottle visualisation. Auth-gates on boot
// (redirects to /login.html on 401). Server is authoritative for ingredient
// + sodium generation — we still preview locally as the user types so the
// wizard feels live, then re-fetch the canonical values on save.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    me: null,
    view: 'list',       // 'list' | 'wizard' | 'detail'
    flavors: [],
    detailId: null,
    detail: null,       // last fetched single-flavor payload
    wizard: defaultWizard(),
  };

  function defaultWizard() {
    return {
      step: 1,
      name: '',
      type: '',
      color: '',
      syrup_color: '',
      flavor_type: '',
      use_of_syrup: '',
      has_salt: null,     // null = unanswered (force a click)
      salt_pct: '',
      preview: { ingredients: '', sodium_mg: 0 },
      saving: false,
      error: '',
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    try {
      const r = await fetch('/api/auth/me');
      if (r.status === 401) { location.href = '/login.html'; return; }
      state.me = await r.json();
      await loadFlavors();
      render();
    } catch (e) {
      $('#fv-app').innerHTML = errorBlock('Could not load Flavors. ' + (e.message || ''));
    }
  }

  async function loadFlavors() {
    const r = await fetch('/api/flavors2');
    if (!r.ok) throw new Error('Could not load flavors');
    state.flavors = await r.json();
  }

  async function loadFlavor(id) {
    const r = await fetch('/api/flavors2/' + id);
    if (!r.ok) throw new Error('Could not load flavor');
    state.detail = await r.json();
  }

  // ── Render dispatcher ─────────────────────────────────────────────────────
  function render() {
    const root = $('#fv-app');
    let body;
    if (state.view === 'wizard')      body = renderWizard();
    else if (state.view === 'detail') body = renderDetail();
    else                              body = renderList();
    root.innerHTML = renderShell(body);
    bind();
  }

  function renderShell(inner) {
    return `
      <div class="fv-shell">
        <header class="fv-header">
          <div class="fv-header-left">
            <a href="/" class="fv-back" title="Back to app">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
              <span>Back</span>
            </a>
            <div class="fv-title">
              <span class="fv-title-icon">🧪</span>
              <h1>Flavors</h1>
            </div>
          </div>
          <div class="fv-header-right">
            ${state.view === 'list' ? `<button class="fv-btn fv-btn-primary" data-act="new-flavor">+ New Flavor</button>` : ''}
            ${state.me ? `<div class="fv-me" title="${escapeAttr(state.me.email||'')}">${escapeHtml(state.me.name || '')}</div>` : ''}
          </div>
        </header>
        <main class="fv-main">${inner}</main>
      </div>
    `;
  }

  // ── List view ─────────────────────────────────────────────────────────────
  function renderList() {
    if (!state.flavors.length) {
      return `
        <div class="fv-empty">
          <div class="fv-empty-art">🧪</div>
          <h2>No flavors yet</h2>
          <p>Launch your first flavor. The wizard walks you through the formula and auto-generates the ingredient list.</p>
          <button class="fv-btn fv-btn-primary" data-act="new-flavor">+ New Flavor</button>
        </div>
      `;
    }
    return `
      <div class="fv-list">
        ${state.flavors.map(renderFlavorCard).join('')}
      </div>
    `;
  }

  function renderFlavorCard(f) {
    const total = (f.tickets_open || 0) + (f.tickets_closed || 0);
    const pct = total > 0 ? Math.round((f.tickets_closed / total) * 100) : 0;
    const typeLabel = f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular';
    return `
      <button class="fv-card" data-act="open-flavor" data-id="${f.id}">
        <div class="fv-card-bottle">${bottleSvg(pct, f.syrup_color || (f.color === 'caramel' ? '#92400e' : '#bae6fd'), pct >= 100)}</div>
        <div class="fv-card-body">
          <div class="fv-card-head">
            <div class="fv-card-name">${escapeHtml(f.name)}</div>
            <span class="fv-chip fv-chip-${f.type}">${typeLabel}</span>
          </div>
          <div class="fv-card-meta">
            ${f.color !== 'none' ? `<span class="fv-meta-pill">🎨 ${escapeHtml(f.color)}${f.syrup_color ? ' · ' + escapeHtml(f.syrup_color) : ''}</span>` : ''}
            <span class="fv-meta-pill">${f.use_of_syrup}</span>
            ${f.has_salt ? `<span class="fv-meta-pill">salt ${f.salt_pct}%</span>` : ''}
          </div>
          <div class="fv-card-progress">
            <div class="fv-progress-bar"><div class="fv-progress-fill" style="width:${pct}%"></div></div>
            <span class="fv-progress-text">${f.tickets_closed}/${total || 0} tasks</span>
          </div>
        </div>
      </button>
    `;
  }

  // ── Wizard ────────────────────────────────────────────────────────────────
  // Single panel that swaps content per step. We track step locally so the
  // user can move back and forth without losing typed values.
  function renderWizard() {
    const w = state.wizard;
    const steps = [
      { n: 1, label: 'Name' },
      { n: 2, label: 'Sugar' },
      { n: 3, label: 'Color' },
      { n: 4, label: 'Flavor type' },
      { n: 5, label: 'Use case' },
      { n: 6, label: 'Salt' },
      { n: 7, label: 'Review' },
    ];

    return `
      <div class="fv-wizard">
        <div class="fv-wizard-stepper">
          ${steps.map(s => `
            <div class="fv-step ${w.step === s.n ? 'active' : ''} ${w.step > s.n ? 'done' : ''}">
              <div class="fv-step-dot">${w.step > s.n ? '✓' : s.n}</div>
              <div class="fv-step-label">${s.label}</div>
            </div>
          `).join('')}
        </div>

        <div class="fv-wizard-panel">
          ${renderWizardStep(w)}
          ${w.error ? `<div class="fv-error">${escapeHtml(w.error)}</div>` : ''}
          <div class="fv-wizard-nav">
            <button class="fv-btn fv-btn-ghost" data-act="wizard-cancel">Cancel</button>
            <div class="fv-wizard-nav-right">
              ${w.step > 1 ? `<button class="fv-btn fv-btn-sec" data-act="wizard-back">Back</button>` : ''}
              ${w.step < 7
                ? `<button class="fv-btn fv-btn-primary" data-act="wizard-next">Next →</button>`
                : `<button class="fv-btn fv-btn-primary" data-act="wizard-save" ${w.saving ? 'disabled' : ''}>${w.saving ? 'Saving…' : 'Create flavor'}</button>`}
            </div>
          </div>
        </div>

        <aside class="fv-wizard-preview">
          <div class="fv-preview-head">Live preview</div>
          <div class="fv-preview-bottle">${bottleSvg(8, w.syrup_color || (w.color === 'caramel' ? '#92400e' : '#bae6fd'), false)}</div>
          <div class="fv-preview-name">${escapeHtml(w.name || 'Untitled flavor')}</div>
          <div class="fv-preview-section">
            <div class="fv-preview-label">Ingredients</div>
            <div class="fv-preview-ingredients">${w.preview.ingredients ? escapeHtml(w.preview.ingredients) : '<span class="fv-muted">Answer the questions to generate…</span>'}</div>
          </div>
          <div class="fv-preview-section">
            <div class="fv-preview-label">Sodium / serving</div>
            <div class="fv-preview-sodium">${w.preview.sodium_mg ? w.preview.sodium_mg + ' mg' : '<span class="fv-muted">—</span>'}</div>
          </div>
        </aside>
      </div>
    `;
  }

  function renderWizardStep(w) {
    switch (w.step) {
      case 1:
        return `
          <h2 class="fv-step-title">What's the flavor called?</h2>
          <p class="fv-step-hint">This name appears on the label, on tickets, and everywhere the flavor is referenced.</p>
          <input type="text" class="fv-input" data-field="name" value="${escapeAttr(w.name)}" placeholder="e.g. Vanilla Caramel" autofocus maxlength="80"/>
        `;
      case 2:
        return `
          <h2 class="fv-step-title">Regular or sugar-free?</h2>
          <p class="fv-step-hint">Sugar-free swaps cane sugar for sucralose + gum and changes the preservative blend.</p>
          ${optionCards('type', w.type, [
            { value: 'regular',    icon: '🍯', label: 'Regular',   sub: 'Pure cane sugar base' },
            { value: 'sugar_free', icon: '💧', label: 'Sugar-free', sub: 'Sucralose + gum base' },
          ])}
        `;
      case 3:
        return `
          <h2 class="fv-step-title">What color are we using?</h2>
          <p class="fv-step-hint">If you pick a color, it gets appended to the ingredient list. "Syrup color" is the visual swatch shown on listings — type a hex or a plain-English color.</p>
          ${optionCards('color', w.color, [
            { value: 'natural', icon: '🌿', label: 'Natural', sub: 'NATURAL COLOR' },
            { value: 'caramel', icon: '🍮', label: 'Caramel', sub: 'CARAMEL COLOR' },
            { value: 'none',    icon: '⚪', label: 'None',    sub: 'No color added' },
          ])}
          <div class="fv-field-row">
            <label class="fv-label">Syrup color (display only)</label>
            <input type="text" class="fv-input" data-field="syrup_color" value="${escapeAttr(w.syrup_color)}" placeholder="e.g. amber, #c2410c" maxlength="60"/>
          </div>
        `;
      case 4:
        return `
          <h2 class="fv-step-title">Flavor type</h2>
          <p class="fv-step-hint">This sets whether the ingredient list says "NATURAL FLAVORS" or "NATURAL AND ARTIFICIAL FLAVORS".</p>
          ${optionCards('flavor_type', w.flavor_type, [
            { value: 'natural',                icon: '🌱', label: 'Natural',                  sub: 'NATURAL FLAVORS' },
            { value: 'natural_and_artificial', icon: '⚗️', label: 'Natural + Artificial',     sub: 'NATURAL AND ARTIFICIAL FLAVORS' },
          ])}
        `;
      case 5:
        return `
          <h2 class="fv-step-title">What's it used for?</h2>
          <p class="fv-step-hint">Used to drive listing-content keywords later (e.g. coffee flavors lean into espresso vocabulary).</p>
          ${optionCards('use_of_syrup', w.use_of_syrup, [
            { value: 'coffee', icon: '☕', label: 'Coffee', sub: 'Latte, espresso, barista' },
            { value: 'fruity', icon: '🍓', label: 'Fruity', sub: 'Soda, lemonade, mocktail' },
            { value: 'other',  icon: '✨', label: 'Other',  sub: 'Dessert, baking, etc.' },
          ])}
        `;
      case 6: {
        const hasSalt = w.has_salt === true;
        return `
          <h2 class="fv-step-title">Does this flavor include salt?</h2>
          <p class="fv-step-hint">Salt drives the sodium value on the nutrition label. Formula: <code>30 × ${w.type === 'sugar_free' ? '1.2' : '1.3'} × (salt% ÷ 100) × 393</code>.</p>
          ${optionCards('has_salt', hasSalt ? 'yes' : (w.has_salt === false ? 'no' : ''), [
            { value: 'yes', icon: '🧂', label: 'Yes', sub: 'Adds SALT to the ingredients' },
            { value: 'no',  icon: '🚫', label: 'No',  sub: 'No sodium beyond preservatives' },
          ])}
          ${hasSalt ? `
            <div class="fv-field-row">
              <label class="fv-label">Salt % (enter 0.5 for half a percent)</label>
              <input type="number" step="0.01" min="0.01" max="100" class="fv-input" data-field="salt_pct" value="${escapeAttr(w.salt_pct)}" placeholder="e.g. 0.5" autofocus/>
            </div>
          ` : ''}
        `;
      }
      case 7:
        return `
          <h2 class="fv-step-title">Review &amp; create</h2>
          <p class="fv-step-hint">Double-check before saving. After creating, you can spawn the launch ticket pipeline from the detail page.</p>
          <dl class="fv-review">
            ${reviewRow('Name', w.name)}
            ${reviewRow('Type', w.type === 'sugar_free' ? 'Sugar-Free' : 'Regular')}
            ${reviewRow('Color', w.color + (w.syrup_color ? ' · ' + w.syrup_color : ''))}
            ${reviewRow('Flavor type', w.flavor_type === 'natural_and_artificial' ? 'Natural + Artificial' : 'Natural')}
            ${reviewRow('Use', w.use_of_syrup)}
            ${reviewRow('Salt', w.has_salt ? `Yes · ${w.salt_pct}%` : 'No')}
            ${reviewRow('Sodium / serving', (w.preview.sodium_mg || 0) + ' mg')}
          </dl>
          <div class="fv-review-ingredients">
            <div class="fv-preview-label">Generated ingredients</div>
            <div class="fv-preview-ingredients fv-ingredients-full">${escapeHtml(w.preview.ingredients || '—')}</div>
          </div>
        `;
    }
  }

  function optionCards(field, current, options) {
    return `
      <div class="fv-options" data-field="${field}">
        ${options.map(o => `
          <button class="fv-option ${current === o.value ? 'selected' : ''}" data-value="${o.value}">
            <span class="fv-option-icon">${o.icon}</span>
            <span class="fv-option-body">
              <span class="fv-option-label">${escapeHtml(o.label)}</span>
              <span class="fv-option-sub">${escapeHtml(o.sub)}</span>
            </span>
          </button>
        `).join('')}
      </div>
    `;
  }

  function reviewRow(k, v) {
    return `<div class="fv-review-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v || '—'))}</dd></div>`;
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  function renderDetail() {
    const f = state.detail;
    if (!f) return `<div class="fv-empty">Loading…</div>`;
    const total = (f.tickets_open || 0) + (f.tickets_closed || 0);
    const pct = total > 0 ? Math.round((f.tickets_closed / total) * 100) : 0;
    const sealed = total > 0 && f.tickets_open === 0;

    return `
      <div class="fv-detail">
        <button class="fv-detail-back" data-act="back-to-list">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          All flavors
        </button>

        <div class="fv-detail-grid">
          <section class="fv-detail-main">
            <div class="fv-detail-head">
              <h2>${escapeHtml(f.name)}</h2>
              <span class="fv-chip fv-chip-${f.type}">${f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular'}</span>
            </div>

            <div class="fv-detail-section">
              <div class="fv-section-label">Formula</div>
              <dl class="fv-review">
                ${reviewRow('Color', f.color + (f.syrup_color ? ' · ' + f.syrup_color : ''))}
                ${reviewRow('Flavor type', f.flavor_type === 'natural_and_artificial' ? 'Natural + Artificial' : 'Natural')}
                ${reviewRow('Use', f.use_of_syrup)}
                ${reviewRow('Salt', f.has_salt ? `Yes · ${f.salt_pct}%` : 'No')}
                ${reviewRow('Sodium / serving', f.sodium_mg + ' mg')}
              </dl>
            </div>

            <div class="fv-detail-section">
              <div class="fv-section-label">Ingredients</div>
              <div class="fv-ingredients-full">${escapeHtml(f.ingredients)}</div>
            </div>

            <div class="fv-detail-section">
              <div class="fv-section-label">Identifiers</div>
              <div class="fv-id-row">
                <label>UPC <span class="fv-muted">(filled by GS1 ticket)</span></label>
                <div class="fv-id-value">${f.upc ? escapeHtml(f.upc) : '<span class="fv-muted">— pending</span>'}</div>
              </div>
              <div class="fv-id-row">
                <label>SKU <span class="fv-muted">(filled by SKU ticket)</span></label>
                <div class="fv-id-value">${f.sku ? escapeHtml(f.sku) : '<span class="fv-muted">— pending</span>'}</div>
              </div>
            </div>

            <div class="fv-detail-section">
              <div class="fv-section-label">Tasks (${f.tickets_closed}/${total || 0} done)</div>
              ${total === 0
                ? `<div class="fv-muted fv-task-empty">No tasks yet. The launch pipeline (UPC, SKU, NineYard, label, listings, images, channel listings) will be added in the next phase.</div>`
                : `<ul class="fv-task-list">${(f.tickets || []).map(t => `
                    <li class="fv-task ${t.status === 'Closed' ? 'done' : ''}">
                      <span class="fv-task-check">${t.status === 'Closed' ? '✓' : '○'}</span>
                      <span class="fv-task-title">${escapeHtml(t.title)}</span>
                      <span class="fv-task-meta">${escapeHtml(t.assignee || '')}</span>
                      <span class="fv-task-status">${escapeHtml(t.status)}</span>
                    </li>
                  `).join('')}</ul>`
              }
            </div>
          </section>

          <aside class="fv-detail-bottle">
            <div class="fv-bottle-big">${bottleSvg(Math.max(pct, 6), f.syrup_color || (f.color === 'caramel' ? '#92400e' : '#bae6fd'), sealed)}</div>
            <div class="fv-bottle-progress">${pct}% complete</div>
            <div class="fv-bottle-sub">${sealed ? 'Sealed & launched' : `${f.tickets_open} task${f.tickets_open === 1 ? '' : 's'} open`}</div>
          </aside>
        </div>
      </div>
    `;
  }

  // ── Bottle visualisation ──────────────────────────────────────────────────
  // SVG syrup bottle. Fill height is clamped 0-100; "sealed" toggles a cap
  // on top (used when every linked ticket is closed). Color comes from the
  // flavor's syrup_color hint, falling back to a sane default per color
  // choice. Anything unparseable just renders blue.
  function bottleSvg(pct, color, sealed) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    // bottle interior: y=42 (top of liquid area) to y=170 (bottom).
    const top    = 42;
    const bottom = 170;
    const liquidTop = bottom - ((bottom - top) * (clamped / 100));
    const fill = sanitizeColor(color);
    return `
      <svg viewBox="0 0 120 200" class="fv-bottle">
        <defs>
          <clipPath id="fv-bottle-inside">
            <path d="M 35 42
                     L 35 38
                     Q 35 32 42 32
                     L 78 32
                     Q 85 32 85 38
                     L 85 42
                     Q 95 50 95 75
                     L 95 170
                     Q 95 178 87 178
                     L 33 178
                     Q 25 178 25 170
                     L 25 75
                     Q 25 50 35 42 Z"/>
          </clipPath>
        </defs>
        ${sealed ? `
          <rect x="38" y="6" width="44" height="14" rx="2" fill="#0f172a"/>
          <rect x="36" y="18" width="48" height="8" rx="1.5" fill="#334155"/>
        ` : `
          <rect x="42" y="14" width="36" height="14" rx="2" fill="#64748b" opacity="0.4"/>
        `}
        <path d="M 35 42 L 35 30 Q 35 26 39 26 L 81 26 Q 85 26 85 30 L 85 42"
              fill="none" stroke="#475569" stroke-width="2"/>
        <path d="M 35 42
                 Q 25 50 25 75
                 L 25 170
                 Q 25 178 33 178
                 L 87 178
                 Q 95 178 95 170
                 L 95 75
                 Q 95 50 85 42 Z"
              fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
        <g clip-path="url(#fv-bottle-inside)">
          <rect x="20" y="${liquidTop}" width="80" height="${bottom - liquidTop + 4}" fill="${fill}"/>
          <ellipse cx="60" cy="${liquidTop + 2}" rx="38" ry="4" fill="${fill}" opacity="0.55"/>
        </g>
        <rect x="30" y="100" width="60" height="40" rx="2" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
        <rect x="34" y="106" width="40" height="3" rx="1" fill="#94a3b8"/>
        <rect x="34" y="113" width="32" height="2" rx="1" fill="#cbd5e1"/>
        <rect x="34" y="118" width="48" height="2" rx="1" fill="#cbd5e1"/>
        <rect x="34" y="123" width="44" height="2" rx="1" fill="#cbd5e1"/>
        <rect x="34" y="128" width="38" height="2" rx="1" fill="#cbd5e1"/>
      </svg>
    `;
  }

  function sanitizeColor(c) {
    const v = String(c || '').trim();
    if (!v) return '#bae6fd';
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
    // Common syrup-color words → hex. Anything else falls through to CSS,
    // which the SVG fill attribute accepts for named colors.
    const map = {
      amber: '#d97706', clear: '#e0f2fe', red: '#dc2626', pink: '#ec4899',
      green: '#16a34a', blue: '#2563eb', yellow: '#eab308', orange: '#ea580c',
      purple: '#7c3aed', brown: '#78350f', caramel: '#92400e', white: '#f1f5f9',
    };
    const k = v.toLowerCase();
    if (map[k]) return map[k];
    // Defensive: strip anything that isn't word chars / # so it can't break
    // out of the fill attribute into the SVG markup.
    return v.replace(/[^a-zA-Z0-9#]/g, '') || '#bae6fd';
  }

  // ── Event binding ─────────────────────────────────────────────────────────
  // Document-level delegation: render() replaces the inner DOM but the
  // document survives, so we attach once and let event bubbling find the
  // right [data-act] / .fv-option target. The _bound guard makes bind()
  // safe to call after every render without re-stacking listeners.
  let _bound = false;
  function bind() {
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
  }

  function onClick(e) {
    const act = e.target.closest('[data-act]');
    if (act) {
      e.preventDefault();
      const name = act.getAttribute('data-act');
      if (name === 'new-flavor') {
        state.wizard = defaultWizard();
        state.view = 'wizard';
        return render();
      }
      if (name === 'open-flavor') {
        const id = Number(act.getAttribute('data-id'));
        return openDetail(id);
      }
      if (name === 'back-to-list') {
        state.view = 'list';
        state.detail = null;
        state.detailId = null;
        return render();
      }
      if (name === 'wizard-cancel') {
        state.view = 'list';
        return render();
      }
      if (name === 'wizard-back') {
        if (state.wizard.step > 1) state.wizard.step--;
        state.wizard.error = '';
        return render();
      }
      if (name === 'wizard-next') {
        return wizardNext();
      }
      if (name === 'wizard-save') {
        return wizardSave();
      }
    }
    // Option-card buttons (the wizard's radio-card UI). The selected value
    // depends on the card's data-field on its parent .fv-options container.
    const opt = e.target.closest('.fv-option');
    if (opt) {
      const wrap = opt.closest('.fv-options');
      if (!wrap) return;
      const field = wrap.getAttribute('data-field');
      const value = opt.getAttribute('data-value');
      if (field === 'has_salt') {
        state.wizard.has_salt = (value === 'yes');
        if (value === 'no') state.wizard.salt_pct = '';
      } else {
        state.wizard[field] = value;
      }
      state.wizard.error = '';
      refreshPreview();
      render();
    }
  }

  function onInput(e) {
    const f = e.target.getAttribute && e.target.getAttribute('data-field');
    if (!f) return;
    if (f === 'salt_pct') {
      state.wizard.salt_pct = e.target.value;
    } else {
      state.wizard[f] = e.target.value;
    }
    refreshPreview();
  }

  function onChange() { /* hook for future inputs */ }

  // ── Wizard logic ──────────────────────────────────────────────────────────
  function wizardNext() {
    const w = state.wizard;
    const err = stepError(w);
    if (err) { w.error = err; return render(); }
    w.error = '';
    w.step = Math.min(7, w.step + 1);
    refreshPreview();
    render();
  }

  function stepError(w) {
    switch (w.step) {
      case 1: return w.name.trim() ? '' : 'Give the flavor a name.';
      case 2: return w.type ? '' : 'Pick regular or sugar-free.';
      case 3: return w.color ? '' : 'Pick a color (or "none").';
      case 4: return w.flavor_type ? '' : 'Pick a flavor type.';
      case 5: return w.use_of_syrup ? '' : 'Pick a use case.';
      case 6:
        if (w.has_salt === null) return 'Does this flavor have salt?';
        if (w.has_salt && !(Number(w.salt_pct) > 0)) return 'Enter a salt % greater than 0.';
        return '';
      default: return '';
    }
  }

  // Live preview via the server so the rules can never drift. Debounced
  // lightly so fast typing in the name field doesn't hammer the endpoint;
  // 200 ms feels live and keeps the request rate sane.
  let _previewTimer = null;
  function refreshPreview() {
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(async () => {
      const w = state.wizard;
      if (!w.type || !w.flavor_type) {
        w.preview = { ingredients: '', sodium_mg: 0 };
        renderPreviewOnly();
        return;
      }
      try {
        const r = await fetch('/api/flavors2/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: w.name, type: w.type, color: w.color || 'none',
            syrup_color: w.syrup_color, flavor_type: w.flavor_type,
            use_of_syrup: w.use_of_syrup || 'other',
            has_salt: !!w.has_salt, salt_pct: Number(w.salt_pct || 0),
          }),
        });
        if (r.ok) {
          w.preview = await r.json();
          renderPreviewOnly();
        }
      } catch (_) { /* preview is best-effort */ }
    }, 200);
  }

  // Re-render just the preview pane + review section so typing in the name
  // input doesn't lose focus. Falls back to a full render if the targets
  // aren't on the page (i.e. we're not on the wizard view).
  function renderPreviewOnly() {
    const pane = $('.fv-wizard-preview');
    if (!pane) return;
    const w = state.wizard;
    pane.outerHTML = `
      <aside class="fv-wizard-preview">
        <div class="fv-preview-head">Live preview</div>
        <div class="fv-preview-bottle">${bottleSvg(8, w.syrup_color || (w.color === 'caramel' ? '#92400e' : '#bae6fd'), false)}</div>
        <div class="fv-preview-name">${escapeHtml(w.name || 'Untitled flavor')}</div>
        <div class="fv-preview-section">
          <div class="fv-preview-label">Ingredients</div>
          <div class="fv-preview-ingredients">${w.preview.ingredients ? escapeHtml(w.preview.ingredients) : '<span class="fv-muted">Answer the questions to generate…</span>'}</div>
        </div>
        <div class="fv-preview-section">
          <div class="fv-preview-label">Sodium / serving</div>
          <div class="fv-preview-sodium">${w.preview.sodium_mg ? w.preview.sodium_mg + ' mg' : '<span class="fv-muted">—</span>'}</div>
        </div>
      </aside>
    `;
    // If we're on step 7 the ingredients also appear in the review body;
    // patch that block too without disturbing focus.
    const reviewBlock = $('.fv-review-ingredients .fv-ingredients-full');
    if (reviewBlock) reviewBlock.textContent = w.preview.ingredients || '—';
  }

  async function wizardSave() {
    const w = state.wizard;
    // Re-run all prior step validations in case the user jumped back and
    // cleared a field. Cheap and prevents a 400 round-trip.
    for (let s = 1; s <= 6; s++) {
      const old = w.step; w.step = s;
      const err = stepError(w);
      w.step = old;
      if (err) { w.error = err; w.step = s; return render(); }
    }
    w.saving = true; w.error = ''; render();
    try {
      const r = await fetch('/api/flavors2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: w.name.trim(),
          type: w.type,
          color: w.color,
          syrup_color: w.syrup_color.trim(),
          flavor_type: w.flavor_type,
          use_of_syrup: w.use_of_syrup,
          has_salt: !!w.has_salt,
          salt_pct: Number(w.salt_pct || 0),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      await loadFlavors();
      state.view = 'detail';
      state.detailId = data.id;
      state.detail = { ...data, tickets: [] };
      render();
    } catch (e) {
      w.saving = false;
      w.error = e.message || 'Could not save';
      render();
    }
  }

  async function openDetail(id) {
    state.view = 'detail';
    state.detailId = id;
    state.detail = null;
    render();
    try {
      await loadFlavor(id);
      render();
    } catch (e) {
      state.detail = null;
      $('#fv-app').innerHTML = renderShell(errorBlock('Could not load flavor. ' + e.message));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function errorBlock(msg) {
    return `<div class="fv-empty"><div class="fv-empty-art">⚠️</div><h2>Something went wrong</h2><p>${escapeHtml(msg)}</p></div>`;
  }
})();
