#!/usr/bin/env python3
"""Descarga el MDT 2025 de IDECA remuestreado a ~5 m sobre el recuadro de las ciclorrutas.

Se usa solo en el preprocesamiento, para dar elevación a los tramos de la red. Son una
docena de peticiones grandes en lugar de miles de consultas puntuales.

Guarda en data/raw/ (no versionado):
  - mdt.f32   float32 little-endian, filas de norte a sur; NaN donde no hay dato
  - mdt.json  georreferenciación de la grilla

Uso:
    python3 scripts/descargar_mdt.py [--forzar]
"""
import array
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
BBOX = json.loads((ROOT / "src" / "data" / "ciclorrutas-bbox.json").read_text())
EXPORT = (
    "https://serviciosgis.catastrobogota.gov.co/image/rest/services/Imagenes/"
    "modelodigitalterreno2025funcion/ImageServer/exportImage"
)
RES = 4.5e-5  # grados por píxel (~5 m)
MARGIN = 0.005  # el mismo margen que la descarga de la malla vial
CHUNK = 2048


def fetch_chunk(west, south, east, north, width, height, retries=4):
    params = {
        "bbox": f"{west},{south},{east},{north}",
        "bboxSR": 4326,
        "imageSR": 4326,
        "size": f"{width},{height}",
        "format": "bip",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    url = f"{EXPORT}?{urllib.parse.urlencode(params)}"
    expected = width * height * 4 + width * height // 8
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "visor-ciclorrutas"})
            with urllib.request.urlopen(request, timeout=300) as response:
                data = response.read()
            if len(data) != expected:
                raise RuntimeError(f"tamaño inesperado: {len(data)} en vez de {expected}")
            return data
        except Exception as error:  # noqa: BLE001 - se reintenta ante cualquier fallo de red
            if attempt == retries - 1:
                raise
            print(f"  reintento tras error: {error}")
            time.sleep(5 * (attempt + 1))


def main():
    out, meta_out = RAW / "mdt.f32", RAW / "mdt.json"
    if out.exists() and meta_out.exists() and "--forzar" not in sys.argv:
        print("  mdt: ya existe (usa --forzar para volver a descargar)")
        return
    RAW.mkdir(parents=True, exist_ok=True)

    west = BBOX["west"] - MARGIN
    north = BBOX["north"] + MARGIN
    # Dimensiones múltiplo de 8: la máscara de validez viene empaquetada a 1 bit por píxel.
    width = math.ceil((BBOX["east"] + MARGIN - west) / RES / 8) * 8
    height = math.ceil((north - (BBOX["south"] - MARGIN)) / RES / 8) * 8

    grid = array.array("f", [math.nan]) * (width * height)
    assert grid.itemsize == 4 and sys.byteorder == "little"

    total = math.ceil(width / CHUNK) * math.ceil(height / CHUNK)
    done = 0
    for row0 in range(0, height, CHUNK):
        rows = min(CHUNK, height - row0)
        for col0 in range(0, width, CHUNK):
            cols = min(CHUNK, width - col0)
            data = fetch_chunk(
                west + col0 * RES,
                north - (row0 + rows) * RES,
                west + (col0 + cols) * RES,
                north - row0 * RES,
                cols,
                rows,
            )
            values = array.array("f")
            values.frombytes(data[: cols * rows * 4])
            mask = data[cols * rows * 4 :]
            for i in range(cols * rows):
                # Bit más significativo primero; 0 = sin dato.
                if not (mask[i >> 3] >> (7 - (i & 7))) & 1 or values[i] <= 0:
                    values[i] = math.nan
            for r in range(rows):
                start = (row0 + r) * width + col0
                grid[start : start + cols] = values[r * cols : (r + 1) * cols]
            done += 1
            print(f"  mdt: {done}/{total} bloques", end="\r", flush=True)
            time.sleep(0.5)

    with open(out, "wb") as fh:
        grid.tofile(fh)
    meta_out.write_text(
        json.dumps({"west": west, "north": north, "res": RES, "width": width, "height": height})
    )
    valid = sum(1 for v in grid if v == v)
    print(f"  mdt: {width}×{height} px, {100 * valid / len(grid):.1f} % con dato -> {out}")


if __name__ == "__main__":
    main()
