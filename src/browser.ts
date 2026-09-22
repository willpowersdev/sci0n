/**
 * SCI0 resource explorer.  The engine code is shared with the Node
 * tests; only the byte source and the rendering are browser-specific.
 * No game data ships with this -- the user points it at their own copy.
 */
import { Game, TYPE_NAMES, type ResourceSource } from './resources.ts';
import { View, type Cel } from './view.ts';
import { Picture, WIDTH, HEIGHT } from './pic.ts';
import { EGA_RGB, BLENDED_RGB, ditherPixel } from './ega.ts';
import { Script, Index, s16 } from './script.ts';
import { sweep, mnemonic } from './disasm.ts';
import { saidDecode, gameGroups, nameTable, stringTable, classTable,
         opcodes, suffixes, parserWords, parserWordsSci01,
         SELECTORS, KERNEL_NAMES, CLASS_TABLE, MAIN_VOCAB, MAIN_VOCAB_SCI01,
         SUFFIX_VOCAB, SUFFIX_VOCAB_SCI01 } from './vocab.ts';
import { strings as textStrings } from './text.ts';
import { Font, Cursor, CURSOR_SIZE, CURSOR_CLEAR } from './font.ts';
import { parseSound, detectHeaderSize, DEVICE_ADLIB } from './sound.ts';
import { parseBank, type Instrument } from './opl/patch.ts';
import { Player, resample, TICKS_PER_SECOND } from './opl/player.ts';
import { OPL_RATE } from './opl/opl2.ts';
import { encodeGIF, type Frame } from './gif.ts';
import { Scene } from './scene.ts';
import { picHistogram, unditherCel } from './undither.ts';
import * as RG from './roomgraph.ts';

const SCALE = 3, ASPECT = 1.2;
/**
 * Elements are looked up by id on every use, so anything that is read
 * back later has to survive the churn.  `#title` is permanent and lives
 * in `#bar`; the viewers rebuild `#controls` instead, because clearing
 * `#bar` would delete `#title` and the next lookup would return null.
 */
const $ = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};
const cv = $('cv') as HTMLCanvasElement;
const ctx = cv.getContext('2d')!;
const off = document.createElement('canvas');
const octx = off.getContext('2d')!;

let game: Game | null = null;
/** Selector and kernel names; built once per game, not per resource. */
let index: Index | null = null;
let groups: Map<number, string[]> | null = null;
/** AdLib instrument bank, read once per game. */
let bank: Instrument[] | null = null;
/** Which room scripts stage each picture, for the sprite overlay. */
let picToScript: Map<number, number[]> | null = null;
/** Pooled dither histogram of every background, built on first use. */
let picHist: Int32Array | null = null;
let showSprites = false;
let viewUndither = false;
let soundHeader = -1;
let audio: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;
let kind = 'pic';
let current: { type: number; num: number } | null = null;
let mode: 'visual' | 'undithered' | 'priority' | 'control' = 'visual';
let anim: number | null = null;
/** Preview frame time; the exported GIF uses the same. */
const ANIM_MS = 140;

/** A ResourceSource backed by the files the user selected. */
async function sourceFromFiles(files: FileList): Promise<ResourceSource> {
  const bytes = new Map<string, Uint8Array>();
  for (const f of Array.from(files)) {
    const name = f.name.toUpperCase();
    if (name === 'RESOURCE.MAP' || /^RESOURCE\.\d+$/.test(name))
      bytes.set(f.name, new Uint8Array(await f.arrayBuffer()));
  }
  return { names: () => [...bytes.keys()], read: (n) => bytes.get(n)! };
}

/**
 * A ResourceSource backed by the server's `/games/<name>/` route, so the
 * page can be opened directly at a game rather than picking a folder.
 */
async function sourceFromServer(name: string): Promise<ResourceSource> {
  const listing: string[] = await (await fetch(`/games/${name}/`)).json();
  const want = listing.filter(n =>
    /^RESOURCE\.(MAP|\d+)$/i.test(n));
  if (!want.length) throw new Error(`no SCI0 resources in ${name}`);
  const bytes = new Map<string, Uint8Array>();
  await Promise.all(want.map(async n => {
    const r = await fetch(`/games/${name}/${n}`);
    bytes.set(n, new Uint8Array(await r.arrayBuffer()));
  }));
  return { names: () => [...bytes.keys()], read: (n) => bytes.get(n)! };
}

function blit(rgb: Uint8Array, w: number, h: number, alpha?: Uint8Array) {
  off.width = w; off.height = h;
  const img = octx.createImageData(w, h);
  for (let i = 0, o = 0; i < w * h; i++) {
    img.data[o++] = rgb[i * 3]; img.data[o++] = rgb[i * 3 + 1];
    img.data[o++] = rgb[i * 3 + 2]; img.data[o++] = alpha ? alpha[i] : 255;
  }
  octx.putImageData(img, 0, 0);
  cv.width = w * SCALE; cv.height = Math.round(h * SCALE * ASPECT);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(off, 0, 0, cv.width, cv.height);
}

function planeRGB(plane: Uint8Array): Uint8Array {
  const out = new Uint8Array(plane.length * 3);
  for (let i = 0, o = 0; i < plane.length; i++) {
    const c = EGA_RGB[plane[i] & 0x0F];
    out[o++] = c[0]; out[o++] = c[1]; out[o++] = c[2];
  }
  return out;
}

function undithered(vis: Uint8Array): Uint8Array {
  const out = new Uint8Array(vis.length * 3);
  for (let i = 0, o = 0; i < vis.length; i++) {
    const c = BLENDED_RGB[vis[i]];
    out[o++] = c[0]; out[o++] = c[1]; out[o++] = c[2];
  }
  return out;
}

