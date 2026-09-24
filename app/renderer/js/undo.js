// ManageFreak — annullamento delle operazioni (undo)
//
// Le operazioni distruttive dell'app (scritture di preset, svuotamenti, cambio
// volume, wavetable, campioni, libreria del PC) leggono già il contenuto
// precedente per ripristinarlo in caso di errore: prima veniva buttato via a
// operazione riuscita, qui viene conservato per poter tornare indietro.
//
// Il modulo tiene solo i DATI e le etichette: chi lo usa decide come riscrivere
// il synth (vedi app.js). Una "transazione" raggruppa più scritture in una sola
// voce annullabile, così un invio multiplo resta un unico "Torna indietro".
'use strict';

const Undo = (() => {
  const MAX_ENTRIES = 5; // quante operazioni si possono annullare
  const MAX_BYTES = 24 * 1024 * 1024; // memoria massima dello stack

  let stack = []; // la voce più recente è l'ultima
  let open = null; // transazione in corso

  /** Stima dei byte occupati da un valore (per il limite di memoria). */
  function sizeOf(v) {
    if (v == null) return 0;
    if (v instanceof Uint8Array) return v.length;
    if (Array.isArray(v)) return v.reduce((n, x) => n + sizeOf(x), 0);
    if (typeof v === 'object') return Object.values(v).reduce((n, x) => n + sizeOf(x), 0);
    if (typeof v === 'string') return v.length;
    return 8;
  }

  /**
   * Apre una transazione. Tutte le registrazioni che seguono finiscono nella
   * stessa voce, con una sola etichetta leggibile.
   */
  function begin(label) {
    if (open) commit(); // una transazione dimenticata aperta non va persa
    open = { label: String(label || 'Operation'), presets: new Map(), wavetables: new Map(), samples: new Map(), library: null, bytes: 0 };
    return open;
  }

  const active = () => !!open;
  const label = () => (open ? open.label : (stack.length ? stack[stack.length - 1].label : ''));

  /** Vero se la transazione in corso ha qualcosa da annullare. */
  function hasChanges() {
    if (!open) return false;
    return open.presets.size > 0 || open.wavetables.size > 0 || open.samples.size > 0 || !!open.library;
  }

  /** Stato precedente di uno slot di preset (il primo registrato è quello buono). */
  function recordPreset(slot, prev) {
    if (!open || open.presets.has(slot)) return;
    open.presets.set(slot, prev || null);
    open.bytes += sizeOf(prev);
  }

  function recordWavetable(slot, prev) {
    if (!open || open.wavetables.has(slot)) return;
    open.wavetables.set(slot, prev || null);
    open.bytes += sizeOf(prev);
  }

  function recordSample(slot, prev) {
    if (!open || open.samples.has(slot)) return;
    open.samples.set(slot, prev || null);
    open.bytes += sizeOf(prev);
  }

  /**
   * Stato precedente della libreria del PC: ordine degli id, voci rimosse (con
   * l'indice che avevano) e campi modificati (id -> valori precedenti).
   */
  function recordLibrary(part) {
    if (!open) return;
    if (!open.library) open.library = { order: null, removed: [], added: [], fields: new Map() };
    const lib = open.library;
    if (part.order) lib.order = part.order.slice();
    if (part.removed) {
      for (const r of part.removed) {
        if (!lib.removed.some((x) => x.entry && x.entry.id === r.entry.id && x.index === r.index)) {
          lib.removed.push(r);
          open.bytes += sizeOf(r.entry);
        }
      }
    }
    // voci AGGIUNTE alla libreria (import dal device, file importati): annullando
    // vanno tolte di nuovo, altrimenti resterebbero duplicati
    if (part.added) {
      for (const id of part.added) {
        if (!lib.added.includes(id)) { lib.added.push(id); open.bytes += 8; }
      }
    }
    if (part.fields) {
      for (const [id, prev] of part.fields) {
        if (!lib.fields.has(id)) { lib.fields.set(id, prev); open.bytes += sizeOf(prev); }
      }
    }
  }

  /** Chiude la transazione: entra nello stack solo se ha qualcosa da annullare. */
  function commit() {
    if (!open) return false;
    const tx = open;
    open = null;
    if (!hasChangesTx(tx)) return false;
    stack.push(tx);
    // limiti: numero di voci e memoria occupata
    while (stack.length > MAX_ENTRIES) stack.shift();
    let total = stack.reduce((n, t) => n + t.bytes, 0);
    while (stack.length > 1 && total > MAX_BYTES) {
      total -= stack[0].bytes;
      stack.shift();
    }
    return true;
  }

  function hasChangesTx(tx) {
    return tx.presets.size > 0 || tx.wavetables.size > 0 || tx.samples.size > 0 || !!tx.library;
  }

  /** Butta la transazione in corso (operazione fallita o annullata). */
  function abort() {
    open = null;
  }

  const canUndo = () => stack.length > 0;
  const depth = () => stack.length;

  /** Etichetta dell'operazione annullabile più recente. */
  function undoLabel() {
    return stack.length ? stack[stack.length - 1].label : '';
  }

  /** Contenuto della voce più recente, senza rimuoverla. */
  function peek() {
    return stack.length ? stack[stack.length - 1] : null;
  }

  /** Estrae la voce più recente: chi la prende si occupa di eseguire il ripristino. */
  function take() {
    return stack.length ? stack.pop() : null;
  }

  /** Rimette in cima una voce (se il ripristino non è riuscito). */
  function push(tx) {
    if (tx) stack.push(tx);
  }

  function clear() {
    stack = [];
    open = null;
  }

  /** Riepilogo leggibile di una voce, per la conferma prima di annullare. */
  function describe(tx) {
    if (!tx) return [];
    const out = [];
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (tx.presets.size) {
      const slots = [...tx.presets.keys()].sort((a, b) => a - b);
      const elenco = slots.slice(0, 12).join(', ') + (slots.length > 12 ? ', …' : '');
      out.push(`${plural(slots.length, 'slot', 'slots')} (${elenco})`);
    }
    if (tx.wavetables.size) {
      const slots = [...tx.wavetables.keys()].sort((a, b) => a - b);
      out.push(`${plural(slots.length, 'wavetable', 'wavetables')} (${slots.join(', ')})`);
    }
    if (tx.samples.size) {
      const slots = [...tx.samples.keys()].sort((a, b) => a - b);
      out.push(`${plural(slots.length, 'sample', 'samples')} (${slots.join(', ')})`);
    }
    if (tx.library) {
      const l = tx.library;
      if (l.removed.length) out.push(`${plural(l.removed.length, 'preset', 'presets')} removed from the library`);
      if (l.added && l.added.length) out.push(`${plural(l.added.length, 'preset', 'presets')} added to the library`);
      if (l.order) out.push('library order');
      if (l.fields.size) out.push(`${plural(l.fields.size, 'preset', 'presets')} modified`);
    }
    return out;
  }

  /** Avvertenze legate alla voce (righe aggiuntive, sempre in inglese). */
  function notes(tx) {
    if (!tx) return [];
    const out = [];
    const vuoti = [...tx.presets.values()].filter((p) => !p).length;
    if (vuoti) {
      out.push(vuoti === 1
        ? '1 slot was empty: it comes back as the firmware Init preset.'
        : `${vuoti} slots were empty: they come back as the firmware Init preset.`);
    }
    if (tx.samples.size || tx.wavetables.size) {
      out.push('Empty wavetable and sample slots cannot be emptied again by the protocol.');
    }
    return out;
  }

  return {
    begin, commit, abort, active, label, hasChanges,
    recordPreset, recordWavetable, recordSample, recordLibrary,
    canUndo, depth, undoLabel, peek, take, push, clear, describe, notes,
    MAX_ENTRIES, MAX_BYTES,
  };
})();

if (typeof module !== 'undefined') module.exports = Undo;
if (typeof globalThis !== 'undefined') globalThis.Undo = Undo;
