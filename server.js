require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const multer = require('multer');
const { col, init: initDb, ObjectId, nowStr } = require('./db');
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
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/syruvia';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: MongoStore.create({ mongoUrl: MONGO_URI, dbName: 'syruvia', ttl: 7 * 24 * 60 * 60 }),
  secret: process.env.SESSION_SECRET || 'syruvia-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); }
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function toOid(id) { try { return new ObjectId(id); } catch { return null; } }

function numHash(id) {
  const s = id.toString();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return h;
}

function timeAgo(iso) {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'Yesterday' : `${d}d ago`;
  } catch { return 'Just now'; }
}

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function getUser(userId) {
  const oid = toOid(userId);
  if (!oid) return null;
  const u = await col('users').findOne({ _id: oid }, { projection: { password_hash: 0 } });
  if (!u) return null;
  return { id: u._id.toString(), name: u.name, email: u.email, role: u.role, dept: u.dept, color: u.color, perm_role: u.perm_role };
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const oid = toOid(req.session.userId);
    const u = oid ? await col('users').findOne({ _id: oid }, { projection: { perm_role: 1 } }) : null;
    if (!u || !['Owner', 'Admin'].includes(u.perm_role)) return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch(e) { next(e); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await col('users').findOne({ email: email.toLowerCase().trim() });
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user._id.toString();
    res.json({ id: user._id.toString(), name: user.name, email: user.email, role: user.role, dept: user.dept, color: user.color, permRole: user.perm_role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, token } = req.body;
    if (!token) return res.status(403).json({ error: 'Registration requires a valid invite link.' });
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const norm = email.toLowerCase().trim();
    const invite = await col('invites').findOne({ token, status: 'Pending' });
    if (!invite) return res.status(400).json({ error: 'This invite link is invalid or has already been used.' });
    if (invite.email.toLowerCase() !== norm) return res.status(400).json({ error: 'Email does not match this invite.' });
    if (await col('users').findOne({ email: norm })) return res.status(409).json({ error: 'This email is already registered.' });
    const role = invite.role || 'Team Member';
    const dept = invite.dept || 'General';
    await col('invites').updateOne({ token }, { $set: { status: 'Accepted' } });
    const { insertedId } = await col('users').insertOne({
      name: name.trim(), email: norm, password_hash: bcrypt.hashSync(password, 10),
      role, dept, color: '#2563eb', perm_role: 'Member', created_at: nowStr()
    });
    req.session.userId = insertedId.toString();
    res.json({ id: insertedId.toString(), name: name.trim(), email: norm, role, dept, permRole: 'Member' });
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
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, color: u.color, permRole: u.perm_role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Team ──────────────────────────────────────────────────────────────────────
app.get('/api/team', requireAuth, async (req, res) => {
  try {
    const members = await col('users').find({}, { projection: { password_hash: 0 } }).sort({ _id: 1 }).toArray();
    const openTickets = await col('tickets').find({ status: { $ne: 'Closed' } }, { projection: { _id: 1 } }).toArray();
    const openIds = openTickets.map(t => t._id);
    const counts = await col('ticket_assignees').aggregate([
      { $match: { ticket_id: { $in: openIds } } },
      { $group: { _id: '$user_name', cnt: { $sum: 1 } } }
    ]).toArray();
    const cm = {};
    counts.forEach(r => { cm[r._id] = r.cnt; });
    res.json(members.map(m => ({
      id: m._id.toString(), name: m.name, email: m.email, role: m.role,
      dept: m.dept, color: m.color, permRole: m.perm_role,
      workload: Math.min(100, (cm[m.name] || 0) * 10), tickets: cm[m.name] || 0
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/:id/role', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (oid) await col('users').updateOne({ _id: oid }, { $set: { perm_role: req.body.permRole } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/:id', requireAuth, async (req, res) => {
  try {
    const meOid = toOid(req.session.userId);
    const me = meOid ? await col('users').findOne({ _id: meOid }, { projection: { perm_role: 1 } }) : null;
    if (!['Owner', 'Admin'].includes(me?.perm_role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const targetOid = toOid(req.params.id);
    const target = targetOid ? await col('users').findOne({ _id: targetOid }, { projection: { perm_role: 1 } }) : null;
    if (target?.perm_role === 'Owner') return res.status(403).json({ error: 'Cannot remove owner' });
    if (targetOid) await col('users').deleteOne({ _id: targetOid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Invites ───────────────────────────────────────────────────────────────────
app.get('/api/invites', requireAuth, async (req, res) => {
  try {
    const rows = await col('invites').find({}).sort({ created_at: -1 }).toArray();
    res.json(rows.map(r => { const { _id, ...rest } = r; return { id: _id.toString(), ...rest }; }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invites', requireAuth, async (req, res) => {
  try {
    const { email, name, role, dept } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'Email and name required' });
    const norm = email.toLowerCase().trim();
    if (await col('users').findOne({ email: norm })) return res.status(409).json({ error: 'User already exists' });
    if (await col('invites').findOne({ email: norm, status: 'Pending' }))
      return res.status(409).json({ error: 'Invite already pending for this email' });
    const token = randomUUID();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { insertedId } = await col('invites').insertOne({
      email: norm, name: name.trim(), role: role || '', dept: dept || '',
      token, status: 'Pending', invited_by: req.session.userId,
      expires_at: expires, created_at: nowStr()
    });
    const invite = await col('invites').findOne({ _id: insertedId });
    const inviter = await col('users').findOne({ _id: toOid(req.session.userId) }, { projection: { name: 1 } });
    try {
      await sendInviteEmail({ toEmail: norm, toName: name.trim(), inviterName: inviter?.name || 'Your team', role, dept, token });
    } catch(e) { console.error('[email] Failed to send invite:', e.message); }
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const { _id, ...rest } = invite;
    res.json({ id: _id.toString(), ...rest, inviteUrl: `${appUrl}/invite.html?token=${token}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/invites/:id', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (oid) await col('invites').updateOne({ _id: oid }, { $set: { status: 'Cancelled' } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invites/token/:token', async (req, res) => {
  try {
    const inv = await col('invites').findOne({ token: req.params.token });
    if (!inv) return res.status(404).json({ error: 'Invite not found' });
    if (inv.status !== 'Pending') return res.status(410).json({ error: 'Invite already used or cancelled' });
    res.json({ name: inv.name, email: inv.email, role: inv.role, dept: inv.dept });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Tickets ───────────────────────────────────────────────────────────────────
async function buildTicket(row) {
  if (!row) return null;
  const ticketId = (row._id || row.id).toString();
  const assignees = await col('ticket_assignees').find({ ticket_id: ticketId }).toArray();
  const { _id, ...rest } = row;
  return {
    ...rest, id: ticketId,
    tags: JSON.parse(row.tags_json || '[]'),
    assignees: assignees.map(a => a.user_name),
    overdue: !!row.overdue,
    comments: row.comments_count
  };
}

app.get('/api/tickets', requireAuth, async (req, res) => {
  try {
    const rows = await col('tickets').find({}).sort({ _id: -1 }).toArray();
    res.json(await Promise.all(rows.map(buildTicket)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    const row = await col('tickets').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(await buildTicket(row));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets', requireAuth, async (req, res) => {
  try {
    const { id, title, req: reqName, assignee, assignees, reporter, priority, status, dept, due, created, overdue, tags } = req.body;
    if (!id || !title) return res.status(400).json({ error: 'id and title required' });
    await col('tickets').updateOne({ _id: id }, {
      $setOnInsert: {
        _id: id, title, req: reqName || '', assignee: assignee || '', reporter: reporter || '',
        priority: priority || 'Medium', status: status || 'Open', dept: dept || 'Engineering',
        due: due || '', created: created || '', overdue: overdue ? 1 : 0,
        tags_json: JSON.stringify(tags || []), comments_count: 0,
        created_by: req.session.userId, created_at: nowStr()
      }
    }, { upsert: true });
    await col('ticket_details').updateOne(
      { ticket_id: id },
      { $setOnInsert: { ticket_id: id, description: '', checklist_json: '[]' } },
      { upsert: true }
    );
    for (const a of (assignees || [])) {
      await col('ticket_assignees').updateOne(
        { ticket_id: id, user_name: a },
        { $setOnInsert: { ticket_id: id, user_name: a } },
        { upsert: true }
      );
    }
    const creator = await getUser(req.session.userId);
    for (const a of (assignees || [])) {
      const target = await col('users').findOne({ name: a }, { projection: { _id: 1 } });
      if (target && target._id.toString() !== req.session.userId) {
        await col('notifications').insertOne({
          user_id: target._id.toString(), type: 'assigned', icon: '👤',
          text: `${creator?.name || 'Someone'} assigned you to "${title}"`,
          ticket_id: id, unread: 1, created_at: nowStr()
        });
      }
    }
    res.status(201).json(await buildTicket(await col('tickets').findOne({ _id: id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    const { title, req: reqName, assignee, assignees, reporter, priority, status, dept, due, overdue, tags } = req.body;
    if (!await col('tickets').findOne({ _id: req.params.id })) return res.status(404).json({ error: 'Not found' });
    const upd = {};
    if (title !== undefined)    upd.title = title;
    if (reqName !== undefined)  upd.req = reqName;
    if (assignee !== undefined) upd.assignee = assignee;
    if (reporter !== undefined) upd.reporter = reporter;
    if (priority !== undefined) upd.priority = priority;
    if (status !== undefined)   upd.status = status;
    if (dept !== undefined)     upd.dept = dept;
    if (due !== undefined)      upd.due = due;
    if (overdue !== undefined)  upd.overdue = overdue ? 1 : 0;
    if (tags !== undefined)     upd.tags_json = JSON.stringify(tags);
    if (Object.keys(upd).length) await col('tickets').updateOne({ _id: req.params.id }, { $set: upd });
    if (assignees !== undefined) {
      const oldDocs = await col('ticket_assignees').find({ ticket_id: req.params.id }).toArray();
      const oldAssignees = oldDocs.map(a => a.user_name);
      await col('ticket_assignees').deleteMany({ ticket_id: req.params.id });
      for (const a of assignees) {
        await col('ticket_assignees').updateOne(
          { ticket_id: req.params.id, user_name: a },
          { $setOnInsert: { ticket_id: req.params.id, user_name: a } },
          { upsert: true }
        );
      }
      const newAssignees = assignees.filter(a => !oldAssignees.includes(a));
      if (newAssignees.length) {
        const assigner = await getUser(req.session.userId);
        const tkt = await col('tickets').findOne({ _id: req.params.id }, { projection: { title: 1 } });
        for (const name of newAssignees) {
          const target = await col('users').findOne({ name }, { projection: { _id: 1 } });
          if (target && target._id.toString() !== req.session.userId) {
            await col('notifications').insertOne({
              user_id: target._id.toString(), type: 'assigned', icon: '👤',
              text: `${assigner?.name || 'Someone'} assigned you to "${tkt?.title || req.params.id}"`,
              ticket_id: req.params.id, unread: 1, created_at: nowStr()
            });
          }
        }
      }
    }
    res.json(await buildTicket(await col('tickets').findOne({ _id: req.params.id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    await col('tickets').deleteOne({ _id: req.params.id });
    await col('ticket_assignees').deleteMany({ ticket_id: req.params.id });
    await col('ticket_details').deleteOne({ ticket_id: req.params.id });
    await col('ticket_comments').deleteMany({ ticket_id: req.params.id });
    await col('ticket_timelines').deleteMany({ ticket_id: req.params.id });
    await col('attachments').deleteMany({ ticket_id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/details', requireAuth, async (req, res) => {
  try {
    const row = await col('ticket_details').findOne({ ticket_id: req.params.id });
    if (!row) return res.json({ description: '', checklist: [] });
    res.json({ description: row.description, checklist: JSON.parse(row.checklist_json || '[]') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tickets/:id/details', requireAuth, async (req, res) => {
  try {
    const { description, checklist } = req.body;
    await col('ticket_details').updateOne(
      { ticket_id: req.params.id },
      { $set: { ticket_id: req.params.id, description: description || '', checklist_json: JSON.stringify(checklist || []) } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/comments', requireAuth, async (req, res) => {
  try {
    const rows = await col('ticket_comments').find({ ticket_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json(rows.map(r => ({ id: r._id.toString(), author: r.author, init: r.author_init, bg: r.author_bg, col: r.author_col, text: r.text, time: timeAgo(r.created_at) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/comments', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
    const u = await getUser(req.session.userId);
    const init = u.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const palette = ['#ede9fe|#5b21b6', '#dde4ff|#3730a3', '#dcfce7|#166534', '#fef9c3|#854d0e'];
    const [bg, clr] = (palette[numHash(u.id) % palette.length] || palette[0]).split('|');
    const { insertedId } = await col('ticket_comments').insertOne({
      ticket_id: req.params.id, author: u.name, author_init: init,
      author_bg: bg, author_col: clr, text: text.trim(), created_at: nowStr()
    });
    await col('tickets').updateOne({ _id: req.params.id }, { $inc: { comments_count: 1 } });
    const tkt = await col('tickets').findOne({ _id: req.params.id }, { projection: { title: 1 } });
    const mentions = (text.match(/@([A-Za-z]+(?: [A-Za-z]+)*)/g) || []).map(m => m.slice(1));
    for (const name of mentions) {
      const mentioned = await col('users').findOne({ name }, { projection: { _id: 1 } });
      if (mentioned && mentioned._id.toString() !== req.session.userId) {
        await col('notifications').insertOne({
          user_id: mentioned._id.toString(), type: 'mention', icon: '💬',
          text: `${u.name} mentioned you in "${tkt?.title || req.params.id}"`,
          ticket_id: req.params.id, unread: 1, created_at: nowStr()
        });
      }
    }
    res.status(201).json({ id: insertedId.toString(), author: u.name, init, bg, col: clr, text: text.trim(), time: 'Just now' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets/:id/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.commentId);
    if (!oid) return res.status(404).json({ error: 'Comment not found' });
    const comment = await col('ticket_comments').findOne({ _id: oid, ticket_id: req.params.id });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    await col('ticket_comments').deleteOne({ _id: oid });
    await col('tickets').updateOne({ _id: req.params.id }, { $inc: { comments_count: -1 } });
    await col('tickets').updateOne({ _id: req.params.id, comments_count: { $lt: 0 } }, { $set: { comments_count: 0 } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/timeline', requireAuth, async (req, res) => {
  try {
    const rows = await col('ticket_timelines').find({ ticket_id: req.params.id }).sort({ created_at: -1 }).toArray();
    if (!rows.length) {
      const t = await col('tickets').findOne({ _id: req.params.id });
      if (t) return res.json([{ dot: 'var(--green)', text: 'Ticket created', sub: t.created }]);
    }
    res.json(rows.map(r => ({ id: r._id.toString(), dot: r.dot, text: r.text, sub: r.sub })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/timeline', requireAuth, async (req, res) => {
  try {
    const { dot, text, sub } = req.body;
    await col('ticket_timelines').insertOne({
      ticket_id: req.params.id, dot: dot || 'var(--accent)', text, sub: sub || 'Just now', created_at: nowStr()
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Work tasks ────────────────────────────────────────────────────────────────
app.get('/api/worktasks', requireAuth, async (req, res) => {
  try {
    const rows = await col('work_tasks').find({}).sort({ created_at: -1 }).toArray();
    res.json(rows.map(r => { const { _id, ...rest } = r; return { id: _id.toString(), ...rest }; }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/worktasks', requireAuth, async (req, res) => {
  try {
    const { ticketId, worker, estimate, notes } = req.body;
    const { insertedId } = await col('work_tasks').insertOne({
      ticket_id: ticketId || '', worker: worker || '', estimate: estimate || '',
      notes: notes || '', status: 'pending', timer_running: 0, timer_elapsed: 0,
      user_id: req.session.userId, created_at: nowStr()
    });
    const doc = await col('work_tasks').findOne({ _id: insertedId });
    const { _id, ...rest } = doc;
    res.status(201).json({ id: _id.toString(), ...rest });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/worktasks/:id', requireAuth, async (req, res) => {
  try {
    const { status, timer_running, timer_elapsed } = req.body;
    const upd = {};
    if (status !== undefined)        upd.status = status;
    if (timer_running !== undefined) upd.timer_running = timer_running ? 1 : 0;
    if (timer_elapsed !== undefined) upd.timer_elapsed = timer_elapsed;
    const oid = toOid(req.params.id);
    if (oid && Object.keys(upd).length) await col('work_tasks').updateOne({ _id: oid }, { $set: upd });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/worktasks/:id', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (oid) await col('work_tasks').deleteOne({ _id: oid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Calendar events ───────────────────────────────────────────────────────────
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const rows = await col('cal_events').find({
      $or: [{ user_id: req.session.userId }, { source: 'syruvia' }]
    }).sort({ date_key: 1 }).toArray();
    res.json(rows.map(r => ({
      id: r._id.toString(), dateKey: r.date_key, type: r.type, label: r.label, title: r.title,
      desc: r.description, allDay: !!r.all_day, startTime: r.start_time, endTime: r.end_time,
      linkedTicketId: r.linked_ticket_id, attendees: JSON.parse(r.attendees_json || '[]'),
      location: r.location, assignee: r.assignee, completed: !!r.completed, syncsTicket: !!r.syncs_ticket,
      source: r.source || 'personal', userId: r.user_id
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', requireAuth, async (req, res) => {
  try {
    const { dateKey, type, label, title, desc, allDay, startTime, endTime, linkedTicketId, attendees, location, assignee, completed, syncsTicket, source } = req.body;
    const { insertedId } = await col('cal_events').insertOne({
      date_key: dateKey, type: type || 'meeting', label: label || title || '',
      title: title || '', description: desc || '', all_day: allDay ? 1 : 0,
      start_time: startTime || '', end_time: endTime || '',
      linked_ticket_id: linkedTicketId || '', attendees_json: JSON.stringify(attendees || []),
      location: location || '', assignee: assignee || '', completed: completed ? 1 : 0,
      syncs_ticket: syncsTicket ? 1 : 0, user_id: req.session.userId,
      source: source || 'personal', created_at: nowStr()
    });
    res.status(201).json({ id: insertedId.toString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
  try {
    const { dateKey, type, label, title, desc, allDay, startTime, endTime, linkedTicketId, attendees, location, assignee, completed, source } = req.body;
    const oid = toOid(req.params.id);
    if (oid) await col('cal_events').updateOne({ _id: oid }, { $set: {
      date_key: dateKey, type, label: label || title || '', title: title || '',
      description: desc || '', all_day: allDay ? 1 : 0,
      start_time: startTime || '', end_time: endTime || '',
      linked_ticket_id: linkedTicketId || '', attendees_json: JSON.stringify(attendees || []),
      location: location || '', assignee: assignee || '', completed: completed ? 1 : 0,
      source: source || 'personal'
    }});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (oid) await col('cal_events').deleteOne({ _id: oid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Plans ─────────────────────────────────────────────────────────────────────
async function buildPlan(row) {
  if (!row) return null;
  const planId = (row._id || row.id).toString();
  const files = await col('plan_files').find({ plan_id: planId }).toArray();
  const { _id, ...rest } = row;
  return {
    ...rest, id: planId,
    files: files.map(f => ({ id: f._id.toString(), name: f.filename, size: f.size })),
    promotedTicketId: row.promoted_ticket_id, reminderAt: row.reminder_at,
    reminderTriggered: !!row.reminder_triggered, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

app.get('/api/plans', requireAuth, async (req, res) => {
  try {
    const rows = await col('plans').find({}).sort({ created_at: -1 }).toArray();
    res.json(await Promise.all(rows.map(buildPlan)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans', requireAuth, async (req, res) => {
  try {
    const { id, title, notes, status, reminderAt } = req.body;
    if (!id || !title) return res.status(400).json({ error: 'id and title required' });
    const now = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    await col('plans').updateOne({ _id: id }, {
      $setOnInsert: {
        _id: id, title, notes: notes || '', status: status || 'draft',
        reminder_at: reminderAt || '', reminder_triggered: 0, promoted_ticket_id: '',
        user_id: req.session.userId, created_at: now, updated_at: now
      }
    }, { upsert: true });
    res.status(201).json(await buildPlan(await col('plans').findOne({ _id: id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/plans/:id', requireAuth, async (req, res) => {
  try {
    const { title, notes, status, reminderAt, reminderTriggered, promotedTicketId } = req.body;
    const upd = {};
    if (title !== undefined)             upd.title = title;
    if (notes !== undefined)             upd.notes = notes;
    if (status !== undefined)            upd.status = status;
    if (reminderAt !== undefined)        upd.reminder_at = reminderAt;
    if (reminderTriggered !== undefined) upd.reminder_triggered = reminderTriggered ? 1 : 0;
    if (promotedTicketId !== undefined)  upd.promoted_ticket_id = promotedTicketId;
    upd.updated_at = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    await col('plans').updateOne({ _id: req.params.id }, { $set: upd });
    res.json(await buildPlan(await col('plans').findOne({ _id: req.params.id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plans/:id', requireAuth, async (req, res) => {
  try {
    await col('plans').deleteOne({ _id: req.params.id });
    await col('plan_files').deleteMany({ plan_id: req.params.id });
    await col('plan_comments').deleteMany({ plan_id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/plans/:id/comments', requireAuth, async (req, res) => {
  try {
    const rows = await col('plan_comments').find({ plan_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json(rows.map(r => ({ id: r._id.toString(), author: r.author, bg: r.author_bg, col: r.author_col, text: r.text, time: timeAgo(r.created_at) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans/:id/comments', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
    const u = await getUser(req.session.userId);
    const palette = ['#ede9fe|#5b21b6', '#dde4ff|#3730a3', '#dcfce7|#166634'];
    const [bg, clr] = (palette[numHash(u.id) % palette.length] || palette[0]).split('|');
    const { insertedId } = await col('plan_comments').insertOne({
      plan_id: req.params.id, author: u.name, author_bg: bg, author_col: clr,
      text: text.trim(), created_at: nowStr()
    });
    res.status(201).json({ id: insertedId.toString(), author: u.name, bg, col: clr, text: text.trim(), time: 'Just now' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Plan files ────────────────────────────────────────────────────────────────
app.get('/api/plans/:id/files', requireAuth, async (req, res) => {
  try {
    const rows = await col('plan_files').find({ plan_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json(rows.map(r => ({ id: r._id.toString(), name: r.filename, size: r.size, createdAt: r.created_at })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans/:id/files', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { insertedId } = await col('plan_files').insertOne({
      plan_id: req.params.id, filename: req.file.originalname, size: req.file.size, created_at: nowStr()
    });
    res.status(201).json({ id: insertedId.toString(), name: req.file.originalname, size: req.file.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plan-files/:id', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (oid) await col('plan_files').deleteOne({ _id: oid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Profile ───────────────────────────────────────────────────────────────────
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const { name, role, dept } = req.body;
    const upd = {};
    if (name) upd.name = name.trim();
    if (role) upd.role = role.trim();
    if (dept) upd.dept = dept.trim();
    const oid = toOid(req.session.userId);
    if (oid && Object.keys(upd).length) await col('users').updateOne({ _id: oid }, { $set: upd });
    const u = await getUser(req.session.userId);
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, color: u.color });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const oid = toOid(req.session.userId);
    const user = oid ? await col('users').findOne({ _id: oid }, { projection: { password_hash: 1 } }) : null;
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });
    await col('users').updateOne({ _id: oid }, { $set: { password_hash: bcrypt.hashSync(newPassword, 10) } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const rows = await col('notifications').find({ user_id: req.session.userId }).sort({ created_at: -1 }).limit(50).toArray();
    res.json(rows.map(r => { const { _id, ...rest } = r; return { id: _id.toString(), ...rest }; }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await col('notifications').updateMany({ user_id: req.session.userId }, { $set: { unread: 0 } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (oid) await col('notifications').updateOne({ _id: oid, user_id: req.session.userId }, { $set: { unread: 0 } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Activity feed ─────────────────────────────────────────────────────────────
app.get('/api/activity', requireAuth, async (req, res) => {
  try {
    const timelines = await col('ticket_timelines').find({}).sort({ created_at: -1 }).limit(20).toArray();
    const ticketIds = [...new Set(timelines.map(t => t.ticket_id))];
    const tickets = await col('tickets').find({ _id: { $in: ticketIds } }, { projection: { title: 1 } }).toArray();
    const titleMap = {};
    tickets.forEach(t => { titleMap[t._id] = t.title; });
    res.json(timelines.map(r => ({
      id: r._id.toString(), ticketId: r.ticket_id,
      ticketTitle: titleMap[r.ticket_id] || '',
      text: r.text, dot: r.dot, timeAgo: timeAgo(r.created_at)
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Attachments ───────────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const u = await getUser(req.session.userId);
    const { ticketId, commentId } = req.body;
    const { insertedId } = await col('attachments').insertOne({
      ticket_id: ticketId || null, comment_id: commentId || null,
      filename: req.file.filename, original_name: req.file.originalname,
      mime_type: req.file.mimetype, size: req.file.size, uploader: u.name, created_at: nowStr()
    });
    res.json({
      id: insertedId.toString(), filename: req.file.filename,
      originalName: req.file.originalname, mimeType: req.file.mimetype,
      size: req.file.size, url: `/uploads/${req.file.filename}`
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/attachments', requireAuth, async (req, res) => {
  try {
    const rows = await col('attachments').find({ ticket_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json(rows.map(r => ({
      id: r._id.toString(), filename: r.filename, originalName: r.original_name,
      mimeType: r.mime_type, size: r.size, uploader: r.uploader,
      commentId: r.comment_id, createdAt: r.created_at, url: `/uploads/${r.filename}`
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/attachments/:id', requireAuth, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (oid) {
      const att = await col('attachments').findOne({ _id: oid }, { projection: { filename: 1 } });
      if (att) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch {}
        await col('attachments').deleteOne({ _id: oid });
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const { period, dept, assignee } = req.query;
    const now = new Date();
    const match = {};

    if (period === 'week') {
      match.created_at = { $gte: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19) };
    } else if (period === 'month') {
      const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
      match.created_at = { $regex: `^${y}-${m}` };
    } else if (period === 'quarter') {
      match.created_at = { $gte: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 19) };
    } else if (period === 'year') {
      match.created_at = { $regex: `^${now.getFullYear()}` };
    }
    if (dept) match.dept = dept;

    let ticketIds = null;
    if (assignee) {
      const docs = await col('ticket_assignees').find({ user_name: assignee }, { projection: { ticket_id: 1 } }).toArray();
      ticketIds = docs.map(a => a.ticket_id);
      match._id = { $in: ticketIds };
    }

    const [total, open, ip, ov, cl, byDeptRaw, allDeptsRaw, allAssigneesRaw] = await Promise.all([
      col('tickets').countDocuments(match),
      col('tickets').countDocuments({ ...match, status: 'Open' }),
      col('tickets').countDocuments({ ...match, status: 'In Progress' }),
      col('tickets').countDocuments({ ...match, overdue: 1 }),
      col('tickets').countDocuments({ ...match, status: 'Closed' }),
      col('tickets').aggregate([
        { $match: match },
        { $group: { _id: '$dept', c: { $sum: 1 } } },
        { $sort: { c: -1 } }
      ]).toArray(),
      col('tickets').distinct('dept', { dept: { $nin: [null, ''] } }),
      col('ticket_assignees').distinct('user_name', { user_name: { $nin: [null, ''] } }),
    ]);

    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0');
      const label = d.toLocaleString('default', { month: 'short' });
      const mm = { created_at: { $regex: `^${y}-${m}` } };
      if (dept) mm.dept = dept;
      if (ticketIds) mm._id = { $in: ticketIds };
      const count = await col('tickets').countDocuments(mm);
      monthly.push({ label, count });
    }

    const todayStr = now.toISOString().slice(0, 10);
    const completedToday = await col('tickets').countDocuments({ status: 'Closed', created_at: { $regex: `^${todayStr}` } });
    const prevNow = new Date(); prevNow.setMonth(prevNow.getMonth() - 1);
    const py = prevNow.getFullYear(), pm = String(prevNow.getMonth() + 1).padStart(2, '0');
    const prevMatch = { created_at: { $regex: `^${py}-${pm}` } };
    if (dept) prevMatch.dept = dept;
    if (ticketIds) prevMatch._id = { $in: ticketIds };
    const [prevTotal, prevIP, prevOv] = await Promise.all([
      col('tickets').countDocuments(prevMatch),
      col('tickets').countDocuments({ ...prevMatch, status: 'In Progress' }),
      col('tickets').countDocuments({ ...prevMatch, overdue: 1 }),
    ]);

    res.json({
      total, open, inProgress: ip, overdue: ov, closed: cl, completedToday,
      byDept: byDeptRaw.map(r => ({ dept: r._id, c: r.c })),
      monthly,
      allDepts: allDeptsRaw.sort().map(d => ({ dept: d })),
      allAssignees: allAssigneesRaw.sort().map(name => ({ name })),
      prevTotal, prevInProgress: prevIP, prevOverdue: prevOv
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
    if (await col('users').findOne({ email: norm })) return res.status(409).json({ error: 'Email already in use' });
    const pRole = ['Owner', 'Admin', 'Member'].includes(permRole) ? permRole : 'Member';
    const { insertedId } = await col('users').insertOne({
      name: name.trim(), email: norm, password_hash: bcrypt.hashSync(password, 10),
      role: role?.trim() || 'Team Member', dept: dept?.trim() || 'General',
      color: '#2563eb', perm_role: pRole, created_at: nowStr()
    });
    const u = await getUser(insertedId.toString());
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, permRole: u.perm_role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: delete user ────────────────────────────────────────────────────────
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const oid = toOid(req.params.id);
    if (!oid) return res.status(404).json({ error: 'User not found' });
    const target = await col('users').findOne({ _id: oid }, { projection: { perm_role: 1 } });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.perm_role === 'Owner') return res.status(403).json({ error: 'Cannot delete the owner account' });
    if (oid.toString() === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
    await col('users').deleteOne({ _id: oid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Departments ───────────────────────────────────────────────────────────────
app.get('/api/departments', requireAuth, async (req, res) => {
  try {
    const rows = await col('departments').find({}).sort({ name: 1 }).toArray();
    res.json(rows.map(r => r.name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/departments', requireAdmin, async (req, res) => {
  try {
    const name = req.body.name?.trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (await col('departments').findOne({ name })) return res.status(409).json({ error: 'Department already exists' });
    await col('departments').insertOne({ name });
    res.json({ ok: true, name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/departments/:name', requireAdmin, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const inUse = await col('users').findOne({ dept: name }) || await col('tickets').findOne({ dept: name });
    if (inUse) return res.status(400).json({ error: 'Department is in use — reassign users and tickets first' });
    await col('departments').deleteOne({ name });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reset all data ────────────────────────────────────────────────────────────
app.post('/api/reset', requireAdmin, async (req, res) => {
  try {
    await Promise.all([
      col('ticket_comments').deleteMany({}),
      col('attachments').deleteMany({}),
      col('ticket_timelines').deleteMany({}),
      col('notifications').deleteMany({}),
      col('ticket_assignees').deleteMany({}),
      col('ticket_details').deleteMany({}),
      col('tickets').deleteMany({}),
      col('plans').deleteMany({}),
      col('plan_files').deleteMany({}),
      col('plan_comments').deleteMany({}),
      col('cal_events').deleteMany({}),
      col('work_tasks').deleteMany({}),
    ]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDb();
    console.log('✅  Database initialized');

    try {
      await col('users').deleteMany({ email: { $in: ['sarah@worknest.com', 'mike@worknest.com', 'emily@worknest.com', 'david@worknest.com', 'priya@worknest.com'] } });
      await col('tickets').deleteMany({ _id: { $in: ['TKT-1042','TKT-1041','TKT-1040','TKT-1039','TKT-1038','TKT-1037','TKT-1036','TKT-1035','TKT-0998'] } });
      await col('plans').deleteMany({ _id: { $in: ['PLN-001', 'PLN-002', 'PLN-003'] } });
      await col('invites').deleteMany({ email: { $in: ['ariana@worknest.com', 'daniel@worknest.com'] } });
      await col('users').updateOne({ email: 'admin@worknest.com', name: 'John Doe' }, { $set: { name: 'Admin', role: 'Administrator' } });
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
