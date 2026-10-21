// Mapa de barrios populares: página aparte, casi a pantalla completa, con zoom hasta cada barrio.
// Motor propio y sin dependencias: grilla de mosaicos lat/lon (la misma del servidor), capas apilables
// y una capa vectorial en SVG que se reproyecta en cada cuadro. Sumar una capa nueva es agregar una
// entrada en LAYERS (raster por mosaicos) o dibujar en la capa vectorial.
import { createRise } from './rise.js';
import { createRutas, CLS, TXT } from './rutas.js';

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, f) => a + (b - a) * f;
const nf = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const parseDay = (iso) => new Date(iso + 'T12:00:00');
const dShort = (iso) => parseDay(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace('.', '');
const dLong = (iso) => parseDay(iso).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const json = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(u))));

// ---------- datos
const [data, extras, ratingsDoc, barrios, geo, cauDoc, pDoc, munDoc] = await Promise.all([
  json('/api/data'),
  json('/api/extras').catch(() => ({})),
  json('/ratings.json').catch(() => ({})),
  json('/barrios.json'),
  json('geo.json'),
  json('/cauces.json').catch(() => null),
  json('/puertos.json').catch(() => null),
  json('/municipios.json').catch(() => null),
]).catch((e) => {
  $('#stage').insertAdjacentHTML('afterbegin', '<p class="float" style="top:50px;left:10px;padding:8px 12px">No se pudieron cargar los datos. Probá de nuevo en un minuto.</p>');
  throw e;
});
const rise = createRise({ data, extras, ratings: ratingsDoc.estaciones || {} });
const days = data.days;
// las dos escalas del Paraguay (altura medida) no son puntos de caudal del monitor: tienen nombre propio
const byId = { ...rise.byId, paraguay_formosa: { name: 'Formosa (río Paraguay)' }, paraguay_clorinda: { name: 'Puerto Pilcomayo (río Paraguay)' } };
// ríos menores con boya del INA (scripts/build-cauces.mjs): cada boya tiene nombre propio y no figura en el monitor
const CAUCES = cauDoc?.cauces ?? [];
for (const c of CAUCES) for (const g of c.gauges) byId[g.id] = { name: `${c.name} · ${g.place}`, cauce: true };
const monitorId = (st) => (byId[st]?.cauce ? null : st.startsWith('paraguay_') ? 'paraguay' : st);
const TODAY_AR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
let todayIdx = days.findLastIndex((d) => d <= TODAY_AR);
if (todayIdx < 0) todayIdx = 0;
let T = todayIdx;
const BAR = barrios.barrios;

// ---------- tema (mismo comportamiento que el monitor)
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
const themeLabel = () => { $('#theme').textContent = isDark() ? 'claro' : 'oscuro'; };
$('#theme').addEventListener('click', () => {
  document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('tema', document.documentElement.dataset.theme); } catch {}
  themeLabel();
});
themeLabel();

// ---------- vista: centro (lon, lat) y zoom z, con z = n cuando un píxel de pantalla es un píxel del mosaico de nivel n
// La proyección es lineal en lon/lat, con la longitud comprimida por cos(30°): conforme en el centro de la cuenca.
const COS = Math.cos(30 * Math.PI / 180);
const ZMIN = 5.2, ZMAX = 17.2, N_MAX = 13;
const view = $('#view'), vec = $('#vec');
let W = 0, H = 0;
const V = { lon: -58.5, lat: -30.5, z: 6 };
const scale = () => (256 * 2 ** V.z) / 180; // píxeles por grado de latitud
const sx = (lon, s = scale()) => (lon - V.lon) * s * COS + W / 2;
const sy = (lat, s = scale()) => (V.lat - lat) * s + H / 2;

function zFor(lonL, lonR, latB, latT, pad = 0.75) {
  const s = Math.min((W * pad) / ((lonR - lonL) * COS), (H * pad) / (latT - latB));
  return clamp(Math.log2((s * 180) / 256), ZMIN, ZMAX);
}
let bounds = { w: 180, e: -180, s: 90, n: -90 };
for (const b of BAR) {
  b.bb = [1e9, 1e9, -1e9, -1e9]; // lonL, latB, lonR, latT
  for (const [x, y] of b.p) { b.bb[0] = Math.min(b.bb[0], x); b.bb[2] = Math.max(b.bb[2], x); b.bb[1] = Math.min(b.bb[1], y); b.bb[3] = Math.max(b.bb[3], y); }
  bounds = { w: Math.min(bounds.w, b.bb[0]), e: Math.max(bounds.e, b.bb[2]), s: Math.min(bounds.s, b.bb[1]), n: Math.max(bounds.n, b.bb[3]) };
  b.nm = norm(`${b.n} ${b.loc} ${b.dep}`);
}
const homeView = () => ({ lon: (bounds.w + bounds.e) / 2, lat: (bounds.s + bounds.n) / 2, z: zFor(bounds.w, bounds.e, bounds.s, bounds.n, 0.92) });

