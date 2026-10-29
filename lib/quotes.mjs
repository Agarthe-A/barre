// Cours de bourse et taux de change, sans clé ni compte. Aucune dépendance.
//
// Plusieurs sources par titre, dans un ordre réglable (config.json,
// « patrimoine.sources », voir ORDRE_DEFAUT) :
//   Paris (.PA)           Boursorama → Tradegate → Yahoo
//   Londres (.L)          London Stock Exchange → Tradegate → Yahoo
//   Change (EURxxx=X)     BCE → Frankfurter → Yahoo
//   Autres                Tradegate (ISIN) → Yahoo
//
// Politesse :
//   - une seule requête par titre et par rafraîchissement. Si elle échoue, le
//     titre garde son dernier cours ; la source fautive est mise en pause et la
//     suivante prend le relais au rafraîchissement d'après ;
//   - les requêtes vers une même source partent l'une après l'autre ;
//   - HTTP 429 ou 403 : source en pause 1 h, puis 2 h tant qu'elle refuse ;
//   - les pauses sont gardées dans data/cours.json (clé « sources ») : un
//     redémarrage ne relance pas les requêtes refusées.
//
// Conditions d'utilisation (lues le 17/10/2026) : la BCE autorise la
// réutilisation de ses statistiques (citer la source) ; Frankfurter est une API
// publique gratuite. Boursorama, la LSE (LSEG), Tradegate et Yahoo réservent
// leurs sites à un usage personnel et y interdisent l'accès automatisé : à
// savoir avant de les garder dans l'ordre (config.json, patrimoine.sources).
//
// Une erreur réseau ne fait jamais tomber le serveur : on garde le dernier
// cours connu (cache mémoire + fichier) avec sa date, et l'interface l'affiche
// comme ancien (« cours du … »).

import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const ACCEPT_JSON = 'application/json, text/plain, */*';
const HOTES_YAHOO = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const SYMBOLE_OK = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;
const MOTIF_ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const MOTIF_CHANGE = /^EUR([A-Z]{3})=X$/;

const MINUTE = 60000;
const HEURE = 60 * MINUTE;
const JOUR = 24 * HEURE;
// 429/403 : 1 h la première fois, 2 h ensuite.
export const PAUSE_BLOCAGE = [HEURE, 2 * HEURE];
// Autre échec d'une source pour un titre : 30 min, puis 1 h, puis 2 h au plus.
export const PAUSE_ECHEC = 30 * MINUTE;
export const PAUSE_ECHEC_MAX = 2 * HEURE;
// Titre inconnu d'une source (tous ses codes essayés) : 6 h.
export const PAUSE_INCONNU = 6 * HEURE;

// Cotations dans une sous-unité (Londres en pence, Johannesburg en cents…) :
// on ramène à l'unité avant toute conversion.
export const SOUS_UNITES = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };

// ---------------------------------------------------------------- heure de Paris

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
});
const JOURS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// → { date: 'AAAA-MM-JJ', h, min, wd (0 = dimanche) } à l'heure de Paris
export function paris(d = new Date()) {
  const p = Object.fromEntries(FMT.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour) % 24, min: Number(p.minute), wd: JOURS.indexOf(p.weekday) };
}

// Instant (ms) d'une date + heure de Paris (minutes depuis minuit).
export function heureParis(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const essai = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const p = paris(new Date(essai));
  const [py, pm, pd] = p.date.split('-').map(Number);
  return essai - (Date.UTC(py, pm - 1, pd, p.h, p.min) - essai);
}

// Horaires (heure de Paris) des places dont la source ne date pas les cours.
export const HORAIRES = {
  paris: { ouverture: 9 * 60, cloture: 17 * 60 + 35 },
  tradegate: { ouverture: 8 * 60, cloture: 22 * 60 }
};

// Dernier instant de cotation (lundi–vendredi, jours fériés ignorés).
export function derniereSeance(now, { ouverture, cloture }) {
  const p = paris(new Date(now));
  const m = p.h * 60 + p.min;
  if (p.wd >= 1 && p.wd <= 5 && m >= ouverture) return m < cloture ? now : heureParis(p.date, cloture);
  let t = Date.parse(`${p.date}T12:00:00Z`);
  do { t -= JOUR; } while ([0, 6].includes(new Date(t).getUTCDay()));
  return heureParis(new Date(t).toISOString().slice(0, 10), cloture);
}

