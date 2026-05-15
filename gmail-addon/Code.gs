// Gmail add-on: turn an open email into a ticket in Work-Management.
//
// One-time setup: open the add-on in Gmail, click "Settings" (the icon
// at the top-right of the card), paste your APP URL and API TOKEN, save.
// Everything else lives in PropertiesService.getUserProperties().

var DEFAULT_APP_URL = '{{APP_URL_DEFAULT}}';   // injected when copied from the setup page
var TOKEN_KEY = 'WM_API_TOKEN';
var APP_URL_KEY = 'WM_APP_URL';

// ─── Triggers ────────────────────────────────────────────────────────────────

function onHomepage(e) {
  return buildSettingsOrIntroCard_();
}

function onOpenSettings(e) {
  return buildSettingsCard_();
}

function onGmailMessage(e) {
  // Gmail add-ons need an explicit per-message access token before
  // GmailApp.getMessageById() will let us read the current message —
  // without this, the call throws "Missing access token for
  // authorization. Request: MailboxService.GetMessage". The token is
  // short-lived and scoped to just this message.
  authorizeGmail_(e);
  var settings = getSettings_();
  if (!settings.token || !settings.appUrl) {
    return [ buildSettingsCard_('Add your API token to start creating tickets.') ];
  }
  var messageId = e && e.gmail && e.gmail.messageId;
  if (!messageId) {
    return [ buildSimpleCard_('Open an email', 'Select an email to create a ticket from it.') ];
  }
  return [ buildChooserCard_(messageId) ];
}

// First card the user sees on a message. Two choices: turn into a ticket,
// or turn into a personal reminder. Each navigates to its dedicated form.
function buildChooserCard_(messageId) {
  var msg = GmailApp.getMessageById(messageId);
  var subject = msg.getSubject() || '(no subject)';
  var fromRaw = msg.getFrom() || '';

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Email → Work'));

  var preview = CardService.newCardSection()
    .addWidget(CardService.newKeyValue().setTopLabel('Subject').setContent(escapeHtml_(subject)))
    .addWidget(CardService.newKeyValue().setTopLabel('From').setContent(escapeHtml_(fromRaw || '(unknown)')));
  card.addSection(preview);

  var actions = CardService.newCardSection().setHeader('What would you like to do?');
  actions.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Create Ticket')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction()
        .setFunctionName('showTicketForm_')
        .setParameters({ messageId: messageId }))));
  actions.addWidget(CardService.newTextParagraph().setText(
    'Adds this email as a ticket in your workspace (with attachments) and can be assigned to teammates.'));

  actions.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Set Reminder')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('showReminderForm_')
        .setParameters({ messageId: messageId }))));
  actions.addWidget(CardService.newTextParagraph().setText(
    'Adds this email to your personal reminders only — you (and nobody else) get pinged at the time you pick.'));

  card.addSection(actions);
  return card.build();
}

function showTicketForm_(e) {
  authorizeGmail_(e);
  var p = (e && e.parameters) || {};
  var messageId = (e && e.gmail && e.gmail.messageId) || p.messageId;
  if (!messageId) return notify_('No message selected.');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(buildMessageCard_(messageId)))
    .build();
}

function showReminderForm_(e) {
  authorizeGmail_(e);
  var p = (e && e.parameters) || {};
  var messageId = (e && e.gmail && e.gmail.messageId) || p.messageId;
  if (!messageId) return notify_('No message selected.');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(buildReminderFormCard_(messageId)))
    .build();
}

function authorizeGmail_(e) {
  var token = e && e.gmail && e.gmail.accessToken;
  if (token) GmailApp.setCurrentMessageAccessToken(token);
}

// ─── Settings ────────────────────────────────────────────────────────────────

function getSettings_() {
  var p = PropertiesService.getUserProperties();
  return {
    token: p.getProperty(TOKEN_KEY) || '',
    appUrl: p.getProperty(APP_URL_KEY) || DEFAULT_APP_URL || '',
  };
}

