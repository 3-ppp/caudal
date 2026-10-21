// Paraná — interfaz. Sin dependencias.
const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);

// El prompt y el título muestran el nombre del sitio donde corre (no queda fijo en el código);
// en una copia local, "caudal".
const SITE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || !location.hostname ? 'caudal' : location.hostname;
document.title = `:~# ${SITE}`;
$('#site-host').textContent = `:~# ${SITE}`;
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const nf = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fmtQ = (q) => (q == null ? '—' : nf.format(q >= 1000 ? Math.round(q / 10) * 10 : Math.round(q)));
const parseDay = (iso) => new Date(iso + 'T12:00:00');
const dLong = (iso) => parseDay(iso).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dShort = (iso) => parseDay(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace('.', '');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, f) => a + (b - a) * f;

const [data, geo] = await Promise.all([
  fetch('/api/data').then((r) => { if (!r.ok) throw new Error('sin datos'); return r.json(); }),
  fetch('geo.json').then((r) => r.json()),
]).catch((e) => {
  document.querySelector('.dash').insertAdjacentHTML('afterbegin',
    `<p class="card">Los datos todavía se están descargando. Probá de nuevo en un minuto.</p>`);
  throw e;
});

const extras = await fetch('/api/extras').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const days = data.days;
// "hoy" es la fecha de Argentina, no la UTC (a las 21 h ya sería mañana)
const TODAY_AR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
let todayIdx = days.findLastIndex((d) => d <= TODAY_AR);
if (todayIdx < 0) todayIdx = 0;
const main = data.stations.filter((s) => s.kind === 'main').sort((a, b) => a.km - b.km);
const tribs = data.stations.filter((s) => s.kind === 'trib');
// Ríos con cauce propio en el tablero; cada punto principal pertenece a uno
const RIVER_NAMES = { parana: 'Paraná', uruguay: 'Uruguay' };
const riverOf = (st) => st.river || 'parana';
const RIV = Object.fromEntries(Object.keys(RIVER_NAMES).map((r) => [r, main.filter((s) => riverOf(s) === r)]));
let PR = 'parana'; // río del perfil
const byId = Object.fromEntries(data.stations.map((s) => [s.id, s]));
const TRIB_KM = { bermejo: -45 }; // desfase respecto de los 25 km por defecto, para que sus marcas no se pisen
for (const t of tribs) t.km = byId[t.joins].km + 25 + (TRIB_KM[t.id] ?? 0); // desembocan apenas aguas abajo del punto de referencia

// ---------- anomalía: 0 = mediana para la fecha, ±1 = percentil 90 / 10
function score(st, t) {
  const q = st.q[t], p10 = st.clim.p10[t], p50 = st.clim.p50[t], p90 = st.clim.p90[t];
  if (q == null || p50 == null) return null;
  const s = q >= p50 ? (q - p50) / Math.max(p90 - p50, 1) : -(p50 - q) / Math.max(p50 - p10, 1);
  return clamp(s, -2, 2.5);
}
function klass(st, t) {
  const s = score(st, t);
  if (s == null) return '—';
  if (st.q[t] > st.clim.max[t]) return 'récord para la fecha';
  if (s > 1) return 'muy alto';
  if (s > 0.35) return 'alto';
  if (s >= -0.35) return 'normal';
  if (s >= -1) return 'bajo';
  return 'muy bajo';
}

// ---------- colores (leídos de las variables CSS para respetar claro/oscuro)
let C = {};
const hex2rgb = (h) => { h = h.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  C = { stops: [[-1.6, v('--low-2')], [-0.9, v('--low-1')], [0, v('--mid')], [1, v('--high-1')], [2.1, v('--high-2')]].map(([s, c]) => [s, hex2rgb(c)]) };
}
function color(s) {
  if (s == null) return 'var(--grid)';
  const st = C.stops;
  if (s <= st[0][0]) return `rgb(${st[0][1]})`;
  for (let i = 1; i < st.length; i++) {
    if (s <= st[i][0]) {
      const f = (s - st[i - 1][0]) / (st[i][0] - st[i - 1][0]);
      return `rgb(${st[i - 1][1].map((c, k) => Math.round(lerp(c, st[i][1][k], f)))})`;
    }
  }
  return `rgb(${st.at(-1)[1]})`;
}

// ---------- tooltip
const tip = $('#tip');
function showTip(html, ev) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
const hideTip = () => (tip.hidden = true);
const tipStation = (st, t) => {
  const q = st.q[t], c = st.clim;
  return `<b>${st.name}</b>${st.sub ? ` <span class="muted">· ${st.sub}</span>` : ''}<br>` +
    `<div class="row"><span>${st.kind === 'trib' ? 'río ' + st.name : 'km ' + nf.format(st.km)}</span><span>${dShort(days[t])}</span></div>` +
    `<div class="row"><span>Caudal</span><span><b>${fmtQ(q)}</b> m³/s</span></div>` +
    `<div class="row"><span>Normal</span><span>${fmtQ(c.p10[t])}–${fmtQ(c.p90[t])}</span></div>` +
    `<div class="row"><span>Estado</span><span>${klass(st, t)}</span></div>`;
};

