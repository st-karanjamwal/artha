import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@/db/database';
import { bundledMigrations, migrate } from '@/db/migrate';
import { all, one, scalar, setDb } from '@/db/sql';
import { setSecretsKey } from '@/crypto/secrets';
import { parseMicro } from '@/lib/units';
import { parseAmfiNav, searchSchemes } from '@/features/mf/amfi';
import { parseCasLines } from '@/features/mf/cas';
import amfiFixture from '@/features/mf/__fixtures__/NAVAll.sample.txt?raw';
import casFixture from '@/features/mf/__fixtures__/cas-sample.txt?raw';
import * as persons from './persons';
import * as banks from './banks';
import * as accounts from './accounts';
import * as funds from './mfFunds';
import * as mfa from './mfAccounts';
import * as mft from './mfTransactions';
import * as nav from './mfNav';
import * as sips from './sips';
import * as pf from './mfPortfolio';
import * as imp from './mfImport';

const U = (s: string) => parseMicro(s)!; // units / NAV → micro
const P = (rupees: number) => Math.round(rupees * 100);

async function freshDb() {
  const db = await openDb();
  migrate(db);
  setDb(db);
  setSecretsKey(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  );
  return db;
}

async function seedBasics() {
  const self = await persons.createPerson({
    FirstName: 'Karan',
    Relationship: 'Self',
    DateOfBirth: '1986-03-12',
  });
  const spouse = await persons.createPerson({ FirstName: 'Simran', Relationship: 'Spouse' });
  const kid = await persons.createPerson({
    FirstName: 'Aara',
    Relationship: 'Daughter',
    DateOfBirth: '2018-05-01',
  });
  const acc = await mfa.createInvestmentAccount({
    PersonId: self,
    AccountName: 'Karan – Groww',
    PlatformName: 'Groww',
  });
  const fundIds = [1, 2, 3].map((i) =>
    funds.createFund({
      AMCName: `AMC ${i}`,
      FundName: `Fund ${i}`,
      Category: i === 3 ? 'Hybrid' : 'Equity',
      SubCategory: i === 3 ? 'Aggressive Hybrid' : 'Flexi Cap',
    }),
  );
  const planIds = fundIds.map((f, i) =>
    funds.createPlan(f, {
      PlanType: 'DIRECT',
      OptionType: 'GROWTH',
      SchemeCode: `SCHEME00${i + 1}`,
      ISIN: `INF00000000${i + 1}`,
    }),
  );
  return { self, spouse, kid, acc, planIds };
}

describe('migration 003', () => {
  it('upgrades a Phase 1 database without data loss', async () => {
    const db = await openDb();
    const phase1 = bundledMigrations().filter((m) => m.version <= 2);
    migrate(db, phase1);
    setDb(db);
    setSecretsKey(
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]),
    );
    const pid = await persons.createPerson({ FirstName: 'Karan', Relationship: 'Self' });
    const bid = banks.createBank({
      BankName: 'SBI',
      BranchName: '',
      BranchAddress: '',
      IFSCCode: '',
      MICRCode: '',
      SwiftCode: '',
      BranchPhone: '',
      RelationshipManager: '',
      RMPhone: '',
      CustomerCareNo: '',
      Website: '',
      Notes: '',
    });
    const aid = await accounts.createAccount(
      { BankId: bid, AccountType: 'Savings', AccountNumber: '123456', OpeningBalance: 500000 },
      [{ PersonId: pid, Role: 'Primary' }],
    );
    expect(migrate(db)).toEqual([3]);
    expect(accounts.getAccount(aid)!.CurrentBalance).toBe(500000);
    expect(scalar('SELECT COUNT(*) FROM Persons')).toBe(1);
    expect(scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'MFTransaction'")).toBe(1);
    expect(pf.getTaxRules().equity.ltAfterMonths).toBe(12);
  });
});

