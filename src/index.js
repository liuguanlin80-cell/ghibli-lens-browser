const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 3000;
const LENS_TOKEN = (process.env.LENS_TOKEN || '').trim();
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 45000);
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 20000);
const PAGE_LOAD_WAIT_MS = Number(process.env.PAGE_LOAD_WAIT_MS || 6000);
const MAX_NAVIGATION_RETRIES = Number(process.env.MAX_NAVIGATION_RETRIES || 2);
const MAX_RESULTS = 10;
const GOOGLE_UPLOAD_ENDPOINT = 'https://www.google.com/searchbyimage/upload?hl=zh-CN';

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    protocolTimeout: NAVIGATION_TIMEOUT_MS + 20000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  return browserInstance;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function isExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    if (h === 'google.com' || h.endsWith('.google.com') ||
        h.endsWith('.gstatic.com') || h.endsWith('.googleusercontent.com') ||
        h.endsWith('.doubleclick.net')) return false;
    return true;
  } catch {
    return false;
  }
}

function toAbsoluteGoogleUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  if (value.startsWith('/')) return `https://www.google.com${value}`;
  return '';
}

function parseSetCookieHeader(rawCookie) {
  if (!rawCookie || typeof rawCookie !== 'string') return null;
  const segments = rawCookie.split(';').map((v) => v.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  const firstEq = segments[0].indexOf('=');
  if (firstEq <= 0) return null;

  const cookie = {
    name: segments[0].slice(0, firstEq),
    value: segments[0].slice(firstEq + 1),
    domain: 'google.com',
    path: '/',
    secure: false,
    httpOnly: false,
  };

  for (let i = 1; i < segments.length; i += 1) {
    const part = segments[i];
    const eq = part.indexOf('=');
    const key = (eq > -1 ? part.slice(0, eq) : part).toLowerCase();
    const value = eq > -1 ? part.slice(eq + 1) : '';

    if (key === 'domain') cookie.domain = value.replace(/^\./, '').toLowerCase() || cookie.domain;
    if (key === 'path') cookie.path = value || cookie.path;
    if (key === 'expires') {
      const unix = Math.floor(Date.parse(value) / 1000);
      if (!Number.isNaN(unix)) cookie.expires = unix;
    }
    if (key === 'secure') cookie.secure = true;
    if (key === 'httponly') cookie.httpOnly = true;
    if (key === 'samesite') {
      const normalized = value.toLowerCase();
      if (normalized === 'none') cookie.sameSite = 'None';
      if (normalized === 'lax') cookie.sameSite = 'Lax';
      if (normalized === 'strict') cookie.sameSite = 'Strict';
    }
  }

  return cookie;
}

async function uploadImageToLens(imageBuffer, contentType) {
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const fileName = `upload.${ext}`;
  const formData = new FormData();
  formData.set('hl', 'zh-CN');
  formData.set('image_content', '');
  formData.set('filename', fileName);
  formData.set('encoded_image', new Blob([imageBuffer], { type: contentType }), fileName);

  const uploadResponse = await fetch(GOOGLE_UPLOAD_ENDPOINT, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    body: formData,
  });

  const location = uploadResponse.headers.get('location');
  const lensUrl = toAbsoluteGoogleUrl(location);
  if (!lensUrl) {
    throw new Error(`Google upload did not return redirect URL (status ${uploadResponse.status}).`);
  }

  let rawCookies = [];
  if (typeof uploadResponse.headers.getSetCookie === 'function') {
    rawCookies = uploadResponse.headers.getSetCookie();
  } else {
    const single = uploadResponse.headers.get('set-cookie');
    if (single) rawCookies = [single];
  }

  const cookies = rawCookies
    .map((entry) => parseSetCookieHeader(entry))
    .filter(Boolean);

  return { lensUrl, cookies };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gotoWithRetries(page, url) {
  let lastError = null;
  const maxAttempts = Math.max(1, MAX_NAVIGATION_RETRIES + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const waitUntil = attempt === 1 ? 'networkidle2' : 'domcontentloaded';
    try {
      await page.goto(url, { waitUntil, timeout: NAVIGATION_TIMEOUT_MS });
      await sleep(PAGE_LOAD_WAIT_MS);
      const finalUrl = page.url();
      const title = await page.title();
      if (finalUrl.startsWith('chrome-error://')) {
        throw new Error(`Chromium navigated to ${finalUrl} (title=${title || 'n/a'})`);
      }
      return { finalUrl, title, attempt };
    } catch (error) {
      lastError = error;
      console.warn('[lens] navigation attempt failed:', attempt, error && error.message ? error.message : error);
      if (attempt < maxAttempts) {
        await sleep(800 * attempt);
      }
    }
  }

  throw lastError || new Error('Navigation failed for unknown reason.');
}

async function searchGoogleLens(imageBuffer, contentType) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const failedRequests = [];

  try {
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.on('requestfailed', (request) => {
      if (failedRequests.length >= 8) return;
      failedRequests.push({
        url: request.url(),
        method: request.method(),
        reason: request.failure() ? request.failure().errorText : 'UNKNOWN',
      });
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    await page.setViewport({ width: 1280, height: 900 });

    const uploaded = await uploadImageToLens(imageBuffer, contentType);
    if (uploaded.cookies.length > 0) {
      await page.setCookie(...uploaded.cookies);
    }
    const nav = await gotoWithRetries(page, uploaded.lensUrl);

    const lensUrl = page.url();
    const title = await page.title();
    console.log('[lens] URL:', lensUrl, 'Title:', title, 'Attempt:', nav.attempt);
    if (failedRequests.length > 0) {
      console.log('[lens] failed requests sample:', JSON.stringify(failedRequests));
    }

    // Handle Google consent dialog if present
    try {
      const cb = await page.$('button[id="L2AGLb"], [aria-label="Accept all"]');
      if (cb) {
        console.log('[lens] Accepting consent...');
        await cb.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await sleep(2000);
      }
    } catch {}

    const pageHtml = await page.content();
    const lowerHtml = pageHtml.toLowerCase();
    if (lensUrl.includes('/sorry/') || lowerHtml.includes('detected unusual traffic')) {
      return {
        ok: false,
        results: [],
        lensUrl,
        code: 'GOOGLE_BLOCKED',
        message: 'Google is blocking this server IP with a verification page.',
      };
    }

    const results = await page.evaluate((maxResults) => {
      const items = [];
      const seen = new Set();

      // Strategy 1: Extract external links from result cards
      const cards = document.querySelectorAll('a[href*="http"]');
      for (const card of cards) {
        const href = card.href;
        if (!href) continue;
        try {
          const p = new URL(href);
          const h = p.hostname.toLowerCase();
          if (h === 'google.com' || h.endsWith('.google.com') ||
              h.endsWith('.gstatic.com') || h.endsWith('.googleusercontent.com')) continue;
          if (p.protocol !== 'http:' && p.protocol !== 'https:') continue;
        } catch { continue; }

        if (seen.has(href)) continue;
        seen.add(href);

        const title = (card.textContent || '').trim().slice(0, 200) || '';
        const img = card.querySelector('img');
        let thumbnail = '';
        if (img && img.src && !img.src.includes('gstatic.com') && !img.src.startsWith('data:image/svg')) {
          thumbnail = img.src;
        }

        if (title || thumbnail) {
          items.push({ title, url: href, thumbnail, domain: '' });
        }
        if (items.length >= maxResults) break;
      }

      // Strategy 2: Parse AF_initDataCallback script data
      if (items.length === 0) {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          if (!text.includes('AF_initDataCallback')) continue;
          const urlRegex = /"(https?:\/\/[^"]+)"/g;
          let m;
          while ((m = urlRegex.exec(text)) !== null) {
            const url = m[1]
              .replace(/\u002F/g, '/')
              .replace(/\u003D/g, '=')
              .replace(/\u0026/g, '&');
            try {
              const p = new URL(url);
              const h = p.hostname.toLowerCase();
              if (h === 'google.com' || h.endsWith('.google.com') || h.endsWith('.gstatic.com')) continue;
              if (seen.has(url)) continue;
              seen.add(url);
              items.push({ title: '', url, thumbnail: '', domain: '' });
              if (items.length >= maxResults) break;
            } catch {}
          }
          if (items.length >= maxResults) break;
        }
      }

      return items;
    }, MAX_RESULTS);

    for (const r of results) {
      if (!r.domain) r.domain = extractDomain(r.url);
      if (!r.title) r.title = r.domain || 'Google Lens result';
    }

    const filtered = results.filter(r => isExternalUrl(r.url));

    return {
      ok: filtered.length > 0,
      results: filtered,
      lensUrl,
      code: filtered.length > 0 ? undefined : 'NO_RESULTS',
      message: filtered.length > 0 ? 'ok' : 'No rendered lens results found.',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const app = express();

async function runConnectivityProbe() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const failed = [];

  page.on('requestfailed', (request) => {
    failed.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure() ? request.failure().errorText : 'UNKNOWN',
    });
  });

  const checkUrl = async (url) => {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      return {
        url,
        ok: true,
        status: response ? response.status() : null,
        finalUrl: page.url(),
        title: await page.title(),
      };
    } catch (error) {
      return {
        url,
        ok: false,
        error: error && error.message ? error.message : String(error),
      };
    }
  };

  try {
    const checks = [];
    checks.push(await checkUrl('https://example.com'));
    checks.push(await checkUrl('https://www.google.com'));
    checks.push(await checkUrl('https://lens.google.com'));
    return { checks, failed };
  } finally {
    await page.close().catch(() => {});
  }
}

