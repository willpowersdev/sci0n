/**
 * The second mouse button looks at things.
 *
 * SCI has no bit for it.  The mouse interrupt handler reported a right
 * press as an ordinary press with shift held -- ScummVM's comment on
 * the line that does it says the value "was hardcoded in the mouse
 * interrupt handler" -- and the games' own handlers read it that way.
 * Camelot already does the rest: a shifted click on something is a
 * look at it, and the room answers with its own description.
 *
 * So nothing here was missing but the modifier.  `Session::mouse` sent
 * zero for every press, so a right click was indistinguishable from a
 * left one and walked the ego instead.
 *
 * The check is that the answer is the *room's* answer.  Text appearing
 * is not enough -- a click that walked the ego into something would
 * also produce text -- so what is drawn has to be one of the lines
 * room 4 keeps for describing itself.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { EV, MOD } from '../src/vm/pmachine.ts';
import { ROOT } from './games.ts';

/** Arthur's chamber, and the rug in the middle of its floor. */
const ROOM_TEXT = 4, RUG_X = 250, RUG_Y = 120;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
const step = (n = 1) => { for (let i = 0; i < n; i++) { clock += 1000 / 60; s.tick(); } };

interface Live { def?: { name?: string } }
interface Machine {
  objects?: Map<number, Live>;
  prop(o: Live, n: string): number;
  kernel(id: number, a: number[], f?: unknown): number;
  resolveTarget(f: null, r: number): Live | null;
  drawText(...a: unknown[]): unknown;
}
const vm = s.vm as unknown as Machine;

// Through the opening menu into the game.
const buttons: Array<{ l: number; t: number; r: number; b: number }> = [];
let win: { top: number; left: number } | null = null;
const drawControl = idx.kernel.indexOf('DrawControl');
const newWindow = idx.kernel.indexOf('NewWindow');
const kernel = vm.kernel.bind(vm);
vm.kernel = (id: number, a: number[], f?: unknown) => {
  if (id === newWindow && !win) win = { top: a[0], left: a[1] };
  if (id === drawControl) {
    const o = vm.resolveTarget(null, a[0]);
    if (o?.def?.name === 'DButton')
      buttons.push({ l: vm.prop(o, 'nsLeft'), t: vm.prop(o, 'nsTop'),
                     r: vm.prop(o, 'nsRight'), b: vm.prop(o, 'nsBottom') });
  }
  return kernel(id, a, f);
};
s.tick(); step(300);
s.key(0x0D); step(90);
const opened = win as { top: number; left: number } | null;
checked++;
if (!opened || buttons.length < 2) {
  failed++;
  console.log('  FAIL  could not start a game');
  console.log(`\n${checked - failed}/${checked} right-click checks passed`);
  process.exit(1);
}
console.log('  ok    started a game');
const b = buttons[1];
s.mouse(EV.mouseDown, opened.left + ((b.l + b.r) >> 1), opened.top + ((b.t + b.b) >> 1));
step(3);
s.mouse(EV.mouseUp, opened.left + ((b.l + b.r) >> 1), opened.top + ((b.t + b.b) >> 1));
step(660);

/** Every line the room keeps for describing itself. */
const roomLines = Buffer.from(g.data(3, ROOM_TEXT)).toString('latin1')
  .split('\0').map(t => t.trim()).filter(t => t.length > 20);

const drawn: string[] = [];
const drawText = vm.drawText.bind(vm);
vm.drawText = (f: unknown, t: unknown, ...rest: unknown[]) => {
  if (typeof t === 'string' && t.trim().length > 3 && !drawn.includes(t)) drawn.push(t);
  return drawText(f, t, ...rest);
};

/**
 * One click, measured on its own.
 *
 * Whatever the last one put up is dismissed first: a click lands on an
 * open message box rather than on the room, so without this each one
 * measures the box before it.
 */
const click = (x: number, y: number, mods: number) => {
  s.key(0x0D); step(60); s.key(0x0D); step(60);
  drawn.length = 0;
  s.mouse(EV.mouseDown, x, y, mods); step(4);
  s.mouse(EV.mouseUp, x, y, mods); step(220);
  return [...drawn];
};

const right = click(RUG_X, RUG_Y, MOD.right);
check(right.length > 0,
  `a right click on the rug answers (${right.map(t => JSON.stringify(t.slice(0, 40))).join(' ') || 'nothing'})`);
check(right.some(t => roomLines.some(line => line.startsWith(t.trim().slice(0, 30)))),
  'what it says is one of the room\'s own descriptions');

const left = click(RUG_X, RUG_Y, 0);
check(left.length === 0,
  `the same click without the button says nothing (${left.map(t => JSON.stringify(t.slice(0, 30))).join(' ') || 'nothing'})`);

console.log(`\n${checked - failed}/${checked} right-click checks passed`);
process.exit(failed ? 1 : 0);