// ---------- estado
let T = todayIdx;
// #rosario, #rosario@8 (zoom), #rosario@8+sat (zoom y fondo satelital)
const HASH = location.hash.match(/^#([a-z]+)(?:@(\d+(?:\.\d+)?))?(\+sat)?$/) || [];
let SEL = HASH[1] || '';
if (!byId[SEL]) SEL = main.reduce((a, b) => ((score(b, todayIdx) ?? -9) > (score(a, todayIdx) ?? -9) ? b : a)).id;

// ================= MAPA =================
const B = { w: -62.3, e: -46.6, s: -35.0, n: -18.6 };
const COS = Math.cos(27 * Math.PI / 180);
const SC = 1000 / ((B.e - B.w) * COS);
const W = 1000, H = Math.round((B.n - B.s) * SC);
const P = ([lon, lat]) => [(lon - B.w) * COS * SC, (B.n - lat) * SC];
const pathOf = (pts) => pts.map((p, i) => { const [x, y] = P(p); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('');
const WQ = (q) => 1.4 + (q ?? 0) / 1000; // ancho del trazo: 1 unidad cada 1.000 m³/s

const map = $('#map');
// ---------- zoom y arrastre: se cambia el viewBox; trazos, puntos y textos se dividen por K
// para conservar su tamaño en pantalla (al acercarse se gana detalle, no tamaño)
var MAP_AXES = null; // se asigna al final, cuando ya existen las funciones de coordenadas
// El mapa ocupa el ancho de la pantalla: el encuadre sigue la forma real del elemento (ASP = alto / ancho),
// no una proporción fija. K = 1 equivale a PS0 píxeles por unidad del mapa: trazos y textos se dividen por K
// y conservan su tamaño en pantalla.
const KMAX = 24, PS0 = 0.5;
let ASP = 1;
const mapSize = () => ({ w: map.clientWidth || 600, h: map.clientHeight || 600 });
const updateAsp = () => { const s = mapSize(); ASP = s.h / s.w; };
const wAt = (k) => mapSize().w / (PS0 * k);   // ancho visible (en unidades del mapa) a zoom k
const wMax = () => Math.max(W, H / ASP);      // el mapa entero a la vista
const wMin = () => wAt(KMAX);
// Encuadre de inicio: en pantallas anchas, la cuenca baja (de Guaíra al Delta, con el Uruguay); en las altas, toda la cuenca
function home() {
  const wide = ASP < 0.9, top = wide ? (B.n + 23.2) * SC : 0, hh = H - top;
  const padL = !wide && innerWidth <= 600 ? 70 : 0; // en el celular, margen al oeste para los nombres de las ciudades
  const w = Math.max(W, hh / ASP), h = w * ASP;
  return { x: W / 2 - w / 2 - padL, y: top + hh / 2 - h / 2, w, h };
}
updateAsp();
let view = home(), K = 1;
const isHome = () => { const h = home(); return Math.abs(view.w - h.w) < 1 && Math.abs(view.x - h.x) < 1 && Math.abs(view.y - h.y) < 1; };
const scaled = [];      // [nodo, atributo, valor a K = 1]
const labelNodes = [];  // textos anclados a un punto, con su desplazamiento en pantalla
function applyView() {
  view.w = clamp(view.w, wMin(), wMax());
  view.h = view.w * ASP;
  const cx = clamp(view.x + view.w / 2, 0, W), cy = clamp(view.y + view.h / 2, 0, H); // el centro no sale del mapa
  view.x = cx - view.w / 2; view.y = cy - view.h / 2;
  K = mapSize().w / view.w / PS0;
  map.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  map.style.setProperty('--k', K);
  map.style.setProperty('--kt', K ** 0.85); // los textos crecen un poco al acercarse
  map.classList.toggle('deep', K >= 4);    // con mucho zoom el trazo esquemático no calza con la imagen
  map.toggleAttribute('data-zoomed', K >= 2);
  map.style.touchAction = isHome() ? 'pan-y' : 'none'; // en el encuadre de inicio, el dedo sigue desplazando la página
  for (const [n, a, v] of scaled) n.setAttribute(a, (v / K).toFixed(2));
  for (const t of labelNodes) {
    const z = K >= 2 && t.dataset.zdx != null;
    t.setAttribute('x', (+t.dataset.x + (z ? t.dataset.zdx : t.dataset.dx) / K ** 0.85).toFixed(1));
    t.setAttribute('y', (+t.dataset.y + (z ? t.dataset.zdy : t.dataset.dy) / K ** 0.85).toFixed(1));
    t.setAttribute('text-anchor', z ? t.dataset.zanchor : t.dataset.anchor);
  }
  if (MAP_AXES) MAP_AXES();
  $('#zout').disabled = view.w >= wMax() - 0.5;
  $('#zhome').disabled = isHome();
}
applyView();
const gSat = el('g', {}, map);
const gBase = el('g', {}, map), gRiver = el('g', { class: 'river-g' }, map), gFlow = el('g', { class: 'flow-g' }, map), gLabels = el('g', {}, map), gDots = el('g', {}, map);

for (const c of geo.coast) scaled.push([el('path', { d: pathOf(c), fill: 'none', stroke: 'var(--coast)', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }, gBase), 'stroke-width', 1.2]);
for (const r of geo.rivers) {
  const w = r.r <= 5 ? 1.6 : r.r <= 7 ? 1.2 : 0.9;
  scaled.push([el('path', { d: pathOf(r.c), fill: 'none', class: 'net', stroke: 'var(--water-faint)', 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, gBase), 'stroke-width', w]);
}
for (const l of geo.lakes) el('path', { d: pathOf(l.c) + 'Z', class: 'net', fill: 'var(--lake)', stroke: 'none' }, gBase);

// Nombres de los ríos de la cuenca: ubicados a mano
const RIV_LABELS = [
  ['Paraguay', -57.95, -24.6], ['Pilcomayo', -61.0, -23.6], ['Iguazú', -53.55, -25.8], ['Uruguay', -54.7, -28.1], ['Paranaíba', -49.6, -19.0],
  ['Grande', -47.9, -20.55], ['Tietê', -49.6, -21.75], ['Paranapanema', -50.9, -23.1], ['Bermejo', -60.6, -25.55],
  ['Salado', -61.6, -30.2], ['Río de la Plata', -57.4, -34.75],
];
for (const [n, lon, lat] of RIV_LABELS) {
  const [x, y] = P([lon, lat]);
  if (x > 0 && x < W && y > 0 && y < H) el('text', { x, y, class: 'riv-label', 'text-anchor': 'middle' }, gLabels).textContent = n;
}

// Cauce principal: un segmento por tramo del trazo, con caudal interpolado por km entre puntos
const stems = geo.stems || { parana: geo.mainstem };
const ms = stems.parana;
const segs = [];
for (const [river, stem] of Object.entries(stems)) {
  for (let i = 1; i < stem.c.length; i++) {
    const [x1, y1] = P(stem.c[i - 1]), [x2, y2] = P(stem.c[i]);
    // f: trazo fino y punteado que se anima río abajo mientras se reproduce el tiempo (la corriente)
    segs.push({ river, km: (stem.km[i - 1] + stem.km[i]) / 2, n: el('line', { x1, y1, x2, y2, 'stroke-linecap': 'round' }, gRiver), f: el('line', { x1, y1, x2, y2, class: 'flow' }, gFlow) });
  }
}
function atKm(k, t, list = RIV.parana) {
  let i = list.findIndex((s) => s.km >= k);
  if (i <= 0) i = i === 0 ? 1 : list.length - 1;
  const a = list[i - 1], b = list[i];
  const f = clamp((k - a.km) / Math.max(b.km - a.km, 1), 0, 1);
  const qa = a.q[t], qb = b.q[t], sa = score(a, t), sb = score(b, t);
  return { q: qa == null || qb == null ? (qa ?? qb) : lerp(qa, qb, f), s: sa == null || sb == null ? (sa ?? sb) : lerp(sa, sb, f) };
}

// Afluentes con dato propio
const pyPaths = geo.paraguay.map((l) => el('path', { d: pathOf(l), fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, gRiver));
// Bermejo: caudal modelado (el modelo lo sigue bien: correlación 0,9 con las alturas del INA).
// Pilcomayo: sin caudal modelado (el modelo no lo sigue: su cauce cambia y se pierde en los esteros);
// se dibuja en trazo punteado y se muestran las alturas medidas por el INA.
const bermejo = byId.bermejo;
const brPaths = bermejo ? (geo.bermejo || []).map((l) => el('path', { d: pathOf(l), fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, gRiver)) : [];
const pcPaths = (geo.pilcomayo || []).map((l) => { const p = el('path', { d: pathOf(l), class: 'river-obs', fill: 'none', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, gRiver); scaled.push([p, 'stroke-width', 2.4]); return p; });
const igz = byId.iguazu;
const igzMouth = ms.c.reduce((best, p) => (Math.hypot(p[0] + 54.59, p[1] + 25.59) < Math.hypot(best[0] + 54.59, best[1] + 25.59) ? p : best));
const igzPath = el('path', { d: pathOf([[igz.lon, igz.lat], igzMouth]), fill: 'none', 'stroke-linecap': 'round' }, gRiver);

// Puntos y etiquetas: las ciudades de las dos orillas, cada una de su lado del río.
// [texto, dx, dy, anchor, 'sub'?] relativos al punto, en unidades del mapa.
const R = 16, L = -16;
const SHORES = {
  nacimiento: [['Nacimiento', R, 6, 'start'], ['Paranaíba + Grande', R, 25, 'start', 'sub']],
  jupia: [['Três Lagoas', R, 6, 'start', 'minor'], ['represa Jupiá', R, 25, 'start', 'sub minor']],
  primavera: [['Porto Primavera', R, 6, 'start']],
  guaira: [['Guaíra', R, 6, 'start'], ['Salto del Guairá', L, 6, 'end']],
  itaipu: [['Foz do Iguaçu', R, 6, 'start'], ['represa Itaipú', R, -14, 'start', 'sub'], ['Ciudad del Este', L, 6, 'end']],
  posadas: [['Encarnación', 4, -14, 'start'], ['Posadas', 4, 28, 'start']],
  yacyreta: [['Ayolas', -4, -14, 'end', 'minor'], ['Ituzaingó', 0, 28, 'middle'], ['represa Yacyretá', 0, 46, 'middle', 'sub']],
  itati: [['Itatí', 0, -14, 'middle', 'minor']],
  // con zoom (≥ 2x) Corrientes pasa a su orilla real, el este: [dx, dy, anchor] alternativos
  corrientes: [['Corrientes', -6, 30, 'end', null, [R, 6, 'start']], ['Resistencia', L, 6, 'end']],
  bellavista: [['Bella Vista', R, 6, 'start']],
  goya: [['Goya', R, 6, 'start'], ['Reconquista', L, 6, 'end']],
  lapaz: [['La Paz', R, 6, 'start']],
  santafe: [['Santa Fe', L, 4, 'end'], ['Paraná', R, 0, 'start']],
  diamante: [['Diamante', R, 12, 'start', 'minor']],
  rosario: [['Rosario', L, 4, 'end'], ['Victoria', R, -2, 'start']],
  sannicolas: [['San Nicolás', L, 16, 'end']],
  sanpedro: [['San Pedro', L, 16, 'end', 'minor']],
  delta: [['Delta', R, 4, 'start'], ['Zárate · Campana', L, 20, 'end', 'minor']],
  // río Uruguay: al oeste la orilla argentina, al este Brasil y Uruguay. Sin zoom, entre los dos ríos
  // no hay lugar: las dos ciudades van apiladas al este; con zoom, cada una a su orilla.
  marcelino: [['Marcelino Ramos', R, 6, 'start', 'minor'], ['Alto Uruguay', R, 25, 'start', 'sub minor']],
  irai: [['Iraí', 0, -14, 'middle']],
  elsoberbio: [['Porto Soberbo', 0, -14, 'middle', 'z2'], ['El Soberbio', 4, 28, 'start']],
  santotome: [['Santo Tomé', R, 6, 'start', null, [L, 6, 'end']], ['São Borja', R, 24, 'start', null, [R, 6, 'start']]],
  pasolibres: [['Paso de los Libres', R, 6, 'start', null, [L, 6, 'end']], ['Uruguaiana', R, 24, 'start', null, [R, 6, 'start']]],
  montecaseros: [['Monte Caseros', R, 6, 'start', null, [L, 6, 'end']], ['Bella Unión', R, 24, 'start', null, [R, 6, 'start']],
    ['Barra do Quaraí', R, 25, 'start', 'sub z2']],
  concordia: [['Concordia', R, 6, 'start', null, [L, 6, 'end']], ['Salto', R, 24, 'start', null, [R, 6, 'start']],
    ['represa Salto Grande', R, -14, 'start', 'sub']],
  colon: [['Colón', R, 6, 'start', null, [L, 6, 'end']], ['Paysandú', R, 24, 'start', null, [R, 6, 'start']]],
  fraybentos: [['Gualeguaychú', R, 6, 'start', null, [L, 6, 'end']], ['Fray Bentos', R, 24, 'start', null, [R, 6, 'start']]],
  nuevapalmira: [['Nueva Palmira', R, 10, 'start']],
  bermejo: [['El Colorado', L, 6, 'end', 'minor']],
};
const dots = {};
for (const st of data.stations) {
  const [x, y] = P([st.lon, st.lat]);
  const texts = (SHORES[st.id] || []).map(([txt, dx, dy, anchor, cls, zoomed]) => {
    const t = el('text', { x: x + dx, y: y + dy, 'text-anchor': anchor, class: 'st-label' + (cls ? ' ' + cls : '') }, gLabels);
    t.textContent = txt;
    Object.assign(t.dataset, { x, y, dx, dy, anchor });
    if (zoomed) Object.assign(t.dataset, { zdx: zoomed[0], zdy: zoomed[1], zanchor: zoomed[2] });
    labelNodes.push(t);
    return t;
  });
  const g = el('g', { tabindex: 0, role: 'button', 'aria-label': st.name }, gDots);
  const rDot = st.kind === 'trib' ? 5 : 6;
  scaled.push([el('circle', { cx: x, cy: y, r: 18, class: 'hit' }, g), 'r', 18]);
  const ring = el('circle', { cx: x, cy: y, r: 11, class: 'ring', visibility: 'hidden' }, g);
  const c = el('circle', { cx: x, cy: y, r: rDot, class: 'st-dot' }, g);
  scaled.push([ring, 'r', 11], [c, 'r', rDot]);
  g.addEventListener('mousemove', (ev) => showTip(tipStation(st, T), ev));
  g.addEventListener('mouseleave', hideTip);
  g.addEventListener('click', () => select(st.id));
  g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(st.id); } });
  dots[st.id] = { c, texts, ring };
}
// estaciones de altura del INA con ubicación propia (Bermejo y Pilcomayo): puntos chicos con su lectura de hoy
const title = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
for (const r of extras.heights?.stations ?? []) {
  if (r.lat == null || r.lon == null || r.height_m == null || r.grp) continue; // los cauces menores solo van en el mapa
  const [gx, gy] = P([r.lon, r.lat]);
  const c = el('circle', { cx: gx, cy: gy, r: 4, class: 'gauge-dot' }, gDots);
  scaled.push([c, 'r', 4]);
  c.addEventListener('mousemove', (ev) => showTip(`<b>${title(r.river)} · ${title(r.port)}</b><br>Altura <b>${nf1.format(r.height_m)} m</b>${r.state ? ' · ' + r.state.toLowerCase() : ''}<br><span class="muted">${r.date}${r.time ? ' ' + r.time : ''} · medición del INA, sin nivel de alerta</span>`, ev));
  c.addEventListener('mouseleave', hideTip);
}

function drawMap() {
  for (const s of segs) {
    const v = atKm(s.km, T, RIV[s.river]);
    s.n.setAttribute('stroke', color(v.s));
    s.n.setAttribute('stroke-width', (WQ(v.q) / K).toFixed(2));
    s.f.setAttribute('stroke-width', (WQ(v.q) * 0.3 / K).toFixed(2));
  }
  const py = byId.paraguay;
  for (const p of pyPaths) { p.setAttribute('stroke', color(score(py, T))); p.setAttribute('stroke-width', (WQ(py.q[T]) / K).toFixed(2)); }
  if (bermejo) for (const p of brPaths) { p.setAttribute('stroke', color(score(bermejo, T))); p.setAttribute('stroke-width', (WQ(bermejo.q[T]) / K).toFixed(2)); }
  igzPath.setAttribute('stroke', color(score(igz, T)));
  igzPath.setAttribute('stroke-width', (WQ(igz.q[T]) / K).toFixed(2));
  for (const [id, d] of Object.entries(dots)) {
    d.c.classList.toggle('sel', id === SEL);
    for (const t of d.texts) t.classList.toggle('sel', id === SEL);
    const lv = worstLevel(id);
    d.ring.setAttribute('visibility', lv ? 'visible' : 'hidden');
    if (lv) d.ring.setAttribute('stroke', lv === 'evac' ? 'var(--st-critical)' : 'var(--st-warning)');
  }
}

// Leyenda
function drawLegend() {
  const lg = $('#legend');
  const px = PS0; // píxeles de pantalla por unidad del mapa: el ancho dibujado de cada trazo
  // barra de color horizontal, como un colorbar de matplotlib: marco fino y marcas en p10, mediana y p90
  const CW = 220, CH = 10, off = (s) => (s + 1.6) / 3.7;
  const stops = C.stops.map(([s, c]) => `<stop offset="${(off(s) * 100).toFixed(1)}%" stop-color="rgb(${c})"/>`).join('');
  const ticks = [[-1, 'p10'], [0, 'mediana'], [1, 'p90']].map(([s, t]) => {
    const x = 1 + off(s) * CW;
    return `<line x1="${x}" x2="${x}" y1="${CH + 1}" y2="${CH + 5}" class="tick"/><text x="${x}" y="${CH + 17}" text-anchor="middle">${t}</text>`;
  }).join('');
  const cbar = `<figure class="cbar"><figcaption>Caudal frente a lo normal para la fecha</figcaption>` +
    `<svg width="${CW + 2}" height="${CH + 22}" aria-hidden="true"><defs><linearGradient id="cbar-g">${stops}</linearGradient></defs>` +
    `<rect x="1" y="1" width="${CW}" height="${CH}" fill="url(#cbar-g)"/><rect x="1" y="1" width="${CW}" height="${CH}" class="spine"/>${ticks}</svg></figure>`;
  // leyenda en recuadro (como plt.legend): anchos de caudal y anillos de estado
  const widths = [2000, 10000, 25000].map((q) =>
    `<span class="key"><svg width="30" height="16" aria-hidden="true"><line x1="2" y1="8" x2="28" y2="8" stroke="var(--mid)" stroke-width="${Math.max(WQ(q) * px, 1).toFixed(1)}"/></svg>${nf.format(q)} m³/s</span>`).join('');
  const rings = extras.heights
    ? `<span class="key"><span class="ico alerta"></span>altura de alerta</span><span class="key"><span class="ico evac"></span>altura de evacuación</span>`
    : '';
  lg.innerHTML = cbar + `<div class="mpl-legend">${widths}${rings}</div>`;
}

// ================= EJES AL ESTILO MATPLOTLIB =================
// Caja negra fina alrededor del área de datos, marcas hacia afuera, sin grilla, rótulos de eje.
function mplFrame(g, M, W, H) {
  el('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, class: 'spine' }, g);
}
function yTick(g, M, y, label) {
  el('line', { x1: M.l - 4, x2: M.l, y1: y, y2: y, class: 'tick' }, g);
  el('text', { x: M.l - 7, y: y + 4, 'text-anchor': 'end' }, g).textContent = label;
}
function xTick(g, x, yBase, label) {
  el('line', { x1: x, x2: x, y1: yBase, y2: yBase + 4, class: 'tick' }, g);
  el('text', { x, y: yBase + 17, 'text-anchor': 'middle' }, g).textContent = label;
}
function yLabel(g, M, H, txt) {
  el('text', { transform: `translate(14,${(M.t + H - M.b) / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'ax-label' }, g).textContent = txt;
}
function xLabel(g, M, W, H, txt) {
  el('text', { x: (M.l + W - M.r) / 2, y: H - 4, 'text-anchor': 'middle', class: 'ax-label' }, g).textContent = txt;
}

// ================= PERFIL A LO LARGO DEL RÍO =================
const prof = $('#profile');
const PW = 640, PH = 254, PM = { l: 70, r: 12, t: 10, b: 42 };
prof.setAttribute('viewBox', `0 0 ${PW} ${PH}`);
// misma escala para todos los ríos: así se comparan a simple vista
const kmMax = Math.ceil(Math.max(...main.map((s) => s.km)) / 250) * 250;
let pyMax = 0;
for (const s of main) for (let t = 0; t < days.length; t++) pyMax = Math.max(pyMax, s.q[t] ?? 0, s.clim.p90[t] ?? 0);
const niceStep = (m) => { const e = 10 ** Math.floor(Math.log10(m / 4)); return [1, 2, 2.5, 5, 10].map((k) => k * e).find((s) => m / s <= 5); };
const pStep = niceStep(pyMax);
pyMax = Math.ceil(pyMax / pStep) * pStep;
const px = (km) => PM.l + (km / kmMax) * (PW - PM.l - PM.r);
const py = (q) => PH - PM.b - (q / pyMax) * (PH - PM.t - PM.b);

const pAxis = el('g', { class: 'axis' }, prof);
mplFrame(pAxis, PM, PW, PH);
for (let q = 0; q <= pyMax; q += pStep) yTick(pAxis, PM, py(q), q ? nf.format(q) : '0');
for (let k = 0; k <= kmMax; k += 500) xTick(pAxis, px(k), PH - PM.b, nf.format(k));
yLabel(pAxis, PM, PH, 'Caudal (m³/s)');
xLabel(pAxis, PM, PW, PH, 'km desde el nacimiento');
const pBand = el('path', { fill: 'var(--band)' }, prof);
const pMed = el('path', { fill: 'none', stroke: 'var(--median)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, prof);
// afluentes: marca en el km de su desembocadura
const pTrib = el('g', {}, prof);
const tribPlaced = [];
for (const t of tribs) {
  const row = tribPlaced.filter((k) => Math.abs(k - t.km) < 180).length;
  tribPlaced.push(t.km);
  el('line', { x1: px(t.km), x2: px(t.km), y1: PM.t, y2: PH - PM.b, stroke: 'var(--rule)', 'stroke-dasharray': '2 3' }, pTrib);
  el('text', { x: px(t.km) + 4, y: PM.t + 10 + 12 * row, class: 'axis', fill: 'var(--ink-3)', 'font-size': 11 }, pTrib).textContent = `+ ${t.name}`;
}
const pLine = el('path', { fill: 'none', stroke: 'var(--q)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, prof);
const pCross = el('line', { y1: PM.t, y2: PH - PM.b, stroke: 'var(--ink-3)', 'stroke-width': 1, visibility: 'hidden' }, prof);
const pDots = Object.fromEntries(main.map((s) => [s.id, el('circle', { r: 4.5, stroke: 'var(--surface)', 'stroke-width': 2 }, prof)]));
const pSel = el('circle', { r: 8, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5 }, prof);
const pHit = el('rect', { x: PM.l, y: PM.t, width: PW - PM.l - PM.r, height: PH - PM.t - PM.b, fill: 'transparent' }, prof);
const nearestByKm = (ev) => {
  const r = prof.getBoundingClientRect();
  const km = ((ev.clientX - r.left) / r.width * PW - PM.l) / (PW - PM.l - PM.r) * kmMax;
  return RIV[PR].reduce((a, b) => (Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a));
};
// pestañas de río del perfil
for (const b of document.querySelectorAll('#prof-tabs button')) {
  b.addEventListener('click', () => { PR = b.dataset.river; drawProfile(); });
}
pHit.addEventListener('mousemove', (ev) => {
  const s = nearestByKm(ev);
  pCross.setAttribute('x1', px(s.km)); pCross.setAttribute('x2', px(s.km)); pCross.setAttribute('visibility', 'visible');
  showTip(tipStation(s, T), ev);
});
pHit.addEventListener('mouseleave', () => { pCross.setAttribute('visibility', 'hidden'); hideTip(); });
pHit.addEventListener('click', (ev) => pick(nearestByKm(ev).id));

function drawProfile() {
  const list = RIV[PR];
  $('#prof-title').textContent = `A lo largo del ${RIVER_NAMES[PR]}`;
  for (const b of document.querySelectorAll('#prof-tabs button')) b.setAttribute('aria-selected', b.dataset.river === PR);
  pTrib.setAttribute('visibility', PR === 'parana' ? 'visible' : 'hidden');
  const pts = (f) => list.filter((s) => f(s) != null).map((s) => [px(s.km), py(f(s))]);
  const line = (p) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const hi = pts((s) => s.clim.p90[T]), lo = pts((s) => s.clim.p10[T]).reverse();
  pBand.setAttribute('d', line(hi) + line(lo).replace('M', 'L') + 'Z');
  pMed.setAttribute('d', line(pts((s) => s.clim.p50[T])));
  pLine.setAttribute('d', line(pts((s) => s.q[T])));
  main.forEach((s) => {
    const q = s.q[T], d = pDots[s.id];
    d.setAttribute('cx', px(s.km)); d.setAttribute('cy', py(q ?? 0));
    d.setAttribute('fill', color(score(s, T)));
    d.setAttribute('visibility', q == null || riverOf(s) !== PR ? 'hidden' : 'visible');
  });
  const sel = byId[SEL];
  if (sel.kind === 'main' && riverOf(sel) === PR && sel.q[T] != null) {
    pSel.setAttribute('cx', px(sel.km)); pSel.setAttribute('cy', py(sel.q[T])); pSel.setAttribute('visibility', 'visible');
  } else pSel.setAttribute('visibility', 'hidden');
}

// ================= SERIE DEL PUNTO ELEGIDO =================
const ser = $('#series');
const SW = 640, SH = 240, SM = { l: 70, r: 12, t: 10, b: 28 };
ser.setAttribute('viewBox', `0 0 ${SW} ${SH}`);
const sx = (i) => SM.l + (i / (days.length - 1)) * (SW - SM.l - SM.r);
let syMax = 1;
const sy = (q) => SH - SM.b - (q / syMax) * (SH - SM.t - SM.b);
const sAxis = el('g', { class: 'axis' }, ser);
const sBand = el('path', { fill: 'var(--band)' }, ser);
const sFcBand = el('path', { fill: 'var(--fc-band)' }, ser);
const sMed = el('path', { fill: 'none', stroke: 'var(--median)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, ser);
const sRec = el('g', {}, ser);
const sToday = el('g', {}, ser);
const sPast = el('path', { fill: 'none', stroke: 'var(--q)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, ser);
const sFc = el('path', { fill: 'none', stroke: 'var(--q-fc)', 'stroke-width': 2, 'stroke-dasharray': '5 3' }, ser);
const sCursor = el('line', { y1: SM.t, y2: SH - SM.b, stroke: 'var(--ink)', 'stroke-width': 1 }, ser);
const sCurDot = el('circle', { r: 4.5, fill: 'var(--q)', stroke: 'var(--surface)', 'stroke-width': 2 }, ser);
const sHover = el('line', { y1: SM.t, y2: SH - SM.b, stroke: 'var(--ink-3)', 'stroke-width': 1, visibility: 'hidden' }, ser);
const sHit = el('rect', { x: SM.l, y: SM.t, width: SW - SM.l - SM.r, height: SH - SM.t - SM.b, fill: 'transparent', style: 'cursor:pointer' }, ser);
const idxAt = (ev) => {
  const r = ser.getBoundingClientRect();
  return clamp(Math.round(((ev.clientX - r.left) / r.width * SW - SM.l) / (SW - SM.l - SM.r) * (days.length - 1)), 0, days.length - 1);
};
sHit.addEventListener('mousemove', (ev) => {
  const i = idxAt(ev);
  sHover.setAttribute('x1', sx(i)); sHover.setAttribute('x2', sx(i)); sHover.setAttribute('visibility', 'visible');
  const st = byId[SEL];
  showTip(`<b>${dShort(days[i])}</b>${i > todayIdx ? ' <span class="muted">· pronóstico</span>' : ''}` +
    `<div class="row"><span>Caudal</span><span><b>${fmtQ(st.q[i])}</b> m³/s</span></div>` +
    (st.lo[i] != null ? `<div class="row"><span>Rango previsto</span><span>${fmtQ(st.lo[i])}–${fmtQ(st.hi[i])}</span></div>` : '') +
    `<div class="row"><span>Normal</span><span>${fmtQ(st.clim.p10[i])}–${fmtQ(st.clim.p90[i])}</span></div>`, ev);
});
sHit.addEventListener('mouseleave', () => { sHover.setAttribute('visibility', 'hidden'); hideTip(); });
sHit.addEventListener('click', (ev) => setT(idxAt(ev)));

function drawSeries() {
  const st = byId[SEL];
  const vals = [...st.q, ...st.clim.p90, ...st.hi].filter((v) => v != null);
  let m = Math.max(...vals);
  const rec = st.clim.record;
  const showRec = rec.q && rec.q < m * 1.35;
  if (showRec) m = Math.max(m, rec.q);
  const step = niceStep(m);
  syMax = Math.ceil(m / step) * step;

  sAxis.replaceChildren();
  mplFrame(sAxis, SM, SW, SH);
  for (let q = 0; q <= syMax; q += step) yTick(sAxis, SM, sy(q), q ? nf.format(q) : '0');
  yLabel(sAxis, SM, SH, 'Caudal (m³/s)');
  // marcas el 1º de cada mes
  days.forEach((d, i) => {
    if (d.endsWith('-01')) xTick(sAxis, sx(i), SH - SM.b, parseDay(d).toLocaleDateString('es-AR', { month: 'short' }).replace('.', ''));
  });

  const line = (arr, from = 0, to = days.length - 1) => {
    let d = '', pen = false;
    for (let i = from; i <= to; i++) {
      if (arr[i] == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(arr[i]).toFixed(1)}`; pen = true;
    }
    return d;
  };
  const area = (hi, lo, from = 0, to = days.length - 1) => {
    const top = [], bot = [];
    for (let i = from; i <= to; i++) if (hi[i] != null && lo[i] != null) { top.push([sx(i), sy(hi[i])]); bot.push([sx(i), sy(lo[i])]); }
    if (!top.length) return '';
    return 'M' + [...top, ...bot.reverse()].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z';
  };
  sBand.setAttribute('d', area(st.clim.p90, st.clim.p10));
  sMed.setAttribute('d', line(st.clim.p50));
  sFcBand.setAttribute('d', area(st.hi, st.lo, todayIdx));
  sPast.setAttribute('d', line(st.q, 0, todayIdx));
  sFc.setAttribute('d', line(st.q, todayIdx));

  sRec.replaceChildren();
  if (showRec) {
    el('line', { x1: SM.l, x2: SW - SM.r, y1: sy(rec.q), y2: sy(rec.q), stroke: 'var(--ink-3)', 'stroke-dasharray': '1 3' }, sRec);
    el('text', { x: SM.l + 4, y: sy(rec.q) - 5, class: 'axis', fill: 'var(--ink-2)', 'font-size': 11 }, sRec).textContent =
      `máximo ${st.clim.years}: ${fmtQ(rec.q)} (${parseDay(rec.date).toLocaleDateString('es-AR', { month: 'short', year: 'numeric' }).replace('.', '')})`;
  }
  sToday.replaceChildren();
  el('line', { x1: sx(todayIdx), x2: sx(todayIdx), y1: SM.t, y2: SH - SM.b, stroke: 'var(--rule)' }, sToday);
  el('text', { x: sx(todayIdx) + 4, y: SM.t + 8, fill: 'var(--ink-3)', 'font-size': 11 }, sToday).textContent = 'pronóstico →';
  moveCursor();

  $('#series-key').innerHTML =
    `<span class="key"><span class="sw line" style="background:var(--q)"></span>Caudal</span>` +
    `<span class="key"><span class="sw dash" style="border-color:var(--q-fc)"></span>Pronóstico</span>` +
    `<span class="key"><span class="sw" style="background:var(--fc-band)"></span>Rango previsto</span>` +
    `<span class="key"><span class="sw" style="background:var(--band)"></span>Normal (${st.clim.years})</span>` +
    `<span class="key"><span class="sw dash" style="border-color:var(--median)"></span>Mediana</span>`;
}
function moveCursor() {
  const st = byId[SEL];
  sCursor.setAttribute('x1', sx(T)); sCursor.setAttribute('x2', sx(T));
  const q = st.q[T];
  sCurDot.setAttribute('cx', sx(T)); sCurDot.setAttribute('cy', sy(q ?? 0));
  sCurDot.setAttribute('visibility', q == null ? 'hidden' : 'visible');
}

// ================= FICHA =================
// Represas: nombre y punto del río donde se compara con el modelo (justo aguas abajo)
const DAM_NAMES = { itaipu: 'Itaipú', yacyreta: 'Yacyretá', saltogrande: 'Salto Grande' };
const DAM_STATION = { itaipu: 'itaipu', yacyreta: 'yacyreta', saltogrande: 'concordia' };
const DAM_SOURCE = {
  itaipu: 'Dato: ONS, operador del sistema eléctrico de Brasil.',
  yacyreta: 'Dato: Entidad Binacional Yacyretá, vía INA.',
  saltogrande: 'Dato: Comisión Técnica Mixta de Salto Grande, vía INA.',
};

// Represa aguas arriba que hoy larga bastante más de lo que estima el modelo (el modelo no conoce sus maniobras)
function damGap(st) {
  let worst = null;
  for (const [id, d] of Object.entries(extras.dams || {})) {
    const dam = byId[DAM_STATION[id]];
    if (!dam || !d?.series?.length || st.kind !== 'main' || riverOf(st) !== riverOf(dam) || st.km < dam.km) continue;
    const last = d.series.filter((r) => r.outflow != null).at(-1);
    const m = dam.q[days.indexOf(last?.date)];
    if (!last || !m) continue;
    const ratio = last.outflow / m;
    if (ratio > 1.25 && (!worst || ratio > worst.ratio)) worst = { name: DAM_NAMES[id] || dam.name, q: last.outflow, m, ratio, date: last.date };
  }
  return worst;
}

function drawStats() {
  const st = byId[SEL];
  $('#st-name').textContent = st.kind === 'trib' ? `Río ${st.name}` : st.name;
  $('#st-sub').textContent = st.kind === 'trib'
    ? `Afluente · ${st.sub}`
    : `${st.sub ? st.sub + ' · ' : ''}km ${nf.format(st.km)} desde el nacimiento`;
  const q = st.q[T], p50 = st.clim.p50[T];
  const ratio = q != null && p50 ? q / p50 : null;
  let pk = todayIdx;
  for (let i = todayIdx; i < days.length; i++) if ((st.q[i] ?? -1) > (st.q[pk] ?? -1)) pk = i;
  const last = st.q.findLastIndex((v) => v != null);
  const rising = pk > todayIdx && st.q[pk] > (st.q[todayIdx] ?? 0) * 1.02;
  const peak = rising && pk >= last
    ? { k: `Pronóstico · ${dShort(days[last])}`, v: fmtQ(st.q[last]), s: 'm³/s · y sigue en alza' }
    : rising
      ? { k: 'Pico previsto', v: fmtQ(st.q[pk]), s: `m³/s · ${dShort(days[pk])}` }
      : { k: 'Próximos 30 días', v: (st.q[last] ?? 0) < (st.q[todayIdx] ?? 0) * 0.98 ? 'en baja' : 'estable', s: 'según el pronóstico' };
  const perDay = q != null ? q * 86400 / 1e9 : null;
  // donde el INA pronostica, su altura es el dato principal (el pico de GloFAS queda en el gráfico)
  const fr = portsOf(SEL).find((r) => fcOf(r.port));
  let ina = null;
  if (fr) {
    const f = fcOf(fr.port), pts = f.points.slice(1);
    const p = pts.find((x) => x.date >= TODAY_AR) || pts.at(-1);
    if (p) ina = { k: `INA · ${portName(fr.port)} · ${dShort(p.date)}`, v: `${nf2.format(p.mid)} m`,
      s: `${chip(lvAt(fr, p.mid)) || 'sin alerta'} · rango ${nf2.format(p.lo)}–${nf2.format(p.hi)}` };
  }
  $('#stats').innerHTML = [
    { k: T === todayIdx ? 'Caudal hoy' : `Caudal · ${dShort(days[T])}`, v: fmtQ(q), s: perDay != null ? `m³/s · ${nf1.format(perDay)} km³ por día` : 'm³/s' },
    { k: 'Frente a lo normal', v: klass(st, T), s: ratio ? `${nf1.format(ratio)} veces la mediana` : '' },
    ina || peak,
  ].map((x) => `<div class="stat"><div class="k">${x.k}</div><div class="v">${x.v}</div><div class="s">${x.s}</div></div>`).join('');
  const gap = damGap(st);
  $('#dam-note').hidden = !gap;
  if (gap) $('#dam-note').innerHTML = `<span class="chip alerta"><span class="ico"></span></span> ${gap.name} largó ${fmtQ(gap.q)} m³/s el ${dShort(gap.date)}, ${nf1.format(gap.ratio)} veces lo que estima el modelo para ese punto. El modelo no conoce las maniobras de las represas: aguas abajo, el caudal real puede ser mayor.${ina ? ' Para este tramo, guiate por el pronóstico del INA.' : ''}`;
}

// ================= ALTURAS MEDIDAS (Prefectura) =================
// Hidrómetros de Prefectura en el tramo de cada punto, de aguas arriba hacia abajo, en ambas orillas
const PORTS = {
  guaira: ['GUAYRA'], itaipu: ['ITAIPU', 'LIBERTAD', 'ELDORADO'],
  posadas: ['LIBERTADOR', 'PUERTO MANI', 'SANTA ANA', 'POSADAS'], yacyreta: ['ITUZAINGO'],
  itati: ['ITA IBATE', 'ITATI', 'PASO DE LA PATRIA'], corrientes: ['CORRIENTES', 'BARRANQUERAS', 'EMPEDRADO'],
  bellavista: ['BELLA VISTA'], goya: ['GOYA', 'RECONQUISTA'], lapaz: ['ESQUINA', 'LA PAZ', 'SANTA ELENA'],
  santafe: ['HERNANDARIAS', 'SANTA FE', 'PARANA'], diamante: ['DIAMANTE'], rosario: ['SAN LORENZO', 'ROSARIO', 'VICTORIA'],
  sannicolas: ['VILLA CONSTITUCION', 'SAN NICOLAS'], sanpedro: ['RAMALLO', 'SAN PEDRO'],
  delta: ['BARADERO', 'ZARATE', 'CAMPANA'], paraguay: ['PILCOMAYO', 'PUERTO PILCOMAYO', 'BOUVIER', 'FORMOSA', 'BERMEJO', 'LAS PALMAS', 'ISLA DEL CERRITO'], bermejo: ['PUERTO LAVALLE', 'EL COLORADO', 'PUERTO VELAZ'], iguazu: ['IGUAZU', 'PUERTO IGUAZU'],
  // río Uruguay
  elsoberbio: ['EL SOBERBIO', 'ALBA POSSE', 'PANAMBI', 'SAN JAVIER'],
  santotome: ['PUERTO CONCEPCION', 'GARRUCHOS', 'SANTO TOME', 'ALVEAR', 'LA CRUZ'],
  pasolibres: ['YAPEYU', 'PASO DE LOS LIBRES', 'BOMPLAND'], montecaseros: ['MONTE CASEROS', 'MOCORETA'],
  concordia: ['SALTO GRANDE ABAJO', 'CONCORDIA', 'YERUA'], colon: ['LA CALERA', 'COLON', 'CONCEPCION DEL URUGUAY'],
  fraybentos: ['CAMPICHUELO'], nuevapalmira: ['PARANACITO'],
};
const norm = (x) => (x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const readings = extras.heights?.stations ?? [];
function portsOf(id) {
  const st = byId[id];
  const river = st.kind === 'trib' ? norm(st.name) : riverOf(st) === 'uruguay' ? 'URUGUAY' : 'PARANA';
  return (PORTS[id] || []).map((p) => readings.find((r) => norm(r.port) === p && norm(r.river).includes(river)))
    .filter((r) => r && r.height_m != null);
}
function level(r) {
  const st = norm(r.state);
  if (st.includes('EVACUACION') || (r.evac_m != null && r.height_m >= r.evac_m)) return 'evac';
  if (st.includes('ALERTA') || (r.alert_m != null && r.height_m >= r.alert_m)) return 'alerta';
  return null;
}
function worstLevel(id) {
  const lv = portsOf(id).map(level);
  return lv.includes('evac') ? 'evac' : lv.includes('alerta') ? 'alerta' : null;
}
const chip = (lv) => (lv === 'evac' ? '<span class="chip evac"><span class="ico"></span>evacuación</span>'
  : lv === 'alerta' ? '<span class="chip alerta"><span class="ico"></span>alerta</span>' : '');
const nf2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TREND = { CRECE: 'crece', BAJA: 'baja', 'ESTAC.': 'estacionario' };
const trend = (r) => TREND[norm(r.state).replace(/^(ALERTA|EVACUACION)\s*/, '')] || '';
// Prefectura publica los nombres en mayúsculas y sin tildes
const ACCENTS = {
  IGUAZU: 'Iguazú', 'PUERTO IGUAZU': 'Puerto Iguazú', ITUZAINGO: 'Ituzaingó', 'ITA IBATE': 'Itá Ibaté', ITATI: 'Itatí', PARANA: 'Paraná', 'PUERTO MANI': 'Puerto Maní',
  'SAN NICOLAS': 'San Nicolás', 'VILLA CONSTITUCION': 'Villa Constitución', ZARATE: 'Zárate', YAPEYU: 'Yapeyú', COLON: 'Colón',
  'SANTO TOME': 'Santo Tomé', 'PUERTO CONCEPCION': 'Puerto Concepción', 'CONCEPCION DEL URUGUAY': 'Concepción del Uruguay',
  YERUA: 'Yeruá', FEDERACION: 'Federación', MOCORETA: 'Mocoretá', 'PANAMBI': 'Panambí', 'GUAYRA': 'Guairá',
  ITAIPU: 'Itaipú', 'REPRESA ITAIPU (BRASIL)': 'Represa Itaipú', 'SALTO GRANDE ABAJO': 'Salto Grande (abajo)',
};
const portName = (p) => ACCENTS[norm(p)] || p.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())
  .replace(/ (De|Del|La|Las|Los|El)(?= )/g, (w) => w.toLowerCase());

function gaugeSvg(r, hist, fc = null) {
  const GW = 600, GH = 66;
  const vals = [r.height_m, r.alert_m, r.evac_m, fc?.hi, ...hist.map((h) => h[1])].filter((v) => v != null);
  const max = Math.max(...vals) * 1.1, min = Math.min(0, ...vals);
  const gx = (v) => ((v - min) / (max - min)) * GW;
  const lv = level(r);
  const fill = lv === 'evac' ? 'var(--st-critical)' : lv === 'alerta' ? 'var(--st-warning)' : 'var(--q)';
  let svg = `<svg class="gauge" viewBox="0 0 ${GW} ${GH}" role="img" aria-label="Altura ${nf2.format(r.height_m)} m">`;
  // últimos 30 días de lecturas, como línea fina sobre la barra
  if (hist.length > 1) {
    const hv = hist.map((h) => h[1]), lo = Math.min(...hv), hi = Math.max(...hv);
    const hx = (i) => (i / (hist.length - 1)) * GW;
    const hy = (v) => 16 - ((v - lo) / (hi - lo || 1)) * 14;
    svg += `<path d="${hist.map((h, i) => `${i ? 'L' : 'M'}${hx(i).toFixed(1)},${hy(h[1]).toFixed(1)}`).join('')}" fill="none" stroke="var(--ink-3)" stroke-width="1.5"/>`;
  }
  svg += `<rect x="0" y="24" width="${GW}" height="10" rx="5" fill="var(--band)"/>`;
  svg += `<rect x="0" y="24" width="${Math.max(gx(r.height_m), 6).toFixed(1)}" height="10" rx="5" fill="${fill}"/>`;
  for (const [v, dash] of [[r.alert_m, '3 2'], [r.evac_m, null]]) {
    if (v == null) continue;
    svg += `<line x1="${gx(v)}" x2="${gx(v)}" y1="19" y2="39" stroke="var(--ink)" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  }
  // pronóstico INA a +7 días: rango (bajo–alto) y valor central, sobre la barra
  if (fc) {
    svg += `<line x1="${gx(fc.lo)}" x2="${gx(fc.hi)}" y1="29" y2="29" stroke="var(--ink)" stroke-width="1.5"/>` +
      `<circle cx="${gx(fc.mid)}" cy="29" r="5.5" fill="var(--fig)" stroke="var(--ink)" stroke-width="2"/>`;
  }
  const marks = [fc && `○ INA ${dShort(fc.date)}`, r.alert_m != null && `┆ alerta ${nf2.format(r.alert_m)}`, r.evac_m != null && `│ evacuación ${nf2.format(r.evac_m)}`].filter(Boolean).join('   ');
  if (marks) svg += `<text x="${GW}" y="56" text-anchor="end" font-size="12" fill="var(--ink-2)">${marks}</text>`;
  return svg + '</svg>';
}

// pronóstico INA de un puerto (si lo hay) y el estado que implicaría cada valor
const fcOf = (port) => extras.forecastINA?.ports?.find((p) => p.port === norm(port));
const lvAt = (r, v) => (r.evac_m != null && v >= r.evac_m ? 'evac' : r.alert_m != null && v >= r.alert_m ? 'alerta' : null);
function fcLine(r, f) {
  const pts = f.points.filter((p) => p.date > f.points[0].date);
  if (!pts.length) return '';
  return `<p class="fc-line"><span class="muted">pronóstico INA (${dShort(f.issued)}):</span> ` +
    pts.map((p) => `${dShort(p.date)} <b>${nf2.format(p.mid)} m</b> <span class="muted">(${nf2.format(p.lo)}–${nf2.format(p.hi)})</span> ${chip(lvAt(r, p.mid))}`).join(' · ') + '</p>';
}
function gaugeRow(r) {
  const hist = Object.entries(extras.history?.[`${r.river}|${r.port}`] || {}).sort().slice(-30);
  const v = r.var_m != null ? ` ${r.var_m > 0 ? '+' : r.var_m < 0 ? '−' : '±'}${nf2.format(Math.abs(r.var_m))}` : '';
  const f = fcOf(r.port), next = f?.points.find((p) => p.date > f.points[0].date);
  return `<div class="gauge-row" data-port="${r.port}"><div class="gauge-head"><span><b>${portName(r.port)}</b> <span class="muted small">${dShort(r.date)}${r.time ? ' ' + r.time : ''}</span></span>` +
    `<span>${chip(level(r))} <span class="h">${nf2.format(r.height_m)} m</span> <span class="muted small">${trend(r)}${v}</span></span></div>` +
    gaugeSvg(r, hist, next || null) + (f ? fcLine(r, f) : '') + '</div>';
}
function drawHeights() {
  const box = $('#heights');
  const rs = portsOf(SEL);
  box.hidden = !rs.length;
  if (!rs.length) return;
  // principal: el que tiene pronóstico del INA o, si no, el más comprometido; el resto, plegado
  const rank = (r) => (fcOf(r.port) ? 4 : 0) + ({ evac: 2, alerta: 1 }[level(r)] || 0);
  const sorted = rs.slice().sort((a, b) => rank(b) - rank(a));
  const [first, ...rest] = sorted;
  box.innerHTML = `<h3>Altura medida</h3>` +
    `<details class="help"><summary>cómo leer</summary><p class="muted small">Hidrómetros de Prefectura en este tramo, última lectura (no cambia con la fecha elegida arriba). La línea fina son los últimos 30 días; las rayas, las alturas de alerta (punteada) y evacuación. El círculo es la altura que pronostica el INA para la próxima semana, con su rango.</p></details>` +
    gaugeRow(first) +
    (rest.length ? `<details class="more"><summary>${rest.length} ${rest.length === 1 ? 'hidrómetro más' : 'hidrómetros más'} en este tramo</summary>${rest.map(gaugeRow).join('')}</details>` : '');
}

// ================= SATÉLITE =================
// Una pasada de Sentinel-1 por vez: la más reciente con detecciones, y las anteriores a elección.
// (Acumular días suma artefactos de borde de pasada.)
let satReq = 0;
async function drawSat() {
  const fig = $('#sat'), box = $('#sat-box');
  const sat = extras.satellite;
  box.hidden = !sat;
  if (!sat) return;
  // plegado: las imágenes se piden recién al abrirlo
  if (!box.open) { satReq++; fig.innerHTML = ''; return; }
  const id = SEL, req = ++satReq;
  const attr = [sat.layers?.base?.attribution, sat.layers?.flood?.attribution].filter(Boolean).join(' · ');
  fig.innerHTML = `<details class="help"><summary>cómo leer</summary><p class="muted small">Unos 50 km alrededor del punto. En rosa, el agua fuera de su lugar habitual que detectó el radar de Sentinel-1 (ve a través de las nubes) en una pasada. Donde no hay rosa puede no haber inundación, o el satélite no cubrió esa zona. El radar a veces confunde suelo muy húmedo o bordes de pasada con agua.</p></details>` +
    `<div class="frame"><img alt="Imagen satelital alrededor de ${byId[id].name}" src="/api/sat/base/${id}.png"></div>` +
    `<figcaption class="small muted"><span id="sat-ctl">buscando pasadas del satélite…</span><span>${attr}</span></figcaption>`;
  let passes = [];
  try { passes = await fetch(`/api/sat/passes/${id}`).then((r) => (r.ok ? r.json() : [])); } catch {}
  if (req !== satReq) return; // el usuario ya eligió otro punto
  const ctl = $('#sat-ctl');
  if (!passes.length) { ctl.textContent = 'sin detecciones del radar en los últimos 14 días'; return; }
  const frame = fig.querySelector('.frame');
  const overlay = document.createElement('img');
  overlay.className = 'overlay'; overlay.alt = '';
  frame.appendChild(overlay);
  const show = (d) => { overlay.src = `/api/sat/flood/${id}.png?date=${d}`; };
  ctl.innerHTML = `<label><input type="checkbox" checked id="sat-toggle"> inundación detectada</label> · pasada del ` +
    `<select id="sat-date" aria-label="Fecha de la pasada">${passes.map((d) => `<option value="${d}">${dShort(d)}</option>`).join('')}</select>`;
  show(passes[0]);
  $('#sat-date').addEventListener('change', (ev) => show(ev.target.value));
  $('#sat-toggle').addEventListener('change', (ev) => { overlay.hidden = !ev.target.checked; });
}


$('#sat-box').addEventListener('toggle', () => { if ($('#sat-box').open) drawSat(); });

// ================= REPRESAS =================
// Una línea por represa con lo esencial; el detalle y el gráfico, al desplegar
function drawDams() {
  const dams = Object.entries(extras.dams || {}).filter(([, d]) => d?.series?.length);
  $('#dams-card').hidden = !dams.length;
  const sgn = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v);
  const info = dams.map(([id, d]) => {
    const model = byId[DAM_STATION[id]];
    const valid = d.series.filter((r) => r.outflow != null);
    const last = valid.at(-1);
    const ref = valid.find((r) => r.date >= days[Math.max(0, todayIdx - 30)]);
    const m = model?.q[days.indexOf(last?.date)];
    return { id, d, model, last, ref, m,
      ch: last && ref ? Math.round((last.outflow / ref.outflow - 1) * 100) : null,
      ratio: m && last ? last.outflow / m : null };
  });
  $('#dams').innerHTML = info.map(({ id, last, ratio, ch }) =>
    `<details class="dam fold" id="dam-block-${id}"><summary><b>${DAM_NAMES[id] || id}</b> · ${fmtQ(last?.outflow)} m³/s` +
    (ratio ? ` · <span class="${ratio > 1.25 ? 'warn' : ''}">×${nf1.format(ratio)} el modelo</span>` : '') +
    (ch != null ? ` · ${sgn(ch)} % en 30 días` : '') + `</summary>` +
    `<p class="muted small">${DAM_SOURCE[id] || ''}</p><div class="stats" id="dam-stats-${id}"></div>` +
    `<svg class="chart" id="dam-${id}" role="img" aria-label="Caudal erogado por ${DAM_NAMES[id] || id}"></svg>` +
    `<div class="series-key small muted"><span class="key"><span class="sw line" style="background:var(--q)"></span>Erogado (medido)</span>` +
    `<span class="key"><span class="sw dash" style="border-color:var(--model)"></span>Modelo en ese punto</span></div></details>`).join('');
  for (const { id, d, model, last, ref, m, ch } of info) {
    const byDate = Object.fromEntries(d.series.map((r) => [r.date, r]));
    const meas = days.map((t) => byDate[t]?.outflow ?? null);
    const r = m && last ? Math.round((last.outflow / m - 1) * 100) : null;
    $(`#dam-stats-${id}`).innerHTML = [
      { k: `Erogado · ${last ? dShort(last.date) : '—'}`, v: fmtQ(last?.outflow), s: last?.spill != null ? `m³/s · ${fmtQ(last.spill)} por vertedero` : 'm³/s medido' },
      { k: 'En 30 días', v: ch == null ? '—' : `${sgn(ch)} %`, s: ref ? `desde ${fmtQ(ref.outflow)} m³/s` : '' },
      { k: 'Frente al modelo', v: r == null ? '—' : `${sgn(r)} %`, s: m ? `el modelo estima ${fmtQ(m)}` : '' },
    ].map((x) => `<div class="stat"><div class="k">${x.k}</div><div class="v">${x.v}</div><div class="s">${x.s}</div></div>`).join('');
    miniChart($(`#dam-${id}`), [
      { v: model ? model.q.map((q, i) => (i <= todayIdx ? q : null)) : [], stroke: 'var(--model)', dash: '6 3', label: 'Modelo' },
      { v: meas, stroke: 'var(--q)', label: 'Erogado' },
    ]);
  }
}

// Gráfico de líneas mínimo sobre el eje de fechas común, con tooltip
function miniChart(svg, series) {
  const W2 = 640, H2 = 200, M = { l: 70, r: 12, t: 10, b: 26 };
  svg.setAttribute('viewBox', `0 0 ${W2} ${H2}`);
  const all = series.flatMap((s) => s.v).filter((v) => v != null);
  if (!all.length) return;
  const step = niceStep(Math.max(...all));
  const ymax = Math.ceil(Math.max(...all) / step) * step;
  const x = (i) => M.l + (i / (days.length - 1)) * (W2 - M.l - M.r);
  const y = (v) => H2 - M.b - (v / ymax) * (H2 - M.t - M.b);
  const ax = el('g', { class: 'axis' }, svg);
  mplFrame(ax, M, W2, H2);
  for (let q = 0; q <= ymax; q += step) yTick(ax, M, y(q), q ? nf.format(q) : '0');
  yLabel(ax, M, H2, 'Caudal (m³/s)');
  days.forEach((d, i) => {
    if (d.endsWith('-01')) xTick(ax, x(i), H2 - M.b, parseDay(d).toLocaleDateString('es-AR', { month: 'short' }).replace('.', ''));
  });
  el('line', { x1: x(todayIdx), x2: x(todayIdx), y1: M.t, y2: H2 - M.b, stroke: 'var(--rule)' }, svg);
  for (const s of series) {
    let d = '', pen = false;
    s.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    el('path', { d, fill: 'none', stroke: s.stroke, 'stroke-width': 2, 'stroke-dasharray': s.dash, 'stroke-linejoin': 'round' }, svg);
  }
  const hover = el('line', { y1: M.t, y2: H2 - M.b, stroke: 'var(--ink-3)', visibility: 'hidden' }, svg);
  const hit = el('rect', { x: M.l, y: M.t, width: W2 - M.l - M.r, height: H2 - M.t - M.b, fill: 'transparent' }, svg);
  hit.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const i = clamp(Math.round(((ev.clientX - r.left) / r.width * W2 - M.l) / (W2 - M.l - M.r) * (days.length - 1)), 0, days.length - 1);
    hover.setAttribute('x1', x(i)); hover.setAttribute('x2', x(i)); hover.setAttribute('visibility', 'visible');
    showTip(`<b>${dShort(days[i])}</b>` + series.map((s) => `<div class="row"><span>${s.label}</span><span>${fmtQ(s.v[i])}</span></div>`).join(''), ev);
  });
  hit.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); hideTip(); });
}

