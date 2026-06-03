'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');
let XLSX = null;
try { XLSX = require('xlsx'); } catch { /* optional until installed */ }

const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');

// ── Helpers ────────────────────────────────────────────────────────────────

// Pull the 10-char ASIN out of any Amazon URL shape (/dp/, /gp/product/,
// /product-reviews/, ?asin=).
function extractAsin(url) {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/product-reviews\/([A-Z0-9]{10})/i,
    /[?&]asin=([A-Z0-9]{10})/i,
    /\/([A-Z0-9]{10})(?:[/?]|$)/i,
  ];
  for (const re of patterns) { const m = url.match(re); if (m) return m[1].toUpperCase(); }
  return '';
}

// Which amazon domain the link is on (so reviews paginate on the same TLD).
function amazonOrigin(url) {
  try { const u = new URL(url); if (/amazon\./i.test(u.hostname)) return u.origin; } catch {}
  return 'https://www.amazon.com';
}

function isoDate(raw) {
  if (!raw) return '';
  // "Reviewed in the United States on March 5, 2024" → 2024-03-05
  const m = String(raw).match(/on\s+(.+)$/i);
  const candidate = m ? m[1] : raw;
  const d = new Date(candidate);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// ── Claude clean-up (optional) ───────────────────────────────────────────────
// One batched call: tidy bodies, normalise dates, and infer regular vs
// sugar-free from each review's "format strip" text. Skipped if no API key.
async function callClaude(system, user, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Claude API ' + res.status + ': ' + t.slice(0, 200));
  }
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}

async function normalizeWithClaude(reviews, ctx) {
  const system =
    'You normalise scraped Amazon reviews for a syrup brand. Given a JSON array of raw reviews, ' +
    'return ONLY a JSON array (no prose, no markdown fences) where each item has: ' +
    'rating (integer 1-5), title (string), body (string, plain text), reviewer_name (string), ' +
    'posted_at (YYYY-MM-DD or ""), verified (boolean), ' +
    "variant ('regular' or 'sugar_free' — infer from the format/size text; default 'regular'). " +
    'Drop entries that have neither a title nor a body. Keep the order.';
  const user =
    `Flavor being reviewed: ${ctx.flavorName || '(unknown)'}\n` +
    `Raw reviews JSON:\n${JSON.stringify(reviews).slice(0, 90000)}`;
  const out = await callClaude(system, user, 8000);
  if (!out) return null;
  const cleaned = out.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { const arr = JSON.parse(cleaned); return Array.isArray(arr) ? arr : null; }
  catch { return null; }
}

// Pure-JS fallback normalisation (no API key needed).
function jsNormalize(reviews, ctx) {
  return reviews
    .filter(r => (r.title || r.body))
    .map(r => {
      const fmt = (r.formatStrip || '').toLowerCase();
      const variant = /sugar[\s-]?free|\bsf\b|zero sugar/.test(fmt)
        ? 'sugar_free'
        : (ctx.variant || 'regular');
      return {
        rating: r.rating ? Math.round(r.rating) : null,
        title: (r.title || '').trim(),
        body: (r.body || '').trim(),
        reviewer_name: (r.author || '').trim(),
        posted_at: isoDate(r.dateRaw),
        verified: !!r.verified,
        variant,
      };
    });
}

// ── In-page extraction (runs in the browser) ─────────────────────────────────
async function extractReviewsFromPage(page) {
  return page.$$eval('[data-hook="review"], div[id^="customer_review"]', (nodes) => {
    const txt = (el, sel) => { const n = el.querySelector(sel); return n ? n.textContent.trim() : ''; };
    return nodes.map(el => {
      const ratingRaw =
        txt(el, '[data-hook="review-star-rating"] .a-icon-alt') ||
        txt(el, '[data-hook="cmps-review-star-rating"] .a-icon-alt') ||
        txt(el, 'i.review-rating .a-icon-alt');
      const m = ratingRaw.match(/([0-9.]+)\s*out of\s*5/i);
      return {
        rating: m ? parseFloat(m[1]) : null,
        title: txt(el, '[data-hook="review-title"] span:last-child') || txt(el, '[data-hook="review-title"]'),
        body: txt(el, '[data-hook="review-body"] span') || txt(el, '[data-hook="review-body"]'),
        author: txt(el, '.a-profile-name'),
        dateRaw: txt(el, '[data-hook="review-date"]'),
        verified: !!el.querySelector('[data-hook="avp-badge"]'),
        formatStrip: txt(el, '[data-hook="format-strip"]') || txt(el, '.review-format-strip'),
        id: el.id || '',
      };
    });
  });
}