function stopAnim() { if (anim !== null) { clearInterval(anim); anim = null; } }

/**
 * Picture number -> every room script that stages it.
 *
 * Built once per game, and only when the sprite overlay is first asked
 * for, since it means parsing every script.  All candidates are kept
 * rather than the lowest-numbered one: several rooms routinely share a
 * background, and the first by number is often the one that places
 * nothing -- QFG2's picture 2 belongs to script 98, which stages no
 * props, and to script 822, which stages fifty-three.
 */
function scriptsForPicture(num: number): number[] {
  if (!picToScript) {
    picToScript = new Map();
    if (index) {
      for (const [scriptNo, room] of RG.collect(game!, index)) {
        if (room.picture === undefined || room.picture === 0 || room.picture === 0xFFFF) continue;
        const l = picToScript.get(room.picture);
        if (l) l.push(scriptNo); else picToScript.set(room.picture, [scriptNo]);
      }
      for (const l of picToScript.values()) l.sort((a, b) => a - b);
    }
  }
  return picToScript.get(num) ?? [];
}

/**
 * The staged room for a picture: the first candidate that places
 * anything.  The rendered buffer is carried along rather than rendered
 * again by the caller, which would cost a second composite for nothing.
 */
interface Staged { rgb: Uint8Array; placed: number; skipped: number; script: number }
function stageFor(num: number, undither: boolean): Staged | null {
  let fallback: Staged | null = null;
  for (const scriptNo of scriptsForPicture(num)) {
    try {
      const scene = new Scene(game!, index!, scriptNo, { undither });
      const rgb = scene.render();
      const got: Staged = { rgb, placed: scene.placed.length,
                            skipped: scene.skipped.length, script: scriptNo };
      if (got.placed) return got;
      fallback ??= got;
    } catch { /* not a room after all */ }
  }
  return fallback;
}

/**
 * How often each dither pair appears across the game's backgrounds.
 *
 * Cel undithering only merges a combination the *backgrounds* also
 * dithered with, which is what stops it eating deliberate chequerboard
 * texture on a sprite.  One picture is not enough evidence -- most games
 * merge nothing at all from a single histogram -- so this pools every
 * pic in the game, once, the first time it is needed.
 */
function backgroundHistogram(): Int32Array {
  if (picHist) return picHist;
  const hist = new Int32Array(256);
  for (const r of game!.byType('pic')) {
    try {
      const h = picHistogram(new Picture(game!.data(1, r.number)));
      for (let i = 0; i < 256; i++) hist[i] += h[i];
    } catch { /* a pic that will not decode contributes nothing */ }
  }
  picHist = hist;
  return hist;
}

/** A button that toggles a flag and redraws. */
function toggle(label: string, on: boolean, title: string, fn: () => void) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  if (on) b.style.borderColor = 'var(--accent)';
  b.onclick = fn;
  return b;
}

/** Hand the browser a file to save, and let go of the object URL after. */
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a') as HTMLAnchorElement;
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * A button that saves the canvas.
 *
 * The canvas already holds the picture at display scale with the 1.2
 * aspect correction applied, which is what makes SCI art look right on a
 * square-pixel screen -- so that is what gets written, rather than the
 * raw indexed buffer, and the file matches what is on screen.
 */
function pngButton(name: string) {
  const b = document.createElement('button');
  b.textContent = 'PNG';
  b.title = 'save this image as it appears, at display scale';
  b.onclick = () => {
    (cv as HTMLCanvasElement).toBlob(blob => { if (blob) download(`${name}.png`, blob); }, 'image/png');
  };
  return b;
}

const esc = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const hex = (n: number, w = 4) => n.toString(16).padStart(w, '0');

/** Swap the stage between the canvas and the text pane. */
function stageMode(text: boolean) {
  ($('cv') as HTMLElement).hidden = text;
  ($('text') as HTMLElement).hidden = !text;
  $('stage').className = text ? 'text' : '';
}

function showTextPane(html: string) {
  stopAnim();
  stageMode(true);
  $('text').innerHTML = html;
}

/**
 * A text resource is a string table: the game's messages in order.
 * Printing the index alongside each one matters, because that index is
 * what a script's `Print` call refers to.
 */
function showText(num: number) {
  const lines = textStrings(game!.data(3, num));
  // Long messages carry their own newlines; indent the continuations so
  // the index column stays readable.
  const body = lines.map((t, i) => {
    const tag = `<span class="c">${String(i).padStart(3)}</span>  `;
    if (!t) return tag + '<span class="c">·</span>';
    return tag + esc(t).split('\n').join('\n     ');
  }).join('\n');
  showTextPane(`<span class="h">text ${num}</span> <span class="c">· ${lines.length} strings</span>\n\n${body}\n`);
  $('controls').innerHTML = '';
  $('controls').insertAdjacentHTML('beforeend',
    `<span class="dim">text ${num} · ${lines.length} strings · ` +
    `${lines.reduce((a, t) => a + t.length, 0).toLocaleString()} chars</span>`);
}

/**
 * Where each run of code ends.
 *
 * A method's extent is not recorded anywhere -- the script only says
 * where things start.  The next start along is therefore the best
 * available end, which is why every method and export offset has to be
 * collected before any one of them can be disassembled.
 */
function codeBounds(sc: Script): number[] {
  const marks = new Set<number>();
  for (const o of sc.objects) for (const [, off] of o.methods) marks.add(off);
  for (const e of sc.exports) if (e > 0 && e < sc.data.length) marks.add(e);
  for (const [name, off, size] of sc.blocks)
    if (name === 'code') marks.add(off + size);
  marks.add(sc.data.length);
  return [...marks].sort((a, b) => a - b);
}