// ---------- capas raster por mosaicos
// Cada capa pide mosaicos de la grilla fija del servidor; al cambiar de nivel, los del nivel anterior
// quedan debajo hasta que carguen los nuevos.
function tileLayer(root, url, { minN = 3, maxN = N_MAX } = {}) {
  const imgs = new Map();
  let wanted = new Set(), on = true;
  const prune = () => {
    const pending = [...wanted].some((k) => { const i = imgs.get(k); return i && !i.dataset.done; });
    for (const [k, i] of imgs) if (!wanted.has(k) && (!pending || i.dataset.keep === '1')) { i.remove(); imgs.delete(k); }
  };
  return {
    set on(v) { on = v; root.style.display = v ? '' : 'none'; if (!v) this.clear(); },
    get on() { return on; },
    clear() { for (const i of imgs.values()) i.remove(); imgs.clear(); wanted = new Set(); },
    render(n0) {
      if (!on) return;
      const s = scale(), n = clamp(n0, minN, maxN), deg = 180 / 2 ** n;
      const lonL = V.lon - W / 2 / (s * COS), lonR = V.lon + W / 2 / (s * COS), latT = V.lat + H / 2 / s, latB = V.lat - H / 2 / s;
      const c0 = Math.floor((lonL + 180) / deg), c1 = Math.floor((lonR + 180) / deg), r0 = Math.floor((90 - latT) / deg), r1 = Math.floor((90 - latB) / deg);
      wanted = new Set();
      if ((c1 - c0 + 1) * (r1 - r0 + 1) <= 150) {
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const k = `${n}/${r}/${c}`;
          wanted.add(k);
          if (!imgs.has(k)) {
            const img = document.createElement('img');
            img.alt = ''; img.decoding = 'async'; img.draggable = false;
            img.dataset.n = n; img.dataset.r = r; img.dataset.c = c;
            const done = () => { img.dataset.done = '1'; prune(); };
            img.addEventListener('load', done);
            img.addEventListener('error', () => { img.style.visibility = 'hidden'; done(); });
            img.src = url(n, r, c);
            root.appendChild(img);
            imgs.set(k, img);
          }
        }
      }
      for (const img of imgs.values()) {
        const m = +img.dataset.n, d = 180 / 2 ** m;
        const x = sx(+img.dataset.c * d - 180, s), y = sy(90 - +img.dataset.r * d, s);
        img.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;
        img.style.width = (d * s * COS + 0.6).toFixed(2) + 'px';
        img.style.height = (d * s + 0.6).toFixed(2) + 'px';
        img.style.zIndex = m === n ? 2 : 1;
        img.dataset.keep = m === n ? '1' : '0';
      }
      prune();
    },
  };
}
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const levelFor = () => Math.round(V.z + (dpr > 1.4 ? 0.5 : 0));
const LAYERS = {
  sat: tileLayer($('#l-sat'), (n, r, c) => `/api/tiles/${n}/${r}/${c}.jpg`),
};

// ---------- capa vectorial: ríos, puntos de caudal y barrios
const gLoc = el('g', {}, vec), gRiv = el('g', {}, vec), gPts = el('g', {}, vec), gRut = el('g', {}, vec), gBar = el('g', {}, vec), gHot = el('g', {}, vec), gLab = el('g', {}, vec); // gHot: los barrios afectados, siempre por encima
const rivPaths = Object.values(geo.stems).map((st) => ({ c: st.c, n: el('path', { class: 'riv' }, gRiv) }));
for (const c of CAUCES) rivPaths.push({ c: c.c, n: el('path', { class: 'riv cau' }, gRiv) });
for (const [id, t] of Object.entries(geo.tribs || {})) rivPaths.push({ c: t.c, n: el('path', { class: id === 'pilcomayo' ? 'riv obs' : 'riv' }, gRiv) });
// estaciones de altura del INA con ubicación propia (Bermejo y Pilcomayo): puntos con su lectura de hoy
// Las escalas de Prefectura (republicadas por el INA) traen su ubicación en puertos.json; las boyas del INA, en la propia lectura.
const PUERTO = Object.fromEntries((pDoc?.puertos ?? []).map((p) => [`${p.port}|${p.river}`, p]));
const GAUGES = (extras.heights?.stations ?? []).map((r) => {
  const p = r.lat == null ? PUERTO[`${r.port}|${r.river}`] : null;
  return p ? { ...r, lat: p.lat, lon: p.lon, alert_m: r.alert_m ?? p.alert ?? null, evac_m: r.evac_m ?? p.evac ?? null, pna: true } : r;
}).filter((r) => r.lat != null && r.lon != null && r.height_m != null);
const gdNodes = GAUGES.map((r, i) => el('circle', { class: 'gd' + (r.pna || r.grp === 'pna' ? ' pna' : ''), r: 4.5, 'data-i': i }, gPts));
const stPts = data.stations.filter((s) => s.kind === 'main' || s.id === 'bermejo' || s.id === 'paraguay').map((s) => ({
  s, dot: el('circle', { class: 'st-pt', r: 3.5 }, gPts), txt: el('text', { dy: -7, 'text-anchor': 'middle' }, gPts),
}));
for (const p of stPts) p.txt.textContent = p.s.name;

