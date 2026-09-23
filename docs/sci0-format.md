# Reading Sierra SCI0 resources

> This is the format reference the engine was built from: how an SCI0 game
> stores what it stores, and which parts of it mislead you. It was written
> alongside a Python implementation that has since been superseded by the
> TypeScript in `src/`, and is kept because the findings are about the
> format rather than about either implementation.


A working extractor for Sierra's SCI0 games, plus notes on how the format
actually behaves — written by dissecting the games in `~/DOSGames/SIERRA`
rather than by trusting the published specs, which are wrong or blank in
several places.

```
python3 -m sci0 info    <game-dir>
python3 -m sci0 list    <game-dir> [--type view]
python3 -m sci0 extract <game-dir> -o out [--aspect] [--scale 2] [--undither] [--raw]
python3 -m sci0 model   <game-dir> -o out
python3 -m sci0 plan    <game-dir> <start> <goal>
python3 -m sci0 scene   <game-dir> <room> [--aspect] [--scale 3] [--undither] [--aa]
```

Verified against SQ3, LSL2, KQ4, Camelot, Colonel's Bequest, Iceman,
Hero's Quest and QFG2:

* **7,065 resources decoded, zero failures**
* **11,938 objects parsed**
* **7,849 code blocks disassembled, every one landing exactly on an
  instruction boundary**

Sections 1-9 cover reading resources; 10-12 cover reading the compiled
scripts, which is what lets you reassemble a room rather than just its
background.

---

## 1. The three layers

Every SCI reader is the same three questions stacked:

| layer | question | where it lives |
|---|---|---|
| container | which bytes belong to resource *N*? | `RESOURCE.MAP` + `RESOURCE.###` |
| codec | how do I turn those bytes into the resource? | 8-byte volume header |
| format | what does the resource *mean*? | per-type decoders |

Keep them separate. Almost every confusing thing about SCI comes from
people collapsing layer 2 into layer 3 — and, as it turns out, Sierra
collapsed them too (see §4).

## 2. `RESOURCE.MAP` — the container

SCI0's map is a flat array of 6-byte records, terminated by `0xFFFF`.
Everything is little-endian.

```
u16 id    type   = id >> 11          (5 bits)
          number = id & 0x7FF        (11 bits)
u16+u16   loc    volume = loc >> 26  (6 bits)
                 offset = loc & 0x03FFFFFF
```

Two things bite here:

* **The same resource id appears many times.** Floppy games duplicate
  resources onto every disk they might be needed from. You want the first
  copy that lives in a volume you actually have.
* **The bit split is not stable across SCI versions.** SCI0 takes the
  volume from the top *6* bits; SCI1 moved it to the top 4 and rewrote the
  map into per-type tables. This is why a naive reader silently produces
  garbage offsets on the wrong game.

For reference, the layouts confirmed by probing the games on this machine:

| family | example | map shape | entry | offset encoding | vol header |
|---|---|---|---|---|---|
| SCI0 / SCI1-early | SQ3, KQ4, **KQ5** | flat | 6 B | `loc>>26`, `loc&0x3FFFFFF` | 8 B |
| SCI1-late | Longbow, Tales | typed table | 6 B | `loc>>28`, `loc&0xFFFFFFF` | 9 B |
| SCI1.1 | KQ6CD, QFG3 | typed table | 5 B | `u24 × 2` | 9 B |
| SCI2 | QFG4 | typed table | 6 B | raw `u32` | 13 B |

Note KQ5: a *SCI1* game still using the *SCI0* container. Engine version
and resource version are independent — detect the container, don't infer
it from the game.

## 3. The volume header

At `offset` inside `RESOURCE.###`:

```
u16 id            same packing as the map id — verify it matches
u16 comp_size     bytes of payload, counted from id+2 (so subtract 4)
u16 decomp_size   size after decompression
u16 method        0 stored, 1 LZW, 2 Huffman or COMP3
```

The id check is the single most useful sanity test in the whole format:
if it matches, your map arithmetic is right. That is exactly how the
layout table above was derived — try each candidate encoding, score by how
many headers come back with the expected type and number.

`comp_size` counts from *after* the id word, so the payload is
`data[offset+8 : offset+8+comp_size-4]`. Off-by-four here is the classic
first bug.

## 4. Compression, and why you must probe for it

There are three codecs in the SCI0 era:

* **Stored.**
* **LZW.** LSB-first bitstream, 9→12 bit codes, 256 = reset, 257 = end.
  The dictionary stores `(offset, length)` slices *of the output buffer
  itself* rather than strings, and the stored length is `written + 1` —
  which makes the classic KwKwK self-referencing case fall out for free,
  with no special case.
* **COMP3.** The same LZW, but MSB-first and with the early
  code-width-change bug (width grows at `2^n - 1`, one code sooner than
  it needs to).
* **Huffman**, with the tree carried in the resource: `u8 node_count,
  u8 terminator`, then 2-byte nodes of `(value, siblings)`. `siblings`
  packs the relative index of the left child in the high nibble and the
  right child in the low nibble; a right index of 0 is an escape meaning
  "the next 8 bits are a raw byte".

