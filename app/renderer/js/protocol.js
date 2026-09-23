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

  const isTimeoutErr = (e) => {
    const m = (e && e.message) || '';
    return m.includes('timeout') || m.includes('Timeout');
  };

  /**
   * Richiesta con retry automatico sui SOLI timeout. Usata per i comandi che
   * riavviano/resettano uno stream (header, inizio lettura blocco, selezione):
   * riprovarli è sicuro. Gli errori diversi dal timeout vengono rilanciati
   * subito. I pacchetti dati (op 0x18/0x16/0x17) NON usano il retry singolo:
   * il device è già avanzato dopo una risposta persa, quindi si riparte dal
   * blocco (vedi readSample/readPreset/readWavetable).
   */
  async function requestRetry(op, payload, timeoutMs = 2500, attempts = 3) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await request(op, payload, timeoutMs);
      } catch (e) {
        lastErr = e;
        if (!isTimeoutErr(e)) throw e;
        await sleep(40);
      }
    }
    throw lastErr;
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
    const res = await requestRetry(0x19, [bankOf(id0), progOf(id0), 0x00], timeoutMs);
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
    const headerRes = await requestRetry(0x19, [bankOf(id0), progOf(id0), 0x00], timeoutMs);
    expectReply(headerRes, 0x52, HEADER_LEN, `Header slot ${slot}`);
    const header = decodeHeader(headerRes.payload, slot);

    if (header.empty) {
      if (onProgress) onProgress(1, 1);
      return { ...header, data: null };
    }

    await sleep(5); // pausa tra le operazioni (come Elektroid)

    // lettura del corpo con retry a livello di trasferimento: se un pacchetto
    // va perso si riparte da zero (op 19 sel.1 riavvia lo stream) — mai retry
    // del singolo 0x18, che farebbe saltare un pacchetto.
    let data = null;
    for (let attempt = 0; attempt < 3 && data === null; attempt++) {
      try {
        const startRes = await requestRetry(0x19, [bankOf(id0), progOf(id0), 0x01], timeoutMs);
        expectReply(startRes, 0x15, 0, `Start reading slot ${slot}`);
        await sleep(5);

        const d = new Uint8Array(DATALEN);
        for (let i = 0; i < PRESET_PARTS; i++) {
          const res = await request(0x18, [0x00], timeoutMs);
          const expectedOp = i === PRESET_PARTS - 1 ? 0x17 : 0x16;
          expectReply(res, expectedOp, PART_LEN, `Part ${i + 1}/${PRESET_PARTS} slot ${slot}`);
          d.set(res.payload, i * PART_LEN);
          if (onProgress) onProgress(i + 1, PRESET_PARTS);
        }
        data = d;
      } catch (e) {
        if (attempt === 2 || !isTimeoutErr(e)) throw e;
        await sleep(60);
      }
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

  // -------------------------------------------------------------------------
  // Wavetable / Samples / Global settings
  // (protocollo verificato su hardware da freakout, docs/microfreak-sysex.md)
  // -------------------------------------------------------------------------

  const WAVE_SLOTS = 16;
  const WAVE_PCM_BYTES = 16384;          // 32 cicli × 256 campioni × 2 B
  const WAVE_PART_BYTES = 4096;
  const WAVE_PARTS = WAVE_PCM_BYTES / WAVE_PART_BYTES; // 4
  const WAVE_PACKETS_PER_PART = 147;     // 146 pacchetti da 28 B + 1 finale da 8 B utili

  const SAMPLE_SLOTS = 128;
  const SAMPLE_PART_BYTES = 4096;
  const SAMPLE_PACKETS_PER_PART = 147;
  const SAMPLE_HEADER_RAW = 28;
  const SAMPLE_RATE_HZ = 32000;
  const SAMPLE_MAX_SECONDS = 24;
  const SAMPLE_MAX_BYTES = SAMPLE_MAX_SECONDS * SAMPLE_RATE_HZ * 2; // 1.536.000
  const SAMPLE_TOTAL_CAPACITY_MS = 209920; // ~3,5 minuti di memoria sample

  /** 8 byte MIDI (bitmap + 7 byte) → 7 byte raw (bit 7 ripristinato). */
  function unpack8to7(data) {
    const out = new Uint8Array(Math.floor(data.length / 8) * 7);
    for (let block = 0; block * 8 + 8 <= data.length; block++) {
      const base = block * 8;
      const bitmap = data[base];
      const outBase = block * 7;
      for (let i = 0; i < 7; i++) {
        out[outBase + i] = data[base + 1 + i] | ((bitmap >> i) & 1 ? 0x80 : 0);
      }
    }
    return out;
  }

  /** 7 byte raw → 8 byte MIDI (bitmap + 7 byte a 7 bit). */
  function pack7to8(data) {
    if (data.length % 7 !== 0) throw new Error('pack7to8: input length must be a multiple of 7');
    const out = new Uint8Array((data.length / 7) * 8);
    for (let block = 0; block * 7 < data.length; block++) {
      const base = block * 7;
      const outBase = block * 8;
      let bitmap = 0;
      for (let i = 0; i < 7; i++) {
        if (data[base + i] & 0x80) bitmap |= 1 << i;
        out[outBase + 1 + i] = data[base + i] & 0x7f;
      }
      out[outBase] = bitmap;
    }
    return out;
  }

  function bytesEqual(u1, u2) {
    if (!u1 || !u2 || u1.length !== u2.length) return false;
    for (let i = 0; i < u1.length; i++) if (u1[i] !== u2[i]) return false;
    return true;
  }

  const asciiName = (bytes, start, end) => {
    let s = '';
    for (let i = start; i < end && i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0) break;
      s += String.fromCharCode(c & 0x7f);
    }
    return s;
  };

  const le16 = (b, off) => (b[off] | (b[off + 1] << 8)) & 0xffff;
  const le32 = (b, off) => ((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0);

  /** Invia una richiesta e attende una risposta sull'envelope alternativa 07 7F. */
  async function requestAlt(op, payload, timeoutMs = 2500) {
    const msg = await Midi.requestSysexAny(op, payload, timeoutMs);
    const raw = Array.from(msg);
    if (raw[0] === 0xf0) raw.shift();
    if (raw[raw.length - 1] === 0xf7) raw.pop();
    if (!(raw.length >= 8 && raw[0] === 0x00 && raw[1] === 0x20 && raw[2] === 0x6b &&
          raw[3] === 0x07 && raw[4] === 0x7f)) {
      throw new Error('Invalid alternate envelope reply');
    }
    const len = raw[6];
    const opReply = raw[7];
    return { op: opReply, payload: Uint8Array.from(raw.slice(8, 8 + len)), raw: msg };
  }

  // ------------------------------------------------------------------ globals

  const GLOBAL_CODES = {
    'midi.channel_in': 0x20, 'midi.channel_out': 0x21, 'midi.automation_in': 0x22,
    'midi.automation_out': 0x23, 'midi.output_destination': 0x25, 'midi.local_control': 0x26,
    'control.pause_exit_mode': 0x29, 'midi.program_change_enable': 0x2A,
    'midi.arp_seq_notes_out': 0x2B, 'midi.thru': 0x3B, 'midi.knob_send_cc': 0x24,
    'midi.merge': 0x3C, 'clock.source': 0x2E, 'device.id': 0x2F, 'midi.automation_14bit': 0x30,
    'clock.sync_port_timing': 0x31, 'clock.sync_port_start': 0x32, 'clock.global_tempo': 0x3D,
    'cv.pitch_format': 0x38, 'cv.gate_format': 0x39, 'cv.press_range': 0x3A,
    'cv.zero_volt_reference': 0x36, 'cv.one_volt_reference': 0x37,
    'control.knob_catch': 0x2D, 'control.click_to_load': 0x3E, 'control.help_screen': 0x40,
    'control.osc_knob_speed': 0x4C, 'control.octave_led_blink': 0x4D,
    'tuning.master': 0x42, 'memory.protection': 0x3F, 'keyboard.sensitivity': 0x41,
    'keyboard.aftertouch_curve': 0x27, 'keyboard.velocity_curve': 0x28,
    'keyboard.aftertouch_compensation': 0x33, 'keyboard.aftertouch_offset': 0x34,
    'midi.channel_in_lower': 0x35, 'keyboard.relative_bend': 0x44,
    'keyboard.scale': 0x45, 'keyboard.root_note': 0x46,
    'microphone.gain': 0x47, 'microphone.noise_gate': 0x49, 'microphone.detect': 0x4A,
    'midi.usb_to_din': 0x43,
  };

  const _range = (a, b, step = 1) => {
    const out = [];
    for (let i = a; i < b; i += step) out.push(i);
    return out;
  };
  const _seq = (labels) => ({
    values: _range(0, labels.length),
    label: (v) => labels[v] !== undefined ? labels[v] : String(v),
  });
  const _onOff = () => _seq(['Off', 'On']);
  const _map = (m) => ({ values: Object.keys(m).map(Number), label: (v) => m[v] !== undefined ? m[v] : String(v) });
  const _NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const _noteLabel = (v) => `${_NOTES[v % 12]}${Math.floor(v / 12) - 2}`;

  const GLOBAL_SPECS = {
    'midi.channel_in': { values: [..._range(0, 16), 126, 127], label: (v) => v <= 15 ? String(v + 1) : (v === 126 ? 'None' : 'All') },
    'midi.channel_out': { values: _range(0, 16), label: (v) => String(v + 1) },
    'midi.automation_in': _onOff(),
    'midi.automation_out': _onOff(),
    'midi.output_destination': _map({ 0: 'None', 1: 'USB', 4: 'MIDI', 5: 'Both' }),
    'midi.local_control': _onOff(),
    'control.pause_exit_mode': _onOff(),
    'midi.program_change_enable': _onOff(),
    'midi.arp_seq_notes_out': _onOff(),
    'midi.thru': _onOff(),
    'midi.knob_send_cc': _onOff(),
    'midi.merge': _map({ 1: 'USB+KBD', 2: 'MIDI+KBD', 3: 'MIDI+USB+KBD' }),
    'clock.source': _seq(['Internal', 'USB', 'MIDI', 'Clock', 'Auto']),
    'device.id': { values: _range(0, 127), label: (v) => String(v) },
    'midi.automation_14bit': _onOff(),
    'clock.sync_port_timing': _map({ 1: '1step (Clock)', 2: '1pulse (Korg)', 3: '24ppq', 4: '48ppq' }),
    'clock.sync_port_start': _onOff(),
    'clock.global_tempo': _onOff(),
    'cv.pitch_format': _seq(['1V/Oct', 'Hz/V', '1.2V/Oct']),
    'cv.gate_format': _seq(['S-trig', 'V-trig 5V', 'V-trig 12V']),
    'cv.press_range': { values: _range(0, 10), label: (v) => `${v + 1} V` },
    'cv.zero_volt_reference': { values: _range(0, 128), label: _noteLabel },
    'cv.one_volt_reference': { values: _range(0, 128), label: _noteLabel },
    'control.knob_catch': _seq(['Jump', 'Hook', 'Scaled']),
    'control.click_to_load': _onOff(),
    'control.help_screen': _onOff(),
    'control.osc_knob_speed': _seq(['Slow', 'Fast']),
    'control.octave_led_blink': _onOff(),
    'tuning.master': { values: _range(14, 115), label: (v) => { const c = v - 64; return `${c} cent${Math.abs(c) === 1 ? '' : 's'}`; } },
    'memory.protection': _seq(['Off', 'Factory only', 'All']),
    'keyboard.sensitivity': { values: _range(0, 91), label: (v) => `${v + 10}%` },
    'keyboard.aftertouch_curve': _seq(['Lin', 'Log', 'Exp']),
    'keyboard.velocity_curve': _seq(['Lin', 'Log', 'Exp']),
    'keyboard.aftertouch_compensation': { values: _range(0, 101, 10), label: (v) => `${v}%` },
    'keyboard.aftertouch_offset': { values: _range(0, 101), label: (v) => String(v) },
    'midi.channel_in_lower': { values: [..._range(0, 16), 126], label: (v) => v <= 15 ? String(v + 1) : 'None' },
    'keyboard.relative_bend': _onOff(),
    'keyboard.scale': _seq(['Off', 'Major', 'Minor', 'HarmoMinor', 'Dorian', 'Mixolydian', 'Blues', 'Pentatonic']),
    'keyboard.root_note': { values: _range(0, 12), label: (v) => _NOTES[v] },
    'microphone.gain': { values: [..._range(0, 72), 72], label: (v) => v === 72 ? 'Auto Gain' : `${v - 12} dB` },
    'microphone.noise_gate': { values: _range(0, 32), label: (v) => v === 0 ? 'Off' : `-${28 + 2 * v} dB` },
    'microphone.detect': _onOff(),
    'midi.usb_to_din': _onOff(),
  };

  const globalLabel = (name, value) => {
    const spec = GLOBAL_SPECS[name];
    if (!spec) return String(value);
    return spec.label(value);
  };

  /** Legge un global setting: op 43 con codice; risposta alt-op 0x42. */
  async function readGlobalCode(code, timeoutMs = 2500) {
    const res = await requestAlt(0x43, [code], timeoutMs);
    if (res.op !== 0x42 || res.payload.length !== 2 || res.payload[0] !== code) {
      throw new Error(`Invalid global reply for code 0x${code.toString(16)}`);
    }
    return res.payload[1];
  }

  async function readGlobalCodes(codes, timeoutMs = 2500) {
    const out = {};
    for (const code of codes) out[code] = await readGlobalCode(code, timeoutMs);
    return out;
  }

  async function readAllGlobals(timeoutMs = 2500) {
    const raw = await readGlobalCodes(Object.values(GLOBAL_CODES), timeoutMs);
    const out = {};
    for (const [name, code] of Object.entries(GLOBAL_CODES)) out[name] = raw[code];
    return out;
  }

  /** Scrive un global setting (op 42, nessun ack). Verifica a parte con op 43. */
  async function writeGlobalCode(code, value) {
    if (value < 0 || value > 127) throw new Error('Global value must be 0..127');
    Midi.sendSysex(0x42, [code, value]);
    await sleep(40);
  }

  async function writeGlobalSetting(name, value) {
    const code = GLOBAL_CODES[name];
    if (code === undefined) throw new Error(`Unknown global: ${name}`);
    const before = await readGlobalCode(code);
    await writeGlobalCode(code, value);
    const readback = await readGlobalCode(code);
    if (readback !== value) {
      await writeGlobalCode(code, before);
      const restored = await readGlobalCode(code);
      if (restored !== before) throw new Error('Global write failed and restore failed');
      throw new Error(`Global write failed: ${name} readback ${readback} != ${value}`);
    }
    return true;
  }

  // ------------------------------------------------------------------ wavetable

  function wavetableHeaderBytes(slot, name, { empty = false } = {}) {
    const id0 = slot - 1;
    const encoded = (name || '').slice(0, 15);
    const header = new Uint8Array(28);
    header[0] = id0;
    header[3] = empty ? 0x08 : 0;
    header[8] = id0;
    header[10] = 1;
    header[11] = 1;
    for (let i = 0; i < encoded.length; i++) header[12 + i] = encoded.charCodeAt(i) & 0x7f;
    return header;
  }

  async function setWavetableEntry(slot, name, { empty = false } = {}) {
    const id0 = slot - 1;
    let res = await request(0x56, [id0, 0, 0]);
    expectReply(res, 0x18, 0, `Wavetable reset slot ${slot}`);
    await sleep(5);
    res = await request(0x15, null);
    expectReply(res, 0x18, 0, `Wavetable start slot ${slot}`);
    await sleep(5);
    const header = wavetableHeaderBytes(slot, name, { empty });
    res = await request(0x16, pack7to8(header));
    expectReply(res, 0x18, 0, `Wavetable header slot ${slot}`);
    await sleep(5);
    res = await request(0x17, new Uint8Array(8));
    expectReply(res, 0x18, 0, `Wavetable header tail slot ${slot}`);
    await sleep(5);
  }

  async function uploadWavetableParts(slot, pcm16le, { onPart, shouldCancel } = {}) {
    if (!pcm16le || pcm16le.length !== WAVE_PCM_BYTES) {
      throw new Error(`Wavetable must be ${WAVE_PCM_BYTES} bytes`);
    }
    const id0 = slot - 1;
    for (let part = 0; part < WAVE_PARTS; part++) {
      if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
      let res = await request(0x54, [id0, part, 1]);
      expectReply(res, 0x18, 0, `Wavetable part start ${part}`);
      await sleep(5);
      res = await request(0x15, null);
      expectReply(res, 0x18, 0, `Wavetable part flow ${part}`);
      await sleep(5);
      const partData = pcm16le.subarray(part * WAVE_PART_BYTES, (part + 1) * WAVE_PART_BYTES);
      for (let packet = 0; packet < WAVE_PACKETS_PER_PART; packet++) {
        if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
        const off = packet * 28;
        let raw;
        if (packet === WAVE_PACKETS_PER_PART - 1) {
          raw = new Uint8Array(28);
          raw.set(partData.subarray(off, off + 8));
        } else {
          raw = partData.subarray(off, off + 28);
        }
        const op = packet === WAVE_PACKETS_PER_PART - 1 ? 0x17 : 0x16;
        res = await request(op, pack7to8(raw));
        expectReply(res, 0x18, 0, `Wavetable data ${part}/${packet}`);
        await sleep(5);
      }
      if (onPart) onPart(part + 1, WAVE_PARTS);
    }
  }

  async function readWavetableHeader(slot, timeoutMs = 2500) {
    const id0 = slot - 1;
    // In caso di timeout si riparte dall'INTERA sequenza (op 57 riazzera lo
    // stream): riprovare il solo pacchetto 0x18 chiederebbe il pacchetto
    // successivo, che qui non esiste, con il rischio di leggere dati di
    // un'altra operazione (header sbagliato).
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await request(0x57, [id0, 0, 0], timeoutMs);
        expectReply(res, 0x15, 0, `Wavetable header slot ${slot}`);
        await sleep(2);
        const p = await request(0x18, [0x01], timeoutMs);
        expectReply(p, 0x16, 32, `Wavetable header packet slot ${slot}`);
        const header = unpack8to7(p.payload);
        return {
          slot,
          name: asciiName(header, 12, 28),
          empty: !!(header[3] & 0x08),
          raw: Uint8Array.from(header),
        };
      } catch (e) {
        lastErr = e;
        if (!isTimeoutErr(e)) throw e;
        await sleep(50);
      }
    }
    throw lastErr;
  }

  async function readWavetable(slot, { onProgress, timeoutMs = 2500, shouldCancel } = {}) {
    // la lettura dell'header (op 57) seleziona lo slot e inizializza lo stream
    const header = await readWavetableHeader(slot, timeoutMs);
    if (header.empty) return { ...header, data: null };
    const id0 = slot - 1;

    // ripartenza completa su timeout: op 57 resetta lo stream, poi si leggono
    // di nuovo tutte le parti da capo (nessun retry dei singoli pacchetti)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await readWavetableHeader(slot, timeoutMs);
        const data = new Uint8Array(WAVE_PCM_BYTES);
        for (let part = 0; part < WAVE_PARTS; part++) {
          if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
          const res = await request(0x55, [id0, part, 0], timeoutMs);
          expectReply(res, 0x15, 0, `Wavetable part ${part} slot ${slot}`);
          await sleep(2);
          for (let packet = 0; packet < WAVE_PACKETS_PER_PART; packet++) {
            if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
            const p = await request(0x18, [0x00], timeoutMs);
            const expectedOp = packet === WAVE_PACKETS_PER_PART - 1 ? 0x17 : 0x16;
            expectReply(p, expectedOp, 32, `Wavetable packet ${part}/${packet} slot ${slot}`);
            const raw = unpack8to7(p.payload);
            const useful = packet === WAVE_PACKETS_PER_PART - 1 ? raw.subarray(0, 8) : raw;
            data.set(useful, part * WAVE_PART_BYTES + packet * 28);
          }
          if (onProgress) onProgress(part + 1, WAVE_PARTS);
        }
        return { ...header, data };
      } catch (e) {
        if (attempt === 2 || !isTimeoutErr(e)) throw e;
        await sleep(80);
      }
    }
    throw new Error(`Wavetable read failed after 3 attempts (slot ${slot})`);
  }

  async function restoreWavetable(slot, before) {
    if (!before || !before.data) {
      await setWavetableEntry(slot, '', { empty: true });
      await uploadWavetableParts(slot, new Uint8Array(WAVE_PCM_BYTES));
      const h = await readWavetableHeader(slot);
      return h.empty;
    }
    await setWavetableEntry(slot, before.name);
    await uploadWavetableParts(slot, before.data);
    const rb = await readWavetable(slot);
    return !!(rb.data && bytesEqual(rb.data, before.data));
  }

  /** Upload guardato con backup + verifica readback + rollback automatico. */
  async function writeWavetable(slot, { name, data }, { onProgress, shouldCancel } = {}) {
    const report = (f, l) => { if (onProgress) onProgress(f, l); };
    const stop = () => { if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled'); };
    report(0.02, 'Reading current slot…');
    const beforeHeader = await readWavetableHeader(slot);
    const before = beforeHeader.empty ? null : await readWavetable(slot, { shouldCancel });
    stop();
    report(0.08, 'Writing wavetable…');
    try {
      await setWavetableEntry(slot, name);
      await uploadWavetableParts(slot, data, {
        onPart: (i, t) => report(0.1 + (i / t) * 0.8, `Wavetable part ${i}/${t}`),
        shouldCancel,
      });
    } catch (e) {
      if (!(await restoreWavetable(slot, before))) {
        throw new Error(`Wavetable write failed and restore failed (${e.message})`);
      }
      throw e;
    }
    stop();
    report(0.92, 'Verifying…');
    const readback = await readWavetable(slot, { shouldCancel });
    if (!readback.data || !bytesEqual(readback.data, data)) {
      if (!(await restoreWavetable(slot, before))) {
        throw new Error('Wavetable readback mismatch and restore failed');
      }
      throw new Error('Wavetable readback mismatch; original restored');
    }
    report(1, 'Done');
    return true;
  }

  /** Svuota uno slot wavetable (header vuoto + 4 parti zero). */
  async function clearWavetable(slot) {
    const beforeHeader = await readWavetableHeader(slot);
    if (beforeHeader.empty) return true;
    const before = await readWavetable(slot);
    try {
      await setWavetableEntry(slot, '', { empty: true });
      await uploadWavetableParts(slot, new Uint8Array(WAVE_PCM_BYTES));
    } catch (e) {
      if (!(await restoreWavetable(slot, before))) {
        throw new Error(`Wavetable clear failed and restore failed (${e.message})`);
      }
      throw e;
    }
    const h = await readWavetableHeader(slot);
    if (!h.empty) {
      await restoreWavetable(slot, before);
      throw new Error('Wavetable clear verification failed; original restored');
    }
    return true;
  }

  /** Rinomina una wavetable sul dispositivo (solo header; il corpo resta). */
  async function renameWavetable(slot, newName) {
    const old = await readWavetableHeader(slot);
    if (old.empty) throw new Error(`Wavetable slot ${slot} is empty`);
    const name = (newName || 'Wavetable').slice(0, 15);
    await setWavetableEntry(slot, name);
    const check = await readWavetableHeader(slot);
    if (check.empty || check.name !== name) {
      await setWavetableEntry(slot, old.name);
      throw new Error('Wavetable rename verification failed; name restored');
    }
    return check;
  }

  // ------------------------------------------------------------------ samples

  function sampleChecksum(audio) {
    let sum = 0;
    for (let i = 0; i + 1 < audio.length; i += 2) {
      sum = (sum + (audio[i] | (audio[i + 1] << 8))) & 0xffff;
    }
    return sum;
  }

  function sampleHeaderBytes(slot, name, audio, { empty = false } = {}) {
    const id0 = slot - 1;
    const header = new Uint8Array(SAMPLE_HEADER_RAW);
    if (!empty) {
      const encoded = (name || '').slice(0, 12);
      header[4] = audio.length & 0xff;
      header[5] = (audio.length >> 8) & 0xff;
      header[6] = (audio.length >> 16) & 0xff;
      header[7] = (audio.length >> 24) & 0xff;
      const cs = sampleChecksum(audio);
      header[8] = cs & 0xff;
      header[9] = (cs >> 8) & 0xff;
      for (let i = 0; i < encoded.length; i++) header[10 + i] = encoded.charCodeAt(i) & 0x7f;
    }
    header[23] = id0;
    return header;
  }

  async function resetSampleHeader(slot, header) {
    const id0 = slot - 1;
    let res = await request(0x5a, [id0, 0, 0]);
    expectReply(res, 0x18, 0, `Sample reset slot ${slot}`);
    await sleep(5);
    res = await request(0x15, null);
    expectReply(res, 0x18, 0, `Sample start slot ${slot}`);
    await sleep(5);
    res = await request(0x17, pack7to8(header));
    expectReply(res, 0x18, 0, `Sample header slot ${slot}`);
    await sleep(5);
  }

  async function readSampleHeader(slot, timeoutMs = 2500) {
    const id0 = slot - 1;
    // come per la wavetable: su timeout si riparte dalla sequenza completa
    // (op 5B riseleziona lo slot e riazzera lo stream), mai dal solo 0x18
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await request(0x5b, [id0, 0, 0], timeoutMs);
        expectReply(res, 0x15, 0, `Sample header slot ${slot}`);
        await sleep(2);
        const p = await request(0x18, [0x00], timeoutMs);
        expectReply(p, 0x16, 32, `Sample header packet slot ${slot}`);
        const header = unpack8to7(p.payload);
        const size = le32(header, 4);
        return {
          slot,
          name: asciiName(header, 10, 23),
          address: le32(header, 0),
          sizeBytes: size,
          checksum: le16(header, 8),
          deviceId: header[23],
          empty: size === 0,
          raw: Uint8Array.from(header),
        };
      } catch (e) {
        lastErr = e;
        if (!isTimeoutErr(e)) throw e;
        await sleep(50);
      }
    }
    throw lastErr;
  }

  async function readSample(slot, { onProgress, timeoutMs = 2500, shouldCancel } = {}) {
    // la lettura dell'header (op 5B) seleziona lo slot e resetta lo stream:
    // non va mai saltata, anche se l'header è già in memoria
    const header = await readSampleHeader(slot, timeoutMs);
    if (header.empty) return { ...header, data: null };
    const id0 = slot - 1;
    const partCount = Math.ceil(header.sizeBytes / SAMPLE_PART_BYTES);

    // Ogni tentativo ri-seleziona lo slot (op 5B resetta lo stream) e legge
    // TUTTI i blocchi da capo: se un pacchetto va perso (MIDI instabile), la
    // posizione dello stream non è più affidabile, quindi si riparte da zero.
    // Niente retry del singolo 0x18 o del singolo op 59 (il device potrebbe
    // essere già avanzato: i dati risulterebbero spostati → readback mismatch).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await readSampleHeader(slot, timeoutMs); // reset stream
        const out = [];
        for (let part = 0; part < partCount; part++) {
          if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
          // L'indice di blocco DEVE stare in 7 bit: i messaggi SysEx non
          // ammettono byte > 127 (un sample > ~8,2 s supera i 128 blocchi e
          // farebbe fallire l'invio). Il device legge i blocchi in sequenza e
          // ignora il valore, quindi si maschera a 7 bit senza perdere nulla.
          const res = await request(0x59, [id0, part & 0x7f], timeoutMs);
          expectReply(res, 0x15, 0, `Sample block ${part} slot ${slot}`);
          await sleep(2);
          for (let packet = 0; packet < SAMPLE_PACKETS_PER_PART; packet++) {
            if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
            const p = await request(0x18, [0x00], timeoutMs);
            const expectedOp = packet === SAMPLE_PACKETS_PER_PART - 1 ? 0x17 : 0x16;
            expectReply(p, expectedOp, 32, `Sample packet ${part}/${packet} slot ${slot}`);
            const raw = unpack8to7(p.payload);
            if (packet === SAMPLE_PACKETS_PER_PART - 1) {
              for (let i = 0; i < 8; i++) out.push(raw[i]);
            } else {
              for (let i = 0; i < 28; i++) out.push(raw[i]);
            }
          }
          if (onProgress) onProgress(part + 1, partCount);
        }
        return { ...header, data: Uint8Array.from(out).subarray(0, header.sizeBytes) };
      } catch (e) {
        if (attempt === 2 || !isTimeoutErr(e)) throw e;
        await sleep(80); // riparte da zero con stream resettato
      }
    }
    throw new Error(`Sample read failed after 3 attempts (slot ${slot})`);
  }

  /** Statistiche memoria sample: op 47/48 (envelope alternativa). */
  async function readSampleStats(timeoutMs = 2500) {
    Midi.sendSysex(0x1c, null);
    await sleep(50);
    try {
      const res = await requestAlt(0x47, [0x0a], timeoutMs);
      if (res.op !== 0x48 || res.payload.length !== 9) {
        throw new Error(`Unexpected sample stats reply (op 0x${res.op.toString(16)}, ${res.payload.length} bytes)`);
      }
      const p = res.payload;
      const lsb = p[6] | (p[2] & 0x08 ? 0x80 : 0);
      const msb = p[7] | (p[2] & 0x04 ? 0x80 : 0);
      const usedMs = ((msb << 8) | lsb) << 2;
      const freeMs = Math.max(0, SAMPLE_TOTAL_CAPACITY_MS - usedMs);
      return {
        usedMs,
        freeMs,
        capacityMs: SAMPLE_TOTAL_CAPACITY_MS,
        usedBytes: usedMs * 64,
        freeBytes: freeMs * 64,
      };
    } finally {
      Midi.sendSysex(0x1d, null);
      await sleep(30);
    }
  }

  async function uploadSampleParts(slot, audio, { onPart, shouldCancel } = {}) {
    const id0 = slot - 1;
    const partCount = Math.ceil(audio.length / SAMPLE_PART_BYTES);
    for (let part = 0; part < partCount; part++) {
      if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
      let res = await request(0x58, [id0, 0, 1]);
      expectReply(res, 0x18, 0, `Sample block start ${part}`);
      await sleep(5);
      res = await request(0x15, null);
      expectReply(res, 0x18, 0, `Sample block flow ${part}`);
      await sleep(5);
      const partData = new Uint8Array(SAMPLE_PART_BYTES);
      partData.set(audio.subarray(part * SAMPLE_PART_BYTES, (part + 1) * SAMPLE_PART_BYTES));
      for (let packet = 0; packet < SAMPLE_PACKETS_PER_PART; packet++) {
        // annullamento reattivo: senza questo controllo un Cancel premuto
        // durante un sample lungo non aveva effetto fino alla fine del sample
        if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
        const off = packet * 28;
        let raw;
        if (packet === SAMPLE_PACKETS_PER_PART - 1) {
          raw = new Uint8Array(28);
          raw.set(partData.subarray(off, off + 8));
        } else {
          raw = partData.subarray(off, off + 28);
        }
        const op = packet === SAMPLE_PACKETS_PER_PART - 1 ? 0x17 : 0x16;
        res = await request(op, pack7to8(raw));
        expectReply(res, 0x18, 0, `Sample data ${part}/${packet}`);
        await sleep(5);
      }
      if (onPart) onPart(part + 1, partCount);
    }
  }

  async function uploadSample(slot, name, audio, { onPart, shouldCancel } = {}) {
    if (!audio || audio.length < 2 || audio.length > SAMPLE_MAX_BYTES) {
      throw new Error(`Sample PCM must be 2..${SAMPLE_MAX_BYTES} bytes`);
    }
    if (audio.length % 2) throw new Error('Sample PCM must contain complete 16-bit samples');
    const header = sampleHeaderBytes(slot, name, audio);
    const id0 = slot - 1;

    // 1. negoziazione allocazione
    let res = await request(0x5d, [id0, 0, 0]);
    expectReply(res, 0x18, 0, `Sample alloc slot ${slot}`);
    await sleep(5);
    res = await request(0x15, null);
    expectReply(res, 0x18, 0, `Sample alloc flow slot ${slot}`);
    await sleep(5);
    res = await request(0x17, pack7to8(header));
    expectReply(res, 0x16, 1, `Sample alloc accept slot ${slot}`);
    if (res.payload[0] !== 0x01) {
      throw new Error('Sample allocation refused (insufficient contiguous space)');
    }
    // seconda risposta di completamento allocazione: va CONSUMATA con un timeout
    // generoso, qualunque contenuto abbia. Se la lasciamo in coda, desincronizza
    // il reset 5A successivo e i dati scritti risultano sbagliati.
    try {
      const completionMsg = await Midi.receiveSysex(3000);
      parseReply(completionMsg); // consuma e ignora il contenuto
    } catch {
      /* nessuna risposta di completamento: ok su alcuni firmware */
    }
    await sleep(5);

    // 2. installa la voce di directory
    await resetSampleHeader(slot, header);

    // 3. trasferimento dei blocchi
    await uploadSampleParts(slot, audio, { onPart, shouldCancel });

    // 4. passaggio di stream post-upload (flusso ufficiale MCC) — con retry
    //    del flusso completo se un pacchetto va perso
    let finalized = false;
    for (let attempt = 0; attempt < 3 && !finalized; attempt++) {
      if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled');
      try {
        res = await requestRetry(0x5b, [id0, 0, 1]);
        expectReply(res, 0x15, 0, `Sample finalize slot ${slot}`);
        await sleep(5);
        for (let packet = 0; packet < SAMPLE_PACKETS_PER_PART; packet++) {
          const p = await request(0x18, [0x00]);
          const expectedOp = packet === SAMPLE_PACKETS_PER_PART - 1 ? 0x17 : 0x16;
          expectReply(p, expectedOp, 32, `Sample finalize packet ${packet}`);
          await sleep(5);
        }
        finalized = true;
      } catch (e) {
        if (attempt === 2 || !isTimeoutErr(e)) throw e;
        await sleep(60);
      }
    }
  }

  /** Reset robusto di uno slot sample (header a lunghezza zero), con retry.
   *  Ripulisce la directory anche se il device è momentaneamente instabile. */
  async function hardResetSampleSlot(slot) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await resetSampleHeader(slot, sampleHeaderBytes(slot, '', null, { empty: true }));
        await sleep(30);
        return true;
      } catch {
        await sleep(150);
      }
    }
    return false;
  }

  /** Scrittura sample con verifica readback. Non fa il backup del corpo
   *  (una lettura su slot corrotto bloccherebbe il device): se la scrittura o
   *  la verifica falliscono, lo slot viene svuotato con un HARD RESET, così
   *  non resta mai uno slot corrotto. */
  async function writeSample(slot, name, audio, { onProgress, shouldCancel } = {}) {
    const report = (f, l) => { if (onProgress) onProgress(f, l); };
    const stop = () => { if (shouldCancel && shouldCancel()) throw new Error('Operation cancelled'); };
    report(0.02, 'Checking slot…');
    await readSampleHeader(slot); // controllo che lo slot risponda prima di scrivere
    stop();
    report(0.07, 'Checking sample memory…');
    const stats = await readSampleStats();
    const padded = Math.ceil(audio.length / SAMPLE_PART_BYTES) * SAMPLE_PART_BYTES;
    if (padded > stats.freeBytes) {
      throw new Error('Not enough free sample memory for this upload');
    }
    report(0.1, 'Writing sample…');
    try {
      await uploadSample(slot, name, audio, {
        onPart: (i, t) => report(0.1 + (i / t) * 0.8, `Sample block ${i}/${t}`),
        shouldCancel,
      });
    } catch (e) {
      // HARD RESET: qualunque cosa sia successa, lo slot deve finire pulito
      const resetOk = await hardResetSampleSlot(slot);
      if (!resetOk) {
        throw new Error(`Sample write failed and slot reset failed (${e.message})`);
      }
      throw e;
    }
    stop();
    report(0.92, 'Verifying…');
    const readback = await readSample(slot, { shouldCancel });
    // Il MicroFreak azzera gli ultimi byte di un sample in memoria (granularità
    // interna): la coda può risultare 0x00 anche se noi avevamo inviato dati.
    // La tolleranza è di 512 byte (256 campioni ≈ 8 ms a 32 kHz) e vale SOLO se
    // quei byte sono identici a quanto inviato oppure azzerati: qualunque altro
    // valore è una corruzione vera e fa fallire la verifica.
    const TAIL_TOLERANCE = 512;
    const strictLen = audio.length > TAIL_TOLERANCE ? audio.length - TAIL_TOLERANCE : audio.length;
    let rbOk = !!(readback.data && readback.data.length >= audio.length &&
      bytesEqual(readback.data.subarray(0, strictLen), audio.subarray(0, strictLen)));
    if (rbOk) {
      for (let i = strictLen; i < audio.length; i++) {
        const got = readback.data[i];
        if (got !== audio[i] && got !== 0) { rbOk = false; break; }
      }
    }
    if (!rbOk) {
      let diag;
      if (!readback.data) {
        diag = 'no data read back';
      } else if (readback.data.length !== audio.length) {
        diag = `size differs (sent ${audio.length} bytes, read ${readback.data.length})`;
      } else {
        // stesso numero di byte ma contenuto diverso: trova il primo offset
        let off = -1;
        for (let i = 0; i < audio.length; i++) {
          if (readback.data[i] !== audio[i]) { off = i; break; }
        }
        diag = off >= 0
          ? `content differs at byte ${off} (sent 0x${audio[off].toString(16).padStart(2, '0')}, read 0x${readback.data[off].toString(16).padStart(2, '0')})`
          : 'content differs (unknown offset)';
      }
      // HARD RESET: mai lasciare uno slot corrotto dopo un mismatch
      const resetOk = await hardResetSampleSlot(slot);
      if (!resetOk) {
        throw new Error(`Sample readback mismatch and slot reset failed (${diag})`);
      }
      throw new Error(`Sample readback mismatch (${diag}); slot reset to empty`);
    }
    report(1, 'Done');
    return true;
  }

  /** Svuota uno slot sample (header di lunghezza zero).
   *  Come MCC, esegue il reset della directory direttamente (op 5A), SENZA
   *  leggere prima il corpo: su uno slot corrotto una lettura andrebbe in
   *  timeout e lascerebbe il device bloccato. La pulizia è quindi immediata. */
  async function clearSample(slot) {
    await resetSampleHeader(slot, sampleHeaderBytes(slot, '', null, { empty: true }));
    const h = await readSampleHeader(slot);
    if (!h.empty) throw new Error('Sample clear verification failed');
    return true;
  }

  /** Rinomina un sample sul dispositivo (solo header; corpo e indirizzo restano). */
  async function renameSample(slot, newName) {
    const old = await readSampleHeader(slot);
    if (old.empty) throw new Error(`Sample slot ${slot} is empty`);
    const name = (newName || 'Sample').slice(0, 12);
    // copia l'header originale (indirizzo/dimensione/checksum restano) e cambia il nome
    const header = Uint8Array.from(old.raw);
    for (let i = 10; i < 23; i++) header[i] = 0;
    for (let i = 0; i < name.length; i++) header[10 + i] = name.charCodeAt(i) & 0x7f;
    await resetSampleHeader(slot, header);
    const check = await readSampleHeader(slot);
    if (check.empty || check.name !== name) {
      await resetSampleHeader(slot, old.raw);
      throw new Error('Sample rename verification failed; name restored');
    }
    return check;
  }

  // ------------------------------------------------------------------ riordino (swap/shift)

  async function restoreWavetableEntries(backup) {
    for (const [from, p] of backup) {
      await setWavetableEntry(from, p.name);
      await uploadWavetableParts(from, p.data);
    }
  }

  /** Riordina wavetable: backup di tutte le sorgenti, scritture, verifica, rollback. */
  async function reorderWavetables(writes, movedSlots, { onProgress } = {}) {
    const report = (f, l) => { if (onProgress) onProgress(f, l); };
    const backup = new Map();
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i];
      const p = await readWavetable(w.from);
      if (!p.data) throw new Error(`Wavetable slot ${w.from} has no body`);
      backup.set(w.from, p);
      report((i / writes.length) * 0.4, `Backing up slot ${w.from}…`);
    }
    try {
      for (let k = 0; k < writes.length; k++) {
        const w = writes[k];
        const p = backup.get(w.from);
        await setWavetableEntry(w.to, p.name);
        await uploadWavetableParts(w.to, p.data);
        report(0.4 + (k / writes.length) * 0.5, `Writing slot ${w.to}…`);
      }
    } catch (e) {
      await restoreWavetableEntries(backup);
      throw new Error(`Wavetable reorder failed and was restored (${e.message})`);
    }
    report(0.95, 'Verifying…');
    for (const w of writes) {
      const expected = backup.get(w.from);
      const h = await readWavetableHeader(w.to);
      if (h.empty || h.name !== expected.name) {
        await restoreWavetableEntries(backup);
        throw new Error(`Wavetable reorder verification failed at slot ${w.to}; restored`);
      }
    }
    const movedSet = new Set(movedSlots);
    for (const w of writes) {
      if (!movedSet.has(w.from)) continue;
      const expected = backup.get(w.from);
      const rb = await readWavetable(w.to);
      if (!rb.data || !bytesEqual(rb.data, expected.data)) {
        await restoreWavetableEntries(backup);
        throw new Error(`Wavetable reorder body verification failed at slot ${w.to}; restored`);
      }
    }
    report(1, 'Done');
    return true;
  }

  async function restoreSampleEntries(backup) {
    for (const [from, raw] of backup) {
      const header = Uint8Array.from(raw);
      header[23] = (from - 1) & 0x7f;
      await resetSampleHeader(from, header);
    }
  }

  /** Riordina sample SOLO tramite voci di directory: i corpi audio non si muovono. */
  async function reorderSamples(writes, movedSlots, { onProgress } = {}) {
    const report = (f, l) => { if (onProgress) onProgress(f, l); };
    const backup = new Map();
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i];
      const h = await readSampleHeader(w.from);
      if (h.empty) throw new Error(`Sample slot ${w.from} is empty`);
      backup.set(w.from, Uint8Array.from(h.raw));
      report((i / writes.length) * 0.4, `Backing up slot ${w.from}…`);
    }
    try {
      for (let k = 0; k < writes.length; k++) {
        const w = writes[k];
        const raw = backup.get(w.from);
        const header = Uint8Array.from(raw);
        header[23] = (w.to - 1) & 0x7f;
        await resetSampleHeader(w.to, header);
        report(0.4 + (k / writes.length) * 0.5, `Writing slot ${w.to}…`);
      }
    } catch (e) {
      await restoreSampleEntries(backup);
      throw new Error(`Sample reorder failed and was restored (${e.message})`);
    }
    report(0.95, 'Verifying…');
    for (const w of writes) {
      const raw = backup.get(w.from);
      const expectedName = asciiName(raw, 10, 23);
      const expectedSize = le32(raw, 4);
      const h = await readSampleHeader(w.to);
      if (h.empty || h.name !== expectedName || h.sizeBytes !== expectedSize) {
        await restoreSampleEntries(backup);
        throw new Error(`Sample reorder verification failed at slot ${w.to}; restored`);
      }
    }
    report(1, 'Done');
    return true;
  }

  // -------------------------------------------------------------------------
  // Lock seriale sulle transazioni MIDI: il MicroFreak ha un unico stream,
  // quindi richieste concorrenti (es. due letture in parallelo) si
  // sovrascriverebbero a vicenda. Tutte le operazioni pubbliche passano da qui.
  // -------------------------------------------------------------------------

  let _deviceQueue = Promise.resolve();
  function withDeviceLock(fn) {
    const run = _deviceQueue.then(fn, fn);
    _deviceQueue = run.catch(() => {});
    return run;
  }
  const locked = (fn) => (...args) => withDeviceLock(() => fn(...args));

  return {
    PRESET_PARTS, PART_LEN, HEADER_LEN, DATALEN, NAME_LEN, MAX_PRESETS,
    CATEGORIES,
    bankOf, progOf,
    sleep,
    request,
    parseReply,
    readHeader: locked(readHeader),
    readPreset: locked(readPreset),
    readInitTemplate: locked(readInitTemplate),
    writePreset: locked(writePreset),
    renamePreset: locked(renamePreset),
    selectPreset,
    scanHeaders: locked(scanHeaders),
    readMany: locked(readMany),
    buildHeader,
    patchHeader,
    decodeHeader,
    unpack8to7,
    pack7to8,
    bytesEqual,
    requestAlt,
    WAVE_SLOTS, WAVE_PCM_BYTES, WAVE_PART_BYTES, WAVE_PARTS, WAVE_PACKETS_PER_PART,
    SAMPLE_SLOTS, SAMPLE_PART_BYTES, SAMPLE_PACKETS_PER_PART, SAMPLE_MAX_BYTES,
    SAMPLE_TOTAL_CAPACITY_MS, SAMPLE_RATE_HZ,
    GLOBAL_CODES, GLOBAL_SPECS, globalLabel,
    readGlobalCode: locked(readGlobalCode),
    readGlobalCodes: locked(readGlobalCodes),
    readAllGlobals: locked(readAllGlobals),
    writeGlobalCode: locked(writeGlobalCode),
    writeGlobalSetting: locked(writeGlobalSetting),
    readWavetableHeader: locked(readWavetableHeader),
    readWavetable: locked(readWavetable),
    writeWavetable: locked(writeWavetable),
    clearWavetable: locked(clearWavetable),
    renameWavetable: locked(renameWavetable),
    readSampleHeader: locked(readSampleHeader),
    readSample: locked(readSample),
    readSampleStats: locked(readSampleStats),
    writeSample: locked(writeSample),
    clearSample: locked(clearSample),
    renameSample: locked(renameSample),
    reorderWavetables: locked(reorderWavetables),
    reorderSamples: locked(reorderSamples),
  };
})();

if (typeof module !== 'undefined') module.exports = MF;
if (typeof globalThis !== 'undefined') globalThis.MF = MF;
