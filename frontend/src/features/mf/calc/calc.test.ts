import { describe, expect, it } from 'vitest';
import {
  formatBps,
  formatNav,
  formatUnits,
  fromMicro,
  parseBps,
  parseMicro,
  stampDuty,
  unitsFromAmount,
  valuePaise,
} from '@/lib/units';
import { runFifo, type FifoTxn } from './fifo';
import {
  annualAmount,
  amountOn,
  instalments,
  nextInstalment,
  pendingInstalments,
  scheduleDates,
  type SipLike,
} from './sipSchedule';
import {
  addMonths,
  classifyRealisation,
  classifyTerm,
  summariseFy,
  taxClassFor,
  type TaxRules,
} from './tax';
import { xirr } from './xirr';
import migration from '@/db/migrations/003_mutual_funds.sql?raw';

// Default rules as shipped in the migration.
const RULES: TaxRules = JSON.parse(/json\('([\s\S]*?)'\)/.exec(migration)![1]) as TaxRules;

describe('units', () => {
  it('converts micro-units and money exactly', () => {
    expect(parseMicro('79.6773')).toBe(79_677_300);
    expect(parseMicro('1,234.5')).toBe(1_234_500_000);
    expect(parseMicro('abc')).toBeNull();
    expect(fromMicro(79_677_000, 3)).toBe('79.677');
    expect(formatUnits(1_234_567_890)).toBe('1,234.568');
    expect(formatNav(125_500_000)).toBe('125.5000');
    expect(parseBps('0.65')).toBe(6500);
    expect(formatBps(6500)).toBe('0.65');
  });

  it('spec example: ₹10,000 SIP at NAV 125.50 with 0.005% stamp duty', () => {
    const gross = 1_000_000; // paise
    const stamp = stampDuty(gross);
    expect(stamp).toBe(50); // ₹0.50
    const units = unitsFromAmount(gross - stamp, 125_500_000);
    expect(units).toBe(79_677_000); // 79.677 (3-dp allotment)
    expect(valuePaise(units, 125_500_000)).toBe(999_946); // 79.677 × 125.50 = ₹9,999.46
    // Owner's raw example without stamp duty, 6 dp
    expect(unitsFromAmount(gross, 125_500_000, 6)).toBe(79_681_275);
  });
});

describe('xirr (Excel reference sets, within 0.01%)', () => {
  it('Excel documentation example → 37.336%', () => {
    const r = xirr([
      { date: '2008-01-01', amount: -1_000_000 },
      { date: '2008-03-01', amount: 275_000 },
      { date: '2008-10-30', amount: 425_000 },
      { date: '2009-02-15', amount: 325_000 },
      { date: '2009-04-01', amount: 275_000 },
    ])!;
    expect(Math.abs(r - 0.373362535)).toBeLessThan(1e-4);
  });

  it('one year with a leap day (366 days, Excel 365-day convention)', () => {
    const r = xirr([
      { date: '2020-01-01', amount: -100_000 },
      { date: '2021-01-01', amount: 110_000 },
    ])!;
    expect(Math.abs(r - (Math.pow(1.1, 365 / 366) - 1))).toBeLessThan(1e-4);
  });

  it('two years, 50% total gain → 22.474%', () => {
    const r = xirr([
      { date: '2021-01-01', amount: -100_000 },
      { date: '2023-01-01', amount: 150_000 },
    ])!;
    expect(Math.abs(r - 0.224744871)).toBeLessThan(1e-4);
  });

  it('monthly SIP + final value has NPV ≈ 0 at the result; no sign change → null', () => {
    const flows = Array.from({ length: 12 }, (_, i) => ({
      date: `2025-${String(i + 1).padStart(2, '0')}-10`,
      amount: -1_000_000,
    }));
    flows.push({ date: '2026-01-10', amount: 13_000_000 });
    const r = xirr(flows)!;
    expect(r).toBeGreaterThan(0.1);
    expect(r).toBeLessThan(0.2);
    expect(xirr([{ date: '2025-01-01', amount: -5 }])).toBeNull();
  });

  it('handles losses (negative rate)', () => {
    const r = xirr([
      { date: '2024-01-01', amount: -100_000 },
      { date: '2025-01-01', amount: 60_000 },
    ])!;
    expect(r).toBeLessThan(0);
    expect(Math.abs(r - (Math.pow(0.6, 365 / 366) - 1))).toBeLessThan(1e-4);
  });
});

const tx = (
  p: Partial<FifoTxn> & Pick<FifoTxn, 'TransactionId' | 'TransactionDate' | 'TransactionType'>,
): FifoTxn => ({
  Units: 0,
  Amount: 0,
  StampDuty: 0,
  ExitLoad: 0,
  OtherCharges: 0,
  ...p,
});

