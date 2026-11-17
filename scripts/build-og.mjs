// Genera las imágenes de vista previa que aparecen al compartir un enlace (Open Graph / Twitter) y el ícono de iOS.
// Salen del mismo trazo del favicon (public/favicon.svg), en el azul marino y plata del sitio, con el nombre y la bajada de cada página.
//   node scripts/build-og.mjs            → public/og-monitor.png, public/og-mapa.png (1200×630) y public/apple-touch-icon.png (180×180)
// Necesita Chrome o Edge (se usa en modo sin ventana para dibujar el SVG). Otra ruta: CHROME=/ruta/al/navegador.
// Para cambiar un texto, se edita PAGES más abajo y se vuelve a correr.
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!CHROME) { console.error('No encuentro Chrome ni Edge: pasalo en CHROME=/ruta'); process.exit(1); }

const NAVY = '#000080', DEEP = '#000058', SILVER = '#c0c0c0';
const RIVER = 'M11 3c-3 2.5 2 4.5-2 7s-3.5 2.5-3 4'; // el trazo del favicon, en una grilla de 16×16
const MONO = "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

const PAGES = {
  'og-monitor': { title: 'Paraná y Uruguay', sub: 'monitor de caudales, día a día', foot: 'modelo GloFAS · alturas del INA · represas' },
  'og-mapa': { title: 'Mapa de reportes', sub: 'los vecinos marcan dónde hay agua', foot: 'calles anegadas · viviendas · rutas cortadas' },
};

const card = ({ title, sub, foot }) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${MONO}">
  <rect width="1200" height="630" fill="${NAVY}"/>
  <rect x="26" y="26" width="1148" height="578" fill="none" stroke="${SILVER}" stroke-width="2"/>
  <rect x="34" y="34" width="1132" height="562" fill="none" stroke="${SILVER}" stroke-opacity=".35" stroke-width="1"/>
  <g transform="translate(88 115)">
    <rect width="400" height="400" rx="44" fill="${DEEP}" stroke="${SILVER}" stroke-width="3"/>
    <g transform="scale(25)"><path d="${RIVER}" fill="none" stroke="${SILVER}" stroke-width="2.2" stroke-linecap="round"/></g>
  </g>
  <text x="556" y="262" font-size="84" font-weight="700" fill="#fff">:~# caudal<tspan fill="${SILVER}">_</tspan></text>
  <text x="556" y="338" font-size="52" font-weight="700" fill="#fff" fill-opacity=".92">${title}</text>
  <text x="556" y="392" font-size="29" fill="${SILVER}">${sub}</text>
  <line x1="556" y1="432" x2="1112" y2="432" stroke="${SILVER}" stroke-opacity=".45"/>
  <text x="556" y="474" font-size="22" fill="${SILVER}" fill-opacity=".8">${foot}</text>
  <text x="1112" y="548" font-size="30" font-weight="700" fill="#fff" text-anchor="end">caudal.puaj.club</text>
</svg>`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 16 16"><rect width="16" height="16" fill="${NAVY}"/><path d="${RIVER}" fill="none" stroke="${SILVER}" stroke-width="2.2" stroke-linecap="round"/></svg>`;

const tmp = mkdtempSync(path.join(tmpdir(), 'caudal-og-'));
function render(svg, w, h, out) {
  const html = path.join(tmp, 'p.html');
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${NAVY}}svg{display:block}</style>${svg}`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`,
    `--screenshot=${out}`, pathToFileURL(html).href], { stdio: 'ignore' });
  console.log('→', path.relative(ROOT, out));
}
try {
  for (const [name, p] of Object.entries(PAGES)) render(card(p), 1200, 630, path.join(ROOT, 'public', name + '.png'));
  render(icon, 180, 180, path.join(ROOT, 'public', 'apple-touch-icon.png'));
} finally { rmSync(tmp, { recursive: true, force: true }); }
