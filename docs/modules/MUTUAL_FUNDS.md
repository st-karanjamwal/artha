# Artha — Phase 2: Mutual Funds & SIP Module

> **For Claude Code:** This is the specification for the Mutual Fund (MF) module of Artha.
> Read `docs/PLAN.md` first. The security model, money conventions and migration rules from
> the master plan still apply. Build this module only after Phase 0 and Phase 1 are complete.
> Put this file in the repo as `docs/modules/MUTUAL_FUNDS.md`.

---

## 1. Goal

Track mutual fund investments for the whole family (self, spouse, kids):

- Fund master data (fund → plans/options with ISIN and AMFI scheme code)
- Where each investment is held (platform / folio)
- SIPs (current portfolio: 3 SIPs × ₹10,000 monthly = ₹30,000/month, ₹3,60,000/year)
- Every purchase, SIP instalment, redemption, switch and IDCW (dividend) in **one** transaction table
- Daily NAV history → current value, gains, XIRR, historical portfolio value, capital gains per FY

### Design principles (owner's decisions — keep them)

1. **ISIN and scheme code live on `MutualFundPlan`**, not `MutualFund`, because Direct-Growth,
   Regular-Growth, Direct-IDCW etc. each have their own identifiers and NAV.
2. **One transaction table (`MFTransaction`)** for all transaction types. No separate
   purchase/redemption/SIP tables.
3. **No `MFHolding` table.** Holdings are always derived from transactions, so they can never
   go out of sync. (A cached/materialised view can be added later only if performance requires it.)
4. **`InvestmentAccount` is generic** so it can be reused later for shares, bonds, etc.

---

## 2. Adaptations from the owner's SQL Server design to Artha (SQLite in browser)

The owner's draft was written in SQL Server syntax. Artha runs SQLite (sql.js) in the browser,
so apply these mappings. The table structure and names stay as the owner designed them.

| Owner's draft (SQL Server) | Artha implementation (SQLite) |
|---|---|
| `INT PRIMARY KEY IDENTITY` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `VARCHAR(n)` | `TEXT` (length validated in Zod schema in the UI) |
| `BIT` | `INTEGER` 0/1 with `CHECK (x IN (0,1))` |
| `DATE` / `DATETIME`, `GETDATE()` | ISO-8601 `TEXT`; audit default `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `CreatedDate` / `ModifiedDate` | `CreatedOn` / `UpdatedOn` (same names as Phase 1 tables) |
| `DECIMAL(18,2)` money | `INTEGER` **paise** (₹10,000 → `1000000`) |
| `DECIMAL(18,6)` NAV and units | `INTEGER` **micro-units** (value × 1,000,000). NAV 125.50 → `125500000`; units 79.681275 → `79681275` |
| `DECIMAL(8,4)` expense ratio | `INTEGER` basis points × 100 (0.6500% → `6500`) or TEXT decimal |
| `Status VARCHAR DEFAULT 'ACTIVE'` | `TEXT NOT NULL DEFAULT 'ACTIVE'` + `CHECK` on allowed values |

**Why integers:** SQLite has no true DECIMAL type and REAL causes rounding errors in money.
All conversions happen in `frontend/src/lib/money.ts` and a new `frontend/src/lib/units.ts`
(use `decimal.js` for any multiplication/division, e.g. Units = Amount ÷ NAV).

---

## 3. Improvements added to the owner's design

| # | Change | Reason |
|---|---|---|
| 1 | `InvestmentAccount.PersonId` → `Persons` | Owner wants MF for self, wife and kids. `HolderName` text alone cannot drive per-person reports. |
| 2 | New `MFFolio` table; `SIP` and `MFTransaction` get `FolioId` | A folio is per AMC per holder. Free-text `FolioNumber` on every transaction leads to typos and cannot hold joint holders/nominees. Kept `FolioNumber` on the transaction only as "as printed on statement". |
| 3 | New `MFFolioPerson` table (Primary / Joint / Nominee / Guardian) | Joint holding, nominee and guardian for minors (kids). |
| 4 | Transaction types `IDCW_PAYOUT` and `IDCW_REINVEST` instead of `DIVIDEND` | Reinvested IDCW adds units; payout does not. They must be treated differently in the holdings query. |
| 5 | `TDS` and `ExitLoad` columns on `MFTransaction` | IDCW payouts have TDS; redemptions may have exit load. Needed for correct cash flows and XIRR. |
| 6 | `BankTransactionId` on `MFTransaction` → Phase 1 `Transactions` | Links the SIP debit / redemption credit in the bank account. |
| 7 | `SIP.StepUpPercent`, `SIP.MandateReference`, `SIP.PausedUntil` | Common real-world SIP features. |
| 8 | `NAV` nullable for `IDCW_PAYOUT` | A payout has no unit allotment; `Units = 0`. |
| 9 | `CHECK` constraints on types/statuses and `Units >= 0` | Units are always stored positive; the transaction type decides the sign. |

---

## 4. Schema (migration `NNN_mutual_funds.sql`)

```sql
-- 4.1 Fund master
CREATE TABLE MutualFund (
  MutualFundId   INTEGER PRIMARY KEY AUTOINCREMENT,
  AMCName        TEXT NOT NULL,
  FundName       TEXT NOT NULL,
  Category       TEXT,               -- Equity / Debt / Hybrid / Solution Oriented / Other (Index, FoF)
  SubCategory    TEXT,               -- Flexi Cap / Large Cap / Aggressive Hybrid ...
  Benchmark      TEXT,
  FundType       TEXT,               -- Open Ended / Close Ended / Interval
  RiskLevel      TEXT,               -- Low ... Very High (SEBI riskometer)
  InceptionDate  TEXT,
  Status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','MERGED','CLOSED')),
  Notes          TEXT,
  CreatedOn      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn      TEXT,
  UNIQUE (AMCName, FundName)
);

