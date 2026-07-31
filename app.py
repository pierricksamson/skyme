import json
import os
import re
import warnings
from functools import wraps
from threading import Lock

from flask import Flask, render_template, request, jsonify, redirect, url_for, send_from_directory
from datetime import datetime, timezone, timedelta
import numpy as np

warnings.filterwarnings("ignore", category=UserWarning, module="astropy")

from astropy.utils import iers
iers.conf.auto_download = True

from astropy.time import Time
from astropy.coordinates import (
    EarthLocation, AltAz, SkyCoord, get_body, get_sun,
    get_body_barycentric, GeocentricTrueEcliptic
)
import astropy.units as u
import requests

import astro_fast
from catalog import STARS, DEEP_SKY, CATEGORY_COLOR
from space_objects import (
    ASTEROIDS, COMETS, SATELLITE_NORAD_ID,
    asteroid_factory, comet_factory, satellite_factory,
    asteroid_magnitude, comet_magnitude, satellite_magnitude,
)
import config
from db import (
    init_db, verify_user, create_session, get_user_by_session,
    delete_session, get_settings, update_settings,
    get_favorites, toggle_favorite,
    get_plan, save_plan, delete_plan, get_plan_counts, list_plans,
    add_journal_entry, get_journal, delete_journal_entry,
)

app = Flask(__name__)
init_db()

# Cookie de session : pas d'expiration fonctionnelle (10 ans ~ "à vie").
SESSION_COOKIE_NAME = "skyme_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 365 * 10


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        token = request.cookies.get(SESSION_COOKIE_NAME)
        user = get_user_by_session(token)
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"error": "authentication required"}), 401
            return redirect(url_for("login", next=request.path))
        request.user = user
        return view(*args, **kwargs)
    return wrapped


# ---------- Résumé Wikipedia (image carrée + description) pour la popup info ----------
# Cache persistant sur disque (wiki_cache.json) : évite de re-solliciter
# l'API Wikipedia à chaque ouverture de la popup pour un même objet, y
# compris entre deux redémarrages du process serveur (économie d'appels API).
_WIKI_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage", "wiki_cache.json")
_WIKI_CACHE_LOCK = Lock()


def _load_wiki_cache():
    try:
        with open(_WIKI_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_wiki_cache(cache):
    tmp_path = _WIKI_CACHE_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, _WIKI_CACHE_PATH)


_WIKI_CACHE = _load_wiki_cache()


WIKI_TITLE_OVERRIDES = {
    "Cérès": "Ceres (dwarf planet)",
    "Pallas": "2 Pallas",
    "Junon": "3 Juno",
    "Vesta": "4 Vesta",
    "2P/Encke": "Comet Encke",
    "67P/Churyumov-Gerasimenko": "67P/Churyumov–Gerasimenko",
    "21P/Giacobini-Zinner": "21P/Giacobini–Zinner",
    "ISS (station spatiale)": "International Space Station",
    "Télescope Hubble": "Hubble Space Telescope",
    "Tiangong (station chinoise)": "Tiangong space station",
    "M13 Hercules Cluster": "Messier 13",
    "M15 Pegasus Cluster": "Messier 15",
    "M22 Sagittarius Cluster": "Messier 22",
    "M106 Galaxy": "Messier 106",
    "Melotte 25 Hyades": "Hyades (star cluster)",
    "Sharpless 2-155 Cave Nebula": "Cave Nebula",
    "Azha": "Eta Eridani",
    "Ain": "Epsilon Tauri",
    "Mercury": "Mercury (planet)",

    # --- Noms d'étoiles dont la page Wikipedia brute est soit une
    # désambiguïsation non taguée comme telle par l'API REST, soit une page
    # sans rapport (ville, objet du quotidien...). Identifiés dans
    # wiki_cache.json : image/description null ou description du style
    # "X may refer to:". Override direct plutôt que suffixe " (star)" car
    # ce dernier ne mène pas toujours à la bonne page.
    "Merak": "Merak (star)",
    "Sadr": "Sadr (star)",
    "Naos": "Naos (star)",
    "Izar": "Izar (star)",
    "Wasat": "Wasat (star)",
    "Atria": "Atria (star)",
    "Castor": "Castor (star)",
    "Pollux": "Pollux (star)",
    "Chara": "Chara (star)",
    "Asterion": "Cor Caroli",       # doublon de coordonnées avec Cor Caroli
    "Al Nath": "Elnath",
    "Gienah": "Gamma Corvi",
    "Kraz": "Beta Corvi",
    "Turais": "Iota Carinae",
    "Han": "Zeta Ophiuchi",
    "Kuma": "Nu Draconis",
    "Talitha": "Iota Ursae Majoris",
    "Markab": "Alpha Pegasi",
    "Alnair": "Alpha Gruis",
    "Merga": "38 Boötis",
}

_WIKI_CATEGORY_SUFFIX = {"star": " (star)", "planet": " (planet)"}

_WIKI_GENERIC_SUFFIXES = {
    "galaxy", "galaxies", "nebula", "cluster",
    "open cluster", "globular cluster", "star cluster",
}

_WIKI_LEADING_CATALOG_RE = re.compile(r"^(M|NGC|IC)\s*(\d+)\s*(.*)$")
_WIKI_TRAILING_CATALOG_RE = re.compile(r"^(.*?)\s+(NGC|IC|M)\s*(\d+)$")

# Détecte les pages "X may refer to:" / "X refers to:" que l'API REST ne
# tague pas toujours avec type == "disambiguation" (cas fréquent pour les
# noms d'étoiles qui sont aussi des noms de lieux/objets courants).
_DISAMBIG_TEXT_RE = re.compile(r"^.{0,60}?\b(may refer to|refers to)\b", re.I)


def _wiki_title_candidates(name, category=None):
    """Construit la liste ordonnée des titres Wikipedia à essayer pour un
    nom d'objet affiché dans l'app (nom usuel, identifiant de catalogue,
    override explicite, nom brut en dernier recours). `category` (star,
    planet, ...) permet de prioriser un suffixe désambiguïsateur avant le
    nom brut quand on sait par avance qu'il risque d'être ambigu."""
    candidates = []

    override = WIKI_TITLE_OVERRIDES.get(name)
    if override:
        candidates.append(override)

    m = _WIKI_LEADING_CATALOG_RE.match(name)
    t = _WIKI_TRAILING_CATALOG_RE.match(name)
    if m:
        prefix, num, rest = m.group(1), m.group(2), m.group(3).strip()
        catalog_id = f"Messier {num}" if prefix == "M" else f"{prefix} {num}"
        if rest and rest.lower() not in _WIKI_GENERIC_SUFFIXES:
            candidates.append(rest)
        candidates.append(catalog_id)
        if prefix == "M":
            candidates.append(f"M{num}")
    elif t:
        rest, prefix, num = t.group(1).strip(), t.group(2), t.group(3)
        catalog_id = f"Messier {num}" if prefix == "M" else f"{prefix} {num}"
        if rest and rest.lower() not in _WIKI_GENERIC_SUFFIXES:
            candidates.append(rest)
        candidates.append(catalog_id)
        if prefix == "M":
            candidates.append(f"M{num}")
    else:
        suffix = _WIKI_CATEGORY_SUFFIX.get(category)
        if suffix:
            candidates.append(f"{name}{suffix}")
        candidates.append(name)
        candidates.append(f"{name} (star)")
        candidates.append(f"{name} (planet)")

    candidates.append(name)

    seen, out = set(), []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _looks_like_disambiguation(api_data, description):
    """L'API REST de Wikipedia tague type == 'disambiguation' pour les vraies
    pages de désambiguïsation, mais certaines pages "X may refer to:" (noms
    d'étoiles homonymes de lieux/objets) ne sont pas taguées ainsi. On
    complète donc par une détection textuelle du même motif."""
    if api_data.get("type") == "disambiguation":
        return True
    if description and _DISAMBIG_TEXT_RE.match(description):
        return True
    return False


