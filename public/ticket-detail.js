/* ============================================================
   ticket-detail.js — standalone conversation-first ticket page
   (Version B redesign of the old #page-ticket-detail in
   index.html). Talks to the same REST API; every feature of
   the old page is preserved — see the header comment block in
   ticket-detail.css and the redesign PR description.
   ============================================================ */
(function () {
'use strict';

/* ── State ─────────────────────────────────────────────────── */
let ME = null;              // /api/auth/me
let TEAM = [];              // /api/team
let DEPARTMENTS = [];       // /api/departments
let T = null;               // the ticket
let DETAILS = { description: '', checklist: [] };
let COMMENTS = [];
let TIMELINE = [];          // oldest-first after load
let SUBTASKS = [];
let SUBATTS = {};           // subtaskId → [attachments]
let ATTS = [];              // ticket attachments
let MYREMS = [];
let CHILDREN = [];
let TICKET_REMINDERS = [];
let prevViewedAt = null;    // UTC "YYYY-MM-DD HH:MM:SS" — before this visit
let descState = 'loading';  // loading | loaded | error
let commentsState = 'loading';
let editAllMode = false;
let pendingTags = [];
let pendingAssignees = [];
let pendingFiles = [];      // composer attachments waiting for send
let expandedThreads = new Set();
let expandedSubtasks = new Set();
let convoFilter = 'all';    // all | mentions | files
let editingMyRemId = null;
let openDD = null;          // currently open dropdown element

const TICKET_ID = (() => {
  const m = /^\/tickets\/([^/?#]+)/.exec(location.pathname);
  if (m) return decodeURIComponent(m[1]);
  const q = new URLSearchParams(location.search).get('id');
  return q || null;
})();

const CMT_VISIBLE_REPLIES_DEFAULT = 2;
const CMT_COLLAPSE_AT = 3;
const STATUS_OPTIONS = [
  { value: 'Open',           dot: '#3b82f6', cls: 's-open' },
  { value: 'In Progress',    dot: '#eab308', cls: 's-ip' },
  { value: 'In Review',      dot: '#06b6d4', cls: 's-ir' },
  { value: 'Pending Review', dot: '#8b5cf6', cls: 's-pr' },
  { value: 'On Hold',        dot: '#94a3b8', cls: 's-oh' },
  { value: 'Closed',         dot: '#22c55e', cls: 's-cl' },
];

/* ── Tiny helpers ──────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = esc;

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('unauthenticated'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || (method + ' ' + path + ' failed (' + r.status + ')'));
  return data;
}
const apiGet = (p) => api('GET', p);
const apiPost = (p, b) => api('POST', p, b);
const apiPut = (p, b) => api('PUT', p, b);
const apiDel = (p) => api('DELETE', p);

function toast(msg) {
  let el = document.querySelector('.td-toast');
  if (!el) { el = document.createElement('div'); el.className = 'td-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}
function teamMember(name) { return TEAM.find(m => m.name === name) || null; }
function avatarHtml(name, size, bg, fg) {
  const m = teamMember(name);
  const px = size || 30;
  const style = `width:${px}px;height:${px}px;font-size:${Math.max(7, Math.round(px / 3))}px;` +
    (m && m.avatarUrl ? '' : `background:${bg || (m && m.color) || '#64748b'};color:${fg || '#fff'}`);
  const inner = (m && m.avatarUrl) ? `<img src="${escAttr(m.avatarUrl)}" alt=""/>` : esc(initials(name));
  return `<span class="avatar" style="${style}">${inner}</span>`;
}

/* UTC "YYYY-MM-DD HH:MM:SS" (or ISO) → Date */
function parseUtc(s) {
  if (!s) return null;
  let str = String(s).replace(' ', 'T');
  if (!/Z|[+-]\d{2}:?\d{2}$/.test(str)) str += 'Z';
  const d = new Date(str);
  return isNaN(d) ? null : d;
}
function fmtLocal(s) {
  const d = parseUtc(s);
  if (!d) return String(s || '');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const month = d.toLocaleString('en-US', { month: 'short' });
  const h = d.getHours(), h12 = (h % 12) || 12, am = h >= 12 ? 'PM' : 'AM';
  const min = String(d.getMinutes()).padStart(2, '0');
  return sameYear
    ? `${month} ${d.getDate()}, ${h12}:${min} ${am}`
    : `${month} ${d.getDate()}, ${d.getFullYear()}, ${h12}:${min} ${am}`;
}
function fmtTimeOnly(s) {
  const d = parseUtc(s);
  if (!d) return '';
  const h = d.getHours(), h12 = (h % 12) || 12, am = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${am}`;
}
function dayLabel(s) {
  const d = parseUtc(s);
  if (!d) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (diff === 0) return 'Today · ' + md;
  if (diff === 1) return 'Yesterday · ' + md;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return wd + ' · ' + md + (sameYear ? '' : ', ' + d.getFullYear());
}
function dayKey(s) {
  const d = parseUtc(s);
  return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : '';
}

function parseTicketDate(s) {
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
  return isNaN(d) ? null : d;
}
function formatDateLong(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
const APP_TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

function computeSLA(t) {
  if (t.status === 'Closed')   return { text: 'Resolved', color: 'var(--text3)' };
  if (t.status === 'Archived') return { text: 'Archived', color: 'var(--text3)' };
  const due = parseTicketDate(t.due);
  if (!due) return { text: 'No due date', color: 'var(--text3)' };
  const days = Math.round((due - APP_TODAY) / 86400000);
  if (days < 0)   return { text: `Overdue by ${-days} day${-days === 1 ? '' : 's'}`, color: 'var(--red)' };
  if (days === 0) return { text: 'Due today', color: 'var(--orange)' };
  if (days <= 2)  return { text: `${days} day${days === 1 ? '' : 's'} remaining`, color: 'var(--orange)' };
  return { text: `${days} days remaining`, color: 'var(--green)' };
}

function getAssignees(t) {
  if (!t) return [];
  if (Array.isArray(t.assignees) && t.assignees.length) return t.assignees.slice();
  return t.assignee ? [t.assignee] : [];
}
function isAdmin() { return ME && ['Admin', 'Manager'].includes(ME.permRole); }

/* ── Markdown (same subset as index.html's _mdRender) ──────── */
function mdRender(text) {
  if (text == null) return '';
  let s = String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lines = s.split('\n');
  const out = [];
  let inUl = false, inOl = false, blankRun = 0;
  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) { blankRun++; closeLists(); if (blankRun === 1) out.push('<div style="height:6px"></div>'); continue; }
    blankRun = 0;
    let m;
    if ((m = line.match(/^### (.*)$/))) { closeLists(); out.push('<h3>' + m[1] + '</h3>'); continue; }
    if ((m = line.match(/^## (.*)$/)))  { closeLists(); out.push('<h2>' + m[1] + '</h2>'); continue; }
    if ((m = line.match(/^# (.*)$/)))   { closeLists(); out.push('<h1>' + m[1] + '</h1>'); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push('<li>' + m[1] + '</li>'); continue;
    }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push('<li>' + m[1] + '</li>'); continue;
    }
    closeLists();
    out.push('<div>' + line + '</div>');
  }
  closeLists();
  let html = out.join('');
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1<em>$2</em>$3')
    .replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<em>$2</em>$3')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return autoLinkHtml(html);
}
function autoLinkHtml(html) {
  const out = [];
  let i = 0, m;
  const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  while ((m = anchorRe.exec(html)) !== null) {
    out.push(autoLinkPlain(html.slice(i, m.index)));
    out.push(m[0]);
    i = m.index + m[0].length;
  }
  out.push(autoLinkPlain(html.slice(i)));
  return out.join('');
}
function autoLinkPlain(s) {
  s = s.replace(/(\bhttps?:\/\/[^\s<]+?|\bwww\.[^\s<]+?)([.,;:!?)\]]*)(?=\s|$|<)/gi, (f, url, trail) => {
    const href = url.startsWith('http') ? url : 'https://' + url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="word-break:break-all">${url}</a>${trail}`;
  });
  s = s.replace(/(\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})([.,;:!?)\]]*)(?=\s|$|<)/gi, (f, addr, trail) =>
    `<a href="mailto:${addr}">${addr}</a>${trail}`);
  return s;
}

function formatCommentText(raw) {
  const t = String(raw || '');
  if (t.startsWith('VOICENOTE::')) {
    const url = escAttr(t.slice(11));
    return `<div class="voice-note">🎤 <audio controls src="${url}"></audio> Voice note</div>`;
  }
  if (t.startsWith('SCREENRECORD::')) {
    const url = escAttr(t.slice(14));
    return `<div class="screen-note">
      <span class="sn-cap">📺 Screen recording</span>
      <video controls playsinline preload="metadata" src="${url}"></video>
      <a href="${url}" download style="font-size:10px">Download video</a>
    </div>`;
  }
  let html = mdRender(t);
  const names = TEAM.map(m => m.name).filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => b.length - a.length);
  if (names.length) {
    const pattern = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    html = html.replace(new RegExp(`@(${pattern})\\b`, 'g'), (f, name) => `<span class="mention-chip">@${name}</span>`);
  }
  return html;
}
function mentionsMe(text) {
  if (!ME || !ME.name) return false;
  const escRe = ME.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|\\s)@' + escRe + '(\\b|$)').test(String(text || ''));
}
function hasFiles(c) {
  const t = String(c.text || '');
  return (c.attachments && c.attachments.length) || t.startsWith('VOICENOTE::') || t.startsWith('SCREENRECORD::');
}

/* ── Dropdown helper ───────────────────────────────────────── */
function closeDD() { if (openDD) { openDD.remove(); openDD = null; } }
function showDD(anchor, html, opts) {
  closeDD();
  const dd = document.createElement('div');
  dd.className = 'dd';
  dd.innerHTML = html;
  document.body.appendChild(dd);
  const r = anchor.getBoundingClientRect();
  const w = dd.offsetWidth;
  let left = (r.right - w) > 10 && (opts && opts.alignRight) ? r.right - w : r.left;
  if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10;
  if (left < 10) left = 10;
  let top = r.bottom + 6;
  const h = dd.offsetHeight;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 6);
  dd.style.left = left + 'px';
  dd.style.top = top + 'px';
  openDD = dd;
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (openDD !== dd) return;
      if (dd.contains(e.target)) { document.addEventListener('click', handler, { once: true }); return; }
      closeDD();
    }, { once: true });
  }, 0);
  return dd;
}

/* ── Modal helpers ─────────────────────────────────────────── */
function openModal(id) { const el = $(id); if (el) el.classList.add('open'); }
function closeModal(id) { const el = $(id); if (el) el.classList.remove('open'); }
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closeModal(closer.getAttribute('data-close'));
  if (e.target.classList && e.target.classList.contains('md-overlay')) e.target.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.md-overlay.open').forEach(o => o.classList.remove('open'));
    $('lb-overlay').classList.remove('open');
    closeDD();
  }
});

/* ── Lightbox ──────────────────────────────────────────────── */
function openLightbox(url, name, mime) {
  const lb = $('lb-overlay');
  const safeName = String(name || (url || '').split('/').pop() || 'file');
  $('lb-title').textContent = safeName;
  const dl = $('lb-dl');
  dl.href = url; dl.setAttribute('download', safeName);
  const m = String(mime || '').toLowerCase();
  const ext = (safeName.split('.').pop() || '').toLowerCase();
  const body = $('lb-body');
  const safeUrl = escAttr(url);
  const isImage = m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext);
  const isVideo = m.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext);
  const isAudio = m.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac'].includes(ext);
  const isPdf = m === 'application/pdf' || ext === 'pdf';
  const officeExts = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
  if (isImage) body.innerHTML = `<img src="${safeUrl}" alt="${escAttr(safeName)}"/>`;
  else if (isVideo) body.innerHTML = `<video controls playsinline autoplay src="${safeUrl}"></video>`;
  else if (isAudio) body.innerHTML = `<div class="lb-fallback"><div style="font-size:40px">🎤</div><audio controls autoplay src="${safeUrl}" style="width:min(460px,80vw)"></audio></div>`;
  else if (isPdf) body.innerHTML = `<iframe src="${safeUrl}" title="${escAttr(safeName)}"></iframe>`;
  else if (officeExts.includes(ext)) {
    const abs = url.startsWith('http') ? url : (location.origin + url);
    body.innerHTML = `<iframe src="https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(abs)}" title="${escAttr(safeName)}"></iframe>`;
  } else {
    body.innerHTML = `<div class="lb-fallback"><div style="font-size:48px">📄</div>
      <div>No in-app preview for this file type.</div>
      <a href="${safeUrl}" download="${escAttr(safeName)}" class="btn-pri" style="text-decoration:none">⬇ Download ${esc(safeName)}</a></div>`;
  }
  lb.classList.add('open');
}
$('lb-x').addEventListener('click', () => $('lb-overlay').classList.remove('open'));
$('lb-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });

/* ── Recording helpers (same mime logic as index.html) ─────── */
function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return null;
}
function pickVideoMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return null;
}
function audioExtFor(mime) {
  const base = String(mime || '').split(';')[0].trim();
  return { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }[base] || 'webm';
}
async function getMicStream() {
  const savedId = localStorage.getItem('preferredMicId') || '';
  const base = { echoCancellation: true, noiseSuppression: true };
  if (savedId) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: savedId } } }); }
    catch {}
  }
  return navigator.mediaDevices.getUserMedia({ audio: base });
}
function isScreenCaptureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && typeof MediaRecorder !== 'undefined');
}

