// Uses the built-in node:sqlite module (Node.js v22.5+, stable in v24)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

const DB_PATH = path.join(__dirname, 'worknest.db');
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'Team Member',
      dept TEXT DEFAULT 'General',
      color TEXT DEFAULT '#3b82f6',
      perm_role TEXT DEFAULT 'Member',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT '',
      dept TEXT DEFAULT '',
      token TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'Pending',
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      req TEXT DEFAULT '',
      assignee TEXT DEFAULT '',
      reporter TEXT DEFAULT '',
      priority TEXT DEFAULT 'Medium',
      status TEXT DEFAULT 'Open',
      dept TEXT DEFAULT 'Engineering',
      due TEXT DEFAULT '',
      created TEXT DEFAULT '',
      overdue INTEGER DEFAULT 0,
      tags_json TEXT DEFAULT '[]',
      comments_count INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_assignees (
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      PRIMARY KEY (ticket_id, user_name)
    );

    CREATE TABLE IF NOT EXISTS ticket_details (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      description TEXT DEFAULT '',
      checklist_json TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      author_init TEXT,
      author_bg TEXT DEFAULT '#ede9fe',
      author_col TEXT DEFAULT '#5b21b6',
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_timelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      dot TEXT DEFAULT 'var(--accent)',
      text TEXT NOT NULL,
      sub TEXT DEFAULT 'Just now',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      reminder_at TEXT DEFAULT '',
      reminder_triggered INTEGER DEFAULT 0,
      promoted_ticket_id TEXT DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plan_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plan_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      author_bg TEXT DEFAULT '#ede9fe',
      author_col TEXT DEFAULT '#5b21b6',
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT REFERENCES tickets(id),
      worker TEXT DEFAULT '',
      estimate TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'Pending',
      timer_running INTEGER DEFAULT 0,
      timer_elapsed INTEGER DEFAULT 0,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      type TEXT DEFAULT 'mention',
      icon TEXT DEFAULT '💬',
      text TEXT NOT NULL,
      time_label TEXT DEFAULT 'Just now',
      unread INTEGER DEFAULT 1,
      ticket_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  seedDefaultAdmin();
}

