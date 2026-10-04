-- Phase 1: family, banks, accounts, credentials, transactions, statement import.

CREATE TABLE Persons (
  PersonId INTEGER PRIMARY KEY AUTOINCREMENT,
  FirstName TEXT NOT NULL, LastName TEXT,
  Relationship TEXT NOT NULL,            -- Lookup: Relationship
  DateOfBirth TEXT, Gender TEXT,
  Email TEXT, Phone TEXT, Address TEXT,
  PAN_Enc TEXT, Aadhaar_Enc TEXT,        -- field-encrypted
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
  AccountType TEXT NOT NULL,             -- Lookup: AccountType
  AccountNumber_Enc TEXT NOT NULL, AccountNumberLast4 TEXT,
  CustomerId TEXT,
  OpenedOn TEXT, MaturityDate TEXT,
  InterestRate TEXT,                     -- decimal as text, e.g. "7.10"
  OpeningBalance INTEGER NOT NULL DEFAULT 0,   -- paise
  OpeningBalanceDate TEXT,
  DebitCardLast4 TEXT,
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL, IsActive INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IX_Accounts_Bank ON Accounts(BankId);

CREATE TABLE AccountPersons (
  AccountPersonId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId) ON DELETE CASCADE,
  PersonId INTEGER NOT NULL REFERENCES Persons(PersonId),
  Role TEXT NOT NULL,                    -- Primary, Joint, Nominee, Guardian
  SharePercent TEXT,
  UNIQUE (AccountId, PersonId, Role)
);
CREATE INDEX IX_AccountPersons_Person ON AccountPersons(PersonId);

CREATE TABLE AccountCredentials (
  CredentialId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId) ON DELETE CASCADE,
  Channel TEXT NOT NULL,                 -- NetBanking, MobileApp, UPI, PhoneBanking
  LoginId_Enc TEXT, Password_Enc TEXT, MPIN_Enc TEXT, TxnPassword_Enc TEXT,
  LastChangedOn TEXT,
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL, IsActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE SecurityQuestions (
  SecurityQuestionId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId) ON DELETE CASCADE,
  Question TEXT NOT NULL, Answer_Enc TEXT NOT NULL,
  SortOrder INTEGER NOT NULL DEFAULT 0,
  CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL
);

CREATE TABLE Categories (
  CategoryId INTEGER PRIMARY KEY AUTOINCREMENT,
  Name TEXT NOT NULL, ParentCategoryId INTEGER REFERENCES Categories(CategoryId),
  Kind TEXT NOT NULL,                    -- Income, Expense, Transfer, Investment
  IsActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ImportBatches (
  ImportBatchId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId),
  FileName TEXT NOT NULL,
  ImportedOn TEXT NOT NULL,
  RowCount INTEGER NOT NULL DEFAULT 0,
  SkippedCount INTEGER NOT NULL DEFAULT 0,
  UndoneOn TEXT,
  Notes TEXT
);

-- Column mapping for statement import, saved per bank.
CREATE TABLE ImportMappings (
  ImportMappingId INTEGER PRIMARY KEY AUTOINCREMENT,
  BankId INTEGER NOT NULL UNIQUE REFERENCES Banks(BankId),
  MappingJson TEXT NOT NULL,
  UpdatedOn TEXT NOT NULL
);

CREATE TABLE Transactions (
  TransactionId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId),
  TxnDate TEXT NOT NULL, TxnTime TEXT,
  Description TEXT NOT NULL,
  DebitAmount INTEGER NOT NULL DEFAULT 0,      -- paise
  CreditAmount INTEGER NOT NULL DEFAULT 0,     -- paise
  Mode TEXT,                             -- Lookup: TxnMode
  ReferenceNo TEXT, CounterParty TEXT,
  CategoryId INTEGER REFERENCES Categories(CategoryId),
  TransferGroupId TEXT,                  -- links both legs of a self-transfer
  LinkedEntity TEXT, LinkedEntityId INTEGER,
  ImportBatchId INTEGER REFERENCES ImportBatches(ImportBatchId),
  Notes TEXT, CreatedOn TEXT NOT NULL, UpdatedOn TEXT NOT NULL,
  CHECK (DebitAmount >= 0 AND CreditAmount >= 0 AND NOT (DebitAmount > 0 AND CreditAmount > 0))
);
CREATE INDEX IX_Transactions_Account_Date ON Transactions(AccountId, TxnDate);
CREATE INDEX IX_Transactions_TransferGroup ON Transactions(TransferGroupId);
CREATE INDEX IX_Transactions_ImportBatch ON Transactions(ImportBatchId);

-- Balance is calculated, never typed in.
CREATE VIEW vAccountBalances AS
SELECT a.AccountId,
       a.OpeningBalance + COALESCE(SUM(t.CreditAmount), 0) - COALESCE(SUM(t.DebitAmount), 0) AS CurrentBalance
