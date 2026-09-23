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

let heard = 0, asking = 0, failed = 0, checked = false;
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
/**
 * Does the music survive the title screen?
 *
 * The check above is satisfied by any audible piece, and the title
 * music is the first thing every game plays -- so a game that falls
 * silent for everything after it still passed.  Camelot did exactly
 * that: `Intro::init` calls `DoSound(4, 1)`, whose argument says
 * whether sound is *on*.  Read as "mute", it turned the sound off just
 * before the intro started its own music, and every piece from there
 * to the end of the game mixed at zero gain while the driver happily
 * reported it playing.
 *
 * So this follows Camelot past the title sequence and insists on audio
 * from a piece that starts later, which is the part no first-piece
 * check can see.
 *
 * What counts as "later" is the piece, not the clock.  Pinning it to a
 * tick made the check depend on the title sequence taking exactly as
 * long as it did the day it was written: correcting the machine class
 * the games' own speed test reports lengthened that sequence by nine
 * seconds, and the one keypress that used to choose "See the Intro"
 * from an already-open menu now only opened the menu.  The music was
 * fine; the test was reading the clock.
 */
{
  const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
  const s = new Session(g, new Index(g));
  let clock = 0;
  s.now = () => clock;
  const box = s.vm.sounds;
  const buf = new Float32Array(2048);
  let st = s.tick();
  let titlePeak = 0, introPeak = 0, introPlays = 0;
  /** The title music, which is the piece this check must look past. */
  const TITLE_MUSIC = 1;
  // Keep offering Enter: one press opens the menu, the next takes
  // "See the Intro", and pressing on costs nothing once the intro runs.
  for (let i = 0; i < 9000 && st.running; i++) {
    if (i % 300 === 0) s.key(0x0D);
    clock += 1000 / 60;
    st = s.tick();
    if (!box.active) continue;
    box.mix(buf);
    let p = 0;
    for (const v of buf) p = Math.max(p, Math.abs(v));
    // Judge each block by what is actually sounding in it.
    const later = box.playing.some(n => n !== TITLE_MUSIC);
    if (later) { introPeak = Math.max(introPeak, p); if (p > 0.02) introPlays++; }
    else titlePeak = Math.max(titlePeak, p);
  }
  const ok = introPeak > 0.02;
  checked = ok;
  if (!ok) failed++;
  console.log(`CAMELOT   title peak ${titlePeak.toFixed(3)} · after the title screen peak ` +
    `${introPeak.toFixed(3)} over ${introPlays} blocks` +
    `${ok ? '' : ' -- WENT SILENT ONCE THE INTRO BEGAN'}`);
}

console.log(`\n${heard}/${asking} games that asked for music were heard playing it` +
  `${checked ? ', and Camelot kept playing past its title screen' : ''}`);
process.exit(failed ? 1 : 0);
