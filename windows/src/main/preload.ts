// The narrow bridge between the editor page and the main process. The page never touches Node directly.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface FileFilter { name: string; extensions: string[] }

const api = {
  platform: process.platform,
  openDialog: (options: { title?: string; filters?: FileFilter[]; properties?: string[]; defaultPath?: string }) =>
    ipcRenderer.invoke('dialog:open', options) as Promise<string[] | null>,
  saveDialog: (options: { title?: string; filters?: FileFilter[]; defaultPath?: string }) =>
    ipcRenderer.invoke('dialog:save', options) as Promise<string | null>,
  readFile: (file: string) => ipcRenderer.invoke('fs:read', file) as Promise<Uint8Array>,
  writeFile: (file: string, data: Uint8Array) => ipcRenderer.invoke('fs:write', file, data) as Promise<void>,
  stat: (file: string) => ipcRenderer.invoke('fs:stat', file) as Promise<{ exists: boolean; isDirectory: boolean; isFile: boolean; size: number }>,
  readPackage: (folder: string) => ipcRenderer.invoke('fs:read-package', folder) as Promise<Record<string, Uint8Array>>,
  writePackage: (folder: string, files: Record<string, Uint8Array>) => ipcRenderer.invoke('fs:write-package', folder, files) as Promise<void>,
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image') as Promise<Uint8Array | null>,
  clipboardHasImage: () => ipcRenderer.invoke('clipboard:has-image') as Promise<boolean>,
  writeClipboardImage: (png: Uint8Array) => ipcRenderer.invoke('clipboard:write-image', png) as Promise<void>,
  version: () => ipcRenderer.invoke('app:version') as Promise<string>,
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates') as Promise<{ status: string; version?: string; message?: string }>,
  modelStatus: () => ipcRenderer.invoke('app:model-status') as Promise<{ available: boolean; size: number }>,
  downloadModel: () => ipcRenderer.invoke('app:download-model') as Promise<void>,
  onModelProgress: (listener: (progress: { received: number; total: number }) => void) => {
    const handler = (_event: unknown, progress: { received: number; total: number }) => listener(progress);
    ipcRenderer.on('app:model-progress', handler);
    return () => { ipcRenderer.removeListener('app:model-progress', handler); };
  },
  pathForFile: (file: File) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  setTitle: (title: string) => ipcRenderer.send('window:set-title', title),
  toggleFullScreen: () => ipcRenderer.send('window:toggle-full-screen'),
  accentColor: () => ipcRenderer.invoke('app:accent-color') as Promise<string | null>,
  rendererReady: () => ipcRenderer.send('app:renderer-ready'),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  onOpenFiles: (listener: (paths: string[]) => void) => {
    const handler = (_event: unknown, paths: string[]) => listener(paths);
    ipcRenderer.on('app:open-files', handler);
    return () => { ipcRenderer.removeListener('app:open-files', handler); };
  },
  onCloseRequested: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('app:close-requested', handler);
    return () => { ipcRenderer.removeListener('app:close-requested', handler); };
  },
  onFullScreen: (listener: (full: boolean) => void) => {
    const handler = (_event: unknown, full: boolean) => listener(full);
    ipcRenderer.on('app:full-screen', handler);
    return () => { ipcRenderer.removeListener('app:full-screen', handler); };
  },
};

export type CompositorBridge = typeof api;
contextBridge.exposeInMainWorld('compositor', api);
