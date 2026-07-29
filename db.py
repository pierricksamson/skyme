"""
Couche d'accès SQLite pour Skyme.

- Comptes utilisateurs (créés uniquement via create.py, pas d'inscription
  depuis l'application).
- Sessions "à vie" (le cookie de session est permanent, voir app.py).
- Paramètres utilisateur (zoom, plage horaire, altitude min, mode nocturne
  "red filter", etc.) : plus rien n'est stocké côté client (localStorage),
  tout vit dans la base.
- Plans de soirée (objets prévus + note, par jour) : voir /api/plan.
"""
import json
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
import os

from werkzeug.security import check_password_hash, generate_password_hash

from config import DEFAULT_SETTINGS, PLAN_SETTINGS_KEYS

DB_PATH = os.path.join("storage", "skyme.db")

# Type attendu pour chaque paramètre modifiable via /api/settings
ALLOWED_SETTINGS = {
    "zoom_mode": str,
    "zoom_value": float,
    "pref_mode": str,
    "pref_margin": int,
    "pref_fixed_start": str,
    "pref_fixed_end": str,
    "pref_min_alt": float,
    "red_filter": bool,
    "loc_mode": str,
    "loc_lat": float,
    "loc_lon": float,
    "loc_elev": float,
}

# Champs pouvant être explicitement remis à NULL (ex. "pas de position du
# tout" choisi côté client). Sans cette liste, update_settings() tentait
# caster(None) -> TypeError -> l'update était silencieusement ignoré et
# l'ancienne latitude/longitude restait en base malgré la demande de reset.
NULLABLE_SETTINGS = {"loc_lat", "loc_lon"}

