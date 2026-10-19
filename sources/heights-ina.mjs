// Alturas de ríos vía INA (Instituto Nacional del Agua) — Sistema de Alerta Hidrológico, API "A5".
// Zero-dependency, Node >= 18 (fetch global). Fallback de prefectura.mjs cuando Prefectura no es alcanzable.
//
// Cómo se encontraron las series (una sola vez, a mano):
//   GET https://alerta.ina.gob.ar/a5/obs/puntual/estaciones?tabla=alturas_prefe
//       -> red "escalas Prefectura Nacional" (tabla alturas_prefe): INA republica las escalas de Prefectura.
//          Cada estación trae nivel_alerta / nivel_evacuacion (m) y rio (PARANAMED, PARANAINF, URUGUAY, ...).
//   GET https://alerta.ina.gob.ar/a5/obs/puntual/series?var_id=2&proc_id=1&tabla=alturas_prefe
//       -> series de "Altura hidrométrica" (var_id 2), "medición directa" (proc_id 1).
//          En esta red series_id === estacion.id (ej. Rosario = 34), y date_range muestra cuáles están vivas.
//   GET https://alerta.ina.gob.ar/a5/obs/puntual/observaciones?series_id=34,29,...&timestart=YYYY-MM-DD&timeend=YYYY-MM-DD
//       -> observaciones de varias series en un solo request (valor en metros).
// Las observaciones son diarias (timestart = 00:00 hora argentina = 03:00Z; valor = lectura matinal de Prefectura).
// Hora argentina = UTC-3 sin DST. Estaciones cortadas (Puerto Maní desde 2024) quedan en la tabla pero se omiten
// del resultado si no hay lecturas en la ventana.

import { pathToFileURL } from 'node:url';

export const SOURCE = 'INA (Sistema de Alerta Hidrológico), republica Prefectura';
const BASE = 'https://alerta.ina.gob.ar/a5/obs/puntual';
const UA = 'Mozilla/5.0 (compatible; parana-dashboard/1.0)';
const WINDOW_DAYS = 7;
const STATE_THRESHOLD_M = 0.02;
const CHUNK = 30;
const CONCURRENCY = 4;

