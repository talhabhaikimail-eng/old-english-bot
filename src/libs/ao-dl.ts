/** @deprecated Scratch test file only. Production code is in downloader.ts */

const {
  ttdl, fbdown, twitter,
  mediafire, capcut, gdrive, pinterest
} = require('ab-downloader');

const TESTS: Array<{ name: string; fn: Function; url: string }> = [
  { name: 'TikTok',    fn: ttdl,      url: 'https://www.tiktok.com/@tiktok/video/6584647400055697670' },
  { name: 'Facebook',  fn: fbdown,    url: 'https://www.facebook.com/watch/?v=1393572814172251' },
  { name: 'Twitter',   fn: twitter,   url: 'https://twitter.com/Twitter/status/1229369819511709697' },
  { name: 'MediaFire', fn: mediafire, url: 'https://www.mediafire.com/file/941xczxhn27qbby/file.apk/file' },
  { name: 'CapCut',    fn: capcut,    url: 'https://www.capcut.com/template-detail/7299286607478181121' },
  { name: 'GDrive',    fn: gdrive,    url: 'https://drive.google.com/file/d/1thDYWcS5p5FFhzTpTev7RUv0VFnNQyZ4/view' },
  { name: 'Pinterest', fn: pinterest, url: 'https://pin.it/4CVodSq' },
];

(async () => {
  for (const { name, fn, url } of TESTS) {
    try {
      const result = await fn(url);
    } catch (err: unknown) {
      console.error(`❌ ${name} error:`, err instanceof Error ? err.message : err);
    }
  }
})();