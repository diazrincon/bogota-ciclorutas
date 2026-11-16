#!/usr/bin/env python3
"""Descarga de IDECA las capas necesarias para calcular rutas.

Guarda en data/raw/ (no versionado):
  - red_biciusuarios.geojson  ejes de la infraestructura para bicicletas
  - malla_vial.geojson        ejes de las vías (solo dentro del recuadro de las ciclorrutas)
  - puentes.geojson           polígonos de puentes (para corregir la elevación)
  - dominios.json             leyendas de los códigos de las capas

Uso:
    python3 scripts/descargar_redes.py [--forzar]
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
BBOX = json.loads((ROOT / "src" / "data" / "ciclorrutas-bbox.json").read_text())
SERVICE = (
    "https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/"
    "Mapa_Referencia/Mapa_Referencia/MapServer"
)
PAGE = 1000
MARGIN = 0.005  # ~550 m alrededor del recuadro, para no cortar vías en el borde

LAYERS = {
    "red_biciusuarios": {"id": 19, "bbox": False},
    "malla_vial": {"id": 13, "bbox": True},
    "puentes": {"id": 14, "bbox": True},
}


def fetch_json(url, params, retries=4):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    for attempt in range(retries):
        try:
            request = urllib.request.Request(full, headers={"User-Agent": "visor-ciclorrutas"})
            with urllib.request.urlopen(request, timeout=120) as response:
                data = json.loads(response.read())
            if "error" in data:
                raise RuntimeError(data["error"])
            return data
        except Exception as error:  # noqa: BLE001 - se reintenta ante cualquier fallo de red
            if attempt == retries - 1:
                raise
            print(f"  reintento tras error: {error}")
            time.sleep(3 * (attempt + 1))


def download_layer(name, layer_id, use_bbox):
    params = {
        "where": "1=1",
        "outFields": "*",
        "outSR": 4326,
        "geometryPrecision": 7,
        "orderByFields": "OBJECTID",
        "resultRecordCount": PAGE,
        "f": "geojson",
    }
    if use_bbox:
        params.update(
            geometry=(
                f"{BBOX['west'] - MARGIN},{BBOX['south'] - MARGIN},"
                f"{BBOX['east'] + MARGIN},{BBOX['north'] + MARGIN}"
            ),
            geometryType="esriGeometryEnvelope",
            inSR=4326,
            spatialRel="esriSpatialRelIntersects",
        )
    features = []
    offset = 0
    while True:
        page = fetch_json(f"{SERVICE}/{layer_id}/query", {**params, "resultOffset": offset})
        batch = page.get("features", [])
        features.extend(batch)
        print(f"  {name}: {len(features)}", end="\r", flush=True)
        if len(batch) < PAGE:
            break
        offset += PAGE
        time.sleep(0.2)  # sin prisa: es un servicio público
    print(f"  {name}: {len(features)} elementos")
    out = RAW / f"{name}.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))


def main():
    force = "--forzar" in sys.argv
    RAW.mkdir(parents=True, exist_ok=True)
    for name, spec in LAYERS.items():
        if (RAW / f"{name}.geojson").exists() and not force:
            print(f"  {name}: ya existe (usa --forzar para volver a descargar)")
            continue
        download_layer(name, spec["id"], spec["bbox"])

    ids = json.dumps([spec["id"] for spec in LAYERS.values()])
    domains = fetch_json(f"{SERVICE}/queryDomains", {"layers": ids, "f": "json"})
    (RAW / "dominios.json").write_text(json.dumps(domains, ensure_ascii=False, indent=1))
    print("  dominios.json")


if __name__ == "__main__":
    main()
