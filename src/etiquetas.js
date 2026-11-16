// Nombres de localidades y vías dibujados por MapLibre, para que se lean derechos con
// cualquier giro de la cámara. Los datos los genera scripts/construir_etiquetas.py.

const FONT = ['Open Sans Semibold'];

// Colores del texto según el fondo.
const THEMES = {
  claro: { text: '#3d4854', strong: '#1f2933', halo: 'rgba(255, 255, 255, 0.9)' },
  oscuro: { text: '#e3e8ee', strong: '#ffffff', halo: 'rgba(0, 0, 0, 0.75)' },
};

export const LABEL_LAYERS = ['etiquetas-vias-locales', 'etiquetas-vias', 'etiquetas-lugares'];

export function labelSources(baseUrl) {
  return {
    'etiquetas-vias': { type: 'geojson', data: `${baseUrl}data/etiquetas-vias.geojson`, tolerance: 1 },
    'etiquetas-lugares': { type: 'geojson', data: `${baseUrl}data/etiquetas-lugares.geojson` },
  };
}

// Nombre de la vía; de cerca se le añade la nomenclatura ("Av. Caracas · AK 14").
const STREET_TEXT = [
  'step',
  ['zoom'],
  ['coalesce', ['get', 'n'], ['get', 'c']],
  14,
  [
    'case',
    ['all', ['has', 'n'], ['has', 'c']],
    ['concat', ['get', 'n'], ' · ', ['get', 'c']],
    ['coalesce', ['get', 'n'], ['get', 'c']],
  ],
];

export function labelLayers() {
  const theme = THEMES.claro;
  const halo = { 'text-halo-color': theme.halo, 'text-halo-width': 1.4 };
  return [
    {
      id: 'etiquetas-vias-locales',
      type: 'symbol',
      source: 'etiquetas-vias',
      minzoom: 14.5,
      filter: ['==', ['get', 'k'], 3],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 350,
        'text-field': STREET_TEXT,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 10, 18, 13],
        'text-max-angle': 35,
        // De cara a la pantalla: acostado sobre el mapa se aplasta al inclinar la cámara.
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': theme.text, ...halo },
    },
    {
      id: 'etiquetas-vias',
      type: 'symbol',
      source: 'etiquetas-vias',
      minzoom: 11.5,
      // Primero solo las arteriales; las intermedias entran al acercarse.
      filter: ['any', ['==', ['get', 'k'], 1], ['all', ['==', ['get', 'k'], 2], ['>=', ['zoom'], 13.5]]],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 450,
        'symbol-sort-key': ['get', 'k'],
        'text-field': STREET_TEXT,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 10, 16, 13.5],
        'text-max-angle': 35,
        // De cara a la pantalla: acostado sobre el mapa se aplasta al inclinar la cámara.
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': theme.text, ...halo },
    },
    {
      id: 'etiquetas-lugares',
      type: 'symbol',
      source: 'etiquetas-lugares',
      maxzoom: 15,
      layout: {
        'text-field': ['get', 'n'],
        'text-font': FONT,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 7,
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 14],
      },
      paint: { 'text-color': theme.strong, ...halo, 'text-halo-width': 1.6 },
    },
  ];
}

export function setLabelTheme(map, name) {
  const theme = THEMES[name];
  for (const id of LABEL_LAYERS) {
    map.setPaintProperty(id, 'text-color', id === 'etiquetas-lugares' ? theme.strong : theme.text);
    map.setPaintProperty(id, 'text-halo-color', theme.halo);
  }
}
