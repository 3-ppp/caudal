// Genera los cauces menores del mapa: afluentes del Paraná y el Uruguay (Mesopotamia, Chaco y Santa Fe) con boyas
// hidrométricas del INA (red de telemetría "sat2").
//   node scripts/build-cauces.mjs [id,id,...]    (sin argumentos: todos)
//
// Salidas:
//   public/cauces.json            traza de cada río (de OpenStreetMap) con su km y sus puntos de medición
//   sources/gauges-extra.json     las series del INA que el servidor consulta (puerto, río, ubicación)
//   (la altura mediana de cada punto, de la que sale la subida del río, la calcula scripts/build-ratings.mjs)
//
// Estos ríos no tienen pronóstico: el modelo de caudal (GloFAS) no los sigue (humedales, cauces chicos) y el INA no los
// pronostica. La estimación sobre barrios solo vale para los días con medición. Ver README.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { root, rootPath, dist, dp } from './lib/rio.mjs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const INA = 'https://alerta.ina.gob.ar/a5/obs/puntual';
const CACHE = rootPath('data/cache/osm-rios.json');

// id, nombre, nombres en OpenStreetMap, caja [sur, oeste, norte, este], series del INA [id de serie, lugar]
const CAUCES = [
  { id: 'corriente', name: 'Río Corriente', osm: 'Río Corriente|Rio Corriente|Río Corrientes', bb: [-30.6, -60, -27, -56.5], gauges: [[9021, 'Paso Lucero'], [6756, 'Los Laureles']] },
  { id: 'santalucia', name: 'Río Santa Lucía', osm: 'Río Santa Lucía|Rio Santa Lucia', bb: [-30, -59.8, -27.5, -57.5], gauges: [[9108, 'Santa Lucía']] },
  { id: 'mirinay', name: 'Río Miriñay', osm: 'Río Miriñay|Rio Miriñay|Río Mirinay', bb: [-30.5, -58, -28, -56.5], gauges: [[9542, 'Paso Mesa'], [6897, 'Paso Ledesma']] },
  { id: 'batel', name: 'Arroyo Batel', osm: 'Arroyo Batel|Arroyo Batelito|Río Batel', bb: [-29.5, -59.2, -28.2, -58], gauges: [[6806, 'Paso Cerrito']] },
  { id: 'aguapey', name: 'Río Aguapey', osm: 'Río Aguapey|Arroyo Aguapey', bb: [-28.6, -57, -27.4, -55.8], gauges: [[9018, 'La Sirena']] },
  { id: 'mocoreta', name: 'Río Mocoretá', osm: 'Río Mocoretá|Arroyo Mocoretá|Río Mocoreta', bb: [-30.9, -58.4, -29.6, -57.5], gauges: [[33259, 'RN 127']] },
  { id: 'gualeguay', name: 'Río Gualeguay', osm: 'Río Gualeguay', bb: [-34, -60, -30.2, -58.2], gauges: [[6833, 'Villaguay'], [6706, 'Rosario del Tala'], [9550, 'Paso Alonso']] },
  { id: 'nogoya', name: 'Arroyo Nogoyá', osm: 'Arroyo Nogoyá|Río Nogoyá|Río Nogoya', bb: [-33, -60.3, -31.7, -58.9], gauges: [[9412, 'RN 12']] },
  { id: 'feliciano', name: 'Arroyo Feliciano', osm: 'Arroyo Feliciano|Río Feliciano', bb: [-31.6, -59.8, -30, -58.2], gauges: [[6807, 'Paso Medina']] },
  { id: 'guayquiraro', name: 'Río Guayquiraró', osm: 'Río Guayquiraró|Arroyo Guayquiraró', bb: [-30.9, -59.9, -29.5, -58.6], gauges: [[34086, 'Curupí']] },
  { id: 'riachuelo', name: 'Riachuelo (Corrientes)', osm: 'Riachuelo|Arroyo Riachuelo|Río Riachuelo', bb: [-27.9, -58.9, -27.3, -58.1], gauges: [[9551, 'RP 5']] },
  { id: 'negro', name: 'Río Negro (Chaco)', osm: 'Río Negro', bb: [-27.8, -59.7, -26.5, -58.7], gauges: [[32633, 'Obra de control']] },
  { id: 'pirayguazu', name: 'Arroyo Piray Guazú', osm: 'Arroyo Piray Guazú|Río Piray Guazú|Piray Guazú', bb: [-27.1, -55.1, -26, -54.1], gauges: [[32261, 'RN 12']] },
  { id: 'piraymini', name: 'Arroyo Piray Miní', osm: 'Arroyo Piray Miní|Río Piray Miní|Piray Miní', bb: [-27.1, -55.1, -26, -54.1], gauges: [[32868, 'Valle Hermoso']] },
  { id: 'colastine', name: 'Río Colastiné', osm: 'Río Colastiné|Colastiné|Rio Colastine', bb: [-32.3, -60.9, -31.3, -60.2], gauges: [[8313, 'RN 168'], [6856, 'Autopista']] },
  { id: 'leyes', name: 'Arroyo Leyes', osm: 'Arroyo Leyes', bb: [-31.9, -60.8, -31.3, -60.3], gauges: [[9199, 'RP 1']] },
  { id: 'coronda', name: 'Río Coronda', osm: 'Río Coronda|Rio Coronda', bb: [-32.4, -61, -31.7, -60.5], gauges: [[6755, 'Coronda']] },
  { id: 'malabrigo', name: 'Arroyo Malabrigo', osm: 'Arroyo Malabrigo', bb: [-29.9, -60.3, -28.9, -59.5], gauges: [[34340, 'RN 11']] },
  { id: 'garzas', name: 'Arroyo Las Garzas', osm: 'Arroyo Las Garzas', bb: [-29.4, -60.2, -28.4, -59.2], gauges: [[32023, 'RN 11']] },
  { id: 'barrancas', name: 'Arroyo Barrancas', osm: 'Arroyo Barrancas', bb: [-30.6, -59.8, -29.8, -59], gauges: [[9200, 'Paso La Llana']] },
  // Comahue (Vaca Muerta): los ríos de la cuenca con las boyas del INA. Sus caudales los manejan las represas del Comahue (Alicurá,
  // Piedra del Águila, Pichi Picún Leufú, El Chocón, Arroyito, Mari Menuco), que el modelo no ve: solo cuenta la altura medida.
  { id: 'neuquen', name: 'Río Neuquén', osm: 'Río Neuquén|Rio Neuquen', bb: [-39.1, -70.6, -36.8, -67.9], gauges: [[32997, 'Chos Malal'], [6898, 'Paso de Indios'], [37043, 'Dique Ballester'], [34346, 'Neuquén']] },
  { id: 'limay', name: 'Río Limay', osm: 'Río Limay|Rio Limay', bb: [-39.6, -69.0, -38.85, -67.9], gauges: [[37038, 'Isla Jordán']] },
  { id: 'negropat', name: 'Río Negro (Patagonia)', osm: 'Río Negro|Rio Negro', bb: [-41.3, -68.2, -38.9, -62.5], gauges: [[37038, 'Isla Jordán'], [37040, 'Paso Córdova'], [33760, 'Primera Angostura']] },
  { id: 'colorado', name: 'Río Colorado', osm: 'Río Colorado|Rio Colorado', bb: [-39.8, -69.9, -36.8, -62.0], gauges: [[34010, 'Pata Mora'], [32291, 'Puesto Hernández'], [6874, 'Pichi Mahuida'], [32666, 'Paso Alsina'], [33091, 'Pedro Luro']] },
];

