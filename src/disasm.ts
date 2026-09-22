/**
 * SCI0 PMachine disassembler.
 *
 * One "extended opcode" byte per instruction: `opcode = ext >> 1`, and
 * bit 0 selects operand width -- set means 1-byte operands, clear means
 * 2-byte little-endian.  Argument counts are the exception: always one
 * byte regardless.
 *
 * The table only spells out 0x00-0x3F, because 0x40-0x7F is a perfectly
 * regular block -- load/store/inc/dec crossed with global/local/temp/
 * param, each taking exactly one variable-index operand.
 */

const N = 0, B = 1, V = 2, S = 3;   // operand kinds

const OPS: Record<number, [string | null, number[]]> = {
  0x00: ['bnot', []], 0x01: ['add', []], 0x02: ['sub', []], 0x03: ['mul', []],
  0x04: ['div', []], 0x05: ['mod', []], 0x06: ['shr', []], 0x07: ['shl', []],
  0x08: ['xor', []], 0x09: ['and', []], 0x0A: ['or', []], 0x0B: ['neg', []],
  0x0C: ['not', []], 0x0D: ['eq?', []], 0x0E: ['ne?', []], 0x0F: ['gt?', []],
  0x10: ['ge?', []], 0x11: ['lt?', []], 0x12: ['le?', []], 0x13: ['ugt?', []],
  0x14: ['uge?', []], 0x15: ['ult?', []], 0x16: ['ule?', []],
  0x17: ['bt', [S]], 0x18: ['bnt', [S]], 0x19: ['jmp', [S]],
  0x1A: ['ldi', [S]], 0x1B: ['push', []], 0x1C: ['pushi', [S]],
  0x1D: ['toss', []], 0x1E: ['dup', []], 0x1F: ['link', [V]],
  0x20: ['call', [S, B]], 0x21: ['callk', [V, B]], 0x22: ['callb', [V, B]],
  0x23: ['calle', [V, S, B]], 0x24: ['ret', []], 0x25: ['send', [B]],
  0x26: [null, []], 0x27: [null, []],
  0x28: ['class', [V]], 0x29: [null, []],
  0x2A: ['self', [B]], 0x2B: ['super', [V, B]], 0x2C: ['&rest', [V]],
  0x2D: ['lea', [V, S]], 0x2E: ['selfID', []], 0x2F: [null, []],
  0x30: ['pprev', []],
  0x31: ['pToa', [V]], 0x32: ['aTop', [V]], 0x33: ['pTos', [V]],
  0x34: ['sTop', [V]], 0x35: ['ipToa', [V]], 0x36: ['dpToa', [V]],
  0x37: ['ipTos', [V]], 0x38: ['dpTos', [V]],
  0x39: ['lofsa', [S]], 0x3A: ['lofss', [S]],
  0x3B: ['push0', []], 0x3C: ['push1', []], 0x3D: ['push2', []],
  0x3E: ['pushSelf', []], 0x3F: [null, []],
};

const ACC = ['a', 's'];                 // to accumulator / to stack
const KIND = ['g', 'l', 't', 'p'];      // global, local, temp, param
const VERB = ['l', 's', '+', '-'];      // load, store, inc+load, dec+load

function varName(op: number): string {
  const grp = (op - 0x40) >> 4;
  const rest = (op - 0x40) & 0x0F;
  return VERB[grp] + ACC[(rest >> 2) & 1] + KIND[rest & 3] +
    (((rest >> 3) & 1) ? 'i' : '');
}

export function mnemonic(op: number): string | null {
  return op < 0x40 ? OPS[op][0] : varName(op);
}

function operands(op: number): number[] {
  return op < 0x40 ? OPS[op][1] : [V];
}

export interface Instruction { pc: number; name: string; args: number[]; }

/** Decode one instruction, or null if the opcode is invalid. */
export function decode(data: Uint8Array, pos: number): Instruction & { length: number } | null {
  const ext = data[pos];
  const op = ext >> 1;
  const name = mnemonic(op);
  if (name === null) return null;
  const wide = (ext & 1) === 0;
  let o = pos + 1;
  const args: number[] = [];
  for (const kind of operands(op)) {
    if (kind === B) {
      if (o >= data.length) return null;
      args.push(data[o++]);
    } else if (wide) {
      if (o + 1 >= data.length) return null;
      let v = data[o] | (data[o + 1] << 8);
      o += 2;
      if (kind === S && (v & 0x8000)) v -= 0x10000;
      args.push(v);
    } else {
      if (o >= data.length) return null;
      let v = data[o++];
      if (kind === S && (v & 0x80)) v -= 0x100;
      args.push(v);
    }
  }
  return { pc: pos, name, args, length: o - pos };
}

/**
 * Linear disassembly of [start, end).  `ok` is true when the sweep lands
 * exactly on `end` -- the self-check that the operand widths are right,
 * since a wrong width desynchronises and overshoots almost immediately.
 */
export function sweep(data: Uint8Array, start: number, end: number):
    [Instruction[], boolean] {
  const out: Instruction[] = [];
  let p = start;
  while (p < end) {
    const d = decode(data, p);
    if (!d) return [out, false];
    out.push({ pc: d.pc, name: d.name, args: d.args });
    p += d.length;
  }
  return [out, p === end];
}
