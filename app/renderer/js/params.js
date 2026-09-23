// ManageFreak — decodifica del corpo preset MicroFreak
//
// Il corpo trasferito (4672 byte) è impacchettato 8→7 bit. Dopo l'unpack
// (4088 byte) i preset firmware 5 contengono un prefisso "auto-descrittivo":
//   gruppo:  '@#' + 3 byte nome (o 0x23 + 3 byte al primo gruppo)
//   campo:   (0x40 + lunghezza nome) nome 'c'(0x63) metadata uint16-le
//
// Fonti:
//   - https://github.com/kmorrill/freakout (docs/microfreak-sysex.md, MIT)
//   - https://github.com/francoisgeorgy/microfreak-reader
'use strict';

const Params = (() => {
  const ENGINES_22 = [
    null, // indice 0 non usato (runtime 1..22)
    'BasicWaves', 'SuperWave', 'Wavetable', 'Harmo', 'KarplusStr', 'V.Analog',
    'Waveshaper', 'Two Op. FM', 'Formant', 'Chords', 'Speech', 'Modal',
    'Noise', 'Vocoder', 'Bass', 'SawX', 'Harm', 'WaveUser', 'Sample',
    'Scan Grains', 'Cloud Grains', 'Hit Grains',
  ];

  const ENGINES_LEGACY = [
    'BasicWaves', 'Superwave', 'Wavetable', 'Harmonic', 'KarplusStrong',
    'V.Analog', 'Waveshaper', 'Two Op. FM', 'Formant', 'Chords', 'Speech',
    'Modal', 'Noise',
  ];

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

  /** 7 byte raw → 8 byte MIDI (bitmap + 7 byte a 7 bit). Speculare di MF.pack7to8,
   *  tenuto qui per non dipendere dall'ordine di caricamento degli script. */
  function pack7to8(data) {
    if (data.length % 7 !== 0) throw new Error('pack7to8: input length must be a multiple of 7');
    const out = new Uint8Array((data.length / 7) * 8);
    for (let block = 0; block * 7 < data.length; block++) {
      const base = block * 7;
      const outBase = block * 8;
      let bitmap = 0;
      for (let i = 0; i < 7; i++) {
        if (data[base + i] & 0x80) bitmap |= 1 << i;
      }
      out[outBase] = bitmap;
      for (let i = 0; i < 7; i++) {
        out[outBase + 1 + i] = data[base + i] & 0x7f;
      }
    }
    return out;
  }

  /** Cammina la struttura taggata di un corpo già unpackato (4088 byte).
   *  Ogni campo include anche rawPos: offset dei 2 byte (LE) del valore raw. */
  function walkFields(unpacked) {
    const fields = [];
    let group = null;
    let pos = 0;
    while (pos < unpacked.length) {
      let groupBytes = null;
      if (pos === 0 && unpacked[pos] === 0x23) {
        groupBytes = unpacked.subarray(pos + 1, pos + 4);
        pos += 4;
      } else if (unpacked[pos] === 0x40 && unpacked[pos + 1] === 0x23) {
        groupBytes = unpacked.subarray(pos + 2, pos + 5);
        pos += 5;
      }
      if (groupBytes) {
        if (groupBytes.length !== 3) break;
        group = String.fromCharCode(...groupBytes);
        continue;
      }
      const nameLen = unpacked[pos] - 0x40;
      const end = pos + 1 + nameLen;
      if (!group || nameLen < 1 || nameLen > 31 || end + 4 > unpacked.length) break;
      const nameBytes = unpacked.subarray(pos + 1, end);
      if (unpacked[end] !== 0x63) break;
      const name = String.fromCharCode(...nameBytes);
      const metadata = unpacked[end + 1];
      const raw = unpacked[end + 2] | (unpacked[end + 3] << 8);
      const s16 = raw < 0x8000 ? raw : raw - 0x10000;
      fields.push({ key: `${group}.${name}`, group, name, metadata, raw, s16, rawPos: end + 2 });
      pos = end + 4;
    }
    return fields;
  }

  /**
   * Estrae i campi taggati firmware 5.
   * @returns {Array} [{key, group, name, metadata, raw, s16, rawPos}]
   */
  function parseStructured(data) {
    if (!data || data.length !== 4672) return { fields: [], unpacked: null };
    const unpacked = unpack8to7(data);
    return { fields: walkFields(unpacked), unpacked };
  }

  /**
   * Imposta il valore raw (0..32767) di un campo taggato nel corpo preset
   * (4672 byte, formato 8→7 bit) e restituisce un NUOVO corpo modificato.
   * Restituisce null se il corpo non è taggato o il campo non esiste.
   */
  function setFieldValue(packedData, key, rawValue) {
    if (!packedData || packedData.length !== 4672) return null;
    const unpacked = unpack8to7(packedData);
    const fields = walkFields(unpacked);
    const f = fields.find((x) => x.key === key);
    if (!f) return null;
    const v = Math.max(0, Math.min(0xffff, Math.round(rawValue)));
    const out = new Uint8Array(unpacked);
    out[f.rawPos] = v & 0xff;
    out[f.rawPos + 1] = (v >> 8) & 0xff;
    return pack7to8(out);
  }

  /** Legge il valore raw (0..32767) di un campo taggato, o null se assente. */
  function getFieldValue(packedData, key) {
    if (!packedData || packedData.length !== 4672) return null;
    const f = walkFields(unpack8to7(packedData)).find((x) => x.key === key);
    return f ? f.raw : null;
  }

  // ------------------------------------------------------------------ volume

  // Sul MicroFreak il Volume è mostrato in dB da -12 a +12 (0 dB = valore
  // neutro). Il campo salvato nel preset è "Gen.PrstVol" (Preset Volume):
  // il suo metadata è 24, cioè lo span in dB (-12..+12). Il campo
  // "Gen.Volume" invece è costante (32766) in ogni preset e NON è il volume
  // mostrato dal synth. Il raw 0..32767 è mappato linearmente sull'intervallo.
  const VOLUME_KEY = 'Gen.PrstVol';
  const VOLUME_DB_MIN = -12;
  const VOLUME_DB_MAX = 12;
  const VOLUME_DB_SPAN = VOLUME_DB_MAX - VOLUME_DB_MIN; // 24

  const volumeDbToRaw = (db) => {
    const v = Math.max(VOLUME_DB_MIN, Math.min(VOLUME_DB_MAX, db));
    return Math.round(((v - VOLUME_DB_MIN) / VOLUME_DB_SPAN) * 32767);
  };
  const volumeRawToDb = (raw) => {
    // clamp: un corpo corrotto può contenere un valore fuori scala (fino a
    // 65535) che altrimenti verrebbe mostrato come "+36 dB"
    const v = Math.max(0, Math.min(32767, Number.isFinite(Number(raw)) ? Number(raw) : 0));
    return (v / 32767) * VOLUME_DB_SPAN + VOLUME_DB_MIN;
  };

  /** Formatta i dB come li mostra il MicroFreak: "+3 dB", "0 dB", "-12 dB". */
  const volumeDbLabel = (db) => {
    const v = Math.round(db);
    return `${v > 0 ? '+' : ''}${v} dB`;
  };
  // Campi normalizzati 0..1 (percentuale)
  const NORMALIZED = new Set([
    'VCO.Param1', 'VCO.Param2', 'VCO.Param3',
    'VCF.Cutoff', 'VCF.Reso',
    'EG1.RiseLvl', 'EG1.RiseSlp', 'EG1.FallLvl', 'EG1.Hold',
    'EG1.FallSlp', 'EG1.Amount', 'Kbd.Glide',
    'Arp.Rate', 'Arp.Spice', 'Arp.Dice', 'LFO.Rate',
    'EG2.Attack', 'EG2.DecRel', 'EG2.Sustain',
    'Gen.UniSprd',
  ]);

  // Campi bipolari -1..1 (matrice di modulazione Co1..Co7)
  const BIPOLAR_GROUPS = new Set(['Co1', 'Co2', 'Co3', 'Co4', 'Co5', 'Co6', 'Co7']);

  function friendlyValue(field) {
    const key = field.key;
    if (key === 'VCO.Type') {
      const meta = field.metadata || 22;
      const idx = Math.round((field.raw * meta) / 32767);
      let name;
      if (meta >= 22) name = ENGINES_22[idx] || `Engine ${idx}`;
      else name = idx <= 12 ? ENGINES_LEGACY[idx] : `Engine ${idx}`;
      return { text: name, kind: 'engine' };
    }
    if (key === VOLUME_KEY) {
      return { text: volumeDbLabel(volumeRawToDb(field.raw)), kind: 'db' };
    }
    if (NORMALIZED.has(key)) {
      return { text: `${Math.round((field.raw / 32767) * 1000) / 10}%`, kind: 'percent' };
    }
    if (BIPOLAR_GROUPS.has(field.group)) {
      const v = Math.round((field.s16 / 32767) * 1000) / 10;
      return { text: v === 0 ? '0%' : `${v > 0 ? '+' : ''}${v}%`, kind: 'bipolar' };
    }
    return { text: String(field.raw), kind: 'raw' };
  }

  // Mappatura motori storica per firmware <= 4 (ordine tipo OSC)
  function legacyOscType(v) {
    const ranges = [
      [0x00, 'Basic Waves'], [0x0b, 'Superwave'], [0x16, 'Wavetable'],
      [0x21, 'Harmonic'], [0x2b, 'Karplus Strong'], [0x36, 'V. Analog'],
      [0x41, 'Waveshaper'], [0x4b, 'Two Op. FM'], [0x56, 'Formant'],
      [0x60, 'Chords'], [0x6b, 'Speech'], [0x76, 'Modal'], [0x7f, 'Noise'],
    ];
    for (const [max, name] of ranges) {
      if (v <= max) return name;
    }
    return '?';
  }

  function multibytesValue(data, MSB, LSB, msbCell, msbMask) {
    // MSB/LSB: [row, col]; msbCell: [row, col, mask]
    if (data.length <= MSB[0] || data.length <= LSB[0]) return 0;
    const high = (data[MSB[0]][MSB[1]] & 0x7f) << 8;
    const mid = data[LSB[0]][LSB[1]] & 0x7f;
    let low = 0;
    if (msbCell && data.length > msbCell[0]) {
      low = (data[msbCell[0]][msbCell[1]] & msbCell[2]) ? 0x80 : 0;
    }
    return high + mid + low;
  }

  // Offsets fissi firmware 2 (fallback per preset senza formato taggato)
  const LEGACY_FW2 = [
    { label: 'OSC Type', rows: null, get: (d) => legacyOscType(d[0][14]) },
    { label: 'OSC Wave', m: { MSB: [0, 27], LSB: [0, 26], msb: [0, 24, 0x02] }, get: (d, m) => multibytesValue(d, m.MSB, m.LSB, m.msb) },
    { label: 'OSC Timbre', m: { MSB: [1, 7], LSB: [1, 6], msb: [1, 0, 0x20] } },
    { label: 'OSC Shape', m: { MSB: [1, 20], LSB: [1, 19], msb: [1, 16, 0x04] } },
    { label: 'Cutoff', m: { MSB: [2, 30], LSB: [2, 29], msb: [2, 24, 0x10] } },
    { label: 'Resonance', m: { MSB: [3, 9], LSB: [3, 7], msb: [3, 0, 0x40] } },
    { label: 'CycEnv Rise', m: { MSB: [4, 6], LSB: [4, 5], msb: [4, 0, 0x10] } },
    { label: 'CycEnv Fall', m: { MSB: [5, 2], LSB: [5, 1], msb: [5, 0, 0x01] } },
    { label: 'CycEnv Hold', m: { MSB: [5, 12], LSB: [5, 11], msb: [5, 8, 0x04] } },
    { label: 'CycEnv Amount', m: { MSB: [6, 6], LSB: [6, 5], msb: [6, 0, 0x10] } },
    { label: 'Glide', m: { MSB: [6, 23], LSB: [6, 22], msb: [6, 16, 0x20] } },
    { label: 'Arp/Seq Rate Sync', m: { MSB: [10, 17], LSB: [10, 15], msb: [10, 8, 0x40] } },
    { label: 'Arp/Seq Rate Free', m: { MSB: [10, 27], LSB: [10, 26], msb: [10, 24, 0x02] } },
    { label: 'LFO Rate Sync', m: { MSB: [13, 21], LSB: [13, 20], msb: [13, 16, 0x08] } },
    { label: 'LFO Rate Free', m: { MSB: [13, 31], LSB: [13, 30], msb: [13, 24, 0x20] } },
    { label: 'Env Attack', m: { MSB: [15, 19], LSB: [15, 18], msb: [15, 16, 0x02] } },
    { label: 'Env Decay/Rel', m: { MSB: [15, 31], LSB: [15, 30], msb: [15, 24, 0x20] } },
    { label: 'Env Sustain', m: { MSB: [16, 13], LSB: [16, 12], msb: [16, 8, 0x08] } },
  ];

  /**
   * Decodifica il corpo di un preset in una lista leggibile di parametri.
   * @param {Uint8Array|null} data corpo da 4672 byte
   */
  function describe(data) {
    if (!data) return { kind: 'none', rows: [] };
    const rows = [];
    const { fields } = parseStructured(data);
    if (fields.length) {
      const interesting = fields.filter((f) => {
        if (f.key === 'VCO.Type') return true;
        if (f.key === 'Gen.Volume') return false; // costante in ogni preset, non è il volume
        if (NORMALIZED.has(f.key)) return true;
        if (BIPOLAR_GROUPS.has(f.group)) return true;
        if (f.group === 'EG1' || f.group === 'EG2' || f.group === 'VCF' || f.group === 'VCO' ||
            f.group === 'Arp' || f.group === 'LFO' || f.group === 'Gen' || f.group === 'Kbd') return true;
        return false;
      });
      for (const f of interesting) {
        const v = friendlyValue(f);
        rows.push({ label: f.key, value: v.text, kind: v.kind });
      }
      return { kind: 'tagged', rows, count: fields.length };
    }
    // Fallback firmware <= 4: offsets fissi
    const d = [];
    const n = Math.min(data.length, 38 * 32);
    for (let i = 0; i < n; i += 32) d.push(data.subarray(i, i + 32));
    if (d.length < 16) return { kind: 'none', rows: [] };
    for (const item of LEGACY_FW2) {
      try {
        const raw = item.get ? item.get(d) : multibytesValue(d, item.m.MSB, item.m.LSB, item.m.msb);
        if (typeof raw === 'string') {
          rows.push({ label: item.label, value: raw, kind: 'text' });
        } else {
          rows.push({ label: item.label, value: `${Math.round((raw / 32767) * 1000) / 10}%`, kind: 'percent' });
        }
      } catch {
        /* salta */
      }
    }
    return { kind: 'legacy', rows };
  }

  return {
    unpack8to7, pack7to8, parseStructured, walkFields,
    setFieldValue, getFieldValue,
    VOLUME_KEY, VOLUME_DB_MIN, VOLUME_DB_MAX,
    volumeDbToRaw, volumeRawToDb, volumeDbLabel,
    describe, friendlyValue, legacyOscType, ENGINES_22,
  };
})();

if (typeof module !== 'undefined') module.exports = Params;
if (typeof globalThis !== 'undefined') globalThis.Params = Params;
