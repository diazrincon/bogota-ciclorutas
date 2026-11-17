// Service worker: guarda los archivos propios del visor (aplicación, datos, tipografía)
// para no volver a pedirlos en cada visita y poder abrirlo sin conexión.
//
// La versión llega en la URL de registro (sw.js?v=X.Y.Z): cada versión nueva instala un
// service worker nuevo con su propio almacén y borra los anteriores. Las teselas de
// IDECA no pasan por aquí; las guardan los protocolos del mapa (src/tile-cache.js).

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'ciclorrutas-app-';
const STORE = PREFIX + VERSION;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== STORE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

async function fromNetwork(request, cache) {
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(STORE).then(async (cache) => {
      if (request.mode === 'navigate') {
        // La página: primero la red, para recibir versiones nuevas; guardada si no hay red.
        try {
          return await fromNetwork(request, cache);
        } catch {
          return (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ?? Response.error();
        }
      }
      // El resto no cambia dentro de una misma versión: primero lo guardado.
      // ignoreVary: el servidor responde con "Vary" (Origin, Accept-Encoding) y, sin esto,
      // lo guardado por la página no coincidiría con lo que piden <script> y <link>.
      return (await cache.match(request, { ignoreVary: true })) ?? fromNetwork(request, cache);
    }),
  );
});
