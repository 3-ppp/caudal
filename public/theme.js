// Tema elegido por la persona, aplicado antes de pintar para evitar un parpadeo.
// Sin elección guardada, manda el sistema operativo.
try {
  const t = localStorage.getItem('tema');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