/* ── WorkTrack bridge (same localStorage protocol as index) ── */
const BRIDGE_KEY = 'worknest_bridge_v1';
function bridgeRead() {
  try { return Object.assign({ tickets: [], workTasks: [], events: [], lastEventId: 0, version: 1 }, JSON.parse(localStorage.getItem(BRIDGE_KEY) || '{}')); }
  catch { return { tickets: [], workTasks: [], events: [], lastEventId: 0, version: 1 }; }
}
function bridgeWrite(s) { try { localStorage.setItem(BRIDGE_KEY, JSON.stringify(s)); } catch {} }
function bridgeUpsertWorkTask(task) {
  const s = bridgeRead();
  const i = s.workTasks.findIndex(x => x.id === task.id);
  if (i >= 0) s.workTasks[i] = { ...s.workTasks[i], ...task };
  else s.workTasks.unshift(task);
  bridgeWrite(s);
}
function bridgeEmit(type, payload) {
  const s = bridgeRead();
  s.lastEventId = (s.lastEventId || 0) + 1;
  s.events.push({ id: s.lastEventId, type, payload, ts: Date.now() });
  if (s.events.length > 200) s.events = s.events.slice(-200);
  bridgeWrite(s);
}
function worktrackLinkFor(ticketId) {
  const s = bridgeRead();
  const task = s.workTasks.find(w => w.fromTicketId === ticketId);
  if (!task) return null;
  const status = task.status === 'started' ? 'running' : (task.status || 'pending');
  return { taskId: task.id, status };
}

/* ══════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════ */
async function boot() {
  if (!TICKET_ID) {
    $('td-boot').innerHTML = 'No ticket id in the URL. <a href="/">Back to the app</a>';
    return;
  }
  try {
    ME = await apiGet('/api/auth/me');
  } catch { return; /* api() already redirected to /login.html on 401 */ }

  try {
    const [team, depts, ticket] = await Promise.all([
      apiGet('/api/team').catch(() => []),
      apiGet('/api/departments').catch(() => ['Engineering', 'Design', 'Support', 'Operations']),
      apiGet('/api/tickets/' + encodeURIComponent(TICKET_ID)),
    ]);
    TEAM = Array.isArray(team) ? team : [];
    DEPARTMENTS = Array.isArray(depts) && depts.length ? depts : ['Engineering', 'Design', 'Support', 'Operations'];
    T = ticket;
  } catch (e) {
    $('td-boot').innerHTML = `Couldn't open <b>${esc(TICKET_ID)}</b> — ${esc(e.message)}.<br><br><a href="/">Back to the app</a>`;
    return;
  }

  document.title = T.id + ' · ' + (T.title || 'Ticket');
  $('td-boot').style.display = 'none';
  $('td-app').style.display = '';

  renderHeader();
  renderDetails();
  renderProjectBanner();
  restoreAccordions();
  restoreSideWidth();

  // Mark viewed FIRST so we capture the previous last-viewed stamp for the
  // "new since your last visit" divider (server returns it), before any
  // other client would re-stamp it.
  markViewed();

  // Parallel loads — each renders as it lands.
  loadComments();
  loadTimeline();
  loadDescription();
  loadSubtasks();
  loadAttachments();
  loadMyReminders();
  if (T.isProject) loadChildren();

  wireHeader();
  wireComposer();
  wireSidebar();
}

async function markViewed() {
  try {
    const r = await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/mark-viewed', {});
    if (r && r.previousViewedAt !== undefined) prevViewedAt = r.previousViewedAt;
  } catch {}
  // Local fallback for older server responses (no previousViewedAt field).
  if (prevViewedAt === null) {
    const k = 'td-lastseen-' + (ME ? ME.id : 0) + '-' + T.id;
    prevViewedAt = localStorage.getItem(k) || null;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try { localStorage.setItem(k, now); } catch {}
  }
  if (commentsState === 'loaded') renderConvo();
}

/* ══════════════════════════════════════════════════════════════
   HEADER
   ══════════════════════════════════════════════════════════════ */
function statusMeta(status) {
  return STATUS_OPTIONS.find(s => s.value === status) || { value: status, dot: '#94a3b8', cls: 's-oh' };
}

function renderHeader() {
  $('td-tid').textContent = '#' + T.id;
  const ttl = $('td-title');
  ttl.textContent = T.title || '(untitled)';
  ttl.title = (T.title || '') + ' — click to rename';

  const sm = statusMeta(T.status);
  const pill = $('td-status-pill');
  pill.className = 'td-status-pill ' + sm.cls;
  $('td-status-label').textContent = T.status;

  // Chips row
  const chips = [];
  const pcls = { Urgent: 'p-u', High: 'p-h', Medium: 'p-m', Low: 'p-l' }[T.priority] || 'p-m';
  chips.push(`<span class="chip ${pcls}">${esc(T.priority || 'Medium')}${T.priority === 'Urgent' || T.priority === 'High' ? ' priority' : ''}</span>`);
  chips.push(`<span class="chip">${esc(T.dept || '—')}</span>`);
  if (T.due) chips.push(`<span class="chip">Due ${esc(T.due)}</span>`);
  if (T.overdue && T.status !== 'Closed') chips.push(`<span class="chip overdue">⚠ Overdue</span>`);
  if (T.reopened) chips.push(`<span class="chip reop" title="This ticket was previously closed and reopened">↻ Reopened</span>`);
  if (T.status === 'Closed' && T.closeReason) {
    chips.push(`<span class="chip closed" title="Reason for closing">✓ <span>Closed: ${esc(T.closeReason)}</span></span>`);
  }
  const wt = worktrackLinkFor(T.id);
  if (wt) {
    chips.push(`<span class="chip wt" title="Linked WorkTrack task"><span class="live ${wt.status === 'running' ? 'pulse' : ''}" style="background:${wt.status === 'running' ? 'var(--green)' : wt.status === 'paused' ? '#3b82f6' : wt.status === 'done' ? '#16a34a' : '#94a3b8'}"></span>📤 WorkTrack · ${esc(wt.taskId)} · ${esc(wt.status)}</span>`);
  }
  if (T.sourceEmailUrl) {
    chips.push(`<a class="chip mail" href="${escAttr(T.sourceEmailUrl)}" target="_blank" rel="noopener" title="Open the original email in Gmail">✉ Open email</a>`);
  }
  if (T.snoozedUntil) {
    chips.push(`<span class="chip snz" title="Snoozed by ${escAttr(T.snoozedByName || 'someone')}">💤 Snoozed until ${esc(fmtLocal(T.snoozedUntil))}${T.snoozedByName ? ' · by ' + esc(T.snoozedByName) : ''}</span>`);
  }
  if (T.parentTicketId) {
    chips.push(`<a class="chip proj" href="/tickets/${encodeURIComponent(T.parentTicketId)}" title="Open the parent project">📁 Part of ${esc(T.parentTicketId)}</a>`);
  }
  if (T.isProject) {
    chips.push(`<span class="chip proj">📁 PROJECT · ${T.childCount || 0} sub-ticket${(T.childCount || 0) === 1 ? '' : 's'}</span>`);
  }
  $('td-chips').innerHTML = chips.join('');

  applyClosedState();
}

function applyClosedState() {
  const closed = T.status === 'Closed';
  document.getElementById('td-app').classList.toggle('is-closed', closed);
  $('td-assign-btn').setAttribute('aria-disabled', String(closed));
}

function wireHeader() {
  $('td-back').addEventListener('click', () => {
    try {
      if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
        history.back(); return;
      }
    } catch {}
    location.href = '/';
  });

  $('td-copy').addEventListener('click', async () => {
    const btn = $('td-copy');
    const done = (ok) => {
      if (!ok) { toast('Could not copy to clipboard'); return; }
      btn.classList.add('copied');
      toast('Copied ' + T.id + ' to clipboard');
      setTimeout(() => btn.classList.remove('copied'), 1400);
    };
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(T.id); done(true); return; }
      throw new Error('no clipboard api');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = T.id; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch { done(false); }
    }
  });

  $('td-title').addEventListener('click', startEditTitle);
  $('td-status-pill').addEventListener('click', (e) => { e.stopPropagation(); openStatusMenu(e.currentTarget); });
  $('td-assign-btn').addEventListener('click', (e) => { e.stopPropagation(); openAssignMenu(e.currentTarget); });
  $('td-more-btn').addEventListener('click', (e) => { e.stopPropagation(); openMoreMenu(e.currentTarget); });
}

function startEditTitle() {
  if (T.status === 'Closed') return;
  const h = $('td-title');
  if (h.style.display === 'none') return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'td-ttl-input';
  input.value = T.title || '';
  h.style.display = 'none';
  h.after(input);
  input.focus(); input.select();
  let doneOnce = false;
  const finish = async (save) => {
    if (doneOnce) return; doneOnce = true;
    const val = input.value.trim();
    if (save && val && val !== T.title) {
      try {
        await apiPut('/api/tickets/' + encodeURIComponent(T.id), { title: val });
        T.title = val;
        document.title = T.id + ' · ' + val;
        loadTimeline();
      } catch (e) { alert('Could not save title: ' + e.message); }
    }
    input.remove();
    h.style.display = '';
    renderHeader();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function openStatusMenu(anchor) {
  if (T.status === 'Closed') { toast('Reopen the ticket first (⋯ More → Reopen)'); return; }
  const html = `<div class="dd-sec">Change status</div>` + STATUS_OPTIONS.map(s => `
    <button class="mi ${s.value === T.status ? 'active' : ''}" data-status="${escAttr(s.value)}">
      <span class="sdot" style="background:${s.dot}"></span>${esc(s.value)}
      ${s.value === T.status ? '<span class="chk">✓</span>' : ''}
    </button>`).join('');
  const dd = showDD(anchor, html);
  dd.querySelectorAll('[data-status]').forEach(btn => btn.addEventListener('click', () => {
    const status = btn.getAttribute('data-status');
    closeDD();
    if (status === T.status) return;
    if (status === 'Closed') { openCloseModal(); return; }
    setStatus(status);
  }));
}

async function setStatus(status, extra) {
  const old = T.status;
  T.status = status;
  if (status !== 'Closed') { T.closeReason = ''; }
  renderHeader(); renderDetails();
  try {
    await apiPut('/api/tickets/' + encodeURIComponent(T.id), Object.assign({ status }, extra || {}));
    toast(status === 'Closed' ? T.id + ' closed' : old === 'Closed' ? T.id + ' reopened' : 'Status → ' + status);
    loadTimeline();
  } catch (e) {
    T.status = old;
    renderHeader(); renderDetails();
    alert('Could not change status: ' + e.message);
  }
}

function openAssignMenu(anchor) {
  if (T.status === 'Closed') return;
  const dd = showDD(anchor, `
    <div class="dd-sec">Assign to</div>
    <input type="text" class="dd-search" id="dd-assign-q" placeholder="Search team…" autocomplete="off"/>
    <div class="dd-scroll" id="dd-assign-list"></div>`, { alignRight: true });
  const listEl = dd.querySelector('#dd-assign-list');
  const qEl = dd.querySelector('#dd-assign-q');
  const renderList = () => {
    const q = (qEl.value || '').toLowerCase().trim();
    const assigned = new Set(getAssignees(T));
    const filtered = TEAM.filter(m => !q || m.name.toLowerCase().includes(q) || (m.role || '').toLowerCase().includes(q));
    filtered.sort((a, b) => (assigned.has(a.name) ? 0 : 1) - (assigned.has(b.name) ? 0 : 1));
    listEl.innerHTML =
      `<div style="padding:2px 11px 6px;font-size:9.5px;color:var(--text3)">${assigned.size ? assigned.size + ' assigned · click to toggle' : 'Click a name to assign'}</div>` +
      (filtered.map(m => `
        <button class="mi ${assigned.has(m.name) ? 'active' : ''}" data-name="${escAttr(m.name)}">
          ${avatarHtml(m.name, 22)}
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left">${esc(m.name)}</span>
          <span class="chk" style="color:${assigned.has(m.name) ? 'var(--accent2)' : 'transparent'}">✓</span>
        </button>`).join('') || '<div style="padding:12px;text-align:center;color:var(--text3);font-size:11px">No matches</div>');
    listEl.querySelectorAll('[data-name]').forEach(btn => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleAssignee(btn.getAttribute('data-name'));
      renderList();
    }));
  };
  qEl.addEventListener('input', renderList);
  qEl.addEventListener('click', (e) => e.stopPropagation());
  renderList();
  setTimeout(() => qEl.focus(), 30);
}

