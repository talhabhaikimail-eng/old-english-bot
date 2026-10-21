import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Loader2, Check, Circle, PenLine, Wand2, Globe, Rocket, ExternalLink } from 'lucide-react';

const STEPS = [
  'Querying Google Search for latest news and trends...',
  'Having Gemini identify the hottest developer sub-trends...',
  'Researching chosen sub-trend in-depth on the web...',
  'Drafting human-like, citation-free technical blog post...',
  'Selecting matched cover image & publishing to site...'
];

export default function BlogGenPanel() {
  const [topic, setTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  // Animate steps while loading is true
  useEffect(() => {
    if (!loading) return;
    setStepIndex(0);
    const interval = setInterval(() => {
      setStepIndex(prev => (prev < STEPS.length - 1 ? prev + 1 : prev));
    }, 4500);
    return () => clearInterval(interval);
  }, [loading]);

  const handleGenerate = async (mode: 'custom' | 'discover' | 'community') => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      let res;
      if (mode === 'community') {
        res = await api.generateBlog(undefined, true);
      } else if (mode === 'discover') {
        res = await api.generateBlog(undefined, false);
      } else {
        res = await api.generateBlog(topic, false);
      }
      if (res.success) {
        setResult(res.data || res);
      } else {
        setError(res.message || 'Failed to generate blog post.');
      }
    } catch (e: any) {
      setError(e.message || 'An error occurred during blog generation.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto text-sm">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-tight"><PenLine className="size-4 text-muted-foreground" />Automated technical blog generator</CardTitle>
          <CardDescription>
            Autonomous trend discovery, Gemini synthesis, and live publication.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground block">
              Topic or technology keyword
            </label>
            <Input
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="e.g. Next.js 15, Rust Async, SQLite in Go..."
              disabled={loading}
              className="w-full"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Button
              onClick={() => handleGenerate('custom')}
              disabled={loading || !topic.trim()}
            >
              <Wand2 /> Custom topic
            </Button>
            <Button
              onClick={() => handleGenerate('discover')}
              disabled={loading}
              variant="outline"
            >
              <Globe /> Autodiscover trends
            </Button>
            <Button
              onClick={() => handleGenerate('community')}
              disabled={loading}
              variant="outline"
            >
              <Rocket /> Community digest
            </Button>
          </div>

          {loading && (
            <div className="bg-secondary/40 rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin text-primary" /><span className="text-xs font-medium text-foreground">Generating</span>
              </div>
              <div className="space-y-1.5 text-xs">
                {STEPS.map((s, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center gap-2 ${idx === stepIndex
                        ? 'text-foreground font-medium'
                        : idx < stepIndex
                          ? 'text-muted-foreground line-through'
                          : 'text-muted-foreground opacity-40'
                      }`}
                  >
                    {idx < stepIndex ? <Check className="size-3.5 text-primary" /> : idx === stepIndex ? <Loader2 className="size-3.5 animate-spin" /> : <Circle className="size-3.5" />}
                    <span>{s}</span>
                  </div>
                ))}
              </div>
              <div className="w-full bg-background h-1.5 rounded-full border border-border overflow-hidden">
                <div
                  className="bg-primary h-full transition-all duration-500"
                  style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-3">
              {error}
            </div>
          )}

          {result && (
            <div className="bg-secondary/40 rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">Published</span>
                <p className="text-xs text-muted-foreground font-mono">ID: {result.id || 'N/A'}</p>
              </div>

              {result.imageUrl && (
                <div className="rounded-md overflow-hidden border border-border bg-background">
                  <img
                    src={result.imageUrl}
                    alt={result.title || 'Cover'}
                    className="w-full h-44 object-cover"
                  />
                </div>
              )}

              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-foreground">{result.title}</h4>
                <p className="text-xs text-muted-foreground">{result.description}</p>
              </div>

              <a
                href={result.url || `https://talhacodes.site/blog/${result.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 h-8 rounded-md border border-primary bg-primary text-primary-foreground hover:bg-primary/85 font-medium text-xs"
              >
                <ExternalLink className="size-3.5" />
                <span>Open published post</span>
              </a>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
