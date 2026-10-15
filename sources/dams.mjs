// Daily dam OUTFLOW (caudal / vazao defluente, m3/s) for Itaipu, Yacyreta and Salto Grande.
// Zero dependencies, Node >= 18 (global fetch). No API keys.
//
// Itaipu    : ONS (Brazil) open data, daily hydrological series per year (CSV on S3).
//             https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/dados_hidrologicos_di/DADOS_HIDROLOGICOS_RES_<YYYY>.csv
//             Row = reservoir ITAIPU (cod_usina 66). Published with ~1 day lag.
//             Uses HTTP Range (tail of the file) so the ~9 MB yearly file is only partly downloaded.
// Yacyreta  : INA Argentina "A5" alert system public JSON API, which republishes the EBY daily
//             hydrological report: series 937 = "Yacyreta efluente" (discharge), 936 = "Yacyreta afluente".
//             https://alerta.ina.gob.ar/a5/obs/puntual/series/937/observaciones?timestart=..&timeend=..
//             Values are daily means rounded to 100 m3/s. The entry for the current day is EBY's
//             same-day estimate/forecast and gets revised the next day.
// Salto Grande: CTM (Comision Tecnica Mixta) website; no JSON API exists (INA A5 series 938/939 "Aporte/Erogado
//             Salto Grande" are dead: only a few Aug-2020 samples). Three public pages are combined:
//             https://www.saltogrande.org/docs/hidrologia/CaudalesNiveles.pdf  (daily "Erogado Medio Diario", last ~4 days)
//             https://www.saltogrande.org/datos_diarios.php?f=YYYY-MM-DD      (inflow + level, any past date)
//             https://www.saltogrande.org/datos_horarios.php?fh=YYYY-MM-DD+HH%3A00%3A00 (turbined + spilled, hourly)

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const ONS_BASE = 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/dados_hidrologicos_di/DADOS_HIDROLOGICOS_RES_';
const INA_BASE = 'https://alerta.ina.gob.ar/a5/obs/puntual/series/';
const YACY_OUT_SERIES = 937;
const YACY_IN_SERIES = 936;
const TIMEOUT_MS = 60000;
const UA = 'paranasuperniño-dashboard/1.0';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// "today" in UTC-3 (Brazil/Argentina/Paraguay river-agency time), as YYYY-MM-DD
function todayLocal() {
  return iso(Date.now() - 3 * 3600000);
}
function addDays(dateStr, n) {
  return iso(Date.parse(dateStr + 'T00:00:00Z') + n * DAY);
}

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

async function http(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

// ---------------------------------------------------------------- Itaipu (ONS)

// Returns { header: string[], rows: string[][], complete: boolean } or null if the file doesn't exist (404).
// Rows in the yearly file are ordered by date, so we ask only for the tail with a Range request and
// grow it until it reaches back to `startDate` (or covers the whole file).
async function fetchOnsYear(year, startDate, days) {
  const url = `${ONS_BASE}${year}.csv`;
  // header line
  const h = await http(url, { Range: 'bytes=0-2047' });
  if (h.status === 404 || h.status === 403) return null;
  if (!h.ok) throw new Error(`ONS ${year} header HTTP ${h.status}`);
  const hText = await h.text();
  if (h.status === 200) {
    // server ignored Range: we already have the whole file
    return parseOns(hText, null);
  }
  const header = hText.split(/\r?\n/)[0].split(';');

  let bytes = Math.max(300000, Math.ceil((days + 4) * 42000));
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await http(url, { Range: `bytes=-${bytes}` });
    if (!r.ok) throw new Error(`ONS ${year} HTTP ${r.status}`);
    const text = await r.text();
    const cr = r.headers.get('content-range') || ''; // bytes a-b/total
    const m = cr.match(/bytes (\d+)-\d+\/(\d+)/);
    const startsAtZero = r.status === 200 || (m && Number(m[1]) === 0);
    let body = text;
    if (!startsAtZero) body = text.slice(text.indexOf('\n') + 1); // drop partial first line
    const parsed = parseOns(startsAtZero ? text : null, header, body);
    // earliest date present in the chunk (first day may be incomplete -> require strictly earlier)
    let minDate = null;
    for (const row of parsed.rows) {
      const d = row[parsed.iDate];
      if (d && (minDate === null || d < minDate)) minDate = d;
    }
    if (startsAtZero || (minDate && minDate < startDate)) return parsed;
    bytes = Math.ceil(bytes * 1.6);
  }
  // fall back to the whole file
  const full = await http(url);
  if (!full.ok) throw new Error(`ONS ${year} HTTP ${full.status}`);
  return parseOns(await full.text(), null);
}

