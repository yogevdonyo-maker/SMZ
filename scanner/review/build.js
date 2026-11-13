#!/usr/bin/env node
/* Builds a stock review in the layout of Peter DiCarlo's articles: HTML page + PDF.

   node scanner/review/build.js content.json [--scan path/scan.json] [--out dir]

   content.json holds the written parts (see example.json). The technical part – ranges, zones, entry, stops,
   targets, the math and the level map – is computed here from scan.json, so the numbers always match the scanner.
   Text fields accept **bold** and line breaks. Output: <out>/<TICKER>-review.html and .pdf. */
'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const contentFile = args.find(a => !a.startsWith('--') && a.endsWith('.json'));
if (!contentFile) { console.error('usage: build.js content.json [--scan scan.json] [--out dir]'); process.exit(2); }
const C = JSON.parse(fs.readFileSync(contentFile, 'utf8'));
const scanFile = opt('scan', path.join(__dirname, '..', 'data', 'scan.json'));
const S = fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, 'utf8')) : null;
const OUT = opt('out', path.join(__dirname, 'out')); fs.mkdirSync(OUT, { recursive: true });
const T = String(C.ticker).toUpperCase();
const row = S && S.rows.find(r => r.s === T);

/* ---------- helpers ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = s => String(s).replace(/(\$?[−-]?\d[\d,]*(?:\.\d+)?%?(?:[–-]\$?\d[\d,]*(?:\.\d+)?%?)?[MBK]?)/g, '<span class="num">$1</span>');
const md = s => num(esc(s)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const fmt = n => n == null || !isFinite(n) ? '–' : (Math.abs(n) >= 1000 ? n.toFixed(0) : Math.abs(n) >= 5 ? n.toFixed(2) : n.toFixed(3)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = (n, dp = 0) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(dp) + '%';
const heDate = d => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${+dd}.${+m}.${y}`; };
const font = f => 'data:font/woff2;base64,' + fs.readFileSync(path.join(__dirname, 'fonts', f)).toString('base64');
const faces = [['Heebo', 400, 'heebo'], ['Heebo', 500, 'heebo'], ['Heebo', 700, 'heebo'], ['Frank Ruhl Libre', 500, 'frank-ruhl-libre'], ['Frank Ruhl Libre', 700, 'frank-ruhl-libre']]
  .map(([fam, w, f]) => ['hebrew', 'latin'].map(sub => `@font-face{font-family:'${fam}';font-weight:${w};font-style:normal;font-display:block;src:url(${font(`${f}-${sub}-${w}-normal.woff2`)}) format('woff2');unicode-range:${sub === 'hebrew' ? 'U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F' : 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'};}`).join('')).join('\n');

/* ---------- technical part from the scanner ---------- */
const GR = { A: 'כניסה מאושרת', B: 'באזור הקנייה, חסר תנאי', C: 'אזור צבירה מוסדי', D: 'מתקרבת לאזור', E: 'יצאה מהאזור', '-': 'מעל האזורים' };
const STT = { smz: 'בתוך ה-Smart Money Zone', deep: 'בדיסקאונט עמוק, מתחת ל-SMZ', under: 'מתחת לשפל הטווח', inst: 'באזור המוסדי', near: 'קרוב לאזור', bounce: 'יצא מהאזור לאחרונה', premium: 'מעל האזורים' };
const TRIG = { flip: 'התהפך לירוק', hl: 'שפל עולה', up: 'ירוק ועולה', none: 'יורד' };
const WHY = { conf: 'אין אישור מומנטום', rr: 'יחס סיכוי/סיכון נמוך מ-3', htf: 'המבנה השבועי אינו עולה', under: 'סגירה מתחת לשפל הטווח' };
function tf(a) {
  if (!a) return null; const c = S.cfg, R = a.hi - a.lo, r = x => a.hi - R * x;
  const inst = r(c.inst), top = r(c.smzTop), bot = r(c.smzBot), t2 = a.lo + R * c.ext1, t3 = a.lo + R * c.ext2;
  const en = a.en, up = (a.hi - en) / en * 100, risk = (en - a.ss) / en * 100, rr = a.rr;
  const tightRisk = a.sl != null ? (en - a.sl) / en * 100 : null, tightRR = a.sl != null && en > a.sl ? (a.hi - en) / (en - a.sl) : null;
  return { a, inst, top, bot, t2, t3, en, up, risk, rr, tightRisk, tightRR };
}
const D = row && tf(row.d), W = row && tf(row.w);
const price = row ? row.p : null, asOf = S ? S.asOf : (C.asOf || '');