async function toggleAssignee(name) {
  const cur = getAssignees(T);
  const next = cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name];
  const prev = { assignees: T.assignees, assignee: T.assignee };
  T.assignees = next;
  T.assignee = next[0] || '';
  renderDetails();
  try {
    await apiPut('/api/tickets/' + encodeURIComponent(T.id), { assignees: next, assignee: T.assignee });
    loadTimeline();
  } catch (e) {
    Object.assign(T, prev);
    renderDetails();
    alert('Could not update assignees: ' + e.message);
  }
}

function openMoreMenu(anchor) {
  const closed = T.status === 'Closed';
  const snoozed = !!T.snoozedUntil;
  const rows = [];
  rows.push(`<button class="mi" data-act="schedule"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Schedule event <small>calendar</small></button>`);
  rows.push(`<button class="mi" data-act="remind"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>Remind me <small>email nudge</small></button>`);
  rows.push(snoozed
    ? `<button class="mi" data-act="wake"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="9 11 12 14 16 9"/></svg>Wake up <small>back to the list now</small></button>`
    : `<button class="mi" data-act="snooze"><svg viewBox="0 0 24 24"><path d="M12 22a10 10 0 1 0-10-10"/><polyline points="2 8 6 8 6 12"/><path d="M9 9h6l-6 6h6"/></svg>Snooze <small>park up to 6 days</small></button>`);
  rows.push(`<button class="mi" data-act="reqmore"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Request update <small>emails assignees</small></button>`);
  rows.push(`<button class="mi" data-act="worktrack"><svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send to WorkTrack</button>`);
  rows.push('<div class="msep"></div>');
  rows.push(closed
    ? `<button class="mi" data-act="reopen"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>Reopen ticket</button>`
    : `<button class="mi danger" data-act="close"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Close ticket…</button>`);
  rows.push(`<button class="mi danger" data-act="delete"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Delete <small>trash · 30 days</small></button>`);

  const dd = showDD(anchor, rows.join(''), { alignRight: true });
  dd.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
    const act = btn.getAttribute('data-act');
    closeDD();
    if (act === 'schedule') openScheduleModal();
    else if (act === 'remind') openRemindModal();
    else if (act === 'snooze') openSnoozeModal();
    else if (act === 'wake') unsnooze();
    else if (act === 'reqmore') requestUpdate();
    else if (act === 'worktrack') openWorkTrackModal();
    else if (act === 'close') openCloseModal();
    else if (act === 'reopen') reopenTicket();
    else if (act === 'delete') deleteTicket();
  }));
}

async function reopenTicket() {
  T.reopened = true;
  await setStatus('Open', { closeReason: '' });
}

async function deleteTicket() {
  const ok = await uiConfirm(
    `Move ${T.id} to the trash? It stays recoverable by an admin for 30 days.`,
    { title: 'Delete ticket', okText: 'Delete', danger: true }
  );
  if (!ok) return;
  try {
    await apiDel('/api/tickets/' + encodeURIComponent(T.id));
    toast(T.id + ' moved to trash');
    setTimeout(() => { location.href = '/'; }, 600);
  } catch (e) { alert('Could not delete: ' + e.message); }
}

/* ── Close modal ───────────────────────────────────────────── */
function openCloseModal() {
  $('close-reason').value = '';
  openModal('md-close');
  setTimeout(() => $('close-reason').focus(), 60);
}
$('close-go').addEventListener('click', async () => {
  const reason = $('close-reason').value.trim();
  closeModal('md-close');
  T.closeReason = reason;
  await setStatus('Closed', { closeReason: reason });
});

/* ── Snooze ────────────────────────────────────────────────── */
function localDtValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function openSnoozeModal() {
  const def = new Date(); def.setDate(def.getDate() + 1); def.setHours(9, 0, 0, 0);
  $('snooze-until').value = localDtValue(def);
  const presets = [];
  const mk = (label, d) => presets.push({ label, d });
  const t9 = (days) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d; };
  const eod = new Date(); eod.setHours(17, 0, 0, 0);
  if (eod > new Date()) mk('Later today 5pm', eod);
  mk('Tomorrow 9am', t9(1));
  mk('In 2 days', t9(2));
  mk('In 3 days', t9(3));
  mk('In 6 days', t9(6));
  $('snooze-presets').innerHTML = presets.map((p, i) =>
    `<button data-i="${i}">${esc(p.label)}</button>`).join('');
  $('snooze-presets').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    $('snooze-until').value = localDtValue(presets[Number(b.dataset.i)].d);
    $('snooze-presets').querySelectorAll('button').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
  }));
  $('snooze-err').style.display = 'none';
  openModal('md-snooze');
}
$('snooze-go').addEventListener('click', async () => {
  const err = $('snooze-err');
  const val = $('snooze-until').value;
  const d = val ? new Date(val) : null;
  const fail = (msg) => { err.textContent = msg; err.style.display = 'block'; };
  if (!d || isNaN(d)) return fail('Pick a wake-up time first.');
  if (d.getTime() <= Date.now() + 60000) return fail('Wake-up time must be in the future.');
  if (d.getTime() > Date.now() + 6 * 86400000) return fail('Snooze max is 6 days.');
  try {
    const fresh = await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/snooze', { until: d.toISOString() });
    if (fresh && fresh.id) T = fresh;
    closeModal('md-snooze');
    renderHeader(); renderDetails();
    toast('Snoozed until ' + fmtLocal(T.snoozedUntil));
  } catch (e) { fail(e.message); }
});
async function unsnooze() {
  try {
    await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/unsnooze', {});
    T.snoozedUntil = null; T.snoozedBy = null; T.snoozedByName = null;
    renderHeader();
    toast('Ticket is back in the list');
  } catch (e) { alert(e.message); }
}

/* ── Remind me (personal email reminders on this ticket) ───── */
function openRemindModal() {
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  $('tkrem-when').value = localDtValue(d);
  $('tkrem-note').value = '';
  openModal('md-remind');
  loadTicketReminders();
}
async function loadTicketReminders() {
  const list = $('tkrem-list');
  list.innerHTML = '<div class="rem-empty">Loading…</div>';
  try {
    TICKET_REMINDERS = await apiGet('/api/tickets/' + encodeURIComponent(T.id) + '/reminders');
    if (!TICKET_REMINDERS.length) { list.innerHTML = '<div class="rem-empty">No reminders set yet.</div>'; return; }
    list.innerHTML = TICKET_REMINDERS.map(r => `
      <div class="rem">
        <div style="flex:1;min-width:0">
          <div class="rem-title">🔔 ${esc(fmtLocal(r.remindAt))} <span style="color:var(--text3)">(${r.sent ? 'sent' : 'pending'})</span></div>
          ${r.note ? `<div class="rem-sub">${esc(r.note)}</div>` : ''}
        </div>
        ${r.sent ? '' : `<button class="rem-btn" data-cancel="${r.id}">Cancel</button>`}
      </div>`).join('');
    list.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      try { await apiDel('/api/reminders/' + b.getAttribute('data-cancel')); loadTicketReminders(); }
      catch (e) { alert('Could not cancel: ' + e.message); }
    }));
  } catch { list.innerHTML = '<div class="rem-empty" style="color:var(--red)">Could not load reminders.</div>'; }
}
$('tkrem-add').addEventListener('click', async () => {
  const when = $('tkrem-when').value;
  const note = $('tkrem-note').value.trim();
  const d = when ? new Date(when) : null;
  if (!d || isNaN(d)) { alert('Pick a date/time first.'); return; }
  if (d.getTime() < Date.now() - 60000) { alert('That time is in the past. Pick a future moment.'); return; }
  try {
    await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/reminders', { remindAt: d.toISOString(), note });
    $('tkrem-note').value = '';
    loadTicketReminders();
    toast('Reminder scheduled');
  } catch (e) { alert('Could not set reminder: ' + e.message); }
});

/* ── Request update ────────────────────────────────────────── */
async function requestUpdate() {
  const note = await uiPrompt(
    'Ask the assignees for an update on this ticket. Optional note (appears in the email — leave blank to just ask):',
    { title: 'Request update', okText: 'Send' }
  );
  if (note === null) return;
  try {
    const data = await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/request-update', { note: note || '' });
    const names = (data.notified || []).join(', ');
    toast(names ? 'Asked for update from ' + names : 'Update request sent');
    loadTimeline();
  } catch (e) { alert(e.message); }
}

/* ── Schedule calendar event ───────────────────────────────── */
let evAttendees = new Set();
function openScheduleModal() {
  $('ev-title').value = 'Sync on ' + T.id;
  $('ev-type').value = 'meeting';
  const due = parseTicketDate(T.due) || new Date();
  const base = due < APP_TODAY ? new Date() : due;
  const pad = (n) => String(n).padStart(2, '0');
  $('ev-date').value = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  $('ev-start').value = '10:00';
  $('ev-end').value = '10:30';
  $('ev-location').value = '';
  $('ev-desc').value = '';
  evAttendees = new Set(getAssignees(T).filter(n => TEAM.some(m => m.name === n)));
  if (ME) evAttendees.add(ME.name);
  renderEvAttendees();
  openModal('md-event');
}
function renderEvAttendees() {
  $('ev-att-picker').innerHTML = TEAM.map(m =>
    `<button type="button" class="${evAttendees.has(m.name) ? 'sel' : ''}" data-n="${escAttr(m.name)}">${esc(m.name)}</button>`).join('');
  $('ev-att-picker').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const n = b.getAttribute('data-n');
    if (evAttendees.has(n)) evAttendees.delete(n); else evAttendees.add(n);
    renderEvAttendees();
  }));
}
$('ev-go').addEventListener('click', async () => {
  const title = $('ev-title').value.trim();
  if (!title) { alert('Give the event a title.'); return; }
  const dateVal = $('ev-date').value;
  if (!dateVal) { alert('Pick a date.'); return; }
  const [y, mo, dd] = dateVal.split('-').map(Number);
  // NOTE: the in-app calendar stores date_key with a 0-indexed month
  // ("2026-6-14" = Jul 14 2026) — match that convention exactly.
  const dateKey = `${y}-${mo - 1}-${dd}`;
  try {
    await apiPost('/api/events', {
      dateKey,
      type: $('ev-type').value,
      title,
      label: title,
      desc: $('ev-desc').value.trim(),
      allDay: false,
      startTime: $('ev-start').value || '',
      endTime: $('ev-end').value || '',
      linkedTicketId: T.id,
      attendees: Array.from(evAttendees),
      location: $('ev-location').value.trim(),
    });
    closeModal('md-event');
    toast('Event created on the calendar');
    apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/timeline', {
      dot: '#0ea5e9', text: `${ME.name} scheduled "${title}" on the calendar`,
    }).then(loadTimeline).catch(() => {});
  } catch (e) { alert('Could not create event: ' + e.message); }
});

/* ── Send to WorkTrack ─────────────────────────────────────── */
function openWorkTrackModal() {
  const existing = worktrackLinkFor(T.id);
  const proceed = () => {
    $('swt-info').innerHTML = `<strong style="color:var(--accent2)">${esc(T.id)}</strong> — ${esc(T.title)}<br>
      <span style="color:var(--text3);font-size:10.5px">${esc(T.priority)} priority · ${esc(T.dept)} · Due ${esc(T.due || '—')}</span>`;
    const sel = $('swt-worker');
    sel.innerHTML = TEAM.map(m => `<option value="${escAttr(m.name)}">${esc(m.name)} — ${esc(m.dept || 'General')}</option>`).join('');
    const match = TEAM.find(m => m.name === T.assignee);
    if (match) sel.value = match.name;
    $('swt-estimate').value = '';
    $('swt-notes').value = '';
    openModal('md-worktrack');
  };
  if (existing) {
    uiConfirm(`This ticket is already linked to WorkTrack task ${existing.taskId}. Send another?`).then(ok => { if (ok) proceed(); });
  } else proceed();
}
$('swt-go').addEventListener('click', async () => {
  const worker = $('swt-worker').value;
  if (!worker) { alert('Please select a worker.'); return; }
  const estimate = $('swt-estimate').value.trim();
  const notes = $('swt-notes').value.trim();
  const workTaskId = 'WT-' + Date.now().toString().slice(-6);
  bridgeUpsertWorkTask({
    id: workTaskId, name: T.title, description: DETAILS.description || '',
    type: 'onetime', assignee: worker, estimatedTime: estimate, instructions: notes,
    fromTicketId: T.id, status: 'pending', createdAt: Date.now(),
    createdBy: ME.name, todayHours: 0,
  });
  bridgeEmit('ticket.send_to_worktrack', { ticketId: T.id, workTaskId, worker, title: T.title, estimate, notes });
  closeModal('md-worktrack');
  renderHeader();
  toast(`Sent to WorkTrack as ${workTaskId} — ${worker} will see it in their queue`);
  apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/timeline', {
    dot: '#0ea5e9', text: `${ME.name} sent the ticket to WorkTrack as ${workTaskId} — assigned to ${worker}`,
  }).then(loadTimeline).catch(() => {});
});
// Live WorkTrack chip: watch the bridge for status flips from the Work app.
window.addEventListener('storage', (e) => { if (e.key === BRIDGE_KEY && T) renderHeader(); });
setInterval(() => { if (T && worktrackLinkFor(T.id)) renderHeader(); }, 5000);

