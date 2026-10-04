import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { dbVersion, useDb } from '@/app/session';
import { useStore } from '@/lib/store';
import { DATE_FORMATS, formatDate, formatDateTime, type DateFormat } from '@/lib/dates';
import { getAccount, balanceAsOf, listAccounts, accountLabel } from '@/repositories/accounts';
import {
  applyMapping,
  chronological,
  commitImport,
  getSavedMapping,
  guessHeaderRow,
  guessMapping,
  listImportBatches,
  markDuplicates,
  readStatementFile,
  sampleDateFormat,
  saveMapping,
  statementClosing,
  undoImport,
  type Cell,
  type Grid,
  type ImportMapping,
} from '@/repositories/imports';
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
  cx,
} from '@/components/ui';
import { AccountSelect, CategorySelect, Money } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';

const cellText = (c: Cell) =>
  c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c);

function ColumnSelect({
  header,
  value,
  onChange,
  optional,
  label,
}: {
  header: Cell[];
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  optional?: boolean;
  label: string;
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
            {String.fromCharCode(65 + (i % 26))}: {cellText(h) || `(column ${i + 1})`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function isComplete(m: Partial<ImportMapping>): m is ImportMapping {
  if (
    m.headerRow == null ||
    m.dateCol == null ||
    m.descCol == null ||
    !m.dateFormat ||
    !m.amountMode
  )
    return false;
  if (m.amountMode === 'split') return m.debitCol != null && m.creditCol != null;
  if (m.amountMode === 'drcr') return m.amountCol != null && m.drcrCol != null;
  return m.amountCol != null;
}

export function ImportPage() {
  const [params] = useSearchParams();
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const account = useDb(() => (accountId ? getAccount(Number(accountId)) : undefined), [accountId]);
  const [fileName, setFileName] = useState('');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [mapping, setMapping] = useState<Partial<ImportMapping>>({});
  const [forceInclude, setForceInclude] = useState<Set<number>>(new Set());
  const [rememberMapping, setRememberMapping] = useState(true);
  const [recordSnapshot, setRecordSnapshot] = useState(true);
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const version = useStore(dbVersion);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!account) return toastError('Choose the account first');
    setBusy(true);
    try {
      const g = await readStatementFile(file);
      if (!g.length) throw new Error('The file is empty');
      setGrid(g);
      setFileName(file.name);
      setForceInclude(new Set());
      const saved = getSavedMapping(account.BankId);
      if (saved && g[saved.headerRow]) {
        setMapping(saved);
      } else {
        const headerRow = guessHeaderRow(g);
        const guess = guessMapping(g[headerRow] ?? []);
        setMapping({
          ...guess,
          headerRow,
          dateFormat:
            guess.dateCol != null
              ? sampleDateFormat(g, { headerRow, dateCol: guess.dateCol })
              : 'DD/MM/YYYY',
        });
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => {
    if (!grid || !account || !isComplete(mapping)) return null;
    const parsed = chronological(applyMapping(grid, mapping));
    return markDuplicates(account.AccountId, parsed).map((r) =>
      forceInclude.has(r.line) ? { ...r, duplicate: false, forced: true } : { ...r, forced: false },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, mapping, account, forceInclude, version]);

  const summary = useMemo(() => {
    if (!rows || !account) return null;
    const ok = rows.filter((r) => !r.error && !r.duplicate);
    const closing = statementClosing(rows);
    let computed: number | null = null;
    if (closing) {
      computed =
        balanceAsOf(account.AccountId, closing.date) +
        ok.filter((r) => r.date! <= closing.date).reduce((s, r) => s + r.credit - r.debit, 0);
    }
    return {
      ok: ok.length,
      dup: rows.filter((r) => r.duplicate).length,
      err: rows.filter((r) => r.error).length,
      debit: ok.reduce((s, r) => s + r.debit, 0),
      credit: ok.reduce((s, r) => s + r.credit, 0),
      closing,
      computed,
    };
  }, [rows, account]);

  const doImport = () => {
    if (!rows || !account || !isComplete(mapping)) return;
    try {
      if (rememberMapping) saveMapping(account.BankId, mapping);
      const batch = commitImport(account.AccountId, fileName, rows, {
        categoryId: categoryId ? Number(categoryId) : null,
        recordSnapshot,
      });
      toast(`Imported ${summary?.ok} transactions (batch #${batch})`);
      setGrid(null);
      setMapping({});
      setFileName('');
    } catch (e) {
      toastError(e);
    }
  };

  const header = grid && mapping.headerRow != null ? (grid[mapping.headerRow] ?? []) : [];
  const set = (patch: Partial<ImportMapping>) => setMapping((m) => ({ ...m, ...patch }));

  return (
    <>
      <PageHeader
        title="Import statement"
        subtitle="CSV or Excel statements from your bank. Parsed entirely in your browser."
      />

      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Account" required>
            <AccountSelect
              placeholder="Select account…"
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setGrid(null);
              }}
            />
          </Field>
          <Field label="Statement file (.csv, .xlsx)" required hint={busy ? 'Reading…' : undefined}>
            <Input
              key={fileName || 'empty'}
              type="file"
              accept=".csv,.txt,.xlsx,.xls"
              disabled={!account}
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </Field>
        </div>
      </Card>

      {grid && (
        <Card className="mb-4" title="1. Map columns">
          <div className="mb-4 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full text-xs">
              <tbody>
                {grid.slice(0, Math.max(12, (mapping.headerRow ?? 0) + 4)).map((r, i) => (
                  <tr
                    key={i}
                    onClick={() => set({ headerRow: i })}
                    className={cx(
                      'cursor-pointer',
                      i === mapping.headerRow
                        ? 'bg-brand-100 font-semibold dark:bg-brand-800/40'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/40',
                    )}
                  >
                    <td className="w-8 px-2 py-1 text-slate-400">{i + 1}</td>
                    {(r ?? []).slice(0, 10).map((c, j) => (
                      <td key={j} className="max-w-48 truncate whitespace-nowrap px-2 py-1">
                        {cellText(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            Click the header row in the preview above (currently row {(mapping.headerRow ?? 0) + 1}
            ).
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ColumnSelect
              label="Date"
              header={header}
              value={mapping.dateCol}
              onChange={(v) => set({ dateCol: v })}
            />
            <Field label="Date format" required>
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
              label="Description"
              header={header}
              value={mapping.descCol}
              onChange={(v) => set({ descCol: v })}
            />
            <ColumnSelect
              label="Reference no."
              optional
              header={header}
              value={mapping.refCol}
              onChange={(v) => set({ refCol: v })}
            />
            <Field label="Amounts are in" required>
              <Select
                value={mapping.amountMode ?? ''}
                onChange={(e) => set({ amountMode: e.target.value as ImportMapping['amountMode'] })}
              >
                <option value="" disabled>
                  Select…
                </option>
                <option value="split">Separate Debit and Credit columns</option>
                <option value="signed">One column, negative = debit</option>
                <option value="drcr">One amount column + Dr/Cr column</option>
              </Select>
            </Field>
            {mapping.amountMode === 'split' && (
              <>
                <ColumnSelect
                  label="Debit / withdrawal"
                  header={header}
                  value={mapping.debitCol}
                  onChange={(v) => set({ debitCol: v })}
                />
                <ColumnSelect
                  label="Credit / deposit"
                  header={header}
                  value={mapping.creditCol}
                  onChange={(v) => set({ creditCol: v })}
                />
              </>
            )}
            {(mapping.amountMode === 'signed' || mapping.amountMode === 'drcr') && (
              <ColumnSelect
                label="Amount"
                header={header}
                value={mapping.amountCol}
                onChange={(v) => set({ amountCol: v })}
              />
            )}
            {mapping.amountMode === 'drcr' && (
              <ColumnSelect
                label="Dr/Cr"
                header={header}
                value={mapping.drcrCol}
                onChange={(v) => set({ drcrCol: v })}
              />
            )}
            <ColumnSelect
              label="Balance (to verify)"
              optional
              header={header}
              value={mapping.balanceCol}
              onChange={(v) => set({ balanceCol: v })}
            />
          </div>
          {account && (
            <div className="mt-4">
              <Checkbox
                label={`Remember this mapping for ${account.BankName}`}
                checked={rememberMapping}
                onChange={(e) => setRememberMapping(e.target.checked)}
              />
            </div>
          )}
        </Card>
      )}

      {rows && summary && (
        <Card className="mb-4" title="2. Review">
          <div className="mb-4 flex flex-wrap gap-2 text-sm">
            <Badge tone="green">{summary.ok} new</Badge>
            <Badge tone="amber">{summary.dup} duplicates skipped</Badge>
            {summary.err > 0 && <Badge tone="red">{summary.err} errors</Badge>}
            <span className="text-slate-500">
              Out <Money paise={summary.debit} /> · In <Money paise={summary.credit} />
            </span>
          </div>
          {summary.closing && summary.computed != null && (
            <div className="mb-4">
              {summary.closing.balance === summary.computed ? (
                <Alert tone="brand">
                  ✓ After import, the balance on {formatDate(summary.closing.date)} will be{' '}
                  <Money paise={summary.computed} />, matching the statement.
                </Alert>
              ) : (
                <Alert>
                  Statement balance on {formatDate(summary.closing.date)} is{' '}
                  <Money paise={summary.closing.balance} />, but Artha will show{' '}
                  <Money paise={summary.computed} /> (difference{' '}
                  <Money paise={summary.closing.balance - summary.computed} />
                  ). Check the account's opening balance, or earlier missing transactions.
                </Alert>
              )}
            </div>
          )}
          <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-800">
                <tr>
                  <th className="px-2 py-2">Line</th>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">Ref</th>
                  <th className="px-2 py-2 text-right">Debit</th>
                  <th className="px-2 py-2 text-right">Credit</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr
                    key={r.line}
                    className={cx(
                      r.error && 'bg-red-50 dark:bg-red-950/30',
                      r.duplicate && 'opacity-60',
                    )}
                  >
                    <td className="px-2 py-1.5 text-slate-400">{r.line}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {r.date ? formatDate(r.date) : '—'}
                    </td>
                    <td className="max-w-xs truncate px-2 py-1.5">{r.description}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">{r.ref}</td>
                    <td className="px-2 py-1.5 text-right">
                      {r.debit ? <Money paise={r.debit} /> : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {r.credit ? <Money paise={r.credit} /> : ''}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.error ? (
                        <Badge tone="red">{r.error}</Badge>
                      ) : r.duplicate ? (
                        <button
                          className="text-xs underline"
                          onClick={() => setForceInclude((s) => new Set(s).add(r.line))}
                        >
                          Duplicate · import anyway
                        </button>
                      ) : r.forced ? (
                        <button
                          className="text-xs underline"
                          onClick={() =>
                            setForceInclude((s) => {
                              const n = new Set(s);
                              n.delete(r.line);
                              return n;
                            })
                          }
                        >
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
          <div className="mt-4 grid grid-cols-1 items-end gap-4 md:grid-cols-3">
            <Field
              label="Category for all imported rows"
              hint="Optional; you can categorise later in bulk."
            >
              <CategorySelect
                placeholder="Leave uncategorised"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              />
            </Field>
            <div className="md:col-span-1">
              {summary.closing && (
                <Checkbox
                  label="Record statement closing balance for reconciliation"
                  checked={recordSnapshot}
                  onChange={(e) => setRecordSnapshot(e.target.checked)}
                />
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setGrid(null)}>
                Cancel
              </Button>
              <Button disabled={summary.ok === 0} onClick={doImport}>
                Import {summary.ok} transactions
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ImportHistory />
    </>
  );
}

function ImportHistory() {
  const batches = useDb(() => listImportBatches());
  const accounts = useDb(
    () => new Map(listAccounts({ includeInactive: true }).map((a) => [a.AccountId, a])),
  );
  const [undoing, setUndoing] = useState<number | null>(null);
  return (
    <Card title="Import history">
      {batches.length === 0 ? (
        <EmptyState title="No imports yet" />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {batches.map((b) => {
            const a = accounts.get(b.AccountId);
            return (
              <li
                key={b.ImportBatchId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{b.FileName}</p>
                  <p className="text-xs text-slate-500">
                    {a && (
                      <Link className="hover:underline" to={`/accounts/${a.AccountId}`}>
                        {accountLabel(a)}
                      </Link>
                    )}{' '}
                    · {formatDateTime(b.ImportedOn)} · {b.RowCount} imported, {b.SkippedCount}{' '}
                    skipped
                  </p>
                </div>
                {b.UndoneOn ? (
                  <Badge>Undone {formatDate(b.UndoneOn.slice(0, 10))}</Badge>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setUndoing(b.ImportBatchId)}>
                    Undo ({b.RemainingCount})
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={undoing != null}
        danger
        title="Undo this import?"
        message="All transactions created by this import will be deleted, including any edits made to them since."
        confirmLabel="Undo import"
        onCancel={() => setUndoing(null)}
        onConfirm={() => {
          undoImport(undoing!);
          setUndoing(null);
          toast('Import undone');
        }}
      />
    </Card>
  );
}
