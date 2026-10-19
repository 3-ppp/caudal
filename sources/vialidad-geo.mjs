// Ubica sobre el mapa un tramo que Vialidad Nacional informa por localidades ("Santa Ana - Eldorado").
//
// Cómo: la traza de la ruta sale de sources/rutas-nacionales.json (IGN, ver scripts/build-rutas-geo.mjs); cada
// extremo del tramo se ubica con la API pública Georef (datos.gob.ar, localidades) o, si es un empalme con otra
// ruta nacional ("Emp. RN 131"), en el cruce de las dos trazas; y el tramo es el camino más corto sobre la traza
// entre los dos extremos. Se controla contra los km que informa Vialidad: si no coinciden, no se dibuja.
//
// Es una UBICACIÓN APROXIMADA. Los límites provinciales ("Lte. Con Corrientes"), los empalmes con rutas provinciales
// y los puntos kilométricos no se ubican: esos tramos quedan solo en la lista.
import { readFile } from 'node:fs/promises';

const GEO_FILE = new URL('./rutas-nacionales.json', import.meta.url);
const GEOREF = 'https://apis.datos.gob.ar/georef/api';
const R = 6371, rad = Math.PI / 180;
const GAP_KM = 4;
const dkm = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad), b[1] - a[1]) * rad * R;

const why = (m) => { if (process.env.GEO_DEBUG) console.log('     ·', m); };
let geoP = null;
const loadGeo = () => (geoP ||= readFile(GEO_FILE, 'utf8').then((t) => JSON.parse(t).rutas).catch(() => ({})));

// ---- grafo de una ruta: nodos en los vértices (unidos si coinciden a ~10 m o quedan a menos de 250 m entre extremos)
const graphs = new Map();
function graphOf(id, lines) {
  if (graphs.has(id)) return graphs.get(id);
  const idx = new Map(), pts = [], adj = [];
  const node = (lon, lat) => {
    const k = lon.toFixed(4) + ',' + lat.toFixed(4);
    if (!idx.has(k)) { idx.set(k, pts.length); pts.push([lon, lat]); adj.push([]); }
    return idx.get(k);
  };
  const ends = [], lineOf = [];
  for (const [li, l] of lines.entries()) {
    let prev = null;
    for (let i = 0; i < l.length; i += 2) {
      const n = node(l[i], l[i + 1]);
      lineOf[n] ??= li;
      if (prev != null && prev !== n) { const w = dkm(pts[prev], pts[n]); adj[prev].push([n, w]); adj[n].push([prev, w]); }
      prev = n;
    }
    ends.push(node(l[0], l[1]), node(l[l.length - 2], l[l.length - 1]));
  }
  // la traza del IGN tiene huecos: cada extremo de línea se une con el nodo más cercano de otra línea si queda a menos de GAP_KM
  for (const a of new Set(ends)) {
    let best = -1, bd = GAP_KM;
    for (let b = 0; b < pts.length; b++) {
      if (lineOf[b] === lineOf[a]) continue;
      const w = dkm(pts[a], pts[b]);
      if (w < bd) { bd = w; best = b; }
    }
    if (best >= 0) { adj[a].push([best, bd]); adj[best].push([a, bd]); }
  }
  const g = { pts, adj };
  graphs.set(id, g);
  return g;
}
const nearestNode = (g, p) => { let best = -1, bd = Infinity; g.pts.forEach((q, i) => { const d = dkm(p, q); if (d < bd) { bd = d; best = i; } }); return { i: best, d: bd }; };

function shortest(g, s, t) {
  const dist = new Float64Array(g.pts.length).fill(Infinity), prev = new Int32Array(g.pts.length).fill(-1);
  dist[s] = 0;
  const heap = [[0, s]]; // montículo mínimo simple
  const push = (x) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (u === t) break;
    for (const [v, w] of g.adj[u]) if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; push([dist[v], v]); }
  }
  if (!isFinite(dist[t])) return null;
  const path = [];
  for (let u = t; u !== -1; u = prev[u]) path.push(g.pts[u]);
  return { km: dist[t], path: path.reverse() };
}

