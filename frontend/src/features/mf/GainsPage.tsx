import { useMemo, useState } from 'react';
import { useDb } from '@/app/session';
import { financialYear, formatDate, todayLocal } from '@/lib/dates';
import { formatINR } from '@/lib/money';
import { formatUnits } from '@/lib/units';
import { capitalGainsForFy, fysWithGains } from '@/repositories/mfPortfolio';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, Select } from '@/components/ui';
import { Money } from '@/components/inputs';
import { toastError } from '@/components/toast';
import type { GainRow } from './calc/tax';
import { Gain, MFNav } from './components';

const CLASS_LABEL = { EQUITY: 'Equity', DEBT: 'Debt', OTHER: 'Other' } as const;
const rupees = (p: number) => (p / 100).toFixed(2);

function exportRows(rows: GainRow[]) {
  return rows.map((r) => ({
    Person: r.personName,
    Fund: r.fundLabel,
    'Tax class': CLASS_LABEL[r.taxClass],
    Term: r.term === 'LT' ? 'Long term' : 'Short term',
    'Buy date': r.buyDate,
    'Sell date': r.sellDate,
    Units: formatUnits(r.units).replace(/,/g, ''),
    'Cost (₹)': rupees(r.cost),
    'Cost for tax (₹)': rupees(r.taxCost),
    Grandfathered: r.grandfathered ? 'Yes' : '',
    'Sale value (₹)': rupees(r.proceeds),
    'Gain (₹)': rupees(r.taxGain),
    'Rate %': r.rate ?? 'Slab',
  }));
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function GainsPage() {
  const fys = useDb(() => {
    const list = fysWithGains();
    const current = financialYear(todayLocal());
    return list.includes(current) ? list : [current, ...list];
  });
  const [fy, setFy] = useState(fys[0]);
  const data = useDb(() => capitalGainsForFy(fy), [fy]);
  const totals = useMemo(() => data.rows.reduce((s, r) => s + r.taxGain, 0), [data]);

  const csv = () => {
    const rows = exportRows(data.rows);
    if (!rows.length) return;
    const head = Object.keys(rows[0]);
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const text = [
      head.map(esc).join(','),
      ...rows.map((r) => head.map((h) => esc(r[h as keyof typeof r])).join(',')),
    ].join('\n');
    download(`artha-capital-gains-${fy}.csv`, new Blob([text], { type: 'text/csv' }));
  };
  const xlsx = async () => {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          data.summary.map((s) => ({
            Person: s.personName,
            'Equity STCG (₹)': rupees(s.equityST),
            'Equity LTCG (₹)': rupees(s.equityLT),
            'LTCG exemption (₹)': rupees(s.equityLTExemption),
            'Taxable equity LTCG (₹)': rupees(s.equityLTTaxable),
            'Other LTCG (₹)': rupees(s.otherLT),
            'Slab-rate STCG (₹)': rupees(s.slabST),
            'Estimated fixed-rate tax (₹)': rupees(s.estimatedFixedRateTax),
          })),
        ),
        'Summary',
      );
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows(data.rows)), 'Details');
      const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      download(
        `artha-capital-gains-${fy}.xlsx`,
        new Blob([out], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <PageHeader
        title="Mutual funds"
        actions={
          <>
            <Button variant="secondary" disabled={!data.rows.length} onClick={csv}>
              Export CSV
            </Button>
            <Button variant="secondary" disabled={!data.rows.length} onClick={xlsx}>
              Export XLSX
            </Button>
          </>
        }
      />
      <MFNav />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="w-40">
          <Field label="Financial year">
            <Select value={fy} onChange={(e) => setFy(e.target.value)}>
              {fys.map((f) => (
                <option key={f} value={f}>
                  FY {f}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="pb-2 text-sm text-slate-500">
          Realised gains (FIFO) on redemptions and switch-outs, 1 Apr – 31 Mar. Total{' '}
          <Gain value={totals} />
        </p>
      </div>
      <div className="mb-4">
        <Alert>
          {data.rules.note} Surcharge and cess are not included; slab-rate gains depend on your
          income.
        </Alert>
      </div>
      {!data.rows.length ? (
        <EmptyState title={`No realised gains in FY ${fy}`} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.summary.map((s) => (
              <Card key={s.personId} title={s.personName}>
                <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
                  <dt className="text-slate-500">Equity STCG</dt>
                  <dd className="text-right">
                    <Gain value={s.equityST} />
                  </dd>
                  <dt className="text-slate-500">Equity LTCG</dt>
                  <dd className="text-right">
                    <Gain value={s.equityLT} />
                  </dd>
                  <dt className="text-slate-500">LTCG exemption used</dt>
                  <dd className="text-right">
                    <Money paise={s.equityLTExemption} />
                  </dd>
                  <dt className="text-slate-500">Taxable equity LTCG</dt>
                  <dd className="text-right">
                    <Money paise={s.equityLTTaxable} />
                  </dd>
                  <dt className="text-slate-500">Debt / other LTCG</dt>
                  <dd className="text-right">
                    <Gain value={s.otherLT} />
                  </dd>
                  <dt className="text-slate-500">Slab-rate STCG</dt>
                  <dd className="text-right">
                    <Gain value={s.slabST} />
                  </dd>
                  <dt className="border-t border-slate-100 pt-1.5 font-medium dark:border-slate-800">
                    Estimated tax (fixed-rate part)
                  </dt>
                  <dd className="border-t border-slate-100 pt-1.5 text-right font-medium dark:border-slate-800">
                    <Money paise={s.estimatedFixedRateTax} />
                  </dd>
                </dl>
              </Card>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2">Fund · person</th>
                  <th className="px-3 py-2">Bought</th>
                  <th className="px-3 py-2">Sold</th>
                  <th className="px-3 py-2 text-right">Units</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Sale value</th>
                  <th className="px-3 py-2 text-right">Gain</th>
                  <th className="px-3 py-2">Term</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.rows.map((r, i) => (
                  <tr key={`${r.sellTxnId}-${r.buyTxnId}-${i}`}>
                    <td className="px-3 py-2">
                      {r.fundLabel}
                      <div className="text-xs text-slate-500">{r.personName}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{formatDate(r.buyDate)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatDate(r.sellDate)}</td>
                    <td className="num px-3 py-2 text-right">{formatUnits(r.units)}</td>
                    <td className="px-3 py-2 text-right">
                      <Money paise={r.taxCost} />
                      {r.grandfathered && (
                        <div className="text-xs text-slate-500">
                          grandfathered (actual {formatINR(r.cost)})
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money paise={r.proceeds} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Gain value={r.taxGain} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={r.term === 'LT' ? 'brand' : 'amber'}>
                        {CLASS_LABEL[r.taxClass]} {r.term}
                      </Badge>
                      <span className="ml-1 text-xs text-slate-500">
                        {r.rate != null ? `${r.rate}%` : 'slab'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
