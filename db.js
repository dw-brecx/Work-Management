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
}

module.exports = { pool, init, get, all, run, safeAlter };
