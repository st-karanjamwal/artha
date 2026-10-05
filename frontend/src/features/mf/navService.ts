import { api } from '@/lib/api';
import { parseMicro } from '@/lib/units';
import { todayLocal } from '@/lib/dates';
import { scalar } from '@/db/sql';
import {
  applyAmfiNavs,
  lastNavRefresh,
  storeNavHistory,
  type NavRefreshResult,
} from '@/repositories/mfNav';
import { getPlan } from '@/repositories/mfFunds';
import { parseAmfiNav, type AmfiScheme } from './amfi';
import { addDaysIso } from './calc/sipSchedule';

/** AMFI list is public data: cached in memory only (never in the vault). */
let cache: { list: AmfiScheme[]; at: number } | null = null;
let inflight: Promise<AmfiScheme[]> | null = null;

export async function loadAmfiList(force = false): Promise<AmfiScheme[]> {
  if (!force && cache && Date.now() - cache.at < 3 * 3600_000) return cache.list;
  inflight ??= api
    .amfiNav(force)
    .then(({ text }) => {
      const list = parseAmfiNav(text);
      if (!list.length) throw new Error('The AMFI NAV file was empty');
      cache = { list, at: Date.now() };
      return list;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function refreshNavs(force = false): Promise<NavRefreshResult> {
  return applyAmfiNavs(await loadAmfiList(force));
}

/**
 * Refresh once per day on unlock. After 9 PM IST AMFI has published that day's NAV, so a refresh
 * made earlier in the day is refreshed again.
 */
export function navRefreshDue(now = new Date()): boolean {
  if (!scalar<number>('SELECT COUNT(*) FROM MutualFundPlan')) return false;
  const last = lastNavRefresh();
  if (!last) return true;
  const lastDate = new Date(last);
  if (todayLocal(lastDate) < todayLocal(now)) return true;
  const istHour = (d: Date) => (d.getUTCHours() + 5.5 + 24) % 24;
  return istHour(now) >= 21 && istHour(lastDate) < 21;
}

/** Backfill public NAV history for a plan (via the server relay to the historical provider). */
export async function backfillNavHistory(planId: number): Promise<number> {
  const plan = getPlan(planId);
  if (!plan?.SchemeCode) throw new Error('This plan has no AMFI scheme code; add it first');
  const first = scalar<string>(
    'SELECT MIN(TransactionDate) FROM MFTransaction WHERE MutualFundPlanId = ?',
    [planId],
  );
  const from = first ? addDaysIso(first, -30) : addDaysIso(todayLocal(), -730);
  const res = await api.navHistory(plan.SchemeCode);
  const points = res.data
    .map((p) => ({ date: p.date, nav: parseMicro(p.nav) ?? 0 }))
    .filter((p) => p.nav > 0);
  return storeNavHistory(planId, points, from);
}
