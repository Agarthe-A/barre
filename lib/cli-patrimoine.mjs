// Commande « patrimoine » : consulter et mettre à jour le patrimoine de la barre.
// Aucune dépendance. Parle au serveur de la barre (jeton de config.json) ; si le
// serveur est arrêté, modifie directement le fichier (écriture atomique).
// Uniquement des chiffres : aucun conseil d'investissement.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chargerFichier, ecrireFichier, calculer, appliquerOperation, annulerDerniere, modifierLigne,
  fixerLiquidites, fixerCible, versJsonStable, fmtMontant, fmtQ, dateLongue, ErreurSaisie
} from './patrimoine.mjs';
import { paris } from './quotes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const AIDE = `patrimoine — chiffres du patrimoine affiché sur la barre (aucun conseil).

Consulter
  patrimoine                         résumé (total, comptes, lignes, répartition, échéances)
  patrimoine --json                  totaux au format stable « barre.patrimoine/1 » (voir README)
  patrimoine historique [--n 20]     dernières opérations
  patrimoine cible                   cible actuelle par catégorie

Opérations (date du jour par défaut)
  patrimoine achat <titre> <qté> <prix> [--compte pea|ibkr] [--date AAAA-MM-JJ] [--frais x] [--tranche swing|nominatif]
  patrimoine vente <titre> <qté> <prix> [mêmes options]
  patrimoine dividende <titre> <montant> [--date …] [--devise USD]
  patrimoine versement <compte> <montant> [--devise …]   (retrait : idem)
  patrimoine attribution <titre> <qté>                     (actions gratuites)
  patrimoine annuler                                        (annule la dernière opération)

Réglages
  patrimoine ligne <symbole|titre> [--quantite q] [--pru p|aucun] [--categorie "…"] [--compte …]
                   [--nom "…"] [--tranche …] [--isin …] [--devise USD] [--symbole NOUVEAU.PA]
                   [--inscription AAAA-MM-JJ] [--fidelite] [--defaut] [--alias "nom"] [--supprimer]
  patrimoine liquidites <compte> <montant> [--devise USD]
  patrimoine cible "Actions Europe=30" "Or=10" … [--remplacer]
  patrimoine cours                   rafraîchit les cours tout de suite