describe('transactions & holdings', () => {
  beforeEach(freshDb);

  it('buy → partial redeem → switch → bonus → IDCW reinvest gives expected units', async () => {
    const { acc, planIds } = await seedBasics();
    const [p1, p2] = planIds;
    const folio = mfa.createFolio({
      InvestmentAccountId: acc,
      AMCName: 'AMC 1',
      FolioNumber: '111 / 1',
    });
    const folio2 = mfa.createFolio({
      InvestmentAccountId: acc,
      AMCName: 'AMC 2',
      FolioNumber: '222',
    });
    const base = { InvestmentAccountId: acc, FolioId: folio, MutualFundPlanId: p1 };
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2026-01-10',
      TransactionType: 'PURCHASE',
      NAV: U('100'),
      Units: U('100'),
      Amount: P(10000),
    });
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2026-02-10',
      TransactionType: 'REDEMPTION',
      NAV: U('110'),
      Units: U('30'),
      Amount: P(3300),
      STT: 3,
    });
    mft.createSwitch({
      InvestmentAccountId: acc,
      TransactionDate: '2026-03-10',
      FromPlanId: p1,
      FromFolioId: folio,
      OutUnits: U('20'),
      OutNAV: U('120'),
      OutAmount: P(2400),
      ToPlanId: p2,
      ToFolioId: folio2,
      InUnits: U('48'),
      InNAV: U('50'),
      InAmount: P(2399.88),
      StampDuty: 12,
    });
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2026-04-10',
      TransactionType: 'BONUS',
      NAV: U('120'),
      Units: U('5'),
      Amount: 0,
    });
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2026-05-10',
      TransactionType: 'IDCW_REINVEST',
      NAV: U('125'),
      Units: U('1.234'),
      Amount: P(154.25),
    });
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2026-05-10',
      TransactionType: 'IDCW_PAYOUT',
      Units: 0,
      Amount: P(100),
      TDS: P(10),
    });

    expect(mft.unitsHeld(acc, folio, p1)).toBe(U('56.234')); // 100 − 30 − 20 + 5 + 1.234
    expect(mft.unitsHeld(acc, folio2, p2)).toBe(U('48'));
    const view = all<{ MutualFundPlanId: number; UnitsHeld: number }>(
      'SELECT MutualFundPlanId, UnitsHeld FROM vMFHoldings ORDER BY MutualFundPlanId',
    );
    expect(view).toEqual([
      { MutualFundPlanId: p1, UnitsHeld: U('56.234') },
      { MutualFundPlanId: p2, UnitsHeld: U('48') },
    ]);
    // Bank cash flows per spec §5
    const rows = mft.listMFTransactions({ planId: p1 });
    const byType = Object.fromEntries(rows.map((r) => [r.TransactionType, r.TotalAmount]));
    expect(byType).toMatchObject({
      PURCHASE: P(10000),
      REDEMPTION: P(3300) - 3,
      SWITCH_OUT: 0,
      BONUS: 0,
      IDCW_REINVEST: 0,
      IDCW_PAYOUT: P(90),
    });
    // Switch legs are linked; deleting one deletes both.
    const sw = rows.find((r) => r.TransactionType === 'SWITCH_OUT')!;
    expect(
      all('SELECT 1 FROM MFTransaction WHERE SwitchGroupId = ?', [sw.SwitchGroupId]),
    ).toHaveLength(2);
    // NAVs from transactions land in history.
    expect(nav.navOn(p1, '2026-02-10')?.NAV).toBe(U('110'));
  });

  it('cannot redeem more units than held in that folio on that date', async () => {
    const { acc, planIds } = await seedBasics();
    const folio = mfa.createFolio({ InvestmentAccountId: acc, AMCName: 'AMC 1', FolioNumber: '1' });
    const base = { InvestmentAccountId: acc, FolioId: folio, MutualFundPlanId: planIds[0] };
    const buy = mft.createMFTransaction({
      ...base,
      TransactionDate: '2026-03-01',
      TransactionType: 'PURCHASE',
      NAV: U('10'),
      Units: U('10'),
      Amount: P(100),
    });
    // Before the purchase date
    expect(() =>
      mft.createMFTransaction({
        ...base,
        TransactionDate: '2026-02-28',
        TransactionType: 'REDEMPTION',
        NAV: U('10'),
        Units: U('1'),
        Amount: P(10),
      }),
    ).toThrow(/Not enough units/);
    // More than held
    expect(() =>
      mft.createMFTransaction({
        ...base,
        TransactionDate: '2026-03-02',
        TransactionType: 'REDEMPTION',
        NAV: U('10'),
        Units: U('10.001'),
        Amount: P(100.01),
      }),
    ).toThrow(/Not enough units/);
    // Other folio does not count
    const other = mfa.createFolio({ InvestmentAccountId: acc, AMCName: 'AMC 1', FolioNumber: '2' });
    expect(() =>
      mft.createMFTransaction({
        ...base,
        FolioId: other,
        TransactionDate: '2026-03-02',
        TransactionType: 'REDEMPTION',
        NAV: U('10'),
        Units: U('1'),
        Amount: P(10),
      }),
    ).toThrow(/Not enough units/);
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2026-03-02',
      TransactionType: 'REDEMPTION',
      NAV: U('10'),
      Units: U('10'),
      Amount: P(100),
    });
    // Deleting the purchase would break the later redemption
    expect(() => mft.deleteMFTransaction(buy)).toThrow(/Not enough units/);
  });

  it('IDCW payout may have no NAV; NAV required otherwise', async () => {
    const { acc, planIds } = await seedBasics();
    expect(() =>
      mft.createMFTransaction({
        InvestmentAccountId: acc,
        MutualFundPlanId: planIds[0],
        TransactionDate: '2026-01-01',
        TransactionType: 'PURCHASE',
        Units: U('1'),
        Amount: 100,
      }),
    ).toThrow(/NAV/);
    expect(() =>
      mft.createMFTransaction({
        InvestmentAccountId: acc,
        MutualFundPlanId: planIds[0],
        TransactionDate: '2026-01-01',
        TransactionType: 'IDCW_PAYOUT',
        Units: 0,
        Amount: 100,
      }),
    ).not.toThrow();
  });

  it('folio needs a guardian when the primary holder is a minor', async () => {
    const { kid, self, acc } = await seedBasics();
    expect(() => mfa.validateFolioPersons([{ PersonId: kid, Role: 'PRIMARY' }])).toThrow(
      /guardian/,
    );
    expect(() =>
      mfa.validateFolioPersons([
        { PersonId: kid, Role: 'PRIMARY' },
        { PersonId: self, Role: 'GUARDIAN' },
      ]),
    ).not.toThrow();
    const kidAcc = await mfa.createInvestmentAccount({
      PersonId: kid,
      AccountName: 'Aara – MF Central',
    });
    const f = mfa.createFolio(
      { InvestmentAccountId: kidAcc, AMCName: 'AMC 1', FolioNumber: 'K1' },
      [
        { PersonId: kid, Role: 'PRIMARY' },
        { PersonId: self, Role: 'GUARDIAN' },
      ],
    );
    expect(mfa.getFolio(f)!.HasGuardian).toBe(1);
    void acc;
  });
});

