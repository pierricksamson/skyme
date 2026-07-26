# Static catalogs: bright stars and deep-sky objects (J2000 RA/Dec)
# RA in hours, Dec in degrees, mag = apparent magnitude

STARS = [
    ("Sirius",      6.7525,  -16.7161, -1.46),
    ("Canopus",     6.3992,  -52.6957, -0.74),
    ("Arcturus",   14.2610,   19.1825,  0.05),
    ("Vega",       18.6156,   38.7837,  0.03),
    ("Capella",     5.2782,   45.9980,  0.08),
    ("Rigel",       5.2423,   -8.2016,  0.13),
    ("Procyon",     7.6550,    5.2250,  0.34),
    ("Betelgeuse",  5.9195,    7.4071,  0.50),
    ("Achernar",    1.6286,  -57.2367,  0.46),
    ("Altair",     19.8464,    8.8683,  0.77),
    ("Aldebaran",   4.5987,   16.5093,  0.85),
    ("Antares",    16.4901,  -26.4320,  1.09),
    ("Spica",      13.4199,  -11.1613,  0.97),
    ("Pollux",      7.7553,   28.0262,  1.14),
    ("Fomalhaut",  22.9608,  -29.6222,  1.16),
    ("Deneb",      20.6905,   45.2803,  1.25),
    ("Regulus",    10.1395,   11.9672,  1.35),
    ("Castor",      7.5766,   31.8883,  1.58),
    ("Bellatrix",   5.4188,    6.3497,  1.64),
    ("Polaris",     2.5303,   89.2641,  1.98),
]

# name, ra_hours, dec_deg, mag, type (galaxy | nebula | cluster)
DEEP_SKY = [
    ("M31 Andromeda Galaxy",   0.7123,  41.2691, 3.44, "galaxy"),
    ("M81 Bode's Galaxy",      9.9258,  69.0653, 6.94, "galaxy"),
    ("M104 Sombrero Galaxy",  12.6666, -11.6231, 8.98, "galaxy"),
    ("M51 Whirlpool Galaxy",  13.4979,  47.1953, 8.40, "galaxy"),
    ("M33 Triangulum Galaxy",  1.5642,  30.6602, 5.72, "galaxy"),

    ("M42 Orion Nebula",       5.5880, -5.3911,  4.00, "nebula"),
    ("M8 Lagoon Nebula",      18.0604, -24.3800, 6.00, "nebula"),
    ("M57 Ring Nebula",       18.8933,  33.0292, 8.80, "nebula"),
    ("M27 Dumbbell Nebula",   19.9938,  22.7211, 7.50, "nebula"),
    ("M20 Trifid Nebula",     18.0450, -23.0300, 6.30, "nebula"),

    ("M45 Pleiades",           3.7912,  24.1053, 1.60, "cluster"),
    ("M13 Hercules Cluster",  16.6947,  36.4600, 5.80, "cluster"),
    ("M44 Beehive Cluster",    8.6725,  19.6700, 3.70, "cluster"),
    ("M22 Sagittarius Cluster",18.6069,-23.9042, 5.10, "cluster"),
    ("M6 Butterfly Cluster",  17.6683, -32.2170, 4.20, "cluster"),
]

PLANETS = {
    "Mercury": "mercury",
    "Venus": "venus",
    "Mars": "mars",
    "Jupiter": "jupiter barycenter",
    "Saturn": "saturn barycenter",
    "Uranus": "uranus barycenter",
    "Neptune": "neptune barycenter",
}

CATEGORY_COLOR = {
    "moon":    "#d9d2c4",
    "planet":  "#c98a4b",
    "star":    "#eae0b8",
    "galaxy":  "#8f7fc9",
    "nebula":  "#c4577f",
    "cluster": "#4fa89c",
}
