"""
Comètes, astéroïdes et objets artificiels (ISS, télescopes en orbite,
stations spatiales...).

Contrairement aux planètes (éphéméride intégrée à Astropy) et aux étoiles /
objets du ciel profond (position fixe), ces objets nécessitent :

  - astéroïdes/comètes : propagation kepleriennne à 2 corps (Soleil +
    petit corps) à partir d'éléments orbitaux osculateurs récupérés
    automatiquement depuis l'API JPL Horizons (avec un cache disque
    rafraîchi une fois par jour, cf. config.ORBITAL_ELEMENTS_TTL_SEC) et
    ne retombe sur les valeurs figées ci-dessous que si le réseau est
    indisponible. Les éléments réels évoluent lentement dans le temps
    (perturbations planétaires / forces non-gravitationnelles pour les
    comètes) : comme les éléments récupérés sont recalés chaque jour à
    l'époque courante, la propagation képlerienne à 2 corps reste très
    précise sur les quelques jours qui suivent.

  - satellites/objets artificiels : propagation SGP4 à partir d'un jeu
    d'éléments orbitaux (TLE). Un TLE devient imprécis après quelques
    jours/semaines (l'ISS notamment corrige régulièrement son orbite) :
    ce module tente de récupérer un TLE à jour depuis Celestrak (avec un
    cache disque de quelques heures) et ne retombe sur les valeurs figées
    ci-dessous que si le réseau est indisponible.
"""
import json
import os
import time as _time

import numpy as np
import requests
import astropy.units as u
from astropy.time import Time
from astropy.coordinates import (
    SkyCoord, CartesianRepresentation, TEME, ITRS, AltAz,
    get_body_barycentric,
)

import config

# Constante gravitationnelle de Gauss (k) : n (rad/jour) = k * a^(-3/2)
# pour un corps de masse négligeable en orbite héliocentrique (a en UA).
_GAUSS_K = 0.01720209895
GM_SUN = _GAUSS_K ** 2  # UA^3 / jour^2
OBLIQUITY_J2000 = np.radians(23.43929111)


# ---------------------------------------------------------------------------
# Astéroïdes : éléments osculateurs moyens à l'époque J2000.0 (JD 2451545.0).
# a (UA), e, i / node (Ω) / peri (ω) / M0 (degrés).
# H, G : magnitude absolue et paramètre de pente (système H-G standard IAU).
# ---------------------------------------------------------------------------
ASTEROID_EPOCH_JD = 2451545.0
ASTEROIDS = {
    "Cérès": {
        "a": 2.7653, "e": 0.0794, "i": 10.594, "node": 80.328,
        "peri": 73.117, "M0": 95.989, "H": 3.34, "G": 0.12,
    },
    "Pallas": {
        "a": 2.7721, "e": 0.2302, "i": 34.841, "node": 172.905,
        "peri": 310.049, "M0": 27.478, "H": 4.13, "G": 0.11,
    },
    "Junon": {
        "a": 2.6699, "e": 0.2555, "i": 12.991, "node": 169.853,
        "peri": 248.139, "M0": 222.618, "H": 5.33, "G": 0.32,
    },
    "Vesta": {
        "a": 2.3617, "e": 0.0894, "i": 7.140, "node": 103.810,
        "peri": 151.216, "M0": 169.043, "H": 3.20, "G": 0.32,
    },
}

# name -> (diamètre en km, masse en kg) — données physiques indicatives.
ASTEROID_PHYSICAL = {
    "Cérès": (939.4, 9.38e20),
    "Pallas": (512, 2.04e20),
    "Junon": (233, 2.67e19),
    "Vesta": (525, 2.59e20),
}