/**
 * Every glyph in a font, laid out on a grid.
 *
 * Cells are sized to the widest and tallest glyph so the grid stays
 * aligned, and each glyph sits at the cell's top-left -- proportional
 * fonts have glyphs of different widths, and centring them would hide
 * exactly the spacing a font viewer exists to show.
 */
function showFont(num: number) {
  stopAnim();
  stageMode(false);
  const f = new Font(game!.data(7, num));
  const cols = 16;
  const cw = Math.max(1, ...f.chars.map(c => c.width));
  const chh = Math.max(1, ...f.chars.map(c => c.height));
  const rows = Math.max(1, Math.ceil(f.chars.length / cols));
  const w = cols * (cw + 1) + 1, h = rows * (chh + 1) + 1;
  const rgb = new Uint8Array(w * h * 3);
  // A faint grid, so an empty cell is still visibly a cell.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x % (cw + 1) && y % (chh + 1)) continue;
    const o = (y * w + x) * 3;
    rgb[o] = 32; rgb[o + 1] = 32; rgb[o + 2] = 44;
  }
  f.chars.forEach((c, i) => {
    const ox = (i % cols) * (cw + 1) + 1, oy = Math.floor(i / cols) * (chh + 1) + 1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (!c.bits[y * c.width + x]) continue;
      const o = ((oy + y) * w + ox + x) * 3;
      rgb[o] = 235; rgb[o + 1] = 235; rgb[o + 2] = 245;
    }
  });
  blit(rgb, w, h);
  $('controls').innerHTML = '';
  $('controls').append(pngButton(`font${num}`));
  $('controls').insertAdjacentHTML('beforeend',
    `<span class="dim">font ${num} · ${f.chars.length} glyphs · line height ${f.lineHeight}` +
    ` · widest ${cw}px · tallest ${chh}px</span>`);
}

/**
 * A cursor, with its hotspot marked.
 *
 * The hotspot is the pixel the click actually lands on, so it is drawn
 * in as a red cross-hair: without it the image tells you what the cursor
 * looks like but not where it points.
 */
function showCursor(num: number) {
  stopAnim();
  stageMode(false);
  const c = new Cursor(game!.data(8, num));
  const N = CURSOR_SIZE;
  const rgb = new Uint8Array(N * N * 3);
  const alpha = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const v = c.pixels[i];
    if (v === CURSOR_CLEAR) continue;
    const col = EGA_RGB[v & 0x0F];
    rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
    alpha[i] = 255;
  }
  // The guide lines only tint pixels the cursor leaves transparent, so
  // marking the hotspot never paints over the art it is describing.
  const hx = c.hotspotX, hy = c.hotspotY;
  if (hx >= 0 && hx < N && hy >= 0 && hy < N) {
    const tint = (i: number, strong: boolean) => {
      if (!strong && alpha[i]) return;
      rgb[i * 3] = 255; rgb[i * 3 + 1] = 40; rgb[i * 3 + 2] = 40;
      alpha[i] = strong ? 255 : 80;
    };
    for (let x = 0; x < N; x++) tint(hy * N + x, false);
    for (let y = 0; y < N; y++) tint(y * N + hx, false);
    tint(hy * N + hx, true);
  }
  blit(rgb, N, N);
  const lit = [...c.pixels].filter(v => v !== CURSOR_CLEAR).length;
  $('controls').innerHTML = '';
  $('controls').append(pngButton(`cursor${num}`));
  $('controls').insertAdjacentHTML('beforeend',
    `<span class="dim">cursor ${num} · ${N}×${N} · hotspot ${hx},${hy} ` +
    `(marked red) · ${lit} opaque pixels</span>`);
}

function stopSound() {
  if (playing) { try { playing.stop(); } catch { /* already ended */ } playing = null; }
}

/**
 * A sound resource: what it contains, and the AdLib arrangement of it.
 *
 * Rendering runs the whole piece through the OPL2 engine before playing
 * a note of it.  At roughly thirty times real time that costs a moment
 * for a long track, but it keeps the synthesis off the audio thread,
 * where a late buffer is an audible glitch rather than a slow start.
 */
