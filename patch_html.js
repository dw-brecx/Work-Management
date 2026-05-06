const fs = require('fs');
const path = require('path');

const SRC  = path.join('C:\\Users\\Duvy Weiss\\Downloads', 'worknest (8).html');
const DEST = path.join(__dirname, 'public', 'index.html');

let html = fs.readFileSync(SRC, 'utf8');

// ── Inject font + full light-mode redesign CSS into <head> ───────────────────
const DESIGN_CSS = `
  <!-- Modern light redesign -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style id="wn-redesign">
    /* ── Global: Inter font + forced light mode ── */
    *, body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important; }

    /* Override dark mode — always stay light */
    @media (prefers-color-scheme: dark) {
      :root {
        --bg:     #f5f7fa !important;
        --bg2:    #edf0f7 !important;
        --bg3:    #e2e7f0 !important;
        --card:   #ffffff !important;
        --border: #e4e9f2 !important;
        --border2:#d1daea !important;
        --text:   #111827 !important;
        --text2:  #4b5563 !important;
        --text3:  #9ca3af !important;
      }
    }
    :root {
      --bg:     #f5f7fa;
      --bg2:    #edf0f7;
      --bg3:    #e2e7f0;
      --card:   #ffffff;
      --border: #e4e9f2;
      --border2:#d1daea;
      --text:   #111827;
      --text2:  #4b5563;
      --text3:  #9ca3af;
      --accent: #2563eb;
      --accent2:#4f46e5;
      --shadow-sm: 0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04);
      --shadow-md: 0 4px 16px rgba(16,24,40,.08), 0 2px 6px rgba(16,24,40,.04);
      --shadow-lg: 0 12px 32px rgba(16,24,40,.10), 0 4px 12px rgba(16,24,40,.06);
    }

    /* ── Sidebar redesign: dark → clean white ── */
    #sidebar {
      background: #ffffff !important;
      border-right: 1px solid #e8ecf4 !important;
      box-shadow: 2px 0 8px rgba(16,24,40,.04) !important;
    }
    .sb-logo {
      border-bottom: 1px solid #f0f3fb !important;
      padding: 20px 16px 16px !important;
    }
    .sb-logo-text {
      color: #111827 !important;
      font-size: 15px !important;
      font-weight: 700 !important;
      letter-spacing: -.02em !important;
    }
    .sb-logo-sub {
      color: #9ca3af !important;
      font-size: 10.5px !important;
    }
    #nav { padding: 10px 10px !important; }
    .nav-item {
      color: #6b7280 !important;
      font-size: 12.5px !important;
      font-weight: 500 !important;
      padding: 8px 12px !important;
      border-radius: 10px !important;
      margin-bottom: 1px !important;
      transition: all .15s ease !important;
    }
    .nav-item svg { opacity: .65; }
    .nav-item:hover {
      background: #f0f5ff !important;
      color: #2563eb !important;
    }
    .nav-item:hover svg { opacity: 1; }
    .nav-item.active {
      background: linear-gradient(135deg, #eff6ff, #eef2ff) !important;
      color: #1d4ed8 !important;
      font-weight: 600 !important;
      box-shadow: 0 1px 4px rgba(37,99,235,.12) !important;
    }
    .nav-item.active svg { opacity: 1; }
    .nav-item .badge {
      background: #fee2e2 !important;
      color: #dc2626 !important;
      font-size: 9px !important;
      font-weight: 700 !important;
    }
    .sb-bottom {
      border-top: 1px solid #f0f3fb !important;
      padding: 14px 12px !important;
    }
    .sb-invite {
      background: linear-gradient(135deg, #f0f5ff, #eef2ff) !important;
      border: 1px solid #c7d7fe !important;
      border-radius: 12px !important;
    }
    .sb-invite p { color: #4b5563 !important; }
    .sb-invite button {
      background: #2563eb !important;
      border: none !important;
      color: #ffffff !important;
      border-radius: 8px !important;
      font-weight: 600 !important;
      padding: 6px 10px !important;
      transition: background .15s !important;
    }
    .sb-invite button:hover { background: #1d4ed8 !important; }
    .sb-user-name { color: #111827 !important; font-weight: 600 !important; }
    .sb-user-role { color: #9ca3af !important; }

    /* ── Topbar ── */
    #topbar {
      background: #ffffff !important;
      border-bottom: 1px solid #e8ecf4 !important;
      box-shadow: 0 1px 4px rgba(16,24,40,.04) !important;
      height: 56px !important;
      padding: 0 24px !important;
    }
    .search-wrap input {
      background: #f5f7fa !important;
      border: 1px solid #e4e9f2 !important;
      border-radius: 10px !important;
      padding: 8px 12px 8px 36px !important;
      font-size: 12.5px !important;
      color: #111827 !important;
      transition: border-color .15s, box-shadow .15s !important;
    }
    .search-wrap input:focus {
      border-color: #93c5fd !important;
      box-shadow: 0 0 0 3px rgba(37,99,235,.08) !important;
      background: #fff !important;
      outline: none !important;
    }
    .search-wrap input::placeholder { color: #9ca3af !important; }

    /* ── Buttons ── */
    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #1d4ed8) !important;
      border-radius: 10px !important;
      padding: 8px 16px !important;
      font-weight: 600 !important;
      font-size: 12.5px !important;
      box-shadow: 0 1px 4px rgba(37,99,235,.25), 0 1px 2px rgba(37,99,235,.15) !important;
      letter-spacing: -.01em !important;
      transition: all .15s ease !important;
    }
    .btn-primary:hover {
      background: linear-gradient(135deg, #1d4ed8, #1e40af) !important;
      box-shadow: 0 4px 12px rgba(37,99,235,.30) !important;
      transform: translateY(-1px) !important;
    }
    .btn-sec {
      border: 1px solid #e4e9f2 !important;
      border-radius: 10px !important;
      color: #4b5563 !important;
      font-weight: 500 !important;
      transition: all .15s !important;
    }
    .btn-sec:hover {
      background: #f5f7fa !important;
      border-color: #c7d7fe !important;
      color: #2563eb !important;
    }

    /* ── Cards ── */
    .card, .card-sm {
      border-radius: 24px !important;
      border: 1px solid rgba(0,0,0,.06) !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.07), 0 1px 3px rgba(0,0,0,.05) !important;
      background: #fff !important;
    }
    .card:hover { box-shadow: 0 6px 20px rgba(0,0,0,.10) !important; transition: box-shadow .2s !important; }

    /* ── Stat cards ── */
    .stat-card {
      border-radius: 24px !important;
      border: 1px solid rgba(0,0,0,.06) !important;
      padding: 22px 24px !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.07), 0 1px 3px rgba(0,0,0,.05) !important;
      background: #fff !important;
      transition: transform .15s, box-shadow .15s !important;
    }
    .stat-card:hover { transform: translateY(-3px) !important; box-shadow: 0 8px 24px rgba(0,0,0,.12) !important; }
    .stat-value { font-size: 30px !important; font-weight: 800 !important; letter-spacing: -.04em !important; color: #111827 !important; }
    .stat-label { font-size: 12px !important; font-weight: 500 !important; color: #6b7280 !important; margin-bottom: 4px !important; }
    .stat-change { font-size: 11px !important; font-weight: 600 !important; margin-top: 5px !important; }
    .stat-icon {
      width: 42px !important; height: 42px !important;
      border-radius: 14px !important;
      margin-bottom: 14px !important;
    }

    /* ── Tables — clearly rounded white card ── */
    .tbl {
      border-radius: 20px !important;
      overflow: hidden !important;
      border: 1px solid rgba(0,0,0,.06) !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.06) !important;
      background: #fff !important;
    }
    .tbl th {
      background: #f5f8ff !important;
      color: #6b7280 !important;
      font-size: 10.5px !important;
      font-weight: 600 !important;
      letter-spacing: .04em !important;
      text-transform: uppercase !important;
      padding: 12px 18px !important;
      border-bottom: 1px solid #eef1f9 !important;
    }
    .tbl th:first-child { border-radius: 20px 0 0 0 !important; }
    .tbl th:last-child  { border-radius: 0 20px 0 0 !important; }
    .tbl td {
      padding: 13px 18px !important;
      font-size: 12.5px !important;
      border-bottom: 1px solid #f3f5fb !important;
      color: #374151 !important;
      background: #fff !important;
    }
    .tbl tbody tr:last-child td { border-bottom: none !important; }
    .tbl tr:hover td { background: #f5f9ff !important; }

    /* ── Badges — pill shaped ── */
    .badge-status { border-radius: 999px !important; font-size: 11px !important; padding: 4px 11px !important; font-weight: 600 !important; }
    .s-open  { background: #eff6ff !important; color: #2563eb !important; }
    .s-ip    { background: #fefce8 !important; color: #a16207 !important; }
    .s-cl    { background: #f0fdf4 !important; color: #16a34a !important; }
    .s-ov    { background: #fff1f2 !important; color: #e11d48 !important; }
    .s-pr    { background: #f5f3ff !important; color: #7c3aed !important; }
    .s-oh    { background: #f8fafc !important; color: #475569 !important; }
    .s-ir    { background: #eef2ff !important; color: #4338ca !important; }
    .p-u     { background: #fff1f2 !important; color: #e11d48 !important; }
    .p-h     { background: #fff7ed !important; color: #c2410c !important; }
    .p-m     { background: #fffbeb !important; color: #b45309 !important; }
    .p-l     { background: #f0fdf4 !important; color: #15803d !important; }

    /* ── Tabs — pill style ── */
    .tabs { border-bottom: none !important; background: #edf1f9 !important; border-radius: 14px !important; padding: 4px !important; gap: 2px !important; }
    .tab { border-radius: 10px !important; font-size: 12px !important; font-weight: 500 !important; color: #6b7280 !important; border-bottom: none !important; padding: 7px 13px !important; }
    .tab.active { color: #1d4ed8 !important; background: #fff !important; border-bottom: none !important; font-weight: 600 !important; box-shadow: 0 1px 4px rgba(16,24,40,.10) !important; }
    .tab:hover:not(.active) { background: rgba(255,255,255,.6) !important; color: #374151 !important; }

    /* ── Page headers ── */
    h1 { font-size: 24px !important; font-weight: 800 !important; color: #111827 !important; letter-spacing: -.04em !important; }
    .page > p, .page-content > p { color: #6b7280 !important; font-size: 13px !important; }

    /* ── Main background — make it clearly distinct so white cards pop ── */
    #main { background: #dde3f0 !important; }
    .page, .page-content { background: #dde3f0 !important; padding: 28px !important; }

    /* ── Every top-level card/section floats on the background ── */
    .card, .card-sm,
    .stat-card,
    #dash-ticket-table,
    .tbl {
      background: #ffffff !important;
    }

    /* ── Rounded section wrappers ── */
    .stat-grid { gap: 16px !important; margin-bottom: 20px !important; }

    /* ── Kanban board ── */
    .kanban-col { border-radius: 20px !important; background: #f0f4ff !important; border: 1px solid #dce6ff !important; }
    .kanban-col-header { border-radius: 20px 20px 0 0 !important; padding: 14px 16px !important; }
    .kanban-card { border-radius: 14px !important; box-shadow: var(--shadow-sm) !important; border: 1px solid #e8ecf4 !important; }
    .kanban-card:hover { box-shadow: var(--shadow-md) !important; transform: translateY(-1px) !important; }

    /* ── Modals ── */
    .modal-overlay { background: rgba(15,23,42,.4) !important; backdrop-filter: blur(6px) !important; }
    .modal-box, .modal {
      border-radius: 24px !important;
      box-shadow: 0 28px 64px rgba(16,24,40,.16) !important;
      border: 1px solid #e8ecf4 !important;
      overflow-y: auto !important;
      max-height: 90vh !important;
    }
    .modal-head { border-radius: 0 !important; }

    /* ── Right panel (calendar / ticket detail) ── */
    .right-panel {
      background: #ffffff !important;
      border-left: 1px solid #e8ecf4 !important;
      backdrop-filter: none !important;
    }
    @media (prefers-color-scheme: dark) {
      .right-panel { background: #ffffff !important; border-left-color: #e8ecf4 !important; }
    }

    /* ── Notification panel ── */
    .notif-panel { border-radius: 20px !important; box-shadow: 0 16px 48px rgba(16,24,40,.14) !important; }
    .notif-btn {
      background: #f5f7fa !important;
      border: 1px solid #e4e9f2 !important;
      border-radius: 12px !important;
    }
    .notif-btn:hover { background: #eff6ff !important; border-color: #93c5fd !important; color: #2563eb !important; }

    /* ── Sidebar logo area — rounded icon ── */
    .sb-logo-icon { border-radius: 14px !important; }

    /* ── Planning cards ── */
    .plan-card { border-radius: 20px !important; transition: transform .15s, box-shadow .15s !important; }
    .plan-card:hover { transform: translateY(-2px) !important; box-shadow: var(--shadow-md) !important; }

    /* ── Calendar ── */
    .cal-day { border-radius: 12px !important; transition: background .12s !important; }
    .cal-day:hover { background: #f0f5ff !important; }
    .cal-day.today { background: #eff6ff !important; border: 2px solid #93c5fd !important; border-radius: 12px !important; }
    .cal-stat-card { border-radius: 16px !important; }

    /* ── Team cards ── */
    .team-card { border-radius: 20px !important; }

    /* ── Invite items ── */
    .invite-item { border-radius: 16px !important; }

    /* ── Scrollbars ── */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #d1daea; border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: #93c5fd; }

    /* ── Input / select / textarea ── */
    input:not([type=checkbox]):not([type=radio]), select, textarea {
      border-radius: 12px !important;
      border: 1px solid #e4e9f2 !important;
      background: #f8faff !important;
      color: #111827 !important;
      transition: border-color .15s, box-shadow .15s !important;
    }
    input:not([type=checkbox]):not([type=radio]):focus, select:focus, textarea:focus {
      border-color: #93c5fd !important;
      box-shadow: 0 0 0 3px rgba(37,99,235,.08) !important;
      background: #fff !important;
      outline: none !important;
    }

    /* ── Dropdown menus ── */
    .dropdown, [class*="dropdown"], [class*="-menu"] {
      border-radius: 14px !important;
      box-shadow: 0 8px 24px rgba(16,24,40,.10) !important;
      border: 1px solid #e8ecf4 !important;
      overflow: hidden !important;
    }

    /* ── Profile menu — modern redesign ── */
    .profile-menu {
      background: #ffffff !important;
      border-radius: 16px !important;
      box-shadow: 0 12px 36px rgba(16,24,40,.14), 0 2px 8px rgba(16,24,40,.06) !important;
      border: 1px solid #e8ecf4 !important;
      padding: 6px !important;
      min-width: 224px !important;
      overflow: visible !important;
    }
    .profile-menu-head {
      padding: 12px 12px 11px !important;
      border-bottom: 1px solid #f0f3fb !important;
      margin-bottom: 4px !important;
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
    }
    .profile-menu-avatar {
      width: 38px !important; height: 38px !important;
      border-radius: 11px !important;
      font-size: 13px !important; font-weight: 700 !important;
      flex-shrink: 0 !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
    }
    .profile-menu-name { font-size: 13.5px !important; font-weight: 600 !important; color: #111827 !important; line-height: 1.3 !important; }
    .profile-menu-email { font-size: 11.5px !important; color: #9ca3af !important; margin-top: 1px !important; }
    .profile-menu button {
      display: flex !important; align-items: center !important; gap: 9px !important;
      padding: 8px 11px !important; border-radius: 10px !important;
      font-size: 13px !important; font-weight: 500 !important; color: #374151 !important;
      background: none !important; border: none !important; cursor: pointer !important;
      width: 100% !important; text-align: left !important; transition: background .12s, color .12s !important;
    }
    .profile-menu button:hover { background: #f5f7fa !important; color: #111827 !important; }
    .profile-menu button.danger { color: #dc2626 !important; }
    .profile-menu button.danger:hover { background: #fef2f2 !important; }
    .profile-menu-line { height: 1px !important; background: #f0f3fb !important; margin: 4px 6px !important; }
    .pm-icon { width: 15px !important; height: 15px !important; color: #9ca3af !important; flex-shrink: 0 !important; }
    .profile-menu button:hover .pm-icon { color: #6b7280 !important; }
    .profile-menu button.danger .pm-icon { color: #f87171 !important; }

    /* ── Sidebar collapse arrow (chevron, not hamburger) ── */
    .sb-collapse-btn { border-radius: 8px !important; }
    .sb-collapse-btn svg { transition: transform .22s cubic-bezier(.4,0,.2,1) !important; }
    #sidebar.collapsed .sb-collapse-btn svg { transform: rotate(180deg) !important; }

    /* ── Hide fake pagination ── */
    .pg { display: none !important; }

    /* ── Dashboard / Reports filter bar ── */
    .page-filter-bar {
      display: flex !important; align-items: center !important; gap: 8px !important;
      margin-bottom: 18px !important; flex-wrap: wrap !important;
    }
    .pf-label { font-size: 11.5px !important; font-weight: 500 !important; color: var(--text3) !important; white-space: nowrap !important; }
    .pf-select {
      font-size: 12px !important; font-weight: 500 !important; color: #374151 !important;
      background: #fff !important; border: 1px solid #e4e9f2 !important;
      border-radius: 10px !important; padding: 6px 26px 6px 10px !important;
      cursor: pointer !important; appearance: none !important; -webkit-appearance: none !important;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%239ca3af'/%3E%3C/svg%3E") !important;
      background-repeat: no-repeat !important; background-position: right 8px center !important;
      box-shadow: 0 1px 3px rgba(16,24,40,.06) !important; transition: border-color .15s !important;
      width: auto !important; min-width: 130px !important; max-width: 200px !important;
      height: auto !important; line-height: normal !important;
    }
    .pf-select:hover { border-color: #93c5fd !important; }
    .pf-select:focus { border-color: #93c5fd !important; outline: none !important; box-shadow: 0 0 0 3px rgba(37,99,235,.08) !important; }

    /* ── Timeline ── */
    .tl-dot { box-shadow: 0 0 0 3px #edf1f9 !important; border-radius: 50% !important; }

    /* ── Page transition ── */
    .page.active { animation: wnFadeIn .18s ease !important; }
    @keyframes wnFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

    /* ── Misc rounded elements ── */
    .workload-bar { border-radius: 999px !important; }
    .legend-dot   { border-radius: 50% !important; }
    .avatar       { border-radius: 50% !important; }
    .stk-avatar   { border-radius: 50% !important; }
    .tag          { border-radius: 999px !important; }
    select        { border-radius: 12px !important; }

    /* ── Kill original body/html gradient that causes pink corners ── */
    html, body { background: #f5f7fa !important; }
    body::before, body::after { display: none !important; }

    /* ── Dashboard donut chart hover tooltips ── */
    .donut-segment { cursor: pointer; transition: opacity .15s; }
    .donut-segment:hover { opacity: .75; }
    .donut-tooltip {
      position: fixed; background: #1e293b; color: #fff;
      padding: 6px 10px; border-radius: 8px; font-size: 12px;
      pointer-events: none; z-index: 9999; white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0,0,0,.2); display: none;
    }
    .donut-tooltip.show { display: block; }

    /* ── Sidebar: full + collapsed states ─────────────────────────── */
    #sidebar {
      width: 220px !important;
      transition: width .22s cubic-bezier(.4,0,.2,1) !important;
      overflow: hidden !important;
      flex-shrink: 0 !important;
    }
    #sidebar.collapsed { width: 64px !important; }
    #sidebar.collapsed .nav-label,
    #sidebar.collapsed .nav-item span:not(.badge),
    #sidebar.collapsed .nav-item-text,
    #sidebar.collapsed .sb-logo-name,
    #sidebar.collapsed .sb-full-logo,
    #sidebar.collapsed .badge,
    #sidebar.collapsed .sb-bottom > *:not(.sb-user),
    #sidebar.collapsed .sb-invite,
    #sidebar.collapsed .sb-user-name,
    #sidebar.collapsed .sb-user-role { display: none !important; }
    #sidebar.collapsed .sb-icon-logo { display: block !important; }
    #sidebar.collapsed .nav-item {
      justify-content: center !important;
      padding: 10px 0 !important;
      overflow: hidden !important;
    }
    #sidebar.collapsed .nav-item svg { margin: 0 auto !important; flex-shrink: 0 !important; }
    .sb-full-logo { display: block !important; height: 36px !important; width: auto !important; }
    .sb-icon-logo { display: none !important; height: 30px !important; width: auto !important; }
    .sb-logo {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 18px 16px 14px !important;
    }
    /* Collapsed: hide the logo/navigate button, center just the toggle arrow */
    #sidebar.collapsed .sb-logo > button:not(.sb-collapse-btn) { display: none !important; }
    #sidebar.collapsed .sb-logo { justify-content: center !important; padding: 14px 0 12px !important; }
    .sb-collapse-btn {
      background: none !important;
      border: none !important;
      cursor: pointer !important;
      color: #9ca3af !important;
      padding: 6px !important;
      border-radius: 8px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: color .15s, background .15s !important;
      flex-shrink: 0 !important;
    }
    .sb-collapse-btn:hover { color: #2563eb !important; background: #eff6ff !important; }
    #sidebar.collapsed .sb-collapse-btn { margin: 0 auto !important; }

    /* ── Collapsed sidebar: nav item tooltips ── */
    #sidebar.collapsed .nav-item {
      position: relative !important;
    }
    #sidebar.collapsed .nav-item::after {
      content: attr(data-tooltip);
      position: absolute !important;
      left: 60px !important;
      top: 50% !important;
      transform: translateY(-50%) !important;
      background: #1e293b !important;
      color: #fff !important;
      font-size: 11.5px !important;
      font-weight: 500 !important;
      padding: 5px 10px !important;
      border-radius: 7px !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity .12s !important;
      z-index: 999 !important;
      box-shadow: 0 4px 12px rgba(0,0,0,.2) !important;
    }
    #sidebar.collapsed .nav-item:hover::after { opacity: 1 !important; }
    /* Collapsed: user area only shows avatar */
    #sidebar.collapsed .sb-user { justify-content: center !important; padding: 8px 0 !important; }
    #sidebar.collapsed .sb-bottom { padding: 10px 0 !important; }

    /* ── Mobile sidebar overlay ── */
    #sb-overlay {
      display: none;
      position: fixed; inset: 0;
      background: rgba(15,23,42,.4);
      z-index: 99;
      backdrop-filter: blur(2px);
    }
    .mob-menu-btn {
      display: none !important;
      background: none !important;
      border: none !important;
      cursor: pointer !important;
      color: #374151 !important;
      padding: 6px !important;
      border-radius: 8px !important;
      margin-right: 8px !important;
    }
    .mob-menu-btn:hover { background: #f3f4f6 !important; }
    @media (max-width: 768px) {
      .mob-menu-btn { display: flex !important; align-items: center !important; }
      #sidebar {
        position: fixed !important;
        left: -240px !important;
        top: 0 !important;
        height: 100vh !important;
        z-index: 100 !important;
        width: 220px !important;
        transition: left .25s cubic-bezier(.4,0,.2,1) !important;
      }
      #sidebar.mobile-open { left: 0 !important; }
      #sidebar.mobile-open ~ #sb-overlay { display: block; }
      #app { width: 100% !important; }
      #topbar { padding: 0 14px !important; }
      .search-wrap { max-width: 200px !important; }
      .page, .page-content { padding: 16px !important; }
      .stat-grid { grid-template-columns: 1fr 1fr !important; }
      .tbl { overflow-x: auto !important; }
    }

    /* ── Nav item layout ── */
    .nav-item {
      display: flex !important;
      align-items: center !important;
      gap: 9px !important;
    }
    .nav-item svg { flex-shrink: 0 !important; }

    /* ── Notification panel icons ── */
    .notif-icon-wrap { font-size: 0 !important; }
    .notif-icon-wrap svg { width: 15px !important; height: 15px !important; }

    /* ── Voice note in comments ── */
    .voice-comment-player {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      padding: 6px 0 !important;
    }
    .voice-comment-player audio {
      height: 30px !important;
      max-width: 200px !important;
      flex: 1 !important;
    }
    .voice-comment-label {
      font-size: 11px !important;
      color: #7c3aed !important;
      font-weight: 500 !important;
      display: flex !important;
      align-items: center !important;
      gap: 4px !important;
    }

    /* ── Settings sidebar tabs (remove emoji dependency) ── */
    .stab-icon { display: none !important; }

    /* ── Profile menu items ── */
    .profile-menu-icon { display: none !important; }
    .profile-menu button { gap: 10px !important; }

    /* ── Password toggle ── */
    .pw-toggle { font-size: 0 !important; }
    .pw-toggle svg { width: 16px; height: 16px; display: inline-block; }

    /* ════════════════════════════════════════════════════════
       SYRUVIA COLOR SYSTEM — vivid status, priority, dates
       ════════════════════════════════════════════════════════ */

    /* ── Sidebar nav ── */
    #sidebar { background: linear-gradient(180deg,#0f0f23 0%,#1a1040 100%) !important; border-right: none !important; }
    #sidebar .nav-item { color: rgba(255,255,255,.55) !important; border-radius: 10px !important; margin-bottom: 2px !important; transition: all .15s !important; }
    #sidebar .nav-item:hover { color: #fff !important; background: rgba(255,255,255,.1) !important; }
    #sidebar .nav-item.active { color: #fff !important; background: linear-gradient(135deg,rgba(99,102,241,.7),rgba(124,58,237,.5)) !important; box-shadow: 0 4px 12px rgba(99,102,241,.3) !important; }
    #sidebar .nav-item svg { opacity: .7 !important; }
    #sidebar .nav-item:hover svg, #sidebar .nav-item.active svg { opacity: 1 !important; }
    .sb-logo-text { color: #fff !important; }
    .sb-user-name { color: rgba(255,255,255,.9) !important; }
    .sb-user-role { color: rgba(255,255,255,.45) !important; }
    .sb-divider { background: rgba(255,255,255,.08) !important; }
    #sidebar .sb-section-title { color: rgba(255,255,255,.3) !important; }
    .sb-collapse-btn { color: rgba(255,255,255,.4) !important; }
    .sb-collapse-btn:hover { color: #fff !important; background: rgba(255,255,255,.1) !important; }
    /* sidebar badge (ticket count) */
    #sidebar .nav-badge { background: #6366f1 !important; color: #fff !important; }

    /* ── Topbar ── */
    #topbar { background: rgba(255,255,255,.95) !important; border-bottom: 1px solid #e8e5ff !important; backdrop-filter: blur(12px) !important; }

    /* ── Stat cards — vivid hover ── */
    .stat-card { transition: transform .18s,box-shadow .18s,border-color .18s !important; border: 1.5px solid transparent !important; cursor: default !important; }
    .stat-card:hover { transform: translateY(-3px) !important; box-shadow: 0 12px 32px rgba(99,102,241,.14) !important; border-color: #c7d2fe !important; }
    .stat-card .stat-icon { border-radius: 14px !important; }
    /* Stat icon accent colors */
    .stat-card:nth-child(1) .stat-icon { background: linear-gradient(135deg,#eff6ff,#dbeafe) !important; }
    .stat-card:nth-child(2) .stat-icon { background: linear-gradient(135deg,#fefce8,#fef9c3) !important; }
    .stat-card:nth-child(3) .stat-icon { background: linear-gradient(135deg,#fef2f2,#fee2e2) !important; }
    .stat-card:nth-child(4) .stat-icon { background: linear-gradient(135deg,#f0fdf4,#dcfce7) !important; }
    .stat-card .stat-change { font-size: 11px !important; font-weight: 600 !important; }
    .stat-card .stat-change.up { color: #16a34a !important; }
    .stat-card .stat-change.dn { color: #dc2626 !important; }

    /* ── Status badges — vivid ── */
    .badge-status,
    span[class*="s-open"], span[class*="s-ip"], span[class*="s-pr"],
    span[class*="s-oh"], span[class*="s-cl"], span[class*="s-ov"], span[class*="s-ir"] {
      font-weight: 700 !important; letter-spacing: .02em !important;
      border-radius: 6px !important; padding: 3px 9px !important; font-size: 10.5px !important;
    }
    .s-open  { background: #eff6ff !important; color: #1d4ed8 !important; border: 1px solid #bfdbfe !important; }
    .s-ip    { background: #fffbeb !important; color: #b45309 !important; border: 1px solid #fde68a !important; }
    .s-pr    { background: #f5f3ff !important; color: #6d28d9 !important; border: 1px solid #ddd6fe !important; }
    .s-oh    { background: #f8fafc !important; color: #475569 !important; border: 1px solid #cbd5e1 !important; }
    .s-cl    { background: #f0fdf4 !important; color: #15803d !important; border: 1px solid #bbf7d0 !important; }
    .s-ov    { background: #fef2f2 !important; color: #b91c1c !important; border: 1px solid #fecaca !important; }
    .s-ir    { background: #eef2ff !important; color: #4338ca !important; border: 1px solid #c7d2fe !important; }

    /* ── Priority badges — vivid ── */
    .p-h { background: #fef2f2 !important; color: #b91c1c !important; border: 1px solid #fecaca !important; font-weight: 700 !important; }
    .p-m { background: #fff7ed !important; color: #c2410c !important; border: 1px solid #fed7aa !important; font-weight: 700 !important; }
    .p-l { background: #f0fdf4 !important; color: #15803d !important; border: 1px solid #bbf7d0 !important; font-weight: 700 !important; }
    .p-u { background: #fef2f2 !important; color: #991b1b !important; border: 1px solid #fca5a5 !important; font-weight: 700 !important; }

    /* ── Ticket table rows ── */
    .tbl tbody tr { transition: background .12s !important; }
    .tbl tbody tr:hover td { background: #f5f3ff !important; }
    .tbl tbody tr:hover td:first-child { border-left: 3px solid #6366f1 !important; padding-left: 9px !important; }

    /* ── Due date colors ── */
    .due-overdue  { color: #dc2626 !important; font-weight: 700 !important; }
    .due-soon     { color: #d97706 !important; font-weight: 600 !important; }
    .due-ok       { color: #16a34a !important; }
    .due-none     { color: #94a3b8 !important; }

    /* ── Cards ── */
    .card { border: 1px solid #ede9ff !important; }
    .card:hover { box-shadow: 0 8px 32px rgba(99,102,241,.08) !important; }

    /* ── Kanban cards ── */
    .kanban-card { border: 1.5px solid #ede9ff !important; transition: all .18s !important; }
    .kanban-card:hover { transform: translateY(-3px) !important; box-shadow: 0 10px 28px rgba(99,102,241,.15) !important; border-color: #a5b4fc !important; }
    .kanban-card .k-id { color: #6366f1 !important; }

    /* ── Buttons ── */
    .btn-primary { background: linear-gradient(135deg,#4f46e5,#7c3aed) !important; box-shadow: 0 4px 14px rgba(79,70,229,.3) !important; border: none !important; }
    .btn-primary:hover { transform: translateY(-1px) !important; box-shadow: 0 6px 20px rgba(79,70,229,.4) !important; }
    button[class*="btn-primary"] { background: linear-gradient(135deg,#4f46e5,#7c3aed) !important; }

    /* ── Progress bars ── */
    .progress-fill { background: linear-gradient(90deg,#6366f1,#8b5cf6) !important; }
    .workload-bar .progress-fill { height: 7px !important; }

    /* ── Notification badge ── */
    .notif-badge { background: linear-gradient(135deg,#ef4444,#dc2626) !important; box-shadow: 0 2px 8px rgba(239,68,68,.4) !important; }

    /* ── Ticket ID links ── */
    .ticket-id, [class*="tkt-id"], .k-id { color: #6366f1 !important; }

    /* ── Dashboard donut center text ── */
    #page-dashboard svg text { fill: #1e1b4b !important; }

    /* ── Settings tabs active ── */
    .settings-tab.active { background: linear-gradient(135deg,#eff6ff,#eef2ff) !important; color: #4f46e5 !important; border-left: 3px solid #6366f1 !important; font-weight: 700 !important; }
    .settings-tab:hover:not(.active) { background: #f9f8ff !important; color: #6366f1 !important; }

    /* ── Team workload bars ── */
    .workload-bar { background: #f0edff !important; }

    /* ── Search bar focus ── */
    .search-wrap input:focus { border-color: #6366f1 !important; box-shadow: 0 0 0 4px rgba(99,102,241,.1) !important; }

    /* ── Activity timeline dots ── */
    .timeline-dot { border-color: #6366f1 !important; }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #c7d2fe; border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: #818cf8; }

  </style>
`;

