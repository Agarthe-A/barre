#!/bin/zsh
# Refait les médias de la vitrine « barre » (captures, vidéo) sur une COPIE du tableau de bord en mode démo.
# Rien de réel lu ni modifié: ~/barre et ~/.config/barre ne sont pas touchés, le service com.barre.dashboard non plus.
# Usage: ./refaire.sh   (écrit dans projects/hub/vitrines/barre/, ne lance pas build_hub.py)
set -e
HERE=${0:A:h}
S=$HOME/.hermes/cache/scratch/barre-vitrine
OUT=$HOME/clawd/projects/hub/vitrines/barre
FF=$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg
PY=/Applications/Xcode.app/Contents/Developer/usr/bin/python3     # avec Pillow
PORT=4799
rm -rf $S/barre-demo $S/cfg; mkdir -p $S/cfg $S/real
rsync -a --exclude backup-v1 --exclude logs --exclude touch --exclude node_modules --exclude '*.orig' --exclude vitrine $HOME/barre/ $S/barre-demo/
cd $S/barre-demo
# données fictives et actions neutralisées (les .patch décrivent exactement les écarts avec le vrai code)
patch -s -p0 server.mjs < $HERE/demo-server.patch
patch -s -p0 lib/demo.mjs < $HERE/demo-demo.patch
patch -s -p0 lib/patrimoine.mjs < $HERE/demo-patrimoine.patch
print '{"port":'$PORT',"host":"127.0.0.1","token":"demo-jetable-vitrine","googleCalendar":{"enabled":false},"hermes":{"enabled":false},"plex":{"enabled":false}}' > $S/cfg/config.json
BARRE_DEMO=1 BARRE_CONFIG=$S/cfg/config.json node server.mjs > $S/demo.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 2
URL="http://127.0.0.1:$PORT/?token=demo-jetable-vitrine&kiosk=1"
# 1. outil du dépôt: vraies exécutions (make, --version)
rm -rf $S/repo; cp -R $HOME/projets/wisecoco-touchscreen-macos $S/repo
(cd $S/repo && make -B > $S/real/make.txt 2>&1 && ./build/wisecoco-touch-enable --version > $S/real/version.txt 2>&1)
# 2. captures de la page, enregistrement, vidéo
node $HERE/capture_pages.mjs $URL $S/shots $S/png
node $HERE/record_dashboard.mjs $URL $S/rec
$FF -loglevel error -y -f concat -safe 0 -i $S/rec/list.txt -vf "fps=30,scale=1920:720" -pix_fmt yuv420p -c:v libx264 -preset veryfast -crf 20 $S/rec.mp4
$PY $HERE/make_video.py $S/video $S/rec.mp4 $S/presentation.mp4 $S/presentation.jpg $FF $S/real
mkdir -p $OUT
for i in 1 2 3 4 5 6 7 8 9; do cp $S/shots/p$i.jpg $OUT/p$i.jpg; done
cp $S/presentation.mp4 $S/presentation.jpg $OUT/
echo "médias écrits dans $OUT"
echo "ensuite: python3 projects/togi/togi.py gate $OUT && node $HERE/test_page.mjs $OUT/index.html"
