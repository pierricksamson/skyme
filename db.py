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

DB_PATH = os.path.join("storage", "skyme.db")

DEFAULT_SETTINGS = {
    "zoom_mode": "auto",
    "zoom_value": 1.0,
    "pref_mode": "margin",
    "pref_margin": 30,
    "pref_fixed_start": "20:00",
    "pref_fixed_end": "06:00",
    "pref_min_alt": 10.0,
    "red_filter": False,
    "loc_mode": "auto",
    "loc_lat": None,
    "loc_lon": None,
    "loc_elev": 0.0,
}

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
                zoom_mode TEXT NOT NULL DEFAULT 'auto',
                zoom_value REAL NOT NULL DEFAULT 1.0,
                pref_mode TEXT NOT NULL DEFAULT 'margin',
                pref_margin INTEGER NOT NULL DEFAULT 30,
                pref_fixed_start TEXT NOT NULL DEFAULT '20:00',
                pref_fixed_end TEXT NOT NULL DEFAULT '06:00',
                pref_min_alt REAL NOT NULL DEFAULT 10.0,
                red_filter INTEGER NOT NULL DEFAULT 0,
                loc_mode TEXT NOT NULL DEFAULT 'auto',
                loc_lat REAL,
                loc_lon REAL,
                loc_elev REAL NOT NULL DEFAULT 0,
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
            """
        )
        existing_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(settings)")
        }

        migrations = {
            "loc_mode": "ALTER TABLE settings ADD COLUMN loc_mode TEXT NOT NULL DEFAULT 'auto'",
            "loc_lat": "ALTER TABLE settings ADD COLUMN loc_lat REAL",
            "loc_lon": "ALTER TABLE settings ADD COLUMN loc_lon REAL",
            "loc_elev": "ALTER TABLE settings ADD COLUMN loc_elev REAL NOT NULL DEFAULT 0",
        }

        for col, ddl in migrations.items():
            if col not in existing_cols:
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

def get_plan(user_id, date_str):
    """Retourne {date, objects, note, updated_at} ou None si aucun plan."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT date, objects, note, updated_at FROM plans WHERE user_id = ? AND date = ?",
            (user_id, date_str),
        ).fetchone()
        if row is None:
            return None
        data = dict(row)
        try:
            data["objects"] = json.loads(data["objects"])
        except (TypeError, ValueError):
            data["objects"] = []
        return data
    finally:
        conn.close()


def save_plan(user_id, date_str, objects, note=""):
    """Crée ou remplace le plan d'un utilisateur pour un jour donné."""
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO plans (user_id, date, objects, note, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, date) DO UPDATE SET
                objects = excluded.objects,
                note = excluded.note,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                date_str,
                json.dumps(objects, ensure_ascii=False),
                note or "",
                datetime.now(timezone.utc).isoformat(),
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