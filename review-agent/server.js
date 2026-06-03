'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

// Tiny .env loader (no dependency): load KEY=VALUE lines from ./.env if present.
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const { gatherReviews, DOWNLOAD_DIR } = require('./lib/gather');

const app = express();
const PORT = Number(process.env.PORT || 4577);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Server-Sent-Events gather stream: the browser opens an EventSource and we
// push a line per progress step, then a final "done" (or "error") event.
app.get('/api/gather', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onProgress = (msg) => send('progress', { msg });

  try {
    const result = await gatherReviews({
      url: String(req.query.url || ''),
      maxPages: req.query.maxPages,
      headless: req.query.headless === '1',
      flavorName: req.query.flavorName,
      variant: req.query.variant,
    }, onProgress);
    send('done', { count: result.count, asin: result.asin, file: result.file, downloadUrl: '/downloads/' + encodeURIComponent(result.file) });
  } catch (e) {
    send('error', { msg: e.message });
  } finally {
    res.end();
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, claude: !!process.env.ANTHROPIC_API_KEY }));

app.listen(PORT, () => {
  console.log('');
  console.log('  Review Agent running →  http://localhost:' + PORT);
  console.log('  Claude clean-up: ' + (process.env.ANTHROPIC_API_KEY ? 'ON' : 'OFF (set ANTHROPIC_API_KEY to enable)'));
  console.log('  Open that URL, paste a flavor\'s Amazon link, click Gather.');
  console.log('');
});
