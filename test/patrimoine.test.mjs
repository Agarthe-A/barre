// Tests du modèle : PRU, ventes, liquidités, validation, calculs, échéances.
// node --test   (depuis la racine du projet)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  squelette, normaliser, appliquerOperation, annulerDerniere, modifierLigne, fixerLiquidites, fixerCible,
  calculer, resoudreLigne, chargerFichier, ecrireFichier, versJsonStable, symbolesNecessaires, ajouterAns, r2
} from '../lib/patrimoine.mjs';
import { parseChart } from '../lib/quotes.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'yahoo');
// Vendredi 16 octobre 2026, 18:00 à Paris (après la clôture).
const MAINTENANT = new Date('2026-10-16T16:00:00Z');

const base = () => normaliser(squelette());
const avec = (data, id, champs) => { Object.assign(data.lignes.find((l) => l.id === id), champs); return data; };
const ligne = (data, id) => data.lignes.find((l) => l.id === id);
const op = (data, body) => appliquerOperation(data, body, { maintenant: MAINTENANT });
const cours = (...symboles) => Object.fromEntries(symboles.map((s) => {
  const q = parseChart(JSON.parse(fs.readFileSync(path.join(FIX, `${s}.json`), 'utf8')), s);
  return [s, { ...q, recupere_le: MAINTENANT.getTime() - 10 * 60000 }];
}));

// ---------------------------------------------------------------- PRU et opérations

test('achat sur ligne vide : PRU = (q × prix + frais) / q', () => {
  const r = op(base(), { sens: 'achat', titre: 'TTE.PA', quantite: 40, prix: 60, frais: 2 });
  const l = ligne(r.data, 'pea-tte');
  assert.equal(l.quantite, 40);
  assert.equal(l.pru, 60.05);
  assert.equal(r.operation.montant, 2402);
  assert.equal(r.data.liquidites.pea.EUR, -2402);
});

test('achat sur ligne existante : PRU moyen pondéré, frais compris', () => {
  const d = avec(base(), 'pea-ai-swing', { quantite: 33, pru: 170 });
  const r = op(d, { sens: 'achat', titre: 'air liquide', quantite: 10, prix: 180, frais: 2 });
  const l = ligne(r.data, 'pea-ai-swing');
  assert.equal(l.quantite, 43);
  assert.equal(l.pru, Math.round(((33 * 170 + 1800 + 2) / 43) * 1e4) / 1e4);
  assert.equal(l.pru, 172.3721);
  // la copie : les données d'origine ne bougent pas
  assert.equal(ligne(d, 'pea-ai-swing').quantite, 33);
});

test('achat sans PRU connu : le PRU reste à renseigner (avertissement)', () => {
  const d = avec(base(), 'pea-tte', { quantite: 50, pru: null });
  const r = op(d, { sens: 'achat', titre: 'total', quantite: 10, prix: 55 });
  assert.equal(ligne(r.data, 'pea-tte').pru, null);
  assert.equal(ligne(r.data, 'pea-tte').quantite, 60);
  assert.match(r.avertissements.join(' '), /PRU .* inconnu/);
});

test('vente : PRU inchangé, plus-value réalisée = q × (prix − PRU) − frais', () => {
  const d = avec(base(), 'pea-tte', { quantite: 100, pru: 58.1 });
  d.liquidites.pea.EUR = 100;
  const r = op(d, { sens: 'vente', titre: 'TTE', quantite: 30, prix: 62, frais: 1.5 });
  const l = ligne(r.data, 'pea-tte');
  assert.equal(l.quantite, 70);
  assert.equal(l.pru, 58.1);
  assert.equal(r.operation.plus_value, r2(30 * (62 - 58.1) - 1.5));
  assert.equal(r.operation.plus_value, 115.5);
  assert.equal(r.data.liquidites.pea.EUR, r2(100 + 30 * 62 - 1.5));
});

test('vente perdante et vente totale', () => {
  const d = avec(base(), 'pea-tte', { quantite: 10, pru: 60 });
  const r = op(d, { sens: 'vente', titre: 'TTE.PA', quantite: 10, prix: 55 });
  assert.equal(r.operation.plus_value, -50);
  assert.equal(ligne(r.data, 'pea-tte').quantite, 0);
});

