import { describe, expect, it } from 'vitest';
import { ageFrom, financialYear, parseDate } from './dates';
import {
  formatINR,
  formatINRCompact,
  parseStatementAmount,
  parseToPaise,
  paiseToInput,
} from './money';
import { IFSC_RE } from './validators';

describe('money', () => {
  it('formats with Indian grouping', () => {
    expect(formatINR(123456700)).toBe('₹12,34,567.00');
    expect(formatINR(5)).toBe('₹0.05');
    expect(formatINR(-99999)).toBe('-₹999.99');
    expect(formatINR(100000000000)).toBe('₹1,00,00,00,000.00');
    expect(formatINR(1234500, { symbol: false })).toBe('12,345.00');
  });

  it('compact', () => {
    expect(formatINRCompact(12500000)).toBe('₹1.25 L');
    expect(formatINRCompact(3400000000)).toBe('₹3.4 Cr');
  });

  it('parses user input exactly', () => {
    expect(parseToPaise('12,34,567.89')).toBe(123456789);
    expect(parseToPaise('₹ 1,000')).toBe(100000);
    expect(parseToPaise('0.1')).toBe(10);
    expect(parseToPaise('.5')).toBe(50);
    expect(parseToPaise('-25.5')).toBe(-2550);
    expect(parseToPaise('1.234')).toBeNull();
    expect(parseToPaise('abc')).toBeNull();
    expect(parseToPaise('')).toBeNull();
    // Classic float trap: 0.1 + 0.2
    expect(parseToPaise('0.1')! + parseToPaise('0.2')!).toBe(30);
  });

  it('parses statement amounts', () => {
    expect(parseStatementAmount('1,23,456.78')).toBe(12345678);
    expect(parseStatementAmount('(500.00)')).toBe(-50000);
    expect(parseStatementAmount('500.00 Dr')).toBe(-50000);
    expect(parseStatementAmount('500.00 Cr')).toBe(50000);
    expect(parseStatementAmount(1234.56)).toBe(123456);
    expect(parseStatementAmount('')).toBeNull();
    expect(parseStatementAmount('-')).toBeNull();
  });

  it('paiseToInput', () => {
    expect(paiseToInput(123450)).toBe('1234.50');
  });
});

describe('dates', () => {
  it('parses statement formats', () => {
    expect(parseDate('05/04/2026', 'DD/MM/YYYY')).toBe('2026-04-05');
    expect(parseDate('05-Apr-2026', 'DD-MMM-YYYY')).toBe('2026-04-05');
    expect(parseDate('05/04/26', 'DD/MM/YY')).toBe('2026-04-05');
    expect(parseDate('2026-04-05', 'YYYY-MM-DD')).toBe('2026-04-05');
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('05/04/2026 10:30', 'DD/MM/YYYY')).toBe('2026-04-05');
  });

  it('age and FY', () => {
    expect(ageFrom('2015-10-05', '2026-10-04')).toBe(10);
    expect(ageFrom('2015-10-04', '2026-10-04')).toBe(11);
    expect(financialYear('2026-03-31')).toBe('2025-26');
    expect(financialYear('2026-04-01')).toBe('2026-27');
  });
});

describe('validators', () => {
  it('IFSC', () => {
    expect(IFSC_RE.test('SBIN0001234')).toBe(true);
    expect(IFSC_RE.test('HDFC0ABC123')).toBe(true);
    expect(IFSC_RE.test('SBIN1001234')).toBe(false);
  });
});
