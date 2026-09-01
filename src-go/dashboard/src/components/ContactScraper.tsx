import { useState } from 'react';
import { 
  Globe, 
  Terminal as TerminalIcon, 
  Play, 
  RefreshCw, 
  Settings, 
  Mail, 
  Phone, 
  Share2, 
  Link as LinkIcon, 
  Copy, 
  Check, 
  AlertCircle
} from 'lucide-react';

interface ContactScraperProps {
  addLog: (msg: string) => void;
}

interface ScrapingResult {
  targetUrl: string;
  emails: string[];
  phones: string[];
  socials: Record<string, string>;
  pagesCrawled: number;
  internalLinks: string[];
}

export default function ContactScraper({ addLog }: ContactScraperProps) {
  const [targetUrl, setTargetUrl] = useState<string>('https://example.com');
  const [scraperServiceUrl, setScraperServiceUrl] = useState<string>('http://localhost:8081');
  const [maxPages, setMaxPages] = useState<number>(30);
  const [workers, setWorkers] = useState<number>(5);
  const [timeoutSec, setTimeoutSec] = useState<number>(30);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [copiedText, setCopiedText] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [results, setResults] = useState<ScrapingResult | null>(null);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(''), 2000);
  };

  const handleStartScrape = async () => {
    setIsScraping(true);
    setErrorMsg('');
    setResults(null);
    addLog(`Initiating contact scraping for URL: ${targetUrl} (Max Pages: ${maxPages}, Workers: ${workers}, Timeout: ${timeoutSec}s)`);

    try {
      const url = `${scraperServiceUrl}/api/scrape?url=${encodeURIComponent(targetUrl)}&max-pages=${maxPages}&workers=${workers}&timeout=${timeoutSec}s`;
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error! Status: ${response.status}`);
      }

      const data: ScrapingResult = await response.json();
      setResults(data);
      addLog(`Scraping completed! Crawled ${data.pagesCrawled} pages. Found ${data.emails.length} emails, ${data.phones.length} phones, and ${Object.keys(data.socials).length} socials.`);
    } catch (err: any) {
      const msg = err.message || 'Scrape request failed';
      setErrorMsg(msg);
      addLog(`Error during contact scraping: ${msg}`);
    } finally {
      setIsScraping(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full animate-in">
      <div className="flex flex-col lg:flex-row gap-8">
        
        {/* Left Panel: Configuration */}
        <div className="flex-1 glass-card rounded-2xl p-6 flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-brand" />
            <h2 className="text-lg font-semibold m-0 text-white">Scraper Configuration</h2>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs text-muted font-medium">Target Company Website URL</label>
              <div className="relative mt-1">
                <Globe className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
                <input
                  type="text"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  className="w-full bg-[#11151f] border border-white/10 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-brand"
                  placeholder="https://company.com"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted font-medium">Scraper Service API Endpoint</label>
              <div className="relative mt-1">
                <LinkIcon className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
                <input
                  type="text"
                  value={scraperServiceUrl}
                  onChange={(e) => setScraperServiceUrl(e.target.value)}
                  className="w-full bg-[#11151f] border border-white/10 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-brand"
                  placeholder="http://localhost:8081"
                />
              </div>
              <span className="text-[10px] text-muted mt-1 block">
                The endpoint where your contact-scraper microservice is running.
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-muted font-medium">Max Pages to Crawl</label>
                <input
                  type="number"
                  value={maxPages}
                  onChange={(e) => setMaxPages(parseInt(e.target.value) || 10)}
                  min="1"
                  max="500"
                  className="w-full mt-1 bg-[#11151f] border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="text-xs text-muted font-medium">Worker Goroutines</label>
                <input
                  type="number"
                  value={workers}
                  onChange={(e) => setWorkers(parseInt(e.target.value) || 1)}
                  min="1"
                  max="50"
                  className="w-full mt-1 bg-[#11151f] border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="text-xs text-muted font-medium">Timeout Limit (seconds)</label>
                <input
                  type="number"
                  value={timeoutSec}
                  onChange={(e) => setTimeoutSec(parseInt(e.target.value) || 5)}
                  min="5"
                  max="300"
                  className="w-full mt-1 bg-[#11151f] border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={handleStartScrape}
                disabled={isScraping || !targetUrl}
                className="px-5 py-2.5 rounded-lg bg-brand text-white font-semibold text-xs hover:opacity-90 disabled:opacity-50 transition-all flex items-center gap-2 shadow-lg shadow-brand/10 w-full justify-center"
              >
                {isScraping ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {isScraping ? 'Scraping and Parsing...' : 'Run Contact Parser Scrape'}
              </button>
            </div>
          </div>
        </div>

        {/* Right Panel: Live Scraping Status / Errors */}
        <div className="w-full lg:w-[450px] glass-card rounded-2xl p-6 flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <TerminalIcon className="h-5 w-5 text-teal" />
            <h2 className="text-lg font-semibold m-0 text-white">Scraper Status</h2>
          </div>

          <div className="flex-1 flex flex-col gap-4 justify-center items-center min-h-[200px] border border-white/5 rounded-xl bg-[#11151f]/20 p-6 text-center">
            {isScraping ? (
              <div className="flex flex-col items-center gap-3">
                <RefreshCw className="h-10 w-10 text-teal animate-spin" />
                <p className="text-sm font-medium text-teal">Crawling & Extracting Contacts...</p>
                <p className="text-xs text-muted">Spinning up Goroutines to parse HTML tokens</p>
              </div>
            ) : errorMsg ? (
              <div className="flex flex-col items-center gap-3">
                <AlertCircle className="h-10 w-10 text-red-500" />
                <p className="text-sm font-medium text-red-400">Scrape failed</p>
                <p className="text-xs text-muted max-w-[300px] break-words">{errorMsg}</p>
              </div>
            ) : results ? (
              <div className="flex flex-col items-center gap-2">
                <div className="h-12 w-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-1">
                  <Check className="h-6 w-6 text-emerald-400" />
                </div>
                <p className="text-sm font-bold text-emerald-400">Execution Successful</p>
                <div className="grid grid-cols-2 gap-4 mt-3 bg-black/20 p-3 rounded-lg border border-white/5 text-left w-full text-xs">
                  <div>
                    <span className="text-muted">Pages Scraped:</span>
                    <p className="font-bold text-white text-sm">{results.pagesCrawled}</p>
                  </div>
                  <div>
                    <span className="text-muted">Emails Found:</span>
                    <p className="font-bold text-white text-sm">{results.emails.length}</p>
                  </div>
                  <div>
                    <span className="text-muted">Phones Found:</span>
                    <p className="font-bold text-white text-sm">{results.phones.length}</p>
                  </div>
                  <div>
                    <span className="text-muted">Socials Found:</span>
                    <p className="font-bold text-white text-sm">{Object.keys(results.socials).length}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <Globe className="h-10 w-10 text-muted mx-auto mb-2" />
                <p className="text-sm text-muted">Ready to crawl target site</p>
                <p className="text-xs text-muted max-w-[280px] mt-1 mx-auto">
                  Provide a valid URL and click run to extract emails, phones, and social links.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Results View Panel */}
      {results && (
        <div className="glass-card rounded-2xl p-6 flex flex-col gap-6 w-full animate-in duration-300">
          <div className="flex justify-between items-center pb-4 border-b border-white/5">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Share2 className="h-5 w-5 text-brand" />
              Scraped Contacts for {results.targetUrl}
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Emails Section */}
            <div className="p-4 rounded-xl border border-white/5 bg-[#11151f]/30 flex flex-col gap-3">
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-brand" />
                  <h3 className="text-sm font-bold text-white">Personal / Corporate Emails</h3>
                </div>
                <span className="text-[10px] bg-brand/10 text-brand py-0.5 px-2 rounded-full font-bold">
                  {results.emails.length}
                </span>
              </div>
              <div className="max-h-[220px] overflow-y-auto flex flex-col gap-1.5 pr-1 text-sm scrollbar-thin">
                {results.emails.length === 0 ? (
                  <span className="text-xs text-muted py-2">No unique/non-generic emails found.</span>
                ) : (
                  results.emails.map((email, idx) => (
                    <div key={idx} className="flex justify-between items-center p-2 bg-black/20 rounded border border-white/5 hover:border-white/10 transition-all font-mono text-xs">
                      <span className="truncate mr-2 text-white">{email}</span>
                      <button 
                        onClick={() => handleCopy(email)} 
                        className="p-1 text-muted hover:text-white hover:bg-white/5 rounded transition-all"
                        title="Copy Email"
                      >
                        {copiedText === email ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Phone Numbers Section */}
            <div className="p-4 rounded-xl border border-white/5 bg-[#11151f]/30 flex flex-col gap-3">
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-teal" />
                  <h3 className="text-sm font-bold text-white">Phone Numbers</h3>
                </div>
                <span className="text-[10px] bg-teal/10 text-teal py-0.5 px-2 rounded-full font-bold">
                  {results.phones.length}
                </span>
              </div>
              <div className="max-h-[220px] overflow-y-auto flex flex-col gap-1.5 pr-1 text-sm scrollbar-thin">
                {results.phones.length === 0 ? (
                  <span className="text-xs text-muted py-2">No phone numbers discovered.</span>
                ) : (
                  results.phones.map((phone, idx) => (
                    <div key={idx} className="flex justify-between items-center p-2 bg-black/20 rounded border border-white/5 hover:border-white/10 transition-all font-mono text-xs">
                      <span className="truncate mr-2 text-white">{phone}</span>
                      <button 
                        onClick={() => handleCopy(phone)} 
                        className="p-1 text-muted hover:text-white hover:bg-white/5 rounded transition-all"
                        title="Copy Phone"
                      >
                        {copiedText === phone ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Social Links Section */}
            <div className="p-4 rounded-xl border border-white/5 bg-[#11151f]/30 flex flex-col gap-3">
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <Share2 className="h-4 w-4 text-brand" />
                  <h3 className="text-sm font-bold text-white">Social Media Networks</h3>
                </div>
                <span className="text-[10px] bg-brand/10 text-brand py-0.5 px-2 rounded-full font-bold">
                  {Object.keys(results.socials).length}
                </span>
              </div>
              <div className="max-h-[220px] overflow-y-auto flex flex-col gap-2 pr-1 scrollbar-thin">
                {Object.keys(results.socials).length === 0 ? (
                  <span className="text-xs text-muted py-2">No social networks found on the site.</span>
                ) : (
                  Object.entries(results.socials).map(([net, url], idx) => (
                    <a
                      key={idx}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between p-2.5 bg-black/20 rounded border border-white/5 hover:bg-white/5 hover:border-white/10 transition-all text-xs font-medium text-white"
                    >
                      <span className="capitalize text-teal">{net}</span>
                      <span className="text-muted hover:text-white truncate max-w-[200px] select-none text-[10px] border border-white/10 rounded px-1.5 py-0.5 bg-[#11151f]">
                        View Profile
                      </span>
                    </a>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Internal Links Expanded Section */}
          <div className="mt-2 border-t border-white/5 pt-4">
            <details className="group">
              <summary className="list-none flex items-center justify-between font-bold text-xs uppercase tracking-wider text-muted cursor-pointer hover:text-white transition-all select-none">
                <span className="flex items-center gap-2">
                  <LinkIcon className="h-3.5 w-3.5" />
                  Show Crawled Internal URLs ({results.internalLinks.length})
                </span>
                <span className="text-[10px] text-muted group-open:rotate-180 transition-transform duration-200">▼</span>
              </summary>
              <div className="mt-4 p-4 rounded-xl border border-white/5 bg-[#11151f]/40 max-h-[300px] overflow-y-auto flex flex-col gap-1.5 font-mono text-xs text-muted scrollbar-thin">
                {results.internalLinks.length === 0 ? (
                  <span>No internal URLs found.</span>
                ) : (
                  results.internalLinks.map((link, idx) => (
                    <a 
                      key={idx} 
                      href={link} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="hover:text-brand hover:underline truncate py-0.5"
                    >
                      {link}
                    </a>
                  ))
                )}
              </div>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
