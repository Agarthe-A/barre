// Page « Switch » de la barre : la ludothèque d'Eden façon console.
//
// - Jeux : fichiers NSP/XCI (jouables) et NSZ/XCZ (à décompresser) des dossiers de jeux d'Eden
//   (~/.config/eden/qt-config.ini). Titre et icône lus dans chaque jeu par tools/switch_meta.py
//   (clés d'Eden, environnement Python ~/.venvs/nsz), gardés en cache dans data/switch.json.
// - Temps de jeu et dernière partie : fichiers d'Eden (play_time/playtime.bin, ~/.cache/eden/launched.json).
// - Deux émulateurs : Eden (par défaut) et Ryujinx, au choix jeu par jeu (data/switch-emu.json, bouton sur la page).
//   Ryujinx affiche mieux certains jeux sur Mac (Mario Kart) ; ses clés et son firmware sont les mêmes qu'Eden.
// - Jeu en cours, fenêtre sur la barre ou l'écran : demandé à BarreTouch (relais 127.0.0.1:4748, POST /window).
// - « Toute la Switch sur la barre » : un jeu qui démarre (depuis la page ou depuis Eden) passe tout seul
//   en plein écran sur la barre (watch(), toutes les 1,5 s), sauf si on l'a lancé exprès sur le grand écran.
// Rien n'est jamais écrit dans les dossiers d'Eden ni à côté des jeux (sauf la décompression demandée).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EMUS = {
  eden:    { label: 'Eden',    app: '/Applications/eden.app',    bin: '/Applications/eden.app/Contents/MacOS/eden',       args: (f) => ['-g', f] },
  ryujinx: { label: 'Ryujinx', app: '/Applications/Ryujinx.app', bin: '/Applications/Ryujinx.app/Contents/MacOS/Ryujinx', args: (f) => [f] }
};
const EDEN_APP = EMUS.eden.app;
const EDEN_BIN = EMUS.eden.bin;
const RYU_DATA = path.join(HOME, 'Library/Application Support/Ryujinx');
const QT_CONFIG = path.join(HOME, '.config/eden/qt-config.ini');
const PLAYTIME = path.join(HOME, '.local/share/eden/play_time/playtime.bin');
const LAUNCHED = path.join(HOME, '.cache/eden/launched.json');
const NSZ_PY = path.join(HOME, '.venvs/nsz/bin/python');
const META_PY = path.join(ROOT, 'tools/switch_meta.py');
const DECOMP = path.join(HOME, 'bin/decompresser-nsz');
const EXT = /\.(nsp|xci|nsz|xcz)$/i;

const sh = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) =>
    resolve({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') }));
});

