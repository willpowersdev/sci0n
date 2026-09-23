/**
 * Said matching, against the grammar the games ship.
 *
 * The parser used to work by scanning: a pattern became a list of word
 * groups and the line matched if those groups turned up in it, in
 * order.  That answers "look" and "get the rock" correctly and is
 * wrong about almost everything else, because it has no idea what any
 * word is *doing* in the sentence.  It cannot tell "give the knight the
 * sword" from "give the sword the knight", it matches `look/rock` on
 * "look" plus any stray rock later in the line, and it has no way to
 * distinguish "turn on the belt" from "turn the belt".
 *
 * SCI does not scan.  It parses the line with vocab.900's grammar,
 * which assigns every word a role -- what is being done, what to, what
 * with -- and a pattern names those roles.  Each check below is a case
 * where the difference shows, so a scanner cannot pass this suite.
 *
 * The patterns are built here from the games' own vocabulary rather
 * than lifted from a script, so that what is being asked is legible;
 * the word groups, the grammar and the classes are all the game's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { Script } from '../src/script.ts';
import { gameWords } from '../src/vocab.ts';
import { Parser } from '../src/vm/parser.ts';
import { ROOT } from './games.ts';

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

const OPS: Record<string, number> = {
  ',': 0xF0, '&': 0xF1, '/': 0xF2, '(': 0xF3, ')': 0xF4,
  '[': 0xF5, ']': 0xF6, '#': 0xF7, '<': 0xF8, '>': 0xF9,
};

let failed = 0, checked = 0;

for (const name of ['SQ3', 'CAMELOT']) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const parser = new Parser(g);
  const groups = new Map<string, number>();
  for (const [w, , grp] of gameWords(g)) if (!groups.has(w)) groups.set(w, grp);

  console.log(`\n=== ${name} ===`);
  if (!parser.ready) { failed++; console.log('  NO VOCABULARY OR GRAMMAR'); continue; }

  /** Compile a written pattern the way the script compiler would. */
  function spec(text: string): Uint8Array | null {
    const out: number[] = [];
    for (const tok of text.match(/[a-z0-9'*!]+|[,&/()[\]#<>]/g) ?? []) {
      if (OPS[tok] !== undefined) { out.push(OPS[tok]); continue; }
      const grp = tok === '*' ? 0xFFF : tok === '!*' ? 0xFFE : groups.get(tok);
      if (grp === undefined) return null;
      out.push((grp >> 8) & 0xFF, grp & 0xFF);
    }
    return new Uint8Array(out);
  }

  /**
   * Type a line, then ask a pattern about it.
   *
   * Null means this game has no word for something here, and the check
   * is skipped.  That has to cover the *line* as well as the pattern:
   * a line the game cannot read fails every pattern, which would let
   * every "must not match" check pass without testing anything.
   */
  function ask(line: string, pattern: string): boolean | null {
    const sp = spec(pattern);
    if (!sp) return null;
    const unknown = parser.parse(line);
    if (unknown !== null) return null;
    return parser.match(sp).matched;
  }

  function check(want: boolean, line: string, pattern: string, why: string) {
    const got = ask(line, pattern);
    if (got === null) { console.log(`  skipped (a word here is not in this game): ${line} / ${pattern}`); return; }
    checked++;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(line).padEnd(28)} ` +
      `${want ? 'matches' : 'must not match'} '${pattern}'${ok ? '' : ` -- got ${got}`}  (${why})`);
  }

  // A pattern names roles, so either word order reaches the same one.
  check(true, 'give the guard the key', 'give/key/guard', 'indirect object first');
  check(true, 'give the key to the guard', 'give/key/guard', 'direct object first');
  // ...and the roles are not interchangeable.
  check(false, 'give the guard the key', 'give/guard/key', 'the roles are not symmetric');

  // A part the pattern does not mention is not asked about, which is
  // what lets a game test `look>` on the outside and sort out what was
  // looked at on the inside.
  check(true, 'look', 'look', 'nothing but the verb');
  check(true, 'look at the key', 'look', 'a pattern of one part ignores the rest');
  check(true, 'look at the key', 'look/key', 'naming the second part');
  check(true, 'look at the key', '/key', 'an empty first part takes any verb');
  check(true, 'look at the key', '/key/', 'a trailing slash takes any third part too');

  // `!*` is how a pattern asks for a part to have been left unsaid, and
  // `*` is how it asks for anything at all to have been said there.
  check(true, 'look', 'look/!*', 'nothing was said about anything');
  check(false, 'look at the key', 'look/!*', 'something was');
  check(true, 'look at the key', 'look/*', 'something was said there');
  check(false, 'look', 'look/*', 'and here nothing was');
  // Making that test optional cannot make it vacuous: "absent" and
  // "empty" are the same thing to ask about.
  check(true, 'look', 'look[/!*]', 'an optional emptiness test still holds');
  check(false, 'look at the key', 'look[/!*]', 'and still refuses a line that said something');

  // A reference asks for the particle as well as the verb.
  check(true, 'turn on the key', 'turn<on/key', 'the particle was typed');
  check(false, 'turn the key', 'turn<on/key', 'the particle was not');
  check(true, 'turn the key', 'turn/key', 'and without the reference it is not wanted');

  // Alternatives and options.
  check(true, 'get the key', 'acquire,look/key', 'the first alternative');
  check(true, 'look at the key', 'acquire,look/key', 'the second');
  check(true, 'get the key', 'get/key[<red]', 'an option left out');

  // Scanning order is not sentence structure: a word in the wrong role
  // must not satisfy a pattern that asks for it in another.
  check(false, 'get the key', 'key/get', 'the verb is not the object');

  // `>` matches without spending the line, so a second pattern still
  // gets an answer where a claiming one would have taken it.
  checked++;
  parser.parse('look at the key');
  const keep = spec('/key>'), second = spec('look/key');
  if (keep && second) {
    const a = parser.match(keep), b = parser.match(second);
    const ok = a.matched && !a.claim && b.matched;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} '>' matched without claiming, and the next pattern still matched` +
      `${ok ? '' : ` -- ${JSON.stringify(a)} then ${JSON.stringify(b)}`}`);
  }
  // Where a claiming pattern does take the line, the next gets nothing.
  checked++;
  parser.parse('look at the key');
  const first = spec('/key'), after = spec('look/key');
  if (first && after) {
    const a = parser.match(first), b = parser.match(after);
    const ok = a.matched && a.claim && !b.matched;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} a claiming match spends the line for the next pattern` +
      `${ok ? '' : ` -- ${JSON.stringify(a)} then ${JSON.stringify(b)}`}`);
  }

  // A word the game does not know is named back; a line of known words
  // the grammar cannot assemble is a different failure, and silent.
  checked++;
  const unknown = parser.parse('zzxyqq the key');
  const ok = unknown === 'zzxyqq';
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} an unknown word is named back${ok ? '' : ` -- got ${JSON.stringify(unknown)}`}`);
}

