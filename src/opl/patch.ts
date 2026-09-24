/**
 * The AdLib instrument bank, patch resource 3.
 *
 * Read out of ADL.DRV -- the driver Sierra shipped with these games --
 * rather than inferred.  The loader at 0x1f7f walks an instrument:
 *
 *     add di, 0x1a     ; the two waveform bytes, at +26 and +27
 *     mov al, cs:[di]  ; waveform for operator 0
 *     inc di
 *     mov dl, cs:[di]  ; waveform for operator 1
 *     mov si, cx
 *     add si, 0x0d     ; operator 1's record, thirteen bytes in
 *
 * and the copy at 0x2007 moves thirteen bytes (`cmp di, 0x0d`) into the
 * driver's live operator state, then stores the caller's waveform byte
 * masked to two bits as the fourteenth.  So the record is:
 *
 *     +0  .. +12   operator 0, the modulator
 *     +13 .. +25   operator 1, the carrier
 *     +26, +27     a waveform select for each
 *
 * The six register builders at 0x2090..0x228f then read fixed offsets
 * within an operator:
 *
 *     +0  KSL   -> 0x40 bits 6-7      +7  RR    -> 0x80 low nibble
 *     +1  MULT  -> 0x20 bits 0-3      +8  TL    -> 0x40 bits 0-5
 *     +2  FB    -> 0xC0 bits 1-3      +9  AM    -> 0x20 bit 0x80
 *     +3  AR    -> 0x60 high nibble   +10 VIB   -> 0x20 bit 0x40
 *     +4  SL    -> 0x80 high nibble   +11 KSR   -> 0x20 bit 0x10
 *     +5  EG    -> 0x20 bit 0x20      +12 CONN  -> 0xC0 bit 0, inverted
 *     +6  DR    -> 0x60 low nibble
 *
 * AM, VIB, KSR and EG are tested with `or al,al` rather than masked, so
 * any non-zero value sets the bit.  CONN is inverted: the builder at
 * 0x211e does `cmp ...,0 / jne / inc cl`, so a zero byte sets the
 * connection bit and means additive, and a non-zero byte means FM.
 *
 * There is no header: read from byte zero, feedback is 0..7 and the
 * waveforms 0..3 in every one of the 624 instruments across seven games.
 * Read two bytes later, feedback is valid in as few as 55% of them and a
 * waveform reaches 205.
 *
 * Feedback and connection belong to the channel, not the operator, so
 * the driver takes them from the modulator's record.
 */
import type { Operator } from './opl2.ts';

export interface OperatorPatch {
  ksl: number; mult: number; ar: number; sl: number; eg: boolean;
  dr: number; rr: number; tl: number; am: boolean; vib: boolean;
  ksr: boolean; wave: number;
}

export interface Instrument {
  raw: Uint8Array;
  feedback: number;
  /** Operators summed rather than one modulating the other. */
  additive: boolean;
  /** Modulator first, then carrier. */
  ops: OperatorPatch[];
}

const OP_BYTES = 13;
const RECORD = 28;

function readOp(r: Uint8Array, at: number, wave: number): OperatorPatch {
  const f = (i: number) => r[at + i] ?? 0;
  return {
    ksl: f(0) & 3,          // shifted left six into an 8-bit register
    mult: f(1) & 15,
    ar: f(3) & 15,
    sl: f(4) & 15,
    eg: f(5) !== 0,
    dr: f(6) & 15,
    rr: f(7) & 15,
    tl: f(8) & 63,
    am: f(9) !== 0,
    vib: f(10) !== 0,
    ksr: f(11) !== 0,
    wave: wave & 3,
  };
}

export function parseBank(d: Uint8Array): Instrument[] {
  const out: Instrument[] = [];
  for (let o = 0; o + RECORD <= d.length; o += RECORD) {
    const r = d.subarray(o, o + RECORD);
    out.push({
      raw: r,
      feedback: r[2] & 7,
      additive: r[12] === 0,
      ops: [readOp(r, 0, r[26]), readOp(r, OP_BYTES, r[27])],
    });
  }
  return out;
}

/** Copy an instrument's operator settings onto a live operator. */
export function applyOp(o: Operator, s: OperatorPatch) {
  o.ksl = s.ksl; o.mult = s.mult; o.ar = s.ar; o.sl = s.sl; o.eg = s.eg;
  o.dr = s.dr; o.rr = s.rr; o.tl = s.tl; o.am = s.am; o.vib = s.vib;
  o.ksr = s.ksr; o.wave = s.wave;
}

/**
 * The instrument bank Sierra's earliest AdLib driver carries itself.
 *
 * Before the games shipped `patch.003` the instruments lived in
 * `adl.drv`, and KQ4 is the one here still built that way: it has no
 * patch resource at all, so without this it has no music.
 *
 * The table is found rather than looked up at a fixed address, so it
 * identifies itself -- but it has to be found on the right byte, and
 * that is harder than it looks.  A first attempt tested only the fields
 * whose values happen to be narrow, most of which the parser masks
 * anyway, and settled three bytes early: forty-eight records that all
 * looked plausible and every one of which read its neighbour's fields.
 * The instruments came out wrong and the music with them.
 *
 * So every field is tested at the width the chip gives it -- two bits
 * of key-scale level, four of multiplier and of each envelope rate, six
 * of total level, one apiece for the flags, two for each wave select --
 * across both operators of all forty-eight records.  That is around
 * forty numbers per record, and the count of records that pass tells
 * one alignment from another: only the true one has all forty-eight
 * intact, and it has to be the only offset that does.  The later
 * driver, whose games carry `patch.003`, has no such run and is
 * correctly left alone.
 */
export function bankInDriver(d: Uint8Array): Instrument[] | null {
  const COUNT = 48;
  /** The widths the chip actually gives each field, by byte offset. */
  const WIDTH: Array<[number, number]> = [
    [0, 3], [1, 15], [3, 15], [4, 15], [5, 1],
    [6, 15], [7, 15], [8, 63], [9, 1], [10, 1], [11, 1],
  ];
  const shaped = (o: number) => {
    for (const at of [0, OP_BYTES])
      for (const [i, max] of WIDTH) if (d[o + at + i] > max) return false;
    // Feedback is masked to three bits when read, so it says nothing
    // here; the algorithm bit and the two wave selects do.
    return d[o + 12] <= 1 && d[o + 26] <= 3 && d[o + 27] <= 3;
  };
  let best = -1, bestAt = -1, ties = 0;
  for (let o = 0; o + COUNT * RECORD <= d.length; o++) {
    let n = 0;
    for (let i = 0; i < COUNT; i++) if (shaped(o + i * RECORD)) n++;
    if (n > best) { best = n; bestAt = o; ties = 1; }
    else if (n === best) ties++;
  }
  if (best < COUNT || ties !== 1 || bestAt < 0) return null;
  return parseBank(d.subarray(bestAt, bestAt + COUNT * RECORD));
}
