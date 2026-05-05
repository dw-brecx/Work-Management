"""
Copies worknest HTML to public/index.html and injects API integration.
Run once: python patch_html.py
"""
import os
import re

SRC  = r'C:\Users\Duvy Weiss\Downloads\worknest (8).html'
DEST = r'C:\Users\Duvy Weiss\Documents\Syruvia T App\public\index.html'

with open(SRC, 'r', encoding='utf-8') as f:
    html = f.read()

# ── Targeted patches ──────────────────────────────────────────────────────────

# 1. "Mine" tab filter uses hardcoded 'John Doe' → use logged-in user
html = html.replace(
    "getAssignees(t).includes('John Doe')",
    "getAssignees(t).includes((window.CURRENT_USER||{name:'John Doe'}).name)"
)

# 2. Reporter default in saveTicket
html = html.replace(
    "document.getElementById('m-reporter')?.value || 'John Doe'",
    "document.getElementById('m-reporter')?.value || (window.CURRENT_USER||{name:'John Doe'}).name"
)

# 3. Activity log: status change attribution
html = html.replace(
    "by John Doe`, 'var(--yellow)'",
    "by ${(window.CURRENT_USER||{name:'John Doe'}).name}`, 'var(--yellow)'"
)

# 4. Activity log: note added attribution
html = html.replace(
    "Note added by John Doe:",
    "Note added by ${(window.CURRENT_USER||{name:'John Doe'}).name}:"
)

# 5. Replace the static init block with our API-backed version
OLD_INIT = """// ============ INIT ============
loadPersistedState();
initDashboard();
initDetailComments();
renderNotifPrefs();
syncPlanReminderNotifications();
syncNotifBadge();
registerBridgeListeners();"""

