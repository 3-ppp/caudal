// Paraná — servidor + recolector. Sin dependencias: Node 18+.
//   node server.mjs            → http://localhost:8080
//   PORT=3000 node server.mjs
//   HOST=0.0.0.0 para escuchar en todas las interfaces (por defecto, solo localhost)
//   DATA_DIR=/ruta para guardar datos y cachés fuera del directorio de la app
// Fuente de caudal: GloFAS (Copernicus) vía Open-Meteo Flood API, modelo diario a 0.05°.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import zlib, { gzipSync, brotliCompressSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalytics } from './analytics.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
// puntos calibrados: configuración que viaja con la app (no es caché)
const CAL_FILE = path.join(ROOT, 'data', 'stations.calibrated.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = +(process.env.PORT || 8080);
const REFRESH_MS = 3 * 3600e3;          // GloFAS se actualiza una vez por día
const PAST_DAYS = 120;
const FORECAST_DAYS = 31;
const CLIM_START = '2000-01-01', CLIM_END = '2024-12-31';
const CLIM_WINDOW = 10;                  // ± días alrededor de cada fecha del año
const API = 'https://flood-api.open-meteo.com/v1/flood';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJSON = async (f) => JSON.parse(await readFile(f, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 5) {
  for (let i = 1; ; i++) {
    let wait = 5000 * i;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120e3) });
      if (res.status === 429) wait = 65e3; // límite por minuto de Open-Meteo
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      log(`reintento en ${wait / 1000}s (${e.message.slice(0, 60)})`);
      await sleep(wait);
    }
  }
}

async function loadStations() {
  const cal = await readJSON(CAL_FILE);
  const geo = await readJSON(path.join(PUBLIC, 'geo.json'));
  return [
    ...cal.main.map((s) => ({ ...s, kind: 'main', river: 'parana', km: geo.stationKm[s.id] })),
    ...cal.tributaries.map((s) => ({ ...s, kind: 'trib', river: 'parana' })),
    ...(cal.uruguay || []).map((s) => ({ ...s, kind: 'main', river: 'uruguay', km: geo.stationKm[s.id] })),
  ];
}

// ---------- climatología 2000–2024: percentiles por día del año
const doy = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5); // 0..365
};
const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

async function buildClimatology(st) {
  const url = `${API}?latitude=${st.glat}&longitude=${st.glon}&daily=river_discharge` +
    `&start_date=${CLIM_START}&end_date=${CLIM_END}`;
  const j = await getJSON(url);
  const { time, river_discharge: q } = j.daily;
  const byDoy = Array.from({ length: 366 }, () => []);
  let rec = { q: -1, date: null }, sum = 0, n = 0;
  time.forEach((t, i) => {
    const v = q[i];
    if (v == null) return;
    const d = doy(t);
    for (let k = -CLIM_WINDOW; k <= CLIM_WINDOW; k++) byDoy[(d + k + 366) % 366].push(v);
    if (v > rec.q) rec = { q: v, date: t };
    sum += v; n++;
  });
  const r = (v) => (v == null ? null : Math.round(v));
  return {
    p10: byDoy.map((a) => r(pct(a.sort((x, y) => x - y), 0.10))),
    p50: byDoy.map((a) => r(pct(a, 0.50))),
    p90: byDoy.map((a) => r(pct(a, 0.90))),
    max: byDoy.map((a) => r(a.at(-1))),
    record: { q: r(rec.q), date: rec.date },
    mean: r(sum / (n || 1)),
    years: `${CLIM_START.slice(0, 4)}–${CLIM_END.slice(0, 4)}`,
  };
}

async function ensureClimatology(stations) {
  const file = path.join(DATA, 'climatology.json');
  let clim = {};
  try { clim = await readJSON(file); } catch {}
  for (const st of stations) {
    const key = `${st.id}@${st.glat},${st.glon}`;
    if (clim[key]) continue;
    log(`climatología: ${st.id}…`);
    clim[key] = await buildClimatology(st);
    await writeFile(file, JSON.stringify(clim));
    await sleep(4000); // 25 años diarios pesan en la cuota por minuto de la API
  }
  return (st) => clim[`${st.id}@${st.glat},${st.glon}`];
}