function showSound(num: number) {
  stopAnim();
  stopSound();
  stageMode(true);
  const d = game!.data(4, num);
  const s = parseSound(d, soundHeader >= 0 ? soundHeader : undefined);
  if (!s) {
    showTextPane(`<span class="h">sound ${num}</span> <span class="c">· ${d.length} bytes</span>\n\n` +
      `<span class="c">This is not an SCI0 sound stream.  SCI01 uses a multi-track\n` +
      `header that this decoder does not read.</span>\n`);
    $('controls').innerHTML = '';
    $('controls').insertAdjacentHTML('beforeend', `<span class="dim">sound ${num} · not SCI0</span>`);
    return;
  }
  const notes = s.events.filter(e => (e.status & 0xF0) === 0x90 && e.b > 0).length;
  const used = new Set(s.events.map(e => e.status & 0x0F));
  const out: string[] = [];
  out.push(`<span class="h">sound ${num}</span> <span class="c">· ${s.events.length.toLocaleString()} events · ` +
    `${(s.ticks / TICKS_PER_SECOND).toFixed(1)}s · ${notes.toLocaleString()} notes</span>`);
  out.push('');
  out.push('<span class="k">channels</span>  <span class="c">voices  devices        used</span>');
  for (let i = 0; i < s.channels.length; i++) {
    const c = s.channels[i];
    const dev = c.devices ? '0x' + c.devices.toString(16).padStart(2, '0') : '-';
    out.push(`   ${String(i).padStart(2)}      ${String(c.voices).padStart(5)}   ` +
      `${dev.padEnd(6)} ${(c.devices & DEVICE_ADLIB) ? '<span class="s">AdLib</span>' : '     '}` +
      `   ${used.has(i) ? 'yes' : '<span class="c">no</span>'}`);
  }
  if (s.digital)
    out.push(`\n<span class="k">digital</span>  <span class="c">${s.digital.length.toLocaleString()} bytes of sampled audio follow the music</span>`);
  out.push('');
  out.push('<span class="k">first events</span>');
  for (const e of s.events.slice(0, 24)) {
    const kind = ({ 0x80: 'noteOff', 0x90: 'noteOn', 0xB0: 'control', 0xC0: 'program', 0xE0: 'bend' } as Record<number, string>)[e.status & 0xF0]
      ?? '0x' + (e.status & 0xF0).toString(16);
    out.push(`   <span class="c">${String(e.tick).padStart(6)}</span>  ch ${String(e.status & 0x0F).padStart(2)}  ` +
      `${kind.padEnd(8)} ${String(e.a).padStart(3)} ${String(e.b).padStart(3)}`);
  }
  showTextPane(out.join('\n') + '\n');

  $('controls').innerHTML = '';
  const play = document.createElement('button');
  play.textContent = bank ? 'play' : 'no instrument bank';
  play.onclick = async () => {
    if (!bank) return;
    if (playing) { stopSound(); play.textContent = 'play'; return; }
    play.textContent = 'rendering…';
    audio ??= new AudioContext();
    await audio.resume();
    // Give the button a frame to repaint before the render blocks.
    await new Promise(r => setTimeout(r, 0));
    const p = new Player(s, bank);
    const secs = Math.min(120, p.duration);
    const pcm = resample(p.render(secs), OPL_RATE, audio.sampleRate);
    const b = audio.createBuffer(1, pcm.length, audio.sampleRate);
    b.copyToChannel(pcm, 0);
    const src = audio.createBufferSource();
    src.buffer = b;
    // Normalise to just under full scale.  A fixed gain clips the loud
    // passages of a busy track, which is heard as static rather than as
    // loudness.
    let pk = 0;
    for (const v of pcm) pk = Math.max(pk, Math.abs(v));
    const gain = audio.createGain();
    gain.gain.value = pk > 0 ? Math.min(6, 0.89 / pk) : 1;
    src.connect(gain).connect(audio.destination);
    src.onended = () => { if (playing === src) { playing = null; play.textContent = 'play'; } };
    src.start();
    playing = src;
    play.textContent = 'stop';
  };
  $('controls').append(play);
  $('controls').insertAdjacentHTML('beforeend',
    `<span class="dim">sound ${num} · ${(s.ticks / TICKS_PER_SECOND).toFixed(1)}s · ` +
    `${notes.toLocaleString()} notes · ${s.channels.length} channels` +
    `${s.digital ? ' · has a digital sample' : ''}</span>`);
}

