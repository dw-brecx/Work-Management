// ─────────────────────────────────────────────────────────────────────────────
// API Keys + external read API (/api/v1/*)
//
// Lets a user mint personal API keys so OTHER apps can pull ticket data out
// of Work-Management without a browser session. Two halves:
//
//   * Key management (session-authenticated, drives /api-keys.html):
//       GET    /api/api-keys        list my keys (never the secret itself)
//       POST   /api/api-keys        mint a key — plaintext returned ONCE
//       DELETE /api/api-keys/:id    revoke one of my keys
//
//   * External API (authenticated by `Authorization: Bearer wm_live_…`
//     or an `X-API-Key` header — no cookies, no CSRF surface):
//       GET /api/v1/tickets         compact list of tickets the key can see
//       GET /api/v1/tickets/:id     EVERYTHING about one ticket: the ticket
//                                   itself, description + checklist, comments
//                                   (with attachments), timeline, subtasks,
//                                   and file attachments
//
// Security model: only a SHA-256 hash of each key is stored; a key acts as
// its owner, so the external API reuses the exact same access gate
// (userCanAccessTicket) as the interactive app — an Admin's key sees every
// ticket, anyone else's key sees only tickets they're involved in. The
// external surface is read-only by design.
// ─────────────────────────────────────────────────────────────────────────────
const { randomBytes, createHash } = require('crypto');

