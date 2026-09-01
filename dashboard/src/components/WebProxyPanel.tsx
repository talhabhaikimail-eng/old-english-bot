import React, { useState, useRef } from 'react';
import { 
  Globe, Search, ArrowLeft, RefreshCw, X, ExternalLink, 
  BookOpen, Github, MessageSquare, Compass
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface BookMark {
  name: string;
  url: string;
  icon: React.ReactNode;
}

export default function WebProxyPanel() {
  const [urlInput, setUrlInput] = useState('');
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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
    setActiveUrl(formattedUrl);
    setUrlInput(formattedUrl);
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
    setUrlInput('');
    setLoading(false);
  };

  const getProxyUrl = (target: string) => {
    const token = localStorage.getItem('dashboard_token') || '';
    return `/api/web-proxy?url=${encodeURIComponent(target)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  };

  return (
    <Card className="border border-border bg-card flex flex-col h-[78vh] text-sm font-mono">
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
          <div className="flex items-center bg-background border border-border px-2.5 py-1">
            <Search className="w-3.5 h-3.5 text-muted-foreground mr-2 flex-shrink-0" />
            <input 
              type="text" 
              className="flex-1 bg-transparent border-none outline-none text-xs text-foreground placeholder-muted-foreground p-0 font-mono"
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

        {activeUrl && (
          <a 
            href={getProxyUrl(activeUrl)} 
            target="_blank" 
            rel="noopener noreferrer"
            className="px-2.5 py-1 border border-border bg-secondary hover:bg-foreground hover:text-background text-foreground text-xs flex items-center gap-1 font-bold"
            title="Open Raw View"
          >
            <span className="hidden sm:inline">RAW</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 bg-background relative overflow-hidden flex flex-col justify-center items-center">
        {!activeUrl ? (
          <div className="max-w-xl w-full px-4 py-8 flex flex-col items-center text-center space-y-6">
            <div className="w-12 h-12 border border-border bg-foreground text-background flex items-center justify-center text-2xl font-bold font-mono">
              🌐
            </div>

            <div>
              <CardTitle className="text-base font-bold uppercase tracking-wider text-foreground font-mono">
                Virtual Browser Network Proxy
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-1 font-mono">
                Isolated sandbox proxy routing traffic through the cloud runner IP.
              </CardDescription>
            </div>

            {/* Quick Bookmarks */}
            <div className="w-full space-y-2">
              <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground text-left px-1">Quick Portals</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {bookmarks.map((bm) => (
                  <Button
                    key={bm.name}
                    onClick={() => handleGo(bm.url)}
                    variant="outline"
                    size="sm"
                    className="flex flex-col items-center justify-center p-2.5 h-auto text-xs font-mono"
                  >
                    <div className="mb-1 text-foreground">
                      {bm.icon}
                    </div>
                    <span className="text-[10px] uppercase font-bold">{bm.name}</span>
                  </Button>
                ))}
              </div>
            </div>

            {/* Usage Tips */}
            <div className="p-3 border border-border bg-secondary text-[11px] text-muted-foreground text-left space-y-1 w-full font-mono">
              <p className="font-bold text-foreground uppercase">Instructions:</p>
              <p>• Type any standard website URL and press Enter to browse privately.</p>
              <p>• Search terms are automatically parsed and forwarded to search.</p>
            </div>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col relative">
            {loading && (
              <div className="absolute inset-0 bg-background/80 z-10 flex flex-col items-center justify-center gap-2">
                <p className="text-xs text-muted-foreground tracking-wider font-mono">LOADING VIRTUAL FRAME...</p>
              </div>
            )}
            <iframe 
              ref={iframeRef}
              src={getProxyUrl(activeUrl)} 
              className="w-full h-full border-none bg-white"
              onLoad={handleIframeLoad}
              title="Virtual Proxy Browser Frame"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        )}
      </div>
    </Card>
  );
}
