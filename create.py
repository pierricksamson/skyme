#!/usr/bin/env python3
"""
Crée un compte utilisateur Skyme.

L'application ne propose aucune inscription : ce script est le seul moyen
de créer un compte.

Usage :
    python create.py -user user12345678 -passkey 12345678

Format imposé :
    - identifiant : le mot "user" suivi de 8 chiffres (ex: user12345678)
    - passkey     : une suite de 8 chiffres
"""
import argparse
import re
import sqlite3
import sys

from db import create_user, init_db

USERNAME_RE = re.compile(r"^user\d{8}$")
PASSKEY_RE = re.compile(r"^\d{8}$")


def main():
    parser = argparse.ArgumentParser(
        description="Crée un compte Skyme (identifiant + passkey)."
    )
    parser.add_argument(
        "-user",
        dest="user",
        required=True,
        help="Identifiant, format : user + 8 chiffres (ex: user12345678)",
    )
    parser.add_argument(
        "-passkey",
        dest="passkey",
        required=True,
        help="Code d'accès à 8 chiffres (ex: 12345678)",
    )
    args = parser.parse_args()

    if not USERNAME_RE.match(args.user):
        print(
            f"Erreur : l'identifiant doit être 'user' suivi de 8 chiffres "
            f"(ex: user12345678). Reçu : {args.user!r}"
        )
        sys.exit(1)

    if not PASSKEY_RE.match(args.passkey):
        print(
            f"Erreur : le passkey doit être une suite de 8 chiffres. "
            f"Reçu : {args.passkey!r}"
        )
        sys.exit(1)

    init_db()

    try:
        user_id = create_user(args.user, args.passkey)
    except sqlite3.IntegrityError:
        print(f"Erreur : le compte {args.user!r} existe déjà.")
        sys.exit(1)

    print(f"Compte créé : {args.user} (id={user_id})")


if __name__ == "__main__":
    main()
