// Données fictives pour tester l'interface sans Mac (BARRE_DEMO=1).

import { squelette, normaliser } from './patrimoine.mjs';

// Patrimoine fictif (chiffres inventés, uniquement pour les captures d'écran).
export function patrimoineDemo(now = Date.now()) {
  const data = normaliser(squelette());
  const set = (id, champs) => Object.assign(data.lignes.find((l) => l.id === id), champs);
  data.comptes[0].date_ouverture = '2022-08-12';
  delete data.comptes[0]._a_remplir;
  set('pea-psp5', { quantite: 1000, pru: 38.2 });
  set('pea-wpea', { quantite: 2400, pru: 5.42 });
  set('pea-ai-nominatif', { quantite: 21, pru: 151.3, date_inscription_nominatif: '2023-03-15' });
  set('pea-ai-swing', { quantite: 33, pru: 168.9 });
  set('pea-tte', { quantite: 120, pru: 58.1 });
  set('ibkr-igln', { quantite: 60, pru: 61.4 });
  set('ibkr-gdx', { quantite: 40, pru: 55 });
  for (const l of data.lignes) delete l._a_remplir;
  data.liquidites = { pea: { EUR: 1240 }, ibkr: { EUR: 310, USD: 0 }, revolut: { EUR: 6500 } };
  data.cible = { 'Actions US': 35, Monde: 20, 'Actions Europe': 20, 'Défense': 10, Or: 10, Cash: 5 };
  const div = (date, ligne, symbole, montant) => ({ id: `op-demo-${date}`, date, compte: 'pea', sens: 'dividende', symbole, ligne, montant, devise: 'EUR' });
  data.operations = [
    div('2026-01-05', 'pea-tte', 'TTE.PA', 101.4),
    div('2026-04-01', 'pea-tte', 'TTE.PA', 102),
    div('2026-05-20', 'pea-ai-swing', 'AI.PA', 108.9),
    div('2026-05-20', 'pea-ai-nominatif', 'AI.PA', 76.23),
    div('2026-07-01', 'pea-tte', 'TTE.PA', 102),
    div('2026-10-01', 'pea-tte', 'TTE.PA', 102)
  ];
  const heure = now - 25 * 60000;
  const q = (symbole, prix, veille, devise, h = heure) => [symbole, { symbole, prix, veille, devise, heure: h, recupere_le: now }];
  const cours = Object.fromEntries([
    q('PSP5.PA', 47.86, 47.52, 'EUR'),
    q('WPEA.PA', 5.94, 5.92, 'EUR'),
    q('AI.PA', 172.36, 169.8, 'EUR'),
    q('TTE.PA', 56.42, 56.95, 'EUR'),
    q('IGLN.L', 78.12, 77.4, 'USD'),
    // cours ancien : la dernière lecture date de 5 jours
    ['GDX.L', { symbole: 'GDX.L', prix: 71.8, veille: 70.9, devise: 'USD', heure: now - 5 * 86400000, recupere_le: now - 5 * 86400000, echec: 'délai dépassé' }],
    q('EURUSD=X', 1.162, 1.158, 'USD')
  ]);
  return { data, cours };
}

