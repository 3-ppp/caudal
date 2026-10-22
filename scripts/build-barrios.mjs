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
import { createRio, dp, root, rootPath } from './lib/rio.mjs';

const SRC_URL = 'https://archivo.infraestructura.gob.ar/dataset/ssisu/20231205_info_publica.geojson';
const MAX_KM = 12;          // Paraná, Uruguay, Paraguay, Bermejo
const MAX_KM_CAUCE = 4;     // ríos menores (cauces.json): la crecida de un arroyo no llega lejos
const MAX_H_CAUCE = 10;     // y un barrio más de 10 m sobre un arroyo no se muestra

const { dist, nearestRiver, stationFor, elevations, refAt, cauces } = await createRio();

let srcPath = process.argv[2];
if (!srcPath) {
  srcPath = rootPath('data/cache/barrios-renabap.geojson');
  if (!existsSync(srcPath)) {
    await mkdir(root('data/cache/'), { recursive: true });
    console.log('descargando', SRC_URL);
    const res = await fetch(SRC_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(srcPath, Buffer.from(await res.arrayBuffer()));
  }
}
const src = JSON.parse(await readFile(srcPath, 'utf8'));
console.log('barrios en el registro:', src.features.length);

// ---- geometría auxiliar
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
// un anillo cerrado tiene el mismo primer y último punto: Douglas–Peucker lo colapsaría, así que se
// parte en el vértice más lejano del primero y se simplifica cada mitad
function simplifyRing(ring, tol) {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  if (pts.length < 5) return pts;
  let k = 0, far = -1;
  pts.forEach((p, i) => { const d = (p[0] - pts[0][0]) ** 2 + (p[1] - pts[0][1]) ** 2; if (d > far) { far = d; k = i; } });
  return [...dp(pts.slice(0, k + 1), tol), ...dp([...pts.slice(k), pts[0]], tol).slice(1, -1)];
}

// ---- preselección por distancia al río
const cand = [];
for (const f of src.features) {
  const rs = rings(f.geometry).sort((a, b) => b.length - a.length);
  const c = ringCentroid(rs[0]);
  // el curso más cercano: un río menor solo si está a menos de MAX_KM_CAUCE y más cerca que el río grande
  const nb = nearestRiver(c, 'main'), nc = cauces.length ? nearestRiver(c, 'cauce') : { d: Infinity };
  const near = nc.d <= MAX_KM_CAUCE && nc.d < nb.d ? nc : nb.d <= MAX_KM ? nb : null;
  if (near) cand.push({ f, rs, c, near });
}
console.log(`junto a un curso de agua:`, cand.length, `(${cand.filter((x) => x.near.river.startsWith('c:')).length} en ríos menores)`);

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
  if (near.river.startsWith('c:') && h > MAX_H_CAUCE) return;
  const p = f.properties;
  // estación de caudal del mismo río más cercana por km
  const s = stationFor(near);
  const poly = simplifyRing(rs[0].map((q) => [+q[0].toFixed(5), +q[1].toFixed(5)]), 2.5e-5);
  out.push({
    id: p.id_renabap, n: p.nombre_barrio, loc: p.localidad, dep: p.departamento, prov: p.provincia,
    fam: p.cantidad_familias_aproximada ?? null, viv: p.cantidad_viviendas_aproximadas ?? null,
    c: [+c[0].toFixed(5), +c[1].toFixed(5)], d: +near.d.toFixed(1), km: Math.round(near.km), r: near.river, st: s.id,
    h: +h.toFixed(1), p: poly, ...(h < (near.river.startsWith('c:') ? 0 : -3) ? { x: 1 } : {}),
  });
});
out.sort((a, b) => a.h - b.h);
console.log('con referencia dudosa (barrio bajo el río):', out.filter((b) => b.x).length);
const doc = {
  fuente: 'Registro Nacional de Barrios Populares (RENABAP) · Secretaría de Integración Socio Urbana · datos.gob.ar · CC BY 4.0',
  elevacion: 'SRTM 30 m (NASA) vía OpenTopoData. Altura sobre el río estimada, con error de varios metros.',
  generado: new Date().toISOString().slice(0, 10),
  maxKm: MAX_KM, maxKmCauce: MAX_KM_CAUCE,
  barrios: out,
};
const file = root('public/barrios.json');
await writeFile(file, JSON.stringify(doc));
const kb = Buffer.byteLength(JSON.stringify(doc)) / 1024;
console.log(`public/barrios.json: ${out.length} barrios, ${kb.toFixed(0)} KB`);
const hs = out.map((b) => b.h);
console.log('altura sobre el río (m) · p10/p50/p90:', [0.1, 0.5, 0.9].map((q) => hs[Math.floor(q * (hs.length - 1))]).join(' / '));