<titre> : nom, alias (« air liquide », « total », « or »…), symbole Yahoo (AI.PA) ou ISIN.
Nombres : virgule ou point (180,5). Montants en euros sauf --devise.`;

// ---------------------------------------------------------------- arguments

const VALEURS = ['compte', 'date', 'frais', 'tranche', 'devise', 'quantite', 'pru', 'categorie', 'nom', 'isin', 'inscription', 'alias', 'symbole', 'n', 'note'];
const DRAPEAUX = ['json', 'remplacer', 'supprimer', 'defaut', 'fidelite', 'aide', 'help', 'h'];
const SYNONYMES = { 'catégorie': 'categorie', 'quantité': 'quantite', qte: 'quantite', 'qté': 'quantite', cat: 'categorie' };
// Options acceptées par commande (--json partout). Une option ignorée en silence
// changerait le sens d'une saisie (ex. --devise EUR sur un achat d'IGLN.L : le
// prix serait enregistré en dollars) : elle est refusée.
const OPTIONS = {
  resume: [], historique: ['n'], cible: ['remplacer'], annuler: [], cours: [],
  achat: ['compte', 'date', 'frais', 'tranche', 'note'],
  vente: ['compte', 'date', 'frais', 'tranche', 'note'],
  dividende: ['compte', 'date', 'tranche', 'devise', 'note'],
  versement: ['date', 'devise', 'note'],
  retrait: ['date', 'devise', 'note'],
  attribution: ['compte', 'date', 'tranche', 'note'],
  ligne: ['compte', 'tranche', 'nom', 'quantite', 'pru', 'categorie', 'isin', 'devise', 'inscription', 'fidelite', 'defaut', 'alias', 'supprimer', 'symbole'],
  liquidites: ['devise']
};

const COMMANDES = {
  '': 'resume', resume: 'resume', 'résumé': 'resume', total: 'resume', etat: 'resume', 'état': 'resume',
  achat: 'achat', acheter: 'achat', achete: 'achat', 'acheté': 'achat',
  vente: 'vente', vendre: 'vente', vendu: 'vente',
  dividende: 'dividende', dividendes: 'dividende',
  versement: 'versement', verser: 'versement', retrait: 'retrait',
  attribution: 'attribution',
  ligne: 'ligne', liquidites: 'liquidites', 'liquidités': 'liquidites', cash: 'liquidites',
  cible: 'cible', cibles: 'cible',
  historique: 'historique', hist: 'historique', operations: 'historique', 'opérations': 'historique',
  annuler: 'annuler', cours: 'cours', aide: 'aide', help: 'aide'
};

export class ErreurCli extends Error {}
const err = (m) => new ErreurCli(m);

export function analyser(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (/^--?[^\d-]/.test(a)) {
      const m = a.replace(/^--?/, '').match(/^([^=]+)(?:=(.*))?$/);
      const cle = SYNONYMES[m[1]] || m[1];
      if (DRAPEAUX.includes(cle)) {
        if (m[2] != null) throw err(`--${cle} ne prend pas de valeur`);
        opts[cle] = true;
      } else if (VALEURS.includes(cle)) {
        const v = m[2] != null ? m[2] : argv[++i];
        if (v == null) throw err(`--${cle} : valeur manquante`);
        if (cle === 'alias') (opts.alias ||= []).push(v);
        else opts[cle] = v;
      } else throw err(`Option inconnue : ${a} (patrimoine aide)`);
    } else pos.push(a);
  }
  const brut = (pos.shift() || '').toLowerCase();
  const commande = opts.aide || opts.help || opts.h ? 'aide' : Object.hasOwn(COMMANDES, brut) ? COMMANDES[brut] : null;
  if (!commande) throw err(`Commande inconnue : « ${brut} » (patrimoine aide)`);
  if (commande !== 'aide') {
    for (const k of Object.keys(opts)) {
      if (k !== 'json' && !OPTIONS[commande].includes(k)) {
        throw err(`--${k} ne s'applique pas à « patrimoine ${commande} »${k === 'devise' && (commande === 'achat' || commande === 'vente') ? ' : le prix est dans la devise de la ligne' : ''} (patrimoine aide)`);
      }
    }
  }
  return { commande, pos, opts };
}

// « 180,5 », « 1 234,50 € », « 62$ » → nombre
export function nombreFr(s, nom = 'nombre') {
  const t = String(s).replace(/[\s  ]/g, '').replace(/(€|eur|euros?|\$|usd|£|gbp)$/i, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw err(`${nom} : « ${s} » n'est pas un nombre`);
  return Number(t);
}

function dateOpt(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "aujourd'hui" || s === 'aujourdhui') return undefined;
  if (s === 'hier') return paris(new Date(Date.now() - 86400000)).date;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return String(v).trim();
}

const SYMBOLE_YAHOO = /^[A-Za-z0-9^][A-Za-z0-9\-^]*[.=][A-Za-z0-9.=]+$/;

