/* Smart Money Zones – scan engine (v2).
   One file, no dependencies. Runs in Node (the daily scan) and in a browser.

   Method: Peter DiCarlo's Smart Money Zones, as taught in his course and applied in his published analyses
   (HOOD, HIMS, ORCL, ALAB, MRVL, BE, NBIS, AAOI – November 2026). test/run-fixture.js checks the engine against them.
     1. Range: the last bullish leg, swing low -> swing high, that broke structure (BOS).
        The range stays valid until price CLOSES below the swing low more than once in a row; a wick or a single close does not break it.
     2. Retracement of the range, measured from the high:
          0.618 – 0.786  institutional zone: accumulation area, early
          0.786 – 0.826  Smart Money Zone: the buy zone ("above it, price is outside the zone")
          below 0.826, above the swing low: deep discount, still a buy while the low holds
     3. A buy-side zone only counts while the bigger trend is bullish: a daily setup needs a valid weekly range.
     4. Confirmation: B-Xtrender momentum turning up, or the weekly Stochastic RSI oversold ("rubber band").
     5. Stop: under the swing low, on a closing basis (structural). The tight alternative sits under the SMZ.
     6. Target: back to the swing high; then the 1.272 / 1.618 extensions. The setup must offer at least 3:1.
     7. Volume profile: the heavy shelf below price is the conservative entry; a thin stretch below price is a "fast lane".

   bars: [{t: unix seconds, o, h, l, c, v}], oldest first. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMZ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    version: 2,
    d: { strength: 10, lookback: 520, minLegAtr: 6, minLegPct: 0.12, nearAtr: 1.5, recent: 15, chart: 260, breakCloses: 2, gap: 5 },
    w: { strength: 6, lookback: 270, minLegAtr: 3, minLegPct: 0.25, nearAtr: 1.5, recent: 8, chart: 200, breakCloses: 2, gap: 2, cycle: 104 },
    inst: 0.618, smzTop: 0.786, smzBot: 0.826,   // retracement levels
    entry1: 0.705, entry2: 0.806,                // resting limits: middle of the institutional zone / of the SMZ
    stopPct: 0.02,                               // a stop level sits 2% under the swing low (or under the SMZ); it is acted on at a close
    ext1: 1.272, ext2: 1.618,
    minRR: 3,                                    // "at least $3 of upside for every $1 of risk"
    oversold: 20, extreme: 5,                    // weekly Stochastic RSI %K
    vpBins: 60, vpWindow: 520, vpShelf: 2, vpThin: 0.7, vpLane: 0.08,   // volume profile: bins, daily bars, shelf = 2x the average bin, thin = under 0.7x
  };

  /* ---------- indicators ---------- */
  function ema(src, n) {
    const out = new Array(src.length).fill(NaN); const k = 2 / (n + 1); let e = NaN, sum = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i]; if (!isFinite(v)) continue;
      if (cnt < n) { sum += v; cnt++; if (cnt === n) { e = sum / n; out[i] = e; } }
      else { e = v * k + e * (1 - k); out[i] = e; }
    }
    return out;
  }
  // Wilder RSI, same seeding as TradingView's ta.rsi
  function rsi(src, n) {
    const out = new Array(src.length).fill(NaN); let up = 0, dn = 0, cnt = 0, prev = NaN;
    const val = () => dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
    for (let i = 0; i < src.length; i++) {
      const v = src[i]; if (!isFinite(v)) continue;
      if (!isFinite(prev)) { prev = v; continue; }
      const ch = v - prev; prev = v; const u = Math.max(ch, 0), d = Math.max(-ch, 0);
      if (cnt < n) { up += u; dn += d; cnt++; if (cnt === n) { up /= n; dn /= n; out[i] = val(); } }
      else { up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + d) / n; out[i] = val(); }
    }
    return out;
  }
  /* B-Xtrender (Puppytherapy): short = RSI(EMA5 − EMA20, 15) − 50, long = RSI(EMA20, 15) − 50 */
  function bxtrender(closes) {
    const e5 = ema(closes, 5), e20 = ema(closes, 20);
    const diff = closes.map((_, i) => e5[i] - e20[i]);
    return { short: rsi(diff, 15).map(v => v - 50), long: rsi(e20, 15).map(v => v - 50) };
  }
  /* State of the short-term histogram on the last bar.
     green = above zero, red = below zero, rising = higher than the bar before.
     trigger: 'flip' red->green within the last 3 bars · 'hl' turned up while still red (higher low) ·
              'up' green and rising · 'none' falling */
  function bxState(series) {
    const n = series.length - 1; if (n < 3 || !isFinite(series[n]) || !isFinite(series[n - 1])) return null;
    const v = series[n], p = series[n - 1], rising = v > p;
    let trigger = 'none', age = null;
    for (let k = 0; k < 3 && n - k - 1 >= 0; k++) { if (series[n - k] > 0 && series[n - k - 1] <= 0) { trigger = 'flip'; age = k; break; } }
    if (trigger === 'none' && v <= 0 && rising) {
      let run = 1; while (n - run - 1 >= 0 && series[n - run] > series[n - run - 1]) run++;
      trigger = 'hl'; age = run - 1;
    }
    if (trigger === 'none' && v > 0 && rising) trigger = 'up';
    return { v: +v.toFixed(1), rising, green: v > 0, trigger, age };
  }
  function atr(bars, n) {
    if (bars.length < n + 1) return 0; let s = 0;
    for (let i = bars.length - n; i < bars.length; i++) { const b = bars[i], p = bars[i - 1]; s += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)); }
    return s / n;
  }

  // Stochastic RSI (14, 14, 3, 3): returns the %K series
  function stochRsiK(closes) {
    const r = rsi(closes, 14), raw = new Array(r.length).fill(NaN);
    for (let i = 13; i < r.length; i++) {
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let j = i - 13; j <= i; j++) { if (!isFinite(r[j])) { ok = false; break; } if (r[j] < lo) lo = r[j]; if (r[j] > hi) hi = r[j]; }
      if (ok) raw[i] = hi > lo ? (r[i] - lo) / (hi - lo) * 100 : 50;
    }
    return raw.map((_, i) => i >= 2 && isFinite(raw[i]) && isFinite(raw[i - 1]) && isFinite(raw[i - 2]) ? (raw[i] + raw[i - 1] + raw[i - 2]) / 3 : NaN);
  }
  /* Volume by price over the last `vpWindow` daily bars.
     poc   – the price with the most volume
     shelf – the first heavy block of volume below the last close (conservative entry / support)
     lane  – when volume is thin right below the close, the price that thin stretch runs down to ("fast lane") */
  function volumeProfile(dailyAll) {
    const d = dailyAll.slice(-CFG.vpWindow), B = CFG.vpBins; if (d.length < 60) return null;
    let lo = Infinity, hi = -Infinity, tot = 0; for (const b of d) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; tot += b.v || 0; }
    if (!(hi > lo) || !(tot > 0)) return null;
    const w = (hi - lo) / B, v = new Array(B).fill(0);
    for (const b of d) { const a = Math.max(0, Math.min(B - 1, Math.floor((b.l - lo) / w))), z = Math.max(0, Math.min(B - 1, Math.floor((b.h - lo) / w))); const share = (b.v || 0) / (z - a + 1); for (let k = a; k <= z; k++) v[k] += share; }
    const sm = v.map((x, i) => (x + (i > 0 ? v[i - 1] : x) + (i < B - 1 ? v[i + 1] : x)) / 3), mean = tot / B, mid = i => lo + (i + 0.5) * w;
    let pocI = 0; for (let i = 1; i < B; i++) if (sm[i] > sm[pocI]) pocI = i;
    const c = d[d.length - 1].c, ci = Math.max(0, Math.min(B - 1, Math.floor((c - lo) / w)));
    let shelf = null; for (let i = ci - 1; i >= 0; i--) if (sm[i] >= CFG.vpShelf * mean) { shelf = mid(i); break; }
    let lane = null;
    if (sm[ci] < CFG.vpThin * mean) { let i = ci; while (i > 0 && sm[i - 1] < mean) i--; const to = lo + i * w; if ((c - to) / c >= CFG.vpLane) lane = to; }
    return { poc: mid(pocI), shelf, lane };
  }

  /* ---------- bars ---------- */
  // daily -> weekly (weeks start Monday, UTC date of the bar)
  function toWeekly(daily) {
    const out = []; let cur = null, key = null;
    for (const b of daily) {
      const d = new Date(b.t * 1000); const dow = (d.getUTCDay() + 6) % 7;
      const k = Math.floor(b.t / 86400) - dow;
      if (k !== key) { if (cur) out.push(cur); key = k; cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; }
      else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; cur.v += b.v || 0; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ---------- structure ---------- */
  // swing highs/lows with `n` bars on each side, merged into an alternating zigzag
  function findSwings(bars, n) {
    const raw = [];
    for (let i = n; i < bars.length - n; i++) {
      let h = true, l = true;
      for (let j = i - n; j <= i + n; j++) {
        if (j === i) continue;
        if (bars[j].h >= bars[i].h) h = false;
        if (bars[j].l <= bars[i].l) l = false;
        if (!h && !l) break;
      }
      if (h) raw.push({ i, type: 'H', price: bars[i].h });
      if (l) raw.push({ i, type: 'L', price: bars[i].l });
    }
    raw.sort((a, b) => a.i - b.i || (a.type === 'L' ? -1 : 1));
    const out = [];
    for (const s of raw) {
      const last = out[out.length - 1];
      if (last && last.type === s.type) { if ((s.type === 'H' && s.price > last.price) || (s.type === 'L' && s.price < last.price)) out[out.length - 1] = s; }
      else out.push(s);
    }
    return out;
  }

  /* Bullish ranges that are still valid, most recent first.
     A range starts at a swing low and ends at the highest high made since.
     Valid when: the high broke the swing high that preceded the low (break of structure),
     price has not closed below the low `breakCloses` bars in a row, and the range is big enough to matter.
     On the weekly chart (cfg.cycle) the range is the cycle's range: its high must also clear every high of the
     two years before its low, so a lower high inside a pullback does not start a new long-term range. */
  function findLegs(bars, swings, cfg, a) {
    const n = bars.length - 1; const legs = [];
    const hiI = new Array(n + 2).fill(-1);
    for (let i = n; i >= 0; i--) hiI[i] = (hiI[i + 1] < 0 || bars[i].h >= bars[hiI[i + 1]].h) ? i : hiI[i + 1];
    for (let k = swings.length - 1; k >= 0; k--) {
      const s = swings[k]; if (s.type !== 'L' || s.i >= n) continue;
      let run = 0, broken = false, floor = s.price;
      for (let i = s.i + 1; i <= n; i++) { if (bars[i].c < s.price) { if (++run >= cfg.breakCloses) { broken = true; break; } } else run = 0; if (bars[i].l < floor) floor = bars[i].l; }
      if (broken) continue;
      const hI = hiI[s.i + 1]; const H = bars[hI].h; const R = H - s.price;
      if (!(R > 0)) continue;
      let prevH = null; for (let j = k - 1; j >= 0; j--) if (swings[j].type === 'H') { prevH = swings[j]; break; }
      if (prevH && !(H > prevH.price)) continue;            // no break of structure
      if (cfg.cycle) { let mx = -Infinity; for (let i = Math.max(0, s.i - cfg.cycle); i < s.i; i++) if (bars[i].h > mx) mx = bars[i].h; if (!(H > mx)) continue; }
      if (R < cfg.minLegAtr * a || R / s.price < cfg.minLegPct) continue;
      legs.push({ lowI: s.i, low: s.price, highI: hI, high: H, R, floor, bos: prevH ? prevH.price : null });
    }
    return legs;
  }

  function levels(low, high) {
    const R = high - low; const r = x => high - R * x;
    return { inst: r(CFG.inst), smzTop: r(CFG.smzTop), smzBot: r(CFG.smzBot), eq: r(0.5), e1: r(CFG.entry1), e2: r(CFG.entry2),
      t1: high, t2: low + R * CFG.ext1, t3: low + R * CFG.ext2 };
  }

  /* One timeframe: take the most recent valid range, place the price inside it, build the plan.
     ctx.soW – weekly Stochastic RSI %K (the same reading serves the daily and the weekly setup) */
  function analyze(barsAll, tf, ctx) {
    const cfg = CFG[tf]; const bars = barsAll.slice(-cfg.lookback);
    if (bars.length < cfg.strength * 2 + 40) return null;
    const n = bars.length - 1, last = bars[n]; const a = atr(bars, 14); if (!(a > 0)) return null;
    const swings = findSwings(bars, cfg.strength);
    const legs = findLegs(bars, swings, cfg, a);
    if (!legs.length) return null;
    const c = last.c;
    const leg = legs[0], Z = levels(leg.low, leg.high);
    const outer = legs.slice(1).find(L => L.low < leg.low) || null;
    const pos = (leg.high - c) / leg.R;                  // retracement depth of the last close (0 = at the high, 1 = at the low)

    // visits to the zones since the high
    let lastInst = -1; const eps = [];
    for (let i = leg.highI + 1; i <= n; i++) {
      const b = bars[i]; if (b.l <= Z.inst) lastInst = i;
      if (b.l <= Z.smzTop) { const e = eps[eps.length - 1]; if (e && i - e.end <= cfg.gap) { e.end = i; if (b.l < e.low) { e.low = b.l; e.lowI = i; } } else eps.push({ start: i, end: i, low: b.l, lowI: i }); }
    }
    const sinceInst = lastInst < 0 ? null : n - lastInst;
    // what the previous visit to the Smart Money Zone led to
    let prior = null;
    for (let k = eps.length - 1; k >= 0; k--) {
      const e = eps[k]; if (n - e.end <= cfg.gap) continue;              // still in progress
      const to = k + 1 < eps.length ? eps[k + 1].start - 1 : n; let mx = -Infinity; for (let i = e.end + 1; i <= to; i++) if (bars[i].h > mx) mx = bars[i].h;
      if (isFinite(mx)) prior = { t: bars[e.lowI].t, pct: (mx / e.low - 1) * 100 }; break;
    }

    let status;
    if (c < leg.low) status = 'under';                   // one close under the swing low: the range is on its last test
    else if (pos > CFG.smzBot) status = 'deep';
    else if (pos >= CFG.smzTop) status = 'smz';
    else if (pos >= CFG.inst) status = 'inst';
    else status = (sinceInst != null && sinceInst <= cfg.recent) ? 'bounce' : ((c - Z.inst) <= cfg.nearAtr * a ? 'near' : 'premium');

    const bx = bxtrender(bars.map(b => b.c)); const bs = bxState(bx.short);
    const bl = bx.long[n], blp = bx.long[n - 1];
    const soW = ctx && isFinite(ctx.soW) ? ctx.soW : null;
    const conf = []; if (bs && (bs.trigger === 'hl' || bs.trigger === 'flip')) conf.push('bx'); if (soW != null && soW < CFG.oversold) conf.push('so');

    // plan: at the close when price is in the institutional zone or deeper, otherwise the resting limit in the middle of the SMZ
    const inRange = status === 'inst' || status === 'smz' || status === 'deep' || status === 'under';
    const entry = inRange ? c : Z.e2;
    const stopStruct = leg.floor * (1 - CFG.stopPct);
    const tight = Z.smzBot * (1 - CFG.stopPct);
    const stopTight = entry > tight ? tight : null;      // only exists while price is above the SMZ floor
    const risk = entry - stopStruct;

    return {
      tf, status, price: c, atr: a,
      leg: { low: leg.low, lowT: bars[leg.lowI].t, high: leg.high, highT: bars[leg.highI].t, floor: leg.floor, bos: leg.bos },
      z: Z, outer: outer ? { low: outer.low, lowT: bars[outer.lowI].t, high: outer.high, highT: bars[outer.highI].t } : null,
      pos, touches: eps.length, sinceTouch: sinceInst, prior,
      bx: bs, bxLong: isFinite(bl) ? { v: +bl.toFixed(1), rising: bl > blp } : null, soW, conf,
      plan: { entry, stopStruct, stopTight, rr: risk > 0 ? (Z.t1 - entry) / risk : null,
        riskPct: risk > 0 ? risk / entry * 100 : null, upPct: (Z.t1 - entry) / entry * 100 },
    };
  }

  /* Grade of one timeframe result
       A  in the buy zone (SMZ or deeper, swing low holding) + confirmation + at least 3:1 + bigger trend bullish
       B  in the buy zone, a condition is still missing (r.why lists which: conf / rr / htf / under)
       C  in the institutional zone: accumulation area, early for a trade
       D  approaching the zones
       E  bounced out of the zones within the last few bars
       -  far above (waiting for a pullback)
     htfOk: for a daily setup, whether the weekly range is valid. Always true for the weekly setup (no monthly data here). */
  function grade(r, htfOk) {
    if (!r) return null; r.why = [];
    if (r.status === 'smz' || r.status === 'deep' || r.status === 'under') {
      if (r.status === 'under') r.why.push('under');
      if (!r.conf.length) r.why.push('conf');
      if (!(r.plan.rr >= CFG.minRR)) r.why.push('rr');
      if (!htfOk) r.why.push('htf');
      return r.why.length ? 'B' : 'A';
    }
    if (r.status === 'inst') return 'C';
    if (r.status === 'near') return 'D';
    if (r.status === 'bounce') return 'E';
    return '-';
  }

  function score(r, other, htfOk, vp) {
    if (!r) return 0; let s = 0;
    const depth = Math.max(0, Math.min(1, (r.pos - CFG.inst) / (CFG.smzTop - CFG.inst)));
    s += { smz: 30, deep: 28, under: 12, inst: 10 + depth * 8, near: 8, bounce: 6, premium: 0 }[r.status] || 0;
    if (r.bx) s += r.bx.trigger === 'flip' ? 18 : r.bx.trigger === 'hl' ? 14 : r.bx.trigger === 'up' ? 4 : 0;
    if (r.soW != null) s += r.soW < CFG.extreme ? 12 : r.soW < CFG.oversold ? 8 : 0;
    if (r.plan.rr != null) s += Math.max(0, Math.min(15, r.plan.rr * 2.5));
    if (r.tf === 'd' && htfOk) s += 8;
    if (other) s += (other.status === 'smz' || other.status === 'deep') ? 6 : other.status === 'inst' ? 3 : 0;
    if (r.prior && r.prior.pct >= 20) s += 5;
    if (vp) { if (vp.shelf != null && vp.shelf <= r.price && vp.shelf >= r.plan.stopStruct) s += 4; if (vp.lane != null) s -= 3; }
    return Math.round(Math.max(0, Math.min(100, s)));
  }

  /* Full scan of one ticker from daily bars. Returns null when there is too little history. */
  function scanTicker(daily) {
    if (!daily || daily.length < 120) return null;
    const weekly = toWeekly(daily);
    const kw = stochRsiK(weekly.map(b => b.c)); const soW = kw[kw.length - 1];
    const d = analyze(daily, 'd', { soW }); const w = analyze(weekly, 'w', { soW });
    const vp = volumeProfile(daily);
    const htf = !!w && w.status !== 'under';            // weekly structure still bullish
    const n = daily.length - 1; const last = daily[n], prev = daily[n - 1];
    const out = { price: last.c, chg: prev ? (last.c / prev.c - 1) * 100 : 0, t: last.t, d: null, w: null, weekly, vp, soW: isFinite(soW) ? soW : null, htf };
    if (d) { d.grade = grade(d, htf); d.score = score(d, w, htf, vp); out.d = d; }
    if (w) { w.grade = grade(w, true); w.score = score(w, d, true, vp); out.w = w; }
    return out;
  }

  /* ---------- output: one compact row per ticker, the shape scan.json and the dashboard share ---------- */
  const px = x => x == null || !isFinite(x) ? null : (Math.abs(x) < 5 ? Math.round(x * 10000) / 10000 : Math.round(x * 100) / 100);
  const day = t => new Date(t * 1000).toISOString().slice(0, 10);
  function packTf(a) {
    if (!a) return null;
    return { g: a.grade, st: a.status, sc: a.score, why: a.why, lo: px(a.leg.low), lt: day(a.leg.lowT), hi: px(a.leg.high), ht: day(a.leg.highT),
      fl: a.leg.floor < a.leg.low ? px(a.leg.floor) : null,
      atr: px(a.atr), pos: +a.pos.toFixed(3), tc: a.touches, ago: a.sinceTouch,
      bx: a.bx ? [a.bx.v, a.bx.rising ? 1 : 0, a.bx.trigger, a.bx.age] : null, bl: a.bxLong ? [a.bxLong.v, a.bxLong.rising ? 1 : 0] : null, cf: a.conf,
      en: px(a.plan.entry), ss: px(a.plan.stopStruct), sl: px(a.plan.stopTight), rr: a.plan.rr == null ? null : +a.plan.rr.toFixed(1),
      pb: a.prior ? [day(a.prior.t), Math.round(a.prior.pct)] : null,
      ol: a.outer ? px(a.outer.low) : null, oh: a.outer ? px(a.outer.high) : null };
  }
  /* meta: {name, idx: ['sp','ndx','x']} */
  function buildRow(sym, meta, daily) {
    const r = scanTicker(daily);
    if (!r) return { s: sym, n: meta.name || sym, i: meta.idx || [], short: 1, p: daily && daily.length ? px(daily[daily.length - 1].c) : null };
    const dn = CFG.d.chart, wn = CFG.w.chart;
    return { s: sym, n: meta.name || sym, i: meta.idx || [], p: px(r.price), ch: +r.chg.toFixed(2), t: day(r.t),
      d: packTf(r.d), w: packTf(r.w),
      so: r.soW == null ? null : +r.soW.toFixed(1), hf: r.htf ? 1 : 0,
      vp: r.vp ? { poc: px(r.vp.poc), sh: px(r.vp.shelf), ln: px(r.vp.lane) } : null,
      cd: daily.slice(-dn).map(b => px(b.c)), d0: day(daily[Math.max(0, daily.length - dn)].t),
      cw: r.weekly.slice(-wn).map(b => px(b.c)), w0: day(r.weekly[Math.max(0, r.weekly.length - wn)].t),
      _dt: daily.slice(-dn).map(b => day(b.t)), _wt: r.weekly.slice(-wn).map(b => day(b.t)) };   // dates of the chart points; buildScan keeps one shared copy
  }
  // carry over "since when does it hold this grade" from the previous scan
  function buildScan(rows, prevScan, info) {
    const prev = {}; if (prevScan && prevScan.rows) for (const r of prevScan.rows) prev[r.s] = r;
    let asOf = null; for (const r of rows) if (r.t && (!asOf || r.t > asOf)) asOf = r.t;
    // every ticker trades on the same days, so the chart dates are stored once (from the longest up-to-date series)
    const cal = { d: [], w: [] };
    for (const r of rows) {
      if (r.t === asOf && r._dt && r._dt.length > cal.d.length) cal.d = r._dt;
      if (r.t === asOf && r._wt && r._wt.length > cal.w.length) cal.w = r._wt;
      delete r._dt; delete r._wt;
    }
    for (const r of rows) for (const tf of ['d', 'w']) {
      const a = r[tf]; if (!a) continue; const p = prev[r.s] && prev[r.s][tf];
      a.since = p && p.g === a.g && p.since ? p.since : r.t;
      if (p && p.g !== a.g) a.was = p.g;
    }
    rows.sort((x, y) => x.s < y.s ? -1 : 1);
    return Object.assign({ v: CFG.version, asOf, generated: new Date().toISOString(), cal,
      cfg: { inst: CFG.inst, smzTop: CFG.smzTop, smzBot: CFG.smzBot, entry1: CFG.entry1, entry2: CFG.entry2, ext1: CFG.ext1, ext2: CFG.ext2, minRR: CFG.minRR, oversold: CFG.oversold, extreme: CFG.extreme }, rows }, info || {});
  }
  // bars from a Yahoo chart response; drops the still-forming bar of an open session
  function barsFromYahoo(res, nowSec) {
    const Q = res.indicators.quote[0], T = res.timestamp || []; const bars = [];
    for (let i = 0; i < T.length; i++) {
      const c = Q.close[i]; if (c == null || Q.high[i] == null || Q.low[i] == null) continue;
      bars.push({ t: T[i], o: Q.open[i] == null ? c : Q.open[i], h: Q.high[i], l: Q.low[i], c, v: Q.volume[i] || 0 });
    }
    const reg = res.meta && res.meta.currentTradingPeriod && res.meta.currentTradingPeriod.regular;
    if (bars.length && reg && bars[bars.length - 1].t >= reg.start && nowSec < reg.end) bars.pop();
    return bars;
  }

  return { CFG, ema, rsi, bxtrender, bxState, stochRsiK, volumeProfile, atr, toWeekly, findSwings, findLegs, levels, analyze, grade, score, scanTicker,
    px, day, buildRow, buildScan, barsFromYahoo };
});
