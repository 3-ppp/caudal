// Scraper de alturas de ríos — Prefectura Naval Argentina.
// Zero-dependency, Node >= 22 (fetch global).
//
//   GET https://contenidosweb.prefecturanaval.gob.ar/alturas/
//       -> una sola tabla server-side con TODAS las estaciones (Paraná, Paraguay,
//          Uruguay, Iguazú, Delta, Río de la Plata, ...), una fila por puerto.
//   GET .../alturas/?page=historico&id=<id>&tiempo=<7|30|180|365>
//       -> serie histórica de una estación (tabla HTML + series Highcharts).
//          El <id> sale del link "Hist." de cada fila de la tabla principal.
//
// Las horas de Prefectura son hora local argentina (UTC-3), sin DST.

import { pathToFileURL } from 'node:url';

export const SOURCE = 'Prefectura Naval Argentina';
const BASE = 'https://contenidosweb.prefecturanaval.gob.ar/alturas/';
const UA = 'Mozilla/5.0 (compatible; parana-dashboard/1.0)';

const MONTHS = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6,
  JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12,
};

async function getHtml(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Prefectura: HTTP ${res.status} al pedir ${url}`);
  return res.text();
}

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const cellText = (html) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Mayúsculas, sin acentos, espacios colapsados. */
export const normName = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/** "4,12" / "4.12" / "-0.03" -> number; "-", "S/E", "" -> null. */
function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/\s*(mts?|m)\s*$/i, '').trim().replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** "13/OCT/26 - 1200" -> { date: '2026-10-13', time: '12:00' } */
function parseStamp(s) {
  const m = /(\d{1,2})\s*\/\s*([A-Za-z]{3})\w*\s*\/\s*(\d{2,4})(?:\s*-\s*(\d{2}):?(\d{2}))?/.exec(s || '');
  if (!m) return { date: null, time: null };
  const mon = MONTHS[normName(m[2])];
  if (!mon) return { date: null, time: null };
  const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const date = `${yr}-${String(mon).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return { date, time: m[4] ? `${m[4]}:${m[5]}` : null };
}

/**
 * Parsea el HTML de la página principal. Exportado para tests.
 * @returns {Array} estaciones
 */
export function parsePrefecturaHtml(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  // La tabla correcta tiene encabezados "Puerto", "Alerta" y "Evacuación".
  const table = tables.find(
    (t) => /<th[^>]*>\s*Puerto\s*<\/th>/i.test(t) && /Alerta/i.test(t) && /Evacuaci/i.test(t),
  );
  if (!table) throw new Error('Prefectura: no se encontró la tabla de alturas (cambió el HTML del sitio?)');

  const headerRow = (table.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0];
  const headers = [...headerRow.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => normName(cellText(m[1])));
  const col = (name) => headers.findIndex((h) => h === name);
  const idx = {
    port: col('PUERTO'), river: col('RIO'), height: col('ULT. REGISTRO'), variation: col('VARIACION'),
    stamp: col('FECHA HORA'), state: col('ESTADO'), prev: col('REGISTRO ANTERIOR'),
    prevStamp: col('FECHA ANTERIOR'), alert: col('ALERTA'), evac: col('EVACUACION'),
  };
  const missing = Object.entries(idx).filter(([, v]) => v < 0).map(([k]) => k);
  if (missing.length) throw new Error(`Prefectura: faltan columnas en la tabla: ${missing.join(', ')}`);

  const body = (table.match(/<tbody[\s\S]*?<\/tbody>/i) || [table])[0];
  const stations = [];
  for (const rm of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rm[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) => cellText(m[1]));
    if (cells.length < headers.length) continue;
    const idMatch = /[?&]id=(\d+)/.exec(rm[1]);
    const stamp = parseStamp(cells[idx.stamp]);
    const prevStamp = parseStamp(cells[idx.prevStamp]);
    const port = normName(cells[idx.port]);
    if (!port) continue;
    stations.push({
      id: idMatch ? Number(idMatch[1]) : null,
      port,
      river: normName(cells[idx.river]),
      height_m: num(cells[idx.height]), // null si "S/E" (sin dato)
      var_m: num(cells[idx.variation]),
      prev_m: num(cells[idx.prev]),
      date: stamp.date,
      time: stamp.time,
      prev_date: prevStamp.date,
      prev_time: prevStamp.time,
      alert_m: num(cells[idx.alert]),
      evac_m: num(cells[idx.evac]),
      state: normName(cells[idx.state]),
    });
  }
  if (!stations.length) throw new Error('Prefectura: la tabla de alturas no tiene filas');
  return stations;
}