-- 4.2 Plan / option (Direct/Regular × Growth/IDCW)
CREATE TABLE MutualFundPlan (
  MutualFundPlanId  INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundId      INTEGER NOT NULL REFERENCES MutualFund(MutualFundId),
  PlanType          TEXT NOT NULL CHECK (PlanType IN ('DIRECT','REGULAR')),
  OptionType        TEXT NOT NULL CHECK (OptionType IN ('GROWTH','IDCW_PAYOUT','IDCW_REINVEST')),
  SchemeCode        TEXT,            -- AMFI scheme code (used for NAV download)
  ISIN              TEXT,            -- ISIN (growth / div-payout)
  ISINReinvest      TEXT,            -- separate ISIN for IDCW reinvestment, if any
  ExpenseRatioBps   INTEGER,         -- 0.6500% → 6500 (hundredths of a basis point)
  ExitLoad          TEXT,            -- e.g. "1% if redeemed within 365 days"
  ExitLoadDays      INTEGER,         -- 365 (for warnings before redemption)
  ExitLoadPercentBps INTEGER,        -- 1% → 10000
  PurchaseAllowed   INTEGER NOT NULL DEFAULT 1 CHECK (PurchaseAllowed IN (0,1)),
  RedemptionAllowed INTEGER NOT NULL DEFAULT 1 CHECK (RedemptionAllowed IN (0,1)),
  Status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','MERGED','CLOSED')),
  CreatedOn         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn         TEXT,
  UNIQUE (MutualFundId, PlanType, OptionType)
);
CREATE UNIQUE INDEX UX_MutualFundPlan_SchemeCode ON MutualFundPlan(SchemeCode) WHERE SchemeCode IS NOT NULL;
CREATE UNIQUE INDEX UX_MutualFundPlan_ISIN       ON MutualFundPlan(ISIN)       WHERE ISIN IS NOT NULL;

