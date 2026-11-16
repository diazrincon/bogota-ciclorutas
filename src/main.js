import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { DEM_PROTOCOL, demStatus, registerDemProtocol } from './dem-protocol.js';
import { ProfilePanel } from './perfil.js';
import { loadNetwork, nearestVertex } from './red.js';
import { findRoute } from './ruta.js';

registerDemProtocol(maplibregl);

const IDECA_MAPS = 'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/Mapa_Referencia';
const BASEMAPS = {
  gris: 'mapa_base_gris',
  hibrido: 'mapa_hibrido',
  oscuro: 'mapa_base_oscuro_3857',
};
const CICLORRUTA_COLOR = '#ff2d6f';
const ROUTE_COLOR = '#1463ff';
const EMPTY_LINE = { type: 'FeatureCollection', features: [] };

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
    ruta: { type: 'geojson', data: EMPTY_LINE },
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
    {
      id: 'ruta-borde',
      type: 'line',
      source: 'ruta',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 11] },
    },
    {
      id: 'ruta',
      type: 'line',
      source: 'ruta',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ROUTE_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 7] },
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

map.on('idle', () => {
  if (demStatus.idecaErrors > 0 && demStatus.idecaTiles === 0) {
    setStatus('El MDT de IDECA no responde: se muestra relieve global de menor detalle.', true);
  }
});

// --- Rutas -------------------------------------------------------------------

const PROMPT_ORIGIN = 'Haz clic en el mapa para marcar el origen.';
const PROMPT_DESTINATION = 'Ahora haz clic en el destino.';
const SNAP_LIMIT = 500; // m: distancia máxima entre el clic y la red

let network = null;
const points = { origin: null, destination: null }; // resultados de nearestVertex()

const markers = {
  origin: new maplibregl.Marker({ color: '#12a150', draggable: true }),
  destination: new maplibregl.Marker({ color: '#d92d20', draggable: true }),
};
const hoverDot = document.createElement('div');
hoverDot.className = 'hover-dot';
const hoverMarker = new maplibregl.Marker({ element: hoverDot });

const profile = new ProfilePanel(document.getElementById('profile'), {
  onHover: (lngLat) => {
    if (lngLat) hoverMarker.setLngLat(lngLat).addTo(map);
    else hoverMarker.remove();
  },
  onClear: clearRoute,
});

function setPoint(which, lngLat) {
  const snapped = nearestVertex(network, lngLat.lng, lngLat.lat, SNAP_LIMIT);
  if (!snapped) {
    setStatus(`Ese punto está a más de ${SNAP_LIMIT} m de la red. Prueba más cerca de una vía.`, true);
    // Si se arrastró un marcador fuera de la red, vuelve a su sitio.
    if (points[which]) markers[which].setLngLat(vertexLngLat(points[which].vertex));
    return false;
  }
  points[which] = snapped;
  markers[which].setLngLat(vertexLngLat(snapped.vertex)).addTo(map);
  return true;
}

function vertexLngLat(vertex) {
  return [network.lon[vertex] * 1e-7, network.lat[vertex] * 1e-7];
}

function updateRoute() {
  if (!points.origin || !points.destination) {
    map.getSource('ruta').setData(EMPTY_LINE);
    profile.setRoute(null);
    setStatus(points.origin ? PROMPT_DESTINATION : PROMPT_ORIGIN);
    return;
  }
  const started = performance.now();
  const route = findRoute(network, points.origin, points.destination);
  if (!route) {
    map.getSource('ruta').setData(EMPTY_LINE);
    profile.setRoute(null);
    setStatus('No hay ruta entre esos dos puntos.', true);
    return;
  }
  map.getSource('ruta').setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: route.coordinates },
  });
  profile.setRoute(route);
  setStatus(`Ruta calculada en ${Math.round(performance.now() - started)} ms. Arrastra los marcadores para ajustarla.`);
}

function clearRoute() {
  points.origin = points.destination = null;
  markers.origin.remove();
  markers.destination.remove();
  hoverMarker.remove();
  updateRoute();
}

// MapLibre recoloca los marcadores al mover la cámara, pero no cuando el relieve termina
// de cargar después: sin esto quedan desplazados hasta el siguiente movimiento.
let markerRefreshQueued = false;
function refreshMarkers() {
  if (markerRefreshQueued) return;
  markerRefreshQueued = true;
  requestAnimationFrame(() => {
    markerRefreshQueued = false;
    for (const marker of [markers.origin, markers.destination, hoverMarker]) {
      if (marker.getLngLat()) marker.setLngLat(marker.getLngLat());
    }
  });
}
map.on('idle', refreshMarkers);
map.on('sourcedata', (event) => {
  if (event.sourceId === 'terreno') refreshMarkers();
});

for (const which of ['origin', 'destination']) {
  markers[which].on('dragend', () => {
    setPoint(which, markers[which].getLngLat());
    updateRoute();
  });
}

map.on('click', (event) => {
  if (!network) return;
  // Primer clic: origen. Los siguientes fijan (o mueven) el destino.
  const which = points.origin ? 'destination' : 'origin';
  if (setPoint(which, event.lngLat)) updateRoute();
});

setStatus('Cargando la red de rutas…');
loadNetwork(`${import.meta.env.BASE_URL}data/red.bin`)
  .then((loaded) => {
    network = loaded;
    map.getCanvas().style.cursor = 'crosshair';
    setStatus(PROMPT_ORIGIN);
  })
  .catch((error) => {
    console.error(error);
    setStatus('No se pudo cargar la red de rutas. Ejecuta "npm run data".', true);
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
window.rutas = { points, setPoint, updateRoute, clearRoute, get network() { return network; } };
