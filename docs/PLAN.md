# Artha — Personal Finance Vault: Development Plan

> **For Claude Code:** This is the master plan for Artha. Read it fully before writing code.
> Build **one phase at a time**. Phase 0 (foundation) and Phase 1 (banking) must be complete,
> tested and working before starting Phase 2. Ask before changing the security model or the
> database schema conventions described here.

---

## 1. Product summary

Artha is a **single-user, privacy-first personal finance vault** for an Indian household
(owner, spouse, children). It stores bank accounts, credentials, transactions and, in later
phases, mutual funds, insurance, property, gold/silver, kitty, shares and loans — and shows a
consolidated family net worth.

### Non-negotiable principles

1. **End-to-end encryption (zero-knowledge server).** All data is encrypted/decrypted **in the
   browser**. The server only ever stores an encrypted blob. The server never sees the key,
   the passphrase or plaintext data.
2. **Single-file database.** The whole database is one SQLite file, encrypted as a single blob.
3. **Own your backups.** Encrypted blob is backed up to the owner's Google Drive, versioned.
4. **Accessible from any device** via a browser (hosted on AWS EC2, sub-domain).
5. **Simple to maintain.** One user, no multi-tenancy, no over-engineering.

---

## 2. Architecture

```
┌──────────────────────── Browser (any device) ────────────────────────┐
│ React + TypeScript (Vite)                                             │
│  ├─ Unlock screen → passphrase → Argon2id → KEK → unwrap DEK          │
│  ├─ sql.js (SQLite in WASM) – full DB in memory while unlocked        │
│  ├─ Repository layer (TS) – all business logic & queries              │
│  └─ Save: export DB → AES-256-GCM encrypt with DEK → PUT /vault       │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ HTTPS (encrypted blob only)
┌──────────────────────────────────▼───────────────────────────────────┐
│ Python FastAPI (thin, "dumb" storage server) – Docker on EC2          │
│  ├─ Auth: login password (bcrypt/argon2) + TOTP 2FA, session cookie   │
│  ├─ GET/PUT /vault  (blob + version for optimistic locking)           │
│  ├─ Versioned blob history on disk (last N versions)                  │
│  └─ Scheduled job: upload encrypted blob to Google Drive (retain N)   │
└──────────────────────────────────────────────────────────────────────┘
```

**Why business logic lives in the browser:** if Python decrypted the database, the key would
pass through the server and encryption would no longer be end-to-end. Python stays as the
storage/auth/backup service only.

### Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| UI | Tailwind CSS + shadcn/ui (or Mantine) ; React Router ; TanStack Table ; Recharts |
| Forms/validation | React Hook Form + Zod |
| In-browser DB | **sql.js** (SQLite WASM). Whole DB loaded in memory (fine for single user, < 50 MB) |
| Crypto | Web Crypto API (AES-256-GCM) + **Argon2id** via `hash-wasm` |
| Backend | Python 3.12, FastAPI, Uvicorn, Pydantic |
| Backend storage | Local filesystem (Docker volume) for blob + metadata JSON (no server DB needed) |
| Auth | Argon2 password hash + TOTP (`pyotp`), HttpOnly Secure SameSite=Strict cookie |
| Backup | Google Drive API (service account or OAuth refresh token), encrypted blob only |
| Tests | Vitest (frontend logic, crypto, migrations), Playwright (E2E), pytest (backend) |
| Deploy | Docker Compose on EC2, Nginx reverse proxy, Let's Encrypt (Certbot) |

---

## 3. Security model (implement exactly)

### 3.1 Keys

- **DEK (Data Encryption Key):** random 256-bit AES key, generated once at vault creation.
  Encrypts the database blob.
- **KEK (Key Encryption Key):** derived from the master passphrase with
  **Argon2id** (memory ≥ 64 MB, iterations ≥ 3, parallelism 1, random 16-byte salt).
  The KEK wraps (encrypts) the DEK.