// Analyse → requête HTTP pour le serveur de la barre. Pur (testable).
export function construireRequete({ commande, pos, opts }) {
  const commun = (corps) => {
    if (opts.compte) corps.compte = opts.compte;
    if (opts.tranche) corps.tranche = opts.tranche;
    const d = dateOpt(opts.date);
    if (d) corps.date = d;
    if (opts.note) corps.note = opts.note;
    return corps;
  };
  switch (commande) {
    case 'aide': return { aide: true };
    case 'resume': return { methode: 'GET', chemin: '/api/patrimoine', vue: opts.json ? 'json' : 'resume' };
    case 'historique': {
      const n = opts.n == null ? 20 : nombreFr(opts.n, '--n');
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw err('--n : entier entre 1 et 1000');
      return { methode: 'GET', chemin: '/api/patrimoine', vue: opts.json ? 'historique-json' : 'historique', n };
    }
    case 'achat':
    case 'vente': {
      // Tolère « achat air liquide 10 à 180 » : les mots « à », « @ » sont ignorés.
      const p = pos.filter((x) => !['à', '@'].includes(x));
      if (p.length < 3) throw err(`Usage : patrimoine ${commande} <titre> <quantité> <prix>`);
      const prix = nombreFr(p.pop(), 'prix');
      const quantite = nombreFr(p.pop(), 'quantité');
      const corps = commun({ sens: commande, titre: p.join(' '), quantite, prix });
      if (opts.frais != null) corps.frais = nombreFr(opts.frais, '--frais');
      return { methode: 'POST', chemin: '/api/patrimoine/operation', corps };
    }
    case 'dividende': {
      const p = [...pos];
      if (p.length < 2) throw err('Usage : patrimoine dividende <titre> <montant>');
      const montant = nombreFr(p.pop(), 'montant');
      const corps = commun({ sens: 'dividende', titre: p.join(' '), montant });
      if (opts.devise) corps.devise = opts.devise.toUpperCase();
      return { methode: 'POST', chemin: '/api/patrimoine/operation', corps };
    }
    case 'versement':
    case 'retrait': {
      if (pos.length !== 2) throw err(`Usage : patrimoine ${commande} <compte> <montant>`);
      const corps = commun({ sens: commande, montant: nombreFr(pos[1], 'montant') });
      corps.compte = pos[0];
      delete corps.tranche;
      if (opts.devise) corps.devise = opts.devise.toUpperCase();
      return { methode: 'POST', chemin: '/api/patrimoine/operation', corps };
    }
    case 'attribution': {
      const p = [...pos];
      if (p.length < 2) throw err('Usage : patrimoine attribution <titre> <quantité>');
      const quantite = nombreFr(p.pop(), 'quantité');
      return { methode: 'POST', chemin: '/api/patrimoine/operation', corps: commun({ sens: 'attribution', titre: p.join(' '), quantite }) };
    }
    case 'annuler': return { methode: 'POST', chemin: '/api/patrimoine/annuler', corps: {} };
    case 'cours': return { methode: 'POST', chemin: '/api/patrimoine/cours', corps: {} };
    case 'ligne': {
      if (!pos.length) throw err('Usage : patrimoine ligne <symbole|titre> [--quantite …] [--pru …] [--categorie …]');
      const cle = pos.join(' ');
      const corps = { type: 'ligne' };
      if (!opts.symbole && SYMBOLE_YAHOO.test(cle)) corps.symbole = cle.toUpperCase();
      else {
        corps.titre = cle;
        if (opts.symbole) corps.symbole = opts.symbole.toUpperCase();
      }
      if (opts.compte) corps.compte = opts.compte;
      if (opts.tranche) corps.tranche = opts.tranche;
      if (opts.nom) corps.nom = opts.nom;
      if (opts.quantite != null) corps.quantite = nombreFr(opts.quantite, '--quantite');
      if (opts.pru != null) corps.pru = /^(aucun|null|-)$/i.test(opts.pru) ? null : nombreFr(opts.pru, '--pru');
      if (opts.categorie) corps.categorie = opts.categorie;
      if (opts.isin) corps.isin = /^(aucun|null|-)$/i.test(opts.isin) ? null : opts.isin.toUpperCase();
      if (opts.devise) corps.devise = /^(auto|aucune|null)$/i.test(opts.devise) ? null : opts.devise.toUpperCase();
      if (opts.inscription) corps.inscription = /^(aucune|null|-)$/i.test(opts.inscription) ? null : dateOpt(opts.inscription);
      if (opts.fidelite) corps.prime_fidelite = true;
      if (opts.defaut) corps.defaut = true;
      if (opts.alias) corps.alias = opts.alias;
      if (opts.supprimer) corps.supprimer = true;
      return { methode: 'POST', chemin: '/api/patrimoine/ligne', corps };
    }
    case 'liquidites': {
      if (pos.length !== 2) throw err('Usage : patrimoine liquidites <compte> <montant> [--devise USD]');
      const corps = { type: 'liquidites', compte: pos[0], montant: nombreFr(pos[1], 'montant') };
      if (opts.devise) corps.devise = opts.devise.toUpperCase();
      return { methode: 'POST', chemin: '/api/patrimoine/ligne', corps };
    }
    case 'cible': {
      const texte = pos.join(' ').trim();
      if (!texte && !opts.remplacer) return { methode: 'GET', chemin: '/api/patrimoine', vue: opts.json ? 'json' : 'cible' };
      const cible = {};
      const re = /\s*([^=]+?)\s*=\s*(-?\d+(?:[.,]\d+)?)\s*%?/gy;
      let m;
      let fin = 0;
      while ((m = re.exec(texte))) { cible[m[1]] = nombreFr(m[2], m[1]); fin = re.lastIndex; }
      if (texte.slice(fin).trim()) throw err('Usage : patrimoine cible "Catégorie=30" "Or=10" … [--remplacer]');
      const corps = { type: 'cible', cible };
      if (opts.remplacer) corps.remplacer = true;
      return { methode: 'POST', chemin: '/api/patrimoine/ligne', corps };
    }
    default: throw err('Commande inconnue');
  }
}

