// Agrega a public/geo.json las trazas de los afluentes del NEA: Paraguay, Bermejo y Pilcomayo, con su km desde el
// nacimiento (para ubicar barrios y servicios sobre cada río) y los puntos de caudal.
//   node scripts/add-tribs-geo.mjs
//
// Las trazas salen del mismo Natural Earth de scripts/build-geo.mjs: el Bermejo y el Pilcomayo ya estaban en la lista
// de ríos de fondo; acá se pasan a primer plano (se sacan de la red de fondo para no dibujarlos dos veces).
// Si se regenera geo.json con build-geo.mjs, volver a correr este script.
import { readFile, writeFile } from 'node:fs/promises';
import { root } from './lib/rio.mjs';

const geoFile = root('public/geo.json');
const geo = JSON.parse(await readFile(geoFile, 'utf8'));
const st = JSON.parse(await readFile(root('stations.json'), 'utf8'));

const rad = Math.PI / 180, R = 6371;
const dkm = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad), b[1] - a[1]) * rad * R;
const kmAlong = (c) => { let k = 0; return c.map((p, i) => { if (i) k += dkm(c[i - 1], p); return Math.round(k); }); };
const nearest = (c, km, lon, lat) => { let b = 0, bd = Infinity; c.forEach((p, i) => { const d = dkm(p, [lon, lat]); if (d < bd) { bd = d; b = i; } }); return { km: km[b], d: bd }; };

// ríos de fondo con ese nombre: se toma el más largo
const pick = (name) => geo.rivers.filter((r) => r.n === name).sort((a, b) => b.c.length - a.c.length)[0];
const bermejo = pick('Bermejo') ?? (geo.tribs?.bermejo && { c: geo.tribs.bermejo.c });
const pilcomayo = pick('Pilcomayo') ?? (geo.tribs?.pilcomayo && { c: geo.tribs.pilcomayo.c });
if (!bermejo || !pilcomayo) throw new Error('no encontré el Bermejo o el Pilcomayo en geo.json');
const paraguay = geo.paraguay.filter((l) => l.length > 1).sort((a, b) => b.length - a.length)[0];

const stById = Object.fromEntries([...st.tributaries, ...st.main].map((s) => [s.id, s]));
const tribs = {};
for (const [id, c] of [['paraguay', paraguay], ['bermejo', bermejo.c], ['pilcomayo', pilcomayo.c]]) {
  const km = kmAlong(c), s = stById[id];
  tribs[id] = { c, km, ...(s ? { stationKm: nearest(c, km, s.lon, s.lat).km } : {}) };
}
geo.tribs = tribs;
// las trazas de primer plano ya no se repiten en la red de fondo
geo.rivers = geo.rivers.filter((r) => r.n !== 'Bermejo' && r.n !== 'Pilcomayo');
geo.bermejo = [tribs.bermejo.c];
geo.pilcomayo = [tribs.pilcomayo.c];
for (const id of ['paraguay', 'bermejo']) if (tribs[id].stationKm != null) geo.stationKm[id] = tribs[id].stationKm;
// Paraguay: se estima con la altura medida por Prefectura en dos escalas (sin caudal modelado ni pronóstico)
for (const [id, lon, lat] of [['paraguay_formosa', -58.1833, -26.1833], ['paraguay_clorinda', -57.65, -25.3667]]) geo.stationKm[id] = nearest(tribs.paraguay.c, tribs.paraguay.km, lon, lat).km;
await writeFile(geoFile, JSON.stringify(geo));
for (const [id, t] of Object.entries(tribs)) console.log(id.padEnd(10), t.c.length, 'puntos,', t.km.at(-1), 'km', t.stationKm != null ? `· punto de caudal en el km ${t.stationKm}` : '');