def _fetch_wiki_page(title):
    """Interroge l'API REST Wikipedia pour un titre de page donné. Renvoie
    toujours un dict {'image', 'description'} (valeurs à None si absentes
    ou si la page est une page de désambiguïsation, qui n'apporte aucune
    info exploitable sur l'objet précis)."""
    result = {"image": None, "description": None}
    try:
        resp = requests.get(
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
            + requests.utils.quote(title),
            headers={"User-Agent": "Skyme/1.0 (astronomy app; contact: admin@skyme.local)"},
            timeout=5,
        )
        if resp.ok:
            data = resp.json()
            description = data.get("extract")
            if _looks_like_disambiguation(data, description):
                return result
            thumb = data.get("thumbnail") or data.get("originalimage")
            if thumb:
                result["image"] = thumb.get("source")
            result["description"] = description
    except requests.RequestException:
        pass
    return result


def fetch_wikipedia_summary(name, category=None):
    """Récupère un court résumé Wikipedia (image miniature + description)
    pour un objet de l'app, en essayant plusieurs titres candidats jusqu'à
    obtenir un résultat exploitable. Retourne toujours un dict avec les clés
    'image' et 'description' (à None si indisponible pour tous les
    candidats / hors-ligne)."""
    with _WIKI_CACHE_LOCK:
        if name in _WIKI_CACHE:
            return _WIKI_CACHE[name]

    result = {"image": None, "description": None}
    for title in _wiki_title_candidates(name, category):
        result = _fetch_wiki_page(title)
        if result["image"] or result["description"]:
            break

    with _WIKI_CACHE_LOCK:
        _WIKI_CACHE[name] = result
        _save_wiki_cache(_WIKI_CACHE)
    return result


@app.route("/api/object-info")
@login_required
def object_info():
    name = (request.args.get("name") or "").strip()
    category = (request.args.get("category") or "").strip() or None
    if not name:
        return jsonify({"error": "name required"}), 400
    return jsonify(fetch_wikipedia_summary(name, category))


STEP_MINUTES = config.STEP_MINUTES

# Approximate mean apparent magnitudes (true planetary magnitude depends on
# phase & sun-earth-planet distance, but fixed values keep the app fully
# offline and fast).
PLANET_MAG = {
    "Mercury": -0.4,
    "Venus": -4.4,
    "Mars": -0.5,
    "Jupiter": -2.2,
    "Saturn": 0.5,
    "Uranus": 5.7,
    "Neptune": 7.8,
}
PLANET_BODY_NAME = {
    "Mercury": "mercury", "Venus": "venus", "Mars": "mars",
    "Jupiter": "jupiter", "Saturn": "saturn",
    "Uranus": "uranus", "Neptune": "neptune",
}
SYNODIC_MONTH_DAYS = 29.530588853

def moon_magnitude(t, location):
    """Rough phase-based Moon magnitude estimate."""
    moon = get_body("moon", t, location)
    sun = get_sun(t)
    elongation = moon.separation(sun).deg  # 0 = new moon side, 180 = full
    illum = (1 - np.cos(np.radians(elongation))) / 2  # 0..1
    illum = max(illum, 0.01)
    return round(-12.7 + 2.5 * np.log10(1 / illum), 2)

def _heliocentric_distance_au(body_key, t):
    pos = get_body_barycentric(body_key, t)
    sun_pos = get_body_barycentric("sun", t)
    return float((pos - sun_pos).norm().to(u.au).value)


def _planet_phase_geometry(body_key, t, location):
    """r = distance Soleil-planète (UA), delta = distance observateur-planète
    (UA), R = distance Soleil-Terre (UA), i = angle de phase (degrés,
    Soleil-planète-Terre). 100% hors-ligne (éphéméride intégrée Astropy)."""
    geocentric = get_body(body_key, t, location)
    delta = float(geocentric.distance.to(u.au).value)
    r = _heliocentric_distance_au(body_key, t)
    R = _heliocentric_distance_au("earth", t)
    cos_i = (r ** 2 + delta ** 2 - R ** 2) / (2 * r * delta)
    cos_i = min(1.0, max(-1.0, cos_i))
    i = float(np.degrees(np.arccos(cos_i)))
    return r, delta, R, i


def compute_planet_magnitude(pname, body_key, t, location):
    """Magnitude apparente approx., basée sur la phase et les distances
    Soleil-planète-Terre (formules empiriques classiques, Meeus,
    Astronomical Algorithms ch. 41). Toujours hors-ligne."""
    try:
        r, delta, _R, i = _planet_phase_geometry(body_key, t, location)
    except Exception:
        return PLANET_MAG.get(pname)

    if pname == "Mercury":
        v1 = -0.42 + 0.0380 * i - 0.000273 * i ** 2 + 0.000002 * i ** 3
    elif pname == "Venus":
        v1 = -4.40 + 0.0009 * i + 0.000239 * i ** 2 - 0.00000065 * i ** 3
    elif pname == "Mars":
        v1 = -1.52 + 0.016 * i
    elif pname == "Jupiter":
        v1 = -9.40 + 0.005 * i
    elif pname == "Saturn":
        # Contribution des anneaux ignorée (nécessiterait leur angle
        # d'ouverture vu depuis la Terre) : approximation raisonnable.
        v1 = -8.88
    elif pname == "Uranus":
        v1 = -7.19
    elif pname == "Neptune":
        v1 = -6.87
    else:
        v1 = 0.0

    try:
        return round(v1 + 5 * np.log10(r * delta), 2)
    except (ValueError, ZeroDivisionError):
        return PLANET_MAG.get(pname)


def _moon_phase_angle_deg(t):
    """0°=nouvelle lune, 90°=1er quartier, 180°=pleine lune, 270°=dernier
    quartier — différence de longitude écliptique géocentrique Lune-Soleil."""
    moon = get_body("moon", t).transform_to(GeocentricTrueEcliptic(equinox=t))
    sun = get_sun(t).transform_to(GeocentricTrueEcliptic(equinox=t))
    return float((moon.lon.deg - sun.lon.deg) % 360)


_MOON_PHASE_BUCKETS = [
    (22.5, "Nouvelle lune"), (67.5, "Premier croissant"),
    (112.5, "Premier quartier"), (157.5, "Lune gibbeuse croissante"),
    (202.5, "Pleine lune"), (247.5, "Lune gibbeuse décroissante"),
    (292.5, "Dernier quartier"), (337.5, "Dernier croissant"),
    (360.01, "Nouvelle lune"),
]


