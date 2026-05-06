require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const multer = require('multer');
const { pool, init: initDb, get, all, run, safeAlter } = require('./db');
const { sendInviteEmail } = require('./email');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, randomUUID() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/|audio\/|application\/pdf|text\/)/.test(file.mimetype)
      || ['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype);
    cb(null, ok);
  }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session store — uses PostgreSQL so sessions persist across deploys
const PgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET || 'syruvia-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Serve uploaded files (avatars, attachments, voice notes) from UPLOADS_DIR.
// In production UPLOADS_DIR is /data/uploads (outside public/), so this route
// is required for /uploads/<filename> to resolve. Locally it harmlessly mirrors
// public/uploads.
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); }
}));

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function getUser(userId) {
  return get('SELECT id,name,email,role,dept,color,perm_role,avatar_url,tz FROM users WHERE id=?', userId);
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const u = await get('SELECT perm_role FROM users WHERE id=?', req.session.userId);
    if (!u || !['Owner','Admin'].includes(u.perm_role)) return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch(e) { next(e); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await get('SELECT * FROM users WHERE email=?', email.toLowerCase().trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    res.json({ id:user.id, name:user.name, email:user.email, role:user.role, dept:user.dept, color:user.color, permRole:user.perm_role, avatarUrl:user.avatar_url || '', tz:user.tz || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, token } = req.body;
    if (!token) return res.status(403).json({ error: 'Registration requires a valid invite link.' });
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const norm = email.toLowerCase().trim();
    const invite = await get("SELECT * FROM invites WHERE token=? AND status='Pending'", token);
    if (!invite) return res.status(400).json({ error: 'This invite link is invalid or has already been used.' });
    if (invite.email.toLowerCase() !== norm) return res.status(400).json({ error: 'Email does not match this invite.' });
    if (await get('SELECT id FROM users WHERE email=?', norm)) return res.status(409).json({ error: 'This email is already registered.' });
    const role = invite.role || 'Team Member';
    const dept = invite.dept || 'General';
    await run("UPDATE invites SET status='Accepted' WHERE token=?", token);
    const hash = bcrypt.hashSync(password, 10);
    const info = await run('INSERT INTO users (name,email,password_hash,role,dept,perm_role) VALUES (?,?,?,?,?,?) RETURNING id',
      name.trim(), norm, hash, role, dept, 'Member');
    req.session.userId = Number(info.lastInsertRowid);
    res.json({ id:Number(info.lastInsertRowid), name:name.trim(), email:norm, role, dept, permRole:'Member' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const u = await getUser(req.session.userId);
    if (!u) return res.status(401).json({ error: 'User not found' });
    res.json({ id:u.id, name:u.name, email:u.email, role:u.role, dept:u.dept, color:u.color, permRole:u.perm_role, avatarUrl:u.avatar_url || '', tz:u.tz || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Team ──────────────────────────────────────────────────────────────────────
app.get('/api/team', requireAuth, async (req, res) => {
  try {
    const members = await all('SELECT id,name,email,role,dept,color,perm_role,avatar_url FROM users ORDER BY id');
    const counts = await all(`SELECT user_name,COUNT(*) as cnt FROM ticket_assignees ta
      JOIN tickets t ON t.id=ta.ticket_id AND t.status!='Closed' GROUP BY user_name`);
    const cm = {};
    counts.forEach(r => { cm[r.user_name] = parseInt(r.cnt, 10); });
    res.json(members.map(m => ({
      id:m.id, name:m.name, email:m.email, role:m.role, dept:m.dept, color:m.color,
      permRole:m.perm_role, avatarUrl:m.avatar_url || '',
      workload:Math.min(100,(cm[m.name]||0)*10), tickets:cm[m.name]||0
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/:id/role', requireAuth, async (req, res) => {
  try {
    await run('UPDATE users SET perm_role=? WHERE id=?', req.body.permRole, req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/:id', requireAuth, async (req, res) => {
  try {
    const me = await get('SELECT perm_role FROM users WHERE id=?', req.session.userId);
    if (!['Owner','Admin'].includes(me?.perm_role)) return res.status(403).json({ error:'Insufficient permissions' });
    const target = await get('SELECT perm_role FROM users WHERE id=?', req.params.id);
    if (target?.perm_role === 'Owner') return res.status(403).json({ error:'Cannot remove owner' });
    await run('DELETE FROM users WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Invites ───────────────────────────────────────────────────────────────────
app.get('/api/invites', requireAuth, async (req, res) => {
  try {
    res.json(await all('SELECT * FROM invites ORDER BY created_at DESC'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invites', requireAuth, async (req, res) => {
  try {
    const { email, name, role, dept } = req.body;
    if (!email || !name) return res.status(400).json({ error:'Email and name required' });
    const norm = email.toLowerCase().trim();
    if (await get('SELECT id FROM users WHERE email=?', norm)) return res.status(409).json({ error:'User already exists' });
    if (await get("SELECT id FROM invites WHERE email=? AND status='Pending'", norm))
      return res.status(409).json({ error:'Invite already pending for this email' });
    const token = randomUUID();
    const expires = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    const info = await run(`INSERT INTO invites (email,name,role,dept,token,status,invited_by,expires_at)
      VALUES (?,?,?,?,?,'Pending',?,?) RETURNING id`, norm, name.trim(), role||'', dept||'', token, req.session.userId, expires);
    const invite = await get('SELECT * FROM invites WHERE id=?', Number(info.lastInsertRowid));
    const inviter = await get('SELECT name FROM users WHERE id=?', req.session.userId);
    try {
      await sendInviteEmail({ toEmail: norm, toName: name.trim(), inviterName: inviter?.name || 'Your team', role, dept, token });
    } catch(e) {
      console.error('[email] Failed to send invite:', e.message);
    }
    res.json({ ...invite, inviteUrl:`${process.env.APP_URL || `http://localhost:${PORT}`}/invite.html?token=${token}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/invites/:id', requireAuth, async (req, res) => {
  try {
    await run("UPDATE invites SET status='Cancelled' WHERE id=?", req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invites/token/:token', async (req, res) => {
  try {
    const inv = await get('SELECT * FROM invites WHERE token=?', req.params.token);
    if (!inv) return res.status(404).json({ error:'Invite not found' });
    if (inv.status !== 'Pending') return res.status(410).json({ error:'Invite already used or cancelled' });
    res.json({ name:inv.name, email:inv.email, role:inv.role, dept:inv.dept });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Tickets ───────────────────────────────────────────────────────────────────
async function buildTicket(row) {
  if (!row) return null;
  const assignees = await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', row.id);
  return { ...row, tags:JSON.parse(row.tags_json||'[]'), assignees:assignees.map(a=>a.user_name), overdue:!!row.overdue, comments:row.comments_count };
}

app.get('/api/tickets', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    const isAdmin = u && ['Owner','Admin'].includes(u.perm_role);
    let rows;
    if (isAdmin) {
      rows = await all('SELECT * FROM tickets ORDER BY id DESC');
    } else {
      // Members see only tickets they are assigned to (primary or via ticket_assignees)
      rows = await all(
        `SELECT t.* FROM tickets t
           WHERE t.assignee = ?
              OR EXISTS (SELECT 1 FROM ticket_assignees ta WHERE ta.ticket_id = t.id AND ta.user_name = ?)
           ORDER BY t.id DESC`,
        u.name, u.name
      );
    }
    res.json(await Promise.all(rows.map(buildTicket)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    const row = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error:'Not found' });
    res.json(await buildTicket(row));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets', requireAuth, async (req, res) => {
  try {
    const { id, title, req:reqName, assignee, assignees, reporter, priority, status, dept, due, created, overdue, tags, checklist } = req.body;
    if (!id || !title) return res.status(400).json({ error:'id and title required' });
    if (await get('SELECT id FROM tickets WHERE id=?', id)) {
      return res.status(409).json({ error: `Ticket ${id} already exists`, code: 'duplicate_id' });
    }
    await run(`INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      id, title, reqName||'', assignee||'', reporter||'', priority||'Medium', status||'Open',
      dept||'Engineering', due||'', created||'', overdue?1:0, JSON.stringify(tags||[]), req.session.userId);
    await run('INSERT INTO ticket_details (ticket_id) VALUES (?) ON CONFLICT DO NOTHING', id);
    for (const a of (assignees||[])) await run('INSERT INTO ticket_assignees (ticket_id,user_name) VALUES (?,?) ON CONFLICT DO NOTHING', id, a);
    // Persist any checklist items from the create modal as real subtasks (default-assigned to the ticket assignee)
    if (Array.isArray(checklist) && checklist.length) {
      let pos = 1;
      for (const item of checklist) {
        const text = typeof item === 'string' ? item : (item?.text || '');
        const trimmed = String(text).trim();
        if (!trimmed) continue;
        await run(
          `INSERT INTO ticket_subtasks (ticket_id, position, text, done, assignee) VALUES (?,?,?,?,?)`,
          id, pos++, trimmed, item?.done ? 1 : 0, assignee || ''
        );
      }
    }
    const creator = await getUser(req.session.userId);
    for (const a of (assignees||[])) {
      const target = await get('SELECT id FROM users WHERE name=?', a);
      if (target && target.id !== req.session.userId) {
        await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
          target.id, 'assigned', '👤', `${creator?.name || 'Someone'} assigned you to "${title}"`, id);
      }
    }
    res.status(201).json(await buildTicket(await get('SELECT * FROM tickets WHERE id=?', id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    const { title, req:reqName, assignee, assignees, reporter, priority, status, dept, due, overdue, tags } = req.body;
    if (!await get('SELECT id FROM tickets WHERE id=?', req.params.id)) return res.status(404).json({ error:'Not found' });
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
    if (u.length) { v.push(req.params.id); await run(`UPDATE tickets SET ${u.join(',')} WHERE id=?`, ...v); }
    if (assignees!==undefined) {
      const oldAssignees = (await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', req.params.id)).map(a => a.user_name);
      await run('DELETE FROM ticket_assignees WHERE ticket_id=?', req.params.id);
      for (const a of assignees) await run('INSERT INTO ticket_assignees (ticket_id,user_name) VALUES (?,?) ON CONFLICT DO NOTHING', req.params.id, a);
      const newAssignees = assignees.filter(a => !oldAssignees.includes(a));
      if (newAssignees.length) {
        const assigner = await getUser(req.session.userId);
        const tkt = await get('SELECT title FROM tickets WHERE id=?', req.params.id);
        for (const name of newAssignees) {
          const target = await get('SELECT id FROM users WHERE name=?', name);
          if (target && target.id !== req.session.userId) {
            await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
              target.id, 'assigned', '👤', `${assigner?.name || 'Someone'} assigned you to "${tkt?.title || req.params.id}"`, req.params.id);
          }
        }
      }
    }
    res.json(await buildTicket(await get('SELECT * FROM tickets WHERE id=?', req.params.id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM tickets WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/details', requireAuth, async (req, res) => {
  try {
    const row = await get('SELECT * FROM ticket_details WHERE ticket_id=?', req.params.id);
    if (!row) return res.json({ description:'', checklist:[] });
    res.json({ description:row.description, checklist:JSON.parse(row.checklist_json||'[]') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tickets/:id/details', requireAuth, async (req, res) => {
  try {
    const { description, checklist } = req.body;
    await run(`INSERT INTO ticket_details (ticket_id,description,checklist_json) VALUES (?,?,?)
         ON CONFLICT(ticket_id) DO UPDATE SET description=EXCLUDED.description,checklist_json=EXCLUDED.checklist_json`,
      req.params.id, description||'', JSON.stringify(checklist||[]));
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/comments', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM ticket_comments WHERE ticket_id=? ORDER BY created_at ASC', req.params.id);
    res.json(rows.map(r => ({ id:r.id, author:r.author, init:r.author_init, bg:r.author_bg, col:r.author_col, text:r.text, time:timeAgo(r.created_at) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/comments', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error:'Text required' });
    const u = await getUser(req.session.userId);
    const init = u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const palette = ['#ede9fe|#5b21b6','#dde4ff|#3730a3','#dcfce7|#166534','#fef9c3|#854d0e'];
    const [bg,col] = (palette[u.id % palette.length]||palette[0]).split('|');
    const info = await run(`INSERT INTO ticket_comments (ticket_id,author,author_init,author_bg,author_col,text) VALUES (?,?,?,?,?,?) RETURNING id`,
      req.params.id, u.name, init, bg, col, text.trim());
    await run('UPDATE tickets SET comments_count=comments_count+1 WHERE id=?', req.params.id);
    const tkt = await get('SELECT title FROM tickets WHERE id=?', req.params.id);
    const mentions = (text.match(/@([A-Za-z]+(?: [A-Za-z]+)*)/g) || []).map(m => m.slice(1));
    for (const name of mentions) {
      const mentioned = await get('SELECT id FROM users WHERE name=?', name);
      if (mentioned && mentioned.id !== req.session.userId) {
        await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
          mentioned.id, 'mention', '💬', `${u.name} mentioned you in "${tkt?.title || req.params.id}"`, req.params.id);
      }
    }
    res.status(201).json({ id:Number(info.lastInsertRowid), author:u.name, init, bg, col, text:text.trim(), time: formatUSDateTime(new Date().toISOString()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets/:id/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const comment = await get('SELECT id FROM ticket_comments WHERE id=? AND ticket_id=?', req.params.commentId, req.params.id);
    if (!comment) return res.status(404).json({ error:'Comment not found' });
    await run('DELETE FROM ticket_comments WHERE id=?', req.params.commentId);
    await run('UPDATE tickets SET comments_count=GREATEST(0,comments_count-1) WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/timeline', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM ticket_timelines WHERE ticket_id=? ORDER BY created_at DESC', req.params.id);
    if (!rows.length) {
      const t = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
      if (t) return res.json([{ dot:'var(--green)', text:'Ticket created', sub: formatUSDateTime(t.created_at) || t.created }]);
    }
    res.json(rows.map(r=>({ id:r.id, dot:r.dot, text:r.text, sub: formatUSDateTime(r.created_at) || r.sub })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/timeline', requireAuth, async (req, res) => {
  try {
    const { dot, text, sub } = req.body;
    await run('INSERT INTO ticket_timelines (ticket_id,dot,text,sub) VALUES (?,?,?,?)', req.params.id, dot||'var(--accent)', text, sub||'Just now');
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Announcements ────────────────────────────────────────────────────────────
// Active, unacknowledged announcements for the current user.
app.get('/api/announcements/active', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT a.* FROM announcements a
        WHERE a.active = 1
          AND NOT EXISTS (
            SELECT 1 FROM announcement_seen s
             WHERE s.announcement_id = a.id AND s.user_id = ?
          )
        ORDER BY a.created_at DESC, a.id DESC`,
      req.session.userId
    );
    res.json(rows.map(r => ({
      id: r.id, title: r.title || '', body: r.body || '',
      requireAck: !!r.require_ack, createdAt: r.created_at
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mark an announcement as seen / acknowledged for the current user.
app.post('/api/announcements/:id/ack', requireAuth, async (req, res) => {
  try {
    await run(
      `INSERT INTO announcement_seen (announcement_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      Number(req.params.id), req.session.userId
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin CRUD
app.get('/api/announcements', requireAdmin, async (req, res) => {
  try {
    const rows = await all(`
      SELECT a.*, (SELECT COUNT(*) FROM announcement_seen s WHERE s.announcement_id = a.id) AS ack_count
      FROM announcements a ORDER BY a.created_at DESC, a.id DESC`);
    res.json(rows.map(r => ({
      id: r.id, title: r.title || '', body: r.body || '',
      requireAck: !!r.require_ack, active: !!r.active,
      createdAt: r.created_at, ackCount: parseInt(r.ack_count || 0, 10)
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/announcements', requireAdmin, async (req, res) => {
  try {
    const { title, body, requireAck } = req.body || {};
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t && !b) return res.status(400).json({ error: 'Title or body required' });
    const info = await run(
      `INSERT INTO announcements (title, body, require_ack, active, created_by) VALUES (?,?,?,1,?) RETURNING id`,
      t, b, requireAck ? 1 : 0, req.session.userId
    );
    const row = await get('SELECT * FROM announcements WHERE id=?', Number(info.lastInsertRowid));
    res.status(201).json({
      id: row.id, title: row.title || '', body: row.body || '',
      requireAck: !!row.require_ack, active: !!row.active, createdAt: row.created_at, ackCount: 0
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const { title, body, requireAck, active, resetSeen } = req.body || {};
    const u = []; const v = [];
    if (title !== undefined)      { u.push('title=?');       v.push(String(title || '').trim()); }
    if (body !== undefined)       { u.push('body=?');        v.push(String(body || '').trim()); }
    if (requireAck !== undefined) { u.push('require_ack=?'); v.push(requireAck ? 1 : 0); }
    if (active !== undefined)     { u.push('active=?');      v.push(active ? 1 : 0); }
    if (u.length) { v.push(Number(req.params.id)); await run(`UPDATE announcements SET ${u.join(',')} WHERE id=?`, ...v); }
    if (resetSeen) await run('DELETE FROM announcement_seen WHERE announcement_id=?', Number(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/announcements/:id', requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM announcement_seen WHERE announcement_id=?', Number(req.params.id));
    await run('DELETE FROM announcements WHERE id=?', Number(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ticket subtasks ──────────────────────────────────────────────────────────
function buildSubtask(r) {
  return {
    id: r.id, ticketId: r.ticket_id, position: r.position,
    text: r.text || '', description: r.description || '',
    done: !!r.done, assignee: r.assignee || '',
    due: r.due || '', priority: r.priority || '',
    createdAt: r.created_at,
  };
}

app.get('/api/tickets/:id/subtasks', requireAuth, async (req, res) => {
  try {
    let rows = await all('SELECT * FROM ticket_subtasks WHERE ticket_id=? ORDER BY position ASC, id ASC', req.params.id);
    // One-time migration: if no subtask rows yet, but legacy checklist_json on ticket_details has items, lift them in.
    if (!rows.length) {
      const det = await get('SELECT checklist_json FROM ticket_details WHERE ticket_id=?', req.params.id);
      let legacy = [];
      try { legacy = JSON.parse(det?.checklist_json || '[]'); } catch {}
      if (Array.isArray(legacy) && legacy.length) {
        const tk = await get('SELECT assignee FROM tickets WHERE id=?', req.params.id);
        let pos = 1;
        for (const item of legacy) {
          const text = typeof item === 'string' ? item : (item?.text || '');
          const trimmed = String(text).trim();
          if (!trimmed) continue;
          await run(
            'INSERT INTO ticket_subtasks (ticket_id, position, text, done, assignee) VALUES (?,?,?,?,?)',
            req.params.id, pos++, trimmed, item?.done ? 1 : 0, tk?.assignee || ''
          );
        }
        // Clear the legacy field so this only runs once
        await run('UPDATE ticket_details SET checklist_json=? WHERE ticket_id=?', '[]', req.params.id);
        rows = await all('SELECT * FROM ticket_subtasks WHERE ticket_id=? ORDER BY position ASC, id ASC', req.params.id);
      }
    }
    res.json(rows.map(buildSubtask));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/subtasks', requireAuth, async (req, res) => {
  try {
    if (!await get('SELECT id FROM tickets WHERE id=?', req.params.id))
      return res.status(404).json({ error: 'Ticket not found' });
    const { text, assignee, due, priority, description } = req.body || {};
    const posRow = await get('SELECT COALESCE(MAX(position),0) AS p FROM ticket_subtasks WHERE ticket_id=?', req.params.id);
    const nextPos = Number(posRow?.p || 0) + 1;
    const info = await run(
      `INSERT INTO ticket_subtasks (ticket_id, position, text, description, done, assignee, due, priority)
       VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
      req.params.id, nextPos, String(text || '').trim() || 'New subtask',
      String(description || ''), 0, assignee || '', due || '', priority || ''
    );
    const row = await get('SELECT * FROM ticket_subtasks WHERE id=?', Number(info.lastInsertRowid));
    res.status(201).json(buildSubtask(row));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/subtasks/:sid', requireAuth, async (req, res) => {
  try {
    const sid = Number(req.params.sid);
    if (!await get('SELECT id FROM ticket_subtasks WHERE id=?', sid))
      return res.status(404).json({ error: 'Subtask not found' });
    const { text, description, done, assignee, due, priority, position } = req.body || {};
    const u = []; const v = [];
    if (text !== undefined)        { u.push('text=?');        v.push(String(text || '').trim()); }
    if (description !== undefined) { u.push('description=?'); v.push(String(description || '')); }
    if (done !== undefined)        { u.push('done=?');        v.push(done ? 1 : 0); }
    if (assignee !== undefined)    { u.push('assignee=?');    v.push(assignee || ''); }
    if (due !== undefined)         { u.push('due=?');         v.push(due || ''); }
    if (priority !== undefined)    { u.push('priority=?');    v.push(priority || ''); }
    if (position !== undefined)    { u.push('position=?');    v.push(Number(position) || 0); }
    if (u.length) { v.push(sid); await run(`UPDATE ticket_subtasks SET ${u.join(',')} WHERE id=?`, ...v); }
    const row = await get('SELECT * FROM ticket_subtasks WHERE id=?', sid);
    res.json(buildSubtask(row));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/subtasks/:sid', requireAuth, async (req, res) => {
  try {
    const sid = Number(req.params.sid);
    // Delete attached files from disk before cascading
    const atts = await all('SELECT filename FROM attachments WHERE subtask_id=?', sid);
    for (const a of atts) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, a.filename)); } catch {}
    }
    await run('DELETE FROM attachments WHERE subtask_id=?', sid);
    await run('DELETE FROM ticket_subtasks WHERE id=?', sid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/subtasks/:sid/attachments', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM attachments WHERE subtask_id=? ORDER BY created_at ASC', Number(req.params.sid));
    res.json(rows.map(r => ({
      id: r.id, filename: r.filename, originalName: r.original_name,
      mimeType: r.mime_type, size: r.size, uploader: r.uploader,
      subtaskId: r.subtask_id, createdAt: r.created_at,
      url: `/uploads/${r.filename}`,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Flavor launch template + flavor creation ─────────────────────────────────
// Template: rows in flavor_tasks. Editable from settings.
app.get('/api/flavor-tasks', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM flavor_tasks ORDER BY position ASC, id ASC');
    res.json(rows.map(r => ({
      id: r.id, position: r.position, title: r.title_template,
      assignee: r.assignee || '', dept: r.dept || '', priority: r.priority || 'Medium',
      daysOffset: r.days_offset
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Replace the entire template list. Body: { tasks: [{ title, assignee, dept, priority, daysOffset }] }
app.put('/api/flavor-tasks', requireAuth, async (req, res) => {
  try {
    const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    await run('DELETE FROM flavor_tasks');
    let pos = 1;
    for (const t of tasks) {
      const title = String(t.title || '').trim();
      if (!title) continue;
      await run(
        'INSERT INTO flavor_tasks (position, title_template, assignee, dept, priority, days_offset) VALUES (?,?,?,?,?,?)',
        pos++, title, t.assignee || '', t.dept || 'General', t.priority || 'Medium',
        Number.isFinite(Number(t.daysOffset)) ? Number(t.daysOffset) : 7
      );
    }
    res.json({ ok: true, count: pos - 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create one ticket per template row for a new flavor.
// Body: { name: 'Mango Mint', launchDate: 'YYYY-MM-DD' }
app.post('/api/flavors', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const launchDate = String(req.body?.launchDate || '').trim();
    if (!name) return res.status(400).json({ error: 'Flavor name required' });
    if (!launchDate || !/^\d{4}-\d{2}-\d{2}$/.test(launchDate))
      return res.status(400).json({ error: 'launchDate must be YYYY-MM-DD' });

    const tmpl = await all('SELECT * FROM flavor_tasks ORDER BY position ASC, id ASC');
    if (!tmpl.length) return res.status(409).json({ error: 'No template tasks. Add some in Settings → Flavor Tasks first.' });

    const u = await getUser(req.session.userId);
    const launchMs = new Date(launchDate + 'T00:00:00').getTime();

    // Compute next ticket id from current max — server-side avoids race conditions.
    const maxRow = await get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
    let nextNum = 1000;
    if (maxRow?.id) {
      const m = /^TKT-(\d+)$/.exec(maxRow.id);
      if (m) nextNum = parseInt(m[1], 10);
    }

    const tag = `Launch: ${name}`;
    const created = []; // returned to client

    for (const row of tmpl) {
      nextNum += 1;
      const tktId = 'TKT-' + nextNum;
      const title = (row.title_template || '').replace(/\{flavor\}/gi, name);
      const dueMs = launchMs + Number(row.days_offset || 0) * 86400000;
      const due = new Date(dueMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const createdStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      await run(`INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        tktId, title, u?.name || '', row.assignee || '', u?.name || '',
        row.priority || 'Medium', 'Open', row.dept || 'General',
        due, createdStr, 0, JSON.stringify([tag]), req.session.userId);
      await run('INSERT INTO ticket_details (ticket_id) VALUES (?) ON CONFLICT DO NOTHING', tktId);
      if (row.assignee) {
        await run('INSERT INTO ticket_assignees (ticket_id,user_name) VALUES (?,?) ON CONFLICT DO NOTHING', tktId, row.assignee);
        const target = await get('SELECT id FROM users WHERE name=?', row.assignee);
        if (target && target.id !== req.session.userId) {
          await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
            target.id, 'assigned', '👤', `${u?.name || 'Someone'} assigned you to "${title}"`, tktId);
        }
      }
      created.push({ id: tktId, title, assignee: row.assignee || '', dept: row.dept || '', due });
    }

    res.status(201).json({ ok: true, flavor: name, tag, tickets: created });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Work tasks ────────────────────────────────────────────────────────────────
app.get('/api/worktasks', requireAuth, async (req, res) => {
  try {
    res.json(await all('SELECT * FROM work_tasks ORDER BY created_at DESC'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/worktasks', requireAuth, async (req, res) => {
  try {
    const { ticketId, worker, estimate, notes } = req.body;
    const info = await run('INSERT INTO work_tasks (ticket_id,worker,estimate,notes,user_id) VALUES (?,?,?,?,?) RETURNING id',
      ticketId||'', worker||'', estimate||'', notes||'', req.session.userId);
    res.status(201).json(await get('SELECT * FROM work_tasks WHERE id=?', Number(info.lastInsertRowid)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/worktasks/:id', requireAuth, async (req, res) => {
  try {
    const { status, timer_running, timer_elapsed } = req.body;
    const u=[]; const v=[];
    if (status!==undefined)        { u.push('status=?');        v.push(status); }
    if (timer_running!==undefined) { u.push('timer_running=?'); v.push(timer_running?1:0); }
    if (timer_elapsed!==undefined) { u.push('timer_elapsed=?'); v.push(timer_elapsed); }
    if (u.length) { v.push(req.params.id); await run(`UPDATE work_tasks SET ${u.join(',')} WHERE id=?`, ...v); }
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/worktasks/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM work_tasks WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Calendar events ───────────────────────────────────────────────────────────
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    await safeAlter('ALTER TABLE cal_events ADD COLUMN source TEXT DEFAULT \'personal\'');
    const rows = await all("SELECT * FROM cal_events WHERE user_id=? OR source='syruvia' ORDER BY date_key ASC", req.session.userId);
    res.json(rows.map(r => ({
      id:r.id, dateKey:r.date_key, type:r.type, label:r.label, title:r.title,
      desc:r.description, allDay:!!r.all_day, startTime:r.start_time, endTime:r.end_time,
      linkedTicketId:r.linked_ticket_id, attendees:JSON.parse(r.attendees_json||'[]'),
      location:r.location, assignee:r.assignee, completed:!!r.completed, syncsTicket:!!r.syncs_ticket,
      source: r.source || 'personal', userId: r.user_id
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', requireAuth, async (req, res) => {
  try {
    const { dateKey, type, label, title, desc, allDay, startTime, endTime, linkedTicketId, attendees, location, assignee, completed, syncsTicket, source } = req.body;
    const info = await run(`INSERT INTO cal_events (date_key,type,label,title,description,all_day,start_time,end_time,linked_ticket_id,attendees_json,location,assignee,completed,syncs_ticket,user_id,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      dateKey, type||'meeting', label||title||'', title||'', desc||'', allDay?1:0,
      startTime||'', endTime||'', linkedTicketId||'', JSON.stringify(attendees||[]),
      location||'', assignee||'', completed?1:0, syncsTicket?1:0, req.session.userId, source||'personal');
    res.status(201).json({ id:Number(info.lastInsertRowid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
  try {
    const { dateKey, type, label, title, desc, allDay, startTime, endTime, linkedTicketId, attendees, location, assignee, completed, source } = req.body;
    await run(`UPDATE cal_events SET date_key=?,type=?,label=?,title=?,description=?,all_day=?,start_time=?,end_time=?,linked_ticket_id=?,attendees_json=?,location=?,assignee=?,completed=?,source=? WHERE id=?`,
      dateKey, type, label||title||'', title||'', desc||'', allDay?1:0,
      startTime||'', endTime||'', linkedTicketId||'', JSON.stringify(attendees||[]),
      location||'', assignee||'', completed?1:0, source||'personal', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM cal_events WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Plans ─────────────────────────────────────────────────────────────────────
async function buildPlan(row) {
  if (!row) return null;
  const files = await all('SELECT * FROM plan_files WHERE plan_id=?', row.id);
  return { ...row, files:files.map(f=>({id:f.id,name:f.filename,size:f.size})),
    promotedTicketId:row.promoted_ticket_id, reminderAt:row.reminder_at,
    reminderTriggered:!!row.reminder_triggered, createdAt:row.created_at, updatedAt:row.updated_at };
}

app.get('/api/plans', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM plans ORDER BY created_at DESC');
    res.json(await Promise.all(rows.map(buildPlan)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans', requireAuth, async (req, res) => {
  try {
    const { id, title, notes, status, reminderAt } = req.body;
    if (!id || !title) return res.status(400).json({ error:'id and title required' });
    const now = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    await run('INSERT INTO plans (id,title,notes,status,reminder_at,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, title, notes||'', status||'draft', reminderAt||'', req.session.userId, now, now);
    res.status(201).json(await buildPlan(await get('SELECT * FROM plans WHERE id=?', id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/plans/:id', requireAuth, async (req, res) => {
  try {
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
    await run(`UPDATE plans SET ${u.join(',')} WHERE id=?`, ...v);
    res.json(await buildPlan(await get('SELECT * FROM plans WHERE id=?', req.params.id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plans/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM plans WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/plans/:id/comments', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM plan_comments WHERE plan_id=? ORDER BY created_at ASC', req.params.id);
    res.json(rows.map(r=>({ id:r.id, author:r.author, bg:r.author_bg, col:r.author_col, text:r.text, time:timeAgo(r.created_at) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans/:id/comments', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error:'Text required' });
    const u = await getUser(req.session.userId);
    const palette = ['#ede9fe|#5b21b6','#dde4ff|#3730a3','#dcfce7|#166634'];
    const [bg,col] = (palette[u.id % palette.length]||palette[0]).split('|');
    const info = await run('INSERT INTO plan_comments (plan_id,author,author_bg,author_col,text) VALUES (?,?,?,?,?) RETURNING id',
      req.params.id, u.name, bg, col, text.trim());
    res.status(201).json({ id:Number(info.lastInsertRowid), author:u.name, bg, col, text:text.trim(), time: formatUSDateTime(new Date().toISOString()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Plan files ────────────────────────────────────────────────────────────────
app.get('/api/plans/:id/files', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM plan_files WHERE plan_id=? ORDER BY created_at ASC', req.params.id);
    res.json(rows.map(r => ({ id:r.id, name:r.filename, size:r.size, createdAt:r.created_at })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans/:id/files', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file' });
    const info = await run('INSERT INTO plan_files (plan_id,filename,size) VALUES (?,?,?) RETURNING id',
      req.params.id, req.file.originalname, req.file.size);
    res.status(201).json({ id:Number(info.lastInsertRowid), name:req.file.originalname, size:req.file.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plan-files/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM plan_files WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Profile ───────────────────────────────────────────────────────────────────
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const { name, role, dept, tz } = req.body;
    if (name !== undefined) await run('UPDATE users SET name=? WHERE id=?', String(name).trim(), req.session.userId);
    if (role !== undefined) await run('UPDATE users SET role=? WHERE id=?', String(role).trim(), req.session.userId);
    if (dept !== undefined) await run('UPDATE users SET dept=? WHERE id=?', String(dept).trim(), req.session.userId);
    if (tz   !== undefined) await run('UPDATE users SET tz=? WHERE id=?',   String(tz).trim(),   req.session.userId);
    const u = await getUser(req.session.userId);
    res.json({ id:u.id, name:u.name, email:u.email, role:u.role, dept:u.dept, color:u.color, avatarUrl:u.avatar_url || '', tz:u.tz || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error:'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error:'Password must be at least 6 characters' });
    const user = await get('SELECT password_hash FROM users WHERE id=?', req.session.userId);
    if (!bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(401).json({ error:'Current password is incorrect' });
    await run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(newPassword, 10), req.session.userId);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', req.session.userId);
    res.json(rows.map(n => ({ ...n, time_label: formatUSDateTime(n.created_at) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await run('UPDATE notifications SET unread=0 WHERE user_id=?', req.session.userId);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await run('UPDATE notifications SET unread=0 WHERE id=? AND user_id=?', req.params.id, req.session.userId);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Activity feed ─────────────────────────────────────────────────────────────
app.get('/api/activity', requireAuth, async (req, res) => {
  try {
    const rows = await all(`
      SELECT tt.id, tt.ticket_id, tt.text, tt.dot, tt.created_at,
             t.title as ticket_title
      FROM ticket_timelines tt
      LEFT JOIN tickets t ON t.id = tt.ticket_id
      ORDER BY tt.created_at DESC LIMIT 20
    `);
    res.json(rows.map(r => ({
      id: r.id, ticketId: r.ticket_id, ticketTitle: r.ticket_title || '',
      text: r.text, dot: r.dot, timeAgo: timeAgo(r.created_at)
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// US-format date/time: "May 5, 2:33 PM" (year shown only for prior years).
// Stored timestamps are 'YYYY-MM-DD HH:MM:SS' in UTC; we treat them as UTC.
function formatUSDateTime(iso) {
  try {
    const s = String(iso || '');
    const isoZ = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
    const d = new Date(isoZ);
    if (isNaN(d.getTime())) return '';
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    const h = d.getHours();
    const hour12 = (h % 12) || 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const minute = String(d.getMinutes()).padStart(2, '0');
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return sameYear
      ? `${month} ${day}, ${hour12}:${minute} ${ampm}`
      : `${month} ${day}, ${d.getFullYear()}, ${hour12}:${minute} ${ampm}`;
  } catch { return ''; }
}

function timeAgo(iso) { return formatUSDateTime(iso); }

// ── Attachments ───────────────────────────────────────────────────────────────
// Profile avatar upload — stores filename in users.avatar_url and returns the public url
app.post('/api/profile/avatar', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!req.file.mimetype?.startsWith('image/')) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
      return res.status(400).json({ error: 'Only image files allowed' });
    }
    // Remove the previous avatar file if any
    const prev = await get('SELECT avatar_url FROM users WHERE id=?', req.session.userId);
    if (prev?.avatar_url) {
      const oldName = String(prev.avatar_url).replace(/^\/uploads\//, '');
      if (oldName) try { fs.unlinkSync(path.join(UPLOADS_DIR, oldName)); } catch {}
    }
    const url = '/uploads/' + req.file.filename;
    await run('UPDATE users SET avatar_url=? WHERE id=?', url, req.session.userId);
    res.json({ ok: true, avatarUrl: url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/profile/avatar', requireAuth, async (req, res) => {
  try {
    const prev = await get('SELECT avatar_url FROM users WHERE id=?', req.session.userId);
    if (prev?.avatar_url) {
      const oldName = String(prev.avatar_url).replace(/^\/uploads\//, '');
      if (oldName) try { fs.unlinkSync(path.join(UPLOADS_DIR, oldName)); } catch {}
    }
    await run("UPDATE users SET avatar_url='' WHERE id=?", req.session.userId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const u = await getUser(req.session.userId);
    const { ticketId, commentId, subtaskId } = req.body;
    const info = await run(
      'INSERT INTO attachments (ticket_id,comment_id,subtask_id,filename,original_name,mime_type,size,uploader) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      ticketId || null, commentId ? Number(commentId) : null, subtaskId ? Number(subtaskId) : null,
      req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, u.name
    );
    res.json({
      id: Number(info.lastInsertRowid),
      filename: req.file.filename, originalName: req.file.originalname,
      mimeType: req.file.mimetype, size: req.file.size, url: `/uploads/${req.file.filename}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/attachments', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM attachments WHERE ticket_id=? ORDER BY created_at ASC', req.params.id);
    res.json(rows.map(r => ({
      id: r.id, filename: r.filename, originalName: r.original_name,
      mimeType: r.mime_type, size: r.size, uploader: r.uploader,
      commentId: r.comment_id, createdAt: r.created_at, url: `/uploads/${r.filename}`,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/attachments/:id', requireAuth, async (req, res) => {
  try {
    const att = await get('SELECT filename FROM attachments WHERE id=?', req.params.id);
    if (att) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch {}
      await run('DELETE FROM attachments WHERE id=?', req.params.id);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const { period, dept, assignee } = req.query;
    const now = new Date();
    let dateClause = '';
    if (period === 'week') {
      const since = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
      dateClause = `AND created_at >= '${since}'`;
    } else if (period === 'month') {
      const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
      dateClause = `AND created_at LIKE '${y}-${m}%'`;
    } else if (period === 'quarter') {
      const since = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
      dateClause = `AND created_at >= '${since}'`;
    } else if (period === 'year') {
      dateClause = `AND created_at LIKE '${now.getFullYear()}%'`;
    }
    // Members see stats limited to their own assigned tickets — overrides any client-supplied assignee filter.
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Owner','Admin'].includes(me.perm_role);
    const effectiveAssignee = isAdmin ? assignee : (me?.name || '__none__');
    const deptClause = dept ? `AND dept = '${dept.replace(/'/g, "''")}'` : '';
    const assigneeClause = effectiveAssignee
      ? `AND (assignee = '${effectiveAssignee.replace(/'/g, "''")}'
             OR id IN (SELECT ticket_id FROM ticket_assignees WHERE user_name = '${effectiveAssignee.replace(/'/g, "''")}'))`
      : '';
    const where = `WHERE 1=1 ${dateClause} ${deptClause} ${assigneeClause}`;

    const [totalRow, openRow, ipRow, ovRow, clRow, byDept, allDepts, allAssignees] = await Promise.all([
      get(`SELECT COUNT(*) as c FROM tickets ${where}`),
      get(`SELECT COUNT(*) as c FROM tickets ${where} AND status='Open'`),
      get(`SELECT COUNT(*) as c FROM tickets ${where} AND status='In Progress'`),
      get(`SELECT COUNT(*) as c FROM tickets ${where} AND overdue=1`),
      get(`SELECT COUNT(*) as c FROM tickets ${where} AND status='Closed'`),
      all(`SELECT dept, COUNT(*) as c FROM tickets ${where} GROUP BY dept ORDER BY c DESC`),
      all("SELECT DISTINCT dept FROM tickets WHERE dept IS NOT NULL AND dept != '' ORDER BY dept"),
      all("SELECT DISTINCT user_name as name FROM ticket_assignees WHERE user_name IS NOT NULL AND user_name != '' ORDER BY user_name"),
    ]);

    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0');
      const label = d.toLocaleString('default', { month: 'short' });
      let q = `SELECT COUNT(*) as c FROM tickets WHERE created_at LIKE '${y}-${m}%'`;
      if (deptClause) q += ` ${deptClause}`;
      if (assigneeClause) q += ` ${assigneeClause}`;
      const row = await get(q);
      monthly.push({ label, count: parseInt(row?.c || 0, 10) });
    }

    const todayStr = now.toISOString().slice(0, 10);
    const completedTodayRow = await get(
      `SELECT COUNT(*) as c FROM tickets WHERE status='Closed' AND created_at LIKE '${todayStr}%' ${assigneeClause}`
    );
    const prevNow = new Date(); prevNow.setMonth(prevNow.getMonth() - 1);
    const py = prevNow.getFullYear(), pm = String(prevNow.getMonth() + 1).padStart(2, '0');
    const prevWhere = `WHERE 1=1 AND created_at LIKE '${py}-${pm}%' ${deptClause} ${assigneeClause}`;
    const [prevTotalRow, prevIPRow, prevOvRow] = await Promise.all([
      get(`SELECT COUNT(*) as c FROM tickets ${prevWhere}`),
      get(`SELECT COUNT(*) as c FROM tickets ${prevWhere} AND status='In Progress'`),
      get(`SELECT COUNT(*) as c FROM tickets ${prevWhere} AND overdue=1`),
    ]);

    res.json({
      total: parseInt(totalRow?.c||0,10), open: parseInt(openRow?.c||0,10),
      inProgress: parseInt(ipRow?.c||0,10), overdue: parseInt(ovRow?.c||0,10),
      closed: parseInt(clRow?.c||0,10), completedToday: parseInt(completedTodayRow?.c||0,10),
      byDept, monthly, allDepts, allAssignees,
      prevTotal: parseInt(prevTotalRow?.c||0,10), prevInProgress: parseInt(prevIPRow?.c||0,10),
      prevOverdue: parseInt(prevOvRow?.c||0,10),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: create user ────────────────────────────────────────────────────────
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role, dept, permRole } = req.body;
    if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const norm = email.toLowerCase().trim();
    if (await get('SELECT id FROM users WHERE email=?', norm)) return res.status(409).json({ error: 'Email already in use' });
    const pRole = ['Owner','Admin','Member'].includes(permRole) ? permRole : 'Member';
    const hash = bcrypt.hashSync(password, 10);
    const info = await run('INSERT INTO users (name,email,password_hash,role,dept,perm_role) VALUES (?,?,?,?,?,?) RETURNING id',
      name.trim(), norm, hash, role?.trim() || 'Team Member', dept?.trim() || 'General', pRole);
    const u = await getUser(Number(info.lastInsertRowid));
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, permRole: u.perm_role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: delete user ────────────────────────────────────────────────────────
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const target = await get('SELECT id,perm_role FROM users WHERE id=?', req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.perm_role === 'Owner') return res.status(403).json({ error: 'Cannot delete the owner account' });
    if (target.id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
    await run('DELETE FROM users WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Departments ───────────────────────────────────────────────────────────────
app.get('/api/departments', requireAuth, async (req, res) => {
  try {
    res.json((await all('SELECT name FROM departments ORDER BY name ASC')).map(r => r.name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/departments', requireAdmin, async (req, res) => {
  try {
    const name = req.body.name?.trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (await get('SELECT id FROM departments WHERE name=?', name)) return res.status(409).json({ error: 'Department already exists' });
    await run('INSERT INTO departments (name) VALUES (?)', name);
    res.json({ ok: true, name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/departments/:name', requireAdmin, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const inUse = await get('SELECT id FROM users WHERE dept=? LIMIT 1', name) ||
                  await get('SELECT id FROM tickets WHERE dept=? LIMIT 1', name);
    if (inUse) return res.status(400).json({ error: 'Department is in use — reassign users and tickets first' });
    await run('DELETE FROM departments WHERE name=?', name);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reset all data ────────────────────────────────────────────────────────────
app.post('/api/reset', requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM ticket_comments');
    await run('DELETE FROM attachments');
    await run('DELETE FROM ticket_subtasks');
    await run('DELETE FROM ticket_timelines');
    await run('DELETE FROM notifications');
    await run('DELETE FROM ticket_assignees');
    await run('DELETE FROM ticket_details');
    await run('DELETE FROM tickets');
    await run('DELETE FROM plans');
    await run('DELETE FROM plan_files');
    await run('DELETE FROM plan_comments');
    await run('DELETE FROM cal_events');
    await run('DELETE FROM work_tasks');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok:true, ts: new Date().toISOString() });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error:'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDb();
    console.log('✅  Database initialized');

    try {
      await run("DELETE FROM users WHERE email IN ('sarah@worknest.com','mike@worknest.com','emily@worknest.com','david@worknest.com','priya@worknest.com')");
      await run("DELETE FROM tickets WHERE id IN ('TKT-1042','TKT-1041','TKT-1040','TKT-1039','TKT-1038','TKT-1037','TKT-1036','TKT-1035','TKT-0998')");
      await run("DELETE FROM plans WHERE id IN ('PLN-001','PLN-002','PLN-003')");
      await run("DELETE FROM invites WHERE email IN ('ariana@worknest.com','daniel@worknest.com')");
      await run("UPDATE users SET name='Admin', role='Administrator' WHERE email='admin@worknest.com' AND name='John Doe'");
    } catch(e) { console.warn('[cleanup]', e.message); }

    app.listen(PORT, () => {
      console.log(`✅  Syruvia running at http://localhost:${PORT}`);
      console.log(`   Default login: admin@worknest.com / admin123`);
    });
  } catch(e) {
    console.error('❌  Failed to start:', e.message);
    process.exit(1);
  }
})();
