// Contexto del mapa público: localidades, ríos y sus medidores (boyas del INA y escalas de Prefectura). Solo se dibujan; los
// reportes de vecinos siguen siendo lo central. Los datos de las capas más completas (barrios, rutas, represas) siguen en la
// herramienta de análisis.
const nf1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const titulo = (t) => t.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ciudades vecinas de las otras orillas (población aproximada, solo para ordenar)
const VECINAS = [
  ['Asunción', 'Paraguay', -57.576, -25.264, 520000], ['Ciudad del Este', 'Paraguay', -54.611, -25.510, 300000], ['Foz do Iguaçu', 'Brasil', -54.585, -25.516, 260000],
  ['Encarnación', 'Paraguay', -55.867, -27.331, 130000], ['Uruguaiana', 'Brasil', -57.088, -29.755, 125000], ['Salto', 'Uruguay', -57.967, -31.383, 105000],
  ['Paysandú', 'Uruguay', -58.076, -32.321, 76000], ['Concepción', 'Paraguay', -57.434, -23.406, 75000], ['Villa Hayes', 'Paraguay', -57.525, -25.091, 65000],
  ['São Borja', 'Brasil', -56.004, -28.660, 60000], ['Mercedes', 'Uruguay', -58.031, -33.252, 42000], ['Itaqui', 'Brasil', -56.553, -29.125, 38000],
  ['Pilar', 'Paraguay', -58.305, -26.859, 35000], ['Fray Bentos', 'Uruguay', -58.300, -33.117, 25000], ['Ayolas', 'Paraguay', -56.883, -27.383, 15000],
  ['Bella Unión', 'Uruguay', -57.598, -30.259, 12000], ['Nueva Palmira', 'Uruguay', -58.418, -33.877, 9000],
];
// criterio: cuanto más cerca el zoom, más chica la población mínima
const locMin = (z) => (z < 6.5 ? 150e3 : z < 7.5 ? 50e3 : z < 8.5 ? 20e3 : z < 9.5 ? 8e3 : z < 10.5 ? 3e3 : z < 11.5 ? 1e3 : 0);

