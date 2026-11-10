// Checks the engine on real daily bars captured from Yahoo (through the close of 2026-11-09) against the levels
// Peter DiCarlo published for the same stocks in November 2026. Each case is evaluated as of the article's date.
const fs = require('fs'), path = require('path');
const S = require('../smz-engine.js');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-2026-11-09.json'), 'utf8'));
const bars = (s, until) => { const b = fx.bars[s]; let a = b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i] })); if (until) a = a.filter(x => S.day(x.t) <= until); return a; };
const f = x => x == null ? null : +(+x).toFixed(2);
let fail = 0; const ok = (name, cond, got) => { if (!cond) fail++; console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name + (got !== undefined ? '  -> ' + JSON.stringify(got) : '')); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) >= Math.max(a1, b1);
const at = (s, d) => S.scanTicker(bars(s, d));

console.log('— HOOD, article of 9 Nov (prices of 6 Nov): bullish daily structure, weekly extremely oversold, long-term zone $60–50, target = swing high');
{ const r = at('HOOD', '2026-11-06');
  ok('weekly range 29.66 → 153.86 (all-time high)', near(r.w.leg.low, 29.66, 0.1) && near(r.w.leg.high, 153.86, 0.1), [r.w.leg.low, r.w.leg.high]);
  ok('weekly SMZ inside $60–50', r.w.z.smzTop < 60 && r.w.z.smzBot > 50, [f(r.w.z.smzBot), f(r.w.z.smzTop)]);
  ok('weekly Stochastic RSI extremely oversold', r.soW < S.CFG.extreme, f(r.soW));
  ok('daily: in the buy zone and confirmed (he called a long trade here)', r.d.grade === 'A', [r.d.grade, r.d.status, r.d.conf]);
  ok('daily target = swing high 126.74 (his ~$128–130)', near(r.d.z.t1, 126.74, 0.1), r.d.z.t1); }

console.log('— HIMS, 9 Nov (close $26.00): daily structure bullish above the $21.44 swing low, stop on closes under $22, target ~$38');
{ const r = at('HIMS', '2026-11-06');
  ok('daily range starts at the 21.5 swing low', near(r.d.leg.low, 21.44, 0.2), r.d.leg.low);
  ok('daily target = July high ~39 (his ~$38)', near(r.d.z.t1, 38, 1.5), r.d.z.t1);
  ok('structural stop just under $22', r.d.plan.stopStruct < 22 && r.d.plan.stopStruct > 20.5, f(r.d.plan.stopStruct));
  ok('weekly oversold', r.soW < S.CFG.oversold, f(r.soW)); }

console.log('— ORCL, 7 Nov (close $116.10): range April 2025 low → September 2025 high, alive unless several weekly closes under the low; hold above $105');
{ const r = at('ORCL', '2026-11-06');
  ok('weekly range 118.86 → 345.72 survives the wicks and the single weekly close under the low', near(r.w.leg.low, 118.86, 0.1) && near(r.w.leg.high, 345.72, 0.1), [r.w.leg.low, r.w.leg.high]);
  ok('price is at the bottom of the range', r.w.pos > 0.95, f(r.w.pos));
  ok('structural stop ≈ $105 (under the 109.21 low)', near(r.w.plan.stopStruct, 105, 3), f(r.w.plan.stopStruct));
  const later = at('ORCL'); ok('back above the low on 9 Nov: deep discount, range intact', later.w.status === 'deep' && near(later.w.leg.low, 118.86, 0.1), later.w.status); }

console.log('— ALAB, 7 Nov (close $190.71): weekly SMZ $170–184, stop on a break of structure at $93, target ~$500–520');
{ const r = at('ALAB', '2026-11-06');
  ok('weekly SMZ ≈ 170–184', near(r.w.z.smzTop, 184, 2) && near(r.w.z.smzBot, 170, 3), [f(r.w.z.smzBot), f(r.w.z.smzTop)]);
  ok('structural stop ≈ $93', near(r.w.plan.stopStruct, 93, 4), f(r.w.plan.stopStruct));
  ok('target = swing high 499.48', near(r.w.z.t1, 499.48, 0.1), r.w.z.t1);
  ok('just above the SMZ: accumulation zone, not yet the buy zone', r.w.status === 'inst' && r.w.grade === 'C', [r.w.status, r.w.grade]); }

console.log('— BE, 6 Nov: buy $150–166, "above $166 price is outside the zone", line in the sand = close under the $113 swing low, last visit (27 Jul) rallied 90%+');
{ const r = at('BE', '2026-11-06');
  ok('range 116.5 → 351.28 on both timeframes', near(r.w.leg.low, 116.5, 0.1) && near(r.d.leg.low, 116.5, 0.1) && near(r.w.leg.high, 351.28, 0.1), [r.d.leg.low, r.w.leg.low, r.w.leg.high]);
  ok('SMZ top ≈ $166', near(r.w.z.smzTop, 166, 1.5), f(r.w.z.smzTop));
  ok('structural stop ≈ $113', near(r.w.plan.stopStruct, 113, 2), f(r.w.plan.stopStruct));
  ok('at $173 the price is outside the buy zone', r.w.grade === 'C', r.w.grade);
  ok('previous visit to the SMZ: late July, +90% or more', r.d.prior && S.day(r.d.prior.t) >= '2026-07-27' && S.day(r.d.prior.t) <= '2026-07-31' && r.d.prior.pct > 90, r.d.prior && [S.day(r.d.prior.t), Math.round(r.d.prior.pct)]);
  const one = at('BE', '2026-11-05'); ok('the day before, at $167.5, price was at the top of the buy zone', one.d.pos > 0.78 && one.d.pos < 0.80, f(one.d.pos)); }

