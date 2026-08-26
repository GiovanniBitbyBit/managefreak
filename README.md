# ManageFreak

**Open-source preset manager for the Arturia MicroFreak** — cross-platform (Windows, macOS, Linux).

ManageFreak is a lightweight, fast alternative to Arturia MIDI Control Center for organizing
MicroFreak presets: backup of the 512 slots, a local library with **Arturia categories and
characteristics**, safe writes **with verification and automatic rollback**, and import/export
of Arturia MCC files (`.mfp`, `.mbp`, `.mfpz`, `.mfprojz`, `.syx`).

> ⚠️ **Unofficial project.** ManageFreak is not affiliated with, endorsed by, or sponsored by
> Arturia. *MicroFreak* is a trademark of Arturia.

---

## Features

### Device
- **Scan of all 512 presets** (names, Arturia category, used/empty state) in seconds.
- **Full read** of the occupied presets with progress bar and cancellation.
- **Safe write**: before writing, the slot is read as a backup; the readback is verified
  byte-by-byte and, on any error, **the original content is restored automatically**.
- **Rename** a preset on the device (header only — the sound is untouched).
- **Audition/select** a preset on the synth (Bank Select + Program Change).
- **Drag & drop**: drop a library preset onto a device slot to write it.
- **Reorder presets on the device**: swap (drop on the middle of a slot) or shift
  (drop on the edges), with backup + verification + rollback.
- **Initialize** slots back to the firmware's *Init* preset.
- **Download the whole bank** as a single `.mfprojz` file compatible with Arturia MCC.

### Library
- **Libraries (collections)**: choose or create a destination library when importing, so
  presets don't pile up together. Move presets between libraries from the detail pane.
- **Arturia categories** (Bass, Brass, Keys, Lead, Organ, Pad, Percussion, Sequence, SFX,
  Strings, Template, Vocoder) with correct counts, plus a **★ Favorites** entry.
- **Arturia characteristics** (Acid, Aggressive, Ambient, … 18 total): filter by them and
  toggle them per preset from the detail pane.
- **Search by name**, **sort** (manual / name / rating / category), **star rating**.
- **Grid or list view** (toggle ☰ / ▦ in the library header).
- **Multi-selection** with Ctrl/Shift and batch actions (move, favorites, export, delete)
  from the detail pane.
- **Import** single presets (`.mfp`, `.mbp`, `.mfpz`), MCC projects (`.mfprojz`, many presets
  at once), sysex (`.syx`) and ManageFreak JSON backups (restores libraries too).
- **Export** single presets (`.mfp` / `.mfpz`) and JSON backups.
- **Parameter view** of the preset (oscillator type, cutoff, resonance, envelopes, LFO, arp,
  modulation matrix…), decoded from the firmware-5 tagged format.

### Tabs (MCC-style)
- **Wavetables**: 16 user wavetable slots on the device, split view (PC library ↔ MicroFreak).
  Import `.wav` (mono PCM16, 32 kHz, exactly 8192 samples), `.mfw`, `.mfwz`; download
  `.mfw`/`.mfwz`; clear slots; drag & drop both ways; **visual preview** of the selected
  wavetable (perspective ribbon of the 32 cycles, with a cycle slider), like Arturia MCC.
- **Samples**: 128 sample slots (firmware 5+) with a **memory time counter**
  (total ~3.5 min); split view (PC library ↔ MicroFreak). Import `.wav` (mono, resampled to
  32 kHz, max 24 s) and `.mfsample` backups; download; clear; drag & drop both ways;
  waveform preview in the details pane.
- **Device**: 31 global settings (MIDI channels, clock, CV, knob behavior, tuning,
  keyboard, microphone…) with the **audited allowed values** from Arturia's device
  description; changes are written with readback verification and automatic rollback.
- A **details pane** at the bottom shows name/source/size for the clicked preset,
  wavetable or sample, with inline **rename** (on the device or in the PC library).

