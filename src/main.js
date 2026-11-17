import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import AREA from './data/ciclorrutas-bbox.json';
import { BASE_PROTOCOL, BASE_TILE_SIZE, registerBaseProtocol } from './base-protocol.js';
import { DEM_PROTOCOL, demStatus, registerDemProtocol } from './dem-protocol.js';
import { LABEL_LAYERS, labelLayers, labelSources, setLabelTheme } from './etiquetas.js';
import { enableOffline } from './offline.js';
import { ProfilePanel } from './perfil.js';
import { loadNetwork, nearestVertex } from './red.js';
import { findRoute } from './ruta.js';

// Con empaquetador, MapLibre 6 necesita que se le indique dónde quedó su worker.
maplibregl.setWorkerUrl(workerUrl);
registerDemProtocol(maplibregl);
registerBaseProtocol(maplibregl);

// Servicio de IDECA de cada mapa base y el color de texto que le va a las etiquetas.
const BASEMAPS = {
  gris: { service: 'mapa_base_gris', labels: 'claro' },
  hibrido: { service: 'mapa_hibrido', labels: 'oscuro' },
  oscuro: { service: 'mapa_base_oscuro_3857', labels: 'oscuro' },
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
  glyphs: `${new URL(import.meta.env.BASE_URL, window.location.href).href}fonts/{fontstack}/{range}.pbf`,
  sources: {
    ...Object.fromEntries(
      Object.entries(BASEMAPS).map(([id, { service }]) => [
        `base-${id}`,
        {
          type: 'raster',
          tiles: [`${BASE_PROTOCOL}://${service}/{z}/{x}/{y}`],
          tileSize: BASE_TILE_SIZE,
          maxzoom: 18,
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
    ...labelSources(import.meta.env.BASE_URL),
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
    ...labelLayers(),
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

// --- Vistas ------------------------------------------------------------------

const AREA_BOUNDS = [
  [AREA.west, AREA.south],
  [AREA.east, AREA.north],
];
const DEFAULT_FOV = 36.87; // grados; el valor de MapLibre
// Isométrica: cámara a 35,26° sobre el horizonte y con un campo de visión estrecho para
// que casi no haya perspectiva (MapLibre no tiene cámara ortográfica). Se mira desde el
// occidente, de frente al eje largo de la ciudad, con los cerros orientales al fondo.
// Planta: primero con el norte a la izquierda (la ciudad queda apaisada y los cerros
// arriba); un segundo clic la pone con el norte arriba.
const PLAN_BEARING = 90;
const ISOMETRIC = { pitch: 54.7, bearing: 105, fov: 12 };

const panel = document.getElementById('panel');
const profileRoot = document.getElementById('profile');

// Margen para que el recuadro no quede debajo del panel ni del perfil.
function viewPadding() {
  const panelOpen = !panel.classList.contains('collapsed');
  return {
    top: 24,
    right: 56,
    bottom: profileRoot.hidden ? 24 : profileRoot.offsetHeight + 48,
    left: panelOpen ? panel.offsetWidth + 24 : 24,
  };
}

if (window.innerWidth < 700) panel.classList.add('collapsed');

const map = new maplibregl.Map({
  container: 'map',
  style,
  bounds: AREA_BOUNDS,
  fitBoundsOptions: { padding: viewPadding(), bearing: PLAN_BEARING },
  bearing: PLAN_BEARING,
  maxPitch: 80,
  minZoom: 8.5,
  maxBounds: [
    [-75.2, 3.5],
    [-73.2, 5.6],
  ],
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

// Transición propia: MapLibre no anima el campo de visión, y cambiarlo durante un easeTo
// con relieve activo se pierde a ratos (la animación trabaja sobre una copia de la cámara).
let viewAnimation = 0;
function showView(name) {
  let view = ISOMETRIC;
  if (name === 'planta') {
    const alreadyThere = map.getPitch() < 1 && Math.abs(map.getBearing() - PLAN_BEARING) < 1;
    view = { pitch: 0, bearing: alreadyThere ? 0 : PLAN_BEARING, fov: DEFAULT_FOV };
  }
  const target = map.cameraForBounds(AREA_BOUNDS, { padding: viewPadding(), bearing: view.bearing });
  const from = {
    lng: map.getCenter().lng,
    lat: map.getCenter().lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    fov: map.getVerticalFieldOfView(),
  };
  const turn = ((view.bearing - from.bearing + 540) % 360) - 180; // por el lado corto
  const duration = 1200;
  const started = performance.now();
  const mix = (a, b, t) => a + (b - a) * t;

  cancelAnimationFrame(viewAnimation);
  map.stop();
  const step = () => {
    const t = Math.min(1, (performance.now() - started) / duration);
    const k = t * t * (3 - 2 * t);
    map.jumpTo({
      center: [mix(from.lng, target.center.lng, k), mix(from.lat, target.center.lat, k)],
      zoom: mix(from.zoom, target.zoom, k),
      pitch: mix(from.pitch, view.pitch, k),
      bearing: from.bearing + turn * k,
    });
    map.setVerticalFieldOfView(mix(from.fov, view.fov, k));
    if (t < 1) viewAnimation = requestAnimationFrame(step);
  };
  viewAnimation = requestAnimationFrame(step);
}
// Si el usuario mueve el mapa a mitad de la transición, manda el usuario.
for (const type of ['mousedown', 'wheel', 'touchstart']) {
  map.getCanvasContainer().addEventListener(type, () => cancelAnimationFrame(viewAnimation), { passive: true });
}

const VIEW_BUTTONS = [
  {
    view: 'planta',
    title: 'Vista 2D de toda la red (otro clic: norte arriba)',
    icon: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6"/>',
  },
  {
    view: 'isometrica',
    title: 'Vista isométrica (resalta el relieve)',
    icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  },
];

map.addControl(
  {
    onAdd() {
      this.container = document.createElement('div');
      this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group view-buttons';
      for (const { view, title, icon } of VIEW_BUTTONS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${icon}</svg>`;
        button.addEventListener('click', () => showView(view));
        this.container.append(button);
      }
      return this.container;
    },
    onRemove() {
      this.container.remove();
    },
  },
  'top-right',
);

const panelToggle = document.getElementById('panel-toggle');
const syncPanelToggle = () =>
  panelToggle.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
panelToggle.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
  syncPanelToggle();
});
syncPanelToggle();
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

const profile = new ProfilePanel(profileRoot, {
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
    setLabelTheme(map, BASEMAPS[input.value].labels);
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

document.getElementById('toggle-labels').addEventListener('change', (event) => {
  for (const id of LABEL_LAYERS) {
    map.setLayoutProperty(id, 'visibility', event.target.checked ? 'visible' : 'none');
  }
});

document.getElementById('toggle-hillshade').addEventListener('change', (event) => {
  map.setLayoutProperty('sombreado', 'visibility', event.target.checked ? 'visible' : 'none');
});

// Cuando el mapa ya cargó, para no competir con la primera carga.
map.once('idle', enableOffline);

// Útil para depurar desde la consola del navegador.
window.map = map;
window.rutas = { points, setPoint, updateRoute, clearRoute, get network() { return network; } };
