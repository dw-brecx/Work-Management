// ─────────────────────────────────────────────────────────────────────────────
// Flavor Reviews — REST API
//
// Manages an in-market flavor catalog (separate from flavors_v2, which is the
// launch wizard), the reviews that come in from sales channels, and the
// "issues" that bad reviews spawn. Reviewer works a calendar of "cycles" that
// the system auto-schedules per cadence and AI-bumps when bad reviews pile up.
//
// All endpoints are auth-gated. Mutations are open to any logged-in user —
// this is a small operations team. Tighten with requireAdmin if you ever
// need to.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function attach(app, deps) {
  const { get, all, run, requireAuth } = deps;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
  const aiReady = !!ANTHROPIC_API_KEY;

  const KINDS = ['coffee', 'cocktail', 'fruit', 'tea', 'latte', 'smoothie', 'unique', 'other'];
  const VARIANTS = ['regular', 'sugar_free'];
  const SEVERITIES = ['low', 'medium', 'high', 'critical'];

  const todayUtc = () => new Date().toISOString().slice(0, 10);
  const addMonthsIso = (iso, months) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  };

  // ── Flavors ─────────────────────────────────────────────────────────────
  function validateFlavor(body) {
    const errors = [];
    const name = String(body.name || '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 120) errors.push('name too long');
    const kind = String(body.kind || 'other').trim();
    if (!KINDS.includes(kind)) errors.push('kind must be one of: ' + KINDS.join(', '));
    const variant = String(body.variant || 'regular').trim();
    if (!VARIANTS.includes(variant)) errors.push('variant must be regular or sugar_free');
    const notes = String(body.notes || '').slice(0, 4000);
    const status = ['active', 'discontinued'].includes(body.status) ? body.status : 'active';
    return { errors, clean: { name, kind, variant, notes, status } };
  }

  function shapeFlavor(row, extras) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      variant: row.variant,
      notes: row.notes || '',
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(extras || {}),
    };
  }

  app.get('/api/flavor-reviews/flavors', requireAuth, async (req, res) => {
    try {
      const rows = await all(`SELECT * FROM fr_flavors ORDER BY name ASC`);
      // Tally per-flavor counts for the list view chips.
      const counts = await all(`
        SELECT f.id,
          (SELECT COUNT(*) FROM fr_issues   i WHERE i.flavor_id=f.id AND i.status='open')          AS open_issues,
          (SELECT COUNT(*) FROM fr_reviews  r WHERE r.flavor_id=f.id AND r.rating > 0 AND r.rating <= 2 AND r.status='open') AS open_bad,
          (SELECT COUNT(*) FROM fr_reviews  r WHERE r.flavor_id=f.id)                              AS total_reviews,
          (SELECT scheduled_for FROM fr_cycles c WHERE c.flavor_id=f.id AND c.status='scheduled'
             ORDER BY scheduled_for ASC LIMIT 1)                                                   AS next_cycle,
          (SELECT COUNT(*) FROM fr_flavor_links l WHERE l.flavor_id=f.id)                          AS link_count
        FROM fr_flavors f
      `);
      const m = new Map();
      for (const c of counts) m.set(c.id, c);
      res.json(rows.map(r => shapeFlavor(r, {
        open_issues: Number(m.get(r.id)?.open_issues || 0),
        open_bad: Number(m.get(r.id)?.open_bad || 0),
        total_reviews: Number(m.get(r.id)?.total_reviews || 0),
        next_cycle: m.get(r.id)?.next_cycle || '',
        link_count: Number(m.get(r.id)?.link_count || 0),
      })));
    } catch (e) {
      console.error('[fr] flavors list failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/flavor-reviews/flavors', requireAuth, async (req, res) => {
    try {
      const { errors, clean } = validateFlavor(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      const dup = await get(
        'SELECT id FROM fr_flavors WHERE LOWER(name)=LOWER(?) AND variant=?',
        clean.name, clean.variant
      );
      if (dup) return res.status(409).json({ error: 'A flavor with that name and variant already exists.' });
      const ins = await run(
        `INSERT INTO fr_flavors (name, kind, variant, notes, status, created_by)
         VALUES (?,?,?,?,?,?) RETURNING id`,
        clean.name, clean.kind, clean.variant, clean.notes, clean.status, req.session.userId
      );
      const row = await get('SELECT * FROM fr_flavors WHERE id=?', ins.lastInsertRowid);
      await maybeAutoSchedule(row.id);
      res.status(201).json(shapeFlavor(row));
    } catch (e) {
      console.error('[fr] flavor create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/flavor-reviews/flavors/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const row = await get('SELECT * FROM fr_flavors WHERE id=?', id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      const links = await all(
        'SELECT * FROM fr_flavor_links WHERE flavor_id=? ORDER BY position ASC, id ASC', id
      );
      const reviews = await all(
        `SELECT r.*, i.title AS issue_title, i.status AS issue_status
           FROM fr_reviews r LEFT JOIN fr_issues i ON i.id = r.issue_id
          WHERE r.flavor_id=?
          ORDER BY COALESCE(NULLIF(r.posted_at,''), r.created_at) DESC`, id
      );
      const issues = await all(
        `SELECT i.*,
                (SELECT COUNT(*) FROM fr_reviews r WHERE r.issue_id=i.id) AS review_count,
                (SELECT name FROM fr_flavors WHERE id=i.flavor_id) AS flavor_name
           FROM fr_issues i
          WHERE i.flavor_id=?
          ORDER BY
            CASE i.status WHEN 'open' THEN 0 WHEN 'merged' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END,
            i.created_at DESC`, id
      );
      const cycles = await all(
        `SELECT * FROM fr_cycles WHERE flavor_id=? ORDER BY scheduled_for DESC`, id
      );
      res.json({
        ...shapeFlavor(row),
        links: links.map(shapeLink),
        reviews: reviews.map(shapeReview),
        issues: issues.map(shapeIssue),
        cycles: cycles.map(shapeCycle),
      });
    } catch (e) {
      console.error('[fr] flavor detail failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/flavor-reviews/flavors/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM fr_flavors WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const merged = {
        name:    'name'    in req.body ? req.body.name    : existing.name,
        kind:    'kind'    in req.body ? req.body.kind    : existing.kind,
        variant: 'variant' in req.body ? req.body.variant : existing.variant,
        notes:   'notes'   in req.body ? req.body.notes   : existing.notes,
        status:  'status'  in req.body ? req.body.status  : existing.status,
      };
      const { errors, clean } = validateFlavor(merged);
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      await run(
        `UPDATE fr_flavors SET name=?, kind=?, variant=?, notes=?, status=?,
            updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          WHERE id=?`,
        clean.name, clean.kind, clean.variant, clean.notes, clean.status, id
      );
      const row = await get('SELECT * FROM fr_flavors WHERE id=?', id);
      res.json(shapeFlavor(row));
    } catch (e) {
      console.error('[fr] flavor patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/flavor-reviews/flavors/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM fr_flavors WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Bulk import (CSV / TSV paste) ────────────────────────────────────────
  // Accepts a text blob. Sniffs the delimiter (tab vs comma) and the optional
  // header row. Columns: name, kind, variant, notes, links.
  // links column is "Channel|URL;Channel|URL;..." for any number of channels.
  // Validates per-row; returns counts so the UI can render a summary.
  app.post('/api/flavor-reviews/flavors/bulk-import', requireAuth, async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'No text to import.' });
      const parsed = parseDelimited(text);
      if (!parsed.rows.length) return res.status(400).json({ error: 'No rows found.' });

      const created = []; const skipped = []; const errors = [];
      for (let i = 0; i < parsed.rows.length; i++) {
        const r = parsed.rows[i];
        const name = (r.name || '').trim();
        if (!name) { errors.push({ row: i + 1, reason: 'missing name' }); continue; }
        const kind    = KINDS.includes(r.kind) ? r.kind : 'other';
        const variant = VARIANTS.includes(r.variant) ? r.variant : 'regular';
        const notes   = String(r.notes || '');
        try {
          const dup = await get(
            'SELECT id FROM fr_flavors WHERE LOWER(name)=LOWER(?) AND variant=?',
            name, variant
          );
          if (dup) { skipped.push({ row: i + 1, name, reason: 'already exists' }); continue; }
          const ins = await run(
            `INSERT INTO fr_flavors (name, kind, variant, notes, created_by)
             VALUES (?,?,?,?,?) RETURNING id`,
            name, kind, variant, notes, req.session.userId
          );
          const newId = ins.lastInsertRowid;
          // Parse links column if present (semicolon-separated "channel|url").
          const linksRaw = String(r.links || '').trim();
          if (linksRaw) {
            const pieces = linksRaw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
            let pos = 0;
            for (const piece of pieces) {
              const [chRaw, urlRaw] = piece.split('|');
              const ch = (chRaw || '').trim();
              const url = (urlRaw || '').trim();
              if (!ch || !url) continue;
              await run(
                `INSERT INTO fr_flavor_links (flavor_id, channel, url, position)
                 VALUES (?,?,?,?)`,
                newId, ch.slice(0, 60), url.slice(0, 1000), pos++
              );
            }
          }
          await maybeAutoSchedule(newId);
          created.push({ row: i + 1, id: newId, name });
        } catch (e) {
          errors.push({ row: i + 1, reason: e.message });
        }
      }
      res.json({ created, skipped, errors, total: parsed.rows.length });
    } catch (e) {
      console.error('[fr] bulk import failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Parse a CSV-or-TSV blob. Auto-detects delimiter from the first line.
  // Header row is required. Returns rows keyed by lower-snake-cased headers.
  function parseDelimited(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length > 0);
    if (!lines.length) return { rows: [], headers: [] };
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const splitLine = (line) => {
      if (delim === '\t') return line.split('\t');
      // RFC4180-lite CSV: respect double-quotes, "" → "
      const out = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQ = false;
          else cur += c;
        } else {
          if (c === ',') { out.push(cur); cur = ''; }
          else if (c === '"' && cur === '') inQ = true;
          else cur += c;
        }
      }
      out.push(cur);
      return out;
    };
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const headers = splitLine(lines[0]).map(norm);
    const rows = [];
    for (let li = 1; li < lines.length; li++) {
      const parts = splitLine(lines[li]);
      const row = {};
      for (let ci = 0; ci < headers.length; ci++) row[headers[ci]] = (parts[ci] || '').trim();
      rows.push(row);
    }
    return { rows, headers };
  }

  // ── Flavor links ─────────────────────────────────────────────────────────
  function shapeLink(row) {
    return {
      id: row.id, flavor_id: row.flavor_id,
      channel: row.channel, url: row.url, notes: row.notes,
      position: row.position, created_at: row.created_at,
    };
  }

  app.post('/api/flavor-reviews/flavors/:id/links', requireAuth, async (req, res) => {
    try {
      const flavorId = Number(req.params.id);
      if (!Number.isFinite(flavorId)) return res.status(400).json({ error: 'Bad id' });
      const channel = String(req.body?.channel || '').trim().slice(0, 60);
      const url     = String(req.body?.url || '').trim().slice(0, 1000);
      const notes   = String(req.body?.notes || '').slice(0, 1000);
      if (!channel || !url) return res.status(400).json({ error: 'channel and url required' });
      const maxPos = await get('SELECT MAX(position) AS p FROM fr_flavor_links WHERE flavor_id=?', flavorId);
      const pos = Number(maxPos?.p || -1) + 1;
      const ins = await run(
        `INSERT INTO fr_flavor_links (flavor_id, channel, url, notes, position)
         VALUES (?,?,?,?,?) RETURNING id`,
        flavorId, channel, url, notes, pos
      );
      const row = await get('SELECT * FROM fr_flavor_links WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapeLink(row));
    } catch (e) {
      console.error('[fr] link create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/flavor-reviews/links/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM fr_flavor_links WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const sets = []; const args = [];
      if ('channel' in req.body) { sets.push('channel=?'); args.push(String(req.body.channel || '').slice(0, 60)); }
      if ('url' in req.body)     { sets.push('url=?');     args.push(String(req.body.url || '').slice(0, 1000)); }
      if ('notes' in req.body)   { sets.push('notes=?');   args.push(String(req.body.notes || '').slice(0, 1000)); }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      args.push(id);
      await run(`UPDATE fr_flavor_links SET ${sets.join(',')} WHERE id=?`, ...args);
      const row = await get('SELECT * FROM fr_flavor_links WHERE id=?', id);
      res.json(shapeLink(row));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/flavor-reviews/links/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM fr_flavor_links WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Reviews ──────────────────────────────────────────────────────────────
  function classifySentiment(rating) {
    if (!rating) return '';
    if (rating <= 2) return 'negative';
    if (rating === 3) return 'neutral';
    return 'positive';
  }

  function shapeReview(row) {
    return {
      id: row.id,
      flavor_id: row.flavor_id,
      source: row.source,
      source_review_id: row.source_review_id || '',
      rating: row.rating,
      reviewer_name: row.reviewer_name,
      title: row.title,
      body: row.body,
      url: row.url,
      posted_at: row.posted_at,
      sentiment: row.sentiment,
      ai_summary: row.ai_summary,
      status: row.status,
      issue_id: row.issue_id || null,
      issue_title: row.issue_title || null,
      issue_status: row.issue_status || null,
      created_at: row.created_at,
    };
  }

  function validateReview(body) {
    const errors = [];
    const source = String(body.source || '').trim().slice(0, 60);
    if (!source) errors.push('source required');
    const rating = Math.max(0, Math.min(5, parseInt(body.rating, 10) || 0));
    const reviewer_name = String(body.reviewer_name || '').slice(0, 120);
    const title = String(body.title || '').slice(0, 200);
    const review_body = String(body.body || '').slice(0, 10000);
    const url = String(body.url || '').slice(0, 1000);
    const posted_at = String(body.posted_at || '').slice(0, 10);
    if (posted_at && !/^\d{4}-\d{2}-\d{2}$/.test(posted_at)) errors.push('posted_at must be YYYY-MM-DD');
    const source_review_id = String(body.source_review_id || '').slice(0, 200);
    return { errors, clean: { source, source_review_id, rating, reviewer_name, title, body: review_body, url, posted_at } };
  }

  app.post('/api/flavor-reviews/flavors/:id/reviews', requireAuth, async (req, res) => {
    try {
      const flavorId = Number(req.params.id);
      if (!Number.isFinite(flavorId)) return res.status(400).json({ error: 'Bad id' });
      const { errors, clean } = validateReview(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });

      // Soft dedup against an already-addressed identical review
      // (same source + reviewer_name + body for the same flavor).
      if (clean.source_review_id) {
        const dup = await get(
          'SELECT id, status, issue_id FROM fr_reviews WHERE flavor_id=? AND source=? AND source_review_id=?',
          flavorId, clean.source, clean.source_review_id
        );
        if (dup) return res.status(200).json({ duplicate: true, existing_id: dup.id, existing_status: dup.status });
      }

      const sentiment = classifySentiment(clean.rating);
      // Auto-link to the most recent OPEN issue for this flavor if the body
      // looks similar — string-based prefilter to avoid an AI call per review.
      // The dedicated "find duplicates" AI endpoint covers the harder cases.
      const ins = await run(
        `INSERT INTO fr_reviews
           (flavor_id, source, source_review_id, rating, reviewer_name, title, body, url, posted_at, sentiment, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        flavorId, clean.source, clean.source_review_id, clean.rating,
        clean.reviewer_name, clean.title, clean.body, clean.url, clean.posted_at,
        sentiment, req.session.userId
      );
      const row = await get('SELECT * FROM fr_reviews WHERE id=?', ins.lastInsertRowid);

      // If a bad review came in and this flavor has cycles scheduled, bump
      // the priority on the next scheduled cycle so the calendar surfaces it.
      if (sentiment === 'negative') await bumpNextCyclePriority(flavorId);

      res.status(201).json(shapeReview(row));
    } catch (e) {
      console.error('[fr] review create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Attach a review to a new or existing issue. Status flows here:
  //   review.status: open → addressed (when issue_id is set)
  // Doesn't change issue lifecycle — that's done via the issue endpoints.
  app.patch('/api/flavor-reviews/reviews/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM fr_reviews WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const sets = []; const args = [];
      if ('status' in req.body) {
        const s = String(req.body.status || '').trim();
        if (!['open', 'addressed', 'ignored'].includes(s)) return res.status(400).json({ error: 'Bad status' });
        sets.push('status=?'); args.push(s);
      }
      if ('issue_id' in req.body) {
        const iid = req.body.issue_id == null ? null : Number(req.body.issue_id);
        sets.push('issue_id=?'); args.push(iid);
        if (iid && !sets.find(s => s.startsWith('status'))) {
          sets.push('status=?'); args.push('addressed');
        }
      }
      if ('ai_summary' in req.body) {
        sets.push('ai_summary=?'); args.push(String(req.body.ai_summary || '').slice(0, 4000));
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      args.push(id);
      await run(`UPDATE fr_reviews SET ${sets.join(',')} WHERE id=?`, ...args);
      const row = await get('SELECT * FROM fr_reviews WHERE id=?', id);
      res.json(shapeReview(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Issues ───────────────────────────────────────────────────────────────
  function shapeIssue(row) {
    return {
      id: row.id,
      flavor_id: row.flavor_id,
      flavor_name: row.flavor_name || null,
      title: row.title,
      summary: row.summary,
      severity: row.severity,
      status: row.status,
      resolution: row.resolution || '',
      merged_into_id: row.merged_into_id || null,
      fixed_at: row.fixed_at || null,
      fixed_by: row.fixed_by || null,
      ignored_at: row.ignored_at || null,
      ignored_reason: row.ignored_reason || '',
      review_count: Number(row.review_count || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  app.post('/api/flavor-reviews/flavors/:id/issues', requireAuth, async (req, res) => {
    try {
      const flavorId = Number(req.params.id);
      if (!Number.isFinite(flavorId)) return res.status(400).json({ error: 'Bad id' });
      const title = String(req.body?.title || '').trim().slice(0, 200);
      const summary = String(req.body?.summary || '').slice(0, 4000);
      const severity = SEVERITIES.includes(req.body?.severity) ? req.body.severity : 'medium';
      const fromReviewIds = Array.isArray(req.body?.from_review_ids) ? req.body.from_review_ids.map(Number).filter(Number.isFinite) : [];
      if (!title) return res.status(400).json({ error: 'title required' });
      const ins = await run(
        `INSERT INTO fr_issues (flavor_id, title, summary, severity, created_by)
         VALUES (?,?,?,?,?) RETURNING id`,
        flavorId, title, summary, severity, req.session.userId
      );
      const issueId = ins.lastInsertRowid;
      for (const rid of fromReviewIds) {
        await run(
          `UPDATE fr_reviews SET issue_id=?, status='addressed',
              updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
            WHERE id=? AND flavor_id=?`,
          issueId, rid, flavorId
        );
      }
      const row = await get(
        `SELECT i.*,
                (SELECT COUNT(*) FROM fr_reviews r WHERE r.issue_id=i.id) AS review_count,
                (SELECT name FROM fr_flavors WHERE id=i.flavor_id) AS flavor_name
           FROM fr_issues i WHERE i.id=?`, issueId
      );
      res.status(201).json(shapeIssue(row));
    } catch (e) {
      console.error('[fr] issue create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/flavor-reviews/issues/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const row = await get(
        `SELECT i.*,
                (SELECT COUNT(*) FROM fr_reviews r WHERE r.issue_id=i.id) AS review_count,
                (SELECT name FROM fr_flavors WHERE id=i.flavor_id) AS flavor_name
           FROM fr_issues i WHERE i.id=?`, id
      );
      if (!row) return res.status(404).json({ error: 'Not found' });
      const reviews = await all(
        `SELECT r.*, NULL AS issue_title, NULL AS issue_status
           FROM fr_reviews r WHERE r.issue_id=?
          ORDER BY COALESCE(NULLIF(r.posted_at,''), r.created_at) DESC`, id
      );
      // Open issues for this flavor — used in the "merge into" picker.
      const mergeCandidates = await all(
        `SELECT id, title, severity, created_at FROM fr_issues
          WHERE flavor_id=? AND status='open' AND id != ?
          ORDER BY created_at DESC`, row.flavor_id, id
      );
      res.json({
        ...shapeIssue(row),
        reviews: reviews.map(shapeReview),
        merge_candidates: mergeCandidates,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Status workflow. Body shapes:
  //   { status: 'fixed', resolution: 'what was done' }
  //   { status: 'ignored', ignored_reason: 'why' }
  //   { status: 'merged', merged_into_id: 123 }
  //   { status: 'open' } — re-open
  // PATCH also accepts title / summary / severity edits when status not given.
  app.patch('/api/flavor-reviews/issues/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM fr_issues WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });

      const sets = []; const args = [];

      if ('title' in req.body) { sets.push('title=?'); args.push(String(req.body.title || '').slice(0, 200)); }
      if ('summary' in req.body) { sets.push('summary=?'); args.push(String(req.body.summary || '').slice(0, 4000)); }
      if ('severity' in req.body && SEVERITIES.includes(req.body.severity)) {
        sets.push('severity=?'); args.push(req.body.severity);
      }

      if ('status' in req.body) {
        const s = String(req.body.status || '').trim();
        if (!['open', 'fixed', 'ignored', 'merged'].includes(s)) return res.status(400).json({ error: 'Bad status' });

        sets.push('status=?'); args.push(s);

        if (s === 'fixed') {
          const resolution = String(req.body.resolution || '').slice(0, 4000);
          if (!resolution) return res.status(400).json({ error: 'resolution required when marking fixed' });
          sets.push('resolution=?'); args.push(resolution);
          sets.push(`fixed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
          sets.push('fixed_by=?'); args.push(req.session.userId);
          sets.push('merged_into_id=NULL');
          sets.push('ignored_at=NULL');
        } else if (s === 'ignored') {
          const reason = String(req.body.ignored_reason || '').slice(0, 1000);
          sets.push('ignored_reason=?'); args.push(reason);
          sets.push(`ignored_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
          sets.push('fixed_at=NULL');
          sets.push('merged_into_id=NULL');
        } else if (s === 'merged') {
          const target = Number(req.body.merged_into_id);
          if (!Number.isFinite(target)) return res.status(400).json({ error: 'merged_into_id required' });
          if (target === id) return res.status(400).json({ error: 'Cannot merge an issue into itself' });
          const dst = await get('SELECT id, flavor_id, status FROM fr_issues WHERE id=?', target);
          if (!dst) return res.status(404).json({ error: 'Target issue not found' });
          if (dst.flavor_id !== existing.flavor_id) {
            return res.status(400).json({ error: 'Target issue belongs to a different flavor' });
          }
          if (dst.status !== 'open') return res.status(400).json({ error: 'Target issue must be open' });
          sets.push('merged_into_id=?'); args.push(target);
          sets.push('fixed_at=NULL');
          sets.push('ignored_at=NULL');
          // Move reviews from this issue → the target. Keeps the receipts
          // attached to the still-open issue so subsequent duplicate
          // detection picks them up.
          await run(`UPDATE fr_reviews SET issue_id=? WHERE issue_id=?`, target, id);
        } else if (s === 'open') {
          sets.push('fixed_at=NULL');
          sets.push('fixed_by=NULL');
          sets.push('ignored_at=NULL');
          sets.push('merged_into_id=NULL');
        }
      }

      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      args.push(id);
      await run(`UPDATE fr_issues SET ${sets.join(',')} WHERE id=?`, ...args);
      const row = await get(
        `SELECT i.*,
                (SELECT COUNT(*) FROM fr_reviews r WHERE r.issue_id=i.id) AS review_count,
                (SELECT name FROM fr_flavors WHERE id=i.flavor_id) AS flavor_name
           FROM fr_issues i WHERE i.id=?`, id
      );
      res.json(shapeIssue(row));
    } catch (e) {
      console.error('[fr] issue patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Cycles (schedule) ────────────────────────────────────────────────────
  function shapeCycle(row) {
    return {
      id: row.id, flavor_id: row.flavor_id, flavor_name: row.flavor_name || null,
      scheduled_for: row.scheduled_for, assigned_to: row.assigned_to || null,
      assignee_name: row.assignee_name || '',
      status: row.status, priority: row.priority, ai_priority_bump: row.ai_priority_bump,
      completed_at: row.completed_at || null, completed_by: row.completed_by || null,
      notes: row.notes || '',
      created_at: row.created_at,
    };
  }

  app.get('/api/flavor-reviews/cycles', requireAuth, async (req, res) => {
    try {
      const month = String(req.query.month || '').trim(); // optional 'YYYY-MM' filter
      let where = '';
      const args = [];
      if (/^\d{4}-\d{2}$/.test(month)) {
        where = `WHERE c.scheduled_for LIKE ?`;
        args.push(month + '-%');
      }
      const rows = await all(
        `SELECT c.*, f.name AS flavor_name, u.name AS assignee_name
           FROM fr_cycles c
           JOIN fr_flavors f ON f.id = c.flavor_id
      LEFT JOIN users u ON u.id = c.assigned_to
          ${where}
       ORDER BY c.scheduled_for ASC, (c.priority + c.ai_priority_bump) DESC`,
        ...args
      );
      res.json(rows.map(shapeCycle));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/flavor-reviews/flavors/:id/cycles', requireAuth, async (req, res) => {
    try {
      const flavorId = Number(req.params.id);
      if (!Number.isFinite(flavorId)) return res.status(400).json({ error: 'Bad id' });
      const scheduled_for = String(req.body?.scheduled_for || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduled_for)) return res.status(400).json({ error: 'scheduled_for must be YYYY-MM-DD' });
      const assigned_to = req.body?.assigned_to ? Number(req.body.assigned_to) : null;
      const priority = Math.max(1, Math.min(5, parseInt(req.body?.priority, 10) || 3));
      const ins = await run(
        `INSERT INTO fr_cycles (flavor_id, scheduled_for, assigned_to, priority)
         VALUES (?,?,?,?) RETURNING id`,
        flavorId, scheduled_for, assigned_to, priority
      );
      const row = await get(
        `SELECT c.*, f.name AS flavor_name, u.name AS assignee_name
           FROM fr_cycles c JOIN fr_flavors f ON f.id=c.flavor_id
      LEFT JOIN users u ON u.id=c.assigned_to
          WHERE c.id=?`, ins.lastInsertRowid
      );
      res.status(201).json(shapeCycle(row));
    } catch (e) {
      console.error('[fr] cycle create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/flavor-reviews/cycles/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM fr_cycles WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const sets = []; const args = [];
      if ('scheduled_for' in req.body) {
        const v = String(req.body.scheduled_for || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: 'scheduled_for must be YYYY-MM-DD' });
        sets.push('scheduled_for=?'); args.push(v);
      }
      if ('assigned_to' in req.body) {
        const a = req.body.assigned_to == null ? null : Number(req.body.assigned_to);
        sets.push('assigned_to=?'); args.push(a);
      }
      if ('priority' in req.body) {
        sets.push('priority=?'); args.push(Math.max(1, Math.min(5, parseInt(req.body.priority, 10) || 3)));
      }
      if ('notes' in req.body) {
        sets.push('notes=?'); args.push(String(req.body.notes || '').slice(0, 4000));
      }
      if ('status' in req.body) {
        const s = String(req.body.status || '').trim();
        if (!['scheduled', 'in_progress', 'done', 'skipped'].includes(s)) return res.status(400).json({ error: 'Bad status' });
        sets.push('status=?'); args.push(s);
        if (s === 'done') {
          sets.push(`completed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
          sets.push('completed_by=?'); args.push(req.session.userId);
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      args.push(id);
      await run(`UPDATE fr_cycles SET ${sets.join(',')} WHERE id=?`, ...args);

      // When marking done, auto-schedule the next cycle per cadence so the
      // calendar never goes empty after a review session.
      if (req.body?.status === 'done') {
        await scheduleNextCycle(existing.flavor_id);
      }

      const row = await get(
        `SELECT c.*, f.name AS flavor_name, u.name AS assignee_name
           FROM fr_cycles c JOIN fr_flavors f ON f.id=c.flavor_id
      LEFT JOIN users u ON u.id=c.assigned_to
          WHERE c.id=?`, id
      );
      res.json(shapeCycle(row));
    } catch (e) {
      console.error('[fr] cycle patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/flavor-reviews/cycles/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM fr_cycles WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function maybeAutoSchedule(flavorId) {
    const s = await get('SELECT * FROM fr_settings WHERE id=1');
    if (!s || !s.auto_schedule) return;
    const open = await get(
      `SELECT id FROM fr_cycles WHERE flavor_id=? AND status='scheduled' ORDER BY scheduled_for ASC LIMIT 1`,
      flavorId
    );
    if (open) return;
    const due = addMonthsIso(todayUtc(), Number(s.cadence_months || 3));
    await run(
      `INSERT INTO fr_cycles (flavor_id, scheduled_for, assigned_to, priority)
       VALUES (?,?,?,?)`,
      flavorId, due, s.default_reviewer_id || null, 3
    );
  }

  async function scheduleNextCycle(flavorId) {
    const s = await get('SELECT * FROM fr_settings WHERE id=1');
    if (!s || !s.auto_schedule) return;
    const due = addMonthsIso(todayUtc(), Number(s.cadence_months || 3));
    await run(
      `INSERT INTO fr_cycles (flavor_id, scheduled_for, assigned_to, priority)
       VALUES (?,?,?,?)`,
      flavorId, due, s.default_reviewer_id || null, 3
    );
  }

  async function bumpNextCyclePriority(flavorId) {
    const s = await get('SELECT * FROM fr_settings WHERE id=1');
    const threshold = Number(s?.bad_review_threshold || 2);
    // Count recent (last 30d) bad reviews. If we've crossed the threshold
    // for the first time, bump priority and (if no scheduled cycle exists)
    // pull one in to today + 14d so the calendar surfaces it.
    const badCount = await get(
      `SELECT COUNT(*) AS n FROM fr_reviews
        WHERE flavor_id=? AND rating > 0 AND rating <= 2
          AND status='open'
          AND COALESCE(NULLIF(posted_at,''), created_at) >=
              TO_CHAR((NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days', 'YYYY-MM-DD')`,
      flavorId
    );
    if (Number(badCount?.n || 0) < threshold) return;
    const cycle = await get(
      `SELECT * FROM fr_cycles WHERE flavor_id=? AND status='scheduled'
        ORDER BY scheduled_for ASC LIMIT 1`,
      flavorId
    );
    if (cycle) {
      // Bump the bump value (capped) and pull the date in if it's far out.
      const newBump = Math.min(2, Number(cycle.ai_priority_bump || 0) + 1);
      const pullIn = (cycle.scheduled_for > addMonthsIso(todayUtc(), 0));
      const sets = ['ai_priority_bump=?'];
      const args = [newBump];
      if (pullIn) {
        sets.push('scheduled_for=?');
        const target = new Date();
        target.setUTCDate(target.getUTCDate() + 7);
        args.push(target.toISOString().slice(0, 10));
      }
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      args.push(cycle.id);
      await run(`UPDATE fr_cycles SET ${sets.join(',')} WHERE id=?`, ...args);
    } else {
      const target = new Date();
      target.setUTCDate(target.getUTCDate() + 7);
      await run(
        `INSERT INTO fr_cycles (flavor_id, scheduled_for, assigned_to, priority, ai_priority_bump)
         VALUES (?,?,?,?,1)`,
        flavorId, target.toISOString().slice(0, 10), s?.default_reviewer_id || null, 4
      );
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get('/api/flavor-reviews/settings', requireAuth, async (req, res) => {
    try {
      const row = await get('SELECT * FROM fr_settings WHERE id=1');
      const team = await all(`SELECT id, name, email FROM users ORDER BY name ASC`);
      res.json({
        cadence_months: Number(row?.cadence_months || 3),
        default_reviewer_id: row?.default_reviewer_id || null,
        bad_review_threshold: Number(row?.bad_review_threshold || 2),
        auto_schedule: !!(row?.auto_schedule ?? 1),
        team,
      });
    } catch (e) {
      console.error('[fr] settings get failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/flavor-reviews/settings', requireAuth, async (req, res) => {
    try {
      const sets = []; const args = [];
      if ('cadence_months' in req.body) {
        const v = Math.max(1, Math.min(36, parseInt(req.body.cadence_months, 10) || 3));
        sets.push('cadence_months=?'); args.push(v);
      }
      if ('default_reviewer_id' in req.body) {
        const a = req.body.default_reviewer_id == null ? null : Number(req.body.default_reviewer_id);
        sets.push('default_reviewer_id=?'); args.push(a);
      }
      if ('bad_review_threshold' in req.body) {
        const v = Math.max(1, Math.min(20, parseInt(req.body.bad_review_threshold, 10) || 2));
        sets.push('bad_review_threshold=?'); args.push(v);
      }
      if ('auto_schedule' in req.body) {
        sets.push('auto_schedule=?'); args.push(req.body.auto_schedule ? 1 : 0);
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      args.push(1);
      await run(`UPDATE fr_settings SET ${sets.join(',')} WHERE id=?`, ...args);
      const row = await get('SELECT * FROM fr_settings WHERE id=1');
      res.json({
        cadence_months: row.cadence_months,
        default_reviewer_id: row.default_reviewer_id,
        bad_review_threshold: row.bad_review_threshold,
        auto_schedule: !!row.auto_schedule,
      });
    } catch (e) {
      console.error('[fr] settings patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Dashboard ────────────────────────────────────────────────────────────
  // Single fan-out endpoint so the dashboard renders in one round trip.
  app.get('/api/flavor-reviews/dashboard', requireAuth, async (req, res) => {
    try {
      const today = todayUtc();
      const totalFlavors = await get('SELECT COUNT(*) AS n FROM fr_flavors WHERE status=\'active\'');
      const openIssues   = await get('SELECT COUNT(*) AS n FROM fr_issues WHERE status=\'open\'');
      const openBadRev   = await get('SELECT COUNT(*) AS n FROM fr_reviews WHERE rating>0 AND rating<=2 AND status=\'open\'');
      const cyclesDue    = await get(`SELECT COUNT(*) AS n FROM fr_cycles WHERE status='scheduled' AND scheduled_for <= ?`, today);

      // Today's queue: scheduled cycles due today or overdue, sorted by AI bump.
      const todayQueue = await all(
        `SELECT c.*, f.name AS flavor_name, f.kind AS flavor_kind, f.variant AS flavor_variant, u.name AS assignee_name
           FROM fr_cycles c
           JOIN fr_flavors f ON f.id=c.flavor_id
      LEFT JOIN users u ON u.id=c.assigned_to
          WHERE c.status='scheduled' AND c.scheduled_for <= ?
       ORDER BY (c.priority + c.ai_priority_bump) DESC, c.scheduled_for ASC
          LIMIT 20`, today
      );

      // AI-prioritised flavors: highest open-bad-review count first.
      const priority = await all(
        `SELECT f.id, f.name, f.kind, f.variant,
                COUNT(r.id) AS bad_count,
                MAX(r.posted_at) AS last_bad_at
           FROM fr_flavors f
           JOIN fr_reviews r ON r.flavor_id=f.id
          WHERE r.rating > 0 AND r.rating <= 2 AND r.status='open'
          GROUP BY f.id
          ORDER BY bad_count DESC, last_bad_at DESC
          LIMIT 10`
      );

      const recentIssues = await all(
        `SELECT i.*,
                (SELECT COUNT(*) FROM fr_reviews r WHERE r.issue_id=i.id) AS review_count,
                (SELECT name FROM fr_flavors WHERE id=i.flavor_id) AS flavor_name
           FROM fr_issues i
          WHERE i.status='open'
          ORDER BY i.updated_at DESC, i.created_at DESC
          LIMIT 10`
      );

      res.json({
        totals: {
          flavors: Number(totalFlavors?.n || 0),
          open_issues: Number(openIssues?.n || 0),
          open_bad_reviews: Number(openBadRev?.n || 0),
          cycles_due: Number(cyclesDue?.n || 0),
        },
        today_queue: todayQueue.map(shapeCycle),
        ai_priority: priority.map(p => ({
          id: p.id, name: p.name, kind: p.kind, variant: p.variant,
          bad_count: Number(p.bad_count || 0), last_bad_at: p.last_bad_at || null,
        })),
        recent_issues: recentIssues.map(shapeIssue),
        ai_enabled: aiReady,
      });
    } catch (e) {
      console.error('[fr] dashboard failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── AI helpers ───────────────────────────────────────────────────────────
  async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
    if (!aiReady) throw new Error('AI disabled — ANTHROPIC_API_KEY not set');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('AI ' + r.status + ': ' + t.slice(0, 200));
    }
    const data = await r.json();
    return (data.content?.[0]?.text || '').trim();
  }

  // Summarise a flavor's open bad reviews into a recommendation (what to do,
  // if anything). Returns plain text the UI shows under the "AI take" header.
  app.post('/api/flavor-reviews/flavors/:id/ai/summary', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM fr_flavors WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });

      const reviews = await all(
        `SELECT rating, title, body, posted_at, source FROM fr_reviews
          WHERE flavor_id=?
          ORDER BY COALESCE(NULLIF(posted_at,''), created_at) DESC
          LIMIT 25`, id
      );
      if (!reviews.length) return res.json({ summary: 'No reviews logged yet for this flavor.' });

      const lines = reviews.map(r =>
        `[${r.rating || '?'}★ ${r.source}${r.posted_at ? ' / ' + r.posted_at : ''}] ${r.title ? r.title + ' — ' : ''}${(r.body || '').slice(0, 400)}`
      ).join('\n');

      const system =
        "You analyze customer reviews for syrup flavors at a small consumer-goods company. " +
        "Given a flavor and its recent reviews, write a SHORT recommendation (max 7 sentences) covering: " +
        "(1) the dominant theme of complaints, (2) whether action is needed and what KIND of action " +
        "(reformulate, fix bottle/label, adjust marketing copy, no action — already addressed, etc.), " +
        "(3) urgency. Be concrete and operational. Don't pad. " +
        "If reviews are overwhelmingly positive, say \"No action needed\" plainly and stop.";
      const userMsg =
        `Flavor: ${f.name} (${f.kind}, ${f.variant})\n` +
        `Reviews:\n${lines}`;
      const summary = await callClaude(system, userMsg, 600);
      res.json({ summary });
    } catch (e) {
      console.error('[fr] ai summary failed:', e.message);
      res.status(502).json({ error: 'AI call failed: ' + e.message });
    }
  });

  // Given a candidate review (id or body), find existing issues on the same
  // flavor that look like duplicates. The model returns a JSON array of
  // issue ids it considers a likely duplicate. We sanity-check against the
  // actual ids we sent.
  app.post('/api/flavor-reviews/reviews/:id/ai/find-duplicates', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const review = await get('SELECT * FROM fr_reviews WHERE id=?', id);
      if (!review) return res.status(404).json({ error: 'Not found' });
      // Pull every issue on the same flavor (any status) — fixed/merged
      // ones are the whole point: "is this the same complaint we already
      // fixed and it's just lagging into the market?".
      const issues = await all(
        `SELECT id, title, summary, status, resolution FROM fr_issues WHERE flavor_id=?
          ORDER BY created_at DESC LIMIT 50`, review.flavor_id
      );
      if (!issues.length) return res.json({ matches: [] });

      const system =
        "You de-duplicate customer-review complaints against an existing issue list. " +
        "Given ONE incoming review and a list of past issues (some open, some fixed), " +
        "return a JSON array of issue ids that describe the SAME underlying complaint. " +
        "Match on the problem, not on word choice. Prefer false negatives over false positives. " +
        "ONLY output a JSON array, e.g. [12, 7]. No prose, no markdown, no code fences.";
      const userMsg =
        `Incoming review (rating ${review.rating}/5): ${review.title || ''} — ${review.body || ''}\n\n` +
        `Past issues:\n` +
        issues.map(i =>
          `id=${i.id} [${i.status}] ${i.title}${i.summary ? ' — ' + i.summary.slice(0, 240) : ''}${i.resolution ? ' (resolved by: ' + i.resolution.slice(0, 240) + ')' : ''}`
        ).join('\n');
      const raw = await callClaude(system, userMsg, 300);
      let ids = [];
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) ids = parsed.map(Number).filter(Number.isFinite);
      } catch {}
      const allowed = new Set(issues.map(i => i.id));
      const matches = ids.filter(x => allowed.has(x))
        .map(x => issues.find(i => i.id === x))
        .map(i => ({ id: i.id, title: i.title, status: i.status, summary: i.summary, resolution: i.resolution }));
      res.json({ matches });
    } catch (e) {
      console.error('[fr] ai dedup failed:', e.message);
      res.status(502).json({ error: 'AI call failed: ' + e.message });
    }
  });

  // Pull the AI priority signal back into the cycles table. Reads all
  // active flavors with open bad reviews in the last 60 days, asks the
  // model to score 1-5, and bumps the next scheduled cycle for each.
  app.post('/api/flavor-reviews/ai/refresh-priority', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const rows = await all(
        `SELECT f.id, f.name, f.kind, f.variant,
                COUNT(r.id) AS bad_count,
                STRING_AGG(LEFT(COALESCE(r.title,'') || ' / ' || COALESCE(r.body,''), 300), ' || ') AS recent_text
           FROM fr_flavors f
           JOIN fr_reviews r ON r.flavor_id=f.id
          WHERE f.status='active'
            AND r.status='open'
            AND r.rating > 0 AND r.rating <= 2
            AND COALESCE(NULLIF(r.posted_at,''), r.created_at) >=
                TO_CHAR((NOW() AT TIME ZONE 'UTC') - INTERVAL '60 days', 'YYYY-MM-DD')
          GROUP BY f.id
          ORDER BY bad_count DESC
          LIMIT 30`
      );
      if (!rows.length) return res.json({ updated: 0 });

      const system =
        "You score consumer-goods flavors by how URGENTLY they need a quality review. " +
        "Input is one flavor per line with its recent negative-review snippets. " +
        "Output ONLY a JSON object: { \"<flavor_id>\": <score 0-2>, ... }. " +
        "Score 0 = no rush, 1 = move up by a few weeks, 2 = critical, pull in now. " +
        "Use the snippets — a flavor with severe complaints (off-taste, contamination, " +
        "package leaking, mislabel) scores higher than one with vague \"too sweet\".";
      const userMsg = rows.map(r =>
        `id=${r.id} ${r.name} (${r.kind}, ${r.variant}) — ${r.bad_count} bad — snippets: ${r.recent_text}`
      ).join('\n');
      const raw = await callClaude(system, userMsg, 600);
      let scores = {};
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        scores = JSON.parse(cleaned);
      } catch {}

      let updated = 0;
      for (const r of rows) {
        const bump = Math.max(0, Math.min(2, Number(scores[String(r.id)] ?? scores[r.id] ?? 0)));
        const cycle = await get(
          `SELECT id, scheduled_for FROM fr_cycles WHERE flavor_id=? AND status='scheduled'
            ORDER BY scheduled_for ASC LIMIT 1`,
          r.id
        );
        if (cycle) {
          await run(
            `UPDATE fr_cycles SET ai_priority_bump=?,
                updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
              WHERE id=?`,
            bump, cycle.id
          );
          updated++;
        } else if (bump > 0) {
          const target = new Date();
          target.setUTCDate(target.getUTCDate() + (bump === 2 ? 3 : 14));
          await run(
            `INSERT INTO fr_cycles (flavor_id, scheduled_for, priority, ai_priority_bump)
             VALUES (?,?,?,?)`,
            r.id, target.toISOString().slice(0, 10), 3, bump
          );
          updated++;
        }
      }
      res.json({ updated, scored: Object.keys(scores).length });
    } catch (e) {
      console.error('[fr] ai prioritize failed:', e.message);
      res.status(502).json({ error: 'AI call failed: ' + e.message });
    }
  });

  console.log('[flavor-reviews] mounted (' + (aiReady ? 'AI enabled' : 'AI disabled — set ANTHROPIC_API_KEY') + ')');
};
