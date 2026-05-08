require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const multer = require('multer');
const webpush = require('web-push');
const { pool, init: initDb, get, all, run, safeAlter, withTx } = require('./db');

// ── Web Push (PWA notifications) ─────────────────────────────────────────────
// Configured once at boot. If the keys aren't set the rest of the app keeps
// working — sendPushToUser becomes a no-op so we don't break flows that fan
// out a push as a side effect (assignment, new comment, etc.).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';
let pushReady = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushReady = true;
    console.log('[push] enabled');
  } catch (e) {
    console.error('[push] setVapidDetails failed:', e.message);
  }
} else {
  console.log('[push] disabled — set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars to enable');
}

// Send a Web Push to every device this user has subscribed. Failures are
// swallowed (and stale subscriptions auto-pruned on 404/410), so callers
// can fire-and-forget without worrying about a single bad endpoint
// breaking the request.
async function sendPushToUser(userId, payload) {
  if (!pushReady || !userId) return { sent: 0, removed: 0 };
  let subs;
  try {
    subs = await all('SELECT * FROM push_subscriptions WHERE user_id=?', userId);
  } catch (e) { console.error('[push] sub lookup failed:', e.message); return { sent: 0, removed: 0 }; }
  if (!subs || !subs.length) return { sent: 0, removed: 0 };
  const body = JSON.stringify(payload || {});
  let sent = 0, removed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 60 * 60 * 24 } // a day
      );
      sent++;
      // Refresh last_used_at lazily — only every ~10 sends per row to avoid
      // hammering the DB. Cheap UPDATE either way.
      run('UPDATE push_subscriptions SET last_used_at = TO_CHAR(NOW() AT TIME ZONE \'UTC\', \'YYYY-MM-DD HH24:MI:SS\') WHERE id=?', s.id).catch(()=>{});
    } catch (err) {
      const status = err && (err.statusCode || err.status);
      if (status === 404 || status === 410) {
        // Endpoint is gone — drop the row so we don't keep retrying it.
        try { await run('DELETE FROM push_subscriptions WHERE id=?', s.id); removed++; } catch {}
      } else {
        console.warn('[push] send failed', status || err.message, 'sub', s.id);
      }
    }
  }
  return { sent, removed };
}
const {
  sendInviteEmail, sendWelcomeEmail, sendActivateAccountEmail,
  sendForgotPasswordEmail, sendPasswordChangedEmail, sendNewDeviceLoginEmail,
  sendTicketAssignedEmail, sendTicketStatusChangedEmail, sendTicketClosedEmail,
  sendNewCommentEmail, sendMentionEmail, sendOverdueDigestEmail,
  sendMeetingInviteEmail, sendMeetingReminderEmail, sendTaskAssignedEmail,
  sendDeadlineApproachingEmail, sendEventCancelledEmail,
  sendTicketReminderEmail,
} = require('./email');

// ── Email helpers ────────────────────────────────────────────────────────────
// Look up a user's email by their display name. Returns null when there's
// no matching user (e.g. assignee names that haven't been provisioned yet).
async function emailForName(name) {
  if (!name) return null;
  const u = await get('SELECT email, name FROM users WHERE name=?', name);
  return u ? { email: u.email, name: u.name } : null;
}

