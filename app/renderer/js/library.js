// ManageFreak — libreria locale di preset con categorie e tag
'use strict';

const Library = (() => {
  const FILE = 'library.json';

  let state = {
    version: 2,
    entries: [], // {id, name, category, catName, tags[], favorite, notes, addedAt, sourceSlot, sourceName, rawHeaderB64, dataB64, collectionId, p1}
    customCategories: [], // {id, name, color}
    collections: [], // {id, name, createdAt} — "librerie importate"
    nextId: 1,
  };

  let saveTimer = null;
  let listeners = new Set();

  const onChange = () => listeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save().catch(() => {});
    }, 300);
  };

  function entryFromPreset(preset, extra = {}) {
    const id = state.nextId++;
    return {
      id,
      name: preset.name || 'Preset',
      category: preset.category !== undefined ? preset.category : -1,
      p1: preset.p1 !== undefined ? preset.p1 : 0,
      catName: extra.catName || '',
      tags: extra.tags || [],
      favorite: !!extra.favorite,
      rating: extra.rating || 0,
      characteristics: preset.characteristics || extra.characteristics || [],
      notes: extra.notes || '',
      addedAt: new Date().toISOString(),
      sourceSlot: preset.slot || null,
      sourceName: extra.sourceName || '',
      rawHeaderB64: preset.rawHeader ? Mfp.bytesToB64(preset.rawHeader) : null,
      dataB64: preset.data ? Mfp.bytesToB64(preset.data) : null,
      collectionId: extra.collectionId !== undefined ? extra.collectionId : null,
    };
  }

  function decodeEntry(e) {
    return {
      ...e,
      data: e.dataB64 ? Mfp.b64ToBytes(e.dataB64) : null,
      rawHeader: e.rawHeaderB64 ? Mfp.b64ToBytes(e.rawHeaderB64) : null,
    };
  }

  /** True se la voce rappresenta un preset Init vuoto (nessun corpo). */
  function isInitEntry(e) {
    return !!(e && !e.dataB64);
  }

  /** Rimuove le voci Init vuote; restituisce il numero rimosso. */
  function purgeInit() {
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => !isInitEntry(e));
    return before - state.entries.length;
  }

  async function load() {
    try {
      const exists = await window.mfapi.fileExists(FILE);
      if (!exists) return false;
      const b64 = await window.mfapi.readFile(FILE);
      const json = JSON.parse(atob(b64));
      if (json && Array.isArray(json.entries)) {
        state = Object.assign({ version: 2, entries: [], customCategories: [], collections: [], nextId: 1 }, json);
        // normalizza voci di versioni precedenti
        let maxId = 0;
        for (const e of state.entries) {
          if (e.collectionId === undefined) e.collectionId = null;
          if (!Array.isArray(e.tags)) e.tags = [];
          if (typeof e.rating !== 'number') e.rating = 0;
          if (!Array.isArray(e.characteristics)) e.characteristics = [];
          if (typeof e.id === 'number' && e.id > maxId) maxId = e.id;
        }
        for (const c of state.customCategories) {
          if (typeof c.id === 'number' && c.id > maxId) maxId = c.id;
        }
        for (const c of state.collections) {
          if (typeof c.id === 'number' && c.id > maxId) maxId = c.id;
        }
        state.nextId = maxId + 1;
        const removed = purgeInit();
        if (removed) {
          console.log(`Libreria: rimossi ${removed} preset Init vuoti dalle versioni precedenti`);
          scheduleSave();
        }
      }
      onChange();
      return true;
    } catch (e) {
      console.warn('Libreria non caricata:', e);
      return false;
    }
  }

  async function save() {
    const json = JSON.stringify(state, null, 1);
    await window.mfapi.writeFile(FILE, btoa(unescape(encodeURIComponent(json))));
  }

  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await save();
  }

  function add(preset, extra) {
    const entry = entryFromPreset(preset, extra);
    state.entries.push(entry);
    scheduleSave();
    onChange();
    return entry;
  }

  /** Aggiunge un preset in una posizione specifica (indice nell'array). */
  function addAt(preset, extra, index) {
    const entry = entryFromPreset(preset, extra);
    if (typeof index === 'number' && index >= 0 && index <= state.entries.length) {
      state.entries.splice(index, 0, entry);
    } else {
      state.entries.push(entry);
    }
    scheduleSave();
    onChange();
    return entry;
  }

  /** Reinserisce una voce già completa (backup JSON), riassegnando l'id.
   *  Ignora (restituisce null) i preset Init vuoti. */
  function importRaw(raw) {
    if (isInitEntry(raw)) return null;
    const entry = { ...raw, id: state.nextId++ };
    delete entry.data;
    delete entry.rawHeader;
    if (entry.collectionId === undefined) entry.collectionId = null;
    if (!Array.isArray(entry.tags)) entry.tags = [];
    if (typeof entry.rating !== 'number') entry.rating = 0;
    if (!Array.isArray(entry.characteristics)) entry.characteristics = [];
    state.entries.push(entry);
    scheduleSave();
    onChange();
    return entry;
  }

  function remove(id) {
    state.entries = state.entries.filter((e) => e.id !== id);
    scheduleSave();
    onChange();
  }

  function update(id, patch) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return null;
    Object.assign(e, patch);
    scheduleSave();
    onChange();
    return e;
  }

  function get(id) {
    const e = state.entries.find((x) => x.id === id);
    return e ? decodeEntry(e) : null;
  }

  function all() {
    return state.entries;
  }

  function addTag(id, tag) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    if (!e.tags.includes(tag)) {
      e.tags.push(tag);
      scheduleSave();
      onChange();
    }
  }

  function removeTag(id, tag) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    e.tags = e.tags.filter((t) => t !== tag);
    scheduleSave();
    onChange();
  }

  function toggleFavorite(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    e.favorite = !e.favorite;
    scheduleSave();
    onChange();
  }

  /** Imposta la valutazione (0..5). Cliccando la stessa stella la azzera. */
  function setRating(id, rating) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    e.rating = rating < 0 ? 0 : rating > 5 ? 5 : rating;
    scheduleSave();
    onChange();
  }

  /** Attiva/disattiva una caratteristica Arturia su una voce. */
  function toggleCharacteristic(id, ch) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    if (!Array.isArray(e.characteristics)) e.characteristics = [];
    const i = e.characteristics.indexOf(ch);
    if (i >= 0) e.characteristics.splice(i, 1);
    else e.characteristics.push(ch);
    scheduleSave();
    onChange();
  }

  function allTags() {
    const set = new Set();
    for (const e of state.entries) for (const t of e.tags) set.add(t);
    return Array.from(set).sort();
  }

  function allCategories() {
    return state.customCategories;
  }

  function addCategory(name, color) {
    const id = state.nextId++;
    state.customCategories.push({ id, name, color: color || '#6d7bd6' });
    scheduleSave();
    onChange();
    return id;
  }

  function removeCategory(id) {
    state.customCategories = state.customCategories.filter((c) => c.id !== id);
    scheduleSave();
    onChange();
  }

  // ---------------------------------------------------------------------------
  // Collezioni ("librerie importate")
  // ---------------------------------------------------------------------------

  function allCollections() {
    return state.collections;
  }

  function collectionName(id) {
    const c = state.collections.find((x) => x.id === id);
    return c ? c.name : '';
  }

  function addCollection(name) {
    const id = state.nextId++;
    state.collections.push({ id, name: name || `Libreria ${state.collections.length + 1}`, createdAt: new Date().toISOString() });
    scheduleSave();
    onChange();
    return id;
  }

  function renameCollection(id, name) {
    const c = state.collections.find((x) => x.id === id);
    if (!c) return;
    c.name = name;
    scheduleSave();
    onChange();
  }

  /** Elimina una collezione; i preset restano nella raccolta generale. */
  function removeCollection(id) {
    state.collections = state.collections.filter((c) => c.id !== id);
    for (const e of state.entries) {
      if (e.collectionId === id) e.collectionId = null;
    }
    scheduleSave();
    onChange();
  }

  function moveEntryToCollection(entryId, collectionId) {
    const e = state.entries.find((x) => x.id === entryId);
    if (!e) return;
    e.collectionId = collectionId || null;
    scheduleSave();
    onChange();
  }

  // ---------------------------------------------------------------------------
  // Ordinamento manuale
  // ---------------------------------------------------------------------------

  /** Sposta una voce prima/dopo un'altra voce. */
  function move(entryId, targetId, after = false) {
    if (entryId === targetId) return;
    const from = state.entries.findIndex((e) => e.id === entryId);
    let to = state.entries.findIndex((e) => e.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = state.entries.splice(from, 1);
    to = state.entries.findIndex((e) => e.id === targetId);
    state.entries.splice(to + (after ? 1 : 0), 0, item);
    scheduleSave();
    onChange();
  }

  /** Sposta una voce di delta posizioni (scambio con il vicino). */
  function moveBy(entryId, delta) {
    const from = state.entries.findIndex((e) => e.id === entryId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= state.entries.length) return;
    const [item] = state.entries.splice(from, 1);
    state.entries.splice(to, 0, item);
    scheduleSave();
    onChange();
  }

  /** Sposta un blocco di voci (in ordine) prima/dopo un'altra voce. */
  function moveBlock(ids, targetId, after = false) {
    const blockSet = new Set(ids);
    const block = state.entries.filter((e) => blockSet.has(e.id));
    if (!block.length) return;
    const rest = state.entries.filter((e) => !blockSet.has(e.id));
    const tIdx = rest.findIndex((e) => e.id === targetId);
    if (tIdx < 0) return;
    const insertAt = tIdx + (after ? 1 : 0);
    state.entries = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
    scheduleSave();
    onChange();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    load, save, flush, add, addAt, importRaw, remove, update, get, all,
    addTag, removeTag, toggleFavorite, allTags,
    allCategories, addCategory, removeCategory,
    allCollections, collectionName, addCollection, renameCollection, removeCollection,
    moveEntryToCollection, move, moveBy, moveBlock,
    subscribe, decodeEntry, isInitEntry, purgeInit, setRating, toggleCharacteristic,
  };
})();

if (typeof module !== 'undefined') module.exports = Library;