def moon_phase_info(t):
    diff = _moon_phase_angle_deg(t)
    illum = (1 - np.cos(np.radians(diff))) / 2
    waxing = diff < 180
    age_days = diff / 360.0 * SYNODIC_MONTH_DAYS
    days_to_full = ((180 - diff) if diff <= 180 else (540 - diff)) / 360.0 * SYNODIC_MONTH_DAYS
    days_to_new = (360 - diff) / 360.0 * SYNODIC_MONTH_DAYS
    name = next(label for limit, label in _MOON_PHASE_BUCKETS if diff < limit)

    return {
        "kind": "moon",
        "illumination": round(illum * 100, 1),
        "phase_angle_deg": round(diff, 1),
        "phase_name": name,
        "waxing": bool(waxing),
        "age_days": round(age_days, 1),
        "days_to_full_moon": round(days_to_full, 1),
        "days_to_new_moon": round(days_to_new, 1),
        "synodic_month_days": round(SYNODIC_MONTH_DAYS, 2),
    }


def planet_phase_info(pname, body_key, t, location):
    r, delta, R, i = _planet_phase_geometry(body_key, t, location)
    illum = (1 + np.cos(np.radians(i))) / 2

    # Tendance croissante/décroissante : on compare l'illumination à J+1.
    # Plus l'angle de phase i diminue, plus l'illumination augmente.
    try:
        _r2, delta2, _R2, i2 = _planet_phase_geometry(body_key, t + 1 * u.day, location)
        illum2 = (1 + np.cos(np.radians(i2))) / 2
        waxing = bool(illum2 > illum)
    except Exception:
        waxing = None

    return {
        "kind": "planet",
        "illumination": round(illum * 100, 1),
        "phase_angle_deg": round(i, 1),
        "distance_earth_au": round(delta, 3),
        "distance_sun_au": round(r, 3),
        "waxing": waxing,
    }

def find_night_window(location, now_utc, min_alt=config.DEFAULT_MIN_ALT):
    """Sample the sun's altitude across the next ~36h to find the coming
    moment it crosses below `min_alt` (sunset, or dusk) and the following
    moment it crosses back above it (sunrise, or dawn)."""
    t0 = Time(now_utc)
    minutes = np.arange(0, 36 * 60, 5)
    times = t0 + minutes * u.minute
    frame = AltAz(obstime=times, location=location)
    sun_alt = get_sun(times).transform_to(frame).alt.deg

    sunset_t = None
    sunrise_t = None
    for i in range(1, len(sun_alt)):
        if sunset_t is None and sun_alt[i - 1] > min_alt >= sun_alt[i]:
            sunset_t = _interp_time(times[i - 1], times[i], sun_alt[i - 1], sun_alt[i], min_alt)
        elif sunset_t is not None and sunrise_t is None and sun_alt[i - 1] < min_alt <= sun_alt[i]:
            sunrise_t = _interp_time(times[i - 1], times[i], sun_alt[i - 1], sun_alt[i], min_alt)
            break

    if sunset_t is None or sunrise_t is None:
        sunset_t = t0
        sunrise_t = t0 + 10 * u.hour
    return sunset_t, sunrise_t


def _interp_time(t0, t1, v0, v1, target):
    if v1 == v0:
        frac = 0.0
    else:
        frac = (target - v0) / (v1 - v0)
    frac = min(max(frac, 0.0), 1.0)
    return t0 + frac * (t1 - t0)


def _coarse_step_for(category):
    """Pas du scan grossier (minutes) selon la catégorie : les satellites
    ont des passages courts (qqs minutes) et gardent un pas fin ; les
    autres corps mobiles (Soleil, Lune, planètes, astéroïdes, comètes)
    ont une trajectoire lisse et tolèrent un pas large (cf. astro_fast)."""
    return config.SATELLITE_COARSE_STEP_MIN if category == "satellite" \
        else config.MOVING_COARSE_STEP_MIN


def find_rise_set_event(coord_factory, location, t_ref, min_alt=config.DEFAULT_MIN_ALT,
                         extended_days=None, category=None):
    """Vrai lever/coucher encadrant t_ref (ou le prochain), non limité par
    une fenêtre d'affichage. Étoiles/ciel profond (RA/Dec fixes, marquées
    via `coord_factory.fixed_radec`) : formule analytique exacte, O(1),
    aucun échantillonnage. Corps mobiles : scan grossier + spline cubique
    + recherche de racine (astro_fast.find_rise_set_event_fast)."""
    fixed = getattr(coord_factory, "fixed_radec", None)
    if fixed is not None:
        ra_deg, dec_deg = fixed
        return astro_fast.find_rise_set_analytic(ra_deg, dec_deg, location.lat.deg,
                                                   location, t_ref, min_alt)
    return astro_fast.find_rise_set_event_fast(
        coord_factory, location, t_ref, min_alt,
        coarse_step_minutes=_coarse_step_for(category),
        extended_days=extended_days,
        extended_step_minutes=config.EXTENDED_COARSE_STEP_MIN)


def compute_object(coord_factory, name, category, fixed_mag, t_start, t_end,
                    location, min_alt=config.DEFAULT_MIN_ALT, is_moon=False,
                    is_favorite=False, is_planet=False, planet_body_key=None, mag_func=None):
    """Étoiles/ciel profond : délègue à batch_fixed_rise_set (N=1) via
    astro_fast, entièrement analytique. Corps mobiles : scan grossier +
    spline cubique + brentq (astro_fast.find_visibility_window_fast),
    remplaçant l'ancienne grille fine (STEP_MINUTES) sur toute la
    fenêtre d'affichage."""
    fixed = getattr(coord_factory, "fixed_radec", None)
    if fixed is not None:
        ra_deg, dec_deg = fixed
        batch = astro_fast.batch_fixed_rise_set(
            np.array([ra_deg]), np.array([dec_deg]), location.lat.deg,
            location, t_start, t_end, min_alt)
        if not bool(batch["visible"][0]):
            return None
        return astro_fast.build_fixed_result(
            name, category, fixed_mag, CATEGORY_COLOR[category], batch, 0,
            is_favorite=is_favorite)

    coarse_step = _coarse_step_for(category)
    win = astro_fast.find_visibility_window_fast(
        coord_factory, location, t_start, t_end, min_alt,
        coarse_step_minutes=coarse_step)
    if win is None:
        return None
    rise_t, set_t, peak_t = win["rise_t"], win["set_t"], win["peak_t"]
    peak_alt = win["peak_alt"]

    mag = fixed_mag
    if is_moon:
        mag = moon_magnitude(peak_t, location)
    elif is_planet and planet_body_key:
        mag = compute_planet_magnitude(name, planet_body_key, peak_t, location)
    elif mag_func is not None:
        try:
            mag = mag_func(peak_t, location)
        except Exception:
            mag = fixed_mag

    duration_min = (set_t - rise_t).sec / 60.0

    true_event = astro_fast.find_rise_set_event_fast(
        coord_factory, location, peak_t, min_alt, coarse_step_minutes=coarse_step)

    return {
        "name": name,
        "category": category,
        "color": CATEGORY_COLOR[category],
        "rise_iso": rise_t.utc.isot + "Z",
        "set_iso": set_t.utc.isot + "Z",
        "duration_min": round(duration_min),
        "peak_altitude": round(peak_alt, 1),
        "magnitude": round(mag, 2) if mag is not None else None,
        "touches_start": bool(win["touches_start"]),
        "touches_end": bool(win["touches_end"]),
        "favorite": bool(is_favorite),
        "true_rise_iso": true_event["rise_iso"],
        "true_set_iso": true_event["set_iso"],
        "always_visible": true_event["always_visible"],
        "never_visible": true_event["never_visible"],
        "up_now": true_event["up_now"],
    }