console.log('— NBIS, 6 Nov (prices of 5 Nov): back in the weekly SMZ (~$120–123), target $300, volume point of control ~$90');
{ const r = at('NBIS', '2026-11-05');
  ok('weekly SMZ top ≈ $122', near(r.w.z.smzTop, 122, 1.5), f(r.w.z.smzTop));
  ok('price inside the weekly SMZ, confirmed, 3:1 or better', r.w.status === 'smz' && r.w.grade === 'A' && r.w.plan.rr >= 3, [r.w.status, r.w.grade, f(r.w.plan.rr)]);
  ok('target = swing high 299.86', near(r.w.z.t1, 299.86, 0.1), r.w.z.t1);
  ok('volume point of control ≈ $90', near(r.vp.poc, 90, 5), f(r.vp.poc)); }

console.log('— MRVL, 5 Nov (close $133.55): long-term SMZ $112–120, price ~11% above it, target ~$330, heavy volume at $100 / $90, "fast lane" below');
{ const r = at('MRVL', '2026-11-05');
  ok('weekly SMZ overlaps his $112–120', overlap(r.w.z.smzBot, r.w.z.smzTop, 112, 120), [f(r.w.z.smzBot), f(r.w.z.smzTop)]);
  ok('price above the SMZ, in the institutional zone', r.w.status === 'inst', r.w.status);
  ok('target = all-time high ~330', near(r.w.z.t1, 330, 1), r.w.z.t1);
  ok('heavy volume shelf between $90 and $100', r.vp.shelf >= 88 && r.vp.shelf <= 101, f(r.vp.shelf));
  ok('thin volume right below the price (fast lane)', r.vp.lane != null && r.vp.lane < 125, f(r.vp.lane)); }

console.log('— AAOI, 5 Nov: in the long-term Smart Money Zone after a 70% sell-off, target = swing high, conservative entry $33 (volume gap)');
{ const r = at('AAOI', '2026-11-05');
  ok('weekly: in the buy zone', ['smz', 'deep'].includes(r.w.status), [r.w.status, f(r.w.pos)]);
  ok('target = swing high 233.67 (his $200–240)', near(r.w.z.t1, 233.67, 0.1), r.w.z.t1);
  ok('volume shelf ≈ $33', near(r.vp.shelf, 33, 3), f(r.vp.shelf)); }

console.log('— earlier calls and mechanics');
{ const vrt = at('VRT'); ok('VRT weekly range 147.82 → 379.93 (his stop under $147, target $380)', near(vrt.w.leg.low, 147.82, 0.1) && near(vrt.w.leg.high, 379.93, 0.1), [vrt.w.leg.low, vrt.w.leg.high]);
  const meta = at('META'); ok('META daily SMZ ≈ 580–590 (his "optimal zone $580–600")', meta.d.z.smzTop > 580 && meta.d.z.smzTop < 600, [f(meta.d.z.smzBot), f(meta.d.z.smzTop)]);
  const Z = S.levels(100, 200); ok('levels of a 100 → 200 range', f(Z.inst) === 138.2 && f(Z.smzTop) === 121.4 && f(Z.smzBot) === 117.4 && f(Z.t2) === 227.2 && f(Z.t3) === 261.8);
  const d = bars('NVDA'), w = S.toWeekly(d); const wk = w[w.length - 5]; const days = d.filter(b => b.t >= wk.t && b.t < w[w.length - 4].t);
  ok('weekly bar = max/min/last of its days', days.length <= 5 && wk.h === Math.max(...days.map(b => b.h)) && wk.l === Math.min(...days.map(b => b.l)) && wk.c === days[days.length - 1].c);
  ok('short history is flagged, not scanned', S.buildRow('SPCX', { name: 'x' }, bars('SPCX')).short === 1);
  // a setup is A only with confirmation, 3:1 and a bullish weekly structure
  let bad = 0, n = 0; for (const s of Object.keys(fx.bars)) { const r = S.scanTicker(bars(s)); if (!r) continue; for (const tf of ['d', 'w']) { const a = r[tf]; if (!a) continue; n++;
    if (a.grade === 'A' && !(a.conf.length && a.plan.rr >= S.CFG.minRR && ['smz', 'deep'].includes(a.status) && (tf === 'w' || r.htf))) bad++;
    if (a.plan.stopStruct >= a.price && a.status !== 'under') bad++; } }
  ok(`grade A always meets every condition (${n} setups checked)`, bad === 0, bad); }
console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
