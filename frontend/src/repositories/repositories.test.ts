import { beforeEach, describe, expect, it } from 'vitest';
import { exportDb, openDb } from '@/db/database';
import { bundledMigrations, migrate, schemaVersion } from '@/db/migrate';
import { all, getDb, run, scalar, setDb } from '@/db/sql';
import { decryptSecret, setSecretsKey } from '@/crypto/secrets';
import { parseToPaise } from '@/lib/money';
import * as accounts from './accounts';
import * as banks from './banks';
import * as dash from './dashboard';
import * as imports from './imports';
import * as persons from './persons';
import * as txns from './transactions';

const P = (s: string) => parseToPaise(s)!;

async function freshDb() {
  const db = await openDb();
  migrate(db);
  setDb(db);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  setSecretsKey(key);
  return db;
}

const BANK = {
  BankName: 'State Bank of India',
  BranchName: 'Sector 17',
  BranchAddress: '',
  IFSCCode: 'sbin0001234',
  MICRCode: '',
  SwiftCode: '',
  BranchPhone: '',
  RelationshipManager: '',
  RMPhone: '',
  CustomerCareNo: '',
  Website: '',
  Notes: '',
};

async function seed() {
  const self = await persons.createPerson({
    FirstName: 'Karan',
    Relationship: 'Self',
    PAN: 'abcde1234f',
  });
  const spouse = await persons.createPerson({ FirstName: 'Simran', Relationship: 'Spouse' });
  const kid = await persons.createPerson({
    FirstName: 'Aara',
    Relationship: 'Daughter',
    DateOfBirth: '2018-05-01',
  });
  const sbi = banks.createBank(BANK);
  const hdfc = banks.createBank({ ...BANK, BankName: 'HDFC Bank', IFSCCode: 'HDFC0000001' });
  const savings = await accounts.createAccount(
    {
      BankId: sbi,
      AccountType: 'Savings',
      AccountNumber: '1234 5678 9012',
      OpeningBalance: P('10000'),
      OpeningBalanceDate: '2026-01-01',
    },
    [
      { PersonId: self, Role: 'Primary' },
      { PersonId: spouse, Role: 'Joint' },
      { PersonId: kid, Role: 'Nominee', SharePercent: '100' },
    ],
  );
  const salary = await accounts.createAccount(
    { BankId: hdfc, AccountType: 'Salary', AccountNumber: '50100012345678', OpeningBalance: 0 },
    [{ PersonId: spouse, Role: 'Primary' }],
  );
  const ssy = await accounts.createAccount(
    {
      BankId: sbi,
      AccountType: 'SukanyaSamriddhi',
      AccountNumber: 'SSY998877',
      OpeningBalance: P('50000'),
      MaturityDate: '2039-05-01',
    },
    [
      { PersonId: kid, Role: 'Primary' },
      { PersonId: self, Role: 'Guardian' },
    ],
  );
  return { self, spouse, kid, sbi, hdfc, savings, salary, ssy };
}

