// Estadísticas propias, mínimas y sin datos personales.
// - Sin cookies ni almacenamiento en el navegador.
// - Visitantes únicos: hash(sal del día + IP + navegador). La IP nunca se guarda; la sal se
//   descarta al cambiar el día, así que no se puede seguir a nadie de un día a otro.
// - Se guardan solo totales por día: visitas, únicos, celular/compu, dominio de origen y
//   localidades consultadas, visitas por página y compartidos (toques en WhatsApp, X o copiar enlace) con las visitas que
//   llegan por esos enlaces (?via=wa|x|link). Los bots y clientes automatizados no cuentan.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const KEEP_DAYS = 400;
const VIA = new Set(['wa', 'x', 'link']);
const PAGES = new Set(['monitor', 'mapa']);
const VIA_NAME = { wa: 'WhatsApp', x: 'X', link: 'enlace copiado' };
const BOT = /\bnode\b|undici|bot|crawl|spider|slurp|preview|fetch|curl|wget|python|httpclient|headless|lighthouse|monitor|uptime|pingdom|facebookexternalhit|whatsapp|telegram|discord|slack|embed/i;
const dayAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());

export async function createAnalytics({ dataDir, ownHost, stationIds, log }) {
  const file = path.join(dataDir, 'analytics.json');
  const todayFile = path.join(dataDir, 'analytics-today.json'); // sal y hashes del día en curso
  const keyFile = path.join(dataDir, 'stats-key');

  let db = { days: {} };
  try { db = JSON.parse(await readFile(file, 'utf8')); } catch {}
  let today = { day: null, salt: null, seen: [] };
  try { today = JSON.parse(await readFile(todayFile, 'utf8')); } catch {}
  let seen = new Set(today.seen);

  // clave para ver /stats: se genera una vez y se anuncia una sola vez en el log del servicio
  let key;
  try { key = (await readFile(keyFile, 'utf8')).trim(); } catch {}
  if (!key) {
    key = randomBytes(18).toString('base64url');
    await writeFile(keyFile, key + '\n', { mode: 0o600 });
    log(`estadísticas: clave nueva generada → /stats?key=${key}`);
  }

  let dirty = false;
  const bucket = () => {
    const d = dayAR();
    if (today.day !== d) { // día nuevo: sal nueva, se olvidan los hashes de ayer
      today = { day: d, salt: randomBytes(16).toString('hex'), seen: [] };
      seen = new Set();
    }
    const b = (db.days[d] ||= { views: 0, uniques: 0, mobile: 0, desktop: 0, refs: {}, stations: {} });
    b.pages ||= {}; b.shares ||= {}; b.via ||= {}; // días anteriores a estos contadores
    return b;
  };
  const ipOf = (req) => (process.env.TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '';
  const isBot = (req) => BOT.test(req.headers['user-agent'] || '') || !req.headers['user-agent'];

  // page: 'monitor' o 'mapa'; via: de qué botón de compartir salió el enlace (wa, x, link) o nada
  function pageView(req, page = 'monitor', via = null) {
    if (isBot(req)) return;
    const b = bucket();
    b.views++;
    b.pages[page] = (b.pages[page] || 0) + 1;
    if (VIA.has(via)) b.via[via] = (b.via[via] || 0) + 1;
    const ua = req.headers['user-agent'] || '';
    const h = createHash('sha256').update(today.salt + '|' + ipOf(req) + '|' + ua).digest('base64url').slice(0, 16);
    if (!seen.has(h)) {
      seen.add(h);
      b.uniques++;
      if (/Mobi|Android|iPhone|iPad/i.test(ua)) b.mobile++; else b.desktop++;
    }
    try {
      const ref = new URL(req.headers.referer || '').host.replace(/^www\./, '');
      // el propio sitio no cuenta como origen (SITE_HOST o, si no está, el host del pedido)
      const own = (ownHost || req.headers['x-forwarded-host'] || req.headers.host || '').replace(/:\d+$/, '').replace(/^www\./, '');
      if (ref && ref !== own) b.refs[ref] = (b.refs[ref] || 0) + 1;
    } catch {}
    dirty = true;
  }

  // aviso de la página: al elegir una localidad {"s":"rosario"} o al compartir {"sh":"wa","p":"mapa"}
  function hit(req, body) {
    if (isBot(req)) return;
    let m;
    try { m = JSON.parse(body); } catch { return; }
    if (m?.sh) {
      if (!VIA.has(m.sh) || !PAGES.has(m.p)) return;
      const b = bucket(), k = `${m.p}:${m.sh}`;
      b.shares[k] = (b.shares[k] || 0) + 1;
      dirty = true;
      return;
    }
    if (!stationIds.has(m?.s)) return;
    const b = bucket();
    b.stations[m.s] = (b.stations[m.s] || 0) + 1;
    dirty = true;
  }

  async function flush() {
    if (!dirty) return;
    dirty = false;
    const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    for (const d of Object.keys(db.days)) if (d < cutoff) delete db.days[d];
    today.seen = [...seen];
    // escritura atómica: primero a un temporal, después se renombra
    await writeFile(file + '.tmp', JSON.stringify(db));
    await rename(file + '.tmp', file);
    await writeFile(todayFile, JSON.stringify(today), { mode: 0o600 });
  }
  setInterval(() => flush().catch((e) => log('estadísticas:', e.message)), 60e3).unref();

  const authorized = (k) => {
    if (!k) return false;
    const a = Buffer.from(String(k)), b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  return { pageView, hit, flush, authorized, report: (names, host) => report(db, names, host) };
}

// ---------- página /stats (HTML sin JavaScript, con el estilo del sitio)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('es-AR');
const bar = (v, max, w = 24) => '█'.repeat(Math.round((v / (max || 1)) * w)) || (v ? '▏' : '');

function report(db, names, host = 'caudal') {
  const days = Object.keys(db.days).sort().reverse();
  const last30 = days.slice(0, 30);
  const sum = (ds, f) => ds.reduce((a, d) => a + f(db.days[d]), 0);
  const top = (ds, field, n = 15) => {
    const acc = {};
    for (const d of ds) for (const [k, v] of Object.entries(db.days[d][field] || {})) acc[k] = (acc[k] || 0) + v;
    return Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, n);
  };
  const v30 = sum(last30, (x) => x.views), u30 = sum(last30, (x) => x.uniques);
  const m30 = sum(last30, (x) => x.mobile), dk30 = sum(last30, (x) => x.desktop);
  const maxV = Math.max(1, ...last30.map((d) => db.days[d].views));
  const refs = top(last30, 'refs'), sts = top(last30, 'stations', 20);
  const shareN = (ch) => sum(last30, (x) => Object.entries(x.shares || {}).filter(([k]) => k.endsWith(':' + ch)).reduce((a, [, v]) => a + v, 0));
  const viaN = (ch) => sum(last30, (x) => (x.via || {})[ch] || 0);
  const pageN = (p) => sum(last30, (x) => (x.pages || {})[p] || 0);
  const shareRows = Object.keys(VIA_NAME).map((ch) => [VIA_NAME[ch], shareN(ch), viaN(ch)]);
  const maxR = Math.max(1, ...refs.map((r) => r[1])), maxS = Math.max(1, ...sts.map((r) => r[1]));
  const pct = (a, t) => (t ? Math.round((a / t) * 100) + ' %' : '—');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>:~# caudal · estadísticas</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/style.css"></head>
<body class="stats-page"><main class="stats-main">
<p class="prompt-line">:~# ${esc(host)}/stats</p>
<h1><a href="/" class="home">caudal</a> · estadísticas</h1>
<p class="tagline">sin cookies, sin IPs guardadas, solo totales por día</p>

<section class="card"><p class="kicker">últimos-30-días</p>
<dl class="kv"><dt>visitas</dt><dd>${nf.format(v30)}</dd><dt>visitantes únicos por día (suma)</dt><dd>${nf.format(u30)}</dd>
<dt>celular</dt><dd>${pct(m30, m30 + dk30)}</dd><dt>compu</dt><dd>${pct(dk30, m30 + dk30)}</dd></dl></section>

<section class="card"><p class="kicker">por-día</p><div class="table-wrap"><table>
<thead><tr><th>día</th><th class="num">visitas</th><th class="num">únicos</th><th class="num">celular</th><th></th></tr></thead><tbody>
${last30.map((d) => { const x = db.days[d]; return `<tr><td>${d}</td><td class="num">${nf.format(x.views)}</td><td class="num">${nf.format(x.uniques)}</td><td class="num">${pct(x.mobile, x.mobile + x.desktop)}</td><td class="bar">${bar(x.views, maxV)}</td></tr>`; }).join('') || '<tr><td colspan="5">todavía no hay visitas</td></tr>'}
</tbody></table></div></section>

<section class="card"><p class="kicker">compartidos</p><div class="table-wrap"><table>
<thead><tr><th>botón</th><th class="num">toques</th><th class="num">visitas desde esos enlaces</th></tr></thead><tbody>
${shareRows.map(([n, a, v]) => `<tr><td>${esc(n)}</td><td class="num">${nf.format(a)}</td><td class="num">${nf.format(v)}</td></tr>`).join('')}
</tbody></table></div><p class="tagline">visitas por página (últimos 30 días): monitor ${nf.format(pageN('monitor'))} · mapa ${nf.format(pageN('mapa'))}</p></section>

<section class="card"><p class="kicker">de-dónde-vienen</p><div class="table-wrap"><table>
<thead><tr><th>sitio</th><th class="num">visitas</th><th></th></tr></thead><tbody>
${refs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${nf.format(v)}</td><td class="bar">${bar(v, maxR)}</td></tr>`).join('') || '<tr><td colspan="3">directo o sin dato</td></tr>'}
</tbody></table></div></section>

<section class="card"><p class="kicker">localidades-consultadas</p><div class="table-wrap"><table>
<thead><tr><th>localidad</th><th class="num">veces</th><th></th></tr></thead><tbody>
${sts.map(([k, v]) => `<tr><td>${esc(names[k] || k)}</td><td class="num">${nf.format(v)}</td><td class="bar">${bar(v, maxS)}</td></tr>`).join('') || '<tr><td colspan="3">todavía no hay datos</td></tr>'}
</tbody></table></div></section>
</main></body></html>`;
}
