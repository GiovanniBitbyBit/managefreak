// ManageFreak — wrapper Web MIDI con richiesta/risposta per SysEx
'use strict';

const Midi = (() => {
  let access = null;
  let input = null;
  let output = null;
  let seq = 0;
  const pending = new Map(); // seq -> {resolve, reject, timer, onData}
  const globalListeners = new Set();
  let stateChangeCb = null;

  const nextSeq = () => {
    const s = seq;
    seq = (seq + 1) & 0x7f;
    return s;
  };

  const fail = (s, err) => {
    const p = pending.get(s);
    if (!p) return;
    pending.delete(s);
    clearTimeout(p.timer);
    p.reject(err);
  };

  const handleMessage = (msg) => {
    const data = msg.data;
    if (!data || !data.length) return;
    if (data[0] === 0xf8) return; // timing clock

    if (data[0] === 0xf0) {
      const s = data.length > 6 ? data[6] : -1;
      const p = pending.get(s);
      if (p) {
        pending.delete(s);
        clearTimeout(p.timer);
        p.resolve(data);
        return;
      }
    }
    for (const l of globalListeners) {
      try {
        l(data);
      } catch (e) {
        /* ignore listener errors */
      }
    }
  };

  const onMidiMessage = (e) => handleMessage(e);

  // ------------------------------------------------------------- backend attivo
  // 'native' = RtMidi nel processo principale (WinMM su Windows, CoreMIDI su
  //            macOS, ALSA su Linux): è il percorso preferito, perché lo strato
  //            Web MIDI di Chromium su Windows può smettere di enumerare i
  //            dispositivi e lasciare l'app senza porte.
  // 'web'    = Web MIDI di Chromium (ripiego, se il modulo nativo non c'è).
  let mode = null;
  let nativePorts = { inputs: [], outputs: [] };
  let nativeUnsub = [];

  const nativeApi = () =>
    typeof window !== 'undefined' && window.mfapi && typeof window.mfapi.midiList === 'function'
      ? window.mfapi
      : null;

  /** Collega gli eventi del backend nativo (messaggi in arrivo, porta persa). */
  // Porte che non vanno né mostrate né usate: il sintetizzatore GS di Windows e
  // il MIDI Mapper passano da wdmaud.drv, che con i SysEx del MicroFreak va in
  // violazione di accesso e fa cadere l'app (poi il MIDI di sistema resta
  // incastrato: è la causa dei "zero porte" visti dopo un crash).
  const UNSAFE_PORT = /wavetable synth|midi mapper/i;
  const usablePort = (p) => !UNSAFE_PORT.test((p && p.name) || '');

  function bindNativeEvents() {
    const api = nativeApi();
    if (!api || nativeUnsub.length) return;
    if (api.onMidiMessage) {
      nativeUnsub.push(
        api.onMidiMessage((bytes) => {
          try {
            handleMessage({ data: Uint8Array.from(bytes || []) });
          } catch {
            /* messaggio malformato: ignora */
          }
        })
      );
    }
    if (api.onMidiState) {
      nativeUnsub.push(
        api.onMidiState((payload) => {
          if (payload && payload.open === false) {
            // porta sparita (USB staccato): stessa segnalazione di Web MIDI
            input = null;
            output = null;
            if (stateChangeCb) {
              try {
                stateChangeCb();
              } catch {
                /* ignora */
              }
            }
          }
        })
      );
    }
  }

  return {
    supported() {
      return (
        !!nativeApi() || (typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess)
      );
    },

    /** 'native' | 'web' | null — usato per diagnostica e messaggi. */
    backend() {
      return mode;
    },

    async refresh() {
      // 1) backend nativo, se disponibile
      const api = nativeApi();
      if (api) {
        try {
          const res = await api.midiList();
          if (res && res.ok) {
            mode = 'native';
            bindNativeEvents();
            nativePorts = {
              inputs: (res.inputs || []).map((p) => ({
                id: p.id,
                name: p.name || p.id,
                manufacturer: p.manufacturer || '',
              })),
              outputs: (res.outputs || []).map((p) => ({
                id: p.id,
                name: p.name || p.id,
                manufacturer: p.manufacturer || '',
              })),
            };
            return;
          }
        } catch {
          /* modulo nativo assente o non caricabile: si prova Web MIDI */
        }
      }
      // 2) ripiego: Web MIDI di Chromium
      mode = 'web';
      if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
        throw new Error('No MIDI backend available (native module and Web MIDI both missing)');
      }
      access = await navigator.requestMIDIAccess({ sysex: true });
      if (access && !access.__mfStateBound) {
        access.__mfStateBound = true;
        access.onstatechange = () => {
          // Gli id delle porte Web MIDI sono indicizzati e cambiano quando
          // un'altra porta MIDI appare o sparisce: se la porta aperta non ha più
          // quell'id la si ritrova per NOME, invece di dichiarare persa la
          // connessione (era la causa di errori casuali "MIDI ports not open").
          const reacquire = (port, map) => {
            if (!port) return null;
            const direct = map.get(port.id);
            if (direct) return direct;
            return Array.from(map.values()).find((p) => (p.name || '') === (port.name || '')) || null;
          };
          const newIn = reacquire(input, access.inputs);
          const newOut = reacquire(output, access.outputs);
          if (input && !newIn) input = null;
          else if (newIn && newIn !== input) {
            input = newIn;
            input.onmidimessage = onMidiMessage;
          }
          if (output && !newOut) output = null;
          else if (newOut && newOut !== output) output = newOut;
          if (stateChangeCb) {
            try { stateChangeCb(); } catch { /* ignore */ }
          }
        };
      }
    },

    onStateChange(fn) {
      stateChangeCb = fn;
    },

    inputs() {
      if (mode === 'native') return nativePorts.inputs.filter(usablePort);
      if (!access) return [];
      return Array.from(access.inputs.values())
        .map((p) => ({
          id: p.id,
          name: p.name || p.id,
          manufacturer: p.manufacturer || '',
        }))
        .filter(usablePort);
    },

    outputs() {
      if (mode === 'native') return nativePorts.outputs.filter(usablePort);
      if (!access) return [];
      return Array.from(access.outputs.values())
        .map((p) => ({
          id: p.id,
          name: p.name || p.id,
          manufacturer: p.manufacturer || '',
        }))
        .filter(usablePort);
    },

    isOpen() {
      return !!(input && output);
    },

    currentNames() {
      return {
        input: input ? input.name || input.id : null,
        output: output ? output.name || output.id : null,
      };
    },

    /** Id delle porte attualmente aperte (per evitare riaperture inutili). */
    currentIds() {
      return {
        input: input ? input.id : null,
        output: output ? output.id : null,
      };
    },

    close() {
      // backend nativo: chiudere le porte nel processo principale
      if (mode === 'native') {
        const api = nativeApi();
        if (api && api.midiClose) {
          try {
            api.midiClose();
          } catch {
            /* ignora */
          }
        }
      }
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Connessione MIDI chiusa'));
      }
      pending.clear();
      if (input) {
        input.onmidimessage = null;
        input = null;
      }
      if (output) output = null;
    },

    /**
     * Rilascio completo prima di uscire dall'app: chiude DAVVERO le porte a
     * livello di sistema. Senza questo Windows resta con il MicroFreak occupato
     * e l'avvio successivo dell'app enumera zero dispositivi MIDI (il bug
     * "la prima volta funziona, poi chiudo e riapro e non trova più le porte").
     * Si usa SOLO all'uscita: una porta Web MIDI chiusa non è più utilizzabile,
     * quindi durante il normale funzionamento si usa close().
     */
    shutdown() {
      const release = (port) => {
        try {
          if (port && typeof port.close === 'function') Promise.resolve(port.close()).catch(() => {});
        } catch {
          /* niente da fare mentre si esce */
        }
      };
      if (mode === 'native') {
        const api = nativeApi();
        if (api && api.midiShutdown) {
          try {
            api.midiShutdown();
          } catch {
            /* niente da fare mentre si esce */
          }
        }
      } else {
        release(input);
        release(output);
      }
      this.close();
      if (access) {
        access.onstatechange = null;
        access = null;
      }
    },

    async open(inputId, outputId) {
      // backend nativo: gli oggetti porta hanno la STESSA forma di quelli Web
      // MIDI (send + messaggi in ingresso), quindi sendSysex, requestSysex,
      // sendCC/sendPC, ping e identity restano identici.
      if (mode === 'native') {
        const api = nativeApi();
        if (!api) throw new Error('Native MIDI bridge not available');
        this.close();
        const res = await api.midiOpen(inputId, outputId);
        if (!res || !res.ok) throw new Error((res && res.error) || 'MIDI port not found');
        const inName = (nativePorts.inputs.find((p) => p.id === inputId) || {}).name || inputId;
        const outName = (nativePorts.outputs.find((p) => p.id === outputId) || {}).name || outputId;
        input = { id: inputId, name: inName };
        output = {
          id: outputId,
          name: outName,
          send: (bytes) => {
            try {
              api.midiSend(Array.from(bytes));
            } catch {
              /* se la porta è sparita lo segnala il timeout della richiesta */
            }
          },
        };
        return true;
      }
      if (!access) await this.refresh();
      this.close();
      const ip = access.inputs.get(inputId);
      const op = access.outputs.get(outputId);
      if (!ip || !op) throw new Error('MIDI port not found');
      ip.onmidimessage = onMidiMessage;
      input = ip;
      output = op;
      return true;
    },

    onMessage(fn) {
      globalListeners.add(fn);
      return () => globalListeners.delete(fn);
    },

    /**
     * Costruisce e invia un messaggio SysEx MicroFreak:
     *   F0 00 20 6B 07 01 SS LL OP [payload] F7
     * @param {number} op operazione
     * @param {Uint8Array|number[]|null} payload
     * @returns {number} numero di sequenza usato
     */
    sendSysex(op, payload) {
      if (!output) throw new Error('No open MIDI output port');
      const bytes = payload ? Array.from(payload) : [];
      const s = nextSeq();
      const msg = [0xf0, 0x00, 0x20, 0x6b, 0x07, 0x01, s, bytes.length & 0x7f, op, ...bytes, 0xf7];
      output.send(msg);
      return s;
    },

    /**
     * Invia un SysEx e attende la risposta con lo stesso numero di sequenza.
     * @returns {Promise<Uint8Array>} messaggio completo ricevuto
     */
    requestSysex(op, payload, timeoutMs = 2500) {
      return new Promise((resolve, reject) => {
        if (!input || !output) {
          reject(new Error('MIDI ports not open'));
          return;
        }
        const s = this.sendSysex(op, payload);
        const timer = setTimeout(() => fail(s, new Error(`MIDI timeout (op 0x${op.toString(16)})`)), timeoutMs);
        pending.set(s, { resolve, reject, timer });
      });
    },

    /**
     * Invia un SysEx e attende la PRIMA risposta SysEx in ingresso, usando
     * l'envelope alternativa 07 7F (controlli/global: la sequenza nella
     * risposta è generata dal dispositivo, non è l'echo della richiesta).
     * @returns {Promise<Uint8Array>} messaggio completo ricevuto
     */
    requestSysexAny(op, payload, timeoutMs = 2500) {
      return new Promise((resolve, reject) => {
        if (!input || !output) {
          reject(new Error('MIDI ports not open'));
          return;
        }
        let done = false;
        const off = this.onMessage((data) => {
          if (done) return;
          if (data[0] !== 0xf0) return;
          // envelope alternativa: F0 00 20 6B 07 7F ...
          if (!(data[1] === 0x00 && data[2] === 0x20 && data[3] === 0x6b &&
                data[4] === 0x07 && data[5] === 0x7f)) return;
          done = true;
          clearTimeout(timer);
          off();
          resolve(data);
        });
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            off();
            reject(new Error(`MIDI timeout (op 0x${op.toString(16)})`));
          }
        }, timeoutMs);
        try {
          this.sendSysex(op, payload);
        } catch (e) {
          done = true;
          clearTimeout(timer);
          off();
          reject(e);
        }
      });
    },

    /** Attende il prossimo messaggio SysEx in ingresso senza inviare nulla. */
    receiveSysex(timeoutMs = 2500) {
      return new Promise((resolve, reject) => {
        if (!input) {
          reject(new Error('MIDI ports not open'));
          return;
        }
        let done = false;
        const off = this.onMessage((data) => {
          if (done) return;
          if (data[0] !== 0xf0) return;
          done = true;
          clearTimeout(timer);
          off();
          resolve(data);
        });
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            off();
            reject(new Error('MIDI timeout'));
          }
        }, timeoutMs);
      });
    },

    sendCC(channel, cc, value) {
      if (!output) return;
      output.send([0xb0 | (channel & 0x0f), cc & 0x7f, value & 0x7f]);
    },

    sendPC(channel, program) {
      if (!output) return;
      output.send([0xc0 | (channel & 0x0f), program & 0x7f]);
    },

    /** Nota premuta: serve all'ascolto dei preset della libreria (audition). */
    sendNoteOn(channel, note, velocity = 100) {
      if (!output) return;
      output.send([0x90 | (channel & 0x0f), note & 0x7f, velocity & 0x7f]);
    },

    /** Rilascio della nota (velocity 0: alcuni device ignorano il Note On a 0). */
    sendNoteOff(channel, note) {
      if (!output) return;
      output.send([0x80 | (channel & 0x0f), note & 0x7f, 0]);
    },

    /** Test di connessione: identity request universale (F0 7E 7F 06 01 F7). */
    ping(timeoutMs = 1500) {
      if (!output || !input) return Promise.resolve(false);
      return new Promise((resolve) => {
        let done = false;
        const off = this.onMessage((data) => {
          if (done) return;
          if (data[0] === 0xf0 && data.length > 7 && data[5] === 0x06 && data[6] === 0x02) {
            done = true;
            clearTimeout(timer);
            off();
            resolve(true);
          }
        });
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            off();
            resolve(false);
          }
        }, timeoutMs);
        try {
          output.send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
        } catch {
          done = true;
          clearTimeout(timer);
          off();
          resolve(false);
        }
      });
    },

    /**
     * Legge la versione firmware dall'identity reply (F0 7E <dev> 06 02 …).
     * Arturia: manufacturer 00 20 6B, family 2 byte, model 2 byte, poi 4 byte
     * di versione letterali (es. 05 00 00 24 → "5.0.0.36").
     */
    identity(timeoutMs = 1500) {
      if (!output || !input) return Promise.resolve(null);
      return new Promise((resolve) => {
        let done = false;
        const off = this.onMessage((data) => {
          if (done) return;
          if (data[0] !== 0xf0 || data.length < 16 || data[4] !== 0x02) return;
          const offset = data.length - 15; // 0 o 2
          if (data[1] !== 0x7e) return;
          // verifica manufacturer Arturia: 00 20 6B
          const companyOk = offset === 2
            ? (data[5] === 0x00 && data[6] === 0x20 && data[7] === 0x6b)
            : data[5] === 0x00;
          if (!companyOk) return;
          const v = data.slice(10 + offset, 14 + offset);
          done = true;
          clearTimeout(timer);
          off();
          resolve(`${v[0]}.${v[1]}.${v[2]}.${v[3]}`);
        });
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            off();
            resolve(null);
          }
        }, timeoutMs);
        try {
          output.send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
        } catch {
          done = true;
          clearTimeout(timer);
          off();
          resolve(null);
        }
      });
    },
  };
})();

if (typeof module !== 'undefined') module.exports = Midi;
