// Panel de administración: los reportes como una base de datos (tabla o tablero), con filtros, orden, agrupación, acciones en lote,
// panel lateral de detalle y exportación a CSV. Es de uso interno: pide el mismo acceso que la herramienta de análisis
// (la clave de administrador o un acceso de autoridad, que es de solo lectura).
import { KIND, SEV, ago, vigencia } from './reportes.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nf = new Intl.NumberFormat('es-AR');
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TZ = 'America/Argentina/Buenos_Aires';
const fmt = (ms) => new Date(ms).toLocaleString('es-AR', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));

// ---------- acceso (el mismo que la herramienta de análisis: se guarda en este navegador y viaja en Authorization)
const KEY_STORE = 'caudal-analisis';
let KEY = '';
try { KEY = localStorage.getItem(KEY_STORE) || ''; } catch {}
{
  const m = location.hash.match(/^#k=([\w-]+)$/);
  if (m) { KEY = m[1]; try { localStorage.setItem(KEY_STORE, KEY); } catch {} history.replaceState(null, '', location.pathname); }
}
async function api(url, body) {
  const opts = body ? { method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { authorization: 'Bearer ' + KEY } };
  const r = await fetch(url, opts);
  if (!r.ok) throw Object.assign(new Error(url), { status: r.status });
  return r.json();
}
async function gate() {
  let wrong = '';
  for (;;) {
    if (KEY) {
      try { return await api('/api/analisis/yo'); }
      catch (e) { if (e.status !== 401 && e.status !== 429) throw e; wrong = e.status === 429 ? 'Demasiados intentos. Esperá unos minutos.' : 'Ese código no es válido.'; KEY = ''; try { localStorage.removeItem(KEY_STORE); } catch {} }
    }
    $('#login').hidden = false;
    $('#login-msg').textContent = wrong;
    KEY = await new Promise((resolve) => { $('#login-form').onsubmit = (ev) => { ev.preventDefault(); resolve($('#login-key').value.trim()); }; });
    try { localStorage.setItem(KEY_STORE, KEY); } catch {}
  }
}

// ---------- tema
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
const themeLabel = () => { $('#theme').textContent = isDark() ? 'tema claro' : 'tema oscuro'; };
$('#theme').addEventListener('click', () => { document.documentElement.dataset.theme = isDark() ? 'light' : 'dark'; try { localStorage.setItem('tema', document.documentElement.dataset.theme); } catch {} themeLabel(); });
themeLabel();

const ME = await gate();
$('#login').hidden = true; $('#app').hidden = false;
const ADMIN = ME.role === 'admin';
$('#role').textContent = ADMIN ? 'Administración' : 'Autoridad · solo lectura';
$('#logout').addEventListener('click', () => { try { localStorage.removeItem(KEY_STORE); } catch {} location.reload(); });
if (ADMIN) { $('#nav-acc').hidden = false; const st = $('#nav-stats'); st.hidden = false; st.href = '/stats?key=' + encodeURIComponent(KEY); }

// ---------- estado de la vista (se recuerda lo elegido en este navegador)
const PREF = 'caudal-admin';
let pref = {}; try { pref = JSON.parse(localStorage.getItem(PREF) || '{}'); } catch {}
const S = { rows: [], now: Date.now(), view: pref.view === 'tablero' ? 'tablero' : 'tabla', dias: +pref.dias || 30, group: pref.group || '',
  estados: new Set(), tipos: new Set(), sevs: new Set(), loc: '', q: '', sort: { key: 't', dir: -1 }, sel: new Set(), cur: null, collapsed: new Set() };
const savePref = () => { try { localStorage.setItem(PREF, JSON.stringify({ view: S.view, dias: S.dias, group: S.group })); } catch {} };

const ESTADOS = [['vigente', 'live'], ['por vencer', 'fade'], ['vencido', 'gone'], ['resuelto', 'res'], ['oculto', 'hid']].filter(([e]) => ADMIN || e !== 'oculto');
const ECLS = Object.fromEntries(ESTADOS);
const EORD = Object.fromEntries(ESTADOS.map(([e], i) => [e, i]));
const FADE = 24 * 3600e3;
function estadoOf(r) {
  if (r.h) return 'oculto';
  if (r.dn >= 3 && r.dn > r.up) return 'resuelto'; // tres o más "ya bajó" y más que los "sigue": el mapa público ya no lo muestra
  const rem = r.x - S.now;
  return rem <= 0 ? 'vencido' : rem < FADE ? 'por vencer' : 'vigente';
}

// ---------- datos
async function load(silent = false) {
  try {
    const d = await api(`/api/analisis/reportes?dias=${S.dias}`);
    S.now = d.now;
    S.rows = d.reportes.map((r) => ({ ...r, e: '', dia: dayOf(r.t) }));
    for (const r of S.rows) { r.e = estadoOf(r); r.nm = norm(`${r.n} ${r.loc || ''} #${r.id} ${KIND[r.k]?.n || ''}`); }
    S.rows = S.rows.filter((r) => KIND[r.k]); // un tipo desconocido no debe romper la tabla
    const ids = new Set(S.rows.map((r) => r.id));
    for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
    fillLocs();
    render();
    if (S.cur != null) { if (ids.has(S.cur)) drawPeek(); else closePeek(); }
  } catch (e) {
    if (e.status === 401) { try { localStorage.removeItem(KEY_STORE); } catch {} location.reload(); return; }
    if (!silent) $('#sub').textContent = 'No se pudieron cargar los reportes. Probá de nuevo.';
  }
}
function fillLocs() {
  const cnt = {};
  for (const r of S.rows) if (r.loc) cnt[r.loc] = (cnt[r.loc] || 0) + 1;
  const sel = $('#f-loc');
  sel.innerHTML = '<option value="">Todas las localidades</option>' + Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l, n]) => `<option value="${esc(l)}"${S.loc === l ? ' selected' : ''}>${esc(l)} · ${n}</option>`).join('') + '<option value="__none"' + (S.loc === '__none' ? ' selected' : '') + '>Sin localidad cercana</option>';
}

