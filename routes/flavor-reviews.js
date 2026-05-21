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
  const { get, all, run, requireAuth, pool } = deps;
  const { randomBytes } = require('crypto');
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
      image_url: row.image_url || '',
      amazon_asin: row.amazon_asin || '',
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
      asin: row.asin || '',
      listing_type: row.listing_type || 'single',
      image_url: row.image_url || '',
      title: row.title || '',
      pack_size: Number(row.pack_size || 1),
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
  // Strict review dedup key. Two reviews on the same flavor with identical
  // normalized reviewer_name + posted_at + body are treated as the same
  // review and the later one is dropped silently. Empty body → empty key
  // (we don't dedupe rating-only rows since their key would collapse all
  // anonymous "5-star, no body" entries into one).
  function computeDedupKey(reviewer_name, posted_at, body) {
    const b = String(body || '').trim().replace(/\s+/g, ' ');
    if (!b) return '';
    const n = String(reviewer_name || '').trim().toLowerCase();
    const d = String(posted_at || '').trim();
    return n + '' + d + '' + b.toLowerCase();
  }

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

      // Dedup pass 1: stable source-side review ID (rare — only when the
      // caller supplied one). Cheap exact match.
      if (clean.source_review_id) {
        const dup = await get(
          'SELECT id, status, issue_id FROM fr_reviews WHERE flavor_id=? AND source=? AND source_review_id=?',
          flavorId, clean.source, clean.source_review_id
        );
        if (dup) return res.status(200).json({ duplicate: true, existing_id: dup.id, existing_status: dup.status });
      }
      // Dedup pass 2: strict content-based key. Catches the case where the
      // same review lands without a source_review_id (e.g. paste, bookmarklet).
      const dedupKey = computeDedupKey(clean.reviewer_name, clean.posted_at, clean.body);
      if (dedupKey) {
        const dup = await get(
          'SELECT id, status FROM fr_reviews WHERE flavor_id=? AND dedup_key=? LIMIT 1',
          flavorId, dedupKey
        );
        if (dup) return res.status(200).json({ duplicate: true, existing_id: dup.id, existing_status: dup.status });
      }

      const sentiment = classifySentiment(clean.rating);
      // Auto-link to the most recent OPEN issue for this flavor if the body
      // looks similar — string-based prefilter to avoid an AI call per review.
      // The dedicated "find duplicates" AI endpoint covers the harder cases.
      const ins = await run(
        `INSERT INTO fr_reviews
           (flavor_id, source, source_review_id, rating, reviewer_name, title, body, url, posted_at, sentiment, dedup_key, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        flavorId, clean.source, clean.source_review_id, clean.rating,
        clean.reviewer_name, clean.title, clean.body, clean.url, clean.posted_at,
        sentiment, dedupKey, req.session.userId
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

  // ── Amazon URL import ─────────────────────────────────────────────────
  // The user pastes an Amazon product URL. We try TWO methods to grab the
  // page (Claude's web_fetch tool, then a server-side fetch with a polite
  // browser-y UA); whichever returns usable content gets sent to Claude
  // for structured extraction. If both fail we return needs_paste=true so
  // the UI can flip to a "paste page content" textarea.

  const LISTING_TYPES_FR = ['single', 'with_pump', '4_pack', '6_pack', 'other'];
  const EXTRACT_SCHEMA = `{
  "variations": [
    {
      "asin": "10-char Amazon product ID",
      "title": "full Amazon product title for this variation",
      "flavor_name": "the human flavor name only, e.g. \\"Vanilla\\" or \\"Caramel\\"",
      "image_url": "https://m.media-amazon.com/... high-res hero image",
      "listing_type": "single | with_pump | 4_pack | 6_pack | other",
      "pack_size": 1
    }
  ],
  "page_summary": "one-sentence description of what this listing is"
}`;

  const EXTRACT_SYSTEM =
    "You extract product data from Amazon listings for a syrup brand's catalog. " +
    "Given EITHER a URL to fetch OR raw page content, return ONLY a JSON object " +
    "with this exact schema:\n" + EXTRACT_SCHEMA + "\n\n" +
    "Rules:\n" +
    "- If the page has a flavor-variations widget (dropdown of multiple flavors), " +
    "list EVERY variation. One variation per flavor. Use the variation label as flavor_name.\n" +
    "- If there are NO variations, return ONE entry in `variations` for the main product.\n" +
    "- ASIN is the 10-char alphanumeric Amazon ID (parsed from URL paths like /dp/ASIN/ or /product/ASIN/).\n" +
    "- listing_type:\n" +
    "  • 'single' = one bottle, no pump\n" +
    "  • 'with_pump' = single bottle that ships with a pump\n" +
    "  • '4_pack' = 4 bottles in one listing\n" +
    "  • '6_pack' = 6 bottles in one listing\n" +
    "  • 'other' = anything else (gift set, sampler, …)\n" +
    "  Detect from title or pack-quantity hints. Default 'single'.\n" +
    "- pack_size: 1 / 4 / 6 / N based on listing_type.\n" +
    "- image_url: the highest-resolution hero image URL you can find.\n" +
    "- flavor_name should be the bare flavor only — strip \"Syrup\", \"Coffee Syrup\", " +
    "\"25 fl oz\", brand names, sizes. Just \"Vanilla\", \"Caramel\", \"Hazelnut\", etc.\n" +
    "- Return ONLY JSON. No markdown, no code fences, no prose.";

  function parseExtractJSON(raw) {
    const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      const j = JSON.parse(cleaned);
      const variations = Array.isArray(j.variations) ? j.variations.map(v => ({
        asin: String(v.asin || '').trim().slice(0, 20),
        title: String(v.title || '').trim().slice(0, 500),
        flavor_name: String(v.flavor_name || '').trim().slice(0, 120),
        image_url: String(v.image_url || '').trim().slice(0, 1000),
        listing_type: LISTING_TYPES_FR.includes(v.listing_type) ? v.listing_type : 'single',
        pack_size: Math.max(1, Math.min(99, parseInt(v.pack_size, 10) || 1)),
      })).filter(v => v.flavor_name || v.title) : [];
      return { variations, page_summary: String(j.page_summary || '').slice(0, 500) };
    } catch (e) {
      console.warn('[fr] extract JSON parse failed:', e.message, 'raw:', cleaned.slice(0, 400));
      return { variations: [], page_summary: '', parse_error: e.message };
    }
  }

  function asinFromUrl(url) {
    const m = /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i.exec(String(url || ''));
    return m ? m[1].toUpperCase() : '';
  }

  // Anthropic API — message with optional tools. We don't use the existing
  // callClaude because we sometimes want tool use (web_fetch).
  async function anthropicCall({ system, userText, tools, maxTokens, betaHeader }) {
    if (!aiReady) throw new Error('AI disabled — ANTHROPIC_API_KEY not set');
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (betaHeader) headers['anthropic-beta'] = betaHeader;
    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 2048,
      system,
      messages: [{ role: 'user', content: userText }],
    };
    if (tools && tools.length) body.tools = tools;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('Anthropic ' + r.status + ': ' + t.slice(0, 300));
    }
    const data = await r.json();
    // Find the last text block in content[]
    const blocks = data.content || [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'text' && blocks[i].text) return blocks[i].text;
    }
    return '';
  }

  // Strategy A: ask Claude to fetch the URL itself (web_fetch tool).
  async function extractViaWebFetch(url) {
    const userText =
      `Fetch this Amazon product URL and extract every flavor variation.\n\n` +
      `URL: ${url}\n\n` +
      `Use the web_fetch tool to read the page, then output the JSON described in your instructions.`;
    const raw = await anthropicCall({
      system: EXTRACT_SYSTEM,
      userText,
      tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 }],
      maxTokens: 3000,
      betaHeader: 'web-fetch-2025-09-10',
    });
    return parseExtractJSON(raw);
  }

  // Strategy B: server-side fetch with realistic headers; send the HTML
  // (trimmed) to Claude for extraction. Amazon often returns the page to
  // server-side requests when the UA looks like a real browser.
  async function serverFetchHtml(url) {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity', // no gzip — we want raw text
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });
    if (!r.ok) throw new Error('server fetch ' + r.status);
    const html = await r.text();
    // Cheap CAPTCHA sniff — Amazon's "Robot Check" page is small and has
    // distinctive markers. Treat as a soft-fail so we return needs_paste.
    if (/Type the characters you see in this image/i.test(html) ||
        /api-services-support@amazon\.com/i.test(html) && html.length < 30000) {
      throw new Error('captcha');
    }
    return html;
  }

  async function extractViaServerFetch(url) {
    const html = await serverFetchHtml(url);
    // Trim to ~80k chars — enough to capture the variations widget without
    // blowing out the model's context.
    const trimmed = html.slice(0, 80000);
    const userText =
      `I fetched this Amazon URL on the server and am pasting the raw HTML.\n\n` +
      `URL: ${url}\n\n` +
      `PAGE HTML (may be truncated):\n${trimmed}`;
    const raw = await anthropicCall({
      system: EXTRACT_SYSTEM,
      userText,
      maxTokens: 3000,
    });
    return parseExtractJSON(raw);
  }

  app.post('/api/flavor-reviews/import/amazon-url', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const url = String(req.body?.url || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Valid URL required' });

      // Try web_fetch first, then server fetch. Either path either returns
      // a variations array (success) or throws.
      let result = null;
      let fetchedVia = null;
      try {
        result = await extractViaWebFetch(url);
        if (result.variations.length) fetchedVia = 'claude_web_fetch';
      } catch (e) {
        console.warn('[fr] web_fetch path failed:', e.message);
      }
      if (!result || !result.variations.length) {
        try {
          result = await extractViaServerFetch(url);
          if (result.variations.length) fetchedVia = 'server_fetch';
        } catch (e) {
          console.warn('[fr] server fetch path failed:', e.message);
        }
      }

      if (!result || !result.variations.length) {
        // Neither path worked. Tell the client to paste the page content.
        return res.json({ ok: false, needs_paste: true, source_url: url });
      }

      // Backfill ASIN from URL if Claude missed one (single-variation cases)
      const urlAsin = asinFromUrl(url);
      for (const v of result.variations) {
        if (!v.asin && urlAsin) v.asin = urlAsin;
      }

      res.json({
        ok: true,
        source_url: url,
        page_summary: result.page_summary,
        variations: result.variations,
        fetched_via: fetchedVia,
      });
    } catch (e) {
      console.error('[fr] amazon-url failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/flavor-reviews/import/amazon-paste', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const url = String(req.body?.url || '').trim();
      const content = String(req.body?.content || '').trim();
      if (!content) return res.status(400).json({ error: 'Paste the Amazon page content first.' });
      if (content.length > 200000) return res.status(400).json({ error: 'Pasted content too large (max 200k chars).' });

      const userText =
        `Here is the content of an Amazon product page (URL ${url || 'unknown'}). ` +
        `Extract every flavor variation per your instructions.\n\n${content}`;
      const raw = await anthropicCall({
        system: EXTRACT_SYSTEM,
        userText,
        maxTokens: 3000,
      });
      const result = parseExtractJSON(raw);
      if (!result.variations.length) {
        return res.json({
          ok: false,
          source_url: url,
          error: 'Nothing extractable in that content. Did you paste the product page itself?',
          parse_error: result.parse_error || null,
        });
      }
      const urlAsin = asinFromUrl(url);
      for (const v of result.variations) if (!v.asin && urlAsin) v.asin = urlAsin;
      res.json({
        ok: true,
        source_url: url,
        page_summary: result.page_summary,
        variations: result.variations,
        fetched_via: 'paste',
      });
    } catch (e) {
      console.error('[fr] amazon-paste failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ── Match-batch: for each extracted variation, suggest an existing flavor
  // (or "create new"). The user can override per-row in the approval UI.
  // Uses simple lowercase exact match first, then asks AI to break ties or
  // resolve fuzzy matches across the remaining candidates.
  app.post('/api/flavor-reviews/import/match-batch', requireAuth, async (req, res) => {
    try {
      const vars = Array.isArray(req.body?.variations) ? req.body.variations : [];
      if (!vars.length) return res.json({ matches: [] });
      const flavors = await all('SELECT id, name, variant, kind FROM fr_flavors');

      // Pass 1: exact case-insensitive name match.
      const matches = vars.map((v, idx) => {
        const name = String(v.flavor_name || '').trim().toLowerCase();
        if (!name) return { variation_index: idx, suggested_flavor_id: null, confidence: 0 };
        const hit = flavors.find(f => f.name.toLowerCase() === name);
        if (hit) return { variation_index: idx, suggested_flavor_id: hit.id, suggested_flavor_name: hit.name, confidence: 1.0 };
        return { variation_index: idx, suggested_flavor_id: null, confidence: 0 };
      });

      // Pass 2 (optional, AI): if anything still unmatched AND there are
      // existing flavors, ask Claude to fuzzy-match the leftovers.
      const unmatched = matches.filter(m => m.suggested_flavor_id === null);
      if (aiReady && unmatched.length && flavors.length) {
        try {
          const system =
            "You match candidate flavor names against an existing catalog. " +
            "Return ONLY a JSON object: { \"<candidate_index>\": <existing_flavor_id or null>, ... }. " +
            "Match only when you're confident — return null otherwise. " +
            "Ignore size / pack qualifiers (\"4-pack\", \"with pump\", \"25 oz\") — match on the flavor itself. " +
            "Treat \"Vanilla\" = \"French Vanilla\" as DIFFERENT unless the existing list contains exactly the same name.";
          const userText =
            `Existing flavors:\n` +
            flavors.map(f => `id=${f.id} ${f.name} (${f.variant})`).join('\n') +
            `\n\nCandidates to match:\n` +
            unmatched.map(m => `index=${m.variation_index} ${vars[m.variation_index].flavor_name} — ${vars[m.variation_index].title}`).join('\n');
          const raw = await anthropicCall({ system, userText, maxTokens: 600 });
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
          const scores = JSON.parse(cleaned);
          for (const m of unmatched) {
            const v = scores[String(m.variation_index)];
            if (v != null && Number.isFinite(Number(v))) {
              const id = Number(v);
              const flav = flavors.find(f => f.id === id);
              if (flav) { m.suggested_flavor_id = id; m.suggested_flavor_name = flav.name; m.confidence = 0.6; }
            }
          }
        } catch (e) {
          console.warn('[fr] match AI pass failed:', e.message);
        }
      }
      res.json({ matches });
    } catch (e) {
      console.error('[fr] match-batch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Confirm: write approved items to DB. Each item has an action:
  //   action='create'  → create a new fr_flavor + add this listing as link
  //   action='link'    → add this listing as a link on an existing flavor
  //   action='skip'    → ignore (no-op)
  // Returns counts so the UI can show a clean summary.
  app.post('/api/flavor-reviews/import/confirm', requireAuth, async (req, res) => {
    try {
      const sourceUrl = String(req.body?.source_url || '').trim();
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length) return res.status(400).json({ error: 'No items to import.' });

      const created = []; const linked = []; const skipped = []; const errors = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          if (it.action === 'skip') { skipped.push({ index: i }); continue; }

          const name = String(it.name || '').trim();
          const kind = KINDS.includes(it.kind) ? it.kind : 'other';
          const variant = VARIANTS.includes(it.variant) ? it.variant : 'regular';
          const asin = String(it.asin || '').trim().slice(0, 20);
          const title = String(it.title || '').trim().slice(0, 500);
          const imageUrl = String(it.image_url || '').trim().slice(0, 1000);
          const listingType = LISTING_TYPES_FR.includes(it.listing_type) ? it.listing_type : 'single';
          const packSize = Math.max(1, Math.min(99, parseInt(it.pack_size, 10) || 1));
          const channel = String(it.channel || 'Amazon').trim().slice(0, 60);
          const listingUrl = String(it.url || sourceUrl || '').trim().slice(0, 1000);

          let flavorId;
          if (it.action === 'create') {
            if (!name) { errors.push({ index: i, reason: 'name required' }); continue; }
            const dup = await get(
              'SELECT id FROM fr_flavors WHERE LOWER(name)=LOWER(?) AND variant=?',
              name, variant
            );
            if (dup) {
              // Race / re-import case — silently fall back to link mode.
              flavorId = dup.id;
              linked.push({ index: i, flavor_id: flavorId, name, action: 'link_existing' });
            } else {
              const ins = await run(
                `INSERT INTO fr_flavors (name, kind, variant, image_url, amazon_asin, created_by)
                 VALUES (?,?,?,?,?,?) RETURNING id`,
                name, kind, variant,
                listingType === 'single' ? imageUrl : '', // hero image only from single
                listingType === 'single' ? asin : '',
                req.session.userId
              );
              flavorId = ins.lastInsertRowid;
              created.push({ index: i, flavor_id: flavorId, name });
              try { await maybeAutoSchedule(flavorId); } catch {}
            }
          } else if (it.action === 'link') {
            flavorId = Number(it.existing_flavor_id);
            if (!Number.isFinite(flavorId)) { errors.push({ index: i, reason: 'existing_flavor_id required' }); continue; }
            const exists = await get('SELECT id, image_url, amazon_asin FROM fr_flavors WHERE id=?', flavorId);
            if (!exists) { errors.push({ index: i, reason: 'target flavor not found' }); continue; }
            linked.push({ index: i, flavor_id: flavorId });
            // Backfill hero image / primary ASIN if missing.
            if (listingType === 'single') {
              const sets = []; const args = [];
              if (!exists.image_url && imageUrl) { sets.push('image_url=?'); args.push(imageUrl); }
              if (!exists.amazon_asin && asin) { sets.push('amazon_asin=?'); args.push(asin); }
              if (sets.length) {
                args.push(flavorId);
                await run(`UPDATE fr_flavors SET ${sets.join(',')} WHERE id=?`, ...args);
              }
            }
          } else {
            errors.push({ index: i, reason: 'unknown action ' + it.action }); continue;
          }

          // Add the link row if we have a URL. Dedup on (flavor_id, asin or url).
          if (listingUrl) {
            const dupLink = asin
              ? await get('SELECT id FROM fr_flavor_links WHERE flavor_id=? AND asin=?', flavorId, asin)
              : await get('SELECT id FROM fr_flavor_links WHERE flavor_id=? AND url=?', flavorId, listingUrl);
            if (!dupLink) {
              const maxPos = await get('SELECT MAX(position) AS p FROM fr_flavor_links WHERE flavor_id=?', flavorId);
              const pos = Number(maxPos?.p || -1) + 1;
              await run(
                `INSERT INTO fr_flavor_links
                   (flavor_id, channel, url, notes, position, asin, listing_type, image_url, title, pack_size)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                flavorId, channel, listingUrl, String(it.notes || '').slice(0, 1000),
                pos, asin, listingType, imageUrl, title, packSize
              );
            }
          }
        } catch (e) {
          errors.push({ index: i, reason: e.message });
        }
      }
      res.json({ created, linked, skipped, errors });
    } catch (e) {
      console.error('[fr] import confirm failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Reviews extraction (URL fetch / paste) ───────────────────────────────
  const REVIEW_EXTRACT_SYSTEM =
    "You extract product reviews from Amazon / Walmart / TikTok pages or pasted text. " +
    "Return ONLY this JSON: { \"reviews\": [{ \"rating\": <1-5 or null>, \"title\": \"...\", " +
    "\"body\": \"...\", \"reviewer_name\": \"...\", \"posted_at\": \"YYYY-MM-DD or empty\", " +
    "\"verified\": true/false }] }\n\n" +
    "Rules:\n" +
    "- Extract every distinct review you can identify. Don't combine reviews.\n" +
    "- rating: integer 1-5 if visible (\"★★★★☆\" = 4). null if not shown.\n" +
    "- posted_at: ISO date if shown (\"Reviewed in the United States on May 12, 2024\" → \"2024-05-12\"). " +
    "Empty string otherwise. Today is " + todayUtc() + ".\n" +
    "- reviewer_name: visible username or display name. Empty if anonymous.\n" +
    "- verified: true if marked \"Verified Purchase\", else false.\n" +
    "- DO NOT invent reviews. If the content has no recognizable reviews, return { \"reviews\": [] }.\n" +
    "- DO NOT include code fences, markdown, or any commentary.";

  function parseReviewsJSON(raw) {
    const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      const j = JSON.parse(cleaned);
      const reviews = Array.isArray(j.reviews) ? j.reviews.map(r => ({
        rating: r.rating == null ? 0 : Math.max(0, Math.min(5, parseInt(r.rating, 10) || 0)),
        title: String(r.title || '').slice(0, 200),
        body: String(r.body || '').slice(0, 10000),
        reviewer_name: String(r.reviewer_name || '').slice(0, 120),
        posted_at: /^\d{4}-\d{2}-\d{2}$/.test(r.posted_at || '') ? r.posted_at : '',
        verified: !!r.verified,
      })).filter(r => r.body || r.title) : [];
      return { reviews };
    } catch (e) {
      console.warn('[fr] review JSON parse failed:', e.message, 'raw:', cleaned.slice(0, 300));
      return { reviews: [], parse_error: e.message };
    }
  }

  // Deterministic parser for the "--- Review N ---" structured format
  // (and a few near-variants). When AI agents or humans pre-format reviews
  // into this shape there's no reason to spend AI tokens re-parsing them:
  // the regex pass is instant, free, and exact. Returns null if the format
  // isn't recognized so callers can fall back to Claude.
  function tryStructuredReviewParse(content) {
    const text = String(content || '');
    // Split on "--- Review N ---" / "--- Review ---" / "=== Review N ===" markers.
    const splitRe = /(?:^|\n)\s*[-=]{2,}\s*Review\s*\d*\s*[-=]{2,}\s*(?:\n|$)/i;
    const blocks = text.split(splitRe).map(b => b.trim()).filter(Boolean);
    if (blocks.length < 2) return null; // need ≥2 to be confident

    const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    function parseLooseDate(s) {
      if (!s) return '';
      // "May 18, 2026", "Reviewed in the US on May 18, 2026", etc.
      let m = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
      if (m) {
        const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
        if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${String(Number(m[2])).padStart(2,'0')}`;
      }
      // ISO already
      m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      return '';
    }

    const reviews = [];
    for (const block of blocks) {
      const reviewer    = (block.match(/^\s*Reviewer\s*:\s*(.+?)\s*$/im)        || [])[1] || '';
      const ratingLine  = (block.match(/^\s*Rating\s*:\s*([0-9](?:\.\d+)?)\s*(?:out of\s*5|\/\s*5|stars?)?/im) || []);
      const titleMatch  = (block.match(/^\s*Title\s*:\s*(.+?)\s*$/im)           || [])[1] || '';
      const dateLine    = (block.match(/^\s*Date\s*:\s*(.+?)\s*$/im)            || [])[1] || '';
      // Body = everything after "Review:" through end of block. /m so ^ matches line start.
      let body = '';
      const reviewIdx = block.search(/^\s*Review\s*:\s*/im);
      if (reviewIdx >= 0) {
        body = block.slice(reviewIdx).replace(/^\s*Review\s*:\s*/i, '').trim();
      } else {
        // Fallback: if no explicit "Review:" field, treat anything after the
        // last labelled line as the body. Skip if we can't find a reasonable
        // chunk so we don't accept garbage.
        const lastLabelEnd = Math.max(
          block.lastIndexOf('Date:'),
          block.lastIndexOf('Title:'),
          block.lastIndexOf('Rating:'),
          block.lastIndexOf('Reviewer:')
        );
        if (lastLabelEnd >= 0) {
          const tail = block.slice(lastLabelEnd);
          const nl = tail.indexOf('\n');
          if (nl >= 0) body = tail.slice(nl + 1).trim();
        }
      }
      if (!body && !titleMatch) continue;

      const rating = ratingLine[1] ? Math.max(0, Math.min(5, Math.round(parseFloat(ratingLine[1])))) : 0;
      reviews.push({
        rating,
        title: titleMatch.slice(0, 200),
        body: body.slice(0, 10000),
        reviewer_name: reviewer.slice(0, 120),
        posted_at: parseLooseDate(dateLine),
        verified: /verified/i.test(dateLine),
      });
    }
    return reviews.length ? reviews : null;
  }

  app.post('/api/flavor-reviews/import/reviews-fetch', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const url = String(req.body?.url || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Valid URL required' });

      let reviews = []; let fetchedVia = null;

      // Strategy A: Claude web_fetch
      try {
        const raw = await anthropicCall({
          system: REVIEW_EXTRACT_SYSTEM,
          userText: `Fetch this reviews page and extract every review. URL: ${url}`,
          tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 }],
          maxTokens: 8000,
          betaHeader: 'web-fetch-2025-09-10',
        });
        const r = parseReviewsJSON(raw);
        if (r.reviews.length) { reviews = r.reviews; fetchedVia = 'claude_web_fetch'; }
      } catch (e) {
        console.warn('[fr] reviews web_fetch failed:', e.message);
      }

      // Strategy B: server-side fetch
      if (!reviews.length) {
        try {
          const html = await serverFetchHtml(url);
          const trimmed = html.slice(0, 80000);
          const raw = await anthropicCall({
            system: REVIEW_EXTRACT_SYSTEM,
            userText: `I fetched this reviews page on the server. URL: ${url}\n\nHTML:\n${trimmed}`,
            maxTokens: 8000,
          });
          const r = parseReviewsJSON(raw);
          if (r.reviews.length) { reviews = r.reviews; fetchedVia = 'server_fetch'; }
        } catch (e) {
          console.warn('[fr] reviews server fetch failed:', e.message);
        }
      }

      if (!reviews.length) return res.json({ ok: false, needs_paste: true, source_url: url });
      res.json({ ok: true, source_url: url, reviews, fetched_via: fetchedVia });
    } catch (e) {
      console.error('[fr] reviews-fetch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/flavor-reviews/import/reviews-paste', requireAuth, async (req, res) => {
    try {
      const content = String(req.body?.content || '').trim();
      if (!content) return res.status(400).json({ error: 'Paste the review content first.' });
      if (content.length > 200000) return res.status(400).json({ error: 'Pasted content too large (max 200k chars).' });

      // Fast path: structured "--- Review N ---" / similar format. Instant,
      // free, deterministic. This is what other AI agents tend to output
      // when asked to scrape reviews, so it's worth handling without AI.
      const direct = tryStructuredReviewParse(content);
      if (direct && direct.length) {
        return res.json({ ok: true, reviews: direct, parsed_via: 'deterministic' });
      }

      // Fall back to Claude for unstructured content. maxTokens bumped to
      // 8000 so 50+ reviews of typical length don't get truncated mid-JSON.
      if (!aiReady) {
        return res.status(503).json({
          error: 'AI disabled and the content isn\'t in the structured "--- Review N ---" format. ' +
                 'Re-paste in that format, or set ANTHROPIC_API_KEY on the server.'
        });
      }
      const raw = await anthropicCall({
        system: REVIEW_EXTRACT_SYSTEM,
        userText: `Here is pasted content with one or more reviews. Extract them.\n\n${content}`,
        maxTokens: 8000,
      });
      const r = parseReviewsJSON(raw);
      if (!r.reviews.length) {
        return res.json({ ok: false, reviews: [], error: 'No reviews recognised in that content.', parse_error: r.parse_error || null });
      }
      res.json({ ok: true, reviews: r.reviews, parsed_via: 'ai' });
    } catch (e) {
      console.error('[fr] reviews-paste failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ── Reviews confirm: bulk-create approved reviews on a flavor ────────────
  app.post('/api/flavor-reviews/import/reviews-confirm', requireAuth, async (req, res) => {
    try {
      const flavorId = Number(req.body?.flavor_id);
      if (!Number.isFinite(flavorId)) return res.status(400).json({ error: 'flavor_id required' });
      const source = String(req.body?.source || '').trim().slice(0, 60);
      if (!source) return res.status(400).json({ error: 'source required (Amazon / Walmart / TikTok / …)' });
      const sourceUrl = String(req.body?.url || '').trim().slice(0, 1000);
      const items = Array.isArray(req.body?.reviews) ? req.body.reviews : [];
      if (!items.length) return res.status(400).json({ error: 'No reviews to save.' });

      const flavor = await get('SELECT id FROM fr_flavors WHERE id=?', flavorId);
      if (!flavor) return res.status(404).json({ error: 'Flavor not found' });

      const created = []; const skipped = []; const errors = [];
      // Intra-batch dedup: catches Claude double-emitting the same row OR
      // a user pasting the same review twice within one import.
      const seenInBatch = new Set();
      for (let i = 0; i < items.length; i++) {
        const r = items[i];
        try {
          const rating = Math.max(0, Math.min(5, parseInt(r.rating, 10) || 0));
          const title = String(r.title || '').slice(0, 200);
          const body = String(r.body || '').slice(0, 10000);
          const reviewer_name = String(r.reviewer_name || '').slice(0, 120);
          const posted_at = /^\d{4}-\d{2}-\d{2}$/.test(r.posted_at || '') ? r.posted_at : '';

          // Strict dedup by reviewer_name + posted_at + body (normalized).
          // Empty-body rows aren't dedupable (key collapses across all
          // anonymous rating-only reviews), so they always insert.
          const dedupKey = computeDedupKey(reviewer_name, posted_at, body);
          if (dedupKey) {
            if (seenInBatch.has(dedupKey)) {
              skipped.push({ index: i, reason: 'duplicate-in-batch' });
              continue;
            }
            const dup = await get(
              `SELECT id FROM fr_reviews WHERE flavor_id=? AND dedup_key=? LIMIT 1`,
              flavorId, dedupKey
            );
            if (dup) {
              skipped.push({ index: i, reason: 'duplicate', existing_id: dup.id });
              continue;
            }
            seenInBatch.add(dedupKey);
          }

          const sentiment = classifySentiment(rating);
          const ins = await run(
            `INSERT INTO fr_reviews
               (flavor_id, source, rating, reviewer_name, title, body, url, posted_at, sentiment, dedup_key, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
            flavorId, source, rating, reviewer_name, title, body, sourceUrl, posted_at,
            sentiment, dedupKey, req.session.userId
          );
          created.push({ index: i, id: ins.lastInsertRowid });
          if (sentiment === 'negative') {
            try { await bumpNextCyclePriority(flavorId); } catch {}
          }
        } catch (e) {
          errors.push({ index: i, reason: e.message });
        }
      }
      res.json({ created, skipped, errors });
    } catch (e) {
      console.error('[fr] reviews-confirm failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Bookmarklet scraper ──────────────────────────────────────────────────
  // The user drags a bookmarklet to their browser bar. On any Amazon page
  // they click it; the bookmarklet runs INSIDE the page (so it passes every
  // bot wall — it IS a real browser) and POSTs the rendered HTML to us
  // with a workspace bearer token. We queue the raw HTML in fr_scraper_inbox
  // and parse on demand with Claude (same pipeline as paste-mode), so cost
  // is incurred only on items the user actually wants to import.

  function corsScraper(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '86400');
  }

  async function getOrCreateToken() {
    let row = await get('SELECT scraper_token FROM fr_settings WHERE id=1');
    if (!row?.scraper_token) {
      const tok = 'fr_' + randomBytes(24).toString('hex');
      await run('UPDATE fr_settings SET scraper_token=? WHERE id=1', tok);
      row = { scraper_token: tok };
    }
    return row.scraper_token;
  }

  // Token + bookmarklet snippet
  app.get('/api/flavor-reviews/scraper/config', requireAuth, async (req, res) => {
    try {
      const token = await getOrCreateToken();
      // The bookmarklet is generated server-side so it bakes in the right
      // origin (works in dev + prod without hand-editing).
      const origin = req.protocol + '://' + req.get('host');
      res.json({
        token,
        origin,
        bookmarklet: buildBookmarklet(origin, token),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/flavor-reviews/scraper/rotate-token', requireAuth, async (req, res) => {
    try {
      const tok = 'fr_' + randomBytes(24).toString('hex');
      await run('UPDATE fr_settings SET scraper_token=? WHERE id=1', tok);
      const origin = req.protocol + '://' + req.get('host');
      res.json({ token: tok, origin, bookmarklet: buildBookmarklet(origin, tok) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Ingest (the bookmarklet posts here from amazon.com) ─────────────────
  // Auth via Bearer token only — no session cookie. CORS open so the call
  // from amazon.com origin lands. Body size is governed by server.js's
  // 50mb express.json limit, which comfortably fits a 10-page review walk.
  app.options('/api/flavor-reviews/scraper/ingest', (req, res) => {
    corsScraper(res);
    res.sendStatus(204);
  });
  app.post('/api/flavor-reviews/scraper/ingest', async (req, res) => {
    corsScraper(res);
    try {
      const auth = String(req.get('Authorization') || '');
      const bearer = /^Bearer\s+(\S+)/i.exec(auth);
      if (!bearer) return res.status(401).json({ error: 'Missing Bearer token' });
      const token = bearer[1];
      const expected = await getOrCreateToken();
      if (token !== expected) return res.status(401).json({ error: 'Invalid token' });

      const kind = (req.body?.kind === 'reviews') ? 'reviews' : 'product';
      const sourceUrl = String(req.body?.url || '').slice(0, 2000);
      const pageTitle = String(req.body?.page_title || '').slice(0, 500);
      const html = String(req.body?.html || '');
      const pageCount = Math.max(1, Math.min(50, parseInt(req.body?.page_count, 10) || 1));
      const ua = String(req.body?.user_agent || req.get('User-Agent') || '').slice(0, 300);
      if (!html || html.length < 100) return res.status(400).json({ error: 'Empty or tiny html payload' });

      const ins = await run(
        `INSERT INTO fr_scraper_inbox (kind, source_url, page_title, html, bytes, page_count, user_agent)
         VALUES (?,?,?,?,?,?,?) RETURNING id`,
        kind, sourceUrl, pageTitle, html, html.length, pageCount, ua
      );
      // Opportunistic cleanup of old/consumed items so the table doesn't
      // grow forever. Cheap query, runs on each ingest.
      run(`DELETE FROM fr_scraper_inbox
           WHERE consumed_at IS NOT NULL
             AND created_at < TO_CHAR(NOW() - INTERVAL '7 days' AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`).catch(()=>{});
      res.json({ ok: true, id: ins.lastInsertRowid, bytes: html.length });
    } catch (e) {
      console.error('[fr] scraper ingest failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Inbox listing for the UI. Excludes the HTML body to keep responses small.
  app.get('/api/flavor-reviews/scraper/inbox', requireAuth, async (req, res) => {
    try {
      const kind = req.query.kind === 'reviews' ? 'reviews' : (req.query.kind === 'product' ? 'product' : null);
      const sql = `SELECT id, kind, source_url, page_title, bytes, page_count, status,
                          parsed_json, user_agent, created_at, parsed_at, consumed_at
                   FROM fr_scraper_inbox
                   WHERE consumed_at IS NULL ${kind ? 'AND kind=?' : ''}
                   ORDER BY created_at DESC LIMIT 50`;
      const rows = kind ? await all(sql, kind) : await all(sql);
      res.json({ items: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/flavor-reviews/scraper/inbox/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM fr_scraper_inbox WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Mark consumed (after the user has accepted the parsed proposal). We
  // keep the row for 7d for debugging then auto-cleanup picks it up.
  app.post('/api/flavor-reviews/scraper/inbox/:id/consume', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run(`UPDATE fr_scraper_inbox SET consumed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`, id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Parse a queued capture with Claude. Caches the result on the row so a
  // second click is free. Returns the same shape as /amazon-paste or
  // /reviews-paste depending on `kind`.
  app.post('/api/flavor-reviews/scraper/parse/:id', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const row = await get('SELECT id, kind, source_url, html, parsed_json, status FROM fr_scraper_inbox WHERE id=?', id);
      if (!row) return res.status(404).json({ error: 'Not found' });

      // Cache hit — return the previously-parsed JSON without another AI call.
      if (row.parsed_json && !req.query.force) {
        try {
          const j = JSON.parse(row.parsed_json);
          return res.json({ ok: true, ...j, cached: true });
        } catch {}
      }

      // Trim aggressively — bookmarklet captures full DOM which can be 1-3MB.
      // Strip <script> / <style> / SVG paths to focus the model on text + product data.
      const cleaned = stripHtmlNoise(row.html).slice(0, 120000);

      if (row.kind === 'product') {
        const raw = await anthropicCall({
          system: EXTRACT_SYSTEM,
          userText: `Captured from ${row.source_url}.\n\nHTML:\n${cleaned}`,
          maxTokens: 3500,
        });
        const result = parseExtractJSON(raw);
        const urlAsin = asinFromUrl(row.source_url);
        for (const v of result.variations || []) if (!v.asin && urlAsin) v.asin = urlAsin;
        const payload = {
          source_url: row.source_url,
          page_summary: result.page_summary,
          variations: result.variations || [],
          fetched_via: 'bookmarklet',
        };
        await run(
          `UPDATE fr_scraper_inbox SET parsed_json=?, status='parsed',
              parsed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
           WHERE id=?`,
          JSON.stringify(payload), id
        );
        return res.json({ ok: true, ...payload });
      } else {
        const raw = await anthropicCall({
          system: REVIEW_EXTRACT_SYSTEM,
          userText: `Captured from ${row.source_url}. The HTML may contain multiple paginated review pages concatenated together (separated by <!--PAGEBREAK--> markers — treat each as continuing the same review stream and DON'T duplicate).\n\nHTML:\n${cleaned}`,
          maxTokens: 8000,
        });
        const result = parseReviewsJSON(raw);
        const payload = {
          source_url: row.source_url,
          reviews: result.reviews || [],
          fetched_via: 'bookmarklet',
        };
        await run(
          `UPDATE fr_scraper_inbox SET parsed_json=?, status='parsed',
              parsed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
           WHERE id=?`,
          JSON.stringify(payload), id
        );
        return res.json({ ok: true, ...payload });
      }
    } catch (e) {
      console.error('[fr] scraper parse failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // Trim a captured DOM so Claude sees product data, not 80% noise.
  // Cheap regex pass — does NOT need to be perfect, just smaller.
  function stripHtmlNoise(html) {
    return String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<!--(?!PAGEBREAK)[\s\S]*?-->/g, '') // keep our own PAGEBREAK markers
      .replace(/\s+/g, ' ');
  }

  // ── Bookmarklet payload generator ─────────────────────────────────────
  // Returns a `javascript:` URL the user can drag to their bookmark bar.
  // The script:
  //   1. Detects whether it's on a product page or a reviews page
  //   2. If reviews: walks pageNumber=1..10 same-origin fetch(), bundles
  //      them as one payload (separated by PAGEBREAK markers our backend
  //      tells the AI to ignore as duplicates)
  //   3. POSTs to the ingest endpoint with the bearer token
  //   4. Pops a floating confirmation div in the page
  function buildBookmarklet(origin, token) {
    // The function below runs inside Amazon's page context. Anything that
    // would conflict with a page's globals is namespaced. Returns minified
    // javascript: URL — the caller URI-encodes the whole script body.
    const body = `(async function(){
  try {
    var APP = ${JSON.stringify(origin)};
    var TOK = ${JSON.stringify(token)};
    function flash(msg, ok) {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:20px;right:20px;background:'+(ok?'#7c3aed':'#dc2626')+';color:#fff;padding:14px 22px;border-radius:10px;z-index:2147483647;font:14px system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.25);max-width:360px;line-height:1.4';
      d.textContent = msg; document.body.appendChild(d);
      setTimeout(function(){ d.style.transition='opacity .4s'; d.style.opacity='0'; setTimeout(function(){d.remove();}, 500); }, 4500);
    }
    var here = location.href;
    var isReviews = /\\/product-reviews\\//.test(here);
    var html, pageCount = 1;
    if (isReviews) {
      flash('✨ Collecting up to 10 review pages...', true);
      // Walk pageNumber=1..10. We fetch as text from inside amazon.com so
      // there's no CORS and Amazon's bot defenses see a real session.
      var baseUrl = here.replace(/([?&])pageNumber=\\d+/g, '$1').replace(/[?&]$/, '');
      var pages = [];
      // page 1 = the current DOM (no extra fetch needed)
      pages.push(document.documentElement.outerHTML);
      for (var i = 2; i <= 10; i++) {
        try {
          var sep = baseUrl.indexOf('?') >= 0 ? '&' : '?';
          var resp = await fetch(baseUrl + sep + 'pageNumber=' + i, { credentials: 'include' });
          if (!resp.ok) break;
          var t = await resp.text();
          if (!t || !/(review|customer)/i.test(t)) break;
          // Stop if Amazon serves the same page twice (we hit the end).
          if (pages[pages.length-1].length === t.length) break;
          pages.push(t);
          pageCount = i;
          // small jitter to be polite
          await new Promise(function(r){ setTimeout(r, 350 + Math.random()*250); });
        } catch (e) { break; }
      }
      html = pages.join('\\n<!--PAGEBREAK-->\\n');
    } else {
      html = document.documentElement.outerHTML;
    }
    flash('✨ Sending ' + Math.round(html.length/1024) + ' KB' + (isReviews ? ' from ' + pageCount + ' page' + (pageCount===1?'':'s') : '') + '...', true);
    var r = await fetch(APP + '/api/flavor-reviews/scraper/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOK },
      body: JSON.stringify({
        kind: isReviews ? 'reviews' : 'product',
        url: here,
        page_title: document.title,
        html: html,
        page_count: pageCount,
        user_agent: navigator.userAgent
      })
    });
    if (r.ok) flash('✓ Sent to Syruvia. Open the Import wizard to approve.', true);
    else flash('✗ Failed (' + r.status + '). Check the token in Settings.', false);
  } catch (e) {
    alert('Bookmarklet error: ' + e.message);
  }
})();`;
    return 'javascript:' + encodeURIComponent(body);
  }

  // ── Manual dedup pass ───────────────────────────────────────────────────
  // The startup cleanup runs once via fr_settings.dedup_v1_done. Use this
  // endpoint to dedupe again on demand (after a bad import, or if
  // duplicates somehow snuck in via a different path).
  app.post('/api/flavor-reviews/reviews/dedupe', requireAuth, async (req, res) => {
    try {
      // 1) Backfill any rows missing a key (defensive — every insert path
      //    now stamps it, but a stray INSERT or restore could leave gaps).
      await pool.query(`
        UPDATE fr_reviews
        SET dedup_key = CASE
          WHEN BTRIM(COALESCE(body, '')) = '' THEN ''
          ELSE LOWER(BTRIM(COALESCE(reviewer_name, '')))
               || E'\\x01' || COALESCE(posted_at, '')
               || E'\\x01' || LOWER(REGEXP_REPLACE(BTRIM(body), E'\\s+', ' ', 'g'))
        END
        WHERE dedup_key = ''
          AND BTRIM(COALESCE(body, '')) <> ''`);
      // 2) Delete duplicates, keeping the earliest (MIN id) per group.
      const del = await pool.query(`
        DELETE FROM fr_reviews
        WHERE dedup_key <> ''
          AND id NOT IN (
            SELECT MIN(id) FROM fr_reviews
            WHERE dedup_key <> ''
            GROUP BY flavor_id, dedup_key
          )`);
      res.json({ deleted: Number(del.rowCount || 0) });
    } catch (e) {
      console.error('[fr] manual dedupe failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Smart Import Agent ──────────────────────────────────────────────────
  // One URL in, one structured proposal out. The agent:
  //   1. Classifies the URL by path (product vs reviews vs unknown).
  //   2. Resolves content: bookmarklet inbox item by id > Claude web_fetch
  //      > server-side fetch. First one that succeeds wins.
  //   3. Runs the matching extraction (variations OR reviews).
  //   4. For product URLs: ALSO tries the derived /product-reviews/<asin>/
  //      URL in the same call so the user gets a "32 reviews waiting" hint
  //      and can save them to the right flavor after approval.
  //   5. For reviews URLs: looks up which flavor owns this ASIN
  //      (fr_flavor_links.asin), pre-fills the approval grid so the user
  //      doesn't have to pick a target.
  // Nothing writes to the DB — the existing /confirm + /reviews-confirm
  // endpoints handle that after the user approves. Keeps the agent safe.

  function classifyAmazonUrl(url) {
    const s = String(url || '');
    if (!/amazon\./i.test(s)) {
      // Allow paths even when host isn't amazon (some mirrors / shortened URLs).
      const revHit = /\/product-reviews\/([A-Z0-9]{10})/i.exec(s);
      if (revHit) return { kind: 'reviews', asin: revHit[1].toUpperCase() };
      const prodHit = /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i.exec(s);
      if (prodHit) return { kind: 'product', asin: prodHit[1].toUpperCase() };
      return { kind: 'unsupported', asin: '' };
    }
    const revMatch = /\/product-reviews\/([A-Z0-9]{10})/i.exec(s);
    if (revMatch) return { kind: 'reviews', asin: revMatch[1].toUpperCase() };
    const prodMatch = /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i.exec(s);
    if (prodMatch) return { kind: 'product', asin: prodMatch[1].toUpperCase() };
    return { kind: 'unknown', asin: '' };
  }

  // Run extraction directly from raw HTML (used for inbox-sourced content).
  async function extractFromHtml(html, urlContext, expectedKind) {
    const trimmed = stripHtmlNoise(html).slice(0, 120000);
    if (expectedKind === 'reviews') {
      const raw = await anthropicCall({
        system: REVIEW_EXTRACT_SYSTEM,
        userText: `Captured from ${urlContext}. The HTML may contain multiple paginated review pages concatenated with <!--PAGEBREAK--> markers; treat them as one continuous stream and don't duplicate.\n\nHTML:\n${trimmed}`,
        maxTokens: 8000,
      });
      return parseReviewsJSON(raw);
    }
    const raw = await anthropicCall({
      system: EXTRACT_SYSTEM,
      userText: `Captured from ${urlContext}. Extract every flavor variation per your instructions.\n\nHTML:\n${trimmed}`,
      maxTokens: 3500,
    });
    return parseExtractJSON(raw);
  }

  // Try web_fetch then server_fetch for a URL. Returns the parsed extraction
  // and which path succeeded, or null if both fail.
  async function fetchAndExtract(url, expectedKind) {
    // A) Claude web_fetch — handles both fetch and extract in one call.
    try {
      const raw = await anthropicCall({
        system: expectedKind === 'reviews' ? REVIEW_EXTRACT_SYSTEM : EXTRACT_SYSTEM,
        userText: expectedKind === 'reviews'
          ? `Fetch this reviews page and extract every review. URL: ${url}`
          : `Fetch this Amazon URL and extract every flavor variation.\n\nURL: ${url}\n\nUse the web_fetch tool to read the page, then output the JSON described.`,
        tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 }],
        maxTokens: expectedKind === 'reviews' ? 8000 : 3500,
        betaHeader: 'web-fetch-2025-09-10',
      });
      const parsed = expectedKind === 'reviews' ? parseReviewsJSON(raw) : parseExtractJSON(raw);
      const ok = expectedKind === 'reviews' ? parsed.reviews.length : parsed.variations.length;
      if (ok) return { extraction: parsed, source: 'claude_web_fetch' };
    } catch (e) {
      console.warn('[fr agent web_fetch]', e.message);
    }
    // B) Server-side fetch with realistic UA.
    try {
      const html = await serverFetchHtml(url);
      const parsed = await extractFromHtml(html, url, expectedKind);
      const ok = expectedKind === 'reviews' ? parsed.reviews.length : parsed.variations.length;
      if (ok) return { extraction: parsed, source: 'server_fetch' };
    } catch (e) {
      console.warn('[fr agent server_fetch]', e.message);
    }
    return null;
  }

  app.post('/api/flavor-reviews/import/agent', requireAuth, async (req, res) => {
    try {
      if (!aiReady) return res.status(503).json({ error: 'AI disabled — ANTHROPIC_API_KEY not set on the server.' });
      const url = String(req.body?.url || '').trim();
      const inboxId = Number(req.body?.inbox_id || 0);
      if (!url && !inboxId) return res.status(400).json({ error: 'Provide a URL or pick an inbox capture.' });

      // 1. Resolve URL + classification (inbox source URL wins over passed URL).
      let urlToUse = url;
      let inboxRow = null;
      if (inboxId) {
        inboxRow = await get('SELECT id, html, source_url, kind FROM fr_scraper_inbox WHERE id=?', inboxId);
        if (!inboxRow) return res.status(404).json({ error: 'Inbox capture not found' });
        if (inboxRow.source_url) urlToUse = inboxRow.source_url;
      }
      const detected = classifyAmazonUrl(urlToUse);
      if (detected.kind === 'unsupported') {
        return res.json({
          ok: false,
          action: 'unsupported',
          source_url: urlToUse,
          message: `Only Amazon URLs are supported right now. Got: ${urlToUse}`,
        });
      }

      // Decide what kind to extract for. Inbox row already declares its kind;
      // for raw URLs we use the detected path. "unknown" defaults to product.
      const expectedKind = inboxRow ? inboxRow.kind
        : (detected.kind === 'reviews' ? 'reviews' : 'product');

      // 2. Get extraction
      let extraction = null;
      let source = null;
      if (inboxRow) {
        try {
          extraction = await extractFromHtml(inboxRow.html, urlToUse, expectedKind);
          source = 'bookmarklet_inbox';
        } catch (e) {
          console.warn('[fr agent inbox extract]', e.message);
        }
      }
      if (!extraction || (expectedKind === 'reviews' ? !extraction.reviews.length : !extraction.variations.length)) {
        if (urlToUse) {
          const got = await fetchAndExtract(urlToUse, expectedKind);
          if (got) { extraction = got.extraction; source = got.source; }
        }
      }

      if (!extraction || (expectedKind === 'reviews' ? !extraction.reviews.length : !extraction.variations.length)) {
        // Couldn't get anything useful. Tell the user to use the bookmarklet.
        return res.json({
          ok: false,
          action: 'needs_capture',
          source_url: urlToUse,
          detected,
          expected_kind: expectedKind,
          message: 'Couldn\'t auto-fetch the page (Amazon usually blocks server-side scrapes). Click the bookmarklet on this URL in your browser — it\'ll land in the inbox and you can re-run the agent picking that capture.',
        });
      }

      // 3. Branch on kind
      if (expectedKind === 'reviews') {
        // Look up flavor by ASIN — first via fr_flavor_links, fall back to fr_flavors.amazon_asin
        let flavor = null;
        if (detected.asin) {
          flavor = await get(
            `SELECT f.id, f.name, f.variant FROM fr_flavors f
             JOIN fr_flavor_links l ON l.flavor_id=f.id
             WHERE l.asin=? LIMIT 1`, detected.asin);
          if (!flavor) {
            flavor = await get('SELECT id, name, variant FROM fr_flavors WHERE amazon_asin=? LIMIT 1', detected.asin);
          }
        }
        return res.json({
          ok: true,
          action: 'reviews-proposal',
          kind: 'reviews',
          source_url: urlToUse,
          source,
          detected,
          flavor,            // null if no match — UI will ask user to pick
          reviews: extraction.reviews,
        });
      }

      // Product path
      // Backfill ASINs from URL if Claude missed any
      for (const v of extraction.variations) {
        if (!v.asin && detected.asin) v.asin = detected.asin;
      }

      // Match against existing catalog. Same simple two-pass as match-batch:
      // exact case-insensitive name, then AI fuzzy if anything's left.
      const flavors = await all('SELECT id, name, variant, kind FROM fr_flavors');
      const matches = extraction.variations.map((v, idx) => {
        const name = String(v.flavor_name || '').trim().toLowerCase();
        if (!name) return { variation_index: idx, suggested_flavor_id: null, confidence: 0 };
        const hit = flavors.find(f => f.name.toLowerCase() === name);
        if (hit) return { variation_index: idx, suggested_flavor_id: hit.id, suggested_flavor_name: hit.name, confidence: 1.0 };
        return { variation_index: idx, suggested_flavor_id: null, confidence: 0 };
      });
      const unmatched = matches.filter(m => m.suggested_flavor_id === null);
      if (unmatched.length && flavors.length) {
        try {
          const system = "You match candidate flavor names against an existing catalog. " +
            "Return ONLY JSON: { \"<index>\": <existing_flavor_id or null>, ... }. " +
            "Match only when confident. Ignore size/pack qualifiers.";
          const userText =
            `Existing flavors:\n` + flavors.map(f => `id=${f.id} ${f.name} (${f.variant})`).join('\n') +
            `\n\nCandidates:\n` + unmatched.map(m => `index=${m.variation_index} ${extraction.variations[m.variation_index].flavor_name} — ${extraction.variations[m.variation_index].title}`).join('\n');
          const raw = await anthropicCall({ system, userText, maxTokens: 600 });
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
          const scores = JSON.parse(cleaned);
          for (const m of unmatched) {
            const v = scores[String(m.variation_index)];
            if (v != null && Number.isFinite(Number(v))) {
              const flav = flavors.find(f => f.id === Number(v));
              if (flav) { m.suggested_flavor_id = flav.id; m.suggested_flavor_name = flav.name; m.confidence = 0.6; }
            }
          }
        } catch (e) {
          console.warn('[fr agent fuzzy match]', e.message);
        }
      }

      // 4. Opportunistic reviews pull from /product-reviews/<asin>/.
      // Best-effort. If Amazon blocks (typical), we just skip and the user can
      // re-run the agent on the reviews URL via the bookmarklet inbox.
      let bonusReviews = null;
      if (detected.asin && expectedKind === 'product') {
        const reviewsUrl = 'https://www.amazon.com/product-reviews/' + detected.asin + '/';
        try {
          const got = await fetchAndExtract(reviewsUrl, 'reviews');
          if (got && got.extraction.reviews.length) {
            bonusReviews = {
              url: reviewsUrl,
              reviews: got.extraction.reviews,
              fetched_via: got.source,
            };
          }
        } catch (e) {
          console.warn('[fr agent bonus reviews]', e.message);
        }
      }

      return res.json({
        ok: true,
        action: 'product-proposal',
        kind: 'product',
        source_url: urlToUse,
        source,
        detected,
        page_summary: extraction.page_summary,
        variations: extraction.variations,
        matches,
        bonus_reviews: bonusReviews,
      });
    } catch (e) {
      console.error('[fr agent] failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[flavor-reviews] mounted (' + (aiReady ? 'AI enabled' : 'AI disabled — set ANTHROPIC_API_KEY') + ')');
};
