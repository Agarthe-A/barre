// Hermes sur la barre : tableau Kanban et état de la passerelle.
//
// Tout passe par la commande officielle `hermes kanban …` (jamais d'écriture
// directe dans kanban.db) : la barre crée des tâches, Hermes les exécute.
// Pour ne pas lancer Python toutes les 5 s, la liste n'est relue que quand
// kanban.db (ou son journal -wal) change, ou au moins toutes les 30 s.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './sources.mjs';

const expand = (p) => String(p || '').replace(/^~(?=$|\/)/, os.homedir());
const ms = (s) => (s ? s * 1000 : null);
const court = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Colonnes de la barre ← statuts Hermes
export const COLONNES = {
  triage: 'afaire', todo: 'afaire', ready: 'afaire', scheduled: 'afaire',
  running: 'encours',
  blocked: 'bloque', review: 'bloque',
  done: 'fait'
};

export function creerHermes(opts = {}) {
  const home = expand(opts.home || '~/.hermes');
  const bin = expand(opts.bin || path.join(home, 'hermes-agent', '.hermes', 'bin', 'hermes'));
  const assignee = opts.assignee || 'default';
  const db = path.join(home, 'kanban.db');
  const estop = path.join(home, 'ESTOP');

  let etat = { ok: false, error: 'chargement' };
  let empreinte = '';
  let derniereLecture = 0;
  // id → { cle, summary, raison } : le détail d'une tâche terminée ou bloquée ne change plus.
  const details = new Map();

  const cli = async (args, { timeout = 20000, input } = {}) => {
    const r = await run(bin, args, { timeout, input, cwd: home });
    if (!r.ok) {
      const msg = (r.err || r.out || '').trim().split('\n').filter(Boolean).pop() || 'commande hermes en échec';
      throw new Error(r.timedOut ? 'Hermes ne répond pas' : msg);
    }
    return r.out;
  };
  const cliJson = async (args, o) => JSON.parse(await cli([...args], o));

  function empreinteDb() {
    const parts = [];
    for (const f of [db, db + '-wal']) {
      try { const st = fs.statSync(f); parts.push(st.mtimeMs, st.size); } catch { parts.push(0); }
    }
    return parts.join(':');
  }

  function passerelle() {
    let g = null;
    try { g = JSON.parse(fs.readFileSync(path.join(home, 'gateway_state.json'), 'utf8')); } catch { /* pas de passerelle */ }
    if (!g) return { etat: 'absente', vivante: false, plateformes: [] };
    let vivante = false;
    if (g.pid) { try { process.kill(g.pid, 0); vivante = true; } catch (e) { vivante = e.code === 'EPERM'; } }
    return {
      etat: vivante ? (g.gateway_state || 'inconnu') : 'arrêtée',
      vivante,
      agents: g.active_agents || 0,
      version: g.code_version || null,
      plateformes: Object.entries(g.platforms || {}).map(([nom, p]) => ({ nom, ok: p.state === 'connected', etat: p.state }))
    };
  }

  async function detail(t) {
    const cle = `${t.status}:${t.completed_at || ''}:${t.started_at || ''}`;
    const d = details.get(t.id);
    if (d && d.cle === cle) return d;
    let summary = null;
    let raison = null;
    try {
      const s = await cliJson(['kanban', 'show', t.id, '--json'], { timeout: 15000 });
      summary = s.latest_summary || s.task?.result || null;
      const comms = s.comments || [];
      if (t.status === 'blocked' && comms.length) {
        const c = comms[comms.length - 1];
        raison = c.body || c.text || c.content || null;
      }
      if (!raison && t.status === 'blocked') {
        const ev = [...(s.events || [])].reverse().find((e) => e.kind === 'blocked' || e.kind === 'auto_blocked');
        raison = ev?.payload?.reason || null;
      }
    } catch { /* on réessaiera au prochain passage */ return d || { summary: null, raison: null }; }
    const out = { cle, summary, raison };
    details.set(t.id, out);
    return out;
  }

  async function rafraichir(force = false) {
    const e = empreinteDb();
    const vieux = Date.now() - derniereLecture > 30000;
    const pause = fs.existsSync(estop);
    const gw = passerelle();
    if (!force && !vieux && e === empreinte && etat.ok) {
      // Seuls la passerelle et la pause peuvent avoir bougé.
      etat = { ...etat, pause, passerelle: gw };
      return etat;
    }
    if (!fs.existsSync(bin)) {
      etat = { ok: false, error: 'absent', pause, passerelle: gw };
      return etat;
    }
    try {
      const liste = await cliJson(['kanban', 'list', '--json']);
      empreinte = e;
      derniereLecture = Date.now();
      const taches = [];
      let budget = 6; // pas plus de 6 lectures de détail par passage
      for (const t of liste) {
        const col = COLONNES[t.status];
        if (!col) continue;
        let d = details.get(t.id);
        if ((t.status === 'done' || t.status === 'blocked' || t.status === 'review') && budget > 0) {
          const avant = d;
          d = await detail(t);
          if (d !== avant) budget--;
        }
        taches.push({
          id: t.id,
          titre: court(t.title, 160),
          corps: court(t.body, 1200),
          statut: t.status,
          col,
          par: t.created_by || null,
          creee: ms(t.created_at),
          debut: ms(t.started_at),
          fin: ms(t.completed_at),
          resume: d ? court(d.summary, 2400) || null : null,
          raison: d ? court(d.raison, 400) || null : null,
          erreur: court(t.last_failure_error, 400) || null
        });
      }
      const ids = new Set(liste.map((t) => t.id));
      for (const id of details.keys()) if (!ids.has(id)) details.delete(id);
      const tri = (a, b) => (b.fin || b.debut || b.creee || 0) - (a.fin || a.debut || a.creee || 0);
      taches.sort(tri);
      etat = { ok: true, pause, passerelle: gw, taches, maj: Date.now() };
    } catch (err) {
      etat = { ok: false, error: 'erreur', detail: err.message, pause, passerelle: gw };
    }
    return etat;
  }

  // Crée une tâche et la lance tout de suite (sauf si Hermes est en pause).
  // Trois appuis rapides sur le même bouton ne font qu'une tâche.
  const enVol = new Map();
  async function creer(texte) {
    const t = String(texte || '').replace(/\r/g, '').trim();
    if (!t) throw new Error('Demande vide');
    if (t.length > 4000) throw new Error('Demande trop longue (4 000 caractères max.)');
    if (enVol.has(t)) return { ...(await enVol.get(t)), lancee: false, deja: true };
    const deja = etat.ok && etat.taches.find((x) => (x.col === 'afaire' || x.col === 'encours') && (x.corps || '').trim() === court(t, 1200));
    if (deja) return { id: deja.id, lancee: false, deja: true };
    const p = creerVraiment(t);
    enVol.set(t, p);
    try { return await p; } finally { enVol.delete(t); }
  }
  async function creerVraiment(t) {
    const premiere = t.split('\n')[0].trim();
    const titre = court(premiere, 90);
    const args = ['kanban', 'create', '--body-file', '-', '--assignee', assignee, '--created-by', 'barre', '--json', '--', titre];
    const tache = await cliJson(args, { input: t });
    let lancee = false;
    if (!fs.existsSync(estop)) lancee = await lancer();
    await rafraichir(true);
    return { id: tache.id, lancee };
  }

  async function lancer() {
    try {
      const r = await cliJson(['kanban', 'dispatch', '--max', '1', '--json'], { timeout: 30000 });
      return (r.spawned || []).length > 0;
    } catch { return false; } // la passerelle relancera de toute façon dans la minute
  }

  const VERBES = {
    // Arrêter : on tue le travailleur, puis on bloque pour qu'il ne reparte pas tout seul.
    arreter: async (id) => {
      await cli(['kanban', 'reclaim', id, '--reason', 'Arrêtée depuis la barre']).catch(() => {});
      await cli(['kanban', 'block', id, 'Arrêtée depuis la barre']);
    },
    relancer: async (id, t) => {
      if (t && (t.statut === 'blocked' || t.statut === 'scheduled')) await cli(['kanban', 'unblock', id, '--reason', 'Relancée depuis la barre']);
      else if (t && t.statut === 'review') await cli(['kanban', 'reopen-review', id]);
      else if (t && (t.statut === 'todo' || t.statut === 'triage')) await cli(['kanban', 'promote', id, 'Lancée depuis la barre']);
      if (!fs.existsSync(estop)) await lancer();
    },
    valider: async (id) => { await cli(['kanban', 'complete', id, '--force']); },
    archiver: async (id) => { await cli(['kanban', 'archive', id]); },
    refaire: async (id, t) => {
      if (!t) throw new Error('Tâche introuvable');
      await creer(t.corps || t.titre);
    }
  };

  async function action(id, verbe) {
    if (!/^t_[\w-]+$/.test(id)) throw new Error('Identifiant invalide');
    const f = VERBES[verbe];
    if (!f) throw new Error('Action inconnue');
    const t = etat.ok ? etat.taches.find((x) => x.id === id) : null;
    await f(id, t);
    await rafraichir(true);
    return { ok: true };
  }

  async function viderFaites() {
    const ids = etat.ok ? etat.taches.filter((t) => t.statut === 'done').map((t) => t.id) : [];
    if (ids.length) await cli(['kanban', 'archive', ...ids]);
    await rafraichir(true);
    return { ok: true, n: ids.length };
  }

  // Arrêt d'urgence officiel de Hermes (fichier ESTOP) : plus de nouvelles
  // tâches ni de nouveaux tours ; le travail déjà lancé continue.
  async function pause(on) {
    if (on) await cli(['pause', '--reason', 'Pause depuis la barre']);
    else {
      await cli(['resume']);
      await lancer();
    }
    await rafraichir(true);
    return { ok: true, pause: fs.existsSync(estop) };
  }

  return { etat: () => etat, rafraichir, creer, action, viderFaites, pause };
}
