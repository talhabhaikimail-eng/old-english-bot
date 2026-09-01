import { browserPool } from '../libs/browser-pool';
import { acquirePage, releasePage } from '../libs/page-pool';

const WORKERS = [
    { id: 'browser-worker-5-runner-2a319255', url: 'https://hammer-auburn-downloaded-affordable.trycloudflare.com' },
];

for (const w of WORKERS) {
    browserPool.register(w.id, w.url);
}

async function debugEvaluate() {
    const browser = browserPool.getNext();
    if (!browser) return;

    const { conn, page } = await acquirePage(browser);
    
    // Listen for browser logs
    page.on('console', (msg: any) => console.log('PAGE LOG:', msg.text()));

    try {
        const targetUrl = `https://www.google.com/search?q=xxxtentacion&start=0&num=100&hl=en&gbv=2&pws=0&udm=2`;
        console.log("Navigating to:", targetUrl);
        
        const client = await page.target().createCDPSession();
        await client.send('Page.navigate', { url: targetUrl });
        await page.waitForSelector('h3', { timeout: 10000 }).catch(() => {});

        console.log("Evaluating...");
        const results = await page.evaluate((categoryParam: string) => {
            console.log("Inside evaluate, categoryParam:", categoryParam);
            const pageHtml = document.documentElement.innerHTML;
            console.log("HTML length:", pageHtml.length);
            
            const imgRegex = /\[0\s*,\s*"([^"]+)"\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g;
            let imgMatch;
            let count = 0;
            while ((imgMatch = imgRegex.exec(pageHtml)) !== null) {
                count++;
                if (count <= 3) {
                    console.log("Found match:", imgMatch[5].substring(0, 50));
                }
            }
            console.log("Total regex matches:", count);
            return count;
        }, 'images');

        console.log("Returned count:", results);

    } catch (e) {
        console.error(e);
    } finally {
        await releasePage(conn, page, true);
    }
}

debugEvaluate().then(() => process.exit(0));
