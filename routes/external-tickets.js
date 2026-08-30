// ── External ticket API for Inventory Hub ────────────────────────────────────
// Server-to-server API so inventory.brecx.com can open, read, reply to,
// re-assign, close, and delete tickets here. Called only from Inventory
// Hub's backend (no CORS surface on purpose).
//
// Auth: one static key in env TICKETS_API_KEY, presented on every request
// as the `x-tickets-api-key` header. Never accepted as a query parameter.
//
// Endpoints (all JSON):
//   POST   /api/external/tickets                — create (idempotent on externalRef)
//   GET    /api/external/tickets                — list / poll (updatedSince)
//   GET    /api/external/tickets/:id            — one ticket + full thread
//   POST   /api/external/tickets/:id/messages   — reply into the thread
//   PATCH  /api/external/tickets/:id            — status and/or assignee
//   DELETE /api/external/tickets/:id            — remove (same soft delete the UI uses)
//
// Tickets and replies created here trigger the SAME in-app notification
// fan-out as the interactive routes (notifications row + email + web push
// + Slack DM), so e.g. the label-printing person hears about a warehouse
// request immediately.
//
// Outbound webhook: fireTicketsWebhook(event, ticketId) POSTs
// { event, ticketId, ticket } to TICKETS_WEBHOOK_URL (skipped when unset)
// with header x-tickets-webhook-secret = TICKETS_WEBHOOK_SECRET, for any
// new message or status change on a ticket whose source is an external
// app. Exposed on app.locals so the in-app comment/status routes fire it
// too — that's how Inventory Hub sees UI replies without polling.

const { createHash, timingSafeEqual } = require('crypto');

