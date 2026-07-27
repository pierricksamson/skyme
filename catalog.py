# Static catalogs: bright stars and deep-sky objects (J2000 RA/Dec)
# RA in hours, Dec in degrees, mag = apparent magnitude

STARS = [
    # Stars from original list
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
    
    # New notable stars
    ("Algol",       3.1353,   40.9556,  2.12),
    ("Almach",      2.0650,   42.3297,  2.10),
    ("Mizar",      13.3986,   54.9254,  2.23),
    ("Alnitak",     5.6793,   -1.9426,  1.77),
    ("Alioth",     12.9004,   55.9598,  1.76),
    ("Dubhe",      11.0621,   61.7511,  1.79),
    ("Diphda",      0.7261,  -17.9930,  2.04),
    ("Mirfak",      3.4054,   49.8612,  1.79),
    ("Alphard",     9.4597,   -8.6653,  1.98),
    ("Hamal",       2.1206,   23.4624,  2.01),
]

# name, ra_hours, dec_deg, mag, type (galaxy | nebula | cluster)
DEEP_SKY = [
    # --- GALAXIES ---
    ("M31 Andromeda Galaxy",   0.7123,  41.2691, 3.44, "galaxy"),
    ("M33 Triangulum Galaxy",  1.5642,  30.6602, 5.72, "galaxy"),
    ("M81 Bode's Galaxy",      9.9258,  69.0653, 6.94, "galaxy"),
    ("M82 Cigar Galaxy",       9.9322,  69.6797, 8.41, "galaxy"),
    ("M104 Sombrero Galaxy",  12.6666, -11.6231, 8.98, "galaxy"),
    ("M51 Whirlpool Galaxy",  13.4979,  47.1953, 8.40, "galaxy"),
    ("M63 Sunflower Galaxy",  13.2642,  42.0294, 8.60, "galaxy"),
    ("M101 Pinwheel Galaxy",  14.0533,  54.3489, 7.86, "galaxy"),
    ("M87 Virgo A",           12.5136,  12.3911, 8.60, "galaxy"),
    ("M74 Phantom Galaxy",     1.6114,  15.7836, 9.40, "galaxy"),

    # --- NEBULAE ---
    ("M1 Crab Nebula",         5.5755,  22.0145, 8.40, "nebula"),
    ("M8 Lagoon Nebula",      18.0604, -24.3800, 6.00, "nebula"),
    ("M16 Eagle Nebula",      18.3144, -13.8078, 6.00, "nebula"),
    ("M17 Swan Nebula",       18.3472, -16.1753, 6.00, "nebula"),
    ("M20 Trifid Nebula",     18.0450, -23.0300, 6.30, "nebula"),
    ("M27 Dumbbell Nebula",   19.9938,  22.7211, 7.50, "nebula"),
    ("M42 Orion Nebula",       5.5880,  -5.3911, 4.00, "nebula"),
    ("M43 De Mairan's Nebula", 5.5925,  -5.2708, 9.00, "nebula"),
    ("M57 Ring Nebula",       18.8933,  33.0292, 8.80, "nebula"),
    ("M76 Little Dumbbell",    1.7061,  51.5753, 10.1, "nebula"),
    ("M97 Owl Nebula",        11.2467,  55.0192, 9.90, "nebula"),
    ("NGC 7000 North America",20.9808,  44.3500, 7.00, "nebula"),

    # --- CLUSTERS ---
    ("M3 Globular Cluster",   13.7036,  28.3769, 6.20, "cluster"),
    ("M4 Globular Cluster",   16.3933, -26.5258, 5.90, "cluster"),
    ("M5 Globular Cluster",   15.3097,   2.0811, 5.60, "cluster"),
    ("M6 Butterfly Cluster",  17.6683, -32.2170, 4.20, "cluster"),
    ("M7 Ptolemy Cluster",    17.8983, -34.8200, 3.30, "cluster"),
    ("M11 Wild Duck Cluster", 18.8514,  -6.2700, 6.30, "cluster"),
    ("M13 Hercules Cluster",  16.6947,  36.4600, 5.80, "cluster"),
    ("M15 Pegasus Cluster",   21.4994,  12.1672, 6.20, "cluster"),
    ("M22 Sagittarius Cluster",18.6069,-23.9042, 5.10, "cluster"),
    ("M35 Open Cluster",       6.1483,  24.3333, 5.30, "cluster"),
    ("M36 Open Cluster",       5.6017,  34.1400, 6.30, "cluster"),
    ("M37 Open Cluster",       5.8733,  32.5500, 5.60, "cluster"),
    ("M38 Open Cluster",       5.4783,  35.8500, 6.40, "cluster"),
    ("M44 Beehive Cluster",    8.6725,  19.6700, 3.70, "cluster"),
    ("M45 Pleiades",           3.7912,  24.1053, 1.60, "cluster"),
    ("NGC 869 Double Cluster", 2.3183,  57.1333, 5.30, "cluster"),
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