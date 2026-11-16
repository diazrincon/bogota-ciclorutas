import { defineConfig } from 'vite';

// BASE_PATH es la carpeta desde la que se sirve el sitio. En GitHub Pages es
// "/bogota-ciclorutas/"; en local y en el ejecutable portable, la raíz.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
});