export function createContext({ parent, el, data, extras, geo, cauDoc, pDoc, locDoc }) {
  const gLoc = el('g', {}, parent), gRiv = el('g', {}, parent), gPts = el('g', {}, parent);

  // ---------- localidades
  const LOC = [...(locDoc?.localidades ?? []).map((m) => ({ n: m.n, p: m.p, lon: m.c[0], lat: m.c[1], pob: m.pob })),
    ...VECINAS.map(([n, p, lon, lat, pob]) => ({ n, p, lon, lat, pob }))].sort((a, b) => b.pob - a.pob);
  for (const l of LOC) l.nm = norm(l.n);
  const locNodes = [];
  // si el punto del monitor ya lleva el nombre de la ciudad, no se repite el rótulo de la localidad
  function renderLoc({ X, Y, W, H, z }, skip) {
    const min = locMin(z), boxes = [];
    let k = 0;
    for (const m of LOC) {
      if (m.pob < min) break; // ordenadas por población
      if (skip?.has(m.nm)) continue;
      const x = X(m.lon), y = Y(m.lat);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const w = m.n.length * 6.3 + 12, box = [x - 4, y - 8, x + w, y + 6];
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue; // se pisa con una más grande
      boxes.push(box);
      if (k >= 160) break;
      let o = locNodes[k];
      if (!o) o = locNodes[k] = { c: el('circle', { r: 2.2, class: 'loc-pt' }, gLoc), t: el('text', { dy: 3.5 }, gLoc) };
      o.c.style.display = ''; o.t.style.display = '';
      o.c.setAttribute('cx', x.toFixed(1)); o.c.setAttribute('cy', y.toFixed(1));
      o.t.setAttribute('x', (x + 5).toFixed(1)); o.t.setAttribute('y', y.toFixed(1));
      if (o.t.textContent !== m.n) o.t.textContent = m.n;
      k++;
    }
    for (; k < locNodes.length; k++) locNodes[k].c.style.display = locNodes[k].t.style.display = 'none';
  }
  // búsqueda por nombre (sin tildes ni mayúsculas): primero las que empiezan igual, después las que lo contienen; las más pobladas primero
  function searchLoc(text, max = 6) {
    const t = norm(text).trim();
    if (t.length < 2) return [];
    const starts = [], has = [];
    for (const l of LOC) { if (l.nm.startsWith(t)) starts.push(l); else if (l.nm.includes(t)) has.push(l); }
    return [...starts, ...has].slice(0, max);
  }

  // ---------- ríos: trazas de los grandes, de los afluentes y de los ríos menores
  const CAUCES = cauDoc?.cauces ?? [];
  const rivPaths = Object.values(geo.stems).map((st) => ({ c: st.c, n: el('path', { class: 'riv' }, gRiv) }));
  for (const c of CAUCES) rivPaths.push({ c: c.c, n: el('path', { class: 'riv cau' }, gRiv) });
  for (const [id, t] of Object.entries(geo.tribs || {})) rivPaths.push({ c: t.c, n: el('path', { class: id === 'pilcomayo' ? 'riv obs' : 'riv' }, gRiv) });

  // ---------- medidores: escalas de Prefectura (su ubicación sale de puertos.json) y boyas del INA (traen la suya), con la lectura de hoy
  const PUERTO = Object.fromEntries((pDoc?.puertos ?? []).map((p) => [`${p.port}|${p.river}`, p]));
  const GAUGES = (extras.heights?.stations ?? []).map((r) => {
    const p = r.lat == null ? PUERTO[`${r.port}|${r.river}`] : null;
    return p ? { ...r, lat: p.lat, lon: p.lon, alert_m: r.alert_m ?? p.alert ?? null, evac_m: r.evac_m ?? p.evac ?? null, pna: true } : r;
  }).filter((r) => r.lat != null && r.lon != null && r.height_m != null);
  const gdNodes = GAUGES.map((r, i) => el('circle', { class: 'gd' + (r.pna || r.grp === 'pna' ? ' pna' : ''), r: 4.5, 'data-i': i }, gPts));
  // puntos de caudal del monitor, con su nombre
  const stPts = (data?.stations ?? []).filter((s) => s.kind === 'main' || s.id === 'bermejo' || s.id === 'paraguay').map((s) => ({
    s, dot: el('circle', { class: 'st-pt', r: 3.5 }, gPts), txt: el('text', { dy: -7, 'text-anchor': 'middle' }, gPts),
  }));
  for (const p of stPts) p.txt.textContent = p.s.name;
  const stNames = new Set(stPts.map((p) => norm(p.s.name)));

  function render({ X, Y, W, H, z, loc = true, riv = true }) {
    gLoc.style.display = loc ? '' : 'none';
    if (loc) renderLoc({ X, Y, W, H, z }, riv ? stNames : null);
    // la traza de los ríos es esquemática: de cerca la imagen satelital muestra el río real y la línea desentona
    gRiv.style.display = riv && z < 9.5 ? '' : 'none';
    gPts.style.display = riv ? '' : 'none';
    if (!riv) return;
    if (z < 9.5) for (const r of rivPaths) r.n.setAttribute('d', r.c.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(''));
    GAUGES.forEach((r, i) => {
      const x = X(r.lon), y = Y(r.lat), vis = x > -10 && x < W + 10 && y > -10 && y < H + 10 && (z >= 7 || !(r.pna || r.grp === 'pna'));
      gdNodes[i].style.display = vis ? '' : 'none';
      if (vis) { gdNodes[i].setAttribute('cx', x.toFixed(1)); gdNodes[i].setAttribute('cy', y.toFixed(1)); }
    });
    for (const p of stPts) {
      const x = X(p.s.lon), y = Y(p.s.lat), vis = x > -60 && x < W + 60 && y > -20 && y < H + 20;
      p.dot.style.display = p.txt.style.display = vis ? '' : 'none';
      if (vis) { p.dot.setAttribute('cx', x.toFixed(1)); p.dot.setAttribute('cy', y.toFixed(1)); p.txt.setAttribute('x', x.toFixed(1)); p.txt.setAttribute('y', y.toFixed(1)); }
    }
  }
  // el medidor visible más cercano a (px, py) dentro de `rad` píxeles (con el dedo no se acierta a un punto de 9 px)
  function hitGauge(px, py, { X, Y }, rad = 14) {
    let best = -1, bd = rad * rad;
    GAUGES.forEach((r, i) => {
      if (gdNodes[i].style.display === 'none' || gPts.style.display === 'none') return;
      const dx = X(r.lon) - px, dy = Y(r.lat) - py, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  const gaugeName = (r) => (r.port.startsWith(r.river) ? titulo(r.port) : `${titulo(r.river)} · ${titulo(r.port)}`);
  // texto del medidor (para el tooltip y la ficha)
  function gaugeHtml(i) {
    const r = GAUGES[i];
    return `<b>${esc(gaugeName(r))}</b><br>Altura <b>${nf1.format(r.height_m)} m</b>${r.state ? ' · ' + esc(r.state.toLowerCase()) : ''}<br>` +
      (r.alert_m != null ? `<div class="row"><span>Alerta / evacuación</span><span>${nf1.format(r.alert_m)} / ${r.evac_m != null ? nf1.format(r.evac_m) : '—'} m</span></div>` : '') +
      `<span class="muted">${esc(r.date)}${r.time ? ' ' + esc(r.time) : ''} · ${r.pna || r.grp === 'pna' ? 'escala de Prefectura, vía INA' : 'medición del INA'}${r.alert_m == null ? ', sin nivel de alerta' : ''}</span>`;
  }
  return { render, hitGauge, gaugeHtml, searchLoc, gaugeCount: GAUGES.length };
}
