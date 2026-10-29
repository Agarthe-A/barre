// Tests de bout en bout : vrai serveur sur un port libre, HOME et config
// temporaires, cours Yahoo enregistrés (BARRE_COURS_FIXTURES). Puis la commande
// « patrimoine » contre ce serveur, et sans serveur (écriture directe).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'yahoo');
const TOKEN = 'jeton-de-test-0123456789';
let dir; let cfgPath; let port; let base; let srv;

const libre = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

function demarrer() {
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, HOME: dir, BARRE_CONFIG: cfgPath, BARRE_COURS_FIXTURES: FIX, BARRE_DEMO: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.journal = '';
  srv.stdout.on('data', (d) => { srv.journal += d; });
  srv.stderr.on('data', (d) => { srv.journal += d; });
}
async function pret() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.ok) {
        const s = await r.json();
        if (s.patrimoine && s.patrimoine.ok && Object.keys(s.patrimoine.lignes).length) return s;
      }
    } catch { /* pas encore prêt */ }
    await attendre(100);
  }
  throw new Error('serveur non démarré : ' + srv.journal);
}
const arreter = () => new Promise((resolve) => { if (!srv || srv.exitCode != null) return resolve(); srv.once('exit', resolve); srv.kill('SIGTERM'); });

const api = async (methode, p, corps, headers = { authorization: `Bearer ${TOKEN}` }) => {
  const r = await fetch(base + p, {
    method: methode,
    headers: { 'content-type': 'application/json', ...headers },
    body: corps === undefined ? undefined : typeof corps === 'string' ? corps : JSON.stringify(corps)
  });
  return { status: r.status, corps: await r.json().catch(() => ({})) };
};
const op = (corps) => api('POST', '/api/patrimoine/operation', corps);
const ligne = (corps) => api('POST', '/api/patrimoine/ligne', corps);
const etat = async () => (await api('GET', '/api/state')).corps.patrimoine;

