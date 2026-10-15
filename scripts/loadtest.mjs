// Prueba de carga: N usuarios simultáneos recorriendo la página como lo haría una persona.
//   node scripts/loadtest.mjs [usuarios=100] [base=http://localhost:8080]
// Para que el límite por IP no frene la prueba, el servidor tiene que correr con RATE_LIMIT=0.
// Lo importante no es solo la latencia sino cuántos pedidos salen hacia servicios externos
// (lo informa /health): tiene que crecer poco o nada con más usuarios.
const USERS = +(process.argv[2] || 100);
const BASE = process.argv[3] || 'http://localhost:8080';

const times = [], errors = {};
async function get(path, headers = {}) {
  const t = performance.now();
  try {
    const r = await fetch(BASE + path, { headers });
    await r.arrayBuffer();
    if (!r.ok && r.status !== 304) errors[r.status] = (errors[r.status] || 0) + 1;
    return r;
  } catch (e) {
    errors[e.code || e.message] = (errors[e.code || e.message] || 0) + 1;
  } finally { times.push(performance.now() - t); }
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mosaicos alrededor de una ciudad al nivel z (como al hacer zoom con el satélite prendido)
function tilesAround(lon, lat, z, span = 2) {
  const deg = 180 / 2 ** z, col = Math.floor((lon + 180) / deg), row = Math.floor((90 - lat) / deg);
  const out = [];
  for (let r = row - span; r <= row + span; r++) for (let c = col - span; c <= col + span; c++) out.push(`/api/tiles/${z}/${r}/${c}.jpg`);
  return out;
}

async function user(data) {
  await sleep(Math.random() * 3000); // llegadas escalonadas en 3 s
  // 1. carga de la página
  const first = await Promise.all(['/', '/app.js', '/style.css', '/geo.json', '/api/data', '/api/extras'].map((p) => get(p)));
  const etags = first.map((r) => r?.headers.get('etag'));
  // 2. abre tres ciudades
  for (let i = 0; i < 3; i++) {
    const st = pick(data.stations);
    const passes = await (await get(`/api/sat/passes/${st.id}`))?.json?.().catch(() => []) ?? [];
    await Promise.all([get(`/api/sat/base/${st.id}.png`), passes[0] && get(`/api/sat/flood/${st.id}.png?date=${passes[0]}`)]);
    await sleep(300 + Math.random() * 700);
  }
  // 3. prende el satélite y hace zoom sobre una de las 5 ciudades más consultadas
  const city = pick(data.stations.slice(0, 5));
  for (const z of [8, 9, 10]) await Promise.all(tilesAround(city.lon, city.lat, z).map((p) => get(p)));
  // 4. vuelve más tarde: revalida con ETag
  await Promise.all(['/', '/app.js', '/style.css', '/geo.json'].map((p, i) => get(p, etags[i] ? { 'if-none-match': etags[i] } : {})));
}

const health = async () => (await (await fetch(BASE + '/health')).json()).outbound_requests_since_start;
const data = await (await fetch(BASE + '/api/data')).json();
const before = await health();
const t0 = performance.now();
await Promise.all(Array.from({ length: USERS }, () => user(data)));
const secs = (performance.now() - t0) / 1000;
const after = await health();

times.sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(0);
const delta = Object.fromEntries(Object.keys(after).map((h) => [h, after[h] - (before[h] || 0)]));
console.log(`${USERS} usuarios · ${times.length} pedidos en ${secs.toFixed(1)} s (${(times.length / secs).toFixed(0)}/s)`);
console.log(`latencia ms → p50 ${q(0.5)} · p95 ${q(0.95)} · p99 ${q(0.99)} · máx ${times.at(-1).toFixed(0)}`);
console.log('errores:', Object.keys(errors).length ? errors : 'ninguno');
console.log('pedidos salientes durante la prueba:', Object.keys(delta).length ? delta : 'ninguno');
