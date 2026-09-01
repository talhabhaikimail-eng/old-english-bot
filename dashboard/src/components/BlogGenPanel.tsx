import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const STEPS = [
  '🔍 Querying Google Search for latest news and trends...',
  '🧠 Having Gemini identify the hottest developer sub-trends...',
  '📖 Researching chosen sub-trend in-depth on the web...',
  '✍️ Drafting human-like, citation-free technical blog post...',
  '🎨 Selecting matched cover image & publishing to site...'
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
    <div className="space-y-4 max-w-4xl mx-auto text-sm font-mono">
      <Card className="border border-border bg-card">
        <CardHeader>
          <CardTitle>✍️ Automated Technical Blog Generator</CardTitle>
          <CardDescription>
            Autonomous trend discovery, Gemini synthesis, and live publication.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
              Topic or Technology Keyword
            </label>
            <Input
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="e.g. Next.js 15, Rust Async, SQLite in Go..."
              disabled={loading}
              className="w-full text-xs"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Button
              onClick={() => handleGenerate('custom')}
              disabled={loading || !topic.trim()}
              className="font-mono text-xs uppercase"
            >
              🪄 CUSTOM TOPIC
            </Button>
            <Button
              onClick={() => handleGenerate('discover')}
              disabled={loading}
              variant="outline"
              className="font-mono text-xs uppercase"
            >
              🌐 AUTODISCOVER TRENDS
            </Button>
            <Button
              onClick={() => handleGenerate('community')}
              disabled={loading}
              variant="outline"
              className="font-mono text-xs uppercase"
            >
              🚀 COMMUNITY DIGEST
            </Button>
          </div>

          {loading && (
            <div className="bg-secondary border border-border p-4 space-y-3 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-foreground">[GENERATOR ACTIVE]</span>
              </div>
              <div className="space-y-1.5 text-xs">
                {STEPS.map((s, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center gap-2 ${idx === stepIndex
                        ? 'text-foreground font-bold'
                        : idx < stepIndex
                          ? 'text-muted-foreground line-through'
                          : 'text-muted-foreground opacity-40'
                      }`}
                  >
                    <span>{idx < stepIndex ? '✓' : idx === stepIndex ? '▶' : '○'}</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
              <div className="w-full bg-background h-1.5 border border-border">
                <div
                  className="bg-foreground h-full transition-all duration-500"
                  style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-foreground bg-secondary border border-border p-3 font-mono">
              [ERROR] {error}
            </div>
          )}

          {result && (
            <div className="bg-secondary border border-border p-4 space-y-3 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-foreground">[SUCCESS: PUBLISHED]</span>
                <p className="text-[10px] text-muted-foreground">ID: {result.id || 'N/A'}</p>
              </div>

              {result.imageUrl && (
                <div className="border border-border bg-background">
                  <img
                    src={result.imageUrl}
                    alt={result.title || 'Cover'}
                    className="w-full h-44 object-cover"
                  />
                </div>
              )}

              <div className="space-y-1">
                <h4 className="text-xs font-bold text-foreground">{result.title}</h4>
                <p className="text-xs text-muted-foreground">{result.description}</p>
              </div>

              <a
                href={result.url || `https://talhacodes.site/blog/${result.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 py-2 border border-border bg-foreground text-background font-bold text-xs uppercase"
              >
                <span>🌍</span>
                <span>OPEN PUBLISHED POST</span>
              </a>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
