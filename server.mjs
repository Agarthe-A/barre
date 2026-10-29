#!/usr/bin/env node
// Barre — serveur du tableau de bord, à faire tourner sur le Mac mini.
// Aucune dépendance : Node 18+ suffit.
//
//   node server.mjs            → démarre le serveur
//   BARRE_CONFIG=/chemin.json  → utilise un autre fichier de config
//
// Sécurité : écoute par défaut sur 127.0.0.1 uniquement, et chaque requête
// doit présenter le jeton secret (config.json). Pour y accéder depuis un autre
// appareil, passer par `tailscale serve` (voir README.md), jamais par Internet.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ENV, run, getMusic, musicCommand, saveArtwork, getReminders, completeReminder,
  getCalendars, getGoogleCalendar, getPlex, getHue, setHueRoom, getContainers, generatePriorities, readJson, writeJson
} from './lib/sources.mjs';
import {
  chargerFichier, ecrireFichier, calculer, appliquerOperation, annulerDerniere, modifierLigne,
  fixerLiquidites, fixerCible, symbolesNecessaires, ErreurSaisie
} from './lib/patrimoine.mjs';
import { creerServiceCours, intervalleCours } from './lib/quotes.mjs';
import { creerHermes } from './lib/hermes.mjs';
import { creerSwitch } from './lib/switch.mjs';
import { creerDiscord } from './lib/discord.mjs';
import { creerDiscordRpc } from './lib/discord-rpc.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Le jeton, les règles et les données vivent hors du dossier du code
// (~/.config/barre), pour qu'une session Claude Code ouverte dans ~/barre ne
// puisse pas les lire ou les modifier sans demander.
const STATE_DIR = path.join(os.homedir(), '.config', 'barre');
const CONFIG_PATH = process.env.BARRE_CONFIG
  || (fs.existsSync(path.join(ROOT, 'config.json')) && !fs.existsSync(path.join(STATE_DIR, 'config.json'))
    ? path.join(ROOT, 'config.json')
    : path.join(STATE_DIR, 'config.json'));
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
const DATA_DIR = path.join(path.dirname(CONFIG_PATH), 'data');
const RULES_PATH = path.join(path.dirname(CONFIG_PATH), 'rules.json');
const PRIORITIES_PATH = path.join(DATA_DIR, 'priorities.json');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEMO = process.env.BARRE_DEMO === '1';
// En démo, le patrimoine n'est jamais écrit dans le vrai fichier.
const PATRIMOINE_PATH = path.join(DATA_DIR, DEMO ? 'patrimoine.demo.json' : 'patrimoine.json');
const COURS_PATH = path.join(DATA_DIR, DEMO ? 'cours.demo.json' : 'cours.json');

// ---------------------------------------------------------------- config

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4747,
  token: null,
  // Temps laissé pour répondre sur la barre avant que Claude Code
  // ne repasse à la question habituelle dans le terminal.
  permissionTimeoutSec: 90,
  countdowns: [
    { label: 'SEMI', date: '2026-12-27' },
    { label: '250 KM', date: '2026-12-11' }
  ],
  plan: { label: 'Plan semi', start: '2026-09-15', end: '2026-12-27' },
  // Mots qui signalent une séance d'entraînement dans l'agenda
  trainingKeywords: ['course', 'run', 'sortie', 'semi', 'fractionn', 'footing', 'vélo', 'velo', 'home trainer', 'home-trainer', 'z2', 'sweet spot', 'séance', 'seance', 'muscu', 'piscine'],
  // Agendas iCal : pour Google Agenda, Paramètres de l'agenda › « Adresse secrète au format iCal »
  calendars: [],
  // Google Agenda via l'accès déjà donné à Hermes (lecture seule). exclude : noms d'agendas à masquer.
  googleCalendar: { enabled: true, tokenFile: '~/.hermes/google_token.json', exclude: [] },
  reminders: { enabled: true, lists: [] },
  music: { enabled: true },
  plex: { enabled: true, url: 'http://127.0.0.1:32400', token: null, recentSections: [] },
  hue: { enabled: true },
  priorities: { enabled: true, time: '07:00' },
  // Boutons du bas. `command` est une commande shell exécutée sur le Mac
  // (définie ici uniquement, jamais envoyée par la page). null = à configurer.
  actions: [
    { id: 'brief', tag: 'HERMES', label: 'Brief du matin', command: null },
    { id: 'ticket', tag: 'HERMES', label: 'Imprimer le ticket', command: null },
    { id: 'mails', tag: 'HERMES', label: 'Résumé des mails', command: null },
    { id: 'refresh', tag: 'SERVEUR', label: "Rafraîchir l'état", builtin: 'refresh' }
  ],
  docker: true,
  // Disque externe : affiché « Non branché » tant qu'aucun volume externe n'est monté. Si le chemin configuré
  // est absent, on prend le plus grand volume monté dans /Volumes (hors disque de démarrage).
  externalDisk: { enabled: true, label: 'SSD', path: '/Volumes/SSD' },
  // Page Patrimoine : données dans data/patrimoine.json, cours Yahoo Finance.
  patrimoine: { enabled: true },
  // Page Discord : streams du salon vocal capturés par BarreTouch ; clientId / clientSecret : application
  // Discord de l'utilisateur (discord.com/developers) pour la liaison RPC (qui parle, micros, avatars).
  discord: { enabled: true, clientId: null, clientSecret: null, autoStreams: true },
  // Page Kanban : tâches confiées à Hermes (commande `hermes kanban`).
  // modeles : demandes toutes prêtes, en un appui. Une action du bas peut aussi
  // créer une tâche : { "id": "brief", "label": "…", "kanban": "texte de la demande" }.
  hermes: {
    enabled: true,
    home: '~/.hermes',
    bin: null,
    assignee: 'default',
    modeles: [
      { label: 'Résumé des mails', texte: 'Résume mes mails non lus importants des dernières 24 h : expéditeur, sujet et ce que je dois faire. Ne réponds à aucun mail et ne supprime rien.' },
      { label: 'Brief du jour', texte: 'Prépare mon brief du jour : agenda d’aujourd’hui, météo, mails importants et rappels en retard. Réponse courte, en français.' },
      { label: 'Point serveur', texte: 'Vérifie l’état du Mac mini (espace disque, conteneurs Docker arrêtés, mises à jour en attente) et résume en 5 lignes. Ne modifie rien.' }
    ]
  }
};

function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  // Fusion sur un niveau : un réglage partiel ("reminders": {"lists": [...]})
  // garde les autres valeurs par défaut de la même section.
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(fileCfg)) {
    const d = DEFAULTS[k];
    cfg[k] = d && v && typeof d === 'object' && typeof v === 'object' && !Array.isArray(d) && !Array.isArray(v) ? { ...d, ...v } : v;
  }
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    console.log(`[barre] Jeton créé et enregistré dans ${CONFIG_PATH}`);
  }
  return cfg;
}