// ---------- serie reciente + pronóstico
async function refresh() {
  const stations = await loadStations();
  const climOf = await ensureClimatology(stations);
  const url = `${API}?latitude=${stations.map((s) => s.glat)}&longitude=${stations.map((s) => s.glon)}` +
    `&daily=river_discharge,river_discharge_p25,river_discharge_p75` +
    `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`;
  let res = await getJSON(url);
  if (!Array.isArray(res)) res = [res];

  const days = res[0].daily.time;
  // fecha de Argentina: el corte entre observación y pronóstico no puede saltar a las 21 h
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  const r = (v) => (v == null ? null : Math.round(v));
  const out = {
    updated: new Date().toISOString(),
    today,
    days,
    source: 'GloFAS (Copernicus Emergency Management Service) vía Open-Meteo Flood API',
    stations: stations.map((st, i) => {
      const d = res[i].daily, c = climOf(st);
      const isFc = days.map((t) => t > today);
      return {
        id: st.id, name: st.name, sub: st.sub, kind: st.kind, river: st.river, km: st.km ?? null, joins: st.joins ?? null,
        lat: st.lat, lon: st.lon,
        q: d.river_discharge.map(r),
        lo: d.river_discharge_p25.map((v, k) => (isFc[k] ? r(v) : null)),
        hi: d.river_discharge_p75.map((v, k) => (isFc[k] ? r(v) : null)),
        clim: {
          p10: days.map((t) => c.p10[doy(t)]),
          p50: days.map((t) => c.p50[doy(t)]),
          p90: days.map((t) => c.p90[doy(t)]),
          max: days.map((t) => c.max[doy(t)]),
          record: c.record, mean: c.mean, years: c.years,
        },
      };
    }),
  };
  await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(out));
  log(`datos actualizados: ${out.stations.length} puntos, ${days[0]} → ${days.at(-1)}`);
}

let refreshing = null;
async function safeRefresh() {
  if (refreshing) return refreshing;
  refreshing = refresh().catch((e) => log('error al actualizar:', e.message)).finally(() => (refreshing = null));
  return refreshing;
}

// ---------- fuentes complementarias: alturas medidas, represas, satélite.
// Cada una es un módulo opcional en sources/: si falta o falla, el resto sigue.
const EXTRAS_MS = 3600e3;
const HISTORY_DAYS = 400;

async function optionalImport(name) {
  try { return await import(`./sources/${name}.mjs`); }
  catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') log(`sources/${name}: ${e.message}`); return null; }
}

// Serie histórica propia de alturas (una lectura por día y puerto). La primera vez se completa
// con el histórico de 30 días de la fuente (histFn); después se suma cada lectura nueva.
const HEIGHT_RIVERS = /PARANA|PARAGUAY|IGUAZU|URUGUAY/;
async function appendHeightHistory(pref, histFn) {
  const file = path.join(DATA, 'heights-history.json');
  let h = {};
  try { h = await readJSON(file); } catch {}
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  // El sitio bloquea ráfagas (403): pocos pedidos por vuelta, espaciados, y se corta ante el primer error.
  // Con la actualización horaria, el histórico de todos los puertos se completa en unas horas.
  if (histFn) {
    let budget = 5;
    for (const s of pref.stations) {
      const key = `${s.river}|${s.port}`;
      if (!budget || !HEIGHT_RIVERS.test(s.river) || Object.keys(h[key] || {}).length >= 5) continue;
      budget--;
      try {
        for (const r of (await histFn(s)) || []) if (r.height_m != null) (h[key] ||= {})[r.date] = r.height_m;
      } catch (e) { log(`historial ${s.port}: ${e.message} — se reintenta en la próxima vuelta`); break; }
      await sleep(4000);
    }
  }
  for (const s of pref.stations) {
    if (s.height_m == null || !s.date) continue;
    const key = `${s.river}|${s.port}`;
    (h[key] ||= {})[s.date] = s.height_m;
    for (const d of Object.keys(h[key])) if (d < cutoff) delete h[key][d];
  }
  await writeFile(file, JSON.stringify(h));
  return h;
}