html = html.replace('</head>', DESIGN_CSS + '\n</head>');

// ── Clear all hardcoded fake data arrays from source template ─────────────────
// Replace populated static arrays with empty ones; real data comes from API calls
html = html.replace(
  /const COMMENTS_DATA = \[[\s\S]*?\];/,
  'const COMMENTS_DATA = [];'
);
html = html.replace(
  /let TICKETS_DATA = \[[\s\S]*?\];/,
  'let TICKETS_DATA = [];'
);
html = html.replace(
  /let TEAM_DATA = \[[\s\S]*?\];/,
  'let TEAM_DATA = [];'
);
html = html.replace(
  /let DASH_ACTIVITY = \[[\s\S]*?\];/,
  'let DASH_ACTIVITY = [];'
);
// CAL_EVENTS is an object — replace the whole populated literal with an empty object
html = html.replace(
  /const CAL_EVENTS = \{[\s\S]*?\};/,
  'const CAL_EVENTS = {};'
);
// Clear fake NOTIFICATIONS array — real ones come from /api/notifications
html = html.replace(
  /let NOTIFICATIONS = \[[\s\S]*?\];/,
  'let NOTIFICATIONS = [];'
);

// ── Remove hardcoded badge "8" from Tickets nav ──────────────────────────────
html = html.replace(
  'Tickets <span class="badge">8</span>',
  'Tickets <span class="badge" id="nav-tickets-badge" style="display:none"></span>'
);