test('vente de plus que la quantité détenue : refusée', () => {
  const d = avec(base(), 'pea-tte', { quantite: 10, pru: 60 });
  assert.throws(() => op(d, { sens: 'vente', titre: 'TTE.PA', quantite: 11, prix: 55 }), /n'en contient que 10/);
});

test('dividende, versement, retrait : liquidités du compte', () => {
  let d = base();
  d = op(d, { sens: 'versement', compte: 'pea', montant: 1000 }).data;
  d = op(d, { sens: 'dividende', titre: 'Air Liquide', montant: 45.5 }).data;
  d = op(d, { sens: 'retrait', compte: 'revolut', montant: 20 }).data;
  d = op(d, { sens: 'versement', compte: 'ibkr', montant: 300, devise: 'USD' }).data;
  assert.equal(d.liquidites.pea.EUR, 1045.5);
  assert.equal(d.liquidites.revolut.EUR, -20);
  assert.equal(d.liquidites.ibkr.USD, 300);
  assert.equal(d.operations.length, 4);
  assert.equal(d.operations[1].ligne, 'pea-ai-swing'); // tranche par défaut
});

test('attribution d’actions gratuites : coût inchangé, PRU baisse', () => {
  const d = avec(base(), 'pea-ai-nominatif', { quantite: 20, pru: 150 });
  const r = op(d, { sens: 'attribution', titre: 'air liquide', tranche: 'nominatif', quantite: 2 });
  const l = ligne(r.data, 'pea-ai-nominatif');
  assert.equal(l.quantite, 22);
  assert.equal(l.pru, 136.3636); // 20 × 150 / 22
  assert.equal(r.data.liquidites.pea.EUR, 0);
});

test('annuler la dernière opération restaure la ligne et les liquidités', () => {
  const d = avec(base(), 'pea-ai-swing', { quantite: 33, pru: 170 });
  const r = op(d, { sens: 'achat', titre: 'AI.PA', quantite: 10, prix: 180 });
  const u = annulerDerniere(r.data);
  assert.equal(ligne(u.data, 'pea-ai-swing').quantite, 33);
  assert.equal(ligne(u.data, 'pea-ai-swing').pru, 170);
  assert.equal(u.data.liquidites.pea.EUR, 0);
  assert.equal(u.data.operations.length, 0);
  assert.throws(() => annulerDerniere(u.data), /Aucune opération/);
});

test('annuler est refusé si la ligne a été modifiée depuis', () => {
  const d = avec(base(), 'pea-tte', { quantite: 10, pru: 60 });
  const r = op(d, { sens: 'achat', titre: 'TTE.PA', quantite: 5, prix: 50 });
  const m = modifierLigne(r.data, { titre: 'TTE.PA', quantite: 99 });
  assert.throws(() => annulerDerniere(m.data), /modifiée depuis/);
});

// ---------------------------------------------------------------- recherche des titres

test('résolution : alias, symbole sans suffixe, ISIN, nom partiel, tranche par défaut', () => {
  const d = base();
  assert.equal(resoudreLigne(d, 'total').symbole, 'TTE.PA');
  assert.equal(resoudreLigne(d, 'TotalEnergies').symbole, 'TTE.PA');
  assert.equal(resoudreLigne(d, 'tte').symbole, 'TTE.PA');
  assert.equal(resoudreLigne(d, 'FR0000120271').symbole, 'TTE.PA');
  assert.equal(resoudreLigne(d, 'or').symbole, 'IGLN.L');
  assert.equal(resoudreLigne(d, 'Air Liquide').id, 'pea-ai-swing');
  assert.equal(resoudreLigne(d, 'air liquide', { tranche: 'nominatif' }).id, 'pea-ai-nominatif');
  assert.throws(() => resoudreLigne(d, 'Air Liquide', { defaut: false }), /précise la tranche/);
  assert.throws(() => resoudreLigne(d, 'Thales'), /Titre inconnu/);
  assert.throws(() => resoudreLigne(d, 'ishares'), /ambigu/);
});

// ---------------------------------------------------------------- validation stricte

test('opérations : saisies invalides refusées', () => {
  const d = base();
  const ko = (body, re) => assert.throws(() => op(d, body), re);
  ko({ sens: 'don', titre: 'TTE', quantite: 1, prix: 1 }, /sens/);
  ko({ sens: 'achat', titre: 'TTE', quantite: '10', prix: 50 }, /quantité : nombre attendu/);
  ko({ sens: 'achat', titre: 'TTE', quantite: -1, prix: 50 }, /supérieur à 0/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 0, prix: 50 }, /supérieur à 0/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: NaN }, /nombre attendu/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, frais: -1 }, /au moins 0/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1.1234567, prix: 50 }, /décimales/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, date: '2099-01-01' }, /passée/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, date: '2026-02-30' }, /AAAA-MM-JJ/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, date: '17/10/2026' }, /AAAA-MM-JJ/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, montant: 50 }, /Champ inattendu : montant/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, admin: true }, /Champ inattendu/);
  ko({ sens: 'achat', titre: '', quantite: 1, prix: 50 }, /titre/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, compte: 'boursorama' }, /Compte inconnu/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, compte: 'ibkr' }, /Titre inconnu/);
  ko({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 50, note: 'a\u0000b' }, /non autorisés/);
  ko({ sens: 'dividende', titre: 'TTE', montant: 10, quantite: 3 }, /Champ inattendu/);
  ko({ sens: 'versement', montant: 10 }, /compte manquant/);
  ko({ sens: 'versement', compte: 'pea', montant: 10, devise: 'usd' }, /devise/);
  ko([], /Objet JSON/);
  ko(null, /Objet JSON/);
});

