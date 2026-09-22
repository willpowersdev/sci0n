/**
 * Text resources: a run of NUL-terminated latin-1 strings.
 *
 * Not the count-and-offset table the vocab resources use -- the strings
 * are simply laid end to end.  A leading empty string is normal (SQ3's
 * text 1 opens with a NUL), so empties are kept: an entry's index is how
 * a script's `Print` call refers to it, and dropping one would shift
 * every line after it onto the wrong number.
 */
const latin1 = (d: Uint8Array) => Array.from(d, b => String.fromCharCode(b)).join('');

export function strings(data: Uint8Array): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) continue;
    out.push(latin1(data.subarray(start, i)));
    start = i + 1;
  }
  if (start < data.length) out.push(latin1(data.subarray(start)));
  return out;
}
