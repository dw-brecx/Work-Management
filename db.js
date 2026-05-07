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
    `CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire)`,
  ];

  for (const sql of tables) {
    await pool.query(sql);
  }

  // Add subtask linkage to attachments (existing installs)
  await safeAlter('ALTER TABLE attachments ADD COLUMN subtask_id INTEGER');
  // Profile avatar (existing installs)
  await safeAlter("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''");
  // Time zone preference (existing installs)
  await safeAlter("ALTER TABLE users ADD COLUMN tz TEXT DEFAULT ''");
  // Soft delete for tickets — never actually drop a row, just mark deleted_at
  await safeAlter("ALTER TABLE tickets ADD COLUMN deleted_at TEXT DEFAULT NULL");

  // Seed default admin
  const existing = await get('SELECT id FROM users WHERE email=?', 'admin@worknest.com');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run('INSERT INTO users (name,email,password_hash,role,dept,color,perm_role) VALUES (?,?,?,?,?,?,?)',
      'Admin', 'admin@worknest.com', hash, 'Administrator', 'Management', '#2563eb', 'Owner');
  }

  // Seed default departments
  const defaults = ['Engineering', 'Design', 'Support', 'Operations', 'Management', 'General'];
  for (const name of defaults) {
    if (!await get('SELECT id FROM departments WHERE name=?', name))
      await run('INSERT INTO departments (name) VALUES (?)', name);
  }

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

module.exports = { pool, init, get, all, run, safeAlter };