- **Recovery Key:** random 256-bit key shown **once** at setup as a printable code
  (and downloadable PDF/text). It also wraps the DEK. Used if passphrase is forgotten.
- Stored on server (in the vault header, all non-secret): Argon2 salt + params,
  `wrappedDEK_byPassphrase`, `wrappedDEK_byRecoveryKey`, IVs, schema version.
- **Never store** the passphrase, KEK, DEK or recovery key on the server or in Google Drive.
  The owner keeps the recovery key offline (printed / password manager), **not** in the same
  Google Drive as the backups.

### 3.2 Vault file format

```
ARTHA1 | header JSON length | header JSON | IV (12 bytes) | AES-GCM ciphertext(+tag)
header = { version, kdf:{algo,salt,mem,iter,par}, wrapped_dek_pass, wrapped_dek_recovery,
           created_on, updated_on, schema_version, blob_version }
```

### 3.3 Sensitive fields — second layer ("Secrets")

Bank passwords, MPIN, transaction password, security answers, PAN, Aadhaar are stored in the
already-encrypted DB **and additionally** field-encrypted with a separate key derived from the
DEK (HKDF, info="artha-secrets"). UI rules:

- Masked by default (`••••1234`); "Reveal" button shows for 30 seconds.
- Optional: re-enter passphrase before reveal (setting).
- "Copy" button copies to clipboard and clears clipboard after 30 seconds.
- Secrets never written to console, logs, error reports or URLs.

### 3.4 Session & app hardening

- Auto-lock after 5 minutes of inactivity (configurable) and on tab hide (optional):
  wipe in-memory DB and keys.
- Strict Content Security Policy, no third-party scripts/CDNs at runtime, no analytics.
- Login rate-limiting and lockout on the backend; TOTP mandatory.
- HTTPS only, HSTS.

### 3.5 Save & sync (multi-device safety)

- Every PUT /vault sends `If-Match: <blob_version>`. Server rejects with **409** if another
  device saved in between. UI then reloads the latest vault and asks the user to redo the edit
  (single-user → conflicts are rare; never silently overwrite).
- Auto-save: debounce 3 s after a change + explicit "Save" indicator (Saved / Saving / Unsaved).
- Server keeps the last 30 blob versions locally; "Restore previous version" in settings.

### 3.6 Backups

- Nightly job (and on-demand button) uploads the latest encrypted blob to a Google Drive
  folder as `artha_YYYY-MM-DD_HHMM.vault`; retain last 30 daily + 12 monthly.
- "Export vault" button in UI downloads the encrypted file locally.
- "Import/restore vault" accepts a `.vault` file (needs passphrase or recovery key).
- Document a manual restore procedure in `docs/RESTORE.md`.

---

## 4. Database conventions (apply to all phases)

- SQLite, `PRAGMA foreign_keys = ON`.
- Table names: PascalCase plural (as owner specified). Columns: PascalCase.
- Primary keys: `INTEGER PRIMARY KEY AUTOINCREMENT` named `<Entity>Id`.
- **Money: store as INTEGER in paise** (₹1 = 100). Never use REAL for money.
  Quantities (MF units, grams of gold, shares) as INTEGER scaled values or TEXT decimals
  handled with a decimal library (`decimal.js`) — units: 4 decimals, grams: 3 decimals.
- Dates: ISO-8601 TEXT. `CreatedOn`/`UpdatedOn` in UTC; business dates (`TxnDate`) as local date.
- Every master table has: `CreatedOn`, `UpdatedOn`, `IsActive` (soft delete = `IsActive = 0`).
- `Notes TEXT` on most tables for free text.
- Lookup values (account types, insurance types, etc.) stored in a generic
  `LookupValues(Category, Code, Label, SortOrder, IsActive)` table so new types can be added
  from the UI without code changes.
- **Schema migrations:** `SchemaVersion` table + ordered migration files in
  `frontend/src/db/migrations/NNN_description.sql`. On unlock, run pending migrations, then
  save. Every phase = new migration(s); never edit an old migration.

