#!/usr/bin/env python3
"""Vidéo de présentation de la vitrine « barre » (1920x1080, 30 i/s, H.264, sans son).

1. Terminal (≈9 s): vraies exécutions de l'outil du dépôt (make, --version) puis le format de sortie du lecteur de
   diagnostic tel que le README du dépôt le donne (la barre n'est pas branchée ici: c'est écrit à l'écran).
2. Tableau de bord (≈27 s): enregistrement réel de la copie en mode démo (record_dashboard.mjs), données fictives.

Usage (Python d'Xcode, avec Pillow): make_video.py <dossier-travail> <enregistrement.mp4> <sortie.mp4> <poster.jpg> <ffmpeg> <real/>
  <real/> = dossier contenant make.txt et version.txt (sorties réelles).
"""
import os, sys, subprocess, shutil
from PIL import Image, ImageDraw, ImageFont

WORK, REC, OUT, POSTER, FFMPEG, REAL = sys.argv[1:7]
W, H, FPS = 1920, 1080, 30
BG, PANEL, INK, MUTED, AMBER, GREEN = (13, 14, 16), (21, 23, 26), (236, 234, 228), (154, 152, 144), (242, 169, 59), (120, 200, 140)
MONO = "/System/Library/Fonts/SFNSMono.ttf"
SANS = "/System/Library/Fonts/SFNS.ttf"
os.makedirs(WORK, exist_ok=True)


def font(path, size, weight=None):
    f = ImageFont.truetype(path, size)
    if weight:
        try: f.set_variation_by_name(weight)
        except Exception: pass
    return f


def read(name):
    return open(os.path.join(REAL, name), encoding="utf-8").read().rstrip("\n").splitlines()


# ---- contenu du terminal: (texte, couleur, tape-t-on ?)
lines = [("$ make", INK, True)]
lines += [((l if len(l) <= 74 else l[:73] + "…"), MUTED, False) for l in read("make.txt")]
lines += [("$ ./build/wisecoco-touch-enable --version", INK, True)]
lines += [(l, MUTED, False) for l in read("version.txt")]
lines += [("$ ./build/wisecoco-touch-dump --seconds 20", INK, True),
          ("listening for 0712:0010 for 20 s; touch the screen now", MUTED, False),
          ("[   0.012] device: hotlotus wcidtest (0712:0010)", MUTED, False),
          ("[   2.481] report 4  count=1  [id 1 down x=1019 y=546]", GREEN, False)]
NOTE = "make et --version : exécutés pour de vrai. Les trois dernières lignes : exemple du README du dépôt (la barre n'était pas branchée)."

fm = font(MONO, 31)
fs = font(SANS, 30, "Medium")
fsb = font(SANS, 44, "Semibold")
LH = 52
X0, Y0 = 150, 250
total_chars = sum(len(t) for t, _, typed in lines if typed)


def terminal_frame(t):
    """t en secondes depuis le début du terminal."""
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((100, 150, W - 100, H - 190), 22, fill=PANEL, outline=(40, 42, 48), width=2)
    d.text((150, 175), "terminal", font=fs, fill=MUTED)
    # frappe: 38 caractères/s, puis les lignes de sortie apparaissent d'un coup
    typed_budget = int(max(0, t - 0.4) * 38)
    y = Y0
    shown_lines = 0
    for text, col, typed in lines:
        if typed:
            n = min(len(text), typed_budget)
            if n <= 0 and typed_budget <= 0 and shown_lines > 0:
                break
            d.text((X0, y), text[:n], font=fm, fill=col)
            typed_budget -= len(text)
            if typed_budget < 0 and n < len(text):
                if int(t * 2) % 2 == 0:
                    cw = d.textlength(text[:n], font=fm)
                    d.rectangle((X0 + cw + 3, y + 6, X0 + cw + 18, y + 40), fill=INK)
                break
            y += LH; shown_lines += 1
        else:
            if typed_budget < 0 or shown_lines == 0:
                break
            d.text((X0, y), text, font=fm, fill=col)
            y += LH; shown_lines += 1
    d.text((150, H - 150), NOTE[:130], font=fs, fill=MUTED)
    return im


def main_background():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((36, 168, W - 36, 168 + 744), 26, fill=(26, 28, 32))
    d.text((64, 100), "barre", font=fsb, fill=INK)
    d.text((64 + d.textlength("barre", font=fsb) + 24, 112), "tableau de bord en mode démo, données d'exemple", font=fs, fill=MUTED)
    d.text((64, 960), "copie jetable du tableau de bord, rien de réel à l'écran · geste joué à la souris, l'anneau ambre est le doigt", font=fs, fill=MUTED)
    return im


# ---- 1. terminal
tdir = os.path.join(WORK, "term"); shutil.rmtree(tdir, ignore_errors=True); os.makedirs(tdir)
TERM_S = 9.0
n = int(TERM_S * FPS)
for i in range(n):
    terminal_frame(i / FPS).save(f"{tdir}/t{i:04d}.png")
q = [FFMPEG, "-loglevel", "error", "-y"]
subprocess.run(q + ["-framerate", str(FPS), "-i", f"{tdir}/t%04d.png", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", f"{WORK}/intro.mp4"], check=True)

# ---- 2. tableau de bord dans son cadre
bg = os.path.join(WORK, "bg.png"); main_background().save(bg)
subprocess.run(q + ["-i", bg, "-i", REC, "-filter_complex",
                    "[1:v]fps=30,scale=1792:672:flags=lanczos[v];[0:v][v]overlay=64:204,format=yuv420p",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS), "-shortest", f"{WORK}/main.mp4"], check=True)

# ---- assemblage
with open(f"{WORK}/cat.txt", "w") as f:
    f.write(f"file '{WORK}/intro.mp4'\nfile '{WORK}/main.mp4'\n")
subprocess.run(q + ["-f", "concat", "-safe", "0", "-i", f"{WORK}/cat.txt", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", OUT], check=True)
# affiche: le tableau de bord, accueil, 2 s après le début de la partie 2
subprocess.run(q + ["-ss", str(TERM_S + 1.2), "-i", OUT, "-frames:v", "1", "-q:v", "3", POSTER], check=True)
dur = subprocess.run([FFMPEG, "-i", OUT], capture_output=True, text=True).stderr
print([l for l in dur.splitlines() if "Duration" in l][0].strip())