-- 4.3 Where the investment is held (generic: reusable for shares/bonds later)
CREATE TABLE InvestmentAccount (
  InvestmentAccountId INTEGER PRIMARY KEY AUTOINCREMENT,
  PersonId            INTEGER NOT NULL REFERENCES Persons(PersonId),
  AccountName         TEXT NOT NULL,     -- "Karan – Groww", "Kids – MF Central"
  PlatformName        TEXT,              -- Groww / Zerodha Coin / MF Central / Kuvera / Bank / AMC Direct
  AccountNumber       TEXT,              -- client id on the platform
  HolderName          TEXT,              -- as on platform (display only; PersonId is the real link)
  LinkedBankAccountId INTEGER REFERENCES Accounts(AccountId),   -- default bank for SIP debit
  LoginId_Enc         TEXT,              -- field-encrypted (see master plan §3.3)
  Password_Enc        TEXT,
  AssetClass          TEXT NOT NULL DEFAULT 'MF' CHECK (AssetClass IN ('MF','EQUITY','BOND','MIXED')),
  Status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','CLOSED')),
  Notes               TEXT,
  CreatedOn           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn           TEXT
);

-- 4.4 Folio (per AMC, per holder)
CREATE TABLE MFFolio (
  FolioId             INTEGER PRIMARY KEY AUTOINCREMENT,
  InvestmentAccountId INTEGER NOT NULL REFERENCES InvestmentAccount(InvestmentAccountId),
  AMCName             TEXT NOT NULL,
  FolioNumber         TEXT NOT NULL,
  ModeOfHolding       TEXT NOT NULL DEFAULT 'SINGLE' CHECK (ModeOfHolding IN ('SINGLE','JOINT','ANYONE_OR_SURVIVOR')),
  BankAccountId       INTEGER REFERENCES Accounts(AccountId),    -- payout/redemption bank on record
  Status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','CLOSED')),
  Notes               TEXT,
  CreatedOn           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn           TEXT,
  UNIQUE (AMCName, FolioNumber)
);

CREATE TABLE MFFolioPerson (
  FolioPersonId  INTEGER PRIMARY KEY AUTOINCREMENT,
  FolioId        INTEGER NOT NULL REFERENCES MFFolio(FolioId),
  PersonId       INTEGER NOT NULL REFERENCES Persons(PersonId),
  Role           TEXT NOT NULL CHECK (Role IN ('PRIMARY','JOINT','NOMINEE','GUARDIAN')),
  SharePercent   TEXT,               -- nominee share, e.g. "50.00"
  UNIQUE (FolioId, PersonId, Role)
);

-- 4.5 SIP
CREATE TABLE SIP (
  SIPId               INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundPlanId    INTEGER NOT NULL REFERENCES MutualFundPlan(MutualFundPlanId),
  InvestmentAccountId INTEGER NOT NULL REFERENCES InvestmentAccount(InvestmentAccountId),
  FolioId             INTEGER REFERENCES MFFolio(FolioId),          -- known after first allotment
  SIPAmount           INTEGER NOT NULL CHECK (SIPAmount > 0),       -- paise
  Frequency           TEXT NOT NULL CHECK (Frequency IN ('DAILY','WEEKLY','FORTNIGHTLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY')),
  SIPDate             INTEGER CHECK (SIPDate BETWEEN 1 AND 31),     -- day of month (monthly+)
  StartDate           TEXT NOT NULL,
  EndDate             TEXT,                                          -- NULL = perpetual
  StepUpPercentBps    INTEGER,                                       -- 10% yearly step-up → 100000
  StepUpFrequency     TEXT CHECK (StepUpFrequency IN ('YEARLY','HALF_YEARLY')),
  AutoDebit           INTEGER NOT NULL DEFAULT 1 CHECK (AutoDebit IN (0,1)),
  MandateReference    TEXT,                                          -- NACH/UPI AutoPay mandate id
  DebitBankAccountId  INTEGER REFERENCES Accounts(AccountId),
  Status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','PAUSED','STOPPED','COMPLETED')),
  PausedUntil         TEXT,
  Notes               TEXT,
  CreatedOn           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn           TEXT
);

