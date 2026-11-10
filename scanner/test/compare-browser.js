// The first full scan was computed in a browser tab (the only place with network access to Yahoo at the time).
// This checks that the rows in data/scan.json equal what smz-engine.js gives in Node for the fixture tickers.
// The fixture bars were rounded to cents, so numbers may differ in the last digit.
const fs = require('fs'), path = require('path'); const S = require('../smz-engine.js');
const scan = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'scan.json'), 'utf8'));
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-2026-11-09.json'), 'utf8'));
if (scan.asOf !== '2026-11-09') { console.log('scan.json is newer than the fixture – nothing to compare'); process.exit(0); }
let bad = 0;
const cmp = (a, b, p) => {
  if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > Math.max(0.011, Math.abs(a) * 0.0015)) { bad++; console.log('  ', p, a, b); } return; }
  if (a && b && typeof a === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) cmp(a[k], b[k], p + '.' + k); return; }
  if (a !== b) { bad++; console.log('  ', p, a, b); }
};
for (const s of Object.keys(fx.bars)) {
  const b = fx.bars[s]; const bars = b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i] }));
  const page = scan.rows.find(r => r.s === s); const node = S.buildScan([S.buildRow(s, { name: page.n, idx: page.i }, bars)], null).rows[0];
  cmp(node, page, s);
}
console.log(bad ? bad + ' differences' : 'all fixture tickers match');
process.exit(bad ? 1 : 0);
