-- Phase 2: mutual funds & SIPs. Spec: docs/modules/MUTUAL_FUNDS.md
-- Units/NAV are INTEGER micro-units (x 1,000,000). Money is INTEGER paise.
-- Table names are singular, as designed by the owner.

CREATE TABLE MutualFund (
  MutualFundId   INTEGER PRIMARY KEY AUTOINCREMENT,
  AMCName        TEXT NOT NULL,
  FundName       TEXT NOT NULL,
  Category       TEXT,               -- Equity / Debt / Hybrid / Solution Oriented / Other
  SubCategory    TEXT,
  Benchmark      TEXT,
  FundType       TEXT,               -- Open Ended / Close Ended / Interval
  RiskLevel      TEXT,
  InceptionDate  TEXT,
  -- Capital-gains treatment. NULL = derive from Category/SubCategory via tax rules.
  TaxClass       TEXT CHECK (TaxClass IN ('EQUITY','DEBT','OTHER')),
  Status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','MERGED','CLOSED')),
  Notes          TEXT,
  CreatedOn      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn      TEXT,
  UNIQUE (AMCName, FundName)
);

CREATE TABLE MutualFundPlan (
  MutualFundPlanId   INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundId       INTEGER NOT NULL REFERENCES MutualFund(MutualFundId),
  PlanType           TEXT NOT NULL CHECK (PlanType IN ('DIRECT','REGULAR')),
  OptionType         TEXT NOT NULL CHECK (OptionType IN ('GROWTH','IDCW_PAYOUT','IDCW_REINVEST')),
  SchemeCode         TEXT,
  ISIN               TEXT,
  ISINReinvest       TEXT,
  ExpenseRatioBps    INTEGER,          -- 0.65% -> 6500 (hundredths of a basis point)
  ExitLoad           TEXT,
  ExitLoadDays       INTEGER,
  ExitLoadPercentBps INTEGER,          -- 1% -> 10000
  PurchaseAllowed    INTEGER NOT NULL DEFAULT 1 CHECK (PurchaseAllowed IN (0,1)),
  RedemptionAllowed  INTEGER NOT NULL DEFAULT 1 CHECK (RedemptionAllowed IN (0,1)),
  Status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','MERGED','CLOSED')),
  CreatedOn          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn          TEXT,
  UNIQUE (MutualFundId, PlanType, OptionType)
);
CREATE UNIQUE INDEX UX_MutualFundPlan_SchemeCode ON MutualFundPlan(SchemeCode) WHERE SchemeCode IS NOT NULL;
CREATE UNIQUE INDEX UX_MutualFundPlan_ISIN       ON MutualFundPlan(ISIN)       WHERE ISIN IS NOT NULL;

CREATE TABLE InvestmentAccount (
  InvestmentAccountId INTEGER PRIMARY KEY AUTOINCREMENT,
  PersonId            INTEGER NOT NULL REFERENCES Persons(PersonId),
  AccountName         TEXT NOT NULL,
  PlatformName        TEXT,
  AccountNumber       TEXT,
  HolderName          TEXT,
  LinkedBankAccountId INTEGER REFERENCES Accounts(AccountId),
  LoginId_Enc         TEXT,
  Password_Enc        TEXT,
  AssetClass          TEXT NOT NULL DEFAULT 'MF' CHECK (AssetClass IN ('MF','EQUITY','BOND','MIXED')),
  Status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','CLOSED')),
  Notes               TEXT,
  CreatedOn           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn           TEXT
);

CREATE TABLE MFFolio (
  FolioId             INTEGER PRIMARY KEY AUTOINCREMENT,
  InvestmentAccountId INTEGER NOT NULL REFERENCES InvestmentAccount(InvestmentAccountId),
  AMCName             TEXT NOT NULL,
  FolioNumber         TEXT NOT NULL,
  ModeOfHolding       TEXT NOT NULL DEFAULT 'SINGLE' CHECK (ModeOfHolding IN ('SINGLE','JOINT','ANYONE_OR_SURVIVOR')),
  BankAccountId       INTEGER REFERENCES Accounts(AccountId),
  Status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','CLOSED')),
  Notes               TEXT,
  CreatedOn           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn           TEXT,
  UNIQUE (AMCName, FolioNumber)
);

CREATE TABLE MFFolioPerson (
  FolioPersonId  INTEGER PRIMARY KEY AUTOINCREMENT,
  FolioId        INTEGER NOT NULL REFERENCES MFFolio(FolioId) ON DELETE CASCADE,
  PersonId       INTEGER NOT NULL REFERENCES Persons(PersonId),
  Role           TEXT NOT NULL CHECK (Role IN ('PRIMARY','JOINT','NOMINEE','GUARDIAN')),
  SharePercent   TEXT,
  UNIQUE (FolioId, PersonId, Role)
);

