#!/usr/bin/env python3
"""Construye el grafo de rutas (public/data/red.bin) a partir de las capas de IDECA.

Entradas (data/raw/, ver descargar_redes.py y descargar_mdt.py):
  red_biciusuarios.geojson, malla_vial.geojson, puentes.geojson, mdt.f32 + mdt.json

Pasos:
  1. Une extremos que coinciden y parte los tramos donde otro tramo termina sobre ellos.
  2. Conecta la red de bicis con la malla vial: casi no comparten nodos, así que cada
     nodo de la red de bicis se enlaza con el eje vial más cercano.
  3. Conserva solo el componente conectado principal.
  4. Toma la elevación del MDT cada ~10 m y corrige los puentes, donde el MDT (terreno
     desnudo) da la cota del suelo que hay debajo.

Solo usa la biblioteca estándar.
"""
import array
import json
import math
import struct
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "data" / "red.bin"

# Plano local en metros (suficiente para una ciudad).
LON0, LAT0 = -74.1, 4.65
KX = math.cos(math.radians(LAT0)) * 111_320
KY = 110_574

SNAP = 0.5  # m: extremos más cercanos que esto son el mismo nodo
SPACING = 10.0  # m: separación máxima entre vértices (resolución del perfil)
CONNECT_RADIUS = 20.0  # m: enlace de un nodo de la red de bicis con el eje vial
CONNECT_RADIUS_DANGLING = 40.0  # m: lo mismo para los extremos sueltos

# Tipos de tramo (un byte). 1-13: clase de la Red Biciusuarios (dominio D_RBiClase).
# 21-27: malla vial según MVITCLA (20 + código). 40: conexión entre ambas redes.
KIND_STREET = 20
KIND_CONNECTOR = 40
BIKE_ELEVATED = {6, 8}  # ciclotúnel y ciclopuente: no se enlazan con la vía de al lado

FORWARD, BACKWARD = 1, 2


