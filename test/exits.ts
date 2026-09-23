/**
 * Leaving a room by walking off the edge of it.
 *
 * Several of Camelot's rooms have no door to use and no exit verb to
 * type: the room's own `doit` watches the ego's position and sends it
 * back to the map when it passes a line.  Merlin's room is left by
 * walking off the bottom, `Rm2::doit` waiting for y to pass 188;
 * Gwenhyver's bower by walking off the right, `Rm6::doit` waiting for x
 * to pass 308.  Both lines are outside the part of the picture an actor
 * can stand entirely within, which is the point -- a room that wants a
 * way out leaves its edge unpainted in the control plane, and the edge
 * of a picture is not a wall.
 *
 * The question "may this actor stand here" is asked from two
 * directions: the kernel's `CanBeHere`, and the test inside `DoBresen`
 * that every step passes through.  They are the same question and they
 * had drifted apart -- the bounds test was taken out of one and left in
 * the other -- so the answer depended on who asked.  `CanBeHere` said
 * the ego could be at y 190, and putting it there by hand did leave the
 * room; it simply could never walk there.  It stopped at 188 exactly,
 * one row short, in a room with no other way out.
 *
 * So this walks, rather than placing the ego past the line and calling
 * that a test: placing it there passed throughout.
 *
 * Arriving matters as much as leaving.  The map puts the ego back at
 * the place it came from -- `rm1::init` reads a pair of tables indexed
 * by which room that was, and Merlin's tower is 238,64 -- and it does
 * that inside `init`, which runs before the next `Animate`.  `Act::posn`
 * asks the control plane whether the spot it was given is one the ego
 * may stand on, and if not `Act::findPosn` spirals outward looking for
 * somewhere better.  With the picture's planes still those of the room
 * just left, every answer was wrong, the spiral never found anything,
 * and it wandered off the edge of the picture: Arthur appeared off
 * screen at 303,-1 and walked in from there.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { ROOT } from './games.ts';

const DOWN = 0x5000, RIGHT = 0x4D00;
/**
 * Where each room lets you out, which way you have to walk, and where
 * the map puts you down -- `rm1::init`'s tables, indexed by where you
 * came from.
 */
const EXITS = [
  { room: 2, name: "Merlin's room", key: DOWN, to: 1, lands: [238, 64] },
  { room: 6, name: "Gwenhyver's bower", key: RIGHT, to: 1, lands: [182, 57] },
];
/** Export 0 of script 0 is the game object, and its newRoom is here. */
const NEW_ROOM = 2530;

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

interface Live { def?: { name?: string } }
interface Machine {
  objects?: Map<number, Live>;
  globals: Int32Array;
  stack: number[];
  prop(o: Live, n: string): number;
  setProp(o: Live, n: string, v: number): void;
  kernel(id: number, a: number[], f?: unknown): number;
  resolveTarget(f: null, r: number): Live | null;
  scriptID(s: number, i: number): number;
  run(s: number, o: Live | null, pc: number, opts: Record<string, unknown>): { stopped: string };
}

