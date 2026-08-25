# Protocollo SysEx dell'Arturia MicroFreak

Documentazione di riferimento per ManageFreak. Il protocollo è stato ricavato tramite
reverse engineering dai seguenti progetti pubblici (vedi crediti nel README):

- **Elektroid** (`src/connectors/microfreak.c`, GPL-3) — implementazione wire verificata su hardware;
- **freakout** (`docs/microfreak-sysex.md`, MIT) — documentazione completa, inclusa la
  cattura passiva di Arturia MIDI Control Center 1.23 contro firmware 5.0.0.36;
- **microfreak-reader** (François Georgy) — primi studi sul protocollo di lettura.

## Framing

Tutti i messaggi sono SysEx a 7 bit:

```
F0 00 20 6B 07 01 SS LL OP [LL byte di payload] F7
```

| Campo | Significato |
|---|---|
| `00 20 6B` | Manufacturer ID Arturia |
| `07 01` | famiglia di protocollo MicroFreak |
| `SS` | contatore di sequenza `00..7F`; la risposta **ripete lo stesso SS** |
| `LL` | numero di byte del payload |
| `OP` | operazione |

Le risposte hanno lo stesso framing. Alcune risposte speciali (statistiche memoria, op
`48`) usano la famiglia alternativa `F0 00 20 6B 07 7F …` con un contatore gestito dal
dispositivo; ManageFreak non le usa.

## Operazioni bulk (dispatch firmware 5)

| Op | Ruolo |
|---|---|
| `15` | inizio trasferimento / flow control (payload vuoto) |
| `16` | pacchetto dati (non finale) |
| `17` | pacchetto dati finale |
| `18` | ack / richiesta del pacchetto successivo |
| `19` | inizio lettura preset salvato |
| `52` | risposta header / inizio scrittura preset |
| `54–5D` | wavetables e campioni (non usati da ManageFreak) |

## Preset: struttura

- 512 slot, numerati 1..512 in UI/API. `bank = (slot-1) >> 7`, `program = (slot-1) & 0x7F`.
- Header di 35 byte:
  - `[0..1]` bank e program
  - `[3] & 0x08` = slot vuoto (Init)
  - `[8]` program (id nel bank)
  - `[10]` categoria (0 Bass, 1 Brass, 2 Keys, 3 Lead, 4 Organ, 5 Pad, 6 Percussion,
    7 Sequence, 8 SFX, 9 Strings, 10 Template, 11 Vocoder)
  - `[11]` campo `p1` (opaco, preservato)
  - `[12..25]` nome, max 14 byte ASCII 7-bit, terminato da NUL
- Corpo: **146 parti × 32 byte = 4672 byte**. Il corpo è a sua volta impacchettato
  8→7 bit: 8 byte MIDI → 7 byte reali (4672 → 4088 byte).

### Lettura header (scansione)

Per ogni slot: invia `19 [bank, program, 0]` → risposta `52` con payload da 35 byte.

### Lettura corpo

1. `19 [bank, program, 0]` → `52` + header 35 byte.
   Se `header[3] & 0x08`: slot vuoto, stop.
2. `19 [bank, program, 1]` → `15` vuoto.
3. 146 × `18 [00]` → 145 risposte `16` + 1 risposta `17`, ognuna con 32 byte di payload.

### Scrittura

1. `52` + header 35 byte → ack (payload vuoto, tipicamente op `18`).
2. `52 [bank, program, 1]` → ack.
3. `15` (vuoto) → ack.
4. 145 × `16` + 1 × `17`, ognuna con una parte da 32 byte → ack per parte.
5. **Verifica con readback completo** (ManageFreak lo fa sempre, con ripristino
   automatico del contenuto precedente in caso di mismatch).

Nota: gli slot vuoti (Init) non sono scrivibili via upload con questo protocollo.

### Rinomina (solo header)

1. Leggi l'header (`19 … 0`).
2. `52` + header modificato (nome/categoria).
3. `52 [bank, program, 1]`.
4. Facoltativo: rilettura di conferma + Program Change.

### Selezione / audizione

Canale 1: `CC 0 = bank` poi `PC = program`. Non cambia la memoria, solo il patch attivo.

## Timing

Il dispositivo risponde in ~2 ms su USB. Elektroid usa pause di 5 ms tra i messaggi e
30 ms dopo un trasferimento completo. ManageFreak usa pause analoghe (2–5 ms tra le
parti, 30 ms dopo le scritture).

## Formato file Arturia MCC

### `.mfp` / `.mbp` (preset singolo, testo Boost-serialization)

```
22 serialization::archive 10 0 4 <len> <versione> <len> <nome> <cat> 0 0 18 000000000000000000 <init> 0 <p1> <datalen> <b0> <b1> … <bn>\n
```

- `<versione>` per i preset = `174`.
- I byte del corpo sono decimali **con segno** (int8: `0xFF` → `-1`).

### `.mfpz`

ZIP (stored o deflate) con un unico membro `0_preset` = contenuto `.mfp`.

### `.mfprojz`

ZIP con membri `project/bank/NNN-file.mbp`: ogni membro è un preset `.mbp`.

## Formato interno del corpo preset (firmware 5)

Dopo l'unpack 8→7 (4088 byte):

- I gruppi iniziano con `@#` + 3 byte di nome (il primo gruppo può iniziare con il solo
  byte `#` + 3 byte).
- Ogni campo è: `(0x40 + len_nome)` + nome ASCII + `0x63` + byte metadata + valore
  uint16 little-endian.
- Esempi: `VCO.Type` (indice del motore, `round(raw * metadata / 32767)` con metadata =
  numero massimo di motori del firmware che ha salvato il preset), `VCF.Cutoff`,
  `EG2.Attack`, gruppi `Co1..Co7` per la matrice di modulazione (valori bipolari).
- Dopo il prefisso taggato seguono i blocchi fissi Sequence A (offset 1980) e
  Sequence B (offset 3022), 64 step × 16 byte ciascuno (preservati, non interpretati).

I preset firmware ≤ 4 non hanno il formato taggato: ManageFreak usa come fallback la
mappa a offset fissi documentata in microfreak-reader (righe/colonne della matrice da
146×32).
