import { useMemo, useState } from 'react';
import { useDb } from '@/app/session';
import { DATE_FORMATS, formatDate, formatDateTime, type DateFormat } from '@/lib/dates';
import { formatUnits } from '@/lib/units';
import { readStatementFile, type Cell, type Grid } from '@/repositories/imports';
import {
  commitCasImport,
  commitCsvImport,
  getMfMapping,
  guessMfCsvMapping,
  listMfImportBatches,
  negativeHoldings,
  prepareCasImport,
  prepareCsvImport,
  saveMfMapping,
  undoMfImport,
  type ImportRow,
  type MFCsvMapping,
  type PreparedImport,
} from '@/repositories/mfImport';
import { listLookups } from '@/repositories/lookups';
import { TXN_TYPE_LABEL } from '@/repositories/mfTransactions';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Tabs,
  cx,
} from '@/components/ui';
import { Money } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';
import { parseCasLines, type CasResult } from './cas';
import { extractPdfLines, PdfPasswordError } from './pdf';
import { InvestmentAccountSelect, MFNav } from './components';

function PreviewTable({ rows, onToggle }: { rows: ImportRow[]; onToggle: (r: ImportRow) => void }) {
  return (
    <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-800">
          <tr>
            <th className="px-2 py-2">Date</th>
            <th className="px-2 py-2">Scheme · folio</th>
            <th className="px-2 py-2">Type</th>
            <th className="px-2 py-2 text-right">Units</th>
            <th className="px-2 py-2 text-right">Amount</th>
            <th className="px-2 py-2">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r) => (
            <tr
              key={r.line}
              className={cx(
                r.status === 'error' && 'bg-red-50 dark:bg-red-950/30',
                r.status === 'duplicate' && 'opacity-60',
              )}
            >
              <td className="whitespace-nowrap px-2 py-1.5">{r.date ? formatDate(r.date) : '—'}</td>
              <td className="max-w-xs px-2 py-1.5">
                <span className="line-clamp-1">{r.schemeName}</span>
                <span className="text-xs text-slate-500">
                  {r.folioNumber ?? 'no folio'}
                  {!r.planId && r.status !== 'error' && ' · new fund'}
                </span>
              </td>
              <td className="px-2 py-1.5 text-xs">{TXN_TYPE_LABEL[r.type]}</td>
              <td className="num px-2 py-1.5 text-right">{r.units ? formatUnits(r.units) : '—'}</td>
              <td className="px-2 py-1.5 text-right">
                <Money paise={r.amount} />
              </td>
              <td className="px-2 py-1.5">
                {r.status === 'error' ? (
                  <Badge tone="red">{r.error}</Badge>
                ) : r.status === 'duplicate' ? (
                  <button className="text-xs underline" onClick={() => onToggle(r)}>
                    Duplicate · import anyway
                  </button>
                ) : r.forced ? (
                  <button className="text-xs underline" onClick={() => onToggle(r)}>
                    Forced · undo
                  </button>
                ) : (
                  <Badge tone="green">New</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useForcing(prepared: PreparedImport | null) {
  const [forced, setForced] = useState<Set<number>>(new Set());
  const rows = useMemo(
    () =>
      (prepared?.rows ?? []).map((r) =>
        forced.has(r.line) && r.status === 'duplicate'
          ? { ...r, status: 'new' as const, forced: true }
          : r,
      ),
    [prepared, forced],
  );
  const toggle = (r: ImportRow) =>
    setForced((s) => {
      const n = new Set(s);
      if (n.has(r.line)) n.delete(r.line);
      else n.add(r.line);
      return n;
    });
  return { rows, toggle, reset: () => setForced(new Set()) };
}

function CasImport() {
  const [accountId, setAccountId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cas, setCas] = useState<CasResult | null>(null);
  const prepared = useDb(() => (cas ? prepareCasImport(cas) : null), [cas]);
  const { rows, toggle, reset } = useForcing(prepared);

  const parse = async () => {
    if (!file) return toastError('Choose the CAS PDF');
    setBusy(true);
    try {
      const lines = await extractPdfLines(await file.arrayBuffer(), password || undefined);
      const result = parseCasLines(lines);
      if (!result.schemes.length)
        throw new Error('No schemes found. Is this a detailed CAMS/KFintech CAS?');
      setCas(result);
      setNeedPassword(false);
      reset();
    } catch (e) {
      if (e instanceof PdfPasswordError) {
        setNeedPassword(true);
        toastError(e.incorrect ? 'Incorrect password' : 'Enter the CAS password');
      } else toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const commit = () => {
    if (!cas || !prepared) return;
    if (!accountId) return toastError('Choose the investment account (person) for new folios');
    try {
      const id = commitCasImport(
        { ...prepared, rows },
        cas,
        Number(accountId),
        file?.name ?? 'cas.pdf',
      );
      toast(`Imported (batch #${id})`);
      setCas(null);
      setFile(null);
      setPassword('');
      const neg = negativeHoldings();
      if (neg.length)
        toastError(`Some holdings are now negative: ${neg.map((n) => n.label).join(', ')}`);
    } catch (e) {
      toastError(e);
    }
  };

  const mismatches = prepared?.recon.filter((r) => r.diff != null && r.diff !== 0) ?? [];
  const newCount = rows.filter((r) => r.status === 'new').length;

  return (
    <>
      <Card className="mb-4">
        <p className="mb-3 text-sm text-slate-500">
          Request a <strong>detailed</strong> CAS from CAMS or KFintech (ideally since inception).
          The PDF is opened and read in this browser only; it is never uploaded.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field
            label="Investment account for new folios"
            required
            hint="The person the CAS belongs to (by PAN)"
          >
            <InvestmentAccountSelect
              placeholder="Select…"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </Field>
          <Field label="CAS PDF" required>
            <Input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setCas(null);
              }}
            />
          </Field>
          <Field
            label="PDF password"
            hint={
              needPassword
                ? 'The password you set when requesting the CAS'
                : 'If the PDF is protected'
            }
          >
            <Input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button busy={busy} disabled={!file} onClick={parse}>
            Read CAS
          </Button>
        </div>
      </Card>

      {cas && prepared && (
        <>
          <Card className="mb-4" title="Reconciliation">
            <p className="mb-3 text-sm text-slate-500">
              {cas.periodFrom &&
                `Statement ${formatDate(cas.periodFrom)} – ${formatDate(cas.periodTo)} · `}
              {cas.schemes.length} schemes. Closing units in the CAS vs units in Artha after this
              import.
            </p>
            {mismatches.length === 0 ? (
              <Alert tone="brand">
                ✓ All {prepared.recon.length} schemes match the CAS closing units.
              </Alert>
            ) : (
              <Alert tone="red">{mismatches.length} scheme(s) don't match; see below.</Alert>
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1">Scheme · folio</th>
                    <th className="py-1 text-right">CAS closing</th>
                    <th className="py-1 text-right">Already in Artha</th>
                    <th className="py-1 text-right">This import</th>
                    <th className="py-1 text-right">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {prepared.recon.map((r) => (
                    <tr
                      key={`${r.folioNumber}-${r.isin}`}
                      className={cx(r.diff ? 'bg-red-50 dark:bg-red-950/30' : '')}
                    >
                      <td className="py-1.5">
                        {r.schemeName}
                        <div className="text-xs text-slate-500">
                          {r.folioNumber} · {r.isin}
                          {r.openingMissing &&
                            ' · opening balance not in Artha (request CAS since inception)'}
                        </div>
                      </td>
                      <td className="num py-1.5 text-right">
                        {r.statementClosing != null ? formatUnits(r.statementClosing) : '—'}
                      </td>
                      <td className="num py-1.5 text-right">{formatUnits(r.existingBefore)}</td>
                      <td className="num py-1.5 text-right">{formatUnits(r.imported)}</td>
                      <td
                        className={cx(
                          'num py-1.5 text-right',
                          r.diff
                            ? 'font-medium text-red-600'
                            : 'text-emerald-700 dark:text-emerald-400',
                        )}
                      >
                        {r.diff == null ? '—' : formatUnits(r.diff)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {prepared.warnings.length > 0 && (
            <details className="mb-4">
              <summary className="cursor-pointer text-sm text-amber-700 dark:text-amber-400">
                {prepared.warnings.length} lines were not understood
              </summary>
              <ul className="mt-2 space-y-1 font-mono text-xs text-slate-500">
                {prepared.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <Card className="mb-4" title="Transactions">
            <div className="mb-3 flex flex-wrap gap-2 text-sm">
              <Badge tone="green">{newCount} new</Badge>
              <Badge tone="amber">
                {rows.filter((r) => r.status === 'duplicate').length} duplicates
              </Badge>
              {rows.some((r) => r.status === 'error') && (
                <Badge tone="red">{rows.filter((r) => r.status === 'error').length} errors</Badge>
              )}
            </div>
            <PreviewTable rows={rows} onToggle={toggle} />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCas(null)}>
                Cancel
              </Button>
              <Button disabled={!newCount} onClick={commit}>
                Import {newCount} transactions
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

const cellText = (c: Cell) =>
  c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c);

function ColumnSelect({
  label,
  header,
  value,
  onChange,
  optional,
}: {
  label: string;
  header: Cell[];
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  optional?: boolean;
}) {
  return (
    <Field label={label} required={!optional}>
      <Select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      >
        <option value="">{optional ? '— none —' : 'Select column…'}</option>
        {header.map((h, i) => (
          <option key={i} value={i}>
            {cellText(h) || `(column ${i + 1})`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const complete = (m: Partial<MFCsvMapping>): m is MFCsvMapping =>
  m.headerRow != null &&
  m.dateCol != null &&
  !!m.dateFormat &&
  m.schemeCol != null &&
  !!m.schemeKind &&
  m.typeCol != null &&
  m.unitsCol != null &&
  m.amountCol != null;

function CsvImport() {
  const platforms = useDb(() => listLookups('InvestmentPlatform'));
  const [accountId, setAccountId] = useState('');
  const [platform, setPlatform] = useState('');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Partial<MFCsvMapping>>({});
  const [remember, setRemember] = useState(true);
  const prepared = useDb(
    () => (grid && complete(mapping) ? prepareCsvImport(grid, mapping) : null),
    [grid, mapping],
  );
  const { rows, toggle, reset } = useForcing(prepared);
  const set = (p: Partial<MFCsvMapping>) => setMapping((m) => ({ ...m, ...p }));
  const header = grid && mapping.headerRow != null ? (grid[mapping.headerRow] ?? []) : [];

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const g = await readStatementFile(f);
      setGrid(g);
      setFileName(f.name);
      reset();
      const saved = platform ? getMfMapping(platform) : null;
      if (saved) setMapping(saved);
      else {
        const headerRow = Math.max(
          0,
          g.findIndex((r) => (r ?? []).some((c) => /date/i.test(String(c ?? '')))),
        );
        setMapping({
          ...guessMfCsvMapping(g[headerRow] ?? []),
          headerRow,
          dateFormat: 'DD/MM/YYYY',
        });
      }
    } catch (e) {
      toastError(e);
    }
  };

  const commit = () => {
    if (!prepared || !complete(mapping)) return;
    if (!accountId) return toastError('Choose the investment account');
    try {
      if (remember && platform) saveMfMapping(platform, mapping);
      const id = commitCsvImport({ ...prepared, rows }, Number(accountId), fileName);
      toast(`Imported (batch #${id})`);
      setGrid(null);
    } catch (e) {
      toastError(e);
    }
  };
  const newCount = rows.filter((r) => r.status === 'new').length;

  return (
    <>
      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Investment account" required>
            <InvestmentAccountSelect
              placeholder="Select…"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </Field>
          <Field label="Platform" hint="Column mapping is remembered per platform">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">—</option>
              {platforms.map((p) => (
                <option key={p.Code} value={p.Label}>
                  {p.Label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Export file (.csv, .xlsx)" required>
            <Input
              key={fileName || 'empty'}
              type="file"
              accept=".csv,.txt,.xlsx,.xls"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </Field>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Funds must already exist (match by ISIN, scheme code or exact fund name). Add missing ones
          under Funds.
        </p>
      </Card>
      {grid && (
        <Card className="mb-4" title="Map columns">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Header row">
              <Input
                type="number"
                min={1}
                value={(mapping.headerRow ?? 0) + 1}
                onChange={(e) => set({ headerRow: Math.max(0, Number(e.target.value) - 1) })}
              />
            </Field>
            <ColumnSelect
              label="Date"
              header={header}
              value={mapping.dateCol}
              onChange={(v) => set({ dateCol: v })}
            />
            <Field label="Date format">
              <Select
                value={mapping.dateFormat}
                onChange={(e) => set({ dateFormat: e.target.value as DateFormat })}
              >
                {DATE_FORMATS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
            <ColumnSelect
              label="Scheme (ISIN / code / name)"
              header={header}
              value={mapping.schemeCol}
              onChange={(v) => set({ schemeCol: v })}
            />
            <Field label="Scheme column contains">
              <Select
                value={mapping.schemeKind}
                onChange={(e) => set({ schemeKind: e.target.value as MFCsvMapping['schemeKind'] })}
              >
                <option value="isin">ISIN</option>
                <option value="code">AMFI scheme code</option>
                <option value="name">Scheme name</option>
              </Select>
            </Field>
            <ColumnSelect
              label="Transaction type"
              header={header}
              value={mapping.typeCol}
              onChange={(v) => set({ typeCol: v })}
            />
            <ColumnSelect
              label="Units"
              header={header}
              value={mapping.unitsCol}
              onChange={(v) => set({ unitsCol: v })}
            />
            <ColumnSelect
              label="NAV / price"
              optional
              header={header}
              value={mapping.navCol}
              onChange={(v) => set({ navCol: v })}
            />
            <ColumnSelect
              label="Amount"
              header={header}
              value={mapping.amountCol}
              onChange={(v) => set({ amountCol: v })}
            />
            <ColumnSelect
              label="Folio"
              optional
              header={header}
              value={mapping.folioCol}
              onChange={(v) => set({ folioCol: v })}
            />
            <ColumnSelect
              label="Stamp duty"
              optional
              header={header}
              value={mapping.stampCol}
              onChange={(v) => set({ stampCol: v })}
            />
          </div>
          {platform && (
            <div className="mt-3">
              <Checkbox
                label={`Remember this mapping for ${platform}`}
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
            </div>
          )}
        </Card>
      )}
      {prepared && (
        <Card className="mb-4" title="Review">
          <PreviewTable rows={rows} onToggle={toggle} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setGrid(null)}>
              Cancel
            </Button>
            <Button disabled={!newCount} onClick={commit}>
              Import {newCount} transactions
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

function History() {
  const batches = useDb(listMfImportBatches);
  const [undoing, setUndoing] = useState<number | null>(null);
  return (
    <Card title="Import history">
      {!batches.length ? (
        <EmptyState title="No imports yet" />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {batches.map((b) => (
            <li
              key={b.ImportBatchId}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{b.FileName}</p>
                <p className="text-xs text-slate-500">
                  {b.Source === 'CAS_IMPORT' ? 'CAS' : 'CSV'} · {formatDateTime(b.ImportedOn)} ·{' '}
                  {b.RowCount} imported, {b.SkippedCount} skipped
                </p>
              </div>
              {b.UndoneOn ? (
                <Badge>Undone</Badge>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setUndoing(b.ImportBatchId)}>
                  Undo ({b.RemainingCount})
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={undoing != null}
        danger
        title="Undo this import?"
        message="All transactions created by this import will be deleted. Funds and folios it created are kept."
        confirmLabel="Undo import"
        onCancel={() => setUndoing(null)}
        onConfirm={() => {
          undoMfImport(undoing!);
          setUndoing(null);
          const neg = negativeHoldings();
          if (neg.length)
            toastError(`Some holdings are now negative: ${neg.map((n) => n.label).join(', ')}`);
          else toast('Import undone');
        }}
      />
    </Card>
  );
}

export function MFImportPage() {
  const [tab, setTab] = useState<'cas' | 'csv'>('cas');
  return (
    <>
      <PageHeader title="Mutual funds" />
      <MFNav />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'cas', label: 'CAS PDF (CAMS / KFintech)' },
          { id: 'csv', label: 'Platform CSV / Excel' },
        ]}
      />
      {tab === 'cas' ? <CasImport /> : <CsvImport />}
      <History />
    </>
  );
}