**The method number does not identify the codec.** It is an index into a
table that changed between interpreter revisions, and nothing in the files
says which revision you have. Measured on this corpus:

| | method 1 | method 2 |
|---|---|---|
| SCI0 — SQ3, LSL2, KQ4, Camelot, Colonel, Iceman, Hero | LZW | Huffman |
| SCI01 — QFG2 | **Huffman** | **COMP3** |

The published spec's SCI01 table (`1 = LZW, 2 = COMP3, 3 = Huffman`) does
not match QFG2, which has no method 3 at all and reads its Huffman
resources as method 1.

So resolve it empirically, per game and per method id — `Game.codec_for()`
takes a handful of sample resources, runs every candidate, and keeps the
winner.

### Length alone is not a good enough oracle

The obvious test is "did I get `decomp_size` bytes out?". It is not
sufficient, and believing it cost me a round of wrong results: the Huffman
decoder loops `while len(out) < size`, so it *always* returns exactly
`size` bytes unless it trips the terminator early. It will happily report
success on an LZW stream while emitting noise.

The fix is to also check **input consumption**: a correct codec finishes
having read essentially the whole payload. Wrong-codec runs overshoot or
stop far short. Accept a candidate only when

```
len(output) == decomp_size  and  |bytes_consumed - len(payload)| <= 4
```

With both halves in place the QFG2 ambiguity resolves cleanly and all
7,065 resources in this corpus round-trip.

### The bit SCI1 teaches you about SCI0

Worth knowing even though it is out of scope here. In SCI1.0 and SCI1.1
the method field stops meaning "codec" and starts meaning
"codec + post-processing":

```
SCI1.0   2 = LZW1          3 = LZW1 then un-shuffle a view    4 = ... a pic
SCI1.1  18 = DCL implode  19 = DCL  then un-shuffle a view   20 = ... a pic
```

Measured over KQ5, Longbow, KQ6CD and QFG3, method 3/19 occurs on view
resources and *nothing else*, and 4/20 on pics and nothing else. The
published spec lists 3 and 4 as "UNKNOWN-0" and "UNKNOWN-1"; that
type-correlation is what gives them away.

## 5. Resource types

`0 view · 1 pic · 2 script · 3 text · 4 sound · 5 memory · 6 vocab ·
7 font · 8 cursor · 9 patch`

Loose numbered files in the game directory (`0.FNT`, `999.SCR`) are
patches that override the packed copy; they carry a 2-byte header and are
never compressed.

## 6. View — the sprites

```
view   u16 loop_count, u16 mirror_mask, 4 unused, u16 loop_offset[]
loop   u16 cel_count, u16 unused, u16 cel_offset[]
cel    u16 w, u16 h, s8 x_shift, s8 y_shift, u8 transparent_colour, RLE...
```

RLE is one byte per run: `(length << 4) | ega_colour`.

**Gotcha:** the RLE is a *single flat stream over `w*h` pixels*. Runs cross
row boundaries freely. Decoding row-by-row and clamping each run to the
row width looks right on most cels and shears the rest. (I wrote that bug
first; the ScummVM EGA path makes it obvious — it is one `while
(pixelNr < pixelCount)` loop with no row concept at all.)

`mirror_mask` bit *L* means loop *L* is drawn flipped horizontally — that
is how a character gets left- and right-facing walk cycles from one set of
cels. `x_shift`/`y_shift` are the draw offsets that keep a sprite's feet
planted as its frames change size.

## 7. Pic — a program, not an image

A pic is a little vector program that paints **three 320×190 canvases at
once**:

* **visual** — what you see
* **priority** — 16 depth bands; the interpreter compares a sprite's band
  against this to decide whether the character walks in front of or behind
  scenery
* **control** — 16 invisible zones that scripts test against (walk-off
  edges, trigger areas)

That is why extracting a pic gives you three images, and why the priority
map is the interesting one if you want to understand a room's staging.

Opcodes are `0xF0`–`0xFE`, terminator `0xFF`, and every opcode consumes
arguments until the next byte `>= 0xF0` — so the argument lists are
self-terminating and you never need a length.

### Dithering

The visual plane does not store colours, it stores **pairs**. The palette
has 40 entries, each one byte holding two EGA colours (high nibble, low
nibble), painted as a chequerboard:

```
colour = (x ^ y) & 1  ?  pal >> 4  :  pal & 0x0F
```

16 hardware colours become ~136 apparent ones. `--undither` merges the
pair instead, which is the modern "remastered" look.

**Merging needs no pattern detection here** — the pair is stored
explicitly, so it is purely a blending choice. Blend in *linear light*,
not by averaging the stored bytes: `(c1+c2)/2` mixes gamma-encoded values
and comes out far too dark. Black + white should read as 186, not 127.
ScummVM ships the naive version commented out in favour of gamma-2.2, and
`ega._blend` follows it.

