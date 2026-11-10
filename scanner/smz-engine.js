/* Smart Money Zones – scan engine.
   One file, no dependencies. Runs in Node (the daily scan) and in a browser.

   Method (Peter DiCarlo / THT "Smart Money Zones"):
     1. Find the last bullish impulse leg: swing low -> swing high that broke structure (BOS).
     2. Retracement of that leg, measured from the high:
          0.618 – 0.786  institutional buy zone
          0.786 – 0.826  Smart Money Zone (optimal entry)
     3. Entry only inside the zone, confirmed by B-Xtrender momentum turning up.
     4. Stop: close below the SMZ (tight) or below the leg's low (structural).
     5. Targets: the leg's high (equal highs), then the 1.272 / 1.618 extensions.

   bars: [{t: unix seconds, o, h, l, c, v}], oldest first. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMZ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    version: 1,
    d: { strength: 10, lookback: 520, minLegAtr: 6, minLegPct: 0.12, nearAtr: 1.5, recent: 15, chart: 260 },
    w: { strength: 6, lookback: 270, minLegAtr: 5, minLegPct: 0.25, nearAtr: 1.5, recent: 8, chart: 200 },
    inst: 0.618, smzTop: 0.786, smzBot: 0.826,   // retracement levels
    entry1: 0.705, entry2: 0.806,                // limit prices: middle of each zone
    stopPct: 0.01, stopAtr: 0.5,                 // tight stop sits under the SMZ by the larger of 1% / half an ATR
    ext1: 1.272, ext2: 1.618,
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

  /* Bullish legs that are still valid, most recent first.
     A leg starts at a swing low and ends at the highest high made since.
     Valid when: the high broke the swing high that preceded the low (break of structure),
     the low has not been traded through since, and the leg is big enough to matter. */
  function findLegs(bars, swings, cfg, a) {
    const n = bars.length - 1; const legs = [];
    // suffix arrays: index of the highest high / the lowest low from i to the end
    const hiI = new Array(n + 2).fill(-1), loV = new Array(n + 2).fill(Infinity);
    for (let i = n; i >= 0; i--) {
      hiI[i] = (hiI[i + 1] < 0 || bars[i].h >= bars[hiI[i + 1]].h) ? i : hiI[i + 1];
      loV[i] = Math.min(bars[i].l, loV[i + 1]);
    }
    for (let k = swings.length - 1; k >= 0; k--) {
      const s = swings[k]; if (s.type !== 'L' || s.i >= n) continue;
      if (loV[s.i + 1] < s.price) continue;                 // low was swept later: not the origin of anything live
      const hI = hiI[s.i + 1]; const H = bars[hI].h; const R = H - s.price;
      if (!(R > 0)) continue;
      let prevH = null; for (let j = k - 1; j >= 0; j--) if (swings[j].type === 'H') { prevH = swings[j]; break; }
      if (prevH && !(H > prevH.price)) continue;            // no break of structure
      if (R < cfg.minLegAtr * a || R / s.price < cfg.minLegPct) continue;
      legs.push({ lowI: s.i, low: s.price, highI: hI, high: H, R, bos: prevH ? prevH.price : null });
    }
    return legs;
  }

  function levels(low, high) {
    const R = high - low; const r = x => high - R * x;
    return { inst: r(CFG.inst), smzTop: r(CFG.smzTop), smzBot: r(CFG.smzBot), eq: r(0.5), e1: r(CFG.entry1), e2: r(CFG.entry2),
      t1: high, t2: low + R * CFG.ext1, t3: low + R * CFG.ext2 };
  }

  /* One timeframe: pick the live leg, place the price inside it, build the trade plan. */
  function analyze(barsAll, tf) {
    const cfg = CFG[tf]; const bars = barsAll.slice(-cfg.lookback);
    if (bars.length < cfg.strength * 2 + 40) return null;
    const n = bars.length - 1, last = bars[n]; const a = atr(bars, 14); if (!(a > 0)) return null;
    const swings = findSwings(bars, cfg.strength);
    const legs = findLegs(bars, swings, cfg, a);
    if (!legs.length) return null;
    const c = last.c;
    // primary leg: the most recent one whose SMZ still holds on a closing basis; otherwise the most recent
    let pi = legs.findIndex(L => c >= levels(L.low, L.high).smzBot); if (pi < 0) pi = 0;
    const leg = legs[pi], Z = levels(leg.low, leg.high);
    const outer = legs.slice(pi + 1).find(L => L.low < leg.low) || null;

    // what the price did since the high
    let minLow = Infinity, touches = 0, inside = false, lastTouch = -1;
    for (let i = leg.highI + 1; i <= n; i++) {
      const b = bars[i]; if (b.l < minLow) minLow = b.l;
      const t = b.l <= Z.inst; if (t && !inside) touches++; if (t) lastTouch = i; inside = t;
    }
    const sinceTouch = lastTouch < 0 ? null : n - lastTouch;

    let status;
    if (c > Z.inst) status = (sinceTouch != null && sinceTouch <= cfg.recent) ? 'bounce' : ((c - Z.inst) <= cfg.nearAtr * a ? 'near' : 'premium');
    else if (c > Z.smzTop) status = 'inst';
    else if (c >= Z.smzBot) status = 'smz';
    else status = 'deep';

    const bx = bxtrender(bars.map(b => b.c)); const bs = bxState(bx.short);
    const bl = bx.long[n], blp = bx.long[n - 1];

    // plan: enter at the close when inside the zone, otherwise the resting limit in the middle of the institutional zone
    const inZone = status === 'inst' || status === 'smz';
    const entry = (inZone || status === 'deep') ? c : Z.e1;
    const stopTight = Z.smzBot - Math.max(Z.smzBot * CFG.stopPct, a * CFG.stopAtr);
    const stopStruct = leg.low - Math.max(leg.low * CFG.stopPct, a * CFG.stopAtr);
    const stop = status === 'deep' ? stopStruct : stopTight;
    const risk = entry - stop;

    return {
      tf, status, price: c, atr: a,
      leg: { low: leg.low, lowT: bars[leg.lowI].t, high: leg.high, highT: bars[leg.highI].t, bos: leg.bos },
      z: Z, outer: outer ? { low: outer.low, lowT: bars[outer.lowI].t, high: outer.high, highT: bars[outer.highI].t } : null,
      pos: (leg.high - c) / leg.R,                      // retracement depth of the last close (0 = at the high, 1 = at the low)
      touches, sinceTouch, wickSMZ: isFinite(minLow) && minLow <= Z.smzTop,
      bx: bs, bxLong: isFinite(bl) ? { v: +bl.toFixed(1), rising: bl > blp } : null,
      plan: { entry, stop, stopTight, stopStruct, rr: risk > 0 ? (Z.t1 - entry) / risk : null,
        riskPct: risk > 0 ? risk / entry * 100 : null, upPct: (Z.t1 - entry) / entry * 100 },
    };
  }

  /* Grade of one timeframe result
       A  inside the zone + momentum confirmation (BX higher low or red->green flip)
       B  inside the zone, no confirmation yet
       C  approaching the zone
       D  closed below the SMZ – the tight stop is out, only the leg's low still holds
       E  bounced out of the zone within the last few bars
       -  far above the zone (waiting for a pullback) */
  function grade(r) {
    if (!r) return null;
    const trig = r.bx && (r.bx.trigger === 'hl' || r.bx.trigger === 'flip');
    if (r.status === 'inst' || r.status === 'smz') return trig ? 'A' : 'B';
    if (r.status === 'near') return 'C';
    if (r.status === 'deep') return 'D';
    if (r.status === 'bounce') return 'E';
    return '-';
  }

  function score(r, other) {
    if (!r) return 0; let s = 0;
    const depth = Math.max(0, Math.min(1, (r.pos - CFG.inst) / (CFG.smzTop - CFG.inst)));
    s += { smz: 30, inst: 20 + depth * 8, deep: 10, near: 10, bounce: 8, premium: 0 }[r.status] || 0;
    if (r.wickSMZ && r.status === 'inst') s += 4;
    if (r.bx) s += r.bx.trigger === 'flip' ? 25 : r.bx.trigger === 'hl' ? 18 + Math.min(4, (r.bx.age || 0) * 2) : r.bx.trigger === 'up' ? 6 : 0;
    if (r.plan.rr != null) s += Math.max(0, Math.min(15, r.plan.rr * 3));
    s += r.touches <= 1 ? 6 : r.touches === 2 ? 3 : r.touches >= 4 ? -4 : 0;
    if (other) {                                           // agreement of the other timeframe
      if (other.status === 'inst' || other.status === 'smz') s += 10;
      else if (other.pos >= 0.5) s += 5;
      if (other.bx && other.bx.rising) s += 5;
    }
    return Math.round(Math.max(0, Math.min(100, s)));
  }

  /* Full scan of one ticker from daily bars. Returns null when there is too little history. */
  function scanTicker(daily) {
    if (!daily || daily.length < 120) return null;
    const weekly = toWeekly(daily);
    const d = analyze(daily, 'd'); const w = analyze(weekly, 'w');
    const n = daily.length - 1; const last = daily[n], prev = daily[n - 1];
    const out = { price: last.c, chg: prev ? (last.c / prev.c - 1) * 100 : 0, t: last.t, d: null, w: null, weekly };
    if (d) { d.grade = grade(d); d.score = score(d, w); out.d = d; }
    if (w) { w.grade = grade(w); w.score = score(w, d); out.w = w; }
    return out;
  }

  /* ---------- output: one compact row per ticker, the shape scan.json and the dashboard share ---------- */
  const px = x => x == null || !isFinite(x) ? null : (Math.abs(x) < 5 ? Math.round(x * 10000) / 10000 : Math.round(x * 100) / 100);
  const day = t => new Date(t * 1000).toISOString().slice(0, 10);
  function packTf(a) {
    if (!a) return null;
    return { g: a.grade, st: a.status, sc: a.score, lo: px(a.leg.low), lt: day(a.leg.lowT), hi: px(a.leg.high), ht: day(a.leg.highT),
      atr: px(a.atr), pos: +a.pos.toFixed(3), tc: a.touches, ago: a.sinceTouch, wk: a.wickSMZ ? 1 : 0,
      bx: a.bx ? [a.bx.v, a.bx.rising ? 1 : 0, a.bx.trigger, a.bx.age] : null, bl: a.bxLong ? [a.bxLong.v, a.bxLong.rising ? 1 : 0] : null,
      en: px(a.plan.entry), sl: px(a.plan.stopTight), ss: px(a.plan.stopStruct), rr: a.plan.rr == null ? null : +a.plan.rr.toFixed(1),
      ol: a.outer ? px(a.outer.low) : null, oh: a.outer ? px(a.outer.high) : null };
  }
  /* meta: {name, idx: ['sp','ndx','x']} */
  function buildRow(sym, meta, daily) {
    const r = scanTicker(daily);
    if (!r) return { s: sym, n: meta.name || sym, i: meta.idx || [], short: 1, p: daily && daily.length ? px(daily[daily.length - 1].c) : null };
    const dn = CFG.d.chart, wn = CFG.w.chart;
    return { s: sym, n: meta.name || sym, i: meta.idx || [], p: px(r.price), ch: +r.chg.toFixed(2), t: day(r.t),
      d: packTf(r.d), w: packTf(r.w),
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
      cfg: { inst: CFG.inst, smzTop: CFG.smzTop, smzBot: CFG.smzBot, entry1: CFG.entry1, entry2: CFG.entry2, ext1: CFG.ext1, ext2: CFG.ext2 }, rows }, info || {});
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

  return { CFG, ema, rsi, bxtrender, bxState, atr, toWeekly, findSwings, findLegs, levels, analyze, grade, score, scanTicker,
    px, day, buildRow, buildScan, barsFromYahoo };
});