-- 4.6 The heart of the module: one transaction table
CREATE TABLE MFTransaction (
  TransactionId        INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundPlanId     INTEGER NOT NULL REFERENCES MutualFundPlan(MutualFundPlanId),
  InvestmentAccountId  INTEGER NOT NULL REFERENCES InvestmentAccount(InvestmentAccountId),
  FolioId              INTEGER REFERENCES MFFolio(FolioId),
  SIPId                INTEGER REFERENCES SIP(SIPId),
  TransactionDate      TEXT NOT NULL,          -- allotment / NAV date
  TransactionType      TEXT NOT NULL CHECK (TransactionType IN (
                          'PURCHASE','SIP','REDEMPTION','SWITCH_IN','SWITCH_OUT',
                          'IDCW_PAYOUT','IDCW_REINVEST','BONUS',
                          'TRANSFER_IN','TRANSFER_OUT')),   -- transmission / demat moves
  NAV                  INTEGER,                -- micro-units; NULL allowed only for IDCW_PAYOUT
  Units                INTEGER NOT NULL DEFAULT 0 CHECK (Units >= 0),   -- micro-units, always positive
  Amount               INTEGER NOT NULL DEFAULT 0 CHECK (Amount >= 0),  -- paise: Units × NAV
  STT                  INTEGER NOT NULL DEFAULT 0,   -- paise (equity-fund redemptions)
  StampDuty            INTEGER NOT NULL DEFAULT 0,   -- paise (purchases/SIP/switch-in)
  ExitLoad             INTEGER NOT NULL DEFAULT 0,   -- paise (redemptions/switch-out)
  TDS                  INTEGER NOT NULL DEFAULT 0,   -- paise (IDCW payout, NRI redemption)
  OtherCharges         INTEGER NOT NULL DEFAULT 0,   -- paise
  TotalAmount          INTEGER NOT NULL,             -- paise: cash that left/entered the bank (see §5)
  SwitchGroupId        TEXT,                         -- links SWITCH_OUT ↔ SWITCH_IN legs (UUID)
  FolioNumber          TEXT,                         -- as printed on statement (reference only)
  TransactionReference TEXT,                         -- order id / CAS txn ref
  BankTransactionId    INTEGER REFERENCES Transactions(TransactionId),  -- Phase 1 bank entry
  Source               TEXT NOT NULL DEFAULT 'MANUAL' CHECK (Source IN ('MANUAL','CAS_IMPORT','CSV_IMPORT','SIP_AUTO')),
  ImportBatchId        INTEGER,
  Remarks              TEXT,
  CreatedOn            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn            TEXT,
  CHECK (NAV IS NOT NULL OR TransactionType = 'IDCW_PAYOUT')
);

-- 4.7 NAV history
CREATE TABLE MFNAVHistory (
  NAVId             INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundPlanId  INTEGER NOT NULL REFERENCES MutualFundPlan(MutualFundPlanId),
  NAVDate           TEXT NOT NULL,
  NAV               INTEGER NOT NULL,     -- micro-units
  Source            TEXT NOT NULL DEFAULT 'AMFI' CHECK (Source IN ('AMFI','MANUAL','TRANSACTION','MFAPI')),
  CreatedOn         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (MutualFundPlanId, NAVDate)
);

