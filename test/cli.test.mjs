// Tests de l'analyse des commandes « patrimoine » (sans serveur).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyser, construireRequete, nombreFr, ErreurCli } from '../lib/cli-patrimoine.mjs';

const req = (...argv) => construireRequete(analyser(argv));

test('achat : titre en plusieurs mots, virgule décimale, « à », options', () => {
  assert.deepEqual(req('achat', 'air', 'liquide', '10', 'à', '180,5', '--compte', 'pea', '--frais=1,95', '--date', '2026-10-15'), {
    methode: 'POST', chemin: '/api/patrimoine/operation',
    corps: { sens: 'achat', titre: 'air liquide', quantite: 10, prix: 180.5, compte: 'pea', date: '2026-10-15', frais: 1.95 }
  });
  assert.deepEqual(req('acheté', 'IGLN.L', '3', '78.4$', '--compte', 'ibkr').corps, { sens: 'achat', titre: 'IGLN.L', quantite: 3, prix: 78.4, compte: 'ibkr' });
  assert.equal(req('achat', 'ai', '5', '170', '--tranche', 'nominatif').corps.tranche, 'nominatif');
  assert.equal(req('achat', 'tte', '5', '60', '--date', '15/10/2026').corps.date, '2026-10-15');
});

test('vente, dividende, versement, retrait, attribution, annuler, cours', () => {
  assert.deepEqual(req('vendu', 'TTE', '5', '62').corps, { sens: 'vente', titre: 'TTE', quantite: 5, prix: 62 });
  assert.deepEqual(req('dividende', 'Air', 'Liquide', '45€').corps, { sens: 'dividende', titre: 'Air Liquide', montant: 45 });
  assert.deepEqual(req('dividende', 'igln', '12,5', '--devise', 'usd').corps, { sens: 'dividende', titre: 'igln', montant: 12.5, devise: 'USD' });
  assert.deepEqual(req('versement', 'pea', '1 500').corps, { sens: 'versement', compte: 'pea', montant: 1500 });
  assert.deepEqual(req('retrait', 'revolut', '200').corps, { sens: 'retrait', compte: 'revolut', montant: 200 });
  assert.deepEqual(req('attribution', 'air', 'liquide', '2', '--tranche', 'nominatif').corps, { sens: 'attribution', titre: 'air liquide', quantite: 2, tranche: 'nominatif' });
  assert.equal(req('annuler').chemin, '/api/patrimoine/annuler');
  assert.equal(req('cours').chemin, '/api/patrimoine/cours');
});

test('ligne : symbole Yahoo ou titre, options', () => {
  assert.deepEqual(req('ligne', 'AI.PA', '--tranche', 'nominatif', '--quantite', '21', '--pru', '150,2', '--inscription', '2023-03-15').corps,
    { type: 'ligne', symbole: 'AI.PA', tranche: 'nominatif', quantite: 21, pru: 150.2, inscription: '2023-03-15' });
  assert.deepEqual(req('ligne', 'air.pa', '--compte', 'pea', '--categorie', 'Défense', '--nom', 'Airbus', '--alias', 'airbus', '--alias', 'air').corps,
    { type: 'ligne', symbole: 'AIR.PA', compte: 'pea', nom: 'Airbus', categorie: 'Défense', alias: ['airbus', 'air'] });
  assert.deepEqual(req('ligne', 'gold', 'miners', '--symbole', 'gdgb.l').corps, { type: 'ligne', titre: 'gold miners', symbole: 'GDGB.L' });
  assert.deepEqual(req('ligne', 'total', '--pru', 'aucun').corps, { type: 'ligne', titre: 'total', pru: null });
  assert.deepEqual(req('ligne', 'TTE', '--quantité', '0', '--supprimer').corps, { type: 'ligne', titre: 'TTE', quantite: 0, supprimer: true });
  assert.equal(req('ligne', 'EURUSD=X', '--quantite', '1').corps.symbole, 'EURUSD=X');
});