// ---------- filtros, orden y agrupación
function visible() {
  const q = norm(S.q.trim());
  const rows = S.rows.filter((r) => (!S.estados.size || S.estados.has(r.e)) && (!S.tipos.size || S.tipos.has(r.k)) && (!S.sevs.size || S.sevs.has(String(r.s)))
    && (!S.loc || (S.loc === '__none' ? !r.loc : r.loc === S.loc)) && (!q || r.nm.includes(q)));
  const { key, dir } = S.sort;
  const val = { t: (r) => r.t, x: (r) => r.x, e: (r) => EORD[r.e], k: (r) => r.k, s: (r) => r.s, loc: (r) => r.loc || '', n: (r) => r.n, v: (r) => r.up - r.dn, id: (r) => r.id }[key];
  return rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || b.t - a.t; });
}

// ---------- piezas de la interfaz
const tagE = (e) => `<span class="tag ${ECLS[e]}">${esc(e)}</span>`;
const tagK = (k) => `<span class="tag k"><i class="sw ${k}"></i>${esc(KIND[k].n)}</span>`;
const dots = (s) => `<span class="dots" title="${esc(SEV[s])}"><b>${'●'.repeat(s)}</b><i>${'●'.repeat(3 - s)}</i></span>`;
const votes = (r) => `<span title="sigue así / ya bajó">↑${r.up} ↓${r.dn}</span>`;
const vence = (r) => (r.e === 'vencido' || r.e === 'oculto' || r.e === 'resuelto' ? '—' : r.e === 'por vencer' ? vigencia(r, S.now).t.replace('por vencer · ', '') : fmt(r.x));