Sprites are the harder case, because a cel pixel is a single colour index
with no pair to recover. There you do need detection, and ScummVM's
`GfxView::unditherBitmap` is the de-facto standard: find runs of four
horizontally alternating pixels whose next row carries the reversed
combination, then only merge a combination if it occurs more than 5 times
in the cel *and* more than 200 times in the background pic. That
cross-check is the clever part — it merges only patterns the artist was
already using as dither, leaving deliberate checkerboard texture alone.

Implemented in `sci0/undither.py`, off by default
(`Scene(..., undither=True)`, or `scene --undither`). It is deliberately
conservative: across QFG2's 808 placed sprites it merges 53 cels, and
Iceman's 462 sprites 59 cels. Most SCI0 sprite art is flat-shaded, so
sprites with real dither are the exception. After merging, a cel pixel
holds a pair byte (>= 0x10) rather than a colour index, which is why the
replacement swaps nibbles when the high one is zero — it keeps merged
values out of the 0..15 range so the renderers can still tell them
apart.

Getting the parity backwards is invisible on solid colours and subtly
wrong everywhere else, so it is worth pinning down: ScummVM's `dither()`
does `color ^= color << 4` then `((x^y)&1) ? color >> 4 : color & 0x0F`,
and since the pic sits at screen y+10 (an even offset) the parity is the
same in pic space.

### The fiddly parts

* **Patterns** (brushes) come in 8 pen sizes, as rectangles or circles,
  optionally spattered with a 256-bit "random" texture. The texture table
  wraps with the 256th bit *dropped*, so the duplicated copy is offset by
  one; reproduce that or textured brushes drift out of alignment.
* **Rectangle brushes wrap off the right edge** onto the next row with the
  dither pair swapped. A genuine Sierra quirk, visible in SQ3's pics.
* **Flood fill** aborts rather than filling when the target pixel is not
  white (or the fill colour *is* white). This is load-bearing: pics rely on
  fills that deliberately do nothing. A "sensible" flood fill floods the
  whole screen.

### SCI01 adds two opcodes

QFG2 needs two extended opcodes the SCI0 games never emit, and without
them its pics stop after about six instructions and come out blank:

* `FE 07` — **embedded cel**: absolute coords, a `u16` byte count, then an
  8-byte cel header (`u16 w, u16 h`, two ignored bytes, `u8 transparent`,
  pad) and the same flat EGA RLE a view uses. Pics can paste sprite
  artwork straight into the background.
* `FE 08` — **priority band table**: 14 y-coordinates that redefine where
  the depth bands fall. Skipping the 14 bytes is what actually matters;
  the tool keeps them as `Picture.priority_bands`.

## 8. Script — the objects

This is where the game's actual content lives. A script is a flat list of
blocks, `u16 type, u16 size` (size includes the header), ending at type 0:

```
1 object   2 code    3 synonyms  4 said    5 strings
6 class    7 exports 8 reloc     9 preload 10 locals
```

An object or class body, with `base = block_offset + 4`:

```
base+0  u16 magic = 0x1234
base+2  u16 local-variable offset
base+4  u16 method-table offset, relative to block_offset + 10
base+6  u16 property_count
base+8  u16 property[property_count]
```

The first four properties are always `species`, `superClass`, `-info-`,
`name`. `-info-` bit `0x8000` marks a class. `name` is an absolute offset
into the script, pointing into a strings block.

A **class** then carries a parallel table of property *selector ids*;
an **instance** does not, because it borrows its layout from its species'
class. Resolving instance property names therefore means: `species` →
`vocab.996` → script number → find the class with that species → read its
selector table → `vocab.997` → names.

Then the method table, at `block_offset + 10 + method_offset`:

```
u16 method_count
u16 selector_id[method_count]
u16 0                          <- separator
u16 code_offset[method_count]
```

**Gotcha:** those are two parallel arrays, *not* interleaved
`(selector, offset)` pairs. Reading them as pairs still produces plausible
output for the first couple of methods, then quietly drifts into
nonsense selector ids — which is how I caught it (`sel643` in a game with
341 selectors).

Done right, SQ3 script 0 yields `ego`, `SQ3`, and the inventory:
*Glowing Gem, Wire, Ladder, Orat on a Stick, Buckazoids…*

### Early SCI0 differs twice

KQ4 (1988) is the oldest game here and breaks two assumptions:

1. **Its scripts start with one extra word** before the block list.
   `Script._pick_start` sniffs for it by parsing from both 0 and 2 and
   keeping whichever yields a clean chain of blocks.
2. **Its selector ids are doubled** — stored as byte offsets into the
   selector table rather than indices. Halve them before looking a name
   up, or every property after `species` is named one slot too far along
   and half the methods resolve to nothing.

Both quirks travel together, so the tool keys the selector shift off the
script-header detection. With them handled, KQ4 goes from 22 parsed
objects to 755, with 0 of 1,173 method selectors unresolved.

## 9. Vocab — the names

* `vocab.000` — parser words, alphabetical and prefix-compressed: a byte
  saying how many leading characters to reuse from the previous word, then
  the new characters with the high bit set on the last one, then 3 packed
  bytes of word-class and group. Words sharing a group are synonyms.