const config = loadConfig();
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- règles « Toujours autoriser »
// Une règle n'autorise d'office qu'une demande STRICTEMENT identique : même
// outil, même dossier de travail et mêmes paramètres complets (à l'octet près,
// hors champs purement descriptifs). rules.json est relu à chaque demande.

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
function ruleKey(tool, cwd, toolInput) {
  let input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  // Pour Bash seulement, la description et le délai ne changent pas ce qui s'exécute.
  if (tool === 'Bash') {
    const { description, timeout, ...rest } = input;
    input = rest;
  }
  return crypto.createHash('sha256').update(`${tool}\n${cwd || ''}\n${canonical(input)}`).digest('hex');
}
// Un dossier est « sous » un autre s'il est identique ou contenu dedans.
function under(cwd, base) {
  return !!cwd && !!base && (cwd === base || cwd.startsWith(base.endsWith(path.sep) ? base : base + path.sep));
}
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Début fiable d'un aperçu relayé (Claude Code peut le couper au milieu ou à la fin).
function previewPrefix(s) {
  const t = normText(s);
  const cut = t.search(/[⋯…]/);
  return (cut >= 0 ? t.slice(0, cut) : t).trim();
}
// Le texte complet correspond-il à l'aperçu ? Égalité stricte, sauf si l'aperçu
// a été coupé (⋯ ou …) : on compare alors le début.
function matchesPreview(full, shown) {
  const s = normText(shown);
  if (!s) return false;
  if (/[⋯…]/.test(s)) {
    const p = previewPrefix(s);
    return !!p && normText(full).startsWith(p);
  }
  return normText(full) === s;
}

function loadRules() {
  const r = readJson(RULES_PATH, []);
  return Array.isArray(r) ? r : [];
}
function addRule(tool, cwd, key, summary) {
  if (!key) return;
  const rules = loadRules();
  if (!rules.some((r) => r.key === key)) {
    rules.push({ tool, cwd: cwd || '', key, summary, createdAt: new Date().toISOString() });
    writeJson(RULES_PATH, rules);
  }
}
function removeRule(index) {
  const rules = loadRules();
  if (index < 0 || index >= rules.length) return false;
  rules.splice(index, 1);
  writeJson(RULES_PATH, rules);
  return true;
}
function matchesRule(key) {
  return !!key && loadRules().some((r) => r.key === key);
}

// ---------------------------------------------------------------- état

const sessions = new Map();   // session_id → { id, project, status, text, updatedAt }
const pending = new Map();    // id → { id, sessionId, project, tool, summary, createdAt, res, timer }
const feed = [];              // [{ time, text, source }]
const clients = new Set();    // réponses SSE ouvertes

let system = { cpu: null, ram: null, disk: null, ext: null, docker: null, containers: [], updatedAt: null };
let music = { ok: false, error: 'chargement' };
let reminders = { ok: false, error: 'chargement' };
let calendar = { ok: false, error: 'chargement' };
let plex = { ok: false, error: 'chargement' };
let hue = { ok: false, error: 'chargement' };
let priorities = readJson(PRIORITIES_PATH, { date: null, items: [], generatedAt: null });
let prioritiesStatus = { running: false, error: null };
let artVersion = 0;
let lastTrackId = null;
// Patrimoine : données du fichier (dernière version lisible) et cours en cache.
let patri = { ok: false, error: 'chargement', data: null, erreurFichier: null };
let patriMtime = 0;
let dernierCours = 0;
const hermes = creerHermes(config.hermes || {});
// Page Switch : ludothèque d'Eden, fenêtre du jeu placée par BarreTouch (relais 4748).
const sw = creerSwitch({ dataDir: DATA_DIR, token: config.token });
let switchState = { ok: false, error: 'chargement' };
// Page Discord : flux d'un salon vocal capturés par BarreTouch (relais 4748) et redisposés sur la barre.
let discordState = { ok: false, error: 'chargement' };
const discordRpc = config.discord?.enabled === false ? null : creerDiscordRpc({
  clientId: config.discord?.clientId, clientSecret: config.discord?.clientSecret, dataDir: DATA_DIR,
  log: (m) => console.log('[barre]', m),
  onChange: () => { discordState = dc.etat(); broadcast(); }
});
const dc = creerDiscord({ token: config.token, rpc: discordRpc });
let hermesStatuts = null; // id → statut au passage précédent (pour annoncer les tâches finies)
const coursService = creerServiceCours({
  fichierCache: COURS_PATH,
  // Réponses Yahoo enregistrées (tests, bac à sable sans Internet).
  fixtures: process.env.BARRE_COURS_FIXTURES || null,
  // Ordre des sources (facultatif) : { "PA": [...], "L": [...], "FX": [...], "*": [...], "AI.PA": [...] }.
  ordre: config.patrimoine?.sources || null
});

function pushFeed(text, source = 'barre') {
  feed.unshift({ time: Date.now(), text: String(text).slice(0, 280), source });
  feed.length = Math.min(feed.length, 40);
}

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function countdowns() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (config.countdowns || []).map((c) => {
    const d = new Date(c.date + 'T00:00:00');
    return { label: c.label, date: c.date, days: Math.round((d - today) / 86400000) };
  });
}

function planProgress() {
  const p = config.plan;
  if (!p || !p.start || !p.end) return null;
  const start = new Date(p.start + 'T00:00:00').getTime();
  const end = new Date(p.end + 'T00:00:00').getTime();
  const total = Math.max(1, Math.ceil((end - start + 86400000) / (7 * 86400000)));
  const week = Math.min(total, Math.max(0, Math.floor((Date.now() - start) / (7 * 86400000)) + 1));
  return { label: p.label, week, total };
}

function isTraining(title) {
  const t = String(title || '').toLowerCase();
  return (config.trainingKeywords || []).some((k) => t.includes(k.toLowerCase()));
}

function publicState() {
  const order = { waiting: 0, running: 1, idle: 2, done: 3, ended: 4 };
  return {
    pending: [...pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, sessionId, project, tool, summary, createdAt, key }) => ({
        id, sessionId, project, tool, summary, createdAt, canAlways: !!key
      })),
    sessions: [...sessions.values()]
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.updatedAt - a.updatedAt)
      .slice(0, 10),
    feed: feed.slice(0, 20),
    system,
    music: { ...music, artVersion },
    reminders,
    calendar: calendar.ok
      ? { ok: true, events: calendar.events.map((e) => ({ ...e, training: isTraining(e.title) })) }
      : calendar,
    plex,
    hue,
    priorities: { ...priorities, ...prioritiesStatus, today: priorities.date === dayKey() },
    rules: loadRules().map((r) => ({
      tool: `${r.tool} · ${r.cwd ? path.basename(r.cwd) : 'ancienne règle'}`,
      summary: r.summary
    })),
    plan: planProgress(),
    countdowns: countdowns(),
    actions: (config.actions || []).map((a) => ({
      id: a.id, tag: a.tag || '', label: a.label, ready: !!(a.command || a.builtin || (a.kanban && config.hermes?.enabled))
    })),
    patrimoine: patrimoinePublic(),
    hermes: hermesPublic(),
    switch: config.switch?.enabled === false ? { ok: false, error: 'désactivé' } : switchState,
    discord: config.discord?.enabled === false ? { ok: false, error: 'désactivé' } : discordState
  };
}

// Chiffres seulement (ni opérations, ni historique) : la page n'affiche que des totaux.
// Une erreur de calcul ne doit jamais casser publicState() (et avec lui les
// autorisations Claude Code et toutes les autres pages).
function patrimoinePublic() {
  if (!config.patrimoine?.enabled) return { ok: false, error: 'désactivé' };
  if (!patri.ok) return { ok: false, error: patri.error || 'chargement' };
  try {
    return { ok: true, ...calculer(patri.data, coursService.cours(), new Date()), erreur_fichier: patri.erreurFichier };
  } catch (err) {
    return { ok: false, error: `calcul impossible : ${err.message}` };
  }
}

let lastPayload = '';
function broadcast(force = false) {
  const json = JSON.stringify(publicState());
  if (!force && json === lastPayload) return;
  lastPayload = json;
  const data = `data: ${json}\n\n`;
  for (const res of clients) res.write(data);
}

