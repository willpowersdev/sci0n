/**
 * The AdLib instrument bank, patch resource 3.
 *
 * Structure established from the data: records are 28 bytes, and a bank
 * is either 1344 bytes (48 records, no header) or 2690 (a two-byte
 * header then 96).  Within a record the two operators sit in parallel
 * twelve-byte blocks, which is visible directly -- instrument 9 of SQ3
 * reads `02 02 01 01 03 00 01 01 00 00 02 00` against
 * `02 01 01 01 03 00 01 01 00 00 02 02` -- separated by a single byte,
 * with two more bytes at the end whose values are always 0..3, the range
 * of the OPL2 waveform select.
 *
 *   byte  0      per-instrument, range 0..7 (feedback is also 3 bits)
 *   bytes 1..12  operator 1
 *   byte  13     per-operator-2 prefix; values look like a packed
 *                AM/VIB/EG/KSR/MULT register
 *   bytes 14..25 operator 2
 *   bytes 26,27  waveform select for each operator
 *
 * WHAT IS NOT ESTABLISHED: the order of the twelve fields inside an
 * operator block.  The observed ranges do not reconcile with a plain
 * one-field-per-byte reading -- four of the OPL2 operator parameters are
 * single bits, yet only two positions are ever 0 or 1 -- so the mapping
 * below is a working assignment that puts each field somewhere its
 * observed range allows, not a decoded format.  Instruments therefore
 * play with approximately the right envelopes and ratios rather than the
 * exact AdLib timbres, and `raw` is kept so a corrected mapping can be
 * dropped in without re-reading the resource.
 */
import type { Operator } from './opl2.ts';

export interface Instrument {
  /** The whole 28-byte record, so a better mapping needs no re-read. */
  raw: Uint8Array;
  feedback: number;
  additive: boolean;
  ops: Array<{
    mult: number; ar: number; dr: number; sl: number; rr: number;
    tl: number; ksl: number; am: boolean; vib: boolean; eg: boolean;
    ksr: boolean; wave: number;
  }>;
}

const RECORD = 28;

/**
 * Fields are placed by how they are distributed across 363 clean
 * instruments pooled from six games, not by a decoded spec.
 *
 * The operators sit 13 bytes apart, and the fields that behave the same
 * way in both of them identify themselves: index 2 peaks hard on the
 * value 1 (multiplier), index 7 peaks on 0 and runs to 63 (total level),
 * 8 and 9 are only ever 0 or 1, and 10 never exceeds 3 (key scale
 * level).  Index 0 has the highest mean of the four 0..15 fields, which
 * is what an attack rate looks like in a bank of real instruments.
 *
 * Indices 1 and 5 are left unassigned: both are wide, and index 1 is the
 * one field that behaves differently between the two operators, so
 * nothing can be concluded about it from distribution alone.
 */
function readOp(r: Uint8Array, at: number, wave: number) {
  const f = (i: number) => r[at + i] ?? 0;
  return {
    ar: f(0) & 15,
    mult: f(2) & 15,
    dr: f(3) & 15,
    sl: f(4) & 15,
    rr: f(6) & 15,
    tl: f(7) & 63,
    am: !!(f(8) & 1),
    vib: !!(f(9) & 1),
    ksl: f(10) & 3,
    eg: !!(f(11) & 1),
    ksr: false,
    wave: wave & 3,
  };
}

export function parseBank(d: Uint8Array): Instrument[] {
  const off = d.length % RECORD === 0 ? 0 : 2;
  const n = Math.floor((d.length - off) / RECORD);
  const out: Instrument[] = [];
  for (let i = 0; i < n; i++) {
    const r = d.subarray(off + i * RECORD, off + (i + 1) * RECORD);
    out.push({
      raw: r,
      feedback: r[0] & 7,
      // The connection bit rides with feedback on the real chip; with
      // the field order unresolved, FM is the safer default -- additive
      // on a patch meant for FM is much more wrong than the reverse.
      additive: false,
      ops: [readOp(r, 1, r[26]), readOp(r, 14, r[27])],
    });
  }
  return out;
}

/**
 * Copy an instrument's operator settings onto a live operator.
 *
 * `sustain` overrides the EG-type bit.  That bit decides whether a note
 * holds while the key is down or decays on its own, and its position in
 * the record is one of the unresolved fields -- read from the wrong
 * place it comes out clear on nearly every instrument, every note dies
 * about forty milliseconds in, and the music is inaudible.  Holding
 * notes for the duration the score writes is the better error of the
 * two: genuinely percussive patches ring longer than they should, which
 * is audible but not silent.
 */
export function applyOp(o: Operator, s: Instrument['ops'][number], sustain = true) {
  o.mult = s.mult; o.ar = s.ar; o.dr = s.dr; o.sl = s.sl; o.rr = s.rr;
  o.tl = s.tl; o.ksl = s.ksl; o.am = s.am; o.vib = s.vib;
  o.eg = sustain ? true : s.eg; o.ksr = s.ksr; o.wave = s.wave;
}
