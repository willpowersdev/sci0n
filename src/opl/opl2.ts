/**
 * A YM3812 (OPL2) voice engine.
 *
 * Nine channels, two operators each.  An operator is a sine-ish
 * oscillator with its own ADSR envelope; within a channel the first
 * either modulates the second (FM) or is summed with it (additive),
 * chosen by the connection bit.
 *
 * This is a float model of the chip, not a cycle-exact one: phase and
 * envelope are computed in floating point rather than through the
 * hardware's log/exp tables.  It reproduces the structure that decides
 * how an AdLib patch sounds -- operator ratios, envelope rates,
 * feedback, the four waveforms -- but a sample-exact comparison against
 * real hardware would not match, and it is not claimed to.
 */

/** The chip runs at this rate; everything else is resampled from it. */
export const OPL_RATE = 49716;

/** Attenuation is counted in these, 512 of them spanning 96 dB. */
const ATTEN_MAX = 511;
const DB_PER_UNIT = 96 / 512;
const dbToGain = (db: number) => db >= 96 ? 0 : Math.pow(10, -db / 20);

/** Key-scale-level attenuation per block, in dB, indexed by KSL. */
const KSL_DB = [0, 1.5, 3, 6];

/** Node's strip-only TypeScript has no `enum`, so these are constants. */
export const Env = { Off: 0, Attack: 1, Decay: 2, Sustain: 3, Release: 4 } as const;
export type EnvPhase = typeof Env[keyof typeof Env];

export class Operator {
  // register fields
  am = false; vib = false; eg = false; ksr = false;
  mult = 1; ksl = 0; tl = 0;
  ar = 0; dr = 0; sl = 0; rr = 0; wave = 0;

  phase = 0;
  env: EnvPhase = Env.Off;
  /** Current attenuation in envelope units; 0 is full volume. */
  atten = ATTEN_MAX;
  out = 0; prev = 0;

  keyOn() { this.env = Env.Attack; this.phase = 0; }
  keyOff() { if (this.env !== Env.Off) this.env = Env.Release; }

  /** Envelope units per sample for a 4-bit rate, with key scaling. */
  private step(rate: number, ksrOffset: number): number {
    if (rate === 0) return 0;
    const r = Math.min(63, rate * 4 + ksrOffset);
    // Each group of four rate steps doubles the speed; the constant puts
    // a mid rate at a few hundred milliseconds, as the hardware does.
    return Math.pow(2, (r - 28) / 4) * (512 / (0.30 * OPL_RATE));
  }

  advance(ksrOffset: number) {
    switch (this.env) {
      case Env.Attack: {
        const s = this.step(this.ar, ksrOffset);
        if (this.ar === 0) { this.atten = ATTEN_MAX; break; }
        // Attack approaches zero attenuation geometrically, which is why
        // a note reaches full volume quickly and then eases in.
        this.atten -= (this.atten + 1) * s * 0.12;
        if (this.atten <= 0) { this.atten = 0; this.env = Env.Decay; }
        break;
      }
      case Env.Decay: {
        const target = this.sl === 15 ? ATTEN_MAX : this.sl * 32;
        this.atten += this.step(this.dr, ksrOffset);
        if (this.atten >= target) { this.atten = target; this.env = Env.Sustain; }
        break;
      }
      case Env.Sustain:
        // A percussive patch keeps falling; a sustained one holds.
        if (this.eg) break;
        this.atten += this.step(this.rr, ksrOffset);
        if (this.atten >= ATTEN_MAX) { this.atten = ATTEN_MAX; this.env = Env.Off; }
        break;
      case Env.Release:
        this.atten += this.step(this.rr, ksrOffset);
        if (this.atten >= ATTEN_MAX) { this.atten = ATTEN_MAX; this.env = Env.Off; }
        break;
    }
  }

  /** Total attenuation in dB: envelope, total level and key scaling. */
  gain(kslDb: number): number {
    return dbToGain(this.atten * DB_PER_UNIT + this.tl * 0.75 + kslDb);
  }
}