// ── Targeted patches ──────────────────────────────────────────────────────────

// 1. "Mine" tab filter - use logged-in user name instead of hardcoded "John Doe"
html = html.replaceAll(
  "getAssignees(t).includes('John Doe')",
  "getAssignees(t).includes((window.CURRENT_USER||{name:'John Doe'}).name)"
);

// 2. Reporter default in create ticket form
html = html.replace(
  "document.getElementById('m-reporter')?.value || 'John Doe'",
  "document.getElementById('m-reporter')?.value || (window.CURRENT_USER||{name:'John Doe'}).name"
);

// 3. Status-change activity log attribution
html = html.replace(
  "by John Doe`, 'var(--yellow)'",
  "by ${(window.CURRENT_USER||{name:'John Doe'}).name}`, 'var(--yellow)'"
);

// 4. Note-added activity log attribution
html = html.replace(
  "Note added by John Doe:",
  "Note added by ${(window.CURRENT_USER||{name:'John Doe'}).name}:"
);

// ── Branding ──────────────────────────────────────────────────────────────────
html = html.replace('<title>WorkNest – Work Management</title>', '<title>Syruvia</title>');

// ── Sidebar: replace WorkNest logo with Syruvia SVG logo + collapse button ────
html = html.replace(
  `    <div class="sb-logo-icon">
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24">
        <rect x="3" y="3" width="8" height="8" rx="1.5" fill="white"/>
        <rect x="13" y="3" width="8" height="8" rx="1.5" fill="white" opacity=".6"/>
        <rect x="3" y="13" width="8" height="8" rx="1.5" fill="white" opacity=".6"/>
        <rect x="13" y="13" width="8" height="8" rx="1.5" fill="white" opacity=".3"/>
      </svg>
    </div>
    <div>
      <div class="sb-logo-text">WorkNest</div>
      <div class="sb-logo-sub">Work Management</div>
    </div>`,
  `    <button onclick="navigate('dashboard')" style="background:none;border:none;cursor:pointer;padding:0;display:flex;align-items:center;flex:1;min-width:0;">
      <img src="/syruvia-logo.svg" class="sb-full-logo" alt="Syruvia">
      <img src="/syruvia-icon.svg" class="sb-icon-logo" alt="Syruvia">
    </button>
    <button class="sb-collapse-btn" onclick="toggleSidebar()" title="Collapse sidebar">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
    </button>`
);

// ── Mobile overlay element (lives just before #app) ───────────────────────────
html = html.replace(
  '</div>\n\n<!-- APP -->',
  '</div>\n<div id="sb-overlay" onclick="closeMobileSidebar()"></div>\n\n<!-- APP -->'
);

// ── Mobile hamburger button in topbar ─────────────────────────────────────────
html = html.replace(
  '    <div class="search-wrap">',
  '    <button class="mob-menu-btn" onclick="openMobileSidebar()" aria-label="Open menu"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>\n    <div class="search-wrap">'
);

// ── Profile menu: modern redesign with SVG icons + real email ────────────────
html = html.replace(
  `<div class="profile-menu" id="profile-menu">
          <div class="profile-menu-head">
            <div class="avatar profile-menu-avatar">JD</div>
            <div>
              <div class="profile-menu-name">John Doe</div>
              <div class="profile-menu-email">john@worknest.com</div>
            </div>
          </div>
          <button onclick="navigate('settings'); closeProfileMenu();"><span class="profile-menu-icon">👤</span><span class="profile-menu-text">My Profile</span></button>
          <button onclick="navigate('my-tickets'); closeProfileMenu();"><span class="profile-menu-icon">✓</span><span class="profile-menu-text">My Tickets</span></button>
          <button onclick="closeProfileMenu();"><span class="profile-menu-icon">🔔</span><span class="profile-menu-text">Notifications</span></button>
          <button onclick="navigate('settings'); closeProfileMenu();"><span class="profile-menu-icon">⚙</span><span class="profile-menu-text">Account Settings</span></button>
          <button onclick="closeProfileMenu();"><span class="profile-menu-icon">?</span><span class="profile-menu-text">Help & Support</span></button>
          <div class="profile-menu-line"></div>
          <button onclick="closeProfileMenu();clearPersistedState();"><span class="profile-menu-icon">⟲</span><span class="profile-menu-text">Reset demo data</span></button>
          <button class="danger" onclick="closeProfileMenu();"><span class="profile-menu-icon">↪</span><span class="profile-menu-text">Sign Out</span></button>
        </div>`,
  `<div class="profile-menu" id="profile-menu">
          <div class="profile-menu-head">
            <div class="avatar profile-menu-avatar">JD</div>
            <div style="min-width:0">
              <div class="profile-menu-name">John Doe</div>
              <div class="profile-menu-email" id="pm-email">admin@worknest.com</div>
            </div>
          </div>
          <button onclick="navigate('settings'); closeProfileMenu();">
            <svg class="pm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            My Profile
          </button>
          <button onclick="navigate('my-tickets'); closeProfileMenu();">
            <svg class="pm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
            My Tickets
          </button>
          <button onclick="navigate('settings'); closeProfileMenu();">
            <svg class="pm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
            Account Settings
          </button>
          <button class="danger" onclick="closeProfileMenu();window.logoutUser&&window.logoutUser();">
            <svg class="pm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Sign Out
          </button>
        </div>`
);

// ── Notification panel: empty state (emoji → SVG) ─────────────────────────────
html = html.replace(
  '<div class="notif-empty-icon">🔔</div>',
  '<div class="notif-empty-icon" style="font-size:0"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.4"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg></div>'
);

// ── Dashboard: inject filter bar above the stat grid ─────────────────────────
html = html.replace(
  `<p style="color:var(--text2);font-size:12px;margin-bottom:18px">Welcome back, John! Here's what's happening.</p>

      <div class="stat-grid">`,
  `<p style="color:var(--text2);font-size:12px;margin-bottom:14px">Welcome back, John! Here's what's happening.</p>

      <div class="page-filter-bar" id="dash-filter-bar">
        <span class="pf-label">Period</span>
        <select class="pf-select" id="dash-period" onchange="applyDashFilters()">
          <option value="all">All Time</option>
          <option value="month" selected>This Month</option>
          <option value="quarter">Last 3 Months</option>
          <option value="year">This Year</option>
        </select>
        <span class="pf-label" style="margin-left:6px">Department</span>
        <select class="pf-select" id="dash-dept" onchange="applyDashFilters()">
          <option value="">All Departments</option>
        </select>
      </div>

      <div class="stat-grid">`
);

// ── Reports: inject filter bar above the report grid ─────────────────────────
html = html.replace(
  `<p style="color:var(--text2);font-size:12px;margin-bottom:16px">Insights and analytics for your team's performance.</p>
      <div class="report-grid">`,
  `<p style="color:var(--text2);font-size:12px;margin-bottom:14px">Insights and analytics for your team's performance.</p>

      <div class="page-filter-bar" id="rpt-filter-bar">
        <span class="pf-label">Period</span>
        <select class="pf-select" id="rpt-period" onchange="applyReportFilters()">
          <option value="all">All Time</option>
          <option value="month" selected>This Month</option>
          <option value="quarter">Last 3 Months</option>
          <option value="year">This Year</option>
        </select>
        <span class="pf-label" style="margin-left:6px">Department</span>
        <select class="pf-select" id="rpt-dept-filter" onchange="applyReportFilters()">
          <option value="">All Departments</option>
        </select>
        <span class="pf-label" style="margin-left:6px">Assignee</span>
        <select class="pf-select" id="rpt-assignee-filter" onchange="applyReportFilters()">
          <option value="">Everyone</option>
        </select>
      </div>

      <div class="report-grid">`
);

// ── Reports page: add IDs so JS can populate with real data ──────────────────
html = html.replace(
  `<div class="card"><div style="font-size:12px;color:var(--text3);margin-bottom:4px">Total Tickets</div><div style="font-size:28px;font-weight:600">1,248</div><div style="font-size:11px;color:var(--green)">↑ 18.2% this month</div></div>`,
  `<div class="card"><div style="font-size:12px;color:var(--text3);margin-bottom:4px">Total Tickets</div><div style="font-size:28px;font-weight:600" id="rpt-total">—</div><div style="font-size:11px;color:var(--green)" id="rpt-total-delta"></div></div>`
);
html = html.replace(
  `<div class="card"><div style="font-size:12px;color:var(--text3);margin-bottom:4px">Avg. Resolution Time</div><div style="font-size:28px;font-weight:600">2.4d</div><div style="font-size:11px;color:var(--green)">↓ 0.3d from last month</div></div>`,
  `<div class="card"><div style="font-size:12px;color:var(--text3);margin-bottom:4px">Open Tickets</div><div style="font-size:28px;font-weight:600" id="rpt-open">—</div><div style="font-size:11px;color:var(--text3)" id="rpt-open-delta"></div></div>`
);
html = html.replace(
  `<div class="card"><div style="font-size:12px;color:var(--text3);margin-bottom:4px">SLA Compliance</div><div style="font-size:28px;font-weight:600">94%</div><div style="font-size:11px;color:var(--green)">↑ 2% from last month</div></div>`,
  `<div class="card"><div style="font-size:12px;color:var(--text3);margin-bottom:4px">Overdue</div><div style="font-size:28px;font-weight:600" id="rpt-overdue">—</div><div style="font-size:11px;color:var(--text3)" id="rpt-overdue-delta"></div></div>`
);

// ── Reports dept bars: add an id to the container ────────────────────────────
html = html.replace(
  '<div style="font-size:13px;font-weight:500;margin-bottom:14px">Tickets by Department</div>\n          <div style="display:flex;flex-direction:column;gap:10px">',
  '<div style="font-size:13px;font-weight:500;margin-bottom:14px">Tickets by Department</div>\n          <div id="rpt-dept-bars" style="display:flex;flex-direction:column;gap:10px">'
);

// ── Reports: replace monthly chart card with a real data-driven one ──────────
html = html.replace(
  '<div style="font-size:13px;font-weight:500;margin-bottom:14px">Monthly Ticket Volume</div>\n          <div class="bar-chart"',
  '<div style="font-size:13px;font-weight:500;margin-bottom:14px">Monthly Ticket Volume</div>\n          <div id="rpt-monthly-chart" style="display:flex;align-items:flex-end;gap:6px;height:80px;margin-bottom:8px"></div>\n          <div class="bar-chart" style="display:none"'
);

// ── Reports: add Custom Reports section after the grid ───────────────────────
html = html.replace(
  // After the monthly/dept grid, add custom reports
  '</div>\n    </div>\n\n    <!-- ========== SETTINGS ========== -->',
  `      <div style="margin-top:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div style="font-size:13px;font-weight:600">Custom Reports</div>
          <button onclick="generateCustomReport()" style="padding:7px 14px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">+ Generate Report</button>
        </div>
        <div id="custom-report-area" style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
            <div><label style="font-size:11px;color:var(--text2);font-weight:600;display:block;margin-bottom:4px">Status</label>
              <select id="cr-status" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:12px">
                <option value="">All</option><option>Open</option><option>In Progress</option><option>On Hold</option><option>In Review</option><option>Closed</option><option>Overdue</option>
              </select></div>
            <div><label style="font-size:11px;color:var(--text2);font-weight:600;display:block;margin-bottom:4px">Priority</label>
              <select id="cr-priority" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:12px">
                <option value="">All</option><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option>
              </select></div>
            <div><label style="font-size:11px;color:var(--text2);font-weight:600;display:block;margin-bottom:4px">Department</label>
              <select id="cr-dept" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:12px">
                <option value="">All</option><option>Engineering</option><option>Design</option><option>Support</option><option>Operations</option><option>Management</option>
              </select></div>
          </div>
          <div id="cr-results" style="font-size:12px;color:var(--text3);text-align:center;padding:16px">Select filters above and click Generate Report</div>
        </div>
      </div>
    </div>
    </div>

    <!-- ========== SETTINGS ========== -->`
);

// ── Settings: patch profile panel with dynamic header + dept dropdown ─────────
html = html.replace(
  `<div class="avatar" style="width:60px;height:60px;font-size:20px;background:linear-gradient(135deg,#6366f1,#8b5cf6)">JD</div>
            <div><div style="font-size:14px;font-weight:500">John Doe</div><div style="font-size:12px;color:var(--text3)">Product Designer · Acme Solutions</div><button class="btn-sec" style="margin-top:6px;font-size:11px" onclick="alert('Photo upload would open here.')">Change Photo</button></div>`,
  `<div class="avatar" id="prof-avatar" style="width:60px;height:60px;font-size:20px;background:linear-gradient(135deg,#6366f1,#8b5cf6)">?</div>
            <div>
              <div style="font-size:15px;font-weight:600" id="prof-header-name">—</div>
              <div style="font-size:12px;color:var(--text3)" id="prof-header-sub">—</div>
            </div>`
);
// Add dept select + fix email readonly + remove hardcoded values
html = html.replace(
  `<div class="form-row"><label>Full Name</label><input type="text" id="prof-name" value="John Doe"/></div>
            <div class="form-row"><label>Role</label><input type="text" id="prof-role" value="Product Designer"/></div>
            <div class="form-row"><label>Email</label><input type="email" id="prof-email" value="john.doe@acme.com"/></div>`,
  `<div class="form-row"><label>Full Name</label><input type="text" id="prof-name" placeholder="Your name"/></div>
            <div class="form-row"><label>Job Title</label><input type="text" id="prof-role" placeholder="e.g. Developer"/></div>
            <div class="form-row"><label>Email</label><input type="email" id="prof-email" readonly style="opacity:.65;cursor:default" title="Email cannot be changed"/></div>
            <div class="form-row"><label>Department</label><select id="prof-dept"><option value="">— Select —</option></select></div>`
);

// ── Settings: add Reset Data + Admin tabs to sidebar ─────────────────────────
html = html.replace(
  `            <div class="settings-tab" data-stab="permissions" onclick="switchSettingsTab('permissions')">
              <span class="stab-icon">🛡️</span> Permissions
            </div>`,
  `            <div class="settings-tab" data-stab="permissions" onclick="switchSettingsTab('permissions')">
              <span class="stab-icon">🛡️</span> Permissions
            </div>
            <div class="settings-tab" data-stab="admin" onclick="switchSettingsTab('admin')" id="admin-settings-tab" style="display:none">
              <span class="stab-icon">🔧</span> Admin
            </div>
            <div class="settings-tab" data-stab="reset" onclick="switchSettingsTab('reset')" id="reset-settings-tab" style="display:none;color:#dc2626">
              <span class="stab-icon">⚠️</span> Reset Data
            </div>`
);

