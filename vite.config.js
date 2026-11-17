import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// BASE_PATH es la carpeta desde la que se sirve el sitio. En GitHub Pages es
// "/bogota-ciclorutas/"; en local y en la app de escritorio, la raíz.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  define: { __APP_VERSION__: JSON.stringify(version) },
});
