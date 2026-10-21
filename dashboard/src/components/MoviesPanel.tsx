import React, { useState } from 'react';
import { Clapperboard, Play, Search, Star, AlertCircle, Loader2 } from 'lucide-react';
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
    <div className="space-y-4 max-w-5xl mx-auto text-[13px]">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold tracking-tight">Discover movies & series</CardTitle>
          <CardDescription className="text-xs">Search TMDB catalogue for titles, overviews, and streams.</CardDescription>
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
            >
              {searching ? <Loader2 className="animate-spin" /> : <Search />}
              {searching ? 'Searching...' : 'Search TMDB'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2.5">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {results.map(m => (
            <Card
              key={m.tmdbId}
              className="flex flex-col justify-between overflow-hidden p-0 gap-0 hover:border-foreground/30 transition-colors"
            >
              <div>
                <div className="relative aspect-[16/10] bg-secondary border-b border-border overflow-hidden flex items-center justify-center">
                  {m.posterUrl ? (
                    <img
                      src={m.posterUrl}
                      alt={m.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Clapperboard className="size-8 text-muted-foreground" />
                  )}

                  <Badge variant="secondary" className="absolute top-2 left-2 bg-background/90">
                    {m.mediaType === 'tv' ? 'TV show' : 'Movie'}
                  </Badge>

                  {m.releaseDate && (
                    <Badge variant="secondary" className="absolute top-2 right-2 bg-background/90">
                      {m.releaseDate.slice(0, 4)}
                    </Badge>
                  )}
                </div>

                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold tracking-tight text-sm text-foreground truncate">{m.title}</h3>
                    {m.voteAverage > 0 && (
                      <Badge variant="outline" className="shrink-0">
                        <Star className="text-amber-500" /> {m.voteAverage.toFixed(1)}
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
                  className="w-full inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary hover:bg-accent text-foreground text-xs font-medium transition-colors"
                >
                  <Play className="size-3.5" />
                  <span>Watch content</span>
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