function parseOns(fullText, headerIn, bodyOnly) {
  let header = headerIn;
  let lines;
  if (bodyOnly != null) {
    lines = bodyOnly.split(/\r?\n/);
  } else {
    lines = fullText.split(/\r?\n/);
    header = lines.shift().replace(/^﻿/, '').split(';');
  }
  const idx = (name) => header.indexOf(name);
  const iDate = idx('din_instante');
  const iName = idx('nom_reservatorio');
  const iCode = idx('cod_usina');
  if (iDate < 0 || iName < 0) throw new Error('ONS CSV: unexpected header');
  const rows = [];
  for (const line of lines) {
    if (!line || line.indexOf('ITAIPU') < 0) continue;
    const c = line.split(';');
    if (c.length < header.length - 1) continue; // truncated line
    if (c[iName].trim() !== 'ITAIPU') continue;
    rows.push(c);
  }
  return { header, rows, iDate, iCode, idx };
}

export async function fetchItaipu({ days = 120 } = {}) {
  const today = todayLocal();
  const start = addDays(today, -(days + 1)); // small margin; trimmed below
  const y1 = Number(today.slice(0, 4));
  const y0 = Number(start.slice(0, 4));

  const byDate = new Map();
  let anyFile = false;
  for (let y = y0; y <= y1; y++) {
    const parsed = await fetchOnsYear(y, y === y0 ? start : `${y}-01-01`, days);
    if (!parsed) continue; // e.g. current-year file not yet created in early January
    anyFile = true;
    const { idx, iDate } = parsed;
    const iOut = idx('val_vazaodefluente');
    const iIn = idx('val_vazaoafluente');
    const iSp = idx('val_vazaovertida');
    const iLv = idx('val_nivelmontante');
    for (const c of parsed.rows) {
      const date = c[iDate];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      byDate.set(date, {
        date,
        outflow: num(c[iOut]),
        inflow: num(c[iIn]),
        spill: num(c[iSp]),
        level_m: num(c[iLv]),
      });
    }
  }
  if (!anyFile) throw new Error('ONS: no yearly CSV available');

  let series = [...byDate.values()].filter((r) => r.outflow !== null).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!series.length) throw new Error('ONS: no Itaipu rows found');
  const last = series[series.length - 1].date;
  const first = addDays(last, -(days - 1));
  series = series.filter((r) => r.date >= first);
  return {
    source: 'ONS dados abertos - Dados Hidraulicos por Reservatorio (base diaria), ITAIPU',
    unit: 'm3/s',
    series,
  };
}

// ---------------------------------------------------------------- Yacyreta (INA A5 <- EBY)