---

## Requirements

To **use** the prebuilt binaries: none — just plug the MicroFreak in over USB.

To **build from source**:
- [Node.js](https://nodejs.org) 18+ (20/22 recommended)
- npm

> Writes are verified on **MicroFreak firmware 5.x** (the same protocol verified on hardware
> by Elektroid and freakout). Reading uses the same documented operation family that also
> works on earlier firmware; read presets are saved losslessly either way.
>
> Hardware-verified on a real MicroFreak: preset read/write/rename/reorder, wavetable and
> sample read/write, **sample and wavetable rename and reorder (swap/shift)** — sample
> reordering rewrites only the directory entries, so it is fast even for large samples,
> and device settings read/write.

---

## Development

```bash
cd app
npm install        # installs Electron
npm start          # runs the app
npm test           # runs the automated tests (protocol, file formats, parameters)
```

## Building installers

```bash
cd app
npm run dist:win     # Windows: NSIS installer + portable build
npm run dist:mac     # macOS: DMG + zip
npm run dist:linux   # Linux: AppImage + deb
```

Packages are generated in `app/dist/`. On Linux machines you need the ALSA libraries
(for audio/MIDI): `sudo apt install libasound2`.

---

## Quick start

1. **Connect** the MicroFreak over USB and turn it on.
2. Open ManageFreak: the MicroFreak MIDI ports are detected automatically (top bar).
   Press **Connect**.
3. The 512 slots are scanned automatically; use **⬅ Fetch library to PC** for a full
   backup of the occupied presets (a few minutes: 146 messages per preset).
4. Organize in the **Library**: drag presets to reorder, drop device slots onto the grid
   to import them at a chosen position, assign categories/characteristics, search, rate,
   mark favorites.
5. To send a preset to the synth: drag it onto a slot in the MicroFreak panel (or use
   **➡ Send** on the card). The previous slot content is backed up and restored if
   anything goes wrong.
6. **Export** presets as `.mfp`/`.mfpz` to share them or reuse them in Arturia MCC.

### Migrating an existing library from Arturia MCC

1. In MCC: select your presets and use *Export* (`.mfpz` or `.mfprojz`).
2. In ManageFreak: **Import library or presets** and pick the exported files.
3. From then on, manage everything from ManageFreak.

---

## Where the data lives

The library is a `library.json` file in the app's data folder
(`%APPDATA%/managefreak` on Windows, `~/Library/Application Support/managefreak` on macOS,
`~/.config/managefreak` on Linux). Use **Backup library (JSON)** to move it to another PC.

---

## Known limitations

- **Init (empty) slots** are read and shown, but cannot be recreated via upload with the
  current protocol (same limitation documented by
  [freakout](https://github.com/kmorrill/freakout) and
  [Elektroid](https://github.com/dagargo/elektroid)). To empty a slot, use the MicroFreak
  itself or MCC. ManageFreak's *Delete* action rewrites the firmware Init template instead.
- **Sequences (Seq A/B)** are transferred *integrally* inside the preset body (lossless
  backup), but are not yet editable from the UI.
- The protocol was obtained by **reverse engineering**: always test on disposable slots
  before important operations, and keep a library backup.

---

## Technical background & credits

The SysEx protocol used by ManageFreak is documented in
[`app/docs/PROTOCOLLO.md`](app/docs/PROTOCOLLO.md) (Italian) and derives from the public
work of:

- [Elektroid](https://github.com/dagargo/elektroid) (MicroFreak connector, GPL) —
  hardware-verified read/write sequences;
- [freakout](https://github.com/kmorrill/freakout) (MIT) — complete protocol documentation,
  `.mfp`/`.mfpz`/`.mfprojz` format, firmware-5 tagged parameter format;
- [microfreak-reader](https://github.com/francoisgeorgy/microfreak-reader) by François Georgy —
  early studies on the read protocol and the CC parameter map.

---

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
