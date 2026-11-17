// Reportes de vecinos (anegamientos, calles cortadas, agua en viviendas) con confirmación de otros usuarios.
//
// Qué se guarda de cada reporte: hora, ubicación redondeada a unos 100 m, tipo, gravedad, una nota corta y un hash del
// dispositivo (IP + navegador + sal del día) que se usa solo para poner límites y contar dispositivos distintos. La IP no se
// guarda y la sal cambia todos los días, así que no se puede seguir a nadie de un día a otro.
//
// Defensas contra el abuso (ver README): captcha Cloudflare Turnstile (si hay claves), campo trampa, tiempo mínimo en el
// formulario, límite por IP y por dispositivo, sin enlaces en la nota, reportes repetidos que se funden en uno,
// vencimiento a las 48 h y moderación manual (ocultar, sin borrar).
import { createHash, randomBytes } from 'node:crypto';

export const KINDS = { calle: 'Calle anegada', casas: 'Agua en viviendas', ruta: 'Ruta o camino cortado', rio: 'Río desbordado' };
const BOX = { w: -72.5, e: -40, s: -42, n: -10 }; // la misma zona que cubre el mapa
const TTL = 48 * 3600e3;       // cuánto dura un reporte sin confirmaciones
const EXTEND = 24 * 3600e3;    // cada "sigue así" lo mantiene vivo un día más...
const MAX_LIFE = 96 * 3600e3;  // ...hasta un máximo de 4 días desde que se hizo
const MAX_PER_DEVICE_DAY = 8;
const MIN_FORM_MS = 2500;      // un humano tarda más que esto en completar el formulario
const NOTE_MAX = 140;
const LINK = /(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|ar|io|ly|me|xyz|top|ru|cn)\b)/i;
const dayAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
const fail = (status, error) => ({ status, body: { error } });
const r3 = (v) => Math.round(v * 1000) / 1000;