/** 16 bytes per line, hex and printable gutter. */
function hexDump(d: Uint8Array, limit = 4096): string {
  const rows: string[] = [];
  const n = Math.min(d.length, limit);
  for (let o = 0; o < n; o += 16) {
    const row = d.subarray(o, o + 16);
    const h = Array.from(row, b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const a = Array.from(row, b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    rows.push(`<span class="c">${hex(o)}</span>  ${h}  <span class="s">${esc(a)}</span>`);
  }
  if (d.length > n) rows.push(`<span class="c">… ${(d.length - n).toLocaleString()} more bytes</span>`);
  return rows.join('\n');
}

const WORD_CLASS: Array<[number, string]> = [
  [0x001, 'number'], [0x002, 'noun'], [0x004, 'adjective'], [0x008, 'verb'],
  [0x010, 'preposition'], [0x020, 'article'], [0x040, 'pronoun'],
  [0x080, 'conjunction'], [0x100, 'special'],
];
const classBits = (m: number) =>
  WORD_CLASS.filter(([b]) => m & b).map(([, n]) => n).join('|') || `0x${m.toString(16)}`;

/**
 * Vocab resources, each of which is a different format.
 *
 * The number decides the decoder: the word list, the suffix rules, the
 * class table, the selector and kernel name tables and the interpreter's
 * own opcode table all live here under fixed numbers.  Anything without
 * a decoder is shown as bytes rather than guessed at -- a wrong reading
 * presented confidently is worse than an honest hex dump.
 */
function showVocab(num: number) {
  const d = game!.data(6, num);
  const out: string[] = [];
  const head = (what: string, n?: number, unit?: string) =>
    out.push(`<span class="h">vocab ${num}</span> <span class="c">· ${what}` +
             (unit ? ` · ${n!.toLocaleString()} ${unit}` : '') +
             ` · ${d.length.toLocaleString()} bytes</span>`, '');
  let summary = `${d.length.toLocaleString()} bytes`;

  if (num === MAIN_VOCAB || num === MAIN_VOCAB_SCI01) {
    const words = num === MAIN_VOCAB ? parserWords(d) : parserWordsSci01(d);
    head('parser words', words.length, 'words');
    const byGroup = new Map<number, string[]>();
    for (const [w, , grp] of words) {
      const l = byGroup.get(grp); if (l) l.push(w); else byGroup.set(grp, [w]);
    }
    out.push(`<span class="c">${byGroup.size.toLocaleString()} word groups; synonyms share a group</span>`, '');
    for (const [w, cls, grp] of words)
      out.push(`  <span class="s">${esc(w.padEnd(22))}</span>` +
               `<span class="c">group ${String(grp).padStart(5)}  ${esc(classBits(cls))}</span>`);
    summary = `${words.length} words · ${byGroup.size} groups`;

  } else if (num === SUFFIX_VOCAB || num === SUFFIX_VOCAB_SCI01) {
    const suf = suffixes(d);
    if (suf.length >= 4 && suf.every(e => e.pattern)) {
      head('suffix rules', suf.length, 'rules');
      out.push('  <span class="c">pattern            replacement        in       out</span>');
      for (const e of suf)
        out.push(`  <span class="s">${esc(e.pattern.padEnd(18))}${esc(e.replacement.padEnd(18))}</span>` +
                 `<span class="c">0x${e.inClass.toString(16).padStart(4,'0')}   0x${e.outClass.toString(16).padStart(4,'0')}</span>`);
      summary = `${suf.length} suffix rules`;
    } else {
      // SCI01 repurposes 901; without a decoder, show the bytes.
      head('no decoder for this layout');
      out.push(hexDump(d));
    }

  } else if (num === CLASS_TABLE) {
    const t = classTable(d);
    head('class table', t.size, 'species');
    for (const [species, script] of t)
      out.push(`  <span class="c">species</span> ${String(species).padStart(4)}` +
               `  <span class="c">-> script</span> ${String(script).padStart(4)}` +
               `  ${esc(index?.classForSpecies(species)?.name ?? '')}`);
    summary = `${t.size} species`;

  } else if (num === SELECTORS || num === KERNEL_NAMES) {
    const names = nameTable(d);
    head(num === SELECTORS ? 'selector names' : 'kernel names', names.length, 'entries');
    for (let i = 0; i < names.length; i++)
      out.push(`  <span class="c">${String(i).padStart(4)}</span>  <span class="s">${esc(names[i])}</span>`);
    summary = `${names.length} names`;

  } else if (num === 998) {
    const ops = opcodes(d);
    head("the interpreter's own opcode table", ops.length, 'entries');
    for (let i = 0; i < ops.length; i++) {
      const mine = i < 0x40 ? mnemonic(i) : null;
      const agree = i >= 0x40 || ops[i].name === (mine ?? '');
      out.push(`  <span class="c">0x${i.toString(16).padStart(2, '0')}</span>  ` +
               `<span class="s">${esc((ops[i].name || '-').padEnd(12))}</span>` +
               `<span class="c">type ${ops[i].type}${i < 0x40 && !agree ? `  DISAGREES with "${mine}"` : ''}</span>`);
    }
    summary = `${ops.length} opcodes`;

  } else {
    const st = stringTable(d);
    const printable = st.filter(t => t && ![...t].some(c => {
      const v = c.charCodeAt(0); return v < 9 || (v > 13 && v < 32);
    })).length;
    if (st.length && printable >= st.length * 0.6) {
      head('string table (no dedicated decoder)', st.length, 'strings');
      st.forEach((t, i) => out.push(
        `  <span class="c">${String(i).padStart(4)}</span>  <span class="s">${esc(t)}</span>`));
      summary = `${st.length} strings`;
    } else {
      head('no decoder for this resource');
      out.push(hexDump(d));
    }
  }

  showTextPane(out.join('\n') + '\n');
  $('controls').innerHTML = '';
  $('controls').insertAdjacentHTML('beforeend', `<span class="dim">vocab ${num} · ${summary}</span>`);
}

/** Instructions that push exactly one value and nothing else. */
const FIXED_PUSH = new Set(['push', 'pushi', 'push0', 'push1', 'push2',
                            'pushSelf', 'pprev', 'dup', 'lofss',
                            'pTos', 'ipTos', 'dpTos']);
/** A variable opcode pushes when it loads (l/+/-) to the stack (s). */
const varPushes = (n: string) => n.length >= 2 && n[1] === 's' && 'l+-'.includes(n[0]);
const pushesOne = (n: string) => FIXED_PUSH.has(n) || varPushes(n);
/** Ops with no effect on the value stack, so a scan may step over them. */
const stackNeutral = (n: string) =>
  ['ldi', 'lofsa', 'class', 'lea', 'selfID', 'bnot', 'not', 'neg'].includes(n) ||
  (n.length >= 2 && n[1] === 'a' && 'l+-'.includes(n[0]));
/** The literal a push puts on the stack, or null if it is not a literal. */
function literal(i: { name: string; args: number[] }): number | null {
  if (i.name === 'pushi') return i.args[0];
  if (i.name === 'push0') return 0;
  if (i.name === 'push1') return 1;
  if (i.name === 'push2') return 2;
  return null;
}

/**
 * Which `pushi` instructions are actually selectors.
 *
 * Annotating every `pushi` whose value happens to name a selector is
 * wrong: `pushi 778` is a view number and `pushi 300` an argument, yet
 * both resolve to plausible names.  A send says how many words it takes,
 * so walking back over the pushes that feed it recovers the real
 * (selector, argc, args...) groups.  Anything that makes the walk
 * uncertain -- a pop, a variable-width push, a branch landing in the
 * middle -- abandons that send rather than guessing.
 */
function selectorPushes(ins: Array<{ pc: number; name: string; args: number[] }>): Set<number> {
  const marked = new Set<number>();
  const targets = new Set<number>();
  for (let n = 0; n < ins.length; n++) {
    const i = ins[n];
    if (/^(bt|bnt|jmp)$/.test(i.name) && ins[n + 1])
      targets.add(ins[n + 1].pc + i.args[0]);
  }
  for (let n = 0; n < ins.length; n++) {
    const i = ins[n];
    if (!/^(send|self|super)$/.test(i.name)) continue;
    const words = (i.args[i.args.length - 1] ?? 0) >> 1;
    if (words <= 0) continue;
    const run: number[] = [];
    let k = n - 1;
    for (; k >= 0 && run.length < words; k--) {
      const p = ins[k];
      if (pushesOne(p.name)) run.unshift(k);
      else if (!stackNeutral(p.name)) break;         // a pop, or unknown
      // A branch landing on the first instruction of the run is simply
      // where the run starts; one landing inside it joins two different
      // stack states, so only that case is unsafe.
      if (run.length < words && targets.has(p.pc)) break;
    }
    if (run.length !== words) continue;
    for (let g = 0; g + 1 < run.length;) {
      const sel = literal(ins[run[g]]);
      const argc = literal(ins[run[g + 1]]);
      if (sel === null || argc === null || argc < 0) break;
      if (ins[run[g]].name === 'pushi') marked.add(run[g]);
      g += 2 + argc;
    }
  }
  return marked;
}

function disasmAt(sc: Script, start: number, bounds: number[], idx: Index | null): string {
  const end = bounds.find(b => b > start) ?? sc.data.length;
  const [ins, clean] = sweep(sc.data, start, Math.min(end, sc.data.length));
  const sels = selectorPushes(ins);
  const lines = ins.map((i, n) => {
    // A jump's operand is relative to the *next* instruction, so the
    // following entry's pc is what makes the target readable.
    const after = ins[n + 1]?.pc;
    let note = '';
    if (i.name === 'callk' && idx)
      note = `; ${idx.kernelName(i.args[0])}`;
    else if (/^(bt|bnt|jmp)$/.test(i.name) && after !== undefined)
      note = `; -> ${hex(after + i.args[0])}`;
    else if (/^(lofsa|lofss)$/.test(i.name) && after !== undefined)
      note = `; @${hex(after + i.args[0])}`;
    else if (i.name === 'pushi' && idx && sels.has(n)) {
      const sel = idx.selectorName(i.args[0] << idx.selectorShift);
      if (!sel.startsWith('sel')) note = `; ${sel}`;
    }
    return `      <span class="c">${hex(i.pc)}</span>  ${esc(i.name.padEnd(7))} ` +
           `${esc(i.args.join(', ').padEnd(10))}` +
           (note ? `<span class="c">${esc(note)}</span>` : '');
  });
  if (!clean) lines.push('      <span class="c">… decode stopped early</span>');
  return lines.join('\n');
}

/**
 * The structure of a compiled script: its blocks, its exports, and every
 * object with its properties and disassembled methods.  This is the same
 * view the Node tooling produces, so what the page shows and what the
 * tests compare against stay the same thing.
 */
function showScript(num: number) {
  const sc = new Script(game!.data(2, num), num);
  const idx = index;
  const bounds = codeBounds(sc);
  const out: string[] = [];
  out.push(`<span class="h">script ${num}</span> <span class="c">· ${sc.data.length.toLocaleString()} bytes` +
           `${sc.start ? ' · 2-byte prefix' : ''}</span>`);
  out.push('');
  out.push(`<span class="k">blocks</span>   ` +
    sc.blocks.map(([n, o, sz]) => `${esc(n)}@${hex(o)}+${sz}`).join('  '));
  if (sc.exports.length)
    out.push(`<span class="k">exports</span>  ` +
      sc.exports.map((e, i) => `${i}:${hex(e)}`).join('  '));
  if (sc.locals.length)
    out.push(`<span class="k">locals</span>   ${sc.locals.length} · ` +
      sc.locals.slice(0, 24).map(v => String(s16(v))).join(' ') +
      (sc.locals.length > 24 ? ' …' : ''));

  if (sc.said.length && groups) {
    out.push('');
    out.push(`<span class="k">said</span>`);
    for (const [off, spec] of sc.said)
      out.push(`   <span class="c">${hex(off)}</span>  <span class="s">${esc(saidDecode(spec, groups))}</span>`);
  }
  if (sc.strings.size) {
    out.push('');
    out.push(`<span class="k">strings</span>`);
    for (const [off, t] of sc.strings)
      out.push(`   <span class="c">${hex(off)}</span>  <span class="s">"${esc(t)}"</span>`);
  }

  for (const o of sc.objects) {
    out.push('');
    out.push(`<span class="k">${o.isClass ? 'class' : 'instance'}</span> <b>${esc(o.name)}</b>` +
      ` <span class="c">@${hex(o.offset)} · species ${o.species} · super ${o.superclass}` +
      `${idx && o.species !== null ? ' ' + esc(idx.classForSpecies(o.species)?.name ?? '') : ''}</span>`);
    const names = o.propertyNames(idx);
    out.push(`  <span class="c">properties (${o.propCount})</span>`);
    for (let i = 0; i < o.propCount; i++) {
      const v = o.properties[i];
      out.push(`    ${esc((names[i] ?? `prop${i}`).padEnd(16))}` +
               `${String(s16(v)).padStart(7)}  <span class="c">0x${hex(v)}</span>`);
    }
    if (!o.methods.length) continue;
    out.push(`  <span class="c">methods (${o.methods.length})</span>`);
    for (const [sel, off] of o.methods) {
      out.push(`    <b>${esc(idx ? idx.selectorName(sel) : String(sel))}</b>` +
               ` <span class="c">@${hex(off)}</span>`);
      out.push(disasmAt(sc, off, bounds, idx));
    }
  }
  showTextPane(out.join('\n') + '\n');
  $('controls').innerHTML = '';
  $('controls').insertAdjacentHTML('beforeend',
    `<span class="dim">script ${num} · ${sc.objects.length} objects · ` +
    `${sc.objects.reduce((a, o) => a + o.methods.length, 0)} methods · ` +
    `${sc.exports.length} exports · ${sc.said.length} said</span>`);
}

function showPic(num: number) {
  stopAnim();
  stageMode(false);
  const p = new Picture(game!.data(1, num));
  const flat = mode === 'visual' || mode === 'undithered';
  let rgb: Uint8Array;
  let staged: { placed: number; skipped: number; script: number } | null = null;
  // Sprites only mean anything over the visual planes; priority and
  // control are the data that decides where sprites go, not a picture to
  // put them on.
  const stage = showSprites && flat ? stageFor(num, mode === 'undithered') : null;
  if (stage) {
    rgb = stage.rgb;
    staged = { placed: stage.placed, skipped: stage.skipped, script: stage.script };
  } else {
    rgb = mode === 'priority' ? planeRGB(p.priority)
        : mode === 'control' ? planeRGB(p.control)
        : mode === 'undithered' ? undithered(p.visual)
        : p.visualRGB();
  }
  blit(rgb, WIDTH, HEIGHT);
  $('controls').innerHTML = '';
  for (const m of ['visual', 'undithered', 'priority', 'control'] as const) {
    const b = document.createElement('button');
    b.textContent = m; b.onclick = () => { mode = m; showPic(num); };
    if (m === mode) b.style.borderColor = 'var(--accent)';
    $('controls').append(b);
  }
  if (flat) {
    const rooms = scriptsForPicture(num);
    $('controls').append(toggle('sprites', showSprites,
      rooms.length ? `composite the props staged by script ${rooms.join(' or ')}`
                   : 'no room script stages this picture',
      () => { showSprites = !showSprites; showPic(num); }));
  }
  $('controls').append(pngButton(`pic${num}_${mode}${staged ? '_scene' : ''}`));
  const bands = p.priorityBands ? ` · bands ${p.priorityBands.join(',')}` : '';
  const note = staged
    ? ` · script ${staged.script}: ${staged.placed} sprites placed` +
      (staged.skipped ? `, ${staged.skipped} skipped` : '')
    : (showSprites && flat ? ' · no room stages this picture' : '');
  $('controls').insertAdjacentHTML('beforeend',
    `<span class="dim">pic ${num} · ${p.ops} opcodes · ${WIDTH}×${HEIGHT}${bands}${note}</span>`);
}

/**
 * Lay a loop's cels out in one frame, aligned by their displacements.
 *
 * Cels in a loop are different sizes and carry their own displacement,
 * so packing each into its own bounding box makes a walk cycle jitter.
 * Placing them the way the engine does -- (x, y) is the bottom centre,
 * displaceX signed and negated when the loop is mirrored, displaceY
 * unsigned -- and taking the union of the results keeps the sprite
 * registered against itself across the whole loop.
 */
function loopFrames(cels: Cel[], delayCs: number):
    { width: number; height: number; frames: Frame[]; key: number } | null {
  if (!cels.length) return null;
  const place = (c: Cel) => {
    const dx = c.mirrored ? -c.xShift : c.xShift;
    const dy = c.yShift >= 0 ? c.yShift : c.yShift + 256;
    const left = dx - (c.width >> 1);
    const bottom = dy + 1;
    return { left, top: bottom - c.height };
  };
  const boxes = cels.map(place);
  const x0 = Math.min(...boxes.map(b => b.left));
  const y0 = Math.min(...boxes.map(b => b.top));
  const x1 = Math.max(...cels.map((c, i) => boxes[i].left + c.width));
  const y1 = Math.max(...cels.map((c, i) => boxes[i].top + c.height));
  const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
  // One transparent index for the whole file, clear of the 16 colours.
  const key = 16;
  const frames: Frame[] = cels.map((c, i) => {
    const px = new Uint8Array(width * height).fill(key);
    const ox = boxes[i].left - x0, oy = boxes[i].top - y0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const v = c.pixels[y * c.width + x];
        if (v === c.key) continue;
        px[(oy + y) * width + ox + x] = v & 0x0F;
      }
    }
    return { pixels: px, delayCs, transparent: key };
  });
  return { width, height, frames, key };
}

