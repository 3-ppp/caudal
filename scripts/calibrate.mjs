// Ajusta cada punto de stations.json a la celda GloFAS del cauce principal:
// busca en una grilla alrededor del punto nominal la celda con mayor caudal medio.
// Uso: node scripts/calibrate.mjs   → escribe data/stations.calibrated.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const STEP = 0.05;

const cfg = JSON.parse(await readFile(new URL('stations.json', ROOT), 'utf8'));

async function candidates(st) {
  const n = Math.round(st.r / STEP);
  const lats = [], lons = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    lats.push((st.lat + i * STEP).toFixed(3));
    lons.push((st.lon + j * STEP).toFixed(3));
  }
  const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${lats}&longitude=${lons}` +
    `&daily=river_discharge&past_days=60&forecast_days=1`;
  let res = await fetch(url);
  while (res.status === 429) { // límite por minuto de Open-Meteo
    console.log('  (límite de la API, espero 65 s)');
    await new Promise((r) => setTimeout(r, 65e3));
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`${st.id}: HTTP ${res.status} ${await res.text()}`);
  let data = await res.json();
  if (!Array.isArray(data)) data = [data];
  const seen = new Map();
  for (const d of data) {
    const key = `${d.latitude.toFixed(3)},${d.longitude.toFixed(3)}`;
    if (seen.has(key)) continue;
    const v = d.daily.river_discharge.filter((x) => x != null);
    const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    seen.set(key, { lat: +d.latitude.toFixed(3), lon: +d.longitude.toFixed(3), mean });
  }
  return [...seen.values()].sort((a, b) => b.mean - a.mean);
}

// Los puntos ya calibrados que no cambiaron en stations.json se reusan
let prev = {};
try { prev = JSON.parse(await readFile(new URL('data/stations.calibrated.json', ROOT), 'utf8')); } catch {}
const prevById = Object.fromEntries(Object.values(prev).flat().map((s) => [s.id, s]));
const out = { main: [], tributaries: [], uruguay: [] };
for (const group of ['main', 'tributaries', 'uruguay']) {
  for (const st of cfg[group]) {
    const p = prevById[st.id];
    if (p && p.lat === st.lat && p.lon === st.lon && p.r === st.r) { out[group].push({ ...st, glat: p.glat, glon: p.glon }); continue; }
    const c = await candidates(st);
    const best = c[0];
    console.log(`${st.id.padEnd(12)} ${String(Math.round(best.mean)).padStart(6)} m³/s  @ ${best.lat},${best.lon}` +
      `   (2º: ${Math.round(c[1]?.mean ?? 0)})`);
    out[group].push({ ...st, glat: best.lat, glon: best.lon });
  }
}
await mkdir(new URL('data/', ROOT), { recursive: true });
await writeFile(new URL('data/stations.calibrated.json', ROOT), JSON.stringify(out, null, 2));
console.log('→ data/stations.calibrated.json');
