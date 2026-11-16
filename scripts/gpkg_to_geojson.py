#!/usr/bin/env python3
"""Convierte la capa de ciclorrutas del GeoPackage de IDECA a GeoJSON para la webapp.

Solo usa la biblioteca estándar (no requiere GDAL).

Uso:
    python3 scripts/gpkg_to_geojson.py [entrada.gpkg] [salida.geojson]
"""
import json
import math
import sqlite3
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IN = ROOT / "data" / "Ciclorruta.gpkg"
DEFAULT_OUT = ROOT / "public" / "data" / "ciclorrutas.geojson"
# Recuadro que contiene todas las ciclorrutas; el visor solo pide elevación a IDECA dentro de él.
BBOX_OUT = ROOT / "src" / "data" / "ciclorrutas-bbox.json"

# Bytes del sobre (envelope) según el indicador del encabezado GeoPackage.
ENVELOPE_BYTES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
DECIMALS = 7  # ~1 cm


# Al convertir arcos en segmentos, la cuerda no se aleja del arco más que esta tolerancia.
# Un paso angular fijo no sirve: en arcos de radio grande el error llega a decímetros,
# lo cual es mucho para franjas de ~2 m de ancho.
ARC_TOLERANCE_DEG = 0.02 / 111_320  # 2 cm expresados en grados
ARC_MAX_STEP = math.radians(15)


def linearize_arc(p0, p1, p2):
    """Puntos intermedios y final de un arco circular definido por tres puntos."""
    # Plano local: se escala la longitud para que el círculo no salga deformado.
    k = math.cos(math.radians(p1[1]))
    ax, ay, bx, by, cx, cy = p0[0] * k, p0[1], p1[0] * k, p1[1], p2[0] * k, p2[1]
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    chord = math.hypot(cx - ax, cy - ay) or math.hypot(bx - ax, by - ay)
    if chord == 0 or abs(d) < 1e-12 * chord * chord:
        return [p1, p2]  # colineales o degenerados
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay)
          + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx)
          + (cx * cx + cy * cy) * (bx - ax)) / d
    radius = math.hypot(ax - ux, ay - uy)
    a0 = math.atan2(ay - uy, ax - ux)
    a1 = math.atan2(by - uy, bx - ux)
    a2 = math.atan2(cy - uy, cx - ux)
    tau = 2 * math.pi
    if (ax, ay) == (cx, cy):  # círculo completo
        sweep = tau
    else:
        sweep = (a2 - a0) % tau
        if (a1 - a0) % tau > sweep:  # el punto medio queda del otro lado: sentido horario
            sweep -= tau
    step = min(ARC_MAX_STEP, 2 * math.acos(max(0.0, 1 - ARC_TOLERANCE_DEG / radius)))
    steps = max(2, math.ceil(abs(sweep) / step))
    points = []
    for i in range(1, steps):
        angle = a0 + sweep * i / steps
        points.append([(ux + radius * math.cos(angle)) / k, uy + radius * math.sin(angle)])
    points.append(p2)
    return points


class WkbReader:
    """Lee WKB (ISO/EWKB), incluidas las geometrías curvas que exporta ArcGIS."""

    def __init__(self, data, pos=0):
        self.data = data
        self.pos = pos

    def _unpack(self, fmt, size, endian):
        value = struct.unpack_from(endian + fmt, self.data, self.pos)
        self.pos += size
        return value

    def _header(self):
        endian = "<" if self.data[self.pos] == 1 else ">"
        self.pos += 1
        (code,) = self._unpack("I", 4, endian)
        has_z = bool(code & 0x80000000)
        has_m = bool(code & 0x40000000)
        code &= 0x0FFFFFFF
        iso_dim, base = divmod(code, 1000)
        dims = 2 + (has_z or iso_dim in (1, 3)) + (has_m or iso_dim in (2, 3))
        return endian, base, dims

    def _count(self, endian):
        return self._unpack("I", 4, endian)[0]

    def _points(self, endian, dims):
        count = self._count(endian)
        values = self._unpack(f"{count * dims}d", count * dims * 8, endian)
        return [[values[i], values[i + 1]] for i in range(0, count * dims, dims)]

    def _curve(self):
        """LineString, CircularString o CompoundCurve -> lista de puntos."""
        endian, base, dims = self._header()
        if base == 2:
            return self._points(endian, dims)
        if base == 8:
            pts = self._points(endian, dims)
            out = pts[:1]
            for i in range(0, len(pts) - 2, 2):
                out.extend(linearize_arc(pts[i], pts[i + 1], pts[i + 2]))
            return out
        if base == 9:
            out = []
            for _ in range(self._count(endian)):
                part = self._curve()
                out.extend(part[1:] if out else part)
            return out
        raise ValueError(f"Tipo de curva WKB no soportado: {base}")

    def _surface(self):
        """Polygon o CurvePolygon -> lista de anillos."""
        endian, base, dims = self._header()
        if base == 3:
            return [self._points(endian, dims) for _ in range(self._count(endian))]
        if base == 10:
            return [self._curve() for _ in range(self._count(endian))]
        raise ValueError(f"Tipo de superficie WKB no soportado: {base}")

    def geometry(self):
        start = self.pos
        endian, base, _ = self._header()
        if base in (3, 10):
            self.pos = start
            return {"type": "Polygon", "coordinates": rounded(self._surface())}
        if base in (6, 12):
            polygons = [self._surface() for _ in range(self._count(endian))]
            return {"type": "MultiPolygon", "coordinates": rounded(nest_holes(polygons))}
        if base in (2, 8, 9):
            self.pos = start
            return {"type": "LineString", "coordinates": rounded(self._curve())}
        if base in (5, 11):
            lines = [self._curve() for _ in range(self._count(endian))]
            return {"type": "MultiLineString", "coordinates": rounded(lines)}
        raise ValueError(f"Tipo de geometría WKB no soportado: {base}")


