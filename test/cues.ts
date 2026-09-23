/**
 * The music tells the scene where it is.
 *
 * An SCI piece marks points in itself and a script polls for them: the
 * marks are program changes on MIDI channel 15, whose "instrument" is
 * the number the script reads back as `signal`.  Camelot's title
 * sequence is built on them -- `credits::doit` watches
 * `titleMusic.prevSignal` for 20, and moves on to the options menu when
 * it reads -1, the piece having ended.
 *
 * While these were being dropped the sequence still ran, on the
 * stopwatch fallbacks each state carries, so nothing looked broken.
 * That is why this checks the cues arrive *and* that the one which
 * matters is what ends the sequence: a timer that happens to fire at
 * about the right moment would satisfy the first on its own.
 *
 * The machine class is checked here too, because it decides the same
 * sequence's shape.  `SpeedTst` counts its own cycles for a second and
 * files the machine under 0, 1 or 2 at the boundaries 30 and 60 -- an
 * 8088 XT, a 286 AT, a 386.  Reported as an XT, Camelot turns off every
 * picture transition and skips one of its credit screens.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { parseSound } from '../src/sound.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/** Camelot's title music, and the cue its credits script waits for. */
const TITLE_MUSIC = 1, WANTED_CUE = 20, LOOP_MARKER = 127;
/** The machine the interpreter claims to be. */
const MACHINE_286 = 1;

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));

// --- what is in the resource -------------------------------------------
const snd = parseSound(g.data(4, TITLE_MUSIC))!;
const cues = snd.cues;
console.log(`sound ${TITLE_MUSIC}: ${(snd.ticks / 60).toFixed(1)}s, cues ` +
  cues.map(c => `${c.signal}@${(c.tick / 60).toFixed(1)}s`).join(' '));
check(cues.some(c => c.signal === WANTED_CUE),
  `the piece carries the cue the credits script waits for (${WANTED_CUE})`);
check(!cues.some(c => c.signal === LOOP_MARKER),
  `the loop marker (${LOOP_MARKER}) is kept back, not passed off as a cue`);
check(snd.loopTick !== null, 'the loop point was read out of the piece');

// --- what reaches the game ---------------------------------------------
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
/** The live object, as much of it as this test needs to ask about. */
interface Live { def?: { name?: string } }
interface Machine {
  globals: Int32Array;
  objects?: Map<number, Live>;
  prop(o: Live, n: string): number;
}
const vm = s.vm as unknown as Machine;
const find = (name: string): Live | undefined =>
  [...(vm.objects?.values() ?? [])].find(o => o?.def?.name === name);

let st = s.tick();
const cueSeen = new Set<number>();
let endedAt = -1, stateAt21 = -1;
for (let i = 0; i < 4600 && st.running; i++) {
  clock += 1000 / 60;
  st = s.tick();
  const tm = find('titleMusic'), cr = find('credits');
  if (tm) {
    for (const p of ['signal', 'prevSignal'] as const) {
      const v = vm.prop(tm, p);
      if (v > 0) cueSeen.add(v);
      if (v === -1 && endedAt < 0) endedAt = clock / 1000;
    }
  }
  if (cr && stateAt21 < 0 && vm.prop(cr, 'state') === 21) stateAt21 = clock / 1000;
}

console.log(`cues that reached the script: ${[...cueSeen].sort((a, b) => a - b).join(', ') || 'none'}`);
check(cueSeen.has(WANTED_CUE),
  `cue ${WANTED_CUE} reached the game's sound object`);
check(endedAt > 0, `the end of the piece reached the game as signal -1 (at ${endedAt.toFixed(1)}s)`);

/**
 * The cue has to be what moves the scene on, not a coincidence.
 *
 * State 20 carries a timer of its own, so the test is whether the
 * change lands with the end of the music rather than anywhere else.
 */
const musicEnds = snd.ticks / 60;
const gap = Math.abs(stateAt21 - musicEnds);
check(stateAt21 > 0 && gap < 2,
  `the credits move on when the music ends, not on a timer ` +
  `(state 21 at ${stateAt21.toFixed(1)}s, music ends at ${musicEnds.toFixed(1)}s)`);

// --- the machine the games think they are on ---------------------------
const cls = vm.globals[103];
check(cls === MACHINE_286,
  `Camelot's own speed test files us as a 286 AT (class ${cls}, wanted ${MACHINE_286})`);

console.log(`\n${checked - failed}/${checked} music-cue checks passed`);
process.exit(failed ? 1 : 0);
