import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatDateTime } from '@/lib/dates';
import { scalar } from '@/db/sql';
import { aggregate, computeHoldings, valueSeries, type GroupBy } from '@/repositories/mfPortfolio';
import { lastNavRefresh } from '@/repositories/mfNav';
import { sipTotals } from '@/repositories/sips';
import { Alert, Button, Card, EmptyState, PageHeader, Tabs } from '@/components/ui';
import { Money } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';
import { Gain, MFNav, Rate, SplitList, Stat } from './components';
import { ValueChart } from './charts';
import { PendingSips } from './SipsPage';
import { refreshNavs } from './navService';

export function RefreshNavButton() {
  const [busy, setBusy] = useState(false);
  const last = useDb(lastNavRefresh);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="hidden text-xs text-slate-500 sm:inline">
        {last ? `NAV ${formatDateTime(last)}` : 'NAV never refreshed'}
      </span>
      <Button
        variant="secondary"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await refreshNavs(true);
            toast(
              `NAV refreshed: ${r.matched} plan${r.matched === 1 ? '' : 's'} matched${r.unmatched.length ? `, ${r.unmatched.length} not found` : ''}`,
            );
          } catch (e) {
            toastError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Refresh NAV
      </Button>
    </span>
  );
}

const SPLITS: { id: GroupBy; label: string }[] = [
  { id: 'person', label: 'Person' },
  { id: 'category', label: 'Category' },
  { id: 'subCategory', label: 'Sub-category' },
  { id: 'amc', label: 'AMC' },
];

export function MFDashboard() {
  const holdings = useDb(() => computeHoldings());
  const series = useDb(() => valueSeries({ months: 36 }));
  const sip = useDb(() => sipTotals());
  const counts = useDb(() => ({
    plans: scalar<number>('SELECT COUNT(*) FROM MutualFundPlan') ?? 0,
    accounts: scalar<number>('SELECT COUNT(*) FROM InvestmentAccount') ?? 0,
  }));
  const [split, setSplit] = useState<GroupBy>('person');
  const family = aggregate(holdings, 'family')[0];
  const splitRows = aggregate(holdings, split);
  const shortfall = holdings.filter((h) => h.shortfall > 0);
  const noNav = holdings.filter((h) => !h.nav);

  return (
    <>
      <PageHeader title="Mutual funds" actions={<RefreshNavButton />} />
      <MFNav />
      {!holdings.length && sip.count === 0 ? (
        <>
          <div className="mb-4">
            <PendingSips limit={5} />
          </div>
          <EmptyState
            title="Start tracking mutual funds"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link to="/mf/accounts">
                  <Button variant="secondary">
                    1. Investment accounts{counts.accounts ? ` (${counts.accounts})` : ''}
                  </Button>
                </Link>
                <Link to="/mf/funds">
                  <Button variant="secondary">
                    2. Add funds{counts.plans ? ` (${counts.plans})` : ''}
                  </Button>
                </Link>
                <Link to="/mf/sips">
                  <Button variant="secondary">3. SIPs</Button>
                </Link>
                <Link to="/mf/import">
                  <Button>Or import a CAS</Button>
                </Link>
              </div>
            }
          >
            Add an investment account per person and platform, then funds and SIPs — or import your
            CAMS/KFintech CAS to set everything up at once.
          </EmptyState>
        </>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Current value" value={<Money paise={family?.value ?? 0} />} />
            <Stat label="Invested" value={<Money paise={family?.invested ?? 0} />} />
            <Stat
              label="Gain"
              value={<Gain value={family?.gain ?? 0} />}
              sub={
                family?.invested ? (
                  <Gain value={family.gain} base={family.invested} className="text-xs" />
                ) : undefined
              }
            />
            <Stat
              label="XIRR"
              value={<Rate r={family?.xirr} />}
              sub={
                <>
                  Monthly SIP <Money paise={sip.monthly} /> · <Money paise={sip.annual} />
                  /yr
                </>
              }
            />
          </div>
          {(shortfall.length > 0 || noNav.length > 0) && (
            <div className="mb-4 space-y-2">
              {shortfall.length > 0 && (
                <Alert tone="red">
                  Some redemptions exceed recorded purchases (
                  {shortfall.map((h) => h.FundName).join(', ')}). Import a CAS from the start, or
                  add the missing purchases.
                </Alert>
              )}
              {noNav.length > 0 && (
                <Alert>
                  No NAV yet for {noNav.map((h) => h.FundName).join(', ')}; values use cost. Refresh
                  NAV.
                </Alert>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Invested vs value" className="lg:col-span-2">
              <ValueChart points={series} />
            </Card>
            <div className="space-y-4">
              <PendingSips limit={5} />
              <Card title="Split">
                <Tabs tabs={SPLITS} value={split} onChange={setSplit} />
                <SplitList rows={splitRows} />
              </Card>
            </div>
            <Card title="Top holdings" className="lg:col-span-3">
              <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {holdings.slice(0, 8).map((h) => (
                  <li
                    key={h.key}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <Link
                      to={`/mf/plans/${h.MutualFundPlanId}`}
                      className="min-w-0 hover:underline"
                    >
                      <span className="font-medium">{h.FundName}</span>
                      <span className="text-xs text-slate-500"> · {h.PersonName}</span>
                    </Link>
                    <span className="flex items-center gap-3">
                      <Money paise={h.value} className="font-medium" />
                      <Gain value={h.gain} base={h.invested} className="text-xs" />
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to="/mf/portfolio"
                className="mt-2 inline-block text-sm text-brand-700 hover:underline dark:text-brand-500"
              >
                Full portfolio →
              </Link>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
