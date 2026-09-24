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
 * identifies itself: forty-eight consecutive well-formed records is not
 * something a stretch of 8086 happens to be.  Each is judged on the
 * fields that cannot hold arbitrary values -- two wave selects of two
 * bits, an algorithm bit, three bits of feedback -- and the run has to
 * be the only one in the file, or this is not what was found.  The
 * later driver, whose games carry `patch.003`, has no such run and is
 * correctly left alone.
 */
export function bankInDriver(d: Uint8Array): Instrument[] | null {
  const COUNT = 48;
  const shaped = (o: number) =>
    d[o + 26] <= 3 && d[o + 27] <= 3 && d[o + 12] <= 1 && d[o + 2] <= 7;
  const blank = (o: number) => d.subarray(o, o + RECORD).every(b => b === 0);
  const runs: number[] = [];
  for (let o = 0; o + COUNT * RECORD <= d.length; o++) {
    let n = 0, live = 0;
    while (o + (n + 1) * RECORD <= d.length && shaped(o + n * RECORD)) {
      if (!blank(o + n * RECORD)) live++;
      n++;
    }
    // Mostly-empty records are a field of zeros somewhere, not a bank.
    if (n >= COUNT && live >= COUNT * 0.8) { runs.push(o); o += n * RECORD - 1; }
  }
  if (runs.length !== 1) return null;
  return parseBank(d.subarray(runs[0], runs[0] + COUNT * RECORD));
}
