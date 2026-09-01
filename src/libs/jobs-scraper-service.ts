import { searchViaPool, searchIndeedViaPool, browserPool } from './browser-pool';
import { getJobsFromR2, saveJobsToR2, getJobsStatusFromR2, saveJobsStatusToR2, ScrapedJob, JobsStatus } from './r2-jobs-store';

const DEFAULT_KEYWORDS = [
  'software engineer',
  "software developer",
  'web developer',
  'react developer',
  'node developer',
  'frontend developer',
  "full stack developer",
  "golang developer",
  "laravel developer",
  "php developer",
  "Fast api developer",
  "react js developer",
  "Next js developer",
  'backend developer',
  'python developer'
];

const DEFAULT_LOCATION = 'Pakistan';

const FORBIDDEN_DOMAINS = [
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'youtube.com', 'indeed.com', 'glassdoor.com', 'rozee.pk', 'mustakbil.com',
  'github.com', 'medium.com', 'crunchbase.com', 'wikipedia.org', 'upwork.com',
  'fiverr.com', 'careerjoin.com', 'simplyhired.com', 'pnp.com.pk', 'google.com',
  'pinterest.com', 'behance.net', 'dribbble.com'
];

function getNormalizedKey(title: string, company: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${clean(title)}_${clean(company)}`;
}

function parseGoogleJob(title: string, link: string, snippet: string): ScrapedJob {
  let jobTitle = title;
  let company = 'Unknown Company';
  
  // Strip common suffixes
  title = title.replace(/\s*\|\s*LinkedIn\s*$/i, '');
  title = title.replace(/\s*-\s*Indeed\s*$/i, '');
  title = title.replace(/\s*-\s*Glassdoor\s*$/i, '');

  const separators = [
    { regex: /\s+at\s+([^-|@]+)/i, compIndex: 1 },
    { regex: /\s*[@]\s*([^-|]+)/, compIndex: 1 },
    { regex: /\s*[-]\s*([^-|]+)/, compIndex: 1 },
    { regex: /\s*[|]\s*([^|]+)/, compIndex: 1 },
  ];

  for (const sep of separators) {
    const match = title.match(sep.regex);
    if (match) {
      company = match[sep.compIndex].trim();
      const idx = title.indexOf(match[0]);
      if (idx > 0) {
        jobTitle = title.substring(0, idx).trim();
      }
      break;
    }
  }

  // Clean company name from junk at the end
  company = company.replace(/\s+(Jobs|Hiring|Careers|Employment).*$/i, '');

  return {
    jk: 'google_' + Buffer.from(link).toString('base64').substring(0, 16).replace(/[^a-zA-Z0-9]/g, ''),
    title: jobTitle,
    company: company,
    location: 'Pakistan',
    salary: '',
    snippet: snippet,
    description: snippet,
    url: link,
    source: 'google',
    scrapedAt: new Date().toISOString()
  };
}

async function scrapeIndeedJobs(query: string, location: string): Promise<ScrapedJob[]> {
  const jobsList: ScrapedJob[] = [];

  // Scrape up to 2 pages of Indeed for this keyword
  for (let page = 1; page <= 2; page++) {
    try {
      console.log(`[Jobs Scraper] Scraping Indeed via BrowserPool: ${query} in ${location} (Page ${page})`);
      const poolRes = await searchIndeedViaPool(query, location, page);
      if (poolRes && poolRes.jobs && poolRes.jobs.length > 0) {
        for (const j of poolRes.jobs) {
          if (j.jk) {
            jobsList.push({
              jk: j.jk,
              title: j.title || query,
              company: j.company || 'Unknown Company',
              location: j.location || location,
              salary: j.salary || '',
              snippet: j.snippet || '',
              description: j.description || j.snippet || '',
              url: j.url || `https://www.indeed.com/viewjob?jk=${j.jk}`,
              source: 'indeed',
              scrapedAt: new Date().toISOString()
            });
          }
        }
        continue;
      }

      // Fallback: worker API
      const activeWorkers = browserPool.getActive().filter(b => b.apiUrl);
      if (activeWorkers.length > 0) {
        const worker = activeWorkers[0];
        console.log(`[Jobs Scraper] Fallback: Scraping Indeed via worker API ${worker.workerId}`);
        const response = await fetch(`${worker.apiUrl}/scrape/indeed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, location, page }),
        });

        if (response.ok) {
          const jobs = await response.json() as any[];
          if (Array.isArray(jobs)) {
            for (const j of jobs) {
              if (j.jk) {
                jobsList.push({
                  jk: j.jk,
                  title: j.title || query,
                  company: j.company || 'Unknown Company',
                  location: j.location || location,
                  salary: j.salary || '',
                  snippet: j.snippet || '',
                  description: j.description || j.snippet || '',
                  url: j.url || `https://www.indeed.com/viewjob?jk=${j.jk}`,
                  source: 'indeed',
                  scrapedAt: new Date().toISOString()
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Jobs Scraper] Indeed scraping error for page ${page}:`, err);
    }
  }

  return jobsList;
}

async function scrapeGoogleJobs(query: string): Promise<ScrapedJob[]> {
  const jobsList: ScrapedJob[] = [];
  try {
    const searchQuery = `"${query}" jobs Pakistan`;
    console.log(`[Jobs Scraper] Scraping Google Search for: "${searchQuery}"`);
    const results = await searchViaPool(searchQuery, 1, false, 'all');
    if (results && Array.isArray(results.organic)) {
      for (const result of results.organic) {
        // Skip job portal pages themselves as company pages
        const isPortal = FORBIDDEN_DOMAINS.some(domain => result.link.includes(domain));
        if (isPortal && !result.link.includes('linkedin.com/jobs')) {
          continue;
        }
        jobsList.push(parseGoogleJob(result.title, result.link, result.snippet));
      }
    }
  } catch (err) {
    console.error(`[Jobs Scraper] Google search scraping error:`, err);
  }
  return jobsList;
}

export async function findCompanyWebsite(company: string): Promise<string | null> {
  try {
    const query = `"${company} Pakistan" official website`;
    console.log(`[Jobs Scraper] Finding website for company "${company}" via query: "${query}"`);
    const results = await searchViaPool(query, 1, false, 'all');
    if (results && Array.isArray(results.organic)) {
      for (const result of results.organic) {
        const urlObj = new URL(result.link);
        const domain = urlObj.hostname.replace(/^www\./i, '').toLowerCase();
        
        const isForbidden = FORBIDDEN_DOMAINS.some(fd => domain === fd || domain.endsWith('.' + fd));
        if (!isForbidden) {
          console.log(`[Jobs Scraper] Found website for "${company}": ${result.link}`);
          return result.link;
        }
      }
    }
  } catch (err) {
    console.error(`[Jobs Scraper] Error finding company website for "${company}":`, err);
  }
  return null;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+92|0092|0)[\s\-]?[0-9]{2,3}[\s\-]?[0-9]{7}/g;
const LINKEDIN_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/gi;

function extractEmailsFromText(text: string): string[] {
  const matches = text.match(EMAIL_REGEX) || [];
  // Filter out common false-positives (image extensions, example domains)
  return [...new Set(matches.filter(e =>
    !e.match(/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i) &&
    !e.includes('example.') &&
    !e.includes('sentry.') &&
    !e.includes('@2x') &&
    !e.endsWith('.min')
  ))];
}

function extractPhonesFromText(text: string): string[] {
  const matches = text.match(PHONE_REGEX) || [];
  return [...new Set(matches.map(p => p.replace(/[\s\-]/g, '')))];
}

async function findContactsViaGoogle(company: string): Promise<{ emails: string[]; phones: string[]; socials: { linkedin?: string[] } }> {
  const result = { emails: [] as string[], phones: [] as string[], socials: { linkedin: [] as string[] } };

  const queries = [
    `"${company}" contact email Pakistan`,
    `"${company}" Pakistan HR recruiter site:linkedin.com`,
  ];

  for (const query of queries) {
    try {
      console.log(`[Jobs Scraper] Google contact search: "${query}"`);
      const res = await searchViaPool(query, 1, false, 'all');
      if (!res) continue;

      // Extract from organic snippets and titles
      for (const item of res.organic || []) {
        const text = `${item.title} ${item.snippet} ${item.link}`;
        result.emails.push(...extractEmailsFromText(text));
        result.phones.push(...extractPhonesFromText(text));
        // Collect LinkedIn profile URLs for HR/recruiter results
        const linkedins = text.match(LINKEDIN_REGEX) || [];
        result.socials.linkedin!.push(...linkedins);
      }

      // Extract from featured snippet
      if (res.featuredSnippet) {
        const text = `${res.featuredSnippet.title} ${res.featuredSnippet.snippet}`;
        result.emails.push(...extractEmailsFromText(text));
        result.phones.push(...extractPhonesFromText(text));
      }

      // Local results often have phone numbers
      for (const local of res.localResults || []) {
        if (local.phone) result.phones.push(...extractPhonesFromText(local.phone));
      }

      // Knowledge panel may have phone/website
      if (res.knowledgePanel?.attributes) {
        for (const attr of res.knowledgePanel.attributes) {
          const text = `${attr.label} ${attr.value}`;
          result.emails.push(...extractEmailsFromText(text));
          result.phones.push(...extractPhonesFromText(text));
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[Jobs Scraper] Google contact search error for "${company}":`, err);
    }
  }

  // Deduplicate
  result.emails = [...new Set(result.emails)];
  result.phones = [...new Set(result.phones)];
  result.socials.linkedin = [...new Set(result.socials.linkedin)];

  return result;
}

