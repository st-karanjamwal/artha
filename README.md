# Artha

A private, end-to-end-encrypted personal finance vault for one household. It stores family
members, banks, accounts, credentials and transactions, and shows balances and a dashboard.

The whole database is one SQLite file. It is encrypted **in your browser** and the server only ever
sees an opaque encrypted blob. The server never sees your passphrase, keys or data.

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation: encryption, server auth (password + TOTP), save/sync, versions, backup, export/import | ✅ Done |
| 1 | Family, banks, accounts, holders/nominees, credentials, security questions, transactions, statement import, dashboard | ✅ Done |
| 2–7 | Mutual funds, insurance, property, gold/kitty, shares, loans | Planned ([docs/PLAN.md](docs/PLAN.md)) |

---

## Contents

- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Run it locally](#run-it-locally)
- [First run walkthrough](#first-run-walkthrough)
- [Using the app](#using-the-app)
- [Tests and checks](#tests-and-checks)
- [Backend reference](#backend-reference)
- [Frontend reference](#frontend-reference)
- [Configuration (.env)](#configuration-env)
- [Deploying, backups and restoring](#deploying-backups-and-restoring)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
Browser (React + TypeScript)                         Server (Python FastAPI)
┌─────────────────────────────────────────┐          ┌─────────────────────────────┐
│ passphrase ─Argon2id─► KEK ─unwrap─► DEK │          │ login: password + TOTP      │
│ sql.js (SQLite in WASM), all queries     │  HTTPS   │ GET/PUT /api/vault (blob)   │
│ save: export DB ─AES-256-GCM(DEK)─► blob │ ───────► │ last 30 versions on disk    │
└─────────────────────────────────────────┘          │ nightly → Google Drive      │
                                                     └─────────────────────────────┘
```

There are **two separate secrets**:

| Secret | Protects | Where it's checked |
|---|---|---|
| **Server login password + authenticator code** | Who may download or upload the encrypted blob | Server |
| **Vault master passphrase** (and the one-time **recovery key**) | The data itself | Only in your browser; never sent anywhere |

Losing the login password is recoverable (reset it on the server). Losing **both** the passphrase
and the recovery key means the data cannot be decrypted by anyone. That is by design.

More detail: [docs/SECURITY.md](docs/SECURITY.md).

## Repository layout

```
artha/
├─ README.md               you are here
├─ CLAUDE.md               rules for AI-assisted development
├─ docs/
│  ├─ PLAN.md              master plan (all phases)
│  ├─ SECURITY.md          security model, threat notes
│  ├─ DEPLOY.md            EC2 + Docker + nginx + Google Drive setup
│  └─ RESTORE.md           every way to get your data back
├─ docker-compose.yml      api + web containers
├─ .env.example            server configuration template
├─ nginx/artha.conf        host nginx server block (TLS, HSTS)
├─ backend/                FastAPI storage/auth/backup server
│  ├─ app/
│  │  ├─ main.py           app factory, CSRF header check, security headers
│  │  ├─ auth.py           setup, login, TOTP, sessions, rate limiting
│  │  ├─ vault.py          blob storage, If-Match locking, version history
│  │  ├─ backup_gdrive.py  Google Drive upload + retention + nightly scheduler
│  │  ├─ settings.py       ARTHA_* environment settings
│  │  └─ storage.py        atomic file writes
│  ├─ scripts/
│  │  ├─ gdrive_auth.py    one-time Google OAuth → refresh token
│  │  └─ decrypt_vault.py  offline: .vault → plain .sqlite
│  └─ tests/               pytest
└─ frontend/               React app (all business logic lives here)
   ├─ src/
   │  ├─ crypto/           kdf, aes, vault format, field secrets (+ tests)
   │  ├─ db/               sql.js setup, migrations/*.sql, migration runner, autosave
   │  ├─ repositories/     all queries & business rules (+ tests)
   │  ├─ features/         screens: onboarding, dashboard, family, banks, accounts,
   │  │                    transactions, import, settings
   │  ├─ components/       shared UI: SecretField, MoneyInput, Modal, …
   │  ├─ lib/              money (paise ↔ ₹), dates, validators, API client
   │  └─ app/              routing, layout, session (unlock/lock/save), theme
   └─ e2e/                 Playwright acceptance test
```

## Run it locally

### Prerequisites

- **Python 3.12+**
- **Node.js 20+** and npm
- Optional: Docker (to run the production containers)

### 1. Backend (terminal 1)

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'

# Local-only settings: plain http cookies, a throwaway setup token, data in ./data
export ARTHA_SETUP_TOKEN=dev-setup-token
export ARTHA_COOKIE_SECURE=false
export ARTHA_DATA_DIR=./data
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Check it's up: `curl http://127.0.0.1:8000/api/health` should return `{"status":"ok"}`.

> `ARTHA_COOKIE_SECURE=false` is **only** for `http://localhost`. In production, leave it at
> the default (`true`).

### 2. Frontend (terminal 2)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` to `http://127.0.0.1:8000`. To point it at
another backend, set `ARTHA_API=http://host:port`.

> Reloading the page **locks the vault**, because keys live only in memory. In dev, Vite can
> force a reload when it discovers a new dependency. If you get bounced to the unlock screen,
> just unlock again.

### 3. Or run the production containers

```bash
cp .env.example .env              # then set ARTHA_SETUP_TOKEN, and ARTHA_COOKIE_SECURE=false for plain http
docker compose up -d --build
open http://127.0.0.1:8080
```

## First run walkthrough

1. **Server setup** (once per server). Enter the `ARTHA_SETUP_TOKEN`, choose a **login
   password** (12+ characters), scan the QR code with an authenticator app (Google
   Authenticator, Authy, 1Password…) and enter the 6-digit code.
2. **Create vault.** Choose a **master passphrase** (12+ characters; 4–6 random words work well).
   Key derivation takes a second or two.
3. **Save the recovery key.** It's shown once. Download or print it and keep it offline,
   **not** in the same Google Drive as your backups. You then confirm two of its groups.
4. You're in. Suggested order: **Family** (start with yourself, "Self") → **Banks** →
   **Accounts** → **Transactions** or **Import statement**.

Next time: sign in (password + code) → unlock (passphrase). If the passphrase is forgotten, use
**Forgot passphrase?** with the recovery key and set a new passphrase.

To restore from a `.vault` backup instead of creating a new vault, use **"Restore from a .vault
backup file instead"** on the create screen.

## Using the app

| Screen | What you can do |
|---|---|
| **Dashboard** | Total bank balance; balance by person and by bank; income vs expense for the last 30 days and last 6 months (chart or table); PPF/SSY/FD/RD maturities; top expense categories |
| **Family** | Add/edit people (relationship, DOB → age/minor badge, contact). PAN and Aadhaar are field-encrypted and masked (`••••234F`) with Reveal (30 s) and Copy (clipboard cleared after 30 s) |
| **Banks** | Bank + branch details with IFSC/MICR/SWIFT validation, RM and customer-care contacts |
| **Accounts** | Group by person or bank. Detail tabs: **Overview** (encrypted account number, maturity, reconcile against the bank's balance), **Holders & Nominees** (one primary; joint, nominee with share %, guardian), **Credentials** (net banking / app / UPI / phone banking, all encrypted), **Security Questions**, **Transactions**, **Notes** |
| **Transactions** | Filter by account, dates, category, amount, text. Running balance per account. Add income/expense, **self-transfer** (two linked legs; edits and deletes apply to both), bulk-categorise, link two imported rows as one transfer |
| **Import statement** | Upload CSV/XLSX → pick the header row and map columns (saved per bank) → preview with duplicate detection (date + amount + reference) → import → check the statement closing balance matches → **undo** any import batch |
| **Settings** | Auto-lock timeout, lock on tab hide, require passphrase to reveal; change passphrase; change login password; Google Drive status / back up now; export/import `.vault`; server version history (download/restore); edit lists (account types, modes…) and categories |

Save status is shown top-right (**Saved / Unsaved / Saving… / Save failed / Conflict**).
Changes autosave 3 seconds after the last edit. If another device saved in the meantime, you'll be
asked to reload the latest version; nothing is silently overwritten.

## Tests and checks

```bash
# Backend: 18 tests (auth, TOTP replay, lockout, CSRF, vault locking/versions, backup retention)
cd backend && .venv/bin/pytest -q && .venv/bin/ruff check . && .venv/bin/ruff format --check .

# Frontend: 32 unit tests (crypto, tamper detection, money math, dates, migrations,
# balances, transfers, statement import + duplicates + undo)
cd frontend && npm test && npm run lint && npx tsc --noEmit

# End-to-end acceptance (starts both servers itself, uses a throwaway data dir in frontend/.e2e-data)
cd frontend && npx playwright install chromium   # first time only
npm run e2e
```

The E2E test runs against the production build, under the production Content Security Policy,
and fails on any CSP violation. It covers the acceptance flow: server setup with TOTP → create
vault → add a person, bank, account and transaction → autosave → **inspect the server's file and
assert no plaintext** → lock → reload → wrong passphrase rejected → unlock → data present →
secret masked, then revealed → recovery-key unlock with a new passphrase → **CSV statement import**
(balance matches the statement) → re-import flags duplicates → undo import.

Screenshots of every main screen (desktop + phone, light + dark) for visual review:
`SHOTS=1 npx playwright test e2e/screens.spec.ts` → `frontend/.e2e-data/shots/`.

## Backend reference

The backend is deliberately "dumb": auth, blob storage, versions, backup. It cannot read the vault.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | Liveness |
| `GET /api/auth/status` | – | `{setup_complete, authenticated}` |
| `POST /api/auth/setup` | setup token | Set login password, returns TOTP secret + QR |
| `POST /api/auth/setup/confirm` | setup token | Confirm first TOTP code, starts a session |
| `POST /api/auth/login` | – | Password + TOTP → session cookie |
| `POST /api/auth/logout` | – | End session |
| `POST /api/auth/password` | session | Change login password (needs TOTP); signs out other sessions |
| `GET /api/vault/meta` | session | `{exists, blob_version, updated_on, size}` |
| `GET /api/vault` | session | Encrypted blob; `X-Blob-Version` header |
| `PUT /api/vault` | session | Upload blob; **`If-Match: <blob_version>` required**; `409` if stale |
| `GET /api/vault/versions` | session | Version history (last 30 kept) |
| `GET /api/vault/versions/{v}` | session | Download an old version |
| `POST /api/vault/restore/{v}` | session | Copy an old version forward as newest |
| `GET /api/backup/status` | session | Google Drive backup state |
| `POST /api/backup/run` | session | Back up now |

Notes:

- Every `POST/PUT` must send `X-Artha-Request: 1` (CSRF defence together with the
  `SameSite=Strict` cookie).
- Login: 5 failures per IP (20 globally) in 15 minutes → `429`. TOTP codes cannot be reused.
- Sessions are in memory, so restarting the server signs everyone out. That's intentional.
- On disk (`ARTHA_DATA_DIR`): `auth.json` (Argon2 hash + TOTP secret, mode 600),
  `vault/versions/00000001.vault …`, `vault/meta.json`, `backup_state.json`.
- OpenAPI docs are off by default; set `ARTHA_ENABLE_DOCS=true` for `/api/docs` while developing.

## Frontend reference

- **All business logic is in the browser.** `src/repositories/*.ts` are plain synchronous
  functions over the in-memory SQLite database (`src/db/sql.ts` → `all`, `one`, `run`, `tx`).
  Every write triggers autosave and refreshes the UI via `useDb(() => query(), deps)`.
- **Money** is always `INTEGER` paise. Use `parseToPaise` / `formatINR` (`src/lib/money.ts`) at
  the UI edge only; Indian grouping is `₹12,34,567.00`.
- **Secrets** (`*_Enc` columns) are encrypted with `encryptSecret` (`src/crypto/secrets.ts`) and
  displayed only through `<SecretField>`. Never log them.
- **Schema changes**: add `src/db/migrations/NNN_description.sql` (next number). Migrations run
  automatically on unlock and the vault is re-saved. Never edit a migration that has shipped.
- **Lookups** (account types, roles, modes, relationships) live in the `LookupValues` table and
  are editable in Settings → Lists.
- Stack: React 19, TypeScript, Vite, Tailwind CSS v4, React Router, React Hook Form + Zod,
  Recharts, sql.js, hash-wasm (Argon2id), Web Crypto (AES-GCM/HKDF), PapaParse, SheetJS.
  No runtime CDNs, analytics or telemetry; the CSP allows only `'self'`.

## Configuration (.env)

All server settings use the `ARTHA_` prefix (see [.env.example](.env.example)).

| Variable | Default | Meaning |
|---|---|---|
| `ARTHA_SETUP_TOKEN` | *(empty)* | Required to complete first-run setup. Use a long random value |
| `ARTHA_DATA_DIR` | `./data` (`/data` in Docker) | Where auth, blobs and versions are stored |
| `ARTHA_COOKIE_SECURE` | `true` | `false` only for local http |
| `ARTHA_SESSION_TTL_HOURS` | `12` | Server session lifetime |
| `ARTHA_KEEP_VERSIONS` | `30` | Blob versions kept on the server |
| `ARTHA_TRUST_PROXY` | `false` (`true` in Docker) | Use `X-Real-IP` from your nginx for rate limiting |
| `ARTHA_TIMEZONE` | `Asia/Kolkata` | Backup schedule and file names |
| `ARTHA_GDRIVE_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` / `_FOLDER_ID` | *(empty)* | Google Drive backup (all four needed) |
| `ARTHA_BACKUP_TIME` | `03:00` | Daily backup time (local) |
| `ARTHA_BACKUP_KEEP_DAILY` / `_MONTHLY` | `30` / `12` | Drive retention |
| `ARTHA_ENABLE_DOCS` | `false` | Expose `/api/docs` |
| `ARTHA_WEB_PORT` | `8080` | Host port for the web container (bound to 127.0.0.1) |

## Deploying, backups and restoring

- **Deploy to EC2** (Docker Compose behind host nginx, Let's Encrypt, HSTS):
  [docs/DEPLOY.md](docs/DEPLOY.md)
- **Google Drive backups**: run `backend/scripts/gdrive_auth.py` once, put the four values in
  `.env`. Backups run nightly and on demand, and only the encrypted file is uploaded.
- **Restore** (from server versions, a Drive backup, an exported file, or fully offline with
  `backend/scripts/decrypt_vault.py`): [docs/RESTORE.md](docs/RESTORE.md)

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Server has no ARTHA_SETUP_TOKEN configured" | Set `ARTHA_SETUP_TOKEN` and restart the backend |
| Sign-in works but you're immediately signed out locally | You're on http; set `ARTHA_COOKIE_SECURE=false` for local dev |
| "Too many attempts" | Wait 15 minutes (per-IP lockout), or restart the server to clear it |
| Lost the authenticator / login password | On the server, stop the api, delete `auth.json` in the data dir, restart, and repeat server setup. The vault is unaffected |
| "Vault changed on another device" | Click **Reload latest** and redo your last edit |
| "Vault schema vN is newer than this app" | Deploy the latest frontend |
| Bounced to unlock screen | Auto-lock (Settings → Security), tab-hide lock, or a page reload. Unlock again |
| Statement import shows many "Invalid date" | Pick the right **Date format** in the mapping step |
| Imported balance doesn't match the statement | Check the account's **opening balance** and its *as of* date, and look for transactions before the statement period |