// ================= TABLA =================
const tbody = $('#table tbody');
const order = [];
for (const r of Object.keys(RIVER_NAMES)) {
  for (const s of RIV[r]) { order.push(s); for (const t of tribs.filter((t) => t.joins === s.id)) order.push(t); }
}
const rows = order.map((st, i) => {
  if (i === 0 || riverOf(order[i - 1]) !== riverOf(st)) {
    const th = document.createElement('tr');
    th.className = 'river-row';
    th.innerHTML = `<th colspan="6">Río ${RIVER_NAMES[riverOf(st)]}</th>`;
    tbody.appendChild(th);
  }
  const tr = document.createElement('tr');
  tr.tabIndex = 0;
  tr.addEventListener('click', () => pick(st.id));
  tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick(st.id); });
  tbody.appendChild(tr);
  return { st, tr };
});
function drawTable() {
  for (const { st, tr } of rows) {
    const q = st.q[T], p50 = st.clim.p50[T], q7 = st.q[T - 7];
    const vs = q != null && p50 ? Math.round((q / p50 - 1) * 100) : null;
    const d7 = q != null && q7 ? Math.round((q / q7 - 1) * 100) : null;
    const sign = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)} %`);
    tr.className = st.id === SEL ? 'sel' : '';
    tr.innerHTML = `<td class="${st.kind === 'trib' ? 'trib' : ''}"><span class="dot" style="background:${color(score(st, T))}"></span>${st.kind === 'trib' ? '+ río ' : ''}${st.name}</td>` +
      `<td class="num">${st.kind === 'trib' ? '' : nf.format(st.km)}</td><td class="num">${fmtQ(q)}</td><td class="num">${sign(vs)}</td><td class="num">${sign(d7)}</td>` +
      `<td class="num">${(() => { const r = portsOf(st.id).find((p) => level(p)) || portsOf(st.id)[0]; return r ? `${chip(level(r))} ${nf2.format(r.height_m)} m` : '—'; })()}</td>`;
  }
}

// ================= TIEMPO =================
const slider = $('#slider');
slider.max = days.length - 1;
$('#t-start').textContent = dShort(days[0]);
$('#t-end').textContent = dShort(days.at(-1));
// posiciona la etiqueta "hoy" en su lugar real de la escala
$('.time-scale span:nth-child(2)').style.cssText = `position:relative;left:${((todayIdx / (days.length - 1)) - 0.5) * 100}%`;
function drawTime() {
  slider.value = T;
  $('#date-label').textContent = dLong(days[T]);
  const n = T - todayIdx;
  $('#date-rel').textContent = n === 0 ? 'hoy' : n < 0 ? `hace ${-n} día${n === -1 ? '' : 's'}` : `pronóstico · en ${n} día${n === 1 ? '' : 's'}`;
}

function setT(t) {
  T = clamp(t, 0, days.length - 1);
  drawTime(); drawMap(); drawProfile(); moveCursor(); drawStats(); drawTable();
}
// Estadísticas: avisa qué localidad se eligió (sin cookies; el servidor solo suma totales).
// No cuenta la carga inicial ni los redibujados de la misma localidad (cambio de tema, etc.).
let statsReady = false, lastReported = null;
function reportStation(id) {
  if (!statsReady || id === lastReported) return;
  lastReported = id;
  try { navigator.sendBeacon('/api/hit', new Blob([JSON.stringify({ s: id })], { type: 'application/json' })); } catch {}
}

function select(id) {
  reportStation(id);
  SEL = id;
  PR = riverOf(byId[id]);
  drawHeights(); drawSat();
  history.replaceState(null, '', '#' + id);
  $('#st-select').value = id;
  drawMap(); drawProfile(); drawSeries(); drawStats(); drawTable();
}
slider.addEventListener('input', () => { stop(); setT(+slider.value); });
$('#today').addEventListener('click', () => { stop(); setT(todayIdx); });

let timer = null;
const play = $('#play');
function stop() { clearInterval(timer); timer = null; play.textContent = '▶'; play.setAttribute('aria-label', 'Reproducir'); map.classList.remove('flowing'); }
play.addEventListener('click', () => {
  if (timer) return stop();
  // desde hoy o desde el final, arranca 60 días atrás para ver llegar la crecida
  if (T >= days.length - 1 || T === todayIdx) setT(Math.max(0, todayIdx - 60));
  play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pausar');
  map.classList.add('flowing');
  timer = setInterval(() => { if (T >= days.length - 1) return stop(); setT(T + 1); }, 140);
});
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('select, input')) return;
  if (ev.key === 'ArrowRight') { stop(); setT(T + 1); }
  if (ev.key === 'ArrowLeft') { stop(); setT(T - 1); }
});

const selEl = $('#st-select');
selEl.innerHTML = Object.entries(RIVER_NAMES).map(([r, name]) => `<optgroup label="Río ${name}">` +
  order.filter((s) => riverOf(s) === r).map((s) => `<option value="${s.id}">${s.kind === 'trib' ? '+ río ' : ''}${s.name}</option>`).join('') +
  '</optgroup>').join('');
selEl.addEventListener('change', () => pick(selEl.value));

const up = new Date(data.updated);
$('#updated').textContent = `Actualizado: ${up.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })}.`;

// Acerca el mapa a un punto (lista, selector, perfil, tablero, "ver en el mapa" y enlaces con @zoom).
// Si ya hay más zoom que el habitual, se conserva. Con animación, salvo que se pida lo contrario.
const FOCUS_K = 8;
function focusStation(id, k = Math.max(FOCUS_K, K), animate = true) {
  const [x, y] = P([byId[id].lon, byId[id].lat]);
  const w = wAt(clamp(k, 1, KMAX));
  flyTo({ x: x - w / 2, y: y - (w * ASP) / 2, w, h: w * ASP }, animate);
}
// Vuelo suave: el zoom se interpola en escala geométrica (se siente parejo) y el centro, lineal
let flyRaf = 0;
function flyTo(target, animate = true, ms = 650) {
  cancelAnimationFrame(flyRaf);
  // sin animación si se pidió, si la persona prefiere menos movimiento, o si la pestaña no está a la
  // vista (ahí el navegador frena las animaciones y el mapa quedaría a mitad de camino)
  if (!animate || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) { view = target; zoomed(); return; }
  const from = { ...view }, t0 = performance.now();
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 }, tc = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const step = (now) => {
    const f = Math.min(1, (now - t0) / ms);
    const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2; // ease-in-out
    const w = from.w * (target.w / from.w) ** e, h = w * ASP;
    view = { x: lerp(fc.x, tc.x, e) - w / 2, y: lerp(fc.y, tc.y, e) - h / 2, w, h };
    applyView();
    drawMap();
    if (f < 1) flyRaf = requestAnimationFrame(step);
    else scheduleSat();
  };
  flyRaf = requestAnimationFrame(step);
}
// elegir una localidad desde el panel derecho también lleva el mapa hasta ella
const pick = (id) => { select(id); focusStation(id); };
$('#st-focus').addEventListener('click', () => {
  focusStation(SEL);
  scrollTo({ top: 0, behavior: 'smooth' }); // el mapa está arriba de todo
});

// ================= MONITOR: barra de estado, tablero de situación, coordenadas, tema =================
const ago = (iso) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  if (m < 48 * 60) return `hace ${Math.round(m / 60)} h`;
  return dShort(iso.slice(0, 10));
};
const listEs = (xs, max = 3) => {
  const shown = xs.slice(0, max), rest = xs.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} y ${rest} más`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} y ${shown.at(-1)}` : shown[0] || '';
};
const daysOld = (d) => (d ? (Date.now() - Date.parse(d + 'T12:00:00')) / 864e5 : Infinity);

function drawStatus() {
  const err = extras.errors || {};
  const dams = Object.entries(extras.dams || {}).filter(([, d]) => d?.series?.length);
  const damDates = dams.map(([, d]) => d.series.at(-1).date).sort();
  const items = [
    { k: 'Modelo', v: ago(data.updated), ok: Date.now() - Date.parse(data.updated) < 6 * 3600e3 },
    extras.heights?.via === 'INA'
      ? { k: 'Alturas', v: `vía INA · ${ago(extras.heights.fetchedAt)}`, ok: Date.now() - Date.parse(extras.heights.fetchedAt) < 3 * 3600e3 }
      : { k: 'Prefectura', v: err.prefectura ? `sin respuesta · última ${ago(extras.heights?.fetchedAt)}` : ago(extras.heights?.fetchedAt),
        ok: !err.prefectura && extras.heights && Date.now() - Date.parse(extras.heights.fetchedAt) < 3 * 3600e3 },
    { k: 'Represas', v: dams.length ? `${dams.length} · al ${dShort(damDates[0])}` : '—', ok: dams.length && daysOld(damDates[0]) < 3 },
    { k: 'Radar', v: extras.satellite?.latest ? `pasada ${dShort(extras.satellite.latest)}` : '—', ok: daysOld(extras.satellite?.latest) < 3 },
  ];
  $('#sources').innerHTML = items.map((x) =>
    `<li title="${x.ok ? 'al día' : 'demorada o sin respuesta'}"><span class="ico ${x.ok ? 'ok' : 'alerta'}"></span>${x.k} <b>${x.v}</b></li>`).join('') +
    (fresh ? `<li><button class="sb-btn" style="width:auto;padding:0 8px;font-size:11px" id="reload" type="button">datos nuevos · actualizar</button></li>` : '');
  $('#reload')?.addEventListener('click', () => location.reload());
  const now = new Date();
  $('#clock').textContent = now.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace('.', '').toUpperCase() +
    ' · ' + now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

// Tablero: cuatro estados, cada uno con la lista de lo que está en ese estado. Cada nombre lleva
// exactamente a su dato: el puerto a su hidrómetro, el punto del río a su ficha, la represa a su gráfico.
function stationOfPort(r) {
  return Object.keys(PORTS).find((id) => byId[id] && PORTS[id].includes(norm(r.port)) && portsOf(id).includes(r));
}
function goTo(kind, key, station) {
  pick(station);
  const target =
    kind === 'port' ? document.querySelector(`#heights .gauge-row[data-port="${CSS.escape(key)}"]`) :
    kind === 'dam' ? document.getElementById(`dam-block-${key}`) :
    $('#detail');
  if (!target) return;
  for (let d = target.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  target.classList.remove('flash');
  void target.offsetWidth; // reinicia la animación si se vuelve a elegir el mismo
  target.classList.add('flash');
}
function drawKpis() {
  const sys = readings.filter((r) => r.height_m != null && /PARANA|URUGUAY|PARAGUAY|IGUAZU/.test(norm(r.river)));
  const margin = (r, k) => (r.height_m - (r[k] ?? r.height_m)) ;
  const evac = sys.filter((r) => level(r) === 'evac').sort((a, b) => margin(b, 'evac_m') - margin(a, 'evac_m'));
  const alerta = sys.filter((r) => level(r) === 'alerta').sort((a, b) => margin(b, 'alert_m') - margin(a, 'alert_m'));

  const high = data.stations
    .map((s) => ({ s, sc: score(s, todayIdx), r: s.q[todayIdx] / s.clim.p50[todayIdx] }))
    .filter((x) => x.sc != null && x.sc > 1)
    .sort((a, b) => b.r - a.r);

  const dams = Object.entries(extras.dams || {}).filter(([, d]) => d?.series?.length).map(([id, d]) => {
    const last = d.series.filter((x) => x.outflow != null).at(-1);
    const m = byId[DAM_STATION[id]]?.q[days.indexOf(last?.date)];
    return { id, r: m && last ? last.outflow / m : null };
  }).filter((d) => d.r > 1.25).sort((a, b) => b.r - a.r);

  // pronóstico oficial: puertos que superarían la evacuación (valor central), con la primera fecha
  const fcEvac = (extras.forecastINA?.ports || []).map((f) => {
    const r = sys.find((x) => norm(x.port) === f.port);
    const p = r && f.points.slice(1).find((p) => lvAt(r, p.mid) === 'evac');
    return p ? { r, date: p.date, over: p.mid - r.evac_m } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || b.over - a.over);

  // ítem: link si hay a dónde llevar; si no, texto
  const item = (label, kind, key, station) => station
    ? `<li><button type="button" class="kpi-link" data-kind="${kind}" data-key="${key}" data-st="${station}">${label}</button></li>`
    : `<li>${label}</li>`;
  const tile = (cls, ico, label, items) =>
    `<section class="kpi ${items.length ? cls : ''}"><p class="kicker"><span class="ico ${items.length ? ico : 'ok'}"></span>${label} · ${items.length}</p>` +
    (items.length ? `<ol class="${items.length > 4 ? 'many' : ''}">${items.join('')}</ol>` : `<p class="none">ninguno</p>`) + '</section>';

  $('#kpis').innerHTML = [
    tile('evac', 'evac', 'Evacuación', evac.map((r) => item(portName(r.port), 'port', r.port, stationOfPort(r)))),
    tile('alerta', 'alerta', 'Alerta', alerta.map((r) => item(portName(r.port), 'port', r.port, stationOfPort(r)))),
    tile('alerta', 'alerta', 'Caudal muy alto', high.map((x) => item(x.s.kind === 'trib' ? `río ${x.s.name}` : x.s.name, 'station', x.s.id, x.s.id))),
    tile('evac', 'evac', 'Evacuación pronosticada (INA)', fcEvac.map((x) => item(`${portName(x.r.port)} <span class="nw">${dShort(x.date)}</span>`, 'port', x.r.port, stationOfPort(x.r)))),
  ].join('');
  for (const b of document.querySelectorAll('#kpis .kpi-link')) {
    b.addEventListener('click', () => goTo(b.dataset.kind, b.dataset.key, b.dataset.st));
  }
}

// Lectura de coordenadas bajo el cursor
map.addEventListener('pointermove', (ev) => {
  if (gesture?.moving) return;
  const p = toUser(ev.clientX, ev.clientY);
  const lon = B.w + p.x / (COS * SC), lat = B.n - p.y / SC;
  const f = (v) => nf2.format(Math.abs(v));
  $('#coords').textContent = `${f(lat)}° S · ${f(lon)}° O`;
});
map.addEventListener('pointerleave', () => { $('#coords').textContent = ''; });

// Tema claro / oscuro (la elección se recuerda en este navegador). El botón
// dice lo que va a hacer el clic: "[ oscuro ]" en claro, "[ claro ]" en oscuro.
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
const themeLabel = () => { $('#theme').textContent = isDark() ? 'claro' : 'oscuro'; };
$('#theme').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('tema', root.dataset.theme); } catch {}
  themeLabel();
  drawAll();
});
themeLabel();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeLabel);

