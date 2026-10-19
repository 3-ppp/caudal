// Genera public/barrios.json: barrios populares (RENABAP) a menos de MAX_KM de los ríos Paraná y Uruguay,
// con su altura estimada sobre el nivel del río.
//   node scripts/build-barrios.mjs [archivo.geojson]
// Si no se pasa un archivo, descarga el GeoJSON del Registro Nacional de Barrios Populares
// (datos.gob.ar, CC BY 4.0) a data/cache/.
//
// Altura sobre el río = cota del terreno del barrio − cota del río en el punto más cercano.
// Las cotas salen de SRTM (NASA, 30 m) vía OpenTopoData. Es una
// ESTIMACIÓN: el modelo ve techos y árboles, y el río se toma como el mínimo de los puntos vecinos.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const SRC_URL = 'https://archivo.infraestructura.gob.ar/dataset/ssisu/20231205_info_publica.geojson';
const MAX_KM = 12;
const R = 6371;

const geo = JSON.parse(await readFile(new URL('public/geo.json', ROOT), 'utf8'));
const st = JSON.parse(await readFile(new URL('stations.json', ROOT), 'utf8'));

let srcPath = process.argv[2];
if (!srcPath) {
  srcPath = fileURLToPath(new URL('data/cache/barrios-renabap.geojson', ROOT));
  if (!existsSync(srcPath)) {
    await mkdir(new URL('data/cache/', ROOT), { recursive: true });
    console.log('descargando', SRC_URL);
    const res = await fetch(SRC_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(srcPath, Buffer.from(await res.arrayBuffer()));
  }
}
const src = JSON.parse(await readFile(srcPath, 'utf8'));
console.log('barrios en el registro:', src.features.length);

// ---- geometría auxiliar (equirectangular local; sobra para distancias de unos km)
const rad = Math.PI / 180;
function dist(a, b) {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad), y = b[1] - a[1];
  return Math.hypot(x, y) * rad * R;
}
const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((p) => p[0]);
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1], f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-18) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}
function dp(pts, tol) { // Douglas–Peucker en grados
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

// un anillo cerrado tiene el mismo primer y último punto: Douglas–Peucker lo colapsaría, así que se
// parte en el vértice más lejano del primero y se simplifica cada mitad
function simplifyRing(ring, tol) {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  if (pts.length < 5) return pts;
  let k = 0, far = -1;
  pts.forEach((p, i) => { const d = (p[0] - pts[0][0]) ** 2 + (p[1] - pts[0][1]) ** 2; if (d > far) { far = d; k = i; } });
  return [...dp(pts.slice(0, k + 1), tol), ...dp([...pts.slice(k), pts[0]], tol).slice(1, -1)];
}

// ---- ríos: vértices con su km desde el nacimiento
const river = [];
for (const [name, s] of Object.entries(geo.stems)) s.c.forEach((c, i) => river.push({ river: name, c, km: s.km[i], i }));
const stations = [
  ...st.main.map((s) => ({ id: s.id, river: 'parana', km: geo.stationKm[s.id] })),
  ...st.uruguay.map((s) => ({ id: s.id, river: 'uruguay', km: geo.stationKm[s.id] })),
].filter((s) => s.km != null);

// punto más cercano de la poligonal (por segmentos, no solo por vértices)
function nearestRiver(p) {
  let best = { d: Infinity };
  for (const name of Object.keys(geo.stems)) {
    const L = geo.stems[name].c, K = geo.stems[name].km;
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

// ---- preselección por distancia al río
const cand = [];
for (const f of src.features) {
  const rs = rings(f.geometry).sort((a, b) => b.length - a.length);
  const c = ringCentroid(rs[0]);
  const near = nearestRiver(c);
  if (near.d <= MAX_KM) cand.push({ f, rs, c, near });
}
console.log(`a menos de ${MAX_KM} km de un río:`, cand.length);

// ---- elevaciones (OpenTopoData, 100 puntos por pedido)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CACHE = fileURLToPath(new URL('data/cache/elevaciones.json', ROOT));
const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {};
const ck = (p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;
async function elevations(pts) {
  const need = [...new Set(pts.map(ck))].filter((k) => !(k in cache)).map((k) => k.split(',').reverse().map(Number));
  await fetchElevations(need);
  return pts.map((p) => cache[ck(p)] ?? null);
}
async function fetchElevations(pts) {
  const out = [];
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
  console.log();
}

// río: cota en cada vértice; la del agua se toma como el mínimo en ±2 vértices (el DEM aplana el agua,
// pero la poligonal de Natural Earth puede caer unos cientos de metros sobre la orilla)
const rEl = await elevations(river.map((v) => v.c));
river.forEach((v, k) => (v.e = rEl[k]));
for (const name of Object.keys(geo.stems)) {
  const vs = river.filter((v) => v.river === name);
  vs.forEach((v, k) => { v.ref = Math.min(...vs.slice(Math.max(0, k - 2), k + 3).map((w) => w.e)); });
}
const refAt = (near) => {
  const vs = river.filter((v) => v.river === near.river);
  const a = vs[near.seg], b = vs[Math.min(near.seg + 1, vs.length - 1)];
  const t = b.km > a.km ? (near.km - a.km) / (b.km - a.km) : 0;
  return a.ref + (b.ref - a.ref) * Math.max(0, Math.min(1, t));
};

// barrios: centroide + hasta 4 vértices repartidos del contorno principal
const samples = cand.map(({ rs, c }) => {
  const r = rs[0], n = r.length - 1, pts = [c];
  for (let k = 0; k < 4 && n >= 4; k++) pts.push(r[Math.floor((k * n) / 4)]);
  return pts;
});
const flat = samples.flat();
const bEl = await elevations(flat);
let o = 0;
const out = [];
cand.forEach(({ f, rs, c, near }, i) => {
  const els = bEl.slice(o, o + samples[i].length).filter((e) => e != null).sort((a, b) => a - b);
  o += samples[i].length;
  if (!els.length) return;
  const e = els.length > 2 ? els[1] : els[0]; // segunda más baja: el punto bajo, sin dejarse engañar por un pixel suelto
  const h = e - refAt(near); // sin recortar: un valor muy negativo delata una referencia de río mal tomada
  const p = f.properties;
  // estación de caudal del mismo río más cercana por km
  const sts = stations.filter((s) => s.river === near.river);
  const s = sts.reduce((a, b) => (Math.abs(b.km - near.km) < Math.abs(a.km - near.km) ? b : a));
  const poly = simplifyRing(rs[0].map((q) => [+q[0].toFixed(5), +q[1].toFixed(5)]), 2.5e-5);
  out.push({
    id: p.id_renabap, n: p.nombre_barrio, loc: p.localidad, dep: p.departamento, prov: p.provincia,
    fam: p.cantidad_familias_aproximada ?? null, viv: p.cantidad_viviendas_aproximadas ?? null,
    c: [+c[0].toFixed(5), +c[1].toFixed(5)], d: +near.d.toFixed(1), km: Math.round(near.km), r: near.river, st: s.id,
    h: +h.toFixed(1), p: poly, ...(h < -3 ? { x: 1 } : {}),
  });
});
out.sort((a, b) => a.h - b.h);
console.log('con referencia dudosa (barrio >3 m bajo el río):', out.filter((b) => b.x).length);
const doc = {
  fuente: 'Registro Nacional de Barrios Populares (RENABAP) · Secretaría de Integración Socio Urbana · datos.gob.ar · CC BY 4.0',
  elevacion: 'SRTM 30 m (NASA) vía OpenTopoData. Altura sobre el río estimada, con error de varios metros.',
  generado: new Date().toISOString().slice(0, 10),
  maxKm: MAX_KM,
  barrios: out,
};
const file = new URL('public/barrios.json', ROOT);
await writeFile(file, JSON.stringify(doc));
const kb = Buffer.byteLength(JSON.stringify(doc)) / 1024;
console.log(`public/barrios.json: ${out.length} barrios, ${kb.toFixed(0)} KB`);
const hs = out.map((b) => b.h);
console.log('altura sobre el río (m) · p10/p50/p90:', [0.1, 0.5, 0.9].map((q) => hs[Math.floor(q * (hs.length - 1))]).join(' / '));
