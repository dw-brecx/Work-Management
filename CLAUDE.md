# Working agreements for this repo

## Never push without explicit approval

Do NOT run `git push` (or any remote-changing git command) until I explicitly
say so in the current session. "Approval" means a clear instruction like
"push it", "ship it", "push to origin", etc. — not just "looks good" or
"that works". This applies to every session, every branch, including the
designated feature branch.

Same rule for: `gh pr create`, force-pushes, branch deletions on the
remote, merging PRs.

Local commits are fine without asking, but pause before anything that
leaves my machine.

## Keep `public/index.html` small

`public/index.html` is already very large (25k+ lines). Don't add new
features to it. For every new feature from now on:

- Create a new standalone HTML page under `public/` (pattern: a tiny
  shell HTML that loads its own `.css` and `.js`, like `flavors.html` /
  `apps.html` / `recurring.html`).
- Wire it into the sidebar nav with `onclick="window.location.href='/<name>.html'"`
  (the Flavors nav item is the model).
- Server side: the existing `express.static` middleware serves
  `/<name>.html` from `public/<name>.html` automatically — no extra
  route needed unless you want a pretty URL like `/recurring` instead of
  `/recurring.html`.
- Auth-check the page on load via `GET /api/auth/me` and redirect to
  `/login.html` on 401.

Only touch `index.html` for the sidebar nav entry that links out to the
new page, or for genuinely cross-cutting changes (shared CSS variables,
theme tokens, the modal pattern itself, etc.).
