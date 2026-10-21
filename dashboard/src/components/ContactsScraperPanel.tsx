import React, { useState, useEffect } from 'react';
import { api, ScrapedJobItem, AutomatedJobsResponse, ReceivedEmail } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search, Globe, Bot, Inbox, Mail, Phone, Link2, ChevronDown, ChevronUp, RefreshCw, Rocket, AlertTriangle, Info, ExternalLink, Loader2 } from 'lucide-react';

interface ContactsScrapeResult {
  targetUrl: string;
  emails: string[];
  phones: string[];
  socials: Record<string, string>;
  pagesCrawled: number;
  internalLinks: string[];
}

export default function ContactsScraperPanel() {
  const [activeTab, setActiveTab] = useState<'crawler' | 'jobs' | 'emails'>('crawler');

  // Single url scraper state
  const [targetUrl, setTargetUrl] = useState('');
  const [maxPages, setMaxPages] = useState(20);
  const [workers, setWorkers] = useState(5);
  const [timeout, setTimeoutVal] = useState('30s');
  const [crawlerLoading, setCrawlerLoading] = useState(false);
  const [crawlerError, setCrawlerError] = useState<string | null>(null);
  const [crawlerResult, setCrawlerResult] = useState<ContactsScrapeResult | null>(null);

  // Automated jobs state
  const [jobsData, setJobsData] = useState<AutomatedJobsResponse | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  
  // Custom manual trigger state
  const [customKeywords, setCustomKeywords] = useState('software engineer, web developer');
  const [customLocation, setCustomLocation] = useState('Pakistan');
  const [triggerLoading, setTriggerLoading] = useState(false);
  const [triggerStatus, setTriggerStatus] = useState<string | null>(null);
  
  // Filter state for jobs
  const [searchFilter, setSearchFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'indeed' | 'google'>('all');
  const [hasContactsFilter, setHasContactsFilter] = useState(false);
  const [expandedJobJks, setExpandedJobJks] = useState<Record<string, boolean>>({});

  // Inbound emails state
  const [emailsData, setEmailsData] = useState<ReceivedEmail[]>([]);
  const [emailsLoading, setEmailsLoading] = useState(false);
  const [emailsError, setEmailsError] = useState<string | null>(null);
  const [expandedEmailIds, setExpandedEmailIds] = useState<Record<string, boolean>>({});
  const [emailSearchFilter, setEmailSearchFilter] = useState('');

  const fetchJobsData = async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      const data = await api.getAutomatedJobs();
      setJobsData(data);
    } catch (err: any) {
      setJobsError(err.message || 'Failed to fetch automated jobs database.');
    } finally {
      setJobsLoading(false);
    }
  };

  const fetchEmailsData = async () => {
    setEmailsLoading(true);
    setEmailsError(null);
    try {
      const data = await api.getReceivedEmails();
      setEmailsData(data.emails || []);
    } catch (err: any) {
      setEmailsError(err.message || 'Failed to fetch received emails.');
    } finally {
      setEmailsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'jobs') {
      fetchJobsData();
    } else if (activeTab === 'emails') {
      fetchEmailsData();
    }
  }, [activeTab]);

  const handleCrawlerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUrl) return;

    setCrawlerLoading(true);
    setCrawlerError(null);
    setCrawlerResult(null);

    try {
      const res = await api.scrapeContacts(targetUrl, maxPages, workers, timeout);
      if (res.error) {
        throw new Error(res.error);
      }
      setCrawlerResult(res);
    } catch (err: any) {
      setCrawlerError(err.message || 'Scraping failed. Ensure contact scraper service is running on actions.');
    } finally {
      setCrawlerLoading(false);
    }
  };

  const handleTriggerJobsScraper = async (e: React.FormEvent) => {
    e.preventDefault();
    setTriggerLoading(true);
    setTriggerStatus(null);
    try {
      const keywordsArr = customKeywords.split(',').map(k => k.trim()).filter(Boolean);
      const res = await api.triggerJobsScraper(keywordsArr, customLocation);
      if (res.success) {
        setTriggerStatus('Job scraper successfully triggered in the background! Status will update shortly.');
        // Refresh status after 5 seconds
        setTimeout(fetchJobsData, 5000);
      } else {
        throw new Error(res.message);
      }
    } catch (err: any) {
      setTriggerStatus(`Failed to trigger scraper: ${err.message}`);
    } finally {
      setTriggerLoading(false);
    }
  };

  const toggleJobExpand = (jk: string) => {
    setExpandedJobJks(prev => ({ ...prev, [jk]: !prev[jk] }));
  };

  // Filter jobs
  const filteredJobs = jobsData?.jobs.filter(job => {
    const matchesSearch = 
      job.title.toLowerCase().includes(searchFilter.toLowerCase()) ||
      job.company.toLowerCase().includes(searchFilter.toLowerCase()) ||
      job.snippet.toLowerCase().includes(searchFilter.toLowerCase());
    
    const matchesSource = sourceFilter === 'all' || job.source === sourceFilter;
    
    const hasContacts = !hasContactsFilter || (
      job.contacts && (
        job.contacts.emails.length > 0 ||
        job.contacts.phones.length > 0 ||
        Object.keys(job.contacts.socials).length > 0
      )
    );

    return matchesSearch && matchesSource && hasContacts;
  }) || [];

  const errBox = 'flex items-start gap-2 px-3 py-2.5 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-xs font-medium';
  const labelCls = 'text-xs font-medium text-muted-foreground';
  const tabCls = (active: boolean) =>
    `inline-flex items-center gap-2 pb-2.5 text-[13px] font-medium transition-colors border-b-2 -mb-px ${
      active
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;
  const statCell = 'flex flex-col justify-center p-3 rounded-md border border-border bg-secondary/40';

  return (
    <div className="space-y-4 text-[13px]">
      {/* Tabs */}
      <div className="flex border-b border-border gap-6">
        <button onClick={() => setActiveTab('crawler')} className={tabCls(activeTab === 'crawler')}>
          <Globe className="size-4" /> Single URL crawler
        </button>
        <button onClick={() => setActiveTab('jobs')} className={tabCls(activeTab === 'jobs')}>
          <Bot className="size-4" /> Auto jobs database
        </button>
        <button onClick={() => setActiveTab('emails')} className={tabCls(activeTab === 'emails')}>
          <Inbox className="size-4" /> Inbox (received)
        </button>
      </div>

      {activeTab === 'crawler' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Scraper controls */}
            <Card className="lg:col-span-1 p-4 h-fit">
              <CardHeader className="p-0">
                <CardTitle>Contact crawler</CardTitle>
                <CardDescription>
                  Deep crawl any domain to scrape emails, phone numbers, and social media handles.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <form onSubmit={handleCrawlerSubmit} className="space-y-3">
                  <div className="space-y-1.5">
                    <label className={labelCls}>Target URL</label>
                    <Input
                      type="url"
                      value={targetUrl}
                      onChange={e => setTargetUrl(e.target.value)}
                      required
                      placeholder="https://example.com"
                      className="font-mono text-xs"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className={labelCls}>Max pages</label>
                    <Input
                      type="number"
                      value={maxPages}
                      onChange={e => setMaxPages(Number(e.target.value))}
                      min={1}
                      max={200}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className={labelCls}>Parallel workers</label>
                    <Input
                      type="number"
                      value={workers}
                      onChange={e => setWorkers(Number(e.target.value))}
                      min={1}
                      max={30}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className={labelCls}>Timeout (duration)</label>
                    <Input
                      type="text"
                      value={timeout}
                      onChange={e => setTimeoutVal(e.target.value)}
                      placeholder="e.g. 30s, 1m"
                      className="font-mono text-xs"
                    />
                  </div>

                  <Button type="submit" disabled={crawlerLoading} className="w-full mt-1">
                    {crawlerLoading ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Crawling domain...
                      </>
                    ) : (
                      <>
                        <Search className="size-4" />
                        Start crawling
                      </>
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* Results visualization */}
            <div className="lg:col-span-2 space-y-4">
              {crawlerError && (
                <div className={errBox}>
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>{crawlerError}</span>
                </div>
              )}

              {crawlerLoading && (
                <Card className="p-12 flex flex-col items-center justify-center text-center gap-3">
                  <Loader2 className="size-6 animate-spin text-primary" />
                  <div>
                    <h3 className="text-sm font-semibold tracking-tight text-foreground">Crawl in progress</h3>
                    <p className="text-muted-foreground text-xs mt-1 max-w-sm">
                      Crawling sitemaps and pages, parsing anchor tags and text bodies to extract contact coordinates...
                    </p>
                  </div>
                </Card>
              )}

              {!crawlerLoading && !crawlerResult && !crawlerError && (
                <Card className="p-12 flex flex-col items-center justify-center text-center gap-2">
                  <Globe className="size-6 text-muted-foreground" />
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">No active crawl</h3>
                  <p className="text-muted-foreground text-xs max-w-sm">
                    Enter a target URL on the left panel to crawl its pages and extract contact numbers, emails, and social profiles.
                  </p>
                </Card>
              )}

              {crawlerResult && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  {/* Overview Stats */}
                  <Card className="p-4 grid grid-cols-3 gap-3">
                    <div className={statCell}>
                      <span className={labelCls}>Pages crawled</span>
                      <p className="text-xl font-semibold text-foreground mt-1">{crawlerResult.pagesCrawled}</p>
                    </div>
                    <div className={statCell}>
                      <span className={labelCls}>Emails found</span>
                      <p className="text-xl font-semibold text-primary mt-1">{crawlerResult.emails.length}</p>
                    </div>
                    <div className={statCell}>
                      <span className={labelCls}>Phones found</span>
                      <p className="text-xl font-semibold text-primary mt-1">{crawlerResult.phones.length}</p>
                    </div>
                  </Card>

                  {/* Emails & Phones lists */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Card className="p-4">
                      <CardTitle className="flex items-center gap-2">
                        <Mail className="size-4 text-muted-foreground" /> Emails
                      </CardTitle>
                      {crawlerResult.emails.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No email addresses discovered.</p>
                      ) : (
                        <div className="space-y-2 max-h-[250px] overflow-y-auto scrollbar-thin">
                          {crawlerResult.emails.map(email => (
                            <div key={email} className="px-3 py-2 bg-secondary/40 border border-border rounded-md text-xs font-mono text-foreground select-all">
                              {email}
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>

                    <Card className="p-4">
                      <CardTitle className="flex items-center gap-2">
                        <Phone className="size-4 text-muted-foreground" /> Phone numbers
                      </CardTitle>
                      {crawlerResult.phones.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No phone numbers discovered.</p>
                      ) : (
                        <div className="space-y-2 max-h-[250px] overflow-y-auto scrollbar-thin">
                          {crawlerResult.phones.map(phone => (
                            <div key={phone} className="px-3 py-2 bg-secondary/40 border border-border rounded-md text-xs font-mono text-foreground select-all">
                              {phone}
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  </div>

                  {/* Social Handles */}
                  <Card className="p-4">
                    <CardTitle className="flex items-center gap-2">
                      <Link2 className="size-4 text-muted-foreground" /> Social media handles
                    </CardTitle>
                    {Object.keys(crawlerResult.socials).length === 0 ? (
                      <p className="text-xs text-muted-foreground">No social media links discovered.</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {Object.entries(crawlerResult.socials).map(([platform, link]) => (
                          <a
                            key={platform}
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-between gap-3 px-3 py-2.5 bg-secondary/40 border border-border hover:bg-secondary/70 rounded-md text-xs font-medium text-foreground transition-colors"
                          >
                            <span className="capitalize text-primary">{platform}</span>
                            <span className="text-[11px] font-mono text-muted-foreground truncate max-w-[200px]">{link}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'jobs' && (
        <div className="space-y-4">
          {/* Status summary */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Run statistics */}
            <Card className="lg:col-span-2 p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className={statCell}>
                <span className={labelCls}>Database status</span>
                <Badge variant="outline" className={`mt-1 ${
                  jobsData?.status === 'scraping'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
                    : jobsData?.status === 'completed'
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'bg-secondary border-border text-muted-foreground'
                }`}>
                  {jobsData?.status || 'unknown'}
                </Badge>
              </div>

              <div className={statCell}>
                <span className={labelCls}>Total stored jobs</span>
                <p className="text-lg font-semibold text-foreground mt-1">{jobsData?.stats?.totalJobs || 0}</p>
              </div>

              <div className={statCell}>
                <span className={labelCls}>Unique companies</span>
                <p className="text-lg font-semibold text-foreground mt-1">{jobsData?.stats?.companiesScraped || 0}</p>
              </div>

              <div className={statCell}>
                <span className={labelCls}>Last run added</span>
                <p className="text-lg font-semibold text-primary mt-1">+{jobsData?.stats?.lastRunCount || 0}</p>
              </div>
            </Card>

            {/* Scraper triggering */}
            <Card className="p-4 flex flex-col justify-between">
              <div className="space-y-3">
                <CardTitle>Manual scraper trigger</CardTitle>
                <form onSubmit={handleTriggerJobsScraper} className="space-y-3">
                  <div className="space-y-1.5">
                    <label className={labelCls}>Keywords (comma separated)</label>
                    <Input
                      type="text"
                      value={customKeywords}
                      onChange={e => setCustomKeywords(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelCls}>Location</label>
                    <Input
                      type="text"
                      value={customLocation}
                      onChange={e => setCustomLocation(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={triggerLoading || jobsData?.status === 'scraping'}
                    className="w-full"
                  >
                    {triggerLoading ? 'Triggering...' : (<><Rocket className="size-4" /> Trigger run now</>)}
                  </Button>
                </form>
              </div>
            </Card>
          </div>

          {triggerStatus && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-primary/10 border border-primary/30 rounded-md text-primary text-xs font-medium">
              <Info className="size-4 shrink-0" />
              <span>{triggerStatus}</span>
            </div>
          )}

          {/* Filters card */}
          <Card className="p-3 flex flex-col sm:flex-row items-center gap-4">
            <div className="relative w-full sm:w-1/3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search by title, company, or desc..."
                value={searchFilter}
                onChange={e => setSearchFilter(e.target.value)}
                className="pl-8 text-xs"
              />
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              <span className="text-xs text-muted-foreground">Source:</span>
              <div className="flex bg-secondary/40 border border-border rounded-md p-0.5">
                {(['all', 'indeed', 'google'] as const).map(src => (
                  <button
                    key={src}
                    onClick={() => setSourceFilter(src)}
                    className={`px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                      sourceFilter === src
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {src}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
              <input
                type="checkbox"
                checked={hasContactsFilter}
                onChange={e => setHasContactsFilter(e.target.checked)}
                className="rounded border-border accent-primary"
              />
              Show only with extracted contacts
            </label>

            {jobsData?.lastRun && (
              <span className="text-xs text-muted-foreground sm:ml-auto">
                Last run: {new Date(jobsData.lastRun).toLocaleString()}
              </span>
            )}
          </Card>

          {/* Jobs list */}
          {jobsLoading && !jobsData && (
            <div className="flex items-center justify-center p-12 text-muted-foreground text-xs">
              Loading automated jobs database...
            </div>
          )}

          {jobsError && (
            <div className={errBox}>
              <AlertTriangle className="size-4 shrink-0" />
              <span>{jobsError}</span>
            </div>
          )}

          {jobsData && filteredJobs.length === 0 && (
            <Card className="p-12 items-center text-center text-muted-foreground text-xs gap-2">
              <Search className="size-6" />
              No jobs matching your filter parameters were discovered in the database.
            </Card>
          )}

          {filteredJobs.length > 0 && (
            <Card className="overflow-hidden p-0 gap-0">
              <div className="divide-y divide-border">
                {filteredJobs.map((job, idx) => {
                  const hasContactInfo =
                    job.contacts && (
                      job.contacts.emails.length > 0 ||
                      job.contacts.phones.length > 0 ||
                      Object.keys(job.contacts.socials).length > 0
                    );

                  return (
                    <div key={job.jk} className="p-4 hover:bg-secondary/50 transition-colors space-y-3">
                      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                        {/* Title, Company and Source */}
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold tracking-tight text-foreground">
                              {idx + 1}. {job.title}
                            </h3>
                            <Badge variant="outline" className={job.source === 'indeed'
                              ? 'bg-secondary border-border text-foreground'
                              : 'bg-primary/10 border-primary/30 text-primary'
                            }>
                              {job.source}
                            </Badge>
                          </div>
                          <div className="text-muted-foreground text-xs">
                            <span className="text-foreground/80">{job.company}</span> — <span>{job.location}</span>
                            {job.companyWebsite && (
                              <a
                                href={job.companyWebsite}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-2.5 text-primary hover:underline inline-flex items-center gap-1"
                              >
                                {job.companyWebsite.replace(/^https?:\/\/(www\.)?/i, '')} <ExternalLink className="size-3" />
                              </a>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-start lg:self-center">
                          {job.salary && (
                            <Badge variant="outline" className="bg-primary/10 border-primary/30 text-primary">
                              {job.salary}
                            </Badge>
                          )}
                          <Button asChild variant="outline" size="sm">
                            <a href={job.url} target="_blank" rel="noopener noreferrer">
                              View job listing <ExternalLink className="size-3.5" />
                            </a>
                          </Button>
                        </div>
                      </div>

                      {/* Job snippet / description preview */}
                      <p className="text-xs text-muted-foreground leading-relaxed pl-3 border-l-2 border-border max-w-4xl">
                        {job.snippet}
                      </p>

                      {/* Collapsible description */}
                      <div>
                        <button
                          onClick={() => toggleJobExpand(job.jk)}
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          {expandedJobJks[job.jk]
                            ? (<><ChevronUp className="size-3.5" /> Hide details</>)
                            : (<><ChevronDown className="size-3.5" /> Show details</>)}
                        </button>
                        {expandedJobJks[job.jk] && (
                          <div className="mt-3 bg-secondary/40 border border-border rounded-md p-4 text-xs text-foreground/80 leading-relaxed font-mono whitespace-pre-wrap select-text max-h-[300px] overflow-y-auto scrollbar-thin">
                            {job.description || 'No description found.'}
                          </div>
                        )}
                      </div>

                      {/* Extracted Contact details */}
                      {hasContactInfo ? (
                        <div className="bg-secondary/40 border border-border rounded-md p-3 space-y-2.5">
                          <h4 className="text-xs font-medium text-muted-foreground">Extracted contacts</h4>

                          {job.contacts!.emails.length > 0 && (
                            <div className="flex items-start gap-2 text-xs flex-wrap">
                              <span className="text-muted-foreground font-medium">Emails:</span>
                              {job.contacts!.emails.map(email => (
                                <Badge key={email} variant="outline" className="font-mono text-foreground select-all">
                                  {email}
                                </Badge>
                              ))}
                            </div>
                          )}

                          {job.contacts!.phones.length > 0 && (
                            <div className="flex items-start gap-2 text-xs flex-wrap">
                              <span className="text-muted-foreground font-medium">Phones:</span>
                              {job.contacts!.phones.map(phone => (
                                <Badge key={phone} variant="outline" className="font-mono text-foreground select-all">
                                  {phone}
                                </Badge>
                              ))}
                            </div>
                          )}

                          {Object.keys(job.contacts!.socials).length > 0 && (
                            <div className="flex items-start gap-2 text-xs flex-wrap">
                              <span className="text-muted-foreground font-medium">Social links:</span>
                              {Object.entries(job.contacts!.socials).map(([plat, url]) => (
                                <a
                                  key={plat}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline bg-primary/10 border border-primary/30 rounded-full px-2 py-0.5 capitalize text-[11px] font-medium"
                                >
                                  {plat}
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          No direct contacts crawled yet for this company.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      )}

      {activeTab === 'emails' && (
        <div className="space-y-4">
          {/* Header Controls */}
          <Card className="p-3 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="relative w-full sm:w-1/3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search by sender or subject..."
                value={emailSearchFilter}
                onChange={e => setEmailSearchFilter(e.target.value)}
                className="pl-8 text-xs"
              />
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Total received: {emailsData.length}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchEmailsData}
                disabled={emailsLoading}
              >
                <RefreshCw className={`size-3.5 ${emailsLoading ? 'animate-spin' : ''}`} />
                {emailsLoading ? 'Refreshing...' : 'Refresh inbox'}
              </Button>
            </div>
          </Card>

          {emailsLoading && emailsData.length === 0 && (
            <div className="flex items-center justify-center p-12 text-muted-foreground text-xs">
              Loading received emails from R2 inbox...
            </div>
          )}

          {emailsError && (
            <div className={errBox}>
              <AlertTriangle className="size-4 shrink-0" />
              <span>{emailsError}</span>
            </div>
          )}

          {emailsData.length === 0 && !emailsLoading && (
            <Card className="p-12 items-center text-center gap-2">
              <Inbox className="size-6 text-muted-foreground" />
              <p className="text-sm font-semibold tracking-tight text-foreground">Your inbox is empty.</p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Incoming emails sent to contact@talhacodes.site will appear here once they are received and forwarded by Brevo's Inbound Parsing Webhook.
              </p>
            </Card>
          )}

          {/* Emails list */}
          {emailsData.length > 0 && (
            <Card className="overflow-hidden p-0 gap-0">
              <div className="divide-y divide-border">
                {emailsData
                  .filter(email => {
                    const term = emailSearchFilter.toLowerCase();
                    return (
                      email.subject.toLowerCase().includes(term) ||
                      email.from.address.toLowerCase().includes(term) ||
                      (email.from.name && email.from.name.toLowerCase().includes(term))
                    );
                  })
                  .map((email, idx) => {
                    const isExpanded = !!expandedEmailIds[email.id];
                    const senderName = email.from.name || email.from.address.split('@')[0];
                    const formattedDate = new Date(email.receivedAt).toLocaleString();

                    return (
                      <div key={email.id} className="p-4 hover:bg-secondary/50 transition-colors space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="space-y-1">
                            <h3 className="text-sm font-semibold tracking-tight text-foreground">
                              {idx + 1}. {email.subject}
                            </h3>
                            <div className="text-muted-foreground text-xs">
                              From: <span className="text-primary">{senderName}</span> &lt;{email.from.address}&gt;
                              {email.to && email.to.length > 0 && (
                                <span className="text-muted-foreground/70"> to {email.to.join(', ')}</span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 self-start sm:self-center">
                            <span className="text-xs text-muted-foreground">
                              {formattedDate}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setExpandedEmailIds(prev => ({ ...prev, [email.id]: !isExpanded }))}
                            >
                              {isExpanded
                                ? (<><ChevronUp className="size-3.5" /> Hide body</>)
                                : (<><ChevronDown className="size-3.5" /> Read email</>)}
                            </Button>
                          </div>
                        </div>

                        {/* Email Body Content */}
                        {isExpanded && (
                          <div className="mt-3 bg-secondary/40 border border-border rounded-md p-4 text-xs text-foreground/80 leading-relaxed font-sans max-h-[500px] overflow-y-auto scrollbar-thin select-text">
                            {email.bodyHtml ? (
                              <div className="rounded-md overflow-hidden border border-border bg-white">
                                <iframe
                                  title={`email-body-${email.id}`}
                                  srcDoc={`
                                    <!DOCTYPE html>
                                    <html>
                                      <head>
                                        <meta charset="utf-8">
                                        <style>
                                          body {
                                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                                            font-size: 14px;
                                            line-height: 1.5;
                                            color: #333333;
                                            background-color: #ffffff;
                                            margin: 15px;
                                          }
                                        </style>
                                      </head>
                                      <body>
                                        ${email.bodyHtml}
                                      </body>
                                    </html>
                                  `}
                                  className="w-full h-[350px] border-0"
                                  sandbox="allow-same-origin"
                                />
                              </div>
                            ) : (
                              <pre className="whitespace-pre-wrap font-sans text-xs bg-card p-4 rounded-md select-text border border-border">
                                {email.bodyText || '(Empty message body)'}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