function showView(num: number) {
  stopAnim();
  stageMode(false);
  const v = new View(game!.data(0, num));
  // Undithering rewrites cel pixels in place, so it is applied once to
  // this freshly decoded View rather than on every redraw -- a merged
  // pixel holds a pair byte, and running the detector over its own
  // output again would be reading something it did not produce.
  let merged = 0;
  if (viewUndither) {
    const hist = backgroundHistogram();
    for (const l of v.loops) for (const c of l) merged += unditherCel(c, hist);
  }
  let loop = 0, frame = 0;
  const draw = () => {
    const cels = v.loops[loop] ?? [];
    if (!cels.length) return;
    const c = cels[frame % cels.length];
    const rgb = new Uint8Array(c.width * c.height * 3);
    const alpha = new Uint8Array(c.width * c.height);
    for (let i = 0; i < c.width * c.height; i++) {
      const px = c.pixels[i];
      if (px === c.key) continue;
      // Undithering leaves a colour *pair* behind (>= 0x10), which is
      // blended, while a plain index is one of the sixteen.
      const col = px < 16 ? EGA_RGB[px] : BLENDED_RGB[px];
      rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
      alpha[i] = 255;
    }
    blit(rgb, c.width, c.height, alpha);
  };
  $('controls').innerHTML = '';
  const sel = document.createElement('select');
  v.loops.forEach((l, i) => sel.add(new Option(`loop ${i} (${l.length} cels)`, String(i))));
  sel.onchange = () => { loop = +sel.value; frame = 0; draw(); };
  const play = document.createElement('button');
  play.textContent = 'play';
  play.onclick = () => {
    if (anim !== null) { stopAnim(); play.textContent = 'play'; return; }
    play.textContent = 'stop';
    anim = window.setInterval(() => { frame++; draw(); }, ANIM_MS);
  };
  const gif = document.createElement('button');
  gif.textContent = 'GIF';
  gif.title = 'save this loop as an animated GIF at native size';
  gif.onclick = () => {
    const cels = v.loops[loop] ?? [];
    const laid = loopFrames(cels, Math.round(ANIM_MS / 10));
    if (!laid) return;
    // 17 entries: the sixteen EGA colours plus one transparent slot.
    const palette = [...EGA_RGB, [0, 0, 0] as [number, number, number]];
    const bytes = encodeGIF({ width: laid.width, height: laid.height,
                              palette, frames: laid.frames });
    download(`view${num}_loop${loop}.gif`,
             new Blob([bytes as BlobPart], { type: 'image/gif' }));
  };
  const und = toggle('undither', viewUndither,
    'merge dither pairs the game\'s backgrounds also use',
    () => { viewUndither = !viewUndither; showView(num); });
  $('controls').append(sel, play, und, pngButton(`view${num}_loop${loop}_cel${frame}`), gif);
  const mnote = viewUndither ? ` · ${merged} combinations merged` : '';
  $('controls').insertAdjacentHTML('beforeend',
    `<span class="dim">view ${num} · ${v.loops.length} loops · ` +
    `mirror 0x${v.mirrorMask.toString(16)}${mnote}</span>`);
  draw();
}