describe('SIPs (owner example)', () => {
  beforeEach(freshDb);

  it('3 × ₹10,000 monthly = ₹30,000/month, ₹3,60,000/year; 10 instalments → ₹1,00,000 per fund', async () => {
    const { acc, planIds } = await seedBasics();
    const sipIds = planIds.map((p) =>
      sips.createSip({
        MutualFundPlanId: p,
        InvestmentAccountId: acc,
        SIPAmount: P(10000),
        Frequency: 'MONTHLY',
        SIPDate: 10,
        StartDate: '2026-01-10',
      }),
    );
    const totals = sips.sipTotals('2026-10-12');
    expect(totals.monthly).toBe(P(30000));
    expect(totals.annual).toBe(P(360000));

    const pending = sips.pendingSipConfirmations('2026-10-12');
    expect(pending).toHaveLength(30); // Jan–Oct × 3
    for (const p of pending) {
      sips.confirmSipInstalment({
        sipId: p.sip.SIPId,
        date: p.date,
        amount: p.amount,
        nav: U('125.50'),
      });
    }
    expect(sips.pendingSipConfirmations('2026-10-12')).toHaveLength(0); // no duplicates after confirming
    for (const id of sipIds) {
      expect(
        scalar<number>('SELECT SUM(TotalAmount) FROM MFTransaction WHERE SIPId = ?', [id]),
      ).toBe(P(100000));
    }
    const units = one<{ Units: number; StampDuty: number; Amount: number }>(
      'SELECT Units, StampDuty, Amount FROM MFTransaction LIMIT 1',
    )!;
    expect(units).toEqual({ Units: 79_677_000, StampDuty: 50, Amount: 999_950 }); // spec §10 example
    const family = pf.aggregate(
      pf.computeHoldings({ today: '2026-10-12' }),
      'family',
      '2026-10-12',
    )[0];
    expect(family.invested).toBe(P(300000));
  });

  it('pause and stop affect pending instalments and history', async () => {
    const { acc, planIds } = await seedBasics();
    const id = sips.createSip({
      MutualFundPlanId: planIds[0],
      InvestmentAccountId: acc,
      SIPAmount: P(5000),
      Frequency: 'MONTHLY',
      SIPDate: 10,
      StartDate: '2026-01-10',
    });
    sips.pauseSip(id, '2026-04-30', '2026-03-01');
    sips.resumeSip(id, '2026-05-01');
    sips.stopSip(id, '2026-07-31');
    const dates = sips.pendingSipConfirmations('2026-10-12').map((p) => p.date);
    expect(dates).toEqual(['2026-01-10', '2026-02-10', '2026-05-10', '2026-06-10', '2026-07-10']);
    expect(sips.sipHistory(id).map((h) => h.Action)).toEqual([
      'STOPPED',
      'RESUMED',
      'PAUSED',
      'CREATED',
    ]);
    expect(sips.sipTotals('2026-10-12').monthly).toBe(0);
  });

  it('expired pauses auto-resume', async () => {
    const { acc, planIds } = await seedBasics();
    const id = sips.createSip({
      MutualFundPlanId: planIds[0],
      InvestmentAccountId: acc,
      SIPAmount: P(5000),
      Frequency: 'MONTHLY',
      SIPDate: 10,
      StartDate: '2026-01-10',
    });
    sips.pauseSip(id, '2026-03-31', '2026-02-01');
    expect(sips.autoResumeExpiredPauses('2026-04-02')).toBe(1);
    expect(sips.getSip(id)!.Status).toBe('ACTIVE');
  });
});

