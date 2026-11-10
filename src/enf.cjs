// ENF (electrical network frequency): extract the mains hum from a recording and match it to a grid log.
// ENF (şebeke frekansı): kayıttaki uğultuyu çıkarır ve şebeke kaydıyla eşleştirir.
//
// 1) extract (cikar):  node enf.cjs extract audio.f32 SR out.tsv
//    audio.f32: mono float32; SR=1000 is enough (ffmpeg -i rec -ac 1 -ar 1000 -f f32le audio.f32).
//    Every second: a 4 s Hann window, a 2^16-point zero-padded FFT, the peak near 50·k Hz (k = 1..9) and a
//    parabolic interpolation. Each harmonic gets an SNR (peak / median of the ±1·k Hz band). The estimate is
//    the SNR-weighted mean of f_k/k. Output: t_s (window centre from the start), f_Hz, snr_dB, harmonics used.
//
// 2) match (esle):  node enf.cjs match enf.tsv reference.tsv [min_overlap_s]
//    reference.tsv comes from enf-reference.cjs (unix_ms, local time, f_Hz).
//    For every 1 s shift, the Pearson correlation and RMS difference of the two mean-removed curves.
//    The best shift gives the wall-clock start of the recording.
//
// 3) splice (montaj):  node enf.cjs splice enf.tsv reference.tsv [window_s] [step_s]
//    Matches sliding windows separately. In an unedited recording every window implies the same start time;
//    after a cut it jumps forward by the length of the cut, after an insertion it jumps back or stops matching.
//
// Environment:
//   SMOOTH (YUMUSAT)  running-median length in s for match, default 5
//   REF_FROM, REF_TO  limit the reference to a time range, e.g. REF_FROM=2026-11-09T22:30:00+03:00
//   TZ_NAME           time zone for printed times, default Europe/Istanbul
//   OUT               also write the results as JSON to this file
const fs = require('fs');
const MODES = { cikar: 'extract', esle: 'match', montaj: 'splice' };
const mode = MODES[process.argv[2]] || process.argv[2];
const TZ = process.env.TZ_NAME || 'Europe/Istanbul';
const clock = s => new Date(s * 1000).toLocaleTimeString('en-GB', { timeZone: TZ });

function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]];[im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const p = i + k, q = p + len / 2, vr = re[q] * cr - im[q] * ci, vi = re[q] * ci + im[q] * cr; re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }
const med = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };

// Reference rows {t: unix s, f: Hz}, optionally limited to REF_FROM..REF_TO
function readReference(file) {
  const from = process.env.REF_FROM ? Date.parse(process.env.REF_FROM) / 1000 : -Infinity;
  const to = process.env.REF_TO ? Date.parse(process.env.REF_TO) / 1000 : Infinity;
  if (!(from < to)) { console.error('REF_FROM must be before REF_TO, both as ISO times'); process.exit(1); }
  const ref = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'))
    .map(r => ({ t: +r[0] / 1000, f: +r[2] })).filter(r => r.t >= from && r.t <= to);
  if (ref.length < 2) { console.error('The reference has no samples in this range'); process.exit(1); }
  return ref;
}