-- 4.8 Indexes (owner's list + folio/SIP)
CREATE INDEX IX_MFTransaction_Fund    ON MFTransaction(MutualFundPlanId, TransactionDate);
CREATE INDEX IX_MFTransaction_Account ON MFTransaction(InvestmentAccountId, TransactionDate);
CREATE INDEX IX_MFTransaction_Folio   ON MFTransaction(FolioId, TransactionDate);
CREATE INDEX IX_MFTransaction_SIP     ON MFTransaction(SIPId);
CREATE INDEX IX_MFNAVHistory_FundDate ON MFNAVHistory(MutualFundPlanId, NAVDate);
CREATE INDEX IX_SIP_Status            ON SIP(Status);
```

> Note: the `UNIQUE (MutualFundPlanId, NAVDate)` constraint already creates an index, so
> `IX_MFNAVHistory_FundDate` is optional; keep it only if query plans show it is used.

---

## 5. Transaction rules (implement in `repositories/mfTransactions.ts`)

| Type | Units effect | `Amount` | `TotalAmount` (bank cash flow) | Notes |
|---|---|---|---|---|
| PURCHASE / SIP | **+ Units** | Units × NAV | Amount + StampDuty + OtherCharges (cash **out**) | Stamp duty 0.005% of invested amount |
| SWITCH_IN | **+ Units** | Units × NAV | Amount + StampDuty (no bank flow) | Paired with SWITCH_OUT via `SwitchGroupId` |
| IDCW_REINVEST | **+ Units** | Units × NAV | 0 (no bank flow) | Taxable income for the year |
| BONUS | **+ Units** | 0 | 0 | Cost = 0; date matters for tax |
| TRANSFER_IN | **+ Units** | original cost | 0 | Carry original purchase date/cost |
| REDEMPTION | **− Units** | Units × NAV | Amount − STT − ExitLoad − TDS − OtherCharges (cash **in**) | Warn if inside exit-load period |
| SWITCH_OUT | **− Units** | Units × NAV | 0 (no bank flow) | Is a redemption for tax purposes |
| TRANSFER_OUT | **− Units** | — | 0 | |
| IDCW_PAYOUT | 0 | gross IDCW | Amount − TDS (cash **in**) | NAV may be NULL |

**Validation**
- Redemption/switch-out units cannot exceed units held in that folio + plan on that date.
- When the user enters Amount and NAV, compute Units = (Amount − StampDuty) ÷ NAV, rounded to
  the AMC's precision (default 3 decimals; allow override to match the statement exactly).
- Allow entering Units and NAV instead; compute Amount.
- Every NAV entered on a transaction is also upserted into `MFNAVHistory` (Source = 'TRANSACTION')
  if that date has no AMFI NAV.

### 5.1 Holdings (derived — no MFHolding table)

```sql
CREATE VIEW vMFHoldings AS
SELECT
  t.InvestmentAccountId,
  t.FolioId,
  t.MutualFundPlanId,
  SUM(CASE WHEN t.TransactionType IN ('PURCHASE','SIP','SWITCH_IN','IDCW_REINVEST','BONUS','TRANSFER_IN') THEN t.Units
           WHEN t.TransactionType IN ('REDEMPTION','SWITCH_OUT','TRANSFER_OUT') THEN -t.Units
           ELSE 0 END) AS UnitsHeld
FROM MFTransaction t
GROUP BY t.InvestmentAccountId, t.FolioId, t.MutualFundPlanId
HAVING UnitsHeld <> 0;

CREATE VIEW vMFLatestNAV AS
SELECT h.MutualFundPlanId, h.NAVDate, h.NAV
FROM MFNAVHistory h
JOIN (SELECT MutualFundPlanId, MAX(NAVDate) AS MaxDate FROM MFNAVHistory GROUP BY MutualFundPlanId) m
  ON m.MutualFundPlanId = h.MutualFundPlanId AND m.MaxDate = h.NAVDate;
```

Current market value = `UnitsHeld × LatestNAV` — compute in TypeScript with `decimal.js`
(micro-units × micro-units → divide by 10^12 → round to paise). Do not multiply in SQL.

### 5.2 Cost basis, gains and tax (TypeScript, `features/mf/calc/`)

- **FIFO lots:** every unit-adding transaction is a lot (date, units, cost per unit).
  Redemptions/switch-outs consume the oldest lots first. Bonus lots have cost 0.
- **Invested amount (current holdings)** = remaining cost of open lots.
- **Unrealised gain** = current value − invested.
- **Realised gain** per redemption = proceeds − FIFO cost of the units consumed.
- **Holding period** per lot → short-term vs long-term.
- **Tax rules must be configurable**, not hard-coded, in a `TaxRules` settings table/JSON
  (thresholds, holding periods, rates, ₹ exemption limit, grandfathering date 31-Jan-2018,
  and the different treatment of debt funds bought on/after 1-Apr-2023). Ship defaults
  based on the current Income Tax rules and show a note "verify with your CA".
- **XIRR** per plan, per person, per family: cash flows = `TotalAmount` (out = negative,
  in = positive) + today's market value as the final positive flow. Newton-Raphson with
  bisection fallback; unit-test against Excel's XIRR results.
- **Absolute return %** and **CAGR** for display.

---

## 6. NAV data

- **Daily NAV:** AMFI publishes all NAVs at `https://www.amfiindia.com/spages/NAVAll.txt`
  (semicolon-separated: Scheme Code; ISIN Div Payout/Growth; ISIN Div Reinvestment;
  Scheme Name; NAV; Date).
- The browser cannot fetch it directly (CORS), so add a **backend relay endpoint**
  `GET /api/public/amfi-nav` that downloads and caches the public file (once per day).
  It is public data; no user data is sent to the server. The browser then matches by
  `SchemeCode` or `ISIN` and upserts `MFNAVHistory`.
- **Historical NAV backfill** (for charts and historical portfolio value): optional relay to a
  public historical NAV API (e.g. mfapi.in, which is unofficial) by scheme code. Make the
  provider pluggable and handle failures gracefully.
- "Refresh NAV" button + auto-refresh once per day on unlock (after 9 PM IST = previous day OK).
- **Fund search when adding a fund:** search the cached AMFI list by name and auto-fill AMC,
  fund name, scheme code, ISIN, plan type and option from the scheme name.

---

## 7. SIP automation

- **Upcoming SIPs:** compute the schedule from `StartDate`, `Frequency`, `SIPDate`, `EndDate`,
  `PausedUntil`, step-up. If SIPDate is 29–31 and the month is shorter, use the last day.
  If the date is a holiday, allotment happens next business day (user corrects date on confirm).
- **Pending instalments:** on unlock, for every ACTIVE SIP whose instalment date has passed
  without a matching `MFTransaction` (SIPId + month), show a "Pending SIP confirmations" card.
  One click creates the transaction (Source = 'SIP_AUTO') pre-filled with amount and the NAV of
  that date (if available); user can edit units to match the statement.
- Optionally auto-create the matching bank debit in Phase 1 `Transactions` and link
  `BankTransactionId`.
- **Summary:** monthly SIP total and annual SIP total (owner's example: 3 × ₹10,000 =
  ₹30,000/month = ₹3,60,000/year), per person and family.
- Status changes (pause, stop, step-up) are kept in a simple `SIPHistory` audit or `AuditLog`.

---

## 8. Imports

1. **CAS (Consolidated Account Statement) import** — the most important feature for adoption.
   - CAMS/KFintech CAS PDF. CAS PDFs are protected with the password the user sets while
     requesting the statement, so prompt for it. Parse in the browser with `pdf.js` so the PDF
     and its contents never reach the server.
   - Create/match `MutualFund`, `MutualFundPlan` (by ISIN), `MFFolio`, and insert
     `MFTransaction` rows (Source = 'CAS_IMPORT'), with duplicate detection on
     (Folio, Plan, Date, Type, Units, Amount).
   - Show a preview & reconciliation screen: closing units per scheme in the CAS vs computed
     `vMFHoldings`; highlight mismatches.
2. **CSV import** from platforms (Groww / Zerodha Coin / Kuvera exports) with a saved column
   mapping per platform (same mapping UI as Phase 1 bank statement import).
3. Every import gets an `ImportBatchId` and can be undone.

---

## 9. Screens (`frontend/src/features/mf/`)

| Screen | Contents |
|---|---|
| **MF Dashboard** | Family total: invested, current value, gain, XIRR; split by person, category (Equity/Debt/Hybrid), sub-category, AMC; monthly SIP total; pending SIP confirmations; value-over-time chart from NAV history |
| **Portfolio** | Table per plan: person, fund, plan/option, folio, units, avg cost, invested, NAV (date), current value, gain ₹ / %, XIRR, holding period mix (ST/LT) |
| **Fund detail** | Plan info (ISIN, scheme code, expense ratio, exit load), NAV chart, lots (FIFO), transactions, SIPs |
| **Funds master** | Add from AMFI search or manual; manage plans/options |
| **Investment accounts & folios** | Platforms per person; folios with holders, nominees, guardian (kids) |
| **SIPs** | List with status, next date, amount; add/edit/pause/stop/step-up; calendar view |
| **Transactions** | Filter by person/fund/type/date; add (form adapts to type); switch wizard (creates both legs) |
| **Capital gains** | Per FY (Apr–Mar): realised ST/LT gains per person, export to CSV/XLSX for ITR |
| **Import** | CAS PDF, CSV, with preview and undo |

All amounts in Indian format (₹3,60,000.00); units to 3–4 decimals; NAV to 4 decimals.

---

## 10. Sample / seed data (dev & tests only — never seed in production)

Use the owner's example: three funds, Direct-Growth, one investment account, three monthly
SIPs of ₹10,000 on the 10th, starting 10-Jan-2026.

```sql
INSERT INTO Persons (FirstName, LastName, Relationship, CreatedOn, UpdatedOn)
VALUES ('Sample', 'Owner', 'Self', datetime('now'), datetime('now'));          -- PersonId 1

INSERT INTO MutualFund (AMCName, FundName, Category, SubCategory, RiskLevel) VALUES
 ('AMC 1','Fund 1','Equity','Flexi Cap','Very High'),
 ('AMC 2','Fund 2','Equity','Large Cap','Very High'),
 ('AMC 3','Fund 3','Hybrid','Aggressive Hybrid','Very High');

INSERT INTO MutualFundPlan (MutualFundId, PlanType, OptionType, SchemeCode, ISIN) VALUES
 (1,'DIRECT','GROWTH','SCHEME001','ISIN001'),
 (2,'DIRECT','GROWTH','SCHEME002','ISIN002'),
 (3,'DIRECT','GROWTH','SCHEME003','ISIN003');

INSERT INTO InvestmentAccount (PersonId, AccountName, PlatformName, HolderName)
VALUES (1,'My Mutual Fund Account','MF Platform','Sample Owner');               -- Id 1

INSERT INTO SIP (MutualFundPlanId, InvestmentAccountId, SIPAmount, Frequency, SIPDate, StartDate, Status) VALUES
 (1,1,1000000,'MONTHLY',10,'2026-01-10','ACTIVE'),     -- ₹10,000 = 1,000,000 paise
 (2,1,1000000,'MONTHLY',10,'2026-01-10','ACTIVE'),
 (3,1,1000000,'MONTHLY',10,'2026-01-10','ACTIVE');

-- Example SIP instalment: 10-Oct-2026, NAV 125.50, ₹10,000
-- Stamp duty 0.005% = ₹0.50 → units = 9,999.50 / 125.50 = 79.677 (3-dp allotment)
INSERT INTO MFTransaction (MutualFundPlanId, InvestmentAccountId, SIPId, TransactionDate, TransactionType,
                           NAV, Units, Amount, StampDuty, TotalAmount, Source)
VALUES (1,1,1,'2026-10-10','SIP', 125500000, 79677000, 999950, 50, 1000000, 'SIP_AUTO');
```

> The owner's example (₹10,000 ÷ 125.50 = 79.681275 units) ignores stamp duty. Real allotment
> is on the net amount after 0.005% stamp duty and is usually rounded to 3 decimals; the app
> must let the user overwrite units to match the actual statement.

Expected results for tests: Monthly SIP = ₹30,000; Annual SIP = ₹3,60,000; after 10
instalments (Jan–Oct 2026) invested per fund = ₹1,00,000 and family total = ₹3,00,000.

---

## 11. Tests (must pass before the module is "done")

- Unit conversion helpers: paise ↔ ₹, micro-units ↔ decimal, rounding.
- Holdings view: buy → partial redeem → switch → bonus → IDCW reinvest gives expected units.
- Validation: cannot redeem more units than held (per folio + plan + date).
- FIFO: multi-lot redemption produces correct realised gain and ST/LT split.
- XIRR: matches Excel XIRR within 0.01% for 3 reference cash-flow sets.
- SIP schedule: 31st-day SIPs in Feb/Apr, pause window, step-up after 12 months, end date.
- Pending SIP detection: no duplicates after confirmation.
- AMFI parser: sample `NAVAll.txt` fixture, scheme-code and ISIN matching.
- CAS import: fixture file → expected folios/transactions; re-import creates no duplicates.
- Migration test: Phase 1 database upgrades to Phase 2 schema without data loss.

## 12. Acceptance criteria

1. Add the 3 funds by searching the AMFI list; plans auto-filled with scheme code and ISIN.
2. Create investment accounts for self, spouse and one child (with guardian on the folio).
3. Create the 3 SIPs; dashboard shows ₹30,000/month and ₹3,60,000/year.
4. Confirm pending SIP instalments; units and amounts match a real statement.
5. Refresh NAV; portfolio shows current value, gain and XIRR per fund, person and family.
6. Import a real CAS; reconciliation shows zero unit mismatches.
7. Redeem part of a fund; realised gain and ST/LT classification appear in the FY report.
8. Everything works on a phone browser; all data remains inside the encrypted vault.

## 13. Out of scope for now (later phases / enhancements)

- Placing orders / starting SIPs on platforms (read-only tracking only).
- Scheme mergers & consolidation automation (handle manually with SWITCH legs for now).
- Goal-based planning (child education, retirement) — separate "Goals" module later, linking
  SIPs to goals.
- Portfolio overlap / fund-level stock holdings analysis.

---

## 14. Implementation notes (as built)

Status: **all §12 acceptance criteria are covered by tests** (`frontend/src/repositories/mf.test.ts`,
`frontend/src/features/mf/calc/calc.test.ts`, `frontend/e2e/mf.spec.ts`, `backend/tests/test_public_data.py`).
Criterion 6 (real CAS) is tested with a synthetic CAS in the CAMS layout; validate once with a real
statement.

| Area | Where |
|---|---|
| Schema | `frontend/src/db/migrations/003_mutual_funds.sql` |
| Unit / money maths (decimal.js) | `frontend/src/lib/units.ts` |
| FIFO, XIRR, tax rules, SIP schedule | `frontend/src/features/mf/calc/` |
| AMFI parser, CAS parser, pdf.js extraction | `frontend/src/features/mf/amfi.ts`, `cas.ts`, `pdf.ts` |
| Repositories | `frontend/src/repositories/mf*.ts`, `sips.ts` |
| Screens | `frontend/src/features/mf/` |
| NAV relays | `backend/app/public_data.py` |

Small additions to the schema in §4 (none change the owner's tables or names):

1. `MutualFund.TaxClass` (nullable `EQUITY`/`DEBT`/`OTHER`) overrides the category-based tax treatment.
2. `SIPHistory` (status/amount audit, §7), `MFImportBatch` (undoable imports, §8) and
   `MFImportMapping` (CSV mapping per platform, §8).
3. `MFTransaction.BankTransactionId … ON DELETE SET NULL` and `SIPId … ON DELETE SET NULL`, so
   deleting a bank entry or SIP never fails on the link; `ImportBatchId` references `MFImportBatch`.
4. Default tax rules stored in `AppSettings` (`MFTaxRules`), editable in Settings.

Behaviour worth knowing:

- Purchase/SIP: the user enters the **gross** amount; stamp duty defaults to 0.005%;
  `Amount` = gross − stamp; units = `Amount ÷ NAV` rounded to 3 dp (editable to match the statement).
  Cost of a lot = `Amount + StampDuty + OtherCharges` (stamp duty is part of the cost of acquisition).
- Realised gain uses `Amount − ExitLoad − OtherCharges` as sale value (STT is not deductible).
- Units can never go negative per folio + plan on any date (checked on create, edit and delete).
- Pending SIP instalments match a transaction within −3/+7 days of the schedule (holidays);
  pauses are reconstructed from `SIPHistory`; expired pauses auto-resume on unlock.
- NAV source priority when two sources give the same date: AMFI > Manual (CAS closing NAV) >
  historical relay > transaction.
- Equity LTCG exemption is applied once per person per FY; the tax estimate covers fixed-rate gains
  only (no surcharge/cess; slab-rate gains are listed separately).