export async function fetchPrefectura() {
  const html = await getHtml(BASE);
  const stations = parsePrefecturaHtml(html);
  return { fetchedAt: new Date().toISOString(), source: SOURCE, stations };
}

// ---------------------------------------------------------------- historial

/** Parsea la página ?page=historico -> [{date, time, height_m}] (más nuevo primero). */
export function parseHistoryHtml(html) {
  const out = [];
  for (const m of html.matchAll(/(\d{4}-\d{2}-\d{2})\s*<i[^>]*><\/i>\s*(\d{2}:\d{2})[\s\S]*?<td>\s*([-\d.,]+)\s*Mts/gi)) {
    const h = num(m[3]);
    if (h != null) out.push({ date: m[1], time: m[2], height_m: h });
  }
  if (!out.length) {
    // Fallback: serie Highcharts [[ms_epoch, valor], ...] (epoch = hora local ART expresada como UTC-3 real)
    const s = /name:\s*'Registro',\s*data:\s*(\[\[[\s\S]*?\]\])/.exec(html);
    if (s) {
      for (const [ms, v] of JSON.parse(s[1])) {
        const d = new Date(ms - 3 * 3600e3);
        out.push({ date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), height_m: v });
      }
    }
  }
  if (!out.length) throw new Error('Prefectura: no se encontró la serie histórica en la página');
  return out;
}

/**
 * Historial de un puerto (nombre p.ej. 'ROSARIO', o id numérico de Prefectura).
 * El sitio ofrece ventanas de 7/30/180/365 días; se elige la menor >= days y se recorta.
 * @returns {Promise<Array<{date:string,time:string,height_m:number}>>} orden cronológico ascendente.
 */
export async function fetchPrefecturaHistory(port, days = 30) {
  let id = typeof port === 'number' ? port : null;
  if (id == null) {
    const { stations } = await fetchPrefectura();
    const want = normName(String(port));
    const st = stations.find((s) => s.port === want);
    if (!st || st.id == null) throw new Error(`Prefectura: puerto no encontrado: ${port}`);
    id = st.id;
  }
  const tiempo = [7, 30, 180, 365].find((t) => t >= days) ?? 365;
  const html = await getHtml(`${BASE}?page=historico&id=${id}&tiempo=${tiempo}`);
  const rows = parseHistoryHtml(html).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
  const last = rows[rows.length - 1];
  const cutoff = new Date(`${last.date}T00:00:00Z`).getTime() - days * 86400e3;
  return rows.filter((r) => new Date(`${r.date}T00:00:00Z`).getTime() >= cutoff);
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await fetchPrefectura();
    const pad = (v, n) => String(v ?? '-').padEnd(n);
    const parana = r.stations.filter((s) => s.river === 'PARANA');
    console.log(`${r.source} @ ${r.fetchedAt}: ${r.stations.length} estaciones, ${parana.length} en el Parana`);
    console.log(`${pad('port', 20)}${pad('height', 8)}${pad('alert', 7)}${pad('evac', 7)}${pad('state', 18)}date`);
    for (const s of parana) {
      console.log(`${pad(s.port, 20)}${pad(s.height_m, 8)}${pad(s.alert_m, 7)}${pad(s.evac_m, 7)}${pad(s.state, 18)}${s.date} ${s.time ?? ''}`);
    }
    const hi = process.argv.indexOf('--history');
    if (hi >= 0) {
      const p = process.argv[hi + 1] || 'ROSARIO';
      const h = await fetchPrefecturaHistory(p, 30);
      console.log(`\nHistorial ${p}: ${h.length} puntos, ${h[0].date} -> ${h[h.length - 1].date}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
