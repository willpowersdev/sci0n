/**
 * Playing an SCI score on a General MIDI synthesiser.
 *
 * Three things have to be right and none of them is visible on screen,
 * so each is checked against the games' own data rather than against a
 * fixture that could have been generated from the same mistake.
 *
 * The mapping.  SCI addresses an MT-32, so a program change means
 * nothing until it has been through the game's `patch.001` and then
 * through a table of stand-ins.  Both ends are matched by name, and
 * name matching is where the quiet errors live: folding "Str Sect1"
 * and "Str Sect2" onto one key made every lookup of either answer
 * String Ensemble 2, which sounds almost right and is wrong.
 *
 * What is left out.  Half of these banks are not instruments -- Camelot
 * carries "Swords  MS" and "Horse1  MS" -- and General MIDI has no
 * stand-in for a sword.  Those must come back unmapped, because a horse
 * played as a piano is worse than a horse not played.
 *
 * The stream.  Channel 15 is how the score talks to the game and must
 * not reach the synthesiser; neither must the controllers Sierra used
 * for its own purposes, which a GM synthesiser would act on.
 *
 * And the line between the two, which is the part that was drawn in the
 * wrong place.  "A wrong instrument is worse than a silent one" is
 * right for a horse or a castle gate, and wrong for anything the sound
 * set can really make: Camelot's purse plays sound 21, whose only
 * patch is "Coins   MS", and leaving that unmapped dropped both its
 * channels and opened the purse in silence.  The test below follows
 * that sound all the way from the patch bank to the notes that come
 * out, because every step of it looked reasonable on its own.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { parseSound, detectHeaderSize } from '../src/sound.ts';
import { parsePatchBank, gmPatchMap, timbreNameOf } from '../src/mt32.ts';
import { GM_NAMES, UNMAPPED, gmForTimbre } from '../src/gm.ts';
import { toGeneralMidi, writeMidiFile, CONTROL_CHANNEL } from '../src/gmstream.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};
const gm = (name: string) => {
  const i = gmForTimbre(name);
  return i === UNMAPPED ? '(unmapped)' : GM_NAMES[i];
};

// --- the table itself --------------------------------------------------
console.log('mapping:');
for (const [timbre, want] of [
  ['Str Sect1', 'String Ensemble 1'],
  ['Str Sect2', 'String Ensemble 2'],
  ['AcouPiano1', 'Acoustic Grand Piano'],
  ['CelticHarp', 'Orchestral Harp'],
  ['RecorderMS', 'Recorder'],
  ['Trumpet 1', 'Trumpet'],
  ['Fr Horn 2', 'French Horn'],
  ['Taiko', 'Taiko Drum'],
] as const)
  check(gm(timbre) === want, `${JSON.stringify(timbre)} -> ${want} (got ${gm(timbre)})`);

/**
 * Numbered GM names must stay distinct.
 *
 * This is the collision that produced String Ensemble 2, stated as the
 * property rather than as the one example that caught it.
 */
const keys = new Set(GM_NAMES.map(n => n.toLowerCase().replace(/[^a-z0-9]/g, '')));
check(keys.size === GM_NAMES.length,
  `all ${GM_NAMES.length} GM names fold to distinct keys (${keys.size} distinct)`);

/**
 * What must not be mapped.
 *
 * The line is whether the sound set has something of the same kind, not
 * whether the name looks like an instrument.  A horse, a castle gate,
 * an airlock and a rocket lifting off have no stand-in among a hundred
 * and twenty-eight instruments, and giving them one would be worse than
 * the silence.  Swords used to be on this list and is not any more: it
 * is a struck metal bar, which the sound set does have.
 */
for (const effect of ['Horse1  MS', 'CstlGateMS', 'AirLock2MS', 'TakeOff MS'])
  check(gmForTimbre(effect) === UNMAPPED,
    `${JSON.stringify(effect)} is left unmapped rather than given an instrument`);

