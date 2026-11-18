// Usuarios y sesiones del panel de administración (/admin) y de la herramienta de análisis (/analisis).
//   admin      puede moderar reportes, usar las guardas contra el flood y administrar usuarios
//   autoridad  solo lectura (p. ej. Defensa Civil de un municipio); no ve los reportes ocultos
// Contraseñas: scrypt con sal propia (módulo crypto de Node), nunca en texto. Sesiones: cookie HttpOnly con un código al azar
// de 256 bits; en la base solo se guarda su hash SHA-256. Las cuentas se crean desde el servidor (scripts/admin.mjs) o por un
// administrador desde el panel; la contraseña inicial es temporal y se muestra una sola vez (hay que cambiarla al entrar).
import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 96 * 1024 * 1024;
const IDLE_MS = 12 * 3600e3;            // la sesión se cierra tras 12 h sin uso...
const ABSOLUTE_MS = 7 * 864e5;          // ...y de todos modos a los 7 días
const LOCK_AFTER = 5, LOCK_MS = 15 * 60e3; // 5 fallos con el mismo usuario desde la misma IP: 15 minutos de espera
export const MIN_PASSWORD = 12;
export const COOKIE = 'caudal_sid';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin letras ni números que se confunden

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p, maxmem: MAXMEM });
  return got.length === want.length && timingSafeEqual(got, want);
}
// contraseña temporal legible: 4 grupos de 4 caracteres (80 bits)
export const generatePassword = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')).join('-');
const validName = (u) => /^[a-z0-9._-]{3,32}$/.test(u);
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `La contraseña tiene que tener al menos ${MIN_PASSWORD} caracteres.`;
  if (password.length > 200) return 'La contraseña es demasiado larga.';
  if (new Set(password).size < 5) return 'La contraseña es demasiado simple.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'La contraseña no puede contener el nombre de usuario.';
  return null;
}