* `vocab.996` — species → defining script
* `vocab.997` — selector names (`x`, `y`, `view`, `loop`, `cel`, `doit`…)
* `vocab.999` — kernel function names

Without 997 an object dump is numbers; with it, it reads like source.

## 10. Bytecode — the PMachine

Everything above is data.  The rest of a game lives in compiled script
code, and reaching it needs a disassembler.

One "extended opcode" byte per instruction: `opcode = ext >> 1`, and bit 0
selects operand width — set means 1-byte operands, clear means 2-byte
little-endian.  Argument counts are the exception: always one byte.

The table only has to spell out `0x00`-`0x3F`, because `0x40`-`0x7F` is a
perfectly regular block — load / store / inc / dec crossed with global /
local / temp / param, each taking exactly one variable-index operand.

**Validating it without a reference table.** I could not find ScummVM's
`opcode_formats` as a fetchable file, so the table here was reconstructed
and then checked by self-consistency: disassemble every code block
linearly and see whether the sweep lands exactly on the block's last byte.
A single wrong operand width desynchronises and overshoots almost
immediately.  Result: **7,849 / 7,849 blocks clean across all eight
games** — the same probe-and-score approach that cracked the container.

### Two conventions you need before code is readable

* **`lofsa` / `lofss` are PC-relative.**  The target is
  `address_after_the_instruction + operand`, and the operand is signed.
  Read it as an absolute offset and you get nonsense like -1244.
* **An object pointer is `block + 12`** — the start of the property
  array, not the start of the block.  Verified at 152 of 177 references in
  one script; the remaining 25 point at strings and `said` blocks.

Note this is a *different* base from the method-table offset in §8, which
is relative to `block + 10`.  Both are correct; Sierra just used two
bases.

### Room transitions

`(someRoom newRoom: N)` compiles to `pushi <newRoom>`, `pushi 1`,
`pushi N`, load the target, `send 6` — so destinations are literals in the
instruction stream.  Walking them with a validated disassembler is safe;
scanning raw bytes for the same pattern would also match operand bytes
that happen to look like a push.

In QFG2 that recovers **117 transitions across 77 scripts**, with only 15
computed at run time.  The static `north`/`south`/`east`/`west` properties
alone yield 25.

## 11. Rooms — composing a scene

A room script declares its props as instances carrying static `view`,
`loop`, `cel`, `x`, `y`, `z` and `priority`, so a scene can be
reassembled from data alone.  Placement uses SCI's bottom-centre anchor:

```
left   = x + displaceX - (width >> 1)
bottom = y + displaceY - z + 1
```

`displaceX` is signed and negated on mirrored loops; **`displaceY` is
unsigned**.  A cel pixel is drawn only where its priority is at least the
pic's priority value there — that is what beds sprites into scenery
instead of pasting them on top.

### Three things that will bite

* **Property words are signed.**  Sprites are routinely parked at negative
  coordinates so they can slide in from off-screen.  Read `x`/`y`/`z`
  unsigned and they land at x=65529 instead of -7.
* **The priority band formula has no `+1`.**  The 14 band coordinates are
  the *starts* of bands 1..14, so `priority = count(bands <= y)`.  That is
  equivalent to the interpreter's
  `1 + ((y - top) * 2000) / (((bottom - top) * 2000) / 14)`, checked
  against it for every row y=0..189 with zero mismatches.  An off-by-one
  here is invisible on most sprites and quietly wrong on the rest.
* **Composite characters are several objects.**  Rakeesh is
  `rakeeshBody` + `rakeeshHead` + `rakeeshTail`; the object actually named
  `rakeesh` is a 1x1 placeholder that scripts talk to.  Drawing zero
  pixels is the correct outcome for it.

### Staging lives in `init`

Static properties say where the compiler left a prop.  The room's `init`
method is where it dresses the set, so `sci0/interp.py` walks that method
with a small abstract interpreter — tracking the accumulator and the send
stack, resolving object references, and decoding `send N` (N *bytes*, so
N/2 words of `selector, argc, args...` groups).  It applies `hide`/`show`,
`posn`/`x`/`y`/`z`, `view`/`loop`/`cel` and `setPri`.

Across QFG2's 92 rooms and 808 sprites: **19 hidden by init, 25
repositioned or restyled**, and 276 of 958 sends aimed at objects reached
through variables or the cast list, which are reported rather than
guessed at.

Without this, Katta's Tail Inn renders `shema` invisible by accident (the
pic's priority mask happens to cover her) when the real reason is that
init calls `(shema init: hide:)`; and the Adventurers' Guild is missing
Uhura entirely, because `uhuraBody` has no static position and is placed
at (218,118) by code.

### Anti-aliasing the result

`--aa` runs morphological anti-aliasing (MLAA, after Reshetov 2009) over
the composed room. It is not a blur and not a rescale: it finds the
staircases along colour discontinuities, reconstructs the straight edge
the steps approximate, and blends each pixel by how much of it that edge
actually covers. Axis-aligned edges have no staircase, so they are left
alone -- which is what keeps lettering and flat panels crisp.

