# sci0web

A TypeScript reimplementation of Sierra's **SCI0** engine, running in the browser:
resource decoding, EGA graphics, script disassembly, a PMachine interpreter, and
OPL2 sound.

**No game data is included and none can be.** The engine reads your own copies of
the games. Point `SCI_GAMES` at a directory holding one folder per game.

## What works

| Layer | State |
|---|---|
| Resource container | LZW, COMP3/LZW1, Huffman; 8 games, 7,065 resources |
| Pictures | Full vector machine, three planes, SCI01 opcodes |
| Views | Flat-stream RLE, mirrored loops, cel animation |
| Scripts | Blocks, objects, method tables, exports, locals, said specs |
| Disassembler | 1,389,133 instructions across 7,849 code blocks |
| PMachine | Explicit frame stack; 5 of 8 games boot to an animating cast |
| Text / vocab | String tables, parser words, suffix rules, class table |
| Fonts / cursors | 6,528 glyphs, 24 cursors |
| Sound | 747 SCI0 resources, 609,750 events, OPL2 synthesis |

## Running it

```sh
npm install
SCI_GAMES=/path/to/games npm run serve      # then open http://localhost:8017
```

`/?game=SQ3` loads a game directly; `/?game=` lists what it can see. There is also
a directory picker for browsing without the server route.

```sh
SCI_GAMES=/path/to/games npm test           # the differential suites
SCI_GAMES=/path/to/games npm run test:ui    # drives the page through a DOM shim
SCI_GAMES=/path/to/games npm run test:vm    # interpreter sweep and boot
```

Node 22.6+ is required: the sources are run directly with
`--experimental-strip-types`, so there is no build step for the tests.

## How this was built, and how far to trust it

Most of the format work is checked against a separate Python reference
implementation, byte for byte, with digests over raw fields rather than formatted
text. That catches porting errors, but it cannot catch a mistake both sides share
— and twice it didn't:

- **The cursor AND-mask was inverted** in both. SQ3's arrow rendered as a black
  square with an arrow-shaped hole. Both digests agreed the whole time.
- **The glyph header is width-then-height**, not the reverse. The wrong order still
  renders something letter-shaped whenever both widths need the same number of
  bytes per row, so most fonts looked fine.

Both were found by looking at the output, and both are now covered by checks that
do not depend on the reference agreeing:

- Every glyph's bytes must end exactly where the next glyph begins (the wrong
  order gives 2,066 overruns).
- The disassembler's mnemonics are compared against **vocab.998, the interpreter's
  own opcode table** — 512 entries across 8 games, 0 mismatches.
- Every sound stream must run from its header to its `0xFC` end marker with no
  byte left unexplained.

### Known approximations

These are deliberate and stated rather than hidden:

- **OPL2 is a float model, not a cycle-exact YM3812.** Structure — operator ratios,
  envelope rates, feedback, the four waveforms — is reproduced; sample-exact
  hardware comparison is not claimed. Pitch is accurate to within 9 cents across
  five octaves through the full event chain.
- **The AdLib patch field order is partly inferred.** Fields were placed by how they
  distribute across 363 clean instruments pooled from six games, not from a spec.
  MULT and TL are well supported (and a wrong MULT would throw pitch off by whole
  harmonic ratios, which it does not). Two of the twelve fields are unassigned.
  The raw 28-byte record is kept on every instrument so a corrected mapping drops
  in without re-reading anything.
- **The EG-type bit is not reliably located**, so notes are held for the duration the
  score writes. Genuinely percussive patches ring longer than they should.
- **SCI01 sound is not decoded** (QFG2). It uses a multi-track header; the viewer
  says so rather than guessing.
- **Storage is 32-bit where SCI is 16-bit.** Object references are script-tagged and
  do not fit in a word. Arithmetic relying on 16-bit overflow no longer wraps.
- **KQ4 and QFG1 do not boot.** KQ4 dies in a copy-protection script that reads a
  local variable from a script with no locals block; QFG1 dies in `Act::canBeHere`
  on a path that needs `BaseSetter`.
- **There is no input source**, so games that wait at a title screen stay there.

## Licence

None yet — all rights reserved by default. Open an issue if you want one added.

Sierra's games and their data are not covered by this repository in any case.