// ---------------------------------------------------------------- sessions Claude Code

function shortPath(p) {
  return String(p || '').replace(os.homedir(), '~');
}

function summarize(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (toolInput.command) return String(toolInput.command);
  if (toolInput.file_path) return shortPath(toolInput.file_path);
  if (toolInput.notebook_path) return shortPath(toolInput.notebook_path);
  if (toolInput.url) return String(toolInput.url);
  if (toolInput.pattern) return String(toolInput.pattern);
  return JSON.stringify(toolInput).slice(0, 200);
}

function touchSession(input, patch) {
  const id = input.session_id || 'inconnue';
  const s = sessions.get(id) || { id, project: '—', status: 'idle', text: '', updatedAt: Date.now() };
  if (input.cwd) { s.cwd = input.cwd; s.project = path.basename(input.cwd) || input.cwd; }
  Object.assign(s, patch, { updatedAt: Date.now() });
  sessions.set(id, s);
  return s;
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const age = now - s.updatedAt;
    // Une session tuée sans « SessionEnd » finit aussi par disparaître.
    if (s.status !== 'ended' && age > 6 * 3600 * 1000) sessions.delete(id);
    if (s.status === 'ended' && age > 10 * 60 * 1000) sessions.delete(id);
  }
}

function handleHookEvent(input) {
  clearAnsweredRelays(input);
  switch (input.hook_event_name) {
    case 'SessionStart':
      touchSession(input, { status: 'idle', text: 'Session ouverte' });
      break;
    case 'UserPromptSubmit':
      touchSession(input, { status: 'running', text: String(input.prompt || '').replace(/\s+/g, ' ').slice(0, 140) });
      break;
    case 'PreToolUse':
    case 'PostToolUse':
      touchSession(input, { status: 'running', text: `${input.tool_name || 'Outil'} · ${summarize(input.tool_input)}`.slice(0, 140) });
      break;
    case 'Notification':
      touchSession(input, { status: 'waiting', text: String(input.message || 'Claude attend ta réponse').slice(0, 140) });
      break;
    case 'Stop':
      touchSession(input, { status: 'done', text: 'Réponse terminée' });
      break;
    case 'SessionEnd':
      touchSession(input, { status: 'ended', text: 'Session fermée' });
      break;
    default:
      touchSession(input, {});
  }
}

// Une demande d'autorisation : on garde la requête du hook ouverte
// jusqu'à ce qu'un bouton soit touché sur la barre (ou expiration).
function handlePermissionRequest(input, res) {
  const tool = input.tool_name || 'Outil';
  const summary = summarize(input.tool_input);
  const key = ruleKey(tool, input.cwd, input.tool_input);

  if (matchesRule(key)) {
    const s = touchSession(input, { status: 'running', text: `${tool} · ${summary}`.slice(0, 140) });
    // Le relais peut arriver en même temps que le hook : on n'affiche pas de carte
    // pour une demande déjà autorisée par une règle.
    if (input.barre_channel) {
      const ch = channelFor(input);
      if (ch) {
        const info = { sid: input.barre_sid || null, chCwd: ch.cwd, tool, key, summary, sessionId: s.id, at: Date.now() };
        const card = matchingCards(info)[0];
        if (card && matchingCards(info).length === 1) dropRelay(card);
        else { autoAllowed = autoAllowed.filter((a) => Date.now() - a.at < 30000); autoAllowed.push(info); }
      }
    }
    pushFeed(`Autorisé d'office (règle) · ${s.project} · ${summary}`.slice(0, 200), 'claude');
    broadcast();
    return json(res, 200, { decision: 'allow', auto: true });
  }

  // Session lancée avec le canal (et canal bien connecté pour ce dossier) : la
  // question s'ouvre tout de suite dans le terminal et arrive sur la barre par
  // le relais. On garde ici la demande exacte pour « Toujours autoriser ».
  const ch = input.barre_channel ? channelFor(input) : null;
  if (ch) {
    const s = touchSession(input, { status: 'waiting', text: `Demande : ${tool}` });
    const info = { sid: input.barre_sid || null, chCwd: ch.cwd, tool, key, summary, sessionId: s.id, at: Date.now() };
    // Claude Code peut envoyer le relais avant ou après le hook : si la carte est
    // déjà là, on la relie maintenant (sans ambiguïté), sinon on garde l'info.
    if (!linkCard(info)) {
      pruneHookInfo();
      hookInfo.push(info);
    }
    broadcast();
    return json(res, 200, { decision: 'relay' });
  }

  const id = crypto.randomUUID();
  const s = touchSession(input, { status: 'waiting', text: `Demande : ${tool}` });
  const entry = { id, sessionId: s.id, project: s.project, cwd: input.cwd || '', tool, summary, key, createdAt: Date.now(), res, timer: null };
  entry.timer = setTimeout(() => settle(id, 'ask'), config.permissionTimeoutSec * 1000);
  res.on('close', () => {
    // Le hook a été interrompu (réponse donnée dans le terminal, timeout côté Claude…)
    if (pending.has(id)) {
      clearTimeout(entry.timer);
      pending.delete(id);
      broadcast();
    }
  });
  pending.set(id, entry);
  broadcast();
}

function settle(id, decision) {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  if (decision === 'always' && entry.key) addRule(entry.tool, entry.cwd, entry.key, entry.summary);
  const behavior = decision === 'always' ? 'allow' : decision;
  if (entry.kind === 'relay') {
    if (behavior === 'allow' || behavior === 'deny') relaySend(entry.cid, { request_id: entry.requestId, behavior });
  } else {
    try {
      entry.res.writeHead(200, { 'content-type': 'application/json' });
      entry.res.end(JSON.stringify({ decision: behavior }));
    } catch { /* hook déjà parti */ }
  }
  const s = sessions.get(entry.sessionId);
  if (s) {
    if (decision === 'ask') Object.assign(s, { status: 'waiting', text: 'Réponse attendue dans le terminal', updatedAt: Date.now() });
    else if (decision === 'deny') Object.assign(s, { status: 'waiting', text: `Refusé : ${entry.tool}`, updatedAt: Date.now() });
    else Object.assign(s, { status: 'running', text: `${entry.tool} · ${entry.summary}`.slice(0, 140), updatedAt: Date.now() });
  }
  const label = { allow: 'Autorisé', always: 'Toujours autorisé', deny: 'Refusé', ask: entry.kind === 'relay' ? 'Sans réponse sur la barre' : 'Sans réponse, renvoyé au terminal' }[decision];
  pushFeed(`${label} · ${entry.project} · ${entry.summary}`.slice(0, 200), 'claude');
  broadcast();
  return true;
}

// ---------------------------------------------------------------- relais (terminal + barre en même temps)
// Le canal (channel/barre-channel.mjs) tourne dans chaque session lancée avec
// le raccourci « claude ». Il garde une connexion ouverte ici pour recevoir les
// réponses, et nous transmet chaque demande qui s'ouvre dans le terminal.

