/**
 * Does playing a game produce music?
 *
 * The sound tests up to now prove the resources parse and that the
 * OPL2 renders them.  Neither says anything about the path a player
 * actually hears, which runs the other way round: the game decides what
 * to play and asks the driver for it through `DoSound`.  Before this was
 * wired that kernel call returned 0 and every game was silent while
 * passing every test.
 *
 * So this boots each game the way the browser does, watches the driver,
 * and insists on audio that is actually audible.
 *
 * The bar is "every game that asks for a piece is heard playing it",
 * not a fixed list of games: one stuck in its intro asks for nothing,
 * and calling that a sound failure would only make the test lie about
 * where the problem is.  A floor of known-good games is checked too, so
 * a regression that stops a game asking at all still fails.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

/** Games that reach music today; if one stops asking, something broke. */
const MUST_PLAY = new Set(['SQ3', 'CAMELOT', 'COLONEL']);

let heard = 0, asking = 0, failed = 0;
for (const name of ['SQ3', 'CAMELOT', 'LSL2', 'COLONEL', 'QFG2']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const s = new Session(g, new Index(g));
  let clock = 0;
  s.now = () => clock;

  // Count what the game asks of the driver, without changing what it does.
  const box = s.vm.sounds;
  let plays = 0;
  const realPlay = box.play.bind(box);
  const asked: number[] = [];
  (box as any).play = (h: number, n: number, loop: boolean) => {
    plays++; asked.push(n); return realPlay(h, n, loop);
  };

  let st = s.tick();
  const buf = new Float32Array(2048);
  let peak = 0, mixed = 0;
  for (let i = 0; i < 2400 && st.running; i++) {
    clock += 1000 / 60;
    st = s.tick();
    // Pull audio at roughly the rate a sound card would.
    if (box.active) {
      box.mix(buf);
      mixed += buf.length;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
    }
  }
  const secs = (mixed / box.rate).toFixed(1);
  let verdict: string;
  if (plays > 0) {
    asking++;
    // Asked for and heard, or asked for and silent -- the latter is the
    // failure this whole test exists to catch.
    if (peak > 0.02) { heard++; verdict = 'audible'; }
    else { failed++; verdict = 'ASKED FOR MUSIC AND PLAYED NOTHING'; }
  } else if (MUST_PLAY.has(name)) {
    failed++; verdict = 'NEVER ASKED FOR MUSIC';
  } else {
    verdict = 'asks for none (stuck before any music)';
  }
  console.log(`${name.padEnd(9)} ${box.available ? 'bank' : 'NO BANK'} · ` +
    `${String(plays).padStart(2)} plays (sounds ${[...new Set(asked)].slice(0, 6).join(',') || '-'}) · ` +
    `${secs.padStart(5)}s mixed · peak ${peak.toFixed(3)} · ${verdict}`);
}
console.log(`\n${heard}/${asking} games that asked for music were heard playing it`);
process.exit(failed ? 1 : 0);