// Parse a User-Agent string into something human-friendly for security alerts.
function parseUA(ua) {
  if (!ua) return 'Unknown device';
  const s = String(ua);
  let browser = 'Unknown browser';
  if (/edg(e|a|ios)?\//i.test(s))      browser = 'Edge';
  else if (/chrome\//i.test(s))         browser = 'Chrome';
  else if (/firefox\//i.test(s))        browser = 'Firefox';
  else if (/safari\//i.test(s))         browser = 'Safari';
  else if (/curl|wget|node/i.test(s))   browser = 'API client';
  let os = 'Unknown OS';
  if (/windows nt 10/i.test(s))         os = 'Windows 10';
  else if (/windows/i.test(s))          os = 'Windows';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/iphone|ipad|ios/i.test(s))  os = 'iOS';
  else if (/android/i.test(s))          os = 'Android';
  else if (/linux/i.test(s))            os = 'Linux';
  return `${browser} on ${os}`;
}

// Best-effort device "fingerprint" stored on the user. We just keep parseUA().
function deviceKey(ua) {
  return parseUA(ua);
}

// Wrapper that fires & forgets emails — never lets a mailer error fail
// the underlying request. Logs and moves on.
function fireEmail(label, promiseFactory) {
  Promise.resolve()
    .then(() => promiseFactory())
    .catch(e => console.error(`[email:${label}] failed:`, e.message));
}

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
  // 100MB limit to accommodate screen recordings (1.2 Mbps × ~10 min ≈ 90MB).
  // Voice notes and images stay well under this.
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Allow common image (excluding SVG — it can carry <script>), audio,
    // video (webm/mp4 only — what MediaRecorder produces), PDF, common
    // Office + spreadsheet formats, plain text/csv. Block HTML / SVG /
    // executables — the static handler below could otherwise serve them
    // back on our origin and run scripts in users' browsers.
    const m = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const safeImage = /^image\/(png|jpeg|jpg|gif|webp|bmp|heic|heif)$/.test(m)
      || ['png','jpg','jpeg','gif','webp','bmp','heic','heif'].includes(ext);
    const safeAudio = /^audio\//.test(m);
    // Allow webm, mp4, quicktime (Safari mov) — accept with or without
    // codec parameters (browsers vary on whether they include them).
    const safeVideo = /^video\/(webm|mp4|quicktime|x-matroska)\b/.test(m)
      || ['mp4','mov','webm'].includes(ext);
    const safePdf   = m === 'application/pdf' || ext === 'pdf';
    const safeOffice = [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ].includes(m) || ['doc','docx','xls','xlsx','ppt','pptx'].includes(ext);
    const safeText = /^text\/(plain|csv)$/.test(m) || ['txt','csv','log'].includes(ext);
    const safeArchive = m === 'application/zip' || ext === 'zip';
    const ok = safeImage || safeAudio || safeVideo || safePdf || safeOffice || safeText || safeArchive;
    if (!ok) {
      console.warn('[upload] rejected by filter:', file.originalname, '→', m || '(no mimetype)', 'ext=' + (ext || '(none)'));
      // Stash the rejection reason on the request so the route handler
      // can return a meaningful 400 instead of a generic "No file".
      req._uploadRejected = { name: file.originalname, mime: m, ext };
    }
    cb(null, ok);
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Behind Render / a reverse proxy — needed so secure-cookie checks see HTTPS
app.set('trust proxy', 1);

// Tiny in-memory rate limiter. Keyed by IP+route. Not perfect (per-process,
// lost on deploy) but enough to slow credential-stuffing on the auth routes.
function rateLimit({ windowMs, max, key = 'ip' }) {
  const buckets = new Map(); // key → { resetAt, count }
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
    const k = key === 'ip' ? ip : `${ip}:${req.path}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt < now) { b = { resetAt: now + windowMs, count: 0 }; buckets.set(k, b); }
    b.count++;
    if (b.count > max) {
      const retryMs = Math.max(0, b.resetAt - now);
      res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    next();
  };
}
const authLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10, key: 'route' });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, key: 'route' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session store — uses PostgreSQL so sessions persist across deploys.
const PgSession = require('connect-pg-simple')(session);
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set in production. Set it in Render env vars.');
  process.exit(1);
}
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET || 'syruvia-dev-secret',
  resave: false,
  saveUninitialized: false,
  name: 'syruvia.sid',
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,                  // not readable by JS — defense against XSS cookie theft
    sameSite: 'lax',                 // CSRF defense for cross-site POSTs
    secure: IS_PROD,                 // require HTTPS in production
  }
}));

// Serve uploaded files (avatars, attachments, voice notes) from UPLOADS_DIR.
// In production UPLOADS_DIR is /data/uploads (outside public/), so this route
// is required for /uploads/<filename> to resolve. Locally it harmlessly mirrors
// public/uploads.
//
// Defense-in-depth: tell the browser never to sniff the type, and force any
// non-image / non-audio file to download as an attachment so a stray HTML or
// SVG file (somehow past the multer filter) can't execute on our origin and
// steal session cookies.
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(filePath).toLowerCase();
    const inlineExts = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.mp3','.wav','.m4a','.ogg','.webm','.mp4','.mov','.pdf']);
    if (!inlineExts.has(ext)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

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
    if (!u || !['Admin','Manager'].includes(u.perm_role)) return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch(e) { next(e); }
}

// Returns true when the current session can read/write the given ticket id.
// Admin and Manager can touch every live ticket; Members can only touch tickets
// they're assigned to (primary or via ticket_assignees) or that they created.
// Soft-deleted tickets (deleted_at IS NOT NULL) are off-limits to everyone via
// this path — recovery goes through the admin dump/restore endpoints.
async function canAccessTicket(req, ticketId) {
  if (!req.session.userId) return false;
  const me = await getUser(req.session.userId);
  if (!me) return false;
  // Confirm the ticket exists and isn't soft-deleted.
  const exists = await get('SELECT id FROM tickets WHERE id=? AND deleted_at IS NULL', ticketId);
  if (!exists) return false;
  if (['Admin','Manager'].includes(me.perm_role)) return true;
  const t = await get(
    `SELECT 1 FROM tickets t
       WHERE t.id = ?
         AND t.deleted_at IS NULL
         AND (t.assignee_user_id = ?
              OR (t.assignee_user_id IS NULL AND t.assignee = ?)
              OR EXISTS (
                   SELECT 1 FROM ticket_assignees ta
                    WHERE ta.ticket_id = t.id
                      AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
                 )
              OR t.created_by = ?)`,
    ticketId, me.id, me.name, me.id, me.name, me.id
  );
  return !!t;
}

// Express middleware version. The ticket id is read from req.params.id (the
// only convention used in this codebase). Returns 404 (not 403) when access
// is denied so the response is indistinguishable from "ticket doesn't exist".
async function requireTicketAccess(req, res, next) {
  try {
    const id = req.params.id;
    if (!await canAccessTicket(req, id)) return res.status(404).json({ error: 'Not found' });
    next();
  } catch(e) { next(e); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await get('SELECT * FROM users WHERE email=?', email.toLowerCase().trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;

    // ── New-device sign-in detection ──────────────────────────────────────
    // Build a coarse device fingerprint from the User-Agent. If we've never
    // seen this UA for this user before AND this isn't their very first
    // login, fire a security-alert email. Always update the known_uas list
    // and the last_login_ip / last_login_at columns.
    try {
      const ua  = req.headers['user-agent'] || '';
      const ip  = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
      const dev = deviceKey(ua);
      let known = [];
      try { known = JSON.parse(user.known_uas || '[]'); } catch {}
      const isFirstLogin = !user.last_login_at;
      const isNewDevice  = !known.includes(dev);
      if (isNewDevice) known.push(dev);
      if (known.length > 12) known = known.slice(-12); // keep recent only

      await run('UPDATE users SET known_uas=?, last_login_ip=?, last_login_at=? WHERE id=?',
        JSON.stringify(known), ip || '', new Date().toISOString(), user.id);

      if (isNewDevice && !isFirstLogin) {
        fireEmail('new-device-login', () => sendNewDeviceLoginEmail({
          toEmail: user.email, toName: user.name,
          ip, device: dev, locationLabel: '',
        }));
      }
    } catch(e) {
      console.error('[login] new-device tracking failed:', e.message);
    }

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
    const info = await run('INSERT INTO users (name,email,password_hash,role,dept,perm_role,welcome_sent) VALUES (?,?,?,?,?,?,1) RETURNING id',
      name.trim(), norm, hash, role, dept, 'Member');
    req.session.userId = Number(info.lastInsertRowid);

    // Welcome email — fire & forget so a mail outage doesn't block sign-up.
    fireEmail('welcome', () => sendWelcomeEmail({ toEmail: norm, toName: name.trim() }));

    res.json({ id:Number(info.lastInsertRowid), name:name.trim(), email:norm, role, dept, permRole:'Member' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Forgot password: takes {email}, generates a reset token, emails the link.
// Always returns {ok:true} — never reveal whether the email exists.
app.post('/api/auth/forgot-password', resetLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await get('SELECT id,name,email FROM users WHERE email=?', email);
    if (user) {
      const token = randomUUID();
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      await run('INSERT INTO password_resets (user_id, token, expires_at, used) VALUES (?,?,?,0)',
        user.id, token, expires);
      const base = process.env.APP_URL || `http://localhost:${PORT}`;
      const resetUrl = `${base}/reset-password.html?token=${token}`;
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
      fireEmail('forgot-password', () => sendForgotPasswordEmail({
        toEmail: user.email, toName: user.name, resetUrl, ip,
      }));
    }
    // Always respond the same way regardless of whether the email matched.
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reset password: takes {token, newPassword}. Validates the token,
// updates the password, and fires a password-changed security alert.
app.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const reset = await get('SELECT * FROM password_resets WHERE token=? AND used=0', token);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link.' });
    if (new Date(reset.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }
    const user = await get('SELECT id,name,email FROM users WHERE id=?', reset.user_id);
    if (!user) return res.status(400).json({ error: 'Account no longer exists.' });
    const hash = bcrypt.hashSync(String(newPassword), 10);
    await run('UPDATE users SET password_hash=? WHERE id=?', hash, user.id);
    await run('UPDATE password_resets SET used=1 WHERE id=?', reset.id);

    const ip  = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const dev = deviceKey(req.headers['user-agent'] || '');
    fireEmail('password-changed', () => sendPasswordChangedEmail({
      toEmail: user.email, toName: user.name, ip, device: dev,
    }));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    // Count open tickets per user_id (preferred) or name (legacy fallback)
    const byId = await all(`SELECT ta.user_id, COUNT(*) as cnt
                              FROM ticket_assignees ta
                              JOIN tickets t ON t.id = ta.ticket_id
                             WHERE t.status != 'Closed' AND t.deleted_at IS NULL AND ta.user_id IS NOT NULL
                             GROUP BY ta.user_id`);
    const byName = await all(`SELECT ta.user_name, COUNT(*) as cnt
                                FROM ticket_assignees ta
                                JOIN tickets t ON t.id = ta.ticket_id
                               WHERE t.status != 'Closed' AND t.deleted_at IS NULL AND ta.user_id IS NULL
                               GROUP BY ta.user_name`);
    const idMap = {}; byId.forEach(r => { idMap[r.user_id] = parseInt(r.cnt, 10); });
    const nameMap = {}; byName.forEach(r => { nameMap[r.user_name] = parseInt(r.cnt, 10); });
    res.json(members.map(m => {
      const c = (idMap[m.id] || 0) + (nameMap[m.name] || 0);
      return {
        id:m.id, name:m.name, email:m.email, role:m.role, dept:m.dept, color:m.color,
        permRole:m.perm_role, avatarUrl:m.avatar_url || '',
        workload: Math.min(100, c * 10), tickets: c
      };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/:id/role', requireAdmin, async (req, res) => {
  try {
    const role = req.body && req.body.permRole;
    if (!['Admin','Manager','Member'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be Admin, Manager, or Member.' });
    }
    await run('UPDATE users SET perm_role=? WHERE id=?', role, req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/:id', requireAuth, async (req, res) => {
  try {
    const me = await get('SELECT perm_role FROM users WHERE id=?', req.session.userId);
    if (!['Admin','Manager'].includes(me?.perm_role)) return res.status(403).json({ error:'Insufficient permissions' });
    if (Number(req.params.id) === Number(req.session.userId)) return res.status(400).json({ error:'Cannot delete your own account' });
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

app.post('/api/invites', requireAdmin, async (req, res) => {
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
    const inviter = await get('SELECT name,email FROM users WHERE id=?', req.session.userId);
    fireEmail('invite', () => sendInviteEmail({
      toEmail: norm, toName: name.trim(),
      inviterName: inviter?.name || 'Your team',
      inviterEmail: inviter?.email || '',
      role, dept, token,
      workspaceName: process.env.APP_NAME || 'Ticket - Brecx',
    }));
    res.json({ ...invite, inviteUrl:`${process.env.APP_URL || `http://localhost:${PORT}`}/invite.html?token=${token}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/invites/:id', requireAdmin, async (req, res) => {
  try {
    await run("UPDATE invites SET status='Cancelled' WHERE id=?", req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Resend a pending invite ──────────────────────────────────────────────────
// Looks up the existing invite (by id OR by email — the front-end only knows
// the email when it renders the pending list), refreshes the expiry, and
// re-sends the workspace-invite email with the same token.
async function resendInviteByLookup(lookup, req) {
  const where = lookup.id ? 'id=?' : 'LOWER(email)=?';
  const arg   = lookup.id ? Number(lookup.id) : String(lookup.email || '').toLowerCase().trim();
  const inv = await get(`SELECT * FROM invites WHERE ${where} AND status='Pending' ORDER BY created_at DESC LIMIT 1`, arg);
  if (!inv) return { ok: false, code: 404, error: 'No pending invite found.' };

  // Refresh expiry so the resent link is good for another 7 days.
  const newExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await run('UPDATE invites SET expires_at=? WHERE id=?', newExpires, inv.id);

  const inviter = await get('SELECT name,email FROM users WHERE id=?', req.session.userId);
  fireEmail('invite-resend', () => sendInviteEmail({
    toEmail: inv.email, toName: inv.name,
    inviterName: inviter?.name || 'Your team',
    inviterEmail: inviter?.email || '',
    role: inv.role, dept: inv.dept, token: inv.token,
    workspaceName: process.env.APP_NAME || 'Ticket - Brecx',
  }));
  const base = process.env.APP_URL || `http://localhost:${PORT}`;
  return { ok: true, inviteUrl: `${base}/invite.html?token=${inv.token}`,
           email: inv.email, name: inv.name };
}

app.post('/api/invites/:id/resend', requireAdmin, async (req, res) => {
  try {
    const r = await resendInviteByLookup({ id: req.params.id }, req);
    if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Convenience for the front-end — it knows the email but not the invite id.
app.post('/api/invites/resend-by-email', requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const r = await resendInviteByLookup({ email }, req);
    if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
    res.json(r);
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
// Look up a user.id from a name string. Names aren't guaranteed unique — when
// they collide we just pick the lowest id, which is the historical default.
async function resolveUserIdByName(name) {
  if (!name) return null;
  const u = await get('SELECT id FROM users WHERE name=? ORDER BY id ASC LIMIT 1', name);
  return u ? u.id : null;
}

// Derive the *current* display name for a user.id (so a profile rename
// reflects everywhere automatically). Falls back to the stored name string
// when no user_id is set (legacy data) or when the user was deleted.
async function nameForUserId(userId, fallback) {
  if (!userId) return fallback || '';
  const u = await get('SELECT name FROM users WHERE id=?', userId);
  return u ? u.name : (fallback || '');
}

async function buildTicket(row) {
  if (!row) return null;
  // Pull all assignees with both user_id and stored user_name; prefer the
  // current user.name when user_id resolves.
  const assigneeRows = await all(
    `SELECT ta.user_name, u.name AS current_name
       FROM ticket_assignees ta
       LEFT JOIN users u ON u.id = ta.user_id
      WHERE ta.ticket_id=?`, row.id
  );
  const assignees = assigneeRows.map(a => a.current_name || a.user_name);
  const liveAssignee = await nameForUserId(row.assignee_user_id, row.assignee);
  const liveReporter = await nameForUserId(row.reporter_user_id, row.reporter);
  const liveReq      = await nameForUserId(row.req_user_id, row.req);
  // Count of child tickets (only meaningful when is_project = 1, but cheap
  // either way). Used by the projects page + the project badge on the list.
  const childRow = await get(
    'SELECT COUNT(*)::int AS n FROM tickets WHERE parent_ticket_id = ? AND deleted_at IS NULL',
    row.id
  );
  return {
    ...row,
    tags: JSON.parse(row.tags_json || '[]'),
    assignee: liveAssignee,
    reporter: liveReporter,
    req:      liveReq,
    assignees,
    overdue: !!row.overdue,
    comments: row.comments_count,
    parentTicketId: row.parent_ticket_id || null,
    isProject: !!row.is_project,
    childCount: parseInt(childRow?.n || 0, 10),
    closeReason: row.close_reason || '',
  };
}

app.get('/api/tickets', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    const isAdmin = u && ['Admin','Manager'].includes(u.perm_role);
    let rows;
    if (isAdmin) {
      rows = await all('SELECT * FROM tickets WHERE deleted_at IS NULL ORDER BY id DESC');
    } else {
      // Members see tickets they are assigned to (primary or via ticket_assignees)
      // OR tickets they created. Match by user_id first (renames don't break
      // anything) and fall back to name match for any legacy rows that
      // never got a user_id back-filled.
      rows = await all(
        `SELECT t.* FROM tickets t
           WHERE t.deleted_at IS NULL
             AND (t.assignee_user_id = ?
                  OR (t.assignee_user_id IS NULL AND t.assignee = ?)
                  OR EXISTS (
                       SELECT 1 FROM ticket_assignees ta
                        WHERE ta.ticket_id = t.id
                          AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
                     )
                  OR t.created_by = ?)
           ORDER BY t.id DESC`,
        u.id, u.name, u.id, u.name, u.id
      );
    }
    res.json(await Promise.all(rows.map(buildTicket)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Projects (admin-promoted parent tickets) ────────────────────────────────
// Promote / demote are admin-only. The list and children endpoints are open to
// any authenticated user (filtered by ticket access where needed).
app.post('/api/tickets/:id/promote', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const t = await get('SELECT id, parent_ticket_id, deleted_at FROM tickets WHERE id=?', id);
    if (!t || t.deleted_at) return res.status(404).json({ error: 'Not found' });
    if (t.parent_ticket_id) return res.status(400).json({ error: 'Cannot promote a sub-ticket — it already belongs to a project' });
    await run('UPDATE tickets SET is_project=1 WHERE id=?', id);
    console.log(`[projects] PROMOTE ${id} by user ${req.session.userId} at ${new Date().toISOString()}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/demote', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const t = await get('SELECT id, deleted_at FROM tickets WHERE id=?', id);
    if (!t || t.deleted_at) return res.status(404).json({ error: 'Not found' });
    // Release any children — they become regular tickets again.
    await run('UPDATE tickets SET parent_ticket_id=NULL WHERE parent_ticket_id=?', id);
    await run('UPDATE tickets SET is_project=0 WHERE id=?', id);
    console.log(`[projects] DEMOTE ${id} by user ${req.session.userId} at ${new Date().toISOString()}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List of projects (parent tickets only) with their child counts. Admin-only —
// non-admins don't have a Projects view, but their My Tickets shows the
// individual sub-tickets they're assigned to.
app.get('/api/projects', requireAdmin, async (req, res) => {
  try {
    const rows = await all(`
      SELECT t.*,
             (SELECT COUNT(*) FROM tickets c WHERE c.parent_ticket_id = t.id AND c.deleted_at IS NULL)::int AS child_count
        FROM tickets t
       WHERE t.is_project = 1 AND t.deleted_at IS NULL
       ORDER BY t.id DESC`);
    const out = await Promise.all(rows.map(buildTicket));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Children of a given project ticket. Authenticated, but the access middleware
// gates non-admins by per-ticket access — a worker can only see children
// they're assigned to (which they'd already see in My Tickets anyway).
app.get('/api/tickets/:id/children', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    const isAdmin = u && ['Admin','Manager'].includes(u.perm_role);
    let rows;
    if (isAdmin) {
      rows = await all('SELECT * FROM tickets WHERE parent_ticket_id=? AND deleted_at IS NULL ORDER BY id ASC', req.params.id);
    } else {
      // Same access pattern as the main /api/tickets list — restrict to
      // children the user is associated with.
      rows = await all(
        `SELECT t.* FROM tickets t
           WHERE t.parent_ticket_id = ?
             AND t.deleted_at IS NULL
             AND (t.assignee_user_id = ?
                  OR (t.assignee_user_id IS NULL AND t.assignee = ?)
                  OR EXISTS (SELECT 1 FROM ticket_assignees ta WHERE ta.ticket_id = t.id AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?)))
                  OR t.created_by = ?)
           ORDER BY t.id ASC`,
        req.params.id, u.id, u.name, u.id, u.name, u.id
      );
    }
    res.json(await Promise.all(rows.map(buildTicket)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id', requireAuth, requireTicketAccess, async (req, res) => {
  // Block reads of soft-deleted tickets — even admins shouldn't see them
  // through this path; use /api/admin/tickets/dump for forensics.
  try {
    const row = await get('SELECT * FROM tickets WHERE id=? AND deleted_at IS NULL', req.params.id);
    if (!row) return res.status(404).json({ error:'Not found' });
    res.json(await buildTicket(row));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets', requireAuth, async (req, res) => {
  try {
    const { id: clientId, title, req:reqName, assignee, assignees, reporter, priority, status, dept, due, created, overdue, tags, checklist, parentTicketId } = req.body;
    if (!title) return res.status(400).json({ error:'title required' });
    // Validate parent (if creating a sub-ticket): must exist, not be soft-
    // deleted, must itself be a project, and must NOT itself have a parent
    // (single-level hierarchy only).
    let resolvedParent = null;
    if (parentTicketId) {
      const parent = await get(
        'SELECT id, parent_ticket_id, is_project FROM tickets WHERE id=? AND deleted_at IS NULL',
        String(parentTicketId)
      );
      if (!parent) return res.status(400).json({ error: 'Parent project not found' });
      if (parent.parent_ticket_id) return res.status(400).json({ error: 'Cannot nest sub-tickets under another sub-ticket' });
      if (!parent.is_project) return res.status(400).json({ error: 'Parent must be promoted to a project first' });
      resolvedParent = parent.id;
    }
    // Server-authoritative ID. Pick max(existing TKT-### number) + 1, with a tiny retry
    // loop in case of a concurrent insert. Eliminates the client-side ID-collision race.
    let id = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const maxRow = await get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
      let nextNum = 1000;
      if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }
      const candidate = 'TKT-' + (nextNum + 1);
      if (!await get('SELECT id FROM tickets WHERE id=?', candidate)) { id = candidate; break; }
    }
    if (!id) return res.status(500).json({ error: 'Could not allocate a unique ticket id — please retry.' });
    console.log(`[tickets] INSERT ${id} "${String(title).slice(0,80)}" by user ${req.session.userId} (clientHint=${clientId||'-'}) at ${new Date().toISOString()}`);
    // Resolve names → user.id so renames don't break links later
    const assigneeUid = await resolveUserIdByName(assignee);
    const reporterUid = await resolveUserIdByName(reporter);
    const reqUid      = await resolveUserIdByName(reqName);
    await run(`INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id,parent_ticket_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
      id, title, reqName||'', assignee||'', reporter||'', priority||'Medium', status||'Open',
      dept||'Engineering', due||'', created||'', overdue?1:0, JSON.stringify(tags||[]), req.session.userId,
      assigneeUid, reporterUid, reqUid, resolvedParent);
    // Persist the description from the create modal. Audit had this as
    // outstanding: req.body.description was being read for the email but
    // never written, so descriptions silently disappeared on every create.
    const _newDesc = String(req.body?.description || '').trim();
    await run(
      `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
         ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
      id, _newDesc
    );
    for (const a of (assignees||[])) {
      const uid = await resolveUserIdByName(a);
      await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', id, a, uid);
    }
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
      const target = await get('SELECT id,name,email FROM users WHERE name=?', a);
      if (target && target.id !== req.session.userId) {
        await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
          target.id, 'assigned', '👤', `${creator?.name || 'Someone'} assigned you to "${title}"`, id);
        // Email the new assignee.
        fireEmail('ticket-assigned', () => sendTicketAssignedEmail({
          toEmail: target.email, toName: target.name,
          assignerName: creator?.name || 'Someone',
          ticketId: id, title,
          priority: priority || 'Medium',
          dueAt: due || '',
          status: status || 'Open',
          dept: dept || '',
          requester: reporter || '',
          description: req.body?.description || reqName || '',
          tags: tags || [],
        }));
        // Push notification on the assignee's installed PWA / browser.
        sendPushToUser(target.id, {
          title: 'New ticket: ' + (title || id),
          body: `${creator?.name || 'Someone'} assigned this to you`,
          tag: 'ticket-' + id,
          url: '/tickets/' + id,
        }).catch(()=>{});
      }
    }
    res.status(201).json(await buildTicket(await get('SELECT * FROM tickets WHERE id=?', id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tickets/:id', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const { title, req:reqName, assignee, assignees, reporter, priority, status, dept, due, overdue, tags, closeReason } = req.body;
    const exists = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
    if (!exists) return res.status(404).json({ error:'Not found' });
    if (exists.deleted_at) return res.status(404).json({ error:'Not found' });
    console.log(`[tickets] UPDATE ${req.params.id} by user ${req.session.userId} fields=${Object.keys(req.body||{}).join(',')}`);

    // Snapshot before-state for email diffing
    const oldStatus = exists.status;
    const oldAssigneesAll = (await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', req.params.id)).map(a => a.user_name);

    const u=[]; const v=[];
    if (title!==undefined)    { u.push('title=?');      v.push(title); }
    if (reqName!==undefined)  { u.push('req=?');        v.push(reqName);
                                u.push('req_user_id=?');     v.push(await resolveUserIdByName(reqName)); }
    if (assignee!==undefined) { u.push('assignee=?');   v.push(assignee);
                                u.push('assignee_user_id=?'); v.push(await resolveUserIdByName(assignee)); }
    if (reporter!==undefined) { u.push('reporter=?');   v.push(reporter);
                                u.push('reporter_user_id=?'); v.push(await resolveUserIdByName(reporter)); }
    if (priority!==undefined) { u.push('priority=?');   v.push(priority); }
    if (status!==undefined)   { u.push('status=?');     v.push(status); }
    if (dept!==undefined)     { u.push('dept=?');       v.push(dept); }
    if (due!==undefined)      { u.push('due=?');        v.push(due); }
    if (overdue!==undefined)  { u.push('overdue=?');    v.push(overdue?1:0); }
    if (tags!==undefined)     { u.push('tags_json=?');  v.push(JSON.stringify(tags)); }
    // Persist the optional close-reason note. Only saved when the caller
    // explicitly provided one (undefined = "don't touch this column"); a
    // blank string clears any previous reason (e.g. on reopen).
    if (closeReason !== undefined) {
      u.push('close_reason=?');
      v.push(String(closeReason || '').trim() || null);
    }
    // If status flipped to a non-Closed value (reopen / move back to Open),
    // wipe any stale close_reason so the next display doesn't lie.
    if (status !== undefined && oldStatus === 'Closed' && status !== 'Closed' && closeReason === undefined) {
      u.push('close_reason=?'); v.push(null);
    }
    if (u.length) { v.push(req.params.id); await run(`UPDATE tickets SET ${u.join(',')} WHERE id=?`, ...v); }
    if (assignees!==undefined) {
      await run('DELETE FROM ticket_assignees WHERE ticket_id=?', req.params.id);
      for (const a of assignees) {
        const uid = await resolveUserIdByName(a);
        await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', req.params.id, a, uid);
      }
      const newAssignees = assignees.filter(a => !oldAssigneesAll.includes(a));
      if (newAssignees.length) {
        const assigner = await getUser(req.session.userId);
        const tkt = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
        for (const name of newAssignees) {
          const target = await get('SELECT id,name,email FROM users WHERE name=?', name);
          if (target && target.id !== req.session.userId) {
            await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
              target.id, 'assigned', '👤', `${assigner?.name || 'Someone'} assigned you to "${tkt?.title || req.params.id}"`, req.params.id);
            fireEmail('ticket-assigned', () => sendTicketAssignedEmail({
              toEmail: target.email, toName: target.name,
              assignerName: assigner?.name || 'Someone',
              ticketId: req.params.id, title: tkt?.title || '',
              priority: tkt?.priority || 'Medium',
              dueAt: tkt?.due || '',
              status: tkt?.status || 'Open',
              dept: tkt?.dept || '',
              requester: tkt?.reporter || '',
              description: tkt?.req || '',
              tags: (() => { try { return JSON.parse(tkt?.tags_json || '[]'); } catch { return []; } })(),
            }));
          }
        }
      }
    }

    // ── Status change emails (status-changed, plus ticket-closed when applicable) ──
    if (status !== undefined && oldStatus && oldStatus !== status) {
      const updated  = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
      const changer  = await getUser(req.session.userId);
      const currentAssignees = (await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', req.params.id)).map(a => a.user_name);
      // Notify everyone tied to the ticket: assignees + reporter, minus the actor.
      const recipientNames = new Set([...currentAssignees, updated.reporter].filter(Boolean));
      recipientNames.delete(changer?.name);
      for (const name of recipientNames) {
        const target = await emailForName(name);
        if (!target?.email) continue;
        fireEmail('status-changed', () => sendTicketStatusChangedEmail({
          toEmail: target.email, toName: target.name,
          changedByName: changer?.name || 'Someone',
          ticketId: req.params.id, title: updated.title || '',
          fromStatus: oldStatus, toStatus: status,
        }));
      }
      // If newly closed, also fire the ticket-closed email (idempotent flag).
      if (String(status).toLowerCase() === 'closed' && !exists.closed_email_sent) {
        await run('UPDATE tickets SET closed_email_sent=1 WHERE id=?', req.params.id);
        const createdAt = updated.created_at ? new Date(updated.created_at) : null;
        const daysOpen  = createdAt && !isNaN(createdAt) ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86400000)) : null;
        for (const name of recipientNames) {
          const target = await emailForName(name);
          if (!target?.email) continue;
          fireEmail('ticket-closed', () => sendTicketClosedEmail({
            toEmail: target.email, toName: target.name,
            closerName: changer?.name || 'Someone',
            ticketId: req.params.id, title: updated.title || '',
            resolution: updated.req || '',
            resolvedAt: new Date(),
            daysOpen,
            commentsCount: updated.comments_count || 0,
          }));
        }
      }
    }

    res.json(await buildTicket(await get('SELECT * FROM tickets WHERE id=?', req.params.id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets/:id', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    const id = req.params.id;
    // If this is a project, cascade the soft-delete to every still-live
    // sub-ticket so they don't end up orphaned (visible-but-detached).
    // Same timestamp on parent + children so an admin can identify a
    // matching restore set later.
    const parent = await get('SELECT id, is_project FROM tickets WHERE id=?', id);
    const isProject = !!(parent && parent.is_project);
    let cascadeCount = 0;
    if (isProject) {
      const children = await all(
        'SELECT id FROM tickets WHERE parent_ticket_id=? AND deleted_at IS NULL',
        id
      );
      cascadeCount = children.length;
      if (cascadeCount > 0) {
        await run(
          "UPDATE tickets SET deleted_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE parent_ticket_id=? AND deleted_at IS NULL",
          id
        );
        for (const c of children) {
          console.log(`[tickets] SOFT-DELETE ${c.id} (cascade from project ${id}) by user ${req.session.userId} (${u?.name}) at ${new Date().toISOString()}`);
        }
      }
    }
    console.log(`[tickets] SOFT-DELETE ${id} by user ${req.session.userId} (${u?.name})${isProject ? ' [project, cascaded ' + cascadeCount + ' sub-tickets]' : ''} at ${new Date().toISOString()}`);
    // Soft delete: keep the row, just mark it. Admin can restore via /api/admin/tickets/restore/:id.
    await run("UPDATE tickets SET deleted_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?", id);
    res.json({ ok: true, cascadedSubtickets: cascadeCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ticket reminders ────────────────────────────────────────────────────────
// Per-user self-reminders attached to a ticket. The reminder fires (email)
// at remind_at to the user who set it. Multiple users can have reminders on
// the same ticket; each user only sees their own. Stored in UTC; the cron
// loop further down compares against TO_CHAR(NOW()) text for simplicity.
app.get('/api/tickets/:id/reminders', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM ticket_reminders
        WHERE ticket_id=? AND user_id=?
        ORDER BY remind_at ASC, id ASC`,
      req.params.id, req.session.userId
    );
    res.json(rows.map(r => ({
      id: r.id, ticketId: r.ticket_id, remindAt: r.remind_at,
      note: r.note || '', sent: !!r.sent, sentAt: r.sent_at, createdAt: r.created_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/reminders', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const { remindAt, note } = req.body || {};
    if (!remindAt) return res.status(400).json({ error: 'remindAt required (YYYY-MM-DD or ISO datetime)' });
    // Normalize the input to a "YYYY-MM-DD HH:MM:SS" UTC string so the cron
    // loop can compare with TO_CHAR(NOW()) directly. Accept date-only
    // (treated as 9:00 local-of-server / 9:00 UTC) and full ISO datetime.
    let storedAt;
    try {
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(remindAt));
      const d = isDateOnly ? new Date(remindAt + 'T09:00:00Z') : new Date(remindAt);
      if (isNaN(d)) throw new Error('parse failed');
      const pad = n => String(n).padStart(2, '0');
      storedAt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    } catch {
      return res.status(400).json({ error: 'Invalid remindAt — use YYYY-MM-DD or ISO datetime' });
    }
    const info = await run(
      `INSERT INTO ticket_reminders (ticket_id, user_id, remind_at, note) VALUES (?,?,?,?) RETURNING id`,
      req.params.id, req.session.userId, storedAt, String(note || '').slice(0, 500)
    );
    res.status(201).json({ id: Number(info.lastInsertRowid), ticketId: req.params.id, remindAt: storedAt, note: note || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/reminders/:id', requireAuth, async (req, res) => {
  try {
    // Only the user who set the reminder can delete it.
    await run('DELETE FROM ticket_reminders WHERE id=? AND user_id=?', Number(req.params.id), req.session.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/details', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const row = await get('SELECT * FROM ticket_details WHERE ticket_id=?', req.params.id);
    if (!row) return res.json({ description:'', checklist:[] });
    res.json({ description:row.description, checklist:JSON.parse(row.checklist_json||'[]') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tickets/:id/details', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const { description, checklist } = req.body;
    await run(`INSERT INTO ticket_details (ticket_id,description,checklist_json) VALUES (?,?,?)
         ON CONFLICT(ticket_id) DO UPDATE SET description=EXCLUDED.description,checklist_json=EXCLUDED.checklist_json`,
      req.params.id, description||'', JSON.stringify(checklist||[]));
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/comments', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    // Derive the live author name from users.name when author_user_id is set,
    // so a profile rename retroactively updates how every comment appears.
    const rows = await all(`
      SELECT tc.*, u.name AS author_name_now
        FROM ticket_comments tc
        LEFT JOIN users u ON u.id = tc.author_user_id
       WHERE tc.ticket_id=?
       ORDER BY tc.created_at ASC`, req.params.id);
    res.json(rows.map(r => ({
      id:r.id, parentId: r.parent_id || null,
      author: r.author_name_now || r.author,
      init: r.author_init, bg: r.author_bg, col: r.author_col,
      text: r.text, time: timeAgo(r.created_at)
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/comments', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const { text, parentId } = req.body;
    if (!text?.trim()) return res.status(400).json({ error:'Text required' });
    const u = await getUser(req.session.userId);
    const init = u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const palette = ['#ede9fe|#5b21b6','#dde4ff|#3730a3','#dcfce7|#166534','#fef9c3|#854d0e'];
    const [bg,col] = (palette[u.id % palette.length]||palette[0]).split('|');
    // Validate parentId belongs to this ticket
    let safeParentId = null;
    if (parentId) {
      const parent = await get('SELECT id FROM ticket_comments WHERE id=? AND ticket_id=?', Number(parentId), req.params.id);
      if (parent) safeParentId = parent.id;
    }
    const info = await run(`INSERT INTO ticket_comments (ticket_id,author,author_user_id,author_init,author_bg,author_col,text,parent_id) VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
      req.params.id, u.name, u.id, init, bg, col, text.trim(), safeParentId);
    await run('UPDATE tickets SET comments_count=comments_count+1 WHERE id=?', req.params.id);
    const tkt = await get('SELECT * FROM tickets WHERE id=?', req.params.id);

    // Track who's been emailed about this comment so we don't double-send
    // (e.g. someone is both an assignee and got mentioned).
    const emailedUserIds = new Set([req.session.userId]);

    // ── @-mentions: mention email + in-app notification ───────────────────
    const mentions = (text.match(/@([A-Za-z]+(?: [A-Za-z]+)*)/g) || []).map(m => m.slice(1));
    for (const name of mentions) {
      const mentioned = await get('SELECT id,name,email,role,dept FROM users WHERE name=?', name);
      if (mentioned && !emailedUserIds.has(mentioned.id)) {
        emailedUserIds.add(mentioned.id);
        await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
          mentioned.id, 'mention', '💬', `${u.name} mentioned you in "${tkt?.title || req.params.id}"`, req.params.id);
        fireEmail('mention', () => sendMentionEmail({
          toEmail: mentioned.email, toName: mentioned.name,
          authorName: u.name, authorRole: u.role || '', authorDept: u.dept || '',
          ticketId: req.params.id, title: tkt?.title || '',
          commentText: text.trim(),
        }));
        sendPushToUser(mentioned.id, {
          title: `${u.name} mentioned you`,
          body: text.trim().slice(0, 140),
          tag: 'ticket-' + req.params.id + '-cmt',
          url: '/tickets/' + req.params.id,
        }).catch(()=>{});
      }
    }

    // ── Reply-to-parent notification + email ──────────────────────────────
    if (safeParentId) {
      // Prefer author_user_id (stable across renames); fall back to author name
      // for legacy rows where the id wasn't backfilled.
      const parentInfo = await get(
        `SELECT u.id AS user_id, u.name AS name, u.email AS email, u.role AS role
           FROM ticket_comments tc
           JOIN users u ON u.id = COALESCE(tc.author_user_id,
                                           (SELECT id FROM users WHERE name = tc.author ORDER BY id ASC LIMIT 1))
          WHERE tc.id = ?`, safeParentId);
      if (parentInfo && !emailedUserIds.has(parentInfo.user_id)) {
        emailedUserIds.add(parentInfo.user_id);
        await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
          parentInfo.user_id, 'comment', '↩', `${u.name} replied to your comment on "${tkt?.title || req.params.id}"`, req.params.id);
        fireEmail('comment-reply', () => sendNewCommentEmail({
          toEmail: parentInfo.email, toName: parentInfo.name,
          authorName: u.name, authorRole: u.role || '',
          authorBg: bg, authorFg: col,
          ticketId: req.params.id, title: tkt?.title || '',
          commentText: text.trim(),
        }));
        sendPushToUser(parentInfo.user_id, {
          title: `${u.name} replied`,
          body: text.trim().slice(0, 140),
          tag: 'ticket-' + req.params.id + '-cmt',
          url: '/tickets/' + req.params.id,
        }).catch(()=>{});
      }
    }

    // ── New-comment email to all assignees + reporter (excluding actor / already-emailed) ──
    const watchers = new Set();
    const assigneesRows = await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', req.params.id);
    assigneesRows.forEach(r => r.user_name && watchers.add(r.user_name));
    if (tkt?.reporter) watchers.add(tkt.reporter);
    for (const wname of watchers) {
      const w = await get('SELECT id,name,email FROM users WHERE name=?', wname);
      if (!w || emailedUserIds.has(w.id)) continue;
      emailedUserIds.add(w.id);
      fireEmail('new-comment', () => sendNewCommentEmail({
        toEmail: w.email, toName: w.name,
        authorName: u.name, authorRole: u.role || '',
        authorBg: bg, authorFg: col,
        ticketId: req.params.id, title: tkt?.title || '',
        commentText: text.trim(),
      }));
      sendPushToUser(w.id, {
        title: `${u.name} commented on ${tkt?.title || req.params.id}`,
        body: text.trim().slice(0, 140),
        tag: 'ticket-' + req.params.id + '-cmt',
        url: '/tickets/' + req.params.id,
      }).catch(()=>{});
    }

    res.status(201).json({ id:Number(info.lastInsertRowid), parentId: safeParentId, author:u.name, init, bg, col, text:text.trim(), time: formatUSDateTime(new Date().toISOString()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets/:id/comments/:commentId', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const comment = await get('SELECT id FROM ticket_comments WHERE id=? AND ticket_id=?', req.params.commentId, req.params.id);
    if (!comment) return res.status(404).json({ error:'Comment not found' });
    await run('DELETE FROM ticket_comments WHERE id=?', req.params.commentId);
    await run('UPDATE tickets SET comments_count=GREATEST(0,comments_count-1) WHERE id=?', req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/timeline', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM ticket_timelines WHERE ticket_id=? ORDER BY created_at DESC', req.params.id);
    if (!rows.length) {
      const t = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
      if (t) return res.json([{ dot:'var(--green)', text:'Ticket created', sub: formatUSDateTime(t.created_at) || t.created }]);
    }
    res.json(rows.map(r=>({ id:r.id, dot:r.dot, text:r.text, sub: formatUSDateTime(r.created_at) || r.sub })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/timeline', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const { dot, text, sub } = req.body;
    await run('INSERT INTO ticket_timelines (ticket_id,dot,text,sub) VALUES (?,?,?,?)', req.params.id, dot||'var(--accent)', text, sub||'Just now');
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Push (PWA) subscribe / unsubscribe ──────────────────────────────────────
// Public key is safe to expose — it only authorizes the *server* to send
// pushes to subscriptions issued for it.
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY, enabled: !!pushReady });
});

// Browser sends its PushSubscription.toJSON() here once it's been created.
// Same endpoint upserts (on conflict update keys + ownership) so a
// re-permission-grant just refreshes existing rows.
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const sub = req.body || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String(sub.keys?.p256dh || '');
    const auth = String(sub.keys?.auth || '');
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Invalid subscription' });
    const ua = String(req.headers['user-agent'] || '').slice(0, 255);
    await run(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
         VALUES (?,?,?,?,?)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               p256dh = EXCLUDED.p256dh,
               auth = EXCLUDED.auth,
               user_agent = EXCLUDED.user_agent`,
      req.session.userId, endpoint, p256dh, auth, ua
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Caller posts the same endpoint string they got from PushSubscription so
// we can drop just that one device.
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || '');
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?', endpoint, req.session.userId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Self-test — sends a push to the caller's own subscriptions. Surfaces
// real send count + any pruned-stale subs so the Settings page can show
// "delivered to N device(s)".
app.post('/api/push/test', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    const r = await sendPushToUser(req.session.userId, {
      title: 'Syruvia push test',
      body: `Hi ${u?.name || 'there'} — push notifications are working.`,
      tag: 'push-self-test',
      url: '/dashboard',
    });
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Announcements ────────────────────────────────────────────────────────────
// Helper: should the current user see admin-only announcements? Members
// don't; Admins and Managers do. Used to filter the popup / feed / unread.
async function _viewerSeesAdminOnlyAnnouncements(req) {
  const u = await getUser(req.session.userId);
  return !!(u && ['Admin', 'Manager'].includes(u.perm_role));
}

// Active, unacknowledged announcements for the current user.
app.get('/api/announcements/active', requireAuth, async (req, res) => {
  try {
    const seesAdminOnly = await _viewerSeesAdminOnlyAnnouncements(req);
    const audienceClause = seesAdminOnly ? '' : ' AND COALESCE(a.admin_only,0) = 0 ';
    const rows = await all(
      `SELECT a.* FROM announcements a
        WHERE a.active = 1
          ${audienceClause}
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

// What's New feed — every active announcement, attachments inlined, visible
// to any authenticated user. Replaces the popup ack flow for users who'd
// rather browse the timeline.
app.get('/api/announcements/feed', requireAuth, async (req, res) => {
  try {
    const seesAdminOnly = await _viewerSeesAdminOnlyAnnouncements(req);
    const audienceClause = seesAdminOnly ? '' : ' AND COALESCE(a.admin_only,0) = 0 ';
    const rows = await all(
      `SELECT a.*, u.name AS author_name, u.avatar_url AS author_avatar
         FROM announcements a
         LEFT JOIN users u ON u.id = a.created_by
        WHERE a.active = 1 ${audienceClause}
        ORDER BY a.created_at DESC, a.id DESC`);
    const ids = rows.map(r => r.id);
    let attMap = {};
    if (ids.length) {
      const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
      const atts = await all(
        `SELECT * FROM attachments WHERE announcement_id IN (${placeholders}) ORDER BY created_at ASC`,
        ...ids
      );
      attMap = atts.reduce((m, a) => {
        (m[a.announcement_id] ||= []).push({
          id: a.id, filename: a.filename, originalName: a.original_name,
          mimeType: a.mime_type, size: a.size, url: `/uploads/${a.filename}`,
          createdAt: a.created_at,
        });
        return m;
      }, {});
    }
    res.json(rows.map(r => ({
      id: r.id, kind: r.kind || 'update',
      title: r.title || '', body: r.body || '',
      requireAck: !!r.require_ack, active: !!r.active,
      adminOnly: !!r.admin_only,
      createdAt: r.created_at,
      author: { name: r.author_name || '', avatarUrl: r.author_avatar || '' },
      attachments: attMap[r.id] || [],
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sidebar badge — count of active announcements newer than the user's
// last-seen high-water mark. O(1) thanks to the indexed id comparison.
app.get('/api/announcements/unread-count', requireAuth, async (req, res) => {
  try {
    const u = await get('SELECT last_announcement_id_seen FROM users WHERE id=?', req.session.userId);
    const lastSeen = parseInt(u?.last_announcement_id_seen || 0, 10);
    const seesAdminOnly = await _viewerSeesAdminOnlyAnnouncements(req);
    const audienceClause = seesAdminOnly ? '' : ' AND COALESCE(admin_only,0) = 0 ';
    const row = await get(
      `SELECT COUNT(*)::int AS n FROM announcements WHERE active = 1 AND id > ? ${audienceClause}`,
      lastSeen
    );
    res.json({ count: row?.n || 0, lastSeenId: lastSeen });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mark all current active announcements as seen for this user. Called
// when the user opens the What's New page (or clicks "View announcement"
// in the popup) — clears the sidebar badge. Uses the same audience filter
// as the feed so a Member's high-water mark only advances over things
// they could actually see.
app.post('/api/announcements/mark-all-seen', requireAuth, async (req, res) => {
  try {
    const seesAdminOnly = await _viewerSeesAdminOnlyAnnouncements(req);
    const audienceClause = seesAdminOnly ? '' : ' AND COALESCE(admin_only,0) = 0 ';
    const row = await get(`SELECT COALESCE(MAX(id),0) AS max_id FROM announcements WHERE 1=1 ${audienceClause}`);
    const maxId = parseInt(row?.max_id || 0, 10);
    await run('UPDATE users SET last_announcement_id_seen=? WHERE id=? AND COALESCE(last_announcement_id_seen,0) < ?',
      maxId, req.session.userId, maxId);
    res.json({ ok: true, lastSeenId: maxId });
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
      id: r.id, kind: r.kind || 'update',
      title: r.title || '', body: r.body || '',
      requireAck: !!r.require_ack, active: !!r.active,
      adminOnly: !!r.admin_only,
      createdAt: r.created_at, ackCount: parseInt(r.ack_count || 0, 10)
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/announcements', requireAdmin, async (req, res) => {
  try {
    const { title, body, requireAck, kind, adminOnly } = req.body || {};
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t && !b) return res.status(400).json({ error: 'Title or body required' });
    const k = ['feature','bugfix','update','note'].includes(String(kind || '').toLowerCase())
      ? String(kind).toLowerCase()
      : 'update';
    const info = await run(
      `INSERT INTO announcements (title, body, require_ack, active, created_by, kind, admin_only) VALUES (?,?,?,1,?,?,?) RETURNING id`,
      t, b, requireAck ? 1 : 0, req.session.userId, k, adminOnly ? 1 : 0
    );
    const row = await get('SELECT * FROM announcements WHERE id=?', Number(info.lastInsertRowid));
    res.status(201).json({
      id: row.id, title: row.title || '', body: row.body || '', kind: row.kind || 'update',
      requireAck: !!row.require_ack, active: !!row.active,
      adminOnly: !!row.admin_only,
      createdAt: row.created_at, ackCount: 0
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const { title, body, requireAck, active, resetSeen, kind, adminOnly } = req.body || {};
    const u = []; const v = [];
    if (title !== undefined)      { u.push('title=?');       v.push(String(title || '').trim()); }
    if (body !== undefined)       { u.push('body=?');        v.push(String(body || '').trim()); }
    if (requireAck !== undefined) { u.push('require_ack=?'); v.push(requireAck ? 1 : 0); }
    if (active !== undefined)     { u.push('active=?');      v.push(active ? 1 : 0); }
    if (adminOnly !== undefined)  { u.push('admin_only=?');  v.push(adminOnly ? 1 : 0); }
    if (kind !== undefined && ['feature','bugfix','update','note'].includes(String(kind).toLowerCase())) {
      u.push('kind=?'); v.push(String(kind).toLowerCase());
    }
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

// ── Feedback (feature requests + bug reports + add-on requests) ──────────────
// Anyone authenticated can list / create / comment. Admins can update status
// and delete. These are intentionally segregated from tickets — they never
// appear in the tickets list, dashboard, calendar, or stats.
const FEEDBACK_KINDS = new Set(['feature', 'bug', 'addon']);
const FEEDBACK_STATUSES = new Set(['open', 'planned', 'in_progress', 'done', 'dismissed']);

function shapeFeedback(r, attachments = [], comments = []) {
  return {
    id: r.id,
    kind: r.kind || 'feature',
    title: r.title || '',
    description: r.description || '',
    status: r.status || 'open',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: {
      id: r.created_by_user_id || null,
      name: r.author_name || '',
      avatarUrl: r.author_avatar || '',
    },
    attachments,
    comments,
  };
}

app.get('/api/feedback', requireAuth, async (req, res) => {
  try {
    const rows = await all(`
      SELECT f.*, u.name AS author_name, u.avatar_url AS author_avatar,
             (SELECT COUNT(*) FROM feedback_comments c WHERE c.feedback_id = f.id) AS comment_count
        FROM feedback_items f
        LEFT JOIN users u ON u.id = f.created_by_user_id
       ORDER BY f.created_at DESC, f.id DESC`);
    const ids = rows.map(r => r.id);
    let attMap = {};
    if (ids.length) {
      const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
      const atts = await all(
        `SELECT * FROM attachments WHERE feedback_id IN (${placeholders}) ORDER BY created_at ASC`,
        ...ids
      );
      attMap = atts.reduce((m, a) => {
        (m[a.feedback_id] ||= []).push({
          id: a.id, filename: a.filename, originalName: a.original_name,
          mimeType: a.mime_type, size: a.size, url: `/uploads/${a.filename}`,
          createdAt: a.created_at,
        });
        return m;
      }, {});
    }
    res.json(rows.map(r => ({
      ...shapeFeedback(r, attMap[r.id] || []),
      commentCount: parseInt(r.comment_count || 0, 10),
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/feedback', requireAuth, async (req, res) => {
  try {
    const { kind, title, description } = req.body || {};
    const k = FEEDBACK_KINDS.has(String(kind || '').toLowerCase())
      ? String(kind).toLowerCase() : 'feature';
    const t = String(title || '').trim();
    const d = String(description || '').trim();
    if (!t && !d) return res.status(400).json({ error: 'Title or description required' });
    const info = await run(
      `INSERT INTO feedback_items (kind, title, description, status, created_by_user_id)
        VALUES (?,?,?,?,?) RETURNING id`,
      k, t.slice(0, 200), d, 'open', req.session.userId
    );
    const row = await get(
      `SELECT f.*, u.name AS author_name, u.avatar_url AS author_avatar
         FROM feedback_items f
         LEFT JOIN users u ON u.id = f.created_by_user_id
        WHERE f.id = ?`,
      Number(info.lastInsertRowid)
    );
    res.status(201).json(shapeFeedback(row, [], []));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/feedback/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get(
      `SELECT f.*, u.name AS author_name, u.avatar_url AS author_avatar
         FROM feedback_items f
         LEFT JOIN users u ON u.id = f.created_by_user_id
        WHERE f.id = ?`,
      id
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    const attachments = (await all(
      `SELECT * FROM attachments WHERE feedback_id = ? ORDER BY created_at ASC`,
      id
    )).map(a => ({
      id: a.id, filename: a.filename, originalName: a.original_name,
      mimeType: a.mime_type, size: a.size, url: `/uploads/${a.filename}`,
      createdAt: a.created_at,
    }));
    const comments = (await all(
      `SELECT c.*, u.name AS author_name, u.avatar_url AS author_avatar, u.perm_role AS author_role
         FROM feedback_comments c
         LEFT JOIN users u ON u.id = c.author_user_id
        WHERE c.feedback_id = ?
        ORDER BY c.created_at ASC, c.id ASC`,
      id
    )).map(c => ({
      id: c.id, text: c.text || '', createdAt: c.created_at,
      author: {
        id: c.author_user_id || null,
        name: c.author_name || '',
        avatarUrl: c.author_avatar || '',
        role: c.author_role || '',
      },
    }));
    res.json(shapeFeedback(row, attachments, comments));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/feedback/:id', requireAdmin, async (req, res) => {
  try {
    const { status, kind, title, description } = req.body || {};
    const u = []; const v = [];
    if (status !== undefined && FEEDBACK_STATUSES.has(String(status).toLowerCase())) {
      u.push('status=?'); v.push(String(status).toLowerCase());
    }
    if (kind !== undefined && FEEDBACK_KINDS.has(String(kind).toLowerCase())) {
      u.push('kind=?'); v.push(String(kind).toLowerCase());
    }
    if (title !== undefined)       { u.push('title=?');       v.push(String(title || '').trim().slice(0, 200)); }
    if (description !== undefined) { u.push('description=?'); v.push(String(description || '').trim()); }
    if (!u.length) return res.json({ ok: true });
    u.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
    v.push(Number(req.params.id));
    await run(`UPDATE feedback_items SET ${u.join(',')} WHERE id=?`, ...v);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/feedback/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT created_by_user_id FROM feedback_items WHERE id=?', id);
    if (!row) return res.json({ ok: true });
    const u = await getUser(req.session.userId);
    const isAdmin = (u?.perm_role || '').toLowerCase() === 'admin';
    const isCreator = row.created_by_user_id && row.created_by_user_id === req.session.userId;
    if (!isAdmin && !isCreator) return res.status(403).json({ error: 'Forbidden' });
    // Free up the uploaded files attached to this item
    const atts = await all('SELECT filename FROM attachments WHERE feedback_id=?', id);
    for (const a of atts) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, a.filename)); } catch {}
    }
    await run('DELETE FROM feedback_items WHERE id=?', id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/feedback/:id/comments', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { text } = req.body || {};
    const t = String(text || '').trim();
    if (!t) return res.status(400).json({ error: 'Empty comment' });
    const exists = await get('SELECT id FROM feedback_items WHERE id=?', id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const info = await run(
      `INSERT INTO feedback_comments (feedback_id, author_user_id, text) VALUES (?,?,?) RETURNING id`,
      id, req.session.userId, t
    );
    await run(`UPDATE feedback_items SET updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`, id);
    res.status(201).json({ id: Number(info.lastInsertRowid), text: t });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ticket subtasks ──────────────────────────────────────────────────────────
// Async — looks up the live user.name when assignee_user_id is set so a
// renamed user shows their current name on every subtask they're on.
async function buildSubtask(r) {
  let assignee = r.assignee || '';
  if (r.assignee_user_id) {
    const u = await get('SELECT name FROM users WHERE id=?', r.assignee_user_id);
    if (u?.name) assignee = u.name;
  }
  return {
    id: r.id, ticketId: r.ticket_id, position: r.position,
    text: r.text || '', description: r.description || '',
    done: !!r.done, assignee,
    due: r.due || '', priority: r.priority || '',
    createdAt: r.created_at,
  };
}

app.get('/api/tickets/:id/subtasks', requireAuth, requireTicketAccess, async (req, res) => {
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
    res.json(await Promise.all(rows.map(buildSubtask)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/subtasks', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    if (!await get('SELECT id FROM tickets WHERE id=?', req.params.id))
      return res.status(404).json({ error: 'Ticket not found' });
    const { text, assignee, due, priority, description } = req.body || {};
    const posRow = await get('SELECT COALESCE(MAX(position),0) AS p FROM ticket_subtasks WHERE ticket_id=?', req.params.id);
    const nextPos = Number(posRow?.p || 0) + 1;
    const assigneeUid = await resolveUserIdByName(assignee);
    const info = await run(
      `INSERT INTO ticket_subtasks (ticket_id, position, text, description, done, assignee, assignee_user_id, due, priority)
       VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
      req.params.id, nextPos, String(text || '').trim() || 'New subtask',
      String(description || ''), 0, assignee || '', assigneeUid, due || '', priority || ''
    );
    const row = await get('SELECT * FROM ticket_subtasks WHERE id=?', Number(info.lastInsertRowid));
    res.status(201).json(await buildSubtask(row));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/subtasks/:sid', requireAuth, async (req, res) => {
  try {
    const sid = Number(req.params.sid);
    const sub = await get('SELECT ticket_id FROM ticket_subtasks WHERE id=?', sid);
    if (!sub) return res.status(404).json({ error: 'Subtask not found' });
    if (!await canAccessTicket(req, sub.ticket_id)) return res.status(404).json({ error: 'Subtask not found' });
    const { text, description, done, assignee, due, priority, position } = req.body || {};
    const u = []; const v = [];
    if (text !== undefined)        { u.push('text=?');        v.push(String(text || '').trim()); }
    if (description !== undefined) { u.push('description=?'); v.push(String(description || '')); }
    if (done !== undefined)        { u.push('done=?');        v.push(done ? 1 : 0); }
    if (assignee !== undefined)    {
      u.push('assignee=?');         v.push(assignee || '');
      u.push('assignee_user_id=?'); v.push(await resolveUserIdByName(assignee));
    }
    if (due !== undefined)         { u.push('due=?');         v.push(due || ''); }
    if (priority !== undefined)    { u.push('priority=?');    v.push(priority || ''); }
    if (position !== undefined)    { u.push('position=?');    v.push(Number(position) || 0); }
    if (u.length) { v.push(sid); await run(`UPDATE ticket_subtasks SET ${u.join(',')} WHERE id=?`, ...v); }
    const row = await get('SELECT * FROM ticket_subtasks WHERE id=?', sid);
    res.json(await buildSubtask(row));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/subtasks/:sid', requireAuth, async (req, res) => {
  try {
    const sid = Number(req.params.sid);
    const sub = await get('SELECT ticket_id FROM ticket_subtasks WHERE id=?', sid);
    if (!sub) return res.status(404).json({ error: 'Subtask not found' });
    if (!await canAccessTicket(req, sub.ticket_id)) return res.status(404).json({ error: 'Subtask not found' });
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
    const sid = Number(req.params.sid);
    const sub = await get('SELECT ticket_id FROM ticket_subtasks WHERE id=?', sid);
    if (!sub) return res.status(404).json({ error: 'Subtask not found' });
    if (!await canAccessTicket(req, sub.ticket_id)) return res.status(404).json({ error: 'Subtask not found' });
    const rows = await all('SELECT * FROM attachments WHERE subtask_id=? ORDER BY created_at ASC', sid);
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
app.put('/api/flavor-tasks', requireAdmin, async (req, res) => {
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
//
// Wrapped in a single Postgres transaction so the batch is atomic — if any
// row fails (id collision, FK error, anything) the whole batch rolls back
// and no half-created flavor is left behind. ID allocation uses an advisory
// lock to serialize concurrent /api/flavors and /api/tickets POSTs.
app.post('/api/flavors', requireAdmin, async (req, res) => {
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
    const tag = `Launch: ${name}`;

    // Email side-effects collected during the transaction; fired after commit
    // so a rollback doesn't send confused emails about tickets that no longer exist.
    const emailJobs = [];
    const notifJobs = [];

    const created = await withTx(async (tx) => {
      // Serialize ticket-id allocation across all writers (other /api/flavors,
      // /api/tickets, /api/admin/users) using a session-scoped advisory lock.
      // Released automatically on COMMIT/ROLLBACK.
      await tx.run('SELECT pg_advisory_xact_lock(91501)');

      // Compute next id once — safe because we hold the lock.
      const maxRow = await tx.get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
      let nextNum = 1000;
      if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }

      const out = [];
      for (const row of tmpl) {
        nextNum += 1;
        const tktId = 'TKT-' + nextNum;
        const title = (row.title_template || '').replace(/\{flavor\}/gi, name);
        const dueMs = launchMs + Number(row.days_offset || 0) * 86400000;
        const due = new Date(dueMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const createdStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        const assigneeRow = row.assignee
          ? await tx.get('SELECT id,name,email FROM users WHERE name=? ORDER BY id ASC LIMIT 1', row.assignee)
          : null;
        const flavorAssigneeUid = assigneeRow?.id || null;
        const flavorReporterUid = u?.id || null;
        const flavorReqUid      = u?.id || null;

        await tx.run(`INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
          tktId, title, u?.name || '', row.assignee || '', u?.name || '',
          row.priority || 'Medium', 'Open', row.dept || 'General',
          due, createdStr, 0, JSON.stringify([tag]), req.session.userId,
          flavorAssigneeUid, flavorReporterUid, flavorReqUid);
        await tx.run('INSERT INTO ticket_details (ticket_id) VALUES (?) ON CONFLICT DO NOTHING', tktId);

        if (row.assignee) {
          await tx.run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', tktId, row.assignee, flavorAssigneeUid);
          if (assigneeRow && assigneeRow.id !== req.session.userId) {
            await tx.run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
              assigneeRow.id, 'assigned', '👤', `${u?.name || 'Someone'} assigned you to "${title}"`, tktId);
            // Defer email to post-commit
            emailJobs.push({
              toEmail: assigneeRow.email, toName: assigneeRow.name,
              assignerName: u?.name || 'Someone',
              ticketId: tktId, title,
              priority: row.priority || 'Medium', dueAt: due,
              status: 'Open', dept: row.dept || 'General',
              requester: u?.name || '', description: '', tags: [tag],
            });
          }
        }
        out.push({ id: tktId, title, assignee: row.assignee || '', dept: row.dept || '', due });
      }
      return out;
    });

    // Post-commit side-effects
    for (const job of emailJobs) {
      fireEmail('flavor-ticket-assigned', () => sendTicketAssignedEmail(job));
    }

    res.status(201).json({ ok: true, flavor: name, tag, tickets: created });
  } catch(e) {
    console.error('[flavors] failed:', e.message);
    res.status(500).json({ error: 'Could not create flavor launch — please retry.' });
  }
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
    const eventId = Number(info.lastInsertRowid);

    // ── Calendar emails ───────────────────────────────────────────────────
    // Build a real Date for start time so the email helper can format it
    // nicely. dateKey is 'YYYY-MM-DD'. startTime may be 'HH:MM' or empty.
    function combineDateTime(dKey, tStr) {
      if (!dKey) return null;
      const cleanT = (tStr && /^\d{1,2}:\d{2}/.test(tStr)) ? tStr : '00:00';
      const iso = `${dKey}T${cleanT.length === 4 ? '0'+cleanT : cleanT}:00`;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d;
    }
    try {
      const organizer = await getUser(req.session.userId);
      const startAt   = combineDateTime(dateKey, startTime);
      const endAt     = combineDateTime(dateKey, endTime);
      const evType    = String(type || 'meeting').toLowerCase();

      if (evType === 'meeting') {
        // Meeting invite to every attendee that isn't the organizer.
        const attList = Array.isArray(attendees) ? attendees : [];
        const linked  = linkedTicketId ? await get('SELECT title FROM tickets WHERE id=?', linkedTicketId) : null;
        for (const aName of attList) {
          if (!aName || aName === organizer?.name) continue;
          const t = await emailForName(aName);
          if (!t?.email) continue;
          fireEmail('meeting-invite', () => sendMeetingInviteEmail({
            toEmail: t.email, toName: t.name,
            organizerName: organizer?.name || 'Someone',
            title: title || 'Meeting',
            startAt, endAt,
            location: location || '',
            description: desc || (linked ? `Linked: ${linkedTicketId} · ${linked.title}` : ''),
            attendees: [organizer?.name, ...attList].filter(Boolean),
            eventId,
            tz: organizer?.tz || '',
          }));
        }
      } else if (evType === 'task' && assignee && assignee !== organizer?.name) {
        // Calendar-task assigned email.
        const t = await emailForName(assignee);
        if (t?.email) {
          const linked = linkedTicketId ? await get('SELECT title FROM tickets WHERE id=?', linkedTicketId) : null;
          fireEmail('task-assigned', () => sendTaskAssignedEmail({
            toEmail: t.email, toName: t.name,
            assignerName: organizer?.name || 'Someone',
            title: title || 'New task',
            dueAt: startAt || null,
            estimate: '',
            linkedTicketId: linkedTicketId || '',
            linkedTicketTitle: linked?.title || '',
            description: desc || '',
            eventId,
          }));
        }
      }
    } catch(e) {
      console.error('[events] email dispatch failed:', e.message);
    }

    res.status(201).json({ id: eventId });
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
    // Read the event first so we can email all attendees BEFORE the row is gone.
    const ev = await get('SELECT * FROM cal_events WHERE id=?', req.params.id);
    await run('DELETE FROM cal_events WHERE id=?', req.params.id);
    if (ev && (ev.type === 'meeting' || ev.type === 'task')) {
      try {
        const canceller = await getUser(req.session.userId);
        // Combine date_key + start_time into a real Date so the email format is nice.
        let originalStart = null, originalEnd = null;
        if (ev.date_key) {
          const t1 = (ev.start_time && /^\d{1,2}:\d{2}/.test(ev.start_time)) ? ev.start_time : '00:00';
          originalStart = new Date(`${ev.date_key}T${t1.length === 4 ? '0'+t1 : t1}:00`);
          if (ev.end_time && /^\d{1,2}:\d{2}/.test(ev.end_time)) {
            const t2 = ev.end_time;
            originalEnd = new Date(`${ev.date_key}T${t2.length === 4 ? '0'+t2 : t2}:00`);
          }
        }
        let attList = [];
        try { attList = JSON.parse(ev.attendees_json || '[]'); } catch {}
        if (ev.assignee && !attList.includes(ev.assignee)) attList.push(ev.assignee);
        for (const aName of attList) {
          if (!aName || aName === canceller?.name) continue;
          const t = await emailForName(aName);
          if (!t?.email) continue;
          fireEmail('event-cancelled', () => sendEventCancelledEmail({
            toEmail: t.email, toName: t.name,
            cancellerName: canceller?.name || 'Someone',
            title: ev.title || ev.label || 'Event',
            originalStart: originalStart && !isNaN(originalStart) ? originalStart : null,
            originalEnd:   originalEnd   && !isNaN(originalEnd)   ? originalEnd   : null,
            reason: '',
          }));
        }
      } catch(e) {
        console.error('[events] cancel-email dispatch failed:', e.message);
      }
    }
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
    const user = await get('SELECT id,name,email,password_hash FROM users WHERE id=?', req.session.userId);
    if (!bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(401).json({ error:'Current password is incorrect' });
    await run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(newPassword, 10), req.session.userId);

    // Security alert email — fire & forget.
    const ip  = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const dev = deviceKey(req.headers['user-agent'] || '');
    fireEmail('password-changed', () => sendPasswordChangedEmail({
      toEmail: user.email, toName: user.name, ip, device: dev,
    }));

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
    // Skip activity tied to soft-deleted tickets
    const rows = await all(`
      SELECT tt.id, tt.ticket_id, tt.text, tt.dot, tt.created_at,
             t.title as ticket_title
      FROM ticket_timelines tt
      JOIN tickets t ON t.id = tt.ticket_id AND t.deleted_at IS NULL
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
    if (!req.file) {
      if (req._uploadRejected) {
        const r = req._uploadRejected;
        return res.status(400).json({
          error: `File type not allowed: ${r.name || 'file'} (${r.mime || 'no mime'}${r.ext ? ', .' + r.ext : ''})`,
          rejected: r,
        });
      }
      return res.status(400).json({ error: 'No file' });
    }
    const u = await getUser(req.session.userId);
    const { ticketId, commentId, subtaskId, feedbackId, announcementId } = req.body;
    // Verify the uploader actually has access to the parent ticket. Without
    // this a Member could attach files to anyone's ticket by id-guessing.
    let parentTicketId = ticketId || null;
    if (!parentTicketId && subtaskId) {
      const sub = await get('SELECT ticket_id FROM ticket_subtasks WHERE id=?', Number(subtaskId));
      parentTicketId = sub ? sub.ticket_id : null;
    }
    if (parentTicketId && !await canAccessTicket(req, parentTicketId)) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
      return res.status(404).json({ error: 'Ticket not found' });
    }
    // Announcement attachments: only an admin can attach to one (the create
    // and edit routes are admin-only too). Reject non-admins to keep the
    // feed clean.
    if (announcementId) {
      if ((u?.perm_role || '').toLowerCase() !== 'admin') {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
        return res.status(403).json({ error: 'Admin only' });
      }
    }
    // Feedback attachments: anyone authenticated can attach to any feedback
    // item (the feedback page is shared by everyone). No further check
    // beyond the auth middleware.
    const info = await run(
      'INSERT INTO attachments (ticket_id,comment_id,subtask_id,feedback_id,announcement_id,filename,original_name,mime_type,size,uploader) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id',
      ticketId || null,
      commentId ? Number(commentId) : null,
      subtaskId ? Number(subtaskId) : null,
      feedbackId ? Number(feedbackId) : null,
      announcementId ? Number(announcementId) : null,
      req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, u.name
    );
    res.json({
      id: Number(info.lastInsertRowid),
      filename: req.file.filename, originalName: req.file.originalname,
      mimeType: req.file.mimetype, size: req.file.size, url: `/uploads/${req.file.filename}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/attachments', requireAuth, requireTicketAccess, async (req, res) => {
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
    const att = await get('SELECT filename, ticket_id, subtask_id FROM attachments WHERE id=?', req.params.id);
    if (!att) return res.json({ ok: true }); // already gone
    // Resolve the parent ticket id (direct or via the parent subtask) and verify access
    let ticketId = att.ticket_id;
    if (!ticketId && att.subtask_id) {
      const sub = await get('SELECT ticket_id FROM ticket_subtasks WHERE id=?', att.subtask_id);
      ticketId = sub ? sub.ticket_id : null;
    }
    if (ticketId && !await canAccessTicket(req, ticketId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch {}
    await run('DELETE FROM attachments WHERE id=?', req.params.id);
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
    // Members see stats limited to tickets they are assigned to OR tickets they created —
    // overrides any client-supplied assignee filter. Match by user_id first, fall back
    // to the legacy name match for any rows that haven't been back-filled yet.
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);

    // Validate `dept` against the departments table. Unknown values are dropped
    // so an attacker can't smuggle SQL meta-characters into the where-clause.
    let safeDept = '';
    if (dept) {
      const known = await get('SELECT name FROM departments WHERE name=? LIMIT 1', dept);
      if (known?.name) safeDept = known.name;
    }
    const deptClause = safeDept ? `AND dept = '${safeDept.replace(/'/g, "''")}'` : '';

    let assigneeClause = '';
    if (!isAdmin && me?.id) {
      const safeName = (me.name || '').replace(/'/g, "''");
      assigneeClause =
        `AND (assignee_user_id = ${Number(me.id)}
              OR (assignee_user_id IS NULL AND assignee = '${safeName}')
              OR id IN (SELECT ticket_id FROM ticket_assignees WHERE user_id = ${Number(me.id)} OR (user_id IS NULL AND user_name = '${safeName}'))
              OR created_by = ${Number(me.id)})`;
    } else if (isAdmin && assignee) {
      // Validate assignee against the users table by name; only use the id-based
      // clause when the lookup actually resolves. This makes the assigneeClause
      // contain only validated identifiers (id from DB, name from DB), no
      // unsanitized request input.
      const target = await get('SELECT id, name FROM users WHERE name=? ORDER BY id ASC LIMIT 1', assignee);
      if (target?.id) {
        const validatedName = String(target.name || '').replace(/'/g, "''");
        assigneeClause =
          `AND (assignee_user_id = ${Number(target.id)}
                OR (assignee_user_id IS NULL AND assignee = '${validatedName}')
                OR id IN (SELECT ticket_id FROM ticket_assignees WHERE user_id = ${Number(target.id)} OR (user_id IS NULL AND user_name = '${validatedName}')))`;
      }
    }
    // Always exclude soft-deleted tickets from stats (audit Finding 6.2).
    const where = `WHERE deleted_at IS NULL ${dateClause} ${deptClause} ${assigneeClause}`;

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
      let q = `SELECT COUNT(*) as c FROM tickets WHERE deleted_at IS NULL AND created_at LIKE '${y}-${m}%'`;
      if (deptClause) q += ` ${deptClause}`;
      if (assigneeClause) q += ` ${assigneeClause}`;
      const row = await get(q);
      monthly.push({ label, count: parseInt(row?.c || 0, 10) });
    }

    const todayStr = now.toISOString().slice(0, 10);
    const completedTodayRow = await get(
      `SELECT COUNT(*) as c FROM tickets WHERE deleted_at IS NULL AND status='Closed' AND created_at LIKE '${todayStr}%' ${assigneeClause}`
    );
    const prevNow = new Date(); prevNow.setMonth(prevNow.getMonth() - 1);
    const py = prevNow.getFullYear(), pm = String(prevNow.getMonth() + 1).padStart(2, '0');
    const prevWhere = `WHERE deleted_at IS NULL AND created_at LIKE '${py}-${pm}%' ${deptClause} ${assigneeClause}`;
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
    const pRole = ['Admin','Manager','Member'].includes(permRole) ? permRole : 'Member';
    const hash = bcrypt.hashSync(password, 10);
    const info = await run('INSERT INTO users (name,email,password_hash,role,dept,perm_role,welcome_sent) VALUES (?,?,?,?,?,?,1) RETURNING id',
      name.trim(), norm, hash, role?.trim() || 'Team Member', dept?.trim() || 'General', pRole);
    const u = await getUser(Number(info.lastInsertRowid));

    // Welcome email — admin-created accounts also get an onboarding email.
    fireEmail('admin-created-welcome', () => sendWelcomeEmail({ toEmail: u.email, toName: u.name }));

    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, permRole: u.perm_role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: delete user ────────────────────────────────────────────────────────
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const target = await get('SELECT id,perm_role FROM users WHERE id=?', req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
    await run('DELETE FROM users WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: tickets ground-truth + restore ────────────────────────────────────
// Returns every row in the tickets table (including soft-deleted) so an admin
// can verify what's actually in the DB vs. what the UI shows.
app.get('/api/admin/tickets/dump', requireAdmin, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM tickets ORDER BY id DESC');
    res.json({
      total: rows.length,
      live: rows.filter(r => !r.deleted_at).length,
      deleted: rows.filter(r => r.deleted_at).length,
      rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Returns id, name, email, role (job title), perm_role (permissions), dept for every
// user. Lets an admin quickly verify whether someone has the Admin permission saved.
app.get('/api/admin/users/dump', requireAdmin, async (req, res) => {
  try {
    const rows = await all('SELECT id, name, email, role, perm_role, dept, last_login_at FROM users ORDER BY id ASC');
    res.json({ total: rows.length, users: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Restore a soft-deleted ticket
app.post('/api/admin/tickets/:id/restore', requireAdmin, async (req, res) => {
  try {
    const exists = await get('SELECT id, deleted_at FROM tickets WHERE id=?', req.params.id);
    if (!exists) return res.status(404).json({ error: 'Ticket not found' });
    if (!exists.deleted_at) return res.json({ ok: true, alreadyLive: true });
    await run('UPDATE tickets SET deleted_at=NULL WHERE id=?', req.params.id);
    console.log(`[tickets] RESTORE ${req.params.id} by user ${req.session.userId} at ${new Date().toISOString()}`);
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
                  await get('SELECT id FROM tickets WHERE dept=? AND deleted_at IS NULL LIMIT 1', name);
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

// ── Background email jobs ─────────────────────────────────────────────────────
// All three timers run inside try/catch — a single bad row never kills the loop.
// Idempotency is enforced via per-row flags (cal_events.reminder_sent /
// .deadline_warned) and a per-user timestamp (users.last_overdue_digest_at).

// Combine a date_key + time string into a real Date.
function combineEventStart(dateKey, timeStr) {
  if (!dateKey) return null;
  const t = (timeStr && /^\d{1,2}:\d{2}/.test(timeStr)) ? timeStr : '00:00';
  const iso = `${dateKey}T${t.length === 4 ? '0'+t : t}:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// Job 1: Meeting reminders — runs every 5 minutes, fires for any meeting
// whose start time is between 55 and 65 minutes from now.
async function runMeetingReminderJob() {
  try {
    const events = await all(
      "SELECT * FROM cal_events WHERE type='meeting' AND COALESCE(reminder_sent,0)=0 AND date_key >= ?",
      new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    );
    const now = Date.now();
    const lower = now + 55 * 60 * 1000;
    const upper = now + 65 * 60 * 1000;
    for (const ev of events) {
      const startAt = combineEventStart(ev.date_key, ev.start_time);
      if (!startAt) continue;
      const t = startAt.getTime();
      if (t < lower || t > upper) continue;
      let attList = [];
      try { attList = JSON.parse(ev.attendees_json || '[]'); } catch {}
      const organizer = ev.user_id ? await getUser(ev.user_id) : null;
      const targetNames = new Set(attList.filter(Boolean));
      if (organizer?.name) targetNames.add(organizer.name);
      for (const name of targetNames) {
        const u = await emailForName(name);
        if (!u?.email) continue;
        fireEmail('meeting-reminder', () => sendMeetingReminderEmail({
          toEmail: u.email, toName: u.name,
          title: ev.title || ev.label || 'Meeting',
          startAt,
          location: ev.location || '',
          attendeesCount: targetNames.size,
          eventId: ev.id,
        }));
      }
      await run('UPDATE cal_events SET reminder_sent=1 WHERE id=?', ev.id);
    }
  } catch(e) {
    console.error('[cron:meeting-reminder] failed:', e.message);
  }
}

// Job 2: Deadline-approaching — runs hourly, fires once per deadline event
// when its start (= due time) is between 22 and 26 hours from now.
async function runDeadlineWarningJob() {
  try {
    const events = await all(
      "SELECT * FROM cal_events WHERE type='deadline' AND COALESCE(deadline_warned,0)=0 AND date_key >= ?",
      new Date().toISOString().slice(0, 10)
    );
    const now = Date.now();
    const lower = now + 22 * 60 * 60 * 1000;
    const upper = now + 26 * 60 * 60 * 1000;
    for (const ev of events) {
      const dueAt = combineEventStart(ev.date_key, ev.start_time || '23:59');
      if (!dueAt) continue;
      const t = dueAt.getTime();
      if (t < lower || t > upper) continue;
      const owner = ev.user_id ? await getUser(ev.user_id) : null;
      const linked = ev.linked_ticket_id ? await get('SELECT title FROM tickets WHERE id=?', ev.linked_ticket_id) : null;
      const recipients = new Set();
      if (owner?.name) recipients.add(owner.name);
      if (ev.assignee) recipients.add(ev.assignee);
      let attList = [];
      try { attList = JSON.parse(ev.attendees_json || '[]'); } catch {}
      attList.forEach(a => a && recipients.add(a));
      for (const name of recipients) {
        const u = await emailForName(name);
        if (!u?.email) continue;
        fireEmail('deadline-approaching', () => sendDeadlineApproachingEmail({
          toEmail: u.email, toName: u.name,
          title: ev.title || ev.label || 'Deadline',
          dueAt,
          ownerName: owner?.name || '—',
          linkedTicketId: ev.linked_ticket_id || '',
          linkedTicketTitle: linked?.title || '',
          status: 'In progress',
          outstanding: [],
          eventId: ev.id,
        }));
      }
      await run('UPDATE cal_events SET deadline_warned=1 WHERE id=?', ev.id);
    }
  } catch(e) {
    console.error('[cron:deadline-warning] failed:', e.message);
  }
}

// Job 3: Overdue digest — once a day per user. We check hourly, but only
// actually send to a given user if their last_overdue_digest_at is >= 23h ago
// (so the wall-clock time of the daily send naturally drifts to whenever the
// server happens to first run the loop after a day's gap).
// Ticket reminders: scan for un-sent reminders whose remind_at has passed,
// email the user who set each one, mark them sent so we don't re-send.
async function runTicketReminderJob() {
  try {
    const due = await all(
      `SELECT r.*, u.email AS user_email, u.name AS user_name,
              t.title AS ticket_title, t.status AS ticket_status,
              t.priority AS ticket_priority, t.due AS ticket_due, t.dept AS ticket_dept
         FROM ticket_reminders r
         JOIN users u   ON u.id = r.user_id
         JOIN tickets t ON t.id = r.ticket_id
        WHERE r.sent = 0
          AND r.remind_at <= TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          AND t.deleted_at IS NULL
        ORDER BY r.remind_at ASC
        LIMIT 200`
    );
    if (!due.length) return;
    for (const r of due) {
      try {
        await sendTicketReminderEmail({
          toEmail: r.user_email, toName: r.user_name,
          ticketId: r.ticket_id, title: r.ticket_title,
          status: r.ticket_status, priority: r.ticket_priority,
          dueAt: r.ticket_due, dept: r.ticket_dept,
          note: r.note || '',
        });
        await run(
          `UPDATE ticket_reminders SET sent = 1, sent_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
          r.id
        );
        console.log(`[reminder] sent #${r.id} (${r.ticket_id} → ${r.user_email})`);
      } catch (e) { console.error('[reminder] failed for', r.id, e.message); }
    }
  } catch (e) { console.error('[cron:ticket-reminder] failed:', e.message); }
}

async function runOverdueDigestJob() {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const users = await all('SELECT id,name,email,last_overdue_digest_at FROM users');
    const allTickets = await all("SELECT * FROM tickets WHERE deleted_at IS NULL AND status != 'Closed' AND overdue=1");
    const allDeadlines = await all("SELECT * FROM cal_events WHERE type='deadline' AND date_key < ?", todayKey);

    for (const usr of users) {
      if (!usr.email) continue;
      // Throttle: skip if we sent within the last 23 hours.
      if (usr.last_overdue_digest_at) {
        const last = new Date(usr.last_overdue_digest_at).getTime();
        if (!isNaN(last) && (Date.now() - last) < 23 * 60 * 60 * 1000) continue;
      }
      // Tickets where this user is the primary assignee (id-linked or
      // legacy name match) or appears in ticket_assignees (id-linked or
      // legacy name match). Renames don't break the digest because the
      // id-link path keeps working.
      const myTicketRows = allTickets.filter(t =>
        t.assignee_user_id === usr.id ||
        (t.assignee_user_id == null && t.assignee === usr.name)
      );
      const otherTicketIds = (await all(
        `SELECT ticket_id FROM ticket_assignees
          WHERE user_id = ? OR (user_id IS NULL AND user_name = ?)`,
        usr.id, usr.name
      )).map(r => r.ticket_id);
      const otherTickets = allTickets.filter(t =>
        otherTicketIds.includes(t.id) && !myTicketRows.find(x => x.id === t.id)
      );
      const myTickets = [...myTicketRows, ...otherTickets];
      const myDeadlines = allDeadlines.filter(d => d.user_id === usr.id || d.assignee === usr.name);
      if (!myTickets.length && !myDeadlines.length) continue;

      const items = [];
      const today = Date.now();
      for (const t of myTickets) {
        const dueDate = t.due ? new Date(t.due) : null;
        const daysLate = dueDate && !isNaN(dueDate)
          ? Math.max(1, Math.floor((today - dueDate.getTime()) / 86400000))
          : 1;
        items.push({
          id: t.id,
          title: t.title || '(untitled)',
          type: `Ticket · ${t.priority || 'Medium'}`,
          daysLate,
          owner: t.assignee || usr.name,
          link: `${process.env.APP_URL || `http://localhost:${PORT}`}/?ticket=${encodeURIComponent(t.id)}`,
        });
      }
      for (const d of myDeadlines) {
        const due = combineEventStart(d.date_key, d.start_time || '23:59');
        const daysLate = due && !isNaN(due)
          ? Math.max(1, Math.floor((today - due.getTime()) / 86400000))
          : 1;
        items.push({
          id: `EVT-${d.id}`,
          title: d.title || d.label || 'Deadline',
          type: 'Deadline',
          daysLate,
          owner: d.assignee || usr.name,
          link: `${process.env.APP_URL || `http://localhost:${PORT}`}/?event=${d.id}`,
        });
      }

      fireEmail('overdue-digest', () => sendOverdueDigestEmail({
        toEmail: usr.email, toName: usr.name, items,
      }));
      await run('UPDATE users SET last_overdue_digest_at=? WHERE id=?', new Date().toISOString(), usr.id);
    }
  } catch(e) {
    console.error('[cron:overdue-digest] failed:', e.message);
  }
}

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error:'Not found' });
  // Don't fall through to the SPA HTML for missing /uploads paths — that
  // turns a 404 into "downloaded a copy of index.html" when a user clicks
  // a Download link for a file that's no longer on disk.
  if (req.path.startsWith('/uploads/')) return res.status(404).send('File not found');
  // Same for static-asset extensions that should resolve to a real file or
  // fail. Without this, /favicon.svg or /sw.js would silently become the
  // app HTML, and the service worker would refuse to register.
  if (/\.(svg|png|jpg|jpeg|gif|webp|ico|js|css|map|json|webmanifest|webm|mp4|mov|m4a|mp3|wav|ogg|pdf)$/i.test(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDb();
    console.log('✅  Database initialized');

    // Seed the "General" department on first boot — it's the company default
    // we surface in the Create Ticket modal. Idempotent: silently skipped on
    // subsequent boots once the row exists.
    try {
      const existing = await get("SELECT id FROM departments WHERE name='General'");
      if (!existing) {
        await run("INSERT INTO departments (name) VALUES ('General')");
        console.log("[seed] Inserted default department 'General'");
      }
    } catch (e) { console.warn("[seed] Could not seed General department:", e.message); }

    // (Removed) Previously a hardcoded "demo data cleanup" block ran on every server
    // start and DELETE'd TKT-1035..TKT-1042 / PLN-001..003 plus a fixed list of users.
    // It was meant to be a one-time migration but, because it had no guard, it wiped
    // any real ticket whose server-allocated id happened to land in that range every
    // single deploy. Removed entirely — soft-delete is the proper mechanism for any
    // future cleanup, and admins can use Settings → Reset Data when they want a wipe.

    app.listen(PORT, () => {
      console.log(`✅  Syruvia running at http://localhost:${PORT}`);
      console.log(`   Default login: admin@worknest.com / admin123`);
      console.log(`   No on-start ticket cleanup — your data is safe across deploys.`);
      console.log(`   Status is end-user controlled only; never reset on boot.`);
    });

    // ── Email cron loops ────────────────────────────────────────────────────
    // Every 5 min: meeting reminders ~1 hour before start, ticket reminders
    // whose remind_at has passed.
    setInterval(runMeetingReminderJob, 5 * 60 * 1000);
    setInterval(runTicketReminderJob,  5 * 60 * 1000);
    // Every hour: deadline-approaching warnings + overdue-digest dispatch.
    setInterval(runDeadlineWarningJob, 60 * 60 * 1000);
    setInterval(runOverdueDigestJob,   60 * 60 * 1000);
    // Run all jobs once at startup (slightly delayed) so a freshly-deployed
    // server doesn't have to wait an hour to start sending alerts.
    setTimeout(() => {
      runMeetingReminderJob();
      runTicketReminderJob();
      runDeadlineWarningJob();
      runOverdueDigestJob();
    }, 30 * 1000);
    console.log('✅  Email cron loops scheduled (meeting-reminder/ticket-reminder/deadline/overdue-digest).');
  } catch(e) {
    console.error('❌  Failed to start:', e.message);
    process.exit(1);
  }
})();