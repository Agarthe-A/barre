// Tests des sources de cours (réponses réelles enregistrées le 17/10/2026 dans
// test/fixtures/sources, aucun accès réseau) et des pauses entre requêtes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBoursorama, parseLse, parseTradegate, parseBce, parseFrankfurter, nombre, chaineSources,
  derniereSeance, heureParis, HORAIRES, creerServiceCours, ORDRE_DEFAUT
} from '../lib/quotes.mjs';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(ICI, 'fixtures', 'sources');
const YAHOO = path.join(ICI, 'fixtures', 'yahoo');
const texte = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const json = (f) => JSON.parse(texte(f));

const SAMEDI = Date.parse('2026-10-17T10:00:00Z'); // 12:00 à Paris
const VENDREDI_11H = Date.parse('2026-10-16T09:00:00Z');
const CLOTURE_PARIS_VENDREDI = Date.parse('2026-10-16T15:35:00Z'); // 17:35 à Paris

// ---------------------------------------------------------------- lecture des réponses

test('Boursorama : dernier cours, veille = cours − variation (en euros), jour de séance', () => {
  const ai = parseBoursorama(json('boursorama_AI.PA.json'), 'AI.PA', { now: SAMEDI });
  assert.equal(ai.prix, 173.16);
  assert.equal(ai.veille, 173.04);
  assert.equal(ai.devise, 'EUR');
  assert.equal(ai.heure, CLOTURE_PARIS_VENDREDI);
  // « var » à 3 décimales : clôture veille 7,164 affichée par Boursorama
  const wpea = parseBoursorama(json('boursorama_WPEA.PA.json'), 'WPEA.PA', { now: SAMEDI });
  assert.equal(wpea.prix, 7.153);
  assert.equal(wpea.veille, 7.164);
  // en séance le jour même : l'heure est celle de la lecture
  assert.equal(parseBoursorama(json('boursorama_TTE.PA.json'), 'TTE.PA', { now: VENDREDI_11H }).heure, VENDREDI_11H);
});

test('Boursorama : inconnu, champs manquants', () => {
  assert.throws(() => parseBoursorama(json('boursorama_inconnu.json'), 'ZZZ.PA'), (e) => e.inconnu === true);
  assert.throws(() => parseBoursorama({ d: [] }, 'ZZZ.PA'), (e) => e.inconnu === true);
  assert.throws(() => parseBoursorama({ d: [{ c: null }] }, 'AI.PA'), /cours absent/);
  const sansVar = parseBoursorama({ d: [{ c: '60,35' }] }, 'PSP5.PA', { now: SAMEDI });
  assert.equal(sansVar.prix, 60.35);
  assert.equal(sansVar.veille, null);
  assert.equal(sansVar.heure, CLOTURE_PARIS_VENDREDI); // pas de date : dernière séance
});

test('LSE : dollars, pence (GBX) ramenés en livres, heure UTC, veille = previousreferenceprice', () => {
  const igln = parseLse(json('lse_IGLN.json'), 'IGLN.L', { isin: 'IE00B4ND3602' });
  assert.equal(igln.prix, 81.015);
  assert.equal(igln.veille, 80.585);
  assert.equal(igln.devise, 'USD');
  assert.equal(igln.heure, Date.parse('2026-10-16T15:35:13Z'));
  const sgln = parseLse(json('lse_SGLN.json'), 'SGLN.L');
  assert.equal(sgln.devise_cotation, 'GBX');
  assert.equal(sgln.devise, 'GBP');
  assert.equal(sgln.prix, 60.72);
  assert.equal(sgln.veille, 60.79);
});

test('LSE : autre ISIN refusé, devise ou cours manquants, veille de secours', () => {
  assert.throws(() => parseLse(json('lse_IGLN.json'), 'IGLN.L', { isin: 'IE00BQQP9F84' }), (e) => e.inconnu && /IE00B4ND3602/.test(e.message));
  const j = json('lse_IGLN.json');
  delete j.currency;
  assert.throws(() => parseLse(j, 'IGLN.L'), /devise absente/);
  const k = json('lse_IGLN.json');
  k.lastprice = null;
  k.lastclosedate = null;
  assert.throws(() => parseLse(k, 'IGLN.L'), /cours absent/);
  const v = json('lse_IGLN.json');
  delete v.previousreferenceprice;
  assert.equal(parseLse(v, 'IGLN.L').veille, 80.585); // lastprice − netchange
  assert.throws(() => parseLse(null, 'IGLN.L'), /réponse vide/);
});

