// Registra el service worker (public/sw.js) y le deja guardados los archivos de esta
// versión. Solo en la versión web publicada: en desarrollo estorbaría, y en la app de
// escritorio los archivos ya están en el disco.

import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

const STORE = `ciclorrutas-app-${__APP_VERSION__}`;

// Archivos que la página carga y que deben quedar disponibles sin conexión. Los de
// assets/ llevan un nombre distinto en cada compilación, así que se leen del documento.
function ownFiles() {
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  const fromDocument = [...document.querySelectorAll('script[src], link[rel="stylesheet"], link[rel="icon"]')].map(
    (element) => element.src || element.href,
  );
  const data = [
    'data/red.bin',
    'data/ciclorrutas.geojson',
    'data/etiquetas-vias.geojson',
    'data/etiquetas-lugares.geojson',
    'fonts/Open Sans Semibold/0-255.pbf',
    'fonts/Open Sans Semibold/256-511.pbf',
  ].map((path) => new URL(path, base).href);
  // El worker de MapLibre se carga desde el código, no desde el documento.
  return [base.href, ...fromDocument, new URL(workerUrl, window.location.href).href, ...data];
}

export async function enableOffline() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || window.location.protocol === 'app:') return;
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js?v=${__APP_VERSION__}`);
    await navigator.serviceWorker.ready;
    // En la primera visita la página cargó antes de que el service worker tomara el
    // control, así que se le dejan aquí los archivos (salen de la caché HTTP, sin red).
    const cache = await caches.open(STORE);
    for (const url of ownFiles()) {
      if (!(await cache.match(url, { ignoreVary: true }))) await cache.add(url).catch(() => {});
    }
  } catch (error) {
    console.warn('No se pudo activar el uso sin conexión:', error);
  }
}