// estado de cada barrio en la fecha T
const NEAR_M = 1;
const stateOf = (b, t) => {
  const r = rise.riseAt(b.st, t);
  return r == null || b.x ? 'na' : r >= b.h ? 'wet' : r >= b.h - NEAR_M ? 'near' : 'dry';
};
// altura sobre el agua más cercana → tramo del gradiente (l0 el más bajo); sin dato confiable: lx
const lvOf = (b) => (b.x ? 'lx' : b.h < 2 ? 'l0' : b.h < 4 ? 'l1' : b.h < 7 ? 'l2' : b.h < 12 ? 'l3' : 'l4');
const nodes = BAR.map((b, i) => {
  const halo = el('path', { class: 'bp-halo off' }, gBar);
  const n = el('path', { class: `bp na ${lvOf(b)} dot`, 'data-i': i }, gBar);
  return { b, halo, n, lv: lvOf(b), mode: '', st: 'na', vis: false, d: '' };
});
// diámetro del punto: crece con las familias y, de lejos, se achica para que no se amontonen
const diam = (b) => clamp(6 + Math.sqrt(b.fam || 20) / 2, 6, 15) * (0.4 + 0.6 * clamp((V.z - 5.5) / 5, 0, 1));
let selected = -1, labels = [];
let selRoad = -1;
// estado oficial de las rutas nacionales (Vialidad Nacional); las provinciales no figuran
const EST = extras.rutasEstado || null;
const RUT = EST ? createRutas({ alertas: EST.alertas, parent: gRut, el }) : null;
if (!EST) $('#c-rut').closest('label').hidden = true;
if (!RUT) $('#c-rut').closest('label').hidden = true;
// ---------- localidades: gobiernos locales de las seis provincias (población del Censo 2022) y las ciudades vecinas de las otras
// orillas (población aproximada, solo para ordenar). Criterio: cuanto más cerca el zoom, más chica la población mínima.
const VECINAS = [
  ['Asunción', -57.576, -25.264, 520000], ['Ciudad del Este', -54.611, -25.510, 300000], ['Foz do Iguaçu', -54.585, -25.516, 260000],
  ['Encarnación', -55.867, -27.331, 130000], ['Uruguaiana', -57.088, -29.755, 125000], ['Salto', -57.967, -31.383, 105000],
  ['Paysandú', -58.076, -32.321, 76000], ['Concepción', -57.434, -23.406, 75000], ['Villa Hayes', -57.525, -25.091, 65000],
  ['São Borja', -56.004, -28.660, 60000], ['Mercedes', -58.031, -33.252, 42000], ['Itaqui', -56.553, -29.125, 38000],
  ['Pilar', -58.305, -26.859, 35000], ['Fray Bentos', -58.300, -33.117, 25000], ['Ayolas', -56.883, -27.383, 15000],
  ['Bella Unión', -57.598, -30.259, 12000], ['Nueva Palmira', -58.418, -33.877, 9000],
];
const LOC = [...(munDoc?.municipios ?? []).filter((m) => m.c && m.pob).map((m) => ({ n: m.n, lon: m.c[0], lat: m.c[1], pob: m.pob })),
  ...VECINAS.map(([n, lon, lat, pob]) => ({ n, lon, lat, pob }))].sort((a, b) => b.pob - a.pob);
