// Carga del grafo de rutas (public/data/red.bin, generado por scripts/construir_red.py).

const LON0 = -74.1;
const LAT0 = 4.65;
const KX = Math.cos((LAT0 * Math.PI) / 180) * 111320;
const KY = 110574;
const GRID_CELL = 50; // m

export const FORWARD = 1;
export const BACKWARD = 2;

// Grupos de tramos: definen el color en el perfil y cuánto "pesa" cada metro al elegir
// la ruta (1 = ideal). Los tipos 1-13 son la clase de la Red Biciusuarios de IDECA; los
// 21-27, la clasificación de la malla vial (inferida de los datos: el servicio no
// publica la leyenda de ese campo); el 40, las conexiones entre ambas redes.
export const GROUPS = [
  { id: 'ciclorruta', label: 'Ciclorruta', color: '#1a9850', factor: 1.0, kinds: [2, 6, 8, 9] },
  { id: 'bicicarril', label: 'Bicicarril', color: '#8fd16a', factor: 1.15, kinds: [3, 5] },
  { id: 'compartida', label: 'Vía compartida', color: '#f2c230', factor: 1.3, kinds: [1, 4, 7, 11, 12, 13] },
  { id: 'local', label: 'Calle local', color: '#9aa3ad', factor: 1.6, kinds: [23, 25, 26, 27] },
  { id: 'intermedia', label: 'Vía intermedia', color: '#f08a3c', factor: 2.2, kinds: [22] },
  { id: 'arterial', label: 'Vía arterial', color: '#d73027', factor: 3.5, kinds: [21] },
  { id: 'peatonal', label: 'Peatonal', color: '#9e7bd1', factor: 2.0, kinds: [10, 24] },
  { id: 'conexion', label: 'Conexión', color: '#5c6670', factor: 2.0, kinds: [40] },
];

// Cada metro de subida cuenta como estos metros adicionales de recorrido.
export const CLIMB_WEIGHT = 15;

const groupOfKind = new Uint8Array(256).fill(GROUPS.findIndex((g) => g.id === 'local'));
GROUPS.forEach((group, index) => group.kinds.forEach((kind) => (groupOfKind[kind] = index)));
export const MIN_FACTOR = Math.min(...GROUPS.map((g) => g.factor));

export function groupOf(kind) {
  return groupOfKind[kind];
}

export function toXY(lon, lat) {
  return [(lon - LON0) * KX, (lat - LAT0) * KY];
}

