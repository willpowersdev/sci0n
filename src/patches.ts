/**
 * Changes made to a game's own compiled scripts.
 *
 * Kept small and kept honest.  A patch names the bytes it expects to
 * find and is not applied unless they are exactly there, so it
 * identifies its own game: no other script 414 in any other game has
 * these bytes at these offsets, and if a different release of this one
 * does not, nothing happens rather than something wrong.
 *
 * Only the interpreter's view is patched.  The resource on disk and
 * everything that reads it -- the browser, the digests the tests
 * compare -- see the bytes Sierra shipped.
 */

export interface Patch {
  /** Which script, and where in it. */
  script: number;
  at: number;
  /** The bytes that must be there, or the patch is not applied. */
  expect: readonly number[];
  replace: readonly number[];
  /** What it is for, reported when it is applied. */
  why: string;
}

/**
 * The Colonel's Bequest asks you to identify a fingerprint from the
 * map in the box, in room 414.
 *
 * Two of these three are a repair.  `myCopy::init` picks the
 * fingerprint with `Random(0, 600) / 100` for the loop and
 * `Random(1, 1000) / 250` for the cel, and both ranges are one too
 * generous: 600 gives loop 6 and 1000 gives cel 4, neither of which
 * exists in view 553.  When that happens the game draws one
 * fingerprint and marks another as the answer, so the right answer is
 * refused.  Sierra's own arithmetic, and it is wrong about once in
 * every few hundred tries.
 *
 * Which leaves the question still asked.  Skipping it outright was
 * tried and is not here: `myCopy::handleEvent` compares the answer
 * against a table at local 53 and branches past `self.cue()` when they
 * differ, but turning that branch around never reached `cue` in any
 * run.  All it did was stop a wrong answer ending the game, which
 * leaves the player stuck in front of the fingerprint instead -- worse
 * than before, and not what it would have claimed to do.
 */
export const PATCHES: readonly Patch[] = [
  {
    script: 414, at: 507,
    expect: [0x38, 0x58, 0x02],          // pushi 600
    replace: [0x38, 0x57, 0x02],         // pushi 599
    why: "Colonel's Bequest: the fingerprint's loop could overflow view 553",
  },
  {
    script: 414, at: 520,
    expect: [0x78, 0x38, 0xE8, 0x03],    // push1, pushi 1000
    replace: [0x76, 0x38, 0xE7, 0x03],   // push0, pushi 999
    why: "Colonel's Bequest: the fingerprint's cel could overflow view 553",
  },
  /**
   * King's Quest 4 asks a question it never manages to ask.
   *
   * `copyProtect::doit` formats text 701 line 0, which reads
   * "...answer the following question:\n\n%s" -- the question itself
   * arrives as that `%s`, out of a buffer the room is meant to have
   * filled with one of the ninety-odd it carries in its own script
   * ("On page 2, what is the fourth word of the first sentence?").
   * The buffer is empty by the time it is formatted, so what reaches
   * the screen is the preamble, a colon and nothing at all.  There is
   * no question to answer and no answer that will do: a wrong one is
   * refused and asked again, for ever.
   *
   * So the game is sent past it.  Script 0 starts play with
   * `(self newRoom: 701)`, the copy-protection room; room 700 is
   * where `copyProtect` itself goes when an answer is accepted, so
   * one byte of that room number is all this changes.  The room is
   * never entered rather than entered and defeated, which leaves the
   * question of what `copyProtect` would have done to the rest of the
   * game where it belongs -- unasked.
   */
  {
    script: 0, at: 632,
    expect: [0x38, 0xbd, 0x02, 0x54, 0x06, 0x48],   // pushi 701; self 6; ret
    replace: [0x38, 0xbc, 0x02],                    // pushi 700
    why: "King's Quest IV: the copy-protection question is never built, so the room is not entered",
  },
];

const matches = (d: Uint8Array, at: number, want: readonly number[]) =>
  want.every((b, i) => d[at + i] === b);

/**
 * The script as the interpreter should see it.
 *
 * Copies before writing, so the caller's bytes are left alone, and
 * only when there is something to write.
 */
export function patchScript(number: number, data: Uint8Array):
    { data: Uint8Array; applied: string[] } {
  const todo = PATCHES.filter(p => p.script === number && matches(data, p.at, p.expect));
  if (!todo.length) return { data, applied: [] };
  const out = Uint8Array.from(data);
  for (const p of todo) out.set(p.replace, p.at);
  return { data: out, applied: todo.map(p => p.why) };
}
