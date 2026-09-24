/**
 * The listing a deployed copy reads instead of a directory.
 *
 * A web server serves files, not listings: `GET /games/` is not a
 * question it answers.  So a copy on the web carries `games/games.json`
 * naming each game and its resources, and `manifest.mjs` writes it.
 *
 * Two things have to hold, and the second is the one that matters.
 * The manifest must name every game that is one -- a folder with a
 * RESOURCE.MAP -- and what it names for each must be *enough*: the
 * whole point is to upload less than a Sierra folder holds, and a list
 * that leaves out a volume produces a game that starts and then cannot
 * find half its rooms.
 *
 * "Enough" is measured against the folder, not against perfection.
 * This interpreter reads SCI0 and cannot decode the resources of the
 * SCI1 games sitting in the same place, so asking that every resource
 * be readable would fail them for a fault that is not the manifest's.
 * What is asked instead is that the listed files read *no worse* than
 * the whole folder does -- which is the only thing leaving files out
 * could have broken.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Game } from '../src/resources.ts';
import { ROOT } from './games.ts';

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

const out = join(mkdtempSync(join(tmpdir(), 'sci0n-manifest-')), 'games.json');
execFileSync('node', ['manifest.mjs', ROOT, out], { stdio: 'pipe' });
const manifest: Record<string, string[]> = JSON.parse(readFileSync(out, 'utf8'));

/** Which folders really are games, decided the same way the loader does. */
const real = readdirSync(ROOT).filter(n => {
  if (n.startsWith('.')) return false;
  try { return readdirSync(join(ROOT, n)).some(f => /^RESOURCE\.MAP$/i.test(f)); }
  catch { return false; }
}).sort();

check(Object.keys(manifest).sort().join() === real.join(),
  `every game is listed and nothing else (${Object.keys(manifest).length} of ${real.length})`);

/** Only what the interpreter opens: the map and the numbered volumes. */
const stray = Object.entries(manifest)
  .flatMap(([g, fs]) => fs.filter(f => !/^RESOURCE\.(MAP|\d+)$/i.test(f)).map(f => `${g}/${f}`));
check(stray.length === 0,
  `nothing is listed that the loader would not open (${stray.slice(0, 3).join(' ') || 'none'})`);

/**
 * And the list is enough on its own.
 *
 * Loaded from exactly the named files, as a server would serve them,
 * rather than from the folder they came out of.
 */
let leanest = Number.POSITIVE_INFINITY, worst = '';
for (const [game, files] of Object.entries(manifest)) {
  const dir = join(ROOT, game);
  checked++;
  /** How many resources come out, from a given set of files. */
  const readable = (names: string[]) => {
    try {
      const g = new Game({ names: () => names,
                           read: (n) => new Uint8Array(readFileSync(join(dir, n))) });
      const all = [...(g as unknown as
        { resources: Map<string, { type: number; number: number }> }).resources.values()];
      let n = 0;
      for (const r of all) { try { g.data(r.type, r.number); n++; } catch { /* unreadable */ } }
      return { total: all.length, n };
    } catch { return { total: 0, n: 0 }; }
  };
  const whole = readdirSync(dir).filter(f => statSync(join(dir, f)).isFile());
  const lean = readable(files), full = readable(whole);
  const bad = lean.n < full.n || lean.total < full.total;
  if (bad) failed++;
  const read = lean.n;
  // How much of the folder was left behind, which is the point of it.
  const saved = whole.length - files.length;
  if (saved < leanest) { leanest = saved; worst = game; }
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${game.padEnd(9)} ${files.length} files carry ` +
    `${lean.total} resources, ${read} readable -- the whole folder gives ` +
    `${full.total}/${full.n} (${saved} files left behind)`);
}
check(leanest > 0, `every game listed fewer files than its folder holds (${worst} saved the least)`);

console.log(`\n${checked - failed}/${checked} manifest checks passed`);
process.exit(failed ? 1 : 0);
