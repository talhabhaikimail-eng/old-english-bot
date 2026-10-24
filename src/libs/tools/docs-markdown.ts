/**
 * @file tools/docs-markdown.ts
 * @description Small dependency-free Markdown → HTML renderer (CommonMark-ish + GFM tables, task
 * lists, strikethrough, fenced code) used when Markdown files are uploaded to html-to-pdf or
 * office-convert. The dashboard renders pasted Markdown with `marked` before upload; this covers
 * uploaded .md files and API use.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeUrl(u: string): string {
  const t = u.trim();
  return /^(javascript|vbscript|data:text\/html):/i.test(t) ? '#' : esc(t);
}

function inline(src: string): string {
  // Pull code spans out first so their content isn't formatted.
  const codes: string[] = [];
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c: string) => {
    codes.push(`<code>${esc(c.trim())}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Keep inline HTML tags as-is, escape stray < > &.
  const tags: string[] = [];
  s = s.replace(/<\/?[A-Za-z][^<>]*>/g, m => { tags.push(m); return `\u0001${tags.length - 1}\u0001`; });
  s = s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, alt, url, title) =>
      `<img src="${safeUrl(url)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''}>`)
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, text, url, title) =>
      `<a href="${safeUrl(url)}"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${safeUrl(url)}">${url}</a>`)
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/ {2,}\n|\\\n/g, '<br>\n');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => tags[Number(i)]);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const splitRow = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out: string[] = [];
  let i = 0;

  const listItemRe = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

  function renderList(start: number, baseIndent: number): number {
    const first = listItemRe.exec(lines[start])!;
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    out.push(ordered ? (startNum !== 1 ? `<ol start="${startNum}">` : '<ol>') : '<ul>');
    let j = start;
    while (j < lines.length) {
      const m = listItemRe.exec(lines[j]);
      if (!m || m[1].length < baseIndent) break;
      if (m[1].length > baseIndent) { j = renderList(j, m[1].length); continue; }
      if (/\d/.test(m[2]) !== ordered) break;
      let text = m[3];
      j++;
      // Continuation lines (indented, not a new item).
      while (j < lines.length && lines[j].trim() && !listItemRe.test(lines[j]) && /^\s+/.test(lines[j])) {
        text += '\n' + lines[j].trim();
        j++;
      }
      const task = /^\[([ xX])\]\s+(.*)$/s.exec(text);
      const body = task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}` : inline(text);
      // Nested list directly after this item.
      if (j < lines.length) {
        const nm = listItemRe.exec(lines[j]);
        if (nm && nm[1].length > baseIndent) {
          out.push(`<li${task ? ' class="task"' : ''}>${body}`);
          j = renderList(j, nm[1].length);
          out.push('</li>');
          continue;
        }
      }
      out.push(`<li${task ? ' class="task"' : ''}>${body}</li>`);
      // A single blank line between items keeps the list going.
      if (j < lines.length - 1 && !lines[j].trim() && listItemRe.test(lines[j + 1]) && listItemRe.exec(lines[j + 1])![1].length >= baseIndent) j++;
    }
    out.push(ordered ? '</ol>' : '</ul>');
    return j;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` class="language-${esc(fence[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = h[2];
      const id = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
      out.push(`<h${h[1].length} id="${esc(id)}">${inline(text)}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (listItemRe.test(line)) { i = renderList(i, listItemRe.exec(line)![1].length); continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const al = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(`<tr>${splitRow(lines[i]).map((c, k) => `<td${al(k)}>${inline(c)}</td>`).join('')}</tr>`);
        i++;
      }
      out.push(`<table><thead><tr>${header.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    if (/^ {4,}\S/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i]) || !lines[i].trim())) body.push(lines[i++].slice(4));
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*<(\/?[A-Za-z][\w-]*|!--)/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
      out.push(body.join('\n'));
      continue;
    }
    // Paragraph (with setext heading support).
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d{1,9}[.)])\s)/.test(lines[i])) {
      if (para.length && /^\s*(=+|-+)\s*$/.test(lines[i])) break;
      para.push(lines[i++]);
    }
    if (i < lines.length && para.length && /^\s*(=+|-+)\s*$/.test(lines[i])) {
      const lvl = lines[i].trim().startsWith('=') ? 1 : 2;
      out.push(`<h${lvl}>${inline(para.join('\n'))}</h${lvl}>`);
      i++;
      continue;
    }
    if (!para.length) { para.push(lines[i++]); }
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

/** Clean, print-friendly stylesheet shared by Markdown and plain-text renders. */
export const PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { font-size: 11pt; }
body { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", sans-serif;
  line-height: 1.55; color: #1f2328; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; page-break-after: avoid; break-after: avoid; }
h1 { font-size: 1.9em; border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
h2 { font-size: 1.45em; border-bottom: 1px solid #d0d7de; padding-bottom: .25em; }
h3 { font-size: 1.2em; } h4 { font-size: 1.05em; }
p, ul, ol, table, pre, blockquote { margin: 0 0 0.9em; }
a { color: #0969da; text-decoration: none; }
code { font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.88em;
  background: #f3f4f6; border-radius: 4px; padding: 0.1em 0.35em; }
pre { background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; overflow: hidden;
  white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 0.85em; }
blockquote { border-left: 4px solid #d0d7de; color: #57606a; padding: 0 1em; margin-left: 0; }
table { border-collapse: collapse; width: auto; max-width: 100%; page-break-inside: auto; }
tr { page-break-inside: avoid; break-inside: avoid; }
th, td { border: 1px solid #d0d7de; padding: 5px 10px; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
img { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
li.task { list-style: none; margin-left: -1.2em; }
`;

export function htmlDocument(title: string, bodyHtml: string, extraCss = ''): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${PRINT_CSS}${extraCss}</style></head>
<body>
${bodyHtml}
</body></html>`;
}

export function markdownToHtmlDocument(md: string, title = 'Document'): string {
  return htmlDocument(title, markdownToHtml(md));
}

export function textToHtmlDocument(text: string, title = 'Document'): string {
  return htmlDocument(title, `<pre style="border:0;background:none;padding:0;font-size:10pt">${esc(text)}</pre>`);
}