---

## 5. Phase 0 — Foundation (build first)

**Deliverables**

1. Monorepo scaffold (see §13), Docker Compose, lint/format (ESLint, Prettier, Ruff).
2. Backend: auth (setup once → login → TOTP), `GET /vault`, `PUT /vault`, `GET /vault/versions`,
   `POST /vault/restore/{version}`, `POST /backup/run`, health endpoint.
3. Frontend: first-run wizard (create passphrase → show recovery key → confirm it was saved),
   unlock screen, recovery-key unlock, change passphrase (re-wrap DEK only), auto-lock.
4. Crypto module with unit tests (encrypt/decrypt round-trip, wrong passphrase fails,
   tamper detection via GCM tag).
5. DB layer: open/create sql.js DB, migration runner, repository helpers, save pipeline.
6. App shell: sidebar navigation (Dashboard, Family, Banks, Accounts, Transactions, Settings),
   light/dark theme, mobile-responsive layout, ₹ formatting (Indian digit grouping: 12,34,567.00).
7. Settings: auto-lock timeout, backup status, export/import vault, restore version.

**Acceptance:** create vault on laptop → add a record → open on phone → unlock → record visible;
server file inspected manually contains no plaintext.

---

## 6. Phase 1 — Family, Banks, Accounts, Transactions

The owner's draft tables are kept, with these improvements:

1. `AccountHolders` → generalised to **`Persons`** (family members: self, spouse, kids) because
   all later phases (MF, insurance, property, loans) need owners/nominees. Added `Relationship`,
   `DateOfBirth` (needed for Sukanya Samriddhi / minors).
2. **`Accounts` was missing `BankId`** — added.
3. **Joint holders & nominees:** many-to-many `AccountPersons` (Role: Primary / Joint / Nominee /
   Guardian) instead of a single `AccountHolderId`.
4. Credentials moved to **`AccountCredentials`** (Password, MPIN, TxnPassword, net-banking
   user ID…) and **`SecurityQuestions`** (unlimited rows instead of 5 fixed column pairs).
5. `AccountHistory` → **`Transactions`**: removed redundant `AccountHolderId`, added category,
   mode, reference, running balance. `ClosingBalance` is **calculated**, not typed in.

### 6.1 Schema