export function install({ setState, broadcast, pushFeed }) {
  const now = Date.now();
  const day = (offset, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); return d.getTime(); };
  const allDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const ev = (title, start, minutes = 60, extra = {}) => ({ title, location: '', start, end: start + minutes * 60000, allDay: false, calendar: 'Perso', ...extra });

  let position = 74;
  const music = () => ({ ok: true, running: true, state: 'playing', volume: 60, id: 'demo1', title: 'Night Drive', artist: 'Les Ondes', album: 'Périphérique', duration: 236, position });

  setState({
    system: {
      cpu: 14,
      ram: { used: 29.4e9, total: 51.5e9 },
      disk: { used: 443e9, total: 494e9 },
      docker: { running: 10, total: 11 },
      containers: [
        ['plex', 'running', 'Up 3 days'], ['sonarr', 'running', 'Up 3 days'], ['radarr', 'running', 'Up 3 days'],
        ['prowlarr', 'running', 'Up 3 days'], ['qbittorrent', 'running', 'Up 3 days'], ['overseerr', 'running', 'Up 3 days'],
        ['bazarr', 'running', 'Up 3 days'], ['flaresolverr', 'running', 'Up 3 days'], ['homepage', 'running', 'Up 2 days'],
        ['hermes', 'running', 'Up 5 hours'], ['tautulli', 'exited', 'Exited (0) 2 days ago']
      ].map(([name, state, status]) => ({ name, state, status })),
      updatedAt: now
    },
    music: music(),
    reminders: {
      ok: true,
      items: [
        { id: 'r1', title: 'Relancer le recruteur Capgemini', list: 'Boulot', due: day(-1, 18), priority: 1, overdue: true },
        { id: 'r2', title: 'Envoyer la candidature Decathlon', list: 'Boulot', due: day(0, 12), priority: 0, overdue: false },
        { id: 'r3', title: 'Changer les plaquettes du vélo', list: 'Perso', due: day(2, 9), priority: 0, overdue: false },
        { id: 'r4', title: 'Prendre rendez-vous kiné', list: 'Perso', due: null, priority: 0, overdue: false },
        { id: 'r5', title: 'Payer la facture Free', list: 'Perso', due: day(4, 9), priority: 0, overdue: false }
      ]
    },
    calendar: {
      ok: true,
      events: [
        ev('Footing Z2 · 45 min', day(0, 8, 30), 45),
        ev('Point avec Thomas', day(0, 11), 30, { location: 'Visio' }),
        ev('Déjeuner papa', day(0, 13), 90),
        ev('Fractionné 6×800', day(1, 18, 30), 60),
        { title: 'Anniversaire Léa', location: '', start: allDay(2), end: allDay(3), allDay: true, calendar: 'Perso' },
        ev('Entretien Decathlon', day(2, 10), 60),
        ev('Home trainer sweet spot', day(3, 19), 75),
        ev('Sortie longue 16 km', day(5, 9), 100),
        ev('Vélo · sortie club', day(6, 8), 180),
        ev('Ciné', day(6, 20, 30), 150)
      ]
    },
    plex: {
      ok: true,
      sessions: [{ title: 'Severance · Hello, Ms. Cobel', user: 'julian', state: 'playing', progress: 42 }],
      recent: [
        { title: 'Dune : Deuxième partie', type: 'movie', addedAt: now - 3 * 3600e3 },
        { title: 'The Bear · Saison 3', type: 'season', addedAt: now - 26 * 3600e3 },
        { title: 'Shogun · Saison 1', type: 'season', addedAt: now - 50 * 3600e3 },
        { title: 'Le Comte de Monte-Cristo', type: 'movie', addedAt: now - 72 * 3600e3 }
      ]
    },
    hue: {
      ok: true,
      rooms: [
        { id: 'a', name: 'Salon', on: true, brightness: 72 },
        { id: 'b', name: 'Bureau', on: true, brightness: 100 },
        { id: 'c', name: 'Chambre', on: false, brightness: 0 },
        { id: 'd', name: 'Cuisine', on: false, brightness: 0 },
        { id: 'e', name: 'Entrée', on: false, brightness: 0 }
      ]
    },
    priorities: {
      date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(),
      generatedAt: day(0, 7),
      items: [
        { text: 'Relancer le recruteur Capgemini avant midi', done: true },
        { text: 'Finaliser et envoyer la candidature Decathlon', done: false },
        { text: 'Footing Z2 45 min, garder le cardio bas', done: false }
      ]
    },
    sessions: [
      { id: 's1', project: 'barre-dashboard', status: 'running', text: 'Ajoute la page Musique', updatedAt: now - 60e3 },
      { id: 's2', project: 'homelab', status: 'done', text: 'Réponse terminée', updatedAt: now - 40 * 60e3 },
      { id: 's3', project: 'hermes', status: 'idle', text: 'Session ouverte', updatedAt: now - 2 * 3600e3 }
    ],
    patrimoine: patrimoineDemo(now)
  });
  pushFeed('Brief prêt : 3 mails importants, 1 entretien demain', 'hermes');
  pushFeed('Autorisé · homelab · docker compose up -d', 'claude');
  pushFeed('Priorités du jour prêtes (auto)', 'claude');
  broadcast(true);

  setInterval(() => {
    position = (position + 3) % 236;
    setState({ music: music() });
    broadcast();
  }, 3000);
}
