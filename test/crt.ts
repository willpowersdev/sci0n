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
 * Started, not run to completion.
 *
 * The page is served from this same process, so the event loop has to
 * stay free to answer for it: `spawnSync` blocks it, Chrome's request
 * for the page is never answered, and it gives back an empty document
 * once its clock runs out.
 */
const argv = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  // Its own profile: the browser the person is using holds a lock on
  // theirs, and a second Chrome pointed at it simply never starts.
  `--user-data-dir=${join(dir, 'profile')}`,
  // SwiftShader, so this is the same picture on every machine.
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--virtual-time-budget=15000', '--dump-dom',
  `http://127.0.0.1:${port}/`,
];
const dom = await new Promise<string>((resolve) => {
  const child = spawn(chrome, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.on('data', (d: Buffer) => { buf += d.toString(); });
  const bell = setTimeout(() => child.kill('SIGKILL'), 90_000);
  child.on('close', () => { clearTimeout(bell); resolve(buf); });
  child.on('error', () => { clearTimeout(bell); resolve(''); });
});
server.close();
const body = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom);
if (!body) {
  console.log('CRT: the page produced no result at all');
  console.log(`  ${dom.length} bytes of document came back`);
  process.exit(1);
}
const lines = body[1].split('\n').map(l => l.trim()).filter(Boolean);
for (const l of lines) console.log(`  ${l}`);
const failed = lines.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${lines.length - failed}/${lines.length} CRT checks passed`);
process.exit(failed ? 1 : 0);
