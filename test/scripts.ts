/**
 * Differential test for the script layer: block tables, object layouts,
 * method tables, property values, exports, locals and said specs must
 * all agree with the Python reference -- plus the vocab name tables and
 * the early-SCI0 selector shift.
 *
 * Every digest is over raw bytes: fixed-width little-endian fields and
 * string bytes, never formatted text.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Script, Index, BLOCK_NAMES } from '../src/script.ts';
import { gameWords } from '../src/vocab.ts';
import { sweep } from '../src/disasm.ts';

import { ROOT } from './games.ts';
const fx = JSON.parse(readFileSync('fixtures/scripts.json', 'utf8'));
const CODE = new Map(Object.entries(BLOCK_NAMES).map(([k, v]) => [v, Number(k)]));

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

const u8 = (h: Hash, v: number) => h.update(Buffer.from([v & 0xFF]));
const u16 = (h: Hash, v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF); h.update(b); };
const u32 = (h: Hash, v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); h.update(b); };
const str0 = (h: Hash, s: string) => {
  h.update(Buffer.from(Array.from(s, c => c.charCodeAt(0) & 0xFF)));
  h.update(Buffer.from([0]));
};
const fin = (h: Hash) => h.digest('hex').slice(0, 16);

function namesDigest(names: string[]) {
  const h = createHash('sha1');
  for (const n of names) str0(h, n);
  return fin(h);
}

function wordsDigest(words: Array<[string, number, number]>) {
  const h = createHash('sha1');
  for (const [w, cls, grp] of words) { str0(h, w); u16(h, cls); u16(h, grp); }
  return fin(h);
}

function scriptDigest(s: Script) {
  const h = createHash('sha1');
  for (const [name, off, size] of s.blocks) {
    u16(h, CODE.get(name) ?? 255); u32(h, off); u32(h, size);
  }
  for (const o of s.objects) {
    u8(h, o.isClass ? 1 : 0); u16(h, o.propCount);
    u16(h, o.species ?? 0); u16(h, o.superclass ?? 0); u16(h, o.info ?? 0);
    u16(h, o.methods.length);
    for (const [sid, coff] of o.methods) { u16(h, sid); u16(h, coff); }
    for (const v of o.properties) u16(h, v);
    if (o.propSelectors) for (const sid of o.propSelectors) u16(h, sid);
    str0(h, o.name ?? '');
  }
  for (const e of s.exports) u16(h, e);
  /**
   * Only the locals the file actually carries.
   *
   * Early SCI0 stores no locals at all, just a count in the word the
   * script begins with, and the interpreter allocates them zeroed.  The
   * reference this is differenced against reads those scripts as having
   * none, so hashing the ones we now allocate would compare our
   * allocation against its absence and call the difference a mismatch.
   * What those scripts do carry is checked below instead.
   */
  if (s.start !== 2) for (const l of s.locals) u16(h, l);
  for (const [off, spec] of s.said) { u32(h, off); h.update(Buffer.from(spec)); }
  return fin(h);
}

let total = 0, bad = 0;
const problems: string[] = [];

for (const [name, data] of Object.entries<any>(fx)) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  let gameBad = 0;

  if (idx.selectorShift !== data.selectorShift) {
    gameBad++; problems.push(`${name}: selectorShift ${idx.selectorShift} != ${data.selectorShift}`);
  }
  for (const [label, got, want] of [
    ['selectors', [idx.selectors.length, namesDigest(idx.selectors)], data.selectors],
    ['kernel', [idx.kernel.length, namesDigest(idx.kernel)], data.kernel],
    ['words', [gameWords(g).length, wordsDigest(gameWords(g))], data.words],
  ] as Array<[string, [number, string], [number, string]]>) {
    if (got[0] !== want[0] || got[1] !== want[1]) {
      gameBad++;
      problems.push(`${name}: ${label} ${got[0]}/${got[1]} != ${want[0]}/${want[1]}`);
    }
  }

  for (const [num, start, blockCount, objCount, saidCount, digest] of data.scripts) {
    total++;
    try {
      const s = new Script(g.data(2, num), num);
      if (s.start !== start) { gameBad++; problems.push(`${name} script.${num}: start ${s.start}!=${start}`); continue; }
      if (s.blocks.length !== blockCount) { gameBad++; problems.push(`${name} script.${num}: blocks`); continue; }
      if (s.objects.length !== objCount) { gameBad++; problems.push(`${name} script.${num}: objects`); continue; }
      if (s.said.length !== saidCount) { gameBad++; problems.push(`${name} script.${num}: said count`); continue; }
      if (scriptDigest(s) !== digest) { gameBad++; problems.push(`${name} script.${num}: digest`); }
    } catch (e: any) { gameBad++; problems.push(`${name} script.${num}: ${e.message}`); }
  }

  bad += gameBad;
  console.log(`${name.padEnd(9)} ${String(data.scripts.length).padStart(4)} scripts  ` +
    `shift=${data.selectorShift}  ${gameBad === 0 ? 'all match' : gameBad + ' MISMATCH'}`);
}

/**
 * And the locals early SCI0 does not write down.
 *
 * The count is the word the script starts with.  That it really is a
 * count, and not something else that happens to sit there, is checked
 * by the scripts themselves: over every code block in every script, no
 * local is ever named at or past it.  Read as zero -- which is what
 * having no locals block amounts to -- KQ4 ran with no globals and
 * every script with no locals, and its intro credits were built into
 * variables that did not exist.
 */
for (const [name] of Object.entries<any>(fx)) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const idx = new Index(g);
  if (idx.selectorShift !== 1) continue;        // a later build; it has blocks
  let named = 0, over = 0, miscounted = 0;
  for (const r of g.byType('script')) {
    const d = g.tryData('script', r.number);
    const s = idx.script(r.number);
    if (!d || !s) continue;
    if (s.locals.length !== (d[0] | (d[1] << 8))) miscounted++;
    let max = -1;
    for (const [bn, at, size] of s.blocks) {
      if (bn !== 'code') continue;
      const [ins] = sweep(s.data, at + 4, at + size);
      for (const i of ins) if (/^(lal|sal|lali|sali|lsl|ssl|\+al|-al)/.test(i.name)) max = Math.max(max, i.args[0]);
    }
    if (max < 0) continue;
    named++;
    if (max >= s.locals.length) over++;
  }
  total += 2;
  if (miscounted) { bad++; problems.push(`${name}: ${miscounted} scripts got a locals count other than the leading word`); }
  if (over) { bad++; problems.push(`${name}: ${over} of ${named} scripts name a local past the count`); }
  console.log(`${name.padEnd(9)} early header: ${named} scripts name locals, ` +
    `${over} past the count, ${miscounted} counted wrong`);
}

console.log(`\n${total} scripts compared, ${bad} mismatches`);
for (const p of problems.slice(0, 12)) console.log('   ' + p);
process.exit(bad ? 1 : 0);
