"""
Valeurs par défaut et constantes de configuration côté serveur pour Skyme.

Centralise ce qui était auparavant dispersé (littéraux en dur) dans app.py
et db.py : réglages généraux utilisateur, paramètres de plan, calcul du
ciel (agenda, timeline), etc. Toute valeur par défaut modifiable doit vivre
ici, pas ailleurs.
"""

v ='v0.6+'

# ---------- Rafraîchissement automatique des données orbitales ----------

# Éléments orbitaux des astéroïdes/comètes (JPL Horizons) : durée de vie du
# cache disque avant nouvelle requête réseau. Ces éléments dérivent lentement
# (perturbations planétaires, forces non-gravitationnelles pour les comètes)
# donc un rafraîchissement quotidien suffit largement à rester précis.
ORBITAL_ELEMENTS_TTL_SEC = 24 * 3600

# TLE des satellites (Celestrak) : durée de vie du cache disque. Un TLE se
# périme beaucoup plus vite (l'ISS corrige régulièrement son orbite), d'où
# un rafraîchissement plus fréquent.
TLE_CACHE_TTL_SEC = 6 * 3600

# ---------- Calcul du ciel (timeline / agenda / plans) ----------

# Hauteur minimale (degrés) au-dessus de l'horizon pour qu'un objet soit
# considéré "visible".
DEFAULT_MIN_ALT = 10.0

# Hauteur minimale spécifique au Soleil (dépression standard, tient compte
# de la réfraction atmosphérique) pour calculer le lever/coucher réel.
SUN_MIN_ALT = -0.83

# Pas de temps (minutes) pour l'échantillonnage des trajectoires d'objets.
# Conservé pour compat (find_night_window utilise encore une grille fine
# sur le Soleil, calcul unique donc peu coûteux).
STEP_MINUTES = 4

# ---------- astro_fast : scan grossier "coarse-to-fine" ----------
# Corps lents (Soleil, Lune, planètes, astéroïdes, comètes) : la courbe
# d'altitude est très lisse, un pas large + spline cubique suffit très
# largement à la précision cible (±1 min / ±0.1°).
MOVING_COARSE_STEP_MIN = 30
# Satellites : passages courts (qqs minutes), pas plus fin pour ne pas
# rater un passage bref entre deux points du scan grossier.
SATELLITE_COARSE_STEP_MIN = 3
# Recherche étendue (jusqu'à plusieurs dizaines de jours, ex. Lune/planètes
# hors de portée immédiate) : déclinaison variant lentement, pas très large.
EXTENDED_COARSE_STEP_MIN = 180

# Plage horaire par défaut : mode "margin" (marge en minutes autour du
# coucher/lever du soleil) ou "fixed" (heures murales fixes).
DEFAULT_PREF_MODE = "margin"
DEFAULT_MARGIN_MIN = 30
DEFAULT_FIXED_START = "20:00"
DEFAULT_FIXED_END = "06:00"
DEFAULT_FIXED_START_H, DEFAULT_FIXED_START_M = 20, 0
DEFAULT_FIXED_END_H, DEFAULT_FIXED_END_M = 6, 0

# Position par défaut (mode auto = géolocalisation navigateur).
DEFAULT_LOC_MODE = "auto"
DEFAULT_LOC_ELEV = 0.0

# Affichage / zoom timeline.
DEFAULT_ZOOM_MODE = "auto"
DEFAULT_ZOOM_VALUE = 1.0
DEFAULT_RED_FILTER = False

# ---------- Agenda ----------

# Nombre maximal de jours calculables en une requête (protection perf).
AGENDA_MAX_RANGE_DAYS = 60

# ---------- Plans de soirée ("Prévoir") ----------

PLAN_OBJECTS_MAX = 200
PLAN_NOTE_MAX_LEN = 2000

# Champs de paramètres propres à un plan (lieu, plage horaire, altitude
# min), partagés entre app.py et db.py.
PLAN_SETTINGS_KEYS = [
    "loc_mode", "loc_lat", "loc_lon", "loc_elev",
    "pref_mode", "pref_margin", "pref_fixed_start", "pref_fixed_end",
    "pref_min_alt",
]

# ---------- Réglages généraux utilisateur (table settings) ----------

DEFAULT_SETTINGS = {
    "zoom_mode": DEFAULT_ZOOM_MODE,
    "zoom_value": DEFAULT_ZOOM_VALUE,
    "pref_mode": DEFAULT_PREF_MODE,
    "pref_margin": DEFAULT_MARGIN_MIN,
    "pref_fixed_start": DEFAULT_FIXED_START,
    "pref_fixed_end": DEFAULT_FIXED_END,
    "pref_min_alt": DEFAULT_MIN_ALT,
    "red_filter": DEFAULT_RED_FILTER,
    "loc_mode": DEFAULT_LOC_MODE,
    "loc_lat": None,
    "loc_lon": None,
    "loc_elev": DEFAULT_LOC_ELEV,
}