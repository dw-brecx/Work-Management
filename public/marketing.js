/* ============================================================
 * Marketing — standalone page (calendar + templates + posts)
 *
 * Three tabs:
 *   1. Calendar (default) — month + week views of materialised posts
 *   2. Templates — recurring post templates with prep-task lists
 *   3. Posts — flat filterable list of materialised posts
 *
 * Mutations (create/edit/delete templates, skip posts) are
 * admin/manager only — the server enforces this with requireAdmin
 * on every write route; the UI hides write buttons for non-admins.
 *
 * Page boot: GET /api/auth/me, redirect to /login.html on 401.
 * ============================================================ */

(function () {
  'use strict';

  const PLATFORMS = [
    { value: 'instagram',    label: 'Instagram',       icon: '📸' },
    { value: 'facebook',     label: 'Facebook',        icon: '📘' },
    { value: 'tiktok',       label: 'TikTok',          icon: '🎵' },
    { value: 'x',            label: 'X / Twitter',     icon: '✖️'  },
    { value: 'linkedin',     label: 'LinkedIn',        icon: '💼' },
    { value: 'youtube',      label: 'YouTube',         icon: '▶️' },
    { value: 'email',        label: 'Email blast',     icon: '✉️' },
    { value: 'ad-facebook',  label: 'Facebook Ad',     icon: '📢' },
    { value: 'ad-instagram', label: 'Instagram Ad',    icon: '📣' },
    { value: 'other',        label: 'Other',           icon: '📌' },
  ];
  const POST_KINDS = [
    { value: 'post',      label: 'Post' },
    { value: 'story',     label: 'Story' },
    { value: 'reel',      label: 'Reel / Short' },
    { value: 'video',     label: 'Video' },
    { value: 'carousel',  label: 'Carousel' },
    { value: 'ad',        label: 'Ad' },
  ];
  const STATUSES = [
    { value: 'planned',     label: 'Planned' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'ready',       label: 'Ready' },
    { value: 'posted',      label: 'Posted' },
    { value: 'skipped',     label: 'Skipped' },
  ];
  const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Static US holiday list with marketing-relevant retail/cultural days.
  // Embedded here (not server-side) because the calendar is the only place
  // that uses them and the data is small + slow-changing. Add more years
  // by appending to the array. Each row: YYYY-MM-DD, label, emoji.
  const HOLIDAYS = [
    // 2026
    { date:'2026-01-01', name:"New Year's Day",            emoji:'🎉' },
    { date:'2026-01-19', name:'MLK Day',                   emoji:'✊' },
    { date:'2026-02-02', name:'Groundhog Day',             emoji:'🐹' },
    { date:'2026-02-14', name:"Valentine's Day",           emoji:'💝' },
    { date:'2026-02-16', name:"Presidents' Day",           emoji:'🇺🇸' },
    { date:'2026-03-17', name:"St. Patrick's Day",         emoji:'🍀' },
    { date:'2026-04-01', name:"April Fool's Day",          emoji:'🤡' },
    { date:'2026-04-05', name:'Easter Sunday',             emoji:'🐰' },
    { date:'2026-04-22', name:'Earth Day',                 emoji:'🌎' },
    { date:'2026-05-05', name:'Cinco de Mayo',             emoji:'🌮' },
    { date:'2026-05-10', name:"Mother's Day",              emoji:'🌷' },
    { date:'2026-05-25', name:'Memorial Day',              emoji:'🇺🇸' },
    { date:'2026-06-19', name:'Juneteenth',                emoji:'🎆' },
    { date:'2026-06-21', name:"Father's Day",              emoji:'👨‍👧' },
    { date:'2026-07-04', name:'Independence Day',          emoji:'🎆' },
    { date:'2026-09-07', name:'Labor Day',                 emoji:'👷' },
    { date:'2026-10-12', name:'Columbus / Indigenous Day', emoji:'🌎' },
    { date:'2026-10-31', name:'Halloween',                 emoji:'🎃' },
    { date:'2026-11-11', name:'Veterans Day',              emoji:'🎖️' },
    { date:'2026-11-26', name:'Thanksgiving',              emoji:'🦃' },
    { date:'2026-11-27', name:'Black Friday',              emoji:'🛍️' },
    { date:'2026-11-30', name:'Cyber Monday',              emoji:'💻' },
    { date:'2026-12-24', name:'Christmas Eve',             emoji:'🎄' },
    { date:'2026-12-25', name:'Christmas Day',             emoji:'🎄' },
    { date:'2026-12-31', name:"New Year's Eve",            emoji:'🥂' },
    // 2027
    { date:'2027-01-01', name:"New Year's Day",            emoji:'🎉' },
    { date:'2027-01-18', name:'MLK Day',                   emoji:'✊' },
    { date:'2027-02-02', name:'Groundhog Day',             emoji:'🐹' },
    { date:'2027-02-14', name:"Valentine's Day",           emoji:'💝' },
    { date:'2027-02-15', name:"Presidents' Day",           emoji:'🇺🇸' },
    { date:'2027-03-17', name:"St. Patrick's Day",         emoji:'🍀' },
    { date:'2027-03-28', name:'Easter Sunday',             emoji:'🐰' },
    { date:'2027-04-01', name:"April Fool's Day",          emoji:'🤡' },
    { date:'2027-04-22', name:'Earth Day',                 emoji:'🌎' },
    { date:'2027-05-05', name:'Cinco de Mayo',             emoji:'🌮' },
    { date:'2027-05-09', name:"Mother's Day",              emoji:'🌷' },
    { date:'2027-05-31', name:'Memorial Day',              emoji:'🇺🇸' },
    { date:'2027-06-19', name:'Juneteenth',                emoji:'🎆' },
    { date:'2027-06-20', name:"Father's Day",              emoji:'👨‍👧' },
    { date:'2027-07-04', name:'Independence Day',          emoji:'🎆' },
    { date:'2027-09-06', name:'Labor Day',                 emoji:'👷' },
    { date:'2027-10-11', name:'Columbus / Indigenous Day', emoji:'🌎' },
    { date:'2027-10-31', name:'Halloween',                 emoji:'🎃' },
    { date:'2027-11-11', name:'Veterans Day',              emoji:'🎖️' },
    { date:'2027-11-25', name:'Thanksgiving',              emoji:'🦃' },
    { date:'2027-11-26', name:'Black Friday',              emoji:'🛍️' },
    { date:'2027-11-29', name:'Cyber Monday',              emoji:'💻' },
    { date:'2027-12-24', name:'Christmas Eve',             emoji:'🎄' },
    { date:'2027-12-25', name:'Christmas Day',             emoji:'🎄' },
    { date:'2027-12-31', name:"New Year's Eve",            emoji:'🥂' },
    // 2028
    { date:'2028-01-01', name:"New Year's Day",            emoji:'🎉' },
    { date:'2028-01-17', name:'MLK Day',                   emoji:'✊' },
    { date:'2028-02-14', name:"Valentine's Day",           emoji:'💝' },
    { date:'2028-02-21', name:"Presidents' Day",           emoji:'🇺🇸' },
    { date:'2028-03-17', name:"St. Patrick's Day",         emoji:'🍀' },
    { date:'2028-04-16', name:'Easter Sunday',             emoji:'🐰' },
    { date:'2028-05-14', name:"Mother's Day",              emoji:'🌷' },
    { date:'2028-05-29', name:'Memorial Day',              emoji:'🇺🇸' },
    { date:'2028-06-18', name:"Father's Day",              emoji:'👨‍👧' },
    { date:'2028-06-19', name:'Juneteenth',                emoji:'🎆' },
    { date:'2028-07-04', name:'Independence Day',          emoji:'🎆' },
    { date:'2028-09-04', name:'Labor Day',                 emoji:'👷' },
    { date:'2028-10-31', name:'Halloween',                 emoji:'🎃' },
    { date:'2028-11-11', name:'Veterans Day',              emoji:'🎖️' },
    { date:'2028-11-23', name:'Thanksgiving',              emoji:'🦃' },
    { date:'2028-11-24', name:'Black Friday',              emoji:'🛍️' },
    { date:'2028-11-27', name:'Cyber Monday',              emoji:'💻' },
    { date:'2028-12-24', name:'Christmas Eve',             emoji:'🎄' },
    { date:'2028-12-25', name:'Christmas Day',             emoji:'🎄' },
    { date:'2028-12-31', name:"New Year's Eve",            emoji:'🥂' },
  ];
  const HOLIDAYS_BY_DATE = HOLIDAYS.reduce((m, h) => { (m[h.date] = m[h.date] || []).push(h); return m; }, {});

  // Mutable page state. Single source of truth for what the UI shows.
  // calVisible.platforms is the set of *enabled* platforms — empty means
  // "all hidden", null means "no filter" (initial). We default-fill it on
  // first calendar render so every platform is visible.
  // openDrawer = { kind: 'template'|'post'|'new-template'|'one-off', id, date }
  // captures whatever is currently visible above the tab so URL routing and
  // breadcrumbs can describe it.
  const state = {
    me: null,
    isAdmin: false,
    tab: 'calendar',         // 'calendar' | 'templates' | 'posts'
    calMode: 'month',        // 'month' | 'week'
    calCursor: null,         // a Date pinned to UTC midnight
    calVisible: null,        // { platforms: Set<string>, holidays: bool, status: '' }
    templates: [],
    posts: [],               // posts for the current calendar window
    users: [],               // workspace users for assignee dropdowns
    postsListFilters: { platform: '', status: '', from: '', to: '' },
    postsList: [],
    openDrawer: null,        // { kind, id?, date?, prefill? } for current drawer
    drawerEntity: null,      // hydrated entity (template or post) for breadcrumb labels
  };

  // ── DOM helpers ────────────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v != null) node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(cc => node.appendChild(cc instanceof Node ? cc : document.createTextNode(String(cc))));
      else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  // ── UTC date helpers (server stores YYYY-MM-DD UTC) ────────────
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  function fmtYmd(d) {
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function todayUtc() {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }
  function addDays(d, n) {
    const out = new Date(d);
    out.setUTCDate(out.getUTCDate() + n);
    return out;
  }
  function fmtNice(d) {
    if (!d) return '';
    return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric', timeZone:'UTC' });
  }

  // ── API ────────────────────────────────────────────────────────
  async function api(method, url, body) {
    const init = { method, credentials:'same-origin', headers: { 'Content-Type':'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(url, init);
    if (r.status === 401) { location.href = '/login.html'; throw new Error('auth'); }
    if (!r.ok) {
      let err = ''; try { err = (await r.json()).error || ''; } catch {}
      throw new Error(err || ('HTTP ' + r.status));
    }
    if (r.status === 204) return null;
    return r.json();
  }

  // ── Routing ────────────────────────────────────────────────────
  // URLs:
  //   /marketing                         → calendar
  //   /marketing/calendar                → calendar (canonical)
  //   /marketing/templates               → templates list
  //   /marketing/templates/new           → templates list + new-template drawer
  //   /marketing/templates/:id           → templates list + edit-template drawer
  //   /marketing/posts                   → posts list
  //   /marketing/posts/:id               → posts list + post-detail drawer
  //   /marketing/calendar/new/:YYYY-MM-DD → calendar + one-off-post drawer for date
  function urlFor(target) {
    if (!target) return '/marketing/calendar';
    if (target.kind === 'calendar')    return '/marketing/calendar';
    if (target.kind === 'templates')   return '/marketing/templates';
    if (target.kind === 'posts')       return '/marketing/posts';
    if (target.kind === 'template')    return '/marketing/templates/' + target.id;
    if (target.kind === 'new-template') return '/marketing/templates/new';
    if (target.kind === 'post')        return '/marketing/posts/' + target.id;
    if (target.kind === 'one-off' && target.date) return '/marketing/calendar/new/' + target.date;
    return '/marketing/calendar';
  }

  // Apply a URL to state, without re-rendering. Returns the parsed target so
  // the caller can decide what to do (initial boot vs. popstate).
  function parseUrl(p) {
    p = String(p || '').replace(/\/+$/, '');
    let m;
    if ((m = /^\/marketing\/templates\/new$/.exec(p))) return { tab: 'templates', drawer: { kind: 'new-template' } };
    if ((m = /^\/marketing\/templates\/(\d+)$/.exec(p))) return { tab: 'templates', drawer: { kind: 'template', id: Number(m[1]) } };
    if (/^\/marketing\/templates$/.test(p)) return { tab: 'templates', drawer: null };
    if ((m = /^\/marketing\/posts\/(\d+)$/.exec(p))) return { tab: 'posts', drawer: { kind: 'post', id: Number(m[1]) } };
    if (/^\/marketing\/posts$/.test(p)) return { tab: 'posts', drawer: null };
    if ((m = /^\/marketing\/calendar\/new\/(\d{4}-\d{2}-\d{2})$/.exec(p))) return { tab: 'calendar', drawer: { kind: 'one-off', date: m[1] } };
    return { tab: 'calendar', drawer: null };
  }

  // Update the URL + state to reflect a tab/drawer change. mode='push' adds
  // a history entry (default); mode='replace' rewrites the current entry
  // (used for state nudges that shouldn't grow the back stack).
  function navTo(target, mode) {
    const url = urlFor(target);
    if (mode === 'replace') history.replaceState({ target }, '', url);
    else history.pushState({ target }, '', url);
    applyTarget(target);
    renderShell();
  }

  function applyTarget(target) {
    if (!target) target = { tab: 'calendar' };
    state.tab = target.tab || (target.kind === 'template' || target.kind === 'new-template' ? 'templates'
                              : target.kind === 'post' ? 'posts'
                              : target.kind === 'one-off' ? 'calendar'
                              : target.kind || 'calendar');
    // Drawer descriptor: anything but a plain tab landing.
    if (target.drawer) state.openDrawer = target.drawer;
    else if (['template','new-template','post','one-off'].includes(target.kind)) state.openDrawer = target;
    else state.openDrawer = null;
  }

  window.addEventListener('popstate', () => {
    const parsed = parseUrl(location.pathname);
    state.tab = parsed.tab;
    state.openDrawer = parsed.drawer;
    state.drawerEntity = null;
    renderShell();
    if (state.openDrawer) {
      reopenDrawerFromState();
    } else {
      // Active drawer needs to be closed without re-touching the URL (popstate
      // already updated it).
      const back = $('#mk-drawer-back'); const dr = $('#mk-drawer');
      if (back) back.classList.remove('open');
      if (dr)   dr.classList.remove('open');
    }
  });

  // Used after popstate or a deep link — open whatever drawer the URL says.
  async function reopenDrawerFromState() {
    const d = state.openDrawer;
    if (!d) return;
    if (d.kind === 'template')      return openTemplateDrawerById(d.id);
    if (d.kind === 'new-template')  return openTemplateEditor(null, { fromUrl: true });
    if (d.kind === 'post')          return openPostDrawerById(d.id);
    if (d.kind === 'one-off')       return openOneOffDrawer(d.date, d.prefill || {}, { fromUrl: true });
  }

  // ── Page shell ─────────────────────────────────────────────────
  function renderShell() {
    const root = $('#mk-app');
    root.innerHTML = '';
    root.appendChild(
      el('div', { class: 'mk-page' },
        renderCrumbs(),
        el('div', { class: 'mk-header' },
          el('h1', { class: 'mk-title' }, '📣 Marketing'),
          state.isAdmin
            ? el('button', { class: 'mk-btn mk-btn-primary', onclick: () => navTo({ kind: 'new-template' }) }, '+ New post template')
            : null,
        ),
        el('p', { class: 'mk-lede' },
          'Plan recurring social-media posts and ads. Each template carries a schedule (e.g. every Friday) and a checklist of prep tasks. ' +
          'When a post date approaches, tickets auto-spawn so prep is done in time, and the calendar tracks every upcoming post.'
        ),
        el('div', { class: 'mk-tabs' },
          tabBtn('calendar',  'Calendar'),
          tabBtn('templates', 'Templates'),
          tabBtn('posts',     'Posts'),
        ),
        el('div', { id: 'mk-tab-calendar',  class: 'mk-panel' + (state.tab === 'calendar'  ? ' active' : '') }),
        el('div', { id: 'mk-tab-templates', class: 'mk-panel' + (state.tab === 'templates' ? ' active' : '') }),
        el('div', { id: 'mk-tab-posts',     class: 'mk-panel' + (state.tab === 'posts'     ? ' active' : '') }),
      )
    );
    // Drawer container (filled on demand)
    if (!$('#mk-drawer-back')) {
      document.body.appendChild(el('div', { id: 'mk-drawer-back', class: 'mk-drawer-back', onclick: () => closeDrawer({ updateUrl: true }) }));
      document.body.appendChild(el('div', { id: 'mk-drawer',      class: 'mk-drawer' }));
    }
    renderActiveTab();
  }

  // Breadcrumb above the page header. The first crumb doubles as a "back to
  // calendar" jump button. Every parent crumb is clickable; the current
  // location is plain text.
  function renderCrumbs() {
    const crumbs = [];
    const d = state.openDrawer;
    // Always show "Marketing" as the root jump-back link unless we're already there.
    const atRoot = state.tab === 'calendar' && !d;
    crumbs.push({ label: '📣 Marketing', href: '/marketing/calendar', current: atRoot });
    if (state.tab === 'templates') {
      crumbs.push({ label: 'Templates', href: '/marketing/templates', current: !d });
      if (d && d.kind === 'template') {
        const entity = state.drawerEntity;
        crumbs.push({ label: entity?.name ? entity.name : `Template #${d.id}`, current: true });
      } else if (d && d.kind === 'new-template') {
        crumbs.push({ label: 'New template', current: true });
      }
    } else if (state.tab === 'posts') {
      crumbs.push({ label: 'Posts', href: '/marketing/posts', current: !d });
      if (d && d.kind === 'post') {
        const entity = state.drawerEntity;
        crumbs.push({ label: entity?.name ? `${entity.name} · ${entity.post_date}` : `Post #${d.id}`, current: true });
      }
    } else if (state.tab === 'calendar') {
      if (d && d.kind === 'one-off') {
        crumbs.push({ label: 'Calendar', href: '/marketing/calendar', current: false });
        crumbs.push({ label: `New post · ${d.date}`, current: true });
      }
    }
    const nodes = [];
    if (!atRoot) {
      nodes.push(el('a', {
        class: 'crumb-back',
        href: '/marketing/calendar',
        onclick: (e) => { e.preventDefault(); navTo({ kind: 'calendar' }); }
      }, '← Back to Calendar'));
    }
    crumbs.forEach((c, i) => {
      if (i > 0) nodes.push(el('span', { class: 'crumb-sep' }, '/'));
      if (c.current || !c.href) {
        nodes.push(el('span', { class: 'crumb-current' }, c.label));
      } else {
        nodes.push(el('a', {
          href: c.href,
          onclick: (e) => {
            e.preventDefault();
            const t = parseUrl(c.href);
            navTo(t.drawer ? Object.assign({ tab: t.tab }, t.drawer) : { kind: t.tab });
          }
        }, c.label));
      }
    });
    return el('nav', { class: 'mk-crumbs', 'aria-label': 'Breadcrumb' }, ...nodes);
  }

  function tabBtn(id, label) {
    return el('div', {
      class: 'mk-tab' + (state.tab === id ? ' active' : ''),
      onclick: () => navTo({ kind: id })
    }, label);
  }

  function renderActiveTab() {
    if (state.tab === 'calendar')  renderCalendar();
    if (state.tab === 'templates') renderTemplates();
    if (state.tab === 'posts')     renderPostsList();
  }

  // ── Calendar ───────────────────────────────────────────────────
  // For month view: range = first day of grid (last Sunday on/before
  // the first of the month) through the last Saturday of the trailing
  // week, so we always render a complete 6-row grid.
  // For week view: range = Sunday-Saturday of state.calCursor.
  function calendarRange() {
    const cursor = state.calCursor;
    if (state.calMode === 'week') {
      const dow = cursor.getUTCDay();
      const start = addDays(cursor, -dow);
      const end = addDays(start, 6);
      return { start, end, label: `${fmtNice(start)} – ${fmtNice(end)}` };
    }
    const first = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    const startDow = first.getUTCDay();
    const start = addDays(first, -startDow);
    const end = addDays(start, 41); // 6 weeks × 7 days - 1
    return { start, end, label: `${MONTH_NAMES[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}` };
  }

  // Lazily fill the calendar visibility bitmask on first render. All platforms
  // visible, holidays on, no status filter.
  function ensureCalVisible() {
    if (state.calVisible) return;
    state.calVisible = {
      platforms: new Set(PLATFORMS.map(p => p.value)),
      holidays: true,
      status: '',
    };
  }

  async function renderCalendar() {
    const root = $('#mk-tab-calendar');
    if (!root) return;
    if (!state.calCursor) state.calCursor = todayUtc();
    ensureCalVisible();
    const { start, end, label } = calendarRange();
    const vis = state.calVisible;

    root.innerHTML = '';
    // Top toolbar — month/week nav + status dropdown.
    const toolbar = el('div', { class: 'mk-cal-toolbar' },
      el('div', { class: 'mk-cal-nav' },
        el('button', { title: 'Previous', onclick: () => navCal(-1) }, '‹'),
        el('button', { title: 'Today', onclick: () => { state.calCursor = todayUtc(); renderCalendar(); } }, '•'),
        el('button', { title: 'Next', onclick: () => navCal(+1) }, '›'),
      ),
      el('div', { class: 'mk-cal-label' }, label),
      el('div', { class: 'mk-cal-mode' },
        el('button', { class: state.calMode === 'month' ? 'active' : '', onclick: () => { state.calMode = 'month'; renderCalendar(); } }, 'Month'),
        el('button', { class: state.calMode === 'week'  ? 'active' : '', onclick: () => { state.calMode = 'week';  renderCalendar(); } }, 'Week'),
      ),
      el('div', { class: 'mk-cal-filters' },
        el('select', { onchange: (e) => { vis.status = e.target.value; renderCalendar(); } },
          el('option', { value: '' }, 'All statuses'),
          ...STATUSES.map(s => el('option', { value: s.value, selected: vis.status === s.value ? '' : null }, s.label))
        ),
      ),
    );
    root.appendChild(toolbar);

    // Multi-select chip row — toggles per platform + holidays. Chip-style so
    // users can hide just "Instagram" or just "Holidays" without losing the
    // others.
    const chipRow = el('div', { class: 'mk-cal-chips' },
      el('button', {
        class: 'mk-chip mk-chip-allnone',
        onclick: () => {
          const allOn = vis.platforms.size === PLATFORMS.length && vis.holidays;
          if (allOn) { vis.platforms.clear(); vis.holidays = false; }
          else { vis.platforms = new Set(PLATFORMS.map(p => p.value)); vis.holidays = true; }
          renderCalendar();
        },
        title: 'Toggle all'
      }, (vis.platforms.size === PLATFORMS.length && vis.holidays) ? 'Hide all' : 'Show all'),
      ...PLATFORMS.map(p => el('button', {
        class: 'mk-chip mk-chip-' + p.value + (vis.platforms.has(p.value) ? ' active' : ''),
        onclick: () => {
          if (vis.platforms.has(p.value)) vis.platforms.delete(p.value);
          else vis.platforms.add(p.value);
          renderCalendar();
        }
      }, `${p.icon} ${p.label}`)),
      el('button', {
        class: 'mk-chip mk-chip-holiday' + (vis.holidays ? ' active' : ''),
        onclick: () => { vis.holidays = !vis.holidays; renderCalendar(); }
      }, '🎉 Holidays'),
    );
    root.appendChild(chipRow);

    const gridHost = el('div', { class: 'mk-cal-grid' + (state.calMode === 'week' ? ' mk-week' : '') });
    root.appendChild(gridHost);
    gridHost.innerHTML = '<div class="mk-cal-headcell">Loading…</div>';

    // Server-side filter for any *checked* platform; if nothing is checked we
    // still send the request so the empty list comes back fast.
    const params = new URLSearchParams({ from: fmtYmd(start), to: fmtYmd(end) });
    const platformList = Array.from(vis.platforms);
    if (platformList.length && platformList.length < PLATFORMS.length) {
      params.set('platform', platformList.join(','));
    } else if (!platformList.length) {
      params.set('platform', '__none__'); // matches nothing
    }
    if (vis.status) params.set('status', vis.status);

    let posts = [];
    try { posts = await api('GET', '/api/marketing/posts?' + params.toString()); }
    catch (e) { gridHost.innerHTML = `<div class="mk-cal-headcell">Failed to load: ${esc(e.message)}</div>`; return; }
    state.posts = posts;

    const byDate = new Map();
    for (const p of posts) {
      const k = p.post_date;
      if (!byDate.has(k)) byDate.set(k, []);
      byDate.get(k).push(p);
    }

    gridHost.innerHTML = '';
    for (let i = 0; i < 7; i++) gridHost.appendChild(el('div', { class: 'mk-cal-headcell' }, WEEKDAYS[i]));

    const days = state.calMode === 'week' ? 7 : 42;
    const today = fmtYmd(todayUtc());
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      const ymd = fmtYmd(d);
      const dim = state.calMode === 'month' && d.getUTCMonth() !== state.calCursor.getUTCMonth();
      const cell = el('div', { class: 'mk-cal-cell' + (dim ? ' dim' : '') + (ymd === today ? ' today' : '') });

      // Day-num row with optional "+" button on hover (admin only).
      const dayHead = el('div', { class: 'mk-cal-dayhead' },
        el('span', { class: 'mk-cal-daynum' }, String(d.getUTCDate())),
        state.isAdmin ? el('button', {
          class: 'mk-cal-plus',
          title: 'Create one-off post on this day',
          onclick: (e) => { e.stopPropagation(); openOneOffDrawer(ymd); }
        }, '+') : null,
      );
      cell.appendChild(dayHead);

      // Holiday chip(s) — render first so they're visible above posts.
      if (vis.holidays) {
        const hols = HOLIDAYS_BY_DATE[ymd] || [];
        for (const h of hols) cell.appendChild(renderHolidayChip(h, ymd));
      }

      const chips = byDate.get(ymd) || [];
      for (const p of chips) cell.appendChild(renderPostChip(p));
      gridHost.appendChild(cell);
    }
  }

  function renderHolidayChip(h, ymd) {
    return el('div', {
      class: 'mk-holiday-chip',
      title: `${h.name}\nClick to plan a post for this holiday`,
      onclick: () => state.isAdmin && openOneOffDrawer(ymd, { name: h.name, notes: `Holiday-tie-in for ${h.name}` })
    }, `${h.emoji} ${h.name}`);
  }

  function navCal(step) {
    if (state.calMode === 'week') {
      state.calCursor = addDays(state.calCursor, step * 7);
    } else {
      const c = state.calCursor;
      state.calCursor = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + step, 1));
    }
    renderCalendar();
  }

  function renderPostChip(post) {
    const plat = PLATFORMS.find(p => p.value === post.platform) || PLATFORMS[PLATFORMS.length - 1];
    const colorVar = `var(--p-${post.platform || 'other'})`;
    const chip = el('div', {
      class: `mk-post-chip status-${post.status || 'planned'}`,
      style: `color:${colorVar};background:var(--p-${post.platform || 'other'}-bg)`,
      onclick: () => openPostDrawer(post.id),
    },
      el('div', { class: 'pc-title', style: 'color:var(--text)' }, `${plat.icon} ${post.name || '(untitled)'}`),
      el('div', { class: 'pc-meta' },
        post.post_time ? `${post.post_time} · ` : '',
        plat.label,
        post.tickets && post.tickets.length ? ` · ${post.tickets.length} task${post.tickets.length === 1 ? '' : 's'}` : '',
      ),
    );
    return chip;
  }

  // ── Templates tab ──────────────────────────────────────────────
  async function renderTemplates() {
    const root = $('#mk-tab-templates');
    if (!root) return;
    root.innerHTML = '<div class="mk-empty">Loading templates…</div>';
    try { state.templates = await api('GET', '/api/marketing/templates'); }
    catch (e) { root.innerHTML = `<div class="mk-empty">Failed to load: ${esc(e.message)}</div>`; return; }

    if (!state.templates.length) {
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'mk-empty' },
        state.isAdmin
          ? 'No post templates yet. Click "+ New post template" to create your first one.'
          : 'No post templates yet. An admin can create them.'
      ));
      return;
    }

    root.innerHTML = '';
    const list = el('div', { class: 'mk-tmpl-list' });
    for (const t of state.templates) list.appendChild(renderTemplateCard(t));
    root.appendChild(list);
  }

  function renderTemplateCard(t) {
    const plat = PLATFORMS.find(p => p.value === t.platform) || PLATFORMS[PLATFORMS.length - 1];
    const recur = describeRecurrence(t);
    return el('div', { class: 'mk-tmpl-card' + (t.active ? '' : ' inactive') },
      el('div', { class: 'mk-tmpl-row' },
        el('div', { class: 'mk-tmpl-icon', style: `background:var(--p-${t.platform}-bg)` }, plat.icon),
        el('div', { class: 'mk-tmpl-body' },
          el('h3', { class: 'mk-tmpl-name' },
            t.name || '(unnamed)',
            ' ',
            el('span', { class: `mk-plat mk-plat-${t.platform}` }, plat.label),
            ' ',
            t.active ? null : el('span', { class: 'mk-status mk-status-skipped' }, 'paused'),
          ),
          t.description ? el('p', { class: 'mk-tmpl-sub' }, t.description) : null,
          el('div', { class: 'mk-tmpl-stats' },
            el('span', null, recur),
            t.next_post_date ? el('span', null, 'Next post: ', el('b', null, t.next_post_date)) : null,
            el('span', null, `${t.tasks.length} prep task${t.tasks.length === 1 ? '' : 's'}`),
            t.lead_time_days > 0 ? el('span', null, `${t.lead_time_days} day lead time`) : null,
          ),
        ),
        state.isAdmin ? el('div', { class: 'mk-tmpl-actions' },
          el('button', { class: 'mk-btn mk-btn-sm', onclick: () => openEditTemplate(t.id), title: 'Edit' }, 'Edit'),
          el('button', { class: 'mk-btn mk-btn-sm', onclick: () => toggleTemplateActive(t), title: t.active ? 'Pause' : 'Resume' }, t.active ? 'Pause' : 'Resume'),
          el('button', { class: 'mk-btn mk-btn-sm', onclick: () => materializeNow(t), title: 'Spawn the next post now' }, 'Run now'),
        ) : null,
      ),
    );
  }

  function describeRecurrence(t) {
    const FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    if (t.recur_type === 'weekly')        return `Every ${FULL[t.recur_weekday || 0]}`;
    if (t.recur_type === 'monthly_day')   return `Monthly on the ${t.recur_day || 1}${ordinalSuffix(t.recur_day || 1)}`;
    if (t.recur_type === 'monthly_same')  return `Monthly on the same day as ${t.start_date}`;
    if (t.recur_type === 'every_n_days')  return `Every ${t.recur_interval || 1} day${(t.recur_interval || 1) === 1 ? '' : 's'}`;
    return 'Custom';
  }
  function ordinalSuffix(n) {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }

  async function toggleTemplateActive(t) {
    try {
      await api('PUT', '/api/marketing/templates/' + t.id, { active: t.active ? 0 : 1 });
      renderTemplates();
    } catch (e) { uiAlert('Could not update: ' + e.message); }
  }

  async function materializeNow(t) {
    if (!await uiConfirm(`Spawn the next "${t.name}" post (${t.next_post_date || 'no date'}) and its prep tickets right now?`)) return;
    try {
      const r = await api('POST', '/api/marketing/templates/' + t.id + '/materialize-now');
      if (r.alreadyExisted) uiAlert('A post for that date already existed. No new tickets were created.');
      else uiAlert(`Created ${r.ticketIds.length} prep ticket${r.ticketIds.length === 1 ? '' : 's'} for ${t.next_post_date}.`);
      renderTemplates();
      if (state.tab === 'calendar') renderCalendar();
    } catch (e) { uiAlert('Could not spawn: ' + e.message); }
  }

  // ── Posts list ─────────────────────────────────────────────────
  async function renderPostsList() {
    const root = $('#mk-tab-posts');
    if (!root) return;
    root.innerHTML = '';
    const f = state.postsListFilters;

    const filterBar = el('div', { class: 'mk-posts-filters' },
      el('input', { type: 'date', value: f.from || '', onchange: e => { f.from = e.target.value; renderPostsList(); } }),
      el('span', { style: 'color:var(--text3);font-size:12px' }, '→'),
      el('input', { type: 'date', value: f.to || '', onchange: e => { f.to = e.target.value; renderPostsList(); } }),
      el('select', { onchange: e => { f.platform = e.target.value; renderPostsList(); } },
        el('option', { value: '' }, 'All platforms'),
        ...PLATFORMS.map(p => el('option', { value: p.value, selected: f.platform === p.value ? '' : null }, `${p.icon} ${p.label}`))
      ),
      el('select', { onchange: e => { f.status = e.target.value; renderPostsList(); } },
        el('option', { value: '' }, 'All statuses'),
        ...STATUSES.map(s => el('option', { value: s.value, selected: f.status === s.value ? '' : null }, s.label))
      ),
    );
    root.appendChild(filterBar);

    const params = new URLSearchParams();
    if (f.from) params.set('from', f.from);
    if (f.to)   params.set('to',   f.to);
    if (f.platform) params.set('platform', f.platform);
    if (f.status)   params.set('status',   f.status);

    let rows = [];
    try { rows = await api('GET', '/api/marketing/posts?' + params.toString()); }
    catch (e) { root.appendChild(el('div', { class: 'mk-empty' }, 'Failed to load: ' + e.message)); return; }
    state.postsList = rows;

    if (!rows.length) {
      root.appendChild(el('div', { class: 'mk-empty' }, 'No posts match these filters.'));
      return;
    }
    const tbl = el('table', { class: 'mk-posts-table' },
      el('thead', null, el('tr', null,
        el('th', null, 'Date'),
        el('th', null, 'Post'),
        el('th', null, 'Platform'),
        el('th', null, 'Status'),
        el('th', null, 'Prep tickets'),
      )),
      el('tbody', null, ...rows.map(p => {
        const plat = PLATFORMS.find(pp => pp.value === p.platform) || PLATFORMS[PLATFORMS.length - 1];
        return el('tr', { class: 'clickable', onclick: () => openPostDrawer(p.id) },
          el('td', null, p.post_date + (p.post_time ? ` · ${p.post_time}` : '')),
          el('td', null, p.name || '(untitled)'),
          el('td', null, el('span', { class: `mk-plat mk-plat-${p.platform}` }, `${plat.icon} ${plat.label}`)),
          el('td', null, el('span', { class: `mk-status mk-status-${p.status}` }, (STATUSES.find(s => s.value === p.status) || { label: p.status }).label)),
          el('td', null, String((p.tickets || []).length)),
        );
      })),
    );
    root.appendChild(tbl);
  }

  // ── Drawer infrastructure ──────────────────────────────────────
  function openDrawer(title, bodyNode, footNode) {
    const back = $('#mk-drawer-back');
    const drawer = $('#mk-drawer');
    drawer.innerHTML = '';
    drawer.appendChild(el('div', { class: 'mk-drawer-head' },
      el('h3', null, title),
      el('button', { class: 'mk-drawer-close', onclick: () => closeDrawer({ updateUrl: true }), 'aria-label': 'Close' }, '×'),
    ));
    drawer.appendChild(el('div', { class: 'mk-drawer-body' }, bodyNode));
    if (footNode) drawer.appendChild(el('div', { class: 'mk-drawer-foot' }, footNode));
    back.classList.add('open');
    drawer.classList.add('open');
  }
  // closeDrawer({ updateUrl }): pops the URL back to the parent tab so the
  // browser back button stays in sync. opts.updateUrl=false skips the push
  // (used when navTo just changed the URL itself).
  function closeDrawer(opts) {
    $('#mk-drawer-back').classList.remove('open');
    $('#mk-drawer').classList.remove('open');
    state.drawerEntity = null;
    if (opts && opts.updateUrl !== false && state.openDrawer) {
      state.openDrawer = null;
      navTo({ kind: state.tab });
    } else {
      state.openDrawer = null;
    }
  }

  // Used by the popstate handler + initial boot when the URL contains a
  // template id. Fetches the template, sets it as the drawer entity so the
  // breadcrumb has a name to show, then opens the editor.
  async function openTemplateDrawerById(id) {
    try {
      const t = await api('GET', '/api/marketing/templates/' + id);
      state.drawerEntity = t;
      renderShell(); // refresh breadcrumb with the name
      openTemplateEditor(t, { fromUrl: true });
    } catch (e) { uiAlert('Could not load template: ' + e.message); navTo({ kind: 'templates' }); }
  }

  async function openPostDrawerById(id) {
    try {
      const p = await api('GET', '/api/marketing/posts/' + id);
      state.drawerEntity = p;
      renderShell();
      renderPostDrawerBody(p);
    } catch (e) { uiAlert('Could not load post: ' + e.message); navTo({ kind: 'posts' }); }
  }

  // ── Post detail drawer ─────────────────────────────────────────
  // Public entry: updates URL + state, then loads + renders.
  function openPostDrawer(postId) {
    navTo({ kind: 'post', id: postId });
    openPostDrawerById(postId);
  }

  // Renders the drawer body for a hydrated post. Used by openPostDrawerById
  // (which fetches first) so the same code can run for both new opens and
  // popstate re-opens.
  function renderPostDrawerBody(p) {
    const plat = PLATFORMS.find(pp => pp.value === p.platform) || PLATFORMS[PLATFORMS.length - 1];

    const statusSel = el('select', null, ...STATUSES.map(s => el('option', { value: s.value, selected: p.status === s.value ? '' : null }, s.label)));
    const notesArea = el('textarea', { placeholder: 'Internal notes (caption draft, asset links, approvals…)' }, p.notes || '');

    const body = el('div', null,
      el('div', { class: 'mk-field' },
        el('label', null, 'Platform & kind'),
        el('div', null,
          el('span', { class: `mk-plat mk-plat-${p.platform}` }, `${plat.icon} ${plat.label}`),
          ' ',
          el('span', { style: 'color:var(--text2);font-size:12px' }, p.post_kind || ''),
        ),
      ),
      el('div', { class: 'mk-field' },
        el('label', null, 'Post date / time'),
        el('div', null, p.post_date + (p.post_time ? ` · ${p.post_time}` : '')),
      ),
      el('div', { class: 'mk-field' },
        el('label', null, 'Status'),
        statusSel,
      ),
      el('div', { class: 'mk-field' },
        el('label', null, 'Notes'),
        notesArea,
      ),
      el('div', { class: 'mk-field' },
        el('label', null, `Prep tickets (${(p.tickets || []).length})`),
        ...((p.tickets || []).length
          ? p.tickets.map(t => el('div', { class: 'mk-ticket-row' },
              el('a', { class: 'tr-id', href: `/tickets/${encodeURIComponent(t.ticket_id)}`, target: '_blank' }, t.ticket_id),
              el('div', { class: 'tr-title' }, t.task_title || (t.ticket && t.ticket.title) || ''),
              el('div', { class: 'tr-meta' }, 'due ' + (t.due_date || '')),
              t.ticket ? el('div', { class: `tr-status s-${(t.ticket.status || '').toLowerCase().replace(/\s+/g, '_')}` }, t.ticket.status) : null,
            ))
          : [el('div', { style: 'color:var(--text3);font-size:12.5px' }, 'No prep tickets linked.')]
        ),
      ),
    );

    const foot = el('div', null,
      state.isAdmin ? el('button', { class: 'mk-btn mk-btn-danger', onclick: () => skipPost(p) }, 'Skip / cancel') : null,
      el('button', { class: 'mk-btn', onclick: () => closeDrawer({ updateUrl: true }) }, 'Close'),
      el('button', { class: 'mk-btn mk-btn-primary', onclick: async () => {
        try {
          await api('PUT', '/api/marketing/posts/' + p.id, { status: statusSel.value, notes: notesArea.value });
          closeDrawer({ updateUrl: true });
          if (state.tab === 'calendar') renderCalendar();
          if (state.tab === 'posts')    renderPostsList();
        } catch (e) { uiAlert('Save failed: ' + e.message); }
      } }, 'Save'),
    );
    openDrawer(`${plat.icon} ${p.name || '(untitled post)'}`, body, foot);
  }

  async function skipPost(p) {
    const ticketCount = (p.tickets || []).length;
    const ok = await uiConfirm(
      `Skip "${p.name}" on ${p.post_date}?` +
      (ticketCount ? `\n\nAlso DELETE the ${ticketCount} prep ticket(s) linked to it? ` +
        `OK = skip and delete tickets. Cancel = leave everything alone.` : ''),
      { okText: ticketCount ? 'Skip + delete tickets' : 'Skip post', cancelText: 'Cancel', danger: true }
    );
    if (!ok) return;
    try {
      await api('DELETE', `/api/marketing/posts/${p.id}?deleteTickets=${ticketCount ? 1 : 0}`);
      closeDrawer({ updateUrl: true });
      if (state.tab === 'calendar') renderCalendar();
      if (state.tab === 'posts')    renderPostsList();
    } catch (e) { uiAlert('Could not skip: ' + e.message); }
  }

  // ── One-off post drawer ────────────────────────────────────────
  // Triggered by the "+" button on a calendar cell. Lets the user create a
  // single-occurrence post (no recurrence) and optionally pull prep tasks
  // from an existing template — typical use is "I want an extra Instagram
  // post this Saturday for [holiday]; same prep checklist as my weekly
  // Instagram template".
  // opts.fromUrl=true is set when this is being re-opened via popstate or a
  // deep link, so we don't push the URL again.
  async function openOneOffDrawer(dateYmd, prefill, opts) {
    prefill = prefill || {};
    opts = opts || {};
    if (!opts.fromUrl) navTo({ kind: 'one-off', date: dateYmd, prefill });
    // Make sure we have the templates list (for the copy-tasks-from dropdown).
    if (!state.templates.length) {
      try { state.templates = await api('GET', '/api/marketing/templates'); } catch {}
    }
    const draft = {
      name: prefill.name || '',
      platform: prefill.platform || 'instagram',
      post_kind: prefill.post_kind || 'post',
      post_date: dateYmd,
      post_time: prefill.post_time || '',
      notes: prefill.notes || '',
      copy_from_template_id: '',
      tasks: [],
    };

    const nameInput = el('input', { type: 'text', value: draft.name, placeholder: 'e.g. Memorial Day flash sale' });
    const platSel = el('select', null, ...PLATFORMS.map(p => el('option', { value: p.value, selected: draft.platform === p.value ? '' : null }, `${p.icon} ${p.label}`)));
    const kindSel = el('select', null, ...POST_KINDS.map(k => el('option', { value: k.value, selected: draft.post_kind === k.value ? '' : null }, k.label)));
    const dateInp = el('input', { type: 'date', value: draft.post_date });
    const timeInp = el('input', { type: 'time', value: draft.post_time });
    const notesArea = el('textarea', { placeholder: 'Caption draft, asset links, anything…' }, draft.notes);

    // Copy-tasks-from-template dropdown. Re-ranked whenever platform changes
    // so the platform-matching templates float to the top, with a hint label.
    const copySel = el('select');
    const copyHint = el('div', { style: 'font-size:11px;color:var(--text2);margin-top:4px' });
    function rebuildCopyDropdown() {
      copySel.innerHTML = '';
      copySel.appendChild(el('option', { value: '' }, '— Empty (no prep tasks) —'));
      // Two groups: matching platform first, then others.
      const matching = state.templates.filter(t => t.platform === platSel.value && t.tasks && t.tasks.length);
      const others   = state.templates.filter(t => t.platform !== platSel.value && t.tasks && t.tasks.length);
      if (matching.length) {
        const og = el('optgroup', { label: `Same platform (${platSel.value})` });
        for (const t of matching) og.appendChild(el('option', { value: t.id }, `${t.name} · ${t.tasks.length} task${t.tasks.length === 1 ? '' : 's'}`));
        copySel.appendChild(og);
      }
      if (others.length) {
        const og = el('optgroup', { label: 'Other templates' });
        for (const t of others) og.appendChild(el('option', { value: t.id }, `${t.name} (${t.platform}) · ${t.tasks.length} task${t.tasks.length === 1 ? '' : 's'}`));
        copySel.appendChild(og);
      }
      // Auto-select first matching template as a hint, but don't override an
      // explicit choice the user already made.
      if (matching.length && !draft.copy_from_template_id) {
        copySel.value = String(matching[0].id);
        draft.copy_from_template_id = String(matching[0].id);
      } else if (draft.copy_from_template_id) {
        copySel.value = draft.copy_from_template_id;
      }
      // Update the hint preview
      const chosen = state.templates.find(t => String(t.id) === String(copySel.value));
      copyHint.innerHTML = '';
      if (chosen) {
        copyHint.appendChild(document.createTextNode(`Will create ${chosen.tasks.length} prep ticket(s): ` +
          chosen.tasks.map(t => `${t.title} (${t.days_before_post}d before)`).join(', ')));
      } else {
        copyHint.appendChild(document.createTextNode('No prep tickets will be spawned. You can still mark this post manually.'));
      }
    }
    copySel.addEventListener('change', () => {
      draft.copy_from_template_id = copySel.value;
      rebuildCopyDropdown();
    });
    platSel.addEventListener('change', () => {
      draft.platform = platSel.value;
      // Reset the auto-suggestion when platform changes.
      draft.copy_from_template_id = '';
      rebuildCopyDropdown();
    });
    rebuildCopyDropdown();

    const holidayHint = HOLIDAYS_BY_DATE[dateYmd]
      ? el('div', { style: 'background:var(--warn-bg);color:var(--warn);padding:8px 12px;border-radius:8px;font-size:12px;margin-bottom:12px' },
          `🎉 ${HOLIDAYS_BY_DATE[dateYmd].map(h => h.name).join(', ')} — good day for a tie-in`)
      : null;

    const body = el('div', null,
      holidayHint,
      el('div', { class: 'mk-field' }, el('label', null, 'Post name'), nameInput),
      el('div', { class: 'mk-grid-2' },
        el('div', { class: 'mk-field' }, el('label', null, 'Platform'), platSel),
        el('div', { class: 'mk-field' }, el('label', null, 'Kind'), kindSel),
      ),
      el('div', { class: 'mk-grid-2' },
        el('div', { class: 'mk-field' }, el('label', null, 'Post date'), dateInp),
        el('div', { class: 'mk-field' }, el('label', null, 'Post time'), timeInp),
      ),
      el('div', { class: 'mk-field' },
        el('label', null, 'Use prep tasks from'),
        copySel,
        copyHint,
      ),
      el('div', { class: 'mk-field' }, el('label', null, 'Notes'), notesArea),
    );

    async function save() {
      const name = nameInput.value.trim();
      if (!name && !draft.copy_from_template_id) {
        // Still allow nameless one-offs to seed quickly with a default.
      }
      const payload = {
        name: name || `${platSel.value} ${kindSel.value}`,
        platform: platSel.value,
        post_kind: kindSel.value,
        post_date: dateInp.value,
        post_time: timeInp.value,
        notes: notesArea.value,
        copy_from_template_id: copySel.value || null,
      };
      if (!payload.post_date) return uiAlert('Pick a date.');
      try {
        const r = await api('POST', '/api/marketing/posts', payload);
        closeDrawer({ updateUrl: true });
        if (state.tab === 'calendar') renderCalendar();
        if (state.tab === 'posts')    renderPostsList();
        if (Array.isArray(r.ticketIds) && r.ticketIds.length) {
          uiAlert(`Created post on ${payload.post_date} with ${r.ticketIds.length} prep ticket(s).`);
        }
      } catch (e) { uiAlert('Could not create: ' + e.message); }
    }

    const foot = el('div', null,
      el('button', { class: 'mk-btn', onclick: () => closeDrawer({ updateUrl: true }) }, 'Cancel'),
      el('button', { class: 'mk-btn mk-btn-primary', onclick: save }, 'Create post'),
    );

    openDrawer(`New post on ${dateYmd}`, body, foot);
  }

  // ── Template editor drawer ─────────────────────────────────────
  // Entry points all funnel through navTo so URLs stay correct, then
  // open the drawer. The URL-driven re-opens (popstate / deep link)
  // skip navTo and go straight to the builder via openTemplateDrawerById.
  function openNewTemplate() {
    navTo({ kind: 'new-template' });
    openTemplateEditor(null, { fromUrl: true });
  }
  function openEditTemplate(id) {
    navTo({ kind: 'template', id });
    openTemplateDrawerById(id);
  }

  // opts.fromUrl=true is set when we're rebuilding the drawer because
  // a popstate / deep-link asked for it. In that case the URL is already
  // correct and we don't push a new history entry.
  function openTemplateEditor(existing, opts) {
    opts = opts || {};
    // Local mutable draft. Tasks live here as plain JS objects so we can
    // add/remove rows without round-tripping to the server until "Save".
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      name: '',
      description: '',
      platform: 'instagram',
      post_kind: 'post',
      start_date: fmtYmd(addDays(todayUtc(), 7)),
      post_time: '',
      recur_type: 'weekly',
      recur_day: null,
      recur_weekday: 5,  // Friday — matches the user's example
      recur_interval: 7,
      end_type: 'never',
      end_count: 10,
      end_date: '',
      active: 1,
      tasks: [],
    };
    // Defensive defaults for templates created before end_type existed.
    draft.end_type  = draft.end_type  || 'never';
    draft.end_count = draft.end_count || 10;
    draft.end_date  = draft.end_date  || '';

    const nameInput = el('input', { type: 'text', value: draft.name, placeholder: 'e.g. Friday Special of the Week' });
    const descInput = el('textarea', { placeholder: 'What is this post about?' }, draft.description || '');
    const platSel   = el('select', null, ...PLATFORMS.map(p => el('option', { value: p.value, selected: draft.platform === p.value ? '' : null }, `${p.icon} ${p.label}`)));
    const kindSel   = el('select', null, ...POST_KINDS.map(p => el('option', { value: p.value, selected: draft.post_kind === p.value ? '' : null }, p.label)));
    const startInp  = el('input', { type: 'date', value: draft.start_date });
    const timeInp   = el('input', { type: 'time', value: draft.post_time || '' });

    const recurTypeSel = el('select', null,
      el('option', { value: 'weekly',        selected: draft.recur_type === 'weekly'        ? '' : null }, 'Weekly'),
      el('option', { value: 'monthly_day',   selected: draft.recur_type === 'monthly_day'   ? '' : null }, 'Monthly (day of month)'),
      el('option', { value: 'monthly_same',  selected: draft.recur_type === 'monthly_same'  ? '' : null }, 'Monthly (same as start)'),
      el('option', { value: 'every_n_days',  selected: draft.recur_type === 'every_n_days'  ? '' : null }, 'Every N days'),
    );
    const FULL_WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const recurWeekdaySel = el('select', null, ...FULL_WEEKDAYS.map((w, i) => el('option', { value: i, selected: (draft.recur_weekday || 0) === i ? '' : null }, w)));
    const recurDayInp     = el('input', { type: 'number', min: 1, max: 31, value: draft.recur_day || 1, style: 'width:80px' });
    const recurIntInp     = el('input', { type: 'number', min: 1, max: 365, value: draft.recur_interval || 7, style: 'width:90px' });

    const recurRow = el('div', { class: 'mk-recur-row' }, recurTypeSel,
      recurChild('weekly',       el('span', null, 'on ', recurWeekdaySel)),
      recurChild('monthly_day',  el('span', null, 'on day ', recurDayInp)),
      recurChild('every_n_days', el('span', null, 'every ', recurIntInp, ' days')),
    );

    // End-condition controls. "Never" auto-extends a rolling 13-month window,
    // "After N" caps occurrences, "On date" cuts off after the given date.
    const endTypeSel = el('select', null,
      el('option', { value: 'never', selected: draft.end_type === 'never' ? '' : null }, 'Never (keeps going)'),
      el('option', { value: 'count', selected: draft.end_type === 'count' ? '' : null }, 'After N times'),
      el('option', { value: 'date',  selected: draft.end_type === 'date'  ? '' : null }, 'On a specific date'),
    );
    const endCountInp = el('input', { type: 'number', min: 1, max: 500, value: draft.end_count || 10, style: 'width:80px' });
    const endDateInp  = el('input', { type: 'date', value: draft.end_date || '' });
    function endChild(type, node) {
      node.style.display = draft.end_type === type ? '' : 'none';
      node.dataset.endType = type;
      return node;
    }
    const endRow = el('div', { class: 'mk-recur-row' }, endTypeSel,
      endChild('count', el('span', null, 'after ', endCountInp, ' posts')),
      endChild('date',  el('span', null, 'on ', endDateInp)),
    );
    endTypeSel.addEventListener('change', () => {
      draft.end_type = endTypeSel.value;
      Array.from(endRow.children).forEach(c => {
        if (c.dataset && c.dataset.endType) c.style.display = c.dataset.endType === draft.end_type ? '' : 'none';
      });
    });
    function recurChild(type, node) {
      node.style.display = draft.recur_type === type ? '' : 'none';
      node.dataset.recurType = type;
      return node;
    }
    recurTypeSel.addEventListener('change', () => {
      draft.recur_type = recurTypeSel.value;
      Array.from(recurRow.children).forEach(c => {
        if (c.dataset && c.dataset.recurType) c.style.display = c.dataset.recurType === draft.recur_type ? '' : 'none';
      });
    });

    // Task list ── mutate `draft.tasks` directly, then re-render.
    const taskListEl = el('div', { class: 'mk-task-list' });
    function renderTasks() {
      taskListEl.innerHTML = '';
      if (!draft.tasks.length) {
        taskListEl.appendChild(el('div', { class: 'mk-empty', style: 'padding:20px;font-size:12px' },
          'No prep tasks yet. Add one for each step (write caption, design graphic, get approval, etc.).'));
      }
      draft.tasks.forEach((task, idx) => taskListEl.appendChild(renderTaskCard(task, idx)));
    }
    function renderTaskCard(task, idx) {
      const titleInp = el('input', { type: 'text', value: task.title || '', placeholder: 'Task title (e.g. Write caption)' });
      titleInp.addEventListener('input', () => { task.title = titleInp.value; });

      const assigneeSel = el('select', null,
        el('option', { value: '' }, '— Unassigned —'),
        ...state.users.map(u => el('option', { value: u.name, selected: (task.assignees && task.assignees[0]) === u.name ? '' : null }, u.name))
      );
      assigneeSel.addEventListener('change', () => { task.assignees = assigneeSel.value ? [assigneeSel.value] : []; });

      const daysInp = el('input', { type: 'number', min: 0, max: 365, value: task.days_before_post != null ? task.days_before_post : 1, title: 'Days before the post date when this ticket is due' });
      daysInp.addEventListener('input', () => { task.days_before_post = Number(daysInp.value) || 0; });

      const remHrsInp = el('input', { type: 'number', min: 0, max: 720, value: task.reminder_offset_hours || 0, title: 'Hours before the due date when the assignee gets a reminder. 0 = no reminder.' });
      remHrsInp.addEventListener('input', () => { task.reminder_offset_hours = Number(remHrsInp.value) || 0; });

      const prioSel = el('select', null,
        ...['Urgent','High','Medium','Low'].map(p => el('option', { value: p, selected: (task.priority || 'Medium') === p ? '' : null }, p))
      );
      prioSel.addEventListener('change', () => { task.priority = prioSel.value; });

      const descInp = el('input', { type: 'text', value: task.description || '', placeholder: 'Optional description / instructions' });
      descInp.addEventListener('input', () => { task.description = descInp.value; });

      return el('div', { class: 'mk-task-card' },
        el('div', { class: 'mk-task-head' },
          el('span', { style: 'font-size:11px;color:var(--text3);font-weight:700;width:18px;text-align:right' }, String(idx + 1) + '.'),
          titleInp,
          el('button', { class: 'mk-task-remove', title: 'Remove', onclick: () => { draft.tasks.splice(idx, 1); renderTasks(); } }, '×'),
        ),
        el('div', { class: 'mk-task-meta' },
          labelled('Assignee', assigneeSel),
          labelled('Days before post', daysInp),
          labelled('Remind (hrs before due)', remHrsInp),
        ),
        el('div', { class: 'mk-task-meta', style: 'margin-top:6px' },
          labelled('Priority', prioSel),
          el('div', { style: 'grid-column:span 2' }, labelled('Description', descInp)),
        ),
      );
    }
    function labelled(text, node) {
      return el('label', { style: 'display:flex;flex-direction:column;gap:3px;font-size:10.5px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em' },
        text, node);
    }
    renderTasks();

    const addTaskBtn = el('button', { class: 'mk-btn mk-btn-sm', onclick: () => {
      draft.tasks.push({ title: '', description: '', assignees: [], priority: 'Medium', days_before_post: 1, reminder_offset_hours: 0, checklist: [], tags: [] });
      renderTasks();
    } }, '+ Add prep task');

    const body = el('div', null,
      el('div', { class: 'mk-field' }, el('label', null, 'Template name'), nameInput),
      el('div', { class: 'mk-field' }, el('label', null, 'Description'), descInput),
      el('div', { class: 'mk-grid-2' },
        el('div', { class: 'mk-field' }, el('label', null, 'Platform'), platSel),
        el('div', { class: 'mk-field' }, el('label', null, 'Kind'), kindSel),
      ),
      el('div', { class: 'mk-grid-2' },
        el('div', { class: 'mk-field' }, el('label', null, 'Start date (first post)'), startInp),
        el('div', { class: 'mk-field' }, el('label', null, 'Post time (optional)'), timeInp),
      ),
      el('div', { class: 'mk-field' }, el('label', null, 'Recurrence'), recurRow),
      el('div', { class: 'mk-field' }, el('label', null, 'Ends'), endRow),
      el('div', { class: 'mk-field' },
        el('label', null, 'Prep tasks'),
        el('div', { style: 'font-size:11.5px;color:var(--text2);margin-bottom:8px' },
          'One ticket gets spawned per task ahead of every post date. ' +
          'Set "Days before post" to control when the ticket is due, and "Remind" to notify the assignee that many hours before the due date.'
        ),
        taskListEl,
        el('div', { style: 'margin-top:8px' }, addTaskBtn),
      ),
    );

    async function save() {
      const payload = {
        name: nameInput.value.trim(),
        description: descInput.value.trim(),
        platform: platSel.value,
        post_kind: kindSel.value,
        start_date: startInp.value,
        post_time: timeInp.value,
        recur_type: recurTypeSel.value,
        recur_weekday: recurTypeSel.value === 'weekly' ? Number(recurWeekdaySel.value) : null,
        recur_day:     recurTypeSel.value === 'monthly_day' ? Number(recurDayInp.value) : null,
        recur_interval:recurTypeSel.value === 'every_n_days' ? Number(recurIntInp.value) : null,
        end_type:  endTypeSel.value,
        end_count: endTypeSel.value === 'count' ? Number(endCountInp.value) : null,
        end_date:  endTypeSel.value === 'date'  ? endDateInp.value : '',
        active: draft.active ? 1 : 0,
        tasks: draft.tasks.filter(t => t.title && t.title.trim()),
      };
      if (!payload.name) return uiAlert('Please give the template a name.');
      if (!payload.start_date) return uiAlert('Please pick a start date.');
      try {
        if (existing) await api('PUT', '/api/marketing/templates/' + existing.id, payload);
        else          await api('POST', '/api/marketing/templates', payload);
        closeDrawer({ updateUrl: true });
        // navTo above pushed us back to /marketing/templates — re-render that
        // tab so the user sees the fresh list.
        if (state.tab === 'templates') renderTemplates();
        if (state.tab === 'calendar')  renderCalendar();
      } catch (e) { uiAlert('Save failed: ' + e.message); }
    }

    const foot = el('div', null,
      existing ? el('button', { class: 'mk-btn mk-btn-danger', onclick: async () => {
        if (!await uiConfirm(`Delete template "${existing.name}"? Already-spawned posts and tickets are kept.`, { danger: true })) return;
        try {
          await api('DELETE', '/api/marketing/templates/' + existing.id);
          closeDrawer({ updateUrl: true });
          renderTemplates();
        } catch (e) { uiAlert('Delete failed: ' + e.message); }
      } }, 'Delete') : null,
      el('button', { class: 'mk-btn', onclick: () => closeDrawer({ updateUrl: true }) }, 'Cancel'),
      el('button', { class: 'mk-btn mk-btn-primary', onclick: save }, existing ? 'Save changes' : 'Create template'),
    );

    openDrawer(existing ? 'Edit post template' : 'New post template', body, foot);
  }

  // ── Boot ───────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (me.status === 401) { location.href = '/login.html'; return; }
      state.me = await me.json();
      // /api/auth/me returns the role as `permRole` (camelCase). Accept the
      // snake_case form too in case the endpoint ever changes shape.
      const role = state.me?.permRole || state.me?.perm_role;
      state.isAdmin = ['Admin','Manager'].includes(role);
    } catch {
      location.href = '/login.html';
      return;
    }
    // Workspace users for the assignee picker. Best-effort: if the call
    // fails (e.g. permissions), we still render with an empty list and
    // the user can type names manually via the search-existing flow.
    try {
      state.users = await api('GET', '/api/team');
    } catch { state.users = []; }
    state.calCursor = todayUtc();

    // Seed state from URL so a refresh / shared link lands on the right view.
    const parsed = parseUrl(location.pathname);
    state.tab = parsed.tab;
    state.openDrawer = parsed.drawer;
    // Make sure the initial entry has a target object so popstate can read it.
    history.replaceState({ target: parsed.drawer ? Object.assign({ tab: parsed.tab }, parsed.drawer) : { kind: parsed.tab } }, '', location.pathname);

    renderShell();
    if (state.openDrawer) reopenDrawerFromState();
  });
})();
