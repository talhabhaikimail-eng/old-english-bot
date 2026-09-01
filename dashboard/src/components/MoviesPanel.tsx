import React, { useState } from 'react';
import { api, MovieResult } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

export default function MoviesPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MovieResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setResults([]);
    try {
      const res = await api.movieSearch(query);
      setResults(res.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto text-sm">
      <Card className="border border-border bg-card">
        <CardHeader>
          <CardTitle>Discover Movies & Series</CardTitle>
          <CardDescription>Search TMDB catalogue for titles, overviews, and streams.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="Search movies or TV shows..."
              className="flex-1"
            />
            <Button
              onClick={search}
              disabled={searching || !query.trim()}
              className="font-mono text-xs uppercase"
            >
              {searching ? 'SEARCHING...' : 'SEARCH TMDB'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="text-xs text-foreground bg-secondary border border-border px-4 py-3 font-mono">
          [ERROR] {error}
        </div>
      )}

      {results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {results.map(m => (
            <Card
              key={m.tmdbId}
              className="flex flex-col justify-between border border-border bg-card"
            >
              <div className="space-y-3">
                <div className="relative aspect-[16/10] bg-secondary border-b border-border overflow-hidden flex items-center justify-center">
                  {m.posterUrl ? (
                    <img
                      src={m.posterUrl}
                      alt={m.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-3xl">🎬</div>
                  )}
                  
                  <Badge variant="outline" className="absolute top-2 left-2 text-[9px] bg-background">
                    {m.mediaType === 'tv' ? 'TV SHOW' : 'MOVIE'}
                  </Badge>
                  
                  {m.releaseDate && (
                    <Badge variant="outline" className="absolute top-2 right-2 text-[9px] bg-background">
                      {m.releaseDate.slice(0, 4)}
                    </Badge>
                  )}
                </div>

                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-bold font-mono text-xs uppercase tracking-wider text-foreground truncate">{m.title}</h3>
                    {m.voteAverage > 0 && (
                      <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                        ⭐ {m.voteAverage.toFixed(1)}
                      </Badge>
                    )}
                  </div>
                  {m.overview && (
                    <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                      {m.overview}
                    </p>
                  )}
                </div>
              </div>

              <div className="p-4 pt-0">
                <a
                  href={m.watchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-1.5 py-2 border border-border bg-secondary hover:bg-foreground hover:text-background text-foreground text-xs font-mono font-bold uppercase transition-colors"
                >
                  <span>▶</span>
                  <span>WATCH CONTENT</span>
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