```sql
CREATE TABLE Persons (
  PersonId INTEGER PRIMARY KEY AUTOINCREMENT,
  FirstName TEXT NOT NULL, LastName TEXT,
  Relationship TEXT NOT NULL,            -- Self, Spouse, Son, Daughter, Father, Mother, Other
  DateOfBirth TEXT, Gender TEXT,
  Email TEXT, Phone TEXT, Address TEXT,
  PAN_Enc TEXT, Aadhaar_Enc TEXT,        -- field-encrypted (see 3.3)
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL, IsActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE Banks (
  BankId INTEGER PRIMARY KEY AUTOINCREMENT,
  BankName TEXT NOT NULL, BranchName TEXT, BranchAddress TEXT,
  IFSCCode TEXT, MICRCode TEXT, SwiftCode TEXT,
  BranchPhone TEXT, RelationshipManager TEXT, RMPhone TEXT, CustomerCareNo TEXT, Website TEXT,
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL, IsActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE Accounts (
  AccountId INTEGER PRIMARY KEY AUTOINCREMENT,
  BankId INTEGER NOT NULL REFERENCES Banks(BankId),
  AccountType TEXT NOT NULL,            -- Lookup: Savings, Current, PPF, SukanyaSamriddhi, FD, RD, NRE, NRO, Salary
  AccountNumber_Enc TEXT NOT NULL, AccountNumberLast4 TEXT,   -- last4 for display/search
  CustomerId TEXT,
  OpenedOn TEXT, MaturityDate TEXT,     -- PPF/SSY/FD/RD
  InterestRate TEXT,                    -- decimal as text, e.g. "7.10"
  OpeningBalance INTEGER NOT NULL DEFAULT 0,   -- paise
  OpeningBalanceDate TEXT,
  DebitCardLast4 TEXT,
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL, IsActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE AccountPersons (
  AccountPersonId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId),
  PersonId INTEGER NOT NULL REFERENCES Persons(PersonId),
  Role TEXT NOT NULL,                   -- Primary, Joint, Nominee, Guardian
  SharePercent TEXT,                    -- nominee share
  UNIQUE(AccountId, PersonId, Role)
);

CREATE TABLE AccountCredentials (
  CredentialId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId),
  Channel TEXT NOT NULL,                -- NetBanking, MobileApp, UPI, PhoneBanking
  LoginId_Enc TEXT, Password_Enc TEXT, MPIN_Enc TEXT, TxnPassword_Enc TEXT,
  LastChangedOn TEXT,
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL, IsActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE SecurityQuestions (
  SecurityQuestionId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId),
  Question TEXT NOT NULL, Answer_Enc TEXT NOT NULL,
  SortOrder INTEGER NOT NULL DEFAULT 0,
  CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL
);

CREATE TABLE Categories (
  CategoryId INTEGER PRIMARY KEY AUTOINCREMENT,
  Name TEXT NOT NULL, ParentCategoryId INTEGER REFERENCES Categories(CategoryId),
  Kind TEXT NOT NULL,                   -- Income, Expense, Transfer, Investment
  IsActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE Transactions (
  TransactionId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId),
  TxnDate TEXT NOT NULL, TxnTime TEXT,
  Description TEXT NOT NULL,
  DebitAmount INTEGER NOT NULL DEFAULT 0,      -- paise
  CreditAmount INTEGER NOT NULL DEFAULT 0,     -- paise
  Mode TEXT,                            -- UPI, NEFT, RTGS, IMPS, Cheque, Cash, Card, ECS/NACH, Interest
  ReferenceNo TEXT, CounterParty TEXT,
  CategoryId INTEGER REFERENCES Categories(CategoryId),
  TransferGroupId TEXT,                 -- links both legs of a self-transfer between own accounts
  LinkedEntity TEXT, LinkedEntityId INTEGER,   -- later phases: 'SIP', 'Premium', 'EMI', 'Loan'...
  ImportBatchId INTEGER,                -- set when imported from a statement
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL,
  CHECK (DebitAmount >= 0 AND CreditAmount >= 0 AND NOT (DebitAmount > 0 AND CreditAmount > 0))
);
CREATE INDEX IX_Transactions_Account_Date ON Transactions(AccountId, TxnDate);

-- Balance is calculated:  OpeningBalance + SUM(Credit) - SUM(Debit)  (view)
CREATE VIEW vAccountBalances AS
SELECT a.AccountId,
       a.OpeningBalance + COALESCE(SUM(t.CreditAmount),0) - COALESCE(SUM(t.DebitAmount),0) AS CurrentBalance
FROM Accounts a LEFT JOIN Transactions t ON t.AccountId = a.AccountId
GROUP BY a.AccountId;

CREATE TABLE BalanceSnapshots (        -- optional manual "balance as per bank" to reconcile
  BalanceSnapshotId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId),
  AsOfDate TEXT NOT NULL, Balance INTEGER NOT NULL, Notes TEXT
);
```

### 6.2 Screens (Phase 1)

- **Family:** list/add/edit persons; age shown; PAN/Aadhaar masked.
- **Banks:** list/add/edit; IFSC format validation (`^[A-Z]{4}0[A-Z0-9]{6}$`).
- **Accounts:** list grouped by person or bank; card shows bank, type, last-4, balance;
  detail page with tabs: Overview, Holders & Nominees, Credentials (masked, reveal/copy),
  Security Questions, Transactions, Notes.
- **Transactions:** filter by account/date/category/amount; add/edit; self-transfer
  (creates two linked legs); running balance column.