def to_xy(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def to_lonlat(x, y):
    return (x / KX + LON0, y / KY + LAT0)


def log(message):
    print(f"[{time.time() - T0:6.1f}s] {message}", flush=True)


# --- Carga -----------------------------------------------------------------


def line_parts(feature):
    geometry = feature.get("geometry")
    if not geometry:
        return []
    if geometry["type"] == "LineString":
        return [geometry["coordinates"]]
    return geometry["coordinates"]


def densify(points):
    """Inserta vértices para que ninguno quede a más de SPACING del siguiente."""
    out = [points[0]]
    original = [True]
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        steps = max(1, math.ceil(math.hypot(x2 - x1, y2 - y1) / SPACING))
        for i in range(1, steps):
            t = i / steps
            out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
            original.append(False)
        out.append((x2, y2))
        original.append(True)
    return out, original


def load_edges():
    edges = []

    def add(feature, kind, flags):
        for part in line_parts(feature):
            points = []
            for lon, lat, *_ in part:
                xy = to_xy(lon, lat)
                if not points or xy != points[-1]:
                    points.append(xy)
            if len(points) < 2:
                continue
            pts, original = densify(points)
            edges.append({"pts": pts, "orig": original, "kind": kind, "flags": flags})

    for feature in json.loads((RAW / "red_biciusuarios.geojson").read_text())["features"]:
        props = feature["properties"]
        kind = props["RBICLASE"] if props["RBICLASE"] in range(1, 14) else 1
        # Supuesto: "en un solo sentido" sigue el sentido en que está dibujado el tramo.
        flags = FORWARD if props["RBISENTIDO"] == "US" else FORWARD | BACKWARD
        add(feature, kind, flags)
    bike_count = len(edges)

    for feature in json.loads((RAW / "malla_vial.geojson").read_text())["features"]:
        props = feature["properties"]
        klass = props["MVITCLA"] if props["MVITCLA"] in range(1, 8) else 6
        sense = (props["MVISVIA"] or "").upper()
        # Supuesto: FT = sentido del dibujo, TF = sentido contrario.
        flags = {"FT": FORWARD, "TF": BACKWARD}.get(sense, FORWARD | BACKWARD)
        add(feature, KIND_STREET + klass, flags)

    log(f"tramos cargados: {bike_count} de bicis, {len(edges) - bike_count} de vías")
    return edges


# --- Índices espaciales ------------------------------------------------------


class NodeIndex:
    """Nodos con búsqueda por cercanía (rejilla de 1 m)."""

    def __init__(self):
        self.xy = []
        self.grid = defaultdict(list)

    def find(self, x, y, tol=SNAP):
        cx, cy = math.floor(x), math.floor(y)
        best, best_d = None, tol
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.grid.get((cx + dx, cy + dy), ()):
                    d = math.hypot(self.xy[i][0] - x, self.xy[i][1] - y)
                    if d <= best_d:
                        best, best_d = i, d
        return best

    def get(self, x, y):
        found = self.find(x, y)
        if found is not None:
            return found
        self.xy.append((x, y))
        self.grid[(math.floor(x), math.floor(y))].append(len(self.xy) - 1)
        return len(self.xy) - 1


class SegmentIndex:
    """Segmentos (ya densificados, por tanto cortos) en una rejilla de CELL metros."""

    CELL = 40.0

    def __init__(self, edges, edge_ids):
        self.edges = edges
        self.grid = defaultdict(list)
        cell = self.CELL
        for e in edge_ids:
            pts = edges[e]["pts"]
            for s in range(len(pts) - 1):
                (x1, y1), (x2, y2) = pts[s], pts[s + 1]
                for cx in range(math.floor(min(x1, x2) / cell), math.floor(max(x1, x2) / cell) + 1):
                    for cy in range(math.floor(min(y1, y2) / cell), math.floor(max(y1, y2) / cell) + 1):
                        self.grid[(cx, cy)].append((e, s))

    def nearest(self, x, y, radius, exclude=()):
        """(distancia, tramo, segmento, t, (qx, qy)) del punto más cercano, o None."""
        cell = self.CELL
        best = None
        for cx in range(math.floor((x - radius) / cell), math.floor((x + radius) / cell) + 1):
            for cy in range(math.floor((y - radius) / cell), math.floor((y + radius) / cell) + 1):
                for e, s in self.grid.get((cx, cy), ()):
                    if e in exclude:
                        continue
                    pts = self.edges[e]["pts"]
                    (x1, y1), (x2, y2) = pts[s], pts[s + 1]
                    dx, dy = x2 - x1, y2 - y1
                    length2 = dx * dx + dy * dy
                    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length2))
                    qx, qy = x1 + dx * t, y1 + dy * t
                    d = math.hypot(qx - x, qy - y)
                    if d <= radius and (best is None or d < best[0]):
                        best = (d, e, s, t, (qx, qy))
        return best


# --- Topología ---------------------------------------------------------------


