import json
import os
import re
import warnings
from functools import wraps
from threading import Lock

from flask import Flask, render_template, request, jsonify, redirect, url_for
from datetime import datetime, timezone, timedelta
import numpy as np

warnings.filterwarnings("ignore", category=UserWarning, module="astropy")

from astropy.utils import iers
iers.conf.auto_download = False  # keep the app fully offline

from astropy.time import Time
from astropy.coordinates import (
    EarthLocation, AltAz, SkyCoord, get_body, get_sun
)
import astropy.units as u
import requests

from catalog import STARS, DEEP_SKY, CATEGORY_COLOR
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


def _wiki_title(name):
    """Convertit le nom affiché dans l'app en titre de page Wikipedia.

    Les objets du catalogue Deep Sky sont affichés avec leur préfixe
    Messier ("M31 Andromeda Galaxy", "M42 Orion Nebula", ...), mais les
    pages Wikipedia correspondantes n'utilisent pas ce préfixe (la page
    s'appelle "Andromeda Galaxy", pas "M31 Andromeda Galaxy"). On retire
    donc ce préfixe uniquement pour la requête à l'API ; le nom affiché
    dans l'UI (o.name) n'est pas modifié.
    """
    stripped = re.sub(r"^M\d+\s+", "", name).strip()
    return stripped or name


def fetch_wikipedia_summary(title):
    """Récupère un court résumé Wikipedia (image miniature + description)
    pour un titre de page donné. Retourne toujours un dict avec les clés
    'image' et 'description' (à None si indisponible / hors-ligne)."""
    with _WIKI_CACHE_LOCK:
        if title in _WIKI_CACHE:
            return _WIKI_CACHE[title]

    result = {"image": None, "description": None}
    try:
        resp = requests.get(
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
            + requests.utils.quote(_wiki_title(title)),
            headers={"User-Agent": "Skyme/1.0 (astronomy app; contact: admin@skyme.local)"},
            timeout=5,
        )
        if resp.ok:
            data = resp.json()
            thumb = data.get("thumbnail") or data.get("originalimage")
            if thumb:
                result["image"] = thumb.get("source")
            result["description"] = data.get("extract")
    except requests.RequestException:
        pass

    with _WIKI_CACHE_LOCK:
        _WIKI_CACHE[title] = result
        _save_wiki_cache(_WIKI_CACHE)
    return result


@app.route("/api/object-info")
@login_required
def object_info():
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    return jsonify(fetch_wikipedia_summary(name))


STEP_MINUTES = 4

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


def moon_magnitude(t, location):
    """Rough phase-based Moon magnitude estimate."""
    moon = get_body("moon", t, location)
    sun = get_sun(t)
    elongation = moon.separation(sun).deg  # 0 = new moon side, 180 = full
    illum = (1 - np.cos(np.radians(elongation))) / 2  # 0..1
    illum = max(illum, 0.01)
    return round(-12.7 + 2.5 * np.log10(1 / illum), 2)


def find_night_window(location, now_utc, min_alt=10.0):
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


def build_time_array(t_start, t_end, step_minutes=STEP_MINUTES):
    total_min = (t_end - t_start).sec / 60.0
    n = max(int(total_min / step_minutes) + 1, 2)
    offsets = np.linspace(0, total_min, n)
    return t_start + offsets * u.minute


def find_visibility_window(alt_deg, min_alt=10.0):
    above = alt_deg > min_alt
    if not np.any(above):
        return None
    idx = np.where(above)[0]
    first, last = idx[0], idx[-1]
    for i in range(first, last + 1):
        if not above[i]:
            last = i - 1
            break
    touches_start = (first == 0)
    touches_end = (last == len(above) - 1)
    return int(first), int(last), touches_start, touches_end


def find_next_rise_far(coord_factory, location, t_ref, min_alt=10.0,
                        max_days=30, step_minutes=20):
    """Pour un objet qui ne dépasse pas `min_alt` sur la fenêtre courte de
    `find_rise_set_event` (quelques heures), élargit la recherche jusqu'à
    `max_days` jours en avant. Utile pour la Lune et les planètes, dont la
    déclinaison évolue au fil des jours/semaines et qui peuvent donc finir
    par franchir `min_alt` même si ce n'est pas le cas dans l'immédiat.
    Renvoie l'instant (Time) du prochain lever, ou None si aucun lever
    n'est trouvé dans la fenêtre (objet réellement toujours sous le seuil,
    typiquement une étoile fixe trop proche du pôle opposé)."""
    minutes = np.arange(0, max_days * 24 * 60, step_minutes)
    times = t_ref + minutes * u.minute
    frame = AltAz(obstime=times, location=location)
    coord = coord_factory(times, location)
    alt_deg = coord.transform_to(frame).alt.deg
    above = alt_deg > min_alt

    if not np.any(above):
        return None
    idx = int(np.argmax(above))  # premier True
    if idx == 0:
        return times[0]
    return _interp_time(times[idx - 1], times[idx], alt_deg[idx - 1], alt_deg[idx], min_alt)


