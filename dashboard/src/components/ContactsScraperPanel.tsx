import React, { useState, useEffect } from 'react';
import { api, ScrapedJobItem, AutomatedJobsResponse, ReceivedEmail } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

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

  return (
    <div className="space-y-6 text-sm">
      {/* Premium Tabs */}
      <div className="flex border-b border-white/[0.08] gap-6">
        <button
          onClick={() => setActiveTab('crawler')}
          className={`pb-3 text-sm font-bold uppercase tracking-wider transition-all border-b-2 ${
            activeTab === 'crawler'
              ? 'border-[#0061FF] text-white'
              : 'border-transparent text-white/40 hover:text-white/70'
          }`}
        >
          📇 Single URL Crawler
        </button>
        <button
          onClick={() => setActiveTab('jobs')}
          className={`pb-3 text-sm font-bold uppercase tracking-wider transition-all border-b-2 ${
            activeTab === 'jobs'
              ? 'border-[#0061FF] text-white'
              : 'border-transparent text-white/40 hover:text-white/70'
          }`}
        >
          🤖 Auto Jobs database
        </button>
        <button
          onClick={() => setActiveTab('emails')}
          className={`pb-3 text-sm font-bold uppercase tracking-wider transition-all border-b-2 ${
            activeTab === 'emails'
              ? 'border-[#0061FF] text-white'
              : 'border-transparent text-white/40 hover:text-white/70'
          }`}
        >
          📬 Inbox (Received)
        </button>
      </div>

      {activeTab === 'crawler' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Scraper controls */}
            <Card className="glass rounded-3xl lg:col-span-1 border border-white/[0.08] p-6 h-fit">
              <CardHeader className="p-0 mb-5">
                <CardTitle className="text-white font-bold text-base">Contact Crawler</CardTitle>
                <CardDescription className="text-white/40 text-xs mt-1">
                  Deep crawl any domain to scrape emails, phone numbers, and social media handles.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <form onSubmit={handleCrawlerSubmit} className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[11px] uppercase font-black tracking-wider text-white/40">Target URL</label>
                    <Input
                      type="url"
                      value={targetUrl}
                      onChange={e => setTargetUrl(e.target.value)}
                      required
                      placeholder="https://example.com"
                      className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl px-4 py-2.5 text-xs text-white"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] uppercase font-black tracking-wider text-white/40">Max Pages</label>
                    <Input
                      type="number"
                      value={maxPages}
                      onChange={e => setMaxPages(Number(e.target.value))}
                      min={1}
                      max={200}
                      className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl px-4 py-2.5 text-xs text-white"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] uppercase font-black tracking-wider text-white/40">Parallel Workers</label>
                    <Input
                      type="number"
                      value={workers}
                      onChange={e => setWorkers(Number(e.target.value))}
                      min={1}
                      max={30}
                      className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl px-4 py-2.5 text-xs text-white"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] uppercase font-black tracking-wider text-white/40">Timeout (Duration)</label>
                    <Input
                      type="text"
                      value={timeout}
                      onChange={e => setTimeoutVal(e.target.value)}
                      placeholder="e.g. 30s, 1m"
                      className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl px-4 py-2.5 text-xs text-white"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={crawlerLoading}
                    className="w-full mt-2 py-3 bg-gradient-to-r from-[#0061FF] to-[#00D4FF] hover:opacity-90 disabled:opacity-40 text-white text-xs font-bold rounded-xl transition-all shadow-lg flex items-center justify-center gap-2"
                  >
                    {crawlerLoading ? (
                      <>
                        <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                        Crawling Domain...
                      </>
                    ) : (
                      '🔍 Start Crawling'
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* Results visualization */}
            <div className="lg:col-span-2 space-y-6">
              {crawlerError && (
                <div className="px-4 py-3 bg-rose-500/10 border border-rose-500/25 rounded-xl text-rose-400 text-xs font-medium">
                  ⚠️ {crawlerError}
                </div>
              )}

              {crawlerLoading && (
                <Card className="glass rounded-3xl border border-white/[0.08] p-12 flex flex-col items-center justify-center text-center space-y-4">
                  <div className="w-10 h-10 border-4 border-t-[#0061FF] border-white/15 rounded-full animate-spin" />
                  <div>
                    <h3 className="font-bold text-white text-sm">Crawl in Progress</h3>
                    <p className="text-white/40 text-[11px] mt-1 max-w-sm">
                      Crawling sitemaps and pages, parsing anchor tags and text bodies to extract contact coordinates...
                    </p>
                  </div>
                </Card>
              )}

              {!crawlerLoading && !crawlerResult && !crawlerError && (
                <Card className="glass rounded-3xl border border-white/[0.08] p-12 flex flex-col items-center justify-center text-center">
                  <div className="w-16 h-16 rounded-2xl bg-white/[0.02] border border-white/[0.05] flex items-center justify-center text-2xl mb-4 text-white/30">
                    🕸️
                  </div>
                  <h3 className="font-bold text-white text-sm">No Active Crawl</h3>
                  <p className="text-white/40 text-[11px] mt-1 max-w-sm">
                    Enter a target URL on the left panel to crawl its pages and extract contact numbers, emails, and social profiles.
                  </p>
                </Card>
              )}

              {crawlerResult && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  {/* Overview Stats */}
                  <Card className="glass rounded-3xl border border-white/[0.08] p-6 grid grid-cols-3 gap-4">
                    <div className="text-center p-3 bg-white/[0.01] rounded-xl border border-white/[0.03]">
                      <span className="text-[10px] uppercase font-bold text-white/30 tracking-wider">Pages Crawled</span>
                      <p className="text-xl font-bold text-white mt-1">{crawlerResult.pagesCrawled}</p>
                    </div>
                    <div className="text-center p-3 bg-white/[0.01] rounded-xl border border-white/[0.03]">
                      <span className="text-[10px] uppercase font-bold text-white/30 tracking-wider">Emails Found</span>
                      <p className="text-xl font-bold text-teal-400 mt-1">{crawlerResult.emails.length}</p>
                    </div>
                    <div className="text-center p-3 bg-white/[0.01] rounded-xl border border-white/[0.03]">
                      <span className="text-[10px] uppercase font-bold text-white/30 tracking-wider">Phones Found</span>
                      <p className="text-xl font-bold text-cyan-400 mt-1">{crawlerResult.phones.length}</p>
                    </div>
                  </Card>

                  {/* Emails & Phones lists */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Emails card */}
                    <Card className="glass rounded-3xl border border-white/[0.08] p-6">
                      <CardTitle className="text-white font-bold text-sm mb-4 flex items-center gap-2">
                        ✉️ Emails
                      </CardTitle>
                      {crawlerResult.emails.length === 0 ? (
                        <p className="text-xs text-white/30 italic">No email addresses discovered.</p>
                      ) : (
                        <div className="space-y-2 max-h-[250px] overflow-y-auto scrollbar-thin">
                          {crawlerResult.emails.map(email => (
                            <div key={email} className="px-3 py-2 bg-white/[0.02] border border-white/[0.05] rounded-lg text-xs font-mono text-white/70 select-all">
                              {email}
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>

                    {/* Phones card */}
                    <Card className="glass rounded-3xl border border-white/[0.08] p-6">
                      <CardTitle className="text-white font-bold text-sm mb-4 flex items-center gap-2">
                        📞 Phone Numbers
                      </CardTitle>
                      {crawlerResult.phones.length === 0 ? (
                        <p className="text-xs text-white/30 italic">No phone numbers discovered.</p>
                      ) : (
                        <div className="space-y-2 max-h-[250px] overflow-y-auto scrollbar-thin">
                          {crawlerResult.phones.map(phone => (
                            <div key={phone} className="px-3 py-2 bg-white/[0.02] border border-white/[0.05] rounded-lg text-xs font-mono text-white/70 select-all">
                              {phone}
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  </div>

                  {/* Social Handles */}
                  <Card className="glass rounded-3xl border border-white/[0.08] p-6">
                    <CardTitle className="text-white font-bold text-sm mb-4 flex items-center gap-2">
                      🔗 Social Media Handles
                    </CardTitle>
                    {Object.keys(crawlerResult.socials).length === 0 ? (
                      <p className="text-xs text-white/30 italic">No social media links discovered.</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {Object.entries(crawlerResult.socials).map(([platform, link]) => (
                          <a
                            key={platform}
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-between px-4 py-2.5 bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] rounded-xl text-xs font-medium text-white transition-colors"
                          >
                            <span className="capitalize text-[#00E5FF]">{platform}</span>
                            <span className="text-[10px] text-white/40 truncate max-w-[200px]">{link}</span>
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
        <div className="space-y-6">
          {/* Status summary */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Run statistics */}
            <Card className="glass rounded-3xl lg:col-span-2 border border-white/[0.08] p-6 grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="flex flex-col justify-center p-3 bg-white/[0.01] rounded-2xl border border-white/[0.04]">
                <span className="text-[9px] uppercase font-bold text-white/30 tracking-wider">Database Status</span>
                <Badge variant="outline" className={`w-fit mt-1 text-[10px] ${
                  jobsData?.status === 'scraping'
                    ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                    : jobsData?.status === 'completed'
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                    : 'bg-white/5 border-white/10 text-white/50'
                }`}>
                  {jobsData?.status || 'unknown'}
                </Badge>
              </div>

              <div className="flex flex-col justify-center p-3 bg-white/[0.01] rounded-2xl border border-white/[0.04]">
                <span className="text-[9px] uppercase font-bold text-white/30 tracking-wider">Total Stored Jobs</span>
                <p className="text-lg font-bold text-white mt-1">{jobsData?.stats?.totalJobs || 0}</p>
              </div>

              <div className="flex flex-col justify-center p-3 bg-white/[0.01] rounded-2xl border border-white/[0.04]">
                <span className="text-[9px] uppercase font-bold text-white/30 tracking-wider">Unique Companies</span>
                <p className="text-lg font-bold text-teal-400 mt-1">{jobsData?.stats?.companiesScraped || 0}</p>
              </div>

              <div className="flex flex-col justify-center p-3 bg-white/[0.01] rounded-2xl border border-white/[0.04]">
                <span className="text-[9px] uppercase font-bold text-white/30 tracking-wider">Last Run Added</span>
                <p className="text-lg font-bold text-cyan-400 mt-1">+{jobsData?.stats?.lastRunCount || 0}</p>
              </div>
            </Card>

            {/* Scraper triggering */}
            <Card className="glass rounded-3xl border border-white/[0.08] p-6 flex flex-col justify-between">
              <div className="p-0 space-y-4">
                <CardTitle className="text-white font-bold text-xs uppercase tracking-wider text-white/50">Manual Scraper Trigger</CardTitle>
                <form onSubmit={handleTriggerJobsScraper} className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[9px] uppercase font-bold text-white/30">Keywords (Comma separated)</label>
                    <Input
                      type="text"
                      value={customKeywords}
                      onChange={e => setCustomKeywords(e.target.value)}
                      className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-2 text-[11px] text-white"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] uppercase font-bold text-white/30">Location</label>
                    <Input
                      type="text"
                      value={customLocation}
                      onChange={e => setCustomLocation(e.target.value)}
                      className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-2 text-[11px] text-white"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={triggerLoading || jobsData?.status === 'scraping'}
                    className="w-full mt-1 py-2 bg-white/5 border border-white/10 hover:bg-white/10 text-white text-[11px] font-bold rounded-lg transition-all"
                  >
                    {triggerLoading ? 'Triggering...' : '🚀 Trigger Run Now'}
                  </Button>
                </form>
              </div>
            </Card>
          </div>

          {triggerStatus && (
            <div className="px-4 py-3 bg-teal-500/10 border border-teal-500/20 rounded-xl text-teal-400 text-xs font-medium">
              💡 {triggerStatus}
            </div>
          )}

          {/* Filters card */}
          <Card className="glass rounded-3xl border border-white/[0.08] p-4 flex flex-col sm:flex-row items-center gap-4">
            <div className="relative w-full sm:w-1/3">
              <span className="absolute inset-y-0 left-3 flex items-center text-white/35 text-xs">🔍</span>
              <Input
                type="text"
                placeholder="Search by title, company, or desc..."
                value={searchFilter}
                onChange={e => setSearchFilter(e.target.value)}
                className="w-full bg-white/[0.03] border border-white/[0.06] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl pl-8 py-2 text-xs text-white"
              />
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              <span className="text-xs text-white/50">Source:</span>
              <div className="flex bg-white/[0.02] border border-white/[0.06] rounded-lg p-0.5">
                {(['all', 'indeed', 'google'] as const).map(src => (
                  <button
                    key={src}
                    onClick={() => setSourceFilter(src)}
                    className={`px-3 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all ${
                      sourceFilter === src
                        ? 'bg-[#0061FF] text-white shadow'
                        : 'text-white/40 hover:text-white/70'
                    }`}
                  >
                    {src}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-white/60 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={hasContactsFilter}
                onChange={e => setHasContactsFilter(e.target.checked)}
                className="rounded bg-white/[0.03] border-white/15 text-[#0061FF] focus:ring-[#0061FF]"
              />
              Show only with extracted contacts
            </label>

            {jobsData?.lastRun && (
              <span className="text-[11px] text-white/30 font-mono sm:ml-auto">
                Last Run: {new Date(jobsData.lastRun).toLocaleString()}
              </span>
            )}
          </Card>

          {/* Jobs table list */}
          {jobsLoading && !jobsData && (
            <div className="flex items-center justify-center p-12 text-white/50">
              Loading automated jobs database...
            </div>
          )}

          {jobsError && (
            <div className="px-4 py-3 bg-rose-500/10 border border-rose-500/25 rounded-xl text-rose-400 text-xs font-medium">
              ⚠️ {jobsError}
            </div>
          )}

          {jobsData && filteredJobs.length === 0 && (
            <Card className="glass rounded-3xl border border-white/[0.08] p-12 text-center text-white/30">
              No jobs matching your filter parameters were discovered in the database.
            </Card>
          )}

          {filteredJobs.length > 0 && (
            <Card className="glass rounded-3xl overflow-hidden border border-white/[0.08]">
              <div className="divide-y divide-white/[0.06]">
                {filteredJobs.map((job, idx) => {
                  const hasContactInfo = 
                    job.contacts && (
                      job.contacts.emails.length > 0 ||
                      job.contacts.phones.length > 0 ||
                      Object.keys(job.contacts.socials).length > 0
                    );

                  return (
                    <div key={job.jk} className="p-6 hover:bg-white/[0.01] transition-colors space-y-4">
                      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                        {/* Title, Company and Source */}
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-bold text-white text-sm hover:text-teal-400 transition-colors">
                              {idx + 1}. {job.title}
                            </h3>
                            <Badge variant="outline" className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                              job.source === 'indeed'
                                ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                                : 'bg-[#E3VR9e]/10 border-cyan-500/20 text-cyan-400'
                            }`}>
                              {job.source}
                            </Badge>
                          </div>
                          <div className="text-white/50 text-xs font-medium">
                            {job.company} — <span className="text-white/35 font-normal">{job.location}</span>
                            {job.companyWebsite && (
                              <a
                                href={job.companyWebsite}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-2.5 text-[#00E5FF] hover:underline"
                              >
                                {job.companyWebsite.replace(/^https?:\/\/(www\.)?/i, '')} ↗
                              </a>
                            )}
                          </div>
                        </div>

                        {/* CTA button or actions */}
                        <div className="flex items-center gap-2 self-start lg:self-center">
                          {job.salary && (
                            <Badge variant="outline" className="bg-teal-500/10 border-teal-500/20 text-teal-400 text-[10px] font-semibold">
                              {job.salary}
                            </Badge>
                          )}
                          <a
                            href={job.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white text-[11px] font-semibold transition-all"
                          >
                            View Job Listing ↗
                          </a>
                        </div>
                      </div>

                      {/* Job snippet / description preview */}
                      <p className="text-xs text-white/60 leading-relaxed pl-4 border-l-2 border-white/10 bg-white/[0.01] py-1 max-w-4xl">
                        {job.snippet}
                      </p>

                      {/* Collapsible description */}
                      <div>
                        <button
                          onClick={() => toggleJobExpand(job.jk)}
                          className="text-[11px] font-bold text-teal-400 hover:text-teal-300 transition-all"
                        >
                          {expandedJobJks[job.jk] ? '🔼 Hide Details' : '🔽 Show Details'}
                        </button>
                        {expandedJobJks[job.jk] && (
                          <div className="mt-3 bg-black/45 border border-white/[0.06] rounded-xl p-4 text-xs text-white/70 leading-relaxed font-mono whitespace-pre-wrap select-text max-h-[300px] overflow-y-auto scrollbar-thin">
                            {job.description || 'No description found.'}
                          </div>
                        )}
                      </div>

                      {/* Extracted Contact details */}
                      {hasContactInfo ? (
                        <div className="bg-white/[0.01] border border-white/[0.04] rounded-2xl p-4 space-y-3">
                          <h4 className="text-[10px] font-black uppercase tracking-wider text-teal-400/80">Extracted Contacts</h4>
                          
                          {/* Emails */}
                          {job.contacts!.emails.length > 0 && (
                            <div className="flex items-start gap-2 text-xs flex-wrap">
                              <span className="text-white/40 font-medium">Emails:</span>
                              {job.contacts!.emails.map(email => (
                                <Badge key={email} variant="outline" className="font-mono bg-white/[0.02] border-white/[0.08] text-white/80 select-all rounded-md px-2 py-0.5">
                                  {email}
                                </Badge>
                              ))}
                            </div>
                          )}

                          {/* Phones */}
                          {job.contacts!.phones.length > 0 && (
                            <div className="flex items-start gap-2 text-xs flex-wrap">
                              <span className="text-white/40 font-medium">Phones:</span>
                              {job.contacts!.phones.map(phone => (
                                <Badge key={phone} variant="outline" className="font-mono bg-white/[0.02] border-white/[0.08] text-white/80 select-all rounded-md px-2 py-0.5">
                                  {phone}
                                </Badge>
                              ))}
                            </div>
                          )}

                          {/* Socials */}
                          {Object.keys(job.contacts!.socials).length > 0 && (
                            <div className="flex items-start gap-2 text-xs flex-wrap">
                              <span className="text-white/40 font-medium">Social Links:</span>
                              {Object.entries(job.contacts!.socials).map(([plat, url]) => (
                                <a
                                  key={plat}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[#00E5FF] hover:underline bg-[#00E5FF]/5 border border-[#00E5FF]/10 rounded-md px-2 py-0.5 capitalize text-[10px] font-semibold"
                                >
                                  {plat}
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-[11px] text-white/30 italic pl-1">
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
        <div className="space-y-6">
          {/* Header Controls */}
          <Card className="glass rounded-3xl border border-white/[0.08] p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="relative w-full sm:w-1/3">
              <span className="absolute inset-y-0 left-3 flex items-center text-white/35 text-xs">🔍</span>
              <Input
                type="text"
                placeholder="Search by sender or subject..."
                value={emailSearchFilter}
                onChange={e => setEmailSearchFilter(e.target.value)}
                className="w-full bg-white/[0.03] border border-white/[0.06] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl pl-8 py-2 text-xs text-white"
              />
            </div>
            
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-white/30 font-mono">
                Total Received: {emailsData.length}
              </span>
              <Button
                onClick={fetchEmailsData}
                disabled={emailsLoading}
                className="py-1.5 px-3 bg-white/5 border border-white/10 hover:bg-white/10 text-white text-[11px] font-bold rounded-lg transition-all flex items-center gap-1.5"
              >
                {emailsLoading ? '🔄 Refreshing...' : '🔄 Refresh Inbox'}
              </Button>
            </div>
          </Card>

          {/* Loading and Error States */}
          {emailsLoading && emailsData.length === 0 && (
            <div className="flex items-center justify-center p-12 text-white/50">
              Loading received emails from R2 inbox...
            </div>
          )}

          {emailsError && (
            <div className="px-4 py-3 bg-rose-500/10 border border-rose-500/25 rounded-xl text-rose-400 text-xs font-medium">
              ⚠️ {emailsError}
            </div>
          )}

          {emailsData.length === 0 && !emailsLoading && (
            <Card className="glass rounded-3xl border border-white/[0.08] p-12 text-center text-white/30 space-y-2">
              <div className="text-3xl">📬</div>
              <p className="font-semibold text-white/70">Your inbox is empty.</p>
              <p className="text-xs text-white/40 max-w-md mx-auto">
                Incoming emails sent to contact@talhacodes.site will appear here once they are received and forwarded by Brevo's Inbound Parsing Webhook.
              </p>
            </Card>
          )}

          {/* Emails list */}
          {emailsData.length > 0 && (
            <Card className="glass rounded-3xl overflow-hidden border border-white/[0.08]">
              <div className="divide-y divide-white/[0.06]">
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
                      <div key={email.id} className="p-6 hover:bg-white/[0.01] transition-colors space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          {/* Sender details and subject */}
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-bold text-white text-sm hover:text-teal-400 transition-colors">
                                {idx + 1}. {email.subject}
                              </h3>
                            </div>
                            <div className="text-white/50 text-xs font-medium">
                              From: <span className="text-teal-400">{senderName}</span> &lt;{email.from.address}&gt;
                              {email.to && email.to.length > 0 && (
                                <span className="text-white/25"> to {email.to.join(', ')}</span>
                              )}
                            </div>
                          </div>

                          {/* Timestamp and action */}
                          <div className="flex items-center gap-3 self-start sm:self-center">
                            <span className="text-[11px] text-white/30 font-mono">
                              {formattedDate}
                            </span>
                            <button
                              onClick={() => setExpandedEmailIds(prev => ({ ...prev, [email.id]: !isExpanded }))}
                              className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white text-[11px] font-semibold transition-all"
                            >
                              {isExpanded ? '🔼 Hide Body' : '🔽 Read Email'}
                            </button>
                          </div>
                        </div>

                        {/* Email Body Content */}
                        {isExpanded && (
                          <div className="mt-3 bg-black/45 border border-white/[0.06] rounded-xl p-5 text-xs text-white/70 leading-relaxed font-sans max-h-[500px] overflow-y-auto scrollbar-thin select-text">
                            {email.bodyHtml ? (
                              <div className="rounded-lg overflow-hidden border border-white/[0.08] bg-white">
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
                              <pre className="whitespace-pre-wrap font-sans text-xs bg-black/20 p-4 rounded-lg select-text border border-white/[0.02]">
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
