import React, { useState, useRef } from 'react';
import { 
  Globe, Search, ArrowLeft, RefreshCw, X, ExternalLink, 
  BookOpen, Github, MessageSquare, Compass
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '../api';
import RemoteBrowserPanel from './RemoteBrowserPanel';

interface BookMark {
  name: string;
  url: string;
  icon: React.ReactNode;
}

function LiteProxy() {
  const [urlInput, setUrlInput] = useState('');
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [frameSrc, setFrameSrc] = useState('');
  const [error, setError] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const bookmarks: BookMark[] = [
    { 
      name: 'Google', 
      url: 'https://www.google.com', 
      icon: <Globe className="w-4 h-4" />, 
    },
    { 
      name: 'Wikipedia', 
      url: 'https://www.wikipedia.org', 
      icon: <BookOpen className="w-4 h-4" />, 
    },
    { 
      name: 'GitHub', 
      url: 'https://github.com', 
      icon: <Github className="w-4 h-4" />, 
    },
    { 
      name: 'Reddit', 
      url: 'https://www.reddit.com', 
      icon: <MessageSquare className="w-4 h-4" />, 
    },
    { 
      name: 'DuckDuckGo', 
      url: 'https://duckduckgo.com', 
      icon: <Compass className="w-4 h-4" />, 
    }
  ];

  const handleGo = (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    let formattedUrl = targetUrl.trim();

    if (formattedUrl.includes('/search?') || formattedUrl.includes('google.com/search')) {
      try {
        const absoluteUrl = formattedUrl.startsWith('http') ? formattedUrl : `https://google.com${formattedUrl.startsWith('/') ? '' : '/'}${formattedUrl}`;
        const urlObj = new URL(absoluteUrl);
        const query = urlObj.searchParams.get('q');
        if (query) {
          window.history.pushState(null, '', `/google?q=${encodeURIComponent(query)}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
          return;
        }
      } catch (e) {
        // ignore
      }
    }

    if (!/^https?:\/\//i.test(formattedUrl)) {
      if (formattedUrl.includes('.') && !formattedUrl.includes(' ')) {
        formattedUrl = 'https://' + formattedUrl;
      } else {
        formattedUrl = 'https://www.google.com/search?q=' + encodeURIComponent(formattedUrl);
      }
    }

    if (formattedUrl.includes('/search?') || formattedUrl.includes('google.com/search')) {
      try {
        const urlObj = new URL(formattedUrl);
        const query = urlObj.searchParams.get('q');
        if (query) {
          window.history.pushState(null, '', `/google?q=${encodeURIComponent(query)}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
          return;
        }
      } catch (e) {
        // ignore
      }
    }

    setLoading(true);
    setError('');
    setActiveUrl(formattedUrl);
    setUrlInput(formattedUrl);
    // Each browse gets its own unguessable proxy session; the dashboard credential never appears in a URL.
    api.createWebProxySession(formattedUrl)
      .then(r => setFrameSrc(r.src))
      .catch((e: Error) => { setError(e.message); setLoading(false); setActiveUrl(null); });
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleGo(urlInput);
  };

  const handleIframeLoad = () => {
    setLoading(false);
  };

  const handleRefresh = () => {
    if (iframeRef.current) {
      setLoading(true);
      const currentSrc = iframeRef.current.src;
      iframeRef.current.src = '';
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = currentSrc;
        }
      }, 50);
    }
  };

  const handleHome = () => {
    setActiveUrl(null);
    setFrameSrc('');
    setUrlInput('');
    setLoading(false);
  };

  return (
    <Card className="border border-border bg-card flex flex-col h-[78vh] text-[13px]">
      {/* Browser Address Bar / Header */}
      <div className="bg-secondary border-b border-border px-3 py-2 flex items-center gap-2">
        <div className="flex items-center gap-1">
          {activeUrl && (
            <Button 
              onClick={handleHome}
              variant="outline"
              size="xs"
              title="Home"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button 
            onClick={handleRefresh}
            disabled={!activeUrl}
            variant="outline"
            size="xs"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <form onSubmit={handleFormSubmit} className="flex-1">
          <div className="flex items-center bg-background border border-input rounded-md px-2.5 h-8 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
            <Search className="w-3.5 h-3.5 text-muted-foreground mr-2 flex-shrink-0" />
            <input 
              type="text" 
              className="flex-1 bg-transparent border-none outline-none text-xs text-foreground placeholder:text-muted-foreground p-0 font-mono"
              placeholder="Enter URL (e.g. wikipedia.org) or search query..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
            />
            {urlInput && (
              <button 
                type="button" 
                onClick={() => setUrlInput('')}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </form>

      </div>

      {/* Main Content Area */}
      <div className="flex-1 bg-background relative overflow-hidden flex flex-col justify-center items-center">
        {!activeUrl ? (
          <div className="max-w-xl w-full px-4 py-8 flex flex-col items-center text-center space-y-6">
            <div className="size-12 rounded-lg border border-border bg-secondary text-primary flex items-center justify-center">
              <Globe className="size-6" />
            </div>

            <div>
              <CardTitle className="text-base">
                Virtual browser proxy
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-1">
                Lite rewriting proxy: fast, but heavy sites (Google, YouTube, Discord) may break. Pages run in a sandbox without access to this dashboard. Use Remote browser for full compatibility.
              </CardDescription>
            </div>

            {error && (
              <div className="w-full rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive text-left">{error}</div>
            )}

            {/* Quick Bookmarks */}
            <div className="w-full space-y-2">
              <p className="text-xs font-medium text-muted-foreground text-left px-1">Quick links</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {bookmarks.map((bm) => (
                  <Button
                    key={bm.name}
                    onClick={() => handleGo(bm.url)}
                    variant="outline"
                    size="sm"
                    className="flex flex-col items-center justify-center p-2.5 h-auto text-xs"
                  >
                    <div className="mb-1 text-foreground">
                      {bm.icon}
                    </div>
                    <span className="text-xs font-medium">{bm.name}</span>
                  </Button>
                ))}
              </div>
            </div>

            {/* Usage Tips */}
            <div className="p-3 rounded-lg border border-border bg-secondary/40 text-xs text-muted-foreground text-left space-y-1 w-full">
              <p className="font-medium text-foreground">Instructions</p>
              <p>• Type any standard website URL and press Enter to browse privately.</p>
              <p>• Search terms are automatically parsed and forwarded to search.</p>
            </div>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col relative">
            {loading && (
              <div className="absolute inset-0 bg-background/80 z-10 flex flex-col items-center justify-center gap-2">
                <p className="text-xs text-muted-foreground">Loading virtual frame...</p>
              </div>
            )}
            <iframe 
              ref={iframeRef}
              src={frameSrc || 'about:blank'}
              className="w-full h-full border-none bg-white"
              onLoad={handleIframeLoad}
              title="Virtual Proxy Browser Frame"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        )}
      </div>
    </Card>
  );
}

export default function WebProxyPanel() {
  const [mode, setMode] = useState<'remote' | 'lite'>('remote');
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant={mode === 'remote' ? 'secondary' : 'ghost'} onClick={() => setMode('remote')}>
          Remote browser <Badge variant="default" className="ml-1.5 text-[10px]">recommended</Badge>
        </Button>
        <Button size="sm" variant={mode === 'lite' ? 'secondary' : 'ghost'} onClick={() => setMode('lite')}>Lite proxy</Button>
      </div>
      {mode === 'remote' ? <RemoteBrowserPanel /> : <LiteProxy />}
    </div>
  );
}