function renderCards(rows) {
  const live = rows.filter((r) => r.e === 'vigente' || r.e === 'por vencer').length, fade = rows.filter((r) => r.e === 'por vencer').length;
  const hid = rows.filter((r) => r.e === 'oculto').length, last24 = rows.filter((r) => S.now - r.t < 864e5 && r.e !== 'oculto').length;
  const locs = new Set(rows.filter((r) => r.loc && r.e !== 'oculto').map((r) => r.loc)).size;
  const c = [['all', rows.length, 'En el período'], ['live', live, 'Vigentes'], ['fade', fade, 'Por vencer'], ['24', last24, 'Últimas 24 h'], ['loc', locs, 'Localidades']];
  if (ADMIN) c.push(['hid', hid, 'Ocultos']);
  $('#cards').innerHTML = c.map(([k, n, l]) => `<button class="card" data-card="${k}" type="button"><span class="n">${nf.format(n)}</span><span class="l">${l}</span></button>`).join('');
}
function renderChart(rows) {
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayOf(S.now - i * 864e5));
  const cnt = Object.fromEntries(days.map((d) => [d, 0]));
  for (const r of rows) if (r.e !== 'oculto' && r.dia in cnt) cnt[r.dia]++;
  const max = Math.max(1, ...Object.values(cnt));
  $('#chart').innerHTML = days.map((d) => `<div class="bar" style="height:${Math.max(4, (cnt[d] / max) * 100)}%" title="${d}: ${cnt[d]} reportes"></div>`).join('');
  $('#chart-cap').innerHTML = `<span>Reportes por día · últimos 14 días</span><span>máx. ${max} en un día</span>`;
}
function renderMenus() {
  const menu = (id, items, set) => {
    $('#m-' + id).innerHTML = items.map(([v, label]) => `<label><input type="checkbox" data-f="${id}" value="${esc(v)}"${set.has(v) ? ' checked' : ''}>${label}</label>`).join('');
    $('#p-' + id).classList.toggle('on', set.size > 0);
  };
  menu('estado', ESTADOS.map(([e]) => [e, tagE(e)]), S.estados);
  menu('tipo', Object.keys(KIND).map((k) => [k, tagK(k)]), S.tipos);
  menu('sev', [['1', 'Poca ' + dots(1)], ['2', 'Media ' + dots(2)], ['3', 'Mucha ' + dots(3)]], S.sevs);
}

