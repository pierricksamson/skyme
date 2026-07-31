"""
Script one-shot : pré-télécharge dans storage/wiki_cache.json le résumé
Wikipedia (image + description) de tous les objets du catalogue Skyme
(Soleil, Lune, planètes, étoiles, deep-sky, astéroïdes, comètes, satellites).

Usage :
    python wiki.py            # ne télécharge que ce qui manque dans le cache
    python wiki.py --force    # re-télécharge tout, même ce qui est déjà en cache
"""
import json
import os
import re
import sys
import time

import requests

from catalog import STARS, DEEP_SKY
from space_objects import ASTEROIDS, COMETS, SATELLITE_NORAD_ID

CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage", "wiki_cache.json")
PLANETS = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]


def collect_names():
    names = ["Sun", "Moon"] + PLANETS
    names += [n for n, *_ in STARS]
    names += [n for n, *_ in DEEP_SKY]
    names += list(ASTEROIDS)
    names += list(COMETS)
    names += list(SATELLITE_NORAD_ID)
    # dédoublonnage en préservant l'ordre
    seen = set()
    result = []
    for n in names:
        if n not in seen:
            seen.add(n)
            result.append(n)
    return result


def wiki_title(name):
    stripped = re.sub(r"^M\d+\s+", "", name).strip()
    return stripped or name


def fetch_summary(title):
    result = {"image": None, "description": None}
    try:
        resp = requests.get(
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
            + requests.utils.quote(wiki_title(title)),
            headers={"User-Agent": "Skyme/1.0 (astronomy app; contact: admin@skyme.local)"},
            timeout=8,
        )
        if resp.ok:
            data = resp.json()
            thumb = data.get("thumbnail") or data.get("originalimage")
            if thumb:
                result["image"] = thumb.get("source")
            result["description"] = data.get("extract")
    except requests.RequestException as e:
        print(f"  [erreur] {title}: {e}")
    return result


def load_cache():
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_cache(cache):
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp_path = CACHE_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, CACHE_PATH)


def main():
    force = "--force" in sys.argv
    names = collect_names()
    cache = load_cache()

    todo = names if force else [n for n in names if n not in cache]
    print(f"{len(names)} objets au total, {len(todo)} à télécharger.")

    for i, name in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {name}")
        cache[name] = fetch_summary(name)
        save_cache(cache)
        time.sleep(0.1)

    print(f"Terminé. Cache : {CACHE_PATH} ({len(cache)} entrées).")


if __name__ == "__main__":
    main()