// ¿Hay datos nuevos en el servidor? Se avisa en la barra; no se recarga solo, para no perder lo que se está mirando.
let fresh = false;
async function checkFresh() {
  try {
    const r = await fetch('/api/data', { method: 'HEAD', cache: 'no-cache' });
    const lm = r.headers.get('etag');
    if (lm && dataEtag && lm !== dataEtag) fresh = true;
    dataEtag ||= lm;
  } catch {}
  drawStatus();
}
let dataEtag = null;
checkFresh();
setInterval(checkFresh, 10 * 60e3);
setInterval(drawStatus, 30e3);

// Marco del mapa como un eje de matplotlib: longitudes abajo y latitudes a la izquierda, con un
// paso que se adapta al zoom. Se dibuja en una capa aparte, en píxeles de pantalla.
function drawMapAxes() {
  const ax = $('#map-axes');
  const wr = ax.getBoundingClientRect(), mr = map.getBoundingClientRect();
  if (!mr.width || !mr.height) return;
  ax.setAttribute('viewBox', `0 0 ${wr.width} ${wr.height}`);
  ax.replaceChildren();
  const x0 = mr.left - wr.left, y0 = mr.top - wr.top, x1 = x0 + mr.width, y1 = y0 + mr.height;
  const a = toUser(mr.left, mr.top), b = toUser(mr.right, mr.bottom);
  const lonL = B.w + a.x / (COS * SC), lonR = B.w + b.x / (COS * SC);
  const latT = B.n - a.y / SC, latB = B.n - b.y / SC;
  const stepFor = (span) => [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02].find((s) => span / s >= 3.5) ?? 0.01;
  const deg = (v, s) => nf2.format(Math.abs(v)).replace(/,?0+$/, '') + '°';
  const sl = stepFor(lonR - lonL), sa = stepFor(latT - latB);
  for (let v = Math.ceil(lonL / sl) * sl; v <= lonR + 1e-9; v += sl) {
    const X = x0 + ((v - lonL) / (lonR - lonL)) * mr.width;
    el('line', { x1: X, x2: X, y1: y1, y2: y1 + 4, class: 'tick' }, ax);
    el('text', { x: X, y: y1 + 16, 'text-anchor': 'middle' }, ax).textContent = deg(v, sl) + 'O';
  }
  for (let v = Math.floor(latT / sa) * sa; v >= latB - 1e-9; v -= sa) {
    const Y = y0 + ((latT - v) / (latT - latB)) * mr.height;
    el('line', { x1: x0 - 4, x2: x0, y1: Y, y2: Y, class: 'tick' }, ax);
    el('text', { x: x0 - 7, y: Y + 4, 'text-anchor': 'end' }, ax).textContent = deg(v, sa) + 'S';
  }
}
MAP_AXES = drawMapAxes;

