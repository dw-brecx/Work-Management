require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const { randomUUID } = require('crypto');
const { init: initDb, get, all, run } = require('./db');
const { sendInviteEmail } = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;

initDb();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new FileStore({ path: path.join(__dirname, '.sessions'), retries: 1, ttl: 7 * 24 * 3600 }),
  secret: 'worknest-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); }
}));

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function getUser(userId) {
  return get('SELECT id,name,email,role,dept,color,perm_role FROM users WHERE id=?', userId);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = get('SELECT * FROM users WHERE email=?', email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId = user.id;
  res.json({ id:user.id, name:user.name, email:user.email, role:user.role, dept:user.dept, color:user.color, permRole:user.perm_role });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, token } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const norm = email.toLowerCase().trim();
  if (get('SELECT id FROM users WHERE email=?', norm)) return res.status(409).json({ error: 'Email already registered' });

  let role='Team Member', dept='General', permRole='Member';
  if (token) {
    const invite = get("SELECT * FROM invites WHERE token=? AND status='Pending'", token);
    if (!invite) return res.status(400).json({ error: 'Invalid or expired invite token' });
    if (invite.email.toLowerCase() !== norm) return res.status(400).json({ error: 'Email does not match invite' });
    role = invite.role || role;
    dept = invite.dept || dept;
    run("UPDATE invites SET status='Accepted' WHERE token=?", token);
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = run('INSERT INTO users (name,email,password_hash,role,dept,perm_role) VALUES (?,?,?,?,?,?)',
    name.trim(), norm, hash, role, dept, permRole);
  req.session.userId = Number(info.lastInsertRowid);
  res.json({ id:Number(info.lastInsertRowid), name:name.trim(), email:norm, role, dept, permRole });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const u = getUser(req.session.userId);
  if (!u) return res.status(401).json({ error: 'User not found' });
  res.json({ id:u.id, name:u.name, email:u.email, role:u.role, dept:u.dept, color:u.color, permRole:u.perm_role });
});

// ── Team ──────────────────────────────────────────────────────────────────────
app.get('/api/team', requireAuth, (req, res) => {
  const members = all('SELECT id,name,email,role,dept,color,perm_role FROM users ORDER BY id');
  const counts = all(`SELECT user_name,COUNT(*) as cnt FROM ticket_assignees ta
    JOIN tickets t ON t.id=ta.ticket_id AND t.status!='Closed' GROUP BY user_name`);
  const cm = {};
  counts.forEach(r => { cm[r.user_name] = r.cnt; });
  res.json(members.map(m => ({
    id:m.id, name:m.name, email:m.email, role:m.role, dept:m.dept, color:m.color,
    permRole:m.perm_role, workload:Math.min(100,(cm[m.name]||0)*10), tickets:cm[m.name]||0
  })));
});

app.put('/api/team/:id/role', requireAuth, (req, res) => {
  run('UPDATE users SET perm_role=? WHERE id=?', req.body.permRole, req.params.id);
  res.json({ ok:true });
});

app.delete('/api/team/:id', requireAuth, (req, res) => {
  const me = get('SELECT perm_role FROM users WHERE id=?', req.session.userId);
  if (!['Owner','Admin'].includes(me?.perm_role)) return res.status(403).json({ error:'Insufficient permissions' });
  const target = get('SELECT perm_role FROM users WHERE id=?', req.params.id);
  if (target?.perm_role === 'Owner') return res.status(403).json({ error:'Cannot remove owner' });
  run('DELETE FROM users WHERE id=?', req.params.id);
  res.json({ ok:true });
});

// ── Invites ───────────────────────────────────────────────────────────────────
app.get('/api/invites', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM invites ORDER BY created_at DESC'));
});

