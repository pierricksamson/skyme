import warnings
from flask import Flask, render_template, request, jsonify
from datetime import datetime, timezone
import numpy as np

warnings.filterwarnings("ignore", category=UserWarning, module="astropy")

from astropy.utils import iers
iers.conf.auto_download = False  # keep the app fully offline

from astropy.time import Time
from astropy.coordinates import (
    EarthLocation, AltAz, SkyCoord, get_body, get_sun
)
import astropy.units as u

from catalog import STARS, DEEP_SKY, CATEGORY_COLOR

app = Flask(__name__)

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


def compute_object(coord, name, category, fixed_mag, t_start, t_end,
                    t_list, frame_list, location, min_alt=10.0, is_moon=False):
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
def index():
    return render_template("index.html")


@app.route("/api/sky")
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
    sunset_t, sunrise_t = find_night_window(location, now_utc)

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

    objects = []

    moon_coord = get_body("moon", t_list, location)
    obj = compute_object(moon_coord, "Moon", "moon", None, t_start, t_end,
                          t_list, frame_list, location, is_moon=True, min_alt=min_alt)
    if obj:
        objects.append(obj)

    for pname, body_key in PLANET_BODY_NAME.items():
        coord = get_body(body_key, t_list, location)
        obj = compute_object(coord, pname, "planet", PLANET_MAG[pname], t_start, t_end,
                              t_list, frame_list, location, min_alt=min_alt)
        if obj:
            objects.append(obj)

    for name, ra, dec, mag in STARS:
        coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
        obj = compute_object(coord, name, "star", mag, t_start, t_end,
                              t_list, frame_list, location, min_alt=min_alt)
        if obj:
            objects.append(obj)

    for name, ra, dec, mag, kind in DEEP_SKY:
        coord = SkyCoord(ra=ra * u.hourangle, dec=dec * u.deg, frame="icrs")
        obj = compute_object(coord, name, kind, mag, t_start, t_end,
                              t_list, frame_list, location, min_alt=min_alt)
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


@app.route("/api/catalog/stats")
def catalog_stats():
    deep_sky_by_kind = {}
    for _name, _ra, _dec, _mag, kind in DEEP_SKY:
        deep_sky_by_kind[kind] = deep_sky_by_kind.get(kind, 0) + 1

    counts = {
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
    app.run(debug=True, host="0.0.0.0", port=5000)