function drawAll() { readColors(); drawLegend(); select(SEL); setT(T); drawDams(); drawKpis(); drawStatus(); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);
// ---------- interacción del mapa: rueda, doble clic, arrastre, pellizco y botones
const toUser = (cx, cy, ctm = map.getScreenCTM().inverse()) => new DOMPoint(cx, cy).matrixTransform(ctm);
function zoomed() { applyView(); drawMap(); scheduleSat(); }
function zoomAt(cx, cy, f) {
  const p = toUser(cx, cy);
  const w = clamp(view.w / f, wMin(), wMax()), r = w / view.w;
  view = { x: p.x - (p.x - view.x) * r, y: p.y - (p.y - view.y) * r, w, h: w * ASP };
  zoomed();
}
const zoomCenter = (f) => { const r = map.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
map.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(ev.clientX, ev.clientY, Math.pow(1.0015, -ev.deltaY)); }, { passive: false });
map.addEventListener('dblclick', (ev) => { ev.preventDefault(); zoomAt(ev.clientX, ev.clientY, ev.shiftKey ? 0.5 : 2); });
$('#zin').addEventListener('click', () => zoomCenter(2));
$('#zout').addEventListener('click', () => zoomCenter(0.5));
$('#zhome').addEventListener('click', () => { view = home(); zoomed(); });

