#!/usr/bin/env python3
"""Faalt als de add-on-versie in beregeningsplanner/config.yaml niet omhoog is gegaan
t.o.v. een eerdere git-ref.

Voorkomt dat een (per ongeluk lagere of gelijke) versie naar master gepusht
wordt: Home Assistant biedt zo'n versie nooit aan als update, waardoor een
echte update onopgemerkt stil blijft staan totdat iemand het toevallig
ontdekt.
"""
import re
import subprocess
import sys

ADDON_DIR = "beregeningsplanner"
CONFIG_PATH = f"{ADDON_DIR}/config.yaml"


def read_version(text):
    match = re.search(r'^version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?', text, re.MULTILINE)
    if not match:
        raise SystemExit(f"Kon geen 'version:' vinden in {CONFIG_PATH}")
    return tuple(int(p) for p in match.group(1).split("."))


def read_version_at_ref(ref):
    result = subprocess.run(
        ["git", "show", f"{ref}:{CONFIG_PATH}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None  # geen vorige versie om mee te vergelijken
    return read_version(result.stdout)


def addon_changed_since(ref):
    """Of er iets onder beregeningsplanner/ is gewijzigd sinds het splitspunt met ref.

    Vergelijkt vanaf de merge-base, zodat een PR die achterloopt op master niet
    de wijzigingen van master als eigen wijzigingen ziet. Bij twijfel (geen
    merge-base, onbekende ref) geldt de wijziging als aanwezig.
    """
    base = subprocess.run(
        ["git", "merge-base", ref, "HEAD"],
        capture_output=True,
        text=True,
    )
    if base.returncode != 0:
        return True
    diff = subprocess.run(
        ["git", "diff", "--quiet", base.stdout.strip(), "HEAD", "--", ADDON_DIR],
    )
    return diff.returncode != 0


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Gebruik: check_addon_version.py <git-ref-om-mee-te-vergelijken>")
    base_ref = sys.argv[1]

    if not addon_changed_since(base_ref):
        print(f"Niets gewijzigd onder {ADDON_DIR}/ -- geen versie-bump nodig.")
        return

    with open(CONFIG_PATH, encoding="utf-8") as f:
        new_version = read_version(f.read())

    old_version = read_version_at_ref(base_ref)
    if old_version is None:
        print("Geen vorige versie gevonden om mee te vergelijken -- check overgeslagen.")
        return

    print(
        f"Vorige versie: {'.'.join(map(str, old_version))} -- "
        f"nieuwe versie: {'.'.join(map(str, new_version))}"
    )
    if new_version <= old_version:
        raise SystemExit(
            "FOUT: de add-on-versie in config.yaml is niet hoger dan de vorige "
            "commit. Home Assistant biedt een niet-hogere versie nooit aan als "
            "update. Controleer ook de live installed_version via het "
            "update.beregeningsplanner_update-entity in Home Assistant -- die kan hoger "
            "zijn dan wat de git-geschiedenis laat zien -- en verhoog 'version' "
            "in beregeningsplanner/config.yaml voldoende."
        )


if __name__ == "__main__":
    main()