NEW_INIT = r"""// ============ INIT (API-backed) ============
window.CURRENT_USER = null;

// ── Auth redirect ────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const r = await fetch('/api/auth/me');
    if (r.status === 401) { window.location.href = '/login.html'; return null; }
    return await r.json();
  } catch { return null; }
}

// ── Generic API helpers ──────────────────────────────────────────────────────
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

// ── Update UI with logged-in user info ───────────────────────────────────────
function applyUserToUI(u) {
  document.querySelectorAll('.profile-name, .profile-menu-name').forEach(el => el.textContent = u.name);
  const profName = document.getElementById('prof-name');
  if (profName) profName.value = u.name;
  const profRole = document.getElementById('prof-role');
  if (profRole) profRole.value = u.role || '';
  const profDept = document.getElementById('prof-dept');
  if (profDept) profDept.value = u.dept || '';
  // Sidebar avatar
  document.querySelectorAll('.sb-user .avatar').forEach(el => {
    el.textContent = u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    el.style.background = u.color || '#3b82f6';
  });
}

// ── Invite modal: show real link ─────────────────────────────────────────────
function patchInviteFlow() {
  const origSendInvite = window.sendInvite;
  if (typeof origSendInvite === 'function') {
    window.sendInvite = async function(...args) {
      const email = (document.getElementById('inv-email')?.value || '').trim();
      const name  = (document.getElementById('inv-name')?.value  || '').trim();
      const role  = (document.getElementById('inv-role')?.value  || '').trim();
      const dept  = (document.getElementById('inv-dept')?.value  || '').trim();
      if (!email || !name) return origSendInvite.apply(this, args);
      try {
        const res = await apiPost('/api/invites', { email, name, role, dept });
        if (res.inviteUrl) {
          // Refresh TEAM_INVITES from API
          const invites = await apiGet('/api/invites');
          TEAM_INVITES = invites.filter(i=>i.status==='Pending').map(i=>({id:i.id,name:i.name,email:i.email,role:i.role,dept:i.dept,status:i.status}));
          if (typeof renderTeams === 'function') renderTeams();
          if (typeof renderUsersTab === 'function') renderUsersTab();
          closeModal('invite');
          // Show copy-able link
          setTimeout(()=>{
            const msg = `Invite created!\n\nShare this link with ${name}:\n\n${res.inviteUrl}\n\n(Copy and send via email or message)`;
            alert(msg);
          }, 100);
          return;
        }
      } catch(e) {
        if (e.message !== 'unauth') alert('Could not create invite. Please try again.');
      }
    };
  }
  // Cancel invite
  const origCancelInvite = window.cancelInvite;
  if (typeof origCancelInvite === 'function') {
    window.cancelInvite = async function(id, ...args) {
      try { await apiDel(`/api/invites/${id}`); } catch {}
      const invites = await apiGet('/api/invites');
      TEAM_INVITES = invites.filter(i=>i.status==='Pending').map(i=>({id:i.id,name:i.name,email:i.email,role:i.role,dept:i.dept,status:i.status}));
      return origCancelInvite.apply(this, [id, ...args]);
    };
  }
}

// ── Patch ticket mutations to sync with API ──────────────────────────────────
function patchTicketMutations() {
  // CREATE ticket
  const origSaveTicket = window.saveTicket;
  if (typeof origSaveTicket === 'function') {
    window.saveTicket = async function(...args) {
      const r = origSaveTicket.apply(this, args);
      const t = TICKETS_DATA[0];
      if (t) { apiPost('/api/tickets', { ...t, req: t.req }).catch(()=>{}); }
      return r;
    };
  }

  // Generic: after any mutation that touches a ticket, sync it
  function wrapTicketMutator(name, getTicketFn) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function(...args) {
      const r = orig.apply(this, args);
      setTimeout(() => {
        const t = getTicketFn ? getTicketFn() : TICKETS_DATA.find(x=>x.id===currentTicketId);
        if (t) { apiPut(`/api/tickets/${t.id}`, { ...t, req: t.req }).catch(()=>{}); }
      }, 30);
      return r;
    };
  }

  ['applyStatus','applyAssignee','confirmCloseTicket','reopenTicket',
   'saveEditAllDetails','confirmAssignTicket',
   'applyBulkStatus','applyBulkPriority','applyBulkAssignee','addBulkTag','bulkClose','bulkArchive'
  ].forEach(n => wrapTicketMutator(n, null));

  // DELETE bulk
  const origBulkDelete = window.bulkDelete;
  if (typeof origBulkDelete === 'function') {
    window.bulkDelete = function(...args) {
      const toDelete = [...selectedTicketIds];
      const r = origBulkDelete.apply(this, args);
      toDelete.forEach(id => apiDel(`/api/tickets/${id}`).catch(()=>{}));
      return r;
    };
  }

  // Ticket details (description + checklist edits)
  const origSaveEditAll = window.saveEditAllDetails;
  if (typeof origSaveEditAll === 'function') {
    window.saveEditAllDetails = function(...args) {
      const r = origSaveEditAll.apply(this, args);
      setTimeout(() => {
        if (!currentTicketId) return;
        const det = getTicketDetails(currentTicketId);
        apiPut(`/api/tickets/${currentTicketId}/details`, det).catch(()=>{});
      }, 50);
      return r;
    };
  }

  // Checklist toggle
  const origToggleCheck = window.toggleCheck;
  if (typeof origToggleCheck === 'function') {
    window.toggleCheck = function(...args) {
      const r = origToggleCheck.apply(this, args);
      if (currentTicketId) {
        const det = getTicketDetails(currentTicketId);
        apiPut(`/api/tickets/${currentTicketId}/details`, det).catch(()=>{});
      }
      return r;
    };
  }

  // Comments: post to API, let in-memory handle UI
  const origSubmitComment = window.submitComment;
  if (typeof origSubmitComment === 'function') {
    window.submitComment = async function(...args) {
      const textarea = document.getElementById('comment-text');
      const text = textarea ? textarea.value.trim() : '';
      const r = origSubmitComment.apply(this, args);
      if (text && currentTicketId) {
        apiPost(`/api/tickets/${currentTicketId}/comments`, { text }).catch(()=>{});
      }
      return r;
    };
  }
}

// ── Patch plan mutations ─────────────────────────────────────────────────────
function patchPlanMutations() {
  function syncPlan(id) {
    const p = PLANS.find(x=>x.id===id) || PLANS.find(x=>x.id===currentPlanId);
    if (!p) return;
    apiPut(`/api/plans/${p.id}`, {
      title: p.title, notes: p.notes || '', status: p.status,
      reminderAt: p.reminderAt || null, reminderTriggered: p.reminderTriggered,
      promotedTicketId: p.promotedTicketId || null
    }).catch(()=>{});
  }

  ['setPlanStatus','savePlanReminder','clearPlanReminder'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function(...args) {
      const r = orig.apply(this, args);
      setTimeout(() => syncPlan(currentPlanId), 60);
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
            try { await apiPost('/api/plans', { id:p.id, title:p.title, notes:p.notes||'', status:p.status, reminderAt:p.reminderAt||null }); }
            catch {}
          } else {
            syncPlan(p.id);
          }
        }
      }, 60);
      return r;
    };
  }

  const origSavePlanNotes = window.savePlanNotes;
  if (typeof origSavePlanNotes === 'function') {
    window.savePlanNotes = function(...args) {
      const r = origSavePlanNotes.apply(this, args);
      setTimeout(() => syncPlan(currentPlanId), 60);
      return r;
    };
  }

  // Delete plan
  ['deletePlan','deletePlanFromDetail'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function(id, ...args) {
      apiDel(`/api/plans/${id || currentPlanId}`).catch(()=>{});
      return orig.apply(this, [id, ...args]);
    };
  });

  // Plan comments
  const origAddPlanComment = window.addPlanComment;
  if (typeof origAddPlanComment === 'function') {
    window.addPlanComment = async function(...args) {
      const el = document.getElementById('plan-comment-text') || document.querySelector('.plan-comment-input');
      const text = el ? el.value.trim() : '';
      const r = origAddPlanComment.apply(this, args);
      if (text && currentPlanId) {
        apiPost(`/api/plans/${currentPlanId}/comments`, { text }).catch(()=>{});
      }
      return r;
    };
  }
}

// ── Patch calendar mutations ─────────────────────────────────────────────────
function patchCalMutations() {
  const origSaveEvent = window.saveEvent;
  if (typeof origSaveEvent === 'function') {
    window.saveEvent = async function(...args) {
      const r = origSaveEvent.apply(this, args);
      // Sync all events that lack a _id (newly created)
      setTimeout(async () => {
        for (const [key, arr] of Object.entries(CAL_EVENTS)) {
          for (const evt of arr) {
            if (!evt._id) {
              try {
                const res = await apiPost('/api/events', { ...evt, dateKey: key });
                evt._id = res.id;
              } catch {}
            }
          }
        }
      }, 60);
      return r;
    };
  }

  const origDeleteCurrentEvent = window.deleteCurrentEvent;
  if (typeof origDeleteCurrentEvent === 'function') {
    window.deleteCurrentEvent = async function(...args) {
      // Find the event being edited and delete from API
      if (editingEventKey != null && editingEventIdx != null) {
        const evt = CAL_EVENTS[editingEventKey]?.[editingEventIdx];
        if (evt?._id) { apiDel(`/api/events/${evt._id}`).catch(()=>{}); }
      }
      return origDeleteCurrentEvent.apply(this, args);
    };
  }
}

// ── Logout ───────────────────────────────────────────────────────────────────
window.logoutUser = async function() {
  try { await fetch('/api/auth/logout', { method:'POST' }); } catch {}
  window.location.href = '/login.html';
};

// ── Team: remove member & change role via API ────────────────────────────────
function patchTeamMutations() {
  const origRemoveMember = window.removeMember;
  if (typeof origRemoveMember === 'function') {
    window.removeMember = function(idx, ...args) {
      const m = TEAM_DATA[idx];
      if (!m) return origRemoveMember.apply(this, [idx, ...args]);
      const u = (db_team_ids || {})[m.name];
      const r = origRemoveMember.apply(this, [idx, ...args]);
      if (u) apiDel(`/api/team/${u}`).catch(()=>{});
      return r;
    };
  }
  const origChangeRole = window.changeMemberRole;
  if (typeof origChangeRole === 'function') {
    window.changeMemberRole = function(idx, role, ...args) {
      const m = TEAM_DATA[idx];
      const r = origChangeRole.apply(this, [idx, role, ...args]);
      const u = (db_team_ids || {})[m?.name];
      if (u) apiPut(`/api/team/${u}/role`, { permRole: role }).catch(()=>{});
      return r;
    };
  }
}

// Map of name → DB id for team members (filled after fetch)
let db_team_ids = {};

// ── MAIN ASYNC INIT ──────────────────────────────────────────────────────────
async function initApp() {
  // Auth check
  const me = await checkAuth();
  if (!me) return;
  window.CURRENT_USER = me;
  applyUserToUI(me);

  // Fetch all data in parallel
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
    console.warn('WorkNest: API fetch failed, using seed data', e);
    // Fall back gracefully — seed data already loaded
    initDashboard(); initDetailComments(); renderNotifPrefs();
    syncPlanReminderNotifications(); syncNotifBadge(); registerBridgeListeners();
    patchInviteFlow(); patchTicketMutations(); patchPlanMutations();
    patchCalMutations(); patchTeamMutations();
    return;
  }

  // Overwrite in-memory data with API data
  TICKETS_DATA.length = 0;
  tickets.forEach(t => TICKETS_DATA.push(t));

  // Build team id map
  db_team_ids = {};
  TEAM_DATA.length = 0;
  team.forEach(m => {
    db_team_ids[m.name] = m.id;
    TEAM_DATA.push({
      name: m.name, email: m.email, role: m.role, dept: m.dept,
      color: m.color, workload: m.workload || 0, tickets: m.tickets || 0,
      permRole: m.permRole
    });
  });

  TEAM_INVITES.length = 0;
  invites.filter(i => i.status === 'Pending').forEach(i => {
    TEAM_INVITES.push({ id: i.id, name: i.name, email: i.email, role: i.role, dept: i.dept, status: i.status });
  });

  // Calendar events: convert array → CAL_EVENTS dict  (keep existing seed structure)
  events.forEach(e => {
    if (!CAL_EVENTS[e.dateKey]) CAL_EVENTS[e.dateKey] = [];
    // Avoid duplicates from seed
    const already = CAL_EVENTS[e.dateKey].some(x => x._id === e.id);
    if (!already) {
      CAL_EVENTS[e.dateKey].push({
        _id: e.id, type: e.type, label: e.label, title: e.title,
        desc: e.desc, allDay: e.allDay, startTime: e.startTime, endTime: e.endTime,
        linkedTicketId: e.linkedTicketId, attendees: e.attendees || [],
        location: e.location, assignee: e.assignee,
        completed: e.completed, syncsTicket: e.syncsTicket
      });
    }
  });

  // Plans
  PLANS.length = 0;
  plans.forEach(p => PLANS.push({
    id: p.id, title: p.title, notes: p.notes || '',
    files: p.files || [], status: p.status || 'draft',
    createdAt: p.createdAt || '', updatedAt: p.updatedAt || '',
    promotedTicketId: p.promotedTicketId || null,
    reminderAt: p.reminderAt || null,
    reminderTriggered: !!p.reminderTriggered
  }));

  // Reset dashboard baseline so it counts from real data
  DASH_INITIAL_SNAPSHOT = null;
  captureDashboardBaseline();

  // Re-render everything with real data
  initDashboard();
  initDetailComments();
  renderNotifPrefs();
  syncPlanReminderNotifications();
  syncNotifBadge();
  registerBridgeListeners();
  if (currentPage !== 'dashboard') navigate(currentPage);

  // Apply mutation patches (now that functions exist and data is loaded)
  patchInviteFlow();
  patchTicketMutations();
  patchPlanMutations();
  patchCalMutations();
  patchTeamMutations();
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
loadPersistedState();   // fast init with localStorage/seed data
initDashboard();        // show immediately while API loads
initDetailComments();
renderNotifPrefs();
syncPlanReminderNotifications();
syncNotifBadge();
registerBridgeListeners();
initApp();              // then overwrite with live API data"""

assert OLD_INIT in html, "Init block not found — check the source HTML"
html = html.replace(OLD_INIT, NEW_INIT)

# ── Write output ──────────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(DEST), exist_ok=True)
with open(DEST, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"✅  Written {len(html):,} chars to {DEST}")

# Quick sanity check
assert 'initApp' in html
assert "CURRENT_USER" in html
print("✅  Sanity checks passed")