// ---------------------------------------------------------------- configuration

export function chemins(env = process.env) {
  const nouveau = path.join(os.homedir(), '.config', 'barre', 'config.json');
  const config = env.BARRE_CONFIG || (fs.existsSync(nouveau) ? nouveau : (fs.existsSync(path.join(HERE, '..', 'config.json')) ? path.join(HERE, '..', 'config.json') : nouveau));
  const data = path.join(path.dirname(config), 'data');
  return { config, fichier: path.join(data, 'patrimoine.json'), cours: path.join(data, 'cours.json') };
}

async function appel(cfg, req) {
  const host = !cfg.host || cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  const url = `http://${host}:${cfg.port || 4747}${req.chemin}`;
  try {
    const r = await fetch(url, {
      method: req.methode,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: req.methode === 'POST' ? JSON.stringify(req.corps) : undefined,
      signal: AbortSignal.timeout(req.chemin.endsWith('/cours') ? 30000 : 6000)
    });
    const corps = await r.json().catch(() => ({}));
    return { status: r.status, corps };
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || (e && e.name) || '';
    // Seule une connexion jamais établie autorise l'écriture directe dans le
    // fichier ; un délai dépassé peut cacher une demande déjà enregistrée.
    return { horsLigne: ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code) && !(e && e.name === 'TimeoutError'), code };
  }
}

// Même traitement que le serveur, directement sur le fichier.
function localement(req, ch) {
  const r = chargerFichier(ch.fichier);
  if (!r.ok) throw err(`${r.error}. Corrige le fichier avant toute modification.`);
  let cours = {};
  try { cours = JSON.parse(fs.readFileSync(ch.cours, 'utf8')).cours || {}; } catch { /* pas de cache */ }
  if (req.methode === 'GET') {
    return { lecture: { ok: true, resume: calculer(r.data, cours, new Date()), operations: r.data.operations.map(({ avant, apres, ...x }) => x), cible: r.data.cible } };
  }
  if (req.chemin.endsWith('/cours')) throw err('Le serveur de la barre est arrêté : impossible de rafraîchir les cours.');
  let res;
  if (req.chemin.endsWith('/operation')) res = appliquerOperation(r.data, req.corps, { cours });
  else if (req.chemin.endsWith('/annuler')) res = annulerDerniere(r.data);
  else if (req.corps.type === 'liquidites') res = fixerLiquidites(r.data, req.corps);
  else if (req.corps.type === 'cible') res = fixerCible(r.data, req.corps);
  else res = modifierLigne(r.data, req.corps);
  ecrireFichier(ch.fichier, res.data);
  const op = res.operation ? (({ avant, apres, ...x }) => x)(res.operation) : undefined;
  return { ecriture: { ok: true, message: res.message, avertissements: res.avertissements || [], operation: op } };
}

// ---------------------------------------------------------------- affichage

