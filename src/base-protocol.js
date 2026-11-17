// Protocolo de teselas para los mapas base de IDECA, sin sus textos.
//
// Las teselas ya dibujadas de IDECA traen los nombres pintados en la imagen, y por eso
// giran con el mapa. Aquí se pide cada tesela al servicio dinámico (export) con las capas
// de anotación fuera y el rotulado de las demás apagado; los nombres los dibuja MapLibre
// aparte (ver etiquetas.js). Es más lento que la caché de IDECA (~1 s por tesela), así que
// se usan teselas de 512 px: la cuarta parte de peticiones.

import { loadThroughStore, tileStore } from './tile-cache.js';

const SERVICES = 'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/Mapa_Referencia';
const SIZE = 512;
const MERCATOR_HALF = 20037508.342789244;
// Escala de una tesela de 256 px en el zoom 0 (96 ppp), la convención de ArcGIS.
const SCALE_ZOOM_0 = 591657527.591555;

// El híbrido es una foto aérea: en JPG pesa unas diez veces menos que en PNG.
const FORMATS = { mapa_hibrido: 'jpg' };
const DAY = 24 * 60 * 60 * 1000;
// IDECA manda estas teselas con "max-age=0", así que el navegador no las conserva. Se
// guardan aquí 30 días: el mapa base cambia poco, pero cambia.
const tiles = tileStore('ciclorrutas-fondo-v1', { maxEntries: 1500, maxAge: 30 * DAY });
const metadata = tileStore('ciclorrutas-fondo-capas-v1', { maxEntries: 20, maxAge: 7 * DAY });

export const BASE_PROTOCOL = 'ideca-base';
export const BASE_TILE_SIZE = SIZE;

const layerLists = new Map(); // servicio -> Promise<capas dibujables con su rango de escala>

function loadLayers(service) {
  let promise = layerLists.get(service);
  if (!promise) {
    promise = loadThroughStore(metadata, service, async () => {
      const response = await fetch(`${SERVICES}/${service}/MapServer?f=json`);
      if (!response.ok) throw new Error(`IDECA respondió ${response.status}`);
      const info = await response.json();
      if (!Array.isArray(info.layers)) throw new Error('IDECA no devolvió la lista de capas');
      return new Blob([JSON.stringify({ layers: info.layers })], { type: 'application/json' });
    })
      .then((blob) => blob.text())
      .then((text) => {
        const info = JSON.parse(text);
        const byId = new Map(info.layers.map((layer) => [layer.id, layer]));
        const drawable = [];
        for (const layer of info.layers) {
          if (layer.subLayerIds?.length) continue; // grupos y anotaciones
          const isAnnotationClass = byId.get(layer.parentLayerId)?.type === 'Annotation Layer';
          const isLabelOnly = /^(Etiqueta|Sitio de Inter)/.test(layer.name);
          if (isAnnotationClass || isLabelOnly || layer.type === 'Annotation Layer') continue;
          // El rango de escala efectivo es el de la capa recortado por el de sus grupos.
          let minScale = 0; // denominador mayor: límite al alejarse (0 = sin límite)
          let maxScale = 0; // denominador menor: límite al acercarse
          for (let node = layer; node; node = byId.get(node.parentLayerId)) {
            if (node.minScale) minScale = minScale ? Math.min(minScale, node.minScale) : node.minScale;
            if (node.maxScale) maxScale = Math.max(maxScale, node.maxScale);
          }
          drawable.push({ id: layer.id, minScale, maxScale });
        }
        return drawable;
      });
    promise.catch(() => layerLists.delete(service));
    layerLists.set(service, promise);
  }
  return promise;
}

function fetchTile(service, z, x, y, signal) {
  return loadThroughStore(tiles, `${service}/${z}/${x}/${y}`, () => downloadTile(service, z, x, y, signal));
}

async function downloadTile(service, z, x, y, signal) {
  const layers = await loadLayers(service);
  const scale = SCALE_ZOOM_0 / 2 ** z / (SIZE / 256);
  const visible = layers.filter(
    (layer) => (!layer.minScale || scale <= layer.minScale) && (!layer.maxScale || scale >= layer.maxScale),
  );
  const span = (2 * MERCATOR_HALF) / 2 ** z;
  const minX = -MERCATOR_HALF + x * span;
  const maxY = MERCATOR_HALF - y * span;
  const params = new URLSearchParams({
    bbox: `${minX},${maxY - span},${minX + span},${maxY}`,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${SIZE},${SIZE}`,
    format: FORMATS[service] ?? 'png32',
    transparent: 'false',
    dynamicLayers: JSON.stringify(
      visible.map(({ id }) => ({
        id,
        source: { type: 'mapLayer', mapLayerId: id },
        drawingInfo: { showLabels: false },
      })),
    ),
    f: 'image',
  });
  const response = await fetch(`${SERVICES}/${service}/MapServer/export?${params}`, { signal });
  if (!response.ok) throw new Error(`IDECA respondió ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('IDECA no devolvió una imagen');
  return blob;
}

export function registerBaseProtocol(maplibregl) {
  maplibregl.addProtocol(BASE_PROTOCOL, async (request, abortController) => {
    const match = request.url.match(/\/\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)$/);
    if (!match) throw new Error(`URL de tesela inválida: ${request.url}`);
    const [service, z, x, y] = [match[1], Number(match[2]), Number(match[3]), Number(match[4])];
    const blob = await fetchTile(service, z, x, y, abortController.signal);
    return { data: await createImageBitmap(blob) };
  });
}
