/**
 * A CRT for the picture to be shown on.
 *
 * These games were drawn for a phosphor screen and read wrong without
 * one.  EGA art leans on the display: dithered pairs were meant to mix
 * in the beam rather than stay as a chequerboard, a single bright pixel
 * was meant to bloom, and 200 lines were meant to sit in visible bands
 * with dark between them.  A nearest-neighbour blit shows the data and
 * not the picture.
 *
 * What a CRT does to a frame, and what is modelled here:
 *
 *   - The beam is not a pixel.  It is a spot whose width grows with how
 *     hard it is driven, so a bright line spreads into its neighbours
 *     and a dim one stays thin.  This is the part that makes scanlines
 *     look like light rather than like black stripes drawn on top, and
 *     it is why the gap between lines closes on bright areas.
 *   - Light scatters in the glass.  A blurred copy of the frame added
 *     back is halation: bright areas bleed a halo into the dark.
 *   - The screen is not one phosphor but three in strips, so every
 *     third column is missing two of its primaries.  That costs
 *     brightness, which has to be given back.
 *   - The glass is curved, and the corners fall off.
 *
 * All of it is done in linear light: adding and blurring in gamma space
 * darkens midtones and turns halation grey.
 *
 * Written from the physics and from the techniques CRT shaders have in
 * common rather than from any one of them.  RetroArch's
 * crt-guest-advanced is the best known and was read for its approach --
 * the beam-width-from-brightness idea above is its central one -- but
 * it is GPL and this is not a port of it: no code is shared, the pass
 * structure is shorter, and the falloff, mask and curvature here are
 * written out from their own descriptions.
 */

/** How the phosphors are arranged. */
export type Mask = 'aperture' | 'slot' | 'none';

export interface CrtOptions {
  /** How sharply a scanline falls off; larger is a thinner beam. */
  scanline: number;
  /** Beam width at black and at white, in scanline heights. */
  beamMin: number;
  beamMax: number;
  /** How much of the blurred copy is added back as halation. */
  glow: number;
  /** How dark the unlit phosphors are; 1 is no mask at all. */
  maskDepth: number;
  mask: Mask;
  /** Barrel distortion, across and down. */
  warpX: number;
  warpY: number;
  /** How much the corners fall off. */
  vignette: number;
  /** Lifted to pay for what the mask and the scanlines take away. */
  brightness: number;
  /** The display's gamma, which the output is encoded back to. */
  gamma: number;
}

export const DEFAULTS: CrtOptions = {
  scanline: 8.0,
  beamMin: 1.35,
  beamMax: 0.75,
  glow: 0.16,
  maskDepth: 0.55,
  mask: 'aperture',
  warpX: 0.028,
  warpY: 0.038,
  vignette: 0.22,
  brightness: 1.45,
  gamma: 2.2,
};

/** Two triangles covering the target, as clip-space corners. */
const QUAD = new Float32Array([-1, -1, 3, -1, -1, 3]);

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

/**
 * The beam, laid down one source row at a time.
 *
 * Horizontal only: the frame is stretched to the output width and
 * softened along the line the way a beam is smeared by its own width,
 * while the rows stay separate so the next pass can put the gaps
 * between them.  Output is linear light.
 */
const BEAM = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D src;
uniform vec2 srcSize;
uniform float gamma;
uniform float sharp;

vec3 toLinear(vec3 c) { return pow(c, vec3(gamma)); }

void main() {
  // The frame arrives with its first row first, and a GL texture counts
  // from the bottom, so the source is read upside down.  Turning it over
  // here and nowhere else keeps every later pass in one orientation:
  // each writes a target it also reads with the same coordinates, so a
  // flip anywhere downstream would have to be undone again.
  vec2 t = vec2(uv.x, 1.0 - uv.y) * srcSize;
  float cx = floor(t.x) + 0.5;
  float row = floor(t.y) + 0.5;
  // Three taps is enough at this scale: the spot is about a pixel
  // wide, so only the immediate neighbours carry any of it.
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -1; i <= 1; i++) {
    float x = cx + float(i);
    float d = (x - t.x) * sharp;
    float w = exp2(-d * d);
    sum += toLinear(texture(src, vec2(x, row) / srcSize).rgb) * w;
    wsum += w;
  }
  frag = vec4(sum / wsum, 1.0);
}`;

/** One direction of a separable blur, for the halation copy. */
const BLUR = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D src;
uniform vec2 step;        // one texel along the direction being blurred

void main() {
  // A five-tap binomial kernel, run twice at reduced size, is a wide
  // soft blur for very little work -- and halation has no detail in it
  // worth paying more for.
  vec3 c = texture(src, uv).rgb * 0.375;
  c += texture(src, uv + step).rgb * 0.25;
  c += texture(src, uv - step).rgb * 0.25;
  c += texture(src, uv + step * 2.0).rgb * 0.0625;
  c += texture(src, uv - step * 2.0).rgb * 0.0625;
  frag = vec4(c, 1.0);
}`;

