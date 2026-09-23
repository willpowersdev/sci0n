/**
 * Sixteen-bit arithmetic, and the game state that rides on it.
 *
 * SCI's word is sixteen bits and its `shr` is a logical shift.
 * `0x8000 >> 3` is `0x1000` there.  Taking the sign bit along instead,
 * the way a 32-bit arithmetic shift does, makes it `0xfffff000` -- not
 * a rounding error but every higher bit set.
 *
 * Camelot keeps its story flags sixteen to a global and sets one with
 * `flags |= (0x8000 >> n)`, so a single `setFlag(13)` set flags 0 to 13
 * together.  Flag 3 is "Arthur is wearing his armour", and the room he
 * wakes up in reads it to choose which Arthur to draw: view 0 in chain
 * mail, view 2 in the tunic he slept in.  He began the game already
 * armoured, with his armour also still on its stand behind him.
 *
 * Both ends are checked, because either alone can be satisfied
 * wrongly.  The flag word says the arithmetic is right; the pixels say
 * the game acted on it.  The second is the one that cannot be fudged:
 * the mail cels are nearly a third chain-mail grey and the tunic ones a
 * twenty-fifth, so what is actually on screen decides it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

const ENTER = 0x0D;
/** Where Camelot keeps flags 0..15, and the one that means "in armour". */
const FLAGS = 250, ARMOUR = 3;
/** The greys chain mail is drawn in. */
const MAIL = new Set([7, 8, 15]);
/** Above this share of a cel is mail; the tunic is far below it. */
const MAIL_SHARE = 0.15;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

const bits = (v: number) => { let n = 0; for (let i = 0; i < 16; i++) if (v & (1 << i)) n++; return n; };

let failed = 0, checked = 0;

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
const step = () => { clock += 1000 / 60; return s.tick(); };
const vm = s.vm as any;

let st = s.tick();
for (let i = 0; i < 12_000 && st.running; i++) { if (i % 120 === 0) s.key(ENTER); st = step(); }
console.log(`CAMELOT  in the game at picture ${st.picture}`);

/**
 * The flag word holds what was set, and nothing else.
 *
 * A smeared shift shows up here as a word full of ones -- the game had
 * 0xfffc, fourteen flags, from a single call.
 */
checked++;
const word = vm.globals[FLAGS] & 0xFFFF;
const many = bits(word) > 4;
if (many) failed++;
console.log(`  ${many ? 'FAIL' : 'ok  '} flag word 0x${word.toString(16).padStart(4, '0')} has ${bits(word)} bit(s) set` +
  `${many ? ' -- A SHIFT SMEARED ACROSS THE WORD' : ''}`);

checked++;
const wearing = (word & (0x8000 >>> ARMOUR)) !== 0;
if (wearing) failed++;
console.log(`  ${wearing ? 'FAIL' : 'ok  '} Arthur is ${wearing ? 'FLAGGED AS WEARING HIS ARMOUR' : 'not flagged as wearing his armour'}`);

/**
 * And the Arthur actually on screen is the one in the tunic.
 *
 * Read off the cel the interpreter would draw, so a game that set the
 * flag correctly and then drew the wrong view is still caught.
 */
checked++;
let ego: any = null;
for (const v of vm.listValues(vm.cast)) {
  const o = vm.resolveTarget(null, v);
  if (o?.name === 'ego') { ego = o; break; }
}
const cel = ego ? vm.celOf(ego) : null;
if (!cel) {
  failed++;
  console.log('  FAIL there is no ego on screen to look at');
} else {
  let opaque = 0, mail = 0;
  for (const p of cel.pixels) {
    if (p === cel.key) continue;
    opaque++;
    if (MAIL.has(p)) mail++;
  }
  const share = opaque ? mail / opaque : 0;
  const armoured = share > MAIL_SHARE;
  if (armoured) failed++;
  console.log(`  ${armoured ? 'FAIL' : 'ok  '} the Arthur on screen is view ${vm.prop(ego, 'view')},` +
    ` ${Math.round(share * 100)}% chain-mail grey` +
    `${armoured ? ' -- HE IS WEARING HIS ARMOUR' : ' -- the tunic he woke up in'}`);
}

console.log(`\n${checked - failed}/${checked} 16-bit checks passed`);
process.exit(failed ? 1 : 0);