function rowHTML(r) {
  return `<tr class="row${S.sel.has(r.id) ? ' sel' : ''}${S.cur === r.id ? ' cur' : ''}" data-id="${r.id}">` +
    `<td class="chk">${ADMIN ? `<input type="checkbox" data-chk aria-label="Seleccionar #${r.id}"${S.sel.has(r.id) ? ' checked' : ''}>` : ''}</td>` +
    `<td>${tagE(r.e)}</td><td>${tagK(r.k)}</td><td class="hide-m">${dots(r.s)}</td><td class="m-full" style="white-space:nowrap">${r.loc ? esc(r.loc) : '<span class="dim">sin localidad cercana</span>'}</td>` +
    `<td class="note" title="${esc(r.n)}">${r.n ? esc(r.n) : '—'}</td><td class="dim" title="${esc(fmt(r.t))}">${ago(r.t, S.now)}</td><td class="dim hide-m">${vence(r)}</td><td class="num hide-m">${votes(r)}</td></tr>`;
}
function groupOf(r, g) { return g === 'loc' ? r.loc || 'Sin localidad cercana' : g === 'k' ? KIND[r.k].n : g === 'estado' ? r.e : r.dia; }
function renderTable(rows) {
  if (!rows.length) return '<p class="empty">No hay reportes con estos filtros.</p>';
  const cols = [['e', 'Estado'], ['k', 'Tipo'], ['s', 'Gravedad', 'hide-m'], ['loc', 'Localidad'], ['n', 'Nota'], ['t', 'Creado'], ['x', 'Vence', 'hide-m'], ['v', 'Votos', 'hide-m num']];
  const allSel = rows.every((r) => S.sel.has(r.id));
  const head = `<tr><th class="chk">${ADMIN ? `<input type="checkbox" data-all aria-label="Seleccionar todos"${allSel ? ' checked' : ''}>` : ''}</th>` +
    cols.map(([k, l, c = '']) => `<th class="sortable ${c}" data-sort="${k}">${l}${S.sort.key === k ? (S.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('') + '</tr>';
  let body = '';
  if (S.group) {
    const groups = new Map();
    for (const r of rows) { const g = groupOf(r, S.group); (groups.get(g) || groups.set(g, []).get(g)).push(r); }
    let list = [...groups.entries()];
    list = S.group === 'estado' ? list.sort((a, b) => EORD[a[0]] - EORD[b[0]]) : S.group === 'dia' ? list.sort((a, b) => (a[0] < b[0] ? 1 : -1)) : list.sort((a, b) => b[1].length - a[1].length);
    for (const [g, rs] of list) {
      const closed = S.collapsed.has(g);
      body += `<tr class="grp" data-grp="${esc(g)}"><td colspan="${cols.length + 1}">${closed ? '▸' : '▾'} ${S.group === 'estado' ? tagE(g) : esc(g)}<span class="c">${rs.length}</span></td></tr>`;
      if (!closed) body += rs.map(rowHTML).join('');
    }
  } else body = rows.map(rowHTML).join('');
  return `<div class="tbl-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
function renderBoard(rows) {
  return '<div class="board">' + ESTADOS.map(([e]) => {
    const rs = rows.filter((r) => r.e === e);
    return `<div class="col"><h3>${tagE(e)}<span class="c">${rs.length}</span></h3>` + rs.slice(0, 60).map((r) =>
      `<div class="bcard" data-id="${r.id}"><div class="top">${tagK(r.k)}${dots(r.s)}</div>${r.n ? `<div class="txt">${esc(r.n)}</div>` : ''}<div class="meta">${esc(r.loc || 'sin localidad cercana')} · ${ago(r.t, S.now)} · ${votes(r)}</div></div>`).join('') +
      (rs.length > 60 ? `<p class="meta">y ${rs.length - 60} más: usá los filtros</p>` : '') + '</div>';
  }).join('') + '</div>';
}

function render() {
  const rows = visible();
  $('#n-rep').textContent = S.rows.length ? nf.format(S.rows.length) : '';
  $('#sub').textContent = `${nf.format(S.rows.length)} reportes en el período · ${nf.format(rows.length)} con los filtros actuales`;
  renderCards(S.rows); renderChart(S.rows); renderMenus();
  $('#box').classList.toggle('readonly', !ADMIN);
  $('#box').innerHTML = S.view === 'tablero' ? renderBoard(rows) : renderTable(rows);
  $$('#seg-view button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
  $('#f-dias').value = String(S.dias); $('#g-by').value = S.group; $('#g-by').hidden = S.view === 'tablero';
  const n = S.sel.size;
  $('#bulk').hidden = !ADMIN || !n; $('#bulk-n').textContent = `${nf.format(n)} seleccionado${n === 1 ? '' : 's'}`;
}

// ---------- detalle de un reporte (panel lateral)
function miniMap(r) { // 3×3 mosaicos del satélite (nivel 13) con el punto en el centro
  const deg = 180 / 2 ** 13, col = Math.floor((r.lon + 180) / deg), row = Math.floor((90 - r.lat) / deg);
  const px = ((r.lon + 180) / deg - col) * 256 + 256, py = ((90 - r.lat) / deg - row) * 256 + 256;
  let imgs = '';
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) imgs += `<img alt="" src="/api/tiles/13/${row + dr}/${col + dc}.jpg">`;
  return `<div class="mini"><div class="tiles" style="left:calc(50% - ${px.toFixed(1)}px);top:calc(50% - ${py.toFixed(1)}px)">${imgs}</div><i class="pt"></i><span class="cap">Sentinel-2 © EOX</span></div>`;
}
function drawPeek() {
  const r = S.rows.find((x) => x.id === S.cur), el = $('#peek');
  if (!r) return closePeek();
  const hid = r.e === 'oculto';
  el.innerHTML = `<div class="bar"><span class="dim">Reporte #${r.id}</span><button class="btn sm" data-peek="close" type="button">Cerrar ✕</button></div>` +
    `<h2>${esc(KIND[r.k].n)}</h2><div>${tagE(r.e)}</div>` + miniMap(r) +
    `<dl><dt>Cuánta agua</dt><dd>${dots(r.s)} ${esc(SEV[r.s])}</dd><dt>Localidad</dt><dd>${r.loc ? esc(r.loc) : '<span class="dim">sin localidad cercana</span>'}</dd>` +
    `<dt>Ubicación</dt><dd>${r.lat}, ${r.lon} <span class="dim">(~100 m)</span></dd><dt>Creado</dt><dd>${fmt(r.t)} · ${ago(r.t, S.now)}</dd>` +
    `<dt>Vence</dt><dd>${r.e === 'oculto' || r.e === 'resuelto' ? '—' : fmt(r.x)}${r.e === 'por vencer' ? ` · ${esc(vigencia(r, S.now).t)}` : ''}</dd>` +
    `<dt>Confirmaciones</dt><dd>${r.up} sigue así · ${r.dn} ya bajó</dd></dl>` +
    (r.n ? `<div class="note">“${esc(r.n)}”</div>` : '<p class="dim">Sin nota.</p>') +
    `<p class="dim" style="font-size:12px">Dato de un vecino, sin verificar. Ubicación redondeada a unos 100 m.</p>` +
    `<div class="acts">${ADMIN ? `<button class="btn ${hid ? '' : 'btn-danger'}" data-peek="${hid ? 'show' : 'hide'}" type="button">${hid ? 'Volver a mostrar en el mapa' : 'Ocultar del mapa'}</button>` : ''}` +
    `<a class="btn" href="/analisis#15/${r.lat}/${r.lon}" target="_blank" rel="noopener">Ver en el mapa de análisis ↗</a>` +
    `<button class="btn" data-peek="link" type="button">Copiar enlace público</button></div>`;
  el.hidden = false; $('#scrim').hidden = false;
}
function openPeek(id) { S.cur = id; drawPeek(); render(); }
function closePeek() { S.cur = null; $('#peek').hidden = true; $('#scrim').hidden = true; if (!$('#app').hidden) render(); }

// ---------- acciones
let toastTimer = 0;
function toast(msg) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
async function moderate(ids, accion) {
  try {
    if (ids.length === 1) await api(`/api/admin/reportes/${ids[0]}`, { accion });
    else await api('/api/admin/reportes/lote', { ids, accion });
    toast(accion === 'ocultar' ? `${ids.length} reporte${ids.length === 1 ? '' : 's'} oculto${ids.length === 1 ? '' : 's'} del mapa` : `${ids.length} reporte${ids.length === 1 ? '' : 's'} visible${ids.length === 1 ? '' : 's'} de nuevo`);
    S.sel.clear();
    await load(true);
  } catch { toast('No se pudo completar la acción'); }
}
function exportCSV() {
  const rows = visible(), q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['id', 'creado', 'vence', 'estado', 'tipo', 'gravedad', 'localidad_cercana', 'lat', 'lon', 'nota', 'sigue_asi', 'ya_bajo'].join(',')].concat(rows.map((r) =>
    [r.id, new Date(r.t).toISOString(), new Date(r.x).toISOString(), r.e, KIND[r.k].n, r.s, q(r.loc), r.lat, r.lon, q(r.n), r.up, r.dn].map((v, i) => (i === 3 || i === 4 || i === 6 ? q(v) : v)).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `reportes-${dayOf(Date.now())}.csv`; document.body.appendChild(a); a.click(); a.remove();
  toast(`${rows.length} reportes exportados`);
}

// ---------- eventos
$('#box').addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-all]')) { const rows = visible(); if (t.checked) rows.forEach((r) => S.sel.add(r.id)); else rows.forEach((r) => S.sel.delete(r.id)); render(); return; }
  const th = t.closest('[data-sort]');
  if (th) { const k = th.dataset.sort; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 't' || k === 'x' || k === 'v' || k === 's' ? -1 : 1) }; render(); return; }
  const g = t.closest('[data-grp]');
  if (g) { const k = g.dataset.grp; if (S.collapsed.has(k)) S.collapsed.delete(k); else S.collapsed.add(k); render(); return; }
  const row = t.closest('[data-id]');
  if (!row) return;
  const id = +row.dataset.id;
  if (t.closest('[data-chk]')) { if (t.checked) S.sel.add(id); else S.sel.delete(id); render(); return; }
  openPeek(id);
});
$('#peek').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-peek]');
  if (!b) return;
  const r = S.rows.find((x) => x.id === S.cur);
  if (b.dataset.peek === 'close') closePeek();
  else if (b.dataset.peek === 'hide') moderate([r.id], 'ocultar');
  else if (b.dataset.peek === 'show') moderate([r.id], 'mostrar');
  else if (b.dataset.peek === 'link') { try { await navigator.clipboard.writeText(`${location.origin}/mapa#15/${r.lat}/${r.lon}/r${r.id}`); toast('Enlace copiado'); } catch { toast('No se pudo copiar'); } }
});
$('#scrim').addEventListener('click', closePeek);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && S.cur != null) closePeek(); });
$('#cards').addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-card]');
  if (!c) return;
  S.estados = new Set(); S.tipos = new Set(); S.sevs = new Set(); S.loc = ''; S.q = ''; $('#q').value = '';
  const k = c.dataset.card;
  if (k === 'live') { S.estados = new Set(['vigente', 'por vencer']); } else if (k === 'fade') S.estados = new Set(['por vencer']); else if (k === 'hid') S.estados = new Set(['oculto']);
  else if (k === '24') { S.dias = 1; savePref(); load(); return; } else if (k === 'loc') S.group = 'loc';
  savePref(); render();
});
for (const id of ['estado', 'tipo', 'sev']) $('#m-' + id).addEventListener('change', (ev) => {
  const set = id === 'estado' ? S.estados : id === 'tipo' ? S.tipos : S.sevs, v = ev.target.value;
  if (ev.target.checked) set.add(v); else set.delete(v);
  render();
});
$('#f-loc').addEventListener('change', (ev) => { S.loc = ev.target.value; render(); });
$('#g-by').addEventListener('change', (ev) => { S.group = ev.target.value; S.collapsed.clear(); savePref(); render(); });
$('#f-dias').addEventListener('change', (ev) => { S.dias = +ev.target.value; savePref(); load(); });
let qTimer = 0;
$('#q').addEventListener('input', (ev) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = ev.target.value; render(); }, 160); });
$('#seg-view').addEventListener('click', (ev) => { const b = ev.target.closest('[data-v]'); if (b) { S.view = b.dataset.v; savePref(); render(); } });
$('#csv').addEventListener('click', exportCSV);
$('#refresh').addEventListener('click', () => { load(); toast('Actualizado'); });
$('#bulk-hide').addEventListener('click', () => { const ids = [...S.sel]; if (ids.length && confirm(`¿Ocultar ${ids.length} reporte${ids.length === 1 ? '' : 's'} del mapa público? Se pueden volver a mostrar.`)) moderate(ids, 'ocultar'); });
$('#bulk-show').addEventListener('click', () => { const ids = [...S.sel]; if (ids.length) moderate(ids, 'mostrar'); });
$('#bulk-clear').addEventListener('click', () => { S.sel.clear(); render(); });
// los menús de filtro se cierran al tocar afuera
document.addEventListener('click', (ev) => { for (const d of $$('details.pop[open]')) if (!d.contains(ev.target)) d.open = false; });
$$('.nav[data-view]').forEach((b) => b.addEventListener('click', () => {
  $$('.nav[data-view]').forEach((x) => x.classList.toggle('on', x === b));
  $('#v-reportes').hidden = b.dataset.view !== 'reportes'; $('#v-accesos').hidden = b.dataset.view !== 'accesos';
  if (b.dataset.view === 'accesos') drawAccesos();
}));

