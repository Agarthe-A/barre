// Sources de données de la barre : Apple Music, Rappels, Plex, Hue, Docker,
// agendas iCal et priorités du jour générées par Claude.
// Chaque fonction renvoie { ok: true, ... } ou { ok: false, error } et ne bloque
// jamais plus de quelques secondes (timeouts partout).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseIcs } from './ics.mjs';

const EXTRA_PATH = [
  '/opt/homebrew/bin', '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.orbstack', 'bin')
].join(':');
export const ENV = { ...process.env, PATH: `${process.env.PATH || '/usr/bin:/bin'}:${EXTRA_PATH}` };

// Les autorisations « Automatisation » de macOS (Musique, Rappels) ne peuvent pas être demandées par
// ce service sans fenêtre : osascript est donc exécuté par BarreTouch (vraie app, ~/barre/touch),
// via son relais local 127.0.0.1:4748. Si BarreTouch ne répond pas, on exécute osascript ici.
let relayToken = null;
function barreToken() {
  if (relayToken) return relayToken;
  try {
    relayToken = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'barre', 'config.json'), 'utf8')).token || null;
  } catch { relayToken = null; }
  return relayToken;
}
async function viaBarreTouch(args, timeout) {
  const token = barreToken();
  if (!token) return null;
  try {
    const r = await fetch('http://127.0.0.1:4748/osascript', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ args, timeout: timeout / 1000 }),
      signal: AbortSignal.timeout(timeout + 2000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    return { ok: !!j.ok, out: String(j.out || ''), err: String(j.err || ''), timedOut: !!j.timedOut };
  } catch { return null; }
}

export function run(cmd, args, opts = {}) {
  if (cmd === 'osascript') {
    return viaBarreTouch(args, opts.timeout ?? 5000).then((r) => r ?? runLocal(cmd, args, opts));
  }
  return runLocal(cmd, args, opts);
}

function runLocal(cmd, args, { timeout = 5000, env = ENV, input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, env, cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || ''), timedOut: !!(err && err.killed) });
    });
    // stdin toujours fermé : sinon `claude -p` attend une entrée qui n'arrive jamais.
    // Une commande déjà terminée (ou introuvable) ferme le tube : EPIPE ne doit
    // pas faire tomber le serveur.
    child.stdin.on('error', () => {});
    child.stdin.end(input != null ? input : '');
  });
}

// ---------------------------------------------------------------- AppleScript

// macOS demande une autorisation la 1re fois (Réglages › Confidentialité ›
// Automatisation). Tant qu'elle n'est pas donnée, on renvoie error: 'permission'.
function osaError(res) {
  // Une fenêtre d'autorisation ouverte bloque le script jusqu'au délai : même cause.
  if (res.timedOut) return 'permission';
  if (/-1743|Not authorized|not allowed|autoris/i.test(res.err)) return 'permission';
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(res.err)) return 'permission';
  return 'erreur';
}

async function jxa(script, timeout = 6000) {
  const res = await run('osascript', ['-l', 'JavaScript', '-e', script], { timeout });
  if (!res.ok) return { ok: false, error: osaError(res) };
  try { return { ok: true, data: JSON.parse(res.out.trim() || 'null') }; } catch { return { ok: false, error: 'erreur' }; }
}

// ---------------------------------------------------------------- Apple Music

const MUSIC_STATE = `
const m = Application('Music');
if (!m.running()) { JSON.stringify({ running: false }); } else {
  let r = { running: true, state: String(m.playerState()), volume: m.soundVolume() };
  try {
    const t = m.currentTrack;
    r.id = t.persistentID(); r.title = t.name(); r.artist = t.artist(); r.album = t.album();
    r.duration = t.duration(); r.position = m.playerPosition();
  } catch (e) { r.title = null; }
  JSON.stringify(r);
}`;

export async function getMusic() {
  if (process.platform !== 'darwin') return { ok: false, error: 'mac' };
  const r = await jxa(MUSIC_STATE, 5000);
  if (!r.ok) return r;
  return { ok: true, ...r.data };
}

export async function musicCommand(cmd) {
  const scripts = {
    playpause: "Application('Music').playpause()",
    next: "Application('Music').nextTrack()",
    previous: "Application('Music').backTrack()",
    volup: "const m=Application('Music'); m.soundVolume = Math.min(100, m.soundVolume()+10)",
    voldown: "const m=Application('Music'); m.soundVolume = Math.max(0, m.soundVolume()-10)"
  };
  if (!scripts[cmd]) return { ok: false, error: 'commande inconnue' };
  const res = await run('osascript', ['-l', 'JavaScript', '-e', scripts[cmd]], { timeout: 5000 });
  return res.ok ? { ok: true } : { ok: false, error: osaError(res) };
}

// Pochette du morceau en cours → fichier image (rafraîchi quand le morceau change)
export async function saveArtwork(file) {
  const script = [
    'tell application "Music"',
    'if (count of artworks of current track) is 0 then return "none"',
    'set d to raw data of artwork 1 of current track',
    'end tell',
    `set f to open for access POSIX file "${file}" with write permission`,
    'set eof f to 0',
    'write d to f',
    'close access f',
    'return "ok"'
  ];
  const args = [];
  for (const l of script) args.push('-e', l);
  const res = await run('osascript', args, { timeout: 6000 });
  return res.ok && res.out.trim() === 'ok';
}

