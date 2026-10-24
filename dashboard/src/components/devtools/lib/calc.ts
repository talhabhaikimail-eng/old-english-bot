// Pure, React-free logic for the Calculators and Date & Time tools. No path aliases here —
// this module is unit-tested directly with tsx (see calc.test.ts).

// ═════════════════════════════════════════════════════════════════════════════
// Number helpers
// ═════════════════════════════════════════════════════════════════════════════

/** Trim binary floating-point noise (0.1 + 0.2 → 0.3). */
export function clean(n: number, sig = 12): number {
  if (!Number.isFinite(n) || n === 0) return n;
  return Number(n.toPrecision(sig));
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Finite number or fallback. */
export const num = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);

// ═════════════════════════════════════════════════════════════════════════════
// Safe expression evaluator (Basic Calculator) — recursive descent, no eval.
// Grammar:
//   expr    := term (('+'|'-') term)*
//   term    := unary (('*'|'/'|'mod') unary | implicit-mul unary)*
//   unary   := ('-'|'+') unary | power
//   power   := postfix ('^' unary)?            (right-assoc, binds tighter than unary minus on the left: -2^2 = -4)
//   postfix := primary ('%' | '!')*
//   primary := number | constant | func '(' expr ')' | '(' expr ')'
// Percent: "a + b%" / "a - b%" mean a ± (a·b/100) (calculator convention); elsewhere b% = b/100.
// ═════════════════════════════════════════════════════════════════════════════

type Tok =
  | { t: 'num'; v: number; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'id'; v: string; pos: number }
  | { t: '('; pos: number }
  | { t: ')'; pos: number };

type Node =
  | { k: 'num'; v: number }
  | { k: 'neg'; a: Node }
  | { k: 'pct'; a: Node }
  | { k: 'fact'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'fn'; name: string; a: Node };

export class CalcError extends Error {}

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  sin: x => Math.sin(x), cos: x => Math.cos(x), tan: x => Math.tan(x),
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp,
  round: Math.round, floor: Math.floor, ceil: Math.ceil,
};
const CONSTS: Record<string, number> = { pi: Math.PI, 'π': Math.PI, e: Math.E };

function tokenize(src: string): Tok[] {
  const s = src
    .replace(/×/g, '*').replace(/[÷∶]/g, '/').replace(/[−–]/g, '-').replace(/√/g, ' sqrt ')
    .replace(/,/g, ''); // thousands separators
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) throw new CalcError(`Invalid number at position ${i + 1}`);
      if (/^\d*\.\d*\./.test(s.slice(i))) throw new CalcError(`Invalid number at position ${i + 1}`);
      out.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/^%!'.includes(c)) {
      if (c === '*' && s[i + 1] === '*') { out.push({ t: 'op', v: '^', pos: i }); i += 2; continue; }
      out.push({ t: 'op', v: c, pos: i }); i++; continue;
    }
    if (c === '(') { out.push({ t: '(', pos: i }); i++; continue; }
    if (c === ')') { out.push({ t: ')', pos: i }); i++; continue; }
    const m = /^([a-zπ][a-z0-9]*)/i.exec(s.slice(i));
    if (m) {
      const w = m[1].toLowerCase();
      if (w === 'mod') out.push({ t: 'op', v: 'mod', pos: i });
      else out.push({ t: 'id', v: w, pos: i });
      i += m[1].length;
      continue;
    }
    throw new CalcError(`Unexpected "${c}" at position ${i + 1}`);
  }
  return out;
}

function parseExpr(tokens: Tok[]): Node {
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v: string) => { const t = tokens[p]; return t?.t === 'op' && t.v === v; };

  function expr(): Node {
    let n = term();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[p++] as { v: string }).v;
      n = { k: 'bin', op, a: n, b: term() };
    }
    return n;
  }
  function startsPrimary(t: Tok | undefined) {
    return !!t && (t.t === 'num' || t.t === 'id' || t.t === '(');
  }
  function term(): Node {
    let n = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('mod')) {
        const op = (tokens[p++] as { v: string }).v;
        n = { k: 'bin', op, a: n, b: unary() };
      } else if (startsPrimary(peek())) {
        n = { k: 'bin', op: '*', a: n, b: unary() }; // implicit multiplication: 2(3), 2pi, (1)(2)
      } else break;
    }
    return n;
  }
  function unary(): Node {
    if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power(): Node {
    const base = postfix();
    if (isOp('^')) { p++; return { k: 'bin', op: '^', a: base, b: unary() }; }
    return base;
  }
  function postfix(): Node {
    let n = primary();
    while (isOp('%') || isOp('!')) {
      const op = (tokens[p++] as { v: string }).v;
      n = op === '%' ? { k: 'pct', a: n } : { k: 'fact', a: n };
    }
    return n;
  }
  function primary(): Node {
    const t = tokens[p];
    if (!t) throw new CalcError('Incomplete expression');
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === '(') {
      p++;
      const n = expr();
      // Auto-close: a missing trailing ")" is tolerated, like most handheld calculators.
      if (tokens[p]?.t === ')') p++;
      else if (p < tokens.length) throw new CalcError(`Expected ")" at position ${(tokens[p] as Tok).pos + 1}`);
      return n;
    }
    if (t.t === 'id') {
      p++;
      if (t.v in FUNCS) {
        if (tokens[p]?.t !== '(') {
          // sqrt 9 → sqrt(9)
          return { k: 'fn', name: t.v, a: postfix() };
        }
        return { k: 'fn', name: t.v, a: primary() };
      }
      if (t.v in CONSTS) return { k: 'num', v: CONSTS[t.v] };
      throw new CalcError(`Unknown name "${t.v}"`);
    }
    if (t.t === ')') throw new CalcError(`Unexpected ")" at position ${t.pos + 1}`);
    throw new CalcError(`Unexpected "${t.v}" at position ${t.pos + 1}`);
  }

  if (!tokens.length) throw new CalcError('Empty expression');
  const n = expr();
  if (p < tokens.length) {
    const t = tokens[p];
    throw new CalcError(`Unexpected ${t.t === ')' ? '")"' : `"${'v' in t ? t.v : t.t}"`} at position ${t.pos + 1}`);
  }
  return n;
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('Factorial needs a non-negative integer');
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

