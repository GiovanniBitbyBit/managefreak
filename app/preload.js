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
  // auto-update
  onUpdateEvent: (cb) => {
    if (typeof cb !== 'function') return;
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('update-event', listener);
    return () => ipcRenderer.removeListener('update-event', listener);
  },
  sendUpdateAction: (action) => ipcRenderer.invoke('update:action', action),
  // ultima release pubblicata su GitHub (changelog per il menu About)
  latestRelease: () => ipcRenderer.invoke('app:latest-release'),
  // apre un link nel browser (solo domini fidati, filtro nel main process)
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  // MIDI nativo (RtMidi nel processo principale): stessi concetti di Web MIDI,
  // ma senza dipendere dallo strato di Chromium che su Windows può incastrarsi.
  midiStatus: () => ipcRenderer.invoke('midi:status'),
  midiList: () => ipcRenderer.invoke('midi:list'),
  midiOpen: (inputId, outputId) => ipcRenderer.invoke('midi:open', inputId, outputId),
  midiClose: () => ipcRenderer.invoke('midi:close'),
  midiSend: (bytes) => ipcRenderer.invoke('midi:send', bytes),
  midiShutdown: () => ipcRenderer.invoke('midi:shutdown'),
  onMidiMessage: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, bytes) => cb(bytes);
    ipcRenderer.on('midi:message', listener);
    return () => ipcRenderer.removeListener('midi:message', listener);
  },
  onMidiState: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('midi:state', listener);
    return () => ipcRenderer.removeListener('midi:state', listener);
  },
  // avviso prima dell'uscita: il renderer rilascia le porte MIDI (senza questo
  // Windows resta con il dispositivo occupato e l'avvio successivo non vede nulla)
  onPrepareQuit: (cb) => {
    if (typeof cb !== 'function') return;
    const listener = () => cb();
    ipcRenderer.on('app:prepare-quit', listener);
    return () => ipcRenderer.removeListener('app:prepare-quit', listener);
  },
});