const locMin = (z) => (z < 6.5 ? 150e3 : z < 7.5 ? 50e3 : z < 8.5 ? 20e3 : z < 9.5 ? 8e3 : z < 10.5 ? 3e3 : z < 11.5 ? 1e3 : 0);
const locNodes = [];
function renderLoc(s) {
  const on = $('#c-loc').checked;
  gLoc.style.display = on ? '' : 'none';
  if (!on) return;
  const min = locMin(V.z), boxes = [];
  let k = 0;
  for (const m of LOC) {
    if (m.pob < min) break; // ordenadas por población
    const x = sx(m.lon, s), y = sy(m.lat, s);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const w = m.n.length * 6.3 + 12, box = [x - 4, y - 8, x + w, y + 6];
    if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue; // se pisa con una más grande
    boxes.push(box);
    if (k >= 160) break;
    let o = locNodes[k];
    if (!o) o = locNodes[k] = { c: el('circle', { r: 2.2, class: 'loc-pt' }, gLoc), t: el('text', { dy: 3.5 }, gLoc) };
    o.c.style.display = o.t.style.display = '';
    o.c.setAttribute('cx', x.toFixed(1)); o.c.setAttribute('cy', y.toFixed(1));
    o.t.setAttribute('x', (x + 5).toFixed(1)); o.t.setAttribute('y', y.toFixed(1));
    if (o.t.textContent !== m.n) o.t.textContent = m.n;
    k++;
  }
  for (; k < locNodes.length; k++) locNodes[k].c.style.display = locNodes[k].t.style.display = 'none';
}
function renderVec() {
  const s = scale(), on = $('#c-riv').checked;
  renderLoc(s);
  // la traza de los ríos es esquemática: de cerca la imagen satelital muestra el río real y la línea desentona
  gRiv.style.display = on && V.z < 9.5 ? '' : 'none';
  gPts.style.display = on ? '' : 'none';
  if (on) {
    for (const r of rivPaths) r.n.setAttribute('d', r.c.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0], s).toFixed(1)},${sy(p[1], s).toFixed(1)}`).join(''));
    GAUGES.forEach((r, i) => {
      const x = sx(r.lon, s), y = sy(r.lat, s), vis = x > -10 && x < W + 10 && y > -10 && y < H + 10 && (V.z >= 7 || !(r.pna || r.grp === 'pna'));
      gdNodes[i].style.display = vis ? '' : 'none';
      if (vis) { gdNodes[i].setAttribute('cx', x.toFixed(1)); gdNodes[i].setAttribute('cy', y.toFixed(1)); }
    });
    for (const p of stPts) {
      const x = sx(p.s.lon, s), y = sy(p.s.lat, s), vis = x > -60 && x < W + 60 && y > -20 && y < H + 20;
      p.dot.style.display = p.txt.style.display = vis ? '' : 'none';
      if (vis) { p.dot.setAttribute('cx', x.toFixed(1)); p.dot.setAttribute('cy', y.toFixed(1)); p.txt.setAttribute('x', x.toFixed(1)); p.txt.setAttribute('y', y.toFixed(1)); }
    }
  }
  if (RUT) {
    gRut.style.display = $('#c-rut').checked ? '' : 'none';
    if ($('#c-rut').checked) RUT.render({ X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s), W, H });
  }
  gBar.style.display = gHot.style.display = $('#c-bar').checked ? '' : 'none';
  if (!$('#c-bar').checked) { gLab.replaceChildren(); labels = []; return; }
  const lonL = V.lon - W / 2 / (s * COS), lonR = V.lon + W / 2 / (s * COS), latT = V.lat + H / 2 / s, latB = V.lat - H / 2 / s;
  const wantLabels = V.z >= 14;
  const lab = [];
  for (const o of nodes) {
    const b = o.b, bb = b.bb;
    const vis = bb[2] >= lonL && bb[0] <= lonR && bb[3] >= latB && bb[1] <= latT;
    if (!vis) { if (o.vis) { o.halo.classList.add('off'); o.n.style.display = 'none'; o.vis = false; } continue; }
    if (!o.vis) { o.n.style.display = ''; o.vis = true; }
    const w = (bb[2] - bb[0]) * s * COS, h = (bb[3] - bb[1]) * s;
    const mode = Math.max(w, h) < 9 ? 'dot' : 'poly';
    if (mode !== o.mode) { o.mode = mode; o.n.setAttribute('class', `bp ${o.st} ${o.lv} ${mode}${o.b === BAR[selected] ? ' sel' : ''}`); o.halo.classList.toggle('off', mode === 'poly'); }
    if (mode === 'dot') {
      const x = sx(b.c[0], s).toFixed(1), y = sy(b.c[1], s).toFixed(1), D = diam(b);
      const d = `M${x},${y}h0.02`;
      o.n.setAttribute('d', d); o.halo.setAttribute('d', d);
      o.n.style.strokeWidth = D + 'px'; o.halo.style.strokeWidth = (D + 3) + 'px';
    } else {
      o.n.setAttribute('d', b.p.map((q, i) => `${i ? 'L' : 'M'}${sx(q[0], s).toFixed(1)},${sy(q[1], s).toFixed(1)}`).join('') + 'Z');
      o.n.style.strokeWidth = '';
    }
    if (wantLabels && lab.length < 70) lab.push([b, sx(b.c[0], s), sy(b.bb[3], s)]);
  }
  // nombres de los barrios cuando se está muy cerca
  while (labels.length > lab.length) labels.pop().remove();
  lab.forEach(([b, x, y], i) => {
    const t = labels[i] || (labels[i] = el('text', { 'text-anchor': 'middle' }, gLab));
    if (t.textContent !== b.n) t.textContent = b.n;
    t.setAttribute('x', x.toFixed(1)); t.setAttribute('y', (y - 5).toFixed(1));
  });
}

// ---------- estado oficial de las rutas nacionales (Vialidad Nacional)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cuando = (iso) => (iso ? new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '') : '');
function drawRutasSum() {
  if (!EST) return;
  $('#rut-sum').innerHTML = `<p class="legend-line small muted"><span class="rt-ico total"></span> corte total <span class="rt-ico parcial"></span> parcial <span class="rt-ico restr"></span> restringida<br>Vialidad Nacional · ${cuando(EST.updated)} · pasá el cursor sobre una ruta</p>`;
}
function updateStates() {
  const c = { wet: [0, 0], near: [0, 0], dry: [0, 0], na: [0, 0] };
  for (const o of nodes) {
    const st = stateOf(o.b, T);
    c[st][0]++; c[st][1] += o.b.fam || 0;
    if (st !== o.st) {
      o.st = st; o.n.setAttribute('class', `bp ${st} ${o.lv} ${o.mode || 'dot'}${o.b === BAR[selected] ? ' sel' : ''}`);
      const g = st === 'wet' || st === 'near' ? gHot : gBar;
      if (o.n.parentNode !== g) { g.appendChild(o.halo); g.appendChild(o.n); }
    }
  }
  const fm = (a) => nf.format(a), hit = c.wet[0] + c.near[0];
  $('#bar-sum').innerHTML =
    `<div class="grad"><span class="muted small">más bajo</span><i class="gbar"></i><span class="muted small">más alto</span></div><p class="small muted lg-note">altura sobre el agua más cercana</p>` +
    `<p class="legend-line small"><span class="bar-ico wet"></span> el río lo alcanza <span class="bar-ico near"></span> le falta menos de 1 m</p>` +
    (hit ? `<p class="small"><b>${fm(c.wet[0])}</b> barrios (<b>${fm(c.wet[1])}</b> familias) con inundación probable en esta fecha${c.near[0] ? `, <b>${fm(c.near[0])}</b> más con inundación posible` : ''}.</p>` : '<p class="small muted">En esta fecha el río no alcanza a ningún barrio.</p>') +
    `<details class="help"><summary class="muted small">cómo se estima</summary><p class="muted small">Estimación, no un aviso oficial. El color es la altura del barrio sobre el agua más cercana, que sale del terreno (SRTM, 30 m) y puede errar varios metros. Cuando el río sube hasta esa altura, el barrio se marca en naranja o rojo: la subida sale del caudal del modelo GloFAS, del pronóstico del INA donde lo hay o, en el Paraguay y los ríos menores, de la altura medida hasta hoy. No cuenta defensas, desagües ni lluvia local. Sin estimación del río: Paraná arriba de Yacyretá (depende de las represas), el Delta (marea), el Pilcomayo y el Bermejo aguas arriba de Puerto Lavalle.</p></details>`;
  if (selected >= 0) drawCard();
}

// ---------- ficha del barrio elegido (corta)
const WORD = { wet: 'inundación probable', near: 'inundación posible (al río le falta menos de 1 m)', dry: 'inundación poco probable', na: 'sin estimación del río' };
function drawCard() {
  const b = BAR[selected], card = $('#card');
  if (!b) { card.hidden = true; return; }
  const st = stateOf(b, T), sta = byId[b.st];
  card.innerHTML = `<button class="btn x" id="card-x" type="button" aria-label="Cerrar">x</button>` +
    `<p class="kicker">barrio-popular</p><h2>${esc(b.n)}</h2><div class="muted">${esc(b.loc || b.dep)}, ${esc(b.prov)}</div>` +
    `<dl><dt>Familias</dt><dd>${b.fam != null ? '~' + nf.format(b.fam) : '—'}</dd>` +
    `<dt>Sobre el agua</dt><dd>${b.x ? 'sin dato confiable' : '~' + nf1.format(Math.max(b.h, 0)) + ' m'}</dd>` +
    `<dt>${dShort(days[T])}</dt><dd class="st ${st}">${WORD[st]}</dd></dl>` +
    `<p class="small muted">Estimación a partir de un modelo de elevación; no es un aviso oficial.${sta && monitorId(b.st) ? ` <a href="./#${monitorId(b.st)}">${esc(sta.name)} en el monitor →</a>` : ''}</p>`;
  card.hidden = false;
  $('#card-x').addEventListener('click', () => select(-1));
}
// ---------- ficha de un tramo de ruta (lo que informa Vialidad)
function drawRoadCard() {
  const card = $('#card');
  if (!RUT || selRoad < 0) return;
  const a = RUT.info(selRoad), lvl = a.estado === 'CORTE TOTAL' ? 'wet' : 'near';
  card.innerHTML = `<button class="btn x" id="card-x" type="button" aria-label="Cerrar">x</button>` +
    `<p class="kicker">ruta-nacional</p><h2>RN ${esc(a.ruta)}</h2><div class="muted">${esc(a.prov)} · ${esc(a.tramo)}</div>` +
    `<dl><dt>Estado oficial</dt><dd class="st ${lvl}">${TXT[a.estado] || esc(a.estado.toLowerCase())}</dd>` +
    `<dt>Calzada</dt><dd>${esc(a.calzada.toLowerCase() || '—')}</dd>` +
    `<dt>Largo del tramo</dt><dd>${a.km != null ? '~' + nf.format(a.km) + ' km' : '—'}</dd>` +
    `<dt>Actualizado</dt><dd>${esc(a.act)}</dd></dl>` +
    (a.obs ? `<p class="small">${esc(a.obs)}</p>` : '') +
    `<p class="small muted">Lo informa Vialidad Nacional. La ubicación en el mapa es aproximada y la restricción puede afectar solo una parte del tramo. Para cortes y desvíos, consultá el <a href="${EST.url}" target="_blank" rel="noopener">estado de rutas</a>.</p>`;
  card.hidden = false;
  $('#card-x').addEventListener('click', () => { selectRoad(-1); });
}
function selectRoad(i) {
  if (i >= 0) select(-1);
  selRoad = i;
  if (RUT) RUT.setSel(i);
  if (i < 0) $('#card').hidden = true; else drawRoadCard();
  schedule();
}
function select(i) {
  if (i >= 0 && selRoad >= 0) { selRoad = -1; if (RUT) RUT.setSel(-1); }
  const prev = BAR[selected] && nodes[selected];
  selected = i;
  if (prev) prev.n.classList.remove('sel');
  if (i >= 0) { nodes[i].n.classList.add('sel'); gHot.appendChild(nodes[i].halo); gHot.appendChild(nodes[i].n); } // al frente
  if (i < 0) $('#card').hidden = true; else drawCard();
  syncHash();
}

// ---------- tooltip al pasar sobre un barrio
const tip = $('#tip');
function tipOf(b) {
  const st = stateOf(b, T);
  return `<b>${esc(b.n)}</b> <span class="muted">· ${esc(b.loc || b.dep)}, ${esc(b.prov)}</span><br>` +
    `<div class="row"><span>Familias</span><span>${b.fam != null ? '~' + nf.format(b.fam) : '—'}</span></div>` +
    `<div class="row"><span>Sobre el agua</span><span>${b.x ? '—' : '~' + nf1.format(Math.max(b.h, 0)) + ' m'}</span></div>` +
    (st === 'wet' || st === 'near' ? `<div class="row"><span>${dShort(days[T])}</span><span><b>${st === 'wet' ? 'inundación probable' : 'inundación posible'}</b></span></div>` : '');
}
vec.addEventListener('mousemove', (ev) => {
  const g = ev.target.closest?.('.bp');
  if (drag.active) { tip.hidden = true; return; }
  let html = g ? tipOf(BAR[+g.dataset.i]) : null;
  const gd = !g ? ev.target.closest?.('.gd') : null;
  if (gd) html = tipGauge(+gd.dataset.i);
  if (!html && RUT && $('#c-rut').checked) {
    const rc = view.getBoundingClientRect(), s = scale();
    const ri = RUT.hit(ev.clientX - rc.left, ev.clientY - rc.top, { X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s) });
    if (ri >= 0) html = tipRoad(ri);
  }
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});
const titulo = (t) => t.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
function tipGauge(i) {
  const r = GAUGES[i];
  const nm = r.port.startsWith(r.river) ? titulo(r.port) : `${titulo(r.river)} · ${titulo(r.port)}`;
  return `<b>${nm}</b><br>Altura <b>${nf1.format(r.height_m)} m</b>${r.state ? ' · ' + r.state.toLowerCase() : ''}<br>` +
    (r.alert_m != null ? `<div class="row"><span>Alerta / evacuación</span><span>${nf1.format(r.alert_m)} / ${r.evac_m != null ? nf1.format(r.evac_m) : '—'} m</span></div>` : '') +
    `<span class="muted">${r.date}${r.time ? ' ' + r.time : ''} · ${r.pna || r.grp === 'pna' ? 'escala de Prefectura, vía INA' : 'medición del INA'}${r.alert_m == null ? ', sin nivel de alerta' : ''}</span>`;
}
function tipRoad(ri) {
  const a = RUT.info(ri);
  return `<b>RN ${esc(a.ruta)}</b> <span class="muted">· ${esc(a.prov)}</span><br>${esc(a.tramo)}<br>` +
    `<div class="row"><span>Estado oficial</span><span><b>${TXT[a.estado] || esc(a.estado.toLowerCase())}</b></span></div>` +
    `<div class="row"><span>Calzada</span><span>${esc(a.calzada.toLowerCase() || '—')}</span></div>` +
    `<div class="row"><span>Largo del tramo</span><span>${a.km != null ? '~' + nf.format(a.km) + ' km' : '—'}</span></div>` +
    `<div class="row"><span>Actualizado</span><span>${esc(a.act)}</span></div>` +
    (a.obs ? `<div class="small" style="margin-top:4px;max-width:320px">${esc(a.obs.slice(0, 260))}${a.obs.length > 260 ? '…' : ''}</div>` : '') +
    `<div class="muted small" style="margin-top:3px">Lo informa Vialidad Nacional; ubicación aproximada.</div>`;
}
vec.addEventListener('mouseleave', () => { tip.hidden = true; });

// ---------- dibujo
let dirty = false;
function render() {
  dirty = false;
  if (!W) return;
  view.classList.toggle('sat', LAYERS.sat.on);
  const n = levelFor();
  LAYERS.sat.render(n);
  renderVec();
  syncHash();
}
const schedule = () => { if (!dirty) { dirty = true; requestAnimationFrame(render); } };
new ResizeObserver(() => { const r = view.getBoundingClientRect(); W = r.width; H = r.height; vec.setAttribute('viewBox', `0 0 ${W} ${H}`); schedule(); }).observe(view);

let hashTimer = null;
function syncHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = `#${V.z.toFixed(2)}/${V.lat.toFixed(4)}/${V.lon.toFixed(4)}${selected >= 0 ? '/b' + BAR[selected].id : ''}`;
    try { history.replaceState(null, '', h); } catch {}
  }, 300);
}

