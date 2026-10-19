// Pronóstico oficial de alturas del INA (Sistema de Alerta Hidrológico de la Cuenca del Plata).
// API pública: alerta.ina.gob.ar/pub/datos. Modelo "tabprono", escenario central (calId 289):
// emisión semanal, alturas en los hidrómetros de Prefectura a +7 y +14 días, con tres valores
// por fecha (bajo / central / alto).
//   node sources/forecast-ina.mjs   → imprime el último pronóstico
const BASE = 'https://alerta.ina.gob.ar/pub/datos';
const CAL_ID = 289;

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30e3) });
  if (!res.ok) throw new Error(`INA pronóstico: HTTP ${res.status}`);
  return res.json();
}

export async function fetchForecastINA() {
  const list = await getJSON(`${BASE}/seriesProno&calId=${CAL_ID}`);
  const series = list.data || [];
  if (!series.length) throw new Error('INA pronóstico: sin series');
  const ports = [];
  let forecastDate = null;
  for (const s of series) {
    const fd = new Date(s.forecastdate + 'Z'); // fecha de emisión (hora local tratada como fija)
    const t0 = new Date(fd.getTime() - 2 * 864e5).toISOString(), t1 = new Date(fd.getTime() + 40 * 864e5).toISOString();
    const j = await getJSON(`${BASE}/datosProno&calId=${CAL_ID}&seriesId=${s.seriesid}&timeStart=${t0}&timeEnd=${t1}`);
    const byDate = {};
    for (const d of j.data || []) (byDate[d.timestart.slice(0, 10)] ||= []).push(d.valor);
    const days = Object.keys(byDate).sort();
    const issued = (j.responseHeader?.forecastdate || s.forecastdate || '').slice(0, 10);
    forecastDate = forecastDate && forecastDate > issued ? forecastDate : issued;
    ports.push({
      port: norm(s.estacion_nombre),
      name: s.estacion_nombre,
      issued,
      // el primer día es la lectura de partida; los siguientes, el pronóstico
      points: days.map((d) => {
        const v = byDate[d].slice().sort((a, b) => a - b);
        return { date: d, lo: v[0], mid: v[Math.floor((v.length - 1) / 2)], hi: v.at(-1) };
      }),
    });
  }
  return { fetchedAt: new Date().toISOString(), forecastDate, model: 'INA tabprono (central)', source: 'INA, Sistema de Alerta Hidrológico', ports };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('forecast-ina.mjs')) {
  const f = await fetchForecastINA();
  console.log(f.model, '· emitido', f.forecastDate);
  for (const p of f.ports) console.log(p.port.padEnd(14), p.points.map((x) => `${x.date.slice(5)} ${x.mid.toFixed(2)} (${x.lo.toFixed(2)}–${x.hi.toFixed(2)})`).join(' | '));
}