Two things decide whether it looks good:

* **Undither first.** A chequerboard is discontinuous at every pixel, so
  dithered input gives the edge detector nothing coherent to latch onto.
  `--aa --undither` is the useful combination.
* **Anti-alias on an upscale, not at native resolution.** Running MLAA on
  the 320x190 image and then scaling the result up softens twice, and
  small detail like the `GWENGWENG` banner text smears. Upscaling
  nearest-neighbour first, anti-aliasing there, then resampling down
  keeps the text readable and still cleans up the diagonals.
  `--aa-super` sets that factor (default 2, so `--scale 3` anti-aliases
  at 6x).

MLAA has a ceiling worth knowing about: because it never moves an edge
more than a pixel, it softens a staircase but cannot make a jagged
diagonal genuinely *curved*.  Raising the supersample or dropping the
threshold does not change that -- the result plateaus.  Reconstructing
curves needs a different class of tool (an edge-directed scaler, or
tracing the art to vectors), and both of those buy smoothness by
guessing at shape: on art this detailed they round off lettering and
soften fine detail, which is a bad trade.

**The approximation, stated plainly:** conditional branches are flattened.
Every send in `init` is applied in address order, last write wins.  Real
staging often depends on run-time state — `rm100`'s init is full of
`if (day == 6)` — so there is no single correct static answer.

## 12. Room connectivity

`sci0/roomgraph.py` and `sci0/roomlinks.py` merge both sources of exits
into a graph.  Two warnings about what it does and does not mean:

* **`north`/`south`/`east`/`west` are not compass bearings.**  They name
  the screen edge you walk off.  Two rooms routinely both exit "south"
  into each other — you approach a building from the front and walk back
  out the front.  QFG2 has 8 such pairs, which is proof enough that the
  data cannot be laid out on a grid.
* **Over half the static exits point at dispatchers**, not places.  In
  QFG2, 36 of 66 lead to `desert` or `alleyRoom`, handler rooms that work
  out your real destination at run time.  `desert` has `picture = 0`.

Merged, QFG2 gives **111 links across 81 rooms**.  That is topology, not
geography: bearings come from which trigger polygon you crossed, which is
also code.

## 13. Modelling a parser game

`sci0/model.py` builds a per-room behavioural model: what the player can
do in each room, and what it changes.

```
python3 -m sci0 model <game-dir> -o out
```

The link between a parser command and its code is exact.  The compiler
emits `lofsa <said-spec>` then `callk Said`, so walking the disassembly
to a `Said` call and looking back for the pointer recovers the pattern
the handler answers to.  The body then runs to the next `Said` call or
`ret`, and every global that window reads or writes is recorded.

A said block is a run of patterns separated by `0xFF`, but it cannot be
scanned a byte at a time looking for one.  A byte below `0xF0` opens a
two-byte word group, and the low byte of a group may be anything at all
— `0xFF` included.  The wildcard `*` is group `0x0FFF`, so a scanner
that stops at the first `0xFF` it sees cuts every pattern using it in
half: the head keeps a dangling `0x0F` that reads as the nonexistent
group `0x0F00`, and the tail begins mid-pattern.  Stepping over the pair
is the whole fix, and it is worth 486 rejoined patterns across the eight
games — including the global handlers that answer "get <anything>".

On SQ3: **1,119 of 1,131 said specs linked to their handler, 2
unlinked** — and all 3,597 word groups decode against `vocab.000`, so
the commands come out readable:

```
room 11   rm11   picture 11
  > use , press/push , press/push / claw , button
      tests  global148 != 2; global148 != 3
      sets   global159 = 1
  > ascend/climb , jump / device/machine
      tests  global132 != 4; global132 != 5
```

### Three things that are per-game, not per-format

Running the same extractor over other games turned up three assumptions
that only held for SQ3.  All three are now detected rather than
hardcoded, and all three failed loudly (zero handlers, unreadable
commands) rather than quietly:

* **The message printer differs.**  SQ3, Camelot, LSL2 and Iceman print
  through `calle 255, 0`; QFG2 uses `calle 1, 13`.  `detect_printer`
  scores every `(script, export)` called with two integer arguments by
  how often those arguments name a real text resource and a line inside
  it, and takes the best.
* **`vocab.999` has two layouts.**  Most games store an offset table;
  QFG2 concatenates NUL-terminated names with no table, and parsing that
  as a table yields 511 empty entries plus one giant string -- which
  silently lost the `Said` kernel and produced *zero* handlers.  The
  detector must be proportional: one stray NUL in a trailing entry is
  normal, so requiring *no* NULs rejects perfectly good tables.
* **SCI01 keeps its parser words in `vocab.900`, not `vocab.000`**, with
  a 510-byte header instead of 52 and words terminated by a NUL rather
  than by the high bit on the last character.  The 3-byte class/group
  trailer is identical.  Without this, QFG2's commands render as
  `group1120 , group450` instead of `get , acquire/bring / soulforge`.

### Finding what a handler actually does