// Serie de cada represa guardada en disco: se piden solo los días que faltan, como mucho una vez
// por día (Salto Grande se arma raspando su sitio, varios pedidos por día: hay que ser mesurado).
const DAM_BACKFILL = { saltogrande: 30 }; // primera carga corta donde cada día cuesta varios pedidos
async function fetchDam(id, fn) {
  const file = path.join(DATA, `dam-${id}.json`);
  let cache = { fetched: 0, source: '', series: [] };
  try { cache = await readJSON(file); } catch {}
  if (Date.now() - cache.fetched < 20 * 3600e3 && cache.series.length) return cache;
  const lastDate = cache.series.at(-1)?.date;
  const missing = lastDate ? Math.ceil((Date.now() - Date.parse(lastDate)) / 864e5) + 2 : (DAM_BACKFILL[id] ?? PAST_DAYS);
  let r;
  try { r = await fn({ days: Math.min(missing, PAST_DAYS) }); }
  catch (e) { if (cache.series.length) { log(`${id}: ${e.message} (se usa lo guardado)`); return cache; } throw e; }
  const byDate = new Map(cache.series.map((s) => [s.date, s]));
  for (const s of r.series) byDate.set(s.date, s); // los días recientes se reemplazan (los operadores corrigen)
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  cache = { fetched: Date.now(), source: r.source, unit: r.unit,
    series: [...byDate.values()].filter((s) => s.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date)) };
  await writeFile(file, JSON.stringify(cache));
  return cache;
}