- **Statement import:** CSV/XLSX upload, column mapping UI (save mapping per bank),
  preview, duplicate detection (date + amount + reference), import batch undo.
  (PDF statement parsing is a later enhancement.)
- **Dashboard v1:** total bank balance by person and by bank; PPF/SSY maturity dates;
  last-30-days income vs expense.

**Acceptance:** add 3 family members, 2 banks, 4 accounts (one joint, one PPF, one SSY for a
child), import a CSV statement, balances match the bank statement.

---

## 7. Phase 2 — Mutual Funds & SIPs (self, spouse, kids)

```sql
AMCs(AMCId, Name, Website, Notes, …audit)
Schemes(SchemeId, AMCId, SchemeName, AMFICode, ISIN, Category, Plan[Direct/Regular], Option[Growth/IDCW], IsActive)
Folios(FolioId, AMCId, FolioNumber, PrimaryPersonId, BankAccountId, Notes, …audit)
FolioPersons(FolioId, PersonId, Role[Primary/Joint/Nominee/Guardian])
SIPs(SIPId, FolioId, SchemeId, Amount, Frequency, SIPDay, StartDate, EndDate, StepUpPercent, MandateRef, Status[Active/Paused/Stopped])
MFTransactions(MFTransactionId, FolioId, SchemeId, TxnDate, TxnType[Purchase/SIP/Redemption/SwitchIn/SwitchOut/IDCW/STP/SWP],
               Amount, Units, NAV, StampDuty, SIPId NULL, BankTransactionId NULL)
NAVHistory(SchemeId, NAVDate, NAV)
```

- Holdings & average cost computed from transactions (FIFO for capital gains).
- **NAV refresh:** browser fetches AMFI daily NAV file (`https://www.amfiindia.com/spages/NAVAll.txt`)
  via a backend proxy endpoint that only relays public data (no user data sent).
- **CAS import:** parse CAMS/KFintech Consolidated Account Statement (PDF via `casparser`
  logic or Excel) — import into folios/transactions.
- Reports: current value, invested, gain, XIRR per scheme/person/family; upcoming SIP dates;
  short/long-term capital gains for the financial year (Apr–Mar).

## 8. Phase 3 — Insurance

```sql
Insurers(InsurerId, Name, ClaimPhone, Website, …)
Policies(PolicyId, InsurerId, PolicyType[Health/Term/Life/ULIP/Endowment/Home/Motor/Travel/PersonalAccident],
         PolicyNumber, PlanName, ProposerPersonId, SumAssured, Premium, PremiumFrequency,
         StartDate, EndDate/MaturityDate, NextDueDate, AgentName, AgentPhone, TPAName, Status, Notes)
PolicyPersons(PolicyId, PersonId, Role[Insured/Nominee], SharePercent)
PolicyPremiums(PremiumId, PolicyId, DueDate, PaidDate, Amount, BankTransactionId NULL)
PolicyClaims(ClaimId, PolicyId, ClaimDate, Amount, Settled, Status, Notes)
PolicyAssets(PolicyId, AssetType['Property'/'Vehicle'], AssetId)   -- home/motor link
```

- Renewal/premium reminders (30/15/7 days), total cover per person (health & term), 80C/80D summary.

## 9. Phase 4 — Property (Land / Plot / Residential / Commercial)

```sql
Properties(PropertyId, Name, PropertyType[Land/Plot/Residential/Commercial/Agricultural], Address, City, State,
           AreaValue, AreaUnit[sqft/sqyd/marla/kanal/acre], KhasraNo/RegistryNo, PurchaseDate, Status[Owned/UnderConstruction/Sold])
PropertyOwners(PropertyId, PersonId, SharePercent)
PropertyCosts(CostId, PropertyId, CostType[BasePrice/StampDuty/Registration/Brokerage/Legal/Construction/Other], Amount, Date, BankTransactionId NULL)
PropertyPaymentSchedule(PropertyId, Milestone, DueDate, Amount, PaidDate)       -- builder installments
PropertyValuations(PropertyId, ValuationDate, Value, Source)
PropertyIncome(PropertyId, Date, Type[Rent/Other], Amount, TenantName)
```