def _batch_fixed_objects(catalog_rows, location, t_start, t_end, min_alt, favorites):
    """Calcule d'un coup (un seul appel numpy vectorisé, aucun AltAz) le
    lever/coucher/pic de TOUS les objets à RA/Dec fixes (étoiles + ciel
    profond) fournis. `catalog_rows` : liste de (name, category, ra, dec, mag)."""
    if not catalog_rows:
        return []
    ra = np.array([r[2] for r in catalog_rows])
    dec = np.array([r[3] for r in catalog_rows])
    batch = astro_fast.batch_fixed_rise_set(ra, dec, location.lat.deg, location,
                                             t_start, t_end, min_alt)
    out = []
    for i, (name, category, _ra, _dec, mag) in enumerate(catalog_rows):
        if not bool(batch["visible"][i]):
            continue
        out.append(astro_fast.build_fixed_result(
            name, category, mag, CATEGORY_COLOR[category], batch, i,
            is_favorite=(name in favorites)))
    return out


def assign_lanes(objects):
    """Greedy interval-graph coloring so overlapping blocks land in
    different lanes (no visual overlap)."""
    objs_sorted = sorted(objects, key=lambda o: o["rise_iso"])
    lane_end_iso = []
    for o in objs_sorted:
        placed = False
        for lane_idx, end_iso in enumerate(lane_end_iso):
            if o["rise_iso"] >= end_iso:
                o["lane"] = lane_idx
                lane_end_iso[lane_idx] = o["set_iso"]
                placed = True
                break
        if not placed:
            o["lane"] = len(lane_end_iso)
            lane_end_iso.append(o["set_iso"])
    return objs_sorted, len(lane_end_iso)


@app.route("/")
@login_required
def index():
    return render_template("index.html", username=request.user["username"], v=config.v)


@app.route("/login", methods=["GET", "POST"])
def login():
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if get_user_by_session(token):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        passkey = (request.form.get("passkey") or "").strip()
        user_id = verify_user(username, passkey)
        if user_id is None:
            error = "Identifiant ou passkey invalide."
        else:
            session_token = create_session(user_id)
            resp = redirect(url_for("index"))
            resp.set_cookie(
                SESSION_COOKIE_NAME,
                session_token,
                max_age=SESSION_MAX_AGE,
                httponly=True,
                samesite="Lax",
                secure=request.is_secure,
            )
            return resp

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        delete_session(token)
    resp = redirect(url_for("login"))
    resp.delete_cookie(SESSION_COOKIE_NAME)
    return resp


@app.route("/api/settings", methods=["GET", "POST"])
@login_required
def settings_api():
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        update_settings(request.user["id"], payload)
    return jsonify(get_settings(request.user["id"]))


@app.route("/api/sky")
@login_required
def sky():
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])        
    except (KeyError, ValueError):
        return jsonify({"error": "lat/lon required"}), 400

    date_str = request.args.get("date")
    elev = float(request.args.get("elev", 0) or 0)

    try:
        min_alt = float(request.args.get("min_alt", config.DEFAULT_MIN_ALT))
    except (TypeError, ValueError):
        min_alt = config.DEFAULT_MIN_ALT
    
    if date_str:
        try:
            now_utc = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return jsonify({"error": "date must be formatted YYYY-MM-DD"}), 400
    else:
        now_utc = datetime.now(timezone.utc)

    location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=max(elev, 0) * u.m)

    # Calcul du vrai coucher/lever pour l'affichage
    sunset_t, sunrise_t = find_night_window(location, now_utc, min_alt=-1)

    mode = request.args.get("mode", "margin")
    if mode == "fixed":
        try:
            # Client envoie l'heure exacte en ISO depuis son fuseau local
            fixed_start_str = request.args.get("fixed_start").replace("Z", "+00:00")
            fixed_end_str = request.args.get("fixed_end").replace("Z", "+00:00")
            t_start = Time(datetime.fromisoformat(fixed_start_str))
            t_end = Time(datetime.fromisoformat(fixed_end_str))
        except (KeyError, TypeError, ValueError):
            t_start = sunset_t
            t_end = sunrise_t
    else:
        # Mode Marge (Choix 2)
        try:
            margin = float(request.args.get("margin", config.DEFAULT_MARGIN_MIN))
        except (TypeError, ValueError):
            margin = config.DEFAULT_MARGIN_MIN
            
        t_start = sunset_t - margin * u.minute
        t_end = sunrise_t + margin * u.minute
        
        # Sécurité : Si la marge est trop grande et chevauche le jour
        if t_start >= t_end:
            t_start = sunset_t
            t_end = sunrise_t
    
    favorites = set(get_favorites(request.user["id"]))

    objects = []

    moon_factory = lambda times, loc: get_body("moon", times, loc)
    obj = compute_object(moon_factory, "Moon", "moon", None, t_start, t_end,
                          location, is_moon=True, min_alt=min_alt,
                          is_favorite=("Moon" in favorites))
    if obj:
        objects.append(obj)

    for pname, body_key in PLANET_BODY_NAME.items():
        factory = (lambda times, loc, bk=body_key: get_body(bk, times, loc))
        obj = compute_object(factory, pname, "planet", PLANET_MAG[pname], t_start, t_end,
                            location, min_alt=min_alt,
                            is_favorite=(pname in favorites),
                            is_planet=True, planet_body_key=body_key)

        if obj: 
            objects.append(obj)

    # Étoiles + ciel profond : un unique appel vectorisé (numpy pur, aucun
    # AltAz) au lieu d'une boucle avec échantillonnage par objet.
    fixed_rows = [(name, "star", ra * 15.0, dec, mag) for name, ra, dec, mag in STARS]
    fixed_rows += [(name, kind, ra * 15.0, dec, mag) for name, ra, dec, mag, kind in DEEP_SKY]
    objects.extend(_batch_fixed_objects(fixed_rows, location, t_start, t_end, min_alt, favorites))

    for name in ASTEROIDS:
        factory = asteroid_factory(name)
        obj = compute_object(factory, name, "asteroid", None, t_start, t_end,
                              location, min_alt=min_alt,
                              is_favorite=(name in favorites),
                              mag_func=(lambda t, loc, n=name: asteroid_magnitude(n, t, loc)))
        if obj:
            objects.append(obj)

    for name in COMETS:
        factory = comet_factory(name)
        obj = compute_object(factory, name, "comet", None, t_start, t_end,
                              location, min_alt=min_alt,
                              is_favorite=(name in favorites),
                              mag_func=(lambda t, loc, n=name: comet_magnitude(n, t, loc)))
        if obj:
            objects.append(obj)

    # Objets artificiels (ISS, télescopes en orbite, stations...) : leur
    # visibilité change de nuit en nuit (plusieurs passages/nuit possibles),
    # on ne retient ici que le premier créneau visible de la fenêtre, comme
    # pour tous les autres objets.
    for name, norad_id in SATELLITE_NORAD_ID.items():
        factory = satellite_factory(norad_id)
        obj = compute_object(factory, name, "satellite", None, t_start, t_end,
                              location, min_alt=min_alt,
                              is_favorite=(name in favorites),
                              mag_func=(lambda t, loc, n=name: satellite_magnitude(n, t, loc)))
        if obj:
            objects.append(obj)

    objects_sorted, lane_count = assign_lanes(objects)

    return jsonify({
        "requested_date": date_str,
        "mode": mode,
        "sunset": sunset_t.utc.isot + "Z",
        "sunrise": sunrise_t.utc.isot + "Z",
        "window_start": t_start.utc.isot + "Z",
        "window_end": t_end.utc.isot + "Z",
        "lane_count": lane_count,
        "objects": objects_sorted,
    })


