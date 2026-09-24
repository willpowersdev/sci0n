/**
 * The page itself, in a browser.
 *
 * Everything else here asks the interpreter what it would do.  This
 * asks the page what it actually shows, which is a different question
 * and the one that was wrong: the served games were read, listed and
 * offered correctly, and then the moment a game was open the sidebar
 * became the resource browser and there was no way back to the others.
 * A page serving eight games looked like it had none, and the folder
 * chooser -- which is for a copy the server cannot see -- was the only
 * way to change game.
 *
 * So the menu is asked for by name, with a game open, which is the
 * case that was broken.  Where there is no Chrome to drive there is
 * nothing to report and this says so rather than passing quietly.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const chrome = CHROMES.find(p => existsSync(p));
if (!chrome) {
  console.log('page: no Chrome or Chromium on this machine, so the page was NOT checked');
  process.exit(0);
}
if (!existsSync('games/games.json')) {
  console.log('page: no games/games.json here, so the served list was NOT checked');
  process.exit(0);
}

execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });

// The real server, on a port of its own, serving the real page.
const server = spawn('node', ['serve.mjs'], {
  env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
const port = await new Promise<number>((resolve) => {
  let seen = '';
  const bell = setTimeout(() => resolve(0), 10_000);
  const look = (d: Buffer) => {
    seen += d.toString();
    const m = /:(\d{2,5})\b/.exec(seen);
    if (m) { clearTimeout(bell); resolve(Number(m[1])); }
  };
  server.stdout.on('data', look);
  server.stderr.on('data', look);
});
const killServer = () => { try { process.kill(-server.pid!, 'SIGKILL'); } catch { server.kill('SIGKILL'); } };
if (!port) { killServer(); console.log('page: the server never said which port it took'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'sci0n-page-'));
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${join(dir, 'profile')}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

const browserWs = await new Promise<string>((resolve) => {
  let seen = '';
  const bell = setTimeout(() => resolve(''), 40_000);
  child.stderr.on('data', (d: Buffer) => {
    seen += d.toString();
    const m = /ws:\/\/[^\s]+/.exec(seen);
    if (m) { clearTimeout(bell); resolve(m[0]); }
  });
});
let wsUrl = '';
if (browserWs) {
  const devtools = new URL(browserWs.replace(/^ws:/, 'http:')).host;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const targets = await (await fetch(`http://${devtools}/json/list`)).json() as
        Array<{ type: string; webSocketDebuggerUrl: string }>;
      wsUrl = targets.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    } catch { /* not listening yet */ }
    if (!wsUrl) await new Promise(r => setTimeout(r, 250));
  }
}
const stopChrome = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };

/** What the page reports about itself, as JSON. */
let found: { menu: string[]; labels: string[]; selected: string; rows: number;
             fetched: string[]; picker: boolean } | null = null;
if (wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>(r => { ws.onopen = () => r(); });
  let seq = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, never>>(r => {
      const id = ++seq; pending.set(id, r as never);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  // Opened at a game, which is the case the menu has to survive.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?game=kq4sci` });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const sel = document.getElementById('games');
        if (!sel || sel.hidden || sel.options.length < 2) return '';
        return JSON.stringify({
          menu: [...sel.options].map(o => o.value).filter(Boolean),
          labels: [...sel.options].filter(o => o.value).map(o => o.textContent ?? ''),
          selected: sel.value,
          picker: !!document.getElementById('pick'),
          rows: document.getElementById('list')?.children.length ?? 0,
          fetched: performance.getEntriesByType('resource')
            .map(e => e.name.split('/').pop()).filter(n => /^(RESOURCE|adl)/i.test(n ?? '')),
        });
      })()`,
      returnByValue: true,
    }) as unknown as { result?: { value?: string } };
    if (r?.result?.value) { found = JSON.parse(r.result.value); break; }
  }
  ws.close();
}
stopChrome();
killServer();

let failed = 0, checked = 0;
function check(ok: boolean, line: string) {
  checked++;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`);
}

if (!found) {
  console.log('  FAIL the page never offered a menu of the served games');
  console.log('\n0/1 page checks passed');
  process.exit(1);
}

check(found.menu.length >= 2,
  `the served games are offered with one already open: ${found.menu.join(', ')}`);

/**
 * Named, not abbreviated.
 *
 * The folders carry ScummVM's short names because that is how a
 * deployed copy is trimmed, and `kq4sci` is not what the game is
 * called.  Every folder in the shipped set has a title, so a label
 * that is still its folder name means the table has been left behind.
 */
const bare = found.menu.filter((v, i) => found.labels[i] === v);
check(bare.length === 0,
  `every game is offered by its title${bare.length ? ` -- ${bare.join(', ')} still show the folder` : ''}`);
const kq4 = found.menu.indexOf('kq4sci');
check(kq4 < 0 || /King's Quest IV/.test(found.labels[kq4]),
  kq4 < 0 ? 'kq4sci is not in this copy' : `kq4sci reads "${found.labels[kq4]}"`);

/**
 * And there is no local folder chooser.
 *
 * It was there for a copy the server could not see, and it is the
 * server's list now.
 */
check(!found.picker, `the folder chooser is gone${found.picker ? ' -- IT IS STILL THERE' : ''}`);
check(found.selected === 'kq4sci',
  `the one being played is the one shown as chosen (${found.selected || 'none'})`);
// The sidebar list belongs to the resource browser once a game is open,
// which is exactly why the menu cannot live there.
check(found.rows > 20, `the sidebar is showing the game's ${found.rows} resources`);
/**
 * And the game was fetched whole.
 *
 * KQ4 keeps its AdLib instruments in `adl.drv`; a page that filters it
 * out fetches a game that runs in silence, and nothing on the screen
 * says so.
 */
check(found.fetched.some(n => /^adl\.drv$/i.test(n)),
  `it fetched ${found.fetched.length} files including the driver` +
  `${found.fetched.some(n => /^adl\.drv$/i.test(n)) ? '' : ' -- WITHOUT adl.drv'}`);

console.log(`\n${checked - failed}/${checked} page checks passed`);
process.exit(failed ? 1 : 0);