def find_rise_set_event(coord_factory, location, t_ref, min_alt=10.0,
                         back_hours=15, fwd_hours=48, step_minutes=5,
                         extended_days=None, extended_step_minutes=20):
    """Locate the *real* rise/set pair for an object, unlimited by any
    display window: the crossing-above/crossing-below of `min_alt` that
    encloses `t_ref` (if the object is up right then) or the next upcoming
    one otherwise. Handles circumpolar objects (always above min_alt) and
    objects that never reach min_alt from this location.

    Si `extended_days` est fourni et que l'objet ne dépasse `min_alt` sur
    aucun point de la fenêtre courte, une recherche élargie (jusqu'à
    `extended_days` jours) est tentée : si un lever futur est trouvé, il
    est renvoyé dans "rise_iso" ("never_visible" reste à True, pour
    indiquer qu'il n'y a pas de fenêtre lever/coucher "immédiate")."""
    minutes = np.arange(-back_hours * 60, fwd_hours * 60, step_minutes)
    times = t_ref + minutes * u.minute
    frame = AltAz(obstime=times, location=location)
    coord = coord_factory(times, location)
    alt_deg = coord.transform_to(frame).alt.deg
    above = alt_deg > min_alt

    if np.all(above):
        return {"rise_iso": None, "set_iso": None,
                "always_visible": True, "never_visible": False, "up_now": True}
    if not np.any(above):
        far_rise = None
        if extended_days:
            far_rise = find_next_rise_far(
                coord_factory, location, t_ref, min_alt,
                max_days=extended_days, step_minutes=extended_step_minutes)
        return {
            "rise_iso": (far_rise.utc.isot + "Z") if far_rise is not None else None,
            "set_iso": None,
            "always_visible": False, "never_visible": True, "up_now": False,
        }

    idx_now = int(np.argmin(np.abs(minutes)))
    up_now = bool(above[idx_now])

    n = len(above)
    islands = []
    i = 0
    while i < n:
        if above[i]:
            j = i
            while j + 1 < n and above[j + 1]:
                j += 1
            islands.append((i, j))
            i = j + 1
        else:
            i += 1

    chosen = None
    if up_now:
        for s, e in islands:
            if s <= idx_now <= e:
                chosen = (s, e)
                break
    else:
        for s, e in islands:
            if s > idx_now:
                chosen = (s, e)
                break
        if chosen is None:
            chosen = islands[-1]
    s, e = chosen

    rise_t = times[0] if s == 0 else _interp_time(
        times[s - 1], times[s], alt_deg[s - 1], alt_deg[s], min_alt)
    set_t = times[-1] if e == n - 1 else _interp_time(
        times[e], times[e + 1], alt_deg[e], alt_deg[e + 1], min_alt)

    return {
        "rise_iso": rise_t.utc.isot + "Z",
        "set_iso": set_t.utc.isot + "Z",
        "always_visible": False,
        "never_visible": False,
        "up_now": up_now,
    }


