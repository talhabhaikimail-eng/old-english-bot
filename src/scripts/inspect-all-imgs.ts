import * as fs from 'fs';

function inspectAll() {
    const html = fs.readFileSync('debug-google.html', 'utf8');
    
    // Find all img tags and print their attributes
    const imgRegex = /<img\s+([^>]*?)>/gi;
    let match;
    const imgs: any[] = [];
    while ((match = imgRegex.exec(html)) !== null) {
        const attrs = match[1];
        const srcMatch = /src="([^"]*)"/i.exec(attrs);
        const altMatch = /alt="([^"]*)"/i.exec(attrs);
        const dataSrcMatch = /data-src="([^"]*)"/i.exec(attrs);
        const classMatch = /class="([^"]*)"/i.exec(attrs);
        
        imgs.push({
            src: srcMatch ? srcMatch[1] : null,
            alt: altMatch ? altMatch[1] : null,
            dataSrc: dataSrcMatch ? dataSrcMatch[1] : null,
            className: classMatch ? classMatch[1] : null,
            raw: match[0]
        });
    }

    console.log(`Total <img> tags: ${imgs.length}`);
    
    const base64Imgs = imgs.filter(i => i.src && i.src.startsWith('data:image'));
    const externalImgs = imgs.filter(i => i.src && !i.src.startsWith('data:image'));
    const noSrcImgs = imgs.filter(i => !i.src);

    console.log(`Base64 images: ${base64Imgs.length}`);
    console.log(`External images: ${externalImgs.length}`);
    console.log(`No-src images: ${noSrcImgs.length}`);

    console.log('\n--- First 10 Base64 images ---');
    base64Imgs.slice(0, 10).forEach((i, idx) => {
        console.log(`${idx + 1}: class="${i.className}" alt="${i.alt}" src="${i.src.substring(0, 80)}..."`);
    });

    console.log('\n--- First 10 External images ---');
    externalImgs.slice(0, 10).forEach((i, idx) => {
        console.log(`${idx + 1}: class="${i.className}" alt="${i.alt}" src="${i.src}"`);
    });

    console.log('\n--- First 10 No-src images ---');
    noSrcImgs.slice(0, 10).forEach((i, idx) => {
        console.log(`${idx + 1}: class="${i.className}" alt="${i.alt}" data-src="${i.dataSrc}"`);
    });
}

inspectAll();