// ---------- movimiento: arrastre, rueda, pellizco, teclado, botones y vuelos
const clampView = () => {
  V.z = clamp(V.z, ZMIN, ZMAX);
  V.lon = clamp(V.lon, -70, -40); V.lat = clamp(V.lat, -40, -10);
};
let flyRaf = 0;
const stopFly = () => cancelAnimationFrame(flyRaf);
function panBy(dx, dy) { const s = scale(); V.lon -= dx / (s * COS); V.lat += dy / s; clampView(); schedule(); }
function zoomAt(px, py, dz) {
  const s0 = scale(), lon = V.lon + (px - W / 2) / (s0 * COS), lat = V.lat - (py - H / 2) / s0;
  V.z = clamp(V.z + dz, ZMIN, ZMAX);
  const s1 = scale();
  V.lon = lon - (px - W / 2) / (s1 * COS); V.lat = lat + (py - H / 2) / s1;
  clampView(); schedule();
}
function flyTo(t, ms = 750) {
  stopFly();
  const to = { lon: t.lon, lat: t.lat, z: clamp(t.z, ZMIN, ZMAX) };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) { Object.assign(V, to); clampView(); schedule(); return; }
  const from = { ...V }, t0 = performance.now();
  const step = (now) => {
    const f = Math.min(1, (now - t0) / ms), e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    // al alejarse y volver a acercarse, el trayecto largo "sube" un poco para no marear
    V.lon = lerp(from.lon, to.lon, e); V.lat = lerp(from.lat, to.lat, e); V.z = lerp(from.z, to.z, e);
    schedule();
    if (f < 1) flyRaf = requestAnimationFrame(step);
  };
  flyRaf = requestAnimationFrame(step);
}
const flyToBox = (bb, pad = 0.5) => flyTo({ lon: (bb[0] + bb[2]) / 2, lat: (bb[1] + bb[3]) / 2, z: Math.min(zFor(bb[0], bb[2], bb[1], bb[3], pad), 16.2) });