# ---------------------------------------------------------------------------
# Comètes périodiques : éléments donnés au dernier passage au périhélie
# connu (Tp, date UTC). q = distance au périhélie (UA), a = q / (1 - e).
# M1 / K1 : formule de magnitude cométaire totale classique
#   m1 = M1 + 5*log10(delta) + K1*log10(r)   (delta, r en UA)
# ---------------------------------------------------------------------------
COMETS = {
    "2P/Encke": {
        "q": 0.3361, "e": 0.8483, "i": 11.94, "node": 334.30,
        "peri": 187.30, "Tp": "2023-10-22T00:00:00", "M1": 11.5, "K1": 15.0,
    },
    "67P/Churyumov-Gerasimenko": {
        "q": 1.2432, "e": 0.6497, "i": 7.04, "node": 50.15,
        "peri": 12.78, "Tp": "2021-11-02T00:00:00", "M1": 10.5, "K1": 15.0,
    },
    "21P/Giacobini-Zinner": {
        "q": 1.0121, "e": 0.7098, "i": 31.83, "node": 195.44,
        "peri": 172.51, "Tp": "2018-09-10T00:00:00", "M1": 9.0, "K1": 15.0,
    },
}

# name -> diamètre du noyau en km — données physiques indicatives.
COMET_PHYSICAL = {
    "2P/Encke": 4.8,
    "67P/Churyumov-Gerasimenko": 4.1,
    "21P/Giacobini-Zinner": 2.0,
}

# ---------------------------------------------------------------------------
# Rafraîchissement automatique des éléments orbitaux (JPL Horizons)
#
# Le "COMMAND" Horizons identifie l'objet (numéro d'astéroïde ou désignation
# de comète suivi de ";" pour forcer une recherche "petit corps" plutôt
# qu'un corps majeur). On demande les éléments osculateurs ("ELEMENTS")
# héliocentriques à l'époque courante : ils sont donc automatiquement
# recalés sur les dernières perturbations connues à chaque rafraîchissement
# du cache, ce qui permet à la propagation képlerienne à 2 corps de rester
# précise jusqu'au prochain rafraîchissement.
# ---------------------------------------------------------------------------
_HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"

ASTEROID_HORIZONS_COMMAND = {
    "Cérès": "1;",
    "Pallas": "2;",
    "Junon": "3;",
    "Vesta": "4;",
}

COMET_HORIZONS_COMMAND = {
    "2P/Encke": "2P;",
    "67P/Churyumov-Gerasimenko": "67P;",
    "21P/Giacobini-Zinner": "21P;",
}

_ORBITAL_CACHE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "storage", "orbital_elements_cache.json"
)
_ORBITAL_CACHE_TTL_SEC = getattr(config, "ORBITAL_ELEMENTS_TTL_SEC", 24 * 3600)
_orbital_mem_cache = {}


def _load_orbital_disk_cache():
    try:
        with open(_ORBITAL_CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_orbital_disk_cache(cache):
    try:
        os.makedirs(os.path.dirname(_ORBITAL_CACHE_FILE), exist_ok=True)
        tmp_path = _ORBITAL_CACHE_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp_path, _ORBITAL_CACHE_FILE)
    except Exception:
        pass


def _fetch_horizons_elements(command):
    """Interroge l'API JPL Horizons pour les éléments orbitaux osculateurs
    héliocentriques actuels (époque = aujourd'hui, référentiel J2000) de
    l'objet désigné par `command` (ex: "1;" pour Cérès, "2P;" pour Encke).

    Renvoie un dict {epoch_jd, a, e, i, node, peri, M0, q, Tp_jd} — lève une
    exception si la requête échoue ou si la réponse est inattendue."""
    now = Time.now()
    start = now.utc.strftime("%Y-%m-%d")
    stop = (now + 2 * u.day).utc.strftime("%Y-%m-%d")
    params = {
        "format": "json",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'ELEMENTS'",
        "CENTER": "'500@10'",  # héliocentrique
        "REF_SYSTEM": "'J2000'",
        "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": "'1d'",
        "CSV_FORMAT": "'YES'",
    }
    resp = requests.get(_HORIZONS_URL, params=params, timeout=10)
    resp.raise_for_status()
    text = resp.json().get("result", "")

    soe, eoe = text.index("$$SOE"), text.index("$$EOE")
    data_lines = [l for l in text[soe + 5:eoe].splitlines() if l.strip()]
    if not data_lines:
        raise ValueError("Horizons: aucune ligne d'éléments dans la réponse")

    # Colonnes CSV : JDTDB, Calendar Date, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR,
    fields = [f.strip() for f in data_lines[0].split(",")]
    jd_tdb = float(fields[0])
    ec, qr, inc, om, w, tp, _n, ma, _ta, a, _ad, _pr = (float(x) for x in fields[2:14])
    return {
        "epoch_jd": jd_tdb, "a": a, "e": ec, "i": inc,
        "node": om, "peri": w, "M0": ma, "q": qr, "Tp_jd": tp,
    }