export async function scrapeCompanyContacts(websiteUrl: string, company?: string): Promise<any | null> {
  // Run direct website scraper and Google search in parallel
  const [directResult, googleResult] = await Promise.allSettled([
    (async () => {
      try {
        console.log(`[Jobs Scraper] Direct scraping contacts for: ${websiteUrl}`);
        const scraperApi = `http://127.0.0.1:8081/api/scrape?url=${encodeURIComponent(websiteUrl)}&max-pages=8&workers=4&timeout=25s`;
        const response = await fetch(scraperApi, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          return await response.json() as any;
        }
      } catch (err) {
        console.error(`[Jobs Scraper] Error direct scraping contacts for ${websiteUrl}:`, err);
      }
      return null;
    })(),
    company ? findContactsViaGoogle(company) : Promise.resolve(null),
  ]);

  const direct = directResult.status === 'fulfilled' ? directResult.value : null;
  const google = googleResult.status === 'fulfilled' ? googleResult.value : null;

  const emails = new Set<string>([
    ...(direct?.emails || []),
    ...(google?.emails || []),
  ]);
  const phones = new Set<string>([
    ...(direct?.phones || []),
    ...(google?.phones || []),
  ]);

  // Merge socials: direct scraper returns an object, google gives linkedin array
  const socials: Record<string, any> = { ...(direct?.socials || {}) };
  if (google?.socials?.linkedin?.length) {
    socials.linkedin = [...new Set([
      ...(Array.isArray(socials.linkedin) ? socials.linkedin : (socials.linkedin ? [socials.linkedin] : [])),
      ...google.socials.linkedin,
    ])];
  }

  if (emails.size === 0 && phones.size === 0 && Object.keys(socials).length === 0) {
    return null;
  }

  return {
    emails: [...emails],
    phones: [...phones],
    socials,
    pagesCrawled: direct?.pagesCrawled || 0,
  };
}

