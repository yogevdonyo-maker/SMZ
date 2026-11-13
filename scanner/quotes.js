#!/usr/bin/env node
/* Live prices for the dashboard: the latest Yahoo Finance price of every ticker in data/scan.json.

   node quotes.js --out quotes.json [--force]     one pass, write the file (only while the market is open unless --force)
   node quotes.js --loop --dir out [--force]      stay running through the trading day and publish a fresh quotes.json
                                                  to the repo's `live` branch every minute (what the workflow runs)

   The loop asks Yahoo for prices in batches of 20 and refreshes the day's high/low with a full per-ticker pass every
   15 minutes. With the market-wide universe the tickers are split in two tiers: the index members, the watch list and
   every stock in or near a zone (grades A–E) are refreshed every minute; the rest (far above their zones, or without
   a valid range) every COLD_EVERY minutes. The `live` branch always holds a single commit.
   Needs Node 18+. In loop mode: GH_REMOTE (push URL with a token), GITHUB_REPOSITORY, GITHUB_TOKEN. */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const now = () => Date.now() / 1000;
const px = x => x == null || !isFinite(x) ? null : (Math.abs(x) < 5 ? Math.round(x * 10000) / 10000 : Math.round(x * 100) / 100);
const ysym = s => s.replace('.', '-');
const STEP = +process.env.SMZ_STEP || 60;   // seconds between publishes
const FULL_EVERY = 15 * 60;           // seconds between full passes (day high/low) of the hot tier
const COLD_EVERY = +process.env.SMZ_COLD_EVERY || 5;   // rounds between refreshes of the cold tier
const HOT_GRADES = new Set(['A', 'B', 'C', 'D', 'E']);
const isHot = r => (r.i || []).some(i => i === 'sp' || i === 'ndx' || i === 'x') || (r.d && HOT_GRADES.has(r.d.g)) || (r.w && HOT_GRADES.has(r.w.g));
const MAX_RUN = 5 * 3600 + 40 * 60;   // a GitHub job may run 6 hours; hand over before that
const FRESH = 150;                    // a published file younger than this means another run is feeding the branch

async function yahoo(pathAndQuery) {
  let err;
  for (let a = 0; a < 3; a++) {
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com${pathAndQuery}`, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { err = e; }
    }
    await sleep(1000 * (a + 1));
  }
  throw err;
}
async function chartMeta(sym) {
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(ysym(sym))}?range=1d&interval=1d`);
  const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || m.regularMarketPrice == null) throw new Error('no price');
  return m;
}
async function pool(items, n, fn, gap) { const q = items.slice(); await Promise.all(Array.from({ length: n }, async () => { while (q.length) { await fn(q.shift()); if (gap) await sleep(gap); } })); }

/* Q[sym] = [price, unix time of the price, day low, day high] */
// full pass: one request per ticker, brings the day's range
async function fullPass(syms, Q) {
  let ok = 0;
  await pool(syms, 6, async s => { try { const m = await chartMeta(s); Q[s] = [px(m.regularMarketPrice), m.regularMarketTime || null, px(m.regularMarketDayLow), px(m.regularMarketDayHigh)]; ok++; } catch (e) { } }, 60);
  return ok;
}
// quick pass: 20 tickers per request, price and time only; the range is widened by what we see
async function quickPass(syms, Q) {
  const chunks = []; for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));
  let ok = 0;
  await pool(chunks, 4, async ch => {
    try {
      const j = await yahoo(`/v8/finance/spark?symbols=${ch.map(s => encodeURIComponent(ysym(s))).join(',')}&range=1d&interval=1d`);
      for (const s of ch) {
        const v = j[ysym(s)]; const p = v && v.close && px(v.close[v.close.length - 1]); const t = v && v.timestamp && v.timestamp[v.timestamp.length - 1];
        if (p == null || !t) continue;
        const old = Q[s]; const sameDay = old && old[1] && Math.abs(t - old[1]) < 20 * 3600;
        Q[s] = [p, t, sameDay && old[2] != null ? Math.min(old[2], p) : p, sameDay && old[3] != null ? Math.max(old[3], p) : p]; ok++;
      }
    } catch (e) { }
  }, 40);
  return ok;
}

