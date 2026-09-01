import * as fs from 'fs';

function findContext() {
    const html = fs.readFileSync('debug-google.html', 'utf8');
    const target = 'Xxxtentacion_%28cropped%29.jpg';
    const index = html.indexOf(target);
    if (index !== -1) {
        const start = Math.max(0, index - 300);
        const end = Math.min(html.length, index + target.length + 300);
        console.log(`Context for "${target}":`);
        console.log(html.substring(start, end));
    } else {
        console.log(`"${target}" not found.`);
    }
}

findContext();
