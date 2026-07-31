"""
astro_fast.py — Calculs d'éphémérides rapides pour Skyme.

Remplace l'échantillonnage brute-force (grille fine 4-5 min sur des
fenêtres allant jusqu'à 60 jours) par deux stratégies, sans perte de
précision vs la cible (±1 min sur les horaires, ±0.1° sur les altitudes) :

1. Étoiles & ciel profond (RA/Dec fixes) : formule analytique de
   l'angle horaire de lever/coucher (trigo sphérique), vectorisée sur
   numpy pour TOUS les objets fixes d'un coup. Aucun appel AltAz.

2. Corps mobiles (Soleil, Lune, planètes, astéroïdes, comètes,
   satellites) : scan grossier (pas large, coarse_step_minutes) suivi
   d'une interpolation cubique (CubicSpline) de la courbe d'altitude,
   puis recherche de racine (brentq) sur la spline pour isoler
   l'instant exact de franchissement — sans appel AltAz supplémentaire.
"""
import numpy as np
from astropy.time import Time
from astropy.coordinates import AltAz
import astropy.units as u
from scipy.interpolate import CubicSpline
from scipy.optimize import brentq, minimize_scalar

# 1h de temps sidéral = 0.99726958 h de temps solaire (UT).
SIDEREAL_TO_SOLAR = 0.99726958


def _wrap360(x):
    return np.mod(x, 360.0)


def local_sidereal_time_deg(t, location):
    """Temps sidéral local apparent (deg). Accepte un Time scalaire ou
    tableau (retour de même forme)."""
    return t.sidereal_time("apparent", longitude=location.lon).deg


# ---------------------------------------------------------------------
# 1) Étoiles / ciel profond — formule analytique, vectorisée
# ---------------------------------------------------------------------

def analytic_altitude_deg(ra_deg, dec_deg, lat_deg, lst_deg):
    """Altitude (deg) via trigonométrie sphérique. ra_deg/dec_deg : array
    (N objets). lst_deg : scalaire ou array de même forme. Vectorisé."""
    phi = np.radians(lat_deg)
    delta = np.radians(dec_deg)
    H = np.radians(_wrap360(np.asarray(lst_deg) - np.asarray(ra_deg)))
    sin_alt = np.sin(phi) * np.sin(delta) + np.cos(phi) * np.cos(delta) * np.cos(H)
    return np.degrees(np.arcsin(np.clip(sin_alt, -1.0, 1.0)))


def hour_angle_rise_set_deg(ra_deg, dec_deg, lat_deg, min_alt_deg):
    """Angle horaire (deg, >=0) du lever/coucher pour l'altitude min_alt_deg :
    cos(H) = (sin(h) - sin(phi)sin(delta)) / (cos(phi)cos(delta)).
    Renvoie (H_deg, circumpolar, never), tous vectorisés (array N)."""
    phi = np.radians(lat_deg)
    delta = np.radians(dec_deg)
    h = np.radians(min_alt_deg)
    denom = np.cos(phi) * np.cos(delta)
    with np.errstate(divide="ignore", invalid="ignore"):
        cosH = (np.sin(h) - np.sin(phi) * np.sin(delta)) / denom
    circumpolar = cosH < -1.0
    never = cosH > 1.0
    H_deg = np.degrees(np.arccos(np.clip(cosH, -1.0, 1.0)))
    return H_deg, circumpolar, never


def lst_to_time_after(target_lst_deg, t_ref, lst_ref_deg):
    """Prochain instant (>= t_ref) où LST == target_lst_deg."""
    diff = _wrap360(target_lst_deg - lst_ref_deg)  # [0, 360)
    dt_hours = diff / 15.0 * SIDEREAL_TO_SOLAR
    return t_ref + dt_hours * u.hour


def lst_to_time_before(target_lst_deg, t_ref, lst_ref_deg):
    """Instant précédent (<= t_ref) où LST == target_lst_deg."""
    diff = _wrap360(target_lst_deg - lst_ref_deg)  # [0, 360)
    dt_hours = (diff - 360.0) / 15.0 * SIDEREAL_TO_SOLAR
    return t_ref + dt_hours * u.hour


