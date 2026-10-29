#!/bin/sh
# Installe BarreTouch comme service macOS (démarre avec la session, relancé s'il s'arrête).
# Usage : sh install.sh      — désinstallation : sh install.sh remove
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.barre.touch
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/barre"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
if [ "$1" = remove ]; then rm -f "$PLIST"; echo "BarreTouch désinstallée."; exit 0; fi
pkill -x BarreTouch 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/BarreTouch.app/Contents/MacOS/BarreTouch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/barre/touch-stderr.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "BarreTouch installée (journal : ~/Library/Logs/barre/touch.log)."