// ---------------------------------------------------------------- lignes, liquidités, cible

test('ligne : création (compte + catégorie requis), modification, suppression', () => {
  const d = base();
  assert.throws(() => modifierLigne(d, { symbole: 'AIR.PA', categorie: 'Défense' }), /précise le compte/);
  assert.throws(() => modifierLigne(d, { symbole: 'AIR.PA', compte: 'pea' }), /catégorie/);
  assert.throws(() => modifierLigne(d, { symbole: 'pas un symbole', compte: 'pea', categorie: 'X' }), /symbole/);
  const c = modifierLigne(d, { symbole: 'air.pa', compte: 'pea', categorie: 'défense', nom: 'Airbus', quantite: 5, pru: 150, alias: ['airbus'] });
  const l = c.data.lignes.find((x) => x.symbole === 'AIR.PA');
  assert.equal(l.id, 'pea-air');
  assert.equal(l.categorie, 'défense');
  assert.equal(c.nouveauSymbole, true);
  assert.equal(resoudreLigne(c.data, 'airbus').id, 'pea-air');
  // la catégorie reprend l'orthographe existante
  const m = modifierLigne(c.data, { titre: 'total', categorie: 'actions europe' });
  assert.equal(m.data.lignes.find((x) => x.id === 'pea-tte').categorie, 'Actions Europe');
  assert.throws(() => modifierLigne(c.data, { titre: 'airbus', supprimer: true }), /contient encore 5/);
  const z = modifierLigne(c.data, { titre: 'airbus', quantite: 0 });
  const s = modifierLigne(z.data, { titre: 'airbus', supprimer: true });
  assert.equal(s.data.lignes.some((x) => x.symbole === 'AIR.PA'), false);
});