export function createAccess({ store, log = () => {} }) {
  const touch = new Map();       // id de sesión → ms: "último uso" se anota como mucho una vez por minuto
  const fails = new Map();       // "ip|usuario" → { n, until }
  let dummy = null;              // hash de mentira: el tiempo de respuesta no delata si el usuario existe
  const dummyHash = async () => (dummy ||= await hashPassword(randomBytes(12).toString('hex')));

  const cookieOf = (req) => {
    for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim(); }
    return null;
  };
  const publicUser = (u) => ({ id: u.id, usuario: u.username, rol: u.role, cambiar: !!u.must_change });

  // el usuario de la sesión de este pedido (o null)
  function fromRequest(req) {
    const token = cookieOf(req);
    if (!token || token.length > 100) return null;
    const row = store.get(`SELECT s.id sid, s.created, s.last_seen, u.id, u.username, u.role, u.must_change, u.disabled
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sha(token));
    const now = Date.now();
    if (!row) return null;
    if (row.disabled || now - row.last_seen > IDLE_MS || now - row.created > ABSOLUTE_MS) { store.run('DELETE FROM sessions WHERE id = ?', row.sid); return null; }
    if (now - (touch.get(row.sid) ?? 0) > 60e3) { touch.set(row.sid, now); store.run('UPDATE sessions SET last_seen = ? WHERE id = ?', now, row.sid); }
    return { ...row, token };
  }

  async function login(username, password, ip) {
    const name = String(username || '').trim().toLowerCase().slice(0, 64), key = `${ip}|${name}`, now = Date.now();
    const f = fails.get(key);
    if (f && f.n >= LOCK_AFTER && now < f.until) return { ok: false, status: 429, error: 'Demasiados intentos con este usuario. Probá en unos minutos.' };
    const user = store.get('SELECT * FROM users WHERE username = ?', name);
    const ok = await verifyPassword(String(password || '').slice(0, 300), user ? user.pass : await dummyHash());
    if (!user || !ok || user.disabled) {
      fails.set(key, { n: (f && now < f.until ? f.n : 0) + 1, until: now + LOCK_MS });
      return { ok: false, status: 401, error: 'Usuario o contraseña incorrectos.' };
    }
    fails.delete(key);
    const token = randomBytes(32).toString('base64url');
    store.run('INSERT INTO sessions (id, user_id, created, last_seen) VALUES (?, ?, ?, ?)', sha(token), user.id, now, now);
    store.run('UPDATE users SET last_login = ? WHERE id = ?', now, user.id);
    return { ok: true, token, user: publicUser(user), maxAge: Math.floor(ABSOLUTE_MS / 1000) };
  }
  const logout = (token) => { if (token) store.run('DELETE FROM sessions WHERE id = ?', sha(token)); };

  async function changePassword(session, current, next) {
    const user = store.get('SELECT * FROM users WHERE id = ?', session.id);
    if (!user || !(await verifyPassword(String(current || '').slice(0, 300), user.pass))) return { ok: false, status: 403, error: 'La contraseña actual no es correcta.' };
    const problem = passwordProblem(next, user.username);
    if (problem) return { ok: false, status: 400, error: problem };
    if (next === current) return { ok: false, status: 400, error: 'La contraseña nueva tiene que ser distinta de la actual.' };
    store.run('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?', await hashPassword(next), user.id);
    store.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, sha(session.token)); // se cierran las demás sesiones
    return { ok: true };
  }

  // ---------- administración de usuarios (la usa el panel y scripts/admin.mjs)
  async function createUser(username, role, password = null) {
    const name = String(username || '').trim().toLowerCase();
    if (!validName(name)) return { ok: false, status: 400, error: 'El usuario va de 3 a 32 caracteres: letras, números, punto, guion o guion bajo.' };
    if (role !== 'admin' && role !== 'autoridad') return { ok: false, status: 400, error: 'Rol inválido.' };
    if (store.get('SELECT id FROM users WHERE username = ?', name)) return { ok: false, status: 409, error: 'Ya existe ese usuario.' };
    const temp = password ?? generatePassword();
    const r = store.run('INSERT INTO users (username, pass, role, created, must_change) VALUES (?, ?, ?, ?, 1)', name, await hashPassword(temp), role, Date.now());
    return { ok: true, id: Number(r.lastInsertRowid), usuario: name, rol: role, clave: temp };
  }
  async function resetPassword(id) {
    const u = store.get('SELECT id, username FROM users WHERE id = ?', id);
    if (!u) return { ok: false, status: 404, error: 'No existe ese usuario.' };
    const temp = generatePassword();
    store.run('UPDATE users SET pass = ?, must_change = 1 WHERE id = ?', await hashPassword(temp), id);
    store.run('DELETE FROM sessions WHERE user_id = ?', id);
    return { ok: true, usuario: u.username, clave: temp };
  }
  function setDisabled(id, disabled) {
    const u = store.get('SELECT id, role FROM users WHERE id = ?', id);
    if (!u) return { ok: false, status: 404, error: 'No existe ese usuario.' };
    if (disabled && u.role === 'admin' && store.get("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", id).n === 0) return { ok: false, status: 400, error: 'Tiene que quedar al menos un administrador activo.' };
    store.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
    if (disabled) store.run('DELETE FROM sessions WHERE user_id = ?', id);
    return { ok: true };
  }
  const listUsers = () => store.all('SELECT id, username, role, created, last_login, disabled, must_change FROM users ORDER BY id')
    .map((u) => ({ id: u.id, usuario: u.username, rol: u.role, creado: u.created, ultimoIngreso: u.last_login, desactivado: !!u.disabled, claveTemporal: !!u.must_change }));
  const hasUsers = () => store.get('SELECT COUNT(*) n FROM users').n > 0;

  // sesiones vencidas y contadores de fallos viejos, fuera de la base y de la memoria
  setInterval(() => {
    const now = Date.now();
    store.run('DELETE FROM sessions WHERE last_seen < ? OR created < ?', now - IDLE_MS, now - ABSOLUTE_MS);
    for (const [k, f] of fails) if (now > f.until) fails.delete(k);
  }, 600e3).unref();

  return { fromRequest, login, logout, changePassword, createUser, resetPassword, setDisabled, listUsers, hasUsers, publicUser, cookieOf };
}
