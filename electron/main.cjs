// Aplicación de escritorio: muestra el visor en una ventana propia, sin servidor ni
// navegador. El sitio compilado (dist/) va dentro del paquete y se sirve con un
// esquema interno, app://, para que fetch y los módulos funcionen como en la web.
// El relieve y los mapas base se siguen pidiendo a IDECA: hace falta internet.

const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SITE = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://ciclorrutas';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function serveSite(request) {
  const { pathname } = new URL(request.url);
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.join(SITE, relative);
  // Nada fuera de la carpeta del sitio.
  if (!file.startsWith(SITE + path.sep)) return new Response('No permitido', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    title: 'Ciclorrutas de Bogotá',
    backgroundColor: '#cfd8dc',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Los enlaces (créditos de los mapas) se abren en el navegador del sistema.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  window.loadURL(`${ORIGIN}/`);
}

app.whenReady().then(() => {
  protocol.handle('app', serveSite);
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