test('ligne : tranche obligatoire quand il y en a plusieurs, date d’inscription', () => {
  const d = base();
  assert.throws(() => modifierLigne(d, { symbole: 'AI.PA', quantite: 21 }), /précise la tranche/);
  const r = modifierLigne(d, { symbole: 'AI.PA', tranche: 'nominatif', quantite: 21, pru: 150.2, inscription: '2023-03-15' }, { maintenant: MAINTENANT });
  const l = ligne(r.data, 'pea-ai-nominatif');
  assert.equal(l.quantite, 21);
  assert.equal(l.date_inscription_nominatif, '2023-03-15');
  assert.equal(l._a_remplir, undefined);
  assert.throws(() => modifierLigne(d, { symbole: 'AI.PA', tranche: 'nominatif', inscription: '2099-01-01' }, { maintenant: MAINTENANT }), /passée/);
  assert.throws(() => modifierLigne(d, { symbole: 'AI.PA', tranche: 'nominatif', pru: 0 }), /supérieur à 0/);
  assert.throws(() => modifierLigne(d, { symbole: 'TTE.PA', isin: 'FR123' }), /ISIN/);
  assert.throws(() => modifierLigne(d, { symbole: 'TTE.PA', alias: 'or' }), /déjà utilisé pour IGLN.L/);
  assert.throws(() => modifierLigne(d, { symbole: 'TTE.PA', inconnu: 1 }), /Champ inattendu/);
});

test('alias : noms hérités d’Object.prototype traités comme des noms ordinaires', () => {
  const r = modifierLigne(base(), { symbole: 'TTE.PA', alias: ['constructor', 'valueOf'] });
  assert.equal(r.data.alias.constructor, 'TTE.PA');
  assert.equal(resoudreLigne(r.data, 'constructor').symbole, 'TTE.PA');
  assert.equal(resoudreLigne(r.data, 'valueof').symbole, 'TTE.PA');
  assert.throws(() => resoudreLigne(base(), 'constructor'), /Titre inconnu/);
  assert.throws(() => modifierLigne(base(), { symbole: 'TTE.PA', alias: '__proto__' }), /nom réservé/);
  assert.equal(Object.prototype.polluted, undefined);
});

test('ligne : changement de symbole (les alias suivent)', () => {
  const r = modifierLigne(base(), { titre: 'gold miners', symbole: 'GDGB.L' });
  assert.equal(ligne(r.data, 'ibkr-gdx').symbole, 'GDGB.L');
  assert.equal(r.data.alias['gold miners'], 'GDGB.L');
  assert.equal(r.nouveauSymbole, true);
});

test('liquidités : montant fixé (négatif possible), devise', () => {
  const r = fixerLiquidites(base(), { compte: 'IBKR', montant: -120.456, devise: 'USD' });
  assert.equal(r.data.liquidites.ibkr.USD, -120.46);
  assert.throws(() => fixerLiquidites(base(), { compte: 'pea', montant: '10' }), /nombre attendu/);
  assert.throws(() => fixerLiquidites(base(), { montant: 10 }), /compte manquant/);
  // « cto » désigne le seul compte de type CTO
  assert.equal(fixerLiquidites(base(), { compte: 'cto', montant: 5 }).data.liquidites.ibkr.EUR, 5);
});

test('cible : fusion, remplacement, total ≤ 100 %', () => {
  let r = fixerCible(base(), { cible: { 'Actions Europe': 30, 'Or': 10 } });
  assert.deepEqual(r.data.cible, { 'Actions Europe': 30, Or: 10 });
  assert.match(r.avertissements[0], /40 %/);
  r = fixerCible(r.data, { cible: { 'actions europe': 35, Défense: 15 } });
  assert.deepEqual(r.data.cible, { Or: 10, 'Actions Europe': 35, Défense: 15 });
  assert.throws(() => fixerCible(r.data, { cible: { Monde: 50 } }), /plus de 100/);
  r = fixerCible(r.data, { cible: { Monde: 100 }, remplacer: true });
  assert.deepEqual(r.data.cible, { Monde: 100 });
  assert.deepEqual(r.avertissements, []);
  assert.throws(() => fixerCible(base(), { cible: { Monde: 101 } }), /cible Monde/);
  assert.throws(() => fixerCible(base(), { cible: { Monde: '10' } }), /nombre attendu/);
  assert.throws(() => fixerCible(base(), { cible: [] }), /objet/);
});

// ---------------------------------------------------------------- calculs (cours enregistrés)

