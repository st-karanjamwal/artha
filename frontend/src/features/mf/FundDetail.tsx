import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatDate } from '@/lib/dates';
import { formatBps, formatNav, formatUnits } from '@/lib/units';
import { getPlan, planVariant } from '@/repositories/mfFunds';
import { navSeries } from '@/repositories/mfNav';
import { computeHoldings } from '@/repositories/mfPortfolio';
import { listSips } from '@/repositories/sips';
import { Badge, Button, Card, DefinitionList, EmptyState, PageHeader } from '@/components/ui';
import { Money } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';
import { Gain, MFNav, Rate } from './components';
import { NavChart } from './charts';
import { MFTxnForm, MFTxnTable, SwitchWizard } from './MFTransactionsPage';
import { backfillNavHistory } from './navService';

export function FundDetail() {
  const id = Number(useParams().id);
  const plan = useDb(() => getPlan(id), [id]);
  const holdings = useDb(
    () => computeHoldings({ includeClosed: true }).filter((h) => h.MutualFundPlanId === id),
    [id],
  );
  const navs = useDb(() => navSeries(id), [id]);
  const sips = useDb(() => listSips({ planId: id }), [id]);
  const [adding, setAdding] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!plan)
    return <EmptyState title="Fund not found" action={<Link to="/mf/funds">Back to funds</Link>} />;
  const open = holdings.filter((h) => h.units > 0);
  const first = open[0];

  return (
    <>
      <PageHeader
        title={plan.FundName}
        subtitle={
          <>
            {plan.AMCName} · {planVariant(plan)} · {plan.Category ?? '—'}
            {plan.SubCategory && ` / ${plan.SubCategory}`}
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setSwitching(true)}>
              Switch
            </Button>
            <Button onClick={() => setAdding(true)}>Add transaction</Button>
          </>
        }
      />
      <MFNav />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Plan" className="lg:col-span-1">
          <DefinitionList
            items={[
              [
                'Latest NAV',
                plan.LatestNAV
                  ? `₹${formatNav(plan.LatestNAV)} (${formatDate(plan.LatestNAVDate)})`
                  : '—',
              ],
              ['AMFI scheme code', plan.SchemeCode],
              ['ISIN', plan.ISIN && <span className="font-mono">{plan.ISIN}</span>],
              [
                'ISIN (reinvest)',
                plan.ISINReinvest && <span className="font-mono">{plan.ISINReinvest}</span>,
              ],
              [
                'Expense ratio',
                plan.ExpenseRatioBps != null ? `${formatBps(plan.ExpenseRatioBps)}%` : '',
              ],
              ['Exit load', plan.ExitLoad],
              ['Risk', plan.RiskLevel],
              [
                'Status',
                plan.Status !== 'ACTIVE' ? (
                  <Badge tone="red">{plan.Status.toLowerCase()}</Badge>
                ) : (
                  ''
                ),
              ],
            ]}
          />
        </Card>
        <Card
          title="NAV history"
          className="lg:col-span-2"
          actions={
            <Button
              size="sm"
              variant="secondary"
              busy={busy}
              disabled={!plan.SchemeCode}
              onClick={async () => {
                setBusy(true);
                try {
                  const n = await backfillNavHistory(id);
                  toast(`Loaded ${n} NAV points`);
                } catch (e) {
                  toastError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Load NAV history
            </Button>
          }
        >
          <NavChart points={navs} />
          <p className="mt-2 text-xs text-slate-500">
            History comes from public data via your server (mfapi.in); daily NAVs from AMFI.
          </p>
        </Card>

        {holdings.map((h) => (
          <Card
            key={h.key}
            className="lg:col-span-3"
            title={
              <span>
                {h.PersonName} · {h.FolioNo ?? 'no folio'}
                <span className="block text-xs font-normal text-slate-500">{h.AccountName}</span>
              </span>
            }
          >
            <div className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-6">
              <div>
                <p className="text-xs text-slate-500">Units</p>
                <p className="num font-medium">{formatUnits(h.units)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Invested</p>
                <Money paise={h.invested} className="font-medium" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Value</p>
                <Money paise={h.value} className="font-medium" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Unrealised</p>
                <Gain value={h.gain} base={h.invested} />
              </div>
              <div>
                <p className="text-xs text-slate-500">Realised</p>
                <Gain value={h.realisedGain} />
              </div>
              <div>
                <p className="text-xs text-slate-500">XIRR</p>
                <Rate r={h.xirr} className="font-medium" />
              </div>
            </div>
            {h.lots.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-brand-700 dark:text-brand-500">
                  Open lots (FIFO) · {h.lots.length}
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="py-1">Bought</th>
                        <th className="py-1">Type</th>
                        <th className="py-1 text-right">Units left</th>
                        <th className="py-1 text-right">Cost left</th>
                        <th className="py-1 text-right">Cost / unit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {h.lots.map((l) => (
                        <tr key={l.txnId}>
                          <td className="py-1.5">{formatDate(l.date)}</td>
                          <td className="py-1.5 text-xs">
                            {l.type.toLowerCase().replace('_', ' ')}
                          </td>
                          <td className="num py-1.5 text-right">{formatUnits(l.units)}</td>
                          <td className="py-1.5 text-right">
                            <Money paise={l.cost} />
                          </td>
                          <td className="num py-1.5 text-right">
                            {l.units
                              ? formatNav(Math.round((l.cost / 100 / (l.units / 1e6)) * 1e6))
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </Card>
        ))}

        {sips.length > 0 && (
          <Card title="SIPs" className="lg:col-span-3">
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {sips.map((s) => (
                <li key={s.SIPId} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    {s.PersonName} · <Money paise={s.SIPAmount} />{' '}
                    {s.Frequency.toLowerCase().replace('_', '-')}
                  </span>
                  <Badge tone={s.Status === 'ACTIVE' ? 'green' : 'slate'}>
                    {s.Status.toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="lg:col-span-3">
          <h2 className="mb-2 font-semibold">Transactions</h2>
          <MFTxnTable filter={{ planId: id }} compact />
        </div>
      </div>
      {adding && (
        <MFTxnForm
          txn={null}
          defaults={{ planId: id, accountId: first?.InvestmentAccountId, folioId: first?.FolioId }}
          onClose={() => setAdding(false)}
        />
      )}
      {switching && (
        <SwitchWizard
          defaults={{ planId: id, accountId: first?.InvestmentAccountId, folioId: first?.FolioId }}
          onClose={() => setSwitching(false)}
        />
      )}
    </>
  );
}
