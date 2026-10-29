// Patrimoine : fichier de données, opérations et calculs. Aucune dépendance.
//
// Uniquement des chiffres : ce module ne produit aucun conseil ni aucune
// suggestion d'achat ou de vente. Il additionne, convertit et compare à la
// cible que Julian a lui-même fixée.
//
// Le fichier ~/.config/barre/data/patrimoine.json (mode 600) est la seule
// source de vérité. Le serveur de la barre et la commande « patrimoine »
// passent tous les deux par ce module.

import fs from 'node:fs';
import path from 'node:path';
import { paris, estPerime, symboleChange } from './quotes.mjs';

export const SENS = ['achat', 'vente', 'dividende', 'versement', 'retrait', 'attribution'];
export const TYPES_COMPTE = ['PEA', 'CTO', 'cash'];
export const CATEGORIE_CASH = 'Cash';
const MAX = 1e9;
const JOUR = 86400000;

// ---------------------------------------------------------------- petits outils

const arrondi = (n) => (x) => {
  if (x == null || !Number.isFinite(x)) return x;
  const v = Math.round(Number((x * 10 ** n).toPrecision(15))) / 10 ** n;
  return v === 0 ? 0 : v;
};
export const r2 = arrondi(2);
export const r4 = arrondi(4);
export const r6 = arrondi(6);