function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function seedDefaultAdmin() {
  const existing = get('SELECT id FROM users WHERE email = ?', 'admin@worknest.com');
  if (existing) return;

  const hash = bcrypt.hashSync('admin123', 10);
  run(`INSERT INTO users (name, email, password_hash, role, dept, color, perm_role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'John Doe', 'admin@worknest.com', hash, 'Product Designer', 'Design', '#3b82f6', 'Owner');

  const members = [
    { name:'Sarah Johnson', email:'sarah@worknest.com', role:'Frontend Developer',  dept:'Engineering', color:'#3b82f6', pr:'Admin'  },
    { name:'Mike Peters',   email:'mike@worknest.com',  role:'Backend Developer',   dept:'Engineering', color:'#6366f1', pr:'Member' },
    { name:'Emily Davis',   email:'emily@worknest.com', role:'UI/UX Designer',       dept:'Design',      color:'#22c55e', pr:'Member' },
    { name:'David Lee',     email:'david@worknest.com', role:'Full Stack Developer', dept:'Engineering', color:'#eab308', pr:'Member' },
    { name:'Priya Singh',   email:'priya@worknest.com', role:'QA Engineer',          dept:'Support',     color:'#f97316', pr:'Member' },
  ];
  for (const m of members) {
    const ph = bcrypt.hashSync('password123', 10);
    run(`INSERT OR IGNORE INTO users (name, email, password_hash, role, dept, color, perm_role)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, m.name, m.email, ph, m.role, m.dept, m.color, m.pr);
  }

  run(`INSERT OR IGNORE INTO invites (email, name, role, dept, token, status) VALUES (?, ?, ?, ?, ?, ?)`,
      'ariana@worknest.com', 'Ariana Moore', 'Customer Success Manager', 'Support', randomUUID(), 'Pending');
  run(`INSERT OR IGNORE INTO invites (email, name, role, dept, token, status) VALUES (?, ?, ?, ?, ?, ?)`,
      'daniel@worknest.com', 'Daniel Cooper', 'Product Manager', 'Management', randomUUID(), 'Pending');

  const tickets = [
    { id:'TKT-1042', title:'API Integration for Payment Gateway',    req:'Olivia Brown', assignee:'John Doe',     reporter:'John Doe',     priority:'High',   status:'In Progress',    dept:'Engineering', due:'May 24, 2024', created:'May 20, 2024', ov:1, tags:'["API","Payment"]',        cm:3, as:['John Doe','Sarah Johnson'] },
    { id:'TKT-1041', title:'Fix: Unable to Upload Documents',         req:'Liam Wilson',  assignee:'Mike Peters',  reporter:'John Doe',     priority:'Medium', status:'Open',           dept:'Support',     due:'May 26, 2024', created:'May 21, 2024', ov:0, tags:'["Bug","Upload"]',         cm:1, as:['Mike Peters'] },
    { id:'TKT-1040', title:'Design: New Landing Page',                req:'Emma Clark',   assignee:'John Doe',     reporter:'Sarah Johnson',priority:'High',   status:'In Review',      dept:'Design',      due:'May 23, 2024', created:'May 18, 2024', ov:1, tags:'["Design","Marketing"]',   cm:7, as:['John Doe','Emily Davis','Priya Singh'] },
    { id:'TKT-1039', title:'User Role & Permission Management',       req:'Noah Lee',     assignee:'David Lee',    reporter:'John Doe',     priority:'Medium', status:'Pending Review', dept:'Engineering', due:'May 28, 2024', created:'May 19, 2024', ov:0, tags:'["Auth","Backend"]',       cm:5, as:['David Lee','Sarah Johnson'] },
    { id:'TKT-1038', title:'Email Notification Not Working',          req:'Ava Smith',    assignee:'John Doe',     reporter:'John Doe',     priority:'Low',    status:'Open',           dept:'Support',     due:'May 30, 2024', created:'May 21, 2024', ov:0, tags:'["Email","Bug"]',          cm:0, as:['John Doe'] },
    { id:'TKT-1037', title:'Customer Portal UI Cleanup',              req:'John Doe',     assignee:'Sarah Johnson',reporter:'Sarah Johnson',priority:'Medium', status:'Open',           dept:'Design',      due:'May 31, 2024', created:'May 22, 2024', ov:0, tags:'["UI","Polish"]',          cm:2, as:['Sarah Johnson','Emily Davis'] },
    { id:'TKT-1036', title:'Inventory Sync Error',                    req:'Sophia Taylor',assignee:'Mike Peters',  reporter:'John Doe',     priority:'Urgent', status:'Overdue',        dept:'Operations',  due:'May 22, 2024', created:'May 17, 2024', ov:1, tags:'["Sync","Bug","Urgent"]',  cm:9, as:['Mike Peters','David Lee','John Doe','Priya Singh'] },
    { id:'TKT-1035', title:'Mobile App Crash on Login',               req:'Oliver Brown', assignee:'David Lee',    reporter:'Mike Peters',  priority:'High',   status:'In Progress',    dept:'Engineering', due:'May 25, 2024', created:'May 20, 2024', ov:0, tags:'["Mobile","Crash"]',       cm:4, as:['David Lee'] },
    { id:'TKT-0998', title:'Profile Page Bug Fixes',                  req:'Mia Anderson', assignee:'John Doe',     reporter:'John Doe',     priority:'Medium', status:'Closed',         dept:'Engineering', due:'May 18, 2024', created:'May 15, 2024', ov:0, tags:'["Profile","Bug"]',        cm:6, as:['John Doe'] },
  ];

  for (const t of tickets) {
    run(`INSERT OR IGNORE INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.id, t.title, t.req, t.assignee, t.reporter, t.priority, t.status, t.dept, t.due, t.created, t.ov, t.tags, t.cm);
    for (const a of t.as) run(`INSERT OR IGNORE INTO ticket_assignees (ticket_id,user_name) VALUES (?,?)`, t.id, a);
    run(`INSERT OR IGNORE INTO ticket_details (ticket_id,description,checklist_json) VALUES (?,?,?)`,
        t.id, `Details for "${t.title}". Add a description to give your team more context.`, '[]');
  }

  run(`UPDATE ticket_details SET description=?, checklist_json=? WHERE ticket_id='TKT-1042'`,
    'We need to integrate the third-party payment gateway into our platform. This includes implementing the required API endpoints, handling authentication (OAuth 2.0), and ensuring secure communication.\n\nVerify the payment flow from initiation to confirmation. Implement proper error handling for failed transactions and timeouts. Map the gateway callbacks/webhooks to our internal event system.\n\nEnsure all flows are tested in sandbox and production environments. Provide unit and integration tests with at least 90% coverage.',
    JSON.stringify([
      { text:'Review and finalize API documentation', done:true },
      { text:'Implement authentication and token refresh', done:true },
      { text:'Map callback/webhook events', done:false },
      { text:'End-to-end testing in staging environment', done:false },
    ])
  );

  const insCmt = `INSERT INTO ticket_comments (ticket_id,author,author_init,author_bg,author_col,text) VALUES (?,?,?,?,?,?)`;
  run(insCmt, 'TKT-1042','Sarah Johnson','SJ','#ede9fe','#5b21b6',"I've completed the authentication flow and initial API integration. Working on error handling and callback mapping now.");
  run(insCmt, 'TKT-1042','Mike Peters',  'MP','#dde4ff','#3730a3','The sandbox environment is stable. You can test the payment initiation and status check endpoints.');
  run(insCmt, 'TKT-1042','John Doe',     'JD','#dcfce7','#166534','Great progress! Please share ETA for staging tests so we can plan the UAT with the finance team.');

  run(`INSERT OR IGNORE INTO plans (id,title,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    'PLN-001','Investigate why customer support replies are slow',
    'Hypothesis: too many handoffs between Tier 1 and Tier 2.\n\nQuestions:\n• Avg response time by agent?\n• Where do tickets sit longest?\n• Should we add a triage stage?\n\nData to pull: last 30 days of TKT response times.',
    'draft','May 18, 2024','May 20, 2024');
  run(`INSERT OR IGNORE INTO plans (id,title,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    'PLN-002','Revamp onboarding checklist for new hires',
    'Current checklist is 3 years old. Missing: tool access, security training, buddy assignment.\n\nOwner: HR + Engineering leads\nTimeline: Q2 target',
    'waiting','May 19, 2024','May 21, 2024');
  run(`INSERT OR IGNORE INTO plans (id,title,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    'PLN-003','Reduce ticket backlog by 30% before end of quarter',
    'We need to close or archive stale tickets. Define "stale" threshold first.\n\nIdea: auto-close anything older than 60 days with no activity after one warning email.',
    'draft','May 20, 2024','May 20, 2024');
}

module.exports = { db, init, get, all, run };