def compute_object(coord_factory, name, category, fixed_mag, t_start, t_end,
                    t_list, frame_list, location, min_alt=10.0, is_moon=False,
                    is_favorite=False):
    coord = coord_factory(t_list, location)
    altaz = coord.transform_to(frame_list)
    alt_deg = altaz.alt.deg

    result = find_visibility_window(alt_deg, min_alt)
    if result is None:
        return None
    first, last, touches_start, touches_end = result

    rise_t = t_start if touches_start else _interp_time(
        t_list[first - 1], t_list[first], alt_deg[first - 1], alt_deg[first], min_alt)
    set_t = t_end if touches_end else _interp_time(
        t_list[last], t_list[last + 1], alt_deg[last], alt_deg[last + 1], min_alt)

    window_alt = alt_deg[first:last + 1]
    peak_alt = float(np.max(window_alt))
    peak_idx = first + int(np.argmax(window_alt))

    mag = fixed_mag
    if is_moon:
        mag = moon_magnitude(t_list[peak_idx], location)

    duration_min = (set_t - rise_t).sec / 60.0

    # Vrai lever/coucher, non limité par la fenêtre d'affichage (marge ou
    # plage fixe) : on prend comme référence le pic d'altitude (l'objet y
    # est garanti au-dessus du seuil), puis on cherche l'évènement complet.
    true_event = find_rise_set_event(coord_factory, location, t_list[peak_idx], min_alt)

    return {
        "name": name,
        "category": category,
        "color": CATEGORY_COLOR[category],
        "rise_iso": rise_t.utc.isot + "Z",
        "set_iso": set_t.utc.isot + "Z",
        "duration_min": round(duration_min),
        "peak_altitude": round(peak_alt, 1),
        "magnitude": round(mag, 2) if mag is not None else None,
        "touches_start": bool(touches_start),
        "touches_end": bool(touches_end),
        "favorite": bool(is_favorite),
        "true_rise_iso": true_event["rise_iso"],
        "true_set_iso": true_event["set_iso"],
        "always_visible": true_event["always_visible"],
        "never_visible": true_event["never_visible"],
        "up_now": true_event["up_now"],
    }


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
    return render_template("index.html", username=request.user["username"])


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
        min_alt = float(request.args.get("min_alt", 10.0))
    except (TypeError, ValueError):
        min_alt = 10.0
    
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
            margin = float(request.args.get("margin", 30))
        except (TypeError, ValueError):
            margin = 30
            
        t_start = sunset_t - margin * u.minute
        t_end = sunrise_t + margin * u.minute
        
        # Sécurité : Si la marge est trop grande et chevauche le jour
        if t_start >= t_end:
            t_start = sunset_t
            t_end = sunrise_t
    
    t_list = build_time_array(t_start, t_end)
    frame_list = AltAz(obstime=t_list, location=location)

    favorites = set(get_favorites(request.user["id"]))

    objects = []

    moon_factory = lambda times, loc: get_body("moon", times, loc)
    obj = compute_object(moon_factory, "Moon", "moon", None, t_start, t_end,
                          t_list, frame_list, location, is_moon=True, min_alt=min_alt,
                          is_favorite=("Moon" in favorites))
    if obj:
        objects.append(obj)

    for pname, body_key in PLANET_BODY_NAME.items():
        factory = (lambda times, loc, bk=body_key: get_body(bk, times, loc))
        obj = compute_object(factory, pname, "planet", PLANET_MAG[pname], t_start, t_end,
                              t_list, frame_list, location, min_alt=min_alt,
                              is_favorite=(pname in favorites))
        if obj:
            objects.append(obj)

    for name, ra, dec, mag in STARS:
        fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
        factory = (lambda times, loc, c=fixed_coord: c)
        obj = compute_object(factory, name, "star", mag, t_start, t_end,
                              t_list, frame_list, location, min_alt=min_alt,
                              is_favorite=(name in favorites))
        if obj:
            objects.append(obj)

    for name, ra, dec, mag, kind in DEEP_SKY:
        fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
        factory = (lambda times, loc, c=fixed_coord: c)
        obj = compute_object(factory, name, kind, mag, t_start, t_end,
                              t_list, frame_list, location, min_alt=min_alt,
                              is_favorite=(name in favorites))
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
        "_min_alt_override": -0.83,
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
        items.append({
            "name": name,
            "category": "star",
            "magnitude": mag,
            "ra": round(ra, 4),
            "dec": round(dec, 4),
            "_factory": (lambda times, loc, c=fixed_coord: c),
        })

    for name, ra, dec, mag, kind in DEEP_SKY:
        fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
        items.append({
            "name": name,
            "category": kind,
            "magnitude": mag,
            "ra": round(ra, 4),
            "dec": round(dec, 4),
            "_factory": (lambda times, loc, c=fixed_coord: c),
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
        min_alt = float(request.args.get("min_alt", 10.0))
    except (TypeError, ValueError):
        min_alt = 10.0

    now_utc = datetime.now(timezone.utc)

    for item in items:
        factory = item.pop("_factory")
        item_min_alt = item.pop("_min_alt_override", min_alt)
        # Le Soleil n'est jamais favoritable (objet uniquement de référence
        # dans la bibliothèque, jamais dans la timeline/l'agenda).
        item["favorite"] = (item["name"] in favorites) if item.get("favorable", True) else False
        if location is not None:
            event = find_rise_set_event(factory, location, Time(now_utc), min_alt=item_min_alt,
                                         extended_days=30)
            item["rise_iso"] = event["rise_iso"]
            item["set_iso"] = event["set_iso"]
            item["always_visible"] = event["always_visible"]
            item["never_visible"] = event["never_visible"]
            item["up_now"] = event["up_now"]

    items.sort(key=lambda o: o["name"])
    return jsonify({"items": items})


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
# min) : mêmes clés que la table `plans` / PLAN_SETTINGS_FIELDS dans db.py.
PLAN_SETTINGS_KEYS = (
    "loc_mode", "loc_lat", "loc_lon", "loc_elev",
    "pref_mode", "pref_margin", "pref_fixed_start", "pref_fixed_end",
    "pref_min_alt",
)

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
        objects = [str(o) for o in objects][:200]

        note = payload.get("note")
        if note is None:
            existing = get_plan(request.user["id"], date_str)
            note = existing["note"] if existing else ""
        note = str(note or "")[:2000]

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
        min_alt = float(request.args.get("min_alt", 10.0))
    except (TypeError, ValueError):
        min_alt = 10.0

    mode = request.args.get("mode", "margin")
    try:
        margin = float(request.args.get("margin", 30))
    except (TypeError, ValueError):
        margin = 30

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

    start_h, start_m = parse_hm(request.args.get("fixed_start_hm"), 20, 0)
    end_h, end_m = parse_hm(request.args.get("fixed_end_hm"), 6, 0)

    try:
        start_date = datetime.strptime(request.args["start_date"], "%Y-%m-%d")
        end_date = datetime.strptime(request.args["end_date"], "%Y-%m-%d")
    except (KeyError, ValueError):
        return jsonify({"error": "start_date/end_date required (YYYY-MM-DD)"}), 400

    # Garde-fou : on ne calcule jamais plus de 60 jours d'un coup.
    if (end_date - start_date).days > 60 or end_date < start_date:
        return jsonify({"error": "invalid date range"}), 400

    favorite_set = set(get_favorites(request.user["id"]))
    if not favorite_set:
        return jsonify({"counts": {}})

    location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=max(elev, 0) * u.m)

    fav_stars = [s for s in STARS if s[0] in favorite_set]
    fav_deep_sky = [d for d in DEEP_SKY if d[0] in favorite_set]
    fav_planets = [p for p in PLANET_BODY_NAME.items() if p[0] in favorite_set]
    want_moon = "Moon" in favorite_set

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

        t_list = build_time_array(t_start, t_end)
        frame_list = AltAz(obstime=t_list, location=location)

        count = 0

        if want_moon:
            moon_factory = lambda times, loc: get_body("moon", times, loc)
            if compute_object(moon_factory, "Moon", "moon", None, t_start, t_end,
                               t_list, frame_list, location, is_moon=True,
                               min_alt=min_alt) is not None:
                count += 1

        for pname, body_key in fav_planets:
            factory = (lambda times, loc, bk=body_key: get_body(bk, times, loc))
            if compute_object(factory, pname, "planet", PLANET_MAG[pname], t_start, t_end,
                               t_list, frame_list, location, min_alt=min_alt) is not None:
                count += 1

        for name, ra, dec, mag in fav_stars:
            fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
            factory = (lambda times, loc, c=fixed_coord: c)
            if compute_object(factory, name, "star", mag, t_start, t_end,
                               t_list, frame_list, location, min_alt=min_alt) is not None:
                count += 1

        for name, ra, dec, mag, kind in fav_deep_sky:
            fixed_coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
            factory = (lambda times, loc, c=fixed_coord: c)
            if compute_object(factory, name, kind, mag, t_start, t_end,
                               t_list, frame_list, location, min_alt=min_alt) is not None:
                count += 1

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


@app.route("/api/journal/<int:entry_id>", methods=["DELETE"])
@login_required
def journal_delete(entry_id):
    ok = delete_journal_entry(request.user["id"], entry_id)
    return jsonify({"deleted": ok})


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
    }
    total = sum(counts.values())

    return jsonify({
        "total": total,
        "counts": counts,
        "deep_sky_total": len(DEEP_SKY),
    })


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=443,
        ssl_context=("ssl/cert.pem", "ssl/key.pem"),
        debug=True
    )