@app.route("/api/catalog/list")
@login_required
def catalog_list():
    favorites = set(get_favorites(request.user["id"]))

    items = [{
        "name": "Sun",
        "category": "sun",
        "magnitude": -26.7,
        "ra": None,
        "dec": None,
        "favorable": False,
        "_min_alt_override": config.SUN_MIN_ALT,
        "_factory": (lambda times, loc: get_body("sun", times, loc)),
    }, {
        "name": "Moon",
        "category": "moon",
        "magnitude": None,
        "ra": None,
        "dec": None,
        "_factory": (lambda times, loc: get_body("moon", times, loc)),
    }]

    for pname, body_key in PLANET_BODY_NAME.items():
        items.append({
            "name": pname,
            "category": "planet",
            "magnitude": PLANET_MAG[pname],
            "ra": None,
            "dec": None,
            "_factory": (lambda times, loc, bk=body_key: get_body(bk, times, loc)),
        })

    for name, ra, dec, mag in STARS:
        fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
        factory = (lambda times, loc, c=fixed_coord: c)
        factory.fixed_radec = (ra * 15.0, dec)  # ra catalogue en heures -> degrés
        items.append({
            "name": name,
            "category": "star",
            "magnitude": mag,
            "ra": round(ra, 4),
            "dec": round(dec, 4),
            "_factory": factory,
        })

    for name, ra, dec, mag, kind in DEEP_SKY:
        fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
        factory = (lambda times, loc, c=fixed_coord: c)
        factory.fixed_radec = (ra * 15.0, dec)
        items.append({
            "name": name,
            "category": kind,
            "magnitude": mag,
            "ra": round(ra, 4),
            "dec": round(dec, 4),
            "_factory": factory,
        })

    for name in ASTEROIDS:
        items.append({
            "name": name,
            "category": "asteroid",
            "magnitude": None,
            "ra": None,
            "dec": None,
            "_factory": asteroid_factory(name),
        })

    for name in COMETS:
        items.append({
            "name": name,
            "category": "comet",
            "magnitude": None,
            "ra": None,
            "dec": None,
            "_factory": comet_factory(name),
        })

    for name, norad_id in SATELLITE_NORAD_ID.items():
        items.append({
            "name": name,
            "category": "satellite",
            "magnitude": None,
            "ra": None,
            "dec": None,
            "_factory": satellite_factory(norad_id),
        })

    # Lever/coucher réel (non limité par une fenêtre d'affichage), calculé
    # uniquement si une position est fournie : avec les paramètres actuels
    # (position, altitude minimale), pour savoir quand un objet se lève et
    # se couche même s'il n'apparaît pas dans le ciel du moment.
    location = None
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
        elev = float(request.args.get("elev", 0) or 0)
        location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=max(elev, 0) * u.m)
    except (KeyError, ValueError, TypeError):
        location = None

    try:
        min_alt = float(request.args.get("min_alt", config.DEFAULT_MIN_ALT))
    except (TypeError, ValueError):
        min_alt = config.DEFAULT_MIN_ALT

    now_utc = datetime.now(timezone.utc)

    for item in items:
        factory = item.pop("_factory")
        item_min_alt = item.pop("_min_alt_override", min_alt)
        # Le Soleil n'est jamais favoritable (objet uniquement de référence
        # dans la bibliothèque, jamais dans la timeline/l'agenda).
        item["favorite"] = (item["name"] in favorites) if item.get("favorable", True) else False
        if location is not None:
            event = find_rise_set_event(factory, location, Time(now_utc), min_alt=item_min_alt,
                                         extended_days=30, category=item["category"])
            item["rise_iso"] = event["rise_iso"]
            item["set_iso"] = event["set_iso"]
            item["always_visible"] = event["always_visible"]
            item["never_visible"] = event["never_visible"]
            item["up_now"] = event["up_now"]
            if item["category"] == "planet":
                item["magnitude"] = compute_planet_magnitude(
                    item["name"], PLANET_BODY_NAME[item["name"]], Time(now_utc), location)
            elif item["category"] == "moon":
                item["magnitude"] = moon_magnitude(Time(now_utc), location)
            elif item["category"] == "asteroid":
                try:
                    item["magnitude"] = asteroid_magnitude(item["name"], Time(now_utc), location)
                except Exception:
                    item["magnitude"] = None
            elif item["category"] == "comet":
                try:
                    item["magnitude"] = comet_magnitude(item["name"], Time(now_utc), location)
                except Exception:
                    item["magnitude"] = None
            elif item["category"] == "satellite":
                try:
                    item["magnitude"] = satellite_magnitude(item["name"], Time(now_utc), location)
                except Exception:
                    item["magnitude"] = None

    items.sort(key=lambda o: o["name"])
    return jsonify({"items": items})

@app.route("/api/phase")
@login_required
def phase_info():
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400

    # Comme pour /api/sky : si un `date` (YYYY-MM-DD) est fourni, la phase est
    # calculée pour cette date plutôt que pour l'instant présent. Ceci permet
    # d'afficher la bonne phase de Lune/planète quand l'objet est consulté
    # depuis l'agenda (nuit future) ou depuis un plan prévu à l'avance
    # (date — et éventuellement lieu — différents d'aujourd'hui/maintenant).
    date_str = request.args.get("date")
    if date_str:
        try:
            now_utc = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return jsonify({"error": "date must be formatted YYYY-MM-DD"}), 400
    else:
        now_utc = datetime.now(timezone.utc)
    t = Time(now_utc)

    if name == "Moon":
        return jsonify(moon_phase_info(t))

    body_key = PLANET_BODY_NAME.get(name)
    if not body_key:
        return jsonify({"error": "not applicable"}), 404

    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except (KeyError, ValueError):
        return jsonify({"error": "lat/lon required"}), 400
    elev = float(request.args.get("elev", 0) or 0)
    location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=max(elev, 0) * u.m)

    return jsonify(planet_phase_info(name, body_key, t, location))

