// ManageFreak — test runner (senza dipendenze)
'use strict';

const assert = require('assert');
const path = require('path');

// ---------------------------------------------------------------------------
// Stub Midi con risposte scriptate
// ---------------------------------------------------------------------------

function makeMidiStub() {
  const calls = [];
  let script = [];
  let anyScript = [];
  let receiveQueue = [];
  let replyFn = null; // modalità generativa: (op, payload, index) => messaggio
  let replyIndex = 0;
  // I messaggi SysEx ammettono SOLO byte 0..127: se l'app prova a inviare un
  // valore più grande, Web MIDI (e il device) rifiutano il messaggio.
  const assertSysexClean = (op, payload) => {
    if (!payload) return;
    for (let i = 0; i < payload.length; i++) {
      const b = payload[i];
      if (!Number.isInteger(b) || b < 0 || b > 127) {
        throw new Error(
          `payload SysEx non valido per op 0x${op.toString(16)}: byte ${b} all'indice ${i} (ammessi solo 0..127)`
        );
      }
    }
  };
  return {
    calls,
    queue(...msgs) { script = msgs; },
    queueAny(...msgs) { anyScript = msgs; },
    queueReceive(...msgs) { receiveQueue = msgs; },
    /** Risposte generate al volo (per flussi lunghi: evita script enormi). */
    queueReplies(fn) { replyFn = fn; replyIndex = 0; },
    get remaining() { return script.length; },
    Midi: {
      requestSysex: async (op, payload) => {
        assertSysexClean(op, payload);
        calls.push({ op, payload: payload ? Array.from(payload) : null });
        if (replyFn) return Uint8Array.from(replyFn(op, payload, replyIndex++));
        const next = script.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('script esaurito');
        return Uint8Array.from(next);
      },
      requestSysexAny: async (op, payload) => {
        assertSysexClean(op, payload);
        calls.push({ op, payload: payload ? Array.from(payload) : null, any: true });
        const next = anyScript.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('script any esaurito');
        return Uint8Array.from(next);
      },
      receiveSysex: async () => {
        const next = receiveQueue.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('receive esaurito');
        return Uint8Array.from(next);
      },
      sendSysex: (op, payload) => {
        assertSysexClean(op, payload);
        calls.push({ op, payload: payload ? Array.from(payload) : null, send: true });
      },
      sendCC: () => {},
      sendPC: () => {},
    },
  };
}

global.Midi = makeMidiStub().Midi;
const MF = require('../renderer/js/protocol.js');
const Mfp = require('../renderer/js/mfp.js');
const Params = require('../renderer/js/params.js');

// stub window.mfapi per la libreria
global.window = {
  mfapi: {
    fileExists: async () => false,
    readFile: async () => '',
    writeFile: async () => true,
    listDir: async () => [],
  },
};
const Library = require('../renderer/js/library.js');
const Shift = require('../renderer/js/shift.js');

// ---------------------------------------------------------------------------
// helper per costruire messaggi sysex
// ---------------------------------------------------------------------------

const sysex = (seq, op, payload) => {
  const p = payload ? Array.from(payload) : [];
  return [0xf0, 0x00, 0x20, 0x6b, 0x07, 0x01, seq, p.length, op, ...p, 0xf7];
};

const headerPayload = ({ bank = 0, program = 0, name = 'Test', category = 3, p1 = 7, empty = false } = {}) => {
  const h = new Uint8Array(35);
  h[0] = bank;
  h[1] = program;
  h[3] = empty ? 0x08 : 0;
  h[8] = program;
  h[10] = category;
  h[11] = p1;
  for (let i = 0; i < name.length && i < 14; i++) h[12 + i] = name.charCodeAt(i);
  return h;
};