// Heure d'un cours dont on ne connaît que le jour de séance.
function heureDuJour(jour, now, horaires) {
  if (!jour) return derniereSeance(now, horaires);
  const p = paris(new Date(now));
  if (jour > p.date || (jour === p.date && p.h * 60 + p.min < horaires.cloture)) return now;
  return heureParis(jour, horaires.cloture);
}

const hhmm = (t) => { const p = paris(new Date(t)); return `${p.h}:${String(p.min).padStart(2, '0')}`; };

// Toutes les 15 min en semaine de 9:00 à 17:45 (heure de Paris), toutes les 2 h sinon.
export const QUINZE_MIN = 15 * 60000;
export const DEUX_H = 2 * 3600000;
export function intervalleCours(d = new Date()) {
  const p = paris(d);
  const m = p.h * 60 + p.min;
  return p.wd >= 1 && p.wd <= 5 && m >= 9 * 60 && m <= 17 * 60 + 45 ? QUINZE_MIN : DEUX_H;
}

// Un cours est ancien si la séance date de plus de 4 jours (week-end + férié
// compris) ou si les dernières mises à jour ont échoué (1 h en séance, 5 h sinon).
// Le seuil d'1 h ne s'applique qu'après 1 h de séance : à 9:00, la dernière
// lecture date du rythme de nuit (2 h) sans qu'aucune mise à jour ait échoué.
export function estPerime(q, now = Date.now()) {
  if (!q || !q.heure) return true;
  if (now - q.heure > 4 * 86400000) return true;
  if (!q.recupere_le) return false;
  const enSeance = (t) => intervalleCours(new Date(t)) === QUINZE_MIN;
  const seuil = enSeance(now) && enSeance(now - 3600000) ? 3600000 : 5 * 3600000;
  return now - q.recupere_le > seuil;
}

// Taux de change : EURUSD=X vaut « dollars pour 1 € ».
export const symboleChange = (devise) => `EUR${devise}=X`;

// ---------------------------------------------------------------- petits outils

const estObjet = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const estDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const arrondi6 = (x) => Math.round(x * 1e6) / 1e6;
const inconnu = (message) => Object.assign(new Error(message), { inconnu: true });

