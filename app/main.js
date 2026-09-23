// ManageFreak — Electron main process
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
// MIDI nativo (RtMidi: WinMM/CoreMIDI/ALSA) nel processo principale: lo strato
// Web MIDI di Chromium su Windows può smettere di enumerare i dispositivi.
const midiBackend = require('./midi-backend');

let mainWindow = null;

function logCrash(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* il log non deve mai rompere l'app */
  }
}

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

  // se il processo di rendering crasha (es. driver MIDI instabile),
  // registra l'evento e ricarica automaticamente la finestra
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logCrash('renderer crashed: ' + JSON.stringify(details));
    setTimeout(() => {
      try {
        mainWindow.reload();
      } catch {
        /* finestra già chiusa */
      }
    }, 600);
  });

  mainWindow.on('closed', () => {
    midiBackend.setWindow(null);
    mainWindow = null;
  });

  // il backend MIDI nativo manda i messaggi in arrivo alla finestra
  midiBackend.setWindow(mainWindow);

  // Prima di chiudere la finestra: avvisa il renderer, che rilascia le porte MIDI.
  // Senza questo rilascio Windows resta con il MicroFreak occupato e al successivo
  // avvio l'app non vede più nessuna porta MIDI ("la prima volta funziona, poi no").
  let quitting = false;
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    try {
      mainWindow.webContents.send('app:prepare-quit');
    } catch {
      /* renderer già andato */
    }
    // un attimo per far chiudere le porte al renderer, poi si chiude davvero
    setTimeout(() => {
      try {
        midiBackend.shutdown(); // rilascio nativo delle porte MIDI
      } catch {
        /* niente da fare mentre si esce */
      }
      try {
        mainWindow.destroy();
      } catch {
        /* già chiusa */
      }
    }, 600);
  });

  if (process.argv.includes('--screenshots')) {
    // Cattura i 4 tab in screenshot/presets.png ecc. (strumento per le release).
    // Attese lunghe: l'utente preme Connetti e seleziona qualcosa in ogni schermata.
    mainWindow.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 25000)); // connetti + sincronizzazione
      const outDir = path.join(__dirname, '..', 'screenshots');
      fs.mkdirSync(outDir, { recursive: true });
      try {
        // presets (tab iniziale): l'utente seleziona un preset in libreria
        let img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'presets.png'), img.toPNG());
        // wavetables: l'utente seleziona uno slot wavetable
        await mainWindow.webContents.executeJavaScript(`document.querySelector('.tab-btn[data-tab="wavetables"]').click()`);
        await new Promise((r) => setTimeout(r, 25000));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'wavetables.png'), img.toPNG());
        // samples: l'utente seleziona uno slot sample
        await mainWindow.webContents.executeJavaScript(`document.querySelector('.tab-btn[data-tab="samples"]').click()`);
        await new Promise((r) => setTimeout(r, 25000));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'samples.png'), img.toPNG());
        // device: le impostazioni si caricano da sole
        await mainWindow.webContents.executeJavaScript(`document.querySelector('.tab-btn[data-tab="device"]').click()`);
        await new Promise((r) => setTimeout(r, 15000));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'device.png'), img.toPNG());
        console.log('SCREENSHOTS_OK');
      } catch (e) {
        console.log('SCREENSHOTS_FAIL ' + String(e));
      }
      app.exit(0);
    });
  }

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

// L'aggiornamento automatico è possibile solo nell'app installata su Windows
// (installer NSIS): la versione portable e le build macOS/Linux non hanno un
// canale di update — lì si offre il controllo manuale con link alla release.
const canAutoUpdate = process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  userData: userDataRoot(),
  platform: process.platform,
  canAutoUpdate,
}));

ipcMain.handle('app:open-user-data', async () => {
  await shell.openPath(userDataRoot());
  return true;
});