async function refreshExtras() {
  const file = path.join(DATA, 'extras.json');
  let prev = {};
  try { prev = await readJSON(file); } catch {}
  const out = { updated: new Date().toISOString(), heights: prev.heights ?? null, history: prev.history ?? {},
    dams: prev.dams ?? {}, satellite: prev.satellite ?? null, errors: {} };

  // Alturas: Prefectura; si no responde (su sitio no es alcanzable desde algunos servidores), el INA,
  // que republica sus lecturas. Los umbrales que falten salen de la última tabla conocida de Prefectura.
  let heightsOk = false;
  const pref = await optionalImport('prefectura');
  if (pref) {
    try {
      out.heights = await pref.fetchPrefectura();
      out.history = await appendHeightHistory(out.heights, pref.fetchPrefecturaHistory && ((s) => s.id && pref.fetchPrefecturaHistory(s.id, 30)));
      heightsOk = true;
    } catch (e) { out.errors.prefectura = e.message; }
  }
  if (!heightsOk) {
    const ina = await optionalImport('heights-ina');
    if (ina) {
      try {
        const h = await ina.fetchHeightsINA();
        const umb = await readJSON(path.join(ROOT, 'data', 'umbrales.json')).catch(() => ({ puertos: {} }));
        for (const st of h.stations) {
          const u = umb.puertos[st.port];
          if (u) { st.alert_m ??= u.alert_m; st.evac_m ??= u.evac_m; }
        }
        h.via = 'INA';
        out.heights = h;
        out.history = await appendHeightHistory(h, ina.fetchHeightsINAHistory && ((s) => ina.fetchHeightsINAHistory(s.port, 30)));
        delete out.errors.prefectura; // hay alturas: el respaldo cubrió la falla
        out.notes = { alturas: 'Prefectura no responde desde este servidor; alturas vía INA' };
      } catch (e) { out.errors.ina = e.message; }
    }
  }
  const dams = await optionalImport('dams');
  if (dams) {
    for (const [id, fn] of [['itaipu', 'fetchItaipu'], ['yacyreta', 'fetchYacyreta'], ['saltogrande', 'fetchSaltoGrande']]) {
      if (!dams[fn]) continue;
      try { out.dams[id] = await fetchDam(id, dams[fn]); }
      catch (e) { out.errors[id] = e.message; }
    }
  }
  const sat = await optionalImport('satellite');
  if (sat) {
    try { out.satellite = { latest: await sat.latestFloodDate(), layers: sat.LAYERS }; }
    catch (e) { out.errors.satellite = e.message; }
  }
  await writeFile(file, JSON.stringify(out));
  const errs = Object.entries(out.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
  log(`fuentes complementarias actualizadas${errs ? ` (errores → ${errs})` : ''}`);
}
let refreshingExtras = null;
const safeRefreshExtras = () => (refreshingExtras ||= refreshExtras()
  .catch((e) => log('error en fuentes complementarias:', e.message))
  .finally(() => (refreshingExtras = null)));

// Recorte satelital alrededor de un punto, cacheado en disco (la imagen base no cambia; la de
// inundación se guarda por fecha)
const SAT_HALF = { lon: 0.28, lat: 0.22 };
function satImage(layer, id, date) {
  return once(`sat|${layer}|${id}|${date}`, () => satImageRaw(layer, id, date));
}
async function satImageRaw(layer, id, date) {
  const sat = await optionalImport('satellite');
  if (!sat) throw new Error('sin módulo satelital');
  const cal = await readJSON(CAL_FILE);
  const st = [...cal.main, ...cal.tributaries, ...(cal.uruguay || [])].find((s) => s.id === id);
  if (!st) throw new Error('punto desconocido');
  if (layer === 'flood' && !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('fecha inválida');
  const dir = path.join(DATA, 'sat');
  const file = path.join(dir, `${layer}-${id}${layer === 'flood' ? '-' + date : ''}.png`);
  // las pasadas de hoy y ayer pueden completarse más tarde: se refrescan cada 2 h
  const recent = layer === 'flood' && date >= new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  try {
    if (!recent || Date.now() - (await stat(file)).mtimeMs < 2 * 3600e3) return await readFile(file);
  } catch {}
  const bbox = [st.lon - SAT_HALF.lon, st.lat - SAT_HALF.lat, st.lon + SAT_HALF.lon, st.lat + SAT_HALF.lat];
  const width = 640;
  const height = Math.round(width * (2 * SAT_HALF.lat) / (2 * SAT_HALF.lon * Math.cos(st.lat * Math.PI / 180)));
  // Inundación: una sola pasada por imagen. Acumular días suma artefactos de borde de pasada
  // que se ven como franjas rectas de "agua" sobre campos secos.
  const url = layer === 'base' ? sat.baseUrl({ bbox, width, height }) : sat.floodUrl({ bbox, width, height, date, days: 1 });
  countOut(url);
  const res = await limitedFetch(url);
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) throw new Error(`satélite: HTTP ${res.status} ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dir, { recursive: true });
  await writeFile(file, buf);
  return buf;
}

// Días de los últimos PASS_DAYS en que Sentinel-1 pasó sobre el punto y detectó agua fuera de lugar.
// Se recorre de a una fecha (el servicio admite pocos pedidos simultáneos) y se cachea por hora.
const PASS_DAYS = 14;
const passCache = new Map();
async function satPasses(id) {
  const hit = passCache.get(id);
  if (hit && Date.now() - hit.t < 3600e3) return hit.dates;
  return once(`passes|${id}`, () => satPassesRaw(id));
}
async function satPassesRaw(id) {
  const sat = await optionalImport('satellite');
  if (!sat?.pngHasContent) throw new Error('sin módulo satelital');
  const dates = [];
  for (let k = 0; k < PASS_DAYS; k++) {
    const d = new Date(Date.now() - k * 864e5).toISOString().slice(0, 10);
    try { if (sat.pngHasContent(await satImage('flood', id, d))) dates.push(d); } catch {}
  }
  passCache.set(id, { t: Date.now(), dates });
  return dates;
}

// ---------- mosaicos satelitales (Sentinel-2 cloudless 2025, EOX) en grilla lat/lon fija
// Nivel n: mosaicos de 180/2^n grados, 256 px, origen arriba a la izquierda en (90°N, 180°O).
// La grilla es fija y el mosaico anual no cambia: cada mosaico se pide una vez y queda en disco.
const TILE_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025/default/WGS84';
const TILE_BOX = { w: -70, e: -40, s: -40, n: -10 }; // solo la cuenca
const TILE_BUDGET = 3000; // mosaicos nuevos (no cacheados) por hora
const tileBudget = { t: Date.now(), n: 0 };
function satTile(z, row, col) {
  const deg = 180 / 2 ** z, lon = col * deg - 180, lat = 90 - row * deg;
  if (z < 3 || z > 13 || lon + deg < TILE_BOX.w || lon > TILE_BOX.e || lat < TILE_BOX.s || lat - deg > TILE_BOX.n) {
    return Promise.reject(Object.assign(new Error('mosaico fuera de rango'), { status: 404 }));
  }
  const file = path.join(DATA, 'tiles', String(z), String(row), `${col}.jpg`);
  return once(`tile|${z}|${row}|${col}`, async () => {
    try { return await readFile(file); } catch {}
    // tope global de mosaicos nuevos por hora: protege a EOX de un recorrido masivo
    const now = Date.now();
    if (now - tileBudget.t > 3600e3) Object.assign(tileBudget, { t: now, n: 0 });
    if (++tileBudget.n > TILE_BUDGET) throw Object.assign(new Error('mosaico no disponible por ahora'), { status: 503 });
    const url = `${TILE_URL}/${z}/${row}/${col}.jpg`;
    countOut(url);
    const res = await limitedFetch(url);
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) throw new Error(`mosaico: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);
    return buf;
  });
}