export async function loadNetwork(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo cargar la red (${response.status})`);
  const buffer = await response.arrayBuffer();
  const header = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== 'RBG1') throw new Error('red.bin tiene un formato desconocido');
  const nEdges = header.getUint32(4, true);
  const nVerts = header.getUint32(8, true);

  let offset = 16;
  const take = (Type, count) => {
    const view = new Type(buffer, offset, count);
    offset += count * Type.BYTES_PER_ELEMENT;
    return view;
  };
  const start = take(Uint32Array, nEdges);
  const end = take(Uint32Array, nEdges);
  const first = take(Uint32Array, nEdges + 1);
  const lon = take(Int32Array, nVerts);
  const lat = take(Int32Array, nVerts);
  const ele = take(Uint16Array, nVerts); // decímetros
  const kind = take(Uint8Array, nEdges);
  const flags = take(Uint8Array, nEdges);

  // Coordenadas planas en metros.
  const x = new Float32Array(nVerts);
  const y = new Float32Array(nVerts);
  for (let i = 0; i < nVerts; i++) {
    x[i] = (lon[i] * 1e-7 - LON0) * KX;
    y[i] = (lat[i] * 1e-7 - LAT0) * KY;
  }

  // Por tramo: longitud y metros de subida en cada sentido.
  let nNodes = 0;
  const length = new Float32Array(nEdges);
  const up = new Float32Array(nEdges); // subida yendo del inicio al fin
  const down = new Float32Array(nEdges); // subida yendo del fin al inicio
  for (let e = 0; e < nEdges; e++) {
    let len = 0;
    let rise = 0;
    let fall = 0;
    for (let i = first[e]; i < first[e + 1] - 1; i++) {
      len += Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]);
      const delta = (ele[i + 1] - ele[i]) / 10;
      if (delta > 0) rise += delta;
      else fall -= delta;
    }
    length[e] = len;
    up[e] = rise;
    down[e] = fall;
    nNodes = Math.max(nNodes, start[e] + 1, end[e] + 1);
  }

  // Posición de cada nodo y lista de adyacencia compacta: adj guarda tramo*2 + sentido
  // (0 = se recorre del inicio al fin; 1 = al revés).
  const nodeX = new Float32Array(nNodes);
  const nodeY = new Float32Array(nNodes);
  const adjStart = new Uint32Array(nNodes + 1);
  for (let e = 0; e < nEdges; e++) {
    nodeX[start[e]] = x[first[e]];
    nodeY[start[e]] = y[first[e]];
    nodeX[end[e]] = x[first[e + 1] - 1];
    nodeY[end[e]] = y[first[e + 1] - 1];
    if (flags[e] & FORWARD) adjStart[start[e] + 1]++;
    if (flags[e] & BACKWARD) adjStart[end[e] + 1]++;
  }
  for (let n = 0; n < nNodes; n++) adjStart[n + 1] += adjStart[n];
  const adj = new Uint32Array(adjStart[nNodes]);
  const cursor = adjStart.slice(0, nNodes);
  for (let e = 0; e < nEdges; e++) {
    if (flags[e] & FORWARD) adj[cursor[start[e]]++] = e * 2;
    if (flags[e] & BACKWARD) adj[cursor[end[e]]++] = e * 2 + 1;
  }

  // Rejilla de vértices para ubicar el punto de la red más cercano a un clic.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nVerts; i++) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const cols = Math.floor((maxX - minX) / GRID_CELL) + 1;
  const rows = Math.floor((maxY - minY) / GRID_CELL) + 1;
  const cellOf = (i) =>
    Math.floor((y[i] - minY) / GRID_CELL) * cols + Math.floor((x[i] - minX) / GRID_CELL);
  const cellStart = new Uint32Array(cols * rows + 1);
  for (let i = 0; i < nVerts; i++) cellStart[cellOf(i) + 1]++;
  for (let c = 0; c < cols * rows; c++) cellStart[c + 1] += cellStart[c];
  const cellItems = new Uint32Array(nVerts);
  const cellCursor = cellStart.slice(0, cols * rows);
  for (let i = 0; i < nVerts; i++) cellItems[cellCursor[cellOf(i)]++] = i;

  return {
    nEdges, nVerts, nNodes,
    start, end, first, lon, lat, ele, kind, flags,
    x, y, length, up, down, nodeX, nodeY, adjStart, adj,
    grid: { minX, minY, cols, rows, cellStart, cellItems },
  };
}

// Vértice de la red más cercano a un punto, o null si no hay ninguno a menos de maxDistance.
export function nearestVertex(net, lon, lat, maxDistance = 500) {
  const [px, py] = toXY(lon, lat);
  const { minX, minY, cols, rows, cellStart, cellItems } = net.grid;
  const cx = Math.floor((px - minX) / GRID_CELL);
  const cy = Math.floor((py - minY) / GRID_CELL);
  const maxRing = Math.ceil(maxDistance / GRID_CELL);
  let best = -1;
  let bestDistance = maxDistance;
  for (let ring = 0; ring <= maxRing; ring++) {
    // Un anillo más allá ya no puede mejorar lo encontrado.
    if (best >= 0 && (ring - 1) * GRID_CELL > bestDistance) break;
    for (let gy = cy - ring; gy <= cy + ring; gy++) {
      if (gy < 0 || gy >= rows) continue;
      const edgeRow = gy === cy - ring || gy === cy + ring;
      const step = edgeRow ? 1 : 2 * ring || 1;
      for (let gx = cx - ring; gx <= cx + ring; gx += step) {
        if (gx < 0 || gx >= cols) continue;
        const cell = gy * cols + gx;
        for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
          const v = cellItems[k];
          const distance = Math.hypot(net.x[v] - px, net.y[v] - py);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = v;
          }
        }
      }
    }
  }
  if (best < 0) return null;
  return { vertex: best, edge: edgeOfVertex(net, best), distance: bestDistance };
}

function edgeOfVertex(net, vertex) {
  let lo = 0;
  let hi = net.nEdges - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (net.first[mid] <= vertex) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
