// Draws the README charts as SVG from the files in data/. Run: node tools/plot.cjs
//   docs/panel-match.svg       recording ENF vs grid reference at the best shift
//   docs/fridge-search.svg     correlation for every candidate start time over the 2 h log (76 s clip)
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), data = f => path.join(root, 'data', f), docs = f => path.join(root, 'docs', f);
const TZ = 'Europe/Istanbul';
const clock = (s, sec) => new Date(s * 1000).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) });
const med = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const readTsv = f => fs.readFileSync(f, 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const W = 1200, H = 675, ML = 90, MR = 40, MT = 150, MB = 90, IW = W - ML - MR, IH = H - MT - MB;
const C = { bg: '#ffffff', ink: '#1b1f24', muted: '#5b6470', grid: '#e3e6ea', ref: '#2563eb', rec: '#dc2626', ok: '#15803d' };
function frame(title, subtitle, body, foot) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<text x="${ML}" y="58" font-size="30" font-weight="700" fill="${C.ink}">${esc(title)}</text>
<text x="${ML}" y="94" font-size="18" fill="${C.muted}">${esc(subtitle)}</text>
${body}
<text x="${ML}" y="${H - 22}" font-size="14" fill="${C.muted}">${esc(foot)}</text>
</svg>\n`;
}
const axes = (xTicks, yTicks, yLabel) => [
  ...yTicks.map(([y, l]) => `<line x1="${ML}" x2="${ML + IW}" y1="${y}" y2="${y}" stroke="${C.grid}"/><text x="${ML - 10}" y="${y + 5}" font-size="14" fill="${C.muted}" text-anchor="end">${esc(l)}</text>`),
  ...xTicks.map(([x, l]) => `<line x1="${x}" x2="${x}" y1="${MT}" y2="${MT + IH}" stroke="${C.grid}"/><text x="${x}" y="${MT + IH + 26}" font-size="14" fill="${C.muted}" text-anchor="middle">${esc(l)}</text>`),
  `<text x="${ML}" y="${MT - 14}" font-size="14" fill="${C.muted}">${esc(yLabel)}</text>`,
].join('\n');
const poly = (pts, color, w) => `<polyline fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" points="${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}"/>`;
const legend = items => items.map(([color, label], i) => `<rect x="${ML + i * 440}" y="112" width="26" height="6" rx="3" fill="${color}"/><text x="${ML + i * 440 + 36}" y="120" font-size="16" fill="${C.ink}">${esc(label)}</text>`).join('\n');

function runMatch(enfFile, refFile, minO, env) {
  const out = path.join(require('os').tmpdir(), `enf-plot-${process.pid}.json`);
  execFileSync(process.execPath, [path.join(root, 'src', 'enf.cjs'), 'match', enfFile, refFile, String(minO)], { env: { ...process.env, ...env, OUT: out } });
  const j = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out); return j;
}

// ---- 1) panel recording vs reference
{
  const refRows = readTsv(data('reference-2026-11-09-a.tsv')).map(r => [+r[0] / 1000, +r[2]]);
  const j = runMatch(data('panel-23min-enf.tsv'), data('reference-2026-11-09-a.tsv'), 180, { SMOOTH: '9' });
  const start = j.r0 + j.best.o;
  const e0 = readTsv(data('panel-23min-enf.tsv')).map(r => [+r[0], +r[1]]);
  const rec = e0.map((p, i) => [start + p[0], med(e0.slice(Math.max(0, i - 4), i + 5).map(q => q[1]))]).slice(5, -5);
  const tA = Math.min(rec[0][0], refRows[0][0]), tB = Math.max(rec[rec.length - 1][0], refRows[refRows.length - 1][0]);
  const all = [...rec, ...refRows].map(p => (p[1] - 50) * 1000), fA = Math.floor(Math.min(...all) / 20) * 20, fB = Math.ceil(Math.max(...all) / 20) * 20;
  const X = t => ML + (t - tA) / (tB - tA) * IW, Y = mhz => MT + (fB - mhz) / (fB - fA) * IH;
  const xt = []; for (let t = Math.ceil(tA / 300) * 300; t <= tB; t += 300) xt.push([X(t), clock(t)]);
  const yt = []; for (let v = fA; v <= fB; v += 20) yt.push([Y(v), (v > 0 ? '+' : '') + v]);
  const body = [axes(xt, yt, 'deviation from 50 Hz (mHz)'),
    legend([[C.ref, 'Grid frequency (public 1 s log, Germany)'], [C.rec, 'Hum in the phone recording (100 + 200 Hz)']]),
    poly(refRows.map(p => [X(p[0]), Y((p[1] - 50) * 1000)]), C.ref, 3.2),
    poly(rec.map(p => [X(p[0]), Y((p[1] - 50) * 1000)]), C.rec, 1.6),
    `<text x="${ML + IW}" y="${MT - 14}" font-size="16" fill="${C.ink}" text-anchor="end">best start ${clock(start, true)} · r = ${j.best.r.toFixed(3)} · RMS diff ${j.best.rms.toFixed(1)} mHz</text>`].join('\n');
  fs.writeFileSync(docs('panel-match.svg'), frame('The hum in a phone recording matches the European grid',
    '23 minutes recorded next to a fuse box, slid along a grid frequency log until the curves line up (9 Nov 2026).', body,
    'Recording ENF: 4 s Hann window, 2^16-point FFT, parabolic peak at 100/200 Hz, 9 s running median. Code and data: enf-timestamp.'));
}