describe('FIFO', () => {
  const txns = [
    tx({
      TransactionId: 1,
      TransactionDate: '2024-01-10',
      TransactionType: 'PURCHASE',
      Units: 100_000_000,
      Amount: 1_000_000,
      StampDuty: 50,
    }),
    tx({
      TransactionId: 2,
      TransactionDate: '2024-06-10',
      TransactionType: 'SIP',
      Units: 50_000_000,
      Amount: 600_000,
      StampDuty: 30,
    }),
    tx({
      TransactionId: 3,
      TransactionDate: '2025-03-01',
      TransactionType: 'REDEMPTION',
      Units: 120_000_000,
      Amount: 1_800_000,
    }),
  ];

  it('multi-lot redemption: realised gain, remaining lot, ST/LT split', () => {
    const { lots, realised, shortfall } = runFifo(txns);
    expect(shortfall).toBe(0);
    expect(realised).toHaveLength(2);
    expect(realised[0]).toMatchObject({
      buyTxnId: 1,
      units: 100_000_000,
      cost: 1_000_050,
      proceeds: 1_500_000,
      gain: 499_950,
    });
    expect(realised[1]).toMatchObject({
      buyTxnId: 2,
      units: 20_000_000,
      cost: 240_012,
      proceeds: 300_000,
      gain: 59_988,
    });
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ txnId: 2, units: 30_000_000, cost: 360_018 });
    expect(classifyTerm('EQUITY', '2024-01-10', '2025-03-01', RULES)).toBe('LT');
    expect(classifyTerm('EQUITY', '2024-06-10', '2025-03-01', RULES)).toBe('ST');
  });

  it('bonus lots have zero cost; transfer-out removes units without a gain', () => {
    const { lots, realised } = runFifo([
      tx({
        TransactionId: 1,
        TransactionDate: '2024-01-01',
        TransactionType: 'PURCHASE',
        Units: 10_000_000,
        Amount: 100_000,
      }),
      tx({
        TransactionId: 2,
        TransactionDate: '2024-02-01',
        TransactionType: 'BONUS',
        Units: 10_000_000,
      }),
      tx({
        TransactionId: 3,
        TransactionDate: '2024-03-01',
        TransactionType: 'TRANSFER_OUT',
        Units: 10_000_000,
      }),
    ]);
    expect(realised).toHaveLength(0);
    expect(lots).toEqual([expect.objectContaining({ type: 'BONUS', units: 10_000_000, cost: 0 })]);
  });

  it('reports a shortfall when redeeming more than held', () => {
    const r = runFifo([
      tx({
        TransactionId: 1,
        TransactionDate: '2024-01-01',
        TransactionType: 'PURCHASE',
        Units: 5_000_000,
        Amount: 50_000,
      }),
      tx({
        TransactionId: 2,
        TransactionDate: '2024-02-01',
        TransactionType: 'REDEMPTION',
        Units: 6_000_000,
        Amount: 60_000,
      }),
    ]);
    expect(r.shortfall).toBe(1_000_000);
  });

  it('FY summary: exemption on equity LTCG, 20% STCG estimate', () => {
    const { realised } = runFifo(txns);
    const meta = {
      planId: 1,
      personId: 7,
      personName: 'Karan',
      fundLabel: 'Fund 1',
      taxClass: 'EQUITY' as const,
    };
    const rows = realised.map((r) => classifyRealisation(r, meta, RULES));
    const [s] = summariseFy(rows, '2024-25', RULES);
    expect(s).toMatchObject({
      equityLT: 499_950,
      equityST: 59_988,
      equityLTExemption: 499_950,
      equityLTTaxable: 0,
    });
    expect(s.estimatedFixedRateTax).toBe(11_998); // 20% of ₹599.88
    expect(summariseFy(rows, '2025-26', RULES)).toEqual([]);
  });
});

