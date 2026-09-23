/**
 * An SCI score, turned into something a General MIDI synthesiser can play.
 *
 * Four things stand between the two.  The score is addressed to an
 * MT-32, so its program changes mean nothing until they have been
 * through the game's patch bank and the mapping in `gm.ts`.  Its
 * channels carry a mask saying which hardware they were written for,
 * and a channel meant for the PCjr has no business on a GM synth.
 * Channel 15 is not music at all -- it is how the score talks to the
 * game.  And several of its controllers are Sierra's own, which a GM
 * synthesiser would either ignore or, worse, act on.
 *
 * Timing is the one thing that carries over unchanged: SCI counts in
 * sixtieths of a second and so does everything here.
 */
import type { Sound, SoundEvent } from './sound.ts';
import { UNMAPPED } from './gm.ts';

/** SCI0's mask bit for the MT-32, whose scores these are. */
export const DEVICE_MT32 = 0x01;
/** The channel the score talks to the game on, not to the synthesiser. */
export const CONTROL_CHANNEL = 15;
/** General MIDI's percussion channel, which takes no program changes. */
export const PERCUSSION_CHANNEL = 9;

/**
 * Controllers SCI used for its own purposes.
 *
 * A GM synthesiser has its own ideas about some of these numbers, so
 * passing them on is not harmless: 0x4B and 0x50 in particular would be
 * read as sound controllers and change the timbre.
 */
const SCI_CONTROLLERS = new Set([0x4B, 0x4C, 0x50, 0x52, 0x60]);

export interface GmEvent {
  /** Absolute tick, 60 per second. */
  tick: number;
  status: number;
  a: number;
  b: number;
}

/**
 * Which channels this score wants played on an MT-32.
 *
 * Channel 15 is always in -- it is the control channel -- and the
 * rhythm channel comes in whether or not it is flagged, a GM
 * synthesiser always having drums to offer.
 */
export function channelsFor(sound: Sound, mask = DEVICE_MT32): boolean[] {
  return sound.channels.map((c, i) =>
    i === CONTROL_CHANNEL || i === PERCUSSION_CHANNEL || (c.devices & mask) !== 0);
}

/**
 * Translate a score, given the GM program for each of the game's patches.
 *
 * A channel whose patch has no GM equivalent is dropped rather than
 * given a substitute: these banks are half sound effects, and a horse
 * or a sword played as a piano is worse than one not played at all.
 */
export function toGeneralMidi(sound: Sound, patchMap: Int8Array | number[]): GmEvent[] {
  const wanted = channelsFor(sound);
  const out: GmEvent[] = [];
  /** Whether each channel currently has an instrument worth sounding. */
  const audible = new Array<boolean>(16).fill(false);
  audible[PERCUSSION_CHANNEL] = true;

  for (const e of sound.events as SoundEvent[]) {
    const ch = e.status & 0x0F;
    const kind = e.status & 0xF0;
    if (ch === CONTROL_CHANNEL) continue;          // the game's channel, not the synth's
    if (!wanted[ch]) continue;

    if (kind === 0xC0) {
      // Percussion is chosen by note, not by program.
      if (ch === PERCUSSION_CHANNEL) continue;
      const gm = patchMap[e.a] ?? UNMAPPED;
      audible[ch] = gm !== UNMAPPED;
      if (audible[ch]) out.push({ tick: e.tick, status: e.status, a: gm, b: 0 });
      continue;
    }
    if (kind === 0xB0) {
      if (SCI_CONTROLLERS.has(e.a)) continue;
      // Volume and pan are worth keeping even on a silent channel, so
      // that it is in the right state if a program arrives later.
      out.push({ tick: e.tick, status: e.status, a: e.a, b: e.b });
      continue;
    }
    // Notes, aftertouch and bend only go out if something will sound.
    if (!audible[ch]) continue;
    out.push({ tick: e.tick, status: e.status, a: e.a, b: e.b });
  }
  return out;
}

/** Variable-length quantity, as a MIDI file writes its deltas. */
function vlq(n: number, into: number[]) {
  const bytes = [n & 0x7F];
  for (n >>= 7; n > 0; n >>= 7) bytes.unshift((n & 0x7F) | 0x80);
  into.push(...bytes);
}

/**
 * A standard MIDI file, format 0.
 *
 * The division is set to sixty ticks per quarter note and the tempo to
 * a quarter note per second, so that one file tick is one SCI tick and
 * nothing has to be rescaled.
 */
export function writeMidiFile(events: GmEvent[]): Uint8Array {
  const track: number[] = [];
  // Tempo: 1,000,000 microseconds to the quarter note.
  track.push(0x00, 0xFF, 0x51, 0x03, 0x0F, 0x42, 0x40);
  let last = 0, running = -1;
  for (const e of [...events].sort((x, y) => x.tick - y.tick)) {
    vlq(Math.max(0, e.tick - last), track);
    last = e.tick;
    // Running status: the status byte is left out when it repeats.
    if (e.status !== running) { track.push(e.status); running = e.status; }
    track.push(e.a & 0x7F);
    if ((e.status & 0xF0) !== 0xC0 && (e.status & 0xF0) !== 0xD0) track.push(e.b & 0x7F);
  }
  track.push(0x00, 0xFF, 0x2F, 0x00);            // end of track

  const be32 = (n: number) => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
  const out = [
    0x4D, 0x54, 0x68, 0x64, ...be32(6), 0x00, 0x00, 0x00, 0x01, 0x00, 60,
    0x4D, 0x54, 0x72, 0x6B, ...be32(track.length), ...track,
  ];
  return new Uint8Array(out);
}