function portefeuille() {
  const d = base();
  avec(d, 'pea-ai-swing', { quantite: 10, pru: 160 });
  avec(d, 'pea-tte', { quantite: 100, pru: 60 });
  avec(d, 'ibkr-igln', { quantite: 10, pru: 70 });
  d.lignes.push({ id: 'ibkr-sgln', compte: 'ibkr', nom: 'iShares Gold (GBp)', symbole: 'SGLN.L', quantite: 100, pru: 50, devise: 'GBP', categorie: 'Or' });
  d.liquidites = { pea: { EUR: 1000 }, ibkr: { USD: 500 }, revolut: { EUR: 0 } };
  d.cible = { 'Actions Europe': 50, Or: 30, Cash: 10, 'Défense': 10 };
  return d;
}

test('calculs : valeurs, conversion USD et GBp → EUR, variation du jour avec le change, latent', () => {
  const c = cours('AI.PA', 'TTE.PA', 'IGLN.L', 'SGLN.L', 'EURUSD=X', 'EURGBP=X');
  const r = calculer(portefeuille(), c, MAINTENANT);
  const L = Object.fromEntries(r.lignes.map((l) => [l.symbole + (l.sous_tranche ? ':' + l.sous_tranche : ''), l]));
  // Paris en euros
  assert.equal(L['AI.PA:swing'].valeur, 1723.6);
  assert.equal(L['AI.PA:swing'].variation_jour, r2(1723.6 - 1698));
  assert.equal(L['AI.PA:swing'].latente, 123.6);
  assert.equal(L['AI.PA:swing'].latente_pct, r2((123.6 / 1600) * 100));
  // Londres en dollars : 10 × 78,12 $ / 1,162
  assert.equal(L['IGLN.L'].valeur, r2((10 * 78.12) / 1.162));
  assert.equal(L['IGLN.L'].variation_jour, r2((10 * 78.12) / 1.162 - (10 * 77.4) / 1.158));
  assert.equal(L['IGLN.L'].latente, r2((10 * 78.12) / 1.162 - 700 / 1.162));
  // Londres en pence : 5 842,5 GBp = 58,425 £ ; / 0,8671 £ pour 1 €
  assert.equal(L['SGLN.L'].cours, 58.425);
  assert.equal(L['SGLN.L'].devise_cours, 'GBP');
  assert.equal(L['SGLN.L'].valeur, r2((100 * 58.425) / 0.8671));
  assert.equal(L['SGLN.L'].latente, r2((100 * 58.425) / 0.8671 - 5000 / 0.8671));
  // liquidités en dollars converties, variation de change comprise
  const cashUsd = 500 / 1.162;
  const total = 1723.6 + 5642 + (10 * 78.12) / 1.162 + (100 * 58.425) / 0.8671 + 1000 + cashUsd;
  assert.equal(r.total, r2(total));
  const varJour = (1723.6 - 1698) + (5642 - 5695) + ((10 * 78.12) / 1.162 - (10 * 77.4) / 1.158)
    + ((100 * 58.425) / 0.8671 - (100 * 57.95) / 0.8644) + (cashUsd - 500 / 1.158);
  assert.equal(r.variation_jour, r2(varJour));
  assert.equal(r.variation_jour_pct, r2((varJour / (total - varJour)) * 100));
  assert.equal(r.liquidites, r2(1000 + cashUsd));
  assert.equal(r.perime, false);
  assert.equal(r.a_remplir, false);
  // comptes
  const pea = r.comptes.find((x) => x.id === 'pea');
  assert.equal(pea.valeur, r2(1723.6 + 5642 + 1000));
  assert.equal(pea.liquidites, 1000);
  assert.equal(r.comptes.find((x) => x.id === 'ibkr').liquidites, r2(cashUsd));
  // poids : somme ≈ 100
  assert.ok(Math.abs(r.comptes.reduce((a, x) => a + x.poids, 0) - 100) < 0.05);
});