CREATE TABLE SIP (
  SIPId               INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundPlanId    INTEGER NOT NULL REFERENCES MutualFundPlan(MutualFundPlanId),
  InvestmentAccountId INTEGER NOT NULL REFERENCES InvestmentAccount(InvestmentAccountId),
  FolioId             INTEGER REFERENCES MFFolio(FolioId),
  SIPAmount           INTEGER NOT NULL CHECK (SIPAmount > 0),
  Frequency           TEXT NOT NULL CHECK (Frequency IN ('DAILY','WEEKLY','FORTNIGHTLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY')),
  SIPDate             INTEGER CHECK (SIPDate BETWEEN 1 AND 31),
  StartDate           TEXT NOT NULL,
  EndDate             TEXT,
  StepUpPercentBps    INTEGER,
  StepUpFrequency     TEXT CHECK (StepUpFrequency IN ('YEARLY','HALF_YEARLY')),
  AutoDebit           INTEGER NOT NULL DEFAULT 1 CHECK (AutoDebit IN (0,1)),
  MandateReference    TEXT,
  DebitBankAccountId  INTEGER REFERENCES Accounts(AccountId),
  Status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (Status IN ('ACTIVE','PAUSED','STOPPED','COMPLETED')),
  PausedUntil         TEXT,
  Notes               TEXT,
  CreatedOn           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn           TEXT
);
CREATE INDEX IX_SIP_Status ON SIP(Status);

-- Audit of SIP status / amount changes (spec §7).
CREATE TABLE SIPHistory (
  SIPHistoryId  INTEGER PRIMARY KEY AUTOINCREMENT,
  SIPId         INTEGER NOT NULL REFERENCES SIP(SIPId) ON DELETE CASCADE,
  ChangedOn     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  Action        TEXT NOT NULL,       -- CREATED / PAUSED / RESUMED / STOPPED / AMOUNT_CHANGED / EDITED
  Details       TEXT
);

CREATE TABLE MFImportBatch (
  ImportBatchId INTEGER PRIMARY KEY AUTOINCREMENT,
  Source        TEXT NOT NULL CHECK (Source IN ('CAS_IMPORT','CSV_IMPORT')),
  FileName      TEXT NOT NULL,
  ImportedOn    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  RowCount      INTEGER NOT NULL DEFAULT 0,
  SkippedCount  INTEGER NOT NULL DEFAULT 0,
  UndoneOn      TEXT,
  Notes         TEXT
);