let failed = 0, checked = 0;
const check = (ok: boolean, msg: string) => {
  checked++; if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

for (const exit of EXITS) {
  const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { clock += 1000 / 60; s.tick(); } };
  const vm = s.vm as unknown as Machine;

  // Through the opening menu and into the game.
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
  if (!opened || buttons.length < 2) {
    checked++; failed++;
    console.log(`  FAIL  ${exit.name}: could not start a game`);
    continue;
  }
  const b = buttons[1];
  s.mouse(1, opened.left + ((b.l + b.r) >> 1), opened.top + ((b.t + b.b) >> 1));
  step(3);
  s.mouse(2, opened.left + ((b.l + b.r) >> 1), opened.top + ((b.t + b.b) >> 1));
  step(660);

  // Ask the game for the room, the way its own scripts do.
  const game = vm.resolveTarget(null, vm.scriptID(0, 0));
  const base = vm.stack.length;
  vm.stack.push(1, exit.room);
  vm.run(0, game, NEW_ROOM, { paramsBase: base, steps: 400_000, deadline: Date.now() + 5000 });
  step(300);

  const ego = () => [...(vm.objects?.values() ?? [])].find(o => o?.def?.name === 'ego');
  const picture = () => (s.tick() as unknown as { picture: number }).picture;

  checked++;
  if (picture() !== exit.room) {
    failed++;
    console.log(`  FAIL  ${exit.name}: never got into room ${exit.room} (picture ${picture()})`);
    continue;
  }
  const e = ego()!;
  const from = `${vm.prop(e, 'x')},${vm.prop(e, 'y')}`;
  console.log(`  ok    ${exit.name}: entered room ${exit.room}, ego at ${from}`);

  // Walk, and keep walking: one press starts the ego moving, and a
  // press a cycle keeps it going in the same direction.
  let left = false;
  for (let i = 0; i < 90 && !left; i++) {
    s.key(exit.key);
    step(6);
    if (picture() === exit.to) left = true;
  }
  const where = `${vm.prop(e, 'x')},${vm.prop(e, 'y')}`;
  check(left,
    `${exit.name}: walked out to room ${exit.to} ` +
    `(from ${from}, ended at ${where}, picture ${picture()})`);
  if (!left) continue;

  /**
   * And landed where the map meant to put him.
   *
   * Read on the first cycle after the room appears: the map walks the
   * ego on from here by itself, which is the sequence the game plays,
   * so a later reading would be of the walk rather than of the arrival.
   */
  const [wx, wy] = exit.lands;
  const ax = vm.prop(e, 'x'), ay = vm.prop(e, 'y');
  check(ax === wx && ay === wy,
    `${exit.name}: arrived at ${ax},${ay}, where the map puts him (${wx},${wy})`);
  check(ax >= 0 && ax < 320 && ay >= 0 && ay < 190,
    `${exit.name}: arrived on the screen, not off it`);
}

/**
 * The two answers must agree.
 *
 * Stated as its own property so that a future change to one of them
 * fails here rather than in a room that happens to need it.
 */
{
  const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
  const idx = new Index(g);
  const s = new Session(g, idx);
  let clock = 0;
  s.now = () => clock;
  for (let i = 0; i < 400; i++) { clock += 1000 / 60; s.tick(); }
  const vm = s.vm as unknown as Machine & { legalAt(o: Live, x: number, y: number): boolean };
  const canBeHere = idx.kernel.indexOf('CanBeHere');
  const baseSetter = idx.kernel.indexOf('BaseSetter');
  const e = [...(vm.objects?.values() ?? [])].find(o => o?.def?.name === 'ego');
  checked++;
  if (!e) { failed++; console.log('  FAIL  no ego to ask about'); }
  else {
    let disagreed = 0, asked = 0;
    for (let y = 150; y <= 200; y += 2) {
      for (const x of [8, 160, 312]) {
        const keepX = vm.prop(e, 'x'), keepY = vm.prop(e, 'y');
        vm.setProp(e, 'x', x); vm.setProp(e, 'y', y);
        vm.kernel(baseSetter, [vm.globals[0]]);
        const kernelSays = vm.kernel(canBeHere, [vm.globals[0]]) === 1;
        const walkSays = vm.legalAt(e, x, y);
        asked++;
        if (kernelSays !== walkSays) disagreed++;
        vm.setProp(e, 'x', keepX); vm.setProp(e, 'y', keepY);
      }
    }
    check(disagreed === 0,
      `CanBeHere and the walk agree everywhere near the edges ` +
      `(${asked} positions asked, ${disagreed} disagreed)`);
  }
}

console.log(`\n${checked - failed}/${checked} room-exit checks passed`);
process.exit(failed ? 1 : 0);
