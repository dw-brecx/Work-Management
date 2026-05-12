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
  const { get, all, run, requireAuth, requireAdmin } = deps;

  // Listing types are baked in (single, single+pump, 4-pack, 6-pack). Adding
  // a new pack format means a code change anyway (price rules, channel
  // SKU generation, etc.), so a hardcoded enum is honest about that.
  const LISTING_TYPES = ['single', 'single_with_pump', '4_pack', '6_pack'];
  const SYRUP_USES_SETTING   = ['coffee', 'fruity', 'other'];
  const FLAVOR_TYPE_FILTERS  = ['natural', 'natural_and_artificial', 'any'];

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
  //
  // Side effect: when upc / sku flips from blank → set, we auto-close the
  // matching pipeline ticket so the worker doesn't have to bounce over to the
  // tickets list to mark it done. Saves clicks and keeps the bottle in sync.
  const PATCH_FIELDS = ['upc', 'sku', 'status'];
  app.patch('/api/flavors2/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const before = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!before) return res.status(404).json({ error: 'Not found' });

      const sets = []; const args = [];
      const cleaned = {};
      for (const f of PATCH_FIELDS) {
        if (f in req.body) {
          const v = String(req.body[f] || '').trim();
          cleaned[f] = v;
          sets.push(`${f}=?`);
          args.push(v);
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      if (req.body.status === 'complete') {
        sets.push(`completed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      }
      args.push(id);
      await run(`UPDATE flavors_v2 SET ${sets.join(',')} WHERE id=?`, ...args);

      // Auto-close the matching pipeline ticket on first set. Only fires
      // when the field went blank → non-blank (preventing a re-edit from
      // re-closing an already-reopened ticket). The status fan-out hook in
      // server.js's PUT /api/tickets will then take over from there
      // (notifications, downstream label-review spawn, etc.).
      if (cleaned.upc && !before.upc) await closeStepTicket(id, 'upc');
      if (cleaned.sku && !before.sku) await closeStepTicket(id, 'sku');

      // Phase-2 trigger: once both UPC and SKU are set, spawn the NineYard
      // and Label Design tickets so their descriptions can embed the real
      // identifiers instead of placeholder "(pending)" strings. Idempotent
      // — only fires when the phase-2 tickets don't yet exist.
      const after = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if ((cleaned.upc !== undefined || cleaned.sku !== undefined)
          && after.upc && after.sku) {
        await maybeSpawnPhase2(after);
      }

      res.json(shape(after, { open: 0, closed: 0 }));
    } catch (e) {
      console.error('[flavors2] patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  async function closeStepTicket(flavorId, step) {
    const t = await get(
      `SELECT id, status FROM tickets
        WHERE flavor_v2_id=? AND flavor_v2_step=? AND deleted_at IS NULL
          AND status != 'Closed'
        ORDER BY id ASC LIMIT 1`,
      flavorId, step
    );
    if (!t) return;
    await run(
      `UPDATE tickets
          SET status='Closed',
              closed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        WHERE id=?`,
      t.id
    );
  }

  // ── Launch pipeline (phase 1: UPC + SKU only) ─────────────────────────────
  // Spawn the two identifier-gathering tickets up front. The downstream
  // NineYard + Label Design tickets are deferred to maybeSpawnPhase2() and
  // only fire once both UPC and SKU are filled in — that way the real
  // identifiers land in their descriptions instead of "(pending)".
  app.post('/api/flavors2/:id/launch', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });

      const already = await get(
        'SELECT COUNT(*) AS n FROM tickets WHERE flavor_v2_id=? AND deleted_at IS NULL',
        id
      );
      if (Number(already?.n || 0) > 0) {
        return res.status(409).json({ error: 'Pipeline already launched for this flavor.' });
      }

      const created = [];
      for (const spec of phase1Specs(f)) {
        const t = await insertPipelineTicket(f, spec, req.session.userId);
        created.push(t);
      }

      // Defensive: if for some reason the flavor was created with UPC + SKU
      // already populated (bulk import, admin edit), fire phase 2 right away
      // so the launcher doesn't have to re-save the identifier fields.
      if (f.upc && f.sku) await maybeSpawnPhase2(f);

      res.status(201).json({ ok: true, tickets: created });
    } catch (e) {
      console.error('[flavors2] launch failed:', e.message);
      res.status(500).json({ error: 'Could not launch pipeline — please retry.' });
    }
  });

  // ── Phase 2 spawn ─────────────────────────────────────────────────────────
  // Idempotent — only inserts a phase-2 ticket if no live one exists for
  // that step. Called from PATCH /api/flavors2/:id after UPC + SKU are
  // both set, and from /launch defensively. Safe to call repeatedly.
  async function maybeSpawnPhase2(f) {
    for (const spec of phase2Specs(f)) {
      const exists = await get(
        `SELECT id FROM tickets
          WHERE flavor_v2_id=? AND flavor_v2_step=? AND deleted_at IS NULL`,
        f.id, spec.step
      );
      if (exists) continue;
      await insertPipelineTicket(f, spec, null);
    }
  }

  // Shared insert helper so phase-1, phase-2, and the label-review hook all
  // use the same shape (description in ticket_details, checklist in
  // ticket_subtasks, flavor_v2_name denormalised for chip rendering). We
  // deliberately do NOT set syruvia_flavor_id — that field is for the v1
  // external Syruvia Lab bridge, and populating it would make the ticket
  // detail page render an "Open in Syruvia" link to the wrong app.
  async function insertPipelineTicket(f, spec, createdBy) {
    const tid = await allocateTicketId();
    await run(
      `INSERT INTO tickets
        (id, title, status, priority, dept, created, overdue, tags_json,
         comments_count, created_by, flavor_v2_id, flavor_v2_step, flavor_v2_name)
       VALUES (?,?,?,?,?,?,0,?,0,?,?,?,?)`,
      tid, spec.title, 'Open', spec.priority, spec.dept,
      new Date().toISOString().slice(0,10), '[]',
      createdBy, f.id, spec.step, f.name
    );
    await run(
      `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
         ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
      tid, spec.description
    );
    for (let i = 0; i < (spec.checklist || []).length; i++) {
      await run(
        `INSERT INTO ticket_subtasks (ticket_id, position, text, done) VALUES (?,?,?,0)`,
        tid, i + 1, spec.checklist[i]
      );
    }
    return { id: tid, title: spec.title, step: spec.step };
  }

  // ── Pipeline specs ────────────────────────────────────────────────────────
  // Split into two phases. Phase-1 tickets (UPC, SKU) are spawned on launch
  // — their descriptions don't depend on identifiers. Phase-2 tickets
  // (NineYard, Label Design) wait until UPC + SKU are populated so they
  // can embed the real values into their descriptions and checklists.
  function flavorContext(f) {
    const typeLabel = f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular';
    const colorLine = f.color === 'none'
      ? 'None'
      : `${f.color}${f.syrup_color ? ' (' + f.syrup_color + ')' : ''}`;
    const flavorTypeLabel = f.flavor_type === 'natural_and_artificial'
      ? 'Natural + Artificial' : 'Natural';
    const saltLine = f.has_salt ? `Yes — ${f.salt_pct}%` : 'No';
    return {
      typeLabel,
      casePack: f.type === 'sugar_free' ? '24 per case' : '12 per case',
      shared: [
        `Flavor: ${f.name}`,
        `Type: ${typeLabel}`,
        `Color: ${colorLine}`,
        `Flavor type: ${flavorTypeLabel}`,
        `Use: ${f.use_of_syrup}`,
        `Salt: ${saltLine}`,
      ].join('\n'),
      flavorUrl: `/flavors.html#${f.id}`,
    };
  }

  function phase1Specs(f) {
    const { shared, casePack, flavorUrl } = flavorContext(f);
    return [
      {
        step: 'upc',
        title: `Get GS1 UPC for ${f.name}`,
        priority: 'High',
        dept: 'Operations',
        description:
          `Get a GS1 UPC for this flavor and enter it on the flavor detail page. ` +
          `The ticket auto-closes once the UPC is filled in.\n\n` +
          shared + `\nCase pack: ${casePack}\n\n` +
          `→ Enter UPC at: ${flavorUrl}`,
      },
      {
        step: 'sku',
        title: `Assign SKU for ${f.name}`,
        priority: 'High',
        dept: 'Operations',
        description:
          `Assign an internal SKU for this flavor and enter it on the flavor ` +
          `detail page. Auto-closes once filled in.\n\n` +
          shared + `\n\n→ Enter SKU at: ${flavorUrl}`,
      },
    ];
  }

  function phase2Specs(f) {
    const { shared, casePack } = flavorContext(f);
    const productName = `${f.name} ${f.type === 'sugar_free' ? 'Sugar-Free Syrup' : 'Syrup'}`;
    return [
      {
        step: 'nineyard',
        title: `Add ${f.name} to NineYard`,
        priority: 'Medium',
        dept: 'Operations',
        description:
          `Add this flavor to NineYard (POS inventory) with the values below.\n\n` +
          shared + `\n` +
          `\nValues to enter in NineYard:\n` +
          `  • SKU: ${f.sku}\n` +
          `  • UPC: ${f.upc}\n` +
          `  • Product name: ${productName}\n` +
          `  • Vendor: (your vendor)\n` +
          `  • Price: (per current price rules)\n` +
          `  • Case pack: ${casePack}\n\n` +
          `Check each line below as you enter it.`,
        checklist: [
          `SKU entered (${f.sku})`,
          `UPC entered (${f.upc})`,
          `Product name entered (${productName})`,
          'Vendor entered',
          'Price entered',
          `Case pack entered (${casePack})`,
        ],
      },
      {
        step: 'label_design',
        title: `Design label for ${f.name}`,
        priority: 'High',
        dept: 'Design',
        description:
          `Design the product label for this flavor. All identifiers are now ` +
          `final — bake them into the artwork as needed.\n\n` +
          shared + `\n` +
          `UPC: ${f.upc}\n` +
          `SKU: ${f.sku}\n\n` +
          `Ingredients:\n${f.ingredients}\n` +
          `Sodium: ${f.sodium_mg} mg / serving\n\n` +
          `Once the draft is ready, attach the file and confirm OU has been ` +
          `added. A review ticket is created automatically when you close ` +
          `this one.`,
        checklist: [
          'OU symbol added to the design',
          'Final label file attached',
        ],
      },
    ];
  }

  // Ticket-id allocator — mirrors the loop in server.js's POST /api/tickets
  // (max + 1 with a retry on collision). We don't share that endpoint
  // because we need to insert four tickets in one request and want to
  // attach flavor_v2_id / flavor_v2_step (the existing endpoint doesn't
  // accept those fields).
  async function allocateTicketId() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const maxRow = await get(
        `SELECT id FROM tickets WHERE id LIKE 'TKT-%'
          ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`
      );
      let nextNum = 1000;
      if (maxRow?.id) {
        const m = /^TKT-(\d+)$/.exec(maxRow.id);
        if (m) nextNum = parseInt(m[1], 10);
      }
      const candidate = 'TKT-' + (nextNum + 1);
      if (!await get('SELECT id FROM tickets WHERE id=?', candidate)) return candidate;
    }
    throw new Error('Could not allocate a unique ticket id');
  }

  // ── Settings: listing-type enum (read-only) ───────────────────────────────
  // Exposed to the client so the examples editor can populate its dropdown
  // without duplicating the constant. Authenticated users can read; only
  // admins write the actual examples below.
  app.get('/api/flavors2/settings/listing-types', requireAuth, (req, res) => {
    res.json({ types: LISTING_TYPES });
  });

  // ── Settings: channels CRUD ───────────────────────────────────────────────
  // All authenticated users can read the channel list (the eventual content
  // generator needs it). Mutations are admin-only — channels drive every
  // downstream pipeline ticket so accidental edits ripple.
  app.get('/api/flavors2/settings/channels', requireAuth, async (req, res) => {
    try {
      const rows = await all('SELECT * FROM flavor_channels ORDER BY position ASC, id ASC');
      res.json(rows.map(shapeChannel));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/flavors2/settings/channels', requireAdmin, async (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const code = String(req.body.code || '').trim().toLowerCase();
      const has_fba = req.body.has_fba ? 1 : 0;
      const enabled = req.body.enabled === false ? 0 : 1;
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!/^[a-z0-9_-]+$/.test(code)) {
        return res.status(400).json({ error: 'code must be lowercase letters / digits / dash / underscore' });
      }
      const dup = await get('SELECT id FROM flavor_channels WHERE code=?', code);
      if (dup) return res.status(409).json({ error: 'A channel with that code already exists.' });
      const maxPos = await get('SELECT MAX(position) AS p FROM flavor_channels');
      const pos = Number(maxPos?.p || 0) + 1;
      const ins = await run(
        'INSERT INTO flavor_channels (name, code, has_fba, enabled, position) VALUES (?,?,?,?,?) RETURNING id',
        name, code, has_fba, enabled, pos
      );
      const row = await get('SELECT * FROM flavor_channels WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapeChannel(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Whitelisted patch — `code` is omitted on purpose since the eventual
  // channel-SKU + price-rule tables will key off it. Rename via name only.
  app.patch('/api/flavors2/settings/channels/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const sets = []; const args = [];
      if ('name' in req.body) {
        const n = String(req.body.name || '').trim();
        if (!n) return res.status(400).json({ error: 'name cannot be blank' });
        sets.push('name=?'); args.push(n);
      }
      if ('has_fba' in req.body)  { sets.push('has_fba=?'); args.push(req.body.has_fba ? 1 : 0); }
      if ('enabled' in req.body)  { sets.push('enabled=?'); args.push(req.body.enabled ? 1 : 0); }
      if ('position' in req.body) { sets.push('position=?'); args.push(Number(req.body.position) || 0); }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      args.push(id);
      await run(`UPDATE flavor_channels SET ${sets.join(',')} WHERE id=?`, ...args);
      const row = await get('SELECT * FROM flavor_channels WHERE id=?', id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(shapeChannel(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/flavors2/settings/channels/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM flavor_channels WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  function shapeChannel(row) {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      has_fba: !!row.has_fba,
      enabled: !!row.enabled,
      position: row.position,
    };
  }

  // ── Settings: listing-content examples CRUD ───────────────────────────────
  // The user pastes their existing listing copy here keyed by
  // (syrup_use, flavor_type, listing_type). The eventual generator does
  // placeholder substitution against a flavor's data: {name}, {type},
  // {color}, {ingredients}, {sodium}, etc. See LISTING_PLACEHOLDERS below.
  app.get('/api/flavors2/settings/examples', requireAuth, async (req, res) => {
    try {
      const rows = await all('SELECT * FROM flavor_listing_examples ORDER BY syrup_use ASC, listing_type ASC, id DESC');
      res.json(rows.map(shapeExample));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/flavors2/settings/examples', requireAdmin, async (req, res) => {
    try {
      const { errors, clean } = validateExample(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      const ins = await run(
        `INSERT INTO flavor_listing_examples
          (name, syrup_use, flavor_type, listing_type,
           title_template, bullets_json, description_template, keywords, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        clean.name, clean.syrup_use, clean.flavor_type, clean.listing_type,
        clean.title_template, JSON.stringify(clean.bullets), clean.description_template,
        clean.keywords, clean.notes, req.session.userId
      );
      const row = await get('SELECT * FROM flavor_listing_examples WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapeExample(row));
    } catch (e) {
      console.error('[flavors2] example create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/flavors2/settings/examples/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM flavor_listing_examples WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      // Merge body over existing for validation — partial updates allowed.
      const merged = {
        name: 'name' in req.body ? req.body.name : existing.name,
        syrup_use: 'syrup_use' in req.body ? req.body.syrup_use : existing.syrup_use,
        flavor_type: 'flavor_type' in req.body ? req.body.flavor_type : existing.flavor_type,
        listing_type: 'listing_type' in req.body ? req.body.listing_type : existing.listing_type,
        title_template: 'title_template' in req.body ? req.body.title_template : existing.title_template,
        bullets: 'bullets' in req.body ? req.body.bullets : safeJSON(existing.bullets_json, []),
        description_template: 'description_template' in req.body ? req.body.description_template : existing.description_template,
        keywords: 'keywords' in req.body ? req.body.keywords : existing.keywords,
        notes: 'notes' in req.body ? req.body.notes : existing.notes,
      };
      const { errors, clean } = validateExample(merged);
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      await run(
        `UPDATE flavor_listing_examples SET
            name=?, syrup_use=?, flavor_type=?, listing_type=?,
            title_template=?, bullets_json=?, description_template=?,
            keywords=?, notes=?,
            updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          WHERE id=?`,
        clean.name, clean.syrup_use, clean.flavor_type, clean.listing_type,
        clean.title_template, JSON.stringify(clean.bullets), clean.description_template,
        clean.keywords, clean.notes, id
      );
      const row = await get('SELECT * FROM flavor_listing_examples WHERE id=?', id);
      res.json(shapeExample(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/flavors2/settings/examples/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM flavor_listing_examples WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  function validateExample(body) {
    const errors = [];
    const name = String(body.name || '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 120) errors.push('name too long');
    const syrup_use = String(body.syrup_use || 'other').trim();
    if (!SYRUP_USES_SETTING.includes(syrup_use)) errors.push('syrup_use must be coffee, fruity, or other');
    const flavor_type = String(body.flavor_type || 'any').trim();
    if (!FLAVOR_TYPE_FILTERS.includes(flavor_type)) errors.push('flavor_type must be natural, natural_and_artificial, or any');
    const listing_type = String(body.listing_type || 'single').trim();
    if (!LISTING_TYPES.includes(listing_type)) errors.push('listing_type invalid');

    let bullets = body.bullets;
    if (typeof bullets === 'string') bullets = bullets.split('\n').map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(bullets)) bullets = [];
    bullets = bullets.map(b => String(b || '').trim()).filter(Boolean).slice(0, 10);

    return {
      errors,
      clean: {
        name, syrup_use, flavor_type, listing_type,
        title_template:       String(body.title_template       || '').trim().slice(0, 500),
        description_template: String(body.description_template || '').trim().slice(0, 5000),
        keywords:             String(body.keywords             || '').trim().slice(0, 2000),
        notes:                String(body.notes                || '').trim().slice(0, 1000),
        bullets,
      },
    };
  }

  function shapeExample(row) {
    return {
      id: row.id,
      name: row.name,
      syrup_use: row.syrup_use,
      flavor_type: row.flavor_type,
      listing_type: row.listing_type,
      title_template: row.title_template,
      bullets: safeJSON(row.bullets_json, []),
      description_template: row.description_template,
      keywords: row.keywords,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function safeJSON(s, fallback) {
    try { const v = JSON.parse(s); return v == null ? fallback : v; }
    catch { return fallback; }
  }

  // ── Hook exposed to server.js's PUT /api/tickets ──────────────────────────
  // Called when a ticket transitions to Closed. If the ticket is part of the
  // label-design step of a flavor pipeline, we spawn the follow-up label
  // review ticket. Kept here (not inline in server.js) so all flavor-launch
  // logic lives in one file.
  app.locals.flavorsHook = {
    async onTicketClosed(ticket) {
      try {
        if (!ticket || !ticket.flavor_v2_id) return;
        if (ticket.flavor_v2_step !== 'label_design') return;
        const f = await get('SELECT * FROM flavors_v2 WHERE id=?', ticket.flavor_v2_id);
        if (!f) return;
        // Idempotency: don't spawn a second review ticket if one already
        // exists (e.g. label design ticket is reopened and re-closed).
        const exists = await get(
          `SELECT id FROM tickets
            WHERE flavor_v2_id=? AND flavor_v2_step='label_review' AND deleted_at IS NULL`,
          f.id
        );
        if (exists) return;
        const desc =
          `The label design ticket ${ticket.id} just closed for "${f.name}". ` +
          `Review the attached label and confirm it's ready to send to print.\n\n` +
          `Approve → close this ticket.\n` +
          `Reject → comment with the issue and reopen ${ticket.id}.\n\n` +
          `Flavor: ${f.name}\n` +
          `Type: ${f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular'}\n` +
          `UPC: ${f.upc || '(pending)'}\n` +
          `SKU: ${f.sku || '(pending)'}`;
        await insertPipelineTicket(f, {
          step: 'label_review',
          title: `Review label design for ${f.name}`,
          priority: 'High',
          dept: 'Design',
          description: desc,
        }, null);
      } catch (e) {
        console.warn('[flavorsHook.onTicketClosed] failed:', e && e.message);
      }
    },
  };

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
