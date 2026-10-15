// Genera public/geo.json a partir de Natural Earth 10m (ríos, lagos, costa).
// Solo agua: no se dibujan límites políticos.
// Uso: node scripts/build-geo.mjs <carpeta-con-geojson-de-natural-earth>
//   (ne_10m_rivers_lake_centerlines.geojson, ne_10m_lakes.geojson, ne_10m_coastline.geojson)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NE = process.argv[2];
if (!NE) { console.error('falta la carpeta de Natural Earth'); process.exit(1); }
const ROOT = new URL('..', import.meta.url);
const BOX = { w: -66, e: -43, s: -36.5, n: -15 };
const CONFLUENCIA_PY = -27.29; // latitud del encuentro Paraguay–Paraná

const load = async (f) => JSON.parse(await readFile(path.join(NE, f + '.geojson'), 'utf8'));
const lines = (g) => g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
const inBox = ([x, y]) => x > BOX.w && x < BOX.e && y > BOX.s && y < BOX.n;
const r3 = (p) => [+p[0].toFixed(3), +p[1].toFixed(3)];

function hav([lon1, lat1], [lon2, lat2]) {
  const R = 6371, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Douglas–Peucker en grados (suficiente para escala de cuenca)
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [x1, y1] = pts[a], [x2, y2] = pts[b];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Recorta una línea a los tramos dentro de la caja
function clip(line, pred = inBox) {
  const out = []; let cur = [];
  for (const p of line) { if (pred(p)) cur.push(p); else if (cur.length) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out.filter((l) => l.length > 1);
}

const rivers = await load('ne_10m_rivers_lake_centerlines');
const lakes = await load('ne_10m_lakes');
const coast = await load('ne_10m_coastline');

// ---- Paraná: cauce principal y Paraguay
const paranaPieces = [], uruguayPieces = [], paraguay = [], network = [];
for (const f of rivers.features) {
  const name = f.properties.name;
  for (const l of lines(f.geometry)) {
    if (name === 'Paraná' && f.properties.scalerank === 2) {
      // Natural Earth une Paraguay + Paraná bajo un mismo nombre: el tramo que nace
      // al norte de la confluencia es el río Paraguay
      if (l[0][1] > CONFLUENCIA_PY) paraguay.push(...clip(l));
      else paranaPieces.push(l);
    } else if (name === 'Paraná') {
      paranaPieces.push(l);
    } else if (name === 'Uruguay') {
      uruguayPieces.push(l);
    } else {
      for (const c of clip(l)) network.push({ name, rank: f.properties.scalerank, c });
    }
  }
}

// Encadena los tramos de un río desde su nacimiento hacia la desembocadura y ubica sus puntos (km)
const cal = JSON.parse(await readFile(new URL('data/stations.calibrated.json', ROOT), 'utf8'));
function buildStem(name, pieces, start, stations, tail = []) {
  let pool = pieces.map((l) => l.slice());
  let chain = [];
  // Siguiente tramo: el extremo más cercano, descartando brazos que vuelven a un punto ya
  // recorrido (islas del Delta, brazos laterales); ante empates (< 5 km) gana el que más
  // se aleja del nacimiento.
  const visited = (p) => chain.some((q) => hav(p, q) < 5);
  const nearestEnd = (pt, forwardOnly = false) => {
    const cand = [];
    pool.forEach((l, i) => {
      for (const rev of forwardOnly ? [false] : [false, true]) {
        const end = rev ? l[0] : l.at(-1);
        if (visited(end)) continue;
        const d = hav(pt, rev ? l.at(-1) : l[0]);
        cand.push({ i, rev, d, far: hav(start, end) });
      }
    });
    if (!cand.length) return null;
    const dmin = Math.min(...cand.map((c) => c.d));
    return cand.filter((c) => c.d < dmin + 5).sort((a, b) => b.far - a.far)[0];
  };
  let b = nearestEnd(start, true); // el primer tramo se toma en sentido de la corriente
  while (b && (chain.length === 0 || b.d < 40)) {
    const l = pool.splice(b.i, 1)[0];
    const seg = b.rev ? l.reverse() : l;
    chain.push(...(chain.length ? seg.slice(1) : seg));
    b = pool.length ? nearestEnd(chain.at(-1)) : null;
  }
  // Recorta lo que esté aguas arriba del nacimiento
  let i0 = 0, dmin = Infinity;
  chain.forEach((p, i) => { const d = hav(p, start); if (d < dmin) { dmin = d; i0 = i; } });
  chain = chain.slice(i0).concat(tail);

  const c = simplify(chain, 0.004).map(r3);
  const km = [0];
  for (let i = 1; i < c.length; i++) km.push(km[i - 1] + hav(c[i - 1], c[i]));
  const stationKm = {};
  for (const st of stations) {
    let best = { d: Infinity, i: 0 };
    c.forEach((p, i) => { const d = hav(p, [st.lon, st.lat]); if (d < best.d) best = { d, i }; });
    stationKm[st.id] = Math.round(km[best.i]);
    console.log(`${st.id.padEnd(12)} km ${String(stationKm[st.id]).padStart(5)}   (a ${Math.round(best.d)} km del trazo)`);
  }
  console.log(`${name}: ${Math.round(km.at(-1))} km, ${c.length} vértices, tramos sobrantes: ${pool.length}`);
  return { c, km: km.map((v) => Math.round(v)), stationKm };
}

// Paraná: desde la confluencia Paranaíba + Grande
const parana = buildStem('Paraná', paranaPieces, [cal.main[0].lon, cal.main[0].lat], cal.main);
// Uruguay: desde las nacientes del Pelotas. Natural Earth lo corta frente a Paysandú (aguas abajo lo
// trata como estuario): el último tramo se completa con rectas hasta Fray Bentos y Nueva Palmira.
const uyTail = cal.uruguay.filter((s) => s.lat < uruguayPieces[0].at(-1)[1]).map((s) => [s.lon, s.lat]);
const uruguay = buildStem('Uruguay', uruguayPieces, uruguayPieces[0][0], cal.uruguay, uyTail);
const stationKm = { ...parana.stationKm, ...uruguay.stationKm };

// ---- resto de la red, lagos y costa (simplificados)
const net = network
  .map((r) => ({ n: r.name, r: r.rank, c: simplify(r.c, 0.01).map(r3) }))
  .filter((r) => r.c.length > 1);
const py = paraguay.map((l) => simplify(l, 0.006).map(r3));
const lk = [];
for (const f of lakes.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    const ring = poly[0];
    if (!ring.some(inBox)) continue;
    lk.push({ n: f.properties.name, c: simplify(ring, 0.005).map(r3) });
  }
}
const cs = [];
for (const f of coast.features) for (const l of lines(f.geometry)) for (const c of clip(l)) cs.push(simplify(c, 0.01).map(r3));

const out = {
  source: 'Natural Earth 10m (dominio público)',
  box: BOX,
  mainstem: { c: parana.c, km: parana.km },
  stems: { parana: { c: parana.c, km: parana.km }, uruguay: { c: uruguay.c, km: uruguay.km } },
  stationKm,
  paraguay: py,
  rivers: net,
  lakes: lk,
  coast: cs,
};
await writeFile(new URL('public/geo.json', ROOT), JSON.stringify(out));
console.log('→ public/geo.json', (JSON.stringify(out).length / 1024).toFixed(0), 'KB');
