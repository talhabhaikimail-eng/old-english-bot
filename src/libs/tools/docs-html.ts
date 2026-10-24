/**
 * @file tools/docs-html.ts
 * @description `html-to-pdf`: render uploaded HTML / Markdown / text files, or a public URL, to PDF
 * with headless Chromium (puppeteer-core). Falls back to LibreOffice for files when no browser is
 * installed. Every request the page makes is checked: only public http(s) hosts are allowed, so a
 * rendered page can't reach the server's private network.
 *
 * Browser lookup: PUPPETEER_EXECUTABLE_PATH / TOOLS_CHROME / CHROME_PATH, then standard Chrome,
 * Edge and Chromium install paths on Windows, Linux and macOS.
 */

import { lookup } from 'dns/promises';
import { existsSync, promises as fs } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { pathToFileURL } from 'url';
import { withExt, type ConverterSpec, type JobOutput, type JobRunCtx } from './jobs';
import { findBinary } from './binaries';
import { killTree, sofficeConvert } from './docs-office';
import { markdownToHtmlDocument, textToHtmlDocument } from './docs-markdown';

let guard: typeof import('../web-proxy-guard') | null = null;
function proxyGuard() {
  // Lazy: the guard module pulls in the proxy library, which only this converter needs.
  if (!guard) guard = require('../web-proxy-guard');
  return guard!;
}

export function findBrowser(): string | null {
  const env = [process.env.TOOLS_CHROME, process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH].filter(Boolean) as string[];
  const win = process.platform === 'win32' ? [
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.LOCALAPPDATA || '', 'Chromium/Application/chrome.exe'),
  ] : [];
  const unix = [
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  return [...env, ...win, ...unix].find(p => p && existsSync(p)) ?? null;
}

const PAGE_FORMATS = ['A4', 'Letter', 'Legal', 'A3', 'A5'] as const;

/** Allow only data/blob/about and public http(s) URLs (hostname + every resolved address checked). */
function makeUrlChecker(allowFile?: string) {
  const cache = new Map<string, Promise<boolean>>();
  const { isBlockedHostname, isBlockedIp } = proxyGuard();
  return (raw: string): Promise<boolean> => {
    let u: URL;
    try { u = new URL(raw); } catch { return Promise.resolve(false); }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return Promise.resolve(true);
    if (u.protocol === 'file:') return Promise.resolve(!!allowFile && raw.split('#')[0] === allowFile);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.resolve(false);
    if (isBlockedHostname(u.hostname)) return Promise.resolve(false);
    let p = cache.get(u.hostname);
    if (!p) {
      p = lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true })
        .then(list => list.length > 0 && !list.some(a => isBlockedIp(a.address)))
        .catch(() => false);
      cache.set(u.hostname, p);
    }
    return p;
  };
}