describe('portfolio, XIRR and capital gains', () => {
  beforeEach(freshDb);

  it('value, gain, XIRR and FY gains with ST/LT split', async () => {
    const { acc, planIds } = await seedBasics();
    const base = { InvestmentAccountId: acc, MutualFundPlanId: planIds[0] };
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2024-01-10',
      TransactionType: 'PURCHASE',
      NAV: U('100'),
      Units: U('100'),
      Amount: P(10000),
    });
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2024-06-10',
      TransactionType: 'PURCHASE',
      NAV: U('120'),
      Units: U('50'),
      Amount: P(6000),
    });
    mft.createMFTransaction({
      ...base,
      TransactionDate: '2025-03-01',
      TransactionType: 'REDEMPTION',
      NAV: U('150'),
      Units: U('120'),
      Amount: P(18000),
    });
    nav.upsertNav(planIds[0], '2026-10-01', U('160'), 'AMFI');

    const [h] = pf.computeHoldings({ today: '2026-10-05' });
    expect(h.units).toBe(U('30'));
    expect(h.invested).toBe(P(3600)); // 30 remaining of the ₹120 lot
    expect(h.value).toBe(P(4800));
    expect(h.gain).toBe(P(1200));
    expect(h.realisedGain).toBe(P(5600)); // 18000 − 10000 − 2400 (20 units × 120)
    expect(h.xirr).toBeGreaterThan(0.2);
    expect(h.ltUnits).toBe(U('30')); // bought 2024-06, today 2026-10 → LT

    const { summary, rows } = pf.capitalGainsForFy('2024-25');
    expect(rows.map((r) => r.term)).toEqual(['LT', 'ST']);
    expect(summary[0]).toMatchObject({ equityLT: P(5000), equityST: P(600), equityLTTaxable: 0 });
    expect(pf.fysWithGains()).toEqual(['2024-25']);
  });

  it('value series uses NAV history at each month end', async () => {
    const { acc, planIds } = await seedBasics();
    mft.createMFTransaction({
      InvestmentAccountId: acc,
      MutualFundPlanId: planIds[0],
      TransactionDate: '2026-01-10',
      TransactionType: 'PURCHASE',
      NAV: U('100'),
      Units: U('10'),
      Amount: P(1000),
    });
    nav.upsertNav(planIds[0], '2026-01-31', U('110'), 'AMFI');
    nav.upsertNav(planIds[0], '2026-02-27', U('90'), 'AMFI');
    const s = pf.valueSeries({ today: '2026-03-15' });
    expect(s.map((p) => [p.date, p.value])).toEqual([
      ['2026-01-31', P(1100)],
      ['2026-02-28', P(900)],
      ['2026-03-15', P(900)],
    ]);
  });
});