// --- the banks the games ship ------------------------------------------
console.log('\nbanks:');
let totalPatches = 0, totalMapped = 0, banks = 0;
for (const name of readdirSync(ROOT).filter(d => !d.startsWith('.')).sort()) {
  let g: Game;
  try { g = new Game(nodeSource(join(ROOT, name))); } catch { continue; }
  let d: Uint8Array;
  try { d = g.data(9, 1); } catch { continue; }
  const bank = parsePatchBank(d);
  if (!bank) continue;
  banks++;
  const map = gmPatchMap(bank);
  const named = bank.patches.filter(p => timbreNameOf(bank, p)).length;
  const mapped = [...map].filter(v => v !== UNMAPPED).length;
  totalPatches += bank.patches.length; totalMapped += mapped;
  // Every patch must have been *considered*: a bank that parsed but
  // whose patches all name nothing would otherwise pass quietly.
  check(named > bank.patches.length / 2,
    `${name.padEnd(9)} ${named}/${bank.patches.length} patches name a timbre, ${mapped} map to GM`);
}
check(banks >= 6, `${banks} games' MT-32 banks parsed`);
check(totalMapped > totalPatches / 2,
  `${totalMapped}/${totalPatches} patches across all banks map to an instrument`);

// --- the stream ---------------------------------------------------------
console.log('\nstream:');
const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const bank = parsePatchBank(g.data(9, 1))!;
const map = gmPatchMap(bank);
const hdr = detectHeaderSize([...g.byType('sound')].slice(0, 40).map(r => g.data(4, r.number)));

let anyEvents = 0, sounds = 0, leaked = 0, sciCtrl = 0, badProgram = 0;
for (const r of [...g.byType('sound')].sort((a, b) => a.number - b.number)) {
  const snd = parseSound(g.data(4, r.number), hdr);
  if (!snd) continue;
  sounds++;
  const ev = toGeneralMidi(snd, map);
  anyEvents += ev.length;
  for (const e of ev) {
    if ((e.status & 0x0F) === CONTROL_CHANNEL) leaked++;
    if ((e.status & 0xF0) === 0xB0 && [0x4B, 0x4C, 0x50, 0x52, 0x60].includes(e.a)) sciCtrl++;
    if ((e.status & 0xF0) === 0xC0 && (e.a < 0 || e.a > 127)) badProgram++;
  }
}
check(sounds > 20 && anyEvents > 1000,
  `${sounds} of Camelot's scores converted, ${anyEvents} GM events`);
check(leaked === 0, `nothing on the game's own channel ${CONTROL_CHANNEL} reaches the synthesiser (${leaked})`);
check(sciCtrl === 0, `Sierra's private controllers are stripped (${sciCtrl} left in)`);
check(badProgram === 0, `every program change is a real GM program (${badProgram} were not)`);

// --- the file -----------------------------------------------------------
console.log('\nfile:');
const title = parseSound(g.data(4, 1), hdr)!;
const events = toGeneralMidi(title, map);
const mid = writeMidiFile(events);

/** Walk the file back, which is the only way to know it is one. */
const be = (at: number, n: number) => {
  let v = 0; for (let i = 0; i < n; i++) v = (v << 8) | mid[at + i]; return v;
};
const header = String.fromCharCode(...mid.subarray(0, 4));
const division = be(12, 2);
const trackLen = be(18, 4);
check(header === 'MThd' && String.fromCharCode(...mid.subarray(14, 18)) === 'MTrk',
  'the file has the chunks a MIDI file has');
check(14 + 8 + trackLen === mid.length,
  `the track length agrees with the file size (${14 + 8 + trackLen} vs ${mid.length})`);