// Pasadas del radar de todas las ciudades, precalculadas en segundo plano: ningún usuario espera
// la primera consulta. Los días cerrados quedan en disco; solo se reconsultan hoy y ayer.
async function warmPasses() {
  try {
    const cal = await readJSON(CAL_FILE);
    for (const st of [...cal.main, ...cal.tributaries, ...(cal.uruguay || [])]) {
      await satPasses(st.id).catch(() => {});
      await satImage('base', st.id).catch(() => {});
    }
  } catch (e) { log('precalentado satelital:', e.message); }
}

// Mosaicos precalentados una sola vez: la cuenca entera en niveles 4–6 (satélite sin zoom) y
// alrededor de cada ciudad en 8–9 (lo que muestra "ver en el mapa"). ~1000 mosaicos; los ya
// guardados en disco no generan pedidos.
async function warmTiles() {
  const want = [];
  for (const z of [4, 5, 6]) {
    const deg = 180 / 2 ** z;
    for (let r = Math.floor((90 - TILE_BOX.n) / deg); r <= Math.floor((90 - TILE_BOX.s) / deg); r++)
      for (let c = Math.floor((TILE_BOX.w + 180) / deg); c <= Math.floor((TILE_BOX.e + 180) / deg); c++) want.push([z, r, c]);
  }
  try {
    const cal = await readJSON(CAL_FILE);
    for (const st of [...cal.main, ...cal.tributaries, ...(cal.uruguay || [])]) {
      for (const [z, span] of [[8, 1], [9, 2]]) {
        const deg = 180 / 2 ** z, col = Math.floor((st.lon + 180) / deg), row = Math.floor((90 - st.lat) / deg);
        for (let r = row - span; r <= row + span; r++) for (let c = col - span; c <= col + span; c++) want.push([z, r, c]);
      }
    }
  } catch {}
  let fetched = 0;
  for (const [z, r, c] of want) {
    const file = path.join(DATA, 'tiles', String(z), String(r), `${c}.jpg`);
    try { await stat(file); continue; } catch {}
    try { await satTile(z, r, c); fetched++; } catch {}
  }
  if (fetched) log(`mosaicos precalentados: ${fetched} nuevos de ${want.length}`);
}

// ---------- protección de los servicios externos
// Un pedido en curso se comparte: si 20 personas abren la misma ciudad, sale un solo pedido.
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
// Pedidos simultáneos máximos por servicio (GFM admite 10 por usuario; dejamos margen)
const LIMITS = { 'geoserver.gfm.eodc.eu': 4, 'tiles.maps.eox.at': 6 };
const slots = new Map();
async function limitedFetch(url, opts = {}) {
  const host = new URL(url).host, max = LIMITS[host] ?? 4;
  const s = slots.get(host) ?? { busy: 0, queue: [] };
  slots.set(host, s);
  if (s.busy >= max) await new Promise((r) => s.queue.push(r));
  s.busy++;
  try { return await fetch(url, { signal: AbortSignal.timeout(60e3), ...opts }); }
  finally { s.busy--; s.queue.shift()?.(); }
}
// Contador de pedidos salientes por servicio (lo muestra /health; sirve para pruebas de carga)
const outbound = {};
const countOut = (url) => { const h = new URL(url).host; outbound[h] = (outbound[h] || 0) + 1; };