test('Tradegate : euros, nombres à l’allemande, heure = dernière séance (8:00–22:00)', () => {
  const ai = parseTradegate(json('tradegate_FR0000120073.json'), 'AI.PA', { now: SAMEDI });
  assert.equal(ai.prix, 171.76);
  assert.equal(ai.veille, 173.42);
  assert.equal(ai.devise, 'EUR');
  assert.equal(ai.heure_estimee, true);
  assert.equal(ai.heure, Date.parse('2026-10-16T20:00:00Z')); // vendredi 22:00 à Paris
  assert.equal(parseTradegate(json('tradegate_IE00BQQP9F84.json'), 'GDX.L', { now: VENDREDI_11H }).heure, VENDREDI_11H);
  // sans dernier cours : milieu de fourchette ; chaînes « 172,10 »
  assert.equal(parseTradegate({ bid: '171,90', ask: '172,10' }, 'AI.PA', { now: SAMEDI }).prix, 172);
  assert.throws(() => parseTradegate(undefined, 'AI.PA'), (e) => e.inconnu === true); // corps vide = ISIN inconnu
  assert.throws(() => parseTradegate({ bid: 0, ask: 0 }, 'AI.PA'), /cours absent/);
  assert.equal(nombre('+0,30'), 0.3);
  assert.equal(nombre('1.234,5'), 1234.5);
  assert.equal(nombre(6.10E+3), 6100);
  assert.ok(Number.isNaN(nombre('12 €')));
  assert.ok(Number.isNaN(nombre(null)));
});

test('BCE (CSV) et Frankfurter : dernier taux, veille, 14:15 à Paris', () => {
  const bce = parseBce(texte('bce_USD.csv'), 'EURUSD=X');
  assert.equal(bce.prix, 1.1253);
  assert.equal(bce.veille, 1.1208);
  assert.equal(bce.devise, 'USD');
  assert.equal(bce.heure, Date.parse('2026-10-16T12:15:00Z'));
  assert.throws(() => parseBce(texte('bce_USD.csv'), 'EURGBP=X'), (e) => e.inconnu === true);
  assert.throws(() => parseBce('', 'EURUSD=X'), (e) => e.inconnu === true);
  assert.throws(() => parseBce('a,b\n1,2', 'EURUSD=X'), /illisible/);
  const usd = parseFrankfurter(json('frankfurter_serie.json'), 'EURUSD=X');
  assert.deepEqual([usd.prix, usd.veille, usd.heure], [1.1253, 1.1208, Date.parse('2026-10-16T12:15:00Z')]);
  const gbp = parseFrankfurter(json('frankfurter_serie.json'), 'EURGBP=X');
  assert.deepEqual([gbp.prix, gbp.veille], [0.84385, 0.8461]);
  const dernier = parseFrankfurter(json('frankfurter_latest.json'), 'EURUSD=X');
  assert.deepEqual([dernier.prix, dernier.veille], [1.1253, null]);
  assert.throws(() => parseFrankfurter(json('frankfurter_serie.json'), 'EURJPY=X'), (e) => e.inconnu === true);
  assert.throws(() => parseFrankfurter({}, 'EURUSD=X'), /réponse vide/);
});