def build_topology(edges):
    nodes = NodeIndex()
    for edge in edges:
        edge["a"] = nodes.get(*edge["pts"][0])
        edge["b"] = nodes.get(*edge["pts"][-1])
    log(f"nodos tras unir extremos: {len(nodes.xy)}")

    incident = defaultdict(list)  # nodo -> tramos
    for e, edge in enumerate(edges):
        incident[edge["a"]].append(e)
        incident[edge["b"]].append(e)

    splits = defaultdict(list)  # tramo -> [(segmento, t, nodo)]

    # 1. Vértices interiores que coinciden con un nodo existente.
    vertex_splits = 0
    for e, edge in enumerate(edges):
        pts, orig = edge["pts"], edge["orig"]
        for i in range(1, len(pts) - 1):
            if orig[i]:
                n = nodes.find(*pts[i], tol=0.3)
                if n is not None and n not in (edge["a"], edge["b"]):
                    splits[e].append((i, 0.0, n))
                    vertex_splits += 1
    log(f"cortes en vértices interiores: {vertex_splits}")

    is_bike = [edge["kind"] < KIND_STREET for edge in edges]
    all_index = SegmentIndex(edges, range(len(edges)))
    street_index = SegmentIndex(edges, [e for e in range(len(edges)) if not is_bike[e]])

    # 2. Extremos sueltos que terminan sobre otro tramo sin compartir vértice.
    t_splits = 0
    for n, around in incident.items():
        if len(around) != 1:
            continue
        hit = all_index.nearest(*nodes.xy[n], SNAP, exclude=around)
        if hit:
            _, e, s, t, _ = hit
            if n not in (edges[e]["a"], edges[e]["b"]):
                splits[e].append((s, t, n))
                t_splits += 1
    log(f"cortes por extremos sobre otro tramo: {t_splits}")

    # 3. Conexiones entre la red de bicis y la malla vial.
    connectors = []
    already = 0
    for n, around in incident.items():
        if not any(is_bike[e] for e in around):
            continue
        if any(not is_bike[e] for e in around):
            already += 1
            continue
        if any(edges[e]["kind"] in BIKE_ELEVATED for e in around):
            continue
        radius = CONNECT_RADIUS_DANGLING if len(around) == 1 else CONNECT_RADIUS
        hit = street_index.nearest(*nodes.xy[n], radius)
        if not hit:
            continue
        d, e, s, t, q = hit
        target = n if d <= SNAP else nodes.get(*q)
        if target not in (edges[e]["a"], edges[e]["b"]):
            splits[e].append((s, t, target))
        if target != n:
            connectors.append((n, target))
    log(f"nodos de bici ya sobre la malla vial: {already}; conexiones nuevas: {len(connectors)}")

    # Aplicar los cortes. Cada corte se ubica por su posición a lo largo del tramo
    # (índice de vértice + fracción del segmento) y pasa a ser extremo de dos subtramos.
    result = []
    for e, edge in enumerate(edges):
        cuts = splits.get(e)
        if not cuts:
            result.append(edge)
            continue
        pts = edge["pts"]
        last = float(len(pts) - 1)
        items = {float(i): (point, None) for i, point in enumerate(pts)}
        items[0.0] = (nodes.xy[edge["a"]], edge["a"])
        items[last] = (nodes.xy[edge["b"]], edge["b"])
        for segment, t, node in cuts:
            position = segment + t
            if 0.0 < position < last:
                items[position] = (nodes.xy[node], node)
        current, start_node = [items[0.0][0]], edge["a"]
        for position in sorted(items):
            if position == 0.0:
                continue
            point, node = items[position]
            if point != current[-1]:
                current.append(point)
            if node is not None:
                if len(current) >= 2:
                    result.append(
                        {"pts": current, "kind": edge["kind"], "flags": edge["flags"], "a": start_node, "b": node}
                    )
                current, start_node = [point], node

    for a, b in connectors:
        pts, _ = densify([nodes.xy[a], nodes.xy[b]])
        result.append({"pts": pts, "kind": KIND_CONNECTOR, "flags": FORWARD | BACKWARD, "a": a, "b": b})

    # Tramos degenerados fuera.
    clean = []
    for edge in result:
        length = sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(edge["pts"], edge["pts"][1:]))
        if length < 0.05 or (edge["a"] == edge["b"] and length < 2 * SNAP):
            continue
        edge["len"] = length
        clean.append(edge)
    log(f"tramos tras cortar y conectar: {len(clean)}")
    return clean, nodes


def keep_main_component(edges, node_count):
    parent = list(range(node_count))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for edge in edges:
        ra, rb = find(edge["a"]), find(edge["b"])
        if ra != rb:
            parent[ra] = rb
    length_by_root = Counter()
    for edge in edges:
        length_by_root[find(edge["a"])] += edge["len"]
    main, main_len = length_by_root.most_common(1)[0]
    total = sum(length_by_root.values())
    kept = [edge for edge in edges if find(edge["a"]) == main]
    dropped_bike = sum(e["len"] for e in edges if find(e["a"]) != main and e["kind"] < KIND_STREET)
    log(
        f"componentes: {len(length_by_root)}; el principal tiene {main_len / 1000:.0f} de {total / 1000:.0f} km "
        f"({100 * main_len / total:.1f} %); red de bicis descartada: {dropped_bike / 1000:.1f} km"
    )
    return kept


# --- Elevación ---------------------------------------------------------------