The first pass looked like a failure: 912 of 1,132 handler bodies
contained no sends and almost no kernel calls, as though the scan had
missed the code.  It had not -- the bodies were being read correctly,
but SQ3's workhorse is neither a send nor a kernel call:

```
callk Said
bnt   +30
lsg   132 / ldi 3 / eq? / bnt +11
push2 / pushi 11 / push0 / calle 255, 0, 4      <- print text.11 line 0
jmp   +259
push2 / pushi 11 / push1 / calle 255, 0, 4      <- else, line 1
```

`calle <script>, <export>, <argc>` calls an exported procedure, and
script 255 export 0 is this game's message printer, taking (text
resource, line).  Confirmed against the resources: `text.11[0]` is
"You are standing on a narrow rail..." and `[1]` is "You are riding
below a narrow rail..." -- exactly matching the `global132 == 3` branch.

Resolving that attaches the game's own response to each command:

```
  > use , press/push / claw , button
      tests  global148 != 2; global148 != 3; clunk.play (read)
      sets   global159 = 1; clunk.number = 74; clunk.loop = 1
      says   "You must stop the grabber before claw functions..."
      calls  clawScript.setScript(clawScript)
```

### What it is honestly good for

As a **reference** it is strong -- 704 of 936 commands carry the text
the game prints, traceable to a resource offset. As the input to an
automatic **solver** it is still thin:

| | count |
|---|---|
| commands in rooms | 936 |
| ...with the response text recovered | 704 |
| ...that test a global or property | 116 |
| ...that call a method (setScript etc.) | 66 |
| ...that set a global or property | 31 |
| ...that move you | 19 |
| ...with nothing recovered | 218 |
| rooms with a recovered exit | 62 of 84 |

Only 31 commands have a recorded effect -- because most parser patterns
are *responses*.  The puzzle state lives somewhere else.

### Following setScript into the state machines

A command like `clawScript.setScript(clawScript)` hands control to a
Script object, and that object's `changeState` method is where the
puzzle actually runs.  The compiler turns its `switch (state)` into a
chain of `dup / ldi N / eq? / bnt <next>`, so each state's body is
exactly the span from its `bnt` to that branch's target:

```
lap 1 / aTop 10        ; self.state = param
dup / ldi 0 / eq? / bnt +15
  <state 0 body>
jmp end
dup / ldi 1 / eq? / bnt +76
  <state 1 body>
```

SQ3 has **277 such machines, 1,584 states** -- and that is where the
effects were hiding:

| | commands | states |
|---|---|---|
| set a global or property | 31 | **933** |
| test something | 116 | 604 |
| call a method | 66 | 515 |
| move you to another room | 19 | 56 |

The loop closes.  Room 11's commands test `global132 != 4` and
`!= 5`; `grabScript` state 3 sets `global132 = 5` and state 6 sets it to
`4`; `clawScript` state 2 clears `global159` and moves the player to
room 8 or 7.  Condition and effect now meet.

### Across five games

| game | printer | commands | with text | machines | states | rooms w/ exit | **planner reach** |
|---|---|---|---|---|---|---|---|
| SQ3 | 255,0 | 936 | 704 | 277 | 1,584 | 76/84 | 39 (46%) |
| Camelot | 255,0 | 3,877 | 1,524 | 422 | 2,491 | 49/92 | 17 (18%) |
| QFG2 | **1,13** | 928 | 330 | 671 | 4,176 | 82/96 | 46 (48%) |
| LSL2 | 255,0 | 787 | 567 | 143 | 1,800 | 85/91 | 76 (84%) |
| **Iceman** | 255,0 | 1,624 | 981 | 409 | 2,220 | 76/90 | **78 (87%)** |

"Planner reach" is the honest figure: how much of the game the search
can actually justify visiting, walking only through transitions that
are not gated behind a parser command and typing only commands whose
conditions it can satisfy.  It is always far below the raw room graph,
because the raw graph counts typed transitions as if they were free.

