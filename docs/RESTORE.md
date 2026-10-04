# Restoring your data

Every copy of your data is the same encrypted `.vault` file. Any copy can be opened with the
**passphrase that was valid when it was saved**, or with the **recovery key** (which never changes).

## 1. Undo recent changes (server version history)

The server keeps the last 30 saves.

1. Settings → Backup & restore → **Version history**.
2. Click **Restore** next to the version you want. It is copied forward as the newest version;
   nothing is deleted.
3. The app locks. Unlock with the passphrase that was valid at that time.

## 2. Restore from a Google Drive backup or an exported file

1. Download the file (Drive folder "Artha backups", e.g. `artha_2026-10-04_0300.vault`).
2. In the app:
   - **Existing vault:** Settings → Backup & restore → **Import vault file…**
   - **New/empty server:** on the "Create your vault" screen choose **Restore from a .vault backup
     file instead**.
3. Enter that file's passphrase (or tick "Use recovery key"). The file is verified in the browser,
   uploaded as the newest version, and the app locks. Unlock it.

## 3. Rebuild the whole server

1. Deploy a fresh server ([DEPLOY.md](DEPLOY.md)) and complete server setup (new login + TOTP).
2. Follow section 2 with your latest backup.

If you still have the old `artha_data` Docker volume (or an EBS snapshot), you can instead copy
its `vault/` folder into the new volume. `auth.json` can be copied too, to keep the old login.

## 4. Fully offline (no Artha server or web app)

`backend/scripts/decrypt_vault.py` decrypts a `.vault` into a normal SQLite file on your own computer.

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install argon2-cffi cryptography
.venv/bin/python scripts/decrypt_vault.py ~/Downloads/artha_2026-10-04_0300.vault ~/artha.sqlite
#   --recovery   use the recovery key instead of the passphrase
#   --secrets    also decrypt passwords/PAN/account numbers (*_Enc columns)
sqlite3 ~/artha.sqlite "SELECT * FROM vAccountBalances;"
```

The output is **not encrypted**. Delete it when finished (`rm -P` on macOS, or empty the trash).

The format is simple enough to reimplement if needed: see [SECURITY.md](SECURITY.md) → "Vault file
format" (Argon2id → unwrap DEK with AES-GCM → AES-GCM decrypt with the header as AAD).

## 5. Forgotten passphrase

On the unlock screen choose **Forgot passphrase?**, enter the recovery key, and set a new
passphrase. Then export a fresh `.vault` and make sure your recovery key is still stored safely.

## 6. Lost login password or authenticator

These protect server access only. On the server:

```bash
docker compose exec api sh -c 'rm /data/auth.json'   # or delete it from the data volume
docker compose restart api
```

Open the site and repeat server setup (needs `ARTHA_SETUP_TOKEN`). The vault is untouched.

## What cannot be recovered

If **both** the passphrase (for every backup you have) **and** the recovery key are lost, the
data is unrecoverable by design. Nobody, including the server operator, can decrypt it.

## Practise once

After setting up, do a restore drill: export a `.vault`, run the offline script on it, and confirm
you can see your accounts. Then delete the decrypted file.
