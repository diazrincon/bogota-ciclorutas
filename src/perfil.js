// Panel inferior con el perfil de elevación de la ruta, coloreado por pendiente o por tipo de vía.

import { GROUPS, groupOf } from './red.js';

// Rangos de pendiente (%): límite superior de cada uno y su color.
const SLOPE_BINS = [
  { max: -7, color: '#1b1f4d' },
  { max: -3, color: '#2f3a94' },
  { max: -0.5, color: '#3273c4' },
  { max: 0.5, color: '#4aa56a' },
  { max: 3, color: '#f2cd5c' },
  { max: 6, color: '#e6a45a' },
  { max: 9, color: '#cf7a2c' },
  { max: 12, color: '#a8562a' },
  { max: Infinity, color: '#8f1d1d' },
];
const SLOPE_WINDOW = 40; // m: la pendiente se mide sobre esta distancia para no mostrar ruido
const ASCENT_THRESHOLD = 0.5; // m: cambios menores no cuentan como subida o bajada
const MIN_ELEVATION_SPAN = 30; // m: evita que una ruta plana parezca una montaña
const MARGIN = { top: 10, right: 14, bottom: 30, left: 52 };

const number = (value, digits = 0) =>
  value.toLocaleString('es-CO', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function slopeColor(slope) {
  return SLOPE_BINS.find((bin) => slope < bin.max).color;
}

// Elevación interpolada a una distancia dada a lo largo de la ruta.
function elevationAt(route, target) {
  const { distance, elevation } = route;
  if (target <= 0) return elevation[0];
  if (target >= route.length) return elevation[elevation.length - 1];
  let lo = 0;
  let hi = distance.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (distance[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = distance[hi] - distance[lo];
  const t = span > 0 ? (target - distance[lo]) / span : 0;
  return elevation[lo] + (elevation[hi] - elevation[lo]) * t;
}

function analyse(route) {
  const n = route.coordinates.length;
  // Pendiente (%) del segmento i -> i + 1, medida en una ventana centrada en él.
  const slopes = new Float32Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const middle = (route.distance[i] + route.distance[i + 1]) / 2;
    const from = Math.max(0, middle - SLOPE_WINDOW / 2);
    const to = Math.min(route.length, middle + SLOPE_WINDOW / 2);
    slopes[i] = to > from ? ((elevationAt(route, to) - elevationAt(route, from)) / (to - from)) * 100 : 0;
  }

  // Subida y bajada acumuladas, ignorando oscilaciones menores que el umbral.
  let ascent = 0;
  let descent = 0;
  let anchor = route.elevation[0];
  for (let i = 1; i < n; i++) {
    const delta = route.elevation[i] - anchor;
    if (delta >= ASCENT_THRESHOLD) {
      ascent += delta;
      anchor = route.elevation[i];
    } else if (delta <= -ASCENT_THRESHOLD) {
      descent -= delta;
      anchor = route.elevation[i];
    }
  }

  const metresByGroup = new Float64Array(GROUPS.length);
  for (let i = 0; i < n - 1; i++) {
    metresByGroup[groupOf(route.kinds[i])] += route.distance[i + 1] - route.distance[i];
  }
  return { slopes, ascent, descent, metresByGroup };
}

export class ProfilePanel {
  constructor(root, { onHover, onClear }) {
    this.root = root;
    this.onHover = onHover;
    this.mode = 'pendiente';
    this.route = null;
    this.hoverIndex = -1;

    this.summary = root.querySelector('[data-summary]');
    this.legend = root.querySelector('[data-legend]');
    this.tooltip = root.querySelector('[data-tooltip]');
    this.canvas = root.querySelector('canvas');
    this.buttons = [...root.querySelectorAll('[data-mode]')];

    for (const button of this.buttons) {
      button.addEventListener('click', () => this.setMode(button.dataset.mode));
    }
    root.querySelector('[data-clear]').addEventListener('click', onClear);
    this.canvas.addEventListener('pointermove', (event) => this.handlePointer(event));
    this.canvas.addEventListener('pointerleave', () => this.setHover(-1));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  setRoute(route) {
    this.route = route;
    this.stats = route ? analyse(route) : null;
    this.hoverIndex = -1;
    this.tooltip.hidden = true;
    this.onHover(null);
    this.root.hidden = !route;
    if (!route) return;
    this.summary.textContent =
      `${number(route.length / 1000, 1)} km  +${number(this.stats.ascent)} m / −${number(this.stats.descent)} m`;
    this.renderLegend();
    this.draw();
  }

  setMode(mode) {
    this.mode = mode;
    for (const button of this.buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    if (this.route) {
      this.renderLegend();
      this.draw();
    }
  }

  renderLegend() {
    this.legend.replaceChildren();
    const chip = (color, text) => {
      const item = document.createElement('span');
      item.className = 'chip';
      const swatch = document.createElement('i');
      swatch.style.background = color;
      item.append(swatch, text);
      this.legend.append(item);
    };
    if (this.mode === 'pendiente') {
      const labels = ['< −7 %', '−7 a −3', '−3 a −0,5', 'plano', '0,5 a 3', '3 a 6', '6 a 9', '9 a 12', '> 12 %'];
      SLOPE_BINS.forEach((bin, index) => chip(bin.color, labels[index]));
    } else {
      GROUPS.forEach((group, index) => {
        const metres = this.stats.metresByGroup[index];
        if (metres >= 1) chip(group.color, `${group.label} ${number(metres / 1000, 1)} km`);
      });
    }
  }

  segmentColor(index) {
    return this.mode === 'pendiente'
      ? slopeColor(this.stats.slopes[index])
      : GROUPS[groupOf(this.route.kinds[index])].color;
  }

  layout() {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const { elevation } = this.route;
    let min = Infinity;
    let max = -Infinity;
    for (const value of elevation) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const span = Math.max(max - min, MIN_ELEVATION_SPAN);
    const centre = (max + min) / 2;
    const low = centre - span * 0.6;
    const high = centre + span * 0.6;
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = height - MARGIN.top - MARGIN.bottom;
    return {
      width, height, low, high, plotWidth, plotHeight,
      x: (d) => MARGIN.left + (d / this.route.length) * plotWidth,
      y: (e) => MARGIN.top + (1 - (e - low) / (high - low)) * plotHeight,
    };
  }

  draw() {
    if (!this.route || this.root.hidden) return;
    const ratio = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = this.canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.canvas.width = Math.round(clientWidth * ratio);
    this.canvas.height = Math.round(clientHeight * ratio);
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, clientWidth, clientHeight);

    const L = this.layout();
    const { distance, elevation } = this.route;
    const baseline = MARGIN.top + L.plotHeight;

    // Ejes.
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#56616d';
    ctx.strokeStyle = '#e1e5ea';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStep = niceStep((L.high - L.low) / 4);
    for (let value = Math.ceil(L.low / yStep) * yStep; value <= L.high; value += yStep) {
      const py = Math.round(L.y(value)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, py);
      ctx.lineTo(MARGIN.left + L.plotWidth, py);
      ctx.stroke();
      ctx.fillText(`${number(value)} m`, MARGIN.left - 6, py);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStep = niceStep(this.route.length / 8);
    for (let value = 0; value <= this.route.length; value += xStep) {
      const label = xStep >= 1000 ? `${number(value / 1000)} km` : `${number(value)} m`;
      ctx.fillText(label, L.x(value), baseline + 8);
    }

    // Área bajo el perfil: se agrupan segmentos contiguos del mismo color.
    let runStart = 0;
    let runColor = this.segmentColor(0);
    const flush = (endIndex) => {
      ctx.beginPath();
      ctx.moveTo(L.x(distance[runStart]), baseline);
      for (let i = runStart; i <= endIndex; i++) ctx.lineTo(L.x(distance[i]), L.y(elevation[i]));
      ctx.lineTo(L.x(distance[endIndex]), baseline);
      ctx.closePath();
      ctx.fillStyle = runColor;
      ctx.fill();
    };
    for (let i = 1; i < elevation.length - 1; i++) {
      const color = this.segmentColor(i);
      if (color !== runColor) {
        flush(i);
        runStart = i;
        runColor = color;
      }
    }
    flush(elevation.length - 1);

    // Contorno superior.
    ctx.beginPath();
    for (let i = 0; i < elevation.length; i++) {
      const px = L.x(distance[i]);
      const py = L.y(elevation[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(20, 30, 45, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (this.hoverIndex >= 0) {
      const px = L.x(distance[this.hoverIndex]);
      ctx.strokeStyle = '#1c2530';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, MARGIN.top);
      ctx.lineTo(px, baseline);
      ctx.stroke();
      ctx.fillStyle = '#1c2530';
      ctx.beginPath();
      ctx.arc(px, L.y(elevation[this.hoverIndex]), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  handlePointer(event) {
    if (!this.route) return;
    const rect = this.canvas.getBoundingClientRect();
    const L = this.layout();
    const fraction = (event.clientX - rect.left - MARGIN.left) / L.plotWidth;
    if (fraction < 0 || fraction > 1) return this.setHover(-1);
    const target = fraction * this.route.length;
    const { distance } = this.route;
    let lo = 0;
    let hi = distance.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (distance[mid] <= target) lo = mid;
      else hi = mid;
    }
    this.setHover(target - distance[lo] < distance[hi] - target ? lo : hi);
  }

  setHover(index) {
    if (index === this.hoverIndex) return;
    this.hoverIndex = index;
    this.draw();
    if (index < 0) {
      this.tooltip.hidden = true;
      this.onHover(null);
      return;
    }
    const segment = Math.min(index, this.route.kinds.length - 1);
    const slope = this.stats.slopes[segment];
    this.tooltip.hidden = false;
    this.tooltip.textContent =
      `${number(this.route.distance[index] / 1000, 2)} km · ${number(this.route.elevation[index])} m · ` +
      `${slope >= 0 ? '+' : '−'}${number(Math.abs(slope), 1)} % · ${GROUPS[groupOf(this.route.kinds[segment])].label}`;
    this.onHover(this.route.coordinates[index]);
  }
}

// Paso "redondo" (1, 2 o 5 × 10^n) cercano al valor dado.
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const scaled = raw / power;
  return (scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10) * power;
}
