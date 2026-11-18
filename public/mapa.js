// Mapa público de reportes de vecinos: la imagen satelital y, encima, lo que la gente marca (calles anegadas, agua en viviendas,
// rutas cortadas, río desbordado). Las capas de datos (barrios, ríos, rutas, represas) no están acá: viven en la herramienta de
// análisis para administración y autoridades (analisis.html). Motor propio y sin dependencias: grilla de mosaicos lat/lon (la
// misma del servidor) y una capa vectorial en SVG que se reproyecta en cada cuadro.
import { initShare } from './share.js';
import { createReportLayer, KIND, SEV, SEV_SHORT, ago, vigencia } from './reportes.js';
import { captchaToken } from './captcha.js';
import { createContext } from './contexto.js';

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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nf = new Intl.NumberFormat('es-AR');

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
// la vista inicial muestra el Litoral, de Misiones al Delta
const homeView = () => ({ lon: -57.2, lat: -30.3, z: zFor(-61, -53.4, -36, -24.6, 0.92) });

// ---------- capa raster por mosaicos (satélite)
// Pide mosaicos de la grilla fija del servidor; al cambiar de nivel, los del nivel anterior quedan debajo hasta que carguen los nuevos.
function tileLayer(root, url, { minN = 3, maxN = N_MAX } = {}) {
  const imgs = new Map();
  let wanted = new Set();
  const prune = () => {
    const pending = [...wanted].some((k) => { const i = imgs.get(k); return i && !i.dataset.done; });
    for (const [k, i] of imgs) if (!wanted.has(k) && (!pending || i.dataset.keep === '1')) { i.remove(); imgs.delete(k); }
  };
  return {
    render(n0) {
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
const SAT = tileLayer($('#l-sat'), (n, r, c) => `/api/tiles/${n}/${r}/${c}.jpg`);

// ---------- reportes de vecinos
const gCtx = el('g', {}, vec); // localidades, ríos y medidores: debajo de los reportes
const gRep = el('g', {}, vec);
const REP = createReportLayer({ parent: gRep, el });
let serverNow = Date.now();
let selected = -1; // id del reporte elegido
const repDate = (ms) => new Date(ms).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
async function loadReports() {
  try {
    const d = await fetch('/api/reportes').then((r) => (r.ok ? r.json() : Promise.reject(new Error('reportes'))));
    serverNow = d.now;
    REP.setItems(d.reportes, d.now);
    if (selected >= 0) { if (REP.items.some((r) => r.id === selected)) REP.setSel(selected); else select(-1); }
    const n = d.reportes.length;
    $('#rep-count').innerHTML = n ? `<b>${nf.format(n)}</b> ${n === 1 ? 'reporte vigente' : 'reportes vigentes'} en el mapa.` : 'Todavía no hay reportes vigentes. Si ves agua, sé el primero en marcarla.';
    schedule();
  } catch { $('#rep-count').textContent = 'No se pudieron cargar los reportes.'; }
}
// ---------- contexto: localidades, ríos y medidores (se cargan aparte: si fallan, los reportes siguen andando)
let CTX = null;
const ctxArgs = () => { const s = scale(); return { X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s), W, H, z: V.z, loc: $('#c-loc').checked, riv: $('#c-riv').checked }; };
async function loadContext() {
  try {
    const j = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(u))));
    const [data, extras, geo, cauDoc, pDoc, locDoc] = await Promise.all([
      j('/api/data').catch(() => null), j('/api/extras').catch(() => ({})), j('geo.json'),
      j('/api/capas/cauces.json').catch(() => null), j('/api/capas/puertos.json').catch(() => null), j('/api/localidades.json').catch(() => null)]);
    CTX = createContext({ parent: gCtx, el, data, extras, geo, cauDoc, pDoc, locDoc });
    schedule();
  } catch { /* sin contexto: el mapa sigue mostrando reportes */ }
}
$('#c-loc').addEventListener('change', () => schedule());
$('#c-riv').addEventListener('change', () => schedule());

