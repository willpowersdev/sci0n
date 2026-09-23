import { MT32_PRESETS, gmForTimbre, UNMAPPED } from './gm.ts';

/**
 * The MT-32 patch bank a game ships as `patch.001`.
 *
 * A sound resource's program change does not name an instrument; it
 * selects one of the synthesiser's *patches*, and the patch says which
 * timbre to use.  So playing an SCI score on anything other than an
 * MT-32 means reading this bank first: it is the only place the game
 * says what its programs were meant to sound like.
 *
 * The layout is Sierra's, and fixed:
 *
 *   0x6B + 8i     patch i, for i < 48
 *   0x1EB         how many memory timbres follow (64 at most)
 *   0x1EC + 246n  memory timbre n, its first ten bytes the name
 *   ...           0xABCD, and then 48 more patches, if the bank has them
 *
 * Each patch begins `group, number, keyshift, finetune, benderRange`,
 * and the group says how to read the number: a preset timbre from the
 * synthesiser's own two banks of 64, one of the memory timbres above,
 * or a rhythm timbre.
 */

/**
 * Where a patch's timbre comes from.
 *
 * Plain constants rather than an enum: the build strips types without
 * transforming them, and an enum is a value that has to be generated.
 */
export const PRESET_A = 0;   // the synthesiser's preset bank, timbres 0..63
export const PRESET_B = 1;   // bank B, continuing the same numbering at 64
export const MEMORY = 2;     // a timbre this bank defines itself, and names
export const RHYTHM = 3;     // one of the rhythm timbres
export type TimbreGroup = typeof PRESET_A | typeof PRESET_B | typeof MEMORY | typeof RHYTHM;

export interface Patch {
  group: TimbreGroup;
  /** Timbre within the group; for a preset, already offset into 0..127. */
  number: number;
  keyshift: number;
  benderRange: number;
}

export interface PatchBank {
  patches: Patch[];
  /** Names of the timbres this bank defines, in order. */
  timbreNames: string[];
}

/**
 * What each patch is called, which is what a GM mapping needs.
 *
 * A preset patch is named by the synthesiser's own list; a memory one
 * by the bank itself.  A patch pointing past the timbres the bank
 * actually carries has no name, and gets an empty one rather than a
 * borrowed one.
 */
export function timbreNameOf(bank: PatchBank, patch: Patch): string {
  switch (patch.group) {
    case PRESET_A:
    case PRESET_B:
      return MT32_PRESETS[patch.number] ?? '';
    case MEMORY:
      return bank.timbreNames[patch.number] ?? '';
    default:
      // Rhythm timbres are struck, not played; no game here uses one.
      return '';
  }
}

/**
 * The GM program for each of the bank's patches, `UNMAPPED` where none
 * stands in.  This is the table a program change is looked up in.
 */
export function gmPatchMap(bank: PatchBank): Int8Array {
  const out = new Int8Array(bank.patches.length).fill(UNMAPPED);
  bank.patches.forEach((p, i) => { out[i] = gmForTimbre(timbreNameOf(bank, p)); });
  return out;
}

const PATCHES_LOW = 0x6B;        // patches 0..47 begin here
const MEMTIMBRE_COUNT = 0x1EB;   // how many memory timbres follow
const MEMTIMBRES = 0x1EC;        // and where they start
const TIMBRE_SIZE = 0xF6;
const NAME_LENGTH = 10;
const PATCH_SIZE = 8;
const LOW_PATCHES = 48;
/** Marks a bank that carries a second set of 48 patches. */
const EXTENDED = 0xABCD;

const name = (d: Uint8Array, at: number) => {
  let s = '';
  for (let i = 0; i < NAME_LENGTH && at + i < d.length; i++) {
    const c = d[at + i];
    // Sierra pads with spaces; anything unprintable ends the name.
    if (c < 0x20 || c >= 0x7F) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
};

const patchAt = (d: Uint8Array, at: number): Patch => {
  const group = (d[at] ?? 0) as TimbreGroup;
  let number = d[at + 1] ?? 0;
  // Bank B is not a separate space: it continues bank A's numbering.
  if (group === PRESET_B) number += 64;
  return { group, number, keyshift: d[at + 2] ?? 0, benderRange: d[at + 4] ?? 0 };
};

export function parsePatchBank(d: Uint8Array): PatchBank | null {
  if (d.length <= MEMTIMBRES) return null;
  const count = d[MEMTIMBRE_COUNT];
  if (count > 64) return null;
  const timbreNames: string[] = [];
  for (let i = 0; i < count; i++) timbreNames.push(name(d, MEMTIMBRES + i * TIMBRE_SIZE));

  const patches: Patch[] = [];
  for (let i = 0; i < LOW_PATCHES; i++) patches.push(patchAt(d, PATCHES_LOW + i * PATCH_SIZE));

  // The second set of patches sits past the timbres, behind a marker.
  const after = MEMTIMBRES + count * TIMBRE_SIZE;
  if (after + 1 < d.length && ((d[after] << 8) | d[after + 1]) === EXTENDED)
    for (let i = 0; i < LOW_PATCHES; i++)
      patches.push(patchAt(d, after + 2 + i * PATCH_SIZE));

  return { patches, timbreNames };
}