# Paramètres propres à chaque plan de soirée (lieu, plage horaire, altitude
# min). Même forme que ALLOWED_SETTINGS/NULLABLE_SETTINGS ci-dessus, mais
# stockés par plan plutôt que globalement pour l'utilisateur : un plan donné
# peut ainsi avoir un lieu et des horaires différents des réglages généraux.
PLAN_SETTINGS_FIELDS = {key: ALLOWED_SETTINGS[key] for key in PLAN_SETTINGS_KEYS}
PLAN_SETTINGS_NULLABLE = {"loc_lat", "loc_lon"}


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_connection()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                passkey_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
                user_id INTEGER PRIMARY KEY,
                zoom_mode TEXT NOT NULL DEFAULT '{zoom_mode}',
                zoom_value REAL NOT NULL DEFAULT {zoom_value},
                pref_mode TEXT NOT NULL DEFAULT '{pref_mode}',
                pref_margin INTEGER NOT NULL DEFAULT {pref_margin},
                pref_fixed_start TEXT NOT NULL DEFAULT '{pref_fixed_start}',
                pref_fixed_end TEXT NOT NULL DEFAULT '{pref_fixed_end}',
                pref_min_alt REAL NOT NULL DEFAULT {pref_min_alt},
                red_filter INTEGER NOT NULL DEFAULT {red_filter},
                loc_mode TEXT NOT NULL DEFAULT '{loc_mode}',
                loc_lat REAL,
                loc_lon REAL,
                loc_elev REAL NOT NULL DEFAULT {loc_elev},
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS favorites (
                user_id INTEGER NOT NULL,
                object_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (user_id, object_name),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS plans (
                user_id INTEGER NOT NULL,
                date TEXT NOT NULL,
                objects TEXT NOT NULL DEFAULT '[]',
                note TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                loc_mode TEXT NOT NULL DEFAULT '{loc_mode}',
                loc_lat REAL,
                loc_lon REAL,
                loc_elev REAL NOT NULL DEFAULT {loc_elev},
                pref_mode TEXT NOT NULL DEFAULT '{pref_mode}',
                pref_margin INTEGER NOT NULL DEFAULT {pref_margin},
                pref_fixed_start TEXT NOT NULL DEFAULT '{pref_fixed_start}',
                pref_fixed_end TEXT NOT NULL DEFAULT '{pref_fixed_end}',
                pref_min_alt REAL NOT NULL DEFAULT {pref_min_alt},
                PRIMARY KEY (user_id, date),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                object_name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'seen',
                date TEXT NOT NULL,
                time TEXT,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_journal_user_date
                ON journal(user_id, date);
            """.format(
                zoom_mode=DEFAULT_SETTINGS["zoom_mode"],
                zoom_value=DEFAULT_SETTINGS["zoom_value"],
                pref_mode=DEFAULT_SETTINGS["pref_mode"],
                pref_margin=DEFAULT_SETTINGS["pref_margin"],
                pref_fixed_start=DEFAULT_SETTINGS["pref_fixed_start"],
                pref_fixed_end=DEFAULT_SETTINGS["pref_fixed_end"],
                pref_min_alt=DEFAULT_SETTINGS["pref_min_alt"],
                red_filter=int(DEFAULT_SETTINGS["red_filter"]),
                loc_mode=DEFAULT_SETTINGS["loc_mode"],
                loc_elev=DEFAULT_SETTINGS["loc_elev"],
            )
        )
        existing_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(settings)")
        }

        migrations = {
            "loc_mode": f"ALTER TABLE settings ADD COLUMN loc_mode TEXT NOT NULL DEFAULT '{DEFAULT_SETTINGS['loc_mode']}'",
            "loc_lat": "ALTER TABLE settings ADD COLUMN loc_lat REAL",
            "loc_lon": "ALTER TABLE settings ADD COLUMN loc_lon REAL",
            "loc_elev": f"ALTER TABLE settings ADD COLUMN loc_elev REAL NOT NULL DEFAULT {DEFAULT_SETTINGS['loc_elev']}",
        }

        for col, ddl in migrations.items():
            if col not in existing_cols:
                conn.execute(ddl)

        # Plans existants créés avant l'ajout des paramètres par plan (lieu,
        # plage horaire, altitude min) : on ajoute les colonnes manquantes,
        # avec les mêmes valeurs par défaut que les réglages globaux.
        existing_plan_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(plans)")
        }
        plan_migrations = {
            "loc_mode": f"ALTER TABLE plans ADD COLUMN loc_mode TEXT NOT NULL DEFAULT '{DEFAULT_SETTINGS['loc_mode']}'",
            "loc_lat": "ALTER TABLE plans ADD COLUMN loc_lat REAL",
            "loc_lon": "ALTER TABLE plans ADD COLUMN loc_lon REAL",
            "loc_elev": f"ALTER TABLE plans ADD COLUMN loc_elev REAL NOT NULL DEFAULT {DEFAULT_SETTINGS['loc_elev']}",
            "pref_mode": f"ALTER TABLE plans ADD COLUMN pref_mode TEXT NOT NULL DEFAULT '{DEFAULT_SETTINGS['pref_mode']}'",
            "pref_margin": f"ALTER TABLE plans ADD COLUMN pref_margin INTEGER NOT NULL DEFAULT {DEFAULT_SETTINGS['pref_margin']}",
            "pref_fixed_start": f"ALTER TABLE plans ADD COLUMN pref_fixed_start TEXT NOT NULL DEFAULT '{DEFAULT_SETTINGS['pref_fixed_start']}'",
            "pref_fixed_end": f"ALTER TABLE plans ADD COLUMN pref_fixed_end TEXT NOT NULL DEFAULT '{DEFAULT_SETTINGS['pref_fixed_end']}'",
            "pref_min_alt": f"ALTER TABLE plans ADD COLUMN pref_min_alt REAL NOT NULL DEFAULT {DEFAULT_SETTINGS['pref_min_alt']}",
        }
        for col, ddl in plan_migrations.items():
            if col not in existing_plan_cols:
                conn.execute(ddl)

        conn.commit()
    finally:
        conn.close()


# ---------- Comptes utilisateurs ----------

def create_user(username, passkey):
    """Crée un compte. Lève sqlite3.IntegrityError si le username existe déjà."""
    conn = get_connection()
    try:
        passkey_hash = generate_password_hash(passkey)
        cur = conn.execute(
            "INSERT INTO users (username, passkey_hash, created_at) VALUES (?, ?, ?)",
            (username, passkey_hash, datetime.now(timezone.utc).isoformat()),
        )
        user_id = cur.lastrowid
        conn.execute("INSERT INTO settings (user_id) VALUES (?)", (user_id,))
        conn.commit()
        return user_id
    finally:
        conn.close()


def verify_user(username, passkey):
    """Retourne l'id utilisateur si les identifiants sont valides, sinon None."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, passkey_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
        if row is None:
            return None
        if not check_password_hash(row["passkey_hash"], passkey):
            return None
        return row["id"]
    finally:
        conn.close()


# ---------- Sessions (stockées en base, cookie permanent côté client) ----------

def create_session(user_id):
    token = secrets.token_urlsafe(32)
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user_id, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()
    return token


def get_user_by_session(token):
    if not token:
        return None
    conn = get_connection()
    try:
        row = conn.execute(
            """
            SELECT users.id AS id, users.username AS username
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?
            """,
            (token,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_session(token):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
    finally:
        conn.close()


# ---------- Paramètres utilisateur (remplace localStorage) ----------

def get_settings(user_id):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM settings WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is None:
            conn.execute("INSERT INTO settings (user_id) VALUES (?)", (user_id,))
            conn.commit()
            row = conn.execute(
                "SELECT * FROM settings WHERE user_id = ?", (user_id,)
            ).fetchone()
        data = dict(row)
        data.pop("user_id", None)
        data["red_filter"] = bool(data["red_filter"])
        return data
    finally:
        conn.close()


def update_settings(user_id, updates: dict):
    fields, values = [], []
    for key, raw_value in updates.items():
        caster = ALLOWED_SETTINGS.get(key)
        if caster is None:
            continue
        if raw_value is None:
            if key in NULLABLE_SETTINGS:
                fields.append(f"{key} = ?")
                values.append(None)
            # Champ non-nullable envoyé à null : ignoré (comportement
            # d'origine), pas d'erreur car ce n'est pas censé arriver.
            continue
        try:
            value = (1 if raw_value else 0) if caster is bool else caster(raw_value)
        except (TypeError, ValueError):
            continue
        fields.append(f"{key} = ?")
        values.append(value)

    if not fields:
        return

    conn = get_connection()
    try:
        conn.execute("INSERT OR IGNORE INTO settings (user_id) VALUES (?)", (user_id,))
        conn.execute(
            f"UPDATE settings SET {', '.join(fields)} WHERE user_id = ?",
            (*values, user_id),
        )
        conn.commit()
    finally:
        conn.close()


# ---------- Favoris (objets du catalogue marqués par l'utilisateur) ----------

def get_favorites(user_id):
    """Retourne la liste des noms d'objets favoris de l'utilisateur."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT object_name FROM favorites WHERE user_id = ?", (user_id,)
        ).fetchall()
        return [row["object_name"] for row in rows]
    finally:
        conn.close()


def add_favorite(user_id, object_name):
    conn = get_connection()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO favorites (user_id, object_name, created_at) VALUES (?, ?, ?)",
            (user_id, object_name, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


def remove_favorite(user_id, object_name):
    conn = get_connection()
    try:
        conn.execute(
            "DELETE FROM favorites WHERE user_id = ? AND object_name = ?",
            (user_id, object_name),
        )
        conn.commit()
    finally:
        conn.close()


def toggle_favorite(user_id, object_name):
    """Bascule l'état favori d'un objet et retourne le nouvel état (bool)."""
    current = set(get_favorites(user_id))
    if object_name in current:
        remove_favorite(user_id, object_name)
        return False
    add_favorite(user_id, object_name)
    return True


# ---------- Plans de soirée (objets prévus + note, par jour) ----------

def _row_to_plan(row):
    data = dict(row)
    data.pop("user_id", None)
    try:
        data["objects"] = json.loads(data["objects"])
    except (TypeError, ValueError):
        data["objects"] = []
    return data


def get_plan(user_id, date_str):
    """Retourne le plan complet (objets, note, lieu, plage horaire, altitude
    min...) ou None si aucun plan n'existe pour ce jour."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM plans WHERE user_id = ? AND date = ?",
            (user_id, date_str),
        ).fetchone()
        if row is None:
            return None
        return _row_to_plan(row)
    finally:
        conn.close()


def list_plans(user_id):
    """Retourne tous les plans de l'utilisateur (les plus proches d'abord),
    avec leurs paramètres, pour la liste de la page Prévoir."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM plans WHERE user_id = ? ORDER BY date ASC",
            (user_id,),
        ).fetchall()
        return [_row_to_plan(row) for row in rows]
    finally:
        conn.close()


def _resolve_plan_settings(plan_settings):
    """Caste/valide un dict de paramètres de plan (partiel ou complet) et
    renvoie les 9 valeurs dans l'ordre des colonnes, prêtes pour le SQL.
    Les champs absents ou invalides restent à None (voir save_plan pour la
    résolution des valeurs par défaut)."""
    plan_settings = plan_settings or {}
    cols = (
        "loc_mode", "loc_lat", "loc_lon", "loc_elev",
        "pref_mode", "pref_margin", "pref_fixed_start", "pref_fixed_end",
        "pref_min_alt",
    )
    values = []
    for col in cols:
        raw_value = plan_settings.get(col)
        if raw_value is None:
            values.append(None)
            continue
        caster = PLAN_SETTINGS_FIELDS[col]
        try:
            values.append(caster(raw_value))
        except (TypeError, ValueError):
            values.append(None)
    return values


def save_plan(user_id, date_str, objects, note="", plan_settings=None):
    """Crée ou met à jour le plan d'un utilisateur pour un jour donné.

    `plan_settings` (optionnel) contient les paramètres propres au plan :
    loc_mode/loc_lat/loc_lon/loc_elev (lieu), pref_mode/pref_margin/
    pref_fixed_start/pref_fixed_end (plage horaire) et pref_min_alt
    (altitude min). Les valeurs absentes du dict sont résolues par l'appelant
    (app.py) avant l'appel : à la création, à partir des réglages globaux de
    l'utilisateur ; à la mise à jour, à partir du plan existant."""
    values = _resolve_plan_settings(plan_settings)
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO plans (
                user_id, date, objects, note, updated_at,
                loc_mode, loc_lat, loc_lon, loc_elev,
                pref_mode, pref_margin, pref_fixed_start, pref_fixed_end, pref_min_alt
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, date) DO UPDATE SET
                objects = excluded.objects,
                note = excluded.note,
                updated_at = excluded.updated_at,
                loc_mode = excluded.loc_mode,
                loc_lat = excluded.loc_lat,
                loc_lon = excluded.loc_lon,
                loc_elev = excluded.loc_elev,
                pref_mode = excluded.pref_mode,
                pref_margin = excluded.pref_margin,
                pref_fixed_start = excluded.pref_fixed_start,
                pref_fixed_end = excluded.pref_fixed_end,
                pref_min_alt = excluded.pref_min_alt
            """,
            (
                user_id,
                date_str,
                json.dumps(objects, ensure_ascii=False),
                note or "",
                datetime.now(timezone.utc).isoformat(),
                *values,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def delete_plan(user_id, date_str):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM plans WHERE user_id = ? AND date = ?", (user_id, date_str))
        conn.commit()
    finally:
        conn.close()


# ---------- Journal (historique des observations : vu / tentative échouée) ----------

def add_journal_entry(user_id, object_name, category, status, date_str, time_str=None, note=""):
    conn = get_connection()
    try:
        cur = conn.execute(
            """
            INSERT INTO journal (user_id, object_name, category, status, date, time, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id, object_name, category or "", status or "seen",
                date_str, (time_str or None), note or "",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_journal(user_id, limit=500):
    """Retourne l'historique de l'utilisateur, du plus récent au plus ancien
    (date puis heure puis date de création)."""
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT id, object_name, category, status, date, time, note, created_at
            FROM journal WHERE user_id = ?
            ORDER BY date DESC, (time IS NULL) ASC, time DESC, created_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def delete_journal_entry(user_id, entry_id):
    conn = get_connection()
    try:
        cur = conn.execute(
            "DELETE FROM journal WHERE user_id = ? AND id = ?", (user_id, entry_id)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def get_plan_counts(user_id, start_date, end_date):
    """Retourne {date: nombre d'objets prévus} pour chaque jour ayant un plan
    dans la plage [start_date, end_date] (inclus), utilisé pour la bulle de
    l'agenda."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT date, objects FROM plans WHERE user_id = ? AND date BETWEEN ? AND ?",
            (user_id, start_date, end_date),
        ).fetchall()
        counts = {}
        for row in rows:
            try:
                objs = json.loads(row["objects"])
            except (TypeError, ValueError):
                objs = []
            counts[row["date"]] = len(objs)
        return counts
    finally:
        conn.close()