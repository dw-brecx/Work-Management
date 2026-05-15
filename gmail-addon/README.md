# Gmail Add-on — Email → Ticket

A Gmail sidebar add-on that turns an open email into a Work-Management ticket
in one click. Lives entirely on Google Apps Script — the only thing the app
itself exposes is the `POST /api/inbound/gmail-addon` endpoint the add-on
calls (Bearer-token authenticated, one token per user).

## What's in here

| File              | Purpose                                                                 |
|-------------------|-------------------------------------------------------------------------|
| `Code.gs`         | Apps Script source: contextual trigger, settings card, ticket creation. |
| `appsscript.json` | Add-on manifest — scopes, trigger registration, name, icon.             |
| `README.md`       | This file.                                                              |

## Install (manual — recommended for personal / team use)

1. Sign in at the app's **Email → Ticket setup page** (`/email-to-ticket.html`)
   and click **Generate token**. Copy the token immediately — it's only shown
   once.
2. Open <https://script.google.com> and click **New project**.
3. Paste the contents of `Code.gs` over the default `Code.gs` content. Save.
4. Click the gear (**Project Settings**) and tick
   **Show "appsscript.json" manifest file in editor**.
5. Open `appsscript.json` from the file list and paste in the contents of
   the file from this directory. Save.
6. Click **Deploy → Test deployments**, choose **Gmail**, click **Install**.
7. Reload Gmail (web). Open any email. The add-on icon appears in the right
   sidebar.
8. Click it, then click **Settings** (the gear at the top of the card). Paste
   your **App URL** (e.g. `https://your-workspace.example.com`) and the
   **API token**. Click **Save**, then **Test connection**.
9. Open an email, click the add-on icon, click **Create Ticket**. Done.

The first time you create a ticket Google will ask you to authorize the
add-on. The only scopes it asks for are:

- read the **currently-open** message (subject, body, sender, attachments) —
  the add-on can't read the rest of your mailbox.
- send outbound HTTPS to your App URL.
- read your Google account's email address (used for identification only).

## Install (clasp — for developers)

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "Email to Ticket"
# Replace the generated files with the ones from this directory:
cp Code.gs <clasp-project>/Code.js   # clasp renames .gs → .js locally
cp appsscript.json <clasp-project>/appsscript.json
cd <clasp-project>
clasp push
clasp open                            # opens the script in your browser
# In the Apps Script editor: Deploy → Test deployments → Gmail → Install
```

## How the round-trip works

```
   [Gmail web]                       [Apps Script]                  [App]
        │                                  │                          │
        │  open an email                   │                          │
        ├─────────────────────────────────►│                          │
        │  click "Create Ticket"           │                          │
        ├─────────────────────────────────►│  POST /api/inbound/      │
        │                                  │  gmail-addon             │
        │                                  │  (Bearer: wm_...)        │
        │                                  ├─────────────────────────►│
        │                                  │                          │ create ticket
        │                                  │                          │ persist attachments
        │                                  │◄─────────────────────────┤
        │  show "Ticket TKT-1234 created"  │   { ticketId, url }      │
        │◄─────────────────────────────────┤                          │
```

## Idempotency

Each Gmail message has a stable `Message-Id`. The endpoint stores it on the
ticket (`tickets.source_email_id`) and returns the existing ticket id if you
click "Create Ticket" a second time on the same email. Safe to retry on a
network error.

## Limits

- Per attachment: **20 MB**
- Total per email: **40 MB**
- Mime allow-list matches the app's regular upload route (images, PDFs,
  Office docs, plain text, audio/video, zips). Anything else is silently
  skipped.

## Revoking access

- Remove the **API token** from the app's setup page → the add-on stops
  working but stays installed.
- Uninstall the **add-on**: Gmail Settings → Add-ons → Manage → Uninstall.