Command extraction is stable across games; the *graph* is not.  Camelot
fragments into 23/16/9/5/4 plus 31 isolated rooms, because it uses **no**
cardinal exit properties at all (0 of 92, against SQ3's 29 of 84) and
joins its chapters with travel sequences.  Iceman is the opposite --
one 43-room region the planner can move through freely, which makes it
much the best solver target in this corpus.

### Cutscenes are actions too

The single largest gain came from noticing that the planner could not
leave Iceman's first room.  Room 1 has **no parser commands at all** --
its transition lives in a state machine that the room's own `init`
starts.  The planner only ran machines that a command handed to via
`setScript`, so every cutscene was invisible and whole acts of each game
were unreachable.

Offering each room's machines as actions in their own right moved every
game at once:

| | before | after |
|---|---|---|
| Iceman | 43 | **78 of 90** |
| LSL2 | 20 | **76 of 91** |
| QFG2 | 8 | 46 of 96 |
| SQ3 | 25 | 39 of 84 |
| Camelot | 14 | 17 of 92 |

This is optimistic: it assumes a machine can be triggered when the
player is in the room, which is true for cutscenes that fire on entry
and not necessarily true otherwise.  Plans mark those steps
`(name runs)` so a machine step is never mistaken for something typed.

With that in place the search produces an end-to-end route through
Iceman, from the opening to room 89 -- whose text resource holds the
Rear Admiral's closing speech:

```
  1. go to room 1
  2. in room 1    type: (dinghyScript runs)              -> room 44
  3. in room 44   type: (flyToHawaiiScript runs)         -> room 22
  4. in room 22   type: (messageLeavePearlScript runs)   -> room 23
  5. in room 23   type: ask/request / permission / board -> room 31
  ...
 22. in room 80   type: (driveAwayScript runs)           -> room 81
 23. in room 81   type: (shootOutScript runs)            -> room 88
 25. in room 90   type: (RoomScript runs)                -> room 89
```

25 steps, 394 states.  It is a *route*, not a verified walkthrough: it
threads the rooms, but it skips the puzzle steps whose preconditions the
model does not carry, so following it literally would not finish the
game.

Iceman also produces the most walkthrough-like output:

```
route: 15 steps
  1. in room 39   type: cease/stop , stand [ < up ]   -> room 32
  2. go to room 34
  ...
  5. in room 37   type: climb [ < up ]                -> room 38
  6. in room 38   type: get/grab , wear               -> room 50
```

### Is that enough to plan over?

| | |
|---|---|
| distinct globals tested | 48 |
| distinct globals written | 93 |
| tested *and* written | 32 (67% of tested) |
| rooms reachable via extracted transitions | 41 of 84 |

The 16 tested-but-never-written globals are mostly `global0`, `1`, `2`,
`5`, `9`, `11`-`13` -- SCI's system globals (ego, game object, score,
cast), maintained by the interpreter rather than by any script.  Their
absence is correct, not a gap, so the real closure is higher than 67%.

### Getting the rest of the room graph

Three sources of exit are needed, and missing any one of them silently
halves the graph:

1. **`newRoom` literals** anywhere in the script.
2. **The room's own `north`/`south`/`east`/`west` properties.**  29 of
   SQ3's 84 rooms carry these, and the call that uses them lives in the
   shared `Rm` base class, which passes the property as a *parameter* --
   so nothing at the call site is a literal and a bytecode-only scan
   never sees the destination.  Adding this source took rooms with a
   known exit from **62 to 76 of 84**, and the best reachable component
   from 33 to **52**.
3. **`newRoom` inside Said handlers and state machines.**

What is left really is dynamic.  76 call sites take a non-literal
argument, but 59 of them are `newRoom: param1` inside a room's *own*
`newRoom` override -- rooms hook the method to clean up, then
`super::newRoom(param)`.  Those are forwarding stubs, not destinations,
and counting them as unresolved overstates the problem.  The genuine
remainder is small: `newRoom: global13` (SCI's previous-room global, a
"go back" that has no static answer) and a handful fed by globals whose
literal assignments are not room numbers at all -- `global210` is only
ever assigned 1..8, which are indices, and treating them as rooms would
inject edges that do not exist.

Ten rooms have no inbound edge at all.  Searching for their numbers as
literals elsewhere does not help: 45, 50-54 and 81 are small integers
that appear in dozens of scripts as cels, loops and coordinates, so the
search returns noise rather than call sites.

Two traps worth naming, both of which produced wrong output first time:

* **Exits are not a parser-command property.** Taking a room's exits
  from the `newRoom` calls inside its Said handlers gave 8 of 84 rooms
  any exit at all, because most movement is triggered by walking off a
  screen edge in `doit`/`handleEvent`. Using every `newRoom` literal in
  the script raises that to 62.
* **A tested global is not a precondition.** The scan covers the whole
  handler body, so tests belonging to a nested branch get attributed to
  the command as a whole. The report says "tests", not "needs", for that
  reason.

## 14. Planning a route

`sci0/planner.py` searches the model for a way from one room to another.

```
python3 -m sci0 plan <game-dir> <start> <goal>
```

State is `(room, values of every global anything tests)` -- 11 of them
in SQ3, once you keep only globals that are both tested and written.
Actions are the parser commands a room handles: a command applies its
own effects plus those of any state machine it starts via `setScript`,
and may move the player.  Walking between connected rooms is free.

```
route: 3 steps, 14 states explored
  1. go to room 2
  2. go to room 14
  3. in room 14   type: / comp/computer      -> room 16
```

Commands whose conditions were never met are counted and reported, so
the search leaves a record of what it could not do and why.

### Two bugs that made it look better than it was

* **Walking must exclude typed transitions.**  `Room.exits` folds in the
  destinations of command handlers, so the first version let the planner
  walk through doors the game gates behind a command -- it "reached" 38
  rooms without ever typing anything.  Subtracting those back out is
  what makes the search mean something.
* **A step happens in the room you were in**, not the one you arrive at.
  The first output read `in room 16 type: ...` for a command typed in
  room 14 that moves you to 16.

### What it can honestly reach

