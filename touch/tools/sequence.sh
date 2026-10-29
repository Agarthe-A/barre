#!/bin/zsh
# Attend un débranchement/rebranchement de la barre, puis enchaîne des essais d'initialisation
# du tactile (du moins risqué au plus risqué), en notant chaque étape dans le journal de BarreTouch.
L=~/Library/Logs/barre/touch.log
T=~/barre/touch/tools/usbctl
note() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') [essai] $*" >> $L }
run() { "$T" "$@" 2>&1 | while IFS= read -r l; do note "  $l"; done }
present() { ioreg -r -n wcidtest -d1 2>/dev/null | grep -q wcidtest }

if [[ "$1" != now ]]; then
  note "en attente du débranchement de la barre"
  while present; do sleep 0.3; done
  note "barre débranchée, en attente du rebranchement"
  while ! present; do sleep 0.3; done
fi
note "début des essais : référence pendant 6 s"
sleep 6
note "A : protocole BOOT (souris simple)"
run "21 0b 0000 0001 0"
sleep 8
note "B : retour au protocole REPORT"
run "21 0b 0001 0001 0"
sleep 4
note "C : descripteurs Microsoft (MS OS 1.0)"
run "80 06 03ee 0000 12" "c0 60 0000 0004 10" "c0 60 0000 0004 28" "c1 60 0000 0005 0a"
sleep 8
note "D : empreinte d'énumération Windows"
run "80 06 0100 0000 40" "80 06 0200 0000 ff" "80 06 0200 0000 ff" "80 06 0200 0000 ff"
sleep 6
note "E : SET_IDLE + lecture des rapports de configuration (longueurs exactes)"
run "21 0a 0000 0001 0" "a1 01 0302 0001 2" "a1 01 0303 0001 101"
sleep 10
note "fin des essais"