// port (nombre Prefectura, mayúsculas sin acentos) -> { id: series_id INA (= estacion_id), river }
export const SERIES = {
  // PARANA
  'LIBERTAD': { id: 10, river: 'PARANA' },
  'ELDORADO': { id: 11, river: 'PARANA' },
  'LIBERTADOR': { id: 12, river: 'PARANA' },
  'PUERTO MANI': { id: 131, river: 'PARANA' }, // cortada en 2024
  'SANTA ANA': { id: 13, river: 'PARANA' },
  'POSADAS': { id: 14, river: 'PARANA' },
  'ITUZAINGO': { id: 15, river: 'PARANA' },
  'ITA IBATE': { id: 16, river: 'PARANA' },
  'ITATI': { id: 17, river: 'PARANA' },
  'PASO DE LA PATRIA': { id: 18, river: 'PARANA' },
  'CORRIENTES': { id: 19, river: 'PARANA' },
  'BARRANQUERAS': { id: 20, river: 'PARANA' },
  'EMPEDRADO': { id: 21, river: 'PARANA' },
  'BELLA VISTA': { id: 22, river: 'PARANA' },
  'GOYA': { id: 23, river: 'PARANA' },
  'RECONQUISTA': { id: 24, river: 'PARANA' },
  'ESQUINA': { id: 25, river: 'PARANA' },
  'LA PAZ': { id: 26, river: 'PARANA' },
  'SANTA ELENA': { id: 27, river: 'PARANA' },
  'HERNANDARIAS': { id: 28, river: 'PARANA' },
  'SANTA FE': { id: 30, river: 'PARANA' },
  'PARANA': { id: 29, river: 'PARANA' },
  'DIAMANTE': { id: 31, river: 'PARANA' },
  'SAN LORENZO': { id: 33, river: 'PARANA' },
  'ROSARIO': { id: 34, river: 'PARANA' },
  'VICTORIA': { id: 32, river: 'PARANA' },
  'VILLA CONSTITUCION': { id: 35, river: 'PARANA' },
  'SAN NICOLAS': { id: 36, river: 'PARANA' },
  'RAMALLO': { id: 37, river: 'PARANA' },
  'SAN PEDRO': { id: 38, river: 'PARANA' },
  'BARADERO': { id: 39, river: 'PARANA' },
  'ZARATE': { id: 40, river: 'PARANA' },
  'CAMPANA': { id: 41, river: 'PARANA' },
  // URUGUAY
  'EL SOBERBIO': { id: 61, river: 'URUGUAY' },
  'ALBA POSSE': { id: 63, river: 'URUGUAY' },
  'PANAMBI': { id: 64, river: 'URUGUAY' },
  'SAN JAVIER': { id: 65, river: 'URUGUAY' },
  'PUERTO CONCEPCION': { id: 66, river: 'URUGUAY' },
  'GARRUCHOS': { id: 67, river: 'URUGUAY' },
  'SANTO TOME': { id: 68, river: 'URUGUAY' },
  'ALVEAR': { id: 69, river: 'URUGUAY' },
  'LA CRUZ': { id: 70, river: 'URUGUAY' },
  'YAPEYU': { id: 71, river: 'URUGUAY' },
  'PASO DE LOS LIBRES': { id: 72, river: 'URUGUAY' },
  'BOMPLAND': { id: 73, river: 'URUGUAY' },
  'MONTE CASEROS': { id: 74, river: 'URUGUAY' },
  'MOCORETA': { id: 75, river: 'URUGUAY' },
  'SALTO GRANDE ABAJO': { id: 78, river: 'URUGUAY' },
  'CONCORDIA': { id: 79, river: 'URUGUAY' },
  'COLON': { id: 80, river: 'URUGUAY' },
  'CONCEPCION DEL URUGUAY': { id: 81, river: 'URUGUAY' },
  'CAMPICHUELO': { id: 82, river: 'URUGUAY' },
  'PARANACITO': { id: 43, river: 'URUGUAY' }, // Villa Paranacito (Delta entrerriano)
  // PARAGUAY (tramo argentino)
  'FORMOSA': { id: 57, river: 'PARAGUAY' },
  'ISLA DEL CERRITO': { id: 59, river: 'PARAGUAY' },
  'PUERTO PILCOMAYO': { id: 55, river: 'PARAGUAY' },
  'BERMEJO': { id: 58, river: 'PARAGUAY' },
  // IGUAZU
  'IGUAZU': { id: 8, river: 'IGUAZU' }, // Andresito (río Iguazú)
  'PUERTO IGUAZU': { id: 9, river: 'IGUAZU' },
};
// Bermejo y Pilcomayo: no están en la red de Prefectura. Son series de la red de telemetría del INA ("sat2", altura
// hidrométrica, lectura de varias veces por día): `id` es el de la SERIE, no el de la estación. Sin niveles de alerta.
// lat/lon: ubicación de la estación, para dibujarla donde el río no tiene punto de caudal.
export const EXTRA = {
  'EL COLORADO': { id: 6697, river: 'BERMEJO', lat: -26.3342, lon: -59.3625 },
  'PUERTO LAVALLE': { id: 6917, river: 'BERMEJO', lat: -25.6511, lon: -60.1281 },
  'PUERTO VELAZ': { id: 6918, river: 'BERMEJO', lat: -26.6606, lon: -58.6339 },
  'MISION LA PAZ': { id: 32025, river: 'PILCOMAYO', lat: -22.3775, lon: -62.5236 },
  'PUESTO JEREZ': { id: 9198, river: 'PILCOMAYO', lat: -22.7281, lon: -62.2133 },
  'VILLA GRAL GUEMES': { id: 33396, river: 'PILCOMAYO', lat: -24.7469, lon: -59.4997 },
  // series largas (red histórica "bdhi", 2001–2026 y 2019–2024): no tienen lectura diaria al día, sirven para ajustar la curva altura–caudal
  'EL COLORADO (SERIE LARGA)': { id: 6521, river: 'BERMEJO' },
  'SAUZALITO (SERIE LARGA)': { id: 29393, river: 'BERMEJO' },
};
// No existen en INA (sin escala en alturas_prefe): GUAYRA, YERUA, LA CALERA, PILAR.

const getJson = async (url, timeoutMs = 20000) => {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`INA: HTTP ${res.status} al pedir ${url}`);
  return res.json();
};

const pad = (n) => String(n).padStart(2, '0');
const AR_OFFSET_MS = 3 * 3600e3;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const round = (x, n = 2) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);
const finite = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** ISO UTC -> { date:'YYYY-MM-DD', time:'HH:MM'|null, ts } en hora argentina. 00:00 = dato diario sin hora. */
function arStamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - AR_OFFSET_MS);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { date, time: hm === '00:00' ? null : hm, ts: t };
}