const relayChannels = new Map(); // cid → { cid, cwd, res }
// Demandes exactes vues par le hook en mode canal, en attente de leur relais (30 s max).
let hookInfo = [];
function pruneHookInfo() {
  const now = Date.now();
  hookInfo = hookInfo.filter((h) => now - h.at < 30000);
}
// Demandes autorisées d'office par une règle, dont le relais peut arriver juste après (30 s).
let autoAllowed = [];
// Cartes relayées « sans demande exacte » qui correspondent sans ambiguïté à une info du hook.
function matchingCards(info) {
  const now = Date.now();
  return [...pending.values()].filter((e) => e.kind === 'relay' && !e.key && now - e.createdAt < 30000
    && e.tool === info.tool
    && (e.sid && info.sid ? e.sid === info.sid : e.cwd === info.chCwd)
    && (normText(e.shown) ? matchesPreview(info.summary, e.shown) : !!(e.sid && info.sid)));
}
// Relie une carte relayée encore « sans demande exacte » à l'info du hook.
function linkCard(info) {
  const cards = matchingCards(info);
  if (cards.length !== 1) return false;
  const e = cards[0];
  Object.assign(e, { key: info.key, summary: info.summary });
  const s = sessions.get(info.sessionId);
  if (s) Object.assign(e, { sessionId: s.id, project: s.project });
  return true;
}
// Canal de la session : par identifiant de lancement (BARRE_SID), sinon par dossier.
function channelFor(input) {
  const chans = [...relayChannels.values()];
  const byFolder = (list) => list.filter((c) => under(input.cwd, c.cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0] || null;
  // Avec un identifiant, seul le canal de CE lancement compte (ou un canal sans
  // identifiant) : jamais celui d'une autre session, qui ne relaierait rien.
  if (input.barre_sid) return chans.find((c) => c.sid === input.barre_sid) || byFolder(chans.filter((c) => !c.sid));
  return byFolder(chans);
}

function relaySend(cid, verdict) {
  const ch = relayChannels.get(cid);
  if (ch) ch.res.write(`data: ${JSON.stringify(verdict)}\n\n`);
}

function previewSummary(tool, preview) {
  const raw = String(preview || '');
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return summarize(obj);
  } catch { /* aperçu tronqué : on lit le champ à la main */ }
  const m = raw.match(/"(command|file_path|notebook_path|url|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    let v = m[2];
    try { v = JSON.parse(`"${v}"`); } catch { /* tel quel */ }
    return m[1].endsWith('path') ? shortPath(v) : v;
  }
  return raw.slice(0, 200);
}

function handleRelayRequest(body) {
  const ch = relayChannels.get(body.cid);
  if (!ch || !body.request_id) return false;
  const tool = body.tool_name || 'Outil';
  // Pas d'autorisation d'office ici : le hook a déjà comparé la demande exacte.
  // L'aperçu du relais est modifié par Claude Code (espaces, coupures, secrets
  // masqués) : il ne sert qu'à l'affichage. La demande exacte vient du hook.
  // On ne relie la carte à une demande exacte que s'il n'y a aucune ambiguïté :
  // même session (ou même dossier), même outil, et un aperçu compatible.
  pruneHookInfo();
  const shown = previewSummary(tool, body.input_preview);
  // Déjà autorisée d'office par une règle (le hook est passé avant) : pas de carte.
  autoAllowed = autoAllowed.filter((a) => Date.now() - a.at < 30000);
  const auto = autoAllowed.filter((a) => a.tool === tool && (ch.sid && a.sid ? a.sid === ch.sid : a.chCwd === ch.cwd) && matchesPreview(a.summary, shown));
  if (auto.length === 1) {
    autoAllowed = autoAllowed.filter((a) => a !== auto[0]);
    return true;
  }
  const candidates = hookInfo.filter((h) => h.tool === tool
    && (ch.sid && h.sid ? h.sid === ch.sid : h.chCwd === ch.cwd)
    && (normText(shown) ? matchesPreview(h.summary, shown) : !!(ch.sid && h.sid)));
  const exact = candidates.length === 1 ? candidates[0] : null;
  if (exact) hookInfo = hookInfo.filter((h) => h !== exact);
  const summary = exact ? exact.summary : (shown || String(body.description || '').slice(0, 200));
  const s = exact ? sessions.get(exact.sessionId)
    : [...sessions.values()].filter((x) => x.cwd === ch.cwd && x.status !== 'ended').sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (s) Object.assign(s, { status: 'waiting', text: `Demande : ${tool}`, updatedAt: Date.now() });
  const id = crypto.randomUUID();
  const entry = {
    id, kind: 'relay', cid: ch.cid, cwd: ch.cwd, sid: ch.sid || null, shown, requestId: String(body.request_id), sessionId: s ? s.id : null,
    project: s ? s.project : path.basename(ch.cwd), tool, summary,
    // Sans demande exacte, pas de bouton « Toujours autoriser ».
    key: exact ? exact.key : null,
    createdAt: Date.now(), timer: null
  };
  // Le terminal attend toujours : la carte reste longtemps sur la barre.
  entry.timer = setTimeout(() => settle(id, 'ask'), 15 * 60 * 1000);
  pending.set(id, entry);
  broadcast();
  return true;
}

// Retire une carte relayée sans réponse (on a répondu dans le terminal).
function dropRelay(entry, why) {
  if (!pending.has(entry.id)) return;
  clearTimeout(entry.timer);
  pending.delete(entry.id);
  if (why) pushFeed(`${why} · ${entry.project} · ${entry.summary}`.slice(0, 200), 'claude');
}

// Un événement de la session montre que la demande a été tranchée dans le terminal.
function clearAnsweredRelays(input) {
  if (!input.cwd) return;
  const ev = input.hook_event_name;
  const relays = [...pending.values()].filter((e) => e.kind === 'relay' && under(input.cwd, e.cwd));
  if (!relays.length) return;
  const sameSession = (e) => !e.sessionId || e.sessionId === input.session_id;
  if (ev === 'PostToolUse') {
    const key = ruleKey(input.tool_name || 'Outil', input.cwd, input.tool_input);
    const sum = summarize(input.tool_input);
    for (const e of relays) {
      if (e.tool !== input.tool_name || !sameSession(e)) continue;
      // Sans demande exacte, la comparaison sert seulement à retirer la carte (jamais à autoriser).
      if (e.key ? e.key === key : matchesPreview(sum, e.summary)) dropRelay(e, 'Autorisé dans le terminal');
    }
  } else if (ev === 'Stop' || ev === 'UserPromptSubmit' || ev === 'SessionEnd') {
    for (const e of relays) if (sameSession(e)) dropRelay(e, 'Répondu dans le terminal');
  }
}

function handleRelayConnect(req, res, url) {
  const cid = url.searchParams.get('cid');
  const cwd = url.searchParams.get('cwd') || '';
  const sid = url.searchParams.get('sid') || null;
  if (!cid) return json(res, 400, { error: 'cid manquant' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': ok\n\n');
  relayChannels.set(cid, { cid, cwd, sid, res });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    // Seule la connexion enregistrée compte (une ancienne connexion qui se
    // ferme après une reconnexion ne doit rien effacer).
    if (relayChannels.get(cid)?.res !== res) return;
    relayChannels.delete(cid);
    // Session fermée : ses cartes n'ont plus de sens.
    for (const e of [...pending.values()]) if (e.kind === 'relay' && e.cid === cid) dropRelay(e);
    broadcast();
  });
}

// ---------------------------------------------------------------- système

let lastCpu = os.cpus().map((c) => c.times);
function cpuPercent() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] || t;
    const d = (k) => t[k] - p[k];
    idle += d('idle');
    total += d('user') + d('nice') + d('sys') + d('idle') + d('irq');
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : null;
}

async function ramUsage() {
  const total = os.totalmem();
  if (process.platform === 'darwin') {
    const r = await run('vm_stat', [], { timeout: 4000 });
    if (r.ok) {
      const pageSize = Number((r.out.match(/page size of (\d+)/) || [])[1] || 16384);
      const pages = (label) => Number(((r.out.match(new RegExp(label + ':\\s+(\\d+)')) || [])[1]) || 0);
      const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
      return { used, total };
    }
  }
  return { used: total - os.freemem(), total };
}

