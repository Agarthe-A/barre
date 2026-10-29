# Barre — tableau de bord tactile du Mac mini

Un tableau de bord pour une barre tactile Wisecoco 12,3" (1920×720) branchée à un Mac mini : douze pages
(accueil, tâches, musique, agenda, serveur, maison, Claude Code, patrimoine, Kanban, Switch, Discord, Plex), un
serveur Node sans dépendance, et une app macOS (BarreTouch) qui affiche la page sur la barre, rend son
tactile utilisable et sert de bras pour ce qu'une page web ne peut pas faire (fenêtres d'autres apps,
captures d'écran, accessibilité). Le correctif USB qui fait marcher le tactile de cette barre sur Mac est
dans son propre dépôt : [wisecoco-touchscreen-macos](https://github.com/Agarthe-A/wisecoco-touchscreen-macos).
Code sous licence MIT ; c'est un projet personnel, écrit pour un Mac précis, publié tel quel.


Le Mac mini est le cerveau, la barre n'est qu'une fenêtre dessus. Le serveur
tourne sur le Mac mini. N'importe quel ordi branché à la barre ouvre la page en
plein écran : le Mac mini lui-même, ou le PC de l'appart via Tailscale.

## Ce que fait la v1

- **Demandes d'autorisation Claude Code** : quand une session Claude Code veut
  lancer une commande, la barre affiche *Refuser / Toujours autoriser / Autoriser*.
  Sans réponse au bout de 90 s, la question revient normalement dans le terminal.
- **Sessions Claude Code** : en cours, en attente, terminées.
- **État du Mac** : CPU, RAM, SSD, conteneurs Docker.
- **Fil d'activité** : décisions, actions lancées, et messages envoyés par Hermes
  (ou n'importe quel script) via `POST /api/feed`.
- **Comptes à rebours** (semi, 250 km), **minuteur focus** de 25 min.
- **Boutons d'action** : commandes shell définies dans `config.json`.
- **Plex** : lecture en cours via Tautulli (optionnel).

## Installation sur le Mac mini

```sh
cd ~/barre
sh install.sh            # lance le serveur au démarrage de la session (launchd)
node hooks/install-hooks.mjs   # branche Claude Code (sauvegarde settings.json avant)
```

Le premier démarrage crée `config.json` avec un **jeton secret**. L'adresse à
ouvrir s'affiche à la fin de `install.sh`.

## Accès depuis un autre ordi (PC de l'appart)

Le serveur n'écoute que sur le Mac lui-même. Pour le rendre accessible **uniquement
à tes appareils Tailscale** :

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 4747
```

Puis, sur l'autre ordi : `https://<nom-du-mac>.<ton-tailnet>.ts.net/?token=<jeton>&kiosk=1`.
Ne jamais utiliser `tailscale funnel` ni un tunnel public : les boutons peuvent
autoriser des commandes sur ton Mac.

## Afficher la page en plein écran sur la barre

- **Mac** : ouvre l'adresse dans Chrome, glisse la fenêtre sur la barre, puis
  Ctrl+Cmd+F (plein écran). `&kiosk=1` masque le curseur.
- **Windows** : `chrome --kiosk --window-position=<x>,0 "https://…/?token=…&kiosk=1"`
  (x = position horizontale de la barre dans les réglages d'affichage).

## Configurer les boutons

Dans `config.json`, chaque action a une `command` exécutée sur le Mac :

```json
{ "id": "brief", "tag": "HERMES", "label": "Brief du matin",
  "command": "curl -s -X POST … " }
```

Tant que `command` vaut `null`, le bouton apparaît grisé.

## Afficher un message sur la barre (Hermes, scripts…)

```sh
curl -s -X POST http://127.0.0.1:4747/api/feed \
  -H "Authorization: Bearer <jeton>" -H "content-type: application/json" \
  -d '{"text":"Sortie longue dimanche 9 h 30","source":"hermes"}'
```

## Plex (optionnel)

Ajoute dans `config.json` :

```json
"tautulli": { "url": "http://127.0.0.1:8181", "apiKey": "<clé API Tautulli>" }
```

## Désinstaller

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.barre.dashboard.plist
node hooks/install-hooks.mjs --remove
```

## Version 2 : 7 pages

On passe d'une page à l'autre en **glissant à gauche ou à droite** (doigt ou souris), en touchant les onglets du bas, avec les flèches du clavier ou les touches 1 à 7. Sans toucher pendant 2 minutes, la barre revient à l'accueil (sauf sur Musique en lecture). Une nouvelle demande de Claude ramène aussi à l'accueil.

1. **Accueil** : heure, objectifs, état du Mac, demande Claude, fil Hermes, actions, mini-lecteur Apple Music, focus.
2. **Tâches** : 3 priorités du jour écrites par Claude (chaque matin à `priorities.time`, ou bouton « Régénérer »), Rappels Apple cochables, agenda du jour.
3. **Musique** : pochette, morceau, lecture/pause, précédent, suivant, volume.
4. **Agenda** : comptes à rebours, semaine du plan, 7 prochains jours avec les séances repérées (`trainingKeywords`).
5. **Serveur** : CPU, RAM, SSD, conteneurs Docker, lectures et ajouts Plex.
6. **Maison** : pièces Hue (allumer / éteindre), volets à venir.
7. **Claude** : toutes les sessions, décisions récentes, règles « Toujours autoriser » (bouton Retirer).

### Réglages dans config.json

```json
"calendars": [{ "name": "Perso", "url": "https://calendar.google.com/calendar/ical/…/basic.ics" }],
"reminders": { "enabled": true, "lists": [] },
"plex": { "enabled": true, "url": "http://127.0.0.1:32400", "recentSections": [12, 13, 14] },
"priorities": { "enabled": true, "time": "07:00" },
"plan": { "label": "Plan semi", "start": "2026-09-15", "end": "2026-12-27" }
```

- Google Agenda : Paramètres de l'agenda › Intégrer l'agenda › « Adresse secrète au format iCal ». Cette adresse donne accès à l'agenda : la garder pour soi.
- `reminders.lists` vide = toutes les listes.
- `externalDisk` : disque externe affiché sur l'Accueil et la page Serveur. Par défaut `{ "label": "NVMe", "path": "/Volumes/NVMe" }` : formater le disque sous le nom « NVMe », ou changer `path`. Affiche « Non branché » tant que le volume n'est pas monté.
- Depuis la relecture de sécurité, `config.json` (jeton), `rules.json` et `data/` sont rangés dans `~/.config/barre/` (hors du dossier du code) et le journal dans `~/Library/Logs/barre/`.
- Musique et Rappels demandent une autorisation macOS la première fois (« node souhaite contrôler… ») : l'accepter sur le Mac.

Hermes peut aussi envoyer ses propres priorités :

```sh
curl -X POST -H "Authorization: Bearer <jeton>" -H 'content-type: application/json' \
  -d '{"items":["…","…","…"]}' http://127.0.0.1:4747/api/priorities
```

Après une modification de config.json : `launchctl kickstart -k gui/$(id -u)/com.barre.dashboard`.

## Terminal et barre en même temps

Le raccourci `claude` (fonction ajoutée à la fin de `~/.zshrc`) lance Claude Code avec le canal de la barre (`channel/barre-channel.mjs`). Chaque demande d'autorisation s'ouvre tout de suite dans le terminal **et** sur la barre : la première réponse gagne, l'autre se ferme. Une réponse donnée dans le terminal retire la carte de la barre.

- Au lancement, Claude Code affiche un avertissement « Loading development channels » : appuyer sur Entrée (fonction en aperçu).
- « Toujours autoriser » ajoute une règle à `rules.json` ; le hook l'applique avant même que la question s'affiche.
- Sessions lancées autrement (VS Code, `command claude`…) : ancien fonctionnement, la barre d'abord puis le terminal après `permissionTimeoutSec`.
- Pour désactiver : supprimer le bloc « Barre » à la fin de `~/.zshrc` (une sauvegarde `~/.zshrc.barre-*.bak` existe).
## Patrimoine (page 8)

Des chiffres, jamais de conseil : la page additionne, convertit en euros et compare à la cible que tu fixes toi-même.

- **Montants masqués par défaut** : touche l'œil pour les afficher (les pourcentages restent visibles). Le choix est mémorisé sur l'écran de la barre.
- **Données** : `~/.config/barre/data/patrimoine.json` (mode 600), créé au premier démarrage avec tes lignes et **toutes les quantités à 0, à remplir**. Il peut être édité à la main (la barre le relit dans la minute) ; s'il devient illisible, la barre garde la dernière version correcte et refuse toute modification jusqu'à correction.
- **Cours** : sans clé ni compte, toutes les 15 min en semaine de 9:00 à 17:45 (heure de Paris), toutes les 2 h sinon. Sources par défaut, dans l'ordre : Paris (`.PA`) Boursorama → Tradegate → Yahoo ; Londres (`.L`) London Stock Exchange → Tradegate → Yahoo ; taux de change (EURUSD=X…) BCE (taux de référence du jour) → Frankfurter → Yahoo ; autres titres Tradegate → Yahoo (Tradegate cote en euros, par ISIN). Une seule requête par titre et par rafraîchissement : si elle échoue, le titre garde son dernier cours et la source suivante prend le relais au rafraîchissement d'après. Une source qui répond 429/403 est mise en pause 1 h, puis 2 h ; les pauses sont gardées dans `data/cours.json` (clé `sources`). Ordre réglable dans `config.json` : `"patrimoine": { "enabled": true, "sources": { "PA": ["tradegate", "boursorama"], "AI.PA": ["yahoo"], "*": [...] } }` (clés : symbole, place `PA`/`L`…, `FX`, `*` ; sources : `boursorama`, `lse`, `tradegate`, `bce`, `frankfurter`, `yahoo`). Cotations en pence (GBp/GBX) ramenées en livres. Un cours ancien est signalé « cours du JJ/MM ». Conditions d'utilisation : la BCE autorise la réutilisation (en citant la source) et Frankfurter est une API publique gratuite ; Boursorama, la LSE (LSEG), Tradegate et Yahoo réservent leurs sites à un usage personnel et y interdisent l'accès automatisé (à savoir avant de les garder dans l'ordre).
- **Échéances** : 5 ans du PEA (date d'ouverture du compte), prime de fidélité Air Liquide (inscrites au nominatif l'année A → +10 % à partir du dividende A+3), dividendes reçus sur 12 mois.

### Commande `patrimoine`

Installée par `install.sh` (`/opt/homebrew/bin/patrimoine`). Elle passe par le serveur ; s'il est arrêté, elle modifie directement le fichier (écriture atomique).

```sh
patrimoine                                         # résumé
patrimoine ligne AI.PA --tranche nominatif --quantite 21 --pru 150 --inscription 2023-03-01
patrimoine liquidites revolut 6500
patrimoine cible "Actions Europe=30" "Défense=10" "Or=10"
patrimoine achat "air liquide" 10 180 --compte pea --frais 1,95
patrimoine vente TTE 5 62
patrimoine dividende "air liquide" 45
patrimoine historique        # dans l'ordre de saisie
patrimoine annuler           # annule la dernière opération
patrimoine aide
```

Achat : PRU moyen pondéré, frais compris. Vente : PRU inchangé, plus-value réalisée enregistrée. Les liquidités du compte suivent chaque opération (`patrimoine liquidites …` pour les recaler). Hermes et Claude Code ont une compétence `patrimoine` (`skills/`, installée par `install.sh`) pour mettre à jour par message.

API (même jeton que le reste, même règle d'origine pour le cookie) : `GET /api/patrimoine`, `POST /api/patrimoine/operation`, `POST /api/patrimoine/ligne` (`type` : `ligne`, `liquidites` ou `cible`), `POST /api/patrimoine/annuler`, `POST /api/patrimoine/cours`.

### `patrimoine --json` (format stable)

Pour les scripts (ex. la revue du dimanche). Le format `barre.patrimoine/1` ne perd ni ne renomme jamais un champ ; un changement incompatible passerait à `/2`.

```json
{
  "schema": "barre.patrimoine/1",
  "source": "serveur",                 // "fichier" si le serveur était arrêté (cours du cache)
  "genere_le": "2026-10-17T15:40:12.000Z",
  "cours_au": "2026-10-17T15:35:12.000Z",  // dernier cours utilisé (null si aucun)
  "perime": false,                     // true si un cours ou un taux utilisé est ancien
  "a_remplir": false,                  // true tant que toutes les quantités sont à 0
  "devise": "EUR",
  "total_eur": 82431.12,
  "variation_jour_eur": 412.3,          // séance du jour (ou dernière séance), change compris
  "variation_jour_pct": 0.5,
  "latente_eur": 6210.5,                // null si aucun PRU connu
  "liquidites_eur": 8050,
  "comptes": [{ "id": "pea", "nom": "PEA Crédit Agricole", "type": "PEA", "valeur_eur": 78120.5,
                "liquidites_eur": 1240, "variation_jour_eur": 300.2, "poids_pct": 94.8 }],
  "categories": [{ "categorie": "Actions US", "valeur_eur": 40000, "poids_pct": 48.5,
                   "cible_pct": 30, "ecart_pts": 18.5 }],   // cible_pct / ecart_pts : null sans cible
  "lignes_perimees": []                 // symboles dont le cours est ancien
}
```

Montants arrondis au centime, pourcentages à 0,01. Pour une évolution d'une semaine sur l'autre, comparer `total_eur` (et `comptes[].valeur_eur`) de deux exports ; vérifier `perime` avant.

### Tests

```sh
node --test          # modèle, cours (réponses enregistrées dans test/fixtures : yahoo, sources), commande, API
```

Sans Internet, le serveur peut lire ces réponses enregistrées : `BARRE_COURS_FIXTURES=test/fixtures/yahoo node server.mjs` (réservé aux essais).

## Discord (page 11) : les streams du salon en mosaïque

Discord ne donne aucun accès à ses flux vidéo (ni API, ni bot), mais il sait ouvrir chaque stream dans
sa propre fenêtre (« Stream de <pseudo> »). La barre s'appuie là-dessus :

- **Lecture** (`touch/discordax.swift`) : BarreTouch lit Discord par l'accessibilité macOS (Discord ne
  construit cet arbre que si on le lui demande, `AXManualAccessibility`) : salon vocal en cours,
  participants (pseudo, micro coupé, « EN DIRECT », jeu joué), streams de l'appel (vignettes
  « Vignette d'appel, stream, <pseudo> ») et fenêtres de stream déjà ouvertes. Toutes les 2 s pendant la
  mosaïque, 5 s sinon (0,3 s par lecture, hors fil principal). Un menu contextuel ouvert masque tout le
  reste de l'arbre : BarreTouch le referme (Échap envoyé à Discord seul) avant de lire.
- **Commande** : un appui sur un stream (page Discord ou bande de droite) → BarreTouch ouvre le menu de
  sa vignette (`AXShowMenu`), choisit « Ouvrir le stream dans une fenêtre séparée », appuie sur
  « Regarder le stream » dans la fenêtre, puis la capture ; si Discord affiche un autre serveur, elle
  revient d'abord sur l'appel par le lien du bloc « Voix connectée ». Un second appui ferme la fenêtre.
  Son propre stream n'est pas proposé (Discord n'en montre qu'un aperçu figé).
- **Capture** (`touch/mosaic.swift`) : ScreenCaptureKit sur chaque fenêtre de stream (elles peuvent rester
  derrière les autres fenêtres, pas réduites dans le Dock ; fenêtre agrandie si elle fait moins de
  1280 px, `"discordEnlarge": false` dans `touch.json` pour l'en empêcher). Dans chaque fenêtre, la vidéo
  est repérée (blocs de 16 px : contenu s'il a bougé dans les 4 s ou s'il n'a pas la couleur du fond ;
  bords affinés au pixel ; disposition retenue après plusieurs lectures identiques), les bandes noires et
  la barre de titre exclues ; sinon la fenêtre entière. La fenêtre de l'appel entière marche aussi (une
  vignette par vidéo). Grille 1600×720 entre deux bandes de 160 px (`discordBands`), pseudo en bas de
  chaque flux (nom affiché quand Discord le donne), 30 i/s (`discordFps`).
- **Liaison RPC** (`lib/discord-rpc.mjs`) : l'API locale du client Discord (socket `$TMPDIR/discord-ipc-N`,
  celle du Stream Deck) donne en temps réel, par événements : le salon rejoint, ses participants (pseudo
  de serveur, avatar via le CDN, 128 px, dans `data/discord-avatars/<id>.png`), micro et casque coupés,
  et qui parle (SPEAKING_START / STOP, quelques dizaines de ms). Il faut une application Discord créée par
  l'utilisateur sur discord.com/developers (OAuth2 : Client ID, Client Secret, redirection
  `http://127.0.0.1`) dans `config.json` : `"discord": { "clientId": "…", "clientSecret": "…" }`. Au premier
  démarrage, Discord affiche « Barre souhaite accéder à votre compte » (scopes `rpc`, `rpc.voice.read`,
  réservés aux applications approuvées sauf pour leur propriétaire) ; le jeton est gardé dans
  `data/discord-rpc.json` et renouvelé tout seul. Sans cette liaison, BarreTouch lit à la place une image
  de la fenêtre Discord (toutes les 0,3 s pendant la mosaïque) : anneau vert autour de l'avatar de la
  ligne du participant (disque de 24 pt à 16 pt du bord gauche), icônes rouges à droite, avatar découpé.
- **Sur la barre** : un appui sur un flux le met en grand (les autres en petit sur les côtés), un nouvel
  appui revient à la grille ; appui long (1,2 s) : retour au tableau de bord. Bandeau sous les flux :
  les participants du salon avec leur avatar, anneau vert = parle, micro barré = coupé, « en direct » ;
  un appui sur une pastille ouvre le volume de cette personne pour moi (curseur 0–200 %, « Couper pour
  moi », commande RPC `SET_USER_VOICE_SETTINGS`). Bande de gauche : horloge, salon, boutons **Muet** et
  **Sourdine** (mon micro / mon casque, `SET_VOICE_SETTINGS`, état en direct). Bande de droite : un bouton
  par stream, Fenêtres entières / Vidéos repérées, Quitter. Mêmes commandes sur la page Discord.
- **Nouveau stream automatique** : quand quelqu'un se met en direct dans le salon, BarreTouch l'ouvre et
  l'ajoute à la grille toute seule (et une ligne dans le fil d'activité), à condition que la barre soit
  libre (pas de jeu en cours) ; un stream retiré à la main n'est pas réajouté tant que la personne
  stream. `"discord": { "autoStreams": false }` pour désactiver.

Au premier affichage, macOS demande **Enregistrement de l'écran** pour BarreTouch (Réglages ›
Confidentialité et sécurité ; BarreTouch redémarre ensuite d'elle-même) ; **Accessibilité** est déjà
accordée pour la Switch. `config.json` : `"discord": { "enabled": false }` masque la page ;
`touch.json` : `"discordAx": false` coupe la lecture de Discord (la capture manuelle des fenêtres reste).

Réglage et diagnostic : `POST /api/discord/snapshot` enregistre les images capturées et les vignettes
repérées dans `~/Library/Logs/barre/discord-capture-N.{png,json}` ; relais BarreTouch
`{"action":"discord","op":"ax-dump"}` écrit l'arbre d'accessibilité de Discord dans
`~/Library/Logs/barre/discord-ax.txt`, `"op":"ax-snapshot","fresh":true` ce qui en est lu, `"op":"ax-rows"`
découpe les lignes des participants (`discord-row-N.png`, pour recaler la lecture des pixels).

API (même jeton) : `POST /api/discord/self` (`{"mute": bool}` ou `{"deaf": bool}`), `user`
(`{"id": "<id Discord>", "volume": 0–200, "mute": bool}`), `watch` et `unwatch` (`{"user": "<pseudo>"}`), `start`
(`{"windows": [<id>…]}`, sans liste : toutes les fenêtres de stream, et chaque nouvelle les rejoint),
`add` / `remove` (`{"window": <id>}`), `stop`, `focus` (`{"index": n}`, -1 = grille), `mode`
(`{"mode": "grid"|"whole"}`), `rescan`, `snapshot` ; l'état est dans `discord` du flux `/api/events`
(`ax` : salon, participants, streams). Relais : `POST 127.0.0.1:4748/window` avec `{"action":"discord","op":…}`.

## Plex (page 12) : regarder sa médiathèque sur la barre

Plex Media Server tourne sur le Mac (jeton lu dans ses réglages, comme pour la page Serveur). La page
montre **Reprendre** (On Deck, avec la progression) et les **nouveautés** (films, premier épisode non vu
d'une saison ajoutée). Un appui lance la lecture dans la page : Plex transcode en HLS (profil Safari,
1080p, 12 Mbit/s), WebKit le lit nativement sur la barre, le son sort du Mac. Bande de gauche : affiche,
titre, position ; bande de droite : lecture / pause, −15 s, +30 s, son −/+, quitter ; un appui sur la
vidéo met en pause. La position est renvoyée à Plex toutes les 10 s (`/:/timeline`) : Reprendre et
« vu » restent justes, et le transcodage est arrêté en quittant. Pendant une lecture, la barre ne revient
pas à l'accueil et un stream Discord ne s'invite pas ; lancer Plex efface la mosaïque Discord.

Le serveur fait relais vers Plex avec le jeton, la page ne le voit jamais : `GET /api/plex/img`
(affiches), `GET /api/plex/hls/<session>/…` (listes HLS et segments ; le lecteur de WebKit n'envoie ni
cookie ni jeton aux sous-requêtes, c'est l'identifiant de session, aléatoire et créé par
`POST /api/plex/play`, qui fait foi ; les listes sont renvoyées d'un bloc, WebKit refuse une liste
diffusée en flux). `POST /api/plex/play` (`{"key", "offset"}` → `src`, `session`), `timeline`
(`{"key", "state", "time", "duration", "session"}`), `refresh`. `config.json` : `"plex": { "url",
"recentSections": [12, 13, 14] }` (sections des nouveautés), `"enabled": false` masque la page.
Changer de position (−15 s, +30 s) relance une session HLS au nouveau décalage.

Lecteur à deux colonnes de 320 px autour de la vidéo (1280×720) : à gauche l'épisode en cours puis la
saison (un appui lance un épisode, le suivant s'enchaîne à la fin, bouton « Suivant »), ou le résumé pour
un film ; à droite les commandes, puis **Audio** et **Sous-titres** (toutes les pistes du fichier ;
un choix est mémorisé par Plex pour ce média via `PUT /library/parts/<id>`, la session HLS repart au
même endroit, sous-titre incrusté par le transcodeur). **Grand écran** : BarreTouch ouvre une fenêtre
vidéo native (AVPlayer, `touch/plexwindow.swift`, relais `{"action":"plex","op":…}`) en plein écran
sur l'écran principal avec une session HLS à part ; la barre devient la télécommande (pause, position,
son, pistes, saison) et **Renvoyer sur la barre** referme la fenêtre pour reprendre ici au même
endroit ; Échap ou un double clic sur le grand écran font pareil. `POST /api/plex/main`
(`{"op": "open"|"status"|"play"|"pause"|"seek"|"volume"|"close", …}`), `GET /api/plex/episodes?key=`,
`POST /api/plex/select` (`{"key", "audio"|"subtitle": <id>, 0 = aucun}`).

## Vitrine (2026-10-29)
Page de présentation du hub: `~/clawd/projects/hub/vitrines/barre/`. Outils pour la refaire: `vitrine/` (`./vitrine/refaire.sh` lance une copie du tableau de bord en `BARRE_DEMO=1` sur le port 4799 avec une config jetable, jamais le vrai service ni `~/.config/barre`). Détails et état dans `projects/hub.md` (section « Vitrine barre »).
