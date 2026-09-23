/**
 * The explorer's click wiring, driven through a minimal DOM.
 *
 * The bug this exists to catch: `#title` lived inside `#bar`, and every
 * viewer begins by clearing its container.  The first selection worked
 * and deleted `#title`; every one after it threw on the null lookup
 * before reaching the try block, so the whole panel went dead.  Nothing
 * in the engine tests can see that -- it is purely a DOM-contract bug --
 * so the page gets driven here the way a person drives it: load a game,
 * switch tabs, and click several rows in a row.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 8017, ORIGIN = `http://localhost:${PORT}`;
const GAME = process.argv[2] ?? 'QFG2';

const reg = new Map<string, El>();
/** Whatever last had `focus()` called on it. */
let focused: El | null = null;
const idsIn = (html: string) => [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

class El {
  tag: string; children: any[] = []; style: Record<string, string> = {};
  // Enough of an element for the page to set up play mode without a
  // real browser: a class list, listeners and a rectangle to map
  // pointer coordinates against.
  classList = { add() {}, remove() {} };
  disabled = false;
  value = '';
  // Focus and listeners are real here, because the bug they catch is
  // invisible otherwise: only printable characters travel through the
  // hidden field, so losing its focus leaves menus and arrows working
  // and kills nothing but typing.
  listeners: Record<string, Function[]> = {};
  addEventListener(t: string, fn: Function) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: Function) {
    this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn);
  }
  dispatch(t: string, ev: any = {}) { for (const fn of this.listeners[t] ?? []) fn({ target: this, ...ev }); }
  focus() { focused = this; }
  blur() { if (focused === this) focused = null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 684 }; }
  textContent = ''; className = ''; value = ''; hidden = false;
  width = 0; height = 0;
  onclick: (() => void) | null = null; onchange: (() => void) | null = null;
  private _id: string | null = null;
  constructor(tag: string) { this.tag = tag; }
  get tagName() { return this.tag.toUpperCase(); }
  set id(v: string) { this._id = v; if (v) reg.set(v, this); }
  get id() { return this._id ?? ''; }
  unregister() {
    if (this._id) reg.delete(this._id);
    for (const c of this.children) c.unregister?.();
  }
  // The markup is retained, not discarded: a test that cannot read back
  // what a viewer wrote can only check that it did not throw.
  private _html = '';
  set innerHTML(v: string) {
    for (const c of this.children) c.unregister?.();
    this.children = [];
    this._html = String(v);
    for (const i of idsIn(String(v))) { const e = new El('span'); e.id = i; this.children.push(e); }
  }
  get innerHTML() { return this._html; }
  append(...xs: any[]) { this.children.push(...xs); }
  insertAdjacentHTML(_where: string, html: string) {
    this._html += html;
    for (const i of idsIn(html)) { const e = new El('span'); e.id = i; this.children.push(e); }
  }
  add(o: any) { this.children.push(o); }
  getContext() { return CTX; }
}

// The canvas is not what is under test; absorb every call.
const CTX: any = new Proxy({}, {
  get: () => () => ({ data: new Uint8ClampedArray(4 * 1024 * 1024) }),
});

async function serverUp() {
  try { return (await fetch(ORIGIN + '/')).ok; } catch { return false; }
}

const g: any = globalThis;
g.document = {
  createElement: (t: string) => new El(t),
  getElementById: (id: string) => reg.get(id) ?? null,
  title: '',
  body: new El('body'),
};
/** The page's frame callback, so the loop can be stepped by hand. */
let frameFn: Function | null = null;
g.requestAnimationFrame = (fn: Function) => { frameFn = fn; return 1; };
g.cancelAnimationFrame = () => {};
g.Option = class { text: string; value: string;
  constructor(t: string, v: string) { this.text = t; this.value = v; } };
const winListeners: Record<string, Function[]> = {};
g.window = {
  setInterval: () => 1, clearInterval: () => {},
  addEventListener: (t: string, fn: Function) => { (winListeners[t] ??= []).push(fn); },
  removeEventListener: (t: string, fn: Function) => {
    winListeners[t] = (winListeners[t] ?? []).filter(f => f !== fn);
  },
};
const fireWindow = (t: string, ev: any = {}) => { for (const fn of winListeners[t] ?? []) fn(ev); };
// Playback is user-driven and not exercised here; the viewer only has to
// build its controls without an audio device present.
g.AudioContext = class { sampleRate = 44100; resume() { return Promise.resolve(); }
  createBuffer() { return { copyToChannel() {} }; }
  createBufferSource() { return { connect: (x: any) => x, start() {}, stop() {} }; }
  createGain() { return { gain: { value: 1 }, connect: (x: any) => x }; }
  get destination() { return {}; } };
g.clearInterval = () => {};
g.location = { search: `?game=${GAME}` };
// The page records the chosen game in the URL; there is no URL here.
g.history = { replaceState() {} };

// The skeleton index.html declares, including #title inside #bar.
for (const id of ['pick', 'gameinfo', 'tabs', 'list', 'bar', 'title',
                  'controls', 'stage', 'cv', 'text', 'play', 'quit', 'hud',
                  'dictate', 'mic', 'speed', 'dither']) {
  // The tag matters for #speed: the page leaves a dropdown holding the
  // keyboard while it is open, and tells it apart by tag name.
  const tag = id === 'cv' ? 'canvas' : id === 'speed' ? 'select'
            : id === 'dictate' ? 'input' : 'div';
  const e = new El(tag); e.id = id;
}
reg.get('bar')!.children.push(reg.get('title')!, reg.get('controls')!);