@app.route("/api/favorites", methods=["GET"])
@login_required
def favorites_list():
    return jsonify({"favorites": get_favorites(request.user["id"])})


@app.route("/api/favorites/toggle", methods=["POST"])
@login_required
def favorites_toggle():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    is_favorite = toggle_favorite(request.user["id"], name)
    return jsonify({"name": name, "favorite": is_favorite})



# Champs de paramètres propres à un plan (lieu, plage horaire, altitude
# min) : mêmes clés que la table `plans` / PLAN_SETTINGS_FIELDS dans db.py,
# définies une seule fois dans config.py.
PLAN_SETTINGS_KEYS = config.PLAN_SETTINGS_KEYS

# Correspondance entre les réglages globaux de l'utilisateur (table
# `settings`) et les champs d'un plan : sert de valeur par défaut lorsqu'on
# crée un nouveau plan sans préciser explicitement ses propres paramètres
# ("toujours ceux que j'ai" par défaut, mais personnalisables ensuite).
def _default_plan_settings_from_user(user_id):
    settings = get_settings(user_id)
    return {key: settings.get(key) for key in PLAN_SETTINGS_KEYS}


def _plan_to_json(plan):
    return {
        "date": plan["date"],
        "objects": plan["objects"],
        "note": plan["note"],
        "exists": True,
        **{key: plan.get(key) for key in PLAN_SETTINGS_KEYS},
    }


@app.route("/api/plan", methods=["GET", "POST", "DELETE"])
@login_required
def plan_api():
    """Plan de soirée : liste d'objets choisis + note libre + paramètres
    propres au plan (lieu, plage horaire, altitude min), pour un jour donné.
    GET renvoie le plan existant (ou un plan vide), POST crée/met à jour le
    plan du jour indiqué, DELETE le supprime.

    Les paramètres du plan sont optionnels dans le payload POST : ceux non
    fournis reprennent la valeur déjà enregistrée pour ce plan, ou, à la
    création, les réglages généraux de l'utilisateur."""
    date_str = (request.args.get("date") or "").strip()
    if request.method != "GET":
        payload = request.get_json(silent=True) or {}
        date_str = (payload.get("date") or date_str or "").strip()

    if not date_str:
        return jsonify({"error": "date required"}), 400
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "date must be formatted YYYY-MM-DD"}), 400

    if request.method == "DELETE":
        delete_plan(request.user["id"], date_str)
        return jsonify({"date": date_str, "objects": [], "note": "", "exists": False})

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        objects = payload.get("objects")
        if objects is None:
            existing = get_plan(request.user["id"], date_str)
            objects = existing["objects"] if existing else []
        if not isinstance(objects, list):
            return jsonify({"error": "objects must be a list"}), 400
        objects = [str(o) for o in objects][:config.PLAN_OBJECTS_MAX]

        note = payload.get("note")
        if note is None:
            existing = get_plan(request.user["id"], date_str)
            note = existing["note"] if existing else ""
        note = str(note or "")[:config.PLAN_NOTE_MAX_LEN]

        # Résout les paramètres du plan : valeur envoyée > valeur déjà
        # enregistrée pour ce plan > réglage général de l'utilisateur.
        existing_plan = get_plan(request.user["id"], date_str)
        base_settings = (
            {key: existing_plan.get(key) for key in PLAN_SETTINGS_KEYS}
            if existing_plan
            else _default_plan_settings_from_user(request.user["id"])
        )
        incoming_settings = payload.get("settings") or {}
        plan_settings = {
            key: incoming_settings.get(key, base_settings.get(key))
            for key in PLAN_SETTINGS_KEYS
        }

        save_plan(request.user["id"], date_str, objects, note, plan_settings)

    plan = get_plan(request.user["id"], date_str)
    if plan is None:
        return jsonify({"date": date_str, "objects": [], "note": "", "exists": False})
    return jsonify(_plan_to_json(plan))


@app.route("/api/plans", methods=["GET"])
@login_required
def plans_list():
    """Liste tous les plans de l'utilisateur (page Prévoir), avec leurs
    paramètres, pour afficher la liste des soirées prévues."""
    plans = list_plans(request.user["id"])
    return jsonify({"plans": [_plan_to_json(p) for p in plans]})


@app.route("/api/plans/range")
@login_required
def plans_range():
    """Pour une plage de dates, renvoie le nombre d'objets prévus chaque
    jour où un plan existe, afin d'afficher un badge dans l'agenda."""
    try:
        start_date = request.args["start_date"]
        end_date = request.args["end_date"]
        datetime.strptime(start_date, "%Y-%m-%d")
        datetime.strptime(end_date, "%Y-%m-%d")
    except (KeyError, ValueError):
        return jsonify({"error": "start_date/end_date required (YYYY-MM-DD)"}), 400
    counts = get_plan_counts(request.user["id"], start_date, end_date)
    return jsonify({"counts": counts})