function render() {
  const list = $('list'); list.innerHTML = '';
  if (!game) return;
  const rev = Object.entries(TYPE_NAMES).find(([, n]) => n === kind)?.[0];
  const rows = [...game.resources.values()]
    .filter(r => String(r.type) === rev).sort((a, b) => a.number - b.number);
  for (const r of rows) {
    const d = document.createElement('div');
    d.className = 'row' + (current && current.type === r.type && current.num === r.number ? ' on' : '');
    d.textContent = `${kind} ${r.number}`;
    d.onclick = () => {
      stopSound();
      current = { type: r.type, num: r.number };
      $('title').textContent = `${kind} ${r.number}`;
      try {
        kind === 'pic' ? showPic(r.number)
        : kind === 'view' ? showView(r.number)
        : kind === 'script' ? showScript(r.number)
        : kind === 'text' ? showText(r.number)
        : kind === 'vocab' ? showVocab(r.number)
        : kind === 'font' ? showFont(r.number)
        : kind === 'cursor' ? showCursor(r.number)
        : kind === 'sound' ? showSound(r.number)
        : notVisual();
      }
      catch (e: any) { $('controls').innerHTML = `<span class="dim">decode failed: ${e.message}</span>`; }
      render();
    };
    list.append(d);
  }
}

function notVisual() {
  stopAnim();
  stageMode(false);
  $('controls').innerHTML = '<span class="dim">no viewer for this type yet</span>';
  blit(new Uint8Array(WIDTH * HEIGHT * 3), WIDTH, HEIGHT);
}

