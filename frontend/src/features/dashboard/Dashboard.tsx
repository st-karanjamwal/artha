import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useDb } from '@/app/session';
import { useTheme } from '@/app/theme';
import { addDays, daysBetween, formatDate, todayLocal } from '@/lib/dates';
import { formatINR, formatINRCompact } from '@/lib/money';
import {
  balanceByBank,
  balanceByPerson,
  last30Days,
  monthlyFlows,
  topExpenseCategories,
  totalBankBalance,
  upcomingMaturities,
  type GroupTotal,
} from '@/repositories/dashboard';
import { Badge, Button, Card, EmptyState, PageHeader, Tabs } from '@/components/ui';
import { Money } from '@/components/inputs';
import { aggregate, computeHoldings } from '@/repositories/mfPortfolio';
import { sipTotals } from '@/repositories/sips';
import { PendingSips } from '@/features/mf/SipsPage';
import { Gain } from '@/features/mf/components';

// Validated categorical slots 1–2 (light / dark steps).
const SERIES = {
  light: { income: '#2a78d6', expense: '#eb6834' },
  dark: { income: '#3987e5', expense: '#d95926' },
};

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold break-words sm:text-2xl">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

function BarList({
  rows,
  link,
}: {
  rows: GroupTotal[];
  link?: (r: GroupTotal) => string | undefined;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.Total)));
  if (!rows.length) return <p className="text-sm text-slate-500">No accounts yet.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const href = link?.(r);
        const name = href ? (
          <Link to={href} className="hover:underline">
            {r.Name}
          </Link>
        ) : (
          r.Name
        );
        return (
          <li key={`${r.Id}-${r.Name}`}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {name}{' '}
                {r.AccountCount > 0 && (
                  <span className="text-xs text-slate-500">· {r.AccountCount}</span>
                )}
              </span>
              <Money paise={r.Total} colored className="font-medium" />
            </div>
            <div className="mt-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className="h-2 rounded-full bg-brand-600"
                style={{ width: `${Math.max(2, (Math.abs(r.Total) / max) * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
};

function FlowChart() {
  const data = useDb(() => monthlyFlows(6));
  const [theme] = useTheme();
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const c = dark ? SERIES.dark : SERIES.light;
  const [asTable, setAsTable] = useState(false);
  const rows = data.map((d) => ({
    month: monthLabel(d.Month),
    Income: d.Income / 100,
    Expense: d.Expense / 100,
    raw: d,
  }));

  return (
    <Card
      className="lg:col-span-2"
      title="Income vs expense, last 6 months"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setAsTable((x) => !x)}>
          {asTable ? 'Chart' : 'Table'}
        </Button>
      }
    >
      {asTable ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Month</th>
              <th className="py-1 text-right">Income</th>
              <th className="py-1 text-right">Expense</th>
              <th className="py-1 text-right">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.month}>
                <td className="py-1.5">{r.month}</td>
                <td className="py-1.5 text-right">
                  <Money paise={r.raw.Income} />
                </td>
                <td className="py-1.5 text-right">
                  <Money paise={r.raw.Expense} />
                </td>
                <td className="py-1.5 text-right">
                  <Money paise={r.raw.Income - r.raw.Expense} colored />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} barGap={2} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={dark ? '#334155' : '#e2e8f0'} />
              <XAxis
                dataKey="month"
                interval={0}
                tickFormatter={(v: string) => v.slice(0, 3)}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: dark ? '#94a3b8' : '#64748b' }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tick={{ fontSize: 12, fill: dark ? '#94a3b8' : '#64748b' }}
                tickFormatter={(v: number) => formatINRCompact(v * 100)}
              />
              <Tooltip
                cursor={{ fill: dark ? 'rgba(148,163,184,0.12)' : 'rgba(100,116,139,0.08)' }}
                formatter={(v) => formatINR(Math.round(Number(v) * 100))}
                contentStyle={{
                  borderRadius: 8,
                  fontSize: 12,
                  background: dark ? '#0f172a' : '#fff',
                  border: `1px solid ${dark ? '#334155' : '#e2e8f0'}`,
                  color: dark ? '#f1f5f9' : '#0f172a',
                }}
              />
              <Legend
                iconType="circle"
                wrapperStyle={{ fontSize: 12 }}
                itemSorter={null} // keep series order (Income, Expense) instead of alphabetical
              />
              <Bar dataKey="Income" fill={c.income} radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Bar dataKey="Expense" fill={c.expense} radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">Self-transfers and investments are excluded.</p>
    </Card>
  );
}

export function Dashboard() {
  const total = useDb(totalBankBalance);
  const flow = useDb(last30Days);
  const byPerson = useDb(balanceByPerson);
  const byBank = useDb(balanceByBank);
  const maturities = useDb(upcomingMaturities);
  const topCats = useDb(() => topExpenseCategories(addDays(todayLocal(), -29)));
  const mf = useDb(() => aggregate(computeHoldings(), 'family')[0]);
  const sip = useDb(() => sipTotals());
  const [groupTab, setGroupTab] = useState<'person' | 'bank'>('person');
  const today = todayLocal();

  if (!byBank.length && !byPerson.length && !mf) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="Welcome to Artha"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link to="/family">
                <Button variant="secondary">1. Add family</Button>
              </Link>
              <Link to="/banks">
                <Button variant="secondary">2. Add banks</Button>
              </Link>
              <Link to="/accounts">
                <Button>3. Add accounts</Button>
              </Link>
            </div>
          }
        >
          Start by adding your family members, then banks, then accounts.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dashboard" subtitle={formatDate(today)} />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total bank balance" value={<Money paise={total} colored />} />
        <Stat label="Income · 30 days" value={<Money paise={flow.Income} />} />
        <Stat label="Expense · 30 days" value={<Money paise={flow.Expense} />} />
        <Stat
          label="Net · 30 days"
          value={<Money paise={flow.Income - flow.Expense} colored />}
          sub={
            flow.Invested ? (
              <>
                Invested <Money paise={flow.Invested} />
              </>
            ) : undefined
          }
        />
      </div>

      {(mf || sip.count > 0) && (
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Link
            to="/mf"
            className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-500 lg:col-span-2 dark:border-slate-800 dark:bg-slate-900"
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">Mutual funds</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <Money paise={mf?.value ?? 0} className="text-2xl font-semibold" />
              {mf && <Gain value={mf.gain} base={mf.invested} className="text-sm" />}
              <span className="text-sm text-slate-500">
                SIP <Money paise={sip.monthly} />
                /month
              </span>
            </div>
          </Link>
          <PendingSips limit={3} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <FlowChart />
        <Card title="Balances">
          <Tabs
            value={groupTab}
            onChange={setGroupTab}
            tabs={[
              { id: 'person', label: 'By person' },
              { id: 'bank', label: 'By bank' },
            ]}
          />
          {groupTab === 'person' ? (
            <BarList rows={byPerson} />
          ) : (
            <BarList rows={byBank} link={(r) => (r.Id ? `/accounts?bank=${r.Id}` : undefined)} />
          )}
          <p className="mt-3 text-xs text-slate-500">
            Joint accounts count under the primary holder.
          </p>
        </Card>

        <Card title="Maturities (PPF, SSY, FD, RD)" className="lg:col-span-2">
          {maturities.length === 0 ? (
            <p className="text-sm text-slate-500">
              Add a maturity date to deposit accounts to track them here.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {maturities.map((m) => {
                const d = daysBetween(today, m.MaturityDate);
                return (
                  <li
                    key={m.AccountId}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <Link to={`/accounts/${m.AccountId}`} className="min-w-0 hover:underline">
                      <span className="font-medium">{m.TypeLabel}</span>{' '}
                      <span className="text-slate-500">
                        · {m.BankName} ··{m.AccountNumberLast4}
                        {m.Holder && ` · ${m.Holder}`}
                      </span>
                    </Link>
                    <span className="flex items-center gap-2">
                      <Money paise={m.CurrentBalance} className="text-slate-500" />
                      <Badge tone={d < 0 ? 'slate' : d <= 90 ? 'amber' : 'brand'}>
                        {formatDate(m.MaturityDate)}
                        {d < 0 ? ' · matured' : d <= 365 ? ` · ${d}d` : ''}
                      </Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Top expenses · 30 days">
          {topCats.length === 0 ? (
            <p className="text-sm text-slate-500">No expenses recorded in the last 30 days.</p>
          ) : (
            <BarList
              rows={topCats.map((c) => ({
                Id: null,
                Name: c.Name,
                Total: c.Total,
                AccountCount: 0,
              }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