/* ══════════════════════════════════════════════════════════════
   PROJECT BANNER + SUB-TICKETS
   ══════════════════════════════════════════════════════════════ */
function renderProjectBanner() {
  const el = $('td-project-banner');
  const admin = isAdmin();
  if (T.parentTicketId) {
    el.className = 'proj-banner is-child';
    el.style.display = '';
    el.innerHTML = `📁 Part of project: <a href="/tickets/${encodeURIComponent(T.parentTicketId)}">${esc(T.parentTicketId)}</a>`;
    return;
  }
  if (T.isProject) {
    el.className = 'proj-banner is-proj';
    el.style.display = '';
    el.innerHTML = `
      <span class="pb-badge">PROJECT · ${T.childCount || 0}</span>
      <span>Sub-tickets are listed in the sidebar.</span>
      <button class="cta" id="pb-add-sub">+ Add sub-ticket</button>
      ${admin ? '<button class="cta sec" id="pb-demote">Disconnect project</button>' : ''}`;
    $('pb-add-sub').addEventListener('click', openSubticketModal);
    const dem = $('pb-demote');
    if (dem) dem.addEventListener('click', async () => {
      if (!await uiConfirm('Disconnect this project? Its sub-tickets become regular tickets again.')) return;
      try {
        await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/demote', {});
        T.isProject = false; T.childCount = 0;
        $('acc-children').style.display = 'none';
        renderHeader(); renderProjectBanner();
        toast('Project disconnected');
      } catch (e) { alert(e.message); }
    });
    $('acc-children').style.display = '';
    return;
  }
  if (admin) {
    el.className = 'proj-banner hint';
    el.style.display = '';
    el.innerHTML = `Need to break this into multiple sub-tickets?
      <button class="cta" id="pb-promote">Convert to Project</button>`;
    $('pb-promote').addEventListener('click', async () => {
      try {
        await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/promote', {});
        T.isProject = true; T.childCount = 0;
        renderHeader(); renderProjectBanner(); loadChildren();
        toast(T.id + ' is now a project');
      } catch (e) { alert(e.message); }
    });
  } else {
    el.style.display = 'none';
  }
}

async function loadChildren() {
  $('acc-children').style.display = '';
  try { CHILDREN = await apiGet('/api/tickets/' + encodeURIComponent(T.id) + '/children'); }
  catch { CHILDREN = []; }
  renderChildren();
}
function renderChildren() {
  $('child-count').textContent = CHILDREN.length;
  const el = $('child-list');
  if (!CHILDREN.length) { el.innerHTML = '<div class="child-empty">No sub-tickets yet.</div>'; return; }
  el.innerHTML = CHILDREN.map(c => {
    const sm = statusMeta(c.status);
    return `<div class="child" data-id="${escAttr(c.id)}">
      <span class="child-id">${esc(c.id)}</span>
      <span class="child-title">${esc(c.title)}</span>
      <span class="child-status" style="background:${sm.dot}22;color:${sm.dot}">${esc(c.status)}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.child').forEach(row => row.addEventListener('click', () => {
    location.href = '/tickets/' + encodeURIComponent(row.getAttribute('data-id'));
  }));
}
function openSubticketModal() {
  $('sk-title').value = '';
  $('sk-due').value = '';
  $('sk-priority').value = 'Medium';
  $('sk-assignee').innerHTML = '<option value="">— unassigned —</option>' +
    TEAM.map(m => `<option value="${escAttr(m.name)}">${esc(m.name)}</option>`).join('');
  openModal('md-subticket');
  setTimeout(() => $('sk-title').focus(), 60);
}
$('child-add-btn').addEventListener('click', openSubticketModal);
$('sk-go').addEventListener('click', async () => {
  const title = $('sk-title').value.trim();
  if (!title) { alert('Give the sub-ticket a title.'); return; }
  const dueRaw = $('sk-due').value;
  const due = dueRaw ? formatDateLong(parseTicketDate(dueRaw)) : '';
  const assignee = $('sk-assignee').value;
  try {
    await apiPost('/api/tickets', {
      title,
      parentTicketId: T.id,
      priority: $('sk-priority').value,
      due,
      assignee,
      assignees: assignee ? [assignee] : [],
      req: ME.name,
      reporter: ME.name,
      dept: T.dept,
      created: formatDateLong(new Date()),
      tags: [],
    });
    closeModal('md-subticket');
    T.childCount = (T.childCount || 0) + 1;
    renderHeader(); renderProjectBanner(); loadChildren();
    toast('Sub-ticket created');
  } catch (e) { alert('Could not create sub-ticket: ' + e.message); }
});

/* ══════════════════════════════════════════════════════════════
   DETAILS (sidebar card)
   ══════════════════════════════════════════════════════════════ */
function renderDetails() {
  const body = $('details-body');
  if (editAllMode) { renderDetailsEdit(body); return; }
  const sla = computeSLA(T);
  const asg = getAssignees(T);
  const rows = [];
  const row = (label, valueHtml, editKey) => rows.push(`
    <div class="prop" ${editKey ? `data-prop="${editKey}"` : ''}>
      <span class="plabel">${label}</span>
      <span class="pval">${valueHtml}</span>
      ${editKey && T.status !== 'Closed' ? `<button class="pedit" data-edit="${editKey}" title="Edit ${label.toLowerCase()}">✎</button>` : ''}
    </div>`);
  const person = (name, fallback) => name
    ? `${avatarHtml(name, 17)}<span>${esc(name)}</span>`
    : `<span style="color:var(--text3)">${fallback || '—'}</span>`;

  row('Requester', person(T.req, '—'), 'req');
  row(asg.length > 1 ? 'Assignees' : 'Assignee',
    asg.length
      ? asg.map(n => `<span class="asgn">${avatarHtml(n, 17)}${esc(n)}</span>`).join('')
      : '<span style="color:var(--text3)">Unassigned</span>',
    'assignees');
  row('Reporter', person(T.reporter || '', '—'), 'reporter');
  const pcls = { Urgent: 'p-u', High: 'p-h', Medium: 'p-m', Low: 'p-l' }[T.priority] || 'p-m';
  row('Priority', `<span class="chip ${pcls}" style="font-size:9.5px">${esc(T.priority || '—')}</span>`, 'priority');
  row('Due date', `<span style="color:${sla.color === 'var(--red)' ? 'var(--red)' : 'inherit'}">${esc(T.due || '—')}</span>`, 'due');
  row('Department', esc(T.dept || '—'), 'dept');
  row('SLA', `<span style="color:${sla.color};font-weight:700">${sla.text}</span>`);
  row('Created', `<span style="color:var(--text2)">${esc(T.created || (T.created_at ? fmtLocal(T.created_at) : '—'))}</span>`);
  row('Tags',
    (T.tags && T.tags.length)
      ? T.tags.map(tag => `<span class="tagc">${esc(tag)}</span>`).join('')
      : '<span style="color:var(--text3)">—</span>',
    'tags');

  // Flavor links (three legacy variants — show whichever is set)
  if (T.flavor_v2_id) {
    row('🧪 Flavor', `<span class="flavor-pill">🍯 ${esc(T.flavor_v2_name || ('Flavor #' + T.flavor_v2_id))}</span>
      <a class="linkish" href="/flavors.html#${encodeURIComponent(T.flavor_v2_id)}">Open flavor ↗</a>`);
  } else if (T.syruvia_flavor_id) {
    const su = window.__SYRUVIA_URL__ || '';
    row('Flavor', `<span class="flavor-pill">🍯 ${esc(T.syruvia_flavor_name || T.syruvia_flavor_id)}</span>` +
      (su ? `<a class="linkish" href="${escAttr(su)}?flavor=${encodeURIComponent(T.syruvia_flavor_id)}" target="_blank" rel="noopener noreferrer">Open in Syruvia ↗</a>` : ''));
  } else if (T.fr_flavor_id) {
    row('💬 Flavor', `<span class="flavor-pill">🍯 ${esc(T.fr_flavor_name || ('Flavor #' + T.fr_flavor_id))}</span>
      <a class="linkish" href="/flavor-reviews.html#/flavor/${Number(T.fr_flavor_id)}">View all reviews →</a>`);
  }

  body.innerHTML = rows.join('');
  body.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    startFieldEdit(btn.getAttribute('data-edit'), btn.closest('.prop'));
  }));
}

function teamOptions(current) {
  return TEAM.map(m => `<option value="${escAttr(m.name)}" ${m.name === current ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
}
function priorityOptions(current) {
  return ['Urgent', 'High', 'Medium', 'Low'].map(p => `<option ${p === current ? 'selected' : ''}>${p}</option>`).join('');
}
function deptOptions(current) {
  const list = DEPARTMENTS.includes(current) || !current ? DEPARTMENTS : [current, ...DEPARTMENTS];
  return list.map(d => `<option ${d === current ? 'selected' : ''}>${esc(d)}</option>`).join('');
}

/* Single-field quick edit (hover pencil) */
function startFieldEdit(key, rowEl) {
  if (key === 'assignees') { openAssignMenu(rowEl); return; }
  const val = rowEl.querySelector('.pval');
  const actions = `<span class="edit-actions"><button class="ok" title="Save">✓</button><button class="no" title="Cancel">×</button></span>`;
  let editor = '';
  if (key === 'req') editor = `<select class="inline-edit" id="fe-input">${teamOptions(T.req)}</select>`;
  else if (key === 'reporter') editor = `<select class="inline-edit" id="fe-input">${teamOptions(T.reporter || ME.name)}</select>`;
  else if (key === 'priority') editor = `<select class="inline-edit" id="fe-input">${priorityOptions(T.priority)}</select>`;
  else if (key === 'dept') editor = `<select class="inline-edit" id="fe-input">${deptOptions(T.dept)}</select>`;
  else if (key === 'due') {
    const d = parseTicketDate(T.due);
    const iso = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
    editor = `<input type="date" class="inline-edit" id="fe-input" value="${iso}"/>`;
  } else if (key === 'tags') {
    pendingTags = (T.tags || []).slice();
    val.innerHTML = `<span id="fe-tag-chips" style="display:inline-flex;gap:4px;flex-wrap:wrap"></span>
      <input type="text" class="tags-input" id="fe-input" placeholder="add tag + Enter"/>` ;
    rowEl.querySelector('.pedit').outerHTML = actions;
    renderTagChips('fe-tag-chips');
    wireTagInput($('fe-input'), 'fe-tag-chips');
    wireFieldEditActions(rowEl, key);
    $('fe-input').focus();
    return;
  }
  val.innerHTML = editor;
  const pedit = rowEl.querySelector('.pedit');
  if (pedit) pedit.outerHTML = actions;
  wireFieldEditActions(rowEl, key);
  const inp = $('fe-input');
  if (inp) inp.focus();
}
function wireFieldEditActions(rowEl, key) {
  rowEl.querySelector('.edit-actions .ok').addEventListener('click', async () => {
    const patch = {};
    if (key === 'tags') {
      const inp = $('fe-input');
      if (inp && inp.value.trim()) addPendingTag(inp.value, 'fe-tag-chips');
      patch.tags = pendingTags.slice();
    } else {
      const v = $('fe-input') ? $('fe-input').value : '';
      if (key === 'due') {
        const d = parseTicketDate(v);
        patch.due = d ? formatDateLong(d) : '';
        patch.overdue = d ? d < APP_TODAY : false;
      } else patch[key] = v;
    }
    await saveTicketPatch(patch);
    renderDetails(); renderHeader();
  });
  rowEl.querySelector('.edit-actions .no').addEventListener('click', () => renderDetails());
}

async function saveTicketPatch(patch) {
  const before = JSON.parse(JSON.stringify({
    req: T.req, reporter: T.reporter, priority: T.priority, dept: T.dept,
    due: T.due, tags: T.tags, overdue: T.overdue,
  }));
  Object.assign(T, patch);
  try {
    await apiPut('/api/tickets/' + encodeURIComponent(T.id), patch);
    loadTimeline();
  } catch (e) {
    Object.assign(T, before);
    alert('Could not save: ' + e.message);
  }
}

/* Edit-all mode */
$('details-edit-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const acc = $('acc-details');
  if (!acc.classList.contains('open')) acc.classList.add('open');
  editAllMode = true;
  pendingTags = (T.tags || []).slice();
  pendingAssignees = getAssignees(T);
  renderDetails();
});
function renderDetailsEdit(body) {
  body.innerHTML = `
    <div class="prop"><span class="plabel">Requester</span><span class="pval"><select class="inline-edit" id="ea-req">${teamOptions(T.req)}</select></span></div>
    <div class="prop"><span class="plabel">Assignees</span><span class="pval" id="ea-asg-chips" style="gap:4px"></span></div>
    <div class="prop"><span class="plabel">Reporter</span><span class="pval"><select class="inline-edit" id="ea-rep">${teamOptions(T.reporter || ME.name)}</select></span></div>
    <div class="prop"><span class="plabel">Priority</span><span class="pval"><select class="inline-edit" id="ea-pri">${priorityOptions(T.priority)}</select></span></div>
    <div class="prop"><span class="plabel">Due date</span><span class="pval"><input type="date" class="inline-edit" id="ea-due" value="${(() => { const d = parseTicketDate(T.due); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; })()}"/></span></div>
    <div class="prop"><span class="plabel">Department</span><span class="pval"><select class="inline-edit" id="ea-dept">${deptOptions(T.dept)}</select></span></div>
    <div class="prop"><span class="plabel">SLA</span><span class="pval" style="color:var(--text3);font-style:italic">Auto-computed from due date</span></div>
    <div class="prop"><span class="plabel">Tags</span><span class="pval" style="gap:4px">
      <span id="ea-tag-chips" style="display:inline-flex;gap:4px;flex-wrap:wrap"></span>
      <input type="text" class="tags-input" id="ea-tag-input" placeholder="add tag + Enter"/>
    </span></div>
    <div class="row-end">
      <button class="btn-sec" id="ea-cancel">Cancel</button>
      <button class="btn-pri" id="ea-save">Save all</button>
    </div>`;
  renderTagChips('ea-tag-chips');
  wireTagInput($('ea-tag-input'), 'ea-tag-chips');
  renderEaAssignees();
  $('ea-cancel').addEventListener('click', () => { editAllMode = false; renderDetails(); });
  $('ea-save').addEventListener('click', async () => {
    const inp = $('ea-tag-input');
    if (inp && inp.value.trim()) addPendingTag(inp.value, 'ea-tag-chips');
    const dueRaw = $('ea-due').value;
    const d = parseTicketDate(dueRaw);
    const patch = {
      req: $('ea-req').value,
      reporter: $('ea-rep').value,
      priority: $('ea-pri').value,
      dept: $('ea-dept').value,
      tags: pendingTags.slice(),
      assignees: pendingAssignees.slice(),
      assignee: pendingAssignees[0] || '',
    };
    if (d) { patch.due = formatDateLong(d); patch.overdue = d < APP_TODAY; }
    editAllMode = false;
    T.assignees = patch.assignees; T.assignee = patch.assignee;
    await saveTicketPatch(patch);
    renderDetails(); renderHeader();
    toast('Details saved');
  });
}
function renderEaAssignees() {
  const wrap = $('ea-asg-chips');
  if (!wrap) return;
  wrap.innerHTML = pendingAssignees.map((n, i) =>
    `<span class="asgn">${avatarHtml(n, 17)}${esc(n)}<button class="rm" data-i="${i}" title="Remove">×</button></span>`).join('') +
    `<button class="rem-btn" id="ea-asg-add">+ Add</button>`;
  wrap.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => {
    pendingAssignees.splice(Number(b.dataset.i), 1);
    renderEaAssignees();
  }));
  $('ea-asg-add').addEventListener('click', (e) => {
    e.stopPropagation();
    const remaining = TEAM.filter(m => !pendingAssignees.includes(m.name));
    const dd = showDD(e.currentTarget, `<div class="dd-scroll">` + (remaining.map(m =>
      `<button class="mi" data-n="${escAttr(m.name)}">${avatarHtml(m.name, 20)}${esc(m.name)}</button>`).join('') ||
      '<div style="padding:10px;color:var(--text3);font-size:11px">Everyone is assigned</div>') + `</div>`);
    dd.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', () => {
      pendingAssignees.push(b.getAttribute('data-n'));
      closeDD();
      renderEaAssignees();
    }));
  });
}

