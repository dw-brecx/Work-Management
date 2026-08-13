# Work-Management

Internal ticketing / work-management app (tickets, projects, subtasks, comments,
timelines, attachments, reminders, flavors, spaces, chat). Node.js + Express +
PostgreSQL, plain-HTML frontend served from `public/`.

This README documents the **External API** — how another application can read
ticket data out of Work-Management using an API key.

---

## External API

A read-only HTTP API, authenticated with personal API keys instead of a browser
session. A key acts as its owner: it sees exactly the tickets that user can see
in the app (Admins see everything; everyone else sees tickets they are involved
in as assignee, reporter, requester, creator, or watcher).

### 1. Get an API key

1. Log in to the app.
2. Open **Settings → 🔑 API Access** (or **sidebar → Build → API Keys**).
3. Click **＋ New key**, name it after the app that will use it.
4. **Copy the key immediately** — the full `wm_live_…` value is shown exactly
   once. Only a SHA-256 hash is stored server-side; if you lose the key,
   revoke it and create a new one.

Store the key in the other app's environment variables or secrets manager.
Never commit it to source control or ship it in client-side code — anyone
holding the key can read your tickets. Revoking a key (same page) cuts off
access immediately.

### 2. Authenticate requests

Send the key on **every** request, either way works:

```
Authorization: Bearer wm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

or

```
X-API-Key: wm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Missing, invalid, or revoked keys get `401 {"error": "..."}`.

### 3. Endpoints

Base URL is wherever the app is hosted, e.g. `https://your-app.onrender.com`.

#### `GET /api/v1/tickets` — list tickets

Compact list of every ticket the key can see, newest first. Use it to discover
ticket ids.

Query parameters:

| Param    | Description                                          |
|----------|------------------------------------------------------|
| `status` | Optional exact-match filter, e.g. `?status=Open`     |

Example:

```bash
curl -H "Authorization: Bearer $WM_API_KEY" \
  https://your-app.example.com/api/v1/tickets?status=Open
```

Response:

```json
{
  "tickets": [
    {
      "id": "TKT-1001",
      "title": "API test ticket",
      "status": "Open",
      "priority": "High",
      "dept": "Engineering",
      "due": "",
      "created_at": "2026-08-12 18:31:44",
      "assignee": "Jane Doe",
      "reporter": "Admin"
    }
  ]
}
```

#### `GET /api/v1/tickets/:id` — everything about one ticket

The whole ticket in a single response: the ticket record, description +
checklist, all comments (with their attachments), the activity timeline,
subtasks, and file attachments.

```bash
curl -H "Authorization: Bearer $WM_API_KEY" \
  https://your-app.example.com/api/v1/tickets/TKT-1001
```

Response shape:

```json
{
  "ticket": {
    "id": "TKT-1001",
    "title": "API test ticket",
    "status": "Open",
    "priority": "High",
    "dept": "Engineering",
    "assignee": "Jane Doe",
    "assignees": ["Jane Doe", "Bob"],
    "reporter": "Admin",
    "req": "Customer name",
    "due": "2026-08-20",
    "created_at": "2026-08-12 18:31:44",
    "tags": ["hardware"],
    "overdue": false,
    "comments": 3,
    "parentTicketId": null,
    "isProject": false,
    "childCount": 0,
    "closeReason": ""
  },
  "details": {
    "description": "Full description text…",
    "checklist": []
  },
  "comments": [
    {
      "id": 1,
      "parentId": null,
      "author": "Admin",
      "text": "First comment",
      "createdAt": "2026-08-12 18:32:01",
      "attachments": [
        {
          "id": 5,
          "originalName": "photo.jpg",
          "mimeType": "image/jpeg",
          "size": 123456,
          "uploader": "Admin",
          "url": "https://your-app.example.com/uploads/abc123.jpg"
        }
      ]
    }
  ],
  "timeline": [
    { "id": 2, "text": "Admin commented", "createdAt": "2026-08-12 18:32:01", "sub": "Aug 12, 2026, 6:32 PM" },
    { "id": 1, "text": "Ticket created by Admin", "createdAt": "2026-08-12 18:31:44", "sub": "Aug 12, 2026, 6:31 PM" }
  ],
  "subtasks": [
    { "id": 1, "position": 1, "text": "step one", "done": false, "assignee": "Jane Doe", "due": "", "priority": "" }
  ],
  "attachments": [
    {
      "id": 6,
      "filename": "def456.pdf",
      "originalName": "spec.pdf",
      "mimeType": "application/pdf",
      "size": 88231,
      "uploader": "Admin",
      "commentId": null,
      "createdAt": "2026-08-12 18:35:10",
      "url": "https://your-app.example.com/uploads/def456.pdf"
    }
  ]
}
```

Notes:

- Timestamps are UTC, formatted `YYYY-MM-DD HH:MM:SS`.
- A ticket the key's owner cannot see returns `404 {"error":"Not found"}` —
  identical to a nonexistent id, so ids cannot be probed.
- Attachment `url` values are absolute when the server has the `APP_URL`
  environment variable set (recommended); otherwise they are origin-relative
  paths like `/uploads/abc123.jpg` that you must prefix with the base URL.
- The `/api/v1` surface is **read-only** — there are no write endpoints.

#### Key management (session-authenticated, used by the API Keys page)

These require a logged-in browser session, not an API key:

| Method   | Path                | Description                                    |
|----------|---------------------|------------------------------------------------|
| `GET`    | `/api/api-keys`     | List your active keys (prefix only, no secret) |
| `POST`   | `/api/api-keys`     | `{ "name": "…" }` → creates a key; response includes the plaintext `key` **once** |
| `DELETE` | `/api/api-keys/:id` | Revoke one of your keys (immediate)            |

### 4. Integrating from another app

**Node.js**

```js
const BASE = process.env.WM_BASE_URL;   // e.g. https://your-app.onrender.com
const KEY  = process.env.WM_API_KEY;    // wm_live_…

async function getTicket(id) {
  const res = await fetch(`${BASE}/api/v1/tickets/${id}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (res.status === 404) return null;          // no such ticket / no access
  if (!res.ok) throw new Error(`WM API ${res.status}`);
  return res.json();                            // { ticket, details, comments, … }
}

async function listOpenTickets() {
  const res = await fetch(`${BASE}/api/v1/tickets?status=Open`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`WM API ${res.status}`);
  return (await res.json()).tickets;
}
```

**Python**

```python
import os, requests

BASE = os.environ["WM_BASE_URL"]
HEADERS = {"Authorization": f"Bearer {os.environ['WM_API_KEY']}"}

def list_tickets(status=None):
    params = {"status": status} if status else {}
    r = requests.get(f"{BASE}/api/v1/tickets", headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()["tickets"]

def get_ticket(ticket_id):
    r = requests.get(f"{BASE}/api/v1/tickets/{ticket_id}", headers=HEADERS)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()
```

### 5. Error reference

| Status | Meaning                                                            |
|--------|--------------------------------------------------------------------|
| `401`  | Missing, malformed, invalid, or revoked API key                    |
| `404`  | Ticket doesn't exist **or** the key's owner can't see it           |
| `500`  | Server error — response body contains `{ "error": "…" }`           |

---

## Development

```bash
npm install
DATABASE_URL=postgresql://localhost/syruvia node server.js
```

The schema (including the `api_keys` table) is created automatically on boot.
Relevant environment variables: `DATABASE_URL`, `SESSION_SECRET` (required in
production), `APP_URL` (used to build absolute attachment URLs in API
responses), `PORT`.
