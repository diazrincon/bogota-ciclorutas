// Protocolo de teselas de elevación para MapLibre.
//
// Pide al ImageServer de IDECA (MDT Bogotá 2025, LiDAR) el recorte de cada tesela en
// flotantes crudos y lo codifica como "terrarium", el formato que MapLibre sabe leer.
// Para no cargar el servicio sin necesidad, a IDECA solo se le piden las teselas que
// tocan el recuadro de las ciclorrutas. El resto del terreno (y los píxeles sin dato)
// sale de un modelo global (teselas Terrarium públicas, ~30 m), de modo que no aparezcan
// acantilados en el borde del recuadro.

import cicloBounds from './data/ciclorrutas-bbox.json';

const IDECA_EXPORT =
  'https://serviciosgis.catastrobogota.gov.co/image/rest/services/Imagenes/modelodigitalterreno2025funcion/ImageServer/exportImage';
const FALLBACK_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const FALLBACK_MAX_ZOOM = 15;

// Recuadro (lon/lat) que contiene todas las ciclorrutas; lo genera scripts/gpkg_to_geojson.py.
const IDECA_AREA = cicloBounds;

const SIZE = 256;
const PIXELS = SIZE * SIZE;
const MERCATOR_HALF = 20037508.342789244;
const CACHE_LIMIT = 160;

export const DEM_PROTOCOL = 'ideca-dem';

// Estado visible para la interfaz: si IDECA falla se sigue viendo relieve, pero menos detallado.
export const demStatus = { idecaTiles: 0, idecaErrors: 0 };

const cache = new Map(); // "z/x/y" -> Promise<Uint8ClampedArray> (RGBA terrarium)

function tileBounds(z, x, y) {
  const span = (2 * MERCATOR_HALF) / 2 ** z;
  const minX = -MERCATOR_HALF + x * span;
  const maxY = MERCATOR_HALF - y * span;
  return { minX, minY: maxY - span, maxX: minX + span, maxY };
}

function mercatorToLonLat(mx, my) {
  const lon = (mx / MERCATOR_HALF) * 180;
  const lat = (Math.atan(Math.sinh((my / MERCATOR_HALF) * Math.PI)) * 180) / Math.PI;
  return [lon, lat];
}

function intersectsIdecaArea(bounds) {
  const [west, south] = mercatorToLonLat(bounds.minX, bounds.minY);
  const [east, north] = mercatorToLonLat(bounds.maxX, bounds.maxY);
  return (
    east > IDECA_AREA.west &&
    west < IDECA_AREA.east &&
    north > IDECA_AREA.south &&
    south < IDECA_AREA.north
  );
}

// Devuelve { heights, valid } o null si la tesela no tiene ningún dato de IDECA.
async function fetchIdeca(bounds) {
  const params = new URLSearchParams({
    bbox: `${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY}`,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${SIZE},${SIZE}`,
    format: 'bip',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  const response = await fetch(`${IDECA_EXPORT}?${params}`);
  if (!response.ok) throw new Error(`IDECA respondió ${response.status}`);
  const buffer = await response.arrayBuffer();

  // Formato BIP: float32 little-endian por píxel y, al final, una máscara de validez de
  // 1 bit por píxel (bit más significativo primero).
  const dataBytes = PIXELS * 4;
  const maskBytes = PIXELS / 8;
  if (buffer.byteLength < dataBytes + maskBytes) {
    throw new Error('Respuesta de IDECA con tamaño inesperado');
  }
  const heights = new Float32Array(buffer, 0, PIXELS);
  const mask = new Uint8Array(buffer, dataBytes, maskBytes);
  const valid = new Uint8Array(PIXELS);
  let count = 0;
  for (let i = 0; i < PIXELS; i++) {
    const bit = (mask[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit && Number.isFinite(heights[i]) && heights[i] > 0) {
      valid[i] = 1;
      count++;
    }
  }
  return count === 0 ? null : { heights, valid, count };
}

// Tesela Terrarium global ya codificada (RGBA), o null si no está disponible.
async function fetchFallback(z, x, y) {
  if (z > FALLBACK_MAX_ZOOM) return null;
  const response = await fetch(`${FALLBACK_TILES}/${z}/${x}/${y}.png`);
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  bitmap.close();
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

function encodeTerrarium(rgba, i, height) {
  const value = height + 32768;
  const whole = Math.floor(value);
  rgba[i * 4] = whole >> 8;
  rgba[i * 4 + 1] = whole & 255;
  rgba[i * 4 + 2] = Math.floor((value - whole) * 256);
  rgba[i * 4 + 3] = 255;
}

async function buildTile(z, x, y) {
  const bounds = tileBounds(z, x, y);

  let ideca = null;
  if (intersectsIdecaArea(bounds)) {
    try {
      ideca = await fetchIdeca(bounds);
      demStatus.idecaTiles++;
    } catch (error) {
      demStatus.idecaErrors++;
      console.warn(`MDT de IDECA no disponible para ${z}/${x}/${y}:`, error);
    }
  }

  if (ideca && ideca.count === PIXELS) {
    const rgba = new Uint8ClampedArray(PIXELS * 4);
    for (let i = 0; i < PIXELS; i++) encodeTerrarium(rgba, i, ideca.heights[i]);
    return rgba;
  }

  const fallback = await fetchFallback(z, x, y).catch(() => null);
  if (!ideca && !fallback) throw new Error(`Sin datos de elevación para ${z}/${x}/${y}`);

  const rgba = fallback ?? new Uint8ClampedArray(PIXELS * 4);
  if (ideca) {
    // Sin modelo global de respaldo, los vacíos toman la cota mínima de la tesela.
    let floor = Infinity;
    if (!fallback) {
      for (let i = 0; i < PIXELS; i++) {
        if (ideca.valid[i] && ideca.heights[i] < floor) floor = ideca.heights[i];
      }
    }
    for (let i = 0; i < PIXELS; i++) {
      if (ideca.valid[i]) encodeTerrarium(rgba, i, ideca.heights[i]);
      else if (!fallback) encodeTerrarium(rgba, i, floor);
    }
  }
  return rgba;
}

function getTile(key, z, x, y) {
  let promise = cache.get(key);
  if (promise) {
    cache.delete(key); // se reinserta para mantener el orden de uso reciente
  } else {
    promise = buildTile(z, x, y);
    promise.catch(() => cache.delete(key));
  }
  cache.set(key, promise);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return promise;
}

export function registerDemProtocol(maplibregl) {
  maplibregl.addProtocol(DEM_PROTOCOL, async (request) => {
    const match = request.url.match(/(\d+)\/(\d+)\/(\d+)$/);
    if (!match) throw new Error(`URL de tesela inválida: ${request.url}`);
    const [z, x, y] = match.slice(1).map(Number);
    const rgba = await getTile(`${z}/${x}/${y}`, z, x, y);
    // Se copia: el terreno y el sombreado comparten la caché y cada uno recibe su imagen.
    const image = new ImageData(new Uint8ClampedArray(rgba), SIZE, SIZE);
    return { data: await createImageBitmap(image) };
  });
}