/** Apre un link nel browser di sistema, solo per domini fidati. */
ipcMain.handle('app:open-external', async (_e, url) => {
  const ok = typeof url === 'string' && /^https:\/\/(github\.com|www\.arturia\.com|ko-fi\.com)\//i.test(url);
  if (!ok) return false;
  await shell.openExternal(url);
  return true;
});

/** Confronto di versioni "1.2.3" → true se a è più recente di b. */
function isNewerVersion(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function fetchLatestRelease() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://api.github.com/repos/GiovanniBitbyBit/managefreak/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ManageFreak' },
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    const j = await res.json();
    return { version: j.tag_name || '', name: j.name || '', body: j.body || '', url: j.html_url || '' };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ultima release pubblicata su GitHub (per il menu About: versione + changelog)
ipcMain.handle('app:latest-release', () => fetchLatestRelease());

// Nessun aggiornamento automatico su questa piattaforma: il check diventa un
// confronto con l'ultima release, con link per scaricarla a mano.
if (!canAutoUpdate) {
  ipcMain.handle('update:action', async (_e, action) => {
    if (action !== 'check') return { unsupported: true, platform: process.platform };
    const rel = await fetchLatestRelease();
    if (rel.error) return { unsupported: true, platform: process.platform, error: rel.error };
    const current = app.getVersion();
    return {
      unsupported: true,
      platform: process.platform,
      current,
      latest: rel.version,
      hasUpdate: isNewerVersion(rel.version, current),
      url: rel.url || 'https://github.com/GiovanniBitbyBit/managefreak/releases/latest',
    };
  });
}

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
// Auto-update (electron-updater)
// ---------------------------------------------------------------------------

let updaterEngine = null;
let updateDownloaded = false;
let autoCheckPending = false; // true durante il check automatico all'avvio
let updatePhase = 'idle'; // idle | check | download | install (per gli errori)

function sendUpdateEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // nelle modalità di test (smoke/screenshots) non aprire dialoghi di update
  if (process.argv.includes('--smoke') || process.argv.includes('--screenshots')) return;
  mainWindow.webContents.send('update-event', payload);
}

