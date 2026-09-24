/**
 * The CRT, run on a real GPU.
 *
 * The shaders are the one part of this program that no amount of
 * reading TypeScript can check: GLSL is compiled by the driver, the
 * framebuffers are validated by the driver, and the orientation of a
 * texture is a convention the driver holds and the source does not
 * state.  So the checks live in a page, and this drives a browser at
 * it and reads back what it found.
 *
 * Chrome is asked for software rendering, so the answer does not depend
 * on the machine's graphics card.  Where there is no Chrome to drive
 * there is nothing to report and this says so rather than passing
 * quietly -- a test that skips without saying so is worse than no test.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { mkdtempSync } from 'node:fs';
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
  console.log('CRT: no Chrome or Chromium on this machine, so the shaders were NOT checked');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'sci0web-crt-'));
execFileSync('npx', ['esbuild', 'test/crt/harness.ts', '--bundle', '--format=esm',
                     `--outfile=${join(dir, 'harness.js')}`], { stdio: 'pipe' });
const page = readFileSync('test/crt/page.html');

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0];
  if (name === '/' || name === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
    return;
  }
  const file = join(dir, name.replace(/^\//, ''));
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

/**
 * Driven, not dumped.
 *
 * `--dump-dom` waits out a virtual clock and then prints, which under
 * software rendering is both slow and unreliable about exiting: the
 * renderer processes keep the pipe open after the parent is killed, so
 * a run that overruns hangs rather than failing.  The debugging
 * protocol asks the page a direct question and gets a direct answer,
 * and the browser is shut by asking it rather than by killing it.
 */
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  // SwiftShader, so this is the same picture on every machine.
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  `--user-data-dir=${join(dir, 'profile')}`, '--remote-debugging-port=0',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

/**
 * Chrome prints the endpoint it settled on to stderr as it comes up.
 *
 * That one is the browser's, which does not answer questions about a
 * page; the page has an endpoint of its own, listed alongside it.
 */
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

const stop = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
let dom = '';
if (!wsUrl) {
  console.log('CRT: the browser never reported a debugging endpoint');
} else {
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
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  // The page writes its findings into #result; poll until they appear.
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', {
      expression: `document.getElementById('result')?.textContent ?? ''`,
      returnByValue: true,
    }) as unknown as { result?: { value?: string } };
    if (r?.result?.value) { dom = r.result.value; break; }
  }
  ws.close();
}
stop();
server.close();
if (!dom) {
  console.log('CRT: the page produced no result at all');
  process.exit(1);
}
const lines = dom.split('\n').map(l => l.trim()).filter(Boolean);
for (const l of lines) console.log(`  ${l}`);
const failed = lines.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${lines.length - failed}/${lines.length} CRT checks passed`);
process.exit(failed ? 1 : 0);