function cli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'patrimoine.mjs'), ...args], { env: { ...process.env, HOME: dir, BARRE_CONFIG: cfgPath, ...env } }, (e, stdout, stderr) => {
      resolve({ code: e ? e.code : 0, out: stdout, err: stderr });
    });
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barre-patri-'));
  cfgPath = path.join(dir, '.config', 'barre', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  port = await libre();
  base = `http://127.0.0.1:${port}`;
  // Sources du Mac coupées : seul le patrimoine tourne.
  fs.writeFileSync(cfgPath, JSON.stringify({
    token: TOKEN, port, host: '127.0.0.1', docker: false,
    music: { enabled: false }, reminders: { enabled: false }, plex: { enabled: false }, hue: { enabled: false },
    priorities: { enabled: false }, googleCalendar: { enabled: false }, externalDisk: { enabled: false }
  }));
  demarrer();
  await pret();
});
after(async () => {
  if (process.env.BARRE_TEST_JOURNAL) process.stderr.write(srv.journal);
  await arreter();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('premier démarrage : patrimoine.json créé (600) avec quantités à remplir ; cours lus', async () => {
  const f = path.join(path.dirname(cfgPath), 'data', 'patrimoine.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(d.lignes.length >= 7 && d.lignes.every((l) => l.quantite === 0));
  let p = await etat();
  for (let i = 0; i < 50 && !p.lignes.every((l) => l.cours != null); i++) { await attendre(100); p = await etat(); }
  assert.equal(p.a_remplir, true);
  assert.ok(p.lignes.every((l) => l.cours != null), 'tous les cours chargés depuis les réponses enregistrées');
  assert.equal(fs.statSync(path.join(path.dirname(f), 'cours.json')).mode & 0o777, 0o600);
  assert.ok(p.echeances.some((e) => e.type === 'fidelite' && e.a_renseigner));
  // l'état public ne contient ni opérations ni jeton
  const brut = JSON.stringify((await api('GET', '/api/state')).corps);
  assert.ok(!brut.includes(TOKEN));
  assert.ok(!brut.includes('"operations"'));
});

test('authentification et origine : mêmes règles que les autres POST', async () => {
  const corps = { sens: 'versement', compte: 'pea', montant: 1 };
  assert.equal((await api('POST', '/api/patrimoine/operation', corps, {})).status, 401);
  assert.equal((await api('POST', '/api/patrimoine/operation', corps, { authorization: 'Bearer mauvais' })).status, 401);
  assert.equal((await api('GET', '/api/patrimoine', undefined, {})).status, 401);
  // cookie sans même origine → refusé ; cookie + même origine → accepté
  assert.equal((await api('POST', '/api/patrimoine/ligne', { type: 'liquidites', compte: 'pea', montant: 0 }, { cookie: `barre_token=${TOKEN}` })).status, 403);
  assert.equal((await api('POST', '/api/patrimoine/ligne', { type: 'liquidites', compte: 'pea', montant: 0 }, { cookie: `barre_token=${TOKEN}`, origin: 'https://ailleurs.example' })).status, 403);
  assert.equal((await api('POST', '/api/patrimoine/ligne', { type: 'liquidites', compte: 'pea', montant: 0 }, { cookie: `barre_token=${TOKEN}`, 'sec-fetch-site': 'same-origin' })).status, 200);
});

test('validation stricte des requêtes', async () => {
  const ko = async (r, re) => { const x = await r; assert.equal(x.status, 400, JSON.stringify(x.corps)); assert.match(x.corps.error, re); };
  await ko(api('POST', '/api/patrimoine/operation', '{"sens":'), /JSON invalide/);
  await ko(api('POST', '/api/patrimoine/operation', '[1,2]'), /objet JSON/);
  await ko(op({}), /sens/);
  await ko(op({ sens: 'achat', titre: 'TTE', quantite: '10', prix: 60 }), /nombre attendu/);
  await ko(op({ sens: 'achat', titre: 'TTE', quantite: 10, prix: 60, extra: 1 }), /Champ inattendu/);
  await ko(op({ sens: 'achat', titre: 'Thales', quantite: 10, prix: 60 }), /Titre inconnu/);
  await ko(op({ sens: 'vente', titre: 'TTE', quantite: 10, prix: 60 }), /n'en contient que 0/);
  await ko(op({ sens: 'achat', titre: 'TTE', quantite: 1, prix: 60, date: '2999-01-01' }), /passée/);
  await ko(ligne({ type: 'autre' }), /type/);
  await ko(ligne({ type: 'cible', cible: { Or: 80, Monde: 30 } }), /plus de 100/);
  await ko(ligne({ symbole: 'AI.PA', quantite: 21 }), /tranche/);
  // Corps de plus de 16 Ko : refusé (le serveur coupe la connexion, comme pour les autres routes).
  const gros = await api('POST', '/api/patrimoine/operation', JSON.stringify({ sens: 'achat', note: 'x'.repeat(20000) })).catch(() => ({ status: 'coupé' }));
  assert.ok(gros.status === 400 || gros.status === 'coupé', String(gros.status));
  assert.equal((await api('GET', '/api/state')).status, 200, 'le serveur tient');
  // le fichier n'a pas bougé
  const d = JSON.parse(fs.readFileSync(path.join(path.dirname(cfgPath), 'data', 'patrimoine.json'), 'utf8'));
  assert.equal(d.operations.length, 0);
});

test('saisie des lignes, opérations, PRU, GBp, liquidités, cible : chiffres de l’état public', async () => {
  let r = await ligne({ symbole: 'AI.PA', tranche: 'nominatif', quantite: 21, pru: 150, inscription: '2023-03-15' });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  r = await ligne({ titre: 'air liquide', tranche: 'swing', quantite: 33, pru: 170 });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  r = await ligne({ symbole: 'IGLN.L', quantite: 10, pru: 70 });
  assert.equal(r.status, 200);
  // nouvelle ligne cotée en pence : la devise vient de la cotation, le taux EURGBP=X est chargé
  r = await ligne({ symbole: 'SGLN.L', compte: 'ibkr', categorie: 'Or', nom: 'iShares Gold GBP', quantite: 100, pru: 50, devise: 'GBP' });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.match(r.corps.message, /Ligne ajoutée/);
  r = await op({ sens: 'achat', titre: 'Air Liquide', quantite: 10, prix: 180, frais: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.operation.sous_tranche, 'swing');
  assert.equal(r.corps.operation.avant, undefined); // détails internes non renvoyés
  assert.match(r.corps.avertissements.join(' '), /négatives/);
  r = await ligne({ type: 'liquidites', compte: 'pea', montant: 5000 });
  assert.equal(r.status, 200);
  r = await ligne({ type: 'liquidites', compte: 'ibkr', montant: 500, devise: 'USD' });
  assert.equal(r.status, 200);
  r = await ligne({ type: 'cible', cible: { 'Actions Europe': 60, Or: 30, Cash: 10 } });
  assert.equal(r.status, 200);
  r = await op({ sens: 'dividende', titre: 'air liquide', tranche: 'nominatif', montant: 45 });
  assert.equal(r.status, 200);

  let p = await etat();
  for (let i = 0; i < 50 && !(p.lignes.find((l) => l.symbole === 'SGLN.L') || {}).cours; i++) { await attendre(100); p = await etat(); }
  const L = (s, t) => p.lignes.find((l) => l.symbole === s && (!t || l.sous_tranche === t));
  assert.equal(L('AI.PA', 'swing').quantite, 43);
  assert.equal(L('AI.PA', 'swing').pru, 172.3721);
  assert.equal(L('AI.PA', 'swing').valeur, Math.round(43 * 172.36 * 100) / 100);
  assert.equal(L('IGLN.L').valeur, Math.round(((10 * 78.12) / 1.162) * 100) / 100);
  assert.equal(L('SGLN.L').cours, 58.425);
  assert.equal(L('SGLN.L').valeur, Math.round(((100 * 58.425) / 0.8671) * 100) / 100);
  const attendu = 43 * 172.36 + 21 * 172.36 + (10 * 78.12) / 1.162 + (100 * 58.425) / 0.8671 + 5000 + 45 + 500 / 1.162;
  assert.ok(Math.abs(p.total - attendu) < 0.02, `${p.total} ≠ ${attendu}`);
  const A = Object.fromEntries(p.allocation.map((a) => [a.categorie, a]));
  assert.equal(A['Actions Europe'].cible, 60);
  assert.equal(A['Actions Europe'].ecart, Math.round((A['Actions Europe'].poids - 60) * 100) / 100);
  assert.equal(p.dividendes_12m.total, 45);
  const fid = p.echeances.find((e) => e.type === 'fidelite');
  assert.equal(fid.annee, 2026);
  const pea5 = p.echeances.find((e) => e.type === 'pea5');
  assert.equal(pea5.date, '2027-08-01');

  // annuler le dividende
  r = await api('POST', '/api/patrimoine/annuler', {});
  assert.equal(r.status, 200);
  assert.equal((await etat()).dividendes_12m.total, 0);

  // GET complet (pour la commande) : opérations sans les détails internes
  const g = await api('GET', '/api/patrimoine');
  assert.equal(g.status, 200);
  assert.equal(g.corps.operations.length, 1);
  assert.equal(g.corps.operations[0].avant, undefined);
});

test('fichier modifié à la main : relu ; illisible : écritures bloquées, dernière version gardée', async () => {
  const f = path.join(path.dirname(cfgPath), 'data', 'patrimoine.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.liquidites.revolut = { EUR: 1234 };
  fs.writeFileSync(f, JSON.stringify(d));
  const r = await api('GET', '/api/patrimoine');
  assert.equal(r.corps.resume.comptes.find((c) => c.id === 'revolut').valeur, 1234);
  const bon = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '{ cassé');
  const w = await op({ sens: 'versement', compte: 'revolut', montant: 10 });
  assert.equal(w.status, 409);
  assert.match(w.corps.error, /illisible/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ cassé');
  const p = await etat();
  assert.equal(p.ok, true);
  assert.match(p.erreur_fichier, /illisible/);
  // la commande signale aussi le fichier illisible (sur stderr : --json reste lisible)
  const c = await cli(['--json']);
  assert.equal(c.code, 0, c.err);
  assert.equal(JSON.parse(c.out).schema, 'barre.patrimoine/1');
  assert.match(c.err, /illisible/);
  // opération mal formée (date) : même traitement, et le reste de la barre tient
  const abime = JSON.parse(bon);
  abime.operations.push({ id: 'op-main', sens: 'achat', ligne: 'pea-ai-nominatif', date: { annee: 2026 }, quantite: 1 });
  fs.writeFileSync(f, JSON.stringify(abime));
  assert.equal((await api('GET', '/api/patrimoine')).status, 200); // relu tout de suite (sinon dans la minute)
  const s = await api('GET', '/api/state');
  assert.equal(s.status, 200);
  assert.equal(s.corps.patrimoine.ok, true);
  assert.match(s.corps.patrimoine.erreur_fichier, /opération n° \d+ \(op-main\) : date/);
  fs.writeFileSync(f, bon);
  assert.equal((await op({ sens: 'versement', compte: 'revolut', montant: 10 })).status, 200);
});

test('commande « patrimoine » avec le serveur : résumé, --json stable, achat, erreurs', async () => {
  let r = await cli([]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Patrimoine : /);
  assert.match(r.out, /Échéances/);
  r = await cli(['--json']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.schema, 'barre.patrimoine/1');
  assert.equal(j.source, 'serveur');
  assert.equal(typeof j.total_eur, 'number');
  assert.ok(Array.isArray(j.comptes) && Array.isArray(j.categories));
  assert.equal(typeof j.perime, 'boolean');
  r = await cli(['achat', 'total', '10', '56,5', '--frais', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Achat enregistré : 10 TotalEnergies à 56,50 €/);
  r = await cli(['vente', 'total', '50', '60']);
  assert.equal(r.code, 1);
  assert.match(r.err, /n'en contient que 10/);
  r = await cli(['historique', '--json', '--n', '1']);
  assert.equal(JSON.parse(r.out)[0].symbole, 'TTE.PA');
  r = await cli(['cours']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Cours rafraîchis/);
  // jeton faux : erreur, pas d'écriture directe dans le fichier
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const faux = path.join(dir, 'faux.json');
  fs.writeFileSync(faux, JSON.stringify({ ...cfg, token: 'faux' }));
  r = await cli(['versement', 'pea', '1'], { BARRE_CONFIG: faux });
  assert.equal(r.code, 1);
  assert.match(r.err, /non autorisé/);
});

test('commande « patrimoine » serveur arrêté : écriture atomique directe, relue au redémarrage', async () => {
  await arreter();
  // date relative : le dividende doit rester dans les 12 derniers mois quel que soit le jour du test
  let r = await cli(['dividende', 'total', '12,30', '--date', 'hier']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Dividende enregistré : 12,30 €/);
  assert.match(r.out, /serveur de la barre arrêté/);
  const dataDir = path.join(path.dirname(cfgPath), 'data');
  assert.equal(fs.statSync(path.join(dataDir, 'patrimoine.json')).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(dataDir).some((x) => x.endsWith('.tmp')));
  r = await cli(['--json']);
  assert.equal(JSON.parse(r.out).source, 'fichier');
  r = await cli(['cours']);
  assert.equal(r.code, 1);
  r = await cli(['vente', 'total', '500', '1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /n'en contient que 10/);
  demarrer();
  await pret();
  const p = await etat();
  assert.ok(p.dividendes_12m.total >= 12.3);
});
