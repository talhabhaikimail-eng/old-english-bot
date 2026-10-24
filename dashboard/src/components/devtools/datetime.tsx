import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cronstrue from 'cronstrue';
import {
  ArrowUpDown, Bell, BellOff, Clock, Pause, Play, Plus, RotateCcw, SkipForward, Trash2, Volume2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  MONO, FIXED, CopyButton, ErrorBox, InfoBox, FieldLabel, Segmented, Checkbox, NumberField, Stat,
} from './shared';
import { SearchSelect, usePersisted, fmtN, type PickOption } from './calculators';
import * as C from './lib/calc';

const pad2 = (n: number) => String(n).padStart(2, '0');
const longDate = (v: C.YMD) =>
  new Date(v.y, v.m - 1, v.d).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const localInputValue = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function Panel({ title, children, action, className }: { title: string; children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <Card size="sm" className={className}>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2 min-h-7">
          <p className="text-sm font-semibold">{title}</p>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** "in 3h 12m" / "5m ago" */
function relative(ms: number) {
  const abs = Math.abs(ms);
  const s = Math.round(abs / 1000);
  let txt: string;
  if (s < 60) txt = `${s}s`;
  else if (s < 3600) txt = `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  else if (s < 86400) txt = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  else txt = `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  return ms >= 0 ? `in ${txt}` : `${txt} ago`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Date difference
// ═════════════════════════════════════════════════════════════════════════════

export function DateDifference() {
  const t = C.todayYMD();
  const today = C.fmtYMD(t);
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(`${t.y}-12-31`);
  const [inclusive, setInclusive] = useState(false);
  const [holidayText, setHolidayText] = useState('');

  const [base, setBase] = useState(today);
  const [op, setOp] = useState<'add' | 'sub'>('add');
  const [amt, setAmt] = useState({ years: 0, months: 1, weeks: 2, days: 3 });
  const [bizDays, setBizDays] = useState(false);

  const a = C.parseYMD(start);
  const b = C.parseYMD(end);
  const holidays = useMemo(() => new Set(holidayText.split(/[\s,;]+/).filter(Boolean)), [holidayText]);
  const badHolidays = [...holidays].filter(h => !C.parseYMD(h));

  const diff = useMemo(() => {
    if (!a || !b) return null;
    const d = C.diffYMD(a, b);
    let days = C.dayNumber(b) - C.dayNumber(a);
    const sign = days < 0 ? -1 : 1;
    if (inclusive) days += sign;
    const lo = sign < 0 ? b : a;
    const hi = sign < 0 ? a : b;
    const business = C.businessDays(lo, hi, inclusive, holidays) * sign;
    const totalM = C.totalMonths(lo, hi);
    return { d, days, business, totalM, weekend: Math.abs(days) - Math.abs(business) };
  }, [start, end, inclusive, holidays]);

  const added = useMemo(() => {
    const p = C.parseYMD(base);
    if (!p) return null;
    const s = op === 'add' ? 1 : -1;
    let r = C.addMonths(p, s * (C.num(amt.years) * 12 + C.num(amt.months)));
    if (bizDays) r = C.addBusinessDays(C.addDays(r, s * C.num(amt.weeks) * 7), s * C.num(amt.days));
    else r = C.addDays(r, s * (C.num(amt.weeks) * 7 + C.num(amt.days)));
    return { r, delta: C.dayNumber(r) - C.dayNumber(p) };
  }, [base, op, amt, bizDays]);

  const unitField = (k: keyof typeof amt, label: string) => (
    <NumberField label={label} value={amt[k]} min={0} onChange={v => setAmt(x => ({ ...x, [k]: Math.trunc(v) }))} />
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Between two dates" action={
        <Button variant="ghost" size="xs" onClick={() => { setStart(end); setEnd(start); }}><ArrowUpDown /> Swap</Button>
      }>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <FieldLabel action={start !== today && <Button variant="ghost" size="xs" onClick={() => setStart(today)}>Today</Button>}>Start</FieldLabel>
            <Input type="date" value={start} onChange={e => setStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <FieldLabel action={end !== today && <Button variant="ghost" size="xs" onClick={() => setEnd(today)}>Today</Button>}>End</FieldLabel>
            <Input type="date" value={end} onChange={e => setEnd(e.target.value)} />
          </div>
        </div>
        <Checkbox checked={inclusive} onChange={setInclusive}>Include the end date (+1 day)</Checkbox>
        {!diff ? <ErrorBox message="Enter two valid dates." /> : (
          <>
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2.5">
              <p className="text-lg font-semibold tabular-nums">
                {diff.d.negative && '−'}{diff.d.years > 0 && <>{diff.d.years} <span className="text-xs font-normal text-muted-foreground">yr</span> </>}
                {(diff.d.years > 0 || diff.d.months > 0) && <>{diff.d.months} <span className="text-xs font-normal text-muted-foreground">mo</span> </>}
                {diff.d.days + (inclusive ? 1 : 0)} <span className="text-xs font-normal text-muted-foreground">days</span>
              </p>
              <p className="text-[11px] text-muted-foreground">{a && longDate(a)} → {b && longDate(b)}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Total days" value={fmtN(diff.days, 0)} />
              <Stat label="Weeks" value={`${fmtN(Math.trunc(diff.days / 7), 0)}`} hint={diff.days % 7 ? `+ ${Math.abs(diff.days % 7)} days` : 'exactly'} />
              <Stat label="Months" value={fmtN(diff.totalM, 0)} hint="whole months" />
              <Stat label="Business days" value={fmtN(diff.business, 0)} hint={`Mon–Fri${holidays.size ? `, minus holidays` : ''}`} />
              <Stat label="Weekend/holiday days" value={fmtN(diff.weekend, 0)} />
              <Stat label="Hours" value={fmtN(diff.days * 24, 0)} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Holidays to exclude from business days (optional)</FieldLabel>
              <Textarea className={cn(MONO, FIXED, 'h-16')} placeholder="2025-12-25, 2026-01-01" value={holidayText} onChange={e => setHolidayText(e.target.value)} />
              {badHolidays.length > 0 && <p className="text-[11px] text-destructive">Ignored (not YYYY-MM-DD): {badHolidays.join(', ')}</p>}
            </div>
          </>
        )}
      </Panel>

      <Panel title="Add or subtract">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-[10rem]">
            <FieldLabel action={base !== today && <Button variant="ghost" size="xs" onClick={() => setBase(today)}>Today</Button>}>Date</FieldLabel>
            <Input type="date" value={base} onChange={e => setBase(e.target.value)} />
          </div>
          <Segmented value={op} onChange={setOp} options={[{ value: 'add', label: '+ Add' }, { value: 'sub', label: '− Subtract' }]} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {unitField('years', 'Years')}{unitField('months', 'Months')}{unitField('weeks', 'Weeks')}{unitField('days', bizDays ? 'Business days' : 'Days')}
        </div>
        <Checkbox checked={bizDays} onChange={setBizDays}>Count days as business days (skip weekends)</Checkbox>
        {!added ? <ErrorBox message="Enter a valid date." /> : (
          <div className="rounded-md border border-border bg-secondary/40 px-3 py-2.5 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-lg font-semibold">{longDate(added.r)}</p>
              <p className="text-[11px] text-muted-foreground">{C.fmtYMD(added.r)} · {added.delta >= 0 ? '+' : '−'}{fmtN(Math.abs(added.delta), 0)} calendar days</p>
            </div>
            <CopyButton value={C.fmtYMD(added.r)} />
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">Months are added first and clamp to the month's last day (Jan 31 + 1 month = Feb 28/29), then weeks and days.</p>
      </Panel>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Timezone converter
// ═════════════════════════════════════════════════════════════════════════════

const FALLBACK_ZONES = [
  'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Africa/Cairo', 'Africa/Lagos', 'Asia/Dubai',
  'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
  'Pacific/Auckland', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu',
];

function allZones(): string[] {
  try {
    const z = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (z && z.length) return z.includes('UTC') ? z : ['UTC', ...z];
  } catch { /* ignore */ }
  return FALLBACK_ZONES;
}

const localZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
const city = (z: string) => z.split('/').pop()!.replace(/_/g, ' ');
const region = (z: string) => (z.includes('/') ? z.split('/').slice(0, -1).join(' / ').replace(/_/g, ' ') : 'Coordinated Universal Time');

function zoneAbbr(zone: string, t: number) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(t));
    return p.find(x => x.type === 'timeZoneName')?.value ?? '';
  } catch { return ''; }
}

function validZone(z: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

export function TimezoneConverter() {
  const zones = useMemo(allZones, []);
  const here = useMemo(localZone, []);
  const [src, setSrc] = usePersisted('devtools.tz.source', here, v => typeof v === 'string' && validZone(v));
  const [targets, setTargets] = usePersisted<string[]>(
    'devtools.tz.targets',
    () => ['UTC', 'America/New_York', 'Europe/London', 'Asia/Karachi', 'Asia/Tokyo', 'America/Los_Angeles'].filter(z => z !== here),
    v => Array.isArray(v) && v.every(x => typeof x === 'string'),
  );
  const [h24, setH24] = usePersisted('devtools.tz.h24', true, v => typeof v === 'boolean');
  const nowIn = useCallback((zone: string) => {
    const w = C.wallTime(zone, Date.now());
    return `${w.y}-${pad2(w.m)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}`;
  }, []);
  const [dt, setDt] = useState(() => nowIn(src));
  const [adding, setAdding] = useState('');

  const options = useMemo<PickOption[]>(() => {
    const t = Date.now();
    return zones.map(z => ({ value: z, label: z.replace(/_/g, ' '), hint: C.formatOffset(C.zoneOffset(z, t)).replace('UTC', '') }));
  }, [zones]);

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dt);
  const parts = m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] } : null;
  const instant = parts ? C.zonedToUtc(parts.y, parts.mo, parts.d, parts.h, parts.mi, src) : NaN;
  const srcWall = Number.isFinite(instant) ? C.wallTime(src, instant) : null;
  const gap = parts && srcWall && (srcWall.h !== parts.h || srcWall.mi !== parts.mi);

  const changeSrc = (z: string) => {
    // Keep the same instant when switching the source zone.
    if (Number.isFinite(instant)) {
      const w = C.wallTime(z, instant);
      setDt(`${w.y}-${pad2(w.m)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}`);
    }
    setSrc(z);
  };

  const fmtTime = (w: { h: number; mi: number }) => {
    if (h24) return `${pad2(w.h)}:${pad2(w.mi)}`;
    const h = w.h % 12 || 12;
    return `${h}:${pad2(w.mi)} ${w.h < 12 ? 'AM' : 'PM'}`;
  };

  const rows = useMemo(() => {
    if (!Number.isFinite(instant) || !parts) return [];
    const srcDay = C.dayNumber({ y: parts.y, m: parts.mo, d: parts.d });
    const srcOff = C.zoneOffset(src, instant);
    // Map each hour of the source day to the target's local hour (meeting planner strip).
    const hourInstants = Array.from({ length: 24 }, (_, h) => C.zonedToUtc(parts.y, parts.mo, parts.d, h, 0, src));
    return [src, ...targets.filter(z => z !== src)].map(z => {
      const w = C.wallTime(z, instant);
      const off = C.zoneOffset(z, instant);
      const shift = C.dayNumber({ y: w.y, m: w.m, d: w.d }) - srcDay;
      return {
        zone: z, w, off, shift, rel: off - srcOff, abbr: zoneAbbr(z, instant), dst: C.dstInfo(z, instant),
        strip: hourInstants.map(t => C.wallTime(z, t).h),
        weekday: new Date(Date.UTC(w.y, w.m - 1, w.d)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      };
    });
  }, [instant, src, targets, parts?.y, parts?.mo, parts?.d]);

  const summary = rows.map(r => `${city(r.zone)}: ${r.weekday}, ${fmtTime(r.w)} (${C.formatOffset(r.off)})`).join('\n');

  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] items-end">
            <div className="space-y-1.5">
              <FieldLabel>Date & time</FieldLabel>
              <Input type="datetime-local" value={dt} onChange={e => setDt(e.target.value)} />
            </div>
            <div className="space-y-1.5 min-w-0">
              <FieldLabel>In time zone</FieldLabel>
              <SearchSelect value={src} options={options} onChange={changeSrc} />
            </div>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" className="h-8" onClick={() => setDt(nowIn(src))}><Clock /> Now</Button>
              {src !== here && <Button variant="ghost" size="sm" className="h-8" onClick={() => changeSrc(here)} title={here}>My zone</Button>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={h24 ? '24' : '12'} onChange={v => setH24(v === '24')} options={[{ value: '24', label: '24h' }, { value: '12', label: '12h' }]} />
            <div className="w-56 max-w-full">
              <SearchSelect value={adding} options={options.filter(o => !targets.includes(o.value) && o.value !== src)} placeholder="Add time zone…"
                renderValue={() => <span className="text-muted-foreground flex items-center gap-1"><Plus className="size-3.5" /> Add time zone…</span>}
                onChange={z => { setTargets(t => [...t, z]); setAdding(''); }} />
            </div>
            <CopyButton value={summary} label="Copy all" />
          </div>
          {!parts && <ErrorBox message="Pick a date and time." />}
          {gap && <InfoBox>That local time doesn't exist in {src} (DST change) — showing {fmtTime(srcWall!)} instead.</InfoBox>}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {rows.map((r, i) => (
          <Card key={r.zone} size="sm" className={cn(i === 0 && 'border-primary/50')}>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{city(r.zone)} {i === 0 && <Badge variant="outline" className="ml-1 align-middle">source</Badge>}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{region(r.zone)} · {r.abbr} · {C.formatOffset(r.off)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xl font-semibold tabular-nums leading-tight">{fmtTime(r.w)}</p>
                  <p className="text-[11px] text-muted-foreground">{r.weekday}</p>
                </div>
                {i > 0 && <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setTargets(t => t.filter(z => z !== r.zone))}><X /></Button>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {i > 0 && <Badge variant="secondary">{r.rel === 0 ? 'same time' : `${r.rel > 0 ? '+' : '−'}${fmtN(Math.abs(r.rel) / 60, 2)}h`}</Badge>}
                {r.shift !== 0 && <Badge variant={r.shift > 0 ? 'default' : 'destructive'}>{r.shift > 0 ? 'next day' : 'previous day'}</Badge>}
                {r.dst.observes && <Badge variant="outline">{r.dst.active ? 'DST in effect' : 'standard time (observes DST)'}</Badge>}
              </div>
              <div className="flex gap-px" title="Each cell is one hour of the source day; green = 9–17 working hours here">
                {r.strip.map((h, k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => parts && setDt(`${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)}T${pad2(k)}:${pad2(parts.mi)}`)}
                    className={cn(
                      'flex-1 h-5 min-w-0 text-[9px] leading-5 text-center tabular-nums cursor-pointer first:rounded-l last:rounded-r',
                      h >= 9 && h < 17 ? 'bg-primary/60 text-primary-foreground' : h >= 7 && h < 22 ? 'bg-primary/20' : 'bg-secondary text-muted-foreground',
                      parts && k === parts.h && 'ring-2 ring-foreground ring-inset',
                    )}
                  >
                    <span className="hidden sm:inline">{h}</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">Click an hour in any strip to move the source time. Zones and format are remembered in this browser.</p>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Cron parser
// ═════════════════════════════════════════════════════════════════════════════

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Every 5 min', expr: '*/5 * * * *' },
  { label: 'Every 15 min, work hours', expr: '*/15 9-17 * * MON-FRI' },
  { label: 'Hourly', expr: '@hourly' },
  { label: 'Daily 02:30', expr: '30 2 * * *' },
  { label: 'Weekdays 09:00', expr: '0 9 * * 1-5' },
  { label: 'Mondays 08:00', expr: '0 8 * * MON' },
  { label: '1st of month', expr: '0 0 1 * *' },
  { label: 'Quarterly', expr: '0 0 1 JAN,APR,JUL,OCT *' },
  { label: 'Every 30 s', expr: '*/30 * * * * *' },
  { label: 'Yearly', expr: '@yearly' },
];

export function CronParser() {
  const [expr, setExpr] = useState('*/15 9-17 * * MON-FRI');
  const [mode, setMode] = useState<'local' | 'utc'>('local');
  const [count, setCount] = useState(10);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  const parsed = useMemo(() => {
    try {
      const sched = C.parseCron(expr);
      let description = '';
      try {
        const forDesc = sched.hasSeconds ? sched.normalized : sched.normalized.split(' ').slice(1).join(' ');
        description = cronstrue.toString(forDesc, { use24HourTimeFormat: true, throwExceptionOnParseError: true, verbose: false });
      } catch { description = ''; }
      return { sched, description, error: '' };
    } catch (e) {
      return { sched: null, description: '', error: (e as Error).message };
    }
  }, [expr]);

  const runs = useMemo(() => (parsed.sched ? C.cronNext(parsed.sched, new Date(now), count, mode === 'utc') : []), [parsed.sched, now, count, mode]);
  const tzName = useMemo(localZone, []);

  const s = parsed.sched;
  const fieldRows: [string, string, string][] = s ? [
    ...(s.hasSeconds ? [['Second', s.normalized.split(' ')[0], C.describeValues(s.seconds, 'second')] as [string, string, string]] : []),
    ['Minute', s.normalized.split(' ')[1], C.describeValues(s.minutes, 'minute')],
    ['Hour', s.normalized.split(' ')[2], C.describeValues(s.hours, 'hour')],
    ['Day of month', s.normalized.split(' ')[3], C.describeValues(s.doms, 'dom')],
    ['Month', s.normalized.split(' ')[4], C.describeValues(s.months, 'month')],
    ['Day of week', s.normalized.split(' ')[5], C.describeValues(s.dows, 'dow')],
  ] : [];

  const fmtLocal = (d: Date) => d.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: s?.hasSeconds ? '2-digit' : undefined, hourCycle: 'h23' });

  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input className={cn(MONO, 'text-sm h-9')} value={expr} onChange={e => setExpr(e.target.value)} spellCheck={false} placeholder="*/5 * * * *" aria-label="Cron expression" />
            <CopyButton value={expr} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CRON_PRESETS.map(p => (
              <Button key={p.expr} variant={expr === p.expr ? 'default' : 'outline'} size="xs" onClick={() => setExpr(p.expr)} title={p.expr}>{p.label}</Button>
            ))}
          </div>
          {parsed.error ? <ErrorBox message={parsed.error} /> : (
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2.5">
              <p className="text-base font-medium">{parsed.description || 'Valid expression'}</p>
              {s && s.domRestricted && s.dowRestricted && (
                <p className="text-[11px] text-muted-foreground mt-1">Both day-of-month and day-of-week are set — standard cron runs when <b>either</b> matches.</p>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Format: <code>minute hour day-of-month month day-of-week</code>, or 6 fields with seconds first. Supports <code>* , - /</code>, names (JAN, MON) and @hourly/@daily/@weekly/@monthly/@yearly.
          </p>
        </CardContent>
      </Card>

      {s && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <Panel title="Fields">
            <div className="rounded-md border border-border divide-y divide-border">
              {fieldRows.map(([name, raw, vals]) => (
                <div key={name} className="px-3 py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{name}</span>
                    <code className={MONO}>{raw}</code>
                  </div>
                  <p className="break-words">{vals}</p>
                </div>
              ))}
            </div>
          </Panel>
          <Panel
            title="Next runs"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Segmented value={mode} onChange={setMode} options={[{ value: 'local', label: 'Local time' }, { value: 'utc', label: 'UTC' }]} />
                <select className="h-8 rounded-md border border-input bg-transparent px-2 text-xs" value={count} onChange={e => setCount(Number(e.target.value))}>
                  {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            }
          >
            <p className="text-[11px] text-muted-foreground">
              Schedule evaluated in {mode === 'utc' ? 'UTC' : `your local zone (${tzName})`} — match this to the server running the job.
            </p>
            {runs.length === 0 ? <InfoBox>No runs found in the next 8 years.</InfoBox> : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs tabular-nums">
                  <thead className="bg-secondary text-muted-foreground">
                    <tr><th className="px-2.5 py-1.5 text-left font-medium">#</th><th className="px-2.5 py-1.5 text-left font-medium">Local ({tzName})</th><th className="px-2.5 py-1.5 text-left font-medium">UTC</th><th className="px-2.5 py-1.5 text-right font-medium">When</th></tr>
                  </thead>
                  <tbody>
                    {runs.map((d, i) => (
                      <tr key={d.getTime()} className="border-t border-border">
                        <td className="px-2.5 py-1 text-muted-foreground">{i + 1}</td>
                        <td className="px-2.5 py-1 whitespace-nowrap">{fmtLocal(d)}</td>
                        <td className="px-2.5 py-1 whitespace-nowrap font-mono">{d.toISOString().replace('T', ' ').replace(s.hasSeconds ? '.000Z' : ':00.000Z', 'Z')}</td>
                        <td className="px-2.5 py-1 text-right whitespace-nowrap text-muted-foreground">{relative(d.getTime() - now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Countdown
// ═════════════════════════════════════════════════════════════════════════════

interface Countdown { id: string; label: string; target: string; created: number }

const nextNewYear = () => `${new Date().getFullYear() + 1}-01-01T00:00`;

function splitMs(ms: number) {
  const s = Math.floor(Math.abs(ms) / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

export function CountdownTimer() {
  const [items, setItems] = usePersisted<Countdown[]>(
    'devtools.countdowns',
    () => [{ id: 'newyear', label: `New Year ${new Date().getFullYear() + 1}`, target: nextNewYear(), created: Date.now() }],
    v => Array.isArray(v) && v.every(x => x && typeof x.target === 'string' && typeof x.label === 'string'),
  );
  const [selected, setSelected] = useState<string>(() => items[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [target, setTarget] = useState(() => {
    const d = new Date(Date.now() + 86400_000);
    d.setHours(9, 0, 0, 0);
    return localInputValue(d);
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);

  const current = items.find(x => x.id === selected) ?? items[0];
  const targetMs = (c: Countdown) => new Date(c.target).getTime();
  const addErr = !target || Number.isNaN(new Date(target).getTime()) ? 'Pick a date and time.' : '';

  const add = () => {
    if (addErr) return;
    const c: Countdown = { id: Math.random().toString(36).slice(2, 10), label: label.trim() || new Date(target).toLocaleString(), target, created: Date.now() };
    setItems(xs => [...xs, c]);
    setSelected(c.id);
    setLabel('');
  };
  const quick = (ms: number, l: string) => { setTarget(localInputValue(new Date(Date.now() + ms))); setLabel(l); };

  const big = current ? targetMs(current) - now : 0;
  const parts = splitMs(big);
  const progress = current ? Math.min(1, Math.max(0, (now - current.created) / Math.max(1, targetMs(current) - current.created))) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
      <div className="space-y-4 min-w-0">
        {current ? (
          <Card size="sm">
            <CardContent className="space-y-4 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-semibold truncate">{current.label}</p>
                  <p className="text-xs text-muted-foreground">{new Date(current.target).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}</p>
                </div>
                {big <= 0 ? <Badge>Reached</Badge> : <Badge variant="secondary">{relative(big)}</Badge>}
              </div>
              <div className="grid grid-cols-4 gap-2">
                {([['days', parts.d], ['hours', parts.h], ['minutes', parts.m], ['seconds', parts.s]] as const).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-border bg-secondary/40 py-3 text-center">
                    <p className="text-2xl sm:text-4xl font-semibold tabular-nums">{k === 'days' ? v : pad2(v)}</p>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{k}</p>
                  </div>
                ))}
              </div>
              {big <= 0
                ? <p className="text-xs text-muted-foreground text-center">Reached {relative(big)} — time since shown above.</p>
                : (
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-secondary overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${progress * 100}%` }} /></div>
                    <p className="text-[11px] text-muted-foreground text-right">{fmtN(progress * 100, 1)}% of the wait since it was added · {fmtN(big / 3_600_000, 1)} hours left</p>
                  </div>
                )}
            </CardContent>
          </Card>
        ) : <InfoBox>No countdowns yet — add one.</InfoBox>}

        {items.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {items.map(c => {
              const left = targetMs(c) - now;
              const p = splitMs(left);
              return (
                <div key={c.id} className={cn('flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer', c.id === current?.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/40')}
                  onClick={() => setSelected(c.id)}>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{c.label}</p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {left <= 0 ? `done · ${relative(left)}` : `${p.d}d ${pad2(p.h)}:${pad2(p.m)}:${pad2(p.s)}`}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon-xs" title="Delete" onClick={e => { e.stopPropagation(); setItems(xs => xs.filter(x => x.id !== c.id)); }}><Trash2 /></Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Panel title="New countdown">
        <div className="space-y-1.5"><FieldLabel>Label</FieldLabel><Input value={label} placeholder="Launch day" onChange={e => setLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} /></div>
        <div className="space-y-1.5"><FieldLabel>Date & time (local)</FieldLabel><Input type="datetime-local" value={target} onChange={e => setTarget(e.target.value)} /></div>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="xs" onClick={() => quick(25 * 60_000, '25 minutes')}>+25 min</Button>
          <Button variant="outline" size="xs" onClick={() => quick(3600_000, 'One hour')}>+1 h</Button>
          <Button variant="outline" size="xs" onClick={() => {
            const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
            setTarget(localInputValue(d)); setLabel('Tomorrow 9:00');
          }}>Tomorrow 9:00</Button>
          <Button variant="outline" size="xs" onClick={() => {
            const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); d.setHours(0, 0, 0, 0);
            setTarget(localInputValue(d)); setLabel('Weekend');
          }}>Weekend</Button>
          <Button variant="outline" size="xs" onClick={() => { setTarget(nextNewYear()); setLabel(`New Year ${new Date().getFullYear() + 1}`); }}>New Year</Button>
        </div>
        {addErr && <ErrorBox message={addErr} />}
        <Button onClick={add} disabled={!!addErr}><Plus /> Add countdown</Button>
        <p className="text-[11px] text-muted-foreground">Saved in this browser.</p>
      </Panel>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Pomodoro
// ═════════════════════════════════════════════════════════════════════════════

type Phase = 'work' | 'short' | 'long';
interface PomoSettings { work: number; short: number; long: number; every: number; autoStart: boolean; sound: boolean; notify: boolean }
const DEFAULT_POMO: PomoSettings = { work: 25, short: 5, long: 15, every: 4, autoStart: false, sound: true, notify: false };
const PHASE_LABEL: Record<Phase, string> = { work: 'Focus', short: 'Short break', long: 'Long break' };

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
};

export function PomodoroTimer() {
  const [cfg, setCfg] = usePersisted<PomoSettings>('devtools.pomodoro.settings', DEFAULT_POMO, v => !!v && typeof v === 'object' && typeof (v as PomoSettings).work === 'number');
  const todayKey = C.fmtYMD(C.todayYMD());
  const [stats, setStats] = usePersisted<{ date: string; sessions: number; minutes: number }>('devtools.pomodoro.stats', { date: todayKey, sessions: 0, minutes: 0 }, v => !!v && typeof v === 'object');
  const today = stats.date === todayKey ? stats : { date: todayKey, sessions: 0, minutes: 0 };

  const dur = useCallback((p: Phase) => Math.max(1, Math.min(240, C.num(p === 'work' ? cfg.work : p === 'short' ? cfg.short : cfg.long, 1))) * 60_000, [cfg]);
  const [phase, setPhase] = useState<Phase>('work');
  const [running, setRunning] = useState(false);
  const [endAt, setEndAt] = useState(0);
  const [remaining, setRemaining] = useState(() => dur('work'));
  const [cycle, setCycle] = useState(0); // completed focus sessions in the current set
  const [started, setStarted] = useState(false);
  const [permission, setPermission] = useState<string>(() => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'));
  const audio = useRef<AudioContext | null>(null);

  // Settings changed while idle → reset the clock to the new length.
  useEffect(() => { if (!running && !started) setRemaining(dur(phase)); }, [cfg.work, cfg.short, cfg.long, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const beep = useCallback(() => {
    if (!cfg.sound) return;
    try {
      const ctx = audio.current ?? new AudioContext();
      audio.current = ctx;
      [0, 0.25, 0.5].forEach((t, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = i === 2 ? 1046 : 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.2);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.22);
      });
    } catch { /* audio unavailable */ }
  }, [cfg.sound]);

  const notify = useCallback((title: string, body: string) => {
    if (!cfg.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: 'devtools-pomodoro' }); } catch { /* ignore */ }
  }, [cfg.notify]);

  const advance = useCallback((completed: boolean) => {
    let next: Phase;
    let nextCycle = cycle;
    if (phase === 'work') {
      if (completed) {
        nextCycle = cycle + 1;
        setStats(st => {
          const base = st.date === todayKey ? st : { date: todayKey, sessions: 0, minutes: 0 };
          return { ...base, sessions: base.sessions + 1, minutes: base.minutes + Math.round(dur('work') / 60_000) };
        });
      }
      next = nextCycle > 0 && nextCycle % Math.max(1, cfg.every) === 0 && completed ? 'long' : 'short';
    } else {
      next = 'work';
      if (phase === 'long') nextCycle = 0;
    }
    setCycle(nextCycle);
    setPhase(next);
    const d = dur(next);
    setRemaining(d);
    if (completed) {
      beep();
      notify(phase === 'work' ? 'Focus session done' : 'Break over', next === 'work' ? 'Time to focus.' : `Take a ${next === 'long' ? 'long' : 'short'} break.`);
    }
    if (completed && cfg.autoStart) { setEndAt(Date.now() + d); setRunning(true); setStarted(true); }
    else { setRunning(false); setStarted(false); }
  }, [beep, cfg.autoStart, cfg.every, cycle, dur, notify, phase, setStats, todayKey]);

  // Tick against a wall-clock deadline so background-tab throttling doesn't drift the timer.
  useEffect(() => {
    if (!running) return;
    let fired = false;
    const tick = () => {
      if (fired) return;
      const left = endAt - Date.now();
      if (left <= 0) { fired = true; clearInterval(t); advance(true); }
      else setRemaining(left);
    };
    const t = setInterval(tick, 250);
    tick();
    return () => clearInterval(t);
  }, [running, endAt, advance]);

  // Page title shows the remaining time while running.
  const originalTitle = useRef(document.title);
  useEffect(() => {
    if (running) document.title = `${mmss(remaining)} · ${PHASE_LABEL[phase]}`;
    else document.title = originalTitle.current;
  }, [running, remaining, phase]);
  useEffect(() => () => { document.title = originalTitle.current; }, []);
  useEffect(() => () => { audio.current?.close().catch(() => {}); }, []);

  const start = () => {
    // Create/resume audio inside the click so browsers allow playback later.
    if (cfg.sound) {
      try { audio.current ??= new AudioContext(); audio.current.resume().catch(() => {}); } catch { /* ignore */ }
    }
    setEndAt(Date.now() + remaining);
    setRunning(true);
    setStarted(true);
  };
  const pause = () => { setRunning(false); setRemaining(Math.max(0, endAt - Date.now())); };
  const reset = () => { setRunning(false); setStarted(false); setRemaining(dur(phase)); };
  const switchPhase = (p: Phase) => { setRunning(false); setStarted(false); setPhase(p); setRemaining(dur(p)); };

  // Space toggles start/pause when not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key !== ' ' || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON' || el.isContentEditable))) return;
      e.preventDefault();
      if (running) pause(); else start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggleNotify = async (on: boolean) => {
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { setPermission(await Notification.requestPermission()); } catch { /* ignore */ }
    }
    setCfg(c => ({ ...c, notify: on }));
  };

  const total = dur(phase);
  const frac = Math.min(1, Math.max(0, 1 - remaining / total));
  const R = 88;
  const CIRC = 2 * Math.PI * R;
  const color = phase === 'work' ? 'var(--primary)' : '#60a5fa';
  const every = Math.max(1, Math.min(12, Math.round(C.num(cfg.every, 4))));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
      <Card size="sm">
        <CardContent className="flex flex-col items-center gap-4 py-2">
          <Segmented value={phase} onChange={switchPhase} options={[{ value: 'work', label: 'Focus' }, { value: 'short', label: 'Short break' }, { value: 'long', label: 'Long break' }]} />
          <div className="relative w-56 h-56 max-w-full">
            <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90">
              <circle cx="100" cy="100" r={R} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth={10} />
              <circle cx="100" cy="100" r={R} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round"
                strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - frac)} style={{ transition: 'stroke-dashoffset 0.25s linear' }} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <p className="text-5xl font-semibold tabular-nums">{mmss(remaining)}</p>
              <p className="text-xs text-muted-foreground mt-1">{PHASE_LABEL[phase]}{running ? '' : started ? ' · paused' : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5" title="Focus sessions in this set">
            {Array.from({ length: every }, (_, i) => (
              <span key={i} className={cn('size-2.5 rounded-full border border-primary', i < cycle % every || (cycle > 0 && cycle % every === 0 && phase === 'long') ? 'bg-primary' : '')} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" title="Reset" onClick={reset}><RotateCcw /></Button>
            {running
              ? <Button size="lg" className="w-32" onClick={pause}><Pause /> Pause</Button>
              : <Button size="lg" className="w-32" onClick={start}><Play /> {started ? 'Resume' : 'Start'}</Button>}
            <Button variant="outline" size="icon" title="Skip to next phase" onClick={() => advance(false)}><SkipForward /></Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Space to start/pause · the tab title shows the time left while running.</p>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Sessions today" value={today.sessions} />
          <Stat label="Focus today" value={`${Math.floor(today.minutes / 60)}h ${today.minutes % 60}m`} />
        </div>
        <Panel title="Settings" action={<Button variant="ghost" size="xs" onClick={() => setCfg(DEFAULT_POMO)}>Defaults</Button>}>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Focus" value={cfg.work} onChange={v => setCfg(c => ({ ...c, work: v }))} min={1} max={240} suffix="min" />
            <NumberField label="Short break" value={cfg.short} onChange={v => setCfg(c => ({ ...c, short: v }))} min={1} max={60} suffix="min" />
            <NumberField label="Long break" value={cfg.long} onChange={v => setCfg(c => ({ ...c, long: v }))} min={1} max={120} suffix="min" />
            <NumberField label="Long break every" value={cfg.every} onChange={v => setCfg(c => ({ ...c, every: v }))} min={1} max={12} suffix="sessions" />
          </div>
          <div className="flex flex-col gap-2">
            <Checkbox checked={cfg.autoStart} onChange={v => setCfg(c => ({ ...c, autoStart: v }))}>Auto-start the next phase</Checkbox>
            <Checkbox checked={cfg.sound} onChange={v => setCfg(c => ({ ...c, sound: v }))}><span className="inline-flex items-center gap-1"><Volume2 className="size-3.5" /> Sound</span></Checkbox>
            <Checkbox checked={cfg.notify} onChange={toggleNotify}>
              <span className="inline-flex items-center gap-1">{cfg.notify ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />} Desktop notifications</span>
            </Checkbox>
            {cfg.notify && permission === 'denied' && <p className="text-[11px] text-destructive">Notifications are blocked for this site in your browser settings.</p>}
            {permission === 'unsupported' && <p className="text-[11px] text-muted-foreground">This browser doesn't support notifications.</p>}
            <Button variant="outline" size="xs" className="self-start" onClick={beep} disabled={!cfg.sound}>Test sound</Button>
          </div>
          {started && <p className="text-[11px] text-muted-foreground">New lengths apply from the next phase (or press reset).</p>}
        </Panel>
      </div>
    </div>
  );
}
