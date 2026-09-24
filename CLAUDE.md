# Working on sci0n

An SCI0 interpreter that runs Sierra's 1988-90 adventure games in a browser.
TypeScript, MIT licensed, no runtime dependencies.

## Every change is checked in a browser, by eye

This is the rule that matters most here, because it is the one that kept
being broken. A change is not finished when the tests pass. It is finished
when the game has been watched running in Chrome and looks right.

Use Claude in Chrome: open the page, start the game, take screenshots, and
look at them. Say what was seen. "The suite is green" is not an answer to
"does the title screen draw?"

The reason is not ceremony. Three separate faults in this project passed a
full green suite and were only found by looking:

- The whole patch table was applied to a copy only the disassembler read,
  so no patch ever reached the running machine. `test/patches.ts` tested the
  patching and not the running, and passed throughout.
- KQ4's title screen drew without its "IV" and its credits never advanced,
  while every Node-side check reported the intro running correctly.
- The audio check passed with the instrument bank disabled, because the
  drum channel is synthesised without reference to the bank.

Headless Node tests answer "what does the interpreter compute". Only the
browser answers "what does the player see".

## And the sound is listened to

Not literally: I cannot hear. What I can do is render the chip's output to
a file and measure it, and that is what "listened to" has to mean here —
pitch against the MIDI note numbers the score asks for, onsets against the
score's timing, the spectrum of a held note against the instrument the
patch defines, silence where there should be none.

Do that rather than checking a `playing` flag. A piece can report itself
playing for its whole length and emit nothing; it can emit something and be
a semitone out, or at half tempo, or on the wrong instrument. Each of those
is "the music is wrong" to the person listening, and none of them shows up
in a boolean.

Write the WAV out where the user can play it, and say so, so that the one
judgement I cannot make is easy for them to make.

## Tests have to be able to fail

Every fix gets a test, and the test is checked by **putting the fault back**
and confirming that specific check fails. A check that passes with the fix
reverted is not a test; delete it or make it bite. Say which check failed
when reporting the work.

Prefer judging the artefact over judging intermediate state: pixels on the
screen rather than a string in a buffer, the mixed audio rather than a
`playing` flag. Where a metric could be satisfied by the wrong thing, say
so in the test and choose a different one.

Do not pick a threshold that makes a test pass. Go and measure what the
right number is.

## Claims

Never report something as fixed without having seen it work. If a fix could
not be verified, say that plainly and leave it out rather than shipping it
on a guess. Several claims in this project's history were withdrawn for
exactly this reason, which is the right outcome.

Correct earlier statements when they turn out wrong, in a sentence, and
move on.

## Commands

    npm test           the whole suite (needs games; see below)
    npm run check      Biome + tsc, the lint gate `npm test` runs first
    npm run build      bundle to dist/app.js
    node serve.mjs     serve the page and games/ on :8017
    node manifest.mjs games    rewrite games/games.json

`test/page.ts` and `test/crt.ts` drive headless Chrome. They say so and skip
rather than passing quietly when there is no Chrome to drive.

## The games

Not in the repo and never committed: they are Sierra's. `games/` is
gitignored and holds a trimmed copy under ScummVM's names — RESOURCE.MAP,
the numbered volumes, and `adl.drv` for the earliest games, whose AdLib
instruments live in the driver rather than in a patch resource. Which files
an interpreter opens is stated once, in `GAME_FILE` in `src/resources.ts`;
the manifest is checked against that same rule.

`SCI_GAMES` points the tests and the server at another copy.

## Fixing the games' own bugs

`src/patches.ts` holds byte patches to Sierra's compiled scripts. A patch
names the bytes it expects and is not applied unless they are exactly there,
so it identifies its own game. Keep them few, and explain in the comment
what the game does wrong and why the replacement is right — preferably by
reusing the game's own instructions from another branch rather than
inventing a sequence.

## Early SCI0

KQ4 is built differently from the rest and is worth knowing about before
debugging anything that only fails there. `Index.selectorShift` is the tell.
In those games: selectors are stored doubled and a property send sets bit 0;
`&rest` is not counted towards a kernel call; the kernel name table stops
short of the kernels the scripts call, so `SCI0_KERNEL` supplies the rest;
the AdLib bank lives in `adl.drv`; and a script's locals are not in the file
at all — the leading word is the count and the interpreter allocates them.

## Style

Comments explain *why*, and name the symptom that made the code necessary —
"Camelot's opening menu was an eight pixel wide box because of it" is worth
more than a restatement of the code. Match the surrounding density; British
spelling; no decorative headers.

Commit messages: what was wrong, what it looked like to a player, why the
fix is right. Lead with the symptom.
