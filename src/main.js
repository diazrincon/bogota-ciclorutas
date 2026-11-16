import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { DEM_PROTOCOL, demStatus, registerDemProtocol } from './dem-protocol.js';

registerDemProtocol(maplibregl);

const IDECA_MAPS = 'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/Mapa_Referencia';
const BASEMAPS = {
  gris: 'mapa_base_gris',
  hibrido: 'mapa_hibrido',
  oscuro: 'mapa_base_oscuro_3857',
};
const CICLORRUTA_COLOR = '#ff2d6f';

const demSource = {
  type: 'raster-dem',
  tiles: [`${DEM_PROTOCOL}://{z}/{x}/{y}`],
  tileSize: 256,
  encoding: 'terrarium',
  minzoom: 8,
  maxzoom: 15,
  attribution:
    'MDT 2025 © SDP / UAECD – IDECA (CC BY 4.0) · relieve fuera de Bogotá: Mapzen Terrain Tiles',
};

const style = {
  version: 8,
  sources: {
    ...Object.fromEntries(
      Object.entries(BASEMAPS).map(([id, service]) => [
        `base-${id}`,
        {
          type: 'raster',
          tiles: [`${IDECA_MAPS}/${service}/MapServer/tile/{z}/{y}/{x}`],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Mapa de referencia © IDECA',
        },
      ]),
    ),
    // MapLibre recomienda fuentes separadas para el terreno y el sombreado; ambas
    // comparten las descargas mediante la caché del protocolo.
    terreno: demSource,
    sombreado: demSource,
    ciclorrutas: {
      type: 'geojson',
      data: `${import.meta.env.BASE_URL}data/ciclorrutas.geojson`,
      attribution: 'Ciclorrutas © IDU – IDECA',
    },
  },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': '#cfd8dc' } },
    ...Object.keys(BASEMAPS).map((id) => ({
      id: `base-${id}`,
      type: 'raster',
      source: `base-${id}`,
      layout: { visibility: id === 'gris' ? 'visible' : 'none' },
    })),
    {
      id: 'sombreado',
      type: 'hillshade',
      source: 'sombreado',
      paint: {
        'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#2b3a4a',
        'hillshade-highlight-color': '#ffffff',
      },
    },
    {
      id: 'ciclorrutas-relleno',
      type: 'fill',
      source: 'ciclorrutas',
      paint: { 'fill-color': CICLORRUTA_COLOR, 'fill-opacity': 0.9 },
    },
    {
      // Las ciclorrutas son franjas de ~2 m: de lejos el relleno ocupa menos de un píxel,
      // así que el contorno las mantiene visibles y se desvanece al acercarse.
      id: 'ciclorrutas-contorno',
      type: 'line',
      source: 'ciclorrutas',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': CICLORRUTA_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 15, 1.2, 18, 0.5],
      },
    },
  ],
  terrain: { source: 'terreno', exaggeration: 1.5 },
  sky: {
    'sky-color': '#8fc1ee',
    'horizon-color': '#e6eef5',
    'fog-color': '#e6eef5',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.4,
  },
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [-74.085, 4.66],
  zoom: 11.3,
  pitch: 58,
  bearing: -12,
  maxPitch: 80,
  minZoom: 8.5,
  maxBounds: [
    [-75.2, 3.5],
    [-73.2, 5.6],
  ],
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// --- Panel -----------------------------------------------------------------

const status = document.getElementById('status');

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

map.on('load', async () => {
  try {
    // getData() espera a que el GeoJSON termine de cargar.
    const data = await map.getSource('ciclorrutas').getData();
    setStatus(`${data.features.length.toLocaleString('es-CO')} tramos de ciclorruta`);
  } catch (error) {
    console.error(error);
    setStatus('No se pudieron cargar las ciclorrutas. Ejecuta "npm run data".', true);
  }
});

map.on('idle', () => {
  if (demStatus.idecaErrors > 0 && demStatus.idecaTiles === 0) {
    setStatus('El MDT de IDECA no responde: se muestra relieve global de menor detalle.', true);
  }
});

for (const input of document.querySelectorAll('input[name="basemap"]')) {
  input.addEventListener('change', () => {
    for (const id of Object.keys(BASEMAPS)) {
      map.setLayoutProperty(`base-${id}`, 'visibility', id === input.value ? 'visible' : 'none');
    }
  });
}

const exaggeration = document.getElementById('exaggeration');
const exaggerationValue = document.getElementById('exaggeration-value');
exaggeration.addEventListener('input', () => {
  const value = Number(exaggeration.value);
  exaggerationValue.textContent = `${value}×`;
  map.setTerrain({ source: 'terreno', exaggeration: value });
});

document.getElementById('toggle-ciclorrutas').addEventListener('change', (event) => {
  const visibility = event.target.checked ? 'visible' : 'none';
  map.setLayoutProperty('ciclorrutas-relleno', 'visibility', visibility);
  map.setLayoutProperty('ciclorrutas-contorno', 'visibility', visibility);
});

document.getElementById('toggle-hillshade').addEventListener('change', (event) => {
  map.setLayoutProperty('sombreado', 'visibility', event.target.checked ? 'visible' : 'none');
});

// Útil para depurar desde la consola del navegador.
window.map = map;
