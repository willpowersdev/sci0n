/**
 * Vocab resources, checked against the games rather than against us.
 *
 * vocab.998 is the interpreter's own opcode table, so it is an account
 * of the instruction set that does not come from the Python reference.
 * Agreeing with it is a stronger result than agreeing with a port of
 * our own assumptions: a shared mistake would survive the differential
 * suites but not this one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type ResourceSource } from '../src/resources.ts';
import { opcodes, gameSuffixes, gameWords, classTable } from '../src/vocab.ts';
import { mnemonic } from '../src/disasm.ts';

import { ROOT } from './games.ts';
const GAMES = ['SQ3', 'LSL2', 'KQ4', 'CAMELOT', 'COLONEL', 'ICE', 'HERO', 'QFG2'];

function nodeSource(dir: string): ResourceSource {
  const files = readdirSync(dir);
  return { names: () => files, read: (n) => new Uint8Array(readFileSync(join(dir, n))) };
}

let bad = 0, checked = 0;
for (const name of GAMES) {
  const g = new Game(nodeSource(join(ROOT, name)));
  const notes: string[] = [];

  // --- opcode names, ours vs the game's ---
  const table = opcodes(g.data(6, 998));
  let agree = 0, mismatch: string[] = [];
  for (let op = 0; op < 0x40 && op < table.length; op++) {
    const theirs = table[op].name;
    const ours = mnemonic(op);
    // An unused opcode is an empty name on their side, null on ours.
    if (theirs === (ours ?? '')) agree++;
    else mismatch.push(`0x${op.toString(16)} "${theirs}" vs "${ours}"`);
    checked++;
  }
  if (mismatch.length) { bad += mismatch.length; notes.push('OPCODES ' + mismatch.slice(0, 4).join(', ')); }

  // --- suffix rules must parse to the end, not trail off ---
  const suf = gameSuffixes(g);
  if (suf.length < 4 || suf.some(s => !s.pattern)) { bad++; notes.push('SUFFIXES malformed'); }

  const words = gameWords(g);
  const classes = classTable(g.data(6, 996));
  console.log(`${name.padEnd(9)} opcodes ${String(agree).padStart(2)}/64 agree · ` +
    `${String(suf.length).padStart(3)} suffixes · ${String(words.length).padStart(5)} parser words · ` +
    `${String(classes.size).padStart(3)} classes` + (notes.length ? '  ' + notes.join(' ') : ''));
}
console.log(`\n${checked} opcode entries compared against the games' own table, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
