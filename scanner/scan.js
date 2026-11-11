#!/usr/bin/env node
/* Daily Smart Money Zones scan: S&P 500 + Nasdaq-100 (+ extra-tickers.txt).
   Fetches daily bars from Yahoo Finance, runs smz-engine.js, writes data/scan.json for the dashboard.

   node scan.js                      full scan
   node scan.js --only HOOD,NVDA     a few tickers (does not touch scan.json unless --out is given)
   node scan.js --fixture file.json  bars from a local file instead of the network (tests)
   Needs Node 18+ (built-in fetch). No packages to install. */
'use strict';
const fs = require('fs'), path = require('path');
const SMZ = require('./smz-engine.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const DATA = path.join(__dirname, 'data');
const OUT = opt('out', opt('only') ? null : path.join(DATA, 'scan.json'));
const CONC = +opt('concurrency', 5);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, as) {
  let err;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
      if (r.status === 429 || r.status >= 500) { err = new Error('HTTP ' + r.status); await sleep(1500 * (a + 1) ** 2); continue; }
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { fatal: true });
      return as === 'json' ? await r.json() : await r.text();
    } catch (e) { err = e; if (e.fatal) break; await sleep(800 * (a + 1)); }
  }
  throw err;
}

/* ---------- universe ---------- */
function parseSp500(csv) {
  const out = {}; const lines = csv.trim().split(/\r?\n/).slice(1);
  for (const ln of lines) { const m = ln.match(/^([^,]+),("([^"]*)"|[^,]*)/); if (m) out[m[1].trim()] = (m[3] || m[2] || '').trim(); }
  return out;
}
// first cell of every row of the "Ticker" table on Wikipedia's list of Nasdaq-100 companies
function parseNdx(html) {
  const out = []; const i = html.search(/<th[^>]*>\s*Ticker/i); if (i < 0) return out;
  const tbl = html.slice(i, html.indexOf('</table>', i));
  for (const row of tbl.split(/<tr[^>]*>/).slice(1)) {
    const m = row.match(/<td[^>]*>([\s\S]*?)<\/td>/); if (!m) continue;
    const s = m[1].replace(/<[^>]+>/g, '').trim(); if (/^[A-Z][A-Z.]{0,5}$/.test(s)) out.push(s);
  }
  return out;
}
async function loadUniverse() {
  const cacheFile = path.join(DATA, 'universe.json');
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { sp: {}, ndx: [] };
  let sp = cache.sp, ndx = cache.ndx; const notes = [];
  try {
    const got = parseSp500(await get('https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'));
    if (Object.keys(got).length >= 450) sp = got; else throw new Error('only ' + Object.keys(got).length + ' rows');
  } catch (e) { notes.push('S&P 500 list not refreshed (' + e.message + '), using the saved one'); }
  try {
    const j = await get('https://en.wikipedia.org/w/api.php?action=parse&page=List_of_NASDAQ-100_companies&prop=text&format=json', 'json');
    const got = parseNdx(j.parse.text['*']);
    if (got.length >= 90) ndx = got; else throw new Error('only ' + got.length + ' rows');
  } catch (e) { notes.push('Nasdaq-100 list not refreshed (' + e.message + '), using the saved one'); }
  const extraFile = path.join(__dirname, 'extra-tickers.txt');
  const extra = fs.existsSync(extraFile) ? fs.readFileSync(extraFile, 'utf8').split(/\r?\n/).map(s => s.replace(/#.*/, '').trim().toUpperCase()).filter(Boolean) : [];
  if (!opt('fixture') && !opt('only')) fs.writeFileSync(cacheFile, JSON.stringify({ sp, ndx }, null, 0));
  const U = {};
  for (const s of Object.keys(sp)) U[s] = { name: sp[s], idx: ['sp'] };
  for (const s of ndx) (U[s] = U[s] || { name: s, idx: [] }).idx.push('ndx');
  for (const s of extra) if (!U[s]) U[s] = { name: s, idx: ['x'] };
  return { U, notes };
}

/* ---------- prices ---------- */
async function yahooBars(sym) {
  const y = sym.replace('.', '-'); let err;
  for (const host of ['query1', 'query2']) {
    try {
      const j = await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=5y&interval=1d`, 'json');
      const res = j.chart && j.chart.result && j.chart.result[0]; if (!res) throw new Error('empty response');
      return { bars: SMZ.barsFromYahoo(res, Date.now() / 1000), name: res.meta.longName || res.meta.shortName };
    } catch (e) { err = e; }
  }
  throw err;
}
function fixtureSource(file) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  return async sym => {
    const b = fx.bars[sym]; if (!b) throw new Error('not in fixture');
    return { bars: b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i] })), name: fx.meta[sym] && fx.meta[sym].name };
  };
}

async function main() {
  const t0 = Date.now();
  const { U, notes } = await loadUniverse();
  let syms = Object.keys(U);
  const fixture = opt('fixture'); const source = fixture ? fixtureSource(fixture) : yahooBars;
  if (opt('only')) syms = String(opt('only')).toUpperCase().split(',').map(s => { if (!U[s]) U[s] = { name: s, idx: ['x'] }; return s; });
  else if (fixture) syms = syms.filter(s => JSON.parse(fs.readFileSync(fixture, 'utf8')).bars[s]);

  const rows = [], failed = []; const queue = syms.slice();
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      try { const { bars, name } = await source(s); rows.push(SMZ.buildRow(s, { name: name || U[s].name, idx: U[s].idx }, bars)); }
      catch (e) { failed.push(s + ' (' + e.message + ')'); }
      if (!fixture) await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: fixture ? 1 : CONC }, worker));

  const okShare = rows.length / Math.max(1, syms.length);
  if (okShare < 0.8) { console.error(`Only ${rows.length}/${syms.length} tickers loaded – not writing scan.json.\n` + failed.slice(0, 15).join('\n')); process.exit(1); }
  const prev = OUT && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  const scan = SMZ.buildScan(rows, prev, { universe: { sp: syms.filter(s => U[s].idx.includes('sp')).length, ndx: syms.filter(s => U[s].idx.includes('ndx')).length, total: syms.length }, failed, notes, source: fixture ? 'fixture' : 'Yahoo Finance' });

  const cnt = { d: {}, w: {} }; for (const r of scan.rows) for (const tf of ['d', 'w']) if (r[tf]) cnt[tf][r[tf].g] = (cnt[tf][r[tf].g] || 0) + 1;
  console.log(`as of ${scan.asOf} · ${rows.length}/${syms.length} tickers · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!fixture && prev && prev.asOf && scan.asOf <= prev.asOf) console.log(`note: no newer close than the previous scan (${prev.asOf}); Yahoo may not have published today's bar yet`);
  console.log('daily ', JSON.stringify(cnt.d)); console.log('weekly', JSON.stringify(cnt.w));
  if (failed.length) console.log('failed:', failed.join(', '));
  notes.forEach(n => console.log('note:', n));
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(scan)); console.log('wrote', path.relative(process.cwd(), OUT), (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB'); }
  else for (const r of scan.rows) console.log(JSON.stringify({ s: r.s, p: r.p, d: r.d, w: r.w }));
}
main().catch(e => { console.error(e); process.exit(1); });