/**
 * The screen itself.
 *
 * The curvature is applied to the coordinate, the two nearest source
 * rows are weighted by how far the beam reaches, the halation is added,
 * and the phosphor strips and the corners take their share back.
 */
const SCREEN = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D beam;
uniform sampler2D glowTex;
uniform vec2 srcSize;
uniform float scanline, beamMin, beamMax, glow, maskDepth, warpX, warpY,
              vignette, brightness, gamma;
uniform int mask;

/** The curve of the glass: each axis bows by how far along the other it is. */
vec2 warp(vec2 p) {
  p = p * 2.0 - 1.0;
  vec2 q = p;
  p.x *= 1.0 + warpX * q.y * q.y;
  p.y *= 1.0 + warpY * q.x * q.x;
  return p * 0.5 + 0.5;
}

/**
 * How much of a row reaches a point d scanlines away from its centre.
 *
 * The spot is Gaussian, and its width is what the brightness drives:
 * a row at full white spreads until it meets its neighbours, a dim one
 * stays a thin bright line with darkness around it.
 */
float beamWeight(float d, float lum) {
  float width = mix(beamMin, beamMax, clamp(lum, 0.0, 1.0));
  float e = d * width;
  return exp2(-scanline * e * e);
}

float luma(vec3 c) { return max(max(c.r, c.g), c.b); }

/** Which phosphors are lit at this column of the output. */
vec3 phosphors(float x) {
  if (mask == 0) return vec3(1.0);
  vec3 lit = vec3(maskDepth);
  if (mask == 1) {                       // strips, one primary each
    int i = int(mod(x, 3.0));
    if (i == 0) lit.r = 1.0; else if (i == 1) lit.g = 1.0; else lit.b = 1.0;
  } else {                               // a coarser two-wide grille
    int i = int(mod(x * 0.5, 3.0));
    if (i == 0) lit.r = 1.0; else if (i == 1) lit.g = 1.0; else lit.b = 1.0;
  }
  return lit;
}