function buildSettingsOrIntroCard_() {
  var s = getSettings_();
  if (!s.token) return buildSettingsCard_('Welcome! Paste your API token to get started.');
  return buildSimpleCard_(
    'Email → Ticket',
    'Open any email in Gmail, then click the add-on icon in the sidebar to create a ticket from it.'
  );
}

function buildSettingsCard_(hint) {
  var s = getSettings_();
  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Settings'));

  var section = CardService.newCardSection();
  if (hint) section.addWidget(CardService.newTextParagraph().setText(hint));

  section.addWidget(CardService.newTextInput()
    .setFieldName('appUrl')
    .setTitle('App URL')
    .setHint('e.g. https://your-workspace.example.com')
    .setValue(s.appUrl || ''));

  section.addWidget(CardService.newTextInput()
    .setFieldName('token')
    .setTitle('API token')
    .setHint('From the Email → Ticket setup page in the app')
    .setValue(s.token ? '••••••' + s.token.slice(-4) : ''));

  section.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Save')
      .setOnClickAction(CardService.newAction().setFunctionName('saveSettings_'))
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED))
    .addButton(CardService.newTextButton()
      .setText('Test connection')
      .setOnClickAction(CardService.newAction().setFunctionName('testConnection_'))));

  card.addSection(section);
  return card.build();
}

function saveSettings_(e) {
  var f = (e && e.formInput) || {};
  var p = PropertiesService.getUserProperties();
  if (f.appUrl) p.setProperty(APP_URL_KEY, String(f.appUrl).trim().replace(/\/+$/, ''));
  // Treat the masked placeholder as "unchanged" — only overwrite when the
  // user typed a fresh token.
  if (f.token && f.token.indexOf('••••••') !== 0) {
    p.setProperty(TOKEN_KEY, String(f.token).trim());
  }
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Settings saved'))
    .setNavigation(CardService.newNavigation().updateCard(buildSimpleCard_('All set', 'Open an email and click the add-on icon to create a ticket.')))
    .build();
}

function testConnection_() {
  var s = getSettings_();
  if (!s.token || !s.appUrl) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('Set the App URL and API token first.'))
      .build();
  }
  // Cheap probe: post an empty body and check the status. The endpoint
  // will return 400 (validation) on 200, both of which prove auth works.
  var resp = UrlFetchApp.fetch(s.appUrl + '/api/inbound/gmail-addon', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ probe: true }),
    headers: { Authorization: 'Bearer ' + s.token },
    muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  var msg;
  if (code === 401) msg = 'Token rejected. Re-paste it from the setup page.';
  else if (code === 404) msg = 'App URL not reachable. Check it ends with no slash and is correct.';
  else if (code >= 500) msg = 'Server error (' + code + '). Try again in a moment.';
  else msg = 'Connection OK (' + code + ').';
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(msg))
    .build();
}

// ─── Message → ticket ────────────────────────────────────────────────────────

// Fetch the workspace's user list + departments via the app's
// /api/inbound/options endpoint so the create-ticket form can show real
// dropdowns instead of free-text inputs. Returns null if the call fails;
// the card falls back to text inputs in that case.
function fetchOptions_() {
  var s = getSettings_();
  if (!s.token || !s.appUrl) return null;
  try {
    var resp = UrlFetchApp.fetch(s.appUrl + '/api/inbound/options', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + s.token },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) return null;
    return JSON.parse(resp.getContentText() || '{}');
  } catch (_) { return null; }
}

// Render a bold label above a widget. Avoids the CardService bug where
// SelectionInput.setTitle() floats over the selected dropdown value and
// reads as overlapping text.
function labeledRow_(section, label, widget) {
  section.addWidget(CardService.newTextParagraph().setText('<b>' + label + '</b>'));
  section.addWidget(widget);
}

