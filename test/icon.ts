/**
 * The picture beside the words.
 *
 * SCI numbers its controls 1 button, 2 text, 3 edit, 4 icon, 6 list.
 * An icon carries a view, a loop and a cel instead of a string, and
 * Camelot's death and quit box uses one: `myIcon` in script 128 is a
 * `DCIcon` with view 999 and a `cycleSpeed`, so what belongs beside
 * "do you really want to quit" is not a still picture but a little
 * animation -- loop 0 of that view is eleven cels.
 *
 * The cycling is the game's own work.  `DCIcon::init` makes a cycler,
 * and its `cycle` advances the cel and calls `draw` again whenever the
 * cel changes.  What was missing was anywhere for that draw to land:
 * `DrawControl` knew buttons, text and edit fields, and an icon fell
 * through to the branch that writes a string.  An icon has no string,
 * so nothing was drawn at all and the box came up with the question
 * and a blank space where the picture goes.
 *
 * So this asks the two things that matter: that an icon control puts
 * something on the screen, and that moving to another cel puts
 * something *different* there -- which is what makes it an animation
 * rather than a picture drawn eleven times.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH } from '../src/vm/screen.ts';
import { ROOT } from './games.ts';

/** Camelot's death and quit box, and the icon in it. */
const DIALOG_SCRIPT = 128, ICON = 'myIcon';
const CONTROL_ICON = 4;

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
for (let i = 0; i < 400; i++) { clock += 1000 / 60; s.tick(); }

interface Live { def?: { name?: string }; handle: number }
interface Machine {
  instantiate(script: number, def: unknown): Live;
  kernel(id: number, a: number[], f?: unknown): number;
  prop(o: Live, n: string, d?: number): number;
  setProp(o: Live, n: string, v: number): void;
  celOf(o: Live): { width: number; height: number } | null;
}
const vm = s.vm as unknown as Machine;

const script = idx.script(DIALOG_SCRIPT);
const def = script?.objects.find(o => o.name === ICON);
checked++;
if (!def) {
  failed++;
  console.log(`  FAIL  script ${DIALOG_SCRIPT} has no ${ICON}`);
  console.log(`\n${checked - failed}/${checked} icon checks passed`);
  process.exit(1);
}
const icon = vm.instantiate(DIALOG_SCRIPT, def);
console.log(`  ok    ${ICON}: type ${vm.prop(icon, 'type')}, view ${vm.prop(icon, 'view')},` +
  ` cycleSpeed ${vm.prop(icon, 'cycleSpeed')}`);
check(vm.prop(icon, 'type') === CONTROL_ICON,
  `it is an icon control (type ${vm.prop(icon, 'type')})`);

// Put it somewhere with room, and see what each cel draws.
const X = 40, Y = 40;
vm.setProp(icon, 'nsLeft', X);
vm.setProp(icon, 'nsTop', Y);
vm.setProp(icon, 'loop', 0);
const cel0 = vm.celOf(icon);
check(cel0 !== null, `its cel is there to draw (${cel0?.width}x${cel0?.height})`);

const drawControl = idx.kernel.indexOf('DrawControl');
const W = cel0?.width ?? 40, H = cel0?.height ?? 40;
const snap = () => {
  const out: number[] = [];
  for (let y = Y; y < Y + H; y++)
    for (let x = X; x < X + W; x++) out.push(s.screen.visual[y * WIDTH + x]);
  return out;
};
/**
 * Put the screen back, so each cel is measured against the same thing.
 *
 * Without this the second cel is drawn on top of the first and only
 * its difference shows, which flatters the check that says it drew
 * anything and makes the one comparing two cels measure the wrong
 * pair of pictures.
 */
const clean = snap();
const restore = () => {
  let i = 0;
  for (let y = Y; y < Y + H; y++)
    for (let x = X; x < X + W; x++) s.screen.visual[y * WIDTH + x] = clean[i++];
};

/** What every cel of the animation puts on the screen. */
const drawn: number[][] = [];
let leastDrawn = Number.POSITIVE_INFINITY;
const CELS = 11;
for (let cel = 0; cel < CELS; cel++) {
  restore();
  vm.setProp(icon, 'cel', cel);
  vm.kernel(drawControl, [icon.handle]);
  const after = snap();
  let changed = 0;
  for (let i = 0; i < clean.length; i++) if (clean[i] !== after[i]) changed++;
  drawn.push(after);
  leastDrawn = Math.min(leastDrawn, changed);
}
check(leastDrawn > 100,
  `all ${CELS} cels drew something (the thinnest put ${leastDrawn} of ${clean.length} pixels down)`);

/**
 * And they must not all look the same.
 *
 * Drawing *a* picture is not enough: if every cel came out identical
 * the box would show a still and the animation would be missing with
 * nothing to show for it.
 *
 * The bar is low on purpose, because the animation is.  The icon is a
 * skull with a worm crawling out of its eye socket: the skull does not
 * move and only the worm does, so the furthest-apart cels of the
 * eleven differ by 52 pixels out of 1152.  Asking for more than that
 * would be asking for an animation this one does not have.  Measured
 * across the whole loop rather than between a chosen pair, since
 * neighbouring cels differ by less still.
 */
let widest = 0;
for (const a of drawn)
  for (const b of drawn) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    widest = Math.max(widest, d);
  }
check(widest > 25,
  `the cels are not all the same picture (the furthest apart differ by ${widest} pixels)`);

console.log(`\n${checked - failed}/${checked} icon checks passed`);
process.exit(failed ? 1 : 0);