Once commands are properly gated, the search reaches **20 of 84 rooms**
from the start, not 38.  That drop is the real measurement: many
movement commands test globals that nothing reachable ever sets, so the
search correctly refuses to assume them.

### Adding object properties, and why it does not help

The obvious next move is to track object state as well as globals.  It
is implemented -- property writes via `aTop`/`sTop` and via one-argument
sends, and property *conditions* typed properly, so a handler that tests
`bucket.cel == 3` records the comparison rather than a bare read.

Two fixes were needed to make the symbols line up at all:

* **Qualify `self`.**  `self.state` means a different object in every
  method, so recording it unqualified collapses every object's state
  into one symbol and nothing that is tested ever matches anything
  written.  Properties are named `clawScript.state`, not `self.state`.
* **Hold the loaded symbol until the comparison.**  Emitting the
  condition at the load discards the operator and value.

And the result is a flat no.  Tracked symbols go from 11 to **12**, and
the reachable set does not move: **20 rooms either way**.

The reason is visible once the tested properties are listed:

| | |
|---|---|
| property condition terms | 97 across 47 distinct properties |
| engine-maintained (`cel`, `loop`, `x`, `y`, `signal`, `prevSignal`) | 75 (**77%**) |
| script-authored candidates | 22 |
| properties both tested *and* written by a script | 5 |

`ladder.cel`, `Scott.x`, `badGuy.loop`, `doorSound.prevSignal` -- the
scripts are not consulting puzzle flags, they are asking *has the
animation reached frame N yet* and *has the sound finished*.  Those
values are produced by the interpreter's animation and sound cycle every
frame.  No amount of reading the bytecode will supply them.

### Where this actually stops

The binding constraint is not model coverage and not search quality.  It
is that SCI0 sequences its puzzles through the **`cue` cycle** -- a
script starts an animation, and the next state runs when the engine
reports the animation done.  That is the same thing that rules out a
stubbed headless VM: you cannot stub the animation cycle, because the
animation cycle *is* the control flow.

So the toolkit ends up with a clean division:

* **static extraction** answers "what can be done, where, and what does
  the game say" -- completely, and with every claim traceable
* **a full playthrough** needs the game executed, because the missing
  information does not exist until it runs

The planner is a working, honest partial solver: it reaches what it can
justify, refuses to assume the rest, and prints the exact commands it
was blocked on.

## 15. Layout

```
sci0/core.py       map, volume headers, patches, per-method codec probe
sci0/compress.py   LZW, COMP3, Huffman
sci0/view.py       sprites
sci0/pic.py        the vector machine + 3 planes
sci0/font.py       fonts and cursors
sci0/text.py       string tables
sci0/vocab.py      word lists and name tables
sci0/script.py     blocks, objects, classes, cross-script name resolution
sci0/disasm.py     PMachine disassembler
sci0/interp.py     abstract interpreter for room `init` staging
sci0/scene.py      composite a room's sprites onto its background
sci0/undither.py   optional dither-pair merging for view cels
sci0/aa.py         morphological anti-aliasing (MLAA)
sci0/roomgraph.py  exit properties, layout
sci0/roomlinks.py  newRoom() targets recovered from bytecode
sci0/model.py      per-room commands, conditions and effects
sci0/planner.py    state-space search over the extracted model
sci0/export.py     PNG/JSON/text writers
sci0/__main__.py   CLI
```

The CLI covers resource extraction only.  Sections 10-12 are library
work:

```python
from sci0 import Game
from sci0.script import Index
from sci0.scene import Scene

game  = Game('~/DOSGames/SIERRA/QFG2')
index = Index(game)                      # selector and kernel names

scene = Scene(game, index, 160)          # room script number
rgb   = scene.render()                   # 320x190 RGB, sprites composited
scene.placed, scene.skipped, scene.overrides

from sci0 import disasm, roomlinks
disasm.sweep(script.data, start, end)    # -> ([(pc, mnemonic, args)], ok)
roomlinks.build(game, index)             # -> {script: {destination rooms}}
```

Output of `extract`:

```
pic/NNN.png  NNN_priority.png  NNN_control.png
view/NNN/loopL_celC.png   view/NNN_sheet.png   view/views.json
font/NNN.png   cursor/NNN.png   text/NNN.txt
vocab/parser_words.txt  selectors.txt  kernel_names.txt  class_table.txt
script/NNN.json   script/objects.txt
```

## 16. Provenance

Container layouts, the compression-method/type correlation, the object and
method-table layouts, the early-SCI0 quirks, the opcode operand table, the
`lofsa` and object-pointer conventions, and the SCI1/SCI1.1/SCI2
comparison table were derived here by probing the games. The published
[SCI specifications](https://wiki.scummvm.org/index.php/SCI/Specifications)
supplied the pic opcode set, the Huffman node encoding and the font/cursor
layouts, and leave LZW and COMP3 as "WriteMe"/blank. The pic pattern
tables (circle brushes, texture bits, texture offsets) and the exact
flood-fill and dither semantics follow ScummVM's `engines/sci`, which is
GPL — the code here is an independent Python implementation, but if you
plan to redistribute it, check that provenance first.
