import { readFileSync } from 'fs';
import { join } from 'path';
import * as cheerio from 'cheerio';

const htmlPath = join(process.cwd(), 'artifacts', 'talhatech_search_results.html');
const html = readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

console.log("Analyzing HTML links...");
const links: any[] = [];
$('a').each((i, el) => {
  const href = $(el).attr('href');
  const text = $(el).text().trim();
  if (href) {
    links.push({ text, href });
  }
});

console.log(`Total anchors found: ${links.length}`);

// Print links containing 'talha', 'github', 'vercel' or 'tech'
const filtered = links.filter(l => 
  l.href.toLowerCase().includes('talha') || 
  l.href.toLowerCase().includes('vercel') || 
  l.href.toLowerCase().includes('tech') ||
  l.text.toLowerCase().includes('talhatech')
);

console.log("\nFiltered links matching potential target patterns:");
console.log(JSON.stringify(filtered, null, 2));