test('heures de Paris : séance en cours, avant l’ouverture, week-end, heure d’hiver', () => {
  assert.equal(heureParis('2026-10-16', 17 * 60 + 35), Date.parse('2026-10-16T15:35:00Z'));
  assert.equal(heureParis('2026-12-04', 17 * 60 + 35), Date.parse('2026-12-04T16:35:00Z'));
  const lundi7h = Date.parse('2026-10-19T05:00:00Z');
  assert.equal(derniereSeance(lundi7h, HORAIRES.tradegate), Date.parse('2026-10-16T20:00:00Z'));
  assert.equal(derniereSeance(Date.parse('2026-10-19T07:00:00Z'), HORAIRES.tradegate), Date.parse('2026-10-19T07:00:00Z'));
  assert.equal(derniereSeance(Date.parse('2026-10-19T19:00:00Z'), HORAIRES.paris), Date.parse('2026-10-19T15:35:00Z'));
});

test('ordre des sources : par défaut, par place, par symbole, tableau, noms inconnus ignorés', () => {
  assert.deepEqual(chaineSources('AI.PA'), ['boursorama', 'tradegate', 'yahoo']);
  assert.deepEqual(chaineSources('IGLN.L'), ['lse', 'tradegate', 'yahoo']);
  assert.deepEqual(chaineSources('EURUSD=X'), ['bce', 'frankfurter', 'yahoo']);
  assert.deepEqual(chaineSources('SAP.DE'), ORDRE_DEFAUT['*']);
  const perso = { PA: ['tradegate', 'boursorama'], 'AI.PA': ['yahoo'], FX: ['nimporte', 'frankfurter'], L: [] };
  assert.deepEqual(chaineSources('TTE.PA', perso), ['tradegate', 'boursorama']);
  assert.deepEqual(chaineSources('AI.PA', perso), ['yahoo']);
  assert.deepEqual(chaineSources('EURGBP=X', perso), ['frankfurter']);
  assert.deepEqual(chaineSources('IGLN.L', perso), ['lse', 'tradegate', 'yahoo']); // liste vide : défaut
  assert.deepEqual(chaineSources('IGLN.L', { '*': ['yahoo'] }), ['yahoo']);
  assert.deepEqual(chaineSources('AI.PA', ['yahoo', 'yahoo']), ['yahoo']);
  assert.deepEqual(chaineSources('AI.PA', { constructor: ['yahoo'] }), ORDRE_DEFAUT.PA);
});

// ---------------------------------------------------------------- service

const INFOS = {
  'PSP5.PA': { isin: 'FR0011871128' }, 'WPEA.PA': { isin: 'IE0002XZSHO1' }, 'AI.PA': { isin: 'FR0000120073' },
  'TTE.PA': { isin: 'FR0000120271' }, 'IGLN.L': { isin: 'IE00B4ND3602' }, 'GDX.L': { isin: 'IE00BQQP9F84' }
};
const TOUS = ['PSP5.PA', 'WPEA.PA', 'AI.PA', 'TTE.PA', 'IGLN.L', 'GDX.L', 'EURUSD=X', 'EURGBP=X'];
const BOURSO = { '1rPAI': 'AI.PA', '1rPTTE': 'TTE.PA', '1rTPSP5': 'PSP5.PA', '1rTWPEA': 'WPEA.PA' };

const rep = (status, corps = '') => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof corps === 'string' ? corps : JSON.stringify(corps)) });

