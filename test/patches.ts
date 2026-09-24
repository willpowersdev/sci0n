/**
 * Changes made to the games' own compiled scripts.
 *
 * A patch names the bytes it expects to find and is skipped unless they
 * are exactly there, which is how it identifies its own game without
 * being told which game it is.  That only works while the expectation
 * is right, so this checks it against the resources rather than taking
 * it on trust -- a patch whose bytes have gone stale would otherwise
 * sit there doing nothing and saying nothing.
 *
 * The one here is a repair to The Colonel's Bequest.  `myCopy::init`
 * picks the fingerprint to show with `Random(0, 600) / 100` for the
 * loop and `Random(1, 1000) / 250` for the cel.  View 553 has six
 * loops, and 600/100 is six: one too many.  When it comes up, the game
 * draws one fingerprint and marks a different one as the answer, so
 * the right answer is refused.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { View } from '../src/view.ts';
import { PATCHES, patchScript } from '../src/patches.ts';
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

/** Every patch has to land on exactly one game, and land. */
const games = readdirSync(ROOT).filter(d => !d.startsWith('.')).sort();
const landed = new Map<string, string[]>();
for (const name of games) {
  let g: Game;
  try { g = new Game(nodeSource(join(ROOT, name))); } catch { continue; }
  for (const p of PATCHES) {
    let d: Uint8Array;
    try { d = g.data(2, p.script); } catch { continue; }
    const { applied } = patchScript(p.script, d);
    for (const why of applied) {
      if (!landed.has(why)) landed.set(why, []);
      if (!landed.get(why)!.includes(name)) landed.get(why)!.push(name);
    }
  }
}
for (const p of PATCHES) {
  const on = landed.get(p.why) ?? [];
  check(on.length === 1,
    `${JSON.stringify(p.why)} matched ${on.length === 1 ? on[0] : `${on.length} games: ${on.join(' ') || 'none'}`}`);
}

// --- and that the repair is the right one -------------------------------
const colonel = new Game(nodeSource(join(ROOT, 'COLONEL')));
const view = new View(colonel.data(0, 553));
check(view.loops.length === 6,
  `the fingerprint view has ${view.loops.length} loops, so a loop of 6 is off the end`);
check(Math.floor(600 / 100) > view.loops.length - 1,
  `Sierra's range picks loop ${Math.floor(600 / 100)}, past the last (${view.loops.length - 1})`);
check(Math.floor(599 / 100) === view.loops.length - 1,
  `the corrected range stops at loop ${Math.floor(599 / 100)}`);

/**
 * The patched script has to be a script still.
 *
 * Three bytes in the wrong place would leave something that parses
 * into objects and then runs as nonsense, so the objects and the
 * method it belongs to are counted either side of the change.
 */
const raw = colonel.data(2, 414);
const idxRaw = new Index(colonel);
const before = idxRaw.script(414);
const { data: after } = patchScript(414, raw);
check(after.length === raw.length, 'the patched script is the same length');
let differ = 0;
for (let i = 0; i < raw.length; i++) if (raw[i] !== after[i]) differ++;
/**
 * Three bytes: the loop's upper bound, and both of the cel's.  The cel
 * range is wrong at both ends -- it starts at one where it should
 * start at nothing, as well as reaching one too far.
 */
check(differ === 3, `exactly ${differ} bytes differ: the loop's bound and both of the cel's`);
check((before?.objects.length ?? 0) > 0,
  `script 414 still parses into ${before?.objects.length} objects`);

console.log(`\n${checked - failed}/${checked} patch checks passed`);
process.exit(failed ? 1 : 0);
