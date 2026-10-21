import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Rocket, Download, ExternalLink, ChevronDown, ChevronRight, AlertCircle, Info } from 'lucide-react';

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
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Scrape Control Card */}
        <Card className="md:col-span-2 p-4 gap-4">
          <CardHeader className="p-0">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Indeed job scraper</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">
              Extract job postings concurrently across active remote browser runners.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <form onSubmit={handleScrape} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Job title</label>
                  <Input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    required
                    placeholder="e.g. software engineer"
                    className="w-full"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Location</label>
                  <Input
                    type="text"
                    value={location}
                    onChange={e => setLocation(e.target.value)}
                    placeholder="e.g. Rawalpindi"
                    className="w-full"
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Pages</span>
                  <div className="flex items-center gap-0.5 rounded-md bg-secondary/40 border border-border p-0.5">
                    {[1, 2, 3, 4, 5].map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPages(p)}
                        className={`size-6 rounded flex items-center justify-center text-xs font-medium transition-colors ${
                          pages === p
                            ? 'bg-primary/10 text-primary'
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
                  className="w-full sm:w-auto"
                >
                  <Rocket />
                  {loading ? 'Scraping jobs...' : 'Start scrape'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Worker Pool Status Card */}
        <Card className="p-4 flex flex-col justify-between">
          <div className="space-y-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Scraper nodes</CardTitle>
            <div className="flex items-center justify-between bg-secondary/40 border border-border rounded-md p-3">
              <span className="text-xs text-muted-foreground">Available nodes</span>
              <Badge variant={workersCount > 0 ? 'default' : 'outline'}>
                {workersCount} online
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {workersCount > 0
                ? 'Tasks divided across active nodes (1 page concurrent per worker).'
                : 'Start a browser runner in the Browser pool tab.'}
            </p>
          </div>
        </Card>
      </div>

      {statusMsg && !error && (
        <div className="flex items-start gap-2 p-3 bg-secondary/40 border border-border rounded-md text-foreground text-xs">
          <Info className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
          {statusMsg}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-xs">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Jobs Results List */}
      {jobs.length > 0 && (
        <Card className="gap-0 py-0 overflow-hidden">
          <CardHeader className="border-b border-border bg-secondary/40 px-4 py-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Scraped jobs ({jobs.length})</CardTitle>
            </div>
            <Button
              onClick={handleDownloadJson}
              variant="outline"
              size="xs"
              className="text-xs"
            >
              <Download />
              Export JSON
            </Button>
          </CardHeader>
          <div className="divide-y divide-border">
            {jobs.map((job, idx) => (
              <div key={job.jk} className="p-4 hover:bg-secondary/50 transition-colors space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-foreground text-sm tracking-tight">
                      {idx + 1}. {job.title}
                    </h3>
                    <p className="text-muted-foreground text-xs mt-0.5">
                      {job.company} — <span>{job.location}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {job.salary && (
                      <Badge variant="secondary">
                        {job.salary}
                      </Badge>
                    )}
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-border text-foreground text-xs font-medium hover:bg-secondary hover:border-primary/50 transition-colors"
                    >
                      View on Indeed
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed pl-3 border-l-2 border-border py-0.5">
                  {job.snippet}
                </p>

                <div className="pt-1">
                  <button
                    onClick={() => toggleExpand(job.jk)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    {expandedJks[job.jk] ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    {expandedJks[job.jk] ? 'Hide full description' : 'Show full description'}
                  </button>

                  {expandedJks[job.jk] && (
                    <div className="mt-2 bg-background border border-border rounded-md p-3 text-xs text-foreground leading-relaxed whitespace-pre-wrap max-h-[260px] overflow-y-auto">
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
