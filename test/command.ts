/**
 * Does the game answer a typed command?
 *
 * This is the whole point of a parser game, and it needs two kernels
 * that were not there at all.  `Parse` reads the line against the
 * game's own vocabulary, where every word it knows carries a group --
 * synonyms share one, which is why "get" and "take" are the same id.
 * `Said` then matches that against the patterns compiled into the
 * scripts.  Both returned 0 for everything, so pressing Return did
 * nothing whatever: the line was read, the window closed, and no
 * handler in the game ever fired.
 *
 * What is checked is the chain end to end: the line parses, a pattern
 * matches it, and the game puts something on the screen in reply.  A
 * word the game does not know must fail to parse, because that is a
 * different answer -- the game names the word back to the player
 * rather than saying it did not understand the sentence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
for (const [name, command] of [['SQ3', 'look'], ['CAMELOT', 'look']] as Array<[string, string]>) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = () => { clock += 1000 / 60; return s.tick(); };
  const vm = s.vm as any;

  // Watch what the parser is asked and what it answers.
  const parseK = idx.kernel.indexOf('Parse'), saidK = idx.kernel.indexOf('Said');
  let parsed = 0, tried = 0, matched = 0, drew = 0;
  const kernel = vm.kernel.bind(vm);
  const windowK = idx.kernel.indexOf('NewWindow'), displayK = idx.kernel.indexOf('Display');
  vm.kernel = (id: number, a: number[], f: unknown) => {
    const r = kernel(id, a, f);
    if (id === parseK && r) parsed++;
    if (id === saidK) { tried++; if (r) matched++; }
    if (id === windowK || id === displayK) drew++;
    return r;
  };

  let st = s.tick();
  for (let i = 0; i < 12_000 && st.running; i++) { if (i % 120 === 0) s.key(ENTER); st = step(); }

  for (const ch of command) { s.key(ch.charCodeAt(0)); for (let i = 0; i < 12 && st.running; i++) st = step(); }
  drew = 0;
  s.key(ENTER);
  for (let i = 0; i < 300 && st.running; i++) st = step();

  checked += 3;
  if (!parsed) failed++;
  if (!matched) failed++;
  if (!drew) failed++;
  console.log(`${name.padEnd(9)} "${command}" · parsed ${parsed ? 'yes' : 'NO'}` +
    ` · ${tried} patterns tried, ${matched} matched${matched ? '' : ' -- NONE MATCHED'}` +
    ` · the game ${drew ? 'answers' : 'SAYS NOTHING'}`);

  // A word it does not know is a different answer from a sentence it
  // cannot follow, and the game says so differently.
  checked++;
  const unknown = vm.parser.parse('zzxyqq');
  const knows = vm.parser.parse(command) === null;
  const ok = unknown === 'zzxyqq' && knows;
  if (!ok) failed++;
  console.log(`          an unknown word is reported back as "${unknown}"` +
    `${ok ? '' : ' -- EXPECTED THE WORD ITSELF, AND THE COMMAND TO PARSE'}`);
}
console.log(`\n${checked - failed}/${checked} command checks passed`);
process.exit(failed ? 1 : 0);
