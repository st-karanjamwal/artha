import { type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import { NavLink } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatINR } from '@/lib/money';
import { percent } from '@/lib/units';
import { listPlans, planLabel } from '@/repositories/mfFunds';
import {
  investmentAccountLabel,
  listFolios,
  listInvestmentAccounts,
} from '@/repositories/mfAccounts';
import { Card, Select, cx } from '@/components/ui';
import { formatRate } from './calc/xirr';

export const MF_LINKS = [
  { to: '/mf', label: 'Overview', end: true },
  { to: '/mf/portfolio', label: 'Portfolio' },
  { to: '/mf/sips', label: 'SIPs' },
  { to: '/mf/transactions', label: 'Transactions' },
  { to: '/mf/funds', label: 'Funds' },
  { to: '/mf/accounts', label: 'Accounts & folios' },
  { to: '/mf/gains', label: 'Capital gains' },
  { to: '/mf/import', label: 'Import' },
];

/** Sub-navigation shown at the top of every mutual-fund screen. */
export function MFNav() {
  return (
    <div className="no-print -mx-4 mb-4 overflow-x-auto border-b border-slate-200 px-4 dark:border-slate-800">
      <nav className="flex gap-1" aria-label="Mutual funds">
        {MF_LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) =>
              cx(
                'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
                isActive
                  ? 'border-brand-700 text-brand-700 dark:border-brand-500 dark:text-brand-500'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
              )
            }
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  ref?: Ref<HTMLSelectElement>;
  placeholder?: string;
};

export function PlanSelect({
  placeholder,
  includeInactive,
  ...p
}: SelectProps & { includeInactive?: boolean }) {
  const plans = useDb(() => listPlans({ includeInactive }), [includeInactive]);
  return (
    <Select {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {plans.map((x) => (
        <option key={x.MutualFundPlanId} value={x.MutualFundPlanId}>
          {planLabel(x)}
        </option>
      ))}
    </Select>
  );
}

export function InvestmentAccountSelect({ placeholder, ...p }: SelectProps) {
  const items = useDb(() => listInvestmentAccounts());
  return (
    <Select {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {items.map((a) => (
        <option key={a.InvestmentAccountId} value={a.InvestmentAccountId}>
          {investmentAccountLabel(a)}
        </option>
      ))}
    </Select>
  );
}

export function FolioSelect({
  placeholder,
  accountId,
  ...p
}: SelectProps & { accountId?: number }) {
  const items = useDb(() => (accountId ? listFolios({ accountId }) : []), [accountId]);
  return (
    <Select {...p}>
      <option value="">{placeholder ?? 'No folio yet'}</option>
      {items.map((f) => (
        <option key={f.FolioId} value={f.FolioId}>
          {f.AMCName} · {f.FolioNumber}
        </option>
      ))}
    </Select>
  );
}

/** "+₹1,234.00 (12.34%)" coloured by sign. */
export function Gain({
  value,
  base,
  className,
}: {
  value: number;
  base?: number;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'num whitespace-nowrap',
        value > 0 ? 'text-emerald-700 dark:text-emerald-400' : value < 0 ? 'text-red-600' : '',
        className,
      )}
    >
      {value > 0 ? '+' : ''}
      {formatINR(value)}
      {base ? ` (${value > 0 ? '+' : ''}${percent(value, base)}%)` : ''}
    </span>
  );
}

export function Rate({ r, className }: { r: number | null | undefined; className?: string }) {
  return (
    <span className={cx('num', r != null && r < 0 && 'text-red-600', className)}>
      {formatRate(r)}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold break-words sm:text-2xl">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

/** Horizontal share bars: label, value, gain %. Single hue (identity is the label). */
export function SplitList({
  rows,
}: {
  rows: { key: string; label: string; value: number; invested: number; xirr?: number | null }[];
}) {
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0) || 1;
  if (!rows.length) return <p className="text-sm text-slate-500">Nothing yet.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="num whitespace-nowrap font-medium">
              {formatINR(r.value, { decimals: false })}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className="h-2 rounded-full bg-brand-600"
                style={{ width: `${Math.max(2, (Math.max(0, r.value) / total) * 100)}%` }}
              />
            </div>
            <span className="w-28 text-right text-xs text-slate-500">
              {percent(Math.max(0, r.value), total, 1)}% ·{' '}
              <Gain value={r.value - r.invested} className="text-xs" />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
