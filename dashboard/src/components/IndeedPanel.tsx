import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface JobResult {
  jk: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  snippet: string;
  url: string;
  description?: string;
}

export default function IndeedPanel() {
  const [query, setQuery] = useState('software engineer');
  const [location, setLocation] = useState('Rawalpindi');
  const [pages, setPages] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobResult[]>([]);
  const [expandedJks, setExpandedJks] = useState<Record<string, boolean>>({});
  const [workersCount, setWorkersCount] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');

  const checkWorkers = async () => {
    try {
      const res = await api.getBrowserPool();
      const count = res.browsers.filter(b => b.apiUrl && b.status === 'active').length;
      setWorkersCount(count);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    checkWorkers();
    const interval = setInterval(checkWorkers, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (workersCount === 0) {
      setError('Cannot start scrape: No active workers with API support registered.');
      return;
    }

    setLoading(true);
    setError(null);
    setStatusMsg('Distributing page tasks across active workers...');
    try {
      const res = await api.indeedSearch(query, location, pages);
      if (res.success) {
        setJobs(res.jobs);
        setStatusMsg(`Successfully scraped ${res.jobsCount} jobs!`);
      } else {
        throw new Error('Scraping did not return success.');
      }
    } catch (err: any) {
      setError(err.message || 'Scrape failed.');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (jk: string) => {
    setExpandedJks(prev => ({
      ...prev,
      [jk]: !prev[jk]
    }));
  };

  const handleDownloadJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(jobs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `indeed_jobs_${query.replace(/\s+/g, '_')}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="space-y-4 text-sm font-mono">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Scrape Control Card */}
        <Card className="md:col-span-2 border border-border bg-card p-4 space-y-4">
          <CardHeader className="p-0">
            <CardTitle className="text-xs uppercase font-bold tracking-wider text-foreground">Distributed Indeed Job Scraper</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">
              Extract job postings concurrently across active remote browser runners.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <form onSubmit={handleScrape} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Job Title</label>
                  <Input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    required
                    placeholder="e.g. software engineer"
                    className="w-full text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Location</label>
                  <Input
                    type="text"
                    value={location}
                    onChange={e => setLocation(e.target.value)}
                    placeholder="e.g. Rawalpindi"
                    className="w-full text-xs"
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground uppercase font-bold">Pages:</span>
                  <div className="flex items-center gap-1 bg-secondary border border-border p-0.5">
                    {[1, 2, 3, 4, 5].map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPages(p)}
                        className={`w-6 h-6 flex items-center justify-center text-xs font-mono font-bold uppercase transition-all ${
                          pages === p
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={loading || workersCount === 0}
                  className="w-full sm:w-auto font-mono text-xs uppercase"
                >
                  {loading ? 'SCRAPING JOBS...' : '🚀 START SCRAPE'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Worker Pool Status Card */}
        <Card className="border border-border bg-card p-4 flex flex-col justify-between">
          <div className="space-y-3">
            <CardTitle className="text-xs uppercase font-bold tracking-wider text-foreground">Scraper Node Status</CardTitle>
            <div className="flex items-center justify-between bg-secondary border border-border p-3">
              <span className="text-xs text-muted-foreground uppercase font-bold">Available Nodes</span>
              <Badge
                variant="outline"
                className="text-[10px]"
              >
                {workersCount} ONLINE
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              {workersCount > 0
                ? 'Tasks divided across active nodes (1 page concurrent per worker).'
                : 'Start a browser runner in the Browser Pool tab.'}
            </p>
          </div>
        </Card>
      </div>

      {statusMsg && !error && (
        <div className="p-3 bg-secondary border border-border text-foreground text-xs font-mono">
          [INFO] {statusMsg}
        </div>
      )}

      {error && (
        <div className="p-3 bg-secondary border border-border text-foreground text-xs font-mono">
          [ERROR] {error}
        </div>
      )}

      {/* Jobs Results List */}
      {jobs.length > 0 && (
        <Card className="border border-border bg-card overflow-hidden">
          <CardHeader className="border-b border-border bg-secondary px-4 py-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-xs uppercase font-bold tracking-wider text-foreground">Scraped Jobs ({jobs.length})</CardTitle>
            </div>
            <Button
              onClick={handleDownloadJson}
              variant="outline"
              size="xs"
              className="font-mono text-xs uppercase"
            >
              📥 EXPORT JSON
            </Button>
          </CardHeader>
          <div className="divide-y divide-border">
            {jobs.map((job, idx) => (
              <div key={job.jk} className="p-4 hover:bg-secondary transition-colors space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-foreground text-xs uppercase tracking-wider">
                      {idx + 1}. {job.title}
                    </h3>
                    <p className="text-muted-foreground text-xs mt-0.5">
                      {job.company} — <span>{job.location}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {job.salary && (
                      <Badge variant="outline" className="text-[10px]">
                        💰 {job.salary}
                      </Badge>
                    )}
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-1 border border-border bg-secondary hover:bg-foreground hover:text-background text-foreground text-[10px] uppercase font-bold"
                    >
                      VIEW ON INDEED ↗
                    </a>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed pl-3 border-l-2 border-border py-0.5">
                  {job.snippet}
                </p>

                <div className="pt-1">
                  <button
                    onClick={() => toggleExpand(job.jk)}
                    className="text-[10px] font-bold uppercase text-foreground hover:underline"
                  >
                    {expandedJks[job.jk] ? '[ - HIDE FULL DESCRIPTION ]' : '[ + SHOW FULL DESCRIPTION ]'}
                  </button>

                  {expandedJks[job.jk] && (
                    <div className="mt-2 bg-background border border-border p-3 text-xs text-foreground leading-relaxed font-mono whitespace-pre-wrap max-h-[260px] overflow-y-auto">
                      {job.description || 'No description found.'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
