import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatDate } from '@/lib/dates';
import { formatNav, formatUnits, percent } from '@/lib/units';
import { planVariant } from '@/repositories/mfFunds';
import { aggregate, computeHoldings } from '@/repositories/mfPortfolio';
import { Card, EmptyState, Field, PageHeader } from '@/components/ui';
import { Money, PersonSelect } from '@/components/inputs';
import { Gain, MFNav, Rate } from './components';
import { RefreshNavButton } from './MFDashboard';

export function PortfolioPage() {
  const [personId, setPersonId] = useState('');
  const all = useDb(() => computeHoldings());
  const holdings = useMemo(
    () => all.filter((h) => !personId || h.PersonId === Number(personId)),
    [all, personId],
  );
  const total = aggregate(holdings, 'family')[0];

  return (
    <>
      <PageHeader title="Mutual funds" actions={<RefreshNavButton />} />
      <MFNav />
      <Card className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="w-56">
            <Field label="Person">
              <PersonSelect
                placeholder="Everyone"
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
              />
            </Field>
          </div>
          {total && (
            <div className="flex flex-wrap gap-6 text-sm">
              <span>
                Invested <Money paise={total.invested} className="font-medium" />
              </span>
              <span>
                Value <Money paise={total.value} className="font-medium" />
              </span>
              <span>
                Gain <Gain value={total.gain} base={total.invested} />
              </span>
              <span>
                XIRR <Rate r={total.xirr} className="font-medium" />
              </span>
            </div>
          )}
        </div>
      </Card>
      {!holdings.length ? (
        <EmptyState title="No holdings">
          Transactions you add, confirm or import appear here.
        </EmptyState>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2">Fund</th>
                  <th className="px-3 py-2">Person · folio</th>
                  <th className="px-3 py-2 text-right">Units</th>
                  <th className="px-3 py-2 text-right">Avg cost</th>
                  <th className="px-3 py-2 text-right">Invested</th>
                  <th className="px-3 py-2 text-right">NAV</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-3 py-2 text-right">Gain</th>
                  <th className="px-3 py-2 text-right">XIRR</th>
                  <th className="px-3 py-2 text-right">ST / LT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {holdings.map((h) => (
                  <tr key={h.key} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="max-w-xs px-3 py-2">
                      <Link
                        to={`/mf/plans/${h.MutualFundPlanId}`}
                        className="font-medium hover:underline"
                      >
                        {h.FundName}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {planVariant(h)} · {h.Category}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {h.PersonName}
                      <div className="text-slate-500">{h.FolioNo ?? 'no folio'}</div>
                    </td>
                    <td className="num px-3 py-2 text-right">{formatUnits(h.units)}</td>
                    <td className="num px-3 py-2 text-right">
                      {h.avgCost ? formatNav(h.avgCost) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money paise={h.invested} />
                    </td>
                    <td className="num px-3 py-2 text-right">
                      {h.nav ? formatNav(h.nav) : '—'}
                      <div className="text-xs text-slate-500">{formatDate(h.navDate)}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-medium">
                      <Money paise={h.value} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Gain value={h.gain} />
                      <div className="text-xs">
                        {h.invested ? `${percent(h.gain, h.invested)}%` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Rate r={h.xirr} />
                    </td>
                    <td className="num px-3 py-2 text-right text-xs">
                      {percent(h.stUnits, h.units, 0)}% / {percent(h.ltUnits, h.units, 0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
            {holdings.map((h) => (
              <Link
                key={h.key}
                to={`/mf/plans/${h.MutualFundPlanId}`}
                className="block rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{h.FundName}</p>
                    <p className="truncate text-xs text-slate-500">
                      {h.PersonName} · {h.FolioNo ?? 'no folio'} · {formatUnits(h.units)} units
                    </p>
                  </div>
                  <div className="text-right">
                    <Money paise={h.value} className="font-semibold" />
                    <p className="text-xs">
                      <Gain value={h.gain} base={h.invested} className="text-xs" />
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Invested <Money paise={h.invested} /> · XIRR <Rate r={h.xirr} />
                </p>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