export interface EvalOptions { degrees?: boolean }

function evalNode(n: Node, o: EvalOptions): number {
  switch (n.k) {
    case 'num': return n.v;
    case 'neg': return -evalNode(n.a, o);
    case 'pct': return evalNode(n.a, o) / 100;
    case 'fact': return factorial(evalNode(n.a, o));
    case 'fn': {
      let x = evalNode(n.a, o);
      const trig = ['sin', 'cos', 'tan'].includes(n.name);
      if (trig && o.degrees) x = (x * Math.PI) / 180;
      let r = FUNCS[n.name](x);
      if (['asin', 'acos', 'atan'].includes(n.name) && o.degrees) r = (r * 180) / Math.PI;
      // sin(180°) should be 0, not 1.2e-16.
      if (trig && Math.abs(r) < 1e-12) r = 0;
      return r;
    }
    case 'bin': {
      const a = evalNode(n.a, o);
      // a ± b% → a ± a·b/100
      if ((n.op === '+' || n.op === '-') && n.b.k === 'pct') {
        const b = (a * evalNode(n.b.a, o)) / 100;
        return n.op === '+' ? a + b : a - b;
      }
      const b = evalNode(n.b, o);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw new CalcError('Division by zero');
          return a / b;
        case 'mod':
          if (b === 0) throw new CalcError('Division by zero');
          return a % b;
        case '^': return Math.pow(a, b);
      }
    }
  }
  throw new CalcError('Bad expression');
}

/** Evaluate a calculator expression. Throws CalcError with a readable message. */
export function evaluate(src: string, opts: EvalOptions = {}): number {
  const v = evalNode(parseExpr(tokenize(src)), opts);
  if (Number.isNaN(v)) throw new CalcError('Result is not a number');
  if (!Number.isFinite(v)) throw new CalcError('Result is too large');
  return clean(v);
}

/** Format a calculator result: grouped thousands, up to 12 significant digits, exponent for huge/tiny. */
export function formatCalc(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e15 || a < 1e-9)) return v.toExponential(8).replace(/\.?0+e/, 'e');
  return v.toLocaleString('en-US', { maximumSignificantDigits: 15, maximumFractionDigits: 12 });
}

// ═════════════════════════════════════════════════════════════════════════════
// Percentages, discounts, tips
// ═════════════════════════════════════════════════════════════════════════════

export const percentOf = (pct: number, of: number) => (pct / 100) * of;
export const whatPercent = (part: number, whole: number) => (whole === 0 ? NaN : (part / whole) * 100);
export const percentChange = (from: number, to: number) => (from === 0 ? NaN : ((to - from) / Math.abs(from)) * 100);
/** Symmetric percentage difference |a−b| / avg(a,b). */
export const percentDifference = (a: number, b: number) => (a + b === 0 ? NaN : (Math.abs(a - b) / ((a + b) / 2)) * 100);

export interface DiscountStep { kind: 'percent' | 'fixed'; value: number }
export interface DiscountResult {
  steps: { label: string; amount: number; after: number }[];
  subtotal: number; discount: number; effectivePct: number; tax: number; total: number;
}

/** Apply discounts sequentially (stacked), then tax on the discounted price. */
export function applyDiscounts(price: number, steps: DiscountStep[], taxPct = 0): DiscountResult {
  let cur = Math.max(0, num(price));
  const out: DiscountResult['steps'] = [];
  for (const s of steps) {
    const v = num(s.value);
    const amt = Math.min(cur, Math.max(0, s.kind === 'percent' ? (cur * v) / 100 : v));
    cur -= amt;
    out.push({ label: s.kind === 'percent' ? `${v}% off` : `${v} off`, amount: amt, after: cur });
  }
  const p = Math.max(0, num(price));
  const tax = (cur * num(taxPct)) / 100;
  return {
    steps: out, subtotal: cur, discount: p - cur,
    effectivePct: p ? ((p - cur) / p) * 100 : 0, tax, total: cur + tax,
  };
}

