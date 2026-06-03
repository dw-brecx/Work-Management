# Review Agent (local)

A small app you run **on your own computer**. Paste a flavor's Amazon link and
it opens a **real Chrome window using your own Amazon session**, walks through
every reviews page like a person, and writes all the reviews to a file
(`.xlsx` / `.csv`) you can upload into the Flavor Reviews app.

The instructions are baked in — you don't explain anything each time. Paste a
link, click **Gather reviews**, download the file.

> Use this only for **your own listings**. It drives your real browser session
> (no stealth/evasion), pauses politely between pages, and respects whatever
> you're signed into. You are responsible for staying within Amazon's terms.

---

## One-time setup

You need **Node.js 18+** installed (https://nodejs.org).

```bash
cd review-agent
npm install          # installs express, playwright, xlsx
npm run setup        # downloads the Chromium browser Playwright drives
```

(Optional) Turn on the Claude clean-up pass — it tidies review text, fixes
dates, and tags each review regular vs sugar-free:

```bash
cp .env.example .env
# then edit .env and paste your ANTHROPIC_API_KEY
```

Without a key it still works; it just uses plain parsing instead of Claude.

---

## Using it

```bash
npm start
```

Open **http://localhost:4577** in your browser.

1. Paste the flavor's Amazon link (product page or reviews page — either works).
2. (Optional) Type the flavor name and pick Regular / Sugar-free — these get
   stamped onto every row so the file slots straight into Flavor Reviews.
3. Leave **"Run hidden" unchecked** the first time. A Chrome window opens — if
   Amazon asks you to sign in or solve a CAPTCHA, do it in that window; the
   agent waits, then continues. Your login is remembered for next time, so
   later runs can be hidden (headless) if you like.
4. Watch the progress log. When it finishes, click **Download file**.
5. In Flavor Reviews, use the Excel/CSV import to upload it.

---

## What you get

A spreadsheet with one row per review:

| asin | flavor_name | variant | rating | title | body | reviewer_name | posted_at | verified | source | url |
|------|-------------|---------|--------|-------|------|---------------|-----------|----------|--------|-----|

Files are saved in `review-agent/downloads/` as well, so you always have them.

---

## Notes & troubleshooting

- **"No reviews captured"** — almost always a sign-in/CAPTCHA wall. Re-run with
  the browser **visible**, sign in, and let it continue. Once signed in, the
  session is saved in `.browser-profile/` for future runs.
- **Amazon changes its page layout** from time to time. The agent uses several
  fallback selectors; if a future change breaks extraction, the field names to
  update live in `lib/gather.js` → `extractReviewsFromPage`.
- **Max pages** caps how far it paginates (10 pages ≈ 100 reviews). Raise it for
  listings with lots of reviews.
- Nothing is sent anywhere except (optionally) the review text to Anthropic for
  the clean-up pass. The browsing happens entirely on your machine.