def batch_fixed_rise_set(ra_deg, dec_deg, lat_deg, location, t_start, t_end, min_alt_deg):
    """Calcule lever/coucher/altitude-pic pour N objets à RA/Dec fixes
    d'un coup (numpy pur, aucune transformation AltAz). Retourne un dict
    de tableaux (longueur N)."""
    ra_deg = np.asarray(ra_deg, dtype=float)
    dec_deg = np.asarray(dec_deg, dtype=float)
    n = len(ra_deg)

    lst_start = float(local_sidereal_time_deg(t_start, location))
    lst_end = float(local_sidereal_time_deg(t_end, location))

    alt_start = analytic_altitude_deg(ra_deg, dec_deg, lat_deg, lst_start)
    alt_end = analytic_altitude_deg(ra_deg, dec_deg, lat_deg, lst_end)

    H_deg, circumpolar, never = hour_angle_rise_set_deg(ra_deg, dec_deg, lat_deg, min_alt_deg)
    duration_hours = (2.0 * H_deg / 15.0) * SIDEREAL_TO_SOLAR

    rise_lst = _wrap360(ra_deg - H_deg)
    up_at_start = alt_start > min_alt_deg

    rise_before = lst_to_time_before(rise_lst, t_start, lst_start)
    rise_after = lst_to_time_after(rise_lst, t_start, lst_start)
    true_rise_t = Time(np.where(up_at_start, rise_before.jd, rise_after.jd), format="jd")
    true_set_t = true_rise_t + duration_hours * u.hour

    # Visible dans [t_start, t_end] : circumpolaire, ou son prochain lever
    # (pertinent) tombe avant la fin de la fenêtre.
    visible = (~never) & (circumpolar | (true_rise_t.jd <= t_end.jd))

    touches_start = circumpolar | up_at_start
    touches_end = circumpolar | (true_set_t.jd >= t_end.jd)

    display_rise = Time(np.where(touches_start, t_start.jd, true_rise_t.jd), format="jd")
    display_set = Time(np.where(touches_end, t_end.jd, true_set_t.jd), format="jd")

    max_alt = 90.0 - np.abs(lat_deg - dec_deg)
    transit_t = true_rise_t + (duration_hours / 2.0) * u.hour
    transit_in_window = (transit_t.jd >= display_rise.jd) & (transit_t.jd <= display_set.jd)

    rise_alt = np.where(touches_start, alt_start, min_alt_deg)
    set_alt = np.where(touches_end, alt_end, min_alt_deg)
    edge_alt = np.maximum(rise_alt, set_alt)
    peak_alt = np.where(circumpolar, np.maximum(max_alt, edge_alt),
                         np.where(transit_in_window, max_alt, edge_alt))

    return {
        "visible": visible, "circumpolar": circumpolar, "never": never,
        "display_rise": display_rise, "display_set": display_set,
        "touches_start": touches_start, "touches_end": touches_end,
        "peak_alt": peak_alt,
        "true_rise_t": true_rise_t, "true_set_t": true_set_t,
        "n": n,
    }


def build_fixed_result(name, category, mag, color, batch, i, is_favorite=False):
    """Construit le dict objet (même format que l'ancien compute_object)
    à partir de l'index i d'un batch calculé par batch_fixed_rise_set."""
    rise_t = batch["display_rise"][i]
    set_t = batch["display_set"][i]
    duration_min = (set_t - rise_t).sec / 60.0
    if bool(batch["circumpolar"][i]):
        true_rise_iso, true_set_iso = None, None
        always_visible, never_visible = True, False
    else:
        true_rise_iso = batch["true_rise_t"][i].utc.isot + "Z"
        true_set_iso = batch["true_set_t"][i].utc.isot + "Z"
        always_visible, never_visible = False, False
    return {
        "name": name,
        "category": category,
        "color": color,
        "rise_iso": rise_t.utc.isot + "Z",
        "set_iso": set_t.utc.isot + "Z",
        "duration_min": round(duration_min),
        "peak_altitude": round(float(batch["peak_alt"][i]), 1),
        "magnitude": round(mag, 2) if mag is not None else None,
        "touches_start": bool(batch["touches_start"][i]),
        "touches_end": bool(batch["touches_end"][i]),
        "favorite": bool(is_favorite),
        "true_rise_iso": true_rise_iso,
        "true_set_iso": true_set_iso,
        "always_visible": always_visible,
        "never_visible": never_visible,
        "up_now": True,
    }


