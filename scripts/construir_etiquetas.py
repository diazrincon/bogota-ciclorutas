#!/usr/bin/env python3
"""Genera los datos de las etiquetas del mapa (nombres de localidades y de vías).

Los mapas base de IDECA traen los textos pintados en la imagen, así que giran con el
mapa. Aquí se preparan como datos para que MapLibre los dibuje siempre derechos.

Entradas (data/raw/, ver descargar_redes.py): malla_vial.geojson y localidades.geojson.
Salidas (public/data/):
  - etiquetas-lugares.geojson  un punto por localidad
  - etiquetas-vias.geojson     ejes de vías unidos por nombre; propiedades:
                               n = nombre ("Av. Caracas"), c = nomenclatura ("AK 14"),
                               k = clase (1 arterial, 2 intermedia, 3 local)

Uso:
    python3 scripts/construir_etiquetas.py
"""
import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "data"
BBOX = json.loads((ROOT / "src" / "data" / "ciclorrutas-bbox.json").read_text())

KX = math.cos(math.radians(4.65)) * 111_320  # metros por grado de longitud
KY = 110_574
SIMPLIFY = 3.0  # m
MIN_LENGTH = {1: 0, 2: 80, 3: 120}  # m: tramos más cortos no alcanzan a llevar etiqueta
LOCALITY_MARGIN = 0.02  # grados alrededor del recuadro de las ciclorrutas

# Los datos vienen en mayúsculas y sin tildes.
ACCENTS = {
    "LOS MARTIRES": "Los Mártires",
    "USAQUEN": "Usaquén",
    "FONTIBON": "Fontibón",
    "ENGATIVA": "Engativá",
    "SAN CRISTOBAL": "San Cristóbal",
    "CIUDAD BOLIVAR": "Ciudad Bolívar",
}
SMALL_WORDS = {"de", "del", "la", "las", "los", "el", "y", "al", "a"}
ABBREVIATIONS = {"avenida": "Av.", "autopista": "Autop.", "carrera": "Cra.", "calle": "Cl."}


def pretty(name):
    words = []
    for index, word in enumerate(name.lower().split()):
        if index == 0 and word in ABBREVIATIONS:
            words.append(ABBREVIATIONS[word])
        elif index > 0 and word in SMALL_WORDS:
            words.append(word)
        else:
            words.append(word.capitalize())
    return " ".join(words)


# --- Localidades --------------------------------------------------------------