function extractReleaseNotes(info) {
  let notes = info && info.releaseNotes;
  if (Array.isArray(notes)) {
    notes = notes
      .map((n) => (typeof n === 'string' ? n : (n && n.note) || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return typeof notes === 'string' && notes.trim() ? notes : '';
}

function initAutoUpdater() {
  // l'auto-update funziona solo nell'app impacchettata (installer NSIS);
  // in sviluppo (`npm start`), nella versione portable e su macOS/Linux non
  // parte nulla: lì il menu About usa il controllo manuale (vedi canAutoUpdate).
  if (!app.isPackaged || !canAutoUpdate) return;
  let au;
  try {
    ({ autoUpdater: au } = require('electron-updater'));
  } catch (e) {
    logCrash('updater require failed: ' + String(e));
    return;
  }
  updaterEngine = au;

  // feed di test locale (senza push sulla repo): es. MF_UPDATE_FEED=http://localhost:8080
  if (process.env.MF_UPDATE_FEED) {
    try {
      au.setFeedURL({ provider: 'generic', url: process.env.MF_UPDATE_FEED });
    } catch (e) {
      logCrash('updater setFeedURL failed: ' + String(e));
    }
  }

  au.autoDownload = false; // il consenso arriva dal renderer
  au.autoInstallOnAppQuit = false; // si installa solo con "Riavvia ora"
  au.logger = {
    info: () => {},
    warn: () => {},
    error: (m) => logCrash('updater: ' + String(m && m.stack || m)),
  };

  au.on('checking-for-update', () => sendUpdateEvent({ type: 'checking' }));
  au.on('update-available', (info) => {
    sendUpdateEvent({
      type: 'available',
      version: info && info.version,
      releaseNotes: extractReleaseNotes(info),
      releaseDate: info && info.releaseDate,
    });
  });
  au.on('update-not-available', (info) => {
    sendUpdateEvent({ type: 'not-available', version: info && info.version });
  });
  au.on('download-progress', (p) => {
    sendUpdateEvent({
      type: 'progress',
      percent: Math.round((p.percent || 0) * 10) / 10,
      transferred: p.transferred || 0,
      total: p.total || 0,
      bytesPerSecond: p.bytesPerSecond || 0,
    });
  });
  au.on('update-downloaded', (info) => {
    updateDownloaded = true;
    sendUpdateEvent({ type: 'downloaded', version: info && info.version });
  });
  au.on('error', (err) => {
    logCrash('updater error: ' + (err && err.stack || err));
    // gli errori del check automatico all'avvio restano silenziosi; se però
    // l'utente ha avviato lui download/installazione, l'errore deve arrivare
    const phase = updatePhase;
    const userInitiated = phase === 'download' || phase === 'install';
    sendUpdateEvent({
      type: 'error',
      message: String((err && err.message) || err),
      phase,
      silent: autoCheckPending && !userInitiated,
    });
    updatePhase = 'idle';
  });

  ipcMain.handle('update:action', async (_e, action) => {
    try {
      switch (action) {
        case 'check':
          updatePhase = 'check';
          await au.checkForUpdates();
          updatePhase = 'idle';
          return true;
        case 'download':
          if (!updateDownloaded) {
            updatePhase = 'download';
            await au.downloadUpdate();
            updatePhase = 'idle';
          }
          return true;
        case 'install':
          if (updateDownloaded) {
            updatePhase = 'install';
            // piccola pausa così il renderer mostra lo stato prima della chiusura
            setTimeout(() => {
              try {
                au.quitAndInstall(false, true);
              } catch (e) {
                logCrash('updater quitAndInstall failed: ' + String(e));
              }
            }, 250);
          }
          return true;
        case 'later':
          // "più tardi" NON annulla il download già fatto: l'aggiornamento
          // resta pronto e installabile dal menu dell'app
          return true;
        default:
          return false;
      }
    } catch (e) {
      logCrash('updater action ' + action + ' failed: ' + String(e && e.stack || e));
      sendUpdateEvent({ type: 'error', message: String((e && e.message) || e), phase: updatePhase });
      updatePhase = 'idle';
      return false;
    }
  });

  // controllo automatico all'avvio (con un piccolo ritardo per non rallentare lo startup)
  setTimeout(() => {
    if (updaterEngine !== au) return;
    autoCheckPending = true;
    au.checkForUpdates()
      .catch(() => { /* gli errori arrivano già come evento */ })
      .finally(() => { autoCheckPending = false; });
  }, 5000);
}

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

// ---------------------------------------------------------------- MIDI nativo
// Il renderer parla al MIDI attraverso questi canali; se il modulo nativo non è
// disponibile risponde ok:false e il renderer ripiega su Web MIDI.
ipcMain.handle('midi:status', () => midiBackend.status());
ipcMain.handle('midi:list', () => midiBackend.list());
ipcMain.handle('midi:open', (_e, inputId, outputId) => midiBackend.open(inputId, outputId));
ipcMain.handle('midi:close', () => midiBackend.close());
ipcMain.handle('midi:send', (_e, bytes) => midiBackend.send(bytes));
ipcMain.handle('midi:shutdown', () => midiBackend.shutdown());

app.whenReady().then(() => {
  // Web MIDI: nelle app impacchettate le richieste di accesso ai dispositivi
  // MIDI vengono negate senza un handler esplicito (i selettori restano vuoti).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'midi' || permission === 'midiSysex');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'midi' || permission === 'midiSysex';
  });
  initAutoUpdater();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  logCrash('main uncaughtException: ' + (err && err.stack || err));
});
process.on('unhandledRejection', (err) => {
  logCrash('main unhandledRejection: ' + (err && err.stack || err));
});
