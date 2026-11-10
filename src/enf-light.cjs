// ENF from light: the grid frequency from a lamp's 100 Hz flicker in a video, either from the rolling-shutter
// bands or, when there are none, from the mean brightness, where 100 Hz folds down to about 10 Hz at 30 fps.
// Usage: node enf-light.cjs video.mp4 out.tsv [skip_s] [window_s]. MOD=bant|zaman forces bands|time path.
// The output has the same format as `enf.cjs extract`. Comments below are in Turkish.
//
// Işıktan ENF: videodaki 100 Hz lamba titremesinin rolling shutter bantlarından şebeke frekansı.
// Kullanım: node enf-light.cjs video.mp4 cikti.tsv [atla_sn] [pencere_sn]
//   atla_sn   : baştan atlanacak süre (ör. saat gösterilen ilk saniyeler), varsayılan 0
//   pencere_sn: frekans eğimi penceresi, varsayılan 4
// Yöntem:
//   1) Kareler gri, uzun kenar 480 px olacak şekilde küçültülür; her karenin satır ve sütun profili alınır.
//   2) Her satırdan/sütundan kayan ortalama (±15 kare) çıkarılır: duvar, gölge ve pozlama değişimi gider, bant kalır.
//   3) Bantların uzaysal frekansı k (çevrim/kare boyu) tüm kareler üzerinden en güçlü periyodik bileşen olarak bulunur;
//      yön (satır mı sütun mu; döndürülmüş dikey videoda bantlar dikey olur) gücü yüksek olandır.
//   4) Her karede o bileşenin karmaşık genliği → faz φ_n.
//   5) ψ_n = φ_n − 2π·100·t_n (beklenen 100 Hz ilerlemesi çıkarılır), sarılımı açılır. Eğim = 2π·(f_ışık − 100).
//      f_şebeke = 50 + (f_ışık − 100)/2. İşaret tarama yönüne bağlıdır; ISARET=-1 ile çevrilir.
//   t_n: ffprobe kare zaman damgalarına doğrusal uydurma (kare aralığı sabit kabul edilir).
// Çıktı enf.cjs ile aynı biçimde: t_sn, f_Hz, snr_dB.
const fs = require('fs'), { execFileSync } = require('child_process'), path = require('path');
const [, , video, out, atla_, pen_] = process.argv;
if (!out) { console.error('Usage / Kullanım: node enf-light.cjs video.mp4 cikti.tsv [atla_sn] [pencere_sn]'); process.exit(1); }
const atla = +(atla_ || 0), PEN = +(pen_ || 4), ISARET = +(process.env.ISARET || 1);
// ffmpeg ve ffprobe PATH'te olmalı; başka bir yerdeyse FFMPEG_DIR ile klasörü ver.
// ffmpeg and ffprobe must be on PATH, or set FFMPEG_DIR to their folder.
const tool = name => process.env.FFMPEG_DIR ? path.join(process.env.FFMPEG_DIR, name) : name;
// boyut ve kare zamanları
const ff = (args) => execFileSync(tool('ffprobe'), args, { maxBuffer: 1 << 28 }).toString().trim();
const [w0, h0] = ff(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]).split(',').map(Number);
const ptsAll = ff(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', video]).split(/\s+/).map(Number).filter(Number.isFinite);
// ffmpeg döndürme yan verisini uygular, sonra scale istenen boyuta getirir: çıktı her zaman W x H (gerekirse sıkıştırılmış).
const sc = 480 / Math.max(w0, h0), W = Math.round(w0 * sc / 2) * 2, H = Math.round(h0 * sc / 2) * 2;
console.log(`Video ${w0}x${h0}, kare ${ptsAll.length}; analiz ${W}x${H}`);
// Tüm kareyi değil, yalnızca profilleri al: alan ortalamalı küçültme ile 8 sütun x H satır ve W sütun x 8 satır.
// 16 bitlik gri (gray16le), 8 bitlik nicemlemenin zayıf bantları silmesini önler.
const ffraw = vf => execFileSync(tool('ffmpeg'),['-v', 'error', '-i', video, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray16le', '-'], { maxBuffer: 1 << 30 });
const rowRaw = ffraw(`scale=8:${H}:flags=area`), colRaw = ffraw(`scale=${W}:8:flags=area`);
const FW = W, FH = H, N = Math.min(Math.floor(rowRaw.length / (16 * FH)), Math.floor(colRaw.length / (16 * FW)), ptsAll.length);
const pts = ptsAll.slice(0, N);
// sabit kare aralığı: pts'e doğrusal uydurma
const n0 = pts.length, mx = (n0 - 1) / 2, my = pts.reduce((a, b) => a + b, 0) / n0;
let sxy = 0, sxx = 0; pts.forEach((p, i) => { sxy += (i - mx) * (p - my); sxx += (i - mx) ** 2; });
const dt = sxy / sxx, tb = my - dt * mx; const T = i => tb + dt * i;
console.log(`Kare aralığı ${(dt * 1000).toFixed(4)} ms (${(1 / dt).toFixed(4)} fps)`);
const i0 = pts.findIndex(p => p >= atla);
// profiller
function profiller(n) {
  const r = new Float64Array(FH), c = new Float64Array(FW), or = n * 8 * FH * 2, oc = n * 8 * FW * 2;
  for (let y = 0; y < FH; y++) { let s = 0; for (let x = 0; x < 8; x++) s += rowRaw.readUInt16LE(or + (y * 8 + x) * 2); r[y] = s / 8 / 256; }
  for (let x = 0; x < FW; x++) { let s = 0; for (let y = 0; y < 8; y++) s += colRaw.readUInt16LE(oc + (y * FW + x) * 2); c[x] = s / 8 / 256; }
  return { r, c };
}
const P = []; for (let n = 0; n < N; n++) P.push(profiller(n));
function artik(key, L) {
  // kayan ortalama çıkar (±15 kare)
  const R = []; const K = 15;
  for (let n = 0; n < N; n++) {
    const a = Math.max(0, n - K), b = Math.min(N - 1, n + K), m = new Float64Array(L);
    for (let j = a; j <= b; j++) { const p = P[j][key]; for (let y = 0; y < L; y++) m[y] += p[y]; }
    const p = P[n][key], r = new Float64Array(L); for (let y = 0; y < L; y++) r[y] = p[y] - m[y] / (b - a + 1);
    R.push(r);
  }
  return R;
}
function bilesen(R, L, k) { // karmaşık genlik, Hann pencereli
  return R.map(r => { let re = 0, im = 0; for (let y = 0; y < L; y++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * y / (L - 1)), a = 2 * Math.PI * k * y / L; re += w * r[y] * Math.cos(a); im -= w * r[y] * Math.sin(a); } return [re, im]; });
}
let en = null;
for (const [key, L] of [['r', FH], ['c', FW]]) {
  const R = artik(key, L).slice(i0);
  for (let k = 1; k <= 15; k += 0.1) {
    const A = bilesen(R.filter((_, i) => i % 5 === 0), L, k);
    // tutarlılık: genliğin ortalaması (faz dönse de büyüklük)
    const g = A.reduce((s, a) => s + Math.hypot(a[0], a[1]), 0) / A.length;
    if (!en || g > en.g) en = { key, L, k: +k.toFixed(2), g };
  }
}
// arka plan: aynı yönde k'dan uzak bileşenlerin ortalama genliği
const Rb = artik(en.key, en.L).slice(i0);
const kom = [en.k * 0.6, en.k * 1.4, en.k + 2.3].map(k => bilesen(Rb.filter((_, i) => i % 5 === 0), en.L, k).reduce((s, a) => s + Math.hypot(a[0], a[1]), 0) / (Rb.length / 5));
const snrUz = 20 * Math.log10(en.g / (kom.reduce((a, b) => a + b, 0) / kom.length));
console.log(`Bantlar: ${en.key === 'r' ? 'yatay (satır)' : 'dikey (sütun)'} yönde, ${en.k} çevrim/kare, uzaysal SNR ${snrUz.toFixed(1)} dB`);
if (snrUz < 6) console.log('UYARI: bant deseni zayıf; lamba titremiyor ya da pozlama titremeyi siliyor olabilir.');
// ZAMAN YOLU: bant yoksa (ör. lambanın kendisi çekildiyse) bütün karenin ortalama parlaklığı titremeyle nabız atar.
// 100 Hz, kare hızına katlanır: f_katlanma = f_ışık − m·fps (m = round(100/fps)). Kare başına bir örnek; 4 sn pencere,
// sıfır dolgulu DFT, beklenen katlanmanın ±0,5 Hz'inde tepe + parabolik ara değer. f_şebeke = (m·fps + f_katlanma)/2.
if (process.env.MOD === 'zaman' || (process.env.MOD !== 'bant' && snrUz < 6)) {
  const fps = 1 / dt, m = Math.round(100 / fps), beklenen = 100 - m * fps;
  const isaret = Math.sign(beklenen) || 1, fk0 = Math.abs(beklenen);
  console.log(`ZAMAN YOLU: ortalama parlaklık, beklenen katlanma ${fk0.toFixed(3)} Hz (100 − ${m}×${fps.toFixed(4)})`);
  const x = P.map(p => p.r.reduce((a, b) => a + b, 0) / p.r.length);
  const L = Math.round(PEN * fps), NF = 1 << 14;
  let o = 't_sn\tf_Hz\tsnr_dB\n', say = 0;
  for (let c = i0 + (L >> 1); c + (L >> 1) < N; c += Math.round(fps)) {
    const a = c - (L >> 1); let mm = 0; for (let i = 0; i < L; i++) mm += x[a + i]; mm /= L;
    const P2 = f => { let re = 0, im = 0; for (let i = 0; i < L; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)), ph = 2 * Math.PI * f * i / fps; re += w * (x[a + i] - mm) * Math.cos(ph); im -= w * (x[a + i] - mm) * Math.sin(ph); } return re * re + im * im; };
    const df = fps / NF; let bf = 0, bv = -1; const ara = [];
    for (let f = fk0 - 0.5; f <= fk0 + 0.5; f += df) { const v = P2(f); ara.push(v); if (v > bv) { bv = v; bf = f; } }
    const vm = P2(bf - df), vp = P2(bf + df), d = vm - 2 * bv + vp, off = d < 0 ? (vm - vp) / (2 * d) * df : 0;
    const fk = bf + off, fl = m * fps + isaret * fk, f = fl / 2;
    const taban = [...ara].sort((p, q) => p - q)[ara.length >> 1];
    o += `${(T(c) - T(0)).toFixed(1)}\t${f.toFixed(5)}\t${(10 * Math.log10(bv / taban)).toFixed(1)}\n`; say++;
  }
  fs.writeFileSync(out, o);
  console.log(`yazıldı: ${out} (${say} sn, zaman yolu). Kare saati sapması sabit kayma yapar (×${m}/2); eşleştirmede korelasyon bunu tolere eder.`);
  process.exit(0);
}
const A = bilesen(Rb, en.L, en.k);
// faz → ψ
const psi = []; let prev = null, acc = 0;
for (let i = 0; i < A.length; i++) {
  const n = i + i0, ph = ISARET * Math.atan2(A[i][1], A[i][0]);
  let p = ph - 2 * Math.PI * 100 * T(n); p = p - 2 * Math.PI * Math.floor(p / (2 * Math.PI));
  if (prev !== null) { let d = p - prev; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); acc += d; } else acc = p;
  prev = p; psi.push({ t: T(n), v: acc, a: Math.hypot(A[i][0], A[i][1]) });
}
// her saniye için PEN sn pencerede ağırlıklı doğrusal eğim
let o = 't_sn\tf_Hz\tsnr_dB\n'; const t0 = psi[0].t, t1 = psi[psi.length - 1].t; let say = 0;
for (let tc = t0 + PEN / 2; tc <= t1 - PEN / 2; tc += 1) {
  const w = psi.filter(p => Math.abs(p.t - tc) <= PEN / 2); if (w.length < 20) continue;
  let sw = 0, st = 0, sv = 0; for (const p of w) { sw += p.a; st += p.a * p.t; sv += p.a * p.v; } const mt = st / sw, mv = sv / sw;
  let num = 0, den = 0, res = 0; for (const p of w) { num += p.a * (p.t - mt) * (p.v - mv); den += p.a * (p.t - mt) ** 2; }
  const egim = num / den; for (const p of w) res += p.a * (p.v - mv - egim * (p.t - mt)) ** 2;
  const fl = 100 + egim / (2 * Math.PI), f = 50 + (fl - 100) / 2;
  const snr = 10 * Math.log10(1 / (res / sw + 1e-9));
  o += `${tc.toFixed(1)}\t${f.toFixed(5)}\t${snr.toFixed(1)}\n`; say++;
}
fs.writeFileSync(out, o);
console.log(`yazıldı: ${out} (${say} sn). Not: kare saati sapması sabit bir frekans kayması yapar; eşleştirmede korelasyon bunu tolere eder.`);
