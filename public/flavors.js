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
    view: 'list',       // 'list' | 'wizard' | 'detail' | 'settings'
    flavors: [],
    detailId: null,
    detail: null,       // last fetched single-flavor payload
    wizard: defaultWizard(),
    settings: {
      tab: 'channels',  // 'channels' | 'examples'
      channels: [],
      examples: [],
      listingTypes: ['single', 'single_with_pump', '4_pack', '6_pack'],
      editingExample: null,   // null = list view; object = editor open
      loading: false,
    },
    // null = modal closed; object = modal open with these fields
    deleteModal: null,
    // null = closed; { channels: [...], submitting, error } = open
    generateListingsModal: null,
  };

  const LISTING_TYPE_LABELS = {
    single:           'Single (no pump)',
    single_with_pump: 'Single with pump',
    '4_pack':         '4-pack',
    '6_pack':         '6-pack',
  };
  const SYRUP_USE_LABELS = { coffee: 'Coffee', fruity: 'Fruity', other: 'Other' };
  const FLAVOR_TYPE_LABELS = {
    natural: 'Natural', natural_and_artificial: 'Natural + Artificial', any: 'Any',
  };
  // Documented for the examples editor so users know what to type in
  // the title / description / bullet templates.
  const PLACEHOLDERS = [
    ['{name}',        'Flavor name'],
    ['{type}',        'Regular / Sugar-Free'],
    ['{type_lower}',  'regular / sugar-free'],
    ['{color}',       'Color word (e.g. caramel)'],
    ['{syrup_color}', 'Syrup color hint'],
    ['{use}',         'coffee / fruity / other'],
    ['{flavor_type}', 'Natural / Natural + Artificial'],
    ['{is_natural}',  '"Natural " prefix if natural, else blank'],
    ['{ingredients}', 'Full ingredient list'],
    ['{sodium_mg}',   'Sodium mg per serving'],
    ['{salt_pct}',    'Salt percentage'],
  ];

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
      // Deep-link support: /flavors.html#42 opens flavor 42 directly. Ticket
      // descriptions link to this URL, so workers landing here from a UPC /
      // SKU ticket arrive on the right detail page.
      const m = /^#(\d+)$/.exec(location.hash || '');
      if (m) await openDetail(Number(m[1]));
      else render();
      window.addEventListener('hashchange', onHashChange);
    } catch (e) {
      $('#fv-app').innerHTML = errorBlock('Could not load Flavors. ' + (e.message || ''));
    }
  }

  function onHashChange() {
    const m = /^#(\d+)$/.exec(location.hash || '');
    if (m) {
      const id = Number(m[1]);
      if (state.detailId !== id) openDetail(id);
    } else if (state.view === 'detail') {
      state.view = 'list';
      state.detail = null;
      state.detailId = null;
      render();
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
    if (state.view === 'wizard')        body = renderWizard();
    else if (state.view === 'detail')   body = renderDetail();
    else if (state.view === 'settings') body = renderSettings();
    else                                body = renderList();
    let overlays = '';
    if (state.deleteModal)            overlays += renderDeleteModal();
    if (state.generateListingsModal)  overlays += renderGenerateListingsModal();
    root.innerHTML = renderShell(body) + overlays;
    bind();
    // Focus password input when modal opens (after innerHTML swap).
    if (state.deleteModal) {
      const inp = $('#fv-delete-pw');
      if (inp) inp.focus();
    }
  }

  function isAdmin() {
    return !!state.me && ['Admin', 'Manager'].includes(state.me.permRole);
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
            ${isAdmin() && state.view !== 'settings'
              ? `<button class="fv-icon-btn" data-act="open-settings" title="Flavor settings">
                   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
                 </button>`
              : ''}
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

  // Editable identifier row used on the detail page. Shows the saved value
  // as a read-only chip plus an input + Save button. Save fires the PATCH;
  // server-side that auto-closes the matching pipeline ticket (UPC / SKU).
  function idEditor(field, label, value, hint) {
    const v = value || '';
    return `
      <div class="fv-id-row fv-id-row-edit">
        <label>${escapeHtml(label)} <span class="fv-muted">(${escapeHtml(hint)})</span></label>
        <div class="fv-id-edit">
          <input type="text" class="fv-input fv-id-input" data-id-field="${field}" value="${escapeAttr(v)}" placeholder="—" maxlength="64"/>
          <button class="fv-btn fv-btn-sec fv-id-save" data-act="save-id" data-field="${field}">Save</button>
        </div>
      </div>
    `;
  }

  function stepLabel(step) {
    return {
      upc: 'UPC',
      sku: 'SKU',
      nineyard: 'NineYard',
      label_design: 'Label',
      label_review: 'Label Review',
      listing_content: 'Listing',
    }[step] || step;
  }

  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  // ── Listing-content action row ────────────────────────────────────────────
  // Shown between Identifiers and Tasks. Visible once UPC + SKU are filled
  // in (so the content generator can embed them) AND no listing_content
  // tickets exist yet for this flavor. Once tickets exist, this collapses
  // to a status row pointing the user to them.
  function renderListingActions(f) {
    const existing = (f.tickets || []).filter(t => t.flavor_v2_step === 'listing_content');
    const ready = f.upc && f.sku;
    if (existing.length > 0) {
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Listing content</div>
          <div class="fv-listing-status">
            <span>✓ ${existing.length} listing-content ticket${existing.length === 1 ? '' : 's'} generated.</span>
            <span class="fv-muted" style="margin-left:6px">Delete them to regenerate after editing templates.</span>
          </div>
        </div>
      `;
    }
    return `
      <div class="fv-detail-section">
        <div class="fv-section-label">Listing content</div>
        <p class="fv-muted" style="font-size:12.5px;margin:0 0 10px">
          ${ready
            ? 'Generate one listing-content ticket per enabled channel. Each ticket gets all 4 variants (single, single+pump, 4-pack, 6-pack) with template substitution.'
            : 'Fill in UPC + SKU above first — the generator embeds them in the listing copy.'}
        </p>
        <button class="fv-btn fv-btn-primary" data-act="open-generate-listings" ${ready ? '' : 'disabled'}>
          📝 Generate listing content
        </button>
      </div>
    `;
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
              ${idEditor('upc', 'UPC', f.upc, 'Filled here closes the GS1 UPC ticket')}
              ${idEditor('sku', 'SKU', f.sku, 'Filled here closes the SKU ticket')}
            </div>

            ${renderListingActions(f)}

            <div class="fv-detail-section">
              <div class="fv-section-label">Tasks (${f.tickets_closed}/${total || 0} done)</div>
              ${total === 0
                ? `<div class="fv-task-empty">
                     <p class="fv-muted" style="margin:0 0 12px">No tasks yet. Launch the pipeline to create the UPC, SKU, NineYard, and label-design tickets.</p>
                     <button class="fv-btn fv-btn-primary" data-act="launch-pipeline" data-id="${f.id}">🚀 Launch pipeline</button>
                   </div>`
                : `<ul class="fv-task-list">${(f.tickets || []).map(t => `
                    <li class="fv-task ${t.status === 'Closed' ? 'done' : ''}">
                      <span class="fv-task-check">${t.status === 'Closed' ? '✓' : '○'}</span>
                      <span class="fv-task-title">
                        ${t.flavor_v2_step ? `<span class="fv-task-step">${escapeHtml(stepLabel(t.flavor_v2_step))}</span>` : ''}
                        <a href="/tickets/${escapeAttr(t.id)}" class="fv-task-link" target="_blank" rel="noopener">${escapeHtml(t.title)}</a>
                      </span>
                      <span class="fv-task-meta">${escapeHtml(t.assignee || '')}</span>
                      <span class="fv-task-status fv-status-${slug(t.status)}">${escapeHtml(t.status)}</span>
                    </li>
                  `).join('')}</ul>`
              }
            </div>

            ${isAdmin() ? `
            <div class="fv-detail-section fv-danger-zone">
              <div class="fv-section-label fv-danger-label">Danger zone</div>
              <p class="fv-muted" style="font-size:12.5px;margin:0 0 10px">Deletes this flavor and soft-deletes every linked ticket. Tickets stay recoverable from the admin trash; the flavor record itself is unrecoverable.</p>
              <button class="fv-btn fv-btn-danger fv-btn-outline" data-act="delete-flavor">Delete this flavor</button>
            </div>` : ''}
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

  // ── Settings view ─────────────────────────────────────────────────────────
  // Two tabs: channels (where listings go) and listing-content examples
  // (templates the eventual content generator substitutes flavor data into).
  // Reachable from the gear icon in the header for admin / manager users.
  function renderSettings() {
    const s = state.settings;
    return `
      <div class="fv-settings">
        <button class="fv-detail-back" data-act="back-to-list">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          All flavors
        </button>
        <div class="fv-settings-tabs">
          <button class="fv-stab ${s.tab === 'channels' ? 'active' : ''}" data-act="settings-tab" data-tab="channels">Channels</button>
          <button class="fv-stab ${s.tab === 'examples' ? 'active' : ''}" data-act="settings-tab" data-tab="examples">Listing examples</button>
        </div>
        <div class="fv-settings-body">
          ${s.tab === 'channels' ? renderSettingsChannels() : renderSettingsExamples()}
        </div>
      </div>
    `;
  }

  function renderSettingsChannels() {
    const rows = state.settings.channels;
    return `
      <div class="fv-settings-head">
        <div>
          <h2>Sales channels</h2>
          <p class="fv-muted">Each enabled channel gets a per-listing ticket in a later launch phase. <code>code</code> is used as the URL-safe key for SKU and price rules.</p>
        </div>
        <button class="fv-btn fv-btn-primary" data-act="add-channel">+ Add channel</button>
      </div>
      ${rows.length === 0
        ? `<div class="fv-empty">No channels yet. Add Amazon, Walmart, or wherever you list.</div>`
        : `<table class="fv-table">
             <thead><tr><th>Name</th><th>Code</th><th>FBA / FBM</th><th>Enabled</th><th></th></tr></thead>
             <tbody>
               ${rows.map(c => `
                 <tr>
                   <td><input class="fv-input fv-tinp" data-channel-id="${c.id}" data-field="name" value="${escapeAttr(c.name)}"/></td>
                   <td><code>${escapeHtml(c.code)}</code></td>
                   <td>
                     <label class="fv-toggle">
                       <input type="checkbox" data-channel-id="${c.id}" data-field="has_fba" ${c.has_fba ? 'checked' : ''}/>
                       <span>Has FBA + FBM</span>
                     </label>
                   </td>
                   <td>
                     <label class="fv-toggle">
                       <input type="checkbox" data-channel-id="${c.id}" data-field="enabled" ${c.enabled ? 'checked' : ''}/>
                       <span>Enabled</span>
                     </label>
                   </td>
                   <td class="fv-row-actions">
                     <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="save-channel" data-channel-id="${c.id}">Save</button>
                     <button class="fv-btn fv-btn-ghost fv-btn-sm fv-btn-danger" data-act="delete-channel" data-channel-id="${c.id}">Delete</button>
                   </td>
                 </tr>
               `).join('')}
             </tbody>
           </table>`
      }
    `;
  }

  function renderSettingsExamples() {
    const s = state.settings;
    if (s.editingExample) return renderExampleEditor(s.editingExample);

    const rows = s.examples;
    return `
      <div class="fv-settings-head">
        <div>
          <h2>Listing-content examples</h2>
          <p class="fv-muted">Paste your existing listing copy here. The eventual generator picks a template by <b>syrup use × flavor type × listing type</b> and substitutes the flavor's data into the placeholders.</p>
        </div>
        <button class="fv-btn fv-btn-primary" data-act="new-example">+ New example</button>
      </div>
      ${rows.length === 0
        ? `<div class="fv-empty">No examples yet. Paste your Amazon / Walmart listing copy as a template so new flavors get the same voice.</div>`
        : `<div class="fv-example-list">
             ${rows.map(e => `
               <button class="fv-example-card" data-act="edit-example" data-id="${e.id}">
                 <div class="fv-example-head">
                   <div class="fv-example-name">${escapeHtml(e.name)}</div>
                   <div class="fv-example-tags">
                     <span class="fv-meta-pill">${escapeHtml(SYRUP_USE_LABELS[e.syrup_use] || e.syrup_use)}</span>
                     <span class="fv-meta-pill">${escapeHtml(FLAVOR_TYPE_LABELS[e.flavor_type] || e.flavor_type)}</span>
                     <span class="fv-meta-pill">${escapeHtml(LISTING_TYPE_LABELS[e.listing_type] || e.listing_type)}</span>
                   </div>
                 </div>
                 ${e.title_template ? `<div class="fv-example-title">${escapeHtml(e.title_template)}</div>` : ''}
                 <div class="fv-example-meta">${e.bullets.length} bullet${e.bullets.length === 1 ? '' : 's'} · ${e.description_template ? 'has description' : 'no description'}</div>
               </button>
             `).join('')}
           </div>`
      }
    `;
  }

  function renderExampleEditor(ex) {
    const bullets = Array.isArray(ex.bullets) ? ex.bullets : [];
    return `
      <div class="fv-settings-head">
        <div>
          <h2>${ex.id ? 'Edit example' : 'New example'}</h2>
          <p class="fv-muted">Title / bullets / description support placeholders. Click one to copy it, or just type it where you want the substitution.</p>
        </div>
        <div class="fv-row-actions">
          <button class="fv-btn fv-btn-sec" data-act="cancel-example">Cancel</button>
          <button class="fv-btn fv-btn-primary" data-act="save-example">${ex.id ? 'Save changes' : 'Create example'}</button>
        </div>
      </div>

      <div class="fv-example-grid">
        <div class="fv-example-form">
          <div class="fv-field-row">
            <label class="fv-label">Template name</label>
            <input class="fv-input" data-ex-field="name" value="${escapeAttr(ex.name || '')}" placeholder="e.g. Natural coffee — single bottle"/>
          </div>
          <div class="fv-example-row">
            <div class="fv-field-row">
              <label class="fv-label">Syrup use</label>
              <select class="fv-input" data-ex-field="syrup_use">
                ${Object.keys(SYRUP_USE_LABELS).map(k => `<option value="${k}" ${ex.syrup_use === k ? 'selected' : ''}>${SYRUP_USE_LABELS[k]}</option>`).join('')}
              </select>
            </div>
            <div class="fv-field-row">
              <label class="fv-label">Flavor type</label>
              <select class="fv-input" data-ex-field="flavor_type">
                ${Object.keys(FLAVOR_TYPE_LABELS).map(k => `<option value="${k}" ${ex.flavor_type === k ? 'selected' : ''}>${FLAVOR_TYPE_LABELS[k]}</option>`).join('')}
              </select>
            </div>
            <div class="fv-field-row">
              <label class="fv-label">Listing type</label>
              <select class="fv-input" data-ex-field="listing_type">
                ${state.settings.listingTypes.map(t => `<option value="${t}" ${ex.listing_type === t ? 'selected' : ''}>${LISTING_TYPE_LABELS[t] || t}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Title template</label>
            <input class="fv-input" data-ex-field="title_template" value="${escapeAttr(ex.title_template || '')}" placeholder="e.g. {is_natural}{name} Coffee Syrup — 25.4 fl oz"/>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Bullet points (one per line, 1-10)</label>
            <textarea class="fv-input fv-textarea" data-ex-field="bullets" rows="6" placeholder="Each line becomes a bullet. Use {placeholders} inline.">${escapeHtml(bullets.join('\n'))}</textarea>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Description</label>
            <textarea class="fv-input fv-textarea" data-ex-field="description_template" rows="6" placeholder="Long description with {placeholders}.">${escapeHtml(ex.description_template || '')}</textarea>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Keywords (comma-separated, copied to listing keywords field)</label>
            <textarea class="fv-input fv-textarea" data-ex-field="keywords" rows="3" placeholder="e.g. coffee syrup, barista, latte, espresso, cafe">${escapeHtml(ex.keywords || '')}</textarea>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Internal notes</label>
            <textarea class="fv-input fv-textarea" data-ex-field="notes" rows="2" placeholder="Anything for the next person who edits this template.">${escapeHtml(ex.notes || '')}</textarea>
          </div>
        </div>

        <aside class="fv-example-side">
          <div class="fv-preview-head">Placeholders</div>
          <p class="fv-muted" style="font-size:11.5px;line-height:1.5">Click to copy, paste into any field.</p>
          <ul class="fv-placeholder-list">
            ${PLACEHOLDERS.map(([k, hint]) => `
              <li><button class="fv-placeholder" data-act="copy-placeholder" data-value="${escapeAttr(k)}"><code>${escapeHtml(k)}</code><span>${escapeHtml(hint)}</span></button></li>
            `).join('')}
          </ul>
        </aside>
      </div>
    `;
  }

  // ── Delete modal ──────────────────────────────────────────────────────────
  // Rendered as a full-page overlay on top of the shell when
  // state.deleteModal is set. Password is verified server-side via bcrypt
  // against the user's account hash — see DELETE /api/flavors2/:id in
  // routes/flavors.js. We don't echo the password back on re-render, so
  // when the server returns "Incorrect password" the input clears and the
  // user retypes.
  function renderDeleteModal() {
    const m = state.deleteModal;
    const f = state.detail;
    const total = (f.tickets_open || 0) + (f.tickets_closed || 0);
    return `
      <div class="fv-modal-overlay" data-act="dismiss-modal">
        <form class="fv-modal" id="fv-delete-form">
          <h2>Delete "${escapeHtml(f.name)}"?</h2>
          <p class="fv-modal-body">
            This permanently deletes the flavor.
            ${total > 0 ? `It also soft-deletes the <b>${total} linked ticket${total === 1 ? '' : 's'}</b> (${f.tickets_open} open, ${f.tickets_closed} closed) — they stay recoverable from the admin trash.` : 'No tickets to delete.'}
            <br/><br/>
            <b>This cannot be undone for the flavor itself.</b>
          </p>
          <label class="fv-label" for="fv-delete-pw">Enter your account password to confirm</label>
          <input id="fv-delete-pw" type="password" class="fv-input" autocomplete="current-password" placeholder="Password" ${m.submitting ? 'disabled' : ''}/>
          ${m.error ? `<div class="fv-error">${escapeHtml(m.error)}</div>` : ''}
          <div class="fv-modal-actions">
            <button type="button" class="fv-btn fv-btn-sec" data-act="close-delete-modal">Cancel</button>
            <button type="submit" class="fv-btn fv-btn-danger fv-btn-solid" ${m.submitting ? 'disabled' : ''}>${m.submitting ? 'Deleting…' : 'Delete flavor'}</button>
          </div>
        </form>
      </div>
    `;
  }

  // ── Generate-listings modal ───────────────────────────────────────────────
  // Confirmation step before the POST. We load channels + examples once when
  // the modal opens so the user can see exactly which channels will get
  // tickets and whether the templates for each listing type exist. Lets
  // them spot "no template" gaps before spawning tickets that would say
  // "(No template found)" inline.
  function renderGenerateListingsModal() {
    const m = state.generateListingsModal;
    const f = state.detail;
    const enabledChannels = (m.channels || []).filter(c => c.enabled);
    const examples = m.examples || [];
    const listingTypes = state.settings.listingTypes;

    function pickExampleClient(listingType) {
      const pool = examples.filter(e => e.listing_type === listingType);
      if (!pool.length) return null;
      return (
        pool.find(e => e.syrup_use === f.use_of_syrup && e.flavor_type === f.flavor_type) ||
        pool.find(e => e.syrup_use === f.use_of_syrup && e.flavor_type === 'any') ||
        pool.find(e => e.syrup_use === 'other'        && e.flavor_type === f.flavor_type) ||
        pool.find(e => e.syrup_use === 'other'        && e.flavor_type === 'any') ||
        pool[0]
      );
    }

    return `
      <div class="fv-modal-overlay" data-act="dismiss-modal" data-modal="generate-listings">
        <div class="fv-modal fv-modal-wide">
          <h2>Generate listing content</h2>
          <p class="fv-modal-body">
            One ticket per enabled channel will be created, each containing all 4 listing variants
            with placeholder substitution against this flavor's data.
            ${enabledChannels.length === 0 ? '<br/><br/><b>No enabled channels</b> — add or enable one in Settings → Channels.' : ''}
          </p>

          ${enabledChannels.length > 0 ? `
            <div class="fv-gen-channels">
              ${enabledChannels.map(c => `
                <div class="fv-gen-channel">
                  <div class="fv-gen-channel-head">
                    <span class="fv-gen-channel-name">${escapeHtml(c.name)}</span>
                    ${c.has_fba ? `<span class="fv-meta-pill">FBA + FBM</span>` : ''}
                  </div>
                  <ul class="fv-gen-variants">
                    ${listingTypes.map(lt => {
                      const ex = pickExampleClient(lt);
                      return `
                        <li class="${ex ? 'has' : 'missing'}">
                          <span class="fv-gen-variant-label">${escapeHtml(LISTING_TYPE_LABELS[lt] || lt)}</span>
                          <span class="fv-gen-variant-tpl">${ex ? '→ ' + escapeHtml(ex.name) : '⚠ no template'}</span>
                        </li>
                      `;
                    }).join('')}
                  </ul>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${m.error ? `<div class="fv-error">${escapeHtml(m.error)}</div>` : ''}

          <div class="fv-modal-actions">
            <button class="fv-btn fv-btn-sec" data-act="close-generate-modal">Cancel</button>
            <button class="fv-btn fv-btn-primary"
                    data-act="confirm-generate-listings"
                    ${(m.submitting || enabledChannels.length === 0) ? 'disabled' : ''}>
              ${m.submitting
                ? 'Creating tickets…'
                : `Create ${enabledChannels.length} ticket${enabledChannels.length === 1 ? '' : 's'}`}
            </button>
          </div>
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
    // Capture Enter-to-submit on the delete-confirm form (and any future
    // forms). Native submit fires before navigation; we preventDefault and
    // route through our handler so the modal stays in place on failure.
    // Submit handler — Enter in the password field OR clicking the submit
    // button both fire this. We preventDefault to keep the page on this URL
    // and route through submitDelete so the modal stays open on failure.
    document.addEventListener('submit', (e) => {
      if (e.target && e.target.id === 'fv-delete-form') {
        e.preventDefault();
        submitDelete();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (state.deleteModal && !state.deleteModal.submitting) {
        state.deleteModal = null;
        return render();
      }
      if (state.generateListingsModal && !state.generateListingsModal.submitting) {
        state.generateListingsModal = null;
        return render();
      }
    });
  }

  function onClick(e) {
    const act = e.target.closest('[data-act]');
    if (act) {
      const name = act.getAttribute('data-act');
      // dismiss-modal: only fire on a direct click of the overlay itself,
      // and only THEN suppress default. Clicks inside the modal (inputs,
      // submit button, etc.) must keep their native behaviour — preventing
      // default here would break input focus. `data-modal` on the overlay
      // tells us which modal to clear; default is the delete modal so the
      // older callsites still work without an attribute.
      if (name === 'dismiss-modal') {
        if (e.target === act) {
          e.preventDefault();
          const which = act.getAttribute('data-modal') || 'delete';
          if (which === 'generate-listings') state.generateListingsModal = null;
          else                                state.deleteModal = null;
          render();
        }
        return;
      }
      e.preventDefault();
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
        if (location.hash) history.replaceState(null, '', location.pathname);
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
      if (name === 'launch-pipeline') {
        const id = Number(act.getAttribute('data-id'));
        return launchPipeline(id);
      }
      if (name === 'save-id') {
        const field = act.getAttribute('data-field');
        return saveIdentifier(field);
      }
      if (name === 'open-settings')   return openSettings();
      if (name === 'settings-tab')    { state.settings.tab = act.getAttribute('data-tab'); return render(); }
      if (name === 'add-channel')     return addChannel();
      if (name === 'save-channel')    return saveChannel(Number(act.getAttribute('data-channel-id')));
      if (name === 'delete-channel')  return deleteChannel(Number(act.getAttribute('data-channel-id')));
      if (name === 'new-example')     { state.settings.editingExample = blankExample(); return render(); }
      if (name === 'edit-example')    return editExample(Number(act.getAttribute('data-id')));
      if (name === 'cancel-example')  { state.settings.editingExample = null; return render(); }
      if (name === 'save-example')    return saveExample();
      if (name === 'copy-placeholder') {
        const val = act.getAttribute('data-value');
        if (navigator.clipboard) navigator.clipboard.writeText(val).catch(()=>{});
        flashCopied(act);
        return;
      }
      if (name === 'delete-flavor') {
        state.deleteModal = { error: '', submitting: false };
        return render();
      }
      if (name === 'close-delete-modal') {
        state.deleteModal = null;
        return render();
      }
      if (name === 'open-generate-listings')   return openGenerateListings();
      if (name === 'close-generate-modal')     { state.generateListingsModal = null; return render(); }
      if (name === 'confirm-generate-listings') return confirmGenerateListings();
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
    // Example editor fields — captured into state.settings.editingExample
    // so the unsaved values survive a re-render (e.g. when the user clicks
    // a placeholder, which doesn't have an explicit save step).
    const ex = e.target.getAttribute && e.target.getAttribute('data-ex-field');
    if (ex && state.settings.editingExample) {
      if (ex === 'bullets') {
        state.settings.editingExample.bullets = e.target.value.split('\n');
      } else {
        state.settings.editingExample[ex] = e.target.value;
      }
      return;
    }
    const f = e.target.getAttribute && e.target.getAttribute('data-field');
    if (!f) return;
    if (state.view === 'wizard') {
      if (f === 'salt_pct') state.wizard.salt_pct = e.target.value;
      else                  state.wizard[f] = e.target.value;
      refreshPreview();
    }
  }

  function onChange(e) {
    // Same handling for <select> changes inside the example editor.
    const ex = e.target.getAttribute && e.target.getAttribute('data-ex-field');
    if (ex && state.settings.editingExample) {
      state.settings.editingExample[ex] = e.target.value;
    }
  }

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
      history.replaceState(null, '', '#' + data.id);
      render();
    } catch (e) {
      w.saving = false;
      w.error = e.message || 'Could not save';
      render();
    }
  }

  // ── Launch pipeline ───────────────────────────────────────────────────────
  // Posts to /api/flavors2/:id/launch which atomically creates the four
  // pipeline tickets. We disable the button and re-fetch the detail so the
  // task list renders immediately with the new tickets.
  async function launchPipeline(id) {
    const btn = $('[data-act="launch-pipeline"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Launching…'; }
    try {
      const r = await fetch(`/api/flavors2/${id}/launch`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Launch failed');
      await loadFlavor(id);
      render();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '🚀 Launch pipeline'; }
      alert('Could not launch pipeline: ' + (e.message || ''));
    }
  }

  // ── Save UPC / SKU ────────────────────────────────────────────────────────
  // PATCHes the flavor record; the server auto-closes the matching pipeline
  // ticket on a blank→set transition. We re-fetch on success so the task
  // list immediately shows the now-closed UPC / SKU ticket.
  async function saveIdentifier(field) {
    const input = document.querySelector(`[data-id-field="${field}"]`);
    if (!input) return;
    const val = String(input.value || '').trim();
    const btn = document.querySelector(`.fv-id-save[data-field="${field}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: val }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      await loadFlavor(state.detailId);
      render();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      alert('Could not save: ' + (e.message || ''));
    }
  }

  // ── Settings handlers ─────────────────────────────────────────────────────
  function blankExample() {
    return {
      id: null, name: '', syrup_use: 'coffee', flavor_type: 'any',
      listing_type: 'single', title_template: '', bullets: [],
      description_template: '', keywords: '', notes: '',
    };
  }

  async function openSettings() {
    state.view = 'settings';
    state.settings.editingExample = null;
    render();
    try {
      await loadSettings();
      render();
    } catch (e) {
      alert('Could not load settings: ' + (e.message || ''));
    }
  }

  async function loadSettings() {
    const [chRes, exRes, ltRes] = await Promise.all([
      fetch('/api/flavors2/settings/channels'),
      fetch('/api/flavors2/settings/examples'),
      fetch('/api/flavors2/settings/listing-types'),
    ]);
    if (!chRes.ok || !exRes.ok || !ltRes.ok) throw new Error('Could not load settings');
    state.settings.channels = await chRes.json();
    state.settings.examples = await exRes.json();
    const lt = await ltRes.json();
    if (Array.isArray(lt.types) && lt.types.length) state.settings.listingTypes = lt.types;
  }

  // ── Channels ──────────────────────────────────────────────────────────────
  async function addChannel() {
    const name = prompt('Channel name (e.g. eBay, Faire):');
    if (!name) return;
    const code = prompt('Channel code (lowercase, used as URL key — e.g. ebay, faire):',
                         name.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    if (!code) return;
    try {
      const r = await fetch('/api/flavors2/settings/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), code: code.trim(), has_fba: false, enabled: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Add failed');
      await loadSettings();
      render();
    } catch (e) { alert('Could not add channel: ' + (e.message || '')); }
  }

  async function saveChannel(id) {
    const row = state.settings.channels.find(c => c.id === id);
    if (!row) return;
    // Pull live values from inputs (state lags behind the DOM because we
    // don't re-render on every keystroke for the channels table).
    const nameEl    = document.querySelector(`input[data-channel-id="${id}"][data-field="name"]`);
    const fbaEl     = document.querySelector(`input[data-channel-id="${id}"][data-field="has_fba"]`);
    const enabledEl = document.querySelector(`input[data-channel-id="${id}"][data-field="enabled"]`);
    const body = {
      name:    nameEl    ? nameEl.value.trim()    : row.name,
      has_fba: fbaEl     ? fbaEl.checked          : row.has_fba,
      enabled: enabledEl ? enabledEl.checked      : row.enabled,
    };
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      // Update in place so the user doesn't lose other unsaved edits in the
      // same table.
      const idx = state.settings.channels.findIndex(c => c.id === id);
      if (idx !== -1) state.settings.channels[idx] = data;
    } catch (e) { alert('Could not save channel: ' + (e.message || '')); }
  }

  async function deleteChannel(id) {
    const row = state.settings.channels.find(c => c.id === id);
    if (!row) return;
    if (!confirm(`Delete channel "${row.name}"? Existing tickets that reference it won't be deleted, but new launches won't include this channel.`)) return;
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Delete failed');
      }
      await loadSettings();
      render();
    } catch (e) { alert('Could not delete channel: ' + (e.message || '')); }
  }

  // ── Listing examples ──────────────────────────────────────────────────────
  function editExample(id) {
    const found = state.settings.examples.find(e => e.id === id);
    if (!found) return;
    // Clone so cancel reverts cleanly and bullets becomes a mutable array.
    state.settings.editingExample = {
      ...found,
      bullets: Array.isArray(found.bullets) ? [...found.bullets] : [],
    };
    render();
  }

  async function saveExample() {
    const ex = state.settings.editingExample;
    if (!ex) return;
    if (!ex.name || !ex.name.trim()) { alert('Template needs a name.'); return; }
    const body = {
      name: ex.name, syrup_use: ex.syrup_use, flavor_type: ex.flavor_type,
      listing_type: ex.listing_type,
      title_template: ex.title_template || '',
      bullets: (ex.bullets || []).map(b => String(b).trim()).filter(Boolean),
      description_template: ex.description_template || '',
      keywords: ex.keywords || '',
      notes: ex.notes || '',
    };
    try {
      const url = ex.id
        ? `/api/flavors2/settings/examples/${ex.id}`
        : '/api/flavors2/settings/examples';
      const r = await fetch(url, {
        method: ex.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      await loadSettings();
      state.settings.editingExample = null;
      render();
    } catch (e) { alert('Could not save: ' + (e.message || '')); }
  }

  // ── Generate listing-content tickets ──────────────────────────────────────
  // The modal does a confirmation + a live preview of which channels get
  // tickets and which listing types have templates (so the user can fix
  // gaps in Settings before committing). The server is authoritative for
  // template matching + substitution; this load is purely to show the
  // user a per-channel summary before they spawn tickets.
  async function openGenerateListings() {
    state.generateListingsModal = { channels: [], examples: [], submitting: false, error: '', loading: true };
    render();
    try {
      const [chRes, exRes] = await Promise.all([
        fetch('/api/flavors2/settings/channels'),
        fetch('/api/flavors2/settings/examples'),
      ]);
      if (!chRes.ok || !exRes.ok) throw new Error('Could not load channels / templates');
      state.generateListingsModal.channels = await chRes.json();
      state.generateListingsModal.examples = await exRes.json();
      state.generateListingsModal.loading = false;
      render();
    } catch (e) {
      state.generateListingsModal.error = e.message || 'Load failed';
      state.generateListingsModal.loading = false;
      render();
    }
  }

  async function confirmGenerateListings() {
    if (!state.generateListingsModal || state.generateListingsModal.submitting) return;
    state.generateListingsModal.submitting = true;
    state.generateListingsModal.error = '';
    render();
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}/generate-listings`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Generate failed');
      state.generateListingsModal = null;
      await loadFlavor(state.detailId);
      render();
      flashToast(`Created ${data.tickets.length} listing-content ticket${data.tickets.length === 1 ? '' : 's'}.`);
    } catch (e) {
      state.generateListingsModal.submitting = false;
      state.generateListingsModal.error = e.message || 'Could not generate';
      render();
    }
  }

  // ── Delete flavor ─────────────────────────────────────────────────────────
  // Submits the password to DELETE /api/flavors2/:id. On success: pop a
  // toast with the soft-deleted ticket count and bounce back to the list.
  // On bad password: clear the field, surface the server's error message,
  // refocus the input.
  async function submitDelete() {
    if (!state.deleteModal || state.deleteModal.submitting) return;
    const inp = $('#fv-delete-pw');
    const password = inp ? inp.value : '';
    if (!password) {
      state.deleteModal.error = 'Enter your password.';
      return render();
    }
    state.deleteModal.submitting = true;
    state.deleteModal.error = '';
    render();
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Delete failed');

      const id = state.detailId;
      state.deleteModal = null;
      state.detail = null;
      state.detailId = null;
      state.view = 'list';
      state.flavors = state.flavors.filter(f => f.id !== id);
      if (location.hash) history.replaceState(null, '', location.pathname);
      render();
      // Lightweight toast — we don't ship a notifications system on this
      // page, and a temporary banner is plenty for a destructive action.
      flashToast(`Flavor deleted. ${data.deletedTickets || 0} ticket${data.deletedTickets === 1 ? '' : 's'} moved to admin trash.`);
    } catch (e) {
      state.deleteModal.submitting = false;
      state.deleteModal.error = e.message || 'Could not delete';
      // render() rebuilds the modal HTML, which gives us a fresh empty
      // password input and auto-focuses it. No need to touch the DOM
      // here; the old input node is gone.
      render();
    }
  }

  function flashToast(msg) {
    const t = document.createElement('div');
    t.className = 'fv-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    // Force a paint then animate the slide-in. Removal after 3.5s.
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }, 3500);
  }

  function flashCopied(btn) {
    const orig = btn.dataset.origText || btn.innerHTML;
    btn.dataset.origText = orig;
    btn.classList.add('copied');
    setTimeout(() => { btn.classList.remove('copied'); }, 600);
  }

  async function openDetail(id) {
    state.view = 'detail';
    state.detailId = id;
    state.detail = null;
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
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