async function diskUsage() {
  const target = process.platform === 'darwin' ? '/System/Volumes/Data' : '/';
  let r = await run('df', ['-k', target], { timeout: 4000 });
  if (!r.ok) r = await run('df', ['-k', '/'], { timeout: 4000 });
  if (!r.ok) return null;
  const line = r.out.trim().split('\n').pop().split(/\s+/);
  const total = Number(line[1]) * 1024;
  const avail = Number(line[3]) * 1024;
  return total ? { used: total - avail, total } : null;
}

// Taille d'un volume monté exactement à `where` (sinon df répond pour le disque qui contient le dossier).
async function volumeUsage(where) {
  const r = await run('df', ['-kP', where], { timeout: 4000 });
  if (!r.ok) return null;
  const f = r.out.trim().split('\n').pop().split(/\s+/);
  if (f.slice(5).join(' ') !== where) return null;
  const total = Number(f[1]) * 1024;
  const avail = Number(f[3]) * 1024;
  return total ? { used: total - avail, total } : null;
}

async function externalDiskUsage() {
  const ext = config.externalDisk;
  if (!ext || !ext.enabled) return null;
  const want = ext.path ? String(ext.path).replace(/\/+$/, '') : null;
  const base = { label: ext.label || (want ? path.basename(want) : 'Externe'), mounted: false };
  if (want && fs.existsSync(want)) {
    const u = await volumeUsage(want);
    if (u) return { ...base, mounted: true, ...u };
  }
  // Le volume a changé de nom ou de disque : on prend le plus grand volume externe présent.
  if (process.platform !== 'darwin') return base;
  let names = [];
  try { names = fs.readdirSync('/Volumes').filter((n) => !n.startsWith('.')); } catch { return base; }
  let best = null;
  for (const n of names) {
    const m = '/Volumes/' + n;
    let real = m;
    try { real = fs.realpathSync(m); } catch { continue; }
    if (real === '/' || real.startsWith('/System/Volumes/')) continue;   // disque de démarrage
    const u = await volumeUsage(m);
    if (u && (!best || u.total > best.total)) best = { label: n, mounted: true, ...u };
  }
  return best || base;
}

async function refreshSystem() {
  const [ram, disk, ext, containers] = await Promise.all([ramUsage(), diskUsage(), externalDiskUsage(), config.docker ? getContainers() : null]);
  system = {
    cpu: cpuPercent(),
    ram,
    disk,
    ext,
    docker: containers ? { running: containers.filter((c) => c.state === 'running').length, total: containers.length } : null,
    containers: containers || [],
    updatedAt: Date.now()
  };
  pruneSessions();
  broadcast();
}

// ---------------------------------------------------------------- sources externes

async function refreshMusic() {
  if (!config.music?.enabled) { music = { ok: false, error: 'désactivé' }; return; }
  music = await getMusic();
  if (music.ok && music.id && music.id !== lastTrackId) {
    lastTrackId = music.id;
    const saved = await saveArtwork(ARTWORK_PATH);
    artVersion = saved ? Date.now() : 0;
  }
  broadcast();
}

async function refreshReminders() {
  if (!config.reminders?.enabled) { reminders = { ok: false, error: 'désactivé' }; return; }
  reminders = await getReminders(config.reminders);
  broadcast();
}

async function refreshCalendar() {
  const parts = [];
  if (config.googleCalendar?.enabled) parts.push(await getGoogleCalendar(config.googleCalendar));
  if ((config.calendars || []).length) parts.push(await getCalendars(config.calendars));
  const ok = parts.filter((p) => p.ok);
  if (!parts.length) calendar = { ok: false, error: 'config' };
  else if (!ok.length) calendar = parts[0];
  else calendar = { ok: true, events: ok.flatMap((p) => p.events).sort((a, b) => a.start - b.start) };
  broadcast();
}

async function refreshPlex() {
  if (!config.plex?.enabled) { plex = { ok: false, error: 'désactivé' }; return; }
  plex = await getPlex(config.plex);
  broadcast();
}

async function refreshHermes(force = false) {
  if (!config.hermes?.enabled) return;
  const h = await hermes.rafraichir(force);
  if (h.ok) {
    const now = new Map(h.taches.map((t) => [t.id, t.statut]));
    if (hermesStatuts) {
      for (const t of h.taches) {
        const avant = hermesStatuts.get(t.id);
        if (avant === undefined || avant === t.statut) continue;
        if (t.statut === 'done') pushFeed(`Tâche terminée : ${t.titre}${t.resume ? ' · ' + t.resume : ''}`, 'hermes');
        else if (t.statut === 'blocked') pushFeed(`Tâche bloquée : ${t.titre}${t.raison ? ' · ' + t.raison : ''}`, 'hermes');
      }
    }
    hermesStatuts = now;
  }
  broadcast();
}

function hermesPublic() {
  if (!config.hermes?.enabled) return { ok: false, error: 'désactivé' };
  return { ...hermes.etat(), modeles: (config.hermes.modeles || []).map((m) => ({ label: m.label, texte: m.texte })) };
}

async function refreshSwitch() {
  if (config.switch?.enabled === false) return;
  try { switchState = await sw.refresh(); } catch (err) { switchState = { ok: false, error: 'erreur', detail: err.message }; }
  broadcast();
}

async function refreshDiscord() {
  if (config.discord?.enabled === false) return;
  try { await dc.refresh(); discordState = dc.etat(); } catch (err) { discordState = { ok: false, error: 'erreur', detail: err.message }; }
  broadcast();
  // Nouveau stream dans le salon → sur la barre, si elle est libre (pas de jeu en cours)
  if (config.discord?.autoStreams !== false) {
    const gaming = !!(switchState && switchState.eden && switchState.eden.gameMode);
    try {
      const x = await dc.autoStreams(!gaming);
      if (x) { pushFeed(`Discord : ${x.name || x.user} est en direct, stream sur la barre`, 'barre'); discordState = dc.etat(); broadcast(); }
    } catch (err) { console.error('[barre] Discord auto :', err.message); }
  }
}

async function refreshHue() {
  if (!config.hue?.enabled) { hue = { ok: false, error: 'désactivé' }; return; }
  hue = await getHue();
  broadcast();
}

// ---------------------------------------------------------------- priorités du jour

async function makePriorities(trigger) {
  if (prioritiesStatus.running) return;
  prioritiesStatus = { running: true, error: null };
  broadcast();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const context = {
    date: new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
    rappels: reminders.ok ? reminders.items.slice(0, 20).map((r) => ({ titre: r.title, liste: r.list, echeance: r.due ? new Date(r.due).toLocaleString('fr-FR') : null })) : [],
    agenda: calendar.ok ? calendar.events.slice(0, 25).map((e) => ({ titre: e.title, debut: new Date(e.start).toLocaleString('fr-FR'), journee: e.allDay })) : [],
    objectifs: countdowns().map((c) => `${c.label} dans ${c.days} jours`)
  };
  const r = await generatePriorities(context);
  if (r.ok) {
    priorities = { date: dayKey(), items: r.items.map((text) => ({ text, done: false })), generatedAt: Date.now() };
    writeJson(PRIORITIES_PATH, priorities);
    prioritiesStatus = { running: false, error: null };
    pushFeed(`Priorités du jour prêtes (${trigger})`, 'claude');
  } else {
    prioritiesStatus = { running: false, error: r.error };
    pushFeed('Échec de la génération des priorités', 'claude');
  }
  broadcast();
}