FROM Accounts a LEFT JOIN Transactions t ON t.AccountId = a.AccountId
GROUP BY a.AccountId;

CREATE TABLE BalanceSnapshots (
  BalanceSnapshotId INTEGER PRIMARY KEY AUTOINCREMENT,
  AccountId INTEGER NOT NULL REFERENCES Accounts(AccountId) ON DELETE CASCADE,
  AsOfDate TEXT NOT NULL, Balance INTEGER NOT NULL, Notes TEXT
);

-- ---------------------------------------------------------------- seed lookups

INSERT INTO LookupValues (Category, Code, Label, SortOrder) VALUES
  ('Relationship', 'Self', 'Self', 1),
  ('Relationship', 'Spouse', 'Spouse', 2),
  ('Relationship', 'Son', 'Son', 3),
  ('Relationship', 'Daughter', 'Daughter', 4),
  ('Relationship', 'Father', 'Father', 5),
  ('Relationship', 'Mother', 'Mother', 6),
  ('Relationship', 'Brother', 'Brother', 7),
  ('Relationship', 'Sister', 'Sister', 8),
  ('Relationship', 'Other', 'Other', 99),
  ('Gender', 'Male', 'Male', 1),
  ('Gender', 'Female', 'Female', 2),
  ('Gender', 'Other', 'Other', 3),
  ('AccountType', 'Savings', 'Savings', 1),
  ('AccountType', 'Salary', 'Salary', 2),
  ('AccountType', 'Current', 'Current', 3),
  ('AccountType', 'FD', 'Fixed Deposit (FD)', 4),
  ('AccountType', 'RD', 'Recurring Deposit (RD)', 5),
  ('AccountType', 'PPF', 'Public Provident Fund (PPF)', 6),
  ('AccountType', 'SukanyaSamriddhi', 'Sukanya Samriddhi (SSY)', 7),
  ('AccountType', 'NRE', 'NRE', 8),
  ('AccountType', 'NRO', 'NRO', 9),
  ('AccountRole', 'Primary', 'Primary holder', 1),
  ('AccountRole', 'Joint', 'Joint holder', 2),
  ('AccountRole', 'Nominee', 'Nominee', 3),
  ('AccountRole', 'Guardian', 'Guardian', 4),
  ('CredentialChannel', 'NetBanking', 'Net banking', 1),
  ('CredentialChannel', 'MobileApp', 'Mobile app', 2),
  ('CredentialChannel', 'UPI', 'UPI', 3),
  ('CredentialChannel', 'PhoneBanking', 'Phone banking', 4),
  ('TxnMode', 'UPI', 'UPI', 1),
  ('TxnMode', 'NEFT', 'NEFT', 2),
  ('TxnMode', 'RTGS', 'RTGS', 3),
  ('TxnMode', 'IMPS', 'IMPS', 4),
  ('TxnMode', 'Cheque', 'Cheque', 5),
  ('TxnMode', 'Cash', 'Cash', 6),
  ('TxnMode', 'Card', 'Card', 7),
  ('TxnMode', 'ECS_NACH', 'ECS / NACH', 8),
  ('TxnMode', 'Interest', 'Interest', 9),
  ('TxnMode', 'Charges', 'Bank charges', 10),
  ('TxnMode', 'Other', 'Other', 99);

-- ---------------------------------------------------------------- seed categories

INSERT INTO Categories (Name, Kind) VALUES
  ('Salary', 'Income'), ('Interest', 'Income'), ('Dividend', 'Income'),
  ('Rent Received', 'Income'), ('Refund / Cashback', 'Income'), ('Other Income', 'Income'),
  ('Groceries', 'Expense'), ('Food & Dining', 'Expense'), ('Utilities', 'Expense'),
  ('Rent', 'Expense'), ('Fuel & Transport', 'Expense'), ('Shopping', 'Expense'),
  ('Medical', 'Expense'), ('Education / School Fees', 'Expense'), ('Insurance Premium', 'Expense'),
  ('Loan EMI', 'Expense'), ('Travel', 'Expense'), ('Entertainment', 'Expense'),
  ('Household', 'Expense'), ('Taxes', 'Expense'), ('Bank Charges', 'Expense'),
  ('Gifts & Donations', 'Expense'), ('Cash Withdrawal', 'Expense'), ('Other Expense', 'Expense'),
  ('Self Transfer', 'Transfer'),
  ('Mutual Fund / SIP', 'Investment'), ('PPF Deposit', 'Investment'), ('SSY Deposit', 'Investment'),
  ('FD / RD Deposit', 'Investment'), ('Shares', 'Investment'), ('Gold / Silver', 'Investment');

INSERT INTO Categories (Name, ParentCategoryId, Kind)
SELECT x.Name, c.CategoryId, 'Expense'
FROM (SELECT 'Electricity' AS Name UNION ALL SELECT 'Water' UNION ALL SELECT 'Gas'
      UNION ALL SELECT 'Internet & Mobile') x
JOIN Categories c ON c.Name = 'Utilities';
