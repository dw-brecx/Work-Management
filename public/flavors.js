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
    productTypes: [],   // shared across wizard + settings + detail-preview
    listingContent: null,  // { needs_setup, variants[] } for the detail view
    listingTab: 'single',  // active tab inside the listing content section
    listingSubmitting: false,  // tracks Approve-and-spawn submission
    wizard: defaultWizard(),
    settings: {
      tab: 'product-types',  // 'product-types' | 'channels' | 'variations' | 'examples'
      channels: [],
      examples: [],
      productTypes: [],
      variations: [],
      expandedProductType: null,  // id of the product type whose card is expanded
      expandedChannel: null,      // id of the channel whose patterns sub-table is open
      channelPatterns: {},        // { channelId: [...patterns] } cache
      channelPrices: {},          // { channelId: [...priceRules] } cache
      channelDefaults: {},        // { channelId: { key: value } } cache
      channelTemplates: {},       // { channelId: { exists, size, uploaded_at } | null }
      addingPatternFor: null,     // channelId — shows the "+ Add pattern" form inline
      addingPriceFor: null,       // channelId — shows the "+ Add price" form inline
      editingVariation: null,     // null = list view; object = new/edit form
      listingTypes: ['single', 'single_with_pump', '4_pack', '6_pack'],
      editingExample: null,   // null = list view; object = editor open
      loading: false,
    },
    // null = modal closed; object = modal open with these fields
    deleteModal: null,
    // null = closed; { channels: [...], submitting, error } = open
    generateListingsModal: null,
    // null = closed; { channels: [...], submitting, error } = open
    generateImagesModal: null,
    // null = closed; { channels, submitting, error } = open
    generateChannelSkusModal: null,
    // last fetched channel-SKU list for the current flavor (display only)
    channelSkus: [],
    // Variation listing matches for the current flavor (loaded lazily).
    variationMatches: [],
    variationSubmitting: false,
  };

  const LISTING_TYPE_LABELS = {
    single:           'Single (no pump)',
    single_with_pump: 'Single with pump',
    '4_pack':         '4-pack',
    '6_pack':         '6-pack',
  };
  // Wizard step 5 icons per product-type key. New keys fall back to 🧪 so
  // adding a product type in Settings doesn't break the wizard render.
  const WIZARD_ICONS = {
    coffee: '☕',
    cocktails: '🍸',
    fruit: '🍓',
    lattes: '🥛',
    smoothie: '🥤',
    tea: '🍵',
    unique: '✨',
    coffee_cocktails: '🥃',
    coffee_fruit: '🍒',
    cocktails_fruit: '🍹',
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
      await Promise.all([loadFlavors(), loadProductTypes()]);
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

  async function loadProductTypes() {
    try {
      const r = await fetch('/api/flavors2/settings/product-types');
      if (r.ok) state.productTypes = await r.json();
    } catch (_) { /* leave empty — wizard shows fallback */ }
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
    // Fire-and-forget the channel-SKU fetch — empty array if generator hasn't
    // run yet. We don't block the detail render on this; the SKU table
    // section just won't appear until the next render after this resolves.
    fetch('/api/flavors2/' + id + '/channel-skus').then(r2 => r2.ok ? r2.json() : []).then(arr => {
      state.channelSkus = Array.isArray(arr) ? arr : [];
      if (state.view === 'detail' && state.detailId === id) render();
    }).catch(() => { state.channelSkus = []; });
    // Auto-generated listing content (Build B). First fetch generates the
    // 4 variants from the product type + flavor data and persists; later
    // fetches return what's stored (possibly edited by the user).
    state.listingContent = null;
    fetch('/api/flavors2/' + id + '/listing-content').then(r2 => r2.ok ? r2.json() : null).then(data => {
      state.listingContent = data;
      if (state.view === 'detail' && state.detailId === id) render();
    }).catch(() => { state.listingContent = null; });
    // Variation listings — only meaningful once channel SKUs exist, but
    // we fire the fetch unconditionally; the server returns [] when no
    // match. Empty array → section shows "no matches" hint with link to
    // Settings → Variations.
    state.variationMatches = [];
    fetch('/api/flavors2/' + id + '/variation-matches').then(r3 => r3.ok ? r3.json() : []).then(arr => {
      state.variationMatches = Array.isArray(arr) ? arr : [];
      if (state.view === 'detail' && state.detailId === id) render();
    }).catch(() => { state.variationMatches = []; });
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
    if (state.deleteModal)              overlays += renderDeleteModal();
    if (state.generateListingsModal)    overlays += renderGenerateListingsModal();
    if (state.generateImagesModal)      overlays += renderGenerateImagesModal();
    if (state.generateChannelSkusModal) overlays += renderGenerateChannelSkusModal();
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
      case 5: {
        // Source the 10 product types directly from flavor_product_types so
        // edits in Settings → Product types flow through to the wizard
        // without a code change. Falls back to the legacy 3-option list if
        // the fetch failed (e.g. server still booting).
        const types = (state.productTypes || []).filter(p => p.enabled);
        const options = types.length
          ? types.map(p => ({
              value: p.key,
              icon: WIZARD_ICONS[p.key] || '🧪',
              label: p.name,
              sub: '',
            }))
          : [
              { value: 'coffee', icon: '☕', label: 'Coffee', sub: 'Latte, espresso, barista' },
              { value: 'fruity', icon: '🍓', label: 'Fruity', sub: 'Soda, lemonade, mocktail' },
              { value: 'other',  icon: '✨', label: 'Other',  sub: 'Dessert, baking, etc.' },
            ];
        return `
          <h2 class="fv-step-title">What product type is this?</h2>
          <p class="fv-step-hint">Drives the auto-generated listing title + bullets. Each option corresponds to one of your 10 templates in Settings → Product types — edits there feed back here automatically.</p>
          ${optionCards('use_of_syrup', w.use_of_syrup, options)}
        `;
      }
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
      image_creation: 'Images',
      ebc: 'EBC',
      channel_launch: 'Channel',
      sku_mapping: 'SKU Map',
      variation_listing: 'Variations',
    }[step] || step;
  }

  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  // ── Listing-content + image action rows ───────────────────────────────────
  // Shown between Identifiers and Tasks. Both share the same UPC+SKU
  // precondition — they bake those values into ticket descriptions so they
  // can't fire until phase 2 lands. Once the underlying tickets exist,
  // each row collapses to a green status banner.
  function renderListingActions(f) {
    return renderListingContentSection(f) +
           renderImageTicketsSection(f) +
           renderChannelSkusSection(f) +
           renderVariationListingsSection(f);
  }

  function renderVariationListingsSection(f) {
    // Only show this section after channel SKUs exist — variations are
    // about attaching channel SKUs to parent listings, so they're
    // meaningless beforehand.
    const channelSkus = state.channelSkus || [];
    if (channelSkus.length === 0) return '';
    const existing = (f.tickets || []).filter(t => t.flavor_v2_step === 'variation_listing');
    if (existing.length > 0) {
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Variation listings</div>
          <div class="fv-listing-status">
            <span>✓ Variation-listing ticket generated.</span>
            <span class="fv-muted" style="margin-left:6px">Delete it to regenerate after editing variations.</span>
          </div>
        </div>
      `;
    }
    const matches = state.variationMatches || [];
    if (matches.length === 0) {
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Variation listings</div>
          <p class="fv-muted" style="font-size:12.5px;margin:0">
            No variation listings match this flavor. Add some in Settings → Variation listings — typically one per parent listing you maintain (e.g. Amazon parent ASINs grouped by REG/SF + pump/no-pump, plus your Custom rollups for REG and SF).
          </p>
        </div>
      `;
    }
    const totalSkus = matches.reduce((sum, m) => sum + (m.sku_count || 0), 0);
    return `
      <div class="fv-detail-section">
        <div class="fv-section-label">Variation listings</div>
        <p class="fv-muted" style="font-size:12.5px;margin:0 0 10px">
          When inventory arrives, attach this flavor's channel SKUs to the parent listings below.
          <b>${matches.length}</b> variation${matches.length === 1 ? '' : 's'} match this flavor (${totalSkus} child SKU${totalSkus === 1 ? '' : 's'} to attach in total).
        </p>
        <ul class="fv-variation-list">
          ${matches.map(m => `
            <li>
              <span class="fv-variation-name">
                <span class="fv-meta-pill">${escapeHtml(m.variation.channel_name)}</span>
                ${escapeHtml(m.variation.name)}
              </span>
              <span class="fv-muted" style="font-size:11.5px">${m.sku_count} SKU${m.sku_count === 1 ? '' : 's'}${m.variation.external_id ? ' · ' + escapeHtml(m.variation.external_id) : ''}</span>
            </li>
          `).join('')}
        </ul>
        <button class="fv-btn fv-btn-primary" data-act="generate-variation-ticket" ${state.variationSubmitting ? 'disabled' : ''}>
          ${state.variationSubmitting ? 'Spawning ticket…' : '🔗 Generate variation-listing ticket'}
        </button>
      </div>
    `;
  }

  function renderChannelSkusSection(f) {
    const launchTickets = (f.tickets || []).filter(t =>
      t.flavor_v2_step === 'channel_launch' || t.flavor_v2_step === 'sku_mapping'
    );
    const hasListings  = (f.tickets || []).some(t => t.flavor_v2_step === 'listing_content');
    const hasImages    = (f.tickets || []).some(t => t.flavor_v2_step === 'image_creation');
    const ready = f.upc && f.sku;
    if (launchTickets.length > 0) {
      const launches = launchTickets.filter(t => t.flavor_v2_step === 'channel_launch').length;
      const mapping  = launchTickets.filter(t => t.flavor_v2_step === 'sku_mapping').length;
      const skus = state.channelSkus || [];
      const hasAmazonSkus = skus.some(s => s.channel_code === 'amazon');
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Channel SKUs &amp; launch</div>
          <div class="fv-listing-status">
            <span>✓ ${launches} channel-launch ticket${launches === 1 ? '' : 's'}${mapping ? ' + 1 SKU mapping ticket' : ''} generated.</span>
            ${skus.length > 0 ? `<span class="fv-muted" style="margin-left:6px">${skus.length} SKU${skus.length === 1 ? '' : 's'} stored.</span>` : ''}
          </div>
          ${skus.length > 0 ? renderChannelSkuTable(skus) : ''}
          ${hasAmazonSkus ? `
            <div style="margin-top:12px">
              <a class="fv-btn fv-btn-sec" href="/api/flavors2/${f.id}/export/amazon" download>
                📥 Export Amazon flat file
              </a>
              <p class="fv-muted" style="font-size:11px;margin:4px 0 0">
                Downloads a copy of the Amazon template with one row per (listing × fulfillment) pre-filled with this flavor's data.
                Configure brand / manufacturer / item type / etc. in Settings → Channels → Amazon → Channel defaults.
              </p>
            </div>
          ` : ''}
        </div>
      `;
    }
    const blockers = [];
    if (!ready) blockers.push('Fill in UPC + SKU');
    if (!hasListings) blockers.push('Run "Generate listing content"');
    if (!hasImages)   blockers.push('Run "Create image tickets"');
    const canRun = ready;
    return `
      <div class="fv-detail-section">
        <div class="fv-section-label">Channel SKUs &amp; launch</div>
        <p class="fv-muted" style="font-size:12.5px;margin:0 0 10px">
          Generate per-channel SKUs (with FBA/FBM splits where applicable) and spawn one launch ticket per channel + a SKU mapping ticket.
          ${blockers.length > 0
            ? `<br/><b>Recommended first:</b> ${blockers.join(' · ')}.${canRun ? ' You can still proceed — references will be missing in the launch tickets.' : ''}`
            : ''}
        </p>
        <button class="fv-btn fv-btn-primary" data-act="open-generate-channel-skus" ${canRun ? '' : 'disabled'}>
          🏷 Generate channel SKUs &amp; launch tickets
        </button>
      </div>
    `;
  }

  function renderChannelSkuTable(skus) {
    // Group by channel for compact display.
    const byChannel = new Map();
    for (const s of skus) {
      if (!byChannel.has(s.channel_name)) byChannel.set(s.channel_name, []);
      byChannel.get(s.channel_name).push(s);
    }
    let html = `<details class="fv-sku-details"><summary>View generated SKUs</summary><div class="fv-sku-tables">`;
    for (const [channel, list] of byChannel) {
      html += `
        <div class="fv-sku-block">
          <div class="fv-sku-channel">${escapeHtml(channel)}</div>
          <table class="fv-sku-table">
            <thead><tr><th>Listing</th><th>Fulfilment</th><th>Channel SKU</th></tr></thead>
            <tbody>
              ${list.map(s => `
                <tr>
                  <td>${escapeHtml(LISTING_TYPE_LABELS[s.listing_type] || s.listing_type)}</td>
                  <td>${s.fulfillment ? `<span class="fv-meta-pill">${escapeHtml(s.fulfillment.toUpperCase())}</span>` : '<span class="fv-muted">—</span>'}</td>
                  <td><code>${escapeHtml(s.channel_sku)}</code></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    html += `</div></details>`;
    return html;
  }

  function renderListingContentSection(f) {
    const ready = f.upc && f.sku;
    // Legacy: a few flavors created before the approve-only flow have
    // listing_content tickets attached. Surface them as a status row but
    // don't gate the editor — the underlying flavor_listing_content is
    // what matters for both the channel-launch tickets and the Amazon
    // flat-file export.
    const existingTickets = (f.tickets || []).filter(t => t.flavor_v2_step === 'listing_content');
    if (!ready) {
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Listing content</div>
          <p class="fv-muted" style="font-size:12.5px;margin:0">
            Fill in UPC + SKU above first — the generated copy embeds them.
          </p>
        </div>
      `;
    }
    const lc = state.listingContent;
    if (!lc) {
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Listing content</div>
          <p class="fv-muted" style="font-size:12.5px;margin:0">Generating preview…</p>
        </div>
      `;
    }
    if (lc.needs_setup) {
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Listing content</div>
          <div class="fv-error" style="margin:0">
            This flavor's product type (<code>${escapeHtml(lc.product_type_key || '—')}</code>) doesn't exist in Settings → Product types. Add or rename it, then click <b>Regenerate</b> below.
          </div>
          <button class="fv-btn fv-btn-sec" data-act="regenerate-listing-content" style="margin-top:10px">Regenerate preview</button>
        </div>
      `;
    }
    const variants = lc.variants || [];
    const singleOnly = variants.length === 1 && variants[0].listing_variant === 'single';
    if (singleOnly) return renderListingSingleOnly(variants[0]);

    const activeTab = state.listingTab || 'single';
    const active = variants.find(v => v.listing_variant === activeTab) || variants[0];
    const allApproved = variants.length === 4 && variants.every(v => v.approved);
    return `
      <div class="fv-detail-section">
        <div class="fv-section-label">Listing content (all variants)</div>
        <p class="fv-muted" style="font-size:12.5px;margin:0 0 12px">
          Single+Pump / 4-Pack / 6-Pack were auto-filled from your approved Single — bullets + description copied, titles swapped per template. Tweak any tab inline, save, then approve. No tickets get spawned; the channel-launch tickets and the Amazon flat-file export read directly from these approved variants.
        </p>

        <div class="fv-lc-tabs">
          ${variants.map(v => `
            <button class="fv-lc-tab ${activeTab === v.listing_variant ? 'active' : ''}" data-act="lc-tab" data-variant="${v.listing_variant}">
              ${escapeHtml(LISTING_TYPE_LABELS[v.listing_variant] || v.listing_variant)}
              ${v.approved ? '<span class="fv-lc-tick">✓</span>' : ''}
            </button>
          `).join('')}
        </div>

        ${active ? renderListingVariantEditor(active) : ''}

        ${allApproved ? `
          <div class="fv-listing-status" style="margin-top:12px">
            ✓ All 4 variants approved. The channel-launch tickets and the Amazon flat-file export use these values.
          </div>
        ` : ''}

        <div class="fv-lc-actions">
          <button class="fv-btn fv-btn-ghost fv-btn-sm" data-act="regenerate-listing-content" title="Discard all variants and start over from the product-type template">↻ Start over from template</button>
          <button class="fv-btn fv-btn-primary"
                  data-act="approve-and-spawn-listings"
                  ${state.listingSubmitting ? 'disabled' : ''}>
            ${state.listingSubmitting
              ? 'Approving…'
              : (allApproved ? '✓ Re-approve all variants' : 'Approve all variants')}
          </button>
        </div>
      </div>
    `;
  }

  // Single-only state: only the Single variant exists. Show its editor with
  // a primary call-to-action explaining the propagate flow — once the user
  // is happy with this content (especially BP1 which is the flavor-specific
  // sensory description), they click "Approve single & generate other
  // variants" and the system creates single+pump / 4-pack / 6-pack by
  // carrying these bullets + description forward.
  function renderListingSingleOnly(single) {
    return `
      <div class="fv-detail-section">
        <div class="fv-section-label">Listing content — write the master copy</div>
        <p class="fv-muted" style="font-size:12.5px;margin:0 0 8px">
          Edit the <b>Single bottle</b> listing below. Pay attention to <b>BP1</b> — that's where you write the flavor-specific sensory description ("rich and buttery", "bright and citrusy", etc.). The other 3 variants (Single+Pump, 4-Pack, 6-Pack) will be auto-generated from this one when you approve below.
        </p>
        <div class="fv-lc-only-single">
          <span class="fv-lc-only-badge">Single bottle</span>
          <span class="fv-muted">+ 3 variants pending</span>
        </div>

        ${renderListingVariantEditor(single)}

        <div class="fv-lc-actions">
          <button class="fv-btn fv-btn-ghost fv-btn-sm" data-act="regenerate-listing-content" title="Discard this draft and re-substitute from the product-type template">↻ Reset to template</button>
          <button class="fv-btn fv-btn-primary"
                  data-act="propagate-from-single"
                  ${state.listingSubmitting ? 'disabled' : ''}>
            ${state.listingSubmitting ? 'Generating other variants…' : '✓ Approve single & generate other variants'}
          </button>
        </div>
      </div>
    `;
  }

  function renderListingVariantEditor(v) {
    const bullets = Array.isArray(v.bullets) ? v.bullets : [];
    return `
      <div class="fv-lc-variant">
        <div class="fv-field-row">
          <label class="fv-label">Title</label>
          <textarea class="fv-input" rows="2" data-lc-variant="${v.listing_variant}" data-lc-field="title">${escapeHtml(v.title)}</textarea>
        </div>
        <div class="fv-field-row">
          <label class="fv-label">Bullets (one per line)</label>
          <textarea class="fv-input fv-textarea" rows="${Math.max(8, bullets.length + 1)}" data-lc-variant="${v.listing_variant}" data-lc-field="bullets">${escapeHtml(bullets.join('\n'))}</textarea>
        </div>
        <div class="fv-field-row">
          <label class="fv-label">Description</label>
          <textarea class="fv-input fv-textarea" rows="6" data-lc-variant="${v.listing_variant}" data-lc-field="description">${escapeHtml(v.description)}</textarea>
        </div>
        <div class="fv-lc-variant-meta">
          <span class="fv-muted">Status: ${v.approved ? '<b>Approved</b>' : 'Pending approval'}</span>
          <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="save-listing-variant" data-variant="${v.listing_variant}">Save this variant</button>
        </div>
      </div>
    `;
  }

  function renderImageTicketsSection(f) {
    const imgTickets = (f.tickets || []).filter(t =>
      t.flavor_v2_step === 'image_creation' || t.flavor_v2_step === 'ebc'
    );
    const ready = f.upc && f.sku;
    if (imgTickets.length > 0) {
      const main = imgTickets.filter(t => t.flavor_v2_step === 'image_creation').length;
      const ebc  = imgTickets.filter(t => t.flavor_v2_step === 'ebc').length;
      return `
        <div class="fv-detail-section">
          <div class="fv-section-label">Image tickets</div>
          <div class="fv-listing-status">
            <span>✓ ${main} product-image ticket${main === 1 ? '' : 's'}${ebc ? ' + ' + ebc + ' EBC ticket' + (ebc === 1 ? '' : 's') : ''} generated.</span>
            <span class="fv-muted" style="margin-left:6px">Designers attach each image to its subtask.</span>
          </div>
        </div>
      `;
    }
    return `
      <div class="fv-detail-section">
        <div class="fv-section-label">Image tickets</div>
        <p class="fv-muted" style="font-size:12.5px;margin:0 0 10px">
          ${ready
            ? 'Create a product-image ticket with a subtask per image slot (main + 7-or-8 additional per enabled channel), plus an Amazon EBC ticket if Amazon is enabled.'
            : 'Fill in UPC + SKU above first — the image briefs reference them.'}
        </p>
        <button class="fv-btn fv-btn-primary" data-act="open-generate-images" ${ready ? '' : 'disabled'}>
          🎨 Create image tickets
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
          <button class="fv-stab ${s.tab === 'product-types' ? 'active' : ''}" data-act="settings-tab" data-tab="product-types">Product types</button>
          <button class="fv-stab ${s.tab === 'channels' ? 'active' : ''}" data-act="settings-tab" data-tab="channels">Channels</button>
          <button class="fv-stab ${s.tab === 'variations' ? 'active' : ''}" data-act="settings-tab" data-tab="variations">Variation listings</button>
          <button class="fv-stab ${s.tab === 'examples' ? 'active' : ''}" data-act="settings-tab" data-tab="examples">Listing examples (legacy)</button>
        </div>
        <div class="fv-settings-body">
          ${s.tab === 'product-types' ? renderSettingsProductTypes()
            : s.tab === 'channels'    ? renderSettingsChannels()
            : s.tab === 'variations'  ? renderSettingsVariations()
            :                            renderSettingsExamples()}
        </div>
      </div>
    `;
  }

  function renderSettingsProductTypes() {
    const rows = state.settings.productTypes || [];
    return `
      <div class="fv-settings-head">
        <div>
          <h2>Product types</h2>
          <p class="fv-muted">
            Curated 10-category taxonomy seeded from your title.xlsx. Each card holds
            the titles + 5 BPs for REG and SF, the pump suffix, the extra BP for pumps,
            and the shared product description. When a flavor is created (Build B),
            the wizard will pick one of these, and the app will pre-fill every listing
            variant using these fields.
          </p>
          <p class="fv-muted" style="font-size:11.5px;margin-top:6px">
            Placeholders kept from your sheet:
            <code>---</code> = flavor name,
            <code>...-Pack</code> = pack size,
            <code>(Naturally Flavored)</code> / <code>(Natural Flavors)</code> = stay as-typed (strip for N+A flavors if your voice differs).
            <code>AI Flavor Description …</code> in BP1 will become a Claude call in Build B; for now it ships as static text.
          </p>
        </div>
      </div>
      <div class="fv-pt-list">
        ${rows.map(renderProductTypeCard).join('')}
      </div>
    `;
  }

  function renderProductTypeCard(pt) {
    const expanded = state.settings.expandedProductType === pt.id;
    if (!expanded) {
      return `
        <div class="fv-pt-card">
          <button class="fv-pt-head" data-act="toggle-pt" data-id="${pt.id}">
            <div class="fv-pt-head-left">
              <span class="fv-pt-name">${escapeHtml(pt.name)}</span>
              <code class="fv-pt-key">${escapeHtml(pt.key)}</code>
            </div>
            <div class="fv-pt-head-right">
              ${pt.enabled ? '<span class="fv-meta-pill">Enabled</span>' : '<span class="fv-meta-pill" style="color:#a16207">Disabled</span>'}
              <span class="fv-muted" style="font-size:11px">${pt.bullets_reg.length} REG · ${pt.bullets_sf.length} SF bullets</span>
              <span class="fv-pt-chevron">▾</span>
            </div>
          </button>
        </div>
      `;
    }
    // Expanded editor — all fields visible, save/cancel on the bottom.
    return `
      <div class="fv-pt-card fv-pt-card-open">
        <button class="fv-pt-head" data-act="toggle-pt" data-id="${pt.id}">
          <div class="fv-pt-head-left">
            <span class="fv-pt-name">${escapeHtml(pt.name)}</span>
            <code class="fv-pt-key">${escapeHtml(pt.key)}</code>
          </div>
          <div class="fv-pt-head-right">
            <span class="fv-pt-chevron rotated">▾</span>
          </div>
        </button>
        <div class="fv-pt-body">
          <div class="fv-pt-row">
            <div class="fv-field-row">
              <label class="fv-label">Display name</label>
              <input class="fv-input" data-pt-id="${pt.id}" data-pt-field="name" value="${escapeAttr(pt.name)}"/>
            </div>
            <div class="fv-field-row">
              <label class="fv-label">Pump title suffix</label>
              <input class="fv-input" data-pt-id="${pt.id}" data-pt-field="pump_title_suffix" value="${escapeAttr(pt.pump_title_suffix)}" placeholder="With Pump"/>
            </div>
            <div class="fv-field-row" style="align-self:end">
              <label class="fv-toggle" style="margin-bottom:8px">
                <input type="checkbox" data-pt-id="${pt.id}" data-pt-field="enabled" ${pt.enabled ? 'checked' : ''}/>
                <span>Enabled (shows in wizard)</span>
              </label>
            </div>
          </div>

          ${renderPtVariant(pt, 'reg', 'Regular')}
          ${renderPtVariant(pt, 'sf',  'Sugar-Free')}

          <div class="fv-field-row">
            <label class="fv-label">BP6 — extra bullet (pump variants only)</label>
            <textarea class="fv-input fv-textarea" rows="2" data-pt-id="${pt.id}" data-pt-field="bullet_pump_extra">${escapeHtml(pt.bullet_pump_extra)}</textarea>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Shared product description</label>
            <textarea class="fv-input fv-textarea" rows="6" data-pt-id="${pt.id}" data-pt-field="description">${escapeHtml(pt.description)}</textarea>
          </div>

          <div class="fv-pt-actions">
            <button class="fv-btn fv-btn-sec" data-act="toggle-pt" data-id="${pt.id}">Close</button>
            <button class="fv-btn fv-btn-primary" data-act="save-pt" data-id="${pt.id}">Save changes</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderPtVariant(pt, variant, label) {
    const bullets = (variant === 'reg' ? pt.bullets_reg : pt.bullets_sf) || [];
    return `
      <fieldset class="fv-pt-variant">
        <legend>${label}</legend>
        <div class="fv-field-row">
          <label class="fv-label">Title (single bottle)</label>
          <input class="fv-input" data-pt-id="${pt.id}" data-pt-field="title_${variant}_single" value="${escapeAttr(pt['title_' + variant + '_single'])}"/>
        </div>
        <div class="fv-field-row">
          <label class="fv-label">Title (packs — uses <code>...-Pack</code> for pack size)</label>
          <input class="fv-input" data-pt-id="${pt.id}" data-pt-field="title_${variant}_packs" value="${escapeAttr(pt['title_' + variant + '_packs'])}"/>
        </div>
        <div class="fv-field-row">
          <label class="fv-label">5 bullet points (one per line)</label>
          <textarea class="fv-input fv-textarea" rows="${Math.max(8, bullets.length + 1)}" data-pt-id="${pt.id}" data-pt-field="bullets_${variant}">${escapeHtml(bullets.join('\n'))}</textarea>
        </div>
      </fieldset>
    `;
  }

  // ── Settings — Variation listings tab ────────────────────────────────────
  // Parent listings on Amazon / Walmart / Custom that flavors get added to
  // as child variants when inventory arrives. Filters control which flavors
  // match: regular vs sugar_free, and which listing-type slot (single,
  // single+pump, 4-pack, 6-pack, or any).
  function renderSettingsVariations() {
    const s = state.settings;
    if (s.editingVariation) return renderVariationEditor(s.editingVariation);
    const rows = s.variations || [];
    // Group by channel for compact display.
    const byChannel = new Map();
    for (const v of rows) {
      const key = v.channel_name || '(no channel)';
      if (!byChannel.has(key)) byChannel.set(key, []);
      byChannel.get(key).push(v);
    }
    return `
      <div class="fv-settings-head">
        <div>
          <h2>Variation listings</h2>
          <p class="fv-muted">
            Parent listings that exist on each channel (Amazon parent ASINs, Walmart variations, Custom rollups). When inventory arrives for a new flavor, the app spawns one ticket listing every variation this flavor should be added to — based on its REG/SF + the listing type each variation covers.
          </p>
        </div>
        <button class="fv-btn fv-btn-primary" data-act="add-variation">+ Add variation listing</button>
      </div>
      ${rows.length === 0
        ? `<div class="fv-empty">No variation listings yet. Add one per existing parent listing you maintain — e.g. "Amazon — Reg coffee — Single with pump", "Custom — All sugar-free flavors".</div>`
        : Array.from(byChannel.entries()).map(([channelName, list]) => `
            <div class="fv-var-channel">
              <div class="fv-var-channel-head">${escapeHtml(channelName)}</div>
              <table class="fv-table">
                <thead><tr>
                  <th>Name</th><th>Flavor type</th><th>Listing type</th><th>Parent ID</th><th>Enabled</th><th></th>
                </tr></thead>
                <tbody>
                  ${list.map(v => `
                    <tr>
                      <td>${escapeHtml(v.name)}${v.notes ? `<div class="fv-muted" style="font-size:11px;margin-top:2px">${escapeHtml(v.notes)}</div>` : ''}</td>
                      <td>${variationFilterLabel('flavor', v.flavor_type_filter)}</td>
                      <td>${variationFilterLabel('listing', v.listing_type_filter)}</td>
                      <td><code>${escapeHtml(v.external_id || '—')}</code></td>
                      <td>${v.enabled ? '<span class="fv-meta-pill">Enabled</span>' : '<span class="fv-meta-pill" style="color:#a16207">Disabled</span>'}</td>
                      <td class="fv-row-actions">
                        <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="edit-variation" data-id="${v.id}">Edit</button>
                        <button class="fv-btn fv-btn-ghost fv-btn-sm fv-btn-danger" data-act="delete-variation" data-id="${v.id}">Delete</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `).join('')
      }
    `;
  }

  function variationFilterLabel(kind, val) {
    if (val === 'any') return '<span class="fv-muted">Any</span>';
    if (kind === 'flavor') {
      return val === 'regular' ? 'Regular' : 'Sugar-Free';
    }
    return escapeHtml(LISTING_TYPE_LABELS[val] || val);
  }

  function renderVariationEditor(v) {
    const channels = state.settings.channels || [];
    const FLAVOR_FILTERS = [
      { value: 'any',         label: 'Any flavor type' },
      { value: 'regular',     label: 'Regular only' },
      { value: 'sugar_free',  label: 'Sugar-Free only' },
    ];
    const LISTING_FILTERS = [
      { value: 'any',               label: 'Any listing type' },
      { value: 'single',            label: 'Single (no pump) only' },
      { value: 'single_with_pump',  label: 'Single with pump only' },
      { value: '4_pack',            label: '4-pack only' },
      { value: '6_pack',            label: '6-pack only' },
    ];
    return `
      <div class="fv-settings-head">
        <div>
          <h2>${v.id ? 'Edit variation listing' : 'New variation listing'}</h2>
          <p class="fv-muted">
            Defines a parent listing flavors will be added to as child variants when inventory arrives. The filters decide which flavors match.
          </p>
        </div>
        <div class="fv-row-actions">
          <button class="fv-btn fv-btn-sec" data-act="cancel-variation">Cancel</button>
          <button class="fv-btn fv-btn-primary" data-act="save-variation">${v.id ? 'Save changes' : 'Create variation'}</button>
        </div>
      </div>
      <div class="fv-example-form" style="max-width:640px">
        <div class="fv-field-row">
          <label class="fv-label">Name</label>
          <input class="fv-input" data-vr-field="name" value="${escapeAttr(v.name || '')}" placeholder="e.g. Amazon — Reg coffee — Single with pump"/>
        </div>
        <div class="fv-example-row">
          <div class="fv-field-row">
            <label class="fv-label">Channel</label>
            <select class="fv-input" data-vr-field="channel_id">
              <option value="">— pick a channel —</option>
              ${channels.map(c => `<option value="${c.id}" ${Number(v.channel_id) === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="fv-field-row">
            <label class="fv-label">Flavor-type filter</label>
            <select class="fv-input" data-vr-field="flavor_type_filter">
              ${FLAVOR_FILTERS.map(f => `<option value="${f.value}" ${v.flavor_type_filter === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
            </select>
          </div>
          <div class="fv-field-row">
            <label class="fv-label">Listing-type filter</label>
            <select class="fv-input" data-vr-field="listing_type_filter">
              ${LISTING_FILTERS.map(f => `<option value="${f.value}" ${v.listing_type_filter === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="fv-field-row">
          <label class="fv-label">Parent ID <span class="fv-muted">(ASIN, parent SKU, listing URL — whatever the worker needs)</span></label>
          <input class="fv-input" data-vr-field="external_id" value="${escapeAttr(v.external_id || '')}" placeholder="e.g. B0ABC123 or https://walmart.com/ip/12345"/>
        </div>
        <div class="fv-field-row">
          <label class="fv-label">Notes for the worker</label>
          <textarea class="fv-input fv-textarea" rows="3" data-vr-field="notes" placeholder="Anything the worker needs to know when attaching SKUs to this parent.">${escapeHtml(v.notes || '')}</textarea>
        </div>
        <div class="fv-field-row">
          <label class="fv-toggle" style="font-size:13px">
            <input type="checkbox" data-vr-field="enabled" ${v.enabled !== false ? 'checked' : ''}/>
            <span>Enabled (matches will appear in flavor variation tickets)</span>
          </label>
        </div>
      </div>
    `;
  }

  function renderSettingsChannels() {
    const rows = state.settings.channels || [];
    return `
      <div class="fv-settings-head">
        <div>
          <h2>Sales channels</h2>
          <p class="fv-muted">
            Each enabled channel gets per-listing tickets in the launch flow. Expand a channel
            to manage its SKU patterns — per-(listing × fulfillment) templates with a single
            <code>(SKU)</code> placeholder for the flavor's base SKU.
          </p>
        </div>
        <button class="fv-btn fv-btn-primary" data-act="add-channel">+ Add channel</button>
      </div>
      ${rows.length === 0
        ? `<div class="fv-empty">No channels yet. Add Amazon, Walmart, or wherever you list.</div>`
        : `<div class="fv-pt-list">${rows.map(renderChannelCard).join('')}</div>`
      }
    `;
  }

  function renderChannelCard(c) {
    const expanded = state.settings.expandedChannel === c.id;
    if (!expanded) {
      return `
        <div class="fv-pt-card">
          <button class="fv-pt-head" data-act="toggle-channel" data-id="${c.id}">
            <div class="fv-pt-head-left">
              <span class="fv-pt-name">${escapeHtml(c.name)}</span>
              <code class="fv-pt-key">${escapeHtml(c.code)}</code>
            </div>
            <div class="fv-pt-head-right">
              ${c.enabled ? '<span class="fv-meta-pill">Enabled</span>' : '<span class="fv-meta-pill" style="color:#a16207">Disabled</span>'}
              ${c.has_fba ? '<span class="fv-meta-pill">FBA + FBM</span>' : ''}
              <span class="fv-pt-chevron">▾</span>
            </div>
          </button>
        </div>
      `;
    }
    const patterns = (state.settings.channelPatterns || {})[c.id] || [];
    return `
      <div class="fv-pt-card fv-pt-card-open">
        <button class="fv-pt-head" data-act="toggle-channel" data-id="${c.id}">
          <div class="fv-pt-head-left">
            <span class="fv-pt-name">${escapeHtml(c.name)}</span>
            <code class="fv-pt-key">${escapeHtml(c.code)}</code>
          </div>
          <div class="fv-pt-head-right">
            <span class="fv-pt-chevron rotated">▾</span>
          </div>
        </button>
        <div class="fv-pt-body">
          <div class="fv-pt-row" style="grid-template-columns:2fr 1fr 1fr auto">
            <div class="fv-field-row">
              <label class="fv-label">Display name</label>
              <input class="fv-input" data-channel-id="${c.id}" data-field="name" value="${escapeAttr(c.name)}"/>
            </div>
            <div class="fv-field-row" style="align-self:end">
              <label class="fv-toggle" style="margin-bottom:8px">
                <input type="checkbox" data-channel-id="${c.id}" data-field="has_fba" ${c.has_fba ? 'checked' : ''}/>
                <span>Has FBA + FBM</span>
              </label>
            </div>
            <div class="fv-field-row" style="align-self:end">
              <label class="fv-toggle" style="margin-bottom:8px">
                <input type="checkbox" data-channel-id="${c.id}" data-field="enabled" ${c.enabled ? 'checked' : ''}/>
                <span>Enabled</span>
              </label>
            </div>
            <div class="fv-row-actions" style="align-self:end">
              <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="save-channel" data-channel-id="${c.id}">Save channel</button>
              <button class="fv-btn fv-btn-ghost fv-btn-sm fv-btn-danger" data-act="delete-channel" data-channel-id="${c.id}">Delete</button>
            </div>
          </div>

          <div class="fv-pt-variant" style="margin-top:8px">
            <legend>SKU patterns</legend>
            <p class="fv-muted" style="font-size:11.5px;margin:0 0 8px">
              One row per (listing type × fulfillment). Template uses <code>(SKU)</code> for the flavor's base SKU — everything else is literal.
              Example: <code>F-(SKU)-NP-UPC</code> with base SKU <code>SY-5500</code> renders <code>F-SY-5500-NP-UPC</code>.
            </p>
            ${patterns.length === 0
              ? `<div class="fv-muted" style="font-size:12px;padding:6px 0">No patterns for this channel yet — add the first row below.</div>`
              : `<table class="fv-table">
                  <thead><tr><th>Listing type</th><th>Fulfilment</th><th>Template</th><th>Preview (SKU=SY-5500)</th><th></th></tr></thead>
                  <tbody>
                    ${patterns.map(p => `
                      <tr>
                        <td>
                          <select class="fv-input fv-tinp" data-pattern-id="${p.id}" data-pf-field="listing_type">
                            ${state.settings.listingTypes.map(lt => `<option value="${lt}" ${p.listing_type === lt ? 'selected' : ''}>${escapeHtml(LISTING_TYPE_LABELS[lt] || lt)}</option>`).join('')}
                          </select>
                        </td>
                        <td>
                          <input class="fv-input fv-tinp" data-pattern-id="${p.id}" data-pf-field="fulfillment" value="${escapeAttr(p.fulfillment)}" placeholder="fba / fbm / wfs / —" style="max-width:100px"/>
                        </td>
                        <td>
                          <input class="fv-input fv-tinp" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px" data-pattern-id="${p.id}" data-pf-field="template" value="${escapeAttr(p.template)}" placeholder="F-(SKU)-…"/>
                        </td>
                        <td><code style="font-size:11px">${escapeHtml(previewPattern(p.template, 'SY-5500'))}</code></td>
                        <td class="fv-row-actions">
                          <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="save-pattern" data-channel-id="${c.id}" data-pattern-id="${p.id}">Save</button>
                          <button class="fv-btn fv-btn-ghost fv-btn-sm fv-btn-danger" data-act="delete-pattern" data-channel-id="${c.id}" data-pattern-id="${p.id}">Delete</button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>`
            }
            ${state.settings.addingPatternFor === c.id
              ? renderAddPatternForm(c.id)
              : `<button class="fv-btn fv-btn-sec fv-btn-sm" data-act="show-add-pattern" data-channel-id="${c.id}" style="margin-top:8px">+ Add pattern row</button>`
            }
          </div>

          ${renderChannelPricesBlock(c)}
          ${renderChannelDefaultsBlock(c)}
          ${renderChannelTemplateBlock(c)}
        </div>
      </div>
    `;
  }

  // ── Channel prices editor (per listing × fulfillment) ─────────────────────
  // Mirrors the SKU-patterns block. One row per combo the user wants priced.
  // Missing combo means the launch ticket shows "(no price rule set)" for
  // that SKU so the worker knows it isn't a covered case yet.
  function renderChannelPricesBlock(c) {
    const prices = (state.settings.channelPrices || {})[c.id];
    return `
      <div class="fv-pt-variant" style="margin-top:8px">
        <legend>Prices</legend>
        <p class="fv-muted" style="font-size:11.5px;margin:0 0 8px">
          One row per (listing type × fulfillment). The channel-launch ticket renders the matching price next to each SKU. No currency conversion — enter the number as it should appear in the worker's marketplace tool.
        </p>
        ${prices === undefined
          ? `<div class="fv-muted" style="font-size:12px">Loading prices…</div>`
          : prices.length === 0
            ? `<div class="fv-muted" style="font-size:12px;padding:6px 0">No prices for this channel yet — add the first row below.</div>`
            : `<table class="fv-table">
                <thead><tr><th>Listing type</th><th>Fulfilment</th><th>Price</th><th></th></tr></thead>
                <tbody>
                  ${prices.map(p => `
                    <tr>
                      <td>
                        <select class="fv-input fv-tinp" data-price-id="${p.id}" data-pr-field="listing_type">
                          ${state.settings.listingTypes.map(lt => `<option value="${lt}" ${p.listing_type === lt ? 'selected' : ''}>${escapeHtml(LISTING_TYPE_LABELS[lt] || lt)}</option>`).join('')}
                        </select>
                      </td>
                      <td>
                        <input class="fv-input fv-tinp" data-price-id="${p.id}" data-pr-field="fulfillment" value="${escapeAttr(p.fulfillment)}" placeholder="fba / fbm / wfs / —" style="max-width:100px"/>
                      </td>
                      <td>
                        <input class="fv-input fv-tinp" data-price-id="${p.id}" data-pr-field="price" value="${escapeAttr(p.price)}" placeholder="12.99" style="max-width:100px;font-family:ui-monospace,Menlo,Consolas,monospace"/>
                      </td>
                      <td class="fv-row-actions">
                        <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="save-price" data-channel-id="${c.id}" data-price-id="${p.id}">Save</button>
                        <button class="fv-btn fv-btn-ghost fv-btn-sm fv-btn-danger" data-act="delete-price" data-channel-id="${c.id}" data-price-id="${p.id}">Delete</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>`
        }
        ${state.settings.addingPriceFor === c.id
          ? renderAddPriceForm(c.id)
          : `<button class="fv-btn fv-btn-sec fv-btn-sm" data-act="show-add-price" data-channel-id="${c.id}" style="margin-top:8px">+ Add price row</button>`
        }
      </div>
    `;
  }

  function renderAddPriceForm(channelId) {
    return `
      <div class="fv-add-pattern">
        <select class="fv-input fv-tinp" id="new-price-listing-${channelId}">
          ${state.settings.listingTypes.map(lt => `<option value="${lt}">${escapeHtml(LISTING_TYPE_LABELS[lt] || lt)}</option>`).join('')}
        </select>
        <input class="fv-input fv-tinp" id="new-price-fulfillment-${channelId}" placeholder="fba / fbm / wfs / blank" style="max-width:140px"/>
        <input class="fv-input fv-tinp" id="new-price-value-${channelId}" placeholder="12.99" style="max-width:100px;font-family:ui-monospace,Menlo,Consolas,monospace"/>
        <button class="fv-btn fv-btn-primary fv-btn-sm" data-act="create-price" data-channel-id="${channelId}">Create</button>
        <button class="fv-btn fv-btn-ghost fv-btn-sm" data-act="cancel-add-price">Cancel</button>
      </div>
    `;
  }

  // ── Channel defaults editor (per-channel KV form) ─────────────────────────
  // Used by per-channel flat-file exporters (Amazon today; others can read
  // the same defaults later). Each key is freeform; the export code looks
  // up well-known keys (brand, manufacturer, product_type, item_type_keyword,
  // unspsc_code, country_of_origin, variation_theme, search_terms) and falls
  // back to its own default if a key is blank or missing.
  function renderChannelDefaultsBlock(c) {
    const defaults = (state.settings.channelDefaults || {})[c.id] || null;
    const KNOWN = [
      { key: 'brand',              label: 'Brand',                example: 'Syruvia' },
      { key: 'manufacturer',       label: 'Manufacturer',         example: 'Syruvia' },
      { key: 'product_type',       label: 'Product Type',         example: 'FOOD' },
      { key: 'item_type_keyword',  label: 'Item Type Keyword',    example: 'Coffee syrup' },
      { key: 'unspsc_code',        label: 'UNSPSC Code',          example: '50171922' },
      { key: 'country_of_origin',  label: 'Country of Origin',    example: 'US' },
      { key: 'variation_theme',    label: 'Variation Theme Name', example: 'Flavor Name' },
      { key: 'search_terms',       label: 'Search Terms (5 max, comma-separated)', example: 'coffee syrup, latte, espresso, barista, cafe' },
    ];
    return `
      <div class="fv-pt-variant" style="margin-top:8px">
        <legend>Channel defaults (used by flat-file exports)</legend>
        <p class="fv-muted" style="font-size:11.5px;margin:0 0 8px">
          These values flow into every flavor row exported for this channel. Blank fields fall back to the exporter's hardcoded fallback.
        </p>
        ${defaults === null
          ? `<div class="fv-muted" style="font-size:12px">Loading defaults…</div>`
          : `<div class="fv-defaults-grid">
              ${KNOWN.map(k => `
                <div class="fv-field-row">
                  <label class="fv-label">${escapeHtml(k.label)} <span class="fv-muted" style="font-size:10.5px">${escapeHtml(k.example)}</span></label>
                  <input class="fv-input fv-tinp" data-default-channel="${c.id}" data-default-key="${escapeAttr(k.key)}" value="${escapeAttr(defaults[k.key] || '')}" placeholder="${escapeAttr(k.example)}"/>
                </div>
              `).join('')}
            </div>
            <div style="margin-top:8px">
              <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="save-channel-defaults" data-channel-id="${c.id}">Save defaults</button>
            </div>`
        }
      </div>
    `;
  }

  function renderChannelTemplateBlock(c) {
    const tpl = (state.settings.channelTemplates || {})[c.id];
    return `
      <div class="fv-pt-variant" style="margin-top:8px">
        <legend>Flat-file template</legend>
        <p class="fv-muted" style="font-size:11.5px;margin:0 0 8px">
          Upload the channel's blank flat-file template (e.g. the Amazon inventory file). The exporter copies the template, injects one row per (listing × fulfillment) of the flavor, and serves the filled file back. One template per channel — re-upload to replace.
        </p>
        ${tpl === undefined
          ? `<div class="fv-muted" style="font-size:12px">Loading template status…</div>`
          : tpl && tpl.exists
            ? `<div class="fv-listing-status" style="margin-bottom:8px">
                 ✓ Template uploaded · ${(tpl.size / 1024).toFixed(0)} KB · ${escapeHtml((tpl.uploaded_at || '').slice(0, 19))}
               </div>`
            : `<div class="fv-muted" style="font-size:12px;margin-bottom:8px">No template uploaded yet.</div>`
        }
        <div style="display:flex;align-items:center;gap:8px">
          <input type="file" id="tpl-file-${c.id}" accept=".xlsm,.xlsx" style="font-size:12px"/>
          <button class="fv-btn fv-btn-sec fv-btn-sm" data-act="upload-template" data-channel-id="${c.id}">${tpl && tpl.exists ? 'Replace template' : 'Upload template'}</button>
        </div>
      </div>
    `;
  }

  function previewPattern(template, sku) {
    return String(template || '').replace(/\(SKU\)/g, sku);
  }

  function renderAddPatternForm(channelId) {
    return `
      <div class="fv-add-pattern">
        <select class="fv-input fv-tinp" id="new-pattern-listing-${channelId}">
          ${state.settings.listingTypes.map(lt => `<option value="${lt}">${escapeHtml(LISTING_TYPE_LABELS[lt] || lt)}</option>`).join('')}
        </select>
        <input class="fv-input fv-tinp" id="new-pattern-fulfillment-${channelId}" placeholder="fba / fbm / wfs / blank" style="max-width:140px"/>
        <input class="fv-input fv-tinp" id="new-pattern-template-${channelId}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px" placeholder="F-(SKU)-NP" />
        <button class="fv-btn fv-btn-primary fv-btn-sm" data-act="create-pattern" data-channel-id="${channelId}">Create</button>
        <button class="fv-btn fv-btn-ghost fv-btn-sm" data-act="cancel-add-pattern">Cancel</button>
      </div>
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
                   <div class="fv-example-name">
                     ${e.is_raw_example ? '<span class="fv-mode-badge fv-mode-badge-raw">PASTE</span>' : ''}
                     ${escapeHtml(e.name)}
                   </div>
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
    const isRaw = !!ex.is_raw_example;
    const flavors = state.flavors || [];
    const headerHint = isRaw
      ? 'Paste your real listing copy as-is. Pick the source flavor so the generator knows what to swap (name, syrup colour, type label) when creating content for new flavors.'
      : 'Use <code>{placeholders}</code> inline so the generator substitutes flavor-specific values. Click any placeholder in the sidebar to copy.';
    return `
      <div class="fv-settings-head">
        <div>
          <h2>${ex.id ? 'Edit example' : 'New example'}</h2>
          <p class="fv-muted">${headerHint}</p>
        </div>
        <div class="fv-row-actions">
          ${ex.id ? `<button class="fv-btn fv-btn-sec" data-act="duplicate-example" data-id="${ex.id}" title="Create a copy of this template (good for cloning per type combo)">⎘ Duplicate</button>` : ''}
          <button class="fv-btn fv-btn-sec" data-act="cancel-example">Cancel</button>
          <button class="fv-btn fv-btn-primary" data-act="save-example">${ex.id ? 'Save changes' : 'Create example'}</button>
        </div>
      </div>

      <div class="fv-mode-toggle">
        <button class="fv-mode ${!isRaw ? 'active' : ''}" data-act="set-example-mode" data-mode="template" type="button">
          <span class="fv-mode-icon">🧩</span>
          <span class="fv-mode-body">
            <b>Template mode</b>
            <span>Author with {placeholders}</span>
          </span>
        </button>
        <button class="fv-mode ${isRaw ? 'active' : ''}" data-act="set-example-mode" data-mode="raw" type="button">
          <span class="fv-mode-icon">📋</span>
          <span class="fv-mode-body">
            <b>Paste mode</b>
            <span>Paste a real listing, pick source flavor</span>
          </span>
        </button>
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

          ${isRaw ? `
            <div class="fv-field-row">
              <label class="fv-label">Source flavor <span style="color:var(--fv-danger)">*</span></label>
              <select class="fv-input" data-ex-field="source_flavor_id">
                <option value="">— pick the flavor this example was written for —</option>
                ${flavors.map(fl => `<option value="${fl.id}" ${Number(ex.source_flavor_id) === fl.id ? 'selected' : ''}>${escapeHtml(fl.name)} (${fl.type === 'sugar_free' ? 'SF' : 'Reg'})</option>`).join('')}
              </select>
              <p class="fv-muted" style="font-size:11px;margin:4px 0 0">
                On generate, the engine swaps this flavor's name + syrup colour + type label for the target flavor's values. Other words stay as-pasted.
              </p>
            </div>
          ` : ''}

          <div class="fv-field-row">
            <label class="fv-label">Title ${isRaw ? '(paste literal)' : 'template'}</label>
            <input class="fv-input" data-ex-field="title_template" value="${escapeAttr(ex.title_template || '')}" placeholder="${isRaw ? 'Paste the exact title from your existing listing' : 'e.g. {is_natural}{name} Coffee Syrup — 25.4 fl oz'}"/>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Bullet points (one per line, 1-10)</label>
            <textarea class="fv-input fv-textarea" data-ex-field="bullets" rows="6" placeholder="${isRaw ? 'Paste each bullet on its own line.' : 'Each line becomes a bullet. Use {placeholders} inline.'}">${escapeHtml(bullets.join('\n'))}</textarea>
          </div>

          <div class="fv-field-row">
            <label class="fv-label">Description</label>
            <textarea class="fv-input fv-textarea" data-ex-field="description_template" rows="6" placeholder="${isRaw ? 'Paste the long description from the existing listing.' : 'Long description with {placeholders}.'}">${escapeHtml(ex.description_template || '')}</textarea>
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
          ${isRaw ? `
            <div class="fv-preview-head">Auto-swapped tokens</div>
            <p class="fv-muted" style="font-size:11.5px;line-height:1.5">When generating for a new flavor, these tokens from the source flavor are replaced with the target flavor's values:</p>
            <ul class="fv-placeholder-list">
              <li><button class="fv-placeholder" disabled><code>{name}</code><span>Flavor name (case-preserved)</span></button></li>
              <li><button class="fv-placeholder" disabled><code>{syrup_color}</code><span>Syrup color hint, if set on both</span></button></li>
              <li><button class="fv-placeholder" disabled><code>Regular ↔ Sugar-Free</code><span>Type label, both casings</span></button></li>
            </ul>
            <p class="fv-muted" style="font-size:11px;line-height:1.5;margin-top:8px">
              <b>Not auto-swapped:</b> "natural" / "caramel" (color words) and "coffee" / "fruity" (use words) — they appear in ingredient lists and English prose, so swapping them would corrupt the copy. Edit the generated ticket if needed.
            </p>
          ` : `
            <div class="fv-preview-head">Placeholders</div>
            <p class="fv-muted" style="font-size:11.5px;line-height:1.5">Click to copy, paste into any field.</p>
            <ul class="fv-placeholder-list">
              ${PLACEHOLDERS.map(([k, hint]) => `
                <li><button class="fv-placeholder" data-act="copy-placeholder" data-value="${escapeAttr(k)}"><code>${escapeHtml(k)}</code><span>${escapeHtml(hint)}</span></button></li>
              `).join('')}
            </ul>
          `}
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

  // ── Generate-images modal ─────────────────────────────────────────────────
  // Confirmation step before POST. Shows per-channel image slot counts and
  // whether Amazon EBC will spawn (only fires when the seeded "amazon"
  // channel is enabled — admin can disable it and skip EBC entirely).
  function renderGenerateImagesModal() {
    const m = state.generateImagesModal;
    const f = state.detail;
    const enabledChannels = (m.channels || []).filter(c => c.enabled);
    const isSF = f.type === 'sugar_free';
    const additional = isSF ? 8 : 7;
    const totalSlots = enabledChannels.length * (1 + additional);
    const amazon = enabledChannels.find(c => c.code === 'amazon');
    return `
      <div class="fv-modal-overlay" data-act="dismiss-modal" data-modal="generate-images">
        <div class="fv-modal fv-modal-wide">
          <h2>Create image tickets</h2>
          <p class="fv-modal-body">
            One product-image ticket with subtasks for every image slot
            ${amazon ? ' + one Amazon EBC ticket' : ''}.
            Designers attach the final file to each subtask via the standard upload flow.
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
                  <div class="fv-gen-imgcount">
                    1 main + ${additional} additional ${isSF ? '<span class="fv-muted">(SF gets 1 extra)</span>' : ''}
                  </div>
                </div>
              `).join('')}
              ${amazon ? `
                <div class="fv-gen-channel" style="border:1px dashed var(--fv-border-strong);background:transparent">
                  <div class="fv-gen-channel-head">
                    <span class="fv-gen-channel-name">📐 Amazon EBC</span>
                    <span class="fv-meta-pill">A+ Content</span>
                  </div>
                  <div class="fv-gen-imgcount">5 default modules (add more on the ticket if needed)</div>
                </div>
              ` : ''}
            </div>

            <div class="fv-gen-total">
              <b>${totalSlots}</b> product-image slot${totalSlots === 1 ? '' : 's'}
              ${amazon ? ` + <b>5</b> EBC module slots` : ''}
            </div>
          ` : ''}

          ${m.error ? `<div class="fv-error">${escapeHtml(m.error)}</div>` : ''}

          <div class="fv-modal-actions">
            <button class="fv-btn fv-btn-sec" data-act="close-generate-images-modal">Cancel</button>
            <button class="fv-btn fv-btn-primary"
                    data-act="confirm-generate-images"
                    ${(m.submitting || enabledChannels.length === 0) ? 'disabled' : ''}>
              ${m.submitting ? 'Creating tickets…' : (amazon ? 'Create 2 tickets' : 'Create 1 ticket')}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Generate-channel-SKUs modal ───────────────────────────────────────────
  // Confirmation step. Shows each enabled channel, the SKU pattern that
  // will be applied, and a sample generated SKU per listing type so the
  // user can sanity-check their pattern before spawning a pile of rows
  // (e.g. 3 channels with FBA + 4 listing types = 32 SKUs).
  function renderGenerateChannelSkusModal() {
    const m = state.generateChannelSkusModal;
    const f = state.detail;
    const enabledChannels = (m.channels || []).filter(c => c.enabled);
    const patterns = m.patterns || [];

    // Group patterns by channel for the per-channel preview blocks.
    const patternsByChannel = new Map();
    for (const p of patterns) {
      if (!patternsByChannel.has(p.channel_id)) patternsByChannel.set(p.channel_id, []);
      patternsByChannel.get(p.channel_id).push(p);
    }
    const channelsWithPatterns = enabledChannels.filter(c => patternsByChannel.has(c.id));
    const channelsWithoutPatterns = enabledChannels.filter(c => !patternsByChannel.has(c.id));
    const totalSkus = patterns.reduce((n) => n + 1, 0);
    const totalLaunchTickets = channelsWithPatterns.length;

    // Compute pattern combos that have no matching price rule, so the user
    // can fix it before generating. Keyed by `${channelId}|${listing}|${ff}`.
    const priceKeys = new Set();
    for (const p of (m.prices || [])) {
      priceKeys.add(`${p.channel_id}|${p.listing_type}|${p.fulfillment || ''}`);
    }
    const skusMissingPrice = patterns.filter(p =>
      !priceKeys.has(`${p.channel_id}|${p.listing_type}|${p.fulfillment || ''}`)
    );

    function previewSku(p) {
      return String(p.template || '').replace(/\(SKU\)/g, f.sku || '');
    }

    return `
      <div class="fv-modal-overlay" data-act="dismiss-modal" data-modal="generate-channel-skus">
        <div class="fv-modal fv-modal-wide">
          <h2>Generate channel SKUs &amp; launch tickets</h2>
          <p class="fv-modal-body">
            One channel SKU per pattern row defined in Settings → Channels. Each channel
            with at least one pattern also gets a launch ticket bundling its SKUs +
            cross-references to listing content and image tickets, plus one SKU mapping
            ticket covers all of them.
            ${enabledChannels.length === 0 ? '<br/><br/><b>No enabled channels</b> — add or enable one in Settings → Channels.' : ''}
          </p>

          ${channelsWithPatterns.length > 0 ? `
            <div class="fv-gen-channels">
              ${channelsWithPatterns.map(c => `
                <div class="fv-gen-channel">
                  <div class="fv-gen-channel-head">
                    <span class="fv-gen-channel-name">${escapeHtml(c.name)}</span>
                    <span class="fv-muted" style="font-size:11px">${(patternsByChannel.get(c.id) || []).length} SKU${(patternsByChannel.get(c.id) || []).length === 1 ? '' : 's'}</span>
                  </div>
                  <ul class="fv-gen-variants">
                    ${(patternsByChannel.get(c.id) || []).map(p => `
                      <li>
                        <span class="fv-gen-variant-label">${escapeHtml(LISTING_TYPE_LABELS[p.listing_type] || p.listing_type)}${p.fulfillment ? ' · ' + escapeHtml(p.fulfillment.toUpperCase()) : ''}</span>
                        <span class="fv-gen-variant-tpl"><code>${escapeHtml(previewSku(p))}</code></span>
                      </li>
                    `).join('')}
                  </ul>
                </div>
              `).join('')}
            </div>
            ${channelsWithoutPatterns.length > 0 ? `
              <div class="fv-error" style="background:#fffbeb;color:#92400e;border-color:#fde68a">
                ⚠ ${channelsWithoutPatterns.length} enabled channel${channelsWithoutPatterns.length === 1 ? '' : 's'} have no SKU patterns and will be <b>skipped</b>: ${channelsWithoutPatterns.map(c => escapeHtml(c.name)).join(', ')}. Add patterns in Settings → Channels.
              </div>
            ` : ''}
            ${skusMissingPrice.length > 0 ? `
              <div class="fv-error" style="background:#fffbeb;color:#92400e;border-color:#fde68a">
                ⚠ ${skusMissingPrice.length} SKU${skusMissingPrice.length === 1 ? '' : 's'} will be generated without a price rule and will show "(no price rule set)" in the launch ticket. Add prices in Settings → Channels (Prices block) — you can still generate now and add prices later, but workers will need them before listings go live.
              </div>
            ` : ''}
            <div class="fv-gen-total">
              <b>${totalSkus}</b> channel SKU${totalSkus === 1 ? '' : 's'} + <b>${totalLaunchTickets}</b> launch ticket${totalLaunchTickets === 1 ? '' : 's'} + <b>1</b> mapping ticket
            </div>
          ` : enabledChannels.length > 0 ? `
            <div class="fv-error" style="background:#fef2f2">
              No enabled channel has any SKU patterns defined. Add patterns in Settings → Channels (expand a channel card) before generating.
            </div>
          ` : ''}

          ${m.error ? `<div class="fv-error">${escapeHtml(m.error)}</div>` : ''}

          <div class="fv-modal-actions">
            <button class="fv-btn fv-btn-sec" data-act="close-generate-channel-skus-modal">Cancel</button>
            <button class="fv-btn fv-btn-primary"
                    data-act="confirm-generate-channel-skus"
                    ${(m.submitting || channelsWithPatterns.length === 0) ? 'disabled' : ''}>
              ${m.submitting ? 'Generating…' : 'Generate'}
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
      if (state.generateImagesModal && !state.generateImagesModal.submitting) {
        state.generateImagesModal = null;
        return render();
      }
      if (state.generateChannelSkusModal && !state.generateChannelSkusModal.submitting) {
        state.generateChannelSkusModal = null;
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
          if (which === 'generate-listings')           state.generateListingsModal = null;
          else if (which === 'generate-images')        state.generateImagesModal = null;
          else if (which === 'generate-channel-skus')  state.generateChannelSkusModal = null;
          else                                          state.deleteModal = null;
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
      if (name === 'toggle-pt') {
        const id = Number(act.getAttribute('data-id'));
        state.settings.expandedProductType = (state.settings.expandedProductType === id) ? null : id;
        return render();
      }
      if (name === 'save-pt') return saveProductType(Number(act.getAttribute('data-id')));
      if (name === 'add-variation') {
        state.settings.editingVariation = blankVariation();
        return render();
      }
      if (name === 'edit-variation') {
        const id = Number(act.getAttribute('data-id'));
        const v = (state.settings.variations || []).find(x => x.id === id);
        if (v) {
          state.settings.editingVariation = { ...v };
          render();
        }
        return;
      }
      if (name === 'cancel-variation') {
        state.settings.editingVariation = null;
        return render();
      }
      if (name === 'save-variation') return saveVariation();
      if (name === 'delete-variation') return deleteVariation(Number(act.getAttribute('data-id')));
      if (name === 'add-channel')     return addChannel();
      if (name === 'save-channel')    return saveChannel(Number(act.getAttribute('data-channel-id')));
      if (name === 'delete-channel')  return deleteChannel(Number(act.getAttribute('data-channel-id')));
      if (name === 'toggle-channel') {
        const id = Number(act.getAttribute('data-id'));
        if (state.settings.expandedChannel === id) {
          state.settings.expandedChannel = null;
        } else {
          state.settings.expandedChannel = id;
          // Lazy-load patterns + prices + defaults + template status when expanded.
          loadChannelPatterns(id);
          loadChannelPrices(id);
          loadChannelDefaults(id);
          loadChannelTemplate(id);
        }
        return render();
      }
      if (name === 'save-channel-defaults') return saveChannelDefaults(Number(act.getAttribute('data-channel-id')));
      if (name === 'upload-template')        return uploadChannelTemplate(Number(act.getAttribute('data-channel-id')));
      if (name === 'show-add-pattern') {
        state.settings.addingPatternFor = Number(act.getAttribute('data-channel-id'));
        return render();
      }
      if (name === 'cancel-add-pattern') {
        state.settings.addingPatternFor = null;
        return render();
      }
      if (name === 'create-pattern')  return createPattern(Number(act.getAttribute('data-channel-id')));
      if (name === 'save-pattern')    return savePattern(Number(act.getAttribute('data-channel-id')), Number(act.getAttribute('data-pattern-id')));
      if (name === 'delete-pattern')  return deletePattern(Number(act.getAttribute('data-channel-id')), Number(act.getAttribute('data-pattern-id')));
      if (name === 'show-add-price') {
        state.settings.addingPriceFor = Number(act.getAttribute('data-channel-id'));
        return render();
      }
      if (name === 'cancel-add-price') {
        state.settings.addingPriceFor = null;
        return render();
      }
      if (name === 'create-price')   return createPrice(Number(act.getAttribute('data-channel-id')));
      if (name === 'save-price')     return savePrice(Number(act.getAttribute('data-channel-id')), Number(act.getAttribute('data-price-id')));
      if (name === 'delete-price')   return deletePrice(Number(act.getAttribute('data-channel-id')), Number(act.getAttribute('data-price-id')));
      if (name === 'new-example')     { state.settings.editingExample = blankExample(); return render(); }
      if (name === 'edit-example')    return editExample(Number(act.getAttribute('data-id')));
      if (name === 'cancel-example')  { state.settings.editingExample = null; return render(); }
      if (name === 'save-example')    return saveExample();
      if (name === 'set-example-mode') {
        if (!state.settings.editingExample) return;
        const mode = act.getAttribute('data-mode');
        state.settings.editingExample.is_raw_example = (mode === 'raw');
        // Switching back to template mode drops the source flavor — it has
        // no meaning without raw paste, and surfacing it on save would be
        // confusing.
        if (mode !== 'raw') state.settings.editingExample.source_flavor_id = null;
        return render();
      }
      if (name === 'duplicate-example') {
        const id = Number(act.getAttribute('data-id'));
        if (id) return duplicateExample(id);
      }
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
      if (name === 'lc-tab') {
        state.listingTab = act.getAttribute('data-variant');
        return render();
      }
      if (name === 'save-listing-variant')      return saveListingVariant(act.getAttribute('data-variant'));
      if (name === 'regenerate-listing-content') return regenerateListingContent();
      if (name === 'approve-and-spawn-listings') return approveAndSpawnListings();
      if (name === 'propagate-from-single')      return propagateFromSingle();
      if (name === 'open-generate-images')         return openGenerateImages();
      if (name === 'close-generate-images-modal')  { state.generateImagesModal = null; return render(); }
      if (name === 'confirm-generate-images')      return confirmGenerateImages();
      if (name === 'open-generate-channel-skus')         return openGenerateChannelSkus();
      if (name === 'close-generate-channel-skus-modal')  { state.generateChannelSkusModal = null; return render(); }
      if (name === 'confirm-generate-channel-skus')      return confirmGenerateChannelSkus();
      if (name === 'generate-variation-ticket')          return generateVariationTicket();
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
    // Variation editor — same pattern as the example editor: capture into
    // state.settings.editingVariation so unsaved values survive a re-render
    // (e.g. when the user switches the channel dropdown, which triggers
    // an onChange that re-renders).
    const vrField = e.target.getAttribute && e.target.getAttribute('data-vr-field');
    if (vrField && state.settings.editingVariation) {
      const v = e.target;
      state.settings.editingVariation[vrField] =
        v.type === 'checkbox' ? v.checked :
        v.tagName === 'SELECT' && vrField === 'channel_id' ? (v.value ? Number(v.value) : null) :
        v.value;
      return;
    }
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
    // Variation editor <select> + checkbox change events.
    const vr = e.target.getAttribute && e.target.getAttribute('data-vr-field');
    if (vr && state.settings.editingVariation) {
      const v = e.target;
      state.settings.editingVariation[vr] =
        v.type === 'checkbox' ? v.checked :
        v.tagName === 'SELECT' && vr === 'channel_id' ? (v.value ? Number(v.value) : null) :
        v.value;
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
      case 5: return w.use_of_syrup ? '' : 'Pick a product type.';
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
      is_raw_example: false, source_flavor_id: null,
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
    const [chRes, exRes, ltRes, ptRes, vrRes] = await Promise.all([
      fetch('/api/flavors2/settings/channels'),
      fetch('/api/flavors2/settings/examples'),
      fetch('/api/flavors2/settings/listing-types'),
      fetch('/api/flavors2/settings/product-types'),
      fetch('/api/flavors2/settings/variation-listings'),
    ]);
    if (!chRes.ok || !exRes.ok || !ltRes.ok || !ptRes.ok || !vrRes.ok) {
      throw new Error('Could not load settings');
    }
    state.settings.channels = await chRes.json();
    state.settings.examples = await exRes.json();
    state.settings.productTypes = await ptRes.json();
    state.settings.variations = await vrRes.json();
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
    // don't re-render on every keystroke for the channels card).
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

  // ── SKU patterns per channel ─────────────────────────────────────────────
  async function loadChannelPatterns(channelId) {
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/sku-patterns`);
      if (!r.ok) throw new Error('Could not load patterns');
      state.settings.channelPatterns[channelId] = await r.json();
      render();
    } catch (e) {
      state.settings.channelPatterns[channelId] = [];
      render();
    }
  }

  async function createPattern(channelId) {
    const listingEl     = document.getElementById('new-pattern-listing-' + channelId);
    const fulfillmentEl = document.getElementById('new-pattern-fulfillment-' + channelId);
    const templateEl    = document.getElementById('new-pattern-template-' + channelId);
    const body = {
      listing_type: listingEl ? listingEl.value : 'single',
      fulfillment: fulfillmentEl ? fulfillmentEl.value.trim() : '',
      template: templateEl ? templateEl.value.trim() : '',
    };
    if (!body.template) { alert('Template is required.'); return; }
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/sku-patterns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Create failed');
      await loadChannelPatterns(channelId);
      state.settings.addingPatternFor = null;
      render();
    } catch (e) { alert('Could not create pattern: ' + (e.message || '')); }
  }

  async function savePattern(channelId, patternId) {
    const listingEl     = document.querySelector(`[data-pattern-id="${patternId}"][data-pf-field="listing_type"]`);
    const fulfillmentEl = document.querySelector(`[data-pattern-id="${patternId}"][data-pf-field="fulfillment"]`);
    const templateEl    = document.querySelector(`[data-pattern-id="${patternId}"][data-pf-field="template"]`);
    const body = {
      listing_type: listingEl ? listingEl.value : undefined,
      fulfillment: fulfillmentEl ? fulfillmentEl.value.trim() : undefined,
      template: templateEl ? templateEl.value.trim() : undefined,
    };
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/sku-patterns/${patternId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      const list = state.settings.channelPatterns[channelId] || [];
      const idx = list.findIndex(p => p.id === patternId);
      if (idx !== -1) list[idx] = data;
      render();
      flashToast('Pattern saved.');
    } catch (e) { alert('Could not save pattern: ' + (e.message || '')); }
  }

  async function loadChannelDefaults(channelId) {
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/defaults`);
      state.settings.channelDefaults[channelId] = r.ok ? await r.json() : {};
      render();
    } catch (_) {
      state.settings.channelDefaults[channelId] = {};
      render();
    }
  }

  async function saveChannelDefaults(channelId) {
    const inputs = document.querySelectorAll(`[data-default-channel="${channelId}"][data-default-key]`);
    const body = {};
    inputs.forEach(el => {
      body[el.getAttribute('data-default-key')] = el.value;
    });
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/defaults`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      state.settings.channelDefaults[channelId] = data;
      flashToast('Defaults saved.');
      render();
    } catch (e) { alert('Could not save defaults: ' + (e.message || '')); }
  }

  async function loadChannelTemplate(channelId) {
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/template`);
      state.settings.channelTemplates[channelId] = r.ok ? await r.json() : { exists: false };
      render();
    } catch (_) {
      state.settings.channelTemplates[channelId] = { exists: false };
      render();
    }
  }

  async function uploadChannelTemplate(channelId) {
    const fileInput = document.getElementById('tpl-file-' + channelId);
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      alert('Pick a file first.');
      return;
    }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/template`, {
        method: 'POST',
        body: fd,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Upload failed');
      await loadChannelTemplate(channelId);
      flashToast('Template uploaded.');
    } catch (e) { alert('Could not upload template: ' + (e.message || '')); }
  }

  async function deletePattern(channelId, patternId) {
    if (!confirm('Delete this SKU pattern? Existing channel SKUs already generated for flavors aren\'t affected — only future generations stop emitting this row.')) return;
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/sku-patterns/${patternId}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Delete failed'); }
      await loadChannelPatterns(channelId);
    } catch (e) { alert('Could not delete: ' + (e.message || '')); }
  }

  // ── Price rules per channel ──────────────────────────────────────────────
  async function loadChannelPrices(channelId) {
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/price-rules`);
      state.settings.channelPrices[channelId] = r.ok ? await r.json() : [];
      render();
    } catch (_) {
      state.settings.channelPrices[channelId] = [];
      render();
    }
  }

  async function createPrice(channelId) {
    const listingEl     = document.getElementById('new-price-listing-' + channelId);
    const fulfillmentEl = document.getElementById('new-price-fulfillment-' + channelId);
    const priceEl       = document.getElementById('new-price-value-' + channelId);
    const body = {
      listing_type: listingEl ? listingEl.value : 'single',
      fulfillment: fulfillmentEl ? fulfillmentEl.value.trim() : '',
      price: priceEl ? priceEl.value.trim() : '',
    };
    if (!body.price) { alert('Price is required.'); return; }
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/price-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Create failed');
      await loadChannelPrices(channelId);
      state.settings.addingPriceFor = null;
      render();
    } catch (e) { alert('Could not create price: ' + (e.message || '')); }
  }

  async function savePrice(channelId, priceId) {
    const listingEl     = document.querySelector(`[data-price-id="${priceId}"][data-pr-field="listing_type"]`);
    const fulfillmentEl = document.querySelector(`[data-price-id="${priceId}"][data-pr-field="fulfillment"]`);
    const priceEl       = document.querySelector(`[data-price-id="${priceId}"][data-pr-field="price"]`);
    const body = {
      listing_type: listingEl ? listingEl.value : undefined,
      fulfillment: fulfillmentEl ? fulfillmentEl.value.trim() : undefined,
      price: priceEl ? priceEl.value.trim() : undefined,
    };
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/price-rules/${priceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      const list = state.settings.channelPrices[channelId] || [];
      const idx = list.findIndex(p => p.id === priceId);
      if (idx !== -1) list[idx] = data;
      render();
      flashToast('Price saved.');
    } catch (e) { alert('Could not save price: ' + (e.message || '')); }
  }

  async function deletePrice(channelId, priceId) {
    if (!confirm('Delete this price rule? Tickets that already reference it aren\'t edited — only future launch tickets stop showing the price.')) return;
    try {
      const r = await fetch(`/api/flavors2/settings/channels/${channelId}/price-rules/${priceId}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Delete failed'); }
      await loadChannelPrices(channelId);
    } catch (e) { alert('Could not delete: ' + (e.message || '')); }
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

  // ── Variation listings (Settings + per-flavor) ────────────────────────────
  function blankVariation() {
    return {
      id: null, channel_id: null, name: '',
      flavor_type_filter: 'any', listing_type_filter: 'any',
      external_id: '', notes: '', enabled: true,
    };
  }

  async function saveVariation() {
    const v = state.settings.editingVariation;
    if (!v) return;
    if (!v.name || !v.name.trim()) { alert('Give the variation a name.'); return; }
    if (!Number(v.channel_id))     { alert('Pick a channel.'); return; }
    const body = {
      channel_id: Number(v.channel_id),
      name: v.name.trim(),
      flavor_type_filter: v.flavor_type_filter || 'any',
      listing_type_filter: v.listing_type_filter || 'any',
      external_id: (v.external_id || '').trim(),
      notes: v.notes || '',
      enabled: v.enabled !== false,
    };
    try {
      const url = v.id
        ? `/api/flavors2/settings/variation-listings/${v.id}`
        : '/api/flavors2/settings/variation-listings';
      const r = await fetch(url, {
        method: v.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      await loadSettings();
      state.settings.editingVariation = null;
      render();
      flashToast('Variation listing saved.');
    } catch (e) { alert('Could not save: ' + (e.message || '')); }
  }

  async function deleteVariation(id) {
    const v = (state.settings.variations || []).find(x => x.id === id);
    if (!v) return;
    if (!confirm(`Delete variation "${v.name}"? Existing tickets that reference it stay intact, but new flavors won't see this variation in their match list.`)) return;
    try {
      const r = await fetch(`/api/flavors2/settings/variation-listings/${id}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Delete failed'); }
      await loadSettings();
      render();
    } catch (e) { alert('Could not delete: ' + (e.message || '')); }
  }

  // ── Product types (Build A) ───────────────────────────────────────────────
  // Read every input inside the expanded card and PATCH the row. Inputs use
  // data-pt-id + data-pt-field attributes so we can collect them without
  // tracking each one in state — convenient because the card has ~15 fields
  // and only mutates on Save (no live state echoing required).
  async function saveProductType(id) {
    const body = {};
    const inputs = document.querySelectorAll(`[data-pt-id="${id}"][data-pt-field]`);
    inputs.forEach(el => {
      const field = el.getAttribute('data-pt-field');
      let val;
      if (el.type === 'checkbox')      val = el.checked;
      else                              val = el.value;
      // Bullets fields ship as newline-joined text — server splits.
      body[field] = val;
    });
    if (Object.keys(body).length === 0) return;
    try {
      const r = await fetch(`/api/flavors2/settings/product-types/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      // Patch the row in state in-place so the expanded card re-renders
      // with the canonical server-side values (e.g. bullets normalised).
      const idx = state.settings.productTypes.findIndex(p => p.id === id);
      if (idx !== -1) state.settings.productTypes[idx] = data;
      render();
      flashToast(`Saved ${data.name}.`);
    } catch (e) {
      alert('Could not save: ' + (e.message || ''));
    }
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

  // Duplicate the saved version of an example. If the user has unsaved
  // edits in the editor, those are intentionally NOT carried over — they
  // should hit Save first to persist, then Duplicate. We surface that
  // expectation in a confirm dialog the first time it matters.
  async function duplicateExample(id) {
    const editing = state.settings.editingExample;
    if (editing && editing.id === id) {
      // Heuristic: if any of the rendered inputs differ from saved state,
      // warn. Cheap — just check title / description / mode flags.
      const saved = state.settings.examples.find(e => e.id === id);
      const hasUnsaved = saved && (
        saved.title_template !== editing.title_template ||
        saved.description_template !== editing.description_template ||
        saved.keywords !== editing.keywords ||
        saved.name !== editing.name ||
        saved.is_raw_example !== editing.is_raw_example
      );
      if (hasUnsaved && !confirm('You have unsaved edits. Duplicate will copy the SAVED version, not what you see in the editor. Continue?')) {
        return;
      }
    }
    try {
      const r = await fetch(`/api/flavors2/settings/examples/${id}/duplicate`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Duplicate failed');
      await loadSettings();
      state.settings.editingExample = {
        ...data,
        bullets: Array.isArray(data.bullets) ? [...data.bullets] : [],
      };
      render();
      flashToast('Template duplicated — change the type combo and tweak the copy.');
    } catch (e) {
      alert('Could not duplicate: ' + (e.message || ''));
    }
  }

  async function saveExample() {
    const ex = state.settings.editingExample;
    if (!ex) return;
    if (!ex.name || !ex.name.trim()) { alert('Template needs a name.'); return; }
    if (ex.is_raw_example && !Number(ex.source_flavor_id)) {
      alert('Pick a source flavor — the engine needs to know whose name + colour + type label to swap when generating for new flavors.');
      return;
    }
    const body = {
      name: ex.name, syrup_use: ex.syrup_use, flavor_type: ex.flavor_type,
      listing_type: ex.listing_type,
      title_template: ex.title_template || '',
      bullets: (ex.bullets || []).map(b => String(b).trim()).filter(Boolean),
      description_template: ex.description_template || '',
      keywords: ex.keywords || '',
      notes: ex.notes || '',
      is_raw_example: !!ex.is_raw_example,
      source_flavor_id: ex.is_raw_example ? Number(ex.source_flavor_id) : null,
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

  // ── Listing content preview / approve (Build B) ──────────────────────────
  // Read every input for this variant from the DOM (textareas only auto-
  // commit on blur; here we collect them all on Save).
  async function saveListingVariant(variant) {
    if (!state.detailId || !variant) return;
    const titleEl = document.querySelector(`textarea[data-lc-variant="${variant}"][data-lc-field="title"]`);
    const bulletsEl = document.querySelector(`textarea[data-lc-variant="${variant}"][data-lc-field="bullets"]`);
    const descEl = document.querySelector(`textarea[data-lc-variant="${variant}"][data-lc-field="description"]`);
    const body = {};
    if (titleEl)   body.title = titleEl.value;
    if (bulletsEl) body.bullets = bulletsEl.value.split('\n');
    if (descEl)    body.description = descEl.value;
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}/listing-content/${variant}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      // Patch in place so the editor doesn't lose other unsaved tabs.
      if (state.listingContent && state.listingContent.variants) {
        const idx = state.listingContent.variants.findIndex(v => v.listing_variant === variant);
        if (idx !== -1) state.listingContent.variants[idx] = data;
      }
      render();
      flashToast(`${LISTING_TYPE_LABELS[variant] || variant} saved.`);
    } catch (e) { alert('Could not save: ' + (e.message || '')); }
  }

  // Save the visible single-tab edits, then POST /propagate which: (a)
  // approves single, (b) generates the other 3 variants by carrying single's
  // bullets + description forward and swapping in the packs title / pump
  // suffix per the product type. Switches the UI from "single only" to
  // "4 tabs" automatically because state.listingContent.variants now has 4.
  async function propagateFromSingle() {
    if (!state.detailId || state.listingSubmitting) return;
    state.listingSubmitting = true;
    render();
    try {
      // Persist any unsaved edits in the single tab before propagating.
      await saveListingVariant('single');
      const r = await fetch(`/api/flavors2/${state.detailId}/listing-content/propagate`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Propagate failed');
      state.listingContent = {
        needs_setup: false,
        product_type_key: state.detail?.use_of_syrup || null,
        variants: data.variants,
      };
      state.listingTab = 'single_with_pump';  // jump to the next variant the user will review
      state.listingSubmitting = false;
      render();
      flashToast('Other variants generated — review and approve all to spawn channel tickets.');
    } catch (e) {
      state.listingSubmitting = false;
      render();
      alert('Could not generate other variants: ' + (e.message || ''));
    }
  }

  async function regenerateListingContent() {
    if (!state.detailId) return;
    if (!confirm('Discard the current edits and regenerate from the product-type template?')) return;
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}/listing-content/regenerate`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Regenerate failed');
      state.listingContent = { needs_setup: false, product_type_key: state.detail?.use_of_syrup || null, variants: data.variants };
      render();
      flashToast('Listing content regenerated from template.');
    } catch (e) { alert('Could not regenerate: ' + (e.message || '')); }
  }

  async function approveAndSpawnListings() {
    if (!state.detailId || state.listingSubmitting) return;
    state.listingSubmitting = true;
    render();
    try {
      // Save the currently-visible tab first so its in-flight edits are
      // included in the approval. Other tabs were saved by the user
      // explicitly via "Save this variant".
      const activeTab = state.listingTab || 'single';
      const hasUnsavedActive = !!document.querySelector(`textarea[data-lc-variant="${activeTab}"]`);
      if (hasUnsavedActive) await saveListingVariant(activeTab);

      // Approve only — no per-channel ticket spawn. Channel launch tickets
      // (created later via Channel SKUs) reference the flavor page for
      // content, and the Amazon flat-file export pulls the approved copy
      // directly.
      const r = await fetch(`/api/flavors2/${state.detailId}/listing-content/approve-all`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Approve failed');
      await loadFlavor(state.detailId);
      state.listingSubmitting = false;
      render();
      flashToast(`Approved ${data.approved_count} variant${data.approved_count === 1 ? '' : 's'}.`);
    } catch (e) {
      state.listingSubmitting = false;
      render();
      alert('Could not approve: ' + (e.message || ''));
    }
  }

  // ── Generate listing-content tickets (legacy — kept for the old modal) ────
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

  // ── Generate image tickets ────────────────────────────────────────────────
  async function openGenerateImages() {
    state.generateImagesModal = { channels: [], submitting: false, error: '', loading: true };
    render();
    try {
      const r = await fetch('/api/flavors2/settings/channels');
      if (!r.ok) throw new Error('Could not load channels');
      state.generateImagesModal.channels = await r.json();
      state.generateImagesModal.loading = false;
      render();
    } catch (e) {
      state.generateImagesModal.error = e.message || 'Load failed';
      state.generateImagesModal.loading = false;
      render();
    }
  }

  async function confirmGenerateImages() {
    if (!state.generateImagesModal || state.generateImagesModal.submitting) return;
    state.generateImagesModal.submitting = true;
    state.generateImagesModal.error = '';
    render();
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}/generate-images`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Generate failed');
      state.generateImagesModal = null;
      await loadFlavor(state.detailId);
      render();
      flashToast(`Created ${data.tickets.length} image ticket${data.tickets.length === 1 ? '' : 's'}.`);
    } catch (e) {
      state.generateImagesModal.submitting = false;
      state.generateImagesModal.error = e.message || 'Could not generate';
      render();
    }
  }

  // ── Variation listings — spawn ticket ─────────────────────────────────────
  // No confirmation modal — the section already lists every variation that
  // will end up on the ticket, so the user has reviewed before clicking.
  async function generateVariationTicket() {
    if (!state.detailId || state.variationSubmitting) return;
    state.variationSubmitting = true;
    render();
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}/generate-variation-ticket`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Spawn failed');
      await loadFlavor(state.detailId);
      state.variationSubmitting = false;
      render();
      flashToast(`Variation ticket created across ${data.matchCount} listings.`);
    } catch (e) {
      state.variationSubmitting = false;
      render();
      alert('Could not spawn ticket: ' + (e.message || ''));
    }
  }

  // ── Generate channel SKUs + per-channel launch tickets ───────────────────
  async function openGenerateChannelSkus() {
    state.generateChannelSkusModal = { channels: [], patterns: [], prices: [], submitting: false, error: '', loading: true };
    render();
    try {
      const chRes = await fetch('/api/flavors2/settings/channels');
      if (!chRes.ok) throw new Error('Could not load channels');
      const channels = await chRes.json();
      state.generateChannelSkusModal.channels = channels;
      // Fan out: fetch every enabled channel's patterns + price rules in
      // parallel so the preview shows the exact SKUs the server will emit
      // and flags SKUs that won't have a price in the launch ticket.
      const enabled = channels.filter(c => c.enabled);
      const [patternResults, priceResults] = await Promise.all([
        Promise.all(enabled.map(c =>
          fetch(`/api/flavors2/settings/channels/${c.id}/sku-patterns`)
            .then(r => r.ok ? r.json() : []).catch(() => [])
        )),
        Promise.all(enabled.map(c =>
          fetch(`/api/flavors2/settings/channels/${c.id}/price-rules`)
            .then(r => r.ok ? r.json() : []).catch(() => [])
        )),
      ]);
      state.generateChannelSkusModal.patterns = patternResults.flat();
      state.generateChannelSkusModal.prices = priceResults.flat();
      state.generateChannelSkusModal.loading = false;
      render();
    } catch (e) {
      state.generateChannelSkusModal.error = e.message || 'Load failed';
      state.generateChannelSkusModal.loading = false;
      render();
    }
  }

  async function confirmGenerateChannelSkus() {
    if (!state.generateChannelSkusModal || state.generateChannelSkusModal.submitting) return;
    state.generateChannelSkusModal.submitting = true;
    state.generateChannelSkusModal.error = '';
    render();
    try {
      const r = await fetch(`/api/flavors2/${state.detailId}/generate-channel-skus`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Generate failed');
      state.generateChannelSkusModal = null;
      await loadFlavor(state.detailId);
      render();
      flashToast(`Created ${data.tickets.length} ticket${data.tickets.length === 1 ? '' : 's'} (${data.skuCount} channel SKUs).`);
    } catch (e) {
      state.generateChannelSkusModal.submitting = false;
      state.generateChannelSkusModal.error = e.message || 'Could not generate';
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
