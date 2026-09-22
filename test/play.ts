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
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

const GAMES = ['SQ3', 'LSL2', 'KQ4', 'CAMELOT', 'COLONEL', 'ICE', 'HERO', 'QFG2'];
let playable = 0;
for (const name of GAMES) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const s = new Session(g);
  if (!s.ready) { console.log(`${name.padEnd(9)} no entry point`); continue; }
  s.budget = 60_000;
  const pics = new Set<number>();
  let st = s.tick();
  let firstHalf = 0;
  for (let i = 0; i < 300 && st.running; i++) {
    if (i % 25 === 24) s.key(13);
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
process.exit(playable >= 5 ? 0 : 1);