export function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'")
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const dUTC = (s) => new Date(s + 'T00:00:00Z');
const isoJour = (d) => d.toISOString().slice(0, 10);
export function ajouterAns(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return isoJour(new Date(Date.UTC(y + n, m - 1, d))); // 29 février → 1er mars
}
export const joursEntre = (a, b) => Math.round((dUTC(b) - dUTC(a)) / JOUR);

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export function dateLongue(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${d === 1 ? '1er' : d} ${MOIS[m - 1]} ${y}`;
}
const nf = (dec) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
export const fmtQ = (q) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6 }).format(q);
const titres = (q) => `${fmtQ(q)} titre${q > 1 ? 's' : ''}`;
export function fmtMontant(x, devise = 'EUR') {
  const sym = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF' }[devise] || devise;
  return `${nf(2).format(x)} ${sym}`;
}

// Erreur due à la demande (→ HTTP 400), jamais à un bug.
export class ErreurSaisie extends Error {
  constructor(message) { super(message); this.saisie = true; }
}
const erreur = (m) => new ErreurSaisie(m);

// ---------------------------------------------------------------- squelette

export function squelette() {
  return {
    _aide: [
      'Patrimoine affiché sur la barre. QUANTITÉS À REMPLIR : tout est à 0 au départ.',
      'Le plus simple : la commande « patrimoine » (patrimoine aide), ou un message à Hermes.',
      'Montants en euros sauf indication « devise ». Aucune donnée secrète ici (pas de numéro de compte).',
      'cible : pourcentages par catégorie, fixés par toi (patrimoine cible "Actions Europe=30" …).'
    ],
    version: 1,
    comptes: [
      { id: 'pea', nom: 'PEA Crédit Agricole', type: 'PEA', date_ouverture: '2022-08-01', _a_remplir: 'jour exact d\'ouverture à vérifier (août 2022)' },
      { id: 'ibkr', nom: 'CTO Interactive Brokers', type: 'CTO', date_ouverture: null },
      { id: 'revolut', nom: 'Revolut', type: 'cash', date_ouverture: null }
    ],
    lignes: [
      { id: 'pea-psp5', compte: 'pea', nom: 'Amundi PEA S&P 500', symbole: 'PSP5.PA', isin: 'FR0011871128', quantite: 0, pru: null, devise: 'EUR', categorie: 'Actions US', _a_remplir: 'quantité et PRU' },
      { id: 'pea-wpea', compte: 'pea', nom: 'iShares MSCI World PEA', symbole: 'WPEA.PA', isin: 'IE0002XZSHO1', quantite: 0, pru: null, devise: 'EUR', categorie: 'Monde', _a_remplir: 'quantité et PRU' },
      { id: 'pea-ai-nominatif', compte: 'pea', nom: 'Air Liquide', symbole: 'AI.PA', isin: 'FR0000120073', quantite: 0, pru: null, devise: 'EUR', categorie: 'Actions Europe', sous_tranche: 'nominatif', prime_fidelite: true, date_inscription_nominatif: null, _a_remplir: 'quantité, PRU et date d\'inscription au nominatif' },
      { id: 'pea-ai-swing', compte: 'pea', nom: 'Air Liquide', symbole: 'AI.PA', isin: 'FR0000120073', quantite: 0, pru: null, devise: 'EUR', categorie: 'Actions Europe', sous_tranche: 'swing', defaut: true, _a_remplir: 'quantité et PRU' },
      { id: 'pea-tte', compte: 'pea', nom: 'TotalEnergies', symbole: 'TTE.PA', isin: 'FR0000120271', quantite: 0, pru: null, devise: 'EUR', categorie: 'Actions Europe', _a_remplir: 'quantité et PRU' },
      { id: 'ibkr-igln', compte: 'ibkr', nom: 'iShares Physical Gold', symbole: 'IGLN.L', isin: 'IE00B4ND3602', quantite: 0, pru: null, devise: 'USD', categorie: 'Or', _a_remplir: 'quantité et PRU (en dollars)' },
      { id: 'ibkr-gdx', compte: 'ibkr', nom: 'VanEck Gold Miners', symbole: 'GDX.L', isin: 'IE00BQQP9F84', quantite: 0, pru: null, devise: 'USD', categorie: 'Or', _a_remplir: 'quantité, PRU (en dollars) ; symbole Yahoo à vérifier' }
    ],
    liquidites: { pea: { EUR: 0 }, ibkr: { EUR: 0, USD: 0 }, revolut: { EUR: 0 } },
    cible: {},
    alias: {
      'air liquide': 'AI.PA', airliquide: 'AI.PA', 'l\'air liquide': 'AI.PA',
      total: 'TTE.PA', totalenergies: 'TTE.PA', 'total energies': 'TTE.PA',
      or: 'IGLN.L', 'or physique': 'IGLN.L', gold: 'IGLN.L', 'etc or': 'IGLN.L',
      's&p 500': 'PSP5.PA', 's&p': 'PSP5.PA', 'sp500': 'PSP5.PA', 'sp 500': 'PSP5.PA', 'etf s&p 500': 'PSP5.PA',
      'msci world': 'WPEA.PA', world: 'WPEA.PA', 'etf world': 'WPEA.PA',
      'mines d\'or': 'GDX.L', miners: 'GDX.L', 'gold miners': 'GDX.L', vaneck: 'GDX.L'
    },
    operations: []
  };
}

// ---------------------------------------------------------------- lecture / écriture

function idLigne(l, lignes) {
  const base = `${slug(l.compte) || 'compte'}-${slug(String(l.symbole).split('.')[0]) || 'ligne'}${l.sous_tranche ? '-' + slug(l.sous_tranche) : ''}`;
  let id = base;
  for (let i = 2; lignes.some((x) => x !== l && x.id === id); i++) id = `${base}-${i}`;
  return id;
}

const estObjet = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Contrôle un fichier (éventuellement modifié à la main). Lève une erreur
// précise plutôt que de remplacer silencieusement une valeur douteuse par 0.
export function normaliser(raw) {
  if (!estObjet(raw)) throw new Error('le fichier doit contenir un objet JSON');
  const d = { ...raw, version: 1 };
  d.comptes = Array.isArray(d.comptes) ? d.comptes : [];
  for (const c of d.comptes) {
    if (!estObjet(c) || typeof c.id !== 'string' || !c.id) throw new Error('compte sans identifiant');
    if (c.date_ouverture != null && !isDate(c.date_ouverture)) throw new Error(`compte ${c.id} : date_ouverture au format AAAA-MM-JJ attendue`);
    c.nom = String(c.nom || c.id);
    c.type = c.type || 'CTO';
  }
  d.lignes = Array.isArray(d.lignes) ? d.lignes : [];
  for (const l of d.lignes) {
    if (!estObjet(l)) throw new Error('ligne invalide');
    l.symbole = String(l.symbole || '').trim().toUpperCase();
    const nom = l.nom || l.symbole || l.id;
    if (!l.symbole) throw new Error(`ligne ${nom} : symbole manquant`);
    if (!d.comptes.some((c) => c.id === l.compte)) throw new Error(`ligne ${nom} : compte « ${l.compte} » inconnu`);
    l.quantite = l.quantite == null ? 0 : l.quantite;
    if (typeof l.quantite !== 'number' || !Number.isFinite(l.quantite) || l.quantite < 0) throw new Error(`ligne ${nom} : quantité invalide`);
    if (l.pru != null && (typeof l.pru !== 'number' || !Number.isFinite(l.pru) || l.pru <= 0)) throw new Error(`ligne ${nom} : PRU invalide`);
    if (l.pru === undefined) l.pru = null;
    if (l.date_inscription_nominatif != null && !isDate(l.date_inscription_nominatif)) throw new Error(`ligne ${nom} : date_inscription_nominatif au format AAAA-MM-JJ attendue`);
    l.nom = String(nom);
    l.categorie = String(l.categorie || 'Autre');
  }
  for (const l of d.lignes) if (!l.id || d.lignes.some((x) => x !== l && x.id === l.id)) l.id = idLigne(l, d.lignes);
  const liq = estObjet(d.liquidites) ? d.liquidites : {};
  d.liquidites = {};
  for (const [k, v] of Object.entries(liq)) {
    if (typeof v === 'number' && Number.isFinite(v)) d.liquidites[k] = { EUR: v };
    else if (estObjet(v)) {
      d.liquidites[k] = {};
      for (const [dev, n] of Object.entries(v)) {
        if (!/^[A-Z]{3}$/.test(dev) || typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`liquidités ${k} : montant ${dev} invalide`);
        d.liquidites[k][dev] = n;
      }
    } else throw new Error(`liquidités ${k} : montant invalide`);
  }
  const cible = estObjet(d.cible) ? d.cible : {};
  d.cible = {};
  for (const [k, v] of Object.entries(cible)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`cible ${k} : pourcentage entre 0 et 100 attendu`);
    d.cible[k] = v;
  }
  const alias = estObjet(d.alias) ? d.alias : {};
  d.alias = {};
  for (const [k, v] of Object.entries(alias)) if (typeof v === 'string' && v) d.alias[norm(k)] = v.toUpperCase();
  d.operations = Array.isArray(d.operations) ? d.operations.filter(estObjet) : [];
  d.operations.forEach((o, i) => {
    const ou = `opération n° ${i + 1}${o.id ? ` (${o.id})` : ''}`;
    if (!SENS.includes(o.sens)) throw new Error(`${ou} : sens invalide`);
    if (!isDate(o.date)) throw new Error(`${ou} : date au format AAAA-MM-JJ attendue`);
    for (const k of ['quantite', 'prix', 'frais', 'montant']) {
      if (o[k] != null && (typeof o[k] !== 'number' || !Number.isFinite(o[k]))) throw new Error(`${ou} : ${k} invalide`);
    }
  });
  return d;
}

export function ecrireFichier(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ignoré */ }
}

// → { ok: true, data, cree } ou { ok: false, error }. Crée le squelette si le fichier manque.
export function chargerFichier(file, { creer = true } = {}) {
  if (!fs.existsSync(file)) {
    if (!creer) return { ok: false, error: 'absent' };
    const d = normaliser(squelette());
    ecrireFichier(file, d);
    return { ok: true, data: d, cree: true };
  }
  try {
    return { ok: true, data: normaliser(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch (e) {
    return { ok: false, error: `patrimoine.json illisible : ${e.message}` };
  }
}

// ---------------------------------------------------------------- recherche d'un compte / d'une ligne

export function resoudreCompte(data, s) {
  if (s == null || s === '') return null;
  const n = norm(s);
  const exact = data.comptes.find((c) => norm(c.id) === n);
  if (exact) return exact;
  const parType = data.comptes.filter((c) => norm(c.type) === n);
  if (parType.length === 1) return parType[0];
  const parNom = data.comptes.filter((c) => norm(c.nom).includes(n));
  if (n.length >= 3 && parNom.length === 1) return parNom[0];
  throw erreur(`Compte inconnu : « ${s} » (comptes : ${data.comptes.map((c) => c.id).join(', ')})`);
}

// titre = nom, alias, symbole (avec ou sans suffixe de place) ou ISIN.
// defaut : avec plusieurs tranches d'un même titre, prend celle marquée « defaut ».
export function resoudreLigne(data, titre, { compte = null, tranche = null, defaut = true, absentOk = false } = {}) {
  const n = norm(titre);
  if (!n) throw erreur('Titre manquant');
  const up = String(titre).trim().toUpperCase();
  const alias = Object.hasOwn(data.alias, n) ? data.alias[n] : null;
  let c = data.lignes.filter((l) => (alias && l.symbole === alias) || l.symbole === up
    || l.symbole.split('.')[0] === up || (l.isin && l.isin === up) || norm(l.nom) === n);
  if (!c.length && n.length >= 3) c = data.lignes.filter((l) => norm(l.nom).includes(n));
  if (compte) c = c.filter((l) => l.compte === compte.id);
  if (tranche) c = c.filter((l) => norm(l.sous_tranche || '') === norm(tranche));
  if (!c.length) {
    if (absentOk) return null;
    throw erreur(`Titre inconnu : « ${titre} »${compte ? ` sur ${compte.nom}` : ''}${tranche ? ` (tranche ${tranche})` : ''}. Ajoute d'abord la ligne : patrimoine ligne <SYMBOLE> --compte … --categorie …`);
  }
  if (c.length === 1) return c[0];
  if (new Set(c.map((l) => `${l.symbole}|${l.compte}`)).size === 1) {
    const def = c.filter((l) => l.defaut);
    if (defaut && def.length === 1) return def[0];
    throw erreur(`Plusieurs lignes ${c[0].nom} (${c.map((l) => l.sous_tranche || 'sans tranche').join(', ')}) : précise la tranche (--tranche …)`);
  }
  throw erreur(`« ${titre} » est ambigu : ${c.map((l) => `${l.nom}${l.sous_tranche ? ' ' + l.sous_tranche : ''} (${l.symbole}, ${l.compte})`).join(', ')}. Précise le symbole ou le compte.`);
}