const ptrs = new Map();
let gesture = null, dragged = false;
map.addEventListener('pointerdown', (ev) => {
  ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  const ctm = map.getScreenCTM().inverse();
  if (ptrs.size === 1) gesture = { kind: 'pan', id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, v0: { ...view }, ctm, moving: false };
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), m0: toUser((a.x + b.x) / 2, (a.y + b.y) / 2, ctm), v0: { ...view }, ctm };
    for (const id of ptrs.keys()) map.setPointerCapture?.(id);
  }
});
map.addEventListener('pointermove', (ev) => {
  if (!ptrs.has(ev.pointerId) || !gesture) return;
  ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (gesture.kind === 'pan') {
    if (!gesture.moving && Math.hypot(ev.clientX - gesture.x0, ev.clientY - gesture.y0) < 4) return;
    if (!gesture.moving) { gesture.moving = true; map.setPointerCapture?.(ev.pointerId); map.classList.add('panning'); hideTip(); }
    const u0 = toUser(gesture.x0, gesture.y0, gesture.ctm), u = toUser(ev.clientX, ev.clientY, gesture.ctm);
    view = { ...gesture.v0, x: gesture.v0.x - (u.x - u0.x), y: gesture.v0.y - (u.y - u0.y) };
    applyView();
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const f = Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0;
    const m1 = toUser((a.x + b.x) / 2, (a.y + b.y) / 2, gesture.ctm);
    const w = clamp(gesture.v0.w / f, wMin(), wMax()), r = w / gesture.v0.w;
    const m = gesture.m0;
    view = { x: m.x - (m.x - gesture.v0.x) * r - (m1.x - m.x) * r, y: m.y - (m.y - gesture.v0.y) * r - (m1.y - m.y) * r, w, h: w * ASP };
    applyView();
  }
});
function endPointer(ev) {
  if (!ptrs.delete(ev.pointerId)) return;
  if (gesture && (gesture.moving || gesture.kind === 'pinch')) { dragged = true; drawMap(); scheduleSat(); }
  map.classList.remove('panning');
  gesture = null;
}
map.addEventListener('pointerup', endPointer);
map.addEventListener('pointercancel', endPointer);
// después de arrastrar, el clic que dispara el navegador no debe elegir un punto
map.addEventListener('click', (ev) => { if (dragged) { ev.stopPropagation(); dragged = false; } }, true);

