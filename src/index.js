const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const LENS_TOKEN = (process.env.LENS_TOKEN || '').trim();
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 25000;
const MAX_RESULTS = 10;

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
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

async function searchGoogleLens(imageBuffer, contentType) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto('https://lens.google.com/', {
      waitUntil: 'networkidle2',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const tempPath = '/tmp/lens-upload-' + Date.now() + '.' + ext;
    fs.writeFileSync(tempPath, imageBuffer);

    // Find file input and upload
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      const uploadBtn = await page.$('[aria-label*="upload"], [aria-label*="Upload"], .nDcEnd, .DV7the');
      if (uploadBtn) {
        await uploadBtn.click();
        await page.waitForSelector('input[type="file"]', { timeout: 5000 }).catch(() => {});
        fileInput = await page.$('input[type="file"]');
      }
    }
    if (fileInput) {
      await fileInput.uploadFile(tempPath);
    }

    try { fs.unlinkSync(tempPath); } catch {}

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));

    const lensUrl = page.url();

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

app.listen(PORT, () => {
  console.log('ghibli-lens-browser listening on port ' + PORT);
});

process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});