/* Tags editing helpers */
function renderTagChips(containerId) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = pendingTags.map((t, i) =>
    `<span class="tagc">${esc(t)}<button class="rm" data-i="${i}" aria-label="Remove tag">×</button></span>`).join('');
  el.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => {
    pendingTags.splice(Number(b.dataset.i), 1);
    renderTagChips(containerId);
  }));
}
function addPendingTag(raw, containerId) {
  const tag = String(raw || '').trim().replace(/^#+/, '').replace(/,+$/, '');
  if (!tag) return;
  if (pendingTags.some(x => x.toLowerCase() === tag.toLowerCase())) return;
  if (pendingTags.length >= 8) { toast('Max 8 tags'); return; }
  pendingTags.push(tag);
  renderTagChips(containerId);
}
function wireTagInput(input, containerId) {
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addPendingTag(input.value, containerId);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && pendingTags.length) {
      pendingTags.pop();
      renderTagChips(containerId);
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   DESCRIPTION
   ══════════════════════════════════════════════════════════════ */
async function loadDescription() {
  descState = 'loading';
  renderDescription();
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const det = await apiGet('/api/tickets/' + encodeURIComponent(T.id) + '/details');
      DETAILS.description = (det && det.description) || '';
      DETAILS.checklist = (det && det.checklist) || [];
      descState = 'loaded';
      renderDescription();
      return;
    } catch {
      if (attempt === 2) { descState = 'error'; renderDescription(); return; }
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}
function renderDescription() {
  const view = $('desc-view');
  view.classList.remove('muted');
  if (descState === 'loading') { view.classList.add('muted'); view.textContent = 'Loading description…'; }
  else if (descState === 'error') {
    view.innerHTML = '<span style="color:var(--red)">Couldn’t load description.</span> <a class="linkish" id="desc-retry">Retry</a>';
    $('desc-retry').addEventListener('click', loadDescription);
  } else if (DETAILS.description && DETAILS.description.trim()) {
    view.innerHTML = mdRender(DETAILS.description);
  } else {
    view.classList.add('muted');
    view.textContent = 'No description yet — click ✎ to add one.';
  }
  view.style.display = '';
  $('desc-edit').style.display = 'none';
}
$('desc-edit-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const acc = $('acc-desc');
  if (!acc.classList.contains('open')) acc.classList.add('open');
  $('desc-view').style.display = 'none';
  $('desc-edit').style.display = '';
  $('desc-textarea').value = DETAILS.description || '';
  setTimeout(() => $('desc-textarea').focus(), 40);
});
$('desc-cancel').addEventListener('click', renderDescription);
$('desc-save').addEventListener('click', async () => {
  const next = $('desc-textarea').value;
  if (next !== DETAILS.description) {
    DETAILS.description = next;
    try {
      await apiPut('/api/tickets/' + encodeURIComponent(T.id) + '/details', DETAILS);
      loadTimeline();
    } catch (e) { alert('Could not save description: ' + e.message); }
  }
  renderDescription();
});

/* ══════════════════════════════════════════════════════════════
   COMMENTS + CONVERSATION
   ══════════════════════════════════════════════════════════════ */
async function loadComments(retries) {
  if (typeof retries !== 'number') retries = 2;
  try {
    const cmts = await apiGet('/api/tickets/' + encodeURIComponent(T.id) + '/comments');
    COMMENTS = Array.isArray(cmts) ? cmts : [];
    commentsState = 'loaded';
    renderConvo();
  } catch (e) {
    if (retries > 0) { setTimeout(() => loadComments(retries - 1), 1500); return; }
    commentsState = 'error';
    renderConvo();
  }
}
async function loadTimeline() {
  try {
    const rows = await apiGet('/api/tickets/' + encodeURIComponent(T.id) + '/timeline');
    // Server returns newest-first; keep oldest-first for the conversation.
    TIMELINE = (Array.isArray(rows) ? rows : []).slice().reverse();
  } catch { TIMELINE = []; }
  // Derive the "Reopened" chip from the audit log so it survives page
  // refreshes (there's no reopened column — the log is the source of truth).
  if (!T.reopened && T.status !== 'Closed' && TIMELINE.some(a => / reopened the ticket/.test(a.text || ''))) {
    T.reopened = true;
    renderHeader();
  }
  renderTimelineAcc();
  if (commentsState === 'loaded') renderConvo();
}
function renderTimelineAcc() {
  $('tl-count').textContent = TIMELINE.length;
  const el = $('tl-list');
  if (!TIMELINE.length) { el.innerHTML = '<div class="att-empty">No activity yet.</div>'; return; }
  el.innerHTML = TIMELINE.slice().reverse().map(a => `
    <div class="tl-item">
      <span class="tl-dot" style="background:${escAttr(a.dot || 'var(--accent2)')}"></span>
      <div class="tl-text">${esc(a.text)}</div>
      <div class="tl-sub">${esc(a.createdAt ? fmtLocal(a.createdAt) : (a.sub || ''))}</div>
    </div>`).join('');
}

function filterCounts() {
  let mentions = 0, files = 0;
  for (const c of COMMENTS) {
    if (mentionsMe(c.text)) mentions++;
    if (hasFiles(c)) files++;
  }
  return { mentions, files };
}

function renderConvo() {
  const el = $('td-convo');
  $('cmt-count').textContent = COMMENTS.length;
  const counts = filterCounts();
  $('filt-mentions-n').textContent = counts.mentions || '';
  $('filt-files-n').textContent = counts.files || '';

  if (commentsState === 'loading') { el.innerHTML = '<div class="td-convo-loading">Loading conversation…</div>'; return; }
  if (commentsState === 'error') {
    el.innerHTML = '<div class="td-convo-error">Couldn’t load comments. <a id="cmt-retry">Retry</a></div>';
    $('cmt-retry').addEventListener('click', () => { commentsState = 'loading'; renderConvo(); loadComments(2); });
    return;
  }

  // Build the parent → children map (same threading rules as the old page).
  const childrenOf = {};
  const tops = [];
  for (const c of COMMENTS) {
    const p = c.parentId || null;
    if (p && COMMENTS.some(x => x.id === p)) (childrenOf[p] = childrenOf[p] || []).push(c);
    else tops.push(c);
  }

  // Which top-level blocks survive the active filter? A block matches when
  // the parent or ANY reply in its thread matches.
  const threadMatches = (c) => {
    const all = [c, ...collectReplies(c, childrenOf)];
    if (convoFilter === 'mentions') return all.some(x => mentionsMe(x.text));
    if (convoFilter === 'files') return all.some(hasFiles);
    return true;
  };
  const visibleTops = tops.filter(threadMatches);

  // Merge stream: comments + (optionally) activity events, oldest-first.
  const showActivity = $('convo-activity-toggle').checked && convoFilter === 'all';
  const stream = [];
  for (const c of visibleTops) stream.push({ kind: 'comment', at: c.createdAt || '', c });
  if (showActivity) {
    for (const a of TIMELINE) {
      if (!a.text) continue;
      if (/ commented( \(reply\))?$/.test(a.text)) continue; // comment itself is already in the stream
      stream.push({ kind: 'event', at: a.createdAt || '', a });
    }
  }
  stream.sort((x, y) => String(x.at).localeCompare(String(y.at)));

  if (!stream.length) {
    el.innerHTML = `<div class="td-convo-empty">${convoFilter === 'all' ? 'No comments yet. Start the conversation below.' : 'Nothing matches this filter.'}</div>`;
    return;
  }

  const parts = [];
  let lastDay = '';
  let newMarkerPlaced = false;
  const isNew = (c) => prevViewedAt && c.createdAt && String(c.createdAt) > String(prevViewedAt) && c.author !== (ME && ME.name);
  for (const item of stream) {
    const dk = dayKey(item.at);
    if (dk && dk !== lastDay) {
      parts.push(`<div class="day-div"><span>${esc(dayLabel(item.at))}</span></div>`);
      lastDay = dk;
    }
    if (!newMarkerPlaced && item.kind === 'comment' && isNew(item.c)) {
      parts.push('<div class="new-div"><span>● new since your last visit</span></div>');
      newMarkerPlaced = true;
    }
    if (item.kind === 'event') {
      parts.push(`<div class="evt"><span class="edot" style="background:${escAttr(item.a.dot || 'var(--accent2)')}"></span>
        <span class="etext">${esc(item.a.text)} · ${esc(fmtTimeOnly(item.a.createdAt) || item.a.sub || '')}</span></div>`);
    } else {
      parts.push(renderCommentBlock(item.c, childrenOf));
    }
  }
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  el.innerHTML = parts.join('');
  wireConvoEvents(el);
  if (nearBottom || !el.dataset.scrolledOnce) {
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    el.dataset.scrolledOnce = '1';
  }
}
function collectReplies(c, childrenOf) {
  const out = [];
  for (const r of (childrenOf[c.id] || [])) { out.push(r, ...collectReplies(r, childrenOf)); }
  return out;
}

function renderCommentBlock(c, childrenOf) {
  return `<div class="cmt-block">${renderOneComment(c, 0, null, childrenOf)}</div>`;
}
function renderOneComment(c, depth, parent, childrenOf) {
  const replies = childrenOf[c.id] || [];
  const expanded = expandedThreads.has(c.id);
  const shouldCollapse = replies.length >= CMT_COLLAPSE_AT && !expanded;
  const visible = shouldCollapse ? replies.slice(-CMT_VISIBLE_REPLIES_DEFAULT) : replies;
  const hidden = replies.length - visible.length;

  const mine = ME && c.author === ME.name;
  const canDelete = !!c.id && (isAdmin() || mine);
  const meMention = mentionsMe(c.text) && !mine && !!c.id;

  const acts = [];
  if (c.id && T.status !== 'Closed') acts.push(`<button class="cmt-act" data-reply="${c.id}">↩ Reply</button>`);
  if (meMention) acts.push(`<button class="cmt-act" data-noreply="${c.id}">✓ No reply needed</button>`);
  if (canDelete) acts.push(`<button class="cmt-act del" data-delcmt="${c.id}">🗑 Delete</button>`);

  const attsHtml = (c.attachments && c.attachments.length)
    ? `<div class="cmt-atts">${c.attachments.map(renderCommentAttachment).join('')}</div>` : '';

  const replyTo = parent ? `<span class="replyto" title="Reply to ${escAttr(parent.author)}">↩ ${esc(parent.author)}</span>` : '';
  const showMore = shouldCollapse
    ? `<button class="show-more" data-expand="${c.id}">▾ View ${hidden} earlier ${hidden === 1 ? 'reply' : 'replies'}</button>` : '';

  const bubble = `
    <div class="cmt">
      ${avatarHtml(c.author, depth > 0 ? 24 : 30, c.bg, c.col)}
      <div class="bubble ${mine ? 'mine' : ''}">
        <div class="cmt-head">
          <span class="cmt-name">${esc(c.author)}</span>
          <span class="cmt-time">${esc(c.createdAt ? fmtTimeOnly(c.createdAt) : (c.time || ''))}</span>
          ${replyTo}
        </div>
        <div class="cmt-body">${formatCommentText(c.text)}</div>
        ${attsHtml}
        ${acts.length ? `<div class="cmt-acts">${acts.join('')}</div>` : ''}
        <div class="reply-form" id="reply-form-${c.id}" style="display:none">
          <textarea id="reply-text-${c.id}" placeholder="Write a reply…" rows="2"></textarea>
          <div class="row-end">
            <button class="btn-sec" data-replycancel="${c.id}">Cancel</button>
            <button class="btn-pri" data-replysend="${c.id}">Reply</button>
          </div>
        </div>
      </div>
    </div>`;

  const kids = visible.map(r => renderOneComment(r, depth + 1, c, childrenOf)).join('');
  if (depth === 0 && (kids || showMore)) {
    return bubble + `<div class="thread">${showMore}${kids}</div>`;
  }
  return bubble + (showMore || '') + kids;
}

function renderCommentAttachment(a) {
  const url = escAttr(a.url || '');
  const name = esc(a.originalName || 'file');
  const mime = a.mimeType || '';
  if (mime.startsWith('image/')) {
    return `<span class="cmt-att cmt-att-img" data-lb-url="${url}" data-lb-name="${escAttr(a.originalName || 'file')}" data-lb-mime="${escAttr(mime)}">
      <img src="${url}" alt="${name}" loading="lazy"/><span class="cmt-att-name">${name}</span></span>`;
  }
  if (mime.startsWith('audio/')) {
    return `<span class="cmt-att"><span class="voice-note">🎤 <audio controls src="${url}"></audio> ${name}</span></span>`;
  }
  if (mime.startsWith('video/')) {
    return `<span class="cmt-att"><video controls preload="metadata" src="${url}"></video><span class="cmt-att-name">${name}</span></span>`;
  }
  const ext = String(a.originalName || '').split('.').pop().toUpperCase().slice(0, 4) || 'FILE';
  return `<span class="cmt-att cmt-att-file" data-lb-url="${url}" data-lb-name="${escAttr(a.originalName || 'file')}" data-lb-mime="${escAttr(mime)}">
    <span class="ext ${ext === 'PDF' ? 'pdf' : ''}">${esc(ext)}</span><span>${name}</span><span>↗</span></span>`;
}

function wireConvoEvents(root) {
  root.querySelectorAll('[data-expand]').forEach(b => b.addEventListener('click', () => {
    expandedThreads.add(Number(b.getAttribute('data-expand')));
    renderConvo();
  }));
  root.querySelectorAll('[data-reply]').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-reply');
    const form = $('reply-form-' + id);
    if (form) { form.style.display = ''; $('reply-text-' + id).focus(); }
  }));
  root.querySelectorAll('[data-replycancel]').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-replycancel');
    const form = $('reply-form-' + id);
    if (form) { form.style.display = 'none'; $('reply-text-' + id).value = ''; }
  }));
  root.querySelectorAll('[data-replysend]').forEach(b => b.addEventListener('click', async () => {
    const id = Number(b.getAttribute('data-replysend'));
    const ta = $('reply-text-' + id);
    const text = ta ? ta.value.trim() : '';
    if (!text) return;
    b.disabled = true;
    try {
      await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/comments', { text, parentId: id });
      expandedThreads.add(id);
      await loadComments();
      loadTimeline();
    } catch (e) { alert('Could not reply: ' + e.message); b.disabled = false; }
  }));
  root.querySelectorAll('[data-delcmt]').forEach(b => b.addEventListener('click', async () => {
    const id = Number(b.getAttribute('data-delcmt'));
    if (!await uiConfirm('Delete this comment? This cannot be undone.', { title: 'Delete comment', okText: 'Delete', danger: true })) return;
    try {
      await apiDel('/api/tickets/' + encodeURIComponent(T.id) + '/comments/' + id);
      COMMENTS = COMMENTS.filter(c => c.id !== id);
      renderConvo();
      loadAttachments(); // server cascade-cleans linked files
    } catch (e) { alert('Could not delete: ' + e.message); }
  }));
  root.querySelectorAll('[data-noreply]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.style.opacity = '.55';
    try {
      await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/mentions/dismiss', {});
      b.textContent = '✓ Dismissed';
      b.classList.add('dismissed');
    } catch (e) {
      alert('Could not mark as no-reply-needed: ' + e.message);
      b.disabled = false; b.style.opacity = '';
    }
  }));
  root.querySelectorAll('[data-lb-url]').forEach(elm => elm.addEventListener('click', () => {
    openLightbox(elm.getAttribute('data-lb-url'), elm.getAttribute('data-lb-name'), elm.getAttribute('data-lb-mime'));
  }));
}

