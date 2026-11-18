// Localidad más cercana a un punto (gobiernos locales de las provincias del mapa, de layers/municipios.json).
// La usan los avisos de Telegram y el panel de administración ("cerca de Goya (Corrientes)").
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function createLocalidades(root) {
  let LOC = [];
  try { LOC = JSON.parse(readFileSync(path.join(root, 'layers', 'municipios.json'), 'utf8')).municipios.filter((m) => m.c).map((m) => ({ n: m.n, p: m.p, lon: m.c[0], lat: m.c[1] })); } catch {}
  // hasta maxKm de distancia; si no hay ninguna, null
  function nearest(lat, lon, maxKm = 30) {
    const cos = Math.cos(lat * Math.PI / 180);
    let best = null, bd = maxKm;
    for (const m of LOC) { const d = Math.hypot((m.lon - lon) * cos * 111.32, (m.lat - lat) * 110.54); if (d < bd) { bd = d; best = m; } }
    return best ? { n: best.n, p: best.p, text: `${best.n} (${best.p})` } : null;
  }
  return { nearest };
}
