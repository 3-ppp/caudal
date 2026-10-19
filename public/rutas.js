// Capa de rutas: los tramos de rutas nacionales que Vialidad Nacional informa con corte o restricción, ubicados
// sobre la traza de la ruta por el servidor (sources/vialidad.mjs y vialidad-geo.mjs). Solo se dibuja lo que informa
// Vialidad; no hay estimación propia. La ubicación es aproximada: la planilla de Vialidad nombra los tramos por
// localidades y no trae geometría.
export const CLS = { 'CORTE TOTAL': 'total', 'CORTE PARCIAL': 'parcial', 'RESTRINGIDA': 'restr' };
export const TXT = { 'CORTE TOTAL': 'corte total', 'CORTE PARCIAL': 'corte parcial', 'RESTRINGIDA': 'restringida' };

export function createRutas({ alertas, parent, el }) {
  const items = alertas.filter((a) => a.geom && a.geom.length >= 4);
  const casing = el('path', { class: 'rt-case' }, parent);
  const paths = { restr: el('path', { class: 'rt restr' }, parent), parcial: el('path', { class: 'rt parcial' }, parent), total: el('path', { class: 'rt total' }, parent) };
  const selPath = el('path', { class: 'rt sel' }, parent);
  const bb = items.map((a) => {
    const b = [1e9, 1e9, -1e9, -1e9];
    for (let i = 0; i < a.geom.length; i += 2) { b[0] = Math.min(b[0], a.geom[i]); b[2] = Math.max(b[2], a.geom[i]); b[1] = Math.min(b[1], a.geom[i + 1]); b[3] = Math.max(b[3], a.geom[i + 1]); }
    return b;
  });
  let selected = -1;
  const d = (a, X, Y) => {
    let s = '';
    for (let i = 0; i < a.geom.length; i += 2) s += `${i ? 'L' : 'M'}${X(a.geom[i]).toFixed(1)},${Y(a.geom[i + 1]).toFixed(1)}`;
    return s;
  };
  // proj: { X(lon), Y(lat), W, H }
  function render({ X, Y, W, H }) {
    const acc = { restr: '', parcial: '', total: '' };
    items.forEach((a, i) => {
      const b = bb[i];
      if (X(b[2]) < -20 || X(b[0]) > W + 20 || Y(b[1]) < -20 || Y(b[3]) > H + 20) return;
      acc[CLS[a.estado] || 'restr'] += d(a, X, Y);
    });
    for (const k of Object.keys(acc)) paths[k].setAttribute('d', acc[k]);
    casing.setAttribute('d', acc.restr + acc.parcial + acc.total);
    selPath.setAttribute('d', selected >= 0 ? d(items[selected], X, Y) : '');
  }
  // tramo más cercano al punto (px) de la pantalla, a menos de `tol` píxeles
  function hit(mx, my, { X, Y }, tol = 10) {
    let best = -1, bd = tol * tol;
    items.forEach((a, i) => {
      const b = bb[i];
      if (mx < X(b[0]) - tol || mx > X(b[2]) + tol || my < Y(b[3]) - tol || my > Y(b[1]) + tol) return;
      for (let k = 0; k + 3 < a.geom.length; k += 2) {
        const x0 = X(a.geom[k]), y0 = Y(a.geom[k + 1]), x1 = X(a.geom[k + 2]), y1 = Y(a.geom[k + 3]);
        const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-9;
        const u = Math.max(0, Math.min(1, ((mx - x0) * dx + (my - y0) * dy) / l2));
        const dd = (mx - x0 - u * dx) ** 2 + (my - y0 - u * dy) ** 2;
        if (dd < bd) { bd = dd; best = i; }
      }
    });
    return best;
  }
  return {
    render, hit, items, bbox: (i) => bb[i], info: (i) => items[i],
    index: (alerta) => items.indexOf(alerta),
    setSel(i) { selected = i; },
  };
}