if (mode === 'extract') {
  const [, , , file, SR_, out] = process.argv; const SR = +SR_;
  if (!out) { console.error('Usage: node enf.cjs extract audio.f32 SR out.tsv'); process.exit(1); }
  const b = fs.readFileSync(file); const x = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  const W = 4 * SR, NF = 1 << 16, df = SR / NF, K = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(k => 50 * k + 1 < SR / 2);
  const win = Float64Array.from({ length: W }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / W));
  const rows = [];
  for (let s = 0; s + W <= x.length; s += SR) {
    const re = new Float64Array(NF), im = new Float64Array(NF);
    let m = 0; for (let i = 0; i < W; i++) m += x[s + i]; m /= W;
    for (let i = 0; i < W; i++) re[i] = (x[s + i] - m) * win[i];
    fft(re, im);
    const P = k => 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-30);
    const har = K.map(k => {
      const lo = Math.round((50 * k - 0.15 * k) / df), hi = Math.round((50 * k + 0.15 * k) / df);
      let bi = lo, bv = -Infinity; for (let i = lo; i <= hi; i++) { const v = P(i); if (v > bv) { bv = v; bi = i; } }
      const a = P(bi - 1), c = P(bi + 1), d = a - 2 * bv + c, off = d < 0 ? (a - c) / (2 * d) : 0;
      const band = []; for (let i = Math.round((50 * k - k) / df); i <= Math.round((50 * k + k) / df); i += 3) band.push(P(i));
      return { k, f: (bi + off) * df / k, snr: bv - med(band) };
    });
    rows.push({ t: (s + W / 2) / SR, har });
  }
  // Harmonic choice: the ones with the highest median SNR over the recording.
  const hs = K.map((k, j) => ({ k, j, m: med(rows.map(r => r.har[j].snr)) })).sort((a, b) => b.m - a.m);
  console.log('Median SNR per harmonic (dB):', hs.map(h => `${50 * h.k}Hz:${h.m.toFixed(1)}`).join('  '));
  // Pure noise also scores ~5 dB on this measure (in-band max / median), so the floor is the median over harmonics.
  const floor = med(hs.map(h => h.m));
  const sel = hs.filter(h => h.m >= Math.max(8, floor + 3)).slice(0, 4);
  if (!sel.length) { console.log(`NOT ENOUGH SIGNAL: no harmonic is 3 dB above the floor (${floor.toFixed(1)} dB) and above 8 dB.`); process.exit(2); }
  console.log('Using:', sel.map(h => 50 * h.k + ' Hz').join(', '));
  let o = 't_sn\tf_Hz\tsnr_dB\t' + sel.map(h => 'f' + 50 * h.k).join('\t') + '\n';
  for (const r of rows) {
    let sw = 0, sf = 0; for (const h of sel) { const q = r.har[h.j]; const w = Math.pow(10, q.snr / 10); sw += w; sf += w * q.f; }
    o += [r.t.toFixed(1), (sf / sw).toFixed(5), Math.max(...sel.map(h => r.har[h.j].snr)).toFixed(1), ...sel.map(h => r.har[h.j].f.toFixed(5))].join('\t') + '\n';
  }
  fs.writeFileSync(out, o); console.log('written:', out, rows.length, 's');
} else if (mode === 'match') {
  const [, , , enfF, refF, minO_] = process.argv; const minO = +(minO_ || 120);
  if (!refF) { console.error('Usage: node enf.cjs match enf.tsv reference.tsv [min_overlap_s]'); process.exit(1); }
  const e0 = fs.readFileSync(enfF, 'utf8').trim().split('\n').slice(1).map(l => l.split('\t').map(Number)).map(r => ({ t: r[0], f: r[1], snr: r[2] }));
  // Smooth the per-second estimates with a running median; the reference is per second but in 1 mHz steps.
  const Y = +(process.env.SMOOTH || process.env.YUMUSAT || 5), h = Y >> 1;
  const e = e0.map((p, i) => ({ ...p, f: med(e0.slice(Math.max(0, i - h), i + h + 1).map(q => q.f)) }));
  const ref = readReference(refF);
  // Resample the reference onto whole seconds (linear interpolation)
  const r0 = Math.ceil(ref[0].t), r1 = Math.floor(ref[ref.length - 1].t); const R = [];
  for (let s = r0, j = 0; s <= r1; s++) { while (j + 1 < ref.length && ref[j + 1].t < s) j++; const a = ref[j], b = ref[Math.min(j + 1, ref.length - 1)]; R.push(b.t > a.t ? a.f + (b.f - a.f) * (s - a.t) / (b.t - a.t) : a.f); }
  // Recording ENF is at window centre t; for shift o the recording starts at r0 + o
  const res = [];
  for (let o = -Math.round(e[e.length - 1].t) + minO; o <= R.length - minO; o++) {
    const xs = [], ys = [];
    for (const p of e) { const idx = Math.round(o + p.t); if (idx >= 0 && idx < R.length) { xs.push(p.f); ys.push(R[idx]); } }
    if (xs.length < minO) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0, d2 = 0; for (let i = 0; i < xs.length; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; d2 += (a - b) ** 2; }
    res.push({ o, r: sxy / Math.sqrt(sxx * syy), rms: Math.sqrt(d2 / xs.length) * 1000, n: xs.length, bias: (mx - my) * 1000 });
  }
  if (!res.length) { console.error('No shift overlaps the reference by min_overlap_s'); process.exit(1); }
  res.sort((a, b) => b.r - a.r);
  console.log(`Reference ${clock(r0)}–${clock(r1)} (${R.length} s). Best 5 shifts (recording start → correlation, RMS diff mHz, mean offset mHz, overlap s):`);
  for (const q of res.slice(0, 5)) console.log(`  ${clock(r0 + q.o)}  r=${q.r.toFixed(3)}  rms=${q.rms.toFixed(1)}  offset=${q.bias.toFixed(1)}  n=${q.n}`);
  const rs = res.map(q => q.r), m = rs.reduce((a, b) => a + b, 0) / rs.length, sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / rs.length);
  const second = res.find(q => Math.abs(q.o - res[0].o) > 20);
  console.log(`All shifts: mean r=${m.toFixed(3)}, sd=${sd.toFixed(3)}; best is ${((res[0].r - m) / sd).toFixed(1)} sd above. Best rival more than 20 s away: ${second ? `${clock(r0 + second.o)} r=${second.r.toFixed(3)}` : '-'}.`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ r0, best: res[0], second, res: res.slice(0, 200) }));
} else if (mode === 'splice') {
  const [, , , enfF, refF, P_, A_] = process.argv; const PW = +(P_ || 120), AD = +(A_ || 10);
  if (!refF) { console.error('Usage: node enf.cjs splice enf.tsv reference.tsv [window_s] [step_s]'); process.exit(1); }
  const e0 = fs.readFileSync(enfF, 'utf8').trim().split('\n').slice(1).map(l => l.split('\t').map(Number)).map(r => ({ t: r[0], f: r[1] }));
  const e = e0.map((p, i) => ({ t: p.t, f: med(e0.slice(Math.max(0, i - 4), i + 5).map(q => q.f)) }));
  const ref = readReference(refF);
  const r0 = Math.ceil(ref[0].t), r1 = Math.floor(ref[ref.length - 1].t); const R = [];
  for (let s = r0, j = 0; s <= r1; s++) { while (j + 1 < ref.length && ref[j + 1].t < s) j++; R.push(ref[j].f); }
  const out = [];
  for (let w0 = e[0].t; w0 + PW <= e[e.length - 1].t; w0 += AD) {
    const w = e.filter(p => p.t >= w0 && p.t < w0 + PW);
    let best = null;
    for (let s = -Math.round(PW * 0.4); s + PW * 0.6 < R.length; s++) { // s: index of the window start in the reference (partial overlap allowed)
      const xs = [], ys = []; for (const p of w) { const k = s + Math.round(p.t - w0); if (k >= 0 && k < R.length) { xs.push(p.f); ys.push(R[k]); } }
      if (xs.length < PW * 0.6) continue;
      const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
      let a = 0, b = 0, c = 0; for (let i = 0; i < xs.length; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; }
      const r = a / Math.sqrt(b * c); if (!best || r > best.r) best = { r, s };
    }
    if (best) out.push({ pos: w0, start: r0 + best.s - w0, r: best.r });
  }
  console.log(`Window ${PW} s, step ${AD} s. pos = window start in the recording; start = recording start implied by this window`);
  console.log('pos_s\tstart\tr');
  for (const q of out) console.log(`${q.pos.toFixed(0)}\t${clock(q.start)}\t${q.r.toFixed(3)}`);
  // Segments: consecutive reliable windows (r ≥ 0.8) whose implied start stays within TOL s.
  // TOL 6 s: in an unedited 23 min recording neighbouring windows moved by ±4 s (loose matches on slow stretches).
  // A segment's start is the median of its members; a new window is compared with that median.
  const good = out.filter(q => q.r >= 0.8), seg = [];
  const TOL = +(process.env.TOL || 6);
  for (const q of good) { const s = seg[seg.length - 1]; if (s && Math.abs(q.start - s.start) <= TOL) { s.m.push(q.start); s.start = med(s.m); s.end = q.pos + PW; s.n++; } else seg.push({ start: q.start, m: [q.start], first: q.pos, end: q.pos + PW, n: 1 }); }
  // Drop groups of fewer than 3 windows, then merge neighbours with the same start
  const main = [];
  for (const b of seg.filter(b => b.n >= 3)) { const s = main[main.length - 1]; if (s && Math.abs(b.start - s.start) <= TOL) { s.end = b.end; s.n += b.n; s.m = s.m.concat(b.m); s.start = med(s.m); } else main.push(b); }
  console.log('\nSEGMENTS (3 windows or more):'); main.forEach(b => console.log(`  recording ${b.first.toFixed(0)}–${b.end.toFixed(0)} s → start ${clock(b.start)} (${b.n} windows)`));
  for (let i = 1; i < main.length; i++) {
    const d = main[i].start - main[i - 1].start;
    const a1 = Math.min(main[i - 1].end, main[i].first), a2 = Math.max(main[i - 1].end, main[i].first), mid = (a1 + a2) / 2;
    console.log(`  → ${d > 0 ? 'CUT' : 'INSERTION/REORDER'}: ${Math.abs(d).toFixed(0)} s, between ${a1.toFixed(0)} and ${a2.toFixed(0)} s of the recording (≈${mid.toFixed(0)} s); the removed part starts at ≈${clock(main[i - 1].start + mid)} wall-clock time`);
  }
  if (main.length === 1) console.log('  One segment: no sign of editing.');
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out));
} else { console.log('Usage: node enf.cjs extract audio.f32 SR out.tsv | match enf.tsv reference.tsv [min_overlap_s] | splice enf.tsv reference.tsv [window_s] [step_s]'); }
