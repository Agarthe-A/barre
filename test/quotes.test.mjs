// Tests des cours Yahoo (réponses enregistrées, aucun accès réseau).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChart, creerServiceCours, intervalleCours, estPerime, paris, QUINZE_MIN, DEUX_H } from '../lib/quotes.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'yahoo');
const lire = (s) => JSON.parse(fs.readFileSync(path.join(FIX, `${s}.json`), 'utf8'));

test('Paris : dernier cours, clôture de la veille (pas chartPreviousClose), devise', () => {
  const q = parseChart(lire('AI.PA'), 'AI.PA');
  assert.equal(q.prix, 172.36);
  assert.equal(q.veille, 169.8); // clôture du jeudi, pas chartPreviousClose (167,9 = avant la période de 5 jours)
  assert.equal(q.devise, 'EUR');
  assert.equal(q.heure, Date.parse('2026-10-16T15:35:12Z'));
  assert.equal(q.place, 'PAR');
});

test('Londres en pence (GBp) : ramené en livres', () => {
  const q = parseChart(lire('SGLN.L'), 'SGLN.L');
  assert.equal(q.devise_cotation, 'GBp');
  assert.equal(q.devise, 'GBP');
  assert.equal(q.prix, 58.425);
  assert.equal(q.veille, 57.95);
});

test('Londres en dollars et taux de change', () => {
  const igln = parseChart(lire('IGLN.L'), 'IGLN.L');
  assert.equal(igln.devise, 'USD');
  assert.equal(igln.prix, 78.12);
  const fx = parseChart(lire('EURUSD=X'), 'EURUSD=X');
  assert.equal(fx.prix, 1.162);
  assert.equal(fx.veille, 1.158);
});

test('une seule séance dans la période : chartPreviousClose sert de veille', () => {
  const j = lire('TTE.PA');
  const r = j.chart.result[0];
  r.timestamp = r.timestamp.slice(-1);
  r.indicators.quote[0].close = r.indicators.quote[0].close.slice(-1);
  r.meta.chartPreviousClose = 56.95;
  assert.equal(parseChart(j).veille, 56.95);
});

test('séance du jour sans clôture encore (null) : prix = regularMarketPrice', () => {
  const j = lire('TTE.PA');
  j.chart.result[0].indicators.quote[0].close[4] = null;
  const q = parseChart(j);
  assert.equal(q.prix, 56.42);
  assert.equal(q.veille, 56.95);
});

test('réponse d’erreur Yahoo et réponse vide : erreur claire', () => {
  assert.throws(() => parseChart(lire('_404')), (e) => e.inconnu === true && /No data found/.test(e.message));
  assert.throws(() => parseChart({}), /réponse vide/);
  const j = lire('AI.PA');
  delete j.chart.result[0].meta.regularMarketPrice;
  j.chart.result[0].indicators.quote[0].close = [null, null, null, null, null];
  assert.throws(() => parseChart(j), /cours absent/);
});

// ---------------------------------------------------------------- service

const reponse = (status, corps) => ({ ok: status >= 200 && status < 300, status, json: async () => corps });

