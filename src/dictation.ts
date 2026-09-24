/**
 * Turning a revised text field into keystrokes.
 *
 * The game has no text field of its own: it reads keys, one at a time,
 * and keeps the line itself.  A browser field is the only place dictated
 * speech appears, so the field has to be translated into the keys that
 * would have produced it.
 *
 * The translation cannot be "send whatever is in the field and empty
 * it".  macOS dictation does not insert a phrase once; it inserts a
 * guess and then revises it, replacing the range it inserted before --
 * "G", then "Ge", then "Get".  A field emptied underneath it has no such
 * range left, so each revision arrives as a fresh insertion of the whole
 * guess and one spoken word lands as "GGeGetGet".
 *
 * So the field is left alone and the difference is sent instead.  A
 * revision that only adds letters sends those letters; one that takes a
 * guess back sends backspaces first, which is exactly what a person
 * correcting themselves would have typed.
 */

/** What the game's backspace key reports. */
export const BACKSPACE = 8;

/**
 * The keys that turn a line reading `sent` into one reading `now`.
 *
 * Only the tail is rewritten.  Dictation revises the end of what it has
 * said and leaves the beginning alone, so comparing from the front keeps
 * the correction as short as it looks: "Get" becoming "Get up" types two
 * more letters rather than retyping the word.
 */
export function revise(sent: string, now: string): number[] {
  let same = 0;
  while (same < sent.length && same < now.length && sent[same] === now[same]) same++;
  const keys: number[] = [];
  for (let i = sent.length; i > same; i--) keys.push(BACKSPACE);
  for (const ch of now.slice(same)) {
    const code = ch.charCodeAt(0);
    // The game's line is a byte string, and anything outside it -- an
    // emoji, a curly quote dictation chose for itself -- has no key that
    // would have typed it.
    if (code >= 32 && code < 256) keys.push(code);
  }
  return keys;
}
