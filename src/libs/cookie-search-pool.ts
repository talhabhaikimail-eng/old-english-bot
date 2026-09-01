import { browserPool, searchViaPool } from './browser-pool';
import { acquirePage, releasePage, isWorkerCached, warmupWorker } from './page-pool';
import type { WorkerConnection } from './page-pool';
import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

class CookieSearchPool {
  private cookiesMap = new Map<string, string>(); // workerId -> cookie string
  private cookieFetchPromises = new Map<string, Promise<string>>();

  constructor() {
    this.startPreWarmingLoop();
    browserPool.onRegister = (browser) => {
      console.log(`[CookieSearchPool] Eagerly pre-warming cookies for newly registered worker ${browser.workerId}...`);
      this.getCookiesForWorker(browser).catch((e) => {
        console.error(`[CookieSearchPool] Eagerly pre-warming cookies failed for ${browser.workerId}:`, e.message);
      });
    };
  }

  private startPreWarmingLoop(): void {
    const interval = setInterval(async () => {
      try {
        const activeBrowsers = browserPool.getActive();
        for (const browser of activeBrowsers) {
          const existingCookie = this.cookiesMap.get(browser.workerId);
          if (!existingCookie) {
            console.log(`[CookieSearchPool Background] Pre-warming cookies for worker ${browser.workerId}...`);
            await this.getCookiesForWorker(browser).catch((e) => {
              console.error(`[CookieSearchPool Background] Failed to pre-warm cookies for ${browser.workerId}:`, e.message);
            });
          }
        }
      } catch (err) {
        // ignore
      }
    }, 2 * 60 * 1000);

    if (interval && typeof interval === 'object' && 'unref' in interval) {
      (interval as NodeJS.Timeout).unref();
    }
  }

  private async getCookiesForWorker(browser: any): Promise<string> {
    let promise = this.cookieFetchPromises.get(browser.workerId);
    if (!promise) {
      promise = this.fetchCookiesForWorker(browser).finally(() => {
        this.cookieFetchPromises.delete(browser.workerId);
      });
      this.cookieFetchPromises.set(browser.workerId, promise);
    }
    return promise;
  }

  private isCaptcha(html: string): boolean {
    return (
      html.includes('action="/sorry/index"') ||
      html.includes('id="captcha"') ||
      html.includes('g-recaptcha')
    );
  }



