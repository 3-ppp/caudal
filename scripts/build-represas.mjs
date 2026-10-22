// Genera public/represas.json: las represas del Comahue (Limay y Neuquén), que regulan el caudal de la cuenca de Vaca Muerta.
//   node scripts/build-represas.mjs
// La lista es curada a mano: se eligieron las represas y diques con nombre de OpenStreetMap (© colaboradores, ODbL) dentro de la
// cuenca; las coordenadas son las del dique o la central en OSM, y la potencia, la que figura en OSM para la central.
// Consulta usada para armarla: nwr["waterway"="dam"], nwr["man_made"="dam"] y nwr["power"="plant"]["plant:source"="hydro"] en
// la caja 41,6°S–38,4°S, 71,4°O–67,8°O, de la que se descartaron los tramos sin nombre (hay cientos de muros de canales de riego).
import { writeFile } from 'node:fs/promises';
import { root } from './lib/rio.mjs';

const REPRESAS = [
  { n: 'Alicurá', rio: 'Limay', lat: -40.585, lon: -70.748, mw: 1050 },
  { n: 'Piedra del Águila', rio: 'Limay', lat: -40.19, lon: -69.992, mw: 1400 },
  { n: 'Pichi Picún Leufú', rio: 'Limay', lat: -40.012, lon: -69.985, mw: 285 },
  { n: 'El Chocón', rio: 'Limay', lat: -39.268, lon: -68.757, mw: 1260 },
  { n: 'Arroyito', rio: 'Limay', lat: -39.11, lon: -68.585, mw: 127.8 },
  { n: 'Portezuelo Grande', rio: 'Neuquén', lat: -38.445, lon: -68.944, nota: 'Complejo Cerros Colorados' },
  { n: 'Mari Menuco', rio: 'Neuquén', lat: -38.581, lon: -68.69, nota: 'Complejo Cerros Colorados' },
  { n: 'Loma de la Lata', rio: 'Neuquén', lat: -38.547, lon: -68.615, nota: 'Complejo Cerros Colorados' },
  { n: 'Planicie Banderita', rio: 'Neuquén', lat: -38.561, lon: -68.475, mw: 472, nota: 'Complejo Cerros Colorados' },
  { n: 'El Chañar', rio: 'Neuquén', lat: -38.583, lon: -68.401, nota: 'Complejo Cerros Colorados' },
  { n: 'Ingeniero Ballester', rio: 'Neuquén', lat: -38.726, lon: -68.173, nota: 'dique derivador del riego del Alto Valle' },
];
await writeFile(root('public/represas.json'), JSON.stringify({
  fuente: 'Ubicación y potencia: OpenStreetMap (© colaboradores, ODbL). Lista curada a mano.',
  generado: new Date().toISOString().slice(0, 10), represas: REPRESAS,
}));
console.log('public/represas.json:', REPRESAS.length, 'represas');