// Réponses enregistrées, routées comme les vrais serveurs.
function reponseEnregistree(url) {
  let m;
  if ((m = /boursorama\.com\/.*UpdateCharts\?symbol=([A-Za-z0-9]+)&period=-1$/.exec(url))) {
    return rep(200, BOURSO[m[1]] ? texte(`boursorama_${BOURSO[m[1]]}.json`) : '[]');
  }
  if ((m = /api\.londonstockexchange\.com\/api\/gw\/lse\/instruments\/alldata\/([A-Z0-9]+)$/.exec(url))) {
    if (m[1] === 'GDX') return rep(200, { ...json('lse_IGLN.json'), tidm: 'GDX', isin: 'IE00BQQP9F84', name: 'VANECK GOLD MINERS UCITS ETF', lastprice: 99.6, lastpricedate: '2026-10-16T15:54:07.000', previousreferenceprice: 97.44 });
    return fs.existsSync(path.join(FIX, `lse_${m[1]}.json`)) ? rep(200, texte(`lse_${m[1]}.json`)) : rep(404, texte('lse_inconnu.json'));
  }
  if ((m = /tradegatebsx\.com\/refresh\.php\?isin=([A-Z0-9]{12})$/.exec(url))) {
    return rep(200, fs.existsSync(path.join(FIX, `tradegate_${m[1]}.json`)) ? texte(`tradegate_${m[1]}.json`) : '');
  }
  if ((m = /data-api\.ecb\.europa\.eu\/service\/data\/EXR\/D\.([A-Z]{3})\.EUR\.SP00\.A\?lastNObservations=2&format=csvdata$/.exec(url))) {
    if (m[1] === 'USD') return rep(200, texte('bce_USD.csv'));
    if (m[1] === 'GBP') return rep(200, texte('bce_USD.csv').replace(/USD/g, 'GBP').replace(/US dollar/g, 'Pound sterling').replace('1.1208', '0.8461').replace('1.1253', '0.84385'));
    return rep(404, 'No results found.');
  }
  if (/api\.frankfurter\.dev\/v1\/\d{4}-\d{2}-\d{2}\.\.\?base=EUR&symbols=[A-Z]{3}$/.test(url)) return rep(200, texte('frankfurter_serie.json'));
  if ((m = /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/([^?]+)\?range=5d&interval=1d$/.exec(url))) {
    const f = path.join(YAHOO, `${decodeURIComponent(m[1])}.json`);
    return fs.existsSync(f) ? rep(200, fs.readFileSync(f, 'utf8')) : rep(404, fs.readFileSync(path.join(YAHOO, '_404.json'), 'utf8'));
  }
  throw new Error(`URL inattendue : ${url}`);
}

// regles : [motif d'URL, (url) => réponse | undefined] essayées avant les réponses enregistrées.
function reseau(regles = []) {
  const appels = [];
  const fetchImpl = async (url, opts) => {
    appels.push(url);
    assert.ok(opts.signal, 'délai obligatoire');
    assert.match(opts.headers['user-agent'], /Mozilla/);
    for (const [motif, f] of regles) if (motif.test(url)) { const r = await f(url); if (r) return r; }
    return reponseEnregistree(url);
  };
  const vers = (motif) => appels.filter((u) => motif.test(u));
  return { appels, fetchImpl, vers };
}

const dossier = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sources-'));
const parTitre = (appels) => {
  const n = {};
  for (const u of appels) {
    const cle = Object.keys(BOURSO).find((c) => u.includes(`symbol=${c}&`)) ? BOURSO[Object.keys(BOURSO).find((c) => u.includes(`symbol=${c}&`))]
      : (/isin=([A-Z0-9]+)/.exec(u) || [])[1] || (/alldata\/([A-Z]+)/.exec(u) || [])[1] || (/D\.([A-Z]{3})\.EUR/.exec(u) || [])[1] || u;
    n[cle] = (n[cle] || 0) + 1;
  }
  return n;
};

