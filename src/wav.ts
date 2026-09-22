/**
 * 16-bit mono WAV, so a rendered tune can leave the page.
 *
 * Normalised rather than gained: a fixed multiplier clips the loud
 * passages of a busy track, which is heard as distortion rather than as
 * loudness.
 */
export function encodeWAV(samples: Float32Array, rate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, n * 2, true);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++)
    v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * g * 32767))), true);
  return new Uint8Array(buf);
}