function countPdfPages(buf: Buffer): number {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

function urlFilename(u: URL): string {
  const slug = (u.hostname + u.pathname).replace(/\/+$/, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 100);
  return `${slug || 'page'}.pdf`;
}

/** Prepare an uploaded file as a standalone HTML document; returns its path. */
async function toHtmlFile(path: string, filename: string, dir: string): Promise<string> {
  const ext = extname(filename).slice(1).toLowerCase();
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return path;
  const raw = await fs.readFile(path, 'utf-8');
  const doc = ext === 'md' || ext === 'markdown' ? markdownToHtmlDocument(raw, filename) : textToHtmlDocument(raw, filename);
  await fs.mkdir(dir, { recursive: true });
  const out = join(dir, withExt(basename(filename), 'html'));
  await fs.writeFile(out, doc);
  return out;
}

interface RenderTask { kind: 'file' | 'url'; source: string; filename: string; label: string }

export const htmlToPdf: ConverterSpec = {
  id: 'html-to-pdf',
  label: 'Render to PDF',
  group: 'document',
  inputs: ['html', 'htm', 'xhtml', 'md', 'markdown', 'txt'],
  output: 'pdf',
  minFiles: 0,
  maxFiles: 20,
  timeoutMs: 15 * 60_000,
  options: [
    { key: 'url', label: 'URL', type: 'text', default: '', placeholder: 'https://example.com', help: 'Render a public web page instead of (or as well as) uploaded files.' },
    { key: 'pageSize', label: 'Page size', type: 'select', default: 'A4', choices: PAGE_FORMATS.map(f => ({ value: f, label: f })) },
    { key: 'landscape', label: 'Landscape', type: 'boolean', default: false },
    { key: 'margin', label: 'Margin (mm)', type: 'number', default: 15, min: 0, max: 50, step: 1 },
    { key: 'printBackground', label: 'Print backgrounds', type: 'boolean', default: true },
    { key: 'scale', label: 'Scale', type: 'number', default: 1, min: 0.1, max: 2, step: 0.05 },
    { key: 'pageNumbers', label: 'Page numbers in footer', type: 'boolean', default: false },
    { key: 'headerText', label: 'Header text', type: 'text', default: '', placeholder: 'Optional header on every page' },
    {
      key: 'media', label: 'CSS media', type: 'select', default: 'print',
      choices: [{ value: 'print', label: 'Print stylesheet' }, { value: 'screen', label: 'Screen (as in the browser)' }],
    },
    { key: 'waitMs', label: 'Extra wait (ms)', type: 'number', default: 500, min: 0, max: 15000, step: 100, help: 'Give script-heavy pages time to finish rendering.' },
    {
      key: 'engine', label: 'Engine', type: 'select', default: 'auto',
      choices: [{ value: 'auto', label: 'Auto (Chromium, else LibreOffice)' }, { value: 'chromium', label: 'Chromium' }, { value: 'libreoffice', label: 'LibreOffice' }],
    },
  ],
  run: async (ctx: JobRunCtx) => {
    const o = ctx.options;
    const jobDir = dirname(ctx.workDir);
    const tasks: RenderTask[] = [];
    const urlRaw = String(o.url || '').trim();
    if (urlRaw) {
      const withScheme = /^[a-z][\w+.-]*:/i.test(urlRaw) ? urlRaw : `https://${urlRaw}`;
      const u = proxyGuard().assertProxyTarget(withScheme);
      if (!(await makeUrlChecker()(u.href))) throw new Error(`Blocked: ${u.hostname} resolves to a private or internal address`);
      tasks.push({ kind: 'url', source: u.href, filename: urlFilename(u), label: u.hostname });
    }
    for (const f of ctx.inputs) {
      tasks.push({ kind: 'file', source: await toHtmlFile(f.path, f.filename, join(jobDir, 'html')), filename: withExt(f.filename, 'pdf'), label: f.filename });
    }
    if (!tasks.length) throw new Error('Upload an HTML / Markdown file or enter a URL');

    const browserPath = o.engine === 'libreoffice' ? null : findBrowser();
    if (!browserPath) {
      if (o.engine === 'chromium') throw new Error('No Chromium / Chrome / Edge browser found on this server (set PUPPETEER_EXECUTABLE_PATH)');
      if (tasks.some(t => t.kind === 'url')) throw new Error('Rendering a URL needs Chromium, which is not installed on this server');
      if (!(await findBinary('soffice'))) throw new Error('Neither Chromium nor LibreOffice is installed on this server');
    }

    const outputs: JobOutput[] = [];
    const files: { source: string; pages: number; engine: string }[] = [];
    const used = new Set<string>();
    const uniq = (name: string) => {
      let n = name;
      for (let k = 2; used.has(n.toLowerCase()); k++) n = name.replace(/\.pdf$/, `-${k}.pdf`);
      used.add(n.toLowerCase());
      return n;
    };

    if (!browserPath) {
      for (const [i, t] of tasks.entries()) {
        ctx.progress(5 + (90 * i) / tasks.length, `Rendering ${t.label} with LibreOffice`);
        const written = await sofficeConvert({
          input: t.source, outDir: join(jobDir, 'lo-out', String(i)), profileDir: join(jobDir, 'lo-profile'),
          convertTo: 'pdf:writer_pdf_Export', infilter: 'HTML (StarWriter)', signal: ctx.signal,
        });
        const pdf = written.find(p => p.toLowerCase().endsWith('.pdf'));
        if (!pdf) throw new Error(`LibreOffice could not render ${t.label}`);
        const name = uniq(t.filename);
        const dest = join(ctx.workDir, name);
        await fs.rename(pdf, dest);
        outputs.push({ path: dest, filename: name });
        files.push({ source: t.label, pages: countPdfPages(await fs.readFile(dest)), engine: 'libreoffice' });
      }
      return { outputs, meta: { engine: 'libreoffice', files } };
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require('puppeteer-core');
    ctx.progress(3, 'Starting browser');
    const browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      pipe: true,
      userDataDir: join(jobDir, 'chrome-profile'),
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-sync', '--mute-audio', '--hide-scrollbars',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    });
    const pid: number | undefined = browser.process()?.pid;
    const onAbort = () => killTree(pid);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const blocked: string[] = [];
    try {
      const marginMm = Math.max(0, Number(o.margin) || 0);
      const footer = !!o.pageNumbers;
      const header = String(o.headerText || '').trim();
      const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      for (const [i, t] of tasks.entries()) {
        if (ctx.signal.aborted) throw new Error('Cancelled');
        ctx.progress(8 + (85 * i) / tasks.length, `Rendering ${t.label}`);
        const fileUrl = t.kind === 'file' ? pathToFileURL(t.source).href : undefined;
        const allowed = makeUrlChecker(fileUrl);
        const page = await browser.newPage();
        try {
          await page.setRequestInterception(true);
          page.on('request', (req: any) => {
            if (req.isInterceptResolutionHandled?.()) return;
            const url: string = req.url();
            allowed(url).then(ok => {
              if (ok) return req.continue();
              if (blocked.length < 20) blocked.push(url.slice(0, 200));
              return req.abort('blockedbyclient');
            }).catch(() => req.abort('failed').catch(() => {}));
          });
          await page.emulateMediaType(o.media === 'screen' ? 'screen' : 'print');
          if (o.media === 'screen') await page.setViewport({ width: 1280, height: 900 });
          try {
            await page.goto(t.kind === 'url' ? t.source : fileUrl!, { waitUntil: 'networkidle2', timeout: 60_000 });
          } catch (e) {
            const msg = (e as Error).message;
            // A page that never goes idle (polling, analytics) is still usually renderable.
            if (!/timeout/i.test(msg)) throw new Error(`Could not load ${t.label}: ${msg.split('\n')[0]}`);
          }
          const wait = Math.min(15_000, Math.max(0, Number(o.waitMs) || 0));
          if (wait) await new Promise(r => setTimeout(r, wait));
          const pdf: Uint8Array = await page.pdf({
            format: PAGE_FORMATS.includes(o.pageSize) ? o.pageSize : 'A4',
            landscape: !!o.landscape,
            printBackground: !!o.printBackground,
            scale: Math.min(2, Math.max(0.1, Number(o.scale) || 1)),
            margin: {
              top: `${header ? Math.max(marginMm, 15) : marginMm}mm`, bottom: `${footer ? Math.max(marginMm, 15) : marginMm}mm`,
              left: `${marginMm}mm`, right: `${marginMm}mm`,
            },
            displayHeaderFooter: footer || !!header,
            headerTemplate: header
              ? `<div style="font-size:8px;width:100%;padding:0 ${marginMm}mm;color:#666;font-family:sans-serif">${escHtml(header)}</div>`
              : '<div></div>',
            footerTemplate: footer
              ? '<div style="font-size:8px;width:100%;text-align:center;color:#666;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
              : '<div></div>',
            timeout: 120_000,
          });
          const buf = Buffer.from(pdf);
          const name = uniq(t.filename);
          const dest = join(ctx.workDir, name);
          await fs.writeFile(dest, buf);
          outputs.push({ path: dest, filename: name });
          files.push({ source: t.label, pages: countPdfPages(buf), engine: 'chromium' });
        } finally {
          await page.close().catch(() => {});
        }
      }
    } catch (e) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      throw e;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
      if (browser.process()?.exitCode === null) killTree(pid);
    }
    return { outputs, meta: { engine: 'chromium', files, blockedRequests: blocked } };
  },
};
