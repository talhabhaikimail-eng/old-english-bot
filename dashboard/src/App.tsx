import React, { useState } from 'react';
import { api } from './api';
import { useUrls, useCountdown, NavSection } from './hooks';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Globe, Network, Search, MapPin, Layers, Briefcase, Contact, Monitor, LayoutDashboard,
  SquareTerminal, Code2, Radio, Smartphone, Link2, Zap, BrainCircuit, Download, PlaySquare,
  Clapperboard, Cpu, Mic, PenLine, GraduationCap, Sun, Moon, RefreshCw, LogOut, Menu, X,
  Timer, ChevronsLeft, ChevronsRight, type LucideIcon,
} from 'lucide-react';

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
  icon: LucideIcon;
}

interface NavCategory {
  title: string;
  items: NavItem[];
}

const NAV_CATEGORIES: NavCategory[] = [
  {
    title: 'Public Sandbox',
    items: [
      { id: 'google',    label: 'Google Clone',   icon: Globe },
      { id: 'web-proxy', label: 'Web Proxy',      icon: Network },
    ]
  },
  {
    title: 'Browser & Search',
    items: [
      { id: 'search',    label: 'Browser Search', icon: Search },
      { id: 'places',    label: 'Maps Places',    icon: MapPin },
      { id: 'pool',      label: 'Browser Pool',   icon: Layers },
      { id: 'indeed',    label: 'Indeed Jobs',    icon: Briefcase },
      { id: 'contacts',  label: 'Contacts & Jobs', icon: Contact },
    ]
  },
  {
    title: 'Control Center',
    items: [
      { id: 'sessions',  label: 'Dev Sessions',   icon: Monitor },
      { id: 'manager',   label: 'Session Manager', icon: LayoutDashboard },
      { id: 'shell',     label: 'Worker Shells (WebSSH)', icon: SquareTerminal },
      { id: 'code-exec', label: 'Code Executor (Runner)', icon: Code2 },
      { id: 'proxy-net', label: 'HTTP Network Proxy', icon: Radio },
      { id: 'android',   label: 'Android',        icon: Smartphone },
      { id: 'urls',      label: 'Live URLs',      icon: Link2 },
      { id: 'go-containers', label: 'Beta Containers (Go)', icon: Zap },
    ]
  },
  {
    title: 'AI & Media',
    items: [
      { id: 'ai-tools',  label: 'AI Tools',       icon: BrainCircuit },
      { id: 'media',     label: 'Media DL',       icon: Download },
      { id: 'youtube',   label: 'YouTube',        icon: PlaySquare },
      { id: 'movies',    label: 'Movies',         icon: Clapperboard },
      { id: 'llm',       label: 'Local LLM',      icon: Cpu },
      { id: 'tts',       label: 'Voice / TTS',    icon: Mic },
      { id: 'blog-gen',  label: 'Blog Generator', icon: PenLine },
      { id: 'courses',   label: 'Course Downloader', icon: GraduationCap },
    ]
  }
];

const NAV: NavItem[] = NAV_CATEGORIES.flatMap(cat => cat.items);

const VALID_SECTIONS: NavSection[] = [
  'google', 'web-proxy', 'search', 'places', 'pool', 'indeed', 'contacts',
  'sessions', 'manager', 'shell', 'code-exec', 'proxy-net', 'android', 'urls', 'go-containers',
  'ai-tools', 'media', 'youtube', 'movies', 'llm', 'tts', 'blog-gen', 'courses'
];