const ONLY = process.argv[2] ? process.argv[2].split(',') : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

// ---- trazas de OpenStreetMap (con caché: Overpass tiene límites y responde lento)
const osm = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {};
async function fetchOsm(c) {
  const q = `[out:json][timeout:90];(way["waterway"~"river|stream|canal"]["name"~"^(${c.osm})$"](${c.bb.join(',')}););out geom;`;
  for (let k = 0; k < 5; k++) {
    try {
      const r = await fetch(OVERPASS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'caudal-puaj/1.0' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(100e3) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.elements.map((e) => ({ n: e.tags.name, w: e.tags.waterway, c: e.geometry.map((p) => [+p.lon.toFixed(5), +p.lat.toFixed(5)]) }));
    } catch (e) { console.log(`  ${c.id}: ${e.message}, reintento`); await sleep(15e3); }
  }
  throw new Error(`${c.id}: Overpass no respondió`);
}

// ---- cadena principal: de las vías de OSM se arma el camino más largo (los ríos vienen en tramos que comparten nodos)
const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
function mainChain(ways) {
  const adj = new Map(), pos = new Map();
  const edge = (a, b, fwd) => {
    const ka = key(a), kb = key(b);
    pos.set(ka, a); pos.set(kb, b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    const d = dist(a, b);
    adj.get(ka).push({ to: kb, d, fwd });
    adj.get(kb).push({ to: ka, d, fwd: -fwd }); // fwd = +1 si la arista se recorre en el sentido en que OSM dibujó la vía
  };
  for (const w of ways) for (let i = 0; i < w.c.length - 1; i++) edge(w.c[i], w.c[i + 1], 1);
  // componentes: se toma la más larga (suma de aristas)
  const seen = new Set(); let best = null;
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = [], stack = [start]; seen.add(start);
    let len = 0;
    while (stack.length) { const u = stack.pop(); comp.push(u); for (const e of adj.get(u)) { len += e.d / 2; if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); } } }
    if (!best || len > best.len) best = { nodes: comp, len };
  }
  // camino más largo en un árbol (doble barrido); con ciclos (brazos) es una aproximación
  const sweep = (s) => {
    const D = new Map([[s, 0]]), prev = new Map(), q = [s];
    while (q.length) { const u = q.shift(); for (const e of adj.get(u)) if (!D.has(e.to)) { D.set(e.to, D.get(u) + e.d); prev.set(e.to, { u, fwd: -e.fwd }); q.push(e.to); } }
    let far = s; for (const [k, v] of D) if (v > D.get(far)) far = k;
    return { far, prev, len: D.get(far) };
  };
  const a = sweep(best.nodes[0]).far, { far: b, prev } = sweep(a);
  const path = [b]; let votes = 0;
  for (let k = b; k !== a;) { const p = prev.get(k); votes += p.fwd; path.push(p.u); k = p.u; }
  // `path` va de b a a; se orienta de aguas arriba a aguas abajo según el sentido de dibujo de OSM (se dibujan río abajo)
  // votes > 0: recorrer a→b coincide con el dibujo; el camino armado va de b a a, así que se invierte si votes > 0
  const pts = path.map((k) => pos.get(k));
  return votes > 0 ? pts.reverse() : pts;
}