-- Column mapping for platform CSV exports, saved per platform name.
CREATE TABLE MFImportMapping (
  ImportMappingId INTEGER PRIMARY KEY AUTOINCREMENT,
  PlatformName    TEXT NOT NULL UNIQUE,
  MappingJson     TEXT NOT NULL,
  UpdatedOn       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE MFTransaction (
  TransactionId        INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundPlanId     INTEGER NOT NULL REFERENCES MutualFundPlan(MutualFundPlanId),
  InvestmentAccountId  INTEGER NOT NULL REFERENCES InvestmentAccount(InvestmentAccountId),
  FolioId              INTEGER REFERENCES MFFolio(FolioId),
  SIPId                INTEGER REFERENCES SIP(SIPId) ON DELETE SET NULL,
  TransactionDate      TEXT NOT NULL,
  TransactionType      TEXT NOT NULL CHECK (TransactionType IN (
                          'PURCHASE','SIP','REDEMPTION','SWITCH_IN','SWITCH_OUT',
                          'IDCW_PAYOUT','IDCW_REINVEST','BONUS',
                          'TRANSFER_IN','TRANSFER_OUT')),
  NAV                  INTEGER,
  Units                INTEGER NOT NULL DEFAULT 0 CHECK (Units >= 0),
  Amount               INTEGER NOT NULL DEFAULT 0 CHECK (Amount >= 0),
  STT                  INTEGER NOT NULL DEFAULT 0,
  StampDuty            INTEGER NOT NULL DEFAULT 0,
  ExitLoad             INTEGER NOT NULL DEFAULT 0,
  TDS                  INTEGER NOT NULL DEFAULT 0,
  OtherCharges         INTEGER NOT NULL DEFAULT 0,
  TotalAmount          INTEGER NOT NULL,
  SwitchGroupId        TEXT,
  FolioNumber          TEXT,
  TransactionReference TEXT,
  -- SET NULL so deleting/undoing a bank entry never fails on this link.
  BankTransactionId    INTEGER REFERENCES Transactions(TransactionId) ON DELETE SET NULL,
  Source               TEXT NOT NULL DEFAULT 'MANUAL' CHECK (Source IN ('MANUAL','CAS_IMPORT','CSV_IMPORT','SIP_AUTO')),
  ImportBatchId        INTEGER REFERENCES MFImportBatch(ImportBatchId),
  Remarks              TEXT,
  CreatedOn            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UpdatedOn            TEXT,
  CHECK (NAV IS NOT NULL OR TransactionType = 'IDCW_PAYOUT')
);
CREATE INDEX IX_MFTransaction_Fund    ON MFTransaction(MutualFundPlanId, TransactionDate);
CREATE INDEX IX_MFTransaction_Account ON MFTransaction(InvestmentAccountId, TransactionDate);
CREATE INDEX IX_MFTransaction_Folio   ON MFTransaction(FolioId, TransactionDate);
CREATE INDEX IX_MFTransaction_SIP     ON MFTransaction(SIPId);
CREATE INDEX IX_MFTransaction_Switch  ON MFTransaction(SwitchGroupId);
CREATE INDEX IX_MFTransaction_Batch   ON MFTransaction(ImportBatchId);

-- UNIQUE (plan, date) already provides the (plan, date) index.
CREATE TABLE MFNAVHistory (
  NAVId             INTEGER PRIMARY KEY AUTOINCREMENT,
  MutualFundPlanId  INTEGER NOT NULL REFERENCES MutualFundPlan(MutualFundPlanId) ON DELETE CASCADE,
  NAVDate           TEXT NOT NULL,
  NAV               INTEGER NOT NULL,
  Source            TEXT NOT NULL DEFAULT 'AMFI' CHECK (Source IN ('AMFI','MANUAL','TRANSACTION','MFAPI')),
  CreatedOn         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (MutualFundPlanId, NAVDate)
);

-- Holdings are always derived from transactions (no holdings table).
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

INSERT INTO LookupValues (Category, Code, Label, SortOrder) VALUES
  ('InvestmentPlatform', 'Groww', 'Groww', 1),
  ('InvestmentPlatform', 'ZerodhaCoin', 'Zerodha Coin', 2),
  ('InvestmentPlatform', 'MFCentral', 'MF Central', 3),
  ('InvestmentPlatform', 'Kuvera', 'Kuvera', 4),
  ('InvestmentPlatform', 'PaytmMoney', 'Paytm Money', 5),
  ('InvestmentPlatform', 'ETMoney', 'ET Money', 6),
  ('InvestmentPlatform', 'INDmoney', 'INDmoney', 7),
  ('InvestmentPlatform', 'Bank', 'Bank', 8),
  ('InvestmentPlatform', 'AMCDirect', 'AMC direct', 9),
  ('InvestmentPlatform', 'Distributor', 'Distributor / advisor', 10),
  ('InvestmentPlatform', 'Other', 'Other', 99);

-- Default capital-gains rules (editable in Settings). Rates in percent; amounts in paise;
-- regimes apply by SALE date. Verify with your CA.
INSERT INTO AppSettings (Key, Value, UpdatedOn) VALUES ('MFTaxRules', json('{
  "version": 1,
  "note": "Defaults per the Income-tax Act as amended by the Finance (No. 2) Act, 2024. Indexation is not applied. Verify with your CA.",
  "categoryClass": { "Equity": "EQUITY", "Debt": "DEBT", "Hybrid": "OTHER", "Solution Oriented": "OTHER", "Other": "OTHER" },
  "subCategoryClass": { "Aggressive Hybrid": "EQUITY", "Arbitrage": "EQUITY", "Balanced Advantage": "EQUITY", "Dynamic Asset Allocation": "EQUITY", "Equity Savings": "EQUITY", "Index Funds": "EQUITY", "ELSS": "EQUITY" },
  "equity": {
    "ltAfterMonths": 12,
    "grandfatherDate": "2018-01-31",
    "regimes": [
      { "from": "2018-04-01", "stcgRate": 15, "ltcgRate": 10, "ltcgExemption": 10000000 },
      { "from": "2024-07-23", "stcgRate": 20, "ltcgRate": 12.5, "ltcgExemption": 12500000 }
    ]
  },
  "debt": {
    "alwaysShortTermIfBoughtFrom": "2023-04-01",
    "regimes": [
      { "from": "2018-04-01", "ltAfterMonths": 36, "ltcgRate": 20 },
      { "from": "2024-07-23", "ltAfterMonths": 24, "ltcgRate": 12.5 }
    ]
  },
  "other": {
    "regimes": [
      { "from": "2018-04-01", "ltAfterMonths": 36, "ltcgRate": 20 },
      { "from": "2024-07-23", "ltAfterMonths": 24, "ltcgRate": 12.5 }
    ]
  }
}'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