app.post('/api/invites', requireAuth, async (req, res) => {
  const { email, name, role, dept } = req.body;
  if (!email || !name) return res.status(400).json({ error:'Email and name required' });
  const norm = email.toLowerCase().trim();
  if (get('SELECT id FROM users WHERE email=?', norm)) return res.status(409).json({ error:'User already exists' });
  if (get("SELECT id FROM invites WHERE email=? AND status='Pending'", norm))
    return res.status(409).json({ error:'Invite already pending for this email' });
  const token = randomUUID();
  const expires = new Date(Date.now() + 7*24*60*60*1000).toISOString();
  const info = run(`INSERT INTO invites (email,name,role,dept,token,status,invited_by,expires_at)
    VALUES (?,?,?,?,?,'Pending',?,?)`, norm, name.trim(), role||'', dept||'', token, req.session.userId, expires);
  const invite = get('SELECT * FROM invites WHERE id=?', Number(info.lastInsertRowid));
  const inviter = get('SELECT name FROM users WHERE id=?', req.session.userId);
  try {
    await sendInviteEmail({ toEmail: norm, toName: name.trim(), inviterName: inviter?.name || 'Your team', role, dept, token });
  } catch(e) {
    console.error('[email] Failed to send invite:', e.message);
  }
  res.json({ ...invite, inviteUrl:`${process.env.APP_URL || `http://localhost:${PORT}`}/invite.html?token=${token}` });
});

app.delete('/api/invites/:id', requireAuth, (req, res) => {
  run("UPDATE invites SET status='Cancelled' WHERE id=?", req.params.id);
  res.json({ ok:true });
});

app.get('/api/invites/token/:token', (req, res) => {
  const inv = get('SELECT * FROM invites WHERE token=?', req.params.token);
  if (!inv) return res.status(404).json({ error:'Invite not found' });
  if (inv.status !== 'Pending') return res.status(410).json({ error:'Invite already used or cancelled' });
  res.json({ name:inv.name, email:inv.email, role:inv.role, dept:inv.dept });
});

// ── Tickets ───────────────────────────────────────────────────────────────────
function buildTicket(row) {
  if (!row) return null;
  const assignees = all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', row.id);
  return { ...row, tags:JSON.parse(row.tags_json||'[]'), assignees:assignees.map(a=>a.user_name), overdue:!!row.overdue, comments:row.comments_count };
}

app.get('/api/tickets', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM tickets ORDER BY rowid DESC').map(buildTicket));
});

app.get('/api/tickets/:id', requireAuth, (req, res) => {
  const row = get('SELECT * FROM tickets WHERE id=?', req.params.id);
  if (!row) return res.status(404).json({ error:'Not found' });
  res.json(buildTicket(row));
});

app.post('/api/tickets', requireAuth, (req, res) => {
  const { id, title, req:reqName, assignee, assignees, reporter, priority, status, dept, due, created, overdue, tags } = req.body;
  if (!id || !title) return res.status(400).json({ error:'id and title required' });
  run(`INSERT OR IGNORE INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    id, title, reqName||'', assignee||'', reporter||'', priority||'Medium', status||'Open',
    dept||'Engineering', due||'', created||'', overdue?1:0, JSON.stringify(tags||[]), req.session.userId);
  run('INSERT OR IGNORE INTO ticket_details (ticket_id) VALUES (?)', id);
  for (const a of (assignees||[])) run('INSERT OR IGNORE INTO ticket_assignees (ticket_id,user_name) VALUES (?,?)', id, a);
  res.status(201).json(buildTicket(get('SELECT * FROM tickets WHERE id=?', id)));
});

app.put('/api/tickets/:id', requireAuth, (req, res) => {
  const { title, req:reqName, assignee, assignees, reporter, priority, status, dept, due, overdue, tags } = req.body;
  if (!get('SELECT id FROM tickets WHERE id=?', req.params.id)) return res.status(404).json({ error:'Not found' });
  const u=[]; const v=[];
  if (title!==undefined)    { u.push('title=?');      v.push(title); }
  if (reqName!==undefined)  { u.push('req=?');        v.push(reqName); }
  if (assignee!==undefined) { u.push('assignee=?');   v.push(assignee); }
  if (reporter!==undefined) { u.push('reporter=?');   v.push(reporter); }
  if (priority!==undefined) { u.push('priority=?');   v.push(priority); }
  if (status!==undefined)   { u.push('status=?');     v.push(status); }
  if (dept!==undefined)     { u.push('dept=?');       v.push(dept); }
  if (due!==undefined)      { u.push('due=?');        v.push(due); }
  if (overdue!==undefined)  { u.push('overdue=?');    v.push(overdue?1:0); }
  if (tags!==undefined)     { u.push('tags_json=?');  v.push(JSON.stringify(tags)); }
  if (u.length) { v.push(req.params.id); run(`UPDATE tickets SET ${u.join(',')} WHERE id=?`, ...v); }
  if (assignees!==undefined) {
    run('DELETE FROM ticket_assignees WHERE ticket_id=?', req.params.id);
    for (const a of assignees) run('INSERT OR IGNORE INTO ticket_assignees (ticket_id,user_name) VALUES (?,?)', req.params.id, a);
  }
  res.json(buildTicket(get('SELECT * FROM tickets WHERE id=?', req.params.id)));
});

app.delete('/api/tickets/:id', requireAuth, (req, res) => {
  run('DELETE FROM tickets WHERE id=?', req.params.id);
  res.json({ ok:true });
});

app.get('/api/tickets/:id/details', requireAuth, (req, res) => {
  const row = get('SELECT * FROM ticket_details WHERE ticket_id=?', req.params.id);
  if (!row) return res.json({ description:'', checklist:[] });
  res.json({ description:row.description, checklist:JSON.parse(row.checklist_json||'[]') });
});

app.put('/api/tickets/:id/details', requireAuth, (req, res) => {
  const { description, checklist } = req.body;
  run(`INSERT INTO ticket_details (ticket_id,description,checklist_json) VALUES (?,?,?)
       ON CONFLICT(ticket_id) DO UPDATE SET description=excluded.description,checklist_json=excluded.checklist_json`,
    req.params.id, description||'', JSON.stringify(checklist||[]));
  res.json({ ok:true });
});

app.get('/api/tickets/:id/comments', requireAuth, (req, res) => {
  const rows = all('SELECT * FROM ticket_comments WHERE ticket_id=? ORDER BY created_at ASC', req.params.id);
  res.json(rows.map(r => ({ id:r.id, author:r.author, init:r.author_init, bg:r.author_bg, col:r.author_col, text:r.text, time:timeAgo(r.created_at) })));
});

app.post('/api/tickets/:id/comments', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error:'Text required' });
  const u = getUser(req.session.userId);
  const init = u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const palette = ['#ede9fe|#5b21b6','#dde4ff|#3730a3','#dcfce7|#166534','#fef9c3|#854d0e'];
  const [bg,col] = (palette[u.id % palette.length]||palette[0]).split('|');
  const info = run(`INSERT INTO ticket_comments (ticket_id,author,author_init,author_bg,author_col,text) VALUES (?,?,?,?,?,?)`,
    req.params.id, u.name, init, bg, col, text.trim());
  run('UPDATE tickets SET comments_count=comments_count+1 WHERE id=?', req.params.id);
  res.status(201).json({ id:Number(info.lastInsertRowid), author:u.name, init, bg, col, text:text.trim(), time:'Just now' });
});

app.get('/api/tickets/:id/timeline', requireAuth, (req, res) => {
  const rows = all('SELECT * FROM ticket_timelines WHERE ticket_id=? ORDER BY created_at DESC', req.params.id);
  if (!rows.length) {
    const t = get('SELECT * FROM tickets WHERE id=?', req.params.id);
    if (t) return res.json([{ dot:'var(--green)', text:'Ticket created', sub:t.created }]);
  }
  res.json(rows.map(r=>({ id:r.id, dot:r.dot, text:r.text, sub:r.sub })));
});

app.post('/api/tickets/:id/timeline', requireAuth, (req, res) => {
  const { dot, text, sub } = req.body;
  run('INSERT INTO ticket_timelines (ticket_id,dot,text,sub) VALUES (?,?,?,?)', req.params.id, dot||'var(--accent)', text, sub||'Just now');
  res.json({ ok:true });
});

// ── Work tasks ────────────────────────────────────────────────────────────────
app.get('/api/worktasks', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM work_tasks ORDER BY created_at DESC'));
});

app.post('/api/worktasks', requireAuth, (req, res) => {
  const { ticketId, worker, estimate, notes } = req.body;
  const info = run('INSERT INTO work_tasks (ticket_id,worker,estimate,notes,user_id) VALUES (?,?,?,?,?)',
    ticketId||'', worker||'', estimate||'', notes||'', req.session.userId);
  res.status(201).json(get('SELECT * FROM work_tasks WHERE id=?', Number(info.lastInsertRowid)));
});

app.put('/api/worktasks/:id', requireAuth, (req, res) => {
  const { status, timer_running, timer_elapsed } = req.body;
  const u=[]; const v=[];
  if (status!==undefined)        { u.push('status=?');        v.push(status); }
  if (timer_running!==undefined) { u.push('timer_running=?'); v.push(timer_running?1:0); }
  if (timer_elapsed!==undefined) { u.push('timer_elapsed=?'); v.push(timer_elapsed); }
  if (u.length) { v.push(req.params.id); run(`UPDATE work_tasks SET ${u.join(',')} WHERE id=?`, ...v); }
  res.json({ ok:true });
});

// ── Calendar events ───────────────────────────────────────────────────────────
app.get('/api/events', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM cal_events ORDER BY date_key ASC').map(r => ({
    id:r.id, dateKey:r.date_key, type:r.type, label:r.label, title:r.title,
    desc:r.description, allDay:!!r.all_day, startTime:r.start_time, endTime:r.end_time,
    linkedTicketId:r.linked_ticket_id, attendees:JSON.parse(r.attendees_json||'[]'),
    location:r.location, assignee:r.assignee, completed:!!r.completed, syncsTicket:!!r.syncs_ticket
  })));
});

app.post('/api/events', requireAuth, (req, res) => {
  const { dateKey, type, label, title, desc, allDay, startTime, endTime, linkedTicketId, attendees, location, assignee, completed, syncsTicket } = req.body;
  const info = run(`INSERT INTO cal_events (date_key,type,label,title,description,all_day,start_time,end_time,linked_ticket_id,attendees_json,location,assignee,completed,syncs_ticket,user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    dateKey, type||'meeting', label||title||'', title||'', desc||'', allDay?1:0,
    startTime||'', endTime||'', linkedTicketId||'', JSON.stringify(attendees||[]),
    location||'', assignee||'', completed?1:0, syncsTicket?1:0, req.session.userId);
  res.status(201).json({ id:Number(info.lastInsertRowid) });
});

app.put('/api/events/:id', requireAuth, (req, res) => {
  const { dateKey, type, label, title, desc, allDay, startTime, endTime, linkedTicketId, attendees, location, assignee, completed } = req.body;
  run(`UPDATE cal_events SET date_key=?,type=?,label=?,title=?,description=?,all_day=?,start_time=?,end_time=?,linked_ticket_id=?,attendees_json=?,location=?,assignee=?,completed=? WHERE id=?`,
    dateKey, type, label||title||'', title||'', desc||'', allDay?1:0,
    startTime||'', endTime||'', linkedTicketId||'', JSON.stringify(attendees||[]),
    location||'', assignee||'', completed?1:0, req.params.id);
  res.json({ ok:true });
});

app.delete('/api/events/:id', requireAuth, (req, res) => {
  run('DELETE FROM cal_events WHERE id=?', req.params.id);
  res.json({ ok:true });
});

// ── Plans ─────────────────────────────────────────────────────────────────────
function buildPlan(row) {
  if (!row) return null;
  const files = all('SELECT * FROM plan_files WHERE plan_id=?', row.id);
  return { ...row, files:files.map(f=>({id:f.id,name:f.filename,size:f.size})),
    promotedTicketId:row.promoted_ticket_id, reminderAt:row.reminder_at,
    reminderTriggered:!!row.reminder_triggered, createdAt:row.created_at, updatedAt:row.updated_at };
}

app.get('/api/plans', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM plans ORDER BY created_at DESC').map(buildPlan));
});

app.post('/api/plans', requireAuth, (req, res) => {
  const { id, title, notes, status, reminderAt } = req.body;
  if (!id || !title) return res.status(400).json({ error:'id and title required' });
  const now = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  run('INSERT INTO plans (id,title,notes,status,reminder_at,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, title, notes||'', status||'draft', reminderAt||'', req.session.userId, now, now);
  res.status(201).json(buildPlan(get('SELECT * FROM plans WHERE id=?', id)));
});

app.put('/api/plans/:id', requireAuth, (req, res) => {
  const { title, notes, status, reminderAt, reminderTriggered, promotedTicketId } = req.body;
  const u=[]; const v=[];
  if (title!==undefined)             { u.push('title=?');              v.push(title); }
  if (notes!==undefined)             { u.push('notes=?');              v.push(notes); }
  if (status!==undefined)            { u.push('status=?');             v.push(status); }
  if (reminderAt!==undefined)        { u.push('reminder_at=?');        v.push(reminderAt); }
  if (reminderTriggered!==undefined) { u.push('reminder_triggered=?'); v.push(reminderTriggered?1:0); }
  if (promotedTicketId!==undefined)  { u.push('promoted_ticket_id=?'); v.push(promotedTicketId); }
  u.push('updated_at=?');
  v.push(new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}));
  v.push(req.params.id);
  run(`UPDATE plans SET ${u.join(',')} WHERE id=?`, ...v);
  res.json(buildPlan(get('SELECT * FROM plans WHERE id=?', req.params.id)));
});

