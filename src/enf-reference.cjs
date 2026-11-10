// Logs the Continental European grid frequency live, as an ENF reference.
// Canlı Kıta Avrupası şebeke frekansı kaydı (ENF referansı).
// The whole synchronous area shares the same frequency drift on the scale of seconds, so a feed measured in
// Germany works as a reference for a recording made anywhere in the area (Spain to Turkey).
// Source: https://www.netzfrequenz.info/json/act.json (a single number in Hz). At most once a second, to be polite.
// Usage: node enf-reference.cjs duration_min interval_s out.tsv
// Output: unix_ms <TAB> local time <TAB> f_Hz. The timestamp is the middle of the request round trip.
// Environment: TZ_NAME, time zone of the local time column (default Europe/Istanbul).
const fs = require('fs');
const [, , minutes, interval, out] = process.argv;
if (!out) { console.error('Usage: node enf-reference.cjs duration_min interval_s out.tsv'); process.exit(1); }
const URL = 'https://www.netzfrequenz.info/json/act.json';
const TZ = process.env.TZ_NAME || 'Europe/Istanbul';
const end = Date.now() + (+minutes) * 60e3, step = Math.max(1, +interval) * 1000;
if (!fs.existsSync(out)) fs.writeFileSync(out, 'unix_ms\tsaat\tf_Hz\n');
let n = 0, errors = 0, last = null;
(async () => {
  console.log('ENF reference:', URL, '→', out, `(${minutes} min, every ${interval} s)`);
  let next = Math.ceil(Date.now() / 1000) * 1000; // align to whole seconds
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, Math.max(0, next - Date.now())));
    const t0 = Date.now();
    try {
      const r = await fetch(URL, { headers: { 'User-Agent': 'enf-timestamp/1.0' } });
      const f = parseFloat((await r.text()).trim());
      const t = Math.round((t0 + Date.now()) / 2);
      if (!isFinite(f) || f < 49 || f > 51) throw new Error('invalid response');
      fs.appendFileSync(out, `${t}\t${new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ })}\t${f}\n`);
      n++; last = f;
      if (n % 60 === 1) console.log(new Date(t).toISOString(), 'sample', n, f, 'Hz');
    } catch (e) { errors++; if (errors % 10 === 1) console.error('error', e.message); }
    next += step;
    if (next < Date.now()) next = Math.ceil(Date.now() / step) * step;
  }
  console.log('Done. Samples:', n, 'errors:', errors, 'last:', last);
})();