// Nombre écrit à l'anglaise (172.1) ou à l'allemande (« 172,10 », « 1.234,5 »).
export function nombre(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  let s = v.replace(/[\s\u00a0\u202f]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : NaN;
}

function csvLigne(l) {
  const out = [];
  let cur = '';
  let guillemets = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (guillemets) {
      if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') guillemets = false; else cur += c;
    } else if (c === '"') guillemets = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- Yahoo (« chart »)

export function parseChart(json, demande) {
  const r = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  if (!r || !r.meta) {
    const e = json && json.chart && json.chart.error;
    throw Object.assign(new Error((e && (e.description || e.code)) || 'réponse vide'), { inconnu: !!e });
  }
  const m = r.meta;
  let devise = m.currency || null;
  let div = 1;
  if (devise && SOUS_UNITES[devise]) [devise, div] = SOUS_UNITES[devise];
  const ts = Array.isArray(r.timestamp) ? r.timestamp : [];
  const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const barres = ts.map((t, i) => ({ t, c: closes[i] })).filter((b) => typeof b.c === 'number' && Number.isFinite(b.c) && b.c > 0);
  const prix = typeof m.regularMarketPrice === 'number' && m.regularMarketPrice > 0 ? m.regularMarketPrice : (barres.length ? barres[barres.length - 1].c : null);
  const heure = typeof m.regularMarketTime === 'number' ? m.regularMarketTime : (barres.length ? barres[barres.length - 1].t : null);
  if (!(prix > 0) || !heure) throw new Error('cours absent');
  // Clôture de la veille = dernière clôture d'une séance antérieure à celle du
  // dernier cours. (chartPreviousClose est la clôture d'avant la période de
  // 5 jours, pas celle de la veille : on ne s'en sert qu'en dernier recours.)
  const decalage = Number(m.gmtoffset) || 0;
  const jour = (t) => new Date((t + decalage) * 1000).toISOString().slice(0, 10);
  const jourCours = jour(heure);
  let veille = null;
  for (let i = barres.length - 1; i >= 0; i--) {
    if (jour(barres[i].t) < jourCours) { veille = barres[i].c; break; }
  }
  if (veille == null && typeof m.previousClose === 'number') veille = m.previousClose;
  if (veille == null && barres.length <= 1 && typeof m.chartPreviousClose === 'number') veille = m.chartPreviousClose;
  return {
    symbole: String(m.symbol || demande || '').toUpperCase(),
    prix: prix / div,
    veille: veille != null && veille > 0 ? veille / div : null,
    devise,
    devise_cotation: m.currency || null,
    heure: heure * 1000,
    place: m.exchangeName || null,
    nom: m.shortName || m.longName || null
  };
}

// ---------------------------------------------------------------- Boursorama (Euronext Paris)

// {"d":[{"o","h","l","c","v","var","qt":[{"d":AAMMJJhhmm,…}]}]} ; « var » est la
// variation en euros depuis la clôture de la veille (pas en %). « [] » : inconnu.
export function parseBoursorama(json, demande, { now = Date.now() } = {}) {
  const o = json && Array.isArray(json.d) ? json.d[0] : null;
  if (!estObjet(o)) throw inconnu('symbole inconnu');
  const prix = nombre(o.c);
  if (!(prix > 0)) throw new Error('cours absent');
  const variation = nombre(o.var);
  const veille = Number.isFinite(variation) ? arrondi6(prix - variation) : NaN;
  let jour = null;
  for (const b of Array.isArray(o.qt) ? o.qt : []) {
    const m = /^(\d{2})(\d{2})(\d{2})\d{4}$/.exec(String(b && b.d));
    if (m) jour = `20${m[1]}-${m[2]}-${m[3]}`;
  }
  return {
    symbole: demande, prix, veille: veille > 0 ? veille : null, devise: 'EUR', devise_cotation: 'EUR',
    heure: heureDuJour(jour, now, HORAIRES.paris), place: 'Euronext Paris', nom: null
  };
}

// ---------------------------------------------------------------- London Stock Exchange

// api.londonstockexchange.com/api/gw/lse/instruments/alldata/<TIDM> ; heures en UTC
// sans fuseau ; devise USD, GBP ou GBX (pence).
export function parseLse(json, demande, { isin = null } = {}) {
  if (!estObjet(json)) throw new Error('réponse vide');
  if (isin && json.isin && json.isin !== isin) throw inconnu(`autre instrument (ISIN ${json.isin})`);
  const cot = typeof json.currency === 'string' && json.currency ? json.currency : null;
  if (!cot) throw new Error('devise absente');
  let devise = cot;
  let div = 1;
  if (SOUS_UNITES[cot]) [devise, div] = SOUS_UNITES[cot];
  const dernier = nombre(json.lastprice);
  const prix = dernier > 0 ? dernier : nombre(json.lastclose);
  const t = dernier > 0 ? (json.lastpricedate || json.lastclosedate) : json.lastclosedate;
  const heure = typeof t === 'string' ? Date.parse(/(z|[+-]\d\d:?\d\d)$/i.test(t) ? t : `${t}Z`) : NaN;
  if (!(prix > 0) || !Number.isFinite(heure)) throw new Error('cours absent');
  let veille = nombre(json.previousreferenceprice);
  if (!(veille > 0) && dernier > 0 && Number.isFinite(nombre(json.netchange))) veille = dernier - nombre(json.netchange);
  return {
    symbole: demande, prix: arrondi6(prix / div), veille: veille > 0 ? arrondi6(veille / div) : null,
    devise, devise_cotation: cot, heure, place: 'LSE', nom: json.name || null
  };
}

// ---------------------------------------------------------------- Tradegate (par ISIN, en euros)

// www.tradegatebsx.com/refresh.php?isin=… : last, close (clôture de la veille),
// bid/ask, parfois en chaîne « 172,10 ». Corps vide : ISIN inconnu. Pas d'heure :
// on prend le dernier instant de cotation (8:00–22:00).
export function parseTradegate(json, demande, { now = Date.now() } = {}) {
  if (!estObjet(json)) throw inconnu('ISIN inconnu');
  const last = nombre(json.last);
  const bid = nombre(json.bid);
  const ask = nombre(json.ask);
  const prix = last > 0 ? last : (bid > 0 && ask > 0 ? arrondi6((bid + ask) / 2) : NaN);
  if (!(prix > 0)) throw new Error('cours absent');
  const close = nombre(json.close);
  return {
    symbole: demande, prix, veille: close > 0 ? close : null, devise: 'EUR', devise_cotation: 'EUR',
    heure: derniereSeance(now, HORAIRES.tradegate), heure_estimee: true, place: 'Tradegate', nom: null
  };
}

// ---------------------------------------------------------------- taux de change (BCE, Frankfurter)

function tauxDepuis(obs, demande, devise, place) {
  if (!obs.length) throw inconnu('taux inconnu');
  const [jour, prix] = obs[obs.length - 1];
  return {
    symbole: demande, prix, veille: obs.length > 1 ? obs[obs.length - 2][1] : null, devise, devise_cotation: devise,
    // Taux de référence BCE : 14:15 (heure de Francfort = heure de Paris).
    heure: heureParis(jour, 14 * 60 + 15), place, nom: `EUR/${devise}`
  };
}

const deviseDe = (demande) => {
  const m = MOTIF_CHANGE.exec(String(demande || ''));
  if (!m) throw inconnu('taux de change attendu (EURxxx=X)');
  return m[1];
};

// data-api.ecb.europa.eu, format=csvdata : une ligne par observation.
export function parseBce(texte, demande) {
  const dev = deviseDe(demande);
  const lignes = String(texte ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (lignes.length < 2) throw inconnu('taux inconnu');
  const tete = csvLigne(lignes[0]);
  const iJ = tete.indexOf('TIME_PERIOD');
  const iV = tete.indexOf('OBS_VALUE');
  const iD = tete.indexOf('CURRENCY');
  const iB = tete.indexOf('CURRENCY_DENOM');
  if (iJ < 0 || iV < 0) throw new Error('réponse illisible');
  const obs = lignes.slice(1).map(csvLigne)
    .filter((c) => (iD < 0 || c[iD] === dev) && (iB < 0 || c[iB] === 'EUR') && estDate(c[iJ]) && nombre(c[iV]) > 0)
    .map((c) => [c[iJ], nombre(c[iV])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return tauxDepuis(obs, demande, dev, 'BCE');
}

// api.frankfurter.dev/v1 : série {"rates":{"AAAA-MM-JJ":{"USD":…}}} ou dernier taux
// {"date":…,"rates":{"USD":…}}.
export function parseFrankfurter(json, demande) {
  const dev = deviseDe(demande);
  if (!estObjet(json) || !estObjet(json.rates)) throw new Error('réponse vide');
  let obs;
  if (Object.keys(json.rates).some(estDate)) {
    obs = Object.entries(json.rates)
      .filter(([j, r]) => estDate(j) && estObjet(r) && nombre(r[dev]) > 0)
      .map(([j, r]) => [j, nombre(r[dev])])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  } else {
    obs = estDate(json.date) && nombre(json.rates[dev]) > 0 ? [[json.date, nombre(json.rates[dev])]] : [];
  }
  return tauxDepuis(obs, demande, dev, 'Frankfurter (BCE)');
}

// ---------------------------------------------------------------- sources

// Codes Boursorama des trackers (« 1rT… ») ; les actions de Paris sont en « 1rP… ».
// Pour un titre absent d'ici, on essaie 1rP puis 1rT (un essai par rafraîchissement).
export const CODES_BOURSORAMA = { 'PSP5.PA': '1rTPSP5', 'WPEA.PA': '1rTWPEA' };

const codesChange = (s) => { const m = MOTIF_CHANGE.exec(s); return m ? [m[1]] : []; };

// codes(symbole, info) → identifiants à essayer ([] : source non concernée) ;
// url(code, { essai, now }) ; lire(corps, symbole, { now, isin }).
export const SOURCES = {
  boursorama: {
    nom: 'Boursorama',
    codes(s) {
      const m = /^([A-Z0-9]{1,12})\.PA$/.exec(s);
      if (!m) return [];
      return Object.hasOwn(CODES_BOURSORAMA, s) ? [CODES_BOURSORAMA[s]] : [`1rP${m[1]}`, `1rT${m[1]}`];
    },
    url: (code) => `https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts?symbol=${encodeURIComponent(code)}&period=-1`,
    lire: (corps, s, o) => parseBoursorama(corps, s, o)
  },
  lse: {
    nom: 'London Stock Exchange',
    codes(s) { const m = /^([A-Z0-9]{2,6})\.L$/.exec(s); return m ? [m[1]] : []; },
    url: (code) => `https://api.londonstockexchange.com/api/gw/lse/instruments/alldata/${encodeURIComponent(code)}`,
    lire: (corps, s, o) => parseLse(corps, s, o)
  },
  tradegate: {
    nom: 'Tradegate',
    codes: (s, info) => (!MOTIF_CHANGE.test(s) && info && MOTIF_ISIN.test(String(info.isin || '')) ? [info.isin] : []),
    url: (code) => `https://www.tradegatebsx.com/refresh.php?isin=${encodeURIComponent(code)}`,
    lire: (corps, s, o) => parseTradegate(corps, s, o)
  },
  bce: {
    nom: 'BCE',
    texte: true,
    accept: 'text/csv',
    codes: codesChange,
    url: (code) => `https://data-api.ecb.europa.eu/service/data/EXR/D.${code}.EUR.SP00.A?lastNObservations=2&format=csvdata`,
    lire: (corps, s) => parseBce(corps, s)
  },
  frankfurter: {
    nom: 'Frankfurter',
    codes: codesChange,
    url: (code, { now }) => `https://api.frankfurter.dev/v1/${new Date(now - 10 * JOUR).toISOString().slice(0, 10)}..?base=EUR&symbols=${code}`,
    lire: (corps, s) => parseFrankfurter(corps, s)
  },
  yahoo: {
    nom: 'Yahoo',
    codes: (s) => [s],
    // Après un échec, l'essai suivant passe par l'autre hôte.
    url: (code, { essai }) => `https://${HOTES_YAHOO[essai % 2]}/v8/finance/chart/${encodeURIComponent(code)}?range=5d&interval=1d`,
    lire: (corps, s) => parseChart(corps, s)
  }
};

// Ordre par symbole exact, par place (suffixe après le point), « FX » pour les
// taux de change, « * » pour le reste. Un tableau seul vaut pour tous les titres.
export const ORDRE_DEFAUT = {
  PA: ['boursorama', 'tradegate', 'yahoo'],
  L: ['lse', 'tradegate', 'yahoo'],
  FX: ['bce', 'frankfurter', 'yahoo'],
  '*': ['tradegate', 'yahoo']
};

export function chaineSources(symbole, ordre = null) {
  const valide = (l) => (Array.isArray(l) ? [...new Set(l.filter((id) => typeof id === 'string' && Object.hasOwn(SOURCES, id)))] : []);
  if (Array.isArray(ordre)) {
    const l = valide(ordre);
    if (l.length) return l;
    ordre = null;
  }
  // Réglage de l'utilisateur d'abord (symbole, place, « * »), puis l'ordre par défaut.
  const perso = estObjet(ordre) ? ordre : {};
  const place = MOTIF_CHANGE.test(symbole) ? 'FX' : (symbole.includes('.') ? symbole.split('.').pop() : '*');
  for (const cle of [symbole, place, '*']) {
    const l = Object.hasOwn(perso, cle) ? valide(perso[cle]) : [];
    if (l.length) return l;
  }
  return Object.hasOwn(ORDRE_DEFAUT, place) ? ORDRE_DEFAUT[place] : ORDRE_DEFAUT['*'];
}

// ---------------------------------------------------------------- service (cache + rafraîchissement)

function ecrireAtomique(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function corpsDe(r, texte) {
  if (typeof r.text !== 'function') return r.json().catch(() => null);
  const t = await r.text();
  if (texte) return t;
  if (!t.trim()) return undefined;
  try { return JSON.parse(t); } catch { throw new Error('réponse illisible'); }
}

const codeErreur = (e) => String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.message) || '');
// Réseau de la maison coupé (pas la faute de la source) : pas de pause.
const reseauLocal = (e) => /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN/.test(codeErreur(e));
const reseau = (e) => reseauLocal(e) || /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|UND_ERR|fetch failed/.test(codeErreur(e));

function lireEtat(j) {
  const etat = { bloc: {}, paire: {} };
  if (!estObjet(j)) return etat;
  for (const [id, b] of Object.entries(estObjet(j.bloc) ? j.bloc : {})) {
    if (Object.hasOwn(SOURCES, id) && estObjet(b) && Number.isFinite(b.jusqua)) etat.bloc[id] = b;
  }
  for (const [cle, p] of Object.entries(estObjet(j.paire) ? j.paire : {})) {
    const [id, s] = cle.split('|');
    if (Object.hasOwn(SOURCES, id) && SYMBOLE_OK.test(s || '') && estObjet(p)) etat.paire[cle] = p;
  }
  return etat;
}

// fixtures : dossier de réponses Yahoo enregistrées (<SYMBOLE>.json), pour les
// tests et le bac à sable sans Internet. fetchImpl, horloge : remplaçables dans
// les tests. ordre : voir chaineSources. espacement : délai entre deux requêtes
// vers une même source.
export function creerServiceCours({
  fichierCache = null, fixtures = null, fetchImpl = (...a) => fetch(...a), delai = 8000,
  ordre = null, horloge = () => Date.now(), espacement = 300
} = {}) {
  let cache = {};
  let etat = { bloc: {}, paire: {} };
  if (fichierCache) {
    try {
      const j = JSON.parse(fs.readFileSync(fichierCache, 'utf8'));
      if (j && estObjet(j.cours)) cache = j.cours;
      if (j) etat = lireEtat(j.sources);
    } catch { /* pas encore de cache */ }
  }
  let erreurs = {};

  // Une file par source : une requête à la fois, espacées.
  const files = new Map();
  function tour(id) {
    const avant = files.get(id) || Promise.resolve();
    let finir;
    const fin = new Promise((r) => { finir = r; });
    files.set(id, avant.then(() => fin));
    return avant.then(() => (requete) => {
      if (requete && espacement > 0) setTimeout(finir, espacement); else finir();
    });
  }

  function noterEchec(id, cle, e, v, nbCodes) {
    const t = horloge();
    const motif = String((e && e.message) || 'erreur').slice(0, 80);
    if (e && e.blocage) {
      const b = etat.bloc[id];
      const niveau = (b && t - b.jusqua < JOUR ? b.niveau | 0 : 0) + 1;
      etat.bloc[id] = { jusqua: t + PAUSE_BLOCAGE[Math.min(niveau, PAUSE_BLOCAGE.length) - 1], niveau, motif, le: t };
      return;
    }
    const p = etat.paire[cle] || {};
    if (e && e.inconnu && !p.ok) {
      // Code suivant au prochain rafraîchissement ; tous essayés : pause.
      etat.paire[cle] = v + 1 < nbCodes ? { v: v + 1, motif, le: t } : { v: 0, jusqua: t + PAUSE_INCONNU, motif, le: t };
      return;
    }
    if (reseauLocal(e)) return;
    const n = (p.n | 0) + 1;
    etat.paire[cle] = { ...p, n, jusqua: t + Math.min(PAUSE_ECHEC * 2 ** (n - 1), PAUSE_ECHEC_MAX), motif, le: t };
  }

  async function essayer(id, src, codes, s, info, horsJeu) {
    const cle = `${id}|${s}`;
    const p = etat.paire[cle] || {};
    const v = Math.min(Math.max(0, p.v | 0), codes.length - 1);
    const url = src.url(codes[v], { essai: p.n | 0, now: horloge() });
    try {
      const r = await fetchImpl(url, {
        headers: { 'user-agent': UA, accept: src.accept || ACCEPT_JSON },
        signal: AbortSignal.timeout(delai),
        redirect: 'follow'
      });
      if (r.status === 429 || r.status === 403) throw Object.assign(new Error(`HTTP ${r.status}`), { blocage: true });
      if (r.status === 404 || r.status === 410) throw inconnu('symbole inconnu');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const q = src.lire(await corpsDe(r, src.texte), s, { now: horloge(), isin: info.isin || null });
      etat.paire[cle] = { v, ok: horloge() };
      delete etat.bloc[id];
      return { ...q, source: id };
    } catch (e) {
      noterEchec(id, cle, e, v, codes.length);
      // Source qui refuse ou ne répond plus : les titres qui attendent leur tour
      // passent à la source suivante (sans dépasser une requête chacun). Une
      // erreur HTTP 5xx peut ne concerner qu'un titre : les autres essaient.
      if (e && (e.blocage || e.name === 'TimeoutError' || e.name === 'AbortError' || reseau(e))) horsJeu.add(id);
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { source: id });
    }
  }

  async function lireUn(s, info, horsJeu) {
    if (!SYMBOLE_OK.test(s)) throw Object.assign(new Error('symbole invalide'), { inconnu: true });
    if (fixtures) {
      const f = path.join(fixtures, `${s}.json`);
      if (!fs.existsSync(f)) throw Object.assign(new Error('symbole inconnu'), { inconnu: true });
      return parseChart(JSON.parse(fs.readFileSync(f, 'utf8')), s);
    }
    let pause = 0;
    let concernee = false;
    for (const id of chaineSources(s, ordre)) {
      const src = SOURCES[id];
      const codes = src.codes(s, info);
      if (!codes.length) continue;
      concernee = true;
      const libre = () => {
        const t = horloge();
        for (const x of [etat.bloc[id], etat.paire[`${id}|${s}`]]) {
          if (x && x.jusqua > t) { pause = pause ? Math.min(pause, x.jusqua) : x.jusqua; return false; }
        }
        return !horsJeu.has(id);
      };
      if (!libre()) continue;
      const liberer = await tour(id);
      let requete = false;
      try {
        if (!libre()) continue;
        requete = true;
        return await essayer(id, src, codes, s, info, horsJeu);
      } finally {
        liberer(requete);
      }
    }
    if (!concernee) throw Object.assign(new Error('aucune source pour ce symbole'), { inconnu: true });
    throw new Error(pause ? `sources en pause jusqu'à ${hhmm(pause)}` : 'sources indisponibles');
  }

  function enregistrer() {
    if (!fichierCache) return;
    const t = horloge();
    for (const [id, b] of Object.entries(etat.bloc)) if (!(b.jusqua > t - JOUR)) delete etat.bloc[id];
    for (const [cle, p] of Object.entries(etat.paire)) if (!p.ok && !(p.v > 0) && !(p.jusqua > t - JOUR)) delete etat.paire[cle];
    try { ecrireAtomique(fichierCache, { cours: cache, sources: etat }); } catch { /* le cache disque est facultatif */ }
  }

  // infos : { SYMBOLE: { isin } } (Tradegate cote par ISIN, LSE vérifie l'ISIN).
  async function rafraichir(symboles, infos = {}) {
    const liste = [...new Set((symboles || []).map((s) => String(s).toUpperCase()))];
    const horsJeu = new Set();
    const resultats = await Promise.all(liste.map(async (s) => {
      try {
        const info = estObjet(infos) && Object.hasOwn(infos, s) && estObjet(infos[s]) ? infos[s] : {};
        const q = await lireUn(s, info, horsJeu);
        cache[s] = { ...q, symbole: s, recupere_le: horloge() };
        delete erreurs[s];
        return { symbole: s, ok: true, source: q.source || null };
      } catch (e) {
        const code = e && e.cause && e.cause.code;
        const msg = e && e.name === 'TimeoutError' ? 'délai dépassé' : String((e && e.message) || 'erreur').concat(code && !String(e.message).includes(code) ? ` (${code})` : '').slice(0, 80);
        erreurs[s] = { message: msg, inconnu: !!(e && e.inconnu), le: horloge(), source: (e && e.source) || null };
        if (cache[s]) cache[s] = { ...cache[s], echec: msg };
        return { symbole: s, ok: false, erreur: msg };
      }
    }));
    enregistrer();
    return resultats;
  }

  return {
    cours: () => cache,
    erreurs: () => ({ ...erreurs }),
    // Pauses en cours (diagnostic, tests).
    etatSources: () => JSON.parse(JSON.stringify(etat)),
    rafraichir,
    // Mode démo : cours fournis tels quels.
    remplacer(c) { cache = { ...(c || {}) }; erreurs = {}; }
  };
}
