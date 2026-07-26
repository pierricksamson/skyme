"""
Couche d'accès SQLite pour Skyme.

- Comptes utilisateurs (créés uniquement via create.py, pas d'inscription
  depuis l'application).
- Sessions "à vie" (le cookie de session est permanent, voir app.py).
- Paramètres utilisateur (zoom, plage horaire, altitude min, mode nocturne
  "red filter", etc.) : plus rien n'est stocké côté client (localStorage),
  tout vit dans la base.
"""
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from werkzeug.security import check_password_hash, generate_password_hash

DB_PATH = Path(__file__).resolve().parent / "skyme.db"

DEFAULT_SETTINGS = {
    "zoom_mode": "auto",
    "zoom_value": 1.0,
    "pref_mode": "margin",
    "pref_margin": 30,
    "pref_fixed_start": "20:00",
    "pref_fixed_end": "06:00",
    "pref_min_alt": 10.0,
    "red_filter": False,
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
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )
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
