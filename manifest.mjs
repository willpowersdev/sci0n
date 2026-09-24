/**
 * Write the manifest a deployed copy reads.
 *
 * A web server serves files, not directory listings, so a copy on the
 * web cannot ask what games it has or which resources each one holds.
 * This writes both answers into `games/games.json`, next to the games:
 *
 *   { "camelot": ["RESOURCE.MAP", "RESOURCE.000", ...], ... }
 *
 * A folder counts as a game when it has a RESOURCE.MAP, and only the
 * files the interpreter opens are listed: the map, the numbered
 * volumes, and `adl.drv`.  The driver is there for the earliest games
 * only -- KQ4 keeps its AdLib instruments inside it rather than in a
 * patch resource, and without it that game is silent -- but it costs a
 * few kilobytes and the later games simply do not read it.  Everything
 * else a Sierra folder carries, the executable and the saved games and
 * the other drivers, is never read and does not need uploading.
 *
 *   node manifest.mjs [games-directory] [output-file]
 *
 * The output defaults to `games.json` inside the directory, which is
 * where a deployed copy looks for it.
 */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEEP = /^(RESOURCE\.(MAP|\d+)|adl\.drv)$/i;
const dir = process.argv[2] ?? 'games';
const to = process.argv[3] ?? join(dir, 'games.json');

const out = {};
let files = 0, bytes = 0;
for (const name of (await readdir(dir)).sort()) {
  if (name.startsWith('.')) continue;
  let entries;
  try { entries = await readdir(join(dir, name)); } catch { continue; }
  if (!entries.some(f => /^RESOURCE\.MAP$/i.test(f))) continue;
  const want = entries.filter(f => KEEP.test(f)).sort();
  out[name] = want;
  files += want.length;
  for (const f of want) bytes += (await stat(join(dir, name, f))).size;
}

const names = Object.keys(out);
if (!names.length) {
  console.error(`no games in ${dir} -- a game folder is one with a RESOURCE.MAP`);
  process.exit(1);
}
await writeFile(to, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${to}: ${names.length} games, ${files} files, ` +
  `${(bytes / 1048576).toFixed(1)} MB`);
for (const n of names) console.log(`  ${n.padEnd(12)} ${out[n].length} files`);