// ---- series del INA: ubicación de cada estación
const sat = await (await fetch(`${INA}/series?var_id=2&proc_id=1&tabla=sat2`, { signal: AbortSignal.timeout(90e3) })).json();
const bySeries = new Map((Array.isArray(sat) ? sat : sat.rows).map((s) => [s.id, s]));

const out = [], extra = {};
await mkdir(root('data/cache/'), { recursive: true });
for (const c of CAUCES) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  if (!osm[c.id]?.length) { osm[c.id] = await fetchOsm(c); await writeFile(CACHE, JSON.stringify(osm)); await sleep(3e3); }
  if (!osm[c.id].length) { console.log(c.id.padEnd(12), 'sin trazas en OpenStreetMap'); continue; }
  const chain = mainChain(osm[c.id]);
  const line = dp(chain, 4e-4);
  const km = []; let k = 0;
  line.forEach((p, i) => { if (i) k += dist(line[i - 1], p); km.push(Math.round(k * 10) / 10); });
  const gauges = [];
  for (const [sid, place] of c.gauges) {
    const s = bySeries.get(sid);
    if (!s) { console.log(`  ${c.id}: la serie ${sid} no existe`); continue; }
    const [lon, lat] = s.estacion.geom.coordinates;
    // punto de la traza más cercano a la estación
    let bi = 0, bd = Infinity;
    line.forEach((p, i) => { const d = dist(p, [lon, lat]); if (d < bd) { bd = d; bi = i; } });
    const river = norm(c.name.replace(/^(Río|Arroyo)\s+/i, '').replace(/\s*\(.*\)/, ''));
    const port = `${river} - ${norm(place)}`;
    const gid = `g${s.estacion.id}`;
    gauges.push({ id: gid, port, river, place, km: km[bi], off: +bd.toFixed(1), lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    extra[port] = { id: sid, river, lat: +lat.toFixed(4), lon: +lon.toFixed(4), grp: 'cauce' };
    console.log(`  ${gid} ${port}: a ${bd.toFixed(1)} km de la traza, km ${km[bi]}`);
  }
  out.push({ id: c.id, name: c.name, c: line.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]), km, len: Math.round(k), gauges });
  console.log(c.id.padEnd(12), `${osm[c.id].length} vías → cadena de ${line.length} puntos, ${Math.round(k)} km, ${gauges.length} puntos de medición`);
}
if (!ONLY) await writeFile(root('public/cauces.json'), JSON.stringify({ fuente: 'Trazas: © colaboradores de OpenStreetMap (ODbL). Alturas: INA, red de telemetría.', generado: new Date().toISOString().slice(0, 10), cauces: out }));
else {
  let prev = { cauces: [] };
  try { prev = JSON.parse(await readFile(root('public/cauces.json'), 'utf8')); } catch {}
  const m = new Map(prev.cauces.map((c) => [c.id, c]));
  for (const c of out) m.set(c.id, c);
  await writeFile(root('public/cauces.json'), JSON.stringify({ ...prev, generado: new Date().toISOString().slice(0, 10), cauces: [...m.values()] }));
}
// series para el servidor (se unen a las que ya estaban)
let ex = {};
try { ex = JSON.parse(await readFile(root('sources/gauges-extra.json'), 'utf8')); } catch {}
await writeFile(root('sources/gauges-extra.json'), JSON.stringify({ ...ex, ...extra }, null, 1));
console.log('public/cauces.json:', out.length, 'cauces · sources/gauges-extra.json:', Object.keys({ ...ex, ...extra }).length, 'series');