// ---------------------------------------------------------------- Rappels

const REMINDERS = (lists, max) => `
const app = Application('Reminders');
const wanted = ${JSON.stringify(lists || [])};
const out = [];
for (const l of app.lists()) {
  const name = l.name();
  if (wanted.length && !wanted.includes(name)) continue;
  const open = l.reminders.whose({ completed: false });
  const ids = open.id(), names = open.name(), dues = open.dueDate(), prios = open.priority();
  for (let i = 0; i < ids.length; i++) {
    out.push({ id: ids[i], title: names[i], list: name, due: dues[i] ? dues[i].getTime() : null, priority: prios[i] || 0 });
  }
}
JSON.stringify(out.slice(0, ${Number(max) || 50}));`;

export async function getReminders(cfg = {}) {
  if (process.platform !== 'darwin') return { ok: false, error: 'mac' };
  const r = await jxa(REMINDERS(cfg.lists, 60), 15000);
  if (!r.ok) return r;
  const now = Date.now();
  const items = (r.data || []).sort((a, b) => {
    const da = a.due ?? Infinity, db = b.due ?? Infinity;
    return da - db || (b.priority || 0) - (a.priority || 0);
  }).map((x) => ({ ...x, overdue: x.due != null && x.due < now }));
  return { ok: true, items };
}

export async function completeReminder(id) {
  const script = `Application('Reminders').reminders.byId(${JSON.stringify(String(id))}).completed = true; 'ok'`;
  const res = await run('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 8000 });
  return res.ok ? { ok: true } : { ok: false, error: osaError(res) };
}

// ---------------------------------------------------------------- Agendas iCal

export async function getCalendars(list = [], days = 8) {
  if (!list.length) return { ok: false, error: 'config' };
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = from.getTime() + days * 86400000;
  const all = [];
  let failed = 0;
  for (const c of list) {
    try {
      const r = await fetch(c.url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(String(r.status));
      all.push(...parseIcs(await r.text(), c.name || 'Agenda', from.getTime(), to));
    } catch { failed += 1; }
  }
  if (failed === list.length) return { ok: false, error: 'injoignable' };
  return { ok: true, events: all.sort((a, b) => a.start - b.start) };
}

// ---------------------------------------------------------------- Google Agenda (accès déjà donné à Hermes)
// Lecture seule : on relit le jeton de Hermes sans jamais le modifier ; le jeton
// d'accès rafraîchi reste en mémoire.

let gAccess = null;
async function googleAccessToken(file) {
  if (gAccess && gAccess.exp > Date.now() + 60000) return gAccess.token;
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const body = new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const r = await fetch(t.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`jeton ${r.status}`);
  const j = await r.json();
  gAccess = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gAccess.token;
}

export async function getGoogleCalendar(cfg = {}, days = 8) {
  const file = String(cfg.tokenFile || '~/.hermes/google_token.json').replace(/^~/, os.homedir());
  if (!fs.existsSync(file)) return { ok: false, error: 'config' };
  try {
    const token = await googleAccessToken(file);
    const api = async (p) => {
      const r = await fetch('https://www.googleapis.com/calendar/v3' + p, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    };
    const list = await api('/users/me/calendarList?minAccessRole=reader');
    const exclude = cfg.exclude || [];
    const cals = (list.items || []).filter((c) => c.selected !== false && !c.hidden && !exclude.includes(c.summaryOverride || c.summary));
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + days * 86400000);
    const out = [];
    await Promise.all(cals.map(async (c) => {
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      try {
        const res = await api(`/calendars/${encodeURIComponent(c.id)}/events?${q}`);
        for (const e of res.items || []) {
          if (e.status === 'cancelled') continue;
          if ((e.attendees || []).some((a) => a.self && a.responseStatus === 'declined')) continue;
          const allDay = !!(e.start && e.start.date);
          const start = allDay ? new Date(e.start.date + 'T00:00:00').getTime() : Date.parse(e.start && e.start.dateTime);
          const end = allDay ? new Date(e.end.date + 'T00:00:00').getTime() : Date.parse(e.end && e.end.dateTime);
          if (!start) continue;
          out.push({ title: e.summary || '(sans titre)', location: e.location || '', start, end: end || start + 3600000, allDay, calendar: c.summaryOverride || c.summary || 'Agenda' });
        }
      } catch { /* un agenda illisible n'empêche pas les autres */ }
    }));
    return { ok: true, events: out.sort((a, b) => a.start - b.start) };
  } catch {
    gAccess = null;
    return { ok: false, error: 'injoignable' };
  }
}

// ---------------------------------------------------------------- Plex

let plexToken = null;
async function plexTokenFor(cfg) {
  if (cfg.token) return cfg.token;
  if (plexToken) return plexToken;
  const r = await run('defaults', ['read', 'com.plexapp.plexmediaserver', 'PlexOnlineToken'], { timeout: 3000 });
  plexToken = r.ok ? r.out.trim() : null;
  return plexToken;
}

export async function getPlex(cfg = {}) {
  const base = cfg.url || 'http://127.0.0.1:32400';
  const token = await plexTokenFor(cfg);
  if (!token) return { ok: false, error: 'config' };
  const get = async (p) => {
    const u = new URL(p, base);
    u.searchParams.set('X-Plex-Token', token);
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()).MediaContainer || {};
  };
  try {
    const s = await get('/status/sessions');
    const sessions = (s.Metadata || []).map((m) => ({
      title: m.grandparentTitle ? `${m.grandparentTitle} · ${m.title}` : m.title,
      user: m.User?.title || '',
      state: m.Player?.state || '',
      progress: m.duration ? Math.round((m.viewOffset || 0) / m.duration * 100) : 0
    }));
    let recent = [];
    const sections = cfg.recentSections || [];
    const lists = await Promise.all((sections.length ? sections : ['']).map((k) =>
      get(k ? `/library/sections/${k}/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=20` : '/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=20')
        .catch(() => ({}))));
    for (const l of lists) recent.push(...(l.Metadata || []));
    // Les épisodes d'une même série sont regroupés : « Série · 4 nouveaux épisodes ».
    const groups = new Map();
    for (const m of recent.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))) {
      const show = m.type === 'episode' ? m.grandparentTitle : m.type === 'season' ? m.parentTitle : null;
      const key = show ? `show:${show}` : `item:${m.ratingKey || m.title}`;
      const g = groups.get(key);
      if (g) { g.count += m.type === 'episode' ? 1 : (m.leafCount || 1); continue; }
      groups.set(key, {
        show,
        title: m.title,
        type: m.type,
        count: m.type === 'episode' ? 1 : m.type === 'season' ? (m.leafCount || 1) : 1,
        addedAt: (m.addedAt || 0) * 1000
      });
    }
    recent = [...groups.values()].slice(0, 6).map((g) => ({
      title: g.show ? (g.count > 1 ? `${g.show} · ${g.count} nouveaux épisodes` : `${g.show} · ${g.title}`) : g.title,
      type: g.show ? 'show' : g.type,
      addedAt: g.addedAt
    }));
    return { ok: true, sessions, recent };
  } catch {
    return { ok: false, error: 'injoignable' };
  }
}

