// ManageFreak — logica interfaccia
'use strict';

const App = (() => {
  // ------------------------------------------------------------------ costanti

  // "Characteristics" usate da Arturia MCC per classificare le patch
  // (ordine dei bit del campo da 18 caratteri, dal bit meno significativo).
  const CHARACTERISTICS = Mfp.CHARACTERISTICS;

  // ------------------------------------------------------------------ stato
  const state = {
    device: null, // array di 512 header dopo lo scan
    devicePhase: 'empty', // empty | scanning | ready | reading
    selectedDeviceSlots: new Set(), // multi-selezione sul dispositivo
    devSelAnchor: null,
    selLib: new Set(), // id dei preset selezionati in libreria
    selAnchor: null, // ancora per la selezione con Shift
    filterCategory: 'all', // 'all' | 'fav' | 'cat:N'
    filterCollection: 'all', // 'all' | N (id collezione) | 'none'
    filterTag: null,
    filterCharacteristic: null,
    sortMode: 'default', // 'default' | 'name' | 'rating' | 'category'
    libView: 'grid', // 'grid' | 'list'
    search: '',
    deviceSearch: '',
    activePane: 'library', // 'library' | 'device' — per la navigazione con frecce
    activeTab: 'presets', // 'presets' | 'wavetables' | 'samples' | 'device'
    firmware: null,
    wavetables: null,      // header dei 16 slot wavetable
    samples: null,         // header dei 128 slot sample
    sampleStats: null,     // {usedMs, freeMs, capacityMs, ...}
    deviceGlobals: null,   // {nomeGlobal: valore}
    wtLib: [],             // libreria PC wavetable: [{id, name, dataB64, collectionId, addedAt, source}]
    smLib: [],             // libreria PC sample: [{id, name, dataB64, sizeBytes, durationMs, collectionId, ...}]
    wtCols: [],            // cartelle della libreria wavetable: [{id, name}]
    smCols: [],            // cartelle della libreria sample: [{id, name}]
    wtFilter: 'all',       // 'all' | 'none' | id cartella
    smFilter: 'all',       // 'all' | 'none' | id cartella
    wtLibSel: null,        // id voce libreria PC wavetable selezionata
    smLibSel: null,        // id voce libreria PC sample selezionata
    wtData: {},            // cache corpi wavetable letti dal dispositivo: slot → {name, data}
    smData: {},            // cache corpi sample letti dal dispositivo: slot → {name, sizeBytes, checksum, data}
    wtLastRender: null,    // {data, name, slot} ultima wavetable renderizzata
    smLastRender: null,    // {slot, libId} ultimo sample mostrato nel dettaglio
    wtReadToken: 0,        // token anti-race per le letture wavetable
    sampleReadToken: 0,    // token anti-race per le letture sample
    wtSel: new Set(),      // multi-selezione sugli slot wavetable del dispositivo
    wtSelAnchor: null,
    smSel: new Set(),      // multi-selezione sugli slot sample del dispositivo
    smSelAnchor: null,
    busy: false,
    cancelRequested: false,
    dragEntryId: null,
  };

  // ------------------------------------------------------------------ DOM
  const $ = (id) => document.getElementById(id);
  const el = {
    midiInput: $('midi-input'),
    midiOutput: $('midi-output'),
    btnConnect: $('btn-connect'),
    btnRefreshPorts: $('btn-refresh-ports'),
    btnTheme: $('btn-theme'),
    connStatus: $('connection-status'),
    fwVersion: $('fw-version'),
    btnReadAll: $('btn-read-all'),
    btnCancel: $('btn-cancel'),
    btnDownloadBank: $('btn-download-bank'),
    btnUploadLibrary: $('btn-upload-library'),
    deviceCounts: $('device-counts'),
    deviceSearch: $('device-search'),
    catList: $('cat-list'),
    tagList: null,
    charList: $('char-list'),
    btnImport: $('btn-import'),
    btnBackup: $('btn-backup'),
    search: $('search'),
    libraryView: $('library-view'),
    slotList: $('slot-list'),
    libGrid: $('lib-grid'),
    libraryCount: $('library-count'),
    detailEmpty: $('detail-empty'),
    detail: $('detail'),
    detailName: $('detail-name'),
    detailMeta: $('detail-meta'),
    detailTags: $('detail-tags'),
    detailAddTag: $('detail-add-tag'),
    detailNotesBox: $('detail-notes-box'),
    detailNotes: $('detail-notes'),
    detailActions: $('detail-actions'),
    detailParams: $('detail-params'),
    statusText: $('status-text'),
    progressWrap: $('progress-wrap'),
    progressFill: $('progress-fill'),
    progressText: $('progress-text'),
    modalBackdrop: $('modal-backdrop'),
    modalTitle: $('modal-title'),
    modalBody: $('modal-body'),
    modalCancel: $('modal-cancel'),
    modalOk: $('modal-ok'),
    updateBackdrop: $('update-backdrop'),
    updateTitle: $('update-title'),
    updateBody: $('update-body'),
    updateChangelog: $('update-changelog'),
    updateProgress: $('update-progress'),
    updateProgressFill: $('update-progress-fill'),
    updateProgressText: $('update-progress-text'),
    updateLater: $('update-later'),
    updatePrimary: $('update-primary'),
    appBrand: $('app-brand'),
    appMenu: $('app-menu'),
    appMenuVersion: $('app-menu-version'),
    appMenuChangelog: $('app-menu-changelog'),
    btnCheckUpdates: $('btn-check-updates'),
    toast: $('toast'),
  };

  // ------------------------------------------------------------------ utilità

  let appVersion = ''; // versione dell'app (impostata in init)
  let canAutoUpdate = true; // false su macOS/Linux e sulla build portable

  // Indicatore di trascinamento: UNO solo, tracciato in una variabile. Prima si
  // ripulivano tutte le righe a ogni movimento del mouse (con 1000+ preset era
  // lentissimo e restavano barrette appese mostrandone due insieme).
  const DRAG_INDICATOR_CLASSES = ['drop-before', 'drop-after', 'drop-left', 'drop-right', 'swap-over'];
  let dragIndicatorEl = null;
  function clearDragIndicator() {
    if (!dragIndicatorEl) return;
    dragIndicatorEl.classList.remove(...DRAG_INDICATOR_CLASSES);
    dragIndicatorEl = null;
  }
  function setDragIndicator(el, cls) {
    if (!el) return clearDragIndicator();
    if (dragIndicatorEl === el && el.classList.contains(cls)) return; // già corretto
    clearDragIndicator();
    el.classList.add(cls);
    dragIndicatorEl = el;
  }

  /** Card della libreria sotto il puntatore (o la più vicina se il punto è nel
   *  gap), con l'indicazione se inserire prima o dopo. */
  function libDropTargetFromPoint(clientX, clientY) {
    const grid = el.libGrid;
    if (!grid) return null;
    const cards = Array.from(grid.querySelectorAll('.lib-card, .lib-row'));
    if (!cards.length) return null;
    let target = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    });
    if (!target) {
      let best = null; let bestD = Infinity;
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        const dx = Math.max(r.left - clientX, 0, clientX - r.right);
        const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = c; }
      }
      target = best;
    }
    if (!target) return null;
    const r = target.getBoundingClientRect();
    const listView = grid.classList.contains('lib-list-view');
    const after = listView ? clientY >= r.top + r.height / 2 : clientX >= r.left + r.width / 2;
    return { id: parseInt(target.dataset.id, 10), after };
  }

  /** Mostra la barretta di inserimento nella libreria (riordino interno e
   *  import dal device), con la stessa normalizzazione: una posizione sola. */
  function showLibInsertIndicator(clientX, clientY) {
    const grid = el.libGrid;
    const t = libDropTargetFromPoint(clientX, clientY);
    if (!grid || !t) return clearDragIndicator();
    const node = grid.querySelector(`[data-id="${t.id}"]`);
    if (!node) return clearDragIndicator();
    const listView = grid.classList.contains('lib-list-view');
    const next = node.nextElementSibling;
    const nextOk = next && next.classList.contains(listView ? 'lib-row' : 'lib-card');
    if (listView) {
      if (!t.after) setDragIndicator(node, 'drop-before');
      else if (nextOk) setDragIndicator(next, 'drop-before');
      else setDragIndicator(node, 'drop-after');
      return;
    }
    if (!t.after) setDragIndicator(node, 'drop-left');
    else if (nextOk) setDragIndicator(next, 'drop-left');
    else setDragIndicator(node, 'drop-right');
  }
  let manualCheckPending = false; // true dopo un click esplicito su "Check for updates"
  let updateReadyVersion = null; // versione scaricata e pronta da installare

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  let toastTimer = null;
  function toast(msg, kind = '', ms = 3200) {
    el.toast.textContent = msg;
    el.toast.className = kind;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
  }

  // errori globali: li mostriamo come toast invece di lasciare l'app muta
  window.addEventListener('error', (e) => {
    try { toast('Unexpected error: ' + (e.message || 'unknown'), 'err', 8000); } catch { /* ignora */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const msg = r && (r.message || String(r)) || 'unknown';
    try { toast('Unexpected error: ' + msg, 'err', 8000); } catch { /* ignora */ }
  });

  function status(msg) {
    el.statusText.textContent = msg;
  }

  function setProgress(frac, text) {
    if (frac === null) {
      el.progressWrap.classList.add('hidden');
      return;
    }
    el.progressWrap.classList.remove('hidden');
    el.progressFill.style.width = `${Math.round(frac * 100)}%`;
    el.progressText.textContent = text || '';
  }

  function setBusy(busy, label) {
    state.busy = busy;
    el.btnReadAll.disabled = busy;
    el.btnImport.disabled = busy;
    el.btnUploadLibrary.disabled = busy;
    el.btnDownloadBank.disabled = busy;
    if (!busy) {
      el.btnCancel.classList.add('hidden');
      status('Ready.');
    } else {
      status(label || 'Working…');
    }
  }

  function catName(idx) {
    return MF.CATEGORIES[idx] || '';
  }

  // ------------------------------------------------------------------ tema

  function applyTheme(theme) {
    const light = theme === 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    el.btnTheme.textContent = light ? '☀️' : '🌙';
    el.btnTheme.title = light ? 'Switch to dark theme' : 'Switch to light theme';
    try { localStorage.setItem('managefreak-theme', light ? 'light' : 'dark'); } catch { /* ignora */ }
  }

  function catColor(idx) {
    const colors = ['#e05d5d', '#e8a25a', '#e8c25a', '#8ec96b', '#43c47c', '#43c4a9',
      '#5ab3e8', '#6d7bd6', '#a07bd6', '#d67bc4', '#9a9aab', '#e86b6b'];
    return colors[idx % colors.length] || '#9a9aab';
  }

  // ------------------------------------------------------------------ modal

  function showModal(title, bodyHTML, { okLabel = 'OK', onOk = null, hideCancel = false } = {}) {
    return new Promise((resolve) => {
      el.modalTitle.textContent = title;
      el.modalBody.innerHTML = bodyHTML;
      el.modalOk.textContent = okLabel;
      el.modalOk.classList.toggle('hidden', hideCancel);
      el.modalCancel.classList.toggle('hidden', hideCancel);
      el.modalBackdrop.classList.remove('hidden');

      const close = (result) => {
        el.modalBackdrop.classList.add('hidden');
        el.modalOk.onclick = null;
        el.modalCancel.onclick = null;
        resolve(result);
      };

      el.modalOk.onclick = () => {
        let ok = true;
        if (onOk) {
          try {
            const r = onOk();
            if (r === false) ok = false;
          } catch (e) {
            toast(String(e.message || e), 'err');
            ok = false;
          }
        }
        if (ok) close(true);
      };
      el.modalCancel.onclick = () => close(false);
      el.modalBackdrop.onclick = (e) => {
        if (e.target === el.modalBackdrop) close(false);
      };
    });
  }

  // ------------------------------------------------------------------ MIDI / porte

  /** Popola i selettori MIDI con il solo segnaposto (mai vuoti). */
  function fillEmptySelects() {
    const fill = (select, emptyLabel) => {
      select.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = emptyLabel;
      select.appendChild(opt);
    };
    fill(el.midiInput, '— MIDI input —');
    fill(el.midiOutput, '— MIDI output —');
  }

  // ------------------------------------------------------- sorveglianza porte MIDI
  // Su Windows l'elenco delle porte Web MIDI può arrivare in ritardo (il backend
  // WinRT enumera in modo asincrono) o restare vuoto per qualche secondo dopo un
  // replug o un riavvio dell'app. Senza un secondo tentativo i menu restavano
  // vuoti per sempre e sembrava che l'app avesse "perso" il MicroFreak.
  const PORTS_RETRY_FAST_MS = 3000;
  const PORTS_RETRY_FAST_TRIES = 20; // ~1 minuto di tentativi ravvicinati
  const PORTS_RETRY_SLOW_MS = 20000; // poi un controllo ogni 20 s, a costo zero
  let portsWatchTimer = null;
  let portsWatchTries = 0;
  let lastAutoConnectAt = 0;
  let portsWereEmpty = true;

  function stopPortWatch() {
    if (portsWatchTimer) clearTimeout(portsWatchTimer);
    portsWatchTimer = null;
    portsWatchTries = 0;
  }

  function schedulePortWatch() {
    if (portsWatchTimer) return;
    const fast = portsWatchTries < PORTS_RETRY_FAST_TRIES;
    const delay = fast ? PORTS_RETRY_FAST_MS : PORTS_RETRY_SLOW_MS;
    portsWatchTimer = setTimeout(() => {
      portsWatchTimer = null;
      portsWatchTries++;
      // nei tentativi ravvicinati si ricrea l'accesso MIDI (è quello che fa
      // ripartire l'enumerazione); nel controllo lento basta rileggere la mappa,
      // che Chromium aggiorna da sé: così non si accumulano oggetti MIDIAccess
      refreshPorts({ quiet: true, rerequest: fast });
    }, delay);
  }

  async function refreshPorts({ quiet = false, rerequest = true } = {}) {
    if (!Midi.supported()) {
      if (!quiet) toast('Web MIDI is not available in this environment.', 'err', 6000);
      fillEmptySelects();
      return;
    }
    if (rerequest) {
      try {
        await Midi.refresh();
      } catch (e) {
        if (!quiet) toast('MIDI access denied: ' + (e.message || e), 'err', 6000);
        fillEmptySelects();
        schedulePortWatch();
        return;
      }
    }
    const inputs = Midi.inputs();
    const outputs = Midi.outputs();

    const fill = (select, ports, emptyLabel) => {
      const prev = select.value;
      // gli id delle porte Web MIDI cambiano quando cambia l'insieme dei
      // dispositivi: se l'id non c'è più si ritrova la porta per NOME
      const prevName = (select.selectedOptions[0] || {}).textContent || '';
      select.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = emptyLabel;
      select.appendChild(opt);
      for (const p of ports) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        if (p.manufacturer) o.textContent += ` (${p.manufacturer})`;
        select.appendChild(o);
      }
      if (prev && Array.from(select.options).some((o) => o.value === prev)) select.value = prev;
      else if (prevName) {
        const byName = Array.from(select.options).find((o) => o.textContent === prevName);
        if (byName) select.value = byName.value;
      }
      // niente default "prima porta": l'ordine delle porte MIDI cambia e la
      // prima disponibile può essere una porta virtuale. Si sceglie dopo.
    };

    fill(el.midiInput, inputs, '— MIDI input —');
    fill(el.midiOutput, outputs, '— MIDI output —');

    // auto-selezione del MicroFreak se presente
    const autoPick = (select, keyword) => {
      if (select.value) return;
      const o = Array.from(select.options).find((x) => x.textContent.toLowerCase().includes(keyword));
      if (o) select.value = o.value;
    };
    autoPick(el.midiInput, 'microfreak');
    autoPick(el.midiOutput, 'microfreak');
    // NIENTE ripiego sulla "prima porta": se il MicroFreak non c'è, l'app
    // finiva per collegarsi a una porta generica (SG Device I/O, StudioRack…)
    // dando l'impressione di funzionare mentre il synth non riceveva nulla.
    // Se manca, i menu restano vuoti e l'app continua a cercarlo.
    const hasMicrofreak = inputs.some((p) => (p.name || '').toLowerCase().includes('microfreak'));
    if (!inputs.length && !outputs.length) {
      // nessuna porta: continua a provare in sottofondo invece di arrendersi
      schedulePortWatch();
      return;
    }
    if (!hasMicrofreak) {
      const n = inputs.length + outputs.length;
      if (!quiet) {
        toast(`MicroFreak not found among the ${n} MIDI ports available. Unplug and replug its USB cable, or press "Refresh ports": ManageFreak keeps looking.`, 'err', 12000);
        status(`MicroFreak not found (${n} other MIDI ports). Replug the USB cable — still searching…`);
      }
      schedulePortWatch();
      return;
    }
    stopPortWatch();
    if (portsWereEmpty) {
      portsWereEmpty = false;
      status(`MIDI ports found: ${inputs.length} input, ${outputs.length} output.`);
    }
    // se compare un MicroFreak e non siamo connessi, connetti: vale anche per le
    // porte che si materializzano in ritardo, grazie al sorvegliante qui sopra
    const inName = (el.midiInput.selectedOptions[0]?.textContent || '').toLowerCase();
    const outName = (el.midiOutput.selectedOptions[0]?.textContent || '').toLowerCase();
    if (!Midi.isOpen() && inName.includes('microfreak') && outName.includes('microfreak')
        && Date.now() - lastAutoConnectAt > 30000) {
      lastAutoConnectAt = Date.now();
      setTimeout(connect, 300);
    }
  }

  /** Sincronizza dal MicroFreak: firmware, 512 preset, 16 wavetable, 128 sample. */
  let syncingNow = false; // evita due sincronizzazioni in parallelo sul device

  async function syncAllFromDevice() {
    // Due sync contemporanee si intrecciano sullo stesso stream SysEx: le
    // letture si incrociano (dati di un altro slot), la scansione non finisce
    // mai e le porte vengono chiuse a metà operazione. Una alla volta.
    if (syncingNow) return;
    syncingNow = true;
    try {
      await detectFirmware();
      await scanDevice();
      await readWavetableInventory();
      await readSampleInventory();
    } finally {
      syncingNow = false;
    }
  }

  async function connect() {
    const inId = el.midiInput.value;
    const outId = el.midiOutput.value;
    if (!inId || !outId) {
      toast('Select both a MIDI input and output.', 'err');
      return;
    }
    // già connessi alle stesse porte: NON riaprire. Midi.open() chiude prima le
    // porte, e quella chiusura interrompeva le operazioni in corso (era la causa
    // degli errori "MIDI ports not open" a metà scansione).
    if (Midi.isOpen() && typeof Midi.currentIds === 'function') {
      const cur = Midi.currentIds();
      if (cur.input === inId && cur.output === outId) {
        toast('Already connected — resynchronizing…', 'ok');
        status('Synchronizing…');
        syncAllFromDevice().catch((e) => toast('Sync failed: ' + (e && e.message || e), 'err', 6000));
        return;
      }
    }
    try {
      await Midi.open(inId, outId);
      el.connStatus.className = 'status-dot online';
      el.connStatus.title = `Connected: ${Midi.currentNames().output}`;
      status('Connected to the MicroFreak. Synchronizing…');
      // firmware + scansione automatica di preset, wavetable e sample
      setTimeout(() => {
        syncAllFromDevice().catch((e) => toast('Sync failed: ' + (e && e.message || e), 'err', 6000));
      }, 250);
    } catch (e) {
      el.connStatus.className = 'status-dot error';
      toast('Connection failed: ' + (e.message || e), 'err', 6000);
    }
  }

  /** Legge la versione firmware dall'identity reply e la mostra nel titolo. */
  async function detectFirmware() {
    try {
      const fw = await Midi.identity(1500);
      if (fw) {
        state.firmware = fw;
        el.fwVersion.textContent = `FW ${fw}`;
        el.fwVersion.classList.remove('hidden');
      }
    } catch {
      /* firmware non disponibile */
    }
  }

  /** Scarica l'intera bank del MicroFreak in un file .mfprojz datato. */
  async function downloadBankToPC() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.device) return toast('Scan the MicroFreak library first.', 'err');
    const occupied = state.device.filter((h) => h && !h.empty && !h.error);
    if (!occupied.length) return toast('No occupied presets to download.', 'err');
    const est = Math.max(1, Math.round((occupied.length * 0.55) / 60)); // minuti circa
    const yes = await showModal(
      `Download the bank (${occupied.length} presets) to PC?`,
      `<p>All occupied presets will be read (about ${est} minutes, cancellable) and saved
       into a single <strong>.mfprojz</strong> file compatible with Arturia MIDI Control Center,
       named <code>MicroFreak-Bank-date-time.mfprojz</code>.</p>`,
      { okLabel: 'Download bank' }
    );
    if (!yes) return;

    setBusy(true, 'Scaricamento della bank…');
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    const presets = [];
    try {
      for (let i = 0; i < occupied.length; i++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const h = occupied[i];
        const preset = await MF.readPreset(h.slot, { timeoutMs: 4000 });
        if (preset.data) presets.push({ slot: h.slot, name: preset.name, category: preset.category, p1: preset.p1, data: preset.data });
        setProgress((i + 1) / occupied.length, `Reading slot ${h.slot}…`);
      }
    } catch (e) {
      toast('Download interrupted: ' + (e.message || e), 'err', 6000);
      return;
    } finally {
      setBusy(false);
      setProgress(null);
    }
    if (!presets.length) return toast('No presets read.', 'err');

    try {
      setBusy(true, 'Creating .mfprojz file…');
      const bytes = await Mfp.serializeMfprojz(presets);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const path = await window.mfapi.saveFile({
        defaultName: `MicroFreak-Bank-${stamp}.mfprojz`,
        data: Mfp.bytesToB64(bytes),
        filters: [{ name: 'MicroFreak project (MCC)', extensions: ['mfprojz'] }],
      });
      if (path) toast(`Bank saved to ${path} (${presets.length} presets) ✓`, 'ok', 6000);
    } catch (e) {
      toast('File creation failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  /** Carica l'intera libreria PC sul MicroFreak (slot 1..N), con conferma. */
  async function uploadLibraryToDevice() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    const entries = Library.all().filter((e) => e.dataB64 && !isInitNamed(e));
    if (!entries.length) return toast('The library is empty.', 'err');
    const n = Math.min(entries.length, 512);
    const est = Math.max(1, Math.round((n * 1.1) / 60));
    const yes = await showModal(
      `Upload ${n} library presets to the MicroFreak?`,
      `<p>The first <strong>${n}</strong> library presets will be written to the first <strong>${n}</strong> slots
       (1–${n}), overwriting the current content. Each slot is read as a backup and restored on error.</p>
       <p class="muted" style="font-size:12px">Estimated time: about ${est} minutes. You can cancel at any time.</p>`,
      { okLabel: 'Upload to MicroFreak' }
    );
    if (!yes) return;

    setBusy(true, 'Uploading library…');
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    let done = 0;
    let failed = 0;
    try {
      for (let i = 0; i < n; i++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const entry = Library.get(entries[i].id);
        if (!entry || !entry.data) { failed++; done++; continue; }
        const slot = i + 1;
        let backup = null;
        try {
          const cur = await MF.readHeader(slot, 4000);
          if (!cur.empty) backup = await MF.readPreset(slot, { timeoutMs: 4000 });
          await MF.writePreset(slot, {
            name: entry.name,
            category: typeof entry.category === 'number' && entry.category >= 0 ? entry.category : 0,
            p1: entry.p1 || 0,
            data: entry.data,
          }, { timeoutMs: 4000 });
          const h = await MF.readHeader(slot, 4000);
          if (h.empty || h.name !== entry.name) throw new Error('header verification failed');
          // la cache degli header esiste solo dopo uno scan riuscito: se l'utente
          // lancia l'upload appena connesso va aggiornata solo se c'è, altrimenti
          // un TypeError interromperebbe il caricamento a metà
          if (state.device) {
            state.device[slot - 1] = {
              slot, name: entry.name,
              category: typeof entry.category === 'number' && entry.category >= 0 ? entry.category : 0,
              p1: entry.p1 || 0, empty: false,
            };
          }
        } catch (e) {
          failed++;
          if (backup && backup.data) {
            try {
              await MF.writePreset(slot, { name: backup.name, category: backup.category, p1: backup.p1, data: backup.data }, { timeoutMs: 4000 });
            } catch { /* ripristino non riuscito */ }
          }
        }
        done++;
        setProgress(done / n, `Slot ${slot}/${n}…`);
      }
      renderDevice();
      toast(`Uploaded ${n - failed} presets to the MicroFreak${failed ? `, ${failed} errors` : ''} ✓`, 'ok', 6000);
    } catch (e) {
      toast('Upload interrupted: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // ------------------------------------------------------------------ scansione dispositivo

  async function scanDevice() {
    if (!Midi.isOpen()) {
      toast('Connect the MIDI ports first.', 'err');
      return;
    }
    setBusy(true, 'Scanning 512 presets…');
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    state.devicePhase = 'scanning';
    state.device = new Array(512).fill(null);
    try {
      const headers = await MF.scanHeaders({
        onProgress: (done, total) => {
          setProgress(done / total, `${done}/${total}`);
          if (state.cancelRequested) throw new Error('Operation cancelled');
        },
        onError: (slot, e) => { /* kept as an error in the row */ },
      });
      state.device = headers;
      state.devicePhase = 'ready';
      status('Scan complete.');
      renderDevice();
    } catch (e) {
      state.devicePhase = 'ready';
      status(String(e.message || e));
      renderDevice();
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function targetCollectionId() {
    if (state.filterCollection !== 'all' && state.filterCollection !== 'none') {
      return parseInt(state.filterCollection, 10);
    }
    return null;
  }

  async function readAllOccupied() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.device) return toast('Scan the preset names first.', 'err');
    const occupied = state.device.filter((h) => h && !h.empty && !h.error);
    if (!occupied.length) return toast('No occupied presets found.', 'err');

    const est = Math.max(1, Math.round((occupied.length * 0.55) / 60)); // minuti circa
    const collections = Library.allCollections();
    const collOpts = collections.map((c) =>
      `<option value="${c.id}" ${String(targetCollectionId()) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const yes = await showModal(
      `Read ${occupied.length} presets from the device?`,
      `<p>This transfers the full preset bodies into the local library
       and takes about ${est} minutes. You can cancel at any time. Init presets are skipped.</p>
       <label><input type="checkbox" id="opt-skip-existing" checked /> Skip presets already in the library</label>
       <div class="field"><label>Destination library</label>
         <select id="m-coll">
           <option value="">— No library (general collection) —</option>
           ${collOpts}
         </select></div>`,
      { okLabel: 'Start reading' }
    );
    if (!yes) return;

    const skipExisting = $('opt-skip-existing') && $('opt-skip-existing').checked;
    const collectionId = $('m-coll').value ? parseInt($('m-coll').value, 10) : null;
    const existingNames = new Set(Library.all().map((e) => `${e.sourceSlot}|${e.name}`));
    const todo = occupied.filter((h) => {
      if (isInitNamed(h)) return false; // gli Init non entrano in libreria
      return !skipExisting || !existingNames.has(`${h.slot}|${h.name}`);
    });
    if (!todo.length) return toast('All occupied presets are already in the library (or are Init).', 'ok');

    setBusy(true, `Reading presets from the device…`);
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    let added = 0;
    let errors = 0;
    try {
      await MF.readMany(todo.map((h) => h.slot), {
        shouldCancel: () => state.cancelRequested,
        onProgress: ({ slot, slotIndex, slotCount, part, parts, error }) => {
          if (error) {
            errors++;
            return;
          }
          const frac = (slotIndex + (part > 0 ? part / parts : 0)) / slotCount;
          setProgress(frac, `Slot ${slot} — part ${part}/${parts}`);
        },
        onSlot: (preset) => {
          if (isInitNamed(preset)) return;
          Library.add(preset, { sourceName: `Device slot ${preset.slot}`, collectionId });
          added++;
        },
      });
      status(`Reading complete: ${added} presets added, ${errors} errors.`);
      toast(`Added ${added} presets to the library.`, 'ok');
      renderDevice();
    } catch (e) {
      status(String(e.message || e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // ------------------------------------------------------------------ scrittura con guardia

  async function writeToSlot(slot, entry, { selectAfter = true } = {}) {
    if (!Midi.isOpen()) {
      toast('Connect the MIDI ports first.', 'err');
      return false;
    }
    if (!entry.data || entry.data.length !== MF.DATALEN) {
      toast('The preset has no valid body.', 'err');
      return false;
    }
    setBusy(true, `Writing preset to slot ${slot}…`);
    let backup = null;
    let backupSlot = null;
    try {
      // backup del contenuto attuale
      const current = await MF.readHeader(slot);
      if (!current.empty) {
        backup = await MF.readPreset(slot);
        backupSlot = slot;
      }

      await MF.writePreset(slot, {
        name: entry.name,
        category: entry.category >= 0 ? entry.category : 0,
        p1: entry.p1 !== undefined ? entry.p1 : 0,
        rawHeader: entry.rawHeader,
        data: entry.data,
      });

      // verifica readback
      const rb = await MF.readPreset(slot);
      let ok = rb.data && rb.data.length === MF.DATALEN;
      if (ok) {
        for (let i = 0; i < rb.data.length; i++) {
          if (rb.data[i] !== entry.data[i]) { ok = false; break; }
        }
      }
      if (!ok) throw new Error('The readback does not match the written preset.');

      // aggiorna la scansione in memoria
      if (state.device && state.device[slot - 1]) {
        state.device[slot - 1] = rb;
        renderDevice();
      }
      if (selectAfter) MF.selectPreset(slot);
      toast(`"${entry.name}" written to slot ${slot} ✓`, 'ok');
      return true;
    } catch (e) {
      toast('Write failed: ' + (e.message || e), 'err', 6000);
      if (backup && backup.data) {
        status('Restoring original content…');
        try {
          await MF.writePreset(slot, {
            name: backup.name,
            category: backup.category,
            p1: backup.p1,
            rawHeader: backup.rawHeader,
            data: backup.data,
          });
          toast('Original content restored ✓', 'ok');
        } catch (e2) {
          toast('WARNING: even the restore failed! (' + (e2.message || e2) + ')', 'err', 8000);
        }
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function writeToSlotWithDialog(entry) {
    const ok = await showModal(
      `Write "${entry.name}" to the device`,
      `<p>Which slot should the preset be written to? (1–512)</p>
       <input id="m-slot" type="number" min="1" max="512" value="1" />
       <p class="muted" style="font-size:12px">The current slot content is read as a backup
       and restored automatically if verification fails.</p>
       <label><input type="checkbox" id="m-select" checked /> Select the preset on the synth after writing</label>`,
      {
        okLabel: 'Send to MicroFreak',
        onOk: () => {
          const slot = parseInt($('m-slot').value, 10);
          if (!slot || slot < 1 || slot > 512) {
            toast('Invalid slot (1–512).', 'err');
            return false;
          }
          $('m-slot').dataset.slot = String(slot);
        },
      }
    );
    if (!ok) return false;
    const slot = parseInt($('m-slot').dataset.slot, 10);
    const selectAfter = $('m-select').checked;
    return writeToSlot(slot, entry, { selectAfter });
  }

  // ------------------------------------------------------------------ rendering dispositivo

  function renderDevice() {
    const list = el.slotList;
    if (!state.device) {
      list.innerHTML = `<div class="hint" style="padding:8px">Connect the MicroFreak and pick the ports at the top: preset scanning starts automatically.</div>`;
      el.deviceCounts.textContent = '';
      return;
    }
    const q = state.deviceSearch.trim().toLowerCase();
    const isInit = (h) => h && !h.empty && !h.error && (h.name || '').trim() === 'Init';
    const occupied = state.device.filter((h) => h && !h.empty && !h.error && !isInit(h));
    const free = state.device.filter((h) => h && !h.error && (h.empty || isInit(h)));
    el.deviceCounts.textContent = `${occupied.length} used · ${free.length} free`;

    let html = '';
    for (const h of state.device) {
      const slot = h ? h.slot : 0;
      const statusTxt = !h ? 'unread' : h.error ? 'error' : h.empty ? 'empty' : '';
      const empty = !h || !!h.error || !!h.empty;
      const isInit = h && !h.error && !h.empty && (h.name || '').trim() === 'Init';
      const name = h && !h.error ? (h.name || '') : '';
      if (q && !name.toLowerCase().includes(q) && !statusTxt.includes(q)) continue;
      const cat = h && !h.error && !h.empty ? h.category : -1;
      const rowClass = [
        'slot-row',
        empty ? 'empty-row' : '',
        isInit ? 'init-row' : '',
        h && h.error ? 'err-row' : '',
        state.selectedDeviceSlots.has(slot) ? 'selected' : '',
      ].join(' ');
      const catChip = cat >= 0
        ? `<span class="slot-cat-name" style="color:${catColor(cat)};border:1px solid ${catColor(cat)}55">${esc(catName(cat))}</span>`
        : '';
      html += `
        <div class="${rowClass}" data-slot="${slot}" draggable="${empty ? 'false' : 'true'}" title="${esc(name)}">
          <span class="slot-num">${slot}</span>
          <span class="slot-name">${esc(statusTxt || name)}</span>
          ${catChip}
        </div>`;
    }
    list.innerHTML = html;

    list.querySelectorAll('.slot-row').forEach((row) => {
      const slot = parseInt(row.dataset.slot, 10);
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        handleDeviceSelect(e, slot);
      });
      // drag da dispositivo → libreria PC o verso un altro slot (scambio/shift)
      row.addEventListener('dragstart', (e) => {
        // il preset afferrato diventa quello attivo (se non era selezionato)
        if (!state.selectedDeviceSlots.has(slot)) {
          state.selectedDeviceSlots = new Set([slot]);
          state.devSelAnchor = slot;
          syncDeviceSelectionVisuals();
          renderDeviceSelBar();
        }
        state.dragDeviceBlock = state.selectedDeviceSlots.has(slot) && state.selectedDeviceSlots.size > 1
          ? deviceSelIds().filter((s) => {
              const h = state.device && state.device[s - 1];
              return h && !h.empty && !h.error;
            })
          : null;
        e.dataTransfer.setData('application/x-managefreak-slot', String(slot));
        e.dataTransfer.setData('text/plain', String(slot));
        e.dataTransfer.effectAllowed = 'copyMove';
        startDragScroll('device');
      });
      row.addEventListener('dragend', () => {
        state.dragDeviceBlock = null;
        stopDragScroll();
      });
    });
    renderDeviceSelBar();
  }

  // ------------------------------------------------------------------ multi-selezione dispositivo

  function handleDeviceSelect(e, slot) {
    state.activePane = 'device';
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    if (ctrl) {
      if (state.selectedDeviceSlots.has(slot)) state.selectedDeviceSlots.delete(slot);
      else {
        state.selectedDeviceSlots.add(slot);
        state.devSelAnchor = slot;
      }
    } else if (shift) {
      const anchor = state.devSelAnchor !== null && state.selectedDeviceSlots.has(state.devSelAnchor) ? state.devSelAnchor : slot;
      const [a, b] = anchor < slot ? [anchor, slot] : [slot, anchor];
      state.selectedDeviceSlots.clear();
      for (let s = a; s <= b; s++) state.selectedDeviceSlots.add(s);
    } else {
      if (state.selectedDeviceSlots.has(slot)) {
        // click su uno slot già selezionato → deseleziona
        state.selectedDeviceSlots.clear();
        state.devSelAnchor = null;
      } else {
        state.selectedDeviceSlots.clear();
        state.selectedDeviceSlots.add(slot);
        state.devSelAnchor = slot;
      }
    }
    updateDeviceSelectionUI();
  }

  function clearDeviceSelection() {
    state.selectedDeviceSlots.clear();
    state.devSelAnchor = null;
    updateDeviceSelectionUI();
  }

  function deviceSelIds() {
    return Array.from(state.selectedDeviceSlots).sort((a, b) => a - b);
  }

  function updateDeviceSelectionUI() {
    renderDevice();
    syncDeviceDetailToSelection();
  }

  function syncDeviceDetailToSelection() {
    const ids = deviceSelIds();
    if (!ids.length) showDetailEmpty();
    else if (ids.length === 1) showDeviceDetail(ids[0]);
    else showMultiDeviceDetail(ids);
  }

  function renderDeviceSelBar() {
    const bar = document.getElementById('device-selbar');
    const count = document.getElementById('device-sel-count');
    if (!bar) return;
    const n = state.selectedDeviceSlots.size;
    bar.querySelectorAll('button').forEach((b) => {
      b.disabled = n === 0;
    });
    if (count) count.textContent = `${n} selected`;
  }

  function showMultiDeviceDetail(slots) {
    renderDetail({
      name: `${slots.length} slots selected`,
      metaRows: [['Slots', slots.join(', ')]],
      tags: [],
      tagInput: null,
      notes: null,
      actions: [
        { id: 'read', label: '⬅ Fetch library to PC', run: () => readDeviceSelectionToLibrary() },
        { id: 'volume', label: '🔊 Set volume…', run: () => setVolumeOnDeviceSelection() },
      ],
      params: [],
    });
  }

  async function readDeviceSelectionToLibrary() {
    const slots = deviceSelIds().filter((s) => {
      const h = state.device && state.device[s - 1];
      return h && !h.empty && !h.error && !isInitNamed(h);
    });
    if (!slots.length) return toast('No occupied (non-Init) slots among the selection.', 'err');
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Reading ${slots.length} slots…`);
    const collectionId = targetCollectionId();
    let added = 0;
    for (const s of slots) {
      try {
        const preset = await MF.readPreset(s);
        if (preset.data && !isInitNamed(preset)) {
          Library.add(preset, { sourceName: `Device slot ${s}`, collectionId });
          added++;
        }
      } catch { /* continue with the next one */ }
    }
    setBusy(false);
    toast(`Added ${added} presets to the library ✓`, 'ok');
  }

  /**
   * Cambia il volume delle patch selezionate SUL dispositivo (una o più slot,
   * es. dalla selezione multipla o dal dettaglio di una singola patch). Prima
   * legge i corpi (per il riepilogo con i volumi attuali), poi chiede il nuovo
   * volume in dB, poi scrive ogni patch modificata e verifica il readback.
   */
  async function setVolumeOnDeviceSelection(slotsArg) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.device) return toast('Scan the preset names first.', 'err');
    // anche i preset Init hanno un corpo (il template del firmware) e il loro
    // volume può essere modificato come quello degli altri
    const slots = (slotsArg || deviceSelIds()).filter((s) => {
      const h = state.device && state.device[s - 1];
      return h && !h.empty && !h.error;
    });
    if (!slots.length) return toast('No occupied presets among the selected slots.', 'err');

    // fase 1: legge i corpi per costruire il riepilogo (nome, categoria, volume)
    setBusy(true, `Reading ${slots.length} presets…`);
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    const read = [];
    let readErrors = 0;
    let cancelled = false;
    try {
      for (let i = 0; i < slots.length; i++) {
        if (state.cancelRequested) {
          cancelled = true;
          break;
        }
        const slot = slots[i];
        setProgress(i / slots.length, `Slot ${slot} — reading…`);
        try {
          const preset = await MF.readPreset(slot, { timeoutMs: 4000 });
          read.push({ slot, preset });
        } catch (e) {
          readErrors++;
          // il motivo va mostrato: prima veniva inghiottito senza traccia
          status(`Slot ${slot}: ${(e && e.message) || e}`);
        }
      }
    } finally {
      // qualunque strada prenda la funzione, la UI non deve restare occupata
      setProgress(null);
      setBusy(false);
      el.btnCancel.classList.add('hidden');
    }
    if (cancelled) return toast('Cancelled.', 'err');
    if (!read.length) {
      return toast(readErrors ? 'Could not read any of the selected presets.' : 'No presets could be read.', 'err');
    }

    // I preset Init contengono il template del firmware, che NON è nel formato
    // "taggato" (nessun campo con nome): per loro non esiste un campo Volume da
    // modificare. Va detto in modo esplicito, non saltato in silenzio.
    const isEditable = (data) => !!(data && Params.parseStructured(data).fields.length);

    const rows = read.map(({ slot, preset }) => {
      const curRaw = Params.getFieldValue(preset.data, Params.VOLUME_KEY);
      const cat = entryCategoryChip(preset);
      return {
        slot,
        preset,
        name: preset.name,
        category: cat.label,
        color: cat.color,
        volume: curRaw === null ? null : Params.volumeDbLabel(Params.volumeRawToDb(curRaw)),
        locked: curRaw === null && !isEditable(preset.data),
      };
    });

    const locked = rows.filter((r) => r.locked).length;
    if (locked === rows.length) {
      return toast(rows.length === 1
        ? 'This slot contains the firmware Init template: it has no named parameters, so its volume cannot be changed.'
        : `All ${rows.length} selected presets contain the firmware Init template: they have no named parameters, so their volume cannot be changed.`,
      'err', 8000);
    }

    const noteParts = [];
    if (readErrors) noteParts.push(`${readErrors} slot${readErrors === 1 ? '' : 's'} could not be read and was skipped.`);
    if (locked) {
      noteParts.push(`${locked} Init preset${locked === 1 ? '' : 's'} contain${locked === 1 ? 's' : ''} the firmware Init template, which has no named parameters: ${locked === 1 ? 'its' : 'their'} volume cannot be changed and ${locked === 1 ? 'it' : 'they'} will be left untouched.`);
    }

    const dbVal = await promptVolume(
      slots.length === 1 ? `Set volume — slot ${slots[0]}` : `Set volume — ${slots.length} slots`,
      {
        targetLabel: rows.length === 1
          ? 'this preset on the MicroFreak'
          : `${rows.length} preset${rows.length === 1 ? '' : 's'} on the MicroFreak`,
        rows,
        note: noteParts.length ? noteParts.join(' ') : null,
      }
    );
    if (dbVal === null) return;
    const raw = Params.volumeDbToRaw(dbVal);
    const targetLabel = Params.volumeDbLabel(dbVal);

    // fase 2: applica (riusa i corpi già letti) con verifica readback
    setBusy(true, `Setting volume to ${targetLabel} on ${rows.length} presets…`);
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    let done = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (let i = 0; i < rows.length; i++) {
        if (state.cancelRequested) {
          toast('Cancelled.', 'err');
          break;
        }
        const { slot, preset } = rows[i];
        const curRaw = Params.getFieldValue(preset.data, Params.VOLUME_KEY);
        if (curRaw === null) { skipped++; continue; }
        const curLabel = Params.volumeDbLabel(Params.volumeRawToDb(curRaw));
        const newData = Params.setFieldValue(preset.data, Params.VOLUME_KEY, raw);
        setProgress((i + 0.5) / rows.length, `Slot ${slot}: ${curLabel} → ${targetLabel}…`);
        try {
          await MF.writePreset(slot, {
            name: preset.name,
            category: preset.category,
            p1: preset.p1,
            data: newData,
          }, { timeoutMs: 4000 });
          // verifica readback
          const rb = await MF.readPreset(slot, { timeoutMs: 4000 });
          let okRb = !!(rb.data && rb.data.length === MF.DATALEN);
          if (okRb) {
            for (let b = 0; b < rb.data.length; b++) {
              if (rb.data[b] !== newData[b]) { okRb = false; break; }
            }
          }
          if (!okRb) throw new Error('readback does not match');
          if (state.device && state.device[slot - 1]) state.device[slot - 1] = rb;
          done++;
        } catch (e) {
          failed++;
          status(`Slot ${slot}: ${e.message || e}`);
        }
      }
      renderDevice();
      const skipNote = skipped ? ` (${skipped} skipped: Init template, no Volume field)` : '';
      const failNote = failed ? `, ${failed} failed` : '';
      toast(`Volume set to ${targetLabel} on ${done} preset${done === 1 ? '' : 's'} on the MicroFreak${skipNote}${failNote} ✓`, 'ok', 7000);
    } finally {
      setBusy(false);
      setProgress(null);
      el.btnCancel.classList.add('hidden');
    }
  }

  /** Moves one or more presets to another position, shifting the others,
   *  with confirmation, verification and automatic rollback. */
  async function moveDeviceSelectionTo(movedSlots, targetSlot, after) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.device) return;
    const moved = Array.from(new Set(movedSlots)).sort((a, b) => a - b);
    if (!moved.length || moved.includes(targetSlot)) return;

    const occupied = state.device
      .map((h, i) => (h && !h.empty && !h.error ? i + 1 : null))
      .filter((s) => s !== null);
    const validMoved = moved.filter((s) => occupied.includes(s));
    if (!validMoved.length) return toast('The selected slots do not contain presets.', 'err');

    // pianifica la nuova sequenza e le scritture necessarie
    const { writes } = Shift.planShift(occupied, moved, targetSlot, after);
    if (!writes.length) return;

    // nomi per la conferma
    const movedNames = validMoved.map((s) => {
      const h = state.device[s - 1];
      return h ? h.name || `slot ${s}` : `slot ${s}`;
    });
    const targetName = occupied.includes(targetSlot)
      ? (state.device[targetSlot - 1] && state.device[targetSlot - 1].name) || `slot ${targetSlot}`
      : `empty slot ${targetSlot}`;

    const yes = await showModal(
      `Move ${validMoved.length} presets?`,
      `<p><strong>${validMoved.length} presets</strong> will be moved:
         <strong>${esc(movedNames.join(', '))}</strong></p>
       <p>Position: <strong>${after ? 'after' : 'before'} "${esc(targetName)}"</strong>.</p>
       <p class="muted" style="font-size:12px">The other presets will be <strong>shifted accordingly</strong>
       (this is not a one-to-one swap). All involved presets are read as backups and restored on error.
       This may take a few minutes and can be cancelled.</p>`,
      { okLabel: 'Move & shift' }
    );
    if (!yes) return;

    setBusy(true, 'Reading the involved presets…');
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;

    try {
      // 1. backup of all sources
      const backup = new Map();
      for (let i = 0; i < writes.length; i++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const w = writes[i];
        const preset = await MF.readPreset(w.from, { timeoutMs: 4000 });
        if (!preset.data) throw new Error(`Slot ${w.from} does not contain a readable preset.`);
        backup.set(w.from, preset);
        setProgress(i / writes.length, `Backing up slot ${w.from}…`);
        await MF.sleep(10);
      }

      // 2. write the new positions
      for (let k = 0; k < writes.length; k++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const w = writes[k];
        const preset = backup.get(w.from);
        await MF.writePreset(w.to, {
          name: preset.name,
          category: preset.category,
          p1: preset.p1,
          data: preset.data,
        }, { timeoutMs: 4000 });
        setProgress((k + 1) / writes.length, `Writing slot ${w.to}…`);
        await MF.sleep(10);
      }
      setProgress(0.98, 'Verifying…');

      // 3. verification: header for all written positions (quick) + full
      //    body only for the actually moved block (at risk)
      for (const w of writes) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const expected = backup.get(w.from);
        const h = await MF.readHeader(w.to, 4000);
        if (h.empty || h.name !== expected.name) {
          throw new Error(`Verification of slot ${w.to} failed.`);
        }
      }
      for (const s of validMoved) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const expected = backup.get(s);
        const w = writes.find((x) => x.from === s);
        const rb = await MF.readPreset(w ? w.to : s, { timeoutMs: 4000 });
        if (!rb.data || !bytesEqual(rb.data, expected.data)) {
          throw new Error(`Body verification of slot ${w ? w.to : s} failed.`);
        }
      }

      // 4. aggiorna gli header in memoria (solo le posizioni cambiate)
      for (const w of writes) {
        const preset = backup.get(w.from);
        state.device[w.to - 1] = {
          slot: w.to,
          name: preset.name,
          category: preset.category,
          p1: preset.p1,
          empty: false,
        };
      }
      renderDevice();
      toast(`Moved ${validMoved.length} presets ✓`, 'ok');
    } catch (e) {
      toast('Move failed: ' + (e.message || e), 'err', 6000);
      // automatic rollback
      if (backup && backup.size) {
        status('Restoring the original presets…');
        try {
          for (const [from, preset] of backup) {
            await MF.writePreset(from, {
              name: preset.name,
              category: preset.category,
              p1: preset.p1,
              data: preset.data,
            }, { timeoutMs: 4000 });
          }
          toast('Original presets restored ✓', 'ok');
        } catch (e2) {
          toast('WARNING: even the restore failed! (' + (e2.message || e2) + ')', 'err', 8000);
        }
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** One-to-one swap between two occupied slots, with confirmation, verification and rollback. */
  async function swapDeviceSlots(a, b) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (a === b) return;
    setBusy(true, `Reading slots ${a} and ${b}…`);
    let pa = null;
    let pb = null;
    try {
      pa = await MF.readPreset(a, { timeoutMs: 4000 });
      pb = await MF.readPreset(b, { timeoutMs: 4000 });
      if (!pa.data || !pb.data) {
        toast('Swapping requires two occupied slots.', 'err', 6000);
        return;
      }
      const yes = await showModal(
        `Swap slots ${a} and ${b}?`,
        `<p><strong>"${esc(pa.name)}"</strong> (slot ${a}) ⇄ <strong>"${esc(pb.name)}"</strong> (slot ${b})</p>
         <p class="muted" style="font-size:12px">One-to-one swap: both presets are read as backups
         and restored on error.</p>`,
        { okLabel: 'Swap' }
      );
      if (!yes) return;

      await MF.writePreset(b, { name: pa.name, category: pa.category, p1: pa.p1, data: pa.data }, { timeoutMs: 4000 });
      await MF.writePreset(a, { name: pb.name, category: pb.category, p1: pb.p1, data: pb.data }, { timeoutMs: 4000 });

      const rbA = await MF.readPreset(a, { timeoutMs: 4000 });
      const rbB = await MF.readPreset(b, { timeoutMs: 4000 });
      if (!rbA.data || !rbB.data || !bytesEqual(rbA.data, pb.data) || !bytesEqual(rbB.data, pa.data)) {
        throw new Error('Swap verification failed.');
      }

      if (state.device) {
        state.device[a - 1] = { slot: a, name: pb.name, category: pb.category, p1: pb.p1, empty: false };
        state.device[b - 1] = { slot: b, name: pa.name, category: pa.category, p1: pa.p1, empty: false };
        renderDevice();
      }
      toast(`Swapped slots ${a} ⇄ ${b} ✓`, 'ok');
    } catch (e) {
      toast('Swap failed: ' + (e.message || e), 'err', 6000);
      if (pa && pb && pa.data && pb.data) {
        status('Restoring the original presets…');
        try {
          await MF.writePreset(a, { name: pa.name, category: pa.category, p1: pa.p1, data: pa.data }, { timeoutMs: 4000 });
          await MF.writePreset(b, { name: pb.name, category: pb.category, p1: pb.p1, data: pb.data }, { timeoutMs: 4000 });
          toast('Original presets restored ✓', 'ok');
        } catch (e2) {
          toast('WARNING: even the restore failed! (' + (e2.message || e2) + ')', 'err', 8000);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  /** Initializes (deletes) one or more presets on the device by writing the
   *  firmware Init template. With backup, confirmation and verification. */
  async function initDeviceSlots(slots) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    const occupiedSlots = (Array.isArray(slots) ? slots : [slots]).filter((s) => {
      const h = state.device && state.device[s - 1];
      return h && !h.empty && !h.error;
    });
    if (!occupiedSlots.length) return toast('No occupied presets to delete.', 'err');

    const yes = await showModal(
      `Initialize ${occupiedSlots.length} presets on the MicroFreak?`,
      `<p>The selected slots will be reset to the <strong>Init</strong> preset (default sound).</p>
       <p class="muted" style="font-size:12px">The MicroFreak protocol cannot create a truly "empty" slot:
       the preset is replaced by the firmware's Init. Each preset is backed up before proceeding,
       but the operation is still irreversible for the previous sound.</p>`,
      { okLabel: 'Initialize' }
    );
    if (!yes) return;

    setBusy(true, 'Reading the Init template…');
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    const backups = new Map();
    try {
      const template = await MF.readInitTemplate(4000);
      if (!template.data) throw new Error('Unable to read the firmware Init template.');

      // backup of the presets to initialize
      for (const s of occupiedSlots) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const p = await MF.readPreset(s, { timeoutMs: 4000 });
        if (p.data) backups.set(s, p);
      }

      // write Init
      for (let i = 0; i < occupiedSlots.length; i++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const s = occupiedSlots[i];
        await MF.writePreset(s, { name: 'Init', category: 0, p1: 0, data: template.data }, { timeoutMs: 4000 });
        setProgress((i + 1) / occupiedSlots.length, `Init slot ${s}…`);
      }

      // header verification
      for (const s of occupiedSlots) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const h = await MF.readHeader(s, 4000);
        if (h.empty || h.name !== 'Init') throw new Error(`Verification of slot ${s} failed.`);
      }

      for (const s of occupiedSlots) {
        state.device[s - 1] = { slot: s, name: 'Init', category: 0, p1: 0, empty: false };
      }
      state.selectedDeviceSlots.clear();
      state.devSelAnchor = null;
      renderDevice();
      toast(`Initialized ${occupiedSlots.length} presets ✓`, 'ok');
    } catch (e) {
      toast('Initialization failed: ' + (e.message || e), 'err', 6000);
      if (backups.size) {
        status('Restoring the original presets…');
        try {
          for (const [s, p] of backups) {
            if (p && p.data) {
              await MF.writePreset(s, { name: p.name, category: p.category, p1: p.p1, data: p.data }, { timeoutMs: 4000 });
            }
          }
          toast('Original presets restored ✓', 'ok');
        } catch (e2) {
          toast('WARNING: even the restore failed! (' + (e2.message || e2) + ')', 'err', 8000);
        }
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function bytesEqual(u1, u2) {
    if (!u1 || !u2 || u1.length !== u2.length) return false;
    for (let i = 0; i < u1.length; i++) if (u1[i] !== u2[i]) return false;
    return true;
  }

  async function confirmDeleteLibrarySelection() {
    const ids = selIds();
    if (!ids.length) return;
    const ok = await showModal(
      `Delete ${ids.length} presets from the library?`,
      `<p>The presets will be removed from the library. Imported files are left untouched.</p>`,
      { okLabel: 'Delete' }
    );
    if (!ok) return;
    for (const id of ids) Library.remove(id);
    state.selLib.clear();
    state.selAnchor = null;
    updateSelectionUI();
  }

  // ------------------------------------------------------------------ auto-scroll durante il drag

  let dragScrollTimer = null;
  function startDragScroll(kind) {
    stopDragScroll();
    state.dragInfo = { active: true, kind, x: 0, y: 0 };
    dragScrollTimer = setInterval(() => {
      const info = state.dragInfo;
      if (!info || !info.active) {
        stopDragScroll();
        return;
      }
      // scrolla il contenitore sotto il cursore (slot list o libreria PC)
      let container = null;
      for (const c of [el.slotList, el.libGrid]) {
        if (!c) continue;
        const r = c.getBoundingClientRect();
        if (info.x >= r.left && info.x <= r.right && info.y >= r.top && info.y <= r.bottom) {
          container = c;
          break;
        }
      }
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const zone = 56;
      let delta = 0;
      if (info.y < rect.top + zone) delta = -(zone - (info.y - rect.top));
      else if (info.y > rect.bottom - zone) delta = zone - (rect.bottom - info.y);
      if (delta) container.scrollTop += delta * 0.6;
    }, 35);
  }
  function stopDragScroll() {
    if (dragScrollTimer) {
      clearInterval(dragScrollTimer);
      dragScrollTimer = null;
    }
    state.dragInfo = null;
  }

  async function readSlotToLibrary(slot) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Reading slot ${slot}…`);
    try {
      const preset = await MF.readPreset(slot);
      if (!preset.data) {
        toast(`Slot ${slot} is empty (Init).`, 'err');
        return;
      }
      if (isInitNamed(preset)) {
        toast(`Slot ${slot} contains the Init preset: it is not added to the library.`, 'err');
        return;
      }
      const collectionId = targetCollectionId();
      Library.add(preset, { sourceName: `Device slot ${slot}`, collectionId });
      const collName = collectionId ? Library.collectionName(collectionId) : '';
      toast(`"${preset.name}" added to the library${collName ? ` "${collName}"` : ''} ✓`, 'ok');
    } catch (e) {
      toast('Read failed: ' + (e.message || e), 'err', 5000);
    } finally {
      setBusy(false);
    }
  }

  async function renameDeviceSlot(slot) {
    const h = state.device ? state.device[slot - 1] : null;
    if (!h || h.empty) return;
    const cats = MF.CATEGORIES.map((c, i) =>
      `<option value="${i}" ${h.category === i ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const ok = await showModal(
      `Rename slot ${slot}`,
      `<div class="field"><label>Name (max 14 characters)</label>
         <input id="m-name" type="text" maxlength="14" value="${esc(h.name)}" /></div>
       <div class="field"><label>Category</label><select id="m-cat">${cats}</select></div>
       <p class="muted" style="font-size:12px">Renaming only updates the header on the device (the sound is untouched).</p>`,
      { okLabel: 'Rename' }
    );
    if (!ok) return;
    const name = $('m-name').value.trim();
    const category = parseInt($('m-cat').value, 10);
    setBusy(true, 'Renaming…');
    try {
      const updated = await MF.renamePreset(slot, { name, category });
      if (state.device) {
        state.device[slot - 1] = updated;
        renderDevice();
      }
      toast(`Renamed slot ${slot} to "${updated.name}" ✓`, 'ok');
    } catch (e) {
      toast('Rename failed: ' + (e.message || e), 'err', 5000);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ rendering libreria

  /** Entries nella sola libreria attualmente selezionata (scope conteggi e filtri). */
  function scopedEntries() {
    const list = Library.all();
    if (state.filterCollection === 'none') return list.filter((e) => !e.collectionId);
    if (state.filterCollection !== 'all') {
      const cid = parseInt(state.filterCollection, 10);
      return list.filter((e) => e.collectionId === cid);
    }
    return list;
  }

  function filteredEntries() {
    let list = scopedEntries();
    list = list.filter((e) => !isInitNamed(e)); // gli Init non compaiono nella libreria
    const q = state.search.trim().toLowerCase();
    if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
    // categoria (incluse le speciali: preferiti)
    if (state.filterCategory === 'fav') {
      list = list.filter((e) => !!e.favorite);
    } else if (state.filterCategory !== 'all') {
      const [kind, id] = state.filterCategory.split(':');
      if (kind === 'cat') {
        const idx = parseInt(id, 10);
        list = list.filter((e) => e.category === idx);
      }
    }
    if (state.filterCharacteristic) {
      list = list.filter((e) => (e.characteristics || []).includes(state.filterCharacteristic));
    }
    if (state.sortMode === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    } else if (state.sortMode === 'rating') {
      list = [...list].sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    } else if (state.sortMode === 'category') {
      const key = (e) => (typeof e.category === 'number' ? e.category : -1);
      list = [...list].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    return list;
  }

  /** True se la voce è un preset "Init" (da non contare nei filtri categoria). */
  function isInitNamed(e) {
    return (e && (e.name || '').trim().toLowerCase() === 'init');
  }

  function entryChips(e) {
    const catIdx = typeof e.category === 'number' && e.category >= 0 ? e.category : -1;
    const catLabel = catIdx >= 0 ? catName(catIdx) : '';
    const catColorUsed = catColor(Math.max(0, catIdx));
    const chars = (e.characteristics || []).map((c) => `<span class="char-chip on">${esc(c)}</span>`).join('');
    return { catLabel, catColorUsed, chars };
  }

  /** Rendering delle 5 stelle; `interactive` abilita il click per impostare la valutazione. */
  function ratingStarsHtml(rating, { interactive = false, id = null, cls = '' } = {}) {
    const r = rating || 0;
    let s = `<span class="rating-stars ${cls}" ${interactive ? `data-rating="${id}"` : ''} title="${r ? `${r}/5` : 'Rating'}">`;
    for (let k = 1; k <= 5; k++) {
      s += `<span class="star ${k <= r ? 'on' : ''}" ${interactive ? `data-star="${k}"` : ''}>★</span>`;
    }
    s += `</span>`;
    return s;
  }

  function bindRating(root) {
    root.querySelectorAll('.rating-stars[data-rating]').forEach((wrap) => {
      const id = parseInt(wrap.dataset.rating, 10);
      const cur = Library.get(id);
      const stars = Array.from(wrap.querySelectorAll('.star'));
      const clearHover = () => stars.forEach((s) => s.classList.remove('hover-on'));
      stars.forEach((star) => {
        star.addEventListener('click', (e) => {
          e.stopPropagation();
          const k = parseInt(star.dataset.star, 10);
          Library.setRating(id, cur && cur.rating === k ? 0 : k);
          renderLibrary();
          if (state.selLib.size === 1 && state.selLib.has(id)) showLibraryDetail(id);
        });
        star.addEventListener('mouseenter', () => {
          clearHover();
          const k = parseInt(star.dataset.star, 10);
          stars.slice(0, k).forEach((s) => s.classList.add('hover-on'));
        });
      });
      wrap.addEventListener('mouseleave', clearHover);
    });
  }

  function bindCard(card, id) {
    const isList = () => el.libGrid.classList.contains('lib-list-view');
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('.fav') || e.target.closest('.rating-stars')) return;
      handleCardSelect(e, id);
    });
    card.addEventListener('dragstart', (e) => {
      // il preset afferrato diventa il preset attivo (se non era selezionato)
      if (!state.selLib.has(id)) {
        state.selLib = new Set([id]);
        state.selAnchor = id;
        syncLibSelectionVisuals();
        renderSelBar();
      }
      state.dragEntryId = id;
      // se la scheda fa parte di una selezione multipla, trascina l'intero blocco
      state.dragBlockIds = state.selLib.has(id) && state.selLib.size > 1 ? selIds() : null;
      e.dataTransfer.setData('application/x-managefreak', String(id));
      e.dataTransfer.setData('text/plain', String(id));
      e.dataTransfer.effectAllowed = 'copyMove';
      card.classList.add('dragging');
      startDragScroll('pc');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      state.dragEntryId = null;
      state.dragBlockIds = null;
      stopDragScroll();
    });
    // riordino: rilascia su un'altra scheda
    card.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-managefreak')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // barretta di inserimento: stessa funzione usata dal drop sulla griglia,
      // così card e gap indicano sempre la stessa identica posizione
      showLibInsertIndicator(e.clientX, e.clientY);
    });
    card.addEventListener('dragleave', () => { /* l'indicatore lo gestisce setDragIndicator */ });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      clearDragIndicator();
      const srcId = parseInt(e.dataTransfer.getData('application/x-managefreak'), 10);
      if (!srcId || srcId === id) return;
      const rect = card.getBoundingClientRect();
      const after = isList()
        ? e.clientY >= rect.top + rect.height / 2
        : e.clientX >= rect.left + rect.width / 2;
      if (state.dragBlockIds && state.dragBlockIds.length > 1) {
        Library.moveBlock(state.dragBlockIds, id, after);
      } else {
        Library.move(srcId, id, after);
      }
    });
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        const entry = Library.get(id);
        if (!entry) return;
        if (act === 'fav') Library.toggleFavorite(id);
        else if (act === 'write') writeToSlotWithDialog(entry);
        else if (act === 'export') exportEntry(entry);
        else if (act === 'delete') {
          Library.remove(id);
          state.selLib.delete(id);
          renderLibrary();
          syncDetailToSelection();
        }
      });
    });
  }

  // ------------------------------------------------------------------ multi-selezione

  function selIds() {
    return Array.from(state.selLib);
  }

  function handleCardSelect(e, id) {
    state.activePane = 'library';
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    if (ctrl) {
      if (state.selLib.has(id)) state.selLib.delete(id);
      else {
        state.selLib.add(id);
        state.selAnchor = id;
      }
    } else if (shift) {
      const order = filteredEntries().map((x) => x.id);
      const anchorId = state.selAnchor !== null && state.selLib.has(state.selAnchor) ? state.selAnchor : id;
      const from = order.indexOf(anchorId);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        state.selLib.clear();
        for (let i = a; i <= b; i++) state.selLib.add(order[i]);
      } else {
        state.selLib.clear();
        state.selLib.add(id);
        state.selAnchor = id;
      }
    } else {
      if (state.selLib.has(id)) {
        // click su un preset già selezionato → deseleziona
        state.selLib.clear();
        state.selAnchor = null;
      } else {
        state.selLib.clear();
        state.selLib.add(id);
        state.selAnchor = id;
      }
    }
    updateSelectionUI();
  }

  function clearSelection() {
    state.selLib.clear();
    state.selAnchor = null;
    updateSelectionUI();
  }

  /** Aggiorna solo la classe "selected" delle card/righe (senza re-render). */
  function syncLibSelectionVisuals() {
    document.querySelectorAll('#lib-grid .lib-card, #lib-grid .lib-row').forEach((node) => {
      const nid = parseInt(node.dataset.id, 10);
      node.classList.toggle('selected', state.selLib.has(nid));
    });
  }

  function syncDeviceSelectionVisuals() {
    document.querySelectorAll('#slot-list .slot-row').forEach((node) => {
      const nslot = parseInt(node.dataset.slot, 10);
      node.classList.toggle('selected', state.selectedDeviceSlots.has(nslot));
    });
  }

  // ------------------------------------------------------------------ navigazione con le frecce

  function navigateLibrary(key) {
    const order = filteredEntries().map((x) => x.id);
    if (!order.length) return;
    let idx = order.indexOf(state.selAnchor !== null && state.selLib.has(state.selAnchor) ? state.selAnchor : (selIds()[0] ?? order[0]));
    if (idx < 0) idx = 0;
    if (key === 'ArrowDown' || key === 'ArrowRight') idx = Math.min(order.length - 1, idx + 1);
    else if (key === 'ArrowUp' || key === 'ArrowLeft') idx = Math.max(0, idx - 1);
    state.selLib = new Set([order[idx]]);
    state.selAnchor = order[idx];
    updateSelectionUI();
    const card = el.libGrid.querySelector(`[data-id="${order[idx]}"]`);
    if (card) card.scrollIntoView({ block: 'nearest' });
  }

  function navigateDevice(key) {
    if (!state.device) return;
    const cur = state.devSelAnchor !== null && state.selectedDeviceSlots.has(state.devSelAnchor)
      ? state.devSelAnchor
      : (deviceSelIds()[0] ?? 1);
    let slot = cur;
    if (key === 'ArrowDown' || key === 'ArrowRight') slot = Math.min(512, slot + 1);
    else if (key === 'ArrowUp' || key === 'ArrowLeft') slot = Math.max(1, slot - 1);
    state.selectedDeviceSlots = new Set([slot]);
    state.devSelAnchor = slot;
    renderDevice();
    renderDeviceSelBar();
    showDeviceDetail(slot);
    const row = el.slotList.querySelector(`.slot-row[data-slot="${slot}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  /** Aggiorna griglia, barra di selezione e pannello dettagli. */
  function updateSelectionUI() {
    renderLibrary();
    renderSelBar();
    syncDetailToSelection();
  }

  function syncDetailToSelection() {
    const ids = selIds();
    if (!ids.length) showDetailEmpty();
    else if (ids.length === 1) showLibraryDetail(ids[0]);
    else showMultiDetail(ids);
  }

  function renderSelBar() {
    // barra sticky rimossa: le azioni di gruppo sono nel pannello dettagli
  }

  /** Azioni di gruppo sulla selezione multipla della libreria. */
  async function runBatchAction(act) {
    const ids = selIds();
    if (!ids.length) return;
    if (act === 'clear') return clearSelection();
    if (act === 'delete') {
      const ok = await showModal(
        `Delete ${ids.length} presets from the library?`,
        `<p>The presets will be removed from the library. Imported files are left untouched.</p>`,
        { okLabel: 'Delete' }
      );
      if (!ok) return;
      for (const id of ids) Library.remove(id);
      state.selLib.clear();
      state.selAnchor = null;
      updateSelectionUI();
    } else if (act === 'move') {
      const collections = Library.allCollections();
      const opts = collections.map((c) =>
        `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      const ok = await showModal(
        `Move ${ids.length} presets to…`,
        `<div class="field"><label>Destination library</label>
           <select id="m-coll">
             <option value="">— No library (general collection) —</option>
             ${opts}
           </select></div>
         <div class="field"><input id="m-newcoll" type="text" placeholder="…or a name for a new library" /></div>`,
        { okLabel: 'Move' }
      );
      if (!ok) return;
      let collectionId = null;
      const newName = $('m-newcoll').value.trim();
      if (newName) collectionId = Library.addCollection(newName);
      else collectionId = $('m-coll').value ? parseInt($('m-coll').value, 10) : null;
      for (const id of ids) Library.moveEntryToCollection(id, collectionId);
      state.filterCollection = collectionId === null ? 'none' : String(collectionId);
      toast(`Moved ${ids.length} presets ✓`, 'ok');
      updateSelectionUI();
    } else if (act === 'fav') {
      const allFav = ids.every((id) => {
        const e = Library.get(id);
        return e && !!e.favorite;
      });
      for (const id of ids) {
        const e = Library.get(id);
        if (!e) continue;
        if ((allFav && e.favorite) || (!allFav && !e.favorite)) Library.toggleFavorite(id);
      }
      updateSelectionUI();
    } else if (act === 'export') {
      const files = [];
      for (const id of ids) {
        const entry = Library.get(id);
        if (!entry || !entry.data) continue;
        const preset = {
          name: entry.name,
          category: typeof entry.category === 'number' && entry.category >= 0 ? entry.category : 0,
          init: 0,
          p1: entry.p1 || 0,
          data: entry.data,
          characteristics: entry.characteristics || [],
        };
        const bytes = Mfp.serializeMfp(preset);
        const safe = (entry.name || 'preset').replace(/[\\/:*?"<>|]/g, '_');
        files.push({ name: `${safe}.mfp`, dataB64: Mfp.bytesToB64(bytes) });
      }
      if (!files.length) return toast('No exportable presets.', 'err');
      const dir = await window.mfapi.exportFolder(files);
      if (dir) toast(`Exported ${files.length} presets to ${dir}`, 'ok');
    }
  }

  function showMultiDetail(ids) {
    const entries = ids.map((id) => Library.get(id)).filter(Boolean);
    const cats = new Set();
    const libs = new Set();
    for (const e of entries) {
      const ci = typeof e.category === 'number' && e.category >= 0 ? e.category : -1;
      if (ci >= 0) cats.add(catName(ci));
      const custom = e.category && String(e.category).startsWith('custom:')
        ? Library.allCategories().find((c) => c.id === parseInt(String(e.category).split(':')[1], 10))
        : null;
      if (custom) cats.add(custom.name);
      if (e.collectionId) libs.add(Library.collectionName(e.collectionId));
      else libs.add('(no library)');
    }
    renderDetail({
      name: `${entries.length} presets selected`,
      metaRows: [
        ['Categories', Array.from(cats).join(', ') || '—'],
        ['Libraries', Array.from(libs).join(', ') || '—'],
      ],
      tags: [],
      tagInput: null,
      actions: [
        { id: 'move', label: '⇥ Move to…', run: () => runBatchAction('move') },
        { id: 'fav', label: '★ Favorites', run: () => runBatchAction('fav') },
        { id: 'volume', label: '🔊 Set volume…', run: () => setVolumeOnLibrarySelection() },
        { id: 'export', label: '⭳ Export .mfp', run: () => runBatchAction('export') },
        { id: 'delete', label: 'Delete', run: () => runBatchAction('delete') },
        { id: 'clear', label: 'Deselect', run: () => runBatchAction('clear') },
      ],
      params: [],
    });
  }

  // ------------------------------------------------------------------ volume in batch

  /** Etichetta e colore della categoria di una voce di libreria o di un preset. */
  function entryCategoryChip(e) {
    const catIdx = typeof e.category === 'number' && e.category >= 0 ? e.category : -1;
    if (catIdx >= 0) return { label: catName(catIdx) || '—', color: catColor(catIdx) };
    if (e.category && String(e.category).startsWith('custom:')) {
      const c = Library.allCategories().find((x) => x.id === parseInt(String(e.category).split(':')[1], 10));
      if (c) return { label: c.name, color: c.color || catColor(0) };
    }
    return { label: '—', color: null };
  }

  /**
   * Modale "Set volume": riepilogo delle patch selezionate in stile vista a
   * lista (nome, tipo, volume attuale) + scelta del nuovo volume in dB
   * (−12 … +12, come sul MicroFreak). rows: [{name, category, color, volume|null}].
   */
  function promptVolume(title, { targetLabel, rows = [], note = null } = {}) {
    const db = (v) => Params.volumeDbLabel(v);
    const rowsHtml = rows.length
      ? `<div class="vol-summary">
           <div class="vol-summary-header"><span>Name</span><span>Type</span><span>Volume</span></div>
           <div class="vol-summary-body">
             ${rows.map((r) => `<div class="vol-summary-item">
               <span class="vsi-name" title="${esc(r.name)}">${esc(r.name)}</span>
               <span class="vsi-cat">${r.category && r.category !== '—'
                 ? `<span class="chip" style="border-color:${r.color || 'var(--border)'}">${esc(r.category)}</span>`
                 : '<span class="vsi-none">—</span>'}</span>
               <span class="vsi-vol">${r.locked
                 ? '<span class="vsi-locked">Init — not editable</span>'
                 : (r.volume === null ? '—' : esc(r.volume))}</span>
             </div>`).join('')}
           </div>
         </div>`
      : '';
    const missing = rows.filter((r) => r.volume === null && !r.locked).length;
    const foot = [
      note,
      missing ? `${missing} preset${missing === 1 ? '' : 's'} without a Volume field will be skipped` : null,
    ].filter(Boolean).join(' ');

    const p = showModal(
      title,
      `<p>Choose the new <strong>Volume</strong> for ${targetLabel}: the patch
        parameter shown on the MicroFreak, from <strong>−12&nbsp;dB</strong> to
        <strong>+12&nbsp;dB</strong> (0&nbsp;dB is neutral).</p>
       ${rowsHtml}
       ${foot ? `<p class="vol-note">${esc(foot)}</p>` : ''}
       <div class="field">
         <label for="v-db">NEW VOLUME</label>
         <div class="vol-picker">
           <span class="vol-min">−12 dB</span>
           <input type="range" id="v-db" min="-12" max="12" step="1" value="0" />
           <span class="vol-max">+12 dB</span>
         </div>
         <div id="v-db-label" class="vol-value">0 dB</div>
       </div>`,
      { okLabel: 'Apply' }
    );
    const range = $('v-db');
    const label = $('v-db-label');
    if (range && label) {
      const update = () => {
        const v = Number(range.value);
        label.textContent = db(v);
        label.classList.toggle('vol-zero', v === 0);
        // il pulsante resta "Apply": il valore è già mostrato grande qui sopra
        el.modalOk.textContent = 'Apply';
      };
      range.addEventListener('input', update);
      update();
      range.focus();
    }
    return p.then((ok) => (ok ? Number(range ? range.value : 0) : null));
  }

  /** Cambia il volume (in dB) di un gruppo di voci di libreria. Ritorna true se applicato. */
  async function applyVolumeToLibraryEntries(entries) {
    const rows = entries.map((e) => {
      const curRaw = Params.getFieldValue(e.data, Params.VOLUME_KEY);
      const cat = entryCategoryChip(e);
      return {
        id: e.id,
        name: e.name,
        category: cat.label,
        color: cat.color,
        volume: curRaw === null ? null : Params.volumeDbLabel(Params.volumeRawToDb(curRaw)),
      };
    });
    const dbVal = await promptVolume(`Set volume — ${entries.length} preset${entries.length === 1 ? '' : 's'}`, {
      targetLabel: entries.length === 1
        ? 'this preset in the PC library'
        : `${entries.length} selected preset${entries.length === 1 ? '' : 's'} in the PC library`,
      rows,
    });
    if (dbVal === null) return false;
    const raw = Params.volumeDbToRaw(dbVal);
    let done = 0;
    let skipped = 0;
    for (const r of rows) {
      if (r.volume === null) { skipped++; continue; }
      const e = entries.find((x) => x.id === r.id);
      if (!e) continue;
      const newData = Params.setFieldValue(e.data, Params.VOLUME_KEY, raw);
      Library.update(e.id, { dataB64: Mfp.bytesToB64(newData) });
      done++;
    }
    const note = skipped ? ` (${skipped} skipped, no Volume field)` : '';
    toast(`Volume set to ${Params.volumeDbLabel(dbVal)} on ${done} preset${done === 1 ? '' : 's'} in the library${note}. Send them to the MicroFreak to apply.`, 'ok', 7000);
    return true;
  }

  /** Cambia il volume delle copie in libreria dei preset selezionati. */
  async function setVolumeOnLibrarySelection() {
    const ids = selIds();
    const entries = ids.map((id) => Library.get(id)).filter((e) => e && e.data);
    if (!entries.length) return toast('No presets with a body among the selection.', 'err');
    await applyVolumeToLibraryEntries(entries);
  }

  function renderLibrary() {
    const entries = filteredEntries();
    el.libraryCount.textContent = entries.length ? `(${entries.length} presets)` : '';
    // the title shows the name of the selected library
    let title = 'All libraries';
    if (state.filterCollection === 'none') title = 'No library';
    else if (state.filterCollection !== 'all') title = Library.collectionName(parseInt(state.filterCollection, 10)) || 'Library';
    const titleEl = document.getElementById('library-title');
    if (titleEl) titleEl.textContent = title;
    el.btnViewToggle = el.btnViewToggle || document.getElementById('btn-view-toggle');
    if (el.btnViewToggle) {
      el.btnViewToggle.textContent = state.libView === 'grid' ? '☰' : '▦';
      el.btnViewToggle.title = state.libView === 'grid' ? 'Switch to list view' : 'Switch to grid view';
    }
    el.libGrid.classList.toggle('lib-list-view', state.libView === 'list');

    if (!entries.length) {
      el.libGrid.innerHTML = `<div class="view-header"><div class="hint">No presets match the filters.
        Read presets from the device or import .mfp/.mfpz/.mfprojz files exported from Arturia MIDI Control Center.</div></div>`;
      renderSidebar();
      return;
    }

    // bank index for presets without a slot number (re-indexing)
    const bankOrder = scopedEntries().map((x) => x.id);

    const html = entries.map((e) => {
      const { catLabel, catColorUsed, chars } = entryChips(e);
      const collName = e.collectionId ? Library.collectionName(e.collectionId) : '';
      const selected = state.selLib.has(e.id) ? 'selected' : '';
      // numero = posizione nella bank corrente (sempre aggiornata)
      const num = bankOrder.indexOf(e.id) + 1;
      if (state.libView === 'list') {
        return `
        <div class="lib-row ${selected}" data-id="${e.id}" draggable="true">
          <span class="row-grip" title="Drag to reorder">⠿</span>
          <span class="fav ${e.favorite ? 'on' : ''}" data-act="fav" title="Favorite">★</span>
          <span class="row-rating">${ratingStarsHtml(e.rating, { interactive: true, id: e.id })}</span>
          <span class="row-name" title="${esc(e.name)}">${esc(e.name)}</span>
          <span class="row-cat">${catLabel ? `<span class="chip" style="border-color:${catColorUsed}">${esc(catLabel)}</span>` : ''}</span>
          <span class="row-tags">${chars}</span>
          <span class="row-coll">${collName ? esc(collName) : ''}</span>
          <span class="row-actions">
            <button class="btn small" data-act="write" title="Send to MicroFreak">➡</button>
            <button class="btn small" data-act="export" title="Export .mfp">⭳</button>
            <button class="btn small" data-act="delete" title="Remove from library">Delete</button>
          </span>
        </div>`;
      }
      return `
        <div class="lib-card ${selected}" data-id="${e.id}" draggable="true">
          <div class="card-head">
            <p class="card-name">${esc(e.name)}</p>
            <span class="fav ${e.favorite ? 'on' : ''}" data-act="fav" title="Favorite">★</span>
            <span class="card-slotnum">${num}</span>
          </div>
          <div class="card-rating">${ratingStarsHtml(e.rating, { interactive: true, id: e.id })}</div>
          <div class="card-tags">
            ${catLabel ? `<span class="chip" style="border-color:${catColorUsed}">${esc(catLabel)}</span>` : ''}
          </div>
          ${chars ? `<div class="char-chips">${chars}</div>` : ''}
          <div class="card-actions">
            <button class="btn small" data-act="write" title="Send to MicroFreak">➡ Send</button>
            <button class="btn small" data-act="export" title="Export .mfp">⭳ .mfp</button>
            <button class="btn small" data-act="delete" title="Remove from library">Delete</button>
          </div>
        </div>`;
    }).join('');

    el.libGrid.innerHTML = html;
    entries.forEach((e) => {
      const card = el.libGrid.querySelector(`[data-id="${e.id}"]`);
      if (card) bindCard(card, e.id);
    });
    bindRating(el.libGrid);
    renderSidebar();
  }

  function renderSidebar() {
    const all = Library.all();
    // entries nello scope della libreria selezionata → conteggi categorie coerenti
    const scoped = scopedEntries();
    const scopedNoInit = scoped.filter((e) => !isInitNamed(e));

    // ---- Imported libraries (no dots, counts right-aligned)
    let libHtml = `<div class="cat-item ${state.filterCollection === 'all' ? 'active' : ''}" data-coll="all">
      <span class="coll-name">All libraries</span>
      <span class="cat-count">${all.length}</span></div>`;
    for (const c of Library.allCollections()) {
      const n = all.filter((e) => e.collectionId === c.id).length;
      libHtml += `<div class="cat-item ${state.filterCollection === String(c.id) ? 'active' : ''}" data-coll="${c.id}">
        <span class="coll-name">${esc(c.name)}</span>
        <span class="coll-x" data-del="${c.id}" title="Delete library (presets stay)">✕</span>
        <span class="cat-count">${n}</span></div>`;
    }
    const noneCount = all.filter((e) => !e.collectionId).length;
    libHtml += `<div class="cat-item ${state.filterCollection === 'none' ? 'active' : ''}" data-coll="none">
      <span class="coll-name">No library</span> <span class="cat-count">${noneCount}</span></div>`;
    libHtml += `<div class="cat-item" data-coll="new" style="color:var(--muted)"><span class="coll-name">＋ New library…</span></div>`;
    el.libList = el.libList || document.getElementById('lib-list');
    el.libList.innerHTML = libHtml;
    el.libList.querySelectorAll('.coll-x').forEach((x) => {
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cid = parseInt(x.dataset.del, 10);
        const c = Library.allCollections().find((cc) => cc.id === cid);
        const ok = await showModal(
          `Delete the library "${esc(c ? c.name : '')}"?`,
          `<p>The presets it contains will <strong>not</strong> be deleted: they go back to the general collection.</p>`,
          { okLabel: 'Delete' }
        );
        if (ok) {
          Library.removeCollection(cid);
          if (state.filterCollection === String(cid)) state.filterCollection = 'all';
          renderLibrary();
        }
      });
    });
    el.libList.querySelectorAll('.cat-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const coll = item.dataset.coll;
        if (coll === 'new') {
          const ok = await showModal('New library',
            `<p>Libraries keep your imported presets organized
             (e.g. an Arturia pack, a personal collection…).</p>
             <div class="field"><label>Name</label><input id="m-cname" type="text" placeholder="e.g. Pack 2024" /></div>`,
            { okLabel: 'Create' });
          if (ok) {
            const name = $('m-cname').value.trim();
            if (name) {
              const id = Library.addCollection(name);
              state.filterCollection = String(id);
              renderLibrary();
            }
          }
          return;
        }
        state.filterCollection = coll;
        renderSidebar();
        renderLibrary();
      });
    });

    // ---- Stock categories + Favorites (no custom categories; Init presets don't count)
    let html = `<div class="cat-item ${state.filterCategory === 'all' ? 'active' : ''}" data-cat="all">
      <span class="cat-dot" style="background:#8d8aa0"></span> All
      <span class="cat-count">${scopedNoInit.length}</span></div>`;
    const favCount = scopedNoInit.filter((e) => e.favorite).length;
    html += `<div class="cat-item fav-item ${state.filterCategory === 'fav' ? 'active' : ''}" data-cat="fav">
      <span class="cat-dot" style="background:var(--yellow)"></span> ★ Favorites
      <span class="cat-count">${favCount}</span></div>`;
    MF.CATEGORIES.forEach((c, i) => {
      const n = scopedNoInit.filter((e) => e.category === i).length;
      html += `<div class="cat-item ${state.filterCategory === `cat:${i}` ? 'active' : ''}" data-cat="cat:${i}">
        <span class="cat-dot" style="background:${catColor(i)}"></span> ${esc(c)}
        <span class="cat-count">${n}</span></div>`;
    });
    el.catList.innerHTML = html;
    el.catList.querySelectorAll('.cat-item').forEach((item) => {
      item.addEventListener('click', () => {
        state.filterCategory = item.dataset.cat;
        renderSidebar();
        renderLibrary();
      });
    });

    // ---- Tag (rimossi) — sezione caratteristiche subito sotto le categorie
    // ---- Caratteristiche Arturia
    el.charList.innerHTML = CHARACTERISTICS.map((c) => {
      const n = all.filter((e) => (e.characteristics || []).includes(c)).length;
      return `<div class="char-item ${state.filterCharacteristic === c ? 'active' : ''}" data-char="${esc(c)}">
        <span class="char-dot"></span> ${esc(c)}
        <span class="char-count">${n}</span></div>`;
    }).join('');
    el.charList.querySelectorAll('.char-item').forEach((item) => {
      item.addEventListener('click', () => {
        state.filterCharacteristic = state.filterCharacteristic === item.dataset.char ? null : item.dataset.char;
        renderLibrary();
      });
    });
  }

  // ------------------------------------------------------------------ dettagli

  function showDetailEmpty() {
    el.detailEmpty.classList.remove('hidden');
    el.detail.classList.add('hidden');
  }

  function renderDetail({ name, metaRows, tags, tagInput, notes, actions, params, onRemoveTag, extraHtml, onRename, hideParams = false, sideHtml = null }) {
    el.detailEmpty.classList.add('hidden');
    el.detail.classList.remove('hidden');
    const paramsTitle = document.getElementById('detail-params-title');
    if (paramsTitle) paramsTitle.classList.toggle('hidden', hideParams);
    el.detailParams.classList.toggle('hidden', hideParams);
    // colonna destra (preview wavetable/sample)
    const side = document.getElementById('detail-side');
    if (side) {
      if (sideHtml) {
        side.innerHTML = sideHtml;
        side.classList.remove('hidden');
        el.detail.classList.add('side-open');
      } else {
        side.classList.add('hidden');
        el.detail.classList.remove('side-open');
      }
    }
    el.detailName.innerHTML = '';
    el.detailName.appendChild(document.createTextNode(name));
    if (onRename) {
      // Editor inline del nome. Entrando in modifica il nome e il pulsante ✎
      // vengono sostituiti dall'input: all'uscita vanno quindi SEMPRE
      // ricostruiti entrambi, anche quando si annulla o si clicca fuori.
      let editing = false;
      const showName = (shownName) => {
        editing = false;
        el.detailName.innerHTML = '';
        el.detailName.appendChild(document.createTextNode(shownName));
        const wrap = document.createElement('span');
        wrap.className = 'name-edit-wrap';
        const btn = document.createElement('button');
        btn.className = 'btn small name-edit-btn';
        btn.textContent = '✎';
        btn.title = 'Rename';
        btn.addEventListener('click', () => startEdit(shownName));
        wrap.appendChild(btn);
        el.detailName.appendChild(wrap);
      };
      const startEdit = (currentName, initialValue) => {
        if (editing) return;
        editing = true;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'name-edit-input';
        input.maxLength = 14;
        input.value = initialValue !== undefined ? initialValue : currentName;
        el.detailName.innerHTML = '';
        el.detailName.appendChild(input);
        input.focus();
        input.select();
        let done = false;
        const finish = async (save, askFirst = false) => {
          if (done) return; // Enter + click fuori: una sola conclusione
          done = true;
          document.removeEventListener('pointerdown', onOutside, true);
          const value = input.value.trim();
          if (!save || !value || value === currentName) {
            showName(currentName); // annullato o invariato
            return;
          }
          if (askFirst) {
            // clic fuori dal campo: chiedi conferma prima di rinominare
            const yes = await showModal('Confirm the name change?',
              `<p>Rename <strong>${esc(currentName)}</strong> to <strong>${esc(value)}</strong>?</p>`,
              { okLabel: 'Rename' });
            if (!yes) { showName(currentName); return; }
          }
          showName(value);
          let applied = true;
          try {
            const res = await Promise.resolve(onRename(value));
            applied = res !== false;
            // se il chiamante restituisce il nome REALMENTE salvato sul device
            // (es. troncato a 12/14 caratteri) è quello che va mostrato
            if (applied && typeof res === 'string' && res && res !== value) showName(res);
          } catch (e) {
            applied = false;
            toast('Rename failed: ' + (e && e.message || e), 'err', 5000);
          }
          // se la scrittura non è riuscita la UI non deve mentire: torna il nome
          // reale e riapre il campo col testo digitato, pronto per riprovare
          if (!applied) {
            showName(currentName);
            startEdit(currentName, value);
          }
        };
        // clic fuori dal campo = conferma (con richiesta esplicita). In fase di
        // capture, così parte PRIMA che il clic ridisegni il pannello
        // distruggendo l'input (era il motivo per cui il testo andava perso).
        const onOutside = (ev) => {
          if (ev.target !== input) finish(true, true);
        };
        document.addEventListener('pointerdown', onOutside, true);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); finish(true, false); }
          else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true, false));
      };
      showName(name);
    }
    el.detailMeta.innerHTML = metaRows.map(([k, v]) =>
      `<div><strong>${esc(k)}:</strong> ${esc(v)}</div>`).join('');
    if (extraHtml) {
      const box = document.createElement('div');
      box.className = 'detail-extra';
      box.innerHTML = extraHtml;
      el.detailMeta.appendChild(box);
    }
    el.detailTags.innerHTML = tags.map((t) =>
      `<span class="tag">${esc(t)} <span class="x" data-tag="${esc(t)}">✕</span></span>`).join('');
    if (onRemoveTag) {
      el.detailTags.querySelectorAll('.x').forEach((x) => {
        x.addEventListener('click', () => onRemoveTag(x.dataset.tag));
      });
    }
    el.detailAddTag.classList.toggle('hidden', !tagInput);
    if (tagInput) {
      el.detailAddTag.value = '';
      el.detailAddTag.onkeydown = (e) => {
        if (e.key === 'Enter' && el.detailAddTag.value.trim()) {
          tagInput.onAdd(el.detailAddTag.value.trim());
          el.detailAddTag.value = '';
        }
      };
    }
    el.detailNotesBox.classList.add('hidden'); // campo note rimosso
    // i pulsanti possono stare nella riga standard oppure accanto alle stelle
    // (contenitore #detail-actions-row fornito dal chiamante)
    const inlineActions = document.getElementById('detail-actions-row');
    const actionsHost = inlineActions || el.detailActions;
    actionsHost.innerHTML = actions.map((a) =>
      `<button class="btn small" data-action="${a.id}">${esc(a.label)}</button>`).join('');
    if (inlineActions) el.detailActions.innerHTML = '';
    actionsHost.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => actions.find((a) => a.id === b.dataset.action).run());
    });
    el.detailParams.innerHTML = params.length
      ? params.map((p) => `<div class="param-row"><span class="plabel">${esc(p.label)}</span><span class="pvalue">${esc(p.value)}</span></div>`).join('')
      : '<div class="muted" style="font-size:12px">Preset body not available.</div>';
  }

  function showDeviceDetail(slot) {
    const h = state.device ? state.device[slot - 1] : null;
    if (!h) return showDetailEmpty();
    const isInit = h && !h.error && !h.empty && (h.name || '').trim() === 'Init';
    renderDetail({
      name: h.name || `Slot ${slot}`,
      metaRows: [
        ['Slot', String(slot)],
        ['Status', !h ? 'Unread' : h.error ? 'Error' : (h.empty ? 'Empty (Init)' : (isInit ? 'Init preset' : 'Occupied'))],
        ['Category', h.category >= 0 ? catName(h.category) : '—'],
      ],
      tags: [],
      tagInput: null,
      actions: [
        { id: 'play', label: '▶ Select on synth', run: () => MF.selectPreset(slot) },
        ...(h.empty || h.error ? [] : [{ id: 'read', label: '⬅ Import to library', run: () => readSlotToLibrary(slot) }]),
        ...(h.empty || h.error ? [] : [{ id: 'volume', label: '🔊 Set volume…', run: () => setVolumeOnDeviceSelection([slot]) }]),
        ...(h.empty || h.error ? [] : [{ id: 'init', label: 'Delete (Init)', run: () => initDeviceSlots([slot]) }]),
      ],
      params: [],
      onRename: (h.empty || h.error) ? null : async (newName) => {
        setBusy(true, 'Renaming…');
        try {
          const updated = await MF.renamePreset(slot, { name: newName });
          if (state.device) {
            state.device[slot - 1] = updated;
            renderDevice();
          }
          toast(`Renamed slot ${slot} to "${updated.name}" ✓`, 'ok');
          return updated.name; // il nome reale salvato sul device
        } catch (e) {
          toast('Rename failed: ' + (e.message || e), 'err', 5000);
          return false;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function showLibraryDetail(id) {
    const entry = Library.get(id);
    if (!entry) return showDetailEmpty();
    const catIdx = typeof entry.category === 'number' && entry.category >= 0 ? entry.category : -1;
    const customCat = entry.category && String(entry.category).startsWith('custom:')
      ? Library.allCategories().find((c) => c.id === parseInt(String(entry.category).split(':')[1], 10))
      : null;
    const catLabel = customCat ? customCat.name : (catIdx >= 0 ? catName(catIdx) : '—');
    const params = entry.data ? Params.describe(entry.data).rows : [];
    const tags = entry.tags || [];
    const collName = entry.collectionId ? Library.collectionName(entry.collectionId) : '—';
    const collOpts = [
      `<option value="">— No library —</option>`,
      ...Library.allCollections().map((c) =>
        `<option value="${c.id}" ${entry.collectionId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`),
    ].join('');
    const catOpts = [
      `<option value="-1">— none —</option>`,
      ...MF.CATEGORIES.map((c, i) =>
        `<option value="${i}" ${catIdx === i ? 'selected' : ''}>${esc(c)}</option>`),
    ].join('');
    const charChips = CHARACTERISTICS.map((c) => {
      const on = (entry.characteristics || []).includes(c);
      return `<span class="char-chip ${on ? 'on' : ''}" data-char="${esc(c)}">${esc(c)}</span>`;
    }).join('');
    const extraHtml = `
      <div class="detail-coll">
        <label for="detail-coll-sel">Library</label>
        <select id="detail-coll-sel">${collOpts}</select>
      </div>
      <div class="detail-coll">
        <label for="detail-cat-sel">Category</label>
        <select id="detail-cat-sel">${catOpts}</select>
      </div>
      <div class="detail-coll detail-coll-rating">
        <label>Rating</label>
        <div class="rating-actions">
          <div id="detail-rating">${ratingStarsHtml(entry.rating || 0, { interactive: true, id })}</div>
          <div id="detail-actions-row" class="detail-actions inline"></div>
        </div>
      </div>
      <div class="detail-coll">
        <label>Characteristics</label>
        <div class="char-chips" id="detail-chars">${charChips}</div>
      </div>`;
    renderDetail({
      name: entry.name,
      metaRows: [
        ['Category', catLabel],
        ['Source', entry.sourceName || (entry.sourceSlot ? `Device slot ${entry.sourceSlot}` : '—')],
        ['Added', new Date(entry.addedAt).toLocaleString()],
      ],
      tags: [],
      tagInput: null,
      actions: [
        { id: 'export', label: '⭳ Export .mfp', run: () => exportEntry(entry) },
        { id: 'exportz', label: '⭳ Export .mfpz', run: () => exportEntry(entry, true) },
        { id: 'volume', label: '🔊 Set volume…', run: async () => {
          if (!entry.data) return toast('This preset has no body.', 'err');
          const changed = await applyVolumeToLibraryEntries([entry]);
          if (changed) showLibraryDetail(id); // aggiorna il parametro Volume (dB)
        } },
        { id: 'delete', label: 'Delete', run: () => { Library.remove(id); showDetailEmpty(); renderLibrary(); } },
      ],
      params,
      extraHtml,
      onRename: (newName) => {
        Library.update(id, { name: newName });
        renderLibrary();
        showLibraryDetail(id);
      },
    });
    const sel = document.getElementById('detail-coll-sel');
    if (sel) {
      sel.addEventListener('change', () => {
        Library.moveEntryToCollection(id, sel.value ? parseInt(sel.value, 10) : null);
        showLibraryDetail(id);
      });
    }
    const catSel = document.getElementById('detail-cat-sel');
    if (catSel) {
      catSel.addEventListener('change', () => {
        const v = catSel.value;
        const cat = v === '-1' ? -1 : parseInt(v, 10);
        Library.update(id, { category: cat });
        showLibraryDetail(id);
      });
    }
    const charBox = document.getElementById('detail-chars');
    if (charBox) {
      charBox.querySelectorAll('.char-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          Library.toggleCharacteristic(id, chip.dataset.char);
          showLibraryDetail(id);
        });
      });
    }
    bindRating(el.detail);
  }

  async function renameLibraryEntry(id) {
    const entry = Library.get(id);
    if (!entry) return;
    const cats = MF.CATEGORIES.map((c, i) =>
      `<option value="${i}" ${entry.category === i ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const ok = await showModal(
      'Edit preset in library',
      `<div class="field"><label>Name</label><input id="m-name" type="text" maxlength="14" value="${esc(entry.name)}" /></div>
       <div class="field"><label>Category</label><select id="m-cat">
         <option value="-1">— none —</option>${cats}
       </select></div>`,
      { okLabel: 'Save' }
    );
    if (!ok) return;
    const name = $('m-name').value.trim();
    const cat = $('m-cat').value;
    Library.update(id, { name, category: cat === '-1' ? -1 : parseInt(cat, 10) });
    renderLibrary();
    showLibraryDetail(id);
  }

  // ------------------------------------------------------------------ import / export

  async function importFiles() {
    const files = await window.mfapi.openFiles({
      filters: [
        { name: 'MicroFreak preset / MCC', extensions: ['mfp', 'mbp', 'mfpz', 'mfprojz', 'syx', 'zip', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!files || !files.length) return;

    // 1. parse everything (JSON backups are restored separately)
    const parsed = [];
    const errors = [];
    let restoredBackups = 0;
    for (const f of files) {
      const bytes = Mfp.b64ToBytes(f.data);
      const ext = f.name.split('.').pop().toLowerCase();
      try {
        if (ext === 'json') {
          const json = JSON.parse(Mfp.bytesToText(bytes));
          if (!json || !Array.isArray(json.entries)) throw new Error('Unrecognized JSON');
          const collMap = new Map();
          for (const c of (json.collections || [])) {
            if (typeof c.id === 'number') collMap.set(c.id, Library.addCollection(c.name));
          }
          for (const e of json.entries) {
            if (!e.dataB64 && !e.rawHeaderB64) continue;
            const raw = { ...e };
            if (raw.collectionId != null && collMap.has(raw.collectionId)) {
              raw.collectionId = collMap.get(raw.collectionId);
            } else {
              raw.collectionId = null;
            }
            Library.importRaw(raw);
            restoredBackups++;
          }
        } else if (ext === 'mfp' || ext === 'mbp') {
          parsed.push({ kind: 'preset', value: Mfp.parseMfp(bytes), sourceName: f.name });
        } else if (ext === 'zip') {
          try {
            parsed.push({ kind: 'preset', value: await Mfp.parseMfpz(bytes), sourceName: f.name });
          } catch {
            parsed.push({ kind: 'preset', value: Mfp.parseMfp(bytes), sourceName: f.name });
          }
        } else if (ext === 'mfpz') {
          parsed.push({ kind: 'preset', value: await Mfp.parseMfpz(bytes), sourceName: f.name });
        } else if (ext === 'mfprojz') {
          for (const p of await Mfp.parseMfprojz(bytes)) {
            parsed.push({ kind: 'preset', value: p, sourceName: f.name });
          }
        } else if (ext === 'syx') {
          parsed.push({ kind: 'preset', value: Mfp.parseSyx(bytes), sourceName: f.name });
        } else {
          throw new Error('Unsupported extension: .' + ext);
        }
      } catch (e) {
        errors.push(`${f.name}: ${e.message || e}`);
      }
    }

    if (!parsed.length) {
      if (restoredBackups) {
        toast(`Backup restored: ${restoredBackups} presets ✓`, 'ok');
        renderLibrary();
      } else {
        toast('No importable presets in the chosen files. ' + errors.join(' — '), 'err', 7000);
      }
      return;
    }

    // filtra i preset Init vuoti (slot vuoti dei progetti MCC)
    const isInitPreset = (p) => p.value.init === 1 || !p.value.data || p.value.data.length === 0 || isInitNamed(p.value);
    const importable = parsed.filter((p) => !isInitPreset(p));
    const skippedInit = parsed.length - importable.length;
    if (!importable.length) {
      toast(`No presets imported: all ${parsed.length} presets are empty Init slots.`, 'ok');
      return;
    }

    // 2. scegli la libreria di destinazione
    const collections = Library.allCollections();
    const opts = collections.map((c) =>
      `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const cur = state.filterCollection !== 'all' && state.filterCollection !== 'none'
      ? state.filterCollection : '';
    const ok = await showModal(
      `Import ${importable.length} presets${skippedInit ? ` (${skippedInit} empty Init slots skipped)` : ''}`,
      `<p>Which library should the presets be imported into?</p>
       <div class="field"><label>Destination library</label>
         <select id="m-coll">
           <option value="" ${cur === '' ? 'selected' : ''}>— No library (general collection) —</option>
           ${opts}
         </select></div>
       <div class="field" style="display:flex;gap:8px;align-items:center">
         <input id="m-newcoll" type="text" placeholder="…or type a name for a new library" />
       </div>`,
      {
        okLabel: 'Import',
        onOk: () => {
          if ($('m-newcoll').value.trim()) return true;
          return true;
        },
      }
    );
    if (!ok) return;

    let collectionId = null;
    const newName = $('m-newcoll').value.trim();
    if (newName) {
      collectionId = Library.addCollection(newName);
    } else {
      collectionId = $('m-coll').value ? parseInt($('m-coll').value, 10) : null;
    }

    // 3. inserisci
    let added = 0;
    for (const p of importable) {
      if (p.kind === 'raw') Library.importRaw(p.value);
      else Library.add(p.value, { sourceName: p.sourceName, collectionId });
      added++;
    }
    state.filterCollection = collectionId === null ? 'all' : String(collectionId);
    state.filterCategory = 'all';
    state.filterTag = null;
    toast(`Imported ${added} presets ✓` + (skippedInit ? ` — ${skippedInit} empty Init slots skipped` : ''), 'ok');
    if (errors.length) toast('Some files were not imported: ' + errors.join(' — '), 'err', 7000);
    renderLibrary();
  }

  async function exportEntry(entry, asZip = false) {
    const preset = {
      name: entry.name,
      category: typeof entry.category === 'number' && entry.category >= 0 ? entry.category : 0,
      init: 0,
      p1: entry.p1 || 0,
      data: entry.data,
      characteristics: entry.characteristics || [],
    };
    if (!preset.data) return toast('The preset has no valid body.', 'err');
    const safe = (entry.name || 'preset').replace(/[\\/:*?"<>|]/g, '_');
    if (!asZip) {
      const bytes = Mfp.serializeMfp(preset);
      await window.mfapi.saveFile({
        defaultName: `${safe}.mfp`,
        data: Mfp.bytesToB64(bytes),
        filters: [{ name: 'MicroFreak preset', extensions: ['mfp'] }],
      });
    } else {
      const bytes = await Mfp.serializeMfpz(preset);
      await window.mfapi.saveFile({
        defaultName: `${safe}.mfpz`,
        data: Mfp.bytesToB64(bytes),
        filters: [{ name: 'Compressed MicroFreak preset', extensions: ['mfpz'] }],
      });
    }
  }

  async function exportAll() {
    const entries = Library.all();
    if (!entries.length) return toast('Library is empty.', 'err');
    const files = [];
    for (const e of entries) {
      const entry = Library.get(e.id);
      if (!entry.data) continue;
      const preset = {
        name: entry.name,
        category: typeof entry.category === 'number' && entry.category >= 0 ? entry.category : 0,
        init: 0,
        p1: entry.p1 || 0,
        data: entry.data,
        characteristics: entry.characteristics || [],
      };
      const bytes = Mfp.serializeMfp(preset);
      const safe = (entry.name || 'preset').replace(/[\\/:*?"<>|]/g, '_');
      files.push({ name: `${safe}.mfp`, dataB64: Mfp.bytesToB64(bytes) });
    }
    const dir = await window.mfapi.exportFolder(files);
    if (dir) toast(`Exported ${files.length} presets to ${dir}`, 'ok');
  }

  async function backupLibrary() {
    const entries = Library.all();
    const collections = Library.allCollections();
    const stateCopy = JSON.stringify({
      version: 2,
      entries,
      customCategories: Library.allCategories(),
      collections,
    }, null, 1);
    let savedPath = null;
    try {
      savedPath = await window.mfapi.saveFile({
        defaultName: `managefreak-backup-${new Date().toISOString().slice(0, 10)}.json`,
        data: btoa(unescape(encodeURIComponent(stateCopy))),
        filters: [{ name: 'ManageFreak backup (JSON)', extensions: ['json'] }],
      });
    } catch (e) {
      toast('Library backup failed: ' + (e && e.message || e), 'err', 6000);
      return;
    }
    if (!savedPath) return; // annullato nella finestra di salvataggio
    const file = String(savedPath).split(/[\\/]/).pop();
    const kb = Math.max(1, Math.round(new TextEncoder().encode(stateCopy).length / 1024));
    const sizeTxt = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
    toast(`Library backed up ✓ — ${entries.length} preset${entries.length === 1 ? '' : 's'}`
      + `${collections.length ? `, ${collections.length} librar${collections.length === 1 ? 'y' : 'ies'}` : ''}`
      + ` → "${file}" (${sizeTxt})`, 'ok', 8000);
  }

  async function pickLibraryEntry() {
    const entries = Library.all();
    if (!entries.length) {
      toast('The library is empty.', 'err');
      return null;
    }
    const opts = entries.map((e) =>
      `<option value="${e.id}">${esc(e.name)}${e.sourceSlot ? ` (slot ${e.sourceSlot})` : ''}</option>`).join('');
    const ok = await showModal(
      'Choose the preset to write',
      `<select id="m-entry">${opts}</select>`,
      { okLabel: 'Continue' }
    );
    if (!ok) return null;
    return Library.get(parseInt($('m-entry').value, 10));
  }

  // ------------------------------------------------------------------ colonne ridimensionabili

  function initResizers() {
    document.querySelectorAll('.resizer').forEach((rz) => {
      rz.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const which = rz.dataset.resize; // 'side' | 'right' | 'h'
        const startX = e.clientX;
        const startY = e.clientY;
        const root = document.documentElement;
        const isHorizontal = which === 'h';
        const startVar = parseFloat(getComputedStyle(root).getPropertyValue(isHorizontal ? '--h-detail' : '--w-' + which)) || 0;
        const onMove = (ev) => {
          let v;
          if (isHorizontal) {
            // spostare il bordo verso l'alto espande i dettagli
            v = startVar - (ev.clientY - startY);
            v = Math.min(540, Math.max(120, v));
            root.style.setProperty('--h-detail', v + 'px');
          } else {
            if (which === 'side') {
              // trascinare il divisore verso destra allarga la colonna di sinistra
              v = startVar + (ev.clientX - startX);
              v = Math.min(420, Math.max(170, v));
            } else {
              // trascinare il divisore verso sinistra allarga la colonna di destra
              v = startVar - (ev.clientX - startX);
              v = Math.min(720, Math.max(300, v));
            }
            root.style.setProperty('--w-' + which, v + 'px');
          }
          rz.classList.add('active');
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          rz.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.body.style.cursor = isHorizontal ? 'ns-resize' : 'col-resize';
        document.body.style.userSelect = 'none';
      });
    });
  }

  // ------------------------------------------------------------------ tab bar: Wavetables / Samples / Device

  const safeFile = (s) => String(s || 'file').replace(/[\\/:*?"<>|]/g, '_');

  const DEVICE_SETTINGS = [
    ['midi.channel_in', 'MIDI Input Channel', 'left'],
    ['midi.channel_out', 'MIDI Output Channel', 'left'],
    ['midi.output_destination', 'MIDI Output Destination', 'left'],
    ['midi.local_control', 'Local Control', 'left'],
    ['midi.arp_seq_notes_out', 'Arp/Seq MIDI Out', 'left'],
    ['midi.thru', 'MIDI Through', 'left'],
    ['midi.knob_send_cc', 'Knob Send CCs', 'left'],
    ['midi.merge', 'MIDI Merge', 'left'],
    ['clock.source', 'MIDI Clock Source', 'left'],
    ['clock.sync_port_timing', 'Sync Clock In/Out Settings', 'left'],
    ['clock.global_tempo', 'Global Tempo', 'left'],
    ['cv.pitch_format', 'CV Pitch Format', 'left'],
    ['cv.gate_format', 'CV Gate Format', 'left'],
    ['cv.press_range', 'CV Press Range', 'left'],
    ['cv.zero_volt_reference', 'CV 0V Reference', 'left'],
    ['cv.one_volt_reference', 'CV 1V Reference', 'left'],
    ['control.knob_catch', 'Knob Catch', 'right'],
    ['control.click_to_load', 'Click to Load Preset', 'right'],
    ['control.osc_knob_speed', 'Osc Knob Speed', 'right'],
    ['control.octave_led_blink', 'Oct LED Blink', 'right'],
    ['tuning.master', 'Master Tuning', 'right'],
    ['memory.protection', 'Memory Protection', 'right'],
    ['keyboard.sensitivity', 'Keyboard Sensitivity', 'right'],
    ['keyboard.aftertouch_curve', 'Aftertouch Curve', 'right'],
    ['keyboard.velocity_curve', 'Velocity Curve', 'right'],
    ['keyboard.relative_bend', 'Relative Bend', 'right'],
    ['keyboard.scale', 'Scale', 'right'],
    ['keyboard.root_note', 'Root Note', 'right'],
    ['microphone.gain', 'Mic Gain', 'right'],
    ['microphone.noise_gate', 'Noise Gate', 'right'],
    ['microphone.detect', 'Mic Detection', 'right'],
  ];

  const fmtMs = (ms) => {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('#tabs .tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    const content = document.getElementById('content');
    const layout = document.getElementById('layout');
    for (const t of ['wavetables', 'samples', 'device']) {
      content.classList.toggle('tab-' + t, tab === t);
      layout.classList.toggle('tab-' + t, tab === t);
    }
    const views = { presets: 'library-view', wavetables: 'wavetable-view', samples: 'samples-view', device: 'device-view' };
    for (const [t, id] of Object.entries(views)) {
      $('' + id).classList.toggle('hidden', t !== tab);
    }
    // sidebar contestuale: presets → librerie preset; wavetable/sample → librerie
    // dedicate; device → SOLO backup/ripristino completo (categorie, caratteristiche
    // e librerie non servono nella schermata del dispositivo)
    const libTarget = tab === 'wavetables' ? 'sidebar-wavetables' : tab === 'samples' ? 'sidebar-samples' : 'sidebar-library';
    const mostraLibrerie = tab !== 'device';
    for (const id of ['sidebar-library', 'sidebar-wavetables', 'sidebar-samples']) {
      $('' + id).classList.toggle('hidden', !mostraLibrerie || id !== libTarget);
    }
    // il backup completo del dispositivo si trova nelle schede Presets e Device
    $('sidebar-backup').classList.toggle('hidden', tab !== 'presets' && tab !== 'device');
    if (tab === 'wavetables') {
      renderWavetableSidebar();
      renderWavetablePc();
      showDetailEmpty();
      if (!state.wavetables && Midi.isOpen()) readWavetableInventory();
    }
    if (tab === 'samples') {
      renderSampleSidebar();
      renderSamplePc();
      showDetailEmpty();
      if (!state.samples && Midi.isOpen()) readSampleInventory();
    }
    // la scheda Device rilegge sempre i valori dal synth: un ripristino (o un
    // reset sul synth) può averli cambiati fuori dall'app, e mostrare i valori
    // vecchi faceva sembrare che il ripristino non avesse funzionato
    if (tab === 'device' && Midi.isOpen()) loadDeviceGlobals({ quiet: true });
    if (tab === 'presets') {
      const ids = selIds();
      if (ids.length === 1) showLibraryDetail(ids[0]);
      else if (ids.length > 1) showMultiDetail(ids);
      else showDetailEmpty();
    }
    if (tab !== 'wavetables') {
      state.wtSel.clear();
      state.wtSelAnchor = null;
    }
    if (tab !== 'samples') {
      state.smSel.clear();
      state.smSelAnchor = null;
    }
  }

  // ---------------------------------------------------------------- wavetables

  async function readWavetableInventory() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, 'Reading wavetable slots…');
    try {
      const out = [];
      for (let s = 1; s <= MF.WAVE_SLOTS; s++) out.push(await MF.readWavetableHeader(s));
      state.wavetables = out;
      renderWavetables();
      toast('Wavetable directory loaded ✓', 'ok');
    } catch (e) {
      toast('Wavetable read failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  function renderWavetables() {
    const listEl = $('wt-list');
    if (!listEl) return;
    const list = state.wavetables || [];
    const occ = list.filter((h) => h && !h.empty).length;
    const count = $('wt-count');
    if (count) count.textContent = `(${occ}/16 used)`;
    listEl.innerHTML = list.map((h, i) => {
      const slot = i + 1;
      const empty = !h || h.empty;
      return `<div class="wt-row ${empty ? 'empty' : ''}" data-slot="${slot}">
        <span class="wt-num">${slot}</span>
        <span class="wt-name">${empty ? '(empty)' : esc(h.name)}</span>
        <span class="wt-meta">${empty ? '' : '16 KB'}</span>
        <span class="wt-actions">
          <button class="btn small" data-wt="up" title="Substitute WAV / .mfw / .mfwz">↻</button>
          ${empty ? '' : `<button class="btn small" data-wt="dl" title="Download .mfw">⭳</button>
          <button class="btn small" data-wt="clear" title="Clear slot">✕</button>`}
        </span>
      </div>`;
    }).join('');
    listEl.querySelectorAll('[data-wt]').forEach((btn) => {
      const slot = parseInt(btn.closest('.wt-row').dataset.slot, 10);
      btn.addEventListener('click', () => {
        const act = btn.dataset.wt;
        if (act === 'dl') readWavetableToPC(slot);
        else if (act === 'up') importWavetableIntoSlot(slot);
        else if (act === 'clear') clearWavetableSlot(slot);
      });
    });
    // drag&drop: PC → dispositivo (upload) e dispositivo → PC (archivia)
    listEl.querySelectorAll('.wt-row').forEach((row) => {
      const slot = parseInt(row.dataset.slot, 10);
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        handleWtSelect(e, slot);
      });
      const h = list[slot - 1];
      if (h && !h.empty) {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          if (state.wtSel.has(slot) && state.wtSel.size > 1) {
            e.dataTransfer.setData('application/x-managefreak-wt-block', Array.from(state.wtSel).sort((a, b) => a - b).join(','));
          }
          e.dataTransfer.setData('application/x-managefreak-wt-slot', String(slot));
          e.dataTransfer.setData('text/plain', String(slot));
          e.dataTransfer.effectAllowed = 'copyMove';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
      }
    });
    // drag&drop sul contenitore: upload da PC su uno slot, oppure riordino
    // device (swap al centro della riga, shift sui bordi)
    const clearWtHighlights = () => {
      listEl.querySelectorAll('.wt-row').forEach((r) =>
        r.classList.remove('swap-over', 'write-over', 'drop-before', 'drop-after'));
    };
    const resolveWtDrop = (clientY) => {
      const rows = Array.from(listEl.querySelectorAll('.wt-row'));
      if (!rows.length) return null;
      let hit = null;
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          const rel = (clientY - r.top) / r.height;
          let mode;
          if (rel < 0.3) mode = 'before';
          else if (rel > 0.7) mode = 'after';
          else mode = 'onto';
          hit = { slot: parseInt(row.dataset.slot, 10), mode };
          break;
        }
      }
      if (!hit) {
        hit = { slot: parseInt(rows[rows.length - 1].dataset.slot, 10), mode: 'after' };
        for (const row of rows) {
          const r = row.getBoundingClientRect();
          if (clientY < r.top) {
            hit = { slot: parseInt(row.dataset.slot, 10), mode: 'before' };
            break;
          }
        }
      }
      return hit;
    };
    const handleWtDrop = async (e, target) => {
      const idStr = e.dataTransfer.getData('application/x-managefreak-wt');
      if (idStr) {
        const entry = state.wtLib.find((x) => x.id === idStr);
        if (!entry) return;
        // conferma sempre, identica ai preset
        const ok = await confirmSlotWrite({ name: entry.name, slot: target.slot });
        if (!ok) return;
        await uploadWavetableEntryToSlot(entry, target.slot);
        return;
      }
      const block = e.dataTransfer.getData('application/x-managefreak-wt-block');
      const srcSlot = parseInt(e.dataTransfer.getData('application/x-managefreak-wt-slot'), 10);
      if (!srcSlot && !block) return;
      if (!block && srcSlot === target.slot) return;
      const moved = block
        ? block.split(',').map(Number)
        : (state.wtSel.has(srcSlot) && state.wtSel.size > 1 ? Array.from(state.wtSel) : [srcSlot]);
      if (target.mode === 'onto' && moved.length === 1) {
        await moveWavetableSelection(moved, target.slot, false, { swap: true });
      } else {
        await moveWavetableSelection(moved, target.slot, target.mode === 'after');
      }
    };
    const wtDragTypes = ['application/x-managefreak-wt', 'application/x-managefreak-wt-slot', 'application/x-managefreak-wt-block'];
    listEl.addEventListener('dragover', (e) => {
      if (!wtDragTypes.some((t) => e.dataTransfer.types.includes(t))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = resolveWtDrop(e.clientY);
      if (!target) return;
      // Wavetable trascinata dalla LIBRERIA: sostituisce lo slot sotto il
      // puntatore → nessuna barretta, solo l'evidenziazione dello slot
      if (e.dataTransfer.types.includes('application/x-managefreak-wt')) {
        const row = listEl.querySelector(`.wt-row[data-slot="${target.slot}"]`);
        if (row) setDragIndicator(row, 'swap-over');
        return;
      }
      // stesso punto di inserimento → stessa indicazione (vedi nota nei sample)
      const rows = Array.from(listEl.querySelectorAll('.wt-row'));
      const idx = rows.findIndex((r) => parseInt(r.dataset.slot, 10) === target.slot);
      const ind = (target.mode === 'before' && idx > 0)
        ? { slot: parseInt(rows[idx - 1].dataset.slot, 10), mode: 'after' }
        : target;
      const row = listEl.querySelector(`.wt-row[data-slot="${ind.slot}"]`);
      if (row) {
        setDragIndicator(row, ind.mode === 'onto' ? 'swap-over' : ind.mode === 'before' ? 'drop-before' : 'drop-after');
      }
    });
    listEl.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !listEl.contains(e.relatedTarget)) clearWtHighlights();
    });
    listEl.addEventListener('drop', async (e) => {
      if (!wtDragTypes.some((t) => e.dataTransfer.types.includes(t))) return;
      e.preventDefault();
      clearWtHighlights();
      const target = resolveWtDrop(e.clientY);
      if (target) await handleWtDrop(e, target);
    });
    const pcList = $('wt-pc-list');
    if (pcList && !pcList.dataset.bound) {
      pcList.dataset.bound = '1';
      pcList.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types;
        if (types.includes('application/x-managefreak-wt-slot') || types.includes('application/x-managefreak-wt-block')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          pcList.classList.add('drop-target');
        }
      });
      pcList.addEventListener('dragleave', () => pcList.classList.remove('drop-target'));
      pcList.addEventListener('drop', (e) => {
        e.preventDefault();
        pcList.classList.remove('drop-target');
        const block = e.dataTransfer.getData('application/x-managefreak-wt-block');
        if (block) {
          importWtSelectionToPc();
          return;
        }
        const slotStr = e.dataTransfer.getData('application/x-managefreak-wt-slot');
        if (slotStr) readWavetableSlotToPc(parseInt(slotStr, 10));
      });
    }
  }

  async function readWavetableToPC(slot) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Reading wavetable slot ${slot}…`);
    try {
      const wt = await MF.readWavetable(slot);
      if (!wt.data) return toast(`Wavetable slot ${slot} is empty.`, 'err');
      const bytes = Mfp.serializeMfw({ name: wt.name, data: wt.data });
      await window.mfapi.saveFile({
        defaultName: `${safeFile(wt.name)}.mfw`,
        data: Mfp.bytesToB64(bytes),
        filters: [{ name: 'MicroFreak wavetable', extensions: ['mfw'] }],
      });
    } catch (e) {
      toast('Wavetable read failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  async function importWavetableIntoSlot(slot) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    let target = slot;
    if (target === null || target === undefined) {
      const free = (state.wavetables || []).findIndex((h) => !h || h.empty);
      if (free < 0) return toast('No free wavetable slots.', 'err');
      target = free + 1;
    }
    const files = await window.mfapi.openFiles({
      filters: [
        { name: 'WAV / .mfw / .mfwz', extensions: ['wav', 'mfw', 'mfwz'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!files || !files.length) return;
    const f = files[0];
    const bytes = Mfp.b64ToBytes(f.data);
    const ext = f.name.split('.').pop().toLowerCase();
    let wt;
    try {
      if (ext === 'wav') wt = Mfp.wavToWavetable(bytes, f.name.replace(/\.[^.]+$/, ''));
      else if (ext === 'mfw') wt = Mfp.parseMfw(bytes);
      else if (ext === 'mfwz') wt = await Mfp.parseMfwz(bytes);
      else throw new Error('Unsupported extension: .' + ext);
    } catch (e) {
      return toast('Import failed: ' + (e.message || e), 'err', 6000);
    }
    setBusy(true, `Substituting wavetable in slot ${target}…`);
    setProgress(0, 'Substituting wavetable…');
    try {
      await MF.writeWavetable(target, { name: wt.name || 'Wavetable', data: wt.data }, {
        onProgress: (frac, label) => setProgress(frac, label),
      });
      delete state.wtData[target];
      if (state.wavetables) state.wavetables[target - 1] = await MF.readWavetableHeader(target);
      renderWavetables();
      if (state.wtLastRender && state.wtLastRender.slot === target) selectWavetable(target);
      toast(`Wavetable "${wt.name || 'Wavetable'}" written to slot ${target} ✓`, 'ok');
    } catch (e) {
      toast('Wavetable substitution failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function clearWavetableSlot(slot) {
    const ok = await showModal('Clear wavetable slot',
      `<p>Clear slot ${slot}? The wavetable will be removed from the MicroFreak.</p>`,
      { okLabel: 'Clear' });
    if (!ok) return;
    setBusy(true, `Clearing wavetable slot ${slot}…`);
    try {
      await MF.clearWavetable(slot);
      delete state.wtData[slot];
      if (state.wavetables) state.wavetables[slot - 1] = await MF.readWavetableHeader(slot);
      renderWavetables();
      if (state.wtLastRender && state.wtLastRender.slot === slot) selectWavetable(slot);
      toast(`Wavetable slot ${slot} cleared ✓`, 'ok');
    } catch (e) {
      toast('Wavetable clear failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  async function exportAllWavetables() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.wavetables) await readWavetableInventory();
    const occupied = (state.wavetables || []).map((h, i) => h && !h.empty ? i + 1 : null).filter(Boolean);
    if (!occupied.length) return toast('No wavetables to export.', 'err');
    setBusy(true, 'Reading wavetables…');
    try {
      const files = [];
      for (const slot of occupied) {
        const wt = await MF.readWavetable(slot);
        if (wt.data) {
          files.push({
            name: `${String(slot).padStart(2, '0')}-${safeFile(wt.name)}.mfw`,
            dataB64: Mfp.bytesToB64(Mfp.serializeMfw({ name: wt.name, data: wt.data })),
          });
        }
      }
      const dir = await window.mfapi.exportFolder(files);
      if (dir) toast(`Exported ${files.length} wavetables to ${dir}`, 'ok');
    } catch (e) {
      toast('Wavetable export failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- samples

  async function readSampleInventory() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, 'Reading sample directory…');
    try {
      const out = [];
      for (let s = 1; s <= MF.SAMPLE_SLOTS; s++) out.push(await MF.readSampleHeader(s));
      state.samples = out;
      try {
        state.sampleStats = await MF.readSampleStats();
      } catch {
        state.sampleStats = null;
      }
      renderSamples();
      toast('Sample directory loaded ✓', 'ok');
    } catch (e) {
      toast('Sample read failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  function renderSamples() {
    const list = $('sm-list');
    if (!list) return;
    const items = state.samples || [];
    const occ = items.filter((h) => h && !h.empty).length;
    const count = $('sm-count');
    if (count) count.textContent = `(${occ}/128 used)`;
    const stats = state.sampleStats;
    if (stats) {
      const fill = $('sm-mem-fill');
      if (fill) fill.style.width = `${Math.min(100, (stats.usedMs / stats.capacityMs) * 100)}%`;
      const txt = $('sm-mem-text');
      if (txt) txt.textContent = `Used ${fmtMs(stats.usedMs)} / ${fmtMs(stats.capacityMs)} · free ${fmtMs(stats.freeMs)}`;
    }
    list.innerHTML = items.map((h, i) => {
      const slot = i + 1;
      const empty = !h || h.empty;
      const timeMs = h && h.sizeBytes ? h.sizeBytes / 64 : 0;
      return `<div class="sm-row ${empty ? 'empty' : ''}" data-slot="${slot}">
        <span class="sm-num">${slot}</span>
        <span class="sm-name">${empty ? '(empty)' : esc(h.name)}</span>
        <span class="sm-time">${empty ? '' : `${fmtMs(timeMs)} · ${(h.sizeBytes / 1024).toFixed(0)} KB`}</span>
        <span class="sm-cksum">${empty ? '' : '#' + h.checksum.toString(16).padStart(4, '0')}</span>
        <span class="sm-actions">
          <button class="btn small" data-sm="up" title="Substitute WAV / .mfsample">↻</button>
          ${empty ? '' : `<button class="btn small" data-sm="dl" title="Download .mfsample">⭳</button>
          <button class="btn small" data-sm="clear" title="Clear slot">✕</button>`}
        </span>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-sm]').forEach((btn) => {
      const slot = parseInt(btn.closest('.sm-row').dataset.slot, 10);
      btn.addEventListener('click', () => {
        const act = btn.dataset.sm;
        if (act === 'dl') readSampleToPC(slot);
        else if (act === 'up') importSampleIntoSlot(slot);
        else if (act === 'clear') clearSampleSlot(slot);
      });
    });
    // drag&drop: PC → dispositivo (upload) e dispositivo → PC (archivia)
    list.querySelectorAll('.sm-row').forEach((row) => {
      const slot = parseInt(row.dataset.slot, 10);
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        handleSmSelect(e, slot);
      });
      const h = items[slot - 1];
      if (h && !h.empty) {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          if (state.smSel.has(slot) && state.smSel.size > 1) {
            e.dataTransfer.setData('application/x-managefreak-sm-block', Array.from(state.smSel).sort((a, b) => a - b).join(','));
          }
          e.dataTransfer.setData('application/x-managefreak-sm-slot', String(slot));
          e.dataTransfer.setData('text/plain', String(slot));
          e.dataTransfer.effectAllowed = 'copyMove';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
      }
    });
    // drag&drop sul contenitore: upload da PC su uno slot, oppure riordino
    // device (swap al centro della riga, shift sui bordi)
    const clearSmHighlights = () => {
      list.querySelectorAll('.sm-row').forEach((r) =>
        r.classList.remove('swap-over', 'write-over', 'drop-before', 'drop-after'));
    };
    const resolveSmDrop = (clientY) => {
      const rows = Array.from(list.querySelectorAll('.sm-row'));
      if (!rows.length) return null;
      let hit = null;
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          const rel = (clientY - r.top) / r.height;
          let mode;
          if (rel < 0.3) mode = 'before';
          else if (rel > 0.7) mode = 'after';
          else mode = 'onto';
          hit = { slot: parseInt(row.dataset.slot, 10), mode };
          break;
        }
      }
      if (!hit) {
        hit = { slot: parseInt(rows[rows.length - 1].dataset.slot, 10), mode: 'after' };
        for (const row of rows) {
          const r = row.getBoundingClientRect();
          if (clientY < r.top) {
            hit = { slot: parseInt(row.dataset.slot, 10), mode: 'before' };
            break;
          }
        }
      }
      return hit;
    };
    const handleSmDrop = async (e, target) => {
      const idStr = e.dataTransfer.getData('application/x-managefreak-sm');
      if (idStr) {
        const entry = state.smLib.find((x) => x.id === idStr);
        if (!entry) return;
        // conferma sempre, identica ai preset
        const ok = await confirmSlotWrite({ name: entry.name, slot: target.slot });
        if (!ok) return;
        await uploadSampleEntryToSlot(entry, target.slot);
        return;
      }
      const block = e.dataTransfer.getData('application/x-managefreak-sm-block');
      const srcSlot = parseInt(e.dataTransfer.getData('application/x-managefreak-sm-slot'), 10);
      if (!srcSlot && !block) return;
      if (!block && srcSlot === target.slot) return;
      const moved = block
        ? block.split(',').map(Number)
        : (state.smSel.has(srcSlot) && state.smSel.size > 1 ? Array.from(state.smSel) : [srcSlot]);
      if (target.mode === 'onto' && moved.length === 1) {
        await moveSampleSelection(moved, target.slot, false, { swap: true });
      } else {
        await moveSampleSelection(moved, target.slot, target.mode === 'after');
      }
    };
    const smDragTypes = ['application/x-managefreak-sm', 'application/x-managefreak-sm-slot', 'application/x-managefreak-sm-block'];
    list.addEventListener('dragover', (e) => {
      if (!smDragTypes.some((t) => e.dataTransfer.types.includes(t))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = resolveSmDrop(e.clientY);
      if (!target) return;
      // Sample trascinato dalla LIBRERIA: sostituisce lo slot sotto il puntatore
      // → nessuna barretta, solo l'evidenziazione dello slot
      if (e.dataTransfer.types.includes('application/x-managefreak-sm')) {
        const row = list.querySelector(`.sm-row[data-slot="${target.slot}"]`);
        if (row) setDragIndicator(row, 'swap-over');
        return;
      }
      // stesso punto di inserimento → stessa indicazione: uso sempre "dopo la
      // riga sopra", tranne in testa alla lista dove non c'è una riga sopra
      const rows = Array.from(list.querySelectorAll('.sm-row'));
      const idx = rows.findIndex((r) => parseInt(r.dataset.slot, 10) === target.slot);
      const ind = (target.mode === 'before' && idx > 0)
        ? { slot: parseInt(rows[idx - 1].dataset.slot, 10), mode: 'after' }
        : target;
      const row = list.querySelector(`.sm-row[data-slot="${ind.slot}"]`);
      if (row) {
        setDragIndicator(row, ind.mode === 'onto' ? 'swap-over' : ind.mode === 'before' ? 'drop-before' : 'drop-after');
      }
    });
    list.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !list.contains(e.relatedTarget)) clearSmHighlights();
    });
    list.addEventListener('drop', async (e) => {
      if (!smDragTypes.some((t) => e.dataTransfer.types.includes(t))) return;
      e.preventDefault();
      clearSmHighlights();
      const target = resolveSmDrop(e.clientY);
      if (target) await handleSmDrop(e, target);
    });
    const pcList = $('sm-pc-list');
    if (pcList && !pcList.dataset.bound) {
      pcList.dataset.bound = '1';
      pcList.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types;
        if (types.includes('application/x-managefreak-sm-slot') || types.includes('application/x-managefreak-sm-block')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          pcList.classList.add('drop-target');
        }
      });
      pcList.addEventListener('dragleave', () => pcList.classList.remove('drop-target'));
      pcList.addEventListener('drop', (e) => {
        e.preventDefault();
        pcList.classList.remove('drop-target');
        const block = e.dataTransfer.getData('application/x-managefreak-sm-block');
        if (block) {
          importSmSelectionToPc();
          return;
        }
        const slotStr = e.dataTransfer.getData('application/x-managefreak-sm-slot');
        if (slotStr) readSampleSlotToPc(parseInt(slotStr, 10));
      });
    }
  }

  async function readSampleToPC(slot) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Reading sample slot ${slot}…`);
    try {
      const s = await MF.readSample(slot);
      if (!s.data) return toast(`Sample slot ${slot} is empty.`, 'err');
      const bytes = Mfp.serializeMsample(s.raw, s.data);
      await window.mfapi.saveFile({
        defaultName: `${String(slot).padStart(3, '0')}-${safeFile(s.name)}.mfsample`,
        data: Mfp.bytesToB64(bytes),
        filters: [{ name: 'MicroFreak sample backup', extensions: ['mfsample'] }],
      });
    } catch (e) {
      toast('Sample read failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  async function importSampleIntoSlot(slot) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    let target = slot;
    if (target === null || target === undefined) {
      const free = (state.samples || []).findIndex((h) => !h || h.empty);
      if (free < 0) return toast('No free sample slots.', 'err');
      target = free + 1;
    }
    const files = await window.mfapi.openFiles({
      filters: [
        { name: 'WAV / .mfsample', extensions: ['wav', 'mfsample'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!files || !files.length) return;
    const f = files[0];
    const bytes = Mfp.b64ToBytes(f.data);
    const ext = f.name.split('.').pop().toLowerCase();
    let name;
    let data;
    try {
      if (ext === 'wav') {
        const s = Mfp.wavToSample(bytes, f.name.replace(/\.[^.]+$/, ''));
        name = s.name;
        data = s.data;
      } else if (ext === 'mfsample') {
        const m = Mfp.parseMsample(bytes);
        name = (m.header && Array.from(m.header.subarray(10, 22)).filter((c) => c > 0).map((c) => String.fromCharCode(c)).join('')) || 'Sample';
        data = m.data;
        if (data.length < 2 || data.length > MF.SAMPLE_MAX_BYTES) {
          throw new Error('Sample must be 2..' + MF.SAMPLE_MAX_BYTES + ' bytes');
        }
      } else {
        throw new Error('Unsupported extension: .' + ext);
      }
    } catch (e) {
      return toast('Import failed: ' + (e.message || e), 'err', 6000);
    }
    setBusy(true, `Substituting sample in slot ${target}…`);
    setProgress(0, 'Substituting sample…');
    try {
      await MF.writeSample(target, name, data, {
        onProgress: (frac, label) => setProgress(frac, label),
      });
      delete state.smData[target];
      if (state.samples) state.samples[target - 1] = await MF.readSampleHeader(target);
      try {
        state.sampleStats = await MF.readSampleStats();
      } catch {
        /* stats non disponibili */
      }
      renderSamples();
      if (state.smLastRender && state.smLastRender.slot === target) selectSample(target);
      toast(`Sample "${name}" written to slot ${target} ✓`, 'ok');
    } catch (e) {
      toast('Sample substitution failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function clearSampleSlot(slot) {
    const ok = await showModal('Clear sample slot',
      `<p>Clear slot ${slot}? The sample will be removed from the MicroFreak memory.</p>`,
      { okLabel: 'Clear' });
    if (!ok) return;
    setBusy(true, `Clearing sample slot ${slot}…`);
    try {
      await MF.clearSample(slot);
      delete state.smData[slot];
      if (state.samples) state.samples[slot - 1] = await MF.readSampleHeader(slot);
      try {
        state.sampleStats = await MF.readSampleStats();
      } catch {
        /* stats non disponibili */
      }
      renderSamples();
      if (state.smLastRender && state.smLastRender.slot === slot) selectSample(slot);
      toast(`Sample slot ${slot} cleared ✓`, 'ok');
    } catch (e) {
      toast('Sample clear failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  async function exportAllSamples() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.samples) await readSampleInventory();
    const occupied = (state.samples || []).map((h, i) => h && !h.empty ? i + 1 : null).filter(Boolean);
    if (!occupied.length) return toast('No samples to export.', 'err');
    setBusy(true, 'Reading samples…');
    try {
      const files = [];
      for (const slot of occupied) {
        const s = await MF.readSample(slot);
        if (s.data) {
          files.push({
            name: `${String(slot).padStart(3, '0')}-${safeFile(s.name)}.mfsample`,
            dataB64: Mfp.bytesToB64(Mfp.serializeMsample(s.raw, s.data)),
          });
        }
      }
      const dir = await window.mfapi.exportFolder(files);
      if (dir) toast(`Exported ${files.length} samples to ${dir}`, 'ok');
    } catch (e) {
      toast('Sample export failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- device settings

  function renderDeviceView(values) {
    const left = $('dev-col-left');
    const right = $('dev-col-right');
    const build = (col) => DEVICE_SETTINGS.filter(([, , c]) => c === col).map(([name, label]) => {
      const spec = MF.GLOBAL_SPECS[name];
      if (!spec) return '';
      const cur = values ? values[name] : null;
      const opts = spec.values.map((v) =>
        `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(spec.label(v))}</option>`).join('');
      return `<div class="dev-row" data-global="${name}">
        <label title="${name}">${label}</label>
        <select data-global="${name}">${opts}</select>
      </div>`;
    }).join('');
    left.innerHTML = build('left');
    right.innerHTML = build('right');
    document.querySelectorAll('#dev-cols select[data-global]').forEach((sel) => {
      sel.addEventListener('change', () => applyGlobal(sel.dataset.global, parseInt(sel.value, 10), sel));
    });
  }

  async function loadDeviceGlobals({ quiet = false } = {}) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!quiet) setBusy(true, 'Reading device settings…');
    try {
      const codes = DEVICE_SETTINGS.map(([name]) => MF.GLOBAL_CODES[name]);
      const raw = await MF.readGlobalCodes(codes);
      const values = {};
      DEVICE_SETTINGS.forEach(([name], i) => { values[name] = raw[codes[i]]; });
      state.deviceGlobals = values;
      renderDeviceView(values);
      if (!quiet) toast('Device settings loaded ✓', 'ok');
    } catch (e) {
      toast('Device settings read failed: ' + (e.message || e), 'err', 6000);
    } finally {
      if (!quiet) setBusy(false);
    }
  }

  async function applyGlobal(name, value, sel) {
    try {
      await MF.writeGlobalSetting(name, value);
      if (state.deviceGlobals) state.deviceGlobals[name] = value;
      sel.classList.remove('dirty');
      toast(`${name} set to ${MF.globalLabel(name, value)} ✓`, 'ok');
    } catch (e) {
      toast('Setting failed: ' + (e.message || e), 'err', 6000);
      try {
        const v = await MF.readGlobalCode(MF.GLOBAL_CODES[name]);
        sel.value = String(v);
        sel.classList.remove('dirty');
      } catch {
        /* mantieni il valore corrente */
      }
    }
  }

  async function applyAllDeviceGlobals() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    const selects = Array.from(document.querySelectorAll('#dev-cols select[data-global]'));
    if (!selects.length) return;
    setBusy(true, 'Applying device settings…');
    let done = 0;
    let failed = 0;
    try {
      for (const sel of selects) {
        const name = sel.dataset.global;
        const value = parseInt(sel.value, 10);
        const current = state.deviceGlobals ? state.deviceGlobals[name] : null;
        if (current !== null && current !== value) {
          try {
            await MF.writeGlobalSetting(name, value);
            if (state.deviceGlobals) state.deviceGlobals[name] = value;
            sel.classList.remove('dirty');
          } catch {
            failed++;
          }
        }
        done++;
        setProgress(done / selects.length, `Setting ${name}…`);
      }
      toast(`Applied ${done - failed} of ${done} settings${failed ? `, ${failed} failed` : ''} ✓`, 'ok', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // ---------------------------------------------------------------- render wavetable (vista Arturia)

  /** Colori del canvas: il canvas non eredita le variabili CSS, quindi li scelgo
   *  in base al tema. I valori del tema scuro restano quelli di sempre. */
  function canvasColors() {
    const light = document.documentElement.dataset.theme === 'light';
    return light
      // su fondo bianco i cicli in coda servono un po' piu' di opacita'
      ? { text: '#6d6d7d', highlight: '#c9761f', ribbon: '70, 130, 200', alpha0: 0.38, alphaSpan: 0.55, wave: '#2ea867' }
      : { text: '#8a8a9a', highlight: '#ffb454', ribbon: '96, 175, 235', alpha0: 0.22, alphaSpan: 0.62, wave: 'rgba(96, 210, 160, 0.9)' };
  }

  function drawWavetable(canvas, data, highlightCycle) {
    const ctx = canvas.getContext('2d');
    const C = canvasColors();
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!data || data.length < 512) {
      ctx.fillStyle = C.text;
      ctx.font = '13px sans-serif';
      ctx.fillText(data ? 'No wavetable data' : 'Loading preview…', 12, 20);
      return;
    }
    let min = 32767;
    let max = -32768;
    for (let i = 0; i + 1 < data.length; i += 2) {
      const s = (data[i] | (data[i + 1] << 8)) << 16 >> 16;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    const range = Math.max(1, max - min);
    const cycles = 32;
    const samples = 256;
    const horizonY = H * 0.5;
    const hc = (highlightCycle === undefined || highlightCycle === null) ? 0 : highlightCycle % cycles;
    // ribbon prospettico: cicli dietro (piccoli, in alto) → davanti (grandi, in basso)
    for (let c = 0; c < cycles; c++) {
      const t = c / (cycles - 1);
      const depth = 0.5 + 0.5 * t;
      const amp = (H * 0.22) * depth;
      const yBase = horizonY + (c - (cycles - 1) / 2) * (H * 0.02) * depth;
      const xPad = (W * 0.04) * (1 - depth);
      ctx.beginPath();
      for (let j = 0; j < samples; j++) {
        const idx = (c * samples + j) * 2;
        const s = (data[idx] | (data[idx + 1] << 8)) << 16 >> 16;
        const norm = (s - min) / range - 0.5;
        const x = xPad + (j / (samples - 1)) * (W - 2 * xPad);
        const y = yBase - norm * amp;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const isHl = c === hc;
      ctx.strokeStyle = isHl ? C.highlight : `rgba(${C.ribbon}, ${C.alpha0 + C.alphaSpan * t})`;
      ctx.lineWidth = isHl ? 2.4 : 1.2;
      ctx.stroke();
    }
  }

  function drawSampleWave(canvas, data) {
    const ctx = canvas.getContext('2d');
    const C = canvasColors();
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!data || data.length < 4) {
      ctx.fillStyle = C.text;
      ctx.font = '12px sans-serif';
      ctx.fillText(data ? 'No sample data' : 'Loading preview…', 12, 20);
      return;
    }
    const mid = H / 2;
    const px = Math.max(1, Math.floor(data.length / 2 / W));
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      let mn = 32767;
      let mx = -32768;
      const start = Math.min(data.length - 1, x * px * 2);
      const end = Math.min(data.length - 1, start + px * 2);
      for (let i = start; i < end; i += 2) {
        const s = (data[i] | (data[i + 1] << 8)) << 16 >> 16;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      const y0 = mid - (mx / 32768) * (H * 0.45);
      const y1 = mid - (mn / 32768) * (H * 0.45);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.strokeStyle = C.wave;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Dettagli wavetable nel pannello in basso (con render piccolo e rename). */
  function showWtDetail({ name, data, slot, libId, source }) {
    state.wtLastRender = { data, name, slot: slot || null, libId: libId || null };
    const actions = [];
    if (slot) {
      actions.push({ id: 'dl', label: '⭳ Download .mfw', run: () => readWavetableToPC(slot) });
      actions.push({ id: 'clear', label: '✕ Clear', run: () => clearWavetableSlot(slot).then(() => showDetailEmpty()) });
    } else if (libId) {
      actions.push({ id: 'dl', label: '⭳ Download .mfw', run: () => downloadWavetableEntry(libId) });
      actions.push({ id: 'send', label: '➡ Send to MicroFreak', run: () => sendWavetableToDevice(libId) });
      actions.push({ id: 'del', label: '✕ Remove from PC', run: () => { deleteWavetableFromLib(libId); showDetailEmpty(); } });
    }
    let extraHtml = null;
    if (libId) {
      const entry = state.wtLib.find((e) => e.id === libId);
      const collOpts = ['<option value="">— No folder —</option>'];
      for (const c of state.wtCols) {
        collOpts.push(`<option value="${c.id}" ${entry && entry.collectionId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`);
      }
      extraHtml = `<div class="detail-coll"><label>Library</label><select id="wt-detail-coll">${collOpts.join('')}</select></div>`;
    }
    renderDetail({
      name,
      metaRows: [
        ['Source', source || '—'],
        ['Size', '16 KB (32 cycles × 256 × 16-bit)'],
      ],
      tags: [],
      tagInput: null,
      notes: null,
      actions,
      extraHtml,
      params: [],
      hideParams: true,
      sideHtml: `<div class="detail-render-box">
        <div class="render-head">
          <span>Wavetable preview</span>
          <label class="cycle-slider-small">Cycle
            <input id="wt-detail-cycle" type="range" min="1" max="32" value="1" />
            <span id="wt-detail-cycle-val">1</span>/32
          </label>
        </div>
        <canvas id="wt-detail-canvas" width="460" height="180"></canvas>
      </div>`,
      onRename: (newName) => {
        if (slot) return renameWavetableDetail(slot, newName);
        if (libId) return renameWavetableLibEntry(libId, newName);
        return true;
      },
    });
    const collSel = $('wt-detail-coll');
    if (collSel) {
      collSel.addEventListener('change', () => {
        const v = collSel.value;
        moveWtEntryToCollection(libId, v ? parseInt(v, 10) : null);
        _showWtLibDetail(libId);
      });
    }
    const canvas = $('wt-detail-canvas');
    if (canvas) {
      drawWavetable(canvas, data, 0);
      const slider = $('wt-detail-cycle');
      if (slider) {
        slider.addEventListener('input', () => {
          const val = $('wt-detail-cycle-val');
          if (val) val.textContent = slider.value;
          drawWavetable(canvas, data, parseInt(slider.value, 10) - 1);
        });
      }
    }
  }

  /** Dettagli sample nel pannello in basso (con forma d'onda e rename). */
  function showSmDetail({ name, data, slot, libId, source, sizeBytes, durationMs, checksum }) {
    state.smLastRender = { slot: slot || null, libId: libId || null };
    const actions = [];
    if (slot) {
      actions.push({ id: 'dl', label: '⭳ Download .mfsample', run: () => readSampleToPC(slot) });
      actions.push({ id: 'clear', label: '✕ Clear', run: () => clearSampleSlot(slot).then(() => showDetailEmpty()) });
    } else if (libId) {
      actions.push({ id: 'dl', label: '⭳ Download .mfsample', run: () => downloadSampleEntry(libId) });
      actions.push({ id: 'send', label: '➡ Send to MicroFreak', run: () => sendSampleToDevice(libId) });
      actions.push({ id: 'del', label: '✕ Remove from PC', run: () => { deleteSampleFromLib(libId); showDetailEmpty(); } });
    }
    let extraHtml = null;
    if (libId) {
      const entry = state.smLib.find((e) => e.id === libId);
      const collOpts = ['<option value="">— No folder —</option>'];
      for (const c of state.smCols) {
        collOpts.push(`<option value="${c.id}" ${entry && entry.collectionId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`);
      }
      extraHtml = `<div class="detail-coll"><label>Library</label><select id="sm-detail-coll">${collOpts.join('')}</select></div>`;
    }
    renderDetail({
      name,
      metaRows: [
        ['Source', source || '—'],
        ['Size', `${sizeBytes ? (sizeBytes / 1024).toFixed(1) : 0} KB`],
        ['Duration', durationMs ? fmtMs(durationMs) : '—'],
        ...(checksum !== undefined && checksum !== null ? [['Checksum', '#' + checksum.toString(16).padStart(4, '0')]] : []),
      ],
      tags: [],
      tagInput: null,
      notes: null,
      actions,
      extraHtml,
      params: [],
      hideParams: true,
      sideHtml: `<div class="detail-render-box">
        <div class="render-head"><span>Sample preview</span></div>
        <canvas id="sm-detail-wave" width="460" height="180"></canvas>
      </div>`,
      onRename: (newName) => {
        if (slot) return renameSampleDetail(slot, newName);
        if (libId) return renameSampleLibEntry(libId, newName);
        return true;
      },
    });
    const collSel = $('sm-detail-coll');
    if (collSel) {
      collSel.addEventListener('change', () => {
        const v = collSel.value;
        moveSmEntryToCollection(libId, v ? parseInt(v, 10) : null);
        _showSmLibDetail(libId);
      });
    }
    const wave = $('sm-detail-wave');
    if (wave) drawSampleWave(wave, data);
  }

  /** Seleziona uno slot wavetable del dispositivo: dettagli subito, preview in background. */
  async function selectWavetable(slot) {
    const token = ++state.wtReadToken;
    const cached = state.wtData[slot];
    if (cached) {
      showWtDetail({ name: cached.name, data: cached.data, slot, source: `MicroFreak slot ${slot}` });
      return;
    }
    const header = state.wavetables && state.wavetables[slot - 1];
    // dettagli immediati dall'header già in memoria
    showWtDetail({ name: header ? header.name : 'Wavetable', data: null, slot, source: `MicroFreak slot ${slot}` });
    // corpo in background; una selezione più recente cancella questa lettura
    try {
      const wt = await MF.readWavetable(slot, {
        shouldCancel: () => token !== state.wtReadToken,
      });
      if (token !== state.wtReadToken) return;
      if (!wt.data) {
        showDetailEmpty();
        return;
      }
      state.wtData[slot] = { name: wt.name, data: wt.data };
      if (token === state.wtReadToken) {
        showWtDetail({ name: wt.name, data: wt.data, slot, source: `MicroFreak slot ${slot}` });
      }
    } catch (e) {
      if (token !== state.wtReadToken) return; // lettura superata da una più recente
      toast('Wavetable read failed: ' + (e.message || e), 'err', 6000);
    }
  }

  /** Dettagli di una wavetable della libreria PC (senza dispositivo). */
  function renderWavetableFromLib(id) {
    if (state.wtLibSel === id) {
      // click sulla stessa voce già selezionata → deseleziona
      state.wtLibSel = null;
      document.querySelectorAll('#wt-pc-list .pc-item').forEach((item) => item.classList.remove('selected'));
      document.querySelectorAll('#wt-lib-list .cat-item').forEach((row) => row.classList.remove('selected'));
      showDetailEmpty();
      return;
    }
    const entry = state.wtLib.find((e) => e.id === id);
    if (!entry) return;
    state.wtLibSel = id;
    document.querySelectorAll('#wt-pc-list .pc-item').forEach((item) => {
      item.classList.toggle('selected', String(item.dataset.id) === String(id));
    });
    _showWtLibDetail(id);
  }

  function _showWtLibDetail(id) {
    const entry = state.wtLib.find((e) => e.id === id);
    if (!entry) return;
    showWtDetail({ name: entry.name, data: Mfp.b64ToBytes(entry.dataB64), libId: id, source: entry.source || 'PC library' });
  }

  /** Seleziona uno slot sample del dispositivo: dettagli subito, preview in background. */
  async function selectSample(slot) {
    const token = ++state.sampleReadToken;
    const cached = state.smData[slot];
    if (cached) {
      showSmDetail({
        name: cached.name, data: cached.data, slot,
        source: `MicroFreak slot ${slot}`,
        sizeBytes: cached.sizeBytes,
        durationMs: Math.round((cached.sizeBytes / 2 / 32000) * 1000),
        checksum: cached.checksum,
      });
      return;
    }
    const header = state.samples && state.samples[slot - 1];
    // dettagli immediati dall'header già in memoria
    showSmDetail({
      name: header ? header.name : 'Sample', data: null, slot,
      source: `MicroFreak slot ${slot}`,
      sizeBytes: header ? header.sizeBytes : 0,
      durationMs: header ? Math.round((header.sizeBytes / 2 / 32000) * 1000) : 0,
      checksum: header ? header.checksum : null,
    });
    // corpo in background; una selezione più recente cancella questa lettura
    try {
      const s = await MF.readSample(slot, {
        shouldCancel: () => token !== state.sampleReadToken,
      });
      if (token !== state.sampleReadToken) return;
      if (!s.data) {
        showDetailEmpty();
        return;
      }
      state.smData[slot] = { name: s.name, sizeBytes: s.sizeBytes, checksum: s.checksum, data: s.data };
      if (token === state.sampleReadToken) {
        showSmDetail({
          name: s.name, data: s.data, slot,
          source: `MicroFreak slot ${slot}`,
          sizeBytes: s.sizeBytes,
          durationMs: Math.round((s.sizeBytes / 2 / 32000) * 1000),
          checksum: s.checksum,
        });
      }
    } catch (e) {
      if (token !== state.sampleReadToken) return; // lettura superata da una più recente
      toast('Sample read failed: ' + (e.message || e), 'err', 6000);
    }
  }

  /** Dettagli di un sample della libreria PC. */
  function renderSampleFromLib(id) {
    if (state.smLibSel === id) {
      // click sulla stessa voce già selezionata → deseleziona
      state.smLibSel = null;
      document.querySelectorAll('#sm-pc-list .pc-item').forEach((item) => item.classList.remove('selected'));
      document.querySelectorAll('#sm-lib-list .cat-item').forEach((row) => row.classList.remove('selected'));
      showDetailEmpty();
      return;
    }
    const entry = state.smLib.find((e) => e.id === id);
    if (!entry) return;
    state.smLibSel = id;
    document.querySelectorAll('#sm-pc-list .pc-item').forEach((item) => {
      item.classList.toggle('selected', String(item.dataset.id) === String(id));
    });
    _showSmLibDetail(id);
  }

  function _showSmLibDetail(id) {
    const entry = state.smLib.find((e) => e.id === id);
    if (!entry) return;
    showSmDetail({
      name: entry.name,
      data: Mfp.b64ToBytes(entry.dataB64),
      libId: id,
      source: entry.source || 'PC library',
      sizeBytes: entry.sizeBytes,
      durationMs: entry.durationMs,
    });
  }

  async function renameWavetableDetail(slot, newName) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Renaming wavetable slot ${slot}…`);
    try {
      await MF.renameWavetable(slot, (newName || 'Wavetable').slice(0, 15));
      delete state.wtData[slot];
      if (state.wavetables) state.wavetables[slot - 1] = await MF.readWavetableHeader(slot);
      renderWavetables();
      selectWavetable(slot);
      toast(`Wavetable renamed to "${newName}" ✓`, 'ok');
      return (state.wavetables && state.wavetables[slot - 1] && state.wavetables[slot - 1].name) || true;
    } catch (e) {
      toast('Rename failed: ' + (e.message || e), 'err', 6000);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function renameWavetableLibEntry(id, newName) {
    const entry = state.wtLib.find((e) => e.id === id);
    if (!entry) return;
    entry.name = (newName || 'Wavetable').slice(0, 15);
    saveWavetableLib();
    renderWavetableSidebar();
    renderWavetablePc();
    _showWtLibDetail(id);
  }

  async function renameSampleDetail(slot, newName) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Renaming sample slot ${slot}…`);
    try {
      await MF.renameSample(slot, (newName || 'Sample').slice(0, 12));
      delete state.smData[slot];
      if (state.samples) state.samples[slot - 1] = await MF.readSampleHeader(slot);
      renderSamples();
      selectSample(slot);
      toast(`Sample renamed to "${newName}" ✓`, 'ok');
      return (state.samples && state.samples[slot - 1] && state.samples[slot - 1].name) || true;
    } catch (e) {
      toast('Rename failed: ' + (e.message || e), 'err', 6000);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function renameSampleLibEntry(id, newName) {
    const entry = state.smLib.find((e) => e.id === id);
    if (!entry) return;
    entry.name = (newName || 'Sample').slice(0, 12);
    saveSampleLib();
    renderSampleSidebar();
    renderSamplePc();
    _showSmLibDetail(id);
  }

  // ---------------------------------------------------------------- multi-selezione wavetable/sample

  function handleWtSelect(e, slot) {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    if (ctrl) {
      if (state.wtSel.has(slot)) state.wtSel.delete(slot);
      else {
        state.wtSel.add(slot);
        state.wtSelAnchor = slot;
      }
    } else if (shift) {
      const anchor = state.wtSelAnchor !== null && state.wtSel.has(state.wtSelAnchor) ? state.wtSelAnchor : slot;
      const [a, b] = anchor < slot ? [anchor, slot] : [slot, anchor];
      state.wtSel.clear();
      for (let s = a; s <= b; s++) state.wtSel.add(s);
    } else {
      if (state.wtSel.has(slot)) {
        // click su uno slot già selezionato → deseleziona
        state.wtSel.clear();
        state.wtSelAnchor = null;
      } else {
        state.wtSel.clear();
        state.wtSel.add(slot);
        state.wtSelAnchor = slot;
      }
    }
    updateWtSelectionUI();
  }

  function handleSmSelect(e, slot) {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    if (ctrl) {
      if (state.smSel.has(slot)) state.smSel.delete(slot);
      else {
        state.smSel.add(slot);
        state.smSelAnchor = slot;
      }
    } else if (shift) {
      const anchor = state.smSelAnchor !== null && state.smSel.has(state.smSelAnchor) ? state.smSelAnchor : slot;
      const [a, b] = anchor < slot ? [anchor, slot] : [slot, anchor];
      state.smSel.clear();
      for (let s = a; s <= b; s++) state.smSel.add(s);
    } else {
      if (state.smSel.has(slot)) {
        // click su uno slot già selezionato → deseleziona
        state.smSel.clear();
        state.smSelAnchor = null;
      } else {
        state.smSel.clear();
        state.smSel.add(slot);
        state.smSelAnchor = slot;
      }
    }
    updateSmSelectionUI();
  }

  function updateWtSelectionUI() {
    document.querySelectorAll('#wt-list .wt-row').forEach((r) => {
      r.classList.toggle('selected', state.wtSel.has(parseInt(r.dataset.slot, 10)));
    });
    const ids = Array.from(state.wtSel).sort((a, b) => a - b);
    if (!ids.length) showDetailEmpty();
    else if (ids.length === 1) selectWavetable(ids[0]);
    else showWtMultiDetail(ids);
  }

  function updateSmSelectionUI() {
    document.querySelectorAll('#sm-list .sm-row').forEach((r) => {
      r.classList.toggle('selected', state.smSel.has(parseInt(r.dataset.slot, 10)));
    });
    const ids = Array.from(state.smSel).sort((a, b) => a - b);
    if (!ids.length) showDetailEmpty();
    else if (ids.length === 1) selectSample(ids[0]);
    else showSmMultiDetail(ids);
  }

  function clearWtSelectionUi() {
    state.wtSel.clear();
    state.wtSelAnchor = null;
    updateWtSelectionUI();
  }

  function clearSmSelectionUi() {
    state.smSel.clear();
    state.smSelAnchor = null;
    updateSmSelectionUI();
  }

  function showWtMultiDetail(slots) {
    renderDetail({
      name: `${slots.length} wavetables selected`,
      metaRows: [['Slots', slots.join(', ')]],
      tags: [],
      tagInput: null,
      notes: null,
      actions: [
        { id: 'read', label: '⬅ Import to PC library', run: () => importWtSelectionToPc() },
        { id: 'clear', label: '✕ Clear', run: () => clearWtSelection() },
        { id: 'deselect', label: 'Deselect', run: () => clearWtSelectionUi() },
      ],
      params: [],
      hideParams: true,
    });
  }

  function showSmMultiDetail(slots) {
    renderDetail({
      name: `${slots.length} samples selected`,
      metaRows: [['Slots', slots.join(', ')]],
      tags: [],
      tagInput: null,
      notes: null,
      actions: [
        { id: 'read', label: '⬅ Import to PC library', run: () => importSmSelectionToPc() },
        { id: 'clear', label: '✕ Clear', run: () => clearSmSelection() },
        { id: 'deselect', label: 'Deselect', run: () => clearSmSelectionUi() },
      ],
      params: [],
      hideParams: true,
    });
  }

  async function importWtSelectionToPc() {
    const slots = Array.from(state.wtSel).sort((a, b) => a - b);
    if (!slots.length) return;
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, 'Importing wavetables…');
    let added = 0;
    try {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const wt = await MF.readWavetable(slot);
        if (wt.data) {
          state.wtLib.push({
            id: _libId(),
            name: (wt.name || 'Wavetable').slice(0, 15),
            dataB64: Mfp.bytesToB64(wt.data),
            collectionId: wtTargetCollection(),
            addedAt: Date.now(),
            source: `MicroFreak slot ${slot}`,
          });
          added++;
        }
        setProgress((i + 1) / slots.length, `Wavetables ${i + 1}/${slots.length}`);
      }
      await saveWavetableLib();
      renderWavetableSidebar();
      renderWavetablePc();
      toast(`Imported ${added} wavetable${added === 1 ? '' : 's'} to the PC library ✓`, 'ok');
    } catch (e) {
      toast('Import failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function importSmSelectionToPc() {
    const slots = Array.from(state.smSel).sort((a, b) => a - b);
    if (!slots.length) return;
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, 'Importing samples…');
    let added = 0;
    try {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const s = await MF.readSample(slot);
        if (s.data) {
          state.smLib.push({
            id: _libId(),
            name: (s.name || 'Sample').slice(0, 12),
            dataB64: Mfp.bytesToB64(s.data),
            sizeBytes: s.sizeBytes,
            durationMs: Math.round((s.sizeBytes / 2 / 32000) * 1000),
            collectionId: smTargetCollection(),
            addedAt: Date.now(),
            source: `MicroFreak slot ${slot}`,
          });
          added++;
        }
        setProgress((i + 1) / slots.length, `Samples ${i + 1}/${slots.length}`);
      }
      await saveSampleLib();
      renderSampleSidebar();
      renderSamplePc();
      toast(`Imported ${added} sample${added === 1 ? '' : 's'} to the PC library ✓`, 'ok');
    } catch (e) {
      toast('Import failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function clearWtSelection() {
    const slots = Array.from(state.wtSel).sort((a, b) => a - b);
    if (!slots.length) return;
    const ok = await showModal('Clear wavetables',
      `<p>Clear ${slots.length} wavetable slot${slots.length === 1 ? '' : 's'} on the MicroFreak?</p>`,
      { okLabel: 'Clear' });
    if (!ok) return;
    setBusy(true, 'Clearing wavetables…');
    let failed = 0;
    try {
      for (let i = 0; i < slots.length; i++) {
        try {
          await MF.clearWavetable(slots[i]);
          delete state.wtData[slots[i]];
        } catch {
          failed++;
        }
        setProgress((i + 1) / slots.length, `Slots ${i + 1}/${slots.length}`);
      }
      if (state.wavetables) {
        for (const s of slots) state.wavetables[s - 1] = await MF.readWavetableHeader(s);
      }
      renderWavetables();
      clearWtSelectionUi();
      toast(`Cleared ${slots.length - failed} wavetable slot${slots.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''} ✓`, 'ok');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function clearSmSelection() {
    const slots = Array.from(state.smSel).sort((a, b) => a - b);
    if (!slots.length) return;
    const ok = await showModal('Clear samples',
      `<p>Clear ${slots.length} sample slot${slots.length === 1 ? '' : 's'} on the MicroFreak?</p>`,
      { okLabel: 'Clear' });
    if (!ok) return;
    setBusy(true, 'Clearing samples…');
    let failed = 0;
    try {
      for (let i = 0; i < slots.length; i++) {
        try {
          await MF.clearSample(slots[i]);
          delete state.smData[slots[i]];
        } catch {
          failed++;
        }
        setProgress((i + 1) / slots.length, `Slots ${i + 1}/${slots.length}`);
      }
      if (state.samples) {
        for (const s of slots) state.samples[s - 1] = await MF.readSampleHeader(s);
      }
      try {
        state.sampleStats = await MF.readSampleStats();
      } catch {
        /* stats non disponibili */
      }
      renderSamples();
      clearSmSelectionUi();
      toast(`Cleared ${slots.length - failed} sample slot${slots.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''} ✓`, 'ok');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // ---------------------------------------------------------------- riordino device wavetable/sample

  async function moveWavetableSelection(moved, targetSlot, after, { swap = false } = {}) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.wavetables) return;
    const occupied = state.wavetables.map((h, i) => h && !h.empty ? i + 1 : null).filter(Boolean);
    const validMoved = moved.filter((s) => occupied.includes(s));
    if (!validMoved.length) return toast('The selected slots do not contain wavetables.', 'err');
    let writes;
    if (swap) {
      if (validMoved.length !== 1 || !occupied.includes(targetSlot)) return toast('Swap requires two occupied slots.', 'err');
      const a = validMoved[0];
      const b = targetSlot;
      writes = [{ from: a, to: b }, { from: b, to: a }];
    } else {
      const plan = Shift.planShift(occupied, validMoved, targetSlot, after);
      writes = plan.writes;
    }
    if (!writes.length) return;
    const movedNames = validMoved.map((s) => (state.wavetables[s - 1] && state.wavetables[s - 1].name) || `slot ${s}`);
    const targetName = occupied.includes(targetSlot)
      ? (state.wavetables[targetSlot - 1] && state.wavetables[targetSlot - 1].name) || `slot ${targetSlot}`
      : `empty slot ${targetSlot}`;
    const yes = await showModal(
      swap ? `Swap wavetables?` : `Move ${validMoved.length} wavetable${validMoved.length === 1 ? '' : 's'}?`,
      swap
        ? `<p><strong>${esc(movedNames[0])}</strong> (slot ${validMoved[0]}) ⇄ <strong>${esc(targetName)}</strong> (slot ${targetSlot})</p>
           <p class="muted" style="font-size:12px">One-to-one swap with backup, verification and automatic rollback.</p>`
        : `<p><strong>${validMoved.length} wavetable${validMoved.length === 1 ? '' : 's'}</strong> will be moved:
             <strong>${esc(movedNames.join(', '))}</strong></p>
           <p>Position: <strong>${after ? 'after' : 'before'} "${esc(targetName)}"</strong>.</p>
           <p class="muted" style="font-size:12px">The other wavetables will be shifted accordingly.
             All involved wavetables are read as backups and restored on error. This may take a while.</p>`,
      { okLabel: swap ? 'Swap' : 'Move & shift' }
    );
    if (!yes) return;
    setBusy(true, 'Reading the involved wavetables…');
    setProgress(0, 'Reordering…');
    try {
      await MF.reorderWavetables(writes, validMoved, {
        onProgress: (frac, label) => setProgress(frac, label),
      });
      for (let s = 1; s <= MF.WAVE_SLOTS; s++) {
        if (state.wavetables) state.wavetables[s - 1] = await MF.readWavetableHeader(s);
      }
      // i corpi si sono spostati di slot: senza invalidare la cache l'anteprima
      // di uno slot riletto mostrerebbe ancora la forma d'onda precedente
      if (state.wtData) {
        for (const w of writes) { delete state.wtData[w.from]; delete state.wtData[w.to]; }
      }
      state.wtSel.clear();
      state.wtSelAnchor = null;
      renderWavetables();
      toast(`${swap ? 'Swapped' : 'Moved'} ${validMoved.length} wavetable${validMoved.length === 1 ? '' : 's'} ✓`, 'ok');
    } catch (e) {
      toast('Wavetable move failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function moveSampleSelection(moved, targetSlot, after, { swap = false } = {}) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    if (!state.samples) return;
    const occupied = state.samples.map((h, i) => h && !h.empty ? i + 1 : null).filter(Boolean);
    const validMoved = moved.filter((s) => occupied.includes(s));
    if (!validMoved.length) return toast('The selected slots do not contain samples.', 'err');
    let writes;
    if (swap) {
      if (validMoved.length !== 1 || !occupied.includes(targetSlot)) return toast('Swap requires two occupied slots.', 'err');
      const a = validMoved[0];
      const b = targetSlot;
      writes = [{ from: a, to: b }, { from: b, to: a }];
    } else {
      const plan = Shift.planShift(occupied, validMoved, targetSlot, after);
      writes = plan.writes;
    }
    if (!writes.length) return;
    const movedNames = validMoved.map((s) => (state.samples[s - 1] && state.samples[s - 1].name) || `slot ${s}`);
    const targetName = occupied.includes(targetSlot)
      ? (state.samples[targetSlot - 1] && state.samples[targetSlot - 1].name) || `slot ${targetSlot}`
      : `empty slot ${targetSlot}`;
    const yes = await showModal(
      swap ? `Swap samples?` : `Move ${validMoved.length} sample${validMoved.length === 1 ? '' : 's'}?`,
      swap
        ? `<p><strong>${esc(movedNames[0])}</strong> (slot ${validMoved[0]}) ⇄ <strong>${esc(targetName)}</strong> (slot ${targetSlot})</p>
           <p class="muted" style="font-size:12px">One-to-one swap: only the directory entries are rewritten,
             the audio bodies never move. Backup, verification and automatic rollback included.</p>`
        : `<p><strong>${validMoved.length} sample${validMoved.length === 1 ? '' : 's'}</strong> will be moved:
             <strong>${esc(movedNames.join(', '))}</strong></p>
           <p>Position: <strong>${after ? 'after' : 'before'} "${esc(targetName)}"</strong>.</p>
           <p class="muted" style="font-size:12px">Only the directory entries are rewritten (the audio bodies
             stay in place), so this is fast even for large samples. Backup, verification and rollback included.</p>`,
      { okLabel: swap ? 'Swap' : 'Move & shift' }
    );
    if (!yes) return;
    setBusy(true, 'Reading sample entries…');
    setProgress(0, 'Reordering…');
    try {
      await MF.reorderSamples(writes, validMoved, {
        onProgress: (frac, label) => setProgress(frac, label),
      });
      for (let s = 1; s <= MF.SAMPLE_SLOTS; s++) {
        if (state.samples) state.samples[s - 1] = await MF.readSampleHeader(s);
      }
      // stesso motivo dei wavetable: le voci di directory sono cambiate di posto
      if (state.smData) {
        for (const w of writes) { delete state.smData[w.from]; delete state.smData[w.to]; }
      }
      state.smSel.clear();
      state.smSelAnchor = null;
      renderSamples();
      toast(`${swap ? 'Swapped' : 'Moved'} ${validMoved.length} sample${validMoved.length === 1 ? '' : 's'} ✓`, 'ok');
    } catch (e) {
      toast('Sample move failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // ---------------------------------------------------------------- riordino device (fine)

  const _libId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function loadJsonLib(name, fallback) {
    try {
      const exists = await window.mfapi.fileExists(name);
      if (!exists) return fallback;
      const b64 = await window.mfapi.readFile(name);
      return JSON.parse(Mfp.bytesToText(Mfp.b64ToBytes(b64)));
    } catch {
      return fallback;
    }
  }

  async function saveJsonLib(name, obj) {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    await window.mfapi.writeFile(name, b64);
  }

  async function loadWavetableLib() {
    const data = await loadJsonLib('wavetables.json', { version: 2, collections: [], entries: [] });
    state.wtLib = Array.isArray(data && data.entries) ? data.entries : [];
    state.wtCols = Array.isArray(data && data.collections) ? data.collections : [];
    for (const e of state.wtLib) if (e.collectionId === undefined) e.collectionId = null;
  }

  async function saveWavetableLib() {
    await saveJsonLib('wavetables.json', { version: 2, collections: state.wtCols, entries: state.wtLib });
  }

  async function loadSampleLib() {
    const data = await loadJsonLib('samples.json', { version: 2, collections: [], entries: [] });
    state.smLib = Array.isArray(data && data.entries) ? data.entries : [];
    state.smCols = Array.isArray(data && data.collections) ? data.collections : [];
    for (const e of state.smLib) if (e.collectionId === undefined) e.collectionId = null;
  }

  async function saveSampleLib() {
    await saveJsonLib('samples.json', { version: 2, collections: state.smCols, entries: state.smLib });
  }

  const wtVisibleEntries = () => {
    if (state.wtFilter === 'none') return state.wtLib.filter((e) => !e.collectionId);
    if (state.wtFilter !== 'all') {
      const cid = parseInt(state.wtFilter, 10);
      return state.wtLib.filter((e) => e.collectionId === cid);
    }
    return state.wtLib;
  };

  const smVisibleEntries = () => {
    if (state.smFilter === 'none') return state.smLib.filter((e) => !e.collectionId);
    if (state.smFilter !== 'all') {
      const cid = parseInt(state.smFilter, 10);
      return state.smLib.filter((e) => e.collectionId === cid);
    }
    return state.smLib;
  };

  const wtTargetCollection = () => (state.wtFilter !== 'all' && state.wtFilter !== 'none' ? parseInt(state.wtFilter, 10) : null);
  const smTargetCollection = () => (state.smFilter !== 'all' && state.smFilter !== 'none' ? parseInt(state.smFilter, 10) : null);

  function renderWavetableSidebar() {
    const list = $('wt-lib-list');
    if (!list) return;
    let html = `<div class="cat-item ${state.wtFilter === 'all' ? 'active' : ''}" data-wtf="all">
      <span class="coll-name">All wavetables</span>
      <span class="cat-count">${state.wtLib.length}</span></div>`;
    for (const c of state.wtCols) {
      const n = state.wtLib.filter((e) => e.collectionId === c.id).length;
      html += `<div class="cat-item ${state.wtFilter === String(c.id) ? 'active' : ''}" data-wtf="${c.id}">
        <span class="coll-name">${esc(c.name)}</span>
        <span class="coll-x" data-wtcdel="${c.id}" title="Delete folder (wavetables stay)">✕</span>
        <span class="cat-count">${n}</span></div>`;
    }
    const noneCount = state.wtLib.filter((e) => !e.collectionId).length;
    html += `<div class="cat-item ${state.wtFilter === 'none' ? 'active' : ''}" data-wtf="none">
      <span class="coll-name">No folder</span> <span class="cat-count">${noneCount}</span></div>`;
    html += `<div class="cat-item" data-wtf="new" style="color:var(--muted)"><span class="coll-name">＋ New folder…</span></div>`;
    list.innerHTML = html;
    list.querySelectorAll('[data-wtcdel]').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteWtFolder(parseInt(x.dataset.wtcdel, 10));
      });
    });
    list.querySelectorAll('[data-wtf]').forEach((item) => {
      item.addEventListener('click', async () => {
        const v = item.dataset.wtf;
        if (v === 'new') {
          const ok = await showModal('New folder',
            `<div class="field"><label>Name</label><input id="m-cname" type="text" placeholder="e.g. Granular pack" /></div>`,
            { okLabel: 'Create' });
          if (ok && $('m-cname').value.trim()) {
            const cid = wtAddFolder($('m-cname').value.trim());
            state.wtFilter = String(cid);
            state.wtLibSel = null;
            renderWavetableSidebar();
            renderWavetablePc();
            showDetailEmpty();
          }
          return;
        }
        state.wtFilter = v;
        state.wtLibSel = null;
        renderWavetableSidebar();
        renderWavetablePc();
        showDetailEmpty();
      });
    });
  }

  const wtAddFolder = (name) => {
    const c = { id: Date.now(), name: name.slice(0, 40) };
    state.wtCols.push(c);
    saveWavetableLib();
    return c.id;
  };

  async function deleteWtFolder(cid) {
    const c = state.wtCols.find((cc) => cc.id === cid);
    const ok = await showModal('Delete folder',
      `<p>Delete the folder "${esc(c ? c.name : '')}"? Its wavetables stay in the library, just without a folder.</p>`,
      { okLabel: 'Delete' });
    if (!ok) return;
    state.wtCols = state.wtCols.filter((cc) => cc.id !== cid);
    for (const e of state.wtLib) if (e.collectionId === cid) e.collectionId = null;
    if (state.wtFilter === String(cid)) state.wtFilter = 'all';
    await saveWavetableLib();
    renderWavetableSidebar();
    renderWavetablePc();
  }

  function moveWtEntryToCollection(id, collId) {
    const e = state.wtLib.find((x) => x.id === id);
    if (!e) return;
    e.collectionId = collId;
    saveWavetableLib();
    renderWavetableSidebar();
    renderWavetablePc();
  }

  function renderSampleSidebar() {
    const list = $('sm-lib-list');
    if (!list) return;
    let html = `<div class="cat-item ${state.smFilter === 'all' ? 'active' : ''}" data-smf="all">
      <span class="coll-name">All samples</span>
      <span class="cat-count">${state.smLib.length}</span></div>`;
    for (const c of state.smCols) {
      const n = state.smLib.filter((e) => e.collectionId === c.id).length;
      html += `<div class="cat-item ${state.smFilter === String(c.id) ? 'active' : ''}" data-smf="${c.id}">
        <span class="coll-name">${esc(c.name)}</span>
        <span class="coll-x" data-smcdel="${c.id}" title="Delete folder (samples stay)">✕</span>
        <span class="cat-count">${n}</span></div>`;
    }
    const noneCount = state.smLib.filter((e) => !e.collectionId).length;
    html += `<div class="cat-item ${state.smFilter === 'none' ? 'active' : ''}" data-smf="none">
      <span class="coll-name">No folder</span> <span class="cat-count">${noneCount}</span></div>`;
    html += `<div class="cat-item" data-smf="new" style="color:var(--muted)"><span class="coll-name">＋ New folder…</span></div>`;
    list.innerHTML = html;
    list.querySelectorAll('[data-smcdel]').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSmFolder(parseInt(x.dataset.smcdel, 10));
      });
    });
    list.querySelectorAll('[data-smf]').forEach((item) => {
      item.addEventListener('click', async () => {
        const v = item.dataset.smf;
        if (v === 'new') {
          const ok = await showModal('New folder',
            `<div class="field"><label>Name</label><input id="m-cname" type="text" placeholder="e.g. Drums" /></div>`,
            { okLabel: 'Create' });
          if (ok && $('m-cname').value.trim()) {
            const cid = smAddFolder($('m-cname').value.trim());
            state.smFilter = String(cid);
            state.smLibSel = null;
            renderSampleSidebar();
            renderSamplePc();
            showDetailEmpty();
          }
          return;
        }
        state.smFilter = v;
        state.smLibSel = null;
        renderSampleSidebar();
        renderSamplePc();
        showDetailEmpty();
      });
    });
  }

  const smAddFolder = (name) => {
    const c = { id: Date.now(), name: name.slice(0, 40) };
    state.smCols.push(c);
    saveSampleLib();
    return c.id;
  };

  async function deleteSmFolder(cid) {
    const c = state.smCols.find((cc) => cc.id === cid);
    const ok = await showModal('Delete folder',
      `<p>Delete the folder "${esc(c ? c.name : '')}"? Its samples stay in the library, just without a folder.</p>`,
      { okLabel: 'Delete' });
    if (!ok) return;
    state.smCols = state.smCols.filter((cc) => cc.id !== cid);
    for (const e of state.smLib) if (e.collectionId === cid) e.collectionId = null;
    if (state.smFilter === String(cid)) state.smFilter = 'all';
    await saveSampleLib();
    renderSampleSidebar();
    renderSamplePc();
  }

  function moveSmEntryToCollection(id, collId) {
    const e = state.smLib.find((x) => x.id === id);
    if (!e) return;
    e.collectionId = collId;
    saveSampleLib();
    renderSampleSidebar();
    renderSamplePc();
  }

  function renderWavetablePc() {
    const list = $('wt-pc-list');
    if (!list) return;
    const entries = wtVisibleEntries();
    const count = $('wt-lib-count');
    if (count) count.textContent = `(${entries.length})`;
    list.innerHTML = entries.length
      ? entries.map((e) => `<div class="pc-item" draggable="true" data-id="${e.id}">
          <div>
            <div class="pc-name" title="${esc(e.name)}">${esc(e.name)}</div>
            <div class="pc-meta">${e.addedAt ? new Date(e.addedAt).toLocaleDateString() : ''}</div>
          </div>
          <span class="pc-actions">
            <button class="btn small" data-act="send" title="Send to MicroFreak">➡</button>
            <button class="btn small" data-act="dl" title="Download .mfw">⭳</button>
            <button class="btn small" data-act="del" title="Remove from PC library">✕</button>
          </span>
        </div>`).join('')
      : `<div class="pc-empty">The PC library is empty. Import a WAV, .mfw or .mfwz,
         or drag a device slot here.</div>`;
    list.querySelectorAll('.pc-item').forEach((item) => {
      const id = item.dataset.id;
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        renderWavetableFromLib(id);
      });
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-managefreak-wt', String(id));
        e.dataTransfer.setData('text/plain', String(id));
        e.dataTransfer.effectAllowed = 'copyMove';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'dl') downloadWavetableEntry(id);
          else if (act === 'send') sendWavetableToDevice(id);
          else if (act === 'del') deleteWavetableFromLib(id);
        });
      });
    });
  }

  function renderSamplePc() {
    const list = $('sm-pc-list');
    if (!list) return;
    const entries = smVisibleEntries();
    const count = $('sm-lib-count');
    if (count) count.textContent = `(${entries.length})`;
    list.innerHTML = entries.length
      ? entries.map((e) => `<div class="pc-item" draggable="true" data-id="${e.id}">
          <div>
            <div class="pc-name" title="${esc(e.name)}">${esc(e.name)}</div>
            <div class="pc-meta">${fmtMs(e.durationMs || 0)} · ${((e.dataB64 ? e.dataB64.length * 3 / 4 : 0) / 1024).toFixed(0)} KB</div>
          </div>
          <span class="pc-actions">
            <button class="btn small" data-act="send" title="Send to MicroFreak">➡</button>
            <button class="btn small" data-act="dl" title="Download .mfsample">⭳</button>
            <button class="btn small" data-act="del" title="Remove from PC library">✕</button>
          </span>
        </div>`).join('')
      : `<div class="pc-empty">The PC library is empty. Import a WAV or .mfsample,
         or drag a device slot here.</div>`;
    list.querySelectorAll('.pc-item').forEach((item) => {
      const id = item.dataset.id;
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        renderSampleFromLib(id);
      });
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-managefreak-sm', String(id));
        e.dataTransfer.setData('text/plain', String(id));
        e.dataTransfer.effectAllowed = 'copyMove';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'dl') downloadSampleEntry(id);
          else if (act === 'send') sendSampleToDevice(id);
          else if (act === 'del') deleteSampleFromLib(id);
        });
      });
    });
  }

  async function importWavetableToPc() {
    const files = await window.mfapi.openFiles({
      filters: [
        { name: 'WAV / .mfw / .mfwz', extensions: ['wav', 'mfw', 'mfwz'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!files || !files.length) return;
    let added = 0;
    const errors = [];
    for (const f of files) {
      try {
        const bytes = Mfp.b64ToBytes(f.data);
        const ext = f.name.split('.').pop().toLowerCase();
        let wt;
        if (ext === 'wav') wt = Mfp.wavToWavetable(bytes, f.name.replace(/\.[^.]+$/, ''));
        else if (ext === 'mfw') wt = Mfp.parseMfw(bytes);
        else if (ext === 'mfwz') wt = await Mfp.parseMfwz(bytes);
        else throw new Error('Unsupported extension: .' + ext);
        state.wtLib.push({
          id: _libId(),
          name: (wt.name || 'Wavetable').slice(0, 15),
          dataB64: Mfp.bytesToB64(wt.data),
          collectionId: wtTargetCollection(),
          addedAt: Date.now(),
          source: f.name,
        });
        added++;
      } catch (e) {
        errors.push(`${f.name}: ${e.message || e}`);
      }
    }
    await saveWavetableLib();
    renderWavetableSidebar();
    renderWavetablePc();
    if (added) toast(`Added ${added} wavetable${added > 1 ? 's' : ''} to the PC library ✓`, 'ok');
    if (errors.length) toast('Some files were not imported: ' + errors.join(' — '), 'err', 7000);
  }

  async function importSampleToPc() {
    const files = await window.mfapi.openFiles({
      filters: [
        { name: 'WAV / .mfsample', extensions: ['wav', 'mfsample'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!files || !files.length) return;
    let added = 0;
    const errors = [];
    for (const f of files) {
      try {
        const bytes = Mfp.b64ToBytes(f.data);
        const ext = f.name.split('.').pop().toLowerCase();
        let name;
        let data;
        if (ext === 'wav') {
          const s = Mfp.wavToSample(bytes, f.name.replace(/\.[^.]+$/, ''));
          name = s.name;
          data = s.data;
        } else if (ext === 'mfsample') {
          const m = Mfp.parseMsample(bytes);
          name = (m.header && Array.from(m.header.subarray(10, 23)).filter((c) => c > 0).map((c) => String.fromCharCode(c)).join('')) || 'Sample';
          data = m.data;
        } else {
          throw new Error('Unsupported extension: .' + ext);
        }
        if (!data || data.length < 2 || data.length > MF.SAMPLE_MAX_BYTES) {
          throw new Error('Sample must be 2..' + MF.SAMPLE_MAX_BYTES + ' bytes');
        }
        state.smLib.push({
          id: _libId(),
          name: name.slice(0, 12),
          dataB64: Mfp.bytesToB64(data),
          sizeBytes: data.length,
          durationMs: Math.round((data.length / 2 / 32000) * 1000),
          collectionId: smTargetCollection(),
          addedAt: Date.now(),
          source: f.name,
        });
        added++;
      } catch (e) {
        errors.push(`${f.name}: ${e.message || e}`);
      }
    }
    await saveSampleLib();
    renderSampleSidebar();
    renderSamplePc();
    if (added) toast(`Added ${added} sample${added > 1 ? 's' : ''} to the PC library ✓`, 'ok');
    if (errors.length) toast('Some files were not imported: ' + errors.join(' — '), 'err', 7000);
  }

  async function exportWavetableLib() {
    if (!state.wtLib.length) return toast('The wavetable library is empty.', 'err');
    const files = state.wtLib.map((e) => ({
      name: `${safeFile(e.name)}.mfw`,
      dataB64: e.dataB64,
    }));
    const dir = await window.mfapi.exportFolder(files);
    if (dir) toast(`Exported ${files.length} wavetables to ${dir}`, 'ok');
  }

  async function exportSampleLib() {
    if (!state.smLib.length) return toast('The sample library is empty.', 'err');
    const files = state.smLib.map((e) => ({
      name: `${safeFile(e.name)}.mfsample`,
      dataB64: e.dataB64,
    }));
    const dir = await window.mfapi.exportFolder(files);
    if (dir) toast(`Exported ${files.length} samples to ${dir}`, 'ok');
  }

  async function downloadWavetableEntry(id) {
    const entry = state.wtLib.find((e) => e.id === id);
    if (!entry) return;
    await window.mfapi.saveFile({
      defaultName: `${safeFile(entry.name)}.mfw`,
      data: entry.dataB64,
      filters: [{ name: 'MicroFreak wavetable', extensions: ['mfw'] }],
    });
  }

  async function downloadSampleEntry(id) {
    const entry = state.smLib.find((e) => e.id === id);
    if (!entry) return;
    const bytes = Mfp.b64ToBytes(entry.dataB64);
    const header = new Uint8Array(28);
    header[4] = bytes.length & 0xff;
    header[5] = (bytes.length >> 8) & 0xff;
    header[6] = (bytes.length >> 16) & 0xff;
    header[7] = (bytes.length >> 24) & 0xff;
    // checksum ricalcolato dal corpo
    let sum = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) sum = (sum + (bytes[i] | (bytes[i + 1] << 8))) & 0xffff;
    header[8] = sum & 0xff;
    header[9] = (sum >> 8) & 0xff;
    for (let i = 0; i < entry.name.length && i < 12; i++) header[10 + i] = entry.name.charCodeAt(i) & 0x7f;
    header[23] = 0;
    await window.mfapi.saveFile({
      defaultName: `${safeFile(entry.name)}.mfsample`,
      data: Mfp.bytesToB64(Mfp.serializeMsample(header, bytes)),
      filters: [{ name: 'MicroFreak sample backup', extensions: ['mfsample'] }],
    });
  }

  async function deleteWavetableFromLib(id) {
    state.wtLib = state.wtLib.filter((e) => e.id !== id);
    if (state.wtLibSel === id) state.wtLibSel = null;
    await saveWavetableLib();
    renderWavetableSidebar();
    renderWavetablePc();
  }

  async function deleteSampleFromLib(id) {
    state.smLib = state.smLib.filter((e) => e.id !== id);
    if (state.smLibSel === id) state.smLibSel = null;
    await saveSampleLib();
    renderSampleSidebar();
    renderSamplePc();
  }

  /**
   * Modale di conferma per scrivere una wavetable/sample della libreria PC in
   * uno slot del MicroFreak — identica a quella dei preset.
   */
  async function confirmSlotWrite({ name, slot }) {
    return showModal(
      `Confirm write to slot ${slot}`,
      `<p>Write <strong>"${esc(name)}"</strong> to slot ${slot} on the MicroFreak?</p>`,
      { okLabel: 'Send to MicroFreak' }
    );
  }

  async function chooseSlotModal(title, max, firstFree, { headers = null } = {}) {
    const ok = await showModal(title,
      `<div class="field"><label>Slot (1–${max})</label>
         <input id="m-slot" type="number" min="1" max="${max}" value="${firstFree || 1}" />
         <div id="m-slot-info" class="vol-note"></div></div>`,
      {
        okLabel: 'Send',
        onOk: () => {
          const v = parseInt($('m-slot').value, 10);
          if (!v || v < 1 || v > max) {
            toast(`Invalid slot (1–${max}).`, 'err');
            return false;
          }
          $('m-slot').dataset.slot = String(v);
        },
      });
    const input = $('m-slot');
    const info = $('m-slot-info');
    if (input && info && headers) {
      const update = () => {
        const v = parseInt(input.value, 10);
        const h = v >= 1 && v <= max ? headers[v - 1] : null;
        if (!v || v < 1 || v > max) {
          info.textContent = '';
          info.classList.remove('vol-warn');
          return;
        }
        if (h && !h.empty) {
          info.textContent = `⚠ Slot ${v} is occupied by "${h.name}": this will SUBSTITUTE it.`;
          info.classList.add('vol-warn');
        } else {
          info.textContent = `Slot ${v} is empty.`;
          info.classList.remove('vol-warn');
        }
      };
      input.addEventListener('input', update);
      update();
    }
    if (!ok) return null;
    return parseInt($('m-slot').dataset.slot, 10);
  }

  async function sendWavetableToDevice(id) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    const entry = state.wtLib.find((e) => e.id === id);
    if (!entry) return;
    const firstFree = (state.wavetables || []).findIndex((h) => !h || h.empty) + 1 || 1;
    const slot = await chooseSlotModal('Send wavetable to MicroFreak', 16, firstFree, { headers: state.wavetables });
    if (!slot) return;
    await uploadWavetableEntryToSlot(entry, slot);
  }

  async function uploadWavetableEntryToSlot(entry, slot) {
    setBusy(true, `Substituting wavetable in slot ${slot}…`);
    setProgress(0, 'Substituting wavetable…');
    try {
      await MF.writeWavetable(slot, { name: entry.name, data: Mfp.b64ToBytes(entry.dataB64) }, {
        onProgress: (frac, label) => setProgress(frac, label),
      });
      delete state.wtData[slot];
      if (state.wavetables) state.wavetables[slot - 1] = await MF.readWavetableHeader(slot);
      renderWavetables();
      if (state.wtLastRender && state.wtLastRender.slot === slot) selectWavetable(slot);
      toast(`Wavetable "${entry.name}" written to slot ${slot} ✓`, 'ok');
    } catch (e) {
      toast('Wavetable substitution failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function sendSampleToDevice(id) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    const entry = state.smLib.find((e) => e.id === id);
    if (!entry) return;
    const firstFree = (state.samples || []).findIndex((h) => !h || h.empty) + 1 || 1;
    const slot = await chooseSlotModal('Send sample to MicroFreak', 128, firstFree, { headers: state.samples });
    if (!slot) return;
    await uploadSampleEntryToSlot(entry, slot);
  }

  async function uploadSampleEntryToSlot(entry, slot) {
    setBusy(true, `Substituting sample in slot ${slot}…`);
    setProgress(0, 'Substituting sample…');
    try {
      await MF.writeSample(slot, entry.name, Mfp.b64ToBytes(entry.dataB64), {
        onProgress: (frac, label) => setProgress(frac, label),
      });
      delete state.smData[slot];
      if (state.samples) state.samples[slot - 1] = await MF.readSampleHeader(slot);
      try {
        state.sampleStats = await MF.readSampleStats();
      } catch {
        /* stats non disponibili */
      }
      renderSamples();
      if (state.smLastRender && state.smLastRender.slot === slot) selectSample(slot);
      toast(`Sample "${entry.name}" written to slot ${slot} ✓`, 'ok');
    } catch (e) {
      toast('Sample substitution failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function readWavetableSlotToPc(slot) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Reading wavetable slot ${slot}…`);
    try {
      const wt = await MF.readWavetable(slot);
      if (!wt.data) return toast(`Wavetable slot ${slot} is empty.`, 'err');
      state.wtLib.push({
        id: _libId(),
        name: (wt.name || 'Wavetable').slice(0, 15),
        dataB64: Mfp.bytesToB64(wt.data),
        collectionId: wtTargetCollection(),
        addedAt: Date.now(),
        source: `MicroFreak slot ${slot}`,
      });
      await saveWavetableLib();
      renderWavetableSidebar();
      renderWavetablePc();
      toast(`Wavetable "${wt.name}" stored in the PC library ✓`, 'ok');
    } catch (e) {
      toast('Wavetable read failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  async function readSampleSlotToPc(slot) {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    setBusy(true, `Reading sample slot ${slot}…`);
    try {
      const s = await MF.readSample(slot);
      if (!s.data) return toast(`Sample slot ${slot} is empty.`, 'err');
      state.smLib.push({
        id: _libId(),
        name: s.name.slice(0, 12) || 'Sample',
        dataB64: Mfp.bytesToB64(s.data),
        sizeBytes: s.data.length,
        durationMs: Math.round((s.data.length / 2 / 32000) * 1000),
        collectionId: smTargetCollection(),
        addedAt: Date.now(),
        source: `MicroFreak slot ${slot}`,
      });
      await saveSampleLib();
      renderSampleSidebar();
      renderSamplePc();
      toast(`Sample "${s.name}" stored in the PC library ✓`, 'ok');
    } catch (e) {
      toast('Sample read failed: ' + (e.message || e), 'err', 6000);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- backup completo del dispositivo

  async function backupFullDevice() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    const yes = await showModal('Full device backup',
      `<p>Reads the whole MicroFreak: all occupied presets, wavetables, samples and
         device settings, saved into a single <code>.mfbak</code> file.
         This can take several minutes; you can cancel at any time.</p>`,
      { okLabel: 'Start backup' });
    if (!yes) return;

    setBusy(true, 'Reading preset headers…');
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    try {
      // 1. preset
      const headers = await MF.scanHeaders({
        onProgress: (d, t) => setProgress((d / t) * 0.4, `Preset headers ${d}/${t}`),
        onError: () => { /* righe con errore ignorate nel backup */ },
      });
      const occupied = headers.filter((h) => h && !h.empty && !h.error);
      const presets = [];
      for (let i = 0; i < occupied.length; i++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const h = occupied[i];
        const p = await MF.readPreset(h.slot, { timeoutMs: 4000 });
        if (p.data) {
          presets.push({ slot: h.slot, name: p.name, category: p.category, p1: p.p1, dataB64: Mfp.bytesToB64(p.data) });
        }
        setProgress(0.4 + (i / Math.max(1, occupied.length)) * 0.3, `Presets ${i + 1}/${occupied.length}`);
      }
      // 2. wavetable
      const wavetables = [];
      for (let s = 1; s <= MF.WAVE_SLOTS; s++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const h = await MF.readWavetableHeader(s);
        if (!h.empty) {
          const wt = await MF.readWavetable(s);
          if (wt.data) wavetables.push({ slot: s, name: wt.name, dataB64: Mfp.bytesToB64(wt.data) });
        }
        setProgress(0.7 + (s / MF.WAVE_SLOTS) * 0.1, `Wavetables ${s}/16`);
      }
      // 3. sample
      const samples = [];
      for (let s = 1; s <= MF.SAMPLE_SLOTS; s++) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        const h = await MF.readSampleHeader(s);
        if (!h.empty) {
          const sm = await MF.readSample(s);
          if (sm.data) {
            samples.push({
              slot: s, name: sm.name, sizeBytes: sm.sizeBytes, checksum: sm.checksum,
              headerB64: Mfp.bytesToB64(h.raw), dataB64: Mfp.bytesToB64(sm.data),
            });
          }
        }
        setProgress(0.8 + (s / MF.SAMPLE_SLOTS) * 0.1, `Samples ${s}/128`);
      }
      // 4. impostazioni dispositivo
      setProgress(0.95, 'Reading device settings…');
      const globals = await MF.readAllGlobals();

      const bytes = await Mfp.serializeFullBackup({
        presets, wavetables, samples, globals,
        meta: { device: 'Arturia MicroFreak', createdAt: new Date().toISOString() },
      });
      setProgress(null);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const path = await window.mfapi.saveFile({
        defaultName: `managefreak-full-backup-${stamp}.mfbak`,
        data: Mfp.bytesToB64(bytes),
        filters: [{ name: 'ManageFreak full backup', extensions: ['mfbak'] }],
      });
      if (path) {
        toast(`Full backup saved to ${path} (${presets.length} presets, ${wavetables.length} wavetables, ${samples.length} samples) ✓`, 'ok', 7000);
      }
    } catch (e) {
      if (!(e && e.message === 'Operation cancelled')) {
        toast('Backup failed: ' + (e.message || e), 'err', 6000);
      }
    } finally {
      setBusy(false);
      setProgress(null);
      el.btnCancel.classList.add('hidden');
    }
  }

  async function restoreFullDevice() {
    if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
    const files = await window.mfapi.openFiles({
      filters: [
        { name: 'ManageFreak full backup', extensions: ['mfbak', 'zip'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!files || !files.length) return;
    let backup;
    try {
      backup = await Mfp.parseFullBackup(Mfp.b64ToBytes(files[0].data));
    } catch (e) {
      return toast('Invalid backup file: ' + (e.message || e), 'err', 6000);
    }
    const nGlobals = Object.keys(backup.globals || {}).length;
    // selezione di cosa ripristinare (tutto selezionato di default)
    const pick = { presets: true, wavetables: true, samples: true, settings: true };
    const chk = (id) => {
      const node = document.getElementById(id);
      return !node || node.checked;
    };
    const yes = await showModal('Restore full backup',
      `<p>This <strong>overwrites</strong> the MicroFreak with the backup. Every item is written and then
         <strong>read back to verify it</strong>; anything that does not match is listed at the end.</p>
       <div class="field"><label><input type="checkbox" id="rs-presets" checked />
         Presets (${backup.presets.length})</label></div>
       <div class="field"><label><input type="checkbox" id="rs-wavetables" checked />
         Wavetables (${backup.wavetables.length})</label></div>
       <div class="field"><label><input type="checkbox" id="rs-samples" checked />
         Samples (${backup.samples.length})</label></div>
       <div class="field"><label><input type="checkbox" id="rs-settings" checked />
         Device settings (${nGlobals})</label></div>
       <p class="muted" style="font-size:12px">Settings take seconds; samples take minutes each (identical ones
         are skipped). Cancelling — or an error — keeps what has already been written, with one exception:
         a sample interrupted mid-transfer leaves <strong>that slot empty</strong> (the firmware needs a clean
         slot); its previous content is still in your backup file.</p>`,
      {
        okLabel: 'Restore',
        onOk: () => {
          pick.presets = chk('rs-presets');
          pick.wavetables = chk('rs-wavetables');
          pick.samples = chk('rs-samples');
          pick.settings = chk('rs-settings');
          if (!pick.presets && !pick.wavetables && !pick.samples && !pick.settings) {
            toast('Select at least one group to restore.', 'err');
            return false; // lascia aperta la modale
          }
          return true;
        },
      });
    if (!yes) return;

    const presetList = pick.presets ? backup.presets : [];
    const wtList = pick.wavetables ? backup.wavetables : [];
    const smList = pick.samples ? backup.samples : [];
    const globalList = pick.settings ? Object.entries(backup.globals || {}) : [];

    setBusy(true, 'Restoring presets…');
    el.btnCancel.classList.remove('hidden');
    state.cancelRequested = false;
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let interrupted = 0; // elementi fermati da Cancel o dal watchdog: non sono errori
    const failures = [];
    const total = Math.max(1, presetList.length + wtList.length + smList.length + globalList.length);
    const step = (label) => setProgress(done / total, `${label} (${done}/${total})`);

    // Un elemento alla volta, con due protezioni:
    //  - il progresso DENTRO l'elemento (i sample durano minuti: senza questo
    //    la barra sembrava bloccata);
    //  - un watchdog di inattività: se un elemento non avanza entro STALL_MS
    //    viene interrotto (shouldCancel) invece di restare appeso per ore.
    const STALL_MS = 90000;
    let stallTimer = null;
    let stalled = false;
    const armWatchdog = () => {
      stalled = false;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; }, STALL_MS);
    };
    const disarmWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const abortItem = () => state.cancelRequested || stalled;
    // Un elemento interrotto su richiesta (Cancel) o dal watchdog non è un errore:
    // va contato a parte, altrimenti il riepilogo finale lo elenca fra i guasti.
    const abortedBy = (e) => (e && e.message === 'Operation cancelled') || state.cancelRequested || stalled;
    const itemProgress = (label) => (f, l) => {
      armWatchdog();
      const frac = Math.max(0, Math.min(1, Number(f) || 0));
      setProgress((done + frac) / total, l || label);
    };

    try {
      for (const p of presetList) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        try {
          const want = Mfp.b64ToBytes(p.dataB64);
          armWatchdog();
          await MF.writePreset(p.slot, { name: p.name, category: p.category, p1: p.p1, data: want }, { timeoutMs: 4000 });
          // verifica: lo slot viene riletto e confrontato byte per byte
          const rb = await MF.readPreset(p.slot, { timeoutMs: 4000 });
          disarmWatchdog();
          if (!rb.data || rb.data.length !== want.length || !MF.bytesEqual(rb.data, want)) {
            throw new Error('readback does not match the backup');
          }
          if ((rb.name || '') !== (p.name || '')) {
            throw new Error(`readback name is "${rb.name}" instead of "${p.name}"`);
          }
        } catch (e) {
          disarmWatchdog();
          if (abortedBy(e)) interrupted++;
          else {
            failed++;
            failures.push(`preset ${p.slot}`);
            status(`Slot ${p.slot}: ${e && e.message || e}`);
          }
        }
        done++;
        step('Presets');
      }
      for (const w of wtList) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        try {
          armWatchdog();
          await MF.writeWavetable(w.slot, { name: w.name, data: Mfp.b64ToBytes(w.dataB64) }, {
            onProgress: itemProgress(`Wavetable ${w.slot}`),
            shouldCancel: abortItem,
          });
          disarmWatchdog();
        } catch (e) {
          disarmWatchdog();
          if (abortedBy(e)) interrupted++;
          else {
            failed++;
            failures.push(`wavetable ${w.slot}`);
            status(`Wavetable ${w.slot}: ${e && e.message || e}`);
          }
        }
        done++;
        step('Wavetables');
      }
      for (const s of smList) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        try {
          // salta i sample già identici: nome + dimensione + checksum
          // nell'header bastano a riconoscerli senza rileggere tutto il corpo.
          // Rende un ripristino (anche ripreso dopo un annullamento) molto più rapido.
          const cur = await MF.readSampleHeader(s.slot);
          if (!cur.empty && typeof s.checksum === 'number'
              && cur.checksum === s.checksum && cur.sizeBytes === s.sizeBytes
              && String(cur.name || '') === String(s.name || '')) {
            skipped++;
            done++;
            step('Samples');
            setProgress(done / total, `Sample ${s.slot}: already identical, skipped`);
            continue;
          }
          armWatchdog();
          await MF.writeSample(s.slot, s.name, Mfp.b64ToBytes(s.dataB64), {
            onProgress: itemProgress(`Sample ${s.slot} (${s.name || ''})`),
            shouldCancel: abortItem,
          });
          disarmWatchdog();
        } catch (e) {
          disarmWatchdog();
          if (abortedBy(e)) interrupted++;
          else {
            failed++;
            failures.push(`sample ${s.slot}`);
            status(`Sample ${s.slot}: ${e && e.message || e}`);
          }
        }
        done++;
        step('Samples');
      }
      for (const [name, value] of globalList) {
        if (state.cancelRequested) throw new Error('Operation cancelled');
        try {
          armWatchdog();
          await MF.writeGlobalSetting(name, value);
          disarmWatchdog();
        } catch (e) {
          disarmWatchdog();
          if (abortedBy(e)) interrupted++;
          else {
            failed++;
            failures.push(`setting ${name}`);
            status(`Setting ${name}: ${e && e.message || e}`);
          }
        }
        done++;
        step('Settings');
      }
      // aggiorna la vista
      try {
        await syncAllFromDevice();
      } catch {
        /* la risincronizzazione non blocca l'esito */
      }
      // i globali non fanno parte della risincronizzazione: se la scheda Device
      // è già stata aperta va riletta, altrimenti mostrerebbe i valori vecchi
      if (pick.settings && state.deviceGlobals && Midi.isOpen()) {
        try {
          await loadDeviceGlobals({ quiet: true });
        } catch {
          /* la lettura dei globali non blocca l'esito */
        }
      }
      const okCount = done - failed - interrupted;
      const skipNote = skipped ? ` (${skipped} already identical, skipped)` : '';
      const stopNote = interrupted ? `, ${interrupted} interrupted` : '';
      if (!failed && !interrupted) {
        toast(`Restore complete: ${okCount}/${done} items written and verified${skipNote} ✓`, 'ok', 8000);
      } else if (!failed) {
        toast(`Restore interrupted: ${okCount}/${done} items written and verified${stopNote}${skipNote}.`, 'err', 9000);
      } else {
        const shown = failures.slice(0, 6).join(', ') + (failures.length > 6 ? ', …' : '');
        toast(`Restore finished with problems: ${okCount}/${done} verified, ${failed} failed (${shown})${stopNote}${skipNote}.`, 'err', 10000);
      }
    } catch (e) {
      if (!(e && e.message === 'Operation cancelled')) {
        toast('Restore failed: ' + (e.message || e), 'err', 6000);
      } else {
        toast(`Restore cancelled: ${done}/${total} items processed, the rest is untouched.`, 'err', 8000);
      }
    } finally {
      disarmWatchdog();
      setBusy(false);
      setProgress(null);
      el.btnCancel.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------------ auto-update

  /**
   * Modale di aggiornamento: consenso + changelog + avanzamento + riavvio.
   * Gli eventi arrivano dal main process via 'update-event' (solo app
   * impacchettata / installer NSIS); in sviluppo questa sezione resta inerte.
   */
  function initUpdater() {
    if (!window.mfapi || typeof window.mfapi.onUpdateEvent !== 'function') return;
    let phase = 'idle'; // idle | available | downloading | downloaded
    let downloading = false;

    const fmtBytes = (n) => {
      const v = Number(n) || 0;
      if (v <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      let x = v;
      while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
      return `${x.toFixed(1)} ${units[i]}`;
    };

    const setState = (s) => {
      phase = s;
      const prim = el.updatePrimary;
      const later = el.updateLater;
      switch (s) {
        case 'available':
          prim.textContent = 'Update now';
          prim.classList.remove('hidden');
          prim.disabled = false;
          later.textContent = 'Later';
          later.classList.remove('hidden');
          el.updateProgress.classList.add('hidden');
          prim.focus();
          break;
        case 'downloading':
          prim.textContent = 'Downloading…';
          prim.disabled = true;
          later.textContent = 'Hide';
          el.updateProgress.classList.remove('hidden');
          break;
        case 'downloaded':
          prim.textContent = 'Restart now';
          prim.classList.remove('hidden');
          prim.disabled = false;
          later.textContent = 'Later';
          later.classList.remove('hidden');
          el.updateProgress.classList.add('hidden');
          prim.focus();
          break;
        case 'idle':
        default:
          prim.classList.add('hidden');
          later.classList.add('hidden');
          el.updateProgress.classList.add('hidden');
          break;
      }
    };

    const hide = () => {
      el.updateBackdrop.classList.add('hidden');
      setState('idle');
    };

    el.updateLater.addEventListener('click', () => {
      if (downloading) {
        // nasconde solo la finestra, il download prosegue in background
        el.updateBackdrop.classList.add('hidden');
      } else {
        hide();
      }
      window.mfapi.sendUpdateAction('later').catch(() => {});
    });

    el.updatePrimary.addEventListener('click', () => {
      if (phase === 'available') {
        downloading = true;
        setState('downloading');
        el.updateProgressFill.style.width = '0%';
        el.updateProgressText.textContent = 'Starting download…';
        window.mfapi.sendUpdateAction('download').catch(() => {});
      } else if (phase === 'downloaded') {
        window.mfapi.sendUpdateAction('install').catch(() => {});
      }
    });

    el.updateBackdrop.addEventListener('click', (e) => {
      if (e.target === el.updateBackdrop && phase !== 'downloading') hide();
    });

    window.mfapi.onUpdateEvent((ev) => {
      try {
        switch (ev.type) {
          case 'available': {
            manualCheckPending = false;
            const notes = ev.releaseNotes || '';
            el.updateChangelog.textContent = notes || 'No changelog available for this release.';
            el.updateChangelog.classList.remove('hidden');
            el.updateTitle.textContent = `Update available — v${esc(ev.version)}`;
            el.updateBody.innerHTML = '<p>A new version of ManageFreak is ready. Your presets, libraries and settings are kept — only the application is replaced.</p>';
            setState('available');
            el.updateBackdrop.classList.remove('hidden');
            break;
          }
          case 'downloading':
          case 'progress': {
            if (phase !== 'downloading' && phase !== 'available') break;
            downloading = true;
            if (phase !== 'downloading') setState('downloading');
            const pct = Math.min(100, Math.max(0, ev.percent || 0));
            el.updateProgressFill.style.width = `${pct}%`;
            const speed = ev.bytesPerSecond ? ` · ${fmtBytes(ev.bytesPerSecond)}/s` : '';
            el.updateProgressText.textContent = `${pct.toFixed(1)}% · ${fmtBytes(ev.transferred)} / ${fmtBytes(ev.total)}${speed}`;
            break;
          }
          case 'downloaded':
            downloading = false;
            updateReadyVersion = ev.version || '';
            el.updateTitle.textContent = `Update ready — v${esc(ev.version)}`;
            el.updateBody.innerHTML = '<p>The update has been downloaded and verified. Restart ManageFreak now to install it (the app will close briefly).</p>';
            el.updateChangelog.classList.add('hidden');
            setState('downloaded');
            el.updateBackdrop.classList.remove('hidden');
            break;
          case 'not-available':
            // nessun aggiornamento: se l'utente stava guardando la modale, la chiudiamo
            if (phase !== 'idle') hide();
            // check manuale esplicito → conferma visiva
            if (manualCheckPending) {
              manualCheckPending = false;
              toast(`You are up to date (v${appVersion})`, 'ok', 5000);
            }
            break;
          case 'error':
            downloading = false;
            manualCheckPending = false;
            // il check automatico all'avvio resta silenzioso; gli errori di
            // download/installazione avviati dall'utente vanno sempre mostrati
            if (ev.silent) break;
            toast('Update error: ' + (ev.message || 'unknown'), 'err', 8000);
            if (phase === 'downloading' || ev.phase === 'download') {
              hide();
              toast('Download failed. Try again later or download the new installer manually.', 'err', 8000);
            } else if (ev.phase === 'install') {
              toast('Installation could not start. Reopen the app and try again.', 'err', 8000);
            }
            break;
          default:
            break;
        }
      } catch (e) {
        toast('Update UI error: ' + (e.message || e), 'err', 8000);
      }
    });
  }

  // ------------------------------------------------------------------ menu About / Aggiornamenti

  /** Apre il menu (versione + changelog ultima release + check aggiornamenti). */
  async function openAppMenu() {
    if (!el.appMenu.classList.contains('hidden')) return;
    el.appMenu.classList.remove('hidden');
    el.appMenuVersion.textContent = appVersion ? `v${appVersion}` : '';
    // se un aggiornamento è già scaricato il pulsante installa invece di cercare
    if (el.btnCheckUpdates) {
      el.btnCheckUpdates.textContent = updateReadyVersion
        ? `Restart to install v${updateReadyVersion}`
        : 'Check for updates';
    }
    // riga informativa fissa sulle piattaforme senza aggiornamento automatico
    const oldNote = el.appMenu.querySelector('.app-menu-note');
    if (oldNote) oldNote.remove();
    if (!canAutoUpdate && !updateReadyVersion) {
      const note = document.createElement('div');
      note.className = 'app-menu-note';
      note.textContent = 'Automatic updates are available on the Windows build only — here you can check for a new version and download it manually.';
      const actions = el.appMenu.querySelector('.app-menu-actions');
      if (actions) actions.prepend(note);
    }
    el.appMenuChangelog.textContent = 'Loading…';
    try {
      const rel = await window.mfapi.latestRelease();
      if (!rel || rel.error) {
        el.appMenuChangelog.textContent = rel && rel.error
          ? `Changelog unavailable (${rel.error}).`
          : 'Changelog unavailable.';
        return;
      }
      el.appMenuChangelog.textContent = rel.body || `No changelog for ${rel.version || 'the latest release'}.`;
    } catch {
      el.appMenuChangelog.textContent = 'Changelog unavailable.';
    }
  }

  function closeAppMenu() {
    el.appMenu.classList.add('hidden');
  }

  function initAppMenu() {
    if (!el.appBrand || !el.appMenu) return;
    el.appBrand.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.appMenu.classList.contains('hidden')) openAppMenu();
      else closeAppMenu();
    });
    // click fuori dal menu → chiudi
    document.addEventListener('click', (e) => {
      if (!el.appMenu.classList.contains('hidden') && !e.target.closest('.brand-wrap')) closeAppMenu();
    });
    // Esc → chiudi (prima di qualunque altro handler)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.appMenu.classList.contains('hidden')) {
        e.stopImmediatePropagation();
        closeAppMenu();
      }
    }, true);
    // check manuale degli aggiornamenti (o installazione, se già scaricato)
    if (el.btnCheckUpdates) {
      el.btnCheckUpdates.addEventListener('click', async () => {
        closeAppMenu();
        if (updateReadyVersion) {
          toast('Restarting to install the update…');
          window.mfapi.sendUpdateAction('install').catch((e) => {
            toast('Install failed: ' + (e && e.message || e), 'err', 6000);
          });
          return;
        }
        manualCheckPending = true;
        toast('Checking for updates…');
        try {
          const res = await window.mfapi.sendUpdateAction('check');
          // piattaforme senza aggiornamento automatico (macOS/Linux/portable):
          // risposta chiara invece di un errore tecnico incomprensibile
          if (res && res.unsupported) {
            manualCheckPending = false;
            if (res.error) {
              toast('Could not check for updates: ' + res.error, 'err', 7000);
              return;
            }
            if (res.hasUpdate) {
              const go = await showModal(`Update available — v${esc(res.latest)}`,
                `<p>ManageFreak <strong>v${esc(res.latest)}</strong> is available (you have v${esc(res.current)}).</p>
                 <p class="muted" style="font-size:12px">Automatic updates work on the installed Windows build only.
                 Download the new version from the releases page and install it as usual.</p>`,
                { okLabel: 'Open download page' });
              if (go) window.mfapi.openExternal(res.url);
            } else {
              toast(`You are up to date (v${appVersion}). Automatic updates are Windows-only.`, 'ok', 7000);
            }
          }
        } catch (e) {
          manualCheckPending = false;
          toast('Update check failed: ' + (e.message || e), 'err', 6000);
        }
      });
    }
  }

  // ------------------------------------------------------------------ init

  async function init() {
    // auto-update: si sottoscrive agli eventi del main process (inerte in dev)
    initUpdater();
    // durante un trascinamento l'unica indicazione di posizione deve essere la
    // barretta di inserimento: niente bordo/alone di hover sulla riga sotto il mouse
    document.addEventListener('dragstart', () => document.body.classList.add('mf-dragging'));
    const endDrag = () => { document.body.classList.remove('mf-dragging'); clearDragIndicator(); };
    document.addEventListener('dragend', endDrag);
    document.addEventListener('drop', endDrag);
    // menu About/Aggiornamenti sul nome dell'app
    initAppMenu();

    // listener libreria → aggiorna griglia e sidebar (senza toccare il pannello
    // dettagli, per non perdere il focus durante la digitazione delle note)
    Library.subscribe(() => {
      renderLibrary();
    });

    el.btnRefreshPorts.addEventListener('click', async () => {
      await refreshPorts();
      // se già connesso, risincronizza preset, wavetable e sample
      if (Midi.isOpen()) syncAllFromDevice();
    });
    el.btnConnect.addEventListener('click', connect);
    // se la connessione MIDI cade, dirlo subito: prima si perdeva in silenzio
    // (l'app sembrava funzionare mentre il MicroFreak non riceveva più nulla)
    let midiWasOpen = false;
    let portsDebounce = null;
    Midi.onStateChange(() => {
      // un cambio nell'elenco dei dispositivi MIDI (replug del MicroFreak, altra
      // app che apre/chiude una porta, porta virtuale che appare) deve ricostruire
      // i menu: prima questo evento serviva solo ad accorgersi della disconnessione
      // e le porte che arrivavano dopo restavano invisibili.
      if (!portsDebounce) {
        portsDebounce = setTimeout(() => {
          portsDebounce = null;
          refreshPorts({ quiet: true });
        }, 400);
      }
      if (Midi.isOpen()) { midiWasOpen = true; return; }
      if (!midiWasOpen) return;
      midiWasOpen = false;
      if (el.connStatus) {
        el.connStatus.className = 'status-dot error';
        el.connStatus.title = 'MIDI connection lost';
      }
      status('MIDI connection lost — reconnect the MicroFreak.');
      toast('MIDI connection lost: the MicroFreak is no longer reachable.', 'err', 7000);
    });
    el.btnReadAll.addEventListener('click', readAllOccupied);
    el.btnDownloadBank.addEventListener('click', downloadBankToPC);
    el.btnUploadLibrary.addEventListener('click', uploadLibraryToDevice);
    el.btnCancel.addEventListener('click', () => {
      state.cancelRequested = true;
      toast('Cancellation requested…');
    });
    el.btnImport.addEventListener('click', importFiles);
    el.btnBackup.addEventListener('click', backupLibrary);

    // tema chiaro/scuro
    let theme = 'dark';
    try { theme = localStorage.getItem('managefreak-theme') || 'dark'; } catch { /* ignora */ }
    applyTheme(theme);
    el.btnTheme.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });

    // ordinamento libreria
    document.getElementById('sort-select').addEventListener('change', (e) => {
      state.sortMode = e.target.value;
      renderLibrary();
    });
    el.deviceSearch.addEventListener('input', () => {
      state.deviceSearch = el.deviceSearch.value;
      renderDevice();
    });

    // barra di selezione del dispositivo
    document.querySelectorAll('#device-selbar [data-dsel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.dsel;
        if (act === 'clear') return clearDeviceSelection();
        if (act === 'read') readDeviceSelectionToLibrary();
        if (act === 'volume') setVolumeOnDeviceSelection();
        if (act === 'delete') initDeviceSlots(deviceSelIds());
      });
    });
    document.getElementById('btn-view-toggle').addEventListener('click', () => {
      state.libView = state.libView === 'grid' ? 'list' : 'grid';
      renderLibrary();
    });
    el.search.addEventListener('input', () => {
      state.search = el.search.value;
      renderLibrary();
    });

    // tab Presets / Wavetables / Samples / Device
    document.querySelectorAll('#tabs .tab-btn').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    $('btn-wt-read').addEventListener('click', readWavetableInventory);
    $('btn-wt-pc-import').addEventListener('click', importWavetableToPc);
    $('btn-wt-pc-export').addEventListener('click', exportWavetableLib);
    $('btn-wt-lib-import').addEventListener('click', importWavetableToPc);
    $('btn-wt-lib-export').addEventListener('click', exportWavetableLib);
    $('btn-sm-read').addEventListener('click', readSampleInventory);
    $('btn-sm-pc-import').addEventListener('click', importSampleToPc);
    $('btn-sm-pc-export').addEventListener('click', exportSampleLib);
    $('btn-sm-lib-import').addEventListener('click', importSampleToPc);
    $('btn-sm-lib-export').addEventListener('click', exportSampleLib);
    $('btn-dev-load').addEventListener('click', loadDeviceGlobals);
    $('btn-dev-apply').addEventListener('click', applyAllDeviceGlobals);
    $('btn-backup-full').addEventListener('click', backupFullDevice);
    $('btn-restore-full').addEventListener('click', restoreFullDevice);

    initResizers();

    // traccia la posizione del mouse durante il drag per l'auto-scroll
    document.addEventListener('dragover', (e) => {
      if (state.dragInfo && state.dragInfo.active) {
        state.dragInfo.x = e.clientX;
        state.dragInfo.y = e.clientY;
      }
    });

    // drop da dispositivo → libreria PC (lettura dello slot, inserito nella posizione di rilascio)
    const libDropInsertIndex = (clientX, clientY) => {
      const t = libDropTargetFromPoint(clientX, clientY);
      if (!t) return null;
      const idx = Library.all().findIndex((x) => x.id === t.id);
      return idx < 0 ? null : idx + (t.after ? 1 : 0);
    };
    el.libGrid.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types;
      if (!types.includes('application/x-managefreak-slot') && !types.includes('application/x-managefreak')) return;
      e.preventDefault();
      // sia il riordino interno sia l'import dal device mostrano la barretta
      // nella posizione esatta di inserimento (prima era un riquadro tratteggiato
      // attorno a tutta la griglia: non si capiva dove sarebbe finito il preset)
      showLibInsertIndicator(e.clientX, e.clientY);
    });
    el.libGrid.addEventListener('drop', (e) => {
      // riordino della libreria quando il rilascio cade nel gap fra le card
      const onCard = e.target && e.target.closest && e.target.closest('.lib-card, .lib-row');
      if (e.dataTransfer.types.includes('application/x-managefreak') && !onCard) {
        const t = libDropTargetFromPoint(e.clientX, e.clientY);
        if (t) {
          e.preventDefault();
          clearDragIndicator();
          const srcId = parseInt(e.dataTransfer.getData('application/x-managefreak'), 10);
          if (srcId && srcId !== t.id) {
            if (state.dragBlockIds && state.dragBlockIds.length > 1) {
              Library.moveBlock(state.dragBlockIds, t.id, t.after);
            } else {
              Library.move(srcId, t.id, t.after);
            }
          }
          state.dragBlockIds = null;
          return;
        }
      }
      e.preventDefault();
      clearDragIndicator();
      const slotStr = e.dataTransfer.getData('application/x-managefreak-slot');
      const slot = slotStr ? parseInt(slotStr, 10) : 0;
      if (!slot) return;
      const insertIndex = libDropInsertIndex(e.clientX, e.clientY);
      importDeviceSlotToLibrary(slot, insertIndex);
    });

    /** Reads a device slot and adds it to the library
     *  (at the end or at the given position). */
    async function importDeviceSlotToLibrary(slot, insertIndex) {
      if (!Midi.isOpen()) return toast('Connect the MIDI ports first.', 'err');
      setBusy(true, `Reading slot ${slot}…`);
      try {
        const preset = await MF.readPreset(slot, { timeoutMs: 4000 });
        if (!preset.data) return toast(`Slot ${slot} is empty (Init).`, 'err');
        if (isInitNamed(preset)) return toast(`Slot ${slot} contains the Init preset: it is not added to the library.`, 'err');
        const collectionId = targetCollectionId();
        Library.addAt(preset, { sourceName: `Device slot ${slot}`, collectionId }, insertIndex);
        const collName = collectionId ? Library.collectionName(collectionId) : '';
        toast(`"${preset.name}" added to the library${collName ? ` "${collName}"` : ''} ✓`, 'ok');
      } catch (e) {
        toast('Read failed: ' + (e.message || e), 'err', 5000);
      } finally {
        setBusy(false);
      }
    }

    // ---------------------------------------------------------------------
    // drop sul pannello MicroFreak:
    //  - su un preset (zona centrale) → scambio 1:1
    //  - tra due preset (bordi/gap) → shift (spostamento con scorrimento)
    // ---------------------------------------------------------------------
    const clearSlotHighlights = () => {
      el.slotList.querySelectorAll('.slot-row').forEach((r) =>
        r.classList.remove('drag-over', 'swap-over', 'write-over', 'drop-before', 'drop-after'));
    };
    const resolveSlotDrop = (clientY) => {
      const rows = Array.from(el.slotList.querySelectorAll('.slot-row'));
      if (!rows.length) return null;
      let hit = null;
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          const rel = (clientY - r.top) / r.height;
          let mode;
          if (rel < 0.3) mode = 'before';
          else if (rel > 0.7) mode = 'after';
          else mode = 'onto';
          hit = { slot: parseInt(row.dataset.slot, 10), mode };
          break;
        }
      }
      if (!hit) {
        // in un interstizio tra le righe (o fuori): prima della riga sotto il cursore
        hit = { slot: parseInt(rows[rows.length - 1].dataset.slot, 10), mode: 'after' };
        for (const row of rows) {
          const r = row.getBoundingClientRect();
          if (clientY < r.top) {
            hit = { slot: parseInt(row.dataset.slot, 10), mode: 'before' };
            break;
          }
        }
      }
      return hit;
    };
    const handleSlotDrop = async (e, target) => {
      const entryId = e.dataTransfer.getData('application/x-managefreak');
      if (entryId) {
        const entry = Library.get(parseInt(entryId, 10));
        if (!entry) return;
        // dico anche cosa viene sostituito: è una scrittura, non un inserimento
        const cur = state.device && state.device[target.slot - 1];
        const curName = cur && !cur.error && !cur.empty ? `"${cur.name}"` : 'the current content';
        const yes = await showModal(
          `Confirm write to slot ${target.slot}`,
          `<p>Write <strong>"${esc(entry.name)}"</strong> to slot ${target.slot} on the MicroFreak,
             replacing ${esc(curName)}?</p>
           <label><input type="checkbox" id="m-select" checked /> Select the preset after writing</label>`,
          { okLabel: 'Send to MicroFreak' }
        );
        if (yes) writeToSlot(target.slot, entry, { selectAfter: $('m-select').checked });
        return;
      }
      const srcSlot = parseInt(e.dataTransfer.getData('application/x-managefreak-slot'), 10);
      if (!srcSlot || srcSlot === target.slot) return;
      const moved = state.dragDeviceBlock && state.dragDeviceBlock.length > 1
        ? state.dragDeviceBlock
        : [srcSlot];
      if (target.mode === 'onto' && moved.length === 1) {
        await swapDeviceSlots(moved[0], target.slot); // scambio 1:1
      } else {
        await moveDeviceSelectionTo(moved, target.slot, target.mode === 'after'); // shift
      }
    };
    el.slotList.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types;
      if (!types.includes('application/x-managefreak') && !types.includes('application/x-managefreak-slot')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = resolveSlotDrop(e.clientY);
      if (!target) return;
      // Preset trascinato DALLA LIBRERIA: non esiste un inserimento fra slot (è
      // sempre una scrittura nello slot sotto il puntatore), quindi niente
      // barretta: solo l'evidenziazione dello slot che verrà scritto.
      if (types.includes('application/x-managefreak')) {
        const row = el.slotList.querySelector(`.slot-row[data-slot="${target.slot}"]`);
        if (row) setDragIndicator(row, 'swap-over');
        return;
      }
      // Preset trascinato da uno slot all'altro: qui sì che è un inserimento
      // (shift), quindi stesso punto → stessa indicazione centrata nel gap
      const rows = Array.from(el.slotList.querySelectorAll('.slot-row'));
      const idx = rows.findIndex((r) => parseInt(r.dataset.slot, 10) === target.slot);
      const ind = (target.mode === 'before' && idx > 0)
        ? { slot: parseInt(rows[idx - 1].dataset.slot, 10), mode: 'after' }
        : target;
      const row = el.slotList.querySelector(`.slot-row[data-slot="${ind.slot}"]`);
      if (row) {
        setDragIndicator(row, ind.mode === 'onto' ? 'swap-over' : ind.mode === 'before' ? 'drop-before' : 'drop-after');
      }
    });
    el.slotList.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !el.slotList.contains(e.relatedTarget)) clearSlotHighlights();
    });
    el.slotList.addEventListener('drop', async (e) => {
      const types = e.dataTransfer.types;
      if (!types.includes('application/x-managefreak') && !types.includes('application/x-managefreak-slot')) return;
      e.preventDefault();
      clearSlotHighlights();
      const target = resolveSlotDrop(e.clientY);
      if (target) await handleSlotDrop(e, target);
    });

    // scorciatoie: Esc deseleziona, Ctrl+A seleziona tutti, Canc elimina (con conferma)
    document.addEventListener('keydown', (e) => {
      // se la modale di update è aperta, Esc = Later/Hide, Enter = azione principale
      if (!el.updateBackdrop.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          el.updateLater.click();
        } else if (e.key === 'Enter' && !el.updatePrimary.classList.contains('hidden') && !el.updatePrimary.disabled) {
          e.preventDefault();
          el.updatePrimary.click();
        }
        return;
      }
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
      // le scorciatoie da tastiera valgono solo nella vista Presets (o nelle
      // liste wavetable/sample: Esc deseleziona, Canc svuota gli slot selezionati)
      if (state.activeTab === 'wavetables' || state.activeTab === 'samples') {
        if (e.key === 'Escape' && !typing) {
          if (state.activeTab === 'wavetables') clearWtSelectionUi();
          else clearSmSelectionUi();
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
          e.preventDefault();
          if (state.activeTab === 'wavetables') clearWtSelection();
          else clearSmSelection();
        }
        return;
      }
      if (state.activeTab !== 'presets') return;
      if (e.key === 'Escape') {
        if (state.selLib.size && !typing) clearSelection();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        if (state.selLib.size) {
          e.preventDefault();
          confirmDeleteLibrarySelection();
        } else if (state.selectedDeviceSlots.size) {
          e.preventDefault();
          initDeviceSlots(deviceSelIds());
        }
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (typing) return;
        e.preventDefault();
        if (state.activePane === 'device') navigateDevice(e.key);
        else navigateLibrary(e.key);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !typing) {
        e.preventDefault();
        const all = filteredEntries().map((x) => x.id);
        state.selLib = new Set(all);
        state.selAnchor = all.length ? all[0] : null;
        updateSelectionUI();
      }
    });

    const info = await window.mfapi.appInfo();
    appVersion = info.version;
    canAutoUpdate = info.canAutoUpdate !== false;
    document.title = `ManageFreak v${info.version}`;

    await Library.load();
    await loadWavetableLib();
    await loadSampleLib();
    renderLibrary();
    renderSelBar();
    renderDevice();
    renderWavetableSidebar();
    renderSampleSidebar();
    renderWavetablePc();
    renderSamplePc();
    showDetailEmpty();

    if (Midi.supported()) {
      await refreshPorts();
      // se non compare nessuna porta può essere un hiccup del driver USB MIDI
      // (capita dopo una chiusura forzata dell'app): un secondo tentativo, poi
      // un messaggio chiaro invece di menù vuoti e inspiegabili
      if (!Midi.inputs().length && !Midi.outputs().length) {
        await new Promise((r) => setTimeout(r, 900));
        await refreshPorts({ quiet: true });
        if (!Midi.inputs().length && !Midi.outputs().length) {
          toast('No MIDI ports found — Windows is not exposing any MIDI device. Unplug and replug the MicroFreak USB cable (or restart the app): ManageFreak keeps looking and will connect on its own.', 'err', 14000);
          status('No MIDI ports found. Replug the MicroFreak USB cable — still searching…');
          schedulePortWatch();
        }
      }
      // connetti automaticamente se entrambe le porte puntano a un MicroFreak
      const inName = el.midiInput.selectedOptions[0]?.textContent.toLowerCase() || '';
      const outName = el.midiOutput.selectedOptions[0]?.textContent.toLowerCase() || '';
      if (inName.includes('microfreak') && outName.includes('microfreak')) {
        setTimeout(connect, 400);
      }
    } else {
      status('Web MIDI is not supported in this runtime.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  // Rilascio delle porte MIDI prima di uscire. È la cura del bug "la prima volta
  // funziona, poi chiudo e riapro e non trova più le porte": senza chiudere
  // davvero le porte a livello di sistema, Windows le tiene occupate e l'istanza
  // successiva dell'app enumera zero dispositivi MIDI.
  const releaseMidi = () => {
    try { Midi.shutdown(); } catch { /* niente da fare mentre si esce */ }
  };
  window.addEventListener('beforeunload', releaseMidi);
  window.addEventListener('pagehide', releaseMidi);
  if (window.mfapi && window.mfapi.onPrepareQuit) window.mfapi.onPrepareQuit(releaseMidi);

  return { refreshPorts, connect, scanDevice, renderDevice, renderLibrary };
})();
