// Motor de datos de Caudal: una sola base SQLite (data/caudal.db) con el módulo node:sqlite de Node
// (22.13 o más nuevo: sin dependencias). Guarda todo lo que antes eran archivos JSON sueltos:
//
//   docs               instantáneas que el sitio sirve tal cual: latest (caudal GloFAS), extras (alturas, rutas, satélite,
//                      pronóstico INA), climatología por punto, metadatos de cada represa y el estado de las estadísticas
//   glofas_observed    caudal observado/modelado por punto y día, sin recorte
//   glofas_forecast    cada pronóstico emitido (una emisión por día), para compararlo después con lo que pasó
//   heights            altura medida por escala y día, sin recorte (el monitor muestra los últimos 400 días)
//   dam_series         erogado, aporte, vertido y cota de las represas, sin recorte
//   analytics_days     totales por día de las estadísticas (sin datos personales)
//   reports            reportes de vecinos (anegamientos), con su vencimiento y moderación
//   report_votes       "sigue así" / "ya bajó" de otros usuarios (uno por dispositivo y reporte)
//   access_tokens      accesos de solo lectura para la herramienta de análisis (autoridades); se guarda el hash
//
// Los mosaicos y las imágenes satelitales siguen siendo archivos (son binarios y se sirven directo del disco).
// migrateLegacy() importa los JSON de versiones anteriores la primera vez; no los borra ni los modifica.
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (name TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS glofas_observed (station TEXT NOT NULL, date TEXT NOT NULL, q REAL NOT NULL, PRIMARY KEY (station, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS glofas_issues (issued TEXT PRIMARY KEY, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS glofas_forecast (issued TEXT NOT NULL, station TEXT NOT NULL, date TEXT NOT NULL, q REAL, lo REAL, hi REAL, PRIMARY KEY (issued, station, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS heights (series TEXT NOT NULL, date TEXT NOT NULL, height REAL NOT NULL, PRIMARY KEY (series, date)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS heights_date ON heights (date);
CREATE TABLE IF NOT EXISTS dam_series (dam TEXT NOT NULL, date TEXT NOT NULL, outflow REAL, inflow REAL, spill REAL, level_m REAL, PRIMARY KEY (dam, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS analytics_days (day TEXT PRIMARY KEY, json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,          -- ms desde 1970
  expires INTEGER NOT NULL,          -- hasta cuándo se muestra en el mapa público
  lat REAL NOT NULL, lon REAL NOT NULL,  -- redondeados a ~100 m al guardar
  kind TEXT NOT NULL,                -- calle | casas | ruta | rio
  sev INTEGER NOT NULL,              -- 1 leve, 2 media, 3 grave
  note TEXT NOT NULL DEFAULT '',
  rhash TEXT NOT NULL,               -- hash del dispositivo con sal del día: sirve para límites y para contar dispositivos distintos
  hidden INTEGER NOT NULL DEFAULT 0, -- 1 = ocultado por moderación (no se borra: queda para auditar)
  hidden_at INTEGER
);
CREATE INDEX IF NOT EXISTS reports_created ON reports (created);
CREATE INDEX IF NOT EXISTS reports_active ON reports (hidden, expires);
CREATE TABLE IF NOT EXISTS report_votes (
  report_id INTEGER NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  rhash TEXT NOT NULL, v TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (report_id, rhash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'autoridad', created INTEGER NOT NULL, revoked INTEGER, last_used INTEGER
);
`;

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'caudal.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map();
  const stmt = (sql) => cache.get(sql) ?? (cache.set(sql, db.prepare(sql)), cache.get(sql));
  const run = (sql, ...p) => stmt(sql).run(...p);
  const get = (sql, ...p) => stmt(sql).get(...p);
  const all = (sql, ...p) => stmt(sql).all(...p);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  };

  // ---------- docs: instantáneas JSON
  const getDoc = (name) => { const r = get('SELECT json FROM docs WHERE name = ?', name); return r ? JSON.parse(r.json) : null; };
  const getDocRow = (name) => get('SELECT json, updated FROM docs WHERE name = ?', name) ?? null;
  const setDoc = (name, obj) => { run('INSERT OR REPLACE INTO docs (name, json, updated) VALUES (?, ?, ?)', name, JSON.stringify(obj), Date.now()); };
  const docUpdated = (name) => get('SELECT updated FROM docs WHERE name = ?', name)?.updated ?? null;
  const docsByPrefix = (prefix) => Object.fromEntries(all('SELECT name, json FROM docs WHERE name LIKE ?', prefix + '%')
    .map((r) => [r.name.slice(prefix.length), JSON.parse(r.json)]));

  // ---------- caudal GloFAS: lo observado y cada pronóstico emitido
  function putGlofas(latest) {
    tx(() => {
      for (const s of latest.stations) {
        latest.days.forEach((d, i) => { if (d <= latest.today && s.q[i] != null) run('INSERT OR REPLACE INTO glofas_observed VALUES (?, ?, ?)', s.id, d, s.q[i]); });
      }
      const fi = latest.days.findIndex((d) => d > latest.today);
      if (fi < 0) return;
      // una sola emisión por día: la última corrida del día reemplaza a las anteriores
      run('DELETE FROM glofas_forecast WHERE issued = ?', latest.today);
      run('INSERT OR REPLACE INTO glofas_issues VALUES (?, ?)', latest.today, latest.updated);
      for (const s of latest.stations) {
        for (let i = fi; i < latest.days.length; i++) run('INSERT INTO glofas_forecast VALUES (?, ?, ?, ?, ?, ?)', latest.today, s.id, latest.days[i], s.q[i] ?? null, s.lo[i] ?? null, s.hi[i] ?? null);
      }
    });
  }

  // ---------- alturas medidas
  const putHeights = (rows) => tx(() => { for (const [series, date, h] of rows) if (h != null && date) run('INSERT OR REPLACE INTO heights VALUES (?, ?, ?)', series, date, h); });
  const heightCount = (series) => get('SELECT COUNT(*) n FROM heights WHERE series = ?', series).n;
  function heightsSince(cutoff) {
    const out = {};
    for (const r of all('SELECT series, date, height FROM heights WHERE date >= ? ORDER BY series, date', cutoff)) (out[r.series] ||= {})[r.date] = r.height;
    return out;
  }

  // ---------- represas
  function putDam(id, meta, series) {
    tx(() => {
      setDoc('dam:' + id, meta);
      for (const s of series) run('INSERT OR REPLACE INTO dam_series VALUES (?, ?, ?, ?, ?, ?)', id, s.date, s.outflow ?? null, s.inflow ?? null, s.spill ?? null, s.level_m ?? null);
    });
  }
  function getDam(id, sinceDate = '0000-00-00') {
    const meta = getDoc('dam:' + id);
    if (!meta) return null;
    return { ...meta, series: all('SELECT date, outflow, inflow, spill, level_m FROM dam_series WHERE dam = ? AND date >= ? ORDER BY date', id, sinceDate) };
  }
  const damIds = () => all('SELECT DISTINCT dam FROM dam_series').map((r) => r.dam);

  // ---------- estadísticas
  const analyticsDays = (since) => Object.fromEntries(all('SELECT day, json FROM analytics_days WHERE day >= ?', since).map((r) => [r.day, JSON.parse(r.json)]));
  const putAnalyticsDay = (day, obj) => { run('INSERT OR REPLACE INTO analytics_days VALUES (?, ?)', day, JSON.stringify(obj)); };
  const pruneAnalytics = (cutoff) => { run('DELETE FROM analytics_days WHERE day < ?', cutoff); };

  return { db, run, get, all, tx, getDoc, getDocRow, setDoc, docUpdated, docsByPrefix, putGlofas, putHeights, heightCount, heightsSince,
    putDam, getDam, damIds, analyticsDays, putAnalyticsDay, pruneAnalytics, close: () => db.close() };
}

// ---------- migración desde los JSON de versiones anteriores
// Cada archivo se importa una sola vez (queda anotado en docs "migrated:…"). Los originales no se tocan:
// sirven de respaldo y permiten volver a la versión anterior de la app.
export async function migrateLegacy(store, dataDir, log = () => {}) {
  const read = async (...p) => { try { return await readFile(path.join(dataDir, ...p), 'utf8'); } catch { return null; } };
  const once = async (tag, fn) => {
    if (store.getDocRow('migrated:' + tag)) return;
    const n = await fn();
    if (n == null) return; // el archivo no existe: nada que anotar
    store.setDoc('migrated:' + tag, { at: new Date().toISOString(), rows: n });
    log(`migración ${tag}: ${n} filas`);
  };

  await once('latest.json', async () => {
    const t = await read('latest.json'); if (!t) return null;
    store.setDoc('latest', JSON.parse(t)); return 1;
  });
  await once('archive/glofas-observed.json', async () => {
    const t = await read('archive', 'glofas-observed.json'); if (!t) return null;
    const obs = JSON.parse(t); let n = 0;
    store.tx(() => { for (const [st, ser] of Object.entries(obs)) for (const [d, q] of Object.entries(ser)) { store.run('INSERT OR REPLACE INTO glofas_observed VALUES (?, ?, ?)', st, d, q); n++; } });
    return n;
  });
  await once('archive/glofas-forecasts.jsonl', async () => {
    const t = await read('archive', 'glofas-forecasts.jsonl'); if (!t) return null;
    let n = 0;
    store.tx(() => {
      for (const line of t.split('\n')) {
        if (!line.trim()) continue;
        const f = JSON.parse(line);
        store.run('INSERT OR REPLACE INTO glofas_issues VALUES (?, ?)', f.issued, f.fetchedAt ?? null);
        for (const [st, s] of Object.entries(f.stations)) f.days.forEach((d, i) => {
          store.run('INSERT OR REPLACE INTO glofas_forecast VALUES (?, ?, ?, ?, ?, ?)', f.issued, st, d, s.q?.[i] ?? null, s.lo?.[i] ?? null, s.hi?.[i] ?? null); n++;
        });
      }
    });
    return n;
  });
  // alturas: primero el archivo sin recorte, después el historial reciente (que prevalece)
  await once('heights', async () => {
    const a = await read('archive', 'heights.json'), h = await read('heights-history.json');
    if (!a && !h) return null;
    const rows = [];
    for (const src of [a, h]) if (src) for (const [k, ser] of Object.entries(JSON.parse(src))) for (const [d, v] of Object.entries(ser)) rows.push([k, d, v]);
    store.putHeights(rows); return rows.length;
  });
  // represas: el archivo sin recorte, y encima la serie de cada caché
  await once('dams', async () => {
    const a = await read('archive', 'dams.json');
    let n = 0;
    store.tx(() => {
      if (a) for (const [id, ser] of Object.entries(JSON.parse(a))) for (const [d, v] of Object.entries(ser)) {
        store.run('INSERT OR IGNORE INTO dam_series VALUES (?, ?, ?, ?, ?, ?)', id, d, v.outflow ?? null, v.inflow ?? null, v.spill ?? null, v.level_m ?? null); n++;
      }
    });
    return n;
  });
  for (const id of ['itaipu', 'yacyreta', 'saltogrande']) {
    await once(`dam-${id}.json`, async () => {
      const t = await read(`dam-${id}.json`); if (!t) return null;
      const { series = [], ...meta } = JSON.parse(t);
      store.putDam(id, meta, series); return series.length;
    });
  }
  await once('extras.json', async () => {
    const t = await read('extras.json'); if (!t) return null;
    const { history, dams, ...rest } = JSON.parse(t); // las series viven en sus tablas
    store.setDoc('extras', rest); return 1;
  });
  await once('climatology.json', async () => {
    const t = await read('climatology.json'); if (!t) return null;
    const c = JSON.parse(t);
    store.tx(() => { for (const [k, v] of Object.entries(c)) store.setDoc('clim:' + k, v); });
    return Object.keys(c).length;
  });
  await once('analytics.json', async () => {
    const t = await read('analytics.json'); if (!t) return null;
    const { days = {} } = JSON.parse(t);
    store.tx(() => { for (const [d, v] of Object.entries(days)) store.putAnalyticsDay(d, v); });
    return Object.keys(days).length;
  });
  await once('analytics-today.json', async () => {
    const t = await read('analytics-today.json'); if (!t) return null;
    store.setDoc('analytics-today', JSON.parse(t)); return 1;
  });
  await once('stats-key', async () => {
    const t = await read('stats-key'); if (!t) return null;
    store.setDoc('stats-key', t.trim()); return 1; // la clave de /stats sigue siendo la misma
  });
}
