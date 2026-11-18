// Avisos por Telegram al administrador: cada reporte nuevo y un resumen diario de uso. Sin dependencias (API de bots por HTTP).
// Se activa con TELEGRAM_BOT_TOKEN (el bot, de @BotFather) y TELEGRAM_CHAT_ID (el chat o grupo que recibe los avisos); sin ellos no hace nada.
//   TELEGRAM_API   otra dirección de la API (para pruebas); por defecto https://api.telegram.org
//   SITE_URL       dirección pública del sitio para los enlaces; por defecto https://caudal.puaj.club
// Para no inundar el chat en una crecida: el primer reporte avisa enseguida y los que llegan durante el minuto siguiente
// se juntan en un solo mensaje. Los avisos nunca frenan ni rompen el pedido que los origina.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KINDS } from './reports.mjs';

const SEV = { 1: 'poca agua', 2: 'agua media', 3: 'mucha agua' };
const COOLDOWN_MS = 60e3;
const dayAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
const hourAR = () => +new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(new Date());

export function createNotifier({ store, analytics, root, log }) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('telegram: sin TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: no se envían avisos'); return { enabled: false, newReport() {}, start() {} }; }
  const api = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
  const site = (process.env.SITE_URL || 'https://caudal.puaj.club').replace(/\/$/, '');

  // localidad más cercana al punto (para decir "cerca de Corrientes"); sale de la lista de gobiernos locales
  let LOC = [];
  try { LOC = JSON.parse(readFileSync(path.join(root, 'layers', 'municipios.json'), 'utf8')).municipios.filter((m) => m.c).map((m) => ({ n: m.n, p: m.p, lon: m.c[0], lat: m.c[1] })); } catch {}
  function nearest(lat, lon) {
    const cos = Math.cos(lat * Math.PI / 180);
    let best = null, bd = 30; // hasta 30 km
    for (const m of LOC) { const d = Math.hypot((m.lon - lon) * cos * 111.32, (m.lat - lat) * 110.54); if (d < bd) { bd = d; best = m; } }
    return best ? `${best.n} (${best.p})` : null;
  }

  async function send(text) {
    try {
      const res = await fetch(`${api}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }), signal: AbortSignal.timeout(10e3) });
      if (!res.ok) log(`telegram: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    } catch (e) { log('telegram:', e.name === 'TimeoutError' ? 'sin respuesta' : 'no se pudo enviar'); } // sin el mensaje de error: puede traer la dirección con el token
  }

  const line = (r) => {
    const where = nearest(r.lat, r.lon);
    return { head: `${KINDS[r.kind]} · ${SEV[r.sev]}${where ? ` · cerca de ${where}` : ''}`, note: r.note, url: `${site}/mapa#15/${r.lat}/${r.lon}/r${r.id}` };
  };
  let buffer = [], timer = null;
  function flush() {
    timer = null;
    if (!buffer.length) return;
    const items = buffer.splice(0).map(line);
    const text = items.length === 1
      ? `Reporte nuevo\n${items[0].head}${items[0].note ? `\n“${items[0].note}”` : ''}\n${items[0].url}`
      : `${items.length} reportes nuevos\n` + items.slice(0, 12).map((i) => `• ${i.head}${i.note ? ` — “${i.note.slice(0, 60)}”` : ''}\n  ${i.url}`).join('\n') + (items.length > 12 ? `\n… y ${items.length - 12} más` : '');
    send(text);
    timer = setTimeout(flush, COOLDOWN_MS); // durante el minuto siguiente se acumulan y salen juntos
    timer.unref();
  }
  const newReport = (r) => { buffer.push(r); if (!timer) flush(); };

  // resumen del día, una vez, a partir de las 21 h (hora de Argentina) y solo si hubo uso
  async function digest() {
    const day = dayAR();
    if (hourAR() < +(process.env.DIGEST_HOUR ?? 21) || store.getDoc('notify-digest') === day) return;
    const a = analytics.daySummary(day);
    const since = Date.parse(day + 'T00:00:00-03:00');
    const rep = store.get('SELECT COUNT(*) n FROM reports WHERE created >= ?', since).n;
    const act = store.get('SELECT COUNT(*) n FROM reports WHERE hidden = 0 AND expires > ?', Date.now()).n;
    const votes = store.get('SELECT COUNT(*) n FROM report_votes WHERE at >= ?', since).n;
    store.setDoc('notify-digest', day);
    if (!a.views && !rep) return;
    await send(`Resumen de hoy (${day})\nVisitas: ${a.views} (${a.uniques} únicos) · mapa ${a.pages.mapa || 0} · monitor ${a.pages.monitor || 0}\nCompartidos: ${a.shares}\nReportes nuevos: ${rep} (vigentes ahora: ${act}) · confirmaciones: ${votes}`);
  }
  function start() { setInterval(() => digest().catch(() => {}), 60e3).unref(); log('telegram: avisos activados'); }
  return { enabled: true, newReport, start, send, digest };
}