function levelMap() {
  if (!D && !W) return '';
  const cols = [D && { lab: `יומי · טווח ${fmt(D.a.lo)} → ${fmt(D.a.hi)}`, t: D }, W && { lab: `שבועי · טווח ${fmt(W.a.lo)} → ${fmt(W.a.hi)}`, t: W }].filter(Boolean);   // weekly on the right, as the page reads
  const vals = []; for (const c of cols) vals.push(c.t.a.hi, c.t.a.ss, c.t.inst, c.t.bot, price); if (row.vp && row.vp.poc) vals.push(row.vp.poc);
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const H = 230, top = 30, bot = 212, y = v => (top + (hi - v) / (hi - lo) * (bot - top));
  const colW = cols.length === 2 ? 300 : 620, gap = 20, W_ = 640;
  let svg = `<svg viewBox="0 0 ${W_} ${H}" role="img" aria-label="מפת הרמות" style="direction:ltr" direction="ltr"><rect width="${W_}" height="${H}" fill="var(--bg)"/>`;
  cols.forEach((c, i) => {
    const x0 = 10 + i * (colW + gap), t = c.t, x1 = x0 + colW;
    const labs = [{ v: t.a.hi, s: 'יעד 1', c: 'var(--up)' }, { v: t.inst, s: 'אזור מוסדי', c: 'var(--blue)' }, { v: t.top, s: 'SMZ', c: 'var(--smz)' }, { v: t.bot, s: '', c: 'var(--smz)' }, { v: t.a.ss, s: 'סטופ מבני', c: 'var(--down)' }, { v: price, s: 'סגירה', c: 'var(--fg)', b: 1 }];
    if (c.t === (W || D) && row.vp && row.vp.poc) labs.push({ v: row.vp.poc, s: 'נקודת שליטה בנפח', c: 'var(--muted)', d: 1 });
    svg += `<text x="${x0 + 2}" y="18" font-size="12" font-weight="700" fill="var(--fg)" text-anchor="start" unicode-bidi="plaintext">${esc(c.lab)}</text>`;
    svg += `<rect x="${x0}" y="${y(t.inst).toFixed(1)}" width="${colW}" height="${Math.max(1, y(t.top) - y(t.inst)).toFixed(1)}" fill="var(--inst-bg)"/>`;
    svg += `<rect x="${x0}" y="${y(t.top).toFixed(1)}" width="${colW}" height="${Math.max(1.5, y(t.bot) - y(t.top)).toFixed(1)}" fill="var(--smz-bg)"/>`;
    svg += `<line x1="${x0}" x2="${x1}" y1="${y(t.a.hi).toFixed(1)}" y2="${y(t.a.hi).toFixed(1)}" stroke="var(--up)" stroke-dasharray="4 3"/>`;
    svg += `<line x1="${x0}" x2="${x1}" y1="${y(t.a.ss).toFixed(1)}" y2="${y(t.a.ss).toFixed(1)}" stroke="var(--down)" stroke-dasharray="4 3"/>`;
    svg += `<line x1="${x0}" x2="${x1}" y1="${y(price).toFixed(1)}" y2="${y(price).toFixed(1)}" stroke="var(--fg)" stroke-width="2"/>`;
    if (labs.some(l => l.d)) { const p = labs.find(l => l.d); svg += `<line x1="${x0}" x2="${x1}" y1="${y(p.v).toFixed(1)}" y2="${y(p.v).toFixed(1)}" stroke="var(--muted)" stroke-dasharray="1 4"/>`; }
    const L = labs.filter(l => l.s).map(l => Object.assign({}, l, { y: y(l.v) })).sort((p, q) => p.y - q.y);
    for (let k = 1; k < L.length; k++) if (L[k].y - L[k - 1].y < 13) L[k].y = L[k - 1].y + 13;
    const over = L.length ? L[L.length - 1].y - (bot + 10) : 0; if (over > 0) for (const l of L) l.y -= over;
    for (const l of L) { const w = (fmt(l.v).length + l.s.length + 1) * 6.3 + 8; svg += `<rect x="${x0 + 1}" y="${(l.y - 7).toFixed(1)}" width="${w.toFixed(0)}" height="14" fill="var(--bg)" opacity=".92"/><text x="${x0 + 4}" y="${(l.y + 4).toFixed(1)}" font-size="11" fill="var(--muted)" text-anchor="start" unicode-bidi="plaintext"><tspan fill="${l.c}" font-weight="${l.b ? 700 : 600}">${fmt(l.v)}</tspan> ${esc(l.s)}</text>`; }
  });
  return svg + '</svg>';
}