  private async fetchCookiesForWorker(browser: any, failFast = false): Promise<string> {
    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;
    try {
      const acquired = await acquirePage(browser, failFast);
      conn = acquired.conn;
      page = acquired.page;
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Check and handle cookie consent wall if present
      try {
        const consentBtn = await page.$('#L2AGLb, #introAgreeButton, button[aria-label="Accept all"], button[aria-label="I agree"]');
        if (consentBtn) {
          console.log(`[CookieSearchPool] Consent wall detected for ${browser.workerId}. Clicking to accept cookies...`);
          await consentBtn.click();
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        }
      } catch (consentErr: any) {
        console.warn(`[CookieSearchPool] Warning: Failed to handle cookie consent button:`, consentErr.message);
      }

      const html = await page.content();
      if (this.isCaptcha(html)) {
        browserPool.recordCaptcha(browser.workerId);
        throw new Error('CAPTCHA detected on google.com home page');
      }
      const cookies = await page.cookies();
      const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
      this.cookiesMap.set(browser.workerId, cookieStr);
      return cookieStr;
    } catch (e) {
      pageErrored = true;
      throw e;
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  private async clearCookiesForWorker(browser: any, failFast = false): Promise<void> {
    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;
    try {
      const acquired = await acquirePage(browser, failFast);
      conn = acquired.conn;
      page = acquired.page;
      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCookies');
      await client.detach();
      this.cookiesMap.delete(browser.workerId);
    } catch (e) {
      pageErrored = true;
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  private clearAndRefreshCookiesInBackground(browser: any): void {
    const workerId = browser.workerId;
    if (this.cookieFetchPromises.has(workerId)) {
      return;
    }
    const promise = (async () => {
      try {
        await this.clearCookiesForWorker(browser);
        return await this.fetchCookiesForWorker(browser);
      } catch (err: any) {
        console.error(`[CookieSearchPool Background] Failed to refresh cookies for ${workerId}:`, err.message);
        throw err;
      }
    })().finally(() => {
      this.cookieFetchPromises.delete(workerId);
    });
    this.cookieFetchPromises.set(workerId, promise);
  }

  private async performFetch(url: string, cookie: string): Promise<{ text: string; finalUrl: string }> {
    const resp = await fetch(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-ch-ua": '"Chromium";v="148"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "upgrade-insecure-requests": "1",
        "User-Agent": USER_AGENT,
        "cookie": cookie,
        "Referer": "https://www.google.com/"
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    return { text, finalUrl: resp.url };
  }

  public async search(
    text: string,
    pageNumber: number = 1,
    category: string = 'all'
  ): Promise<{
    organic: Array<{ title: string; link: string; snippet: string; displayedLink?: string; favicon?: string }>;
    aiResponse: string | null;
    featuredSnippet?: { title: string; link: string; snippet: string } | null;
    knowledgePanel?: {
      title: string;
      subtitle?: string;
      description?: string;
      sourceUrl?: string;
      attributes?: Array<{ label: string; value: string }>;
    } | null;
    peopleAlsoAsk?: Array<{ question: string; answer?: string; sourceTitle?: string; sourceUrl?: string }>;
    directAnswer?: { type: string; answer: string; details?: string } | null;
    news?: Array<{ title: string; source: string; time: string; link: string }>;
    videos?: Array<{ title: string; source: string; duration?: string; uploadedAt?: string; link: string }>;
    images?: Array<{ alt: string; sourceUrl: string; imageUrl?: string }>;
    shopping?: Array<{ title: string; price: string; merchant: string; rating?: string; link: string }>;
    relatedSearches?: string[];
    localResults?: Array<{ title: string; rating?: string; reviewsCount?: string; address?: string; phone?: string; link?: string }>;
    captcha?: boolean;
    error?: string;
    html?: string;
  }> {
    const activeBrowsers = browserPool.getActive();
    if (activeBrowsers.length === 0) {
      browserPool.restartWorkers();
      throw new Error('No active browsers available in pool');
    }

    const normCategory = category.toLowerCase().trim();
    let categoryKey = 'all';
    if (normCategory === 'videos' || normCategory === 'video') {
      categoryKey = 'videos';
    } else if (normCategory === 'images' || normCategory === 'image') {
      categoryKey = 'images';
    } else if (normCategory === 'news') {
      categoryKey = 'news';
    } else if (normCategory === 'shopping' || normCategory === 'shop') {
      categoryKey = 'shopping';
    }

    const startParam = (pageNumber - 1) * 10;
    let targetUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10&hl=en&gbv=2&pws=0`;
    if (categoryKey === 'images') {
      targetUrl += '&udm=2';
    } else if (categoryKey === 'videos') {
      targetUrl += '&udm=7';
    } else if (categoryKey === 'news') {
      targetUrl += '&udm=14';
    } else if (categoryKey === 'shopping') {
      targetUrl += '&udm=3';
    }

    const maxAttempts = activeBrowsers.length;
    const hasAnyCached = activeBrowsers.some(b => isWorkerCached(b.workerId));
    let lastHtml = '';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const browser = browserPool.getNext();
      if (!browser) break;

      if (hasAnyCached && !isWorkerCached(browser.workerId)) {
        warmupWorker(browser);
        continue;
      }

      try {
        let cookie = this.cookiesMap.get(browser.workerId);
        if (!cookie) {
          cookie = await this.getCookiesForWorker(browser);
        }

        let html = '';
        let finalUrl = '';
        try {
          const fetchResult = await this.performFetch(targetUrl, cookie);
          html = fetchResult.text;
          finalUrl = fetchResult.finalUrl;
          lastHtml = html;
        } catch (err: any) {
          console.warn(`[CookieSearchPool] Fetch failed on browser ${browser.workerId}:`, err.message);
          this.cookiesMap.delete(browser.workerId);
          continue;
        }

        let isRedirectedToBlock = finalUrl && (
          finalUrl.includes('consent.google.com') ||
          finalUrl.includes('/sorry/')
        );

        if (isRedirectedToBlock || this.isCaptcha(html)) {
          console.warn(`[CookieSearchPool] CAPTCHA/Consent redirect detected on browser ${browser.workerId} (finalUrl: ${finalUrl}). Retrying with fresh cookies on same browser...`);
          this.cookiesMap.delete(browser.workerId);
          
          try {
            await this.clearCookiesForWorker(browser, true);
            cookie = await this.fetchCookiesForWorker(browser, true);
            
            const fetchResult = await this.performFetch(targetUrl, cookie);
            html = fetchResult.text;
            finalUrl = fetchResult.finalUrl;
            lastHtml = html;

            isRedirectedToBlock = finalUrl && finalUrl.includes('/sorry/');

            if (isRedirectedToBlock || this.isCaptcha(html)) {
              console.warn(`[CookieSearchPool] CAPTCHA still detected on browser ${browser.workerId} after retry. Trying next browser...`);
              browserPool.recordCaptcha(browser.workerId);
              continue;
            }
          } catch (retryErr: any) {
            console.error(`[CookieSearchPool] Retry cookie refresh failed for ${browser.workerId}:`, retryErr.message);
            continue;
          }
        }

        const $ = cheerio.load(html);
        const organic: any[] = [];
        let aiResponse: string | null = null;
        let featuredSnippet: any = null;
        let knowledgePanel: any = null;
        const peopleAlsoAsk: any[] = [];
        let directAnswer: any = null;
        const news: any[] = [];
        const videos: any[] = [];
        const images: any[] = [];
        const shopping: any[] = [];
        const localResults: any[] = [];
        const relatedSearches: string[] = [];
        const seen = new Set<string>();

        const cleanText = (str: string | null | undefined) => str ? str.trim().replace(/\s+/g, ' ') : '';

        const decodeGoogleLink = (href: string | null | undefined) => {
          if (!href) return '';
          try {
            if (href.startsWith('/url?q=')) {
              const urlPart = href.split('/url?q=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            } else if (href.startsWith('/url?url=')) {
              const urlPart = href.split('/url?url=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            }
          } catch (e) { }
          return href;
        };

        // 1. EXTRACT AI OVERVIEW / RESPONSE (SGE)
        for (const sel of [
          '.M8OgIe', '.LLtROe', '.IZ6rdc',
          '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk',
        ]) {
          const el = $(sel).first();
          if (el.length && cleanText(el.text()).length > 20) {
            const txt = el.text();
            if (txt.includes('AI Overview is not available') || txt.includes("Can't generate an AI overview")) {
              continue;
            }
            if (
              el.find('[href*="/maps/"]').length ||
              el.find('.YzSd').length ||
              (el.text().includes('Places') && el.text().includes('Reviews'))
            ) {
              continue;
            }
            aiResponse = el.html() || cleanText(el.text());
            break;
          }
        }

        // 2. EXTRACT FEATURED SNIPPET
        const fsContainer = $('[data-attrid="wa:/description"], .kp-blk, .hp-xpd, .c2d06b').first();
        if (fsContainer.length) {
          const titleEl = fsContainer.find('h3, .LC20lb').first();
          const aEl = fsContainer.find('a').first();
          const snippetEl = fsContainer.find('.YyVvo, .di3YZe, .ilUpNd.H66NU.aSRlid, .H66NU').first();
          if (titleEl.length && aEl.length && snippetEl.length) {
            featuredSnippet = {
              title: cleanText(titleEl.text()),
              link: decodeGoogleLink(aEl.attr('href') || ''),
              snippet: cleanText(snippetEl.text())
            };
          }
        }

        // 3. EXTRACT KNOWLEDGE PANEL
        const kpContainer = $('.kp-sidebar, #rhs, .rhs, .kp-blk, .KPDxwd').first();
        if (kpContainer.length) {
          const titleEl = kpContainer.find('[role="heading"], .HPwZGe, .DU1Mzb, .kno-ecr-pt').first();
          const subtitleEl = kpContainer.find('.wDYxhc.mod, .kno-meta, .bV3FIe').first();
          const descEl = kpContainer.find('[data-attrid="kc:/common/topic:description"], .kno-rdesc span').first();
          const sourceEl = kpContainer.find('.kno-rdesc a').first();

          const attributes: any[] = [];
          kpContainer.find('.rVusM, .zVnNfc, .Lrzca').each((_, el) => {
            const label = $(el).find('.wDYxhc, .zVnNfc, .fl').first();
            const val = $(el).find('.Lrzca, .kno-fv').first();
            if (label.length && val.length) {
              attributes.push({
                label: cleanText(label.text()),
                value: cleanText(val.text())
              });
            }
          });

          if (titleEl.length) {
            knowledgePanel = {
              title: cleanText(titleEl.text()),
              subtitle: subtitleEl.length ? cleanText(subtitleEl.text()) : undefined,
              description: descEl.length ? cleanText(descEl.text()) : undefined,
              sourceUrl: sourceEl.length ? decodeGoogleLink(sourceEl.attr('href') || '') : undefined,
              attributes: attributes.length > 0 ? attributes : undefined
            };
          }
        }

        // 4. EXTRACT PEOPLE ALSO ASK (PAA)
        $('[jsname="N760bc"], [data-init-query], .cb76Od, .E3VR9e').each((_, el) => {
          const headerText = cleanText($(el).text());
          if (headerText.toLowerCase().includes('people also ask') || headerText.toLowerCase().includes('questions')) {
            const parent = $(el).parent();
            if (parent.length) {
              parent.find('[jsname="j96n9e"], .ask-xpd, .mB12ae').each((__, qEl) => {
                const qText = cleanText($(qEl).text());
                if (qText) {
                  peopleAlsoAsk.push({ question: qText });
                }
              });
            }
          }
        });

        // 5. EXTRACT DIRECT ANSWERS (WEATHER, TRANSLATION, DICTIONARY, CALCULATOR)
        // Calculator
        const calcResult = $('#cwos').first();
        if (calcResult.length) {
          const calcEq = $('.rN17ge, .SwHCTb').first();
          directAnswer = {
            type: 'calculator',
            answer: cleanText(calcResult.text()),
            details: calcEq.length ? cleanText(calcEq.text()) : undefined
          };
        }

        // Weather
        const weatherTemp = $('#wob_tm, .vk_bk.wob-t').first();
        if (weatherTemp.length && !directAnswer) {
          const tempVal = cleanText(weatherTemp.text());

          let unit = '°F';
          const tempUnitEl = $('#wob_temp_unit, [aria-selected="true"] .wob_t, .wob_t[style*="inline"]').first();
          if (tempUnitEl.length && tempUnitEl.text().includes('C')) {
            unit = '°C';
          } else {
            const weatherContainer = weatherTemp.closest('.Ww4FFb, .vk_c, .card');
            if (weatherContainer.length && weatherContainer.text().includes('°C') && !weatherContainer.text().includes('°F')) {
              unit = '°C';
            }
          }

          const locEl = $('.BBwThe, #wob_loc, .wob_loc').first();
          let location = locEl.length ? cleanText(locEl.text()) : 'Tokyo';
          if (location === 'Weather') {
            const cityEl = $('.BBwThe, .wob_loc').first();
            if (cityEl.length) location = cleanText(cityEl.text());
          }

          const condEl = $('#wob_dc, .wob_dc, #wob_dts + span').first();
          const condition = condEl.length ? cleanText(condEl.text()) : '';

          const precipEl = $('#wob_pp').first();
          const humidEl = $('#wob_hm').first();
          const windEl = $('#wob_ws').first();

          let details = `${location} - ${condition}`;
          if (precipEl.length || humidEl.length || windEl.length) {
            details += ` (Precipitation: ${precipEl.length ? precipEl.text() : 'N/A'}, Humidity: ${humidEl.length ? humidEl.text() : 'N/A'}, Wind: ${windEl.length ? windEl.text() : 'N/A'})`;
          }

          directAnswer = {
            type: 'weather',
            answer: `${tempVal}${unit}`,
            details: details
          };
        }

        // Time / Timezone
        const timeVal = $('.vk_bk, .gsrt.vk_bk').first();
        if (timeVal.length && timeVal.text().includes(':') && !directAnswer) {
          const timeZone = $('.vk_gy, .vk_sh').first();
          directAnswer = {
            type: 'time',
            answer: cleanText(timeVal.text()),
            details: timeZone.length ? cleanText(timeZone.text()) : undefined
          };
        }

        // Dictionary
        const dictWord = $('.v9i61e, [data-attrid="kc:/common/dictionary:definition"]').first();
        if (dictWord.length && !directAnswer) {
          const dictMean = $('.LT1Tbd, .lr_dct_ent').first();
          directAnswer = {
            type: 'dictionary',
            answer: cleanText(dictWord.text()),
            details: dictMean.length ? cleanText(dictMean.text()) : undefined
          };
        }

        // Translation
        const transTarget = $('#tw-target-text').first();
        if (transTarget.length && !directAnswer) {
          const transSource = $('#tw-source-text-ta').first();
          directAnswer = {
            type: 'translation',
            answer: cleanText(transTarget.text()),
            details: transSource.length ? cleanText(transSource.val() as string || transSource.text()) : undefined
          };
        }

        // 6. EXTRACT NEWS / STORIES
        $('g-card, .YLwUee, .WlydOe, .MjjYud').each((_, el) => {
          const a = $(el).find('a').first();
          const isNews = $(el).find('.OSrXXb, .LfNcr').length || $(el).find('.NUnG9b').length;
          if (a.length && isNews) {
            const h3 = $(el).find('[role="heading"], h3, .mCBkyc, .nD1swb').first();
            const srcEl = $(el).find('.NUnG9b, .h1UuCc, .ap3aec').first();
            const timeEl = $(el).find('.OSrXXb, .LfNcr').first();
            if (h3.length && a.attr('href')) {
              const link = decodeGoogleLink(a.attr('href'));
              if (link && !seen.has(link)) {
                news.push({
                  title: cleanText(h3.text()),
                  source: srcEl.length ? cleanText(srcEl.text()) : '',
                  time: timeEl.length ? cleanText(timeEl.text()) : '',
                  link
                });
              }
            }
          }
        });

        // 7. EXTRACT VIDEOS
        $('g-card, .V2Ew3b, .z3HNeb, .MjjYud, [data-curl], .EyBRub, .hIwNKe').each((_, el) => {
          let a = $(el).find('a').first();
          if (!a.length && $(el).is('a')) {
            a = $(el);
          }
          const href = a.length ? (a.attr('href') || '') : '';
          const dataCurl = $(el).attr('data-curl') || '';
          const targetLink = decodeGoogleLink(dataCurl || href);
          if (!targetLink) return;

          const isVideo = targetLink.includes('youtube.com') || targetLink.includes('vimeo.com') || targetLink.includes('tiktok.com') || $(el).find('.vP1iyc').length || $(el).find('.J1y2db').length || $(el).attr('data-pubr') || $(el).find('.O1KYjb').length;
          if (isVideo && !seen.has(targetLink)) {
            seen.add(targetLink);
            const h3 = $(el).find('h3, h1, .mCBkyc, .z3HNeb, .WQWxe').first();
            const durEl = $(el).find('.vP1iyc, .J1y2db, .ZwRhJd').first();
            const uploadedEl = $(el).find('.ap3aec, .PCvXJ, .PLq9Je, .DKsccc').first();

            let duration = durEl.length ? cleanText(durEl.text()) : undefined;
            let uploadedAt = uploadedEl.length ? cleanText(uploadedEl.text()) : undefined;

            const ariaLabel = $(el).attr('aria-label') || '';
            if (ariaLabel && !duration) {
              const durationMatch = ariaLabel.match(/(\d+:\d+)/);
              if (durationMatch) duration = durationMatch[1];
            }

            const pubr = $(el).attr('data-pubr');
            const srcEl = $(el).find('.NUnG9b, .h1UuCc, .ap3aec, .sjVJQd, .KrMNbf').first();
            const source = pubr ? cleanText(pubr) : (srcEl.length ? cleanText(srcEl.text()) : (targetLink.includes('youtube.com') ? 'YouTube' : 'Video'));

            if (h3.length) {
              videos.push({
                title: cleanText(h3.text()),
                source,
                duration,
                uploadedAt,
                link: targetLink
              });
            }
          }
        });

        // 8. EXTRACT IMAGES (both JS-enabled and JS-disabled, inline & traditional)
        const seenImages = new Set<string>();

        // Method A: Script-based high-res image extraction for images category
        if (categoryKey === 'images') {
          const pageHtml = html;
          const imgRegex = /\[0\s*,\s*"([^"]+)"\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g;
          let imgMatch;
          while ((imgMatch = imgRegex.exec(pageHtml)) !== null) {
            const imgUrl = imgMatch[5].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
            if (seenImages.has(imgUrl)) continue;
            seenImages.add(imgUrl);

            const nextChunk = pageHtml.substring(imgMatch.index, imgMatch.index + 2000);
            const metaRegex = /"2003"\s*:\s*\[\s*null\s*,\s*"[^"]*"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/;
            const metaMatch = metaRegex.exec(nextChunk);

            let sourceUrl = '';
            let title = '';
            if (metaMatch) {
              sourceUrl = metaMatch[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
              title = metaMatch[2];
            }

            images.push({
              alt: cleanText(title || 'Image'),
              sourceUrl: sourceUrl || imgUrl,
              imageUrl: imgUrl
            });
          }
        }

        // Method B: DOM-based fallback if no script-based images are found or for non-images category
        if (images.length === 0) {
          $('span, div, h2, h3').each((_, el) => {
            const text = cleanText($(el).text());
            if (text === 'Images') {
              let parent = $(el).parent();
              while (parent.length && parent.find('img').length < 3 && !parent.is('body')) {
                parent = parent.parent();
              }
              if (parent.length) {
                parent.find('img').each((__, img) => {
                  const alt = $(img).attr('alt') || '';
                  const imageUrl = $(img).attr('src') || '';
                  if (!imageUrl) return;

                  let p = $(img).parent();
                  let sourceUrl = '';
                  while (p.length && p.get(0) !== parent.get(0) && !p.is('body')) {
                    const anchor = p.find('a').first();
                    if (anchor.length) {
                      const href = anchor.attr('href') || '';
                      if (href) {
                        sourceUrl = decodeGoogleLink(href);
                        break;
                      }
                    }
                    p = p.parent();
                  }

                  if (sourceUrl && !seenImages.has(imageUrl)) {
                    seenImages.add(imageUrl);
                    images.push({
                      alt: cleanText(alt),
                      sourceUrl,
                      imageUrl
                    });
                  }
                });
              }
            }
          });

          // Method B.2: Traditional imgres fallback links (e.g. JS-disabled/fallback page)
          $('a[href*="imgres"]').each((_, el) => {
            const img = $(el).find('img').first();
            const alt = img.length ? img.attr('alt') || '' : '';
            const href = $(el).attr('href') || '';

            let sourceUrl = '';
            let imageUrl = '';
            try {
              const urlObj = new URL(href, 'https://www.google.com');
              imageUrl = urlObj.searchParams.get('imgurl') || '';
              sourceUrl = urlObj.searchParams.get('imgrefurl') || '';
            } catch (e) {
              const imgMatch = href.match(/[?&]imgurl=([^&]+)/);
              const refMatch = href.match(/[?&]imgrefurl=([^&]+)/);
              if (imgMatch) imageUrl = decodeURIComponent(imgMatch[1]);
              if (refMatch) sourceUrl = decodeURIComponent(refMatch[1]);
            }

            sourceUrl = decodeGoogleLink(sourceUrl || href);
            if (sourceUrl && imageUrl && !seenImages.has(imageUrl)) {
              seenImages.add(imageUrl);
              images.push({
                alt: cleanText(alt),
                sourceUrl,
                imageUrl: imageUrl || undefined
              });
            }
          });
        }

        // 9. EXTRACT SHOPPING RESULTS
        $('.sh-dgr__grid-cell, .sh-dlr__list-result, .sh-np__click-target').each((_, el) => {
          const a = $(el).find('a').first();
          const titleEl = $(el).find('.Xj73ed, .tAxDx').first();
          const priceEl = $(el).find('.a8c5bc, .h1N1A').first();
          const merchantEl = $(el).find('.I5cFL, .mB12ae').first();
          if (a.length && titleEl.length && priceEl.length) {
            const link = decodeGoogleLink(a.attr('href') || '');
            shopping.push({
              title: cleanText(titleEl.text()),
              price: cleanText(priceEl.text()),
              merchant: merchantEl.length ? cleanText(merchantEl.text()) : '',
              link
            });
          }
        });

        // 10. EXTRACT LOCAL RESULTS
        $('.rllt__card, .Vk2fBe').each((_, el) => {
          const titleEl = $(el).find('[role="heading"], .dbg0pd').first();
          const ratingEl = $(el).find('.rGhul, .Yw7Nj').first();
          const reviewsEl = $(el).find('.R3Y11e').first();
          const addressEl = $(el).find('.Lrzca').first();
          const a = $(el).find('a').first();
          if (titleEl.length) {
            localResults.push({
              title: cleanText(titleEl.text()),
              rating: ratingEl.length ? cleanText(ratingEl.text()) : undefined,
              reviewsCount: reviewsEl.length ? cleanText(reviewsEl.text()) : undefined,
              address: addressEl.length ? cleanText(addressEl.text()) : undefined,
              link: a.length ? decodeGoogleLink(a.attr('href') || '') : undefined
            });
          }
        });

        // 11. EXTRACT RELATED SEARCHES
        $('a.title, .s75cqc, .card-section a, .E3VR9e').each((_, el) => {
          const headerText = cleanText($(el).text());
          if (headerText.toLowerCase().includes('people also search') || headerText.toLowerCase().includes('related search')) {
            let parent = $(el).parent();
            while (parent.length && !(parent.attr('class') || '').includes('Gx5Zad') && !parent.is('body')) {
              parent = parent.parent();
            }
            if (parent.length) {
              parent.find('a').each((__, aEl) => {
                const text = cleanText($(aEl).text());
                if (text && text !== headerText && !relatedSearches.includes(text)) {
                  relatedSearches.push(text);
                }
              });
            }
          }
        });

        // 12. EXTRACT ORGANIC SEARCH RESULTS
        if (categoryKey === 'all') {
          $('h3').each((_, h3) => {
            const headingText = cleanText($(h3).text());
            if (
              headingText === 'Search Results' ||
              headingText === 'Weather Result' ||
              headingText === 'Web results' ||
              headingText === 'Featured snippet' ||
              headingText.includes('People also ask')
            ) {
              return;
            }

            const container = $(h3).closest('.g, .MjjYud, .xpd, .Gx5Zad').length ? $(h3).closest('.g, .MjjYud, .xpd, .Gx5Zad') : $(h3).parent();
            if (!container.length) return;

            const a = container.is('a') ? container : container.find('a').first();
            if (!a.length) return;

            const rawLink = a.attr('href') || '';
            const link = decodeGoogleLink(rawLink);

            if (!link || link.includes('google.com') || link.includes('sorry/index') || seen.has(link)) return;
            seen.add(link);

            let snippet = '';
            for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec', '.ilUpNd.H66NU.aSRlid', '.H66NU', '.lQigmf']) {
              const sn = container.find(s).first();
              if (sn.length && sn.text() && sn.text().trim()) {
                const txt = cleanText(sn.text());
                if (txt !== cleanText($(h3).text()) && !txt.includes('www.') && txt.length > 10) {
                  snippet = txt;
                  break;
                }
              }
            }

            if (!snippet) {
              container.find('div, span, p').each((__, sub) => {
                if (!snippet && $(sub).attr('class') && $(sub).text() && $(sub).children().length === 0) {
                  const txt = cleanText($(sub).text());
                  if (txt.length > 30 && !txt.includes('www.') && txt !== cleanText($(h3).text())) {
                    snippet = txt;
                  }
                }
              });
            }

            const dispEl = container.find('.TbwUpd, .byrV5b, .ylgVCe, .BamJPe').first();
            const displayedLink = dispEl.length ? cleanText(dispEl.text()) : undefined;

            const favEl = container.find('img.H1u2de, img.XNo5Ab, .wb41ae img').first();
            const favicon = favEl.length ? favEl.attr('src') || undefined : undefined;

            organic.push({
              title: cleanText($(h3).text()),
              link,
              snippet,
              displayedLink,
              favicon
            });
          });
        }

        if (organic.length === 0 && categoryKey === 'all') {
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

            const parent = $(el).parent();
            const snippet = parent.next().text().trim().slice(0, 200) ||
              parent.parent().text().replace(title, '').trim().slice(0, 200);
            organic.push({ title, link, snippet });
          });
        }

        // Validate results based on category
        const hasCategoryResults = () => {
          if (categoryKey === 'all') return organic && organic.length > 0;
          if (categoryKey === 'images') return images && images.length > 0;
          if (categoryKey === 'videos') return videos && videos.length > 0;
          if (categoryKey === 'news') return news && news.length > 0;
          if (categoryKey === 'shopping') return shopping && shopping.length > 0;
          return false;
        };

        if (!hasCategoryResults()) {
          console.warn(`[CookieSearchPool] Zero results parsed for category "${categoryKey}" on browser ${browser.workerId}. Trying next browser...`);
          this.cookiesMap.delete(browser.workerId);
          this.clearAndRefreshCookiesInBackground(browser);
          continue;
        }

        const otherBrowsers = activeBrowsers.filter(b => b.workerId !== browser.workerId);
        for (const b of otherBrowsers) {
          if (!isWorkerCached(b.workerId)) {
            warmupWorker(b);
          }
        }

        const cleanOrganic = categoryKey === 'all' ? organic : [];
        const cleanNews = categoryKey === 'news' ? news : [];
        const cleanVideos = categoryKey === 'videos' ? videos : [];
        const cleanImages = categoryKey === 'images' ? images : [];
        const cleanShopping = categoryKey === 'shopping' ? shopping : [];

        return {
          organic: cleanOrganic,
          aiResponse: categoryKey === 'all' ? aiResponse : null,
          featuredSnippet: categoryKey === 'all' ? featuredSnippet : null,
          knowledgePanel: categoryKey === 'all' ? knowledgePanel : null,
          peopleAlsoAsk: categoryKey === 'all' ? peopleAlsoAsk : undefined,
          directAnswer: categoryKey === 'all' ? directAnswer : null,
          news: cleanNews.length > 0 ? cleanNews : undefined,
          videos: cleanVideos.length > 0 ? cleanVideos : undefined,
          images: cleanImages.length > 0 ? cleanImages : undefined,
          shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
          relatedSearches: categoryKey === 'all' ? relatedSearches : undefined,
          localResults: categoryKey === 'all' && localResults.length > 0 ? localResults : undefined,
          html
        };
      } catch (e) {
        console.error(`[CookieSearchPool] Search failed on browser ${browser.workerId}:`, e);
      }
    }

    console.error('[CookieSearchPool] All browsers in pool returned CAPTCHA or failed.');
    browserPool.restartWorkers();
    return {
      organic: [],
      aiResponse: null,
      captcha: true,
      error: 'Google Search CAPTCHA detected on all active browsers and could not be bypassed.',
      html: lastHtml
    };
  }
}

export const cookieSearchPool = new CookieSearchPool();