test('service : succès → cache mémoire + fichier (600) ; échec → dernier cours gardé et signalé', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cours-'));
  const fichierCache = path.join(dir, 'cours.json');
  let panne = false;
  const appels = [];
  const fetchImpl = async (url, opts) => {
    appels.push(url);
    assert.ok(opts.signal, 'délai obligatoire');
    assert.match(opts.headers['user-agent'], /Mozilla/);
    if (panne) throw new Error('getaddrinfo ENOTFOUND');
    const s = decodeURIComponent(url.match(/chart\/([^?]+)/)[1]);
    return reponse(200, lire(s));
  };
  const svc = creerServiceCours({ fichierCache, fetchImpl, ordre: ['yahoo'], espacement: 0 });
  const r = await svc.rafraichir(['AI.PA', 'EURUSD=X', 'ai.pa']);
  assert.deepEqual(r.map((x) => x.ok), [true, true]);
  assert.match(appels[0], /^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AI\.PA\?range=5d&interval=1d$/);
  assert.equal(svc.cours()['AI.PA'].prix, 172.36);
  assert.equal(fs.statSync(fichierCache).mode & 0o777, 0o600);
  // relu au redémarrage
  assert.equal(creerServiceCours({ fichierCache, fetchImpl }).cours()['EURUSD=X'].prix, 1.162);
  // panne réseau : le cours reste, marqué en échec, pas d'exception
  panne = true;
  const r2 = await svc.rafraichir(['AI.PA']);
  assert.equal(r2[0].ok, false);
  assert.equal(svc.cours()['AI.PA'].prix, 172.36);
  assert.match(svc.cours()['AI.PA'].echec, /ENOTFOUND/);
  assert.ok(svc.erreurs()['AI.PA']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('service : une requête par titre et par rafraîchissement (query2 au suivant), pas de 2e essai pour un symbole inconnu, symbole invalide refusé', async () => {
  let t = Date.parse('2026-10-16T10:00:00Z');
  const appels = [];
  const fetchImpl = async (url) => {
    appels.push(url);
    if (url.includes('INCONNU')) return reponse(404, lire('_404'));
    if (url.startsWith('https://query1')) return reponse(500, {});
    return reponse(200, lire('TTE.PA'));
  };
  const svc = creerServiceCours({ fetchImpl, ordre: ['yahoo'], horloge: () => t, espacement: 0 });
  const r = await svc.rafraichir(['TTE.PA', 'INCONNU.PA', 'AI.PA;rm']);
  assert.deepEqual(r.map((x) => x.ok), [false, false, false]);
  assert.equal(r[0].erreur, 'HTTP 500');
  assert.equal(appels.filter((u) => u.includes('TTE.PA')).length, 1);
  assert.equal(appels.filter((u) => u.includes('INCONNU')).length, 1);
  assert.ok(!appels.some((u) => u.includes(';')));
  assert.equal(svc.erreurs()['INCONNU.PA'].inconnu, true);
  // Yahoo en pause 30 min pour ce titre : aucune requête entre-temps…
  assert.match((await svc.rafraichir(['TTE.PA']))[0].erreur, /^sources en pause jusqu'à 12:30$/);
  assert.equal(appels.filter((u) => u.includes('TTE.PA')).length, 1);
  // … puis l'essai suivant passe par query2.
  t += 31 * 60000;
  assert.equal((await svc.rafraichir(['TTE.PA']))[0].ok, true);
  assert.match(appels.at(-1), /^https:\/\/query2\.finance\.yahoo\.com\/v8\/finance\/chart\/TTE\.PA/);
  assert.equal(svc.cours()['TTE.PA'].source, 'yahoo');
});

test('service : délai dépassé → erreur « délai dépassé », sans planter', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
  const svc = creerServiceCours({ fetchImpl, delai: 30 });
  // Les minuteurs d'AbortSignal.timeout ne retiennent pas Node (le serveur, lui, tourne).
  const garde = setTimeout(() => {}, 2000);
  const r = await svc.rafraichir(['AI.PA']);
  clearTimeout(garde);
  assert.equal(r[0].ok, false);
  assert.equal(r[0].erreur, 'délai dépassé');
});

test('service : mode réponses enregistrées (fixtures)', async () => {
  const svc = creerServiceCours({ fixtures: FIX });
  const r = await svc.rafraichir(['IGLN.L', 'NEXISTEPAS.PA']);
  assert.deepEqual(r.map((x) => x.ok), [true, false]);
  assert.equal(svc.cours()['IGLN.L'].devise, 'USD');
});

// ---------------------------------------------------------------- rythme et ancienneté

test('rythme : 15 min en semaine 9:00–17:45 (Paris), 2 h sinon, heure d’été comprise', () => {
  const i = (iso) => intervalleCours(new Date(iso));
  assert.equal(i('2026-10-12T07:00:00Z'), QUINZE_MIN); // lun. 9:00 (UTC+2)
  assert.equal(i('2026-10-12T06:59:00Z'), DEUX_H); // lun. 8:59
  assert.equal(i('2026-10-16T15:45:00Z'), QUINZE_MIN); // ven. 17:45
  assert.equal(i('2026-10-16T15:46:00Z'), DEUX_H); // ven. 17:46
  assert.equal(i('2026-10-17T09:00:00Z'), DEUX_H); // samedi
  assert.equal(i('2026-10-18T09:00:00Z'), DEUX_H); // dimanche
  assert.equal(i('2026-01-12T08:30:00Z'), QUINZE_MIN); // hiver (UTC+1) : 9:30
  assert.equal(i('2026-01-12T07:30:00Z'), DEUX_H); // hiver : 8:30
  assert.deepEqual(paris(new Date('2026-03-29T01:30:00Z')), { date: '2026-03-29', h: 3, min: 30, wd: 0 }); // passage à l'heure d'été
});

test('ancienneté : plus de 4 jours, ou mises à jour en échec depuis 1 h (séance) / 5 h (hors séance)', () => {
  const lundi10h = Date.parse('2026-10-12T08:00:00Z');
  const q = (heure, recupere) => ({ heure, recupere_le: recupere });
  assert.equal(estPerime(null, lundi10h), true);
  assert.equal(estPerime(q(lundi10h - 10 * 60000, lundi10h - 60000), lundi10h), false);
  assert.equal(estPerime(q(Date.parse('2026-10-09T15:35:00Z'), lundi10h - 60000), lundi10h), false); // vendredi soir, lu lundi
  assert.equal(estPerime(q(lundi10h - 5 * 86400000, lundi10h), lundi10h), true);
  assert.equal(estPerime(q(lundi10h - 3600000, lundi10h - 61 * 60000), lundi10h), true);
  const samedi = Date.parse('2026-10-17T10:00:00Z');
  assert.equal(estPerime(q(Date.parse('2026-10-16T15:35:00Z'), samedi - 4 * 3600000), samedi), false);
  assert.equal(estPerime(q(Date.parse('2026-10-16T15:35:00Z'), samedi - 6 * 3600000), samedi), true);
  // ouverture : à 9:00:30, dernière lecture à 7:45 (rythme de nuit) → pas ancien
  const vendrediSoir = Date.parse('2026-10-09T15:35:00Z');
  const lu745 = Date.parse('2026-10-12T05:45:00Z');
  assert.equal(estPerime(q(vendrediSoir, lu745), Date.parse('2026-10-12T07:00:30Z')), false);
  // … mais ancien si les lectures échouent depuis plus d'1 h de séance
  assert.equal(estPerime(q(vendrediSoir, lu745), Date.parse('2026-10-12T08:01:00Z')), true);
});