let lastPriorityAttempt = 0;
function checkPrioritySchedule() {
  if (!config.priorities?.enabled) return;
  // En cas d'échec (limite d'usage, déconnexion…), on réessaie au plus une fois par heure.
  if (Date.now() - lastPriorityAttempt < 3600 * 1000) return;
  const [h, m] = String(config.priorities.time || '07:00').split(':').map(Number);
  const now = new Date();
  const due = new Date(now); due.setHours(h || 0, m || 0, 0, 0);
  if (now >= due && priorities.date !== dayKey()) {
    lastPriorityAttempt = Date.now();
    makePriorities('auto');
  }
}

// ---------------------------------------------------------------- patrimoine

// (Re)lit patrimoine.json s'il a changé (commande « patrimoine » serveur arrêté,
// modification à la main…). Un fichier illisible ne remplace jamais la dernière
// version correcte : on la garde et on bloque les écritures jusqu'à correction.
function chargerPatrimoine() {
  let mtime = 0;
  try { mtime = fs.statSync(PATRIMOINE_PATH).mtimeMs; } catch { /* absent : créé ci-dessous */ }
  if (patri.ok && mtime && mtime === patriMtime) return false;
  const r = chargerFichier(PATRIMOINE_PATH);
  if (r.ok) {
    patri = { ok: true, data: r.data, erreurFichier: null };
    if (r.cree) console.log(`[barre] Patrimoine : fichier créé (quantités à remplir) ${PATRIMOINE_PATH}`);
  } else if (patri.ok) {
    patri = { ...patri, erreurFichier: r.error };
    console.error(`[barre] ${r.error}`);
  } else {
    patri = { ok: false, error: r.error, data: null, erreurFichier: r.error };
    console.error(`[barre] ${r.error}`);
  }
  try { patriMtime = fs.statSync(PATRIMOINE_PATH).mtimeMs; } catch { patriMtime = 0; }
  return true;
}

function sauverPatrimoine(data) {
  ecrireFichier(PATRIMOINE_PATH, data);
  patri = { ok: true, data, erreurFichier: null };
  try { patriMtime = fs.statSync(PATRIMOINE_PATH).mtimeMs; } catch { patriMtime = 0; }
}

let coursEnCours = null;
function rafraichirCours() {
  if (DEMO || !patri.ok || !config.patrimoine?.enabled) return Promise.resolve();
  if (coursEnCours) return coursEnCours;
  coursEnCours = (async () => {
    // ISIN des lignes : Tradegate cote par ISIN, la LSE sert à le vérifier.
    const infos = Object.fromEntries(patri.data.lignes.filter((l) => l.isin).map((l) => [l.symbole, { isin: l.isin }]));
    const premiers = symbolesNecessaires(patri.data, coursService.cours());
    await coursService.rafraichir(premiers, infos);
    // Devises découvertes avec les cours (ex. une ligne cotée en GBp) : 2e passe.
    const suite = symbolesNecessaires(patri.data, coursService.cours()).filter((s) => !premiers.includes(s));
    if (suite.length) await coursService.rafraichir(suite, infos);
    dernierCours = Date.now();
    broadcast();
  })().finally(() => { coursEnCours = null; });
  return coursEnCours;
}

// Chaque minute : fichier modifié ? cours à rafraîchir (15 min en séance, 2 h sinon) ?
async function tickPatrimoine() {
  if (!config.patrimoine?.enabled) return;
  if (chargerPatrimoine()) broadcast();
  if (Date.now() - dernierCours >= intervalleCours()) await rafraichirCours();
}

// Écriture commune aux routes POST /api/patrimoine/… : relit le fichier, applique
// la modification sur une copie, enregistre (écriture atomique), diffuse.
async function patrimoineMutation(req, res, appliquer) {
  if (!config.patrimoine?.enabled) return json(res, 404, { error: 'patrimoine désactivé dans config.json' });
  const body = await readBody(req, 16 * 1024);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'objet JSON attendu' });
  if (!DEMO) chargerPatrimoine();
  if (!patri.ok || patri.erreurFichier) {
    return json(res, 409, { error: `${patri.erreurFichier || patri.error}. Corrige le fichier avant toute modification.` });
  }
  let r;
  try {
    r = appliquer(patri.data, body);
  } catch (err) {
    if (err && err.saisie) return json(res, 400, { error: err.message });
    throw err;
  }
  sauverPatrimoine(r.data);
  if (r.nouveauSymbole) rafraichirCours().catch(() => {});
  broadcast();
  const op = r.operation ? (({ avant, apres, ...reste }) => reste)(r.operation) : undefined;
  return json(res, 200, { ok: true, message: r.message, avertissements: r.avertissements || [], operation: op, ligne: r.ligne || undefined });
}

// ---------------------------------------------------------------- actions

function runAction(id) {
  const a = (config.actions || []).find((x) => x.id === id);
  if (!a) return Promise.resolve({ ok: false, error: 'Action inconnue' });
  if (a.builtin === 'refresh') {
    return Promise.all([refreshSystem(), refreshMusic(), refreshReminders(), refreshPlex(), refreshHue(), refreshCalendar(), rafraichirCours()]).then(() => ({ ok: true }));
  }
  // Action confiée à Hermes : une tâche du Kanban, lancée tout de suite.
  if (a.kanban && config.hermes?.enabled) {
    return hermes.creer(a.kanban).then((r) => {
      if (r.deja) pushFeed(`Déjà en cours chez Hermes : ${a.label}`, 'barre');
      else pushFeed(`Confié à Hermes : ${a.label}${r.lancee ? '' : hermes.etat().pause ? ' (Hermes en pause)' : ' (démarrage dans la minute)'}`, 'barre');
      refreshHermes();
      return { ok: true, id: r.id };
    }, (err) => ({ ok: false, error: err.message }));
  }
  if (!a.command) return Promise.resolve({ ok: false, error: 'Action pas encore configurée' });
  pushFeed(`Action lancée : ${a.label}`, 'barre');
  broadcast();
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', a.command], { timeout: 120000, env: ENV, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const ok = !err;
      const tail = String(ok ? stdout : stderr || err?.message || '').trim().split('\n').pop() || '';
      pushFeed(`${ok ? 'Terminé' : 'Échec'} : ${a.label}${tail ? ' · ' + tail.slice(0, 120) : ''}`, 'barre');
      broadcast();
      resolve({ ok, error: ok ? undefined : 'La commande a échoué' });
    });
  });
}

