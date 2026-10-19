// Genera public/servicios.json: escuelas y centros de salud a menos de MAX_KM de los ríos Paraná y Uruguay,
// con su altura estimada sobre el río (a menos de KEEP_H m; los más altos no importan para una crecida).
//   node scripts/build-servicios.mjs
//
// Fuente: capas de puntos del IGN (WFS público, red de puntos de interés):
//   salud_020801                          · establecimientos de salud (fuente principal: SISA, Ministerio de Salud)
//   puntos_de_ciencia_y_educacion_020601  · establecimientos educativos (Mapa Educativo Nacional)
// Altura sobre el río = cota del terreno (SRTM 30 m vía OpenTopoData) − cota del río más cercano. Es una ESTIMACIÓN.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRio, root, rootPath } from './lib/rio.mjs';

const MAX_KM = 8, KEEP_H = 14;
const BBOX = '-62.5,-35.2,-46,-24';
const WFS = (layer) => `https://wms.ign.gob.ar/geoserver/ign/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ign:${layer}&maxFeatures=100000&outputFormat=application/json&bbox=${BBOX},EPSG:4326`;
const LAYERS = { s: ['salud_020801', 'establecimientos de salud'], e: ['puntos_de_ciencia_y_educacion_020601', 'establecimientos educativos'] };

await mkdir(root('data/cache/'), { recursive: true });
const { nearestRiver, stationFor, elevations, refAt } = await createRio();

const cand = [];
for (const [t, [layer, label]] of Object.entries(LAYERS)) {
  const file = rootPath(`data/cache/servicios-${t}.json`);
  if (!existsSync(file)) {
    console.log('descargando', label);
    const res = await fetch(WFS(layer));
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  const j = JSON.parse(await readFile(file, 'utf8'));
  let n = 0;
  for (const f of j.features) {
    if (f.geometry?.type !== 'Point') continue;
    const c = f.geometry.coordinates, near = nearestRiver(c);
    if (near.d > MAX_KM) continue;
    cand.push({ t, c, near, p: f.properties });
    n++;
  }
  console.log(`${label}: ${j.features.length} en la región, ${n} a menos de ${MAX_KM} km de un río`);
}

const el = await elevations(cand.map((x) => x.c));
const out = [];
cand.forEach((x, i) => {
  if (el[i] == null) return;
  const h = el[i] - refAt(x.near);
  if (h > KEEP_H) return;
  out.push({
    t: x.t, n: (x.p.fna || x.p.nam || '').trim(), g: (x.p.gna || '').trim(),
    c: [+x.c[0].toFixed(5), +x.c[1].toFixed(5)], h: +h.toFixed(1), st: stationFor(x.near).id,
    ...(h < -3 ? { x: 1 } : {}), // referencia de río mal tomada: no se estima
  });
});
out.sort((a, b) => a.h - b.h);
const doc = {
  fuente: 'Puntos de interés · IGN (salud: SISA / Ministerio de Salud; educación: Mapa Educativo Nacional)',
  elevacion: 'SRTM 30 m (NASA) vía OpenTopoData. Altura sobre el río estimada, con error de varios metros.',
  generado: new Date().toISOString().slice(0, 10), maxKm: MAX_KM, keepH: KEEP_H, items: out,
};
await writeFile(root('public/servicios.json'), JSON.stringify(doc));
const c = (t) => out.filter((x) => x.t === t).length;
console.log(`public/servicios.json: ${c('s')} de salud y ${c('e')} escuelas (${(Buffer.byteLength(JSON.stringify(doc)) / 1024).toFixed(0)} KB)`);
for (const m of [1, 3, 6]) console.log(`  a menos de ${m} m sobre el río: ${out.filter((x) => !x.x && x.h <= m).length}`);
