import * as fs from 'fs';

function findImageLinks() {
    const html = fs.readFileSync('debug-google.html', 'utf8');
    
    // Let's find all <a ...> tags that wrap an <img ...> tag
    // Since we don't have cheerio, let's use a regex to find all <a href="..."> blocks and see if they have images inside or nearby.
    // Or we can search for the first 15 <img src="data:image/..." or <img data-src="..." or similar and find their surrounding anchors.
    const regex = /<a [^>]*href="([^"]+)"[^>]*>[\s\S]{0,300}?<img [^>]*src="([^"]+)"/g;
    let match;
    const matches: any[] = [];
    while ((match = regex.exec(html)) !== null) {
        matches.push({ href: match[1], src: match[2] });
    }
    
    console.log(`Found ${matches.length} matches via regex:`);
    matches.slice(0, 10).forEach((m, idx) => {
        console.log(`\nMatch ${idx + 1}:`);
        console.log(`Href: ${m.href}`);
        console.log(`Src:  ${m.src.substring(0, 100)}...`);
    });

    // Let's also do a broader search: just find any anchor tag and its immediate contents
    // or look at how the data-src is bound.
    const dataSrcRegex = /data-src="([^"]+)"/g;
    const dataSrcMatches: string[] = [];
    let dsMatch;
    while ((dsMatch = dataSrcRegex.exec(html)) !== null) {
        dataSrcMatches.push(dsMatch[1]);
    }
    console.log(`\nFound ${dataSrcMatches.length} data-src attributes:`);
    dataSrcMatches.slice(0, 5).forEach((m, idx) => {
        console.log(`${idx + 1}: ${m.substring(0, 100)}...`);
    });
}

findImageLinks();