function git(dir, a) { return execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
async function remoteQuotes() {
  const repo = process.env.GITHUB_REPOSITORY; if (!repo) return null;
  try {
    const h = { 'Accept': 'application/vnd.github.raw+json', 'User-Agent': 'smz-quotes' }; if (process.env.GITHUB_TOKEN) h.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/quotes.json?ref=live`, { headers: h, cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function main() {
  const scan = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'scan.json'), 'utf8'));
  const syms = scan.rows.map(r => r.s); const force = !!opt('force'); const loop = !!opt('loop');
  const hot = scan.rows.filter(isHot).map(r => r.s), cold = scan.rows.filter(r => !isHot(r)).map(r => r.s);
  const probe = await chartMeta('SPY'); const reg = probe.currentTradingPeriod && probe.currentTradingPeriod.regular;
  if (!reg) throw new Error('no trading hours from Yahoo');
  const isOpen = () => now() >= reg.start && now() < reg.end;
  const Q = {};
  const payload = extra => JSON.stringify(Object.assign({ t: Math.round(now()), open: isOpen(), scanAsOf: scan.asOf, q: Q }, extra));

  if (!loop) {
    if (!force && !(now() >= reg.start && now() < reg.end + 20 * 60)) { console.log('market closed – nothing to do'); return; }
    const ok = await fullPass(syms, Q);
    if (ok < syms.length * 0.8) { console.error(`only ${ok}/${syms.length} prices – not writing`); process.exit(1); }
    fs.writeFileSync(opt('out', 'quotes.json'), payload()); console.log(`${ok}/${syms.length} prices · market ${isOpen() ? 'open' : 'closed'}`); return;
  }

  /* ----- loop ----- */
  const T0 = now(); const inWindow = now() >= reg.start - 40 * 60 && now() < reg.end + 6 * 60;
  if (!inWindow && !force) { console.log('market closed – nothing to do'); return; }
  // is another run already feeding the branch?
  let remote = await remoteQuotes();
  if (remote && now() - remote.t < FRESH) {
    if (!(remote.loopStart && now() - remote.loopStart > 5 * 3600)) { console.log('another run is publishing – leaving it to it'); return; }
    console.log('standing by to take over from a run that is about to end');
    const until = now() + 50 * 60;
    while (now() < until) { await sleep(20000); remote = await remoteQuotes(); if (!remote || now() - remote.t >= FRESH) break; }
    if (remote && now() - remote.t < FRESH) { console.log('the other run is still publishing – leaving'); return; }
  }
  if (inWindow && now() < reg.start) { console.log(`waiting ${Math.round(reg.start - now())}s for the open`); await sleep((reg.start - now() + 5) * 1000); }

  const dir = path.resolve(String(opt('dir', 'out'))); fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'live']); git(dir, ['config', 'user.name', 'smz-quotes']); git(dir, ['config', 'user.email', 'actions@users.noreply.github.com']);
  const REMOTE = process.env.GH_REMOTE; if (!REMOTE) throw new Error('GH_REMOTE is not set');
  const loopStart = Math.round(now()); let prevSha = null, lastFull = 0, n = 0, pushed = 0;

  for (;;) {
    const t0 = now();
    // every round: the hot tier (full pass for the day's range every FULL_EVERY, otherwise quick); every COLD_EVERY rounds: the cold tier too (quick)
    const withCold = cold.length && n % COLD_EVERY === 0;
    let ok, asked = hot.length + (withCold ? cold.length : 0);
    if (t0 - lastFull >= FULL_EVERY) { ok = await fullPass(hot, Q); lastFull = t0; } else ok = await quickPass(hot, Q);
    if (withCold) ok += await quickPass(cold, Q);
    if (ok >= asked * 0.8) {
      fs.writeFileSync(path.join(dir, 'quotes.json'), payload({ loopStart }));
      git(dir, ['add', 'quotes.json']); git(dir, prevSha ? ['commit', '-q', '--amend', '-m', 'quotes'] : ['commit', '-q', '-m', 'quotes']);
      const sha = git(dir, ['rev-parse', 'HEAD']).trim();
      try {
        git(dir, prevSha ? ['push', '-q', '--force-with-lease=live:' + prevSha, REMOTE, 'HEAD:live'] : ['push', '-q', '-f', REMOTE, 'HEAD:live']);
        prevSha = sha; pushed++;
      } catch (e) {
        // the branch is not where we left it: either another run took over, or the push just failed
        const r = await remoteQuotes();
        if (r && r.loopStart && r.loopStart !== loopStart && now() - r.t < FRESH) { console.log('another run took over – stopping'); break; }
        console.log('push failed, retrying on the next round'); prevSha = null;
      }
    } else console.log(`round ${n}: only ${ok}/${asked} prices, skipped`);
    n++;
    if (n === 1 || n % 30 === 0) console.log(`round ${n} · ${ok}/${asked} prices (${hot.length} hot, ${cold.length} cold) · ${pushed} published · market ${isOpen() ? 'open' : 'closed'}`);
    if (!inWindow && n >= 2) break;                                  // forced run outside market hours: a couple of rounds
    if (inWindow && now() >= reg.end + 5 * 60) break;                // closing prices are in
    if (now() - T0 > MAX_RUN) { console.log('time limit – the next scheduled run takes over'); break; }
    await sleep((t0 + STEP - now()) * 1000);
  }
  console.log(`done · ${n} rounds · ${pushed} published`);
}
main().catch(e => { console.error(e && e.message ? e.message : e); process.exit(1); });