class Terrain:
    def __init__(self):
        meta = json.loads((RAW / "mdt.json").read_text())
        self.west, self.north, self.res = meta["west"], meta["north"], meta["res"]
        self.width, self.height = meta["width"], meta["height"]
        self.grid = array.array("f")
        with open(RAW / "mdt.f32", "rb") as fh:
            self.grid.fromfile(fh, self.width * self.height)

    def sample(self, x, y):
        """Interpolación bilineal; NaN si falta algún píxel vecino."""
        lon, lat = to_lonlat(x, y)
        col = (lon - self.west) / self.res - 0.5
        row = (self.north - lat) / self.res - 0.5
        c0, r0 = math.floor(col), math.floor(row)
        if c0 < 0 or r0 < 0 or c0 + 1 >= self.width or r0 + 1 >= self.height:
            return math.nan
        fc, fr = col - c0, row - r0
        i = r0 * self.width + c0
        g = self.grid
        top = g[i] * (1 - fc) + g[i + 1] * fc
        bottom = g[i + self.width] * (1 - fc) + g[i + self.width + 1] * fc
        return top * (1 - fr) + bottom * fr


class Bridges:
    CELL = 50.0

    def __init__(self):
        self.rings = []
        self.grid = defaultdict(list)
        for feature in json.loads((RAW / "puentes.geojson").read_text())["features"]:
            geometry = feature.get("geometry")
            if not geometry:
                continue
            polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
            for polygon in polygons:
                ring = [to_xy(lon, lat) for lon, lat, *_ in polygon[0]]
                xs, ys = [p[0] for p in ring], [p[1] for p in ring]
                index = len(self.rings)
                self.rings.append(ring)
                for cx in range(math.floor(min(xs) / self.CELL), math.floor(max(xs) / self.CELL) + 1):
                    for cy in range(math.floor(min(ys) / self.CELL), math.floor(max(ys) / self.CELL) + 1):
                        self.grid[(cx, cy)].append(index)

    def contains(self, x, y):
        for index in self.grid.get((math.floor(x / self.CELL), math.floor(y / self.CELL)), ()):
            inside = False
            ring = self.rings[index]
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                    inside = not inside
            if inside:
                return True
        return False


def add_elevation(edges, nodes):
    terrain = Terrain()
    bridges = Bridges()
    node_count = len(nodes.xy)

    # Identificador global de vértice: los extremos usan el del nodo; los interiores, uno propio.
    offset = node_count
    for edge in edges:
        n = len(edge["pts"])
        edge["vid"] = [edge["a"]] + list(range(offset, offset + n - 2)) + [edge["b"]]
        offset += n - 2
    z = array.array("d", [math.nan]) * offset
    pending = set()  # vértices sobre puente o sin dato: su cota se interpola
    on_bridge = 0
    for edge in edges:
        for (x, y), v in zip(edge["pts"], edge["vid"]):
            if z[v] == z[v] or v in pending:
                continue
            if bridges.contains(x, y):
                pending.add(v)
                on_bridge += 1
                continue
            value = terrain.sample(x, y)
            if value == value:
                z[v] = value
            else:
                pending.add(v)
    log(f"vértices: {offset}; sobre puente: {on_bridge}; sin dato en el MDT: {len(pending) - on_bridge}")

    # Los vértices pendientes toman la cota que resulta de interpolar a lo largo de la red
    # entre los vértices buenos más cercanos (en un tramo simple, una recta entre los dos
    # extremos del puente). Se resuelve por relajación con pesos 1/distancia.
    neighbours = defaultdict(list)
    for edge in edges:
        pts, vid = edge["pts"], edge["vid"]
        for i in range(len(pts) - 1):
            a, b = vid[i], vid[i + 1]
            if a in pending or b in pending:
                w = 1.0 / max(0.5, math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]))
                if a in pending:
                    neighbours[a].append((b, w))
                if b in pending:
                    neighbours[b].append((a, w))

    # Arranque: propagar la cota conocida más cercana (por saltos) hacia los pendientes.
    frontier = [v for v in pending if any(z[n] == z[n] for n, _ in neighbours[v])]
    seeded = set()
    while frontier:
        nxt = []
        for v in frontier:
            if v in seeded:
                continue
            known = [z[n] for n, _ in neighbours[v] if z[n] == z[n]]
            if known:
                z[v] = sum(known) / len(known)
                seeded.add(v)
                nxt.extend(n for n, _ in neighbours[v] if n in pending and n not in seeded)
        frontier = nxt
    orphans = [v for v in pending if z[v] != z[v]]
    for v in orphans:  # islas sin ningún vértice bueno alrededor (no deberían quedar)
        z[v] = 2560.0

    order = [v for v in pending if v in seeded]
    omega = 1.85
    for iteration in range(3000):
        worst = 0.0
        for v in order:
            total = weight = 0.0
            for n, w in neighbours[v]:
                total += z[n] * w
                weight += w
            delta = total / weight - z[v]
            z[v] += omega * delta
            if abs(delta) > worst:
                worst = abs(delta)
        if worst < 0.005:
            break
    log(f"cotas interpoladas: {len(order)} (iteraciones: {iteration + 1}, residuo {worst:.4f} m); huérfanos: {len(orphans)}")

    for edge in edges:
        ele = [z[v] for v in edge["vid"]]
        # Suavizado ligero del ruido del MDT, sin mover los extremos (compartidos con otros tramos).
        for _ in range(2):
            ele = [ele[0]] + [(ele[i - 1] + 2 * ele[i] + ele[i + 1]) / 4 for i in range(1, len(ele) - 1)] + [ele[-1]]
        edge["ele"] = ele
        del edge["vid"]