def _get_orbital_elements(kind, name, command, static_elements):
    """Renvoie les éléments orbitaux d'un astéroïde/comète : tente JPL
    Horizons (avec cache mémoire + disque, rafraîchi une fois par jour),
    retombe sur les éléments figés `static_elements` si le réseau est
    indisponible ou si l'objet n'a pas de commande Horizons connue."""
    key = f"{kind}:{name}"
    now = _time.time()

    cached = _orbital_mem_cache.get(key)
    if cached and now - cached["ts"] < _ORBITAL_CACHE_TTL_SEC:
        return cached["elements"]

    disk_cache = _load_orbital_disk_cache()
    entry = disk_cache.get(key)
    if entry and now - entry.get("ts", 0) < _ORBITAL_CACHE_TTL_SEC:
        _orbital_mem_cache[key] = entry
        return entry["elements"]

    if command:
        try:
            elements = _fetch_horizons_elements(command)
            new_entry = {"elements": elements, "ts": now}
            _orbital_mem_cache[key] = new_entry
            disk_cache[key] = new_entry
            _save_orbital_disk_cache(disk_cache)
            return elements
        except Exception:
            pass

    if entry:  # cache disque périmé, mais mieux que des éléments figés très anciens
        return entry["elements"]
    return static_elements


def get_asteroid_elements(name):
    """Éléments orbitaux courants de l'astéroïde `name` (JPL Horizons,
    rafraîchis automatiquement ; retombe sur les valeurs figées sinon)."""
    static = ASTEROIDS[name]
    command = ASTEROID_HORIZONS_COMMAND.get(name)
    fetched = _get_orbital_elements("asteroid", name, command, None)
    if fetched is None:
        return {**static, "epoch_jd": ASTEROID_EPOCH_JD}
    # H, G (magnitude absolue / paramètre de pente) ne sont pas renvoyés par
    # une requête ELEMENTS : on garde les valeurs physiques figées.
    return {**fetched, "H": static["H"], "G": static["G"]}


def get_comet_elements(name):
    """Éléments orbitaux courants de la comète `name` (JPL Horizons,
    rafraîchis automatiquement ; retombe sur les valeurs figées sinon)."""
    static = COMETS[name]
    command = COMET_HORIZONS_COMMAND.get(name)
    fetched = _get_orbital_elements("comet", name, command, None)
    if fetched is None:
        return {**static, "Tp_jd": Time(static["Tp"]).tdb.jd}
    # M1, K1 (paramètres de magnitude cométaire) ne sont pas renvoyés par
    # une requête ELEMENTS : on garde les valeurs figées.
    return {**fetched, "M1": static["M1"], "K1": static["K1"]}


# ---------------------------------------------------------------------------
# Objets artificiels en orbite terrestre (satellites, stations, télescopes).
# ---------------------------------------------------------------------------
SATELLITE_NORAD_ID = {
    "ISS (station spatiale)": 25544,
    "Télescope Hubble": 20580,
    "Tiangong (station chinoise)": 48274,
}

# name -> (longueur/taille indicative en km, masse en kg) — données physiques
# indicatives (pas des sphères : diameter_km sert ici de proxy de taille).
SATELLITE_PHYSICAL = {
    "ISS (station spatiale)": (0.109, 450_000),
    "Télescope Hubble": (0.0132, 11_110),
    "Tiangong (station chinoise)": (0.055, 180_000),
}

