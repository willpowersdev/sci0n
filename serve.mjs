import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css' };
const root = process.cwd();
/**
 * Games are served read-only from their own directory so the page can be
 * opened straight at one (`/?game=QFG2`) instead of going through the
 * directory picker, which needs a click and a native dialog.
 */
const GAMES = process.env.SCI_GAMES ?? join(homedir(), 'DOSGames', 'SIERRA');
createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  let path, base;
  if (url === '/games' || url.startsWith('/games/')) {
    base = GAMES;
    path = join(GAMES, normalize(url.slice('/games'.length) || '/'));
  } else {
    base = root;
    path = join(root, normalize(url === '/' ? '/index.html' : url));
  }
  if (!path.startsWith(base)) { res.writeHead(403).end(); return; }
  // A directory listing lets the page discover which games are present.
  if (base === GAMES) {
    try {
      const st = await stat(path);
      if (st.isDirectory()) {
        const names = await readdir(path);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(names));
        return;
      }
    } catch { res.writeHead(404).end('not found'); return; }
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(8017, () => console.log('serving http://localhost:8017'));
