#!/usr/bin/env python3
"""Maakt de WebP-subartikelen van de grote afbeeldingen van de shop (hero, banners, zakelijk).

Gebruik (vanuit hub/backend, Pillow met WebP nodig): python3 tools/shop-webp.py
De JPEG's blijven staan (terugval en bestaande verwijzingen in Beheer); de shop zet er een picture-element omheen zodra
`<naam>.webp` bestaat. Bij elke afbeelding een kleine versie (`<naam>-klein.webp`) voor smalle schermen.
"""
from pathlib import Path
from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "src" / "webshop" / "assets"
# bestand: (breedte van de kleine subartikel, kwaliteit grote, kwaliteit kleine)
FILES = {
    "hero-tuin.jpg": (720, 74, 72),
    "banner-druppelslang.jpg": (600, 72, 70),
    "banner-pomp.jpg": (600, 72, 70),
    "zakelijk-achtergrond.jpg": (None, 62, 62),
}

for name, (small_width, quality, small_quality) in FILES.items():
    image = Image.open(ASSETS / name).convert("RGB")
    stem = Path(name).stem
    if name.startswith("banner-"):
        # Wordt hooguit ruim 580 px breed getoond; 1000 px is genoeg voor een scherm met dubbele dichtheid.
        image = image.resize((1000, round(image.height * 1000 / image.width)), Image.LANCZOS)
    image.save(ASSETS / f"{stem}.webp", "WEBP", quality=quality, method=6)
    if small_width:
        small = image.resize((small_width, round(image.height * small_width / image.width)), Image.LANCZOS)
        small.save(ASSETS / f"{stem}-klein.webp", "WEBP", quality=small_quality, method=6)
    print(stem, image.size)