export default function App() {
  const getInitialSection = (): NavSection => {
    const hash = window.location.hash.replace(/^#\/?/, '');
    const path = window.location.pathname.replace(/^\//, '');
    const raw = hash || path;
    const current = raw.split('?')[0];

    if (VALID_SECTIONS.includes(current as NavSection)) {
      return current as NavSection;
    }
    return 'sessions';
  };

  const [section, setSection] = React.useState<NavSection>(getInitialSection());
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  React.useEffect(() => {
    const onLocationChange = () => {
      const hash = window.location.hash.replace(/^#\/?/, '');
      const path = window.location.pathname.replace(/^\//, '');
      const current = (hash || path).split('?')[0];
      if (VALID_SECTIONS.includes(current as NavSection)) {
        setSection(current as NavSection);
      }
    };
    window.addEventListener('hashchange', onLocationChange);
    window.addEventListener('popstate', onLocationChange);
    return () => {
      window.removeEventListener('hashchange', onLocationChange);
      window.removeEventListener('popstate', onLocationChange);
    };
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

  const handleNavClick = (id: NavSection) => {
    setSection(id);
    setIsMenuOpen(false);
    window.location.hash = `#/${id}`;
  };

  if (!isAuthenticated && section !== 'google') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background relative p-4 font-sans text-foreground">
        <div className="absolute top-4 right-4 z-20">
          <Button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            variant="ghost"
            size="icon"
            title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>

        <Card className="relative z-10 w-full max-w-sm bg-card border border-border p-6 sm:p-8 gap-6 shadow-2xl">
          <div className="space-y-3">
            <div className="w-9 h-9 rounded-md bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
              B
            </div>
            <div className="space-y-1">
              <CardTitle className="text-xl">Sign in to Bridge</CardTitle>
              <CardDescription className="text-sm">
                Manage live sessions and proxy workers
              </CardDescription>
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Username</label>
              <Input
                type="text"
                required
                autoFocus
                className="w-full h-9"
                placeholder="Enter username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Password</label>
              <Input
                type="password"
                required
                className="w-full h-9"
                placeholder="Enter password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
              />
            </div>

            {loginError && (
              <div className="px-3 py-2 text-xs rounded-md bg-destructive/10 border border-destructive/30 text-destructive">
                {loginError}
              </div>
            )}

            <Button type="submit" disabled={loginLoading} className="w-full h-9">
              {loginLoading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <div className="text-center">
            <Button
              onClick={() => {
                setSection('google');
                window.history.pushState(null, '', '/google');
              }}
              variant="link"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              View public Google Clone
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (section === 'google') {
    return (
      <React.Suspense fallback={<div className="flex items-center justify-center min-h-screen bg-background text-foreground text-xs">Loading Google Clone…</div>}>
        <GoogleClonePanel isStandalone={true} />
      </React.Suspense>
    );
  }

  const active = NAV.find(n => n.id === section);
  const ActiveIcon = active?.icon;
  const activeCategory = NAV_CATEGORIES.find(c => c.items.some(i => i.id === section));
  const urlCount = data?.tools ? Object.keys(data.tools).length : 0;

  const renderNav = (compact: boolean) => (
    <>
      {filteredCategories.map(category => (
        <div key={category.title} className="space-y-0.5">
          {!compact && (
            <h3 className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-muted-foreground/70">
              {category.title}
            </h3>
          )}
          {category.items.map(n => {
            const Icon = n.icon;
            const isActive = section === n.id;
            return (
              <button
                key={n.id}
                onClick={() => handleNavClick(n.id)}
                title={compact ? n.label : undefined}
                className={`group relative w-full flex items-center gap-2.5 rounded-md text-[13px] transition-colors cursor-pointer ${
                  compact ? 'justify-center h-8' : 'px-2.5 h-8'
                } ${
                  isActive
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
              >
                {isActive && !compact && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
                )}
                <Icon className={`size-4 shrink-0 ${isActive ? 'text-primary' : ''}`} />
                {!compact && <span className="truncate">{n.label}</span>}
                {!compact && n.id === 'urls' && urlCount > 0 && (
                  <Badge variant="outline" className="ml-auto h-4 text-[10px] px-1.5">
                    {urlCount}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      ))}
      {filteredCategories.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">No tools found</p>
      )}
    </>
  );

  const searchBox = (cls: string) => (
    <div className={`relative ${cls}`}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
      <Input
        type="text"
        placeholder="Search tools…"
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        className="w-full pl-8 pr-7 text-xs h-8"
      />
      {searchQuery && (
        <button
          onClick={() => setSearchQuery('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div className="h-screen max-h-screen flex flex-col bg-background text-foreground text-[13px] font-sans overflow-hidden">
      {/* Top bar */}
      <header className="relative h-12 shrink-0 bg-background border-b border-border px-3 sm:px-4 flex items-center justify-between gap-3 z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-6 h-6 rounded-md bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
            B
          </div>
          <span className="font-semibold text-sm tracking-tight">Bridge</span>
          <Badge variant="outline" className="hidden sm:inline-flex gap-1.5">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            Live
          </Badge>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <div
            className={`hidden xs:flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-xs tabular-nums ${
              cd.urgent ? 'border-destructive/40 text-destructive bg-destructive/10' : 'border-border text-muted-foreground'
            }`}
            title="Session time remaining"
          >
            <Timer className="size-3.5" />
            <span>{cd.display}</span>
          </div>

          <Button onClick={refresh} variant="ghost" size="icon-sm" title="Refresh">
            <RefreshCw />
          </Button>
          <Button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            variant="ghost"
            size="icon-sm"
            title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
          {isAuthenticated && (
            <Button onClick={handleLogout} variant="outline" size="sm" title="Sign out">
              <LogOut />
              <span className="hidden md:inline">Sign out</span>
            </Button>
          )}
          <Button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            variant="outline"
            size="icon-sm"
            className="md:hidden"
          >
            {isMenuOpen ? <X /> : <Menu />}
          </Button>
        </div>

        {/* Session progress hairline */}
        <div className="absolute left-0 right-0 -bottom-px h-px pointer-events-none">
          <div
            className={`h-full transition-all duration-1000 ${cd.urgent ? 'bg-destructive' : 'bg-primary'}`}
            style={{ width: `${cd.pct}%` }}
          />
        </div>
      </header>

      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Desktop Sidebar */}
        <nav
          className={`${collapsed ? 'w-14' : 'w-60'} shrink-0 bg-sidebar border-r border-border hidden md:flex flex-col transition-[width] duration-150`}
        >
          <div className={`p-2.5 ${collapsed ? 'hidden' : ''}`}>{searchBox('')}</div>

          <div className={`flex-1 overflow-y-auto px-2.5 space-y-3 pb-3 ${collapsed ? 'pt-3' : ''}`}>
            {renderNav(collapsed)}
          </div>

          <div className="border-t border-border p-2.5 space-y-2">
            {!collapsed && data?.sessionStartedAt && (
              <div className="px-2.5 py-2 rounded-md bg-secondary border border-border">
                <p className="text-[11px] text-muted-foreground">Session started</p>
                <p className="text-xs font-medium tabular-nums">
                  {new Date(data.sessionStartedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            )}
            <button
              onClick={() => setCollapsed(c => !c)}
              className={`w-full h-8 flex items-center gap-2.5 rounded-md text-[13px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer ${
                collapsed ? 'justify-center' : 'px-2.5'
              }`}
            >
              {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
              {!collapsed && <span>Collapse menu</span>}
            </button>
          </div>
        </nav>

        {/* Mobile Side Menu Overlay */}
        {isMenuOpen && (
          <div className="fixed inset-0 z-40 md:hidden bg-black/70 backdrop-blur-sm" onClick={() => setIsMenuOpen(false)}>
            <nav
              className="absolute right-0 top-0 bottom-0 w-72 bg-sidebar border-l border-border p-3 flex flex-col shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-sm">Navigation</h3>
                <Button variant="ghost" size="icon-sm" onClick={() => setIsMenuOpen(false)}><X /></Button>
              </div>
              {searchBox('mb-3')}
              <div className="flex-1 overflow-y-auto space-y-3">{renderNav(false)}</div>
            </nav>
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-background">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-5 space-y-5">
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                Bridge{activeCategory ? <><span className="mx-1.5 opacity-50">/</span>{activeCategory.title}</> : null}
              </p>
              <h2 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2.5">
                {ActiveIcon && <ActiveIcon className="size-5 text-primary" />}
                {active?.label}
              </h2>
            </div>

            <div className="animate-in fade-in duration-200">
              <React.Suspense fallback={<div className="flex items-center justify-center p-12 text-muted-foreground text-xs">Loading panel…</div>}>
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
  );
}
