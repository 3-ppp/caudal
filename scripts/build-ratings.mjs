// Genera public/ratings.json: por estación de caudal, cuántos metros sube el río por cada vez que se
// multiplica el caudal (pendiente b de h = a + b·ln Q) y su caudal mediano de referencia.
// Se ajusta con años de alturas diarias (escalas de Prefectura vía INA) contra el caudal GloFAS en la
// misma estación. La capa de barrios lo usa para convertir caudal en subida del río.
//   node scripts/build-ratings.mjs [años=3] [estaciones]   (p. ej. `node scripts/build-ratings.mjs 3 bermejo`: solo esas, el resto se conserva)
import { writeFile, readFile } from 'node:fs/promises';
import { fetchHeightsINAHistory } from '../sources/heights-ina.mjs';

const YEARS = +process.argv[2] || 3;
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const ROOT = new URL('..', import.meta.url);
const API = 'https://flood-api.open-meteo.com/v1/flood';
const MIN_PTS = 150, MIN_R = 0.8;

// estación → escalas de Prefectura próximas (mismo esquema que public/app.js)
const PORTS = {
  itati: ['ITA IBATE', 'ITATI', 'PASO DE LA PATRIA'], yacyreta: ['ITUZAINGO'], posadas: ['POSADAS'],
  corrientes: ['CORRIENTES', 'BARRANQUERAS', 'EMPEDRADO'], bellavista: ['BELLA VISTA'], goya: ['GOYA', 'RECONQUISTA'],
  lapaz: ['ESQUINA', 'LA PAZ', 'SANTA ELENA'], santafe: ['HERNANDARIAS', 'SANTA FE', 'PARANA'], diamante: ['DIAMANTE'],
  rosario: ['SAN LORENZO', 'ROSARIO', 'VICTORIA'], sannicolas: ['VILLA CONSTITUCION', 'SAN NICOLAS'], sanpedro: ['RAMALLO', 'SAN PEDRO'],
  delta: ['BARADERO', 'ZARATE', 'CAMPANA'],
  elsoberbio: ['EL SOBERBIO', 'ALBA POSSE', 'PANAMBI', 'SAN JAVIER'],
  santotome: ['PUERTO CONCEPCION', 'GARRUCHOS', 'SANTO TOME', 'ALVEAR', 'LA CRUZ'],
  pasolibres: ['YAPEYU', 'PASO DE LOS LIBRES', 'BOMPLAND'], montecaseros: ['MONTE CASEROS', 'MOCORETA'],
  concordia: ['SALTO GRANDE ABAJO', 'CONCORDIA'], colon: ['COLON', 'CONCEPCION DEL URUGUAY'],
  fraybentos: ['CAMPICHUELO'], nuevapalmira: ['PARANACITO'],
  // Bermejo: el modelo lo sigue bien (r ≈ 0,9 contra las alturas del INA). El Paraguay y el Pilcomayo no se ajustan: el
  // modelo no los sigue (humedales, remanso, cauce cambiante).
  bermejo: ['EL COLORADO (SERIE LARGA)', 'SAUZALITO (SERIE LARGA)', 'PUERTO LAVALLE'],
};

const cal = JSON.parse(await readFile(new URL('data/stations.calibrated.json', ROOT), 'utf8'));
const stations = Object.fromEntries([...cal.main, ...cal.uruguay, ...cal.tributaries].map((s) => [s.id, s]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

async function flows(st) {
  const url = `${API}?latitude=${st.glat}&longitude=${st.glon}&daily=river_discharge&start_date=${ymd(Date.now() - YEARS * 365 * 864e5)}&end_date=${ymd(Date.now() - 864e5)}`;
  for (let k = 0; ; k++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60e3) });
    if (res.ok) {
      const { daily } = await res.json();
      return new Map(daily.time.map((d, i) => [d, daily.river_discharge[i]]));
    }
    if (k > 6) throw new Error(`GloFAS: HTTP ${res.status}`);
    const wait = res.status === 429 ? 5 * 60e3 : 5e3; // el límite por hora tarda en liberarse
    console.log(`  (${res.status}, espero ${wait / 1000} s)`);
    await sleep(wait);
  }
}

function fit(pts) {
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return { b: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), n };
}
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };

const out = {};
for (const [id, ports] of Object.entries(PORTS)) {
  if (ONLY && !ONLY.includes(id)) continue;
  const st = stations[id];
  if (!st) continue;
  const q = await flows(st);
  const fits = [];
  for (const port of ports) {
    let hist;
    try { hist = await fetchHeightsINAHistory(port, YEARS * 365); } catch { continue; }
    const pts = hist.filter((x) => q.get(x.date) > 0 && x.height_m != null).map((x) => [Math.log(q.get(x.date)), x.height_m]);
    if (pts.length < MIN_PTS) continue;
    const f = fit(pts);
    if (f.b > 0 && f.r >= MIN_R) fits.push({ port, ...f });
  }
  const qs = [...q.values()].filter((v) => v > 0);
  if (!fits.length) { console.log(id.padEnd(13), 'sin ajuste válido'); continue; }
  out[id] = { b: +median(fits.map((f) => f.b)).toFixed(2), qref: Math.round(median(qs)), r: +median(fits.map((f) => f.r)).toFixed(2), ports: fits.map((f) => f.port) };
  console.log(id.padEnd(13), `b=${out[id].b}  r=${out[id].r}  Qmediano=${out[id].qref}  (${fits.map((f) => `${f.port} n=${f.n}`).join(', ')})`);
  await sleep(1500);
}
// Paraguay: sin curva altura–caudal (el modelo de caudal no lo sigue en Formosa y Clorinda). La subida de cada día se
// toma de la altura medida en la escala de Prefectura menos su mediana de los últimos años.
const OBS = { paraguay_formosa: 'FORMOSA', paraguay_clorinda: 'PUERTO PILCOMAYO' };
for (const [id, port] of Object.entries(OBS)) {
  if (ONLY && !ONLY.includes(id)) continue;
  const hist = await fetchHeightsINAHistory(port, YEARS * 365);
  const v = hist.map((x) => x.height_m).filter((x) => x != null);
  if (v.length < MIN_PTS) { console.log(id.padEnd(13), 'sin historia suficiente'); continue; }
  out[id] = { obs: true, port, river: 'PARAGUAY', hmed: +median(v).toFixed(2), n: v.length };
  console.log(id.padEnd(13), `altura mediana ${out[id].hmed} m (${port}, n=${v.length})`);
}
if (ONLY) { // se conservan las curvas de las demás estaciones
  try { Object.assign(out, { ...JSON.parse(await readFile(new URL('public/ratings.json', ROOT), 'utf8')).estaciones, ...out }); } catch {}
}
await writeFile(new URL('public/ratings.json', ROOT), JSON.stringify({
  generado: ymd(Date.now()), anios: YEARS,
  nota: 'b = metros de subida por unidad de ln(caudal); qref = caudal GloFAS mediano del período.', estaciones: out,
}));
console.log('public/ratings.json:', Object.keys(out).length, 'estaciones');
