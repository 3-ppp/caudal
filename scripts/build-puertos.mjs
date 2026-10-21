// Genera public/puertos.json: las escalas de Prefectura (republicadas por el INA) con su ubicación, para dibujarlas en el
// mapa. El mapa une cada una con su lectura de hoy (extras.heights) por el nombre del puerto.
//   node scripts/build-puertos.mjs [estaciones.json]
import { writeFile, readFile } from 'node:fs/promises';
import { SERIES } from '../sources/heights-ina.mjs';
import { root } from './lib/rio.mjs';

let est;
if (process.argv[2]) est = JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[2], 'utf8')); // para probar sin red
for (let k = 0; !est; k++) {
  const res = await fetch('https://alerta.ina.gob.ar/a5/obs/puntual/estaciones?tabla=alturas_prefe', { signal: AbortSignal.timeout(60e3) }).catch(() => ({ ok: false, status: 'sin respuesta' }));
  if (res.ok) { est = await res.json(); break; }
  if (k > 4) throw new Error(`INA: HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 5e3));
}
// nombre del puerto en el servidor (clave de SERIES) a partir del id de la estación
const byId = Object.fromEntries(Object.entries(SERIES).map(([port, s]) => [s.id, { port, river: s.river }]));
const out = [];
for (const e of est) {
  const s = byId[e.id], c = e.geom?.coordinates;
  if (!s || !c) continue;
  out.push({ port: s.port, n: e.nombre, river: s.river, lat: +c[1].toFixed(4), lon: +c[0].toFixed(4),
    ...(e.nivel_alerta != null ? { alert: e.nivel_alerta } : {}), ...(e.nivel_evacuacion != null ? { evac: e.nivel_evacuacion } : {}) });
}
await writeFile(root('public/puertos.json'), JSON.stringify({ fuente: 'Escalas de Prefectura Naval Argentina, vía INA (Sistema de Alerta Hidrológico)', generado: new Date().toISOString().slice(0, 10), puertos: out }));
console.log('public/puertos.json:', out.length, 'puertos de', est.length, 'estaciones');
// Escalas de la red de Prefectura que el monitor no usa (Delta, Río de la Plata, Uruguay menor, represas): se suman a las series
// extra del servidor para que el mapa las muestre. Quedan fuera del monitor (grp: 'pna').
const RIO = { PARANADELASPALMAS: 'DELTA', LATINTA: 'DELTA', CANALGAFOTRE: 'DELTA', PARANAIBICUY: 'DELTA', GUALEGUAY: 'DELTA', PARANAGUAZU: 'DELTA', CHANA: 'DELTA',
  BRAZOLARGO: 'DELTA', LUJAN: 'DELTA', RIODELAPLATA: 'RIO DE LA PLATA', GUALEGUAYCHU: 'URUGUAY', URUGUAY: 'URUGUAY', PARAGUAY: 'PARAGUAY', PARANAMED: 'PARANA',
  PARANAINF: 'PARANA', BARRANQUERAS: 'PARANA', SANJAVIER: 'PARANA', VICTORIA: 'PARANA', BARADERO: 'PARANA', IGUAZU: 'IGUAZU' };
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/s+/g, ' ').trim();
const known = new Set(Object.values(SERIES).map((s) => s.id));
let ex = {};
try { ex = JSON.parse(await readFile(root('sources/gauges-extra.json'), 'utf8')); } catch {}
for (const k of Object.keys(ex)) if (ex[k].grp === 'pna') delete ex[k];
let nuevas = 0;
for (const e of est) {
  const c = e.geom?.coordinates;
  if (known.has(e.id) || !c || !e.has_obs) continue;
  ex[norm(e.nombre)] = { id: e.id, river: RIO[e.rio] ?? norm(e.rio ?? 'OTRO'), lat: +c[1].toFixed(4), lon: +c[0].toFixed(4), grp: 'pna',
    ...(e.nivel_alerta != null ? { alert: e.nivel_alerta } : {}), ...(e.nivel_evacuacion != null ? { evac: e.nivel_evacuacion } : {}) };
  nuevas++;
}
await writeFile(root('sources/gauges-extra.json'), JSON.stringify(ex, null, 1));
console.log('sources/gauges-extra.json: +' + nuevas + ' escalas de Prefectura fuera del monitor');
const sinUbicar = Object.entries(SERIES).filter(([, s]) => !est.some((e) => e.id === s.id)).map(([p]) => p);
if (sinUbicar.length) console.log('sin ubicación en el INA:', sinUbicar.join(', '));