let voted = {};
try { voted = JSON.parse(sessionStorage.getItem('votos') || '{}'); } catch {}
let CAPTCHA = null; // clave pública de Turnstile (null: el servidor no la pide)
fetch('/api/config').then((r) => r.json()).then((c) => { CAPTCHA = c.captcha || null; }).catch(() => {});

function drawCard() {
  const r = REP.items.find((x) => x.id === selected), card = $('#card');
  if (!r) { card.hidden = true; return; }
  const near = REP.nearby(r), v = voted[r.id];
  card.innerHTML = `<button class="btn x" id="card-x" type="button" aria-label="Cerrar">x</button>` +
    `<p class="kicker">reporte-de-vecinos</p><h2><i class="rp-sw k-${r.k}"></i> ${esc(KIND[r.k].n)}</h2><div class="muted">${ago(r.t, serverNow)} · ${repDate(r.t)}</div>` +
    `<dl><dt>Cuánta agua</dt><dd>${esc(SEV[r.s])}</dd>` +
    `<dt>Vigencia</dt><dd class="st ${vigencia(r, serverNow).k === 'fade' ? 'near' : ''}">${vigencia(r, serverNow).t}</dd>` +
    `<dt>Confirmaciones</dt><dd id="votes">${r.up} sigue · ${r.dn} ya bajó</dd>` +
    `<dt>Cerca (300 m, 24 h)</dt><dd>${near ? `${near} reporte${near === 1 ? '' : 's'} más` : 'ninguno'}</dd></dl>` +
    (r.n ? `<p class="rp-note">“${esc(r.n)}”</p>` : '') +
    `<p class="small muted">Dato de un vecino, sin verificar. Ubicación aproximada.</p>` +
    `<div class="row votes"><button class="btn btn-text${v === 'sigue' ? ' on' : ''}" data-v="sigue" type="button">sigue así</button><button class="btn btn-text${v === 'bajo' ? ' on' : ''}" data-v="bajo" type="button">ya bajó</button></div>` +
    `<p id="vote-msg" class="small muted" role="status"></p>`;
  card.hidden = false;
  $('#card-x').addEventListener('click', () => select(-1));
  card.querySelector('.votes').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-v]');
    if (!b || b.disabled) return;
    const msg = $('#vote-msg'), btns = card.querySelectorAll('[data-v]');
    btns.forEach((x) => { x.disabled = true; });
    msg.textContent = 'enviando…';
    try {
      const cf = await captchaToken(CAPTCHA);
      const res = await fetch(`/api/reportes/${r.id}/voto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: b.dataset.v, cf }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'No se pudo enviar.');
      voted[r.id] = b.dataset.v;
      try { sessionStorage.setItem('votos', JSON.stringify(voted)); } catch {}
      msg.textContent = out.gone ? 'Gracias: con tu voto el reporte se da por resuelto.' : 'Gracias por confirmar.';
      $('#votes').textContent = `${out.up} sigue · ${out.dn} ya bajó`;
      btns.forEach((x) => { x.classList.toggle('on', x === b); });
      loadReports();
    } catch (e) { msg.textContent = e.message; }
    btns.forEach((x) => { x.disabled = false; });
  });
}
function select(id) {
  selected = id;
  REP.setSel(id);
  if (id < 0) $('#card').hidden = true; else drawCard();
  syncHash();
  schedule();
}

// ---------- tooltip al pasar sobre un reporte
const tip = $('#tip');
vec.addEventListener('mousemove', (ev) => {
  if (drag.active) { tip.hidden = true; return; }
  const rc = view.getBoundingClientRect(), s = scale();
  const P = { X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s) };
  const i = REP.hit(ev.clientX - rc.left, ev.clientY - rc.top, P);
  const gi = i < 0 && CTX ? CTX.hitGauge(ev.clientX - rc.left, ev.clientY - rc.top, P, 8) : -1;
  if (i < 0 && gi < 0) { tip.hidden = true; return; }
  if (gi >= 0) tip.innerHTML = CTX.gaugeHtml(gi);
  else {
    const r = REP.items[i];
    tip.innerHTML = `<b>${esc(KIND[r.k].n)}</b> <span class="muted">· ${ago(r.t, serverNow)}</span><br>${esc(SEV_SHORT[r.s])} agua${r.n ? `<br><span class="muted">“${esc(r.n.slice(0, 80))}”</span>` : ''}`;
  }
  tip.hidden = false;
  const b = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + b.width > innerWidth - 8) x = ev.clientX - b.width - 14;
  if (y + b.height > innerHeight - 8) y = ev.clientY - b.height - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});
vec.addEventListener('mouseleave', () => { tip.hidden = true; });

// ---------- dibujo
let dirty = false;
function render() {
  dirty = false;
  if (!W) return;
  view.classList.add('sat');
  SAT.render(levelFor());
  const s = scale();
  CTX?.render(ctxArgs());
  REP.render({ X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s), W, H, z: V.z });
  syncHash();
}
const schedule = () => { if (!dirty) { dirty = true; requestAnimationFrame(render); } };
new ResizeObserver(() => { const r = view.getBoundingClientRect(); W = r.width; H = r.height; vec.setAttribute('viewBox', `0 0 ${W} ${H}`); schedule(); }).observe(view);

// el enlace lleva la vista y el reporte elegido: #zoom/lat/lon[/rID]
let hashTimer = null;
const hashNow = () => `#${V.z.toFixed(2)}/${V.lat.toFixed(4)}/${V.lon.toFixed(4)}${selected >= 0 ? '/r' + selected : ''}`;
function syncHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => { try { history.replaceState(null, '', hashNow()); } catch {} }, 300);
}

