# BarreTouch

App macOS qui affiche le tableau de bord (`http://127.0.0.1:4747/?kiosk=1`) en plein écran sur la
barre Wisecoco 12,3" (1920×720) et rend son tactile utilisable, sans voler le focus ni bouger le curseur.

- Service : `sh install.sh` (LaunchAgent `com.barre.touch`, démarre avec la session) — `sh install.sh remove` pour retirer.
- Compiler : `sh build.sh` (signée Apple Development → l'autorisation « Surveillance de l'entrée » tient).
- Journal : `~/Library/Logs/barre/touch.log`.
- Réglages : `~/.config/barre/touch.json` (swapXY, flipX, flipY, debug, initRequests…).
- Ne s'affiche jamais par-dessus l'écran principal (si macOS fait de la barre l'écran principal, elle s'efface).

## Le tactile sur Mac : la solution (28/10/2026)

Contrôleur : VID 0x0712 / PID 0x0010 (« hotlotus / wcidtest »), branché par le Type-C.

Par défaut, sur Mac, la barre fait une « émulation souris » qui envoie des rapports n°5 **à zéro**.
Cause : à la connexion, macOS active le **réveil à distance** de l'appareil (SET_FEATURE
DEVICE_REMOTE_WAKEUP, GET_STATUS = 02 00), ce que Windows ne fait pas. Le firmware s'en sert
visiblement pour reconnaître un Mac.

Séquence qui active le vrai tactile (rapports n°4, 10 doigts), rejouée par BarreTouch via
`tools/usbctl` au branchement, au réveil du Mac et dès qu'un rapport « souris » réapparaît :

1. `00 01 0001 0000 0` — CLEAR_FEATURE(DEVICE_REMOTE_WAKEUP) **en premier**
2. `c0 60 0000 0004 10` / `c0 60 0000 0004 28` — descripteur Microsoft « compat ID » (comme Windows)
3. `80 00 0000 0000 2` — GET_STATUS (doit répondre 00 00)
4. `21 0a 0000 0001 0` — SET_IDLE
5. `81 06 2200 0001 388` — descripteur HID
6. `a1 01 0302 0001 101` / `a1 01 0303 0001 101` — rapports de configuration 2 et 3 (257 octets)

Sans l'étape 1, la lecture des rapports de configuration rend la barre muette jusqu'à la coupure
d'alimentation. Séquence relevée sur Windows avec USBPcap (capture `barre.pcapng`).

Rapport n°4 : `04 | [id 6 bits | posé 1 bit] | X (16 bits, 0–1920) | Y (16 bits, 0–720)` × 10 doigts,
puis horodatage (4 o) et nombre de doigts (1 o).

## Relais osascript (Musique, Rappels)

Le serveur du tableau de bord (service sans fenêtre) ne peut pas obtenir les autorisations
« Automatisation ». `lib/sources.mjs` fait donc exécuter `osascript` par BarreTouch via
`POST http://127.0.0.1:4748/osascript` (jeton du tableau de bord), avec repli local si BarreTouch
ne répond pas. Sauvegarde de l'ancien fichier : `~/barre/backup-v1/pre-relais/sources.mjs`.
Si Musique ne répond plus (« délai dépassé », -1712), la quitter et la relancer.

Outils de diagnostic dans `tools/` (usbctl, usbpoke, usbread, usbcapture, winrace…).