export function createReports({ store, log, turnstile = {} }) {
  const { site = null, secret = null } = turnstile;
  if (!secret) log('reportes: sin TURNSTILE_SECRET_KEY, no se verifica captcha (solo límites y trampas)');

  // sal del día para el hash de dispositivo
  let salt = store.getDoc('reports-salt') ?? { day: null, salt: null };
  const device = (ip, ua) => {
    const d = dayAR();
    if (salt.day !== d) { salt = { day: d, salt: randomBytes(16).toString('hex') }; store.setDoc('reports-salt', salt); }
    return createHash('sha256').update(`${salt.salt}|${ip}|${ua}`).digest('base64url').slice(0, 16);
  };

  async function captchaOk(token, ip) {
    if (!secret) return { ok: true };
    if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, status: 403, error: 'No se pudo verificar que sos una persona. Probá de nuevo.' };
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(8000) });
      return (await res.json()).success ? { ok: true } : { ok: false, status: 403, error: 'No se pudo verificar que sos una persona. Probá de nuevo.' };
    } catch (e) {
      log('turnstile:', e.message);
      return { ok: false, status: 503, error: 'No se pudo verificar ahora mismo. Probá de nuevo en un minuto.' };
    }
  }

  async function create({ ip, ua }, b) {
    if (b.hp) return { status: 204 }; // campo trampa: los bots lo completan; se les responde como si hubiera salido bien
    const lat = Number(b.lat), lon = Number(b.lon);
    if (![lat, lon].every(Number.isFinite) || lon < BOX.w || lon > BOX.e || lat < BOX.s || lat > BOX.n) return fail(400, 'La ubicación queda fuera de la zona del mapa.');
    if (typeof b.kind !== 'string' || !Object.hasOwn(KINDS, b.kind)) return fail(400, 'Elegí qué está pasando.');
    const sev = Number(b.sev);
    if (![1, 2, 3].includes(sev)) return fail(400, 'Elegí cuánta agua hay.');
    const note = String(b.note ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
    if (LINK.test(note)) return fail(400, 'La nota no puede llevar enlaces.');
    // "�" aparece cuando el texto llegó mal codificado: mejor pedir que lo reescriban que guardar letras rotas
    if (note.includes('�')) return fail(400, 'La nota tiene caracteres que no se pudieron leer. Probá escribirla de nuevo.');
    if (!(Number(b.ms) >= MIN_FORM_MS)) return fail(400, 'Esperá un instante y volvé a enviar.');
    const cap = await captchaOk(b.cf, ip);
    if (!cap.ok) return fail(cap.status, cap.error);

    const rhash = device(ip, ua), now = Date.now();
    if (store.get('SELECT COUNT(*) n FROM reports WHERE rhash = ?', rhash).n >= MAX_PER_DEVICE_DAY) return fail(429, 'Hiciste muchos reportes hoy. Probá mañana.');
    // el mismo dispositivo repite el mismo reporte en el mismo lugar: es uno solo (se renueva su vencimiento)
    const la = r3(lat), lo = r3(lon);
    const dup = store.get('SELECT id FROM reports WHERE rhash = ? AND kind = ? AND lat = ? AND lon = ? AND created > ? AND hidden = 0', rhash, b.kind, la, lo, now - 2 * 3600e3);
    if (dup) { store.run('UPDATE reports SET expires = MAX(expires, ?) WHERE id = ?', now + TTL, dup.id); return { status: 200, body: { id: dup.id, dup: true } }; }
    const r = store.run('INSERT INTO reports (created, expires, lat, lon, kind, sev, note, rhash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', now, now + TTL, la, lo, b.kind, sev, note, rhash);
    return { status: 201, body: { id: Number(r.lastInsertRowid) } };
  }

  const SELECT = `SELECT r.id, r.created, r.expires, r.lat, r.lon, r.kind, r.sev, r.note, r.hidden,
    (SELECT COUNT(*) FROM report_votes v WHERE v.report_id = r.id AND v.v = 'sigue') up,
    (SELECT COUNT(*) FROM report_votes v WHERE v.report_id = r.id AND v.v = 'bajo') dn FROM reports r`;
  const shape = (r) => ({ id: r.id, t: r.created, x: r.expires, lat: r.lat, lon: r.lon, k: r.kind, s: r.sev, n: r.note, up: r.up, dn: r.dn, ...(r.hidden ? { h: 1 } : {}) });
  // dos o más usuarios dicen "ya bajó" (y son más que los que dicen "sigue"): el reporte deja de mostrarse
  const resolved = (r) => r.dn >= 2 && r.dn > r.up;

  // mapa público: los reportes vigentes que nadie ocultó ni dio por resueltos
  const publicList = () => store.all(`${SELECT} WHERE r.hidden = 0 AND r.expires > ? ORDER BY r.created DESC LIMIT 3000`, Date.now()).filter((r) => !resolved(r)).map(shape);

  async function vote({ ip, ua }, id, b) {
    if (b.v !== 'sigue' && b.v !== 'bajo') return fail(400, 'Voto inválido.');
    const cap = await captchaOk(b.cf, ip);
    if (!cap.ok) return fail(cap.status, cap.error);
    const now = Date.now();
    const r = store.get('SELECT id, created, expires FROM reports WHERE id = ? AND hidden = 0 AND expires > ?', id, now);
    if (!r) return fail(404, 'Ese reporte ya no está.');
    store.tx(() => {
      store.run('INSERT OR REPLACE INTO report_votes (report_id, rhash, v, at) VALUES (?, ?, ?, ?)', id, device(ip, ua), b.v, now);
      if (b.v === 'sigue') store.run('UPDATE reports SET expires = MIN(created + ?, MAX(expires, ?)) WHERE id = ?', MAX_LIFE, now + EXTEND, id);
    });
    const u = store.get(`${SELECT} WHERE r.id = ?`, id);
    return { status: 200, body: { up: u.up, dn: u.dn, gone: resolved(u) } };
  }

  // herramienta de análisis: todo el período (vigente o vencido); los ocultos solo los ve el administrador
  const analysisList = (days, withHidden) => store.all(`${SELECT} WHERE r.created > ? ${withHidden ? '' : 'AND r.hidden = 0'} ORDER BY r.created DESC LIMIT 20000`, Date.now() - days * 864e5).map(shape);
  const moderate = (id, hide) => store.run('UPDATE reports SET hidden = ?, hidden_at = ? WHERE id = ?', hide ? 1 : 0, hide ? Date.now() : null, id).changes > 0;
  const config = () => ({ captcha: site });

  return { create, vote, publicList, analysisList, moderate, config };
}
