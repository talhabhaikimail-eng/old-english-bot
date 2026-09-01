import { convertHtmlToMarkdown } from 'dom-to-semantic-markdown';
import { JSDOM } from 'jsdom';
import fs from 'fs';
const html = fs.readFileSync('./src/scripts/index.html', { encoding: "utf-8" })
const dom = new JSDOM(html);
const markdown = convertHtmlToMarkdown(html, { overrideDOMParser: new dom.window.DOMParser() });
console.log(markdown);