export type TipRounding = 'none' | 'tip' | 'total' | 'person';
/** Tip split. Rounding up: 'tip' → whole tip, 'total' → whole bill, 'person' → whole per-person share. */
export function computeTip(bill: number, tipPct: number, people: number, rounding: TipRounding = 'none') {
  const b = Math.max(0, num(bill));
  const n = Math.max(1, Math.floor(num(people, 1)));
  let tip = (b * num(tipPct)) / 100;
  let total = b + tip;
  if (rounding === 'tip') { tip = Math.ceil(tip - 1e-9); total = b + tip; }
  if (rounding === 'total') { total = Math.ceil(total - 1e-9); tip = total - b; }
  let perPerson = total / n;
  if (rounding === 'person') { perPerson = Math.ceil(perPerson - 1e-9); total = perPerson * n; tip = total - b; }
  return { tip, total, perPerson, tipPerPerson: tip / n, effectivePct: b ? (tip / b) * 100 : 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Loans & compound interest
// ═════════════════════════════════════════════════════════════════════════════

/** Standard annuity payment. rate = periodic rate (e.g. annual/12/100). */
export function annuityPayment(principal: number, rate: number, periods: number): number {
  if (periods <= 0) return NaN;
  if (rate === 0) return principal / periods;
  return (principal * rate) / (1 - Math.pow(1 + rate, -periods));
}

export interface AmortRow { period: number; payment: number; principal: number; interest: number; extra: number; balance: number }
export interface LoanResult {
  payment: number; months: number; scheduledMonths: number;
  totalInterest: number; totalPaid: number; interestSaved: number; monthsSaved: number;
  rows: AmortRow[];
}

/** Monthly amortisation with an optional fixed extra principal payment each month. */
export function amortize(principal: number, annualRatePct: number, months: number, extraMonthly = 0): LoanResult {
  const P = Math.max(0, num(principal));
  const n = Math.max(1, Math.min(1200, Math.round(num(months, 1))));
  const r = Math.max(0, num(annualRatePct)) / 100 / 12;
  const pay = annuityPayment(P, r, n);
  const extra = Math.max(0, num(extraMonthly));
  const baseInterest = pay * n - P;

  const rows: AmortRow[] = [];
  let bal = P;
  let totalInterest = 0;
  for (let i = 1; i <= n && bal > 0.005; i++) {
    const interest = bal * r;
    let principalPart = Math.min(bal, pay - interest);
    const ex = Math.min(bal - principalPart, extra);
    principalPart = Math.max(0, principalPart);
    bal = bal - principalPart - ex;
    if (bal < 0.005) bal = 0;
    totalInterest += interest;
    rows.push({ period: i, payment: interest + principalPart, principal: principalPart, interest, extra: ex, balance: bal });
  }
  const totalPaid = P + totalInterest;
  return {
    payment: pay, months: rows.length, scheduledMonths: n,
    totalInterest, totalPaid,
    interestSaved: Math.max(0, baseInterest - totalInterest), monthsSaved: n - rows.length, rows,
  };
}

/** Collapse monthly rows into yearly rows (period = year number). */
export function yearlyAmortization(rows: AmortRow[]): AmortRow[] {
  const out: AmortRow[] = [];
  for (const r of rows) {
    const y = Math.ceil(r.period / 12);
    let cur = out[y - 1];
    if (!cur) { cur = { period: y, payment: 0, principal: 0, interest: 0, extra: 0, balance: 0 }; out.push(cur); }
    cur.payment += r.payment; cur.principal += r.principal; cur.interest += r.interest; cur.extra += r.extra;
    cur.balance = r.balance;
  }
  return out;
}

export interface GrowthRow { year: number; deposits: number; interest: number; balance: number; yearInterest: number }

/**
 * Compound growth with monthly contributions (made at the end of each month — or start, if
 * `atStart`). `perYear` = compounding periods per year (1, 2, 4, 12, 52, 365); interest is
 * accrued monthly at the equivalent effective rate, matching common online calculators.
 */
export function compoundGrowth(principal: number, annualRatePct: number, perYear: number, years: number, monthly = 0, atStart = false) {
  const P = Math.max(0, num(principal));
  const Y = Math.max(0, Math.min(100, Math.round(num(years))));
  const r = num(annualRatePct) / 100;
  const m = Math.max(1, num(perYear, 12));
  const monthlyRate = Math.pow(1 + r / m, m / 12) - 1;
  const c = num(monthly);
  let bal = P;
  let deposits = P;
  const rows: GrowthRow[] = [];
  for (let y = 1; y <= Y; y++) {
    const start = bal;
    let dep = 0;
    for (let mo = 0; mo < 12; mo++) {
      if (atStart) { bal += c; dep += c; }
      bal *= 1 + monthlyRate;
      if (!atStart) { bal += c; dep += c; }
    }
    deposits += dep;
    rows.push({ year: y, deposits, interest: bal - deposits, balance: bal, yearInterest: bal - start - dep });
  }
  const last = rows[rows.length - 1];
  return {
    rows,
    final: last?.balance ?? P,
    totalDeposits: last?.deposits ?? P,
    totalInterest: last?.interest ?? 0,
    effectiveAnnualRate: (Math.pow(1 + r / m, m) - 1) * 100,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Salary
// ═════════════════════════════════════════════════════════════════════════════

export type PayPeriod = 'annual' | 'monthly' | 'semimonthly' | 'biweekly' | 'weekly' | 'daily' | 'hourly';
export const PAY_PERIODS: { id: PayPeriod; label: string }[] = [
  { id: 'annual', label: 'Annual' }, { id: 'monthly', label: 'Monthly' }, { id: 'semimonthly', label: 'Semi-monthly' },
  { id: 'biweekly', label: 'Bi-weekly' }, { id: 'weekly', label: 'Weekly' }, { id: 'daily', label: 'Daily' },
  { id: 'hourly', label: 'Hourly' },
];

/** How many of each period make up a year, given working hours/week, days/week and weeks/year. */
export function periodsPerYear(hoursPerWeek: number, weeksPerYear: number, daysPerWeek = 5): Record<PayPeriod, number> {
  return {
    annual: 1, monthly: 12, semimonthly: 24, biweekly: 26, weekly: weeksPerYear,
    daily: weeksPerYear * daysPerWeek, hourly: weeksPerYear * hoursPerWeek,
  };
}

export function convertSalary(amount: number, from: PayPeriod, hoursPerWeek = 40, weeksPerYear = 52, daysPerWeek = 5): Record<PayPeriod, number> {
  const per = periodsPerYear(hoursPerWeek, weeksPerYear, daysPerWeek);
  const annual = num(amount) * per[from];
  // Bi-weekly / semi-monthly / monthly are pay-period based; weekly/daily/hourly follow the worked weeks.
  return Object.fromEntries(Object.entries(per).map(([k, n]) => [k, n ? annual / n : NaN])) as Record<PayPeriod, number>;
}

// ═════════════════════════════════════════════════════════════════════════════
// BMI
// ═════════════════════════════════════════════════════════════════════════════

export const bmi = (kg: number, cm: number) => (cm > 0 ? kg / Math.pow(cm / 100, 2) : NaN);
export const lbToKg = (lb: number) => lb * 0.45359237;
export const kgToLb = (kg: number) => kg / 0.45359237;
export const inToCm = (inch: number) => inch * 2.54;

export const BMI_CATEGORIES = [
  { max: 16, label: 'Severe thinness' },
  { max: 17, label: 'Moderate thinness' },
  { max: 18.5, label: 'Underweight' },
  { max: 25, label: 'Normal weight' },
  { max: 30, label: 'Overweight' },
  { max: 35, label: 'Obese (class I)' },
  { max: 40, label: 'Obese (class II)' },
  { max: Infinity, label: 'Obese (class III)' },
];
export function bmiCategory(v: number) {
  return BMI_CATEGORIES.find(c => v < c.max)?.label ?? '—';
}
/** Weight range (kg) for BMI 18.5–24.9 at a given height. */
export function healthyWeightRange(cm: number): [number, number] {
  const m2 = Math.pow(cm / 100, 2);
  return [18.5 * m2, 24.9 * m2];
}

// ═════════════════════════════════════════════════════════════════════════════
// Dates (calendar arithmetic on local Y-M-D; times ignored)
// ═════════════════════════════════════════════════════════════════════════════

export interface YMD { y: number; m: number; d: number } // m: 1-12

export function parseYMD(s: string): YMD | null {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = { y: +m[1], m: +m[2], d: +m[3] };
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.m)) return null;
  return v;
}
export const fmtYMD = (v: YMD) => `${String(v.y).padStart(4, '0')}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** Day number (UTC-based, DST-proof). */
export const dayNumber = (v: YMD) => Math.round(Date.UTC(v.y, v.m - 1, v.d) / 86_400_000);
export const fromDayNumber = (n: number): YMD => { const d = new Date(n * 86_400_000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
export const weekday = (v: YMD) => new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay(); // 0 = Sunday
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const todayYMD = (now = new Date()): YMD => ({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });

/** Add months, clamping the day (Jan 31 + 1 month → Feb 28/29). */
export function addMonths(v: YMD, months: number): YMD {
  const total = v.y * 12 + (v.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return { y, m, d: Math.min(v.d, daysInMonth(y, m)) };
}
export const addDays = (v: YMD, days: number) => fromDayNumber(dayNumber(v) + days);

/**
 * Calendar difference a → b as years/months/days (b ≥ a, else swapped & negative flag).
 * Day borrowing uses the month before `b`, so 2024-01-31 → 2024-03-01 = 1 month 1 day.
 */
export function diffYMD(a: YMD, b: YMD): { years: number; months: number; days: number; negative: boolean } {
  let negative = false;
  if (dayNumber(b) < dayNumber(a)) { [a, b] = [b, a]; negative = true; }
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  let anchor = addMonths(a, months);
  if (dayNumber(anchor) > dayNumber(b)) { months--; anchor = addMonths(a, months); }
  const days = dayNumber(b) - dayNumber(anchor);
  return { years: Math.floor(months / 12), months: months % 12, days, negative };
}

/** Whole months between a and b (b ≥ a). */
export function totalMonths(a: YMD, b: YMD) {
  const d = diffYMD(a, b);
  return d.years * 12 + d.months;
}

/** Mon–Fri days in [a, b) — or [a, b] when inclusive. Holidays (YMD strings) are excluded too. */
export function businessDays(a: YMD, b: YMD, inclusive = false, holidays: Set<string> = new Set()): number {
  let start = dayNumber(a);
  let end = dayNumber(b);
  let sign = 1;
  if (end < start) { [start, end] = [end, start]; sign = -1; }
  if (inclusive) end += 1;
  const n = end - start;
  const fullWeeks = Math.floor(n / 7);
  let count = fullWeeks * 5;
  for (let i = start + fullWeeks * 7; i < end; i++) {
    const wd = (((i + 4) % 7) + 7) % 7; // day 0 (1970-01-01) was a Thursday
    if (wd !== 0 && wd !== 6) count++;
  }
  for (const h of holidays) {
    const p = parseYMD(h);
    if (!p) continue;
    const dn = dayNumber(p);
    const wd = (((dn + 4) % 7) + 7) % 7;
    if (dn >= start && dn < end && wd !== 0 && wd !== 6) count--;
  }
  return count * sign;
}

/** Add N business days (skipping weekends). */
export function addBusinessDays(v: YMD, n: number): YMD {
  let dn = dayNumber(v);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(Math.trunc(n));
  while (left > 0) {
    dn += step;
    const wd = (((dn + 4) % 7) + 7) % 7;
    if (wd !== 0 && wd !== 6) left--;
  }
  return fromDayNumber(dn);
}

/** Next occurrence of a birthday on/after `from` (Feb 29 → Feb 28 in non-leap years). */
export function nextBirthday(birth: YMD, from: YMD): { date: YMD; days: number; turning: number } {
  const mk = (y: number): YMD => ({ y, m: birth.m, d: Math.min(birth.d, daysInMonth(y, birth.m)) });
  let c = mk(from.y);
  if (dayNumber(c) < dayNumber(from)) c = mk(from.y + 1);
  return { date: c, days: dayNumber(c) - dayNumber(from), turning: c.y - birth.y };
}

// ═════════════════════════════════════════════════════════════════════════════
// Clock durations
// ═════════════════════════════════════════════════════════════════════════════

/** Parse "hh:mm[:ss]", "1h 30m 15s", "90m", or a plain number of minutes into seconds. */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  let sign = 1;
  let body = t;
  if (body.startsWith('-')) { sign = -1; body = body.slice(1).trim(); }
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(body);
  if (m) {
    const [h, mi, se] = [+m[1], +m[2], m[3] ? +m[3] : 0];
    if (mi >= 60 || se >= 60) return null;
    return sign * (h * 3600 + mi * 60 + se);
  }
  m = /^(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/.exec(body);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    return sign * ((+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)));
  }
  if (/^\d+(\.\d+)?$/.test(body)) return sign * Number(body) * 60;
  return null;
}

export function formatHMS(totalSec: number, showSign = true): string {
  const neg = totalSec < 0;
  let s = Math.round(Math.abs(totalSec));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${neg && showSign ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** "Xd Yh Zm Ws" style, skipping zero units. */
export function formatHuman(totalSec: number): string {
  const neg = totalSec < 0;
  let s = Math.round(Math.abs(totalSec));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean);
  return (neg ? '-' : '') + (parts.join(' ') || '0s');
}

/** Seconds from clock time a to b ("HH:MM[:SS]"), wrapping past midnight when b < a. */
export function clockSpan(a: string, b: string): { seconds: number; overnight: boolean } | null {
  const pa = parseClock(a);
  const pb = parseClock(b);
  if (pa === null || pb === null) return null;
  const overnight = pb < pa;
  return { seconds: overnight ? pb + 86400 - pa : pb - pa, overnight };
}
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  const se = m[3] ? +m[3] : 0;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (h > 23 || mi > 59 || se > 59) return null;
  return h * 3600 + mi * 60 + se;
}

// ═════════════════════════════════════════════════════════════════════════════
// GPA
// ═════════════════════════════════════════════════════════════════════════════

export const LETTER_GRADES: { letter: string; points: number; minPct: number }[] = [
  { letter: 'A+', points: 4.0, minPct: 97 }, { letter: 'A', points: 4.0, minPct: 93 }, { letter: 'A-', points: 3.7, minPct: 90 },
  { letter: 'B+', points: 3.3, minPct: 87 }, { letter: 'B', points: 3.0, minPct: 83 }, { letter: 'B-', points: 2.7, minPct: 80 },
  { letter: 'C+', points: 2.3, minPct: 77 }, { letter: 'C', points: 2.0, minPct: 73 }, { letter: 'C-', points: 1.7, minPct: 70 },
  { letter: 'D+', points: 1.3, minPct: 67 }, { letter: 'D', points: 1.0, minPct: 63 }, { letter: 'D-', points: 0.7, minPct: 60 },
  { letter: 'F', points: 0.0, minPct: 0 },
];
export const letterPoints = (l: string) => LETTER_GRADES.find(g => g.letter === l)?.points ?? NaN;
export const pctToLetter = (p: number) => LETTER_GRADES.find(g => p >= g.minPct)?.letter ?? 'F';

export interface GpaCourse { credits: number; points: number }
export function gpa(courses: GpaCourse[], prevGpa = 0, prevCredits = 0) {
  let qp = 0;
  let cr = 0;
  for (const c of courses) {
    if (!Number.isFinite(c.credits) || !Number.isFinite(c.points) || c.credits <= 0) continue;
    qp += c.credits * c.points;
    cr += c.credits;
  }
  const term = cr ? qp / cr : NaN;
  const pc = Math.max(0, num(prevCredits));
  const totalCr = cr + pc;
  const cumulative = totalCr ? (qp + num(prevGpa) * pc) / totalCr : NaN;
  return { term, credits: cr, qualityPoints: qp, cumulative, totalCredits: totalCr };
}

// ═════════════════════════════════════════════════════════════════════════════
// Electricity
// ═════════════════════════════════════════════════════════════════════════════

export interface Tier { upTo: number | null; rate: number } // upTo = cumulative kWh ceiling, null = no limit

/** Cost of `kwh` under tiered (block) pricing. Tiers must be ordered; the last should have upTo=null. */
export function tieredCost(kwh: number, tiers: Tier[]): { cost: number; breakdown: { from: number; to: number; kwh: number; rate: number; cost: number }[] } {
  let left = Math.max(0, num(kwh));
  let prev = 0;
  let cost = 0;
  const breakdown = [];
  for (const t of tiers) {
    if (left <= 0) break;
    const cap = t.upTo === null || !Number.isFinite(t.upTo) ? Infinity : Math.max(prev, t.upTo);
    const used = Math.min(left, cap - prev);
    if (used > 0) {
      const c = used * num(t.rate);
      breakdown.push({ from: prev, to: prev + used, kwh: used, rate: num(t.rate), cost: c });
      cost += c;
      left -= used;
    }
    prev = cap;
  }
  // Anything beyond the last capped tier is billed at the last tier's rate.
  if (left > 0 && tiers.length) {
    const r = num(tiers[tiers.length - 1].rate);
    breakdown.push({ from: prev, to: prev + left, kwh: left, rate: r, cost: left * r });
    cost += left * r;
  }
  return { cost, breakdown };
}

export const applianceKwh = (watts: number, hoursPerDay: number, qty: number, days: number) =>
  (Math.max(0, num(watts)) * Math.max(0, num(hoursPerDay)) * Math.max(0, num(qty)) * Math.max(0, num(days))) / 1000;

// ═════════════════════════════════════════════════════════════════════════════
// Time zones (Intl-based)
// ═════════════════════════════════════════════════════════════════════════════

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(zone: string, t: number) {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(zone, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

/** UTC offset of `zone` at instant `t`, in minutes (e.g. +330 for Asia/Kolkata). */
export function zoneOffset(zone: string, t: number): number {
  const p = partsIn(zone, t);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
}

/** Wall-clock parts of instant t in zone. */
export function wallTime(zone: string, t: number) { return partsIn(zone, t); }

/**
 * Convert a wall-clock time in `zone` to a UTC instant. For times that don't exist (spring-forward
 * gap) the result is shifted forward; for ambiguous times (fall-back) the earlier instant is used.
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, zone: string, s = 0): number {
  const naive = Date.UTC(y, m - 1, d, h, mi, s);
  const offsets = new Set([zoneOffset(zone, naive - 14 * 3600_000), zoneOffset(zone, naive), zoneOffset(zone, naive + 14 * 3600_000)]);
  const valid: number[] = [];
  for (const o of offsets) {
    const t = naive - o * 60000;
    const w = partsIn(zone, t);
    if (w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi) valid.push(t);
  }
  if (valid.length) return Math.min(...valid);
  // Wall time falls in a DST gap: interpret with the pre-transition offset (lands after the gap).
  return naive - zoneOffset(zone, naive - 14 * 3600_000) * 60000;
}

export function formatOffset(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Is DST in effect for `zone` at t? (offset larger than the smaller of Jan/Jul offsets) */
export function dstInfo(zone: string, t: number): { observes: boolean; active: boolean } {
  const y = new Date(t).getUTCFullYear();
  const jan = zoneOffset(zone, Date.UTC(y, 0, 1));
  const jul = zoneOffset(zone, Date.UTC(y, 6, 1));
  if (jan === jul) return { observes: false, active: false };
  return { observes: true, active: zoneOffset(zone, t) === Math.max(jan, jul) };
}

// ═════════════════════════════════════════════════════════════════════════════
// Cron
// ═════════════════════════════════════════════════════════════════════════════

export class CronError extends Error {}

interface FieldDef { name: string; min: number; max: number; names?: string[] }
const F_SEC: FieldDef = { name: 'second', min: 0, max: 59 };
const F_MIN: FieldDef = { name: 'minute', min: 0, max: 59 };
const F_HOUR: FieldDef = { name: 'hour', min: 0, max: 23 };
const F_DOM: FieldDef = { name: 'day-of-month', min: 1, max: 31 };
const F_MON: FieldDef = { name: 'month', min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] };
const F_DOW: FieldDef = { name: 'day-of-week', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] };

export const CRON_MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

export interface CronSchedule {
  /** Normalised expression (macros expanded), always 6 fields: sec min hour dom mon dow. */
  normalized: string;
  hasSeconds: boolean;
  seconds: number[]; minutes: number[]; hours: number[]; doms: number[]; months: number[]; dows: number[];
  domRestricted: boolean; dowRestricted: boolean;
  /** Lookup tables for matching. */
  sets: { s: boolean[]; mi: boolean[]; h: boolean[]; dom: boolean[]; mon: boolean[]; dow: boolean[] };
}

function parseValue(raw: string, f: FieldDef): number {
  const s = raw.toUpperCase();
  if (f.names) {
    const i = f.names.indexOf(s);
    if (i >= 0) return f === F_MON ? i + 1 : i;
  }
  if (!/^\d+$/.test(s)) throw new CronError(`Invalid ${f.name} value "${raw}"`);
  const n = Number(s);
  if (n < f.min || n > f.max) throw new CronError(`${f.name} value ${n} is out of range (${f.min}–${f.max}${f === F_DOW ? ', 0 and 7 = Sunday' : ''})`);
  return n;
}

function parseField(src: string, f: FieldDef): { values: number[]; restricted: boolean } {
  if (src === '') throw new CronError(`Empty ${f.name} field`);
  const set = new Set<number>();
  const restricted = !(src.startsWith('*') || src === '?');
  for (const part of src.split(',')) {
    if (part === '') throw new CronError(`Empty item in ${f.name} list "${src}"`);
    if (/[LW#?]/i.test(part.replace(/[A-Z]{3}/gi, '').replace(/^\?$/, ''))) throw new CronError(`"${part}": L, W and # modifiers are not supported`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`Invalid step in "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new CronError(`Invalid step "/${stepPart}" in ${f.name} field`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    const max = f === F_DOW ? 6 : f.max;
    if (rangePart === '*' || rangePart === '?') {
      if (rangePart === '?' && stepPart !== undefined) throw new CronError(`"?" cannot have a step`);
      lo = f.min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined || a === '' || b === '') throw new CronError(`Invalid range "${rangePart}" in ${f.name} field`);
      lo = parseValue(a, f); hi = parseValue(b, f);
      if (f === F_DOW && hi === 7) hi = 7; // 5-7 = Fri..Sun
      if (lo > hi) throw new CronError(`Range ${rangePart} in ${f.name} field is backwards`);
    } else {
      lo = parseValue(rangePart, f);
      // "a/n" means a, a+n, … up to max.
      hi = stepPart !== undefined ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) set.add(f === F_DOW && v === 7 ? 0 : v);
  }
  return { values: [...set].sort((a, b) => a - b), restricted };
}