/* Filters + activity toggle + jump-to-latest */
document.querySelectorAll('.filt').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.filt').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  convoFilter = b.getAttribute('data-filt');
  renderConvo();
}));
$('convo-activity-toggle').addEventListener('change', () => {
  try { localStorage.setItem('td-show-activity', $('convo-activity-toggle').checked ? '1' : '0'); } catch {}
  renderConvo();
});
try { if (localStorage.getItem('td-show-activity') === '0') $('convo-activity-toggle').checked = false; } catch {}

$('td-convo').addEventListener('scroll', () => {
  const el = $('td-convo');
  const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  $('td-jump').style.display = fromBottom > 300 ? '' : 'none';
});
$('td-jump').addEventListener('click', () => {
  const el = $('td-convo');
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
});

/* ══════════════════════════════════════════════════════════════
   COMPOSER (text + attach + voice + screen + paste + drag + @)
   ══════════════════════════════════════════════════════════════ */
let composerRecorder = null;
let composerRecTimer = null;
let composerRecSecs = 0;
let screenRecorder = null;

function wireComposer() {
  const ta = $('composer-text');

  $('comp-send').addEventListener('click', sendComment);
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendComment(); }
  });

  // files
  $('comp-file-input').addEventListener('change', function () {
    Array.from(this.files).forEach(addPendingFile);
    this.value = '';
  });

  // paste image
  ta.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let handled = false;
    for (const it of items) {
      if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
      const blob = it.getAsFile();
      if (!blob) continue;
      const ext = (blob.type.split('/')[1] || 'png').split(';')[0];
      addPendingFile(new File([blob], `screenshot-${Date.now()}.${ext}`, { type: blob.type }));
      handled = true;
    }
    if (handled) e.preventDefault();
  });

  // drag & drop
  const composer = document.querySelector('.td-composer');
  ['dragenter', 'dragover'].forEach(ev => composer.addEventListener(ev, (e) => {
    e.preventDefault(); composer.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => composer.addEventListener(ev, (e) => {
    e.preventDefault(); composer.classList.remove('dragover');
  }));
  composer.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) Array.from(e.dataTransfer.files).forEach(addPendingFile);
  });

  // voice note
  $('comp-voice-btn').addEventListener('click', toggleComposerVoice);

  // screen recording (only when supported)
  if (isScreenCaptureSupported()) {
    $('comp-screen-btn').style.display = '';
    $('comp-screen-btn').addEventListener('click', startScreenRecording);
  }

  wireMentionTypeahead(ta);
}

function addPendingFile(file) {
  if (!file) return;
  pendingFiles.push(file);
  renderPendingFiles();
}
function renderPendingFiles() {
  const row = $('pv-row');
  row.innerHTML = pendingFiles.map((f, i) => {
    const icon = f.type.startsWith('image/') ? '🖼' : f.type.startsWith('audio/') ? '🎤' : f.type.startsWith('video/') ? '📹' : '📎';
    const img = f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt=""/>` : '';
    const sizeMb = (f.size / 1024 / 1024).toFixed(1);
    return `<span class="pv">${img}${icon} <span class="pv-name">${esc(f.name || 'file')}</span>
      <span style="color:var(--text3)">${sizeMb} MB</span>
      <button class="x" data-rm="${i}" title="Remove" aria-label="Remove file">×</button></span>`;
  }).join('');
  row.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    pendingFiles.splice(Number(b.dataset.rm), 1);
    renderPendingFiles();
  }));
}

async function sendComment() {
  const ta = $('composer-text');
  const text = ta.value.trim();
  const files = pendingFiles.slice();
  if (!text && !files.length) return;
  const btn = $('comp-send');
  btn.disabled = true;
  try {
    let newCommentId = null;
    if (text) {
      const resp = await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/comments', { text });
      newCommentId = resp && resp.id;
      promptAddNewlyMentioned(resp);
    }
    for (const file of files) {
      try {
        const form = new FormData();
        const fallback = file.type.startsWith('video/') ? 'screen.webm' : file.type.startsWith('audio/') ? 'voice.webm' : 'attachment';
        form.append('file', file, file.name || fallback);
        form.append('ticketId', T.id);
        if (newCommentId && !file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
          form.append('commentId', String(newCommentId));
        }
        const r = await fetch('/api/upload', { method: 'POST', body: form, credentials: 'same-origin' });
        if (!r.ok) {
          alert(r.status === 413 ? 'Upload rejected: file is larger than the 100MB limit.' : 'Upload failed (' + r.status + ').');
          continue;
        }
        const data = await r.json();
        // Voice / screen clips post as dedicated media comments so they play
        // inline in the conversation (same protocol as the old page).
        if (file.type.startsWith('audio/') && data.url) {
          await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/comments', { text: 'VOICENOTE::' + data.url });
        } else if (file.type.startsWith('video/') && data.url) {
          await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/comments', { text: 'SCREENRECORD::' + data.url });
        }
      } catch {}
    }
    ta.value = '';
    pendingFiles = [];
    renderPendingFiles();
    await loadComments();
    loadTimeline();
    loadAttachments();
    T.comments = COMMENTS.length;
  } catch (e) {
    alert('Could not post comment: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/* "@Bob isn't on this ticket — add as assignee?" (same as index) */
async function promptAddNewlyMentioned(resp) {
  const list = resp && resp.newlyMentioned;
  if (!Array.isArray(list) || !list.length || !isAdmin()) return;
  for (const u of list) {
    const ok = await uiConfirm(`You mentioned @${u.name}, who isn't on this ticket. Add them as an assignee?`, { title: 'Add assignee?', okText: 'Add' });
    if (ok) await toggleAssignee(u.name);
  }
}

/* Voice note recording */
async function toggleComposerVoice() {
  const btn = $('comp-voice-btn');
  const timer = $('comp-rec-timer');
  if (composerRecorder && composerRecorder.state === 'recording') { composerRecorder.stop(); return; }
  let stream;
  try { stream = await getMicStream(); }
  catch { alert('Microphone access denied.'); return; }
  const chunks = [];
  const mime = pickRecorderMime();
  try { composerRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { alert('Recording not supported here: ' + (e.message || e)); return; }
  composerRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  composerRecorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(composerRecTimer);
    timer.style.display = 'none';
    btn.classList.remove('recording');
    btn.innerHTML = btn.dataset.orig;
    const actualMime = composerRecorder.mimeType || mime || 'audio/webm';
    const total = chunks.reduce((n, c) => n + (c.size || 0), 0);
    if (!chunks.length || total < 1024) { alert('Voice note was empty or too short — please try again.'); return; }
    const base = String(actualMime).split(';')[0].trim() || 'audio/webm';
    addPendingFile(new File(chunks, `voice-${Date.now()}.${audioExtFor(actualMime)}`, { type: base }));
  };
  btn.dataset.orig = btn.innerHTML;
  composerRecorder.start(1000);
  composerRecSecs = 0;
  timer.style.display = '';
  timer.textContent = '0:00';
  composerRecTimer = setInterval(() => {
    composerRecSecs++;
    timer.textContent = Math.floor(composerRecSecs / 60) + ':' + String(composerRecSecs % 60).padStart(2, '0');
  }, 1000);
  btn.classList.add('recording');
  btn.innerHTML = '■ Stop';
}

/* Screen recording — display + mic mixed when possible, 10 min cap */
async function startScreenRecording() {
  if (screenRecorder && screenRecorder.state === 'recording') { screenRecorder.stop(); return; }
  const btn = $('comp-screen-btn');
  let displayStream = null, micStream = null, audioCtx = null;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
  } catch { return; /* user cancelled the picker */ }
  try { micStream = await getMicStream(); } catch { micStream = null; }

  let finalStream;
  try {
    const audioTracks = [];
    const hasSys = displayStream.getAudioTracks().length > 0;
    const hasMic = micStream && micStream.getAudioTracks().length > 0;
    if (hasSys && hasMic) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(displayStream).connect(dest);
      audioCtx.createMediaStreamSource(micStream).connect(dest);
      audioTracks.push(...dest.stream.getAudioTracks());
    } else if (hasMic) audioTracks.push(...micStream.getAudioTracks());
    else if (hasSys) audioTracks.push(...displayStream.getAudioTracks());
    finalStream = new MediaStream([...displayStream.getVideoTracks(), ...audioTracks]);
  } catch {
    finalStream = displayStream;
  }

  const chunks = [];
  const mime = pickVideoMime();
  try { screenRecorder = mime ? new MediaRecorder(finalStream, { mimeType: mime }) : new MediaRecorder(finalStream); }
  catch (e) { alert('Screen recording not supported here.'); return; }
  const cleanup = () => {
    [displayStream, micStream].forEach(s => { if (s) s.getTracks().forEach(t => t.stop()); });
    if (audioCtx) { try { audioCtx.close(); } catch {} }
    btn.classList.remove('recording');
    btn.innerHTML = btn.dataset.orig || btn.innerHTML;
    clearTimeout(hardStop);
  };
  screenRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  screenRecorder.onstop = () => {
    cleanup();
    const actual = screenRecorder.mimeType || mime || 'video/webm';
    const total = chunks.reduce((n, c) => n + (c.size || 0), 0);
    if (!chunks.length || total < 2048) { alert('Screen recording came back empty — please try again.'); return; }
    const base = String(actual).split(';')[0].trim() || 'video/webm';
    const ext = base.includes('mp4') ? 'mp4' : 'webm';
    addPendingFile(new File(chunks, `screen-${Date.now()}.${ext}`, { type: base }));
  };
  const vt = displayStream.getVideoTracks()[0];
  if (vt) vt.addEventListener('ended', () => { try { if (screenRecorder.state === 'recording') screenRecorder.stop(); } catch {} });
  btn.dataset.orig = btn.innerHTML;
  btn.classList.add('recording');
  btn.innerHTML = '■ Stop rec';
  screenRecorder.start(1000);
  const hardStop = setTimeout(() => { try { if (screenRecorder.state === 'recording') screenRecorder.stop(); } catch {} }, 10 * 60 * 1000);
}

