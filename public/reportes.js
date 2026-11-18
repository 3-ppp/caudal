// Capa de reportes de vecinos: marcadores sobre la capa vectorial del mapa. La usan el mapa público y la herramienta de análisis.
// Cada tipo tiene color y forma propios (la forma ayuda a quien no distingue colores); el tamaño crece con la gravedad.
export const KIND = {
  calle: { n: 'Calle anegada', c: '#3b82f6' },
  casas: { n: 'Agua en viviendas', c: '#ef4444' },
  ruta: { n: 'Ruta o camino cortado', c: '#f59e0b' },
  rio: { n: 'Río desbordado', c: '#14b8a6' },
};
export const SEV = { 1: 'poca agua (hasta el tobillo)', 2: 'agua media (hasta la rodilla)', 3: 'mucha agua (no se puede pasar)' };
export const SEV_SHORT = { 1: 'poca', 2: 'media', 3: 'mucha' };

// las últimas 24 h antes de vencer, el marcador pasa a gris y se va apagando; un "sigue así" lo renueva
export const FADE_MS = 24 * 3600e3;
export function vigencia(r, now = Date.now()) {
  const rem = r.x - now;
  if (rem <= 0) return { k: 'gone', t: 'vencido' };
  if (rem < FADE_MS) return { k: 'fade', t: `por vencer · se retira en ${Math.max(1, Math.ceil(rem / 3600e3))} h` };
  return { k: 'live', t: 'vigente' };
}

export const ago = (ms, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - ms) / 60e3));
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
};

// forma de cada tipo, centrada en (x, y) y de radio r
const SHAPE = {
  calle: (x, y, r) => `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`,
  casas: (x, y, r) => `M${x - r},${y - r}h${2 * r}v${2 * r}h${-2 * r}Z`,
  ruta: (x, y, r) => `M${x},${y - r * 1.1}L${x + r * 1.1},${y + r * 0.9}L${x - r * 1.1},${y + r * 0.9}Z`,
  rio: (x, y, r) => `M${x},${y - r * 1.2}L${x + r * 1.2},${y}L${x},${y + r * 1.2}L${x - r * 1.2},${y}Z`,
};

export function createReportLayer({ parent, el }) {
  let items = [], nodes = [], sel = -1, now = Date.now();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  return {
    get items() { return items; },
    setItems(list, serverNow = Date.now()) {
      now = serverNow;
      items = list.filter((r) => Object.hasOwn(KIND, r.k)); // ignora tipos desconocidos: un dato raro no debe romper el mapa
      for (const n of nodes) n.remove();
      nodes = items.map((r, i) => el('path', { class: `rp k-${r.k}${r.h ? ' hid' : ''}`, 'data-i': i }, parent));
      sel = -1;
    },
    setSel(id) {
      sel = items.findIndex((r) => r.id === id);
      nodes.forEach((n, i) => { n.classList.toggle('sel', i === sel); });
      if (sel >= 0) parent.appendChild(nodes[sel]); // al frente
    },
    // X(lon), Y(lat): proyección del mapa; z: zoom (de lejos los marcadores se achican)
    render({ X, Y, W, H, z }) {
      const k = 0.55 + 0.45 * clamp((z - 6) / 5, 0, 1);
      items.forEach((r, i) => {
        const x = X(r.lon), y = Y(r.lat), n = nodes[i];
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) { n.style.display = 'none'; return; }
        n.style.display = '';
        n.setAttribute('d', SHAPE[r.k](+x.toFixed(1), +y.toFixed(1), (5 + 2.5 * r.s) * k));
        const rem = r.x - now, fading = rem < FADE_MS;
        n.classList.toggle('fade', fading);
        n.style.opacity = fading ? Math.max(0.3, 0.3 + 0.7 * Math.max(rem, 0) / FADE_MS) : 1;
      });
    },
    // el marcador más cercano al punto (px, py) dentro de `rad` píxeles
    hit(px, py, { X, Y }, rad = 16) {
      let best = -1, bd = rad * rad;
      items.forEach((r, i) => {
        if (nodes[i].style.display === 'none') return;
        const dx = X(r.lon) - px, dy = Y(r.lat) - py, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    },
    // cuántos otros reportes hay a menos de `meters` en las últimas `hours` horas
    nearby(r, meters = 300, hours = 24) {
      const cos = Math.cos(r.lat * Math.PI / 180);
      return items.filter((o) => o !== r && now - o.t < hours * 3600e3
        && Math.hypot((o.lon - r.lon) * cos * 111320, (o.lat - r.lat) * 110540) < meters).length;
    },
  };
}
