// Accesos a la herramienta de análisis (capas, reportes completos, moderación).
//   admin      la clave de /stats (se genera sola la primera vez): puede moderar y crear accesos
//   autoridad  un acceso de solo lectura que el administrador crea y puede revocar (p. ej. para Defensa Civil de un municipio)
// De los accesos solo se guarda el hash SHA-256: el código se muestra una única vez al crearlo.
import { createHash, randomBytes } from 'node:crypto';

const sha = (t) => createHash('sha256').update(t).digest('hex');

export function createAccess({ store, isAdminKey }) {
  const lastTouch = new Map(); // id → ms: "último uso" se anota como mucho cada 10 min
  return {
    // devuelve 'admin', 'autoridad' o null
    roleOf(token) {
      if (!token || typeof token !== 'string' || token.length > 200) return null;
      if (isAdminKey(token)) return 'admin';
      const row = store.get('SELECT id, role FROM access_tokens WHERE hash = ? AND revoked IS NULL', sha(token));
      if (!row) return null;
      const now = Date.now();
      if (now - (lastTouch.get(row.id) ?? 0) > 600e3) { lastTouch.set(row.id, now); store.run('UPDATE access_tokens SET last_used = ? WHERE id = ?', now, row.id); }
      return row.role;
    },
    create(label) {
      const token = randomBytes(24).toString('base64url');
      const r = store.run('INSERT INTO access_tokens (hash, label, role, created) VALUES (?, ?, ?, ?)', sha(token), String(label || 'sin nombre').slice(0, 80), 'autoridad', Date.now());
      return { id: Number(r.lastInsertRowid), token };
    },
    list: () => store.all('SELECT id, label, role, created, revoked, last_used FROM access_tokens ORDER BY id DESC'),
    revoke: (id) => store.run('UPDATE access_tokens SET revoked = ? WHERE id = ? AND revoked IS NULL', Date.now(), id).changes > 0,
  };
}