# Magnitude "standard" approximative (à 1000 km de distance, phase moyenne),
# utilisée pour estimer la magnitude apparente réelle en fonction de la
# distance effective observée (plus rudimentaire que la formule planétaire :
# ignore l'angle de phase soleil-satellite-observateur).
SATELLITE_STD_MAG = {
    25544: -1.8,  # ISS : très brillante, jusqu'à ~-4 en conditions idéales
    20580: 4.5,   # Hubble : beaucoup plus petit, nettement plus faible
    48274: 0.5,   # Tiangong
}

_FALLBACK_TLE = {
    25544: (
        "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9005",
        "2 25544  51.6416 339.9600 0006317  56.0000 304.1000 15.50377579100000",
    ),
    20580: (
        "1 20580U 90037B   24001.50000000  .00000500  00000-0  22000-4 0  9001",
        "2 20580  28.4700 300.0000 0002700 270.0000  90.0000 15.09000000100000",
    ),
    48274: (
        "1 48274U 21035A   24001.50000000  .00010000  00000-0  10000-3 0  9004",
        "2 48274  41.4700 200.0000 0005000 100.0000 260.0000 15.60000000100000",
    ),
}

_TLE_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage", "tle_cache.json")
_TLE_CACHE_TTL_SEC = getattr(config, "TLE_CACHE_TTL_SEC", 6 * 3600)  # rafraîchir au plus toutes les 6h
_tle_mem_cache = {}