def ring_area(ring):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))) / 2


def point_in_ring(point, ring):
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def nest_holes(polygons):
    """Algunas superficies llegan con sus huecos como partes sueltas: se reubican como anillos interiores."""
    if len(polygons) < 2:
        return polygons
    order = sorted(range(len(polygons)), key=lambda i: -ring_area(polygons[i][0]))
    kept = []
    for i in order:
        outer = polygons[i][0]
        parent = next((k for k in kept if all(point_in_ring(pt, k[0]) for pt in outer[:3])), None)
        # Solo es hueco si cae dentro del exterior y no dentro de un hueco ya existente.
        if parent and not any(point_in_ring(outer[0], hole) for hole in parent[1:]):
            parent.extend(polygons[i])
        else:
            kept.append(list(polygons[i]))
    return kept


def bounding_box(features):
    west = south = math.inf
    east = north = -math.inf

    def visit(coords):
        nonlocal west, south, east, north
        if isinstance(coords[0], (int, float)):
            west, east = min(west, coords[0]), max(east, coords[0])
            south, north = min(south, coords[1]), max(north, coords[1])
        else:
            for child in coords:
                visit(child)

    for feature in features:
        visit(feature["geometry"]["coordinates"])
    return west, south, east, north


def rounded(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], DECIMALS), round(coords[1], DECIMALS)]
    return [rounded(c) for c in coords]


def parse_gpkg_geometry(blob):
    if blob is None or blob[:2] != b"GP":
        return None
    flags = blob[3]
    if flags & 0b00010000:  # geometría vacía
        return None
    envelope = ENVELOPE_BYTES[(flags >> 1) & 0b111]
    return WkbReader(blob, 8 + envelope).geometry()


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IN
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT

    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    table, geom_col, srs_id = con.execute(
        "SELECT c.table_name, g.column_name, g.srs_id "
        "FROM gpkg_contents c JOIN gpkg_geometry_columns g USING (table_name) "
        "WHERE c.data_type = 'features' LIMIT 1"
    ).fetchone()
    # MAGNA-SIRGAS (4686) coincide con WGS84 a nivel de centímetros: no hace falta reproyectar.
    if srs_id not in (4686, 4326):
        raise SystemExit(f"SRS {srs_id} no soportado: se esperaba 4686 o 4326")

    columns = [row[1] for row in con.execute(f'PRAGMA table_info("{table}")')]
    attrs = [c for c in columns if c != geom_col and not c.upper().startswith("SHAPE_")]

    features = []
    skipped = 0
    query = f'SELECT "{geom_col}", ' + ", ".join(f'"{c}"' for c in attrs) + f' FROM "{table}"'
    for row in con.execute(query):
        geometry = parse_gpkg_geometry(row[0])
        if geometry is None:
            skipped += 1
            continue
        features.append(
            {"type": "Feature", "properties": dict(zip(attrs, row[1:])), "geometry": geometry}
        )

    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, separators=(",", ":"))

    west, south, east, north = bounding_box(features)
    BBOX_OUT.parent.mkdir(parents=True, exist_ok=True)
    BBOX_OUT.write_text(
        json.dumps({"west": west, "south": south, "east": east, "north": north}, indent=2) + "\n"
    )

    size_mb = dst.stat().st_size / 1e6
    print(f"{len(features)} elementos ({skipped} sin geometría) -> {dst} ({size_mb:.1f} MB)")
    print(f"Recuadro de las ciclorrutas -> {BBOX_OUT}")


if __name__ == "__main__":
    main()
