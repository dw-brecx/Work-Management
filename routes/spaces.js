// ─────────────────────────────────────────────────────────────────────────────
// Spaces — REST API
//
// Top-level "canvas" workspaces where users drop draggable cards (tickets,
// sticky notes, files, images, voice/screen recordings, links) onto a 2D
// surface. Sharing has two modes:
//   * per-user invites (viewer / editor) via /:id/members
//   * a public share link (toggleable, regeneratable, optional public edit)
//     served by the unauthenticated /public/:token endpoint
//
// Ported (rewritten) from the Prisma-based syruvia-lab implementation in
// claude/sync-latest-updates-Xkku3. Uses our shared db.js helpers instead.
// Lives in its own file (routes/spaces.js) so it doesn't bloat server.js —
// the new convention going forward is one file per feature.
//
// Exports a single function `attach(app, deps)` that registers every route
// on the Express app, given the auth middleware + db helpers the parent
// app already created.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

module.exports = function attach(app, deps) {
  const { get, all, run, requireAuth } = deps;

  // Whitelisted columns the client is allowed to set on a SpaceItem PATCH.
  // Anything outside this list is silently dropped — guards against a
  // client trying to clobber id / space_id / created_by.
  const ITEM_FIELDS = [
    'title', 'text', 'url', 'data', 'mime_type', 'size', 'duration',
    'color', 'ticket_ref', 'ticket_meta',
    'position_x', 'position_y', 'width', 'height', 'z_index',
  ];

  function pickItemUpdate(body) {
    const out = {};
    for (const k of ITEM_FIELDS) if (k in (body || {})) out[k] = body[k];
    // ticket_meta is stored as JSON-serialised text; accept either a string
    // or an object on the wire and normalise here.
    if (out.ticket_meta && typeof out.ticket_meta !== 'string') {
      try { out.ticket_meta = JSON.stringify(out.ticket_meta); } catch { out.ticket_meta = null; }
    }
    return out;
  }

  // Build the UPDATE SQL fragment from a picked-fields object. Returns
  // { sql: 'col1=?,col2=?,...', args: [v1, v2, ...] } — empty when no
  // fields are set.
  function buildItemUpdateSql(picked) {
    const cols = []; const args = [];
    for (const [k, v] of Object.entries(picked)) {
      cols.push(`${k}=?`);
      args.push(v);
    }
    if (cols.length) {
      cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
    }
    return { sql: cols.join(','), args };
  }

  // Shape a space_items row for the wire. ticket_meta is stored as JSON
  // text in the DB; clients want it as an object.
  function shapeItem(r) {
    let ticketMeta = null;
    if (r.ticket_meta) {
      try { ticketMeta = JSON.parse(r.ticket_meta); } catch { ticketMeta = null; }
    }
    return {
      id: r.id,
      space_id: r.space_id,
      type: r.type,
      title: r.title,
      text: r.text,
      url: r.url,
      data: r.data,
      mime_type: r.mime_type,
      size: r.size,
      duration: r.duration,
      color: r.color,
      ticket_ref: r.ticket_ref,
      ticket_meta: ticketMeta,
      position_x: r.position_x,
      position_y: r.position_y,
      width: r.width,
      height: r.height,
      z_index: r.z_index,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  function shapeSpace(s, extras) {
    return Object.assign({
      id: s.id,
      name: s.name,
      description: s.description,
      cover_color: s.cover_color,
      owner_id: s.owner_id,
      owner_name: s.owner_name,
      is_public: !!s.is_public,
      public_token: s.public_token,
      public_can_edit: !!s.public_can_edit,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }, extras || {});
  }

  // Load a space + the requesting user's access level.
  // Returns one of:
  //   { error: { status, message } } on not-found / no-access
  //   { space, isOwner, canEdit }
  async function loadSpaceForUser(spaceId, userId, requireEdit) {
    const space = await get('SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL', spaceId);
    if (!space) return { error: { status: 404, message: 'Space not found' } };
    const isOwner = space.owner_id === userId;
    const member = await get('SELECT role FROM space_members WHERE space_id=? AND user_id=?', spaceId, userId);
    const canView = isOwner || !!member;
    const canEdit = isOwner || (member && member.role === 'editor');
    if (!canView) return { error: { status: 403, message: 'No access to this space' } };
    if (requireEdit && !canEdit) return { error: { status: 403, message: 'Read-only access to this space' } };
    return { space, isOwner, canEdit };
  }

  // ── Public read endpoint (NO auth) ─────────────────────────────────────
  // GET /api/spaces/public/:token
  // Anyone with the share token can view. If public_can_edit is set, the
  // client surfaces an Edit affordance and PATCHes via the route below.
  app.get('/api/spaces/public/:token', async (req, res) => {
    try {
      const space = await get(
        'SELECT * FROM spaces WHERE public_token=? AND deleted_at IS NULL',
        req.params.token
      );
      if (!space || !space.is_public) return res.status(404).json({ error: 'Space not found' });
      const items = await all(
        'SELECT * FROM space_items WHERE space_id=? ORDER BY created_at ASC',
        space.id
      );
      res.json({
        ...shapeSpace(space),
        items: items.map(shapeItem),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/spaces/public/:token/items/:itemId — gated by public_can_edit.
  app.patch('/api/spaces/public/:token/items/:itemId', async (req, res) => {
    try {
      const space = await get(
        'SELECT id, is_public, public_can_edit FROM spaces WHERE public_token=? AND deleted_at IS NULL',
        req.params.token
      );
      if (!space || !space.is_public || !space.public_can_edit) {
        return res.status(403).json({ error: 'Public editing disabled' });
      }
      const item = await get('SELECT id, space_id FROM space_items WHERE id=?', req.params.itemId);
      if (!item || item.space_id !== space.id) return res.status(403).json({ error: 'Item not in this space' });
      const picked = pickItemUpdate(req.body);
      const { sql, args } = buildItemUpdateSql(picked);
      if (sql) {
        await run(`UPDATE space_items SET ${sql} WHERE id=?`, ...args, req.params.itemId);
      }
      const updated = await get('SELECT * FROM space_items WHERE id=?', req.params.itemId);
      res.json(shapeItem(updated));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Everything below requires auth ─────────────────────────────────────

  // GET /api/spaces — spaces I own + spaces shared with me.
  app.get('/api/spaces', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const rows = await all(
        `SELECT s.*,
                (SELECT COUNT(*) FROM space_items i WHERE i.space_id = s.id) AS item_count,
                (SELECT role FROM space_members m WHERE m.space_id = s.id AND m.user_id = ?) AS my_role
           FROM spaces s
          WHERE s.deleted_at IS NULL
            AND (s.owner_id = ? OR EXISTS (
                  SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id = ?
                ))
          ORDER BY s.updated_at DESC`,
        userId, userId, userId
      );
      res.json(rows.map(s => shapeSpace(s, {
        item_count: Number(s.item_count || 0),
        role: s.owner_id === userId ? 'owner' : (s.my_role || 'viewer'),
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/spaces — create a new space.
  app.post('/api/spaces', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const { name, description, cover_color } = req.body || {};
      const cleanName = String(name || '').trim();
      if (!cleanName) return res.status(400).json({ error: 'Name required' });
      const me = await get('SELECT name FROM users WHERE id=?', userId);
      const ins = await run(
        `INSERT INTO spaces (name, description, cover_color, owner_id, owner_name)
         VALUES (?,?,?,?,?) RETURNING id`,
        cleanName, String(description || '').trim(), cover_color || '#bf7325',
        userId, (me && me.name) || ''
      );
      const space = await get('SELECT * FROM spaces WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapeSpace(space, { role: 'owner', item_count: 0 }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/spaces/:id — full space + items + members.
  app.get('/api/spaces/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await loadSpaceForUser(id, req.session.userId, false);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const items = await all('SELECT * FROM space_items WHERE space_id=? ORDER BY created_at ASC', id);
      const members = await all('SELECT user_id, user_name, role, added_at FROM space_members WHERE space_id=?', id);
      res.json({
        ...shapeSpace(result.space),
        role: result.isOwner ? 'owner' : (members.find(m => m.user_id === req.session.userId)?.role || 'viewer'),
        items: items.map(shapeItem),
        members,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/spaces/:id — rename / change description / cover.
  app.patch('/api/spaces/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await loadSpaceForUser(id, req.session.userId, true);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const { name, description, cover_color } = req.body || {};
      const cols = []; const args = [];
      if (name !== undefined) { cols.push('name=?'); args.push(String(name).trim()); }
      if (description !== undefined) { cols.push('description=?'); args.push(String(description || '').trim()); }
      if (cover_color !== undefined) { cols.push('cover_color=?'); args.push(String(cover_color)); }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE spaces SET ${cols.join(',')} WHERE id=?`, ...args, id);
      }
      const space = await get('SELECT * FROM spaces WHERE id=?', id);
      res.json(shapeSpace(space));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/spaces/:id — soft-delete; owner only.
  app.delete('/api/spaces/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const space = await get('SELECT owner_id FROM spaces WHERE id=? AND deleted_at IS NULL', id);
      if (!space) return res.status(404).json({ error: 'Space not found' });
      if (space.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only the owner can delete' });
      await run(
        "UPDATE spaces SET deleted_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
        id
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Items ──────────────────────────────────────────────────────────────
  // POST /api/spaces/:id/items
  app.post('/api/spaces/:id/items', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await loadSpaceForUser(id, req.session.userId, true);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const { type } = req.body || {};
      if (!type) return res.status(400).json({ error: 'Item type required' });
      const picked = pickItemUpdate(req.body);
      const cols = ['space_id', 'type', 'created_by'];
      const placeholders = ['?', '?', '?'];
      const args = [id, type, req.session.userId];
      for (const [k, v] of Object.entries(picked)) {
        cols.push(k); placeholders.push('?'); args.push(v);
      }
      const ins = await run(
        `INSERT INTO space_items (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING id`,
        ...args
      );
      // Touch the parent space's updated_at so sidebar lists re-order.
      await run(
        "UPDATE spaces SET updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
        id
      );
      const item = await get('SELECT * FROM space_items WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapeItem(item));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/spaces/:id/items/:itemId
  app.patch('/api/spaces/:id/items/:itemId', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await loadSpaceForUser(id, req.session.userId, true);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const picked = pickItemUpdate(req.body);
      const { sql, args } = buildItemUpdateSql(picked);
      if (sql) {
        await run(`UPDATE space_items SET ${sql} WHERE id=? AND space_id=?`, ...args, req.params.itemId, id);
      }
      const item = await get('SELECT * FROM space_items WHERE id=?', req.params.itemId);
      if (!item || item.space_id !== id) return res.status(404).json({ error: 'Item not found' });
      res.json(shapeItem(item));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/spaces/:id/items/:itemId
  app.delete('/api/spaces/:id/items/:itemId', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await loadSpaceForUser(id, req.session.userId, true);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      await run('DELETE FROM space_items WHERE id=? AND space_id=?', req.params.itemId, id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Members (per-user sharing) ─────────────────────────────────────────
  // POST /api/spaces/:id/members — owner only. Upserts on (space_id,user_id).
  app.post('/api/spaces/:id/members', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const space = await get('SELECT owner_id FROM spaces WHERE id=? AND deleted_at IS NULL', id);
      if (!space) return res.status(404).json({ error: 'Space not found' });
      if (space.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only the owner can manage members' });
      const { user_id, role } = req.body || {};
      if (!user_id) return res.status(400).json({ error: 'user_id required' });
      const user = await get('SELECT id, name FROM users WHERE id=?', Number(user_id));
      if (!user) return res.status(404).json({ error: 'User not found' });
      const safeRole = role === 'editor' ? 'editor' : 'viewer';
      // INSERT … ON CONFLICT DO UPDATE — standard upsert via Postgres syntax.
      await run(
        `INSERT INTO space_members (space_id, user_id, user_name, role) VALUES (?,?,?,?)
           ON CONFLICT (space_id, user_id) DO UPDATE SET role=EXCLUDED.role, user_name=EXCLUDED.user_name`,
        id, user.id, user.name, safeRole
      );
      const member = await get(
        'SELECT user_id, user_name, role, added_at FROM space_members WHERE space_id=? AND user_id=?',
        id, user.id
      );
      res.status(201).json(member);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/spaces/:id/members/:userId — owner only.
  app.delete('/api/spaces/:id/members/:userId', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const space = await get('SELECT owner_id FROM spaces WHERE id=? AND deleted_at IS NULL', id);
      if (!space) return res.status(404).json({ error: 'Space not found' });
      if (space.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only the owner can manage members' });
      await run('DELETE FROM space_members WHERE space_id=? AND user_id=?', id, Number(req.params.userId));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public share link ──────────────────────────────────────────────────
  // PATCH /api/spaces/:id/share-link — toggle, regenerate, set public-edit.
  // Body: { enabled?: boolean, can_edit?: boolean, regenerate?: boolean }
  app.patch('/api/spaces/:id/share-link', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const space = await get('SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL', id);
      if (!space) return res.status(404).json({ error: 'Space not found' });
      if (space.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only the owner can manage the share link' });
      const { enabled, can_edit, regenerate } = req.body || {};
      const cols = []; const args = [];
      if (enabled !== undefined) { cols.push('is_public=?'); args.push(enabled ? 1 : 0); }
      if (can_edit !== undefined) { cols.push('public_can_edit=?'); args.push(can_edit ? 1 : 0); }
      if (enabled && (!space.public_token || regenerate)) {
        cols.push('public_token=?'); args.push(crypto.randomBytes(16).toString('hex'));
      }
      if (enabled === false && regenerate) {
        cols.push('public_token=?'); args.push(null);
      }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE spaces SET ${cols.join(',')} WHERE id=?`, ...args, id);
      }
      const updated = await get('SELECT * FROM spaces WHERE id=?', id);
      res.json(shapeSpace(updated));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
