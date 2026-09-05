import React, { useState } from 'react';
import { api } from './api';
import { useUrls, useCountdown, NavSection } from './hooks';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

const SessionsPanel = React.lazy(() => import('./components/SessionsPanel'));
const SessionsManagerPanel = React.lazy(() => import('./components/SessionsManagerPanel'));
const AIToolsPanel = React.lazy(() => import('./components/AIToolsPanel'));
const MediaPanel = React.lazy(() => import('./components/MediaPanel'));
const YoutubePanel = React.lazy(() => import('./components/YoutubePanel'));
const MoviesPanel = React.lazy(() => import('./components/MoviesPanel'));
const URLsPanel = React.lazy(() => import('./components/URLsPanel'));
const AndroidPanel = React.lazy(() => import('./components/AndroidPanel'));
const LLMPanel = React.lazy(() => import('./components/LLMPanel'));
const SearchPanel = React.lazy(() => import('./components/SearchPanel'));
const TTSPanel = React.lazy(() => import('./components/TTSPanel'));
const PlacesPanel = React.lazy(() => import('./components/PlacesPanel'));
const GoogleClonePanel = React.lazy(() => import('./components/GoogleClonePanel'));
const WebProxyPanel = React.lazy(() => import('./components/WebProxyPanel'));
const PoolPanel = React.lazy(() => import('./components/PoolPanel'));
const BetaGoContainerPanel = React.lazy(() => import('./components/BetaGoContainerPanel'));
const IndeedPanel = React.lazy(() => import('./components/IndeedPanel'));
const ContactsScraperPanel = React.lazy(() => import('./components/ContactsScraperPanel'));
const BlogGenPanel = React.lazy(() => import('./components/BlogGenPanel'));
const CodeExecPanel = React.lazy(() => import('./components/CodeExecPanel'));
const ProxyPanel = React.lazy(() => import('./components/ProxyPanel'));
const CourseWorkerPanel = React.lazy(() => import('./components/CourseWorkerPanel'));
const WorkerShellPanel = React.lazy(() => import('./components/WorkerShellPanel'));

interface NavItem {
  id: NavSection;
  label: string;
  icon: string;
}

interface NavCategory {
  title: string;
  icon: string;
  items: NavItem[];
}

const NAV_CATEGORIES: NavCategory[] = [
  {
    title: 'Public Sandbox',
    icon: '🌍',
    items: [
      { id: 'google',    label: 'Google Clone',   icon: '🌐' },
      { id: 'web-proxy', label: 'Web Proxy',      icon: '🌍' },
    ]
  },
  {
    title: 'Browser & Search',
    icon: '🔍',
    items: [
      { id: 'search',    label: 'Browser Search', icon: '🔍' },
      { id: 'places',    label: 'Maps Places',    icon: '🗺️' },
      { id: 'pool',      label: 'Browser Pool',   icon: '🕸️' },
      { id: 'indeed',    label: 'Indeed Jobs',    icon: '💼' },
      { id: 'contacts',  label: 'Contacts & Jobs', icon: '📇' },
    ]
  },
  {
    title: 'Control Center',
    icon: '🖥️',
    items: [
      { id: 'sessions',  label: 'Dev Sessions',   icon: '🖥️' },
      { id: 'manager',   label: 'Session Manager', icon: '📊' },
      { id: 'shell',     label: 'Worker Shells (WebSSH)', icon: '💻' },
      { id: 'code-exec', label: 'Code Executor (Runner)', icon: '💻' },
      { id: 'proxy-net', label: 'HTTP Network Proxy', icon: '📡' },
      { id: 'android',   label: 'Android',        icon: '📱' },
      { id: 'urls',      label: 'Live URLs',      icon: '🔗' },
      { id: 'go-containers', label: 'Beta Containers (Go)', icon: '⚡' },
    ]
  },
  {
    title: 'AI & Media',
    icon: '✨',
    items: [
      { id: 'ai-tools',  label: 'AI Tools',       icon: '🧠' },
      { id: 'media',     label: 'Media DL',       icon: '📥' },
      { id: 'youtube',   label: 'YouTube',        icon: '▶️' },
      { id: 'movies',    label: 'Movies',         icon: '🎬' },
      { id: 'llm',       label: 'Local LLM',      icon: '🧠' },
      { id: 'tts',       label: 'Voice / TTS',    icon: '🎙️' },
      { id: 'blog-gen',  label: 'Blog Generator', icon: '✍️' },
      { id: 'courses',   label: 'Course Downloader', icon: '🎓' },
    ]
  }
];

