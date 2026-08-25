// ManageFreak — preload bridge
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mfapi', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  openUserData: () => ipcRenderer.invoke('app:open-user-data'),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, dataB64) => ipcRenderer.invoke('fs:write', p, dataB64),
  fileExists: (p) => ipcRenderer.invoke('fs:exists', p),
  listDir: (p) => ipcRenderer.invoke('fs:list', p),
  openFiles: (options) => ipcRenderer.invoke('dialog:open-files', options),
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  exportFolder: (files) => ipcRenderer.invoke('dialog:export-folder', files),
  exportBank: (files) => ipcRenderer.invoke('dialog:export-bank', files),
});