test('liquidités (négatif accepté) et cible', () => {
  assert.deepEqual(req('liquidites', 'ibkr', '-120,5', '--devise', 'usd').corps, { type: 'liquidites', compte: 'ibkr', montant: -120.5, devise: 'USD' });
  assert.deepEqual(req('liquidités', 'revolut', '6500').corps, { type: 'liquidites', compte: 'revolut', montant: 6500 });
  assert.deepEqual(req('cible', 'Actions Europe=30', 'Or=10', 'Défense=12,5%').corps, { type: 'cible', cible: { 'Actions Europe': 30, Or: 10, 'Défense': 12.5 } });
  assert.deepEqual(req('cible', 'Actions', 'US=20', 'Monde', '=', '40').corps.cible, { 'Actions US': 20, Monde: 40 });
  assert.deepEqual(req('cible', '--remplacer').corps, { type: 'cible', cible: {}, remplacer: true });
  assert.equal(req('cible').vue, 'cible');
  assert.throws(() => req('cible', 'Or', 'beaucoup'), /Usage/);
});

test('résumé, --json, historique', () => {
  assert.deepEqual(req(), { methode: 'GET', chemin: '/api/patrimoine', vue: 'resume' });
  assert.equal(req('--json').vue, 'json');
  assert.equal(req('résumé', '--json').vue, 'json');
  assert.deepEqual(req('historique', '--n', '5'), { methode: 'GET', chemin: '/api/patrimoine', vue: 'historique', n: 5 });
  assert.throws(() => req('historique', '--n', '0'), /entier/);
  assert.equal(req('aide').aide, true);
  assert.equal(req('achat', '--help').aide, true);
});

test('erreurs de saisie', () => {
  assert.throws(() => req('achat', 'tte', '10'), /Usage/);
  assert.throws(() => req('achat', 'air', 'liquide', '10'), /quantité : « liquide » n'est pas un nombre/);
  assert.throws(() => req('achat', 'tte', 'dix', '60'), /quantité : « dix » n'est pas un nombre/);
  assert.throws(() => req('achat', 'tte', '10', '60', '--prix', '3'), /Option inconnue/);
  assert.throws(() => req('achat', 'tte', '10', '60', '--compte'), /valeur manquante/);
  assert.throws(() => req('acheter-vendre'), /Commande inconnue/);
  assert.throws(() => req('liquidites', 'pea'), /Usage/);
  assert.throws(() => req('versement', 'pea', '10', 'euros', 'de plus'), /Usage/);
  assert.throws(() => req('--json=1'), /pas de valeur/);
  assert.throws(() => analyser(['x']), ErreurCli);
  assert.throws(() => analyser(['constructor', '--json']), /Commande inconnue/);
});

test('option qui ne s’applique pas à la commande : refusée, jamais ignorée', () => {
  // --devise sur un achat : le prix serait enregistré dans la devise de la ligne
  assert.throws(() => req('achat', 'IGLN.L', '3', '67', '--devise', 'EUR'), /--devise ne s'applique pas à « patrimoine achat » : le prix est dans la devise de la ligne/);
  assert.throws(() => req('vente', 'tte', '5', '60', '--quantite', '3'), /--quantite ne s'applique pas/);
  assert.throws(() => req('versement', 'pea', '100', '--compte', 'ibkr'), /--compte ne s'applique pas/);
  assert.throws(() => req('dividende', 'tte', '10', '--frais', '1'), /--frais ne s'applique pas/);
  assert.throws(() => req('liquidites', 'pea', '10', '--date', 'hier'), /--date ne s'applique pas/);
  assert.throws(() => req('historique', '--remplacer'), /--remplacer ne s'applique pas/);
  // --json partout, --help/aide prioritaire
  assert.equal(req('achat', 'tte', '1', '60', '--json').corps.prix, 60);
  assert.equal(req('vente', '--devise', 'EUR', '--help').aide, true);
});

test('nombres à la française', () => {
  assert.equal(nombreFr('180,5'), 180.5);
  assert.equal(nombreFr('1 234,50 €'), 1234.5);
  assert.equal(nombreFr('1 234'), 1234);
  assert.equal(nombreFr('62$'), 62);
  assert.equal(nombreFr('-3'), -3);
  assert.throws(() => nombreFr('1.234,5'), /pas un nombre/);
  assert.throws(() => nombreFr('1e5'), /pas un nombre/);
  assert.throws(() => nombreFr(''), /pas un nombre/);
});
