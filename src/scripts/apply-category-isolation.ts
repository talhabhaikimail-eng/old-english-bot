import * as fs from 'fs';

function applyCleanCategoryIsolation() {
    const file1 = 'd:\\discord-whatsapp\\src\\libs\\browser-pool.ts';
    const file2 = 'd:\\discord-whatsapp\\src\\scripts\\test-search-pool.ts';

    [file1, file2].forEach((filePath) => {
        let content = fs.readFileSync(filePath, 'utf8');

        // 1. Let's insert the normalization logic at the very beginning of the timedSearchViaPool and searchViaPool functions.
        // For browser-pool.ts:
        // "  const maxAttempts = Math.max(1, browserPool.getActive().length);"
        // For test-search-pool.ts:
        // "    const maxAttempts = Math.max(1, browserPool.getActive().length);"
        const targetStart = 'const maxAttempts = Math.max(1, browserPool.getActive().length);';
        const replacementStart = `const normCategory = category.toLowerCase().trim();
  let categoryKey = 'all';
  if (normCategory === 'videos' || normCategory === 'video') {
    categoryKey = 'videos';
  } else if (normCategory === 'images' || normCategory === 'image') {
    categoryKey = 'images';
  } else if (normCategory === 'news') {
    categoryKey = 'news';
  } else if (normCategory === 'shopping' || normCategory === 'shop') {
    categoryKey = 'shopping';
  } else if (normCategory === 'maps' || normCategory === 'map') {
    categoryKey = 'maps';
  }

  const maxAttempts = Math.max(1, browserPool.getActive().length);`;

        // Normalize first
        const norm = (str: string) => str.replace(/\r\n/g, '\n');
        let normContent = norm(content);

        if (normContent.includes(targetStart)) {
            normContent = normContent.replace(targetStart, replacementStart);
            console.log(`Normalized start of function in ${filePath}`);
        } else {
            // Check for indented version in test script
            const indentedTarget = '    const maxAttempts = Math.max(1, browserPool.getActive().length);';
            const indentedReplacement = `    const normCategory = category.toLowerCase().trim();
    let categoryKey = 'all';
    if (normCategory === 'videos' || normCategory === 'video') {
      categoryKey = 'videos';
    } else if (normCategory === 'images' || normCategory === 'image') {
      categoryKey = 'images';
    } else if (normCategory === 'news') {
      categoryKey = 'news';
    } else if (normCategory === 'shopping' || normCategory === 'shop') {
      categoryKey = 'shopping';
    } else if (normCategory === 'maps' || normCategory === 'map') {
      categoryKey = 'maps';
    }

    const maxAttempts = Math.max(1, browserPool.getActive().length);`;
            
            if (normContent.includes(indentedTarget)) {
                normContent = normContent.replace(indentedTarget, indentedReplacement);
                console.log(`Normalized indented start of function in ${filePath}`);
            } else {
                console.error(`Could not match start of function in ${filePath}`);
            }
        }

        // 2. Replace formulating targetUrl checks to use `categoryKey` instead of `category`
        normContent = normContent.replace("if (category === 'images')", "if (categoryKey === 'images')");
        normContent = normContent.replace("else if (category === 'videos')", "else if (categoryKey === 'videos')");
        normContent = normContent.replace("else if (category === 'news')", "else if (categoryKey === 'news')");
        normContent = normContent.replace("else if (category === 'shopping')", "else if (categoryKey === 'shopping')");
        normContent = normContent.replace("else if (category === 'maps')", "else if (categoryKey === 'maps')");

        // 3. Replace evaluate calls to pass `categoryKey` instead of `category`
        // results = await extractResults(category);
        normContent = normContent.replace(/extractResults\(category\)/g, 'extractResults(categoryKey)');

        // 4. Update the evaluate return block to enforce strict category tab filtering/isolation.
        // We look for:
        // "return {
        //   captcha: false,
        //   organic,
        //   aiResponse,"
        // And we will inject a clean category-specific filtering block right before returning!
        const targetReturnBlock = `return {
                    captcha: false,
                    organic,
                    aiResponse,`;
        
        const indentedTargetReturnBlock = `return {
                    captcha: false,
                    organic,
                    aiResponse,`;

        const replacementReturnBlock = `// Strict Category Tab Filtering / Isolation
                const cleanOrganic = categoryParam === 'all' ? organic : [];
                const cleanNews = categoryParam === 'news' ? news : [];
                const cleanVideos = categoryParam === 'videos' ? videos : [];
                const cleanImages = categoryParam === 'images' ? images : [];
                const cleanShopping = categoryParam === 'shopping' ? shopping : [];
                const cleanLocalResults = categoryParam === 'maps' ? localResults : [];

                return {
                    captcha: false,
                    organic: cleanOrganic,
                    aiResponse: categoryParam === 'all' ? aiResponse : null,
                    featuredSnippet: categoryParam === 'all' ? featuredSnippet : null,
                    knowledgePanel: categoryParam === 'all' ? knowledgePanel : null,
                    peopleAlsoAsk: categoryParam === 'all' ? peopleAlsoAsk : undefined,
                    directAnswer: categoryParam === 'all' ? directAnswer : null,
                    news: cleanNews.length > 0 ? cleanNews : undefined,
                    videos: cleanVideos.length > 0 ? cleanVideos : undefined,
                    images: cleanImages.length > 0 ? cleanImages : undefined,
                    shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
                    relatedSearches: categoryParam === 'all' ? relatedSearches : undefined,
                    localResults: cleanLocalResults.length > 0 ? cleanLocalResults : undefined
                };`;

        // Wait, for browser-pool.ts the variable in evaluate is categoryParamInner!
        // Let's customize it or define a unified block.
        if (filePath.includes('browser-pool.ts')) {
            const bpTarget = `return {
          captcha: false,
          organic,
          aiResponse,`;
            
            const bpReplacement = `// Strict Category Tab Filtering / Isolation
        const cleanOrganic = categoryParamInner === 'all' ? organic : [];
        const cleanNews = categoryParamInner === 'news' ? news : [];
        const cleanVideos = categoryParamInner === 'videos' ? videos : [];
        const cleanImages = categoryParamInner === 'images' ? images : [];
        const cleanShopping = categoryParamInner === 'shopping' ? shopping : [];
        const cleanLocalResults = categoryParamInner === 'maps' ? localResults : [];

        return {
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
        };`;
            
            if (normContent.includes(bpTarget)) {
                normContent = normContent.replace(bpTarget, bpReplacement);
                console.log(`Replaced return block in ${filePath}`);
            } else {
                console.error(`Could not find return block in ${filePath}`);
            }
        } else {
            // For test-search-pool.ts
            const tsTarget = `return {
                    captcha: false,
                    organic,
                    aiResponse,`;
            
            const tsReplacement = `// Strict Category Tab Filtering / Isolation
                const cleanOrganic = categoryParam === 'all' ? organic : [];
                const cleanNews = categoryParam === 'news' ? news : [];
                const cleanVideos = categoryParam === 'videos' ? videos : [];
                const cleanImages = categoryParam === 'images' ? images : [];
                const cleanShopping = categoryParam === 'shopping' ? shopping : [];
                const cleanLocalResults = categoryParam === 'maps' ? localResults : [];

                return {
                    captcha: false,
                    organic: cleanOrganic,
                    aiResponse: categoryParam === 'all' ? aiResponse : null,
                    featuredSnippet: categoryParam === 'all' ? featuredSnippet : null,
                    knowledgePanel: categoryParam === 'all' ? knowledgePanel : null,
                    peopleAlsoAsk: categoryParam === 'all' ? peopleAlsoAsk : undefined,
                    directAnswer: categoryParam === 'all' ? directAnswer : null,
                    news: cleanNews.length > 0 ? cleanNews : undefined,
                    videos: cleanVideos.length > 0 ? cleanVideos : undefined,
                    images: cleanImages.length > 0 ? cleanImages : undefined,
                    shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
                    relatedSearches: categoryParam === 'all' ? relatedSearches : undefined,
                    localResults: cleanLocalResults.length > 0 ? cleanLocalResults : undefined
                };`;
            
            if (normContent.includes(tsTarget)) {
                normContent = normContent.replace(tsTarget, tsReplacement);
                console.log(`Replaced return block in ${filePath}`);
            } else {
                console.error(`Could not find return block in ${filePath}`);
            }
        }

        // 5. Clean up the standard organic extract condition inside page.evaluate to match categoryParamInner or categoryParam
        if (filePath.includes('browser-pool.ts')) {
            normContent = normContent.replace("if (categoryParam === 'all')", "if (categoryParamInner === 'all')");
        }

        fs.writeFileSync(filePath, normContent, 'utf8');
    });

    console.log("Category isolation applied successfully!");
}

applyCleanCategoryIsolation();