test('répartition par catégorie et écart à la cible en points', () => {
  const c = cours('AI.PA', 'TTE.PA', 'IGLN.L', 'SGLN.L', 'EURUSD=X', 'EURGBP=X');
  const r = calculer(portefeuille(), c, MAINTENANT);
  const A = Object.fromEntries(r.allocation.map((a) => [a.categorie, a]));
  const total = r.total;
  assert.equal(A['Actions Europe'].valeur, r2(1723.6 + 5642));
  assert.equal(A['Actions Europe'].poids, r2(((1723.6 + 5642) / total) * 100));
  assert.equal(A['Actions Europe'].ecart, r2(A['Actions Europe'].poids - 50));
  assert.equal(A.Cash.cible, 10);
  assert.equal(A['Défense'].valeur, 0);
  assert.equal(A['Défense'].ecart, -10);
  assert.equal(A.Monde, undefined); // ni détenu ni ciblé
  assert.equal(r.cible_total, 100);
  assert.ok(Math.abs(r.allocation.reduce((a, x) => a + x.poids, 0) - 100) < 0.05);
});

test('cours manquant : valorisé au PRU + avertissement ; taux manquant : liquidités non comptées', () => {
  const d = portefeuille();
  const r = calculer(d, cours('AI.PA', 'TTE.PA', 'EURUSD=X'), MAINTENANT);
  const sgln = r.lignes.find((l) => l.symbole === 'SGLN.L');
  assert.equal(sgln.valorisation, null); // ni cours ni taux GBP
  assert.equal(sgln.valeur, null);
  const igln = r.lignes.find((l) => l.symbole === 'IGLN.L');
  assert.equal(igln.valorisation, 'pru');
  assert.equal(igln.valeur, r2(700 / 1.162));
  assert.equal(igln.perime, true);
  assert.equal(r.perime, true);
  assert.ok(r.avertissements.some((a) => /Cours indisponible : IGLN.L \(valorisé au PRU\)/.test(a)));
  assert.ok(r.avertissements.some((a) => /SGLN.L \(non compté\)/.test(a)));
});

test('cours ancien : signalé, et sans variation du jour', () => {
  const c = cours('AI.PA', 'TTE.PA');
  c['TTE.PA'] = { ...c['TTE.PA'], heure: MAINTENANT.getTime() - 5 * 86400000 };
  const d = base();
  avec(d, 'pea-tte', { quantite: 10, pru: 50 });
  avec(d, 'pea-ai-swing', { quantite: 1, pru: 150 });
  const r = calculer(d, c, MAINTENANT);
  const tte = r.lignes.find((l) => l.symbole === 'TTE.PA');
  assert.equal(tte.perime, true);
  assert.equal(tte.variation_jour, null);
  assert.equal(tte.cours_date, '2026-10-11');
  assert.equal(r.variation_jour, r2(172.36 - 169.8));
  assert.equal(r.perime, true);
});

test('taux de change ancien : signalé, et sans variation du jour fantôme (liquidités ni titres)', () => {
  const c = cours('IGLN.L', 'EURUSD=X');
  c['EURUSD=X'] = { ...c['EURUSD=X'], heure: MAINTENANT.getTime() - 6 * 86400000, recupere_le: MAINTENANT.getTime() - 6 * 86400000 };
  const d = base();
  avec(d, 'ibkr-igln', { quantite: 10, pru: 70 });
  d.liquidites = { ibkr: { USD: 1000 } };
  const r = calculer(d, c, MAINTENANT);
  assert.equal(r.perime, true);
  assert.equal(r.comptes.find((x) => x.id === 'ibkr').liquidites, r2(1000 / 1.162));
  // seule la variation du titre (78,12 $ contre 77,40 $ la veille), au taux connu
  assert.equal(r.variation_jour, r2((10 * (78.12 - 77.4)) / 1.162));
  assert.equal(r.lignes.find((l) => l.symbole === 'IGLN.L').variation_jour, r2((10 * (78.12 - 77.4)) / 1.162));
});

test('fichier neuf : tout est à remplir, total nul, échéances présentes', () => {
  const r = calculer(base(), cours('AI.PA'), MAINTENANT);
  assert.equal(r.a_remplir, true);
  assert.equal(r.total, 0);
  assert.equal(r.variation_jour_pct, null);
  assert.equal(r.latente, null);
  assert.ok(r.echeances.some((e) => e.type === 'pea5'));
  assert.ok(r.echeances.some((e) => e.type === 'fidelite' && e.a_renseigner && e.texte === 'date d\'inscription au nominatif à renseigner'));
});

// ---------------------------------------------------------------- échéances

