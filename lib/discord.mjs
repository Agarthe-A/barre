// Page « Discord » de la barre : la mosaïque des flux (Go Live) d'un salon vocal.
//
// Discord n'expose pas ses flux vidéo, mais sait détacher chaque stream dans sa propre fenêtre
// (« Stream de <pseudo> »), ou la fenêtre de l'appel entière. BarreTouch capture ces fenêtres
// (ScreenCaptureKit), y repère les vidéos et les redispose sur la barre (touch/mosaic.swift).
// Ici : l'état pour la page, le choix des fenêtres (par défaut toutes les fenêtres de stream et
// d'appel, et chaque nouveau stream détaché rejoint la mosaïque tout seul), démarrage et arrêt.
// Rien n'est jamais envoyé à Discord : on ne fait que regarder ses fenêtres.

const MESSAGES = {
  'capture-permission': 'Autorise BarreTouch dans Réglages › Confidentialité et sécurité › Enregistrement de l’écran (elle redémarre ensuite toute seule)',
  'barre-absente': 'Barre non détectée',
  fenetre: 'Fenêtre Discord introuvable (fermée ?)',
  capture: 'La capture n’a pas démarré',
  fermee: 'La fenêtre Discord a été fermée',
  barretouch: 'BarreTouch ne répond pas'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function creerDiscord({ token, relayPort = 4748, rpc = null }) {
  let st = { ok: false, error: 'chargement' };
  let starting = null;      // { since, titles } pendant un démarrage
  let auto = true;          // démarrée sans choix : toute nouvelle fenêtre de stream rejoint la mosaïque
  let adding = new Set();   // fenêtres en cours d'ajout automatique
  const excluded = new Map(); // pseudo → date : stream retiré depuis la barre, pas réajouté tout seul pendant 15 s
  const streamUser = (title) => String(title || '').replace(/^Stream (de|from) /, '');

  const rpcEtat = () => (rpc ? rpc.etat() : null);
  async function relay(body, timeout = 6000) {
    try {
      // Quand la liaison RPC donne la voix et les avatars, BarreTouch n'a plus besoin de lire l'image de Discord
      if (body.op === 'status') { const r = rpcEtat(); body = { ...body, shots: !(r && r.ok) }; }
      const r = await fetch(`http://127.0.0.1:${relayPort}/window`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'discord', ...body }),
        signal: AbortSignal.timeout(timeout)
      });
      return await r.json();
    } catch {
      return { ok: false, error: 'barretouch' };
    }
  }

  // Fenêtres à afficher = toutes les fenêtres Discord sauf la principale (streams détachés, appel détaché).
  const candidates = (windows) => (windows || []).filter((w) => !w.main);

  async function refresh() {
    const s = await relay({ op: 'status' }, 4000);
    if (!s.ok) {
      st = { ok: false, error: s.error === 'barretouch' ? 'barretouch' : 'erreur', detail: s.error, active: false };
      return st;
    }
    const windows = s.windows || [];
    if (s.active && (s.sources || []).some((x) => x.live)) starting = null;
    st = {
      ok: true,
      running: !!s.running,
      permission: !!s.permission,
      windows,
      auto,
      active: !!s.active,
      sources: s.sources || [],
      title: s.title || '',
      count: s.count || 0,
      focus: typeof s.focus === 'number' ? s.focus : -1,
      mode: s.mode || 'grid',
      fps: s.fps || 0,
      since: s.since || null,
      hole: s.hole || null,
      tiles: s.tiles || [],
      error: s.error || null,
      message: s.error ? (MESSAGES[s.error] || s.error) : null,
      starting: starting && Date.now() - starting.since < 10000 ? starting : null,
      // Lu dans Discord par l'accessibilité : salon, participants (pseudo, micro, EN DIRECT, jeu), streams.
      // Voir etat() : la liaison RPC, quand elle est là, remplace participants, voix et avatars.
      ax: s.ax && typeof s.ax === 'object' ? s.ax : null,
      axOk: !!s.axOk,
      voice: s.voice && typeof s.voice === 'object' ? s.voice : {},       // pseudo → { speaking, muted } (lu dans l'image de Discord)
      avatars: s.avatars && typeof s.avatars === 'object' ? s.avatars : {},   // pseudo → { key, v } (fichier data/discord-avatars/<key>.png)
      strip: s.strip || null,
      job: s.job || null
    };
    // Un stream retiré à la main reste exclu tant que la personne stream ; l'exclusion tombe quand elle arrête.
    const liveUsers = new Set(((st.ax || {}).streams || []).map((x) => x.user));
    for (const [u, t] of excluded) if (!liveUsers.has(u) && Date.now() - t > 15000) excluded.delete(u);
    // Mode automatique : un stream détaché pendant que la mosaïque tourne la rejoint tout seul.
    if (st.active && auto) {
      for (const w of candidates(windows)) {
        if (w.captured || adding.has(w.id)) continue;
        if (excluded.has(streamUser(w.title))) continue;
        adding.add(w.id);
        relay({ op: 'add', window: w.id }).finally(() => setTimeout(() => adding.delete(w.id), 5000));
      }
    }
    return st;
  }

  async function start(ids) {
    await refresh();
    if (!st.ok) throw new Error(MESSAGES.barretouch);
    const windows = st.windows || [];
    const wanted = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : ids ? [Number(ids)] : [];
    const list = wanted.length ? windows.filter((w) => wanted.includes(w.id)) : candidates(windows);
    if (!list.length) {
      if (!st.running) throw new Error('Discord n’est pas ouvert');
      throw new Error('Aucune fenêtre de stream : dans le salon, détache chaque stream (menu du stream › Fenêtre détachée) ou la fenêtre de l’appel');
    }
    auto = !wanted.length;
    starting = { since: Date.now(), titles: list.map((w) => w.title) };
    const r = await relay({ op: 'start', windows: list.map((w) => w.id) }, 8000);
    if (!r.ok) { starting = null; throw new Error(MESSAGES[r.error] || 'Capture impossible'); }
    // Les flux démarrent en arrière-plan : on attend jusqu'à 6 s la première image (ou une erreur)
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      await refresh();
      if (st.active && (st.sources || []).some((x) => x.live)) return { ok: true, titles: starting ? starting.titles : [] };
      if (!st.active && st.error) { starting = null; throw new Error(st.message || st.error); }
    }
    return { ok: true, pending: true };
  }

  async function add(id) {
    const r = await relay({ op: 'add', window: Number(id) }, 8000);
    if (!r.ok) throw new Error(MESSAGES[r.error] || 'Ajout impossible');
    await refresh();
    return r;
  }

  async function remove(id) {
    const r = await relay({ op: 'remove', window: Number(id) }, 8000);
    if (!r.ok) throw new Error(MESSAGES[r.error] || 'Retrait impossible');
    auto = false;   // un retrait à la main : on ne rajoute plus tout seul
    await refresh();
    return r;
  }

  // Depuis la barre : BarreTouch détache le stream du pseudo dans Discord, appuie sur « Regarder le
  // stream » et le capture. On attend la fin de l'opération (jusqu'à 15 s).
  async function watch(user) {
    const u = String(user || '').trim();
    if (!u) throw new Error('Pseudo manquant');
    excluded.delete(u);
    auto = false;   // choix stream par stream : rien ne s'ajoute tout seul
    const r = await relay({ op: 'watch', user: u }, 8000);
    if (!r.ok) throw new Error({ occupe: 'Une autre demande est en cours', accessibilite: 'Autorise BarreTouch dans Réglages › Accessibilité' }[r.error] || MESSAGES[r.error] || 'Impossible');
    for (let i = 0; i < 50; i++) {
      await sleep(300);
      await refresh();
      if (!st.job) {
        if (st.error && (st.sources || []).every((x) => streamUser(x.title) !== u)) {
          throw new Error({ vignette: `Stream de ${u} introuvable dans l’appel`, menu: 'Menu de la vignette inaccessible', 'menu-detacher': 'Pas de « fenêtre séparée » dans le menu' }[st.error] || st.message || st.error);
        }
        return { ok: true, user: u };
      }
    }
    return { ok: true, pending: true, user: u };
  }

  async function unwatch(user) {
    const u = String(user || '').trim();
    if (!u) throw new Error('Pseudo manquant');
    excluded.set(u, Date.now());
    const r = await relay({ op: 'unwatch', user: u }, 8000);
    if (!r.ok) throw new Error(r.error === 'fermeture' ? 'Fenêtre du stream non fermée' : MESSAGES[r.error] || 'Impossible');
    await refresh();
    return { ok: true, user: u };
  }

  async function stop() {
    starting = null;
    const r = await relay({ op: 'stop' }, 6000);
    if (!r.ok) throw new Error(MESSAGES[r.error] || 'Arrêt impossible');
    await refresh();
    return { ok: true };
  }

  async function focus(index) {
    const r = await relay({ op: 'focus', index: Number.isInteger(index) ? index : -1 });
    if (!r.ok) throw new Error(MESSAGES[r.error] || 'Impossible');
    await refresh();
    return r;
  }

  async function mode(m) {
    const r = await relay({ op: 'mode', mode: m === 'whole' ? 'whole' : 'grid' });
    if (!r.ok) throw new Error(MESSAGES[r.error] || 'Impossible');
    await refresh();
    return r;
  }

  async function rescan() {
    const r = await relay({ op: 'rescan' });
    if (!r.ok) throw new Error(MESSAGES[r.error] || 'Impossible');
    return r;
  }

  async function snapshot() {
    const r = await relay({ op: 'snapshot' }, 15000);
    if (!r.ok) throw new Error(r.error === 'barretouch' ? MESSAGES.barretouch : (r.error || 'Impossible'));
    return r;
  }

  // État pour la page : la liaison RPC (temps réel) fournit salon, participants, micros, qui parle et
  // avatars ; l'accessibilité complète avec « EN DIRECT », le jeu joué et les streams.
  function etat() {
    const r = rpcEtat();
    if (!r) return st;
    const axP = ((st.ax || {}).participants || []);
    const byName = (n) => axP.find((p) => p.name === n);
    const members = r.members || [];
    const participants = members.map((m) => {
      const a = byName(m.name) || byName(m.user);
      return { id: m.id, name: m.name, user: m.user, live: !!(a && a.live), game: a ? a.game : null, muted: m.muted, deaf: m.deaf, speaking: m.speaking, volume: m.volume, localMute: m.localMute };
    });
    const rpcInfo = { ok: r.ok, error: r.error, channel: r.channel ? r.channel.name : null, me: r.me ? r.me.name : null, meUser: r.me ? r.me.user : null, since: r.since, self: r.self || null };
    if (!r.ok) return { ...st, rpc: rpcInfo };
    return {
      ...st,
      rpc: rpcInfo,
      ax: { ...(st.ax || {}), channel: r.channel ? r.channel.name : null, participants: r.channel ? participants : [] },
      voice: Object.fromEntries(members.map((m) => [m.name, { speaking: m.speaking, muted: m.muted, deaf: m.deaf }])),
      avatars: Object.fromEntries(members.filter((m) => m.avatar).map((m) => [m.name, m.avatar]))
    };
  }

  // Nouveau stream dans le salon → sur la barre tout seul (sauf retiré à la main, tant qu'il dure).
  // `canStart` : la barre est libre (pas de jeu) ; sinon on n'ajoute que si la mosaïque tourne déjà.
  const autoTried = new Map();   // pseudo → date du dernier essai
  async function autoStreams(canStart) {
    const d = etat();
    if (!d.ok || !d.rpc || !d.rpc.ok || !d.rpc.channel) return null;
    const me = d.rpc.meUser;
    const onBar = new Set((d.sources || []).filter((x) => x.live).map((x) => streamUser(x.title)));
    for (const x of (d.ax && d.ax.streams) || []) {
      if (x.own || x.user === me || onBar.has(x.user)) continue;
      if (excluded.has(x.user)) continue;
      if (d.job) return null;
      if (!d.active && !canStart) return null;
      const t = autoTried.get(x.user);
      if (t && Date.now() - t < 60000) continue;
      autoTried.set(x.user, Date.now());
      try { await watch(x.user); return x; } catch { return null; }
    }
    return null;
  }

  async function self(body) { if (!rpc) throw new Error('liaison Discord absente'); return rpc.setSelf(body || {}); }
  async function user(body) { if (!rpc) throw new Error('liaison Discord absente'); if (!body || !body.id) throw new Error('participant manquant'); return rpc.setUser(body.id, body); }

  return { refresh, etat, start, add, remove, watch, unwatch, stop, focus, mode, rescan, snapshot, autoStreams, self, user };
}
