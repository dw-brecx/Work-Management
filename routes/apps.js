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

const fs = require('fs');
const path = require('path');

module.exports = function attach(app, deps) {
  const { get, all, run, requireAuth, upload, UPLOADS_DIR } = deps;

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
      repo_branch: appRow.repo_branch || 'main',
      repo_path: appRow.repo_path || '',
      // Never echo the raw token back to the client — just a flag for the
      // UI to show "token set, edit to change" instead of the value.
      repo_token_set: !!(appRow.repo_token && appRow.repo_token.length > 0),
      repo_auto_sync: !!appRow.repo_auto_sync,
      repo_last_sync: appRow.repo_last_sync || null,
      repo_last_sha: appRow.repo_last_sha || null,
      repo_last_status: appRow.repo_last_status || '',
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
      // blueprint_bn is the cached Bengali translation. Empty until the
      // translate endpoint runs (or invalidated on English edit).
      has_blueprint_bn: !!(row.blueprint_bn && row.blueprint_bn.trim()),
      // Cheap on-the-wire stat for the preview toolbar — saves shipping
      // the full html_content on every page-detail fetch (typical
      // Claude pages are 30-300KB, occasionally 1MB+). The actual HTML
      // is served separately through /preview which the iframe loads.
      html_size: typeof row.html_content === 'string' ? row.html_content.length : 0,
      status: row.status,
      position: row.position,
      // GitHub provenance — surfaces the 🔗 / ⚠ badges in the sidebar.
      source: row.source || 'manual',
      repo_path: row.repo_path || '',
      repo_removed: !!row.repo_removed,
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
        `SELECT p.id, p.app_id, p.name, p.file_name, p.blueprint, p.blueprint_bn, p.status, p.position,
                p.source, p.repo_path, p.repo_removed,
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
      const { name, description, status, cover_color, designer_id, manager_id, developer_id, repo_url, deploy_url,
              repo_branch, repo_path, repo_token, repo_auto_sync } = req.body || {};
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
      if (repo_branch !== undefined) { cols.push('repo_branch=?'); args.push(String(repo_branch || 'main').trim() || 'main'); }
      if (repo_path !== undefined) { cols.push('repo_path=?'); args.push(String(repo_path || '').trim().replace(/^\/|\/$/g, '')); }
      // The token is write-only — the client can clear it by sending '',
      // set a new one by sending a non-empty string, or leave it alone
      // by not sending the field at all.
      if (repo_token !== undefined) { cols.push('repo_token=?'); args.push(String(repo_token || '')); }
      if (repo_auto_sync !== undefined) { cols.push('repo_auto_sync=?'); args.push(repo_auto_sync ? 1 : 0); }
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
      // Fire-and-forget: kick off the AI blueprint generation in the
      // background so the user sees a draft on their next view without
      // waiting on the upload response. Failures are logged, not surfaced;
      // the user can always click "AI assist" or write the blueprint by
      // hand. Guarded so we don't trample a user-provided blueprint.
      if (ANTHROPIC_API_KEY && !String(blueprint || '').trim()) {
        autoGenerateBlueprint(row.id).catch(e => console.warn('[apps] auto-blueprint failed for page ' + row.id + ':', e.message));
      }
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
      // html_content intentionally omitted — only the iframe needs it,
      // and the iframe fetches it through /preview. Keeping it out of
      // the JSON cuts page-detail responses from "tens to hundreds of
      // KB" down to a couple of KB.
      res.json(shapePage(result.page));
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
      if (blueprint !== undefined) {
        cols.push('blueprint=?'); args.push(String(blueprint || '').trim());
        // English source changed — invalidate the cached Bengali so the
        // next view triggers a fresh translation.
        cols.push('blueprint_bn=?'); args.push('');
      }
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
      // See GET handler — html_content lives in /preview, not in the
      // JSON response.
      res.json(shapePage(row));
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
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Cache strategy hinges on whether the URL carries a ?ts=
      // cache-buster. The client builds preview URLs as
      //   /preview?ts=<page.updated_at>
      // so the URL itself changes whenever the page is re-edited or
      // re-synced from GitHub. That makes the URL effectively immutable
      // for its lifetime and we can let the browser keep it cached —
      // night-and-day faster than re-fetching ~100KB of HTML on every
      // tab toggle / pane re-render. URLs without ?ts (typed by hand,
      // server-to-server fetches, etc.) get the conservative no-store
      // policy so they always see fresh content.
      if (req.query && req.query.ts) {
        res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
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
  // wiring as /api/polish; degrades to 503 if no key is configured. The
  // POST page route also kicks this off automatically in the background,
  // so most users never hit this manually — it's the "regenerate" button.
  app.post('/api/apps/:id/pages/:pageId/blueprint/generate', requireAuth, async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI assist disabled — ANTHROPIC_API_KEY not set on server.' });
    }
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const draft = await generateBlueprintFromPage(result.page);
      if (!draft) return res.status(502).json({ error: 'AI returned empty response' });
      res.json({ draft });
    } catch (e) {
      console.warn('[apps blueprint] generate failed:', e.message);
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // POST /api/apps/:id/pages/:pageId/blueprint/translate — translate the
  // current blueprint into the requested target language (defaults to bn /
  // Bengali). Cached in app_pages.blueprint_bn so repeat reads are free;
  // invalidated automatically when the English source is edited.
  app.post('/api/apps/:id/pages/:pageId/blueprint/translate', requireAuth, async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'Translation disabled — ANTHROPIC_API_KEY not set on server.' });
    }
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const lang = String((req.body && req.body.lang) || 'bn').toLowerCase();
      // Only Bengali is wired up for now — the toggle in the UI is EN ↔ BN.
      // Other languages would need their own cache column or a generic
      // translations table; out of scope for this round.
      if (lang !== 'bn') return res.status(400).json({ error: 'Unsupported language (only bn supported)' });
      const source = String(result.page.blueprint || '').trim();
      if (!source) return res.status(400).json({ error: 'Blueprint is empty — nothing to translate' });

      // Return the cache if we have one. The cache is cleared whenever the
      // English blueprint changes (see the PATCH page handler), so a non-
      // empty value here is guaranteed to match the current source.
      if (result.page.blueprint_bn && result.page.blueprint_bn.trim()) {
        return res.json({ translated: result.page.blueprint_bn, cached: true });
      }

      const translated = await callAnthropic(
        "You translate text into Bengali (Bangla, বাংলা). Preserve formatting (line breaks, bullets, paragraphs) exactly. Translate naturally — favour clarity for a developer reading the result over literal word-for-word mapping. Keep technical terms (URLs, API names, HTTP methods, file names, code identifiers) in English. Return ONLY the translated text — no preamble, no quotes, no commentary.",
        source,
        2048
      );
      if (!translated) return res.status(502).json({ error: 'AI returned empty translation' });
      await run('UPDATE app_pages SET blueprint_bn=? WHERE id=?', translated, result.page.id);
      res.json({ translated, cached: false });
    } catch (e) {
      console.warn('[apps blueprint] translate failed:', e.message);
      res.status(e.statusCode || 500).json({ error: e.message });
    }
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

  // ── Pin annotations on the design preview ─────────────────────────────
  // Each annotation is a single typed pin at (x_pct, y_pct) on the page —
  // dropped via right-click on the iframe overlay. type narrows the icon
  // (question / issue / broken / note); status flips when the thread is
  // resolved.
  app.get('/api/apps/:id/pages/:pageId/annotations', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const rows = await all(
        `SELECT id, page_id, x_pct, y_pct, type, text, status, author_id, author_name, created_at, updated_at
           FROM app_page_annotations
          WHERE page_id=?
          ORDER BY id ASC`,
        result.page.id
      );
      // Pull attachments in one shot, then group by annotation_id so the
      // client can render thumbnails / players inline with the pin row.
      const ids = rows.map(r => r.id);
      let byAnn = new Map();
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        const atts = await all(
          `SELECT id, annotation_id, filename, original_name, mime_type, size FROM attachments WHERE annotation_id IN (${placeholders}) ORDER BY id ASC`,
          ...ids
        );
        for (const a of atts) {
          if (!byAnn.has(a.annotation_id)) byAnn.set(a.annotation_id, []);
          byAnn.get(a.annotation_id).push({
            id: a.id, name: a.original_name || a.filename, url: '/uploads/' + a.filename,
            mime_type: a.mime_type, size: a.size,
          });
        }
      }
      res.json(rows.map(r => ({ ...r, attachments: byAnn.get(r.id) || [] })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/apps/:id/pages/:pageId/annotations', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const { x_pct, y_pct, type, text } = req.body || {};
      const x = clampPct(x_pct);
      const y = clampPct(y_pct);
      const safeType = ANNOTATION_TYPES.has(String(type)) ? String(type) : 'question';
      const clean = String(text || '').trim();
      if (!clean) return res.status(400).json({ error: 'Annotation text required' });
      if (clean.length > 2000) return res.status(400).json({ error: 'Annotation too long (max 2000 chars)' });
      const me = await get('SELECT name FROM users WHERE id=?', req.session.userId);
      const ins = await run(
        `INSERT INTO app_page_annotations (page_id, x_pct, y_pct, type, text, author_id, author_name)
         VALUES (?,?,?,?,?,?,?) RETURNING id`,
        result.page.id, x, y, safeType, clean, req.session.userId, (me && me.name) || ''
      );
      await touchApp(result.app.id);
      const row = await get(
        'SELECT id, page_id, x_pct, y_pct, type, text, status, author_id, author_name, created_at, updated_at FROM app_page_annotations WHERE id=?',
        ins.lastInsertRowid
      );
      res.status(201).json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/apps/:id/pages/:pageId/annotations/:annId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const ann = await get('SELECT * FROM app_page_annotations WHERE id=? AND page_id=?', Number(req.params.annId), result.page.id);
      if (!ann) return res.status(404).json({ error: 'Annotation not found' });
      const cols = []; const args = [];
      if (req.body && 'text' in req.body) {
        if (ann.author_id !== req.session.userId && !result.isAdmin) {
          return res.status(403).json({ error: 'Only the author can edit this annotation' });
        }
        const clean = String(req.body.text || '').trim();
        if (!clean) return res.status(400).json({ error: 'Annotation text required' });
        if (clean.length > 2000) return res.status(400).json({ error: 'Annotation too long (max 2000 chars)' });
        cols.push('text=?'); args.push(clean);
      }
      if (req.body && 'type' in req.body) {
        if (!ANNOTATION_TYPES.has(String(req.body.type))) return res.status(400).json({ error: 'Invalid annotation type' });
        cols.push('type=?'); args.push(String(req.body.type));
      }
      if (req.body && 'status' in req.body) {
        const s = String(req.body.status);
        if (s !== 'open' && s !== 'resolved') return res.status(400).json({ error: 'Invalid status' });
        cols.push('status=?'); args.push(s);
      }
      if (req.body && 'x_pct' in req.body) { cols.push('x_pct=?'); args.push(clampPct(req.body.x_pct)); }
      if (req.body && 'y_pct' in req.body) { cols.push('y_pct=?'); args.push(clampPct(req.body.y_pct)); }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE app_page_annotations SET ${cols.join(',')} WHERE id=?`, ...args, ann.id);
      }
      const updated = await get(
        'SELECT id, page_id, x_pct, y_pct, type, text, status, author_id, author_name, created_at, updated_at FROM app_page_annotations WHERE id=?',
        ann.id
      );
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/apps/:id/pages/:pageId/annotations/:annId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const ann = await get('SELECT * FROM app_page_annotations WHERE id=? AND page_id=?', Number(req.params.annId), result.page.id);
      if (!ann) return res.status(404).json({ error: 'Annotation not found' });
      if (ann.author_id !== req.session.userId && !result.isAdmin) {
        return res.status(403).json({ error: 'Only the author or an admin can delete this annotation' });
      }
      await run('DELETE FROM app_page_annotations WHERE id=?', ann.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Per-page todos (manager writes, developer ticks) ───────────────────
  // Simpler shape than functions: one text field + a checkbox. Functions
  // describe behaviour status with a 4-state chip; todos are the punch
  // list of "things still to do" that the manager hands the developer.
  app.get('/api/apps/:id/pages/:pageId/todos', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const rows = await all(
        `SELECT t.*, u.name AS done_by_name, c.name AS created_by_name
           FROM app_page_todos t
           LEFT JOIN users u ON u.id = t.done_by_id
           LEFT JOIN users c ON c.id = t.created_by_id
          WHERE t.page_id=?
          ORDER BY t.position ASC, t.id ASC`,
        result.page.id
      );
      res.json(rows.map(r => ({ ...r, done: !!r.done })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/apps/:id/pages/:pageId/todos', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const text = String((req.body && req.body.text) || '').trim();
      if (!text) return res.status(400).json({ error: 'Todo text required' });
      if (text.length > 1000) return res.status(400).json({ error: 'Todo too long (max 1000 chars)' });
      const next = await get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM app_page_todos WHERE page_id=?', result.page.id);
      const ins = await run(
        `INSERT INTO app_page_todos (page_id, text, position, created_by_id)
         VALUES (?,?,?,?) RETURNING id`,
        result.page.id, text, Number(next?.next || 0), req.session.userId
      );
      await touchApp(result.app.id);
      const row = await get(
        `SELECT t.*, u.name AS done_by_name, c.name AS created_by_name
           FROM app_page_todos t
           LEFT JOIN users u ON u.id = t.done_by_id
           LEFT JOIN users c ON c.id = t.created_by_id
          WHERE t.id=?`,
        ins.lastInsertRowid
      );
      res.status(201).json({ ...row, done: !!row.done });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/apps/:id/pages/:pageId/todos/:todoId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const todo = await get('SELECT * FROM app_page_todos WHERE id=? AND page_id=?', Number(req.params.todoId), result.page.id);
      if (!todo) return res.status(404).json({ error: 'Todo not found' });
      const cols = []; const args = [];
      if (req.body && 'text' in req.body) {
        const clean = String(req.body.text || '').trim();
        if (!clean) return res.status(400).json({ error: 'Todo text required' });
        if (clean.length > 1000) return res.status(400).json({ error: 'Todo too long (max 1000 chars)' });
        cols.push('text=?'); args.push(clean);
      }
      if (req.body && 'done' in req.body) {
        const isDone = !!req.body.done;
        cols.push('done=?'); args.push(isDone ? 1 : 0);
        if (isDone) {
          cols.push('done_by_id=?'); args.push(req.session.userId);
          cols.push("done_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        } else {
          cols.push('done_by_id=?'); args.push(null);
          cols.push('done_at=?'); args.push(null);
        }
      }
      if (req.body && 'position' in req.body) {
        const n = Number(req.body.position);
        if (Number.isFinite(n)) { cols.push('position=?'); args.push(Math.trunc(n)); }
      }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE app_page_todos SET ${cols.join(',')} WHERE id=?`, ...args, todo.id);
        await touchApp(result.app.id);
      }
      const updated = await get(
        `SELECT t.*, u.name AS done_by_name, c.name AS created_by_name
           FROM app_page_todos t
           LEFT JOIN users u ON u.id = t.done_by_id
           LEFT JOIN users c ON c.id = t.created_by_id
          WHERE t.id=?`,
        todo.id
      );
      res.json({ ...updated, done: !!updated.done });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/apps/:id/pages/:pageId/todos/:todoId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      await run('DELETE FROM app_page_todos WHERE id=? AND page_id=?', Number(req.params.todoId), result.page.id);
      await touchApp(result.app.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Per-app dashboard ──────────────────────────────────────────────────
  // Single endpoint that returns the rolled-up numbers + a flat activity
  // feed across every page in the app. Powers the Dashboard tab — far
  // cheaper than the client making N+1 calls per page.
  app.get('/api/apps/:id/dashboard', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const appId = result.app.id;

      const pages = await all(
        `SELECT id, name, status, blueprint, created_at FROM app_pages WHERE app_id=? ORDER BY position ASC, id ASC`,
        appId
      );
      const pageIds = pages.map(p => p.id);
      const inClause = pageIds.length ? '(' + pageIds.map(() => '?').join(',') + ')' : '(NULL)';

      // Stats: one query per kind. Tiny dataset (a handful of pages); no
      // perf concern. Group counts in the application layer.
      const [fns, todos, comments, annotations] = await Promise.all([
        pageIds.length ? all(`SELECT page_id, status, title FROM app_page_functions WHERE page_id IN ${inClause}`, ...pageIds) : [],
        pageIds.length ? all(`SELECT page_id, done, text FROM app_page_todos WHERE page_id IN ${inClause}`, ...pageIds) : [],
        pageIds.length ? all(`SELECT page_id, text, author_name, resolved, created_at FROM app_page_comments WHERE page_id IN ${inClause}`, ...pageIds) : [],
        pageIds.length ? all(`SELECT page_id, text, type, status, author_name, created_at FROM app_page_annotations WHERE page_id IN ${inClause}`, ...pageIds) : [],
      ]);

      const statsByPage = new Map();
      for (const p of pages) statsByPage.set(p.id, {
        fn_total: 0, fn_working: 0, fn_broken: 0,
        todo_total: 0, todo_done: 0,
        comments_total: 0, comments_open: 0,
        annotations_total: 0, annotations_open: 0,
      });
      for (const f of fns) {
        const s = statsByPage.get(f.page_id); if (!s) continue;
        s.fn_total++;
        if (f.status === 'working') s.fn_working++;
        if (f.status === 'broken') s.fn_broken++;
      }
      for (const t of todos) {
        const s = statsByPage.get(t.page_id); if (!s) continue;
        s.todo_total++;
        if (t.done) s.todo_done++;
      }
      for (const c of comments) {
        const s = statsByPage.get(c.page_id); if (!s) continue;
        s.comments_total++;
        if (!c.resolved) s.comments_open++;
      }
      for (const an of annotations) {
        const s = statsByPage.get(an.page_id); if (!s) continue;
        s.annotations_total++;
        if (an.status === 'open') s.annotations_open++;
      }

      // Flat activity feed: most recent of everything, capped. Each entry
      // carries a `kind` so the UI can render the right icon. Sorted by
      // created_at descending in the application layer for simplicity.
      const pageNameById = new Map(pages.map(p => [p.id, p.name]));
      const activity = [];
      for (const c of comments) activity.push({
        kind: 'comment', page_id: c.page_id, page_name: pageNameById.get(c.page_id),
        author: c.author_name, text: c.text, at: c.created_at, resolved: !!c.resolved
      });
      for (const an of annotations) activity.push({
        kind: 'annotation', page_id: an.page_id, page_name: pageNameById.get(an.page_id),
        author: an.author_name, text: an.text, at: an.created_at, type: an.type, status: an.status
      });
      activity.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

      // Aggregate roll-ups: totals over the whole app.
      const totals = { pages: pages.length, fn_total: 0, fn_working: 0, todo_total: 0, todo_done: 0, comments_total: 0, comments_open: 0, annotations_total: 0, annotations_open: 0 };
      for (const s of statsByPage.values()) {
        totals.fn_total += s.fn_total; totals.fn_working += s.fn_working;
        totals.todo_total += s.todo_total; totals.todo_done += s.todo_done;
        totals.comments_total += s.comments_total; totals.comments_open += s.comments_open;
        totals.annotations_total += s.annotations_total; totals.annotations_open += s.annotations_open;
      }

      res.json({
        app: await shapeApp(result.app),
        totals,
        per_page: pages.map(p => ({
          id: p.id,
          name: p.name,
          status: p.status,
          has_blueprint: !!(p.blueprint && p.blueprint.trim()),
          ...statsByPage.get(p.id),
        })),
        recent_activity: activity.slice(0, 50),
        // Flat lists for the "All items under this app" view. Each
        // includes page_name so the UI can render without follow-ups.
        all_comments: comments.map(c => ({ ...c, page_name: pageNameById.get(c.page_id), resolved: !!c.resolved })),
        all_annotations: annotations.map(a => ({ ...a, page_name: pageNameById.get(a.page_id) })),
        all_todos: todos.map(t => ({ ...t, page_name: pageNameById.get(t.page_id), done: !!t.done })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Annotation attachments ─────────────────────────────────────────────
  // POST /api/apps/:id/pages/:pageId/annotations/:annId/attachments
  // Accepts a single multipart file (image, voice note, screen recording).
  // We reuse the global multer instance from server.js — same disk
  // storage, MIME whitelist, and 100MB cap. The attachment row links
  // back via the new annotation_id column so /uploads/<filename> serves
  // it through the existing static route with the same security headers
  // as ticket attachments.
  app.post(
    '/api/apps/:id/pages/:pageId/annotations/:annId/attachments',
    requireAuth,
    upload.single('file'),
    async (req, res) => {
      try {
        // multer's fileFilter signals rejection via this stash on the req.
        if (req._uploadRejected) {
          const r = req._uploadRejected;
          return res.status(400).json({ error: `Unsupported file type: ${r.name} (${r.mime || 'unknown'})` });
        }
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const result = await loadPageForUser(req.params.pageId, req.session.userId);
        if (result.error) {
          // Best-effort cleanup so a failed access check doesn't leave
          // orphan files on disk.
          tryUnlink(req.file.path);
          return res.status(result.error.status).json({ error: result.error.message });
        }
        if (result.page.app_id !== Number(req.params.id)) {
          tryUnlink(req.file.path);
          return res.status(404).json({ error: 'Page not in this app' });
        }
        const ann = await get(
          'SELECT id FROM app_page_annotations WHERE id=? AND page_id=?',
          Number(req.params.annId), result.page.id
        );
        if (!ann) {
          tryUnlink(req.file.path);
          return res.status(404).json({ error: 'Annotation not found' });
        }

        const me = await get('SELECT name FROM users WHERE id=?', req.session.userId);
        const ins = await run(
          `INSERT INTO attachments (annotation_id, filename, original_name, mime_type, size, uploader)
           VALUES (?,?,?,?,?,?) RETURNING id`,
          ann.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, (me && me.name) || ''
        );
        await touchApp(result.app.id);
        res.status(201).json({
          id: ins.lastInsertRowid,
          name: req.file.originalname,
          url: '/uploads/' + req.file.filename,
          mime_type: req.file.mimetype,
          size: req.file.size,
        });
      } catch (e) {
        if (req.file && req.file.path) tryUnlink(req.file.path);
        res.status(500).json({ error: e.message });
      }
    }
  );

  app.delete('/api/apps/:id/pages/:pageId/annotations/:annId/attachments/:attId', requireAuth, async (req, res) => {
    try {
      const result = await loadPageForUser(req.params.pageId, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      if (result.page.app_id !== Number(req.params.id)) return res.status(404).json({ error: 'Page not in this app' });
      const att = await get(
        'SELECT * FROM attachments WHERE id=? AND annotation_id=?',
        Number(req.params.attId), Number(req.params.annId)
      );
      if (!att) return res.status(404).json({ error: 'Attachment not found' });
      // Only the uploader or an admin can delete. Mirrors how
      // ticket-comment attachments work elsewhere.
      const me = await get('SELECT name, perm_role FROM users WHERE id=?', req.session.userId);
      const isAdmin = me && me.perm_role === 'Admin';
      if (att.uploader !== (me && me.name) && !isAdmin) {
        return res.status(403).json({ error: 'Only the uploader or an admin can delete this attachment' });
      }
      await run('DELETE FROM attachments WHERE id=?', att.id);
      tryUnlink(path.join(UPLOADS_DIR, att.filename));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Per-app tickets ────────────────────────────────────────────────────
  // Lightweight, isolated ticket system scoped to an app. Modelled on the
  // global /api/tickets but with its own table so app dev chatter stays
  // out of the main work queue (per the original feature brief). Anyone
  // with access to the app can create / comment / change status; the
  // closer is recorded for the audit trail.
  app.get('/api/apps/:id/tickets', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      // Optional ?status=open|closed|all filter.
      const filter = String(req.query.status || 'all');
      let where = 't.app_id=?';
      const args = [result.app.id];
      if (filter === 'open') where += " AND t.status NOT IN ('closed', 'resolved')";
      else if (filter === 'closed') where += " AND t.status IN ('closed', 'resolved')";
      const rows = await all(
        `SELECT t.*,
                u.name AS assignee_name,
                c.name AS created_by_name,
                p.name AS page_name,
                (SELECT COUNT(*) FROM app_ticket_comments ac WHERE ac.ticket_id = t.id) AS comment_count
           FROM app_tickets t
           LEFT JOIN users u ON u.id = t.assignee_id
           LEFT JOIN users c ON c.id = t.created_by_id
           LEFT JOIN app_pages p ON p.id = t.page_id
          WHERE ${where}
          ORDER BY
            CASE WHEN t.status IN ('closed','resolved') THEN 1 ELSE 0 END,
            t.id DESC`,
        ...args
      );
      res.json(rows.map(shapeTicket));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/apps/:id/tickets', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const title = String((req.body && req.body.title) || '').trim();
      if (!title) return res.status(400).json({ error: 'Title required' });
      const description = String((req.body && req.body.description) || '').trim();
      const priority = TICKET_PRIORITIES.has(String(req.body && req.body.priority)) ? String(req.body.priority) : 'normal';
      const status = TICKET_STATUSES.has(String(req.body && req.body.status)) ? String(req.body.status) : 'open';
      const assignee = normaliseUserId(req.body && req.body.assignee_id);
      const pageId = normaliseUserId(req.body && req.body.page_id); // reuse helper — same Number-or-null shape
      const ins = await run(
        `INSERT INTO app_tickets (app_id, page_id, title, description, status, priority, assignee_id, created_by_id)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
        result.app.id, pageId, title, description, status, priority, assignee, req.session.userId
      );
      await touchApp(result.app.id);
      const row = await get(
        `SELECT t.*, u.name AS assignee_name, c.name AS created_by_name, p.name AS page_name,
                (SELECT COUNT(*) FROM app_ticket_comments ac WHERE ac.ticket_id = t.id) AS comment_count
           FROM app_tickets t
           LEFT JOIN users u ON u.id = t.assignee_id
           LEFT JOIN users c ON c.id = t.created_by_id
           LEFT JOIN app_pages p ON p.id = t.page_id
          WHERE t.id=?`,
        ins.lastInsertRowid
      );
      res.status(201).json(shapeTicket(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/apps/:id/tickets/:ticketId', requireAuth, async (req, res) => {
    try {
      const t = await loadTicketForUser(req.params.id, req.params.ticketId, req.session.userId);
      if (t.error) return res.status(t.error.status).json({ error: t.error.message });
      const comments = await all(
        `SELECT c.id, c.ticket_id, c.author_id, c.author_name, c.text, c.kind, c.created_at
           FROM app_ticket_comments c
          WHERE c.ticket_id=?
          ORDER BY c.id ASC`,
        t.ticket.id
      );
      const full = await get(
        `SELECT t.*, u.name AS assignee_name, c.name AS created_by_name, p.name AS page_name, cu.name AS closed_by_name,
                (SELECT COUNT(*) FROM app_ticket_comments ac WHERE ac.ticket_id = t.id) AS comment_count
           FROM app_tickets t
           LEFT JOIN users u ON u.id = t.assignee_id
           LEFT JOIN users c ON c.id = t.created_by_id
           LEFT JOIN users cu ON cu.id = t.closed_by_id
           LEFT JOIN app_pages p ON p.id = t.page_id
          WHERE t.id=?`,
        t.ticket.id
      );
      res.json({ ...shapeTicket(full), comments });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/apps/:id/tickets/:ticketId', requireAuth, async (req, res) => {
    try {
      const t = await loadTicketForUser(req.params.id, req.params.ticketId, req.session.userId);
      if (t.error) return res.status(t.error.status).json({ error: t.error.message });
      const cols = []; const args = [];
      const { title, description, status, priority, assignee_id, page_id } = req.body || {};
      if (title !== undefined) {
        const clean = String(title).trim();
        if (!clean) return res.status(400).json({ error: 'Title cannot be empty' });
        cols.push('title=?'); args.push(clean);
      }
      if (description !== undefined) { cols.push('description=?'); args.push(String(description || '').trim()); }
      if (priority !== undefined) {
        if (!TICKET_PRIORITIES.has(String(priority))) return res.status(400).json({ error: 'Invalid priority' });
        cols.push('priority=?'); args.push(String(priority));
      }
      if (assignee_id !== undefined) { cols.push('assignee_id=?'); args.push(normaliseUserId(assignee_id)); }
      if (page_id !== undefined) { cols.push('page_id=?'); args.push(normaliseUserId(page_id)); }
      let logKind = null, logText = null;
      if (status !== undefined) {
        if (!TICKET_STATUSES.has(String(status))) return res.status(400).json({ error: 'Invalid status' });
        const newStatus = String(status);
        cols.push('status=?'); args.push(newStatus);
        if (t.ticket.status !== newStatus) {
          logKind = 'status'; logText = `Status: ${t.ticket.status} → ${newStatus}`;
          // Closing or re-opening — track who/when on the ticket row.
          if ((newStatus === 'closed' || newStatus === 'resolved') && t.ticket.status !== 'closed' && t.ticket.status !== 'resolved') {
            cols.push('closed_by_id=?'); args.push(req.session.userId);
            cols.push("closed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
          } else if (newStatus !== 'closed' && newStatus !== 'resolved' && (t.ticket.status === 'closed' || t.ticket.status === 'resolved')) {
            cols.push('closed_by_id=?'); args.push(null);
            cols.push('closed_at=?'); args.push(null);
          }
        }
      }
      if (cols.length) {
        cols.push("updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
        await run(`UPDATE app_tickets SET ${cols.join(',')} WHERE id=?`, ...args, t.ticket.id);
        await touchApp(t.app.id);
        // Drop a system comment on status changes so the timeline stays
        // self-documenting — same pattern as the global tickets module.
        if (logKind === 'status') {
          const me = await get('SELECT name FROM users WHERE id=?', req.session.userId);
          await run(
            `INSERT INTO app_ticket_comments (ticket_id, author_id, author_name, text, kind) VALUES (?,?,?,?,?)`,
            t.ticket.id, req.session.userId, (me && me.name) || '', logText, 'status'
          );
        }
      }
      const updated = await get(
        `SELECT t.*, u.name AS assignee_name, c.name AS created_by_name, p.name AS page_name, cu.name AS closed_by_name,
                (SELECT COUNT(*) FROM app_ticket_comments ac WHERE ac.ticket_id = t.id) AS comment_count
           FROM app_tickets t
           LEFT JOIN users u ON u.id = t.assignee_id
           LEFT JOIN users c ON c.id = t.created_by_id
           LEFT JOIN users cu ON cu.id = t.closed_by_id
           LEFT JOIN app_pages p ON p.id = t.page_id
          WHERE t.id=?`,
        t.ticket.id
      );
      res.json(shapeTicket(updated));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/apps/:id/tickets/:ticketId', requireAuth, async (req, res) => {
    try {
      const t = await loadTicketForUser(req.params.id, req.params.ticketId, req.session.userId);
      if (t.error) return res.status(t.error.status).json({ error: t.error.message });
      // Only the creator or an admin can delete; everyone else closes via status.
      const isCreator = t.ticket.created_by_id === req.session.userId;
      if (!isCreator && !t.isAdmin) {
        return res.status(403).json({ error: 'Only the creator or an admin can delete this ticket' });
      }
      await run('DELETE FROM app_tickets WHERE id=?', t.ticket.id);
      await touchApp(t.app.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/apps/:id/tickets/:ticketId/comments', requireAuth, async (req, res) => {
    try {
      const t = await loadTicketForUser(req.params.id, req.params.ticketId, req.session.userId);
      if (t.error) return res.status(t.error.status).json({ error: t.error.message });
      const text = String((req.body && req.body.text) || '').trim();
      if (!text) return res.status(400).json({ error: 'Comment text required' });
      if (text.length > 4000) return res.status(400).json({ error: 'Comment too long (max 4000 chars)' });
      const me = await get('SELECT name FROM users WHERE id=?', req.session.userId);
      const ins = await run(
        `INSERT INTO app_ticket_comments (ticket_id, author_id, author_name, text)
         VALUES (?,?,?,?) RETURNING id`,
        t.ticket.id, req.session.userId, (me && me.name) || '', text
      );
      await touchApp(t.app.id);
      const row = await get(
        'SELECT id, ticket_id, author_id, author_name, text, kind, created_at FROM app_ticket_comments WHERE id=?',
        ins.lastInsertRowid
      );
      res.status(201).json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/apps/:id/tickets/:ticketId/comments/:commentId', requireAuth, async (req, res) => {
    try {
      const t = await loadTicketForUser(req.params.id, req.params.ticketId, req.session.userId);
      if (t.error) return res.status(t.error.status).json({ error: t.error.message });
      const c = await get('SELECT * FROM app_ticket_comments WHERE id=? AND ticket_id=?', Number(req.params.commentId), t.ticket.id);
      if (!c) return res.status(404).json({ error: 'Comment not found' });
      if (c.kind === 'status') {
        return res.status(403).json({ error: 'System status events cannot be deleted' });
      }
      if (c.author_id !== req.session.userId && !t.isAdmin) {
        return res.status(403).json({ error: 'Only the author or an admin can delete this comment' });
      }
      await run('DELETE FROM app_ticket_comments WHERE id=?', c.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GitHub sync ────────────────────────────────────────────────────────
  // POST /api/apps/:id/github/test — validate the repo URL + branch +
  // optional PAT before saving. Returns { ok, owner, repo, branch,
  // head_sha, file_count } on success, or { error } on failure.
  app.post('/api/apps/:id/github/test', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const repoUrl = String((req.body && req.body.repo_url) || result.app.repo_url || '');
      const branch = String((req.body && req.body.repo_branch) || result.app.repo_branch || 'main');
      const repoPath = String((req.body && req.body.repo_path) || result.app.repo_path || '');
      const token = (req.body && req.body.repo_token !== undefined)
        ? String(req.body.repo_token || '')
        : String(result.app.repo_token || '');
      const parsed = parseRepoUrl(repoUrl);
      if (!parsed) return res.status(400).json({ error: 'Invalid GitHub repo URL — expected https://github.com/<owner>/<repo>' });
      const branchInfo = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(branch)}`, token);
      const headSha = branchInfo.commit && branchInfo.commit.sha;
      const tree = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${headSha}?recursive=1`, token);
      const htmlFiles = (tree.tree || []).filter(n => n.type === 'blob' && /\.html?$/i.test(n.path) && (!repoPath || n.path.startsWith(repoPath.replace(/^\/|\/$/g, '') + '/')));
      res.json({
        ok: true,
        owner: parsed.owner,
        repo: parsed.repo,
        branch,
        head_sha: headSha,
        file_count: htmlFiles.length,
        files: htmlFiles.slice(0, 20).map(f => ({ path: f.path, sha: f.sha, size: f.size })),
      });
    } catch (e) {
      console.warn('[apps/github] test failed:', e && e.message);
      res.status(e.statusCode || 400).json({ error: e.message || 'GitHub check failed' });
    }
  });

  // POST /api/apps/:id/github/sync — pull HTML files from the configured
  // repo and upsert them as app_pages. GitHub is treated as the source
  // of truth: content + file_name + page name get overwritten, but
  // pin annotations, Q&A comments, todos, function checklists and
  // tickets all stay attached to their page row because we match by
  // repo_path (so the page id is stable across syncs).
  app.post('/api/apps/:id/github/sync', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      const out = await syncAppFromGithub(result.app, { manual: true });
      res.json(out);
    } catch (e) {
      console.warn('[apps/github] sync failed:', e && e.message);
      res.status(e.statusCode || 500).json({ error: e.message || 'Sync failed' });
    }
  });

  // GET /api/apps/:id/github/status — last sync info for the dashboard.
  app.get('/api/apps/:id/github/status', requireAuth, async (req, res) => {
    try {
      const result = await loadAppForUser(req.params.id, req.session.userId);
      if (result.error) return res.status(result.error.status).json({ error: result.error.message });
      res.json({
        connected: !!result.app.repo_url,
        repo_url: result.app.repo_url || '',
        repo_branch: result.app.repo_branch || 'main',
        repo_path: result.app.repo_path || '',
        repo_token_set: !!(result.app.repo_token && result.app.repo_token.length > 0),
        repo_auto_sync: !!result.app.repo_auto_sync,
        last_sync: result.app.repo_last_sync || null,
        last_sha: result.app.repo_last_sha || null,
        last_status: result.app.repo_last_status || '',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Helpers ────────────────────────────────────────────────────────────
  const ANNOTATION_TYPES = new Set(['question', 'issue', 'broken', 'note']);
  const TICKET_STATUSES = new Set(['open', 'in_progress', 'review', 'resolved', 'closed']);
  const TICKET_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

  function normaliseUserId(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  }

  function tryUnlink(p) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }

  function shapeTicket(r) {
    if (!r) return null;
    return {
      id: r.id,
      app_id: r.app_id,
      page_id: r.page_id,
      page_name: r.page_name,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      assignee_id: r.assignee_id,
      assignee_name: r.assignee_name,
      created_by_id: r.created_by_id,
      created_by_name: r.created_by_name,
      closed_by_id: r.closed_by_id,
      closed_by_name: r.closed_by_name,
      closed_at: r.closed_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      comment_count: Number(r.comment_count || 0),
    };
  }

  // Load a ticket + its app + the caller's access. Same pattern as
  // loadAppForUser / loadPageForUser — single point that returns either
  // { error: { status, message } } or { app, ticket, isAdmin } so route
  // handlers stay flat.
  async function loadTicketForUser(appId, ticketId, userId) {
    const tid = Number(ticketId);
    if (!Number.isFinite(tid) || tid < 1) return { error: { status: 400, message: 'Invalid ticket id' } };
    const t = await get('SELECT * FROM app_tickets WHERE id=?', tid);
    if (!t) return { error: { status: 404, message: 'Ticket not found' } };
    if (t.app_id !== Number(appId)) return { error: { status: 404, message: 'Ticket not in this app' } };
    const check = await loadAppForUser(t.app_id, userId);
    if (check.error) return check;
    return { app: check.app, ticket: t, isAdmin: check.isAdmin };
  }

  function clampPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
  }

  // Bump the parent app's updated_at so the list re-orders after activity.
  async function touchApp(appId) {
    await run(
      "UPDATE apps SET updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?",
      appId
    );
  }

  // Single point where we talk to the Anthropic API. Returns the text body
  // or throws an Error with statusCode set on it for the caller to map to
  // an HTTP response. Used by the blueprint generate, translate, and
  // background auto-generate flows.
  async function callAnthropic(systemPrompt, userMessage, maxTokens) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens || 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.warn('[apps anthropic]', r.status, errBody.slice(0, 300));
      const err = new Error('AI service returned ' + r.status);
      err.statusCode = 502;
      throw err;
    }
    const data = await r.json();
    return (data.content?.[0]?.text || '').trim();
  }

  // Build the user prompt + run the Anthropic call for a blueprint. The
  // page row is the only input; the HTML is truncated to 60k chars to
  // stay well under context limits and keep latency predictable.
  async function generateBlueprintFromPage(page) {
    const html = String(page.html_content || '').slice(0, 60000);
    if (!html.trim()) {
      const err = new Error('No HTML to analyse');
      err.statusCode = 400;
      throw err;
    }
    const systemPrompt =
      "You analyse a single HTML page from an app design and write a clear, concise blueprint description for the developer who will build it. " +
      "Cover (1) the purpose of the page, (2) the main sections / regions visible, (3) the interactive elements (forms, buttons, links) and what each should do, and (4) any data that needs to load or save. " +
      "Use short paragraphs and bullets where helpful. Write directly — no preamble, no 'here is', no meta-commentary. " +
      "Stay under 250 words. Return ONLY the blueprint text.";
    return await callAnthropic(
      systemPrompt,
      `Page title: ${page.name}\nFile: ${page.file_name || '(pasted)'}\n\nHTML:\n${html}`,
      1024
    );
  }

  // Background blueprint generation kicked off after page creation. Only
  // writes the result if the blueprint is still empty — guards against a
  // race where the user typed something between create + completion.
  async function autoGenerateBlueprint(pageId) {
    const page = await get('SELECT * FROM app_pages WHERE id=?', pageId);
    if (!page) return;
    if (page.blueprint && page.blueprint.trim()) return;
    const draft = await generateBlueprintFromPage(page);
    if (!draft) return;
    // Conditional UPDATE — only set if still blank. If someone wrote one
    // by hand while we were waiting, theirs wins.
    await run(
      "UPDATE app_pages SET blueprint=?, blueprint_bn='', updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=? AND COALESCE(blueprint, '') = ''",
      draft, pageId
    );
  }

  // ── GitHub helpers ─────────────────────────────────────────────────────
  // Parse a github.com URL (with or without .git suffix, with or without
  // trailing path) into { owner, repo }. Returns null on anything that
  // doesn't look like a github URL.
  function parseRepoUrl(url) {
    if (!url) return null;
    // Accept formats: https://github.com/o/r, https://github.com/o/r.git,
    // git@github.com:o/r.git, github.com/o/r
    const m = String(url).trim().match(/(?:github\.com[\/:])([^\/]+)\/([^\/\.?#\s]+)(?:\.git)?(?:[\/?#]|$)/i);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  }

  // Fire a single request against the GitHub REST API. Token is optional
  // (anonymous requests work for public repos at 60/hr). Errors carry an
  // HTTP-style statusCode so route handlers can pass it through.
  async function ghFetch(path, token, opts) {
    const url = path.startsWith('http') ? path : ('https://api.github.com' + path);
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'syruvia-apps-sync',
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(url, Object.assign({ headers }, opts || {}));
    if (!r.ok) {
      let msg = 'GitHub API ' + r.status;
      try {
        const j = await r.json();
        if (j && j.message) msg = j.message;
        // Surface rate-limit hits with a useful next-step.
        if (r.status === 403 && /rate limit/i.test(j && j.message || '')) {
          msg = 'GitHub rate limit hit. Add a Personal Access Token to raise the cap from 60/hr to 5000/hr.';
        }
        if (r.status === 404) msg = 'Repo or branch not found (check URL, branch name, and token permissions).';
      } catch {}
      const err = new Error(msg);
      err.statusCode = r.status;
      throw err;
    }
    return r.json();
  }

  // The core sync. Idempotent: re-runs over the same repo state are a
  // no-op (we short-circuit when the branch head SHA matches what we
  // saw last time, and per-file we skip when the blob SHA hasn't moved).
  // Returns a summary { ok, head_sha, added, updated, unchanged, removed,
  // skipped, files: [...] } for the caller to surface.
  async function syncAppFromGithub(appRow, opts) {
    opts = opts || {};
    const parsed = parseRepoUrl(appRow.repo_url || '');
    if (!parsed) {
      await recordSync(appRow.id, 'No repo URL configured', null);
      const err = new Error('No repo URL configured for this app');
      err.statusCode = 400;
      throw err;
    }
    const branch = appRow.repo_branch || 'main';
    const repoPath = String(appRow.repo_path || '').replace(/^\/|\/$/g, '');
    const token = appRow.repo_token || '';

    let branchInfo;
    try {
      branchInfo = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(branch)}`, token);
    } catch (e) {
      await recordSync(appRow.id, e.message, appRow.repo_last_sha || null);
      throw e;
    }
    const headSha = branchInfo.commit && branchInfo.commit.sha;
    if (!headSha) {
      await recordSync(appRow.id, 'No HEAD commit on branch', null);
      const err = new Error('Could not resolve branch HEAD'); err.statusCode = 500; throw err;
    }

    // Branch hasn't moved since last sync → nothing to do. Only short
    // circuit when this isn't a manual sync request, so a "Sync now"
    // click can still verify the connection works.
    if (!opts.manual && appRow.repo_last_sha === headSha) {
      await recordSync(appRow.id, 'ok (no changes)', headSha);
      return { ok: true, head_sha: headSha, unchanged_branch: true, added: 0, updated: 0, unchanged: 0, removed: 0 };
    }

    const tree = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${headSha}?recursive=1`, token);
    const htmlNodes = (tree.tree || []).filter(n =>
      n.type === 'blob' &&
      /\.html?$/i.test(n.path) &&
      (!repoPath || n.path === repoPath || n.path.startsWith(repoPath + '/'))
    );
    // Truncated trees on huge repos: warn the user up-front instead of
    // silently syncing a partial set.
    if (tree.truncated) {
      console.warn('[apps/github] tree truncated for app', appRow.id, '— some files may be missing');
    }

    const existing = await all(
      'SELECT id, repo_path, repo_file_sha, source FROM app_pages WHERE app_id=?',
      appRow.id
    );
    const byRepoPath = new Map();
    for (const p of existing) {
      if (p.repo_path) byRepoPath.set(p.repo_path, p);
    }
    const seen = new Set();
    let added = 0, updated = 0, unchanged = 0;
    const detail = [];
    for (const node of htmlNodes) {
      seen.add(node.path);
      const prev = byRepoPath.get(node.path);
      if (prev && prev.repo_file_sha === node.sha) {
        unchanged++;
        detail.push({ path: node.path, action: 'unchanged' });
        // Page already exists with this exact blob; make sure it's not
        // marked as repo_removed (in case it was removed-then-re-added).
        await run('UPDATE app_pages SET repo_removed=0 WHERE id=?', prev.id);
        continue;
      }
      let blob;
      try {
        blob = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}/git/blobs/${node.sha}`, token);
      } catch (e) {
        detail.push({ path: node.path, action: 'error', error: e.message });
        continue;
      }
      const content = blob.encoding === 'base64'
        ? Buffer.from(blob.content || '', 'base64').toString('utf8')
        : (blob.content || '');
      // Soft cap matches the manual-create endpoint.
      if (content.length > 2 * 1024 * 1024) {
        detail.push({ path: node.path, action: 'error', error: 'File too large (>2MB)' });
        continue;
      }
      // File name = basename of the path. Page name = a cleaned-up
      // version (drop extension, replace separators with spaces).
      const baseName = node.path.split('/').pop();
      const niceName = baseName.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim() || baseName;

      if (prev) {
        // GitHub wins: overwrite content + names + invalidate blueprint
        // cache. Comments / pins / todos / functions / tickets stay
        // because they FK to the page id, which doesn't change.
        await run(
          `UPDATE app_pages SET
             html_content=?,
             file_name=?,
             name=?,
             blueprint='',
             blueprint_bn='',
             source='github',
             repo_file_sha=?,
             repo_removed=0,
             updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
           WHERE id=?`,
          content, baseName, niceName, node.sha, prev.id
        );
        updated++;
        detail.push({ path: node.path, action: 'updated', id: prev.id });
        // Re-run auto-blueprint in the background — fresh HTML means a
        // fresh draft.
        if (ANTHROPIC_API_KEY) {
          autoGenerateBlueprint(prev.id).catch(e => console.warn('[apps/github] auto-blueprint failed for page ' + prev.id + ':', e.message));
        }
      } else {
        const nextPos = await get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM app_pages WHERE app_id=?', appRow.id);
        const ins = await run(
          `INSERT INTO app_pages (app_id, name, file_name, html_content, position, source, repo_path, repo_file_sha, created_by)
           VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
          appRow.id, niceName, baseName, content, Number(nextPos?.next || 0), 'github', node.path, node.sha, appRow.created_by
        );
        added++;
        detail.push({ path: node.path, action: 'added', id: ins.lastInsertRowid });
        if (ANTHROPIC_API_KEY) {
          autoGenerateBlueprint(ins.lastInsertRowid).catch(e => console.warn('[apps/github] auto-blueprint failed for page ' + ins.lastInsertRowid + ':', e.message));
        }
      }
    }

    // Mark previously-synced files that are no longer in the repo. We
    // don't delete them — pin comments / todos / tickets may still be
    // useful — just flag them so the UI can render a "removed from repo"
    // badge and the user can clean up manually.
    let removed = 0;
    for (const p of existing) {
      if (p.source === 'github' && p.repo_path && !seen.has(p.repo_path)) {
        await run('UPDATE app_pages SET repo_removed=1 WHERE id=?', p.id);
        removed++;
      }
    }

    await touchApp(appRow.id);
    await recordSync(appRow.id, 'ok', headSha);
    return { ok: true, head_sha: headSha, added, updated, unchanged, removed, total: htmlNodes.length, truncated: !!tree.truncated, detail };
  }

  async function recordSync(appId, status, sha) {
    const cols = ["repo_last_sync=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')", 'repo_last_status=?'];
    const args = [String(status || '').slice(0, 500)];
    if (sha !== null && sha !== undefined) { cols.push('repo_last_sha=?'); args.push(sha); }
    await run(`UPDATE apps SET ${cols.join(',')} WHERE id=?`, ...args, appId);
  }

  // ── Background poller ─────────────────────────────────────────────────
  // Every 5 minutes, sync each app that has repo_auto_sync = 1. Apps
  // sync serially with a tiny delay between them so a workspace with
  // many connected repos doesn't burst the GitHub API. Each sync is
  // independently guarded — one failure doesn't stop the rest.
  //
  // We only start the loop once per process (guarded with a global flag
  // on the app object) because routes/apps.js is required exactly once
  // by server.js but the hot-reload pattern in development can re-run
  // the attach function.
  if (!app.__appsPollerStarted) {
    app.__appsPollerStarted = true;
    const POLL_INTERVAL_MS = 5 * 60 * 1000;
    setInterval(runPollerOnce, POLL_INTERVAL_MS).unref?.();
    // Run shortly after boot too, so users don't have to wait the full
    // 5 minutes after a deploy for the first auto-sync.
    setTimeout(runPollerOnce, 30 * 1000).unref?.();
  }
  async function runPollerOnce() {
    try {
      const apps = await all("SELECT * FROM apps WHERE deleted_at IS NULL AND COALESCE(repo_auto_sync, 0) = 1 AND COALESCE(repo_url, '') <> ''");
      for (const a of apps) {
        try {
          await syncAppFromGithub(a, { manual: false });
        } catch (e) {
          console.warn('[apps/github] poll sync failed for app', a.id, ':', e && e.message);
        }
        // Tiny breather between apps so a workspace with many connected
        // repos doesn't fire GitHub calls back-to-back-to-back.
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      console.warn('[apps/github] poller error:', e && e.message);
    }
  }
};
