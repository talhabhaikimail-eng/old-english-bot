import * as fs from 'fs';

function fixDuplicate() {
    const filePath = 'd:\\discord-whatsapp\\src\\libs\\browser-pool.ts';
    let content = fs.readFileSync(filePath, 'utf8');

    // We want to find the whole evaluate return block that has:
    // "        return {
    //           captcha: false,
    //           organic: cleanOrganic,"
    // all the way down to:
    // "      }, categoryParam);"
    // and replace it with a clean single return statement.
    const startTag = '        return {\n          captcha: false,\n          organic: cleanOrganic,';
    const endTag = '      }, categoryParam);';

    const startIdx = content.indexOf(startTag);
    const endIdx = content.indexOf(endTag);

    if (startIdx !== -1 && endIdx !== -1) {
        const replacement = `        return {
          captcha: false,
          organic: cleanOrganic,
          aiResponse: categoryParamInner === 'all' ? aiResponse : null,
          featuredSnippet: categoryParamInner === 'all' ? featuredSnippet : null,
          knowledgePanel: categoryParamInner === 'all' ? knowledgePanel : null,
          peopleAlsoAsk: categoryParamInner === 'all' ? peopleAlsoAsk : undefined,
          directAnswer: categoryParamInner === 'all' ? directAnswer : null,
          news: cleanNews.length > 0 ? cleanNews : undefined,
          videos: cleanVideos.length > 0 ? cleanVideos : undefined,
          images: cleanImages.length > 0 ? cleanImages : undefined,
          shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
          relatedSearches: categoryParamInner === 'all' ? relatedSearches : undefined,
          localResults: cleanLocalResults.length > 0 ? cleanLocalResults : undefined
        };
      }, categoryParam);`;

        content = content.substring(0, startIdx) + replacement + content.substring(endIdx + endTag.length);
        console.log("Cleaned evaluate return successfully!");
    } else {
        // Try with CRLF (\r\n) normalization
        const norm = (str: string) => str.replace(/\r\n/g, '\n');
        let normContent = norm(content);
        const normStartTag = norm(startTag);
        const normEndTag = norm(endTag);
        
        const nStartIdx = normContent.indexOf(normStartTag);
        const nEndIdx = normContent.indexOf(normEndTag);
        
        if (nStartIdx !== -1 && nEndIdx !== -1) {
            const replacement = `        return {
          captcha: false,
          organic: cleanOrganic,
          aiResponse: categoryParamInner === 'all' ? aiResponse : null,
          featuredSnippet: categoryParamInner === 'all' ? featuredSnippet : null,
          knowledgePanel: categoryParamInner === 'all' ? knowledgePanel : null,
          peopleAlsoAsk: categoryParamInner === 'all' ? peopleAlsoAsk : undefined,
          directAnswer: categoryParamInner === 'all' ? directAnswer : null,
          news: cleanNews.length > 0 ? cleanNews : undefined,
          videos: cleanVideos.length > 0 ? cleanVideos : undefined,
          images: cleanImages.length > 0 ? cleanImages : undefined,
          shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
          relatedSearches: categoryParamInner === 'all' ? relatedSearches : undefined,
          localResults: cleanLocalResults.length > 0 ? cleanLocalResults : undefined
        };
      }, categoryParam);`;

            content = normContent.substring(0, nStartIdx) + replacement + normContent.substring(nEndIdx + normEndTag.length);
            console.log("Cleaned evaluate return with normalized content successfully!");
        } else {
            console.error("Could not locate return duplicate block.");
        }
    }

    fs.writeFileSync(filePath, content, 'utf8');
}

fixDuplicate();