function buildMessageCard_(messageId) {
  var msg = GmailApp.getMessageById(messageId);
  var subject = msg.getSubject() || '(no subject)';
  var fromRaw = msg.getFrom() || '';
  var atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];

  var opts = fetchOptions_();
  var users = (opts && opts.users) || [];
  var depts = (opts && opts.departments) || [];
  var meName = (opts && opts.me && opts.me.name) || '';

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Create ticket from email'));

  var preview = CardService.newCardSection()
    .addWidget(CardService.newKeyValue().setTopLabel('Subject').setContent(escapeHtml_(subject)))
    .addWidget(CardService.newKeyValue().setTopLabel('From').setContent(escapeHtml_(fromRaw || '(unknown)')));
  if (atts.length) {
    preview.addWidget(CardService.newKeyValue()
      .setTopLabel('Attachments')
      .setContent(String(atts.length) + ' file' + (atts.length === 1 ? '' : 's') + ' will be attached'));
  }
  // Heads-up when /api/inbound/options can't be reached — usually means the
  // app hasn't been redeployed with the latest server code, so the user can
  // only see themselves in the dropdowns.
  if (!opts) {
    preview.addWidget(CardService.newTextParagraph().setText(
      '<font color="#b45309">⚠ Couldn\'t load your workspace user list — update the app or check the API URL/token.</font>'
    ));
  }
  card.addSection(preview);

  // ── Title ─────────────────────────────────────────────────────────────────
  var titleSection = CardService.newCardSection();
  labeledRow_(titleSection, 'Title',
    CardService.newTextInput().setFieldName('title').setValue(subject));
  card.addSection(titleSection);

  // ── Requester / Reporter / Assignee ───────────────────────────────────────
  var people = CardService.newCardSection();

  var reqInput = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('requester')
    .addItem('Use email sender', '', true);
  for (var i = 0; i < users.length; i++) reqInput.addItem(users[i].name, users[i].name, false);
  labeledRow_(people, 'Requester', reqInput);

  var repInput = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('reporter')
    .addItem('Me' + (meName ? ' (' + meName + ')' : ''), '', true);
  for (var j = 0; j < users.length; j++) repInput.addItem(users[j].name, users[j].name, false);
  labeledRow_(people, 'Reporter', repInput);

  var asgInput = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('assignee')
    .addItem('Me' + (meName ? ' (' + meName + ')' : ''), '', true);
  for (var k = 0; k < users.length; k++) asgInput.addItem(users[k].name, users[k].name, false);
  labeledRow_(people, 'Assignee', asgInput);

  if (users.length) {
    var multi = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('additionalAssignees');
    for (var u = 0; u < users.length; u++) multi.addItem(users[u].name, users[u].name, false);
    labeledRow_(people, 'Additional assignees', multi);
  }
  card.addSection(people);

  // ── Priority / Department / Due ───────────────────────────────────────────
  var meta = CardService.newCardSection();
  labeledRow_(meta, 'Priority',
    CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('priority')
      .addItem('Low', 'Low', false)
      .addItem('Medium', 'Medium', true)
      .addItem('High', 'High', false)
      .addItem('Critical', 'Critical', false));

  if (depts.length) {
    var deptInput = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('dept')
      .addItem('General', '', true);
    for (var d = 0; d < depts.length; d++) {
      if ((depts[d] || '').toLowerCase() === 'general') continue;
      deptInput.addItem(depts[d], depts[d], false);
    }
    labeledRow_(meta, 'Department', deptInput);
  } else {
    labeledRow_(meta, 'Department',
      CardService.newTextInput().setFieldName('dept').setHint('e.g. Engineering, Support, General'));
  }
  labeledRow_(meta, 'Due date',
    CardService.newTextInput().setFieldName('due').setHint('YYYY-MM-DD (optional)'));
  card.addSection(meta);

  // ── Submit ────────────────────────────────────────────────────────────────
  var submit = CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Create Ticket')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction()
        .setFunctionName('createTicket_')
        .setParameters({ messageId: messageId })));
  card.addSection(CardService.newCardSection().addWidget(submit));

  return card.build();
}