- Total cost of acquisition, current value, gain; rental yield; links to home loan (Phase 7)
  and home insurance (Phase 3).

## 10. Phase 5 — Commodities (Gold/Silver) & Kitty

```sql
CommodityHoldings(HoldingId, PersonId, Metal[Gold/Silver], Form[Jewellery/Coin/Bar/DigitalGold/SGB/ETF],
                  Description, WeightGrams, Purity[24K/22K/18K/999/925], PurchaseDate, PurchasePrice,
                  MakingCharges, GST, Vendor, InvoiceNo, StorageLocation, Status[Held/Sold/Pledged])
CommoditySales(HoldingId, SaleDate, WeightGrams, SaleAmount)
MetalRates(Metal, Purity, RateDate, RatePerGram)          -- manual entry or fetched
KittyGroups(KittyId, Name, Organizer, MemberCount, MonthlyContribution, StartDate, Months, PayoutMonth, Status)
KittyContributions(KittyId, Month, Amount, PaidDate, BankTransactionId NULL)
KittyPayouts(KittyId, PayoutDate, Amount, BidDiscount)
```

- Current value = weight × purity factor × today's rate; SGB interest & maturity; kitty
  net position and effective return.

## 11. Phase 6 — Shares (Equity)

```sql
DematAccounts(DematId, PersonId, Broker, DPId, ClientId, BankAccountId, LoginId_Enc, Password_Enc, …)
Stocks(StockId, Symbol, Exchange[NSE/BSE], ISIN, CompanyName, Sector)
StockTrades(TradeId, DematId, StockId, TradeDate, Side[Buy/Sell], Quantity, Price, Brokerage, STT, OtherCharges)
Dividends(DividendId, DematId, StockId, ExDate, PayDate, Amount, TDS)
CorporateActions(StockId, ActionDate, Type[Split/Bonus/Merger/Demerger], RatioFrom, RatioTo)
StockPrices(StockId, PriceDate, ClosePrice)
```

- Import tradebook CSV (Zerodha/Groww/Upstox mappings), holdings with FIFO cost,
  realised/unrealised P&L, STCG/LTCG per FY, dividend summary.

## 12. Phase 7 — Loans (Lent & Borrowed)

```sql
Loans(LoanId, Direction[Given/Taken], LoanType[Home/Car/Personal/Gold/Education/Friend/Other],
      CounterpartyName, CounterpartyPhone, LenderBankId NULL, PersonId, Principal, InterestRate,
      InterestType[None/Simple/Compound/ReducingBalance], StartDate, TenureMonths, EMIAmount,
      EMIDay, LinkedPropertyId NULL, Collateral, Status[Active/Closed/Overdue/WrittenOff], Notes)
LoanSchedule(LoanId, InstallmentNo, DueDate, Principal, Interest, Total)     -- generated amortization
LoanRepayments(RepaymentId, LoanId, PaidDate, Amount, PrincipalPart, InterestPart, Mode, BankTransactionId NULL)
LoanRateChanges(LoanId, EffectiveDate, NewRate)                               -- floating rate
```

- Outstanding balance, overdue alerts for money lent to friends, prepayment calculator,
  24(b)/80C home-loan interest/principal summary.

---

## 13. Cross-cutting features (add progressively)

- **Net-worth dashboard:** assets (bank, MF, shares, gold, property, policies' surrender value,
  money lent) − liabilities (loans taken) by person and family; monthly snapshot history chart.
- **Reminders & calendar:** SIP dates, premiums, FD/PPF/SSY maturity, EMIs, kitty, property
  installments, passphrase-change reminder. Shown in-app (no email that would leak data).
