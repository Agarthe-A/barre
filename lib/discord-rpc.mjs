// Liaison avec le client Discord par son API locale (RPC, socket Unix $TMPDIR/discord-ipc-N),
// celle qu'utilisent le Stream Deck et compagnie. Elle donne en temps réel, par événements :
// le salon vocal rejoint, ses participants (pseudo de serveur, avatar), micro et casque coupés,
// et qui parle (SPEAKING_START / SPEAKING_STOP). Rien n'est sondé, rien n'est capturé à l'écran.
//
// Il faut une « application » Discord créée par l'utilisateur (discord.com/developers) :
//   config.json → "discord": { "clientId": "…", "clientSecret": "…" }
// Au premier démarrage, Discord affiche une fenêtre d'autorisation (scopes rpc, rpc.voice.read) ;
// le jeton obtenu est gardé dans data/discord-rpc.json (mode 600) et renouvelé tout seul.
// Le scope rpc est réservé aux applications approuvées par Discord, sauf pour leur propriétaire :
// c'est le cas ici (l'application est celle de l'utilisateur).
// Aucune dépendance : Node 18+ (fetch, net, crypto).

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write'];
const VOICE_EVENTS = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'];

function encode(op, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

// Dossiers où le client pose sa socket (TMPDIR du bureau, pas forcément celui d'un service launchd)
async function socketDirs() {
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
  add(process.env.TMPDIR);
  await new Promise((resolve) => execFile('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], (err, out) => { if (!err) add(String(out).trim()); resolve(); }));
  add(process.env.XDG_RUNTIME_DIR);
  add(os.tmpdir());
  add('/tmp');
  const out = [];
  for (const d of dirs) { out.push(d); out.push(path.join(d, 'app', 'com.discordapp.Discord')); }
  return out;
}

export function creerDiscordRpc({ clientId, clientSecret, dataDir, onChange = () => {}, log = () => {} }) {
  const tokenFile = path.join(dataDir, 'discord-rpc.json');
  const avatarDir = path.join(dataDir, 'discord-avatars');
  let sock = null;
  let buf = Buffer.alloc(0);
  let pending = new Map();      // nonce → { resolve, reject }
  let stopped = false;
  let retryMs = 2000;
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { tokens = {}; }
  const st = {
    ok: false,                  // liaison prête (authentifiée)
    error: null,                // 'config' | 'discord-ferme' | 'autorisation' | 'jeton' | texte
    me: null,                   // { id, name }
    channel: null,              // { id, name, guildId }
    self: null,                 // { mute, deaf, volume } : réglages voix de l'utilisateur
    members: {},                // id → { id, name, user, avatar, speaking, muted, deaf, selfMuted, selfDeaf, avatarFile }
    since: null
  };
  const avatarsFetched = new Map();   // id → hash déjà téléchargé

  function changed() { onChange(st); }

  function send(op, obj) {
    if (!sock || sock.destroyed) return;
    sock.write(encode(op, obj));
  }

  function request(cmd, args = {}, evt) {
    return new Promise((resolve, reject) => {
      const nonce = crypto.randomUUID();
      pending.set(nonce, { resolve, reject, at: Date.now() });
      const msg = { cmd, args, nonce };
      if (evt) msg.evt = evt;
      send(OP.FRAME, msg);
      setTimeout(() => { if (pending.has(nonce)) { pending.delete(nonce); reject(new Error(`${cmd} : pas de réponse`)); } }, cmd === 'AUTHORIZE' ? 120000 : 15000);
    });
  }

  async function connect() {
    if (stopped) return;
    for (const dir of await socketDirs()) {
      for (let i = 0; i < 10; i++) {
        const p = path.join(dir, `discord-ipc-${i}`);
        if (!fs.existsSync(p)) continue;
        const ok = await new Promise((resolve) => {
          const s = net.createConnection(p);
          s.once('connect', () => resolve(s));
          s.once('error', () => resolve(null));
        });
        if (ok) { attach(ok, p); return; }
      }
    }
    st.ok = false;
    st.error = 'discord-ferme';
    changed();
    scheduleRetry();
  }

  function scheduleRetry() {
    if (stopped) return;
    setTimeout(connect, retryMs);
    retryMs = Math.min(30000, retryMs * 1.5);
  }

  function attach(s, p) {
    sock = s;
    buf = Buffer.alloc(0);
    log(`RPC Discord : socket ${p}`);
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); drain(); });
    s.on('close', () => {
      if (sock !== s) return;
      sock = null;
      for (const [, w] of pending) w.reject(new Error('liaison fermée'));
      pending = new Map();
      if (st.ok) log('RPC Discord : liaison fermée (Discord redémarre ?)');
      st.ok = false;
      st.error = st.error || 'discord-ferme';
      st.channel = null;
      st.members = {};
      changed();
      scheduleRetry();
    });
    s.on('error', () => { /* close suit */ });
    send(OP.HANDSHAKE, { v: 1, client_id: clientId });
  }

  function drain() {
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0);
      const len = buf.readInt32LE(4);
      if (buf.length < 8 + len) return;
      const body = buf.subarray(8, 8 + len).toString('utf8');
      buf = buf.subarray(8 + len);
      let j = null;
      try { j = JSON.parse(body); } catch { continue; }
      if (op === OP.PING) { send(OP.PONG, j); continue; }
      if (op === OP.CLOSE) { log(`RPC Discord : fermeture demandée (${j && j.message})`); sock && sock.destroy(); continue; }
      if (op !== OP.FRAME) continue;
      handle(j);
    }
  }

  function handle(j) {
    if (j.nonce && pending.has(j.nonce)) {
      const w = pending.get(j.nonce);
      pending.delete(j.nonce);
      if (j.evt === 'ERROR') w.reject(Object.assign(new Error(j.data && j.data.message || 'erreur RPC'), { code: j.data && j.data.code }));
      else w.resolve(j.data);
      return;
    }
    if (j.cmd !== 'DISPATCH') return;
    const d = j.data || {};
    switch (j.evt) {
      case 'READY':
        retryMs = 2000;
        st.me = d.user ? { id: d.user.id, name: d.user.global_name || d.user.username, user: d.user.username || '' } : null;
        authenticate().catch((e) => { log(`RPC Discord : ${e.message}`); st.ok = false; st.error = st.error || e.message; changed(); });
        break;
      case 'VOICE_SETTINGS_UPDATE':
        st.self = { mute: !!d.mute, deaf: !!d.deaf, volume: d.output && typeof d.output.volume === 'number' ? Math.round(d.output.volume) : null };
        changed();
        break;
      case 'VOICE_CHANNEL_SELECT':
        if (d.channel_id) loadChannel(d.channel_id).catch(() => {});
        else { unsubscribeAll(); st.channel = null; st.members = {}; changed(); }
        break;
      case 'VOICE_STATE_CREATE':
      case 'VOICE_STATE_UPDATE':
        upsert(d);
        changed();
        break;
      case 'VOICE_STATE_DELETE':
        if (d.user && st.members[d.user.id]) { delete st.members[d.user.id]; changed(); }
        break;
      case 'SPEAKING_START':
      case 'SPEAKING_STOP': {
        const m = st.members[d.user_id];
        if (m) { m.speaking = j.evt === 'SPEAKING_START'; changed(); }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- OAuth2

  async function tokenRequest(form) {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form }).toString(),
      signal: AbortSignal.timeout(15000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`jeton refusé (${r.status}${j.error ? ' ' + j.error : ''}${j.error_description ? ' : ' + j.error_description : ''})`);
    tokens = { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in || 604800) * 1000 };
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
    return tokens.access;
  }

  async function authenticate() {
    let access = tokens.access;
    if (access && tokens.expires && Date.now() > tokens.expires - 3600000 && tokens.refresh) {
      try { access = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh }); } catch (e) { log(`RPC Discord : ${e.message}, nouvelle autorisation`); access = null; }
    }
    if (!access) {
      st.error = 'autorisation';
      changed();
      log('RPC Discord : autorisation demandée dans Discord (fenêtre « Barre souhaite accéder… »)');
      let auth;
      try {
        auth = await request('AUTHORIZE', { client_id: clientId, scopes: SCOPES });
      } catch (e) {
        throw new Error(/pas de réponse|declined|denied/i.test(e.message) ? 'autorisation refusée ou sans réponse dans Discord' : e.message);
      }
      try {
        access = await tokenRequest({ grant_type: 'authorization_code', code: auth.code, redirect_uri: 'http://127.0.0.1' });
      } catch (e) {
        if (!/redirect/i.test(e.message)) throw e;
        access = await tokenRequest({ grant_type: 'authorization_code', code: auth.code });
      }
    }
    let who;
    try {
      who = await request('AUTHENTICATE', { access_token: access });
    } catch (e) {
      if (/already authenticated/i.test(e.message)) { who = { scopes: SCOPES }; }   // même liaison, déjà faite
      else {
        if (e.code === 4009 || /invalid|expired|unauthorized/i.test(e.message)) {
          // Jeton périmé ou révoqué : on repart de zéro
          tokens = {};
          try { fs.unlinkSync(tokenFile); } catch { /* absent */ }
          return authenticate();
        }
        throw e;
      }
    }
    const got = (who && who.scopes) || [];
    if (SCOPES.some((sc) => !got.includes(sc))) {
      // Jeton obtenu avec moins de droits (version précédente) : nouvelle autorisation sur une liaison neuve
      // (une liaison déjà authentifiée refuse un second AUTHENTICATE)
      log(`RPC Discord : scopes ${got.join(' ')} insuffisants, nouvelle autorisation`);
      tokens = {};
      try { fs.unlinkSync(tokenFile); } catch { /* absent */ }
      retryMs = 1000;
      sock && sock.destroy();
      return;
    }
    st.ok = true;
    st.error = null;
    st.since = Date.now();
    log('RPC Discord : liaison prête');
    await request('SUBSCRIBE', {}, 'VOICE_CHANNEL_SELECT').catch(() => {});
    await request('SUBSCRIBE', {}, 'VOICE_SETTINGS_UPDATE').catch(() => {});
    const vs = await request('GET_VOICE_SETTINGS', {}).catch(() => null);
    if (vs) st.self = { mute: !!vs.mute, deaf: !!vs.deaf, volume: vs.output && typeof vs.output.volume === 'number' ? Math.round(vs.output.volume) : null };
    const ch = await request('GET_SELECTED_VOICE_CHANNEL', {}).catch(() => null);
    if (ch && ch.id) await loadChannel(ch.id, ch);
    else { st.channel = null; st.members = {}; }
    changed();
  }

  // ---------------------------------------------------------------- salon et participants

  let subscribed = null;   // id du salon dont on reçoit les événements

  async function unsubscribeAll() {
    if (!subscribed) return;
    for (const evt of VOICE_EVENTS) await request('UNSUBSCRIBE', { channel_id: subscribed }, evt).catch(() => {});
    subscribed = null;
  }

  async function loadChannel(id, known) {
    const ch = known || await request('GET_CHANNEL', { channel_id: id });
    if (!ch) return;
    await unsubscribeAll();
    st.channel = { id: ch.id, name: ch.name, guildId: ch.guild_id || null };
    st.members = {};
    for (const v of ch.voice_states || []) upsert(v);
    for (const evt of VOICE_EVENTS) await request('SUBSCRIBE', { channel_id: ch.id }, evt).catch((e) => log(`RPC Discord : ${evt} : ${e.message}`));
    subscribed = ch.id;
    changed();
  }

  function upsert(v) {
    const u = v.user || {};
    if (!u.id) return;
    const vs = v.voice_state || {};
    const prev = st.members[u.id] || { speaking: false };
    const m = {
      id: u.id,
      name: v.nick || u.global_name || u.username || u.id,
      user: u.username || '',
      speaking: prev.speaking,
      muted: !!(vs.mute || vs.self_mute || vs.suppress),
      deaf: !!(vs.deaf || vs.self_deaf),
      selfMuted: !!vs.self_mute,
      selfDeaf: !!vs.self_deaf,
      volume: typeof v.volume === 'number' ? Math.round(v.volume) : 100,   // volume pour moi (0–200)
      localMute: !!v.mute,                                                 // coupé pour moi
      avatar: u.avatar || null,
      bot: !!u.bot,
      avatarFile: prev.avatarFile || null,
      avatarV: prev.avatarV || null
    };
    st.members[u.id] = m;
    fetchAvatar(m).catch((e) => log(`RPC Discord : avatar de ${m.name} : ${e.message}`));
  }

  // Avatar (128 px) téléchargé une fois par version dans data/discord-avatars/<id>.png
  async function fetchAvatar(m) {
    const done = avatarsFetched.get(m.id);
    if (done && done.hash === (m.avatar || 'default')) {
      if (!m.avatarFile) { m.avatarFile = done.file; m.avatarV = done.v; }
      return;
    }
    avatarsFetched.set(m.id, { hash: m.avatar || 'default', file: null, v: null });
    const url = m.avatar
      ? `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(m.id) >> 22n) % 6n)}.png`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`avatar ${r.status}`);
    fs.mkdirSync(avatarDir, { recursive: true });
    const f = path.join(avatarDir, `${m.id}.png`);
    fs.writeFileSync(f + '.tmp', Buffer.from(await r.arrayBuffer()));
    fs.renameSync(f + '.tmp', f);
    const v = Date.now();
    avatarsFetched.set(m.id, { hash: m.avatar || 'default', file: f, v });
    // Le participant a pu être remplacé entre-temps (événement VOICE_STATE_UPDATE) : on vise l'objet courant
    const cur = st.members[m.id] || m;
    cur.avatarFile = f;
    cur.avatarV = v;
    changed();
  }

  function etat() {
    return {
      ok: st.ok, error: st.error, me: st.me, since: st.since,
      channel: st.channel ? { ...st.channel } : null,
      self: st.self,
      members: Object.values(st.members).filter((m) => !m.bot).map((m) => ({
        id: m.id, name: m.name, user: m.user, speaking: m.speaking, muted: m.muted, deaf: m.deaf,
        selfMuted: m.selfMuted, selfDeaf: m.selfDeaf, volume: m.volume, localMute: m.localMute,
        avatar: m.avatarFile ? { key: m.id, v: m.avatarV } : null
      }))
    };
  }

  // Commandes (scope rpc.voice.write) : mon micro / mon casque, et le volume des autres pour moi.
  async function setSelf({ mute, deaf }) {
    if (!st.ok) throw new Error('liaison Discord absente');
    const args = {};
    if (typeof mute === 'boolean') args.mute = mute;
    if (typeof deaf === 'boolean') args.deaf = deaf;
    const r = await request('SET_VOICE_SETTINGS', args);
    st.self = { mute: !!r.mute, deaf: !!r.deaf, volume: r.output && typeof r.output.volume === 'number' ? Math.round(r.output.volume) : (st.self && st.self.volume) };
    changed();
    return st.self;
  }

  async function setUser(id, { volume, mute }) {
    if (!st.ok) throw new Error('liaison Discord absente');
    const args = { user_id: String(id) };
    if (typeof volume === 'number') args.volume = Math.max(0, Math.min(200, Math.round(volume)));
    if (typeof mute === 'boolean') args.mute = mute;
    const r = await request('SET_USER_VOICE_SETTINGS', args);
    const m = st.members[String(id)];
    if (m) {
      if (typeof r.volume === 'number') m.volume = Math.round(r.volume);
      if (typeof r.mute === 'boolean') m.localMute = r.mute;
      changed();
    }
    return r;
  }

  function stop() { stopped = true; sock && sock.destroy(); }

  if (!clientId || !clientSecret) { st.error = 'config'; }
  else connect();
  return { etat, stop, setSelf, setUser };
}
