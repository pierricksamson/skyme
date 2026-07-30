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

# ---------- Données physiques/distances (approximatives, indicatives) ----------

STAR_DISTANCE_LY = {
    "Sirius": 8.6, "Canopus": 310, "Arcturus": 37, "Vega": 25, "Capella": 43,
    "Rigel": 860, "Procyon": 11.5, "Betelgeuse": 548, "Achernar": 139,
    "Altair": 17, "Aldebaran": 65, "Antares": 550, "Spica": 250, "Pollux": 34,
    "Fomalhaut": 25, "Deneb": 2600, "Regulus": 79, "Castor": 51,
    "Bellatrix": 250, "Polaris": 433, "Algol": 90, "Almach": 350,
    "Mizar": 78, "Alnitak": 800, "Alioth": 81, "Dubhe": 123, "Diphda": 96,
    "Mirfak": 510, "Alphard": 177, "Hamal": 66,
}

# name -> (rayon en rayons solaires, masse en masses solaires)
STAR_PHYSICAL = {
    "Sirius": (1.71, 2.02), "Canopus": (71, 8.0), "Arcturus": (25.4, 1.08),
    "Vega": (2.36, 2.14), "Capella": (11.98, 2.57), "Rigel": (78.9, 21),
    "Procyon": (2.05, 1.5), "Betelgeuse": (764, 16.5), "Achernar": (7.3, 6.7),
    "Altair": (1.63, 1.79), "Aldebaran": (44.2, 1.16), "Antares": (680, 12),
    "Spica": (7.47, 11.43), "Pollux": (9.06, 1.91), "Fomalhaut": (1.84, 1.92),
    "Deneb": (203, 19), "Regulus": (4.35, 3.8), "Castor": (2.14, 2.37),
    "Bellatrix": (5.75, 7.7), "Polaris": (37.5, 5.4), "Algol": (2.73, 3.17),
    "Almach": (80, 15), "Mizar": (2.4, 2.2), "Alnitak": (20, 33),
    "Alioth": (4.14, 2.91), "Dubhe": (17.03, 4.25), "Diphda": (16.78, 2.8),
    "Mirfak": (68, 8.5), "Alphard": (50.5, 3.0), "Hamal": (14.9, 1.5),
}

# name -> (distance_ly, taille apparente linéaire en années-lumière)
DEEP_SKY_INFO = {
    "M31 Andromeda Galaxy": (2_500_000, 220_000),
    "M33 Triangulum Galaxy": (2_700_000, 60_000),
    "M81 Bode's Galaxy": (12_000_000, 90_000),
    "M82 Cigar Galaxy": (12_000_000, 37_000),
    "M104 Sombrero Galaxy": (28_000_000, 50_000),
    "M51 Whirlpool Galaxy": (23_000_000, 60_000),
    "M63 Sunflower Galaxy": (27_000_000, 100_000),
    "M101 Pinwheel Galaxy": (21_000_000, 170_000),
    "M87 Virgo A": (53_000_000, 120_000),
    "M74 Phantom Galaxy": (32_000_000, 95_000),
    "M1 Crab Nebula": (6_500, 11),
    "M8 Lagoon Nebula": (4_100, 110),
    "M16 Eagle Nebula": (7_000, 70),
    "M17 Swan Nebula": (5_500, 15),
    "M20 Trifid Nebula": (5_200, 40),
    "M27 Dumbbell Nebula": (1_360, 3),
    "M42 Orion Nebula": (1_344, 24),
    "M43 De Mairan's Nebula": (1_600, 20),
    "M57 Ring Nebula": (2_300, 1.3),
    "M76 Little Dumbbell": (2_500, 1.7),
    "M97 Owl Nebula": (2_030, 3.4),
    "NGC 7000 North America": (1_800, 100),
    "M3 Globular Cluster": (33_900, 180),
    "M4 Globular Cluster": (7_200, 75),
    "M5 Globular Cluster": (24_500, 165),
    "M6 Butterfly Cluster": (1_600, 25),
    "M7 Ptolemy Cluster": (980, 25),
    "M11 Wild Duck Cluster": (6_200, 23),
    "M13 Hercules Cluster": (22_200, 145),
    "M15 Pegasus Cluster": (33_600, 175),
    "M22 Sagittarius Cluster": (10_600, 70),
    "M35 Open Cluster": (2_800, 30),
    "M36 Open Cluster": (4_100, 14),
    "M37 Open Cluster": (4_500, 25),
    "M38 Open Cluster": (4_200, 25),
    "M44 Beehive Cluster": (577, 15),
    "M45 Pleiades": (444, 8),
    "NGC 869 Double Cluster": (7_600, 70),
}

SOLAR_SYSTEM_PHYSICAL = {
    "Sun":     {"diameter_km": 1_392_700,  "mass_kg": 1.989e30},
    "Moon":    {"diameter_km": 3_474.8,    "mass_kg": 7.342e22},
    "Mercury": {"diameter_km": 4_879,      "mass_kg": 3.3011e23},
    "Venus":   {"diameter_km": 12_104,     "mass_kg": 4.8675e24},
    "Mars":    {"diameter_km": 6_779,      "mass_kg": 6.4171e23},
    "Jupiter": {"diameter_km": 139_820,    "mass_kg": 1.8982e27},
    "Saturn":  {"diameter_km": 116_460,    "mass_kg": 5.6834e26},
    "Uranus":  {"diameter_km": 50_724,     "mass_kg": 8.6810e25},
    "Neptune": {"diameter_km": 49_244,     "mass_kg": 1.02413e26},
}

LY_KM = 9.4607e12
SUN_RADIUS_KM = 696_340.0
SUN_MASS_KG = 1.989e30