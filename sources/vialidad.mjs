// Estado oficial de las rutas nacionales (Vialidad Nacional, "Estado de rutas").
// https://www.argentina.gob.ar/transporte/vialidad-nacional/estado-de-rutas
//
// La tabla de esa página se arma en el navegador con una planilla pública (hoja "tablavisible"); acá se lee la
// misma planilla como CSV. Solo cubre RUTAS NACIONALES: las provinciales dependen de cada provincia.
// Los textos de argentina.gob.ar están bajo licencia CC BY 4.0.
//   node sources/vialidad.mjs   → imprime los tramos que no están habilitados
//
// Si la página cambia de planilla, el id está en su HTML (buscar "idSpread").
//
// Los tramos con corte o restricción de la zona se ubican sobre la traza de la ruta (sources/vialidad-geo.mjs);
// la planilla los nombra por localidades y no trae geometría, así que la ubicación es aproximada.
import { locate, tieneTraza } from './vialidad-geo.mjs';

// provincias de la zona (cuenca baja del Paraná y el Uruguay)
const ZONA = new Set(['Misiones', 'Corrientes', 'Chaco', 'Formosa', 'Entre Ríos', 'Santa Fe']);
const SHEET = '17AqjqeNvM4nG6cOUsUFKFaKXMiNmztYfzHIxeM9FcXk';
const URL_CSV = `https://docs.google.com/spreadsheets/d/${SHEET}/gviz/tq?tqx=out:csv&sheet=tablavisible`;
const PAGE = 'https://www.argentina.gob.ar/transporte/vialidad-nacional/estado-de-rutas';
const UA = 'Mozilla/5.0 (compatible; parana-dashboard/1.0)';

// CSV con comillas (los campos traen HTML y saltos de línea)
function parseCsv(t) {
  const rows = []; let f = '', row = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const text = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const num = (s) => { const n = parseFloat(String(s || '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
// "19/10/2026 09:00" → ms (hora argentina, UTC-3)
const when = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 3, +m[5]) : 0;
};

export async function fetchEstadoRutas() {
  const res = await fetch(URL_CSV, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30e3) });
  if (!res.ok) throw new Error(`Vialidad: HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  // fila 1: filtros; fila 2: encabezados; desde la 3: datos
  const data = rows.slice(2).filter((r) => r[0] && r[1]);
  if (data.length < 100) throw new Error('Vialidad: la planilla no tiene el formato esperado');
  const rutas = {}, alertas = [];
  let last = 0;
  for (const r of data) {
    const ruta = text(r[1]).toUpperCase(), estado = text(r[3]).toUpperCase();
    const o = (rutas[ruta] ||= { total: 0, habilitadas: 0 });
    o.total++;
    last = Math.max(last, when(r[8]));
    if (estado === 'HABILITADA') { o.habilitadas++; continue; }
    alertas.push({
      prov: text(r[0]), ruta, tramo: text(r[2]), estado, calzada: text(r[4]), km: num(r[5]),
      obs: text(r[7]).slice(0, 900), act: text(r[8]),
    });
  }
  // las alertas de la zona (rutas con traza y provincias de la cuenca) se ubican en el mapa
  for (const a of alertas) {
    a.zona = ZONA.has(a.prov) && (await tieneTraza(a.ruta));
    if (!a.zona) continue;
    try { const g = await locate(a); if (g) { a.geom = g.path; a.geomKm = g.km; } } catch {}
  }
  return {
    fetchedAt: new Date().toISOString(), source: 'Vialidad Nacional · Estado de rutas (rutas nacionales)', url: PAGE,
    updated: last ? new Date(last).toISOString() : null, rutas, alertas,
  };
}

if (process.argv[1]?.endsWith('vialidad.mjs')) {
  const e = await fetchEstadoRutas();
  console.log(`${Object.keys(e.rutas).length} rutas · actualizado ${e.updated}`);
  for (const a of e.alertas) console.log(`RN ${a.ruta} · ${a.prov} · ${a.tramo} · ${a.estado} · ${a.act}${a.zona ? ` · zona${a.geom ? ` · ubicado (${a.geomKm} km)` : ' · sin ubicar'}` : ''}`);
}