let p = 22, running = -1, tick = 0, notes = 0, ended = false;
const vlqAt = () => { let v = 0; for (;;) { const b = mid[p++]; v = (v << 7) | (b & 0x7F); if (!(b & 0x80)) return v; } };
while (p < mid.length) {
  tick += vlqAt();
  if (mid[p] === 0xFF) {
    p++; const type = mid[p++]; const len = vlqAt();
    if (type === 0x2F) { ended = true; break; }
    p += len; continue;
  }
  if (mid[p] & 0x80) running = mid[p++];
  const kind = running & 0xF0;
  if (kind === 0x90) notes++;
  p += (kind === 0xC0 || kind === 0xD0) ? 1 : 2;
}
check(ended, 'the track walks cleanly to its end-of-track marker');
check(division === 60, `the division is 60 ticks to the quarter (${division})`);
// SCI counts in sixtieths and so must the file, or the music plays at
// the wrong speed -- which nothing else here would notice.
check(tick === title.ticks,
  `the file ends where the score does, ${tick} ticks vs ${title.ticks}`);
check(notes > 500, `${notes} note-ons survived the round trip`);

// --- a sound effect that GM can really make -----------------------------
console.log('\neffects:');
{
  /** Camelot's purse: `purseSound` plays this when a coin is picked. */
  const CLINK = 21;
  const snd = parseSound(g.data(4, CLINK), hdr)!;
  const patches = [...new Set(snd.events
    .filter(e => (e.status & 0xF0) === 0xC0 && (e.status & 0x0F) !== CONTROL_CHANNEL)
    .map(e => e.a))];
  const names = patches.map(p => timbreNameOf(bank, bank.patches[p]));
  check(names.some(n => /coin/i.test(n)),
    `sound ${CLINK} is the coins (patches ${patches.join(',')} = ${names.map(n => JSON.stringify(n)).join(' ')})`);
  for (const p of patches)
    check(map[p] !== UNMAPPED,
      `patch ${p} ${JSON.stringify(timbreNameOf(bank, bank.patches[p]))} has an instrument` +
      ` (${map[p] === UNMAPPED ? 'none' : GM_NAMES[map[p]]})`);
  /**
   * And it must actually sound.  A mapping that exists is not the same
   * as notes coming out: the channels are dropped wholesale when their
   * patch has no instrument, so this asks the stream, not the table.
   */
  const ev = toGeneralMidi(snd, map);
  const notes = ev.filter(e => (e.status & 0xF0) === 0x90 && e.b > 0).length;
  check(notes > 0, `the purse clink is audible (${notes} notes survive the translation)`);
}

/**
 * The struck effects the games use as effects.
 *
 * Each is checked by the instrument it lands on rather than merely by
 * being mapped, since "mapped" is satisfied by mapping it to anything.
 * The choices come from the bank's own AdLib definitions -- a fast
 * attack on a high inharmonic multiplier is a struck bar, a slow rise
 * on both operators is a swell -- and not from the names, which can
 * describe a sound the patch does not make.
 */
for (const [timbre, wanted] of [
  ['Swords  MS', 'Tubular Bells'],
  ['Armor   MS', 'Steel Drums'],
  ['Thunder MS', 'Reverse Cymbal'],
  ['ClangBell', 'Tubular Bells'],
] as const) {
  const got = gmForTimbre(timbre);
  check(got !== UNMAPPED && GM_NAMES[got] === wanted,
    `${JSON.stringify(timbre)} -> ${wanted} (got ${got === UNMAPPED ? 'nothing' : GM_NAMES[got]})`);
}

/**
 * And a sound that uses one has to come out of the translation with
 * notes in it.  A mapping in the table is not a sound on the wire: the
 * channel carrying an unmapped patch is dropped whole, so this asks a
 * real resource -- Camelot's sound 33, which is armour and nothing
 * else for most of its length.
 */
{
  const ARMOUR = 33;
  const snd = parseSound(g.data(4, ARMOUR), hdr)!;
  const notes = toGeneralMidi(snd, map).filter(e => (e.status & 0xF0) === 0x90 && e.b > 0).length;
  check(notes > 0, `sound ${ARMOUR} is audible (${notes} notes survive)`);
}

console.log(`\n${checked - failed}/${checked} General MIDI checks passed`);
process.exit(failed ? 1 : 0);
