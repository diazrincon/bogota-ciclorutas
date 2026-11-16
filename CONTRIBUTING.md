# Cómo contribuir

Gracias por el interés. Reportes de errores, correcciones y mejoras son bienvenidos.

## Reportar un problema

Abre un issue con lo que hiciste, lo que esperabas y lo que pasó. Si es una ruta rara (contravía, un desvío sin sentido), incluye las coordenadas o una captura del origen y el destino: suele ser un problema de los datos y así se puede ubicar el tramo.

## Proponer cambios

1. Haz un fork y crea una rama desde `develop` con el prefijo `feature/` o `fix/`.
2. Comprueba que `npm run build` pasa y prueba el cambio en el navegador con `npm run dev`.
3. Abre el pull request contra `develop` explicando qué cambia y por qué.

El proyecto usa gitflow: `main` solo recibe versiones publicadas y el trabajo diario va en `develop`.

## Convenciones

- Código y nombres de variables en inglés; comentarios, mensajes de commit y textos de la interfaz en español.
- Mensajes de commit con prefijo de tipo: `feat(...)`, `fix(...)`, `chore(...)`, `docs(...)`.
- Si cambias los scripts de datos, regenera los archivos de `public/data/` con `npm run data` e inclúyelos en el mismo pull request.
- Los scripts descargan de servicios públicos de IDECA: mantén las pausas entre peticiones y evita descargas innecesarias.