/** Parse a 5-field (min hour dom mon dow) or 6-field (sec min hour dom mon dow) cron expression or @macro. */
export function parseCron(expr: string): CronSchedule {
  let s = expr.trim().replace(/\s+/g, ' ');
  if (!s) throw new CronError('Empty expression');
  if (s.startsWith('@')) {
    const m = CRON_MACROS[s.toLowerCase()];
    if (!m) throw new CronError(`Unknown macro "${s}". Supported: ${Object.keys(CRON_MACROS).join(', ')}`);
    s = m;
  }
  const parts = s.split(' ');
  if (parts.length !== 5 && parts.length !== 6) {
    throw new CronError(`Expected 5 fields (minute hour day month weekday) or 6 with seconds — got ${parts.length}`);
  }
  const hasSeconds = parts.length === 6;
  const [sec, mi, h, dom, mon, dow] = hasSeconds ? parts : ['0', ...parts];
  const S = parseField(sec, F_SEC);
  const MI = parseField(mi, F_MIN);
  const H = parseField(h, F_HOUR);
  const DOM = parseField(dom, F_DOM);
  const MON = parseField(mon, F_MON);
  const DOW = parseField(dow, F_DOW);
  const table = (vals: number[], size: number) => { const a = new Array<boolean>(size).fill(false); vals.forEach(v => { a[v] = true; }); return a; };
  const sched: CronSchedule = {
    normalized: [sec, mi, h, dom, mon, dow].join(' '), hasSeconds,
    seconds: S.values, minutes: MI.values, hours: H.values, doms: DOM.values, months: MON.values, dows: DOW.values,
    domRestricted: DOM.restricted, dowRestricted: DOW.restricted,
    sets: { s: table(S.values, 60), mi: table(MI.values, 60), h: table(H.values, 24), dom: table(DOM.values, 32), mon: table(MON.values, 13), dow: table(DOW.values, 7) },
  };
  // Reject schedules that can never fire (e.g. 30 Feb) — only when weekday doesn't rescue it.
  if (!sched.dowRestricted || !sched.domRestricted) {
    const maxDays = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!sched.months.some(m => sched.doms.some(d => d <= maxDays[m]))) {
      throw new CronError('This schedule never runs (day-of-month does not exist in the selected months)');
    }
  }
  return sched;
}

