// Compositor for Windows: the Electron main process. It owns the window, serves the editor from the app://
// scheme (cross-origin isolated, so the background-removal model can use threads), and does what a page may
// not: native file dialogs, reading and writing files, the system clipboard, and installing updates.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, screen } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const isTest = process.env.COMPOSITOR_TEST === '1';
if (isTest || process.env.COMPOSITOR_SOFTWARE_GL === '1') {
  // Headless test machines have no GPU; SwiftShader still gives WebGL 2.
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
if (process.env.COMPOSITOR_USER_DATA) app.setPath('userData', process.env.COMPOSITOR_USER_DATA);

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

const rendererRoot = path.join(__dirname, '..', 'renderer');
/** Bundled resources (the background-removal model); in development, the project's resources folder. */
const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json', '.onnx': 'application/octet-stream',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function resolveAppPath(url: URL): string | null {
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';
  const models = relative.startsWith('/models/');
  const base = models ? path.join(resourcesRoot, 'models') : rendererRoot;
  const file = path.normalize(path.join(base, models ? relative.slice('/models/'.length) : relative));
  if (!file.startsWith(base)) return null;
  // A model the user downloaded later lives in the profile folder.
  if (models && !existsSync(file)) {
    const downloaded = path.join(app.getPath('userData'), 'models', path.basename(file));
    return existsSync(downloaded) ? downloaded : file;
  }
  return file;
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const file = resolveAppPath(new URL(request.url));
    if (!file || !existsSync(file)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers({
      'Content-Type': mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      // Cross-origin isolation lets ONNX Runtime share memory between threads.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
    });
    return new Response(response.body, { status: 200, headers });
  });
}

// MARK: Window state

interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState | null {
  try {
    const value = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    if (!(value.width > 200 && value.height > 200)) return null;
    // Only reopen where it was if that place is still on a display.
    if (value.x !== undefined && value.y !== undefined) {
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        return value.x! < area.x + area.width - 100 && value.x! + value.width > area.x + 100
          && value.y! < area.y + area.height - 50 && value.y! + 30 > area.y;
      });
      if (!visible) { delete value.x; delete value.y; }
    }
    return value;
  } catch { return null; }
}