// True when Amazon is showing a sign-in wall, CAPTCHA, or "robot" check.
async function looksBlocked(page) {
  const url = page.url();
  if (/\/ap\/signin|\/errors\/validateCaptcha/i.test(url)) return true;
  const body = (await page.title().catch(() => '')) + ' ' + (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
  return /Enter the characters you see|Type the characters|not a robot|Sign in|continue shopping/i.test(body)
    && !/customer reviews/i.test(body);
}

// ── Main gather routine ───────────────────────────────────────────────────────
async function gatherReviews(opts, onProgress) {
  const log = (msg) => { try { onProgress && onProgress(msg); } catch {} };
  const url = String(opts.url || '').trim();
  const asin = extractAsin(url);
  if (!asin) throw new Error('Could not find an ASIN in that link. Paste a full Amazon product or reviews URL.');
  const origin = amazonOrigin(url);
  const maxPages = Math.max(1, Math.min(100, parseInt(opts.maxPages, 10) || 10));
  const headless = !!opts.headless;
  const flavorName = (opts.flavorName || '').trim();
  const variant = opts.variant === 'sugar_free' ? 'sugar_free' : 'regular';

  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  log(`ASIN ${asin} · opening a browser${headless ? ' (headless)' : ' (visible — log in / solve any CAPTCHA there if asked)'}…`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'en-US',
  });

  const seen = new Set();
  const raw = [];
  try {
    const page = context.pages()[0] || await context.newPage();
    for (let p = 1; p <= maxPages; p++) {
      const reviewsUrl = `${origin}/product-reviews/${asin}/?reviewerType=all_reviews&sortBy=recent&pageNumber=${p}`;
      log(`Page ${p}: ${reviewsUrl}`);
      await page.goto(reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Give the user a chance to clear a sign-in / CAPTCHA wall by hand.
      if (await looksBlocked(page)) {
        log('Amazon wants a sign-in or CAPTCHA. Solve it in the browser window — waiting up to 3 min…');
        await page.waitForSelector('[data-hook="review"]', { timeout: 180000 }).catch(() => {});
      }

      await page.waitForSelector('[data-hook="review"]', { timeout: 8000 }).catch(() => {});
      const pageReviews = await extractReviewsFromPage(page);
      const fresh = pageReviews.filter(r => {
        const k = (r.author || '') + '|' + (r.dateRaw || '') + '|' + (r.body || '').slice(0, 60);
        if (seen.has(k)) return false; seen.add(k); return true;
      });
      raw.push(...fresh);
      log(`Page ${p}: +${fresh.length} review(s) · ${raw.length} total`);

      if (!pageReviews.length) { log('No reviews on this page — stopping.'); break; }
      // Polite pause so we behave like a person, not a hammer.
      await page.waitForTimeout(1200 + Math.floor(Math.random() * 900));
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (!raw.length) {
    throw new Error('No reviews captured. The page may have been behind a sign-in/CAPTCHA, or this listing has no reviews. Try again with a visible browser and sign in.');
  }

  // Clean-up pass: Claude if a key is set, otherwise pure-JS.
  let reviews = null;
  if (process.env.ANTHROPIC_API_KEY) {
    log('Cleaning up with Claude (variant tagging, dates, tidying)…');
    try { reviews = await normalizeWithClaude(raw, { flavorName }); } catch (e) { log('Claude pass failed (' + e.message + ') — using plain parsing.'); }
  }
  if (!reviews) reviews = jsNormalize(raw, { flavorName, variant });

  // Stamp shared fields + dedupe again on the normalised shape.
  const finalSeen = new Set();
  reviews = reviews
    .map(r => ({
      asin,
      flavor_name: flavorName,
      variant: r.variant || variant,
      rating: r.rating || null,
      title: r.title || '',
      body: r.body || '',
      reviewer_name: r.reviewer_name || '',
      posted_at: r.posted_at || '',
      verified: r.verified ? 'yes' : 'no',
      source: 'Amazon',
      url: `${origin}/dp/${asin}`,
    }))
    .filter(r => {
      const k = r.reviewer_name + '|' + r.posted_at + '|' + r.body.slice(0, 60);
      if (finalSeen.has(k)) return false; finalSeen.add(k); return true;
    });

  log(`Done: ${reviews.length} review(s) ready.`);
  const file = exportFiles(reviews, { asin, flavorName });
  return { asin, count: reviews.length, file, reviews };
}

// ── Output files ─────────────────────────────────────────────────────────────
function exportFiles(reviews, meta) {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${meta.asin || 'reviews'}-${stamp}`;
  const cols = ['asin', 'flavor_name', 'variant', 'rating', 'title', 'body', 'reviewer_name', 'posted_at', 'verified', 'source', 'url'];

  // CSV (always — no extra dependency).
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.join(',')].concat(reviews.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
  const csvPath = path.join(DOWNLOAD_DIR, base + '.csv');
  fs.writeFileSync(csvPath, csv, 'utf8');

  // Excel if xlsx is installed.
  if (XLSX) {
    try {
      const ws = XLSX.utils.json_to_sheet(reviews, { header: cols });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Reviews');
      XLSX.writeFile(wb, path.join(DOWNLOAD_DIR, base + '.xlsx'));
      return base + '.xlsx';
    } catch { /* fall back to CSV name */ }
  }
  return base + '.csv';
}

module.exports = { gatherReviews, extractAsin, DOWNLOAD_DIR };