const nf = (d) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (v, d = 2) => (v == null ? '—' : `${nf(d).format(v)} €`);
const sig = (v, f) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`);
const pc = (v) => sig(v, (x) => `${nf(2).format(x)} %`);
const col = (s, n, droite = false) => {
  const t = String(s);
  if (t.length > n) return t.slice(0, n - 1) + '…';
  return droite ? t.padStart(n) : t.padEnd(n);
};

export function texteResume(r, { horsLigne = false, maintenant = new Date() } = {}) {
  const L = [];
  const quand = r.cours_au || r.maj;
  const qd = quand ? new Date(quand) : null;
  const memeJour = qd && paris(qd).date === paris(maintenant).date;
  const heure = qd ? qd.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : null;
  const cours = qd ? (memeJour ? `cours de ${heure}` : `cours du ${dateLongue(paris(qd).date)}`) : 'cours en attente';
  L.push(`Patrimoine : ${eur(r.total)} · ${memeJour || !qd ? "aujourd'hui" : 'dernière séance'} ${sig(r.variation_jour, (x) => eur(x))} (${pc(r.variation_jour_pct)}) · ${cours}${r.perime ? ' · certains cours anciens' : ''}${horsLigne ? ' · serveur arrêté (cours en cache)' : ''}`);
  if (r.latente != null) L.push(`Plus-values latentes : ${sig(r.latente, (x) => eur(x))} (${pc(r.latente_pct)})`);
  if (r.a_remplir) L.push('', 'Quantités à remplir : patrimoine ligne <symbole> --quantite … --pru …');
  L.push('', 'Comptes');
  for (const c of r.comptes) L.push(`  ${col(c.nom, 26)} ${col(eur(c.valeur), 14, true)}  ${col(c.type === 'cash' ? '' : pc(c.variation_jour_pct), 9, true)}  ${col(c.poids == null ? '' : nf(1).format(c.poids) + ' %', 7, true)}`);
  const lignes = r.lignes.filter((l) => r.a_remplir || l.quantite > 0);
  if (lignes.length) {
    L.push('', `Lignes${' '.repeat(26)}${col('qté', 8, true)} ${col('cours', 11, true)} ${col('valeur', 13, true)} ${col('latent', 22, true)} ${col('jour', 9, true)}`);
    for (const l of lignes) {
      const nom = `${l.nom}${l.sous_tranche ? ' (' + l.sous_tranche + ')' : ''}`;
      const coursTxt = l.cours == null ? '—' : `${nf(2).format(l.cours)}${l.devise_cours && l.devise_cours !== 'EUR' ? ' ' + l.devise_cours : ''}`;
      const lat = l.latente == null ? '—' : `${sig(l.latente, (x) => eur(x, 0))} (${pc(l.latente_pct)})`;
      L.push(`  ${col(nom, 30)} ${col(fmtQ(l.quantite), 8, true)} ${col(coursTxt, 11, true)} ${col(eur(l.valeur, 0), 13, true)} ${col(lat, 22, true)} ${col(pc(l.variation_jour_pct), 9, true)}${l.perime ? `  cours ${l.cours_date ? 'du ' + l.cours_date : 'indisponible'}` : ''}${l.valorisation === 'pru' ? ' (valorisé au PRU)' : ''}`);
    }
  }
  if (r.allocation.length) {
    L.push('', 'Répartition (actuel · cible · écart)');
    for (const a of r.allocation) {
      L.push(`  ${col(a.categorie, 20)} ${col(nf(1).format(a.poids) + ' %', 8, true)}  ${col(a.cible == null ? 'sans cible' : nf(1).format(a.cible) + ' %', 10, true)}  ${a.ecart == null ? '' : sig(a.ecart, (x) => nf(1).format(x)) + ' pts'}`);
    }
  }
  L.push('', 'Échéances');
  for (const e of r.echeances) {
    if (e.type === 'pea5') L.push(`  ${e.compte.toUpperCase()} : ${e.texte}${e.atteinte ? '' : ` (dans ${e.jours} jours)`}`);
    else L.push(`  ${e.titre} : ${e.texte}${(e.lots || []).map((x) => ` · ${fmtQ(x.quantite)} titres achetés depuis : à partir de ${x.annee}`).join('')}`);
  }
  const d = r.dividendes_12m;
  L.push(`  Dividendes 12 mois : ${eur(d.total)} (${d.nombre} versement${d.nombre > 1 ? 's' : ''})${d.par_titre.length ? ' · ' + d.par_titre.map((x) => `${x.nom} ${eur(x.montant)}`).join(', ') : ''}`);
  if (r.avertissements.length) L.push('', ...r.avertissements.map((a) => `! ${a}`));
  return L.join('\n');
}

const SENS_LIB = { achat: 'Achat', vente: 'Vente', dividende: 'Dividende', versement: 'Versement', retrait: 'Retrait', attribution: 'Attribution' };
export function texteHistorique(ops, n = 20) {
  if (!ops.length) return 'Aucune opération enregistrée.';
  return ops.slice(-n).map((o) => {
    const dev = o.devise || 'EUR';
    const parts = [o.date, col(SENS_LIB[o.sens] || o.sens, 11), col(o.compte || '', 8)];
    if (o.symbole) parts.push(col(`${o.symbole}${o.sous_tranche ? ' ' + o.sous_tranche : ''}`, 18));
    if (o.quantite != null && o.prix != null) parts.push(`${fmtQ(o.quantite)} × ${fmtMontant(o.prix, dev)}${o.frais ? ` (frais ${fmtMontant(o.frais, dev)})` : ''}`);
    else if (o.quantite != null) parts.push(`+${fmtQ(o.quantite)}`);
    else if (o.montant != null) parts.push(fmtMontant(o.montant, dev));
    if (o.plus_value != null) parts.push(`plus-value ${o.plus_value >= 0 ? '+' : ''}${fmtMontant(o.plus_value, dev)}`);
    if (o.note) parts.push(`« ${o.note} »`);
    return parts.join('  ');
  }).join('\n');
}

function texteCible(r) {
  const avec = r.allocation.filter((a) => a.cible != null);
  if (!avec.length) return 'Aucune cible. Exemple de syntaxe : patrimoine cible "Actions Europe=30" "Or=10"';
  return avec.map((a) => `${col(a.categorie, 20)} cible ${col(nf(1).format(a.cible) + ' %', 7, true)} · actuel ${col(nf(1).format(a.poids) + ' %', 7, true)}`).join('\n')
    + `\nTotal des cibles : ${nf(1).format(r.cible_total)} %`;
}

// ---------------------------------------------------------------- exécution

export async function executer(argv, { env = process.env, out = (s) => process.stdout.write(s + '\n'), errOut = (s) => process.stderr.write(s + '\n') } = {}) {
  let req;
  let a;
  try {
    a = analyser(argv);
    req = construireRequete(a);
  } catch (e) {
    if (e instanceof ErreurCli) { errOut(e.message); return 1; }
    throw e;
  }
  if (req.aide) { out(AIDE); return 0; }
  const json = !!a.opts.json;
  const ch = chemins(env);
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(ch.config, 'utf8')); } catch { /* pas de config : fichier direct */ }

  let rep = cfg && cfg.token ? await appel(cfg, req) : { horsLigne: true };
  let horsLigne = false;
  let corps;
  if (rep.horsLigne) {
    horsLigne = true;
    try {
      const loc = localement(req, ch);
      corps = loc.lecture || loc.ecriture;
    } catch (e) {
      if (e instanceof ErreurCli || e instanceof ErreurSaisie) { errOut(e.message); return 1; }
      throw e;
    }
  } else if (rep.status == null) {
    errOut(`Le serveur de la barre ne répond pas (${rep.code || 'délai dépassé'}). Vérifie avec « patrimoine historique » avant de recommencer.`);
    return 2;
  } else if (rep.status !== 200) {
    errOut(rep.corps && rep.corps.error ? rep.corps.error : `Erreur ${rep.status}`);
    return 1;
  } else corps = rep.corps;

  if (req.methode === 'GET') {
    // Fichier abîmé : le serveur montre la dernière version correcte ; on le dit
    // (sur stderr, pour que --json reste lisible).
    if (corps.erreur_fichier) errOut(`! ${corps.erreur_fichier} : chiffres de la dernière version correcte, modifications bloquées jusqu'à correction.`);
    if (req.vue === 'json') out(JSON.stringify(versJsonStable(corps.resume, { source: horsLigne ? 'fichier' : 'serveur' }), null, 2));
    else if (req.vue === 'historique-json') out(JSON.stringify(corps.operations.slice(-req.n), null, 2));
    else if (req.vue === 'historique') out(texteHistorique(corps.operations, req.n));
    else if (req.vue === 'cible') out(texteCible(corps.resume));
    else out(texteResume(corps.resume, { horsLigne }));
    return 0;
  }
  if (json) out(JSON.stringify({ ...corps, source: horsLigne ? 'fichier' : 'serveur' }, null, 2));
  else {
    if (corps.message) out(corps.message);
    if (req.chemin.endsWith('/cours')) {
      const e = Object.entries(corps.erreurs || {});
      out(e.length ? `Cours rafraîchis, sauf : ${e.map(([s, x]) => `${s} (${x.message})`).join(', ')}` : 'Cours rafraîchis.');
    }
    for (const w of corps.avertissements || []) out(`! ${w}`);
    if (horsLigne) out('(serveur de la barre arrêté : fichier modifié directement, la barre le relira au démarrage)');
  }
  return 0;
}