// ── Settings: add Reset Data + Admin panels ───────────────────────────────────
html = html.replace(
  '<!-- Permissions panel (matrix) -->',
  `<!-- Admin panel -->
        <div class="card settings-panel" id="settings-panel-admin" style="display:none">

          <!-- Users section -->
          <div style="margin-bottom:24px">
            <h2 style="font-size:14px;font-weight:700;margin-bottom:2px">Users</h2>
            <p style="font-size:12px;color:var(--text3);margin:0 0 14px">All accounts in this workspace</p>
            <div id="admin-users-list" style="font-size:12px;color:var(--text3)">Loading...</div>
          </div>

          <!-- Add user section -->
          <div style="padding-top:20px;border-top:1px solid var(--border);margin-bottom:24px">
            <h3 style="font-size:13px;font-weight:700;margin-bottom:12px">Add New User</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
              <div>
                <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:4px">Full Name *</label>
                <input type="text" id="au-name" placeholder="Full name" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:4px">Email Address *</label>
                <input type="email" id="au-email" placeholder="user@example.com" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:4px">Password *</label>
                <input type="password" id="au-password" placeholder="Min. 6 characters" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:4px">Job Title</label>
                <input type="text" id="au-role" placeholder="e.g. Developer" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:4px">Department</label>
                <select id="au-dept" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;box-sizing:border-box">
                  <option value="General">General</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:4px">Access Level</label>
                <select id="au-perm" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;box-sizing:border-box">
                  <option value="Member">Member</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>
            </div>
            <button onclick="adminCreateUser()" style="padding:9px 20px;background:var(--accent);color:#fff;border:none;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer">Create User</button>
          </div>

          <!-- Departments section -->
          <div style="padding-top:20px;border-top:1px solid var(--border)">
            <h3 style="font-size:13px;font-weight:700;margin-bottom:12px">Departments</h3>
            <div id="admin-dept-list" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">Loading...</div>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="text" id="au-new-dept" placeholder="New department name" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px">
              <button onclick="adminAddDepartment()" style="padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">Add Department</button>
            </div>
          </div>
        </div>

        <!-- Reset Data panel (admin only) -->
        <div class="card settings-panel" id="settings-panel-reset" style="display:none">
          <h2 style="font-size:14px;font-weight:700;margin-bottom:4px;color:#dc2626">Reset All Data</h2>
          <p style="font-size:12px;color:var(--text2);margin-bottom:4px">Permanently deletes all tickets, comments, attachments, plans, calendar events, and notifications.</p>
          <p style="font-size:12px;color:var(--text2);margin-bottom:20px"><strong>User accounts and departments are kept.</strong> This cannot be undone.</p>
          <button onclick="confirmResetData()" style="padding:10px 24px;background:#dc2626;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Reset All Data</button>
        </div>

        <!-- Permissions panel (matrix) -->`
);

// ── Notification items: replace ${n.icon} emoji with SVG via getNotifIcon() ────
html = html.replace(
  '<div class="notif-icon-wrap ${n.type}">${n.icon}</div>',
  '<div class="notif-icon-wrap ${n.type}">${window.getNotifIcon ? window.getNotifIcon(n.type) : \'\'}</div>'
);

