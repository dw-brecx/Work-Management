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
    // Flavor-launch v2 — guided wizard that captures formula inputs (sugar
    // type, color, salt %, etc.), auto-generates the ingredient list + sodium
    // value, and spawns a pipeline of linked tickets (UPC, SKU, NineYard,
    // label, listing content, images, channel listings, mappings, variations).
    // Each ticket links back via tickets.flavor_v2_id so a per-flavor bottle
    // visualisation can fill as work completes.
    `CREATE TABLE IF NOT EXISTS flavors_v2 (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'regular',
      color TEXT NOT NULL DEFAULT 'none',
      syrup_color TEXT NOT NULL DEFAULT '',
      flavor_type TEXT NOT NULL DEFAULT 'natural',
      use_of_syrup TEXT NOT NULL DEFAULT 'other',
      has_salt INTEGER NOT NULL DEFAULT 0,
      salt_pct NUMERIC NOT NULL DEFAULT 0,
      ingredients TEXT NOT NULL DEFAULT '',
      sodium_mg INTEGER NOT NULL DEFAULT 0,
      upc TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      completed_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_flavors_v2_status ON flavors_v2 (status)`,
    `CREATE INDEX IF NOT EXISTS idx_flavors_v2_created ON flavors_v2 (created_at DESC)`,
    // Sales channels (Amazon, Walmart, Custom, …). Drives the channel-listing
    // tickets in a later phase and the channel-specific price + content
    // rules. has_fba flips on the FBA / FBM split for marketplaces that do
    // both (Amazon, occasionally Walmart). Soft-disable via `enabled` so
    // killing a channel mid-launch doesn't break historical references.
    `CREATE TABLE IF NOT EXISTS flavor_channels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      has_fba INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_flavor_channels_position ON flavor_channels (position)`,
    // Listing-content example templates. The user pastes their existing copy
    // here — title pattern, bullets, description — and the (later-phase)
    // content generator substitutes flavor data into the placeholders to
    // produce listings for new flavors in the same voice. Keyed by
    // (syrup_use, flavor_type) so coffee templates only apply to coffee
    // flavors, natural-only templates leave the "natural" emphasis intact
    // for natural flavors, etc. `keywords` is a freeform comma-separated
    // bag the worker can copy to the listing keywords field on a channel.
    `CREATE TABLE IF NOT EXISTS flavor_listing_examples (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      syrup_use TEXT NOT NULL DEFAULT 'other',
      flavor_type TEXT NOT NULL DEFAULT 'any',
      listing_type TEXT NOT NULL DEFAULT 'single',
      title_template TEXT NOT NULL DEFAULT '',
      bullets_json TEXT NOT NULL DEFAULT '[]',
      description_template TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_flavor_examples_lookup
      ON flavor_listing_examples (syrup_use, flavor_type, listing_type)`,
    // Product types — the user's curated 10-category taxonomy
    // (Coffee, Cocktails, Fruit, Lattes, Smoothie, Tea, Unique, plus three
    // combos). Each type owns the full per-type listing copy: titles for
    // single + packs in REG and SF, all 5 bullets for REG and SF, the
    // pump-suffix appended to the single title for the pump variant, the
    // extra BP6 that only ships with pump variants, and the shared
    // product description. This supersedes the older flavor_listing_examples
    // taxonomy keyed by (syrup_use × flavor_type × listing_type) — kept
    // intact for now so existing data isn't lost.
    `CREATE TABLE IF NOT EXISTS flavor_product_types (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      title_reg_single TEXT NOT NULL DEFAULT '',
      title_sf_single TEXT NOT NULL DEFAULT '',
      title_reg_packs TEXT NOT NULL DEFAULT '',
      title_sf_packs TEXT NOT NULL DEFAULT '',
      pump_title_suffix TEXT NOT NULL DEFAULT 'With Pump',
      bullets_reg_json TEXT NOT NULL DEFAULT '[]',
      bullets_sf_json TEXT NOT NULL DEFAULT '[]',
      bullet_pump_extra TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_flavor_product_types_position ON flavor_product_types (position)`,
    // Per-flavor approved listing content. One row per (flavor, variant).
    // Variants: 'single', 'single_with_pump', '4_pack', '6_pack'. Generated
    // lazily on first preview by substituting the flavor's data into the
    // picked product type's template; then the user edits inline and
    // approves. Tickets spawn from this table, not from the template.
    `CREATE TABLE IF NOT EXISTS flavor_listing_content (
      id SERIAL PRIMARY KEY,
      flavor_id INTEGER NOT NULL REFERENCES flavors_v2(id) ON DELETE CASCADE,
      listing_variant TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      bullets_json TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      approved INTEGER NOT NULL DEFAULT 0,
      generated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_content_unique
       ON flavor_listing_content (flavor_id, listing_variant)`,
    // Variation listings — parent listings on Amazon / Walmart / Custom that
    // each new flavor gets added to as a child variant once inventory
    // arrives. Filters say which flavors apply: flavor_type_filter narrows
    // to regular / sugar_free / any, listing_type_filter narrows to a
    // specific pack/pump variant or any. external_id holds the parent
    // ASIN / SKU / URL the worker needs in NineYard or the marketplace UI.
    `CREATE TABLE IF NOT EXISTS flavor_variation_listings (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER REFERENCES flavor_channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      flavor_type_filter TEXT NOT NULL DEFAULT 'any',
      listing_type_filter TEXT NOT NULL DEFAULT 'any',
      external_id TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_variation_listings_channel
       ON flavor_variation_listings (channel_id, position)`,
    // Per-(channel × listing_type × fulfillment) SKU template. Supersedes
    // the single `flavor_channels.sku_pattern` column — the user's real
    // convention varies by listing type within a channel (Amazon Main =
    // `-NP`, with-pump = `-WP`, 6-case = `-1Case`, etc.), so one channel-
    // wide template can't express it. Sparse matrix is fine: if there's
    // no row for a combo, the generator just doesn't emit that SKU.
    `CREATE TABLE IF NOT EXISTS flavor_channel_sku_patterns (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES flavor_channels(id) ON DELETE CASCADE,
      listing_type TEXT NOT NULL,
      fulfillment TEXT NOT NULL DEFAULT '',
      template TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_sku_patterns_unique
       ON flavor_channel_sku_patterns (channel_id, listing_type, fulfillment)`,
    // Per-(channel × listing_type × fulfillment) price. Used by the channel-
    // launch ticket descriptions so the worker sees the exact price to enter
    // in Seller Central / WFS without consulting a separate doc. Same sparse-
    // matrix shape as flavor_channel_sku_patterns — missing combo just means
    // no price rule yet (worker will see "(no price rule set)" in the ticket).
    // price is text so it can hold currency-formatted values exactly as the
    // user wants them rendered (e.g. "12.99"); validation is "looks like a
    // positive decimal with up to 2 places".
    `CREATE TABLE IF NOT EXISTS flavor_channel_price_rules (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES flavor_channels(id) ON DELETE CASCADE,
      flavor_type TEXT NOT NULL DEFAULT 'any',
      listing_type TEXT NOT NULL,
      fulfillment TEXT NOT NULL DEFAULT '',
      price TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_price_rules_unique_v2
       ON flavor_channel_price_rules (channel_id, flavor_type, listing_type, fulfillment)`,
    // Per-channel listing defaults (Brand, Manufacturer, Item Type Keyword,
    // Country of Origin, etc.). Used by the per-channel flat-file exports
    // (currently just Amazon) so the same Brand/Manufacturer values flow
    // into every flavor row without having to retype them.
    `CREATE TABLE IF NOT EXISTS flavor_channel_defaults (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES flavor_channels(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_defaults_unique
       ON flavor_channel_defaults (channel_id, key)`,
    // Channel SKUs — generated from the per-channel sku_pattern by
    // /api/flavors2/:id/generate-channel-skus. One row per
    // (flavor × channel × listing_type × fulfillment). nineyard_sku is
    // the base SKU on the flavor that this channel SKU maps back to in
    // the POS system; filled at the same time we generate so the SKU
    // mapping ticket can just list both sides for the worker.
    `CREATE TABLE IF NOT EXISTS flavor_channel_skus (
      id SERIAL PRIMARY KEY,
      flavor_id INTEGER NOT NULL REFERENCES flavors_v2(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES flavor_channels(id) ON DELETE CASCADE,
      listing_type TEXT NOT NULL,
      fulfillment TEXT NOT NULL DEFAULT '',
      channel_sku TEXT NOT NULL,
      nineyard_sku TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_skus_unique
      ON flavor_channel_skus (flavor_id, channel_id, listing_type, fulfillment)`,
    `CREATE INDEX IF NOT EXISTS idx_channel_skus_flavor
      ON flavor_channel_skus (flavor_id)`,
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
    // ── Apps (design-to-dev handoff for Claude-built apps) ───────────────
    // Tracks an app project from design (HTML files pasted/uploaded by the
    // designer) through dev handoff (manager + developer review each page,
    // ask questions in a per-page Q&A thread, and tick off a functionality
    // checklist before going live). Access is restricted to the three
    // assignees + creator + admins — page-level Q&A intentionally lives
    // outside the main ticket system so design noise doesn't drown work.
    `CREATE TABLE IF NOT EXISTS apps (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'design',
      cover_color TEXT NOT NULL DEFAULT '#3b82f6',
      designer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      developer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      repo_url TEXT NOT NULL DEFAULT '',
      deploy_url TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_apps_created_by ON apps (created_by)`,
    `CREATE INDEX IF NOT EXISTS idx_apps_designer ON apps (designer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_apps_manager ON apps (manager_id)`,
    `CREATE INDEX IF NOT EXISTS idx_apps_developer ON apps (developer_id)`,
    // One row per HTML page of an app. html_content is the full HTML body
    // pasted or uploaded by the designer — served back via a sandboxed
    // /preview endpoint so the developer can see the design without
    // navigating away. blueprint is the human-written (optionally
    // AI-assisted) one-paragraph description of what the page does.
    `CREATE TABLE IF NOT EXISTS app_pages (
      id SERIAL PRIMARY KEY,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      html_content TEXT NOT NULL DEFAULT '',
      blueprint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_pages_app ON app_pages (app_id, position)`,
    // Per-page Q&A thread. Anyone with access to the app (designer, manager,
    // developer, creator, admin) can post; threading via parent_id mirrors
    // ticket_comments. resolved flips when a thread is acknowledged.
    `CREATE TABLE IF NOT EXISTS app_page_comments (
      id SERIAL PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES app_pages(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES app_page_comments(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_page_comments_page ON app_page_comments (page_id, id)`,
    // Per-page function checklist. Developer (or designer) lists each piece
    // of behaviour that needs to work on the live page, and ticks status as
    // they verify. Drives the "ready to ship" signal on the app row.
    `CREATE TABLE IF NOT EXISTS app_page_functions (
      id SERIAL PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES app_pages(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_page_functions_page ON app_page_functions (page_id, position)`,
    // Pin annotations dropped directly on the page preview. x_pct / y_pct
    // are 0-100 % of the iframe's rendered size so pins survive resize.
    // type narrows the icon + colour: question (blue), issue (amber),
    // broken (red), note (grey). status flips when the thread is resolved.
    `CREATE TABLE IF NOT EXISTS app_page_annotations (
      id SERIAL PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES app_pages(id) ON DELETE CASCADE,
      x_pct REAL NOT NULL DEFAULT 0,
      y_pct REAL NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'question',
      text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_page_annotations_page ON app_page_annotations (page_id, id)`,
    // Manager-authored todos that the developer ticks off. Distinct from
    // app_page_functions (which tracks behaviour status with a 4-state
    // chip); this is a plain checkbox list of "things to do on this page".
    `CREATE TABLE IF NOT EXISTS app_page_todos (
      id SERIAL PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES app_pages(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      done_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      done_at TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_page_todos_page ON app_page_todos (page_id, position)`,
  ];

  for (const sql of tables) {
    await pool.query(sql);
  }

  // Freeform pen-drawing layer on top of a space — JSON array of stroke
  // objects ({color,width,points:[[x,y],…]}). Added via safeAlter so it
  // lands cleanly on existing installs without re-creating the spaces table.
  await safeAlter("ALTER TABLE spaces ADD COLUMN whiteboard_strokes TEXT DEFAULT '[]'");

  // Apps: cached Bengali translation of the blueprint. Cleared on every
  // English edit so the cache never drifts from the source. Added via
  // safeAlter so existing installs pick it up without recreating the table.
  await safeAlter("ALTER TABLE app_pages ADD COLUMN blueprint_bn TEXT DEFAULT ''");

  // Apps: attachments parent for pin annotations. Lets the attachments
  // table carry the same {filename, mime_type, uploader} payload as
  // ticket / feedback attachments and reuse the /uploads static route.
  await safeAlter('ALTER TABLE attachments ADD COLUMN annotation_id INTEGER');

  // Apps: per-app ticket system, separate from the global /api/tickets so
  // app-development chatter stays out of the main work queue. Each ticket
  // belongs to one app, has a status flow (open → in_progress → resolved
  // → closed) and a comment thread modelled on ticket_comments.
  await pool.query(`CREATE TABLE IF NOT EXISTS app_tickets (
    id SERIAL PRIMARY KEY,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    page_id INTEGER REFERENCES app_pages(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_at TEXT,
    created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
    updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_tickets_app ON app_tickets (app_id, id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_tickets_status ON app_tickets (app_id, status)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_ticket_comments (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES app_tickets(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'comment',
    created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_ticket_comments_ticket ON app_ticket_comments (ticket_id, id)`);

  // Per-app multi-developer roster. The legacy `apps.developer_id` column
  // is one slot for the "primary" developer; this table lets the app
  // owner add any number of teammates as developers so they can see the
  // app when they log in and collaborate on it. Each row is one user
  // assignment; UNIQUE prevents the same user being added twice.
  await pool.query(`CREATE TABLE IF NOT EXISTS app_developers (
    id SERIAL PRIMARY KEY,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
    UNIQUE (app_id, user_id)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_developers_app  ON app_developers (app_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_developers_user ON app_developers (user_id)`);

  // Recurring Tasks: a schedule + a list of ticket templates. When the
  // hourly cron sees `next_run_date <= today`, it materializes every
  // template as a real workspace ticket and advances the schedule.
  //
  //   recur_type:
  //     'monthly_same'   – every month on start_date's day-of-month
  //     'monthly_day'    – every month on `recur_day` (1-31)
  //     'weekly'         – once a week on `recur_weekday` (0=Sun..6=Sat)
  //     'every_n_days'   – every `recur_interval` days from start_date
  await pool.query(`CREATE TABLE IF NOT EXISTS recurring_tasks (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL DEFAULT '',
    recur_type TEXT NOT NULL DEFAULT 'monthly_same',
    recur_day INTEGER,
    recur_weekday INTEGER,
    recur_interval INTEGER,
    next_run_date TEXT NOT NULL DEFAULT '',
    last_run_date TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
    updated_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recurring_tasks_due ON recurring_tasks (active, next_run_date)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS recurring_task_items (
    id SERIAL PRIMARY KEY,
    recurring_task_id INTEGER NOT NULL REFERENCES recurring_tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    assignee TEXT NOT NULL DEFAULT '',
    assignees_json TEXT NOT NULL DEFAULT '[]',
    reporter TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'Medium',
    dept TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    checklist_json TEXT NOT NULL DEFAULT '[]',
    due_offset_days INTEGER NOT NULL DEFAULT 7,
    created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recurring_task_items_parent ON recurring_task_items (recurring_task_id, position)`);
  // Existing installs predate the full-ticket fields — backfill via safeAlter.
  await safeAlter("ALTER TABLE recurring_task_items ADD COLUMN assignees_json TEXT NOT NULL DEFAULT '[]'");
  await safeAlter("ALTER TABLE recurring_task_items ADD COLUMN reporter TEXT NOT NULL DEFAULT ''");
  await safeAlter("ALTER TABLE recurring_task_items ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  await safeAlter("ALTER TABLE recurring_task_items ADD COLUMN checklist_json TEXT NOT NULL DEFAULT '[]'");
  await safeAlter("ALTER TABLE recurring_task_items ADD COLUMN due_offset_days INTEGER NOT NULL DEFAULT 7");

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
  // Flavors v2 — every ticket spawned by the flavor-launch pipeline carries
  // the parent flavor id so the bottle viz on the flavor detail page can
  // tally open/closed tickets without a join through the title. flavor_v2_name
  // is denormalised so the ticket-detail chip can render without joining
  // back to flavors_v2 on every ticket fetch.
  await safeAlter("ALTER TABLE tickets ADD COLUMN flavor_v2_id INTEGER DEFAULT NULL");
  await safeAlter("ALTER TABLE tickets ADD COLUMN flavor_v2_step TEXT DEFAULT NULL");
  await safeAlter("ALTER TABLE tickets ADD COLUMN flavor_v2_name TEXT DEFAULT NULL");
  // Per-channel SKU naming pattern. Placeholders are substituted in
  // routes/flavors.js's generateChannelSku() — defaults to a sensible
  // convention; admins override per channel from Flavors → Settings.
  await safeAlter("ALTER TABLE flavor_channels ADD COLUMN sku_pattern TEXT DEFAULT '{sku}-{channel}-{listing}{-fulfillment}'");
  // Price rules expanded from (channel × listing × fulfillment) to also
  // include flavor_type — regular and sugar-free flavors usually carry
  // different retail prices for the same listing shape on the same channel.
  // Drop the older index and let the v2 index (in the schema array) take
  // over for any DB that was already initialized before flavor_type existed.
  await safeAlter("ALTER TABLE flavor_channel_price_rules ADD COLUMN flavor_type TEXT NOT NULL DEFAULT 'any'");
  await safeAlter("DROP INDEX IF EXISTS idx_channel_price_rules_unique");
  // Raw-paste mode for listing examples. When is_raw_example=1, the
  // editor stores the user's literal pasted text (no {placeholder} syntax)
  // and source_flavor_id points at the flavor it was originally written
  // for. The generator does name / syrup-color / type-label swaps from
  // source-flavor data into target-flavor data at substitution time.
  await safeAlter("ALTER TABLE flavor_listing_examples ADD COLUMN is_raw_example INTEGER DEFAULT 0");
  await safeAlter("ALTER TABLE flavor_listing_examples ADD COLUMN source_flavor_id INTEGER DEFAULT NULL");
  await safeAlter("ALTER TABLE users ADD COLUMN last_overdue_digest_at TEXT DEFAULT ''");
  // Cached Slack user id (looked up via users.lookupByEmail the first time
  // we want to DM this user). Empty string = "not yet looked up";
  // 'NOTFOUND' sentinel = "Slack workspace has no user with this email,
  // don't keep retrying". Populated lazily by slackDmUser in server.js.
  await safeAlter("ALTER TABLE users ADD COLUMN slack_user_id TEXT DEFAULT ''");

  // Calendar sync (ICS feed) — each user gets a private token that's the
  // sole credential on the public /api/calendar/feed/:token.ics endpoint
  // they hand to Google Calendar / Apple Calendar / Outlook. Lazily
  // generated on first request and regeneratable from the UI. The
  // _sources_json column holds a JSON object like
  // {"events":true,"tickets":true,"reminders":false,"recurring":false}
  // so each user picks what their external calendar sees.
  await safeAlter("ALTER TABLE users ADD COLUMN gcal_feed_token TEXT DEFAULT ''");
  await safeAlter("ALTER TABLE users ADD COLUMN gcal_feed_sources_json TEXT DEFAULT '{\"meetings\":true,\"tasks\":true,\"deadlines\":true,\"tickets\":true,\"reminders\":false,\"recurring\":false}'");
  // Updated every time Google (or any other external calendar app)
  // actually pulls the .ics feed. Lets the UI show "last picked up by
  // Google: 3h ago" so users understand the polling cadence and don't
  // think their button click triggered a sync that actually didn't.
  await safeAlter("ALTER TABLE users ADD COLUMN gcal_feed_last_fetched_at TEXT DEFAULT ''");
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

  // Snooze: temporarily hide a ticket from the main list (capped at 7
  // days). snoozed_until is the UTC wake-up time; null = not snoozed.
  // snoozed_by/at let us show "who snoozed and when" + notify the
  // requester when the snooze starts. A snooze is "active" when
  // snoozed_until > NOW(); past that the ticket naturally returns to
  // the list (no cron needed — filtering is lazy on read).
  await safeAlter("ALTER TABLE tickets ADD COLUMN snoozed_until TEXT DEFAULT NULL");
  await safeAlter("ALTER TABLE tickets ADD COLUMN snoozed_by INTEGER DEFAULT NULL");
  await safeAlter("ALTER TABLE tickets ADD COLUMN snoozed_at TEXT DEFAULT NULL");
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_snoozed_until ON tickets (snoozed_until)');

  // Ticket watchers: users who get read access + the ongoing comment
  // fan-out on a ticket they aren't otherwise on. Today this is populated
  // when someone @-mentions them in a comment — the mention is no longer
  // a dead-end notification, it implicitly subscribes the user. Same
  // pattern GitHub / Linear / Jira use. `source` records how they got
  // added so we could surface this in a "Why am I seeing this?" UI later.
  await run(
    `CREATE TABLE IF NOT EXISTS ticket_watchers (
       ticket_id TEXT NOT NULL,
       user_id INTEGER NOT NULL,
       source TEXT DEFAULT 'mention',
       added_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
       PRIMARY KEY (ticket_id, user_id)
     )`
  );
  await run('CREATE INDEX IF NOT EXISTS idx_ticket_watchers_user ON ticket_watchers (user_id)');

  // Per-user API tokens for the Gmail-add-on (and any future integration
  // that needs to authenticate as a specific user without the session
  // cookie). We store a SHA-256 hash of the token, never the raw value;
  // a short prefix is kept for the UI so users can identify which token
  // is which. Tokens grant the same access level as the owning user.
  await run(
    `CREATE TABLE IF NOT EXISTS user_api_tokens (
       id SERIAL PRIMARY KEY,
       user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
       token_hash TEXT NOT NULL UNIQUE,
       token_prefix TEXT NOT NULL,
       name TEXT DEFAULT '',
       source TEXT DEFAULT '',
       created_at TEXT DEFAULT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
       last_used_at TEXT DEFAULT NULL
     )`
  );
  await run('CREATE INDEX IF NOT EXISTS idx_user_api_tokens_hash ON user_api_tokens (token_hash)');

  // Provenance: when a ticket originated from a Gmail message via the
  // add-on, we stamp the Gmail message id here so a duplicate submission
  // (e.g. user clicks "Create Ticket" twice) returns the existing ticket
  // instead of spawning another. Null for tickets created any other way.
  await safeAlter('ALTER TABLE tickets ADD COLUMN source_email_id TEXT DEFAULT NULL');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_source_email ON tickets (source_email_id)');
  // Direct URL back to the source email (msg.getThread().getPermalink()).
  // Surfaced as an "Open email" link on the ticket detail header so the
  // user can jump straight to the original conversation in Gmail.
  await safeAlter('ALTER TABLE tickets ADD COLUMN source_email_url TEXT DEFAULT NULL');
  // Personal reminders that originated from a Gmail message get the same
  // pair of columns so the "📧 Open email" pill on the reminder card
  // works the same way.
  await safeAlter('ALTER TABLE personal_reminders ADD COLUMN source_email_id TEXT DEFAULT NULL');
  await safeAlter('ALTER TABLE personal_reminders ADD COLUMN source_email_url TEXT DEFAULT NULL');

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

  // Seed default flavor-launch v2 sales channels. Idempotent — only fires
  // when the channels table is empty. The user can rename, disable, or add
  // channels from Flavors → Settings.
  const channelRows = await get('SELECT COUNT(*) AS n FROM flavor_channels');
  if (!channelRows || Number(channelRows.n) === 0) {
    const seedChannels = [
      { name: 'Amazon',  code: 'amazon',  has_fba: 1, position: 1 },
      { name: 'Walmart', code: 'walmart', has_fba: 0, position: 2 },
      { name: 'Custom',  code: 'custom',  has_fba: 0, position: 3 },
    ];
    for (const c of seedChannels) {
      await run(
        'INSERT INTO flavor_channels (name, code, has_fba, enabled, position) VALUES (?,?,?,1,?)',
        c.name, c.code, c.has_fba, c.position
      );
    }
  }

  // Add Canada idempotently (not part of the original 3-channel seed but
  // added later from the user's real convention). Only inserts if missing.
  const canadaExists = await get("SELECT id FROM flavor_channels WHERE code='canada'");
  if (!canadaExists) {
    const maxPos = await get('SELECT MAX(position) AS p FROM flavor_channels');
    await run(
      'INSERT INTO flavor_channels (name, code, has_fba, enabled, position) VALUES (?,?,1,1,?)',
      'Canada', 'canada', Number(maxPos?.p || 0) + 1
    );
  }

  // Seed channel SKU patterns from the user's real convention. Per channel,
  // only seeds when no patterns exist for that channel yet — so a user can
  // delete + replace any subset without re-seeding overwriting their work.
  async function seedPatternsIfMissing(channelCode, rows) {
    const ch = await get('SELECT id FROM flavor_channels WHERE code=?', channelCode);
    if (!ch) return;
    const existing = await get(
      'SELECT COUNT(*) AS n FROM flavor_channel_sku_patterns WHERE channel_id=?',
      ch.id
    );
    if (Number(existing?.n || 0) > 0) return;
    let pos = 0;
    for (const r of rows) {
      pos++;
      await run(
        `INSERT INTO flavor_channel_sku_patterns
           (channel_id, listing_type, fulfillment, template, position)
         VALUES (?,?,?,?,?)
         ON CONFLICT (channel_id, listing_type, fulfillment) DO NOTHING`,
        ch.id, r.listing_type, r.fulfillment, r.template, pos
      );
    }
  }
  await seedPatternsIfMissing('amazon', [
    { listing_type: 'single',           fulfillment: 'fba', template: 'F-(SKU)-NP-UPC' },
    { listing_type: 'single',           fulfillment: 'fbm', template: 'F-(SKU)-NP' },
    { listing_type: 'single_with_pump', fulfillment: 'fba', template: 'F-(SKU)-WP-FBA' },
    { listing_type: 'single_with_pump', fulfillment: 'fbm', template: 'F-(SKU)-WP' },
    { listing_type: '4_pack',           fulfillment: 'fba', template: 'F-(SKU)-Case-4-FBA' },
    { listing_type: '4_pack',           fulfillment: 'fbm', template: 'F-(SKU)-Case-4' },
    { listing_type: '6_pack',           fulfillment: 'fba', template: 'F-(SKU)-1Case-FBA' },
    { listing_type: '6_pack',           fulfillment: 'fbm', template: 'F-(SKU)-1Case' },
  ]);
  await seedPatternsIfMissing('walmart', [
    { listing_type: 'single',           fulfillment: 'wfs', template: 'W-SY-Mix-(SKU)' },
    { listing_type: 'single_with_pump', fulfillment: 'wfs', template: 'W-(SKU)-WP' },
    { listing_type: '6_pack',           fulfillment: 'fbm', template: 'W-(SKU)-1Case' },
  ]);
  await seedPatternsIfMissing('canada', [
    { listing_type: 'single',           fulfillment: 'fba', template: 'CF-(SKU)-A' },
  ]);

  // Seed the user's curated 10-category product-type taxonomy from the
  // title.xlsx they shared. Only fires when the table is empty — once they
  // edit any row, never re-seed.
  //
  // The strings preserve their original notation:
  //   ---           → placeholder for flavor name (rendered as {name} later)
  //   ...-Pack      → placeholder for pack size (4-Pack / 6-Pack)
  //   (Naturally Flavored) / (Natural Flavors,) → kept verbatim; the
  //                   product-types editor lets admins strip parens for
  //                   natural+artificial flavors if their voice differs
  //   AI Flavor Description … → marker for the AI-generated sensory
  //                   description bullet 1 will become once Claude is wired
  //                   in build B. For now it ships as static text.
  const productTypeRows = await get('SELECT COUNT(*) AS n FROM flavor_product_types');
  if (!productTypeRows || Number(productTypeRows.n) === 0) {
    const PACKS_REG = " ----- Syrup by Syruvia ...-Pack, 25.4 fl oz, (Natural Flavors,) Wholesale Coffee Syrup Shops, Cafes, Baristas, Bistros, & Beverage Bars, Bulk Kosher & Gluten-Free";
    const PACKS_SF  = "Sugar-Free ----- Syrup by Syruvia ...-Pack, 25.4 fl oz, (Natural Flavors,) Wholesale Coffee Syrup Shops, Cafes, Baristas, Bistros, & Beverage Bars, Bulk Kosher & Gluten-Free";
    const PUMP_BP = "Convenient & Ready to Use: Each bottle includes a pump for mess-free, precise pouring—making it easy to add the perfect amount of syrup to every drink.";
    const DESCRIPTION = "Introducing Syruvia, a trusted supplier of a wide selection of high-quality syrups & concentrates, where you can find the most tantalizing flavors to sweeten your everyday life! We are employing only carefully selected ingredients with no additives or harsh fillers to create clean and delicious syrups that offer a unique sense-pampering experience! We strive for greatness in every aspect of our business, from the richest syrup flavors to the unwavering commitment to exceptional quality, to offer you the finest selection of aromas. Delight Your Taste Buds with the Syruvia Syrups!  Made in the USA with pure and clean ingredients, the Syruvia Syrups  have a fresh taste and amazing flavor that enriches your drink without overpowering its unparalleled taste! Subtle yet rich, the syrups are perfect for coffee, latte, tea, smoothies, shakes or desserts, adding a creamy texture and unique sweetness that will take your taste buds by surprise! Still not convinced? Here are some of the amazing features of our syrups: 1. 25.4 fl oz bottle; 2. Made with high-quality, clean ingredients; 3. Kosher-certified; 4. Made in the USA; 5. Large selection of flavors for all tastes; 6. Ideal for coffee, tea, latte, smoothie, protein shakes, oatmeal, breakfast, desserts, ice cream topping, frappe, cocktails, baked goods and more; 7. Smooth and subtle aroma; 8. Creamy texture and rich taste; 9. 25 servings per bottle; Indulge in the exceptional aromas of our syrups!";
    const QUALITY_BP = "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,";

    // Shared bullet 2 + 3 + 4 for the single-product types pull from the
    // type-specific copy on the worksheet. Combos reuse the generic
    // "Add Flavor to Every Drink / Endless Possibilities / Quality" set.
    const COFFEE_BP1_REG = `----(Naturally Flavored) Coffee Syrup AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`;
    const COFFEE_BP1_SF  = ` Sugar free ----(Naturally Flavored) Coffee Syrup AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`;
    const GENERIC_BP1_REG = `----(Naturally Flavored) Syrup AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`;
    const GENERIC_BP1_SF  = ` Sugar free ----(Naturally Flavored) Syrup AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`;

    const TYPES = [
      {
        key: 'coffee', name: 'Coffee', position: 1,
        title_reg_single: "Syruvia Coffee Syrup, --- Flavored Syrup for Drinks, Lattes, and Desserts (Natural Flavors) – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free Coffee Syrup, ---- Flavored Syrup for Drinks, Lattes, and Desserts (Natural Flavors) – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          COFFEE_BP1_REG,
          "Add Flavor to Your Coffee: Awaken your senses and indulge in the delightful taste of coffee crafted to your liking with Syruvia coffee syrup! Our syrups bring rich flavor, inviting aroma, and a sweet note that brightens your senses every morning!",
          "Endless Coffee Possibilities: Thanks to its rich aroma and delightful taste, our coffee syrup can be added to a wide range of drinks, including shakes, lattes, cappuccinos, iced coffees, protein shakes, and more!",
          "Quality You Can Trust: Syruvia coffee syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our coffee syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: Our Coffee syrup adds creamy flavor and rich sweetness to your coffee, lattes, cappuccinos, and espresso drinks for a smooth café-style experience! Made with pure cane sugar, it enhances every cup with balanced sweetness.",
        ],
        bullets_sf: [
          COFFEE_BP1_SF,
          "Add Flavor to Your Coffee: Awaken your senses and indulge in the delightful taste of coffee crafted to your liking with Syruvia coffee syrup! Our syrups bring rich flavor, inviting aroma, and a sweet note that brightens your senses every morning!",
          "Endless Coffee Possibilities: Thanks to its rich aroma and delightful taste, our coffee syrup can be added to a wide range of drinks, including shakes, lattes, cappuccinos, iced coffees, protein shakes, and more!",
          "Quality You Can Trust: Syruvia coffee syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our coffee syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar free coffee syrup is a great way to enjoy creamy café-style drinks with zero calories and carbs! it adds smooth sweetness to lattes and espresso drinks without the added sugar.",
        ],
      },
      {
        key: 'cocktails', name: 'Cocktails', position: 2,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Cocktails, Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Cocktails, Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          `----(Naturally Flavored) Syrup for Cocktails AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Add Flavor to Your Cocktails: Awaken your senses and indulge in the vibrant taste of drinks crafted your way with Syruvia syrup! Our syrups bring bold flavor, smooth aroma, and a sweet touch that makes every sip more exciting!",
          "Endless Cocktail Creations: Thanks to its vibrant aroma and delightful taste, our syrup can be added to a variety of cocktails, mocktails, frozen drinks, and specialty beverages for a flavorful twist in every sip!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring)  to deliver excellent freshness and rich flavor in every pour! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: Our syrup adds smooth flavor, vibrant sweetness, and a delicious twist to cocktails, mocktails, and specialty drinks! Made with pure cane sugar, it brings balanced sweetness to every sip.",
        ],
        bullets_sf: [
          `Sugar free ----(Naturally Flavored) Syrup for Cocktails AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Add Flavor to Your Cocktails: Awaken your senses and indulge in the vibrant taste of drinks crafted your way with Syruvia syrup! Our syrups bring bold flavor, smooth aroma, and a sweet touch that makes every sip more exciting!",
          "Endless Cocktail Creations: Thanks to its vibrant aroma and delightful taste, our syrup can be added to a variety of cocktails, mocktails, frozen drinks, and specialty beverages for a flavorful twist in every sip!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every pour! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar free syrup is a great way to enjoy flavorful cocktails, mocktails, and specialty drinks with zero calories and carbs! it adds delicious sweetness without the added sugar.",
        ],
      },
      {
        key: 'fruit', name: 'Fruit', position: 3,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          GENERIC_BP1_REG,
          "Add a Burst of Fruit Flavor: Awaken your senses and enjoy refreshing drinks made your way with Syruvia syrup! Our syrups bring vibrant flavor, fruity aroma, and a sweet touch that brightens every sip!",
          "Endless Fruity Possibilities: Thanks to its vibrant aroma and refreshing taste, our syrup can be added to lemonades, smoothies, fruit drinks, teas, frozen beverages, and more for a burst of fruity flavor!",
          "Quality You Can Trust: Syruvia fruit syrups are made in the USA with high-quality ingredients (and no artificial coloring)  to deliver excellent freshness and vibrant flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: Our fruit syrup adds vibrant flavor and refreshing sweetness to lemonades, teas, smoothies, and fruity drinks! Made with pure cane sugar, it delivers a bright and delicious taste in every sip.",
        ],
        bullets_sf: [
          GENERIC_BP1_SF,
          "Add a Burst of Fruit Flavor: Awaken your senses and enjoy refreshing drinks made your way with Syruvia syrup! Our syrups bring vibrant flavor, fruity aroma, and a sweet touch that brightens every sip!",
          "Endless Fruity Possibilities: Thanks to its vibrant aroma and refreshing taste, our syrup can be added to lemonades, smoothies, fruit drinks, teas, frozen beverages, and more for a burst of fruity flavor!",
          "Quality You Can Trust: Syruvia fruit syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and vibrant flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar free fruit syrup is a refreshing way to enjoy fruity drinks, lemonades, teas, smoothies, with zero calories and carbs! it adds vibrant sweetness to lemonades, teas, and beverages without the added sugar.",
        ],
      },
      {
        key: 'lattes', name: 'Lattes', position: 4,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Lattes, Drinks, Cappuccinos, Iced coffees, Espresso Drinks, – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Lattes, Drinks, Cappuccinos, Iced coffees, Espresso Drinks, – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          `----(Naturally Flavored) Syrup  for Lattes  AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Elevate Your Latte Experience: Awaken your senses and indulge in smooth, café-style lattes crafted your way with Syruvia syrup! Our syrups bring creamy flavor, inviting aroma, and a sweet touch to every cup!",
          "Endless Latte Possibilities: Thanks to its rich aroma and delightful taste, our syrup can be added to lattes, cappuccinos, iced coffees, espresso drinks, and café-style creations for a smooth and flavorful experience!",
          "Quality You Can Trust: Syruvia latte syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich café-style flavor in every cup! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: Our latte syrup adds creamy flavor and rich sweetness to lattes, cappuccinos, and espresso drinks for a smooth café-style experience! Made with pure cane sugar, it enhances every cup with balanced sweetness.",
        ],
        bullets_sf: [
          `Sugar free ----(Naturally Flavored) Syrup for Lattes AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Elevate Your Latte Experience: Awaken your senses and indulge in smooth, café-style lattes crafted your way with Syruvia syrup! Our syrups bring creamy flavor, inviting aroma, and a sweet touch to every cup!",
          "Endless Latte Possibilities: Thanks to its rich aroma and delightful taste, our syrup can be added to lattes, cappuccinos, iced coffees, espresso drinks, and café-style creations for a smooth and flavorful experience!",
          "Quality You Can Trust: Syruvia latte syrups are made in the USA with high-quality ingredients (and no artificial coloring)  to deliver excellent freshness and rich café-style flavor in every cup! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar free latte syrup is a great way to enjoy creamy café-style drinks with zero calories and carbs! it adds smooth sweetness to lattes and espresso drinks without the added sugar.",
        ],
      },
      {
        key: 'smoothie', name: 'Smoothie', position: 5,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Smoothies, Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Smoothies, Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          `----(Naturally Flavored) Syrup for Smoothies AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Blend More Flavor into Every Smoothie: Awaken your senses and enjoy refreshing smoothies crafted your way with Syruvia syrup! Our syrups bring vibrant flavor, fruity aroma, and a sweet touch to every blend!",
          "Endless Smoothie Possibilities: Thanks to its vibrant aroma and delightful taste, our syrup can be blended into smoothies, shakes, frozen drinks, protein shakes, and fruity creations for extra flavor in every sip!",
          "Quality You Can Trust: Syruvia smoothie syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and vibrant flavor in every blend! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: Our smoothie syrup adds vibrant flavor and rich sweetness to smoothies, shakes, and frozen drinks for a refreshing taste in every blend! Made with pure cane sugar, it delivers delicious sweetness with every sip.",
        ],
        bullets_sf: [
          `Sugar free ----(Naturally Flavored) Syrup for Smoothies Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Blend More Flavor into Every Smoothie: Awaken your senses and enjoy refreshing smoothies crafted your way with Syruvia syrup! Our syrups bring vibrant flavor, fruity aroma, and a sweet touch to every blend!",
          "Endless Smoothie Possibilities: Thanks to its vibrant aroma and delightful taste, our syrup can be blended into smoothies, shakes, frozen drinks, protein shakes, and fruity creations for extra flavor in every sip!",
          "Quality You Can Trust: Syruvia smoothie syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and vibrant flavor in every blend! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar free smoothie syrup is a refreshing way to enjoy smoothies and shakes with zero calories and carbs! it adds delicious sweetness to every blend without the added sugar.",
        ],
      },
      {
        key: 'tea', name: 'Tea', position: 6,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Teas, Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Teas, Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          `----(Naturally Flavored) Tea Syrup AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Add Flavor to Your Tea Moments: Awaken your senses and enjoy smooth tea-inspired drinks crafted your way with Syruvia syrup! Our syrups bring refreshing flavor, inviting aroma, and a sweet touch to every sip!",
          "Endless Tea Possibilities: Thanks to its smooth aroma and delightful taste, our syrup can be added to iced teas, milk teas, refreshers, fruit teas, and specialty tea-inspired drinks for a refreshing flavor boost!",
          "Quality You Can Trust: Syruvia tea syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and smooth flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: Our tea syrup adds smooth flavor and refreshing sweetness to teas, refreshers, and specialty drinks for a flavorful experience in every sip! Made with pure cane sugar, it brings balanced sweetness to your favorite tea-inspired beverages.",
        ],
        bullets_sf: [
          ` Sugar free ----(Naturally Flavored) Tea Syrup AI Flavor Description Paints a sensory picture of the flavor itself  what it tastes like, its texture,  and the mood or feeling it evokes"`,
          "Add Flavor to Your Tea Moments: Awaken your senses and enjoy smooth tea-inspired drinks crafted your way with Syruvia syrup! Our syrups bring refreshing flavor, inviting aroma, and a sweet touch to every sip!",
          "Endless Tea Possibilities: Thanks to its smooth aroma and delightful taste, our syrup can be added to iced teas, milk teas, refreshers, fruit teas, and specialty tea-inspired drinks for a refreshing flavor boost!",
          "Quality You Can Trust: Syruvia tea syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and smooth flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar free tea syrup is a refreshing way to enjoy tea-inspired drinks with zero calories and carbs! it adds smooth sweetness to teas and refreshers without the added sugar.",
        ],
      },
      {
        key: 'unique', name: 'Unique', position: 7,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Specialty Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Specialty Drinks, Lemonades, Iced Teas, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          GENERIC_BP1_REG,
          "Create Drinks Like No Other: Awaken your senses and explore bold, unique flavors crafted your way with Syruvia syrup! Our syrups bring exciting flavor, smooth aroma, and a creative touch to every sip!",
          "Endless Flavor Creations: Thanks to its bold aroma and delightful taste, our syrup can be added to creative drinks, specialty beverages, desserts, shakes, and more for a unique flavor experience!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and bold flavor in every creation! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: Our syrup adds bold flavor and rich sweetness to creative drinks and specialty creations for a unique taste experience! Made with pure cane sugar, it delivers smooth sweetness in every sip.",
        ],
        bullets_sf: [
          GENERIC_BP1_SF,
          "Create Drinks Like No Other: Awaken your senses and explore bold, unique flavors crafted your way with Syruvia syrup! Our syrups bring exciting flavor, smooth aroma, and a creative touch to every sip!",
          "Endless Flavor Creations: Thanks to its bold aroma and delightful taste, our syrup can be added to creative drinks, specialty beverages, desserts, shakes, and more for a unique flavor experience!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and bold flavor in every creation! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar free syrup is a flavorful way to enjoy creative drinks with zero calories and carbs! it adds delicious sweetness to specialty beverages without the added sugar.",
        ],
      },
      {
        key: 'coffee_cocktails', name: 'Coffee & Cocktails', position: 8,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Coffee, Cocktails, Drinks, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Coffee, Cocktails, Drinks, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          COFFEE_BP1_REG,
          "Add Flavor to Every Drink: Awaken your senses and enjoy delicious beverages crafted your way with Syruvia syrup! Our syrups bring smooth flavor, inviting aroma, and a sweet touch that makes every sip more enjoyable!",
          "Endless Possibilities: Thanks to its rich aroma and delightful taste, our syrup can be added to a wide range of drinks, including coffees, shakes, lattes, cappuccinos, iced coffees, protein shakes, and more!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: This versatile syrup adds smooth flavor and vibrant, balanced sweetness to every sip. Perfect for coffee, cocktails, mocktails, and specialty drinks, it delivers a rich, café-style taste and a delicious twist to all your favorite beverages.",
        ],
        bullets_sf: [
          COFFEE_BP1_SF,
          "Add Flavor to Every Drink: Awaken your senses and enjoy delicious beverages crafted your way with Syruvia syrup! Our syrups bring smooth flavor, inviting aroma, and a sweet touch that makes every sip more enjoyable!",
          "Endless Possibilities: Thanks to its rich aroma and delightful taste, our syrup can be added to a wide range of drinks, including coffees, shakes, lattes, cappuccinos, iced coffees, protein shakes, and more!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar-free syrup delivers rich flavor and delicious sweetness to coffee, cocktails, mocktails, and specialty drinks—without the sugar. it contains zero calories and zero carbs, so you can enjoy every sip guilt-free.",
        ],
      },
      {
        key: 'coffee_fruit', name: 'Coffee & Fruit', position: 9,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Coffee, Fruit Drinks, Lemonades, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Coffee, Fruit Drinks, Lemonades, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          GENERIC_BP1_REG,
          "Add Flavor to Every Drink: Awaken your senses and enjoy delicious beverages crafted your way with Syruvia syrup! Our syrups bring smooth flavor, inviting aroma, and a sweet touch that makes every sip more enjoyable!",
          "Endless Possibilities: Thanks to its vibrant aroma and refreshing taste, our syrup can be added to Coffees, lemonades, smoothies, fruit drinks, teas, frozen beverages, and more for a burst of fruity flavor!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: This versatile syrup adds smooth, balanced sweetness and vibrant flavor to coffee, lemonades, teas, smoothies, and fruity drinks. Crafted with pure cane sugar, it delivers a rich café-style taste for coffee and a bright, refreshing twist for fruit beverages in every sip.",
        ],
        bullets_sf: [
          GENERIC_BP1_SF,
          "Add Flavor to Every Drink: Awaken your senses and enjoy delicious beverages crafted your way with Syruvia syrup! Our syrups bring smooth flavor, inviting aroma, and a sweet touch that makes every sip more enjoyable!",
          "Endless Possibilities: Thanks to its vibrant aroma and refreshing taste, our syrup can be added to Coffees, lemonades, smoothies, fruit drinks, teas, frozen beverages, and more for a burst of fruity flavor!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar-free syrup brings rich flavor and vibrant sweetness to coffee, lemonades, teas, and fruity drinks—without the sugar. it contains zero calories and zero carbs so you can enjoy every beverage guilt-free.",
        ],
      },
      {
        key: 'cocktails_fruit', name: 'Cocktails & Fruit', position: 10,
        title_reg_single: "Syruvia --- Syrup, (Naturally) Flavored Syrup for Cocktails, Fruit Drinks, Lemonades, and Desserts – 25.4 fl oz",
        title_sf_single:  "Syruvia Sugar Free --- Syrup, (Naturally) Flavored Syrup for Cocktails, Fruit Drinks, Lemonades, and Desserts – 25.4 fl oz",
        title_reg_packs: PACKS_REG, title_sf_packs: PACKS_SF,
        bullets_reg: [
          GENERIC_BP1_REG,
          "Add Flavor to Every Drink: Awaken your senses and enjoy delicious beverages crafted your way with Syruvia syrup! Our syrups bring smooth flavor, inviting aroma, and a sweet touch that makes every sip more enjoyable!",
          "Endless Possibilities: Thanks to its vibrant aroma and refreshing taste, our syrup can be added to cocktails, mocktails, lemonades, smoothies, fruit drinks, teas, frozen beverages, and more for a burst of fruity flavor!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "Made with Pure Cane Sugar: This versatile syrup adds smooth, balanced sweetness and vibrant flavor to cocktails, mocktails, lemonades, teas, smoothies, and fruity drinks. Crafted with pure cane sugar, it delivers a rich café-style taste for coffee and a bright, refreshing twist for fruit beverages in every sip.",
        ],
        bullets_sf: [
          GENERIC_BP1_SF,
          "Add Flavor to Every Drink: Awaken your senses and enjoy delicious beverages crafted your way with Syruvia syrup! Our syrups bring smooth flavor, inviting aroma, and a sweet touch that makes every sip more enjoyable!",
          "Endless Possibilities: Thanks to its vibrant aroma and refreshing taste, our syrup can be added to cocktails, mocktails, lemonades, smoothies, fruit drinks, teas, frozen beverages, and more for a burst of fruity flavor!",
          "Quality You Can Trust: Syruvia syrups are made in the USA with high-quality ingredients (and no artificial coloring) to deliver excellent freshness and rich flavor in every sip! Our syrups are Kosher-certified, free from unnecessary fillers,",
          "A Diet-Friendly Choice: This sugar-free syrup brings rich flavor and vibrant sweetness to cocktails, mocktails, lemonades, teas, and fruity drinks—without the sugar. it contains zero calories and zero carbs so you can enjoy every beverage guilt-free.",
        ],
      },
    ];

    for (const t of TYPES) {
      await run(
        `INSERT INTO flavor_product_types
           (key, name, position, enabled,
            title_reg_single, title_sf_single, title_reg_packs, title_sf_packs,
            pump_title_suffix, bullets_reg_json, bullets_sf_json,
            bullet_pump_extra, description)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?)`,
        t.key, t.name, t.position,
        t.title_reg_single, t.title_sf_single, t.title_reg_packs, t.title_sf_packs,
        'With Pump',
        JSON.stringify(t.bullets_reg), JSON.stringify(t.bullets_sf),
        PUMP_BP, DESCRIPTION
      );
    }
  }

  // Seed a real Syruvia listing as the starter row in
  // flavor_listing_examples so the admin has something to clone + edit per
  // type combo instead of staring at an empty grid. Only fires when the
  // table is empty — once anything is in there, never re-seed (the user
  // may have deleted it intentionally or replaced it with their own).
  const exampleRows = await get('SELECT COUNT(*) AS n FROM flavor_listing_examples');
  if (!exampleRows || Number(exampleRows.n) === 0) {
    const seedTitle = 'Syruvia Coffee Syrup, {name} Flavored Syrup for Drinks, Lattes, and Desserts – 25.4 fl oz';
    const seedBullets = [
      "{name} Syrup: Embrace the timeless taste of {name} with Syruvia's {name} Syrup. Let its silky, velvety sweetness create a comforting ambiance in your favorite concoctions.",
      "Coffee Flavoring Syrup: Awaken your senses and indulge in the delightful taste of coffee flavored to your liking with the Syruvia coffee flavoring syrup! Our syrups bring savor, aroma and a sweet note that promises to pamper your senses every morning!",
      "Quality You Can Trust: The Syruvia syrups for coffee drinks are made in the USA with the highest quality, most refined ingredients to ensure excellent freshness and the richest taste! The coffee syrups are Kosher-certified, free of any unnecessary fillers, and contain no added coloring, providing you with a pure and natural coffee experience.",
      "Endless Possibilities: Thanks to its intense aroma and delightful taste, our coffee flavoring can be added to a wide range of beverages and desserts, including shakes, lattes, cappuccino, iced coffee, teas, smoothies, protein shakes, oatmeal, porridge and much more!",
      "Made with Pure Cane Sugar: The coffee sauce not only adds texture, creaminess and flavor to your coffee but also rich sweetness! Made with pure cane sugar, the coffee syrup will elevate your beverages with its incomparable sweetness!",
    ];
    const seedNotes =
      'Sample seeded from the existing Syruvia coffee single-bottle Amazon listing. ' +
      'Duplicate this row from the editor to clone it for different listing types ' +
      '(single+pump, 4-pack, 6-pack) and flavor types (natural, sugar-free).';
    await run(
      `INSERT INTO flavor_listing_examples
         (name, syrup_use, flavor_type, listing_type,
          title_template, bullets_json, description_template, keywords, notes,
          is_raw_example, source_flavor_id)
       VALUES (?,?,?,?,?,?,?,?,?,0,NULL)`,
      'Syruvia coffee — single bottle (sample)',
      'coffee',
      'natural_and_artificial',
      'single',
      seedTitle,
      JSON.stringify(seedBullets),
      '',
      '',
      seedNotes
    );
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

module.exports = { pool, init, get, all, run, safeAlter, withTx };