describe('AMFI NAV file', () => {
  beforeEach(freshDb);

  it('parses schemes, categories, plan/option and NAVs', () => {
    const list = parseAmfiNav(amfiFixture);
    expect(list).toHaveLength(8);
    const hdfc = list.find((s) => s.schemeCode === '118955')!;
    expect(hdfc).toMatchObject({
      isin: 'INF179K01UT0',
      amc: 'HDFC Mutual Fund',
      category: 'Equity',
      subCategory: 'Flexi Cap',
      fundName: 'HDFC Flexi Cap Fund',
      planType: 'DIRECT',
      optionType: 'GROWTH',
      nav: U('1950.1234'),
      navDate: '2026-10-03',
    });
    expect(list.find((s) => s.schemeCode === '101762')).toMatchObject({
      planType: 'REGULAR',
      optionType: 'GROWTH',
    });
    expect(list.find((s) => s.schemeCode === '118956')).toMatchObject({
      optionType: 'IDCW_PAYOUT',
      isinReinvest: 'INF179K01UV6',
    });
    expect(list.find((s) => s.schemeCode === '120252')).toMatchObject({
      nav: null,
      isin: null,
      subCategory: 'Aggressive Hybrid',
    });
    expect(searchSchemes(list, 'axis blue')[0].schemeCode).toBe('120465');
    expect(searchSchemes(list, 'INF846K01CH7')[0].schemeCode).toBe('120465');
  });

  it('adds plans from AMFI search and refreshes NAV by scheme code and ISIN', () => {
    const list = parseAmfiNav(amfiFixture);
    const planId = funds.addPlanFromAmfi(list.find((s) => s.schemeCode === '120465')!);
    expect(funds.getPlan(planId)).toMatchObject({
      FundName: 'Axis Bluechip Fund',
      SchemeCode: '120465',
      ISIN: 'INF846K01CH7',
      LatestNAV: U('62.34'),
    });
    expect(funds.addPlanFromAmfi(list.find((s) => s.schemeCode === '120465')!)).toBe(planId); // idempotent
    // A plan known only by ISIN gets matched and its scheme code filled in.
    const fid = funds.createFund({ AMCName: 'SBI Mutual Fund', FundName: 'SBI Liquid Fund' });
    const pid = funds.createPlan(fid, {
      PlanType: 'DIRECT',
      OptionType: 'GROWTH',
      ISIN: 'INF200K01RJ1',
    });
    nav.upsertNav(pid, '2026-10-03', U('1'), 'TRANSACTION');
    const res = nav.applyAmfiNavs(list);
    expect(res.matched).toBe(2);
    expect(funds.getPlan(pid)).toMatchObject({ SchemeCode: '119800', LatestNAV: U('4012.5671') });
    // A transaction NAV does not overwrite AMFI
    nav.upsertNav(pid, '2026-10-03', U('2'), 'TRANSACTION');
    expect(nav.navOn(pid, '2026-10-03')).toMatchObject({ NAV: U('4012.5671'), Source: 'AMFI' });
  });
});