// ── Patch formatCommentText: VOICENOTE:: prefix renders inline audio player ───
html = html.replace('</body>', `<script>
(function(){

  /* ── 0. Search bar: clear value and prevent browser autofill ── */
  (function() {
    function clearSearch() {
      var gs = document.getElementById('global-search');
      if (!gs) return;
      gs.value = '';
      gs.setAttribute('autocomplete', 'off');
      gs.setAttribute('name', 'syruvia-search-' + Math.random());
    }
    clearSearch();
    setTimeout(clearSearch, 100);
    setTimeout(clearSearch, 500);
    // Prevent Chrome autofill from re-injecting email on focus
    document.addEventListener('focus', function(e) {
      if (e.target && e.target.id === 'global-search') {
        // Only clear if the value looks like an email (autofill artifact)
        if (e.target.value && e.target.value.indexOf('@') !== -1) e.target.value = '';
      }
    }, true);
  })();

  /* ── 0b. Dashboard donut chart: interactive hover with real status counts ── */
  function initDonutHover() {
    var svg = document.querySelector('.donut-chart svg, .chart-donut svg, [class*="donut"] svg');
    if (!svg) return;
    var circles = svg.querySelectorAll('circle[stroke-dasharray]');
    if (!circles.length) return;

    // Fetch real counts
    fetch('/api/stats').then(function(r){ return r.json(); }).then(function(d) {
      var statusMap = {
        'Open': d.open || 0,
        'In Progress': d.inProgress || 0,
        'Overdue': d.overdue || 0,
        'Closed': d.closed || 0
      };

      // Create tooltip div
      var tip = document.createElement('div');
      tip.className = 'donut-tooltip';
      tip.id = 'donut-tip';
      document.body.appendChild(tip);

      // Map stroke colors to statuses
      var colorMap = {
        '#3b82f6': 'Open',
        '#f59e0b': 'In Progress',
        '#ef4444': 'Overdue',
        '#22c55e': 'Closed',
        '#8b5cf6': 'On Hold',
        '#06b6d4': 'In Review',
        '#a855f7': 'Pending Review'
      };

      circles.forEach(function(c) {
        c.classList.add('donut-segment');
        var color = c.getAttribute('stroke') || '';
        var status = colorMap[color] || color;
        var count = statusMap[status] !== undefined ? statusMap[status] : '';

        c.addEventListener('mouseenter', function(e) {
          tip.textContent = status + (count !== '' ? ': ' + count : '');
          tip.classList.add('show');
        });
        c.addEventListener('mousemove', function(e) {
          tip.style.left = (e.clientX + 12) + 'px';
          tip.style.top = (e.clientY - 28) + 'px';
        });
        c.addEventListener('mouseleave', function() {
          tip.classList.remove('show');
        });
      });
    }).catch(function(){});
  }
  setTimeout(initDonutHover, 800);

  /* ── 1. formatCommentText: render VOICENOTE:: as inline audio player ── */
  var _fct = window.formatCommentText;
  window.formatCommentText = function(raw) {
    if (raw && raw.startsWith('VOICENOTE::')) {
      var url = raw.slice(11);
      var safe = url.replace(/"/g, '&quot;');
      return '<div class="voice-comment-player">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2">' +
        '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>' +
        '<path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>' +
        '<audio controls src="' + safe + '" style="height:28px;max-width:200px"></audio>' +
        '<span class="voice-comment-label">Voice note</span></div>';
    }
    return _fct ? _fct.call(this, raw) : (raw || '');
  };

  /* ── 2. Wrap nav item bare text nodes in .nav-label spans + set tooltips ── */
  document.querySelectorAll('#nav .nav-item').forEach(function(item) {
    item.childNodes.forEach(function(node) {
      if (node.nodeType === 3 && node.textContent.trim()) {
        var label = node.textContent.trim();
        // Set tooltip for collapsed state
        if (!item.getAttribute('data-tooltip')) item.setAttribute('data-tooltip', label);
        var span = document.createElement('span');
        span.className = 'nav-label';
        span.style.cssText = 'flex:1;overflow:hidden;text-overflow:clip;white-space:nowrap;';
        span.textContent = node.textContent;
        node.parentNode.replaceChild(span, node);
      }
    });
  });

  /* ── 3. Settings profile panel: populate from real user on every applyUserToUI call ── */
  function fillProfilePanelFromUser(u) {
    if (!u || !u.name) return;
    var initials = u.name.split(' ').map(function(w){ return w[0]||''; }).join('').slice(0,2).toUpperCase();
    var av = document.getElementById('prof-avatar');
    if (av) { av.textContent = initials; av.style.background = 'linear-gradient(135deg,' + (u.color||'#6366f1') + ',' + (u.color||'#8b5cf6') + ')'; }
    var hn = document.getElementById('prof-header-name'); if (hn) hn.textContent = u.name;
    var hs = document.getElementById('prof-header-sub');  if (hs) hs.textContent = (u.role||'') + (u.dept ? ' · ' + u.dept : '');
    var fn = document.getElementById('prof-name');  if (fn) fn.value = u.name;
    var fr = document.getElementById('prof-role');  if (fr) fr.value = u.role||'';
    var fe = document.getElementById('prof-email'); if (fe) fe.value = u.email||'';
    // Load departments and set the dept dropdown
    if (window.loadDepartments) {
      window.loadDepartments().then(function() {
        var fd = document.getElementById('prof-dept'); if (fd && u.dept) fd.value = u.dept;
      });
    }
    // Update profile dropdown menu
    var pmEmail = document.getElementById('pm-email'); if (pmEmail && u.email) pmEmail.textContent = u.email;
    var pmName = document.querySelector('.profile-menu-name'); if (pmName) pmName.textContent = u.name;
  }

  var _origApplyUser = window.applyUserToUI;
  window.applyUserToUI = function(u) {
    if (_origApplyUser) _origApplyUser.call(this, u);
    fillProfilePanelFromUser(u);
  };

  /* ── 4. Reports + Dashboard: load real stats from API with optional filters ── */
  function buildStatsUrl(periodId, deptId, assigneeId) {
    var params = new URLSearchParams();
    var period = document.getElementById(periodId);
    if (period && period.value && period.value !== 'all') params.set('period', period.value);
    var dept = document.getElementById(deptId);
    if (dept && dept.value) params.set('dept', dept.value);
    if (assigneeId) {
      var assignee = document.getElementById(assigneeId);
      if (assignee && assignee.value) params.set('assignee', assignee.value);
    }
    return '/api/stats' + (params.toString() ? '?' + params.toString() : '');
  }

  function populateFilterDropdowns(data) {
    // Populate dept dropdowns
    ['dash-dept','rpt-dept-filter'].forEach(function(id) {
      var el = document.getElementById(id);
      if (!el || !data.allDepts) return;
      var cur = el.value;
      el.innerHTML = '<option value="">All Departments</option>' +
        data.allDepts.map(function(d){ return '<option value="' + d.dept + '">' + d.dept + '</option>'; }).join('');
      if (cur) el.value = cur;
    });
    // Populate assignee dropdown
    var ra = document.getElementById('rpt-assignee-filter');
    if (ra && data.allAssignees) {
      var cur = ra.value;
      ra.innerHTML = '<option value="">Everyone</option>' +
        data.allAssignees.map(function(a){ return '<option value="' + a.name + '">' + a.name + '</option>'; }).join('');
      if (cur) ra.value = cur;
    }
  }

  function pctDelta(cur, prev) {
    if (!prev) return cur > 0 ? 'New this period' : '—';
    var pct = Math.round(((cur - prev) / prev) * 100);
    return (pct >= 0 ? '↑ ' : '↓ ') + Math.abs(pct) + '% vs last month';
  }

  function applyStatsToUI(d) {
    // Dashboard stat cards — values
    var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('dash-stat-total', d.total);
    set('dash-stat-inprogress', d.inProgress);
    set('dash-stat-overdue', d.overdue);
    set('dash-stat-completed', d.completedToday !== undefined ? d.completedToday : '');
    // Dashboard delta labels — real percentages
    set('dash-stat-total-delta', pctDelta(d.total, d.prevTotal));
    // Hide the other fake deltas (no ids on them — patch their content via class)
    document.querySelectorAll('.stat-change:not(#dash-stat-total-delta)').forEach(function(el, i) {
      if (i === 0) el.textContent = pctDelta(d.inProgress, d.prevInProgress);
      if (i === 1) el.textContent = pctDelta(d.overdue, d.prevOverdue);
      if (i === 2) el.textContent = d.completedToday > 0 ? d.completedToday + ' closed today' : 'None closed today';
    });
    // Reports stat cards
    set('rpt-total', d.total);
    set('rpt-total-delta', d.open + ' open · ' + d.closed + ' closed');
    set('rpt-open', d.open);
    set('rpt-open-delta', d.inProgress + ' in progress');
    set('rpt-overdue', d.overdue);
    set('rpt-overdue-delta', d.overdue > 0 ? 'Needs attention' : 'All on track');

    var deptBars = document.getElementById('rpt-dept-bars');
    if (deptBars) {
      var colors = ['var(--accent)','var(--accent2)','#10b981','#f59e0b','#ef4444','#8b5cf6'];
      if (d.byDept && d.byDept.length) {
        var maxCount = d.byDept[0].c;
        deptBars.innerHTML = d.byDept.map(function(row, i) {
          var pct = maxCount > 0 ? Math.round((row.c / maxCount) * 100) : 0;
          return '<div><div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
            '<span style="font-size:12px">' + (row.dept || 'Unknown') + '</span>' +
            '<span style="font-size:12px;font-weight:500">' + row.c + '</span></div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%;background:' + colors[i % colors.length] + '"></div></div></div>';
        }).join('');
      } else {
        deptBars.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:8px 0">No data for selected filters.</div>';
      }
    }

  }

  function renderMonthlyChart(monthly, elId) {
    var el = document.getElementById(elId);
    if (!el || !monthly || !monthly.length) return;
    var maxM = Math.max.apply(null, monthly.map(function(m){ return m.count; })) || 1;
    el.innerHTML = monthly.map(function(m) {
      var h = Math.max(4, Math.round((m.count / maxM) * 76));
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">' +
        '<span style="font-size:10px;color:#64748b">' + (m.count || 0) + '</span>' +
        '<div style="width:100%;background:#3b82f6;border-radius:3px 3px 0 0;height:' + h + 'px;min-height:4px;opacity:.8"></div>' +
        '<span style="font-size:9px;color:#94a3b8">' + m.label + '</span></div>';
    }).join('');
  }

  function applyMonthlyCharts(d) {
    renderMonthlyChart(d.monthly, 'rpt-monthly-chart');
    renderMonthlyChart(d.monthly, 'dash-monthly-chart');
  }

  function loadActivityFeed() {
    var el = document.getElementById('dash-activity');
    if (!el) return;
    fetch('/api/activity').then(function(r){ return r.json(); }).then(function(items) {
      if (!items.length) {
        el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">No activity yet.</div>';
        return;
      }
      el.innerHTML = items.slice(0, 8).map(function(item) {
        return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">' +
          '<div style="width:8px;height:8px;border-radius:50%;background:' + (item.dot || 'var(--accent)') + ';flex-shrink:0;margin-top:4px"></div>' +
          '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;line-height:1.4">' + (item.text || '') + '</div>' +
          (item.ticketId ? '<div style="font-size:11px;color:var(--text3);margin-top:1px">' + item.ticketId + (item.ticketTitle ? ' · ' + item.ticketTitle.slice(0,30) : '') + '</div>' : '') +
          '</div>' +
          '<span style="font-size:10px;color:var(--text3);flex-shrink:0">' + (item.timeAgo || '') + '</span>' +
          '</div>';
      }).join('');
    }).catch(function() {
      if (el) el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">No activity yet.</div>';
    });
  }

  function loadStatsWithFilters(periodId, deptId, assigneeId) {
    var url = buildStatsUrl(periodId, deptId, assigneeId);
    return fetch(url).then(function(r){ return r.json(); }).then(function(d) {
      applyStatsToUI(d);
      applyMonthlyCharts(d);
      populateFilterDropdowns(d);
    }).catch(function(){});
  }

  function loadReportStats() {
    if (!document.getElementById('rpt-total') && !document.getElementById('dash-stat-total')) return;
    loadStatsWithFilters('rpt-period', 'rpt-dept-filter', 'rpt-assignee-filter');
  }

  window.applyDashFilters = function() {
    loadStatsWithFilters('dash-period', 'dash-dept', null);
  };

  window.applyReportFilters = function() {
    loadStatsWithFilters('rpt-period', 'rpt-dept-filter', 'rpt-assignee-filter');
  };

  // Intercept route changes to re-load stats and clear search bar
  var _origNav = window.navigate;
  if (typeof _origNav === 'function') {
    window.navigate = function(route) {
      var r = _origNav.apply(this, arguments);
      if (route === 'reports') setTimeout(loadReportStats, 200);
      if (route === 'dashboard') setTimeout(function(){
        loadStatsWithFilters('dash-period','dash-dept',null);
        loadActivityFeed();
      }, 200);
      // Always clear the search bar on navigation (prevents browser autofill from persisting)
      var _gs = document.getElementById('global-search');
      if (_gs) { _gs.value = ''; setTimeout(function(){ if (_gs) _gs.value = ''; }, 50); }
      return r;
    };
  }
  // Also run on hash change
  window.addEventListener('hashchange', function() {
    var p = location.hash || location.pathname;
    if (p.includes('reports')) setTimeout(loadReportStats, 200);
    if (p.includes('dashboard')) setTimeout(function(){ loadStatsWithFilters('dash-period','dash-dept',null); }, 200);
  });
  // Run on initial load
  setTimeout(function(){
    loadStatsWithFilters('dash-period','dash-dept',null);
    loadActivityFeed();
  }, 300);
  setTimeout(loadReportStats, 300);

  /* ── 4. Notification panel: SVG icons by type ── */
  var NOTIF_ICONS = {
    mention:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
    assigned: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    overdue:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    status:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
    note:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    comment:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
    due:      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    default:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>'
  };
  window.getNotifIcon = function(type) {
    return NOTIF_ICONS[type] || NOTIF_ICONS.default;
  };

  /* ── Custom Reports ── */
  window.generateCustomReport = function() {
    var status = document.getElementById('cr-status')?.value;
    var priority = document.getElementById('cr-priority')?.value;
    var dept = document.getElementById('cr-dept')?.value;
    var results = document.getElementById('cr-results');
    if (!results) return;
    results.innerHTML = '<div style="color:#64748b;padding:8px">Loading...</div>';
    fetch('/api/tickets').then(function(r){ return r.json(); }).then(function(tickets) {
      var filtered = tickets.filter(function(t) {
        return (!status || t.status === status) &&
               (!priority || t.priority === priority) &&
               (!dept || t.dept === dept);
      });
      if (!filtered.length) {
        results.innerHTML = '<div style="color:#94a3b8;padding:16px;text-align:center">No tickets match the selected filters.</div>';
        return;
      }
      var rows = filtered.map(function(t) {
        return '<tr style="border-bottom:1px solid #f1f5f9">' +
          '<td style="padding:8px 6px;font-weight:500">' + t.id + '</td>' +
          '<td style="padding:8px 6px">' + t.title + '</td>' +
          '<td style="padding:8px 6px">' + t.status + '</td>' +
          '<td style="padding:8px 6px">' + t.priority + '</td>' +
          '<td style="padding:8px 6px">' + (t.dept||'') + '</td>' +
          '<td style="padding:8px 6px">' + (t.due||'—') + '</td></tr>';
      }).join('');
      results.innerHTML = '<div style="margin-bottom:8px;font-size:11px;color:#64748b">' + filtered.length + ' tickets found</div>' +
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr style="background:#f8fafc;font-size:11px;color:#64748b">' +
        '<th style="padding:8px 6px;text-align:left">ID</th><th style="padding:8px 6px;text-align:left">Title</th>' +
        '<th style="padding:8px 6px;text-align:left">Status</th><th style="padding:8px 6px;text-align:left">Priority</th>' +
        '<th style="padding:8px 6px;text-align:left">Dept</th><th style="padding:8px 6px;text-align:left">Due</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
    }).catch(function(){ results.innerHTML = '<div style="color:#ef4444">Failed to load tickets.</div>'; });
  };

  /* ── Reset data ── */
  window.confirmResetData = function() {
    if (!confirm('⚠️ RESET ALL DATA\\n\\nThis will permanently delete:\\n• All tickets & comments\\n• Attachments & voice notes\\n• Plans & calendar events\\n• Notifications\\n\\nUser accounts are NOT deleted.\\n\\nContinue?')) return;
    if (!confirm('Final confirmation: delete all data? This CANNOT be undone.')) return;
    fetch('/api/reset', { method: 'POST' })
      .then(function(r){ return r.json(); })
      .then(function(d) {
        if (d.ok) { alert('All data has been reset. User accounts are kept.\\nThe page will reload.'); location.reload(); }
        else alert('Reset failed.');
      })
      .catch(function(){ alert('Reset failed. Please try again.'); });
  };

  /* ── Nav tickets badge: dynamic from real count ── */
  function updateNavBadge() {
    var badge = document.getElementById('nav-tickets-badge');
    if (!badge) return;
    var open = (typeof TICKETS_DATA !== 'undefined' ? TICKETS_DATA : [])
      .filter(function(t){ return t.status !== 'Closed' && t.status !== 'Archived'; }).length;
    badge.textContent = open;
    badge.style.display = open > 0 ? '' : 'none';
  }
  // Hook into renderTickets and initDashboard to keep it current
  var _origRenderTickets2 = window.renderTickets;
  window.renderTickets = function() {
    var r = _origRenderTickets2 ? _origRenderTickets2.apply(this, arguments) : undefined;
    updateNavBadge();
    return r;
  };
  // Also update after app init loads tickets
  setTimeout(updateNavBadge, 1000);

  /* ── Settings: always show profile tab when navigating to settings ── */
  (function patchSettingsNav() {
    var _origNavForSettings = window.navigate;
    window.navigate = function(page) {
      var r = _origNavForSettings ? _origNavForSettings.apply(this, arguments) : undefined;
      if (page === 'settings') {
        setTimeout(function() {
          // Ensure profile panel is visible and active
          if (typeof window.switchSettingsTab === 'function') {
            window.switchSettingsTab('profile');
          } else {
            // Manual fallback: show profile, hide others
            document.querySelectorAll('.settings-panel').forEach(function(p) {
              p.style.display = p.id === 'settings-panel-profile' ? 'block' : 'none';
            });
            document.querySelectorAll('.settings-tab').forEach(function(t) {
              t.classList.toggle('active', t.dataset.stab === 'profile');
            });
          }
          // Fill profile panel — uses shared fillProfilePanelFromUser function
          if (typeof fillProfilePanelFromUser === 'function') {
            fillProfilePanelFromUser(window.CURRENT_USER || {});
          }
        }, 50);
      }
      return r;
    };
  })();

  /* ── Settings: wire saveProfileSettings and changePassword to real API ── */
  (function patchSettingsAPI() {
    var _origSaveProf = window.saveProfileSettings;
    window.saveProfileSettings = async function() {
      var name = (document.getElementById('prof-name')?.value||'').trim();
      var role = (document.getElementById('prof-role')?.value||'').trim();
      var dept = document.getElementById('prof-dept')?.value||'';
      if (!name) { alert('Full name is required.'); return; }
      try {
        var updated = await apiPut('/api/profile', { name, role, dept });
        if (updated.error) { alert(updated.error); return; }
        if (window.CURRENT_USER) { window.CURRENT_USER.name = updated.name; window.CURRENT_USER.role = updated.role; window.CURRENT_USER.dept = updated.dept; }
        if (window.applyUserToUI) window.applyUserToUI(updated); else applyUserToUI(updated);
        // Refresh header
        var hn = document.getElementById('prof-header-name'); if (hn) hn.textContent = updated.name;
        var hs = document.getElementById('prof-header-sub');  if (hs) hs.textContent = (updated.role||'') + (updated.dept ? ' · ' + updated.dept : '');
        var av = document.getElementById('prof-avatar');
        if (av) av.textContent = (updated.name||'?').split(' ').map(function(w){ return w[0]; }).join('').slice(0,2).toUpperCase();
        if (typeof settingsToast === 'function') settingsToast('Profile saved');
        else { var t=document.createElement('div'); t.textContent='✓ Saved'; t.style.cssText='position:fixed;bottom:24px;right:24px;background:#16a34a;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.2)'; document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 2500); }
      } catch(e) { alert('Failed to save profile. Please try again.'); }
    };

    var _origChangePw = window.changePassword;
    window.changePassword = async function() {
      var cur = document.getElementById('pw-current')?.value;
      var nw = document.getElementById('pw-new')?.value;
      var cf = document.getElementById('pw-confirm')?.value;
      if (!cur || !nw || !cf) { alert('Please fill in all password fields.'); return; }
      if (nw !== cf) { alert('New passwords do not match.'); return; }
      if (nw.length < 6) { alert('Password must be at least 6 characters.'); return; }
      try {
        var r = await fetch('/api/profile/password', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: cur, newPassword: nw })
        });
        var data = await r.json();
        if (!r.ok) { alert(data.error || 'Failed to update password.'); return; }
        ['pw-current','pw-new','pw-confirm'].forEach(function(id) {
          var el = document.getElementById(id); if (el) { el.value = ''; el.type = 'password'; }
        });
        if (typeof settingsToast === 'function') settingsToast('Password updated successfully');
        else alert('Password updated!');
      } catch(e) { alert('Failed to update password. Please try again.'); }
    };
  })();

  /* ── Admin Settings tab ── */
  (function initAdminTab() {

    // Load and render user list with delete buttons
    function loadAdminUsers() {
      var list = document.getElementById('admin-users-list');
      if (!list) return;
      fetch('/api/team').then(function(r){ return r.json(); }).then(function(team) {
        if (!team.length) { list.innerHTML = '<p style="color:var(--text3);font-size:12px">No users yet.</p>'; return; }
        var me = (window.CURRENT_USER || {}).id;
        list.innerHTML = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
          '<thead><tr style="background:#f8fafc;border-bottom:1px solid #eef1f9">' +
          '<th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b">Name</th>' +
          '<th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b">Email</th>' +
          '<th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b">Dept</th>' +
          '<th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b">Access</th>' +
          '<th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b"></th>' +
          '</tr></thead><tbody>' +
          team.map(function(m) {
            var bbg = m.permRole==='Owner' ? '#fef9c3' : m.permRole==='Admin' ? '#dde4ff' : '#f0fdf4';
            var bc  = m.permRole==='Owner' ? '#854d0e' : m.permRole==='Admin' ? '#3730a3' : '#166534';
            var canDel = m.permRole !== 'Owner' && m.id !== me;
            var delBtn = canDel
              ? '<button onclick="adminDeleteUser(' + m.id + ')" data-uname="' + (m.name||'').replace(/"/g,'') + '" style="padding:4px 10px;background:#fee2e2;color:#dc2626;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">Delete</button>'
              : '<span style="font-size:11px;color:#cbd5e1">' + (m.id === me ? 'You' : 'Protected') + '</span>';
            return '<tr style="border-bottom:1px solid #f3f5fb">' +
              '<td style="padding:9px 12px;font-weight:500">' + (m.name||'') + '</td>' +
              '<td style="padding:9px 12px;color:#6b7280">' + (m.email||'') + '</td>' +
              '<td style="padding:9px 12px">' + (m.dept||'') + '</td>' +
              '<td style="padding:9px 12px"><span style="padding:2px 9px;border-radius:99px;font-size:10px;font-weight:600;background:' + bbg + ';color:' + bc + '">' + (m.permRole||'Member') + '</span></td>' +
              '<td style="padding:9px 12px">' + delBtn + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }).catch(function() {
        if (list) list.innerHTML = '<p style="color:#ef4444;font-size:12px">Failed to load users.</p>';
      });
    }

    // Load departments into the admin dept list and all dept dropdowns
    window.loadDepartments = function() {
      return fetch('/api/departments').then(function(r){ return r.json(); }).then(function(depts) {
        // Render admin dept tags
        var deptList = document.getElementById('admin-dept-list');
        if (deptList) {
          deptList.innerHTML = depts.map(function(d) {
            return '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:#f0f5ff;border:1px solid #c7d7fe;border-radius:99px;font-size:12px;color:#2563eb">' +
              d + '<button onclick="adminDeleteDepartment(this)" data-dname="' + d.replace(/"/g,'') + '" style="background:none;border:none;color:#93c5fd;cursor:pointer;font-size:13px;line-height:1;padding:0">×</button></span>';
          }).join('');
        }
        // Populate every dept dropdown in the page
        ['prof-dept','au-dept'].forEach(function(id) {
          var sel = document.getElementById(id);
          if (!sel) return;
          var cur = sel.value;
          sel.innerHTML = '<option value="">— Select —</option>' + depts.map(function(d){ return '<option value="' + d + '">' + d + '</option>'; }).join('');
          if (cur) sel.value = cur;
        });
        return depts;
      }).catch(function(){ return []; });
    };

    // Create user directly
    window.adminCreateUser = async function() {
      var name  = (document.getElementById('au-name')?.value||'').trim();
      var email = (document.getElementById('au-email')?.value||'').trim();
      var pw    = document.getElementById('au-password')?.value||'';
      var role  = (document.getElementById('au-role')?.value||'').trim();
      var dept  = document.getElementById('au-dept')?.value||'General';
      var perm  = document.getElementById('au-perm')?.value||'Member';
      if (!name || !email || !pw) { alert('Name, email and password are required.'); return; }
      if (pw.length < 6) { alert('Password must be at least 6 characters.'); return; }
      try {
        var res = await apiPost('/api/admin/users', { name, email, password: pw, role, dept, permRole: perm });
        if (res.error) { alert(res.error); return; }
        alert('User created! ' + name + ' can now log in with their email and password.');
        ['au-name','au-email','au-password','au-role'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
        loadAdminUsers();
      } catch(e) { alert('Failed to create user. Try again.'); }
    };

    // Delete user — id only, name read from button data attribute
    window.adminDeleteUser = async function(id) {
      var btn = document.querySelector('button[onclick="adminDeleteUser(' + id + ')"]');
      var name = btn ? btn.dataset.uname : 'this user';
      if (!confirm('Delete user ' + name + '? This cannot be undone.')) return;
      try {
        var res = await apiDel('/api/admin/users/' + id);
        if (res.error) { alert(res.error); return; }
        loadAdminUsers();
      } catch(e) { alert('Failed to delete user.'); }
    };

    // Add department
    window.adminAddDepartment = async function() {
      var name = (document.getElementById('au-new-dept')?.value||'').trim();
      if (!name) { alert('Enter a department name.'); return; }
      try {
        var res = await apiPost('/api/departments', { name });
        if (res.error) { alert(res.error); return; }
        document.getElementById('au-new-dept').value = '';
        window.loadDepartments();
      } catch(e) { alert('Failed to add department.'); }
    };

    // Delete department — btn element passed from onclick
    window.adminDeleteDepartment = async function(btn) {
      var name = btn.dataset ? btn.dataset.dname : btn;
      if (!confirm('Delete department "' + name + '"? Only possible if no users or tickets use it.')) return;
      try {
        var r = await fetch('/api/departments/' + encodeURIComponent(name), { method: 'DELETE' });
        var res = await r.json();
        if (res.error) { alert(res.error); return; }
        window.loadDepartments();
      } catch(e) { alert('Failed to delete department.'); }
    };

    // Show admin + reset tabs only for Owner/Admin
    window.showAdminTabsIfAllowed = function() {
      var u = window.CURRENT_USER;
      if (!u || !['Owner','Admin'].includes(u.permRole)) return;
      var at = document.getElementById('admin-settings-tab');
      var rt = document.getElementById('reset-settings-tab');
      if (at) at.style.display = '';
      if (rt) rt.style.display = '';
    };

    // Patch switchSettingsTab to load data when admin tab opens
    var _origSST = window.switchSettingsTab;
    window.switchSettingsTab = function(tab) {
      if (_origSST) _origSST(tab);
      if (tab === 'admin') {
        setTimeout(function(){ loadAdminUsers(); window.loadDepartments(); }, 60);
      }
    };

    // Wrap applyUserToUI immediately (no setTimeout race)
    var _origAU = window.applyUserToUI;
    window.applyUserToUI = function(u) { if (_origAU) _origAU(u); window.showAdminTabsIfAllowed(); };
  })();

})();
</script>
</body>`);

// ── Replace static init block with API-backed async init ──────────────────────

const OLD_INIT = `// ============ INIT ============
loadPersistedState();
initDashboard();
initDetailComments();
renderNotifPrefs();
syncPlanReminderNotifications();
syncNotifBadge();
registerBridgeListeners();`;