function createTicket_(e) {
  // Action callbacks carry a fresh per-message access token too — set it
  // before any GmailApp call, same reason as in onGmailMessage.
  authorizeGmail_(e);
  var s = getSettings_();
  if (!s.token || !s.appUrl) {
    return notify_('Set the App URL and API token first.');
  }
  var p = (e && e.parameters) || {};
  // Prefer the messageId from the live event over the stashed parameter
  // so we follow whatever message the user is currently looking at.
  var messageId = (e && e.gmail && e.gmail.messageId) || p.messageId;
  if (!messageId) return notify_('No message selected.');

  var f = (e && e.formInput) || {};
  var msg;
  try { msg = GmailApp.getMessageById(messageId); }
  catch (err) { return notify_('Could not read message: ' + err.message); }

  var subject = (f.title || msg.getSubject() || '(no subject)').toString().slice(0, 200);
  var fromRaw = msg.getFrom() || '';
  var fromName = '', fromEmail = '';
  var mFrom = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(fromRaw);
  if (mFrom) { fromName = (mFrom[1] || '').trim(); fromEmail = (mFrom[2] || '').trim(); }
  else { fromEmail = fromRaw.trim(); }

  // Prefer plain text; fall back to a stripped version of the HTML when
  // the sender sent HTML-only (common for marketing-style emails).
  var bodyText = msg.getPlainBody() || '';
  if (!bodyText) bodyText = htmlToText_(msg.getBody() || '');

  // Attachments are always shipped now (no more checkbox). Caps protect
  // against an oversized JSON body — anything over the per-file or total
  // limit is silently dropped on the add-on side and won't reach the app.
  var attachments = [];
  var files = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];
  var totalBytes = 0;
  var maxTotal = 40 * 1024 * 1024;
  var maxPer   = 20 * 1024 * 1024;
  for (var i = 0; i < files.length; i++) {
    var bytes = files[i].getBytes();
    if (bytes.length > maxPer) { continue; }
    if (totalBytes + bytes.length > maxTotal) { break; }
    attachments.push({
      name: files[i].getName(),
      mimeType: files[i].getContentType(),
      dataBase64: Utilities.base64Encode(bytes),
    });
    totalBytes += bytes.length;
  }

  // Multi-select widgets land in formInputs (plural), not formInput.
  var formInputs = (e && e.formInputs) || {};
  var additionalAssignees = formInputs.additionalAssignees || [];
  if (!Array.isArray(additionalAssignees)) additionalAssignees = [additionalAssignees];

  // Permalink back to the open conversation in Gmail. Persisted with the
  // ticket so the user can click "Open email" from the ticket detail and
  // jump straight back to the source thread.
  var thread = msg.getThread();
  var emailUrl = '';
  try { emailUrl = thread ? thread.getPermalink() : ''; } catch (_) { emailUrl = ''; }

  var payload = {
    subject: subject,
    from_name: fromName,
    from_email: fromEmail,
    body_text: bodyText,
    message_id: msg.getId(),
    thread_id: thread ? thread.getId() : '',
    email_url: emailUrl,
    received_at: msg.getDate() ? msg.getDate().toISOString() : '',
    priority: f.priority || 'Medium',
    dept: f.dept || '',
    due: f.due || '',
    requester: f.requester || '',
    reporter: f.reporter || '',
    assignee: f.assignee || '',
    additional_assignees: additionalAssignees,
    attachments: attachments,
  };

  var resp;
  try {
    resp = UrlFetchApp.fetch(s.appUrl + '/api/inbound/gmail-addon', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: { Authorization: 'Bearer ' + s.token },
      muteHttpExceptions: true,
    });
  } catch (err) {
    return notify_('Network error: ' + err.message);
  }

  var code = resp.getResponseCode();
  var body;
  try { body = JSON.parse(resp.getContentText() || '{}'); } catch (_) { body = {}; }
  if (code >= 200 && code < 300) {
    var label = body.duplicate ? ('Already created as ' + body.ticketId) : ('Ticket ' + body.ticketId + ' created');
    // Buttons must live inside a ButtonSet — adding a TextButton directly
    // as a section widget produces a "value cannot be used by the add-ons
    // platform" runtime error from Card Service.
    var openBtn = CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Open ticket')
        .setOpenLink(CardService.newOpenLink().setUrl(body.url || s.appUrl)));
    var success = CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle(label))
      .addSection(CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(
          body.attachments && body.attachments.rejected && body.attachments.rejected.length
            ? ('Note: ' + body.attachments.rejected.length + ' attachment(s) were skipped (size or type).')
            : 'Saved to your workspace.'
        ))
        .addWidget(openBtn));
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText(label))
      .setNavigation(CardService.newNavigation().pushCard(success.build()))
      .build();
  }
  if (code === 401) return notify_('Token rejected. Open Settings and re-paste it.');
  return notify_('Create failed (' + code + '): ' + (body.error || 'unknown error'));
}

