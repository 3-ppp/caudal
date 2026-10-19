// Lo que comparten los scripts que estiman exposición (barrios, rutas): la traza de los ríos con su km,
// la estación de caudal más cercana, las cotas del terreno (SRTM 30 m vía OpenTopoData, con caché en
// data/cache/) y la cota del río en cada punto.
//
// Altura sobre el río = cota del terreno − cota del río en el punto más cercano. Es una ESTIMACIÓN: el
// modelo ve techos y árboles, y el río se toma como el mínimo de los puntos vecinos de su traza.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const R = 6371, rad = Math.PI / 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const root = (p) => new URL(p, ROOT);
export const rootPath = (p) => fileURLToPath(new URL(p, ROOT));

// distancia en km (equirectangular local; sobra para unos km)
export function dist(a, b) {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad), y = b[1] - a[1];
  return Math.hypot(x, y) * rad * R;
}

// Douglas–Peucker en grados
export function dp(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = pts[a], [x2, y2] = pts[b], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-12;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export async function createRio() {
  const geo = JSON.parse(await readFile(root('public/geo.json'), 'utf8'));
  const st = JSON.parse(await readFile(root('stations.json'), 'utf8'));

  // ríos: vértices con su km desde el nacimiento. Además del Paraná y el Uruguay, los afluentes con punto de caudal
  // propio (Bermejo, Paraguay). Se descartan los últimos TRIB_MOUTH_KM de cada afluente: ahí el río es el Paraná y un
  // barrio de Corrientes o Resistencia no debe pasar a otro río por quedar cerca de la desembocadura.
  const TRIB_MOUTH_KM = 40;
  // tramo del afluente donde vale la curva altura–caudal de su estación: el Bermejo, desde Puerto Lavalle (km 730) hacia
  // abajo; aguas arriba (Embarcación, Orán, Aguas Blancas) es un río de piedemonte con crecidas torrenciales
  const TRIB_FROM_KM = { bermejo: 670 };
  const stems = { ...geo.stems };
  for (const id of ['paraguay', 'bermejo']) {
    const t = geo.tribs?.[id];
    if (!t) continue;
    const end = t.km.at(-1) - TRIB_MOUTH_KM, n = t.km.filter((k) => k <= end).length;
    const n0 = Math.max(0, t.km.findIndex((k) => k >= (TRIB_FROM_KM[id] ?? 0)));
    stems[id] = { c: t.c.slice(n0, n), km: t.km.slice(n0, n) };
  }
  const river = [];
  for (const [name, s] of Object.entries(stems)) s.c.forEach((c, i) => river.push({ river: name, c, km: s.km[i], i }));
  const stations = [
    ...st.main.map((s) => ({ id: s.id, river: 'parana', km: geo.stationKm[s.id] })),
    ...st.uruguay.map((s) => ({ id: s.id, river: 'uruguay', km: geo.stationKm[s.id] })),
    ...['bermejo', 'paraguay_formosa', 'paraguay_clorinda'].filter((id) => geo.stationKm[id] != null && stems[id.split('_')[0]])
      .map((id) => ({ id, river: id.split('_')[0], km: geo.stationKm[id] })),
  ].filter((s) => s.km != null);

  // punto más cercano de la poligonal (por segmentos, no solo por vértices)
  function nearestRiver(p) {
    let best = { d: Infinity };
    for (const name of Object.keys(stems)) {
      const L = stems[name].c, K = stems[name].km;
      for (let i = 0; i < L.length - 1; i++) {
        const [x0, y0] = L[i], [x1, y1] = L[i + 1];
        const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / l2));
        const q = [x0 + t * dx, y0 + t * dy], d = dist(p, q);
        if (d < best.d) best = { d, river: name, km: K[i] + t * (K[i + 1] - K[i]), seg: i };
      }
    }
    return best;
  }

  // estación de caudal del mismo río más cercana por km
  const stationFor = (near) => stations.filter((s) => s.river === near.river)
    .reduce((a, b) => (Math.abs(b.km - near.km) < Math.abs(a.km - near.km) ? b : a));

  // elevaciones (OpenTopoData, 100 puntos por pedido, caché en disco)
  const CACHE = rootPath('data/cache/elevaciones.json');
  const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {};
  const ck = (p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;
  async function fetchElevations(pts) {
    for (let i = 0; i < pts.length; i += 100) {
      const chunk = pts.slice(i, i + 100);
      const url = `https://api.opentopodata.org/v1/srtm30m?locations=${chunk.map((p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`).join('|')}`;
      for (let k = 0; ; k++) {
        const res = await fetch(url);
        if (res.ok) { const r = (await res.json()).results; chunk.forEach((p, j) => { cache[ck(p)] = r[j].elevation; }); await writeFile(CACHE, JSON.stringify(cache)); break; }
        if (k > 4) throw new Error(`elevación: HTTP ${res.status}`);
        await sleep(res.status === 429 ? 65e3 : 3e3);
      }
      await sleep(1200); // el servicio público admite 1 pedido por segundo
      process.stdout.write(`\relevaciones ${Math.min(i + 100, pts.length)}/${pts.length}`);
    }
    if (pts.length) console.log();
  }
  async function elevations(pts) {
    const need = [...new Set(pts.map(ck))].filter((k) => !(k in cache)).map((k) => k.split(',').reverse().map(Number));
    await fetchElevations(need);
    return pts.map((p) => cache[ck(p)] ?? null);
  }

  // río: cota en cada vértice; la del agua se toma como el mínimo en ±2 vértices (el DEM aplana el agua,
  // pero la poligonal de Natural Earth puede caer unos cientos de metros sobre la orilla)
  const rEl = await elevations(river.map((v) => v.c));
  river.forEach((v, k) => (v.e = rEl[k]));
  const byRiver = {};
  for (const name of Object.keys(stems)) {
    const vs = river.filter((v) => v.river === name);
    vs.forEach((v, k) => { v.ref = Math.min(...vs.slice(Math.max(0, k - 2), k + 3).map((w) => w.e)); });
    byRiver[name] = vs;
  }
  const refAt = (near) => {
    const vs = byRiver[near.river];
    const a = vs[near.seg], b = vs[Math.min(near.seg + 1, vs.length - 1)];
    const t = b.km > a.km ? (near.km - a.km) / (b.km - a.km) : 0;
    return a.ref + (b.ref - a.ref) * Math.max(0, Math.min(1, t));
  };

  return { dist, nearestRiver, stationFor, elevations, refAt };
}