test('service : chaque titre lu par sa première source, une seule requête chacun, cache 600 avec les pauses', async () => {
  const dir = dossier();
  const fichierCache = path.join(dir, 'cours.json');
  const net = reseau();
  const svc = creerServiceCours({ fichierCache, fetchImpl: net.fetchImpl, horloge: () => SAMEDI, espacement: 0 });
  const r = await svc.rafraichir(TOUS, INFOS);
  assert.deepEqual(r.map((x) => [x.symbole, x.ok, x.source]), [
    ['PSP5.PA', true, 'boursorama'], ['WPEA.PA', true, 'boursorama'], ['AI.PA', true, 'boursorama'], ['TTE.PA', true, 'boursorama'],
    ['IGLN.L', true, 'lse'], ['GDX.L', true, 'lse'], ['EURUSD=X', true, 'bce'], ['EURGBP=X', true, 'bce']
  ]);
  assert.equal(net.appels.length, TOUS.length);
  assert.ok(net.appels.some((u) => u.endsWith('UpdateCharts?symbol=1rTPSP5&period=-1')));
  const c = svc.cours();
  assert.deepEqual([c['PSP5.PA'].prix, c['PSP5.PA'].veille], [60.35, 60.62]);
  assert.deepEqual([c['GDX.L'].prix, c['GDX.L'].devise], [99.6, 'USD']);
  assert.deepEqual([c['EURGBP=X'].prix, c['EURGBP=X'].veille], [0.84385, 0.8461]);
  assert.equal(c['TTE.PA'].recupere_le, SAMEDI);
  assert.equal(fs.statSync(fichierCache).mode & 0o777, 0o600);
  const disque = JSON.parse(fs.readFileSync(fichierCache, 'utf8'));
  assert.equal(disque.cours['AI.PA'].source, 'boursorama');
  assert.deepEqual(Object.keys(disque.sources), ['bloc', 'paire']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('service : HTTP 429 → source en pause 1 h (gardée au redémarrage), les titres en attente passent à la suivante, puis 2 h', async () => {
  const dir = dossier();
  const fichierCache = path.join(dir, 'cours.json');
  let t = Date.parse('2026-10-16T08:00:00Z'); // vendredi 10:00
  let refus = true;
  const net = reseau([[/boursorama/, () => (refus ? rep(429, '<html>Too Many Requests</html>') : undefined)]]);
  const paris = ['AI.PA', 'PSP5.PA', 'TTE.PA'];
  let svc = creerServiceCours({ fichierCache, fetchImpl: net.fetchImpl, horloge: () => t, espacement: 0 });
  let r = await svc.rafraichir(paris, INFOS);
  // AI.PA a pris le 429 ; PSP5 attendait son tour : lu sur Tradegate ; TTE.PA : Tradegate ne le connaît pas.
  assert.deepEqual(r.map((x) => [x.ok, x.source || x.erreur]), [[false, 'HTTP 429'], [true, 'tradegate'], [false, 'ISIN inconnu']]);
  assert.equal(net.vers(/boursorama/).length, 1);
  for (const [, n] of Object.entries(parTitre(net.appels))) assert.equal(n, 1);
  let etat = svc.etatSources();
  assert.equal(etat.bloc.boursorama.jusqua, t + 3600000);
  assert.equal(etat.bloc.boursorama.niveau, 1);
  assert.equal(svc.erreurs()['AI.PA'].source, 'boursorama');

  // 15 min plus tard, après un redémarrage : Boursorama n'est pas rappelée.
  t += 15 * 60000;
  svc = creerServiceCours({ fichierCache, fetchImpl: net.fetchImpl, horloge: () => t, espacement: 0 });
  net.appels.length = 0;
  r = await svc.rafraichir(['AI.PA', 'PSP5.PA'], INFOS);
  assert.deepEqual(r.map((x) => x.source), ['tradegate', 'tradegate']);
  assert.equal(net.vers(/boursorama/).length, 0);

  // Pause finie, refus encore : 2 h.
  t += 50 * 60000;
  net.appels.length = 0;
  await svc.rafraichir(['AI.PA'], INFOS);
  assert.equal(net.vers(/boursorama/).length, 1);
  etat = svc.etatSources();
  assert.equal(etat.bloc.boursorama.niveau, 2);
  assert.equal(etat.bloc.boursorama.jusqua, t + 2 * 3600000);

  // Pause finie, la source répond : pause effacée.
  t += 2 * 3600000 + 1000;
  refus = false;
  r = await svc.rafraichir(['AI.PA'], INFOS);
  assert.equal(r[0].source, 'boursorama');
  assert.equal(svc.etatSources().bloc.boursorama, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('service : 403 compte comme un refus ; tout en pause → aucune requête, dernier cours gardé', async () => {
  let t = SAMEDI;
  const net = reseau([[/yahoo|boursorama|tradegate/, () => rep(403, 'Forbidden')]]);
  const svc = creerServiceCours({ fetchImpl: net.fetchImpl, horloge: () => t, espacement: 0 });
  // 3 rafraîchissements : Boursorama, Tradegate, Yahoo refusent tour à tour.
  for (let i = 0; i < 3; i++) { await svc.rafraichir(['AI.PA'], INFOS); t += 60000; }
  assert.deepEqual(net.appels.map((u) => new URL(u).hostname), ['www.boursorama.com', 'www.tradegatebsx.com', 'query1.finance.yahoo.com']);
  const r = await svc.rafraichir(['AI.PA'], INFOS);
  assert.equal(r[0].ok, false);
  assert.match(r[0].erreur, /^sources en pause jusqu'à 13:00$/); // Boursorama : 12:00 + 1 h
  assert.equal(net.appels.length, 3);
});

test('service : panne (500) → dernier cours gardé, source suivante au rafraîchissement d’après, retour après 30 min', async () => {
  let t = Date.parse('2026-10-16T08:00:00Z');
  let panne = false;
  const net = reseau([[/londonstockexchange/, () => (panne ? rep(503, 'Service Unavailable') : undefined)]]);
  const svc = creerServiceCours({ fetchImpl: net.fetchImpl, horloge: () => t, espacement: 0 });
  await svc.rafraichir(['IGLN.L'], INFOS);
  assert.equal(svc.cours()['IGLN.L'].prix, 81.015);
  panne = true;
  t += 15 * 60000;
  let r = await svc.rafraichir(['IGLN.L'], INFOS);
  assert.equal(r[0].erreur, 'HTTP 503');
  assert.equal(svc.cours()['IGLN.L'].prix, 81.015); // dernier cours gardé…
  assert.equal(svc.cours()['IGLN.L'].echec, 'HTTP 503'); // … et signalé
  t += 15 * 60000;
  r = await svc.rafraichir(['IGLN.L'], INFOS);
  assert.equal(r[0].source, 'tradegate');
  assert.deepEqual([svc.cours()['IGLN.L'].prix, svc.cours()['IGLN.L'].devise], [72.05, 'EUR']);
  assert.equal(svc.cours()['IGLN.L'].echec, undefined);
  panne = false;
  t += 16 * 60000; // 31 min après la panne
  r = await svc.rafraichir(['IGLN.L'], INFOS);
  assert.equal(r[0].source, 'lse');
  assert.equal(net.vers(/londonstockexchange/).length, 3);
});

test('service : délai dépassé sur une source → les titres suivants passent à la suivante dans le même rafraîchissement', async () => {
  const net = reseau();
  // Boursorama ne répond pas pour AI.PA (jusqu'à l'expiration du délai).
  const fetchImpl = (url, opts) => {
    if (url.includes('1rPAI')) {
      net.appels.push(url);
      return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason)));
    }
    return net.fetchImpl(url, opts);
  };
  const svc = creerServiceCours({ fetchImpl, horloge: () => SAMEDI, espacement: 0, delai: 30 });
  const garde = setTimeout(() => {}, 2000);
  const r = await svc.rafraichir(['AI.PA', 'PSP5.PA'], INFOS);
  clearTimeout(garde);
  assert.deepEqual(r.map((x) => x.ok ? x.source : x.erreur), ['délai dépassé', 'tradegate']);
  assert.equal(net.vers(/boursorama/).length, 1);
});

test('service : réseau de la maison coupé (ENOTFOUND) → pas de pause, même source au rafraîchissement suivant', async () => {
  let t = SAMEDI;
  let coupe = true;
  const net = reseau([[/./, () => {
    if (coupe) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    return undefined;
  }]]);
  const svc = creerServiceCours({ fetchImpl: net.fetchImpl, horloge: () => t, espacement: 0 });
  const r = await svc.rafraichir(['AI.PA', 'PSP5.PA', 'EURUSD=X'], INFOS);
  assert.deepEqual(r.map((x) => x.erreur), ['fetch failed (ENOTFOUND)', 'fetch failed (ENOTFOUND)', 'fetch failed (ENOTFOUND)']);
  // une requête par titre au plus (PSP5 attendait Boursorama : passé à Tradegate)
  assert.equal(net.appels.length, 3);
  assert.deepEqual(svc.etatSources().paire, {});
  coupe = false;
  t += 15 * 60000;
  const r2 = await svc.rafraichir(['AI.PA', 'PSP5.PA', 'EURUSD=X'], INFOS);
  assert.deepEqual(r2.map((x) => x.source), ['boursorama', 'boursorama', 'bce']);
});

test('service : titre de Paris sans code connu → 1rP puis 1rT au rafraîchissement suivant, code retenu', async () => {
  const dir = dossier();
  const fichierCache = path.join(dir, 'cours.json');
  let t = SAMEDI;
  const net = reseau([[/symbol=1rTESE&/, () => rep(200, texte('boursorama_WPEA.PA.json'))]]);
  const infos = { 'ESE.PA': { isin: 'FR0011550185' } };
  let svc = creerServiceCours({ fichierCache, fetchImpl: net.fetchImpl, horloge: () => t, espacement: 0 });
  let r = await svc.rafraichir(['ESE.PA'], infos);
  assert.equal(r[0].ok, false);
  assert.equal(r[0].erreur, 'symbole inconnu');
  t += 15 * 60000;
  r = await svc.rafraichir(['ESE.PA'], infos);
  assert.equal(r[0].source, 'boursorama');
  // après redémarrage, le bon code d'emblée
  svc = creerServiceCours({ fichierCache, fetchImpl: net.fetchImpl, horloge: () => t, espacement: 0 });
  await svc.rafraichir(['ESE.PA'], infos);
  assert.deepEqual(net.vers(/boursorama/).map((u) => /symbol=(\w+)/.exec(u)[1]), ['1rPESE', '1rTESE', '1rTESE']);
  // inconnu partout : pause de 6 h par source, puis plus aucune requête
  net.appels.length = 0;
  const z = { 'ZZZ.PA': { isin: 'FR0000000001' } };
  for (let i = 0; i < 5; i++) { await svc.rafraichir(['ZZZ.PA'], z); t += 60000; }
  assert.deepEqual(net.appels.map((u) => new URL(u).hostname), ['www.boursorama.com', 'www.boursorama.com', 'www.tradegatebsx.com', 'query1.finance.yahoo.com']);
  assert.equal(svc.erreurs()['ZZZ.PA'].inconnu, false); // « sources en pause »
  fs.rmSync(dir, { recursive: true, force: true });
});

test('service : requêtes vers une même source espacées, jamais simultanées', async () => {
  let enCours = 0;
  let max = 0;
  const instants = [];
  const fetchImpl = async (url) => {
    enCours++;
    max = Math.max(max, enCours);
    instants.push(Date.now());
    await new Promise((r) => setTimeout(r, 5));
    enCours--;
    return reponseEnregistree(url);
  };
  const svc = creerServiceCours({ fetchImpl, espacement: 40 });
  const r = await svc.rafraichir(['AI.PA', 'TTE.PA', 'PSP5.PA'], INFOS);
  assert.ok(r.every((x) => x.ok));
  assert.equal(max, 1);
  for (let i = 1; i < instants.length; i++) assert.ok(instants[i] - instants[i - 1] >= 40, `écart ${instants[i] - instants[i - 1]} ms`);
});

test('service : ancien cache (sans pauses) et pauses illisibles acceptés', () => {
  const dir = dossier();
  const f = path.join(dir, 'cours.json');
  fs.writeFileSync(f, JSON.stringify({ cours: { 'AI.PA': { prix: 1, heure: 1 } } }));
  assert.equal(creerServiceCours({ fichierCache: f }).cours()['AI.PA'].prix, 1);
  fs.writeFileSync(f, JSON.stringify({ cours: {}, sources: { bloc: { nimporte: { jusqua: 1 }, yahoo: 'x', lse: { jusqua: 5, niveau: 1 } }, paire: { 'lse|__proto__': {}, 'bce|EURUSD=X': { n: 1, jusqua: 9 } } } }));
  const etat = creerServiceCours({ fichierCache: f }).etatSources();
  assert.deepEqual(Object.keys(etat.bloc), ['lse']);
  assert.deepEqual(Object.keys(etat.paire), ['bce|EURUSD=X']);
  fs.rmSync(dir, { recursive: true, force: true });
});