function techHTML() {
  if (!row) return `<p class="muted">המניה אינה בסריקה, ולכן אין רמות טכניות אוטומטיות.</p>`;
  const F = C.framework || {};
  const setup = (t, name, horizon, what) => {
    if (!t) return `<h3>${name}</h3><p class="muted">אין טווח עולה תקף במסגרת הזמן הזו.</p>`;
    const a = t.a; const g = a.g === '-' ? '-' : a.g;
    const inZone = ['smz', 'deep', 'under', 'inst'].includes(a.st);
    const conf = [a.bx ? `BX Trender: ${TRIG[a.bx[2]]} (${a.bx[0] > 0 ? '+' : ''}${a.bx[0]})` : null, row.so != null ? `Stochastic RSI שבועי: ${row.so.toFixed(0)}${row.so < S.cfg.extreme ? ', מכירת יתר קיצונית' : row.so < S.cfg.oversold ? ', מכירת יתר' : ''}` : null].filter(Boolean).join(' · ');
    const why = a.g === 'B' && a.why && a.why.length ? ` <small>(${a.why.map(w => WHY[w]).join(', ')})</small>` : '';
    return `<h3>${name} · ${horizon}</h3>
<p><b>הטווח.</b> משפל של <span class="num">${fmt(a.lo)}</span> (${heDate(a.lt)}) לשיא של <span class="num">${fmt(a.hi)}</span> (${heDate(a.ht)}). הסגירה ב-<span class="num">${fmt(price)}</span> היא תיקון של <span class="num">${(a.pos * 100).toFixed(0)}%</span> מהשיא: ${STT[a.st]}. דירוג הסורק: <b>${GR[g]}</b>${why}.</p>
<p><b>האזורים.</b> אזור מוסדי <span class="num">${fmt(t.top)}–${fmt(t.inst)}</span> · Smart Money Zone <span class="num">${fmt(t.bot)}–${fmt(t.top)}</span>${a.ol != null ? ` · טווח חיצוני מ-<span class="num">${fmt(a.ol)}</span>` : ''}.</p>
<p><b>אישור.</b> ${conf || '–'}.</p>
<div class="math"><div class="mt">${what}</div><dl>
<dt>כניסה</dt><dd><span class="num">${fmt(t.en)}</span> <small>${inZone ? 'הסגירה האחרונה' : 'לימיט באמצע ה-SMZ'}</small></dd>
<dt>סטופ מבני</dt><dd><span class="num">${fmt(a.ss)}</span> <small>סגירה מתחת לשפל הטווח · סיכון <span class="num">${t.risk.toFixed(0)}%</span></small></dd>
${a.sl != null && t.tightRR ? `<dt>סטופ צמוד</dt><dd><span class="num">${fmt(a.sl)}</span> <small>סגירה מתחת ל-SMZ · סיכון <span class="num">${t.tightRisk.toFixed(1)}%</span> · יחס <span class="num">${t.tightRR.toFixed(1)}</span></small></dd>` : ''}
<dt>יעד 1</dt><dd><span class="num">${fmt(a.hi)}</span> <small>שיא הטווח · <span class="num">${pct(t.up)}</span></small></dd>
<dt>יעד 2 · 3</dt><dd><span class="num">${fmt(t.t2)}</span> · <span class="num">${fmt(t.t3)}</span> <small>הרחבות 1.272 / 1.618</small></dd>
<dt>סיכוי/סיכון</dt><dd><b class="num">${t.rr == null ? '–' : t.rr.toFixed(1)} : 1</b> <small>ליעד 1 מול הסטופ המבני</small></dd>
</dl></div>`;
  };
  const vp = row.vp || {};
  const vol = vp.sh != null || vp.ln != null ? `<p><b>נפח.</b> ${vp.sh != null ? `מדף הנפח הכבד הראשון מתחת למחיר ב-<span class="num">${fmt(vp.sh)}</span>, הכניסה השמרנית.` : ''} ${vp.ln != null ? `הנפח דליל ממש מתחת למחיר, מסלול מהיר עד <span class="num">${fmt(vp.ln)}</span>.` : ''} ${vp.poc != null ? `נקודת השליטה של השנתיים האחרונות ב-<span class="num">${fmt(vp.poc)}</span>.` : ''}</p>` : '';
  const prior = (D && D.a.pb) || (W && W.a.pb);
  return `${F.cycle ? `<p><b>איפה אנחנו במחזור.</b> ${md(F.cycle)}</p>` : ''}
<figure><div dir="ltr">${levelMap()}</div><figcaption>מפת הרמות לפי הסורק, נכון לסגירת ${heDate(asOf)}. כחול: אזור מוסדי (61.8%–78.6%). סגול: Smart Money Zone (78.6%–82.6%). הסטופים 2% מתחת לשפל הטווח, בסגירה.</figcaption></figure>
${F.now ? `<p><b>איפה המחיר עכשיו.</b> ${md(F.now)}</p>` : ''}
${setup(D, 'א. עסקה', '30–90 יום (הטווח היומי)', 'המתמטיקה של העסקה')}
${setup(W, 'ב. פוזיציה', '12–18 חודשים (הטווח השבועי)', 'המתמטיקה של הפוזיציה')}
${vol}
${prior ? `<p><b>הביקור הקודם באזור.</b> ${heDate(prior[0])}, ואחריו עלייה של <span class="num">${prior[1]}%</span>.</p>` : ''}
${F.breaks && F.breaks.length ? `<h3>מה ישנה את התמונה</h3><ul>${F.breaks.map(b => `<li>${md(b)}</li>`).join('')}</ul>` : ''}
${F.meet ? `<h3>איפה הגרף והפונדמנטלס נפגשים</h3><p>${md(F.meet)}</p>` : ''}`;
}