function buildTabs() {
  const tabs = $('tabs'); tabs.innerHTML = '';
  const present = new Set([...game!.resources.values()].map(r => TYPE_NAMES[r.type]));
  for (const t of ['pic', 'view', 'script', 'text', 'font', 'cursor', 'sound', 'vocab']) {
    if (!present.has(t)) continue;
    const d = document.createElement('div');
    d.className = 'tab' + (t === kind ? ' on' : '');
    d.textContent = t;
    d.onclick = () => { kind = t; buildTabs(); render(); };
    tabs.append(d);
  }
}

/** Describe what was loaded, and show the first tab. */
function adopt(g: Game) {
  game = g;
  index = new Index(g);
  try { groups = gameGroups(g); } catch { groups = null; }
  // The bank and the header size are game-wide facts, so they are read
  // once here rather than per resource -- the header in particular
  // cannot be decided from a single sound (see detectHeaderSize).
  try { bank = parseBank(g.data(9, 3)); } catch { bank = null; }
  picToScript = null; picHist = null;
  try {
    soundHeader = detectHeaderSize([...g.byType('sound')].map(r => g.data(4, r.number)));
  } catch { soundHeader = -1; }
  const counts: Record<string, number> = {};
  for (const r of game.resources.values()) {
    const n = TYPE_NAMES[r.type] ?? String(r.type);
    counts[n] = (counts[n] ?? 0) + 1;
  }
  $('gameinfo').textContent =
    `${game.resources.size} resources · ` +
    Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${v} ${k}`).join(', ');
  buildTabs(); render();
}

($('pick') as HTMLInputElement).onchange = async (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (!files?.length) return;
  try {
    game = new Game(await sourceFromFiles(files));
  } catch (err: any) {
    $('gameinfo').textContent = 'not an SCI0 game folder: ' + err.message;
    return;
  }
  adopt(game);
};

// `/?game=NAME` loads straight from the server; `/?game=` lists what is there.
(async () => {
  const q = new URLSearchParams(location.search);
  if (!q.has('game')) return;
  const name = q.get('game') ?? '';
  try {
    if (!name) {
      const all: string[] = await (await fetch('/games/')).json();
      $('gameinfo').innerHTML = 'available: ' + all.map(n =>
        `<a href="?game=${encodeURIComponent(n)}" style="color:var(--accent)">${n}</a>`).join(' · ');
      return;
    }
    $('gameinfo').textContent = `loading ${name}…`;
    adopt(new Game(await sourceFromServer(name)));
    document.title = `SCI0 Explorer — ${name}`;
  } catch (err: any) {
    $('gameinfo').textContent = `could not load ${name}: ${err.message}`;
  }
})();
