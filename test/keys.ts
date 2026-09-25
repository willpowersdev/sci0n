/**
 * How events are queued and read, which is ScummVM's shape.
 *
 * `getSciEvent(mask)` drains everything the system has into the queue,
 * then walks the queue for the first event the mask matches and takes
 * only that one out; anything it did not match stays where it is.  A
 * call that matches nothing still answers, and the answer carries the
 * pointer's position, because SCI puts the mouse position on every
 * event rather than sending events for movement -- ScummVM skips past
 * mouse movement in the system queue for exactly that reason.
 *
 * Repeats are not told apart from presses.  ScummVM's backend marks a
 * repeat with `kbdRepeat` and the SCI engine never reads it, so a held
 * key queues at the keyboard's repeat rate while `GetEvent` spends one
 * a cycle.  That is measured here rather than guarded against: see the
 * last check for what it costs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { EV } from '../src/vm/pmachine.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n: string) => new Uint8Array(readFileSync(join(dir, n))) };
}

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

check(EV.keyUp === 1 << 3,
  `a key coming up is bit 3, as SCI numbers it (0x${EV.keyUp.toString(16)})`);
check(EV.keyboard === 1 << 2 && EV.mouseDown === 1 && EV.mouseUp === 1 << 1,
  'and the rest of the types have their SCI values');

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
const step = (n = 1) => { for (let i = 0; i < n; i++) { clock += 1000 / 60; s.tick(); } };
s.tick(); step(400);

interface Machine {
  events: Array<{ type: number }>;
  kernel(id: number, a: number[], f?: unknown): number;
  makeString(t: string): number;
  resolveTarget(a: null, v: number): unknown;
  prop(o: unknown, n: string): number;
  mouseX: number; mouseY: number;
}
const vm = s.vm as unknown as Machine;
const getEvent = idx.kernel.indexOf('GetEvent');
const newNode = idx.kernel.indexOf('NewNode');

/** Somewhere to put the answer: any object with the event selectors. */
const evObj = idx.script(999)?.objects.find(o => o.name === 'Event');
const target = evObj ? (s.vm as unknown as { instantiate(n: number, d: unknown): unknown })
  .instantiate(999, evObj) : null;
const handle = target ? (target as { handle: number }).handle : 0;

// A mask takes only what it matches, and leaves the rest behind.
vm.events.length = 0;
s.mouse(EV.mouseDown, 40, 50);
s.key(0x4D00);
const got = vm.kernel(getEvent, [EV.keyboard, handle], null);
check(vm.events.length === 1 && vm.events[0].type === EV.mouseDown,
  `asking for a key took the key and left the click (${vm.events.length} waiting, ` +
  `type 0x${(vm.events[0]?.type ?? 0).toString(16)})`);
check(got !== 0 || handle === 0, 'and it reported one');

// Nothing matching still answers, with the pointer where it is.
vm.events.length = 0;
s.move(123, 45);
vm.kernel(getEvent, [EV.keyboard, handle], null);
check(vm.mouseX === 123 && vm.mouseY === 45,
  `an empty queue still knows where the pointer is (${vm.mouseX},${vm.mouseY})`);
check(vm.events.length === 0, 'and moving the pointer queued nothing');
void newNode;

/**
 * What passing repeats through costs, stated rather than prevented.
 *
 * A held key at a browser's repeat rate outruns one-a-cycle reading,
 * and the backlog is spent after the key comes up.  ScummVM behaves
 * the same way; the original did not, because the BIOS buffer repeats
 * about ten times a second against twenty cycles and so never gets
 * ahead.
 */
vm.events.length = 0;
let worst = 0;
for (let i = 0; i < 60; i++) { if (i % 2 === 0) s.key(0x4D00); step(1); worst = Math.max(worst, vm.events.length); }
console.log(`  --    a held key at 30 a second leaves ${worst} waiting after a second ` +
  `(ScummVM does the same; the hardware could not)`);

console.log(`\n${checked - failed}/${checked} event-queue checks passed`);
process.exit(failed ? 1 : 0);
