#!/usr/bin/env node
/* Intraday prices for the dashboard: the latest Yahoo Finance price of every ticker in data/scan.json.
   Runs every few minutes while the US market is open and writes a small quotes.json
   (the workflow publishes it on the `live` branch, so the main branch and the website are not rebuilt each time).

   node quotes.js --out quotes.json          only while the market is open (and for 20 minutes after the close)
   node quotes.js --out quotes.json --force  any time
   Needs Node 18+. */
'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const OUT = opt('out', 'quotes.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const px = x => x == null || !isFinite(x) ? null : (Math.abs(x) < 5 ? Math.round(x * 10000) / 10000 : Math.round(x * 100) / 100);

async function meta(sym) {
  const y = sym.replace('.', '-'); let err;
  for (let a = 0; a < 3; a++) {
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=1d&interval=1d`, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json(); const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
        if (!m || m.regularMarketPrice == null) throw new Error('no price');
        return m;
      } catch (e) { err = e; }
    }
    await sleep(1200 * (a + 1));
  }
  throw err;
}
// [price, unix time of the price, day low, day high]
const row = m => [px(m.regularMarketPrice), m.regularMarketTime || null, px(m.regularMarketDayLow), px(m.regularMarketDayHigh)];

async function main() {
  const scan = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'scan.json'), 'utf8'));
  const syms = scan.rows.map(r => r.s);
  const now = Date.now() / 1000;
  const probe = await meta('SPY'); const reg = probe.currentTradingPeriod && probe.currentTradingPeriod.regular;
  const open = !!reg && now >= reg.start && now < reg.end;
  if (!opt('force') && !(reg && now >= reg.start && now < reg.end + 20 * 60)) { console.log('market closed – nothing to do'); return; }

  const q = {}, failed = []; const queue = syms.slice();
  async function worker() { while (queue.length) { const s = queue.shift(); try { q[s] = row(await meta(s)); } catch (e) { failed.push(s); } await sleep(60); } }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (Object.keys(q).length < syms.length * 0.8) { console.error(`only ${Object.keys(q).length}/${syms.length} prices – not publishing`); process.exit(1); }
  fs.writeFileSync(OUT, JSON.stringify({ t: Math.round(Date.now() / 1000), open, scanAsOf: scan.asOf, q }));
  console.log(`${Object.keys(q).length}/${syms.length} prices · market ${open ? 'open' : 'closed'} · ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB` + (failed.length ? ' · failed: ' + failed.join(',') : ''));
}
main().catch(e => { console.error(e); process.exit(1); });
