// Compartir la vista actual con tres íconos, debajo del selector de fecha: WhatsApp, X y copiar el enlace.
//
//   initShare({ container, page: 'mapa' | 'monitor', get: () => ({ text, url }) })
//
// `get` se llama al tocar un ícono, así comparte el estado de ese momento (el zoom, el barrio y la fecha viajan en el enlace).
// WhatsApp usa wa.me, que en el celular abre la app y en la compu, WhatsApp Web.
const ICONS = {
  wa: '<path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<path d="M9 8.3c-.3 3.500 2.900 6.800 6.700 6.700l1-1.500-2.100-1-.9.800c-1-.4-1.800-1.200-2.200-2.200l.8-.9-1-2.100z" fill="currentColor"/>',
  x: '<path d="M18.901 1.153h3.680l-8.040 9.190L24 22.846h-7.406l-5.800-7.584-6.638 7.584H.474l8.600-9.830L0 1.154h7.594l5.243 6.932ZM17.610 20.644h2.039L6.486 3.240H4.298Z" transform="translate(2.500 2.500) scale(.8)" fill="currentColor"/>',
  copy: '<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ok: '<path d="M5 12.500l4.500 4.500L19 7.500" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${ICONS[k]}</svg>`;

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { // sin permiso de portapapeles (http, navegadores viejos): se copia desde un campo temporal
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    t.remove();
    return ok;
  }
}

// el enlace compartido lleva ?via=wa|x|link (antes del #), para saber por qué botón llegó cada visita
const withVia = (url, via) => { const [base, hash] = url.split('#'); return `${base}${base.includes('?') ? '&' : '?'}via=${via}${hash != null ? '#' + hash : ''}`; };
const beacon = (page, sh) => { try { navigator.sendBeacon('/api/hit', new Blob([JSON.stringify({ sh, p: page })], { type: 'application/json' })); } catch {} };

export function initShare({ container, page, get }) {
  container.classList.add('share-row');
  container.innerHTML =
    '<span class="share-hint muted" aria-live="polite">compartir</span>' +
    `<button type="button" class="share-btn" data-k="wa" title="Compartir por WhatsApp" aria-label="Compartir por WhatsApp">${svg('wa')}</button>` +
    `<button type="button" class="share-btn" data-k="x" title="Compartir en X" aria-label="Compartir en X">${svg('x')}</button>` +
    `<button type="button" class="share-btn" data-k="copy" title="Copiar enlace" aria-label="Copiar enlace">${svg('copy')}</button>`;
  const hint = container.querySelector('.share-hint');
  let timer = 0;
  const say = (msg) => { hint.textContent = msg; clearTimeout(timer); timer = setTimeout(() => { hint.textContent = 'compartir'; }, 1800); };

  container.addEventListener('click', async (ev) => {
    const b = ev.target.closest('.share-btn');
    if (!b) return;
    const d = get(), enc = encodeURIComponent;
    if (b.dataset.k === 'wa') { beacon(page, 'wa'); window.open(`https://wa.me/?text=${enc(`${d.text} ${withVia(d.url, 'wa')}`)}`, '_blank', 'noopener'); }
    else if (b.dataset.k === 'x') { beacon(page, 'x'); window.open(`https://twitter.com/intent/tweet?text=${enc(d.text)}&url=${enc(withVia(d.url, 'x'))}`, '_blank', 'noopener'); }
    else {
      const ok = await copyText(withVia(d.url, 'link'));
      if (ok) beacon(page, 'link');
      say(ok ? 'enlace copiado' : 'no se pudo copiar');
      if (ok) { b.innerHTML = svg('ok'); setTimeout(() => { b.innerHTML = svg('copy'); }, 1800); }
    }
  });
}