void main() {
  vec2 p = warp(uv);
  // Past the edge of the glass there is no picture, only the bezel.
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) {
    frag = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float sy = p.y * srcSize.y;
  float centre = floor(sy - 0.5) + 0.5;   // the row above the sample
  float f = sy - 0.5 - floor(sy - 0.5);   // how far between the two rows

  vec3 c0 = texture(beam, vec2(p.x, centre / srcSize.y)).rgb;
  vec3 c1 = texture(beam, vec2(p.x, (centre + 1.0) / srcSize.y)).rgb;

  vec3 lit = c0 * beamWeight(f, luma(c0)) + c1 * beamWeight(1.0 - f, luma(c1));

  // Halation: light that scattered in the glass and came back out
  // somewhere near where it went in.
  lit += texture(glowTex, p).rgb * glow;

  lit *= phosphors(gl_FragCoord.x) * brightness;

  // The corners of a tube are further from the gun and fall off.
  vec2 v = p * (1.0 - p.yx);
  lit *= mix(1.0, clamp(pow(v.x * v.y * 16.0, vignette), 0.0, 1.0), step(0.001, vignette));

  frag = vec4(pow(max(lit, 0.0), vec3(1.0 / gamma)), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(sh) ?? 'shader would not compile');
  return sh;
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(p, 0, 'pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) ?? 'program would not link');
  return p;
}

/** A texture and the framebuffer that draws into it. */
interface Target { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }

export class CrtDisplay {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private beamProg: WebGLProgram;
  private blurProg: WebGLProgram;
  private screenProg: WebGLProgram;
  private src: WebGLTexture;
  private beamT: Target | null = null;
  private blurA: Target | null = null;
  private blurB: Target | null = null;
  private srcW = 0;
  private srcH = 0;
  /**
   * Whether the intermediate buffers can hold linear light properly.
   *
   * Rendering into a half-float target needs `EXT_color_buffer_float`,
   * and filtering one needs `OES_texture_float_linear`.  Without them
   * the framebuffer is simply incomplete and every pass draws nothing
   * -- a black screen with no error anywhere.  Eight bits per channel
   * is the fallback: it bands in the dark, where halation lives, but a
   * banded picture beats no picture.
   */
  private float16 = false;
  options: CrtOptions = { ...DEFAULTS };
  /**
   * Uniform locations, looked up once.
   *
   * `getUniformLocation` is a lookup by string across the driver
   * boundary, and there are a dozen of them here; doing that sixty
   * times a second for a value that never moves is work for nothing.
   */
  private where = new Map<string, WebGLUniformLocation | null>();
  private at(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${(p as unknown as { __id?: number }).__id ?? 0}:${name}`;
    let loc = this.where.get(key);
    if (loc === undefined) { loc = this.gl.getUniformLocation(p, name); this.where.set(key, loc); }
    return loc;
  }

  /** Null when the browser will not give us WebGL2. */
  static create(): CrtDisplay | null {
    try { return new CrtDisplay(); } catch { return null; }
  }

  private constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, premultipliedAlpha: false,
    });
    if (!gl) throw new Error('no WebGL2');
    this.gl = gl;
    this.float16 = gl.getExtension('EXT_color_buffer_float') !== null
                && gl.getExtension('OES_texture_float_linear') !== null;
    this.beamProg = program(gl, BEAM);
    this.blurProg = program(gl, BLUR);
    this.screenProg = program(gl, SCREEN);
    [this.beamProg, this.blurProg, this.screenProg].forEach((p, i) => {
      (p as unknown as { __id: number }).__id = i + 1;
    });
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.src = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  }

  private target(old: Target | null, w: number, h: number, linear: boolean): Target {
    const gl = this.gl;
    if (old && old.w === w && old.h === h) return old;
    if (old) { gl.deleteTexture(old.tex); gl.deleteFramebuffer(old.fb); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Half floats where they can be had: the beam and the halation are
    // added in linear light, where eight bits band badly in the dark.
    if (this.float16)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('the intermediate buffer cannot be drawn into');
    return { tex, fb, w, h };
  }

  private pass(prog: WebGLProgram, into: Target | null, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Draw one frame, and hand back the canvas it landed on.
   *
   * `rgb` is the game's own picture, three bytes to a pixel.
   */
  render(rgb: Uint8Array, w: number, h: number, outW: number, outH: number): HTMLCanvasElement {
    const gl = this.gl;
    const o = this.options;
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW; this.canvas.height = outH;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (w !== this.srcW || h !== this.srcH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, rgb);
      this.srcW = w; this.srcH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.UNSIGNED_BYTE, rgb);
    }

    // The beam is laid out at the output's width but the source's rows:
    // across the line it is a smear, down the screen it is still 190
    // separate lines and must stay that way.
    this.beamT = this.target(this.beamT, outW, h, true);
    const gw = Math.max(1, outW >> 2), gh = Math.max(1, h >> 1);
    this.blurA = this.target(this.blurA, gw, gh, true);
    this.blurB = this.target(this.blurB, gw, gh, true);

    gl.useProgram(this.beamProg);
    gl.uniform1i(this.at(this.beamProg, 'src'), 0);
    gl.uniform2f(this.at(this.beamProg, 'srcSize'), w, h);
    gl.uniform1f(this.at(this.beamProg, 'gamma'), o.gamma);
    // Wider than a pixel, so the dither pairs begin to mix along the line.
    gl.uniform1f(this.at(this.beamProg, 'sharp'), 1.35);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    this.pass(this.beamProg, this.beamT, outW, h);

    gl.useProgram(this.blurProg);
    gl.uniform1i(this.at(this.blurProg, 'src'), 0);
    gl.bindTexture(gl.TEXTURE_2D, this.beamT.tex);
    gl.uniform2f(this.at(this.blurProg, 'step'), 1.5 / gw, 0);
    this.pass(this.blurProg, this.blurA, gw, gh);
    gl.bindTexture(gl.TEXTURE_2D, this.blurA.tex);
    gl.uniform2f(this.at(this.blurProg, 'step'), 0, 1.5 / gh);
    this.pass(this.blurProg, this.blurB, gw, gh);

    const p = this.screenProg;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.beamT.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurB.tex);
    gl.uniform1i(this.at(p, 'beam'), 0);
    gl.uniform1i(this.at(p, 'glowTex'), 1);
    gl.uniform2f(this.at(p, 'srcSize'), w, h);
    for (const [k, v] of [
      ['scanline', o.scanline], ['beamMin', o.beamMin], ['beamMax', o.beamMax],
      ['glow', o.glow], ['maskDepth', o.maskDepth], ['warpX', o.warpX],
      ['warpY', o.warpY], ['vignette', o.vignette], ['brightness', o.brightness],
      ['gamma', o.gamma],
    ] as const)
      gl.uniform1f(this.at(p, k), v);
    gl.uniform1i(this.at(p, 'mask'),
                 o.mask === 'none' ? 0 : o.mask === 'aperture' ? 1 : 2);
    this.pass(p, null, outW, outH);
    gl.activeTexture(gl.TEXTURE0);
    return this.canvas;
  }
}
