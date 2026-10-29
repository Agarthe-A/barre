// Capture les 9 pages du tableau de bord lancé en mode démo (copie jetable, données fictives).
// Usage: node capture_pages.mjs <url-demo> <dossier-jpg> <dossier-png>
// Écrit aussi tabs.json (position des onglets du bas, en % de la barre) dans le dossier jpg.
import { createRequire } from 'module';
import fs from 'fs';
const req = createRequire(import.meta.url);
const puppeteer = req(req.resolve('puppeteer-core', { paths: [process.env.HOME + '/.hermes/cache/hallmark-tools'] }));
const [base, outJpg, outPng] = process.argv.slice(2);
fs.mkdirSync(outJpg, { recursive: true }); fs.mkdirSync(outPng, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
await p.setViewport({ width: 1920, height: 720 });
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(base, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1500));
const names = await p.$$eval('.page', (els) => els.map((e) => e.dataset.name));
const tabs = await p.$$eval('#nav button', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: +(r.x / 19.2).toFixed(2), y: +(r.y / 7.2).toFixed(2), w: +(r.width / 19.2).toFixed(2), h: +(r.height / 7.2).toFixed(2), name: e.textContent.trim() }; }));
fs.writeFileSync(`${outJpg}/tabs.json`, JSON.stringify({ names, tabs }, null, 1));
for (let i = 0; i < names.length; i++) {
  await p.keyboard.press(String(i + 1));
  await new Promise((r) => setTimeout(r, 1100));
  await p.screenshot({ path: `${outJpg}/p${i + 1}.jpg`, type: 'jpeg', quality: 88 });
  await p.screenshot({ path: `${outPng}/p${i + 1}.png` });
}
console.log(names.join(','), 'erreurs:', errs.length, errs.join('|'));
await b.close();