/* ---------- page ---------- */
const sec = s => `<h2>${esc(s.h)}</h2>${(s.p0 || []).map(p => `<p>${md(p)}</p>`).join('')}${s.table ? `<table>${s.table.map((r, i) => `<tr>${r.map(c => i === 0 ? `<th>${esc(c)}</th>` : `<td${/^[\s$−\-\d.,%MBK+]+$/.test(c) ? ' class="v"' : ''}>${md(c)}</td>`).join('')}</tr>`).join('')}</table>` : ''}${(s.b || []).length ? `<ul>${s.b.map(b => `<li>${md(b)}</li>`).join('')}</ul>` : ''}${(s.p || []).map(p => `<p>${md(p)}</p>`).join('')}`;
const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>סקירת ${esc(T)} – ${esc(C.company || '')}</title>
<style>
${faces}
:root{ --bg:#fbfbf9; --fg:#1b1d22; --muted:#6b6f78; --line:#e3e4e0; --panel:#f1f2ee; --up:#0b7a63; --down:#c6343f; --blue:#2457d6; --smz:#7a2c91; --smz-bg:rgba(122,44,145,.14); --inst-bg:rgba(36,87,214,.10); }
*{ box-sizing:border-box; } html,body{ margin:0; background:var(--bg); color:var(--fg); }
body{ font-family:'Heebo',system-ui,sans-serif; font-size:15px; line-height:1.6; }
.wrap{ max-width:72ch; margin:0 auto; padding:26px 20px 48px; }
.eyebrow{ color:var(--muted); font-size:12.5px; letter-spacing:.04em; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
h1{ font-family:'Frank Ruhl Libre',Georgia,serif; font-weight:700; font-size:30px; line-height:1.2; margin:8px 0 8px; }
h1 small{ display:block; font-family:'Heebo',sans-serif; font-weight:500; font-size:15px; color:var(--muted); margin-bottom:4px; }
h2{ font-family:'Frank Ruhl Libre',Georgia,serif; font-weight:700; font-size:21px; margin:28px 0 8px; break-after:avoid; }
h3{ font-size:15px; font-weight:700; margin:16px 0 6px; break-after:avoid; }
p{ margin:0 0 10px; } .lede{ font-size:16px; color:var(--muted); margin-bottom:14px; }
.disc{ font-size:12.5px; color:var(--muted); border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:8px 0; margin:0 0 18px; }
.num{ direction:ltr; unicode-bidi:isolate; font-variant-numeric:tabular-nums; }
ul{ padding-inline-start:20px; margin:0 0 10px; } li{ margin-bottom:4px; }
table{ border-collapse:collapse; width:100%; font-size:13.5px; margin:6px 0 12px; break-inside:avoid; }
th,td{ text-align:start; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } th{ color:var(--muted); font-weight:500; font-size:12.5px; }
td.v{ direction:ltr; text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.math{ background:var(--panel); border-radius:6px; padding:12px 14px; margin:10px 0 14px; break-inside:avoid; }
.math .mt{ font-weight:700; margin-bottom:6px; } .math dl{ display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:0; } .math dt{ color:var(--muted); } .math dd{ margin:0; }
.bb{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:8px 0 12px; break-inside:avoid; } .bb div{ border-top:3px solid var(--up); padding-top:8px; } .bb div + div{ border-color:var(--down); } .bb b{ display:block; margin-bottom:4px; }
.verdict{ border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin:8px 0 14px; break-inside:avoid; } .verdict .ans{ font-family:'Frank Ruhl Libre',Georgia,serif; font-size:20px; font-weight:700; margin-bottom:6px; }
figure{ margin:12px 0 16px; break-inside:avoid; } svg{ display:block; width:100%; height:auto; } figcaption{ font-size:12px; color:var(--muted); margin-top:4px; }
.muted{ color:var(--muted); } small{ color:var(--muted); }
.foot{ font-size:12px; color:var(--muted); margin-top:26px; border-top:1px solid var(--line); padding-top:10px; word-break:break-all; } .foot a{ color:var(--blue); }
@page{ size:A4; margin:16mm 14mm 18mm; }
@media print{ .wrap{ max-width:none; padding:0; } body{ font-size:12.5px; } h1{ font-size:26px; } h2{ font-size:18px; } }
@media (max-width:480px){ .bb{ grid-template-columns:1fr; } h1{ font-size:26px; } }
</style></head><body><div class="wrap">
<div class="eyebrow"><span>סקירה במתכונת Smart Money Zones</span><span>מחירים נכון לסגירת ${heDate(asOf)}</span></div>
<h1><small>${esc(C.company || '')} (${esc(T)})${price != null ? ` · <span class="num">${fmt(price)}</span>` : ''}</small>${esc(C.title || '')}</h1>
${C.lede ? `<p class="lede">${md(C.lede)}</p>` : ''}
<p class="disc">סקירה חינוכית שנכתבה במתכונת הניתוחים של פיטר דיקרלו, על בסיס הסורק ומקורות ציבוריים. אינה ייעוץ השקעות. יש לבדוק את הנתונים לפני כל פעולה.</p>
<h2>הגרסה הקצרה</h2>${(C.short || []).map(p => `<p>${md(p)}</p>`).join('')}
${(C.sections || []).map(sec).join('')}
<h2>6. Smart Money Framework</h2>${techHTML()}
${(C.bull || C.bear) ? `<h2>שור מול דוב</h2><div class="bb"><div><b>השור</b>${md(C.bull || '')}</div><div><b>הדוב</b>${md(C.bear || '')}</div></div>` : ''}
${C.verdict ? `<h2>פסק הדין: האם ${esc(C.company || T)} יציבה פונדמנטלית?</h2><div class="verdict"><div class="ans">${md(C.verdict.answer || '')}</div>${(C.verdict.p || []).map(p => `<p>${md(p)}</p>`).join('')}</div>` : ''}
${(C.remember || []).length ? `<h2>מה לזכור</h2><ul>${C.remember.map(b => `<li>${md(b)}</li>`).join('')}</ul>` : ''}
<p class="foot">מקורות: ${(C.sources || []).map(s => Array.isArray(s) ? `<a href="${esc(s[1])}">${esc(s[0])}</a>` : esc(s)).join(' · ')}${(C.sources || []).length ? ' · ' : ''}הרמות הטכניות מתוך סורק SMZ (yogevdonyo-maker.github.io/SMZ/scanner), נכון לסגירת ${heDate(asOf)}. אינו ייעוץ השקעות.</p>
</div></body></html>`;

const base = path.join(OUT, `${T}-review`);
fs.writeFileSync(base + '.html', html);
// the same page as an artifact body (no document skeleton; the Artifact tool adds one), with a link to the PDF published beside it
const body = html.slice(html.indexOf('<title>'), html.lastIndexOf('</body>')).replace(/<\/head>\s*<body>/, '')
  .replace('<p class="disc">', `<p class="pdf"><a href="${T}-review.pdf" target="_blank" rel="noopener">⬇ הורדת הסקירה כ-PDF</a></p><p class="disc">`)
  .replace('@page{', '.pdf{ margin:0 0 10px; } .pdf a{ color:var(--blue); font-weight:500; text-decoration:none; border:1px solid var(--line); border-radius:6px; padding:6px 12px; display:inline-block; }\n@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ --bg:#15171c; --fg:#e4e5e8; --muted:#979ba6; --line:#2b2e36; --panel:#1e2128; --up:#2fb594; --down:#ef6b73; --blue:#7ea2ff; --smz:#c98ad8; --smz-bg:rgba(201,138,216,.18); --inst-bg:rgba(126,162,255,.16); color-scheme:dark; } }\n:root[data-theme="dark"]{ --bg:#15171c; --fg:#e4e5e8; --muted:#979ba6; --line:#2b2e36; --panel:#1e2128; --up:#2fb594; --down:#ef6b73; --blue:#7ea2ff; --smz:#c98ad8; --smz-bg:rgba(201,138,216,.18); --inst-bg:rgba(126,162,255,.16); color-scheme:dark; }\n@page{')
  .replace('<div class="wrap">', '<div class="wrap" dir="rtl" lang="he">')
  .replace('.wrap{ max-width:72ch; margin:0 auto; padding:26px 20px 48px; }', '.wrap{ max-width:72ch; margin:0 auto; padding-block:26px 48px; padding-left:max(16px,env(safe-area-inset-left,0px)); padding-right:max(16px,env(safe-area-inset-right,0px)); }');
fs.writeFileSync(base + '.artifact.html', body);
(async () => {
  let pdf = false;
  try {
    const { chromium } = require('playwright');
    const b = await chromium.launch(); const p = await b.newPage();
    await p.setContent(html, { waitUntil: 'load' }); await p.evaluate(() => document.fonts.ready);
    await p.pdf({ path: base + '.pdf', format: 'A4', printBackground: true, preferCSSPageSize: true });
    await b.close(); pdf = true;
  } catch (e) { console.error('PDF not rendered:', e.message); }
  console.log(JSON.stringify({ html: base + '.html', artifact: base + '.artifact.html', pdf: pdf ? base + '.pdf' : null, pdfName: `${T}-review.pdf`, ticker: T, asOf, price }));
})();