const drag = { active: false, moved: false };
const ptrs = new Map();
let pinch = null;
view.addEventListener('pointerdown', (ev) => {
  if (ev.button > 0) return;
  stopFly();
  ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY });
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: V.z }; }
  drag.moved = false;
});
view.addEventListener('pointermove', (ev) => {
  const p = ptrs.get(ev.pointerId);
  if (!p) return;
  const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
  if (ptrs.size === 1) {
    if (!drag.moved && Math.hypot(ev.clientX - p.sx, ev.clientY - p.sy) < 4) return;
    if (!drag.moved) { drag.moved = true; drag.active = true; view.classList.add('panning'); try { view.setPointerCapture(ev.pointerId); } catch {} tip.hidden = true; }
    p.x = ev.clientX; p.y = ev.clientY;
    panBy(dx, dy);
  } else if (ptrs.size === 2 && pinch) {
    p.x = ev.clientX; p.y = ev.clientY;
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    const r = view.getBoundingClientRect();
    const target = clamp(pinch.z + Math.log2(d / pinch.d), ZMIN, ZMAX);
    zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, target - V.z);
    drag.moved = true; drag.active = true;
  }
});
const endPtr = (ev) => {
  if (!ptrs.delete(ev.pointerId)) return;
  if (ptrs.size < 2) pinch = null;
  if (!ptrs.size) { view.classList.remove('panning'); setTimeout(() => { drag.active = false; }, 0); }
};
view.addEventListener('pointerup', endPtr);
view.addEventListener('pointercancel', endPtr);
// el clic que sigue a un arrastre no elige nada
view.addEventListener('click', (ev) => {
  if (drag.moved) { drag.moved = false; return; }
  const g = ev.target.closest?.('.bp');
  if (g) { select(+g.dataset.i); return; }
  if (RUT && $('#c-rut').checked) {
    const rc = view.getBoundingClientRect(), s = scale();
    const ri = RUT.hit(ev.clientX - rc.left, ev.clientY - rc.top, { X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s) }, 12);
    if (ri >= 0) selectRoad(ri);
  }
});
view.addEventListener('wheel', (ev) => {
  ev.preventDefault(); stopFly();
  const r = view.getBoundingClientRect(), k = ev.deltaMode === 1 ? 16 : 1;
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, -ev.deltaY * k * (ev.ctrlKey ? 0.012 : 0.0018));
}, { passive: false });
view.addEventListener('dblclick', (ev) => { const r = view.getBoundingClientRect(); stopFly(); flyAround(ev.clientX - r.left, ev.clientY - r.top, 1); });
function flyAround(px, py, dz) { // zoom animado hacia un punto de la pantalla
  const s = scale();
  flyTo({ lon: V.lon + (px - W / 2) / (s * COS) * (1 - 2 ** -dz), lat: V.lat - (py - H / 2) / s * (1 - 2 ** -dz), z: V.z + dz }, 350);
}
view.addEventListener('keydown', (ev) => {
  const k = ev.key, st = 80;
  if (k === 'ArrowLeft') panBy(st, 0); else if (k === 'ArrowRight') panBy(-st, 0);
  else if (k === 'ArrowUp') panBy(0, st); else if (k === 'ArrowDown') panBy(0, -st);
  else if (k === '+' || k === '=') zoomAt(W / 2, H / 2, 0.5); else if (k === '-') zoomAt(W / 2, H / 2, -0.5);
  else return;
  ev.preventDefault();
});
$('#zin').addEventListener('click', () => flyAround(W / 2, H / 2, 1));
$('#zout').addEventListener('click', () => flyAround(W / 2, H / 2, -1));
$('#zhome').addEventListener('click', () => flyTo(homeView()));

