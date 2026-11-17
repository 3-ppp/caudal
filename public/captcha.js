// Captcha de Cloudflare Turnstile. El script de Cloudflare se carga recién cuando alguien envía un reporte o una confirmación
// (no al abrir el mapa), así que quien solo mira no se conecta a Cloudflare. Sin clave (siteKey nulo) no hace nada.
// Se usa el modo "interaction-only": el widget es invisible salvo que Cloudflare pida una verificación.
let loading = null;
const loadScript = () => (loading ||= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.onload = resolve;
  s.onerror = () => { loading = null; reject(new Error('No se pudo cargar la verificación. Revisá tu conexión.')); };
  document.head.appendChild(s);
}));

export async function captchaToken(siteKey) {
  if (!siteKey) return null;
  await loadScript();
  return new Promise((resolve, reject) => {
    const box = document.createElement('div');
    box.className = 'cf-box';
    document.body.appendChild(box);
    let id, timer;
    const end = (fn, v) => { clearTimeout(timer); try { window.turnstile.remove(id); } catch {} box.remove(); fn(v); };
    timer = setTimeout(() => end(reject, new Error('La verificación tardó demasiado. Probá de nuevo.')), 45e3);
    id = window.turnstile.render(box, {
      sitekey: siteKey, appearance: 'interaction-only', language: 'es',
      callback: (t) => end(resolve, t),
      'error-callback': () => end(reject, new Error('No se pudo verificar. Probá de nuevo.')),
    });
  });
}