// ---- 2) 76 s fridge clip: correlation for every start time in the 2 h log
{
  const j = runMatch(data('fridge-video-76s-enf.tsv'), data('reference-2026-11-09-b.tsv'), 60, {});
  // OUT keeps only the best 200; recompute the full curve here with the same method (SMOOTH 5)
  const ref = readTsv(data('reference-2026-11-09-b.tsv')).map(r => ({ t: +r[0] / 1000, f: +r[2] }));
  const r0 = Math.ceil(ref[0].t), r1 = Math.floor(ref[ref.length - 1].t), R = [];
  for (let s = r0, k = 0; s <= r1; s++) { while (k + 1 < ref.length && ref[k + 1].t < s) k++; const a = ref[k], b = ref[Math.min(k + 1, ref.length - 1)]; R.push(b.t > a.t ? a.f + (b.f - a.f) * (s - a.t) / (b.t - a.t) : a.f); }
  const e0 = readTsv(data('fridge-video-76s-enf.tsv')).map(r => ({ t: +r[0], f: +r[1] }));
  const e = e0.map((p, i) => ({ t: p.t, f: med(e0.slice(Math.max(0, i - 2), i + 3).map(q => q.f)) }));
  const curve = [];
  for (let o = 0; o + Math.round(e[e.length - 1].t) < R.length; o++) {
    const xs = [], ys = []; for (const p of e) { const idx = Math.round(o + p.t); xs.push(p.f); ys.push(R[idx]); }
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let a = 0, b = 0, c = 0; for (let i = 0; i < xs.length; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; }
    curve.push([r0 + o, a / Math.sqrt(b * c)]);
  }
  const truth = Date.parse('2026-11-09T22:39:59+03:00') / 1000;
  const atTruth = curve.find(p => p[0] === truth)[1], top = curve.reduce((p, q) => q[1] > p[1] ? q : p);
  const tA = curve[0][0], tB = curve[curve.length - 1][0];
  const X = t => ML + (t - tA) / (tB - tA) * IW, Y = r => MT + (1 - r) / 2 * IH;
  const xt = []; for (let t = Math.ceil(tA / 900) * 900; t <= tB; t += 900) xt.push([X(t), clock(t)]);
  const yt = [1, 0.5, 0, -0.5, -1].map(v => [Y(v), v.toFixed(1)]);
  const win = [Date.parse('2026-11-09T22:37:00+03:00') / 1000, Date.parse('2026-11-09T23:07:00+03:00') / 1000];
  const body = [
    `<rect x="${X(Math.max(win[0], tA))}" y="${MT}" width="${X(win[1]) - X(Math.max(win[0], tA))}" height="${IH}" fill="#15803d" opacity="0.08"/>`,
    `<text x="${(X(Math.max(win[0], tA)) + X(win[1])) / 2}" y="${MT + IH - 12}" font-size="14" fill="${C.ok}" text-anchor="middle">30 min window</text>`,
    axes(xt, yt, 'correlation with the grid log'),
    poly(curve.map(p => [X(p[0]), Y(p[1])]), '#64748b', 1.2),
    `<circle cx="${X(truth)}" cy="${Y(atTruth)}" r="7" fill="${C.ok}"/><text x="${X(truth) + 12}" y="${Y(atTruth) - 10}" font-size="16" fill="${C.ok}">true start ${clock(truth, true)} · r = ${atTruth.toFixed(2)}</text>`,
    `<circle cx="${X(top[0])}" cy="${Y(top[1])}" r="7" fill="${C.rec}"/><text x="${X(top[0]) + 12}" y="${Y(top[1]) - 10}" font-size="16" fill="${C.rec}">false match ${clock(top[0], true)} · r = ${top[1].toFixed(2)}</text>`,
  ].join('\n');
  fs.writeFileSync(docs('fridge-search.svg'), frame('76 seconds of fridge hum: right within 30 minutes, wrong over 2 hours',
    'Correlation of the clip\'s ENF with the grid log for every possible start time. The clock in the video showed 22:39:59.', body,
    `Searching the whole 2 h log, a false start time scores higher than the true one. Recordings of a few minutes or more did not show this.`));
  if (Math.abs(j.r0 + j.best.o - top[0]) > 1) console.warn('note: enf.cjs best differs from the plotted curve peak');
}
console.log('written: docs/panel-match.svg, docs/fridge-search.svg');
