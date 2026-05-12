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

      const row = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      res.json(shape(row, { open: 0, closed: 0 }));
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

  // ── Launch pipeline ───────────────────────────────────────────────────────
  // Atomically spawn the four initial tickets (UPC, SKU, NineYard, Label
  // Design) for a flavor. Each ticket carries flavor_v2_id + flavor_v2_step
  // so the bottle viz on the detail page tallies them, and the upc/sku
  // tickets auto-close once their value lands on the flavor record (see
  // PATCH handler above). Refuses to fire twice — if any pipeline ticket
  // already exists for the flavor, returns 409.
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
      for (const spec of pipelineSpecs(f)) {
        const tid = await allocateTicketId();
        await run(
          `INSERT INTO tickets
            (id, title, status, priority, dept, created, overdue, tags_json,
             comments_count, created_by, flavor_v2_id, flavor_v2_step,
             syruvia_flavor_id, syruvia_flavor_name)
           VALUES (?,?,?,?,?,?,0,?,0,?,?,?,?,?)`,
          tid, spec.title, 'Open', spec.priority, spec.dept,
          new Date().toISOString().slice(0,10), '[]',
          req.session.userId, id, spec.step,
          'flavor_v2:' + id, f.name
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
        created.push({ id: tid, title: spec.title, step: spec.step });
      }

      res.status(201).json({ ok: true, tickets: created });
    } catch (e) {
      console.error('[flavors2] launch failed:', e.message);
      res.status(500).json({ error: 'Could not launch pipeline — please retry.' });
    }
  });

  // ── Pipeline specs ────────────────────────────────────────────────────────
  // Where the rich per-step ticket content lives. Each entry is a single
  // ticket: title, description (markdown-ish plain text — rendered as
  // text in our current ticket detail view), optional checklist of subtask
  // titles, priority, dept. Description string assembly is deliberately
  // explicit so a glance tells you exactly what the worker will see.
  function pipelineSpecs(f) {
    const typeLabel = f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular';
    const casePack  = f.type === 'sugar_free' ? '24 per case' : '12 per case';
    const colorLine = f.color === 'none'
      ? 'None'
      : `${f.color}${f.syrup_color ? ' (' + f.syrup_color + ')' : ''}`;
    const flavorTypeLabel = f.flavor_type === 'natural_and_artificial'
      ? 'Natural + Artificial' : 'Natural';
    const saltLine = f.has_salt ? `Yes — ${f.salt_pct}%` : 'No';
    const flavorUrl = `/flavors.html#${f.id}`;

    const sharedContext = [
      `Flavor: ${f.name}`,
      `Type: ${typeLabel}`,
      `Color: ${colorLine}`,
      `Flavor type: ${flavorTypeLabel}`,
      `Use: ${f.use_of_syrup}`,
      `Salt: ${saltLine}`,
    ].join('\n');

    return [
      {
        step: 'upc',
        title: `Get GS1 UPC for ${f.name}`,
        priority: 'High',
        dept: 'Operations',
        description:
          `Get a GS1 UPC for this flavor and enter it on the flavor detail page. ` +
          `The ticket auto-closes once the UPC is filled in.\n\n` +
          sharedContext + `\nCase pack: ${casePack}\n\n` +
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
          sharedContext + `\n\n→ Enter SKU at: ${flavorUrl}`,
      },
      {
        step: 'nineyard',
        title: `Add ${f.name} to NineYard`,
        priority: 'Medium',
        dept: 'Operations',
        description:
          `Add this flavor to NineYard (POS inventory). SKU + UPC come from ` +
          `the linked tickets in this pipeline — wait until those land before ` +
          `you start, or coordinate so values are entered together.\n\n` +
          sharedContext + `\nCase pack: ${casePack}\n\n` +
          `Check each line below as you enter it.`,
        checklist: [
          'SKU entered',
          'UPC entered',
          'Product name entered',
          'Vendor entered',
          'Price entered',
          'Case pack entered',
        ],
      },
      {
        step: 'label_design',
        title: `Design label for ${f.name}`,
        priority: 'High',
        dept: 'Design',
        description:
          `Design the product label for this flavor. UPC + SKU may not be ` +
          `available yet — check the flavor detail page or coordinate with ` +
          `the linked tickets if your design needs them on the artwork.\n\n` +
          sharedContext + `\n` +
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
        const tid = await allocateTicketId();
        const desc =
          `The label design ticket ${ticket.id} just closed for "${f.name}". ` +
          `Review the attached label and confirm it's ready to send to print.\n\n` +
          `Approve → close this ticket.\n` +
          `Reject → comment with the issue and reopen ${ticket.id}.\n\n` +
          `Flavor: ${f.name}\n` +
          `Type: ${f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular'}\n` +
          `UPC: ${f.upc || '(pending)'}\n` +
          `SKU: ${f.sku || '(pending)'}`;
        await run(
          `INSERT INTO tickets
            (id, title, status, priority, dept, created, overdue, tags_json,
             comments_count, created_by, flavor_v2_id, flavor_v2_step,
             syruvia_flavor_id, syruvia_flavor_name)
           VALUES (?,?,?,?,?,?,0,?,0,?,?,?,?,?)`,
          tid, `Review label design for ${f.name}`, 'Open', 'High', 'Design',
          new Date().toISOString().slice(0,10), '[]',
          null, f.id, 'label_review',
          'flavor_v2:' + f.id, f.name
        );
        await run(
          `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
             ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
          tid, desc
        );
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