# --- Salida ------------------------------------------------------------------


def write_binary(edges):
    """Formato red.bin (little-endian):
      "RBG1", nTramos u32, nVértices u32, 4 bytes de relleno
      u32[nTramos]      nodo inicial
      u32[nTramos]      nodo final
      u32[nTramos + 1]  índice del primer vértice de cada tramo
      i32[nVértices]    longitud × 1e7
      i32[nVértices]    latitud × 1e7
      u16[nVértices]    elevación en decímetros
      u8[nTramos]       tipo
      u8[nTramos]       sentidos permitidos (bit 0: del inicio al fin; bit 1: al revés)
    """
    renumber = {}
    start, end, first = array.array("I"), array.array("I"), array.array("I")
    lon, lat, ele = array.array("i"), array.array("i"), array.array("H")
    kinds, flags = bytearray(), bytearray()
    for edge in edges:
        start.append(renumber.setdefault(edge["a"], len(renumber)))
        end.append(renumber.setdefault(edge["b"], len(renumber)))
        first.append(len(lon))
        for (x, y), h in zip(edge["pts"], edge["ele"]):
            lo, la = to_lonlat(x, y)
            lon.append(round(lo * 1e7))
            lat.append(round(la * 1e7))
            ele.append(max(0, min(65535, round(h * 10))))
        kinds.append(edge["kind"])
        flags.append(edge["flags"])
    first.append(len(lon))
    assert start.itemsize == 4 and lon.itemsize == 4 and ele.itemsize == 2 and sys.byteorder == "little"

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "wb") as fh:
        fh.write(b"RBG1" + struct.pack("<III", len(edges), len(lon), 0))
        for chunk in (start, end, first, lon, lat, ele):
            chunk.tofile(fh)
        fh.write(kinds)
        fh.write(flags)
    log(f"{len(renumber)} nodos, {len(edges)} tramos, {len(lon)} vértices -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


def report(edges):
    km = Counter()
    climb = Counter()
    for edge in edges:
        group = "bici" if edge["kind"] < KIND_STREET else "conexión" if edge["kind"] == KIND_CONNECTOR else "vía"
        km[group] += edge["len"] / 1000
        km[f"tipo {edge['kind']}"] += edge["len"] / 1000
        ele = edge["ele"]
        if edge["len"] > 20:
            grade = abs(ele[-1] - ele[0]) / edge["len"] * 100
            climb["tramos > 20 m"] += 1
            if grade > 15:
                climb["pendiente media > 15 %"] += 1
            if grade > 30:
                climb["pendiente media > 30 %"] += 1
    log("km por grupo: " + ", ".join(f"{k}: {v:.0f}" for k, v in km.items() if not k.startswith("tipo")))
    log("km por tipo: " + ", ".join(f"{k[5:]}: {v:.0f}" for k, v in sorted(km.items()) if k.startswith("tipo")))
    log("pendientes: " + ", ".join(f"{k}: {v}" for k, v in climb.items()))


def main():
    edges = load_edges()
    edges, nodes = build_topology(edges)
    edges = keep_main_component(edges, len(nodes.xy))
    add_elevation(edges, nodes)
    report(edges)
    write_binary(edges)


T0 = time.time()
if __name__ == "__main__":
    main()
