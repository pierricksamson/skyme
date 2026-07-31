"""
Script one-shot : pré-télécharge dans storage/wiki_cache.json le résumé
Wikipedia (image + description) de tous les objets du catalogue Skyme
(Soleil, Lune, planètes, étoiles, deep-sky, astéroïdes, comètes, satellites).

Réutilise directement la logique de résolution de titre et de détection de
désambiguïsation de app.py (fetch_wikipedia_summary), pour ne jamais avoir
deux implémentations divergentes du même algorithme.

Usage :
    python wiki.py                # ne télécharge que ce qui manque dans le cache
    python wiki.py --retry-nulls  # retélécharge aussi les entrées déjà en
                                   # cache mais vides (image ET description
                                   # à null) : utile après une amélioration
                                   # de la logique de résolution de titre
    python wiki.py --force        # re-télécharge tout, même ce qui est déjà en cache
"""
import argparse
import time

from catalog import STARS, DEEP_SKY
from space_objects import ASTEROIDS, COMETS, SATELLITE_NORAD_ID

# Réutilise le cache + la logique de résolution/désambiguïsation de app.py
# plutôt que d'en dupliquer une version appauvrie ici.
import app as skyme_app

PLANETS = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]


def collect_items():
    """Liste (name, category) de tous les objets du catalogue. `category`
    permet à _wiki_title_candidates de prioriser le bon suffixe
    désambiguïsateur (cf. app.py)."""
    items = [("Sun", "sun"), ("Moon", "moon")]
    items += [(p, "planet") for p in PLANETS]
    items += [(n, "star") for n, *_rest in STARS]
    items += [(n, kind) for n, _ra, _dec, _mag, kind in DEEP_SKY]
    items += [(n, "asteroid") for n in ASTEROIDS]
    items += [(n, "comet") for n in COMETS]
    items += [(n, "satellite") for n in SATELLITE_NORAD_ID]

    seen, result = set(), []
    for name, category in items:
        if name not in seen:
            seen.add(name)
            result.append((name, category))
    return result


def is_empty(entry):
    return not entry.get("image") and not entry.get("description")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true",
                         help="re-télécharge tout, même le cache existant")
    parser.add_argument("--retry-nulls", action="store_true",
                         help="re-télécharge uniquement les entrées déjà en "
                              "cache mais vides (image et description nulles)")
    args = parser.parse_args()

    items = collect_items()
    cache = skyme_app._WIKI_CACHE  # chargé depuis le disque à l'import de app.py

    if args.force:
        todo = items
    elif args.retry_nulls:
        todo = [(n, c) for n, c in items if n not in cache or is_empty(cache[n])]
    else:
        todo = [(n, c) for n, c in items if n not in cache]

    print(f"{len(items)} objets au total, {len(todo)} à télécharger.")

    for i, (name, category) in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {name} ({category})")
        # fetch_wikipedia_summary court-circuite si `name` est déjà en
        # cache : on retire l'entrée existante pour forcer un nouveau fetch
        # (cas --force / --retry-nulls).
        cache.pop(name, None)
        result = skyme_app.fetch_wikipedia_summary(name, category)
        if is_empty(result):
            print(f"  -> aucune donnée trouvée pour {name}")
        time.sleep(0.1)

    print(f"Terminé. Cache : {skyme_app._WIKI_CACHE_PATH} ({len(cache)} entrées).")


if __name__ == "__main__":
    main()