// Test de la vitrine barre: vrais gestes de souris à 1440 et 390 px. Usage: node test_page.mjs <index.html> [dossier-captures]
// Sert la vidéo par un petit serveur local pour vérifier qu'elle se lit (200, durée > 0).
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
const req = createRequire(import.meta.url);
const puppeteer = req(req.resolve('puppeteer-core', { paths: [process.env.HOME + '/.hermes/cache/hallmark-tools'] }));
const file = path.resolve(process.argv[2]), shots = process.argv[3] || null;
const root = path.dirname(file);
if (shots) fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.css': 'text/css', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const st = fs.statSync(f), range = q.headers.range;
  const h = { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'accept-ranges': 'bytes' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range), a = m[1] ? +m[1] : 0, z = m[2] ? +m[2] : st.size - 1;
    r.writeHead(206, { ...h, 'content-range': `bytes ${a}-${z}/${st.size}`, 'content-length': z - a + 1 });
    return fs.createReadStream(f, { start: a, end: z }).pipe(r);
  }
  r.writeHead(200, { ...h, 'content-length': st.size }); fs.createReadStream(f).pipe(r);
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}/`;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
let fails = 0, count = 0;
const chk = (n, ok, d = '') => { count++; console.log((ok ? 'ok   ' : 'ECHEC ') + n + (ok ? '' : ' ' + d)); if (!ok) fails++; };
const wait = (ms = 450) => new Promise((r) => setTimeout(r, ms));

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const p = await b.newPage(); await p.setViewport({ width: w, height: h });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('requestfailed', (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText || '')) errs.push('req ' + r.url()); });
  const bad = []; p.on('response', (r) => { if (r.status() >= 400 && !/fonts\.(googleapis|gstatic)/.test(r.url())) bad.push(r.status() + ' ' + r.url()); });
  await p.goto(base, { waitUntil: 'load' }); await wait(1100);
  const page = () => p.$eval('#bar', (e) => Number(e.dataset.page));
  const sel = () => p.$$eval('#tabs .tab', (els) => els.findIndex((e) => e.getAttribute('aria-selected') === 'true') + 1);
  const x = () => p.$eval('#track', (e) => new DOMMatrix(getComputedStyle(e).transform).e);
  const box = () => p.$eval('#bar', (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const swipe = async (dx, steps = 10) => { const [bx, by, bw, bh] = await box(); const y = by + bh / 2, x0 = dx < 0 ? bx + bw * 0.8 : bx + bw * 0.2; await p.mouse.move(x0, y); await p.mouse.down(); await p.mouse.move(x0 + dx / 2, y, { steps }); await p.mouse.move(x0 + dx, y, { steps }); await p.mouse.up(); await wait(650); };
  await p.evaluate(() => document.getElementById('bar').scrollIntoView({ block: 'center' })); await wait(300);

  // écran 8:3, neuf pages, une seule visible
  const [bx, by, bw, bh] = await box();
  chk(`${w}: l'écran garde le format 8:3 (1920×720)`, Math.abs(bw / bh - 8 / 3) < 0.02, `${bw}x${bh}`);
  chk(`${w}: neuf pages, neuf onglets`, (await p.$$eval('#track .slide', (e) => e.length)) === 9 && (await p.$$eval('#tabs .tab', (e) => e.length)) === 9);
  chk(`${w}: départ sur la page 1`, (await page()) === 1 && (await sel()) === 1);
  // images réellement chargées
  const loaded = await p.$$eval('#track img', (els) => els.every((e) => e.complete && e.naturalWidth === 1920 && e.naturalHeight === 720));
  chk(`${w}: les 9 captures sont chargées en 1920×720`, loaded);

  // glisser à gauche = page suivante
  await swipe(-bw * 0.5);
  chk(`${w}: glisser à gauche → page 2`, (await page()) === 2 && (await sel()) === 2, String(await page()));
  chk(`${w}: la piste est décalée d'une largeur`, Math.abs((await x()) + bw) < 2, String(await x()));
  // glisser à droite = page précédente
  await swipe(bw * 0.5);
  chk(`${w}: glisser à droite → page 1`, (await page()) === 1);
  // petit geste: on reste
  await swipe(-bw * 0.04, 4);
  chk(`${w}: un petit glissement ne change pas de page, la piste revient`, (await page()) === 1 && Math.abs(await x()) < 2);
  // bord: pas de page -1
  await swipe(bw * 0.5);
  chk(`${w}: au bord gauche, on reste sur la page 1`, (await page()) === 1 && Math.abs(await x()) < 2);
  // onglets
  await p.click('#tabs .tab:nth-child(5)'); await wait(600);
  chk(`${w}: onglet « serveur » → page 5`, (await page()) === 5 && Math.abs((await x()) + 4 * bw) < 2);
  if (shots && w === 1440) await p.screenshot({ path: `${shots}/serveur-${w}.png` });
  // clavier: flèches, touche 9, touche 1
  await p.focus('#tabs .tab[aria-selected="true"]');
  await p.keyboard.press('ArrowRight'); await wait(500);
  chk(`${w}: flèche droite → page 6`, (await page()) === 6);
  await p.keyboard.press('9'); await wait(500);
  chk(`${w}: touche 9 → page 9, bord droit tenu`, (await page()) === 9);
  await p.keyboard.press('ArrowRight'); await wait(400);
  chk(`${w}: flèche droite au bord droit: on reste sur la page 9`, (await page()) === 9);
  await p.keyboard.press('1'); await wait(500);
  chk(`${w}: touche 1 → page 1`, (await page()) === 1);
  // le glisser sur l'écran ne sélectionne rien et n'ouvre rien
  chk(`${w}: aucune sélection de texte après les glissements`, (await p.evaluate(() => String(getSelection()))) === '');

  // la dalle
  await p.evaluate(() => document.getElementById('pad').scrollIntoView({ block: 'center' })); await wait(300);
  const term = () => p.$eval('#term', (e) => e.textContent);
  const pb = () => p.$eval('#pad', (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  let [qx, qy, qw, qh] = await pb();
  chk(`${w}: la dalle fait 8:3 (3:2 sous 40 rem pour rester touchable) et au moins 150 px de haut`, Math.abs(qw / qh - (w <= 640 ? 3 / 2 : 8 / 3)) < 0.02 && qh >= 150, `${qw}x${qh}`);
  await p.mouse.move(qx + qw * 0.3, qy + qh * 0.4); await p.mouse.down(); await wait(120); await p.mouse.up(); await wait(200);
  let t = await term();
  chk(`${w}: sans correctif → rapport 5, émulation souris (zéros)`, /report 5 +mouse emulation \(zeros\) -> run wisecoco-touch-enable/.test(t) && !/report 4/.test(t), t);
  await p.click('label[for="f-avec"]'); await wait(300);
  t = await term();
  chk(`${w}: changer d'état efface le relevé`, !/report/.test(t.split('\n').slice(2).join('\n')));
  [qx, qy, qw, qh] = await pb();
  const tx = qx + qw * 0.53, ty = qy + qh * 0.76;           // ≈ x 1019, y 546 du dépôt
  await p.mouse.move(tx, ty); await p.mouse.down(); await wait(120);
  const ringOn = await p.$eval('#ring', (e) => e.classList.contains('on'));
  await p.mouse.move(tx + 60, ty - 20, { steps: 6 }); await wait(260);
  await p.mouse.up(); await wait(200);
  t = await term();
  const m = /report 4 +count=1 +\[id 1 down x=(\d+) y=(\d+)\]/.exec(t);
  chk(`${w}: avec correctif → rapport 4, contact 1 posé, X 0–1920 et Y 0–720`, !!m && +m[1] >= 0 && +m[1] <= 1920 && +m[2] >= 0 && +m[2] <= 720, t);
  // position finale = ligne « up » (les lignes « down » intermédiaires sont échantillonnées toutes les 140 ms)
  const lastUp = [...t.matchAll(/\[id 1 up +x=(\d+) y=(\d+)\]/g)].pop();
  const ex = 1920 * (0.53 + 60 / qw), ey = 720 * 0.76 - 20 * 720 / qh;
  chk(`${w}: la position finale suit le doigt (X ≈ ${Math.round(ex)}, Y ≈ ${Math.round(ey)}, à 40 près)`, !!lastUp && Math.abs(+lastUp[1] - ex) < 40 && Math.abs(+lastUp[2] - ey) < 40, t);
  chk(`${w}: l'anneau s'allume au toucher puis s'éteint`, ringOn && !(await p.$eval('#ring', (e) => e.classList.contains('on'))));
  chk(`${w}: le relâchement imprime « up »`, /\[id 1 up +x=\d+ y=\d+\]/.test(t), t);
  // deux doigts: seconde dalle simulée par pointerId différent via CDP touch
  const cdp = await p.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: qx + qw * 0.2, y: qy + qh * 0.5, id: 1 }, { x: qx + qw * 0.7, y: qy + qh * 0.5, id: 2 }] }); await wait(200);
  t = await term();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(200);
  chk(`${w}: deux doigts → count=2 avec deux identifiants`, /count=2 .*\[id 1 .*\[id 2 /.test(t), t);
  // clavier sur la dalle
  await p.focus('#pad'); await p.keyboard.press('Enter'); await wait(400);
  chk(`${w}: Entrée sur la dalle imprime un contact (équivalent clavier)`, /id 1 down x=960 y=360/.test(await term()));

  // vidéo
  const v = await p.evaluate(async () => {
    const el = document.querySelector('video'); el.scrollIntoView({ block: 'center' });
    await new Promise((r) => (el.readyState >= 1 ? r() : el.addEventListener('loadedmetadata', r, { once: true })));
    return { dur: el.duration, w: el.videoWidth, h: el.videoHeight, poster: el.poster, auto: el.autoplay, err: el.error && el.error.code };
  });
  chk(`${w}: vidéo lisible, durée ${v.dur && v.dur.toFixed(1)} s (20–40 s), ${v.w}×${v.h}`, v.dur > 20 && v.dur < 40 && v.w === 1920 && !v.err);
  chk(`${w}: affiche présente, pas de lecture automatique`, !!v.poster && !v.auto);
  const st = await fetch(base + 'presentation.mp4', { method: 'HEAD' }).then((r) => r.status);
  chk(`${w}: presentation.mp4 répond 200`, st === 200);

  // débordement et polices
  const ov = await p.evaluate((W) => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, W }), w);
  chk(`${w}: aucun débordement horizontal`, ov.sw <= w && ov.bw <= w, JSON.stringify(ov));
  chk(`${w}: aucun élément ne sort de la page`, await p.evaluate((W) => [...document.querySelectorAll('main *')].every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || (r.right <= W + 1 && r.left >= -1) || e.closest('.track'); }), w));
  const fontOk = await p.evaluate(async () => { await document.fonts.ready; return document.fonts.check('600 16px "Geist"'); });
  console.log((fontOk ? 'ok   ' : 'note ') + `${w}: police Geist ${fontOk ? 'chargée' : 'non chargée (hors ligne ou bloquée): repli système'}`);
  chk(`${w}: 0 erreur JS, 0 requête en échec`, errs.length === 0 && bad.length === 0, JSON.stringify([errs, bad]));
  if (shots) { await p.evaluate(() => scrollTo(0, 0)); await wait(1000); await p.screenshot({ path: `${shots}/hero-${w}.png` }); await p.screenshot({ path: `${shots}/full-${w}.png`, fullPage: true }); }
  await p.close();
}

// réduire les animations et sans JavaScript
{
  const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
  await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await p.goto(base, { waitUntil: 'load' }); await wait(150);
  const o = await p.$eval('.hero h1', (e) => getComputedStyle(e).opacity);
  chk('reduced-motion: le titre est visible dès 150 ms', o === '1', o);
  await p.close();
  const q = await b.newPage(); await q.setJavaScriptEnabled(false); await q.setViewport({ width: 1440, height: 900 });
  await q.goto(base, { waitUntil: 'load' }); await wait(1000);
  chk('sans JavaScript: les 9 captures restent atteignables (défilement horizontal) et les onglets sont masqués', await q.evaluate(() => { const bar = document.getElementById('bar'); return getComputedStyle(bar).overflowX === 'auto' && getComputedStyle(document.getElementById('tabs')).display === 'none' && bar.scrollWidth > bar.clientWidth; }));
  await q.close();
}
await b.close(); srv.close();
console.log(`\n${count} contrôles, ${fails} échec(s)`);
process.exit(fails ? 1 : 0);