// Devise du prix et du PRU d'une ligne : celle indiquée, sinon celle de la cotation.
export function deviseLigne(l, cours = {}) {
  const q = cours[l.symbole];
  return l.devise || (q && q.devise) || 'EUR';
}

// ---------------------------------------------------------------- contrôle des saisies

function cles(body, permis) {
  if (!estObjet(body)) throw erreur('Objet JSON attendu');
  for (const k of Object.keys(body)) if (!permis.includes(k)) throw erreur(`Champ inattendu : ${k}`);
}
function nombre(v, nom, { min = 0, strict = true, max = MAX, dec = 6 } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw erreur(`${nom} : nombre attendu`);
  if (strict ? v <= min : v < min) throw erreur(`${nom} : doit être ${strict ? 'supérieur à' : 'au moins'} ${min}`);
  if (Math.abs(v) > max) throw erreur(`${nom} : valeur trop grande`);
  if (arrondi(dec)(v) !== v) throw erreur(`${nom} : ${dec} décimales au plus`);
  return v;
}
const CONTROLE = /[\u0000-\u001f\u007f]/;
function texte(v, nom, { max = 60, motif = null } = {}) {
  if (typeof v !== 'string') throw erreur(`${nom} : texte attendu`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) throw erreur(`${nom} : vide`);
  if (s.length > max) throw erreur(`${nom} : ${max} caractères au plus`);
  if (CONTROLE.test(s) || (motif && !motif.test(s))) throw erreur(`${nom} : caractères non autorisés`);
  return s;
}
function dateSaisie(v, nom, aujourdhui) {
  if (!isDate(v)) throw erreur(`${nom} : date AAAA-MM-JJ attendue`);
  if (v < '2000-01-01' || v > aujourdhui) throw erreur(`${nom} : la date doit être passée (ou aujourd'hui)`);
  return v;
}
const MOTIF_CATEGORIE = /^[\p{L}\p{N} '’&/().+-]+$/u;
const MOTIF_TRANCHE = /^[\p{L}\p{N} _-]+$/u;
const MOTIF_SYMBOLE = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;
const MOTIF_ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const MOTIF_DEVISE = /^[A-Z]{3}$/;

// Catégorie : réutilise l'orthographe existante (« actions europe » → « Actions Europe »).
function categorieCanonique(data, s) {
  const n = norm(s);
  if (n === norm(CATEGORIE_CASH)) return CATEGORIE_CASH;
  const existantes = [...data.lignes.map((l) => l.categorie), ...Object.keys(data.cible)];
  return existantes.find((c) => norm(c) === n) || s;
}

function nouvelId() {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function bougerLiquidites(data, compteId, devise, delta) {
  const c = (data.liquidites[compteId] ||= {});
  const avant = c[devise] ?? 0;
  c[devise] = r2(avant + delta);
  return { devise, avant, apres: c[devise] };
}

const libLigne = (l) => `${l.nom}${l.sous_tranche ? ` (${l.sous_tranche})` : ''}`;

// ---------------------------------------------------------------- opérations

const CHAMPS_OP = {
  achat: ['sens', 'titre', 'compte', 'tranche', 'quantite', 'prix', 'frais', 'date', 'note'],
  vente: ['sens', 'titre', 'compte', 'tranche', 'quantite', 'prix', 'frais', 'date', 'note'],
  dividende: ['sens', 'titre', 'compte', 'tranche', 'montant', 'devise', 'date', 'note'],
  versement: ['sens', 'compte', 'montant', 'devise', 'date', 'note'],
  retrait: ['sens', 'compte', 'montant', 'devise', 'date', 'note'],
  attribution: ['sens', 'titre', 'compte', 'tranche', 'quantite', 'date', 'note']
};

// Applique une opération sur une COPIE des données.
// → { data, operation, ligne, avertissements, message }
// Achat : PRU moyen pondéré, frais compris. Vente : PRU inchangé, plus-value
// réalisée = quantité × (prix − PRU) − frais. Les liquidités du compte suivent.
export function appliquerOperation(data0, body, { cours = {}, maintenant = new Date() } = {}) {
  if (!estObjet(body)) throw erreur('Objet JSON attendu');
  if (!SENS.includes(body.sens)) throw erreur(`sens : ${SENS.join(', ')} attendu`);
  const sens = body.sens;
  cles(body, CHAMPS_OP[sens]);
  const data = structuredClone(data0);
  const aujourdhui = paris(maintenant).date;
  const date = body.date == null ? aujourdhui : dateSaisie(body.date, 'date', aujourdhui);
  const note = body.note == null ? undefined : texte(body.note, 'note', { max: 140 });
  const compte = body.compte == null ? null : resoudreCompte(data, texte(body.compte, 'compte', { max: 40 }));
  const tranche = body.tranche == null ? null : texte(body.tranche, 'tranche', { max: 20, motif: MOTIF_TRANCHE });
  const avert = [];
  const op = { id: nouvelId(), date, sens };
  let ligne = null;
  let message;

  if (sens === 'versement' || sens === 'retrait') {
    if (!compte) throw erreur('compte manquant');
    const montant = nombre(body.montant, 'montant', { dec: 2 });
    const devise = body.devise == null ? 'EUR' : texte(body.devise, 'devise', { max: 3, motif: MOTIF_DEVISE });
    const liq = bougerLiquidites(data, compte.id, devise, sens === 'versement' ? montant : -montant);
    Object.assign(op, { compte: compte.id, montant, devise, avant: { liquidites: { devise, montant: liq.avant } }, apres: { liquidites: { devise, montant: liq.apres } } });
    message = `${sens === 'versement' ? 'Versement' : 'Retrait'} enregistré : ${fmtMontant(montant, devise)} · ${compte.nom}`;
  } else {
    const titre = texte(body.titre, 'titre', { max: 60 });
    ligne = resoudreLigne(data, titre, { compte, tranche });
    const c = data.comptes.find((x) => x.id === ligne.compte);
    const devise = deviseLigne(ligne, cours);
    const avantLigne = { quantite: ligne.quantite, pru: ligne.pru };
    let liq = null;
    Object.assign(op, { compte: ligne.compte, symbole: ligne.symbole, ligne: ligne.id });
    if (ligne.sous_tranche) op.sous_tranche = ligne.sous_tranche;

    if (sens === 'achat' || sens === 'vente') {
      const q = nombre(body.quantite, 'quantité', { max: 1e7 });
      const prix = nombre(body.prix, 'prix');
      const frais = body.frais == null ? 0 : nombre(body.frais, 'frais', { strict: false, dec: 2 });
      const q0 = ligne.quantite;
      if (sens === 'achat') {
        if (q0 > 0 && ligne.pru == null) avert.push(`PRU de ${libLigne(ligne)} inconnu : il reste à renseigner (patrimoine ligne ${ligne.symbole} --pru …).`);
        else ligne.pru = r4((q0 * (ligne.pru || 0) + q * prix + frais) / (q0 + q));
        ligne.quantite = r6(q0 + q);
        liq = bougerLiquidites(data, ligne.compte, devise, -(q * prix + frais));
        Object.assign(op, { quantite: q, prix, frais, montant: r2(q * prix + frais), devise });
        message = `Achat enregistré : ${fmtQ(q)} ${libLigne(ligne)} à ${fmtMontant(prix, devise)}${frais ? ` + ${fmtMontant(frais, devise)} de frais` : ''} · ${c.nom} · ${titres(ligne.quantite)}${ligne.pru != null ? `, PRU ${fmtMontant(ligne.pru, devise)}` : ''}`;
      } else {
        if (q > q0 + 1e-9) throw erreur(`Vente de ${fmtQ(q)} ${libLigne(ligne)} alors que la ligne n'en contient que ${fmtQ(q0)}`);
        const pv = ligne.pru != null ? r2(q * (prix - ligne.pru) - frais) : null;
        if (pv == null) avert.push(`PRU de ${libLigne(ligne)} inconnu : plus-value non calculée.`);
        ligne.quantite = r6(q0 - q);
        liq = bougerLiquidites(data, ligne.compte, devise, q * prix - frais);
        Object.assign(op, { quantite: q, prix, frais, montant: r2(q * prix - frais), devise, plus_value: pv });
        message = `Vente enregistrée : ${fmtQ(q)} ${libLigne(ligne)} à ${fmtMontant(prix, devise)}${frais ? ` − ${fmtMontant(frais, devise)} de frais` : ''} · ${c.nom} · reste ${fmtQ(ligne.quantite)}${pv != null ? ` · plus-value réalisée ${pv >= 0 ? '+' : ''}${fmtMontant(pv, devise)}` : ''}`;
      }
    } else if (sens === 'dividende') {
      const montant = nombre(body.montant, 'montant', { dec: 2 });
      const dev = body.devise == null ? devise : texte(body.devise, 'devise', { max: 3, motif: MOTIF_DEVISE });
      liq = bougerLiquidites(data, ligne.compte, dev, montant);
      Object.assign(op, { montant, devise: dev });
      message = `Dividende enregistré : ${fmtMontant(montant, dev)} · ${libLigne(ligne)} · ${c.nom}`;
    } else {
      // attribution d'actions gratuites : coût total inchangé, le PRU baisse.
      const q = nombre(body.quantite, 'quantité', { max: 1e7 });
      const q0 = ligne.quantite;
      if (ligne.pru != null && q0 > 0) ligne.pru = r4((q0 * ligne.pru) / (q0 + q));
      ligne.quantite = r6(q0 + q);
      Object.assign(op, { quantite: q, devise });
      message = `Attribution enregistrée : +${fmtQ(q)} ${libLigne(ligne)} · ${titres(ligne.quantite)}${ligne.pru != null ? `, PRU ${fmtMontant(ligne.pru, devise)}` : ''}`;
    }
    delete ligne._a_remplir;
    op.avant = { ligne: avantLigne };
    op.apres = { ligne: { quantite: ligne.quantite, pru: ligne.pru } };
    if (liq) {
      op.avant.liquidites = { devise: liq.devise, montant: liq.avant };
      op.apres.liquidites = { devise: liq.devise, montant: liq.apres };
    }
  }
  const liqApres = op.apres && op.apres.liquidites;
  if (liqApres && liqApres.montant < 0) {
    const nomCompte = data.comptes.find((x) => x.id === op.compte).nom;
    avert.push(`Liquidités ${liqApres.devise} de ${nomCompte} négatives (${fmtMontant(liqApres.montant, liqApres.devise)}) : à mettre à jour avec patrimoine liquidites ${op.compte} <montant>${liqApres.devise !== 'EUR' ? ` --devise ${liqApres.devise}` : ''}.`);
  }
  if (note) op.note = note;
  op.enregistre_le = maintenant.toISOString();
  data.operations.push(op);
  return { data, operation: op, ligne, avertissements: avert, message };
}

// Annule la dernière opération (et seulement elle).
export function annulerDerniere(data0) {
  const data = structuredClone(data0);
  const op = data.operations[data.operations.length - 1];
  if (!op) throw erreur('Aucune opération à annuler');
  if (!op.avant || !op.apres) throw erreur('Cette opération ne peut pas être annulée automatiquement');
  const avert = [];
  if (op.ligne) {
    const l = data.lignes.find((x) => x.id === op.ligne);
    if (!l) throw erreur('La ligne de cette opération n\'existe plus : annulation impossible');
    if (l.quantite !== op.apres.ligne.quantite || l.pru !== op.apres.ligne.pru) {
      throw erreur(`${libLigne(l)} a été modifiée depuis cette opération : annulation impossible, corrige avec patrimoine ligne`);
    }
    l.quantite = op.avant.ligne.quantite;
    l.pru = op.avant.ligne.pru;
  }
  if (op.avant.liquidites) {
    const { devise } = op.avant.liquidites;
    const c = (data.liquidites[op.compte] ||= {});
    if ((c[devise] ?? 0) === op.apres.liquidites.montant) c[devise] = op.avant.liquidites.montant;
    else avert.push('Les liquidités ont été modifiées depuis : elles n\'ont pas été restaurées.');
  }
  data.operations.pop();
  const quoi = op.symbole ? `${op.sens} ${op.quantite != null ? fmtQ(op.quantite) + ' ' : ''}${op.symbole}` : `${op.sens} ${fmtMontant(op.montant, op.devise)}`;
  return { data, operation: op, avertissements: avert, message: `Opération annulée : ${quoi} du ${op.date}` };
}

// ---------------------------------------------------------------- lignes, liquidités, cible

const CHAMPS_LIGNE = ['type', 'titre', 'symbole', 'compte', 'tranche', 'nom', 'quantite', 'pru', 'categorie', 'isin', 'devise', 'inscription', 'prime_fidelite', 'defaut', 'alias', 'supprimer'];

// Ajoute ou modifie une ligne. Sélection : `titre` (nom, alias, symbole…) ou
// `symbole` ; avec les deux, `symbole` devient le nouveau symbole de la ligne.
// Une ligne absente est créée si `symbole`, `compte` et `categorie` sont donnés.
export function modifierLigne(data0, body, { maintenant = new Date() } = {}) {
  cles(body, CHAMPS_LIGNE);
  const data = structuredClone(data0);
  const aujourdhui = paris(maintenant).date;
  const compte = body.compte == null ? null : resoudreCompte(data, texte(body.compte, 'compte', { max: 40 }));
  const tranche = body.tranche == null ? null : texte(body.tranche, 'tranche', { max: 20, motif: MOTIF_TRANCHE });
  const symbole = body.symbole == null ? null : texte(body.symbole, 'symbole', { max: 20 }).toUpperCase();
  if (symbole && !MOTIF_SYMBOLE.test(symbole)) throw erreur('symbole : symbole Yahoo attendu (ex. AI.PA, IGLN.L)');
  if (body.titre == null && !symbole) throw erreur('titre ou symbole manquant');
  let ligne = body.titre != null
    ? resoudreLigne(data, texte(body.titre, 'titre', { max: 60 }), { compte, tranche, defaut: false })
    : resoudreLigne(data, symbole, { compte, tranche, defaut: false, absentOk: true });
  const avert = [];
  let cree = false;
  let nouveauSymbole = false;

  if (body.supprimer != null) {
    if (body.supprimer !== true) throw erreur('supprimer : true attendu');
    if (!ligne) throw erreur('Ligne introuvable');
    if (Object.keys(body).some((k) => !['type', 'titre', 'symbole', 'compte', 'tranche', 'supprimer'].includes(k))) throw erreur('supprimer : aucun autre champ attendu');
    if (ligne.quantite !== 0) throw erreur(`${libLigne(ligne)} contient encore ${titres(ligne.quantite)} : mets la quantité à 0 avant de la supprimer`);
    data.lignes = data.lignes.filter((l) => l !== ligne);
    return { data, ligne, avertissements: avert, message: `Ligne supprimée : ${libLigne(ligne)} (${ligne.compte})` };
  }

  if (!ligne) {
    if (!compte) throw erreur(`${symbole} n'existe pas encore : précise le compte (--compte …) et la catégorie pour créer la ligne`);
    if (body.categorie == null) throw erreur(`${symbole} n'existe pas encore : précise la catégorie (--categorie …) pour créer la ligne`);
    ligne = { id: '', compte: compte.id, nom: symbole, symbole, isin: null, quantite: 0, pru: null, devise: null, categorie: 'Autre' };
    if (tranche) ligne.sous_tranche = tranche;
    data.lignes.push(ligne);
    ligne.id = idLigne(ligne, data.lignes);
    cree = true;
    nouveauSymbole = true;
  } else if (symbole && body.titre != null && symbole !== ligne.symbole) {
    for (const [k, v] of Object.entries(data.alias)) if (v === ligne.symbole && !data.lignes.some((l) => l !== ligne && l.symbole === v)) data.alias[k] = symbole;
    ligne.symbole = symbole;
    nouveauSymbole = true;
  }

  if (body.nom != null) ligne.nom = texte(body.nom, 'nom', { max: 60 });
  if (body.quantite != null) ligne.quantite = nombre(body.quantite, 'quantité', { strict: false, max: 1e7 });
  if (body.pru !== undefined) ligne.pru = body.pru === null ? null : nombre(body.pru, 'PRU');
  if (body.categorie != null) ligne.categorie = categorieCanonique(data, texte(body.categorie, 'catégorie', { max: 40, motif: MOTIF_CATEGORIE }));
  if (body.isin !== undefined) {
    if (body.isin === null) ligne.isin = null;
    else {
      const isin = texte(body.isin, 'ISIN', { max: 12 }).toUpperCase();
      if (!MOTIF_ISIN.test(isin)) throw erreur('ISIN : 12 caractères attendus (ex. FR0000120073)');
      ligne.isin = isin;
    }
  }
  if (body.devise !== undefined) {
    if (body.devise === null) ligne.devise = null;
    else ligne.devise = texte(body.devise, 'devise', { max: 3, motif: MOTIF_DEVISE });
  }
  if (body.inscription !== undefined) {
    ligne.date_inscription_nominatif = body.inscription === null ? null : dateSaisie(body.inscription, 'inscription', aujourdhui);
  }
  if (body.prime_fidelite != null) {
    if (typeof body.prime_fidelite !== 'boolean') throw erreur('prime_fidelite : true ou false attendu');
    ligne.prime_fidelite = body.prime_fidelite;
  }
  if (body.defaut != null) {
    if (typeof body.defaut !== 'boolean') throw erreur('defaut : true ou false attendu');
    if (body.defaut) for (const l of data.lignes) if (l !== ligne && l.symbole === ligne.symbole && l.compte === ligne.compte) delete l.defaut;
    if (body.defaut) ligne.defaut = true; else delete ligne.defaut;
  }
  if (body.alias != null) {
    const liste = Array.isArray(body.alias) ? body.alias : [body.alias];
    if (liste.length > 10) throw erreur('alias : 10 au plus');
    for (const a of liste) {
      const k = norm(texte(a, 'alias', { max: 40 }));
      if (k === '__proto__') throw erreur(`alias « ${a} » : nom réservé`);
      if (Object.hasOwn(data.alias, k) && data.alias[k] !== ligne.symbole) throw erreur(`alias « ${a} » déjà utilisé pour ${data.alias[k]}`);
      data.alias[k] = ligne.symbole;
    }
  }
  if (ligne.quantite > 0 && ligne.pru == null) avert.push(`PRU de ${libLigne(ligne)} à renseigner (--pru …) pour calculer la plus-value latente.`);
  delete ligne._a_remplir;
  const details = [`${titres(ligne.quantite)}`];
  if (ligne.pru != null) details.push(`PRU ${fmtMontant(ligne.pru, ligne.devise || 'EUR')}`);
  details.push(ligne.categorie);
  if (ligne.date_inscription_nominatif) details.push(`au nominatif depuis le ${ligne.date_inscription_nominatif}`);
  return {
    data, ligne, avertissements: avert, nouveauSymbole,
    message: `${cree ? 'Ligne ajoutée' : 'Ligne mise à jour'} : ${libLigne(ligne)} (${ligne.symbole}, ${ligne.compte}) · ${details.join(' · ')}`
  };
}

export function fixerLiquidites(data0, body) {
  cles(body, ['type', 'compte', 'montant', 'devise']);
  const data = structuredClone(data0);
  if (body.compte == null) throw erreur('compte manquant');
  const compte = resoudreCompte(data, texte(body.compte, 'compte', { max: 40 }));
  if (typeof body.montant !== 'number' || !Number.isFinite(body.montant)) throw erreur('montant : nombre attendu');
  if (Math.abs(body.montant) > MAX) throw erreur('montant : valeur trop grande');
  const devise = body.devise == null ? 'EUR' : texte(body.devise, 'devise', { max: 3, motif: MOTIF_DEVISE });
  (data.liquidites[compte.id] ||= {})[devise] = r2(body.montant);
  return { data, avertissements: [], message: `Liquidités ${compte.nom} : ${fmtMontant(r2(body.montant), devise)}` };
}

export function fixerCible(data0, body) {
  cles(body, ['type', 'cible', 'remplacer']);
  const data = structuredClone(data0);
  if (!estObjet(body.cible)) throw erreur('cible : objet { "Catégorie": pourcentage } attendu');
  if (body.remplacer != null && typeof body.remplacer !== 'boolean') throw erreur('remplacer : true ou false attendu');
  const entrees = Object.entries(body.cible);
  if (!entrees.length && !body.remplacer) throw erreur('cible : au moins une catégorie attendue');
  if (entrees.length > 20) throw erreur('cible : 20 catégories au plus');
  const nouvelle = body.remplacer ? {} : { ...data.cible };
  for (const [k, v] of entrees) {
    const cat = categorieCanonique(data, texte(k, 'catégorie', { max: 40, motif: MOTIF_CATEGORIE }));
    const pct = nombre(v, `cible ${cat}`, { strict: false, max: 100, dec: 2 });
    for (const ex of Object.keys(nouvelle)) if (norm(ex) === norm(cat)) delete nouvelle[ex];
    nouvelle[cat] = pct;
  }
  const total = r2(Object.values(nouvelle).reduce((a, b) => a + b, 0));
  if (total > 100.0001) throw erreur(`Le total des cibles ferait ${String(total).replace('.', ',')} % (plus de 100 %)`);
  data.cible = nouvelle;
  const avert = Object.keys(nouvelle).length && Math.abs(total - 100) > 0.01 ? [`Total des cibles : ${String(total).replace('.', ',')} % (et non 100 %).`] : [];
  const liste = Object.entries(nouvelle).map(([k, v]) => `${k} ${String(v).replace('.', ',')} %`).join(' · ');
  return { data, avertissements: avert, message: liste ? `Cible : ${liste}` : 'Cible effacée' };
}

// ---------------------------------------------------------------- cours nécessaires

export function symbolesNecessaires(data, cours = {}) {
  const titres = new Set(data.lignes.map((l) => l.symbole).filter(Boolean));
  const devises = new Set();
  for (const l of data.lignes) {
    if (l.devise) devises.add(l.devise);
    const q = cours[l.symbole];
    if (q && q.devise) devises.add(q.devise);
  }
  for (const liq of Object.values(data.liquidites)) for (const [dev, m] of Object.entries(liq)) if (m) devises.add(dev);
  for (const o of data.operations) if (o.devise) devises.add(o.devise);
  devises.delete('EUR');
  return [...titres, ...[...devises].sort().map(symboleChange)];
}

// ---------------------------------------------------------------- calculs

const somme = (xs) => xs.reduce((a, b) => a + b, 0);

// Tout en euros. Aucune recommandation : valeurs, écarts à la cible et dates.
export function calculer(data, cours = {}, maintenant = new Date()) {
  const now = maintenant.getTime();
  const aujourdhui = paris(maintenant).date;
  const annee = Number(aujourdhui.slice(0, 4));
  const avert = [];
  const fx = (dev) => {
    if (!dev || dev === 'EUR') return { now: 1, prev: 1, perime: false };
    const q = cours[symboleChange(dev)];
    if (!q || !(q.prix > 0)) return null;
    // Comme pour les titres, un taux ancien ne compte pas dans la variation du jour.
    const perime = estPerime(q, now);
    return { now: q.prix, prev: q.veille > 0 && !perime ? q.veille : q.prix, perime };
  };

  // -- lignes (une entrée de cache sans prix ni heure valables compte comme absente)
  const brut = data.lignes.map((l) => {
    const c = cours[l.symbole];
    const q = c && c.prix > 0 && Number.isFinite(c.heure) && !Number.isNaN(new Date(c.heure).getTime()) ? c : null;
    const devC = q ? q.devise || 'EUR' : null;
    const devL = l.devise || devC || 'EUR';
    const fxC = q ? fx(devC) : null;
    const fxL = fx(devL);
    let valeur = null; let veille = null; let source = null;
    if (q && fxC) {
      valeur = (l.quantite * q.prix) / fxC.now;
      source = 'cours';
      // Un cours ancien ne compte pas dans la variation de la séance.
      if (q.veille > 0 && !estPerime(q, now)) veille = (l.quantite * q.veille) / fxC.prev;
    } else if (l.pru != null && fxL) {
      valeur = (l.quantite * l.pru) / fxL.now;
      source = 'pru';
    }
    const cout = l.pru != null && fxL ? (l.quantite * l.pru) / fxL.now : null;
    const latente = source === 'cours' && cout != null ? valeur - cout : null;
    const perime = l.quantite > 0 && (!q || estPerime(q, now) || !!(fxC && fxC.perime));
    if (l.quantite > 0 && !q) avert.push(`Cours indisponible : ${l.symbole}${source === 'pru' ? ' (valorisé au PRU)' : ' (non compté)'}`);
    else if (l.quantite > 0 && q && !fxC) avert.push(`Taux ${devC}/EUR indisponible : ${l.symbole} ${source === 'pru' ? 'valorisé au PRU' : 'non compté'}`);
    return { l, q, devC, devL, valeur, veille, source, cout, latente, perime };
  });

  // -- liquidités
  const cash = [];
  for (const [compteId, parDevise] of Object.entries(data.liquidites)) {
    if (!data.comptes.some((c) => c.id === compteId)) { avert.push(`Liquidités d'un compte inconnu ignorées : ${compteId}`); continue; }
    for (const [dev, montant] of Object.entries(parDevise)) {
      if (!montant) continue;
      const f = fx(dev);
      if (!f) { avert.push(`Taux ${dev}/EUR indisponible : liquidités ${dev} (${compteId}) non comptées`); continue; }
      cash.push({ compte: compteId, devise: dev, montant, valeur: montant / f.now, variation: dev === 'EUR' ? 0 : montant / f.now - montant / f.prev });
    }
  }

  const total = somme(brut.filter((b) => b.valeur != null).map((b) => b.valeur)) + somme(cash.map((c) => c.valeur));
  const varJour = somme(brut.filter((b) => b.veille != null).map((b) => b.valeur - b.veille)) + somme(cash.map((c) => c.variation));
  const avecLatente = brut.filter((b) => b.latente != null);
  const latente = somme(avecLatente.map((b) => b.latente));
  const coutLatente = somme(avecLatente.map((b) => b.cout));
  const pct = (a, b) => (b > 0 ? r2((a / b) * 100) : null);

  const lignes = brut.map((b) => ({
    id: b.l.id,
    compte: b.l.compte,
    nom: b.l.nom,
    symbole: b.l.symbole,
    categorie: b.l.categorie,
    sous_tranche: b.l.sous_tranche || null,
    quantite: b.l.quantite,
    pru: b.l.pru,
    devise: b.devL,
    cours: b.q ? r4(b.q.prix) : null,
    devise_cours: b.devC,
    cours_heure: b.q ? b.q.heure : null,
    cours_date: b.q ? paris(new Date(b.q.heure)).date : null,
    perime: b.perime,
    valorisation: b.source,
    valeur: b.valeur == null ? null : r2(b.valeur),
    poids: b.valeur == null ? null : pct(b.valeur, total),
    latente: b.latente == null ? null : r2(b.latente),
    latente_pct: b.latente == null ? null : pct(b.latente, b.cout),
    variation_jour: b.veille == null ? null : r2(b.valeur - b.veille),
    variation_jour_pct: b.veille > 0 ? r2((b.valeur / b.veille - 1) * 100) : null
  })).sort((a, b) => (b.quantite > 0) - (a.quantite > 0) || (b.valeur ?? -1) - (a.valeur ?? -1));

  // -- comptes
  const comptes = data.comptes.map((c) => {
    const bs = brut.filter((b) => b.l.compte === c.id);
    const cs = cash.filter((x) => x.compte === c.id);
    const valeur = somme(bs.filter((b) => b.valeur != null).map((b) => b.valeur)) + somme(cs.map((x) => x.valeur));
    const v = somme(bs.filter((b) => b.veille != null).map((b) => b.valeur - b.veille)) + somme(cs.map((x) => x.variation));
    const lat = bs.filter((b) => b.latente != null);
    return {
      id: c.id, nom: c.nom, type: c.type,
      valeur: r2(valeur),
      liquidites: r2(somme(cs.map((x) => x.valeur))),
      poids: pct(valeur, total),
      variation_jour: r2(v),
      variation_jour_pct: valeur - v > 0 ? r2((v / (valeur - v)) * 100) : null,
      latente: lat.length ? r2(somme(lat.map((b) => b.latente))) : null
    };
  });

  // -- répartition par catégorie (orthographe de la cible prioritaire)
  const nomCat = new Map();
  for (const k of Object.keys(data.cible)) nomCat.set(norm(k), k);
  const parCat = new Map();
  const ajouter = (cat, v) => {
    const k = norm(cat);
    if (!nomCat.has(k)) nomCat.set(k, cat);
    parCat.set(k, (parCat.get(k) || 0) + v);
  };
  for (const b of brut) if (b.valeur != null && b.l.quantite > 0) ajouter(b.l.categorie, b.valeur);
  for (const c of cash) ajouter(CATEGORIE_CASH, c.valeur);
  for (const k of Object.keys(data.cible)) if (!parCat.has(norm(k))) parCat.set(norm(k), 0);
  const cibleDe = (k) => {
    const cle = Object.keys(data.cible).find((x) => norm(x) === k);
    return cle == null ? null : data.cible[cle];
  };
  const allocation = [...parCat.entries()].map(([k, v]) => {
    const poids = total > 0 ? r2((v / total) * 100) : 0;
    const cible = cibleDe(k);
    return { categorie: nomCat.get(k), valeur: r2(v), poids, cible, ecart: cible == null ? null : r2(poids - cible) };
  }).sort((a, b) => b.valeur - a.valeur || (b.cible ?? -1) - (a.cible ?? -1));
  const cibleTotal = r2(somme(Object.values(data.cible)));
  if (Object.keys(data.cible).length && Math.abs(cibleTotal - 100) > 0.01) avert.push(`Total des cibles : ${String(cibleTotal).replace('.', ',')} % (et non 100 %)`);

  // -- échéances
  const echeances = [];
  for (const c of data.comptes) {
    if (c.type !== 'PEA' || !isDate(c.date_ouverture)) continue;
    const date = ajouterAns(c.date_ouverture, 5);
    const jours = joursEntre(aujourdhui, date);
    echeances.push({
      type: 'pea5', compte: c.id, titre: `${c.type} · 5 ans`, date, jours, atteinte: jours <= 0,
      texte: jours <= 0 ? `5 ans atteints le ${dateLongue(date)}` : `5 ans le ${dateLongue(date)}`
    });
  }
  for (const l of data.lignes) {
    if (!l.prime_fidelite) continue;
    const base = { type: 'fidelite', ligne: l.id, nom: l.nom, titre: `${l.nom} · prime de fidélité`, quantite: l.quantite };
    if (!isDate(l.date_inscription_nominatif)) {
      echeances.push({ ...base, a_renseigner: true, texte: 'date d\'inscription au nominatif à renseigner' });
      continue;
    }
    // Règle Air Liquide : inscrites au nominatif depuis 2 années civiles pleines
    // à la date de détachement → inscrites l'année A, prime à partir du dividende A + 3.
    const premiere = Number(l.date_inscription_nominatif.slice(0, 4)) + 3;
    const lots = new Map();
    for (const o of data.operations) {
      if (o.ligne !== l.id || o.sens !== 'achat' || !(o.date > l.date_inscription_nominatif)) continue;
      const a = Number(o.date.slice(0, 4)) + 3;
      if (a > Math.max(annee, premiere)) lots.set(a, (lots.get(a) || 0) + o.quantite);
    }
    const suite = [...lots.entries()].sort((x, y) => x[0] - y[0]).map(([a, q]) => ({ annee: a, quantite: q }));
    echeances.push({
      ...base, annee: premiere, eligible: annee >= premiere, lots: suite,
      texte: annee >= premiere ? `+10 % sur le dividende depuis ${premiere}` : `+10 % à partir du dividende ${premiere}`
    });
  }

  // -- dividendes des 12 derniers mois
  const debut = isoJour(new Date(dUTC(aujourdhui).getTime() - 365 * JOUR));
  const divs = data.operations.filter((o) => o.sens === 'dividende' && o.date > debut && o.date <= aujourdhui);
  const parTitre = new Map();
  let totalDiv = 0;
  for (const o of divs) {
    const f = fx(o.devise || 'EUR');
    if (!f) { avert.push(`Taux ${o.devise}/EUR indisponible : un dividende n'est pas compté`); continue; }
    const v = o.montant / f.now;
    totalDiv += v;
    const l = data.lignes.find((x) => x.id === o.ligne);
    const nom = l ? l.nom : o.symbole;
    parTitre.set(nom, (parTitre.get(nom) || 0) + v);
  }

  // Date des cours : celle des lignes détenues (ou de toutes tant que rien n'est rempli).
  const tenus = brut.filter((b) => b.l.quantite > 0 && b.q).length ? brut.filter((b) => b.l.quantite > 0 && b.q) : brut.filter((b) => b.q);
  const cashTotal = somme(cash.map((c) => c.valeur));
  return {
    a_remplir: data.lignes.every((l) => !l.quantite) && !cash.length,
    total: r2(total),
    variation_jour: r2(varJour),
    variation_jour_pct: total - varJour > 0 ? r2((varJour / (total - varJour)) * 100) : null,
    latente: avecLatente.length ? r2(latente) : null,
    latente_pct: avecLatente.length ? pct(latente, coutLatente) : null,
    liquidites: r2(cashTotal),
    cours_au: tenus.length ? Math.max(...tenus.map((b) => b.q.heure)) : null,
    maj: Object.values(cours).reduce((m, q) => Math.max(m, (q && q.recupere_le) || 0), 0) || null,
    perime: brut.some((b) => b.perime) || [...new Set([...brut.map((b) => b.devC), ...cash.map((c) => c.devise)])].some((d) => d && d !== 'EUR' && fx(d) && fx(d).perime),
    comptes,
    lignes,
    allocation,
    cible_total: cibleTotal,
    echeances,
    dividendes_12m: {
      total: r2(totalDiv),
      nombre: divs.length,
      par_titre: [...parTitre.entries()].map(([nom, montant]) => ({ nom, montant: r2(montant) })).sort((a, b) => b.montant - a.montant)
    },
    avertissements: [...new Set(avert)]
  };
}

// ---------------------------------------------------------------- export JSON stable (patrimoine --json)
// Format documenté dans le README (« schema »: "barre.patrimoine/1"). Ne retirer
// ni renommer aucun champ : la revue du dimanche s'en sert pour comparer d'une
// semaine sur l'autre. Ajouter un champ est possible ; tout autre changement
// passe par "barre.patrimoine/2".
export function versJsonStable(r, { source = 'serveur', maintenant = new Date() } = {}) {
  return {
    schema: 'barre.patrimoine/1',
    source,
    genere_le: maintenant.toISOString(),
    cours_au: r.cours_au ? new Date(r.cours_au).toISOString() : null,
    perime: !!r.perime,
    a_remplir: !!r.a_remplir,
    devise: 'EUR',
    total_eur: r.total,
    variation_jour_eur: r.variation_jour,
    variation_jour_pct: r.variation_jour_pct,
    latente_eur: r.latente,
    liquidites_eur: r.liquidites,
    comptes: r.comptes.map((c) => ({
      id: c.id, nom: c.nom, type: c.type, valeur_eur: c.valeur, liquidites_eur: c.liquidites,
      variation_jour_eur: c.variation_jour, poids_pct: c.poids
    })),
    categories: r.allocation.map((a) => ({
      categorie: a.categorie, valeur_eur: a.valeur, poids_pct: a.poids, cible_pct: a.cible, ecart_pts: a.ecart
    })),
    lignes_perimees: r.lignes.filter((l) => l.perime).map((l) => l.symbole)
  };
}
