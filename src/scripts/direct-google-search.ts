
import * as cheerio from 'cheerio';
import fs from 'fs'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

async function searchViaDirect(
  text: string,
  pageNumber: number = 1,
): Promise<{ organic: Array<{ title: string; link: string; snippet: string }>; aiResponse: null } | null> {
  const startParam = (pageNumber - 1) * 10;
  const url = `https://www.google.com/search?q=song+pakistan`;

  try {
    const resp = await fetch(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
        "available-dictionary": ":jnnp6FE9DVs1/xoFw8CiE3NH1sPAf9MLuuIy9ebWvOs=:",
        "cache-control": "no-cache",
        "downlink": "3.1",
        "pragma": "no-cache",
        "priority": "u=0, i",
        "rtt": "50",
        "sec-ch-prefers-color-scheme": "dark",
        "sec-ch-ua": "\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
        "sec-ch-ua-arch": "\"x86\"",
        "sec-ch-ua-bitness": "\"64\"",
        "sec-ch-ua-form-factors": "\"Desktop\"",
        "sec-ch-ua-full-version": "\"148.0.7778.168\"",
        "sec-ch-ua-full-version-list": "\"Chromium\";v=\"148.0.7778.168\", \"Google Chrome\";v=\"148.0.7778.168\", \"Not/A)Brand\";v=\"99.0.0.0\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-model": "\"\"",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-ch-ua-platform-version": "\"19.0.0\"",
        "sec-ch-ua-wow64": "?0",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "x-browser-channel": "stable",
        "x-browser-copyright": "Copyright 2026 Google LLC. All Rights Reserved.",
        "x-browser-validation": "puPtlXuojC+VILE1bgaJ40YGt+E=",
        "x-browser-year": "2026",
        "Referer": "https://www.google.com/",
        

      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.warn(`⚠️ Direct fetch HTTP ${resp.status} — falling back to browser pool`);
      return null;
    }

    const html = await resp.text();

    if (
      html.includes('action="/sorry/index"') ||
      html.includes('id="captcha"') ||
      html.includes('g-recaptcha')
    ) {
      console.warn('⚠️ Direct fetch hit CAPTCHA — falling back to browser pool');
      return null;
    }

    // ── DEBUG: dump HTML so you can inspect what Google actually returned ──
    // Uncomment temporarily if results are still 0:
    // require('fs').writeFileSync('google-dump.html', html);

    const $ = cheerio.load(html);
    const organic: Array<{ title: string; link: string; snippet: string }> = [];
    const seen = new Set<string>();

    // ── Strategy 1: standard result containers ──────────────────────────
    // Google wraps each result in a <div class="g"> or similar.
    // The title is always in an <h3>, and the anchor wrapping it has the real URL.
    $('div.g, div[data-sokoban-container], div[data-hveid]').each((_, el) => {
      if (organic.length >= 10) return false;

      const h3 = $(el).find('h3').first();
      if (!h3.length) return;

      const title = h3.text().trim();
      if (!title) return;

      // Find the closest ancestor <a> that has a real http URL
      const anchor = h3.closest('a[href^="http"]').length
        ? h3.closest('a[href^="http"]')
        : h3.parent().closest('a[href^="http"]');

      let link = anchor.attr('href') ?? '';

      // Google sometimes uses /url?q= redirect links — unwrap them
      if (link.startsWith('/url?')) {
        const qs = new URLSearchParams(link.slice(5));
        link = qs.get('q') ?? link;
      }

      if (!link || link.includes('google.com') || seen.has(link)) return;
      seen.add(link);

      // Snippet: first non-empty text block after the title inside this result
      let snippet = '';
      const snippetEl = $(el).find('.VwiC3b, .lEBKkf, .lyLwlc, .IsZvec, [data-sncf]').first();
      if (snippetEl.length) {
        snippet = snippetEl.text().trim();
      } else {
        // Fallback: grab all text in the container, strip the title
        snippet = $(el).text().replace(title, '').trim().slice(0, 200);
      }

      organic.push({ title, link, snippet });
    });

    // ── Strategy 2: any <h3> → nearest ancestor <a href="http…"> ────────
    // Catches layouts that don't use .g wrappers (featured snippets, etc.)
    if (organic.length === 0) {
      $('h3').each((_, el) => {
        if (organic.length >= 10) return false;

        const title = $(el).text().trim();
        if (!title) return;

        const anchor = $(el).closest('a[href^="http"]').length
          ? $(el).closest('a[href^="http"]')
          : $(el).parents().filter('a[href^="http"]').first();

        let link = anchor.attr('href') ?? '';
        if (link.startsWith('/url?')) {
          const qs = new URLSearchParams(link.slice(5));
          link = qs.get('q') ?? link;
        }
        if (!link || link.includes('google.com') || seen.has(link)) return;
        seen.add(link);

        // Best-effort snippet from sibling/parent text
        const parent = $(el).parent();
        const snippet = parent.next().text().trim().slice(0, 200)
          || parent.parent().text().replace(title, '').trim().slice(0, 200);

        organic.push({ title, link, snippet });
      });
    }

    if (organic.length === 0) {
      console.warn('⚠️ Direct fetch parsed 0 results — falling back to browser pool');
      // Dump for debugging
      fs.writeFileSync('google-dump.html', html);
      console.warn('📄 HTML dumped to google-dump.html for inspection');
      return null;
    }

    console.log(`✅ Direct fetch returned ${organic.length} results`);
    return { organic, aiResponse: null };

  } catch (e) {
    console.warn('⚠️ Direct fetch threw:', (e as Error).message, '— falling back to browser pool');
    return null;
  }
}

searchViaDirect('song pakistan').then(console.log);