@app.route("/api/agenda/favorites-count")
@login_required
def agenda_favorites_count():
    """Pour une plage de dates, renvoie combien d'objets favoris sont
    visibles chaque nuit (compte tenu de la plage horaire choisie et de la
    hauteur minimale), afin d'afficher une bulle '★ N' sur les jours
    concernés dans l'agenda."""
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except (KeyError, ValueError):
        return jsonify({"error": "lat/lon required"}), 400

    elev = float(request.args.get("elev", 0) or 0)

    try:
        min_alt = float(request.args.get("min_alt", config.DEFAULT_MIN_ALT))
    except (TypeError, ValueError):
        min_alt = config.DEFAULT_MIN_ALT

    mode = request.args.get("mode", "margin")
    try:
        margin = float(request.args.get("margin", config.DEFAULT_MARGIN_MIN))
    except (TypeError, ValueError):
        margin = config.DEFAULT_MARGIN_MIN

    # Décalage du fuseau horaire local du navigateur (en minutes, ex: +120
    # pour UTC+2), utilisé uniquement en mode "fixed" : fixed_start_hm /
    # fixed_end_hm sont des heures murales locales ("20:00"), pas UTC. Sans
    # cette correction, on les traitait comme si elles étaient déjà en UTC,
    # ce qui décalait la fenêtre de la nuit d'1 à 2h et faisait apparaître
    # ou disparaître des objets proches du bord de la fenêtre selon
    # l'heure/la saison (d'où un compte de favoris incohérent).
    try:
        tz_offset_min = int(request.args.get("tz_offset_min", 0))
    except (TypeError, ValueError):
        tz_offset_min = 0

    def parse_hm(value, default_h, default_m):
        try:
            h, m = (value or "").split(":")
            return int(h), int(m)
        except (ValueError, AttributeError):
            return default_h, default_m

    start_h, start_m = parse_hm(request.args.get("fixed_start_hm"), config.DEFAULT_FIXED_START_H, config.DEFAULT_FIXED_START_M)
    end_h, end_m = parse_hm(request.args.get("fixed_end_hm"), config.DEFAULT_FIXED_END_H, config.DEFAULT_FIXED_END_M)

    try:
        start_date = datetime.strptime(request.args["start_date"], "%Y-%m-%d")
        end_date = datetime.strptime(request.args["end_date"], "%Y-%m-%d")
    except (KeyError, ValueError):
        return jsonify({"error": "start_date/end_date required (YYYY-MM-DD)"}), 400

    # Garde-fou : on ne calcule jamais plus de 60 jours d'un coup.
    if (end_date - start_date).days > config.AGENDA_MAX_RANGE_DAYS or end_date < start_date:
        return jsonify({"error": "invalid date range"}), 400

    favorite_set = set(get_favorites(request.user["id"]))
    if not favorite_set:
        return jsonify({"counts": {}})

    location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=max(elev, 0) * u.m)

    fav_stars = [s for s in STARS if s[0] in favorite_set]
    fav_deep_sky = [d for d in DEEP_SKY if d[0] in favorite_set]
    fav_planets = [p for p in PLANET_BODY_NAME.items() if p[0] in favorite_set]
    want_moon = "Moon" in favorite_set

    # RA/Dec des favoris fixes précalculés une seule fois (constants sur
    # les 60 jours) : le batch analytique par jour se réduit à un simple
    # appel numpy vectorisé, sans aucune transformation AltAz.
    fixed_names = [s[0] for s in fav_stars] + [d[0] for d in fav_deep_sky]
    fixed_ra = np.array([s[1] * 15.0 for s in fav_stars] + [d[1] * 15.0 for d in fav_deep_sky])
    fixed_dec = np.array([s[2] for s in fav_stars] + [d[2] for d in fav_deep_sky])
    lat_deg = location.lat.deg

    counts = {}
    day = start_date
    while day <= end_date:
        date_str = day.strftime("%Y-%m-%d")
        now_utc = day.replace(tzinfo=timezone.utc)
        sunset_t, sunrise_t = find_night_window(location, now_utc)

        if mode == "fixed":
            # start_h/start_m/end_h/end_m sont des heures locales : on les
            # convertit en UTC via tz_offset_min avant de leur assigner un
            # tzinfo UTC (voir commentaire plus haut).
            local_start = day.replace(hour=start_h, minute=start_m)
            local_end = day.replace(hour=end_h, minute=end_m)
            t_start = Time((local_start - timedelta(minutes=tz_offset_min)).replace(tzinfo=timezone.utc))
            t_end = Time((local_end - timedelta(minutes=tz_offset_min)).replace(tzinfo=timezone.utc))
            if t_end <= t_start:
                t_end = t_end + 1 * u.day
        else:
            t_start = sunset_t - margin * u.minute
            t_end = sunrise_t + margin * u.minute
            if t_start >= t_end:
                t_start, t_end = sunset_t, sunrise_t

        count = 0

        if want_moon:
            moon_factory = lambda times, loc: get_body("moon", times, loc)
            if compute_object(moon_factory, "Moon", "moon", None, t_start, t_end,
                               location, is_moon=True, min_alt=min_alt) is not None:
                count += 1

        for pname, body_key in fav_planets:
            factory = (lambda times, loc, bk=body_key: get_body(bk, times, loc))
            if compute_object(factory, pname, "planet", PLANET_MAG[pname], t_start, t_end,
                               location, min_alt=min_alt) is not None:
                count += 1

        if fixed_names:
            batch = astro_fast.batch_fixed_rise_set(fixed_ra, fixed_dec, lat_deg, location,
                                                      t_start, t_end, min_alt)
            count += int(np.count_nonzero(batch["visible"]))

        if count > 0:
            counts[date_str] = count

        day = day + timedelta(days=1)

    return jsonify({"counts": counts})


@app.route("/api/journal", methods=["GET", "POST"])
@login_required
def journal_api():
    """Historique des observations (vu / tentative échouée). GET renvoie
    la liste triée du plus récent au plus ancien. POST ajoute une entrée."""
    if request.method == "GET":
        return jsonify({"entries": get_journal(request.user["id"])})

    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    category = str(payload.get("category") or "")[:50]
    status = payload.get("status") or "seen"
    if status not in ("seen", "failed"):
        status = "seen"
    date_str = (payload.get("date") or "").strip()
    if not date_str:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "date must be formatted YYYY-MM-DD"}), 400
    time_str = (payload.get("time") or "").strip() or None
    if time_str:
        try:
            datetime.strptime(time_str, "%H:%M")
        except ValueError:
            time_str = None
    note = str(payload.get("note") or "")[:500]

    entry_id = add_journal_entry(request.user["id"], name, category, status, date_str, time_str, note)
    return jsonify({
        "id": entry_id, "object_name": name, "category": category, "status": status,
        "date": date_str, "time": time_str, "note": note,
    })

def _object_factory_and_min_alt(name):
    """Retourne (factory, min_alt_override) pour un nom d'objet du catalogue,
    ou (None, None) si l'objet est inconnu."""
    if name == "Sun":
        return (lambda times, loc: get_body("sun", times, loc)), config.SUN_MIN_ALT
    if name == "Moon":
        return (lambda times, loc: get_body("moon", times, loc)), None
    if name in PLANET_BODY_NAME:
        body_key = PLANET_BODY_NAME[name]
        return (lambda times, loc, bk=body_key: get_body(bk, times, loc)), None
    for s_name, ra, dec, mag in STARS:
        if s_name == name:
            fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
            factory = (lambda times, loc, c=fixed_coord: c)
            factory.fixed_radec = (ra * 15.0, dec)
            return factory, None
    for d_name, ra, dec, mag, kind in DEEP_SKY:
        if d_name == name:
            fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
            factory = (lambda times, loc, c=fixed_coord: c)
            factory.fixed_radec = (ra * 15.0, dec)
            return factory, None
    if name in ASTEROIDS:
        return asteroid_factory(name), None
    if name in COMETS:
        return comet_factory(name), None
    if name in SATELLITE_NORAD_ID:
        return satellite_factory(SATELLITE_NORAD_ID[name]), None
    return None, None


@app.route("/api/object/next-event")
@login_required
def object_next_event():
    """Renvoie le prochain créneau de visibilité (lever/coucher) après un
    instant donné (`after`) — utilisé par la fiche objet ouverte depuis la
    Bibliothèque pour afficher le créneau suivant celui d'aujourd'hui."""
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400

    factory, min_alt_override = _object_factory_and_min_alt(name)
    if factory is None:
        return jsonify({"error": "unknown object"}), 404

    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except (KeyError, ValueError):
        return jsonify({"error": "lat/lon required"}), 400
    elev = float(request.args.get("elev", 0) or 0)

    try:
        min_alt = float(request.args.get("min_alt", config.DEFAULT_MIN_ALT))
    except (TypeError, ValueError):
        min_alt = config.DEFAULT_MIN_ALT
    if min_alt_override is not None:
        min_alt = min_alt_override

    after_str = (request.args.get("after") or "").strip()
    if not after_str:
        return jsonify({"error": "after required"}), 400
    try:
        after_dt = datetime.fromisoformat(after_str.replace("Z", "+00:00"))
    except ValueError:
        return jsonify({"error": "after must be a valid ISO datetime"}), 400

    location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=max(elev, 0) * u.m)
    # +2 min pour être sûr d'être déjà "sous" le seuil et chercher le
    # prochain lever, pas celui qui vient de se terminer.
    t_ref = Time(after_dt) + 2 * u.minute

    category = "satellite" if name in SATELLITE_NORAD_ID else None
    event = find_rise_set_event(factory, location, t_ref, min_alt=min_alt, extended_days=30,
                                 category=category)
    return jsonify(event)