test('PEA : 5 ans après la date d’ouverture', () => {
  const r = calculer(base(), {}, MAINTENANT);
  const e = r.echeances.find((x) => x.type === 'pea5');
  assert.equal(e.date, '2027-08-01');
  assert.equal(e.jours, 289);
  assert.equal(e.atteinte, false);
  assert.equal(e.texte, '5 ans le 1er août 2027');
  const apres = calculer(base(), {}, new Date('2027-08-01T10:00:00Z')).echeances.find((x) => x.type === 'pea5');
  assert.equal(apres.atteinte, true);
  assert.equal(ajouterAns('2024-02-29', 5), '2029-03-01');
});

test('Air Liquide : prime de fidélité à partir du dividende (année d’inscription + 3)', () => {
  const fid = (inscription, quand = MAINTENANT, ops = []) => {
    const d = avec(base(), 'pea-ai-nominatif', { quantite: 21, pru: 150, date_inscription_nominatif: inscription });
    d.operations = ops;
    return calculer(d, {}, quand).echeances.find((x) => x.type === 'fidelite');
  };
  // inscrites en 2023 → 2 années civiles pleines (2024, 2025) → dividende 2026
  let e = fid('2023-03-15');
  assert.equal(e.annee, 2026);
  assert.equal(e.eligible, true);
  assert.equal(e.texte, '+10 % sur le dividende depuis 2026');
  // inscrites le 31 décembre 2023 : même règle
  assert.equal(fid('2023-12-31').annee, 2026);
  // inscrites en 2024 → dividende 2027, pas encore éligible en 2026
  e = fid('2024-01-02');
  assert.equal(e.annee, 2027);
  assert.equal(e.eligible, false);
  assert.equal(e.texte, '+10 % à partir du dividende 2027');
  // achats ajoutés au nominatif après l'inscription : leur propre délai
  e = fid('2023-03-15', MAINTENANT, [{ ligne: 'pea-ai-nominatif', sens: 'achat', date: '2026-02-10', quantite: 4 }]);
  assert.deepEqual(e.lots, [{ annee: 2029, quantite: 4 }]);
});

test('dividendes des 12 derniers mois (conversion en euros)', () => {
  const d = base();
  d.operations = [
    { sens: 'dividende', date: '2025-10-16', ligne: 'pea-tte', symbole: 'TTE.PA', montant: 99, devise: 'EUR' }, // il y a 365 jours : exclu
    { sens: 'dividende', date: '2025-10-17', ligne: 'pea-tte', symbole: 'TTE.PA', montant: 100, devise: 'EUR' },
    { sens: 'dividende', date: '2026-05-20', ligne: 'pea-ai-swing', symbole: 'AI.PA', montant: 45.5, devise: 'EUR' },
    { sens: 'dividende', date: '2026-06-01', ligne: 'ibkr-igln', symbole: 'IGLN.L', montant: 11.62, devise: 'USD' }
  ];
  const r = calculer(d, cours('EURUSD=X'), MAINTENANT);
  assert.equal(r.dividendes_12m.nombre, 3);
  assert.equal(r.dividendes_12m.total, r2(100 + 45.5 + 11.62 / 1.162));
  assert.equal(r.dividendes_12m.par_titre[0].nom, 'TotalEnergies');
});

// ---------------------------------------------------------------- fichier