async function inaSeries(id, from, to) {
  const url = `${INA_BASE}${id}/observaciones?timestart=${from}&timeend=${to}`;
  const res = await http(url, { Accept: 'application/json' });
  if (!res.ok) throw new Error(`INA series ${id} HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error(`INA series ${id}: unexpected response`);
  const m = new Map();
  for (const o of arr) {
    if (!o || o.valor == null || !o.timestart) continue;
    // timestart is local midnight UTC-3 expressed in UTC (03:00Z) -> local date
    const date = iso(Date.parse(o.timestart) - 3 * 3600000);
    const v = Number(o.valor);
    if (Number.isFinite(v)) m.set(date, v);
  }
  return m;
}

export async function fetchYacyreta({ days = 120 } = {}) {
  const today = todayLocal();
  const from = addDays(today, -(days + 1));
  const to = addDays(today, 2);
  let out, inn;
  try {
    [out, inn] = await Promise.all([
      inaSeries(YACY_OUT_SERIES, from, to),
      inaSeries(YACY_IN_SERIES, from, to).catch(() => new Map()),
    ]);
  } catch (e) {
    throw new Error(`not available: INA A5 API failed (${e.message})`);
  }
  if (!out.size) throw new Error('not available: INA A5 returned no Yacyreta efluente data');
  let series = [...out.keys()].sort().map((date) => ({
    date,
    outflow: out.get(date),
    inflow: inn.has(date) ? inn.get(date) : null,
    spill: null, // not published in this feed
    level_m: null, // reservoir level only in EBY text bulletins (not parsed here)
  }));
  const last = series[series.length - 1].date;
  const first = addDays(last, -(days - 1));
  series = series.filter((r) => r.date >= first);
  return {
    source: 'INA Argentina A5 (alerta.ina.gob.ar) series 937 "Yacyreta efluente" / 936 "afluente", from EBY daily report',
    unit: 'm3/s',
    series,
  };
}

// ---------------------------------------------------------------- Salto Grande (CTM)

const CTM_BASE = 'https://www.saltogrande.org/';
const CTM_HOURS = [3, 9, 15, 21]; // hourly snapshots averaged for days not covered by the PDF
const CTM_CONCURRENCY = 4;

async function ctmBytes(path, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      // CTM's Cloudflare returns 403 for custom User-Agents
      const res = await http(CTM_BASE + path, { 'User-Agent': 'Mozilla/5.0' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i + 1 < tries) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`CTM ${path}: ${lastErr.message}`);
}
const ctmHtml = async (path, tries) => new TextDecoder('latin1').decode(await ctmBytes(path, tries));

// "18.607" -> 18607 ; "32,53" -> 32.53
const ctmNum = (s) => num(String(s).replace(/\./g, '').replace(',', '.'));

// Value cell following a row label in the CTM HTML tables.
function ctmCell(html, label) {
  const i = html.indexOf(label);
  if (i < 0) return null;
  const m = html.slice(i, i + 400).match(/text-align:\s*right;?">\s*(-?[\d.,]+)/);
  return m ? ctmNum(m[1]) : null;
}

// Daily report PDF (TCPDF; text operators inside Flate streams): table "Salto Grande - Erogado Medio Diario (m3/s)"
// with QTurb/QVert/QTotal per day; rows "0 a 0" (calendar day) and "7 a 7" (07:00-07:00).
// Returns Map date -> {turb, vert, total} for COMPLETE calendar days only (today's "0 a 0" is partial).
function parseCtmPdf(bytes) {
  const buf = Buffer.from(bytes);
  const s = buf.toString('latin1');
  const items = []; // {x, y, t}
  let i = 0;
  while ((i = s.indexOf('stream', i)) >= 0) {
    if (s.slice(i - 3, i) === 'end') { i += 6; continue; }
    let st = i + 6;
    if (s[st] === '\r') st++;
    if (s[st] === '\n') st++;
    const en = s.indexOf('endstream', st);
    if (en < 0) break;
    let txt = null;
    try { txt = inflateSync(buf.subarray(st, en)).toString('latin1'); } catch { /* not a flate stream */ }
    if (txt && txt.includes(' Td [(')) {
      for (const m of txt.matchAll(/BT\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Td\s+\[\((.*?)\)\]\s*TJ/g)) {
        items.push({ x: Number(m[1]), y: Number(m[2]), t: m[3].replace(/\\([()\\])/g, '$1') });
      }
    }
    i = en + 9;
  }
  if (!items.length) throw new Error('PDF: no text found');
  const rep = items.find((it) => /^Reporte de caudales/.test(it.t));
  const rm = rep && rep.t.match(/(\d{2})\/(\d{2})\/(\d{4})\s*$/);
  if (!rm) throw new Error('PDF: report date not found');
  const reportDate = `${rm[3]}-${rm[2]}-${rm[1]}`;
  const title = items.find((it) => /^Salto Grande - Erogado Medio Diario/.test(it.t));
  if (!title) throw new Error('PDF: Erogado table not found');
  const dateCols = items
    .filter((it) => /^\d{2}\/\d{2}\/\d{4}$/.test(it.t) && it.y < title.y && it.y > title.y - 25)
    .map((it) => ({ x: it.x, date: it.t.slice(6) + '-' + it.t.slice(3, 5) + '-' + it.t.slice(0, 2) }));
  const rowLab = items.find((it) => /^0 a 0$/.test(it.t) && it.y < title.y && it.y > title.y - 60);
  if (!dateCols.length || !rowLab) throw new Error('PDF: Erogado table layout changed');
  const rowItems = items.filter((it) => Math.abs(it.y - rowLab.y) < 1.5 && /^\d+$/.test(it.t));
  const out = new Map();
  for (const col of dateCols) {
    if (col.date >= reportDate) continue; // today's "0 a 0" mean is still partial
    // three columns QTurb, QVert, QTotal start at col.x (+0, +36.6, +73.3)
    const cell = (k) => rowItems.find((it) => Math.abs(it.x - (col.x + k * 36.63)) < 3);
    const t = cell(0), v = cell(1), q = cell(2);
    if (t && v && q) out.set(col.date, { turb: Number(t.t), vert: Number(v.t), total: Number(q.t) });
  }
  return { reportDate, byDate: out };
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      res[k] = await fn(items[k], k);
    }
  }));
  return res;
}

export async function fetchSaltoGrande({ days = 120 } = {}) {
  const today = todayLocal();

  // 1) exact daily erogado from the PDF (last ~3 complete days)
  let pdf = new Map();
  try {
    pdf = parseCtmPdf(await ctmBytes('docs/hidrologia/CaudalesNiveles.pdf')).byDate;
  } catch { /* fall back to hourly sampling for every day */ }

  // 2) inflow + level per complete day (today is partial, skipped)
  const dates = [];
  for (let k = days; k >= 1; k--) dates.push(addDays(today, -k));
  let failed = 0;
  const daily = await pool(dates, CTM_CONCURRENCY, async (d) => {
    try {
      const h = await ctmHtml(`datos_diarios.php?f=${d}`);
      return { inflow: ctmCell(h, 'Caudal de Aporte'), level_m: ctmCell(h, 'Cota presa a las 24:00') };
    } catch { failed++; return null; }
  });
  if (failed === dates.length) throw new Error('not available: saltogrande.org unreachable');

  // 3) outflow for days the PDF does not cover: mean of hourly turbined + spilled snapshots
  const hourly = await pool(dates, CTM_CONCURRENCY, async (d, k) => {
    if (pdf.has(d) || !daily[k]) return null;
    const tur = [], ver = [];
    for (const hh of CTM_HOURS) {
      try {
        const h = await ctmHtml(`datos_horarios.php?fh=${d}+${String(hh).padStart(2, '0')}%3A00%3A00`, 1);
        const t = ctmCell(h, 'Caudal Turbinado'), v = ctmCell(h, 'Caudal Vertido');
        if (t !== null && v !== null) { tur.push(t); ver.push(v); }
      } catch { /* skip this hour */ }
    }
    if (tur.length < 2) return null;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return { outflow: Math.round(mean(tur) + mean(ver)), spill: Math.round(mean(ver)) };
  });

  const series = [];
  dates.forEach((date, k) => {
    const dl = daily[k];
    if (!dl) return;
    let outflow = null, spill = null;
    if (pdf.has(date)) { outflow = pdf.get(date).total; spill = pdf.get(date).vert; }
    else if (hourly[k]) { outflow = hourly[k].outflow; spill = hourly[k].spill; }
    if (outflow === null && dl.inflow === null) return;
    series.push({ date, outflow, inflow: dl.inflow, spill, level_m: dl.level_m });
  });
  if (!series.some((r) => r.outflow !== null)) throw new Error('not available: no Salto Grande outflow parsed from CTM pages');
  return {
    source: 'CTM Salto Grande (saltogrande.org): outflow = "Erogado Medio Diario" (CaudalesNiveles.pdf, last complete days) ' +
      `else mean of ${CTM_HOURS.length} hourly turbined+spilled snapshots (datos_horarios.php); inflow = "Caudal de Aporte" and ` +
      'level_m = "Cota presa 24:00" (datos_diarios.php)',
    unit: 'm3/s',
    series,
  };
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, fn] of [['Itaipu', fetchItaipu], ['Yacyreta', fetchYacyreta], ['SaltoGrande', fetchSaltoGrande]]) {
    try {
      const r = await fn({ days: name === 'SaltoGrande' ? 30 : 120 });
      console.log(`\n== ${name} == ${r.source}  [${r.unit}] n=${r.series.length}`);
      for (const p of r.series.slice(-10)) console.log(JSON.stringify(p));
    } catch (e) {
      console.log(`\n== ${name} == ERROR: ${e.message}`);
    }
  }
}
