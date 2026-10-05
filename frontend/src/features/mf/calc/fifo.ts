import { proRata } from '@/lib/units';

/**
 * FIFO lot accounting for one holding (one folio + plan). Units in micro-units, money in paise.
 * Every unit-adding transaction opens a lot; redemptions / switch-outs / transfer-outs consume
 * the oldest lots first.
 */

export type MFTxnType =
  | 'PURCHASE'
  | 'SIP'
  | 'REDEMPTION'
  | 'SWITCH_IN'
  | 'SWITCH_OUT'
  | 'IDCW_PAYOUT'
  | 'IDCW_REINVEST'
  | 'BONUS'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT';

export const ADD_TYPES: MFTxnType[] = [
  'PURCHASE',
  'SIP',
  'SWITCH_IN',
  'IDCW_REINVEST',
  'BONUS',
  'TRANSFER_IN',
];
export const REDUCE_TYPES: MFTxnType[] = ['REDEMPTION', 'SWITCH_OUT', 'TRANSFER_OUT'];

export interface FifoTxn {
  TransactionId: number;
  TransactionDate: string;
  TransactionType: MFTxnType;
  Units: number;
  Amount: number;
  StampDuty: number;
  ExitLoad: number;
  OtherCharges: number;
}

export interface Lot {
  txnId: number;
  date: string;
  type: MFTxnType;
  units: number; // remaining
  cost: number; // remaining cost, paise
  originalUnits: number;
  originalCost: number;
}

export interface Realisation {
  sellTxnId: number;
  sellDate: string;
  sellType: MFTxnType;
  buyTxnId: number;
  buyDate: string;
  units: number;
  cost: number;
  proceeds: number;
  gain: number;
}

export interface FifoResult {
  lots: Lot[];
  realised: Realisation[];
  /** Units that could not be matched to any lot (data problem, e.g. missing purchases). */
  shortfall: number;
}

/** Cost of acquisition for a unit-adding transaction. Stamp duty is part of the cost. */
export function lotCost(t: FifoTxn): number {
  switch (t.TransactionType) {
    case 'PURCHASE':
    case 'SIP':
      return t.Amount + t.StampDuty + t.OtherCharges;
    case 'SWITCH_IN':
      return t.Amount + t.StampDuty;
    case 'IDCW_REINVEST':
    case 'TRANSFER_IN':
      return t.Amount;
    default:
      return 0; // BONUS and non-adding types
  }
}

/** Sale consideration net of exit load / charges (STT is not deductible). */
export function saleProceeds(t: FifoTxn): number {
  if (t.TransactionType === 'TRANSFER_OUT') return 0;
  return Math.max(0, t.Amount - t.ExitLoad - t.OtherCharges);
}

const order = (t: FifoTxn) => (ADD_TYPES.includes(t.TransactionType) ? 0 : 1);

export function sortForFifo<T extends FifoTxn>(txns: T[]): T[] {
  return [...txns].sort(
    (a, b) =>
      a.TransactionDate.localeCompare(b.TransactionDate) ||
      order(a) - order(b) ||
      a.TransactionId - b.TransactionId,
  );
}

export function runFifo(txns: FifoTxn[]): FifoResult {
  const lots: Lot[] = [];
  const realised: Realisation[] = [];
  let shortfall = 0;
  for (const t of sortForFifo(txns)) {
    if (ADD_TYPES.includes(t.TransactionType)) {
      if (t.Units <= 0) continue;
      const cost = lotCost(t);
      lots.push({
        txnId: t.TransactionId,
        date: t.TransactionDate,
        type: t.TransactionType,
        units: t.Units,
        cost,
        originalUnits: t.Units,
        originalCost: cost,
      });
      continue;
    }
    if (!REDUCE_TYPES.includes(t.TransactionType) || t.Units <= 0) continue;
    let remaining = t.Units;
    const proceedsTotal = saleProceeds(t);
    let proceedsLeft = proceedsTotal;
    while (remaining > 0 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.units, remaining);
      const cost = take === lot.units ? lot.cost : proRata(lot.cost, take, lot.units);
      const proceeds = take === remaining ? proceedsLeft : proRata(proceedsTotal, take, t.Units);
      lot.units -= take;
      lot.cost -= cost;
      remaining -= take;
      proceedsLeft -= proceeds;
      if (t.TransactionType !== 'TRANSFER_OUT') {
        realised.push({
          sellTxnId: t.TransactionId,
          sellDate: t.TransactionDate,
          sellType: t.TransactionType,
          buyTxnId: lot.txnId,
          buyDate: lot.date,
          units: take,
          cost,
          proceeds,
          gain: proceeds - cost,
        });
      }
      if (lot.units === 0) lots.shift();
    }
    shortfall += remaining;
  }
  return { lots, realised, shortfall };
}

export function unitDelta(t: Pick<FifoTxn, 'TransactionType' | 'Units'>): number {
  if (ADD_TYPES.includes(t.TransactionType)) return t.Units;
  if (REDUCE_TYPES.includes(t.TransactionType)) return -t.Units;
  return 0;
}

/** Units held after applying all transactions up to and including `date`. */
export function unitsAt(txns: FifoTxn[], date: string): number {
  return txns.filter((t) => t.TransactionDate <= date).reduce((s, t) => s + unitDelta(t), 0);
}