// ---------------------------------------------------------------- Hue (openhue)

export async function getHue() {
  const r = await run('openhue', ['get', 'room', '--json'], { timeout: 6000 });
  if (!r.ok) return { ok: false, error: /not found|ENOENT/.test(r.err) ? 'absent' : 'injoignable' };
  try {
    const rooms = JSON.parse(r.out).map((x) => ({
      id: x.Id,
      name: x.Name,
      on: !!x.GroupedLight?.HueData?.on?.on,
      brightness: Math.round(x.GroupedLight?.HueData?.dimming?.brightness ?? 0)
    }));
    return { ok: true, rooms };
  } catch {
    return { ok: false, error: 'erreur' };
  }
}

export async function setHueRoom(id, on) {
  const r = await run('openhue', ['set', 'room', String(id), on ? '--on' : '--off'], { timeout: 6000 });
  return r.ok ? { ok: true } : { ok: false, error: 'injoignable' };
}

// ---------------------------------------------------------------- Docker

export async function getContainers() {
  const r = await run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'], { timeout: 5000 });
  if (!r.ok) return null;
  return r.out.trim().split('\n').filter(Boolean).map((l) => {
    const [name, state, status] = l.split('\t');
    return { name, state, status };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- Priorités (Claude)

export async function generatePriorities(context) {
  const prompt = [
    'Tu prépares la journée de Julian. Voici ses rappels en cours, son agenda des prochains jours et ses objectifs.',
    'Propose exactement 3 priorités concrètes et réalistes pour AUJOURD\'HUI, en français, chacune en moins de 70 caractères, en commençant par un verbe.',
    'Tiens compte des échéances et des séances d\'entraînement du jour. N\'invente aucune information et ne mélange jamais deux rappels différents.',
    'Réponds UNIQUEMENT avec ce JSON, sans texte autour : {"priorities":["…","…","…"]}',
    '',
    JSON.stringify(context)
  ].join('\n');
  const env = { ...ENV, BARRE_INTERNAL: '1' };
  // Le contexte (titres d'agenda…) peut venir d'autres personnes : Claude tourne
  // ici sans aucun outil ni serveur MCP, depuis un dossier temporaire.
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  const bin = fs.existsSync(local) ? local : 'claude';
  const r = await run(bin, ['-p', prompt, '--output-format', 'text', '--tools', '', '--strict-mcp-config'], { timeout: 180000, env, cwd: os.tmpdir() });
  if (!r.ok) return { ok: false, error: 'claude' };
  const m = r.out.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : r.out);
    const items = (j.priorities || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
    return items.length ? { ok: true, items } : { ok: false, error: 'vide' };
  } catch {
    return { ok: false, error: 'format' };
  }
}

// ---------------------------------------------------------------- petit stockage

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
