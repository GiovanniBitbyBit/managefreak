// ManageFreak — backend MIDI nativo per il processo principale.
//
// Usa RtMidi (@julusian/midi): WinMM su Windows, CoreMIDI su macOS, ALSA su Linux.
// Motivo: lo strato Web MIDI di Chromium (WinRT su Windows) a volte smette di
// enumerare i dispositivi — l'app restava con "zero porte" mentre il MIDI di
// sistema continuava a funzionare (verificato: WinMM apriva il MicroFreak).
// Qui si usa direttamente la stessa API che usano i DAW e MIDI Control Center.
'use strict';

let midi = null;
let loadError = null;
try {
  // Se il binario nativo non è disponibile (piattaforma insolita) l'app ripiega
  // su Web MIDI: vedi renderer/js/midi.js.
  midi = require('@julusian/midi');
} catch (e) {
  loadError = e;
}

let win = null;
let input = null;
let output = null;
let inputIndex = -1;
let outputIndex = -1;

function setWindow(w) {
  win = w;
}

function status() {
  return {
    ok: !!midi,
    backend: 'native',
    error: loadError ? String((loadError && loadError.message) || loadError) : null,
  };
}

function ensurePorts() {
  if (!midi) throw new Error('Native MIDI is not available on this system');
  if (!input) {
    input = new midi.Input();
    // SysEx sì (serve al protocollo MicroFreak), clock e active sensing no:
    // sarebbero traffico inutile verso la finestra.
    input.ignoreTypes(false, true, true);
    input.on('message', onMessage);
  }
  if (!output) output = new midi.Output();
}

function onMessage(_deltaTime, message) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('midi:message', Array.from(message));
  } catch {
    /* finestra chiusa nel frattempo */
  }
}

function notifyClosed(error) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('midi:state', { open: false, error: error || null });
  } catch {
    /* finestra chiusa */
  }
}

const idxFromId = (id, kind) => {
  const m = new RegExp(`^native-${kind}-(\\d+)$`).exec(String(id || ''));
  return m ? parseInt(m[1], 10) : -1;
};

// Porte da NON aprire mai: il sintetizzatore GS di Windows passa da wdmaud.drv,
// che con i SysEx lunghi del MicroFreak va in violazione di accesso e porta giù
// l'app, lasciando poi il MIDI di sistema incastrato (causa dei crash osservati).
const UNSAFE_PORT = /wavetable synth|midi mapper/i;

/** Elenco porte con id stabili ("native-in-2" / "native-out-3"). */
function list() {
  if (!midi) return { ...status(), inputs: [], outputs: [] };
  try {
    ensurePorts();
    const inputs = [];
    const outputs = [];
    for (let i = 0; i < input.getPortCount(); i++) {
      inputs.push({ id: `native-in-${i}`, name: input.getPortName(i), manufacturer: '' });
    }
    for (let i = 0; i < output.getPortCount(); i++) {
      outputs.push({ id: `native-out-${i}`, name: output.getPortName(i), manufacturer: '' });
    }
    return { ok: true, backend: 'native', error: null, inputs, outputs };
  } catch (e) {
    return { ok: false, backend: 'native', error: String((e && e.message) || e), inputs: [], outputs: [] };
  }
}

function close() {
  if (!midi) return { ok: true };
  try {
    if (input && inputIndex >= 0) input.closePort();
  } catch {
    /* già chiusa */
  }
  try {
    if (output && outputIndex >= 0) output.closePort();
  } catch {
    /* già chiusa */
  }
  inputIndex = -1;
  outputIndex = -1;
  return { ok: true };
}

function open(inputId, outputId) {
  if (!midi) return { ok: false, error: 'Native MIDI is not available on this system' };
  try {
    ensurePorts();
    const ii = idxFromId(inputId, 'in');
    const oi = idxFromId(outputId, 'out');
    if (ii < 0 || oi < 0) return { ok: false, error: 'MIDI port not found' };
    if (ii >= input.getPortCount() || oi >= output.getPortCount()) {
      return { ok: false, error: 'MIDI port not found' };
    }
    const inName = input.getPortName(ii);
    const outName = output.getPortName(oi);
    if (UNSAFE_PORT.test(inName) || UNSAFE_PORT.test(outName)) {
      return {
        ok: false,
        error: `Refusing to open "${UNSAFE_PORT.test(outName) ? outName : inName}": ` +
          'the Windows GS Wavetable Synth / MIDI Mapper crashes on MicroFreak SysEx. Pick the MicroFreak port.',
      };
    }
    close();
    input.openPort(ii);
    output.openPort(oi);
    inputIndex = ii;
    outputIndex = oi;
    return {
      ok: true,
      backend: 'native',
      input: input.getPortName(ii),
      output: output.getPortName(oi),
    };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function send(bytes) {
  if (!midi || !output || outputIndex < 0) {
    return { ok: false, error: 'No open MIDI output port' };
  }
  try {
    const arr = Array.isArray(bytes) ? bytes : Array.from(bytes || []);
    output.sendMessage(arr);
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // una porta sparita (USB staccato) deve farsi sentire nella UI, come faceva
    // l'evento statechange di Web MIDI
    close();
    notifyClosed(msg);
    return { ok: false, error: msg };
  }
}

/** Rilascio completo prima di uscire: chiude le porte a livello di sistema. */
function shutdown() {
  const res = close();
  input = null;
  output = null;
  return res;
}

module.exports = { setWindow, status, list, open, close, send, shutdown };
