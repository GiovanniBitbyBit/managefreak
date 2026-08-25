// ManageFreak — protocollo SysEx Arturia MicroFreak
//
// Framing (entrambe le direzioni):
//   F0 00 20 6B 07 01 SS LL OP [LL byte payload] F7
//   SS = contatore di sequenza (echo nella risposta)
//   LL = lunghezza payload, OP = operazione
//
// Operazioni usate (verificate su firmware 5.x):
//   0x19  lettura preset salvato (payload: bank program selector)
//   0x52  risposta header / inizio scrittura preset
//   0x15  inizio trasferimento / flow control
//   0x16  pacchetto dati (145 per preset)
//   0x17  pacchetto dati finale
//   0x18  ack / richiesta pacchetto successivo
//
// Riferimenti:
//   - https://github.com/dagargo/elektroid (connettore MicroFreak, GPL)
//   - https://github.com/kmorrill/freakout (documentazione protocollo, MIT)
//   - https://github.com/francoisgeorgy/microfreak-reader
'use strict';

const MF = (() => {
  const PRESET_PARTS = 146;
  const PART_LEN = 0x20; // 32
  const HEADER_LEN = 0x23; // 35
  const DATALEN = PRESET_PARTS * PART_LEN; // 4672
  const NAME_LEN = 14;
  const MAX_PRESETS = 512;

  const CATEGORIES = [
    'Bass', 'Brass', 'Keys', 'Lead', 'Organ', 'Pad',
    'Percussion', 'Sequence', 'SFX', 'Strings', 'Template', 'Vocoder',
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const bankOf = (id) => (id & 0x3f80) >> 7;
  const progOf = (id) => id & 0x7f;

  /**
   * Invia richiesta e restituisce {op, payload} della risposta.
   */
  async function request(op, payload, timeoutMs = 2500) {
    const msg = await Midi.requestSysex(op, payload, timeoutMs);
    return parseReply(msg);
  }

  function parseReply(msg) {
    if (msg.length < 10 || msg[0] !== 0xf0 || msg[msg.length - 1] !== 0xf7) {
      throw new Error('Malformed SysEx reply');
    }
    // header: 00 20 6B 07 01 | SS LL OP payload...
    if (!(msg[1] === 0x00 && msg[2] === 0x20 && msg[3] === 0x6b)) {
      throw new Error('Reply from a non-Arturia device');
    }
    const len = msg.length > 7 ? msg[7] : 0;
    const op = msg.length > 8 ? msg[8] : 0;
    const payload = Uint8Array.from(msg.slice(9, 9 + len));
    return { op, payload, raw: msg };
  }

  function expectReply(res, op, payloadLen, label) {
    if (res.op !== op) {
      throw new Error(`${label}: expected op 0x${op.toString(16)}, got 0x${res.op.toString(16)}`);
    }
    if (payloadLen !== null && res.payload.length !== payloadLen) {
      throw new Error(`${label}: payload length ${res.payload.length} instead of ${payloadLen}`);
    }
    return res;
  }

  function decodeHeader(payload, slotOneBased) {
    if (payload.length < HEADER_LEN) throw new Error('Preset header too short');
    let name = '';
    for (let i = 12; i < 12 + NAME_LEN; i++) {
      const c = payload[i];
      if (c === 0) break;
      name += String.fromCharCode(c & 0x7f);
    }
    return {
      slot: slotOneBased,
      bank: payload[0],
      program: payload[1],
      empty: !!(payload[3] & 0x08),
      category: payload[10],
      categoryName: CATEGORIES[payload[10]] || '',
      p1: payload[11],
      name,
      rawHeader: Uint8Array.from(payload.slice(0, HEADER_LEN)),
    };
  }

  function buildHeader({ name = '', category = 0, p1 = 0, empty = false }, slot0) {
    const h = new Uint8Array(HEADER_LEN);
    h[0] = bankOf(slot0);
    h[1] = progOf(slot0);
    h[3] = empty ? 0x08 : 0x00;
    h[8] = progOf(slot0);
    h[10] = category & 0x7f;
    h[11] = p1 & 0x7f;
    const clean = (name || '').slice(0, NAME_LEN);
    for (let i = 0; i < clean.length; i++) {
      h[12 + i] = clean.charCodeAt(i) & 0x7f;
    }
    return h;
  }

  /** Patch il nome/categoria/p1 di un header letto dal dispositivo. */
  function patchHeader(rawHeader, { name, category, p1 }) {
    const h = Uint8Array.from(rawHeader);
    if (name !== undefined) {
      const clean = (name || '').slice(0, NAME_LEN);
      for (let i = 0; i < NAME_LEN; i++) h[12 + i] = 0;
      for (let i = 0; i < clean.length; i++) h[12 + i] = clean.charCodeAt(i) & 0x7f;
    }
    if (category !== undefined) h[10] = category & 0x7f;
    if (p1 !== undefined) h[11] = p1 & 0x7f;
    return h;
  }

  // -------------------------------------------------------------------------
  // Operazioni pubbliche
  // -------------------------------------------------------------------------

  /** Legge l'header di un preset (slot 1..512). */
  async function readHeader(slot, timeoutMs = 2500) {
    const id0 = slot - 1;
    const res = await request(0x19, [bankOf(id0), progOf(id0), 0x00], timeoutMs);
    expectReply(res, 0x52, HEADER_LEN, `Header slot ${slot}`);
    return decodeHeader(res.payload, slot);
  }

  /**
   * Legge il template Init del firmware (pseudo-slot riservato: bank 4, program 0).
   * A differenza di uno slot vuoto, questo indirizzo fornisce anche il corpo
   * completo da 4672 byte (suono di default "Init").
   */
  async function readInitTemplate(timeoutMs = 2500) {
    const bank = 4;
    const prog = 0;
    const headerRes = await request(0x19, [bank, prog, 0x00], timeoutMs);
    expectReply(headerRes, 0x52, HEADER_LEN, 'Header Init template');
    const header = decodeHeader(headerRes.payload, 0);

    await sleep(5);
    const startRes = await request(0x19, [bank, prog, 0x01], timeoutMs);
    expectReply(startRes, 0x15, 0, 'Init template start');
    await sleep(5);

    const data = new Uint8Array(DATALEN);
    for (let i = 0; i < PRESET_PARTS; i++) {
      const res = await request(0x18, [0x00], timeoutMs);
      const expectedOp = i === PRESET_PARTS - 1 ? 0x17 : 0x16;
      expectReply(res, expectedOp, PART_LEN, `Init part ${i + 1}/${PRESET_PARTS}`);
      data.set(res.payload, i * PART_LEN);
    }
    await sleep(20);
    return { ...header, data };
  }

  /**
   * Legge un preset completo: header + 146 parti da 32 byte (4672 byte).
   */
  async function readPreset(slot, { onProgress, timeoutMs = 2500 } = {}) {
    const id0 = slot - 1;
    const headerRes = await request(0x19, [bankOf(id0), progOf(id0), 0x00], timeoutMs);
    expectReply(headerRes, 0x52, HEADER_LEN, `Header slot ${slot}`);
    const header = decodeHeader(headerRes.payload, slot);

    if (header.empty) {
      if (onProgress) onProgress(1, 1);
      return { ...header, data: null };
    }

    await sleep(5); // pausa tra le operazioni (come Elektroid)

    const startRes = await request(0x19, [bankOf(id0), progOf(id0), 0x01], timeoutMs);
    expectReply(startRes, 0x15, 0, `Start reading slot ${slot}`);
    await sleep(5);

    const data = new Uint8Array(DATALEN);
    for (let i = 0; i < PRESET_PARTS; i++) {
      const res = await request(0x18, [0x00], timeoutMs);
      const expectedOp = i === PRESET_PARTS - 1 ? 0x17 : 0x16;
      expectReply(res, expectedOp, PART_LEN, `Part ${i + 1}/${PRESET_PARTS} slot ${slot}`);
      data.set(res.payload, i * PART_LEN);
      if (onProgress) onProgress(i + 1, PRESET_PARTS);
    }
    await sleep(20); // pausa dopo un trasferimento completo
    return { ...header, data };
  }

  /**
   * Scrive un preset (header + corpo) in uno slot.
   * L'header viene costruito da zero (come Elektroid): i byte opachi non
   * vengono mai riciclati dal preset sorgente, per evitare corruzioni.
   * @param {object} preset {name, category, p1, data}
   */
  async function writePreset(slot, preset, { timeoutMs = 3000 } = {}) {
    const id0 = slot - 1;
    const header = buildHeader(preset, id0);
    header[0] = bankOf(id0);
    header[1] = progOf(id0);
    header[8] = progOf(id0);

    if (!preset.data || preset.data.length !== DATALEN) {
      throw new Error('Preset body missing or wrong length');
    }

    // 1. header
    let res = await request(0x52, header, timeoutMs);
    expectReply(res, 0x18, 0, `Write header slot ${slot}`);
    await sleep(5);

    // 2. inizio scrittura
    res = await request(0x52, [bankOf(id0), progOf(id0), 0x01], timeoutMs);
    expectReply(res, 0x18, 0, `Start writing slot ${slot}`);
    await sleep(5);

    // 3. flow control
    res = await request(0x15, null, timeoutMs);
    expectReply(res, 0x18, 0, `Start transfer slot ${slot}`);
    await sleep(5);

    // 4. 145 parti + finale
    // Nota: il dispositivo risponde a ogni parte ma l'opcode di risposta non è
    // documentato in modo affidabile (Elektroid non lo verifica); la garanzia
    // di correttezza è il readback completo eseguito dal chiamante.
    for (let i = 0; i < PRESET_PARTS; i++) {
      const op = i === PRESET_PARTS - 1 ? 0x17 : 0x16;
      const part = preset.data.subarray(i * PART_LEN, (i + 1) * PART_LEN);
      const msg = await Midi.requestSysex(op, part, timeoutMs);
      parseReply(msg); // valida solo l'intestazione Sysex
    }
    await sleep(20);
    return true;
  }

  /**
   * Rinomina un preset sul dispositivo senza toccarne il corpo
   * (header-write, come fa Elektroid). Aggiorna anche categoria e p1.
   */
  async function renamePreset(slot, { name, category, p1 }) {
    const id0 = slot - 1;
    const cur = await readHeader(slot);
    if (cur.empty) throw new Error(`Slot ${slot} is empty (Init)`);
    const header = patchHeader(cur.rawHeader, { name, category, p1 });

    let res = await request(0x52, header);
    // Elektroid non verifica l'opcode qui: accetta qualsiasi risposta valida.
    parseReply(res.raw);
    await sleep(5);
    res = await request(0x52, [bankOf(id0), progOf(id0), 0x01]);
    parseReply(res.raw);
    await sleep(30);
    return readHeader(slot);
  }

  /** Seleziona un preset sul dispositivo (Bank Select + Program Change).
   *  Viene trasmesso su tutti i canali MIDI: il MicroFreak risponde solo sul
   *  proprio canale di ricezione (default 1), così la selezione funziona anche
   *  se l'utente ha cambiato il canale globale del synth. */
  function selectPreset(slot) {
    const id0 = slot - 1;
    const bank = bankOf(id0);
    const prog = progOf(id0);
    for (let ch = 0; ch < 16; ch++) {
      Midi.sendCC(ch, 0, bank);
      Midi.sendCC(ch, 32, 0); // Bank LSB
      Midi.sendPC(ch, prog);
    }
  }

  /**
   * Scansiona gli header di tutti i 512 slot.
   */
  async function scanHeaders({ onProgress, onError, startSlot = 1, endSlot = 512 } = {}) {
    const out = [];
    const total = endSlot - startSlot + 1;
    let done = 0;
    for (let slot = startSlot; slot <= endSlot; slot++) {
      try {
        const h = await readHeader(slot);
        out.push(h);
      } catch (e) {
        out.push({ slot, error: String(e && e.message || e), empty: false, name: '' });
        if (onError) onError(slot, e);
      }
      done++;
      if (onProgress) onProgress(done, total);
      await sleep(4);
    }
    return out;
  }

  /**
   * Legge i preset occupati indicati. Con progresso e cancellazione.
   */
  async function readMany(slots, { onProgress, onSlot, shouldCancel, timeoutMs = 2500 } = {}) {
    const out = [];
    const total = slots.length;
    for (let i = 0; i < total; i++) {
      if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
      const slot = slots[i];
      try {
        const preset = await readPreset(slot, {
          timeoutMs,
          onProgress: (p, t) => {
            if (onProgress) onProgress({ slot, slotIndex: i, slotCount: total, part: p, parts: t });
          },
        });
        out.push(preset);
        if (onSlot) onSlot(preset);
      } catch (e) {
        if (onProgress) onProgress({ slot, slotIndex: i, slotCount: total, part: -1, parts: -1, error: e });
      }
      await sleep(4);
    }
    return out;
  }

  return {
    PRESET_PARTS, PART_LEN, HEADER_LEN, DATALEN, NAME_LEN, MAX_PRESETS,
    CATEGORIES,
    bankOf, progOf,
    sleep,
    request,
    parseReply,
    readHeader,
    readPreset,
    readInitTemplate,
    writePreset,
    renamePreset,
    selectPreset,
    scanHeaders,
    readMany,
    buildHeader,
    patchHeader,
    decodeHeader,
  };
})();

if (typeof module !== 'undefined') module.exports = MF;
if (typeof globalThis !== 'undefined') globalThis.MF = MF;