/* @-mention typeahead */
function wireMentionTypeahead(ta) {
  const dd = $('mention-dd');
  let sel = 0, matches = [];
  const close = () => { dd.style.display = 'none'; matches = []; };
  const query = () => {
    const upToCaret = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([A-Za-z][A-Za-z ]{0,30})?$/.exec(upToCaret);
    return m ? { prefix: (m[2] || ''), start: upToCaret.length - (m[2] || '').length } : null;
  };
  const render = () => {
    dd.innerHTML = matches.map((mm, i) => `
      <div class="mi ${i === sel ? 'sel' : ''}" data-i="${i}">
        ${avatarHtml(mm.name, 20)}<span>${esc(mm.name)}</span><small>${esc(mm.dept || '')}</small>
      </div>`).join('');
    dd.querySelectorAll('.mi').forEach(item => {
      item.addEventListener('mousedown', (e) => { e.preventDefault(); pick(Number(item.dataset.i)); });
    });
  };
  const pick = (i) => {
    const q = query();
    if (!q || !matches[i]) { close(); return; }
    const before = ta.value.slice(0, q.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = before + matches[i].name + ' ' + after;
    const pos = (before + matches[i].name + ' ').length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    close();
  };
  ta.addEventListener('input', () => {
    const q = query();
    if (!q) { close(); return; }
    const p = q.prefix.toLowerCase();
    matches = TEAM.filter(m => m.name.toLowerCase().startsWith(p) || m.name.toLowerCase().includes(' ' + p)).slice(0, 6);
    if (!matches.length) { close(); return; }
    sel = 0;
    dd.style.display = '';
    render();
  });
  ta.addEventListener('keydown', (e) => {
    if (dd.style.display === 'none' || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') close();
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
}

/* ══════════════════════════════════════════════════════════════
   SUBTASKS
   ══════════════════════════════════════════════════════════════ */
async function loadSubtasks() {
  try { SUBTASKS = await apiGet('/api/tickets/' + encodeURIComponent(T.id) + '/subtasks'); }
  catch { SUBTASKS = []; }
  renderSubtasks();
}
function renderSubtasks() {
  const done = SUBTASKS.filter(s => s.done).length;
  const total = SUBTASKS.length;
  $('sub-count').textContent = total ? `${done}/${total}` : '0';
  $('sub-prog-row').style.display = total ? '' : 'none';
  if (total) {
    $('sub-prog-fill').style.width = Math.round(done / total * 100) + '%';
    $('sub-prog-num').textContent = `${done} / ${total} done`;
  }
  const el = $('subtask-list');
  if (!total) {
    el.innerHTML = '<div class="sub-empty">✅ No subtasks yet. Break this ticket into steps below.</div>';
    return;
  }
  el.innerHTML = SUBTASKS.map(renderSubtaskRow).join('');
  wireSubtaskEvents(el);
}
function subTeamOptions(selected) {
  return ['<option value="">— unassigned —</option>']
    .concat(TEAM.map(m => `<option value="${escAttr(m.name)}" ${m.name === (selected || '') ? 'selected' : ''}>${esc(m.name)}</option>`))
    .join('');
}
function renderSubtaskRow(s) {
  const isOpen = expandedSubtasks.has(s.id);
  const dueLate = s.due && parseTicketDate(s.due) && parseTicketDate(s.due) < APP_TODAY && !s.done;
  const pcls = { Urgent: 'p-u', High: 'p-h', Medium: 'p-m', Low: 'p-l' }[s.priority] || '';
  return `
    <div class="sub ${isOpen ? 'exp' : ''}" data-sid="${s.id}">
      <div class="sub-row">
        <input type="checkbox" ${s.done ? 'checked' : ''} data-subtoggle="${s.id}"/>
        <div class="sub-text ${s.done ? 'done' : ''}" contenteditable="${T.status === 'Closed' ? 'false' : 'true'}" data-subtext="${s.id}">${esc(s.text)}</div>
        <button class="sub-btn" data-subexpand="${s.id}" title="${isOpen ? 'Hide details' : 'Show details'}">${isOpen ? '▴' : '▾'}</button>
        <button class="sub-btn del" data-subdel="${s.id}" title="Delete subtask">×</button>
      </div>
      <div class="sub-meta">
        <select data-subfield="assignee" data-sid="${s.id}" title="Assignee">${subTeamOptions(s.assignee)}</select>
        <input type="date" value="${escAttr(s.due || '')}" data-subfield="due" data-sid="${s.id}" title="Due date"
               style="color:${dueLate ? 'var(--red)' : 'inherit'}"/>
        <select data-subfield="priority" data-sid="${s.id}" title="Priority">
          <option value="" ${!s.priority ? 'selected' : ''}>— priority —</option>
          ${['Low', 'Medium', 'High', 'Urgent'].map(p => `<option ${s.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        ${s.priority ? `<span class="pri-tag ${pcls}">${esc(s.priority)}</span>` : ''}
      </div>
      ${isOpen ? renderSubtaskDetail(s) : ''}
    </div>`;
}
function renderSubtaskDetail(s) {
  const atts = SUBATTS[s.id] || [];
  const attsHtml = atts.length
    ? atts.map(a => {
      const isImg = (a.mimeType || '').startsWith('image/');
      const isAud = (a.mimeType || '').startsWith('audio/');
      const inner = isImg
        ? `<img src="${escAttr(a.url)}" data-lb-url="${escAttr(a.url)}" data-lb-name="${escAttr(a.originalName || a.filename)}" data-lb-mime="${escAttr(a.mimeType)}" alt=""/>`
        : isAud
          ? `<audio controls src="${escAttr(a.url)}"></audio>`
          : `<span class="fname" data-lb-url="${escAttr(a.url)}" data-lb-name="${escAttr(a.originalName || a.filename)}" data-lb-mime="${escAttr(a.mimeType)}">📄 ${esc(a.originalName || a.filename)}</span>`;
      return `<span class="sub-att">${inner}<button class="rmatt" data-delsubatt="${a.id}" data-sid="${s.id}" title="Delete">×</button></span>`;
    }).join('')
    : '<span class="paste-hint">No attachments yet.</span>';
  return `
    <div class="sub-detail">
      <p class="microlabel">Description</p>
      <textarea data-subdesc="${s.id}" placeholder="Add details, links, context…">${esc(s.description || '')}</textarea>
      <p class="microlabel" style="margin-top:8px">Attachments</p>
      <div class="attach-row">
        <label class="mini-btn">📎 Add file
          <input type="file" multiple accept="image/*,audio/*,.pdf,.doc,.docx" style="display:none" data-subfile="${s.id}"/>
        </label>
        <button class="mini-btn" data-subrec="${s.id}">🎤 Record voice</button>
        <span class="rec-timer" data-subrectimer="${s.id}" style="display:none"></span>
        <span class="paste-hint">or paste with <span class="kbd">Ctrl+V</span></span>
      </div>
      <div class="sub-atts">${attsHtml}</div>
    </div>`;
}
function findSubtask(sid) { return SUBTASKS.find(s => s.id === sid) || null; }

function wireSubtaskEvents(root) {
  root.querySelectorAll('[data-subtoggle]').forEach(cb => cb.addEventListener('change', async () => {
    const s = findSubtask(Number(cb.getAttribute('data-subtoggle')));
    if (!s) return;
    s.done = cb.checked;
    renderSubtasks();
    try { await apiPut('/api/subtasks/' + s.id, { done: s.done }); } catch {}
  }));
  root.querySelectorAll('[data-subtext]').forEach(div => {
    div.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); div.blur(); } });
    div.addEventListener('blur', async () => {
      const s = findSubtask(Number(div.getAttribute('data-subtext')));
      if (!s) return;
      const text = div.textContent.trim();
      if (!text || text === s.text) { div.textContent = s.text; return; }
      s.text = text;
      try { await apiPut('/api/subtasks/' + s.id, { text }); } catch {}
    });
  });
  root.querySelectorAll('[data-subfield]').forEach(inp => inp.addEventListener('change', async () => {
    const s = findSubtask(Number(inp.getAttribute('data-sid')));
    if (!s) return;
    const field = inp.getAttribute('data-subfield');
    s[field] = inp.value;
    try { await apiPut('/api/subtasks/' + s.id, { [field]: inp.value }); } catch {}
    renderSubtasks();
  }));
  root.querySelectorAll('[data-subexpand]').forEach(b => b.addEventListener('click', async () => {
    const sid = Number(b.getAttribute('data-subexpand'));
    if (expandedSubtasks.has(sid)) expandedSubtasks.delete(sid);
    else {
      expandedSubtasks.add(sid);
      try { SUBATTS[sid] = await apiGet('/api/subtasks/' + sid + '/attachments'); } catch { SUBATTS[sid] = []; }
    }
    renderSubtasks();
  }));
  root.querySelectorAll('[data-subdel]').forEach(b => b.addEventListener('click', async () => {
    const sid = Number(b.getAttribute('data-subdel'));
    if (!await uiConfirm('Delete this subtask (and its attachments)?', { title: 'Delete subtask', okText: 'Delete', danger: true })) return;
    try {
      await apiDel('/api/subtasks/' + sid);
      SUBTASKS = SUBTASKS.filter(s => s.id !== sid);
      renderSubtasks();
    } catch (e) { alert(e.message); }
  }));
  root.querySelectorAll('[data-subdesc]').forEach(taEl => taEl.addEventListener('blur', async () => {
    const s = findSubtask(Number(taEl.getAttribute('data-subdesc')));
    if (!s || taEl.value === s.description) return;
    s.description = taEl.value;
    try { await apiPut('/api/subtasks/' + s.id, { description: s.description }); } catch {}
  }));
  root.querySelectorAll('[data-subfile]').forEach(inp => inp.addEventListener('change', async function () {
    const sid = Number(this.getAttribute('data-subfile'));
    for (const f of Array.from(this.files)) await uploadSubtaskFile(sid, f);
    this.value = '';
  }));
  root.querySelectorAll('[data-subrec]').forEach(b => b.addEventListener('click', () => toggleSubtaskRecord(Number(b.getAttribute('data-subrec')), b)));
  root.querySelectorAll('[data-delsubatt]').forEach(b => b.addEventListener('click', async () => {
    const attId = Number(b.getAttribute('data-delsubatt'));
    const sid = Number(b.getAttribute('data-sid'));
    try {
      await apiDel('/api/attachments/' + attId);
      SUBATTS[sid] = (SUBATTS[sid] || []).filter(a => a.id !== attId);
      renderSubtasks();
    } catch (e) { alert(e.message); }
  }));
  root.querySelectorAll('[data-lb-url]').forEach(elm => elm.addEventListener('click', () => {
    openLightbox(elm.getAttribute('data-lb-url'), elm.getAttribute('data-lb-name'), elm.getAttribute('data-lb-mime'));
  }));
  // Paste-to-attach inside an expanded subtask
  root.querySelectorAll('.sub.exp').forEach(row => {
    if (row._pastePatched) return;
    row._pastePatched = true;
    row.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const sid = Number(row.getAttribute('data-sid'));
      let handled = false;
      for (const it of items) {
        if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
        const blob = it.getAsFile();
        if (!blob) continue;
        const ext = (blob.type.split('/')[1] || 'png').split(';')[0];
        uploadSubtaskFile(sid, new File([blob], `screenshot-${Date.now()}.${ext}`, { type: blob.type }));
        handled = true;
      }
      if (handled) e.preventDefault();
    });
  });
}
async function uploadSubtaskFile(sid, file) {
  try {
    const form = new FormData();
    form.append('file', file, file.name || 'attachment');
    form.append('ticketId', T.id);
    form.append('subtaskId', String(sid));
    const r = await fetch('/api/upload', { method: 'POST', body: form, credentials: 'same-origin' });
    if (!r.ok) { alert('Upload failed (' + r.status + ')'); return; }
    SUBATTS[sid] = await apiGet('/api/subtasks/' + sid + '/attachments');
    renderSubtasks();
    loadAttachments();
  } catch (e) { alert('Upload failed: ' + e.message); }
}
let subRecorder = null, subRecSid = null, subRecInterval = null;
async function toggleSubtaskRecord(sid, btn) {
  if (subRecorder && subRecorder.state === 'recording') { subRecorder.stop(); return; }
  let stream;
  try { stream = await getMicStream(); }
  catch { alert('Microphone access denied.'); return; }
  const chunks = [];
  const mime = pickRecorderMime();
  subRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  subRecSid = sid;
  const timer = document.querySelector(`[data-subrectimer="${sid}"]`);
  let secs = 0;
  subRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  subRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(subRecInterval);
    if (timer) timer.style.display = 'none';
    btn.classList.remove('recording');
    btn.textContent = '🎤 Record voice';
    const actual = subRecorder.mimeType || mime || 'audio/webm';
    const total = chunks.reduce((n, c) => n + (c.size || 0), 0);
    if (!chunks.length || total < 1024) { alert('Voice note was empty or too short — please try again.'); return; }
    const base = String(actual).split(';')[0].trim() || 'audio/webm';
    await uploadSubtaskFile(sid, new File(chunks, `voice-${Date.now()}.${audioExtFor(actual)}`, { type: base }));
  };
  subRecorder.start(1000);
  if (timer) { timer.style.display = ''; timer.textContent = '0:00'; }
  subRecInterval = setInterval(() => {
    secs++;
    if (timer) timer.textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  }, 1000);
  btn.classList.add('recording');
  btn.textContent = '■ Stop';
}
$('sub-add-btn').addEventListener('click', async () => {
  try {
    const s = await apiPost('/api/tickets/' + encodeURIComponent(T.id) + '/subtasks', { text: 'New subtask' });
    SUBTASKS.push(s);
    renderSubtasks();
    const div = document.querySelector(`[data-subtext="${s.id}"]`);
    if (div) {
      div.focus();
      const range = document.createRange();
      range.selectNodeContents(div);
      const selObj = window.getSelection();
      selObj.removeAllRanges(); selObj.addRange(range);
    }
  } catch (e) { alert('Could not add subtask: ' + e.message); }
});

/* ══════════════════════════════════════════════════════════════
   ATTACHMENTS (canonical ticket-wide list)
   ══════════════════════════════════════════════════════════════ */
async function loadAttachments() {
  try { ATTS = await apiGet('/api/tickets/' + encodeURIComponent(T.id) + '/attachments'); }
  catch { ATTS = []; }
  renderAttachments();
}
function renderAttachments() {
  $('att-count').textContent = ATTS.length;
  const el = $('att-list');
  if (!ATTS.length) { el.innerHTML = '<div class="att-empty">No attachments on this ticket yet.</div>'; return; }
  el.innerHTML = ATTS.map(a => {
    const mime = a.mimeType || '';
    const name = a.originalName || a.filename;
    const ext = String(name).split('.').pop().toUpperCase().slice(0, 3);
    let thumb;
    if (mime.startsWith('image/')) thumb = `<span class="thumb th-img"><img src="${escAttr(a.url)}" alt="" loading="lazy"/></span>`;
    else if (mime.startsWith('audio/')) thumb = '<span class="thumb th-aud">🎤</span>';
    else if (mime.startsWith('video/')) thumb = '<span class="thumb th-vid">▶</span>';
    else if (ext === 'PDF') thumb = '<span class="thumb th-pdf">PDF</span>';
    else thumb = `<span class="thumb th-doc">${esc(ext || 'FILE')}</span>`;
    const canDel = isAdmin() || (a.uploader && ME && a.uploader === ME.name);
    return `<div class="att" data-open="${a.id}">
      ${thumb}
      <div style="min-width:0;flex:1">
        <div class="att-name">${esc(name)}</div>
        <div class="att-sub">${esc(a.uploader || '')}${a.createdAt ? ' · ' + esc(fmtLocal(a.createdAt)) : ''}</div>
      </div>
      <div class="att-act">
        <a href="${escAttr(a.url)}" download="${escAttr(name)}" title="Download" data-stop>↓</a>
        ${canDel ? `<button class="del" data-delatt="${a.id}" title="Delete attachment">🗑</button>` : ''}
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.att').forEach(row => row.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]') || e.target.closest('[data-delatt]')) return;
    const a = ATTS.find(x => x.id === Number(row.getAttribute('data-open')));
    if (a) openLightbox(a.url, a.originalName || a.filename, a.mimeType);
  }));
  el.querySelectorAll('[data-delatt]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = Number(b.getAttribute('data-delatt'));
    if (!await uiConfirm('Delete this attachment? This cannot be undone.', { title: 'Delete attachment', okText: 'Delete', danger: true })) return;
    try {
      await apiDel('/api/attachments/' + id);
      ATTS = ATTS.filter(a => a.id !== id);
      renderAttachments();
      loadComments(); // inline copies under comments disappear too
    } catch (e2) { alert(e2.message); }
  }));
}
$('att-upload-input').addEventListener('change', async function () {
  for (const f of Array.from(this.files)) {
    try {
      const form = new FormData();
      form.append('file', f, f.name || 'attachment');
      form.append('ticketId', T.id);
      const r = await fetch('/api/upload', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!r.ok) alert('Upload failed (' + r.status + ')');
    } catch (e) { alert('Upload failed: ' + e.message); }
  }
  this.value = '';
  loadAttachments();
});

