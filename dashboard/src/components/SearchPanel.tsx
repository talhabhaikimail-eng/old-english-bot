import React, { useState, useRef } from 'react';
import { api, BrowserSearchResult } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

type SearchEngine = 'auto' | 'worker' | 'cdp' | 'selenium' | 'cookie' | 'duckduckgo';

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BrowserSearchResult | null>(null);
  const [engine, setEngine] = useState<SearchEngine>('auto');
  const [usedEngine, setUsedEngine] = useState<string>('');
  const [includeAI, setIncludeAI] = useState(false);
  const aiRef = useRef<HTMLDivElement>(null);

  const handleSearch = async (e?: React.FormEvent, customPage?: number) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    const targetPage = customPage ?? page;

    try {
      const res = engine === 'cookie'
        ? await api.cookieSearch(query, targetPage)
        : engine === 'worker'
        ? await api.scrapeGoogle(query, targetPage, includeAI)
        : await api.browserSearch(query, targetPage, engine, includeAI);
      setResult(res);
      setPage(targetPage);
      setUsedEngine(engine);
    } catch (err: any) {
      setError(err.message || 'Failed to perform search');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 text-sm max-w-5xl mx-auto font-mono">
      <Card className="border border-border bg-card">
        <CardHeader className="flex flex-row justify-between items-start">
          <div>
            <CardTitle>Automated Browser Search</CardTitle>
            <CardDescription>
              Query Google via SeleniumBase UC worker, CDP instance, or Cookie session pool.
            </CardDescription>
          </div>
          <Button
            onClick={async () => {
              if (window.confirm('Restart all browser workers? Current searches will be interrupted.')) {
                try {
                  await api.restartBrowsers();
                  alert('Restart command sent to GitHub Actions!');
                } catch (e: any) {
                  alert('Error: ' + e.message);
                }
              }
            }}
            variant="outline"
            size="xs"
            className="font-mono text-xs uppercase"
          >
            🔄 RESTART WORKERS
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Engine selector */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground uppercase font-bold">Engine:</span>
            {(['auto', 'worker', 'cdp', 'selenium', 'cookie', 'duckduckgo'] as SearchEngine[]).map(eng => (
              <Button
                key={eng}
                onClick={() => setEngine(eng)}
                variant="outline"
                size="xs"
                className={`font-mono text-xs uppercase ${
                  engine === eng
                    ? 'bg-foreground text-background border-foreground font-bold'
                    : 'bg-secondary text-muted-foreground'
                }`}
              >
                {eng === 'auto' ? '⚡ Auto' : eng === 'worker' ? '🤖 Worker API' : eng === 'cdp' ? '🔌 CDP' : eng === 'selenium' ? '🐍 Selenium' : eng === 'cookie' ? '🍪 Cookie' : '🦆 DuckDuckGo'}
              </Button>
            ))}
          </div>

          {/* AI response toggle */}
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setIncludeAI(v => !v)}
              variant="outline"
              size="xs"
              className={`font-mono text-xs uppercase ${
                includeAI
                  ? 'bg-foreground text-background border-foreground font-bold'
                  : 'bg-secondary text-muted-foreground'
              }`}
            >
              <span>{includeAI ? '[X]' : '[ ]'}</span>
              <span>AI Overview Stream</span>
            </Button>
          </div>

          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2 pt-2">
            <Input
              type="text"
              className="flex-1"
              placeholder="Enter search query..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              type="submit"
              disabled={loading || !query.trim()}
              className="font-mono text-xs uppercase"
            >
              {loading ? 'SEARCHING...' : 'SEARCH GOOGLE'}
            </Button>
          </form>
          {error && <div className="p-3 bg-secondary border border-border text-foreground text-xs font-mono">[ERROR] {error}</div>}
        </CardContent>
      </Card>

      {loading && (
        <div className="flex justify-center p-8 text-xs font-mono text-muted-foreground">
          Fetching search results...
        </div>
      )}

      {!loading && result && (
        <div className="space-y-4">
          {usedEngine && (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] font-mono">
                ENGINE: {usedEngine.toUpperCase()}
              </Badge>
            </div>
          )}

          {result.aiResponse && (
            <Card className="border border-border bg-secondary p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-bold text-xs uppercase text-foreground">[AI OVERVIEW]</span>
              </div>
              <div
                ref={aiRef}
                className="ai-response-content text-foreground text-xs leading-relaxed"
                dangerouslySetInnerHTML={{ __html: result.aiResponse }}
              />
            </Card>
          )}

          <div className="space-y-3">
            <h4 className="font-bold font-mono text-xs uppercase tracking-wider text-muted-foreground">Organic Search Results ({result.organic.length})</h4>
            {result.organic.length === 0 ? (
              <p className="text-muted-foreground text-xs font-mono">No organic results found.</p>
            ) : (
              result.organic.map((item, idx) => (
                <Card key={idx} className="border border-border bg-card p-4 space-y-1.5 hover:bg-secondary transition-colors">
                  <a href={item.link} target="_blank" rel="noreferrer" className="block space-y-1">
                    <h4 className="text-foreground hover:underline font-bold text-sm">{item.title}</h4>
                    <div className="text-xs text-muted-foreground font-mono truncate">{item.link}</div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{item.snippet}</p>
                  </a>
                </Card>
              ))
            )}
          </div>

          <div className="flex justify-center gap-2 pt-2">
            <Button
              disabled={page <= 1}
              onClick={() => handleSearch(undefined, Math.max(1, page - 1))}
              variant="outline"
              size="xs"
              className="font-mono text-xs uppercase"
            >
              PREVIOUS
            </Button>
            <div className="px-3 py-1 flex items-center justify-center text-muted-foreground text-xs font-mono border border-border bg-secondary">
              PAGE {page}
            </div>
            <Button
              onClick={() => handleSearch(undefined, page + 1)}
              variant="outline"
              size="xs"
              className="font-mono text-xs uppercase"
            >
              NEXT
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
