// Lluvia diaria sobre la cuenca, en una grilla de 0,5° (Open-Meteo, modelos de reanálisis para el pasado y de pronóstico
// para los próximos 16 días). Una sola consulta por vuelta, compartida por todos los usuarios.
//
// Open-Meteo gratuito: uso no comercial, CC BY 4.0, unas 10.000 llamadas por día y 600 por minuto; cada ubicación cuenta
// según los días pedidos, así que se piden pocas ubicaciones por vez y bien espaciadas.
import { pathToFileURL } from 'node:url';

export const SOURCE = 'Open-Meteo (CC BY 4.0): reanálisis y pronóstico de precipitación';
const API = 'https://api.open-meteo.com/v1/forecast';
const BOX = { lon0: -61.5, lon1: -53.5, lat0: -25, lat1: -34 }; // oeste, este, norte, sur
const STEP = 0.5;
const PAST_DAYS = 45, FORECAST_DAYS = 16;
const PER_REQUEST = 40, GAP_MS = 20e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chunk(lats, lons) {
  const url = `${API}?latitude=${lats.join(',')}&longitude=${lons.join(',')}&daily=precipitation_sum` +
    `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}&timezone=America%2FArgentina%2FBuenos_Aires`;
  for (let k = 0; ; k++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60e3) });
    if (res.ok) { const j = await res.json(); return Array.isArray(j) ? j : [j]; }
    if (k >= 4) throw new Error(`Open-Meteo: HTTP ${res.status}`);
    await sleep(res.status === 429 ? 65e3 : 5e3);
  }
}

/** { updated, lon0, lat0, step, nx, ny, days: ['YYYY-MM-DD'...], v: [día][fila*nx+col] en mm } (filas de norte a sur) */
export async function fetchPrecipGrid() {
  const nx = Math.round((BOX.lon1 - BOX.lon0) / STEP) + 1, ny = Math.round((BOX.lat0 - BOX.lat1) / STEP) + 1;
  const pts = [];
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) pts.push([+(BOX.lat0 - r * STEP).toFixed(2), +(BOX.lon0 + c * STEP).toFixed(2)]);
  let days = null; const cols = [];
  for (let i = 0; i < pts.length; i += PER_REQUEST) {
    const part = pts.slice(i, i + PER_REQUEST);
    const out = await chunk(part.map((p) => p[0]), part.map((p) => p[1]));
    for (const o of out) {
      days ??= o.daily.time;
      cols.push(o.daily.precipitation_sum);
    }
    if (i + PER_REQUEST < pts.length) await sleep(GAP_MS);
  }
  if (cols.length !== pts.length) throw new Error('Open-Meteo: faltan ubicaciones');
  const v = days.map((_, d) => cols.map((c) => (c[d] == null ? null : Math.round(c[d] * 10) / 10)));
  return { updated: new Date().toISOString(), source: SOURCE, lon0: BOX.lon0, lat0: BOX.lat0, step: STEP, nx, ny, days, v };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const g = await fetchPrecipGrid();
  console.log(g.nx, 'x', g.ny, 'puntos,', g.days.length, 'días', g.days[0], '→', g.days.at(-1));
}