describe('migrations', () => {
  it('apply cleanly, are idempotent, and survive export/reopen', async () => {
    const db = await openDb();
    const applied = migrate(db);
    expect(applied).toEqual(bundledMigrations().map((m) => m.version));
    expect(migrate(db)).toEqual([]);
    const reopened = await openDb(exportDb(db));
    expect(schemaVersion(reopened)).toBe(applied[applied.length - 1]);
    expect(reopened.exec('PRAGMA foreign_keys')[0].values[0][0]).toBe(1);
  });

  it('rolls back a failing migration', async () => {
    const db = await openDb();
    expect(() =>
      migrate(db, [
        { version: 1, name: 'ok', sql: 'CREATE TABLE A (x INTEGER);' },
        {
          version: 2,
          name: 'bad',
          sql: 'CREATE TABLE B (y INTEGER); INSERT INTO Nope VALUES (1);',
        },
      ]),
    ).toThrow(/002|2_bad/);
    expect(schemaVersion(db)).toBe(1);
    expect(db.exec("SELECT name FROM sqlite_master WHERE name = 'B'")).toEqual([]);
  });

  it('refuses a vault newer than the app', async () => {
    const db = await openDb();
    migrate(db, [{ version: 99, name: 'future', sql: 'SELECT 1;' }]);
    expect(() => migrate(db)).toThrow(/newer/);
  });

  it('foreign keys enforced', async () => {
    await freshDb();
    expect(() =>
      txns.createTransaction({
        AccountId: 999,
        TxnDate: '2026-01-01',
        Description: 'x',
        Amount: 1,
        Direction: 'Debit',
      }),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('persons, banks, accounts', () => {
  beforeEach(freshDb);

  it('encrypts PAN and account numbers', async () => {
    const s = await seed();
    const p = persons.getPerson(s.self)!;
    expect(p.PAN_Enc).toMatch(/^s1:/);
    expect(await decryptSecret(p.PAN_Enc!)).toBe('ABCDE1234F');
    const a = accounts.getAccount(s.savings)!;
    expect(a.AccountNumberLast4).toBe('9012');
    expect(await decryptSecret(a.AccountNumber_Enc)).toBe('123456789012');
    expect(banks.getBank(s.sbi)!.IFSCCode).toBe('SBIN0001234');
    // No plaintext secrets anywhere in the DB file.
    const raw = new TextDecoder().decode(exportDb(getDb()));
    expect(raw).not.toContain('ABCDE1234F');
    expect(raw).not.toContain('123456789012');
  });

  it('holders: one primary required, nominee shares ≤ 100%', async () => {
    const s = await seed();
    expect(() =>
      accounts.setAccountPersons(s.savings, [{ PersonId: s.self, Role: 'Joint' }]),
    ).toThrow(/primary/);
    expect(() =>
      accounts.setAccountPersons(s.savings, [
        { PersonId: s.self, Role: 'Primary' },
        { PersonId: s.kid, Role: 'Nominee', SharePercent: '60' },
        { PersonId: s.spouse, Role: 'Nominee', SharePercent: '50' },
      ]),
    ).toThrow(/100%/);
    const list = accounts.listAccountPersons(s.savings);
    expect(list.map((h) => h.Role)).toEqual(['Primary', 'Joint', 'Nominee']);
    expect(accounts.getAccount(s.savings)!.Holders).toBe('Karan, Simran');
  });

  it('list by person includes joint and guardian accounts', async () => {
    const s = await seed();
    expect(
      accounts
        .listAccounts({ personId: s.self })
        .map((a) => a.AccountId)
        .sort(),
    ).toEqual([s.savings, s.ssy].sort());
  });
});

describe('transactions & balances', () => {
  beforeEach(freshDb);

  it('balance = opening + credits - debits, running balance per account', async () => {
    const s = await seed();
    txns.createTransaction({
      AccountId: s.savings,
      TxnDate: '2026-01-05',
      Description: 'Groceries',
      Amount: P('1500.50'),
      Direction: 'Debit',
    });
    txns.createTransaction({
      AccountId: s.savings,
      TxnDate: '2026-01-03',
      Description: 'Interest',
      Amount: P('120.25'),
      Direction: 'Credit',
    });
    txns.createTransaction({
      AccountId: s.savings,
      TxnDate: '2026-01-07',
      Description: 'Rent',
      Amount: P('2000'),
      Direction: 'Debit',
    });
    expect(accounts.getAccount(s.savings)!.CurrentBalance).toBe(P('6619.75'));
    const rows = txns.listTransactions({ accountId: s.savings });
    expect(rows.map((r) => r.Description)).toEqual(['Rent', 'Groceries', 'Interest']);
    expect(rows.map((r) => r.RunningBalance)).toEqual([P('6619.75'), P('8619.75'), P('10120.25')]);
    // Filtering keeps running balance correct.
    expect(txns.listTransactions({ accountId: s.savings, search: 'groc' })[0].RunningBalance).toBe(
      P('8619.75'),
    );
    expect(accounts.balanceAsOf(s.savings, '2026-01-05')).toBe(P('8619.75'));
  });

  it('rejects debit and credit on the same row', async () => {
    const s = await seed();
    expect(() =>
      run(
        `INSERT INTO Transactions (AccountId, TxnDate, Description, DebitAmount, CreditAmount, CreatedOn, UpdatedOn)
         VALUES (?, '2026-01-01', 'x', 1, 1, '', '')`,
        [s.savings],
      ),
    ).toThrow(/CHECK/);
  });

  it('self-transfer creates linked legs; edit and delete affect both', async () => {
    const s = await seed();
    txns.createTransfer({
      FromAccountId: s.savings,
      ToAccountId: s.salary,
      Amount: P('2500'),
      TxnDate: '2026-02-01',
      Description: 'Move',
    });
    const [leg] = txns.listTransactions({ accountId: s.salary });
    expect(leg.CreditAmount).toBe(P('2500'));
    expect(leg.OtherAccountLabel).toContain('State Bank of India');
    expect(leg.CategoryKind).toBe('Transfer');
    txns.updateTransaction(leg.TransactionId, {
      AccountId: s.salary,
      TxnDate: '2026-02-02',
      Description: 'Move 2',
      Amount: P('3000'),
      Direction: 'Credit',
    });
    expect(accounts.getAccount(s.savings)!.CurrentBalance).toBe(P('7000'));
    expect(accounts.getAccount(s.salary)!.CurrentBalance).toBe(P('3000'));
    // Transfers are excluded from income/expense.
    expect(dash.incomeExpense('2026-01-01', '2026-12-31')).toEqual({
      Income: 0,
      Expense: 0,
      Invested: 0,
    });
    txns.deleteTransaction(leg.TransactionId);
    expect(scalar('SELECT COUNT(*) FROM Transactions')).toBe(0);
  });

  it('dashboard totals by person and bank', async () => {
    const s = await seed();
    txns.createTransaction({
      AccountId: s.salary,
      TxnDate: '2026-01-31',
      Description: 'Salary',
      Amount: P('80000'),
      Direction: 'Credit',
    });
    const byPerson = dash.balanceByPerson();
    expect(byPerson.find((r) => r.Id === s.spouse)!.Total).toBe(P('80000'));
    expect(byPerson.find((r) => r.Id === s.kid)!.Total).toBe(P('50000'));
    expect(dash.totalBankBalance()).toBe(P('140000'));
    expect(dash.balanceByBank().find((b) => b.Name === 'State Bank of India')!.Total).toBe(
      P('60000'),
    );
    expect(dash.upcomingMaturities()[0].MaturityDate).toBe('2039-05-01');
  });
});

describe('statement import', () => {
  beforeEach(freshDb);

  const grid: imports.Grid = [
    ['State Bank of India', null, null, null, null, null],
    ['Account statement', null, null, null, null, null],
    ['Txn Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
    ['10/01/2026', 'UPI/ZOMATO', 'UPI001', '450.00', '', '9,550.00'],
    ['12/01/2026', 'NEFT SALARY ACME', 'N123', '', '50,000.00', '59,550.00'],
    ['12/01/2026', 'ATM WDL', '', '2,000.00', '', '57,550.00'],
    ['', '', '', '', '', ''],
    ['Closing balance', '', '', '', '', '57,550.00'],
  ];

  it('guesses header and mapping, parses rows', () => {
    const h = imports.guessHeaderRow(grid);
    expect(h).toBe(2);
    const g = imports.guessMapping(grid[h]);
    expect(g).toMatchObject({
      dateCol: 0,
      descCol: 1,
      refCol: 2,
      amountMode: 'split',
      debitCol: 3,
      creditCol: 4,
      balanceCol: 5,
    });
    const m = {
      ...g,
      headerRow: h,
      dateFormat: imports.sampleDateFormat(grid, { headerRow: h, dateCol: 0 }),
    } as imports.ImportMapping;
    const rows = imports.applyMapping(grid, m);
    expect(rows).toHaveLength(3); // footer without date and amount dropped
    expect(rows[1]).toMatchObject({
      date: '2026-01-12',
      credit: P('50000'),
      debit: 0,
      ref: 'N123',
    });
    expect(imports.statementClosing(rows)).toEqual({ date: '2026-01-12', balance: P('57550') });
  });

  it('imports, detects duplicates on re-import, reconciles, and undoes', async () => {
    const s = await seed();
    const m = {
      ...imports.guessMapping(grid[2]),
      headerRow: 2,
      dateFormat: 'DD/MM/YYYY',
    } as imports.ImportMapping;
    const rows = imports.markDuplicates(
      s.savings,
      imports.chronological(imports.applyMapping(grid, m)),
    );
    expect(rows.every((r) => !r.duplicate)).toBe(true);
    const batch = imports.commitImport(s.savings, 'jan.csv', rows, { recordSnapshot: true });
    // Opening 10,000 - 450 + 50,000 - 2,000 = 57,550 — matches statement.
    expect(accounts.getAccount(s.savings)!.CurrentBalance).toBe(P('57550'));
    const [snap] = accounts.listSnapshots(s.savings);
    expect(snap.Balance).toBe(snap.ComputedBalance);

    const again = imports.markDuplicates(s.savings, imports.applyMapping(grid, m));
    expect(again.filter((r) => r.duplicate)).toHaveLength(3);

    imports.undoImport(batch);
    expect(accounts.getAccount(s.savings)!.CurrentBalance).toBe(P('10000'));
    expect(imports.listImportBatches(s.savings)[0].UndoneOn).not.toBeNull();
  });

  it('newest-first statements are reversed; Dr/Cr column mode', async () => {
    const g2: imports.Grid = [
      ['Date', 'Narration', 'Amount', 'Dr/Cr'],
      ['05-Feb-2026', 'B', '100', 'DR'],
      ['01-Feb-2026', 'A', '300', 'CR'],
      ['02-Feb-2026', 'C', '50', 'X'],
    ];
    const gm = imports.guessMapping(g2[0]);
    expect(gm).toMatchObject({ amountMode: 'drcr', amountCol: 2, drcrCol: 3 });
    const rows = imports.chronological(
      imports.applyMapping(g2, {
        ...gm,
        headerRow: 0,
        dateFormat: 'DD-MMM-YYYY',
      } as imports.ImportMapping),
    );
    expect(rows.map((r) => r.description)).toEqual(['C', 'A', 'B']);
    expect(rows[0].error).toMatch(/Dr\/Cr/);
    expect(rows[2].debit).toBe(10000);
  });

  it('saves mapping per bank', async () => {
    const s = await seed();
    const m: imports.ImportMapping = {
      headerRow: 2,
      dateCol: 0,
      dateFormat: 'DD/MM/YYYY',
      descCol: 1,
      amountMode: 'split',
      debitCol: 3,
      creditCol: 4,
    };
    imports.saveMapping(s.sbi, m);
    imports.saveMapping(s.sbi, { ...m, headerRow: 3 });
    expect(imports.getSavedMapping(s.sbi)!.headerRow).toBe(3);
    expect(all('SELECT * FROM ImportMappings')).toHaveLength(1);
  });
});
