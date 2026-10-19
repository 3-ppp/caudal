// Cuánto sube el río (en metros) sobre su nivel mediano, en cada estación de caudal y cada fecha.
//
// Curva altura–caudal de cada estación, h = a + b·ln(Q): public/ratings.json (scripts/build-ratings.mjs)
// trae la pendiente b y el caudal mediano, ajustados con años de alturas de Prefectura/INA contra el
// caudal GloFAS. Para las fechas desde la emisión del pronóstico del INA en ese puerto, la subida sigue
// lo que pronostica el INA. Es una estimación: ver el README.
//
// Estaciones "observadas" (Paraguay): sin curva ni pronóstico. La subida de un día es la altura medida por Prefectura
// ese día menos su mediana de los últimos años; solo hay valor para los días con medición (hasta hoy).
const norm = (x) => (x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const parseDay = (iso) => new Date(iso + 'T12:00:00');
const lerp = (a, b, f) => a + (b - a) * f;

// estación de caudal → escalas de Prefectura que la representan (mismo esquema que app.js)
const PORTS = {
  itati: ['ITA IBATE', 'ITATI', 'PASO DE LA PATRIA'], yacyreta: ['ITUZAINGO'], posadas: ['LIBERTADOR', 'PUERTO MANI', 'SANTA ANA', 'POSADAS'],
  corrientes: ['CORRIENTES', 'BARRANQUERAS', 'EMPEDRADO'], bellavista: ['BELLA VISTA'], goya: ['GOYA', 'RECONQUISTA'],
  lapaz: ['ESQUINA', 'LA PAZ', 'SANTA ELENA'], santafe: ['HERNANDARIAS', 'SANTA FE', 'PARANA'], diamante: ['DIAMANTE'],
  rosario: ['SAN LORENZO', 'ROSARIO', 'VICTORIA'], sannicolas: ['VILLA CONSTITUCION', 'SAN NICOLAS'], sanpedro: ['RAMALLO', 'SAN PEDRO'],
  delta: ['BARADERO', 'ZARATE', 'CAMPANA'],
  elsoberbio: ['EL SOBERBIO', 'ALBA POSSE', 'PANAMBI', 'SAN JAVIER'],
  santotome: ['PUERTO CONCEPCION', 'GARRUCHOS', 'SANTO TOME', 'ALVEAR', 'LA CRUZ'],
  pasolibres: ['YAPEYU', 'PASO DE LOS LIBRES', 'BOMPLAND'], montecaseros: ['MONTE CASEROS', 'MOCORETA'],
  concordia: ['SALTO GRANDE ABAJO', 'CONCORDIA', 'YERUA'], colon: ['LA CALERA', 'COLON', 'CONCEPCION DEL URUGUAY'],
  fraybentos: ['CAMPICHUELO'], nuevapalmira: ['PARANACITO'],
  bermejo: ['PUERTO LAVALLE', 'EL COLORADO', 'PUERTO VELAZ'],
};

export function createRise({ data, extras, ratings }) {
  const days = data.days;
  const byId = Object.fromEntries(data.stations.map((s) => [s.id, s]));
  const riverOf = (s) => s.river || 'parana';
  const main = data.stations.filter((s) => s.kind === 'main').sort((a, b) => a.km - b.km);
  const dayIdx = Object.fromEntries(days.map((d, i) => [d, i]));
  const fcOf = (port) => extras.forecastINA?.ports?.find((p) => p.port === norm(port));
  const readings = extras.heights?.stations ?? [];
  const portsOf = (id) => {
    const st = byId[id];
    const river = st.kind === 'trib' ? norm(st.name) : riverOf(st) === 'uruguay' ? 'URUGUAY' : 'PARANA';
    return (PORTS[id] || []).map((p) => readings.find((r) => norm(r.port) === p && norm(r.river).includes(river))).filter(Boolean);
  };

  const slopes = {};
  function slopeFor(id) {
    if (id in slopes) return slopes[id];
    if (ratings[id]) return (slopes[id] = ratings[id].b);
    slopes[id] = null; // evita la recursión; sin ajuste propio, se toma el de la estación más cercana del mismo río
    // solo de una estación cercana (hasta 120 km): más lejos la pendiente del río ya es otra
    const me = byId[id];
    if (!me) return null;
    const near = main.filter((s) => s.id !== id && riverOf(s) === riverOf(me) && Math.abs(s.km - me.km) <= 120)
      .sort((a, b) => Math.abs(a.km - me.km) - Math.abs(b.km - me.km));
    for (const s of near) { const b = slopeFor(s.id); if (b) return (slopes[id] = b); }
    return null;
  }
  const qrefOf = (id) => ratings[id]?.qref ?? (() => {
    const v = byId[id].clim.p50.filter((x) => x > 0).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  })();
  function riseModel(id, t) {
    const b = slopeFor(id), q = byId[id]?.q[t];
    return b == null || !(q > 0) ? null : b * Math.log(q / qrefOf(id));
  }

  const cache = new Map();
  const isObs = (id) => Boolean(ratings[id]?.obs);
  function riseObs(id, t) {
    const r = ratings[id], h = extras.history?.[`${r.river}|${r.port}`]?.[days[t]];
    return h == null ? null : h - r.hmed;
  }
  function riseAt(id, t) {
    const key = id + '|' + t;
    if (cache.has(key)) return cache.get(key);
    if (isObs(id)) { const v = riseObs(id, t); cache.set(key, v); return v; }
    let v = riseModel(id, t);
    const f = v != null && days[t] ? portsOf(id).map((r) => fcOf(r.port)).find(Boolean) : null;
    if (f) {
      const p = f.points, i0 = dayIdx[p[0].date], d = days[t], last = p.at(-1);
      if (i0 != null && d >= p[0].date) {
        const base = riseModel(id, i0);
        let h; // altura del INA en esa fecha, interpolada entre sus puntos
        if (d >= last.date) h = last.mid;
        else {
          const k = p.findIndex((x) => x.date >= d), a = p[Math.max(k - 1, 0)], c = p[k];
          const f2 = a === c ? 0 : (parseDay(d) - parseDay(a.date)) / (parseDay(c.date) - parseDay(a.date));
          h = lerp(a.mid, c.mid, f2);
        }
        if (base != null) {
          v = base + (h - p[0].mid);
          const il = dayIdx[last.date];
          if (d > last.date && il != null && riseModel(id, il) != null) v += riseModel(id, t) - riseModel(id, il); // más allá del INA, sigue el modelo
        }
      }
    }
    cache.set(key, v);
    return v;
  }
  return { riseAt, byId, days, isObs };
}