def find_rise_set_analytic(ra_deg, dec_deg, lat_deg, location, t_ref, min_alt_deg):
    """Version mono-objet de batch_fixed_rise_set, format compatible avec
    l'ancien find_rise_set_event (rise_iso/set_iso/always_visible/
    never_visible/up_now), pour catalog_list / object_next_event."""
    lst_ref = float(local_sidereal_time_deg(t_ref, location))
    alt_ref = float(analytic_altitude_deg(np.array([ra_deg]), np.array([dec_deg]), lat_deg, lst_ref)[0])
    H_deg, circumpolar, never = hour_angle_rise_set_deg(
        np.array([ra_deg]), np.array([dec_deg]), lat_deg, min_alt_deg)
    H_deg, circumpolar, never = float(H_deg[0]), bool(circumpolar[0]), bool(never[0])

    if circumpolar:
        return {"rise_iso": None, "set_iso": None, "always_visible": True,
                "never_visible": False, "up_now": True}
    if never:
        return {"rise_iso": None, "set_iso": None, "always_visible": False,
                "never_visible": True, "up_now": False}

    up_now = alt_ref > min_alt_deg
    rise_lst = _wrap360(ra_deg - H_deg)
    duration_hours = (2.0 * H_deg / 15.0) * SIDEREAL_TO_SOLAR
    rise_t = lst_to_time_before(rise_lst, t_ref, lst_ref) if up_now else \
        lst_to_time_after(rise_lst, t_ref, lst_ref)
    set_t = rise_t + duration_hours * u.hour
    return {"rise_iso": rise_t.utc.isot + "Z", "set_iso": set_t.utc.isot + "Z",
            "always_visible": False, "never_visible": False, "up_now": up_now}


# ---------------------------------------------------------------------
# 2) Corps mobiles — scan grossier + spline cubique + recherche de racine
# ---------------------------------------------------------------------

def _coarse_altitude_curve(coord_factory, location, t_start, t_end, coarse_step_minutes):
    """Un seul appel AltAz vectorisé sur une grille grossière ; renvoie
    (offsets_min, alt_deg)."""
    total_min = (t_end - t_start).sec / 60.0
    n = max(int(total_min / coarse_step_minutes) + 1, 3)
    offsets_min = np.linspace(0, total_min, n)
    times = t_start + offsets_min * u.minute
    frame = AltAz(obstime=times, location=location)
    coord = coord_factory(times, location)
    alt_deg = coord.transform_to(frame).alt.deg
    return offsets_min, alt_deg


def find_visibility_window_fast(coord_factory, location, t_start, t_end, min_alt_deg,
                                 coarse_step_minutes=30):
    """Équivalent de l'ancien compute_object (partie fenêtre d'affichage) :
    scan grossier -> spline cubique -> brentq pour les franchissements,
    minimize_scalar pour le pic. Aucun appel AltAz au-delà du scan
    grossier initial."""
    offsets_min, alt = _coarse_altitude_curve(coord_factory, location, t_start, t_end,
                                               coarse_step_minutes)
    spline = CubicSpline(offsets_min, alt)

    dense = np.linspace(offsets_min[0], offsets_min[-1], max(len(offsets_min) * 20, 200))
    dense_alt = spline(dense)
    above = dense_alt > min_alt_deg
    if not np.any(above):
        return None
    idx = np.where(above)[0]
    first, last = int(idx[0]), int(idx[-1])
    for i in range(first, last + 1):
        if not above[i]:
            last = i - 1
            break
    touches_start = (first == 0)
    touches_end = (last == len(above) - 1)

    def f(x):
        return spline(x) - min_alt_deg

    if touches_start:
        rise_off = offsets_min[0]
    else:
        a, b = dense[first - 1], dense[first]
        try:
            rise_off = brentq(f, a, b, xtol=1e-3)
        except ValueError:
            rise_off = dense[first]

    if touches_end:
        set_off = offsets_min[-1]
    else:
        a, b = dense[last], dense[last + 1]
        try:
            set_off = brentq(f, a, b, xtol=1e-3)
        except ValueError:
            set_off = dense[last]

    window_alt = dense_alt[first:last + 1]
    window_dense = dense[first:last + 1]
    peak_off_guess = float(window_dense[int(np.argmax(window_alt))])
    lo = max(offsets_min[0], peak_off_guess - coarse_step_minutes)
    hi = min(offsets_min[-1], peak_off_guess + coarse_step_minutes)
    try:
        res = minimize_scalar(lambda x: -spline(x), bounds=(lo, hi), method="bounded",
                               options={"xatol": 1e-3})
        peak_off, peak_alt = float(res.x), float(-res.fun)
    except Exception:
        peak_off, peak_alt = peak_off_guess, float(np.max(window_alt))

    return {
        "rise_t": t_start + rise_off * u.minute,
        "set_t": t_start + set_off * u.minute,
        "peak_t": t_start + peak_off * u.minute,
        "peak_alt": peak_alt,
        "touches_start": touches_start,
        "touches_end": touches_end,
    }