const part = (seed) => {
  const p = new Uint8Array(32);
  for (let i = 0; i < 32; i++) p[i] = (seed + i) & 0xff;
  return p;
};

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}`);
    console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e));
  }
}

(async () => {
  console.log('Test ManageFreak\n');

  // ================================================================== MFP
  console.log('Formato .mfp:');

  await test('round-trip .mfp con byte >127 e nome', () => {
    const data = new Uint8Array(4672);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
    const out = Mfp.serializeMfp({ name: 'My Preset', category: 5, init: 0, p1: 127, data });
    const parsed = Mfp.parseMfp(out);
    assert.strictEqual(parsed.version, '174');
    assert.strictEqual(parsed.name, 'My Preset');
    assert.strictEqual(parsed.category, 5);
    assert.strictEqual(parsed.init, 0);
    assert.strictEqual(parsed.p1, 127);
    assert.strictEqual(parsed.data.length, 4672);
    assert.deepStrictEqual(parsed.characteristics, []);
    for (let i = 0; i < data.length; i++) assert.strictEqual(parsed.data[i], data[i]);
  });

  await test('characteristics: round-trip del campo a 18 bit', () => {
    const data = new Uint8Array(4672);
    const chars = ['Acid', 'Bright', 'Soundtrack', 'Quiet'];
    const out = Mfp.serializeMfp({ name: 'X', category: 0, init: 0, p1: 0, data, characteristics: chars });
    const parsed = Mfp.parseMfp(out);
    assert.deepStrictEqual([...parsed.characteristics].sort(), [...chars].sort());
    // Acid è il bit più a destra, Soundtrack il più a sinistra
    const text = new TextDecoder().decode(out);
    const bitset = text.split(' ').find((t) => /^[01]{18}$/.test(t));
    assert.ok(bitset, 'bitset presente');
    assert.strictEqual(bitset[17], '1'); // Acid
    assert.strictEqual(bitset[0], '1'); // Soundtrack
    assert.strictEqual(bitset[16], '0'); // Aggressive no
  });

  await test('parse .mfp di riferimento (come scritto da MCC/Elektroid)', () => {
    const data = new Uint8Array(4672);
    data[0] = 0xff; // → -1 nel file
    data[1] = 0x80; // → -128
    data[2] = 0x7f; // → 127
    let text = '22 serialization::archive 10 0 4 3 174 4 Test 2 0 0 18 000000000000000000 0 0 99 4672';
    for (let i = 0; i < data.length; i++) {
      text += ' ' + (data[i] > 127 ? data[i] - 256 : data[i]);
    }
    text += '\n';
    const parsed = Mfp.parseMfp(new TextEncoder().encode(text));
    assert.strictEqual(parsed.name, 'Test');
    assert.strictEqual(parsed.category, 2);
    assert.strictEqual(parsed.p1, 99);
    assert.strictEqual(parsed.data[0], 0xff);
    assert.strictEqual(parsed.data[1], 0x80);
    assert.strictEqual(parsed.data[2], 0x7f);
  });

  await test('parse .mfp con nome vuoto e init=1', () => {
    const data = new Uint8Array(4672);
    const text = `22 serialization::archive 10 0 4 3 174 0  0 0 0 18 000000000000000000 1 0 5 4672${' 0'.repeat(4672)}\n`;
    const parsed = Mfp.parseMfp(new TextEncoder().encode(text));
    assert.strictEqual(parsed.name, '');
    assert.strictEqual(parsed.init, 1);
    assert.strictEqual(parsed.p1, 5);
  });

  await test('parse .mfp Init vuoto (datalen=0) → init=1 e corpo vuoto', () => {
    const text = `22 serialization::archive 10 0 4 3 174 4 Init 0 0 0 18 000000000000000000 1 0 0 0\n`;
    const parsed = Mfp.parseMfp(new TextEncoder().encode(text));
    assert.strictEqual(parsed.name, 'Init');
    assert.strictEqual(parsed.init, 1);
    assert.strictEqual(parsed.data.length, 0);
  });

  console.log('ZIP (.mfpz/.mfprojz):');

  await test('round-trip zip (stored)', async () => {
    const zip = await Mfp.writeZip([
      { name: '0_preset', data: new TextEncoder().encode('ciao') },
      { name: 'project/bank/001-file.mbp', data: new TextEncoder().encode('secondo') },
    ]);
    const entries = await Mfp.readZip(zip);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].name, '0_preset');
    assert.strictEqual(new TextDecoder().decode(entries[0].data), 'ciao');
    assert.strictEqual(entries[1].name, 'project/bank/001-file.mbp');
    assert.strictEqual(new TextDecoder().decode(entries[1].data), 'secondo');
  });

  await test('lettura zip deflate (generato con zlib)', async () => {
    const zlib = require('zlib');
    // costruisci zip minimale deflate a mano
    const nameB = Buffer.from('x.mfp');
    const raw = Buffer.from('contenuto deflato');
    const compressed = zlib.deflateRawSync(raw);
    const crc = Mfp.crc32(new Uint8Array(raw));
    const chunks = [];
    const u16 = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff]);
    const u32 = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
    const localOff = 0;
    chunks.push(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    chunks.push(u16(20), u16(0), u16(8), u16(0), u16(0x21));
    chunks.push(u32(crc), u32(compressed.length), u32(raw.length));
    chunks.push(u16(nameB.length), u16(0));
    chunks.push(nameB, compressed);
    const cdStart = chunks.reduce((a, c) => a + c.length, 0);
    chunks.push(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    chunks.push(u16(20), u16(20), u16(0), u16(8), u16(0), u16(0x21));
    chunks.push(u32(crc), u32(compressed.length), u32(raw.length));
    chunks.push(u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOff));
    chunks.push(nameB);
    const cdSize = chunks.reduce((a, c) => a + c.length, 0) - cdStart;
    chunks.push(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    chunks.push(u16(0), u16(0), u16(1), u16(1), u32(cdSize), u32(cdStart), u16(0));
    const zip = Buffer.concat(chunks);
    const entries = await Mfp.readZip(new Uint8Array(zip));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(new TextDecoder().decode(entries[0].data), 'contenuto deflato');
  });

  await test('round-trip .mfpz', async () => {
    const data = new Uint8Array(4672);
    data.fill(42);
    const z = await Mfp.serializeMfpz({ name: 'ZipPreset', category: 8, init: 0, p1: 0, data });
    const parsed = await Mfp.parseMfpz(z);
    assert.strictEqual(parsed.name, 'ZipPreset');
    assert.strictEqual(parsed.data[1000], 42);
  });

  await test('.mfprojz con più preset ordinati', async () => {
    const mk = (name, cat) => {
      const data = new Uint8Array(4672);
      return Mfp.serializeMfp({ name, category: cat, init: 0, p1: 0, data });
    };
    const zip = await Mfp.writeZip([
      { name: 'project/bank/002-two.mbp', data: mk('Two', 2) },
      { name: 'project/bank/001-one.mbp', data: mk('One', 1) },
    ]);
    const presets = await Mfp.parseMfprojz(zip);
    assert.strictEqual(presets.length, 2);
    assert.strictEqual(presets[0].fileName, '001-one.mbp');
    assert.strictEqual(presets[0].name, 'One');
    assert.strictEqual(presets[1].name, 'Two');
  });

  await test('serializeMfprojz → parseMfprojz round-trip (bank completa)', async () => {
    const presets = [];
    for (let slot = 1; slot <= 4; slot++) {
      const data = new Uint8Array(4672);
      data.fill(slot);
      presets.push({ slot, name: `Preset${slot}`, category: slot % 11, p1: slot, data });
    }
    const bytes = await Mfp.serializeMfprojz(presets);
    const parsed = await Mfp.parseMfprojz(bytes);
    assert.strictEqual(parsed.length, 4);
    assert.strictEqual(parsed[0].fileName, '001-Preset1.mbp');
    assert.strictEqual(parsed[0].name, 'Preset1');
    assert.strictEqual(parsed[3].name, 'Preset4');
    for (const p of parsed) {
      const idx = parseInt(p.name.replace('Preset', ''), 10) - 1;
      assert.strictEqual(p.data[100], idx + 1);
    }
  });

  await test('.syx da header + 146 parti', () => {
    const messages = [];
    messages.push(Uint8Array.from(sysex(0x10, 0x52, headerPayload({ bank: 1, program: 5, name: 'SyxTest', category: 4, p1: 9 }))));
    for (let i = 0; i < 146; i++) {
      messages.push(Uint8Array.from(sysex(0x11 + (i & 0x0f), i === 145 ? 0x17 : 0x16, part(i))));
    }
    const total = messages.reduce((a, m) => a + m.length, 0);
    const blob = new Uint8Array(total);
    let off = 0;
    for (const m of messages) {
      blob.set(m, off);
      off += m.length;
    }
    const preset = Mfp.parseSyx(blob);
    assert.strictEqual(preset.name, 'SyxTest');
    assert.strictEqual(preset.category, 4);
    assert.strictEqual(preset.p1, 9);
    assert.strictEqual(preset.data.length, 4672);
    assert.strictEqual(preset.data[0], 0); // part(0)[0] = (0+0)&0xff
    assert.strictEqual(preset.data[32], 1); // part(1)[0] = (1+0)&0xff
    assert.strictEqual(preset.data[4671], (145 + 31) & 0xff);
  });

  // ================================================================== PROTOCOLLO
  console.log('Protocollo:');

  await test('readHeader decodifica la risposta 0x52', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    stub.queue(sysex(0x00, 0x52, headerPayload({ name: 'BassoGrosso', category: 0, p1: 3 })));
    const h = await MF.readHeader(1);
    assert.strictEqual(h.name, 'BassoGrosso');
    assert.strictEqual(h.category, 0);
    assert.strictEqual(h.p1, 3);
    assert.strictEqual(h.empty, false);
    assert.strictEqual(h.slot, 1);
    assert.deepStrictEqual(stub.calls[0], { op: 0x19, payload: [0, 0, 0] });
  });

  await test('readHeader slot 300 → bank 2, program 43', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    stub.queue(sysex(0x01, 0x52, headerPayload({ bank: 2, program: 43, name: 'X' })));
    await MF.readHeader(300);
    assert.deepStrictEqual(stub.calls[0], { op: 0x19, payload: [2, 43, 0] });
  });

  await test('readPreset assembla 146 parti', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    stub.queue(
      sysex(0x00, 0x52, headerPayload({ name: 'Full' })),
      sysex(0x01, 0x15, null),
      ...Array.from({ length: 146 }, (_, i) => sysex(0x02 + (i & 0x7f), i === 145 ? 0x17 : 0x16, part(i))),
    );
    const preset = await MF.readPreset(1);
    assert.strictEqual(preset.name, 'Full');
    assert.strictEqual(preset.data.length, 4672);
    assert.strictEqual(preset.data[0], 0);
    assert.strictEqual(preset.data[4671], (145 + 31) & 0xff);
    assert.strictEqual(stub.calls[0].op, 0x19);
    assert.deepStrictEqual(stub.calls[0].payload, [0, 0, 0]);
    assert.strictEqual(stub.calls[1].op, 0x19);
    assert.deepStrictEqual(stub.calls[1].payload, [0, 0, 1]);
    for (let i = 0; i < 146; i++) {
      assert.strictEqual(stub.calls[2 + i].op, 0x18);
      assert.deepStrictEqual(stub.calls[2 + i].payload, [0]);
    }
  });

  await test('readPreset su slot vuoto (init) non legge il corpo', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    stub.queue(sysex(0x00, 0x52, headerPayload({ empty: true })));
    const preset = await MF.readPreset(9);
    assert.strictEqual(preset.empty, true);
    assert.strictEqual(preset.data, null);
    assert.strictEqual(stub.calls.length, 1);
  });

  await test('readInitTemplate legge il template firmware (bank 4, program 0) con corpo', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const initHeader = headerPayload({ bank: 4, program: 0, name: 'Init', empty: true });
    stub.queue(
      sysex(0x00, 0x52, initHeader),
      sysex(0x01, 0x15, null),
      ...Array.from({ length: 146 }, (_, i) => sysex(0x02 + (i & 0x7f), i === 145 ? 0x17 : 0x16, part(i))),
    );
    const t = await MF.readInitTemplate();
    assert.strictEqual(t.name, 'Init');
    assert.strictEqual(t.data.length, 4672);
    assert.strictEqual(t.data[0], 0);
    assert.strictEqual(t.data[4671], (145 + 31) & 0xff);
    assert.deepStrictEqual(stub.calls[0].payload, [4, 0, 0]);
    assert.deepStrictEqual(stub.calls[1].payload, [4, 0, 1]);
  });

  await test('writePreset invia la sequenza corretta (header→start→flow→146 parti)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const replies = [];
    for (let i = 0; i < 3 + 146; i++) replies.push(sysex(0x00, 0x18, null));
    stub.queue(...replies);

    // corpo preset realistico: i 4672 byte sono dati 8→7 bit (valori 0..127)
    const data = new Uint8Array(4672);
    for (let i = 0; i < data.length; i++) data[i] = i % 120;
    await MF.writePreset(200, { name: 'W', category: 6, p1: 0, data });

    assert.strictEqual(stub.calls.length, 3 + 146);
    // 1. header (35 byte) via op 0x52
    assert.strictEqual(stub.calls[0].op, 0x52);
    assert.strictEqual(stub.calls[0].payload.length, 35);
    assert.strictEqual(stub.calls[0].payload[0], 1); // bank di 200
    assert.strictEqual(stub.calls[0].payload[1], 71); // program di 200
    assert.strictEqual(stub.calls[0].payload[8], 71);
    assert.strictEqual(stub.calls[0].payload[10], 6); // categoria
    assert.strictEqual(stub.calls[0].payload[12], 'W'.charCodeAt(0));
    // 2. start
    assert.deepStrictEqual(stub.calls[1].payload, [1, 71, 1]);
    // 3. flow
    assert.strictEqual(stub.calls[2].op, 0x15);
    // 4. parti
    for (let i = 0; i < 146; i++) {
      assert.strictEqual(stub.calls[3 + i].op, i === 145 ? 0x17 : 0x16);
      assert.strictEqual(stub.calls[3 + i].payload.length, 32);
      assert.strictEqual(stub.calls[3 + i].payload[0], (i * 32) % 120);
    }
  });

  await test('writePreset costruisce l\'header da zero (byte opachi non riciclati)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const replies = [];
    for (let i = 0; i < 3 + 146; i++) replies.push(sysex(0x00, 0x18, null));
    stub.queue(...replies);

    const raw = headerPayload({ name: 'Original' });
    raw[2] = 0x55; // byte opaco: NON deve essere riciclato nell'header scritto
    const data = new Uint8Array(4672);
    await MF.writePreset(5, { name: 'NuovoNome', category: 9, p1: 1, rawHeader: raw, data });
    assert.strictEqual(stub.calls[0].payload[2], 0); // azzerato (come Elektroid)
    assert.strictEqual(stub.calls[0].payload[12], 'N'.charCodeAt(0));
    assert.strictEqual(stub.calls[0].payload[10], 9);
    assert.strictEqual(stub.calls[0].payload[0], 0);
    assert.strictEqual(stub.calls[0].payload[1], 4);
  });

  await test('scanHeaders legge 512 header e propaga gli errori di riga', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const replies = [];
    for (let i = 0; i < 512; i++) {
      if (i === 5) {
        // il timeout viene ritentato 3 volte da requestRetry, poi l'errore passa
        replies.push(new Error('timeout'), new Error('timeout'), new Error('timeout'));
      } else {
        replies.push(sysex(i & 0x7f, 0x52, headerPayload({ name: 'P' + i, program: i & 0x7f })));
      }
    }
    stub.queue(...replies);
    const out = await MF.scanHeaders();
    assert.strictEqual(out.length, 512);
    assert.strictEqual(out[5].error, 'timeout');
    assert.strictEqual(out[6].name, 'P6');
  });

  await test('scanHeaders si ferma se onProgress lancia (annullamento)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    stub.queue(...Array.from({ length: 512 }, (_, i) => sysex(i & 0x7f, 0x52, headerPayload({ name: 'P' }))));
    let calls = 0;
    await assert.rejects(
      MF.scanHeaders({
        onProgress: () => {
          calls++;
          if (calls > 3) throw new Error('stop');
        },
      }),
      /stop/
    );
    assert.ok(stub.calls.length <= 4);
  });

  await test('renamePreset riscrive solo header e poi seleziona', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const original = headerPayload({ name: 'Vecchio', category: 1, p1: 2 });
    stub.queue(
      sysex(0x00, 0x52, original),
      sysex(0x01, 0x18, null),
      sysex(0x02, 0x18, null),
      sysex(0x03, 0x52, headerPayload({ name: 'Nuovo', category: 3, p1: 2 })),
    );
    const updated = await MF.renamePreset(1, { name: 'Nuovo', category: 3 });
    assert.strictEqual(updated.name, 'Nuovo');
    assert.strictEqual(stub.calls.length, 4);
    assert.strictEqual(stub.calls[0].op, 0x19); // lettura header corrente
    assert.strictEqual(stub.calls[1].op, 0x52);
    assert.strictEqual(stub.calls[1].payload.length, 35);
    assert.strictEqual(stub.calls[1].payload[12], 'N'.charCodeAt(0));
    assert.strictEqual(stub.calls[1].payload[10], 3);
    assert.deepStrictEqual(stub.calls[2].payload, [0, 0, 1]);
    assert.strictEqual(stub.calls[3].op, 0x19); // rilettura di conferma
  });

  await test('parseReply rejects non-Arturia and malformed replies', () => {
    assert.throws(() => MF.parseReply(Uint8Array.from([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x00, 0x00, 0x00, 0x00, 0xf7])), /Arturia/);
    assert.throws(() => MF.parseReply(Uint8Array.from([0xf0, 0x00, 0x20, 0x6b, 0xf7])), /Malformed/i);
  });

  // ================================================================== PARAMS
  console.log('Parametri:');

  const pack8to7 = (unpacked) => {
    const out = new Uint8Array(Math.ceil(unpacked.length / 7) * 8);
    for (let b = 0; b * 7 < unpacked.length; b++) {
      const base = b * 8;
      let bitmap = 0;
      for (let i = 0; i < 7; i++) {
        const v = unpacked[b * 7 + i] || 0;
        if (v & 0x80) bitmap |= 1 << i;
        out[base + 1 + i] = v & 0x7f;
      }
      out[base] = bitmap;
    }
    return out;
  };

  await test('unpack 8→7 round trip', () => {
    const unpacked = new Uint8Array(4088);
    for (let i = 0; i < unpacked.length; i++) unpacked[i] = (i * 31 + 7) & 0xff;
    const packed = pack8to7(unpacked);
    assert.strictEqual(packed.length, 4672);
    const back = Params.unpack8to7(packed);
    for (let i = 0; i < unpacked.length; i++) assert.strictEqual(back[i], unpacked[i]);
  });

  await test('parseStructured estrae gruppi e campi', () => {
    const unpacked = new Uint8Array(4088);
    let pos = 0;
    unpacked[pos] = 0x23; // gruppo iniziale
    unpacked[pos + 1] = 'V'.charCodeAt(0);
    unpacked[pos + 2] = 'C'.charCodeAt(0);
    unpacked[pos + 3] = 'O'.charCodeAt(0);
    pos += 4;
    // campo VCO.Type: nome "Type" → 0x40+4
    unpacked[pos] = 0x44;
    unpacked[pos + 1] = 'T'.charCodeAt(0);
    unpacked[pos + 2] = 'y'.charCodeAt(0);
    unpacked[pos + 3] = 'p'.charCodeAt(0);
    unpacked[pos + 4] = 'e'.charCodeAt(0);
    unpacked[pos + 5] = 0x63; // 'c'
    unpacked[pos + 6] = 22; // metadata = 22 motori
    unpacked[pos + 7] = 0x4a; // value low = round(14*32767/22) ≈ 20852 = 0x5174 → lo=0x74 hi=0x51
    unpacked[pos + 8] = 0x51;
    pos += 9;
    // gruppo successivo VCF
    unpacked[pos] = 0x40; // '@'
    unpacked[pos + 1] = 0x23; // '#'
    unpacked[pos + 2] = 'V'.charCodeAt(0);
    unpacked[pos + 3] = 'C'.charCodeAt(0);
    unpacked[pos + 4] = 'F'.charCodeAt(0);
    pos += 5;
    // campo Cutoff: nome 6 → 0x46
    unpacked[pos] = 0x46;
    for (let i = 0; i < 6; i++) unpacked[pos + 1 + i] = 'Cutoff'.charCodeAt(i);
    unpacked[pos + 7] = 0x63;
    unpacked[pos + 8] = 0; // metadata
    const cutoff = 13186; // 0x3382
    unpacked[pos + 9] = cutoff & 0xff;
    unpacked[pos + 10] = (cutoff >> 8) & 0xff;
    pos += 11;

    const packed = pack8to7(unpacked);
    const { fields } = Params.parseStructured(packed);
    const type = fields.find((f) => f.key === 'VCO.Type');
    assert.ok(type, 'VCO.Type presente');
    const idx = Math.round((type.raw * 22) / 32767);
    assert.strictEqual(idx, 14); // Vocoder
    const v = Params.friendlyValue(type);
    assert.strictEqual(v.text, 'Vocoder');

    const cf = fields.find((f) => f.key === 'VCF.Cutoff');
    assert.ok(cf, 'VCF.Cutoff presente');
    assert.strictEqual(cf.raw, cutoff);
  });

  await test('describe() su corpo senza tag usa il fallback legacy', () => {
    const data = new Uint8Array(4672);
    const rows = Params.describe(data).rows;
    assert.ok(rows.length > 5);
    const cutoff = rows.find((r) => r.label === 'Cutoff');
    assert.ok(cutoff);
    assert.strictEqual(cutoff.value, '0%');
  });

  // ================================================================== LIBRERIA
  console.log('Libreria (collezioni e ordinamento):');

  const mkPreset = (name) => {
    const data = new Uint8Array(4672);
    return { name, category: 0, p1: 0, data };
  };

  await test('add con collectionId e ordinamento move/moveBy', async () => {
    await Library.load();
    const a = Library.add(mkPreset('A'), {});
    const b = Library.add(mkPreset('B'), {});
    const c = Library.add(mkPreset('C'), {});
    const names = () => Library.all().map((e) => e.name);
    assert.deepStrictEqual(names(), ['A', 'B', 'C']);

    Library.move(c.id, a.id, false); // C prima di A
    assert.deepStrictEqual(names(), ['C', 'A', 'B']);

    Library.move(a.id, b.id, true); // A dopo B
    assert.deepStrictEqual(names(), ['C', 'B', 'A']);

    Library.moveBy(b.id, +1); // B scambia con A
    assert.deepStrictEqual(names(), ['C', 'A', 'B']);

    Library.moveBy(c.id, -1); // C già primo: nessun cambiamento
    assert.deepStrictEqual(names(), ['C', 'A', 'B']);

    Library.move(c.id, c.id, true); // su se stesso: nessun cambiamento
    assert.deepStrictEqual(names(), ['C', 'A', 'B']);
  });

  await test('collezioni: creazione, assegnazione, eliminazione', async () => {
    const entriesBefore = Library.all();
    for (const e of entriesBefore) Library.remove(e.id);

    const col = Library.addCollection('Pack Test');
    assert.ok(col > 0);
    assert.strictEqual(Library.collectionName(col), 'Pack Test');

    const p = Library.add(mkPreset('InCollezione'), { collectionId: col });
    const q = Library.add(mkPreset('SenzaCollezione'), {});
    assert.strictEqual(p.collectionId, col);
    assert.strictEqual(q.collectionId, null);

    Library.moveEntryToCollection(q.id, col);
    assert.strictEqual(Library.get(q.id).collectionId, col);

    Library.renameCollection(col, 'Pack Rinominata');
    assert.strictEqual(Library.collectionName(col), 'Pack Rinominata');

    Library.removeCollection(col);
    assert.strictEqual(Library.allCollections().length, 0);
    assert.strictEqual(Library.get(p.id).collectionId, null);
    assert.strictEqual(Library.get(q.id).collectionId, null);
  });

  await test('i preset Init vuoti vengono ignorati (importRaw) e purgeInit li rimuove', async () => {
    const before = Library.all().length;
    // importRaw su voce senza corpo → null e nessuna aggiunta
    assert.strictEqual(Library.importRaw({ name: 'Init', dataB64: '', rawHeaderB64: null }), null);
    assert.strictEqual(Library.all().length, before);
    assert.strictEqual(Library.isInitEntry({ dataB64: '' }), true);
    assert.strictEqual(Library.isInitEntry({ dataB64: 'AAAA' }), false);
    assert.strictEqual(Library.purgeInit(), 0);
  });

  await test('rating 1–5 con clamp', async () => {
    const p = Library.add(mkPreset('Rated'), {});
    Library.setRating(p.id, 3);
    assert.strictEqual(Library.get(p.id).rating, 3);
    Library.setRating(p.id, 9);
    assert.strictEqual(Library.get(p.id).rating, 5);
    Library.setRating(p.id, -2);
    assert.strictEqual(Library.get(p.id).rating, 0);
  });

  await test('moveBlock sposta più preset insieme', async () => {
    for (const e of Library.all()) Library.remove(e.id);
    const ids = [];
    for (const n of ['A', 'B', 'C', 'D', 'E']) ids.push(Library.add(mkPreset(n), {}).id);
    const names = () => Library.all().map((e) => e.name);
    assert.deepStrictEqual(names(), ['A', 'B', 'C', 'D', 'E']);

    // sposta il blocco [C, D] prima di A → C D A B E
    Library.moveBlock([ids[2], ids[3]], ids[0], false);
    assert.deepStrictEqual(names(), ['C', 'D', 'A', 'B', 'E']);

    // sposta il blocco [B, E] dopo C → C B E D A
    Library.moveBlock([ids[1], ids[4]], ids[2], true);
    assert.deepStrictEqual(names(), ['C', 'B', 'E', 'D', 'A']);
  });

  // ================================================================== SHIFT (dispositivo)
  console.log('Shift sul dispositivo (planShift):');

  const applyWrites = (occupied, writes) => {
    // Ogni write {from,to} sposta il preset (identificato dallo slot d'origine
    // "from") nello slot "to". Ricostruisce l'ordine dei preset per slot.
    const dest = new Map(writes.map((w) => [w.from, w.to]));
    const result = new Array(occupied.length);
    for (let k = 0; k < occupied.length; k++) {
      let found = null;
      for (const x of occupied) {
        const to = dest.has(x) ? dest.get(x) : x;
        if (to === occupied[k]) { found = x; break; }
      }
      result[k] = found;
    }
    return result;
  };

  await test('sposta [2,3] prima di 5 → 1,4,2,3,5', () => {
    const occupied = [1, 2, 3, 4, 5];
    const { newSeq, writes } = Shift.planShift(occupied, [2, 3], 5, false);
    assert.deepStrictEqual(newSeq, [1, 4, 2, 3, 5]);
    // applicando le scritture si ottiene la nuova sequenza
    assert.deepStrictEqual(applyWrites(occupied, writes), newSeq);
  });

  await test('sposta [1] dopo 3 → 2,3,1', () => {
    const occupied = [1, 2, 3];
    const { newSeq, writes } = Shift.planShift(occupied, [1], 3, true);
    assert.deepStrictEqual(newSeq, [2, 3, 1]);
    assert.deepStrictEqual(applyWrites(occupied, writes), newSeq);
  });

  await test('sposta [1] prima di 2 → 1,2,3 (nessuna modifica)', () => {
    const occupied = [1, 2, 3];
    const { newSeq, writes } = Shift.planShift(occupied, [1], 2, false);
    assert.deepStrictEqual(newSeq, [1, 2, 3]);
    assert.strictEqual(writes.length, 0);
  });

  await test('con slot vuoti interposti: [2,5,8], sposta 5 prima di 2 → 5,2,8', () => {
    const occupied = [2, 5, 8];
    const { newSeq, writes } = Shift.planShift(occupied, [5], 2, false);
    assert.deepStrictEqual(newSeq, [5, 2, 8]);
    assert.deepStrictEqual(applyWrites(occupied, writes), newSeq);
    // 8 resta al suo posto: nessuna scrittura su di esso
    assert.ok(writes.every((w) => w.from !== 8 || w.to === 8));
  });

  await test('target vuoto: [1,5,10], sposta 1 dopo slot vuoto 3 → 5,1,10', () => {
    const occupied = [1, 5, 10];
    const { newSeq, writes } = Shift.planShift(occupied, [1], 3, true);
    assert.deepStrictEqual(newSeq, [5, 1, 10]);
    assert.deepStrictEqual(applyWrites(occupied, writes), newSeq);
  });

  await test('target nel blocco spostato → nessuna operazione', () => {
    const occupied = [1, 2, 3, 4];
    const { writes } = Shift.planShift(occupied, [2, 3], 2, false);
    assert.strictEqual(writes.length, 0);
  });

  await test('blocco alla fine della lista', () => {
    const occupied = [1, 2, 3, 4, 5, 6, 7];
    const { newSeq, writes } = Shift.planShift(occupied, [6, 7], 1, false);
    assert.deepStrictEqual(newSeq, [6, 7, 1, 2, 3, 4, 5]);
    assert.deepStrictEqual(applyWrites(occupied, writes), newSeq);
  });

  // ================================================================== GLOBALS / WAVETABLE / SAMPLE
  console.log('Global settings, wavetable e sample:');

  const altSysex = (op, payload) => {
    const p = payload ? Array.from(payload) : [];
    return [0xf0, 0x00, 0x20, 0x6b, 0x07, 0x7f, 0x02, p.length, op, ...p, 0xf7];
  };
  const ack = () => sysex(0, 0x18, []);

  await test('pack7to8/unpack8to7 round-trip', () => {
    const raw = new Uint8Array(28);
    for (let i = 0; i < 28; i++) raw[i] = (i * 13 + 7) & 0xff;
    const packed = MF.pack7to8(raw);
    assert.strictEqual(packed.length, 32);
    assert.ok(packed.every((b) => b <= 0x7f));
    const back = MF.unpack8to7(packed);
    assert.deepStrictEqual(Array.from(back), Array.from(raw));
  });

  await test('readGlobalCode: op 43 → reply alt op 42 con valore', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const code = MF.GLOBAL_CODES['keyboard.root_note'];
    stub.queueAny(altSysex(0x42, [code, 5]));
    const v = await MF.readGlobalCode(code);
    assert.strictEqual(v, 5);
  });

  await test('writeGlobalSetting: scrive op 42 e verifica con op 43', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const code = MF.GLOBAL_CODES['keyboard.root_note'];
    stub.queueAny(altSysex(0x42, [code, 0]), altSysex(0x42, [code, 7]));
    await MF.writeGlobalSetting('keyboard.root_note', 7);
    const sent = stub.calls.find((c) => c.send && c.op === 0x42);
    assert.deepStrictEqual(sent.payload, [code, 7]);
  });

  await test('writeGlobalSetting: readback diverso → ripristina e fallisce', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const code = MF.GLOBAL_CODES['keyboard.root_note'];
    stub.queueAny(
      altSysex(0x42, [code, 0]),  // before
      altSysex(0x42, [code, 3]),  // readback errato (atteso 7)
      altSysex(0x42, [code, 0]),  // restore verified
    );
    let failed = false;
    try {
      await MF.writeGlobalSetting('keyboard.root_note', 7);
    } catch {
      failed = true;
    }
    assert.ok(failed);
  });

  await test('globalLabel: valori ammessi (es. midi.merge, tuning.master, cv.press_range)', () => {
    assert.strictEqual(MF.globalLabel('midi.merge', 3), 'MIDI+USB+KBD');
    assert.strictEqual(MF.globalLabel('tuning.master', 64), '0 cents');
    assert.strictEqual(MF.globalLabel('tuning.master', 65), '1 cent');
    assert.strictEqual(MF.globalLabel('cv.press_range', 5), '6 V');
    assert.strictEqual(MF.globalLabel('microphone.gain', 72), 'Auto Gain');
    assert.strictEqual(MF.globalLabel('microphone.gain', 12), '0 dB');
    assert.strictEqual(MF.globalLabel('keyboard.root_note', 9), 'A');
    assert.strictEqual(MF.globalLabel('keyboard.scale', 3), 'HarmoMinor');
    assert.strictEqual(MF.globalLabel('cv.zero_volt_reference', 60), 'C3');
    assert.strictEqual(MF.globalLabel('midi.channel_in', 126), 'None');
  });

  await test('readSampleStats: op 47 → reply alt op 48 (conteggio tempo)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    // used = 100000 ms → (100000>>2) = 0x61A8 → lsb 0xA8 (flag 0x08 in p[2]), msb 0x61
    const lsb = 0xa8 & 0x7f;
    const msb = 0x61;
    const payload9 = [0, 0, 0x08, 0, 0, 0, lsb, msb, 0];
    stub.queueAny(altSysex(0x48, payload9));
    const stats = await MF.readSampleStats();
    assert.strictEqual(stats.usedMs, 100000);
    assert.strictEqual(stats.freeMs, MF.SAMPLE_TOTAL_CAPACITY_MS - 100000);
    assert.strictEqual(stats.capacityMs, 209920);
    // sessione: 1C inviato prima, 1D dopo
    const ops = stub.calls.filter((c) => c.send).map((c) => c.op);
    assert.strictEqual(ops[0], 0x1c);
    assert.strictEqual(ops[ops.length - 1], 0x1d);
  });

  const wtHeaderRaw = (slot, name, { empty = false } = {}) => {
    const h = new Uint8Array(28);
    h[0] = slot - 1;
    h[3] = empty ? 0x08 : 0;
    h[8] = slot - 1;
    h[10] = 1;
    h[11] = 1;
    for (let i = 0; i < name.length && i < 15; i++) h[12 + i] = name.charCodeAt(i);
    return h;
  };

  // 147 pacchetti per parte: 146×28 byte + 8 utili nel finale
  const partPackets = (pcm, partOff) => {
    const out = [];
    for (let packet = 0; packet < 147; packet++) {
      const off = partOff + packet * 28;
      let raw;
      if (packet === 146) {
        raw = new Uint8Array(28);
        raw.set(pcm.subarray(off, off + 8));
      } else {
        raw = pcm.subarray(off, off + 28);
      }
      const op = packet === 146 ? 0x17 : 0x16;
      out.push(sysex(0, op, MF.pack7to8(raw)));
    }
    return out;
  };

  const makePcm = (len, seed) => {
    const p = new Uint8Array(len);
    for (let i = 0; i < len; i++) p[i] = (i * 11 + seed) & 0xff;
    return p;
  };

  await test('readWavetable: header + 4 parti (16384 byte)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const pcm = makePcm(16384, 3);
    const script = [
      sysex(0, 0x15, []),                                  // reply a 0x57
      sysex(0, 0x16, MF.pack7to8(wtHeaderRaw(2, 'MyTable'))), // reply a 0x18 [1]
    ];
    for (let part = 0; part < 4; part++) {
      script.push(sysex(0, 0x15, []));                     // reply a 0x55
      script.push(...partPackets(pcm, part * 4096));
    }
    stub.queue(...script);
    const wt = await MF.readWavetable(2);
    assert.strictEqual(wt.name, 'MyTable');
    assert.strictEqual(wt.empty, false);
    assert.deepStrictEqual(Array.from(wt.data), Array.from(pcm));
  });

  await test('writeWavetable: upload guardato con verifica readback', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const before = makePcm(16384, 5);
    const target = makePcm(16384, 9);
    const oldHeader = MF.pack7to8(wtHeaderRaw(1, 'Old'));
    // preflight: readWavetableHeader (2×: una per writeWavetable, una per readWavetable)
    const script = [
      sysex(0, 0x15, []),
      sysex(0, 0x16, oldHeader),
      sysex(0, 0x15, []),
      sysex(0, 0x16, oldHeader),
    ];
    // corpo attuale (before): 4 parti
    for (let part = 0; part < 4; part++) {
      script.push(sysex(0, 0x15, []));
      script.push(...partPackets(before, part * 4096));
    }
    // setWavetableEntry: 56→18, 15→18, 16(header)→18, 17(8 zeri)→18
    script.push(ack(), ack(), ack(), ack());
    // uploadWavetableParts: per parte 54→18, 15→18, 147 ack
    for (let part = 0; part < 4; part++) {
      script.push(ack(), ack());
      for (let packet = 0; packet < 147; packet++) script.push(ack());
    }
    // readback: header + 4 parti con il target
    script.push(
      sysex(0, 0x15, []),
      sysex(0, 0x16, MF.pack7to8(wtHeaderRaw(1, 'New'))),
    );
    for (let part = 0; part < 4; part++) {
      script.push(sysex(0, 0x15, []));
      script.push(...partPackets(target, part * 4096));
    }
    stub.queue(...script);
    await MF.writeWavetable(1, { name: 'New', data: target });
    // nessuna eccezione = verifica readback passata
  });

  await test('readSampleHeader + readSample (corpo 4096+ byte)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const audio = makePcm(8192, 7); // 8192 byte → 2 blocchi
    const header = new Uint8Array(28);
    header[4] = audio.length & 0xff;
    header[5] = (audio.length >> 8) & 0xff;
    header[6] = (audio.length >> 16) & 0xff;
    header[7] = (audio.length >> 24) & 0xff;
    header[10] = 0x4e; // 'N'
    header[11] = 0x65; // 'e'
    header[12] = 0x79; // 'y'
    header[23] = 2;
    const script = [
      sysex(0, 0x15, []),                                  // 5B
      sysex(0, 0x16, MF.pack7to8(header)),                 // 18 → header
      // readSample: header letto una sola volta, poi i 2 blocchi
      sysex(0, 0x15, []),
      ...partPackets(audio, 0),
      sysex(0, 0x15, []),
      ...partPackets(audio, 4096),
    ];
    stub.queue(...script);
    const s = await MF.readSample(3);
    assert.strictEqual(s.name, 'Ney');
    assert.strictEqual(s.sizeBytes, 8192);
    assert.deepStrictEqual(Array.from(s.data), Array.from(audio));
  });

  await test('writeSample: allocazione, parti e verifica readback', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const audio = makePcm(8192, 11);
    const header = new Uint8Array(28);
    header[4] = audio.length & 0xff;
    header[5] = (audio.length >> 8) & 0xff;
    header[6] = (audio.length >> 16) & 0xff;
    header[7] = (audio.length >> 24) & 0xff;
    for (let i = 0; i < 3; i++) header[10 + i] = 'New'.charCodeAt(i);
    header[23] = 0;
    const packedHeader = MF.pack7to8(header);

    const script = [];
    // preflight: readSampleHeader (una sola, per il check dello slot; niente backup corpo)
    script.push(sysex(0, 0x15, []), sysex(0, 0x16, packedHeader));
    // alloc: 5D→18, 15→18, 17(header)→16[1], receive non richiesta → 18
    script.push(ack(), ack(), sysex(0, 0x16, [0x01]));
    stub.queueReceive(ack());
    // reset header: 5A→18, 15→18, 17(header)→18
    script.push(ack(), ack(), ack());
    // parti: 2 blocchi × (58→18, 15→18, 147 ack)
    for (let b = 0; b < 2; b++) {
      script.push(ack(), ack());
      for (let packet = 0; packet < 147; packet++) script.push(ack());
    }
    // finalize: 5B→15, 147 pacchetti
    script.push(sysex(0, 0x15, []));
    for (let packet = 0; packet < 147; packet++) {
      script.push(sysex(0, packet === 146 ? 0x17 : 0x16, new Uint8Array(32)));
    }
    // readback: header + corpo
    script.push(sysex(0, 0x15, []), sysex(0, 0x16, packedHeader));
    script.push(sysex(0, 0x15, []), ...partPackets(audio, 0));
    script.push(sysex(0, 0x15, []), ...partPackets(audio, 4096));
    stub.queue(...script);
    stub.queueAny(altSysex(0x48, [0, 0, 0, 0, 0, 0, 0, 0, 0])); // stats: used 0 → free pieno

    await MF.writeSample(1, 'New', audio);
  });

  await test('device lock: due operazioni concorrenti sono serializzate', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const code = MF.GLOBAL_CODES['keyboard.root_note'];
    const header = new Uint8Array(28);
    header[4] = 4; // 4 byte
    header[10] = 0x41; // 'A'
    stub.queue(
      sysex(0, 0x15, []),
      sysex(0, 0x16, MF.pack7to8(header)),
    );
    stub.queueAny(altSysex(0x42, [code, 5]));
    // lanciate senza attendere l'una l'altra
    await Promise.all([MF.readSampleHeader(1), MF.readGlobalCode(code)]);
    const ops = stub.calls.map((c) => c.op);
    const lastOfHeader = ops.lastIndexOf(0x18);   // ultima chiamata della lettura header
    const firstGlobal = ops.indexOf(0x43);        // prima chiamata della lettura global
    assert.ok(firstGlobal > lastOfHeader, 'le transazioni MIDI devono essere serializzate');
  });

  await test('readSample: shouldCancel interrompe la lettura', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const raw = new Uint8Array(28);
    raw[4] = 4096 & 0xff;              // lunghezza 4096 little-endian
    raw[5] = (4096 >> 8) & 0xff;
    raw[6] = (4096 >> 16) & 0xff;
    raw[7] = (4096 >> 24) & 0xff;
    raw[10] = 0x41;
    stub.queue(
      sysex(0, 0x15, []),                               // 5B → 15 (selezione)
      sysex(0, 0x16, MF.pack7to8(raw)),                 // 18 → header
    );
    let cancelled = false;
    let cancelNow = false;
    const p = MF.readSample(1, { shouldCancel: () => cancelNow });
    cancelNow = true;
    try {
      await p;
    } catch (e) {
      cancelled = /Operation cancelled/.test(e.message);
    }
    assert.ok(cancelled, 'la lettura deve essere annullabile');
    // la selezione dello slot avviene sempre, ma il corpo non parte
    assert.ok(stub.calls.some((c) => c.op === 0x5b), 'la selezione dello slot deve avvenire');
    assert.ok(!stub.calls.some((c) => c.op === 0x59), 'dopo la cancellazione non parte il corpo');
  });

  await test('readSample: sample >128 blocchi (indice mascherato a 7 bit)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    // 129 blocchi = 528.384 byte (~16,5 s a 32 kHz): l'indice supera 127 e
    // senza mascheramento il messaggio SysEx sarebbe invalido
    const BLOCKS = 129;
    const sizeBytes = BLOCKS * 4096;
    const header = new Uint8Array(28);
    header[4] = sizeBytes & 0xff;
    header[5] = (sizeBytes >> 8) & 0xff;
    header[6] = (sizeBytes >> 16) & 0xff;
    header[7] = (sizeBytes >> 24) & 0xff;
    'BigSample'.split('').forEach((c, i) => { header[10 + i] = c.charCodeAt(0); });
    const packedHeader = MF.pack7to8(header);

    // dati attesi: ogni blocco ha un pattern diverso
    const expected = new Uint8Array(sizeBytes);
    for (let b = 0; b < BLOCKS; b++) {
      for (let i = 0; i < 4096; i++) expected[b * 4096 + i] = (b * 37 + i * 5) & 0xff;
    }

    let phase = 'header';
    let blockIdx = -1;
    let packetIdx = 0;
    stub.queueReplies((op) => {
      if (op === 0x5b) { phase = 'header'; return sysex(0, 0x15, []); }
      if (op === 0x59) { blockIdx++; packetIdx = 0; phase = 'block'; return sysex(0, 0x15, []); }
      if (op === 0x18) {
        if (phase === 'header') return sysex(0, 0x16, packedHeader);
        const p = packetIdx++;
        const last = p === 146;
        const base = blockIdx * 4096 + p * 28;
        const raw = new Uint8Array(28);
        const n = last ? 8 : 28;
        for (let i = 0; i < n; i++) raw[i] = expected[base + i];
        return sysex(0, last ? 0x17 : 0x16, MF.pack7to8(raw));
      }
      throw new Error(`op inattesa 0x${op.toString(16)}`);
    });

    const s = await MF.readSample(1);
    assert.strictEqual(s.data.length, sizeBytes);
    // contenuto corretto anche nell'ultimo blocco (indice mascherato 128 & 0x7f = 0)
    assert.deepStrictEqual(Array.from(s.data.subarray(0, 64)), Array.from(expected.subarray(0, 64)));
    assert.deepStrictEqual(
      Array.from(s.data.subarray(128 * 4096, 128 * 4096 + 64)),
      Array.from(expected.subarray(128 * 4096, 128 * 4096 + 64))
    );
    // tutte le richieste di blocco hanno l'indice entro i 7 bit
    const blockReqs = stub.calls.filter((c) => c.op === 0x59);
    assert.strictEqual(blockReqs.length, BLOCKS);
    assert.ok(blockReqs.every((c) => c.payload[1] >= 0 && c.payload[1] <= 127),
      'l\'indice di blocco deve stare in 7 bit');
    assert.strictEqual(blockReqs[128].payload[1], 0); // 128 & 0x7f
  });

  await test('renameWavetable: solo header (corpo non toccato)', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const oldHeader = new Uint8Array(28);
    oldHeader[0] = 0;
    oldHeader[3] = 0;
    oldHeader[8] = 0;
    oldHeader[10] = 1;
    oldHeader[11] = 1;
    'Old'.split('').forEach((c, i) => { oldHeader[12 + i] = c.charCodeAt(0); });
    const newHeader = new Uint8Array(oldHeader);
    newHeader.fill(0, 12);
    'New'.split('').forEach((c, i) => { newHeader[12 + i] = c.charCodeAt(0); });
    const script = [
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(oldHeader)),   // header attuale
      ack(), ack(), ack(), ack(),                                    // setWavetableEntry (56,15,16,17)
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(newHeader)),   // verifica
    ];
    stub.queue(...script);
    const check = await MF.renameWavetable(1, 'New');
    assert.strictEqual(check.name, 'New');
    assert.ok(!check.empty);
    // nessuna richiesta di parti (il corpo non viene mai letto/scritto)
    assert.ok(!stub.calls.some((c) => c.op === 0x54 || c.op === 0x55));
  });

  await test('renameSample: solo header, conserva dimensione/checksum/indirizzo', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const oldHeader = new Uint8Array(28);
    oldHeader[0] = 0x10; oldHeader[1] = 0x28; oldHeader[2] = 0x00; oldHeader[3] = 0x00; // indirizzo
    oldHeader[4] = 100; oldHeader[5] = 0; oldHeader[6] = 0; oldHeader[7] = 0;          // 100 byte
    oldHeader[8] = 0x34; oldHeader[9] = 0x12;                                          // checksum
    'Old'.split('').forEach((c, i) => { oldHeader[10 + i] = c.charCodeAt(0); });
    oldHeader[23] = 0;
    const newHeader = new Uint8Array(oldHeader);
    newHeader.fill(0, 10, 23);
    'New'.split('').forEach((c, i) => { newHeader[10 + i] = c.charCodeAt(0); });
    const script = [
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(oldHeader)),   // header attuale
      ack(), ack(), ack(),                                            // resetSampleHeader (5A,15,17)
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(newHeader)),   // verifica
    ];
    stub.queue(...script);
    const check = await MF.renameSample(1, 'New');
    assert.strictEqual(check.name, 'New');
    assert.strictEqual(check.sizeBytes, 100);
    assert.strictEqual(check.checksum, 0x1234);
    assert.strictEqual(check.address, 0x2810);
    // nessuna lettura del corpo (5D/58/59 non usate)
    assert.ok(!stub.calls.some((c) => c.op === 0x59 || c.op === 0x5d || c.op === 0x58));
  });

  await test('reorderSamples: swap 1⇄2 riscrive solo le voci di directory', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const mkHeader = (addr, size, checksum, name, slot) => {
      const h = new Uint8Array(28);
      h[0] = addr & 0xff; h[1] = (addr >> 8) & 0xff; h[2] = (addr >> 16) & 0xff; h[3] = (addr >> 24) & 0xff;
      h[4] = size & 0xff; h[5] = (size >> 8) & 0xff;
      h[8] = checksum & 0xff; h[9] = (checksum >> 8) & 0xff;
      for (let i = 0; i < name.length; i++) h[10 + i] = name.charCodeAt(i);
      h[23] = slot - 1;
      return h;
    };
    const hA = mkHeader(0x100, 100, 0x1111, 'AAA', 1);
    const hB = mkHeader(0x200, 200, 0x2222, 'BBB', 2);
    const script = [
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(hA)),   // backup slot 1
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(hB)),   // backup slot 2
      ack(), ack(), ack(),                                     // reset(2, A)
      ack(), ack(), ack(),                                     // reset(1, B)
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(hA)),   // verifica slot 2
      sysex(0, 0x15, []), sysex(0, 0x16, MF.pack7to8(hB)),   // verifica slot 1
    ];
    stub.queue(...script);
    const writes = [{ from: 1, to: 2 }, { from: 2, to: 1 }];
    await MF.reorderSamples(writes, [1]);
    // il device id (byte 23) di ogni header scritto è lo slot di destinazione
    const headerWrites = stub.calls.filter((c) => c.op === 0x17 && c.payload.length === 32);
    assert.strictEqual(headerWrites.length, 2);
    const decA = MF.unpack8to7(new Uint8Array(headerWrites[0].payload));
    const decB = MF.unpack8to7(new Uint8Array(headerWrites[1].payload));
    assert.strictEqual(decA[23], 1); // scritto verso slot 2
    assert.strictEqual(decB[23], 0); // scritto verso slot 1
    assert.strictEqual(String.fromCharCode(decA[10], decA[11], decA[12]), 'AAA');
    assert.strictEqual(String.fromCharCode(decB[10], decB[11], decB[12]), 'BBB');
    // nessun trasferimento di corpi audio
    assert.ok(!stub.calls.some((c) => c.op === 0x59 || c.op === 0x58 || c.op === 0x5d));
  });

  await test('reorderWavetables: swap 1⇄2 muove i corpi', async () => {
    const stub = makeMidiStub();
    global.Midi = stub.Midi;
    const bodyA = makePcm(16384, 21);
    const bodyB = makePcm(16384, 33);
    const hA = MF.pack7to8(wtHeaderRaw(1, 'AAA'));
    const hB = MF.pack7to8(wtHeaderRaw(2, 'BBB'));
    const script = [];
    // backup: readWavetable(1) = header + 4 parti, readWavetable(2) = idem
    script.push(sysex(0, 0x15, []), sysex(0, 0x16, hA));
    for (let p = 0; p < 4; p++) { script.push(sysex(0, 0x15, [])); script.push(...partPackets(bodyA, p * 4096)); }
    script.push(sysex(0, 0x15, []), sysex(0, 0x16, hB));
    for (let p = 0; p < 4; p++) { script.push(sysex(0, 0x15, [])); script.push(...partPackets(bodyB, p * 4096)); }
    // apply: setWavetableEntry(2,'AAA') + 4 parti di bodyA
    script.push(ack(), ack(), ack(), ack());
    for (let p = 0; p < 4; p++) { script.push(ack(), ack()); for (let k = 0; k < 147; k++) script.push(ack()); }
    // apply: setWavetableEntry(1,'BBB') + 4 parti di bodyB
    script.push(ack(), ack(), ack(), ack());
    for (let p = 0; p < 4; p++) { script.push(ack(), ack()); for (let k = 0; k < 147; k++) script.push(ack()); }
    // verifica header: slot 2 → AAA, slot 1 → BBB
    script.push(sysex(0, 0x15, []), sysex(0, 0x16, hA));
    script.push(sysex(0, 0x15, []), sysex(0, 0x16, hB));
    // verifica corpo del blocco spostato (from=1 → to=2): bodyA
    script.push(sysex(0, 0x15, []), sysex(0, 0x16, hA));
    for (let p = 0; p < 4; p++) { script.push(sysex(0, 0x15, [])); script.push(...partPackets(bodyA, p * 4096)); }
    stub.queue(...script);
    const writes = [{ from: 1, to: 2 }, { from: 2, to: 1 }];
    await MF.reorderWavetables(writes, [1]);
  });

  // ================================================================== MFP: wavetable/sample
  console.log('Formati wavetable/sample (.mfw/.mfwz/.mfsample/WAV):');

  await test('round-trip .mfw (16384 byte PCM16LE)', () => {
    const data = new Uint8Array(16384);
    for (let i = 0; i < data.length; i++) data[i] = (i * 3 + 1) & 0xff;
    const out = Mfp.serializeMfw({ name: 'SawX', data });
    const parsed = Mfp.parseMfw(out);
    assert.strictEqual(parsed.versionTag, 'DEVBUILD');
    assert.strictEqual(parsed.name, 'SawX');
    assert.strictEqual(parsed.p0, 1);
    assert.strictEqual(parsed.p5, 1);
    assert.deepStrictEqual(Array.from(parsed.data), Array.from(data));
  });

  await test('round-trip .mfwz (zip 0_sample)', async () => {
    const data = new Uint8Array(16384);
    const out = await Mfp.serializeMfwz({ name: 'Tab', data });
    const parsed = await Mfp.parseMfwz(out);
    assert.strictEqual(parsed.name, 'Tab');
    assert.deepStrictEqual(Array.from(parsed.data), Array.from(data));
  });

  await test('round-trip .mfsample (header 28 + corpo)', () => {
    const header = new Uint8Array(28);
    header[4] = 0x34; // 52 byte
    const data = new Uint8Array(52);
    for (let i = 0; i < 52; i++) data[i] = i & 0xff;
    const out = Mfp.serializeMsample(header, data);
    assert.strictEqual(out.length, 80);
    const parsed = Mfp.parseMsample(out);
    assert.deepStrictEqual(Array.from(parsed.header), Array.from(header));
    assert.deepStrictEqual(Array.from(parsed.data), Array.from(data));
  });

  const makeWav = ({ channels = 1, bits = 16, rate, data }) => {
    const bytesPerSample = bits / 8;
    const out = new Uint8Array(44 + data.length);
    const dv = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0);
    dv.setUint32(4, 36 + data.length, true);
    out.set([0x57, 0x41, 0x56, 0x45], 8);
    out.set([0x66, 0x6d, 0x74, 0x20], 12);
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, channels, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * channels * bytesPerSample, true);
    dv.setUint16(32, channels * bytesPerSample, true);
    dv.setUint16(34, bits, true);
    out.set([0x64, 0x61, 0x74, 0x61], 36);
    dv.setUint32(40, data.length, true);
    out.set(data, 44);
    return out;
  };

  /** WAV generico (formato/bit/canali arbitrari) per testare la conversione. */
  const makeWavEx = ({ rate = 32000, format = 1, bits = 16, values = [], channels = 1 } = {}) => {
    const bytesPer = bits / 8;
    const dataLen = values.length * bytesPer;
    const out = new Uint8Array(44 + dataLen);
    const dv = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0);
    dv.setUint32(4, 36 + dataLen, true);
    out.set([0x57, 0x41, 0x56, 0x45], 8);
    out.set([0x66, 0x6d, 0x74, 0x20], 12);
    dv.setUint32(16, 16, true);
    dv.setUint16(20, format, true);
    dv.setUint16(22, channels, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * channels * bytesPer, true);
    dv.setUint16(32, channels * bytesPer, true);
    dv.setUint16(34, bits, true);
    out.set([0x64, 0x61, 0x74, 0x61], 36);
    dv.setUint32(40, dataLen, true);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const off = 44 + i * bytesPer;
      if (format === 3 && bits === 32) dv.setFloat32(off, v, true);
      else if (format === 3 && bits === 64) dv.setFloat64(off, v, true);
      else if (bits === 8) out[off] = (Math.round(v) + 128) & 0xff;
      else if (bits === 16) dv.setInt16(off, v, true);
      else if (bits === 24) {
        out[off] = v & 0xff;
        out[off + 1] = (v >> 8) & 0xff;
        out[off + 2] = (v >> 16) & 0xff;
      } else if (bits === 32) dv.setInt32(off, v, true);
    }
    return out;
  };

  const wavS16 = (w) => {
    const dv = new DataView(w.data.buffer, w.data.byteOffset, w.data.byteLength);
    return (i) => dv.getInt16(i * 2, true);
  };

  await test('wavToWavetable: WAV mono 32kHz 8192 campioni', () => {
    const pcm = new Uint8Array(16384);
    for (let i = 0; i < 16384; i++) pcm[i] = (i * 5) & 0xff;
    const wav = makeWav({ rate: 32000, data: pcm });
    const wt = Mfp.wavToWavetable(wav, 'My Table');
    assert.strictEqual(wt.name, 'My Table');
    assert.strictEqual(wt.data.length, 16384);
    assert.deepStrictEqual(Array.from(wt.data), Array.from(pcm));
  });

  await test('wavToSample: risampla a 32 kHz e rispetta il limite', () => {
    // 16000 Hz, 8000 campioni → a 32 kHz diventano 16000 campioni (32000 byte)
    const pcm = new Uint8Array(16000);
    for (let i = 0; i < 16000; i++) pcm[i] = (i * 7) & 0xff;
    const wav = makeWav({ rate: 16000, data: pcm });
    const s = Mfp.wavToSample(wav, 'Drum');
    assert.strictEqual(s.data.length, 32000);
    assert.ok(s.data.length <= 24 * 32000 * 2);
    // WAV troppo lungo → errore
    const tooLong = makeWav({ rate: 32000, data: new Uint8Array(25 * 32000 * 2) });
    assert.throws(() => Mfp.wavToSample(tooLong, 'X'), /24 s/);
  });

  await test('wavToWavetable: risampla, taglia e ripete fino a 8192 campioni', () => {
    // 16000 Hz con 4096 campioni → risampla a 32 kHz → 8192 campioni (16384 byte)
    const pcm16 = new Uint8Array(8192);
    for (let i = 0; i < 8192; i++) pcm16[i] = (i * 3) & 0xff;
    const wav16 = makeWav({ rate: 16000, data: pcm16 });
    const r1 = Mfp.wavToWavetable(wav16, 'Resampled');
    assert.strictEqual(r1.data.length, 16384);
    assert.strictEqual(r1.name, 'Resampled');
    // 32 kHz con 12000 campioni → taglia ai primi 8192
    const long = makeWav({ rate: 32000, data: new Uint8Array(24000) });
    const r2 = Mfp.wavToWavetable(long, 'Long');
    assert.strictEqual(r2.data.length, 16384);
    // 32 kHz con 1024 campioni → ripete ciclicamente fino a 8192
    const orig = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) orig[i] = (i * 3) & 0xff;
    const short = makeWav({ rate: 32000, data: orig });
    const r3 = Mfp.wavToWavetable(short, 'Short');
    assert.strictEqual(r3.data.length, 16384);
    // i primi 1024 campioni dell'originale compaiono 8 volte (loop perfetto)
    const rep = new Uint8Array(16384);
    for (let k = 0; k < 8; k++) rep.set(orig, k * 2048);
    assert.deepStrictEqual(Array.from(r3.data), Array.from(rep));
  });

  await test('wavToWavetable: WAV senza campioni → errore (non deve bloccarsi)', () => {
    // regressione: un WAV con chunk "data" di lunghezza 0 faceva entrare il
    // riempimento ciclico in un ciclo infinito, bloccando l'app
    const empty = makeWavEx({ rate: 32000, values: [] });
    assert.strictEqual(empty.length, 44);
    assert.throws(() => Mfp.wavToWavetable(empty, 'Empty'), /no audio samples/);
    // anche un WAV con un solo byte di dati (mezzo campione) non ha campioni
    const half = makeWav({ rate: 32000, data: new Uint8Array(1) });
    assert.throws(() => Mfp.wavToWavetable(half, 'Half'), /no audio samples/);
  });

  await test('parseWav: 32-bit float → PCM16 con scaling e clamp', () => {
    const wav = makeWavEx({ format: 3, bits: 32, values: [0.5, -1.0, 1.0, 1.5, -1.5, 0.0] });
    const w = Mfp.parseWav(wav);
    assert.strictEqual(w.sampleRate, 32000);
    assert.strictEqual(w.frames, 6);
    const s = wavS16(w);
    assert.strictEqual(s(0), 16384);   // 0.5 × 32768
    assert.strictEqual(s(1), -32768);  // -1.0
    assert.strictEqual(s(2), 32767);   // 1.0 → clamp 32768 → 32767
    assert.strictEqual(s(3), 32767);   // 1.5 clamp
    assert.strictEqual(s(4), -32768);  // -1.5 clamp
    assert.strictEqual(s(5), 0);
  });

  await test('parseWav: 64-bit float → PCM16', () => {
    const wav = makeWavEx({ format: 3, bits: 64, values: [0.25, -0.25] });
    const s = wavS16(Mfp.parseWav(wav));
    assert.strictEqual(s(0), 8192);
    assert.strictEqual(s(1), -8192);
  });

  await test('parseWav: 24-bit e 32-bit int → PCM16', () => {
    const w24 = Mfp.parseWav(makeWavEx({ bits: 24, values: [8388607, -8388608, 0, 262144] }));
    const d24 = new DataView(w24.data.buffer, w24.data.byteOffset, w24.data.byteLength);
    assert.strictEqual(d24.getInt16(0, true), 32767);   // 8388607 >> 8
    assert.strictEqual(d24.getInt16(2, true), -32768);  // -8388608 >> 8
    assert.strictEqual(d24.getInt16(4, true), 0);
    assert.strictEqual(d24.getInt16(6, true), 1024);    // 262144 >> 8
    const w32 = Mfp.parseWav(makeWavEx({ bits: 32, values: [2147483647, -2147483648, 65536] }));
    const d32 = new DataView(w32.data.buffer, w32.data.byteOffset, w32.data.byteLength);
    assert.strictEqual(d32.getInt16(0, true), 32767);   // >> 16
    assert.strictEqual(d32.getInt16(2, true), -32768);
    assert.strictEqual(d32.getInt16(4, true), 1);       // 65536 >> 16
  });

  await test('parseWav: 8-bit unsigned → PCM16', () => {
    const w = Mfp.parseWav(makeWavEx({ bits: 8, values: [-128, 0, 127, -64] }));
    const s = wavS16(w);
    assert.strictEqual(s(0), -32768); // -128 << 8
    assert.strictEqual(s(1), 0);
    assert.strictEqual(s(2), 32512);  // 127 << 8
    assert.strictEqual(s(3), -16384); // -64 << 8
  });

  await test('parseWav: stereo → downmix mono (media dei canali)', () => {
    const wav = makeWavEx({ channels: 2, bits: 16, values: [100, 200, 300, 400, -100, 100] });
    const w = Mfp.parseWav(wav);
    assert.strictEqual(w.frames, 3);
    const s = wavS16(w);
    assert.strictEqual(s(0), 150); // (100+200)/2
    assert.strictEqual(s(1), 350); // (300+400)/2
    assert.strictEqual(s(2), 0);   // (-100+100)/2
  });

  await test('parseWav: stereo 32-bit float → downmix mono', () => {
    const wav = makeWavEx({ channels: 2, format: 3, bits: 32, values: [1.0, -1.0, 0.5, 0.5] });
    const w = Mfp.parseWav(wav);
    assert.strictEqual(w.frames, 2);
    const s = wavS16(w);
    assert.strictEqual(s(0), 0);     // (1 + -1)/2
    assert.strictEqual(s(1), 16384); // (0.5+0.5)/2 × 32768
  });

  await test('wavToSample: accetta WAV 32-bit float', () => {
    const vals = [0.5, -0.5, 0.25, -0.25, 1.0, -1.0, 0.0];
    const w = Mfp.wavToSample(makeWavEx({ rate: 32000, format: 3, bits: 32, values: vals }), 'F');
    assert.strictEqual(w.name, 'F');
    assert.strictEqual(w.data.length, vals.length * 2);
    const s = wavS16(w);
    assert.strictEqual(s(0), 16384);
    assert.strictEqual(s(1), -16384);
    assert.strictEqual(s(4), 32767);
    assert.strictEqual(s(5), -32768);
  });

  await test('wavToWavetable: accetta WAV 24-bit', () => {
    const vals = [0, 262144, -262144, 8388607];
    const w = Mfp.wavToWavetable(makeWavEx({ rate: 32000, bits: 24, values: vals }), 'T');
    assert.strictEqual(w.data.length, 8192 * 2); // riempie fino a 8192 campioni
    const s = wavS16(w);
    assert.strictEqual(s(0), 0);
    assert.strictEqual(s(1), 1024);
    assert.strictEqual(s(2), -1024);
    assert.strictEqual(s(3), 32767);
  });

  await test('resamplePcm16: windowed-sinc a guadagno unitario (DC preservato)', () => {
    const fromRate = 48000;
    const toRate = 32000;
    // DC costante 8000
    const dc = new Uint8Array(fromRate * 2);
    for (let i = 0; i < fromRate; i++) {
      dc[i * 2] = 8000 & 0xff;
      dc[i * 2 + 1] = (8000 >> 8) & 0xff;
    }
    const out = Mfp.resamplePcm16(dc, fromRate, toRate);
    assert.strictEqual(out.length, toRate * 2);
    // al centro (lontano dai bordi del filtro) deve restare ~8000
    const mid = Math.floor(toRate / 2);
    const got = out[mid * 2] | (out[mid * 2 + 1] << 8);
    assert.ok(Math.abs(got - 8000) < 64, `DC dovrebbe restare ~8000, got ${got}`);
    // nessun overshoot/clip
    for (let i = 0; i < toRate; i++) {
      const v = out[i * 2] | (out[i * 2 + 1] << 8);
      assert.ok(v >= 0 && v <= 65535, 'fuori range 16-bit');
    }
  });

  await test('parseWav: rifiuta solo i formati davvero non supportati', () => {
    // PCM 12-bit (non valido)
    assert.throws(() => Mfp.parseWav(makeWavEx({ format: 1, bits: 12, values: [0] })), /Unsupported WAV sample format/);
    // float 16-bit (non valido)
    assert.throws(() => Mfp.parseWav(makeWavEx({ format: 3, bits: 16, values: [0.5] })), /Unsupported WAV sample format/);
  });

  await test('backup completo: round-trip .mfbak (zip)', async () => {
    const presets = [{ slot: 1, name: 'A', category: 3, p1: 0, dataB64: 'QUJD' }];
    const wavetables = [{ slot: 2, name: 'W', dataB64: 'V0FW' }];
    const samples = [{ slot: 3, name: 'S', sizeBytes: 100, checksum: 42, headerB64: 'SEVS', dataB64: 'REFUQQ==' }];
    const globals = { 'keyboard.root_note': 9, 'midi.channel_in': 0 };
    const bytes = await Mfp.serializeFullBackup({ presets, wavetables, samples, globals, meta: { device: 'x' } });
    const parsed = await Mfp.parseFullBackup(bytes);
    assert.strictEqual(parsed.manifest.format, 'managefreak-full-backup');
    assert.strictEqual(parsed.manifest.counts.presets, 1);
    assert.deepStrictEqual(parsed.presets, presets);
    assert.deepStrictEqual(parsed.wavetables, wavetables);
    assert.deepStrictEqual(parsed.samples, samples);
    assert.deepStrictEqual(parsed.globals, globals);
    // file non valido → errore (zip o formato)
    await assert.rejects(() => Mfp.parseFullBackup(new Uint8Array(64)), /Invalid ZIP archive|Not a ManageFreak/);
  });

  // ================================================================== VOLUME BATCH
  console.log('Volume in batch (Params.setFieldValue):');

  const str3 = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2)];

  /** Costruisce un corpo preset taggato (4672 byte) dai campi indicati. */
  function buildTaggedPreset(fields) {
    const unpacked = new Uint8Array(4088);
    let pos = 0;
    let curGroup = null;
    for (const f of fields) {
      if (f.group !== curGroup) {
        if (curGroup === null) {
          unpacked[pos++] = 0x23;
          unpacked.set(str3(f.group), pos);
          pos += 3;
        } else {
          unpacked[pos++] = 0x40;
          unpacked[pos++] = 0x23;
          unpacked.set(str3(f.group), pos);
          pos += 3;
        }
        curGroup = f.group;
      }
      const nameBytes = Array.from(f.name).map((c) => c.charCodeAt(0));
      unpacked[pos++] = 0x40 + nameBytes.length;
      unpacked.set(nameBytes, pos);
      pos += nameBytes.length;
      unpacked[pos++] = 0x63;
      unpacked[pos++] = f.meta || 0;
      unpacked[pos++] = f.raw & 0xff;
      unpacked[pos++] = (f.raw >> 8) & 0xff;
    }
    return Params.pack7to8(unpacked);
  }

  await test('setFieldValue: cambia Gen.PrstVol e lascia invariato il resto', () => {
    const body = buildTaggedPreset([
      { group: 'Gen', name: 'PrstVol', meta: 24, raw: 10000 },
      { group: 'Gen', name: 'UniSprd', meta: 0, raw: 500 },
      { group: 'VCO', name: 'Type', meta: 22, raw: 20000 },
    ]);
    const newBody = Params.setFieldValue(body, 'Gen.PrstVol', 30000);
    assert.ok(newBody);
    assert.strictEqual(newBody.length, 4672);
    const { fields } = Params.parseStructured(newBody);
    assert.strictEqual(fields.find((f) => f.key === 'Gen.PrstVol').raw, 30000);
    assert.strictEqual(fields.find((f) => f.key === 'Gen.UniSprd').raw, 500);
    assert.strictEqual(fields.find((f) => f.key === 'VCO.Type').raw, 20000);
    // solo i 2 byte del volume differiscono dal corpo originale
    let diffs = 0;
    for (let i = 0; i < 4672; i++) if (body[i] !== newBody[i]) diffs++;
    assert.strictEqual(diffs, 2);
  });

  await test('setFieldValue: valore con byte alti (>127) gestisce la bitmap', () => {
    const body = buildTaggedPreset([{ group: 'Gen', name: 'PrstVol', meta: 24, raw: 0 }]);
    const newBody = Params.setFieldValue(body, 'Gen.PrstVol', 32767);
    const { fields } = Params.parseStructured(newBody);
    assert.strictEqual(fields.find((f) => f.key === 'Gen.PrstVol').raw, 32767);
    // round-trip pack/unpack stabile
    const u1 = Params.unpack8to7(newBody);
    assert.deepStrictEqual(Array.from(Params.unpack8to7(Params.pack7to8(u1))), Array.from(u1));
  });

  await test('setFieldValue: campo assente o corpo non taggato → null', () => {
    const body = buildTaggedPreset([{ group: 'Gen', name: 'UniSprd', meta: 0, raw: 1 }]);
    assert.strictEqual(Params.setFieldValue(body, 'Gen.PrstVol', 100), null);
    const zeros = new Uint8Array(4672);
    assert.strictEqual(Params.setFieldValue(zeros, 'Gen.PrstVol', 100), null);
    assert.strictEqual(Params.setFieldValue(null, 'Gen.PrstVol', 100), null);
  });

  await test('Gen.Volume NON viene usato come volume (campo costante)', () => {
    // un preset con solo Gen.Volume (senza Gen.PrstVol) non ha volume editabile
    const body = buildTaggedPreset([{ group: 'Gen', name: 'Volume', meta: 230, raw: 32766 }]);
    assert.strictEqual(Params.getFieldValue(body, Params.VOLUME_KEY), null);
    assert.strictEqual(Params.setFieldValue(body, Params.VOLUME_KEY, 16384), null);
    // il campo esiste ma è distinto dal volume
    assert.strictEqual(Params.getFieldValue(body, 'Gen.Volume'), 32766);
  });

  await test('getFieldValue: legge il valore corrente', () => {
    const body = buildTaggedPreset([{ group: 'Gen', name: 'PrstVol', meta: 24, raw: 12345 }]);
    assert.strictEqual(Params.getFieldValue(body, 'Gen.PrstVol'), 12345);
    assert.strictEqual(Params.getFieldValue(body, 'VCO.Type'), null);
  });

  await test('volumeDbToRaw / volumeRawToDb: conversione dB come sul MicroFreak', () => {
    // -12 dB = raw 0, 0 dB = raw 16384 (centro), +12 dB = raw 32767
    assert.strictEqual(Params.volumeDbToRaw(-12), 0);
    assert.strictEqual(Params.volumeDbToRaw(12), 32767);
    assert.strictEqual(Params.volumeDbToRaw(0), 16384);
    assert.strictEqual(Params.volumeDbToRaw(-20), 0);  // clamp
    assert.strictEqual(Params.volumeDbToRaw(20), 32767); // clamp
    assert.strictEqual(Params.volumeRawToDb(0), -12);
    assert.strictEqual(Params.volumeRawToDb(32767), 12);
    // 16384 è il raw più vicino a 0 dB (quantizzazione: 0.0004 dB di scarto)
    assert.ok(Math.abs(Params.volumeRawToDb(16384)) < 0.001);
    // round-trip a passi interi di dB
    for (let db = -12; db <= 12; db++) {
      assert.strictEqual(Math.round(Params.volumeRawToDb(Params.volumeDbToRaw(db))), db);
    }
    assert.strictEqual(Params.volumeDbLabel(3), '+3 dB');
    assert.strictEqual(Params.volumeDbLabel(0), '0 dB');
    assert.strictEqual(Params.volumeDbLabel(-12), '-12 dB');
  });

  await test('friendlyValue: Gen.PrstVol mostrato in dB', () => {
    const body = buildTaggedPreset([{ group: 'Gen', name: 'PrstVol', meta: 24, raw: 16384 }]);
    const { fields } = Params.parseStructured(body);
    const vol = fields.find((f) => f.key === 'Gen.PrstVol');
    assert.strictEqual(Params.friendlyValue(vol).text, '0 dB');
    const body2 = Params.setFieldValue(body, 'Gen.PrstVol', Params.volumeDbToRaw(6));
    const vol2 = Params.parseStructured(body2).fields.find((f) => f.key === 'Gen.PrstVol');
    assert.strictEqual(Params.friendlyValue(vol2).text, '+6 dB');
  });

  // ================================================================== FINE
  console.log('');
  console.log(`Risultato: ${pass} test superati, ${fail} falliti.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('Errore globale nei test:', e);
  process.exit(1);
});