// Límite simple por IP para los endpoints que pueden disparar pedidos externos
// Holgado a propósito: con CGNAT (habitual en redes móviles) cientos de personas comparten una IP.
// RATE_LIMIT=0 lo desactiva (pruebas de carga).
const RATE = { tiles: [3000, 60e3], sat: [600, 60e3], hit: [120, 60e3] }; // [pedidos, ventana ms]
const hits = new Map();
function rateLimited(req, kind) {
  if (process.env.RATE_LIMIT === '0') return false;
  const ip = (process.env.TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  const [max, win] = RATE[kind], key = kind + '|' + ip, now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.t > win) { hits.set(key, { t: now, n: 1 }); return false; }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 120e3) hits.delete(k); }, 60e3).unref();

// ---------- respuestas: ETag + compresión hecha una sola vez por contenido
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg' };
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
const fileCache = new Map(); // ruta → { mtimeMs, body, etag, type, gz, br }
async function cachedFile(file) {
  const st = await stat(file);
  let c = fileCache.get(file);
  if (!c || c.mtimeMs !== st.mtimeMs) {
    const body = await readFile(file);
    c = { mtimeMs: st.mtimeMs, body, type: TYPES[path.extname(file)] || 'application/octet-stream',
      etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"' };
    if (COMPRESSIBLE.test(c.type) && body.length > 1024) {
      c.br = brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
      c.gz = gzipSync(body, { level: 9 });
    }
    fileCache.set(file, c);
  }
  return c;
}
function send(req, res, c, cacheControl) {
  const headers = { 'content-type': c.type, 'cache-control': cacheControl, vary: 'accept-encoding' };
  if (c.etag) {
    headers.etag = c.etag;
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
  }
  const ae = req.headers['accept-encoding'] || '';
  let body = c.body;
  if (c.br && /\bbr\b/.test(ae)) { body = c.br; headers['content-encoding'] = 'br'; }
  else if (c.gz && /\bgzip\b/.test(ae)) { body = c.gz; headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
const sendText = (res, status, msg, extra = {}) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra });
  res.end(msg);
};
const imgType = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png');

// ---------- estado de las fuentes (para monitoreo)
async function health() {
  const age = async (f) => { try { return Math.round((Date.now() - (await stat(path.join(DATA, f))).mtimeMs) / 60e3); } catch { return null; } };
  let extras = {};
  try { extras = await readJSON(path.join(DATA, 'extras.json')); } catch {}
  const damLast = Object.fromEntries(Object.entries(extras.dams || {}).map(([k, d]) => [k, d?.series?.at(-1)?.date ?? null]));
  const out = {
    ok: true,
    minutes_since: { model: await age('latest.json'), extras: await age('extras.json') },
    prefectura_reading: extras.heights?.fetchedAt ?? null,
    dams_last_day: damLast,
    satellite_latest: extras.satellite?.latest ?? null,
    errors: extras.errors ?? {},
    outbound_requests_since_start: outbound,
    uptime_min: Math.round(process.uptime() / 60),
  };
  // el modelo debería tener menos de 6 h y las fuentes complementarias menos de 3 h
  out.ok = out.minutes_since.model != null && out.minutes_since.model < 360 && out.minutes_since.extras != null && out.minutes_since.extras < 180;
  return out;
}

