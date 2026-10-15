// sources/satellite.mjs - free, no-API-key satellite imagery for <img> use (no CORS needed).
//
// Base  : EOX "Sentinel-2 cloudless" WMS (annual cloud-free mosaic, 10 m).
// Flood : Copernicus GloFAS Global Flood Monitoring (GFM, Sentinel-1 SAR) public GeoServer at EODC.
//
// Both are called as WMS 1.1.1 with SRS=EPSG:4326, which uses lon/lat axis order
// (bbox = west,south,east,north) and avoids the WMS 1.3.0 EPSG:4326 lat/lon swap.
// (CRS:84 also works on GFM but NOT on EOX, so 1.1.1 is the common denominator.)
// Verified 2026-10-13 against Rosario and Corrientes.

import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const EOX_WMS = 'https://tiles.maps.eox.at/wms';
const GFM_WMS = 'https://geoserver.gfm.eodc.eu/geoserver/gfm/wms';

export const LAYERS = {
  base: {
    name: 's2cloudless-2025',
    endpoint: EOX_WMS,
    format: 'image/jpeg',
    attribution: 'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)',
    license: 'CC BY-NC-SA 4.0 (non-commercial; contact EOX for commercial use)',
    notes: 'Annual cloud-free mosaic, NOT near-real-time (shows the river as it was in 2025, not today). '
      + 'Older years: s2cloudless-2017..2024. Same names with _3857 suffix are Web-Mercator variants. '
      + 'Other EOX layers: terrain-light, overlay (labels), osm, blackmarble.',
  },
  flood: {
    name: 'observed_flood_extent',
    endpoint: GFM_WMS,
    format: 'image/png',
    transparent: true,
    attribution: 'Copernicus Emergency Management Service - Global Flood Monitoring (GFM, Sentinel-1) / GloFAS, EODC',
    license: 'Copernicus open data (free, full and open; attribute Copernicus/CEMS GFM)',
    notes: 'Pink pixels = flooded area detected by Sentinel-1 SAR (water outside the reference water mask). '
      + 'TIME is a per-acquisition-day filter; each day only covers the Sentinel-1 swaths that passed that day, '
      + 'so floodUrl() requests a trailing window (default 7 days, "start/end" range, newer overwrites older) for fuller coverage. '
      + 'Sister layers on same server: observed_water_extent (all detected water, blue), reference_water_mask, '
      + 'sentinel_1_footprint, exclusion_mask, uncertainty_values, advisory_flags. '
      + '*_group_layer variants add swath outlines + timestamp labels (not wanted for overlays). '
      + 'Fallbacks: ows.globalfloods.eu/glofas-ows/ows.py layer gfm_observed_flood_extent_group_layer (single-day TIME only, '
      + 'includes swath outlines); NASA GIBS MODIS_Combined_Flood_3-Day (250 m, cloud-limited) at '
      + 'gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi.',
    windowDays: 7,
    probeLayer: 'observed_water_extent',
  },
};

function check(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    throw new TypeError('bbox must be [west, south, east, north] in degrees');
  }
  const [w, s, e, n] = bbox;
  if (!(w < e && s < n)) throw new RangeError('bbox must satisfy west<east and south<north');
  if (!(width > 0 && height > 0)) throw new RangeError('width/height must be positive');
}

function wmsUrl(endpoint, params) {
  const q = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', STYLES: '', SRS: 'EPSG:4326', ...params });
  return `${endpoint}?${q}`.replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/');
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (ymd, n) => isoDay(new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000));

/** GetMap URL (JPEG) for the Sentinel-2 cloudless base layer. bbox = [w,s,e,n] lon/lat. */
export function baseUrl({ bbox, width = 800, height = 800 }) {
  check(bbox, width, height);
  return wmsUrl(LAYERS.base.endpoint, {
    LAYERS: LAYERS.base.name, FORMAT: LAYERS.base.format, WIDTH: Math.round(width), HEIGHT: Math.round(height), BBOX: bbox.join(','),
  });
}

/**
 * GetMap URL (transparent PNG) for GFM observed flood extent.
 * date: 'YYYY-MM-DD' = last day of the window (default: today UTC).
 * days: window length in days (default 7; 1 = that single day only).
 */
