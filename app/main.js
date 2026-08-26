// ManageFreak — Electron main process
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 880,
    minWidth: 1100,
    minHeight: 640,
    show: false, // mostrata solo dopo la massimizzazione (niente flicker)
    title: 'ManageFreak',
    backgroundColor: '#16161e',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // avvio a schermo pieno (maximized, non fullscreen)
  mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.argv.includes('--smoke')) {
    const errors = [];
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) errors.push(message);
    });
    mainWindow.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const checks = await mainWindow.webContents.executeJavaScript(`(async () => {
          const missing = [];
          if (typeof Midi === 'undefined') missing.push('Midi');
          if (typeof MF === 'undefined') missing.push('MF');
          if (typeof Mfp === 'undefined') missing.push('Mfp');
          if (typeof Params === 'undefined') missing.push('Params');
          if (typeof Library === 'undefined') missing.push('Library');
          const dom = ['midi-input', 'midi-output', 'slot-list', 'lib-grid', 'detail', 'lib-list', 'btn-view-toggle', 'device-panel', 'device-header', 'layout', 'device-selbar', 'btn-download-bank'].filter(
            (id) => !document.getElementById(id)
          );
          const issues = [];
          if (document.querySelectorAll('.resizer').length !== 3) issues.push('missing resizers (expected 3)');
          // tab bar: Presets / Wavetables / Samples / Device
          const tabBtns = Array.from(document.querySelectorAll('#tabs .tab-btn'));
          if (tabBtns.length !== 4) issues.push('tab buttons missing (expected 4)');
          else {
            const idByTab = { presets: 'library-view', wavetables: 'wavetable-view', samples: 'samples-view', device: 'device-view' };
            const sidebarByTab = { presets: 'sidebar-library', wavetables: 'sidebar-wavetables', samples: 'sidebar-samples', device: 'sidebar-library' };
            for (const btn of tabBtns) {
              btn.click();
              const view = document.getElementById(idByTab[btn.dataset.tab]);
              if (!view || view.classList.contains('hidden')) issues.push('tab view not shown: ' + btn.dataset.tab);
              const side = document.getElementById(sidebarByTab[btn.dataset.tab]);
              if (!side || side.classList.contains('hidden')) issues.push('sidebar not shown: ' + btn.dataset.tab);
              const backup = document.getElementById('sidebar-backup');
              const backupHidden = !backup || backup.classList.contains('hidden');
              if (btn.dataset.tab === 'presets' ? backupHidden : !backupHidden) {
                issues.push('backup section visibility wrong for ' + btn.dataset.tab);
              }
            }
            tabBtns[0].click();
            if (document.getElementById('library-view').classList.contains('hidden')) issues.push('presets view not restored');
            // split a due pannelli in wavetable e sample (PC a sinistra, dispositivo a destra)
            for (const tab of ['wavetables', 'samples']) {
              const view = document.getElementById(idByTab[tab]);
              if (!view.querySelector('.pane-pc') || !view.querySelector('.pane-dev')) issues.push('pane split missing in ' + tab);
            }
          }
          const libList = document.getElementById('lib-list');
          const catList = document.getElementById('cat-list');
          if (!libList || libList.children.length < 3) issues.push('lib-list not populated');
          if (!catList) issues.push('cat-list missing');
          else {
            const cats = Array.from(catList.querySelectorAll('[data-cat]')).map((i) => i.dataset.cat);
            if (!cats.includes('fav')) issues.push('missing Favorites entry');
            if (!cats.includes('all')) issues.push('missing All entry');
          }
          // toggle vista
          const toggle = document.getElementById('btn-view-toggle');
          if (toggle) {
            toggle.click();
            const grid = document.getElementById('lib-grid');
            if (!grid.classList.contains('lib-list-view')) issues.push('view toggle not applied');
            toggle.click();
            if (grid.classList.contains('lib-list-view')) issues.push('view toggle not reversible');
          }
          // multi-selezione con Ctrl → azioni nel pannello dettagli
          const cards = Array.from(document.querySelectorAll('#lib-grid .lib-card, #lib-grid .lib-row'));
          if (cards.length >= 2) {
            cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
            cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
            const detailActions = document.getElementById('detail-actions');
            const nMulti = detailActions ? detailActions.querySelectorAll('button').length : 0;
            if (nMulti < 5) issues.push('multi-selection actions missing in details: ' + nMulti);
            // deselezione: click singolo su una card già selezionata → pannello vuoto
            cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const detailHidden = document.getElementById('detail').classList.contains('hidden');
            const emptyShown = !document.getElementById('detail-empty').classList.contains('hidden');
            if (!detailHidden || !emptyShown) issues.push('click su card selezionata non ha deselezionato');
          }
          return JSON.stringify({ missing, dom, issues });
        })()`);
        const parsed = JSON.parse(checks);
        const ok = parsed.missing.length === 0 && parsed.dom.length === 0 && parsed.issues.length === 0 && errors.length === 0;
        console.log('SMOKE_RESULT ' + JSON.stringify({ ok, ...parsed, consoleErrors: errors }));
        app.exit(ok ? 0 : 1);
      } catch (e) {
        console.log('SMOKE_RESULT ' + JSON.stringify({ ok: false, exception: String(e), consoleErrors: errors }));
        app.exit(1);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// IPC: filesystem (bounded to the user data directory unless explicitly user
// selected via dialog).
// ---------------------------------------------------------------------------

const userDataRoot = () => app.getPath('userData');

function resolveInUserData(p) {
  const base = path.resolve(userDataRoot());
  const resolved = path.resolve(base, p);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path outside the app data directory');
  }
  return resolved;
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  userData: userDataRoot(),
  platform: process.platform,
}));