/**
 * Every group a pattern names is a real one.
 *
 * The said block is a run of patterns separated by 0xFF, but it cannot
 * be scanned a byte at a time looking for one: a byte below 0xF0 opens
 * a two-byte word group whose low byte may be anything, 0xFF included.
 * The wildcard `*` is group 0x0fff, so every pattern using it was being
 * cut in half -- the head keeping a dangling 0x0f that read as the
 * nonexistent group 0x0f00, the tail starting mid-pattern.
 *
 * Camelot lost 203 wildcards that way, and with them the global
 * handlers that answer "get <anything>" and "look at <anything>";
 * typing "get purse" in Arthur's chamber reached no pattern at all.
 *
 * Two things are asked here, because either alone can be satisfied by
 * a decoder that simply drops what it cannot read: no pattern may name
 * a group the vocabulary does not have, and the wildcard must actually
 * be found, since these games certainly use it.
 */
{
  console.log('\n=== said blocks ===');
  for (const name of ['SQ3', 'CAMELOT', 'LSL2', 'KQ4']) {
    let g: Game;
    try { g = new Game(nodeSource(join(ROOT, name))); } catch { continue; }
    const groups = new Set<number>();
    for (const [, , grp] of gameWords(g)) groups.add(grp);
    let specs = 0, wild = 0;
    const bad = new Map<number, number>();
    for (const r of g.byType('script')) {
      const d = g.tryData('script', r.number);
      if (!d) continue;
      let sc: Script;
      try { sc = new Script(d, r.number); } catch { continue; }
      for (const [, spec] of sc.said) {
        specs++;
        for (let i = 0; i < spec.length; i++) {
          const v = spec[i];
          if (v >= 0xF0) continue;
          const grp = (v << 8) | (spec[i + 1] ?? 0);
          i++;
          if (grp === 0xFFF) { wild++; continue; }
          if (grp === 0xFFE) continue;
          if (!groups.has(grp)) bad.set(grp, (bad.get(grp) ?? 0) + 1);
        }
      }
    }
    checked += 2;
    if (bad.size) failed++;
    if (!wild) failed++;
    console.log(`  ${name.padEnd(8)} ${String(specs).padStart(5)} patterns · ` +
      `${String(wild).padStart(4)} name the wildcard${wild ? '' : ' -- NONE, SO THEY ARE BEING CUT SHORT'} · ` +
      `${bad.size ? `NAMES GROUPS THE VOCABULARY HAS NOT: ${[...bad].map(([k, n]) => `0x${k.toString(16)}x${n}`).join(' ')}`
                  : 'every group is a real one'}`);
  }
}

console.log(`\n${checked - failed}/${checked} Said checks passed`);
process.exit(failed ? 1 : 0);