def clip(ring, west, south, east, north):
    """Recorta un anillo contra un rectángulo (Sutherland-Hodgman)."""
    edges = (
        (lambda p: p[0] >= west, lambda a, b: (west, a[1] + (b[1] - a[1]) * (west - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= east, lambda a, b: (east, a[1] + (b[1] - a[1]) * (east - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= south, lambda a, b: (a[0] + (b[0] - a[0]) * (south - a[1]) / (b[1] - a[1]), south)),
        (lambda p: p[1] <= north, lambda a, b: (a[0] + (b[0] - a[0]) * (north - a[1]) / (b[1] - a[1]), north)),
    )
    points = [tuple(p[:2]) for p in ring]
    for inside, cross in edges:
        if not points:
            break
        result = []
        previous = points[-1]
        for current in points:
            if inside(current):
                if not inside(previous):
                    result.append(cross(previous, current))
                result.append(current)
            elif inside(previous):
                result.append(cross(previous, current))
            previous = current
        points = result
    return points


def centroid(points):
    """Área (m²) y centroide de un polígono."""
    area = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if area == 0:
        return 0.0, None
    return abs(area) / 2 * KX * KY, (cx / (3 * area), cy / (3 * area))


def build_places():
    box = (
        BBOX["west"] - LOCALITY_MARGIN,
        BBOX["south"] - LOCALITY_MARGIN,
        BBOX["east"] + LOCALITY_MARGIN,
        BBOX["north"] + LOCALITY_MARGIN,
    )
    features = []
    for feature in json.loads((RAW / "localidades.geojson").read_text())["features"]:
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        # La etiqueta va en el centro de la parte visible de la localidad: varias se
        # extienden muy al sur, fuera de la zona con ciclorrutas.
        best_area, best_point = 0.0, None
        for polygon in polygons:
            area, point = centroid(clip(polygon[0], *box))
            if point and area > best_area:
                best_area, best_point = area, point
        if best_area < 1e6:
            continue
        raw = feature["properties"]["LOCNOMBRE"].strip()
        features.append(
            {
                "type": "Feature",
                "properties": {"n": ACCENTS.get(raw, pretty(raw))},
                "geometry": {"type": "Point", "coordinates": [round(best_point[0], 5), round(best_point[1], 5)]},
            }
        )
    return features


# --- Vías -----------------------------------------------------------------------


def metres(a, b):
    return math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY)


def simplify(points):
    """Douglas-Peucker iterativo."""
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        ax, ay = points[first][0] * KX, points[first][1] * KY
        bx, by = points[last][0] * KX, points[last][1] * KY
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        worst, index = 0.0, -1
        for i in range(first + 1, last):
            px, py = points[i][0] * KX - ax, points[i][1] * KY - ay
            distance = abs(px * dy - py * dx) / norm if norm else math.hypot(px, py)
            if distance > worst:
                worst, index = distance, i
        if worst > SIMPLIFY:
            keep[index] = True
            stack += [(first, index), (index, last)]
    return [p for p, k in zip(points, keep) if k]


def chain(segments):
    """Une los tramos que se tocan por los extremos en líneas lo más largas posible."""
    by_end = defaultdict(list)
    for index, segment in enumerate(segments):
        by_end[segment[0]].append(index)
        by_end[segment[-1]].append(index)
    used = [False] * len(segments)

    def extend(line):
        # Se sigue solo donde la continuación es única, para no saltar entre calzadas.
        while True:
            candidates = [i for i in by_end[line[-1]] if not used[i]]
            if len(by_end[line[-1]]) != 2 or len(candidates) != 1:
                return
            nxt = segments[candidates[0]]
            used[candidates[0]] = True
            line.extend(nxt[1:] if nxt[0] == line[-1] else nxt[-2::-1])

    lines = []
    for index, segment in enumerate(segments):
        if used[index]:
            continue
        used[index] = True
        line = list(segment)
        extend(line)
        line.reverse()
        extend(line)
        lines.append(line)
    return lines


def build_streets():
    groups = defaultdict(list)
    for feature in json.loads((RAW / "malla_vial.geojson").read_text())["features"]:
        props = feature["properties"]
        kind = props["MVITCLA"]
        if kind not in MIN_LENGTH or not feature["geometry"]:
            continue
        name = (props["MVINOMBRE"] or "").strip()
        name = "" if name in ("", "SIN_NMG") else pretty(name)
        code = " ".join((props["MVIETIQUET"] or "").split())
        if not name and not code:
            continue
        geometry = feature["geometry"]
        parts = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
        for part in parts:
            points = [(round(p[0], 6), round(p[1], 6)) for p in part]
            if len(points) >= 2 and points[0] != points[-1]:
                groups[(name, code, kind)].append(points)

    features = []
    for (name, code, kind), segments in groups.items():
        for line in chain(segments):
            length = sum(metres(a, b) for a, b in zip(line, line[1:]))
            if length < MIN_LENGTH[kind]:
                continue
            properties = {"k": kind}
            if name:
                properties["n"] = name
            if code:
                properties["c"] = code
            features.append(
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": {"type": "LineString", "coordinates": simplify(line)},
                }
            )
    return features


def write(name, features):
    path = OUT / name
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":"))
    )
    print(f"  {name}: {len(features)} elementos, {path.stat().st_size / 1e6:.1f} MB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    write("etiquetas-lugares.geojson", build_places())
    write("etiquetas-vias.geojson", build_streets())


if __name__ == "__main__":
    main()