const NAV: NavItem[] = NAV_CATEGORIES.flatMap(cat => cat.items);

export default function App() {
  const getInitialSection = (): NavSection => {
    const hash = window.location.hash.replace(/^#\/?/, '');
    const path = window.location.pathname.replace(/^\//, '');
    const raw = hash || path;
    const current = raw.split('?')[0];
    const validSections: NavSection[] = [
      'google', 'web-proxy', 'search', 'places', 'pool', 'indeed', 'contacts', 
      'sessions', 'manager', 'shell', 'code-exec', 'proxy-net', 'android', 'urls', 'go-containers', 
      'ai-tools', 'media', 'youtube', 'movies', 'llm', 'tts', 'blog-gen', 'courses'
    ];

    if (validSections.includes(current as NavSection)) {
      return current as NavSection;
    }
    return 'sessions';
  };

  const [section, setSection] = React.useState<NavSection>(getInitialSection());
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  React.useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
      const validSections: NavSection[] = [
        'google', 'web-proxy', 'search', 'places', 'pool', 'indeed', 'contacts', 
        'sessions', 'manager', 'shell', 'code-exec', 'proxy-net', 'android', 'urls', 'go-containers', 
        'ai-tools', 'media', 'youtube', 'movies', 'llm', 'tts', 'blog-gen', 'courses'
      ];
      if (validSections.includes(hash as NavSection)) {
        setSection(hash as NavSection);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const filteredCategories = NAV_CATEGORIES.map(category => {
    const filteredItems = category.items.filter(item =>
      item.label.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return {
      ...category,
      items: filteredItems,
    };
  }).filter(category => category.items.length > 0);
  
  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark';
  });

  React.useEffect(() => {
    localStorage.setItem('theme', theme);
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!localStorage.getItem('dashboard_token'));
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const { data, refresh } = useUrls(isAuthenticated);
  const cd = useCountdown(data?.sessionRemainingSeconds ?? 5 * 3600);

  // Dynamic favicon and page title
  React.useEffect(() => {
    let faviconPath = 'sessions';
    let title = 'Bridge Panel';

    if (!isAuthenticated && section !== 'google') {
      faviconPath = 'login';
      title = 'Login - Bridge Panel';
    } else {
      const activeNav = NAV.find(item => item.id === section);
      if (activeNav) {
        faviconPath = activeNav.id;
        title = `${activeNav.label} - Bridge Panel`;
      } else if (section === 'google') {
        faviconPath = 'google';
        title = 'Google Clone';
      }
    }

    document.title = title;

    let link: HTMLLinkElement | null = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    link.href = `/favicons/${faviconPath}.png`;
  }, [section, isAuthenticated]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await api.login(loginUsername, loginPassword);
      if (res.success && res.token) {
        localStorage.setItem('dashboard_token', res.token);
        setIsAuthenticated(true);
        refresh();
      } else {
        setLoginError('Invalid credentials');
      }
    } catch (err: any) {
      setLoginError(err.message || 'Authentication failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('dashboard_token');
    setIsAuthenticated(false);
    if (section !== 'google') {
      setSection('sessions');
    }
  };

  React.useEffect(() => {
    const handleLocationChange = () => {
      const hash = window.location.hash.replace(/^#\/?/, '');
      const path = window.location.pathname.replace(/^\//, '');
      const current = hash || path;
      const validSections: NavSection[] = [
        'google', 'web-proxy', 'search', 'places', 'pool', 'indeed', 'contacts', 
        'sessions', 'manager', 'code-exec', 'proxy-net', 'android', 'urls', 'go-containers', 
        'ai-tools', 'media', 'youtube', 'movies', 'llm', 'tts', 'blog-gen', 'courses'
      ];
      if (validSections.includes(current as NavSection)) {
        setSection(current as NavSection);
      }
    };
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
    };
  }, []);

  const handleNavClick = (id: NavSection) => {
    setSection(id);
    setIsMenuOpen(false);
    window.location.hash = `#/${id}`;
  };

  if (!isAuthenticated && section !== 'google') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background relative p-4 font-sans text-foreground">
        {/* Theme toggle on login screen */}
        <div className="absolute top-4 right-4 z-20">
          <Button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            variant="outline"
            size="sm"
            className="text-xs"
            title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          >
            <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
            <span>{theme === 'dark' ? 'LIGHT' : 'DARK'}</span>
          </Button>
        </div>

        <Card className="relative z-10 w-full max-w-md bg-card border border-border p-6 sm:p-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 mx-auto border border-border bg-foreground text-background flex items-center justify-center text-xl font-bold font-mono">
              BP
            </div>
            <CardTitle className="text-sm font-mono font-bold uppercase tracking-wider text-foreground">
              Bridge Panel Access
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Authenticate to manage live sessions and proxy workers
            </CardDescription>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground font-mono">
                Username
              </label>
              <Input
                type="text"
                required
                className="w-full"
                placeholder="Enter username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground font-mono">
                Password
              </label>
              <Input
                type="password"
                required
                className="w-full"
                placeholder="Enter password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
              />
            </div>

            {loginError && (
              <div className="p-3 text-xs bg-secondary border border-border text-foreground font-mono">
                [ERROR] {loginError}
              </div>
            )}

            <Button
              type="submit"
              disabled={loginLoading}
              className="w-full py-2.5 text-xs font-bold font-mono tracking-wider uppercase"
            >
              {loginLoading ? 'AUTHENTICATING...' : 'SIGN IN'}
            </Button>
          </form>

          <div className="text-center pt-2">
            <Button
              onClick={() => {
                setSection('google');
                window.history.pushState(null, '', '/google');
              }}
              variant="link"
              className="text-xs text-muted-foreground hover:text-foreground font-mono"
            >
              [ View Public Google Clone ]
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (section === 'google') {
    return (
      <React.Suspense fallback={<div className="flex items-center justify-center min-h-screen bg-background text-foreground font-mono text-xs">Loading Google Clone...</div>}>
        <GoogleClonePanel isStandalone={true} />
      </React.Suspense>
    );
  }

  return (
    <div className="h-screen max-h-screen flex flex-col bg-background text-foreground text-sm font-sans overflow-hidden">
      <div className="relative z-10 flex flex-col h-full overflow-hidden">
        {/* Top Header */}
        <header className="bg-sidebar border-b border-border px-3 sm:px-6 py-2.5 sticky top-0 z-30">
          <div className="flex items-center justify-between gap-2 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="w-7 h-7 bg-foreground text-background flex items-center justify-center text-xs font-mono font-black border border-border">
                BP
              </div>
              <div>
                <h1 className="font-bold text-foreground text-xs sm:text-sm leading-tight tracking-wider uppercase font-mono">
                  Bridge Panel
                </h1>
                <p className="hidden sm:block text-[9px] text-muted-foreground uppercase tracking-widest font-mono">
                  Discord ↔ WhatsApp Orchestrator
                </p>
              </div>
              <Badge variant="outline" className="hidden sm:inline-flex ml-2 text-[9px] font-mono font-bold">
                [LIVE]
              </Badge>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2">
              {/* Countdown badge */}
              <Badge variant="outline" className={`hidden xs:flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono ${
                cd.urgent ? 'border-foreground font-bold' : 'text-muted-foreground'
              }`}>
                <span className="text-muted-foreground">REMAINING:</span> <span>{cd.display}</span>
              </Badge>

              {/* Theme toggle */}
              <Button 
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} 
                variant="outline"
                size="xs"
                className="font-mono text-[10px]"
                title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
              >
                <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
                <span className="hidden sm:inline">{theme === 'dark' ? 'LIGHT' : 'DARK'}</span>
              </Button>

              <Button onClick={refresh} variant="outline" size="xs" className="font-mono text-[10px]">
                <span>🔄</span>
                <span className="hidden md:inline">REFRESH</span>
              </Button>

              {isAuthenticated && (
                <Button onClick={handleLogout} variant="outline" size="xs" className="font-mono text-[10px]">
                  <span>🚪</span>
                  <span className="hidden md:inline">SIGN OUT</span>
                </Button>
              )}

              <Button 
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                variant="outline"
                size="xs"
                className="md:hidden font-mono text-[10px]"
              >
                {isMenuOpen ? '✕' : '☰ MENU'}
              </Button>
            </div>
          </div>
        </header>

        {/* Session progress bar */}
        <div className="h-0.5 bg-secondary sticky top-[48px] sm:top-[56px] z-30">
          <div
            className="h-full bg-foreground transition-all duration-1000"
            style={{ width: `${cd.pct}%` }}
          />
        </div>

        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Desktop Sidebar */}
          <nav className="w-64 flex-shrink-0 bg-sidebar border-r border-border p-3 sm:p-4 space-y-4 hidden md:block overflow-y-auto">
            {/* Sidebar Search */}
            <div className="relative">
              <span className="absolute inset-y-0 left-2.5 flex items-center text-muted-foreground text-xs">🔍</span>
              <Input
                type="text"
                placeholder="Search tools..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-7 pr-6 text-xs h-7"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="space-y-4">
              {filteredCategories.map(category => (
                <div key={category.title} className="space-y-1">
                  <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground px-2 flex items-center gap-1.5 font-mono">
                    <span>{category.icon}</span>
                    {category.title}
                  </h3>
                  <div className="space-y-0.5">
                    {category.items.map(n => (
                      <Button
                        key={n.id}
                        onClick={() => handleNavClick(n.id)}
                        variant="ghost"
                        className={`w-full flex items-center justify-start gap-2 px-2.5 py-1.5 h-auto text-xs font-mono transition-all ${
                          section === n.id
                            ? 'border-l-2 border-foreground bg-foreground text-background hover:bg-foreground hover:text-background font-bold'
                            : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                        }`}
                      >
                        <span className="text-xs">{n.icon}</span>
                        <span className="truncate uppercase tracking-wider text-[11px]">{n.label}</span>
                        {n.id === 'urls' && data?.tools && Object.keys(data.tools).length > 0 && (
                          <Badge variant="outline" className="ml-auto text-[9px] px-1 py-0 border-border">
                            {Object.keys(data.tools).length}
                          </Badge>
                        )}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
              {filteredCategories.length === 0 && (
                <p className="text-[11px] text-muted-foreground text-center py-4 uppercase tracking-wider font-mono">No tools found</p>
              )}
            </div>

            <div className="pt-3 border-t border-border mt-4">
              {data?.sessionStartedAt && (
                <div className="px-2.5 py-1.5 bg-secondary border border-border space-y-0.5">
                  <p className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground font-mono">Session Started</p>
                  <p className="text-xs font-mono text-foreground">
                    {new Date(data.sessionStartedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              )}
            </div>
          </nav>

          {/* Mobile Side Menu Overlay */}
          {isMenuOpen && (
            <div className="fixed inset-0 z-40 md:hidden bg-black/80" onClick={() => setIsMenuOpen(false)}>
              <nav 
                className="absolute right-0 top-0 bottom-0 w-72 bg-sidebar border-l border-border p-4 flex flex-col shadow-2xl"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4 pb-2 border-b border-border">
                  <h3 className="font-bold text-foreground text-xs font-mono uppercase tracking-wider">Navigation</h3>
                  <Button variant="ghost" size="xs" onClick={() => setIsMenuOpen(false)} className="font-mono text-xs">✕</Button>
                </div>

                {/* Mobile Search */}
                <div className="relative mb-4">
                  <span className="absolute inset-y-0 left-2.5 flex items-center text-muted-foreground text-xs">🔍</span>
                  <Input
                    type="text"
                    placeholder="Search tools..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full pl-7 pr-6 text-xs h-8"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                  {filteredCategories.map(category => (
                    <div key={category.title} className="space-y-1">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-2 flex items-center gap-1.5 font-mono">
                        <span>{category.icon}</span>
                        {category.title}
                      </h4>
                      <div className="space-y-0.5">
                        {category.items.map(n => (
                          <Button
                            key={n.id}
                            onClick={() => handleNavClick(n.id)}
                            variant="ghost"
                            className={`w-full flex items-center justify-start gap-2 px-2.5 py-2 h-auto text-xs font-mono transition-all ${
                              section === n.id
                                ? 'bg-foreground text-background border-l-2 border-foreground'
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                            }`}
                          >
                            <span className="text-sm">{n.icon}</span>
                            <span className="truncate">{n.label}</span>
                            {n.id === 'urls' && data?.tools && Object.keys(data.tools).length > 0 && (
                              <Badge variant="outline" className="ml-auto text-xs px-1.5 py-0">
                                {Object.keys(data.tools).length}
                              </Badge>
                            )}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {filteredCategories.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4 font-mono">No tools found</p>
                  )}
                </div>
              </nav>
            </div>
          )}

          {/* Main Content Area */}
          <main className="flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6">
            <div className="max-w-7xl mx-auto space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <h2 className="text-base sm:text-lg font-bold font-mono uppercase tracking-wider text-foreground flex items-center gap-2">
                  <span className="w-7 h-7 border border-border bg-secondary flex items-center justify-center text-sm">
                    {NAV.find(n => n.id === section)?.icon}
                  </span>
                  {NAV.find(n => n.id === section)?.label}
                </h2>
              </div>

              <div className="animate-in fade-in duration-200">
                <React.Suspense fallback={<div className="flex items-center justify-center p-12 text-muted-foreground font-mono text-xs">Loading panel...</div>}>
                  {section === 'sessions' && <SessionsPanel />}
                  {section === 'manager' && <SessionsManagerPanel />}
                  {section === 'code-exec' && <CodeExecPanel />}
                  {section === 'proxy-net' && <ProxyPanel />}
                  {section === 'android' && <AndroidPanel />}

                  {section === 'ai-tools' && <AIToolsPanel />}
                  {section === 'media' && <MediaPanel />}
                  {section === 'youtube' && <YoutubePanel />}
                  {section === 'movies' && <MoviesPanel />}
                  {section === 'urls' && <URLsPanel tools={data?.tools ?? {}} />}
                  {section === 'llm' && <LLMPanel />}
                  {section === 'search' && <SearchPanel />}
                  {section === 'places' && <PlacesPanel />}
                  {section === 'pool' && <PoolPanel />}
                  {section === 'shell' && <WorkerShellPanel />}
                  {section === 'tts' && <TTSPanel />}
                  {section === 'web-proxy' && <WebProxyPanel />}
                  {section === 'go-containers' && <BetaGoContainerPanel />}
                  {section === 'indeed' && <IndeedPanel />}
                  {section === 'contacts' && <ContactsScraperPanel />}
                  {section === 'blog-gen' && <BlogGenPanel />}
                  {section === 'courses' && <CourseWorkerPanel />}
                </React.Suspense>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
