// ManageFreak — pianificazione dello spostamento (shift) dei preset sul dispositivo
'use strict';

const Shift = (() => {
  /**
   * Calcola la nuova sequenza di slot occupati e le scritture necessarie
   * per spostare un blocco di preset "tra" gli altri, con scorrimento.
   *
   * @param {number[]} occupied lista ordinata degli slot occupati (1..512)
   * @param {number[]} moved slot da spostare (sottoinsieme di occupied)
   * @param {number} targetSlot slot di riferimento (occupato o vuoto)
   * @param {boolean} after inserire il blocco dopo il target (true) o prima (false)
   * @returns {{newSeq: number[], writes: {from:number,to:number}[]}}
   */
  function planShift(occupied, moved, targetSlot, after) {
    const movedSorted = Array.from(new Set(moved)).sort((a, b) => a - b);
    const validMoved = movedSorted.filter((s) => occupied.includes(s));
    if (!validMoved.length || validMoved.includes(targetSlot)) {
      return { newSeq: occupied.slice(), writes: [] };
    }
    const movedSet = new Set(validMoved);
    const remainder = occupied.filter((s) => !movedSet.has(s));

    // posizione di inserimento rispetto al target
    let idx;
    if (occupied.includes(targetSlot)) {
      idx = remainder.indexOf(targetSlot);
      if (idx < 0) idx = remainder.length;
    } else {
      // target vuoto: inserisci prima del primo preset che lo segue
      idx = remainder.findIndex((s) => s > targetSlot);
      if (idx < 0) idx = remainder.length;
    }
    if (after) idx += 1;

    const newSeq = [...remainder.slice(0, idx), ...validMoved, ...remainder.slice(idx)];

    // Scritture necessarie: il preset che ora si trova nello slot newSeq[k]
    // deve finire nello slot occupied[k] (posizione k della nuova sequenza).
    const writes = [];
    for (let k = 0; k < occupied.length; k++) {
      if (occupied[k] !== newSeq[k]) {
        writes.push({ from: newSeq[k], to: occupied[k] });
      }
    }
    return { newSeq, writes };
  }

  return { planShift };
})();

if (typeof module !== 'undefined') module.exports = Shift;
if (typeof globalThis !== 'undefined') globalThis.Shift = Shift;