// ---------- movimiento: arrastre, rueda, pellizco, teclado, botones y vuelos
const clampView = () => {
  V.z = clamp(V.z, ZMIN, ZMAX);
  V.lon = clamp(V.lon, -72, -40); V.lat = clamp(V.lat, -41, -10);
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
    V.lon = lerp(from.lon, to.lon, e); V.lat = lerp(from.lat, to.lat, e); V.z = lerp(from.z, to.z, e);
    schedule();
    if (f < 1) flyRaf = requestAnimationFrame(step);
  };
  flyRaf = requestAnimationFrame(step);
}
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
  const rc = view.getBoundingClientRect(), s = scale();
  const i = REP.hit(ev.clientX - rc.left, ev.clientY - rc.top, { X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s) }, 18);
  if (i >= 0) { select(REP.items[i].id); return; }
  const gi = CTX ? CTX.hitGauge(ev.clientX - rc.left, ev.clientY - rc.top, { X: (lon) => sx(lon, s), Y: (lat) => sy(lat, s) }, 16) : -1;
  if (gi >= 0) showGauge(gi);
});
// ficha de un medidor (en el celular no hay "pasar el cursor": se toca)
function showGauge(i) {
  select(-1);
  const card = $('#card');
  card.innerHTML = `<button class="btn x" id="card-x" type="button" aria-label="Cerrar">x</button><p class="kicker">medidor</p><div class="gauge-card">${CTX.gaugeHtml(i)}</div><p class="small muted">Altura del río en esa escala; no es un aviso oficial.</p>`;
  card.hidden = false;
  $('#card-x').addEventListener('click', () => { card.hidden = true; });
}
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
$('#go-lit').addEventListener('click', () => flyTo(homeView()));
$('#go-com').addEventListener('click', () => flyTo({ lon: -68.3, lat: -38.7, z: 7 }));
// la ubicación se usa solo para centrar el mapa en este dispositivo: no se envía a ningún lado
function locate(done) {
  if (!navigator.geolocation) return done?.(new Error('Tu navegador no permite usar la ubicación.'));
  navigator.geolocation.getCurrentPosition(
    (p) => { flyTo({ lon: p.coords.longitude, lat: p.coords.latitude, z: 14.5 }); done?.(); },
    () => done?.(new Error('No se pudo obtener tu ubicación. Revisá el permiso del navegador.')),
    { enableHighAccuracy: true, timeout: 10e3, maximumAge: 60e3 });
}
$('#go-me').addEventListener('click', () => locate((e) => { if (e) alert(e.message); }));

