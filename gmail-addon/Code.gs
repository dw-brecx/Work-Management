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
  // Contextual trigger: e.gmail.messageId is the message currently open
  // in Gmail. We don't fetch the full message here (cheap render); we
  // only do that when the user clicks "Create Ticket".
  var settings = getSettings_();
  if (!settings.token || !settings.appUrl) {
    return [ buildSettingsCard_('Add your API token to start creating tickets.') ];
  }
  var messageId = e && e.gmail && e.gmail.messageId;
  if (!messageId) {
    return [ buildSimpleCard_('Open an email', 'Select an email to create a ticket from it.') ];
  }
  return [ buildMessageCard_(messageId) ];
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

function buildMessageCard_(messageId) {
  var msg = GmailApp.getMessageById(messageId);
  var subject = msg.getSubject() || '(no subject)';
  var fromRaw = msg.getFrom() || '';
  var fromName = '', fromEmail = '';
  // Gmail-style "Name <email@host>" parser. Falls back to a bare address.
  var m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(fromRaw);
  if (m) { fromName = (m[1] || '').trim(); fromEmail = (m[2] || '').trim(); }
  else { fromEmail = fromRaw.trim(); }
  var atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Create ticket from email'));

  var preview = CardService.newCardSection()
    .addWidget(CardService.newKeyValue().setTopLabel('Subject').setContent(escapeHtml_(subject)))
    .addWidget(CardService.newKeyValue().setTopLabel('From').setContent(escapeHtml_(fromRaw || '(unknown)')));
  if (atts.length) {
    preview.addWidget(CardService.newKeyValue().setTopLabel('Attachments').setContent(String(atts.length) + ' file' + (atts.length === 1 ? '' : 's')));
  }
  card.addSection(preview);

  // Optional overrides — the user can leave these blank and let the app
  // apply its defaults. Title pre-fills with the subject; priority and
  // due are blank by default.
  var form = CardService.newCardSection().setHeader('Optional');
  form.addWidget(CardService.newTextInput()
    .setFieldName('title').setTitle('Title').setValue(subject));
  form.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('priority').setTitle('Priority')
    .addItem('Low', 'Low', false)
    .addItem('Medium', 'Medium', true)
    .addItem('High', 'High', false)
    .addItem('Critical', 'Critical', false));
  form.addWidget(CardService.newTextInput()
    .setFieldName('dept').setTitle('Department').setHint('e.g. Engineering, Support, General'));
  form.addWidget(CardService.newTextInput()
    .setFieldName('due').setTitle('Due date').setHint('YYYY-MM-DD (optional)'));
  form.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('includeAttachments')
    .addItem('Include attachments (' + atts.length + ')', 'yes', atts.length > 0));
  card.addSection(form);

  var go = CardService.newCardSection()
    .addWidget(CardService.newTextButton()
      .setText('Create Ticket')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction()
        .setFunctionName('createTicket_')
        .setParameters({ messageId: messageId })));
  card.addSection(go);

  return card.build();
}

function createTicket_(e) {
  var s = getSettings_();
  if (!s.token || !s.appUrl) {
    return notify_('Set the App URL and API token first.');
  }
  var p = (e && e.parameters) || {};
  var messageId = p.messageId;
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

  // Decide whether to ship attachments. The checkbox returns either an
  // array (multi-select) or a single string; treat both as "checked = include".
  var includeAtt = (function () {
    var v = f.includeAttachments;
    if (v == null) return false;
    if (typeof v === 'string') return v === 'yes';
    if (Array.isArray(v)) return v.indexOf('yes') !== -1;
    return Boolean(v);
  })();

  var attachments = [];
  if (includeAtt) {
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
  }

  var payload = {
    subject: subject,
    from_name: fromName,
    from_email: fromEmail,
    body_text: bodyText,
    message_id: msg.getId(),
    thread_id: msg.getThread() ? msg.getThread().getId() : '',
    received_at: msg.getDate() ? msg.getDate().toISOString() : '',
    priority: f.priority || 'Medium',
    dept: f.dept || '',
    due: f.due || '',
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
    var success = CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle(label))
      .addSection(CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(
          body.attachments && body.attachments.rejected && body.attachments.rejected.length
            ? ('Note: ' + body.attachments.rejected.length + ' attachment(s) were skipped (size or type).')
            : 'Saved to your workspace.'
        ))
        .addWidget(CardService.newTextButton()
          .setText('Open ticket')
          .setOpenLink(CardService.newOpenLink().setUrl(body.url || s.appUrl))));
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText(label))
      .setNavigation(CardService.newNavigation().pushCard(success.build()))
      .build();
  }
  if (code === 401) return notify_('Token rejected. Open Settings and re-paste it.');
  return notify_('Create failed (' + code + '): ' + (body.error || 'unknown error'));
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
