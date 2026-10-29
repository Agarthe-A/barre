// Enregistre le tableau de bord (copie en mode démo, données fictives) piloté par de vrais gestes de souris.
// Usage: node record_dashboard.mjs <url-demo> <dossier-images>
// Écrit <dossier>/f00001.jpg… et list.txt (format concat de ffmpeg, durées réelles) et marks.json (instants des pages).
import { createRequire } from 'module';
import fs from 'fs';
const req = createRequire(import.meta.url);
const puppeteer = req(req.resolve('puppeteer-core', { paths: [process.env.HOME + '/.hermes/cache/hallmark-tools'] }));
const [url, out] = process.argv.slice(2);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
await p.setViewport({ width: 1920, height: 720 });
// un anneau suit le pointeur tant qu'il est enfoncé (le « doigt » de la démo, joué à la souris)
await p.evaluateOnNewDocument(() => {
  addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;background:rgba(242,169,59,.28);box-shadow:inset 0 0 0 3px rgba(242,169,59,.9);pointer-events:none;z-index:99999;opacity:0;transition:opacity .12s';
    document.body.appendChild(d);
    const at = (e) => { d.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; };
    addEventListener('pointerdown', (e) => { at(e); d.style.opacity = '1'; }, true);
    addEventListener('pointermove', (e) => { if (e.buttons) at(e); }, true);
    addEventListener('pointerup', () => { d.style.opacity = '0'; }, true);
  });
});
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle2' });
await wait(1500);

const cdp = await p.createCDPSession();
const frames = [];
let n = 0;
cdp.on('Page.screencastFrame', async (f) => {
  n++;
  const name = `f${String(n).padStart(5, '0')}.jpg`;
  fs.writeFileSync(`${out}/${name}`, Buffer.from(f.data, 'base64'));
  frames.push({ name, t: f.metadata.timestamp });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* fin */ }
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
await wait(300);
const marks = [];
const mark = (label) => marks.push({ label, wall: Date.now() / 1000 });

async function swipe(dir = -1) {
  const y = 300, x0 = dir < 0 ? 1500 : 500, x1 = dir < 0 ? 560 : 1440;
  await p.mouse.move(x0, y); await p.mouse.down();
  await p.mouse.move((x0 + x1) / 2, y, { steps: 6 }); await wait(30);
  await p.mouse.move(x1, y, { steps: 8 }); await wait(60);
  await p.mouse.up();
  await wait(700);
}
async function tap(sel) {
  const r = await p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await p.mouse.move(r[0], r[1], { steps: 5 }); await p.mouse.down(); await wait(140); await p.mouse.up(); await wait(500);
}
const page = () => p.$eval('#nav button.on', (e) => e.textContent.trim());

// 9 pages: 8 glissements, un geste par page (toucher une case, lecture/pause, lumière, œil), retour à l'accueil par l'onglet.
mark('Accueil'); await wait(1500);
await swipe(-1); mark(await page());                       // Tâches
await tap('[data-prio="1"]'); await wait(900);
await swipe(-1); mark(await page());                       // Musique
await tap('[data-music="playpause"]'); await wait(700); await tap('[data-music="playpause"]'); await wait(500);
await swipe(-1); mark(await page()); await wait(800);      // Agenda
await swipe(-1); mark(await page()); await wait(800);      // Serveur
await swipe(-1); mark(await page());                       // Maison
await tap('[data-hue="c"]'); await wait(800);
await swipe(-1); mark(await page()); await wait(800);      // Claude
await swipe(-1); mark(await page());                       // Patrimoine
await tap('#pEye'); await wait(1300);
await swipe(-1); mark(await page()); await wait(1200);     // Kanban
await tap('#nav button[data-goto="0"]'); mark(await page()); await wait(1000);
await cdp.send('Page.stopScreencast');
await wait(200);

const lines = [];
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 0.5;
  lines.push(`file '${frames[i].name}'`, `duration ${Math.max(d, 0.001).toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].name}'`);
fs.writeFileSync(`${out}/list.txt`, lines.join('\n') + '\n');
const seconds = frames.at(-1).t - frames[0].t + 0.5;
fs.writeFileSync(`${out}/marks.json`, JSON.stringify({ frames: frames.length, seconds, marks, firstFrameTimestamp: frames[0].t }, null, 1));
console.log('images', frames.length, 'durée', seconds.toFixed(1), 's', 'erreurs', errs.length, errs.join('|'));
console.log(marks.map((m) => m.label).join(' > '));
await b.close();
