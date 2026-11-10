// Runs the engine on real bars captured from Yahoo (close of 2026-11-09) and checks the levels against known values.
const fs = require('fs'), path = require('path');
const S = require('../smz-engine.js');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-2026-11-09.json'), 'utf8'));
const bars = s => { const b = fx.bars[s]; return b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i] })); };
const f = x => x == null ? null : +(+x).toFixed(2);
let fail = 0; const ok = (name, cond, got) => { if (!cond) fail++; console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name + (got !== undefined ? '  -> ' + JSON.stringify(got) : '')); };
for (const s of Object.keys(fx.bars)) {
  const row = S.buildRow(s, { name: fx.meta[s].name, idx: [] }, bars(s));
  const line = a => a ? `${a.g} ${a.st} sc${a.sc} leg ${a.lo}(${a.lt})→${a.hi}(${a.ht}) en ${a.en} sl ${a.sl} ss ${a.ss} rr ${a.rr} bx ${JSON.stringify(a.bx)} outer ${a.ol}` : 'none';
  console.log(s.padEnd(5), row.p, row.short ? 'SHORT HISTORY' : '\n   d: ' + line(row.d) + '\n   w: ' + line(row.w));
}
// HOOD – Peter DiCarlo's 9 Nov 2026 article: the level that matters is ~$76 (SMZ of the leg from the 52-week low), long-term zone $60–50, target = swing high
const hood = S.scanTicker(bars('HOOD'));
const outerZ = S.levels(hood.d.outer.low, hood.d.outer.high);
ok('HOOD daily outer leg starts at the 52-week low 63.5', Math.abs(hood.d.outer.low - 63.51) < 0.1, hood.d.outer.low);
ok('HOOD daily outer SMZ brackets $76', outerZ.smzBot < 76 && outerZ.smzTop > 76, [f(outerZ.smzBot), f(outerZ.smzTop)]);
ok('HOOD weekly SMZ inside $60–50', hood.w.z.smzTop < 60 && hood.w.z.smzBot > 50, [f(hood.w.z.smzBot), f(hood.w.z.smzTop)]);
ok('HOOD weekly leg ends at the all-time high 153.86', f(hood.w.leg.high) === 153.86, hood.w.leg.high);
// VRT – his weekly setup: target $380, stop on a close under $147
const vrt = S.scanTicker(bars('VRT'));
ok('VRT weekly leg 147.8 → 379.9', Math.abs(vrt.w.leg.low - 147.82) < 0.1 && Math.abs(vrt.w.leg.high - 379.93) < 0.1, [vrt.w.leg.low, vrt.w.leg.high]);
// META – his "optimal zone $580–600"
const meta = S.scanTicker(bars('META'));
ok('META daily SMZ ≈ 580–590', meta.d.z.smzTop > 580 && meta.d.z.smzTop < 600, [f(meta.d.z.smzBot), f(meta.d.z.smzTop)]);
// arithmetic of the levels
const Z = S.levels(100, 200);
ok('levels of a 100→200 leg', f(Z.inst) === 138.2 && f(Z.smzTop) === 121.4 && f(Z.smzBot) === 117.4 && f(Z.t2) === 227.2 && f(Z.t3) === 261.8, Z);
// weekly resample: every week has ≤5 days and the highs/lows agree with the daily bars
const d = bars('NVDA'), w = S.toWeekly(d);
const wk = w[w.length - 5]; const days = d.filter(b => b.t >= wk.t && b.t < w[w.length - 4].t);
ok('weekly bar = max/min of its days', days.length <= 5 && wk.h === Math.max(...days.map(b => b.h)) && wk.l === Math.min(...days.map(b => b.l)) && wk.c === days[days.length - 1].c, days.length);
ok('short history is flagged, not scanned', S.buildRow('SPCX', { name: 'x' }, bars('SPCX')).short === 1);
process.exit(fail ? 1 : 0);
