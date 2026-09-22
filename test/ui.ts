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
const idsIn = (html: string) => [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

class El {
  tag: string; children: any[] = []; style: Record<string, string> = {};
  textContent = ''; className = ''; value = ''; hidden = false;
  width = 0; height = 0;
  onclick: (() => void) | null = null; onchange: (() => void) | null = null;
  private _id: string | null = null;
  constructor(tag: string) { this.tag = tag; }
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
};
g.Option = class { text: string; value: string;
  constructor(t: string, v: string) { this.text = t; this.value = v; } };
g.window = { setInterval: () => 1, clearInterval: () => {} };
// Playback is user-driven and not exercised here; the viewer only has to
// build its controls without an audio device present.
g.AudioContext = class { sampleRate = 44100; resume() { return Promise.resolve(); }
  createBuffer() { return { copyToChannel() {} }; }
  createBufferSource() { return { connect: (x: any) => x, start() {}, stop() {} }; }
  createGain() { return { gain: { value: 1 }, connect: (x: any) => x }; }
  get destination() { return {}; } };
g.clearInterval = () => {};
g.location = { search: `?game=${GAME}` };

// The skeleton index.html declares, including #title inside #bar.
for (const id of ['pick', 'gameinfo', 'tabs', 'list', 'bar', 'title',
                  'controls', 'stage', 'cv', 'text']) {
  const e = new El(id === 'cv' ? 'canvas' : 'div'); e.id = id;
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

child?.kill();
console.log(failed ? `\n${failed} tab(s) broke` : '\nselection works repeatedly across tabs');
process.exit(failed ? 1 : 0);
