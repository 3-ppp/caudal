// Archivo histórico propio, sin recorte: lo que el monitor muestra se descarta a los 120–400 días,
// acá se conserva todo para poder compararlo más adelante con información cualitativa.
//
//   data/archive/glofas-observed.json   { estación: { fecha: caudal m³/s } }   (se corrige si GloFAS revisa un día)
//   data/archive/glofas-forecasts.jsonl una línea por día de emisión: { issued, days, stations: { id: {q,lo,hi} } }
//   data/archive/heights.json           { "río|puerto": { fecha: altura m } }
//   data/archive/dams.json              { represa: { fecha: {outflow,inflow,...} } }
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

let dir = null;
export async function initArchive(dataDir) {
  dir = path.join(dataDir, 'archive');
  await mkdir(dir, { recursive: true });
}

const readJSON = async (f, dflt) => { try { return JSON.parse(await readFile(path.join(dir, f), 'utf8')); } catch { return dflt; } };
async function writeAtomic(f, text) {
  const p = path.join(dir, f);
  await writeFile(p + '.tmp', text);
  await rename(p + '.tmp', p);
}

// caudal observado/modelado (la parte pasada de la serie de GloFAS) + pronóstico emitido hoy
export async function archiveGlofas(latest) {
  const obs = await readJSON('glofas-observed.json', {});
  for (const s of latest.stations) {
    const o = (obs[s.id] ||= {});
    latest.days.forEach((d, i) => { if (d <= latest.today && s.q[i] != null) o[d] = s.q[i]; });
  }
  await writeAtomic('glofas-observed.json', JSON.stringify(obs));

  const fi = latest.days.findIndex((d) => d > latest.today);
  if (fi < 0) return;
  const line = {
    issued: latest.today, fetchedAt: latest.updated, days: latest.days.slice(fi),
    stations: Object.fromEntries(latest.stations.map((s) => [s.id,
      { q: s.q.slice(fi), lo: s.lo.slice(fi), hi: s.hi.slice(fi) }])),
  };
  // una sola emisión por día: la última corrida del día reemplaza a las anteriores
  let prev = '';
  try { prev = await readFile(path.join(dir, 'glofas-forecasts.jsonl'), 'utf8'); } catch {}
  const keep = prev.split('\n').filter((l) => l && !l.startsWith(`{"issued":"${line.issued}"`));
  await writeAtomic('glofas-forecasts.jsonl', [...keep, JSON.stringify(line)].join('\n') + '\n');
}

export async function archiveHeights(h) {
  const a = await readJSON('heights.json', {});
  for (const [k, ser] of Object.entries(h)) Object.assign((a[k] ||= {}), ser);
  await writeAtomic('heights.json', JSON.stringify(a));
}

export async function archiveDam(id, series) {
  const a = await readJSON('dams.json', {});
  const d = (a[id] ||= {});
  for (const { date, ...rest } of series) d[date] = rest;
  await writeAtomic('dams.json', JSON.stringify(a));
}
