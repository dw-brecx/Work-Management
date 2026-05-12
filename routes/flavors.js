// ─────────────────────────────────────────────────────────────────────────────
// Flavors v2 — REST API
//
// Guided flavor-launch wizard. Captures the formula inputs (sugar vs sugar-
// free, color, salt %, syrup use case, etc.), auto-generates the ingredient
// list + per-serving sodium value, persists the flavor, and (in later phases)
// spawns the linked ticket pipeline (UPC, SKU, NineYard, label, listing
// content, images, channel listings, mappings, variations).
//
// Lives in its own file per the one-file-per-feature convention.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function attach(app, deps) {
  const { get, all, run, requireAuth } = deps;

  // ── Formula rules ─────────────────────────────────────────────────────────
  // Ingredient list rules, factored out so the wizard preview (client side)
  // and the persisted record (server side) can never drift. Server is
  // authoritative — POST recomputes and stores.
  const TYPES         = ['regular', 'sugar_free'];
  const COLORS        = ['natural', 'caramel', 'none'];
  const FLAVOR_TYPES  = ['natural', 'natural_and_artificial'];
  const SYRUP_USES    = ['coffee', 'fruity', 'other'];

  function colorPhrase(color) {
    if (color === 'caramel') return 'CARAMEL COLOR';
    if (color === 'natural') return 'NATURAL COLOR';
    return '';
  }

  function flavorPhrase(flavorType) {
    return flavorType === 'natural_and_artificial'
      ? 'NATURAL AND ARTIFICIAL FLAVORS'
      : 'NATURAL FLAVORS';
  }

  function generateIngredients({ type, color, flavor_type, has_salt }) {
    const flavorWord = flavorPhrase(flavor_type);
    const tail = [];
    if (has_salt) tail.push('SALT');
    const colorWord = colorPhrase(color);
    if (colorWord) tail.push(colorWord);
    const tailStr = tail.length ? ', ' + tail.join(', ') : '';

    if (type === 'sugar_free') {
      return `WATER, ${flavorWord}, GUM, SUCRALOSE, SODIUM ACID SULFATE (PRESERVATIVE), CITRIC ACID (FRESHNESS), SODIUM BENZOATE, POTASSIUM SORBATE & ACE K (PRESERVATIVES)${tailStr}.`;
    }
    return `PURE CANE SUGAR, WATER, ${flavorWord}, SODIUM ACID SULFATE (PRESERVATIVE), CITRIC ACID (FRESHNESS), SODIUM BENZOATE & POTASSIUM SORBATE (PRESERVATIVES)${tailStr}.`;
  }

  // sodium mg per serving = 30g serving size * factor * (salt% / 100) * 393.
  // Factor is 1.3 for regular, 1.2 for sugar-free (per the source spreadsheet).
  // Returns 0 if has_salt is false. Rounded to nearest integer for display
  // on the nutrition label.
  function computeSodiumMg({ type, has_salt, salt_pct }) {
    if (!has_salt) return 0;
    const factor = type === 'regular' ? 1.3 : 1.2;
    const pctDecimal = Number(salt_pct || 0) / 100;
    if (!Number.isFinite(pctDecimal) || pctDecimal <= 0) return 0;
    return Math.round(30 * factor * pctDecimal * 393);
  }

  // ── Input validation ──────────────────────────────────────────────────────
  function validate(body) {
    const errors = [];
    const name = String(body.name || '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 80) errors.push('name too long');

    const type = String(body.type || '').trim();
    if (!TYPES.includes(type)) errors.push('type must be regular or sugar_free');

    const color = String(body.color || 'none').trim();
    if (!COLORS.includes(color)) errors.push('color must be natural, caramel, or none');

    const syrup_color = String(body.syrup_color || '').trim();
    if (syrup_color.length > 60) errors.push('syrup_color too long');

    const flavor_type = String(body.flavor_type || '').trim();
    if (!FLAVOR_TYPES.includes(flavor_type)) errors.push('flavor_type must be natural or natural_and_artificial');

    const use_of_syrup = String(body.use_of_syrup || '').trim();
    if (!SYRUP_USES.includes(use_of_syrup)) errors.push('use_of_syrup must be coffee, fruity, or other');

    const has_salt = !!body.has_salt;
    let salt_pct = Number(body.salt_pct || 0);
    if (!Number.isFinite(salt_pct) || salt_pct < 0) salt_pct = 0;
    if (has_salt && salt_pct <= 0) errors.push('salt_pct must be > 0 when has_salt is true');
    if (salt_pct > 100) errors.push('salt_pct must be <= 100');

    return {
      errors,
      clean: { name, type, color, syrup_color, flavor_type, use_of_syrup, has_salt, salt_pct },
    };
  }

  // ── Preview ───────────────────────────────────────────────────────────────
  // Used by the wizard to live-render the ingredient list + sodium value as
  // the user changes their answers, without writing anything. Validation is
  // best-effort: invalid input returns 200 with empty strings rather than 400
  // so the preview pane never flashes errors mid-typing.
  app.post('/api/flavors2/preview', requireAuth, async (req, res) => {
    try {
      const { clean } = validate(req.body || {});
      const ingredients = clean.type && clean.flavor_type
        ? generateIngredients(clean) : '';
      const sodium_mg = clean.type ? computeSodiumMg(clean) : 0;
      res.json({ ingredients, sodium_mg });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.post('/api/flavors2', requireAuth, async (req, res) => {
    try {
      const { errors, clean } = validate(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });

      const ingredients = generateIngredients(clean);
      const sodium_mg = computeSodiumMg(clean);

      const ins = await run(
        `INSERT INTO flavors_v2
          (name, type, color, syrup_color, flavor_type, use_of_syrup, has_salt, salt_pct,
           ingredients, sodium_mg, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        clean.name, clean.type, clean.color, clean.syrup_color,
        clean.flavor_type, clean.use_of_syrup, clean.has_salt ? 1 : 0, clean.salt_pct,
        ingredients, sodium_mg, 'draft', req.session.userId
      );
      const id = ins?.lastInsertRowid;
      const row = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      res.status(201).json(shape(row, { open: 0, closed: 0 }));
    } catch (e) {
      console.error('[flavors2] create failed:', e.message);
      res.status(500).json({ error: 'Could not create flavor — please retry.' });
    }
  });

  // ── List ──────────────────────────────────────────────────────────────────
  // Each row carries a tally of linked tickets so the list view can show a
  // mini progress chip without an extra round trip per row.
  app.get('/api/flavors2', requireAuth, async (req, res) => {
    try {
      const rows = await all(
        `SELECT * FROM flavors_v2 ORDER BY created_at DESC, id DESC`
      );
      const counts = await all(
        `SELECT flavor_v2_id,
                SUM(CASE WHEN status='Closed' THEN 1 ELSE 0 END) AS closed,
                SUM(CASE WHEN status!='Closed' THEN 1 ELSE 0 END) AS open
           FROM tickets
          WHERE flavor_v2_id IS NOT NULL AND deleted_at IS NULL
          GROUP BY flavor_v2_id`
      );
      const tally = new Map();
      for (const c of counts) tally.set(Number(c.flavor_v2_id), {
        open: Number(c.open || 0), closed: Number(c.closed || 0),
      });
      res.json(rows.map(r => shape(r, tally.get(r.id) || { open: 0, closed: 0 })));
    } catch (e) {
      console.error('[flavors2] list failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Single ────────────────────────────────────────────────────────────────
  app.get('/api/flavors2/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const row = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      const c = await get(
        `SELECT SUM(CASE WHEN status='Closed' THEN 1 ELSE 0 END) AS closed,
                SUM(CASE WHEN status!='Closed' THEN 1 ELSE 0 END) AS open
           FROM tickets
          WHERE flavor_v2_id=? AND deleted_at IS NULL`,
        id
      );
      const tickets = await all(
        `SELECT id, title, status, priority, assignee, due, flavor_v2_step
           FROM tickets
          WHERE flavor_v2_id=? AND deleted_at IS NULL
          ORDER BY id ASC`,
        id
      );
      res.json({
        ...shape(row, { open: Number(c?.open || 0), closed: Number(c?.closed || 0) }),
        tickets,
      });
    } catch (e) {
      console.error('[flavors2] get failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Update (UPC / SKU / status) ───────────────────────────────────────────
  // Whitelisted fields only — formula inputs are immutable after creation so
  // the audited ingredient list never silently changes under existing tickets.
  // If you really need to re-derive, delete and re-create the flavor.
  const PATCH_FIELDS = ['upc', 'sku', 'status'];
  app.patch('/api/flavors2/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const sets = []; const args = [];
      for (const f of PATCH_FIELDS) {
        if (f in req.body) {
          sets.push(`${f}=?`);
          args.push(String(req.body[f] || '').trim());
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      if (req.body.status === 'complete') {
        sets.push(`completed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      }
      args.push(id);
      await run(`UPDATE flavors_v2 SET ${sets.join(',')} WHERE id=?`, ...args);
      const row = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      res.json(shape(row, { open: 0, closed: 0 }));
    } catch (e) {
      console.error('[flavors2] patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  app.delete('/api/flavors2/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      // Detach any tickets so they don't dangle with a missing flavor_v2_id.
      await run('UPDATE tickets SET flavor_v2_id=NULL WHERE flavor_v2_id=?', id);
      await run('DELETE FROM flavors_v2 WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[flavors2] delete failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Shaping ───────────────────────────────────────────────────────────────
  // pg's NUMERIC + INTEGER columns come back as JS numbers / strings depending
  // on the driver; we normalise everything the client touches so the UI can
  // assume types without defensive coercion.
  function shape(row, tickets) {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      color: row.color,
      syrup_color: row.syrup_color || '',
      flavor_type: row.flavor_type,
      use_of_syrup: row.use_of_syrup,
      has_salt: !!row.has_salt,
      salt_pct: Number(row.salt_pct || 0),
      ingredients: row.ingredients,
      sodium_mg: Number(row.sodium_mg || 0),
      upc: row.upc || '',
      sku: row.sku || '',
      status: row.status,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      tickets_open: tickets.open,
      tickets_closed: tickets.closed,
    };
  }
};