describe('tax rules', () => {
  it('derives tax class from category / sub-category, with explicit override', () => {
    expect(taxClassFor({ Category: 'Equity', SubCategory: 'Flexi Cap' }, RULES)).toBe('EQUITY');
    expect(taxClassFor({ Category: 'Hybrid', SubCategory: 'Aggressive Hybrid' }, RULES)).toBe(
      'EQUITY',
    );
    expect(taxClassFor({ Category: 'Hybrid', SubCategory: 'Conservative Hybrid' }, RULES)).toBe(
      'OTHER',
    );
    expect(taxClassFor({ Category: 'Debt', SubCategory: 'Liquid' }, RULES)).toBe('DEBT');
    expect(taxClassFor({ TaxClass: 'DEBT', Category: 'Equity' }, RULES)).toBe('DEBT');
  });

  it('debt: always short term if bought on/after 1-Apr-2023; 36 vs 24 months by sale date', () => {
    expect(classifyTerm('DEBT', '2023-05-01', '2026-06-01', RULES)).toBe('ST');
    expect(classifyTerm('DEBT', '2022-01-01', '2024-08-01', RULES)).toBe('LT'); // > 24 months, new regime
    expect(classifyTerm('DEBT', '2022-01-01', '2024-07-01', RULES)).toBe('ST'); // < 36 months, old regime
  });

  it('equity "more than 12 months"', () => {
    expect(classifyTerm('EQUITY', '2024-01-10', '2025-01-10', RULES)).toBe('ST');
    expect(classifyTerm('EQUITY', '2024-01-10', '2025-01-11', RULES)).toBe('LT');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('grandfathers equity bought before 31-Jan-2018', () => {
    const r = classifyRealisation(
      {
        sellTxnId: 2,
        sellDate: '2019-06-01',
        sellType: 'REDEMPTION',
        buyTxnId: 1,
        buyDate: '2017-06-01',
        units: 10_000_000,
        cost: 100_000,
        proceeds: 200_000,
        gain: 100_000,
      },
      { planId: 1, personId: 1, personName: 'A', fundLabel: 'F', taxClass: 'EQUITY' },
      RULES,
      () => 150_000_000, // NAV ₹150 on 31-Jan-2018 → FMV ₹1,500 for 10 units
    );
    expect(r).toMatchObject({ taxCost: 150_000, taxGain: 50_000, grandfathered: true, rate: 10 });
  });
});

const SIP: SipLike = {
  SIPAmount: 1_000_000,
  Frequency: 'MONTHLY',
  SIPDate: 10,
  StartDate: '2026-01-10',
  EndDate: null,
  StepUpPercentBps: null,
  StepUpFrequency: null,
};

describe('SIP schedule', () => {
  it('31st-day SIPs clamp to month end in Feb/Apr', () => {
    expect(
      scheduleDates({ ...SIP, SIPDate: 31, StartDate: '2026-01-31' }, '2026-01-01', '2026-04-30'),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('first instalment is the next SIP day on/after start; end date respected', () => {
    expect(
      scheduleDates(
        { ...SIP, StartDate: '2026-01-15', EndDate: '2026-04-10' },
        '2026-01-01',
        '2026-12-31',
      ),
    ).toEqual(['2026-02-10', '2026-03-10', '2026-04-10']);
    expect(scheduleDates({ ...SIP, Frequency: 'QUARTERLY' }, '2026-01-01', '2026-12-31')).toEqual([
      '2026-01-10',
      '2026-04-10',
      '2026-07-10',
      '2026-10-10',
    ]);
  });

  it('pause window skips instalments', () => {
    const got = instalments(SIP, '2026-01-01', '2026-06-30', [
      { from: '2026-03-01', to: '2026-04-30' },
    ]);
    expect(got.map((i) => i.date)).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-05-10',
      '2026-06-10',
    ]);
    expect(nextInstalment(SIP, '2026-03-11', [{ from: '2026-03-01', to: null }])).toBeNull();
  });

  it('10% yearly step-up applies after each 12 months', () => {
    const s = { ...SIP, StepUpPercentBps: 100_000, StepUpFrequency: 'YEARLY' as const };
    expect(amountOn(s, '2027-01-09')).toBe(1_000_000);
    expect(amountOn(s, '2027-01-10')).toBe(1_100_000);
    expect(amountOn(s, '2028-01-10')).toBe(1_210_000);
  });

  it('pending detection tolerates holiday shifts and never double-matches', () => {
    const pending = pendingInstalments(SIP, '2026-10-15', ['2026-01-12', '2026-02-10']);
    expect(pending.map((p) => p.date)).toEqual([
      '2026-03-10',
      '2026-04-10',
      '2026-05-10',
      '2026-06-10',
      '2026-07-10',
      '2026-08-10',
      '2026-09-10',
      '2026-10-10',
    ]);
    // A single transaction can only satisfy one instalment.
    expect(pendingInstalments(SIP, '2026-02-12', ['2026-02-10'])).toHaveLength(1);
  });

  it('owner example: 3 monthly SIPs of ₹10,000 = ₹30,000/month, ₹3,60,000/year', () => {
    const annual = [SIP, SIP, SIP].reduce((s, x) => s + annualAmount(x, '2026-10-05'), 0);
    expect(annual).toBe(36_000_000);
    expect(annual / 12).toBe(3_000_000);
  });
});
