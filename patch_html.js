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
      overflow: hidden !important;
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

    /* ── Profile menu ── */
    .profile-menu { border-radius: 16px !important; box-shadow: 0 8px 28px rgba(16,24,40,.12) !important; overflow: hidden !important; }

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
  </style>
`;

html = html.replace('</head>', DESIGN_CSS + '\n</head>');

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
      if (t) apiPost('/api/tickets', { ...t, req: t.req }).catch(()=>{});
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
        applyUserToUI(updated);
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
  applyUserToUI(me);

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

  // Signal that the app is ready — triggers URL routing from initial path
  window.dispatchEvent(new Event('_wnReady'));
}

// ── Bootstrap: fast local render, then API overwrite ─────────────────────────
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
