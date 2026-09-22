/** EGA colour tables shared by every SCI0 graphics decoder. */

export const EGA_RGB: ReadonlyArray<[number, number, number]> = [
  [0x00,0x00,0x00],[0x00,0x00,0xAA],[0x00,0xAA,0x00],[0x00,0xAA,0xAA],
  [0xAA,0x00,0x00],[0xAA,0x00,0xAA],[0xAA,0x55,0x00],[0xAA,0xAA,0xAA],
  [0x55,0x55,0x55],[0x55,0x55,0xFF],[0x55,0xFF,0x55],[0x55,0xFF,0xFF],
  [0xFF,0x55,0x55],[0xFF,0x55,0xFF],[0xFF,0xFF,0x55],[0xFF,0xFF,0xFF],
];

/**
 * Pic palette: 40 entries, each one byte holding a *pair* of EGA colours
 * (high nibble / low nibble), painted as a chequerboard.
 */
export const DEFAULT_PIC_PALETTE = Uint8Array.from([
  0x00,0x11,0x22,0x33,0x44,0x55,0x66,0x77,
  0x88,0x99,0xAA,0xBB,0xCC,0xDD,0xEE,0x88,
  0x88,0x01,0x02,0x03,0x04,0x05,0x06,0x88,
  0x88,0xF9,0xFA,0xFB,0xFC,0xFD,0xFE,0xFF,
  0x08,0x19,0x2A,0x3B,0x4C,0x5D,0x6E,0x88,
]);

export const DEFAULT_PRIORITY_TABLE = Uint8Array.from([
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  0,1,2,3,4,5,6,7,
]);

/**
 * Resolve one palette byte to a visible colour.  Sierra alternated the
 * halves of the pair on a chequerboard: odd (x^y) shows the high nibble.
 */
export function ditherPixel(pal: number, x: number, y: number): number {
  return ((x ^ y) & 1) ? (pal >> 4) : (pal & 0x0F);
}

/** Mix two channel values in linear light, not in gamma-encoded sRGB. */
function blend(c1: number, c2: number): number {
  const t = Math.pow(c1 / 255, 2.2) + Math.pow(c2 / 255, 2.2);
  return Math.round(Math.pow(t / 2, 1 / 2.2) * 255);
}

export const BLENDED_RGB: ReadonlyArray<[number, number, number]> =
  Array.from({ length: 256 }, (_, p) => {
    const hi = EGA_RGB[p >> 4], lo = EGA_RGB[p & 0x0F];
    return [blend(hi[0], lo[0]), blend(hi[1], lo[1]), blend(hi[2], lo[2])] as
      [number, number, number];
  });