/* ══════════════════════════════════════════════════════════════
   MY REMINDERS (private, per-ticket)
   ══════════════════════════════════════════════════════════════ */
async function loadMyReminders() {
  try { MYREMS = await apiGet('/api/my-reminders?filter=all&ticketId=' + encodeURIComponent(T.id)); }
  catch { MYREMS = []; }
  renderMyReminders();
}
function renderMyReminders() {
  $('rem-count').textContent = MYREMS.length;
  const el = $('rem-list');
  if (!MYREMS.length) { el.innerHTML = '<div class="rem-empty">No personal reminders for this ticket yet.</div>'; return; }
  el.innerHTML = MYREMS.map(r => {
    const overdue = !r.completed && r.dueAt && parseUtc(r.dueAt) < new Date();
    const flags = [r.emailEnabled ? '📧' : '', r.repeatDaily ? '🔁' : '', r.showDailyInApp ? '📺' : ''].filter(Boolean).join(' ');
    return `<div class="rem">
      <div style="flex:1;min-width:0">
        <div class="rem-title ${r.completed ? 'done' : ''}">${esc(r.title)}</div>
        <div class="rem-sub">⏰ ${esc(fmtLocal(r.dueAt))}${flags ? ' · ' + flags : ''}${overdue ? ' · <span class="late">Overdue</span>' : ''}</div>
      </div>
      ${r.completed
        ? `<button class="rem-btn" data-remreopen="${r.id}">Reopen</button>`
        : `<button class="rem-btn go" data-remdone="${r.id}">✓ Done</button>`}
      <button class="rem-btn" data-remedit="${r.id}">Edit</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-remdone]').forEach(b => b.addEventListener('click', async () => {
    try { await apiPut('/api/my-reminders/' + b.getAttribute('data-remdone'), { completed: true }); loadMyReminders(); }
    catch (e) { alert(e.message); }
  }));
  el.querySelectorAll('[data-remreopen]').forEach(b => b.addEventListener('click', async () => {
    try { await apiPut('/api/my-reminders/' + b.getAttribute('data-remreopen'), { completed: false }); loadMyReminders(); }
    catch (e) { alert(e.message); }
  }));
  el.querySelectorAll('[data-remedit]').forEach(b => b.addEventListener('click', () => {
    openMyRemEditor(MYREMS.find(r => r.id === Number(b.getAttribute('data-remedit'))));
  }));
}
function openMyRemEditor(rem) {
  editingMyRemId = rem ? rem.id : null;
  $('myrem-title').textContent = rem ? 'Edit reminder' : 'New reminder';
  $('myrem-t').value = rem ? rem.title : '';
  $('myrem-desc').value = rem ? (rem.description || '') : '';
  const d = rem && rem.dueAt ? parseUtc(rem.dueAt) : (() => { const x = new Date(); x.setDate(x.getDate() + 1); x.setHours(9, 0, 0, 0); return x; })();
  $('myrem-when').value = localDtValue(d);
  $('myrem-email').checked = rem ? !!rem.emailEnabled : true;
  $('myrem-repeat').checked = rem ? !!rem.repeatDaily : false;
  $('myrem-inapp').checked = rem ? !!rem.showDailyInApp : false;
  openModal('md-myrem');
  setTimeout(() => $('myrem-t').focus(), 60);
}
$('rem-add-btn').addEventListener('click', () => openMyRemEditor(null));
$('myrem-save').addEventListener('click', async () => {
  const title = $('myrem-t').value.trim();
  if (!title) { alert('Give the reminder a title.'); return; }
  const when = $('myrem-when').value;
  const d = when ? new Date(when) : null;
  if (!d || isNaN(d)) { alert('Pick a date/time.'); return; }
  const body = {
    title,
    description: $('myrem-desc').value.trim(),
    dueAt: d.toISOString(),
    emailEnabled: $('myrem-email').checked,
    repeatDaily: $('myrem-repeat').checked,
    showDailyInApp: $('myrem-inapp').checked,
  };
  try {
    if (editingMyRemId) await apiPut('/api/my-reminders/' + editingMyRemId, body);
    else await apiPost('/api/my-reminders', Object.assign({ ticketId: T.id }, body));
    closeModal('md-myrem');
    loadMyReminders();
    toast('Reminder saved');
  } catch (e) { alert('Could not save reminder: ' + e.message); }
});

/* ══════════════════════════════════════════════════════════════
   SIDEBAR (accordions + resizer)
   ══════════════════════════════════════════════════════════════ */
function wireSidebar() {
  document.querySelectorAll('.acc-head[data-acc]').forEach(head => {
    head.addEventListener('click', (e) => {
      if (e.target.closest('.pencil') || e.target.closest('.ghost-btn')) return;
      const acc = head.parentElement;
      acc.classList.toggle('open');
      persistAccordions();
    });
  });

  // Draggable divider between conversation and sidebar (desktop only)
  const rz = $('td-side-resizer');
  let dragging = false;
  rz.addEventListener('mousedown', (e) => {
    dragging = true;
    rz.classList.add('dragging');
    e.preventDefault();
    const onMove = (ev) => {
      if (!dragging) return;
      const bodyEl = document.querySelector('.td-body');
      const rect = bodyEl.getBoundingClientRect();
      let w = rect.right - ev.clientX;
      w = Math.max(260, Math.min(560, w));
      bodyEl.style.setProperty('--side-w', w + 'px');
    };
    const onUp = () => {
      dragging = false;
      rz.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const w = document.querySelector('.td-body').style.getPropertyValue('--side-w');
      try { localStorage.setItem('td-side-w', w); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
function persistAccordions() {
  const state = {};
  document.querySelectorAll('.acc[id]').forEach(a => { state[a.id] = a.classList.contains('open'); });
  try { localStorage.setItem('td-accs', JSON.stringify(state)); } catch {}
}
function restoreAccordions() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem('td-accs') || 'null'); } catch {}
  if (!state) return;
  document.querySelectorAll('.acc[id]').forEach(a => {
    if (a.id in state) a.classList.toggle('open', !!state[a.id]);
  });
}
function restoreSideWidth() {
  try {
    const w = localStorage.getItem('td-side-w');
    if (w) document.querySelector('.td-body').style.setProperty('--side-w', w);
  } catch {}
}

/* ── Go ────────────────────────────────────────────────────── */
boot();

})();
