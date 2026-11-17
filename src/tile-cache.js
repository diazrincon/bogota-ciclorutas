// Almacén persistente de teselas sobre la Cache API del navegador.
//
// Evita volver a pedir a IDECA lo que ya se descargó en visitas anteriores. Cada almacén
// tiene un tope de entradas (se borran las más antiguas) y, opcionalmente, una vigencia.
// Si el navegador no ofrece la Cache API (contexto no seguro, modo privado estricto),
// todo funciona igual pero sin guardar nada.

const KEY_PREFIX = 'https://teselas.ciclorrutas.invalid/'; // la Cache API exige claves http(s)
const STAMP = 'x-guardado'; // momento en que se guardó (ms)
const PRUNE_EVERY = 40; // escrituras entre limpiezas

export function tileStore(name, { maxEntries, maxAge = Infinity }) {
  let handle = null;
  let writes = 0;

  function open() {
    handle ??= (globalThis.caches ? caches.open(name) : Promise.resolve(null)).catch(() => null);
    return handle;
  }

  async function prune() {
    const cache = await open();
    if (!cache) return;
    const keys = await cache.keys();
    // keys() devuelve las entradas en orden de inserción: las primeras son las más viejas.
    const excess = keys.length - Math.floor(maxEntries * 0.9);
    if (keys.length <= maxEntries) return;
    await Promise.all(keys.slice(0, excess).map((request) => cache.delete(request)));
  }

  return {
    // Devuelve { blob, fresh } o null. `fresh` es false si la entrada ya caducó: quien
    // llama decide si la usa igualmente (por ejemplo, cuando no hay red).
    async get(key) {
      try {
        const cache = await open();
        const response = await cache?.match(KEY_PREFIX + key);
        if (!response) return null;
        const age = Date.now() - Number(response.headers.get(STAMP));
        return { blob: await response.blob(), fresh: age < maxAge };
      } catch {
        return null;
      }
    },

    async put(key, blob) {
      try {
        const cache = await open();
        if (!cache) return;
        await cache.put(
          KEY_PREFIX + key,
          new Response(blob, { headers: { [STAMP]: String(Date.now()), 'content-type': blob.type } }),
        );
        if (++writes % PRUNE_EVERY === 1) await prune();
      } catch {
        // Sin espacio o almacenamiento bloqueado: se sigue sin guardar.
      }
    },
  };
}

// Patrón común: usar lo guardado si está vigente; si no, descargar y guardar; y si la
// descarga falla, servir lo guardado aunque esté caducado.
export async function loadThroughStore(store, key, download) {
  const stored = await store.get(key);
  if (stored?.fresh) return stored.blob;
  try {
    const blob = await download();
    store.put(key, blob); // sin esperar: no debe retrasar el dibujo
    return blob;
  } catch (error) {
    if (stored) return stored.blob;
    throw error;
  }
}
