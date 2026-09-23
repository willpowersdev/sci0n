/**
 * SCI0 sound resources.
 *
 *   u8  flag        non-zero when a digitised sample follows the music
 *   N x u16 channel  per-channel voice count and device bitmask
 *   ...             delta-time + MIDI events, running status, ending 0xFC
 *
 * N is 16 in most games and 8 in early SCI0 (KQ4) -- the same early/late
 * split as the doubled selector ids.  Which one a game uses is decided
 * by parsing: the wrong header size lands mid-event and the stream stops
 * making sense almost immediately, so it is cheap to detect and there is
 * no need to keep a table of games.
 *
 * Delta times are one byte, with 0xF8 meaning "240 ticks, keep reading".
 * SCI01 uses a different, multi-track header and is not handled here.
 */
export interface SoundEvent {
  /** Absolute tick, 60 per second. */
  tick: number;
  /** Full MIDI status byte, including the channel in the low nibble. */
  status: number;
  a: number;
  b: number;
}

export interface Channel {
  /** Voices the channel asks for, and its priority. */
  voices: number;
  /** Which output devices play this channel; bit 0x04 is AdLib. */
  devices: number;
}

/** A point in a piece where the music tells the script where it is. */
export interface Cue {
  /** Absolute tick, 60 per second. */
  tick: number;
  /** The value the script reads back as `signal`. */
  signal: number;
}

export interface Sound {
  /** 8 or 16, whichever parsed. */
  channelCount: number;
  channels: Channel[];
  events: SoundEvent[];
  /** Total length in ticks. */
  ticks: number;
  /** Bytes of digitised audio after the end marker, if any. */
  digital: Uint8Array | null;
  /** Where the piece signals the script, in order. */
  cues: Cue[];
  /** Tick the piece loops back to, if it marked one. */
  loopTick: number | null;
}

/**
 * The channel SCI reserved for talking to the game rather than to the
 * synthesiser.  A program change here is not an instrument.
 */
export const SIGNAL_CHANNEL = 0x0F;
/** Program change on the signal channel: the low nibble of 0xCF. */
const SIGNAL_STATUS = 0xC0 | SIGNAL_CHANNEL;
/**
 * The signal that marks the loop point instead of cueing the script.
 *
 * SCI0-late and everything after it keep this one to themselves; only
 * the earliest SCI0 passed it on.  (ScummVM also lets it through for
 * KQ4's sound 106, whose scripts wait on signal 127 because Sierra
 * changed the driver without updating them -- untested here, as KQ4
 * does not yet reach its title.)
 */
const SIGNAL_LOOP = 127;

/** Device bit for the AdLib/OPL2 arrangement. */
export const DEVICE_ADLIB = 0x04;

const HEADERS = [33, 17];      // 1 + 16*2, and early SCI0's 1 + 8*2

function scan(d: Uint8Array, start: number, collect: SoundEvent[] | null) {
  let p = start, status = 0, tick = 0, n = 0;
  while (p < d.length) {
    let delta = 0;
    while (p < d.length && d[p] === 0xF8) { delta += 240; p++; }
    if (p >= d.length) return { ok: false, end: p, n, tick };
    delta += d[p++];
    tick += delta;
    if (p >= d.length) return { ok: false, end: p, n, tick };
    if (d[p] >= 0x80) status = d[p++];
    if (status === 0xFC) return { ok: true, end: p, n, tick };   // end of track
    if (status === 0xFF) { p++; continue; }                      // reset / meta
    const hi = status & 0xF0;
    if (status < 0x80 || hi === 0xF0) return { ok: false, end: p, n, tick };
    const wide = !(hi === 0xC0 || hi === 0xD0);
    const a = d[p] ?? 0, b = wide ? (d[p + 1] ?? 0) : 0;
    p += wide ? 2 : 1;
    if (collect) collect.push({ tick, status, a, b });
    n++;
    if (n > 500000) return { ok: false, end: p, n, tick };
  }
  return { ok: false, end: p, n, tick };
}

/** Header size that makes this one stream parse, or -1. */
export function headerSize(d: Uint8Array): number {
  for (const h of HEADERS) if (scan(d, h, null).ok) return h;
  return -1;
}

/**
 * The header size a whole game uses.
 *
 * It has to be decided per game, not per resource: a few of KQ4's
 * 8-channel sounds also happen to parse as 16-channel, so resources
 * asked one at a time disagree with each other and eleven of them come
 * out silently wrong.  Whichever size parses the most is the game's.
 */
export function detectHeaderSize(datas: Uint8Array[]): number {
  let best = -1, bestOk = 0;
  for (const h of HEADERS) {
    let ok = 0;
    for (const d of datas) if (scan(d, h, null).ok) ok++;
    if (ok > bestOk) { bestOk = ok; best = h; }
  }
  return best;
}

export function parseSound(d: Uint8Array, header?: number): Sound | null {
  const h = header ?? headerSize(d);
  if (h < 0 || !scan(d, h, null).ok) return null;
  const channelCount = (h - 1) / 2;
  const channels: Channel[] = [];
  for (let c = 0; c < channelCount; c++)
    channels.push({ voices: d[1 + c * 2], devices: d[2 + c * 2] });
  const events: SoundEvent[] = [];
  const r = scan(d, h, events);
  // The flag byte says a sample follows; the bytes after the end marker
  // are where it is.  Both agree in every resource checked, so a
  // mismatch is worth not inventing data for.
  const tail = d.length - r.end;
  const digital = (d[0] !== 0 && tail > 2) ? d.subarray(r.end) : null;
  /**
   * The cues, read straight out of the stream.
   *
   * A script steps its scene on by polling the sound object's `signal`,
   * so these are what make a title sequence follow its music rather
   * than a stopwatch.  They are program changes on channel 15, whose
   * "instrument" is the value the script reads back.
   */
  const cues: Cue[] = [];
  let loopTick: number | null = null;
  for (const e of events) {
    if (e.status !== SIGNAL_STATUS) continue;
    if (e.a === SIGNAL_LOOP) { loopTick ??= e.tick; continue; }
    cues.push({ tick: e.tick, signal: e.a });
  }
  return { channelCount, channels, events, ticks: r.tick, digital, cues, loopTick };
}