app.delete('/api/plans/:id', requireAuth, (req, res) => {
  run('DELETE FROM plans WHERE id=?', req.params.id);
  res.json({ ok:true });
});

app.get('/api/plans/:id/comments', requireAuth, (req, res) => {
  const rows = all('SELECT * FROM plan_comments WHERE plan_id=? ORDER BY created_at ASC', req.params.id);
  res.json(rows.map(r=>({ id:r.id, author:r.author, bg:r.author_bg, col:r.author_col, text:r.text, time:timeAgo(r.created_at) })));
});

app.post('/api/plans/:id/comments', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error:'Text required' });
  const u = getUser(req.session.userId);
  const palette = ['#ede9fe|#5b21b6','#dde4ff|#3730a3','#dcfce7|#166634'];
  const [bg,col] = (palette[u.id % palette.length]||palette[0]).split('|');
  const info = run('INSERT INTO plan_comments (plan_id,author,author_bg,author_col,text) VALUES (?,?,?,?,?)',
    req.params.id, u.name, bg, col, text.trim());
  res.status(201).json({ id:Number(info.lastInsertRowid), author:u.name, bg, col, text:text.trim(), time:'Just now' });
});

// ── Profile ───────────────────────────────────────────────────────────────────
app.put('/api/profile', requireAuth, (req, res) => {
  const { name, role, dept } = req.body;
  if (name) run('UPDATE users SET name=? WHERE id=?', name.trim(), req.session.userId);
  if (role) run('UPDATE users SET role=? WHERE id=?', role.trim(), req.session.userId);
  if (dept) run('UPDATE users SET dept=? WHERE id=?', dept.trim(), req.session.userId);
  const u = getUser(req.session.userId);
  res.json({ id:u.id, name:u.name, email:u.email, role:u.role, dept:u.dept, color:u.color });
});

app.put('/api/profile/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error:'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error:'Password must be at least 6 characters' });
  const user = get('SELECT password_hash FROM users WHERE id=?', req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(401).json({ error:'Current password is incorrect' });
  run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(newPassword, 10), req.session.userId);
  res.json({ ok:true });
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', req.session.userId));
});

app.put('/api/notifications/read-all', requireAuth, (req, res) => {
  run('UPDATE notifications SET unread=0 WHERE user_id=?', req.session.userId);
  res.json({ ok:true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso) {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff/60000);
    if (m < 1)  return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m/60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h/24);
    return d === 1 ? 'Yesterday' : `${d}d ago`;
  } catch { return 'Just now'; }
}

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error:'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅  WorkNest running at http://localhost:${PORT}`);
  console.log(`   Default login: admin@worknest.com / admin123\n`);
});