// ---------- fondo satelital opcional (Sentinel-2) del área visible
// La proyección del mapa es lineal en lon/lat, así que una imagen EPSG:4326 calza estirada al rectángulo.
let satOn = false, satTimer = null, satSeq = 0;
function scheduleSat() { clearTimeout(satTimer); satTimer = setTimeout(loadSat, 300); }
// Mosaicos de 256 px en grilla lat/lon (nivel n = 180/2^n grados): se eligen los que cubren el
// área visible al nivel que da ~1 píxel de imagen por píxel de pantalla. La grilla es fija, así que
// cada mosaico se pide una sola vez (y lo cachean el servidor y el navegador).
const tileLevels = new Map(); // nivel → { g, keys }
function loadSat() {
  map.classList.toggle('sat-on', satOn);
  if (!satOn) { gSat.replaceChildren(); tileLevels.clear(); return; }
  const r = map.getBoundingClientRect();
  const a = toUser(r.left, r.top), b = toUser(r.right, r.bottom);
  const x0 = clamp(a.x, 0, W), x1 = clamp(b.x, 0, W), y0 = clamp(a.y, 0, H), y1 = clamp(b.y, 0, H);
  if (x1 - x0 < 1 || y1 - y0 < 1) return;
  const lon = (x) => B.w + x / (COS * SC), lat = (y) => B.n - y / SC;
  const dpp = (lon(x1) - lon(x0)) / ((x1 - x0) / (b.x - a.x) * r.width * Math.min(devicePixelRatio || 1, 2));
  const n = clamp(Math.ceil(Math.log2(180 / (256 * dpp))), 3, 13), deg = 180 / 2 ** n;
  const c0 = Math.floor((lon(x0) + 180) / deg), c1 = Math.floor((lon(x1) + 180) / deg);
  const r0 = Math.floor((90 - lat(y0)) / deg), r1 = Math.floor((90 - lat(y1)) / deg);
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > 120) return;

  let lv = tileLevels.get(n);
  if (!lv) { lv = { g: el('g', {}), keys: new Set() }; tileLevels.set(n, lv); }
  gSat.appendChild(lv.g); // el nivel actual, arriba de los anteriores mientras carga
  let pending = 0;
  const prune = () => { for (const [k, o] of tileLevels) if (k !== n) { o.g.remove(); tileLevels.delete(k); } };
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const key = row + '/' + col;
      if (lv.keys.has(key)) continue;
      lv.keys.add(key);
      const [tx, ty] = P([col * deg - 180, 90 - row * deg]);
      const [tx2, ty2] = P([(col + 1) * deg - 180, 90 - (row + 1) * deg]);
      // un pelo de solapamiento evita las costuras entre mosaicos
      const img = el('image', { x: tx, y: ty, width: (tx2 - tx) * 1.004, height: (ty2 - ty) * 1.004, preserveAspectRatio: 'none' }, lv.g);
      pending++;
      const done = () => { if (--pending === 0 && tileLevels.get(n) === lv) prune(); };
      img.addEventListener('load', done);
      img.addEventListener('error', done);
      img.setAttribute('href', `/api/tiles/${n}/${row}/${col}.jpg`);
    }
  }
  if (!pending) prune();
}
$('#zsat').addEventListener('click', (ev) => {
  satOn = !satOn;
  ev.currentTarget.setAttribute('aria-pressed', satOn);
  loadSat();
});
// El mapa sigue el tamaño de su elemento (ventana, fuentes, layout): si estaba en el encuadre de inicio, se vuelve a encuadrar
let lastSize = mapSize().w + 'x' + mapSize().h;
function onMapResize() {
  const s = mapSize(), key = s.w + 'x' + s.h;
  if (key === lastSize) return;
  lastSize = key;
  const wasHome = isHome();
  updateAsp();
  if (wasHome) view = home();
  applyView(); drawMap(); drawLegend(); drawMapAxes(); scheduleSat();
}
addEventListener('resize', onMapResize);
drawAll();
lastReported = SEL; statsReady = true; // desde acá, cada elección de localidad cuenta
// el marco del mapa sigue al tamaño real del elemento (cambios de layout, fuentes, ventana)
new ResizeObserver(onMapResize).observe(map);
drawMapAxes();
if (HASH[2]) focusStation(SEL, +HASH[2], false);
if (HASH[3]) $('#zsat').click();
