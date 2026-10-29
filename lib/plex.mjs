// Page « Plex » de la barre : regarder sa médiathèque sur la barre.
//
// Le serveur Plex tourne sur le Mac lui-même (jeton lu dans ses réglages, comme pour la page Serveur).
// La page montre « Reprendre » (On Deck) et les nouveautés ; un appui lance la lecture dans la page
// (HLS transcodé par Plex, lu nativement par WebKit sur la barre), le son sort du Mac. Le serveur
// fait relais vers Plex avec le jeton : la page ne le voit jamais (/api/plex/p/… et /api/plex/img).
// La position est renvoyée à Plex pendant la lecture (/:/timeline) : « Reprendre » reste juste.

import crypto from 'node:crypto';
import { run } from './sources.mjs';

export const PLEX_CLIENT = {
  'X-Plex-Client-Identifier': 'barre-mac-mini',
  'X-Plex-Product': 'Barre',
  'X-Plex-Version': '1.0',
  'X-Plex-Platform': 'Safari',
  'X-Plex-Platform-Version': '17.0',
  'X-Plex-Device': 'Mac',
  'X-Plex-Device-Name': 'Barre',
  'X-Plex-Model': 'bundled'
};

export function creerPlex({ cfg = {}, log = () => {} }) {
  const base = (cfg.url || 'http://127.0.0.1:32400').replace(/\/$/, '');
  let token = null;
  let st = { ok: false, error: 'chargement', onDeck: [], recent: [], updatedAt: null };
  let playing = null;   // { key, title, state, time, duration, session, since } pendant une lecture
  // Sessions de lecture connues : le lecteur vidéo de WebKit ne renvoie ni cookie ni paramètre aux
  // sous-requêtes HLS, donc l'identifiant de session (aléatoire) dans le chemin tient lieu de jeton.
  const sessions = new Map();   // session → expiration
  const sessionOk = (id) => { const e = sessions.get(id); if (!e) return false; if (Date.now() > e) { sessions.delete(id); return false; } return true; };

  async function tok() {
    if (token) return token;
    if (cfg.token) { token = cfg.token; return token; }
    const r = await run('defaults', ['read', 'com.plexapp.plexmediaserver', 'PlexOnlineToken'], { timeout: 3000 });
    token = r.ok ? r.out.trim() : null;
    return token;
  }

  /// Adresse Plex complète (avec jeton) pour un chemin relatif, paramètres ajoutés.
  async function url(p, params = {}) {
    const t = await tok();
    if (!t) throw new Error('jeton Plex introuvable (Plex Media Server tourne sur ce Mac ?)');
    const u = new URL(p, base + '/');
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    u.searchParams.set('X-Plex-Token', t);
    return u;
  }

  async function get(p, params) {
    const u = await url(p, params);
    const r = await fetch(u, { headers: { ...PLEX_CLIENT, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Plex ${r.status}`);
    return (await r.json()).MediaContainer || {};
  }

  // Fiche courte d'un élément (film ou épisode), ce qu'il faut pour l'afficher et le lancer.
  function item(m) {
    const media = (m.Media || [])[0] || {};
    const part = (media.Part || [])[0] || {};
    return {
      key: String(m.ratingKey || ''),
      type: m.type,
      title: m.title || '',
      show: m.grandparentTitle || null,
      season: m.parentIndex ?? null,
      episode: m.index ?? null,
      year: m.year || (m.parentYear ?? null),
      thumb: m.type === 'episode' ? (m.grandparentThumb || m.thumb || m.parentThumb || null) : (m.thumb || null),
      art: m.art || m.grandparentArt || null,
      duration: m.duration || 0,
      viewOffset: m.viewOffset || 0,
      viewCount: m.viewCount || 0,
      summary: String(m.summary || '').slice(0, 300),
      resolution: media.videoResolution || null,
      container: part.container || null,
      addedAt: (m.addedAt || 0) * 1000,
      lastViewedAt: (m.lastViewedAt || 0) * 1000,
      partId: part.id || null
    };
  }

  // Pistes audio et sous-titres d'un média (celles que Plex a sélectionnées sont marquées).
  const LANG = { fra: 'Français', fre: 'Français', eng: 'Anglais', jpn: 'Japonais', spa: 'Espagnol', ger: 'Allemand', deu: 'Allemand', ita: 'Italien', por: 'Portugais', kor: 'Coréen', chi: 'Chinois', zho: 'Chinois', rus: 'Russe', ara: 'Arabe', hin: 'Hindi', tur: 'Turc', pol: 'Polonais', nld: 'Néerlandais', dut: 'Néerlandais', swe: 'Suédois', dan: 'Danois', nor: 'Norvégien', fin: 'Finnois', tha: 'Thaï', vie: 'Vietnamien', und: '' };
  function tracks(m) {
    const part = ((m.Media || [])[0] || {}).Part || [];
    const out = [];
    for (const s of (part[0] || {}).Stream || []) {
      if (s.streamType !== 2 && s.streamType !== 3) continue;
      const lang = LANG[s.languageCode] ?? s.language ?? '';
      const label = s.streamType === 2
        ? [lang || s.language || 'Piste', s.title && !/^\w{2,3}$/.test(s.title) ? s.title : null, s.channels ? `${s.channels > 2 ? s.channels + '.0' : s.channels === 2 ? 'stéréo' : 'mono'}` : null].filter(Boolean).join(' · ')
        : [lang || s.language || 'Sous-titres', s.forced ? 'forcés' : null, s.title && !/^\w{2,3}$/.test(s.title) ? s.title : null, s.codec === 'pgs' ? 'image' : null].filter(Boolean).join(' · ');
      out.push({ id: s.id, type: s.streamType === 2 ? 'audio' : 'sub', label, lang: s.languageCode || '', selected: !!s.selected, forced: !!s.forced, codec: s.codec || '' });
    }
    return out;
  }

  async function refresh() {
    try {
      const deck = await get('/library/onDeck');
      const onDeck = (deck.Metadata || []).filter((m) => m.type === 'movie' || m.type === 'episode').map(item);
      const sections = cfg.recentSections && cfg.recentSections.length ? cfg.recentSections : [''];
      const lists = await Promise.all(sections.map((k) =>
        get(k ? `/library/sections/${k}/recentlyAdded` : '/library/recentlyAdded', { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 30 }).catch(() => ({}))));
      const seen = new Set();
      let recent = [];
      for (const l of lists) {
        for (const m of l.Metadata || []) {
          if (m.type === 'season' || m.type === 'show') {
            // Une saison ajoutée : on propose son premier épisode non vu
            try {
              const eps = await get(`/library/metadata/${m.ratingKey}/${m.type === 'show' ? 'allLeaves' : 'children'}`, { 'X-Plex-Container-Size': 60 });
              const first = (eps.Metadata || []).find((e) => e.type === 'episode' && !e.viewCount) || (eps.Metadata || []).find((e) => e.type === 'episode');
              if (first && !seen.has(first.ratingKey)) { seen.add(first.ratingKey); recent.push({ ...item(first), addedAt: (m.addedAt || 0) * 1000, group: m.type === 'show' ? m.title : m.parentTitle, count: m.leafCount || null }); }
            } catch { /* saison illisible */ }
          } else if ((m.type === 'movie' || m.type === 'episode') && !seen.has(m.ratingKey)) {
            seen.add(m.ratingKey);
            recent.push(item(m));
          }
        }
      }
      recent.sort((a, b) => b.addedAt - a.addedAt);
      // Les épisodes d'une même série ne sont montrés qu'une fois (le plus récent)
      const shows = new Set();
      recent = recent.filter((x) => { if (!x.show) return true; if (shows.has(x.show)) return false; shows.add(x.show); return true; }).slice(0, 18);
      st = { ok: true, error: null, onDeck: onDeck.slice(0, 12), recent, updatedAt: Date.now() };
    } catch (err) {
      st = { ...st, ok: false, error: /jeton/.test(err.message) ? 'config' : err.message };
    }
    return etat();
  }

  function etat() {
    return { ...st, playing: playing ? { key: playing.key, title: playing.title, state: playing.state, time: playing.time, duration: playing.duration, since: playing.since } : null };
  }

  // Lancement : une session de transcodage HLS (profil Safari, lecteur natif de WebKit), reprise à `offset` secondes.
  async function play(key, offset = 0) {
    const meta = await get(`/library/metadata/${key}`);
    const m = (meta.Metadata || [])[0];
    if (!m) throw new Error('élément Plex introuvable');
    const it = item(m);
    const tr = tracks(m);
    const session = crypto.randomUUID();
    const params = {
      path: `/library/metadata/${key}`, mediaIndex: 0, partIndex: 0, protocol: 'hls', fastSeek: 1,
      directPlay: 0, directStream: 1, directStreamAudio: 1, subtitleSize: 100, audioBoost: 100, location: 'lan',
      // Sous-titre choisi : incrusté dans l'image par le transcodeur (lisible partout, rien à gérer côté lecteur)
      subtitles: tr.some((t) => t.type === 'sub' && t.selected) ? 'burn' : 'none',
      autoAdjustQuality: 0, mediaBufferSize: 102400, session, offset: Math.max(0, Math.floor(offset)),
      videoQuality: 100, videoResolution: '1920x1080', maxVideoBitrate: 12000,
      'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac&subtitleCodec=webvtt)',
      ...PLEX_CLIENT
    };
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    playing = { key: String(key), title: it.show ? `${it.show} · ${it.title}` : it.title, state: 'playing', time: offset * 1000, duration: it.duration, session, since: Date.now() };
    sessions.set(session, Date.now() + 8 * 3600000);
    log(`Plex : lecture de « ${playing.title} » (session ${session.slice(0, 8)}, reprise à ${Math.floor(offset)} s)`);
    return { ok: true, item: it, tracks: tr, session, src: `/api/plex/hls/${session}/video/:/transcode/universal/start.m3u8?${q.toString()}` };
  }

  // Épisodes de la saison d'un épisode (liste de gauche du lecteur, enchaînement automatique).
  async function episodes(key) {
    const meta = await get(`/library/metadata/${key}`);
    const m = (meta.Metadata || [])[0];
    if (!m || m.type !== 'episode' || !m.parentRatingKey) return { ok: true, season: null, episodes: [] };
    const kids = await get(`/library/metadata/${m.parentRatingKey}/children`, { 'X-Plex-Container-Size': 200 });
    const list = (kids.Metadata || []).filter((e) => e.type === 'episode').map((e) => ({
      key: String(e.ratingKey), index: e.index ?? null, title: e.title || '', duration: e.duration || 0,
      viewOffset: e.viewOffset || 0, viewCount: e.viewCount || 0, thumb: e.thumb || null
    }));
    list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return { ok: true, season: { key: String(m.parentRatingKey), title: m.parentTitle || '', index: m.parentIndex ?? null, show: m.grandparentTitle || '' }, episodes: list };
  }

  // Choix de la piste audio ou du sous-titre (0 = aucun) : mémorisé par Plex pour ce média, la lecture
  // suivante en tient compte (la page relance la session HLS à la même position).
  async function select(key, { audio, subtitle }) {
    const meta = await get(`/library/metadata/${key}`);
    const m = (meta.Metadata || [])[0];
    const part = (((m || {}).Media || [])[0] || {}).Part || [];
    const partId = (part[0] || {}).id;
    if (!partId) throw new Error('média Plex introuvable');
    const params = { allParts: 1 };
    if (audio !== undefined && audio !== null) params.audioStreamID = Number(audio);
    if (subtitle !== undefined && subtitle !== null) params.subtitleStreamID = Number(subtitle);
    const u = await url(`/library/parts/${partId}`, params);
    const r = await fetch(u, { method: 'PUT', headers: PLEX_CLIENT, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Plex ${r.status}`);
    const again = await get(`/library/metadata/${key}`);
    return { ok: true, tracks: tracks((again.Metadata || [])[0] || {}) };
  }

  // Position renvoyée à Plex (Reprendre, vu / pas vu) ; `state` : playing | paused | stopped
  async function timeline({ key, state, time, duration, session }) {
    if (!key) throw new Error('clé manquante');
    const s = ['playing', 'paused', 'stopped'].includes(state) ? state : 'playing';
    if (playing && playing.key === String(key)) {
      playing.state = s; playing.time = Number(time) || 0; if (duration) playing.duration = Number(duration);
      if (s === 'stopped') playing = null;
    }
    const u = await url('/:/timeline', {
      ratingKey: key, key: `/library/metadata/${key}`, state: s, time: Math.floor(Number(time) || 0), duration: Math.floor(Number(duration) || 0),
      hasMDE: 1, ...PLEX_CLIENT
    });
    const r = await fetch(u, { headers: PLEX_CLIENT, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (s === 'stopped' && session) {
      sessions.delete(String(session));
      const stop = await url('/video/:/transcode/universal/stop', { session });
      fetch(stop, { headers: PLEX_CLIENT, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    return { ok: !!(r && r.ok) };
  }

  // Relais vers Plex (vidéo HLS, images) : chemin relatif autorisé seulement, jeton ajouté ici.
  const ALLOWED = ['video/:/transcode/universal/', 'photo/:/transcode', 'library/parts/'];
  async function proxyUrl(rest, search) {
    if (!ALLOWED.some((a) => rest.startsWith(a))) throw new Error('chemin Plex refusé');
    const u = await url(rest);
    for (const [k, v] of search) u.searchParams.set(k, v);
    return u;
  }

  async function imageUrl(p, w = 300, h = 450) {
    if (!/^\/[\w\-/:.%]+$/.test(p)) throw new Error('image refusée');
    return url('/photo/:/transcode', { url: p, width: w, height: h, minSize: 1, upscale: 1 });
  }

  return { refresh, etat, play, select, episodes, timeline, proxyUrl, imageUrl, headers: PLEX_CLIENT, playingNow: () => playing, sessionOk };
}
