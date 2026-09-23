import { CrtDisplay } from '../../src/crt.ts';
/**
 * What a CRT has to do to a frame, asked of the real shaders.
 *
 * This runs in a browser because that is the only place the shaders
 * run: a GLSL program that will not compile, a framebuffer that cannot
 * be drawn into, or a texture read upside down are all invisible to
 * anything that only reads the TypeScript.  Every one of those three
 * happened while this was being written, and the last -- the whole
 * picture upside down -- passed every check here until the checks
 * started asking about a place in the frame where the answer differed
 * top from bottom.
 */
const out: string[] = [];
const say = (s: string) => out.push(s);
try {
  const crt = CrtDisplay.create();
  if (!crt) { say('FAIL no WebGL2 context'); }
  else {
    say('ok  WebGL2 context and all three programs compiled and linked');
    const W = 320, H = 190;
    const rgb = new Uint8Array(W * H * 3);
    // A test frame: left half mid-grey, right half white, a black band,
    // and one lone bright pixel to show halation.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let v = x < W / 2 ? 90 : 235;
      if (y > 120 && y < 150) v = 0;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((135 + dy) * W + (80 + dx)) * 3;
      rgb[i] = 255; rgb[i + 1] = 255; rgb[i + 2] = 255;
    }
    const outW = 960, outH = 684;
    const cv = crt.render(rgb, W, H, outW, outH);
    say(`ok  rendered ${outW}x${outH}`);
    // Read it back and check the things a CRT must do.
    const gl = (crt as unknown as { gl: WebGL2RenderingContext }).gl;
    const px = new Uint8Array(outW * outH * 4);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (x: number, y: number) => {
      const i = ((outH - 1 - y) * outW + x) * 4;      // GL reads bottom-up
      return [px[i], px[i + 1], px[i + 2]];
    };
    const lum = (c: number[]) => (c[0] + c[1] + c[2]) / 3;

    // Scanlines: down a column in the grey area, light and dark must alternate.
    const col: number[] = [];
    for (let y = 40; y < 100; y++) col.push(lum(at(300, y)));
    const hi = Math.max(...col), lo = Math.min(...col);
    say(`${hi - lo > 12 ? 'ok  ' : 'FAIL'} scanlines: a column varies from ${lo.toFixed(0)} to ${hi.toFixed(0)}`);

    // The mask: neighbouring columns are tinted differently.
    const a = at(300, 60), b = at(301, 60), c = at(302, 60);
    const spread = Math.max(Math.abs(a[0] - b[0]), Math.abs(b[1] - c[1]), Math.abs(a[2] - c[2]));
    say(`${spread > 8 ? 'ok  ' : 'FAIL'} phosphor mask tints neighbouring columns (spread ${spread})`);

    // Brightness: white must still read brighter than mid grey.
    const greyL = lum(at(200, 60)), whiteL = lum(at(700, 60));
    say(`${whiteL > greyL + 25 ? 'ok  ' : 'FAIL'} white ${whiteL.toFixed(0)} is still brighter than grey ${greyL.toFixed(0)}`);

    // Halation: the black band near the lone bright pixel is lifted
    // above the same band far from it.  The band is source rows 121-149,
    // so output row 135/190*684; the bright spot is at source x 80.
    const bandY = Math.round(135 / 190 * outH);
    // Four source pixels clear of the spot, which is three wide: what
    // is read there cannot have come from the spot except by scattering.
    const near = lum(at(Math.round(85 / 320 * outW), bandY));
    const far = lum(at(Math.round(280 / 320 * outW), bandY));
    say(`${near > far + 1 ? 'ok  ' : 'FAIL'} halation lifts black near a bright spot (${near.toFixed(1)} vs ${far.toFixed(1)} far away)`);

    // The corners are outside the curved glass and must be black.
    const corner = lum(at(2, 2));
    say(`${corner < 6 ? 'ok  ' : 'FAIL'} the corner is off the glass (${corner.toFixed(1)})`);

    // And the picture must not be all one colour.
    const uniq = new Set<number>();
    for (let i = 0; i < px.length; i += 4 * 997) uniq.add(px[i] << 16 | px[i + 1] << 8 | px[i + 2]);
    say(`${uniq.size > 20 ? 'ok  ' : 'FAIL'} the frame has ${uniq.size} distinct sampled colours`);
    document.body.append(cv);
  }
} catch (e) {
  say(`FAIL threw: ${(e as Error).message}`);
}
const pre = document.createElement('pre');
pre.id = 'result';
pre.textContent = out.join('\n');
document.body.prepend(pre);
