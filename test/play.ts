/**
 * Does the interpreter actually run a game?
 *
 * Booting and not crashing is not the same as playing, so the assertion
 * is that the machine reaches a picture and keeps running: a session is
 * driven for several hundred frames and has to draw a background, keep
 * its frame stack alive across slices, and still be going at the end.
 *
 * Resumption is the part most likely to break silently -- a slice that
 * unwound its frames would restart the game every frame and still look
 * busy -- so the instruction count is required to keep climbing.
 *
 * No keys are pressed.  Enter answers whatever dialog is open, and both
 * LSL2 and Colonel's Bequest quit when their copy-protection question is
 * answered wrongly -- which is the game working, not failing, but is
 * indistinguishable here from a crash.
 *
 * Time is driven rather than measured.  Frames run back to back here, so
 * no wall-clock time passes between them, and a game paces itself by the
 * clock: left on real time it would sit waiting for ever and the suite
 * would report it running while it did nothing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/**
 * The shipped copy is preferred over the full collection.
 *
 * `games/` holds what a deployed page serves: the same eight games, but
 * under ScummVM's names and cut down to RESOURCE.MAP and its volumes.
 * Testing the untrimmed originals would leave the trim itself untested,
 * and it is the trim that can go wrong -- a volume left behind reads as
 * a game that boots and then cannot find a room.  Where there is no such
 * folder the originals stand in, so a checkout without one still runs.
 */
const TRIMMED = join(import.meta.dirname, '..', 'games');
const shipped = existsSync(join(TRIMMED, 'games.json'));
const root = shipped ? TRIMMED : ROOT;
const GAMES: string[] = shipped
  ? Object.keys(JSON.parse(readFileSync(join(TRIMMED, 'games.json'), 'utf8')))
  : ['SQ3', 'LSL2', 'KQ4', 'CAMELOT', 'COLONEL', 'ICE', 'HERO', 'QFG2'];
console.log(`reading ${shipped ? 'the shipped games/' : ROOT}\n`);
let playable = 0;
for (const name of GAMES) {
  const g = new Game(nodeSource(join(root, name)));
  const s = new Session(g);
  if (!s.ready) { console.log(`${name.padEnd(9)} no entry point`); continue; }
  s.budget = 60_000;
  let clock = 0;
  s.now = () => clock;           // a sixtieth of a second per frame
  const pics = new Set<number>();
  let st = s.tick();
  let firstHalf = 0;
  for (let i = 0; i < 300 && st.running; i++) {
    clock += 1000 / 60;
    st = s.tick();
    if (st.picture >= 0) pics.add(st.picture);
    if (i === 149) firstHalf = st.instructions;
  }
  const painted = [...s.screen.visual].filter(v => v !== 0xFF).length;
  const drew = pics.size > 0;
  const keptGoing = st.instructions > firstHalf && firstHalf > 0;
  const ok = drew && st.running && keptGoing;
  if (ok) playable++;
  console.log(`${name.padEnd(9)} ${String(st.frames).padStart(4)} frames · ` +
    `${(st.instructions / 1e6).toFixed(0)}M instr · pictures ${[...pics].join(',') || 'none'} · ` +
    `${(100 * painted / (320 * 190)).toFixed(0)}% painted · ` +
    (ok ? 'running' : `stopped: ${st.stopped ?? (drew ? '' : 'drew nothing')}`));
}
console.log(`\n${playable}/${GAMES.length} games run continuously and draw`);
/**
 * All of them, now that all of them do.
 *
 * The bar was five, which is what it had to be while three of these
 * stopped on their first frame: Hero's Quest and Iceman on an invalid
 * property in `Act::canBeHere`, King's Quest 4 on an invalid local in
 * `copyProtect`.  Both are faults in Sierra's own compiled scripts
 * that the original interpreter never checked for, and leaving the bar
 * low would let any of them fall over again without a word.
 */
process.exit(playable === GAMES.length ? 0 : 1);
