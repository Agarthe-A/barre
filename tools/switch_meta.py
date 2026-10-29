#!/usr/bin/env python3
"""Titre et icône d'un jeu Switch (NSP, NSZ, XCI, XCZ), lus dans son NCA « control » avec les clés d'Eden.

Usage : ~/.venvs/nsz/bin/python switch_meta.py <dossier des icônes> <fichier>...
Sortie : une ligne JSON par fichier {"file", "titleId", "name", "publisher", "version", "icon"} ou {"file", "error"}.
Lecture seule : rien n'est écrit à part les icônes (JPEG) dans le dossier donné.
"""
import json
import os
import struct
import sys
from pathlib import Path

from nsz.nut import Keys

Keys.load_default()
import nsz.Fs as Fs  # noqa: E402  (après les clés)
from nsz.Fs.Nca import Nca  # noqa: E402

# Ordre de préférence des langues (index NACP, nom du fichier d'icône)
LANGS = [(3, "French"), (9, "CanadianFrench"), (0, "AmericanEnglish"), (1, "BritishEnglish"),
         (6, "Spanish"), (4, "German"), (7, "Italian"), (2, "Japanese")]


def romfs_files(fs):
    """Lit la table des fichiers d'une RomFS (déjà déchiffrée par nsz) : {nom: (offset, taille)}."""
    lvl = fs.ivfc.levels[-1]
    base = lvl.offset
    fs.seek(base)
    hdr = fs.read(0x50)
    (hsize, dho, dhs, dmo, dms, fho, fhs, fmo, fms, data_off) = struct.unpack("<10Q", hdr)
    fs.seek(base + fmo)
    meta = fs.read(fms)
    files = {}
    pos = 0
    while pos + 0x20 <= len(meta):
        parent, sibling, doff, dsize, hsib, nlen = struct.unpack_from("<IIQQII", meta, pos)
        name = meta[pos + 0x20: pos + 0x20 + nlen].decode("utf-8", "replace")
        files[name] = (base + data_off + doff, dsize)
        pos += 0x20 + ((nlen + 3) & ~3)
    return files


def read_file(fs, ent):
    off, size = ent
    fs.seek(off)
    return fs.read(size)


def meta_for(path, icon_dir):
    p = Path(path)
    f = Fs.factory(p)
    f.open(str(p), "rb")
    try:
        for nca in (x for x in f if isinstance(x, Nca)):
            if nca.header.contentType != Fs.Type.Content.CONTROL:
                continue
            for fs in nca.sectionFilesystems:
                if getattr(fs, "ivfc", None) is None:
                    continue
                files = romfs_files(fs)
                if "control.nacp" not in files:
                    continue
                nacp = read_file(fs, files["control.nacp"])
                name = publisher = icon_name = None
                for idx, lang in LANGS:
                    n = nacp[idx * 0x300: idx * 0x300 + 0x200].split(b"\0")[0].decode("utf-8", "replace").strip()
                    if n and not name:
                        name = n
                        publisher = nacp[idx * 0x300 + 0x200: idx * 0x300 + 0x300].split(b"\0")[0].decode("utf-8", "replace").strip()
                    if f"icon_{lang}.dat" in files and not icon_name:
                        icon_name = f"icon_{lang}.dat"
                if not icon_name:
                    icon_name = next((k for k in files if k.startswith("icon_")), None)
                version = nacp[0x3060:0x3070].split(b"\0")[0].decode("utf-8", "replace").strip()
                tid = nca.header.titleId
                tid = (tid if isinstance(tid, str) else "%016x" % tid).upper()
                icon = None
                if icon_name:
                    os.makedirs(icon_dir, exist_ok=True)
                    icon = os.path.join(icon_dir, tid + ".jpg")
                    with open(icon + ".tmp", "wb") as out:
                        out.write(read_file(fs, files[icon_name]))
                    os.replace(icon + ".tmp", icon)
                return {"file": str(p), "titleId": tid, "name": name, "publisher": publisher, "version": version, "icon": icon}
        return {"file": str(p), "error": "pas de NCA control lisible"}
    finally:
        try:
            f.close()
        except Exception:
            pass


if __name__ == "__main__":
    icon_dir = sys.argv[1]
    for a in sys.argv[2:]:
        try:
            print(json.dumps(meta_for(a, icon_dir), ensure_ascii=False), flush=True)
        except Exception as e:  # un fichier illisible ne doit pas bloquer les autres
            print(json.dumps({"file": a, "error": f"{type(e).__name__}: {e}"[:300]}, ensure_ascii=False), flush=True)
