/**
 * Differential test for font and cursor resources.
 *
 * The digest covers every glyph's dimensions and every pixel, and every
 * cursor's hotspot and 16x16 plane, so a swapped width/height (the char
 * header stores height first) or an inverted mask bit shows up rather
 * than merely looking odd on screen.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Font, Cursor, CURSOR_CLEAR } from '../src/font.ts';

import { ROOT } from './games.ts';
const fx = JSON.parse(readFileSync('fixtures/font.json', 'utf8'));

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}
const le16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF); return b; };

/**
 * A glyph's bytes must end where the next glyph begins.
 *
 * This is the check that does not depend on the reference: it caught the
 * width/height fields being read in the wrong order, which both
 * implementations got wrong together and so the digests agreed on.
 */
function overruns(f: Font): number {
  const bounds = [...new Set(f.offsets)].sort((a, b) => a - b);
  const next = new Map<number, number>();
  bounds.forEach((o, i) => { if (i + 1 < bounds.length) next.set(o, bounds[i + 1]); });
  let n = 0;
  f.offsets.forEach((o, i) => {
    const end = next.get(o);
    if (end === undefined) return;
    const c = f.chars[i];
    if (o + 2 + ((c.width + 7) >> 3) * c.height > end) n++;
  });
  return n;
}

let bad = 0, totalFonts = 0, totalGlyphs = 0, totalCursors = 0, totalOverrun = 0;
for (const name of Object.keys(fx).sort()) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const want = fx[name];

  const fh = createHash('sha1');
  let fonts = 0, glyphs = 0;
  for (const r of [...g.byType('font')].sort((a, b) => a.number - b.number)) {
    let ft: Font;
    try { ft = new Font(g.data(7, r.number)); } catch { continue; }
    fonts++;
    const over = overruns(ft);
    if (over) { totalOverrun += over; console.log(`  ${name} font ${r.number}: ${over} glyphs overrun the next glyph`); }
    fh.update(le16(r.number)); fh.update(le16(ft.charCount)); fh.update(le16(ft.lineHeight));
    for (const c of ft.chars) {
      fh.update(Buffer.from([c.width & 0xFF, c.height & 0xFF]));
      fh.update(Buffer.from(c.bits));
      glyphs++;
    }
  }

  const ch = createHash('sha1');
  let cursors = 0, opaque = 0;
  for (const r of [...g.byType('cursor')].sort((a, b) => a.number - b.number)) {
    let cu: Cursor;
    try { cu = new Cursor(g.data(8, r.number)); } catch { continue; }
    cursors++;
    ch.update(le16(r.number)); ch.update(le16(cu.hotspotX)); ch.update(le16(cu.hotspotY));
    ch.update(Buffer.from(Array.from(cu.pixels, v => v === CURSOR_CLEAR ? 255 : v)));
    opaque += [...cu.pixels].filter(v => v !== CURSOR_CLEAR).length;
  }

  const fd = fh.digest('hex').slice(0, 16), cd = ch.digest('hex').slice(0, 16);
  const ok = fd === want.font_digest && fonts === want.fonts && glyphs === want.glyphs
          && cd === want.cursor_digest && cursors === want.cursors
          && opaque === want.cursor_opaque;
  if (!ok) bad++;
  totalFonts += fonts; totalGlyphs += glyphs; totalCursors += cursors;
  console.log(`${name.padEnd(9)} ${String(fonts).padStart(2)} fonts ` +
    `${String(glyphs).padStart(5)} glyphs · ${String(cursors).padStart(2)} cursors ` +
    `(${String(Math.round(100 * opaque / Math.max(1, cursors * 256))).padStart(2)}% opaque)  ` +
    (ok ? 'match' : `MISMATCH font ${fd}/${fonts}/${glyphs} vs ${want.font_digest}/${want.fonts}/${want.glyphs}, ` +
                    `cursor ${cd}/${cursors} vs ${want.cursor_digest}/${want.cursors}`));
}
console.log(`\n${totalFonts} fonts (${totalGlyphs} glyphs) and ${totalCursors} cursors compared, ` +
  `${bad} mismatches, ${totalOverrun} glyph overruns`);
process.exit(bad || totalOverrun ? 1 : 0);
