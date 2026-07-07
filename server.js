require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { randomUUID, randomBytes, createHash } = require('crypto');
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

// ── Slack DM dispatch ────────────────────────────────────────────────────────
// Configured via SLACK_BOT_TOKEN env var (the xoxb-... Bot User OAuth Token
// from a Slack App with chat:write + users:read + users:read.email scopes).
// When unset the helper is a no-op so callers can fan out fire-and-forget.
//
// To DM a user we need their Slack user_id, which we look up by email the
// first time and cache on users.slack_user_id. Empty = "not yet looked up";
// 'NOTFOUND' sentinel = "Slack workspace has no user with this email" so
// we don't keep hammering the API.
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const slackReady = !!SLACK_BOT_TOKEN;
console.log(`[slack] ${slackReady ? 'enabled' : 'disabled (no SLACK_BOT_TOKEN)'}`);

async function _slackApi(method, body) {
  const r = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function _resolveSlackUserId(user) {
  if (!user || !user.email) return null;
  if (user.slack_user_id === 'NOTFOUND') return null;
  if (user.slack_user_id) return user.slack_user_id;
  // Slack's lookupByEmail only takes a query param, not a JSON body.
  const r = await fetch(
    'https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(user.email),
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
  const data = await r.json();
  if (!data.ok) {
    if (data.error === 'users_not_found') {
      // Cache the miss so we don't ping Slack on every event for this user.
      try { await run('UPDATE users SET slack_user_id=? WHERE id=?', 'NOTFOUND', user.id); } catch {}
    } else {
      console.warn(`[slack] lookupByEmail(${user.email}) failed:`, data.error);
    }
    return null;
  }
  const sid = data.user?.id;
  if (sid) {
    try { await run('UPDATE users SET slack_user_id=? WHERE id=?', sid, user.id); } catch {}
  }
  return sid || null;
}

// Send a Slack DM to the given Syruvia user. payload is passed through to
// chat.postMessage minus `channel` (we set it to the resolved user_id).
// Pass either:
//   { text: "..." }                     simple text message
//   { text: "...", blocks: [...] }      rich block-kit layout
// Failures are swallowed; this is a side-effect of other workflows.
async function slackDmUser(userId, payload) {
  if (!slackReady) { console.log('[slack] dm skip — token not set'); return { skipped: true }; }
  if (!userId) { console.log('[slack] dm skip — no userId'); return { skipped: true }; }
  try {
    console.log(`[slack] dm attempt → userId=${userId} payloadKeys=${Object.keys(payload||{}).join(',')}`);
    const u = await get(
      'SELECT id, name, email, slack_user_id FROM users WHERE id=?',
      userId
    );
    if (!u) { console.log(`[slack] dm skip — no user row for id=${userId}`); return { skipped: true }; }
    if (!u.email) { console.log(`[slack] dm skip — user ${u.name} has no email`); return { skipped: true }; }
    const sid = await _resolveSlackUserId(u);
    if (!sid) { console.log(`[slack] dm skip — could not resolve Slack user_id for ${u.email}`); return { skipped: true }; }
    const data = await _slackApi('chat.postMessage', { channel: sid, ...payload });
    if (!data.ok) {
      console.warn(`[slack] postMessage failed for ${u.email} (sid=${sid}):`, data.error, 'response:', JSON.stringify(data).slice(0, 300));
      return { error: data.error };
    }
    console.log(`[slack] dm sent → ${u.email}`);
    return { ok: true };
  } catch (e) {
    console.warn('[slack] DM failed:', e.message, e.stack);
    return { error: e.message };
  }
}

const {
  sendInviteEmail, sendWelcomeEmail, sendActivateAccountEmail,
  sendForgotPasswordEmail, sendPasswordChangedEmail, sendNewDeviceLoginEmail,
  sendTicketAssignedEmail, sendTicketStatusChangedEmail, sendTicketUpdatedEmail, sendTicketClosedEmail,
  sendNewCommentEmail, sendMentionEmail, sendOverdueDigestEmail,
  sendMeetingInviteEmail, sendMeetingReminderEmail, sendTaskAssignedEmail,
  sendDeadlineApproachingEmail, sendEventCancelledEmail,
  sendTicketReminderEmail,
  sendPersonalReminderEmail,
  sendUpdateRequestedEmail,
  sendBulkUpdateRequestedEmail,
  sendTicketNagEmail,
  sendFeedbackReplyEmail,
  sendFeedbackStatusChangedEmail,
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

// ── SMS (Twilio) ─────────────────────────────────────────────────────────────
// Text messages for the ticket nag schedule. No-op (logged) until the three
// env vars are set — same graceful-degrade pattern as Slack/push/email.
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER || '';
if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
  console.log('[sms] disabled — set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER to enable');
}
async function sendSms(to, body) {
  if (!to) return { skipped: true, reason: 'no-recipient' };
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    console.log(`[sms] (dev / no Twilio) would text ${to}: ${body}`);
    return { skipped: true, reason: 'no-twilio' };
  }
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_SID)}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }).toString(),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Twilio ${resp.status}: ${detail.slice(0, 200)}`);
  }
  return { ok: true };
}

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Boot-time visibility into where uploads actually land. If UPLOADS_DIR
// is the default (public/uploads), files are on ephemeral storage on
// Render and disappear every redeploy — flag that loudly so it's not a
// silent footgun.
console.log(`[uploads] dir = ${UPLOADS_DIR}${process.env.UPLOADS_DIR ? '' : '  (default — NOT persistent on Render!)'}`);

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

// Body limits bumped to 50 MB so Spaces can ship base64-encoded media
// (voice notes, screen recordings, images) inside a single JSON POST.
// Per-item soft cap of 25 MB is enforced client-side; 50 MB here gives
// headroom for the base64 expansion (~33 % overhead).
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session store — uses PostgreSQL so sessions persist across deploys.
const PgSession = require('connect-pg-simple')(session);
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set in production. Set it in Render env vars.');
  process.exit(1);
}
// Hold the configured middleware in a variable so the WebSocket upgrade
// handler (defined further down) can reuse it to authenticate sockets via
// the same session cookie that authenticates regular requests.
const sessionMiddleware = session({
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
});
app.use(sessionMiddleware);

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
// Only Admin has blanket access to every ticket — Manager keeps admin
// powers elsewhere (settings, user management, etc.) but on TICKET views
// they're scoped to their own involvement (assignee/reporter/requester/
// creator), same rule as a Member. Soft-deleted tickets are off-limits
// here either way — recovery goes through the admin dump/restore endpoints.
async function canAccessTicket(req, ticketId) {
  if (!req.session.userId) return false;
  const me = await getUser(req.session.userId);
  if (!me) return false;
  // Confirm the ticket exists and isn't soft-deleted.
  const exists = await get('SELECT id FROM tickets WHERE id=? AND deleted_at IS NULL', ticketId);
  if (!exists) return false;
  if (me.perm_role === 'Admin') return true;
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
              OR t.reporter_user_id = ?
              OR (t.reporter_user_id IS NULL AND t.reporter = ?)
              OR t.req_user_id = ?
              OR (t.req_user_id IS NULL AND t.req = ?)
              OR t.created_by = ?
              OR EXISTS (
                   SELECT 1 FROM ticket_watchers tw
                    WHERE tw.ticket_id = t.id AND tw.user_id = ?
                 ))`,
    ticketId, me.id, me.name, me.id, me.name, me.id, me.name, me.id, me.name, me.id, me.id
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
    // Auto-add to #general so the new user lands in chat with one channel.
    if (typeof app.locals.chatAutoJoinGeneral === 'function') {
      app.locals.chatAutoJoinGeneral(Number(info.lastInsertRowid)).catch(()=>{});
    }

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

// Persist a workspace-wide activity row on the timeline. Surfaces in:
//   - dashboard Recent Activity (/api/activity, scoped per viewer)
//   - the ticket-detail Timeline tab (/api/tickets/:id/timeline)
// Helpers below pick a sensible color dot for each kind of event so the
// feed reads at a glance. Failures are logged and swallowed — a timeline
// row is auxiliary signal, never the canonical data.
async function writeTimeline(ticketId, dot, text) {
  if (!ticketId || !text) return;
  try {
    await run(
      'INSERT INTO ticket_timelines (ticket_id,dot,text,sub) VALUES (?,?,?,?)',
      ticketId, dot || 'var(--accent)', String(text).slice(0, 500), 'Just now'
    );
  } catch (e) { console.warn('[timeline] insert failed:', e.message); }
}
const TL = {
  create:   'var(--green)',
  status:   'var(--yellow)',
  assign:   'var(--accent)',
  priority: 'var(--accent2)',
  comment:  'var(--accent)',
  snooze:   '#4f46e5',
  close:    'var(--green)',
  reopen:   'var(--accent)',
  delete:   'var(--red)',
};

// Derive the *current* display name for a user.id (so a profile rename
// reflects everywhere automatically). Falls back to the stored name string
// when no user_id is set (legacy data) or when the user was deleted.
async function nameForUserId(userId, fallback) {
  if (!userId) return fallback || '';
  const u = await get('SELECT name FROM users WHERE id=?', userId);
  return u ? u.name : (fallback || '');
}

// Create a single main-app ticket programmatically. Used by the Flavor
// Reviews scheduler so a scheduled review spawns real tickets in everyone's
// normal queue (linked to the reviews flavor via fr_flavor_id). Centralised
// here so TKT-id allocation + assignee notification + timeline stay in one
// place instead of being duplicated inside the route modules.
async function createTicket(opts) {
  const {
    title, description = '', assigneeUserId = null, priority = 'Medium',
    dept = 'General', due = '', status = 'Open', tags = [],
    frFlavorId = null, frFlavorName = '', createdBy = null,
  } = opts || {};
  if (!title) throw new Error('createTicket: title required');

  // Allocate a unique TKT-#### id (retry on race with other writers).
  let id = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const maxRow = await get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
    let nextNum = 1000;
    if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }
    const candidate = 'TKT-' + (nextNum + 1);
    if (!await get('SELECT id FROM tickets WHERE id=?', candidate)) { id = candidate; break; }
  }
  if (!id) throw new Error('Could not allocate a unique ticket id — please retry.');

  const creatorName  = createdBy ? await nameForUserId(createdBy, '') : '';
  const assigneeName = assigneeUserId ? await nameForUserId(assigneeUserId, '') : '';
  const createdStr   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  await run(
    `INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id,fr_flavor_id,fr_flavor_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,
    id, title, creatorName || '', assigneeName || '', creatorName || '',
    priority, status, dept, due, createdStr, 0, JSON.stringify(tags || []),
    createdBy, assigneeUserId, createdBy, createdBy,
    frFlavorId || null, frFlavorName || null
  );
  await run(
    `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
       ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
    id, String(description || '')
  );
  if (assigneeName) {
    await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', id, assigneeName, assigneeUserId);
    if (assigneeUserId && assigneeUserId !== createdBy) {
      await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
        assigneeUserId, 'assigned', '👤', `${creatorName || 'The review scheduler'} assigned you "${title}"`, id);
    }
  }
  await writeTimeline(id, TL.create, `Ticket created by ${creatorName || 'the review scheduler'}${assigneeName ? ` · assigned to ${assigneeName}` : ''}`);
  return { id, title, assignee: assigneeName, due };
}

// ── Flavor-review ticket materialisation ──────────────────────────────────
// Tickets for a scheduled review day are NOT all created up front. Each type
// (gather / check) is only created once "today" is within its lead window of
// the review date, so a reviewer never has a stack of tickets for dates weeks
// away. Called immediately when a flavor is scheduled (creates anything
// already in-window) and hourly by runReviewTicketsJob (creates the rest as
// their windows open).
function _frDueString(dateIso) {
  try { return new Date(dateIso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  catch { return dateIso; }
}
function _frAddDays(dateIso, n) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
async function ensureReviewTicketsForCycle(cycle, s) {
  if (!cycle || cycle.status === 'done' || cycle.status === 'skipped') return null;
  if (!cycle.tickets_enabled) return null;
  s = s || await get('SELECT * FROM fr_settings WHERE id=1');
  const today = new Date().toISOString().slice(0, 10);
  const gathererId = s?.review_gatherer_id || s?.default_reviewer_id || null;
  const checkerId  = s?.product_checker_id || null;
  const gatherLead = Number(s?.gather_lead_days ?? 7);
  const checkLead  = Number(s?.check_lead_days ?? 2);
  const checkerOffset = Number(s?.checker_offset_days ?? 3);
  const f = await get('SELECT id, name FROM fr_flavors WHERE id=?', cycle.flavor_id);
  if (!f) return null;
  const tag = `Flavor review: ${f.name}`;
  let g = cycle.gather_ticket_id || '', c = cycle.check_ticket_id || '', changed = false;
  if (!g && today >= _frAddDays(cycle.scheduled_for, -gatherLead)) {
    try {
      const t = await createTicket({
        title: `Gather all reviews — ${f.name}`,
        description: `Collect every recent review for "${f.name}" (Regular + Sugar-free) ahead of the ${_frDueString(cycle.scheduled_for)} review — pull via the Rainforest API on the flavor page or upload a review file.`,
        assigneeUserId: gathererId, dept: 'Reviews', due: _frDueString(cycle.scheduled_for),
        tags: [tag, 'Gather reviews'], frFlavorId: f.id, frFlavorName: f.name, createdBy: null,
      });
      g = t.id; changed = true;
    } catch (e) { console.warn('[review-tickets] gather create failed:', e.message); }
  }
  if (!c && today >= _frAddDays(cycle.scheduled_for, -checkLead)) {
    try {
      const t = await createTicket({
        title: `Check product & adjust — ${f.name}`,
        description: `Review the gathered feedback for "${f.name}" and decide if the product needs changes (reformulate, bottle/label, listing copy, etc.). Record what you changed on the flavor's Review history.`,
        assigneeUserId: checkerId, dept: 'Product', due: _frDueString(_frAddDays(cycle.scheduled_for, checkerOffset)),
        tags: [tag, 'Check product'], frFlavorId: f.id, frFlavorName: f.name, createdBy: null,
      });
      c = t.id; changed = true;
    } catch (e) { console.warn('[review-tickets] check create failed:', e.message); }
  }
  if (changed) await run('UPDATE fr_cycles SET gather_ticket_id=?, check_ticket_id=? WHERE id=?', g, c, cycle.id);
  return { gather_ticket_id: g, check_ticket_id: c };
}

// Hourly sweep: create any review tickets whose lead window has now opened.
async function runReviewTicketsJob() {
  try {
    const s = await get('SELECT * FROM fr_settings WHERE id=1');
    const rows = await all("SELECT * FROM fr_cycles WHERE status IN ('scheduled','in_progress') AND tickets_enabled=1 AND (gather_ticket_id='' OR check_ticket_id='')");
    let made = 0;
    for (const cyc of rows) { const r = await ensureReviewTicketsForCycle(cyc, s); if (r && (r.gather_ticket_id || r.check_ticket_id)) made++; }
    if (made) console.log(`[cron:review-tickets] materialised tickets for ${made} cycle(s)`);
  } catch (e) { console.error('[cron:review-tickets] failed:', e.message); }
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
  // A snooze is "active" only if snoozed_until is still in the future.
  // Past that we expose null so the client treats it as a normal ticket
  // (no auto-clear is needed at the DB level — filtering is lazy).
  const nowUtcText = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const snoozeActive = row.snoozed_until && row.snoozed_until > nowUtcText;
  const snoozedByName = snoozeActive ? await nameForUserId(row.snoozed_by, '') : null;
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
    sourceEmailUrl: row.source_email_url || null,
    snoozedUntil: snoozeActive ? row.snoozed_until : null,
    snoozedBy:    snoozeActive ? row.snoozed_by    : null,
    snoozedByName,
    snoozedAt:    snoozeActive ? row.snoozed_at    : null,
  };
}

app.get('/api/tickets', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    // Cross-workspace view: Admin only. Manager is scoped to their own
    // involvement on tickets (assignee / reporter / requester / creator)
    // — they keep admin powers everywhere else.
    const isAdmin = u && u.perm_role === 'Admin';
    // Snoozed tickets are hidden from the main list to keep it focused on
    // what currently needs attention. EXCEPT: the requester always sees
    // their snoozed ticket (with a "Snoozed until …" pill) so they know
    // it's been deferred — otherwise it'd silently vanish from their
    // "Requested by me" view. Comparing TO_CHAR'd UTC text via lexico-
    // graphic > works correctly given the canonical YYYY-MM-DD HH24:MI:SS
    // format we use everywhere.
    const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    let rows;
    if (isAdmin) {
      rows = await all(
        `SELECT * FROM tickets
           WHERE deleted_at IS NULL
             AND (
                   snoozed_until IS NULL
                OR snoozed_until <= ?
                OR req_user_id = ?
                OR (req_user_id IS NULL AND req = ?)
             )
           ORDER BY id DESC`,
        nowUtc, u.id, u.name
      );
    } else {
      // Members see tickets they're personally involved in: assignee
      // (primary or additional), reporter, requester, or creator.
      // Match by user_id first (renames don't break anything) with a
      // name-match fallback for legacy rows that never got a user_id
      // back-filled. Snoozed tickets are filtered out unless the caller
      // is the requester — they keep seeing their ticket with a
      // "Snoozed until …" pill so it doesn't silently vanish from their
      // "Requested by me" view.
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
                  OR t.reporter_user_id = ?
                  OR (t.reporter_user_id IS NULL AND t.reporter = ?)
                  OR t.req_user_id = ?
                  OR (t.req_user_id IS NULL AND t.req = ?)
                  OR t.created_by = ?
                  OR EXISTS (
                       SELECT 1 FROM ticket_watchers tw
                        WHERE tw.ticket_id = t.id AND tw.user_id = ?
                     ))
             AND (
                   t.snoozed_until IS NULL
                OR t.snoozed_until <= ?
                OR t.req_user_id = ?
                OR (t.req_user_id IS NULL AND t.req = ?)
             )
           ORDER BY t.id DESC`,
        u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.id,
        nowUtc, u.id, u.name
      );
    }
    const tickets = await Promise.all(rows.map(buildTicket));
    // Mark which tickets the user is a mention-watcher on. Used by the
    // "Mentioned" filter chip on /my-tickets and the same-named sidebar
    // page. One indexed query against ticket_watchers, then a set lookup.
    if (tickets.length) {
      const ids = tickets.map(t => t.id);
      const placeholders = ids.map(() => '?').join(',');
      const wrows = await all(
        `SELECT ticket_id FROM ticket_watchers WHERE user_id=? AND ticket_id IN (${placeholders})`,
        u.id, ...ids
      );
      const wset = new Set(wrows.map(r => r.ticket_id));
      for (const t of tickets) t.mentioned = wset.has(t.id);
    }
    // Per-user unread flag. A ticket is unread when:
    //   1. The user is personally involved (assignee, additional assignee,
    //      reporter, or requester) — admins seeing every ticket should NOT
    //      get an unread pill on rows that don't need their attention.
    //   2. The ticket isn't already Closed — closed tickets are done; they
    //      don't pile up in "things I need to look at" even if assigned.
    //   3. There's been activity (creation or a comment) since their last
    //      view (or they've never viewed it).
    if (tickets.length) {
      const ids = tickets.map(t => t.id);
      const placeholders = ids.map(() => '?').join(',');
      const [views, lastComments] = await Promise.all([
        all(`SELECT ticket_id, last_viewed_at FROM ticket_views
              WHERE user_id=? AND ticket_id IN (${placeholders})`, u.id, ...ids),
        all(`SELECT ticket_id, MAX(created_at) AS latest_at FROM ticket_comments
              WHERE ticket_id IN (${placeholders}) GROUP BY ticket_id`, ...ids),
      ]);
      const viewMap = new Map(views.map(v => [v.ticket_id, v.last_viewed_at]));
      const commentMap = new Map(lastComments.map(c => [c.ticket_id, c.latest_at]));
      const myName = u.name;
      const myId = u.id;
      const needsMyAttention = (t) => {
        // "Done"-state tickets (Closed or Archived) never count as unread,
        // even when the current user is the assignee — they're finished
        // and shouldn't pile back into the attention bucket. Same for
        // currently-snoozed tickets: they're explicitly deferred.
        if (t.status === 'Closed' || t.status === 'Archived') return false;
        if (t.snoozedUntil) return false;
        if (t.assignee_user_id === myId) return true;
        if (!t.assignee_user_id && t.assignee === myName) return true;
        if (t.reporter_user_id === myId) return true;
        if (!t.reporter_user_id && t.reporter === myName) return true;
        if (t.req_user_id === myId) return true;
        if (!t.req_user_id && t.req === myName) return true;
        if (Array.isArray(t.assignees) && t.assignees.includes(myName)) return true;
        return false;
      };
      for (const t of tickets) {
        const lastViewed = viewMap.get(t.id) || null;
        const latestActivity = (() => {
          const c = commentMap.get(t.id) || null;
          if (!c) return t.created_at || null;
          if (!t.created_at) return c;
          return c > t.created_at ? c : t.created_at;
        })();
        const hasNewActivity = !lastViewed || (latestActivity && lastViewed < latestActivity);
        t.unread = hasNewActivity && needsMyAttention(t);
        t.lastViewedAt = lastViewed;
      }
    }
    res.json(tickets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mark a ticket as viewed by the current user. Upserts ticket_views
// with the current UTC timestamp. Idempotent and cheap — called every
// time the user opens a ticket detail page.
app.post('/api/tickets/:id/mark-viewed', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    await run(
      `INSERT INTO ticket_views (user_id, ticket_id, last_viewed_at)
       VALUES (?, ?, TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
       ON CONFLICT (user_id, ticket_id)
       DO UPDATE SET last_viewed_at = EXCLUDED.last_viewed_at`,
      req.session.userId, req.params.id
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk mark-viewed. Accepts { ids: [...] } and upserts a ticket_views row
// for every id the caller can actually access — silently skipping any
// id they can't see, so admins and members can both call this safely.
app.post('/api/tickets/bulk-mark-viewed', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return res.json({ ok: true, marked: 0 });
    let marked = 0;
    for (const id of ids) {
      if (!await canAccessTicket(req, id)) continue;
      await run(
        `INSERT INTO ticket_views (user_id, ticket_id, last_viewed_at)
         VALUES (?, ?, TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (user_id, ticket_id)
         DO UPDATE SET last_viewed_at = EXCLUDED.last_viewed_at`,
        req.session.userId, id
      );
      marked++;
    }
    res.json({ ok: true, marked });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Snooze ──────────────────────────────────────────────────────────────────
// Snoozing temporarily hides a ticket from the main list (capped at 6
// days) so it doesn't clutter what's currently actionable. Anyone with
// access to the ticket can snooze it — but the requester always gets a
// notification + still sees the ticket in their own list (with a
// "Snoozed until …" pill on the row), so nothing silently disappears
// on the person who asked for the work.
const SNOOZE_MAX_MS = 6 * 24 * 60 * 60 * 1000;
app.post('/api/tickets/:id/snooze', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const id = req.params.id;
    const { until } = req.body || {};
    if (!until) return res.status(400).json({ error: 'until required' });
    const wake = new Date(until);
    if (isNaN(wake)) return res.status(400).json({ error: 'Invalid date' });
    const now = Date.now();
    if (wake.getTime() <= now + 60_000) {
      // Require at least a minute in the future to avoid races where the
      // ticket wakes up before the response returns.
      return res.status(400).json({ error: 'Snooze date must be in the future' });
    }
    if (wake.getTime() > now + SNOOZE_MAX_MS) {
      return res.status(400).json({ error: 'Snooze max is 6 days' });
    }
    const ticket = await get('SELECT * FROM tickets WHERE id=? AND deleted_at IS NULL', id);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (ticket.status === 'Closed' || ticket.status === 'Archived') {
      return res.status(400).json({ error: "Can't snooze a closed or archived ticket" });
    }
    const wakeUtc = wake.toISOString().replace('T', ' ').slice(0, 19);
    const nowUtc  = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    await run(
      `UPDATE tickets SET snoozed_until=?, snoozed_by=?, snoozed_at=? WHERE id=?`,
      wakeUtc, req.session.userId, nowUtc, id
    );
    const snoozer = await getUser(req.session.userId);
    const niceDate = wake.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    writeTimeline(id, TL.snooze, `${snoozer?.name || 'Someone'} snoozed until ${niceDate}`);
    // Notify the requester (unless they snoozed it themselves).
    if (ticket.req_user_id && ticket.req_user_id !== req.session.userId) {
      await run(
        'INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
        ticket.req_user_id, 'snoozed', '💤',
        `${snoozer?.name || 'Someone'} snoozed "${ticket.title}" until ${niceDate}`,
        id
      );
    }
    const fresh = await buildTicket(await get('SELECT * FROM tickets WHERE id=?', id));
    res.json(fresh);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Wake a snoozed ticket up immediately. Anyone with access can do it —
// the requester might want to bring it back early, the assignee might
// be ready sooner than expected, etc.
app.post('/api/tickets/:id/unsnooze', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const id = req.params.id;
    await run('UPDATE tickets SET snoozed_until=NULL, snoozed_by=NULL, snoozed_at=NULL WHERE id=?', id);
    const actor = (await getUser(req.session.userId))?.name || 'Someone';
    writeTimeline(id, TL.snooze, `${actor} unsnoozed the ticket`);
    const fresh = await buildTicket(await get('SELECT * FROM tickets WHERE id=?', id));
    res.json(fresh);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List of currently-snoozed tickets the caller can see. Powers the new
// sidebar "Snoozed" page. Same access rules as the main list, plus a
// snoozer-sees-their-own clause so admins who snoozed a ticket they're
// otherwise unrelated to still find it here.
app.get('/api/my-snoozed', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    // Admin-only sees the workspace-wide snooze list; Manager is scoped
    // to their own involvement (matches the rule on /api/tickets).
    const isAdmin = u && u.perm_role === 'Admin';
    const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    let rows;
    if (isAdmin) {
      rows = await all(
        `SELECT * FROM tickets
           WHERE deleted_at IS NULL
             AND snoozed_until IS NOT NULL
             AND snoozed_until > ?
           ORDER BY snoozed_until ASC`,
        nowUtc
      );
    } else {
      rows = await all(
        `SELECT t.* FROM tickets t
           WHERE t.deleted_at IS NULL
             AND t.snoozed_until IS NOT NULL
             AND t.snoozed_until > ?
             AND (t.assignee_user_id = ?
                  OR (t.assignee_user_id IS NULL AND t.assignee = ?)
                  OR EXISTS (
                       SELECT 1 FROM ticket_assignees ta
                        WHERE ta.ticket_id = t.id
                          AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
                     )
                  OR t.reporter_user_id = ?
                  OR (t.reporter_user_id IS NULL AND t.reporter = ?)
                  OR t.req_user_id = ?
                  OR (t.req_user_id IS NULL AND t.req = ?)
                  OR t.created_by = ?
                  OR t.snoozed_by = ?)
           ORDER BY t.snoozed_until ASC`,
        nowUtc, u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.id
      );
    }
    const tickets = await Promise.all(rows.map(buildTicket));
    res.json(tickets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Open tickets where the caller was @-mentioned (i.e. they're a row in
// ticket_watchers with source='mention'). Each ticket carries a
// pendingReply flag — true when there's an undismissed mention
// notification on the ticket AND the user hasn't commented after it.
// Powers the sidebar "Mentioned" page + its waiting-my-reply badge.
app.get('/api/my-mentioned', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    const rows = await all(
      `SELECT t.* FROM tickets t
         JOIN ticket_watchers tw ON tw.ticket_id = t.id
        WHERE tw.user_id = ? AND tw.source = 'mention'
          AND t.deleted_at IS NULL
          AND t.status NOT IN ('Closed','Archived')
        ORDER BY t.id DESC`,
      u.id
    );
    if (!rows.length) return res.json([]);
    const tickets = await Promise.all(rows.map(buildTicket));
    // Pending-reply: any undismissed mention notification on this
    // ticket where the user hasn't authored a comment dated after the
    // notification. Single grouped query keeps it fast even on a long
    // mention history.
    const ids = tickets.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    const pendingRows = await all(
      `SELECT n.ticket_id
         FROM notifications n
        WHERE n.user_id = ?
          AND n.type = 'mention'
          AND n.dismissed_at IS NULL
          AND n.ticket_id IN (${placeholders})
          AND NOT EXISTS (
                SELECT 1 FROM ticket_comments tc
                 WHERE tc.ticket_id = n.ticket_id
                   AND (tc.author_user_id = ?
                        OR (tc.author_user_id IS NULL AND tc.author = ?))
                   AND tc.created_at >= n.created_at
              )
        GROUP BY n.ticket_id`,
      u.id, ...ids, u.id, u.name
    );
    const pendingSet = new Set(pendingRows.map(r => r.ticket_id));
    for (const t of tickets) t.pendingReply = pendingSet.has(t.id);
    res.json(tickets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Trash (soft-deleted tickets) ────────────────────────────────────────────
// Admin-only. Lists every soft-deleted ticket with the days-until-purge so
// admins can restore on demand or trigger a permanent removal early.
app.get('/api/admin/tickets/trash', requireAdmin, async (req, res) => {
  try {
    const rows = await all(
      `SELECT t.*, u.name AS deleted_by_name
         FROM tickets t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.deleted_at IS NOT NULL
        ORDER BY t.deleted_at DESC, t.id DESC`
    );
    const out = await Promise.all(rows.map(async r => {
      const t = await buildTicket(r);
      t.deletedAt = r.deleted_at || null;
      // 30-day countdown — purge cron drops anything past that. Using
      // simple JS date math is fine for display; the cron uses SQL math
      // for the actual decision.
      let daysLeft = null;
      if (r.deleted_at) {
        const d = new Date(String(r.deleted_at).replace(' ', 'T') + 'Z');
        if (!isNaN(d)) daysLeft = Math.max(0, 30 - Math.floor((Date.now() - d.getTime()) / 86400000));
      }
      t.daysUntilPurge = daysLeft;
      return t;
    }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin-only hard delete. Drops the row + on-disk attachments + cascades
// to children (FK), comments (FK), reminders (FK). Use this when you
// want a ticket actually gone before the 30-day auto-purge.
app.delete('/api/admin/tickets/:id/permanent', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const t = await get('SELECT id, deleted_at FROM tickets WHERE id=?', id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    // Drop on-disk files for any attachment that lived under this ticket
    // (or any of its sub-tickets).
    const subIds = (await all('SELECT id FROM tickets WHERE parent_ticket_id=?', id)).map(r => r.id);
    const allTktIds = [id, ...subIds];
    if (allTktIds.length) {
      const placeholders = allTktIds.map((_, i) => '$' + (i + 1)).join(',');
      const atts = await all(`SELECT filename FROM attachments WHERE ticket_id IN (${placeholders})`, ...allTktIds);
      for (const a of atts) { try { fs.unlinkSync(path.join(UPLOADS_DIR, a.filename)); } catch {} }
    }
    // Cascades will clean comments / subtask rows / attachment rows / etc.
    await run('DELETE FROM tickets WHERE id=?', id);
    console.log(`[trash] PERMANENT-DELETE ${id} by user ${req.session.userId} at ${new Date().toISOString()}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Daily auto-purge: hard-delete every ticket whose deleted_at is more
// than 30 days old. Same on-disk file cleanup as the manual permanent-
// delete. Idempotent and safe to run on every server start.
async function runTrashAutoPurgeJob() {
  try {
    const old = await all(
      `SELECT id FROM tickets
        WHERE deleted_at IS NOT NULL
          AND deleted_at < TO_CHAR((NOW() - INTERVAL '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
    );
    if (!old.length) return;
    const ids = old.map(r => r.id);
    // Wipe attachment files first.
    const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
    const atts = await all(`SELECT filename FROM attachments WHERE ticket_id IN (${placeholders})`, ...ids);
    for (const a of atts) { try { fs.unlinkSync(path.join(UPLOADS_DIR, a.filename)); } catch {} }
    await run(`DELETE FROM tickets WHERE id IN (${placeholders})`, ...ids);
    console.log(`[trash] auto-purged ${ids.length} ticket(s) past the 30-day mark: ${ids.join(', ')}`);
  } catch (e) { console.error('[cron:trash-auto-purge]', e.message); }
}

// Daily retention sweep for ticket attachments.
//
//   • Open tickets  → keep attachments for up to 3 years from upload time.
//                     Anything older is purged even though the ticket stays.
//   • Closed tickets → keep attachments for 1 year from closed_at, then purge.
//
// Only attachments anchored to a ticket are eligible — rows linked to
// comments / subtasks / docs / chat / etc. without a ticket_id are left
// alone, as are attachments on undeleted tickets where neither window has
// elapsed. The ticket row itself is never touched here; only attachment
// files + their attachments-table rows go away. Idempotent.
async function runTicketAttachmentRetentionJob() {
  try {
    // Pull every candidate in one query. We compare attachment.created_at
    // against now-3y for still-open tickets, and tickets.closed_at against
    // now-1y for closed tickets. Soft-deleted tickets are skipped — the
    // 30-day trash cron above will hard-delete them (and their files) on
    // its own schedule, so double-handling them here would just race.
    const rows = await all(
      `SELECT a.id   AS att_id,
              a.filename,
              t.id   AS ticket_id,
              t.status,
              t.closed_at,
              a.created_at
         FROM attachments a
         JOIN tickets t ON t.id = a.ticket_id
        WHERE a.ticket_id IS NOT NULL
          AND t.deleted_at IS NULL
          AND (
                (t.status <> 'Closed'
                 AND a.created_at < TO_CHAR((NOW() - INTERVAL '3 years') AT TIME ZONE 'UTC',
                                            'YYYY-MM-DD HH24:MI:SS'))
             OR (t.status = 'Closed'
                 AND t.closed_at IS NOT NULL
                 AND t.closed_at < TO_CHAR((NOW() - INTERVAL '1 year') AT TIME ZONE 'UTC',
                                           'YYYY-MM-DD HH24:MI:SS'))
              )`
    );
    if (!rows.length) return;

    // Unlink files first; ignore ENOENT / already-gone errors — the row
    // delete below still needs to run so we don't keep re-selecting the
    // same orphaned attachment row every day.
    for (const r of rows) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, r.filename)); } catch {}
    }

    const ids = rows.map(r => r.att_id);
    const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
    await run(`DELETE FROM attachments WHERE id IN (${placeholders})`, ...ids);

    const openCount   = rows.filter(r => r.status !== 'Closed').length;
    const closedCount = rows.length - openCount;
    console.log(
      `[attachments] retention purge: ${rows.length} file(s) removed ` +
      `(open>3y: ${openCount}, closed>1y: ${closedCount})`
    );
  } catch (e) { console.error('[cron:attachment-retention]', e.message); }
}

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
             (SELECT COUNT(*) FROM tickets c
                WHERE c.parent_ticket_id = t.id AND c.deleted_at IS NULL)::int AS child_count,
             (SELECT COUNT(*) FROM tickets c
                WHERE c.parent_ticket_id = t.id AND c.deleted_at IS NULL
                  AND c.status NOT IN ('Closed','Archived'))::int AS open_child_count
        FROM tickets t
       WHERE t.is_project = 1 AND t.deleted_at IS NULL
       ORDER BY t.id DESC`);
    const out = await Promise.all(rows.map(async r => {
      const t = await buildTicket(r);
      // Open child count for the Projects page filter. A project counts as
      // "done" when it has children and all of them are Closed/Archived.
      // A project with zero children stays "open" (just created).
      t.openChildCount = parseInt(r.open_child_count || 0, 10);
      // A project counts as "closed" on the Projects page filter when it
      // has no open children — either every child is Closed/Archived, OR
      // there are no children at all (an empty project is finished by
      // default, not stuck "Open" forever).
      t.allChildrenClosed = (t.openChildCount === 0);
      return t;
    }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Children of a given project ticket. Authenticated, but the access middleware
// gates non-admins by per-ticket access — a worker can only see children
// they're assigned to (which they'd already see in My Tickets anyway).
app.get('/api/tickets/:id/children', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    // Admin-only sees every child; Manager only sees children they're
    // involved in (same rule as the main /api/tickets list).
    const isAdmin = u && u.perm_role === 'Admin';
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
    const { id: clientId, title, req:reqName, assignee, assignees, reporter, priority, status, dept, due, created, overdue, tags, checklist, parentTicketId, syruvia_flavor_id, syruvia_flavor_name } = req.body;
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
    await run(`INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id,parent_ticket_id,syruvia_flavor_id,syruvia_flavor_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
      id, title, reqName||'', assignee||'', reporter||'', priority||'Medium', status||'Open',
      dept||'Engineering', due||'', created||'', overdue?1:0, JSON.stringify(tags||[]), req.session.userId,
      assigneeUid, reporterUid, reqUid, resolvedParent,
      syruvia_flavor_id || null, syruvia_flavor_name || null);
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
    writeTimeline(id, TL.create, `Ticket created by ${creator?.name || 'someone'}${assignee ? ` · assigned to ${assignee}` : ''}`);
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
        // Slack DM (no-op when SLACK_BOT_TOKEN unset).
        slackDmUser(target.id, {
          text: `🎫 *${creator?.name || 'Someone'}* assigned you to <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${id}|${id}>${title ? ' — ' + title : ''}`,
        }).catch(()=>{});
      }
    }
    const newTicket = await buildTicket(await get('SELECT * FROM tickets WHERE id=?', id));
    res.status(201).json(newTicket);

    // Sync new ticket to Syruvia tasks (fire-and-forget)
    const _syruviaUrl = process.env.SYRUVIA_URL || '';
    const _crossSecret = process.env.CROSS_APP_SECRET || '';
    if (_syruviaUrl && _crossSecret) {
      fetch(`${_syruviaUrl}/api/bridge/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_crossSecret}` },
        body: JSON.stringify({
          wm_ticket_id: id,
          title,
          description: req.body?.description || null,
          assigned_to_name: assignee || null,
          due_date: due || null,
          flavor_id: syruvia_flavor_id || null,
          flavor_name: syruvia_flavor_name || null,
        }),
      }).catch(e => console.error('[syruvia-sync] task sync failed:', e.message));
    }
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
    if (status!==undefined)   {
      u.push('status=?');     v.push(status);
      // Stamp closed_at when transitioning into Closed; clear it on
      // any other status (reopen). Drives the dashboard's accurate
      // "Completed today" count.
      if (status === 'Closed' && exists.status !== 'Closed') {
        u.push("closed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
      } else if (status !== 'Closed' && exists.status === 'Closed') {
        u.push('closed_at=?'); v.push(null);
      }
    }
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

    // Persist meaningful changes to the timeline so they surface in the
    // dashboard Recent Activity feed + the ticket-detail Timeline tab.
    // Fire-and-forget — we do NOT block the PUT response on these writes.
    // Every editable field is covered so the activity log reads like a
    // full audit trail ("Bob changed title from X to Y", etc.). Internal
    // book-keeping (overdue flag, closed_at) is skipped.
    {
      const actor = (await getUser(req.session.userId))?.name || 'someone';
      const shortVal = v => {
        const s = String(v == null ? '' : v).trim();
        return s.length > 80 ? s.slice(0, 77) + '…' : s;
      };
      if (title !== undefined && title !== exists.title) {
        writeTimeline(req.params.id, TL.status,
          `${actor} renamed the ticket: "${shortVal(exists.title)}" → "${shortVal(title)}"`);
      }
      if (status !== undefined && status !== oldStatus) {
        const dot = status === 'Closed' ? TL.close
                  : (oldStatus === 'Closed' ? TL.reopen : TL.status);
        // Always include both the old and new value so the audit log
        // reads as a real "from → to". Close + reopen used to drop the
        // counterpart; now: "Admin closed the ticket (was In Progress)",
        // "Admin reopened the ticket (now Open)", same shape as a mid-
        // workflow status change.
        let msg;
        if (status === 'Closed') {
          msg = `${actor} closed the ticket (was ${oldStatus})`;
        } else if (oldStatus === 'Closed') {
          msg = `${actor} reopened the ticket (now ${status})`;
        } else {
          msg = `${actor} changed status from ${oldStatus} to ${status}`;
        }
        writeTimeline(req.params.id, dot, msg);
      }
      if (assignee !== undefined && assignee !== exists.assignee) {
        writeTimeline(req.params.id, TL.assign,
          assignee && exists.assignee
            ? `${actor} changed assignee from ${shortVal(exists.assignee)} to ${shortVal(assignee)}`
            : (assignee
                ? `${actor} assigned the ticket to ${shortVal(assignee)} (was unassigned)`
                : `${actor} removed assignee ${shortVal(exists.assignee)}`));
      }
      if (priority !== undefined && priority !== exists.priority) {
        writeTimeline(req.params.id, TL.priority,
          exists.priority
            ? `${actor} changed priority from ${exists.priority} to ${priority}`
            : `${actor} set priority to ${priority}`);
      }
      if (reqName !== undefined && reqName !== exists.req) {
        writeTimeline(req.params.id, TL.assign,
          exists.req
            ? `${actor} changed requester from ${shortVal(exists.req)} to ${shortVal(reqName) || '—'}`
            : `${actor} set requester to ${shortVal(reqName) || '—'}`);
      }
      if (reporter !== undefined && reporter !== exists.reporter) {
        writeTimeline(req.params.id, TL.assign,
          exists.reporter
            ? `${actor} changed reporter from ${shortVal(exists.reporter)} to ${shortVal(reporter) || '—'}`
            : `${actor} set reporter to ${shortVal(reporter) || '—'}`);
      }
      if (dept !== undefined && dept !== exists.dept) {
        writeTimeline(req.params.id, TL.status,
          exists.dept
            ? `${actor} changed department from ${shortVal(exists.dept)} to ${shortVal(dept) || '—'}`
            : `${actor} set department to ${shortVal(dept) || '—'}`);
      }
      if (due !== undefined && due !== exists.due) {
        writeTimeline(req.params.id, TL.status,
          due && exists.due
            ? `${actor} changed due date from ${shortVal(exists.due)} to ${shortVal(due)}`
            : (due
                ? `${actor} set due date to ${shortVal(due)}`
                : `${actor} cleared the due date (was ${shortVal(exists.due)})`));
      }
      if (tags !== undefined) {
        let oldTags = [];
        try { oldTags = JSON.parse(exists.tags_json || '[]'); } catch {}
        const newSet = new Set(tags || []);
        const oldSet = new Set(oldTags || []);
        const added   = (tags || []).filter(t => !oldSet.has(t));
        const removed = oldTags.filter(t => !newSet.has(t));
        if (added.length) {
          writeTimeline(req.params.id, TL.status,
            `${actor} added tag${added.length === 1 ? '' : 's'} ${added.map(shortVal).join(', ')}`);
        }
        if (removed.length) {
          writeTimeline(req.params.id, TL.status,
            `${actor} removed tag${removed.length === 1 ? '' : 's'} ${removed.map(shortVal).join(', ')}`);
        }
      }
      // Additional-assignees diff. The primary assignee is handled above;
      // here we cover the multi-assign list.
      if (Array.isArray(assignees)) {
        const oldExtra = new Set(oldAssigneesAll || []);
        const newExtra = new Set(assignees || []);
        const added   = (assignees || []).filter(n => !oldExtra.has(n));
        const removed = (oldAssigneesAll || []).filter(n => !newExtra.has(n));
        for (const n of added)   writeTimeline(req.params.id, TL.assign, `${actor} added ${n} as an assignee`);
        for (const n of removed) writeTimeline(req.params.id, TL.assign, `${actor} removed ${n} as an assignee`);
      }
    }

    // Flavor-launch pipeline hook: when a flavor pipeline ticket transitions
    // to Closed, let routes/flavors.js decide whether to spawn a follow-up
    // (currently: label_design close → spawn the label_review ticket).
    // Deferred so the PUT response stays snappy; failures log and are
    // swallowed since the user-visible status flip already succeeded.
    if (status === 'Closed' && oldStatus !== 'Closed' && exists.flavor_v2_id) {
      setImmediate(() => {
        const fresh = { ...exists, status: 'Closed' };
        req.app.locals.flavorsHook?.onTicketClosed?.(fresh);
      });
    }

    if (assignees!==undefined) {
      await run('DELETE FROM ticket_assignees WHERE ticket_id=?', req.params.id);
      for (const a of assignees) {
        const uid = await resolveUserIdByName(a);
        await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', req.params.id, a, uid);
      }
      const newAssignees = assignees.filter(a => !oldAssigneesAll.includes(a));
      if (newAssignees.length) {
        // Defer to background — assigning N people no longer adds N sequential
        // DB roundtrips to the PUT response. Pool stays free for concurrent GETs.
        setImmediate(() => { (async () => {
          try {
            const assigner = await getUser(req.session.userId);
            const tkt = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
            const targets = (await Promise.all(
              newAssignees.map(n => get('SELECT id,name,email FROM users WHERE name=?', n))
            )).filter(Boolean);
            for (const target of targets) {
              if (target.id === req.session.userId) continue;
              run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
                target.id, 'assigned', '👤', `${assigner?.name || 'Someone'} assigned you to "${tkt?.title || req.params.id}"`, req.params.id
              ).catch(err => console.warn('[assign-notify] insert failed:', err && err.message));
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
              slackDmUser(target.id, {
                text: `🎫 *${assigner?.name || 'Someone'}* assigned you to <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${req.params.id}|${req.params.id}>${tkt?.title ? ' — ' + tkt.title : ''}`,
              }).catch(()=>{});
            }
          } catch (err) {
            console.warn('[new-assignee-fanout] failed:', err && err.message);
          }
        })(); });
      }
    }

    // ── Status change fan-out — deferred to background ──────────────────
    // Notify everyone tied to the ticket: assignees + reporter + REQUESTER,
    // minus the actor. Requester was missing before so the person who opened
    // the ticket never heard about status changes. setImmediate keeps the
    // PUT response fast even when many users need to be notified.
    if (status !== undefined && oldStatus && oldStatus !== status) {
      const _oldStatus = oldStatus;
      const _newStatus = status;
      const _oldClosedFlag = exists.closed_email_sent;
      setImmediate(() => { (async () => {
        try {
          const updated  = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
          const changer  = await getUser(req.session.userId);
          const currentAssignees = (await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', req.params.id)).map(a => a.user_name);
          const recipientNames = new Set([...currentAssignees, updated.reporter, updated.req].filter(Boolean));
          recipientNames.delete(changer?.name);
          // Resolve every recipient name → user row in parallel.
          const recipients = (await Promise.all(
            Array.from(recipientNames).map(n => get('SELECT id,name,email FROM users WHERE name=?', n))
          )).filter(r => r && r.email);
          for (const target of recipients) {
            fireEmail('status-changed', () => sendTicketStatusChangedEmail({
              toEmail: target.email, toName: target.name,
              changedByName: changer?.name || 'Someone',
              ticketId: req.params.id, title: updated.title || '',
              fromStatus: _oldStatus, toStatus: _newStatus,
            }));
            sendPushToUser(target.id, {
              title: `${updated.title || req.params.id}`,
              body: `${changer?.name || 'Someone'} changed status: ${_oldStatus} → ${_newStatus}`,
              tag: 'ticket-' + req.params.id,
              url: '/tickets/' + req.params.id,
            }).catch(()=>{});
            slackDmUser(target.id, {
              text: `🔄 *${changer?.name || 'Someone'}* moved <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${req.params.id}|${req.params.id}>${updated.title ? ' — ' + updated.title : ''} from *${_oldStatus}* to *${_newStatus}*`,
            }).catch(()=>{});
            run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
              target.id, 'status', '🔄', `${changer?.name || 'Someone'} moved "${updated.title || req.params.id}": ${_oldStatus} → ${_newStatus}`, req.params.id
            ).catch(err => console.warn('[status-notify] insert failed:', err && err.message));
          }
          // ticket-closed email (idempotent flag).
          if (String(_newStatus).toLowerCase() === 'closed' && !_oldClosedFlag) {
            run('UPDATE tickets SET closed_email_sent=1 WHERE id=?', req.params.id)
              .catch(err => console.warn('[status-notify] closed-flag update failed:', err && err.message));
            const createdAt = updated.created_at ? new Date(updated.created_at) : null;
            const daysOpen  = createdAt && !isNaN(createdAt) ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86400000)) : null;
            for (const target of recipients) {
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
        } catch (err) {
          console.warn('[status-fanout] failed:', err && err.message);
        }
      })(); });
    }

    // ── Generic field-changes notification (everything except status / new
    //    assignees, which have their own specific emails above) ──────────
    //    Sends in-app + email + push + Slack DM to every watcher
    //    (assignees + reporter + REQUESTER + creator, minus actor).
    const otherChanges = [];
    const cmp = (a, b) => String(a ?? '') !== String(b ?? '');
    if (title    !== undefined && cmp(exists.title,    title))    otherChanges.push('title');
    if (reqName  !== undefined && cmp(exists.req,      reqName))  otherChanges.push('requester');
    if (reporter !== undefined && cmp(exists.reporter, reporter)) otherChanges.push('reporter');
    if (priority !== undefined && cmp(exists.priority, priority)) otherChanges.push('priority');
    if (dept     !== undefined && cmp(exists.dept,     dept))     otherChanges.push('department');
    if (due      !== undefined && cmp(exists.due,      due))      otherChanges.push('due date');
    // Detect any assignee change (not just additions). The new-assignee
    // block above already emails the *added* assignees, but the requester
    // / reporter / creator never heard about it; this block fixes that.
    let assigneesChanged = false;
    if (assignees !== undefined) {
      const oldSorted = oldAssigneesAll.slice().sort();
      const newSorted = (assignees || []).slice().sort();
      assigneesChanged = (oldSorted.length !== newSorted.length) ||
                         oldSorted.some((a, i) => a !== newSorted[i]);
      if (assigneesChanged) otherChanges.push('assignees');
    }

    if (otherChanges.length > 0) {
      // Snapshot what we need before launching the background task so we
      // don't capture mutable state.
      const _changesCopy = otherChanges.slice();
      const _statusChanged = status !== undefined && oldStatus !== status;
      const _assigneesChanged = assignees !== undefined;
      const _addedAssignees = _assigneesChanged
        ? (assignees || []).filter(a => !oldAssigneesAll.includes(a))
        : [];
      // Background fan-out — never blocks the PUT response.
      setImmediate(() => { (async () => {
        try {
          const updated = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
          const changer = await getUser(req.session.userId);
          const currentAssignees = (await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', req.params.id)).map(a => a.user_name);
          // Resolve watchers in parallel: assignees + reporter + req + creator.
          const [resolvedAssignees, resolvedReporter, resolvedReq, resolvedCreator] = await Promise.all([
            Promise.all(currentAssignees.filter(Boolean).map(n => get('SELECT id,name,email FROM users WHERE name=?', n))),
            updated.reporter ? get('SELECT id,name,email FROM users WHERE name=?', updated.reporter) : null,
            updated.req      ? get('SELECT id,name,email FROM users WHERE name=?', updated.req)      : null,
            updated.created_by ? get('SELECT id,name,email FROM users WHERE id=?', updated.created_by) : null,
          ]);
          const watcherMap = new Map();
          [...resolvedAssignees, resolvedReporter, resolvedReq, resolvedCreator].filter(Boolean).forEach(w => {
            if (w.id !== req.session.userId) watcherMap.set(w.id, w);
          });
          // Skip email for users who already got the status-changed or new-
          // assignee specific email above so they aren't double-emailed.
          const skipEmailIds = new Set();
          if (_statusChanged) {
            [...currentAssignees, updated.reporter, updated.req].filter(Boolean).forEach(n => {
              const found = [...watcherMap.values()].find(w => w.name === n);
              if (found) skipEmailIds.add(found.id);
            });
          }
          if (_addedAssignees.length) {
            _addedAssignees.forEach(n => {
              const found = [...watcherMap.values()].find(w => w.name === n);
              if (found) skipEmailIds.add(found.id);
            });
          }
          const summary = _changesCopy.length === 1
            ? _changesCopy[0]
            : (_changesCopy.slice(0, -1).join(', ') + ' and ' + _changesCopy[_changesCopy.length - 1]);
          for (const w of watcherMap.values()) {
            run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
              w.id, 'ticket-updated', '🔔', `${changer?.name || 'Someone'} updated "${updated.title || req.params.id}": ${summary}`, req.params.id
            ).catch(err => console.warn('[ticket-update-notify] insert failed:', err && err.message));
            sendPushToUser(w.id, {
              title: `${updated.title || req.params.id}`,
              body: `${changer?.name || 'Someone'} updated ${summary}`,
              tag: 'ticket-' + req.params.id,
              url: '/tickets/' + req.params.id,
            }).catch(()=>{});
            slackDmUser(w.id, {
              text: `🔔 *${changer?.name || 'Someone'}* updated <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${req.params.id}|${req.params.id}>${updated.title ? ' — ' + updated.title : ''}: ${summary}`,
            }).catch(()=>{});
            if (!skipEmailIds.has(w.id)) {
              fireEmail('ticket-updated', () => sendTicketUpdatedEmail({
                toEmail: w.email, toName: w.name,
                changerName: changer?.name || 'Someone',
                ticketId: req.params.id, title: updated.title || '',
                changes: _changesCopy,
              }));
            }
          }
        } catch (err) {
          console.warn('[ticket-update-fanout] failed:', err && err.message);
        }
      })(); });
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

// ── Request update on a ticket ─────────────────────────────────────────────
// Anyone with access to a ticket can ping its assignees to ask for a status
// update. Each assignee gets an email + bell notification + push (if their
// PWA is subscribed). Requester is excluded from the recipient list — no
// point emailing yourself. Optional `note` is a free-text line included in
// the email.
//
// Cooldown: per-(requester, ticket) 5-minute throttle so an impatient mash
// doesn't spam the team. Tracked in-memory — if the server restarts the
// throttle resets, which is fine for a soft anti-spam guard.
const _UPDATE_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;
const _updateRequestLastSent = new Map(); // key: `${userId}:${ticketId}` → epoch ms
app.post('/api/tickets/:id/request-update', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const requester = await getUser(req.session.userId);
    if (!requester) return res.status(401).json({ error: 'Not signed in' });
    const cooldownKey = `${requester.id}:${ticketId}`;
    const last = _updateRequestLastSent.get(cooldownKey);
    if (last && Date.now() - last < _UPDATE_REQUEST_COOLDOWN_MS) {
      const waitSecs = Math.ceil((_UPDATE_REQUEST_COOLDOWN_MS - (Date.now() - last)) / 1000);
      return res.status(429).json({ error: `Please wait ${Math.ceil(waitSecs/60)} more minute(s) before asking for another update on this ticket.` });
    }
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const t = await get('SELECT * FROM tickets WHERE id=?', ticketId);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    // Build the recipient set: every distinct user assigned to this ticket
    // (multi-assignee table is the source of truth, but legacy `assignee`
    // single-name field still exists on some old tickets). Skip the
    // requester — there's no value emailing yourself.
    const assigneeRows = await all(
      `SELECT DISTINCT COALESCE(ta.user_id, u2.id) AS user_id, COALESCE(u1.name, ta.user_name) AS user_name
         FROM ticket_assignees ta
         LEFT JOIN users u1 ON u1.id = ta.user_id
         LEFT JOIN users u2 ON u2.name = ta.user_name
        WHERE ta.ticket_id = ?`,
      ticketId
    );
    // Legacy single-assignee fallback: include t.assignee if multi-assignee
    // table is empty (very old tickets).
    if (!assigneeRows.length && t.assignee) {
      const u = await get('SELECT id,name FROM users WHERE name=?', t.assignee);
      if (u) assigneeRows.push({ user_id: u.id, user_name: u.name });
    }
    const recipientIds = new Set();
    for (const r of assigneeRows) {
      if (r.user_id && r.user_id !== requester.id) recipientIds.add(r.user_id);
    }
    if (!recipientIds.size) {
      return res.status(400).json({ error: 'Nobody is assigned to this ticket — assign someone before requesting an update.' });
    }
    const recipientUsers = await all(
      `SELECT id,name,email FROM users WHERE id IN (${Array.from(recipientIds).map(() => '?').join(',')})`,
      ...Array.from(recipientIds)
    );
    // Fan out: bell notification, email, push. Each independently best-
    // effort so one failed channel doesn't block the others.
    const notifiedNames = [];
    for (const u of recipientUsers) {
      try {
        await run(
          'INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
          u.id, 'update-requested', '📩',
          `${requester.name || 'Someone'} requested an update on ${ticketId}${t.title ? ' — ' + t.title : ''}`,
          ticketId
        );
      } catch (e) { console.warn('[update-request] notification insert failed for', u.id, e.message); }
      fireEmail('update-requested', () => sendUpdateRequestedEmail({
        toEmail: u.email, toName: u.name,
        requesterName: requester.name || 'A teammate',
        ticketId, title: t.title || '',
        status: t.status || '', priority: t.priority || '',
        dueAt: t.due || '', dept: t.dept || '',
        note,
      }));
      sendPushToUser(u.id, {
        title: `Update requested on ${ticketId}`,
        body:  `${requester.name || 'A teammate'} is asking for an update`,
        tag:   'update-request-' + ticketId,
        url:   '/tickets/' + ticketId,
      }).catch(() => {});
      // Slack DM (no-op when SLACK_BOT_TOKEN unset).
      const _ticketUrl = (process.env.APP_URL || `http://localhost:${PORT}`) + '/tickets/' + ticketId;
      slackDmUser(u.id, {
        text: `📩 *${requester.name || 'A teammate'}* is asking for an update on <${_ticketUrl}|${ticketId}>${t.title ? ' — ' + t.title : ''}${note ? `\n> ${note}` : ''}`,
      }).catch(() => {});
      notifiedNames.push(u.name);
    }
    // Activity timeline entry — visible to anyone viewing the ticket detail.
    try {
      await run(
        'INSERT INTO ticket_timelines (ticket_id,dot,text,sub) VALUES (?,?,?,?)',
        ticketId, 'var(--accent)',
        `${requester.name || 'Someone'} requested an update${note ? ': ' + note : ''}`,
        'Just now'
      );
    } catch (e) { console.warn('[update-request] timeline insert failed:', e.message); }
    _updateRequestLastSent.set(cooldownKey, Date.now());
    res.json({ ok: true, notified: notifiedNames });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Personal reminders ("My Reminders") ─────────────────────────────────────
// A private per-user task list. Optionally linked to a ticket. Each reminder
// can carry voice notes / screen recordings / files (attachments table,
// reminder_id column). Privacy: ALL routes filter by user_id = current user.
// No admin override — these are personal notes, not workspace data.
// Returns a Date that is `n` business days before now (UTC). Walks
// backwards one calendar day at a time, decrementing the counter only
// on weekdays (Mon–Fri). Used by the dashboard's "stale" cutoff so
// tickets aren't flagged as stale just because a weekend passed.
function nBusinessDaysAgo(n) {
  const d = new Date();
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay(); // 0 = Sun, 6 = Sat
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d;
}

function _normalizeDueAt(raw) {
  // Accept ISO datetime, 'YYYY-MM-DD HH:MM' (browser datetime-local), or
  // 'YYYY-MM-DD' (date-only, treated as 09:00 UTC). Returns a UTC string in
  // the same 'YYYY-MM-DD HH:MM:SS' shape the cron uses.
  if (!raw) return null;
  const s = String(raw).trim();
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = isDateOnly ? new Date(s + 'T09:00:00Z') : new Date(s);
  if (isNaN(d)) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function _serializeReminder(r, attachments = []) {
  return {
    id: r.id,
    ticketId: r.ticket_id || null,
    title: r.title || '',
    description: r.description || '',
    dueAt: r.due_at,
    emailEnabled: !!r.email_enabled,
    repeatDaily: !!r.repeat_daily,
    showDailyInApp: !!r.show_daily_in_app,
    completed: !!r.completed,
    completedAt: r.completed_at || null,
    lastEmailSentAt: r.last_email_sent_at || null,
    lastInAppShownAt: r.last_in_app_shown_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sourceEmailUrl: r.source_email_url || null,
    attachments: attachments.map(a => ({
      id: a.id, filename: a.filename, originalName: a.original_name,
      mimeType: a.mime_type, size: a.size, createdAt: a.created_at,
      url: `/uploads/${a.filename}`,
    })),
  };
}

// List the current user's reminders. Query params:
//   ticketId=TKT-123  → only reminders for this ticket (still owner-scoped)
//   filter=open|done|all  (default: open)
app.get('/api/my-reminders', requireAuth, async (req, res) => {
  try {
    const { ticketId, filter } = req.query;
    const where = ['user_id=?'];
    const args = [req.session.userId];
    if (ticketId) { where.push('ticket_id=?'); args.push(String(ticketId)); }
    const f = String(filter || 'open').toLowerCase();
    if (f === 'open')      where.push('completed=0');
    else if (f === 'done') where.push('completed=1');
    // else 'all': no completed filter
    const rows = await all(
      `SELECT * FROM personal_reminders WHERE ${where.join(' AND ')} ORDER BY completed ASC, due_at ASC, id DESC LIMIT 500`,
      ...args
    );
    if (!rows.length) return res.json([]);
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const atts = await all(
      `SELECT * FROM attachments WHERE reminder_id IN (${placeholders}) ORDER BY created_at ASC`,
      ...ids
    );
    const byReminder = new Map();
    for (const a of atts) {
      const arr = byReminder.get(a.reminder_id) || [];
      arr.push(a);
      byReminder.set(a.reminder_id, arr);
    }
    res.json(rows.map(r => _serializeReminder(r, byReminder.get(r.id) || [])));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Single reminder by id (with attachments). Owner-only.
app.get('/api/my-reminders/:id', requireAuth, async (req, res) => {
  try {
    const r = await get('SELECT * FROM personal_reminders WHERE id=? AND user_id=?',
      Number(req.params.id), req.session.userId);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const atts = await all('SELECT * FROM attachments WHERE reminder_id=? ORDER BY created_at ASC', r.id);
    res.json(_serializeReminder(r, atts));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create. Body: { title, description, dueAt, ticketId?, emailEnabled,
// repeatDaily, showDailyInApp }. Title required, dueAt required.
app.post('/api/my-reminders', requireAuth, async (req, res) => {
  try {
    const {
      title, description, dueAt, ticketId,
      emailEnabled, repeatDaily, showDailyInApp,
    } = req.body || {};
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return res.status(400).json({ error: 'title required' });
    const stored = _normalizeDueAt(dueAt);
    if (!stored) return res.status(400).json({ error: 'dueAt required (YYYY-MM-DD or ISO datetime)' });
    // If linking to a ticket, verify the user has access to it. Without this
    // a worker could observe ticket existence by id-guessing.
    if (ticketId) {
      if (!await canAccessTicket(req, String(ticketId))) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
    }
    const info = await run(
      `INSERT INTO personal_reminders
         (user_id, ticket_id, title, description, due_at,
          email_enabled, repeat_daily, show_daily_in_app)
       VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
      req.session.userId,
      ticketId ? String(ticketId) : null,
      cleanTitle.slice(0, 200),
      String(description || '').slice(0, 5000),
      stored,
      emailEnabled === false ? 0 : 1,
      repeatDaily ? 1 : 0,
      showDailyInApp ? 1 : 0,
    );
    const row = await get('SELECT * FROM personal_reminders WHERE id=?', Number(info.lastInsertRowid));
    res.status(201).json(_serializeReminder(row, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update. Owner-only. Any of the writable fields may be patched. Sending
// completed:true sets completed_at; completed:false clears it (reopen).
app.put('/api/my-reminders/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const own = await get('SELECT * FROM personal_reminders WHERE id=? AND user_id=?', id, req.session.userId);
    if (!own) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const u = [];
    const v = [];
    if (b.title !== undefined) {
      const t = String(b.title || '').trim();
      if (!t) return res.status(400).json({ error: 'title cannot be empty' });
      u.push('title=?'); v.push(t.slice(0, 200));
    }
    if (b.description !== undefined) { u.push('description=?'); v.push(String(b.description || '').slice(0, 5000)); }
    if (b.dueAt !== undefined) {
      const stored = _normalizeDueAt(b.dueAt);
      if (!stored) return res.status(400).json({ error: 'Invalid dueAt' });
      u.push('due_at=?'); v.push(stored);
      // Editing dueAt resets the email high-water mark so the new time fires.
      u.push('last_email_sent_at=?'); v.push(null);
    }
    if (b.ticketId !== undefined) {
      if (b.ticketId && !await canAccessTicket(req, String(b.ticketId))) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      u.push('ticket_id=?'); v.push(b.ticketId ? String(b.ticketId) : null);
    }
    if (b.emailEnabled !== undefined)  { u.push('email_enabled=?');     v.push(b.emailEnabled ? 1 : 0); }
    if (b.repeatDaily !== undefined)   { u.push('repeat_daily=?');      v.push(b.repeatDaily ? 1 : 0); }
    if (b.showDailyInApp !== undefined){ u.push('show_daily_in_app=?'); v.push(b.showDailyInApp ? 1 : 0); }
    if (b.completed !== undefined) {
      u.push('completed=?'); v.push(b.completed ? 1 : 0);
      if (b.completed) {
        u.push("completed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
      } else {
        u.push('completed_at=?'); v.push(null);
      }
    }
    if (!u.length) return res.json(_serializeReminder(own, []));
    u.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
    v.push(id, req.session.userId);
    await run(`UPDATE personal_reminders SET ${u.join(', ')} WHERE id=? AND user_id=?`, ...v);
    const row = await get('SELECT * FROM personal_reminders WHERE id=?', id);
    const atts = await all('SELECT * FROM attachments WHERE reminder_id=? ORDER BY created_at ASC', id);
    res.json(_serializeReminder(row, atts));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete. Cascades to attachment files on disk + rows.
app.delete('/api/my-reminders/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const own = await get('SELECT id FROM personal_reminders WHERE id=? AND user_id=?', id, req.session.userId);
    if (!own) return res.json({ ok: true }); // already gone or not yours
    const atts = await all('SELECT filename FROM attachments WHERE reminder_id=?', id);
    for (const a of atts) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, a.filename)); } catch {}
    }
    await run('DELETE FROM attachments WHERE reminder_id=?', id);
    await run('DELETE FROM personal_reminders WHERE id=? AND user_id=?', id, req.session.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily in-app popup feed: reminders the current user has flagged
// show_daily_in_app, that aren't completed, and that haven't been shown
// today yet (per the user's wall clock — comparison is on the date prefix
// of last_in_app_shown_at vs the request's local-day key sent by the
// client). Returned in due-date order so today's overdue ones come first.
app.get('/api/my-reminders/today-popup/list', requireAuth, async (req, res) => {
  try {
    // The client passes its local YYYY-MM-DD as ?dayKey= to handle TZ
    // differences. Fall back to UTC today when missing.
    const dayKey = String(req.query.dayKey || '').match(/^\d{4}-\d{2}-\d{2}$/)
      ? String(req.query.dayKey)
      : new Date().toISOString().slice(0, 10);
    const rows = await all(
      `SELECT * FROM personal_reminders
        WHERE user_id=? AND completed=0 AND show_daily_in_app=1
          AND (last_in_app_shown_at IS NULL OR SUBSTR(last_in_app_shown_at, 1, 10) < ?)
        ORDER BY due_at ASC, id ASC`,
      req.session.userId, dayKey
    );
    res.json(rows.map(r => _serializeReminder(r, [])));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark a reminder as having been shown in the daily popup today. Doesn't
// complete it — just bumps last_in_app_shown_at so it doesn't reappear
// until tomorrow. Owner-only.
app.post('/api/my-reminders/:id/seen-today', requireAuth, async (req, res) => {
  try {
    await run(
      `UPDATE personal_reminders
          SET last_in_app_shown_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        WHERE id=? AND user_id=?`,
      Number(req.params.id), req.session.userId
    );
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
    // Snapshot before so we can log meaningful changes to the timeline.
    // A description rewrite is significant for audit; we log "updated"
    // rather than the full text (no need to dump multi-line bodies into
    // the activity feed).
    const before = await get('SELECT description, checklist_json FROM ticket_details WHERE ticket_id=?', req.params.id);
    await run(`INSERT INTO ticket_details (ticket_id,description,checklist_json) VALUES (?,?,?)
         ON CONFLICT(ticket_id) DO UPDATE SET description=EXCLUDED.description,checklist_json=EXCLUDED.checklist_json`,
      req.params.id, description||'', JSON.stringify(checklist||[]));
    try {
      const actor = (await getUser(req.session.userId))?.name || 'someone';
      const oldDesc = (before?.description || '').trim();
      const newDesc = String(description || '').trim();
      if (oldDesc !== newDesc) {
        writeTimeline(req.params.id, TL.status,
          oldDesc ? `${actor} updated the description` : `${actor} added a description`);
      }
      let oldCl = [];
      try { oldCl = JSON.parse(before?.checklist_json || '[]'); } catch {}
      const newCl = Array.isArray(checklist) ? checklist : [];
      if (oldCl.length !== newCl.length) {
        const delta = newCl.length - oldCl.length;
        writeTimeline(req.params.id, TL.status,
          `${actor} ${delta > 0 ? `added ${delta} checklist item${delta === 1 ? '' : 's'}` : `removed ${-delta} checklist item${delta === -1 ? '' : 's'}`}`);
      }
    } catch {}
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
    // Pull every attachment that's linked to a comment in this ticket, so
    // the client can render them inline under their parent comment.
    const commentIds = rows.map(r => r.id);
    const attsByComment = new Map();
    if (commentIds.length) {
      const ph = commentIds.map(() => '?').join(',');
      const atts = await all(
        `SELECT id, comment_id, filename, original_name, mime_type, size, uploader, created_at
           FROM attachments WHERE comment_id IN (${ph})
           ORDER BY id ASC`,
        ...commentIds
      );
      for (const a of atts) {
        if (!attsByComment.has(a.comment_id)) attsByComment.set(a.comment_id, []);
        attsByComment.get(a.comment_id).push({
          id: a.id,
          originalName: a.original_name || a.filename,
          mimeType: a.mime_type || '',
          size: a.size || 0,
          uploader: a.uploader || '',
          url: '/uploads/' + a.filename,
        });
      }
    }
    res.json(rows.map(r => ({
      id:r.id, parentId: r.parent_id || null,
      author: r.author_name_now || r.author,
      init: r.author_init, bg: r.author_bg, col: r.author_col,
      text: r.text,
      attachments: attsByComment.get(r.id) || [],
      // Raw UTC stamp — client formats this in the user's local time.
      // `time` retained as a server-formatted fallback for any legacy
      // caller, but the client prefers createdAt when present.
      createdAt: r.created_at,
      time: timeAgo(r.created_at),
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

    // Auto-mention when the commenter didn't explicitly @-mention anyone
    // in the workspace. Who we mention depends on context:
    //   - reply (parent comment present)  → the parent comment's author
    //   - top-level comment               → the ticket's requester
    // The mention chip is prepended to the saved text so it reads like
    // an explicit "@Name —" reply, and the existing mention-fan-out
    // further below picks the target up through the same code path
    // (notification, email, push, slack DM, ticket_watcher row).
    let commentText = text.trim();
    let autoMentionUserId = null;
    let tkt = null;
    if (safeParentId) {
      const parent = await get(
        `SELECT COALESCE(tc.author_user_id,
                         (SELECT id FROM users WHERE name = tc.author ORDER BY id ASC LIMIT 1)) AS author_id
           FROM ticket_comments tc WHERE tc.id = ?`,
        safeParentId
      );
      if (parent && parent.author_id) autoMentionUserId = parent.author_id;
    } else {
      tkt = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
      if (tkt && tkt.req_user_id) autoMentionUserId = tkt.req_user_id;
    }
    if (autoMentionUserId && autoMentionUserId !== u.id) {
      const rawCaptures = (commentText.match(/@([A-Za-z]+(?: [A-Za-z]+)*)/g) || []).map(m => m.slice(1));
      let alreadyMentions = false;
      for (const captured of rawCaptures) {
        const words = captured.split(' ');
        for (let len = words.length; len >= 1; len--) {
          const candidate = words.slice(0, len).join(' ');
          if (await get('SELECT id FROM users WHERE name=? LIMIT 1', candidate)) {
            alreadyMentions = true; break;
          }
        }
        if (alreadyMentions) break;
      }
      if (!alreadyMentions) {
        const targetName = await nameForUserId(autoMentionUserId, '');
        if (targetName) {
          commentText = '@' + targetName + (commentText ? ' ' + commentText : '');
        }
      }
    }
    // Ensure tkt is loaded for the fan-out logic below (we may have only
    // queried for the parent comment above).
    if (!tkt) tkt = await get('SELECT * FROM tickets WHERE id=?', req.params.id);

    const info = await run(`INSERT INTO ticket_comments (ticket_id,author,author_user_id,author_init,author_bg,author_col,text,parent_id) VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
      req.params.id, u.name, u.id, init, bg, col, commentText, safeParentId);
    await run('UPDATE tickets SET comments_count=comments_count+1 WHERE id=?', req.params.id);
    writeTimeline(req.params.id, TL.comment, `${u.name} commented${safeParentId ? ' (reply)' : ''}`);

    // ── All comment fan-out (mentions, reply, watchers) runs in the
    //    background so the POST returns immediately. Sequential awaits
    //    here used to add seconds per request and starved the pg pool;
    //    GETs on a slow Render-tier started timing out, which surfaced
    //    as "I have to refresh many times to see comments". ────────────
    const commentId = Number(info.lastInsertRowid);
    setImmediate(() => { (async () => {
      try {
        const emailedUserIds = new Set([req.session.userId]);

        // ── @-mentions: longest-prefix match against users.name ───────────
        const mentionRaw = (commentText.match(/@([A-Za-z]+(?: [A-Za-z]+)*)/g) || []).map(m => m.slice(1));
        const matchedNames = new Set();
        for (const captured of mentionRaw) {
          const words = captured.split(' ');
          for (let len = words.length; len >= 1; len--) {
            const candidate = words.slice(0, len).join(' ');
            const found = await get('SELECT name FROM users WHERE name=? LIMIT 1', candidate);
            if (found) { matchedNames.add(found.name); break; }
          }
        }
        // Resolve all matched users in parallel.
        const mentionedUsers = (await Promise.all(
          Array.from(matchedNames).map(n => get('SELECT id,name,email,role,dept FROM users WHERE name=?', n))
        )).filter(Boolean);
        // Subscribe every mentioned user to this ticket: a watcher row
        // grants them read access (see canAccessTicket) AND keeps them in
        // the comment fan-out for future activity. Idempotent on the
        // (ticket_id, user_id) primary key, so re-mentioning is a no-op.
        for (const m of mentionedUsers) {
          run(
            "INSERT INTO ticket_watchers (ticket_id, user_id, source) VALUES (?,?,?) ON CONFLICT (ticket_id, user_id) DO NOTHING",
            req.params.id, m.id, 'mention'
          ).catch(err => console.warn('[watcher] insert failed:', err && err.message));
        }
        for (const m of mentionedUsers) {
          if (emailedUserIds.has(m.id)) continue;
          emailedUserIds.add(m.id);
          run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
            m.id, 'mention', '💬', `${u.name} mentioned you in "${tkt?.title || req.params.id}"`, req.params.id
          ).catch(err => console.warn('[mention-notify] insert failed:', err && err.message));
          fireEmail('mention', () => sendMentionEmail({
            toEmail: m.email, toName: m.name,
            authorName: u.name, authorRole: u.role || '', authorDept: u.dept || '',
            ticketId: req.params.id, title: tkt?.title || '',
            commentText: commentText,
          }));
          sendPushToUser(m.id, {
            title: `${u.name} mentioned you`,
            body: commentText.slice(0, 140),
            tag: 'ticket-' + req.params.id + '-cmt',
            url: '/tickets/' + req.params.id,
          }).catch(()=>{});
          slackDmUser(m.id, {
            text: `💬 *${u.name}* mentioned you on <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${req.params.id}|${req.params.id}>${tkt?.title ? ' — ' + tkt.title : ''}\n> ${commentText.slice(0, 280)}`,
          }).catch(()=>{});
        }

        // ── Reply-to-parent ──────────────────────────────────────────────
        if (safeParentId) {
          const parentInfo = await get(
            `SELECT u.id AS user_id, u.name AS name, u.email AS email, u.role AS role
               FROM ticket_comments tc
               JOIN users u ON u.id = COALESCE(tc.author_user_id,
                                               (SELECT id FROM users WHERE name = tc.author ORDER BY id ASC LIMIT 1))
              WHERE tc.id = ?`, safeParentId);
          if (parentInfo && !emailedUserIds.has(parentInfo.user_id)) {
            emailedUserIds.add(parentInfo.user_id);
            run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
              parentInfo.user_id, 'comment', '↩', `${u.name} replied to your comment on "${tkt?.title || req.params.id}"`, req.params.id
            ).catch(err => console.warn('[reply-notify] insert failed:', err && err.message));
            fireEmail('comment-reply', () => sendNewCommentEmail({
              toEmail: parentInfo.email, toName: parentInfo.name,
              authorName: u.name, authorRole: u.role || '',
              authorBg: bg, authorFg: col,
              ticketId: req.params.id, title: tkt?.title || '',
              commentText: commentText,
            }));
            sendPushToUser(parentInfo.user_id, {
              title: `${u.name} replied`,
              body: commentText.slice(0, 140),
              tag: 'ticket-' + req.params.id + '-cmt',
              url: '/tickets/' + req.params.id,
            }).catch(()=>{});
            slackDmUser(parentInfo.user_id, {
              text: `↩ *${u.name}* replied to your comment on <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${req.params.id}|${req.params.id}>${tkt?.title ? ' — ' + tkt.title : ''}\n> ${commentText.slice(0, 280)}`,
            }).catch(()=>{});
          }
        }

        // ── Watcher fan-out: assignees + reporter + requester + creator ──
        // + anyone who's been @-mentioned on the ticket previously (now
        // a real watcher row, see ticket_watchers). Once you're pulled
        // in by a mention you keep getting notified on future activity —
        // same model as GitHub / Linear / Jira.
        const watchers = new Set();
        const assigneesRows = await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', req.params.id);
        assigneesRows.forEach(r => r.user_name && watchers.add(r.user_name));
        if (tkt?.reporter) watchers.add(tkt.reporter);
        if (tkt?.req)      watchers.add(tkt.req);
        const [resolvedWatchers, creatorUser, mentionWatcherUsers] = await Promise.all([
          Promise.all(Array.from(watchers).map(n => get('SELECT id,name,email FROM users WHERE name=?', n))),
          tkt?.created_by ? get('SELECT id,name,email FROM users WHERE id=?', tkt.created_by) : Promise.resolve(null),
          all(`SELECT u.id, u.name, u.email
                 FROM ticket_watchers tw JOIN users u ON u.id = tw.user_id
                WHERE tw.ticket_id = ?`, req.params.id),
        ]);
        const watcherUsers = resolvedWatchers.filter(Boolean);
        if (creatorUser && !watcherUsers.some(w => w.id === creatorUser.id)) {
          watcherUsers.push(creatorUser);
        }
        for (const mw of (mentionWatcherUsers || [])) {
          if (!watcherUsers.some(w => w.id === mw.id)) watcherUsers.push(mw);
        }
        for (const w of watcherUsers) {
          if (emailedUserIds.has(w.id)) continue;
          emailedUserIds.add(w.id);
          run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
            w.id, 'comment', '💬', `${u.name} commented on "${tkt?.title || req.params.id}"`, req.params.id
          ).catch(err => console.warn('[comment-notify] insert failed:', err && err.message));
          fireEmail('new-comment', () => sendNewCommentEmail({
            toEmail: w.email, toName: w.name,
            authorName: u.name, authorRole: u.role || '',
            authorBg: bg, authorFg: col,
            ticketId: req.params.id, title: tkt?.title || '',
            commentText: commentText,
          }));
          sendPushToUser(w.id, {
            title: `${u.name} commented on ${tkt?.title || req.params.id}`,
            body: commentText.slice(0, 140),
            tag: 'ticket-' + req.params.id + '-cmt',
            url: '/tickets/' + req.params.id,
          }).catch(()=>{});
          slackDmUser(w.id, {
            text: `💬 *${u.name}* commented on <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${req.params.id}|${req.params.id}>${tkt?.title ? ' — ' + tkt.title : ''}\n> ${commentText.slice(0, 280)}`,
          }).catch(()=>{});
        }
      } catch (err) {
        console.warn('[comment-fanout] failed:', err && err.message);
      }
    })(); });

    // Compute "newly mentioned" users — workspace users this comment
    // @-mentioned who weren't on the ticket in ANY role before this
    // comment (not assignee/additional/reporter/requester/creator, not
    // an existing watcher from a prior mention). The client uses this
    // to prompt the admin "add @Bob as an assignee?" so casual one-off
    // mentions don't silently become permanent ticket-watcher subscriptions.
    const newlyMentioned = await (async () => {
      const captures = (commentText.match(/@([A-Za-z]+(?: [A-Za-z]+)*)/g) || []).map(s => s.slice(1));
      if (!captures.length) return [];
      const matched = new Set();
      for (const cap of captures) {
        const words = cap.split(' ');
        for (let len = words.length; len >= 1; len--) {
          const cand = words.slice(0, len).join(' ');
          const found = await get('SELECT id, name FROM users WHERE name=? LIMIT 1', cand);
          if (found) { matched.add(found.id + '|' + found.name); break; }
        }
      }
      if (!matched.size) return [];
      const out = [];
      const tktForCheck = tkt || await get('SELECT * FROM tickets WHERE id=?', req.params.id);
      for (const key of matched) {
        const [idStr, name] = key.split('|');
        const uid = parseInt(idStr, 10);
        if (uid === u.id) continue;  // self-mention doesn't prompt
        if (tktForCheck.assignee_user_id === uid) continue;
        if (!tktForCheck.assignee_user_id && tktForCheck.assignee === name) continue;
        if (tktForCheck.reporter_user_id === uid) continue;
        if (!tktForCheck.reporter_user_id && tktForCheck.reporter === name) continue;
        if (tktForCheck.req_user_id === uid) continue;
        if (!tktForCheck.req_user_id && tktForCheck.req === name) continue;
        if (tktForCheck.created_by === uid) continue;
        const ta = await get(
          `SELECT 1 FROM ticket_assignees WHERE ticket_id=? AND (user_id=? OR (user_id IS NULL AND user_name=?))`,
          req.params.id, uid, name
        );
        if (ta) continue;
        const tw = await get(
          `SELECT 1 FROM ticket_watchers WHERE ticket_id=? AND user_id=?`,
          req.params.id, uid
        );
        if (tw) continue;
        out.push({ id: uid, name });
      }
      return out;
    })();

    const _nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    res.status(201).json({ id:Number(info.lastInsertRowid), parentId: safeParentId, author:u.name, init, bg, col, text:commentText, createdAt: _nowUtc, time: formatUSDateTime(new Date().toISOString()), newlyMentioned });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets/:id/comments/:commentId', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const comment = await get('SELECT id, author_user_id, text FROM ticket_comments WHERE id=? AND ticket_id=?', req.params.commentId, req.params.id);
    if (!comment) return res.status(404).json({ error:'Comment not found' });
    // Only the original author or an admin/manager can delete a comment.
    // Without this gate any teammate with ticket access could erase
    // someone else's words.
    const u = await getUser(req.session.userId);
    const isAdmin = u && ['Admin','Manager'].includes(u.perm_role);
    const isAuthor = comment.author_user_id && comment.author_user_id === req.session.userId;
    if (!isAdmin && !isAuthor) return res.status(403).json({ error: 'Only the author or an admin can delete this comment.' });

    // Cascade-delete any attachment owned by this comment. Two flavours:
    //   1. Direct rows: attachments.comment_id = this comment id (rare —
    //      attachments uploaded as part of the comment send flow get
    //      tagged this way only when the client passes commentId).
    //   2. Voice notes / screen recordings posted as VOICENOTE::<url> /
    //      SCREENRECORD::<url> comments. The attachment was uploaded
    //      *before* the comment existed, so comment_id is NULL. Match
    //      it by URL → filename → row instead.
    const orphanIds = new Set();
    const orphanFiles = [];
    const direct = await all('SELECT id, filename FROM attachments WHERE comment_id=?', req.params.commentId);
    for (const a of direct) { orphanIds.add(a.id); orphanFiles.push(a.filename); }

    const t = String(comment.text || '');
    const m = t.match(/^(?:VOICENOTE|SCREENRECORD)::(\S+)/);
    if (m) {
      // The stored URL is /uploads/<filename> — strip everything up to and
      // including the last slash to get the on-disk filename.
      const urlPath = m[1];
      const filename = urlPath.split('/').filter(Boolean).pop();
      if (filename) {
        const linked = await all(
          'SELECT id, filename FROM attachments WHERE filename=? AND ticket_id=?',
          filename, req.params.id
        );
        for (const a of linked) { orphanIds.add(a.id); orphanFiles.push(a.filename); }
      }
    }

    for (const f of orphanFiles) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {}
    }
    if (orphanIds.size) {
      const ids = Array.from(orphanIds);
      const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
      await run(`DELETE FROM attachments WHERE id IN (${placeholders})`, ...ids);
    }

    await run('DELETE FROM ticket_comments WHERE id=?', req.params.commentId);
    await run('UPDATE tickets SET comments_count=GREATEST(0,comments_count-1) WHERE id=?', req.params.id);
    res.json({ ok:true, removedAttachments: orphanIds.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id/timeline', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM ticket_timelines WHERE ticket_id=? ORDER BY created_at DESC', req.params.id);
    if (!rows.length) {
      const t = await get('SELECT * FROM tickets WHERE id=?', req.params.id);
      if (t) return res.json([{
        dot: 'var(--green)', text: 'Ticket created',
        // Raw UTC stamp — client formats in user's local time. `sub`
        // retained as a fallback for any legacy renderer.
        createdAt: t.created_at,
        sub: formatUSDateTime(t.created_at) || t.created,
      }]);
    }
    res.json(rows.map(r => ({
      id: r.id, dot: r.dot, text: r.text,
      createdAt: r.created_at,
      sub: formatUSDateTime(r.created_at) || r.sub,
    })));
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

// ── AI polish (Google-Docs-style "Help me write" for any textarea) ─────────
// Sends the user's text to Anthropic Claude Haiku and returns a polished
// version (clearer, more professional, same meaning). Powers the "✨
// Polish" button in comment / description / feedback / reminder editors.
//
// Set ANTHROPIC_API_KEY on Render to enable. Without it the endpoint
// returns 503 and the client button shows a friendly error — no other
// flow breaks.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const polishReady = !!ANTHROPIC_API_KEY;
console.log(`[polish] ${polishReady ? 'enabled' : 'disabled (no ANTHROPIC_API_KEY)'}`);

app.post('/api/polish', requireAuth, async (req, res) => {
  if (!polishReady) {
    return res.status(503).json({ error: 'Polish disabled — ANTHROPIC_API_KEY not set on server.' });
  }
  try {
    const { text, mode } = req.body || {};
    const cleanText = String(text || '').trim();
    if (!cleanText) return res.status(400).json({ error: 'text required' });
    if (cleanText.length > 5000) return res.status(400).json({ error: 'text too long (max 5000 chars)' });
    if (cleanText.length < 3)   return res.status(400).json({ error: 'text too short to polish' });

    // Mode tweaks the system prompt:
    //   light       → spell + grammar fixes only, almost no rewriting.
    //                 Used by the "✓ Polish" button.
    //   comment     → full Google-Polish-style rewrite, sentence-by-
    //                 sentence. Used by "✨ Rewrite" on comments.
    //   description → same heavy rewrite + permission to reorganize
    //                 into paragraphs / bullets. Used by "✨ Rewrite"
    //                 on long-form description fields.
    //
    // CRITICAL: every prompt forbids refusal / clarifying questions. If
    // the input is too short or ambiguous, the AI must return it with
    // at most a typo fix — never replace the user's draft with "I need
    // more info"-style help requests.
    const HARD_RULES = " ABSOLUTE RULES — never break these: (1) NEVER refuse. (2) NEVER ask questions or request more information. (3) NEVER add explanations, preambles, apologies, or meta-commentary. (4) NEVER address the user as 'you' or talk about yourself ('I'). (5) If the input is too short, vague, or already good, return it with at most minor typo / spelling fixes. (6) Output is ALWAYS something the user can send as-is.";
    let systemPrompt;
    if (mode === 'light') {
      systemPrompt = "You are a spell-check and minor-grammar editor for messages in a work-management app. Make ONLY conservative fixes: typos, obvious spelling mistakes, missing punctuation, basic subject-verb agreement, and capital letters at sentence starts. DO NOT rephrase, DO NOT restructure, DO NOT add or remove words beyond what's needed for the fix, DO NOT change tone or style. Preserve sentence structure, casual phrasing, contractions, line breaks, ticket IDs (TKT-####), URLs, and @-mentions exactly. If the text already looks fine, return it unchanged. Output ONLY the corrected text — same length, same voice, same structure." + HARD_RULES;
    } else if (mode === 'description') {
      systemPrompt = "You polish ticket descriptions for a work-management app. Make the text clear, well-structured, and easy for a teammate to understand at first read — no back-and-forth needed. Fix grammar, awkward phrasing, and typos. Improve sentence flow and word choice. You may reorganize sentences, break long paragraphs into shorter ones, and use bullet points for lists. Aim for a friendly-professional tone (warm but not casual). Preserve all facts, ticket IDs (TKT-####), URLs, and @-mentions exactly. Never add information that wasn't there. Don't pad — be concise. Return ONLY the polished text — no preamble, no quotes, no commentary." + HARD_RULES;
    } else {
      systemPrompt = "You polish messages in a work-management app's comment thread. Rewrite the text so the recipient understands it instantly: clearer wording, smoother flow, friendlier tone (warm but professional). Fix grammar and typos. Tighten rambling sentences. You may rephrase liberally as long as the writer's intent and every fact stays intact. Preserve ticket IDs (TKT-####), URLs, and @-mentions exactly — don't reword these. Stay concise — don't add fluff or pleasantries that weren't there. Return ONLY the polished text — no preamble, no quotes, no commentary." + HARD_RULES;
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: cleanText }],
      }),
    });

    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.warn('[polish] Anthropic API error:', r.status, errBody.slice(0, 300));
      return res.status(502).json({ error: 'AI service returned ' + r.status });
    }

    const data = await r.json();
    const polished = (data.content?.[0]?.text || '').trim();
    if (!polished) return res.status(502).json({ error: 'AI returned empty response' });

    // Safety net: detect when the model ignored the prompt and replied as
    // an assistant ("I'd be happy to help, could you share more?"...)
    // instead of polishing. Symptoms:
    //   - Output starts with first-person "I/I'm/I'd" + assistant phrasing
    //   - Output starts with "Sure"/"Of course"/"To help"/"Could you"/"Please"/"Thanks"
    //   - Output ends with a question mark when the original didn't
    //   - Output contains phrases like "more information", "more context",
    //     "more details", "could you share/provide"
    // When detected, fall back to the original text so the user's draft
    // is never destroyed. The polish silently no-ops in that case.
    const refusalRe = /^(I'?d be happy|I'?m happy|I'?d love|I'?ll need|I (need|can|could|would|may|am happy)|Sure(,| !)|Of course|To (help|polish|assist)|Could you|Please (provide|share|clarify)|Thanks for|Apologies)\b/i;
    const askedQuestion = polished.endsWith('?') && !cleanText.endsWith('?');
    const containsAsk = /\b(more (information|context|details)|could you (share|provide|clarify|tell)|please (share|provide|clarify))\b/i.test(polished);
    if (refusalRe.test(polished) || askedQuestion || containsAsk) {
      console.warn('[polish] suspected refusal, returning original. snippet=', polished.slice(0, 200));
      return res.json({ polished: cleanText, fallback: true });
    }

    res.json({ polished });
  } catch (e) {
    console.warn('[polish] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── External apps (sidebar quick links) ────────────────────────────────────
// Workspace-wide list of links to other apps. Anyone authenticated can
// READ (the sidebar shows them to everyone). Only admins can CREATE,
// UPDATE, DELETE. Order by position ASC then id so a stable insertion
// order is preserved when admins haven't reordered.
app.get('/api/external-apps', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, url, icon, position FROM external_apps
        ORDER BY position ASC, id ASC`
    );
    res.json(rows.map(r => ({
      id: r.id, name: r.name, url: r.url, icon: r.icon || '', position: r.position || 0,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/external-apps', requireAdmin, async (req, res) => {
  try {
    const { name, url, icon } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanUrl = String(url || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'name required' });
    if (!cleanUrl) return res.status(400).json({ error: 'url required' });
    // Reject anything that doesn't look like an absolute URL — these are
    // sidebar links that get target=_blank, so a relative path or a
    // javascript:… URL would be either useless or unsafe.
    if (!/^https?:\/\//i.test(cleanUrl)) {
      return res.status(400).json({ error: 'url must start with http:// or https://' });
    }
    // New rows go to the end. Position = max(existing) + 1.
    const maxRow = await get('SELECT COALESCE(MAX(position), 0) AS m FROM external_apps');
    const nextPos = (maxRow?.m || 0) + 1;
    const info = await run(
      `INSERT INTO external_apps (name, url, icon, position, created_by)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      cleanName.slice(0, 80), cleanUrl.slice(0, 500),
      String(icon || '').slice(0, 8), nextPos, req.session.userId
    );
    res.status(201).json({ id: Number(info.lastInsertRowid), name: cleanName, url: cleanUrl, icon: icon || '', position: nextPos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/external-apps/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const exists = await get('SELECT id FROM external_apps WHERE id=?', id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const u = []; const v = [];
    if (b.name !== undefined) {
      const t = String(b.name || '').trim();
      if (!t) return res.status(400).json({ error: 'name cannot be empty' });
      u.push('name=?'); v.push(t.slice(0, 80));
    }
    if (b.url !== undefined) {
      const t = String(b.url || '').trim();
      if (!t || !/^https?:\/\//i.test(t)) {
        return res.status(400).json({ error: 'url must start with http:// or https://' });
      }
      u.push('url=?'); v.push(t.slice(0, 500));
    }
    if (b.icon !== undefined) { u.push('icon=?'); v.push(String(b.icon || '').slice(0, 8)); }
    if (b.position !== undefined) { u.push('position=?'); v.push(Number(b.position) || 0); }
    if (!u.length) return res.json({ ok: true });
    v.push(id);
    await run(`UPDATE external_apps SET ${u.join(', ')} WHERE id=?`, ...v);
    const row = await get('SELECT id,name,url,icon,position FROM external_apps WHERE id=?', id);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/external-apps/:id', requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM external_apps WHERE id=?', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const id = Number(req.params.id);
    const { status, kind, title, description } = req.body || {};
    // Snapshot before-state so we can email on a meaningful status change.
    const before = await get(
      `SELECT f.*, u.email AS creator_email, u.name AS creator_name
         FROM feedback_items f
         LEFT JOIN users u ON u.id = f.created_by_user_id
        WHERE f.id = ?`, id
    );
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
    v.push(id);
    await run(`UPDATE feedback_items SET ${u.join(',')} WHERE id=?`, ...v);
    // Email the original opener when status flipped to something else.
    if (before && status !== undefined && before.status !== String(status).toLowerCase()
        && before.creator_email && before.created_by_user_id !== req.session.userId) {
      const me = await getUser(req.session.userId);
      fireEmail('feedback-status', () => sendFeedbackStatusChangedEmail({
        toEmail: before.creator_email, toName: before.creator_name,
        feedbackId: id, kind: before.kind, title: before.title || '',
        prevStatus: before.status, newStatus: String(status).toLowerCase(),
        changedBy: me?.name || 'An admin',
      }));
    }
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
    const fb = await get(
      `SELECT f.*, u.email AS creator_email, u.name AS creator_name
         FROM feedback_items f
         LEFT JOIN users u ON u.id = f.created_by_user_id
        WHERE f.id = ?`, id
    );
    if (!fb) return res.status(404).json({ error: 'Not found' });
    const info = await run(
      `INSERT INTO feedback_comments (feedback_id, author_user_id, text) VALUES (?,?,?) RETURNING id`,
      id, req.session.userId, t
    );
    await run(`UPDATE feedback_items SET updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`, id);
    // Notify the opener when someone other than them replies. We skip
    // VOICENOTE::/SCREENRECORD:: marker comments so the user gets a
    // meaningful subject line — the media itself is included via the
    // attached file, and a separate text comment usually accompanies it.
    const isMarkerOnly = /^(VOICENOTE|SCREENRECORD)::\S+\s*$/.test(t);
    if (!isMarkerOnly && fb.creator_email && fb.created_by_user_id !== req.session.userId) {
      const me = await getUser(req.session.userId);
      fireEmail('feedback-reply', () => sendFeedbackReplyEmail({
        toEmail: fb.creator_email, toName: fb.creator_name,
        feedbackId: id, kind: fb.kind, title: fb.title || '',
        replyAuthor: me?.name || 'Someone', replyText: t,
      }));
    }
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

// ── Recurring project templates ─────────────────────────────────────────────
// Admin-curated bundles of tasks the team uses repeatedly. From the
// Projects page, an admin can spawn a new project + all its child
// tickets in one call by referencing a template id. Same idea as
// flavor_tasks but supports multiple named templates.
//
// Read-list is open to any authenticated user (so the spawn picker can
// show options); writes (template + task management) are admin-only.
app.get('/api/project-templates', requireAuth, async (req, res) => {
  try {
    const rows = await all(`
      SELECT pt.id, pt.name, pt.description, pt.created_at,
             COALESCE(tc.task_count, 0)::int AS task_count
        FROM project_templates pt
        LEFT JOIN (
          SELECT template_id, COUNT(*) AS task_count
            FROM project_template_tasks
           GROUP BY template_id
        ) tc ON tc.template_id = pt.id
       ORDER BY pt.id ASC`);
    res.json(rows.map(r => ({
      id: r.id, name: r.name, description: r.description || '',
      createdAt: r.created_at, taskCount: r.task_count,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/project-templates/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tpl = await get('SELECT id, name, description, created_at FROM project_templates WHERE id=?', id);
    if (!tpl) return res.status(404).json({ error: 'Not found' });
    const tasks = await all(
      `SELECT id, position, title_template, description, assignee, dept, priority, days_offset
         FROM project_template_tasks
        WHERE template_id=?
        ORDER BY position ASC, id ASC`, id
    );
    res.json({
      id: tpl.id, name: tpl.name, description: tpl.description || '',
      createdAt: tpl.created_at,
      tasks: tasks.map(t => ({
        id: t.id, position: t.position || 0,
        titleTemplate: t.title_template,
        description: t.description || '',
        assignee: t.assignee || '',
        dept: t.dept || 'General',
        priority: t.priority || 'Medium',
        daysOffset: Number(t.days_offset || 0),
      })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/project-templates', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const description = String(req.body?.description || '').trim();
    const info = await run(
      `INSERT INTO project_templates (name, description, created_by)
       VALUES (?, ?, ?) RETURNING id`,
      name.slice(0, 200), description.slice(0, 1000), req.session.userId
    );
    res.status(201).json({ id: Number(info.lastInsertRowid), name, description, taskCount: 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/project-templates/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const exists = await get('SELECT id FROM project_templates WHERE id=?', id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const u = []; const v = [];
    if (req.body?.name !== undefined) {
      const n = String(req.body.name || '').trim();
      if (!n) return res.status(400).json({ error: 'name cannot be empty' });
      u.push('name=?'); v.push(n.slice(0, 200));
    }
    if (req.body?.description !== undefined) {
      u.push('description=?'); v.push(String(req.body.description || '').slice(0, 1000));
    }
    if (!u.length) return res.json({ ok: true });
    v.push(id);
    await run(`UPDATE project_templates SET ${u.join(', ')} WHERE id=?`, ...v);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/project-templates/:id', requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM project_templates WHERE id=?', Number(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk replace the task list for a template. Body: { tasks: [{title,
// assignee, dept, priority, daysOffset, description}, ...] }. Like the
// flavor-tasks editor — drop everything, re-insert in the given order.
app.put('/api/project-templates/:id/tasks', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const exists = await get('SELECT id FROM project_templates WHERE id=?', id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    await withTx(async (tx) => {
      await tx.run('DELETE FROM project_template_tasks WHERE template_id=?', id);
      let pos = 1;
      for (const t of tasks) {
        const title = String(t?.title ?? t?.titleTemplate ?? '').trim();
        if (!title) continue;
        await tx.run(
          `INSERT INTO project_template_tasks
             (template_id, position, title_template, description, assignee, dept, priority, days_offset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id, pos++, title.slice(0, 300),
          String(t?.description || '').slice(0, 2000),
          String(t?.assignee || ''),
          String(t?.dept || 'General'),
          String(t?.priority || 'Medium'),
          Number(t?.daysOffset ?? t?.days_offset ?? 7) || 0
        );
      }
    });
    res.json({ ok: true, count: tasks.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Spawn a real project + child tickets from a template. Mirrors how
// /api/flavors creates tickets, but the parent is a project (is_project=1)
// and children carry parent_ticket_id pointing at it.
//
// Body: { templateId, projectName, dueDate?, tag? }
//   - dueDate (YYYY-MM-DD): used as the launch baseline for daysOffset.
//     Defaults to today if omitted.
//   - tag (string): added to every spawned ticket so they group in lists.
//     Defaults to "Project: {projectName}".
//
// Returns the parent project + the list of child tickets created.
app.post('/api/projects/from-template', requireAdmin, async (req, res) => {
  try {
    const templateId = Number(req.body?.templateId);
    const projectName = String(req.body?.projectName || '').trim();
    if (!templateId) return res.status(400).json({ error: 'templateId required' });
    if (!projectName) return res.status(400).json({ error: 'projectName required' });
    const tpl = await get('SELECT id, name FROM project_templates WHERE id=?', templateId);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    const tasks = await all(
      'SELECT * FROM project_template_tasks WHERE template_id=? ORDER BY position ASC, id ASC',
      templateId
    );
    if (!tasks.length) return res.status(409).json({ error: 'Template has no tasks. Add some in Settings → Recurring Projects.' });

    const u = await getUser(req.session.userId);
    const launchDate = (req.body?.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate))
      ? req.body.dueDate
      : new Date().toISOString().slice(0, 10);
    const launchMs = new Date(launchDate + 'T00:00:00').getTime();
    const tag = String(req.body?.tag || `Project: ${projectName}`).slice(0, 80);
    const createdStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const result = await withTx(async (tx) => {
      // Same advisory lock used by /api/tickets + /api/flavors so
      // concurrent spawns can't race on ticket-id allocation.
      await tx.run('SELECT pg_advisory_xact_lock(91501)');
      const maxRow = await tx.get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
      let nextNum = 1000;
      if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }

      // Parent project ticket. Title = the user-provided projectName.
      // Due date defaults to the latest child due so the project envelope
      // covers all the work inside it.
      nextNum += 1;
      const parentId = 'TKT-' + nextNum;
      const lastDueMs = launchMs + Math.max(0, ...tasks.map(t => Number(t.days_offset || 0))) * 86400000;
      const parentDue = new Date(lastDueMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      await tx.run(
        `INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,is_project,reporter_user_id,req_user_id)
         VALUES (?, ?, ?, '', ?, 'Medium', 'Open', 'General', ?, ?, 0, ?, 0, ?, 1, ?, ?)`,
        parentId, projectName, u?.name || '', u?.name || '',
        parentDue, createdStr, JSON.stringify([tag]), req.session.userId,
        u?.id || null, u?.id || null
      );
      await tx.run('INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?) ON CONFLICT DO NOTHING',
        parentId, `Spawned from template: ${tpl.name}`);

      const children = [];
      for (const row of tasks) {
        nextNum += 1;
        const tktId = 'TKT-' + nextNum;
        // {project} placeholder so templates can reference the project name.
        const title = (row.title_template || '').replace(/\{project\}/gi, projectName);
        const dueMs = launchMs + Number(row.days_offset || 0) * 86400000;
        const due = new Date(dueMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const assigneeRow = row.assignee
          ? await tx.get('SELECT id,name,email FROM users WHERE name=? ORDER BY id ASC LIMIT 1', row.assignee)
          : null;
        await tx.run(
          `INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id,parent_ticket_id)
           VALUES (?,?,?,?,?,?,'Open',?,?,?,0,?,0,?,?,?,?,?)`,
          tktId, title, u?.name || '', row.assignee || '', u?.name || '',
          row.priority || 'Medium', row.dept || 'General',
          due, createdStr, JSON.stringify([tag]), req.session.userId,
          assigneeRow?.id || null, u?.id || null, u?.id || null, parentId
        );
        await tx.run(
          'INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?) ON CONFLICT DO NOTHING',
          tktId, row.description || ''
        );
        if (row.assignee) {
          await tx.run(
            'INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
            tktId, row.assignee, assigneeRow?.id || null
          );
        }
        children.push({ id: tktId, title, assignee: row.assignee || '', due });
      }
      return { parentId, children };
    });

    res.status(201).json({
      ok: true,
      project: { id: result.parentId, title: projectName },
      children: result.children,
      templateName: tpl.name,
    });
  } catch(e) {
    console.error('[projects/from-template] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Workspace docs ─────────────────────────────────────────────────────────
// Notion / ClickUp-style document store. Anyone authenticated can read
// and write any doc. parent_id is wired in advance for future subpages
// but the current MVP renders a flat list ordered by most-recently-
// updated. A doc with body='' is treated as "Untitled / blank".
// Docs come in three flavors (column `type`):
//   markdown — inline markdown body, opens in the editor
//   file     — an uploaded file lives in attachments.doc_id; row click
//              opens the lightbox or downloads
//   link     — external URL (Google Sheets / Notion / etc.) in
//              external_url; row click opens in a new tab
// All three share the same list view; the title column carries the
// human-readable name, the type icon disambiguates.
//
// Visibility — public docs are visible to every authenticated user;
// private docs are visible only to: the creator, admins/managers, or
// users explicitly added via doc_shares. The /uploads/* file URL stays
// publicly fetchable regardless (so Office Online viewer can render).

// SQL fragment that filters docs by visibility for the current user.
// Inlined into the queries below; takes (userId, isAdmin0or1) twice.
const _docVisibilityWhere = `(
  d.visibility = 'public'
  OR ? = 1
  OR d.created_by = ?
  OR EXISTS (SELECT 1 FROM doc_shares s WHERE s.doc_id = d.id AND s.user_id = ?)
)`;
async function _canSeeDoc(userId, isAdmin, docId) {
  if (isAdmin) return true;
  const d = await get('SELECT created_by, visibility FROM docs WHERE id=?', docId);
  if (!d) return false;
  if (d.visibility === 'public') return true;
  if (d.created_by === userId) return true;
  const share = await get('SELECT 1 AS ok FROM doc_shares WHERE doc_id=? AND user_id=?', docId, userId);
  return !!share;
}
async function _canManageDoc(userId, isAdmin, docId) {
  if (isAdmin) return true;
  const d = await get('SELECT created_by FROM docs WHERE id=?', docId);
  return d && d.created_by === userId;
}

app.get('/api/docs', requireAuth, async (req, res) => {
  try {
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role) ? 1 : 0;
    const rows = await all(`
      SELECT d.id, d.title, d.parent_id, d.type, d.external_url, d.visibility, d.created_by, d.created_at, d.updated_at,
             cu.name AS created_by_name,
             uu.name AS updated_by_name
        FROM docs d
        LEFT JOIN users cu ON cu.id = d.created_by
        LEFT JOIN users uu ON uu.id = d.updated_by
       WHERE ${_docVisibilityWhere}
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT 500`,
      isAdmin, req.session.userId, req.session.userId);
    if (!rows.length) return res.json([]);
    // Bundle attached files in one batch query — list view shows the
    // filename / mime so the type icon can render correctly.
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const atts = await all(
      `SELECT id, doc_id, filename, original_name, mime_type, size
         FROM attachments WHERE doc_id IN (${placeholders})`,
      ...ids
    );
    const fileByDoc = new Map();
    for (const a of atts) fileByDoc.set(a.doc_id, a);
    res.json(rows.map(r => {
      const f = fileByDoc.get(r.id);
      return {
        id: r.id,
        title: r.title || 'Untitled',
        type: r.type || 'markdown',
        externalUrl: r.external_url || '',
        visibility: r.visibility || 'public',
        // Mark whether the current user owns or admins this doc — drives
        // whether the Share button is enabled on the row.
        canManage: !!(isAdmin || (r.created_by === req.session.userId)),
        parentId: r.parent_id || null,
        file: f ? {
          attachmentId: f.id, filename: f.filename,
          originalName: f.original_name || f.filename,
          mimeType: f.mime_type || '',
          size: f.size || 0,
          url: '/uploads/' + f.filename,
        } : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        createdBy: r.created_by_name || '',
        updatedBy: r.updated_by_name || '',
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docs/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (!await _canSeeDoc(req.session.userId, isAdmin, id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const r = await get(`
      SELECT d.id, d.title, d.body, d.parent_id, d.type, d.external_url, d.visibility, d.created_by, d.created_at, d.updated_at,
             cu.name AS created_by_name,
             uu.name AS updated_by_name
        FROM docs d
        LEFT JOIN users cu ON cu.id = d.created_by
        LEFT JOIN users uu ON uu.id = d.updated_by
       WHERE d.id=?`, id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const f = await get(
      'SELECT id, filename, original_name, mime_type, size FROM attachments WHERE doc_id=? ORDER BY id DESC LIMIT 1',
      id
    );
    res.json({
      id: r.id, title: r.title || 'Untitled', body: r.body || '',
      type: r.type || 'markdown',
      externalUrl: r.external_url || '',
      visibility: r.visibility || 'public',
      canManage: !!(isAdmin || (r.created_by === req.session.userId)),
      parentId: r.parent_id || null,
      file: f ? {
        attachmentId: f.id, filename: f.filename,
        originalName: f.original_name || f.filename,
        mimeType: f.mime_type || '',
        size: f.size || 0,
        url: '/uploads/' + f.filename,
      } : null,
      createdAt: r.created_at, updatedAt: r.updated_at,
      createdBy: r.created_by_name || '',
      updatedBy: r.updated_by_name || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Share-management endpoints. Only the doc creator (or an admin/manager)
// can read or write the share list. Returns the explicit user grants
// for a private doc (public docs return [] but the endpoint still works
// so the UI can flip a public→private and immediately add users).
app.get('/api/docs/:id/shares', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (!await _canManageDoc(req.session.userId, isAdmin, id)) {
      return res.status(403).json({ error: 'Only the doc creator or an admin can manage sharing.' });
    }
    const rows = await all(
      `SELECT s.user_id, u.name, u.email
         FROM doc_shares s
         JOIN users u ON u.id = s.user_id
        WHERE s.doc_id=?
        ORDER BY u.name ASC`, id);
    res.json(rows.map(r => ({ userId: r.user_id, name: r.name, email: r.email })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/docs/:id/shares', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userIdRaw = req.body?.userId;
    const userId = userIdRaw ? Number(userIdRaw) : null;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (!await _canManageDoc(req.session.userId, isAdmin, id)) {
      return res.status(403).json({ error: 'Only the doc creator or an admin can manage sharing.' });
    }
    const target = await get('SELECT id FROM users WHERE id=?', userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await run(
      `INSERT INTO doc_shares (doc_id, user_id, granted_by)
       VALUES (?, ?, ?)
       ON CONFLICT (doc_id, user_id) DO NOTHING`,
      id, userId, req.session.userId
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/docs/:id/shares/:userId', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = Number(req.params.userId);
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (!await _canManageDoc(req.session.userId, isAdmin, id)) {
      return res.status(403).json({ error: 'Only the doc creator or an admin can manage sharing.' });
    }
    await run('DELETE FROM doc_shares WHERE doc_id=? AND user_id=?', id, userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/docs', requireAuth, async (req, res) => {
  try {
    const title = String(req.body?.title || 'Untitled').trim() || 'Untitled';
    const body  = String(req.body?.body  || '');
    const parentId = req.body?.parentId ? Number(req.body.parentId) : null;
    const rawType = String(req.body?.type || 'markdown').toLowerCase();
    const type = ['markdown', 'file', 'link'].includes(rawType) ? rawType : 'markdown';
    const visibility = String(req.body?.visibility || 'public').toLowerCase() === 'private' ? 'private' : 'public';
    let externalUrl = '';
    if (type === 'link') {
      externalUrl = String(req.body?.externalUrl || '').trim();
      if (!externalUrl) return res.status(400).json({ error: 'externalUrl required for type=link' });
      if (!/^https?:\/\//i.test(externalUrl)) {
        return res.status(400).json({ error: 'externalUrl must start with http:// or https://' });
      }
    }
    const info = await run(
      `INSERT INTO docs (title, body, parent_id, type, external_url, visibility, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      title.slice(0, 200), body.slice(0, 200000), parentId,
      type, externalUrl.slice(0, 1000), visibility,
      req.session.userId, req.session.userId
    );
    const row = await get('SELECT id, title, body, type, external_url, visibility, created_at, updated_at FROM docs WHERE id=?', Number(info.lastInsertRowid));
    res.status(201).json({
      id: row.id, title: row.title, body: row.body || '',
      type: row.type, externalUrl: row.external_url || '',
      visibility: row.visibility,
      createdAt: row.created_at, updatedAt: row.updated_at,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Patch any of: title, body, externalUrl. Stamps updated_by + updated_at
// on every change so the list view's "last edited by X • date" stays
// accurate.
app.put('/api/docs/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const exists = await get('SELECT id, type FROM docs WHERE id=?', id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const u = []; const v = [];
    if (req.body?.title !== undefined) {
      const t = String(req.body.title || '').trim() || 'Untitled';
      u.push('title=?'); v.push(t.slice(0, 200));
    }
    if (req.body?.body !== undefined) {
      u.push('body=?'); v.push(String(req.body.body || '').slice(0, 200000));
    }
    if (req.body?.externalUrl !== undefined) {
      const url = String(req.body.externalUrl || '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'externalUrl must start with http:// or https://' });
      }
      u.push('external_url=?'); v.push(url.slice(0, 1000));
    }
    if (req.body?.visibility !== undefined) {
      // Only the doc creator (or admin) can change visibility — same
      // gate the share endpoints use.
      const me = await getUser(req.session.userId);
      const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
      if (!await _canManageDoc(req.session.userId, isAdmin, id)) {
        return res.status(403).json({ error: 'Only the doc creator or an admin can change visibility.' });
      }
      const vis = String(req.body.visibility).toLowerCase() === 'private' ? 'private' : 'public';
      u.push('visibility=?'); v.push(vis);
    }
    if (!u.length) return res.json({ ok: true });
    u.push('updated_by=?'); v.push(req.session.userId);
    u.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
    v.push(id);
    await run(`UPDATE docs SET ${u.join(', ')} WHERE id=?`, ...v);
    const row = await get('SELECT updated_at FROM docs WHERE id=?', id);
    res.json({ ok: true, updatedAt: row?.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/docs/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Cascade-clean any uploaded file from disk before dropping the row.
    // The attachments rows themselves cascade via FK, but the on-disk
    // files would otherwise leak.
    const atts = await all('SELECT filename FROM attachments WHERE doc_id=?', id);
    for (const a of atts) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, a.filename)); } catch {}
    }
    await run('DELETE FROM attachments WHERE doc_id=?', id);
    await run('DELETE FROM docs WHERE id=?', id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    // nicely.  IMPORTANT: the in-app calendar stores date_key as a
    // 0-indexed-month "YYYY-M-D" (May 19 → "2026-4-19"), NOT standard ISO.
    // Feeding that straight into `new Date(...)` returns Invalid Date,
    // which then bubbles through as `startAt: null` to the email helpers
    // and renders as "January 1, 1970".  Parse the parts by hand and
    // construct a proper local Date.
    function combineDateTime(dKey, tStr) {
      if (!dKey) return null;
      const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dKey).trim());
      if (!dm) return null;
      const y = Number(dm[1]);
      const mo = Number(dm[2]) + 1; // 0-indexed → 1-indexed
      const dd = Number(dm[3]);
      if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
      const cleanT = (tStr && /^\d{1,2}:\d{2}/.test(tStr)) ? tStr : '00:00';
      const tm = /^(\d{1,2}):(\d{2})/.exec(cleanT);
      const hh = Number(tm[1]), mm = Number(tm[2]);
      const d = new Date(y, mo - 1, dd, hh, mm, 0);
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
        // Combine date_key + start_time into a real Date so the email format
        // is nice. date_key is "YYYY-M-D" with a 0-indexed month (the
        // in-app calendar's storage shape, not standard ISO) — parsing it
        // straight with `new Date(...)` returns Invalid Date, which then
        // bubbles into the email as "January 1, 1970".
        let originalStart = null, originalEnd = null;
        const _dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(ev.date_key || '').trim());
        if (_dm) {
          const y = Number(_dm[1]);
          const mo = Number(_dm[2]) + 1;
          const dd = Number(_dm[3]);
          const buildAt = (tStr) => {
            if (!tStr || !/^\d{1,2}:\d{2}/.test(tStr)) return null;
            const tm = /^(\d{1,2}):(\d{2})/.exec(tStr);
            const d = new Date(y, mo - 1, dd, Number(tm[1]), Number(tm[2]), 0);
            return isNaN(d.getTime()) ? null : d;
          };
          originalStart = buildAt(ev.start_time || '00:00');
          originalEnd   = buildAt(ev.end_time);
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

// ── Calendar sync (ICS feed) ────────────────────────────────────────────────
// One-way export so any external calendar (Google, Apple, Outlook, Notion,
// Fantastical, etc.) can subscribe and show this user's app activity.
// The user gets a private secret-URL — token is the sole auth on the
// public feed endpoint — and can toggle which sources to include
// (calendar events, ticket due dates, personal reminders, recurring
// task next-run dates) on a per-user basis. A two-way Google Calendar
// API integration is planned as a follow-up; the schema is forward-
// compatible with that (we just keep adding columns).

const crypto = require('crypto');

function gcalDefaultSources() {
  return {
    meetings:  true,
    tasks:     true,
    deadlines: true,
    tickets:   true,
    reminders: false,
    recurring: false,
  };
}
function gcalParseSources(rawJson) {
  const def = gcalDefaultSources();
  try {
    const obj = JSON.parse(rawJson || '{}');
    // Backwards-compat: rows written before the per-type split carried a
    // single `events` flag covering meetings + tasks + deadlines. If we
    // see that shape and none of the new keys are present, expand it.
    const legacyPresent = ('events' in obj) && !('meetings' in obj) && !('tasks' in obj) && !('deadlines' in obj);
    if (legacyPresent) {
      const v = obj.events !== false;
      return {
        meetings: v, tasks: v, deadlines: v,
        tickets:   obj.tickets   !== false,
        reminders: !!obj.reminders,
        recurring: !!obj.recurring,
      };
    }
    return {
      meetings:  obj.meetings  !== false,
      tasks:     obj.tasks     !== false,
      deadlines: obj.deadlines !== false,
      tickets:   obj.tickets   !== false,
      reminders: !!obj.reminders,
      recurring: !!obj.recurring,
    };
  } catch { return def; }
}

// Lazily mint a 24-byte hex token the first time a user looks at their
// sync settings. Stored as a flat string on users.gcal_feed_token. The
// caller is responsible for fetching the user row.
async function gcalEnsureToken(userId) {
  const u = await get('SELECT gcal_feed_token FROM users WHERE id=?', userId);
  if (u && u.gcal_feed_token) return u.gcal_feed_token;
  const tok = crypto.randomBytes(24).toString('hex');
  await run('UPDATE users SET gcal_feed_token=? WHERE id=?', tok, userId);
  return tok;
}

function gcalFeedBaseUrl(req) {
  // Honour reverse-proxy headers so the URL we hand the user actually
  // works from outside the box. Falls back to the request host + scheme
  // when the headers aren't set.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.headers.host || '').toString().split(',')[0].trim();
  return `${proto}://${host}`;
}

// GET /api/calendar/sync-info — auth'd; returns the current user's
// feed URL + which sources are toggled on. Lazily creates the token.
app.get('/api/calendar/sync-info', requireAuth, async (req, res) => {
  try {
    const token = await gcalEnsureToken(req.session.userId);
    const u = await get('SELECT gcal_feed_sources_json, gcal_feed_last_fetched_at FROM users WHERE id=?', req.session.userId);
    const sources = gcalParseSources(u?.gcal_feed_sources_json);
    res.json({
      token,
      url: `${gcalFeedBaseUrl(req)}/api/calendar/feed/${token}.ics`,
      sources,
      // The timestamp the feed was last pulled by *any* external client
      // (Google, Apple, Outlook, manual curl…). The Sync-Now UI uses
      // this to honestly tell the user whether their feed has been
      // picked up yet, and roughly when Google polled last.
      lastFetchedAt: (u && u.gcal_feed_last_fetched_at) || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/calendar/sync-settings — saves which sources to include
// in the feed. Subsequent feed fetches reflect the new toggles
// immediately (Google polls on its own schedule, so visible-in-Google
// can lag by a few hours).
app.post('/api/calendar/sync-settings', requireAuth, async (req, res) => {
  try {
    const sources = gcalParseSources(JSON.stringify(req.body || {}));
    await run('UPDATE users SET gcal_feed_sources_json=? WHERE id=?', JSON.stringify(sources), req.session.userId);
    res.json({ ok: true, sources });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/calendar/sync-regenerate — invalidates the existing feed
// URL and mints a new one. Used when the user accidentally pasted the
// URL somewhere it shouldn't have gone.
app.post('/api/calendar/sync-regenerate', requireAuth, async (req, res) => {
  try {
    const tok = crypto.randomBytes(24).toString('hex');
    await run('UPDATE users SET gcal_feed_token=? WHERE id=?', tok, req.session.userId);
    res.json({
      token: tok,
      url: `${gcalFeedBaseUrl(req)}/api/calendar/feed/${tok}.ics`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helpers used by the .ics generator below ────────────────────────────────
function icsEscape(s) {
  // RFC 5545 §3.3.11: backslash, comma, semicolon need escaping; newlines
  // become \\n. Strip control chars Google rejects silently.
  return String(s == null ? '' : s)
    .replace(/[ --]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g,  '\\;')
    .replace(/,/g,  '\\,')
    .replace(/\r?\n/g, '\\n');
}
function icsFoldLine(line) {
  // RFC 5545 §3.1: lines must not exceed 75 octets; continue with " "
  // at the start of each fold. We measure bytes (UTF-8) to stay safe
  // with non-ASCII titles.
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const chunk = bytes.subarray(i, Math.min(i + 75, bytes.length)).toString('utf8');
    out.push(i === 0 ? chunk : ' ' + chunk);
    i += 75;
  }
  return out.join('\r\n');
}
function icsDateUTC(d) {
  // YYYYMMDDTHHMMSSZ
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear()
       + pad(d.getUTCMonth() + 1)
       + pad(d.getUTCDate())
       + 'T'
       + pad(d.getUTCHours())
       + pad(d.getUTCMinutes())
       + pad(d.getUTCSeconds())
       + 'Z';
}
// The in-app calendar stores cal_events.date_key in a non-standard form:
// "YYYY-M-D" with a 0-indexed month, unpadded (May 19, 2026 → "2026-4-19").
// The original server comment claiming "dateKey is 'YYYY-MM-DD'" is wrong.
// 100% of in-app calendar writes use the 0-indexed form (see
// public/index.html's buildCalendar + eventDateKeyFromInput), so we
// always treat keys as 0-indexed and bump by one. The 0..11 month
// values mean Dec is "11" not "12" — the standard YYYY-MM-DD form
// would put Dec at "12" and Jan at "01", which we never see in this
// table. If a future code path inserts ISO keys, this parser will
// shift them forward by one month, which would surface as a clear
// off-by-one in the feed rather than silent wrongness.
function _icsParseDateKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) + 1; // 0-indexed → 1-indexed
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}
function icsDateOnly(rawDateKey) {
  // VALUE=DATE form for all-day events. Returns "YYYYMMDD" or null.
  const p = _icsParseDateKey(rawDateKey);
  if (!p) return null;
  return String(p.y).padStart(4, '0') + String(p.mo).padStart(2, '0') + String(p.d).padStart(2, '0');
}
function icsDateTimeUTC(rawDateKey, hhmm) {
  // Combines a date-key + "HH:MM" string into a Date interpreted in
  // the server's local timezone, then serialized as UTC.
  if (!hhmm) return null;
  const p = _icsParseDateKey(rawDateKey);
  if (!p) return null;
  const tm = /^(\d{1,2}):(\d{2})/.exec(String(hhmm).trim());
  if (!tm) return null;
  const hh = Number(tm[1]), mm = Number(tm[2]);
  const dt = new Date(p.y, p.mo - 1, p.d, hh, mm, 0);
  return isNaN(dt.getTime()) ? null : dt;
}

// Parse a long-form ticket due like "May 19, 2026" into a Date at
// noon-local. Used because the tickets table stores due dates as
// human strings, not ISO. Returns null on unparseable values.
function icsParseTicketDue(str) {
  if (!str) return null;
  const d = new Date(String(str));
  if (isNaN(d.getTime())) return null;
  // Set to noon so the resulting all-day UTC ICS date doesn't roll
  // off the user's local day in either direction.
  d.setHours(12, 0, 0, 0);
  return d;
}
function icsDateOnlyFromDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

// Build a single VEVENT block for an all-day event.
// Common VEVENT body shared by the all-day and timed event builders.
// Handles ORGANIZER, ATTENDEE, CATEGORIES, STATUS, X-* hints — the
// stuff that turns a bare time-slot into something Google/Apple render
// as a proper meeting or task-style item.
function _icsCommonEventLines({ organizer, attendees, categories, status, transparency, classification, url }) {
  const lines = [];
  if (organizer && organizer.email) {
    const cn = organizer.name ? `;CN="${String(organizer.name).replace(/"/g, '')}"` : '';
    lines.push(`ORGANIZER${cn}:mailto:${organizer.email}`);
  }
  for (const a of (attendees || [])) {
    if (!a || !a.email) continue;
    const cn = a.name ? `;CN="${String(a.name).replace(/"/g, '')}"` : '';
    // ROLE / PARTSTAT / RSVP make Google show this as a real participant
    // entry in the event details (subscribed calendars still won't *send*
    // the invite — that needs the Google Calendar API integration — but
    // attendees are visible and the slot is rendered correctly).
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`);
  }
  if (categories)    lines.push(`CATEGORIES:${icsEscape(categories)}`);
  if (status)        lines.push(`STATUS:${status}`);
  if (transparency)  lines.push(`TRANSP:${transparency}`); // OPAQUE blocks time, TRANSPARENT doesn't
  if (classification)lines.push(`CLASS:${classification}`);
  if (url)           lines.push(`URL:${url}`);
  return lines;
}

function icsAllDay({ uid, dateYYYYMMDD, summary, description, location, organizer, attendees, categories, status, transparency, url }) {
  if (!dateYYYYMMDD) return '';
  // DTEND on an all-day event is exclusive — one day after DTSTART
  // for a single-day item.
  const start = dateYYYYMMDD;
  const startD = new Date(Number(start.slice(0,4)), Number(start.slice(4,6)) - 1, Number(start.slice(6,8)));
  const next = new Date(startD); next.setDate(next.getDate() + 1);
  const end = icsDateOnlyFromDate(next);
  const now = icsDateUTC(new Date());
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${icsEscape(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  if (location)    lines.push(`LOCATION:${icsEscape(location)}`);
  lines.push(..._icsCommonEventLines({ organizer, attendees, categories, status, transparency, url }));
  lines.push('END:VEVENT');
  return lines.map(icsFoldLine).join('\r\n');
}
function icsTimedEvent({ uid, startDate, endDate, summary, description, location, organizer, attendees, categories, status, transparency, url }) {
  if (!startDate) return '';
  // If no end provided, default to a one-hour block — most calendars
  // refuse zero-length events.
  if (!endDate) endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const now = icsDateUTC(new Date());
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${icsDateUTC(startDate)}`,
    `DTEND:${icsDateUTC(endDate)}`,
    `SUMMARY:${icsEscape(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  if (location)    lines.push(`LOCATION:${icsEscape(location)}`);
  lines.push(..._icsCommonEventLines({ organizer, attendees, categories, status, transparency, url }));
  lines.push('END:VEVENT');
  return lines.map(icsFoldLine).join('\r\n');
}

// Look up workspace users by display name. Used to convert attendee
// names stored on cal_events.attendees_json into mailto:-able
// {name,email} pairs for the ICS feed.
async function _icsResolveAttendees(names) {
  const out = [];
  for (const raw of (names || [])) {
    const n = String(raw || '').trim();
    if (!n) continue;
    const u = await get('SELECT name, email FROM users WHERE name=? LIMIT 1', n);
    if (u && u.email) out.push({ name: u.name, email: u.email });
    else out.push({ name: n });  // No mailto:, but still show the name
  }
  return out;
}

// Build the workspace's "open this" URL for a given ticket. Prefers
// APP_URL (the real public URL configured in env) and falls back to
// the request's own host so dev / preview deployments still work.
function _icsTicketUrl(req, ticketId) {
  const base = (process.env.APP_URL || gcalFeedBaseUrl(req) || '').replace(/\/+$/, '');
  return `${base}/tickets/${encodeURIComponent(ticketId)}`;
}

// GET /api/calendar/feed/:token.ics — UNAUTHENTICATED on purpose.
// The token is the auth: anyone with it sees the user's feed.
// Regenerating the token in the UI invalidates this URL.
app.get('/api/calendar/feed/:tokenIcs', async (req, res) => {
  try {
    // Token is encoded into the path with a trailing ".ics" suffix
    // so Google Calendar's URL validation accepts it as a calendar.
    const raw = String(req.params.tokenIcs || '');
    const m = /^([a-f0-9]{32,})\.ics$/i.exec(raw);
    if (!m) return res.status(404).type('text/plain').send('Not found');
    const token = m[1];
    const user = await get('SELECT id, name, email, gcal_feed_sources_json FROM users WHERE gcal_feed_token=?', token);
    if (!user) return res.status(404).type('text/plain').send('Not found');
    const sources = gcalParseSources(user.gcal_feed_sources_json);
    // Stamp the fetch so the in-app Sync-Now UI can honestly tell the
    // user when Google last polled. Fire-and-forget — a failure here
    // must never block the actual feed response.
    run(
      "UPDATE users SET gcal_feed_last_fetched_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
      user.id
    ).catch(() => {});

    const events = [];

    // 1) In-app calendar events the user owns — gated by event TYPE so
    //    callers can sync only meetings (the common ask) and leave their
    //    private tasks / deadlines out of the shared external calendar.
    const wantMeetings  = !!sources.meetings;
    const wantTasks     = !!sources.tasks;
    const wantDeadlines = !!sources.deadlines;
    if (wantMeetings || wantTasks || wantDeadlines) {
      const rows = await all(
        "SELECT * FROM cal_events WHERE user_id=? OR source='syruvia' ORDER BY date_key ASC",
        user.id
      );
      // Organizer for events the feed owner created is the feed owner.
      const organizer = user.email ? { name: user.name, email: user.email } : null;
      for (const r of rows) {
        const t = String(r.type || 'meeting').toLowerCase();
        // 'ticket'-type rows on the calendar are synthetic mirrors of
        // open tickets, which we already cover under the dedicated
        // tickets toggle below — skip them here.
        if (t === 'ticket') continue;
        if (t === 'meeting'  && !wantMeetings)  continue;
        if (t === 'task'     && !wantTasks)     continue;
        if (t === 'deadline' && !wantDeadlines) continue;
        // Unknown types fall through under the meetings toggle so they
        // aren't silently dropped if a future event type is introduced.
        if (!['meeting','task','deadline'].includes(t) && !wantMeetings) continue;

        const uid = `calendar-event-${r.id}@worknest`;
        const summary = r.title || r.label || 'Event';
        const baseDesc = r.description || '';
        const location = r.location || '';

        // Meetings get the full attendee treatment: ORGANIZER + every
        // attendee resolved to mailto:, so subscribed Google shows the
        // event at the right time with the participant list visible.
        // Google won't *send* invitations from a subscribed calendar
        // (that needs the two-way Google Calendar API integration), but
        // the slot, location, organizer, and attendee list all land
        // correctly.
        let attendees = [];
        if (t === 'meeting') {
          let nameList = [];
          try { nameList = JSON.parse(r.attendees_json || '[]'); } catch {}
          // The on-screen "assignee" of a meeting is treated as an
          // additional participant (mirrors what the in-app meeting
          // invite email already does).
          if (r.assignee && !nameList.includes(r.assignee)) nameList.push(r.assignee);
          attendees = await _icsResolveAttendees(nameList);
        }

        // Compose a richer description so the recipient sees the same
        // context they'd have inside the app — attendee list, the
        // join-link if it's a video meeting, the linked-ticket URL
        // (so Google viewers can jump straight to the ticket in
        // Syruvia from the event details), and the original notes.
        const descLines = [];
        if (t === 'meeting' && attendees.length) {
          descLines.push('Attendees: ' + attendees.map(a => a.email ? `${a.name || ''} <${a.email}>` : (a.name || '')).filter(Boolean).join(', '));
        }
        if (location && /^https?:\/\//i.test(location)) {
          descLines.push(`Join link: ${location}`);
        }
        if (r.linked_ticket_id) {
          // Pull the ticket title so the line reads "TKT-1234 · Fix login"
          // instead of just the id. Best-effort — if the ticket was
          // deleted out from under the event we still emit the id.
          const linked = await get('SELECT title FROM tickets WHERE id=? AND deleted_at IS NULL', r.linked_ticket_id);
          const ttl = linked && linked.title ? ` · ${linked.title}` : '';
          descLines.push(`Linked ticket: ${r.linked_ticket_id}${ttl}`);
          descLines.push(`Open ticket: ${_icsTicketUrl(req, r.linked_ticket_id)}`);
        }
        if (baseDesc) {
          if (descLines.length) descLines.push('');
          descLines.push(baseDesc);
        }
        const description = descLines.join('\n');

        // CATEGORIES + TRANSP let Google render each type appropriately:
        // meetings block time, deadlines block time, tasks/tasks-style
        // items can be marked TRANSPARENT so they don't visually
        // overlap real meetings on the day grid.
        const categories =
          t === 'meeting' ? 'Meeting' :
          t === 'task'    ? 'Task'    :
          t === 'deadline'? 'Deadline': 'Event';
        const transparency = (t === 'task') ? 'TRANSPARENT' : 'OPAQUE';

        // When the event is linked to a ticket, the event's URL property
        // points at the ticket so the Google Calendar event header
        // itself becomes a click-through to Syruvia.
        const eventUrl = r.linked_ticket_id ? _icsTicketUrl(req, r.linked_ticket_id) : null;
        if (r.all_day || !r.start_time) {
          const date = icsDateOnly(r.date_key);
          events.push(icsAllDay({
            uid, dateYYYYMMDD: date, summary, description, location,
            organizer, attendees,
            categories, transparency,
            status: 'CONFIRMED',
            url: eventUrl,
          }));
        } else {
          const startDate = icsDateTimeUTC(r.date_key, r.start_time);
          const endDate   = r.end_time ? icsDateTimeUTC(r.date_key, r.end_time) : null;
          events.push(icsTimedEvent({
            uid, startDate, endDate, summary, description, location,
            organizer, attendees,
            categories, transparency,
            status: 'CONFIRMED',
            url: eventUrl,
          }));
        }
      }
    }

    // 2) Tickets the user is involved in, rendered task-style — full
    //    ticket detail in the description, link back to the app, and
    //    TRANSP=TRANSPARENT so they don't visually block the user's
    //    real meeting slots. Google's subscribed-calendar surface
    //    doesn't import items into Google Tasks (VTODO support is
    //    spotty), so we still emit VEVENT — but with the Task category
    //    and rich body so it reads as a task at a glance.
    if (sources.tickets) {
      const rows = await all(`
        SELECT t.id, t.title, t.due, t.priority, t.status, t.dept,
               t.req, t.assignee, t.reporter
          FROM tickets t
          LEFT JOIN ticket_assignees ta ON ta.ticket_id = t.id
         WHERE t.deleted_at IS NULL
           AND COALESCE(t.status, '') NOT IN ('Closed','Archived')
           AND (t.assignee_user_id = ? OR t.created_by = ? OR t.req_user_id = ? OR ta.user_id = ?)
         GROUP BY t.id
      `, user.id, user.id, user.id, user.id);
      for (const r of rows) {
        const due = icsParseTicketDue(r.due);
        if (!due) continue;
        const uid = `ticket-${r.id}@worknest`;

        // Pull the full assignee list + description so the calendar
        // event carries the same context the user has inside the app.
        const assigneeRows = await all(
          'SELECT user_name FROM ticket_assignees WHERE ticket_id=? ORDER BY user_name ASC',
          r.id
        );
        const assigneeNames = assigneeRows.map(a => a.user_name).filter(Boolean);
        if (r.assignee && !assigneeNames.includes(r.assignee)) assigneeNames.unshift(r.assignee);

        const detRow = await get('SELECT description FROM ticket_details WHERE ticket_id=?', r.id);
        const fullDesc = (detRow && detRow.description) || '';

        const summary = `📌 ${r.id} · ${r.title || ''}`;
        const descLines = [
          `Priority: ${r.priority || 'Medium'}`,
          `Status:   ${r.status || 'Open'}`,
        ];
        if (r.dept)               descLines.push(`Dept:     ${r.dept}`);
        if (assigneeNames.length) descLines.push(`Assignees: ${assigneeNames.join(', ')}`);
        if (r.req)                descLines.push(`Requester: ${r.req}`);
        if (r.reporter && r.reporter !== r.req) descLines.push(`Reporter:  ${r.reporter}`);
        if (fullDesc) { descLines.push(''); descLines.push(fullDesc); }
        descLines.push('');
        descLines.push(`Open in app: ${_icsTicketUrl(req, r.id)}`);
        const description = descLines.join('\n');

        events.push(icsAllDay({
          uid,
          dateYYYYMMDD: icsDateOnlyFromDate(due),
          summary,
          description,
          location: '',
          categories: 'Task',
          transparency: 'TRANSPARENT',
          status: r.status === 'Closed' ? 'COMPLETED' : 'CONFIRMED',
          url: _icsTicketUrl(req, r.id),
        }));
      }
    }

    // 3) Personal reminders (active, not completed)
    if (sources.reminders) {
      const rows = await all(
        "SELECT id, title, description, due_at, ticket_id FROM personal_reminders WHERE user_id=? AND completed=0",
        user.id
      );
      for (const r of rows) {
        if (!r.due_at) continue;
        // due_at is stored as 'YYYY-MM-DD HH:MM:SS' UTC.
        const due = new Date(String(r.due_at).replace(' ', 'T') + 'Z');
        if (isNaN(due.getTime())) continue;
        const uid = `reminder-${r.id}@worknest`;
        const summary = '⏰ ' + (r.title || 'Reminder');
        const description = (r.description || '') + (r.ticket_id ? `\nTicket: ${r.ticket_id}` : '');
        events.push(icsTimedEvent({
          uid,
          startDate: due,
          endDate: new Date(due.getTime() + 30 * 60 * 1000),
          summary,
          description,
        }));
      }
    }

    // 4) Recurring tasks (next_run_date)
    if (sources.recurring) {
      const rows = await all(
        "SELECT id, name, description, next_run_date FROM recurring_tasks WHERE active=1 AND created_by=?",
        user.id
      );
      for (const r of rows) {
        if (!r.next_run_date) continue;
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.next_run_date);
        if (!m) continue;
        const date = m[1] + m[2] + m[3];
        const uid = `recurring-${r.id}-${m[1]}${m[2]}${m[3]}@worknest`;
        const summary = '🔁 ' + (r.name || 'Recurring task');
        events.push(icsAllDay({
          uid,
          dateYYYYMMDD: date,
          summary,
          description: r.description || '',
          location: '',
        }));
      }
    }

    const header = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Syruvia//Work Management//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Syruvia · ${icsEscape(user.name || 'My calendar')}`,
      `X-WR-CALDESC:${icsEscape('Synced from Syruvia Work Management')}`,
      'X-PUBLISHED-TTL:PT1H',
    ].map(icsFoldLine).join('\r\n');
    const footer = 'END:VCALENDAR';
    const body = events.filter(Boolean).join('\r\n');
    const text = [header, body, footer].filter(Boolean).join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="syruvia.ics"');
    // Tell aggregators we'd like a poll roughly every hour. Google
    // ultimately decides its own cadence (often 4-24h), so this is a
    // hint, not a guarantee.
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(text);
  } catch (e) {
    console.error('[gcal-feed]', e.message);
    res.status(500).type('text/plain').send('Feed generation failed');
  }
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
    // Don't pre-format the time on the server — formatUSDateTime() uses
    // the host's local timezone, which is almost never the user's. The
    // client formats from `created_at` (always sent as UTC) so the
    // displayed time matches the viewer's clock.
    res.json(rows);
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
    const u = await getUser(req.session.userId);
    if (!u) return res.json([]);
    // Admin sees workspace-wide activity. Manager (and Member, though
    // the dashboard card itself is admin/manager-gated) sees activity
    // only on tickets they can access — assignee / reporter / requester
    // / creator / mention-watcher. Same predicate as the member SELECT
    // in /api/tickets so the two surfaces line up.
    const isAdmin = u.perm_role === 'Admin';
    let rows;
    if (isAdmin) {
      rows = await all(`
        SELECT tt.id, tt.ticket_id, tt.text, tt.dot, tt.created_at,
               t.title as ticket_title
          FROM ticket_timelines tt
          JOIN tickets t ON t.id = tt.ticket_id AND t.deleted_at IS NULL
         ORDER BY tt.created_at DESC LIMIT 20
      `);
    } else {
      rows = await all(`
        SELECT tt.id, tt.ticket_id, tt.text, tt.dot, tt.created_at,
               t.title as ticket_title
          FROM ticket_timelines tt
          JOIN tickets t ON t.id = tt.ticket_id AND t.deleted_at IS NULL
         WHERE (t.assignee_user_id = ?
                OR (t.assignee_user_id IS NULL AND t.assignee = ?)
                OR EXISTS (
                     SELECT 1 FROM ticket_assignees ta
                      WHERE ta.ticket_id = t.id
                        AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
                   )
                OR t.reporter_user_id = ?
                OR (t.reporter_user_id IS NULL AND t.reporter = ?)
                OR t.req_user_id = ?
                OR (t.req_user_id IS NULL AND t.req = ?)
                OR t.created_by = ?
                OR EXISTS (
                     SELECT 1 FROM ticket_watchers tw
                      WHERE tw.ticket_id = t.id AND tw.user_id = ?
                   ))
         ORDER BY tt.created_at DESC LIMIT 20
      `, u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.id);
    }
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
    let onDiskBytes = 0;
    try { onDiskBytes = fs.statSync(path.join(UPLOADS_DIR, req.file.filename)).size; } catch {}
    if (!req.file.size || onDiskBytes === 0) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
      return res.status(400).json({ error: 'Upload arrived empty (0 bytes). Please try again.' });
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
    // Reject empty / corrupt uploads. Multer reports the upload size, but
    // we also stat the on-disk file as a sanity check — if either is zero,
    // we'd otherwise persist a row pointing to a 0-byte file that plays
    // back as a black video / silent audio on every other client.
    let onDiskBytes = 0;
    try { onDiskBytes = fs.statSync(path.join(UPLOADS_DIR, req.file.filename)).size; } catch {}
    if (!req.file.size || onDiskBytes === 0) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
      console.warn('[upload] rejected empty file:',
        req.file.originalname, 'multer-size=', req.file.size, 'on-disk=', onDiskBytes);
      return res.status(400).json({
        error: 'Upload arrived empty (0 bytes). The browser may have stopped the recording before it finished — please try again.',
      });
    }
    const u = await getUser(req.session.userId);
    const { ticketId, commentId, subtaskId, feedbackId, announcementId, reminderId, docId, chatMessageId } = req.body;
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
    // Chat-message attachments: only the message author may attach files
    // (and only if they're still a member of the channel — covers the case
    // where someone leaves a private channel and then tries to upload).
    if (chatMessageId) {
      const m = await get('SELECT id, channel_id, user_id FROM chat_messages WHERE id=?', Number(chatMessageId));
      if (!m || m.user_id !== req.session.userId) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
        return res.status(404).json({ error: 'Message not found' });
      }
      const member = await get('SELECT 1 FROM chat_channel_members WHERE channel_id=? AND user_id=?',
        m.channel_id, req.session.userId);
      if (!member) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
        return res.status(403).json({ error: 'Not a member of this channel' });
      }
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
    // Personal-reminder attachments: only the owner can attach. The reminder
    // is private to its user_id.
    if (reminderId) {
      const own = await get('SELECT id FROM personal_reminders WHERE id=? AND user_id=?',
        Number(reminderId), req.session.userId);
      if (!own) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {}
        return res.status(404).json({ error: 'Reminder not found' });
      }
    }
    // Feedback attachments: anyone authenticated can attach to any feedback
    // item (the feedback page is shared by everyone). No further check
    // beyond the auth middleware.
    const info = await run(
      'INSERT INTO attachments (ticket_id,comment_id,subtask_id,feedback_id,announcement_id,reminder_id,doc_id,chat_message_id,filename,original_name,mime_type,size,uploader) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
      ticketId || null,
      commentId ? Number(commentId) : null,
      subtaskId ? Number(subtaskId) : null,
      feedbackId ? Number(feedbackId) : null,
      announcementId ? Number(announcementId) : null,
      reminderId ? Number(reminderId) : null,
      docId ? Number(docId) : null,
      chatMessageId ? Number(chatMessageId) : null,
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
    const att = await get('SELECT * FROM attachments WHERE id=?', req.params.id);
    if (!att) return res.json({ ok: true }); // already gone
    // Personal-reminder attachments are private to the reminder's owner.
    // Even an admin can't delete one — reminders are not workspace data.
    if (att.reminder_id) {
      const own = await get('SELECT id FROM personal_reminders WHERE id=? AND user_id=?',
        att.reminder_id, req.session.userId);
      if (!own) return res.status(404).json({ error: 'Attachment not found' });
      try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch {}
      await run('DELETE FROM attachments WHERE id=?', req.params.id);
      return res.json({ ok: true });
    }
    // Resolve the parent ticket id (direct or via the parent subtask) and verify access
    let ticketId = att.ticket_id;
    if (!ticketId && att.subtask_id) {
      const sub = await get('SELECT ticket_id FROM ticket_subtasks WHERE id=?', att.subtask_id);
      ticketId = sub ? sub.ticket_id : null;
    }
    if (ticketId && !await canAccessTicket(req, ticketId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    // Only the uploader or an admin/manager can remove the file. We match
    // by the legacy `uploader` (display name) since that's the only signal
    // stored on attachments. Acceptable because a name collision wouldn't
    // grant escalated access — they'd still be in the same workspace.
    const u = await getUser(req.session.userId);
    const isAdmin = u && ['Admin','Manager'].includes(u.perm_role);
    const isUploader = att.uploader && u && att.uploader === u.name;
    if (!isAdmin && !isUploader) return res.status(403).json({ error: 'Only the uploader or an admin can delete this file.' });
    try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch {}
    await run('DELETE FROM attachments WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dismiss all of the current user's undismissed @mention notifications
// for a given ticket. Used by the "No reply needed" button on a comment
// that mentioned them — lets them clear the dashboard's
// "mentions awaiting reply" count without having to actually post a
// reply. New mentions after this fire fresh, undismissed notifications
// so the count comes back if someone @mentions them again.
app.post('/api/tickets/:id/mentions/dismiss', requireAuth, requireTicketAccess, async (req, res) => {
  try {
    await run(
      `UPDATE notifications
          SET dismissed_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        WHERE user_id = ? AND ticket_id = ? AND type = 'mention' AND dismissed_at IS NULL`,
      req.session.userId, req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Personal dashboard stats ─────────────────────────────────────────────────
// Returns three counts for the current user, scoped to tickets they're
// involved in (assignee / reporter / requester / creator):
//
//   unread          — tickets they've never opened OR have new activity
//                     since their last view (matches the unread pill in
//                     the tickets list).
//   staleCount      — open tickets with no activity (no comment) in 2+
//                     days. "Activity" = MAX(created_at, latest comment).
//   pendingMentions — tickets where the user has a 'mention' notification
//                     and hasn't posted a comment on that ticket since.
//
// Each count is cheap (one aggregate query), so we run them in parallel.
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    // Cutoff for "stale" — anything older than 2 BUSINESS days from now
    // (UTC, weekends skipped). Stored timestamps are TO_CHAR'd
    // 'YYYY-MM-DD HH24:MI:SS' UTC text; lexicographic compare with
    // another such string works correctly.
    const cutoff = nBusinessDaysAgo(2).toISOString().replace('T', ' ').slice(0, 19);
    // Shared "user is involved" filter — same shape as /api/tickets list.
    const involvementSql = `(
      t.assignee_user_id = ?
      OR (t.assignee_user_id IS NULL AND t.assignee = ?)
      OR EXISTS (
           SELECT 1 FROM ticket_assignees ta
            WHERE ta.ticket_id = t.id
              AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
         )
      OR t.reporter_user_id = ?
      OR (t.reporter_user_id IS NULL AND t.reporter = ?)
      OR t.req_user_id = ?
      OR (t.req_user_id IS NULL AND t.req = ?)
      OR t.created_by = ?
    )`;
    const involvementArgs = [u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.name, u.id];

    // Common projection for the inline ticket lists. Kept light — just
    // what the dashboard fold-out needs to render rows.
    const SELECT_LIST_COLS = `t.id, t.title, t.status, t.priority, t.assignee, t.due, t.dept`;

    // Today's UTC date prefix for the closed_at LIKE comparison below.
    const todayUtcKey = new Date().toISOString().slice(0, 10);
    // Unread is a stricter filter than the broader involvement used for
    // stale / completed-today. "Needs my attention" = I'm the assignee
    // (primary or additional), reporter, or requester. NOT just creator,
    // since admins create lots of tickets they aren't otherwise tied to.
    // Closed/Archived tickets are done — they never count as unread.
    const attentionSql = `(
      t.status NOT IN ('Closed', 'Archived')
      AND (
        t.assignee_user_id = ?
        OR (t.assignee_user_id IS NULL AND t.assignee = ?)
        OR EXISTS (
             SELECT 1 FROM ticket_assignees ta
              WHERE ta.ticket_id = t.id
                AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
           )
        OR t.reporter_user_id = ?
        OR (t.reporter_user_id IS NULL AND t.reporter = ?)
        OR t.req_user_id = ?
        OR (t.req_user_id IS NULL AND t.req = ?)
      )
    )`;
    const attentionArgs = [u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.name];

    const [unreadRows, staleRows, mentionRows, completedTodayRows] = await Promise.all([
      // Unread: ticket the user needs to attend to (see attentionSql),
      // deleted_at IS NULL, AND either no ticket_views row OR the row is
      // older than the latest activity. Latest activity = MAX(created_at,
      // latest comment).
      all(
        `SELECT ${SELECT_LIST_COLS} FROM tickets t
           LEFT JOIN ticket_views v ON v.ticket_id = t.id AND v.user_id = ?
           LEFT JOIN (SELECT ticket_id, MAX(created_at) AS latest_at
                        FROM ticket_comments GROUP BY ticket_id) lc
                ON lc.ticket_id = t.id
          WHERE t.deleted_at IS NULL
            AND ${attentionSql}
            AND (
                  v.last_viewed_at IS NULL
               OR v.last_viewed_at < COALESCE(lc.latest_at, t.created_at)
            )
          ORDER BY COALESCE(lc.latest_at, t.created_at) DESC
          LIMIT 50`,
        u.id, ...attentionArgs
      ),
      // Stale: open (not Closed/Archived) tickets where the latest activity
      // is more than 2 days ago. Order by oldest activity first — those
      // are the ones most likely to need a poke.
      all(
        `SELECT ${SELECT_LIST_COLS} FROM tickets t
           LEFT JOIN (SELECT ticket_id, MAX(created_at) AS latest_at
                        FROM ticket_comments GROUP BY ticket_id) lc
                ON lc.ticket_id = t.id
          WHERE t.deleted_at IS NULL
            AND t.status NOT IN ('Closed', 'Archived')
            AND ${involvementSql}
            AND COALESCE(lc.latest_at, t.created_at) < ?
          ORDER BY COALESCE(lc.latest_at, t.created_at) ASC
          LIMIT 50`,
        ...involvementArgs, cutoff
      ),
      // Pending mentions: distinct tickets where the user has a mention
      // notification and hasn't authored a comment after that mention,
      // AND the notification hasn't been dismissed via the "No reply
      // needed" button. Pull the actual ticket rows by joining back to
      // tickets.
      all(
        `SELECT ${SELECT_LIST_COLS} FROM tickets t
          WHERE t.id IN (
                  SELECT DISTINCT n.ticket_id FROM notifications n
                   WHERE n.user_id = ?
                     AND n.type = 'mention'
                     AND n.ticket_id IS NOT NULL
                     AND n.dismissed_at IS NULL
                     AND NOT EXISTS (
                           SELECT 1 FROM ticket_comments tc
                            WHERE tc.ticket_id = n.ticket_id
                              AND (tc.author_user_id = ?
                                   OR (tc.author_user_id IS NULL AND tc.author = ?))
                              AND tc.created_at > n.created_at
                         )
                )
            AND t.deleted_at IS NULL
          ORDER BY t.id DESC
          LIMIT 50`,
        u.id, u.id, u.name
      ),
      // Completed today: scoped tickets that closed today (UTC). Uses
      // tickets.closed_at, stamped by the PUT route on status→Closed.
      all(
        `SELECT ${SELECT_LIST_COLS} FROM tickets t
          WHERE t.deleted_at IS NULL
            AND t.status = 'Closed'
            AND t.closed_at LIKE ?
            AND ${involvementSql}
          ORDER BY t.closed_at DESC
          LIMIT 50`,
        todayUtcKey + '%', ...involvementArgs
      ),
    ]);

    const _shape = r => ({
      id: r.id, title: r.title, status: r.status, priority: r.priority,
      assignee: r.assignee || '', due: r.due || '', dept: r.dept || '',
    });
    res.json({
      unreadCount: unreadRows.length,
      staleCount: staleRows.length,
      pendingMentionsCount: mentionRows.length,
      completedTodayCount: completedTodayRows.length,
      staleThresholdDays: 2,
      unreadTickets: unreadRows.map(_shape),
      staleTickets: staleRows.map(_shape),
      pendingMentionTickets: mentionRows.map(_shape),
      completedTodayTickets: completedTodayRows.map(_shape),
    });
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
    // closed_at is stamped when status flips to Closed; matches "tickets
    // closed today" (was wrongly checking created_at before).
    const completedTodayRow = await get(
      `SELECT COUNT(*) as c FROM tickets WHERE deleted_at IS NULL AND status='Closed' AND closed_at LIKE '${todayStr}%' ${assigneeClause}`
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
    // Auto-add the new user to #general so they have at least one channel.
    if (typeof app.locals.chatAutoJoinGeneral === 'function') {
      app.locals.chatAutoJoinGeneral(u.id).catch(()=>{});
    }

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

// Diagnose Slack integration. Admin-only. Either:
//   GET  /api/admin/slack/diagnose                       → high-level status
//   POST /api/admin/slack/test  body { userId } or {email} → try to DM them
// The test endpoint forces a fresh email lookup (clears the cached
// slack_user_id first) and reports each step separately so you can tell
// whether the failure is "user not found in Slack workspace", "missing
// scope", "auth bad", or "send blocked".
app.get('/api/admin/slack/diagnose', requireAdmin, async (req, res) => {
  try {
    if (!slackReady) return res.json({ ready: false, reason: 'SLACK_BOT_TOKEN not set on server' });
    // auth.test confirms the token is valid + tells us which workspace.
    const auth = await _slackApi('auth.test', {});
    res.json({
      ready: true,
      tokenValid: !!auth.ok,
      workspace: auth.team || null,
      botUser: auth.user || null,
      botUserId: auth.user_id || null,
      authError: auth.ok ? null : auth.error,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/slack/test', requireAdmin, async (req, res) => {
  try {
    if (!slackReady) return res.status(400).json({ error: 'SLACK_BOT_TOKEN not set on server' });
    let { userId, email } = req.body || {};
    let user;
    if (userId) {
      user = await get('SELECT id, name, email, slack_user_id FROM users WHERE id=?', Number(userId));
    } else if (email) {
      user = await get('SELECT id, name, email, slack_user_id FROM users WHERE email=?', String(email));
    }
    if (!user) return res.status(404).json({ error: 'No matching user', userId, email });
    // Clear the cache so we always do a fresh lookup for the diagnostic.
    await run("UPDATE users SET slack_user_id='' WHERE id=?", user.id);
    user.slack_user_id = '';
    // Step 1: lookup by email
    const lookupR = await fetch(
      'https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(user.email),
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const lookupData = await lookupR.json();
    if (!lookupData.ok) {
      return res.json({
        step: 'lookupByEmail', ok: false,
        syruviaUser: { id: user.id, name: user.name, email: user.email },
        slackError: lookupData.error,
        hint: lookupData.error === 'users_not_found'
          ? `Slack workspace has no user with email ${user.email}. Either change the user's email in Syruvia (Settings → Users) so it matches their Slack email, or add this email as an alternate in Slack.`
          : lookupData.error === 'missing_scope'
            ? `The Slack App's bot token is missing the 'users:read.email' scope. Re-install the app with that scope added.`
            : null,
      });
    }
    const sid = lookupData.user.id;
    await run('UPDATE users SET slack_user_id=? WHERE id=?', sid, user.id);
    // Step 2: send a real test DM
    const postData = await _slackApi('chat.postMessage', {
      channel: sid,
      text: `🧪 Syruvia test DM — if you see this, Slack notifications are working. (Triggered by an admin from Settings.)`,
    });
    res.json({
      step: 'chat.postMessage', ok: !!postData.ok,
      syruviaUser: { id: user.id, name: user.name, email: user.email },
      slackUser: lookupData.user,
      slackUserId: sid,
      slackError: postData.ok ? null : postData.error,
      hint: !postData.ok && postData.error === 'missing_scope'
        ? `The Slack App's bot token is missing the 'chat:write' scope. Re-install the app with that scope added.`
        : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnose attachment storage health. Walks the attachments table and
// stats every referenced file on disk, returning the rows that are
// missing, zero-byte, or whose on-disk size doesn't match the DB. Use
// this when users report "empty files" to confirm whether the bytes
// are actually on disk vs. a UI-caching issue.
app.get('/api/admin/uploads/diagnose', requireAdmin, async (req, res) => {
  try {
    let totalDiskBytes = 0;
    try {
      const names = fs.readdirSync(UPLOADS_DIR);
      for (const n of names) {
        try { totalDiskBytes += fs.statSync(path.join(UPLOADS_DIR, n)).size; } catch {}
      }
    } catch (e) {
      return res.status(500).json({
        uploadsDir: UPLOADS_DIR,
        error: 'Could not read uploads dir: ' + e.message,
      });
    }
    const rows = await all('SELECT id, filename, original_name, mime_type, size, ticket_id, comment_id, reminder_id, feedback_id, announcement_id, uploader, created_at FROM attachments ORDER BY id DESC LIMIT 1000');
    const missing = [];
    const zeroByte = [];
    const sizeMismatch = [];
    for (const r of rows) {
      const full = path.join(UPLOADS_DIR, r.filename);
      let stat = null;
      try { stat = fs.statSync(full); } catch {}
      if (!stat) {
        missing.push({ id: r.id, filename: r.filename, dbSize: r.size, originalName: r.original_name, mimeType: r.mime_type, uploader: r.uploader, createdAt: r.created_at });
      } else if (stat.size === 0) {
        zeroByte.push({ id: r.id, filename: r.filename, dbSize: r.size, originalName: r.original_name, mimeType: r.mime_type, uploader: r.uploader, createdAt: r.created_at });
      } else if (r.size && Math.abs(stat.size - r.size) > 0) {
        sizeMismatch.push({ id: r.id, filename: r.filename, dbSize: r.size, diskSize: stat.size, originalName: r.original_name, uploader: r.uploader });
      }
    }
    res.json({
      uploadsDir: UPLOADS_DIR,
      uploadsDirIsDefault: !process.env.UPLOADS_DIR,
      totalDiskBytes,
      totalAttachmentRows: rows.length,
      missingCount: missing.length,
      zeroByteCount: zeroByte.length,
      sizeMismatchCount: sizeMismatch.length,
      missing, zeroByte, sizeMismatch,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Prune broken attachment rows — deletes any attachments whose file is
// missing or 0 bytes on disk. Body: { confirm: true } required so it can't
// be triggered accidentally.
app.post('/api/admin/uploads/prune-broken', requireAdmin, async (req, res) => {
  try {
    if (!req.body || req.body.confirm !== true) {
      return res.status(400).json({ error: 'confirm:true required' });
    }
    const rows = await all('SELECT id, filename FROM attachments');
    const toDelete = [];
    for (const r of rows) {
      const full = path.join(UPLOADS_DIR, r.filename);
      let stat = null;
      try { stat = fs.statSync(full); } catch {}
      if (!stat || stat.size === 0) toDelete.push(r.id);
    }
    if (!toDelete.length) return res.json({ ok: true, deleted: 0 });
    const placeholders = toDelete.map(() => '?').join(',');
    await run(`DELETE FROM attachments WHERE id IN (${placeholders})`, ...toDelete);
    res.json({ ok: true, deleted: toDelete.length, ids: toDelete });
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
// Combine a 0-indexed "YYYY-M-D" date key + "HH:MM" time into a real
// local Date. Same shape issue as combineDateTime inside the POST
// /api/events handler — feeding the non-standard key directly to
// `new Date(...)` returns Invalid Date, which silently disables every
// cron job that depends on it (meeting reminders, deadline warnings,
// overdue digests). Parse by hand.
function combineEventStart(dateKey, timeStr) {
  if (!dateKey) return null;
  const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateKey).trim());
  if (!dm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]) + 1; // 0-indexed → 1-indexed
  const dd = Number(dm[3]);
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
  const cleanT = (timeStr && /^\d{1,2}:\d{2}/.test(timeStr)) ? timeStr : '00:00';
  const tm = /^(\d{1,2}):(\d{2})/.exec(cleanT);
  const d = new Date(y, mo - 1, dd, Number(tm[1]), Number(tm[2]), 0);
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
        // Push to the attendee's installed PWA so it pops up an OS-level
        // alert ~1 hour before the meeting starts.
        const targetUser = await get('SELECT id FROM users WHERE name=?', name);
        if (targetUser) {
          sendPushToUser(targetUser.id, {
            title: 'Meeting in ~1 hour',
            body: `${ev.title || ev.label || 'Meeting'}` +
                  (ev.start_time ? ` at ${ev.start_time}` : '') +
                  (ev.location ? ` · ${ev.location}` : ''),
            tag: 'meeting-' + ev.id,
            url: '/calendar',
          }).catch(()=>{});
        }
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
        // Slack DM alongside the email so the user sees it on whichever
        // channel they're checking. No-op when SLACK_BOT_TOKEN unset.
        slackDmUser(r.user_id, {
          text: `🔔 Reminder you set: check on <${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${r.ticket_id}|${r.ticket_id}>${r.ticket_title ? ' — ' + r.ticket_title : ''}${r.note ? `\n> ${r.note}` : ''}`,
        }).catch(() => {});
        // Push to the user's installed PWA / desktop browser.
        sendPushToUser(r.user_id, {
          title: 'Reminder: ' + (r.ticket_title || r.ticket_id),
          body: r.note ? r.note.slice(0, 140) : 'Reminder you set on this ticket',
          tag: 'ticket-reminder-' + r.id,
          url: '/tickets/' + r.ticket_id,
        }).catch(() => {});
        await run(
          `UPDATE ticket_reminders SET sent = 1, sent_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
          r.id
        );
        console.log(`[reminder] sent #${r.id} (${r.ticket_id} → ${r.user_email})`);
      } catch (e) { console.error('[reminder] failed for', r.id, e.message); }
    }
  } catch (e) { console.error('[cron:ticket-reminder] failed:', e.message); }
}

// Personal reminders ("My Reminders"): scan rows where the user opted in to
// email, that aren't completed, and that are due. Two cases:
//
//   Case A — one-shot (repeat_daily=0):
//     Fire once when due_at <= NOW() AND last_email_sent_at IS NULL.
//
//   Case B — repeat-daily (repeat_daily=1):
//     Fire every day at the same time-of-day until completed=1. We compare
//     SUBSTR(last_email_sent_at, 1, 10) (the YYYY-MM-DD prefix) against
//     today's UTC date — when it's older, we re-fire. The first send still
//     waits for due_at <= NOW() so the user picks the start time.
//
// last_email_sent_at is bumped on every successful send so neither case
// double-fires within the same loop tick or day.
async function runPersonalReminderJob() {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const due = await all(
      `SELECT r.*, u.email AS user_email, u.name AS user_name,
              t.title AS ticket_title
         FROM personal_reminders r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN tickets t ON t.id = r.ticket_id AND t.deleted_at IS NULL
        WHERE r.email_enabled = 1
          AND r.completed = 0
          AND r.due_at <= TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          AND (
                (r.repeat_daily = 0 AND r.last_email_sent_at IS NULL)
             OR (r.repeat_daily = 1 AND (r.last_email_sent_at IS NULL OR SUBSTR(r.last_email_sent_at, 1, 10) < ?))
          )
        ORDER BY r.due_at ASC
        LIMIT 200`,
      todayKey
    );
    if (!due.length) return;
    for (const r of due) {
      try {
        await sendPersonalReminderEmail({
          toEmail: r.user_email, toName: r.user_name,
          title: r.title, description: r.description,
          dueAt: r.due_at, ticketId: r.ticket_id || null,
          ticketTitle: r.ticket_title || '',
          repeatDaily: !!r.repeat_daily,
        });
        // Slack DM alongside the email. Repeat-daily reminders fire daily
        // until completed=1, same gate as the email.
        const _ticketLink = r.ticket_id
          ? ` (<${(process.env.APP_URL || `http://localhost:${PORT}`)}/tickets/${r.ticket_id}|${r.ticket_id}>${r.ticket_title ? ' — ' + r.ticket_title : ''})`
          : ` (<${(process.env.APP_URL || `http://localhost:${PORT}`)}/my-reminders|My Reminders>)`;
        slackDmUser(r.user_id, {
          text: `${r.repeat_daily ? '🔁 Daily reminder' : '🔔 Reminder'}: *${r.title || 'Personal reminder'}*${_ticketLink}${r.description ? `\n> ${r.description.slice(0, 280)}` : ''}`,
        }).catch(() => {});
        // Push to the user's installed PWA / desktop browser.
        sendPushToUser(r.user_id, {
          title: (r.repeat_daily ? '🔁 ' : '🔔 ') + (r.title || 'Reminder'),
          body: (r.description || '').slice(0, 140) || (r.ticket_title ? 'Linked to ' + r.ticket_id : ''),
          tag: 'personal-reminder-' + r.id,
          url: r.ticket_id ? '/tickets/' + r.ticket_id : '/my-reminders',
        }).catch(() => {});
        await run(
          `UPDATE personal_reminders
              SET last_email_sent_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
            WHERE id = ?`,
          r.id
        );
        console.log(`[personal-reminder] sent #${r.id} (→ ${r.user_email}${r.repeat_daily ? ', repeating daily' : ''})`);
      } catch (e) { console.error('[personal-reminder] failed for', r.id, e.message); }
    }
  } catch (e) { console.error('[cron:personal-reminder] failed:', e.message); }
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

// (Catch-all SPA handler is registered at the very end of route setup so it
//  doesn't swallow GET requests for /api/bridge/*, /api/chat/*, etc. — see
//  the block right before "── Start ──".)

// ── Per-user API tokens & Gmail email-to-ticket inbound ─────────────────────
// Tokens authenticate as a specific user (unlike CROSS_APP_SECRET which is a
// shared server-to-server secret). Used today by the Gmail add-on so a user
// can turn an open email into a ticket from inside Gmail. The raw token is
// returned exactly once on creation; we persist only its SHA-256 hash.
const TOKEN_PREFIX = 'wm_';
function hashToken(raw) {
  return createHash('sha256').update(String(raw || '')).digest('hex');
}
function rateLimitBy(keyFn, { windowMs, max }) {
  const buckets = new Map();
  return (req, res, next) => {
    const k = keyFn(req);
    if (!k) return next();
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt < now) { b = { resetAt: now + windowMs, count: 0 }; buckets.set(k, b); }
    b.count++;
    if (b.count > max) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

// Look up Bearer-token auth and attach { apiUser, apiTokenId } to req on
// success. Returns 401 with no body shape leakage when the token is missing
// or unknown so probing can't distinguish "wrong token" from "expired".
async function requireApiToken(req, res, next) {
  try {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const raw = m[1].trim();
    if (!raw) return res.status(401).json({ error: 'Unauthorized' });
    const hash = hashToken(raw);
    const row = await get(
      `SELECT t.id AS token_id, t.user_id, u.id, u.name, u.email, u.perm_role
         FROM user_api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
      hash
    );
    if (!row) return res.status(401).json({ error: 'Unauthorized' });
    req.apiUser = { id: row.user_id, name: row.name, email: row.email, perm_role: row.perm_role };
    req.apiTokenId = row.token_id;
    // Best-effort last-used stamp; never blocks the request.
    run(
      "UPDATE user_api_tokens SET last_used_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
      row.token_id
    ).catch(() => {});
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// CORS for inbound endpoints called from Apps Script (UrlFetchApp doesn't
// send a browser Origin, but a future browser-side caller would). Wide-open
// because the bearer token does the authentication.
function inboundCors(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// List the current user's API tokens (without raw values).
app.get('/api/api-tokens', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, token_prefix, name, source, created_at, last_used_at
         FROM user_api_tokens WHERE user_id=? ORDER BY id DESC`,
      req.session.userId
    );
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve the Gmail add-on source files to the setup page so users can copy
// them without leaving the app. Reads fresh from disk on every request so
// a deploy that updates gmail-addon/ shows the new code to users
// immediately — no server restart needed.
app.get('/api/gmail-addon-snippets', requireAuth, async (req, res) => {
  try {
    const codeGsPath = path.join(__dirname, 'gmail-addon', 'Code.gs');
    const manifestPath = path.join(__dirname, 'gmail-addon', 'appsscript.json');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      codeGs: fs.existsSync(codeGsPath) ? fs.readFileSync(codeGsPath, 'utf8') : '',
      manifest: fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a new API token for the current user. The raw token is returned
// ONCE and never stored — the user must copy it now.
app.post('/api/api-tokens', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80) || 'API token';
    const source = String(req.body?.source || '').trim().slice(0, 40);
    // Cap to a sane number of live tokens per user to keep the table tidy.
    const countRow = await get('SELECT COUNT(*) AS n FROM user_api_tokens WHERE user_id=?', req.session.userId);
    if (Number(countRow?.n || 0) >= 20) {
      return res.status(400).json({ error: 'Too many tokens. Revoke one before creating another.' });
    }
    const raw = TOKEN_PREFIX + randomBytes(24).toString('hex');
    const prefix = raw.slice(0, 11);
    const hash = hashToken(raw);
    const info = await run(
      `INSERT INTO user_api_tokens (user_id, token_hash, token_prefix, name, source) VALUES (?,?,?,?,?) RETURNING id`,
      req.session.userId, hash, prefix, name, source
    );
    res.status(201).json({ id: Number(info.lastInsertRowid), token: raw, prefix, name, source });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Revoke a token (owned by the calling user).
app.delete('/api/api-tokens/:id', requireAuth, async (req, res) => {
  try {
    const tid = Number(req.params.id);
    const own = await get('SELECT id FROM user_api_tokens WHERE id=? AND user_id=?', tid, req.session.userId);
    if (!own) return res.status(404).json({ error: 'Not found' });
    await run('DELETE FROM user_api_tokens WHERE id=?', tid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Same mime/extension allowlist multer uses on the regular upload route —
// applied here so an email attachment can't smuggle in an executable.
function attachmentMimeAllowed(name, mime) {
  const m = String(mime || '').toLowerCase();
  const lname = String(name || '').toLowerCase();
  const ext = lname.includes('.') ? lname.split('.').pop() : '';
  const safeImage = /^image\/(png|jpeg|jpg|gif|webp|bmp|heic|heif)$/.test(m)
    || ['png','jpg','jpeg','gif','webp','bmp','heic','heif'].includes(ext);
  const safeAudio = /^audio\//.test(m);
  const safeVideo = /^video\/(webm|mp4|quicktime|x-matroska)\b/.test(m) || ['mp4','mov','webm'].includes(ext);
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
  return safeImage || safeAudio || safeVideo || safePdf || safeOffice || safeText || safeArchive;
}

// Per-attachment + total caps so a single email can't fill the disk.
const INBOUND_MAX_PER_FILE = 20 * 1024 * 1024;  // 20 MB
const INBOUND_MAX_TOTAL    = 40 * 1024 * 1024;  // 40 MB across all attachments

// POST /api/inbound/gmail-addon — Bearer-token authenticated. Accepts a
// parsed-email payload from the Gmail add-on and creates a ticket as the
// token's owner. Attachments arrive as base64 in JSON; we decode + write
// to UPLOADS_DIR like a regular upload and join via the attachments table.
// GET /api/inbound/options — Bearer-token authenticated. Returns the
// workspace shape the Gmail add-on needs to populate its dropdowns
// (user list for assignee/reporter/requester, departments, priorities).
app.options('/api/inbound/options', inboundCors);
app.get(
  '/api/inbound/options',
  inboundCors,
  rateLimitBy(req => (req.headers['authorization'] || '').slice(-32), { windowMs: 60 * 1000, max: 60 }),
  requireApiToken,
  async (req, res) => {
    try {
      const users = await all('SELECT id, name, email FROM users ORDER BY LOWER(name) ASC');
      const depts = await all('SELECT name FROM departments ORDER BY name ASC');
      res.json({
        users: (users || []).map(u => ({ id: u.id, name: u.name, email: u.email })),
        departments: (depts || []).map(d => d.name),
        priorities: ['Low', 'Medium', 'High', 'Critical'],
        me: { id: req.apiUser.id, name: req.apiUser.name, email: req.apiUser.email },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

app.options('/api/inbound/gmail-addon', inboundCors);
app.post(
  '/api/inbound/gmail-addon',
  inboundCors,
  rateLimitBy(req => (req.headers['authorization'] || '').slice(-32), { windowMs: 60 * 1000, max: 30 }),
  requireApiToken,
  async (req, res) => {
    try {
      // Probe path: the add-on's Settings → "Test connection" button posts
      // { probe: true } to verify the token resolves. Short-circuit before
      // any DB writes so the test never creates a real ticket.
      if (req.body && req.body.probe === true) {
        return res.json({ ok: true, probe: true, as: req.apiUser.name });
      }
      const {
        subject, from_name, from_email, body_text, body_html,
        message_id, thread_id, received_at, email_url,
        priority, dept, due,
        // Optional overrides from the add-on form. When empty/null we fall
        // back to the defaults documented further down (token owner for
        // assignee/reporter, raw email sender for requester).
        requester, assignee, additional_assignees, reporter,
        attachments,
      } = (req.body || {});

      const cleanSubject = String(subject || '').trim().slice(0, 200) || '(no subject)';
      const cleanFromName = String(from_name || '').trim().slice(0, 120);
      const cleanFromEmail = String(from_email || '').trim().slice(0, 200);
      const cleanBodyText = String(body_text || '').slice(0, 40000);

      // Idempotency: if this Gmail message already produced a ticket, hand
      // back the existing one rather than spawning a duplicate. Lets the
      // add-on retry safely (network blip, double-click, etc.).
      const sourceEmailId = String(message_id || '').trim().slice(0, 200) || null;
      if (sourceEmailId) {
        const existing = await get(
          'SELECT id FROM tickets WHERE source_email_id=? AND deleted_at IS NULL',
          sourceEmailId
        );
        if (existing) {
          return res.status(200).json({
            ticketId: existing.id,
            url: `/tickets/${existing.id}`,
            duplicate: true,
          });
        }
      }

      // Allocate a TKT-### id the same way the regular POST /api/tickets does.
      let id = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const maxRow = await get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
        let nextNum = 1000;
        if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }
        const candidate = 'TKT-' + (nextNum + 1);
        if (!await get('SELECT id FROM tickets WHERE id=?', candidate)) { id = candidate; break; }
      }
      if (!id) return res.status(500).json({ error: 'Could not allocate ticket id' });

      const me = req.apiUser;
      const requesterLine = cleanFromName
        ? (cleanFromEmail ? `${cleanFromName} <${cleanFromEmail}>` : cleanFromName)
        : cleanFromEmail;
      const metaLines = [];
      if (requesterLine) metaLines.push(`From: ${requesterLine}`);
      if (received_at)   metaLines.push(`Received: ${received_at}`);
      const description = (metaLines.length
        ? metaLines.join('\n') + '\n\n' + cleanBodyText
        : cleanBodyText
      ).trim();

      // Resolve the optional people fields. The add-on sends a workspace
      // user's display name (from a dropdown populated via /options) or an
      // empty string to mean "use the default". Names that don't match a
      // user (e.g. requester left as an external "Name <email>") keep the
      // raw text and leave user_id null so buildTicket doesn't override it.
      const requesterText = String(requester || '').trim() || requesterLine || '';
      const assigneeName  = String(assignee  || '').trim() || me.name;
      const reporterName  = String(reporter  || '').trim() || me.name;

      const requesterUid = requesterText ? await resolveUserIdByName(requesterText) : null;
      const assigneeUid  = await resolveUserIdByName(assigneeName);
      const reporterUid  = await resolveUserIdByName(reporterName);

      const cleanEmailUrl = String(email_url || '').trim().slice(0, 500) || null;

      console.log(`[inbound:gmail] INSERT ${id} "${cleanSubject.slice(0,80)}" by user ${me.id} from <${cleanFromEmail}> assignee=${assigneeName} reporter=${reporterName}`);
      await run(
        `INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id,source_email_id,source_email_url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,
        id, cleanSubject,
        requesterText,
        assigneeName,
        reporterName,
        (priority && ['Low','Medium','High','Critical'].includes(priority)) ? priority : 'Medium',
        'Open',
        String(dept || '').trim() || 'General',
        String(due || '').trim(),
        '',
        0,
        '[]',
        me.id,
        assigneeUid,
        reporterUid,
        requesterUid,
        sourceEmailId,
        cleanEmailUrl,
      );

      // Persist any extra assignees (multi-assign). Mirrors the regular
      // POST /api/tickets behaviour: one row per name in ticket_assignees,
      // with user_id resolved when the name maps to a real user.
      if (Array.isArray(additional_assignees)) {
        for (const raw of additional_assignees) {
          const nm = String(raw || '').trim();
          if (!nm) continue;
          const uid = await resolveUserIdByName(nm);
          await run(
            'INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
            id, nm, uid
          );
        }
      }

      await run(
        `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
         ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
        id, description
      );

      // Decode + persist each attachment. Failures on individual files are
      // logged and skipped — we'd rather create the ticket with 4-of-5
      // attachments than reject the whole submission for one bad file.
      const accepted = [];
      const rejected = [];
      let totalBytes = 0;
      if (Array.isArray(attachments)) {
        for (const att of attachments) {
          try {
            const name = String(att?.name || '').slice(0, 240) || 'attachment';
            const mime = String(att?.mimeType || 'application/octet-stream').slice(0, 120);
            const b64  = String(att?.dataBase64 || '');
            if (!b64) { rejected.push({ name, reason: 'empty' }); continue; }
            if (!attachmentMimeAllowed(name, mime)) {
              rejected.push({ name, reason: 'mime not allowed' });
              continue;
            }
            const buf = Buffer.from(b64, 'base64');
            if (!buf.length) { rejected.push({ name, reason: 'empty after decode' }); continue; }
            if (buf.length > INBOUND_MAX_PER_FILE) {
              rejected.push({ name, reason: `too large (${buf.length} bytes)` });
              continue;
            }
            if (totalBytes + buf.length > INBOUND_MAX_TOTAL) {
              rejected.push({ name, reason: 'total size cap reached' });
              continue;
            }
            const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
            const fname = randomUUID() + ext;
            fs.writeFileSync(path.join(UPLOADS_DIR, fname), buf);
            totalBytes += buf.length;
            await run(
              'INSERT INTO attachments (ticket_id,comment_id,subtask_id,feedback_id,announcement_id,reminder_id,doc_id,chat_message_id,filename,original_name,mime_type,size,uploader) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
              id, null, null, null, null, null, null, null,
              fname, name, mime, buf.length, me.name
            );
            accepted.push({ name, size: buf.length });
          } catch (e) {
            console.error('[inbound:gmail] attachment failed:', e.message);
            rejected.push({ name: att?.name || '?', reason: e.message });
          }
        }
      }

      const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
      res.status(201).json({
        ticketId: id,
        url: `${appUrl}/tickets/${id}`,
        attachments: { accepted, rejected },
      });
    } catch (e) {
      console.error('[inbound:gmail] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/inbound/gmail-reminder — Bearer-token authenticated. Creates a
// personal reminder for the token's owner from a Gmail message. Mirrors
// POST /api/my-reminders (same column write) plus the email-source niceties:
// the description is composed from the user's notes + From: header + body.
app.options('/api/inbound/gmail-reminder', inboundCors);
app.post(
  '/api/inbound/gmail-reminder',
  inboundCors,
  rateLimitBy(req => (req.headers['authorization'] || '').slice(-32), { windowMs: 60 * 1000, max: 30 }),
  requireApiToken,
  async (req, res) => {
    try {
      if (req.body && req.body.probe === true) {
        return res.json({ ok: true, probe: true, as: req.apiUser.name });
      }
      const {
        subject, from_name, from_email, body_text,
        message_id, received_at, email_url,
        title, description, due_at,
        ticket_id,
        email_enabled, repeat_daily, show_daily_in_app,
        attachments,
      } = (req.body || {});

      const me = req.apiUser;
      const cleanFromName = String(from_name || '').trim().slice(0, 120);
      const cleanFromEmail = String(from_email || '').trim().slice(0, 200);
      const requesterLine = cleanFromName
        ? (cleanFromEmail ? `${cleanFromName} <${cleanFromEmail}>` : cleanFromName)
        : cleanFromEmail;

      const cleanTitle = (String(title || '').trim() || String(subject || '').trim()).slice(0, 200);
      if (!cleanTitle) return res.status(400).json({ error: 'title required' });

      const stored = _normalizeDueAt(due_at);
      if (!stored) return res.status(400).json({ error: 'due_at required (YYYY-MM-DD or ISO datetime)' });

      // Compose description: user's notes first, then From + body so the
      // reminder shows the email context inline.
      const userNotes = String(description || '').trim();
      const cleanBody = String(body_text || '').slice(0, 4000);
      const meta = [];
      if (requesterLine) meta.push(`From: ${requesterLine}`);
      if (received_at) meta.push(`Received: ${received_at}`);
      const parts = [];
      if (userNotes) parts.push(userNotes);
      if (meta.length) parts.push((parts.length ? '\n' : '') + meta.join('\n'));
      if (cleanBody) parts.push((parts.length ? '\n' : '') + cleanBody);
      const fullDesc = parts.join('\n').slice(0, 5000);

      // Optional ticket link. Same UX as the in-app modal — accept any TKT-###
      // that exists. We don't reuse canAccessTicket here because that function
      // reads req.session.userId which doesn't exist on bearer-token requests;
      // verifying existence is enough since the reminder is private to the
      // owner anyway.
      let cleanTicketId = null;
      if (ticket_id) {
        const tid = String(ticket_id).trim().toUpperCase();
        if (tid) {
          const tk = await get('SELECT id FROM tickets WHERE id=? AND deleted_at IS NULL', tid);
          if (!tk) return res.status(400).json({ error: 'Linked ticket not found' });
          cleanTicketId = tid;
        }
      }

      const cleanSourceEmailId  = String(message_id || '').trim().slice(0, 200) || null;
      const cleanSourceEmailUrl = String(email_url  || '').trim().slice(0, 500) || null;

      const info = await run(
        `INSERT INTO personal_reminders
           (user_id, ticket_id, title, description, due_at,
            email_enabled, repeat_daily, show_daily_in_app,
            source_email_id, source_email_url)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        me.id,
        cleanTicketId,
        cleanTitle,
        fullDesc,
        stored,
        email_enabled === false ? 0 : 1,
        repeat_daily ? 1 : 0,
        show_daily_in_app ? 1 : 0,
        cleanSourceEmailId,
        cleanSourceEmailUrl,
      );
      const reminderId = Number(info.lastInsertRowid);
      console.log(`[inbound:reminder] INSERT #${reminderId} "${cleanTitle.slice(0,80)}" for user ${me.id} due ${stored}`);

      // Attach files — same caps + mime allow-list as the ticket flow, just
      // linked to the new reminder row instead of a ticket.
      const accepted = [];
      const rejected = [];
      let totalBytes = 0;
      if (Array.isArray(attachments)) {
        for (const att of attachments) {
          try {
            const name = String(att?.name || '').slice(0, 240) || 'attachment';
            const mime = String(att?.mimeType || 'application/octet-stream').slice(0, 120);
            const b64  = String(att?.dataBase64 || '');
            if (!b64) { rejected.push({ name, reason: 'empty' }); continue; }
            if (!attachmentMimeAllowed(name, mime)) {
              rejected.push({ name, reason: 'mime not allowed' });
              continue;
            }
            const buf = Buffer.from(b64, 'base64');
            if (!buf.length) { rejected.push({ name, reason: 'empty after decode' }); continue; }
            if (buf.length > INBOUND_MAX_PER_FILE) {
              rejected.push({ name, reason: `too large (${buf.length} bytes)` });
              continue;
            }
            if (totalBytes + buf.length > INBOUND_MAX_TOTAL) {
              rejected.push({ name, reason: 'total size cap reached' });
              continue;
            }
            const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
            const fname = randomUUID() + ext;
            fs.writeFileSync(path.join(UPLOADS_DIR, fname), buf);
            totalBytes += buf.length;
            await run(
              'INSERT INTO attachments (ticket_id,comment_id,subtask_id,feedback_id,announcement_id,reminder_id,doc_id,chat_message_id,filename,original_name,mime_type,size,uploader) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
              null, null, null, null, null, reminderId, null, null,
              fname, name, mime, buf.length, me.name
            );
            accepted.push({ name, size: buf.length });
          } catch (e) {
            console.error('[inbound:reminder] attachment failed:', e.message);
            rejected.push({ name: att?.name || '?', reason: e.message });
          }
        }
      }

      const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
      res.status(201).json({
        reminderId,
        url: `${appUrl}/my-reminders`,
        attachments: { accepted, rejected },
      });
    } catch (e) {
      console.error('[inbound:reminder] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

// ── Admin Reports ────────────────────────────────────────────────────────────
// Per-user performance summary + drill-down by user + bulk
// "request update" email. All three are Admin-only because they expose
// data across every workspace user.

function requireStrictAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  getUser(req.session.userId).then(u => {
    if (!u || u.perm_role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    next();
  }).catch(next);
}

// Parse optional period filters into UTC text bounds. Accepts:
//   - ?from=YYYY-MM-DD&to=YYYY-MM-DD  (inclusive window)
//   - or no params → null bounds (all-time)
function _periodBounds(req) {
  const fromQ = String(req.query.from || '').trim();
  const toQ   = String(req.query.to   || '').trim();
  const fmt = (s, endOfDay) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s + (endOfDay ? ' 23:59:59' : ' 00:00:00');
  };
  return { from: fmt(fromQ, false), to: fmt(toQ, true) };
}

// GET /api/reports/user-performance?from=&to=
// One row per workspace user with the headline metrics. Counts are
// scoped to active (non-deleted) tickets; "closed in period" is
// stamped via tickets.closed_at.
app.get('/api/reports/user-performance', requireStrictAdmin, async (req, res) => {
  try {
    const { from, to } = _periodBounds(req);
    const users = await all('SELECT id, name, email, role, dept, avatar_url, perm_role FROM users ORDER BY LOWER(name) ASC');
    if (!users.length) return res.json([]);
    const ids = users.map(u => u.id);
    const ph = ids.map(() => '?').join(',');

    // Open tickets per user (primary or additional assignee, not closed/archived/deleted)
    const openRows = await all(`
      SELECT u.id AS user_id, COUNT(DISTINCT t.id) AS cnt
        FROM users u
        LEFT JOIN tickets t ON t.deleted_at IS NULL
          AND t.status NOT IN ('Closed','Archived')
          AND (t.assignee_user_id = u.id
               OR (t.assignee_user_id IS NULL AND t.assignee = u.name)
               OR EXISTS (SELECT 1 FROM ticket_assignees ta
                            WHERE ta.ticket_id = t.id
                              AND (ta.user_id = u.id OR (ta.user_id IS NULL AND ta.user_name = u.name))))
       WHERE u.id IN (${ph})
       GROUP BY u.id`, ...ids);
    const open = new Map(openRows.map(r => [r.user_id, parseInt(r.cnt, 10)]));

    // Overdue subset of the above
    const overdueRows = await all(`
      SELECT u.id AS user_id, COUNT(DISTINCT t.id) AS cnt
        FROM users u
        LEFT JOIN tickets t ON t.deleted_at IS NULL
          AND t.status NOT IN ('Closed','Archived')
          AND t.overdue = 1
          AND (t.assignee_user_id = u.id
               OR (t.assignee_user_id IS NULL AND t.assignee = u.name)
               OR EXISTS (SELECT 1 FROM ticket_assignees ta
                            WHERE ta.ticket_id = t.id
                              AND (ta.user_id = u.id OR (ta.user_id IS NULL AND ta.user_name = u.name))))
       WHERE u.id IN (${ph})
       GROUP BY u.id`, ...ids);
    const overdue = new Map(overdueRows.map(r => [r.user_id, parseInt(r.cnt, 10)]));

    // Closed-in-period count + average days-to-close (when both created_at + closed_at are present)
    const periodWhere = (from && to)
      ? `AND t.closed_at >= ? AND t.closed_at <= ?`
      : (from ? `AND t.closed_at >= ?` : (to ? `AND t.closed_at <= ?` : ''));
    const periodArgs = [from, to].filter(Boolean);
    const closedRows = await all(`
      SELECT u.id AS user_id,
             COUNT(DISTINCT t.id) AS cnt,
             AVG(
               CASE WHEN t.created_at IS NOT NULL AND t.closed_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (
                          TO_TIMESTAMP(t.closed_at,  'YYYY-MM-DD HH24:MI:SS')
                        - TO_TIMESTAMP(t.created_at, 'YYYY-MM-DD HH24:MI:SS')
                        )) / 86400.0
                    ELSE NULL END) AS avg_days
        FROM users u
        LEFT JOIN tickets t ON t.deleted_at IS NULL
          AND t.status = 'Closed'
          AND t.closed_at IS NOT NULL
          ${periodWhere}
          AND (t.assignee_user_id = u.id
               OR (t.assignee_user_id IS NULL AND t.assignee = u.name)
               OR EXISTS (SELECT 1 FROM ticket_assignees ta
                            WHERE ta.ticket_id = t.id
                              AND (ta.user_id = u.id OR (ta.user_id IS NULL AND ta.user_name = u.name))))
       WHERE u.id IN (${ph})
       GROUP BY u.id`, ...periodArgs, ...ids);
    const closed = new Map(closedRows.map(r => [r.user_id, parseInt(r.cnt, 10)]));
    const avgDays = new Map(closedRows.map(r => [r.user_id, r.avg_days != null ? Number(r.avg_days) : null]));

    // Comments authored in period
    const commentsRows = await all(`
      SELECT COALESCE(c.author_user_id, (SELECT id FROM users WHERE name=c.author ORDER BY id ASC LIMIT 1)) AS user_id,
             COUNT(*) AS cnt,
             MAX(c.created_at) AS last_at
        FROM ticket_comments c
       WHERE 1=1
         ${from ? `AND c.created_at >= ?` : ''}
         ${to   ? `AND c.created_at <= ?` : ''}
       GROUP BY user_id`,
      ...[from, to].filter(Boolean));
    const comments = new Map();
    const lastActiveByComment = new Map();
    for (const r of commentsRows) {
      if (r.user_id != null) {
        comments.set(r.user_id, parseInt(r.cnt, 10));
        lastActiveByComment.set(r.user_id, r.last_at || null);
      }
    }

    const out = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role || '',
      dept: u.dept || '',
      avatarUrl: u.avatar_url || '',
      permRole: u.perm_role || 'Member',
      openTickets:    open.get(u.id)    || 0,
      overdueTickets: overdue.get(u.id) || 0,
      closedInPeriod: closed.get(u.id)  || 0,
      avgDaysToClose: avgDays.get(u.id) != null ? Math.round(avgDays.get(u.id) * 10) / 10 : null,
      commentsInPeriod: comments.get(u.id) || 0,
      lastActiveAt:   lastActiveByComment.get(u.id) || null,
    }));
    res.json(out);
  } catch (e) {
    console.error('[reports:user-performance] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reports/user/:id/tickets?from=&to=
// Every ticket the user touched in the period: assigned to them (primary
// or additional), reporter on, requester on, OR created. Each row
// carries enough for the drawer to render without a second fetch.
app.get('/api/reports/user/:id/tickets', requireStrictAdmin, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const target = await get('SELECT id, name FROM users WHERE id=?', uid);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { from, to } = _periodBounds(req);
    // "Touched in period" is a slightly fuzzy thing — we use ticket
    // created_at as the floor; closed_at <= to for closed tickets. A
    // user might have updated an old ticket in the period; we surface
    // those via comments later if needed. For now keep it simple and
    // fast: any active relationship to the user, optionally filtered by
    // the created/closed window if either bound is set.
    const periodClause = (from && to)
      ? `AND ((t.created_at >= ? AND t.created_at <= ?)
              OR (t.closed_at IS NOT NULL AND t.closed_at >= ? AND t.closed_at <= ?))`
      : '';
    const args = (from && to) ? [from, to, from, to] : [];
    const rows = await all(`
      SELECT t.* FROM tickets t
       WHERE t.deleted_at IS NULL
         AND (t.assignee_user_id = ?
              OR (t.assignee_user_id IS NULL AND t.assignee = ?)
              OR EXISTS (
                   SELECT 1 FROM ticket_assignees ta
                    WHERE ta.ticket_id = t.id
                      AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
                 )
              OR t.reporter_user_id = ?
              OR (t.reporter_user_id IS NULL AND t.reporter = ?)
              OR t.req_user_id = ?
              OR (t.req_user_id IS NULL AND t.req = ?)
              OR t.created_by = ?)
         ${periodClause}
       ORDER BY t.id DESC`,
      target.id, target.name, target.id, target.name,
      target.id, target.name, target.id, target.name, target.id,
      ...args
    );
    const tickets = await Promise.all((rows || []).map(buildTicket));
    res.json(tickets);
  } catch (e) {
    console.error('[reports:user-tickets] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reports/user/:id/request-update
// Body: { ticketIds: [...], note: '' }
// Sends a single email to the target user with the full list of selected
// tickets + an optional note. Also drops a timeline row on each ticket
// so the audit trail shows the request was made.
app.post('/api/reports/user/:id/request-update', requireStrictAdmin, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const target = await get('SELECT id, name, email FROM users WHERE id=?', uid);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!target.email) return res.status(400).json({ error: 'User has no email on file' });
    const ids = Array.isArray(req.body?.ticketIds)
      ? req.body.ticketIds.map(String).filter(Boolean).slice(0, 50)
      : [];
    if (!ids.length) return res.status(400).json({ error: 'ticketIds required' });
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    const me = await getUser(req.session.userId);
    const ph = ids.map(() => '?').join(',');
    const rows = await all(
      `SELECT id, title, status, priority, due FROM tickets WHERE id IN (${ph}) AND deleted_at IS NULL`,
      ...ids
    );
    if (!rows.length) return res.status(400).json({ error: 'No valid tickets found' });
    fireEmail('bulk-update-requested', () => sendBulkUpdateRequestedEmail({
      toEmail: target.email,
      toName:  target.name,
      requesterName: me?.name || 'An admin',
      note,
      tickets: rows.map(r => ({
        id: r.id, title: r.title, status: r.status, priority: r.priority, dueAt: r.due,
      })),
    }));
    for (const r of rows) {
      writeTimeline(r.id, TL.assign, `${me?.name || 'An admin'} requested an update from ${target.name} (via Reports)`);
      run(
        'INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
        target.id, 'comment', '📩',
        `${me?.name || 'An admin'} is asking for an update on "${r.title || r.id}"`,
        r.id
      ).catch(() => {});
    }
    res.json({ ok: true, sentTo: target.email, tickets: rows.length });
  } catch (e) {
    console.error('[reports:request-update] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Tickets Live (read-only wallboard) ───────────────────────────────────────
// GET /api/tickets-live?user=<id>
// Per-user responsiveness board: open tickets, tickets waiting on the user's
// reply (pending update requests + comments by others they haven't answered),
// how long each has been waiting, and avg reply/close speed. Members always
// get their own board regardless of ?user; Admin/Manager can target any user
// or omit ?user for one board per workspace user (team view).
const _TL_INVOLVED = `
      (t.assignee_user_id = ?
       OR (t.assignee_user_id IS NULL AND t.assignee = ?)
       OR EXISTS (SELECT 1 FROM ticket_assignees ta
                   WHERE ta.ticket_id = t.id
                     AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))))`;

async function ticketsLiveBoard(u, nowUtc, cutoff30) {
  const uid = u.id, uname = u.name;
  // "My last comment on this ticket" — used both to detect unanswered
  // comments by others and to decide whether an update request is still
  // pending (a comment after the request counts as the reply). Takes an
  // alias so it can be embedded several times in one statement.
  const myLastComment = (a) => `
      (SELECT MAX(${a}.created_at) FROM ticket_comments ${a}
        WHERE ${a}.ticket_id = t.id
          AND (${a}.author_user_id = ? OR (${a}.author_user_id IS NULL AND ${a}.author = ?)))`;
  const rows = await all(`
    SELECT t.id, t.title, t.priority, t.status, t.due, t.overdue,
           t.created_at, t.snoozed_until,
           ${myLastComment('mc')} AS my_last_comment_at,
           (SELECT MAX(oc.created_at) FROM ticket_comments oc
             WHERE oc.ticket_id = t.id
               AND oc.author_user_id IS DISTINCT FROM ?
               AND NOT (oc.author_user_id IS NULL AND oc.author = ?)) AS others_last_comment_at,
           (SELECT MIN(wc.created_at) FROM ticket_comments wc
             WHERE wc.ticket_id = t.id
               AND wc.author_user_id IS DISTINCT FROM ?
               AND NOT (wc.author_user_id IS NULL AND wc.author = ?)
               AND wc.created_at > COALESCE(${myLastComment('c2')}, '')) AS waiting_since_comment,
           (SELECT MAX(n.created_at) FROM notifications n
             WHERE n.user_id = ?
               AND n.ticket_id = t.id
               AND (n.type = 'update-requested'
                    OR (n.type = 'comment' AND n.text LIKE '%asking for an update%'))
               AND n.created_at > COALESCE(${myLastComment('c3')}, '')) AS update_requested_at
      FROM tickets t
     WHERE t.deleted_at IS NULL
       AND t.status NOT IN ('Closed','Archived')
       AND ${_TL_INVOLVED}
     ORDER BY t.id DESC`,
    uid, uname,                    // my_last_comment_at
    uid, uname,                    // others_last_comment_at
    uid, uname, uid, uname,        // waiting_since_comment (+ inner c2)
    uid, uid, uname,               // update_requested_at (n.user_id + inner c3)
    uid, uname, uid, uname         // involvement
  );

  const tickets = rows.map(r => {
    const snoozed = !!(r.snoozed_until && r.snoozed_until > nowUtc);
    const commentSince = r.waiting_since_comment || null;
    const updateSince  = r.update_requested_at || null;
    let waitingSince = null;
    if (commentSince && updateSince) waitingSince = commentSince < updateSince ? commentSince : updateSince;
    else waitingSince = commentSince || updateSince;
    const needsReply = !snoozed && !!waitingSince;
    return {
      id: r.id,
      title: r.title || '',
      priority: r.priority || 'Medium',
      status: r.status || 'Open',
      due: r.due || '',
      overdue: Number(r.overdue) === 1,
      createdAt: r.created_at || null,
      snoozed,
      myLastReplyAt: r.my_last_comment_at || null,
      othersLastCommentAt: r.others_last_comment_at || null,
      updateRequestedAt: updateSince,
      newCommentSince: commentSince,
      waitingSince: needsReply ? waitingSince : null,
      needsReply,
    };
  });

  // Reply speed: for every comment by someone else on a ticket the user is
  // assigned to, the gap until the user's next comment on that ticket.
  const replyStats = await get(`
    SELECT AVG(gap_h) AS avg_hours_all,
           COUNT(*)   AS replies_all,
           AVG(CASE WHEN prompt_at >= ? THEN gap_h END)  AS avg_hours_30,
           COUNT(CASE WHEN prompt_at >= ? THEN 1 END)    AS replies_30
      FROM (
        SELECT c.created_at AS prompt_at,
               EXTRACT(EPOCH FROM (TO_TIMESTAMP(rep.created_at, 'YYYY-MM-DD HH24:MI:SS')
                                 - TO_TIMESTAMP(c.created_at,   'YYYY-MM-DD HH24:MI:SS'))) / 3600.0 AS gap_h
          FROM ticket_comments c
          JOIN tickets t ON t.id = c.ticket_id AND t.deleted_at IS NULL
          CROSS JOIN LATERAL (
            SELECT rc.created_at FROM ticket_comments rc
             WHERE rc.ticket_id = c.ticket_id
               AND (rc.author_user_id = ? OR (rc.author_user_id IS NULL AND rc.author = ?))
               AND rc.created_at > c.created_at
             ORDER BY rc.created_at ASC LIMIT 1
          ) rep
         WHERE c.author_user_id IS DISTINCT FROM ?
           AND NOT (c.author_user_id IS NULL AND c.author = ?)
           AND ${_TL_INVOLVED}
      ) g`,
    cutoff30, cutoff30, uid, uname, uid, uname, uid, uname, uid, uname);

  // Close speed: created_at → closed_at on tickets the user was assigned to.
  const closeStats = await get(`
    SELECT COUNT(*)      AS closed_all,
           AVG(close_d)  AS avg_days_all,
           COUNT(CASE WHEN closed_at >= ? THEN 1 END)   AS closed_30,
           AVG(CASE WHEN closed_at >= ? THEN close_d END) AS avg_days_30
      FROM (
        SELECT t.closed_at,
               EXTRACT(EPOCH FROM (TO_TIMESTAMP(t.closed_at,  'YYYY-MM-DD HH24:MI:SS')
                                 - TO_TIMESTAMP(t.created_at, 'YYYY-MM-DD HH24:MI:SS'))) / 86400.0 AS close_d
          FROM tickets t
         WHERE t.deleted_at IS NULL
           AND t.status = 'Closed'
           AND t.closed_at IS NOT NULL AND t.closed_at <> ''
           AND t.created_at IS NOT NULL AND t.created_at <> ''
           AND ${_TL_INVOLVED}
      ) g`,
    cutoff30, cutoff30, uid, uname, uid, uname);

  const num = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
  const active = tickets.filter(t => !t.snoozed);
  return {
    id: u.id,
    name: u.name,
    role: u.role || '',
    dept: u.dept || '',
    color: u.color || '#2563eb',
    avatarUrl: u.avatar_url || '',
    openCount: tickets.length,
    needsReplyCount: active.filter(t => t.needsReply).length,
    updateRequestedCount: active.filter(t => t.updateRequestedAt).length,
    newCommentCount: active.filter(t => t.newCommentSince).length,
    overdueCount: active.filter(t => t.overdue).length,
    avgReplyHours30:  num(replyStats?.avg_hours_30),
    avgReplyHoursAll: num(replyStats?.avg_hours_all),
    repliesCount30:   parseInt(replyStats?.replies_30 || 0, 10),
    avgCloseDays30:   num(closeStats?.avg_days_30),
    avgCloseDaysAll:  num(closeStats?.avg_days_all),
    closedCount30:    parseInt(closeStats?.closed_30 || 0, 10),
    closedCountAll:   parseInt(closeStats?.closed_all || 0, 10),
    tickets,
  };
}

app.get('/api/tickets-live', requireAuth, async (req, res) => {
  try {
    const me = await getUser(req.session.userId);
    if (!me) return res.status(401).json({ error: 'Not signed in' });
    const isAdmin = ['Admin', 'Manager'].includes(me.perm_role);
    const requestedId = req.query.user ? Number(req.query.user) : null;

    let targets;
    if (!isAdmin) {
      // Members only ever see their own board — ?user is ignored.
      targets = [me];
    } else if (requestedId) {
      const t = await get('SELECT id,name,role,dept,color,avatar_url FROM users WHERE id=?', requestedId);
      if (!t) return res.status(404).json({ error: 'User not found' });
      targets = [t];
    } else {
      targets = await all('SELECT id,name,role,dept,color,avatar_url FROM users ORDER BY LOWER(name) ASC');
    }

    const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const users = [];
    for (const t of targets) users.push(await ticketsLiveBoard(t, nowUtc, cutoff30));

    res.json({
      now: nowUtc,
      mode: targets.length > 1 ? 'team' : 'user',
      viewer: { id: me.id, name: me.name, isAdmin },
      users,
    });
  } catch (e) {
    console.error('[tickets-live] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Tickets Live share links ─────────────────────────────────────────────────
// Each user gets a secret token so their board can be opened WITHOUT logging
// in (wall display / a link you send to the employee). The token is generated
// lazily on first request and can be rotated by an admin to kill a leaked link.
async function ensureBoardToken(userId) {
  const row = await get('SELECT live_board_token FROM users WHERE id=?', userId);
  if (!row) return null;
  if (row.live_board_token) return row.live_board_token;
  const token = randomBytes(24).toString('hex');
  await run('UPDATE users SET live_board_token=? WHERE id=?', token, userId);
  return token;
}
function boardLinkUrl(req, token) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/tickets-live.html?board=${token}`;
}

// The signed-in user's own share link.
app.get('/api/tickets-live/my-link', requireAuth, async (req, res) => {
  try {
    const token = await ensureBoardToken(req.session.userId);
    if (!token) return res.status(404).json({ error: 'User not found' });
    res.json({ userId: req.session.userId, url: boardLinkUrl(req, token) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin/Manager: every user's share link.
app.get('/api/tickets-live/links', requireAdmin, async (req, res) => {
  try {
    const users = await all('SELECT id, name, email FROM users ORDER BY LOWER(name) ASC');
    const out = [];
    for (const u of users) {
      const token = await ensureBoardToken(u.id);
      out.push({ id: u.id, name: u.name, email: u.email, url: boardLinkUrl(req, token) });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin/Manager: rotate a user's token — the old link stops working.
app.post('/api/tickets-live/links/:id/rotate', requireAdmin, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const u = await get('SELECT id FROM users WHERE id=?', uid);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const token = randomBytes(24).toString('hex');
    await run('UPDATE users SET live_board_token=? WHERE id=?', token, uid);
    res.json({ userId: uid, url: boardLinkUrl(req, token) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team-board share link: one workspace-level secret token so the WHOLE team
// view can run on a wall display without a login session. Same rules as the
// per-user tokens — lazy-generated, admin-rotatable, unknown token → 404.
async function ensureTeamBoardToken() {
  const row = await get(`SELECT value FROM app_settings WHERE key='tickets_live_team_token'`);
  if (row && row.value) return row.value;
  const token = randomBytes(24).toString('hex');
  await run(
    `INSERT INTO app_settings (key, value) VALUES ('tickets_live_team_token', ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, token);
  return token;
}
function teamLinkUrl(req, token) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/tickets-live.html?team=${token}`;
}

app.get('/api/tickets-live/team-link', requireAdmin, async (req, res) => {
  try {
    res.json({ url: teamLinkUrl(req, await ensureTeamBoardToken()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets-live/team-link/rotate', requireAdmin, async (req, res) => {
  try {
    const token = randomBytes(24).toString('hex');
    await run(
      `INSERT INTO app_settings (key, value) VALUES ('tickets_live_team_token', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, token);
    res.json({ url: teamLinkUrl(req, token) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public team board — NO auth, gated by the workspace token. Includes each
// user's personal board URL so rows stay clickable (that data is a subset
// of what this payload already contains).
app.get('/api/tickets-live/team/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ error: 'Board not found' });
    const row = await get(`SELECT value FROM app_settings WHERE key='tickets_live_team_token'`);
    if (!row || !row.value || row.value !== token) return res.status(404).json({ error: 'Board not found' });
    const targets = await all('SELECT id,name,role,dept,color,avatar_url FROM users ORDER BY LOWER(name) ASC');
    const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const users = [];
    const links = {};
    for (const t of targets) {
      users.push(await ticketsLiveBoard(t, nowUtc, cutoff30));
      links[t.id] = boardLinkUrl(req, await ensureBoardToken(t.id));
    }
    res.json({ now: nowUtc, mode: 'team', public: true, viewer: null, users, links });
  } catch (e) {
    console.error('[tickets-live:team] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Public board — NO auth. The 48-hex-char token IS the credential; an
// unknown token is a plain 404. Read-only by construction (GET, and the
// handler only ever SELECTs). Exposes exactly what the personal board
// shows for that one user, nothing workspace-wide.
app.get('/api/tickets-live/board/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ error: 'Board not found' });
    const u = await get('SELECT id,name,role,dept,color,avatar_url FROM users WHERE live_board_token=?', token);
    if (!u) return res.status(404).json({ error: 'Board not found' });
    const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const board = await ticketsLiveBoard(u, nowUtc, cutoff30);
    res.json({ now: nowUtc, mode: 'user', public: true, viewer: null, users: [board] });
  } catch (e) {
    console.error('[tickets-live:board] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Ticket nag schedule ──────────────────────────────────────────────────────
// Admin-configured, per user: at each configured time of day (in the config's
// timezone), if the user still has tickets matching the configured triggers,
// a digest email goes to EVERY configured address and an SMS to the phone.
// When nothing is pending the run sends nothing — so the nagging stops on its
// own once every ticket is replied to / closed.
const NAG_TRIGGERS = ['needsReply', 'updateRequested', 'overdue', 'dueSoon'];

function _nagParseArr(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function _nagSerialize(cfg, userRow) {
  return {
    userId: cfg.user_id,
    name: userRow?.name,
    enabled: Number(cfg.enabled) === 1,
    emails: _nagParseArr(cfg.emails),
    phone: cfg.phone || '',
    times: _nagParseArr(cfg.times),
    tz: cfg.tz || '',
    triggers: _nagParseArr(cfg.triggers),
    dueSoonDays: Number(cfg.due_soon_days) || 0,
    lastSentKey: cfg.last_sent_key || '',
  };
}

// Everything currently actionable for the user, filtered by the config's
// triggers. Reuses the live-board derivation so the definition of "needs
// reply" / "update requested" is identical to what the wallboard shows.
async function nagItemsForUser(user, cfg) {
  const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const board = await ticketsLiveBoard(user, nowUtc, cutoff30);
  const triggers = new Set(_nagParseArr(cfg.triggers));
  const dueSoonMs = (Number(cfg.due_soon_days) || 0) * 86400000;
  const items = [];
  for (const t of board.tickets) {
    if (t.snoozed) continue;
    const reasons = [];
    if (triggers.has('updateRequested') && t.updateRequestedAt) reasons.push('update requested');
    if (triggers.has('needsReply') && t.newCommentSince) reasons.push('reply needed');
    if (triggers.has('overdue') && t.overdue) reasons.push('overdue');
    if (triggers.has('dueSoon') && !t.overdue && t.due && dueSoonMs > 0) {
      const d = new Date(t.due);
      if (!isNaN(d)) {
        const diff = d.getTime() - Date.now();
        if (diff >= 0 && diff <= dueSoonMs) reasons.push(`due in ${Math.max(1, Math.ceil(diff / 86400000))}d`);
      }
    }
    if (reasons.length) items.push({ id: t.id, title: t.title, reasons, due: t.due });
  }
  return items;
}

// Fan out one nag run (all emails + SMS). Returns what was sent.
async function dispatchNag(user, cfg, timeLabel) {
  const items = await nagItemsForUser(user, cfg);
  if (!items.length) return { items: 0, emails: 0, sms: false };
  const emails = _nagParseArr(cfg.emails).filter(e => /\S+@\S+\.\S+/.test(e));
  for (const em of emails) {
    fireEmail('ticket-nag', () => sendTicketNagEmail({ toEmail: em, targetName: user.name, items, timeLabel }));
  }
  let smsSent = false;
  if (cfg.phone) {
    const top = items.slice(0, 5).map(i => `${i.id} (${i.reasons.join(', ')})`).join('; ');
    const more = items.length > 5 ? ` +${items.length - 5} more` : '';
    const link = (process.env.APP_URL || '').replace(/\/+$/, '');
    const body = `Syruvia: ${user.name}, ${items.length} ticket${items.length === 1 ? '' : 's'} need your action — ${top}${more}. Reply or close them.${link ? ' ' + link + '/my-tickets' : ''}`;
    try { await sendSms(cfg.phone, body); smsSent = true; }
    catch (e) { console.warn('[nag] sms failed for', user.name, '-', e.message); }
  }
  return { items: items.length, emails: emails.length, sms: smsSent };
}

// Runs twice a minute; a config fires when the current HH:MM in its timezone
// matches one of its times. last_sent_key (claimed BEFORE sending) makes the
// fire idempotent within that minute.
async function runTicketNagJob() {
  try {
    const cfgs = await all(`
      SELECT c.*, u.name, u.tz AS user_tz
        FROM ticket_nag_configs c JOIN users u ON u.id = c.user_id
       WHERE c.enabled = 1`);
    for (const cfg of cfgs) {
      const times = _nagParseArr(cfg.times);
      if (!times.length) continue;
      const tz = cfg.tz || cfg.user_tz || 'UTC';
      let hhmm, dayKey;
      try {
        hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
        dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      } catch {
        hhmm = new Date().toISOString().slice(11, 16);
        dayKey = new Date().toISOString().slice(0, 10);
      }
      if (!times.includes(hhmm)) continue;
      const sentKey = `${dayKey} ${hhmm}`;
      if (cfg.last_sent_key === sentKey) continue;
      await run('UPDATE ticket_nag_configs SET last_sent_key=? WHERE user_id=?', sentKey, cfg.user_id);
      const user = await get('SELECT id, name FROM users WHERE id=?', cfg.user_id);
      if (!user) continue;
      const r = await dispatchNag(user, cfg, hhmm);
      if (r.items) console.log(`[nag] ${sentKey} → ${user.name}: ${r.items} item(s), ${r.emails} email(s)${r.sms ? ' + sms' : ''}`);
    }
  } catch (e) { console.error('[cron:ticket-nag]', e.message); }
}

// All configs (one row per workspace user, config nullable).
app.get('/api/ticket-nags', requireAdmin, async (req, res) => {
  try {
    const rows = await all(`
      SELECT u.id, u.name, u.tz AS user_tz, c.*
        FROM users u LEFT JOIN ticket_nag_configs c ON c.user_id = u.id
       ORDER BY LOWER(u.name) ASC`);
    res.json(rows.map(r => r.user_id
      ? _nagSerialize(r, { name: r.name })
      : { userId: r.id, name: r.name, enabled: false, emails: [], phone: '', times: [], tz: r.user_tz || '', triggers: NAG_TRIGGERS.slice(), dueSoonDays: 2 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ticket-nags/:userId', requireAdmin, async (req, res) => {
  try {
    const uid = Number(req.params.userId);
    const user = await get('SELECT id, name FROM users WHERE id=?', uid);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const b = req.body || {};
    const emails = (Array.isArray(b.emails) ? b.emails : [])
      .map(e => String(e).trim().toLowerCase()).filter(e => /\S+@\S+\.\S+/.test(e)).slice(0, 20);
    const times = (Array.isArray(b.times) ? b.times : [])
      .map(t => String(t).trim()).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    const triggers = (Array.isArray(b.triggers) ? b.triggers : []).filter(t => NAG_TRIGGERS.includes(t));
    const phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
    const tz = String(b.tz || '').trim().slice(0, 64);
    if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { return res.status(400).json({ error: `Unknown timezone: ${tz}` }); } }
    const dueSoonDays = Math.min(30, Math.max(0, Number(b.dueSoonDays) || 0));
    const enabled = b.enabled ? 1 : 0;
    await run(`
      INSERT INTO ticket_nag_configs (user_id, enabled, emails, phone, times, tz, triggers, due_soon_days, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, TO_CHAR(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
      ON CONFLICT (user_id) DO UPDATE SET
        enabled = EXCLUDED.enabled, emails = EXCLUDED.emails, phone = EXCLUDED.phone,
        times = EXCLUDED.times, tz = EXCLUDED.tz, triggers = EXCLUDED.triggers,
        due_soon_days = EXCLUDED.due_soon_days, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      uid, enabled, JSON.stringify(emails), phone, JSON.stringify(times), tz,
      JSON.stringify(triggers.length ? triggers : NAG_TRIGGERS), dueSoonDays, req.session.userId);
    const row = await get('SELECT * FROM ticket_nag_configs WHERE user_id=?', uid);
    res.json(_nagSerialize(row, user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fire one nag run right now (ignores the schedule) — lets the admin verify
// delivery without waiting for the next configured time.
app.post('/api/ticket-nags/:userId/test', requireAdmin, async (req, res) => {
  try {
    const uid = Number(req.params.userId);
    const user = await get('SELECT id, name FROM users WHERE id=?', uid);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const cfg = await get('SELECT * FROM ticket_nag_configs WHERE user_id=?', uid);
    if (!cfg) return res.status(400).json({ error: 'No nag schedule saved for this user yet' });
    const r = await dispatchNag(user, cfg, 'manual');
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Syruvia Lab Bridge ────────────────────────────────────────────────────────
// Cross-app API for syncing tickets ↔ Syruvia Lab flavors.
// All bridge routes require the shared CROSS_APP_SECRET in the Authorization header.
const CROSS_APP_SECRET = process.env.CROSS_APP_SECRET || '';
const SYRUVIA_URL      = process.env.SYRUVIA_URL      || '';

function bridgeCors(req, res, next) {
  res.header('Access-Control-Allow-Origin', SYRUVIA_URL || '*');
  res.header('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
function requireBridgeSecret(req, res, next) {
  if (!CROSS_APP_SECRET) return res.status(503).json({ error: 'Bridge not configured — set CROSS_APP_SECRET env var' });
  if (req.headers['authorization'] !== `Bearer ${CROSS_APP_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/bridge/flavor-tickets?flavor_id=X — all tickets linked to a Syruvia flavor
app.options('/api/bridge/flavor-tickets', bridgeCors);
app.get('/api/bridge/flavor-tickets', bridgeCors, requireBridgeSecret, async (req, res) => {
  try {
    const { flavor_id } = req.query;
    if (!flavor_id) return res.json([]);
    const rows = await all(
      `SELECT id, title, status, priority, assignee, due, created, overdue, syruvia_flavor_id, syruvia_flavor_name
       FROM tickets WHERE syruvia_flavor_id = ? AND deleted_at IS NULL ORDER BY id DESC`,
      String(flavor_id)
    );
    res.json(rows || []);
  } catch (e) { console.error('[bridge] flavor-tickets error:', e.message); res.json([]); }
});

// GET /api/bridge/calendar-events — tickets with due dates (for Syruvia's calendar)
app.options('/api/bridge/calendar-events', bridgeCors);
app.get('/api/bridge/calendar-events', bridgeCors, requireBridgeSecret, async (req, res) => {
  try {
    const tickets = await all(
      `SELECT id, title, status, priority, due, assignee, syruvia_flavor_id, syruvia_flavor_name
       FROM tickets WHERE due != '' AND deleted_at IS NULL AND status != 'Closed' ORDER BY id DESC LIMIT 300`
    );
    res.json({ tickets: tickets || [] });
  } catch (e) { console.error('[bridge] calendar-events error:', e.message); res.json({ tickets: [] }); }
});

// GET /api/syruvia-flavors — proxy to Syruvia Lab so the browser avoids cross-origin fetch
// Returns the flavor list from Syruvia using the shared secret (server-to-server).
app.get('/api/syruvia-flavors', requireAuth, async (req, res) => {
  if (!SYRUVIA_URL || !CROSS_APP_SECRET) return res.json([]);
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(SYRUVIA_URL + '/api/bridge/flavors', {
      headers: { Authorization: `Bearer ${CROSS_APP_SECRET}` },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!r.ok) return res.json([]);
    res.json(await r.json());
  } catch (e) {
    console.error('[syruvia-flavors proxy] error:', e.message);
    res.json([]);
  }
});

// PATCH /api/tickets/:id/link-flavor — link/unlink a Syruvia flavor (requires login)
app.patch('/api/tickets/:id/link-flavor', requireAuth, async (req, res) => {
  try {
    const { syruvia_flavor_id, syruvia_flavor_name } = req.body;
    await run(
      'UPDATE tickets SET syruvia_flavor_id=?, syruvia_flavor_name=? WHERE id=? AND deleted_at IS NULL',
      syruvia_flavor_id || null, syruvia_flavor_name || null, req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Workspace chat ────────────────────────────────────────────────────────────
// ClickUp / Slack–style chat. Three flavours of "channel" share one table:
//   * type='channel' — named room, optionally private with explicit member list
//   * type='dm'      — 1:1 between exactly two users (dm_key = "min:max" sorted)
//   * type='group'   — ad-hoc 3+ person DM
//
// Realtime is over a single WebSocket connection per browser tab, mounted on
// the main HTTP server further down. The WS authenticates by reusing the
// Express session middleware, so the same login cookie works for both REST
// and the socket — no separate token plumbing.
const WebSocket = require('ws');
const http = require('http');

// userId → Set<ws>. A user can have multiple sockets (multiple tabs / devices).
const wsClientsByUser = new Map();

function wsRegister(userId, ws) {
  if (!wsClientsByUser.has(userId)) wsClientsByUser.set(userId, new Set());
  wsClientsByUser.get(userId).add(ws);
}
function wsUnregister(userId, ws) {
  const set = wsClientsByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) wsClientsByUser.delete(userId);
}
function wsSendToUser(userId, payload) {
  const set = wsClientsByUser.get(userId);
  if (!set || !set.size) return;
  const json = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(json); } catch {}
    }
  }
}
async function wsBroadcastToChannel(channelId, payload, exceptUserId) {
  let members = [];
  try {
    members = await all('SELECT user_id FROM chat_channel_members WHERE channel_id=?', channelId);
  } catch { return; }
  for (const m of members) {
    if (exceptUserId && m.user_id === exceptUserId) continue;
    wsSendToUser(m.user_id, payload);
  }
}

// Deterministic key for a 1:1 DM channel — "min:max" of the two user ids.
// Lets us upsert-by-key without scanning members.
function chatDmKey(a, b) {
  const x = Number(a), y = Number(b);
  return (x < y ? `${x}:${y}` : `${y}:${x}`);
}

// Verify the calling session is a member of the given channel. Returns the
// member row or null. Routes that need write access call this and 404 on
// null to keep "no access" indistinguishable from "doesn't exist".
async function chatGetMembership(req, channelId) {
  if (!req.session?.userId) return null;
  return get(
    'SELECT * FROM chat_channel_members WHERE channel_id=? AND user_id=?',
    channelId, req.session.userId
  );
}

// Pull every @name token out of a raw message body and resolve them against
// real users. Longest-prefix match (mirrors the comment mention parser),
// case-insensitive. Returns an array of { id, name } user rows — no dupes.
async function chatParseMentions(body) {
  if (!body) return [];
  // Match an @ followed by 1+ word/space chars (we'll trim back to a real
  // user via DB lookup). Greedy by design — we want "@John Doe", not "@John".
  const tokens = String(body).match(/@([\w][\w .'-]{0,40})/g) || [];
  if (!tokens.length) return [];
  const users = await all('SELECT id, name FROM users');
  const seen = new Set();
  const out = [];
  for (const tok of tokens) {
    const raw = tok.slice(1).trim().toLowerCase(); // drop leading @
    if (!raw) continue;
    // Find the user whose name forms the longest prefix of this token.
    let best = null;
    for (const u of users) {
      const n = (u.name || '').toLowerCase();
      if (!n) continue;
      if (raw === n || raw.startsWith(n + ' ') || raw.startsWith(n)) {
        if (!best || n.length > best.name.length) best = u;
      }
    }
    if (best && !seen.has(best.id)) {
      seen.add(best.id);
      out.push(best);
    }
  }
  return out;
}

// Hydrate one or more raw chat_messages rows into the wire shape used by the
// REST + WS API. Pulls author display info, attachments, reactions (grouped
// by emoji), reply count for thread previews, and the parsed mention list.
async function chatHydrateMessages(rows) {
  if (!rows || !rows.length) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const [authors, attachments, reactionRows, replyRows, mentionRows] = await Promise.all([
    (async () => {
      const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
      if (!userIds.length) return [];
      const ph = userIds.map(() => '?').join(',');
      return all(`SELECT id, name, avatar_url, color FROM users WHERE id IN (${ph})`, ...userIds);
    })(),
    all(
      `SELECT id, chat_message_id, filename, original_name, mime_type, size, uploader, created_at
         FROM attachments WHERE chat_message_id IN (${placeholders})`,
      ...ids
    ),
    all(
      `SELECT message_id, emoji, user_id FROM chat_message_reactions
         WHERE message_id IN (${placeholders})`,
      ...ids
    ),
    all(
      `SELECT parent_message_id AS pid, COUNT(*) AS n,
              MAX(created_at) AS last_reply_at
         FROM chat_messages
        WHERE parent_message_id IN (${placeholders}) AND deleted_at IS NULL
        GROUP BY parent_message_id`,
      ...ids
    ),
    all(
      `SELECT m.message_id, m.user_id, u.name FROM chat_mentions m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.message_id IN (${placeholders})`,
      ...ids
    ),
  ]);
  const authorById = new Map(authors.map(a => [a.id, a]));
  const attsByMsg = new Map();
  for (const a of attachments) {
    if (!attsByMsg.has(a.chat_message_id)) attsByMsg.set(a.chat_message_id, []);
    attsByMsg.get(a.chat_message_id).push({
      id: a.id, filename: a.filename, originalName: a.original_name,
      mimeType: a.mime_type, size: a.size, uploader: a.uploader,
      createdAt: a.created_at, url: `/uploads/${a.filename}`,
    });
  }
  const reactionsByMsg = new Map();
  for (const r of reactionRows) {
    if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, new Map());
    const byEmoji = reactionsByMsg.get(r.message_id);
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  const repliesByMsg = new Map(replyRows.map(r => [r.pid, r]));
  const mentionsByMsg = new Map();
  for (const m of mentionRows) {
    if (!mentionsByMsg.has(m.message_id)) mentionsByMsg.set(m.message_id, []);
    mentionsByMsg.get(m.message_id).push({ id: m.user_id, name: m.name || '' });
  }
  // Inline reply enrichment — for any row that's a reply, fetch the parent's
  // author + body preview so the renderer can draw a WhatsApp-style quote
  // card above the bubble without a second round-trip per message.
  const parentIds = [...new Set(rows.map(r => r.parent_message_id).filter(Boolean))];
  let parentsById = new Map();
  if (parentIds.length) {
    const pph = parentIds.map(() => '?').join(',');
    const parentRows = await all(
      `SELECT m.id, m.body, m.user_id, m.deleted_at, u.name AS author_name
         FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.id IN (${pph})`,
      ...parentIds
    );
    parentsById = new Map(parentRows.map(p => [p.id, p]));
  }
  return rows.map(r => {
    const author = authorById.get(r.user_id) || null;
    const reactionMap = reactionsByMsg.get(r.id);
    const reactions = reactionMap
      ? [...reactionMap.entries()].map(([emoji, userIds]) => ({ emoji, userIds, count: userIds.length }))
      : [];
    const reply = repliesByMsg.get(r.id);
    const parent = r.parent_message_id ? parentsById.get(r.parent_message_id) : null;
    return {
      id: r.id,
      channelId: r.channel_id,
      parentMessageId: r.parent_message_id || null,
      userId: r.user_id,
      author: author ? {
        id: author.id, name: author.name, avatarUrl: author.avatar_url || '',
        color: author.color || '#2563eb',
      } : null,
      body: r.deleted_at ? '' : r.body,
      attachments: r.deleted_at ? [] : (attsByMsg.get(r.id) || []),
      reactions: r.deleted_at ? [] : reactions,
      mentions: mentionsByMsg.get(r.id) || [],
      replyTo: parent ? {
        id: parent.id,
        authorName: parent.author_name || '',
        body: parent.deleted_at ? '[deleted message]' : (parent.body || '[attachment]').slice(0, 200),
      } : null,
      replyCount: reply ? Number(reply.n) : 0,
      lastReplyAt: reply ? reply.last_reply_at : null,
      editedAt: r.edited_at || null,
      deletedAt: r.deleted_at || null,
      createdAt: r.created_at,
    };
  });
}

// Hard-purge cron: any chat group whose closed_at is older than 30 days
// gets fully deleted (rows + messages + reactions + mentions cascade via FK).
// Active and DM channels are never touched. Runs daily alongside the
// existing trash auto-purge job.
async function chatPurgeOldClosedGroups() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const old = await all(
      `SELECT id FROM chat_channels
        WHERE type = 'group' AND closed_at IS NOT NULL AND closed_at < ?`,
      cutoff
    );
    if (!old.length) return;
    for (const row of old) {
      await run('DELETE FROM chat_channels WHERE id=?', row.id);
    }
    console.log(`[chat] auto-purged ${old.length} closed group(s) past 30-day window`);
  } catch (e) { console.error('[chat:purge]', e.message); }
}

// Serialise one channel for the channel list — adds member-list (id+name),
// the current user's unread count, and the latest message preview.
async function chatSerializeChannel(channel, currentUserId) {
  const members = await all(
    `SELECT u.id, u.name, u.avatar_url, u.color, m.role, m.last_read_message_id, m.notify
       FROM chat_channel_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ?
      ORDER BY u.name`,
    channel.id
  );
  let myMember = null;
  if (currentUserId) {
    myMember = members.find(m => m.id === currentUserId) || null;
  }
  // Unread = messages with id > last_read_message_id and not authored by me.
  let unread = 0;
  let mentionUnread = 0;
  if (myMember) {
    const u = await get(
      `SELECT COUNT(*) AS n FROM chat_messages
         WHERE channel_id = ? AND id > ? AND user_id <> ? AND deleted_at IS NULL`,
      channel.id, myMember.last_read_message_id || 0, currentUserId
    );
    unread = u ? Number(u.n) : 0;
    const mu = await get(
      `SELECT COUNT(*) AS n FROM chat_mentions cm
         JOIN chat_messages m ON m.id = cm.message_id
        WHERE m.channel_id = ? AND cm.user_id = ?
          AND m.id > ? AND m.deleted_at IS NULL`,
      channel.id, currentUserId, myMember.last_read_message_id || 0
    );
    mentionUnread = mu ? Number(mu.n) : 0;
  }
  // Latest non-deleted message for the preview row.
  const last = await get(
    `SELECT m.id, m.body, m.user_id, m.created_at, u.name AS author_name
       FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ? AND m.deleted_at IS NULL
      ORDER BY m.id DESC LIMIT 1`,
    channel.id
  );
  return {
    id: channel.id,
    name: channel.name,
    description: channel.description || '',
    type: channel.type,
    isPrivate: !!channel.is_private,
    topic: channel.topic || '',
    dmKey: channel.dm_key || null,
    createdBy: channel.created_by,
    createdAt: channel.created_at,
    lastMessageAt: channel.last_message_at,
    closedAt: channel.closed_at || null,
    closedBy: channel.closed_by || null,
    members: members.map(m => ({
      id: m.id, name: m.name, avatarUrl: m.avatar_url || '',
      color: m.color || '#2563eb', role: m.role,
    })),
    me: myMember ? {
      role: myMember.role, lastReadMessageId: myMember.last_read_message_id || 0,
      notify: myMember.notify || 'all',
    } : null,
    unread,
    mentionUnread,
    lastMessage: last ? {
      id: last.id, body: last.body, userId: last.user_id,
      authorName: last.author_name || '', createdAt: last.created_at,
    } : null,
  };
}

// GET /api/chat/me — initial bootstrap for the chat page. Returns every
// channel the current user is a member of (channels + DMs), each with its
// unread count, member list, and latest-message preview.
app.get('/api/chat/me', requireAuth, async (req, res) => {
  try {
    const channels = await all(
      `SELECT c.* FROM chat_channels c
         JOIN chat_channel_members m ON m.channel_id = c.id
        WHERE m.user_id = ? AND m.hidden = 0
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      req.session.userId
    );
    const out = [];
    for (const c of channels) out.push(await chatSerializeChannel(c, req.session.userId));
    res.json({ channels: out });
  } catch (e) { console.error('[chat:me]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/chat/tickets — picker source for #-mentions inside the chat
// composer. Returns the caller's accessible tickets (Admin/Manager → all,
// Member → only ones they're involved in). Defaults to non-closed; pass
// includeClosed=1 to also return Closed rows. Free-text q= matches against
// ticket id and title (case-insensitive substring).
app.get('/api/chat/tickets', requireAuth, async (req, res) => {
  try {
    const u = await getUser(req.session.userId);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    const q = String(req.query.q || '').trim().toLowerCase();
    const includeClosed = String(req.query.includeClosed || '') === '1';
    const isAdmin = ['Admin', 'Manager'].includes(u.perm_role);
    const where = ['t.deleted_at IS NULL'];
    const args = [];
    if (!includeClosed) where.push("t.status <> 'Closed'");
    if (q) {
      where.push("(LOWER(t.id) LIKE ? OR LOWER(t.title) LIKE ?)");
      args.push('%' + q + '%', '%' + q + '%');
    }
    if (!isAdmin) {
      where.push(`(
        t.assignee_user_id = ?
        OR (t.assignee_user_id IS NULL AND t.assignee = ?)
        OR EXISTS (
          SELECT 1 FROM ticket_assignees ta
            WHERE ta.ticket_id = t.id
              AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?))
        )
        OR t.reporter_user_id = ?
        OR (t.reporter_user_id IS NULL AND t.reporter = ?)
        OR t.req_user_id = ?
        OR (t.req_user_id IS NULL AND t.req = ?)
        OR t.created_by = ?
      )`);
      args.push(u.id, u.name, u.id, u.name, u.id, u.name, u.id, u.name, u.id);
    }
    // Quick search → return whatever matches; no-query → most recent open.
    const rows = await all(
      `SELECT t.id, t.title, t.status, t.priority, t.assignee, t.dept
         FROM tickets t
        WHERE ${where.join(' AND ')}
        ORDER BY t.id DESC
        LIMIT 30`,
      ...args
    );
    res.json(rows || []);
  } catch (e) { console.error('[chat:tickets]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/chat/users — workspace directory used by "new chat" + add-member
// pickers. Excludes the caller (you can't DM yourself).
app.get('/api/chat/users', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, email, avatar_url, color, perm_role, dept
         FROM users WHERE id <> ? ORDER BY name`,
      req.session.userId
    );
    res.json(rows.map(u => ({
      id: u.id, name: u.name, email: u.email, avatarUrl: u.avatar_url || '',
      color: u.color || '#2563eb', permRole: u.perm_role, dept: u.dept,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/channels/browse — public channels the caller hasn't joined
// yet. Used by the "Browse channels" modal so they can join without an invite.
app.get('/api/chat/channels/browse', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT c.id, c.name, c.description, c.created_at,
              (SELECT COUNT(*) FROM chat_channel_members WHERE channel_id = c.id) AS member_count
         FROM chat_channels c
        WHERE c.type = 'channel' AND c.is_private = 0
          AND NOT EXISTS (
            SELECT 1 FROM chat_channel_members m
             WHERE m.channel_id = c.id AND m.user_id = ?
          )
        ORDER BY c.name ASC`,
      req.session.userId
    );
    res.json(rows.map(r => ({
      id: r.id, name: r.name, description: r.description || '',
      memberCount: Number(r.member_count || 0), createdAt: r.created_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels — create a new channel. Public channels are
// joinable by anyone via /browse; private channels can only be joined when
// added explicitly by a member with role='admin' (or the original creator).
app.post('/api/chat/channels', requireAuth, async (req, res) => {
  try {
    const { name, description, isPrivate, members } = req.body || {};
    const cleanName = String(name || '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 40);
    if (!cleanName) return res.status(400).json({ error: 'Channel name required' });
    // Reject duplicates of the same public channel name (DMs use dm_key, so
    // they're handled separately and don't collide with channels).
    const dup = await get(
      "SELECT id FROM chat_channels WHERE type='channel' AND lower(name)=?",
      cleanName
    );
    if (dup) return res.status(409).json({ error: 'A channel with that name already exists' });
    const ins = await run(
      `INSERT INTO chat_channels (name, description, type, is_private, created_by)
       VALUES (?,?,?,?,?) RETURNING id`,
      cleanName, String(description || '').slice(0, 500), 'channel',
      isPrivate ? 1 : 0, req.session.userId
    );
    const channelId = ins.lastInsertRowid;
    // Creator joins as admin so they can rename/delete and manage members.
    await run(
      'INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (?,?,?)',
      channelId, req.session.userId, 'admin'
    );
    // Optional initial member list for private channels.
    const memberIds = Array.isArray(members) ? members.map(Number).filter(n => n && n !== req.session.userId) : [];
    for (const uid of memberIds) {
      await run(
        'INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
        channelId, uid
      );
    }
    const row = await get('SELECT * FROM chat_channels WHERE id=?', channelId);
    const channel = await chatSerializeChannel(row, req.session.userId);
    // Notify every member's open sockets so the channel appears in their
    // sidebar without a refresh.
    for (const m of channel.members) {
      wsSendToUser(m.id, { type: 'channel:new', channel });
    }
    res.status(201).json(channel);
  } catch (e) { console.error('[chat:create]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/chat/channels/:id — full channel info for the caller. 404 when
// they're not a member (private) or the channel doesn't exist.
app.get('/api/chat/channels/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const member = await chatGetMembership(req, id);
    if (!member && row.is_private) return res.status(404).json({ error: 'Not found' });
    res.json(await chatSerializeChannel(row, req.session.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/chat/channels/:id — rename / change topic / privacy. Only the
// channel creator or a workspace admin can edit.
app.put('/api/chat/channels/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row || row.type !== 'channel') return res.status(404).json({ error: 'Not found' });
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (row.created_by !== req.session.userId && !isAdmin) {
      return res.status(403).json({ error: 'Only the channel creator can edit it' });
    }
    const { name, description, topic, isPrivate } = req.body || {};
    const upd = []; const args = [];
    if (name !== undefined) {
      const cleanName = String(name).trim().replace(/\s+/g, '-').toLowerCase().slice(0, 40);
      if (!cleanName) return res.status(400).json({ error: 'Channel name required' });
      // 'general' is reserved — don't let anyone rename or repoint it.
      if (row.name === 'general' && cleanName !== 'general') {
        return res.status(400).json({ error: 'The #general channel cannot be renamed' });
      }
      upd.push('name=?'); args.push(cleanName);
    }
    if (description !== undefined) { upd.push('description=?'); args.push(String(description).slice(0, 500)); }
    if (topic !== undefined) { upd.push('topic=?'); args.push(String(topic).slice(0, 200)); }
    if (isPrivate !== undefined) { upd.push('is_private=?'); args.push(isPrivate ? 1 : 0); }
    upd.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
    if (upd.length) {
      args.push(id);
      await run(`UPDATE chat_channels SET ${upd.join(',')} WHERE id=?`, ...args);
    }
    const fresh = await get('SELECT * FROM chat_channels WHERE id=?', id);
    const channel = await chatSerializeChannel(fresh, req.session.userId);
    wsBroadcastToChannel(id, { type: 'channel:update', channel });
    res.json(channel);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/chat/channels/:id — creator/admin only. #general is protected.
app.delete('/api/chat/channels/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row) return res.json({ ok: true });
    if (row.type === 'channel' && row.name === 'general') {
      return res.status(400).json({ error: '#general cannot be deleted' });
    }
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (row.created_by !== req.session.userId && !isAdmin) {
      return res.status(403).json({ error: 'Only the channel creator can delete it' });
    }
    const memberRows = await all('SELECT user_id FROM chat_channel_members WHERE channel_id=?', id);
    await run('DELETE FROM chat_channels WHERE id=?', id);
    for (const m of memberRows) wsSendToUser(m.user_id, { type: 'channel:delete', channelId: id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels/:id/join — public-channel self-service join.
app.post('/api/chat/channels/:id/join', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row || row.type !== 'channel') return res.status(404).json({ error: 'Not found' });
    if (row.is_private) {
      // Private channels require explicit invite.
      const existing = await chatGetMembership(req, id);
      if (!existing) return res.status(403).json({ error: 'This channel is private. An admin must add you.' });
    }
    await run(
      'INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT (channel_id, user_id) DO UPDATE SET hidden=0',
      id, req.session.userId
    );
    const channel = await chatSerializeChannel(row, req.session.userId);
    wsBroadcastToChannel(id, { type: 'channel:member-joined', channelId: id, userId: req.session.userId, channel });
    res.json(channel);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels/:id/leave — leave a channel. The #general room and
// DMs can't be left (the latter would orphan history); instead members can
// hide DMs from their sidebar via the same endpoint.
app.post('/api/chat/channels/:id/leave', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.type === 'channel' && row.name === 'general') {
      return res.status(400).json({ error: 'You cannot leave #general' });
    }
    if (row.type === 'dm' || row.type === 'group') {
      // Hide instead of delete — a future message will un-hide it.
      await run('UPDATE chat_channel_members SET hidden=1 WHERE channel_id=? AND user_id=?',
        id, req.session.userId);
    } else {
      await run('DELETE FROM chat_channel_members WHERE channel_id=? AND user_id=?',
        id, req.session.userId);
    }
    wsBroadcastToChannel(id, { type: 'channel:member-left', channelId: id, userId: req.session.userId });
    wsSendToUser(req.session.userId, { type: 'channel:delete', channelId: id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels/:id/members — add one or more users. Caller must
// already be a member; for private channels this is the only way new people
// get in.
app.post('/api/chat/channels/:id/members', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row || row.type !== 'channel') return res.status(404).json({ error: 'Not found' });
    const myMember = await chatGetMembership(req, id);
    if (!myMember) return res.status(404).json({ error: 'Not found' });
    const userIds = Array.isArray(req.body?.userIds)
      ? req.body.userIds.map(Number).filter(n => n)
      : [];
    if (!userIds.length) return res.status(400).json({ error: 'No users specified' });
    for (const uid of userIds) {
      await run(
        'INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT (channel_id, user_id) DO UPDATE SET hidden=0',
        id, uid
      );
    }
    const channel = await chatSerializeChannel(row, req.session.userId);
    for (const uid of userIds) wsSendToUser(uid, { type: 'channel:new', channel });
    wsBroadcastToChannel(id, { type: 'channel:update', channel });
    res.json(channel);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/chat/channels/:id/members/:userId — remove someone. Self-remove
// is equivalent to leaving (use /leave instead). Only the channel creator or
// a workspace admin can remove a different user.
app.delete('/api/chat/channels/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const targetId = Number(req.params.userId);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row || row.type !== 'channel') return res.status(404).json({ error: 'Not found' });
    if (row.name === 'general') return res.status(400).json({ error: 'Cannot remove from #general' });
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (targetId !== req.session.userId && row.created_by !== req.session.userId && !isAdmin) {
      return res.status(403).json({ error: 'Only the channel creator can remove members' });
    }
    await run('DELETE FROM chat_channel_members WHERE channel_id=? AND user_id=?', id, targetId);
    wsSendToUser(targetId, { type: 'channel:delete', channelId: id });
    wsBroadcastToChannel(id, { type: 'channel:member-left', channelId: id, userId: targetId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels/:id/close — soft-close a group chat. Anyone in
// the group can close it for everyone. The channel disappears from the
// main sidebar list and is surfaced under the "Closed" section instead.
// A nightly cron hard-deletes after 30 days. Channels (#general etc.) and
// 1:1 DMs can't be closed via this route — only ad-hoc groups.
app.post('/api/chat/channels/:id/close', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.type !== 'group') {
      return res.status(400).json({ error: 'Only group chats can be closed. Use Leave for DMs and channels.' });
    }
    const member = await chatGetMembership(req, id);
    if (!member) return res.status(404).json({ error: 'Not found' });
    if (row.closed_at) {
      // Idempotent — already closed.
      const existing = await chatSerializeChannel(row, req.session.userId);
      return res.json(existing);
    }
    await run(
      "UPDATE chat_channels SET closed_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), closed_by = ? WHERE id = ?",
      req.session.userId, id
    );
    const fresh = await get('SELECT * FROM chat_channels WHERE id=?', id);
    const memberRows = await all('SELECT user_id FROM chat_channel_members WHERE channel_id=?', id);
    for (const mr of memberRows) {
      wsSendToUser(mr.user_id, { type: 'channel:update', channel: await chatSerializeChannel(fresh, mr.user_id) });
    }
    res.json(await chatSerializeChannel(fresh, req.session.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels/:id/reopen — bring a closed group back. Any
// member can do it; clears closed_at and the group reappears in the
// active list.
app.post('/api/chat/channels/:id/reopen', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM chat_channels WHERE id=?', id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const member = await chatGetMembership(req, id);
    if (!member) return res.status(404).json({ error: 'Not found' });
    if (!row.closed_at) {
      return res.json(await chatSerializeChannel(row, req.session.userId));
    }
    await run('UPDATE chat_channels SET closed_at = NULL, closed_by = NULL WHERE id = ?', id);
    const fresh = await get('SELECT * FROM chat_channels WHERE id=?', id);
    const memberRows = await all('SELECT user_id FROM chat_channel_members WHERE channel_id=?', id);
    for (const mr of memberRows) {
      wsSendToUser(mr.user_id, { type: 'channel:update', channel: await chatSerializeChannel(fresh, mr.user_id) });
    }
    res.json(await chatSerializeChannel(fresh, req.session.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/dm/:userId — get-or-create a 1:1 DM channel with another
// user. Idempotent: the dm_key unique index guarantees one row per pair.
app.post('/api/chat/dm/:userId', requireAuth, async (req, res) => {
  try {
    const otherId = Number(req.params.userId);
    if (!otherId || otherId === req.session.userId) return res.status(400).json({ error: 'Invalid user' });
    const other = await get('SELECT id, name FROM users WHERE id=?', otherId);
    if (!other) return res.status(404).json({ error: 'User not found' });
    const key = chatDmKey(req.session.userId, otherId);
    let row = await get('SELECT * FROM chat_channels WHERE dm_key=?', key);
    if (!row) {
      const ins = await run(
        `INSERT INTO chat_channels (name, type, dm_key, created_by) VALUES (?,?,?,?) RETURNING id`,
        '', 'dm', key, req.session.userId
      );
      const channelId = ins.lastInsertRowid;
      for (const uid of [req.session.userId, otherId]) {
        await run(
          'INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
          channelId, uid
        );
      }
      row = await get('SELECT * FROM chat_channels WHERE id=?', channelId);
    } else {
      // If either side previously hid the DM, un-hide it on re-open.
      await run('UPDATE chat_channel_members SET hidden=0 WHERE channel_id=? AND user_id IN (?,?)',
        row.id, req.session.userId, otherId);
    }
    const channel = await chatSerializeChannel(row, req.session.userId);
    wsSendToUser(otherId, { type: 'channel:new', channel: await chatSerializeChannel(row, otherId) });
    res.json(channel);
  } catch (e) { console.error('[chat:dm]', e); res.status(500).json({ error: e.message }); }
});

// POST /api/chat/group — create a 3+ person group DM. members[] is the list
// of *other* user ids; the creator is implicitly added.
app.post('/api/chat/group', requireAuth, async (req, res) => {
  try {
    const memberIds = Array.isArray(req.body?.members)
      ? [...new Set(req.body.members.map(Number).filter(n => n && n !== req.session.userId))]
      : [];
    if (memberIds.length < 2) return res.status(400).json({ error: 'A group needs at least 3 people' });
    const ins = await run(
      `INSERT INTO chat_channels (name, type, created_by) VALUES (?,?,?) RETURNING id`,
      '', 'group', req.session.userId
    );
    const channelId = ins.lastInsertRowid;
    for (const uid of [req.session.userId, ...memberIds]) {
      await run('INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
        channelId, uid);
    }
    const row = await get('SELECT * FROM chat_channels WHERE id=?', channelId);
    const channel = await chatSerializeChannel(row, req.session.userId);
    for (const uid of memberIds) wsSendToUser(uid, { type: 'channel:new', channel: await chatSerializeChannel(row, uid) });
    res.status(201).json(channel);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/channels/:id/messages — paginated message history. Backwards-
// scrolling pagination via ?before=<msgId>&limit=50. Returns oldest-first
// inside the page (so the client can append-or-prepend either way).
app.get('/api/chat/channels/:id/messages', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const member = await chatGetMembership(req, id);
    if (!member) return res.status(404).json({ error: 'Not found' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = Number(req.query.before) || 0;
    const parent = req.query.parent ? Number(req.query.parent) : null;
    let rows;
    if (parent) {
      // Thread view — messages whose parent_message_id == this id, oldest first.
      rows = await all(
        `SELECT * FROM chat_messages
          WHERE channel_id = ? AND parent_message_id = ?
          ORDER BY id ASC LIMIT ?`,
        id, parent, limit
      );
    } else if (before) {
      // Inline replies render in the main stream now (WhatsApp-style quote
      // card above the body), so don't filter parent_message_id out — the
      // client handles the quote rendering via the replyTo enrichment.
      rows = await all(
        `SELECT * FROM chat_messages
          WHERE channel_id = ? AND id < ?
          ORDER BY id DESC LIMIT ?`,
        id, before, limit
      );
      rows = rows.reverse();
    } else {
      rows = await all(
        `SELECT * FROM chat_messages
          WHERE channel_id = ?
          ORDER BY id DESC LIMIT ?`,
        id, limit
      );
      rows = rows.reverse();
    }
    const messages = await chatHydrateMessages(rows);
    res.json({ messages, hasMore: rows.length === limit });
  } catch (e) { console.error('[chat:list]', e); res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels/:id/messages — send a message (or thread reply).
// body: { body, parentMessageId?, attachmentIds? }
// attachmentIds is the optional list of attachment rows whose chat_message_id
// should be stamped with this new id (the client uploaded them in advance
// with chatMessageId omitted).
app.post('/api/chat/channels/:id/messages', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const member = await chatGetMembership(req, id);
    if (!member) return res.status(404).json({ error: 'Not found' });
    // Block writes to closed groups — they're read-only until reopened.
    const channelRow = await get('SELECT closed_at FROM chat_channels WHERE id=?', id);
    if (channelRow && channelRow.closed_at) {
      return res.status(400).json({ error: 'This group is closed. Reopen it to send messages.' });
    }
    const body = String(req.body?.body || '').trim();
    const parentId = req.body?.parentMessageId ? Number(req.body.parentMessageId) : null;
    const attachmentIds = Array.isArray(req.body?.attachmentIds)
      ? req.body.attachmentIds.map(Number).filter(n => n) : [];
    if (!body && !attachmentIds.length) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }
    if (parentId) {
      const parent = await get('SELECT id, channel_id FROM chat_messages WHERE id=?', parentId);
      if (!parent || parent.channel_id !== id) return res.status(400).json({ error: 'Bad parent' });
    }
    const ins = await run(
      `INSERT INTO chat_messages (channel_id, user_id, parent_message_id, body) VALUES (?,?,?,?) RETURNING id`,
      id, req.session.userId, parentId, body
    );
    const messageId = ins.lastInsertRowid;
    // Stamp the channel's last_message_at so the sidebar list re-orders.
    await run(
      "UPDATE chat_channels SET last_message_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
      id
    );
    // Adopt any pre-uploaded attachments authored by the same user.
    if (attachmentIds.length) {
      for (const aid of attachmentIds) {
        await run(
          `UPDATE attachments SET chat_message_id=? WHERE id=? AND uploader=?`,
          messageId, aid, (await getUser(req.session.userId))?.name || ''
        );
      }
    }
    // Resolve mentions and write rows so unread-mention counters work.
    const mentions = await chatParseMentions(body);
    for (const m of mentions) {
      await run('INSERT INTO chat_mentions (message_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
        messageId, m.id);
    }
    // Mark the sender as having "read up to" their own message — otherwise
    // their own chat appears as unread to themselves.
    await run(
      "UPDATE chat_channel_members SET last_read_message_id=?, last_read_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE channel_id=? AND user_id=?",
      messageId, id, req.session.userId
    );
    // Un-hide the channel for everyone (e.g. someone receiving a DM after
    // having previously hidden it).
    await run('UPDATE chat_channel_members SET hidden=0 WHERE channel_id=?', id);
    const [hydrated] = await chatHydrateMessages([
      await get('SELECT * FROM chat_messages WHERE id=?', messageId),
    ]);
    // Broadcast to every member's socket — the sender's optimistic UI will
    // de-dupe on `id`.
    wsBroadcastToChannel(id, { type: 'message:new', message: hydrated });
    // Push + email fan-out for @mentions and DMs. Fire-and-forget.
    (async () => {
      try {
        const channel = await get('SELECT * FROM chat_channels WHERE id=?', id);
        const sender = await getUser(req.session.userId);
        const senderName = sender?.name || 'Someone';
        const memberRows = await all(
          `SELECT u.id, u.name, u.email, m.notify
             FROM chat_channel_members m JOIN users u ON u.id = m.user_id
            WHERE m.channel_id = ? AND m.user_id <> ?`,
          id, req.session.userId
        );
        const mentionedIds = new Set(mentions.map(m => m.id));
        for (const r of memberRows) {
          const isDm = channel.type === 'dm' || channel.type === 'group';
          const isMention = mentionedIds.has(r.id);
          // Honour notify pref: 'none' = silent, 'mentions' = only on mention,
          // 'all' = anything. DMs are always notification-worthy regardless.
          let notify = false;
          if (r.notify === 'none') notify = false;
          else if (r.notify === 'mentions') notify = isMention || isDm;
          else notify = true;
          if (!notify) continue;
          // In-app notification row drives the bell + the unread badge for
          // users who aren't on the chat page right now.
          const previewBody = body.length > 140 ? body.slice(0, 137) + '…' : body;
          const channelLabel = channel.type === 'dm' ? `from ${senderName}` :
                                channel.type === 'group' ? `in a group chat with ${senderName}` :
                                `in #${channel.name}`;
          const text = (isMention ? `${senderName} mentioned you ${channelLabel}` :
                       isDm        ? `New message from ${senderName}` :
                                      `New message ${channelLabel}`) +
                       (previewBody ? ` — "${previewBody}"` : '');
          await run(
            'INSERT INTO notifications (user_id,type,icon,text,unread) VALUES (?,?,?,?,1)',
            r.id, isMention ? 'chat-mention' : 'chat', isMention ? '@' : '💬', text
          );
          // Push notification on installed PWAs.
          sendPushToUser(r.id, {
            title: isMention ? `${senderName} mentioned you` : senderName,
            body: previewBody || (hydrated.attachments.length ? '📎 sent a file' : ''),
            tag: 'chat-' + id,
            url: '/chat?channel=' + id,
          }).catch(()=>{});
        }
      } catch (e) { console.warn('[chat:notify]', e.message); }
    })();
    // Side-effect: when someone @mentions a third party inside a 1:1 DM,
    // spawn (or re-open) a group chat with all three so the conversation
    // can keep going there. The original DM message stays untouched —
    // this just creates a separate room "to discuss further". The same
    // message body is reposted as the first message in the new group so
    // the newly-added person has context.
    let spawnedGroup = null;
    try {
      const chan = await get('SELECT * FROM chat_channels WHERE id=?', id);
      if (chan && chan.type === 'dm' && mentions.length) {
        const channelMemberRows = await all('SELECT user_id FROM chat_channel_members WHERE channel_id=?', id);
        const channelMemberIds = new Set(channelMemberRows.map(r => r.user_id));
        const newPeople = mentions.filter(m => !channelMemberIds.has(m.id) && m.id !== req.session.userId);
        if (newPeople.length) {
          const allMemberIds = [...new Set([
            req.session.userId,
            ...channelMemberRows.map(r => r.user_id),
            ...newPeople.map(m => m.id),
          ])];
          spawnedGroup = await chatSpawnOrOpenGroup(req.session.userId, allMemberIds, body);
        }
      }
    } catch (e) { console.warn('[chat:spawn-group]', e.message); }
    res.status(201).json(spawnedGroup ? { ...hydrated, spawnedGroup } : hydrated);
  } catch (e) { console.error('[chat:send]', e); res.status(500).json({ error: e.message }); }
});

// Find an existing group chat with EXACTLY the given member set, or create a
// new one and seed it with `initialBody` posted by `creatorId`. Returns the
// fully-serialised channel for the creator. Broadcasts channel:new to every
// other member so it appears in their sidebars without a refresh.
async function chatSpawnOrOpenGroup(creatorId, memberIds, initialBody) {
  const wantedSet = new Set(memberIds);
  // Look for an existing 'group' channel whose member set matches exactly.
  // Cheap: groups are typically few; we only check those the creator is in.
  const candidates = await all(
    `SELECT c.id FROM chat_channels c
       JOIN chat_channel_members m ON m.channel_id = c.id
      WHERE c.type = 'group' AND m.user_id = ?`,
    creatorId
  );
  let existingId = null;
  for (const cand of candidates) {
    const rows = await all('SELECT user_id FROM chat_channel_members WHERE channel_id=?', cand.id);
    const set = new Set(rows.map(r => r.user_id));
    if (set.size === wantedSet.size && [...wantedSet].every(uid => set.has(uid))) {
      existingId = cand.id; break;
    }
  }
  let channelId = existingId;
  if (!channelId) {
    const ins = await run(
      `INSERT INTO chat_channels (name, type, created_by) VALUES (?,?,?) RETURNING id`,
      '', 'group', creatorId
    );
    channelId = ins.lastInsertRowid;
    for (const uid of memberIds) {
      await run('INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
        channelId, uid);
    }
  } else {
    // Re-open for anyone who'd previously hidden it.
    await run('UPDATE chat_channel_members SET hidden=0 WHERE channel_id=?', channelId);
  }
  // Post the seed message — only on creation OR when the body is non-empty.
  if (initialBody) {
    const msgIns = await run(
      `INSERT INTO chat_messages (channel_id, user_id, body) VALUES (?,?,?) RETURNING id`,
      channelId, creatorId, initialBody
    );
    await run("UPDATE chat_channels SET last_message_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?", channelId);
    await run(
      "UPDATE chat_channel_members SET last_read_message_id=?, last_read_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE channel_id=? AND user_id=?",
      msgIns.lastInsertRowid, channelId, creatorId
    );
    // Re-parse mentions inside the seed body so unread-mention counters
    // and notifications fire for everyone in the new group too.
    const seedMentions = await chatParseMentions(initialBody);
    for (const m of seedMentions) {
      await run('INSERT INTO chat_mentions (message_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
        msgIns.lastInsertRowid, m.id);
    }
    const [hydratedSeed] = await chatHydrateMessages([
      await get('SELECT * FROM chat_messages WHERE id=?', msgIns.lastInsertRowid),
    ]);
    wsBroadcastToChannel(channelId, { type: 'message:new', message: hydratedSeed });
  }
  const row = await get('SELECT * FROM chat_channels WHERE id=?', channelId);
  // Push channel:new to every member so the group appears in their sidebar.
  // Each gets a per-user serialisation (their unread count differs).
  const memberRowsForBroadcast = await all('SELECT user_id FROM chat_channel_members WHERE channel_id=?', channelId);
  for (const mr of memberRowsForBroadcast) {
    wsSendToUser(mr.user_id, { type: 'channel:new', channel: await chatSerializeChannel(row, mr.user_id) });
  }
  return chatSerializeChannel(row, creatorId);
}

// PATCH /api/chat/messages/:id — edit your own message body. Re-parses
// mentions and replaces the chat_mentions rows so newly-added @names get
// added; ones you removed simply lose their notification but keep history.
app.patch('/api/chat/messages/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const m = await get('SELECT * FROM chat_messages WHERE id=?', id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    if (m.user_id !== req.session.userId) return res.status(403).json({ error: 'Not your message' });
    if (m.deleted_at) return res.status(400).json({ error: 'Message has been deleted' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Body required' });
    await run(
      "UPDATE chat_messages SET body=?, edited_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
      body, id
    );
    // Re-resolve mentions: insert any new ones, leave existing rows alone.
    const mentions = await chatParseMentions(body);
    for (const mm of mentions) {
      await run('INSERT INTO chat_mentions (message_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
        id, mm.id);
    }
    const [hydrated] = await chatHydrateMessages([await get('SELECT * FROM chat_messages WHERE id=?', id)]);
    wsBroadcastToChannel(m.channel_id, { type: 'message:update', message: hydrated });
    res.json(hydrated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/chat/messages/:id — soft-delete (replace body with placeholder).
// Author or workspace admin only.
app.delete('/api/chat/messages/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const m = await get('SELECT * FROM chat_messages WHERE id=?', id);
    if (!m) return res.json({ ok: true });
    const me = await getUser(req.session.userId);
    const isAdmin = me && ['Admin','Manager'].includes(me.perm_role);
    if (m.user_id !== req.session.userId && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    await run(
      "UPDATE chat_messages SET deleted_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
      id
    );
    wsBroadcastToChannel(m.channel_id, { type: 'message:delete', channelId: m.channel_id, messageId: id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/messages/:id/reactions — add an emoji reaction. Idempotent
// (same user+emoji is a no-op). Returns the updated reaction list.
app.post('/api/chat/messages/:id/reactions', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const emoji = String(req.body?.emoji || '').trim().slice(0, 16);
    if (!emoji) return res.status(400).json({ error: 'Emoji required' });
    const m = await get('SELECT id, channel_id FROM chat_messages WHERE id=?', id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const member = await chatGetMembership(req, m.channel_id);
    if (!member) return res.status(404).json({ error: 'Not found' });
    await run(
      'INSERT INTO chat_message_reactions (message_id, user_id, emoji) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      id, req.session.userId, emoji
    );
    const [hydrated] = await chatHydrateMessages([await get('SELECT * FROM chat_messages WHERE id=?', id)]);
    wsBroadcastToChannel(m.channel_id, { type: 'message:update', message: hydrated });
    res.json(hydrated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/chat/messages/:id/reactions/:emoji — remove your own reaction.
app.delete('/api/chat/messages/:id/reactions/:emoji', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const emoji = decodeURIComponent(req.params.emoji);
    const m = await get('SELECT id, channel_id FROM chat_messages WHERE id=?', id);
    if (!m) return res.json({ ok: true });
    await run(
      'DELETE FROM chat_message_reactions WHERE message_id=? AND user_id=? AND emoji=?',
      id, req.session.userId, emoji
    );
    const [hydrated] = await chatHydrateMessages([await get('SELECT * FROM chat_messages WHERE id=?', id)]);
    wsBroadcastToChannel(m.channel_id, { type: 'message:update', message: hydrated });
    res.json(hydrated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/channels/:id/read — mark the caller's unread cursor up to
// (and including) the given message id. Idempotent; never moves backwards.
app.post('/api/chat/channels/:id/read', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const lastId = Number(req.body?.lastReadMessageId) || 0;
    const member = await chatGetMembership(req, id);
    if (!member) return res.status(404).json({ error: 'Not found' });
    if (lastId > (member.last_read_message_id || 0)) {
      await run(
        "UPDATE chat_channel_members SET last_read_message_id=?, last_read_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE channel_id=? AND user_id=?",
        lastId, id, req.session.userId
      );
      // Mark mentions up to that point as seen so the badge clears.
      await run(
        "UPDATE chat_mentions SET seen_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE user_id=? AND message_id IN (SELECT id FROM chat_messages WHERE channel_id=? AND id<=?) AND seen_at IS NULL",
        req.session.userId, id, lastId
      );
      // Tell *the user's other tabs* that this channel was just read so
      // their unread badge clears too.
      wsSendToUser(req.session.userId, {
        type: 'channel:read', channelId: id, lastReadMessageId: lastId,
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/chat/channels/:id/notify — change notification preference for the
// caller in this channel: 'all' | 'mentions' | 'none'.
app.put('/api/chat/channels/:id/notify', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pref = String(req.body?.notify || 'all');
    if (!['all','mentions','none'].includes(pref)) return res.status(400).json({ error: 'Bad notify value' });
    const member = await chatGetMembership(req, id);
    if (!member) return res.status(404).json({ error: 'Not found' });
    await run('UPDATE chat_channel_members SET notify=? WHERE channel_id=? AND user_id=?',
      pref, id, req.session.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/unread — total unread + per-channel unread for the sidebar
// badge. Cheap aggregate; safe to poll on a 30s timer as a WS-fallback.
app.get('/api/chat/unread', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT m.channel_id,
              (SELECT COUNT(*) FROM chat_messages cm
                WHERE cm.channel_id = m.channel_id
                  AND cm.id > m.last_read_message_id
                  AND cm.user_id <> ?
                  AND cm.deleted_at IS NULL) AS unread,
              (SELECT COUNT(*) FROM chat_mentions x
                JOIN chat_messages mx ON mx.id = x.message_id
                WHERE x.user_id = ?
                  AND mx.channel_id = m.channel_id
                  AND mx.id > m.last_read_message_id
                  AND mx.deleted_at IS NULL) AS mentions
         FROM chat_channel_members m
        WHERE m.user_id = ? AND m.hidden = 0`,
      req.session.userId, req.session.userId, req.session.userId
    );
    let total = 0; let totalMentions = 0;
    const perChannel = {};
    for (const r of rows) {
      const u = Number(r.unread || 0); const mx = Number(r.mentions || 0);
      total += u; totalMentions += mx;
      perChannel[r.channel_id] = { unread: u, mentions: mx };
    }
    res.json({ total, mentions: totalMentions, perChannel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto-add new (just-registered or just-invited) users to #general so they
// have a channel waiting on first chat-page load. Best-effort; never throws.
async function chatAutoJoinGeneral(userId) {
  try {
    const general = await get(
      "SELECT id FROM chat_channels WHERE type='channel' AND lower(name)='general'"
    );
    if (!general) return;
    await run(
      'INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
      general.id, userId
    );
  } catch {}
}
// Expose so the registration / invite-accept routes can call it. Existing
// routes don't call us; we patch them below by wrapping the response.
app.locals.chatAutoJoinGeneral = chatAutoJoinGeneral;

// ── Spaces ────────────────────────────────────────────────────────────────────
// Self-contained feature module (routes/spaces.js). Registers all
// /api/spaces/* routes on the app, including the unauthenticated
// /api/spaces/public/:token endpoint used by the public share viewer.
require('./routes/spaces')(app, { get, all, run, requireAuth });

// ── Apps (design-to-dev handoff for Claude-built apps) ──────────────────────
// Lives in routes/apps.js and is served on /apps.html (standalone page
// outside the SPA shell). Reads ANTHROPIC_API_KEY directly from env for
// the optional blueprint-generation endpoint. UPLOADS_DIR + upload are
// passed so pin annotations can carry pasted images, voice notes, and
// screen recordings via the same /uploads static route everything else
// in the app uses.
require('./routes/apps')(app, { get, all, run, requireAuth, upload, UPLOADS_DIR });

// ── Flavors v2 ────────────────────────────────────────────────────────────────
// Guided flavor-launch wizard + linked-ticket pipeline. Lives in routes/flavors.js
// and is served on /flavors.html (standalone page outside the SPA shell).
require('./routes/flavors')(app, {
  get, all, run, requireAuth, requireAdmin,
  // Needed by the label-review attachment copy (when label_design closes,
  // the spawned review ticket inherits the design's uploaded files).
  UPLOADS_DIR,
});

// ── Flavor Reviews ────────────────────────────────────────────────────────
// In-market flavor catalog + customer-review tracking + scheduled review
// cycles. Lives in routes/flavor-reviews.js and is served on
// /flavor-reviews.html (standalone page outside the SPA shell).
require('./routes/flavor-reviews')(app, { get, all, run, requireAuth, pool, createTicket, ensureReviewTicketsForCycle });

// Unauthenticated standalone HTML for the public share viewer (rendered at
// /p/:token). Lives outside the SPA shell so it works without a session.
const publicSpacePath = path.join(__dirname, 'public', 'public-space.html');
app.get(/^\/p\/[A-Za-z0-9_-]+\/?$/, (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(fs.readFileSync(publicSpacePath, 'utf8'));
  } catch (e) { res.status(404).send('Not found'); }
});

// /apps and /apps/* — serve the Apps SPA shell (public/apps.html) for any
// path under /apps so client-side routing can produce proper URLs like
// /apps/1, /apps/1/p/2, /apps/1/t/3 instead of #-fragments. The static
// middleware handles /apps.html, /apps.css, /apps.js, and /vendor/* on
// its own; this catch-all only fires for path-style routes.
const appsHtmlPath = path.join(__dirname, 'public', 'apps.html');
app.get(/^\/apps(?:\/.*)?$/, (req, res, next) => {
  // Don't intercept static asset requests that happen to start with /apps.
  // The express.static middleware runs before us; anything still here is
  // a "logical" route the client owns.
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(fs.readFileSync(appsHtmlPath, 'utf8'));
  } catch (e) { next(); }
});

// /marketing and /marketing/* — same pattern as /apps. Lets the client-side
// router produce proper URLs like /marketing/templates/12 and /marketing/posts/5
// that survive reloads / right-click "open in new tab". Static assets like
// /marketing.css / /marketing.js are still served by express.static.
const marketingHtmlPath = path.join(__dirname, 'public', 'marketing.html');
app.get(/^\/marketing(?:\/.*)?$/, (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(fs.readFileSync(marketingHtmlPath, 'utf8'));
  } catch (e) { next(); }
});

// ── Recurring Tasks ──────────────────────────────────────────────────────────
// A "recurring task" is a schedule + a list of ticket templates. The hourly
// `runRecurringTasksJob` materializes every template into a fresh ticket
// whenever the schedule's next_run_date is on or before today's UTC date,
// then rolls next_run_date forward by one cycle.

// All recurrence math operates on UTC date strings (YYYY-MM-DD) — the same
// shape stored in the DB. This avoids local-timezone drift moving a schedule
// forward or backward by a day.
function rtTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}
function rtParseUTC(s) {
  // YYYY-MM-DD → Date pinned to UTC midnight. Returning a Date in UTC lets
  // us use the standard get/setUTC* methods for arithmetic without DST drama.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function rtFormatUTC(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function rtDaysInMonth(year, month0) {
  // month0 is 0-based to match Date semantics. Day-0 of next month = last day.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}
// Given a recurring-task row and a "from" date (the date that just fired,
// or the start_date on first calculation), return the next YYYY-MM-DD the
// task should fire on. The result is always strictly after `fromDateStr`
// (we never re-fire on the same date in one cycle).
function rtComputeNextRunDate(rt, fromDateStr) {
  const from = rtParseUTC(fromDateStr) || rtParseUTC(rt.start_date) || rtParseUTC(rtTodayUTC());
  const start = rtParseUTC(rt.start_date) || from;
  if (rt.recur_type === 'monthly_same') {
    const day = start.getUTCDate();
    const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const dim = rtDaysInMonth(next.getUTCFullYear(), next.getUTCMonth());
    next.setUTCDate(Math.min(day, dim));
    return rtFormatUTC(next);
  }
  if (rt.recur_type === 'monthly_day') {
    const day = Math.max(1, Math.min(31, Number(rt.recur_day) || 1));
    // Try this month first (if still in the future), otherwise roll to next.
    let y = from.getUTCFullYear(), m = from.getUTCMonth();
    for (let i = 0; i < 2; i++) {
      const dim = rtDaysInMonth(y, m);
      const cand = new Date(Date.UTC(y, m, Math.min(day, dim)));
      if (cand > from) return rtFormatUTC(cand);
      m++; if (m > 11) { m = 0; y++; }
    }
    return rtFormatUTC(from);
  }
  if (rt.recur_type === 'weekly') {
    const target = ((Number(rt.recur_weekday) || 0) % 7 + 7) % 7;
    const cur = from.getUTCDay();
    let delta = target - cur; if (delta <= 0) delta += 7;
    const next = new Date(from); next.setUTCDate(next.getUTCDate() + delta);
    return rtFormatUTC(next);
  }
  if (rt.recur_type === 'every_n_days') {
    const n = Math.max(1, Number(rt.recur_interval) || 1);
    const next = new Date(from); next.setUTCDate(next.getUTCDate() + n);
    return rtFormatUTC(next);
  }
  // Unknown type — fall back to advancing by one day so we never loop forever.
  const next = new Date(from); next.setUTCDate(next.getUTCDate() + 1);
  return rtFormatUTC(next);
}
// Initial next_run_date when a recurring task is first created. We honour
// the user-supplied start_date directly (it's the first fire date), unless
// the rule requires alignment to a weekday / day-of-month — in which case
// we step forward to the closest matching date on or after start_date.
function rtInitialNextRunDate(rt) {
  const start = rtParseUTC(rt.start_date);
  if (!start) return rtTodayUTC();
  if (rt.recur_type === 'weekly') {
    const target = ((Number(rt.recur_weekday) || 0) % 7 + 7) % 7;
    const cur = start.getUTCDay();
    let delta = target - cur; if (delta < 0) delta += 7;
    const d = new Date(start); d.setUTCDate(d.getUTCDate() + delta);
    return rtFormatUTC(d);
  }
  if (rt.recur_type === 'monthly_day') {
    const day = Math.max(1, Math.min(31, Number(rt.recur_day) || 1));
    let y = start.getUTCFullYear(), m = start.getUTCMonth();
    for (let i = 0; i < 2; i++) {
      const dim = rtDaysInMonth(y, m);
      const cand = new Date(Date.UTC(y, m, Math.min(day, dim)));
      if (cand >= start) return rtFormatUTC(cand);
      m++; if (m > 11) { m = 0; y++; }
    }
  }
  return rt.start_date;
}

// Allocate a unique TKT-#### id and INSERT one regular workspace ticket
// from a recurring-task template. The spawned row goes through the same
// schema as a manually-created ticket: multi-assignee, reporter, tags,
// checklist subtasks, description, and a due date computed as today +
// `due_offset_days`. Each named assignee that isn't the creator also gets
// an in-app `notifications` row. Returns the new TKT-### id.
async function rtSpawnOneTicket(item, ctx) {
  // Allocate id with a tiny retry loop — matches POST /api/tickets so two
  // cron passes never collide.
  let id = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const maxRow = await get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
    let nextNum = 1000;
    if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }
    const candidate = 'TKT-' + (nextNum + 1);
    if (!await get('SELECT id FROM tickets WHERE id=?', candidate)) { id = candidate; break; }
  }
  if (!id) throw new Error('could not allocate ticket id');

  const createdStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  // Due date = today + due_offset_days, formatted to match how POST
  // /api/tickets stores its dates (long human-readable string).
  const offset = Number.isFinite(item.due_offset_days) ? Math.max(0, item.due_offset_days) : 7;
  const dueDate = new Date(Date.now() + offset * 86400000);
  const dueStr = dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const assignees = Array.isArray(item.assignees) ? item.assignees : (item.assignee ? [item.assignee] : []);
  const primaryAssignee = assignees[0] || '';
  const assigneeUid = primaryAssignee ? await resolveUserIdByName(primaryAssignee) : null;
  const reporterName = item.reporter || ctx.creatorName || '';
  const reporterUid = reporterName ? await resolveUserIdByName(reporterName) : null;
  const requesterName = ctx.creatorName || '';
  const requesterUid = ctx.creatorId || null;

  await run(
    `INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
    id, item.title, requesterName, primaryAssignee, reporterName,
    item.priority || 'Medium', 'Open', item.dept || '',
    dueStr, createdStr, 0, JSON.stringify(item.tags || []),
    ctx.creatorId || null, assigneeUid, reporterUid, requesterUid
  );
  await run(
    `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
       ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
    id, item.description || ''
  );
  // Multi-assignee fan-out + per-assignee in-app notification. The cron
  // intentionally skips email/Slack/push for these — they'd flood inboxes
  // every cycle for daily/weekly schedules. The in-app dot is enough.
  for (const name of assignees) {
    if (!name) continue;
    const uid = await resolveUserIdByName(name);
    await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', id, name, uid);
    if (uid && uid !== ctx.creatorId) {
      await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
        uid, 'assigned', '🔁', `Recurring task spawned "${item.title}" and assigned it to you`, id);
    }
  }
  // Checklist → real subtask rows on the spawned ticket. Mirrors what
  // POST /api/tickets does for create-modal checklists.
  const checklist = Array.isArray(item.checklist) ? item.checklist : [];
  let pos = 1;
  for (const c of checklist) {
    const text = (typeof c === 'string' ? c : (c && c.text) || '').trim();
    if (!text) continue;
    await run(
      `INSERT INTO ticket_subtasks (ticket_id, position, text, done, assignee) VALUES (?,?,?,?,?)`,
      id, pos++, text, c && c.done ? 1 : 0, primaryAssignee
    );
  }
  try {
    writeTimeline(id, TL.create,
      `Ticket spawned by recurring task "${ctx.recurringName || ''}"${primaryAssignee ? ` · assigned to ${primaryAssignee}` : ''}`
    );
  } catch {}
  return id;
}

// Process one recurring-task row: spawn one ticket per item, then advance
// the schedule. Wrapped in its own try/catch so a single bad row never
// blocks the rest of the run.
async function rtProcessOne(rt) {
  try {
    const rows = await all('SELECT * FROM recurring_task_items WHERE recurring_task_id=? ORDER BY position ASC, id ASC', rt.id);
    const items = rows.map(rtHydrateItem);
    const creator = rt.created_by ? await getUser(rt.created_by) : null;
    const ctx = {
      creatorId: rt.created_by || null,
      creatorName: creator?.name || '',
      recurringName: rt.name || '',
    };
    for (const it of items) {
      await rtSpawnOneTicket(it, ctx);
    }
    const today = rtTodayUTC();
    const next = rtComputeNextRunDate(rt, today);
    await run('UPDATE recurring_tasks SET last_run_date=?, next_run_date=?, updated_at=TO_CHAR(NOW() AT TIME ZONE \'UTC\', \'YYYY-MM-DD HH24:MI:SS\') WHERE id=?', today, next, rt.id);
    console.log(`[recurring] task #${rt.id} "${rt.name}" fired — ${items.length} ticket(s) created; next=${next}`);
    return items.length;
  } catch (e) {
    console.error(`[recurring] task #${rt.id} failed:`, e.message);
    return 0;
  }
}

// Hourly cron entry-point. A single SELECT pulls every active task whose
// next_run_date is at or before today; we drain the queue in one pass. If
// the same task is overdue by multiple cycles (server was down for a
// week), the cron only fires it once per run — the next pass picks up
// the next missed cycle.
async function runRecurringTasksJob() {
  try {
    const today = rtTodayUTC();
    const due = await all(`SELECT * FROM recurring_tasks WHERE active=1 AND next_run_date <> '' AND next_run_date <= ? ORDER BY next_run_date ASC, id ASC`, today);
    if (!due.length) return;
    console.log(`[recurring] firing ${due.length} task(s) due on/before ${today}`);
    for (const rt of due) await rtProcessOne(rt);
  } catch (e) { console.error('[cron:recurring]', e.message); }
}

// Normalize stored JSON-array columns into arrays before sending to the
// client. Bad/legacy rows just become [] rather than throwing.
function rtParseJsonArray(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// Map a raw DB row from recurring_task_items into the client-shaped object.
// Keeps `assignee` (singular legacy column) as the first assignee when the
// new assignees_json is empty, so legacy rows stay usable.
function rtHydrateItem(r) {
  let assignees = rtParseJsonArray(r.assignees_json);
  if (!assignees.length && r.assignee) assignees = [r.assignee];
  return {
    id: r.id,
    position: r.position,
    title: r.title || '',
    description: r.description || '',
    assignees,
    assignee: assignees[0] || '',
    reporter: r.reporter || '',
    priority: r.priority || 'Medium',
    dept: r.dept || '',
    tags: rtParseJsonArray(r.tags_json),
    checklist: rtParseJsonArray(r.checklist_json),
    due_offset_days: r.due_offset_days == null ? 7 : Number(r.due_offset_days),
  };
}

// Read a recurring task + its items into a single object for the client.
async function rtHydrate(rt) {
  const rows = await all('SELECT * FROM recurring_task_items WHERE recurring_task_id=? ORDER BY position ASC, id ASC', rt.id);
  const items = rows.map(rtHydrateItem);
  return {
    id: rt.id,
    name: rt.name,
    description: rt.description,
    start_date: rt.start_date,
    recur_type: rt.recur_type,
    recur_day: rt.recur_day,
    recur_weekday: rt.recur_weekday,
    recur_interval: rt.recur_interval,
    next_run_date: rt.next_run_date,
    last_run_date: rt.last_run_date,
    active: rt.active ? 1 : 0,
    created_by: rt.created_by,
    items,
  };
}

app.get('/api/recurring-tasks', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM recurring_tasks ORDER BY active DESC, next_run_date ASC, id DESC');
    const out = [];
    for (const r of rows) out.push(await rtHydrate(r));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recurring-tasks/:id', requireAuth, async (req, res) => {
  try {
    const row = await get('SELECT * FROM recurring_tasks WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(await rtHydrate(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sanitize an incoming item payload from the client. Strings get trimmed,
// arrays get clamped to arrays of strings, due_offset_days is bounded.
// Returns null when the item is missing a title (caller filters those out).
function rtCleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const description = String(raw.description || '');
  // Accept either { assignees:[…] } (preferred) or { assignee:"…" } (legacy).
  let assignees = Array.isArray(raw.assignees)
    ? raw.assignees.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  if (!assignees.length && raw.assignee) {
    const a = String(raw.assignee).trim();
    if (a) assignees = [a];
  }
  // Dedupe while preserving order.
  assignees = Array.from(new Set(assignees));
  const reporter = String(raw.reporter || '').trim();
  const dept = String(raw.dept || '').trim();
  const allowedPriority = ['Urgent', 'High', 'Medium', 'Low'];
  const priority = allowedPriority.includes(raw.priority) ? raw.priority : 'Medium';
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  // Checklist items can come as strings or { text, done } objects.
  const checklist = Array.isArray(raw.checklist)
    ? raw.checklist.map(c => {
        if (typeof c === 'string') return { text: c.trim(), done: false };
        return { text: String((c && c.text) || '').trim(), done: !!(c && c.done) };
      }).filter(c => c.text)
    : [];
  const dueOffset = parseInt(raw.due_offset_days, 10);
  const due_offset_days = Number.isFinite(dueOffset) && dueOffset >= 0 && dueOffset <= 3650 ? dueOffset : 7;
  return { title, description, assignees, reporter, priority, dept, tags, checklist, due_offset_days };
}

// Insert one cleaned item under the given recurring task. Returns the new id.
async function rtInsertItem(recurringTaskId, position, c) {
  const ins = await run(
    `INSERT INTO recurring_task_items (recurring_task_id, position, title, description, assignee, assignees_json, reporter, priority, dept, tags_json, checklist_json, due_offset_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    recurringTaskId, position, c.title, c.description,
    c.assignees[0] || '', JSON.stringify(c.assignees),
    c.reporter, c.priority, c.dept,
    JSON.stringify(c.tags), JSON.stringify(c.checklist), c.due_offset_days
  );
  return Number(ins.lastInsertRowid);
}

// Validate + clamp recurrence fields from the request body. Returns the
// sanitized fields (the caller still has to apply them).
function rtCleanRecurFields(body) {
  const recur_type = ['monthly_same','monthly_day','weekly','every_n_days'].includes(body.recur_type) ? body.recur_type : 'monthly_same';
  let recur_day = null, recur_weekday = null, recur_interval = null;
  if (recur_type === 'monthly_day')  recur_day      = Math.max(1, Math.min(31, parseInt(body.recur_day, 10) || 1));
  if (recur_type === 'weekly')       recur_weekday  = Math.max(0, Math.min(6, parseInt(body.recur_weekday, 10) || 0));
  if (recur_type === 'every_n_days') recur_interval = Math.max(1, Math.min(365, parseInt(body.recur_interval, 10) || 1));
  return { recur_type, recur_day, recur_weekday, recur_interval };
}

app.post('/api/recurring-tasks', requireAuth, async (req, res) => {
  try {
    const { name, description, start_date, items } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start_date || ''))) return res.status(400).json({ error: 'start_date required (YYYY-MM-DD)' });
    const r = rtCleanRecurFields(req.body);
    const draft = { start_date, ...r };
    const next_run_date = rtInitialNextRunDate(draft);
    const ins = await run(
      `INSERT INTO recurring_tasks (name, description, start_date, recur_type, recur_day, recur_weekday, recur_interval, next_run_date, last_run_date, active, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?, TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
       RETURNING id`,
      String(name).trim(), String(description || '').trim(), start_date,
      r.recur_type, r.recur_day, r.recur_weekday, r.recur_interval,
      next_run_date, req.session.userId
    );
    const id = Number(ins.lastInsertRowid);
    // Items at creation time are now optional — the UI's preferred flow is
    // "save the schedule, then open it and add tickets like a project".
    if (Array.isArray(items)) {
      let pos = 1;
      for (const raw of items) {
        const c = rtCleanItem(raw);
        if (c) await rtInsertItem(id, pos++, c);
      }
    }
    const row = await get('SELECT * FROM recurring_tasks WHERE id=?', id);
    res.status(201).json(await rtHydrate(row));
  } catch (e) { console.error('[recurring:create]', e); res.status(500).json({ error: e.message }); }
});

// Granular item endpoints — used by the detail view when you add, edit, or
// remove one template at a time (the "like adding sub-tickets to a project"
// flow). The bulk-replace path on PUT /api/recurring-tasks/:id still works
// for clients that want to send the whole list in one shot.

app.get('/api/recurring-tasks/:id/items', requireAuth, async (req, res) => {
  try {
    const rt = await get('SELECT id FROM recurring_tasks WHERE id=?', req.params.id);
    if (!rt) return res.status(404).json({ error: 'Not found' });
    const rows = await all('SELECT * FROM recurring_task_items WHERE recurring_task_id=? ORDER BY position ASC, id ASC', rt.id);
    res.json(rows.map(rtHydrateItem));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recurring-tasks/:id/items', requireAuth, async (req, res) => {
  try {
    const rt = await get('SELECT id FROM recurring_tasks WHERE id=?', req.params.id);
    if (!rt) return res.status(404).json({ error: 'Not found' });
    const c = rtCleanItem(req.body);
    if (!c) return res.status(400).json({ error: 'title required' });
    const maxRow = await get('SELECT COALESCE(MAX(position), 0) AS p FROM recurring_task_items WHERE recurring_task_id=?', rt.id);
    const pos = Number(maxRow?.p || 0) + 1;
    const itemId = await rtInsertItem(rt.id, pos, c);
    const row = await get('SELECT * FROM recurring_task_items WHERE id=?', itemId);
    res.status(201).json(rtHydrateItem(row));
  } catch (e) { console.error('[recurring:item-create]', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/recurring-tasks/:id/items/:itemId', requireAuth, async (req, res) => {
  try {
    const row = await get('SELECT * FROM recurring_task_items WHERE id=? AND recurring_task_id=?', req.params.itemId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(rtHydrateItem(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/recurring-tasks/:id/items/:itemId', requireAuth, async (req, res) => {
  try {
    const existing = await get('SELECT * FROM recurring_task_items WHERE id=? AND recurring_task_id=?', req.params.itemId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const c = rtCleanItem(req.body);
    if (!c) return res.status(400).json({ error: 'title required' });
    await run(
      `UPDATE recurring_task_items SET title=?, description=?, assignee=?, assignees_json=?, reporter=?, priority=?, dept=?, tags_json=?, checklist_json=?, due_offset_days=? WHERE id=?`,
      c.title, c.description, c.assignees[0] || '', JSON.stringify(c.assignees),
      c.reporter, c.priority, c.dept,
      JSON.stringify(c.tags), JSON.stringify(c.checklist), c.due_offset_days,
      existing.id
    );
    const row = await get('SELECT * FROM recurring_task_items WHERE id=?', existing.id);
    res.json(rtHydrateItem(row));
  } catch (e) { console.error('[recurring:item-update]', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/recurring-tasks/:id/items/:itemId', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM recurring_task_items WHERE id=? AND recurring_task_id=?', req.params.itemId, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/recurring-tasks/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await get('SELECT * FROM recurring_tasks WHERE id=?', id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    // Selective updates: any field present in the body replaces the old value.
    // `active` toggles use this path with just { active: 0|1 }.
    const name        = b.name        !== undefined ? String(b.name).trim()         : existing.name;
    const description = b.description !== undefined ? String(b.description).trim()  : existing.description;
    const start_date  = b.start_date  !== undefined ? String(b.start_date)          : existing.start_date;
    const active      = b.active      !== undefined ? (b.active ? 1 : 0)            : (existing.active ? 1 : 0);
    let { recur_type, recur_day, recur_weekday, recur_interval } = existing;
    if (b.recur_type !== undefined) {
      const r = rtCleanRecurFields(b);
      recur_type     = r.recur_type;
      recur_day      = r.recur_day;
      recur_weekday  = r.recur_weekday;
      recur_interval = r.recur_interval;
    }
    // Recompute next_run_date when the schedule shape changes (start date or
    // any recurrence field). Pure active/name/items edits leave it alone so
    // pausing+resuming doesn't accidentally skip a cycle.
    let next_run_date = existing.next_run_date;
    const scheduleChanged = b.start_date !== undefined || b.recur_type !== undefined || b.recur_day !== undefined || b.recur_weekday !== undefined || b.recur_interval !== undefined;
    if (scheduleChanged) {
      next_run_date = rtInitialNextRunDate({ start_date, recur_type, recur_day, recur_weekday, recur_interval });
    }
    await run(
      `UPDATE recurring_tasks SET name=?, description=?, start_date=?, recur_type=?, recur_day=?, recur_weekday=?, recur_interval=?, next_run_date=?, active=?, updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
      name, description, start_date, recur_type, recur_day, recur_weekday, recur_interval, next_run_date, active, id
    );
    // If items array was sent, replace the whole template list. The detail
    // view normally edits items one at a time via the granular endpoints,
    // but this bulk path stays available for callers that want it.
    if (Array.isArray(b.items)) {
      await run('DELETE FROM recurring_task_items WHERE recurring_task_id=?', id);
      let pos = 1;
      for (const raw of b.items) {
        const c = rtCleanItem(raw);
        if (c) await rtInsertItem(id, pos++, c);
      }
    }
    const row = await get('SELECT * FROM recurring_tasks WHERE id=?', id);
    res.json(await rtHydrate(row));
  } catch (e) { console.error('[recurring:update]', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/recurring-tasks/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM recurring_tasks WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual fire. Bypasses the schedule entirely but still rolls next_run_date
// forward — same effect as if the cron had picked it up at the right time.
app.post('/api/recurring-tasks/:id/run-now', requireAuth, async (req, res) => {
  try {
    const rt = await get('SELECT * FROM recurring_tasks WHERE id=?', req.params.id);
    if (!rt) return res.status(404).json({ error: 'Not found' });
    const created = await rtProcessOne(rt);
    res.json({ ok: true, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Marketing post templates ────────────────────────────────────────────────
// Recurrence math is identical to recurring tasks (reuse rtComputeNextRunDate
// / rtInitialNextRunDate / rtParseUTC / rtFormatUTC), anchored on a "post
// date" instead of a "run date". An hourly cron looks ahead at every active
// template, materialises any upcoming post_date that doesn't yet have a
// marketing_posts row, and spawns one prep ticket per template task with
// due_date = post_date - days_before_post (clamped to today). When a task
// has a reminder_offset_hours > 0, a ticket_reminders row is also inserted
// for the primary assignee at due_date - offset.

const MKT_PLATFORMS = ['instagram','facebook','tiktok','x','linkedin','youtube','email','ad-facebook','ad-instagram','other'];
const MKT_POST_KINDS = ['post','story','reel','ad','video','carousel'];
const MKT_STATUSES = ['planned','in_progress','ready','posted','skipped'];

function mktParseJsonArray(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// Same shape as rtCleanItem but with days_before_post + reminder_offset_hours
// instead of due_offset_days. Returns null if the row has no title.
function mktCleanTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const description = String(raw.description || '');
  let assignees = Array.isArray(raw.assignees)
    ? raw.assignees.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  if (!assignees.length && raw.assignee) {
    const a = String(raw.assignee).trim();
    if (a) assignees = [a];
  }
  assignees = Array.from(new Set(assignees));
  const reporter = String(raw.reporter || '').trim();
  const dept = String(raw.dept || '').trim();
  const allowedPriority = ['Urgent','High','Medium','Low'];
  const priority = allowedPriority.includes(raw.priority) ? raw.priority : 'Medium';
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  const checklist = Array.isArray(raw.checklist)
    ? raw.checklist.map(c => {
        if (typeof c === 'string') return { text: c.trim(), done: false };
        return { text: String((c && c.text) || '').trim(), done: !!(c && c.done) };
      }).filter(c => c.text)
    : [];
  const dbpRaw = parseInt(raw.days_before_post, 10);
  const days_before_post = Number.isFinite(dbpRaw) && dbpRaw >= 0 && dbpRaw <= 365 ? dbpRaw : 1;
  const remRaw = parseInt(raw.reminder_offset_hours, 10);
  const reminder_offset_hours = Number.isFinite(remRaw) && remRaw >= 0 && remRaw <= 24 * 30 ? remRaw : 0;
  return { title, description, assignees, reporter, priority, dept, tags, checklist, days_before_post, reminder_offset_hours };
}

function mktHydrateTask(r) {
  let assignees = mktParseJsonArray(r.assignees_json);
  if (!assignees.length && r.assignee) assignees = [r.assignee];
  return {
    id: r.id,
    position: r.position,
    title: r.title || '',
    description: r.description || '',
    assignees,
    assignee: assignees[0] || '',
    reporter: r.reporter || '',
    priority: r.priority || 'Medium',
    dept: r.dept || '',
    tags: mktParseJsonArray(r.tags_json),
    checklist: mktParseJsonArray(r.checklist_json),
    days_before_post: r.days_before_post == null ? 1 : Number(r.days_before_post),
    reminder_offset_hours: r.reminder_offset_hours == null ? 0 : Number(r.reminder_offset_hours),
  };
}

async function mktInsertTask(templateId, position, c) {
  const ins = await run(
    `INSERT INTO marketing_post_template_tasks (template_id, position, title, description, assignee, assignees_json, reporter, priority, dept, tags_json, checklist_json, days_before_post, reminder_offset_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    templateId, position, c.title, c.description,
    c.assignees[0] || '', JSON.stringify(c.assignees),
    c.reporter, c.priority, c.dept,
    JSON.stringify(c.tags), JSON.stringify(c.checklist),
    c.days_before_post, c.reminder_offset_hours
  );
  return Number(ins.lastInsertRowid);
}

// Marketing templates additionally support a non-recurring 'one_time' type
// (a single post on the start date). Recurring tickets don't, so this wraps
// the shared rtCleanRecurFields rather than widening it.
function mktCleanRecurFields(body) {
  if (body.recur_type === 'one_time') {
    return { recur_type: 'one_time', recur_day: null, recur_weekday: null, recur_interval: null };
  }
  return rtCleanRecurFields(body);
}

function mktCleanTemplateFields(body) {
  const platform = MKT_PLATFORMS.includes(body.platform) ? body.platform : 'instagram';
  const post_kind = MKT_POST_KINDS.includes(body.post_kind) ? body.post_kind : 'post';
  const post_time = /^\d{2}:\d{2}$/.test(String(body.post_time || '')) ? String(body.post_time) : '';
  const end_type = ['never','count','date'].includes(body.end_type) ? body.end_type : 'never';
  let end_count = null;
  if (end_type === 'count') {
    const n = parseInt(body.end_count, 10);
    end_count = Number.isFinite(n) && n >= 1 && n <= 500 ? n : 10;
  }
  let end_date = '';
  if (end_type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date || ''))) {
    end_date = String(body.end_date);
  }
  return { platform, post_kind, post_time, end_type, end_count, end_date };
}

async function mktHydrateTemplate(t) {
  const rows = await all('SELECT * FROM marketing_post_template_tasks WHERE template_id=? ORDER BY position ASC, id ASC', t.id);
  const tasks = rows.map(mktHydrateTask);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    platform: t.platform,
    post_kind: t.post_kind,
    start_date: t.start_date,
    post_time: t.post_time,
    recur_type: t.recur_type,
    recur_day: t.recur_day,
    recur_weekday: t.recur_weekday,
    recur_interval: t.recur_interval,
    end_type: t.end_type || 'never',
    end_count: t.end_count,
    end_date: t.end_date || '',
    next_post_date: t.next_post_date,
    last_materialized_date: t.last_materialized_date,
    active: t.active ? 1 : 0,
    created_by: t.created_by,
    tasks,
    // Convenience: longest lead time across tasks, so the client can
    // surface "needs X days prep" in the list.
    lead_time_days: tasks.reduce((m, t) => Math.max(m, t.days_before_post || 0), 0),
  };
}

// Spawn one prep ticket for a materialised post. Schema mirrors
// rtSpawnOneTicket but the due date is anchored to the post date (already
// pre-computed by the caller as `dueStr` in the "MMM D, YYYY" shape that
// other ticket dates use). When `reminderAtUtc` is set, also insert a
// ticket_reminders row for each named assignee so the existing
// runTicketReminderJob can fire it.
async function mktSpawnOneTicket(item, ctx, dueStr, reminderAtUtc) {
  let id = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const maxRow = await get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
    let nextNum = 1000;
    if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }
    const candidate = 'TKT-' + (nextNum + 1);
    if (!await get('SELECT id FROM tickets WHERE id=?', candidate)) { id = candidate; break; }
  }
  if (!id) throw new Error('could not allocate ticket id');

  const createdStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const assignees = Array.isArray(item.assignees) ? item.assignees : (item.assignee ? [item.assignee] : []);
  const primaryAssignee = assignees[0] || '';
  const assigneeUid = primaryAssignee ? await resolveUserIdByName(primaryAssignee) : null;
  const reporterName = item.reporter || ctx.creatorName || '';
  const reporterUid = reporterName ? await resolveUserIdByName(reporterName) : null;
  const requesterName = ctx.creatorName || '';
  const requesterUid = ctx.creatorId || null;

  // Tag every prep ticket with "Marketing" + the platform so they're easy
  // to filter on the tickets page. User-provided tags are kept too.
  const tags = Array.isArray(item.tags) ? item.tags.slice() : [];
  if (!tags.includes('Marketing')) tags.unshift('Marketing');
  if (ctx.platform && !tags.includes(ctx.platform)) tags.push(ctx.platform);

  await run(
    `INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,created_by,assignee_user_id,reporter_user_id,req_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
    id, item.title, requesterName, primaryAssignee, reporterName,
    item.priority || 'Medium', 'Open', item.dept || '',
    dueStr, createdStr, 0, JSON.stringify(tags),
    ctx.creatorId || null, assigneeUid, reporterUid, requesterUid
  );
  const fullDescription = (item.description || '') +
    (ctx.postLabel ? `\n\n— prep task for ${ctx.postLabel}` : '');
  await run(
    `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
       ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
    id, fullDescription
  );

  for (const name of assignees) {
    if (!name) continue;
    const uid = await resolveUserIdByName(name);
    await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', id, name, uid);
    if (uid && uid !== ctx.creatorId) {
      await run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
        uid, 'assigned', '📣', `Marketing post "${ctx.templateName || ''}" assigned "${item.title}" to you`, id);
    }
    // One reminder row per assignee — runTicketReminderJob will send each.
    if (reminderAtUtc && uid) {
      await run(
        `INSERT INTO ticket_reminders (ticket_id, user_id, remind_at, note) VALUES (?,?,?,?)`,
        id, uid, reminderAtUtc, `Prep for ${ctx.postLabel || ctx.templateName || 'marketing post'}`
      );
    }
  }

  const checklist = Array.isArray(item.checklist) ? item.checklist : [];
  let pos = 1;
  for (const c of checklist) {
    const text = (typeof c === 'string' ? c : (c && c.text) || '').trim();
    if (!text) continue;
    await run(
      `INSERT INTO ticket_subtasks (ticket_id, position, text, done, assignee) VALUES (?,?,?,?,?)`,
      id, pos++, text, c && c.done ? 1 : 0, primaryAssignee
    );
  }
  try {
    writeTimeline(id, TL.create,
      `Ticket spawned by marketing template "${ctx.templateName || ''}" for ${ctx.postLabel || 'upcoming post'}${primaryAssignee ? ` · assigned to ${primaryAssignee}` : ''}`
    );
  } catch {}
  return id;
}

// Convert a YYYY-MM-DD date to the "Mon D, YYYY" string that ticket dates
// use elsewhere. Falls back to today on bad input.
function mktDateToTicketStr(yyyymmdd) {
  const d = rtParseUTC(yyyymmdd);
  if (!d) return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Build the "YYYY-MM-DD HH:MM:SS" UTC string that ticket_reminders.remind_at
// expects, given a YYYY-MM-DD due date and a "hours before due" offset.
// We anchor the due time at 09:00 UTC (matches the date-only path in
// /api/tickets/:id/reminders).
function mktReminderAtUtc(dueYmd, offsetHours) {
  const d = rtParseUTC(dueYmd);
  if (!d) return null;
  d.setUTCHours(9, 0, 0, 0);
  d.setUTCHours(d.getUTCHours() - Math.max(0, Number(offsetHours) || 0));
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

// Expand a template into the full ordered list of YYYY-MM-DD post dates,
// starting from start_date and walking the recurrence forward. End condition:
//   end_type='never' → today + 13 months horizon (auto-extends in cron)
//   end_type='count' → end_count occurrences
//   end_type='date'  → up to and including end_date
// A hard SAFETY_CAP of 1000 guards against pathological inputs.
function mktExpandOccurrences(template) {
  const dates = [];
  // One-time templates produce a single post on the start date — no recurrence
  // walk and no end condition. Handled here so we never fall into the
  // advance-by-one-day fallback in rtComputeNextRunDate for an unknown type.
  if (template.recur_type === 'one_time') {
    const only = String(template.start_date || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(only) ? [only] : [];
  }
  let current = rtInitialNextRunDate(template);
  if (!current) return dates;
  const endDateLimit = template.end_type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(template.end_date || '') ? template.end_date : null;
  const countLimit = template.end_type === 'count' ? Math.max(1, Math.min(500, Number(template.end_count) || 1)) : null;
  // Rolling 13-month horizon for 'never' templates. Each cron tick recomputes
  // this so the calendar always shows ~1 year of future dates.
  let horizonYmd = null;
  if (template.end_type === 'never' || !template.end_type) {
    const now = new Date();
    const h = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 13, now.getUTCDate()));
    horizonYmd = rtFormatUTC(h);
  }
  const SAFETY_CAP = 1000;
  for (let i = 0; i < SAFETY_CAP; i++) {
    if (countLimit !== null && i >= countLimit) break;
    if (endDateLimit && current > endDateLimit) break;
    if (horizonYmd && current > horizonYmd) break;
    dates.push(current);
    const next = rtComputeNextRunDate(template, current);
    if (!next || next === current) break;
    current = next;
  }
  return dates;
}

// Diff the freshly expanded date list against the marketing_posts rows that
// belong to this template, then INSERT any new dates and DELETE any future
// rows that no longer match (only when they haven't spawned tickets yet —
// already-materialised history stays put even if the schedule shrinks).
async function mktRegenerateOccurrences(template) {
  const dates = mktExpandOccurrences(template);
  if (!dates.length) return { added: 0, removed: 0 };
  const dateSet = new Set(dates);
  // Insert any missing dates as planned posts (no tickets yet).
  let added = 0;
  for (const ymd of dates) {
    const existing = await get('SELECT id FROM marketing_posts WHERE template_id=? AND post_date=?', template.id, ymd);
    if (!existing) {
      await run(
        `INSERT INTO marketing_posts (template_id, name, platform, post_kind, post_date, post_time, status, notes, is_one_off, tickets_spawned)
         VALUES (?, ?, ?, ?, ?, ?, 'planned', '', 0, 0)`,
        template.id, template.name || '', template.platform || '', template.post_kind || '',
        ymd, template.post_time || ''
      );
      added++;
    }
  }
  // Drop future planned posts whose date dropped out of the new schedule.
  // Conservative: only future-dated rows with no tickets spawned.
  const today = rtTodayUTC();
  const futureRows = await all(
    `SELECT id, post_date FROM marketing_posts WHERE template_id=? AND tickets_spawned=0 AND post_date >= ? AND status IN ('planned','in_progress')`,
    template.id, today
  );
  let removed = 0;
  for (const r of futureRows) {
    if (!dateSet.has(r.post_date)) {
      await run('DELETE FROM marketing_posts WHERE id=?', r.id);
      removed++;
    }
  }
  // Keep next_post_date pointing at the first un-spawned upcoming date — purely
  // for display ("next post: …" in the template card).
  const upcoming = dates.find(d => d >= today) || dates[0] || '';
  await run(
    `UPDATE marketing_post_templates SET next_post_date=?, updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
    upcoming, template.id
  );
  return { added, removed };
}

// Spawn the prep tickets for a single marketing_posts row. Looks up the
// template's task list, computes per-task due dates (post_date -
// days_before_post, clamped to today), creates one ticket per task, and
// links them via marketing_post_tickets. Flips tickets_spawned=1 so the
// cron stops re-checking this row.
async function mktSpawnTicketsForPost(post) {
  if (!post.template_id) {
    // One-off posts spawn their tickets inline at create time — defensive.
    await run('UPDATE marketing_posts SET tickets_spawned=1 WHERE id=?', post.id);
    return { ticketIds: [] };
  }
  const template = await get('SELECT * FROM marketing_post_templates WHERE id=?', post.template_id);
  const taskRows = await all(
    'SELECT * FROM marketing_post_template_tasks WHERE template_id=? ORDER BY position ASC, id ASC',
    post.template_id
  );
  const tasks = taskRows.map(mktHydrateTask);
  if (!tasks.length) {
    await run('UPDATE marketing_posts SET tickets_spawned=1 WHERE id=?', post.id);
    return { ticketIds: [] };
  }
  const creator = template?.created_by ? await getUser(template.created_by) : null;
  const ctx = {
    creatorId: template?.created_by || null,
    creatorName: creator?.name || '',
    templateName: template?.name || post.name || '',
    platform: post.platform || '',
    postLabel: `${post.name || 'post'} · ${post.post_date}`,
  };
  const todayD = rtParseUTC(rtTodayUTC());
  const postD = rtParseUTC(post.post_date);
  const ticketIds = [];
  if (!postD) return { ticketIds };
  for (const task of tasks) {
    const dueD = new Date(postD);
    dueD.setUTCDate(dueD.getUTCDate() - Math.max(0, task.days_before_post || 0));
    if (dueD < todayD) dueD.setTime(todayD.getTime());
    const dueYmd = rtFormatUTC(dueD);
    const dueStr = mktDateToTicketStr(dueYmd);
    const reminderAt = task.reminder_offset_hours > 0 ? mktReminderAtUtc(dueYmd, task.reminder_offset_hours) : null;
    const ticketId = await mktSpawnOneTicket(task, ctx, dueStr, reminderAt);
    await run(
      `INSERT INTO marketing_post_tickets (post_id, ticket_id, template_task_id, task_title, due_date) VALUES (?,?,?,?,?)`,
      post.id, ticketId, task.id, task.title, dueYmd
    );
    ticketIds.push(ticketId);
  }
  await run(
    `UPDATE marketing_posts SET tickets_spawned=1, updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
    post.id
  );
  await run(
    `UPDATE marketing_post_templates SET last_materialized_date=? WHERE id=?`,
    post.post_date, post.template_id
  );
  return { ticketIds };
}

// Hourly cron entry point.
// Phase 1: walk every active template, refresh its occurrence list. This
//   extends the rolling 13-month horizon for 'never' templates and absorbs
//   any schedule edits made via the UI.
// Phase 2: for every planned post within its template's lead-time window
//   (max days_before_post across tasks, +1 day buffer) that hasn't had
//   tickets spawned yet, spawn them.
async function runMarketingPostsJob() {
  try {
    const templates = await all(`SELECT * FROM marketing_post_templates WHERE active=1`);
    for (const t of templates) {
      try { await mktRegenerateOccurrences(t); }
      catch (e) { console.error(`[marketing:regen #${t.id}]`, e.message); }
    }
    const today = rtTodayUTC();
    const todayD = rtParseUTC(today);
    // Pull all un-spawned planned posts; filter by lead-time per-template in JS
    // (cheaper than a correlated subquery, and the row count is small).
    const planned = await all(
      `SELECT * FROM marketing_posts WHERE tickets_spawned=0 AND status='planned' AND template_id IS NOT NULL ORDER BY post_date ASC`
    );
    if (!planned.length) return;
    // Cache max-lead per template so we don't re-query in the loop.
    const leadByTemplate = new Map();
    for (const p of planned) {
      let leadDays = leadByTemplate.get(p.template_id);
      if (leadDays === undefined) {
        const rows = await all(
          'SELECT COALESCE(MAX(days_before_post),0) AS lead FROM marketing_post_template_tasks WHERE template_id=?',
          p.template_id
        );
        leadDays = Number(rows?.[0]?.lead || 0);
        leadByTemplate.set(p.template_id, leadDays);
      }
      const postD = rtParseUTC(p.post_date);
      if (!postD) continue;
      const daysAway = Math.round((postD - todayD) / 86400000);
      if (daysAway > leadDays + 1) continue;
      try { await mktSpawnTicketsForPost(p); }
      catch (e) { console.error(`[marketing:spawn post #${p.id}]`, e.message); }
    }
  } catch (e) { console.error('[cron:marketing]', e.message); }
}

// ── Marketing routes ────────────────────────────────────────────────────────
// Calendar GETs are open to any authed user. Template / post mutations are
// admin/manager only (the "team's marketing plan", not individual to-dos).

app.get('/api/marketing/templates', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM marketing_post_templates ORDER BY active DESC, next_post_date ASC, id DESC');
    const out = [];
    for (const r of rows) out.push(await mktHydrateTemplate(r));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketing/templates/:id', requireAuth, async (req, res) => {
  try {
    const row = await get('SELECT * FROM marketing_post_templates WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(await mktHydrateTemplate(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketing/templates', requireAdmin, async (req, res) => {
  try {
    const { name, description, start_date, tasks } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start_date || ''))) return res.status(400).json({ error: 'start_date required (YYYY-MM-DD)' });
    const r = mktCleanRecurFields(req.body);
    const m = mktCleanTemplateFields(req.body);
    const next_post_date = rtInitialNextRunDate({ start_date, ...r });
    const ins = await run(
      `INSERT INTO marketing_post_templates (name, description, platform, post_kind, start_date, post_time, recur_type, recur_day, recur_weekday, recur_interval, end_type, end_count, end_date, next_post_date, active, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
       RETURNING id`,
      String(name).trim(), String(description || '').trim(),
      m.platform, m.post_kind, start_date, m.post_time,
      r.recur_type, r.recur_day, r.recur_weekday, r.recur_interval,
      m.end_type, m.end_count, m.end_date,
      next_post_date, req.session.userId
    );
    const id = Number(ins.lastInsertRowid);
    if (Array.isArray(tasks)) {
      let pos = 1;
      for (const raw of tasks) {
        const c = mktCleanTask(raw);
        if (c) await mktInsertTask(id, pos++, c);
      }
    }
    const row = await get('SELECT * FROM marketing_post_templates WHERE id=?', id);
    // Pre-populate the calendar with the full schedule (up to horizon /
    // count / end date) so all upcoming Fridays show immediately.
    try { await mktRegenerateOccurrences(row); }
    catch (e) { console.error('[marketing:create regen]', e.message); }
    const fresh = await get('SELECT * FROM marketing_post_templates WHERE id=?', id);
    res.status(201).json(await mktHydrateTemplate(fresh));
  } catch (e) { console.error('[marketing:create]', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/marketing/templates/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await get('SELECT * FROM marketing_post_templates WHERE id=?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const name        = b.name        !== undefined ? String(b.name).trim()         : existing.name;
    const description = b.description !== undefined ? String(b.description).trim()  : existing.description;
    const start_date  = b.start_date  !== undefined ? String(b.start_date)          : existing.start_date;
    const active      = b.active      !== undefined ? (b.active ? 1 : 0)            : (existing.active ? 1 : 0);
    let { platform, post_kind, post_time, end_type, end_count, end_date } = existing;
    const needsTemplateFieldsCleanup =
      b.platform  !== undefined || b.post_kind !== undefined || b.post_time !== undefined ||
      b.end_type  !== undefined || b.end_count !== undefined || b.end_date  !== undefined;
    if (needsTemplateFieldsCleanup) {
      const m = mktCleanTemplateFields({
        platform:  b.platform  !== undefined ? b.platform  : existing.platform,
        post_kind: b.post_kind !== undefined ? b.post_kind : existing.post_kind,
        post_time: b.post_time !== undefined ? b.post_time : existing.post_time,
        end_type:  b.end_type  !== undefined ? b.end_type  : existing.end_type,
        end_count: b.end_count !== undefined ? b.end_count : existing.end_count,
        end_date:  b.end_date  !== undefined ? b.end_date  : existing.end_date,
      });
      platform = m.platform; post_kind = m.post_kind; post_time = m.post_time;
      end_type = m.end_type; end_count = m.end_count; end_date = m.end_date;
    }
    let { recur_type, recur_day, recur_weekday, recur_interval } = existing;
    if (b.recur_type !== undefined) {
      const r = mktCleanRecurFields(b);
      recur_type = r.recur_type; recur_day = r.recur_day;
      recur_weekday = r.recur_weekday; recur_interval = r.recur_interval;
    }
    let next_post_date = existing.next_post_date;
    const scheduleChanged =
      b.start_date !== undefined || b.recur_type !== undefined ||
      b.recur_day !== undefined || b.recur_weekday !== undefined || b.recur_interval !== undefined ||
      b.end_type !== undefined || b.end_count !== undefined || b.end_date !== undefined;
    if (scheduleChanged) {
      next_post_date = rtInitialNextRunDate({ start_date, recur_type, recur_day, recur_weekday, recur_interval });
    }
    await run(
      `UPDATE marketing_post_templates SET name=?, description=?, platform=?, post_kind=?, start_date=?, post_time=?, recur_type=?, recur_day=?, recur_weekday=?, recur_interval=?, end_type=?, end_count=?, end_date=?, next_post_date=?, active=?, updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
      name, description, platform, post_kind, start_date, post_time,
      recur_type, recur_day, recur_weekday, recur_interval,
      end_type, end_count, end_date,
      next_post_date, active, existing.id
    );
    if (Array.isArray(b.tasks)) {
      await run('DELETE FROM marketing_post_template_tasks WHERE template_id=?', existing.id);
      let pos = 1;
      for (const raw of b.tasks) {
        const c = mktCleanTask(raw);
        if (c) await mktInsertTask(existing.id, pos++, c);
      }
    }
    // Refresh the materialised occurrences so calendar + cron pick up the new
    // schedule / end condition. Future un-spawned posts get pruned, missing
    // ones get inserted.
    const updated = await get('SELECT * FROM marketing_post_templates WHERE id=?', existing.id);
    try {
      if (active) await mktRegenerateOccurrences(updated);
      else {
        // Paused: drop future un-spawned planned posts so they vanish from the
        // calendar until the template is resumed.
        const today = rtTodayUTC();
        await run(
          `DELETE FROM marketing_posts WHERE template_id=? AND tickets_spawned=0 AND post_date >= ? AND status='planned'`,
          existing.id, today
        );
      }
    } catch (e) { console.error('[marketing:update regen]', e.message); }
    const row = await get('SELECT * FROM marketing_post_templates WHERE id=?', existing.id);
    res.json(await mktHydrateTemplate(row));
  } catch (e) { console.error('[marketing:update]', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketing/templates/:id', requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM marketing_post_templates WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Granular task endpoints — same shape as the recurring-task item endpoints.
app.post('/api/marketing/templates/:id/tasks', requireAdmin, async (req, res) => {
  try {
    const t = await get('SELECT id FROM marketing_post_templates WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const c = mktCleanTask(req.body);
    if (!c) return res.status(400).json({ error: 'title required' });
    const maxRow = await get('SELECT COALESCE(MAX(position),0) AS p FROM marketing_post_template_tasks WHERE template_id=?', t.id);
    const pos = Number(maxRow?.p || 0) + 1;
    const taskId = await mktInsertTask(t.id, pos, c);
    const row = await get('SELECT * FROM marketing_post_template_tasks WHERE id=?', taskId);
    res.status(201).json(mktHydrateTask(row));
  } catch (e) { console.error('[marketing:task-create]', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/marketing/templates/:id/tasks/:taskId', requireAdmin, async (req, res) => {
  try {
    const existing = await get('SELECT * FROM marketing_post_template_tasks WHERE id=? AND template_id=?', req.params.taskId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const c = mktCleanTask(req.body);
    if (!c) return res.status(400).json({ error: 'title required' });
    await run(
      `UPDATE marketing_post_template_tasks SET title=?, description=?, assignee=?, assignees_json=?, reporter=?, priority=?, dept=?, tags_json=?, checklist_json=?, days_before_post=?, reminder_offset_hours=? WHERE id=?`,
      c.title, c.description, c.assignees[0] || '', JSON.stringify(c.assignees),
      c.reporter, c.priority, c.dept,
      JSON.stringify(c.tags), JSON.stringify(c.checklist),
      c.days_before_post, c.reminder_offset_hours, existing.id
    );
    const row = await get('SELECT * FROM marketing_post_template_tasks WHERE id=?', existing.id);
    res.json(mktHydrateTask(row));
  } catch (e) { console.error('[marketing:task-update]', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketing/templates/:id/tasks/:taskId', requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM marketing_post_template_tasks WHERE id=? AND template_id=?', req.params.taskId, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual fire — spawn prep tickets immediately for the next un-spawned post,
// regardless of the lead-time window. Useful when the user just finished
// authoring a template and wants to see tickets show up right now.
app.post('/api/marketing/templates/:id/materialize-now', requireAdmin, async (req, res) => {
  try {
    const t = await get('SELECT * FROM marketing_post_templates WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    // Regenerate occurrences first so the row exists even on a brand-new template.
    try { await mktRegenerateOccurrences(t); } catch {}
    const next = await get(
      `SELECT * FROM marketing_posts WHERE template_id=? AND tickets_spawned=0 AND status='planned' ORDER BY post_date ASC LIMIT 1`,
      t.id
    );
    if (!next) return res.status(400).json({ error: 'no upcoming planned post to materialise' });
    const r = await mktSpawnTicketsForPost(next);
    res.json({ ok: true, postId: next.id, ticketIds: r.ticketIds, alreadyExisted: false });
  } catch (e) { console.error('[marketing:materialize]', e); res.status(500).json({ error: e.message }); }
});

// One-off post — created from the "+ on a calendar day" flow. Inline tasks
// or `copy_from_template_id` pulls the prep tasks from an existing template
// (calendar shortcut for "do an Instagram post on this day with the same
// prep checklist as my regular Instagram template"). Spawns prep tickets
// immediately so the user sees them in their queue right away.
app.post('/api/marketing/posts', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.post_date || ''))) return res.status(400).json({ error: 'post_date required (YYYY-MM-DD)' });
    const fields = mktCleanTemplateFields(b);
    const name = String(b.name || '').trim() || `${fields.platform} ${fields.post_kind}`;
    let tasks = [];
    if (b.copy_from_template_id) {
      const rows = await all(
        'SELECT * FROM marketing_post_template_tasks WHERE template_id=? ORDER BY position ASC, id ASC',
        b.copy_from_template_id
      );
      tasks = rows.map(mktHydrateTask);
    } else if (Array.isArray(b.tasks)) {
      tasks = b.tasks.map(mktCleanTask).filter(Boolean);
    }
    const insPost = await run(
      `INSERT INTO marketing_posts (template_id, name, platform, post_kind, post_date, post_time, status, notes, is_one_off, tickets_spawned)
       VALUES (NULL, ?, ?, ?, ?, ?, 'planned', ?, 1, 0) RETURNING id`,
      name, fields.platform, fields.post_kind, b.post_date, fields.post_time,
      String(b.notes || '').slice(0, 4000)
    );
    const postId = Number(insPost.lastInsertRowid);
    const ticketIds = [];
    if (tasks.length) {
      const creator = await getUser(req.session.userId);
      const ctx = {
        creatorId: req.session.userId,
        creatorName: creator?.name || '',
        templateName: name,
        platform: fields.platform,
        postLabel: `${name} · ${b.post_date}`,
      };
      const todayD = rtParseUTC(rtTodayUTC());
      const postD = rtParseUTC(b.post_date);
      for (const t of tasks) {
        const dueD = new Date(postD);
        dueD.setUTCDate(dueD.getUTCDate() - Math.max(0, t.days_before_post || 0));
        if (dueD < todayD) dueD.setTime(todayD.getTime());
        const dueYmd = rtFormatUTC(dueD);
        const dueStr = mktDateToTicketStr(dueYmd);
        const reminderAt = t.reminder_offset_hours > 0 ? mktReminderAtUtc(dueYmd, t.reminder_offset_hours) : null;
        const ticketId = await mktSpawnOneTicket(t, ctx, dueStr, reminderAt);
        await run(
          `INSERT INTO marketing_post_tickets (post_id, ticket_id, template_task_id, task_title, due_date) VALUES (?,?,?,?,?)`,
          postId, ticketId, t.id || null, t.title, dueYmd
        );
        ticketIds.push(ticketId);
      }
      await run('UPDATE marketing_posts SET tickets_spawned=1 WHERE id=?', postId);
    }
    const row = await get('SELECT * FROM marketing_posts WHERE id=?', postId);
    res.status(201).json({ ...row, ticketIds });
  } catch (e) { console.error('[marketing:one-off]', e); res.status(500).json({ error: e.message }); }
});

// Calendar feed: every materialised post in a date range. Used by month
// + week views. Each row includes its linked ticket ids so the drawer can
// fetch ticket detail without a second round-trip. Supports comma-separated
// platforms and statuses (e.g. ?platform=instagram,facebook) so the multi-
// select filter on the calendar can hide platforms in a single request.
app.get('/api/marketing/posts', requireAuth, async (req, res) => {
  try {
    const { from, to, platform, status } = req.query;
    const where = [];
    const params = [];
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(String(from))) { where.push('post_date >= ?'); params.push(from); }
    if (to   && /^\d{4}-\d{2}-\d{2}$/.test(String(to)))   { where.push('post_date <= ?'); params.push(to); }
    if (platform) {
      const list = String(platform).split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) {
        where.push(`platform IN (${list.map(() => '?').join(',')})`);
        params.push(...list);
      }
    }
    if (status) {
      const list = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) {
        where.push(`status IN (${list.map(() => '?').join(',')})`);
        params.push(...list);
      }
    }
    const sql = `SELECT * FROM marketing_posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY post_date ASC, id ASC`;
    const posts = await all(sql, ...params);
    if (!posts.length) return res.json([]);
    const ids = posts.map(p => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const links = await all(
      `SELECT post_id, ticket_id, task_title, due_date FROM marketing_post_tickets WHERE post_id IN (${placeholders}) ORDER BY due_date ASC, id ASC`,
      ...ids
    );
    const byPost = new Map();
    for (const l of links) {
      if (!byPost.has(l.post_id)) byPost.set(l.post_id, []);
      byPost.get(l.post_id).push(l);
    }
    res.json(posts.map(p => ({ ...p, tickets: byPost.get(p.id) || [] })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketing/posts/:id', requireAuth, async (req, res) => {
  try {
    const p = await get('SELECT * FROM marketing_posts WHERE id=?', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const links = await all('SELECT * FROM marketing_post_tickets WHERE post_id=? ORDER BY due_date ASC, id ASC', p.id);
    // Pull live status of each ticket so the drawer can render badges.
    const tickets = [];
    for (const l of links) {
      const t = await get('SELECT id, title, status, due, assignee FROM tickets WHERE id=?', l.ticket_id);
      tickets.push({ ...l, ticket: t || null });
    }
    res.json({ ...p, tickets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/marketing/posts/:id', requireAuth, async (req, res) => {
  try {
    const p = await get('SELECT * FROM marketing_posts WHERE id=?', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const status = b.status && MKT_STATUSES.includes(b.status) ? b.status : p.status;
    const notes = b.notes !== undefined ? String(b.notes).slice(0, 4000) : p.notes;
    const actual = b.status === 'posted' && !p.actual_posted_at
      ? new Date().toISOString().replace('T', ' ').replace(/\..*$/, '')
      : (b.actual_posted_at !== undefined ? b.actual_posted_at : p.actual_posted_at);
    await run(
      `UPDATE marketing_posts SET status=?, notes=?, actual_posted_at=?, updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
      status, notes, actual, p.id
    );
    const row = await get('SELECT * FROM marketing_posts WHERE id=?', p.id);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Skip / cancel a single materialised occurrence. When ?deleteTickets=1 is
// passed, the spawned prep tickets are soft-deleted (status='Deleted')
// rather than hard-removed — that keeps the existing trash flow consistent.
app.delete('/api/marketing/posts/:id', requireAdmin, async (req, res) => {
  try {
    const p = await get('SELECT * FROM marketing_posts WHERE id=?', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const deleteTickets = String(req.query.deleteTickets || '') === '1';
    if (deleteTickets) {
      const links = await all('SELECT ticket_id FROM marketing_post_tickets WHERE post_id=?', p.id);
      for (const l of links) {
        try { await run(`UPDATE tickets SET status='Deleted' WHERE id=?`, l.ticket_id); } catch {}
      }
    }
    await run('DELETE FROM marketing_posts WHERE id=?', p.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
// Registered last, after every API route, so it doesn't intercept genuine
// /api/* GETs (which previously returned a fake 404 because this handler ran
// before the bridge + chat routes had a chance to match).
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
  // Inject cross-app config so the frontend can call Syruvia's bridge API
  // without hard-coding the URL in the HTML. We send a tiny inline script
  // that sets window globals before the app JS loads.
  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const inject = `<script>
    window.__SYRUVIA_URL__       = ${JSON.stringify(process.env.SYRUVIA_URL      || '')};
    window.__CROSS_APP_SECRET__  = ${JSON.stringify(process.env.CROSS_APP_SECRET || '')};
  </script>`;
  html = html.replace('<head>', '<head>' + inject);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Critical: never cache the SPA shell. Without this header browsers
  // (especially mobile Safari + installed PWAs) hold onto an old copy
  // and users don't see new code after a deploy until they manually
  // clear site data. Static assets under /public are already no-cache
  // via the express.static middleware.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(html);
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

    // Wrap Express in an http.Server so we can mount the chat WebSocket on
    // the same port/host as REST. The session cookie authenticates both.
    const httpServer = http.createServer(app);
    const wss = new WebSocket.Server({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
      if (!request.url || !request.url.startsWith('/ws/chat')) {
        socket.destroy();
        return;
      }
      // Run the same session middleware on the upgrade request so we can
      // read req.session.userId from the cookie. We hand it a no-op response
      // stub — express-session expects res.setHeader/getHeader/on/end to
      // exist, but for an existing logged-in session (saveUninitialized=false)
      // it never actually writes a Set-Cookie header back during the upgrade.
      const fakeRes = {
        setHeader() {}, getHeader() {}, removeHeader() {},
        on() { return this; }, once() { return this; }, end() {}, write() {},
      };
      sessionMiddleware(request, fakeRes, (err) => {
        if (err) { socket.destroy(); return; }
        const uid = request.session && request.session.userId;
        if (!uid) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.userId = uid;
          wss.emit('connection', ws, request);
        });
      });
    });

    wss.on('connection', (ws) => {
      const uid = ws.userId;
      wsRegister(uid, ws);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', async (raw) => {
        let data; try { data = JSON.parse(raw.toString()); } catch { return; }
        // Typing indicator: client sends { type:'typing', channelId } and we
        // fan it out to the other channel members. Throttled by the client.
        if (data && data.type === 'typing' && data.channelId) {
          wsBroadcastToChannel(Number(data.channelId), {
            type: 'typing', channelId: Number(data.channelId), userId: uid,
          }, uid);
        }
        if (data && data.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        }
      });
      ws.on('close', () => wsUnregister(uid, ws));
      try { ws.send(JSON.stringify({ type: 'hello', userId: uid })); } catch {}
    });
    // Heartbeat — drop dead sockets so we don't fan out to a void.
    setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }, 30 * 1000);

    httpServer.listen(PORT, () => {
      console.log(`✅  Syruvia running at http://localhost:${PORT}`);
      console.log(`   Default login: admin@worknest.com / admin123`);
      console.log(`   Chat WebSocket mounted at ws://localhost:${PORT}/ws/chat`);
    });

    // ── Email cron loops ────────────────────────────────────────────────────
    // Every 5 min: meeting reminders ~1 hour before start, ticket reminders
    // whose remind_at has passed, personal "My Reminders" (one-shot + daily).
    setInterval(runMeetingReminderJob,  5 * 60 * 1000);
    setInterval(runTicketReminderJob,   5 * 60 * 1000);
    setInterval(runPersonalReminderJob, 5 * 60 * 1000);
    // Every hour: deadline-approaching warnings + overdue-digest dispatch.
    setInterval(runDeadlineWarningJob, 60 * 60 * 1000);
    setInterval(runOverdueDigestJob,   60 * 60 * 1000);
    // Once a day: hard-delete tickets that have sat in trash for 30+ days,
    // same window for chat groups that have been closed for 30+ days, and
    // sweep ticket attachments past their retention window (3y while open,
    // 1y after the ticket is closed).
    setInterval(runTrashAutoPurgeJob, 24 * 60 * 60 * 1000);
    setInterval(chatPurgeOldClosedGroups, 24 * 60 * 60 * 1000);
    setInterval(runTicketAttachmentRetentionJob, 24 * 60 * 60 * 1000);
    // Every hour: spawn tickets for any recurring task whose next_run_date
    // is at or before today's UTC date.
    setInterval(runRecurringTasksJob, 60 * 60 * 1000);
    // Every hour: materialise upcoming marketing posts within their lead-time
    // window and spawn the prep tickets.
    setInterval(runMarketingPostsJob, 60 * 60 * 1000);
    // Every hour: create review-day tickets whose per-type lead window opened.
    setInterval(runReviewTicketsJob, 60 * 60 * 1000);
    // Twice a minute: fire ticket nag schedules whose HH:MM just arrived
    // (last_sent_key makes each minute idempotent).
    setInterval(runTicketNagJob, 30 * 1000);
    // Run all jobs once at startup (slightly delayed) so a freshly-deployed
    // server doesn't have to wait an hour to start sending alerts.
    setTimeout(() => {
      runMeetingReminderJob();
      runTicketReminderJob();
      runPersonalReminderJob();
      runDeadlineWarningJob();
      runOverdueDigestJob();
      runTrashAutoPurgeJob();
      chatPurgeOldClosedGroups();
      runTicketAttachmentRetentionJob();
      runRecurringTasksJob();
      runMarketingPostsJob();
      runReviewTicketsJob();
    }, 30 * 1000);
    console.log('✅  Email cron loops scheduled (meeting/ticket/personal reminders, deadline, overdue-digest).');
  } catch(e) {
    console.error('❌  Failed to start:', e.message);
    process.exit(1);
  }
})();