// ---------- accesos (solo administración)
async function drawAccesos() {
  try {
    const { accesos } = await api('/api/admin/accesos');
    const f = (ms) => (ms ? new Date(ms).toLocaleDateString('es-AR', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '') : '—');
    $('#acc-list').innerHTML = accesos.length ? `<div class="tbl-wrap"><table style="min-width:0"><thead><tr><th>Para quién</th><th>Creado</th><th>Último uso</th><th>Estado</th><th></th></tr></thead><tbody>` +
      accesos.map((a) => `<tr><td>${esc(a.label)}</td><td class="dim">${f(a.created)}</td><td class="dim">${f(a.last_used)}</td><td>${a.revoked ? '<span class="tag hid">revocado</span>' : '<span class="tag live">activo</span>'}</td><td>${a.revoked ? '' : `<button class="btn sm btn-danger" data-rev="${a.id}" type="button">Revocar</button>`}</td></tr>`).join('') + '</tbody></table></div>' : '<p class="empty">Todavía no hay accesos de autoridad.</p>';
  } catch { $('#acc-list').innerHTML = '<p class="empty">No se pudieron cargar los accesos.</p>'; }
}
$('#acc-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const label = $('#acc-label').value.trim();
  if (!label) return;
  try {
    const { token } = await api('/api/admin/accesos', { label });
    $('#acc-label').value = '';
    $('#acc-new').innerHTML = `<div class="acc-new"><p>Enlace para <b>${esc(label)}</b>. Se muestra una sola vez; quien lo abre queda con acceso de lectura.</p><input readonly value="${location.origin}/admin#k=${token}" aria-label="Enlace de acceso"></div>`;
    $('#acc-new input').select();
    drawAccesos();
  } catch { toast('No se pudo crear el acceso'); }
});
$('#acc-list').addEventListener('click', async (ev) => {
  const id = ev.target.dataset.rev;
  if (id && confirm('¿Revocar este acceso? Deja de funcionar enseguida.')) { try { await api(`/api/admin/accesos/${id}/revocar`, {}); drawAccesos(); } catch { toast('No se pudo revocar'); } }
});

