// Cálculo de la ruta (A*) sobre el grafo cargado por red.js.
//
// Costo de recorrer un tramo en un sentido:
//   longitud × factor del tipo de tramo + CLIMB_WEIGHT × metros de subida
// El origen y el destino pueden caer en mitad de un tramo: se recorre solo la parte necesaria.

import { BACKWARD, CLIMB_WEIGHT, FORWARD, GROUPS, MIN_FACTOR, groupOf } from './red.js';

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  peekKey() {
    return this.keys[0];
  }

  pop() {
    const { keys, values } = this;
    const top = values[0];
    const key = keys.pop();
    const value = values.pop();
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return top;
  }
}

// Costo de ir del vértice `from` al vértice `to` dentro de un mismo tramo (índices
// absolutos). Infinity si el sentido no está permitido.
function partialCost(net, edge, from, to) {
  if (from === to) return 0;
  const forward = to > from;
  if (!(net.flags[edge] & (forward ? FORWARD : BACKWARD))) return Infinity;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  let length = 0;
  let climb = 0;
  for (let i = lo; i < hi; i++) {
    length += Math.hypot(net.x[i + 1] - net.x[i], net.y[i + 1] - net.y[i]);
    const delta = (net.ele[i + 1] - net.ele[i]) / 10;
    if (forward ? delta > 0 : delta < 0) climb += Math.abs(delta);
  }
  return length * GROUPS[groupOf(net.kind[edge])].factor + CLIMB_WEIGHT * climb;
}

// origin y destination: resultados de nearestVertex(). Devuelve la ruta o null si no hay.
export function findRoute(net, origin, destination) {
  const { start, end, first, adjStart, adj, nodeX, nodeY, length, up, down, kind } = net;
  const e1 = origin.edge;
  const e2 = destination.edge;
  const v1 = origin.vertex;
  const v2 = destination.vertex;
  const targetX = net.x[v2];
  const targetY = net.y[v2];
  const heuristic = (n) => Math.hypot(nodeX[n] - targetX, nodeY[n] - targetY) * MIN_FACTOR;

  // Cómo se llega al destino desde cada extremo de su tramo.
  const tailFromStart = partialCost(net, e2, first[e2], v2);
  const tailFromEnd = partialCost(net, e2, first[e2 + 1] - 1, v2);

  let bestCost = e1 === e2 ? partialCost(net, e1, v1, v2) : Infinity;
  let bestNode = -1; // -1: la mejor ruta va por dentro de un único tramo

  const cost = new Float64Array(net.nNodes).fill(Infinity);
  const via = new Int32Array(net.nNodes).fill(-1); // tramo*2 + sentido con el que se llegó
  const heap = new MinHeap();
  const seed = (node, value) => {
    if (value < cost[node]) {
      cost[node] = value;
      via[node] = -1;
      heap.push(value + heuristic(node), node);
    }
  };
  seed(start[e1], partialCost(net, e1, v1, first[e1]));
  seed(end[e1], partialCost(net, e1, v1, first[e1 + 1] - 1));

  const settled = new Uint8Array(net.nNodes);
  while (heap.size > 0 && heap.peekKey() < bestCost) {
    const node = heap.pop();
    if (settled[node]) continue;
    settled[node] = 1;
    const here = cost[node];

    if (node === start[e2] && here + tailFromStart < bestCost) {
      bestCost = here + tailFromStart;
      bestNode = node;
    }
    if (node === end[e2] && here + tailFromEnd < bestCost) {
      bestCost = here + tailFromEnd;
      bestNode = node;
    }

    for (let k = adjStart[node]; k < adjStart[node + 1]; k++) {
      const code = adj[k];
      const edge = code >> 1;
      const reversed = code & 1;
      const next = reversed ? start[edge] : end[edge];
      if (settled[next]) continue;
      const candidate =
        here +
        length[edge] * GROUPS[groupOf(kind[edge])].factor +
        CLIMB_WEIGHT * (reversed ? down[edge] : up[edge]);
      if (candidate < cost[next]) {
        cost[next] = candidate;
        via[next] = code;
        heap.push(candidate + heuristic(next), next);
      }
    }
  }

  if (bestCost === Infinity) return null;

  // Reconstrucción: lista de tramos parciales (tramo, vértice inicial, vértice final).
  const pieces = [];
  if (bestNode === -1) {
    pieces.push([e1, v1, v2]);
  } else {
    const chain = [];
    let node = bestNode;
    while (via[node] !== -1) {
      const code = via[node];
      const edge = code >> 1;
      chain.push(code & 1 ? [edge, first[edge + 1] - 1, first[edge]] : [edge, first[edge], first[edge + 1] - 1]);
      node = code & 1 ? end[edge] : start[edge];
    }
    // `node` es el extremo del tramo de origen por el que salió la ruta. Si ambos extremos
    // son el mismo nodo (tramo en bucle), se toma el lado más barato.
    let exit = node === start[e1] ? first[e1] : first[e1 + 1] - 1;
    if (start[e1] === end[e1]) {
      const viaStart = partialCost(net, e1, v1, first[e1]);
      const viaEnd = partialCost(net, e1, v1, first[e1 + 1] - 1);
      exit = viaStart <= viaEnd ? first[e1] : first[e1 + 1] - 1;
    }
    pieces.push([e1, v1, exit]);
    pieces.push(...chain.reverse());
    let entry = bestNode === start[e2] ? first[e2] : first[e2 + 1] - 1;
    if (start[e2] === end[e2]) entry = tailFromStart <= tailFromEnd ? first[e2] : first[e2 + 1] - 1;
    pieces.push([e2, entry, v2]);
  }

  // Geometría y perfil. kinds[i] describe el segmento que va del punto i al i + 1.
  const coordinates = [];
  const elevation = [];
  const distance = [];
  const kinds = [];
  let travelled = 0;
  for (const [edge, from, to] of pieces) {
    if (from === to) continue;
    const step = to > from ? 1 : -1;
    for (let i = from; ; i += step) {
      const isFirstOfPiece = i === from;
      if (isFirstOfPiece && coordinates.length > 0) {
        // El primer punto repite el último del tramo anterior.
      } else {
        if (!isFirstOfPiece) {
          travelled += Math.hypot(net.x[i] - net.x[i - step], net.y[i] - net.y[i - step]);
        }
        coordinates.push([net.lon[i] * 1e-7, net.lat[i] * 1e-7]);
        elevation.push(net.ele[i] / 10);
        distance.push(travelled);
      }
      if (i === to) break;
      kinds.push(kind[edge]);
    }
  }
  if (coordinates.length < 2) return null;

  return { coordinates, elevation, distance, kinds, length: travelled, cost: bestCost };
}