// ---- extremos
const ABBR = [[/^Gdor\.?\s+/i, 'Gobernador '], [/^Gral\.?\s+/i, 'General '], [/^Cnel\.?\s+/i, 'Coronel '], [/^Tte\.?\s+/i, 'Teniente '], [/^Pte\.?\s+/i, 'Presidente ']];
const clean = (s) => {
  let n = s.replace(/^(Acc\.?\s*(Aer\.?|Aeropuerto)?\s*(a\s+)?|Pte\.?\s*Internacional\s+con\s+)/i, '').replace(/\s*\(.*\)\s*$/, '').trim();
  for (const [re, to] of ABBR) n = n.replace(re, to);
  return n;
};
const georefCache = new Map();
async function georef(recurso, nombre, provincia) {
  const url = `${GEOREF}/${recurso}?nombre=${encodeURIComponent(nombre)}${provincia ? `&provincia=${encodeURIComponent(provincia)}` : ''}&max=8&campos=nombre,centroide`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15e3) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j[recurso] || []).map((l) => [l.centroide.lon, l.centroide.lat]);
  } catch { return []; }
}
// localidades; si no aparece, asentamientos (incluye parajes chicos); y si no, sin filtrar por provincia (el tramo puede cruzarla)
async function localidades(nombre, provincia) {
  const key = nombre + '|' + provincia;
  if (georefCache.has(key)) return georefCache.get(key);
  let out = [];
  for (const [rec, prov] of [['localidades', provincia], ['asentamientos', provincia], ['localidades', ''], ['asentamientos', '']]) {
    out = await georef(rec, nombre, prov);
    if (out.length) break;
  }
  georefCache.set(key, out);
  return out;
}

// Devuelve [lon, lat] o null. `other`: el otro extremo, ya ubicado (sirve para elegir entre varios cruces)
async function endpoint(name, id, prov, rutas, g, other) {
  const n = name.trim();
  if (/^L[ií]m(ite)?\.?|^Lte\.?|^Km\b|^Emp\.?\s*R[PC]\b|^Emp\.?\s*Ruta\s*Prov/i.test(n)) return null;
  const m = /^Emp\.?\s*R\.?N\.?\s*N?[°º]?\s*([A-Z]?\d+[A-Z]?)/i.exec(n);
  if (m) { // cruce con otra ruta nacional
    const og = rutas[m[1].toUpperCase()] && graphOf(m[1].toUpperCase(), rutas[m[1].toUpperCase()]);
    if (!og || !other) return null;
    let best = null, bd = Infinity;
    for (const p of g.pts) {
      const d = dkm(p, other);
      if (d >= bd) continue;
      let near = false;
      for (const q of og.pts) if (Math.abs(q[0] - p[0]) < 0.06 && Math.abs(q[1] - p[1]) < 0.06 && dkm(p, q) < GAP_KM) { near = true; break; }
      if (near) { bd = d; best = p; }
    }
    return best;
  }
  const cands = await localidades(clean(n), prov);
  if (!cands.length) { why(`Georef no encontró "${clean(n)}" en ${prov}`); return null; }
  let best = null, bd = Infinity;
  for (const c of cands) { const { d } = nearestNode(g, c); if (d < bd) { bd = d; best = c; } }
  if (bd > 20) why(`"${clean(n)}" queda a ${bd.toFixed(0)} km de la traza`);
  return bd <= 20 ? best : null; // la localidad tiene que estar sobre o cerca de la ruta
}

export const tieneTraza = async (id) => Boolean((await loadGeo())[String(id).toUpperCase()]);

// alerta: { ruta, prov, tramo, km } → { path: [lon, lat, ...], km } o null
export async function locate(alerta) {
  const rutas = await loadGeo();
  const id = String(alerta.ruta).toUpperCase();
  if (!rutas[id]) return null;
  const parts = alerta.tramo.split(/\s+-\s+/);
  if (parts.length !== 2) return null;
  const g = graphOf(id, rutas[id]);
  let a = await endpoint(parts[0], id, alerta.prov, rutas, g, null);
  let b = await endpoint(parts[1], id, alerta.prov, rutas, g, a);
  if (!a && b) a = await endpoint(parts[0], id, alerta.prov, rutas, g, b);
  if (!a || !b) { why(`extremos: ${a ? 'A ok' : 'A no'}, ${b ? 'B ok' : 'B no'}`); return null; }
  const na = nearestNode(g, a), nb = nearestNode(g, b);
  if (na.i === nb.i) return null;
  const sp = shortest(g, na.i, nb.i);
  if (!sp) { why('la traza no conecta los dos extremos'); return null; }
  // control contra los km que informa Vialidad (la traza del IGN y el kilometraje oficial no coinciden al metro)
  if (alerta.km && Math.abs(sp.km - alerta.km) / alerta.km > 0.35) { why(`traza ${sp.km.toFixed(0)} km vs oficial ${alerta.km}`); return null; }
  // línea simplificada (cada ~100 m alcanza)
  const out = [];
  let last = null;
  for (const p of sp.path) { if (!last || dkm(last, p) >= 0.1) { out.push(+p[0].toFixed(4), +p[1].toFixed(4)); last = p; } }
  const e = sp.path.at(-1);
  if (out[out.length - 2] !== +e[0].toFixed(4) || out[out.length - 1] !== +e[1].toFixed(4)) out.push(+e[0].toFixed(4), +e[1].toFixed(4));
  return { path: out, km: +sp.km.toFixed(1) };
}