/** The four OPL2 waveforms, applied to a phase in turns. */
function wave(sel: number, ph: number): number {
  const t = ph - Math.floor(ph);
  const s = Math.sin(2 * Math.PI * t);
  switch (sel & 3) {
    case 0: return s;
    case 1: return t < 0.5 ? s : 0;              // half sine
    case 2: return Math.abs(s);                  // absolute sine
    default: return (t % 0.5) < 0.25 ? Math.abs(s) : 0;   // pulse sine
  }
}

export class Channel {
  op0 = new Operator();
  op1 = new Operator();
  fnum = 0; block = 0;
  feedback = 0; additive = false;
  keyed = false;

  /** Operator frequency in Hz for a given multiplier. */
  private hz(mult: number) {
    // F-number and block are the chip's floating-point pitch: the
    // frequency is fnum * 2^block scaled by the sample clock.
    return this.fnum * Math.pow(2, this.block) * OPL_RATE / (1 << 20) * mult;
  }

  keyOn() { this.keyed = true; this.op0.keyOn(); this.op1.keyOn(); }
  keyOff() { this.keyed = false; this.op0.keyOff(); this.op1.keyOff(); }
  get active() { return this.op1.env !== Env.Off || (this.additive && this.op0.env !== Env.Off); }

  sample(): number {
    const ksrOffset = this.op0.ksr ? (this.block << 1) : (this.block >> 1);
    const kslDb = KSL_DB[this.op0.ksl] * Math.max(0, this.block - 3);
    this.op0.advance(ksrOffset);
    this.op1.advance(ksrOffset);
    if (!this.active) return 0;

    // MULT 0 means half, not zero.
    const m0 = this.op0.mult === 0 ? 0.5 : this.op0.mult;
    const m1 = this.op1.mult === 0 ? 0.5 : this.op1.mult;

    const fb = this.feedback ? ((this.op0.out + this.op0.prev) / 2) *
                               Math.pow(2, this.feedback) / 16 : 0;
    this.op0.prev = this.op0.out;
    this.op0.phase += this.hz(m0) / OPL_RATE;
    this.op0.out = wave(this.op0.wave, this.op0.phase + fb) * this.op0.gain(kslDb);

    this.op1.phase += this.hz(m1) / OPL_RATE;
    const kslDb1 = KSL_DB[this.op1.ksl] * Math.max(0, this.block - 3);
    if (this.additive) {
      this.op1.out = wave(this.op1.wave, this.op1.phase) * this.op1.gain(kslDb1);
      return this.op0.out + this.op1.out;
    }
    this.op1.out = wave(this.op1.wave, this.op1.phase + this.op0.out) * this.op1.gain(kslDb1);
    return this.op1.out;
  }
}

export class OPL2 {
  channels: Channel[] = Array.from({ length: 9 }, () => new Channel());

  /** One sample, summed over the nine channels and kept inside [-1, 1]. */
  sample(): number {
    let v = 0;
    for (const c of this.channels) v += c.sample();
    return Math.max(-1, Math.min(1, v / 4));
  }

  render(n: number, out = new Float32Array(n)): Float32Array {
    for (let i = 0; i < n; i++) out[i] = this.sample();
    return out;
  }
}

/**
 * MIDI note to F-number and block.
 *
 * Block is the octave and fnum the pitch within it; picking the highest
 * block that keeps fnum in range gives the most resolution.
 */
export function noteToFreq(note: number, bend = 0): { fnum: number; block: number } {
  const hz = 440 * Math.pow(2, (note - 69 + bend) / 12);
  let block = 0;
  while (block < 7 && hz * (1 << 20) / (OPL_RATE * Math.pow(2, block)) > 1023) block++;
  const fnum = Math.round(hz * (1 << 20) / (OPL_RATE * Math.pow(2, block)));
  return { fnum: Math.max(0, Math.min(1023, fnum)), block };
}
