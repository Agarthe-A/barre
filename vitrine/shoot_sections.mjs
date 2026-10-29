// Captures de contrôle de la vitrine, section par section. Usage: node shoot_sections.mjs <index.html> <dossier>
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
const req = createRequire(import.meta.url);
const puppeteer = req(req.resolve('puppeteer-core', { paths: [process.env.HOME + '/.hermes/cache/hallmark-tools'] }));
const file = path.resolve(process.argv[2]), out = process.argv[3], root = path.dirname(file);
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.css': 'text/css', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}/`;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const p = await b.newPage(); await p.setViewport({ width: w, height: h });
  await p.goto(base, { waitUntil: 'load' }); await wait(1200);
  await p.screenshot({ path: `${out}/hero-${w}.png` });
  for (const id of ['video', 'cause', 'sequence', 'rapport', 'pages', 'installer', 'etat']) {
    const el = await p.$('#' + id); if (!el) continue;
    await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await wait(250);
    await el.screenshot({ path: `${out}/${id}-${w}.png` });
  }
  await p.close();
}
await b.close(); srv.close();
