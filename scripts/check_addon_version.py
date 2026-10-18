#!/usr/bin/env python3
"""Faalt als de versie van de app (beregeningsplanner/backend/package.json) niet
omhoog is gegaan t.o.v. een eerdere git-ref.

De versie staat op het dashboard en in /api/health; zo is altijd te zien welke
build draait. Zolang de tijdelijke Home Assistant-verpakking (config.yaml)
bestaat, moet de versie daarin gelijk zijn.
"""
import json
import os
import re
import subprocess
import sys

ADDON_DIR = "beregeningsplanner"
PACKAGE_PATH = f"{ADDON_DIR}/backend/package.json"
CONFIG_PATH = f"{ADDON_DIR}/config.yaml"


def parse(version):
    return tuple(int(p) for p in version.split("."))


def package_version(text):
    return parse(json.loads(text)["version"])


def config_version(text):
    match = re.search(r'^version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?', text, re.MULTILINE)
    return parse(match.group(1)) if match else None


def git_show(ref, path):
    result = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def read_version_at_ref(ref):
    """Versie op ref: config.yaml was tot 0.13.0 de bron, daarna package.json."""
    versions = []
    pkg = git_show(ref, PACKAGE_PATH)
    if pkg:
        versions.append(package_version(pkg))
    cfg = git_show(ref, CONFIG_PATH)
    if cfg and config_version(cfg):
        versions.append(config_version(cfg))
    return max(versions) if versions else None


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

    with open(PACKAGE_PATH, encoding="utf-8") as f:
        new_version = package_version(f.read())
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = config_version(f.read())
        if cfg != new_version:
            raise SystemExit(f"FOUT: versie in {CONFIG_PATH} wijkt af van {PACKAGE_PATH}.")

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
            f"FOUT: de versie in {PACKAGE_PATH} is niet hoger dan de vorige "
            "commit. Verhoog 'version' (en zolang die bestaat ook die in "
            f"{CONFIG_PATH})."
        )


if __name__ == "__main__":
    main()