@app.route("/api/journal/<int:entry_id>", methods=["DELETE"])
@login_required
def journal_delete(entry_id):
    ok = delete_journal_entry(request.user["id"], entry_id)
    return jsonify({"deleted": ok})

@app.route("/logo")
def logo():
    return send_from_directory("app", "ico_bgless.png")

@app.route("/api/catalog/stats")
@login_required
def catalog_stats():
    deep_sky_by_kind = {}
    for _name, _ra, _dec, _mag, kind in DEEP_SKY:
        deep_sky_by_kind[kind] = deep_sky_by_kind.get(kind, 0) + 1

    counts = {
        "sun": 1,
        "moon": 1,
        "planet": len(PLANET_MAG),
        "star": len(STARS),
        **deep_sky_by_kind,
        "asteroid": len(ASTEROIDS),
        "comet": len(COMETS),
        "satellite": len(SATELLITE_NORAD_ID),
    }
    total = sum(counts.values())

    return jsonify({
        "total": total,
        "counts": counts,
        "deep_sky_total": len(DEEP_SKY),
    })

import math as _math

def _object_category(name):
    if name == "Sun":
        return "sun"
    if name == "Moon":
        return "moon"
    if name in PLANET_BODY_NAME:
        return "planet"
    for s_name, *_rest in STARS:
        if s_name == name:
            return "star"
    for d_name, _ra, _dec, _mag, kind in DEEP_SKY:
        if d_name == name:
            return kind
    if name in ASTEROIDS:
        return "asteroid"
    if name in COMETS:
        return "comet"
    if name in SATELLITE_NORAD_ID:
        return "satellite"
    return None


def _sphere_volume_km3(diameter_km):
    if diameter_km is None:
        return None
    r = diameter_km / 2.0
    return (4.0 / 3.0) * _math.pi * r ** 3


def get_physical_info(name):
    from catalog import (
        SOLAR_SYSTEM_PHYSICAL, STAR_PHYSICAL, STAR_DISTANCE_LY,
        DEEP_SKY_INFO, SUN_RADIUS_KM, SUN_MASS_KG, LY_KM,
    )
    info = {"distance_ly": None, "diameter_km": None, "mass_kg": None, "volume_km3": None}

    if name in SOLAR_SYSTEM_PHYSICAL:
        d = SOLAR_SYSTEM_PHYSICAL[name]
        info["diameter_km"] = d["diameter_km"]
        info["mass_kg"] = d["mass_kg"]
        info["volume_km3"] = _sphere_volume_km3(d["diameter_km"])
        return info

    if name in STAR_PHYSICAL:
        radius_solar, mass_solar = STAR_PHYSICAL[name]
        diameter_km = 2 * radius_solar * SUN_RADIUS_KM
        info["distance_ly"] = STAR_DISTANCE_LY.get(name)
        info["diameter_km"] = diameter_km
        info["mass_kg"] = mass_solar * SUN_MASS_KG
        info["volume_km3"] = _sphere_volume_km3(diameter_km)
        return info

    if name in DEEP_SKY_INFO:
        distance_ly, size_ly = DEEP_SKY_INFO[name]
        info["distance_ly"] = distance_ly
        info["diameter_km"] = size_ly * LY_KM
        return info

    from space_objects import ASTEROID_PHYSICAL, COMET_PHYSICAL, SATELLITE_PHYSICAL

    if name in ASTEROID_PHYSICAL:
        diameter_km, mass_kg = ASTEROID_PHYSICAL[name]
        info["diameter_km"] = diameter_km
        info["mass_kg"] = mass_kg
        info["volume_km3"] = _sphere_volume_km3(diameter_km)
        return info

    if name in COMET_PHYSICAL:
        # Diamètre du noyau uniquement (la chevelure/queue n'a pas de
        # taille "physique" fixe : elle dépend de la distance au Soleil).
        info["diameter_km"] = COMET_PHYSICAL[name]
        return info

    if name in SATELLITE_PHYSICAL:
        # Pas une sphère : "diameter_km" sert ici de proxy de taille
        # (plus grande dimension), indicatif seulement.
        size_km, mass_kg = SATELLITE_PHYSICAL[name]
        info["diameter_km"] = size_km
        info["mass_kg"] = mass_kg
        return info

    return info

@app.route("/api/object/details")
@login_required
def object_details():
    """Position instantanée (azimut/élévation/AD/déclinaison) + données
    physiques (distance, diamètre, masse, volume, RA/dec) pour la popup
    info. Les données physiques/catalogue (non calculées en fonction de
    l'heure d'observation) sont TOUJOURS renvoyées, quel que soit le
    contexte d'appel. `is_now` indique si l'azimut/élévation calculés
    correspondent à l'instant présent : il est vrai seulement si aucune
    `date` n'est fournie (sinon la position live n'aurait pas de sens
    pour une nuit future/passée) ; c'est ce flag que le frontend utilise
    pour n'afficher azimut/élévation que depuis Timeline/Overview/
    Schedule/Bibliothèque, jamais depuis Agenda ou Prévoir (Tools)."""
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400

    factory, _min_alt_override = _object_factory_and_min_alt(name)
    if factory is None:
        return jsonify({"error": "unknown object"}), 404

    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except (KeyError, ValueError):
        return jsonify({"error": "lat/lon required"}), 400
    elev = float(request.args.get("elev", 0) or 0)
    location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=max(elev, 0) * u.m)

    date_str = request.args.get("date")
    is_now = not date_str
    if date_str:
        try:
            now_utc = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return jsonify({"error": "date must be formatted YYYY-MM-DD"}), 400
    else:
        now_utc = datetime.now(timezone.utc)
    t = Time(now_utc)

    coord = factory(t, location)
    icrs = coord.icrs
    altaz = coord.transform_to(AltAz(obstime=t, location=location))

    category = _object_category(name)
    physical = get_physical_info(name)

    distance_km = None
    if category in ("sun", "moon", "planet", "asteroid", "comet", "satellite"):
        try:
            # .cartesian.norm() fonctionne quel que soit le type de
            # représentation sous-jacente (contrairement à .distance, qui
            # n'est exposé que si la frame utilise une représentation
            # sphérique) : c'est le cas pour get_body (planètes/lune) mais
            # pas pour les comètes/astéroïdes/satellites, construits en
            # coordonnées cartésiennes.
            distance_km = float(coord.cartesian.norm().to(u.km).value)
        except Exception:
            distance_km = None

    return jsonify({
        "ra_hours": round(float(icrs.ra.hour), 3),
        "dec_deg": round(float(icrs.dec.deg), 2),
        "azimuth_deg": round(float(altaz.az.deg), 1),
        "altitude_deg": round(float(altaz.alt.deg), 1),
        "is_now": is_now,
        "distance_km": round(distance_km) if distance_km is not None else None,
        **physical,
    })

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=443,
        ssl_context=("ssl/cert.pem", "ssl/key.pem"),
        debug=True
    )