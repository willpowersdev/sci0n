/**
 * What goes back when a sprite moves off a spot.
 *
 * SCI saves the bits beneath a cel before drawing it and puts those
 * same bits back when it moves -- `underBits`.  It does not repaint the
 * picture there, and the difference shows wherever anything other than
 * the picture is underneath.
 *
 * KQ4's intro is built that way throughout: picture 205 decodes to a
 * black screen and everything on it -- the ornate frame, the faces --
 * is views standing on top.  Genesta's eyes blink, and putting the
 * picture back under the blink cut a black band across her face.
 * Measured on the pixels: the eye cel was drawn, and six frames later
 * those pixels were 0.
 *
 * So the check is the contract rather than that one scene, whose
 * timing shifts: paint something over the picture, let a sprite cover
 * it, take the sprite away, and what was there has to come back.
 *
 * The last check is the one that cost a day.  A rectangle wholly off
 * the left of the screen arrives with both x's negative, and clamping
 * only the near one leaves a negative far one -- which `subarray`
 * reads as counting back from the end rather than as empty, asks for
 * most of the framebuffer, and throws copying it into a buffer with no
 * room.  KQ4 has such a cel moments after Tamir appears, and the throw
 * stopped the game there: it looked exactly like the intro hanging.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Index } from '../src/script.ts';
import { Session } from '../src/vm/session.ts';
import { WIDTH } from '../src/vm/screen.ts';
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

const g = new Game(nodeSource(join(ROOT, 'CAMELOT')));
const idx = new Index(g);
const s = new Session(g, idx);
let clock = 0;
s.now = () => clock;
s.tick();
for (let i = 0; i < 400; i++) { clock += 1000 / 60; s.tick(); }

const screen = s.screen as unknown as {
  visual: Uint8Array; bgVisual: Uint8Array;
  castCovered(x0: number, y0: number, x1: number, y1: number): void;
  restoreCastAreas(): void;
  save(x0: number, y0: number, x1: number, y1: number): { w: number; h: number; buf: Uint8Array };
};

const X = 120, Y = 70, W = 30, H = 10;
const at = (x: number, y: number) => screen.visual[y * WIDTH + x];

/** Something standing over the picture: scenery, a portrait, a face. */
const SCENERY = 0x5A;
const paint = (v: number) => {
  for (let y = Y; y < Y + H; y++)
    for (let x = X; x < X + W; x++) screen.visual[y * WIDTH + x] = v;
};
paint(SCENERY);
check(at(X + 5, Y + 5) === SCENERY, 'something is standing over the picture');
check(screen.bgVisual[(Y + 5) * WIDTH + X + 5] !== SCENERY,
  'and the picture underneath is something else');

screen.castCovered(X, Y, X + W, Y + H);
paint(0x11);
check(at(X + 5, Y + 5) === 0x11, 'a sprite covered it');

screen.restoreCastAreas();
const back = at(X + 5, Y + 5);
check(back === SCENERY,
  back === SCENERY
    ? 'what was underneath came back, not the picture'
    : `the picture was painted back instead (${back.toString(16)}, wanted ${SCENERY.toString(16)})`);

/**
 * Two overlapping sprites undo newest first, or the later save -- which
 * holds the earlier sprite's pixels -- puts those back as if they
 * belonged there.
 */
paint(SCENERY);
screen.castCovered(X, Y, X + W, Y + H);
paint(0x22);
screen.castCovered(X + 5, Y, X + W, Y + H);
for (let y = Y; y < Y + H; y++)
  for (let x = X + 5; x < X + W; x++) screen.visual[y * WIDTH + x] = 0x33;
screen.restoreCastAreas();
const both = at(X + 10, Y + 5);
check(both === SCENERY,
  both === SCENERY
    ? 'two overlapping sprites undo to what was under both'
    : `an overlapped sprite left its pixels behind (${both.toString(16)})`);

// A cel wholly off the screen has nothing under it and must not throw.
for (const [x0, y0, x1, y1] of [[-47, -17, -26, 4], [330, 10, 380, 40],
                                [-10, 195, 20, 230], [10, -30, 40, -5]] as const) {
  let threw = '';
  let r: { w: number; h: number; buf: Uint8Array } | null = null;
  try { r = screen.save(x0, y0, x1, y1); } catch (e) { threw = (e as Error).message; }
  check(!threw && !!r && r.buf.length === r.w * r.h,
    threw ? `saving ${x0},${y0}-${x1},${y1} threw: ${threw}`
          : `saving ${x0},${y0}-${x1},${y1} off the screen gives ${r!.w}x${r!.h}`);
}

console.log(`\n${checked - failed}/${checked} under-bits checks passed`);
process.exit(failed ? 1 : 0);
