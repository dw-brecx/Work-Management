// ─────────────────────────────────────────────────────────────────────────────
// Apps — design-to-dev handoff for Claude-built apps
//
// Workflow this supports:
//   1. Designer drafts HTML pages in Claude → uploads or pastes them here
//   2. Creator assigns designer / manager / developer
//   3. Manager + developer review each page in the embedded preview, write
//      a blueprint description (optional AI assist), and ask questions in a
//      per-page Q&A thread that's isolated from the main ticket system
//   4. Developer ticks off a function checklist as they verify behaviour
//      on the live page; when every page is "done" the app ships
//
// Access is restricted to the three role assignees + creator + admins —
// page-level Q&A is intentionally separate from /api/tickets so design
// chatter doesn't drown work tickets.
//
// Pattern follows routes/spaces.js — single attach(app, deps) export, same
// db helpers, requireAuth middleware. Preview endpoint serves uploaded HTML
// back into a sandboxed iframe; CSP + sandbox attribute together prevent
// the design from stealing session cookies or hitting the parent origin.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function attach(app, deps) {
  const { get, all, run, requireAuth } = deps;

  // Read Anthropic key from env directly — same source as the /api/polish
  // route in server.js. If unset the AI-blueprint endpoint returns 503 and
  // the client falls back to manual editing; nothing else breaks.
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

  const APP_STATUSES = new Set(['design', 'dev', 'review', 'live', 'archived']);
  const PAGE_STATUSES = new Set(['pending', 'in_review', 'working', 'broken', 'done']);
  const FN_STATUSES = new Set(['pending', 'working', 'broken', 'na']);

  // ── Access helpers ─────────────────────────────────────────────────────
  // An app is visible to: designer, manager, developer, creator, or admin.
  // We hand the loaded row back so callers don't re-query.
  async function loadAppForUser(appId, userId) {
    const id = Number(appId);
    if (!Number.isFinite(id) || id < 1) return { error: { status: 400, message: 'Invalid app id' } };
    const appRow = await get('SELECT * FROM apps WHERE id=? AND deleted_at IS NULL', id);
    if (!appRow) return { error: { status: 404, message: 'App not found' } };
    const me = await get('SELECT perm_role FROM users WHERE id=?', userId);
    const isAdmin = me && (me.perm_role === 'Admin');
    const isMember = appRow.created_by === userId
      || appRow.designer_id === userId
      || appRow.manager_id === userId
      || appRow.developer_id === userId;
    if (!isAdmin && !isMember) return { error: { status: 403, message: 'No access to this app' } };
    return { app: appRow, isAdmin };
  }

  // Load a page + verify the caller can access its app.
  async function loadPageForUser(pageId, userId) {
    const pid = Number(pageId);
    if (!Number.isFinite(pid) || pid < 1) return { error: { status: 400, message: 'Invalid page id' } };
    const page = await get('SELECT * FROM app_pages WHERE id=?', pid);
    if (!page) return { error: { status: 404, message: 'Page not found' } };
    const accessCheck = await loadAppForUser(page.app_id, userId);
    if (accessCheck.error) return accessCheck;
    return { app: accessCheck.app, page, isAdmin: accessCheck.isAdmin };
  }

  // Hydrate an app row with assignee names so the UI can render avatars
  // without a follow-up /api/team lookup.
  async function shapeApp(appRow, extras) {
    const ids = [appRow.designer_id, appRow.manager_id, appRow.developer_id, appRow.created_by]
      .filter(v => Number.isFinite(Number(v)) && Number(v) > 0);
    let nameMap = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = await all(`SELECT id, name FROM users WHERE id IN (${placeholders})`, ...ids);
      nameMap = new Map(rows.map(r => [r.id, r.name]));
    }
    return Object.assign({
      id: appRow.id,
      name: appRow.name,
      description: appRow.description,
      status: appRow.status,
      cover_color: appRow.cover_color,
      designer_id: appRow.designer_id,
      designer_name: nameMap.get(appRow.designer_id) || null,
      manager_id: appRow.manager_id,
      manager_name: nameMap.get(appRow.manager_id) || null,
      developer_id: appRow.developer_id,
      developer_name: nameMap.get(appRow.developer_id) || null,
      repo_url: appRow.repo_url,
      deploy_url: appRow.deploy_url,
      created_by: appRow.created_by,
      created_by_name: nameMap.get(appRow.created_by) || null,
      created_at: appRow.created_at,
      updated_at: appRow.updated_at,
    }, extras || {});
  }

  function shapePage(row, extras) {
    return Object.assign({
      id: row.id,
      app_id: row.app_id,
      name: row.name,
      file_name: row.file_name,
      blueprint: row.blueprint,
      status: row.status,
      position: row.position,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }, extras || {});
  }

  // ── Apps CRUD ──────────────────────────────────────────────────────────
  // GET /api/apps — every app the caller can access (creator / assignee /
  // admin). Includes a page_count + comment_count so the cards in the list
  // can render summary stats without a follow-up fetch.
  app.get('/api/apps', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const me = await get('SELECT perm_role FROM users WHERE id=?', userId);
      const isAdmin = me && me.perm_role === 'Admin';
      const whereClause = isAdmin
        ? 'a.deleted_at IS NULL'
        : 'a.deleted_at IS NULL AND (a.created_by=? OR a.designer_id=? OR a.manager_id=? OR a.developer_id=?)';
      const args = isAdmin ? [] : [userId, userId, userId, userId];
      const rows = await all(
        `SELECT a.*,
                (SELECT COUNT(*) FROM app_pages p WHERE p.app_id = a.id) AS page_count,
                (SELECT COUNT(*) FROM app_page_functions f
                   JOIN app_pages p ON p.id = f.page_id
                  WHERE p.app_id = a.id AND f.status='working') AS fn_working,
                (SELECT COUNT(*) FROM app_page_functions f
                   JOIN app_pages p ON p.id = f.page_id
                  WHERE p.app_id = a.id) AS fn_total
           FROM apps a
          WHERE ${whereClause}
          ORDER BY a.updated_at DESC`,
        ...args
      );
      const shaped = await Promise.all(rows.map(r => shapeApp(r, {
        page_count: Number(r.page_count || 0),
        fn_working: Number(r.fn_working || 0),
        fn_total: Number(r.fn_total || 0),
      })));
      res.json(shaped);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/apps — create. Only `name` is required; everything else is
  // editable later. Creator becomes both created_by and (by default) the
  // designer slot — most of the time the person dropping HTML in is also
  // the designer.
  app.post('/api/apps', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const { name, description, cover_color, designer_id, manager_id, developer_id, repo_url, deploy_url } = req.body || {};
      const cleanName = String(name || '').trim();
      if (!cleanName) return res.status(400).json({ error: 'Name required' });
      const ins = await run(
        `INSERT INTO apps (name, description, cover_color, designer_id, manager_id, developer_id, repo_url, deploy_url, created_by)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        cleanName,
        String(description || '').trim(),
        cover_color || '#3b82f6',
        normaliseUserId(designer_id) ?? userId,
        normaliseUserId(manager_id),
        normaliseUserId(developer_id),
        String(repo_url || '').trim(),
        String(deploy_url || '').trim(),
        userId
      );
      const appRow = await get('SELECT * FROM apps WHERE id=?', ins.lastInsertRowid);
      const shaped = await shapeApp(appRow, { page_count: 0, fn_working: 0, fn_total: 0 });
      res.status(201).json(shaped);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/apps/:id — full app with the list of pages (metadata only —
  // html_content is loaded on demand via /pages/:pageId so the list view
  // stays light).
  app.get('/api/apps/:id', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const pages = await all(
        `SELECT p.id, p.app_id, p.name, p.file_name, p.blueprint, p.status, p.position,
                p.created_by, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM app_page_comments c WHERE c.page_id = p.id) AS comment_count,
                (SELECT COUNT(*) FROM app_page_functions f WHERE f.page_id = p.id) AS fn_total,
                (SELECT COUNT(*) FROM app_page_functions f WHERE f.page_id = p.id AND f.status='working') AS fn_working
           FROM app_pages p
          WHERE p.app_id = ?
          ORDER BY p.position ASC, p.id ASC`,
        result.app.id
      );
      const shaped = await shapeApp(result.app);
      shaped.pages = pages.map(p => shapePage(p, {
        comment_count: Number(p.comment_count || 0),
        fn_total: Number(p.fn_total || 0),
        fn_working: Number(p.fn_working || 0),
      }));
      res.json(shaped);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/apps/:id — only the creator or an admin can rename / change
  // assignees / update status. Designer/manager/developer have view+contribute
  // rights but can't reassign themselves out.
  app.patch('/api/apps/:id', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const isCreator = result.app.created_by === req.session.userId;
      if (!isCreator && !result.isAdmin) {
        return res.status(403).json({ error: 'Only the creator or an admin can edit app settings' });
      }
      const { name, description, status, cover_color, designer_id, manager_id, developer_id, repo_url, deploy_url } = req.body || {};
      const cols = []; const args = [];
      if (name !== undefined) {
        const clean = String(name).trim();
        if (!clean) return res.status(400).json({ error: 'Name cannot be empty' });
        cols.push('name=?'); args.push(clean);
      }
      if (description !== undefined) { cols.push('description=?'); args.push(String(description || '').trim()); }
      if (status !== undefined) {
        if (!APP_STATUSES.has(String(status))) return res.status(400).json({ error: 'Invalid status' });
        cols.push('status=?'); args.push(String(status));
      }
      if (cover_color !== undefined) { cols.push('cover_color=?'); args.push(String(cover_color)); }
      if (designer_id !== undefined) { cols.push('designer_id=?'); args.push(normaliseUserId(designer_id)); }
      if (manager_id !== undefined) { cols.push('manager_id=?'); args.push(normaliseUserId(manager_id)); }
      if (developer_id !== undefined) { cols.push('developer_id=?'); args.push(normaliseUserId(developer_id)); }
      if (repo_url !== undefined) { cols.push('repo_url=?'); args.push(String(repo_url || '').trim()); }
      if (deploy_url !== undefined) { cols.push('deploy_url=?'); args.push(String(deploy_url || '').trim()); }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE apps SET ${cols.join(',')} WHERE id=?`, ...args, result.app.id);
      }
      const updated = await get('SELECT * FROM apps WHERE id=?', result.app.id);
      const shaped = await shapeApp(updated);
      res.json(shaped);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/apps/:id — soft delete (matches spaces / tickets pattern).
  // Creator or admin only — restores via PATCH would need a separate route
  // we haven't built yet; for v1 deletion is one-way unless an admin
  // un-sets deleted_at directly.
  app.delete('/api/apps/:id', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const isCreator = result.app.created_by === req.session.userId;
      if (!isCreator && !result.isAdmin) {
        return res.status(403).json({ error: 'Only the creator or an admin can delete this app' });
      }
      await run(
        "UPDATE apps SET deleted_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
        result.app.id
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Pages CRUD ─────────────────────────────────────────────────────────
  // POST /api/apps/:id/pages — create one page. Client sends { name,
  // file_name, html_content } whether the source was a file pick or a
  // paste; the server doesn't distinguish.
  app.post('/api/apps/:id/pages', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const { name, file_name, html_content, blueprint } = req.body || {};
      const cleanName = String(name || '').trim() || String(file_name || '').trim() || 'Untitled page';
      const html = String(html_content || '');
      // Soft cap per page — typical Claude-designed HTML files run 30-300KB.
      // 2MB gives plenty of headroom while protecting against runaway pastes.
      if (html.length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'HTML too large (max 2MB per page)' });
      }
      const next = await get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM app_pages WHERE app_id=?', result.app.id);
      const ins = await run(
        `INSERT INTO app_pages (app_id, name, file_name, html_content, blueprint, position, created_by)
         VALUES (?,?,?,?,?,?,?) RETURNING id`,
        result.app.id, cleanName, String(file_name || '').trim(), html,
        String(blueprint || '').trim(), Number(next?.next || 0), req.session.userId
      );
      await touchApp(result.app.id);
      const row = await get('SELECT * FROM app_pages WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapePage(row, { comment_count: 0, fn_total: 0, fn_working: 0 }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/apps/:id/pages/:pageId — full page including html_content.
  // Used by the page-detail panel; the list-of-pages endpoint omits the
  // body to keep payloads small.
  app.get('/api/apps/:id/pages/:pageId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const out = shapePage(result.page);
      out.html_content = result.page.html_content;
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/apps/:id/pages/:pageId — rename, replace HTML, edit
  // blueprint, change status. Any member can edit (it's collaborative).
  app.patch('/api/apps/:id/pages/:pageId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const { name, file_name, html_content, blueprint, status, position } = req.body || {};
      const cols = []; const args = [];
      if (name !== undefined) {
        const clean = String(name).trim();
        if (!clean) return res.status(400).json({ error: 'Name cannot be empty' });
        cols.push('name=?'); args.push(clean);
      }
      if (file_name !== undefined) { cols.push('file_name=?'); args.push(String(file_name || '').trim()); }
      if (html_content !== undefined) {
        const html = String(html_content || '');
        if (html.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'HTML too large (max 2MB per page)' });
        cols.push('html_content=?'); args.push(html);
      }
      if (blueprint !== undefined) { cols.push('blueprint=?'); args.push(String(blueprint || '').trim()); }
      if (status !== undefined) {
        if (!PAGE_STATUSES.has(String(status))) return res.status(400).json({ error: 'Invalid status' });
        cols.push('status=?'); args.push(String(status));
      }
      if (position !== undefined) {
        const n = Number(position);
        if (Number.isFinite(n)) { cols.push('position=?'); args.push(Math.trunc(n)); }
      }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE app_pages SET ${cols.join(',')} WHERE id=?`, ...args, result.page.id);
        await touchApp(result.app.id);
      }
      const row = await get('SELECT * FROM app_pages WHERE id=?', result.page.id);
      const out = shapePage(row);
      out.html_content = row.html_content;
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/apps/:id/pages/:pageId — cascade-drops comments + functions
  // for the page via the ON DELETE CASCADE on app_page_comments / functions.
  app.delete('/api/apps/:id/pages/:pageId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      await run('DELETE FROM app_pages WHERE id=?', result.page.id);
      await touchApp(result.app.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/apps/:id/pages/:pageId/preview — serves the raw HTML body
  // for embedding in a sandboxed iframe. CSP forbids loading anything
  // off-origin, opening top-level navigations, or scripts from anywhere
  // (the iframe's `sandbox` attribute on the client also blocks
  // same-origin access so even if an injected script ran it couldn't
  // read parent cookies). X-Frame-Options is intentionally NOT set so
  // our own page can embed it.
  app.get('/api/apps/:id/pages/:pageId/preview', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).send('Access denied');
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).send('Page not found');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // CSP: no scripts, no external sources, no form submissions, no top
      // navigation. The designer HTML is treated as untrusted (it might
      // call random APIs or include trackers); this strips it down to
      // visual rendering only.
      res.setHeader('Content-Security-Policy',
        "default-src 'self' data: blob:; " +
        "img-src 'self' data: blob: https:; " +
        "style-src 'self' 'unsafe-inline' https:; " +
        "font-src 'self' data: https:; " +
        "script-src 'none'; " +
        "frame-src 'none'; " +
        "object-src 'none'; " +
        "form-action 'none'; " +
        "base-uri 'none'"
      );
      res.send(result.page.html_content || '<!doctype html><html><body><p style="font:14px sans-serif;color:#666;padding:24px">No HTML for this page yet.</p></body></html>');
    } catch (e) { res.status(500).send('Preview failed'); }
  });

  // POST /api/apps/:id/pages/:pageId/blueprint/generate — ask Claude Haiku
  // to summarise the HTML into a blueprint description. Same Anthropic
  // wiring as /api/polish; degrades to 503 if no key is configured.
  app.post('/api/apps/:id/pages/:pageId/blueprint/generate', requireAuth, async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI assist disabled — ANTHROPIC_API_KEY not set on server.' });
    }
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const html = String(result.page.html_content || '').slice(0, 60000);
      if (!html.trim()) return res.status(400).json({ error: 'No HTML to analyse' });

      const systemPrompt =
        "You analyse a single HTML page from an app design and write a clear, concise blueprint description for the developer who will build it. " +
        "Cover (1) the purpose of the page, (2) the main sections / regions visible, (3) the interactive elements (forms, buttons, links) and what each should do, and (4) any data that needs to load or save. " +
        "Use short paragraphs and bullets where helpful. Write directly — no preamble, no 'here is', no meta-commentary. " +
        "Stay under 250 words. Return ONLY the blueprint text.";

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: `Page title: ${result.page.name}\nFile: ${result.page.file_name || '(pasted)'}\n\nHTML:\n${html}`,
          }],
        }),
      });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        console.warn('[apps blueprint] Anthropic error:', r.status, errBody.slice(0, 300));
        return res.status(502).json({ error: 'AI service returned ' + r.status });
      }
      const data = await r.json();
      const draft = (data.content?.[0]?.text || '').trim();
      if (!draft) return res.status(502).json({ error: 'AI returned empty response' });
      res.json({ draft });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Page comments (Q&A thread) ─────────────────────────────────────────
  app.get('/api/apps/:id/pages/:pageId/comments', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const rows = await all(
        `SELECT id, page_id, parent_id, author_id, author_name, text, resolved, created_at
           FROM app_page_comments
          WHERE page_id=?
          ORDER BY id ASC`,
        result.page.id
      );
      res.json(rows.map(r => ({ ...r, resolved: !!r.resolved })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/apps/:id/pages/:pageId/comments', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const text = String((req.body && req.body.text) || '').trim();
      if (!text) return res.status(400).json({ error: 'Comment text required' });
      if (text.length > 4000) return res.status(400).json({ error: 'Comment too long (max 4000 chars)' });
      const parent = req.body && req.body.parent_id != null ? Number(req.body.parent_id) : null;
      const me = await get('SELECT name FROM users WHERE id=?', req.session.userId);
      const ins = await run(
        `INSERT INTO app_page_comments (page_id, parent_id, author_id, author_name, text)
         VALUES (?,?,?,?,?) RETURNING id`,
        result.page.id,
        Number.isFinite(parent) && parent > 0 ? parent : null,
        req.session.userId,
        (me && me.name) || '',
        text
      );
      await touchApp(result.app.id);
      const row = await get(
        'SELECT id, page_id, parent_id, author_id, author_name, text, resolved, created_at FROM app_page_comments WHERE id=?',
        ins.lastInsertRowid
      );
      res.status(201).json({ ...row, resolved: !!row.resolved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH — toggle resolved (or update text by the author).
  app.patch('/api/apps/:id/pages/:pageId/comments/:commentId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const comment = await get('SELECT * FROM app_page_comments WHERE id=? AND page_id=?', Number(req.params.commentId), result.page.id);
      if (!comment) return res.status(404).json({ error: 'Comment not found' });
      const cols = []; const args = [];
      if (req.body && 'resolved' in req.body) { cols.push('resolved=?'); args.push(req.body.resolved ? 1 : 0); }
      if (req.body && 'text' in req.body) {
        // Only the author can edit their own text. Resolve toggle is open
        // to every member because anyone in the thread can close it.
        if (comment.author_id !== req.session.userId && !result.isAdmin) {
          return res.status(403).json({ error: 'Only the author can edit this comment' });
        }
        const text = String(req.body.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Comment text required' });
        if (text.length > 4000) return res.status(400).json({ error: 'Comment too long (max 4000 chars)' });
        cols.push('text=?'); args.push(text);
      }
      if (cols.length) {
        await run(`UPDATE app_page_comments SET ${cols.join(',')} WHERE id=?`, ...args, comment.id);
      }
      const updated = await get(
        'SELECT id, page_id, parent_id, author_id, author_name, text, resolved, created_at FROM app_page_comments WHERE id=?',
        comment.id
      );
      res.json({ ...updated, resolved: !!updated.resolved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/apps/:id/pages/:pageId/comments/:commentId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const comment = await get('SELECT * FROM app_page_comments WHERE id=? AND page_id=?', Number(req.params.commentId), result.page.id);
      if (!comment) return res.status(404).json({ error: 'Comment not found' });
      if (comment.author_id !== req.session.userId && !result.isAdmin) {
        return res.status(403).json({ error: 'Only the author or an admin can delete this comment' });
      }
      await run('DELETE FROM app_page_comments WHERE id=?', comment.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Page function checklist ────────────────────────────────────────────
  app.get('/api/apps/:id/pages/:pageId/functions', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const rows = await all(
        `SELECT f.*, u.name AS assignee_name
           FROM app_page_functions f
           LEFT JOIN users u ON u.id = f.assignee_id
          WHERE f.page_id=?
          ORDER BY f.position ASC, f.id ASC`,
        result.page.id
      );
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/apps/:id/pages/:pageId/functions', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const title = String((req.body && req.body.title) || '').trim();
      if (!title) return res.status(400).json({ error: 'Function title required' });
      const description = String((req.body && req.body.description) || '').trim();
      const status = req.body && FN_STATUSES.has(String(req.body.status)) ? String(req.body.status) : 'pending';
      const assignee = normaliseUserId(req.body && req.body.assignee_id);
      const next = await get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM app_page_functions WHERE page_id=?', result.page.id);
      const ins = await run(
        `INSERT INTO app_page_functions (page_id, title, description, status, position, assignee_id, created_by)
         VALUES (?,?,?,?,?,?,?) RETURNING id`,
        result.page.id, title, description, status, Number(next?.next || 0), assignee, req.session.userId
      );
      await touchApp(result.app.id);
      const row = await get(
        `SELECT f.*, u.name AS assignee_name
           FROM app_page_functions f
           LEFT JOIN users u ON u.id = f.assignee_id
          WHERE f.id=?`,
        ins.lastInsertRowid
      );
      res.status(201).json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/apps/:id/pages/:pageId/functions/:fnId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const fn = await get('SELECT * FROM app_page_functions WHERE id=? AND page_id=?', Number(req.params.fnId), result.page.id);
      if (!fn) return res.status(404).json({ error: 'Function not found' });
      const { title, description, status, position, assignee_id } = req.body || {};
      const cols = []; const args = [];
      if (title !== undefined) {
        const clean = String(title).trim();
        if (!clean) return res.status(400).json({ error: 'Title cannot be empty' });
        cols.push('title=?'); args.push(clean);
      }
      if (description !== undefined) { cols.push('description=?'); args.push(String(description || '').trim()); }
      if (status !== undefined) {
        if (!FN_STATUSES.has(String(status))) return res.status(400).json({ error: 'Invalid status' });
        cols.push('status=?'); args.push(String(status));
      }
      if (position !== undefined) {
        const n = Number(position);
        if (Number.isFinite(n)) { cols.push('position=?'); args.push(Math.trunc(n)); }
      }
      if (assignee_id !== undefined) { cols.push('assignee_id=?'); args.push(normaliseUserId(assignee_id)); }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE app_page_functions SET ${cols.join(',')} WHERE id=?`, ...args, fn.id);
        await touchApp(result.app.id);
      }
      const updated = await get(
        `SELECT f.*, u.name AS assignee_name
           FROM app_page_functions f
           LEFT JOIN users u ON u.id = f.assignee_id
          WHERE f.id=?`,
        fn.id
      );
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/apps/:id/pages/:pageId/functions/:fnId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      await run('DELETE FROM app_page_functions WHERE id=? AND page_id=?', Number(req.params.fnId), result.page.id);
      await touchApp(result.app.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Helpers ────────────────────────────────────────────────────────────
  function normaliseUserId(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  }

  // Bump the parent app's updated_at so the list re-orders after activity.
  async function touchApp(appId) {
    await run(
      "UPDATE apps SET updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
      appId
    );
  }
};