ipcMain.handle('app:open-user-data', async () => {
  await shell.openPath(userDataRoot());
  return true;
});

ipcMain.handle('fs:read', async (_e, p) => {
  const full = resolveInUserData(p);
  const buf = await fsp.readFile(full);
  return buf.toString('base64');
});

ipcMain.handle('fs:write', async (_e, p, dataB64) => {
  const full = resolveInUserData(p);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, Buffer.from(dataB64, 'base64'));
  return true;
});

ipcMain.handle('fs:exists', async (_e, p) => {
  const full = resolveInUserData(p);
  try {
    await fsp.access(full);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:list', async (_e, p) => {
  const full = resolveInUserData(p);
  const entries = await fsp.readdir(full, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
});

// ---------------------------------------------------------------------------
// IPC: dialogs (user-selected paths are allowed anywhere)
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:open-files', async (_e, options) => {
  const opts = {
    properties: ['openFile', 'multiSelections'],
    filters: (options && options.filters) || [
      { name: 'MicroFreak preset', extensions: ['mfp', 'mbp', 'mfpz', 'mfprojz', 'syx', 'zip'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = await dialog.showOpenDialog(mainWindow, opts);
  if (result.canceled || !result.filePaths.length) return [];
  const files = [];
  for (const fp of result.filePaths) {
    const buf = await fsp.readFile(fp);
    files.push({ path: fp, name: path.basename(fp), data: buf.toString('base64') });
  }
  return files;
});

ipcMain.handle('dialog:save-file', async (_e, options) => {
  const opts = {
    defaultPath: (options && options.defaultName) || 'preset.mfp',
    filters: (options && options.filters) || [
      { name: 'MicroFreak preset', extensions: ['mfp', 'mfpz', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = await dialog.showSaveDialog(mainWindow, opts);
  if (result.canceled || !result.filePath) return null;
  const dataB64 = (options && options.data) || '';
  await fsp.writeFile(result.filePath, Buffer.from(dataB64, 'base64'));
  return result.filePath;
});

ipcMain.handle('dialog:choose-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:export-folder', async (_e, files) => {
  // files: [{name, dataB64}]
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose destination folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const dir = result.filePaths[0];
  for (const f of files) {
    const safe = path.basename(f.name);
    await fsp.writeFile(path.join(dir, safe), Buffer.from(f.dataB64, 'base64'));
  }
  return dir;
});

ipcMain.handle('dialog:export-bank', async (_e, files) => {
  // files: [{name, dataB64}] — crea una sottocartella datata e scrive lì
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Where should the MicroFreak bank be saved?',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const base = result.filePaths[0];
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const folder = path.join(base, `MicroFreak-Bank-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`);
  await fsp.mkdir(folder, { recursive: true });
  for (const f of files) {
    const safe = path.basename(f.name);
    await fsp.writeFile(path.join(folder, safe), Buffer.from(f.dataB64, 'base64'));
  }
  return folder;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