// Token auth middleware
app.use('/lens', (req, res, next) => {
  if (LENS_TOKEN) {
    const provided = (req.headers['x-lens-token'] || '').trim();
    if (provided !== LENS_TOKEN) {
      return res.status(401).json({ ok: false, message: 'Invalid token.', code: 'AUTH_FAILED' });
    }
  }
  next();
});

app.post('/lens', express.raw({ type: '*/*', limit: MAX_BODY_BYTES }), async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ ok: false, message: 'Empty image payload.', code: 'EMPTY_IMAGE' });
    }
    const contentType = req.headers['content-type'] || 'image/jpeg';
    const result = await searchGoogleLens(Buffer.from(req.body), contentType);
    res.json(result);
  } catch (error) {
    console.error('Lens search error:', error);
    res.status(500).json({
      ok: false,
      message: 'Browser search failed: ' + (error.message || 'Unknown error'),
      code: 'BROWSER_ERROR',
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ghibli-lens-browser' });
});

app.get('/debug', async (_req, res) => {
  try {
    const probe = await runConnectivityProbe();
    res.json({ ok: true, ...probe });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error && error.message ? error.message : String(error),
    });
  }
});

app.listen(PORT, () => {
  console.log('ghibli-lens-browser listening on port ' + PORT);
});

process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});