- **Documents:** attach PDFs/images (policy docs, registry, invoices). Stored as separate
  AES-GCM encrypted files via `/files` endpoint (not inside the SQLite blob, to keep it small),
  referenced by `Documents(DocumentId, EntityType, EntityId, FileName, ServerFileId, Size)`.
- **Search:** global search across names, banks, policies, folios (on decrypted in-memory DB).
- **Audit log:** `AuditLog(Entity, EntityId, Action, ChangedOn, Summary)` — no secret values.
- **Reports/export:** CSV/XLSX export per module; FY tax summary (Indian FY Apr–Mar).

---

## 14. Repository structure

```
artha/
├─ CLAUDE.md                  # short rules for Claude Code (copy §16)
├─ docs/  PLAN.md (this file) · SECURITY.md · RESTORE.md · DEPLOY.md
├─ docker-compose.yml
├─ nginx/ artha.conf
├─ backend/
│  ├─ app/ main.py · auth.py · vault.py · backup_gdrive.py · settings.py
│  ├─ tests/
│  └─ pyproject.toml · Dockerfile
└─ frontend/
   ├─ src/
   │  ├─ crypto/        # kdf.ts, aes.ts, vaultFormat.ts, secrets.ts (+ tests)
   │  ├─ db/            # database.ts, migrations/*.sql, migrate.ts, save.ts
   │  ├─ repositories/  # persons.ts, banks.ts, accounts.ts, transactions.ts …
   │  ├─ features/      # family/, banks/, accounts/, transactions/, dashboard/, settings/ …
   │  ├─ components/    # shared UI: MoneyInput, SecretField, DataTable, ConfirmDialog
   │  ├─ lib/           # money.ts (paise ↔ ₹, Indian formatting), dates.ts, validators.ts
   │  └─ app/           # routes, layout, auth/lock state
   ├─ e2e/              # Playwright
   └─ package.json · vite.config.ts
```

## 15. Deployment (AWS EC2, alongside existing ERP)

- Run Artha in its own Docker Compose project (separate network, volume, non-root user).
- Nginx server block for `artha.<domain>` → frontend static files + `/api` → FastAPI container.
- Certbot TLS, HSTS, CSP headers, `client_max_body_size` sized for the vault + documents.
- Volume `artha_data` holds blobs + versions; included in EBS snapshot schedule.
- Secrets (login hash, TOTP secret, Google credentials) via `.env` not committed to git.
- Take an EBS snapshot of the ERP instance before first deployment.

## 16. Rules for Claude Code (put in CLAUDE.md)

1. Never send plaintext financial data or keys to the backend; backend handles opaque blobs only.
2. Money is INTEGER paise everywhere; format only at the UI edge (`en-IN`, ₹).
3. All schema changes via new numbered migration files; never edit applied migrations.
4. Secret fields use `SecretField` component and `secrets.ts` helpers; never log them.
5. Write tests for crypto, migrations, money math and balance calculations before UI polish.
6. Build phase by phase; finish acceptance criteria for a phase before starting the next.
7. Keep dependencies minimal; no runtime CDNs, no analytics, no telemetry.
8. Mobile-first responsive UI; every list screen usable on a phone.
9. Ask the owner before changing the security model, file format or conventions in this plan.

## 17. Milestone checklist

- [ ] Phase 0 — Foundation, encryption, auth, save/sync, backup, deploy to EC2
- [ ] Phase 1 — Family, Banks, Accounts, Credentials, Transactions, CSV import, Dashboard v1
- [ ] Phase 2 — Mutual Funds & SIPs (+ CAS import, NAV refresh, XIRR)
- [ ] Phase 3 — Insurance (+ premium reminders)
- [ ] Phase 4 — Property
- [ ] Phase 5 — Gold/Silver & Kitty
- [ ] Phase 6 — Shares
- [ ] Phase 7 — Loans (given/taken)
- [ ] Net-worth dashboard, reminders, documents, reports (progressive)