function dayMatches(c: CronSchedule, dom: number, dow: number): boolean {
  const d = c.sets.dom[dom];
  const w = c.sets.dow[dow];
  // Vixie cron: if both fields are restricted, a day matches when EITHER matches.
  if (c.domRestricted && c.dowRestricted) return d || w;
  if (c.domRestricted) return d;
  if (c.dowRestricted) return w;
  return true;
}

/**
 * Next `count` fire times strictly after `from`, evaluated in local time (or UTC when `utc`).
 * DST: local times that don't exist are skipped; times in a repeated hour may fire twice.
 */
export function cronNext(expr: string | CronSchedule, from: Date, count = 10, utc = false): Date[] {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const g = utc
    ? { Y: (d: Date) => d.getUTCFullYear(), M: (d: Date) => d.getUTCMonth(), D: (d: Date) => d.getUTCDate(), W: (d: Date) => d.getUTCDay(), h: (d: Date) => d.getUTCHours(), m: (d: Date) => d.getUTCMinutes(), s: (d: Date) => d.getUTCSeconds() }
    : { Y: (d: Date) => d.getFullYear(), M: (d: Date) => d.getMonth(), D: (d: Date) => d.getDate(), W: (d: Date) => d.getDay(), h: (d: Date) => d.getHours(), m: (d: Date) => d.getMinutes(), s: (d: Date) => d.getSeconds() };
  const mk = (y: number, mo: number, d: number) => (utc ? new Date(Date.UTC(y, mo, d)) : new Date(y, mo, d));

  const out: Date[] = [];
  let t = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000); // next whole second
  if (!c.hasSeconds && g.s(t) !== 0) t = new Date(t.getTime() + (60 - g.s(t)) * 1000);
  const limit = from.getTime() + 8 * 366 * 86_400_000; // search horizon: 8 years (covers leap-day schedules)
  let guard = 0;

  while (out.length < count && t.getTime() <= limit) {
    if (++guard > 500_000) break;
    const prev = t.getTime();
    if (!c.sets.mon[g.M(t) + 1]) {
      t = mk(g.Y(t), g.M(t) + 1, 1);
    } else if (!dayMatches(c, g.D(t), g.W(t))) {
      t = mk(g.Y(t), g.M(t), g.D(t) + 1);
    } else if (!c.sets.h[g.h(t)]) {
      t = new Date(t.getTime() - (g.m(t) * 60 + g.s(t)) * 1000 + 3600_000);
    } else if (!c.sets.mi[g.m(t)]) {
      t = new Date(t.getTime() - g.s(t) * 1000 + 60_000);
    } else if (!c.sets.s[g.s(t)]) {
      t = new Date(t.getTime() + 1000);
    } else {
      if (!out.length || out[out.length - 1].getTime() !== t.getTime()) out.push(new Date(t));
      t = new Date(t.getTime() + 1000);
      if (!c.hasSeconds) t = new Date(t.getTime() + 59_000);
    }
    if (t.getTime() <= prev) t = new Date(prev + 3600_000); // DST safety: always make progress
  }
  return out;
}

/** Compact human view of a field's values: "0, 15, 30, 45" or "every value". */
export function describeValues(vals: number[], f: 'second' | 'minute' | 'hour' | 'dom' | 'month' | 'dow'): string {
  const full: Record<string, number> = { second: 60, minute: 60, hour: 24, dom: 31, month: 12, dow: 7 };
  if (vals.length === full[f]) return 'every';
  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const label = (v: number) => (f === 'month' ? MONTHS[v] : f === 'dow' ? DOWS[v] : String(v));
  if (vals.length > 16) return `${vals.slice(0, 16).map(label).join(', ')} … (${vals.length} values)`;
  return vals.map(label).join(', ');
}