/** Pide observaciones de varias series -> Map(series_id -> [{date,time,ts,h}] ascendente, una por día). */
async function fetchObs(ids, days) {
  const now = Date.now();
  const from = ymd(now - (days + 1) * 86400e3);
  const to = ymd(now + 86400e3);
  const raw = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      const rows = await getJson(`${BASE}/observaciones?series_id=${c.join(',')}&timestart=${from}&timeend=${to}`, 30000);
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const h = finite(r.valor);
        const st = arStamp(r.timestart);
        if (h == null || !st) continue;
        if (!raw.has(r.series_id)) raw.set(r.series_id, []);
        raw.get(r.series_id).push({ ...st, h });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  const out = new Map();
  for (const [id, arr] of raw) {
    arr.sort((a, b) => a.ts - b.ts);
    const byDay = new Map(); // último valor del día
    for (const o of arr) byDay.set(o.date, o);
    out.set(id, [...byDay.values()]);
  }
  return out;
}

/** Niveles de alerta/evacuación por estación (id -> {alert_m, evac_m}). Falla en silencio. */
async function fetchLevels() {
  try {
    const est = await getJson(`${BASE}/estaciones?tabla=alturas_prefe`);
    const m = new Map();
    for (const e of est) m.set(e.id, { alert_m: finite(e.nivel_alerta), evac_m: finite(e.nivel_evacuacion) });
    return m;
  } catch {
    return new Map();
  }
}

export async function fetchHeightsINA() {
  const entries = Object.entries(SERIES);
  const [obs, levels] = await Promise.all([fetchObs(entries.map(([, v]) => v.id), WINDOW_DAYS), fetchLevels()]);
  const stations = [];
  for (const [port, { id, river }] of entries) {
    const arr = obs.get(id);
    if (!arr || !arr.length) continue; // sin lecturas en la ventana (estación cortada)
    const last = arr[arr.length - 1];
    const prev = arr.length > 1 ? arr[arr.length - 2] : null;
    const var_m = prev ? round(last.h - prev.h) : null;
    const lv = levels.get(id) || {};
    stations.push({
      port,
      river,
      height_m: round(last.h),
      var_m,
      prev_m: prev ? round(prev.h) : null,
      date: last.date,
      time: last.time,
      alert_m: lv.alert_m ?? null,
      evac_m: lv.evac_m ?? null,
      state: var_m == null ? null : var_m > STATE_THRESHOLD_M ? 'CRECE' : var_m < -STATE_THRESHOLD_M ? 'BAJA' : 'ESTAC.',
    });
  }
  if (!stations.length) throw new Error('INA: sin observaciones recientes');
  return { fetchedAt: new Date().toISOString(), source: SOURCE, stations };
}

/** Alturas de las series extra (Bermejo y Pilcomayo): mismas lecturas que `fetchHeightsINA`, sin niveles de alerta. */
export async function fetchHeightsINAExtra() {
  const entries = Object.entries(EXTRA);
  const obs = await fetchObs(entries.map(([, v]) => v.id), WINDOW_DAYS);
  const stations = [];
  for (const [port, { id, river, lat, lon }] of entries) {
    const arr = obs.get(id);
    if (!arr || !arr.length) continue;
    const last = arr.at(-1), prev = arr.length > 1 ? arr.at(-2) : null;
    const var_m = prev ? round(last.h - prev.h) : null;
    stations.push({
      port, river, lat, lon, height_m: round(last.h), var_m, prev_m: prev ? round(prev.h) : null, date: last.date, time: last.time,
      alert_m: null, evac_m: null,
      state: var_m == null ? null : var_m > STATE_THRESHOLD_M ? 'CRECE' : var_m < -STATE_THRESHOLD_M ? 'BAJA' : 'ESTAC.',
    });
  }
  return stations;
}

/** Historia diaria de un puerto: [{date,height_m}] ascendente (último valor de cada día). */
export async function fetchHeightsINAHistory(port, days = 30) {
  const key = String(port).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const s = SERIES[key] || EXTRA[key];
  if (!s) throw new Error(`INA: puerto desconocido "${port}"`);
  const n = Math.max(1, Math.min(Number(days) || 30, 3650));
  const obs = await fetchObs([s.id], n);
  return (obs.get(s.id) || []).map((o) => ({ date: o.date, height_m: round(o.h) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await fetchHeightsINA();
  console.log(`${r.source} - ${r.stations.length} estaciones, ${r.fetchedAt}`);
  for (const s of r.stations) {
    console.log(
      [s.port.padEnd(22), s.river.padEnd(9), String(s.height_m).padStart(6), String(s.var_m ?? '-').padStart(6),
        (s.state ?? '-').padEnd(6), s.date, `${s.alert_m ?? '-'}/${s.evac_m ?? '-'}`].join(' '),
    );
  }
  const h = await fetchHeightsINAHistory('ROSARIO', 10);
  console.log('ROSARIO hist:', h.map((x) => `${x.date}=${x.height_m}`).join(' '));
}