// ---------- compartir: el enlace lleva la vista y el reporte elegido
function shareData() {
  const r = REP.items.find((x) => x.id === selected);
  const text = r ? `${KIND[r.k].n} (${ago(r.t, serverNow)}), según un vecino. Mapa de reportes de inundaciones:` : 'Mapa colaborativo de reportes de inundaciones: los vecinos marcan dónde hay agua.';
  return { text, url: location.origin + location.pathname + hashNow() };
}
initShare({ container: $('#share'), page: 'mapa', get: shareData });

// ---------- formulario de reporte: el punto es el centro de la parte libre del mapa (la cruz), así se marca con precisión también desde el celular
const form = $('#rep-form'), pin = $('#pin');
let openedAt = 0;
// el formulario tapa parte del mapa: la cruz va en el centro de lo que queda a la vista (a la izquierda del formulario en la
// compu; arriba del formulario en el celular)
function pinPos() {
  if (form.hidden) return { x: W / 2, y: H / 2 };
  const vr = view.getBoundingClientRect(), fr = form.getBoundingClientRect();
  return fr.width > W * 0.85 ? { x: W / 2, y: Math.max(60, (fr.top - vr.top) / 2) } : { x: Math.max(80, (fr.left - vr.left) / 2), y: H / 2 };
}
function placePin() {
  const { x, y } = pinPos();
  pin.style.left = x + 'px'; pin.style.top = y + 'px';
}
const pinLatLon = () => { const { x, y } = pinPos(), s = scale(); return { lon: V.lon + (x - W / 2) / (s * COS), lat: V.lat - (y - H / 2) / s }; };
$('#rep-kinds').innerHTML = Object.entries(KIND).map(([k, v], i) => `<label class="opt"><input type="radio" name="kind" value="${k}"${i === 0 ? ' checked' : ''}><span><i class="rp-sw k-${k}"></i>${v.n}</span></label>`).join('');
$('#rep-sevs').innerHTML = Object.entries(SEV).map(([k, v]) => `<label class="opt"><input type="radio" name="sev" value="${k}"${k === '2' ? ' checked' : ''}><span>${v}</span></label>`).join('');
// vuela hasta una localidad dejándola bajo la cruz (que no está en el centro de la pantalla: el formulario tapa parte del mapa)
function flyToPin(lon, lat, z) {
  const { x, y } = pinPos(), s = (256 * 2 ** z) / 180;
  flyTo({ lon: lon - (x - W / 2) / (s * COS), lat: lat + (y - H / 2) / s, z });
}
// escribir la localidad: sugiere las que ya tenemos (gobiernos locales de las provincias del mapa y ciudades vecinas) y lleva el mapa hasta ahí;
// si no aparece, se marca a mano en el mapa
const locIn = $('#rep-loc'), locRes = $('#rep-loc-res');
let locHits = [], locCur = -1;
function showLoc() {
  locRes.hidden = !locHits.length;
  locIn.setAttribute('aria-expanded', String(!!locHits.length));
  locRes.innerHTML = locHits.map((l, i) => `<li role="option" data-i="${i}" class="${i === locCur ? 'on' : ''}"><b>${esc(l.n)}</b> <small>· ${esc(l.p)}</small></li>`).join('');
}
function pickLoc(l) {
  locHits = []; showLoc(); locIn.value = `${l.n} (${l.p})`; locIn.blur();
  $('#rep-hint').textContent = `Listo: ahora acercate y dejá la cruz sobre el lugar exacto de ${l.n}.`;
  flyToPin(l.lon, l.lat, 13);
}
locIn.addEventListener('input', () => {
  locCur = -1;
  if (!CTX) { locHits = []; showLoc(); return; }
  locHits = CTX.searchLoc(locIn.value);
  showLoc();
  // sin coincidencias: se avisa que se puede marcar a mano
  if (!locHits.length && locIn.value.trim().length >= 3) $('#rep-hint').textContent = 'No tenemos esa localidad en la lista: movés el mapa hasta el lugar y listo. La cruz marca el punto.';
});
locIn.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { locCur = Math.min(locCur + 1, locHits.length - 1); showLoc(); ev.preventDefault(); }
  else if (ev.key === 'ArrowUp') { locCur = Math.max(locCur - 1, 0); showLoc(); ev.preventDefault(); }
  else if (ev.key === 'Enter' && locHits.length) { pickLoc(locHits[Math.max(locCur, 0)]); ev.preventDefault(); }
  else if (ev.key === 'Escape') { locHits = []; showLoc(); }
});
locRes.addEventListener('pointerdown', (ev) => { const li = ev.target.closest('li'); if (li) { ev.preventDefault(); pickLoc(locHits[+li.dataset.i]); } });
function openForm() {
  select(-1);
  form.hidden = false; pin.hidden = false; $('#rep-btn').hidden = true; $('#share-bar').hidden = true;
  $('#rep-msg').textContent = ''; $('#rep-note').value = ''; locIn.value = ''; locHits = []; showLoc();
  openedAt = Date.now(); zoomOk = null;
  if (V.z < 12) flyTo({ lon: V.lon, lat: V.lat, z: 12.5 });
  document.body.classList.add('reporting');
  placePin();
  checkZoom();
}
function closeForm() {
  form.hidden = true; pin.hidden = true; $('#rep-btn').hidden = false; $('#share-bar').hidden = false;
  document.body.classList.remove('reporting');
}
// con el mapa muy alejado el punto no es preciso: se pide acercarse antes de enviar
let zoomOk = null;
function checkZoom() {
  placePin();
  const ok = V.z >= 11.5;
  $('#rep-send').disabled = !ok;
  // el aviso de zoom solo se escribe cuando cambia el estado, para no pisar los mensajes del buscador de localidad
  if (ok !== zoomOk) { zoomOk = ok; if (!ok) $('#rep-hint').textContent = 'Acercate hasta ver la calle para marcar el lugar con precisión.'; }
}
$('#rep-btn').addEventListener('click', openForm);
$('#rep-cancel').addEventListener('click', closeForm);
setInterval(() => { if (!form.hidden) checkZoom(); }, 400);
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#rep-msg'), btn = $('#rep-send');
  btn.disabled = true; msg.className = 'small muted'; msg.textContent = 'enviando…';
  try {
    const cf = await captchaToken(CAPTCHA);
    const body = {
      ...pinLatLon(), kind: form.querySelector('[name=kind]:checked').value, sev: +form.querySelector('[name=sev]:checked').value,
      note: $('#rep-note').value, hp: $('#rep-hp').value, ms: Date.now() - openedAt, cf,
    };
    const res = await fetch('/api/reportes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'No se pudo enviar el reporte.');
    closeForm();
    await loadReports();
    if (out.id) select(out.id);
    $('#vote-msg') && ($('#vote-msg').textContent = out.dup ? 'Ya habías enviado este reporte: lo mantuvimos vigente.' : 'Gracias: tu reporte ya está en el mapa.');
  } catch (e) { msg.className = 'small st wet'; msg.textContent = e.message; }
  btn.disabled = false; checkZoom();
});

// ---------- arranque: la vista sale del hash (#zoom/lat/lon[/rID]) o muestra toda la zona
{
  const m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)(?:\/r(\d+))?(?:\/.*)?$/);
  const wait = () => new Promise((r) => { if (W) r(); else new ResizeObserver((_, o) => { if (view.getBoundingClientRect().width) { o.disconnect(); r(); } }).observe(view); });
  await wait();
  Object.assign(V, m ? { z: +m[1], lat: +m[2], lon: +m[3] } : homeView());
  clampView();
  schedule();
  loadContext();
  await loadReports();
  if (m?.[4] && REP.items.some((r) => r.id === +m[4])) select(+m[4]);
  setInterval(() => { if (!document.hidden) loadReports(); }, 60e3);
}
