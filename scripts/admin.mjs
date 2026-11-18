// Administración desde el servidor, sobre la base de datos (data/caudal.db o $DATA_DIR/caudal.db).
// Hay que correrlo como el usuario del servicio (la base es solo suya):
//   sudo -u caudal DATA_DIR=/opt/caudal/data /opt/node/bin/node /opt/caudal/app/scripts/admin.mjs <comando>
//
// Es también el acceso de emergencia: si perdés la contraseña de administración, desde acá se resetea o se crea otro usuario.
//
//   usuarios                       lista los usuarios del panel
//   crear-usuario <nombre> <rol>   crea un usuario (rol: admin o autoridad) con una contraseña temporal, que se muestra una vez
//   resetear-clave <nombre>        genera una contraseña temporal nueva y cierra sus sesiones
//   desactivar <nombre>            el usuario deja de poder entrar (y se cierran sus sesiones)
//   activar <nombre>
//   reportes [n]                   los últimos n reportes (20 por defecto), con los ocultos
//   ocultar <id>                   oculta un reporte del mapa (queda guardado)
//   mostrar <id>                   lo vuelve a mostrar
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../db.mjs';
import { createAccess } from '../access.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = openStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
const access = createAccess({ store });
const [cmd, arg, arg2] = process.argv.slice(2);
const f = (ms) => (ms ? new Date(ms).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—');
const userId = (name) => store.get('SELECT id FROM users WHERE username = ?', String(name || '').toLowerCase())?.id;
const fail = (msg) => { console.error(msg); store.close(); process.exit(1); };

switch (cmd) {
  case 'usuarios':
    for (const u of access.listUsers()) console.log(`#${u.id} ${u.usuario} · ${u.rol}${u.desactivado ? ' · DESACTIVADO' : ''}${u.claveTemporal ? ' · contraseña temporal' : ''} · último ingreso ${f(u.ultimoIngreso)}`);
    if (!access.hasUsers()) console.log('(todavía no hay usuarios: creá el primero con crear-usuario <nombre> admin)');
    break;
  case 'crear-usuario': {
    const r = await access.createUser(arg, arg2);
    if (!r.ok) fail(r.error);
    console.log(`Usuario creado: ${r.usuario} (${r.rol})\nContraseña temporal: ${r.clave}\nSe muestra una sola vez; al entrar por primera vez el panel pide cambiarla.`);
    break;
  }
  case 'resetear-clave': {
    const id = userId(arg);
    if (!id) fail('No existe ese usuario.');
    const r = await access.resetPassword(id);
    console.log(`Contraseña temporal de ${r.usuario}: ${r.clave}\nSe muestra una sola vez; se cerraron sus sesiones y tendrá que cambiarla al entrar.`);
    break;
  }
  case 'desactivar': case 'activar': {
    const id = userId(arg);
    if (!id) fail('No existe ese usuario.');
    const r = access.setDisabled(id, cmd === 'desactivar');
    if (!r.ok) fail(r.error);
    console.log(`${arg}: ${cmd === 'desactivar' ? 'desactivado' : 'activado'}`);
    break;
  }
  case 'reportes':
    for (const r of store.all('SELECT id, created, expires, lat, lon, kind, sev, note, hidden FROM reports ORDER BY id DESC LIMIT ?', Math.min(+arg || 20, 500)))
      console.log(`#${r.id} ${f(r.created)} ${r.kind} gravedad ${r.sev} (${r.lat}, ${r.lon})${r.hidden ? ' [OCULTO]' : r.expires < Date.now() ? ' [vencido]' : ''}${r.note ? ` — ${r.note}` : ''}`);
    break;
  case 'ocultar': case 'mostrar': {
    const id = +arg;
    if (!id) fail('Falta el id del reporte.');
    const n = store.run('UPDATE reports SET hidden = ?, hidden_at = ? WHERE id = ?', cmd === 'ocultar' ? 1 : 0, cmd === 'ocultar' ? Date.now() : null, id).changes;
    console.log(n ? `reporte #${id}: ${cmd === 'ocultar' ? 'oculto' : 'visible'} (el mapa lo refleja en unos segundos)` : 'no existe ese reporte');
    break;
  }
  default: console.error('Comandos: usuarios | crear-usuario <nombre> <admin|autoridad> | resetear-clave <nombre> | desactivar <nombre> | activar <nombre> | reportes [n] | ocultar <id> | mostrar <id>'); store.close(); process.exit(cmd ? 1 : 0);
}
store.close();
