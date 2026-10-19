// Genera sources/rutas-nacionales.json: la traza de las rutas nacionales de la zona (IGN / Secretaría de Transporte,
// datos.gob.ar), agrupada por número de ruta y simplificada. El servidor la usa para ubicar sobre el mapa los
// tramos que Vialidad Nacional informa con corte o restricción (sources/vialidad.mjs).
//   node scripts/build-rutas-geo.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dp, root, rootPath } from './lib/rio.mjs';

const BBOX = '-62.5,-35.2,-46,-24';
const URL_N = `https://wms.ign.gob.ar/geoserver/transporte/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=transporte:vial_nacional&maxFeatures=20000&outputFormat=application/json&bbox=${BBOX},EPSG:4326`;

await mkdir(root('data/cache/'), { recursive: true });
const file = rootPath('data/cache/rutas-N.json');
if (!existsSync(file)) {
  console.log('descargando rutas nacionales (IGN)');
  const res = await fetch(URL_N);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}
const src = JSON.parse(await readFile(file, 'utf8'));
const rutas = {};
let nLines = 0;
for (const f of src.features) {
  const id = String(f.properties.designacion_de_red_vial || '').trim().toUpperCase();
  if (!id) continue;
  const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
  for (const l of lines) {
    const pts = dp(l.map((q) => [+q[0].toFixed(5), +q[1].toFixed(5)]), 1.5e-5);
    if (pts.length < 2) continue;
    (rutas[id] ||= []).push(pts.flat());
    nLines++;
  }
}
const doc = { fuente: 'Red vial · IGN y Secretaría de Transporte (rutas nacionales) · datos.gob.ar', generado: new Date().toISOString().slice(0, 10), rutas };
await writeFile(root('sources/rutas-nacionales.json'), JSON.stringify(doc));
console.log(`sources/rutas-nacionales.json: ${Object.keys(rutas).length} rutas, ${nLines} líneas, ${(Buffer.byteLength(JSON.stringify(doc)) / 1024).toFixed(0)} KB`);
