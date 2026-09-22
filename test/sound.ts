/**
 * SCI0 sound resources, checked against themselves.
 *
 * There is no Python reference for sound, so the assertion is structural
 * and comes from the data: every stream must run from the end of its
 * header to its 0xFC end marker without a single byte left unexplained.
 * A wrong header size or a mis-sized event lands mid-stream and fails
 * within a few events, which is what makes this worth asserting.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { parseSound, detectHeaderSize, DEVICE_ADLIB } from '../src/sound.ts';

import { ROOT } from './games.ts';
const GAMES = ['SQ3', 'LSL2', 'KQ4', 'CAMELOT', 'COLONEL', 'ICE', 'HERO'];

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let bad = 0, total = 0, events = 0, digital = 0;
for (const name of GAMES) {
  const g = new Game(nodeSource(join(ROOT, name)));
  let ok = 0, fail = 0, ev = 0, dig = 0, adlib = 0;
  const rs = [...g.byType('sound')].sort((a, b) => a.number - b.number);
  const datas = rs.map(r => g.data(4, r.number));
  const header = detectHeaderSize(datas);
  for (const d of datas) {
    const s = parseSound(d, header);
    if (!s) { fail++; continue; }
    ok++;
    ev += s.events.length;
    if (s.digital) dig++;
    if (s.channels.some(c => c.devices & DEVICE_ADLIB)) adlib++;
  }
  bad += fail; total += ok; events += ev; digital += dig;
  console.log(`${name.padEnd(9)} ${String(ok).padStart(3)} sounds  header ${header} · ` +
    `${String(ev).toLocaleString().padStart(7)} events · ${adlib} use AdLib · ${dig} carry a sample` +
    (fail ? `  ${fail} FAILED` : ''));
}
console.log(`\n${total} sound resources parsed (${events.toLocaleString()} events, ` +
            `${digital} with digitised audio), ${bad} failures`);
process.exit(bad ? 1 : 0);
