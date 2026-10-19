// Capa de escuelas y centros de salud (public/servicios.json, ver scripts/build-servicios.mjs) con su altura
// estimada sobre el río. En cada fecha, el establecimiento queda "con inundación probable" si la subida del río
// en su estación de caudal supera esa altura; "posible" si le falta menos de un metro. Es una estimación.
const NEAR_M = 1;
export const KIND = { s: 'centro de salud', e: 'escuela' };

export function createServicios({ doc, parent, el, riseAt, nDays }) {
  const items = doc.items;
  const state = (it, day) => {
    const r = riseAt(it.st, day);
    return r == null || it.x ? 'na' : r >= it.h ? 'wet' : r >= it.h - NEAR_M ? 'near' : 'dry';
  };
  const nodes = items.map((it, i) => el('path', { class: `sv ${it.t} na`, 'data-i': i }, parent));
  const states = items.map(() => 'na');
  let selected = -1;

  // salud: cruz; escuela: cuadrado. (x, y) en píxeles de pantalla
  const shape = (it, x, y) => {
    x = x.toFixed(1); y = y.toFixed(1);
    return it.t === 's'
      ? `M${x},${y}m-1.6,-5.5h3.2v3.9h3.9v3.2h-3.9v3.9h-3.2v-3.9h-3.9v-3.2h3.9z`
      : `M${x},${y}m-4,-4h8v8h-8z`;
  };

  function update(day) {
    const c = { e: { wet: 0, near: 0, dry: 0, na: 0 }, s: { wet: 0, near: 0, dry: 0, na: 0 } }, wet = [];
    items.forEach((it, i) => {
      const s = (states[i] = state(it, day));
      c[it.t][s]++;
      if (s === 'wet') wet.push(i);
      nodes[i].setAttribute('class', `sv ${it.t} ${s}${i === selected ? ' sel' : ''}`);
    });
    return { c, wet };
  }
  // proj: { X(lon), Y(lat), W, H, show }
  function render({ X, Y, W, H, show }) {
    parent.style.display = show ? '' : 'none';
    if (!show) return;
    items.forEach((it, i) => {
      const x = X(it.c[0]), y = Y(it.c[1]);
      const vis = x > -12 && x < W + 12 && y > -12 && y < H + 12;
      nodes[i].style.display = vis ? '' : 'none';
      if (vis) nodes[i].setAttribute('d', shape(it, x, y));
    });
  }
  return {
    items, update, render, nodes,
    state: (i, day) => state(items[i], day),
    strip: (i) => Array.from({ length: nDays }, (_, day) => state(items[i], day)),
    setSel(i) { selected = i; nodes.forEach((n, k) => n.classList.toggle('sel', k === i)); if (i >= 0) parent.appendChild(nodes[i]); },
  };
}
