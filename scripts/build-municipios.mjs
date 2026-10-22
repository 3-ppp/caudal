// Genera public/municipios.json: gobiernos locales de las provincias de la zona, con su población (Censo 2022),
// las inundaciones reportadas entre 1999 y 2022, el teléfono y el sitio web.
//   node scripts/build-municipios.mjs
//
// Fuente: Registro Federal de Gobiernos Locales (ReFeGLo), Ministerio del Interior, datos.gob.ar, CC BY 4.0.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { root, rootPath } from './lib/rio.mjs';

const URL_CSV = 'http://datos.mininterior.gob.ar/dataset/8431ab79-3f44-41ee-b72b-cdc645f68d1e/resource/ebe52783-6a7f-4112-8a7f-a17c91cb6b4e/download/brgl_-portal-andino-23_12.csv';
const PROVINCIAS = new Set(['Misiones', 'Corrientes', 'Chaco', 'Formosa', 'Entre Ríos', 'Santa Fe', 'Neuquén', 'Río Negro']);

await mkdir(root('data/cache/'), { recursive: true });
const file = rootPath('data/cache/gobiernos-locales.csv');
if (!existsSync(file)) {
  console.log('descargando el registro de gobiernos locales');
  const res = await fetch(URL_CSV);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}
const rows = (await readFile(file)).toString('latin1').split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));
const H = rows[0].map((h) => h.trim());
const col = (name) => { const i = H.findIndex((h) => h.startsWith(name)); if (i < 0) throw new Error('falta la columna ' + name); return i; };
const iProv = col('provincia'), iDep = col('departamento'), iNom = col('gobierno_local'), iPob = col('poblaci'),
  iInu = col('inundaciones_reportadas'), iTel = col('telefonos_municipio'), iWeb = col('sitio_web'), iLat = col('latitud'), iLon = col('longitud');

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const num = (s) => { const v = clean(s).replace(/\./g, '').replace(',', '.'); return v === '' || v === '-' ? null : Number.isFinite(+v) ? +v : null; };
const real = (s) => { const v = parseFloat(clean(s).replace(',', '.')); return Number.isFinite(v) ? v : null; };
const web = (s) => { const v = clean(s); return /^(https?:\/\/|www\.)/i.test(v) ? v : null; };
const tel = (s) => { const v = clean(s); return v && v !== '-' ? v : null; };

const out = [];
for (const r of rows.slice(1)) {
  const prov = clean(r[iProv]);
  if (!PROVINCIAS.has(prov)) continue;
  const lat = real(r[iLat]), lon = real(r[iLon]);
  out.push({
    n: clean(r[iNom]), d: clean(r[iDep]), p: prov, pob: num(r[iPob]), inu: num(r[iInu]),
    tel: tel(r[iTel]), web: web(r[iWeb]), ...(lat != null && lon != null ? { c: [+lon.toFixed(4), +lat.toFixed(4)] } : {}),
  });
}
const doc = {
  fuente: 'Registro Federal de Gobiernos Locales (ReFeGLo) · Ministerio del Interior · datos.gob.ar · CC BY 4.0',
  periodo: '1999-2022', generado: new Date().toISOString().slice(0, 10), municipios: out,
};
await writeFile(root('public/municipios.json'), JSON.stringify(doc));
console.log(`public/municipios.json: ${out.length} gobiernos locales (${(Buffer.byteLength(JSON.stringify(doc)) / 1024).toFixed(0)} KB)`);
const con = out.filter((m) => m.inu != null);
console.log(`con dato de inundaciones: ${con.length}; con alguna reportada: ${con.filter((m) => m.inu > 0).length}; máx: ${Math.max(...con.map((m) => m.inu))} (${con.sort((a, b) => b.inu - a.inu)[0].n})`);