// ─── Email → Personal Reminder ───────────────────────────────────────────────

function buildReminderFormCard_(messageId) {
  var msg = GmailApp.getMessageById(messageId);
  var subject = msg.getSubject() || '(no subject)';
  var fromRaw = msg.getFrom() || '';
  var atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];

  // Default the picker to tomorrow at 9am local. The CardService picker
  // wants epoch milliseconds; the timezone offset is the user's script TZ
  // so the time shown matches what the user expects.
  var tomorrow9 = new Date();
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Set reminder from email'));

  var preview = CardService.newCardSection()
    .addWidget(CardService.newKeyValue().setTopLabel('Subject').setContent(escapeHtml_(subject)))
    .addWidget(CardService.newKeyValue().setTopLabel('From').setContent(escapeHtml_(fromRaw || '(unknown)')));
  if (atts.length) {
    preview.addWidget(CardService.newKeyValue().setTopLabel('Attachments')
      .setContent(String(atts.length) + ' file' + (atts.length === 1 ? '' : 's') + ' will be attached'));
  }
  card.addSection(preview);

  var form = CardService.newCardSection();

  labeledRow_(form, 'Title',
    CardService.newTextInput().setFieldName('title').setValue(subject));

  labeledRow_(form, 'Notes (optional)',
    CardService.newTextInput().setFieldName('description').setMultiline(true)
      .setHint('Anything you want to remember about this email'));

  labeledRow_(form, 'When to remind me',
    CardService.newDateTimePicker().setFieldName('dueAt')
      .setValueInMsSinceEpoch(tomorrow9.getTime()));

  labeledRow_(form, 'Link to ticket (optional)',
    CardService.newTextInput().setFieldName('ticketId').setHint('e.g. TKT-1042'));

  // Three "how should I remind you" toggles, matching the in-app modal.
  // Multi-select CHECK_BOX with one item each so we get a clean
  // formInputs.<name> array per option.
  labeledRow_(form, 'How should I remind you?',
    CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('reminderOpts')
      .addItem('📧 Email me at the chosen time', 'email', true)
      .addItem('🔁 Keep emailing me daily until I mark it done', 'repeat', false)
      .addItem('📺 Show on screen once a day when I sign in', 'popup', false));

  card.addSection(form);

  var submit = CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Set Reminder')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction()
        .setFunctionName('createReminder_')
        .setParameters({ messageId: messageId })));
  card.addSection(CardService.newCardSection().addWidget(submit));

  return card.build();
}