const NEW_INIT = `// ============ INIT (API-backed) ============
window.CURRENT_USER = null;

// ── Auth helper ───────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const r = await fetch('/api/auth/me');
    if (r.status === 401) { window.location.href = '/login.html'; return null; }
    return await r.json();
  } catch { return null; }
}

// ── Generic API helpers ───────────────────────────────────────────────────────
async function apiGet(p) {
  const r = await fetch(p);
  if (r.status === 401) { window.location.href = '/login.html'; throw new Error('unauth'); }
  if (!r.ok) throw new Error('api-err');
  return r.json();
}
async function apiPost(p, body) {
  const r = await fetch(p, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.status === 401) { window.location.href = '/login.html'; throw new Error('unauth'); }
  return r.json();
}
async function apiPut(p, body) {
  const r = await fetch(p, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.status === 401) { window.location.href = '/login.html'; throw new Error('unauth'); }
  return r.json();
}
async function apiDel(p) {
  const r = await fetch(p, { method:'DELETE' });
  if (r.status === 401) { window.location.href = '/login.html'; throw new Error('unauth'); }
  return r.json();
}

// ── Update DOM with logged-in user info ───────────────────────────────────────
function applyUserToUI(u) {
  document.querySelectorAll('.profile-name, .profile-menu-name').forEach(el => el.textContent = u.name);
  const pn = document.getElementById('prof-name'); if (pn) pn.value = u.name;
  const pr = document.getElementById('prof-role'); if (pr) pr.value = u.role || '';
  const pd = document.getElementById('prof-dept'); if (pd) pd.value = u.dept || '';
  document.querySelectorAll('.sb-user .avatar').forEach(el => {
    el.textContent = u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    el.style.background = 'linear-gradient(135deg,' + (u.color||'#3b82f6') + ',' + (u.color||'#3b82f6') + 'aa)';
  });
}

// ── Invite flow → API ─────────────────────────────────────────────────────────
function patchInviteFlow() {
  const origSend = window.sendInvite;
  if (typeof origSend === 'function') {
    window.sendInvite = async function(...args) {
      const email = (document.getElementById('inv-email')?.value||'').trim();
      const name  = (document.getElementById('inv-name')?.value||'').trim();
      const role  = (document.getElementById('inv-role')?.value||'').trim();
      const dept  = (document.getElementById('inv-dept')?.value||'').trim();
      if (!email || !name) return origSend.apply(this, args);
      try {
        const res = await apiPost('/api/invites', { email, name, role, dept });
        const invites = await apiGet('/api/invites');
        TEAM_INVITES.length = 0;
        invites.filter(i=>i.status==='Pending').forEach(i => TEAM_INVITES.push({id:i.id,name:i.name,email:i.email,role:i.role,dept:i.dept,status:i.status}));
        if (typeof renderTeams==='function') renderTeams();
        if (typeof renderUsersTab==='function') renderUsersTab();
        closeModal('invite');
        if (res.inviteUrl) {
          setTimeout(()=> alert('Invite created!\\n\\nShare this link with ' + name + ':\\n\\n' + res.inviteUrl + '\\n\\n(Copy and send via email or chat)'), 100);
        }
      } catch(e) {
        if (e.message!=='unauth') alert('Could not create invite: ' + (e.message||'unknown error'));
      }
    };
  }
  const origCancel = window.cancelInvite;
  if (typeof origCancel === 'function') {
    window.cancelInvite = async function(id, ...args) {
      try { await apiDel('/api/invites/' + id); } catch {}
      const invites = await apiGet('/api/invites');
      TEAM_INVITES.length = 0;
      invites.filter(i=>i.status==='Pending').forEach(i => TEAM_INVITES.push({id:i.id,name:i.name,email:i.email,role:i.role,dept:i.dept,status:i.status}));
      return origCancel.apply(this, [id, ...args]);
    };
  }
}

// ── Ticket mutations → API ────────────────────────────────────────────────────
function patchTicketMutations() {
  // Keep ticket page stat counts fresh after every render
  const origRenderTickets = window.renderTickets;
  if (typeof origRenderTickets === 'function') {
    window.renderTickets = function(...args) {
      const r = origRenderTickets.apply(this, args);
      updateTicketPageStats();
      return r;
    };
  }

  const origSaveTicket = window.saveTicket;
  if (typeof origSaveTicket === 'function') {
    window.saveTicket = async function(...args) {
      const r = origSaveTicket.apply(this, args);
      const t = TICKETS_DATA[0];
      if (t) {
        try {
          await apiPost('/api/tickets', { ...t, req: t.req });
        } catch(err) {
          if (err.message !== 'unauth') {
            // Roll back the ghost ticket from the UI
            const idx = TICKETS_DATA.findIndex(x => x.id === t.id);
            if (idx !== -1) TICKETS_DATA.splice(idx, 1);
            if (typeof initDashboard === 'function') initDashboard();
            if (typeof renderTickets === 'function') renderTickets();
            alert('Could not save ticket to the server. Please check your connection and try again.');
          }
        }
      }
      return r;
    };
  }

  function wrapMutator(name) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function(...args) {
      const r = orig.apply(this, args);
      setTimeout(() => {
        const t = TICKETS_DATA.find(x=>x.id===currentTicketId);
        if (t) apiPut('/api/tickets/' + t.id, { ...t, req: t.req }).catch(()=>{});
      }, 30);
      return r;
    };
  }
  ['applyStatus','applyAssignee','confirmCloseTicket','reopenTicket',
   'saveEditAllDetails','confirmAssignTicket',
   'applyBulkStatus','applyBulkPriority','applyBulkAssignee','addBulkTag',
   'bulkClose','bulkArchive'
  ].forEach(wrapMutator);

  const origBulkDelete = window.bulkDelete;
  if (typeof origBulkDelete === 'function') {
    window.bulkDelete = function(...args) {
      const toDelete = [...selectedTicketIds];
      const r = origBulkDelete.apply(this, args);
      toDelete.forEach(id => apiDel('/api/tickets/' + id).catch(()=>{}));
      return r;
    };
  }

  const origToggleCheck = window.toggleCheck;
  if (typeof origToggleCheck === 'function') {
    window.toggleCheck = function(...args) {
      const r = origToggleCheck.apply(this, args);
      if (currentTicketId) {
        const det = getTicketDetails(currentTicketId);
        apiPut('/api/tickets/' + currentTicketId + '/details', det).catch(()=>{});
      }
      return r;
    };
  }

  const origSaveEditAll = window.saveEditAllDetails;
  if (typeof origSaveEditAll === 'function') {
    window.saveEditAllDetails = function(...args) {
      const r = origSaveEditAll.apply(this, args);
      if (currentTicketId) {
        setTimeout(() => {
          apiPut('/api/tickets/' + currentTicketId, TICKETS_DATA.find(x=>x.id===currentTicketId)||{}).catch(()=>{});
          apiPut('/api/tickets/' + currentTicketId + '/details', getTicketDetails(currentTicketId)).catch(()=>{});
        }, 50);
      }
      return r;
    };
  }

  const origSubmit = window.submitComment;
  if (typeof origSubmit === 'function') {
    window.submitComment = async function(...args) {
      const el = document.getElementById('comment-text');
      const text = el ? el.value.trim() : '';
      const r = origSubmit.apply(this, args);
      if (text && currentTicketId) apiPost('/api/tickets/' + currentTicketId + '/comments', { text }).catch(()=>{});
      return r;
    };
  }
}

// ── Plan mutations → API ──────────────────────────────────────────────────────
function patchPlanMutations() {
  function syncPlan(id) {
    const p = PLANS.find(x=>x.id===(id||currentPlanId));
    if (!p) return;
    apiPut('/api/plans/' + p.id, {
      title: p.title, notes: p.notes||'', status: p.status,
      reminderAt: p.reminderAt||null, reminderTriggered: !!p.reminderTriggered,
      promotedTicketId: p.promotedTicketId||null
    }).catch(()=>{});
  }

  ['setPlanStatus','savePlanReminder','clearPlanReminder','savePlanNotes'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function(...args) {
      const r = orig.apply(this, args);
      setTimeout(() => syncPlan(), 60);
      return r;
    };
  });

  const origSavePlan = window.savePlan;
  if (typeof origSavePlan === 'function') {
    window.savePlan = async function(...args) {
      const before = new Set(PLANS.map(p=>p.id));
      const r = origSavePlan.apply(this, args);
      setTimeout(async () => {
        for (const p of PLANS) {
          if (!before.has(p.id)) {
            try { await apiPost('/api/plans', { id:p.id, title:p.title, notes:p.notes||'', status:p.status, reminderAt:p.reminderAt||null }); } catch {}
          } else syncPlan(p.id);
        }
      }, 60);
      return r;
    };
  }

  ['deletePlan','deletePlanFromDetail'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function(id, ...args) {
      apiDel('/api/plans/' + (id||currentPlanId)).catch(()=>{});
      return orig.apply(this, [id, ...args]);
    };
  });

  const origAddCmt = window.addPlanComment;
  if (typeof origAddCmt === 'function') {
    window.addPlanComment = async function(...args) {
      const el = document.querySelector('#plan-comment-text,.plan-comment-input');
      const text = el ? el.value.trim() : '';
      const r = origAddCmt.apply(this, args);
      if (text && currentPlanId) apiPost('/api/plans/' + currentPlanId + '/comments', { text }).catch(()=>{});
      return r;
    };
  }
}

// ── Calendar mutations → API ──────────────────────────────────────────────────
function patchCalMutations() {
  const origSaveEv = window.saveEvent;
  if (typeof origSaveEv === 'function') {
    window.saveEvent = async function(...args) {
      const r = origSaveEv.apply(this, args);
      setTimeout(async () => {
        for (const [key, arr] of Object.entries(CAL_EVENTS)) {
          for (const evt of arr) {
            if (!evt._id) {
              try { const res = await apiPost('/api/events', { ...evt, dateKey: key }); evt._id = res.id; } catch {}
            }
          }
        }
      }, 60);
      return r;
    };
  }
  const origDelEv = window.deleteCurrentEvent;
  if (typeof origDelEv === 'function') {
    window.deleteCurrentEvent = async function(...args) {
      if (editingEventKey!=null && editingEventIdx!=null) {
        const evt = (CAL_EVENTS[editingEventKey]||[])[editingEventIdx];
        if (evt?._id) apiDel('/api/events/' + evt._id).catch(()=>{});
      }
      return origDelEv.apply(this, args);
    };
  }
}

// ── Team mutations → API ──────────────────────────────────────────────────────
let _dbTeamIds = {};
function patchTeamMutations() {
  const origRemove = window.removeMember;
  if (typeof origRemove === 'function') {
    window.removeMember = function(idx, ...args) {
      const m = TEAM_DATA[idx];
      const r = origRemove.apply(this, [idx, ...args]);
      if (m && _dbTeamIds[m.name]) apiDel('/api/team/' + _dbTeamIds[m.name]).catch(()=>{});
      return r;
    };
  }
  const origRole = window.changeMemberRole;
  if (typeof origRole === 'function') {
    window.changeMemberRole = function(idx, role, ...args) {
      const m = TEAM_DATA[idx];
      const r = origRole.apply(this, [idx, role, ...args]);
      if (m && _dbTeamIds[m.name]) apiPut('/api/team/' + _dbTeamIds[m.name] + '/role', { permRole: role }).catch(()=>{});
      return r;
    };
  }
}

// ── Profile save ──────────────────────────────────────────────────────────────
(function patchProfileSave() {
  const origSaveProfile = window.saveProfile;
  if (typeof origSaveProfile === 'function') {
    window.saveProfile = async function(...args) {
      const name = document.getElementById('prof-name')?.value?.trim();
      const role = document.getElementById('prof-role')?.value?.trim();
      const dept = document.getElementById('prof-dept')?.value?.trim();
      const r = origSaveProfile.apply(this, args);
      try {
        const updated = await apiPut('/api/profile', { name, role, dept });
        if (window.CURRENT_USER) { window.CURRENT_USER.name = updated.name; window.CURRENT_USER.role = updated.role; }
        if (window.applyUserToUI) window.applyUserToUI(updated); else applyUserToUI(updated);
      } catch {}
      return r;
    };
  }
})();

// ── URL routing — update address bar on every navigate() call ────────────────
(function() {
  const PAGE_PATHS = {
    'dashboard':     '/dashboard',
    'tickets':       '/tickets',
    'my-tickets':    '/my-tickets',
    'planning':      '/planning',
    'calendar':      '/calendar',
    'teams':         '/teams',
    'reports':       '/reports',
    'settings':      '/settings',
    'ticket-detail': '/tickets',
    'plan-detail':   '/planning',
  };

  const origNavigate = window.navigate;
  window.navigate = function(page, ...args) {
    const r = origNavigate.call(this, page, ...args);
    const path = PAGE_PATHS[page] || '/' + page;
    if (window.location.pathname !== path) {
      history.pushState({ page }, '', path);
    }
    return r;
  };

  // Browser back/forward
  window.addEventListener('popstate', function(e) {
    const page = e.state && e.state.page;
    if (page) origNavigate.call(window, page);
  });

  // On initial load, read the URL and navigate to matching page
  window.addEventListener('_wnReady', function() {
    const path = window.location.pathname.slice(1) || 'dashboard';
    const match = Object.keys(PAGE_PATHS).find(k => PAGE_PATHS[k] === '/' + path || k === path);
    if (match && match !== 'dashboard') {
      origNavigate.call(window, match);
      history.replaceState({ page: match }, '', PAGE_PATHS[match] || '/' + match);
    } else {
      history.replaceState({ page: 'dashboard' }, '', '/dashboard');
    }
  });
})();

// ── Logout ────────────────────────────────────────────────────────────────────
window.logoutUser = async function() {
  try { await fetch('/api/auth/logout', { method:'POST' }); } catch {}
  window.location.href = '/login.html';
};

// ── Ticket page stat counts updater ─────────────────────────────────────────
function updateTicketPageStats() {
  const me = (window.CURRENT_USER || {}).name || '';
  const counts = {
    all:      TICKETS_DATA.length,
    mine:     TICKETS_DATA.filter(t => getAssignees(t).includes(me)).length,
    open:     TICKETS_DATA.filter(t => t.status === 'Open').length,
    progress: TICKETS_DATA.filter(t => t.status === 'In Progress').length,
    review:   TICKETS_DATA.filter(t => t.status === 'In Review').length,
    hold:     TICKETS_DATA.filter(t => t.status === 'On Hold').length,
    overdue:  TICKETS_DATA.filter(t => t.overdue || t.status === 'Overdue').length,
    closed:   TICKETS_DATA.filter(t => t.status === 'Closed').length,
    archived: TICKETS_DATA.filter(t => t.status === 'Archived').length,
  };
  // Stat cards (data-filter-tab attribute)
  document.querySelectorAll('[data-filter-tab]').forEach(card => {
    const key = card.dataset.filterTab;
    const el = card.querySelector('.stat-value');
    if (el && counts[key] !== undefined) el.textContent = counts[key].toLocaleString('en-US');
  });
  // Filter tabs (.tab-count spans)
  document.querySelectorAll('[data-ttab]').forEach(btn => {
    const key = btn.dataset.ttab;
    const el = btn.querySelector('.tab-count');
    if (el && counts[key] !== undefined) el.textContent = counts[key].toLocaleString('en-US');
  });
}

// ── Dashboard donut chart updater ────────────────────────────────────────────
function updateDashDonut() {
  const C = 2 * Math.PI * 44;
  const realTotal = TICKETS_DATA.length;
  const counts = {
    'Open':           TICKETS_DATA.filter(t => t.status === 'Open').length,
    'In Progress':    TICKETS_DATA.filter(t => t.status === 'In Progress').length,
    'On Hold':        TICKETS_DATA.filter(t => t.status === 'On Hold').length,
    'In Review':      TICKETS_DATA.filter(t => t.status === 'In Review').length,
    'Closed':         TICKETS_DATA.filter(t => t.status === 'Closed').length,
    'Overdue':        TICKETS_DATA.filter(t => t.status === 'Overdue').length,
    'Pending Review': TICKETS_DATA.filter(t => t.status === 'Pending Review').length,
  };
  const order = ['Open', 'In Progress', 'On Hold', 'In Review', 'Closed'];
  // donut segments use sum of the 5 base categories; extra statuses appear in legend only
  const donutTotal = order.reduce((s, k) => s + (counts[k] || 0), 0);
  const svg = document.querySelector('.donut-wrap svg');
  if (!svg) return;
  const circles = Array.from(svg.querySelectorAll('circle')).filter(c => c.hasAttribute('stroke-dasharray'));
  let offset = 0;
  order.forEach((status, i) => {
    const n = counts[status] || 0;
    const dash = donutTotal > 0 ? (n / realTotal) * C : 0;
    if (circles[i]) {
      circles[i].setAttribute('stroke-dasharray', \`\${dash.toFixed(1)} \${(C - dash).toFixed(1)}\`);
      circles[i].setAttribute('stroke-dashoffset', String((-offset).toFixed(1)));
    }
    offset += dash;
  });
  // Center text = real total
  const texts = svg.querySelectorAll('text');
  if (texts[0]) texts[0].textContent = realTotal.toLocaleString('en-US');
  // Update legend rows for the 5 base categories
  const items = document.querySelectorAll('.donut-wrap .legend-item');
  order.forEach((status, i) => {
    if (!items[i]) return;
    const n = counts[status] || 0;
    const pct = realTotal > 0 ? ((n / realTotal) * 100).toFixed(1) : '0.0';
    const spans = items[i].querySelectorAll('span');
    if (spans.length >= 2) spans[spans.length - 1].textContent = \`\${n.toLocaleString('en-US')} (\${pct}%)\`;
  });
  // Append/update Overdue + Pending Review rows in the legend if they have tickets
  const legendBox = document.querySelector('.donut-wrap > div:last-child');
  if (legendBox) {
    ['Overdue', 'Pending Review'].forEach((status, idx) => {
      const n = counts[status] || 0;
      const pct = realTotal > 0 ? ((n / realTotal) * 100).toFixed(1) : '0.0';
      const extraId = \`dash-legend-extra-\${idx}\`;
      let row = document.getElementById(extraId);
      if (!row) {
        row = document.createElement('div');
        row.id = extraId;
        row.className = 'legend-item';
        const dot = status === 'Overdue' ? '#ef4444' : '#a855f7';
        row.innerHTML = \`<div style="display:flex;align-items:center;gap:5px"><div class="legend-dot" style="background:\${dot}"></div><span style="color:var(--text2)">\${status}</span></div><span style="font-weight:500">—</span>\`;
        legendBox.appendChild(row);
      }
      const spans = row.querySelectorAll('span');
      if (spans.length >= 2) spans[spans.length - 1].textContent = \`\${n.toLocaleString('en-US')} (\${pct}%)\`;
      row.style.display = n > 0 ? '' : 'none';
    });
  }
}

// ── MAIN ASYNC INIT ───────────────────────────────────────────────────────────
async function initApp() {
  const me = await checkAuth();
  if (!me) return;
  window.CURRENT_USER = me;
  // Call via window so IIFE wrappers (profile panel, admin tabs) are triggered
  if (window.applyUserToUI) window.applyUserToUI(me); else applyUserToUI(me);
  if (window.showAdminTabsIfAllowed) window.showAdminTabsIfAllowed();
  // Fix ticketInScope — const CURRENT_USER in template is always 'John Doe'
  // Override it to use the real logged-in user's name
  window.ticketInScope = function(t, s) {
    var myName = (window.CURRENT_USER && window.CURRENT_USER.name) ? window.CURRENT_USER.name : '';
    var assignees = (typeof getAssignees === 'function') ? getAssignees(t) : (t.assignees || [t.assignee || '']);
    if (s === 'assigned')  return assignees.includes(myName);
    if (s === 'requested') return t.req === myName;
    if (s === 'reporting') return t.reporter === myName;
    return false;
  };

  let tickets, team, invites, events, plans, workTasks;
  try {
    [tickets, team, invites, events, plans, workTasks] = await Promise.all([
      apiGet('/api/tickets'),
      apiGet('/api/team'),
      apiGet('/api/invites'),
      apiGet('/api/events'),
      apiGet('/api/plans'),
      apiGet('/api/worktasks'),
    ]);
  } catch(e) {
    if (e.message === 'unauth') return;
    console.warn('WorkNest: API unavailable, using local seed data');
    patchInviteFlow(); patchTicketMutations(); patchPlanMutations();
    patchCalMutations(); patchTeamMutations();
    return;
  }

  // Overwrite globals
  TICKETS_DATA.length = 0;
  tickets.forEach(t => TICKETS_DATA.push(t));

  _dbTeamIds = {};
  TEAM_DATA.length = 0;
  team.forEach(m => {
    _dbTeamIds[m.name] = m.id;
    TEAM_DATA.push({ name:m.name, email:m.email, role:m.role, dept:m.dept, color:m.color, workload:m.workload||0, tickets:m.tickets||0, permRole:m.permRole });
  });

  TEAM_INVITES.length = 0;
  invites.filter(i=>i.status==='Pending').forEach(i => TEAM_INVITES.push({ id:i.id, name:i.name, email:i.email, role:i.role, dept:i.dept, status:i.status }));

  events.forEach(e => {
    if (!CAL_EVENTS[e.dateKey]) CAL_EVENTS[e.dateKey] = [];
    if (!CAL_EVENTS[e.dateKey].some(x=>x._id===e.id)) {
      CAL_EVENTS[e.dateKey].push({ _id:e.id, type:e.type, label:e.label, title:e.title, desc:e.desc, allDay:e.allDay, startTime:e.startTime, endTime:e.endTime, linkedTicketId:e.linkedTicketId, attendees:e.attendees||[], location:e.location, assignee:e.assignee, completed:e.completed, syncsTicket:e.syncsTicket });
    }
  });

  PLANS.length = 0;
  plans.forEach(p => PLANS.push({ id:p.id, title:p.title, notes:p.notes||'', files:p.files||[], status:p.status||'draft', createdAt:p.createdAt||'', updatedAt:p.updatedAt||'', promotedTicketId:p.promotedTicketId||null, reminderAt:p.reminderAt||null, reminderTriggered:!!p.reminderTriggered }));

  // Re-render with live data — replace fake baseline with real DB counts
  DASH_BASELINE.total      = TICKETS_DATA.length;
  DASH_BASELINE.inProgress = TICKETS_DATA.filter(t => t.status === 'In Progress').length;
  DASH_BASELINE.overdue    = TICKETS_DATA.filter(t => t.overdue || t.status === 'Overdue').length;
  DASH_BASELINE.completed  = TICKETS_DATA.filter(t => t.status === 'Closed').length;
  DASH_INITIAL_SNAPSHOT = null;
  captureDashboardBaseline();
  initDashboard();
  updateDashDonut();
  updateTicketPageStats();
  if (currentPage !== 'dashboard') navigate(currentPage);

  // Wire up API save/sync patches
  patchInviteFlow();
  patchTicketMutations();
  patchPlanMutations();
  patchCalMutations();
  patchTeamMutations();

  // Wire up voice + file attachments
  initAttachmentFeature();

  // Load real notifications and start polling
  loadRealNotifications();
  setInterval(loadRealNotifications, 30000);

  // Signal that the app is ready — triggers URL routing from initial path
  window.dispatchEvent(new Event('_wnReady'));
}

// ── Real notifications ────────────────────────────────────────────────────────
async function loadRealNotifications() {
  try {
    const rows = await apiGet('/api/notifications');
    // Map DB rows to the UI format the template expects
    NOTIFICATIONS.length = 0;
    rows.forEach(function(n) {
      NOTIFICATIONS.push({
        id:       n.id,
        type:     n.type || 'mention',
        icon:     n.icon || '🔔',
        unread:   !!n.unread,
        time:     n.time_label || 'Just now',
        text:     n.text || '',
        ticketId: n.ticket_id || '',
      });
    });
    syncNotifBadge();
    // Re-render if panel is currently open
    var panel = document.getElementById('notif-panel');
    if (panel && panel.classList.contains('open')) renderNotifPanel();
  } catch(e) {
    if (e.message !== 'unauth') console.warn('[notif] fetch failed', e);
  }
}

// Wrap markAllNotifsRead to also persist to the API
(function() {
  var _origMark = window.markAllNotifsRead;
  window.markAllNotifsRead = function() {
    if (_origMark) _origMark();
    fetch('/api/notifications/read-all', { method:'PUT' }).catch(function(){});
  };
})();

// Wrap openNotif to also mark as read on the server
(function() {
  var _origOpen = window.openNotif;
  window.openNotif = function(id) {
    fetch('/api/notifications/' + id + '/read', { method:'PUT' }).catch(function(){});
    if (_origOpen) _origOpen(id);
  };
})();

// ── Voice Notes & File Attachments ────────────────────────────────────────────

// Global queue: files staged in the create-ticket modal, uploaded once we get the real ticket ID
window._pendingTicketFiles = [];

// Intercept fetch to catch the POST /api/tickets response and upload staged files immediately
(function() {
  const _origFetch = window.fetch;
  window.fetch = async function(url, opts, ...rest) {
    const result = await _origFetch.call(this, url, opts, ...rest);
    if (typeof url === 'string' && url.includes('/api/tickets') && opts?.method === 'POST' && window._pendingTicketFiles?.length) {
      try {
        const clone = result.clone();
        const data = await clone.json();
        if (data && data.id) {
          const files = [...window._pendingTicketFiles];
          window._pendingTicketFiles = [];
          for (const file of files) {
            try {
              const form = new FormData();
              form.append('file', file, file.name || 'voice-note.webm');
              form.append('ticketId', data.id);
              await _origFetch.call(window, '/api/upload', { method:'POST', body:form });
            } catch(e) { console.warn('[attach] upload failed:', e); }
          }
        }
      } catch(e) {}
    }
    return result;
  };
})();

function initAttachmentFeature() {
  injectAttachmentStyles();
  patchCreateTicketModal();
  watchTicketDetailPanel();
  // Comment attach bar: set up now + re-apply when detail panel opens
  setupCommentAttachBar();
  const _origOTD = window.openTicketDetail;
  if (typeof _origOTD === 'function' && !_origOTD._cmtPatched) {
    const patched = function(id, ...args) {
      const r = _origOTD.call(this, id, ...args);
      setTimeout(setupCommentAttachBar, 400);
      return r;
    };
    patched._cmtPatched = true;
    window.openTicketDetail = patched;
  }
}

function injectAttachmentStyles() {
  if (document.getElementById('wn-attach-styles')) return;
  const s = document.createElement('style');
  s.id = 'wn-attach-styles';
  s.textContent = \`
    .attach-bar { display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap; }
    .attach-btn {
      display:inline-flex; align-items:center; gap:5px;
      background:#f0f5ff; border:1px solid #c7d7fe; color:#2563eb;
      border-radius:8px; padding:5px 11px; font-size:12px; font-weight:500;
      cursor:pointer; transition:all .15s;
    }
    .attach-btn:hover { background:#dbeafe; border-color:#93c5fd; }
    .attach-btn.recording { background:#fee2e2; border-color:#fca5a5; color:#dc2626; animation:rec-pulse 1.2s infinite; }
    @keyframes rec-pulse { 0%,100%{opacity:1} 50%{opacity:.55} }
    .attach-preview-list { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
    .attach-preview-item {
      position:relative; border-radius:10px; overflow:hidden;
      border:1px solid #e4e9f2; background:#f9fafb;
    }
    .attach-preview-item img { width:80px; height:80px; object-fit:cover; display:block; }
    .attach-preview-item audio { max-width:220px; height:32px; display:block; margin:6px; }
    .attach-preview-item .attach-file-info {
      display:flex; align-items:center; gap:6px; padding:8px 10px;
      font-size:11px; color:#4b5563; max-width:200px;
    }
    .attach-preview-item .attach-remove {
      position:absolute; top:3px; right:3px; width:18px; height:18px;
      background:rgba(0,0,0,.5); color:#fff; border-radius:50%; border:none;
      font-size:10px; cursor:pointer; display:flex; align-items:center; justify-content:center;
    }
    .ticket-attachments-section { margin-top:20px; }
    .ticket-attachments-section h4 { font-size:12px; font-weight:600; color:#6b7280; margin:0 0 10px; text-transform:uppercase; letter-spacing:.04em; }
    .ticket-attach-grid { display:flex; flex-wrap:wrap; gap:10px; }
    .ticket-attach-item {
      border-radius:12px; border:1px solid #e4e9f2; overflow:hidden;
      background:#f9fafb; cursor:pointer; transition:box-shadow .15s;
    }
    .ticket-attach-item:hover { box-shadow:0 4px 12px rgba(0,0,0,.1); }
    .ticket-attach-item img { width:120px; height:90px; object-fit:cover; display:block; }
    .ticket-attach-item .attach-meta {
      padding:6px 10px; font-size:10.5px; color:#6b7280; max-width:120px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .ticket-attach-item audio { display:block; margin:8px; max-width:200px; height:32px; }
    .ticket-attach-item .attach-doc { padding:12px 14px; display:flex; align-items:center; gap:8px; font-size:12px; color:#374151; }
    .rec-timer { font-size:11px; font-weight:600; color:#dc2626; min-width:35px; }
  \`;
  document.head.appendChild(s);
}

// ── Create Ticket modal patch ────────────────────────────────────────────────
function patchCreateTicketModal() {
  // Observe DOM for the modal opening
  const observer = new MutationObserver(() => {
    const modal = document.querySelector('.modal-overlay .modal, .modal-overlay .modal-box');
    if (!modal || modal.dataset.attachPatched) return;
    const header = modal.querySelector('.modal-header, h2, h3');
    if (!header || !/create.*ticket/i.test(header.textContent)) return;
    modal.dataset.attachPatched = '1';
    setupTicketModalAttachments(modal);
  });
  observer.observe(document.body, { childList:true, subtree:true });
}

function setupTicketModalAttachments(modal) {
  let pendingFiles = [];
  let voiceBlob = null;
  let recorder = null;
  let recInterval = null;
  let recSeconds = 0;

  // Find or create attach zone (existing attachments box or append after checklist)
  let attachBox = modal.querySelector('.ticket-extra-box:last-of-type');
  if (!attachBox) attachBox = modal;

  // Build UI
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:12px;';
  wrap.innerHTML = \`
    <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;">Attachments & Voice Notes</div>
    <div class="attach-bar">
      <label class="attach-btn" style="cursor:pointer">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        Add Files
        <input type="file" multiple accept="image/*,.pdf,.doc,.docx" style="display:none" id="modal-file-input">
      </label>
      <button class="attach-btn" id="modal-voice-btn" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>
        Record Voice
      </button>
      <span class="rec-timer" id="modal-rec-timer" style="display:none"></span>
    </div>
    <div class="attach-preview-list" id="modal-attach-previews"></div>
  \`;

  // Insert before the submit button
  const submitBtn = modal.querySelector('button.btn-primary');
  if (submitBtn) submitBtn.parentNode.insertBefore(wrap, submitBtn);
  else attachBox.appendChild(wrap);

  // File input handler
  document.getElementById('modal-file-input').addEventListener('change', function() {
    Array.from(this.files).forEach(f => { pendingFiles.push(f); addPreview(f); });
    this.value = '';
  });

  // Voice recording handler
  const voiceBtn = document.getElementById('modal-voice-btn');
  const recTimer = document.getElementById('modal-rec-timer');
  voiceBtn.addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(recInterval);
        recTimer.style.display = 'none';
        voiceBtn.classList.remove('recording');
        voiceBtn.innerHTML = \`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg> Record Voice\`;
        voiceBlob = new Blob(chunks, { type:'audio/webm' });
        voiceBlob.name = \`voice-note-\${Date.now()}.webm\`;
        pendingFiles.push(voiceBlob);
        addPreview(voiceBlob, true);
      };
      recorder.start();
      recSeconds = 0;
      recTimer.style.display = 'inline';
      recTimer.textContent = '0:00';
      recInterval = setInterval(() => {
        recSeconds++;
        recTimer.textContent = Math.floor(recSeconds/60) + ':' + String(recSeconds%60).padStart(2,'0');
      }, 1000);
      voiceBtn.classList.add('recording');
      voiceBtn.innerHTML = \`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop Recording\`;
    } catch(e) {
      alert('Microphone access denied. Please allow microphone access to record voice notes.');
    }
  });

  function addPreview(file, isAudio) {
    const list = document.getElementById('modal-attach-previews');
    const item = document.createElement('div');
    item.className = 'attach-preview-item';
    const idx = pendingFiles.length - 1;

    if (isAudio || file.type?.startsWith('audio/')) {
      const url = URL.createObjectURL(file);
      item.innerHTML = \`<audio controls src="\${url}"></audio><div class="attach-file-info">🎤 Voice note</div>\`;
    } else if (file.type?.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      item.innerHTML = \`<img src="\${url}" alt="\${file.name}">\`;
    } else {
      item.innerHTML = \`<div class="attach-file-info">📄 \${file.name}</div>\`;
    }

    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.textContent = '×';
    rm.onclick = () => { pendingFiles.splice(idx, 1); item.remove(); };
    item.appendChild(rm);
    list.appendChild(item);
  }

  // Stage files into global queue — fetch intercept uploads them with the real ticket ID
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      if (pendingFiles.length === 0) return;
      window._pendingTicketFiles = [...pendingFiles];
      pendingFiles = [];
      document.getElementById('modal-attach-previews').innerHTML = '';
    });
  }
}

// ── Comment section patch ────────────────────────────────────────────────────
function patchCommentSection() {
  // Observe for ticket detail panel opening
  const observer = new MutationObserver(() => {
    document.querySelectorAll('.comment-input-wrap, .cmt-input-wrap, [class*="comment"] textarea').forEach(el => {
      if (el.dataset.attachPatched) return;
      el.dataset.attachPatched = '1';
      setupCommentAttachments(el);
    });
    // Also watch for the send comment button area
    document.querySelectorAll('.add-comment-row, .comment-row, .cmt-row').forEach(el => {
      if (el.dataset.attachPatched) return;
      el.dataset.attachPatched = '1';
      setupCommentAttachments(el);
    });
  });
  observer.observe(document.body, { childList:true, subtree:true });
}

function setupCommentAttachments(container) {
  if (!container.querySelector('textarea, input[type="text"]')) return;
  let pendingFiles = [];
  let recorder = null;
  let recInterval = null;
  let recSeconds = 0;

  const bar = document.createElement('div');
  bar.className = 'attach-bar';
  bar.style.marginTop = '6px';
  bar.innerHTML = \`
    <label class="attach-btn" style="font-size:11px;padding:4px 9px;cursor:pointer">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      File
      <input type="file" multiple accept="image/*,.pdf,.doc,.docx" style="display:none" class="cmt-file-input">
    </label>
    <button class="attach-btn cmt-voice-btn" type="button" style="font-size:11px;padding:4px 9px;">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>
      Voice
    </button>
    <span class="rec-timer cmt-rec-timer" style="display:none"></span>
  \`;

  const previews = document.createElement('div');
  previews.className = 'attach-preview-list';

  container.appendChild(bar);
  container.appendChild(previews);

  bar.querySelector('.cmt-file-input').addEventListener('change', function() {
    Array.from(this.files).forEach(f => { pendingFiles.push(f); addCmtPreview(f); });
    this.value = '';
  });

  const voiceBtn = bar.querySelector('.cmt-voice-btn');
  const timer = bar.querySelector('.cmt-rec-timer');

  voiceBtn.addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(recInterval);
        timer.style.display = 'none';
        voiceBtn.classList.remove('recording');
        voiceBtn.innerHTML = \`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg> Voice\`;
        const blob = new Blob(chunks, { type:'audio/webm' });
        blob.name = \`voice-note-\${Date.now()}.webm\`;
        pendingFiles.push(blob);
        addCmtPreview(blob, true);
      };
      recorder.start();
      recSeconds = 0;
      timer.style.display = 'inline';
      timer.textContent = '0:00';
      recInterval = setInterval(() => {
        recSeconds++;
        timer.textContent = Math.floor(recSeconds/60) + ':' + String(recSeconds%60).padStart(2,'0');
      }, 1000);
      voiceBtn.classList.add('recording');
      voiceBtn.innerHTML = \`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop\`;
    } catch(e) { alert('Microphone access denied.'); }
  });

  function addCmtPreview(file, isAudio) {
    const item = document.createElement('div');
    item.className = 'attach-preview-item';
    const idx = pendingFiles.length - 1;
    if (isAudio || file.type?.startsWith('audio/')) {
      item.innerHTML = \`<audio controls src="\${URL.createObjectURL(file)}"></audio><div class="attach-file-info" style="font-size:10px;padding:2px 6px">🎤 Voice note</div>\`;
    } else if (file.type?.startsWith('image/')) {
      item.innerHTML = \`<img src="\${URL.createObjectURL(file)}" style="width:60px;height:60px;object-fit:cover;display:block">\`;
    } else {
      item.innerHTML = \`<div class="attach-file-info">📄 \${file.name}</div>\`;
    }
    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.textContent = '×';
    rm.onclick = () => { pendingFiles.splice(idx, 1); item.remove(); };
    item.appendChild(rm);
    previews.appendChild(item);
  }

  // Upload files when the send button is clicked (intercept fetch catches comment POST)
  // We upload directly with the known ticket ID right when the button is pressed
  const sendArea = container.closest?.('.right-panel, .td-right') || document.querySelector('.right-panel');
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !/send|comment|add/i.test(btn.textContent + btn.className)) return;
    if (pendingFiles.length === 0) return;
    const ticketId = window.currentDetailTicketId;
    if (!ticketId) return;
    const filesToUpload = [...pendingFiles];
    pendingFiles = [];
    previews.innerHTML = '';
    // Wait briefly for comment to be saved, then upload and refresh attachment list
    await new Promise(r => setTimeout(r, 500));
    for (const file of filesToUpload) {
      try {
        const form = new FormData();
        form.append('file', file, file.name || 'voice-note.webm');
        form.append('ticketId', ticketId);
        await fetch('/api/upload', { method:'POST', body:form });
      } catch(e) { console.warn('[attach] comment upload failed:', e); }
    }
    // Refresh the attachment display
    injectAttachmentsWhenReady(ticketId);
  }, true);
}

// ── Load + display attachments in ticket detail ──────────────────────────────
async function loadTicketAttachments(ticketId) {
  try {
    const atts = await apiGet(\`/api/tickets/\${ticketId}/attachments\`);

    // ── 1. Replace #det-panel-attachments content with real files ────────────
    const attPanel = document.getElementById('det-panel-attachments');
    if (attPanel) {
      attPanel.innerHTML = atts.length === 0
        ? \`<div style="text-align:center;padding:24px;color:var(--text3);font-size:12px">No attachments yet</div>\`
        : '';
      atts.forEach(att => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg2);border-radius:8px;margin-bottom:6px;';
        if (att.mimeType.startsWith('audio/')) {
          row.innerHTML = \`
            <div style="width:28px;height:28px;background:#ede9fe;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">🎤</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;font-weight:500;color:var(--text2);margin-bottom:3px">Voice note · \${att.uploader}</div>
              <audio controls src="\${att.url}" style="height:28px;width:100%;max-width:220px"></audio>
            </div>\`;
        } else if (att.mimeType.startsWith('image/')) {
          row.style.cursor = 'pointer';
          row.onclick = () => window.open(att.url, '_blank');
          row.innerHTML = \`
            <img src="\${att.url}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;flex-shrink:0">
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${att.originalName}</div>
              <div style="font-size:10px;color:var(--text3)">\${att.uploader}</div>
            </div>
            <span style="color:var(--text3);font-size:14px">↓</span>\`;
        } else {
          const ext = att.originalName.split('.').pop().toUpperCase().slice(0,3);
          const bg = ext==='PDF'?'#fef2f2':ext==='DOC'?'#eff6ff':'#f0fdf4';
          const col = ext==='PDF'?'#dc2626':ext==='DOC'?'#2563eb':'#16a34a';
          row.style.cursor = 'pointer';
          row.onclick = () => window.open(att.url, '_blank');
          row.innerHTML = \`
            <div style="width:28px;height:28px;background:\${bg};border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:\${col};flex-shrink:0">\${ext}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${att.originalName}</div>
              <div style="font-size:10px;color:var(--text3)">\${att.uploader}</div>
            </div>
            <span style="color:var(--text3);font-size:14px">↓</span>\`;
        }
        attPanel.appendChild(row);
      });
    }

    // ── 2. Update Attachments tab badge count ────────────────────────────────
    const attTabBtn = Array.from(document.querySelectorAll('.tab')).find(t => /^attachments/i.test(t.textContent.trim()));
    if (attTabBtn) {
      attTabBtn.innerHTML = \`Attachments\${atts.length > 0 ? \` <span class="tab-count">\${atts.length}</span>\` : ''}\`;
    }

    // ── 3. Right panel thumbnail strip (images + audio only) ─────────────────
    const rp = document.querySelector('.right-panel.td-right, .right-panel');
    if (rp) {
      rp.querySelectorAll('.ticket-attachments-section').forEach(el => el.remove());
      const media = atts.filter(a => a.mimeType.startsWith('image/') || a.mimeType.startsWith('audio/'));
      if (media.length > 0) {
        const sec = document.createElement('div');
        sec.className = 'ticket-attachments-section';
        sec.style.cssText = 'padding:12px 14px;border-top:1px solid var(--border);margin-top:8px';
        sec.innerHTML = \`<div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Attachments (\${atts.length})</div>\`;
        media.forEach(att => {
          const el = document.createElement('div');
          el.style.cssText = 'margin-bottom:8px';
          if (att.mimeType.startsWith('audio/')) {
            el.innerHTML = \`<div style="font-size:11px;color:var(--text2);margin-bottom:3px">🎤 \${att.uploader}</div><audio controls src="\${att.url}" style="width:100%;height:30px"></audio>\`;
          } else {
            el.innerHTML = \`<img src="\${att.url}" onclick="window.open('\${att.url}','_blank')" style="width:100%;border-radius:8px;cursor:pointer;max-height:120px;object-fit:cover">\`;
          }
          sec.appendChild(el);
        });
        rp.appendChild(sec);
      }
    }
  } catch(e) {}
}

// Watch the right panel for ticket detail renders and inject attachments + real comments
function watchTicketDetailPanel() {
  const _orig = window.openTicketDetail;
  if (typeof _orig === 'function') {
    window.openTicketDetail = function(id, ...args) {
      window.currentDetailTicketId = id;
      const r = _orig.call(this, id, ...args);
      injectAttachmentsWhenReady(id);
      // Load real comments from API (replaces empty localComments from template)
      apiGet('/api/tickets/' + id + '/comments').then(function(cmts) {
        if (!Array.isArray(cmts)) return;
        localComments.length = 0;
        cmts.forEach(function(c) { localComments.push(c); });
        if (typeof renderComments === 'function') renderComments();
        // Update comment count badge
        var badge = document.querySelector('.right-panel .section-title .badge, [data-section="comments"] .badge');
        if (badge) badge.textContent = cmts.length;
        var countEl = document.querySelector('.comments-count');
        if (countEl) countEl.textContent = cmts.length;
      }).catch(function(){});
      return r;
    };
  }
}

function injectAttachmentsWhenReady(ticketId) {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    const panel = document.getElementById('det-panel-attachments');
    if (panel && (document.querySelector('.right-panel')?.textContent.includes(ticketId) || attempts > 8)) {
      clearInterval(interval);
      await loadTicketAttachments(ticketId);
    }
    if (attempts > 15) clearInterval(interval);
  }, 250);
}

// ── Comment section: direct wire-up ─────────────────────────────────────────
function setupCommentAttachBar() {
  const box = document.querySelector('.td-composer-box');
  if (!box || box.dataset.attachBarAdded) return;
  box.dataset.attachBarAdded = '1';

  let cmtPendingFiles = [];
  let cmtRecorder = null;
  let cmtRecInterval = null;
  let cmtRecSecs = 0;

  // Insert bar inside the composer box, above the actions row
  const bar = document.createElement('div');
  bar.className = 'attach-bar';
  bar.style.cssText = 'padding:4px 10px 6px;border-top:1px solid var(--border);';
  bar.innerHTML = \`
    <label class="attach-btn" style="font-size:11px;padding:4px 10px;cursor:pointer">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      Attach File
      <input type="file" multiple accept="image/*,.pdf,.doc,.docx" style="display:none" id="cmt-file-input">
    </label>
    <button class="attach-btn cmt-voice-btn" type="button" id="cmt-voice-btn" style="font-size:11px;padding:4px 10px;">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>
      Voice Note
    </button>
    <span class="rec-timer" id="cmt-rec-timer" style="display:none"></span>
    <div class="attach-preview-list" id="cmt-previews" style="width:100%;margin-top:4px"></div>
  \`;
  const actions = box.querySelector('.td-composer-actions');
  if (actions) box.insertBefore(bar, actions);
  else box.appendChild(bar);

  // File input
  document.getElementById('cmt-file-input').addEventListener('change', function() {
    Array.from(this.files).forEach(f => { cmtPendingFiles.push(f); addCmtPreview(f); });
    this.value = '';
  });

  // Voice recording
  const voiceBtn = document.getElementById('cmt-voice-btn');
  const recTimer = document.getElementById('cmt-rec-timer');
  voiceBtn.addEventListener('click', async () => {
    if (cmtRecorder && cmtRecorder.state === 'recording') { cmtRecorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      cmtRecorder = new MediaRecorder(stream);
      cmtRecorder.ondataavailable = e => chunks.push(e.data);
      cmtRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(cmtRecInterval);
        recTimer.style.display = 'none';
        voiceBtn.classList.remove('recording');
        voiceBtn.innerHTML = \`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg> Voice Note\`;
        const blob = new Blob(chunks, { type: 'audio/webm' });
        blob.name = \`voice-\${Date.now()}.webm\`;
        cmtPendingFiles.push(blob);
        addCmtPreview(blob, true);
      };
      cmtRecorder.start();
      cmtRecSecs = 0;
      recTimer.style.display = 'inline';
      recTimer.textContent = '0:00';
      cmtRecInterval = setInterval(() => {
        cmtRecSecs++;
        recTimer.textContent = Math.floor(cmtRecSecs/60) + ':' + String(cmtRecSecs%60).padStart(2,'0');
      }, 1000);
      voiceBtn.classList.add('recording');
      voiceBtn.innerHTML = \`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop\`;
    } catch(e) { alert('Microphone access denied.'); }
  });

  function addCmtPreview(file, isAudio) {
    const list = document.getElementById('cmt-previews');
    const item = document.createElement('div');
    item.className = 'attach-preview-item';
    const idx = cmtPendingFiles.length - 1;
    if (isAudio || file.type?.startsWith('audio/')) {
      item.innerHTML = \`<audio controls src="\${URL.createObjectURL(file)}" style="height:28px"></audio><div class="attach-file-info" style="font-size:10px">🎤 Voice note</div>\`;
    } else if (file.type?.startsWith('image/')) {
      item.innerHTML = \`<img src="\${URL.createObjectURL(file)}" style="width:52px;height:52px;object-fit:cover;display:block">\`;
    } else {
      item.innerHTML = \`<div class="attach-file-info">📄 \${file.name}</div>\`;
    }
    const rm = document.createElement('button');
    rm.className = 'attach-remove'; rm.textContent = '×';
    rm.onclick = () => { cmtPendingFiles.splice(idx, 1); item.remove(); };
    item.appendChild(rm);
    list.appendChild(item);
  }

  // Patch addComment: save text to API, audio files → VOICENOTE:: comment, others → attachment
  const _origAddComment = window.addComment;
  if (typeof _origAddComment === 'function') {
    window.addComment = async function(...args) {
      const txtEl = document.getElementById('comment-input');
      const commentText = txtEl ? txtEl.value.trim() : '';
      const filesToUpload = [...cmtPendingFiles];
      cmtPendingFiles = [];
      document.getElementById('cmt-previews').innerHTML = '';
      const r = await _origAddComment.apply(this, args);
      const ticketId = window.currentDetailTicketId;
      if (ticketId) {
        // Save text comment to API
        if (commentText) {
          apiPost('/api/tickets/' + ticketId + '/comments', { text: commentText }).catch(()=>{});
        }
        // Handle attached files
        if (filesToUpload.length > 0) {
          let needsAttachRefresh = false;
          for (const file of filesToUpload) {
            try {
              const form = new FormData();
              form.append('file', file, file.name || 'voice.webm');
              form.append('ticketId', ticketId);
              const resp = await fetch('/api/upload', { method: 'POST', body: form });
              if (file.type && file.type.startsWith('audio/')) {
                // Post audio as a voice note comment so it appears in the comment thread
                const data = await resp.json();
                if (data && data.url) {
                  await apiPost('/api/tickets/' + ticketId + '/comments', { text: 'VOICENOTE::' + data.url });
                  try {
                    const cmts = await apiGet('/api/tickets/' + ticketId + '/comments');
                    if (Array.isArray(cmts)) {
                      localComments.length = 0;
                      cmts.forEach(c => localComments.push(c));
                      renderComments();
                    }
                  } catch {}
                }
              } else {
                needsAttachRefresh = true;
              }
            } catch(e) {}
          }
          if (needsAttachRefresh) setTimeout(() => injectAttachmentsWhenReady(ticketId), 300);
        }
      }
      return r;
    };
  }
}

// ── Sidebar collapse / mobile toggle ─────────────────────────────────────────
window.toggleSidebar = function() {
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  var collapsed = sb.classList.toggle('collapsed');
  // Force inline width so no external CSS can fight it
  sb.style.width = collapsed ? '64px' : '220px';
  try { localStorage.setItem('wn_sb_collapsed', collapsed ? '1' : '0'); } catch(e) {}
};
window.openMobileSidebar = function() {
  document.getElementById('sidebar')?.classList.add('mobile-open');
};
window.closeMobileSidebar = function() {
  document.getElementById('sidebar')?.classList.remove('mobile-open');
};
// Restore sidebar collapsed state across page loads
(function() {
  try {
    var sb = document.getElementById('sidebar');
    if (sb && localStorage.getItem('wn_sb_collapsed') === '1') {
      sb.classList.add('collapsed');
      sb.style.width = '64px';
    }
  } catch(e) {}
})();

// ── Bootstrap: fast local render, then API overwrite ─────────────────────────
// Zero the hardcoded baseline so stats don't flash fake numbers
DASH_BASELINE.total = 0; DASH_BASELINE.inProgress = 0;
DASH_BASELINE.overdue = 0; DASH_BASELINE.completed = 0;
loadPersistedState();
initDashboard();
initDetailComments();
renderNotifPrefs();
syncPlanReminderNotifications();
syncNotifBadge();
registerBridgeListeners();
initApp();`;

if (!html.includes(OLD_INIT)) {
  console.error('ERROR: init block not found in source HTML. Check the source file.');
  process.exit(1);
}

html = html.replace(OLD_INIT, NEW_INIT);

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, html, 'utf8');

console.log(`✅  Written ${html.length.toLocaleString()} chars to ${DEST}`);
console.log('✅  Patches applied: mine filter, reporter default, attribution, init block');
