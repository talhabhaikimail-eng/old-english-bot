import React, { useEffect, useMemo, useState } from 'react';
import { Search, Server, History, LayoutGrid, X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { CATEGORIES, TOOLS, type CategoryId, type ToolDef } from './devtools/registry';

const ACTIVE_KEY = 'devtools_active_tool';
const RECENT_KEY = 'devtools_recent_tools';
const MAX_RECENT = 6;

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/** `#/dev-tools?tool=json` → `json` */
function toolFromHash(): string | null {
  const q = window.location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get('tool') : null;
}

function initialTool(): string | null {
  const fromHash = toolFromHash();
  if (fromHash && TOOLS.some(t => t.id === fromHash)) return fromHash;
  const saved = storageGet(ACTIVE_KEY);
  return saved && TOOLS.some(t => t.id === saved) ? saved : null;
}

class ToolErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          This tool crashed: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function DevToolsPanel() {
  const [active, setActive] = useState<string | null>(initialTool);
  const [category, setCategory] = useState<CategoryId | 'all'>(() => {
    const t = TOOLS.find(x => x.id === initialTool());
    return t ? t.category : 'all';
  });
  const [filter, setFilter] = useState('');
  const [recent, setRecent] = useState<string[]>(() => {
    try { return (JSON.parse(storageGet(RECENT_KEY) || '[]') as string[]).filter(id => TOOLS.some(t => t.id === id)); } catch { return []; }
  });

  const open = (id: string | null) => {
    setActive(id);
    if (id) {
      storageSet(ACTIVE_KEY, id);
      setRecent(r => {
        const next = [id, ...r.filter(x => x !== id)].slice(0, MAX_RECENT);
        storageSet(RECENT_KEY, JSON.stringify(next));
        return next;
      });
    }
    const base = window.location.hash.split('?')[0] || '#/dev-tools';
    window.history.replaceState(null, '', id ? `${base}?tool=${id}` : base);
  };

  useEffect(() => {
    const onHash = () => {
      const id = toolFromHash();
      if (id && TOOLS.some(t => t.id === id)) setActive(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const query = filter.trim().toLowerCase();
  const visible = useMemo(() => TOOLS.filter(t => {
    if (query) return `${t.label} ${t.description} ${t.keywords ?? ''} ${t.id}`.toLowerCase().includes(query);
    return category === 'all' || t.category === category;
  }), [query, category]);

  const tool = TOOLS.find(t => t.id === active) ?? null;
  const counts = useMemo(() => Object.fromEntries(CATEGORIES.map(c => [c.id, TOOLS.filter(t => t.category === c.id).length])), []);

  return (
    <div className="flex flex-col md:flex-row gap-4 text-[13px]">
      <aside className="md:w-52 shrink-0 space-y-2 md:sticky md:top-0 md:self-start">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={filter}
            onChange={e => { setFilter(e.target.value); if (e.target.value) open(null); }}
            placeholder={`Search ${TOOLS.length} tools…`}
            className="pl-8 pr-7 h-8 text-xs"
          />
          {filter && (
            <button onClick={() => setFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <nav className="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible pb-1 md:pb-0">
          {[{ id: 'all' as const, label: 'All tools', icon: LayoutGrid }, ...CATEGORIES].map(c => {
            const Icon = c.icon;
            const isActive = !query && category === c.id;
            return (
              <button
                key={c.id}
                onClick={() => { setCategory(c.id); setFilter(''); open(null); }}
                className={cn(
                  'flex items-center gap-2 h-8 px-2.5 rounded-md text-xs whitespace-nowrap cursor-pointer transition-colors',
                  isActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                )}
              >
                <Icon className={cn('size-4 shrink-0', isActive && 'text-primary')} />
                <span className="flex-1 text-left">{c.label}</span>
                <span className="text-[10px] tabular-nums opacity-60">{c.id === 'all' ? TOOLS.length : counts[c.id]}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 space-y-4">
        {tool ? (
          <ToolView tool={tool} onBack={() => open(null)} onOpen={open} />
        ) : (
          <>
            {!query && category === 'all' && recent.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><History className="size-3.5" /> Recently used</p>
                <div className="flex flex-wrap gap-1.5">
                  {recent.map(id => {
                    const t = TOOLS.find(x => x.id === id)!;
                    const Icon = t.icon;
                    return (
                      <button key={id} onClick={() => open(id)} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs hover:border-primary/50 hover:bg-secondary cursor-pointer">
                        <Icon className="size-3.5 text-primary" /> {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <ToolGrid tools={visible} onOpen={open} />
            {visible.length === 0 && <p className="text-xs text-muted-foreground py-8 text-center">No tools match “{filter}”.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function ToolGrid({ tools, onOpen }: { tools: ToolDef[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {tools.map(t => {
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            onClick={() => onOpen(t.id)}
            className="group text-left rounded-lg border border-border bg-card p-3 hover:border-primary/50 hover:bg-secondary/40 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Icon className="size-4 text-primary shrink-0" />
              <span className="text-[13px] font-medium truncate">{t.label}</span>
              {t.server && <Server className="size-3 text-muted-foreground ml-auto shrink-0" aria-label="Runs on the server" />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{t.description}</p>
          </button>
        );
      })}
    </div>
  );
}

function ToolView({ tool, onBack, onOpen }: { tool: ToolDef; onBack: () => void; onOpen: (id: string) => void }) {
  const Component = tool.component;
  const cat = CATEGORIES.find(c => c.id === tool.category)!;
  const related = TOOLS.filter(t => t.category === tool.category && t.id !== tool.id).slice(0, 8);
  const ToolIcon = tool.icon;

  return (
    <>
      <Card className="min-w-0">
        <CardHeader>
          <p className="text-[11px] text-muted-foreground">
            <button onClick={onBack} className="hover:text-foreground cursor-pointer">Dev Tools</button>
            <span className="mx-1.5 opacity-50">/</span>{cat.label}
          </p>
          <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2">
            <ToolIcon className="size-4 text-primary" />
            {tool.label}
            {tool.server && <Badge variant="secondary" className="gap-1"><Server className="size-3" /> Server</Badge>}
          </CardTitle>
          <CardDescription className="text-xs">{tool.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <ToolErrorBoundary key={tool.id}>
            <React.Suspense fallback={<p className="text-xs text-muted-foreground py-6 text-center">Loading tool…</p>}>
              {/* key resets tool state when switching, so each tool starts clean */}
              <Component key={tool.id} />
            </React.Suspense>
          </ToolErrorBoundary>
        </CardContent>
      </Card>
      {related.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">More {cat.label.toLowerCase()} tools</p>
          <div className="flex flex-wrap gap-1.5">
            {related.map(t => (
              <button key={t.id} onClick={() => onOpen(t.id)} className="h-7 px-2.5 rounded-md border border-border text-xs hover:border-primary/50 hover:bg-secondary cursor-pointer">
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
