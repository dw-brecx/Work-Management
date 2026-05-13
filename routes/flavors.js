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
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

module.exports = function attach(app, deps) {
  const { get, all, run, requireAuth, requireAdmin, UPLOADS_DIR } = deps;

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
  // `use_of_syrup` is now any non-empty string — Build B replaced the
  // 3-option enum with the 10-category product-type taxonomy backed by
  // flavor_product_types. The wizard reads keys from that table dynamically;
  // we accept whatever it sends as long as it's a non-empty slug. Lookup
  // happens at render time (so a deleted product type degrades to a clear
  // "no template" message rather than rejecting on save).
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
    if (!use_of_syrup) errors.push('use_of_syrup is required');
    if (use_of_syrup.length > 60) errors.push('use_of_syrup too long');

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
        await maybeSpawnPhase2(after, req.session.userId);
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
      if (f.upc && f.sku) await maybeSpawnPhase2(f, req.session.userId);

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
  async function maybeSpawnPhase2(f, createdBy) {
    for (const spec of phase2Specs(f)) {
      const exists = await get(
        `SELECT id FROM tickets
          WHERE flavor_v2_id=? AND flavor_v2_step=? AND deleted_at IS NULL`,
        f.id, spec.step
      );
      if (exists) continue;
      await insertPipelineTicket(f, spec, createdBy || null);
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
    // Defensive: coerce to string + log length so a future "description
    // empty after spawn" report is debuggable from server logs. The
    // existing /api/tickets POST does String(req.body?.description || '')
    // for the same reason.
    const desc = String(spec.description || '');
    console.log(
      `[flavors2] insertPipelineTicket flavor=${f.id} step=${spec.step} ` +
      `ticket=${tid} desc.len=${desc.length} checklist.len=${(spec.checklist || []).length}`
    );
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
      tid, desc
    );
    // Verify the description actually landed. If the INSERT silently writes
    // empty text we want a loud warning in the logs the first time it
    // happens, not a quiet "no description" UI bug that takes a day to
    // diagnose. One extra read per pipeline ticket is cheap.
    if (desc.length > 0) {
      const back = await get(
        'SELECT LENGTH(description) AS n FROM ticket_details WHERE ticket_id=?',
        tid
      );
      const n = Number(back?.n || 0);
      if (n === 0) {
        console.warn(
          `[flavors2] description read-back len=0 for ticket=${tid} — write claimed ${desc.length} chars`
        );
      } else if (n !== desc.length) {
        console.warn(
          `[flavors2] description read-back len=${n} but wrote len=${desc.length} for ticket=${tid}`
        );
      }
    }
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

  // ── Attachment carry-over ─────────────────────────────────────────────────
  // Used by the label-review spawn. We pull every file that was uploaded to
  // the source ticket via any path (direct, subtask, comment) and physically
  // duplicate it on disk under a fresh UUID filename. The new attachment
  // rows are top-level on the destination ticket (comment_id / subtask_id
  // NULL) so the reviewer sees the deliverable files immediately on the
  // Attachments tab without re-opening the comment thread.
  //
  // Why duplicate on disk vs. share the file: /api/attachments/:id
  // unconditionally fs.unlinkSync()'s the file when its row is deleted —
  // so a "shared file, two rows" approach would have the design ticket's
  // delete silently 404-ing the review's attachment. Disk cost is bounded
  // (label files are small).
  async function copyTicketAttachmentsTo(srcTicketId, dstTicketId) {
    if (!UPLOADS_DIR) {
      console.warn('[flavorsHook] copyTicketAttachmentsTo: UPLOADS_DIR not set');
      return;
    }
    let rows = [];
    try {
      rows = await all(
        `SELECT a.* FROM attachments a
          WHERE a.ticket_id = ?
             OR a.subtask_id IN (SELECT id FROM ticket_subtasks WHERE ticket_id = ?)
             OR a.comment_id IN (SELECT id FROM ticket_comments WHERE ticket_id = ?)
          ORDER BY a.created_at ASC`,
        srcTicketId, srcTicketId, srcTicketId
      );
    } catch (e) {
      console.warn('[flavorsHook] attachment query failed:', e && e.message);
      return;
    }
    if (!rows.length) {
      console.log(`[flavorsHook] no attachments to copy from ${srcTicketId} → ${dstTicketId}`);
      return;
    }
    let copied = 0;
    for (const a of rows) {
      const srcPath = path.join(UPLOADS_DIR, a.filename);
      if (!fs.existsSync(srcPath)) {
        console.warn(`[flavorsHook] missing source file ${srcPath} — skipping`);
        continue;
      }
      const ext = path.extname(a.filename) || '';
      const newFilename = randomUUID() + ext;
      const dstPath = path.join(UPLOADS_DIR, newFilename);
      try {
        fs.copyFileSync(srcPath, dstPath);
      } catch (e) {
        console.warn(`[flavorsHook] copyFileSync failed for ${a.filename}:`, e && e.message);
        continue;
      }
      try {
        await run(
          `INSERT INTO attachments (ticket_id, filename, original_name, mime_type, size, uploader)
             VALUES (?, ?, ?, ?, ?, ?)`,
          dstTicketId, newFilename,
          a.original_name || '', a.mime_type || '',
          Number(a.size || 0), a.uploader || ''
        );
        copied++;
      } catch (e) {
        // INSERT failed — clean up the orphaned file copy.
        console.warn(`[flavorsHook] attachment row insert failed for ${newFilename}:`, e && e.message);
        try { fs.unlinkSync(dstPath); } catch {}
      }
    }
    console.log(`[flavorsHook] copied ${copied}/${rows.length} attachment(s) from ${srcTicketId} → ${dstTicketId}`);
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
      if ('sku_pattern' in req.body) {
        const p = String(req.body.sku_pattern || '').trim();
        if (!p) return res.status(400).json({ error: 'sku_pattern cannot be blank' });
        sets.push('sku_pattern=?'); args.push(p);
      }
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
      // Legacy single-template column — kept on the wire for older clients,
      // but the new SKU generator ignores it in favour of the per-pattern
      // rows in flavor_channel_sku_patterns. New UI doesn't surface this.
      sku_pattern: row.sku_pattern || '{sku}-{channel}-{listing}{-fulfillment}',
    };
  }

  // ── SKU patterns: per-(channel × listing × fulfillment) CRUD ──────────────
  // Patterns are scoped to a channel and listed in position order so the
  // user controls the row order in Settings. Fulfillment is freeform text
  // (so a channel can use fba / fbm / wfs / blank / anything) — generator
  // stores whatever's in the row.
  app.get('/api/flavors2/settings/channels/:id/sku-patterns', requireAuth, async (req, res) => {
    try {
      const cid = Number(req.params.id);
      if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Bad channel id' });
      const rows = await all(
        'SELECT * FROM flavor_channel_sku_patterns WHERE channel_id=? ORDER BY position ASC, id ASC',
        cid
      );
      res.json(rows.map(shapeSkuPattern));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/flavors2/settings/channels/:id/sku-patterns', requireAdmin, async (req, res) => {
    try {
      const cid = Number(req.params.id);
      if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Bad channel id' });
      const { errors, clean } = validateSkuPattern(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      const dup = await get(
        'SELECT id FROM flavor_channel_sku_patterns WHERE channel_id=? AND listing_type=? AND fulfillment=?',
        cid, clean.listing_type, clean.fulfillment
      );
      if (dup) return res.status(409).json({ error: 'A pattern for that (listing, fulfillment) already exists. Edit that one.' });
      const maxPos = await get('SELECT MAX(position) AS p FROM flavor_channel_sku_patterns WHERE channel_id=?', cid);
      const pos = Number(maxPos?.p || 0) + 1;
      const ins = await run(
        `INSERT INTO flavor_channel_sku_patterns
           (channel_id, listing_type, fulfillment, template, position)
         VALUES (?,?,?,?,?) RETURNING id`,
        cid, clean.listing_type, clean.fulfillment, clean.template, pos
      );
      const row = await get('SELECT * FROM flavor_channel_sku_patterns WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapeSkuPattern(row));
    } catch (e) {
      console.error('[flavors2] sku-pattern create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/flavors2/settings/channels/:id/sku-patterns/:patternId', requireAdmin, async (req, res) => {
    try {
      const cid = Number(req.params.id);
      const pid = Number(req.params.patternId);
      if (!Number.isFinite(cid) || !Number.isFinite(pid)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get(
        'SELECT * FROM flavor_channel_sku_patterns WHERE id=? AND channel_id=?',
        pid, cid
      );
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const merged = {
        listing_type: 'listing_type' in req.body ? req.body.listing_type : existing.listing_type,
        fulfillment:  'fulfillment'  in req.body ? req.body.fulfillment  : existing.fulfillment,
        template:     'template'     in req.body ? req.body.template     : existing.template,
      };
      const { errors, clean } = validateSkuPattern(merged);
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      // Uniqueness check: only if the user changed listing or fulfillment.
      if (clean.listing_type !== existing.listing_type || clean.fulfillment !== existing.fulfillment) {
        const dup = await get(
          'SELECT id FROM flavor_channel_sku_patterns WHERE channel_id=? AND listing_type=? AND fulfillment=? AND id != ?',
          cid, clean.listing_type, clean.fulfillment, pid
        );
        if (dup) return res.status(409).json({ error: 'Another pattern for that (listing, fulfillment) already exists.' });
      }
      await run(
        `UPDATE flavor_channel_sku_patterns SET
           listing_type=?, fulfillment=?, template=?,
           updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id=?`,
        clean.listing_type, clean.fulfillment, clean.template, pid
      );
      const row = await get('SELECT * FROM flavor_channel_sku_patterns WHERE id=?', pid);
      res.json(shapeSkuPattern(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/flavors2/settings/channels/:id/sku-patterns/:patternId', requireAdmin, async (req, res) => {
    try {
      const pid = Number(req.params.patternId);
      if (!Number.isFinite(pid)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM flavor_channel_sku_patterns WHERE id=?', pid);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  function validateSkuPattern(body) {
    const errors = [];
    const listing_type = String(body.listing_type || '').trim();
    if (!LISTING_TYPES.includes(listing_type)) errors.push('listing_type must be one of: ' + LISTING_TYPES.join(', '));
    const fulfillment = String(body.fulfillment || '').trim().toLowerCase().slice(0, 20);
    if (!/^[a-z0-9_-]*$/.test(fulfillment)) errors.push('fulfillment must be alphanumeric (or blank)');
    const template = String(body.template || '').trim();
    if (!template) errors.push('template is required');
    if (template.length > 200) errors.push('template too long');
    return { errors, clean: { listing_type, fulfillment, template } };
  }

  function shapeSkuPattern(row) {
    return {
      id: row.id,
      channel_id: row.channel_id,
      listing_type: row.listing_type,
      fulfillment: row.fulfillment || '',
      template: row.template,
      position: row.position,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ── Settings: product types CRUD ──────────────────────────────────────────
  // The user's curated 10-category taxonomy (Coffee, Cocktails, Fruit,
  // Lattes, Smoothie, Tea, Unique, Coffee & Cocktails, Coffee & Fruit,
  // Cocktails & Fruit). Each row owns the full per-type listing copy:
  // titles for single + packs in both REG and SF, all 5 BPs in REG and SF,
  // the pump suffix, BP6 (pump-only), and the shared description.
  // Build B will: (a) expand wizard step 5 to pick from these, and
  // (b) replace the listing-content generator's substitution path to use
  // this table instead of the older flavor_listing_examples records.
  app.get('/api/flavors2/settings/product-types', requireAuth, async (req, res) => {
    try {
      const rows = await all(
        'SELECT * FROM flavor_product_types ORDER BY position ASC, id ASC'
      );
      res.json(rows.map(shapeProductType));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/flavors2/settings/product-types/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM flavor_product_types WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const sets = []; const args = [];
      const setText = (col, max) => {
        if (col in req.body) {
          const v = String(req.body[col] || '').slice(0, max);
          sets.push(`${col}=?`); args.push(v);
        }
      };
      if ('name' in req.body) {
        const v = String(req.body.name || '').trim();
        if (!v) return res.status(400).json({ error: 'name cannot be blank' });
        sets.push('name=?'); args.push(v.slice(0, 120));
      }
      if ('enabled' in req.body)  { sets.push('enabled=?');  args.push(req.body.enabled ? 1 : 0); }
      if ('position' in req.body) { sets.push('position=?'); args.push(Number(req.body.position) || 0); }
      setText('title_reg_single', 500);
      setText('title_sf_single', 500);
      setText('title_reg_packs', 500);
      setText('title_sf_packs', 500);
      setText('pump_title_suffix', 100);
      setText('bullet_pump_extra', 2000);
      setText('description', 10000);
      // Bullets — accept array of strings or newline-joined string. Cap at 10.
      const normaliseBullets = (raw) => {
        let arr = raw;
        if (typeof arr === 'string') arr = arr.split('\n');
        if (!Array.isArray(arr)) arr = [];
        return arr.map(b => String(b || '').slice(0, 2000)).slice(0, 10);
      };
      if ('bullets_reg' in req.body) {
        sets.push('bullets_reg_json=?');
        args.push(JSON.stringify(normaliseBullets(req.body.bullets_reg)));
      }
      if ('bullets_sf' in req.body) {
        sets.push('bullets_sf_json=?');
        args.push(JSON.stringify(normaliseBullets(req.body.bullets_sf)));
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      args.push(id);
      await run(`UPDATE flavor_product_types SET ${sets.join(',')} WHERE id=?`, ...args);
      const row = await get('SELECT * FROM flavor_product_types WHERE id=?', id);
      res.json(shapeProductType(row));
    } catch (e) {
      console.error('[flavors2] product-type patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  function shapeProductType(row) {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      enabled: !!row.enabled,
      position: row.position,
      title_reg_single: row.title_reg_single || '',
      title_sf_single:  row.title_sf_single || '',
      title_reg_packs:  row.title_reg_packs || '',
      title_sf_packs:   row.title_sf_packs || '',
      pump_title_suffix: row.pump_title_suffix || 'With Pump',
      bullets_reg: safeJSON(row.bullets_reg_json, []),
      bullets_sf:  safeJSON(row.bullets_sf_json, []),
      bullet_pump_extra: row.bullet_pump_extra || '',
      description: row.description || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
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
           title_template, bullets_json, description_template, keywords, notes,
           is_raw_example, source_flavor_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        clean.name, clean.syrup_use, clean.flavor_type, clean.listing_type,
        clean.title_template, JSON.stringify(clean.bullets), clean.description_template,
        clean.keywords, clean.notes,
        clean.is_raw_example ? 1 : 0, clean.source_flavor_id,
        req.session.userId
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
        is_raw_example: 'is_raw_example' in req.body ? req.body.is_raw_example : !!existing.is_raw_example,
        source_flavor_id: 'source_flavor_id' in req.body ? req.body.source_flavor_id : existing.source_flavor_id,
      };
      const { errors, clean } = validateExample(merged);
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      await run(
        `UPDATE flavor_listing_examples SET
            name=?, syrup_use=?, flavor_type=?, listing_type=?,
            title_template=?, bullets_json=?, description_template=?,
            keywords=?, notes=?,
            is_raw_example=?, source_flavor_id=?,
            updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          WHERE id=?`,
        clean.name, clean.syrup_use, clean.flavor_type, clean.listing_type,
        clean.title_template, JSON.stringify(clean.bullets), clean.description_template,
        clean.keywords, clean.notes,
        clean.is_raw_example ? 1 : 0, clean.source_flavor_id,
        id
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

  // Duplicate an example. Copies every field, suffixes the name with
  // " (copy)" so the user can spot the new row in the list, and clears the
  // primary key so a fresh INSERT runs. Returns the new row so the client
  // can switch the editor straight to it.
  app.post('/api/flavors2/settings/examples/:id/duplicate', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const src = await get('SELECT * FROM flavor_listing_examples WHERE id=?', id);
      if (!src) return res.status(404).json({ error: 'Not found' });
      const newName = (src.name || 'Untitled') + ' (copy)';
      const ins = await run(
        `INSERT INTO flavor_listing_examples
           (name, syrup_use, flavor_type, listing_type,
            title_template, bullets_json, description_template, keywords, notes,
            is_raw_example, source_flavor_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        newName, src.syrup_use, src.flavor_type, src.listing_type,
        src.title_template, src.bullets_json, src.description_template,
        src.keywords, src.notes,
        src.is_raw_example ? 1 : 0, src.source_flavor_id,
        req.session.userId
      );
      const row = await get('SELECT * FROM flavor_listing_examples WHERE id=?', ins.lastInsertRowid);
      res.status(201).json(shapeExample(row));
    } catch (e) {
      console.error('[flavors2] example duplicate failed:', e.message);
      res.status(500).json({ error: e.message });
    }
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

    // Raw-paste mode requires a source flavor so the swap engine knows
    // what tokens (name / syrup color / type label) to replace at
    // generate time. Template mode ignores both fields.
    const is_raw_example = !!body.is_raw_example;
    let source_flavor_id = null;
    if (is_raw_example) {
      const sfid = Number(body.source_flavor_id);
      if (Number.isFinite(sfid) && sfid > 0) source_flavor_id = sfid;
      else errors.push('source_flavor_id is required for raw-paste examples');
    }

    return {
      errors,
      clean: {
        name, syrup_use, flavor_type, listing_type,
        title_template:       String(body.title_template       || '').trim().slice(0, 500),
        description_template: String(body.description_template || '').trim().slice(0, 5000),
        keywords:             String(body.keywords             || '').trim().slice(0, 2000),
        notes:                String(body.notes                || '').trim().slice(0, 1000),
        bullets,
        is_raw_example,
        source_flavor_id,
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
      is_raw_example: !!row.is_raw_example,
      source_flavor_id: row.source_flavor_id || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function safeJSON(s, fallback) {
    try { const v = JSON.parse(s); return v == null ? fallback : v; }
    catch { return fallback; }
  }

  // ── Listing content generation ────────────────────────────────────────────
  // Substitution: replace {placeholder} tokens in a template with values
  // derived from the flavor. Unknown placeholders are left intact so the
  // user sees them and can adjust the template later — silently dropping
  // unknowns would mask typos.
  function substitute(template, f) {
    return String(template || '').replace(/\{(\w+)\}/g, (match, key) => {
      switch (key) {
        case 'name':         return f.name || '';
        case 'type':         return f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular';
        case 'type_lower':   return f.type === 'sugar_free' ? 'sugar-free' : 'regular';
        case 'color':        return f.color === 'none' ? '' : (f.color || '');
        case 'syrup_color':  return f.syrup_color || '';
        case 'use':          return f.use_of_syrup || '';
        case 'flavor_type':  return f.flavor_type === 'natural_and_artificial' ? 'Natural + Artificial' : 'Natural';
        // Trailing space so a title like "{is_natural}{name} Syrup" renders
        // "Natural Vanilla Syrup" for naturals and "Vanilla Syrup" for N+A
        // without leaving a double-space when blank.
        case 'is_natural':   return f.flavor_type === 'natural' ? 'Natural ' : '';
        case 'ingredients':  return f.ingredients || '';
        case 'sodium_mg':    return String(f.sodium_mg || 0);
        case 'salt_pct':     return String(f.salt_pct || 0);
        default:             return match;
      }
    });
  }

  // Swap-based substitution for raw-paste examples. Takes the example
  // text (which has the SOURCE flavor's data baked in) and rewrites it
  // for the target flavor by replacing distinctive tokens — name,
  // syrup_color, type label, full color word — with the target's values.
  //
  // Conservatively skips ambiguous swaps:
  //   • color word ("natural" / "caramel") is NOT swapped automatically
  //     because "natural" appears in "natural flavors" in the ingredient
  //     list, and swapping it would corrupt the copy.
  //   • use_of_syrup ("coffee" / "fruity") is NOT swapped — too common
  //     as a regular English word.
  // The user can edit the generated ticket description if the leftover
  // wording doesn't suit a particular new flavor.
  function buildSwapPairs(source, target) {
    const pairs = [];
    const push = (from, to) => {
      if (from && to && from !== to) pairs.push({ from, to });
    };
    push(source.name, target.name);
    if (source.syrup_color && target.syrup_color) {
      push(source.syrup_color, target.syrup_color);
    }
    const sLabel = source.type === 'sugar_free' ? 'Sugar-Free' : 'Regular';
    const tLabel = target.type === 'sugar_free' ? 'Sugar-Free' : 'Regular';
    push(sLabel, tLabel);
    push(sLabel.toLowerCase(), tLabel.toLowerCase());
    // Longer strings first so "Sugar-Free" isn't half-matched as "Sugar".
    pairs.sort((a, b) => b.from.length - a.from.length);
    return pairs;
  }

  function swapSubstitute(text, source, target) {
    if (!text || !source || !target) return String(text || '');
    let result = String(text);
    for (const { from, to } of buildSwapPairs(source, target)) {
      // Word-boundary, case-insensitive. Preserve the leading-cap case of
      // the original match so "Vanilla" → "Caramel" and "vanilla" → "caramel".
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + esc + '\\b', 'gi');
      result = result.replace(re, (match) => {
        if (match[0] === match[0].toUpperCase()) {
          return to.charAt(0).toUpperCase() + to.slice(1);
        }
        return to;
      });
    }
    return result;
  }

  // Pick the best example for a listing type. Strictly requires the
  // listing_type to match (no fallback across pack sizes), but accepts a
  // looser match on syrup_use / flavor_type so a worker can ship templates
  // incrementally without all 12 combinations covered.
  function pickExample(examples, f, listing_type) {
    const pool = examples.filter(e => e.listing_type === listing_type);
    if (!pool.length) return null;
    const exact = pool.find(e => e.syrup_use === f.use_of_syrup && e.flavor_type === f.flavor_type);
    if (exact) return exact;
    const useAny = pool.find(e => e.syrup_use === f.use_of_syrup && e.flavor_type === 'any');
    if (useAny) return useAny;
    const flavAny = pool.find(e => e.syrup_use === 'other' && e.flavor_type === f.flavor_type);
    if (flavAny) return flavAny;
    const both = pool.find(e => e.syrup_use === 'other' && e.flavor_type === 'any');
    if (both) return both;
    return pool[0];
  }

  function renderListingBlock(ex, f, listing_type, listingLabels, sourceFlavorsById) {
    const heading = listingLabels[listing_type] || listing_type;
    if (!ex) {
      return (
        `────────────────────────────────────────────\n` +
        `${heading.toUpperCase()}\n` +
        `────────────────────────────────────────────\n` +
        `(No template found for this listing type. Add one in ` +
        `Flavors → Settings → Listing Examples to auto-fill next time.)\n`
      );
    }
    // Two substitution modes: placeholder ({name}, {type}, ...) for
    // template-mode examples, or token-swap (source flavor's name →
    // target flavor's name, etc.) for raw-paste examples.
    let render;
    let modeLabel;
    if (ex.is_raw_example && ex.source_flavor_id && sourceFlavorsById.get(ex.source_flavor_id)) {
      const src = sourceFlavorsById.get(ex.source_flavor_id);
      render = (text) => swapSubstitute(text, src, f);
      modeLabel = `Raw paste from "${src.name}"`;
    } else {
      render = (text) => substitute(text, f);
      modeLabel = 'Template';
    }
    const title       = render(ex.title_template);
    const bullets     = (ex.bullets || []).map(render);
    const description = render(ex.description_template);
    const keywords    = render(ex.keywords);
    return (
      `────────────────────────────────────────────\n` +
      `${heading.toUpperCase()}  •  ${modeLabel}: ${ex.name}\n` +
      `────────────────────────────────────────────\n` +
      `Title:\n  ${title || '(empty)'}\n\n` +
      `Bullets:\n${bullets.length ? bullets.map(b => '  • ' + b).join('\n') : '  (none in template)'}\n\n` +
      `Description:\n${description || '  (empty)'}\n\n` +
      `Keywords:\n${keywords || '  (none)'}\n`
    );
  }

  function buildListingDescription(channel, f, examples, listingLabels, sourceFlavorsById) {
    const intro =
      `Generated listing content for ${channel.name} — ${f.name}\n\n` +
      `Review each variant below and copy it into ${channel.name}'s listing form when ready. ` +
      `Edit any text directly on this ticket — saves are independent per channel.\n` +
      (channel.has_fba ? `\nNote: ${channel.name} has FBA + FBM. Same listing content applies to both fulfilment SKUs.\n` : '') +
      `\nFlavor: ${f.name} (${f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular'})\n` +
      `Color: ${f.color === 'none' ? 'None' : f.color}${f.syrup_color ? ' (' + f.syrup_color + ')' : ''}\n` +
      `UPC: ${f.upc}   SKU: ${f.sku}\n\n`;
    const blocks = LISTING_TYPES.map(lt =>
      renderListingBlock(pickExample(examples, f, lt), f, lt, listingLabels, sourceFlavorsById)
    ).join('\n');
    const footer =
      `\n────────────────────────────────────────────\n` +
      `INGREDIENTS (same for every variant)\n` +
      `────────────────────────────────────────────\n` +
      `${f.ingredients}\n\n` +
      `Sodium: ${f.sodium_mg} mg / serving\n` +
      `\n(Nutrition facts image will be generated in the Images ticket.)\n`;
    return intro + blocks + footer;
  }

  // ── Per-flavor listing content (Build B) ──────────────────────────────────
  // Replaces the legacy flavor_listing_examples flow. Each flavor has 4
  // variants of listing content (single, single+pump, 4-pack, 6-pack) that
  // are auto-generated from its picked product type, then editable, then
  // approved before channel tickets spawn.

  const LISTING_VARIANTS = ['single', 'single_with_pump', '4_pack', '6_pack'];

  // Substitute flavor data into a product-type template string. Preserves
  // the user's xlsx notation: `---` (3+ dashes) → flavor name, `...-Pack`
  // → pack size label, `(Naturally Flavored)` / `(Natural Flavors)` →
  // stripped when the flavor is natural+artificial.
  function substituteProductTypeText(text, f, packSize) {
    let result = String(text || '');
    // Flavor name — match 3 or more dashes. Done first so subsequent
    // replacements don't interfere with surrounding context.
    result = result.replace(/-{3,}/g, f.name || '');
    // Pack size: literal "...-Pack" → "4-Pack" / "6-Pack" etc. Only fires
    // for the packs variants; callers pass empty string otherwise so the
    // marker stays for the user to edit if they want.
    if (packSize) {
      result = result.replace(/\.{3}-Pack/g, packSize);
    }
    // Natural-only parenthetical callouts. In the templates these are
    // wrapped in parens to mark them as "natural-only — drop me for N+A
    // flavors". For natural flavors we keep the inner text but drop the
    // parens; for N+A we drop the whole thing. List is explicit so we
    // don't accidentally touch unrelated parentheticals (sizes, asides,
    // etc.) elsewhere in the copy.
    const NATURAL_CALLOUTS = [
      /\((Naturally Flavored,?)\)/gi,
      /\((Naturally)\)/gi,
      /\((Natural Flavors,?)\)/gi,
      /\((and no artificial coloring)\)/gi,
    ];
    const keepInner = f.flavor_type === 'natural';
    for (const re of NATURAL_CALLOUTS) {
      result = result.replace(re, (_match, inner) => keepInner ? inner : '');
    }
    // Collapse runs of spaces / tabs left behind by N+A strips, but keep
    // newlines so multi-paragraph descriptions don't fold into one line.
    result = result.replace(/[ \t]{2,}/g, ' ');
    return result;
  }

  // Build the 4 listing variants for a flavor by substituting its data
  // into the picked product type. Returns null when no product type is
  // selected or the picked key doesn't exist in flavor_product_types yet
  // (deleted by admin, etc.) — caller surfaces a clear error to the UI.
  async function buildListingContentFromProductType(f) {
    if (!f.use_of_syrup) return null;
    const pt = await get(
      'SELECT * FROM flavor_product_types WHERE key=? AND enabled=1',
      f.use_of_syrup
    );
    if (!pt) return null;

    const isSF = f.type === 'sugar_free';
    const titleSingle = isSF ? pt.title_sf_single : pt.title_reg_single;
    const titlePacks  = isSF ? pt.title_sf_packs  : pt.title_reg_packs;
    const bullets     = safeJSON(isSF ? pt.bullets_sf_json : pt.bullets_reg_json, []);
    const pumpSuffix  = pt.pump_title_suffix || 'With Pump';
    const pumpExtra   = pt.bullet_pump_extra || '';
    const description = pt.description || '';

    const sub = (s, pack) => substituteProductTypeText(s, f, pack);

    return [
      {
        listing_variant: 'single',
        title: sub(titleSingle, ''),
        bullets: bullets.map(b => sub(b, '')),
        description: sub(description, ''),
      },
      {
        listing_variant: 'single_with_pump',
        title: (sub(titleSingle, '') + ' ' + pumpSuffix).trim().replace(/\s+/g, ' '),
        bullets: [...bullets.map(b => sub(b, '')), sub(pumpExtra, '')].filter(Boolean),
        description: sub(description, ''),
      },
      {
        listing_variant: '4_pack',
        title: sub(titlePacks, '4-Pack'),
        bullets: bullets.map(b => sub(b, '4-Pack')),
        description: sub(description, '4-Pack'),
      },
      {
        listing_variant: '6_pack',
        title: sub(titlePacks, '6-Pack'),
        bullets: bullets.map(b => sub(b, '6-Pack')),
        description: sub(description, '6-Pack'),
      },
    ];
  }

  function shapeListingContent(row) {
    return {
      id: row.id,
      flavor_id: row.flavor_id,
      listing_variant: row.listing_variant,
      title: row.title || '',
      bullets: safeJSON(row.bullets_json, []),
      description: row.description || '',
      approved: !!row.approved,
      generated_at: row.generated_at,
      updated_at: row.updated_at,
    };
  }

  // GET /api/flavors2/:id/listing-content
  //   Returns the 4 variants for this flavor. If they don't yet exist,
  //   generates them from the picked product type and persists. If the
  //   flavor has no product type set, returns { needs_setup: true }.
  app.get('/api/flavors2/:id/listing-content', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });

      let rows = await all(
        `SELECT * FROM flavor_listing_content
          WHERE flavor_id=? ORDER BY listing_variant ASC`,
        id
      );
      // First visit — generate ONLY the single variant from the product
      // type's template. The other 3 variants are created in a second pass
      // (POST .../listing-content/propagate) after the user has edited and
      // approved the single. This keeps the user focused on the one bullet
      // they need to write (the flavor-specific sensory description) and
      // avoids generating throwaway content for the other variants.
      if (rows.length === 0) {
        const generated = await buildListingContentFromProductType(f);
        if (!generated) {
          return res.json({
            needs_setup: true,
            product_type_key: f.use_of_syrup || null,
            variants: [],
          });
        }
        const singleVariant = generated.find(g => g.listing_variant === 'single');
        if (singleVariant) {
          await run(
            `INSERT INTO flavor_listing_content
              (flavor_id, listing_variant, title, bullets_json, description, approved)
             VALUES (?,?,?,?,?,0)
             ON CONFLICT (flavor_id, listing_variant) DO NOTHING`,
            id, singleVariant.listing_variant, singleVariant.title,
            JSON.stringify(singleVariant.bullets), singleVariant.description
          );
        }
        rows = await all(
          `SELECT * FROM flavor_listing_content
            WHERE flavor_id=? ORDER BY listing_variant ASC`,
          id
        );
      }
      res.json({
        needs_setup: false,
        product_type_key: f.use_of_syrup || null,
        variants: rows.map(shapeListingContent),
      });
    } catch (e) {
      console.error('[flavors2] listing-content get failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/flavors2/:id/listing-content/:variant
  //   Updates one variant's title / bullets / description. Editing an
  //   approved variant flips approved back to 0 — the user explicitly
  //   re-approves after edits via POST .../approve-all.
  app.patch('/api/flavors2/:id/listing-content/:variant', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const variant = String(req.params.variant || '');
      if (!Number.isFinite(id) || !LISTING_VARIANTS.includes(variant)) {
        return res.status(400).json({ error: 'Bad id or variant' });
      }
      const sets = []; const args = [];
      if ('title' in req.body) {
        sets.push('title=?'); args.push(String(req.body.title || '').slice(0, 1000));
      }
      if ('bullets' in req.body) {
        let arr = req.body.bullets;
        if (typeof arr === 'string') arr = arr.split('\n');
        if (!Array.isArray(arr)) arr = [];
        arr = arr.map(b => String(b || '').slice(0, 3000)).slice(0, 10);
        sets.push('bullets_json=?'); args.push(JSON.stringify(arr));
      }
      if ('description' in req.body) {
        sets.push('description=?'); args.push(String(req.body.description || '').slice(0, 10000));
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      // Edits drop approval — caller re-approves via approve-all.
      sets.push('approved=0');
      sets.push(`updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
      args.push(id, variant);
      await run(
        `UPDATE flavor_listing_content SET ${sets.join(',')}
          WHERE flavor_id=? AND listing_variant=?`,
        ...args
      );
      const row = await get(
        'SELECT * FROM flavor_listing_content WHERE flavor_id=? AND listing_variant=?',
        id, variant
      );
      if (!row) return res.status(404).json({ error: 'Variant not found' });
      res.json(shapeListingContent(row));
    } catch (e) {
      console.error('[flavors2] listing-content patch failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/flavors2/:id/listing-content/propagate
  //   Carries the (edited + approved) single variant's bullets + description
  //   forward to the other 3 variants — only the titles differ. This lets
  //   the user write BP1's flavor-specific sensory description ONCE for the
  //   single bottle, then the system auto-fills single+pump (adds the pump
  //   suffix to the title + appends BP6) and 4-pack / 6-pack (swaps in the
  //   packs title template) without needing an AI rewrite per variant.
  //
  //   Marks the single variant approved as part of the flow. If the other
  //   3 already exist, they're overwritten — the contract is "single is the
  //   master copy; propagation refreshes everything else."
  app.post('/api/flavors2/:id/listing-content/propagate', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      const pt = await get(
        'SELECT * FROM flavor_product_types WHERE key=? AND enabled=1',
        f.use_of_syrup
      );
      if (!pt) {
        return res.status(409).json({ error: 'Product type for this flavor is missing. Restore it in Settings → Product types.' });
      }
      const single = await get(
        'SELECT * FROM flavor_listing_content WHERE flavor_id=? AND listing_variant=?',
        id, 'single'
      );
      if (!single) {
        return res.status(409).json({ error: 'Generate the single variant first.' });
      }

      const singleBullets = safeJSON(single.bullets_json, []);
      const singleDesc = single.description || '';
      const isSF = f.type === 'sugar_free';
      const titlePacks = isSF ? pt.title_sf_packs : pt.title_reg_packs;
      const pumpSuffix = pt.pump_title_suffix || 'With Pump';
      const pumpExtra = substituteProductTypeText(pt.bullet_pump_extra || '', f, '');

      // Approve the single (this is the explicit "I'm happy with single,
      // generate the rest" moment).
      await run(
        `UPDATE flavor_listing_content
            SET approved=1,
                updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          WHERE flavor_id=? AND listing_variant='single'`,
        id
      );

      const others = [
        {
          listing_variant: 'single_with_pump',
          title: ((single.title || '') + ' ' + pumpSuffix).trim().replace(/\s+/g, ' '),
          bullets: pumpExtra ? [...singleBullets, pumpExtra] : singleBullets,
          description: singleDesc,
        },
        {
          listing_variant: '4_pack',
          title: substituteProductTypeText(titlePacks, f, '4-Pack'),
          bullets: singleBullets,
          description: singleDesc,
        },
        {
          listing_variant: '6_pack',
          title: substituteProductTypeText(titlePacks, f, '6-Pack'),
          bullets: singleBullets,
          description: singleDesc,
        },
      ];
      for (const v of others) {
        await run(
          `INSERT INTO flavor_listing_content
             (flavor_id, listing_variant, title, bullets_json, description, approved)
           VALUES (?,?,?,?,?,0)
           ON CONFLICT (flavor_id, listing_variant) DO UPDATE SET
             title = EXCLUDED.title,
             bullets_json = EXCLUDED.bullets_json,
             description = EXCLUDED.description,
             approved = 0,
             updated_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
          id, v.listing_variant, v.title, JSON.stringify(v.bullets), v.description
        );
      }

      const rows = await all(
        'SELECT * FROM flavor_listing_content WHERE flavor_id=? ORDER BY listing_variant ASC',
        id
      );
      res.json({ variants: rows.map(shapeListingContent) });
    } catch (e) {
      console.error('[flavors2] listing-content propagate failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/flavors2/:id/listing-content/regenerate
  //   Discards all 4 variants and re-generates from the picked product
  //   type. Used when the admin edited a product type and wants to pick
  //   up the new template (or after switching product type on the flavor).
  app.post('/api/flavors2/:id/listing-content/regenerate', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      const generated = await buildListingContentFromProductType(f);
      if (!generated) {
        return res.status(409).json({ error: 'Pick a product type on the flavor first.' });
      }
      await run('DELETE FROM flavor_listing_content WHERE flavor_id=?', id);
      for (const v of generated) {
        await run(
          `INSERT INTO flavor_listing_content
            (flavor_id, listing_variant, title, bullets_json, description, approved)
           VALUES (?,?,?,?,?,0)`,
          id, v.listing_variant, v.title, JSON.stringify(v.bullets), v.description
        );
      }
      const rows = await all(
        'SELECT * FROM flavor_listing_content WHERE flavor_id=? ORDER BY listing_variant ASC',
        id
      );
      res.json({ variants: rows.map(shapeListingContent) });
    } catch (e) {
      console.error('[flavors2] listing-content regenerate failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/flavors2/:id/listing-content/approve-and-spawn
  //   Marks all 4 variants approved and spawns one per-channel listing
  //   ticket bundling the approved content. Replaces the older
  //   generate-listings endpoint flow.
  app.post('/api/flavors2/:id/listing-content/approve-and-spawn', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (!f.upc || !f.sku) {
        return res.status(409).json({ error: 'Set UPC and SKU first.' });
      }
      const variants = await all(
        'SELECT * FROM flavor_listing_content WHERE flavor_id=? ORDER BY listing_variant ASC',
        id
      );
      if (variants.length !== 4) {
        return res.status(409).json({ error: 'Generate the listing-content preview first.' });
      }
      const alreadyTickets = await get(
        `SELECT COUNT(*) AS n FROM tickets
          WHERE flavor_v2_id=? AND flavor_v2_step='listing_content' AND deleted_at IS NULL`,
        id
      );
      if (Number(alreadyTickets?.n || 0) > 0) {
        return res.status(409).json({ error: 'Listing-content tickets already exist. Delete them to regenerate.' });
      }
      const channels = await all(
        'SELECT * FROM flavor_channels WHERE enabled=1 ORDER BY position ASC, id ASC'
      );
      if (!channels.length) {
        return res.status(409).json({ error: 'No enabled channels. Add one in Settings → Channels first.' });
      }

      await run(
        'UPDATE flavor_listing_content SET approved=1 WHERE flavor_id=?',
        id
      );

      const shaped = variants.map(shapeListingContent);
      const labels = {
        single: 'Single (no pump)',
        single_with_pump: 'Single with pump',
        '4_pack': '4-pack',
        '6_pack': '6-pack',
      };
      const created = [];
      for (const channel of channels) {
        const desc = buildChannelListingDescFromApproved(channel, f, shaped, labels);
        const checklist = LISTING_VARIANTS.map(v => `${labels[v]} — content reviewed & published on ${channel.name}`);
        const t = await insertPipelineTicket(f, {
          step: 'listing_content',
          title: `Listing content — ${f.name} on ${channel.name}`,
          priority: 'Medium',
          dept: 'Operations',
          description: desc,
          checklist,
        }, req.session.userId);
        created.push({ id: t.id, channel: channel.name });
      }
      res.status(201).json({ ok: true, tickets: created });
    } catch (e) {
      console.error('[flavors2] approve-and-spawn failed:', e.message);
      res.status(500).json({ error: 'Could not spawn tickets — please retry.' });
    }
  });

  function buildChannelListingDescFromApproved(channel, f, variants, labels) {
    const lines = [
      `APPROVED listing content for ${channel.name} — ${f.name}`,
      '',
      `Flavor: ${f.name} (${f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular'})`,
      `UPC: ${f.upc}    SKU: ${f.sku}`,
      channel.has_fba ? `Note: ${channel.name} has FBA + FBM — same content for both.` : '',
      '',
    ].filter(Boolean);
    for (const v of variants) {
      lines.push('────────────────────────────────────────────');
      lines.push(`${(labels[v.listing_variant] || v.listing_variant).toUpperCase()}`);
      lines.push('────────────────────────────────────────────');
      lines.push('Title:');
      lines.push('  ' + (v.title || '(empty)'));
      lines.push('');
      lines.push('Bullets:');
      if (v.bullets.length) lines.push(...v.bullets.map(b => '  • ' + b));
      else                  lines.push('  (none)');
      lines.push('');
      lines.push('Description:');
      lines.push(v.description || '(empty)');
      lines.push('');
    }
    lines.push('Tick each variant off below as it goes live on ' + channel.name + '.');
    return lines.join('\n');
  }

  // POST /api/flavors2/:id/generate-listings
  // Spawns one "listing content" ticket per enabled channel. Each ticket's
  // description contains all 4 listing variants (single, single+pump, 4-pack,
  // 6-pack) with placeholder substitution against the flavor's data, plus a
  // checklist so the worker can tick off each variant as it's published.
  app.post('/api/flavors2/:id/generate-listings', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (!f.upc || !f.sku) {
        return res.status(409).json({ error: 'Set UPC and SKU first — they need to land on the listing copy.' });
      }
      // Idempotent: refuse if any listing_content ticket already exists for
      // this flavor. The user can delete those first to regenerate.
      const already = await get(
        `SELECT COUNT(*) AS n FROM tickets
          WHERE flavor_v2_id=? AND flavor_v2_step='listing_content' AND deleted_at IS NULL`,
        id
      );
      if (Number(already?.n || 0) > 0) {
        return res.status(409).json({ error: 'Listing-content tickets already exist for this flavor. Delete them to regenerate.' });
      }

      const channels = await all(
        'SELECT * FROM flavor_channels WHERE enabled=1 ORDER BY position ASC, id ASC'
      );
      if (!channels.length) {
        return res.status(409).json({ error: 'No enabled channels. Add one in Flavors → Settings → Channels first.' });
      }
      const examplesRaw = await all('SELECT * FROM flavor_listing_examples');
      const examples = examplesRaw.map(e => ({
        ...e,
        is_raw_example: !!e.is_raw_example,
        source_flavor_id: e.source_flavor_id || null,
        bullets: (() => { try { return JSON.parse(e.bullets_json || '[]'); } catch { return []; } })(),
      }));

      // Preload source flavors referenced by any raw-paste example so we
      // can build the swap-pair table without an N+1 lookup per block.
      const srcIds = Array.from(new Set(
        examples.filter(e => e.is_raw_example && e.source_flavor_id).map(e => e.source_flavor_id)
      ));
      const sourceFlavorsById = new Map();
      for (const sid of srcIds) {
        const srcRow = await get('SELECT * FROM flavors_v2 WHERE id=?', sid);
        if (srcRow) sourceFlavorsById.set(sid, srcRow);
      }

      const listingLabels = {
        single: 'Single (no pump)',
        single_with_pump: 'Single with pump',
        '4_pack': '4-pack',
        '6_pack': '6-pack',
      };

      const created = [];
      for (const channel of channels) {
        const desc = buildListingDescription(channel, f, examples, listingLabels, sourceFlavorsById);
        const checklist = LISTING_TYPES.map(lt =>
          `${listingLabels[lt]} — content reviewed & published on ${channel.name}`
        );
        const t = await insertPipelineTicket(f, {
          step: 'listing_content',
          title: `Listing content — ${f.name} on ${channel.name}`,
          priority: 'Medium',
          dept: 'Operations',
          description: desc,
          checklist,
        }, req.session.userId);
        created.push({ id: t.id, channel: channel.name });
      }

      res.status(201).json({ ok: true, tickets: created });
    } catch (e) {
      console.error('[flavors2] generate-listings failed:', e.message);
      res.status(500).json({ error: 'Could not generate listings — please retry.' });
    }
  });

  // ── Image ticket generation ───────────────────────────────────────────────
  // Spawns the main product-image ticket (one per flavor, with a subtask
  // per image slot × enabled channel) and, when Amazon is enabled, the EBC
  // module ticket. Designers attach the final file to each subtask via the
  // existing /api/upload endpoint with a subtask_id. Idempotent: refuses
  // to re-spawn either ticket while a live one exists.
  //
  // Image counts per channel:
  //   • Main image: 1
  //   • Additional: 7 (regular) / 8 (sugar-free) — SF gets an extra slot
  //     for a typical sucralose / no-sugar callout image.
  app.post('/api/flavors2/:id/generate-images', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (!f.upc || !f.sku) {
        return res.status(409).json({ error: 'Set UPC and SKU first — image briefs reference them.' });
      }
      const already = await get(
        `SELECT COUNT(*) AS n FROM tickets
          WHERE flavor_v2_id=? AND flavor_v2_step IN ('image_creation','ebc') AND deleted_at IS NULL`,
        id
      );
      if (Number(already?.n || 0) > 0) {
        return res.status(409).json({ error: 'Image tickets already exist for this flavor. Delete them to regenerate.' });
      }

      const channels = await all(
        'SELECT * FROM flavor_channels WHERE enabled=1 ORDER BY position ASC, id ASC'
      );
      if (!channels.length) {
        return res.status(409).json({ error: 'No enabled channels. Add one in Flavors → Settings → Channels first.' });
      }

      const isSF = f.type === 'sugar_free';
      const additionalCount = isSF ? 8 : 7;
      const created = [];

      // Main product-image ticket — one row, big subtask list.
      const imgDesc = buildImageTicketDescription(f, channels, additionalCount, isSF);
      const imgChecklist = [];
      for (const c of channels) {
        imgChecklist.push(`${c.name} — Main image`);
        for (let i = 1; i <= additionalCount; i++) {
          imgChecklist.push(`${c.name} — Additional image ${i}`);
        }
      }
      const imgTicket = await insertPipelineTicket(f, {
        step: 'image_creation',
        title: `Create product images for ${f.name}`,
        priority: 'High',
        dept: 'Design',
        description: imgDesc,
        checklist: imgChecklist,
      }, req.session.userId);
      created.push({ id: imgTicket.id, kind: 'image_creation' });

      // EBC ticket — Amazon-specific. Only spawn if Amazon is enabled.
      const amazon = channels.find(c => c.code === 'amazon');
      if (amazon) {
        const ebcDesc = buildEbcTicketDescription(f);
        const ebcChecklist = [
          'EBC Module 1 — Hero / brand banner',
          'EBC Module 2 — Product features',
          'EBC Module 3 — Lifestyle / usage',
          'EBC Module 4 — Comparison / variants',
          'EBC Module 5 — Trust / certifications',
        ];
        const ebcTicket = await insertPipelineTicket(f, {
          step: 'ebc',
          title: `Create Amazon EBC content for ${f.name}`,
          priority: 'Medium',
          dept: 'Design',
          description: ebcDesc,
          checklist: ebcChecklist,
        }, req.session.userId);
        created.push({ id: ebcTicket.id, kind: 'ebc' });
      }

      res.status(201).json({ ok: true, tickets: created });
    } catch (e) {
      console.error('[flavors2] generate-images failed:', e.message);
      res.status(500).json({ error: 'Could not generate image tickets — please retry.' });
    }
  });

  function buildImageTicketDescription(f, channels, additionalCount, isSF) {
    const typeLabel = isSF ? 'Sugar-Free' : 'Regular';
    const colorLine = f.color === 'none'
      ? 'None'
      : `${f.color}${f.syrup_color ? ' (' + f.syrup_color + ')' : ''}`;
    const channelList = channels.map(c =>
      `  • ${c.name}${c.has_fba ? ' (FBA + FBM share these images)' : ''}`
    ).join('\n');
    return (
      `Create all product images for this flavor. Attach the final file to ` +
      `each subtask below as it's ready — the subtask check turns green ` +
      `once a file is on it.\n\n` +
      `Flavor: ${f.name} (${typeLabel})\n` +
      `Color: ${colorLine}\n` +
      `Use: ${f.use_of_syrup}\n` +
      `UPC: ${f.upc}\n` +
      `SKU: ${f.sku}\n\n` +
      `Ingredients:\n${f.ingredients}\n\n` +
      `Sodium: ${f.sodium_mg} mg / serving\n\n` +
      `Channels covered:\n${channelList}\n\n` +
      `Image requirements (per channel):\n` +
      `  • Main image: white background, product centered, ≥2000×2000 px\n` +
      `  • ${additionalCount} additional images: lifestyle / detail / ` +
      `nutrition / ingredients / usage shots\n` +
      (isSF
        ? `  • Sugar-Free flavors get one extra slot — typically a ` +
          `sucralose / no-sugar / zero-calorie callout image.\n`
        : ''
      ) +
      `\nTotal slots: ${channels.length} channel(s) × ${1 + additionalCount} ` +
      `image(s) = ${channels.length * (1 + additionalCount)} subtasks below.`
    );
  }

  function buildEbcTicketDescription(f) {
    const typeLabel = f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular';
    return (
      `Design Amazon Enhanced Brand Content (A+) modules for this flavor. ` +
      `Each module image goes on its own subtask below — attach when ready. ` +
      `Add more subtasks via the Subtasks tab if your design needs more than 5.\n\n` +
      `Flavor: ${f.name} (${typeLabel})\n` +
      `Color: ${f.color === 'none' ? 'None' : f.color}\n` +
      `UPC: ${f.upc}\n` +
      `SKU: ${f.sku}\n\n` +
      `Amazon EBC spec:\n` +
      `  • Module images: 970×600 px (full-width) or smaller for partial-width modules\n` +
      `  • RGB color profile, JPG / PNG, ≤2 MB each\n` +
      `  • Text on image kept minimal (Amazon's policy)\n` +
      `  • Standard modules: hero banner, features, lifestyle, comparison, trust signals\n`
    );
  }

  // ── Channel SKU generation + per-channel listing tickets ─────────────────
  // SKU assembly now lives in flavor_channel_sku_patterns — per-channel ×
  // per-listing-type × per-fulfillment templates, each containing literal
  // text + a single `(SKU)` placeholder. See substitutePatternTemplate
  // above and the seeds in db.js for the user's real convention.
  const LISTING_LABEL_LOCAL = {
    single: 'Single (no pump)',
    single_with_pump: 'Single with pump',
    '4_pack': '4-pack',
    '6_pack': '6-pack',
  };

  // Substitute the base SKU into a per-(channel × listing_type × fulfillment)
  // template. The only placeholder is `(SKU)` — matches the user's existing
  // convention from their pattern sheet. Anything else stays literal so the
  // generator emits exactly what the template says.
  function substitutePatternTemplate(template, baseSku) {
    return String(template || '').replace(/\(SKU\)/g, baseSku || '');
  }

  // GET /api/flavors2/:id/channel-skus — flat list grouped by channel for
  // the detail page to render. Empty array if generator hasn't fired yet.
  app.get('/api/flavors2/:id/channel-skus', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const rows = await all(
        `SELECT s.*, c.name AS channel_name, c.code AS channel_code, c.has_fba
           FROM flavor_channel_skus s
           JOIN flavor_channels c ON c.id = s.channel_id
          WHERE s.flavor_id=?
          ORDER BY c.position ASC, c.id ASC, s.listing_type ASC, s.fulfillment ASC`,
        id
      );
      res.json(rows.map(r => ({
        id: r.id,
        channel_id: r.channel_id,
        channel_name: r.channel_name,
        channel_code: r.channel_code,
        listing_type: r.listing_type,
        fulfillment: r.fulfillment || '',
        channel_sku: r.channel_sku,
        nineyard_sku: r.nineyard_sku || '',
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/flavors2/:id/generate-channel-skus
  //   1. Inserts every (channel × listing_type × fulfillment) row into
  //      flavor_channel_skus using each channel's sku_pattern.
  //   2. Spawns one "listing launch" ticket per channel bundling all the
  //      SKUs + back-references to the listing-content and image tickets.
  //   3. Spawns one SKU mapping ticket covering every generated channel
  //      SKU so the worker can map them back to NineYard in one place.
  // Idempotent — refuses to run while either kind of ticket already exists.
  app.post('/api/flavors2/:id/generate-channel-skus', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      if (!f.upc || !f.sku) {
        return res.status(409).json({ error: 'Set UPC and SKU first — channel SKUs build on the base SKU.' });
      }
      const already = await get(
        `SELECT COUNT(*) AS n FROM tickets
          WHERE flavor_v2_id=? AND flavor_v2_step IN ('channel_launch','sku_mapping') AND deleted_at IS NULL`,
        id
      );
      if (Number(already?.n || 0) > 0) {
        return res.status(409).json({ error: 'Channel-launch tickets already exist for this flavor. Delete them to regenerate.' });
      }
      const channels = await all(
        'SELECT * FROM flavor_channels WHERE enabled=1 ORDER BY position ASC, id ASC'
      );
      if (!channels.length) {
        return res.status(409).json({ error: 'No enabled channels. Add one in Flavors → Settings → Channels first.' });
      }

      // Cross-references: link back to the existing listing-content + image
      // tickets per-channel where available, so the launch ticket points
      // directly to the content/images the worker will copy from.
      const allFlavorTickets = await all(
        `SELECT id, title, flavor_v2_step FROM tickets
          WHERE flavor_v2_id=? AND deleted_at IS NULL`,
        id
      );
      const imageTicket = allFlavorTickets.find(t => t.flavor_v2_step === 'image_creation');
      const ebcTicket   = allFlavorTickets.find(t => t.flavor_v2_step === 'ebc');

      // Existing rows: should be empty (we just checked above for tickets,
      // but a partial prior run might have orphaned SKU rows). Wipe and
      // regenerate to keep the data in sync with the new tickets.
      await run('DELETE FROM flavor_channel_skus WHERE flavor_id=?', id);

      // Pull every pattern row for every enabled channel in one query —
      // cheaper than N round-trips per channel and lets us see at a glance
      // which channels have no patterns (skipped silently with a log line).
      const allPatterns = await all(
        `SELECT p.*, c.code AS channel_code, c.name AS channel_name
           FROM flavor_channel_sku_patterns p
           JOIN flavor_channels c ON c.id = p.channel_id
          WHERE c.enabled = 1
          ORDER BY c.position ASC, p.position ASC, p.id ASC`
      );

      const skusByChannel = new Map(); // channel.id -> [{listing_type, fulfillment, channel_sku}]
      const channelsWithPatterns = new Set(allPatterns.map(p => p.channel_id));
      for (const c of channels) {
        if (!channelsWithPatterns.has(c.id)) {
          console.warn(`[flavors2] channel ${c.code} has no SKU patterns — skipping`);
          continue;
        }
        skusByChannel.set(c.id, []);
      }
      for (const p of allPatterns) {
        const sku = substitutePatternTemplate(p.template, f.sku);
        await run(
          `INSERT INTO flavor_channel_skus
             (flavor_id, channel_id, listing_type, fulfillment, channel_sku, nineyard_sku)
           VALUES (?,?,?,?,?,?)`,
          id, p.channel_id, p.listing_type, p.fulfillment, sku, f.sku
        );
        if (!skusByChannel.has(p.channel_id)) skusByChannel.set(p.channel_id, []);
        skusByChannel.get(p.channel_id).push({
          listing_type: p.listing_type,
          fulfillment: p.fulfillment,
          channel_sku: sku,
        });
      }

      // Find the listing-content ticket for each channel so the per-channel
      // launch ticket can point at it. Match by title suffix — they're
      // named "Listing content — {flavor} on {channel name}".
      function listingContentForChannel(channelName) {
        return allFlavorTickets.find(t =>
          t.flavor_v2_step === 'listing_content' &&
          String(t.title || '').endsWith(' on ' + channelName)
        );
      }

      const created = [];
      // Per-channel listing-launch ticket.
      for (const c of channels) {
        const lc = listingContentForChannel(c.name);
        const desc = buildChannelLaunchDescription(
          f, c, skusByChannel.get(c.id) || [],
          lc, imageTicket, ebcTicket
        );
        const checklist = LISTING_TYPES.map(lt =>
          `${LISTING_LABEL_LOCAL[lt]} live on ${c.name}`
        );
        const t = await insertPipelineTicket(f, {
          step: 'channel_launch',
          title: `Launch listings on ${c.name} — ${f.name}`,
          priority: 'Medium',
          dept: 'Operations',
          description: desc,
          checklist,
        }, req.session.userId);
        created.push({ id: t.id, kind: 'channel_launch', channel: c.name });
      }

      // Single SKU mapping ticket — checklist per channel SKU so the worker
      // ticks them off as they map each one in NineYard.
      const allSkus = [];
      for (const c of channels) {
        for (const s of (skusByChannel.get(c.id) || [])) {
          allSkus.push({ ...s, channel: c.name });
        }
      }
      const mapDesc = buildSkuMappingDescription(f, allSkus);
      const mapChecklist = allSkus.map(s => {
        const fulfix = s.fulfillment ? ' (' + s.fulfillment.toUpperCase() + ')' : '';
        return `${s.channel_sku}${fulfix} → ${f.sku}  [${s.channel} · ${LISTING_LABEL_LOCAL[s.listing_type] || s.listing_type}]`;
      });
      const mapTicket = await insertPipelineTicket(f, {
        step: 'sku_mapping',
        title: `Map channel SKUs to NineYard — ${f.name}`,
        priority: 'Medium',
        dept: 'Operations',
        description: mapDesc,
        checklist: mapChecklist,
      }, req.session.userId);
      created.push({ id: mapTicket.id, kind: 'sku_mapping' });

      res.status(201).json({ ok: true, tickets: created, skuCount: allSkus.length });
    } catch (e) {
      console.error('[flavors2] generate-channel-skus failed:', e.message);
      res.status(500).json({ error: 'Could not generate channel SKUs — please retry.' });
    }
  });

  function buildChannelLaunchDescription(f, channel, skus, listingContent, imageTicket, ebcTicket) {
    // Group SKUs by listing_type so we can show one block per variant with
    // both fulfilments together (relevant for Amazon FBA + FBM).
    const byListing = new Map();
    for (const s of skus) {
      if (!byListing.has(s.listing_type)) byListing.set(s.listing_type, []);
      byListing.get(s.listing_type).push(s);
    }
    const lines = [];
    let idx = 1;
    for (const lt of LISTING_TYPES) {
      const group = byListing.get(lt) || [];
      if (!group.length) continue;
      lines.push(`${idx}. ${LISTING_LABEL_LOCAL[lt] || lt}`);
      for (const s of group) {
        if (s.fulfillment) {
          lines.push(`     • ${s.fulfillment.toUpperCase()} SKU: ${s.channel_sku}`);
        } else {
          lines.push(`     • SKU: ${s.channel_sku}`);
        }
      }
      lines.push(`     • Price: (per current price rules — TBD setting)`);
      lines.push('');
      idx++;
    }
    const refs = [];
    if (listingContent) refs.push(`  • Listing content: ${listingContent.id} (${listingContent.title})`);
    else                refs.push(`  • Listing content: (not yet generated — run "Generate listing content" first)`);
    if (imageTicket)    refs.push(`  • Product images: ${imageTicket.id} (${imageTicket.title})`);
    else                refs.push(`  • Product images: (not yet generated — run "Create image tickets" first)`);
    if (channel.code === 'amazon') {
      if (ebcTicket)    refs.push(`  • Amazon EBC: ${ebcTicket.id} (${ebcTicket.title})`);
      else              refs.push(`  • Amazon EBC: (not yet generated)`);
    }

    return (
      `Launch all listing variants for ${f.name} on ${channel.name}. ` +
      `Each variant below has its channel SKU pre-generated — copy them as-is unless you need to override.\n\n` +
      `Flavor: ${f.name} (${f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular'})\n` +
      `Base SKU: ${f.sku}    UPC: ${f.upc}\n` +
      (channel.has_fba ? `\nThis channel has FBA + FBM — each variant has two SKUs (one per fulfilment).\n` : '') +
      `\nVariants:\n${lines.join('\n')}\n` +
      `Cross-references on this flavor:\n${refs.join('\n')}\n\n` +
      `Check each variant off below as it goes live.`
    );
  }

  function buildSkuMappingDescription(f, allSkus) {
    return (
      `Map each generated channel SKU back to the base NineYard SKU so ` +
      `inventory tracks correctly across marketplaces.\n\n` +
      `Base NineYard SKU: ${f.sku}\n\n` +
      `Channel SKUs to map (${allSkus.length} total):\n` +
      allSkus.map(s => {
        const ff = s.fulfillment ? ' (' + s.fulfillment.toUpperCase() + ')' : '';
        return `  • ${s.channel_sku}${ff}  →  ${f.sku}  [${s.channel} · ${LISTING_LABEL_LOCAL[s.listing_type] || s.listing_type}]`;
      }).join('\n') + `\n\n` +
      `Tick each line in the subtasks list below as you map it in NineYard.`
    );
  }

  // ── Variation listings ────────────────────────────────────────────────────
  // Parent listings on Amazon / Walmart / Custom that each new flavor gets
  // added to as a child variant when inventory arrives. Settings CRUD +
  // per-flavor match + ticket spawn live here.
  const VARIATION_FLAVOR_FILTERS = ['regular', 'sugar_free', 'any'];
  const VARIATION_LISTING_FILTERS = ['single', 'single_with_pump', '4_pack', '6_pack', 'any'];

  app.get('/api/flavors2/settings/variation-listings', requireAuth, async (req, res) => {
    try {
      const rows = await all(
        `SELECT v.*, c.name AS channel_name, c.code AS channel_code, c.has_fba
           FROM flavor_variation_listings v
           LEFT JOIN flavor_channels c ON c.id = v.channel_id
          ORDER BY c.position ASC, c.id ASC, v.position ASC, v.id ASC`
      );
      res.json(rows.map(shapeVariationListing));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/flavors2/settings/variation-listings', requireAdmin, async (req, res) => {
    try {
      const { errors, clean } = validateVariation(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      const maxPos = await get(
        'SELECT MAX(position) AS p FROM flavor_variation_listings WHERE channel_id=?',
        clean.channel_id
      );
      const pos = Number(maxPos?.p || 0) + 1;
      const ins = await run(
        `INSERT INTO flavor_variation_listings
           (channel_id, name, flavor_type_filter, listing_type_filter,
            external_id, notes, enabled, position)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
        clean.channel_id, clean.name, clean.flavor_type_filter, clean.listing_type_filter,
        clean.external_id, clean.notes, clean.enabled ? 1 : 0, pos
      );
      const row = await get(
        `SELECT v.*, c.name AS channel_name, c.code AS channel_code, c.has_fba
           FROM flavor_variation_listings v
           LEFT JOIN flavor_channels c ON c.id = v.channel_id
          WHERE v.id=?`, ins.lastInsertRowid
      );
      res.status(201).json(shapeVariationListing(row));
    } catch (e) {
      console.error('[flavors2] variation create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/flavors2/settings/variation-listings/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const existing = await get('SELECT * FROM flavor_variation_listings WHERE id=?', id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const merged = {
        channel_id:           'channel_id'           in req.body ? req.body.channel_id           : existing.channel_id,
        name:                 'name'                 in req.body ? req.body.name                 : existing.name,
        flavor_type_filter:   'flavor_type_filter'   in req.body ? req.body.flavor_type_filter   : existing.flavor_type_filter,
        listing_type_filter:  'listing_type_filter'  in req.body ? req.body.listing_type_filter  : existing.listing_type_filter,
        external_id:          'external_id'          in req.body ? req.body.external_id          : existing.external_id,
        notes:                'notes'                in req.body ? req.body.notes                : existing.notes,
        enabled:              'enabled'              in req.body ? !!req.body.enabled            : !!existing.enabled,
      };
      const { errors, clean } = validateVariation(merged);
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      await run(
        `UPDATE flavor_variation_listings SET
           channel_id=?, name=?, flavor_type_filter=?, listing_type_filter=?,
           external_id=?, notes=?, enabled=?,
           updated_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id=?`,
        clean.channel_id, clean.name, clean.flavor_type_filter, clean.listing_type_filter,
        clean.external_id, clean.notes, clean.enabled ? 1 : 0,
        id
      );
      const row = await get(
        `SELECT v.*, c.name AS channel_name, c.code AS channel_code, c.has_fba
           FROM flavor_variation_listings v
           LEFT JOIN flavor_channels c ON c.id = v.channel_id
          WHERE v.id=?`, id
      );
      res.json(shapeVariationListing(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/flavors2/settings/variation-listings/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      await run('DELETE FROM flavor_variation_listings WHERE id=?', id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  function validateVariation(body) {
    const errors = [];
    const channel_id = Number(body.channel_id);
    if (!Number.isFinite(channel_id) || channel_id <= 0) errors.push('channel_id is required');
    const name = String(body.name || '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 160) errors.push('name too long');
    const flavor_type_filter = String(body.flavor_type_filter || 'any').trim();
    if (!VARIATION_FLAVOR_FILTERS.includes(flavor_type_filter)) {
      errors.push('flavor_type_filter must be regular, sugar_free, or any');
    }
    const listing_type_filter = String(body.listing_type_filter || 'any').trim();
    if (!VARIATION_LISTING_FILTERS.includes(listing_type_filter)) {
      errors.push('listing_type_filter must be single / single_with_pump / 4_pack / 6_pack / any');
    }
    return {
      errors,
      clean: {
        channel_id, name, flavor_type_filter, listing_type_filter,
        external_id: String(body.external_id || '').trim().slice(0, 200),
        notes: String(body.notes || '').slice(0, 2000),
        enabled: !!body.enabled,
      },
    };
  }

  function shapeVariationListing(row) {
    return {
      id: row.id,
      channel_id: row.channel_id,
      channel_name: row.channel_name || '',
      channel_code: row.channel_code || '',
      channel_has_fba: !!row.has_fba,
      name: row.name,
      flavor_type_filter: row.flavor_type_filter || 'any',
      listing_type_filter: row.listing_type_filter || 'any',
      external_id: row.external_id || '',
      notes: row.notes || '',
      enabled: !!row.enabled,
      position: row.position,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // Match all enabled variation listings for a given flavor + channel SKUs.
  // Returns an array of { variation, skus: [...] } pairs, where skus is the
  // subset of the flavor's channel_skus that fall under this variation
  // (same channel + listing_type matches the filter).
  async function matchVariationsForFlavor(flavorId) {
    const f = await get('SELECT * FROM flavors_v2 WHERE id=?', flavorId);
    if (!f) return [];
    const allVariations = await all(
      `SELECT v.*, c.name AS channel_name, c.code AS channel_code, c.has_fba
         FROM flavor_variation_listings v
         LEFT JOIN flavor_channels c ON c.id = v.channel_id
        WHERE v.enabled=1
        ORDER BY c.position ASC, v.position ASC, v.id ASC`
    );
    const flavorType = f.type;  // 'regular' | 'sugar_free'
    const matches = [];
    for (const v of allVariations) {
      if (v.flavor_type_filter !== 'any' && v.flavor_type_filter !== flavorType) continue;
      // Pull channel SKUs on this channel that match the listing_type filter.
      const sql = v.listing_type_filter === 'any'
        ? 'SELECT * FROM flavor_channel_skus WHERE flavor_id=? AND channel_id=? ORDER BY listing_type ASC, fulfillment ASC'
        : 'SELECT * FROM flavor_channel_skus WHERE flavor_id=? AND channel_id=? AND listing_type=? ORDER BY listing_type ASC, fulfillment ASC';
      const args = v.listing_type_filter === 'any'
        ? [flavorId, v.channel_id]
        : [flavorId, v.channel_id, v.listing_type_filter];
      const skus = await all(sql, ...args);
      if (skus.length === 0) continue;  // flavor wasn't launched on this channel — skip
      matches.push({ variation: shapeVariationListing(v), skus });
    }
    return matches;
  }

  app.get('/api/flavors2/:id/variation-matches', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const matches = await matchVariationsForFlavor(id);
      res.json(matches.map(m => ({
        variation: m.variation,
        sku_count: m.skus.length,
        skus: m.skus.map(s => ({
          listing_type: s.listing_type,
          fulfillment: s.fulfillment || '',
          channel_sku: s.channel_sku,
        })),
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/flavors2/:id/generate-variation-ticket', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const f = await get('SELECT * FROM flavors_v2 WHERE id=?', id);
      if (!f) return res.status(404).json({ error: 'Not found' });
      const already = await get(
        `SELECT COUNT(*) AS n FROM tickets
          WHERE flavor_v2_id=? AND flavor_v2_step='variation_listing' AND deleted_at IS NULL`,
        id
      );
      if (Number(already?.n || 0) > 0) {
        return res.status(409).json({ error: 'Variation-listing ticket already exists. Delete it to regenerate.' });
      }
      const matches = await matchVariationsForFlavor(id);
      if (!matches.length) {
        return res.status(409).json({ error: 'No matching variation listings. Add some in Settings → Variations, or generate channel SKUs first.' });
      }

      // Build description with a section per variation.
      const lines = [
        `Add ${f.name} to the variation listings below. For each, log into the`,
        `channel's catalog UI (or NineYard for Custom) and attach the listed`,
        `child SKUs to the parent ASIN / variation ID.`,
        '',
        `Flavor: ${f.name} (${f.type === 'sugar_free' ? 'Sugar-Free' : 'Regular'})`,
        `UPC: ${f.upc || '(missing)'}    Base SKU: ${f.sku || '(missing)'}`,
        '',
      ];
      const checklist = [];
      const labels = {
        single: 'Single (no pump)',
        single_with_pump: 'Single with pump',
        '4_pack': '4-pack',
        '6_pack': '6-pack',
      };
      for (const m of matches) {
        const v = m.variation;
        lines.push('────────────────────────────────────────────');
        lines.push(`${v.channel_name} — ${v.name}`);
        lines.push('────────────────────────────────────────────');
        lines.push(`Parent ID: ${v.external_id || '(none set — fill in Settings → Variations)'}`);
        if (v.notes) lines.push(`Notes: ${v.notes}`);
        lines.push(`Child SKUs to add (${m.skus.length}):`);
        for (const s of m.skus) {
          const ff = s.fulfillment ? ` (${(s.fulfillment).toUpperCase()})` : '';
          lines.push(`  • ${s.channel_sku}${ff}  [${labels[s.listing_type] || s.listing_type}]`);
        }
        lines.push('');
        checklist.push(`${v.channel_name} — ${v.name}`);
      }
      lines.push('Tick each variation off below as the flavor is attached.');

      const ticket = await insertPipelineTicket(f, {
        step: 'variation_listing',
        title: `Add ${f.name} to variation listings`,
        priority: 'Medium',
        dept: 'Operations',
        description: lines.join('\n'),
        checklist,
      }, req.session.userId);

      res.status(201).json({ ok: true, ticket: { id: ticket.id }, matchCount: matches.length });
    } catch (e) {
      console.error('[flavors2] generate-variation-ticket failed:', e.message);
      res.status(500).json({ error: 'Could not generate ticket — please retry.' });
    }
  });

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
        const review = await insertPipelineTicket(f, {
          step: 'label_review',
          title: `Review label design for ${f.name}`,
          priority: 'High',
          dept: 'Design',
          description: desc,
        }, null);
        // Carry every file the designer uploaded to the design ticket
        // (direct, subtask, or comment) onto the review ticket so the
        // reviewer can actually review what they're reviewing. Each file
        // is duplicated on disk (new UUID filename) so a later delete on
        // either side doesn't break the other.
        await copyTicketAttachmentsTo(ticket.id, review.id);
      } catch (e) {
        console.warn('[flavorsHook.onTicketClosed] failed:', e && e.message);
      }
    },
  };

  // ── Delete (admin, password-confirmed) ────────────────────────────────────
  // Destructive: hard-deletes the flavor row and soft-deletes every linked
  // ticket. Soft-delete means tickets remain recoverable via the existing
  // admin trash / restore endpoints — the flavor itself is unrecoverable.
  // We require the caller to re-enter their account password (verified via
  // bcrypt against users.password_hash) so a stolen session can't silently
  // wipe a flavor.
  app.delete('/api/flavors2/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
      const password = String(req.body?.password || '');
      if (!password) return res.status(400).json({ error: 'Password required' });

      const user = await get(
        'SELECT id, password_hash FROM users WHERE id=?',
        req.session.userId
      );
      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        console.warn(`[flavors2] delete password mismatch — user ${req.session.userId} on flavor ${id}`);
        return res.status(401).json({ error: 'Incorrect password.' });
      }

      const flavor = await get('SELECT name FROM flavors_v2 WHERE id=?', id);
      if (!flavor) return res.status(404).json({ error: 'Not found' });

      const tcount = await get(
        `SELECT COUNT(*) AS n FROM tickets WHERE flavor_v2_id=? AND deleted_at IS NULL`,
        id
      );
      const deletedTickets = Number(tcount?.n || 0);

      await run(
        `UPDATE tickets
            SET deleted_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          WHERE flavor_v2_id=? AND deleted_at IS NULL`,
        id
      );
      await run('DELETE FROM flavors_v2 WHERE id=?', id);

      console.log(
        `[flavors2] DELETE flavor ${id} "${flavor.name}" by user ${req.session.userId} — ${deletedTickets} ticket(s) soft-deleted`
      );
      res.json({ ok: true, deletedTickets });
    } catch (e) {
      console.error('[flavors2] delete failed:', e.message);
      res.status(500).json({ error: 'Could not delete — please retry.' });
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