test('fichier : créé avec le squelette en mode 600, jamais écrasé s’il est illisible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patri-'));
  const f = path.join(dir, 'data', 'patrimoine.json');
  const r = chargerFichier(f);
  assert.equal(r.ok, true);
  assert.equal(r.cree, true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const json = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(json.lignes.every((l) => l.quantite === 0));
  assert.ok(json._aide[0].includes('À REMPLIR'));
  fs.writeFileSync(f, '{ "lignes": [ oups');
  const r2b = chargerFichier(f);
  assert.equal(r2b.ok, false);
  assert.match(r2b.error, /illisible/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ "lignes": [ oups');
  fs.writeFileSync(f, JSON.stringify({ ...json, lignes: [{ ...json.lignes[0], quantite: 'dix' }] }));
  assert.match(chargerFichier(f).error, /quantité invalide/);
  // écriture atomique : pas de fichier temporaire laissé
  ecrireFichier(f, json);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['patrimoine.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fichier : opération mal formée → erreur précise (le calcul ne doit jamais planter)', () => {
  const ok = op(base(), { sens: 'achat', titre: 'TTE', quantite: 1, prix: 60 }).data;
  assert.equal(normaliser(JSON.parse(JSON.stringify(ok))).operations.length, 1);
  const casse = (champs) => normaliser({ ...JSON.parse(JSON.stringify(ok)), operations: [{ ...ok.operations[0], ...champs }] });
  assert.throws(() => casse({ date: { a: 1 } }), /opération n° 1 .* date/);
  assert.throws(() => casse({ date: '2026-13-01' }), /date/);
  assert.throws(() => casse({ sens: 'don' }), /sens invalide/);
  assert.throws(() => casse({ quantite: '1' }), /quantite invalide/);
  assert.throws(() => casse({ montant: null, prix: 'x' }), /prix invalide/);
});

test('cache des cours abîmé (sans heure ni prix) : entrée ignorée, pas d’exception', () => {
  const d = avec(base(), 'pea-tte', { quantite: 10, pru: 50 });
  const r = calculer(d, { 'TTE.PA': { prix: 56, devise: 'EUR' }, 'AI.PA': { heure: Date.now(), devise: 'EUR' } }, MAINTENANT);
  const tte = r.lignes.find((l) => l.symbole === 'TTE.PA');
  assert.equal(tte.valorisation, 'pru');
  assert.equal(tte.cours, null);
  assert.equal(tte.valeur, 500);
  assert.ok(r.avertissements.some((a) => /Cours indisponible : TTE.PA/.test(a)));
});

test('normalisation : liquidités en nombre → { EUR }, alias en minuscules', () => {
  const d = normaliser({ ...squelette(), liquidites: { revolut: 1200 }, alias: { 'Air Liquide': 'ai.pa' } });
  assert.deepEqual(d.liquidites, { revolut: { EUR: 1200 } });
  assert.equal(d.alias['air liquide'], 'AI.PA');
});

test('cours à charger : titres + taux de change des devises utilisées', () => {
  const d = portefeuille();
  const s = symbolesNecessaires(d, cours('SGLN.L'));
  assert.ok(s.includes('AI.PA') && s.includes('IGLN.L') && s.includes('SGLN.L'));
  assert.ok(s.includes('EURUSD=X') && s.includes('EURGBP=X'));
  assert.ok(!s.includes('EUREUR=X'));
});

// ---------------------------------------------------------------- export JSON stable

test('export JSON stable « barre.patrimoine/1 »', () => {
  const c = cours('AI.PA', 'TTE.PA', 'IGLN.L', 'SGLN.L', 'EURUSD=X', 'EURGBP=X');
  const r = calculer(portefeuille(), c, MAINTENANT);
  const j = versJsonStable(r, { source: 'serveur', maintenant: MAINTENANT });
  assert.deepEqual(Object.keys(j), ['schema', 'source', 'genere_le', 'cours_au', 'perime', 'a_remplir', 'devise', 'total_eur',
    'variation_jour_eur', 'variation_jour_pct', 'latente_eur', 'liquidites_eur', 'comptes', 'categories', 'lignes_perimees']);
  assert.equal(j.schema, 'barre.patrimoine/1');
  assert.equal(j.genere_le, '2026-10-16T16:00:00.000Z');
  assert.equal(j.cours_au, '2026-10-16T15:35:12.000Z');
  assert.equal(j.total_eur, r.total);
  assert.deepEqual(Object.keys(j.comptes[0]), ['id', 'nom', 'type', 'valeur_eur', 'liquidites_eur', 'variation_jour_eur', 'poids_pct']);
  assert.deepEqual(Object.keys(j.categories[0]), ['categorie', 'valeur_eur', 'poids_pct', 'cible_pct', 'ecart_pts']);
  assert.equal(typeof j.perime, 'boolean');
  assert.deepEqual(j.lignes_perimees, []);
});