// ---------- fecha
const slider = $('#slider');
slider.max = days.length - 1;
function drawTime() {
  slider.value = T;
  $('#date-label').textContent = dLong(days[T]);
  const n = T - todayIdx;
  $('#date-rel').textContent = n === 0 ? 'hoy' : n < 0 ? `hace ${-n} día${n === -1 ? '' : 's'}` : `pronóstico · en ${n} día${n === 1 ? '' : 's'}`;
}
function setT(t) { T = clamp(t, 0, days.length - 1); drawTime(); updateStates(); }
slider.addEventListener('input', () => { stopPlay(); setT(+slider.value); });
$('#today').addEventListener('click', () => { stopPlay(); setT(todayIdx); });
let timer = null;
const play = $('#play');
function stopPlay() { clearInterval(timer); timer = null; play.textContent = '▶'; play.setAttribute('aria-label', 'Reproducir'); }
play.addEventListener('click', () => {
  if (timer) return stopPlay();
  if (T >= days.length - 1 || T === todayIdx) setT(Math.max(0, todayIdx - 60));
  play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pausar');
  timer = setInterval(() => { if (T >= days.length - 1) return stopPlay(); setT(T + 1); }, 160);
});

// ---------- capas: casillas
// en pantallas chicas el panel de capas arranca cerrado para no tapar el mapa
if (matchMedia('(max-width: 760px)').matches) $('#layers details').open = false;
$('#c-sat').addEventListener('change', (ev) => { LAYERS.sat.on = ev.target.checked; schedule(); });
$('#c-bar').addEventListener('change', schedule);
$('#c-riv').addEventListener('change', schedule);
$('#c-loc').addEventListener('change', schedule);
$('#c-rut').addEventListener('change', schedule);
// ---------- búsqueda de barrio o localidad
const q = $('#q'), res = $('#q-res');
let results = [], cur = -1;
function search(text) {
  const t = norm(text).trim();
  if (t.length < 2) return [];
  const locs = new Map();
  for (const b of BAR) if (norm(b.loc || b.dep).includes(t)) {
    const k = `${b.loc || b.dep}|${b.prov}`;
    const l = locs.get(k) || { kind: 'loc', name: b.loc || b.dep, prov: b.prov, n: 0, fam: 0, bb: [1e9, 1e9, -1e9, -1e9] };
    l.n++; l.fam += b.fam || 0;
    l.bb = [Math.min(l.bb[0], b.bb[0]), Math.min(l.bb[1], b.bb[1]), Math.max(l.bb[2], b.bb[2]), Math.max(l.bb[3], b.bb[3])];
    locs.set(k, l);
  }
  const out = [...locs.values()].sort((a, b) => b.n - a.n).slice(0, 3);
  for (const b of BAR) { if (out.length >= 9) break; if (b.nm.includes(t) && norm(b.n).includes(t)) out.push({ kind: 'b', b }); }
  return out;
}
function showResults() {
  res.hidden = !results.length;
  res.innerHTML = results.map((r, i) => r.kind === 'loc'
    ? `<li data-i="${i}" class="${i === cur ? 'on' : ''}"><b>${r.name}</b> <small>· ${r.prov} · ${r.n} barrios, ~${nf.format(r.fam)} familias</small></li>`
    : `<li data-i="${i}" class="${i === cur ? 'on' : ''}">${r.b.n} <small>· ${r.b.loc || r.b.dep}, ${r.b.prov}</small></li>`).join('');
}
function go(r) {
  res.hidden = true; q.blur();
  if (r.kind === 'loc') { flyToBox(r.bb, 0.6); return; }
  const i = BAR.indexOf(r.b);
  flyToBox(r.b.bb, 0.18);
  select(i);
}
q.addEventListener('input', () => { results = search(q.value); cur = -1; showResults(); });
q.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { cur = Math.min(cur + 1, results.length - 1); showResults(); ev.preventDefault(); }
  else if (ev.key === 'ArrowUp') { cur = Math.max(cur - 1, 0); showResults(); ev.preventDefault(); }
  else if (ev.key === 'Enter' && results.length) go(results[Math.max(cur, 0)]);
  else if (ev.key === 'Escape') { res.hidden = true; q.blur(); }
});
res.addEventListener('mousedown', (ev) => { const li = ev.target.closest('li'); if (li) { ev.preventDefault(); go(results[+li.dataset.i]); } });
q.addEventListener('blur', () => setTimeout(() => { res.hidden = true; }, 150));

// ---------- arranque: la vista sale del hash (#zoom/lat/lon[/bID]) o muestra toda la zona
{
  const m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)(?:\/b(\d+))?$/);
  const bi = m && m[4] ? BAR.findIndex((b) => b.id === +m[4]) : -1;
  const wait = () => new Promise((r) => { if (W) r(); else new ResizeObserver((_, o) => { if (view.getBoundingClientRect().width) { o.disconnect(); r(); } }).observe(view); });
  await wait();
  Object.assign(V, m ? { z: +m[1], lat: +m[2], lon: +m[3] } : homeView());
  clampView();
  drawTime(); updateStates(); drawRutasSum();
  if (bi >= 0) select(bi);
  schedule();
}