function createReminder_(e) {
  authorizeGmail_(e);
  var s = getSettings_();
  if (!s.token || !s.appUrl) return notify_('Set the App URL and API token first.');
  var p = (e && e.parameters) || {};
  var messageId = (e && e.gmail && e.gmail.messageId) || p.messageId;
  if (!messageId) return notify_('No message selected.');

  var f = (e && e.formInput) || {};
  var fInputs = (e && e.formInputs) || {};

  // DateTimePicker returns its value via formInputs as either
  // { msSinceEpoch, hasDate, hasTime } or an array containing that — handle
  // both shapes since Apps Script has been inconsistent across runtime
  // versions.
  var dueRaw = fInputs.dueAt;
  if (Array.isArray(dueRaw)) dueRaw = dueRaw[0];
  var dueIso = '';
  if (dueRaw && typeof dueRaw === 'object' && dueRaw.msSinceEpoch) {
    dueIso = new Date(Number(dueRaw.msSinceEpoch)).toISOString();
  } else if (typeof dueRaw === 'string' && dueRaw) {
    dueIso = dueRaw;
  } else if (typeof f.dueAt === 'string' && f.dueAt) {
    dueIso = f.dueAt;
  }
  if (!dueIso) return notify_('Please pick a reminder date and time.');

  // Read the multi-checkbox state. Anything in the array → that option is on.
  var opts = fInputs.reminderOpts || [];
  if (!Array.isArray(opts)) opts = [opts];
  var emailEnabled    = opts.indexOf('email')  !== -1;
  var repeatDaily     = opts.indexOf('repeat') !== -1;
  var showDailyInApp  = opts.indexOf('popup')  !== -1;

  var msg;
  try { msg = GmailApp.getMessageById(messageId); }
  catch (err) { return notify_('Could not read message: ' + err.message); }

  var subject = (f.title || msg.getSubject() || '').toString().slice(0, 200);
  var fromRaw = msg.getFrom() || '';
  var fromName = '', fromEmail = '';
  var mFrom = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(fromRaw);
  if (mFrom) { fromName = (mFrom[1] || '').trim(); fromEmail = (mFrom[2] || '').trim(); }
  else { fromEmail = fromRaw.trim(); }

  var bodyText = msg.getPlainBody() || '';
  if (!bodyText) bodyText = htmlToText_(msg.getBody() || '');

  // Ship attachments through too — same caps as the ticket flow.
  var attachments = [];
  var files = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];
  var totalBytes = 0;
  var maxTotal = 40 * 1024 * 1024;
  var maxPer   = 20 * 1024 * 1024;
  for (var i = 0; i < files.length; i++) {
    var bytes = files[i].getBytes();
    if (bytes.length > maxPer) continue;
    if (totalBytes + bytes.length > maxTotal) break;
    attachments.push({
      name: files[i].getName(),
      mimeType: files[i].getContentType(),
      dataBase64: Utilities.base64Encode(bytes),
    });
    totalBytes += bytes.length;
  }

  // Same permalink-back-to-Gmail capture as createTicket_ does.
  var thread2 = msg.getThread();
  var emailUrl2 = '';
  try { emailUrl2 = thread2 ? thread2.getPermalink() : ''; } catch (_) { emailUrl2 = ''; }

  var payload = {
    subject: subject,
    from_name: fromName,
    from_email: fromEmail,
    body_text: bodyText,
    message_id: msg.getId(),
    email_url: emailUrl2,
    received_at: msg.getDate() ? msg.getDate().toISOString() : '',
    title: subject,
    description: f.description || '',
    due_at: dueIso,
    ticket_id: f.ticketId || '',
    email_enabled: emailEnabled,
    repeat_daily: repeatDaily,
    show_daily_in_app: showDailyInApp,
    attachments: attachments,
  };

  var resp;
  try {
    resp = UrlFetchApp.fetch(s.appUrl + '/api/inbound/gmail-reminder', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: { Authorization: 'Bearer ' + s.token },
      muteHttpExceptions: true,
    });
  } catch (err) { return notify_('Network error: ' + err.message); }

  var code = resp.getResponseCode(), body;
  try { body = JSON.parse(resp.getContentText() || '{}'); } catch (_) { body = {}; }
  if (code >= 200 && code < 300) {
    var label = 'Reminder set';
    var openBtn = CardService.newButtonSet()
      .addButton(CardService.newTextButton().setText('Open My Reminders')
        .setOpenLink(CardService.newOpenLink().setUrl(body.url || s.appUrl)));
    var success = CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle(label))
      .addSection(CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(
          body.attachments && body.attachments.rejected && body.attachments.rejected.length
            ? ('Note: ' + body.attachments.rejected.length + ' attachment(s) were skipped (size or type).')
            : 'Saved to your personal reminders.'))
        .addWidget(openBtn));
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText(label))
      .setNavigation(CardService.newNavigation().pushCard(success.build())).build();
  }
  if (code === 401) return notify_('Token rejected. Open Settings and re-paste it.');
  return notify_('Set-reminder failed (' + code + '): ' + (body.error || 'unknown error'));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSimpleCard_(title, text) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(title))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(text)))
    .build();
}

function notify_(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}

function escapeHtml_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Rough HTML-to-text: drop tags, collapse whitespace. Good enough when
// the sender forgot to include a text/plain part.
function htmlToText_(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