// ---------------------------------------------------------------- HTTP

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Un cookie mal encodé (posé par un autre site du même hôte) ne doit pas faire tomber le serveur.
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignoré */ }
  }
  return out;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function sameOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs) return sfs === 'same-origin';
  // Navigateurs qui n'envoient pas Sec-Fetch-Site (page en http hors localhost) : on compare l'Origin.
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// → { token, via: 'bearer' | 'cookie' | 'query' | null }
function presentedToken(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return { token: h.slice(7), via: 'bearer' };
  const c = parseCookies(req.headers.cookie).barre_token;
  if (c) return { token: c, via: 'cookie' };
  const q = url.searchParams.get('token');
  return { token: q, via: q ? 'query' : null };
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('trop gros')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function imageType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return json(res, 400, { error: 'adresse invalide' }); }
  const { token, via } = presentedToken(req, url);

  if (!safeEqual(token, config.token)) {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="background:#0D0E10;color:#ECEAE4;font:24px system-ui;padding:40px">Jeton manquant. Ouvre l’adresse avec <code>?token=…</code> (voir config.json).</body>');
      return;
    }
    return json(res, 401, { error: 'non autorisé' });
  }

  // Avec le cookie, une action ne peut venir que de la page de la barre elle-même
  // (pas d'un autre site du tailnet qui partagerait le cookie).
  if (req.method !== 'GET' && via !== 'bearer' && !sameOrigin(req)) {
    return json(res, 403, { error: 'origine refusée' });
  }

  try {
    const p = url.pathname;

    // Page : le jeton passé en paramètre est rangé dans un cookie, puis on nettoie l'adresse.
    if (req.method === 'GET' && p === '/') {
      if (url.searchParams.has('token')) {
        res.writeHead(302, {
          'set-cookie': `barre_token=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          location: '/' + (url.searchParams.has('kiosk') ? '?kiosk=1' : '')
        });
        return res.end();
      }
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && p === '/api/state') return json(res, 200, publicState());

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 2000\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'GET' && p === '/api/music/artwork') {
      if (!fs.existsSync(ARTWORK_PATH) || !artVersion) return json(res, 404, { error: 'pas de pochette' });
      const buf = fs.readFileSync(ARTWORK_PATH);
      res.writeHead(200, { 'content-type': imageType(buf), 'cache-control': 'max-age=3600' });
      return res.end(buf);
    }

    // Canal Claude Code (channel/barre-channel.mjs) : connexion et demandes relayées
    if (req.method === 'GET' && p === '/api/relay/connect') return handleRelayConnect(req, res, url);
    if (req.method === 'POST' && p === '/api/relay/request') {
      const ok = handleRelayRequest(await readBody(req));
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'canal inconnu' });
    }

    // Appelé par le hook Claude Code (hooks/barre-hook.mjs)
    if (req.method === 'POST' && p === '/api/hook') {
      const input = await readBody(req);
      if (input.hook_event_name === 'PermissionRequest') return handlePermissionRequest(input, res);
      handleHookEvent(input);
      broadcast();
      return json(res, 200, { ok: true });
    }

    let m;
    if (req.method === 'POST' && (m = p.match(/^\/api\/permissions\/([\w-]+)\/decision$/))) {
      const body = await readBody(req);
      if (!['allow', 'always', 'deny'].includes(body.decision)) return json(res, 400, { error: 'décision invalide' });
      const ok = settle(m[1], body.decision);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'demande introuvable ou expirée' });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/rules\/(\d+)\/delete$/))) {
      const ok = removeRule(Number(m[1]));
      broadcast();
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'règle introuvable' });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/actions\/([\w-]+)$/))) {
      const result = await runAction(m[1]);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/music\/(playpause|next|previous|volup|voldown)$/))) {
      const r = await musicCommand(m[1]);
      setTimeout(refreshMusic, 400);
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error === 'permission' ? 'Autorise le contrôle de Musique sur le Mac' : 'Musique indisponible' });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/reminders\/(.+)\/complete$/))) {
      const r = await completeReminder(decodeURIComponent(m[1]));
      if (r.ok) {
        if (reminders.ok) reminders = { ...reminders, items: reminders.items.filter((x) => x.id !== decodeURIComponent(m[1])) };
        broadcast();
        setTimeout(refreshReminders, 1500);
      }
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: 'Impossible de cocher ce rappel' });
    }

    if (req.method === 'POST' && p === '/api/priorities/generate') {
      makePriorities('manuel');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/priorities\/(\d+)\/toggle$/))) {
      const it = priorities.items[Number(m[1])];
      if (!it) return json(res, 404, { error: 'introuvable' });
      it.done = !it.done;
      writeJson(PRIORITIES_PATH, priorities);
      broadcast();
      return json(res, 200, { ok: true });
    }

    // Hermes (ou un script) peut envoyer ses propres priorités : {"items":["…","…"]}
    if (req.method === 'POST' && p === '/api/priorities') {
      const body = await readBody(req);
      const items = (body.items || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
      if (!items.length) return json(res, 400, { error: 'items manquants' });
      priorities = { date: dayKey(), items: items.map((text) => ({ text, done: false })), generatedAt: Date.now() };
      writeJson(PRIORITIES_PATH, priorities);
      broadcast();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/hue\/([\w-]+)$/))) {
      const body = await readBody(req);
      const r = await setHueRoom(m[1], !!body.on);
      setTimeout(refreshHue, 800);
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: 'Pont Hue injoignable' });
    }

    // Pour que Hermes (ou n'importe quel script) affiche un message sur la barre :
    // curl -X POST -H "Authorization: Bearer <jeton>" -d '{"text":"…"}' http://127.0.0.1:4747/api/feed
    if (req.method === 'POST' && p === '/api/feed') {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'champ text manquant' });
      pushFeed(body.text, body.source || 'hermes');
      broadcast();
      return json(res, 200, { ok: true });
    }

    // Kanban Hermes : la page crée des tâches et les pilote ; Hermes les exécute.
    //   POST /api/hermes/taches {"texte":"…"}          → crée et lance tout de suite
    //   POST /api/hermes/taches/<id>/<verbe>           → arreter | relancer | valider | archiver | refaire
    //   POST /api/hermes/vider                         → archive les tâches faites
    //   POST /api/hermes/pause {"on":true|false}       → arrêt d'urgence officiel de Hermes
    if (p.startsWith('/api/hermes/') && !config.hermes?.enabled) return json(res, 404, { error: 'Hermes désactivé dans config.json' });
    if (req.method === 'GET' && p === '/api/hermes') {
      await refreshHermes(true);
      return json(res, 200, hermesPublic());
    }
    if (req.method === 'POST' && p === '/api/hermes/taches') {
      const body = await readBody(req);
      const r = await hermes.creer(body.texte);
      if (!r.deja) pushFeed(`Confié à Hermes : ${String(body.texte).trim().split('\n')[0].slice(0, 90)}`, 'barre');
      refreshHermes();
      return json(res, 200, { ok: true, ...r });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/hermes\/taches\/(t_[\w-]+)\/(arreter|relancer|valider|archiver|refaire)$/))) {
      const r = await hermes.action(m[1], m[2]);
      refreshHermes();
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/hermes/vider') {
      const r = await hermes.viderFaites();
      refreshHermes();
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/hermes/pause') {
      const body = await readBody(req);
      const r = await hermes.pause(!!body.on);
      pushFeed(r.pause ? 'Hermes en pause : plus aucune nouvelle tâche ne démarre' : 'Hermes reprend le travail', 'barre');
      refreshHermes();
      return json(res, 200, r);
    }

    // Page Switch (Eden) : icônes des jeux, lancement, fenêtre sur la barre ou l'écran, décompression NSZ.
    if (req.method === 'GET' && (m = p.match(/^\/api\/switch\/icon\/([0-9A-F]{16})\.jpg$/))) {
      const f = await sw.iconPath(m[1]);
      if (!f) return json(res, 404, { error: 'pas d’icône' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/switch\/(launch|place|home|resume|quit|decompress|emu|rescan)$/))) {
      const body = await readBody(req);
      let r;
      if (m[1] === 'launch') {
        r = sw.launch(String(body.id || ''), body.target === 'bar' ? 'bar' : 'main', !!body.force);
        // Le lancement prend jusqu'à 40 s : on répond tout de suite si ce n'est pas une demande de confirmation
        const quick = await Promise.race([r, new Promise((res2) => setTimeout(() => res2(null), 1500))]);
        r.then(() => refreshSwitch(), (e) => { pushFeed(`Switch : ${e.message}`, 'barre'); refreshSwitch(); });
        refreshSwitch();
        return json(res, 200, quick || { ok: true, pending: true });
      }
      if (m[1] === 'place') r = await sw.place(body.target === 'bar' ? 'bar' : 'main');
      else if (m[1] === 'home') r = await sw.home();
      else if (m[1] === 'resume') r = await sw.resume();
      else if (m[1] === 'quit') r = await sw.quit();
      else if (m[1] === 'decompress') r = sw.decompress(String(body.id || ''));
      else if (m[1] === 'emu') r = sw.setEmu(String(body.id || ''), String(body.emu || ''));
      else { await sw.scan(true); r = { ok: true }; }
      refreshSwitch();
      return json(res, 200, r);
    }

    // Page Discord : avatars découpés par BarreTouch dans l'image de Discord (data/discord-avatars/<clé>.png)
    if (req.method === 'GET' && (m = p.match(/^\/api\/discord\/avatar\/([A-Za-z0-9_-]{1,120})\.png$/))) {
      const f = path.join(DATA_DIR, 'discord-avatars', m[1] + '.png');
      if (!fs.existsSync(f)) return json(res, 404, { error: 'pas d’avatar' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=600' });
      return res.end(fs.readFileSync(f));
    }
    // Page Discord : mosaïque des flux de la fenêtre détachée de l'appel (capture par BarreTouch).
    if (req.method === 'POST' && (m = p.match(/^\/api\/discord\/(start|add|remove|watch|unwatch|self|user|stop|focus|mode|rescan|snapshot)$/))) {
      if (config.discord?.enabled === false) return json(res, 404, { error: 'page Discord désactivée dans config.json' });
      const body = await readBody(req);
      let r;
      if (m[1] === 'start') r = await dc.start(body.windows || body.window);
      else if (m[1] === 'add') r = await dc.add(body.window);
      else if (m[1] === 'remove') r = await dc.remove(body.window);
      else if (m[1] === 'watch') r = await dc.watch(body.user);
      else if (m[1] === 'unwatch') r = await dc.unwatch(body.user);
      else if (m[1] === 'self') r = await dc.self(body);
      else if (m[1] === 'user') r = await dc.user(body);
      else if (m[1] === 'stop') r = await dc.stop();
      else if (m[1] === 'focus') r = await dc.focus(Number(body.index));
      else if (m[1] === 'mode') r = await dc.mode(body.mode);
      else if (m[1] === 'rescan') r = await dc.rescan();
      else r = await dc.snapshot();
      refreshDiscord();
      return json(res, 200, r);
    }

    // Patrimoine (commande « patrimoine », Hermes, Claude Code). Mêmes règles
    // que les autres POST : jeton, et même origine quand le jeton vient du cookie.
    if (req.method === 'GET' && p === '/api/patrimoine') {
      if (!config.patrimoine?.enabled) return json(res, 404, { error: 'patrimoine désactivé dans config.json' });
      if (!DEMO) chargerPatrimoine();
      if (!patri.ok) return json(res, 409, { error: patri.error });
      const ops = patri.data.operations.map(({ avant, apres, ...reste }) => reste);
      return json(res, 200, {
        ok: true,
        resume: calculer(patri.data, coursService.cours(), new Date()),
        operations: ops,
        comptes: patri.data.comptes.map(({ id, nom, type, date_ouverture }) => ({ id, nom, type, date_ouverture })),
        cible: patri.data.cible,
        erreur_fichier: patri.erreurFichier,
        erreurs_cours: coursService.erreurs()
      });
    }
    if (req.method === 'POST' && p === '/api/patrimoine/operation') {
      return await patrimoineMutation(req, res, (data, body) => appliquerOperation(data, body, { cours: coursService.cours() }));
    }
    // Ligne (ajout / modification), liquidités ou cible selon « type ».
    if (req.method === 'POST' && p === '/api/patrimoine/ligne') {
      return await patrimoineMutation(req, res, (data, body) => {
        const type = body.type ?? 'ligne';
        if (type === 'ligne') return modifierLigne(data, body);
        if (type === 'liquidites') return fixerLiquidites(data, body);
        if (type === 'cible') return fixerCible(data, body);
        throw new ErreurSaisie('type : ligne, liquidites ou cible attendu');
      });
    }
    if (req.method === 'POST' && p === '/api/patrimoine/annuler') {
      return await patrimoineMutation(req, res, (data) => annulerDerniere(data));
    }
    if (req.method === 'POST' && p === '/api/patrimoine/cours') {
      if (!config.patrimoine?.enabled) return json(res, 404, { error: 'patrimoine désactivé dans config.json' });
      await rafraichirCours();
      return json(res, 200, { ok: true, erreurs: coursService.erreurs() });
    }

    return json(res, 404, { error: 'introuvable' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
});

process.on('unhandledRejection', (err) => console.error('[barre] erreur non gérée :', err && err.message));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[barre] Le port ${config.port} est déjà utilisé (le serveur tourne déjà ?).`);
    process.exit(1);
  }
  throw err;
});

// Boucle de rafraîchissement : jamais deux lectures en même temps, et on
// espace les essais (1 min) tant qu'une autorisation macOS manque.
function every(ms, fn, blocked = () => false) {
  let busy = false;
  let pauseUntil = 0;
  const tick = async () => {
    if (busy || Date.now() < pauseUntil) return;
    busy = true;
    try { await fn(); } catch (err) { console.error('[barre]', err.message); }
    busy = false;
    if (blocked()) pauseUntil = Date.now() + 60000;
  };
  tick();
  return setInterval(tick, ms);
}

server.listen(config.port, config.host, () => {
  // Le jeton n'est jamais écrit dans les journaux (il est dans config.json).
  console.log(`[barre] Tableau de bord sur http://${config.host}:${config.port}/ (jeton : ${CONFIG_PATH})`);
  if (DEMO) return import('./lib/demo.mjs').then((d) => d.install({ setState, broadcast, pushFeed }));
  every(5000, refreshSystem);
  every(3000, refreshMusic, () => !music.ok && music.error === 'permission');
  every(60000, refreshReminders);
  // l'agenda part après les rappels pour que les priorités aient tout le contexte
  setTimeout(() => every(5 * 60000, refreshCalendar), 1000);
  every(10000, refreshPlex);
  every(30000, refreshHue, () => !hue.ok);
  setTimeout(() => every(60000, checkPrioritySchedule), 30000);
  every(60000, tickPatrimoine);
  every(3000, () => refreshHermes());
  every(4000, refreshSwitch);
  every(2000, refreshDiscord);
  // Jeu qui démarre → sur la barre ; jeu arrêté → tableau de bord (sondage léger de la fenêtre d'Eden)
  if (config.switch?.enabled !== false) every(1500, async () => { if (await sw.watch()) refreshSwitch(); });
});

// Pour le mode démo (captures d'écran sans Mac)
function setState(s) {
  if (s.system) system = s.system;
  if (s.music) { music = s.music; artVersion = 0; }
  if (s.reminders) reminders = s.reminders;
  if (s.calendar) calendar = s.calendar;
  if (s.plex) plex = s.plex;
  if (s.hue) hue = s.hue;
  if (s.priorities) priorities = s.priorities;
  if (s.sessions) for (const x of s.sessions) sessions.set(x.id, x);
  if (s.patrimoine) {
    patri = { ok: true, data: s.patrimoine.data, erreurFichier: null };
    coursService.remplacer(s.patrimoine.cours);
  }
}

function shutdown() {
  for (const id of [...pending.keys()]) settle(id, 'ask');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
