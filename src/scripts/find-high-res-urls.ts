import * as fs from 'fs';

function findUrls() {
    const html = fs.readFileSync('debug-google.html', 'utf8');
    
    // Let's search for keywords like "encrypted-tbn", "tbn:", "imgurl", "imgrefurl", etc.
    const searchTerms = ['encrypted-tbn', 'gstatic.com', 'imgurl', 'imgrefurl', '.jpg', '.jpeg', '.png'];
    
    searchTerms.forEach(term => {
        const regex = new RegExp(term, 'gi');
        let count = 0;
        while (regex.exec(html) !== null) count++;
        console.log(`Found term "${term}": ${count} occurrences`);
    });

    // Let's print some sample links that contain image file extensions or look like image URLs
    const urlRegex = /(https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|gif|webp))/gi;
    let match;
    const urls = new Set<string>();
    while ((match = urlRegex.exec(html)) !== null) {
        urls.add(match[1]);
    }
    console.log(`\nFound ${urls.size} unique image URLs via simple extension regex:`);
    Array.from(urls).slice(0, 15).forEach(u => console.log(u));
}

findUrls();
