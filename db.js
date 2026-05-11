require('dotenv').config();
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Parse PostgreSQL BIGINT (COUNT results) as JS numbers
types.setTypeParser(20, val => parseInt(val, 10));

const isLocal = !process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/syruvia',
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

function convertSql(sql) {
  return sql
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO')
    .replace(/\bdatetime\('now'\)/gi, "TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')")
    .replace(/\bROWID\b/gi, 'id')
    .replace(/\bsqlite_sequence\b/gi, 'pg_sequences');
}

function numbered(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function withConflict(sql) {
  if (/INSERT\s+OR\s+IGNORE/i.test(sql)) {
    return convertSql(sql).trimEnd() + ' ON CONFLICT DO NOTHING';
  }
  return convertSql(sql);
}

async function run(sql, ...params) {
  const flat = params.flat().filter(p => p !== undefined);
  const pgSql = numbered(withConflict(sql));
  try {
    const result = await pool.query(pgSql, flat);
    return { lastInsertRowid: result.rows[0]?.id ?? null };
  } catch(e) {
    console.error('[db.run] SQL:', pgSql, '\nParams:', flat, '\nError:', e.message);
    throw e;
  }
}

async function all(sql, ...params) {
  const flat = params.flat().filter(p => p !== undefined);
  const pgSql = numbered(convertSql(sql));
  try {
    const result = await pool.query(pgSql, flat);
    return result.rows;
  } catch(e) {
    console.error('[db.all] SQL:', pgSql, '\nError:', e.message);
    throw e;
  }
}

async function get(sql, ...params) {
  const flat = params.flat().filter(p => p !== undefined);
  let pgSql = numbered(convertSql(sql));
  if (!/\bLIMIT\b/i.test(pgSql)) pgSql += ' LIMIT 1';
  try {
    const result = await pool.query(pgSql, flat);
    return result.rows[0] || null;
  } catch(e) {
    console.error('[db.get] SQL:', pgSql, '\nError:', e.message);
    throw e;
  }
}

async function safeAlter(sql) {
  const pgSql = numbered(convertSql(sql))
    .replace(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i, 'ADD COLUMN IF NOT EXISTS ');
  try { await pool.query(pgSql); } catch(e) { /* ignore if column already exists */ }
}

// Run `fn(tx)` inside a single Postgres transaction. tx exposes the same
// run/get/all surface as the module-level helpers but routes every query
// through one dedicated pool client. On any throw the whole batch is rolled
// back; on success it's committed. Used by endpoints that need atomic
// multi-row writes (e.g. flavor-launch ticket batches).
async function withTx(fn) {
  const client = await pool.connect();
  const tx = {
    run: async (sql, ...params) => {
      const flat = params.flat().filter(p => p !== undefined);
      const pgSql = numbered(withConflict(sql));
      const result = await client.query(pgSql, flat);
      return { lastInsertRowid: result.rows[0]?.id ?? null };
    },
    all: async (sql, ...params) => {
      const flat = params.flat().filter(p => p !== undefined);
      const pgSql = numbered(convertSql(sql));
      const result = await client.query(pgSql, flat);
      return result.rows;
    },
    get: async (sql, ...params) => {
      const flat = params.flat().filter(p => p !== undefined);
      let pgSql = numbered(convertSql(sql));
      if (!/\bLIMIT\b/i.test(pgSql)) pgSql += ' LIMIT 1';
      const result = await client.query(pgSql, flat);
      return result.rows[0] || null;
    },
  };
  try {
    await client.query('BEGIN');
    const out = await fn(tx);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function init() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT '',
      dept TEXT DEFAULT '',
      color TEXT DEFAULT '#2563eb',
      perm_role TEXT DEFAULT 'Member',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS invites (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT '',
      dept TEXT DEFAULT '',
      token TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'Pending',
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      expires_at TEXT DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      req TEXT DEFAULT '',
      assignee TEXT DEFAULT '',
      reporter TEXT DEFAULT '',
      priority TEXT DEFAULT 'Medium',
      status TEXT DEFAULT 'Open',
      dept TEXT DEFAULT '',
      due TEXT DEFAULT '',
      created TEXT DEFAULT '',
      overdue INTEGER DEFAULT 0,
      tags_json TEXT DEFAULT '[]',
      comments_count INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_assignees (
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      PRIMARY KEY (ticket_id, user_name)
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_details (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      description TEXT DEFAULT '',
      checklist_json TEXT DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_comments (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      author_init TEXT DEFAULT '',
      author_bg TEXT DEFAULT '#ede9fe',
      author_col TEXT DEFAULT '#5b21b6',
      text TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_timelines (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      dot TEXT DEFAULT 'var(--accent)',
      text TEXT DEFAULT '',
      sub TEXT DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT DEFAULT 'info',
      icon TEXT DEFAULT '🔔',
      text TEXT DEFAULT '',
      ticket_id TEXT DEFAULT '',
      unread INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      reminder_at TEXT DEFAULT '',
      reminder_triggered INTEGER DEFAULT 0,
      promoted_ticket_id TEXT DEFAULT '',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS plan_comments (
      id SERIAL PRIMARY KEY,
      plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
      author TEXT DEFAULT '',
      author_bg TEXT DEFAULT '#ede9fe',
      author_col TEXT DEFAULT '#5b21b6',
      text TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS plan_files (
      id SERIAL PRIMARY KEY,
      plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS cal_events (
      id SERIAL PRIMARY KEY,
      date_key TEXT NOT NULL,
      type TEXT DEFAULT 'meeting',
      label TEXT DEFAULT '',
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      all_day INTEGER DEFAULT 0,
      start_time TEXT DEFAULT '',
      end_time TEXT DEFAULT '',
      linked_ticket_id TEXT DEFAULT '',
      attendees_json TEXT DEFAULT '[]',
      location TEXT DEFAULT '',
      assignee TEXT DEFAULT '',
      completed INTEGER DEFAULT 0,
      syncs_ticket INTEGER DEFAULT 0,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      source TEXT DEFAULT 'personal',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS work_tasks (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT DEFAULT '',
      worker TEXT DEFAULT '',
      estimate TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      timer_running INTEGER DEFAULT 0,
      timer_elapsed INTEGER DEFAULT 0,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      require_ack INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS announcement_seen (
      announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      acknowledged_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (announcement_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_subtasks (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0,
      text TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      done INTEGER DEFAULT 0,
      assignee TEXT DEFAULT '',
      due TEXT DEFAULT '',
      priority TEXT DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS flavor_tasks (
      id SERIAL PRIMARY KEY,
      position INTEGER DEFAULT 0,
      title_template TEXT NOT NULL,
      assignee TEXT DEFAULT '',
      dept TEXT DEFAULT 'General',
      priority TEXT DEFAULT 'Medium',
      days_offset INTEGER DEFAULT 7,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      comment_id INTEGER REFERENCES ticket_comments(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      original_name TEXT DEFAULT '',
      mime_type TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      uploader TEXT DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    // User-submitted feature requests / bug reports / add-on requests.
    // Intentionally NOT in the tickets table — these never appear in the
    // tickets list, dashboard, calendar, or stats. Visible only via the
    // dedicated "Feedback" sidebar page.
    `CREATE TABLE IF NOT EXISTS feedback_items (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'feature',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS feedback_comments (
      id SERIAL PRIMARY KEY,
      feedback_id INTEGER NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      text TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_items (status)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_kind ON feedback_items (kind)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_comments_feedback ON feedback_comments (feedback_id)`,
    `CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire)`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets (token)`,
    // Web Push subscriptions per device. Users may have multiple (phone +
    // desktop) so endpoint is the natural per-device key, with user_id
    // for fan-out. Keys + auth are the standard P-256 push subscription
    // material from the browser's PushSubscription.toJSON().
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL DEFAULT '',
      auth TEXT NOT NULL DEFAULT '',
      user_agent TEXT DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      last_used_at TEXT DEFAULT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id)`,
    // Per-user reminders attached to a ticket. The user who set the reminder
    // gets an email at remind_at. One ticket can have many reminders, set
    // by different users — each row is scoped to a single (user, ticket)
    // pairing. Marked sent=1 once delivered so the cron doesn't re-send.
    `CREATE TABLE IF NOT EXISTS ticket_reminders (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      remind_at TEXT NOT NULL,
      note TEXT DEFAULT '',
      sent INTEGER DEFAULT 0,
      sent_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_reminders_due ON ticket_reminders (sent, remind_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_reminders_ticket_user ON ticket_reminders (ticket_id, user_id)`,
    // Personal reminders ("My Reminders"): a private per-user task list. Rows
    // are visible only to user_id. Optionally linked to a ticket (ticket_id),
    // but the link is one-way — tickets never expose another user's reminders.
    // due_at is stored as 'YYYY-MM-DD HH:MM:SS' UTC so the cron can compare
    // directly against TO_CHAR(NOW()). When repeat_daily=1, the email cron
    // re-fires at the same time-of-day every day until completed=1; the
    // last_email_sent_at high-water mark prevents duplicate sends within a
    // single day. show_daily_in_app=1 surfaces the row in the once-per-day
    // in-app popup, with last_in_app_shown_at gating per-day display.
    `CREATE TABLE IF NOT EXISTS personal_reminders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      due_at TEXT NOT NULL,
      email_enabled INTEGER DEFAULT 1,
      repeat_daily INTEGER DEFAULT 0,
      show_daily_in_app INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      completed_at TEXT DEFAULT NULL,
      last_email_sent_at TEXT DEFAULT NULL,
      last_in_app_shown_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_personal_reminders_user ON personal_reminders (user_id, completed)`,
    `CREATE INDEX IF NOT EXISTS idx_personal_reminders_ticket ON personal_reminders (ticket_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_personal_reminders_due ON personal_reminders (completed, email_enabled, due_at)`,
    // Per-user "last viewed" stamp on each ticket — drives the unread
    // highlight on the tickets list. A ticket is unread for a user when
    // there's no row here OR last_viewed_at is older than the ticket's
    // latest activity (new comment / status change / etc.). Upserted
    // every time openTicketDetail runs.
    `CREATE TABLE IF NOT EXISTS ticket_views (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      last_viewed_at TEXT NOT NULL DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (user_id, ticket_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_views_user ON ticket_views (user_id)`,
    // Workspace-wide quick links to other apps (Syruvia Lab, Slack, Drive,
    // an internal dashboard, etc.). Visible to everyone in the sidebar;
    // managed by admins under Settings → Apps. Position drives ordering.
    `CREATE TABLE IF NOT EXISTS external_apps (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      icon TEXT DEFAULT '',
      position INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_external_apps_position ON external_apps (position)`,
    // Recurring-project templates: named bundles of tasks the admin can
    // spawn into a real project + child tickets in one click. Same idea
    // as flavor_tasks but with multiple named templates instead of one
    // global one — different recurring workflows (e.g. "Email campaign",
    // "Trade show booth") each have their own task list.
    `CREATE TABLE IF NOT EXISTS project_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS project_template_tasks (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES project_templates(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0,
      title_template TEXT NOT NULL,
      description TEXT DEFAULT '',
      assignee TEXT DEFAULT '',
      dept TEXT DEFAULT 'General',
      priority TEXT DEFAULT 'Medium',
      days_offset INTEGER DEFAULT 7
    )`,
    `CREATE INDEX IF NOT EXISTS idx_project_template_tasks_tpl ON project_template_tasks (template_id, position)`,
    // Workspace docs — a notion/ClickUp-style document store. Anyone in the
    // workspace can read/write any doc (no per-doc ACL yet). parent_id +
    // position are wired in advance so subpages can be added later without
    // a schema migration.
    `CREATE TABLE IF NOT EXISTS docs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Untitled',
      body TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES docs(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_docs_parent ON docs (parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs (updated_at DESC)`,
    // Workspace chat (ClickUp-style). Three flavours of conversation share
    // one "channel" row: type='channel' (named room, optionally private with
    // explicit member list), type='dm' (1:1 — dm_key is the deterministic
    // sorted "minId:maxId" pair so we never create two DM rows for the same
    // pair), and type='group' (>=3-person ad-hoc DM). Membership lives in
    // chat_channel_members; messages in chat_messages (parent_message_id
    // links a reply to its parent — drives threads). Reactions + mentions
    // are their own tables. Attachments piggy-back on the existing
    // `attachments` table via a new chat_message_id column.
    `CREATE TABLE IF NOT EXISTS chat_channels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'channel',
      is_private INTEGER NOT NULL DEFAULT 0,
      dm_key TEXT,
      topic TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      last_message_at TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_dm_key ON chat_channels (dm_key) WHERE dm_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_chat_channels_type ON chat_channels (type)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_channels_last_msg ON chat_channels (last_message_at DESC)`,
    // Members: who's in the channel, what they've read, mute / notify prefs.
    // last_read_message_id is the largest message id this user has marked
    // read — drives unread badges. notify is one of 'all' (every message),
    // 'mentions' (only @mentions), 'none' (mute completely).
    `CREATE TABLE IF NOT EXISTS chat_channel_members (
      channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      last_read_at TEXT,
      notify TEXT NOT NULL DEFAULT 'all',
      hidden INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_channel_members (user_id)`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      parent_message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages (channel_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_parent ON chat_messages (parent_message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages (user_id)`,
    // One row per (message, user, emoji). Composite primary key prevents the
    // same user from reacting twice with the same emoji; multiple emojis
    // per user on a single message are fine.
    `CREATE TABLE IF NOT EXISTS chat_message_reactions (
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (message_id, user_id, emoji)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON chat_message_reactions (message_id)`,
    // One row per @mention parsed out of a message. Drives:
    //   * unread-mention badge (count where user_id=me and seen_at IS NULL)
    //   * push + email fan-out at send time (server inserts a row per match)
    //   * the dashboard "awaiting reply" panel (later)
    `CREATE TABLE IF NOT EXISTS chat_mentions (
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seen_at TEXT,
      PRIMARY KEY (message_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_mentions_user ON chat_mentions (user_id, seen_at)`,
    // ── Spaces ───────────────────────────────────────────────────────────
    // Freeform "canvas" workspaces for collecting project artefacts as
    // draggable cards (tickets, notes, files, links, recordings).
    // Sharing: per-user invites in space_members, plus an optional public
    // share token served by an unauthenticated /api/spaces/public/:token.
    // 30-day soft-delete via deleted_at — matches the tickets-trash pattern.
    `CREATE TABLE IF NOT EXISTS spaces (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      cover_color TEXT NOT NULL DEFAULT '#bf7325',
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      owner_name TEXT NOT NULL DEFAULT '',
      is_public INTEGER NOT NULL DEFAULT 0,
      public_token TEXT,
      public_can_edit INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_public_token ON spaces (public_token) WHERE public_token IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces (owner_id)`,
    // Member access list — same shape as chat_channel_members but for
    // Spaces. role = 'viewer' | 'editor'. Composite PK prevents duplicates.
    `CREATE TABLE IF NOT EXISTS space_members (
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'viewer',
      added_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (space_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members (user_id)`,
    // Individual cards on the canvas. type drives the renderer: 'ticket' |
    // 'sticky' | 'note' | 'document' | 'file' | 'image' | 'voice' | 'video' |
    // 'link'. Media (file/image/voice/video) stores the binary as base64 in
    // `data` — mirrors the chat-attachment pattern. ticket_meta is a cached
    // snapshot for ticket-type cards so the canvas can show status/assignee
    // without a follow-up fetch.
    `CREATE TABLE IF NOT EXISTS space_items (
      id SERIAL PRIMARY KEY,
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT,
      text TEXT,
      url TEXT,
      data TEXT,
      mime_type TEXT,
      size INTEGER,
      duration INTEGER,
      color TEXT,
      ticket_ref TEXT,
      ticket_meta TEXT,
      position_x REAL NOT NULL DEFAULT 0,
      position_y REAL NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT 280,
      height REAL NOT NULL DEFAULT 200,
      z_index INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_space_items_space ON space_items (space_id)`,
    // Per-space chat. Anyone who can view the space (owner / members / public
    // editors) can read; anyone who can edit can post. Messages cascade-delete
    // with the space.
    `CREATE TABLE IF NOT EXISTS space_chat_messages (
      id SERIAL PRIMARY KEY,
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_space_chat_messages_space ON space_chat_messages (space_id, id)`,
  ];

  for (const sql of tables) {
    await pool.query(sql);
  }

  // Add subtask linkage to attachments (existing installs)
  await safeAlter('ALTER TABLE attachments ADD COLUMN subtask_id INTEGER');
  // Same for the new feedback / announcement parents — voice notes, screen
  // recordings, and pasted screenshots can be attached to either.
  await safeAlter('ALTER TABLE attachments ADD COLUMN feedback_id INTEGER');
  await safeAlter('ALTER TABLE attachments ADD COLUMN announcement_id INTEGER');
  // Personal-reminder media: voice notes, screen recordings, files, and
  // pasted images attach to a reminder via this column. Per-user privacy is
  // inherited from the parent reminder row (the upload + delete routes
  // verify the caller owns the reminder).
  await safeAlter('ALTER TABLE attachments ADD COLUMN reminder_id INTEGER');
  // Docs got upgraded from "markdown editor only" to a general document
  // library that can hold uploaded files (Word/Excel/PDF/zip/etc.) and
  // external links (Google Sheets, Google Docs, Notion pages) alongside
  // inline markdown notes. type drives which UI surface a doc opens in.
  await safeAlter("ALTER TABLE docs ADD COLUMN type TEXT DEFAULT 'markdown'");
  await safeAlter("ALTER TABLE docs ADD COLUMN external_url TEXT DEFAULT ''");
  // attachments.doc_id links an uploaded file to its parent doc — same
  // pattern used for ticket / comment / feedback / reminder attachments.
  await safeAlter('ALTER TABLE attachments ADD COLUMN doc_id INTEGER');
  // Same pattern again for chat message attachments — files dropped into
  // the chat composer are uploaded via /api/upload with chatMessageId set
  // and surface inline under the message that pinned them.
  await safeAlter('ALTER TABLE attachments ADD COLUMN chat_message_id INTEGER');
  // Soft-close for chat group / DM channels. When set, the conversation
  // is hidden from the main sidebar list (surfaced under "Closed" instead),
  // and the composer is disabled. A nightly cron hard-deletes any group
  // that's been closed for 30+ days. NULL = active.
  await safeAlter("ALTER TABLE chat_channels ADD COLUMN closed_at TEXT");
  await safeAlter("ALTER TABLE chat_channels ADD COLUMN closed_by INTEGER");
  // Per-doc visibility. public = anyone in the workspace can see it
  // (default); private = only the creator + admins + users explicitly
  // added via doc_shares. The file URL itself (/uploads/*) is still
  // publicly fetchable — visibility gates the listing + GET-by-id only.
  await safeAlter("ALTER TABLE docs ADD COLUMN visibility TEXT DEFAULT 'public'");
  // Per-(doc, user) explicit access grants. Only checked when the doc's
  // visibility = 'private'. Public docs ignore this table entirely.
  await pool.query(`CREATE TABLE IF NOT EXISTS doc_shares (
    doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    granted_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
    PRIMARY KEY (doc_id, user_id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_doc_shares_user ON doc_shares (user_id)');
  // Announcements gain a 'kind' tag (feature / bugfix / update / note) so the
  // What's New feed can color-code them. Default 'update' is safe for any
  // existing row that pre-dates this column.
  await safeAlter("ALTER TABLE announcements ADD COLUMN kind TEXT DEFAULT 'update'");
  // Audience flag: when 1, the announcement is restricted to users whose
  // perm_role is Admin or Manager — Members never see it in the feed, the
  // popup, or the unread badge. Default 0 = visible to everyone (back-
  // compat with announcements that pre-date this column).
  await safeAlter("ALTER TABLE announcements ADD COLUMN admin_only INTEGER DEFAULT 0");
  // High-water mark: the largest announcement id this user has seen in the
  // What's New feed. Drives the unread badge in the sidebar (count of
  // active announcements with id > this value). Separate from
  // announcement_seen — that table is for popup acknowledgement.
  await safeAlter("ALTER TABLE users ADD COLUMN last_announcement_id_seen INTEGER DEFAULT 0");
  // Project hierarchy: an admin can promote a ticket to a "project" and then
  // create child tickets under it. Children carry parent_ticket_id pointing
  // back at the project. Single-level only — children can't themselves be
  // projects. The main tickets list hides children; the Projects page lists
  // every project.
  await safeAlter('ALTER TABLE tickets ADD COLUMN parent_ticket_id TEXT');
  // Optional reason captured when a user closes a ticket. Stored verbatim
  // and surfaced on the closed-ticket detail; null when no reason was
  // provided. Pure metadata — doesn't affect access checks.
  await safeAlter('ALTER TABLE tickets ADD COLUMN close_reason TEXT');
  await safeAlter('ALTER TABLE tickets ADD COLUMN is_project INTEGER DEFAULT 0');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets (parent_ticket_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_is_project ON tickets (is_project)');
  // Profile avatar (existing installs)
  await safeAlter("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''");
  // Time zone preference (existing installs)
  await safeAlter("ALTER TABLE users ADD COLUMN tz TEXT DEFAULT ''");
  // Soft delete for tickets — never actually drop a row, just mark deleted_at
  await safeAlter("ALTER TABLE tickets ADD COLUMN deleted_at TEXT DEFAULT NULL");
  // Threaded comments — parent_id links a reply to the comment it answers
  await safeAlter("ALTER TABLE ticket_comments ADD COLUMN parent_id INTEGER");
  // Stable user references on tickets — link assignee/reporter/req to user.id
  // so a profile rename never breaks the association. (FK constraint
  // intentionally omitted: ADD COLUMN IF NOT EXISTS skips on existing installs
  // so a REFERENCES clause here wouldn't be retroactively applied. The columns
  // are managed application-side via resolveUserIdByName at write time.)
  await safeAlter("ALTER TABLE tickets ADD COLUMN assignee_user_id INTEGER");
  await safeAlter("ALTER TABLE tickets ADD COLUMN reporter_user_id INTEGER");
  await safeAlter("ALTER TABLE tickets ADD COLUMN req_user_id INTEGER");
  await safeAlter("ALTER TABLE ticket_assignees ADD COLUMN user_id INTEGER");
  // Same id-link pattern for comments and subtasks so renames don't break
  // their author/assignee display either. Application-side write resolution.
  await safeAlter("ALTER TABLE ticket_comments ADD COLUMN author_user_id INTEGER");
  await safeAlter("ALTER TABLE ticket_subtasks ADD COLUMN assignee_user_id INTEGER");

  // One-time best-effort back-fill: populate the new *_user_id columns by
  // matching the current name string against users.name. Rows whose stored
  // name no longer matches any user (because that user was renamed since)
  // stay null and continue to fall back to name-based matching.
  await run(`UPDATE tickets t SET assignee_user_id = u.id
              FROM users u
              WHERE t.assignee_user_id IS NULL AND t.assignee = u.name AND t.assignee != ''`);
  await run(`UPDATE tickets t SET reporter_user_id = u.id
              FROM users u
              WHERE t.reporter_user_id IS NULL AND t.reporter = u.name AND t.reporter != ''`);
  await run(`UPDATE tickets t SET req_user_id = u.id
              FROM users u
              WHERE t.req_user_id IS NULL AND t.req = u.name AND t.req != ''`);
  await run(`UPDATE ticket_assignees ta SET user_id = u.id
              FROM users u
              WHERE ta.user_id IS NULL AND ta.user_name = u.name AND ta.user_name != ''`);
  // Back-fill comment author and subtask assignee user_ids the same way.
  await run(`UPDATE ticket_comments tc SET author_user_id = u.id
              FROM users u
              WHERE tc.author_user_id IS NULL AND tc.author = u.name AND tc.author != ''`);
  await run(`UPDATE ticket_subtasks ts SET assignee_user_id = u.id
              FROM users u
              WHERE ts.assignee_user_id IS NULL AND ts.assignee = u.name AND ts.assignee != ''`);
  // Email-system migrations — track known devices/IPs for new-device-login alerts,
  // and per-event flags so we don't double-fire reminder/deadline emails.
  await safeAlter("ALTER TABLE users ADD COLUMN known_uas TEXT DEFAULT '[]'");
  await safeAlter("ALTER TABLE users ADD COLUMN last_login_ip TEXT DEFAULT ''");
  await safeAlter("ALTER TABLE users ADD COLUMN last_login_at TEXT DEFAULT ''");
  await safeAlter("ALTER TABLE users ADD COLUMN welcome_sent INTEGER DEFAULT 0");
  await safeAlter("ALTER TABLE cal_events ADD COLUMN reminder_sent INTEGER DEFAULT 0");
  await safeAlter("ALTER TABLE cal_events ADD COLUMN deadline_warned INTEGER DEFAULT 0");
  await safeAlter("ALTER TABLE tickets ADD COLUMN closed_email_sent INTEGER DEFAULT 0");
  // Syruvia Lab integration — link a ticket to a flavor formula
  await safeAlter("ALTER TABLE tickets ADD COLUMN syruvia_flavor_id TEXT DEFAULT NULL");
  await safeAlter("ALTER TABLE tickets ADD COLUMN syruvia_flavor_name TEXT DEFAULT NULL");
  await safeAlter("ALTER TABLE users ADD COLUMN last_overdue_digest_at TEXT DEFAULT ''");
  // Cached Slack user id (looked up via users.lookupByEmail the first time
  // we want to DM this user). Empty string = "not yet looked up";
  // 'NOTFOUND' sentinel = "Slack workspace has no user with this email,
  // don't keep retrying". Populated lazily by slackDmUser in server.js.
  await safeAlter("ALTER TABLE users ADD COLUMN slack_user_id TEXT DEFAULT ''");
  // Per-notification "user has triaged this" stamp. Null = active, set =
  // user marked it handled (e.g. clicked "No reply needed" on a mention).
  // Used to clear mentions from the dashboard's "awaiting reply" count
  // without forcing the user to actually post a comment in response.
  await safeAlter("ALTER TABLE notifications ADD COLUMN dismissed_at TEXT DEFAULT NULL");
  // Stamped when a ticket's status flips to Closed (and cleared on reopen).
  // Used by the dashboard's "Completed today" card — we used to fudge this
  // as "tickets created today that happen to be Closed" which is wrong.
  await safeAlter("ALTER TABLE tickets ADD COLUMN closed_at TEXT DEFAULT NULL");
  // Back-fill: any currently-Closed ticket that has no closed_at gets
  // its created_at as a best-effort stand-in (we don't have the real
  // close time for historical rows). Marks them as "closed before the
  // closed_at column existed" so they never appear in today's count by
  // accident. New closes from now on get NOW() set in the PUT route.
  await run(
    `UPDATE tickets SET closed_at = created_at
       WHERE status = 'Closed' AND closed_at IS NULL`
  );

  // Consolidate roles to the canonical three: Admin / Manager / Member.
  // Old installs may have Owner / User / Viewer values; map them onto the
  // new set so every user falls into one of the three buckets.
  await run("UPDATE users SET perm_role='Admin'  WHERE perm_role IN ('Owner')");
  await run("UPDATE users SET perm_role='Member' WHERE perm_role IN ('User','Viewer')");
  await run("UPDATE users SET perm_role='Member' WHERE perm_role IS NULL OR perm_role=''");

  // Seed default admin
  const existing = await get('SELECT id FROM users WHERE email=?', 'admin@worknest.com');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run('INSERT INTO users (name,email,password_hash,role,dept,color,perm_role) VALUES (?,?,?,?,?,?,?)',
      'Admin', 'admin@worknest.com', hash, 'Administrator', 'Management', '#2563eb', 'Admin');
  }

  // Seed default departments
  const defaults = ['Engineering', 'Design', 'Support', 'Operations', 'Management', 'General'];
  for (const name of defaults) {
    if (!await get('SELECT id FROM departments WHERE name=?', name))
      await run('INSERT INTO departments (name) VALUES (?)', name);
  }

  // Seed the #general chat channel everyone joins automatically. Idempotent:
  // only inserted if no public 'general' channel exists yet. Every existing
  // user is added as a member; new users get auto-joined at registration.
  try {
    const generalRow = await get(
      "SELECT id FROM chat_channels WHERE type='channel' AND lower(name)='general'"
    );
    let generalId = generalRow ? generalRow.id : null;
    if (!generalId) {
      const ins = await run(
        "INSERT INTO chat_channels (name, description, type, is_private, created_by) VALUES (?,?,?,?,?) RETURNING id",
        'general', 'Workspace-wide announcements and chatter.', 'channel', 0, null
      );
      generalId = ins.lastInsertRowid;
    }
    if (generalId) {
      const everyone = await all('SELECT id FROM users');
      for (const u of (everyone || [])) {
        await run(
          'INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING',
          generalId, u.id
        );
      }
    }
  } catch (e) { console.warn('[seed] #general chat channel:', e.message); }

  // Seed default flavor-launch tasks (template). Only inserted if the table is empty.
  const flavorRows = await get('SELECT COUNT(*) AS n FROM flavor_tasks');
  if (!flavorRows || Number(flavorRows.n) === 0) {
    const seeds = [
      { pos: 1, title: 'Design label for {flavor}',                          dept: 'Design',     priority: 'High',   days: 7  },
      { pos: 2, title: 'Design Amazon listing images for {flavor}',          dept: 'Design',     priority: 'Medium', days: 14 },
      { pos: 3, title: 'Design website page for {flavor}',                   dept: 'Design',     priority: 'Medium', days: 14 },
      { pos: 4, title: 'Write product content / copy for {flavor}',          dept: 'Operations', priority: 'Medium', days: 10 },
      { pos: 5, title: 'List {flavor} on all marketplaces',                  dept: 'Operations', priority: 'High',   days: 21 },
    ];
    for (const s of seeds) {
      await run(
        'INSERT INTO flavor_tasks (position, title_template, assignee, dept, priority, days_offset) VALUES (?,?,?,?,?,?)',
        s.pos, s.title, '', s.dept, s.priority, s.days
      );
    }
  }
}

module.exports = { pool, init, get, all, run, safeAlter, withTx };