// ---------- servidor estático + API
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // estadísticas: aviso de la página al elegir una localidad (cuerpo mínimo, sin cookies)
    if (p === '/api/hit' && req.method === 'POST') {
      if (rateLimited(req, 'hit')) return sendText(res, 429, '');
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) { body += chunk; if (body.length > 300) break; }
      analytics.hit(req, body.slice(0, 300));
      res.writeHead(204); return res.end();
    }
    // estadísticas privadas: sin la clave, la página no existe
    if (p === '/stats') {
      if (!analytics.authorized(url.searchParams.get('key'))) return sendText(res, 404, 'no encontrado');
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      return res.end(analytics.report(stationNames, req.headers['x-forwarded-host'] || req.headers.host));
    }
    if (p === '/api/data') return send(req, res, await cachedFile(path.join(DATA, 'latest.json')), 'public, max-age=300');
    if (p === '/api/extras') {
      try { return send(req, res, await cachedFile(path.join(DATA, 'extras.json')), 'public, max-age=300'); }
      catch { return sendText(res, 200, '{}', { 'content-type': TYPES['.json'] }); }
    }
    if (p === '/health') {
      const h = await health();
      res.writeHead(h.ok ? 200 : 503, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      return res.end(JSON.stringify(h, null, 2));
    }
    const tm = p.match(/^\/api\/tiles\/(\d+)\/(\d+)\/(\d+)\.jpg$/);
    if (tm) {
      if (rateLimited(req, 'tiles')) return sendText(res, 429, 'demasiados pedidos', { 'retry-after': '60' });
      try {
        const img = await satTile(+tm[1], +tm[2], +tm[3]);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': img.length });
        return res.end(img);
      } catch (e) { return sendText(res, e.status || 502, e.message); }
    }
    if (p.startsWith('/api/sat/') && rateLimited(req, 'sat')) return sendText(res, 429, 'demasiados pedidos', { 'retry-after': '60' });
    const pm = p.match(/^\/api\/sat\/passes\/([a-z]+)$/);
    if (pm) {
      try {
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'public, max-age=1800' });
        return res.end(JSON.stringify(await satPasses(pm[1])));
      } catch (e) { return sendText(res, 404, e.message); }
    }
    const m = p.match(/^\/api\/sat\/(base|flood)\/([a-z]+)\.png$/);
    if (m) {
      try {
        const img = await satImage(m[1], m[2], url.searchParams.get('date'));
        // la imagen base no cambia; las pasadas de días cerrados tampoco
        res.writeHead(200, { 'content-type': imgType(img), 'cache-control': 'public, max-age=86400', 'content-length': img.length });
        return res.end(img);
      } catch (e) { return sendText(res, 404, e.message); }
    }
    if ((p === '/' || p === '/index.html') && req.method === 'GET') analytics.pageView(req);
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return sendText(res, 403, 'prohibido');
    // no-cache + ETag: el navegador revalida y, si no cambió, recibe un 304 sin cuerpo
    return send(req, res, await cachedFile(file), 'no-cache');
  } catch (e) {
    if (p === '/api/data') return sendText(res, 503, 'datos todavía no disponibles');
    return sendText(res, 404, 'no encontrado');
  }
});

await mkdir(DATA, { recursive: true });
const allStations = await loadStations();
const stationNames = Object.fromEntries(allStations.map((s) => [s.id, s.kind === 'trib' ? `río ${s.name}` : s.name]));
const analytics = await createAnalytics({ dataDir: DATA, ownHost: process.env.SITE_HOST || null,
  stationIds: new Set(allStations.map((s) => s.id)), log });
// al apagar (deploy, reinicio) se guardan los totales pendientes
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => analytics.flush().finally(() => process.exit(0)));
server.listen(PORT, HOST, () => log(`Caudal en http://${HOST}:${PORT} · datos en ${DATA}`));
try {
  const s = await stat(path.join(DATA, 'latest.json'));
  // se actualiza si los datos son viejos o si se agregaron puntos al río desde la última vez
  const have = new Set((await readJSON(path.join(DATA, 'latest.json'))).stations.map((x) => x.id));
  const want = (await loadStations()).map((x) => x.id);
  if (Date.now() - s.mtimeMs > REFRESH_MS || want.some((id) => !have.has(id))) safeRefresh();
} catch { safeRefresh(); }
setInterval(safeRefresh, REFRESH_MS);
safeRefreshExtras().then(warmPasses).then(warmTiles);
setInterval(() => safeRefreshExtras().then(warmPasses), EXTRAS_MS);
