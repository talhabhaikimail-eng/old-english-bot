import * as fs from 'fs';

function inspectContainers() {
    const html = fs.readFileSync('debug-google.html', 'utf8');
    
    // Find all blocks of HTML that match some YQ4gaf img tags
    // and show their surrounding structure
    const imgRegex = /<img[^>]+class="YQ4gaf"[^>]*>/gi;
    let match;
    let count = 0;
    while ((match = imgRegex.exec(html)) !== null && count < 6) {
        count++;
        const startIndex = Math.max(0, match.index - 300);
        const endIndex = Math.min(html.length, match.index + match[0].length + 300);
        console.log(`\n================ IMAGE MATCH ${count} ================`);
        console.log(html.substring(startIndex, endIndex));
    }
}

inspectContainers();