describe('CAS import', () => {
  beforeEach(freshDb);
  const lines = casFixture.split('\n');

  it('parses folios, schemes, transactions, charges and closing balances', () => {
    const cas = parseCasLines(lines);
    expect(cas.periodFrom).toBe('2026-01-01');
    expect(cas.schemes).toHaveLength(3);
    const [hdfc, axis, liquid] = cas.schemes;
    expect(hdfc).toMatchObject({
      amc: 'HDFC Mutual Fund',
      folioNumber: '12345678/90',
      isin: 'INF179K01UT0',
      schemeName: 'HDFC Flexi Cap Fund - Direct Plan - Growth Option',
      closingUnits: U('9.973'),
      closingNav: U('1950.1234'),
      closingNavDate: '2026-10-03',
    });
    expect(hdfc.transactions.map((t) => [t.type, t.units, t.amount, t.stampDuty, t.stt])).toEqual([
      ['SIP', U('6.123'), P(9999.5), 50, 0],
      ['SIP', U('5.95'), P(9999.5), 50, 0],
      ['REDEMPTION', U('2.1'), P(4000), 0, 4],
    ]);
    expect(axis.transactions.map((t) => t.type)).toEqual(['PURCHASE', 'SWITCH_OUT']);
    expect(liquid.transactions[0]).toMatchObject({ type: 'SWITCH_IN', stampDuty: 50 });
    expect(cas.warnings).toEqual([]);
  });

  it('imports, reconciles to zero mismatches, re-import creates no duplicates, undo works', async () => {
    const { acc } = await seedBasics();
    const cas = parseCasLines(lines);
    const prep = imp.prepareCasImport(cas);
    expect(prep.rows.filter((r) => r.status === 'new')).toHaveLength(6);
    expect(prep.recon.map((r) => r.diff)).toEqual([0, 0, 0]);
    const batch = imp.commitCasImport(prep, cas, acc, 'cas.pdf');

    // Funds/plans/folios created; switch legs paired.
    expect(funds.findPlan({ isin: 'INF846K01CL9' })?.FundName).toBe('Axis Liquid Fund');
    expect(mfa.findFolio('HDFC Mutual Fund', '12345678 / 90')).toBeTruthy();
    expect(
      scalar(
        'SELECT COUNT(DISTINCT SwitchGroupId) FROM MFTransaction WHERE SwitchGroupId IS NOT NULL',
      ),
    ).toBe(1);
    expect(
      one<{ TotalAmount: number }>(
        "SELECT TotalAmount FROM MFTransaction WHERE TransactionType = 'SIP' LIMIT 1",
      )!.TotalAmount,
    ).toBe(P(10000));

    const again = imp.prepareCasImport(cas);
    expect(again.rows.every((r) => r.status === 'duplicate')).toBe(true);
    expect(again.recon.map((r) => r.diff)).toEqual([0, 0, 0]);

    imp.undoMfImport(batch);
    expect(scalar('SELECT COUNT(*) FROM MFTransaction')).toBe(0);
    expect(imp.listMfImportBatches()[0].UndoneOn).not.toBeNull();
  });

  it('platform CSV import with mapping, matching plans by ISIN', async () => {
    const { acc } = await seedBasics();
    const grid = [
      ['Date', 'Scheme Name', 'ISIN', 'Folio Number', 'Transaction Type', 'Units', 'NAV', 'Amount'],
      [
        '10/01/2026',
        'Fund 1 Direct Growth',
        'INF000000001',
        'F-1',
        'SIP Purchase',
        '79.677',
        '125.5',
        '9999.50',
      ],
      [
        '10/02/2026',
        'Fund 1 Direct Growth',
        'INF000000001',
        'F-1',
        'Redemption',
        '-10',
        '130',
        '1300',
      ],
      ['10/02/2026', 'Unknown', 'INF999999999', 'F-1', 'Purchase', '1', '10', '10'],
    ];
    const g = imp.guessMfCsvMapping(grid[0]);
    expect(g).toMatchObject({
      dateCol: 0,
      schemeCol: 2,
      schemeKind: 'isin',
      typeCol: 4,
      unitsCol: 5,
      navCol: 6,
      amountCol: 7,
      folioCol: 3,
    });
    funds.updateFund(1, { AMCName: 'AMC 1', FundName: 'Fund 1', Category: 'Equity' });
    const prep = imp.prepareCsvImport(grid, {
      ...g,
      headerRow: 0,
      dateFormat: 'DD/MM/YYYY',
    } as imp.MFCsvMapping);
    expect(prep.rows.map((r) => r.status)).toEqual(['new', 'new', 'error']);
    expect(prep.rows[1].type).toBe('REDEMPTION');
    imp.commitCsvImport(prep, acc, 'groww.csv');
    expect(mft.unitsHeld(acc, mfa.findFolio('AMC 1', 'F-1')!.FolioId, 1)).toBe(U('69.677'));
    expect(
      imp
        .prepareCsvImport(grid, {
          ...g,
          headerRow: 0,
          dateFormat: 'DD/MM/YYYY',
        } as imp.MFCsvMapping)
        .rows.slice(0, 2)
        .map((r) => r.status),
    ).toEqual(['duplicate', 'duplicate']);
  });
});