// ---------- guardas contra el flood (solo administración): interruptor de emergencia y tope de reportes por hora
let ajustes = null;
async function loadCtl() {
  if (!ADMIN) return;
  try {
    ajustes = await api('/api/admin/ajustes');
    $('#ctl').hidden = false;
    const open = ajustes.abierto;
    $('#ctl-state').textContent = open ? 'Recibiendo reportes' : 'En pausa · solo lectura';
    $('#ctl-state').className = 'pill ' + (open ? 'ok' : 'off');
    $('#ctl-info').textContent = `${nf.format(ajustes.ultimaHora)} en la última hora de ${nf.format(ajustes.tope)} permitidos`;
    $('#ctl-toggle').textContent = open ? 'Pausar reportes' : 'Reabrir reportes';
    $('#ctl-toggle').className = 'btn sm ' + (open ? 'btn-danger' : 'btn-primary');
    if (document.activeElement !== $('#ctl-tope')) $('#ctl-tope').value = ajustes.tope;
  } catch { /* el resto del panel sigue andando */ }
}
$('#ctl-toggle').addEventListener('click', async () => {
  if (!ajustes) return;
  const msg = ajustes.abierto ? '¿Pausar los reportes? El mapa deja de recibir reportes y confirmaciones nuevos (se sigue viendo lo que hay). Podés reabrirlo cuando quieras.' : '¿Reabrir los reportes?';
  if (!confirm(msg)) return;
  try { ajustes = await api('/api/admin/ajustes', { abierto: !ajustes.abierto }); toast(ajustes.abierto ? 'Reportes abiertos' : 'Reportes en pausa'); loadCtl(); } catch { toast('No se pudo cambiar'); }
});
$('#ctl-save').addEventListener('click', async () => {
  const tope = Math.round(+$('#ctl-tope').value);
  if (!(tope >= 10 && tope <= 100000)) { toast('El tope va de 10 a 100.000'); return; }
  try { ajustes = await api('/api/admin/ajustes', { tope }); toast('Tope guardado'); loadCtl(); } catch { toast('No se pudo guardar'); }
});

// ---------- arranque
await load();
loadCtl();
setInterval(() => { if (!document.hidden && $('#v-reportes').hidden === false) { load(true); loadCtl(); } }, 60e3);