let child: ReturnType<typeof spawn> | null = null;
if (!await serverUp()) {
  child = spawn('node', ['serve.mjs'], { cwd: process.cwd(), stdio: 'ignore' });
  for (let i = 0; i < 40 && !await serverUp(); i++) await sleep(100);
  if (!await serverUp()) { console.log('could not start serve.mjs'); process.exit(1); }
}
const bare = globalThis.fetch;
g.fetch = (u: string, o?: any) => bare(u.startsWith('http') ? u : ORIGIN + u, o);

await import('../dist/app.js');
for (let i = 0; i < 60 && !reg.get('list')!.children.length; i++) await sleep(100);

let failed = 0;
const info = reg.get('gameinfo')!.textContent;
console.log(`${GAME}: ${info}`);
const tabs = () => reg.get('tabs')!.children as El[];
console.log(`tabs: ${tabs().map(t => t.textContent).join(' ')}`);

/**
 * Click the first `n` rows and check each actually rendered.
 *
 * "onclick did not throw" is not enough: the page catches viewer errors
 * and writes them into the bar, so a completely broken viewer still
 * looks like a successful click.  What has to be asserted is that the
 * viewer produced output and reported no failure.
 */
function clickRows(label: string, n: number) {
  const rows = () => reg.get('list')!.children as El[];
  const total = rows().length;
  const textual = ['script', 'text', 'vocab', 'sound'].includes(label);
  let ok = 0, bytes = 0;
  for (let i = 0; i < Math.min(n, total); i++) {
    const row = rows()[i];
    const what = row.textContent;
    reg.get('text')!.innerHTML = '';
    try { row.onclick!(); }
    catch (e: any) {
      console.log(`  ${label.padEnd(7)} ${String(total).padStart(4)} rows  ` +
                  `THREW on ${what}: ${e.message}`);
      failed++; return;
    }
    const bar = reg.get('controls')!.innerHTML;
    if (/decode failed|missing element/.test(bar)) {
      console.log(`  ${label.padEnd(7)} ${String(total).padStart(4)} rows  ` +
                  `FAILED on ${what}: ${bar.replace(/<[^>]+>/g, '')}`);
      failed++; return;
    }
    // A canvas viewer leaves no markup, so its evidence is a sized image.
    if (!textual && !(reg.get('cv')!.width > 0 && reg.get('cv')!.height > 0)) {
      console.log(`  ${label.padEnd(7)} ${String(total).padStart(4)} rows  ` +
                  `NOTHING DRAWN on ${what}`);
      failed++; return;
    }
    const pane = reg.get('text')!.innerHTML;
    if (textual && pane.length < 32) {
      console.log(`  ${label.padEnd(7)} ${String(total).padStart(4)} rows  ` +
                  `EMPTY pane on ${what}`);
      failed++; return;
    }
    bytes += pane.length;
    ok++;
  }
  const note = textual ? `, ${bytes.toLocaleString()} chars rendered` : '';
  console.log(`  ${label.padEnd(7)} ${String(total).padStart(4)} rows  clicked ${ok}` +
              `, title now "${reg.get('title')!.textContent}"${note}`);
}

clickRows('pic', 6);
for (const t of tabs()) {
  if (!['view', 'script', 'text', 'vocab', 'font', 'cursor', 'sound'].includes(t.textContent)) continue;
  t.onclick!();
  clickRows(t.textContent, 6);
}

/**
 * Typing reaches the game after the play bar has been touched.
 *
 * Printable characters are read from a hidden input; everything else
 * comes off a window-level keydown listener.  So when that input loses
 * focus the failure is a strange one -- Escape still opens the menu,
 * the arrows still move, Return still works, and only letters go
 * nowhere, which reads as "the parser stopped appearing" rather than
 * as a keyboard problem.  Changing the speed took the focus and never
 * gave it back.
 */
{
  reg.get('play')!.onclick?.();
  const dictate = reg.get('dictate')!;
  if ((reg.get('quit') as El).hidden) {
    console.log(`\nplay mode did not start for ${GAME}; typing not checked`);
  } else {
    const check = (what: string, ok: boolean) => {
      if (!ok) failed++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    };
    console.log('\ntyping:');
    check('starting play focuses the field characters arrive in', focused === dictate);

    // The speed dropdown keeps the keyboard while it is open.
    const speed = reg.get('speed')! as El;
    speed.focus();
    speed.value = '40';
    speed.onchange?.();
    check('changing the speed gives the keyboard back', focused === dictate);

    // Any other click in the bar, then the browser's own event order.
    const dither = reg.get('dither')! as El;
    dither.focus();
    fireWindow('pointerup', { target: dither });
    await sleep(5);
    check('clicking a play-bar button gives the keyboard back', focused === dictate);

    // ...but a click on the dropdown itself must not steal it back
    // while the menu is still open.
    focused = speed;
    fireWindow('pointerup', { target: speed });
    await sleep(5);
    check('a click on the dropdown leaves it holding the keyboard', focused === speed);

    /**
     * A game that ends itself hands the page back.
     *
     * File > Quit, once its prompt is answered, returns from the
     * game's own play loop, and the interpreter reports that as `ret`
     * (test/menubar.ts drives the whole chain).  The page used to do
     * nothing with it: the frame loop simply stopped asking for
     * frames, leaving play mode up over a picture that would never
     * change again, with the play bar still showing and no way back
     * except the keyboard shortcut.
     */
    const sess = (globalThis as any).__lastSession;
    (sess as any).done = { stopped: 'ret' };
    frameFn?.();
    check('a game that quits itself leaves play mode, as Exit does',
      (reg.get('quit') as El).hidden && (reg.get('speed') as El).hidden);
  }
}

child?.kill();
console.log(failed ? `\n${failed} check(s) broke` : '\nselection works repeatedly across tabs, and typing survives the play bar');
process.exit(failed ? 1 : 0);
