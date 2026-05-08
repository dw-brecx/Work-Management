/**
 * email.js — nodemailer-based email service for Syruvia / Ticket - Brecx.
 *
 * Implements every template in the email-templates gallery:
 *   1. meeting-invite           sendMeetingInviteEmail
 *   2. meeting-reminder         sendMeetingReminderEmail
 *   3. task-assigned            sendTaskAssignedEmail
 *   4. deadline-approaching     sendDeadlineApproachingEmail
 *   5. event-cancelled          sendEventCancelledEmail
 *   6. ticket-assigned          sendTicketAssignedEmail
 *   7. status-changed           sendTicketStatusChangedEmail
 *   8. new-comment              sendNewCommentEmail
 *   9. mention                  sendMentionEmail
 *  10. ticket-closed            sendTicketClosedEmail
 *  11. account-invite           sendInviteEmail
 *  12. activate-account         sendActivateAccountEmail
 *  13. welcome                  sendWelcomeEmail
 *  14. forgot-password          sendForgotPasswordEmail
 *  15. password-changed         sendPasswordChangedEmail
 *  16. new-device-login         sendNewDeviceLoginEmail
 *  17. overdue-digest           sendOverdueDigestEmail
 *  18. ticket-reminder          sendTicketReminderEmail   (user-set self-reminder)
 *
 * URL conventions used in every template (path-based, clean URLs):
 *   ${APP_URL}/tickets/TKT-1069    — single ticket
 *   ${APP_URL}/tickets?filter=...  — ticket list with filter
 *   ${APP_URL}/calendar            — calendar view
 *   ${APP_URL}/settings            — settings / account
 *   ${APP_URL}/invite.html?token=  — invite landing
 *   ${APP_URL}/reset-password.html?token=  — reset landing
 *
 * Configuration (.env):
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
 *   FROM_EMAIL          e.g. 'Ticket - Brecx <noreply@brecx.com>'
 *   APP_URL             e.g. 'https://app.brecx.com'  (used for links)
 *   APP_NAME            defaults to 'Ticket - Brecx'
 *
 * If SMTP credentials are missing, the module falls back to logging the
 * rendered email to the console (so dev environments still work).
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

const APP_NAME = process.env.APP_NAME || 'Ticket - Brecx';
const APP_URL  = (process.env.APP_URL  || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const FROM     = process.env.FROM_EMAIL || `${APP_NAME} <no-reply@example.com>`;

// ── URL builders ─────────────────────────────────────────────────────────────
// All app deep-links are generated through these helpers so the path scheme is
// kept in one place. Frontend should serve /tickets, /tickets/:id, /calendar,
// /settings via SPA routes (server.js handles this).
function ticketUrl(id)        { return `${APP_URL}/tickets/${encodeURIComponent(id)}`; }
function ticketListUrl(query) { return `${APP_URL}/tickets${query ? `?${query}` : ''}`; }
function calendarUrl()        { return `${APP_URL}/calendar`; }
function settingsUrl()        { return `${APP_URL}/settings`; }
function inviteUrl(token)     { return `${APP_URL}/invite.html?token=${encodeURIComponent(token)}`; }

// ── Transporter ──────────────────────────────────────────────────────────────
let transporter = null;

function buildTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')).toLowerCase() === 'true';

  if (!host || !user || !pass) {
    console.warn('[email] SMTP not fully configured — emails will be logged to console only.');
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
  });

  // Verify in the background — non-blocking
  transporter.verify().then(
    () => console.log(`[email] SMTP transport ready (${host}:${port}, secure=${secure})`),
    err => console.error('[email] SMTP verification failed:', err.message)
  );
  return transporter;
}
buildTransporter();

// Core dispatcher used by every template helper below.
async function sendMail({ to, subject, html, text, replyTo }) {
  if (!to) {
    console.warn('[email] sendMail called with empty `to` — skipped.');
    return { skipped: true, reason: 'no-recipient' };
  }
  const t = buildTransporter();
  if (!t) {
    // Dev mode — just log and continue without throwing.
    console.log(`\n========== EMAIL (DEV / NO SMTP) ==========`);
    console.log(`To:      ${to}`);
    console.log(`From:    ${FROM}`);
    console.log(`Subject: ${subject}`);
    console.log(`(html length=${html?.length || 0})`);
    console.log(`===========================================\n`);
    return { skipped: true, reason: 'no-smtp' };
  }
  try {
    const info = await t.sendMail({
      from: FROM, to, subject, html,
      text: text || htmlToText(html),
      replyTo: replyTo || undefined,
    });
    return { ok: true, messageId: info.messageId };
  } catch(e) {
    console.error('[email] sendMail failed:', e.message);
    throw e;
  }
}

// ── Helpers (HTML escaping, formatting, text fallback) ───────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|div|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

// Format any input that looks like a date into "Friday, May 24, 2024"
function fmtLongDate(d) {
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return String(d || '');
    return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return String(d || ''); }
}
function fmtShortDate(d) {
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return String(d || '');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return String(d || ''); }
}
function fmtDateTime(d) {
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return String(d || '');
    return dt.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return String(d || ''); }
}

// ── Reusable shell — every email starts and ends with the same chrome ────────
function shell(opts) {
  const {
    name = 'Email',
    subject = '',
    preheader = '',
    headerEyebrow = '',
    headerEmoji = '',
    headerTitle = '',
    headerSub = '',
    body = '',
    ctaText = '',
    ctaHref = '#',
    footerNote = '',
  } = opts;

  return `<!-- ${escapeHtml(APP_NAME)} Email · ${escapeHtml(name)} -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="X-UA-Compatible" content="IE=edge"/>
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">

<!-- Preheader (hidden preview text) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f7fb;">
  ${preheader}
</div>

<!-- Outer wrapper -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f7fb;padding:32px 16px;">
  <tr>
    <td align="center">

      <!-- Email body container -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 14px rgba(15,23,42,0.06);">

        <!-- Brand header -->
        <tr>
          <td style="background:linear-gradient(135deg,#004874 0%,#1381bd 100%);padding:24px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:13px;font-weight:700;color:#ffffff;letter-spacing:0.02em;">
                  <span style="display:inline-block;background:rgba(255,255,255,0.18);padding:5px 9px;border-radius:6px;font-weight:800;">T</span>
                  &nbsp;&nbsp;${escapeHtml(APP_NAME)}
                </td>
                <td align="right" style="font-size:11px;color:rgba(255,255,255,0.78);letter-spacing:0.04em;text-transform:uppercase;font-weight:500;">
                  ${headerEyebrow}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Hero / event title -->
        <tr>
          <td style="padding:36px 36px 20px 36px;">
            ${headerEmoji ? `<div style="font-size:32px;line-height:1;margin-bottom:14px;">${headerEmoji}</div>` : ''}
            <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:600;color:#0f172a;letter-spacing:-0.01em;line-height:1.3;">${headerTitle}</h1>
            ${headerSub ? `<p style="margin:0;font-size:13px;color:#475569;line-height:1.55;">${headerSub}</p>` : ''}
          </td>
        </tr>

        <!-- Body content -->
        <tr>
          <td style="padding:0 36px 28px 36px;">
            ${body}
          </td>
        </tr>

        ${ctaText ? `
        <!-- CTA button -->
        <tr>
          <td style="padding:0 36px 32px 36px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-radius:10px;background:#004874;">
                  <a href="${ctaHref || '#'}" style="display:inline-block;padding:13px 28px;font-size:13px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">
                    ${ctaText} &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ` : ''}

        ${footerNote ? `
        <!-- Inline footer note -->
        <tr>
          <td style="padding:0 36px 28px 36px;">
            <p style="margin:0;font-size:11.5px;color:#94a3b8;line-height:1.55;">${footerNote}</p>
          </td>
        </tr>
        ` : ''}

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 36px;">
            <p style="margin:0 0 6px 0;font-size:11px;color:#94a3b8;line-height:1.55;">
              You're receiving this because you're a member of the ${escapeHtml(APP_NAME)} workspace.
              <a href="${settingsUrl()}" style="color:#475569;text-decoration:underline;">Notification settings</a>
            </p>
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>

</body>
</html>`;
}

// Reusable building blocks
function infoRow(label, value) {
  return `<tr>
    <td style="padding:8px 0;font-size:12px;color:#94a3b8;width:110px;vertical-align:top;font-weight:500;letter-spacing:0.02em;text-transform:uppercase;">${label}</td>
    <td style="padding:8px 0;font-size:13px;color:#0f172a;font-weight:500;line-height:1.5;">${value}</td>
  </tr>`;
}
function infoTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;margin:0 0 16px 0;">
    ${rows.join('')}
  </table>`;
}
function quoteBlock(text, authorLine) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-left:3px solid #004874;border-radius:6px;margin:0 0 16px 0;">
    <tr><td style="padding:14px 18px;">
      <p style="margin:0 0 6px 0;font-size:13px;color:#0f172a;line-height:1.6;">${text}</p>
      ${authorLine ? `<p style="margin:0;font-size:11.5px;color:#94a3b8;">${authorLine}</p>` : ''}
    </td></tr>
  </table>`;
}
function statusPillRow(fromLabel, fromColor, toLabel, toColor) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
    <tr>
      <td style="background:${fromColor.bg};color:${fromColor.fg};font-size:11px;font-weight:600;padding:5px 11px;border-radius:999px;">${escapeHtml(fromLabel)}</td>
      <td style="font-size:14px;color:#94a3b8;padding:0 10px;">&rarr;</td>
      <td style="background:${toColor.bg};color:${toColor.fg};font-size:11px;font-weight:600;padding:5px 11px;border-radius:999px;">${escapeHtml(toLabel)}</td>
    </tr>
  </table>`;
}

// Map an arbitrary status string to a colour pair used in the status-changed pill row.
function statusColors(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('open'))                return { bg: '#dbeafe', fg: '#1d4ed8' };
  if (s.includes('progress'))            return { bg: '#fef3c7', fg: '#b45309' };
  if (s.includes('review') || s.includes('pending')) return { bg: '#ede9fe', fg: '#6d28d9' };
  if (s.includes('block'))               return { bg: '#fee2e2', fg: '#b91c1c' };
  if (s.includes('closed') || s.includes('done') || s.includes('resolved'))
                                          return { bg: '#dcfce7', fg: '#15803d' };
  return { bg: '#f1f5f9', fg: '#475569' };
}
function priorityColors(p) {
  const s = String(p || '').toLowerCase();
  if (s === 'urgent' || s === 'critical') return { bg: '#fee2e2', fg: '#b91c1c' };
  if (s === 'high')                       return { bg: '#fee2e2', fg: '#b91c1c' };
  if (s === 'medium')                     return { bg: '#fef3c7', fg: '#b45309' };
  if (s === 'low')                        return { bg: '#dcfce7', fg: '#15803d' };
  return { bg: '#f1f5f9', fg: '#475569' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MEETING INVITATION
// ─────────────────────────────────────────────────────────────────────────────
async function sendMeetingInviteEmail({
  toEmail, toName, organizerName, title, startAt, endAt, location, description, attendees, eventId, tz,
}) {
  if (!toEmail) return { skipped: true };
  const dateText  = fmtLongDate(startAt);
  const timeText  = startAt
    ? `${new Date(startAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
      + (endAt ? ` &ndash; ${new Date(endAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` : '')
      + (tz ? ` (${escapeHtml(tz)})` : '')
    : '—';
  const where = location && /^https?:\/\//i.test(location)
    ? `<a href="${escapeHtml(location)}" style="color:#004874;text-decoration:underline;">${escapeHtml(location)}</a>`
    : escapeHtml(location || '—');
  const attendeesText = (attendees || []).filter(Boolean).map(escapeHtml).join(', ') || '—';
  const subject = `Meeting invite: ${title || 'Meeting'}${startAt ? ` · ${fmtShortDate(startAt)}` : ''}`;

  const html = shell({
    name: 'Meeting invitation', subject,
    preheader: `${organizerName || 'Someone'} invited you to ${title || 'a meeting'}${startAt ? ` on ${fmtShortDate(startAt)}` : ''}.`,
    headerEyebrow: 'Meeting invite',
    headerEmoji: '📅',
    headerTitle: escapeHtml(title || 'Meeting'),
    headerSub: `${escapeHtml(organizerName || 'Someone')} invited you to a meeting.`,
    body:
      infoTable([
        infoRow('When', escapeHtml(dateText)),
        infoRow('Time', timeText),
        infoRow('Where', where),
        infoRow('Attendees', attendeesText),
      ]) +
      (description
        ? `<p style="margin:0 0 12px 0;font-size:13px;color:#475569;line-height:1.65;font-weight:600;">Agenda</p>` +
          `<p style="margin:0 0 18px 0;font-size:13px;color:#0f172a;line-height:1.65;">${escapeHtml(description)}</p>`
        : ''),
    ctaText: 'View in Calendar',
    ctaHref: calendarUrl(),
    footerNote: 'Need to decline or reschedule? Reply directly to this email or update your response in ' + escapeHtml(APP_NAME) + '.',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. MEETING REMINDER (1 hr before)
// ─────────────────────────────────────────────────────────────────────────────
async function sendMeetingReminderEmail({
  toEmail, toName, title, startAt, location, attendeesCount, eventId,
}) {
  if (!toEmail) return { skipped: true };
  const startDate = startAt ? new Date(startAt) : null;
  const timeText = startDate ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  const subject = `Reminder: ${title || 'Your meeting'} starts in 1 hour`;
  const join = location && /^https?:\/\//i.test(location)
    ? `<a href="${escapeHtml(location)}" style="color:#004874;text-decoration:underline;font-weight:600;">${escapeHtml(location)}</a>`
    : escapeHtml(location || '—');

  const html = shell({
    name: 'Meeting reminder', subject,
    preheader: `${title || 'Your meeting'} starts${timeText ? ` at ${timeText}` : ''} (in 1 hour).`,
    headerEyebrow: 'Reminder · 1 hour to go',
    headerEmoji: '⏰',
    headerTitle: `${escapeHtml(title || 'Your meeting')} starts in 1 hour`,
    headerSub: startAt ? `${escapeHtml(fmtShortDate(startAt))}${timeText ? ` · ${escapeHtml(timeText)}` : ''}` : '',
    body:
      infoTable([
        infoRow('Join link', join),
        infoRow('Attendees', `${Number(attendeesCount || 1)} ${attendeesCount === 1 ? 'person' : 'people'}`),
      ]) +
      `<p style="margin:0;font-size:13px;color:#475569;line-height:1.65;">Heads-up so you have time to get ready.</p>`,
    ctaText: location && /^https?:\/\//i.test(location) ? 'Join meeting' : 'Open calendar',
    ctaHref: location && /^https?:\/\//i.test(location) ? location : calendarUrl(),
    footerNote: `Can't make it? Open the event in ${escapeHtml(APP_NAME)} to mark yourself as away.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TASK ASSIGNED (calendar event of type Task)
// ─────────────────────────────────────────────────────────────────────────────
async function sendTaskAssignedEmail({
  toEmail, toName, assignerName, title, dueAt, estimate, linkedTicketId, linkedTicketTitle, description, eventId,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `New task: ${title || 'Untitled'}${dueAt ? ` · Due ${fmtShortDate(dueAt)}` : ''}`;
  const dueLine = dueAt
    ? `<span style="color:#dc2626;font-weight:600;">${escapeHtml(fmtLongDate(dueAt))}</span>`
    : '—';
  const linkedLine = linkedTicketId
    ? `<a href="${ticketUrl(linkedTicketId)}" style="color:#004874;text-decoration:underline;">${escapeHtml(linkedTicketId)}${linkedTicketTitle ? ` &middot; ${escapeHtml(linkedTicketTitle)}` : ''}</a>`
    : '—';

  const html = shell({
    name: 'Task assigned', subject,
    preheader: `${assignerName || 'Someone'} assigned you "${title || 'a task'}"${dueAt ? ` — due ${fmtShortDate(dueAt)}` : ''}.`,
    headerEyebrow: 'New task',
    headerEmoji: '✅',
    headerTitle: escapeHtml(title || 'New task'),
    headerSub: `${escapeHtml(assignerName || 'Someone')} assigned this to you.`,
    body:
      infoTable([
        infoRow('Due', dueLine),
        infoRow('Estimate', escapeHtml(estimate || '—')),
        infoRow('Linked', linkedLine),
      ]) +
      (description
        ? `<p style="margin:0 0 10px 0;font-size:13px;font-weight:600;color:#475569;">What's needed</p>` +
          `<p style="margin:0 0 14px 0;font-size:13px;color:#0f172a;line-height:1.65;">${escapeHtml(description)}</p>`
        : ''),
    ctaText: 'Open in calendar',
    ctaHref: calendarUrl(),
    footerNote: 'You can reschedule or reassign this task from Calendar &rarr; click the date.',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. DEADLINE APPROACHING (24 hours before)
// ─────────────────────────────────────────────────────────────────────────────
async function sendDeadlineApproachingEmail({
  toEmail, toName, title, dueAt, ownerName, linkedTicketId, linkedTicketTitle, status, outstanding, eventId,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `Deadline tomorrow: ${title || 'Item'}${dueAt ? ` due ${fmtShortDate(dueAt)}` : ''}`;
  const linkedLine = linkedTicketId
    ? `<a href="${ticketUrl(linkedTicketId)}" style="color:#004874;text-decoration:underline;">${escapeHtml(linkedTicketId)}${linkedTicketTitle ? ` &middot; ${escapeHtml(linkedTicketTitle)}` : ''}</a>`
    : '—';
  const sCol = statusColors(status);
  const statusBadge = `<span style="background:${sCol.bg};color:${sCol.fg};padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;">${escapeHtml(status || 'In progress')}</span>`;

  const outstandingHtml = Array.isArray(outstanding) && outstanding.length
    ? `<p style="margin:0 0 10px 0;font-size:13px;font-weight:600;color:#475569;">Outstanding</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px 0;">` +
        outstanding.map(item =>
          `<tr><td style="padding:5px 0;font-size:13px;color:#0f172a;line-height:1.6;">○ &nbsp;${escapeHtml(item)}</td></tr>`
        ).join('') +
      `</table>`
    : '';

  const html = shell({
    name: 'Deadline approaching', subject,
    preheader: `${title || 'Item'} is due tomorrow.`,
    headerEyebrow: 'Deadline · 24 hours',
    headerEmoji: '🚩',
    headerTitle: `${escapeHtml(title || 'Item')} is due tomorrow`,
    headerSub: dueAt ? `${escapeHtml(fmtLongDate(dueAt))}` : '',
    body:
      infoTable([
        infoRow('Owner', escapeHtml(ownerName || '—')),
        infoRow('Linked', linkedLine),
        infoRow('Status', statusBadge),
      ]) + outstandingHtml,
    ctaText: linkedTicketId ? 'Open ticket' : 'Open calendar',
    ctaHref: linkedTicketId ? ticketUrl(linkedTicketId) : calendarUrl(),
    footerNote: `If this deadline needs to slip, update the date in ${escapeHtml(APP_NAME)} so the team is aligned.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EVENT CANCELLED / RESCHEDULED
// ─────────────────────────────────────────────────────────────────────────────
async function sendEventCancelledEmail({
  toEmail, toName, cancellerName, title, originalStart, originalEnd, reason,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `Cancelled: ${title || 'Event'}${originalStart ? ` · ${fmtShortDate(originalStart)}` : ''}`;
  const startLine = originalStart
    ? `${fmtLongDate(originalStart)}` +
      (originalEnd ? ` &middot; ${new Date(originalStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} &ndash; ${new Date(originalEnd).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` : '')
    : '';

  const html = shell({
    name: 'Event cancelled', subject,
    preheader: `${title || 'Event'} has been cancelled.`,
    headerEyebrow: 'Event cancelled',
    headerEmoji: '❌',
    headerTitle: `${escapeHtml(title || 'Event')} has been cancelled`,
    headerSub: `${escapeHtml(cancellerName || 'Someone')} cancelled the meeting${originalStart ? ` that was scheduled for ${escapeHtml(fmtShortDate(originalStart))}` : ''}.`,
    body:
      (startLine
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;margin:0 0 16px 0;">
            <tr><td style="padding:14px 18px;">
              <p style="margin:0 0 4px 0;font-size:11px;font-weight:600;color:#dc2626;text-transform:uppercase;letter-spacing:0.06em;">Originally scheduled</p>
              <p style="margin:0;font-size:13px;color:#0f172a;text-decoration:line-through;">${startLine}</p>
            </td></tr>
          </table>`
        : '') +
      (reason ? quoteBlock(escapeHtml(reason), `— ${escapeHtml(cancellerName || '')}`) : '') +
      `<p style="margin:0;font-size:13px;color:#475569;line-height:1.65;">No action needed. The slot has been removed from your calendar automatically.</p>`,
    ctaText: 'View calendar',
    ctaHref: calendarUrl(),
    footerNote: '',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. TICKET ASSIGNED
// ─────────────────────────────────────────────────────────────────────────────
async function sendTicketAssignedEmail({
  toEmail, toName, assignerName, ticketId, title, priority, dueAt, status, dept, requester, description, tags,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `${ticketId} assigned to you${title ? ` · ${title}` : ''}`;
  const pCol = priorityColors(priority);
  const sCol = statusColors(status);
  const url = ticketUrl(ticketId);

  const html = shell({
    name: 'Ticket assigned', subject,
    preheader: `${assignerName || 'Someone'} assigned ${ticketId} to you${dueAt ? `. Due ${fmtShortDate(dueAt)}.` : '.'}`,
    headerEyebrow: 'Ticket assigned',
    headerEmoji: '🎫',
    headerTitle: escapeHtml(title || ticketId),
    headerSub: `<a href="${url}" style="color:#004874;text-decoration:none;font-weight:600;">${escapeHtml(ticketId)}</a> &middot; ${escapeHtml(assignerName || 'Someone')} assigned this to you.`,
    body:
      infoTable([
        infoRow('Priority', `<span style="background:${pCol.bg};color:${pCol.fg};padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;">${escapeHtml(priority || 'Medium')}</span>`),
        infoRow('Due', dueAt ? `<span style="color:#dc2626;font-weight:600;">${escapeHtml(fmtLongDate(dueAt))}</span>` : '—'),
        infoRow('Status', `<span style="background:${sCol.bg};color:${sCol.fg};padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;">${escapeHtml(status || 'Open')}</span>`),
        infoRow('Department', escapeHtml(dept || '—')),
        infoRow('Requester', escapeHtml(requester || '—')),
      ]) +
      (description
        ? `<p style="margin:0 0 10px 0;font-size:13px;font-weight:600;color:#475569;">Description</p>` +
          `<p style="margin:0 0 18px 0;font-size:13px;color:#0f172a;line-height:1.65;">${escapeHtml(description)}</p>`
        : ''),
    ctaText: 'Open ticket',
    ctaHref: url,
    footerNote: Array.isArray(tags) && tags.length ? `Tags: ${tags.map(escapeHtml).join(' · ')}` : '',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. TICKET STATUS CHANGED
// ─────────────────────────────────────────────────────────────────────────────
async function sendTicketStatusChangedEmail({
  toEmail, toName, changedByName, ticketId, title, fromStatus, toStatus, comment,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `${ticketId} moved from ${fromStatus} to ${toStatus}`;
  const fromCol = statusColors(fromStatus);
  const toCol   = statusColors(toStatus);
  const url = ticketUrl(ticketId);

  const html = shell({
    name: 'Status changed', subject,
    preheader: `${changedByName || 'Someone'} moved ${ticketId} to ${toStatus}.`,
    headerEyebrow: 'Status updated',
    headerEmoji: '🔄',
    headerTitle: `Status updated on ${escapeHtml(ticketId)}`,
    headerSub: `<a href="${url}" style="color:#004874;text-decoration:none;font-weight:600;">${escapeHtml(ticketId)}</a>${title ? ` &middot; ${escapeHtml(title)}` : ''}`,
    body:
      statusPillRow(fromStatus || 'Open', fromCol, toStatus || 'Open', toCol) +
      `<p style="margin:0 0 6px 0;font-size:13px;color:#0f172a;line-height:1.65;">
        <b>${escapeHtml(changedByName || 'Someone')}</b> moved this ticket from <b>${escapeHtml(fromStatus || '—')}</b> to <b>${escapeHtml(toStatus || '—')}</b>.
      </p>` +
      `<p style="margin:0 0 16px 0;font-size:11.5px;color:#94a3b8;">${escapeHtml(fmtDateTime(new Date()))}</p>` +
      (comment ? quoteBlock(escapeHtml(comment), `— ${escapeHtml(changedByName || '')}`) : ''),
    ctaText: 'Review ticket',
    ctaHref: url,
    footerNote: '',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. NEW COMMENT ON TICKET
// ─────────────────────────────────────────────────────────────────────────────
async function sendNewCommentEmail({
  toEmail, toName, authorName, authorRole, authorBg, authorFg, ticketId, title, commentText,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `${authorName || 'Someone'} commented on ${ticketId}${title ? ` · ${title}` : ''}`;
  const url = ticketUrl(ticketId);
  const init = initials(authorName);
  const bg = authorBg || '#a78bfa';
  const fg = authorFg || '#ffffff';
  const preview = String(commentText || '').replace(/\s+/g, ' ').slice(0, 110);

  const html = shell({
    name: 'New comment', subject,
    preheader: `${authorName || 'Someone'}: "${preview}${preview.length === 110 ? '…' : ''}"`,
    headerEyebrow: 'New comment',
    headerEmoji: '💬',
    headerTitle: `${escapeHtml(authorName || 'Someone')} commented`,
    headerSub: `on <a href="${url}" style="color:#004874;text-decoration:none;font-weight:600;">${escapeHtml(ticketId)}</a>${title ? ` &middot; ${escapeHtml(title)}` : ''}`,
    body:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
        <tr>
          <td width="44" valign="top" style="padding-right:12px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="background:${bg};color:${fg};width:36px;height:36px;border-radius:50%;text-align:center;font-weight:700;font-size:13px;line-height:36px;">${escapeHtml(init)}</td></tr>
            </table>
          </td>
          <td valign="top">
            <p style="margin:0 0 2px 0;font-size:13px;font-weight:600;color:#0f172a;">${escapeHtml(authorName || 'Someone')}</p>
            <p style="margin:0;font-size:11.5px;color:#94a3b8;">${escapeHtml(authorRole || 'Team member')} · just now</p>
          </td>
        </tr>
      </table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-radius:10px;margin:0 0 16px 0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#0f172a;line-height:1.65;">${escapeHtml(commentText || '')}</p>
        </td></tr>
      </table>` +
      `<p style="margin:0;font-size:11.5px;color:#94a3b8;">Open the ticket to reply or react.</p>`,
    ctaText: 'View thread',
    ctaHref: url,
    footerNote: '',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. @-MENTION
// ─────────────────────────────────────────────────────────────────────────────
async function sendMentionEmail({
  toEmail, toName, authorName, authorRole, authorDept, ticketId, title, commentText,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `${authorName || 'Someone'} mentioned you on ${ticketId}${title ? ` · ${title}` : ''}`;
  const url = ticketUrl(ticketId);
  const init = initials(authorName);
  const youTag = `@${escapeHtml(toName || 'you')}`;

  const html = shell({
    name: 'You were mentioned', subject,
    preheader: `${authorName || 'Someone'} tagged you in a comment on ${ticketId}.`,
    headerEyebrow: 'You were mentioned',
    headerEmoji: '@',
    headerTitle: `${escapeHtml(authorName || 'Someone')} mentioned you`,
    headerSub: `in a comment on <a href="${url}" style="color:#004874;text-decoration:none;font-weight:600;">${escapeHtml(ticketId)}</a>${title ? ` &middot; ${escapeHtml(title)}` : ''}`,
    body:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2ff;border-left:3px solid #4f46e5;border-radius:6px;margin:0 0 18px 0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 8px 0;font-size:11px;font-weight:700;color:#4f46e5;text-transform:uppercase;letter-spacing:0.06em;">${youTag}</p>
          <p style="margin:0;font-size:13.5px;color:#0f172a;line-height:1.65;">${escapeHtml(commentText || '')}</p>
        </td></tr>
      </table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="40" valign="top" style="padding-right:12px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="background:#a78bfa;color:#fff;width:32px;height:32px;border-radius:50%;text-align:center;font-weight:700;font-size:11px;line-height:32px;">${escapeHtml(init)}</td></tr>
            </table>
          </td>
          <td valign="top">
            <p style="margin:0 0 2px 0;font-size:12px;color:#475569;"><b style="color:#0f172a;">${escapeHtml(authorName || 'Someone')}</b> · just now</p>
            <p style="margin:0;font-size:11.5px;color:#94a3b8;">${escapeHtml(authorRole || 'Team member')}${authorDept ? ` · ${escapeHtml(authorDept)}` : ''}</p>
          </td>
        </tr>
      </table>`,
    ctaText: 'Reply',
    ctaHref: url,
    footerNote: 'Open the ticket to add your response.',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. TICKET CLOSED
// ─────────────────────────────────────────────────────────────────────────────
async function sendTicketClosedEmail({
  toEmail, toName, closerName, ticketId, title, resolution, resolvedAt, daysOpen, commentsCount,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `${ticketId} has been closed${title ? ` · ${title}` : ''}`;
  const url = ticketUrl(ticketId);
  const resolvedDate = resolvedAt ? fmtShortDate(resolvedAt) : fmtShortDate(new Date());

  const html = shell({
    name: 'Ticket closed', subject,
    preheader: `${ticketId} was closed by ${closerName || 'someone'}.`,
    headerEyebrow: 'Ticket closed',
    headerEmoji: '✓',
    headerTitle: `${escapeHtml(ticketId)} has been closed`,
    headerSub: escapeHtml(title || ''),
    body:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;margin:0 0 18px 0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.06em;">Resolved &middot; ${escapeHtml(resolvedDate)}</p>
          <p style="margin:0;font-size:13px;color:#0f172a;line-height:1.6;">Closed by <b>${escapeHtml(closerName || 'someone')}</b>${typeof daysOpen === 'number' ? ` · ${daysOpen} day${daysOpen === 1 ? '' : 's'} from creation` : ''}</p>
        </td></tr>
      </table>` +
      (resolution
        ? `<p style="margin:0 0 10px 0;font-size:13px;font-weight:600;color:#475569;">Resolution</p>` +
          `<p style="margin:0 0 18px 0;font-size:13px;color:#0f172a;line-height:1.65;">${escapeHtml(resolution)}</p>`
        : '') +
      infoTable([
        infoRow('Closed by', escapeHtml(closerName || '—')),
        infoRow('Comments', String(commentsCount ?? 0)),
        ...(typeof daysOpen === 'number' ? [infoRow('Days open', String(daysOpen))] : []),
      ]),
    ctaText: 'View ticket',
    ctaHref: url,
    footerNote: 'Reopen by updating the status from the ticket page.',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. WORKSPACE INVITE  (also exported as sendInviteEmail for back-compat)
// ─────────────────────────────────────────────────────────────────────────────
async function sendInviteEmail({
  toEmail, toName, inviterName, inviterEmail, role, dept, token, workspaceName,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `${inviterName || 'Your team'} invited you to join ${APP_NAME}`;
  const wsName = workspaceName || APP_NAME;
  const wsInitial = (wsName || 'W').trim()[0]?.toUpperCase() || 'W';

  const html = shell({
    name: 'Workspace invite', subject,
    preheader: `${inviterName || 'Someone'} invited you to join the ${wsName} workspace.`,
    headerEyebrow: "You're invited",
    headerEmoji: '✉️',
    headerTitle: `You're invited to join ${escapeHtml(APP_NAME)}`,
    headerSub: `<b>${escapeHtml(inviterName || 'Your team')}</b> wants you on the team.`,
    body:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 18px 0;">
        <tr><td style="padding:18px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="56" valign="middle" style="padding-right:14px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr><td style="background:linear-gradient(135deg,#004874,#1381bd);color:#fff;width:48px;height:48px;border-radius:12px;text-align:center;font-weight:800;font-size:18px;line-height:48px;">${escapeHtml(wsInitial)}</td></tr>
                </table>
              </td>
              <td valign="middle">
                <p style="margin:0 0 2px 0;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(wsName)}</p>
                <p style="margin:0;font-size:12px;color:#94a3b8;">Work management workspace</p>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>` +
      infoTable([
        infoRow('Invited by', `${escapeHtml(inviterName || '—')}${inviterEmail ? ` <span style="color:#94a3b8;font-weight:400;">&lt;${escapeHtml(inviterEmail)}&gt;</span>` : ''}`),
        ...(role ? [infoRow('Your role', `<span style="background:#dbeafe;color:#1d4ed8;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;">${escapeHtml(role)}</span>`)] : []),
        ...(dept ? [infoRow('Department', escapeHtml(dept))] : []),
        infoRow('Email', escapeHtml(toEmail)),
      ]) +
      `<p style="margin:0;font-size:13px;color:#475569;line-height:1.65;">Click below to accept and create your account. The invite expires in <b>7 days</b>.</p>`,
    ctaText: 'Accept invite',
    ctaHref: inviteUrl(token),
    footerNote: `If you weren't expecting this invite, you can safely ignore this email — no account will be created.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. ACTIVATE ACCOUNT / VERIFY EMAIL
// ─────────────────────────────────────────────────────────────────────────────
async function sendActivateAccountEmail({ toEmail, toName, verifyUrl }) {
  if (!toEmail) return { skipped: true };
  const subject = `Verify your email to activate ${APP_NAME}`;
  const url = verifyUrl || `${APP_URL}/verify`;

  const html = shell({
    name: 'Verify your email', subject,
    preheader: `Confirm your email to finish setting up your ${APP_NAME} account.`,
    headerEyebrow: 'One more step',
    headerEmoji: '🔐',
    headerTitle: 'Verify your email address',
    headerSub: `Confirm <b>${escapeHtml(toEmail)}</b> to activate your ${escapeHtml(APP_NAME)} account.`,
    body:
      `<p style="margin:0 0 18px 0;font-size:13.5px;color:#0f172a;line-height:1.65;">Welcome aboard! To make sure this email belongs to you and to keep your workspace secure, click the button below within the next <b>24 hours</b>.</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-radius:10px;margin:0 0 18px 0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">Or paste this link</p>
          <p style="margin:0;font-size:12px;color:#475569;line-height:1.55;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;">${escapeHtml(url)}</p>
        </td></tr>
      </table>`,
    ctaText: 'Verify email',
    ctaHref: url,
    footerNote: `Didn't sign up for ${escapeHtml(APP_NAME)}? You can ignore this email — your address won't be used.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. WELCOME (after first successful login / registration)
// ─────────────────────────────────────────────────────────────────────────────
async function sendWelcomeEmail({ toEmail, toName }) {
  if (!toEmail) return { skipped: true };
  const firstName = String(toName || '').trim().split(/\s+/)[0] || 'there';
  const subject = `Welcome to ${APP_NAME}, ${firstName} 👋`;

  const html = shell({
    name: 'Welcome', subject,
    preheader: `You're all set. Here's how to get the most out of ${APP_NAME}.`,
    headerEyebrow: "You're in",
    headerEmoji: '🎉',
    headerTitle: `Welcome to ${escapeHtml(APP_NAME)}, ${escapeHtml(firstName)}`,
    headerSub: "Glad to have you. Here's a quick tour to get you moving.",
    body:
      `<p style="margin:0 0 18px 0;font-size:13.5px;color:#0f172a;line-height:1.65;">${escapeHtml(APP_NAME)} helps your team triage requests, manage tickets, plan work, and ship faster — all in one place. Here are three things worth doing today:</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;">
        <tr>
          <td width="40" valign="top" style="padding:6px 12px 12px 0;">
            <div style="background:#dbeafe;color:#1d4ed8;width:32px;height:32px;border-radius:8px;text-align:center;font-weight:700;font-size:14px;line-height:32px;">1</div>
          </td>
          <td valign="top" style="padding:6px 0 12px 0;">
            <p style="margin:0 0 2px 0;font-size:13.5px;font-weight:600;color:#0f172a;">Create your first ticket</p>
            <p style="margin:0;font-size:12.5px;color:#475569;line-height:1.55;">Capture work as it comes in. Set priority, due date, and assignee.</p>
          </td>
        </tr>
        <tr>
          <td width="40" valign="top" style="padding:6px 12px 12px 0;">
            <div style="background:#ede9fe;color:#6d28d9;width:32px;height:32px;border-radius:8px;text-align:center;font-weight:700;font-size:14px;line-height:32px;">2</div>
          </td>
          <td valign="top" style="padding:6px 0 12px 0;">
            <p style="margin:0 0 2px 0;font-size:13.5px;font-weight:600;color:#0f172a;">Invite your team</p>
            <p style="margin:0;font-size:12.5px;color:#475569;line-height:1.55;">Add teammates so you can assign work and collaborate.</p>
          </td>
        </tr>
        <tr>
          <td width="40" valign="top" style="padding:6px 12px 12px 0;">
            <div style="background:#dcfce7;color:#15803d;width:32px;height:32px;border-radius:8px;text-align:center;font-weight:700;font-size:14px;line-height:32px;">3</div>
          </td>
          <td valign="top" style="padding:6px 0 12px 0;">
            <p style="margin:0 0 2px 0;font-size:13.5px;font-weight:600;color:#0f172a;">Plan ahead</p>
            <p style="margin:0;font-size:12.5px;color:#475569;line-height:1.55;">Capture rough ideas in <i>Planning</i> and promote them to tickets when ready.</p>
          </td>
        </tr>
      </table>`,
    ctaText: `Open ${APP_NAME}`,
    ctaHref: APP_URL,
    footerNote: 'Need help? Reply to this email — a real person will get back to you.',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. FORGOT PASSWORD
// ─────────────────────────────────────────────────────────────────────────────
async function sendForgotPasswordEmail({ toEmail, toName, resetUrl, ip, locationLabel }) {
  if (!toEmail) return { skipped: true };
  const subject = `Reset your ${APP_NAME} password`;
  const url = resetUrl || `${APP_URL}/reset-password.html`;

  const html = shell({
    name: 'Reset password', subject,
    preheader: `Click to reset your ${APP_NAME} password. Link expires in 1 hour.`,
    headerEyebrow: 'Password reset',
    headerEmoji: '🔑',
    headerTitle: 'Reset your password',
    headerSub: `We received a request to reset the password for <b>${escapeHtml(toEmail)}</b>.`,
    body:
      `<p style="margin:0 0 18px 0;font-size:13.5px;color:#0f172a;line-height:1.65;">Click the button below to choose a new password. For your security, this link will expire in <b>1 hour</b>.</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-radius:10px;margin:0 0 18px 0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">Or paste this link</p>
          <p style="margin:0;font-size:12px;color:#475569;line-height:1.55;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;">${escapeHtml(url)}</p>
        </td></tr>
      </table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:10px;margin:0;">
        <tr><td style="padding:12px 16px;">
          <p style="margin:0;font-size:12px;color:#78350f;line-height:1.55;"><b>Didn't request this?</b> Someone may have entered your email by mistake. You can safely ignore this — your password won't change.</p>
        </td></tr>
      </table>`,
    ctaText: 'Reset password',
    ctaHref: url,
    footerNote: ip || locationLabel
      ? `Request came from ${ip ? `IP ${escapeHtml(ip)}` : ''}${ip && locationLabel ? ' · ' : ''}${locationLabel ? escapeHtml(locationLabel) : ''} at ${escapeHtml(fmtDateTime(new Date()))}.`
      : `Request received at ${escapeHtml(fmtDateTime(new Date()))}.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. PASSWORD CHANGED (security alert)
// ─────────────────────────────────────────────────────────────────────────────
async function sendPasswordChangedEmail({ toEmail, toName, ip, device, locationLabel }) {
  if (!toEmail) return { skipped: true };
  const subject = `Your ${APP_NAME} password was changed`;

  const html = shell({
    name: 'Password changed', subject,
    preheader: "Your password was just changed. If this wasn't you, take action right away.",
    headerEyebrow: 'Security alert',
    headerEmoji: '✅',
    headerTitle: 'Your password was changed',
    headerSub: `This is a confirmation that the password for <b>${escapeHtml(toEmail)}</b> was just updated.`,
    body:
      infoTable([
        infoRow('When', escapeHtml(fmtDateTime(new Date()))),
        infoRow('Device', escapeHtml(device || 'Unknown device')),
        infoRow('Location', escapeHtml(locationLabel || (ip ? `IP ${ip}` : 'Unknown'))),
      ]) +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;margin:0 0 18px 0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 6px 0;font-size:13px;font-weight:600;color:#b91c1c;">Wasn't you?</p>
          <p style="margin:0;font-size:12.5px;color:#7f1d1d;line-height:1.55;">Reset your password right away and review your active sessions. If you can't get in, contact support immediately.</p>
        </td></tr>
      </table>`,
    ctaText: 'Secure my account',
    ctaHref: settingsUrl(),
    footerNote: 'If you made this change, no further action is needed.',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. NEW DEVICE LOGIN
// ─────────────────────────────────────────────────────────────────────────────
async function sendNewDeviceLoginEmail({ toEmail, toName, ip, device, locationLabel }) {
  if (!toEmail) return { skipped: true };
  const subject = `New sign-in to your ${APP_NAME} account`;

  const html = shell({
    name: 'New device sign-in', subject,
    preheader: 'A new device just signed in to your account. Was this you?',
    headerEyebrow: 'Security alert',
    headerEmoji: '🛡️',
    headerTitle: 'New sign-in detected',
    headerSub: `We noticed a sign-in to <b>${escapeHtml(toEmail)}</b> from a device we haven't seen before.`,
    body:
      infoTable([
        infoRow('When', escapeHtml(fmtDateTime(new Date()))),
        infoRow('Device', escapeHtml(device || 'Unknown device')),
        infoRow('Location', escapeHtml(locationLabel || 'Unknown')),
        infoRow('IP address', escapeHtml(ip || '—')),
      ]) +
      `<p style="margin:0 0 14px 0;font-size:13.5px;color:#0f172a;line-height:1.65;">If this was you, no action needed. We're letting you know just in case.</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;margin:0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 6px 0;font-size:13px;font-weight:600;color:#b91c1c;">Don't recognize this?</p>
          <p style="margin:0;font-size:12.5px;color:#7f1d1d;line-height:1.55;">Sign out of all devices and change your password right away.</p>
        </td></tr>
      </table>`,
    ctaText: 'Review activity',
    ctaHref: settingsUrl(),
    footerNote: '',
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. OVERDUE DIGEST
// ─────────────────────────────────────────────────────────────────────────────
async function sendOverdueDigestEmail({ toEmail, toName, items }) {
  if (!toEmail) return { skipped: true };
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { skipped: true, reason: 'no-items' };

  const total = list.length;
  const ticketsCount   = list.filter(i => /ticket/i.test(i.type || '')).length;
  const otherCount     = total - ticketsCount;
  const oldestDays     = Math.max(...list.map(i => Number(i.daysLate || 0)), 0);
  const subject = `You have ${total} overdue item${total === 1 ? '' : 's'}${oldestDays >= 1 ? ` · oldest is ${oldestDays} day${oldestDays === 1 ? '' : 's'} late` : ''}`;

  const overdueRow = (id, title, type, daysLate, owner, link, idColor) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #e2e8f0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td valign="top" width="56" style="padding-right:12px;">
              <div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:10px;font-weight:700;padding:4px 8px;border-radius:6px;text-align:center;letter-spacing:0.04em;">
                ${daysLate} ${daysLate === 1 ? 'DAY' : 'DAYS'}<br/><span style="font-size:9px;font-weight:600;">LATE</span>
              </div>
            </td>
            <td valign="top">
              <p style="margin:0 0 3px 0;font-size:11px;color:${idColor};font-weight:700;letter-spacing:0.02em;">
                ${escapeHtml(id)} <span style="color:#94a3b8;font-weight:500;">&middot;</span>
                <span style="color:#94a3b8;font-weight:500;text-transform:uppercase;font-size:10px;">${escapeHtml(type)}</span>
              </p>
              <p style="margin:0 0 4px 0;font-size:13.5px;font-weight:600;color:#0f172a;line-height:1.4;">
                <a href="${escapeHtml(link)}" style="color:#0f172a;text-decoration:none;">${escapeHtml(title)}</a>
              </p>
              <p style="margin:0;font-size:11.5px;color:#94a3b8;">Owner: ${escapeHtml(owner || '—')}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  const sortedList = [...list].sort((a, b) => Number(b.daysLate || 0) - Number(a.daysLate || 0));
  const rowsHtml = sortedList.map(it => {
    const idColor = /ticket/i.test(it.type || '') ? '#dc2626' : (/deadline/i.test(it.type || '') ? '#7c3aed' : '#16a34a');
    const link = it.link || (it.id?.startsWith('TKT-') ? ticketUrl(it.id) : APP_URL);
    return overdueRow(it.id || '—', it.title || 'Untitled', it.type || 'Item', Number(it.daysLate || 0), it.owner || '—', link, idColor);
  }).join('');

  const html = shell({
    name: 'Overdue digest', subject,
    preheader: `${total} overdue items: ${ticketsCount} ticket${ticketsCount === 1 ? '' : 's'}, ${otherCount} other.`,
    headerEyebrow: `Overdue alert · ${escapeHtml(fmtShortDate(new Date()))}`,
    headerEmoji: '⚠️',
    headerTitle: `You have ${total} overdue item${total === 1 ? '' : 's'}`,
    headerSub: `These tickets, tasks, and deadlines have passed their due date.${oldestDays >= 1 ? ` The oldest is <b>${oldestDays} day${oldestDays === 1 ? '' : 's'} late</b>.` : ''}`,
    body:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px 0;">
        <tr>
          <td width="33%" style="padding-right:6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;">
              <tr><td style="padding:14px 16px;text-align:center;">
                <p style="margin:0 0 2px 0;font-size:24px;font-weight:700;color:#b91c1c;line-height:1;">${total}</p>
                <p style="margin:0;font-size:10.5px;color:#7f1d1d;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Total overdue</p>
              </td></tr>
            </table>
          </td>
          <td width="33%" style="padding:0 3px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;">
              <tr><td style="padding:14px 16px;text-align:center;">
                <p style="margin:0 0 2px 0;font-size:24px;font-weight:700;color:#c2410c;line-height:1;">${ticketsCount}</p>
                <p style="margin:0;font-size:10.5px;color:#7c2d12;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Tickets</p>
              </td></tr>
            </table>
          </td>
          <td width="33%" style="padding-left:6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
              <tr><td style="padding:14px 16px;text-align:center;">
                <p style="margin:0 0 2px 0;font-size:24px;font-weight:700;color:#475569;line-height:1;">${otherCount}</p>
                <p style="margin:0;font-size:10.5px;color:#475569;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Tasks &amp; deadlines</p>
              </td></tr>
            </table>
          </td>
        </tr>
      </table>` +
      `<p style="margin:0 0 4px 0;font-size:11.5px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">Sorted by oldest first</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;">${rowsHtml}</table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 4px 0;font-size:12px;font-weight:600;color:#0f172a;">💡 Quick wins</p>
          <p style="margin:0;font-size:12px;color:#475569;line-height:1.55;">Closing or rescheduling even one of these today keeps the team unblocked.</p>
        </td></tr>
      </table>`,
    ctaText: 'Open overdue list',
    ctaHref: ticketListUrl('filter=overdue'),
    footerNote: `You're getting this overdue alert daily while items remain past due. Change frequency or turn it off in Settings → Notifications.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK — reply / status change notifications to the original opener
// ─────────────────────────────────────────────────────────────────────────────
async function sendFeedbackReplyEmail({
  toEmail, toName, feedbackId, kind, title, replyAuthor, replyText,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `New reply on your feedback: ${title || ('#' + feedbackId)}`;
  const html = shell({
    name: 'Feedback reply', subject,
    preheader: `${replyAuthor || 'Someone'} replied to your ${kind || 'feedback'}.`,
    headerEyebrow: 'Feedback reply',
    headerEmoji: '💬',
    headerTitle: `${escapeHtml(replyAuthor || 'Someone')} replied`,
    headerSub: title ? escapeHtml(title) : '',
    body:
      `<div style="margin:0 0 18px;padding:14px 16px;background:#fafbff;border:1px solid #e2e8f0;border-radius:10px;color:#0f172a;font-size:13px;line-height:1.55">${escapeHtml((replyText || '').slice(0, 400))}${(replyText || '').length > 400 ? '…' : ''}</div>` +
      `<p style="margin:0;font-size:13px;color:#475569;line-height:1.65;">Open the feedback to read the full reply, add another, or change its status.</p>`,
    ctaText: 'Open feedback',
    ctaHref: `${APP_URL}/feedback`,
    footerNote: `You're getting this because you opened this feedback item.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

async function sendFeedbackStatusChangedEmail({
  toEmail, toName, feedbackId, kind, title, prevStatus, newStatus, changedBy,
}) {
  if (!toEmail) return { skipped: true };
  const STATUS_LABEL = { open: 'Open', planned: 'Planned', in_progress: 'In Progress', done: 'Done', dismissed: 'Dismissed' };
  const prevLbl = STATUS_LABEL[String(prevStatus || '').toLowerCase()] || (prevStatus || '—');
  const newLbl  = STATUS_LABEL[String(newStatus || '').toLowerCase()]  || (newStatus  || '—');
  const subject = `Feedback status updated: ${title || ('#' + feedbackId)} → ${newLbl}`;
  const html = shell({
    name: 'Feedback status', subject,
    preheader: `${changedBy || 'An admin'} marked your ${kind || 'feedback'} as ${newLbl}.`,
    headerEyebrow: 'Status update',
    headerEmoji: '📌',
    headerTitle: `Marked as ${escapeHtml(newLbl)}`,
    headerSub: title ? escapeHtml(title) : '',
    body:
      infoTable([
        infoRow('Previous status', escapeHtml(prevLbl)),
        infoRow('New status',      escapeHtml(newLbl)),
        infoRow('Changed by',      escapeHtml(changedBy || '—')),
      ]) +
      `<p style="margin:0;font-size:13px;color:#475569;line-height:1.65;">Open the feedback to see the latest replies.</p>`,
    ctaText: 'Open feedback',
    ctaHref: `${APP_URL}/feedback`,
    footerNote: `You're getting this because you opened this feedback item.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. TICKET REMINDER (user-set self-reminder on a ticket)
// ─────────────────────────────────────────────────────────────────────────────
async function sendTicketReminderEmail({
  toEmail, toName, ticketId, title, status, priority, dueAt, dept, note,
}) {
  if (!toEmail) return { skipped: true };
  const subject = `Reminder: check on ${ticketId}${title ? ' — ' + title : ''}`;
  const html = shell({
    name: 'Ticket reminder', subject,
    preheader: `You asked to be reminded to check on ${ticketId}${title ? ' (' + title + ')' : ''}.`,
    headerEyebrow: 'Reminder',
    headerEmoji: '🔔',
    headerTitle: `Check on ${escapeHtml(ticketId)}`,
    headerSub: title ? escapeHtml(title) : '',
    body:
      (note
        ? `<div style="margin:0 0 18px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;color:#78350f;font-size:13px;line-height:1.55"><strong style="color:#92400e">Your note:</strong> ${escapeHtml(note)}</div>`
        : '') +
      infoTable([
        infoRow('Ticket', escapeHtml(ticketId || '—')),
        infoRow('Status', escapeHtml(status || '—')),
        infoRow('Priority', escapeHtml(priority || '—')),
        infoRow('Due date', escapeHtml(dueAt || '—')),
        infoRow('Department', escapeHtml(dept || '—')),
      ]) +
      `<p style="margin:0;font-size:13px;color:#475569;line-height:1.65;">You set this reminder yourself. Open the ticket to follow up, change status, or set another reminder.</p>`,
    ctaText: 'Open ticket',
    ctaHref: ticketId ? ticketUrl(ticketId) : APP_URL,
    footerNote: `Reminders only go to the person who set them. To stop getting these for this ticket, open it and remove the reminder.`,
  });
  return sendMail({ to: toEmail, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// Module exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Calendar
  sendMeetingInviteEmail,
  sendMeetingReminderEmail,
  sendTaskAssignedEmail,
  sendDeadlineApproachingEmail,
  sendEventCancelledEmail,
  // Tickets
  sendTicketAssignedEmail,
  sendTicketStatusChangedEmail,
  sendNewCommentEmail,
  sendMentionEmail,
  sendTicketClosedEmail,
  sendOverdueDigestEmail,
  sendTicketReminderEmail,
  sendFeedbackReplyEmail,
  sendFeedbackStatusChangedEmail,
  // Account
  sendInviteEmail,
  sendActivateAccountEmail,
  sendWelcomeEmail,
  sendForgotPasswordEmail,
  sendPasswordChangedEmail,
  sendNewDeviceLoginEmail,
  // Low-level (for custom use)
  sendMail,
};