module.exports = function attach(app, deps) {
  const {
    get, all, run, writeTimeline, TL,
    sendPushToUser, slackDmUser, fireEmail,
    sendTicketAssignedEmail, sendNewCommentEmail,
    sendTicketStatusChangedEmail, sendTicketClosedEmail,
    appUrl,
  } = deps;

  const SOURCE_LABELS = { 'inventory-hub': 'Inventory Hub' };
  const sourceLabel = (s) => SOURCE_LABELS[s] || s || '';

  // ── Auth ──────────────────────────────────────────────────────────────
  function requireTicketsApiKey(req, res, next) {
    const configured = String(process.env.TICKETS_API_KEY || '').trim();
    if (!configured) {
      return res.status(503).json({ ok: false, error: 'External ticket API is not configured (TICKETS_API_KEY unset)' });
    }
    const presented = String(req.headers['x-tickets-api-key'] || '').trim();
    // Hash both sides so timingSafeEqual always gets equal-length buffers.
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(configured).digest();
    if (!presented || !timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'Invalid or missing API key' });
    }
    next();
  }

  // ── Small helpers ─────────────────────────────────────────────────────
  // DB timestamps are TEXT 'YYYY-MM-DD HH24:MI:SS' in UTC.
  const toIso = (t) => {
    if (!t) return null;
    const d = new Date(String(t).replace(' ', 'T') + 'Z');
    return isNaN(d) ? null : d.toISOString();
  };
  const isoToDbText = (iso) => {
    const d = new Date(String(iso));
    return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
  };

  // The external API speaks a stable 3-state status vocabulary; the app
  // itself has finer-grained statuses. Reads collapse, writes map to a
  // canonical in-app value.
  const STATUS_TO_DB = { open: 'Open', pending: 'Pending Review', closed: 'Closed' };
  const externalStatus = (dbStatus) => {
    const s = String(dbStatus || '');
    if (s === 'Closed' || s === 'Archived') return 'closed';
    if (s === 'Pending Review' || s === 'On Hold' || s === 'In Review') return 'pending';
    return 'open';
  };
  const PRIORITY_TO_DB = { low: 'Low', normal: 'Medium', high: 'High', urgent: 'Urgent' };
  const externalPriority = (p) =>
    ({ Low: 'low', Medium: 'normal', High: 'high', Urgent: 'urgent', Critical: 'urgent' }[p] || 'normal');

  const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

  async function resolveUserByEmail(email) {
    if (!email || !String(email).includes('@')) return null;
    return await get(
      'SELECT id,name,email FROM users WHERE LOWER(email)=LOWER(?) ORDER BY id ASC LIMIT 1',
      String(email).trim()
    );
  }

  // ── Ticket shape ──────────────────────────────────────────────────────
  // "Last activity" = newest of ticket creation, any comment, any timeline
  // row (status changes / reassignments write timeline rows) — so
  // updatedSince catches every kind of change without an updated_at column.
  const ACTIVITY_SQL = `GREATEST(t.created_at,
      COALESCE((SELECT MAX(c.created_at) FROM ticket_comments c WHERE c.ticket_id=t.id), t.created_at),
      COALESCE((SELECT MAX(l.created_at) FROM ticket_timelines l WHERE l.ticket_id=t.id), t.created_at))`;

  const TICKET_SELECT = `SELECT t.*, ${ACTIVITY_SQL} AS activity_at,
       td.description AS _description,
       au.name AS _assignee_name, au.email AS _assignee_email,
       qu.name AS _req_name,      qu.email AS _req_email
  FROM tickets t
  LEFT JOIN ticket_details td ON td.ticket_id = t.id
  LEFT JOIN users au ON au.id = t.assignee_user_id
  LEFT JOIN users qu ON qu.id = t.req_user_id`;

  function ticketJson(row, lastMessage) {
    const numMatch = /^TKT-(\d+)$/.exec(row.id);
    const requesterName = row._req_name || row.req || '';
    return {
      id: row.id,
      number: numMatch ? parseInt(numMatch[1], 10) : null,
      subject: row.title,
      status: externalStatus(row.status),
      statusDetail: row.status,
      priority: externalPriority(row.priority),
      priorityDetail: row.priority,
      requester: { name: requesterName, email: row.requester_email || row._req_email || null },
      assignee: (row._assignee_name || row.assignee)
        ? { name: row._assignee_name || row.assignee, email: row._assignee_email || null }
        : null,
      category: row.dept || null,
      source: row.source || null,
      externalRef: row.external_ref || null,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.activity_at),
      closedAt: toIso(row.closed_at),
      messageCount: 1 + (row.comments_count || 0), // initial message + replies
      lastMessage: lastMessage || {
        author: requesterName || sourceLabel(row.source) || 'Unknown',
        body: String(row._description || '').slice(0, 200),
        at: toIso(row.created_at),
      },
      url: `${appUrl}/tickets/${row.id}`,
    };
  }

  // lastMessage rows for a page of ticket ids, one query.
  async function lastMessagesFor(ticketIds) {
    if (!ticketIds.length) return new Map();
    const ph = ticketIds.map(() => '?').join(',');
    const rows = await all(
      `SELECT DISTINCT ON (tc.ticket_id) tc.ticket_id, tc.text, tc.created_at,
              COALESCE(u.name, tc.author) AS author
         FROM ticket_comments tc
         LEFT JOIN users u ON u.id = tc.author_user_id
        WHERE tc.ticket_id IN (${ph})
        ORDER BY tc.ticket_id, tc.created_at DESC, tc.id DESC`,
      ...ticketIds
    );
    const map = new Map();
    for (const r of rows) {
      map.set(r.ticket_id, { author: r.author, body: String(r.text || '').slice(0, 200), at: toIso(r.created_at) });
    }
    return map;
  }

  async function loadExternalTicket(id) {
    const row = await get(`${TICKET_SELECT} WHERE t.id=? AND t.deleted_at IS NULL`, id);
    if (!row) return null;
    const lm = await lastMessagesFor([row.id]);
    return ticketJson(row, lm.get(row.id) || null);
  }

  // ── Outbound webhook ──────────────────────────────────────────────────
  // Fire-and-forget POST to Inventory Hub on new messages / status changes
  // for tickets that came from an external app. Silently skipped when
  // TICKETS_WEBHOOK_URL is unset or the ticket isn't externally sourced.
  async function fireTicketsWebhook(event, ticketId) {
    try {
      const url = String(process.env.TICKETS_WEBHOOK_URL || '').trim();
      if (!url) return;
      const src = await get('SELECT source FROM tickets WHERE id=?', ticketId);
      if (!src || !src.source) return;
      const ticket = await loadExternalTicket(ticketId);
      if (!ticket) return;
      const headers = { 'content-type': 'application/json' };
      const secret = String(process.env.TICKETS_WEBHOOK_SECRET || '').trim();
      if (secret) headers['x-tickets-webhook-secret'] = secret;
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ event, ticketId, ticket }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      console.warn('[tickets-webhook] failed:', e && e.message);
    }
  }
  app.locals.fireTicketsWebhook = fireTicketsWebhook;

  // ── Notification fan-outs (parity with the interactive routes) ───────
  function notifyAssignee(target, { actorLabel, ticketId, title, priority, due, status, dept, requester, description }) {
    // Same 4 side effects as POST /api/tickets: in-app row, email, push, Slack.
    run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
      target.id, 'assigned', '👤', `${actorLabel} assigned you to "${title}"`, ticketId
    ).catch((err) => console.warn('[ext-assign-notify] insert failed:', err && err.message));
    fireEmail('ticket-assigned', () => sendTicketAssignedEmail({
      toEmail: target.email, toName: target.name,
      assignerName: actorLabel,
      ticketId, title,
      priority: priority || 'Medium',
      dueAt: due || '',
      status: status || 'Open',
      dept: dept || '',
      requester: requester || '',
      description: description || '',
      tags: [],
    }));
    sendPushToUser(target.id, {
      title: 'New ticket: ' + (title || ticketId),
      body: `${actorLabel} assigned this to you`,
      tag: 'ticket-' + ticketId,
      url: '/tickets/' + ticketId,
    }).catch(() => {});
    slackDmUser(target.id, {
      text: `🎫 *${actorLabel}* assigned you to <${appUrl}/tickets/${ticketId}|${ticketId}>${title ? ' — ' + title : ''}`,
    }).catch(() => {});
  }

  // Everyone tied to the ticket: assignees + reporter + requester +
  // creator + mention-watchers — the same recipient set the in-app
  // comment route notifies. skipUserId excludes the acting user when the
  // API reply was posted "as" a workspace user.
  async function commentRecipients(tkt, skipUserId) {
    const names = new Set();
    const assigneesRows = await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', tkt.id);
    assigneesRows.forEach((r) => r.user_name && names.add(r.user_name));
    if (tkt.reporter) names.add(tkt.reporter);
    if (tkt.req) names.add(tkt.req);
    const [resolved, creatorUser, mentionWatchers] = await Promise.all([
      Promise.all(Array.from(names).map((n) => get('SELECT id,name,email FROM users WHERE name=?', n))),
      tkt.created_by ? get('SELECT id,name,email FROM users WHERE id=?', tkt.created_by) : Promise.resolve(null),
      all(`SELECT u.id, u.name, u.email
             FROM ticket_watchers tw JOIN users u ON u.id = tw.user_id
            WHERE tw.ticket_id = ?`, tkt.id),
    ]);
    const users = [];
    const seen = new Set(skipUserId ? [skipUserId] : []);
    for (const u of [...resolved, creatorUser, ...(mentionWatchers || [])]) {
      if (u && u.email && !seen.has(u.id)) { seen.add(u.id); users.push(u); }
    }
    return users;
  }

  // ═════════════════════════════ ROUTES ═════════════════════════════════

  // 1) Create a ticket (idempotent on externalRef).
  app.post('/api/external/tickets', requireTicketsApiKey, async (req, res) => {
    try {
      const b = req.body || {};
      const subject = String(b.subject || '').trim();
      const body = String(b.body || '').trim();
      const requesterEmail = String(b.requesterEmail || '').trim();
      if (!subject) return bad(res, 400, 'subject is required');
      if (!body) return bad(res, 400, 'body is required');
      if (!requesterEmail || !requesterEmail.includes('@')) return bad(res, 400, 'requesterEmail is required and must be an email address');
      const priorityIn = b.priority === undefined || b.priority === null || b.priority === '' ? 'normal' : String(b.priority);
      const priority = PRIORITY_TO_DB[priorityIn.toLowerCase()];
      if (!priority) return bad(res, 400, `priority must be one of low|normal|high|urgent (got "${b.priority}")`);
      const source = String(b.source || 'inventory-hub').trim() || 'inventory-hub';
      const externalRef = b.externalRef ? String(b.externalRef).trim() : null;

      // Idempotency: the same Inventory Hub event can fire more than once —
      // an existing (non-deleted) ticket with this externalRef wins.
      if (externalRef) {
        const existing = await get('SELECT id FROM tickets WHERE external_ref=? AND deleted_at IS NULL', externalRef);
        if (existing) {
          const ticket = await loadExternalTicket(existing.id);
          return res.status(200).json({ ok: true, duplicate: true, ticket });
        }
      }

      const requesterUser = await resolveUserByEmail(requesterEmail);
      let assigneeUser = null;
      if (b.assigneeEmail) {
        assigneeUser = await resolveUserByEmail(String(b.assigneeEmail).trim());
        if (!assigneeUser) return bad(res, 400, `assigneeEmail "${b.assigneeEmail}" does not match any user in the ticket app`);
      }

      // Allocate a unique TKT-#### id (same retry loop the app uses).
      let id = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const maxRow = await get(`SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY CAST(SUBSTRING(id FROM 5) AS INTEGER) DESC LIMIT 1`);
        let nextNum = 1000;
        if (maxRow?.id) { const m = /^TKT-(\d+)$/.exec(maxRow.id); if (m) nextNum = parseInt(m[1], 10); }
        const candidate = 'TKT-' + (nextNum + 1);
        if (!await get('SELECT id FROM tickets WHERE id=?', candidate)) { id = candidate; break; }
      }
      if (!id) return bad(res, 500, 'Could not allocate a unique ticket id — please retry');

      const label = sourceLabel(source);
      const reqName = requesterUser ? requesterUser.name : (String(b.requesterName || '').trim() || requesterEmail);
      const createdStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const dept = String(b.category || '').trim() || 'General';

      try {
        await run(
          `INSERT INTO tickets (id,title,req,assignee,reporter,priority,status,dept,due,created,overdue,tags_json,comments_count,
                                req_user_id,assignee_user_id,source,external_ref,requester_email)
           VALUES (?,?,?,?,?,?,?,?,?,?,0,'[]',0,?,?,?,?,?)`,
          id, subject, reqName, assigneeUser ? assigneeUser.name : '', label,
          priority, 'Open', dept, '', createdStr,
          requesterUser ? requesterUser.id : null,
          assigneeUser ? assigneeUser.id : null,
          source, externalRef, requesterEmail.toLowerCase()
        );
      } catch (e) {
        // Unique-index race on external_ref: another delivery of the same
        // event just created the ticket — return that one.
        if (externalRef && /idx_tickets_external_ref|duplicate key/i.test(e.message || '')) {
          const existing = await get('SELECT id FROM tickets WHERE external_ref=? AND deleted_at IS NULL', externalRef);
          if (existing) {
            const ticket = await loadExternalTicket(existing.id);
            return res.status(200).json({ ok: true, duplicate: true, ticket });
          }
        }
        throw e;
      }

      await run(
        `INSERT INTO ticket_details (ticket_id, description) VALUES (?, ?)
           ON CONFLICT (ticket_id) DO UPDATE SET description = EXCLUDED.description`,
        id, body
      );
      if (assigneeUser) {
        await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
          id, assigneeUser.name, assigneeUser.id);
      }
      await writeTimeline(id, TL.create,
        `Ticket created via ${label} for ${reqName}${assigneeUser ? ` · assigned to ${assigneeUser.name}` : ''}`);

      if (assigneeUser) {
        notifyAssignee(assigneeUser, {
          actorLabel: label, ticketId: id, title: subject,
          priority, due: '', status: 'Open', dept,
          requester: reqName, description: body,
        });
      }

      const ticket = await loadExternalTicket(id);
      res.status(201).json({ ok: true, ticket });
    } catch (e) {
      console.error('[external-tickets] create failed:', e);
      bad(res, 500, e.message);
    }
  });

  // 2) List / poll tickets.
  app.get('/api/external/tickets', requireTicketsApiKey, async (req, res) => {
    try {
      const q = req.query || {};
      const where = ['t.deleted_at IS NULL'];
      const params = [];

      const status = String(q.status || 'open').toLowerCase();
      if (status === 'closed') where.push(`t.status IN ('Closed','Archived')`);
      else if (status === 'pending') where.push(`t.status IN ('Pending Review','On Hold','In Review')`);
      else if (status === 'open') where.push(`t.status NOT IN ('Closed','Archived','Pending Review','On Hold','In Review')`);
      else if (status !== 'all') return bad(res, 400, 'status must be open|pending|closed|all');

      if (q.assigneeEmail) {
        const u = await resolveUserByEmail(String(q.assigneeEmail));
        if (!u) return res.json({ ok: true, tickets: [], total: 0 }); // no such user → nothing assigned to them
        where.push(`(t.assignee_user_id = ? OR EXISTS (SELECT 1 FROM ticket_assignees ta WHERE ta.ticket_id=t.id AND ta.user_id = ?))`);
        params.push(u.id, u.id);
      }
      if (q.requesterEmail) {
        const email = String(q.requesterEmail).trim().toLowerCase();
        const u = await resolveUserByEmail(email);
        if (u) { where.push(`(LOWER(t.requester_email) = ? OR t.req_user_id = ?)`); params.push(email, u.id); }
        else { where.push(`LOWER(t.requester_email) = ?`); params.push(email); }
      }
      if (q.source) { where.push('t.source = ?'); params.push(String(q.source)); }
      if (q.updatedSince) {
        const since = isoToDbText(q.updatedSince);
        if (!since) return bad(res, 400, 'updatedSince must be an ISO-8601 date');
        where.push(`${ACTIVITY_SQL} > ?`);
        params.push(since);
      }

      const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
      const page = Math.max(parseInt(q.page, 10) || 1, 1);
      const whereSql = where.join(' AND ');

      const totalRow = await get(`SELECT COUNT(*)::int AS n FROM tickets t WHERE ${whereSql}`, ...params);
      const rows = await all(
        `${TICKET_SELECT} WHERE ${whereSql} ORDER BY activity_at DESC, t.id DESC LIMIT ? OFFSET ?`,
        ...params, limit, (page - 1) * limit
      );
      const lastByTicket = await lastMessagesFor(rows.map((r) => r.id));
      res.json({
        ok: true,
        tickets: rows.map((r) => ticketJson(r, lastByTicket.get(r.id) || null)),
        total: totalRow ? totalRow.n : 0,
        page, limit,
      });
    } catch (e) {
      console.error('[external-tickets] list failed:', e);
      bad(res, 500, e.message);
    }
  });

  // 3) One ticket with its full message thread (oldest first).
  app.get('/api/external/tickets/:id', requireTicketsApiKey, async (req, res) => {
    try {
      const row = await get(`${TICKET_SELECT} WHERE t.id=? AND t.deleted_at IS NULL`, req.params.id);
      if (!row) return bad(res, 404, `Ticket ${req.params.id} not found`);
      const comments = await all(
        `SELECT tc.*, u.name AS live_name, u.email AS live_email
           FROM ticket_comments tc
           LEFT JOIN users u ON u.id = tc.author_user_id
          WHERE tc.ticket_id=?
          ORDER BY tc.created_at ASC, tc.id ASC`, row.id);
      const requesterName = row._req_name || row.req || '';
      const messages = [
        {
          id: 0, // the opening message lives on the ticket itself, not in the comments table
          initial: true,
          authorName: requesterName || sourceLabel(row.source) || 'Unknown',
          authorEmail: row.requester_email || row._req_email || null,
          body: String(row._description || ''),
          at: toIso(row.created_at),
          internal: false,
          viaApi: !!row.source,
        },
        ...comments.map((c) => ({
          id: c.id,
          parentId: c.parent_id || null,
          authorName: c.live_name || c.author,
          authorEmail: c.live_email || c.author_email || null,
          body: c.text,
          at: toIso(c.created_at),
          internal: false,
          viaApi: !!c.source,
        })),
      ];
      const lm = await lastMessagesFor([row.id]);
      res.json({ ok: true, ticket: { ...ticketJson(row, lm.get(row.id) || null), messages } });
    } catch (e) {
      console.error('[external-tickets] get failed:', e);
      bad(res, 500, e.message);
    }
  });

  // 4) Reply into a ticket.
  app.post('/api/external/tickets/:id/messages', requireTicketsApiKey, async (req, res) => {
    try {
      const tkt = await get('SELECT * FROM tickets WHERE id=? AND deleted_at IS NULL', req.params.id);
      if (!tkt) return bad(res, 404, `Ticket ${req.params.id} not found`);
      const b = req.body || {};
      const text = String(b.body || '').trim();
      if (!text) return bad(res, 400, 'body is required');

      const source = tkt.source || 'inventory-hub';
      const label = sourceLabel(source);
      const authorUser = b.authorEmail ? await resolveUserByEmail(String(b.authorEmail).trim()) : null;
      // Post as the matched user ("via Inventory Hub" badge in the UI), or
      // as the external app itself with whatever name was given.
      const authorName = authorUser ? authorUser.name : (String(b.authorName || '').trim() || label);
      const init = authorName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      const palette = ['#ede9fe|#5b21b6', '#dde4ff|#3730a3', '#dcfce7|#166534', '#fef9c3|#854d0e'];
      const [bg, col] = (authorUser ? palette[authorUser.id % palette.length] : palette[1]).split('|');

      const info = await run(
        `INSERT INTO ticket_comments (ticket_id,author,author_user_id,author_init,author_bg,author_col,text,source,author_email)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        tkt.id, authorName, authorUser ? authorUser.id : null, init, bg, col, text,
        source, b.authorEmail ? String(b.authorEmail).trim().toLowerCase() : null
      );
      await run('UPDATE tickets SET comments_count=comments_count+1 WHERE id=?', tkt.id);
      writeTimeline(tkt.id, TL.comment, `${authorName} commented via ${label}`);
      const commentId = Number(info.lastInsertRowid);

      // Same watcher fan-out as the in-app comment route.
      setImmediate(() => { (async () => {
        try {
          const recipients = await commentRecipients(tkt, authorUser ? authorUser.id : null);
          for (const w of recipients) {
            run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
              w.id, 'comment', '💬', `${authorName} commented on "${tkt.title || tkt.id}"`, tkt.id
            ).catch((err) => console.warn('[ext-comment-notify] insert failed:', err && err.message));
            fireEmail('new-comment', () => sendNewCommentEmail({
              toEmail: w.email, toName: w.name,
              authorName, authorRole: authorUser ? '' : label,
              authorBg: bg, authorFg: col,
              ticketId: tkt.id, title: tkt.title || '',
              commentText: text,
            }));
            sendPushToUser(w.id, {
              title: `${authorName} commented on ${tkt.title || tkt.id}`,
              body: text.slice(0, 140),
              tag: 'ticket-' + tkt.id + '-cmt',
              url: '/tickets/' + tkt.id,
            }).catch(() => {});
            slackDmUser(w.id, {
              text: `💬 *${authorName}* commented on <${appUrl}/tickets/${tkt.id}|${tkt.id}>${tkt.title ? ' — ' + tkt.title : ''}\n> ${text.slice(0, 280)}`,
            }).catch(() => {});
          }
        } catch (err) {
          console.warn('[ext-comment-fanout] failed:', err && err.message);
        }
      })(); });

      fireTicketsWebhook('message.created', tkt.id);

      const c = await get('SELECT created_at FROM ticket_comments WHERE id=?', commentId);
      res.status(201).json({
        ok: true,
        message: {
          id: commentId,
          authorName,
          authorEmail: authorUser ? authorUser.email : (b.authorEmail ? String(b.authorEmail).trim().toLowerCase() : null),
          body: text,
          at: toIso(c && c.created_at),
          viaApi: true,
        },
      });
    } catch (e) {
      console.error('[external-tickets] reply failed:', e);
      bad(res, 500, e.message);
    }
  });

  // 5) Update: status and/or assignee.
  app.patch('/api/external/tickets/:id', requireTicketsApiKey, async (req, res) => {
    try {
      const tkt = await get('SELECT * FROM tickets WHERE id=? AND deleted_at IS NULL', req.params.id);
      if (!tkt) return bad(res, 404, `Ticket ${req.params.id} not found`);
      const b = req.body || {};
      const label = sourceLabel(tkt.source || 'inventory-hub');

      let newStatus = null;
      if (b.status !== undefined) {
        newStatus = STATUS_TO_DB[String(b.status).toLowerCase()];
        if (!newStatus) return bad(res, 400, 'status must be open|pending|closed');
      }
      let assigneeUser = null;
      if (b.assigneeEmail !== undefined) {
        assigneeUser = await resolveUserByEmail(String(b.assigneeEmail || '').trim());
        if (!assigneeUser) return bad(res, 400, `assigneeEmail "${b.assigneeEmail}" does not match any user in the ticket app`);
      }
      if (!newStatus && !assigneeUser) return bad(res, 400, 'Nothing to update — send status and/or assigneeEmail');

      // ── Reassignment ──
      if (assigneeUser && assigneeUser.id !== tkt.assignee_user_id) {
        const oldAssignee = tkt.assignee || '';
        await run('UPDATE tickets SET assignee=?, assignee_user_id=? WHERE id=?', assigneeUser.name, assigneeUser.id, tkt.id);
        // Keep the multi-assignee set consistent: swap the old primary for the new one.
        if (oldAssignee) await run('DELETE FROM ticket_assignees WHERE ticket_id=? AND user_name=?', tkt.id, oldAssignee);
        await run('INSERT INTO ticket_assignees (ticket_id,user_name,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
          tkt.id, assigneeUser.name, assigneeUser.id);
        await writeTimeline(tkt.id, TL.assign,
          oldAssignee ? `${label} reassigned the ticket from ${oldAssignee} to ${assigneeUser.name}`
                      : `${label} assigned the ticket to ${assigneeUser.name}`);
        const desc = await get('SELECT description FROM ticket_details WHERE ticket_id=?', tkt.id);
        notifyAssignee(assigneeUser, {
          actorLabel: label, ticketId: tkt.id, title: tkt.title,
          priority: tkt.priority, due: tkt.due, status: newStatus || tkt.status,
          dept: tkt.dept, requester: tkt.req, description: (desc && desc.description) || '',
        });
      }

      // ── Status change ──
      const oldStatus = tkt.status;
      if (newStatus && newStatus !== oldStatus) {
        if (newStatus === 'Closed') {
          await run(`UPDATE tickets SET status=?, closed_at=TO_CHAR(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') WHERE id=?`, newStatus, tkt.id);
        } else if (oldStatus === 'Closed') {
          await run('UPDATE tickets SET status=?, closed_at=NULL, close_reason=NULL WHERE id=?', newStatus, tkt.id);
        } else {
          await run('UPDATE tickets SET status=? WHERE id=?', newStatus, tkt.id);
        }
        await writeTimeline(tkt.id,
          newStatus === 'Closed' ? TL.close : (oldStatus === 'Closed' ? TL.reopen : TL.status),
          newStatus === 'Closed' ? `${label} closed the ticket (was ${oldStatus})`
            : (oldStatus === 'Closed' ? `${label} reopened the ticket (now ${newStatus})`
                                      : `${label} changed status from ${oldStatus} to ${newStatus}`));

        // Same fan-out as the in-app status change (assignees + reporter + requester).
        const _oldClosedFlag = tkt.closed_email_sent;
        setImmediate(() => { (async () => {
          try {
            const updated = await get('SELECT * FROM tickets WHERE id=?', tkt.id);
            const currentAssignees = (await all('SELECT user_name FROM ticket_assignees WHERE ticket_id=?', tkt.id)).map((a) => a.user_name);
            const recipientNames = new Set([...currentAssignees, updated.reporter, updated.req].filter(Boolean));
            const recipients = (await Promise.all(
              Array.from(recipientNames).map((n) => get('SELECT id,name,email FROM users WHERE name=?', n))
            )).filter((r) => r && r.email);
            for (const target of recipients) {
              fireEmail('status-changed', () => sendTicketStatusChangedEmail({
                toEmail: target.email, toName: target.name,
                changedByName: label,
                ticketId: tkt.id, title: updated.title || '',
                fromStatus: oldStatus, toStatus: newStatus,
              }));
              sendPushToUser(target.id, {
                title: `${updated.title || tkt.id}`,
                body: `${label} changed status: ${oldStatus} → ${newStatus}`,
                tag: 'ticket-' + tkt.id,
                url: '/tickets/' + tkt.id,
              }).catch(() => {});
              slackDmUser(target.id, {
                text: `🔄 *${label}* moved <${appUrl}/tickets/${tkt.id}|${tkt.id}>${updated.title ? ' — ' + updated.title : ''} from *${oldStatus}* to *${newStatus}*`,
              }).catch(() => {});
              run('INSERT INTO notifications (user_id,type,icon,text,ticket_id,unread) VALUES (?,?,?,?,?,1)',
                target.id, 'status', '🔄', `${label} moved "${updated.title || tkt.id}": ${oldStatus} → ${newStatus}`, tkt.id
              ).catch((err) => console.warn('[ext-status-notify] insert failed:', err && err.message));
            }
            if (newStatus === 'Closed' && !_oldClosedFlag) {
              run('UPDATE tickets SET closed_email_sent=1 WHERE id=?', tkt.id).catch(() => {});
              const createdAt = updated.created_at ? new Date(String(updated.created_at).replace(' ', 'T') + 'Z') : null;
              const daysOpen = createdAt && !isNaN(createdAt) ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86400000)) : null;
              for (const target of recipients) {
                fireEmail('ticket-closed', () => sendTicketClosedEmail({
                  toEmail: target.email, toName: target.name,
                  closerName: label,
                  ticketId: tkt.id, title: updated.title || '',
                  resolution: updated.req || '',
                  resolvedAt: new Date(),
                  daysOpen,
                  commentsCount: updated.comments_count || 0,
                }));
              }
            }
          } catch (err) {
            console.warn('[ext-status-fanout] failed:', err && err.message);
          }
        })(); });

        fireTicketsWebhook('ticket.status_changed', tkt.id);
      }

      const ticket = await loadExternalTicket(tkt.id);
      res.json({ ok: true, ticket });
    } catch (e) {
      console.error('[external-tickets] update failed:', e);
      bad(res, 500, e.message);
    }
  });

  // 6) Delete — same soft delete the in-app delete uses (an Admin can
  // restore via /api/admin/tickets/restore/:id if it was a mistake).
  app.delete('/api/external/tickets/:id', requireTicketsApiKey, async (req, res) => {
    try {
      const tkt = await get('SELECT id, is_project FROM tickets WHERE id=? AND deleted_at IS NULL', req.params.id);
      if (!tkt) return bad(res, 404, `Ticket ${req.params.id} not found`);
      let cascaded = 0;
      if (tkt.is_project) {
        const kids = await all('SELECT id FROM tickets WHERE parent_ticket_id=? AND deleted_at IS NULL', tkt.id);
        for (const k of kids) {
          await run(`UPDATE tickets SET deleted_at=TO_CHAR(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') WHERE id=?`, k.id);
          cascaded++;
        }
      }
      await run(`UPDATE tickets SET deleted_at=TO_CHAR(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') WHERE id=?`, tkt.id);
      res.json({ ok: true, deleted: tkt.id, cascadedSubtickets: cascaded });
    } catch (e) {
      console.error('[external-tickets] delete failed:', e);
      bad(res, 500, e.message);
    }
  });
};
