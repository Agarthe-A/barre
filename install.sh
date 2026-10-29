#!/bin/sh
# Installe le serveur de la barre comme service macOS (démarre avec la session).
# Usage : sh install.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node introuvable. Installe-le (brew install node) puis relance." >&2
  exit 1
fi

LOGDIR="$HOME/Library/Logs/barre"
mkdir -p "$LOGDIR"
PLIST="$HOME/Library/LaunchAgents/com.barre.dashboard.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" -e "s#__LOGDIR__#$LOGDIR#g" "$DIR/launchd/com.barre.dashboard.plist.template" > "$PLIST"

# Recharge le service s'il existait déjà
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# Patrimoine : commande « patrimoine » et compétences Hermes / Claude Code.
# Relançable sans risque : le lien et les copies sont simplement remplacés.
chmod +x "$DIR/bin/patrimoine.mjs"
BIN="/opt/homebrew/bin"
[ -d "$BIN" ] || BIN="/usr/local/bin"
if [ -w "$BIN" ]; then
  # Petit lanceur avec le chemin complet de node : marche aussi quand le PATH
  # ne contient pas Homebrew (Hermes, tâches planifiées).
  rm -f "$BIN/patrimoine"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$DIR/bin/patrimoine.mjs" > "$BIN/patrimoine"
  chmod 755 "$BIN/patrimoine"
  echo "Commande installée : $BIN/patrimoine"
else
  echo "Pas le droit d'écrire dans $BIN : lance « sudo ln -sfn $DIR/bin/patrimoine.mjs $BIN/patrimoine »."
fi
mkdir -p "$HOME/.claude/skills/patrimoine"
cp "$DIR/skills/claude/patrimoine/SKILL.md" "$HOME/.claude/skills/patrimoine/SKILL.md"
echo "Compétence Claude Code : ~/.claude/skills/patrimoine"
if [ -d "$HOME/.hermes" ]; then
  mkdir -p "$HOME/.hermes/skills/productivity/patrimoine"
  cp "$DIR/skills/hermes/patrimoine/SKILL.md" "$HOME/.hermes/skills/productivity/patrimoine/SKILL.md"
  echo "Compétence Hermes : ~/.hermes/skills/productivity/patrimoine"
else
  echo "Hermes absent (~/.hermes) : compétence Hermes non installée."
fi

sleep 1.5
CFG="$HOME/.config/barre/config.json"
[ -f "$CFG" ] || CFG="$DIR/config.json"
TOKEN="$("$NODE" -e "console.log(require('$CFG').token)")"
PORT="$("$NODE" -e "console.log(require('$CFG').port || 4747)")"
echo "Serveur lancé."
echo "Ouvre : http://127.0.0.1:$PORT/?token=$TOKEN&kiosk=1"