def _find_next_rise_far_fast(coord_factory, location, t_ref, min_alt_deg,
                              max_days=30, step_minutes=180):
    offsets_min, alt = _coarse_altitude_curve(coord_factory, location, t_ref,
                                               t_ref + max_days * u.day, step_minutes)
    spline = CubicSpline(offsets_min, alt)
    dense = np.linspace(offsets_min[0], offsets_min[-1], max(len(offsets_min) * 10, 500))
    dense_alt = spline(dense)
    above = dense_alt > min_alt_deg
    if not np.any(above):
        return None
    idx = int(np.argmax(above))
    if idx == 0:
        return t_ref

    def f(x):
        return spline(x) - min_alt_deg

    try:
        off = brentq(f, dense[idx - 1], dense[idx], xtol=1e-3)
    except ValueError:
        off = dense[idx]
    return t_ref + off * u.minute


def find_rise_set_event_fast(coord_factory, location, t_ref, min_alt_deg,
                              back_hours=15, fwd_hours=48, coarse_step_minutes=30,
                              extended_days=None, extended_step_minutes=180):
    """Équivalent rapide de l'ancien find_rise_set_event : localise le
    vrai lever/coucher encadrant t_ref (ou le prochain), non limité par
    une fenêtre d'affichage, via scan grossier + spline + brentq."""
    t_start = t_ref - back_hours * u.hour
    t_end = t_ref + fwd_hours * u.hour
    offsets_min, alt = _coarse_altitude_curve(coord_factory, location, t_start, t_end,
                                               coarse_step_minutes)
    spline = CubicSpline(offsets_min, alt)
    dense = np.linspace(offsets_min[0], offsets_min[-1], max(len(offsets_min) * 20, 400))
    dense_alt = spline(dense)
    above = dense_alt > min_alt_deg

    if np.all(above):
        return {"rise_iso": None, "set_iso": None, "always_visible": True,
                "never_visible": False, "up_now": True}
    if not np.any(above):
        far_rise = None
        if extended_days:
            far_rise = _find_next_rise_far_fast(coord_factory, location, t_ref, min_alt_deg,
                                                 max_days=extended_days,
                                                 step_minutes=extended_step_minutes)
        return {"rise_iso": (far_rise.utc.isot + "Z") if far_rise is not None else None,
                "set_iso": None, "always_visible": False, "never_visible": True,
                "up_now": False}

    t_ref_offset = (t_ref - t_start).sec / 60.0
    idx_now = int(np.argmin(np.abs(dense - t_ref_offset)))
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

    def f(x):
        return spline(x) - min_alt_deg

    if s == 0:
        rise_off = dense[0]
    else:
        try:
            rise_off = brentq(f, dense[s - 1], dense[s], xtol=1e-3)
        except ValueError:
            rise_off = dense[s]

    if e == n - 1:
        set_off = dense[-1]
    else:
        try:
            set_off = brentq(f, dense[e], dense[e + 1], xtol=1e-3)
        except ValueError:
            set_off = dense[e]

    rise_t = t_start + rise_off * u.minute
    set_t = t_start + set_off * u.minute
    return {"rise_iso": rise_t.utc.isot + "Z", "set_iso": set_t.utc.isot + "Z",
            "always_visible": False, "never_visible": False, "up_now": up_now}