// Main execution function
let isScrapeRunning = false;

export async function runJobsScraper(customKeywords?: string[], customLocation?: string): Promise<{ success: boolean; message: string }> {
  if (isScrapeRunning) {
    return { success: false, message: 'Scraper job is already running.' };
  }
  isScrapeRunning = true;

  const keywords = customKeywords && customKeywords.length > 0 ? customKeywords : DEFAULT_KEYWORDS;
  const location = customLocation || DEFAULT_LOCATION;

  // 1. Update status to scraping
  const status = await getJobsStatusFromR2();
  status.status = 'scraping';
  status.startedAt = new Date().toISOString();
  await saveJobsStatusToR2(status);

  // Run in background asynchronously so it doesn't block the HTTP request
  (async () => {
    try {
      console.log(`[Jobs Scraper] Starting automated run for keywords: ${keywords.join(', ')}`);
      
      // Load existing historical jobs database
      const historicalJobs = await getJobsFromR2();
      console.log(`[Jobs Scraper] Loaded ${historicalJobs.length} historical jobs from R2.`);
      
      // Create cache of known company websites and contacts to save API requests
      const companyWebsiteCache = new Map<string, string>();
      const companyContactsCache = new Map<string, any>();
      for (const job of historicalJobs) {
        if (job.company && job.companyWebsite) {
          companyWebsiteCache.set(job.company.toLowerCase(), job.companyWebsite);
        }
        if (job.company && job.contacts) {
          companyContactsCache.set(job.company.toLowerCase(), job.contacts);
        }
      }

      const newlyScrapedJobs: ScrapedJob[] = [];

      // 2. Scrape jobs from Indeed and Google
      for (const keyword of keywords) {
        // Indeed jobs
        const indeedJobs = await scrapeIndeedJobs(keyword, location);
        newlyScrapedJobs.push(...indeedJobs);

        // Google jobs
        const googleJobs = await scrapeGoogleJobs(keyword);
        newlyScrapedJobs.push(...googleJobs);

        // Sleep briefly to avoid slamming Google search
        await new Promise(r => setTimeout(r, 2000));
      }

      console.log(`[Jobs Scraper] Raw scraped jobs count: ${newlyScrapedJobs.length}`);

      // 3. Deduplicate newly scraped jobs among themselves and keep unique ones
      const uniqueNewJobsMap = new Map<string, ScrapedJob>();
      for (const job of newlyScrapedJobs) {
        const key = getNormalizedKey(job.title, job.company);
        if (!uniqueNewJobsMap.has(key)) {
          uniqueNewJobsMap.set(key, job);
        }
      }
      
      const uniqueNewJobs = Array.from(uniqueNewJobsMap.values());
      console.log(`[Jobs Scraper] Deduplicated new jobs count: ${uniqueNewJobs.length}`);

      // Filter out jobs that are already present in historicalJobs
      const finalJobsToProcess: ScrapedJob[] = [];
      const historicalKeys = new Set(historicalJobs.map(j => getNormalizedKey(j.title, j.company)));

      for (const job of uniqueNewJobs) {
        const key = getNormalizedKey(job.title, job.company);
        if (!historicalKeys.has(key)) {
          finalJobsToProcess.push(job);
        }
      }

      console.log(`[Jobs Scraper] Jobs to process for company info and contacts: ${finalJobsToProcess.length}`);

      // 4. For each job, find company website and scrape contacts
      let processedCount = 0;
      let lastSaveTime = Date.now();
      const SAVE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

      const saveProgress = async (currentProcessedCount: number) => {
        const processedNewJobs = finalJobsToProcess.slice(0, currentProcessedCount);
        const mergedJobs = [...processedNewJobs, ...historicalJobs];
        
        // Deduplicate the entire merged array (safety check)
        const finalMergedMap = new Map<string, ScrapedJob>();
        for (const job of mergedJobs) {
          const key = getNormalizedKey(job.title, job.company);
          if (finalMergedMap.has(key)) {
            const existing = finalMergedMap.get(key)!;
            // Prefer the one that has companyWebsite or contacts
            if (!existing.contacts && job.contacts) {
              finalMergedMap.set(key, job);
            }
          } else {
            finalMergedMap.set(key, job);
          }
        }

        const finalJobsList = Array.from(finalMergedMap.values());
        
        // Sort jobs by scrapedAt descending
        finalJobsList.sort((a, b) => new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime());

        // Save merged jobs to R2
        await saveJobsToR2(finalJobsList);

        // Compute statistics
        const totalCompanies = new Set(finalJobsList.map(j => j.company.toLowerCase())).size;

        // Update Status
        const currentStatus: JobsStatus = {
          ...status,
          lastRun: status.lastRun,
          status: 'scraping',
          startedAt: status.startedAt,
          stats: {
            totalJobs: finalJobsList.length,
            companiesScraped: totalCompanies,
            lastRunCount: finalJobsToProcess.length
          }
        };

        await saveJobsStatusToR2(currentStatus);
        console.log(`[Jobs Scraper] Saved intermediate progress: ${currentProcessedCount}/${finalJobsToProcess.length} jobs processed.`);
      };

      for (const job of finalJobsToProcess) {
        const compLower = job.company.toLowerCase();
        
        // Check cache for website
        let website = companyWebsiteCache.get(compLower) || null;
        if (!website && job.company !== 'Unknown Company') {
          website = await findCompanyWebsite(job.company);
          if (website) {
            companyWebsiteCache.set(compLower, website);
          }
          // Sleep briefly to avoid Google rate limit
          await new Promise(r => setTimeout(r, 1500));
        }

        if (website) {
          job.companyWebsite = website;

          // Check cache for contacts
          let contacts = companyContactsCache.get(compLower) || null;
          if (!contacts) {
            contacts = await scrapeCompanyContacts(website, job.company);
            if (contacts) {
              companyContactsCache.set(compLower, contacts);
            }
          }

          if (contacts) {
            job.contacts = contacts;
          }
        }

        processedCount++;
        if (processedCount % 5 === 0) {
          console.log(`[Jobs Scraper] Processed ${processedCount}/${finalJobsToProcess.length} jobs.`);
        }

        // Save progress every 10 minutes
        if (Date.now() - lastSaveTime >= SAVE_INTERVAL_MS) {
          try {
            await saveProgress(processedCount);
            lastSaveTime = Date.now();
          } catch (saveErr) {
            console.error('[Jobs Scraper] Failed to save intermediate progress:', saveErr);
          }
        }
      }

      // 5. Merge processed jobs with historical jobs
      const mergedJobs = [...finalJobsToProcess, ...historicalJobs];
      
      // Deduplicate the entire merged array (safety check)
      const finalMergedMap = new Map<string, ScrapedJob>();
      for (const job of mergedJobs) {
        const key = getNormalizedKey(job.title, job.company);
        // If it already exists, prefer the one that has companyWebsite or contacts
        if (finalMergedMap.has(key)) {
          const existing = finalMergedMap.get(key)!;
          if (!existing.contacts && job.contacts) {
            finalMergedMap.set(key, job);
          }
        } else {
          finalMergedMap.set(key, job);
        }
      }

      const finalJobsList = Array.from(finalMergedMap.values());
      
      // Sort jobs by scrapedAt descending
      finalJobsList.sort((a, b) => new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime());

      // Save merged jobs to R2
      await saveJobsToR2(finalJobsList);

      // Compute statistics
      const totalCompanies = new Set(finalJobsList.map(j => j.company.toLowerCase())).size;

      // 6. Update Status
      const finalStatus: JobsStatus = {
        ...status,
        lastRun: new Date().toISOString(),
        status: 'completed',
        stats: {
          totalJobs: finalJobsList.length,
          companiesScraped: totalCompanies,
          lastRunCount: finalJobsToProcess.length
        }
      };

      await saveJobsStatusToR2(finalStatus);
      console.log(`[Jobs Scraper] Completed automated run successfully! Merged DB size: ${finalJobsList.length} jobs.`);
    } catch (err: any) {
      console.error('[Jobs Scraper] Automated job run failed:', err);
      const finalStatus: JobsStatus = {
        ...status,
        lastRun: new Date().toISOString(),
        status: 'failed',
        error: err.message || 'Unknown error occurred.',
        stats: status.stats
      };
      await saveJobsStatusToR2(finalStatus);
    } finally {
      isScrapeRunning = false;
    }
  })();

  return { success: true, message: 'Scraper job started in the background.' };
}
