"""Offline recovery: decrypt an Artha .vault file to a plain SQLite database.

Use this if the Artha server or web app is unavailable. Runs entirely on your machine.

    pip install argon2-cffi cryptography
    python decrypt_vault.py backup.vault out.sqlite              # asks for the passphrase
    python decrypt_vault.py backup.vault out.sqlite --recovery   # asks for the recovery key
    python decrypt_vault.py backup.vault out.sqlite --secrets    # also decrypt *_Enc columns

The output file is UNENCRYPTED. Open it with `sqlite3` or DB Browser for SQLite, then delete it
securely when done. Without --secrets, sensitive columns (*_Enc: passwords, PAN, account numbers)
stay field-encrypted.
"""

import argparse
import base64
import getpass
import json
import os
import sqlite3
import struct
import sys
import unicodedata

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b"ARTHA1"
B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def b32decode(s: str) -> bytes:
    clean = "".join(c for c in s.upper() if c in B32)
    bits = value = 0
    out = bytearray()
    for ch in clean:
        value = (value << 5) | B32.index(ch)
        bits += 5
        if bits >= 8:
            out.append((value >> (bits - 8)) & 255)
            bits -= 8
    return bytes(out)


def open_packed(key: bytes, packed_b64: str) -> bytes:
    raw = base64.b64decode(packed_b64)
    return AESGCM(key).decrypt(raw[:12], raw[12:], None)


def parse(blob: bytes):
    if not blob.startswith(MAGIC):
        sys.exit("Not an Artha vault file")
    o = len(MAGIC)
    (hlen,) = struct.unpack(">I", blob[o : o + 4])
    o += 4
    header_bytes = blob[o : o + hlen]
    o += hlen
    return json.loads(header_bytes), header_bytes, blob[o : o + 12], blob[o + 12 :]


def unwrap_dek(header: dict, secret: str, recovery: bool) -> bytes:
    if recovery:
        kek = b32decode(secret)
        if len(kek) != 32:
            sys.exit("Recovery key is malformed")
        wrapped = header["wrapped_dek_recovery"]
    else:
        kdf = header["kdf"]
        kek = hash_secret_raw(
            secret=unicodedata.normalize("NFKC", secret).encode(),
            salt=base64.b64decode(kdf["salt"]),
            time_cost=kdf["iter"],
            memory_cost=kdf["mem"],
            parallelism=kdf["par"],
            hash_len=32,
            type=Type.ID,
        )
        wrapped = header["wrapped_dek_pass"]
    try:
        return open_packed(kek, wrapped)
    except Exception:
        sys.exit("Wrong passphrase or recovery key")


def secrets_key(dek: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes(32), info=b"artha-secrets").derive(
        dek
    )


def decrypt_secret_columns(path: str, key: bytes) -> int:
    con = sqlite3.connect(path)
    n = 0
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    for t in tables:
        cols = [r[1] for r in con.execute(f'PRAGMA table_info("{t}")')]
        pk = cols[0]
        for c in (c for c in cols if c.endswith("_Enc")):
            # Identifiers come from the decrypted file's own schema, not user input.
            sql = f'SELECT "{pk}", "{c}" FROM "{t}" WHERE "{c}" LIKE \'s1:%\''  # noqa: S608
            rows = con.execute(sql)
            for rid, val in rows.fetchall():
                plain = open_packed(key, val[3:]).decode()
                upd = f'UPDATE "{t}" SET "{c}" = ? WHERE "{pk}" = ?'  # noqa: S608
                con.execute(upd, (plain, rid))
                n += 1
    con.commit()
    con.close()
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("vault")
    ap.add_argument("output")
    ap.add_argument("--recovery", action="store_true", help="use the recovery key")
    ap.add_argument("--secrets", action="store_true", help="also decrypt *_Enc columns")
    a = ap.parse_args()
    if os.path.exists(a.output):
        sys.exit(f"{a.output} already exists; refusing to overwrite")

    with open(a.vault, "rb") as f:
        header, header_bytes, iv, ct = parse(f.read())
    secret = os.environ.get("ARTHA_SECRET") or getpass.getpass(
        "Recovery key: " if a.recovery else "Vault passphrase: "
    )
    dek = unwrap_dek(header, secret, a.recovery)
    try:
        db = AESGCM(dek).decrypt(iv, ct, header_bytes)
    except Exception:
        sys.exit("Vault data failed integrity check (file corrupted or tampered)")

    fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(db)
    msg = (
        f"Wrote {a.output} (schema v{header.get('schema_version')}, "
        f"saved {header.get('updated_on')})"
    )
    if a.secrets:
        msg += f"; decrypted {decrypt_secret_columns(a.output, secrets_key(dek))} secret values"
    print(msg)
    print("WARNING: this file is not encrypted. Delete it securely when finished.")


if __name__ == "__main__":
    main()
