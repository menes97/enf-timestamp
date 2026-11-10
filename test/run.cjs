// Checks that the method and the published results reproduce. Run: npm test (or node test/run.cjs)
// 1) Synthetic: a hum made from the reference log, with a hidden start time and noise, must be dated to ±2 s.
// 2) The saved ENF curves in data/ must give the results stated in the README.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), enf = path.join(root, 'src', 'enf.cjs'), data = f => path.join(root, 'data', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enf-test-'));
let failed = 0;
const run = (args, env = {}) => execFileSync(process.execPath, [enf, ...args], { env: { ...process.env, TZ_NAME: 'Europe/Istanbul', ...env }, encoding: 'utf8' });
const best = out => out.split('\n').find(l => /^\s+\d\d:\d\d:\d\d\s+r=/.test(l)).trim().split(/\s+/)[0];
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failed++; };
const secs = hms => hms.split(':').reduce((a, b) => a * 60 + +b, 0);

try {
  // ---- 1) synthetic hum from reference b, hidden start, white noise
  const ref = fs.readFileSync(data('reference-2026-11-09-b.tsv'), 'utf8').trim().split('\n').slice(1)
    .map(l => l.split('\t')).map(r => ({ t: +r[0] / 1000, f: +r[2] }));
  const SR = 1000, DUR = 300, hiddenStart = Math.round(ref[0].t) + 1800 + 37; // 30 min 37 s into the log
  const fAt = t => { let j = ref.findIndex(r => r.t > t); if (j <= 0) j = 1; const a = ref[j - 1], b = ref[j]; return a.f + (b.f - a.f) * (t - a.t) / (b.t - a.t); };
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const x = new Float32Array(SR * DUR); let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const f = fAt(hiddenStart + i / SR); phase += 2 * Math.PI * 2 * f / SR; // 100 Hz hum (twice the grid frequency)
    x[i] = 0.05 * Math.sin(phase) + 0.02 * Math.sin(2 * phase) + 0.2 * gauss();
  }
  const f32 = path.join(tmp, 'synthetic.f32'), tsv = path.join(tmp, 'synthetic-enf.tsv');
  fs.writeFileSync(f32, Buffer.from(x.buffer));
  run(['extract', f32, String(SR), tsv]);
  const found = best(run(['match', tsv, data('reference-2026-11-09-b.tsv'), '120'], { SMOOTH: '9' }));
  const truth = new Date(hiddenStart * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/Istanbul' });
  check('synthetic 5 min hum in noise, 2 h reference', Math.abs(secs(found) - secs(truth)) <= 2, `hidden ${truth}, found ${found}`);

  // ---- 2) saved curves
  const panel = best(run(['match', data('panel-23min-enf.tsv'), data('reference-2026-11-09-a.tsv'), '180'], { SMOOTH: '9' }));
  check('23 min panel recording', panel === '22:01:32', `found ${panel}`);

  const lamp = best(run(['match', data('lamp-video-191s-enf.tsv'), data('reference-2026-11-09-b.tsv'), '120'], { SMOOTH: '9' }));
  check('191 s lamp video (light only), 2 h reference, file end time minus duration = 23:38:55', Math.abs(secs(lamp) - secs('23:38:55')) <= 1, `found ${lamp}`);

  const window30 = { REF_FROM: '2026-11-09T22:37:00+03:00', REF_TO: '2026-11-09T23:07:00+03:00' };
  const fridge = best(run(['match', data('fridge-video-76s-enf.tsv'), data('reference-2026-11-09-b.tsv'), '60'], window30));
  check('76 s fridge video, 30 min reference window, clock in frame 22:39:59', Math.abs(secs(fridge) - secs('22:39:59')) <= 1, `found ${fridge}`);

  // Known limitation, kept as a test so it is not forgotten: over the full 2 h log a false match wins.
  const fridgeWide = best(run(['match', data('fridge-video-76s-enf.tsv'), data('reference-2026-11-09-b.tsv'), '60']));
  check('76 s fridge video, full 2 h reference: known false match (limitation)', fridgeWide === '23:12:09', `found ${fridgeWide}`);

  const truthCut = JSON.parse(fs.readFileSync(data('panel-spliced-truth.json'), 'utf8'));
  const splice = run(['splice', data('panel-spliced-enf.tsv'), data('reference-2026-11-09-a.tsv')]);
  const m = splice.match(/CUT: (\d+) s, between (\d+) and (\d+) s/);
  check('spliced panel recording: cut found with the right length and position', !!m && +m[1] === truthCut.kesimSure_sn && truthCut.kesimBas_sn >= +m[2] - 15 && truthCut.kesimBas_sn <= +m[3] + 15,
    m ? `found ${m[1]} s at ${m[2]}–${m[3]} s, truth ${truthCut.kesimSure_sn} s at ${truthCut.kesimBas_sn} s` : 'no cut found');
  const clean = run(['splice', data('panel-23min-enf.tsv'), data('reference-2026-11-09-a.tsv')]);
  check('unedited panel recording: no cut reported', /One segment: no sign of editing/.test(clean));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
