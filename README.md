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
| Imaging | Cel undithering (ScummVM's cross-check) and MLAA |
| Scenes | 754 rooms composited from static props, 2,709 sprites placed |
| Analysis | Room graph, room links, a per-room behavioural model over 17,058 Said handlers, and a planner over it |
| Export | PNG from any image tab; animated GIF for a view's loop |
| **Playing** | **5 of 8 games boot, draw and keep running in the browser** |

## Running it

```sh
npm install
SCI_GAMES=/path/to/games npm run serve      # then open http://localhost:8017
```

Opening it lists the games it can see and you click one. `/?game=SQ3` still loads one
directly. There is also a directory picker for a copy the server cannot reach, which
is the only way in when the page is opened from a file rather than served.

A picture has a **sprites** toggle that composites the props its room script stages,
priority-tested against the pic so sprites sit behind the scenery they should. A view
has an **undither** toggle that merges the dither pairs the game's backgrounds also
use. Both work alongside the existing visual/undithered/priority/control modes.

**Speed.** SCI0 games ask to wait zero ticks and let the machine set the pace — that
is what their speed test was measuring — so on anything modern they run as fast as the
interpreter can be driven. A zero wait is held for three ticks by default, which is
twenty game cycles a second, about where the hardware of the day left them. The
control in the corner changes it.

**Dictation.** A page cannot see the fn key, so the hook is the other half of what
macOS needs: playing keeps a focused, invisible text field over the picture, and
dictated text inserted into it is forwarded to the game as keystrokes. Press fn twice
as usual. Typed characters come through the same path — the `input` event is the only
place dictated text appears, since macOS delivers it as an insertion with no key
events at all, so handling both would type everything twice.

**▶ Play this game** runs the interpreter itself: the VM executes a slice per
displayed frame, draws the cast over the picture with the priority test that beds
sprites into scenery, and takes keyboard and mouse input. Shift-Escape leaves.
Five of the eight games reach a picture and keep running; see the limits below.

Pictures, views, fonts and cursors each have a **PNG** button, which saves the image
as displayed — at view scale, with the 1.2 aspect correction that makes SCI art look
right on square pixels. A view also has a **GIF** button that exports the selected
loop as a looping animation at native size, with the cels aligned by their
displacements so the sprite stays registered against itself rather than jittering
inside per-cel bounding boxes.

```sh
SCI_GAMES=/path/to/games npm test           # twelve differential suites
SCI_GAMES=/path/to/games npm run test:ui    # drives the page through a DOM shim
SCI_GAMES=/path/to/games npm run test:vm    # interpreter sweep and boot
```

Node 22.6+ is required: the sources are run directly with
`--experimental-strip-types`, so there is no build step for the tests.

## The format

[`docs/sci0-format.md`](docs/sci0-format.md) is the reference this engine was built
from: the container, the compression and why it has to be probed for, the pic opcodes,
view cels, script objects, the bytecode, and the places the format misleads you.

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
- The GIF encoder is checked by decoding its own output back to the exact pixels with
  an independently written reader, including a case large enough to fill the LZW
  dictionary and force a table reset.
- The disassembler's mnemonics are compared against **vocab.998, the interpreter's
  own opcode table** — 512 entries across 8 games, 0 mismatches.
- The AdLib patch format is taken from **ADL.DRV, the driver Sierra shipped**, by
  disassembling its loader and its six OPL register builders — not guessed from the
  data. The data then agrees: read that way, feedback is 0..7 and the waveform
  selects 0..3 in every one of the 624 instruments across seven games, where reading
  the record two bytes later makes feedback valid in as few as 55% of them.
- Every sound stream must run from its header to its `0xFC` end marker with no
  byte left unexplained.

### Known approximations

These are deliberate and stated rather than hidden:

- **OPL2 is a float model, not a cycle-exact YM3812.** Structure — operator ratios,
  envelope rates, feedback, the four waveforms — is reproduced; sample-exact
  hardware comparison is not claimed. Pitch is accurate to within 9 cents across
  five octaves through the full event chain.
- **Percussion is a dedicated synth, not OPL2 rhythm mode** (see below).
- **Percussion is a dedicated synth, not OPL2 rhythm mode.** Channel 9 carries General
  MIDI percussion — pooled over a game its notes are hi-hat, kick, snare, tambourine
  and cymbals — and each drum is synthesised from a swept tone plus a noise burst.
  The AdLib driver used the chip's rhythm channels for these; the timbres here are
  tuned rather than decoded. This is the one part of the sound path that is still
  approximated rather than read from the driver.
- **Melodic programs are not General MIDI.** They index the game's own AdLib bank:
  the numbers used run 0..95 against a 96-instrument bank, and LSL2's 48-instrument
  bank is never asked for anything above 42. Program 127 means no instrument. Only
  the drum channel follows a General MIDI map.
- **KQ4 has no patch resource**, so it plays drums but no melody — its instrument
  definitions live inside `adl.drv`, which is not read.
- **SCI01 sound is not decoded** (QFG2). It uses a multi-track header; the viewer
  says so rather than guessing.
- **Storage is 32-bit where SCI is 16-bit.** Object references are script-tagged and
  do not fit in a word. Arithmetic relying on 16-bit overflow no longer wraps.
- **KQ4 and QFG1 do not boot.** KQ4 dies in a copy-protection script that reads a
  local variable from a script with no locals block; QFG1 dies in `Act::canBeHere`
  on a path that needs `BaseSetter`.
- **The interpreter is partial.** It draws pictures and the cast, moves actors, takes
  input, draws text, and opens windows with their controls — LSL2 reaches its
  copy-protection dialog with the prompt wrapped inside a message box and a working
  edit field. Menus, the parser and save/restore are still stubs, so a game runs and
  animates without being completable. Typing works: LSL2's copy-protection field
  accepts digits, and answering it wrongly makes the game quit, which is the game
  working. KQ4, Iceman and QFG1 stop with an error during start-up. KQ4 and QFG1 stop with an error during
  start-up; Iceman runs but has not drawn a picture by frame 300.
- **The behavioural model is a hypothesis, not a proof.** A tested global is not
  necessarily a precondition — the scan covers a whole handler body, so tests in a
  nested branch are attributed to the command as a whole — conditions held in object
  properties are missed, and transitions whose destination is computed cannot be
  resolved. It maps what is *possible* per room, not what will work.
- **`roomgraph.layout` does not reproduce the reference's coordinates.** It is seeded
  from Python's Mersenne Twister there and from a small generator here. The graph is
  identical; only the dot positions differ, which is why the test digests the
  structure and not the layout.

## Licence

[MIT](LICENSE) — © 2026 Will Powers.

This covers the code in this repository only. Sierra's games, their resources and
their data are not covered by it and are not distributed here.