export function floodUrl({ bbox, width = 800, height = 800, date, days = LAYERS.flood.windowDays }) {
  check(bbox, width, height);
  const end = date ?? isoDay(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new TypeError("date must be 'YYYY-MM-DD'");
  const time = days > 1 ? `${addDays(end, -(days - 1))}/${end}` : end;
  return wmsUrl(LAYERS.flood.endpoint, {
    LAYERS: LAYERS.flood.name, FORMAT: LAYERS.flood.format, TRANSPARENT: 'true',
    WIDTH: Math.round(width), HEIGHT: Math.round(height), BBOX: bbox.join(','), TIME: time,
  });
}

// ---- latest date ---------------------------------------------------------
// GFM's GetCapabilities TIME dimension is just a daily list up to "today" (verified: it lists today even
// when no scene exists), so it cannot tell you the real latest data. Instead probe backwards, one day at
// a time, with a tiny GetMap of observed_water_extent (water pixels appear wherever Sentinel-1 was processed)
// over a bbox and look for a non-uniform PNG.

// Parana corridor Rosario -> Corrientes (w,s,e,n)
const PARANA_BBOX = [-61.0, -34.0, -57.5, -27.0];
const PROBE_SIZE = 256;

// ¿Hay algún píxel visible (alfa > 0)? Decodifica el PNG (des-filtra cada fila) y mira la
// transparencia real: un PNG RGBA "vacío" puede ser blanco 100 % transparente.
export function pngHasContent(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  let w, h, depth, ctype, trns = null;
  const idat = [];
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; }
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  if (!idat.length || d16(depth)) return true; // 16 bits: no se analiza, se asume contenido
  const raw = inflateSync(Buffer.concat(idat));
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const bpp = Math.max(1, (ch * depth) >> 3);           // bytes por píxel para los filtros
  const rowLen = Math.ceil((w * ch * depth) / 8);
  let prev = Buffer.alloc(rowLen);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (rowLen + 1)];
    const row = Buffer.from(raw.subarray(y * (rowLen + 1) + 1, (y + 1) * (rowLen + 1)));
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? row[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
      if (ft === 1) row[i] = (row[i] + left) & 255;
      else if (ft === 2) row[i] = (row[i] + up) & 255;
      else if (ft === 3) row[i] = (row[i] + ((left + up) >> 1)) & 255;
      else if (ft === 4) {
        const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)) & 255;
      }
    }
    for (let x = 0; x < w; x++) {
      if (ctype === 6 && row[x * 4 + 3] > 0) return true;
      if (ctype === 4 && row[x * 2 + 1] > 0) return true;
      if (ctype === 3) {
        const bit = x * depth, idx = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        if (!trns || idx >= trns.length || trns[idx] > 0) return true;
      }
      if (ctype === 0 || ctype === 2) return true; // sin canal alfa: todo es visible
    }
    prev = row;
  }
  return false;
}
const d16 = (depth) => depth === 16;

/**
 * Latest day (YYYY-MM-DD, UTC) with Sentinel-1 water detections from GFM over `bbox`
 * (default: Parana corridor). Returns null if nothing in the last `maxBackDays` days or on network failure.
 */
export async function latestFloodDate({ bbox = PARANA_BBOX, maxBackDays = 21, signal } = {}) {
  const today = isoDay(new Date());
  for (let i = 0; i <= maxBackDays; i++) {
    const day = addDays(today, -i);
    const url = wmsUrl(GFM_WMS, {
      LAYERS: LAYERS.flood.probeLayer, FORMAT: 'image/png', TRANSPARENT: 'true',
      WIDTH: PROBE_SIZE, HEIGHT: PROBE_SIZE, BBOX: bbox.join(','), TIME: day,
    });
    try {
      const r = await fetch(url, { signal: signal ?? AbortSignal.timeout(20000) });
      if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('image/png')) continue;
      if (pngHasContent(Buffer.from(await r.arrayBuffer()))) return day;
    } catch { /* try previous day */ }
  }
  return null;
}

// ---- CLI -----------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rosario = [-60.95, -33.2, -60.4, -32.7];
  const date = await latestFloodDate();
  console.log('latest GFM date over Parana corridor:', date);
  console.log('base :', baseUrl({ bbox: rosario, width: 700, height: 700 }));
  console.log('flood:', floodUrl({ bbox: rosario, width: 700, height: 700, date: date ?? undefined }));
}