function saveWindowState(window: BrowserWindow) {
  try {
    const bounds = window.getNormalBounds();
    const state: WindowState = { ...bounds, maximized: window.isMaximized() };
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch { /* the next launch simply starts at the default size */ }
}

// MARK: Opening files

let mainWindow: BrowserWindow | null = null;
let rendererReady = false;
const pendingOpen: string[] = [];

function filesFromArgv(argv: string[]): string[] {
  // The first argument is the executable (and, unpackaged, the app folder).
  const candidates = argv.slice(app.isPackaged ? 1 : 2);
  return candidates.filter((arg) => !arg.startsWith('-') && existsSync(arg) && path.resolve(arg) !== path.resolve('.'))
    .map((arg) => path.resolve(arg));
}

function openFiles(paths: string[]) {
  if (paths.length === 0) return;
  if (mainWindow && rendererReady) {
    mainWindow.webContents.send('app:open-files', paths);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingOpen.push(...paths);
  }
}

// MARK: The window

let allowClose = false;

function createWindow() {
  const saved = loadWindowState();
  const window = new BrowserWindow({
    width: saved?.width ?? 1180,
    height: saved?.height ?? 780,
    x: saved?.x,
    y: saved?.y,
    minWidth: 800,
    minHeight: 520,
    show: false,
    backgroundColor: '#242424',
    title: 'Compositor',
    icon: path.join(rendererRoot, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1c1c1c', symbolColor: '#d8d8d8', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  window.webContents.setVisualZoomLevelLimits(1, 1);
  // The editor has its own zoom: Ctrl+wheel and Ctrl+= never zoom the page.
  window.webContents.on('zoom-changed', () => window.webContents.setZoomFactor(1));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('app://')) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && (!app.isPackaged || input.control && input.shift)) {
      window.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  window.once('ready-to-show', () => {
    // A first launch fills the screen (without going full screen); after that it opens as it was left.
    if (!saved || saved.maximized) window.maximize();
    if (!process.env.COMPOSITOR_HIDDEN) window.show();
  });
  window.on('close', (event) => {
    saveWindowState(window);
    if (allowClose || !rendererReady) return;
    // The editor asks about unsaved projects first, then closes the window itself.
    event.preventDefault();
    window.webContents.send('app:close-requested');
  });
  window.on('closed', () => { mainWindow = null; rendererReady = false; });
  window.on('enter-full-screen', () => window.webContents.send('app:full-screen', true));
  window.on('leave-full-screen', () => window.webContents.send('app:full-screen', false));
  window.loadURL('app://compositor/index.html');
  return window;
}

// MARK: IPC

function senderWindow(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
}

async function writeAtomically(file: string, data: Uint8Array) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, data);
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/** Reads a Mac-style project package: a folder holding manifest.json and images/. Symbolic links and oversized
 *  files are refused, as the Mac app refuses them. */
async function readPackage(folder: string) {
  const files: Record<string, Uint8Array> = {};
  const manifest = path.join(folder, 'manifest.json');
  const manifestInfo = await fs.lstat(manifest);
  if (!manifestInfo.isFile() || manifestInfo.size > 4 * 1024 * 1024) throw new Error('This is not a valid Compositor project, or its metadata is damaged.');
  files['manifest.json'] = new Uint8Array(await fs.readFile(manifest));
  const images = path.join(folder, 'images');
  if (existsSync(images)) {
    for (const entry of await fs.readdir(images, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(images, entry.name);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 512 * 1024 * 1024) continue;
      files[`images/${entry.name}`] = new Uint8Array(await fs.readFile(file));
    }
  }
  return files;
}

/** Writes a Mac-style project package, replacing any existing one only once the new one is complete. */
async function writePackage(folder: string, files: Record<string, Uint8Array>) {
  const staging = path.join(path.dirname(folder), `.${path.basename(folder)}.${randomUUID()}.tmp`);
  await fs.mkdir(path.join(staging, 'images'), { recursive: true });
  try {
    for (const [name, data] of Object.entries(files)) {
      const target = path.normalize(path.join(staging, name));
      if (!target.startsWith(staging)) throw new Error('Invalid file name in project.');
      await fs.writeFile(target, data);
    }
    let previous: string | null = null;
    if (existsSync(folder)) {
      previous = path.join(path.dirname(folder), `.${path.basename(folder)}.${randomUUID()}.old`);
      await fs.rename(folder, previous);
    }
    try {
      await fs.rename(staging, folder);
    } catch (error) {
      if (previous) await fs.rename(previous, folder);
      throw error;
    }
    if (previous) await fs.rm(previous, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function registerIpc() {
  ipcMain.handle('dialog:open', async (event, options: OpenDialogOptions) => {
    const window = senderWindow(event);
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths;
  });
  ipcMain.handle('dialog:save', async (event, options: SaveDialogOptions) => {
    const window = senderWindow(event);
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  });
  ipcMain.handle('fs:read', async (_event, file: string) => new Uint8Array(await fs.readFile(file)));
  ipcMain.handle('fs:write', async (_event, file: string, data: Uint8Array) => { await writeAtomically(file, data); });
  ipcMain.handle('fs:stat', async (_event, file: string) => {
    try {
      const info = await fs.stat(file);
      return { exists: true, isDirectory: info.isDirectory(), isFile: info.isFile(), size: info.size };
    } catch { return { exists: false, isDirectory: false, isFile: false, size: 0 }; }
  });
  ipcMain.handle('fs:read-package', async (_event, folder: string) => readPackage(folder));
  ipcMain.handle('fs:write-package', async (_event, folder: string, files: Record<string, Uint8Array>) => {
    await writePackage(folder, files);
  });
  ipcMain.handle('fs:temp-dir', () => app.getPath('temp'));
  ipcMain.handle('clipboard:read-image', () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    return new Uint8Array(image.toPNG());
  });
  ipcMain.handle('clipboard:has-image', () => {
    const formats = clipboard.availableFormats();
    return formats.some((format) => format.startsWith('image/')) || !clipboard.readImage().isEmpty();
  });
  ipcMain.handle('clipboard:write-image', (_event, png: Uint8Array) => {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)));
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:open-external', (_event, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('app:model-path', () => path.join(app.getPath('userData'), 'models'));
  ipcMain.handle('app:save-model', async (_event, name: string, data: Uint8Array) => {
    const folder = path.join(app.getPath('userData'), 'models');
    await fs.mkdir(folder, { recursive: true });
    await writeAtomically(path.join(folder, path.basename(name)), data);
  });
  ipcMain.on('app:renderer-ready', (event) => {
    rendererReady = true;
    if (pendingOpen.length) {
      event.sender.send('app:open-files', pendingOpen.splice(0));
    }
  });
  ipcMain.on('app:confirm-close', () => {
    allowClose = true;
    mainWindow?.close();
  });
  ipcMain.on('window:set-title', (event, title: string) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
  });
  ipcMain.handle('app:check-updates', async () => checkForUpdates());
}

// MARK: Updates

async function checkForUpdates(): Promise<{ status: string; version?: string; message?: string }> {
  if (!app.isPackaged) return { status: 'development' };
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = false;
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (!latest || latest === app.getVersion() || !result?.isUpdateAvailable) return { status: 'current', version: app.getVersion() };
    const window = mainWindow ?? undefined;
    const options = {
      type: 'info' as const, buttons: ['Download and Install', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update available', message: `Compositor ${latest} is available.`,
      detail: `You have version ${app.getVersion()}. Download it now? Compositor restarts to install it once it has downloaded.`,
    };
    const choice = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (choice.response !== 0) return { status: 'available', version: latest };
    await autoUpdater.downloadUpdate();
    allowClose = true;
    autoUpdater.quitAndInstall();
    return { status: 'installing', version: latest };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

// MARK: Lifecycle

if (!isTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    openFiles(filesFromArgv(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    registerIpc();
    pendingOpen.push(...filesFromArgv(process.argv));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