def _load_tle_disk_cache():
    try:
        with open(_TLE_CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_tle_disk_cache(cache):
    try:
        with open(_TLE_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except Exception:
        pass


def get_tle(norad_id):
    """Renvoie (line1, line2) pour un NORAD ID donné : tente Celestrak
    (avec cache mémoire + disque de quelques heures pour ne pas le
    solliciter à chaque requête), retombe sur un TLE figé si le réseau est
    indisponible."""
    key = str(norad_id)
    now = _time.time()

    cached = _tle_mem_cache.get(key)
    if cached and now - cached["ts"] < _TLE_CACHE_TTL_SEC:
        return cached["line1"], cached["line2"]

    disk_cache = _load_tle_disk_cache()
    entry = disk_cache.get(key)
    if entry and now - entry.get("ts", 0) < _TLE_CACHE_TTL_SEC:
        _tle_mem_cache[key] = entry
        return entry["line1"], entry["line2"]

    try:
        resp = requests.get(
            "https://celestrak.org/NORAD/elements/gp.php",
            params={"CATNR": norad_id, "FORMAT": "TLE"},
            timeout=5,
        )
        lines = [l.strip() for l in resp.text.strip().splitlines() if l.strip()]
        if resp.ok and len(lines) >= 2:
            line1, line2 = lines[-2], lines[-1]
            new_entry = {"line1": line1, "line2": line2, "ts": now}
            _tle_mem_cache[key] = new_entry
            disk_cache[key] = new_entry
            _save_tle_disk_cache(disk_cache)
            return line1, line2
    except Exception:
        pass

    if entry:  # cache disque périmé, mais mieux qu'un TLE figé très ancien
        return entry["line1"], entry["line2"]
    if norad_id in _FALLBACK_TLE:
        return _FALLBACK_TLE[norad_id]
    raise ValueError(f"Aucun TLE disponible pour NORAD {norad_id}")


# ---------------------------------------------------------------------------
# Propagation kepleriennne à 2 corps (astéroïdes / comètes)
# ---------------------------------------------------------------------------

def _solve_kepler(M, e, tol=1e-9, max_iter=50):
    """Résout M = E - e*sin(E) par Newton-Raphson (vectorisé numpy)."""
    E = np.where(e < 0.8, M, np.pi)
    for _ in range(max_iter):
        dE = (E - e * np.sin(E) - M) / (1 - e * np.cos(E))
        E = E - dE
        if np.all(np.abs(dE) < tol):
            break
    return E


def _ecliptic_to_equatorial(x, y, z):
    """Rotation écliptique J2000 -> équatorial J2000 (obliquité)."""
    cos_e, sin_e = np.cos(OBLIQUITY_J2000), np.sin(OBLIQUITY_J2000)
    x_eq = x
    y_eq = y * cos_e - z * sin_e
    z_eq = y * sin_e + z * cos_e
    return x_eq, y_eq, z_eq


def _kepler_heliocentric_xyz(a, e, i_deg, node_deg, peri_deg, M):
    """Position héliocentrique (UA, équatorial J2000) à partir des éléments
    orbitaux classiques et de l'anomalie moyenne M (radians)."""
    i, node, peri = np.radians(i_deg), np.radians(node_deg), np.radians(peri_deg)
    E = _solve_kepler(M, e)
    nu = 2 * np.arctan2(np.sqrt(1 + e) * np.sin(E / 2), np.sqrt(1 - e) * np.cos(E / 2))
    r = a * (1 - e * np.cos(E))

    x_orb = r * np.cos(nu)
    y_orb = r * np.sin(nu)

    cos_o, sin_o = np.cos(node), np.sin(node)
    cos_w, sin_w = np.cos(peri), np.sin(peri)
    cos_i, sin_i = np.cos(i), np.sin(i)

    x_ecl = (cos_o * cos_w - sin_o * sin_w * cos_i) * x_orb + \
            (-cos_o * sin_w - sin_o * cos_w * cos_i) * y_orb
    y_ecl = (sin_o * cos_w + cos_o * sin_w * cos_i) * x_orb + \
            (-sin_o * sin_w + cos_o * cos_w * cos_i) * y_orb
    z_ecl = (sin_w * sin_i) * x_orb + (cos_w * sin_i) * y_orb

    return _ecliptic_to_equatorial(x_ecl, y_ecl, z_ecl)


def _geocentric_coord_from_helio(x_au, y_au, z_au, t):
    """Convertit une position héliocentrique équatoriale (UA) en SkyCoord
    géocentrique (repère GCRS, requiert un obstime), en soustrayant la
    position héliocentrique de la Terre au même instant."""
    earth = get_body_barycentric("earth", t) - get_body_barycentric("sun", t)
    ex = earth.x.to(u.au).value
    ey = earth.y.to(u.au).value
    ez = earth.z.to(u.au).value
    gx, gy, gz = x_au - ex, y_au - ey, z_au - ez
    dist_au = np.sqrt(gx ** 2 + gy ** 2 + gz ** 2)
    coord = SkyCoord(
        x=gx * u.au, y=gy * u.au, z=gz * u.au,
        representation_type="cartesian", frame="gcrs", obstime=t,
    )
    return coord, dist_au


def _asteroid_r_delta(elements, t):
    a, e = elements["a"], elements["e"]
    n = _GAUSS_K * a ** -1.5
    M0 = np.radians(elements["M0"])
    dt_days = t.tdb.jd - elements["epoch_jd"]
    M = (M0 + n * dt_days) % (2 * np.pi)
    x, y, z = _kepler_heliocentric_xyz(a, e, elements["i"], elements["node"], elements["peri"], M)
    r = np.sqrt(x ** 2 + y ** 2 + z ** 2)
    coord, delta = _geocentric_coord_from_helio(x, y, z, t)
    return coord, r, delta


def _comet_r_delta(elements, t):
    a = elements["q"] / (1 - elements["e"])
    e = elements["e"]
    n = _GAUSS_K * a ** -1.5
    dt_days = t.tdb.jd - elements["Tp_jd"]
    M = (n * dt_days) % (2 * np.pi)
    x, y, z = _kepler_heliocentric_xyz(a, e, elements["i"], elements["node"], elements["peri"], M)
    r = np.sqrt(x ** 2 + y ** 2 + z ** 2)
    coord, delta = _geocentric_coord_from_helio(x, y, z, t)
    return coord, r, delta


def asteroid_factory(name):
    """(times, location) -> SkyCoord géocentrique de l'astéroïde `name`.
    Les éléments orbitaux sont récupérés (JPL Horizons, cache ~1 jour) à
    chaque appel, donc automatiquement tenus à jour sans redémarrage."""
    def factory(times, location):
        elements = get_asteroid_elements(name)
        coord, _r, _delta = _asteroid_r_delta(elements, times)
        return coord
    return factory


def comet_factory(name):
    """(times, location) -> SkyCoord géocentrique de la comète `name`.
    Les éléments orbitaux sont récupérés (JPL Horizons, cache ~1 jour) à
    chaque appel, donc automatiquement tenus à jour sans redémarrage."""
    def factory(times, location):
        elements = get_comet_elements(name)
        coord, _r, _delta = _comet_r_delta(elements, times)
        return coord
    return factory


def asteroid_magnitude(name, t, location):
    """Magnitude apparente approx. (formule H-G IAU standard pour les
    petits corps du système solaire)."""
    elements = get_asteroid_elements(name)
    _coord, r, delta = _asteroid_r_delta(elements, t)
    r, delta = float(r), float(delta)
    H, G = elements["H"], elements["G"]
    try:
        cos_alpha = (r ** 2 + delta ** 2 - 1.0) / (2 * r * delta)
        alpha = np.degrees(np.arccos(min(1.0, max(-1.0, cos_alpha))))
    except Exception:
        alpha = 0.0
    tan_half = np.tan(np.radians(alpha) / 2)
    phi1 = np.exp(-3.33 * tan_half ** 0.63)
    phi2 = np.exp(-1.87 * tan_half ** 1.22)
    term = max((1 - G) * phi1 + G * phi2, 1e-6)
    return round(H + 5 * np.log10(max(r * delta, 1e-6)) - 2.5 * np.log10(term), 2)


def comet_magnitude(name, t, location):
    """Magnitude apparente approx. (formule cométaire totale classique)."""
    elements = get_comet_elements(name)
    _coord, r, delta = _comet_r_delta(elements, t)
    r, delta = float(r), float(delta)
    M1, K1 = elements["M1"], elements["K1"]
    return round(M1 + 5 * np.log10(max(delta, 1e-3)) + K1 * np.log10(max(r, 0.05)), 2)


# ---------------------------------------------------------------------------
# Satellites / objets artificiels : propagation SGP4 à partir d'un TLE.
# ---------------------------------------------------------------------------

def satellite_factory(norad_id):
    """(times, location) -> SkyCoord géocentrique du satellite (TEME ->
    ITRS via SGP4, cf. la documentation Astropy sur les TLE)."""
    def factory(times, location):
        from sgp4.api import Satrec

        scalar = times.isscalar
        times_arr = Time([times]) if scalar else times

        line1, line2 = get_tle(norad_id)
        sat = Satrec.twoline2rv(line1, line2)
        jd = times_arr.utc.jd1
        fr = times_arr.utc.jd2
        _err, r, _v = sat.sgp4_array(jd, fr)
        r = np.asarray(r)  # km, shape (N, 3)

        teme = TEME(
            CartesianRepresentation(r[:, 0] * u.km, r[:, 1] * u.km, r[:, 2] * u.km),
            obstime=times_arr,
        )
        itrs = teme.transform_to(ITRS(obstime=times_arr))
        coord = SkyCoord(itrs)
        return coord[0] if scalar else coord

    return factory


def satellite_magnitude(name, t, location):
    """Magnitude apparente très approximative : magnitude "standard" du
    satellite (à 1000 km) ajustée de la distance réelle observée. Ignore
    l'angle de phase soleil-satellite-observateur (donc l'éclipse dans
    l'ombre de la Terre, où le satellite est en réalité invisible)."""
    norad_id = SATELLITE_NORAD_ID[name]
    factory = satellite_factory(norad_id)
    coord = factory(t, location)
    altaz = coord.transform_to(AltAz(obstime=t, location=location))
    range_km = float(altaz.distance.to(u.km).value)
    std_mag = SATELLITE_STD_MAG.get(norad_id, 2.0)
    if range_km <= 0:
        return std_mag
    return round(std_mag + 5 * np.log10(range_km / 1000.0), 2)
