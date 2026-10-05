# Artha — Phase 3: Insurance Module + Common Reminder Engine

> **For Claude Code:** Specification for Phase 3 of Artha. Read `docs/PLAN.md` (master plan)
> and `docs/modules/MUTUAL_FUNDS.md` first — the security model, money/date conventions,
> SQLite type mappings and migration rules apply here too.
> Put this file in the repo as `docs/modules/INSURANCE_AND_REMINDERS.md`.
>
> **Build order inside this phase:**
> 1. **Common Reminder engine** (§3) — a core module used by every module, not only insurance.
> 2. **Common Document store** (§4) — encrypted attachments for any entity.
> 3. **Insurance module** (§5–§9).
> 4. Retro-fit reminder event providers for Phase 1 (FD/PPF/SSY maturity) and Phase 2 (SIP dates).

---

## 1. Goal

Insurance has two distinct things to manage:

1. **Policy information** — what is insured, cover, insurer company, policy holder, insured
   members, nominees, policy dates, documents.
2. **Recurring obligations** — premium payments, renewal dates and reminders.

Design decisions (owner's — keep them):

- **One `InsurancePolicy` table with an `InsuranceType`**, not separate tables for health,
  term, motor, home, travel, etc.
- `InsurancePolicy.PremiumAmount` = current/expected premium; `InsurancePremium` = actual
  due/payment history.
- Separate tables for **members** (family floater) and **nominees** (percentage split).
- Reminders are **rule-based** (30/14/7/1 days before), generated automatically — never
  created by hand every year.
- **Reminder is a common/core module from the beginning**, shared by Insurance, SIP, Loans,
  FD maturity, credit cards, documents, passport, vehicle RC, etc.

### People come from `Persons` only

Policy holder (proposer), insured members and nominees are always linked to the Phase 1
`Persons` table (self, spouse, kids, parents, others). Names, relationship and date of birth
are **not** typed again in the insurance tables — they are read from `Persons`. If a nominee
or member is not yet in the family list, the UI offers "Add person" inline (Relationship can
be `Other`). The insurance **company** comes from the `InsuranceCompany` table.

---

## 2. Adaptations from the owner's SQL Server draft (same as MF module)

| Owner's draft | Artha (SQLite in browser) |
|---|---|
| `INT/BIGINT PRIMARY KEY IDENTITY` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `VARCHAR(n)` | `TEXT` (length validated by Zod in the UI) |
| `BIT` | `INTEGER` 0/1 with `CHECK` |
| `DATE` / `DATETIME`, `GETDATE()` | ISO-8601 `TEXT`, default `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `CreatedDate` / `ModifiedDate` | `CreatedOn` / `UpdatedOn` |
| `DECIMAL(18,2)` money | `INTEGER` paise |
| `DECIMAL(5,2)` percentage | `INTEGER` basis points (70.00% → `7000`) |
| `MemberName`, `NomineeName`, `DateOfBirth`, `Relationship`, `PolicyHolderName`, `InsuredName` | `PersonId` → `Persons` (owner's rule: persons table only) |
| `InsuranceReminder`, `InsuranceReminderRule` | Generic `Reminder`, `ReminderRule` (§3) with `EntityType = 'INSURANCE_POLICY'` |
| `InsuranceDocument.FilePath` | Generic `Document` table (§4); files stored encrypted on server, no plain file paths |

---

## 3. Common Reminder Engine (core module)

### 3.1 Concept

```
 Module "event providers"            Reminder engine                      UI
 ───────────────────────            ───────────────                      ──
 Insurance: renewal, premium due ┐
 SIP: next instalment            │   events (date + entity)
 Loan: EMI due                   ├──▶ apply ReminderRules ──▶ Reminder rows ──▶ Reminder Center,
 FD / PPF / SSY: maturity        │   (30/14/7/1 days before)   (idempotent)      dashboard badges,
 Credit card: bill due           │                                              notifications
 Documents: expiry               │
 Custom: passport, RC, PUC ...   ┘
```

- Each module exposes an **event provider**: `getEvents(fromDate, toDate): ReminderEvent[]`
  where `ReminderEvent = { entityType, entityId, eventType, eventDate, title, amount? }`.
- The engine applies **rules** (per entity, else per type default) and **upserts** reminder rows.
- Runs on vault unlock and once per day while the app is open (look-ahead window: 400 days,
  so yearly renewals always have their reminders).

### 3.2 Schema

```sql
-- Default rules per event type, and optional overrides per entity
CREATE TABLE ReminderRule (
  ReminderRuleId   INTEGER PRIMARY KEY AUTOINCREMENT,
  EntityType       TEXT NOT NULL,       -- INSURANCE_POLICY, SIP, LOAN, FIXED_DEPOSIT, CREDIT_CARD, DOCUMENT, CUSTOM ...
  EntityId         INTEGER,             -- NULL = default rule for every entity of this type
  ReminderType     TEXT NOT NULL,       -- PREMIUM_DUE, POLICY_RENEWAL, DOCUMENT_EXPIRY, SIP_DUE, EMI_DUE, MATURITY, BILL_DUE, OTHER
  DaysBefore       INTEGER NOT NULL CHECK (DaysBefore >= 0),
  NotificationMethod TEXT NOT NULL DEFAULT 'APP' CHECK (NotificationMethod IN ('APP','PUSH','EMAIL')),
  IsActive         INTEGER NOT NULL DEFAULT 1 CHECK (IsActive IN (0,1)),
  CreatedOn        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn        TEXT,
  UNIQUE (EntityType, EntityId, ReminderType, DaysBefore, NotificationMethod)
);
-- Rule resolution: if any active rule exists for (EntityType, EntityId, ReminderType), use those;
-- otherwise use the defaults (EntityId IS NULL). A per-entity "no reminders" flag = set all its rules inactive.

-- Generated (and manual) reminders
CREATE TABLE Reminder (
  ReminderId       INTEGER PRIMARY KEY AUTOINCREMENT,
  EntityType       TEXT NOT NULL,
  EntityId         INTEGER,             -- NULL for CUSTOM reminders not tied to a record
  ReminderType     TEXT NOT NULL,
  EventDate        TEXT NOT NULL,       -- the due/renewal/expiry date itself
  ReminderDate     TEXT NOT NULL,       -- EventDate - DaysBefore
  DaysBefore       INTEGER,
  ReminderTitle    TEXT NOT NULL,
  ReminderMessage  TEXT,
  Amount           INTEGER,             -- paise, e.g. premium due (optional)
  Status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (Status IN ('PENDING','SNOOZED','COMPLETED','DISMISSED','CANCELLED')),
  SnoozedUntil     TEXT,
  CompletedOn      TEXT,
  ReminderRuleId   INTEGER REFERENCES ReminderRule(ReminderRuleId),
  IsManual         INTEGER NOT NULL DEFAULT 0 CHECK (IsManual IN (0,1)),
  SourceKey        TEXT UNIQUE,         -- idempotency: "INSURANCE_POLICY:12:POLICY_RENEWAL:2027-01-10:30"
  CreatedOn        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn        TEXT
);
CREATE INDEX IX_Reminder_Date   ON Reminder(Status, ReminderDate);
CREATE INDEX IX_Reminder_Entity ON Reminder(EntityType, EntityId);

-- Custom recurring reminders not tied to any module (passport, vehicle RC, PUC, ITR filing ...)
CREATE TABLE CustomReminder (
  CustomReminderId INTEGER PRIMARY KEY AUTOINCREMENT,
  Title            TEXT NOT NULL,
  PersonId         INTEGER REFERENCES Persons(PersonId),
  EventDate        TEXT NOT NULL,       -- first / next occurrence
  Recurrence       TEXT NOT NULL DEFAULT 'NONE' CHECK (Recurrence IN ('NONE','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY','EVERY_N_YEARS')),
  RecurrenceYears  INTEGER,             -- for EVERY_N_YEARS (passport = 10)
  Notes            TEXT,
  IsActive         INTEGER NOT NULL DEFAULT 1 CHECK (IsActive IN (0,1)),
  CreatedOn        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn        TEXT
);
```

**Default rules to seed (editable in Settings → Reminders):**

| EntityType / ReminderType | Days before |
|---|---|
| INSURANCE_POLICY / POLICY_RENEWAL | 30, 14, 7, 1 |
| INSURANCE_POLICY / PREMIUM_DUE | 15, 3, 0 |
| DOCUMENT / DOCUMENT_EXPIRY | 60, 30, 7 |
| SIP / SIP_DUE | 2 (balance check) |
| FIXED_DEPOSIT, PPF, SSY / MATURITY | 30, 7 |
| LOAN / EMI_DUE | 3, 0 |
| CUSTOM / OTHER | 30, 7, 1 |

### 3.3 Engine rules (`frontend/src/core/reminders/`)

1. **Idempotent:** build `SourceKey` = `EntityType:EntityId:ReminderType:EventDate:DaysBefore`;
   insert only if not existing. Re-running the engine never creates duplicates.
2. **Event moved or cancelled** (renewal date changed, policy cancelled, premium paid):
   all `PENDING`/`SNOOZED` reminders for that entity+type whose `EventDate` no longer matches
   an event are set to `CANCELLED`.
3. **Premium paid / renewed** → that event's reminders are set to `COMPLETED` automatically.
4. **Past reminder dates:** if a rule's `ReminderDate` is already in the past when generated
   but the event is still in the future, create it with today's date (don't skip silently).
5. **Snooze:** 1 day / 3 days / custom; reappears on `SnoozedUntil`.
6. **Overdue:** event date passed and not completed → shown in red under "Overdue".
7. Rule changes in Settings regenerate future pending reminders for that type.

### 3.4 Notifications and privacy (important)

Artha is end-to-end encrypted: the server cannot read reminders. Therefore:

- **APP (default):** Reminder Center + badge in the app, computed in the browser after unlock.
- **PUSH (optional, Web Push / PWA):** the browser sends the server only **timestamps**
  with a **generic message** ("Artha: you have reminders due today"). Never send policy names,
  amounts, insurer or person names to the server, push service or email provider.
- **EMAIL (optional):** same rule — generic text only, no financial details.
- **SMS:** not supported (would require sending data to a third party).
- **Calendar export (.ics download):** user-initiated, with a warning that the calendar
  provider will see the titles; offer "generic titles" option.
- Settings page explains this clearly.

---

## 4. Common Document store (replaces `InsuranceDocument.FilePath`)

Documents are generic so they can be reused for property papers, MF statements, loan
agreements, RC, passport, etc. Files are encrypted in the browser (AES-GCM, key derived from
the DEK) and uploaded to `/api/files`; the database only stores metadata and the server file id.

```sql
CREATE TABLE Document (
  DocumentId     INTEGER PRIMARY KEY AUTOINCREMENT,
  EntityType     TEXT NOT NULL,         -- INSURANCE_POLICY, INSURANCE_PREMIUM, INSURANCE_CLAIM, PROPERTY, LOAN, PERSON ...
  EntityId       INTEGER NOT NULL,
  DocumentType   TEXT NOT NULL,         -- POLICY_DOCUMENT, PREMIUM_RECEIPT, HEALTH_CARD, CLAIM_DOCUMENT, RC, RENEWAL_DOCUMENT, OTHER
  DocumentName   TEXT NOT NULL,
  FileName       TEXT NOT NULL,         -- original name
  MimeType       TEXT,
  FileSizeBytes  INTEGER,
  ServerFileId   TEXT NOT NULL,         -- opaque id of the encrypted file on the server
  FileKeyWrapped TEXT NOT NULL,         -- per-file key wrapped by the DEK
  Sha256         TEXT,                  -- of plaintext, for duplicate detection
  DocumentDate   TEXT,
  ExpiryDate     TEXT,                  -- feeds DOCUMENT_EXPIRY reminders
  Notes          TEXT,
  CreatedOn      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn      TEXT
);
CREATE INDEX IX_Document_Entity ON Document(EntityType, EntityId);
```

- Max file size 20 MB (configurable); images can be compressed client-side.
- Viewer decrypts in memory and shows PDF/image in the app; "Download" decrypts to a file.
- Google Drive backup job also backs up the encrypted files folder.

---

## 5. Insurance schema (migration `NNN_insurance.sql`)

```sql
-- 5.1 Insurance companies
CREATE TABLE InsuranceCompany (
  InsuranceCompanyId INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyName        TEXT NOT NULL UNIQUE,
  CompanyType        TEXT CHECK (CompanyType IN ('LIFE','GENERAL','HEALTH')),
  ContactNumber      TEXT,
  ClaimsContactNumber TEXT,
  Email              TEXT,
  Website            TEXT,
  Status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','INACTIVE')),
  Notes              TEXT,
  CreatedOn          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn          TEXT
);

-- 5.2 Policies (one table for all types)
CREATE TABLE InsurancePolicy (
  InsurancePolicyId    INTEGER PRIMARY KEY AUTOINCREMENT,
  InsuranceCompanyId   INTEGER NOT NULL REFERENCES InsuranceCompany(InsuranceCompanyId),
  PolicyNumber         TEXT NOT NULL,
  PolicyName           TEXT,                 -- plan name, e.g. "Optima Secure", "iProtect Smart"
  InsuranceType        TEXT NOT NULL CHECK (InsuranceType IN (
                         'TERM','LIFE','HEALTH','MOTOR','HOME','TRAVEL','PERSONAL_ACCIDENT',
                         'PROPERTY','GENERAL','OTHER')),
  SubType              TEXT,                 -- FAMILY_FLOATER, INDIVIDUAL, SUPER_TOP_UP, CAR, BIKE, ENDOWMENT, ULIP ...
  PolicyHolderPersonId INTEGER NOT NULL REFERENCES Persons(PersonId),   -- proposer / policy holder
  SumInsured           INTEGER,              -- paise (IDV for motor, cover for term/health)
  PremiumAmount        INTEGER,              -- paise, current/expected premium (incl. GST)
  PremiumFrequency     TEXT CHECK (PremiumFrequency IN ('MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY','SINGLE')),
  PremiumDueDay        INTEGER CHECK (PremiumDueDay BETWEEN 1 AND 31),
  GracePeriodDays      INTEGER DEFAULT 30,   -- lapse warning after due date
  PolicyStartDate      TEXT,
  PolicyEndDate        TEXT,                 -- cover end date (term policy: end of cover)
  PremiumPayingEndDate TEXT,                 -- limited-pay term/life policies
  RenewalDate          TEXT,                 -- next renewal (health/motor/home/travel)
  PreviousPolicyId     INTEGER REFERENCES InsurancePolicy(InsurancePolicyId),  -- renewal chain when policy number changes
  InsuredAssetType     TEXT CHECK (InsuredAssetType IN ('NONE','VEHICLE','PROPERTY','OTHER')) DEFAULT 'NONE',
  InsuredAssetRef      TEXT,                 -- e.g. vehicle registration no. / address
  LinkedPropertyId     INTEGER,              -- FK to Property (Phase 4) once that table exists
  PaymentBankAccountId INTEGER REFERENCES Accounts(AccountId),   -- default bank/auto-debit
  TaxSection           TEXT CHECK (TaxSection IN ('80C','80D','10(10D)','NONE')) DEFAULT 'NONE',
  TypeDetails          TEXT,                 -- JSON, type-specific fields (see 5.7), validated by Zod
  Status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','EXPIRED','CANCELLED','LAPSED','MATURED','SURRENDERED','CLAIMED')),
  AgentName            TEXT,
  AgentContact         TEXT,
  CustomerPortalLogin_Enc TEXT,              -- field-encrypted, optional
  Notes                TEXT,
  CreatedOn            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn            TEXT,
  UNIQUE (InsuranceCompanyId, PolicyNumber)
);
CREATE INDEX IX_InsurancePolicy_Type    ON InsurancePolicy(InsuranceType, Status);
CREATE INDEX IX_InsurancePolicy_Renewal ON InsurancePolicy(RenewalDate);

-- 5.3 Insured members (family floater etc.) — persons only
CREATE TABLE InsuranceMember (
  InsuranceMemberId  INTEGER PRIMARY KEY AUTOINCREMENT,
  InsurancePolicyId  INTEGER NOT NULL REFERENCES InsurancePolicy(InsurancePolicyId) ON DELETE CASCADE,
  PersonId           INTEGER NOT NULL REFERENCES Persons(PersonId),
  IsPrimaryInsured   INTEGER NOT NULL DEFAULT 0 CHECK (IsPrimaryInsured IN (0,1)),
  SumInsuredShare    INTEGER,          -- paise; for individual-sum-insured policies (NULL for floater)
  PreExistingDiseases_Enc TEXT,        -- optional, field-encrypted (health)
  MemberIdOnCard     TEXT,             -- health card / TPA member id
  Notes              TEXT,
  UNIQUE (InsurancePolicyId, PersonId)
);

-- 5.4 Nominees — persons only
CREATE TABLE InsuranceNominee (
  NomineeId          INTEGER PRIMARY KEY AUTOINCREMENT,
  InsurancePolicyId  INTEGER NOT NULL REFERENCES InsurancePolicy(InsurancePolicyId) ON DELETE CASCADE,
  PersonId           INTEGER NOT NULL REFERENCES Persons(PersonId),
  NomineePercentageBps INTEGER NOT NULL CHECK (NomineePercentageBps BETWEEN 1 AND 10000),  -- 70% → 7000
  AppointeePersonId  INTEGER REFERENCES Persons(PersonId),   -- required if nominee is a minor
  Notes              TEXT,
  UNIQUE (InsurancePolicyId, PersonId)
);
-- Validation (app layer): nominee percentages per policy must total exactly 100%;
-- if a nominee is under 18 (from Persons.DateOfBirth) an appointee is required.

-- 5.5 Premium schedule & payment history
CREATE TABLE InsurancePremium (
  PremiumId            INTEGER PRIMARY KEY AUTOINCREMENT,
  InsurancePolicyId    INTEGER NOT NULL REFERENCES InsurancePolicy(InsurancePolicyId),
  DueDate              TEXT NOT NULL,
  PremiumAmount        INTEGER NOT NULL,     -- paise, expected (incl. GST)
  GSTAmount            INTEGER,              -- paise (for records)
  PaymentDate          TEXT,
  PaidAmount           INTEGER,              -- paise
  PaymentStatus        TEXT NOT NULL DEFAULT 'PENDING' CHECK (PaymentStatus IN ('PENDING','PAID','OVERDUE','WAIVED','CANCELLED')),
  PaymentMode          TEXT CHECK (PaymentMode IN ('CASH','UPI','BANK','CREDIT_CARD','DEBIT_CARD','AUTO_DEBIT','CHEQUE')),
  PaidFromAccountId    INTEGER REFERENCES Accounts(AccountId),
  BankTransactionId    INTEGER REFERENCES Transactions(TransactionId),   -- Phase 1 link
  TransactionReference TEXT,
  ReceiptNumber        TEXT,
  CoverFrom            TEXT,                 -- period this premium covers
  CoverTo              TEXT,
  Notes                TEXT,
  CreatedOn            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn            TEXT,
  UNIQUE (InsurancePolicyId, DueDate)
);
CREATE INDEX IX_InsurancePremium_Due ON InsurancePremium(PaymentStatus, DueDate);

-- 5.6 Claims (added — needed for health & motor)
CREATE TABLE InsuranceClaim (
  ClaimId            INTEGER PRIMARY KEY AUTOINCREMENT,
  InsurancePolicyId  INTEGER NOT NULL REFERENCES InsurancePolicy(InsurancePolicyId),
  ClaimantPersonId   INTEGER REFERENCES Persons(PersonId),
  ClaimNumber        TEXT,
  ClaimType          TEXT CHECK (ClaimType IN ('CASHLESS','REIMBURSEMENT','DEATH','MATURITY','OWN_DAMAGE','THIRD_PARTY','THEFT','OTHER')),
  IncidentDate       TEXT,
  ClaimDate          TEXT NOT NULL,
  ClaimedAmount      INTEGER,          -- paise
  ApprovedAmount     INTEGER,          -- paise
  SettledAmount      INTEGER,          -- paise
  SettlementDate     TEXT,
  Status             TEXT NOT NULL DEFAULT 'FILED' CHECK (Status IN ('FILED','IN_PROCESS','APPROVED','PARTIALLY_SETTLED','SETTLED','REJECTED','WITHDRAWN')),
  HospitalOrGarage   TEXT,
  Notes              TEXT,
  CreatedOn          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn          TEXT
);
```

### 5.7 `TypeDetails` JSON (one table, type-specific fields without new columns)

Validate with a Zod schema per `InsuranceType`; all fields optional.

| Type | Fields |
|---|---|
| HEALTH | `tpaName`, `tpaContact`, `roomRentLimit`, `deductible`, `coPayPercent`, `noClaimBonusPercent`, `restoreBenefit`, `waitingPeriodPED` (months), `networkHospitalsUrl` |
| TERM / LIFE | `policyTermYears`, `premiumPayingTermYears`, `riders` [], `maturityBenefit`, `deathBenefit`, `surrenderValue` |
| MOTOR | `vehicleType` (CAR/BIKE), `make`, `model`, `registrationNo`, `engineNo`, `chassisNo`, `idv`, `ncbPercent`, `zeroDep`, `addOns` [] |
| HOME / PROPERTY | `structureCover`, `contentsCover`, `address` |
| TRAVEL | `destination`, `tripStart`, `tripEnd`, `multiTrip` |
| PERSONAL_ACCIDENT | `accidentalDeath`, `permanentDisability`, `weeklyBenefit` |

Amounts inside JSON are also stored as integer paise.

---

## 6. Business rules (`frontend/src/features/insurance/`)

### 6.1 Premium schedule generation

- When a policy is saved (and on unlock), generate `InsurancePremium` rows for the **next
  12 months** (and at least the next due) from `PolicyStartDate` / `RenewalDate`,
  `PremiumFrequency`, `PremiumDueDay`, `PremiumPayingEndDate`. `SINGLE` = one row only.
- Use `PremiumAmount` from the policy as the expected amount; the user can edit a specific row
  (e.g. renewal premium increased from ₹29,500 to ₹31,000).
- `UNIQUE (InsurancePolicyId, DueDate)` makes generation idempotent.
- Status is recalculated on unlock: `PENDING` + `DueDate` passed → `OVERDUE`;
  `OVERDUE` + grace period passed and policy is TERM/LIFE → prompt to mark policy `LAPSED`.

### 6.2 Paying a premium

"Mark as paid" dialog: payment date, paid amount, mode, from account, reference, receipt
number, attach receipt (Document). Optionally create the matching debit in Phase 1
`Transactions` and link `BankTransactionId`. Completes that premium's reminders.

### 6.3 Renewal (yearly policies: health, motor, home, travel)

"Renew" action:
- **Same policy number** (common for health): update `RenewalDate` + 1 year, update
  `PremiumAmount`/`SumInsured`, keep history in `InsurancePremium`.
- **New policy number** (common for motor, or when switching insurer): create a new
  `InsurancePolicy` with `PreviousPolicyId` → old one, copy members/nominees/TypeDetails,
  mark old policy `EXPIRED`. Policy detail page shows the renewal chain.

### 6.4 Validation

- Nominee percentages = 100% per policy; appointee required for minor nominees.
- Health floater must have ≥ 1 member; exactly one `IsPrimaryInsured` (warn if none).
- `PolicyEndDate` ≥ `PolicyStartDate`; motor requires `registrationNo` in TypeDetails.
- Warn on duplicate active policy for the same vehicle registration number.

### 6.5 Reminder event provider (insurance)

```ts
// features/insurance/reminderEvents.ts
// POLICY_RENEWAL: RenewalDate (or PolicyEndDate if no renewal) of ACTIVE policies
// PREMIUM_DUE:    DueDate of InsurancePremium rows with status PENDING/OVERDUE
// DOCUMENT_EXPIRY: Document.ExpiryDate for EntityType = 'INSURANCE_POLICY'
```

Example — car insurance renewing 10-Jan-2027 with default rules 30/14/7/1:

| ReminderDate | Days before | Title |
|---|---|---|
| 11-Dec-2026 | 30 | Car insurance renewal due on 10-Jan-2027 |
| 27-Dec-2026 | 14 | Car insurance renewal due on 10-Jan-2027 |
| 03-Jan-2027 | 7 | Car insurance renewal due on 10-Jan-2027 |
| 09-Jan-2027 | 1 | Car insurance renewal due tomorrow |

(30 days before 10-Jan-2027 is 11-Dec-2026.)

---

## 7. Screens

| Screen | Contents |
|---|---|
| **Insurance dashboard** | Total cover per person (health, term/life, accident); annual premium outgo (family, per person, per type); upcoming renewals & premiums (next 60 days); overdue premiums; policies expiring without renewal; "gaps" hints (e.g. a family member with no health cover, no term cover for an earning member) |
| **Policies list** | Filter by type, person, insurer, status; cards show insurer, type, policy no., cover, premium, next due/renewal |
| **Policy detail** (tabs) | Overview & type details · Members · Nominees · Premiums (history + upcoming, the owner's table view) · Claims · Documents · Reminders (rules for this policy + generated reminders) · Renewal chain |
| **Add/Edit policy wizard** | Type → company → holder & members (from Persons) → cover & premium → dates → nominees → reminders (defaults pre-filled) → documents |
| **Insurance companies** | Master list with contact/claim numbers |
| **Reminder Center** (core) | Tabs: Overdue · Today · Next 7 days · Next 30 days · All; actions: complete, snooze, dismiss, open linked record; manual/custom reminders; calendar view |
| **Settings → Reminders** | Default rules per reminder type; notification method (App/Push/Email with privacy note) |

Premium history view (owner's example format):

```
Policy: Car Insurance
Due Date      Amount     Paid Date     Status
10-Jan-2025   ₹28,000    08-Jan-2025   PAID
10-Jan-2026   ₹29,500    07-Jan-2026   PAID
10-Jan-2027   ₹31,000    -             PENDING
```

---

## 8. Reports

- Annual premium summary per FY (Apr–Mar) and per person.
- Tax summary: 80C (life/term), 80D (health — self/family and parents shown separately),
  with a note to verify limits with the CA (limits stored as configurable settings, not code).
- Cover summary per person: health, term/life, accident.
- Claims history and settlement ratio (own claims).
- Export to CSV/XLSX.

---

## 9. Integration with other modules

| Module | Integration |
|---|---|
| Persons (Phase 1) | Policy holder, members, nominees, appointee, claimant |
| Bank (Phase 1) | Premium payment links to `Transactions`; default payment account |
| Property (Phase 4) | `LinkedPropertyId` for home/property insurance |
| Loans (Phase 7) | Home-loan-linked insurance (optional link later) |
| Net worth | Term/health = protection only (not an asset); endowment/ULIP surrender value can be shown as an asset |
| Reminder engine | Renewal, premium due, document expiry |
| Document store | Policy PDF, receipts, health card, RC, claim documents |

Retro-fit in this phase: event providers for **SIP_DUE** (Phase 2) and **MATURITY** of
FD/PPF/SSY (Phase 1), so the Reminder Center is useful immediately.

---

## 10. Example data (tests/dev only — never seed real data in production)

Family floater (members come from `Persons`):

```
Policy: Family Floater (HEALTH / FAMILY_FLOATER), Sum insured ₹10,00,000
  Members : Karan (Self, primary), Nisha (Spouse), Suhani (Child), Sanjvi (Child)
  Nominee : Nisha 100%
  Premium : ₹32,000 yearly, renewal 15-Apr-2027
```

Term policy with split nominees:

```
Policy: Term Plan (TERM), cover ₹1,00,00,000, policy holder & insured: Karan
  Nominee 1 → Nisha  70%
  Nominee 2 → Suhani 30% (minor → appointee: Nisha)
```

Car insurance: premiums 10-Jan-2025 ₹28,000 PAID, 10-Jan-2026 ₹29,500 PAID,
10-Jan-2027 ₹31,000 PENDING; reminders as in §6.5.

---

## 11. Tests

- Reminder engine: idempotency (run twice → no duplicates); rule override vs default;
  event date change cancels old pending reminders; paid premium completes reminders;
  past reminder date clamped to today; snooze; leap-year and month-end dates.
- Premium schedule: monthly/quarterly/half-yearly/yearly/single; due day 31 in short months;
  premium-paying end date respected; overdue and lapse detection.
- Nominee validation (100% total, minor appointee).
- Renewal with same vs new policy number (chain, members/nominees copied).
- TypeDetails Zod schemas per type.
- Document encryption round-trip; server stores only ciphertext.
- Migration from Phase 2 database without data loss.

## 12. Acceptance criteria

1. Add a family floater with 4 members and a term plan with 2 nominees (70/30, minor appointee).
2. Add car insurance; premium history shows 2 paid years and 1 pending.
3. Reminder Center shows 30/14/7/1-day renewal reminders automatically, without manual entry.
4. Marking a premium paid links the bank transaction and clears its reminders.
5. Renewing the car policy with a new policy number keeps the history chain.
6. SIP due and FD/PPF maturity reminders also appear in the same Reminder Center.
7. Policy PDF and receipt upload, open and download correctly; server holds only encrypted files.
8. No policy names, amounts or person names are ever sent in push/email notifications.
9. Works fully on a phone browser.

## 13. Out of scope (later)

- Fetching policies automatically from insurers or the insurance repository.
- Premium comparison / quote fetching.
- SMS notifications (privacy).
