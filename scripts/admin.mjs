// Administración desde el servidor, sobre la base de datos (data/caudal.db o $DATA_DIR/caudal.db).
// Hay que correrlo como el usuario del servicio (la base es solo suya):
//   sudo -u caudal DATA_DIR=/opt/caudal/data /opt/node/bin/node /opt/caudal/app/scripts/admin.mjs <comando>
//
//   clave                muestra la clave de administración (la de /stats y de la herramienta de análisis)
//   nueva-clave          genera una clave nueva y la muestra; hay que reiniciar el servicio para que rija
//   accesos              lista los accesos de autoridad (sin sus códigos: solo se guarda el hash)
//   reportes [n]         los últimos n reportes (20 por defecto), con los ocultos
//   ocultar <id>         oculta un reporte del mapa (queda guardado)
//   mostrar <id>         lo vuelve a mostrar
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = openStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
const [cmd, arg] = process.argv.slice(2);
const f = (ms) => (ms ? new Date(ms).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—');

switch (cmd) {
  case 'clave': console.log(store.getDoc('stats-key') ?? '(todavía no hay clave: se genera al arrancar el servicio)'); break;
  case 'nueva-clave': {
    const k = randomBytes(18).toString('base64url');
    store.setDoc('stats-key', k);
    console.log(k, '\nReiniciá el servicio para que la use.');
    break;
  }
  case 'accesos':
    for (const a of store.all('SELECT id, label, role, created, revoked, last_used FROM access_tokens ORDER BY id'))
      console.log(`#${a.id} ${a.label} · ${a.role} · creado ${f(a.created)}${a.last_used ? ` · usado ${f(a.last_used)}` : ''}${a.revoked ? ` · REVOCADO ${f(a.revoked)}` : ''}`);
    break;
  case 'reportes':
    for (const r of store.all('SELECT id, created, expires, lat, lon, kind, sev, note, hidden FROM reports ORDER BY id DESC LIMIT ?', Math.min(+arg || 20, 500)))
      console.log(`#${r.id} ${f(r.created)} ${r.kind} gravedad ${r.sev} (${r.lat}, ${r.lon})${r.hidden ? ' [OCULTO]' : r.expires < Date.now() ? ' [vencido]' : ''}${r.note ? ` — ${r.note}` : ''}`);
    break;
  case 'ocultar': case 'mostrar': {
    const id = +arg;
    if (!id) { console.error('Falta el id del reporte.'); process.exit(1); }
    const n = store.run('UPDATE reports SET hidden = ?, hidden_at = ? WHERE id = ?', cmd === 'ocultar' ? 1 : 0, cmd === 'ocultar' ? Date.now() : null, id).changes;
    console.log(n ? `reporte #${id}: ${cmd === 'ocultar' ? 'oculto' : 'visible'} (el mapa lo refleja en unos segundos)` : 'no existe ese reporte');
    break;
  }
  default: console.error('Comandos: clave | nueva-clave | accesos | reportes [n] | ocultar <id> | mostrar <id>'); process.exit(cmd ? 1 : 0);
}
store.close();
