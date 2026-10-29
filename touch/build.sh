#!/bin/sh
# Compile BarreTouch.app (affichage + tactile de la barre).
# Usage : sh build.sh
# Signature : certificat « Apple Development » s'il existe, pour que macOS garde l'autorisation
# « Surveillance de l'entrée » d'une compilation à l'autre. Sinon signature locale (ad hoc) :
# il faut alors réactiver BarreTouch dans la liste après chaque recompilation.
# Le calibrage se règle sans recompiler dans ~/.config/barre/touch.json.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/BarreTouch.app"
mkdir -p "$APP/Contents/MacOS"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
swiftc -O "$DIR/main.swift" "$DIR/relay.swift" "$DIR/window.swift" "$DIR/mosaic.swift" "$DIR/discordax.swift" "$DIR/plexwindow.swift" -o "$APP/Contents/MacOS/BarreTouch"
ID="$(security find-identity -v -p codesigning 2>/dev/null | awk '/Apple Development/ {print $2; exit}')"
if [ -n "$ID" ] && codesign --force --sign "$ID" --identifier com.barre.touch "$APP" 2>/dev/null; then
  echo "Signé avec le certificat Apple Development"
else
  codesign --force --sign - --identifier com.barre.touch "$APP"
  echo "Signé en local (ad hoc)"
fi
echo "Compilé : $APP"
