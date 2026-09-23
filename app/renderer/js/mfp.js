// ManageFreak — formati file: .mfp / .mbp (Arturia MCC), .mfpz, .mfprojz, .syx
'use strict';

const Mfp = (() => {
  // -------------------------------------------------------------------------
  // Utilità
  // -------------------------------------------------------------------------

  const te = new TextEncoder();
  const td = new TextDecoder();

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function bytesToText(bytes) {
    return td.decode(bytes);
  }

  // -------------------------------------------------------------------------
  // CRC32 (per ZIP)
  // -------------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // -------------------------------------------------------------------------
  // Inflate/Deflate raw: DecompressionStream nel renderer, zlib in Node
  // -------------------------------------------------------------------------

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (typeof require !== 'undefined') {
      const zlib = require('zlib');
      return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));
    }
    throw new Error('Nessun decompressore disponibile');
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (typeof require !== 'undefined') {
      const zlib = require('zlib');
      return new Uint8Array(zlib.deflateRawSync(Buffer.from(bytes)));
    }
    throw new Error('Nessun compressore disponibile');
  }

  // -------------------------------------------------------------------------
  // ZIP minimale (scrittura: stored; lettura: stored + deflate)
  // -------------------------------------------------------------------------

  async function writeZip(entries) {
    // entries: [{name, data: Uint8Array}]
    const enc = (s) => te.encode(s);
    const chunks = [];
    const central = [];
    let offset = 0;

    const pushU16 = (v) => chunks.push(new Uint8Array([v & 0xff, (v >> 8) & 0xff]));
    const pushU32 = (v) => chunks.push(new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]));

    for (const entry of entries) {
      const nameB = enc(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const localStart = offset;

      // Local file header
      chunks.push(new Uint8Array([0x50, 0x4b, 0x03, 0x04])); // sig
      pushU16(20); // version needed
      pushU16(0); // flags
      pushU16(0); // method: stored
      pushU16(0); // time
      pushU16(0x21); // date (1980-01-01)
      pushU32(crc);
      pushU32(data.length);
      pushU32(data.length);
      pushU16(nameB.length);
      pushU16(0); // extra len
      chunks.push(nameB);
      chunks.push(data);
      offset += 30 + nameB.length + data.length;

      central.push({ nameB, crc, size: data.length, localStart });
    }

    const cdStart = offset;
    for (const c of central) {
      chunks.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02])); // sig
      pushU16(20); // version made by
      pushU16(20); // version needed
      pushU16(0); // flags
      pushU16(0); // method
      pushU16(0);
      pushU16(0x21);
      pushU32(c.crc);
      pushU32(c.size);
      pushU32(c.size);
      pushU16(c.nameB.length);
      pushU16(0); // extra
      pushU16(0); // comment
      pushU16(0); // disk
      pushU16(0); // internal attrs
      pushU32(0); // external attrs
      pushU32(c.localStart);
      chunks.push(c.nameB);
      offset += 46 + c.nameB.length;
    }
    const cdSize = offset - cdStart;

    chunks.push(new Uint8Array([0x50, 0x4b, 0x05, 0x06])); // EOCD
    pushU16(0);
    pushU16(0);
    pushU16(central.length);
    pushU16(central.length);
    pushU32(cdSize);
    pushU32(cdStart);
    pushU16(0); // comment len

    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  async function readZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => dv.getUint16(o, true);
    const u32 = (o) => dv.getUint32(o, true);

    // trova EOCD negli ultimi 64KB+22
    let eocd = -1;
    const min = Math.max(0, bytes.length - 0xffff - 22);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Invalid ZIP archive (EOCD not found)');

    const count = u16(eocd + 10);
    const cdSize = u32(eocd + 12);
    const cdStart = u32(eocd + 16);

    const entries = [];
    let p = cdStart;
    const cdEnd = cdStart + cdSize;
    while (p < cdEnd) {
      if (u32(p) !== 0x02014b50) break;
      const method = u16(p + 10);
      const csize = u32(p + 20);
      const usize = u32(p + 24);
      const nameLen = u16(p + 28);
      const extraLen = u16(p + 30);
      const commentLen = u16(p + 32);
      const localOff = u32(p + 42);
      const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name, method, csize, usize, localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }

    const out = [];
    for (const e of entries) {
      // local header
      const lNameLen = u16(e.localOff + 26);
      const lExtraLen = u16(e.localOff + 28);
      const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
      let data = bytes.subarray(dataStart, dataStart + e.csize);
      if (e.method === 8) {
        data = await inflateRaw(data);
      } else if (e.method !== 0) {
        throw new Error(`Unsupported ZIP method (${e.method}) for ${e.name}`);
      }
      out.push({ name: e.name, data: new Uint8Array(data) });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Formato .mfp / .mbp
  //   "22 serialization::archive 10 0 4 <lenver> <ver> <lenname> <name> \
  //    <cat> 0 0 18 000000000000000000 <init> 0 <p1> <datalen> <b0>..<bn>\n"
  // I byte sono decimali CON SEGNO (int8).
  // -------------------------------------------------------------------------

  // "Characteristics" Arturia: il campo a 18 caratteri del file MCC.
  // Il bit più a destra è Acid, poi Aggressive … fino a Soundtrack a sinistra.
  const CHARACTERISTICS = [
    'Acid', 'Aggressive', 'Ambient', 'Bizarre', 'Bright', 'Complex', 'Dark',
    'Digital', 'Ensemble', 'Funky', 'Hard', 'Long', 'Noise', 'Quiet', 'Short',
    'Simple', 'Soft', 'Soundtrack',
  ];

  function characteristicsToBitset(chars) {
    const bits = Array(18).fill('0');
    for (const ch of chars) {
      const idx = CHARACTERISTICS.indexOf(ch);
      if (idx >= 0) bits[17 - idx] = '1';
    }
    return bits.join('');
  }

  function bitsetToCharacteristics(bitset) {
    const out = [];
    for (let i = 0; i < 18 && i < bitset.length; i++) {
      if (bitset[17 - i] === '1') out.push(CHARACTERISTICS[i]);
    }
    return out;
  }

  function serializeMfp({ name = '', category = 0, init = 0, p1 = 0, data, characteristics = [] }) {
    if (!data || data.length !== 4672) throw new Error('Invalid preset body length (expected 4672 bytes)');
    const parts = [];
    const tag = 'serialization::archive';
    parts.push(`22 ${tag} 10 0 4`);
    const version = '174';
    parts.push(`${version.length} ${version}`);
    const nm = (name || '').slice(0, 64);
    parts.push(`${nm.length} ${nm}`);
    parts.push(`${category & 0x7f} 0 0`);
    parts.push(`18 ${characteristicsToBitset(characteristics || [])}`);
    parts.push(`${init ? 1 : 0} 0 ${p1 & 0x7f}`);
    parts.push(`${data.length}`);
    let body = parts.join(' ');
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      body += ' ' + (b > 127 ? b - 256 : b);
    }
    body += '\n';
    return te.encode(body);
  }

  function parseMfp(bytes) {
    const text = bytesToText(bytes).replace(/\r\n/g, '\n');
    const tokens = text.trim().split(/\s+/);
    let i = 0;
    const num = () => parseInt(tokens[i++], 10);

    if (num() !== 22 || tokens[i++] !== 'serialization::archive') {
      throw new Error('Unrecognized preset file (serialization::archive header missing)');
    }
    if (num() !== 10 || num() !== 0 || num() !== 4) {
      throw new Error('Unrecognized preset file (unexpected version fields)');
    }
    const verLen = num();
    const version = tokens[i++];
    if (verLen !== version.length) throw new Error('Inconsistent version length');

    const nameLen = num();
    let name = '';
    if (nameLen > 0) {
      name = tokens[i++];
      if (nameLen !== name.length) {
        // nomi con spazi: ricostruisci da più token (raro, ma robusto)
        let missing = nameLen - name.length;
        while (missing > 0 && i < tokens.length) {
          const next = tokens[i++];
          name += ' ' + next;
          missing -= next.length + 1;
        }
      }
    }

    const category = num();
    if (num() !== 0 || num() !== 0) throw new Error('Expected p0 fields not found');
    const charsLen = num();
    if (charsLen !== 18) throw new Error('Unexpected characteristics field');
    const bitset = tokens[i++] || '';
    const characteristics = bitsetToCharacteristics(bitset);
    const init = num();
    if (num() !== 0) throw new Error('Expected p4 field not found');
    const p1 = num();
    const datalen = num();

    const data = new Uint8Array(datalen);
    for (let k = 0; k < datalen; k++) {
      const v = num();
      data[k] = v & 0xff;
    }
    return { version, name, category, init, p1, data, characteristics };
  }

  /** .mfpz: zip con membro "0_preset". */
  async function parseMfpz(bytes) {
    const entries = await readZip(bytes);
    const e = entries.find((x) => x.name === '0_preset' || x.name.endsWith('/0_preset'));
    if (!e) throw new Error('.mfpz without 0_preset member');
    return parseMfp(e.data);
  }

  async function serializeMfpz(preset, presetName) {
    const data = serializeMfp(preset);
    return writeZip([{ name: '0_preset', data }]);
  }

  /** .mfprojz: progetto MCC (project/bank/*.mbp). */
  async function parseMfprojz(bytes) {
    const entries = await readZip(bytes);
    const presets = [];
    for (const e of entries) {
      const base = e.name.split('/').pop();
      if (/\.(mbp|mfp)$/i.test(base)) {
        try {
          const preset = parseMfp(e.data);
          const m = /^(\d+)/.exec(base);
          presets.push({ fileName: base, slot: m ? parseInt(m[1], 10) : null, ...preset });
        } catch {
          /* salta membri non preset */
        }
      }
    }
    if (!presets.length) throw new Error('.mfprojz without presets');
    presets.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
    return presets;
  }

  /**
   * Serializza una bank (elenco di preset) in un file .mfprojz compatibile con
   * Arturia MIDI Control Center: membri project/bank/NNN-file.mbp.
   * @param {Array} presets [{slot, name, category, p1, data}]
   * @returns {Promise<Uint8Array>}
   */
  async function serializeMfprojz(presets) {
    const entries = presets.map((p) => {
      const safe = (p.name || 'preset').replace(/[\\/:*?"<>|]/g, '_');
      const fileName = `${String(p.slot).padStart(3, '0')}-${safe}.mbp`;
      const data = serializeMfp({
        name: p.name,
        category: p.category !== undefined ? p.category : 0,
        init: 0,
        p1: p.p1 !== undefined ? p.p1 : 0,
        data: p.data,
        characteristics: p.characteristics || [],
      });
      return { name: `project/bank/${fileName}`, data };
    });
    // indice della bank come membro extra (ignorato da MCC, utile per noi)
    const info = {
      exportedAt: new Date().toISOString(),
      device: 'Arturia MicroFreak',
      count: presets.length,
      presets: presets.map((p) => ({
        slot: p.slot,
        name: p.name,
        category: p.category !== undefined ? p.category : 0,
        categoryName: MF.CATEGORIES[p.category] || '',
      })),
    };
    entries.push({
      name: 'project/bank-info.json',
      data: te.encode(JSON.stringify(info, null, 2)),
    });
    return writeZip(entries);
  }

  /** .syx: concatenazione di messaggi SysEx (header 0x52 + parti 0x16/0x17). */
  function parseSyx(bytes) {
    const messages = [];
    let i = 0;
    while (i < bytes.length) {
      if (bytes[i] !== 0xf0) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < bytes.length && bytes[j] !== 0xf7) j++;
      if (j < bytes.length) {
        messages.push(bytes.subarray(i, j + 1));
        i = j + 1;
      } else {
        break;
      }
    }
    let header = null;
    const parts = [];
    for (const m of messages) {
      // F0 00 20 6B 07 01 SS LL OP payload F7
      if (m.length < 10 || m[1] !== 0x00 || m[2] !== 0x20 || m[3] !== 0x6b || m[4] !== 0x07) continue;
      const op = m[8];
      if (op === 0x52 && m.length >= 9 + 35) {
        header = m.subarray(9, 9 + 35);
      } else if ((op === 0x16 || op === 0x17) && m.length >= 9 + 32) {
        parts.push(m.subarray(9, 9 + 32));
      }
    }
    if (!header) throw new Error('.syx file without preset header (op 0x52)');
    if (!parts.length) throw new Error('.syx file without preset data');
    const data = new Uint8Array(4672);
    const n = Math.min(parts.length, 146);
    for (let k = 0; k < n; k++) data.set(parts[k], k * 32);
    const h = MF.decodeHeader(header, 0);
    return { name: h.name, category: h.category, p1: h.p1, rawHeader: Uint8Array.from(header), data };
  }

  // -------------------------------------------------------------------------
  // Wavetable: .mfw (Boost text + 16384 byte PCM16LE), .mfwz (zip 0_sample)
  //   Layout: 22 serialization::archive 10 0 4 <vlen> <tag> <nlen> <name>
  //           <p0> 0 0 18 <bits> <p3> 0 <p5> <datalen> <signed bytes>\n
  //   WAV sorgente: mono PCM16, 32000 Hz, esattamente 8192 campioni
  //   (32 cicli × 256 campioni), come richiesto da MCC/freakout.
  // -------------------------------------------------------------------------

  const MFW_PCM_BYTES = 16384;
  const MFW_WAV_FRAMES = 8192;
  const MFW_WAV_RATE = 32000;

  function serializeMfw({ name = '', versionTag = 'DEVBUILD', p0 = 1, p3 = 0, p5 = 1, data, characteristics = [] }) {
    if (!data || data.length !== MFW_PCM_BYTES) throw new Error('Invalid wavetable body length (expected 16384 bytes)');
    const parts = [];
    parts.push(`22 serialization::archive 10 0 4`);
    const tag = (versionTag || 'DEVBUILD').slice(0, 64);
    parts.push(`${tag.length} ${tag}`);
    const nm = (name || '').slice(0, 15);
    parts.push(`${nm.length} ${nm}`);
    parts.push(`${p0 & 0x7f} 0 0`);
    parts.push(`18 ${characteristicsToBitset(characteristics || [])}`);
    parts.push(`${p3 & 0x7f} 0 ${p5 & 0x7f}`);
    parts.push(`${data.length}`);
    let body = parts.join(' ');
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      body += ' ' + (b > 127 ? b - 256 : b);
    }
    body += '\n';
    return te.encode(body);
  }

  function parseMfw(bytes) {
    const text = bytesToText(bytes).replace(/\r\n/g, '\n');
    const tokens = text.trim().split(/\s+/);
    let i = 0;
    const num = () => parseInt(tokens[i++], 10);

    if (num() !== 22 || tokens[i++] !== 'serialization::archive') {
      throw new Error('Unrecognized wavetable file (serialization::archive header missing)');
    }
    if (num() !== 10 || num() !== 0 || num() !== 4) {
      throw new Error('Unrecognized wavetable file (unexpected version fields)');
    }
    const verLen = num();
    const versionTag = tokens[i++];
    if (verLen !== versionTag.length) throw new Error('Inconsistent version length');

    const nameLen = num();
    let name = '';
    if (nameLen > 0) {
      name = tokens[i++];
      if (nameLen !== name.length) {
        let missing = nameLen - name.length;
        while (missing > 0 && i < tokens.length) {
          const next = tokens[i++];
          name += ' ' + next;
          missing -= next.length + 1;
        }
      }
    }

    const p0 = num();
    if (num() !== 0 || num() !== 0) throw new Error('Expected p0 fields not found');
    const charsLen = num();
    if (charsLen !== 18) throw new Error('Unexpected characteristics field');
    const bitset = tokens[i++] || '';
    const characteristics = bitsetToCharacteristics(bitset);
    const p3 = num();
    if (num() !== 0) throw new Error('Expected p4 field not found');
    const p5 = num();
    const datalen = num();

    const data = new Uint8Array(datalen);
    for (let k = 0; k < datalen; k++) data[k] = num() & 0xff;
    return { versionTag, name, p0, p3, p5, data, characteristics };
  }

  async function parseMfwz(bytes) {
    const entries = await readZip(bytes);
    const e = entries.find((x) => x.name === '0_sample' || x.name.endsWith('/0_sample'));
    if (!e) throw new Error('.mfwz without 0_sample member');
    return parseMfw(e.data);
  }

  async function serializeMfwz(wt) {
    return writeZip([{ name: '0_sample', data: serializeMfw(wt) }]);
  }

  // -------------------------------------------------------------------------
  // Sample: .mfsample = header raw 28 byte + corpo PCM esatto
  //   (artefatto di recupero lossless documentato da freakout)
  // -------------------------------------------------------------------------

  function serializeMsample(header, data) {
    const out = new Uint8Array(header.length + data.length);
    out.set(header, 0);
    out.set(data, header.length);
    return out;
  }

  function parseMsample(bytes) {
    if (bytes.length < 28) throw new Error('.mfsample too short');
    return {
      header: Uint8Array.from(bytes.subarray(0, 28)),
      data: Uint8Array.from(bytes.subarray(28)),
    };
  }

  // -------------------------------------------------------------------------
  // WAV (RIFF PCM): parser minimale + conversione per wavetable/sample
  // -------------------------------------------------------------------------

  function parseWav(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 44 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
      throw new Error('Not a RIFF/WAV file');
    }
    if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) {
      throw new Error('Not a WAVE file');
    }
    let fmt = null;
    let dataChunk = null;
    let p = 12;
    while (p + 8 <= bytes.length) {
      const id = td.decode(bytes.subarray(p, p + 4));
      const size = dv.getUint32(p + 4, true);
      const bodyStart = p + 8;
      if (id === 'fmt ') {
        fmt = {
          format: dv.getUint16(bodyStart, true),
          channels: dv.getUint16(bodyStart + 2, true),
          sampleRate: dv.getUint32(bodyStart + 4, true),
          byteRate: dv.getUint32(bodyStart + 8, true),
          blockAlign: dv.getUint16(bodyStart + 12, true),
          bitsPerSample: dv.getUint16(bodyStart + 14, true),
        };
      } else if (id === 'data') {
        dataChunk = bytes.subarray(bodyStart, bodyStart + size);
        break;
      }
      p = bodyStart + size + (size & 1);
    }
    if (!fmt || !dataChunk) throw new Error('WAV missing fmt/data chunk');
    if (fmt.format !== 1 && fmt.format !== 3) {
      throw new Error(`WAV must be uncompressed PCM or IEEE float (got format ${fmt.format})`);
    }

    const bits = fmt.bitsPerSample;
    const pcmOk = fmt.format === 1 && [8, 16, 24, 32].includes(bits);
    const floatOk = fmt.format === 3 && [32, 64].includes(bits);
    if (!pcmOk && !floatOk) {
      throw new Error(`Unsupported WAV sample format: ${fmt.format === 3 ? 'float' : 'PCM'} ${bits}-bit`);
    }

    // conversione automatica → PCM16 LE mono (il formato nativo del MicroFreak):
    // - multicanale → mono con media dei canali (downmix)
    // - 8/24/32-bit PCM → 16-bit
    // - IEEE float 32/64 → 16-bit (scaling ×32768 + clamp)
    const bytesPerSample = bits / 8;
    const channels = fmt.channels;
    if (!channels || channels < 1) throw new Error('WAV has no audio channels');
    const frames = Math.floor(dataChunk.length / (channels * bytesPerSample));
    const out = new Uint8Array(frames * 2);
    const ddv = new DataView(dataChunk.buffer, dataChunk.byteOffset, dataChunk.byteLength);
    const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
    const readCh = (frame, ch) => {
      const off = (frame * channels + ch) * bytesPerSample;
      if (fmt.format === 3) {
        return bits === 64 ? ddv.getFloat64(off, true) : ddv.getFloat32(off, true);
      }
      if (bits === 8) return (ddv.getUint8(off) - 128) << 8;
      if (bits === 16) return ddv.getInt16(off, true);
      if (bits === 24) {
        const b0 = ddv.getUint8(off);
        const b1 = ddv.getUint8(off + 1);
        const b2 = ddv.getUint8(off + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (b2 & 0x80) v |= 0xff000000;
        return v >> 8;
      }
      return ddv.getInt32(off, true) >> 16;
    };
    for (let frame = 0; frame < frames; frame++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) sum += readCh(frame, ch);
      const s = fmt.format === 3
        ? clamp16((sum / channels) * 32768)
        : clamp16(sum / channels);
      out[frame * 2] = s & 0xff;
      out[frame * 2 + 1] = (s >> 8) & 0xff;
    }
    return { sampleRate: fmt.sampleRate, data: out, frames };
  }

  /** Risampla PCM16 mono verso una frequenza target con filtro windowed-sinc
   *  (anti-aliasing): l'interpolazione lineare, riducendo la frequenza,
   *  ripiegava le alte frequenze e rendeva il suono "fuzzy"/metallico. */
  function resamplePcm16(data, fromRate, toRate) {
    if (fromRate === toRate) return data;
    const inLen = data.length / 2;
    const outLen = Math.floor((inLen * toRate) / fromRate);
    const out = new Uint8Array(outLen * 2);
    const step = fromRate / toRate; // campioni sorgente per campione output
    // cutoff relativo alla Nyquist sorgente: per downsampling < 1 (anti-alias)
    const cutoff = Math.min(1.0, toRate / fromRate);
    const TAPS = 48;
    const half = TAPS / 2;
    const win = new Float64Array(TAPS);
    for (let n = 0; n < TAPS; n++) {
      win[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) +
        0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
    }
    const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    for (let i = 0; i < outLen; i++) {
      const pos = i * step;
      const center = Math.floor(pos);
      let acc = 0;
      let wsum = 0;
      for (let k = -half + 1; k <= half; k++) {
        const idx = center + k;
        if (idx < 0 || idx >= inLen) continue;
        const x = pos - idx;
        const w = sinc(x * cutoff) * win[k + half - 1];
        wsum += w;
        let s = data[idx * 2] | (data[idx * 2 + 1] << 8);
        if (s >= 0x8000) s -= 0x10000;
        acc += s * w;
      }
      let v = wsum !== 0 ? Math.round(acc / wsum) : 0;
      if (v < -32768) v = -32768;
      if (v > 32767) v = 32767;
      out[i * 2] = v & 0xff;
      out[i * 2 + 1] = (v >> 8) & 0xff;
    }
    return out;
  }

  /** WAV → wavetable: mono PCM16, risampla a 32 kHz, taglia/ripete fino a 8192 campioni. */
  function wavToWavetable(bytes, name) {
    const wav = parseWav(bytes);
    let data = resamplePcm16(wav.data, wav.sampleRate, MFW_WAV_RATE);
    const targetFrames = 8192;
    const curFrames = Math.floor(data.length / 2);
    if (curFrames > targetFrames) {
      data = data.subarray(0, targetFrames * 2);
    } else if (curFrames < targetFrames) {
      // un WAV con chunk "data" vuoto (o troppo corto) non ha campioni: senza
      // questa guardia il ciclo sotto non avanzerebbe mai (blocco dell'app)
      if (curFrames === 0) throw new Error('WAV contains no audio samples');
      // ripete ciclicamente il materiale fino a riempire 8192 campioni
      const out = new Uint8Array(targetFrames * 2);
      let off = 0;
      while (off < out.length) {
        const take = Math.min(data.length, out.length - off);
        out.set(data.subarray(0, take), off);
        off += take;
      }
      data = out;
    }
    return { name: (name || 'Wavetable').slice(0, 15), data };
  }

  /** WAV → sample (mono PCM16, risampla a 32 kHz, max 24 s). */
  function wavToSample(bytes, name) {
    const wav = parseWav(bytes);
    const data = resamplePcm16(wav.data, wav.sampleRate, MFW_WAV_RATE);
    if (data.length < 2) throw new Error('Sample too short');
    if (data.length > 24 * 32000 * 2) {
      throw new Error('Sample longer than 24 s at 32 kHz');
    }
    return { name: (name || 'Sample').slice(0, 12), data };
  }

  // -------------------------------------------------------------------------
  // Backup completo del dispositivo: ZIP con manifest + preset/wavetable/
  // sample/device JSON (tutti i corpi in base64)
  // -------------------------------------------------------------------------

  async function serializeFullBackup({ presets = [], wavetables = [], samples = [], globals = {}, meta = {} } = {}) {
    const entries = [
      {
        name: 'manifest.json',
        data: te.encode(JSON.stringify({
          format: 'managefreak-full-backup',
          version: 1,
          ...meta,
          counts: {
            presets: presets.length,
            wavetables: wavetables.length,
            samples: samples.length,
            globals: Object.keys(globals).length,
          },
        }, null, 1)),
      },
      { name: 'presets.json', data: te.encode(JSON.stringify({ entries: presets })) },
      { name: 'wavetables.json', data: te.encode(JSON.stringify({ entries: wavetables })) },
      { name: 'samples.json', data: te.encode(JSON.stringify({ entries: samples })) },
      { name: 'device.json', data: te.encode(JSON.stringify({ globals })) },
    ];
    return writeZip(entries);
  }

  async function parseFullBackup(bytes) {
    const entries = await readZip(bytes);
    const get = (name) => {
      const e = entries.find((x) => x.name === name);
      return e ? JSON.parse(bytesToText(e.data)) : null;
    };
    const manifest = get('manifest.json');
    if (!manifest || manifest.format !== 'managefreak-full-backup') {
      throw new Error('Not a ManageFreak full backup');
    }
    return {
      manifest,
      presets: (get('presets.json') || {}).entries || [],
      wavetables: (get('wavetables.json') || {}).entries || [],
      samples: (get('samples.json') || {}).entries || [],
      globals: (get('device.json') || {}).globals || {},
    };
  }

  return {
    b64ToBytes,
    bytesToB64,
    bytesToText,
    crc32,
    writeZip,
    readZip,
    inflateRaw,
    deflateRaw,
    serializeMfp,
    parseMfp,
    parseMfpz,
    serializeMfpz,
    parseMfprojz,
    serializeMfprojz,
    parseSyx,
    CHARACTERISTICS,
    MFW_PCM_BYTES,
    serializeMfw,
    parseMfw,
    parseMfwz,
    serializeMfwz,
    serializeMsample,
    parseMsample,
    parseWav,
    resamplePcm16,
    wavToWavetable,
    wavToSample,
    serializeFullBackup,
    parseFullBackup,
  };
})();

if (typeof module !== 'undefined') module.exports = Mfp;
if (typeof globalThis !== 'undefined') globalThis.Mfp = Mfp;