export function creerSwitch({ dataDir, token, relayPort = 4748 }) {
  const cacheFile = path.join(dataDir, 'switch.json');
  const emuFile = path.join(dataDir, 'switch-emu.json');     // { "<titleId ou chemin>": "ryujinx" | "eden" }
  let emuPref = {};
  try { emuPref = JSON.parse(fs.readFileSync(emuFile, 'utf8')); } catch { emuPref = {}; }
  const installed = () => Object.keys(EMUS).filter((k) => fs.existsSync(EMUS[k].app));
  const emuFor = (g) => {
    const want = emuPref[g.titleId || ''] || emuPref[g.file] || 'eden';
    return EMUS[want] && fs.existsSync(EMUS[want].app) ? want : (installed()[0] || 'eden');
  };
  const iconDir = path.join(dataDir, 'switch-icons');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { meta = {}; }
  let games = [];
  let lastScan = 0;
  let scanning = null;
  let eden = { running: false };
  let controller = { connected: false };
  let lastController = 0;
  let decomp = null;          // { file, started, out, expected } pendant une décompression
  let lastDecomp = null;      // { file, ok, at }
  let busy = null;            // « lancement… » affiché sur la page
  let placing = false;        // déplacement de fenêtre en cours
  let seen;                   // dernier jeu vu par watch() (undefined : pas encore regardé)
  let wasOnBar = false;
  let stopTicks = 0;          // « plus de jeu » vu plusieurs fois de suite (les bascules plein écran trompent une lecture)
  let live = { game: null, since: 0 };

  // ------------------------------------------------------------------ relais BarreTouch
  async function relay(body, timeout = 15000) {
    try {
      const r = await fetch(`http://127.0.0.1:${relayPort}/window`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: 'barretouch' };
    }
  }

  // ------------------------------------------------------------------ jeux
  function gameDirs() {
    let txt = '';
    try { txt = fs.readFileSync(QT_CONFIG, 'utf8'); } catch { return []; }
    const dirs = [];
    for (const m of txt.matchAll(/^Paths\\gamedirs\\(\d+)\\path=(.+)$/gm)) {
      const p = m[2].trim();
      if (!p.startsWith('/')) continue;                        // SDMC, UserNAND, SysNAND : contenus installés, ignorés
      const deep = new RegExp(`^Paths\\\\gamedirs\\\\${m[1]}\\\\deep_scan=true$`, 'm').test(txt);
      dirs.push({ path: p, deep });
    }
    return dirs;
  }

  function listFiles(dir, deep, depth = 0, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (deep && depth < 3) listFiles(full, deep, depth + 1, out); continue; }
      if (EXT.test(e.name)) out.push(full);
    }
    return out;
  }

  // « Pokemon Fire Red [0100554023408000][v0] (35 MB) » → titre et identifiant de secours
  function fromName(file) {
    const base = path.basename(file).replace(EXT, '');
    const tid = (base.match(/\[(0100[0-9A-Fa-f]{12})\]/) || [])[1];
    const name = base.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { name: name || base, titleId: tid ? tid.toUpperCase() : null };
  }

  const lisible = (s) => !!s && s.length >= 2 && !/[�\u0000-\u001F]/.test(s);

  async function scan(force = false) {
    if (scanning) return scanning;
    if (!force && Date.now() - lastScan < 60000 && games.length) return games;
    scanning = (async () => {
      const files = gameDirs().flatMap((d) => listFiles(d.path, d.deep));
      const todo = [];
      const st = {};
      for (const f of files) {
        try { const s = fs.statSync(f); st[f] = { size: s.size, mtime: Math.round(s.mtimeMs) }; } catch { continue; }
        const m = meta[f];
        if (!m || m.size !== st[f].size || m.mtime !== st[f].mtime) todo.push(f);
      }
      if (todo.length && fs.existsSync(NSZ_PY) && fs.existsSync(META_PY)) {
        const r = await sh(NSZ_PY, [META_PY, iconDir, ...todo], 120000);
        for (const line of r.out.split('\n')) {
          if (!line.startsWith('{')) continue;
          try {
            const j = JSON.parse(line);
            meta[j.file] = { ...st[j.file], ...j };
          } catch { /* ligne illisible */ }
        }
        for (const f of todo) if (!meta[f]) meta[f] = { ...st[f], error: 'lecture impossible' };
        try { fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(meta, null, 1)); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch { /* cache facultatif */ }
      }
      for (const k of Object.keys(meta)) if (!st[k]) delete meta[k];
      games = files.filter((f) => st[f]).map((f) => {
        const m = meta[f] || {};
        const fb = fromName(f);
        const tid = (m.titleId || fb.titleId || '').toUpperCase() || null;
        const compressed = /\.(nsz|xcz)$/i.test(f);
        return {
          id: Buffer.from(f).toString('base64url'),
          file: f,
          titleId: tid,
          name: lisible(m.name) ? m.name : fb.name,
          publisher: lisible(m.publisher) ? m.publisher : null,
          version: m.version || null,
          format: path.extname(f).slice(1).toUpperCase(),
          size: st[f].size,
          compressed,
          icon: !!(tid && fs.existsSync(path.join(iconDir, tid + '.jpg')))
        };
      });
      lastScan = Date.now();
      return games;
    })();
    try { return await scanning; } finally { scanning = null; }
  }

  function playtimes() {
    const out = {};
    try {
      const b = fs.readFileSync(PLAYTIME);
      for (let o = 0; o + 16 <= b.length; o += 16) {
        out[b.readBigUInt64LE(o).toString(16).padStart(16, '0').toUpperCase()] = Number(b.readBigUInt64LE(o + 8));
      }
    } catch { /* jamais joué */ }
    return out;
  }

  // Ryujinx : games/<TID>/gui/metadata.json → { timespan_played: "[j.]hh:mm:ss[.fff]", last_played_utc }
  function ryujinxTimes() {
    const out = {};
    let ids = [];
    try { ids = fs.readdirSync(path.join(RYU_DATA, 'games')); } catch { return out; }
    for (const id of ids) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(RYU_DATA, 'games', id, 'gui/metadata.json'), 'utf8'));
        const m = String(j.timespan_played || '').match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
        const secs = m ? (Number(m[1] || 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) : 0;
        const last = j.last_played_utc ? Date.parse(j.last_played_utc) || 0 : 0;
        out[id.toUpperCase()] = { secs, last };
      } catch { /* jeu jamais lancé dans Ryujinx */ }
    }
    return out;
  }

  function launches() {
    try {
      const j = JSON.parse(fs.readFileSync(LAUNCHED, 'utf8'));
      const out = {};
      for (const [k, v] of Object.entries(j)) out[k.toUpperCase()] = { count: v.launch_count || 0, last: (v.timestamp || 0) * 1000 };
      return out;
    } catch { return {}; }
  }

  // ------------------------------------------------------------------ Eden et manette
  // Nom du jeu d'après le titre de la fenêtre.
  // Eden : « Eden | v0.2.1 | compilateur » au repos ; « … | <jeu> (64-bit) | version | MoltenVK » en jeu.
  // Ryujinx : « Ryujinx 1.3.3 » au repos ; « Ryujinx 1.3.3 - <jeu> v1.0.0 (0100152000022000) (32-bit) » en jeu.
  function gameFromTitle(emu, title) {
    const t = String(title || '');
    if (emu === 'ryujinx') {
      const i = t.indexOf(' - ');
      if (i < 0) return null;
      return t.slice(i + 3).replace(/\s*\((32|64)-bit\)\s*$/, '').replace(/\s*\([0-9A-Fa-f]{16}\)\s*$/, '').replace(/\s+v[\d.]+\s*$/, '').trim() || null;
    }
    const parts = t.split(' | ');
    return parts.length >= 4 ? parts[3].replace(/\s*\((32|64)-bit\)\s*$/, '') : null;
  }

  async function runningEmus() {
    const out = [];
    for (const k of Object.keys(EMUS)) {
      const p = await sh('/usr/bin/pgrep', ['-f', EMUS[k].bin]);
      if (p.ok && p.out.trim()) out.push(k);
    }
    return out;
  }

  async function refreshEden(light = false) {
    if (placing) return eden;   // BarreTouch est occupé à déplacer la fenêtre (animations plein écran) : dernier état connu
    const s = await relay({ action: 'status', light }, 4000);
    if (!s.ok) {
      const r = await runningEmus();
      eden = { running: r.length > 0, emu: r[0] || null, emuLabel: r[0] ? EMUS[r[0]].label : null, trusted: null, error: s.error };
      return eden;
    }
    const emu = s.emu && EMUS[s.emu] ? s.emu : null;
    const game = gameFromTitle(emu, s.title);
    if (game !== live.game) live = { game, since: game ? Date.now() : 0 };
    eden = {
      running: !!s.eden, emu, emuLabel: emu ? EMUS[emu].label : null,
      trusted: !!s.trusted, playing: !!game, game, since: live.since || null, titleOk: !!s.title,
      onBar: !!s.onBar, gameMode: !!s.gameMode,
      fullscreen: light ? !!eden.fullscreen : !!s.fullscreen,   // la version légère ne lit pas le plein écran
      hole: s.hole || null
    };
    return eden;
  }

  // Toutes les 1,5 s (léger) : un jeu qui démarre passe sur la barre ; un jeu arrêté libère la barre.
  // → true si l'état a changé (le serveur rediffuse alors la page).
  async function watch() {
    if (busy || placing) return false;
    const before = JSON.stringify([eden.game, eden.onBar, eden.gameMode]);
    await refreshEden(true);
    if (eden.error || eden.trusted === false) return false;   // BarreTouch muet (redémarrage…) : on ne conclut rien
    if (eden.running && !eden.titleOk) return false;          // fenêtre d'Eden introuvable un instant (bascule plein écran)
    const key = eden.playing ? eden.game : null;
    if (seen === undefined) { seen = key; wasOnBar = eden.onBar; return false; }   // au démarrage du serveur : on ne touche à rien
    if (key !== seen) {
      seen = key;
      if (key && !eden.onBar) {
        placing = true;
        try { await relay({ action: 'eden', target: 'bar' }, 20000); } finally { placing = false; }
        await refreshEden();
      }
    }
    const stopped = !eden.playing && (eden.gameMode || (wasOnBar && eden.onBar && eden.running));
    stopTicks = stopped ? stopTicks + 1 : 0;
    if (stopped && stopTicks < 2) return false;               // on attend de le revoir 1,5 s plus tard
    if (stopped) {
      // Jeu arrêté depuis Eden : sa liste revient sur le grand écran, le tableau de bord sur la barre
      stopTicks = 0;
      placing = true;
      try { await relay(eden.running && eden.onBar ? { action: 'eden', target: 'main' } : { action: 'panel', visible: true }, 20000); } finally { placing = false; }
      await refreshEden();
    }
    wasOnBar = eden.playing && eden.onBar;
    return JSON.stringify([eden.game, eden.onBar, eden.gameMode]) !== before;
  }

  async function refreshController() {
    if (Date.now() - lastController < 30000) return controller;
    lastController = Date.now();
    const r = await sh('/usr/sbin/system_profiler', ['SPBluetoothDataType', '-json'], 15000);
    let found = null;
    try {
      const j = JSON.parse(r.out);
      for (const ctl of j.SPBluetoothDataType || []) {
        for (const dev of ctl.device_connected || []) {
          for (const [name, d] of Object.entries(dev)) {
            if (/controller|dualsense|dualshock|xbox|joy-con|8bitdo|gamepad/i.test(name) || /gamepad/i.test(d.device_minorType || '')) {
              found = { name: name.replace(/ Wireless Controller$/, ''), battery: d.device_batteryLevelMain || null };
            }
          }
        }
      }
    } catch { /* lecture impossible */ }
    if (!found) {   // manette branchée par câble
      const u = await sh('/usr/sbin/ioreg', ['-p', 'IOUSB', '-w0']);
      const m = u.out.match(/\+-o ([^@<]*(?:DualSense|DualShock|Wireless Controller|Pro Controller|Xbox|8BitDo|Gamepad)[^@<]*)@/i);
      if (m) found = { name: m[1].trim().replace(/ Wireless Controller$/, ''), battery: null, usb: true };
    }
    controller = found ? { connected: true, ...found } : { connected: false };
    return controller;
  }

  async function refresh() {
    await Promise.all([scan(), refreshEden(), refreshController()]);
    return etat();
  }

  function etat() {
    const pt = playtimes();
    const ln = launches();
    const ry = ryujinxTimes();
    const emus = installed();
    const list = games.map((g0) => {
      const { file, ...g } = g0;
      const r = (g.titleId && ry[g.titleId]) || { secs: 0, last: 0 };
      return {
        ...g,
        emu: emuFor(g0),
        playtime: (g.titleId ? pt[g.titleId] || 0 : 0) + r.secs,
        launches: g.titleId && ln[g.titleId] ? ln[g.titleId].count : 0,
        lastPlayed: Math.max(g.titleId && ln[g.titleId] ? ln[g.titleId].last : 0, r.last)
      };
    });
    // Comme sur la console : le dernier joué d'abord, puis les jamais lancés
    list.sort((a, b) => (b.lastPlayed - a.lastPlayed) || a.name.localeCompare(b.name, 'fr'));
    let d = null;
    if (decomp) {
      let written = 0;
      try { written = fs.statSync(decomp.out).size; } catch { /* pas encore créé */ }
      d = { name: decomp.name, started: decomp.started, written, expected: decomp.expected };
    }
    return {
      ok: emus.length > 0,
      error: emus.length ? null : 'absent',
      emus: emus.map((k) => ({ id: k, label: EMUS[k].label })),
      games: list,
      eden,
      controller,
      decompress: d,
      lastDecompress: lastDecomp,
      busy
    };
  }

  // ------------------------------------------------------------------ actions
  const find = (id) => games.find((g) => g.id === id);

  const alive = (pids) => pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function stopEmu(k) {
    const p = await sh('/usr/bin/pgrep', ['-f', EMUS[k].bin]);
    const pids = p.out.split('\n').map((x) => Number(x)).filter(Boolean);
    if (!pids.length) return;
    if (k === 'ryujinx') {
      // Quitter proprement (arrêt de l'émulation, sauvegardes écrites), puis forcer si besoin
      await sh('/usr/bin/osascript', ['-e', 'tell application id "org.ryujinx.Ryujinx" to quit'], 5000);
      for (let i = 0; i < 40 && alive(pids); i++) await sleep(200);
    }
    if (alive(pids)) {
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* déjà fini */ } }
      for (let i = 0; i < 30 && alive(pids); i++) await sleep(200);
    }
    if (alive(pids)) {
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* déjà fini */ } }
      await sleep(500);
    }
  }

  async function stopEden() {
    for (const k of Object.keys(EMUS)) await stopEmu(k);
  }

  async function launch(id, target, force) {
    const g = find(id);
    if (!g) throw new Error('Jeu introuvable');
    if (g.compressed) throw new Error('Décompresse d’abord ce jeu (NSZ)');
    await refreshEden();
    if (eden.playing && !force) return { ok: false, confirm: true, game: eden.game };
    const emu = emuFor(g);
    busy = { name: g.name, target, emu, emuLabel: EMUS[emu].label, since: Date.now() };
    try {
      await stopEden();   // un seul émulateur à la fois (une app déjà ouverte ignorerait le jeu passé en argument)
      // Si la barre affichait un jeu, le tableau de bord revient pendant le chargement
      await relay({ action: 'panel', visible: true }, 4000);
      const r = await sh('/usr/bin/open', ['-a', EMUS[emu].app, '--args', ...EMUS[emu].args(g.file)], 15000);
      if (!r.ok) throw new Error(`${EMUS[emu].label} ne démarre pas`);
      // On attend la fenêtre du jeu (titre avec le nom du jeu), 40 s au plus
      for (let i = 0; i < 80; i++) {
        await new Promise((res) => setTimeout(res, 500));
        await refreshEden();
        if (eden.playing) break;
      }
      if (target === 'bar' || target === 'main') {
        placing = true;
        let p;
        try { p = await relay({ action: 'eden', target }, 20000); } finally { placing = false; }
        if (!p.ok) return { ok: true, placed: false, error: p.error };
      }
      return { ok: true, placed: true };
    } finally {
      busy = null;
      await refreshEden();
      seen = eden.playing ? eden.game : null;   // déjà placé comme demandé : watch() n'y touche plus
      wasOnBar = eden.playing && eden.onBar;
    }
  }

  async function place(target) {
    placing = true;
    let p;
    try { p = await relay({ action: 'eden', target }, 20000); } finally { placing = false; }
    await refreshEden();
    if (!p.ok) throw new Error({ accessibilite: 'Autorise BarreTouch dans Réglages › Accessibilité', 'eden-ferme': 'Aucun émulateur ouvert', fenetre: 'Fenêtre de l’émulateur introuvable', 'barre-absente': 'Barre non détectée', barretouch: 'BarreTouch ne répond pas' }[p.error] || 'Déplacement impossible');
    return { ok: true };
  }

  // Bouton « Changer de jeu » : l'accueil de la Switch par-dessus le jeu, qui continue derrière.
  async function home() {
    await relay({ action: 'panel', visible: true }, 4000);
    await refreshEden();
    return { ok: true };
  }

  // « Reprendre » : retour au jeu sur la barre (le replace s'il n'y est plus).
  async function resume() {
    await refreshEden();
    if (!eden.playing) throw new Error('Aucun jeu en cours');
    if (eden.onBar) await relay({ action: 'panel', visible: false }, 4000);
    else return place('bar');
    await refreshEden();
    return { ok: true };
  }

  async function quit() {
    await relay({ action: 'panel', visible: true }, 4000);
    await stopEden();
    await refreshEden();
    return { ok: true };
  }

  function decompress(id) {
    const g = find(id);
    if (!g || !g.compressed) throw new Error('Jeu introuvable');
    if (decomp) throw new Error('Une décompression est déjà en cours');
    if (!fs.existsSync(DECOMP)) throw new Error('Outil decompresser-nsz absent');
    const out = g.file.replace(/\.nsz$/i, '.nsp').replace(/\.xcz$/i, '.xci');
    const m = path.basename(g.file).match(/\((\d+(?:[.,]\d+)?)\s*GB\)/i);
    decomp = { name: g.name, started: Date.now(), out, expected: m ? Math.round(parseFloat(m[1].replace(',', '.')) * 1e9) : null };
    const child = spawn(DECOMP, [g.file], { stdio: 'ignore' });
    child.on('exit', (code) => {
      lastDecomp = { name: decomp.name, ok: code === 0, at: Date.now() };
      decomp = null;
      scan(true);
    });
    return { ok: true };
  }

  function setEmu(id, emu) {
    const g = find(id);
    if (!g) throw new Error('Jeu introuvable');
    if (!EMUS[emu] || !fs.existsSync(EMUS[emu].app)) throw new Error('Émulateur absent');
    emuPref[g.titleId || g.file] = emu;
    try { fs.writeFileSync(emuFile, JSON.stringify(emuPref, null, 1)); } catch { /* préférence non mémorisée */ }
    return { ok: true, emu };
  }

  async function iconPath(tid) {
    if (!/^[0-9A-F]{16}$/.test(tid)) return null;
    const p = path.join(iconDir, tid + '.jpg');
    return fs.existsSync(p) ? p : null;
  }

  return { refresh, etat, scan, launch, place, home, resume, quit, decompress, setEmu, iconPath, refreshEden, watch };
}
