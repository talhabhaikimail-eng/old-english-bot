// Run from the repo root: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/calc.test.ts
/// <reference types="node" />
import assert from 'node:assert/strict';
import * as C from './calc';

let passed = 0;
const failed: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failed.push(name); console.log(`✗ ${name}\n   ${(e as Error).message.split('\n').join('\n   ')}`); }
}
const close = (a: number, b: number, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');

// ── evaluator ────────────────────────────────────────────────────────────────
test('precedence and parentheses', () => {
  assert.equal(C.evaluate('2+3*4'), 14);
  assert.equal(C.evaluate('(2+3)*4'), 20);
  assert.equal(C.evaluate('10 - 4 - 3'), 3);
  assert.equal(C.evaluate('2^3^2'), 512);
  assert.equal(C.evaluate('-2^2'), -4);
  assert.equal(C.evaluate('2^-1'), 0.5);
  assert.equal(C.evaluate('8 / 2 / 2'), 2);
  assert.equal(C.evaluate('7 mod 3'), 1);
  assert.equal(C.evaluate('5!'), 120);
  assert.equal(C.evaluate('3 × 4 ÷ 2 − 1'), 5);
});
test('float noise is cleaned', () => {
  assert.equal(C.evaluate('0.1+0.2'), 0.3);
  assert.equal(C.evaluate('1.1*3'), 3.3);
});
test('percent semantics', () => {
  assert.equal(C.evaluate('50%'), 0.5);
  assert.equal(C.evaluate('200+10%'), 220);
  assert.equal(C.evaluate('200-10%'), 180);
  assert.equal(C.evaluate('200*10%'), 20);
  assert.equal(C.evaluate('10%*200'), 20);
});
test('implicit multiplication, functions, constants', () => {
  assert.equal(C.evaluate('2(3+4)'), 14);
  assert.equal(C.evaluate('(1+1)(2+2)'), 8);
  assert.equal(C.evaluate('sqrt(16)+√9'), 7);
  close(C.evaluate('2pi'), 2 * Math.PI, 1e-9);
  assert.equal(C.evaluate('sin(180)', { degrees: true }), 0);
  assert.equal(C.evaluate('cos(0)'), 1);
  assert.equal(C.evaluate('log(1000)'), 3);
  assert.equal(C.evaluate('1,234.5 + 0.5'), 1235);
  assert.equal(C.evaluate('1e3+1'), 1001);
  assert.equal(C.evaluate('(2+3'), 5); // auto-close
});
test('evaluator errors', () => {
  for (const [src, re] of [
    ['1/0', /Division by zero/], ['', /Empty/], ['2+', /Incomplete/], ['2)+1', /Unexpected "\)"/],
    ['foo(2)', /Unknown name/], ['1.2.3', /Invalid number/], ['2 $ 3', /Unexpected "\$"/], ['(-1)!', /Factorial/],
    ['sqrt(-1)', /not a number/], ['10^400', /too large/], ['alert(1)', /Unknown name/],
  ] as [string, RegExp][]) {
    assert.throws(() => C.evaluate(src), re, src);
  }
});
test('formatCalc', () => {
  assert.equal(C.formatCalc(1234567.5), '1,234,567.5');
  assert.equal(C.formatCalc(1e20), '1e+20');
  assert.equal(C.formatCalc(-0.25), '-0.25');
});

// ── percent / discount / tip ────────────────────────────────────────────────
test('percentages', () => {
  assert.equal(C.percentOf(15, 200), 30);
  assert.equal(C.whatPercent(30, 200), 15);
  assert.equal(C.percentChange(80, 100), 25);
  assert.equal(C.percentChange(100, 80), -20);
  assert.ok(Number.isNaN(C.percentChange(0, 5)));
  close(C.percentDifference(80, 100), 22.2222222, 1e-6);
});
test('stacked discounts with tax', () => {
  const r = C.applyDiscounts(100, [{ kind: 'percent', value: 20 }, { kind: 'percent', value: 10 }, { kind: 'fixed', value: 5 }], 10);
  close(r.subtotal, 67); // 100 → 80 → 72 → 67
  close(r.discount, 33);
  close(r.effectivePct, 33);
  close(r.tax, 6.7);
  close(r.total, 73.7);
  const capped = C.applyDiscounts(10, [{ kind: 'fixed', value: 50 }]);
  assert.equal(capped.subtotal, 0);
});
test('tip split and rounding', () => {
  const r = C.computeTip(87.5, 18, 3);
  close(r.tip, 15.75); close(r.total, 103.25); close(r.perPerson, 34.416666, 1e-5);
  const p = C.computeTip(87.5, 18, 3, 'person');
  assert.equal(p.perPerson, 35); assert.equal(p.total, 105); close(p.tip, 17.5);
  const t = C.computeTip(87.5, 18, 3, 'total');
  assert.equal(t.total, 104);
  assert.equal(C.computeTip(100, 15, 0).perPerson, 115); // people clamps to 1
});

// ── loans / compounding ─────────────────────────────────────────────────────
test('loan payment and amortisation', () => {
  // $200,000 at 6% for 30 years → $1,199.10/month (well-known figure)
  const r = C.amortize(200_000, 6, 360);
  close(r.payment, 1199.1, 0.01);
  assert.equal(r.rows.length, 360);
  close(r.rows[0].interest, 1000, 1e-9);
  close(r.rows[359].balance, 0, 0.01);
  close(r.totalInterest, 1199.1 * 360 - 200_000, 2);
  const y = C.yearlyAmortization(r.rows);
  assert.equal(y.length, 30);
  close(y.reduce((s, x) => s + x.interest, 0), r.totalInterest, 1e-6);
});
test('loan with extra payments pays off early', () => {
  const base = C.amortize(200_000, 6, 360);
  const r = C.amortize(200_000, 6, 360, 200);
  assert.ok(r.months < 360 && r.months > 250, `months ${r.months}`);
  assert.ok(r.totalInterest < base.totalInterest);
  close(r.interestSaved, base.totalInterest - r.totalInterest, 1);
  close(r.rows.reduce((s, x) => s + x.principal + x.extra, 0), 200_000, 0.01);
});
test('zero-interest loan', () => {
  const r = C.amortize(1200, 0, 12);
  assert.equal(r.payment, 100);
  assert.equal(r.totalInterest, 0);
});
test('compound growth', () => {
  // $10,000 at 5% compounded annually for 10 years → 16,288.95
  close(C.compoundGrowth(10_000, 5, 1, 10).final, 16288.946, 0.01);
  // monthly compounding, no contributions: 10000*(1+0.05/12)^120 = 16470.09
  close(C.compoundGrowth(10_000, 5, 12, 10).final, 16470.095, 0.01);
  // contributions only, 0% → sum of deposits
  const z = C.compoundGrowth(0, 0, 12, 2, 100);
  assert.equal(z.final, 2400);
  assert.equal(z.rows.length, 2);
  // FV of $100/month at 6%/12 for 10 years (ordinary annuity) = 16387.93
  close(C.compoundGrowth(0, 6, 12, 10, 100).final, 16387.93, 0.01);
  close(C.compoundGrowth(0, 6, 12, 1, 100).effectiveAnnualRate, 6.1678, 1e-3);
});

// ── salary / bmi ────────────────────────────────────────────────────────────
test('salary conversion', () => {
  const r = C.convertSalary(52_000, 'annual');
  assert.equal(r.monthly, 52_000 / 12);
  assert.equal(r.weekly, 1000);
  assert.equal(r.hourly, 25);
  assert.equal(r.daily, 200);
  assert.equal(r.biweekly, 2000);
  const h = C.convertSalary(30, 'hourly', 37.5, 48);
  assert.equal(h.annual, 30 * 37.5 * 48);
});
test('bmi', () => {
  close(C.bmi(70, 175), 22.857, 1e-3);
  assert.equal(C.bmiCategory(22.9), 'Normal weight');
  assert.equal(C.bmiCategory(18.4), 'Underweight');
  assert.equal(C.bmiCategory(31), 'Obese (class I)');
  const [lo, hi] = C.healthyWeightRange(175);
  close(lo, 56.66, 0.01); close(hi, 76.26, 0.01);
  close(C.lbToKg(154.3236), 70, 1e-3);
});

// ── dates ───────────────────────────────────────────────────────────────────
const D = (s: string) => C.parseYMD(s)!;
test('parseYMD validation', () => {
  assert.equal(C.parseYMD('2023-02-29'), null);
  assert.deepEqual(C.parseYMD('2024-02-29'), { y: 2024, m: 2, d: 29 });
  assert.equal(C.parseYMD('2024-13-01'), null);
});
test('addMonths clamps', () => {
  assert.equal(C.fmtYMD(C.addMonths(D('2024-01-31'), 1)), '2024-02-29');
  assert.equal(C.fmtYMD(C.addMonths(D('2023-01-31'), 1)), '2023-02-28');
  assert.equal(C.fmtYMD(C.addMonths(D('2024-03-15'), -15)), '2022-12-15');
  assert.equal(C.fmtYMD(C.addDays(D('2024-02-28'), 2)), '2024-03-01');
});
test('diffYMD', () => {
  assert.deepEqual(C.diffYMD(D('1990-05-15'), D('2024-03-10')), { years: 33, months: 9, days: 24, negative: false });
  assert.deepEqual(C.diffYMD(D('2024-01-31'), D('2024-03-01')), { years: 0, months: 1, days: 1, negative: false });
  assert.deepEqual(C.diffYMD(D('2024-03-01'), D('2024-01-31')), { years: 0, months: 1, days: 1, negative: true });
  assert.deepEqual(C.diffYMD(D('2020-02-29'), D('2021-02-28')), { years: 1, months: 0, days: 0, negative: false }); // clamped anniversary
  assert.deepEqual(C.diffYMD(D('2020-03-31'), D('2020-04-30')), { years: 0, months: 1, days: 0, negative: false });
  assert.deepEqual(C.diffYMD(D('2020-02-29'), D('2024-02-29')), { years: 4, months: 0, days: 0, negative: false });
  assert.equal(C.totalMonths(D('2024-01-15'), D('2025-03-14')), 13);
});
test('business days', () => {
  // Mon 2024-01-01 → Mon 2024-01-08: 5 business days (exclusive end)
  assert.equal(C.businessDays(D('2024-01-01'), D('2024-01-08')), 5);
  assert.equal(C.businessDays(D('2024-01-01'), D('2024-01-08'), true), 6);
  assert.equal(C.businessDays(D('2024-01-06'), D('2024-01-08')), 0); // Sat → Mon
  assert.equal(C.businessDays(D('2024-01-08'), D('2024-01-01')), -5);
  assert.equal(C.businessDays(D('2024-01-01'), D('2024-12-31'), true), 262);
  assert.equal(C.businessDays(D('2024-01-01'), D('2024-01-08'), false, new Set(['2024-01-01', '2024-01-06'])), 4);
  assert.equal(C.fmtYMD(C.addBusinessDays(D('2024-01-05'), 1)), '2024-01-08');
  assert.equal(C.fmtYMD(C.addBusinessDays(D('2024-01-08'), -1)), '2024-01-05');
  assert.equal(C.weekday(D('2024-01-01')), 1);
});
test('next birthday', () => {
  const r = C.nextBirthday(D('1990-05-15'), D('2024-03-10'));
  assert.equal(C.fmtYMD(r.date), '2024-05-15'); assert.equal(r.days, 66); assert.equal(r.turning, 34);
  assert.equal(C.nextBirthday(D('1990-05-15'), D('2024-05-15')).days, 0);
  assert.equal(C.fmtYMD(C.nextBirthday(D('2000-02-29'), D('2023-03-01')).date), '2024-02-29');
  assert.equal(C.fmtYMD(C.nextBirthday(D('2000-02-29'), D('2022-03-01')).date), '2023-02-28');
});

// ── durations ───────────────────────────────────────────────────────────────
test('durations', () => {
  assert.equal(C.parseDuration('01:30:15'), 5415);
  assert.equal(C.parseDuration('1:30'), 5400);
  assert.equal(C.parseDuration('1h 30m'), 5400);
  assert.equal(C.parseDuration('2d 3s'), 172803);
  assert.equal(C.parseDuration('45'), 2700);
  assert.equal(C.parseDuration('-0:15'), -900);
  assert.equal(C.parseDuration('1:75'), null);
  assert.equal(C.parseDuration('abc'), null);
  assert.equal(C.formatHMS(5415), '01:30:15');
  assert.equal(C.formatHMS(-900), '-00:15:00');
  assert.equal(C.formatHMS(100 * 3600), '100:00:00');
  assert.equal(C.formatHuman(90061), '1d 1h 1m 1s');
  assert.deepEqual(C.clockSpan('22:30', '06:15'), { seconds: 7 * 3600 + 45 * 60, overnight: true });
  assert.deepEqual(C.clockSpan('9:00 am', '5:30 pm'), { seconds: 8.5 * 3600, overnight: false });
  assert.equal(C.parseClock('12:00 am'), 0);
  assert.equal(C.parseClock('12:00 pm'), 12 * 3600);
  assert.equal(C.parseClock('25:00'), null);
});

// ── gpa / electricity ───────────────────────────────────────────────────────
test('gpa', () => {
  const r = C.gpa([{ credits: 3, points: 4 }, { credits: 4, points: 3 }, { credits: 2, points: C.letterPoints('B+') }]);
  close(r.term, (12 + 12 + 6.6) / 9, 1e-9);
  assert.equal(r.credits, 9);
  const cum = C.gpa([{ credits: 15, points: 4 }], 3.0, 45);
  close(cum.cumulative, 3.25, 1e-9);
  assert.equal(C.pctToLetter(91), 'A-');
  assert.equal(C.pctToLetter(59), 'F');
  assert.ok(Number.isNaN(C.gpa([]).term));
});
test('electricity tiers', () => {
  assert.equal(C.applianceKwh(100, 10, 2, 30), 60);
  const tiers = [{ upTo: 100, rate: 0.1 }, { upTo: 300, rate: 0.2 }, { upTo: null, rate: 0.3 }];
  close(C.tieredCost(50, tiers).cost, 5);
  close(C.tieredCost(250, tiers).cost, 10 + 30);
  close(C.tieredCost(400, tiers).cost, 10 + 40 + 30);
  assert.equal(C.tieredCost(400, tiers).breakdown.length, 3);
  close(C.tieredCost(400, [{ upTo: 100, rate: 0.1 }]).cost, 40); // overflow billed at last rate
});

// ── timezones ───────────────────────────────────────────────────────────────
test('zone offsets and conversion', () => {
  assert.equal(C.zoneOffset('Asia/Kolkata', Date.UTC(2024, 0, 1)), 330);
  assert.equal(C.zoneOffset('America/New_York', Date.UTC(2024, 0, 15)), -300);
  assert.equal(C.zoneOffset('America/New_York', Date.UTC(2024, 6, 15)), -240);
  assert.equal(C.zoneOffset('UTC', Date.UTC(2024, 6, 15)), 0);
  assert.equal(new Date(C.zonedToUtc(2024, 7, 1, 9, 0, 'America/New_York')).toISOString(), '2024-07-01T13:00:00.000Z');
  assert.equal(new Date(C.zonedToUtc(2024, 1, 1, 0, 0, 'Asia/Tokyo')).toISOString(), '2023-12-31T15:00:00.000Z');
  // Ambiguous (fall back 2024-11-03 01:30 in New York) → earlier (EDT) instant
  assert.equal(new Date(C.zonedToUtc(2024, 11, 3, 1, 30, 'America/New_York')).toISOString(), '2024-11-03T05:30:00.000Z');
  // Non-existent (spring forward 2024-03-10 02:30) → lands after the gap (03:30 EDT = 07:30Z)
  assert.equal(new Date(C.zonedToUtc(2024, 3, 10, 2, 30, 'America/New_York')).toISOString(), '2024-03-10T07:30:00.000Z');
  assert.equal(C.formatOffset(330), 'UTC+05:30');
  assert.equal(C.formatOffset(-210), 'UTC-03:30');
  assert.deepEqual(C.dstInfo('America/New_York', Date.UTC(2024, 6, 1)), { observes: true, active: true });
  assert.deepEqual(C.dstInfo('Asia/Karachi', Date.UTC(2024, 6, 1)), { observes: false, active: false });
  assert.deepEqual(C.dstInfo('Australia/Sydney', Date.UTC(2024, 0, 1)), { observes: true, active: true });
});

// ── cron ────────────────────────────────────────────────────────────────────
const FROM = new Date(Date.UTC(2024, 0, 1, 10, 7, 30)); // Mon 2024-01-01 10:07:30Z
const next = (expr: string, n = 5, from = FROM) => C.cronNext(expr, from, n, true).map(iso);

test('cron: every minute / every 15 minutes', () => {
  assert.deepEqual(next('* * * * *', 2), ['2024-01-01T10:08:00Z', '2024-01-01T10:09:00Z']);
  assert.deepEqual(next('*/15 * * * *', 3), ['2024-01-01T10:15:00Z', '2024-01-01T10:30:00Z', '2024-01-01T10:45:00Z']);
});
test('cron: strictly after `from`', () => {
  const at = new Date(Date.UTC(2024, 0, 1, 10, 15, 0));
  assert.deepEqual(next('*/15 * * * *', 1, at), ['2024-01-01T10:30:00Z']);
});
test('cron: ranges, lists, steps on ranges', () => {
  assert.deepEqual(next('0 9-17/4 * * *', 4), ['2024-01-01T13:00:00Z', '2024-01-01T17:00:00Z', '2024-01-02T09:00:00Z', '2024-01-02T13:00:00Z']);
  assert.deepEqual(next('5,35 10 * * *', 3), ['2024-01-01T10:35:00Z', '2024-01-02T10:05:00Z', '2024-01-02T10:35:00Z']);
  assert.deepEqual(next('10/20 * * * *', 3), ['2024-01-01T10:10:00Z', '2024-01-01T10:30:00Z', '2024-01-01T10:50:00Z']);
});
test('cron: weekdays and names', () => {
  // 2024-01-01 is a Monday
  assert.deepEqual(next('30 9 * * MON-FRI', 6), ['2024-01-02T09:30:00Z', '2024-01-03T09:30:00Z', '2024-01-04T09:30:00Z', '2024-01-05T09:30:00Z', '2024-01-08T09:30:00Z', '2024-01-09T09:30:00Z']);
  assert.deepEqual(next('0 0 * * sun', 2), ['2024-01-07T00:00:00Z', '2024-01-14T00:00:00Z']);
  assert.deepEqual(next('0 0 * * 7', 1), ['2024-01-07T00:00:00Z']);
  assert.deepEqual(next('0 0 * * 5-7', 3), ['2024-01-05T00:00:00Z', '2024-01-06T00:00:00Z', '2024-01-07T00:00:00Z']);
  assert.deepEqual(next('0 0 1 jan,jul *', 2), ['2024-07-01T00:00:00Z', '2025-01-01T00:00:00Z']);
  assert.deepEqual(next('0 12 * * MON,WED', 2), ['2024-01-01T12:00:00Z', '2024-01-03T12:00:00Z']);
});
test('cron: day-of-month OR day-of-week when both restricted', () => {
  // 13th of the month OR any Friday
  assert.deepEqual(next('0 0 13 * 5', 4), ['2024-01-05T00:00:00Z', '2024-01-12T00:00:00Z', '2024-01-13T00:00:00Z', '2024-01-19T00:00:00Z']);
});
test('cron: month ends and leap days', () => {
  assert.deepEqual(next('0 0 31 * *', 3), ['2024-01-31T00:00:00Z', '2024-03-31T00:00:00Z', '2024-05-31T00:00:00Z']);
  assert.deepEqual(next('0 0 29 2 *', 2), ['2024-02-29T00:00:00Z', '2028-02-29T00:00:00Z']);
});
test('cron: 6-field with seconds', () => {
  assert.deepEqual(next('*/20 * * * * *', 3), ['2024-01-01T10:07:40Z', '2024-01-01T10:08:00Z', '2024-01-01T10:08:20Z']);
  assert.deepEqual(next('15 30 10 * * *', 2), ['2024-01-01T10:30:15Z', '2024-01-02T10:30:15Z']);
  assert.equal(C.parseCron('0 */5 * * * *').hasSeconds, true);
});
test('cron: macros', () => {
  assert.deepEqual(next('@hourly', 2), ['2024-01-01T11:00:00Z', '2024-01-01T12:00:00Z']);
  assert.deepEqual(next('@daily', 1), ['2024-01-02T00:00:00Z']);
  assert.deepEqual(next('@weekly', 1), ['2024-01-07T00:00:00Z']);
  assert.deepEqual(next('@monthly', 1), ['2024-02-01T00:00:00Z']);
  assert.deepEqual(next('@yearly', 1), ['2025-01-01T00:00:00Z']);
  assert.deepEqual(next('@ANNUALLY', 1), ['2025-01-01T00:00:00Z']);
});
test('cron: field expansion', () => {
  const c = C.parseCron('0 9-17/4 * * 1-5');
  assert.deepEqual(c.hours, [9, 13, 17]);
  assert.deepEqual(c.dows, [1, 2, 3, 4, 5]);
  assert.equal(C.describeValues(c.dows, 'dow'), 'Mon, Tue, Wed, Thu, Fri');
  assert.equal(C.describeValues(c.months, 'month'), 'every');
  assert.equal(c.normalized, '0 0 9-17/4 * * 1-5');
});
test('cron: errors', () => {
  for (const [expr, re] of [
    ['', /Empty/], ['* * * *', /Expected 5 fields/], ['* * * * * * *', /Expected 5 fields/],
    ['60 * * * *', /minute value 60 is out of range/], ['* 24 * * *', /hour value 24/], ['* * 0 * *', /day-of-month value 0/],
    ['* * * 13 *', /month value 13/], ['* * * * 8', /day-of-week value 8/], ['*/0 * * * *', /Invalid step/],
    ['5-1 * * * *', /backwards/], ['a * * * *', /Invalid minute value "a"/], ['@every5m', /Unknown macro/],
    ['0 0 L * *', /not supported/], ['0 0 * * 5#2', /not supported/], ['0 0 30 2 *', /never runs/], ['1,,2 * * * *', /Empty item/],
  ] as [string, RegExp][]) {
    assert.throws(() => C.parseCron(expr), re, expr || '(empty)');
  }
});
test('cron: local-time evaluation produces local wall-clock times', () => {
  const runs = C.cronNext('30 9 * * *', new Date(2024, 0, 1, 12, 0, 0), 3, false);
  assert.equal(runs.length, 3);
  for (const r of runs) { assert.equal(r.getHours(), 9); assert.equal(r.getMinutes(), 30); }
  assert.equal(runs[0].getDate(), 2);
});
test('cron: DST transitions in local time (America/New_York)', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    if (new Date(2024, 0, 1).getTimezoneOffset() !== 300) return; // runtime TZ switching unsupported here
    // 02:30 doesn't exist on 2024-03-10 → skipped
    assert.deepEqual(C.cronNext('30 2 * * *', new Date(2024, 2, 9, 12), 2).map(iso), ['2024-03-11T06:30:00Z', '2024-03-12T06:30:00Z']);
    // 01:30 happens twice on 2024-11-03
    assert.deepEqual(C.cronNext('30 1 * * *', new Date(2024, 10, 2, 12), 3).map(iso), ['2024-11-03T05:30:00Z', '2024-11-03T06:30:00Z', '2024-11-04T06:30:00Z']);
    assert.deepEqual(C.cronNext('0 0 * * *', new Date(2024, 2, 9, 12), 2).map(iso), ['2024-03-10T05:00:00Z', '2024-03-11T04:00:00Z']);
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