module.exports = function attach(app, deps) {
  const {
    get, all, run, requireAuth, getUser, userCanAccessTicket,
    buildTicket, fetchTicketComments, fetchTicketSubtasks, formatUSDateTime,
  } = deps;

  const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

  // Attachment URLs in DB are origin-relative (/uploads/…). An external app
  // can't resolve those, so when APP_URL is configured we hand back absolute
  // links; otherwise the relative path is the best we can do.
  const absUrl = (u) => {
    const base = (process.env.APP_URL || '').replace(/\/+$/, '');
    return base && u && u.startsWith('/') ? base + u : u;
  };

  const serializeKey = (r) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || null,
    revokedAt: r.revoked_at || null,
  });

  // ── Key management (session auth) ─────────────────────────────────────────

  app.get('/api/api-keys', requireAuth, async (req, res) => {
    try {
      const rows = await all(
        'SELECT * FROM api_keys WHERE user_id=? AND revoked_at IS NULL ORDER BY id DESC',
        req.session.userId
      );
      res.json(rows.map(serializeKey));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/api-keys', requireAuth, async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'name required' });
      // Soft cap so a stuck client can't mint keys forever.
      const { n } = await get(
        'SELECT COUNT(*)::int AS n FROM api_keys WHERE user_id=? AND revoked_at IS NULL',
        req.session.userId
      ) || { n: 0 };
      if (n >= 20) return res.status(400).json({ error: 'Key limit reached (20). Revoke an unused key first.' });

      const token = 'wm_live_' + randomBytes(24).toString('hex'); // 192 bits of entropy
      const prefix = token.slice(0, 15) + '…';                    // enough to recognise, useless to guess
      const info = await run(
        'INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?,?,?,?) RETURNING id',
        req.session.userId, name, prefix, sha256(token)
      );
      const row = await get('SELECT * FROM api_keys WHERE id=?', info.lastInsertRowid);
      // `key` is the ONLY time the plaintext ever leaves the server.
      res.status(201).json({ ...serializeKey(row), key: token });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/api-keys/:id', requireAuth, async (req, res) => {
    try {
      const row = await get(
        'SELECT id FROM api_keys WHERE id=? AND user_id=? AND revoked_at IS NULL',
        req.params.id, req.session.userId
      );
      if (!row) return res.status(404).json({ error: 'Not found' });
      await run(
        `UPDATE api_keys SET revoked_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
        row.id
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── External API auth ─────────────────────────────────────────────────────

  async function requireApiKey(req, res, next) {
    try {
      const auth = String(req.headers['authorization'] || '');
      const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
      const token = bearer || String(req.headers['x-api-key'] || '').trim();
      if (!token || !token.startsWith('wm_')) {
        return res.status(401).json({ error: 'API key required. Pass it as "Authorization: Bearer <key>" or an "X-API-Key" header.' });
      }
      const keyRow = await get(
        'SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL', sha256(token)
      );
      const user = keyRow ? await getUser(keyRow.user_id) : null;
      if (!keyRow || !user) return res.status(401).json({ error: 'Invalid or revoked API key' });
      // Usage stamp — fire-and-forget, a lost update here is harmless.
      run(
        `UPDATE api_keys SET last_used_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
        keyRow.id
      ).catch(() => {});
      req.apiUser = user;
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  }

  // ── External API (read-only) ──────────────────────────────────────────────

  // Compact list so the calling app can discover ticket ids. Same visibility
  // rule as the in-app list: Admin sees everything, everyone else only
  // tickets they're involved in (assignee / reporter / requester / creator /
  // watcher). Optional ?status= filter, e.g. /api/v1/tickets?status=Open
  app.get('/api/v1/tickets', requireApiKey, async (req, res) => {
    try {
      const me = req.apiUser;
      const params = [];
      let where = 't.deleted_at IS NULL';
      if (me.perm_role !== 'Admin') {
        where += ` AND (t.assignee_user_id = ?
              OR (t.assignee_user_id IS NULL AND t.assignee = ?)
              OR EXISTS (SELECT 1 FROM ticket_assignees ta
                          WHERE ta.ticket_id = t.id
                            AND (ta.user_id = ? OR (ta.user_id IS NULL AND ta.user_name = ?)))
              OR t.reporter_user_id = ?
              OR (t.reporter_user_id IS NULL AND t.reporter = ?)
              OR t.req_user_id = ?
              OR (t.req_user_id IS NULL AND t.req = ?)
              OR t.created_by = ?
              OR EXISTS (SELECT 1 FROM ticket_watchers tw
                          WHERE tw.ticket_id = t.id AND tw.user_id = ?))`;
        params.push(me.id, me.name, me.id, me.name, me.id, me.name, me.id, me.name, me.id, me.id);
      }
      const status = String(req.query.status || '').trim();
      if (status) { where += ' AND t.status = ?'; params.push(status); }
      const rows = await all(
        `SELECT t.id, t.title, t.status, t.priority, t.dept, t.due, t.created_at,
                COALESCE(a.name, t.assignee) AS assignee,
                COALESCE(r.name, t.reporter) AS reporter
           FROM tickets t
           LEFT JOIN users a ON a.id = t.assignee_user_id
           LEFT JOIN users r ON r.id = t.reporter_user_id
          WHERE ${where}
          ORDER BY t.created_at DESC`,
        ...params
      );
      res.json({ tickets: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Everything about one ticket in a single response — the external-app
  // equivalent of the ticket-detail bootstrap, minus the caller-specific
  // bits (reminders, view stamps, team pickers).
  app.get('/api/v1/tickets/:id', requireApiKey, async (req, res) => {
    try {
      const tid = req.params.id;
      // 404 (not 403) on no-access, same as the in-app routes, so the
      // response can't be used to probe which ticket ids exist.
      if (!await userCanAccessTicket(req.apiUser.id, tid)) {
        return res.status(404).json({ error: 'Not found' });
      }
      const row = await get('SELECT * FROM tickets WHERE id=? AND deleted_at IS NULL', tid);
      if (!row) return res.status(404).json({ error: 'Not found' });

      const [ticket, comments, timelineRows, detailsRow, subtasks, attRows] = await Promise.all([
        buildTicket(row),
        fetchTicketComments(tid),
        all('SELECT * FROM ticket_timelines WHERE ticket_id=? ORDER BY created_at DESC', tid),
        get('SELECT * FROM ticket_details WHERE ticket_id=?', tid),
        fetchTicketSubtasks(tid),
        all('SELECT * FROM attachments WHERE ticket_id=? ORDER BY created_at ASC', tid),
      ]);

      res.json({
        ticket,
        details: detailsRow
          ? { description: detailsRow.description || '', checklist: JSON.parse(detailsRow.checklist_json || '[]') }
          : { description: '', checklist: [] },
        comments: comments.map(c => ({
          ...c,
          attachments: (c.attachments || []).map(a => ({ ...a, url: absUrl(a.url) })),
        })),
        timeline: timelineRows.length
          ? timelineRows.map(r => ({
              id: r.id, dot: r.dot, text: r.text,
              createdAt: r.created_at,
              sub: formatUSDateTime(r.created_at) || r.sub,
            }))
          : [{
              dot: 'var(--green)', text: 'Ticket created',
              createdAt: row.created_at,
              sub: formatUSDateTime(row.created_at) || row.created,
            }],
        subtasks,
        attachments: attRows.map(r => ({
          id: r.id, filename: r.filename, originalName: r.original_name,
          mimeType: r.mime_type, size: r.size, uploader: r.uploader,
          commentId: r.comment_id, createdAt: r.created_at,
          url: absUrl(`/uploads/${r.filename}`),
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
