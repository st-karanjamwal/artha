import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTheme } from '@/app/theme';
import { formatDate } from '@/lib/dates';
import { formatINR, formatINRCompact } from '@/lib/money';
import { formatNav } from '@/lib/units';
import { Button } from '@/components/ui';
import type { ValuePoint } from '@/repositories/mfPortfolio';
import type { NavPoint } from '@/repositories/mfNav';

// Validated categorical slots 1–2 (same as the main dashboard).
const SERIES = {
  light: {
    a: '#2a78d6',
    b: '#eb6834',
    grid: '#e2e8f0',
    tick: '#64748b',
    bg: '#fff',
    border: '#e2e8f0',
    text: '#0f172a',
  },
  dark: {
    a: '#3987e5',
    b: '#d95926',
    grid: '#334155',
    tick: '#94a3b8',
    bg: '#0f172a',
    border: '#334155',
    text: '#f1f5f9',
  },
};

function useColors() {
  const [theme] = useTheme();
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? SERIES.dark : SERIES.light;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthTick = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ’${iso.slice(2, 4)}`;

export function ValueChart({ points }: { points: ValuePoint[] }) {
  const c = useColors();
  const [table, setTable] = useState(false);
  if (points.length < 2) {
    return (
      <p className="text-sm text-slate-500">
        The chart appears once there are at least two months of history.
      </p>
    );
  }
  const data = points.map((p) => ({
    date: p.date,
    Invested: p.invested / 100,
    Value: p.value / 100,
  }));
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setTable((x) => !x)}>
          {table ? 'Chart' : 'Table'}
        </Button>
      </div>
      {table ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1">Month end</th>
                <th className="py-1 text-right">Invested</th>
                <th className="py-1 text-right">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {points.map((p) => (
                <tr key={p.date}>
                  <td className="py-1.5">{formatDate(p.date)}</td>
                  <td className="num py-1.5 text-right">{formatINR(p.invested)}</td>
                  <td className="num py-1.5 text-right">{formatINR(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={c.grid} />
              <XAxis
                dataKey="date"
                tickFormatter={monthTick}
                tickLine={false}
                axisLine={false}
                minTickGap={16}
                tick={{ fontSize: 11, fill: c.tick }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tick={{ fontSize: 11, fill: c.tick }}
                tickFormatter={(v: number) => formatINRCompact(v * 100)}
              />
              <Tooltip
                labelFormatter={(l) => formatDate(String(l))}
                formatter={(v) => formatINR(Math.round(Number(v) * 100))}
                contentStyle={{
                  borderRadius: 8,
                  fontSize: 12,
                  background: c.bg,
                  border: `1px solid ${c.border}`,
                  color: c.text,
                }}
              />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} itemSorter={null} />
              <Line
                type="monotone"
                dataKey="Invested"
                stroke={c.a}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="Value"
                stroke={c.b}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export function NavChart({ points }: { points: NavPoint[] }) {
  const c = useColors();
  if (points.length < 2)
    return (
      <p className="text-sm text-slate-500">Not enough NAV history yet. Use “Load NAV history”.</p>
    );
  const data = points.map((p) => ({ date: p.NAVDate, nav: p.NAV / 1e6 }));
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis
            dataKey="date"
            tickFormatter={monthTick}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            tick={{ fontSize: 11, fill: c.tick }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            domain={['auto', 'auto']}
            tick={{ fontSize: 11, fill: c.tick }}
          />
          <Tooltip
            labelFormatter={(l) => formatDate(String(l))}
            formatter={(v) => [`₹${formatNav(Math.round(Number(v) * 1e6))}`, 'NAV']}
            contentStyle={{
              borderRadius: 8,
              fontSize: 12,
              background: c.bg,
              border: `1px solid ${c.border}`,
              color: c.text,
            }}
          />
          <Line
            type="monotone"
            dataKey="nav"
            stroke={c.a}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
