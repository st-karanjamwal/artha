import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDb } from '@/app/session';
import { addDays, formatDate, todayLocal } from '@/lib/dates';
import { formatINR, parseToPaise, paiseToInput } from '@/lib/money';
import { moneyField, optText } from '@/lib/validators';
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  linkAsTransfer,
  listTransactions,
  setTransactionCategory,
  updateTransaction,
  type Transaction,
  type TransactionRow,
  type TxnFilter,
} from '@/repositories/transactions';
import { listCategories } from '@/repositories/categories';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  FormGrid,
  Input,
  Modal,
  PageHeader,
  Select,
  Tabs,
  Textarea,
  cx,
} from '@/components/ui';
import {
  AccountSelect,
  CategorySelect,
  LookupSelect,
  Money,
  MoneyInput,
} from '@/components/inputs';
import { toast, toastError } from '@/components/toast';

// ---------------------------------------------------------------- form

const txnSchema = z.object({
  AccountId: z.string().min(1, 'Choose an account'),
  Direction: z.enum(['Debit', 'Credit']),
  TxnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Required'),
  Amount: moneyField({ required: true }),
  Description: z.string().trim().min(1, 'Required'),
  CategoryId: z.string().default(''),
  Mode: optText,
  ReferenceNo: optText,
  CounterParty: optText,
  Notes: optText,
});

const transferSchema = z
  .object({
    FromAccountId: z.string().min(1, 'Required'),
    ToAccountId: z.string().min(1, 'Required'),
    TxnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Required'),
    Amount: moneyField({ required: true }),
    Description: z.string().trim().min(1, 'Required'),
    Mode: optText,
    ReferenceNo: optText,
    Notes: optText,
  })
  .refine((v) => v.FromAccountId !== v.ToAccountId, {
    path: ['ToAccountId'],
    message: 'Choose a different account',
  });

function TxnFields({
  txn,
  defaultAccountId,
  onClose,
}: {
  txn: Transaction | null;
  defaultAccountId?: number;
  onClose: () => void;
}) {
  const isTransferLeg = !!txn?.TransferGroupId;
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof txnSchema>, unknown, z.output<typeof txnSchema>>({
    resolver: zodResolver(txnSchema),
    defaultValues: {
      AccountId: String(txn?.AccountId ?? defaultAccountId ?? ''),
      Direction: txn ? (txn.DebitAmount > 0 ? 'Debit' : 'Credit') : 'Debit',
      TxnDate: txn?.TxnDate ?? todayLocal(),
      Amount: txn ? paiseToInput(txn.DebitAmount || txn.CreditAmount) : '',
      Description: txn?.Description ?? '',
      CategoryId: txn?.CategoryId ? String(txn.CategoryId) : '',
      Mode: txn?.Mode ?? '',
      ReferenceNo: txn?.ReferenceNo ?? '',
      CounterParty: txn?.CounterParty ?? '',
      Notes: txn?.Notes ?? '',
    },
  });
  const dir = watch('Direction');
  const submit = handleSubmit((v) => {
    const input = {
      ...v,
      AccountId: Number(v.AccountId),
      Amount: parseToPaise(v.Amount)!,
      CategoryId: v.CategoryId ? Number(v.CategoryId) : null,
    };
    try {
      if (txn) updateTransaction(txn.TransactionId, input);
      else createTransaction(input);
      toast('Saved');
      onClose();
    } catch (e) {
      toastError(e);
    }
  });
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(['Debit', 'Credit'] as const).map((d) => (
          <button
            key={d}
            type="button"
            disabled={isTransferLeg}
            onClick={() => setValue('Direction', d)}
            className={cx(
              'rounded-lg border px-3 py-2 text-sm font-medium',
              dir === d
                ? d === 'Debit'
                  ? 'border-red-500 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                  : 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300',
            )}
          >
            {d === 'Debit' ? 'Money out (Debit)' : 'Money in (Credit)'}
          </button>
        ))}
      </div>
      <FormGrid>
        <Field label="Account" required error={errors.AccountId?.message}>
          <AccountSelect
            placeholder="Select…"
            disabled={isTransferLeg}
            {...register('AccountId')}
          />
        </Field>
        <Field label="Date" required error={errors.TxnDate?.message}>
          <Input type="date" {...register('TxnDate')} />
        </Field>
        <Field label="Amount" required error={errors.Amount?.message}>
          <MoneyInput {...register('Amount')} autoFocus={!txn} />
        </Field>
        <Field label="Category">
          <CategorySelect placeholder="Uncategorised" {...register('CategoryId')} />
        </Field>
      </FormGrid>
      <Field label="Description" required error={errors.Description?.message}>
        <Input {...register('Description')} />
      </Field>
      <FormGrid>
        <Field label="Mode">
          <LookupSelect category="TxnMode" placeholder="—" {...register('Mode')} />
        </Field>
        <Field label="Reference / UTR / cheque no.">
          <Input {...register('ReferenceNo')} />
        </Field>
        <Field label="Counterparty">
          <Input {...register('CounterParty')} />
        </Field>
      </FormGrid>
      <Field label="Notes">
        <Textarea rows={2} {...register('Notes')} />
      </Field>
      {isTransferLeg && (
        <p className="text-xs text-slate-500">
          This is one leg of a self-transfer; date, amount and description changes apply to both
          legs.
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" busy={isSubmitting}>
          Save
        </Button>
      </div>
    </form>
  );
}

function TransferFields({
  defaultAccountId,
  onClose,
}: {
  defaultAccountId?: number;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.input<typeof transferSchema>, unknown, z.output<typeof transferSchema>>({
    resolver: zodResolver(transferSchema),
    defaultValues: {
      FromAccountId: String(defaultAccountId ?? ''),
      ToAccountId: '',
      TxnDate: todayLocal(),
      Amount: '',
      Description: 'Self transfer',
      Mode: '',
      ReferenceNo: '',
      Notes: '',
    },
  });
  const submit = handleSubmit((v) => {
    try {
      createTransfer({
        ...v,
        FromAccountId: Number(v.FromAccountId),
        ToAccountId: Number(v.ToAccountId),
        Amount: parseToPaise(v.Amount)!,
      });
      toast('Transfer recorded in both accounts');
      onClose();
    } catch (e) {
      toastError(e);
    }
  });
  return (
    <form onSubmit={submit} className="space-y-4">
      <FormGrid>
        <Field label="From account" required error={errors.FromAccountId?.message}>
          <AccountSelect placeholder="Select…" {...register('FromAccountId')} />
        </Field>
        <Field label="To account" required error={errors.ToAccountId?.message}>
          <AccountSelect placeholder="Select…" {...register('ToAccountId')} />
        </Field>
        <Field label="Date" required error={errors.TxnDate?.message}>
          <Input type="date" {...register('TxnDate')} />
        </Field>
        <Field label="Amount" required error={errors.Amount?.message}>
          <MoneyInput {...register('Amount')} />
        </Field>
      </FormGrid>
      <Field label="Description" required error={errors.Description?.message}>
        <Input {...register('Description')} />
      </Field>
      <FormGrid>
        <Field label="Mode">
          <LookupSelect category="TxnMode" placeholder="—" {...register('Mode')} />
        </Field>
        <Field label="Reference">
          <Input {...register('ReferenceNo')} />
        </Field>
      </FormGrid>
      <Field label="Notes">
        <Textarea rows={2} {...register('Notes')} />
      </Field>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Record transfer</Button>
      </div>
    </form>
  );
}

export function TransactionForm({
  txn,
  mode = 'txn',
  defaultAccountId,
  onClose,
}: {
  txn: Transaction | null;
  mode?: 'txn' | 'transfer';
  defaultAccountId?: number;
  onClose: () => void;
}) {
  const [m, setM] = useState(mode);
  return (
    <Modal open onClose={onClose} title={txn ? 'Edit transaction' : 'New transaction'}>
      {!txn && (
        <Tabs
          value={m}
          onChange={setM}
          tabs={[
            { id: 'txn', label: 'Income / expense' },
            { id: 'transfer', label: 'Self transfer' },
          ]}
        />
      )}
      {m === 'txn' || txn ? (
        <TxnFields txn={txn} defaultAccountId={defaultAccountId} onClose={onClose} />
      ) : (
        <TransferFields defaultAccountId={defaultAccountId} onClose={onClose} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- table

export function TransactionTable({
  filter,
  showAccount = true,
}: {
  filter: TxnFilter;
  showAccount?: boolean;
}) {
  const rows = useDb(() => listTransactions(filter), [JSON.stringify(filter)]);
  const [editing, setEditing] = useState<TransactionRow | null>(null);
  const [deleting, setDeleting] = useState<TransactionRow | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCat, setBulkCat] = useState('');
  const showBalance = !!filter.accountId;

  const totals = useMemo(
    () =>
      rows.reduce(
        (t, r) => ({ debit: t.debit + r.DebitAmount, credit: t.credit + r.CreditAmount }),
        { debit: 0, credit: 0 },
      ),
    [rows],
  );

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selectedRows = rows.filter((r) => selected.has(r.TransactionId));
  const canLink =
    selectedRows.length === 2 &&
    selectedRows.every((r) => !r.TransferGroupId) &&
    selectedRows.some((r) => r.DebitAmount > 0) &&
    selectedRows.some((r) => r.CreditAmount > 0);

  if (!rows.length)
    return (
      <EmptyState title="No transactions match">Add one, or import a bank statement.</EmptyState>
    );

  return (
    <>
      {selected.size > 0 && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-500/40 bg-brand-50 p-2 text-sm dark:bg-slate-900">
          <span className="font-medium">{selected.size} selected</span>
          <div className="w-56">
            <CategorySelect
              placeholder="Set category…"
              value={bulkCat}
              onChange={(e) => setBulkCat(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={!bulkCat}
            onClick={() => {
              setTransactionCategory([...selected], bulkCat === '' ? null : Number(bulkCat));
              setSelected(new Set());
              setBulkCat('');
            }}
          >
            Apply
          </Button>
          {canLink && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                try {
                  const d = selectedRows.find((r) => r.DebitAmount > 0)!;
                  const c = selectedRows.find((r) => r.CreditAmount > 0)!;
                  linkAsTransfer(d.TransactionId, c.TransactionId);
                  setSelected(new Set());
                  toast('Linked as self-transfer');
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              Link as self-transfer
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* desktop */}
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  className="accent-brand-700"
                  checked={selected.size === rows.length}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? new Set(rows.map((r) => r.TransactionId)) : new Set(),
                    )
                  }
                />
              </th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Category</th>
              {showAccount && <th className="px-3 py-2">Account</th>}
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Credit</th>
              {showBalance && <th className="px-3 py-2 text-right">Balance</th>}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.TransactionId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    className="accent-brand-700"
                    aria-label="Select"
                    checked={selected.has(r.TransactionId)}
                    onChange={() => toggle(r.TransactionId)}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-2">{formatDate(r.TxnDate)}</td>
                <td className="max-w-sm px-3 py-2">
                  <button className="text-left hover:underline" onClick={() => setEditing(r)}>
                    {r.Description}
                  </button>
                  <div className="text-xs text-slate-500">
                    {[
                      r.OtherAccountLabel && `⇄ ${r.OtherAccountLabel}`,
                      r.CounterParty,
                      r.ReferenceNo,
                      r.Mode,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {r.CategoryName ? (
                    <Badge>{r.CategoryName}</Badge>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                {showAccount && (
                  <td className="px-3 py-2 text-xs text-slate-500">{r.AccountLabel}</td>
                )}
                <td className="px-3 py-2 text-right text-red-600">
                  {r.DebitAmount ? <Money paise={r.DebitAmount} /> : ''}
                </td>
                <td className="px-3 py-2 text-right text-emerald-700 dark:text-emerald-400">
                  {r.CreditAmount ? <Money paise={r.CreditAmount} /> : ''}
                </td>
                {showBalance && (
                  <td className="px-3 py-2 text-right">
                    <Money paise={r.RunningBalance} colored />
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <button
                    className="text-slate-400 hover:text-red-600"
                    aria-label="Delete"
                    onClick={() => setDeleting(r)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 text-sm font-medium dark:bg-slate-800/50">
            <tr>
              <td colSpan={showAccount ? 5 : 4} className="px-3 py-2 text-right text-slate-500">
                {rows.length} transactions
              </td>
              <td className="px-3 py-2 text-right">
                <Money paise={totals.debit} />
              </td>
              <td className="px-3 py-2 text-right">
                <Money paise={totals.credit} />
              </td>
              {showBalance && <td />}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* mobile */}
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white md:hidden dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {rows.map((r) => (
          <li
            key={r.TransactionId}
            className="flex items-start gap-3 p-3"
            onClick={() => setEditing(r)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.Description}</p>
              <p className="truncate text-xs text-slate-500">
                {formatDate(r.TxnDate)}
                {r.CategoryName && ` · ${r.CategoryName}`}
                {showAccount && ` · ${r.AccountLabel}`}
              </p>
            </div>
            <div className="text-right">
              <p
                className={cx(
                  'num text-sm font-medium',
                  r.DebitAmount ? 'text-red-600' : 'text-emerald-700 dark:text-emerald-400',
                )}
              >
                {r.DebitAmount ? '−' + formatINR(r.DebitAmount) : '+' + formatINR(r.CreditAmount)}
              </p>
              {showBalance && <Money paise={r.RunningBalance} className="text-xs text-slate-500" />}
            </div>
          </li>
        ))}
      </ul>

      {editing && <TransactionForm txn={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        danger
        title="Delete transaction?"
        message={
          deleting?.TransferGroupId
            ? 'This is a self-transfer; both legs will be deleted.'
            : 'This cannot be undone (except by restoring an earlier vault version).'
        }
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          deleteTransaction(deleting!.TransactionId);
          setDeleting(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- page

export function TransactionsPage() {
  const [params] = useSearchParams();
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const [from, setFrom] = useState(addDays(todayLocal(), -90));
  const [to, setTo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [minAmt, setMinAmt] = useState('');
  const [maxAmt, setMaxAmt] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<'txn' | 'transfer' | null>(null);

  const filter: TxnFilter = {
    accountId: Number(accountId) || undefined,
    from: from || undefined,
    to: to || undefined,
    categoryId: categoryId === 'none' ? 'none' : Number(categoryId) || undefined,
    minAmount: parseToPaise(minAmt) ?? undefined,
    maxAmount: parseToPaise(maxAmt) ?? undefined,
    search: search || undefined,
  };

  return (
    <>
      <PageHeader
        title="Transactions"
        actions={
          <>
            <Button variant="secondary" onClick={() => setAdding('transfer')}>
              Self transfer
            </Button>
            <Button onClick={() => setAdding('txn')}>Add transaction</Button>
          </>
        }
      />
      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <div className="col-span-2">
            <Field label="Account">
              <AccountSelect
                placeholder="All accounts"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
            </Field>
          </div>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="col-span-2 md:col-span-1">
            <Field label="Category">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">All</option>
                <option value="none">Uncategorised</option>
                <CategoryOptions />
              </Select>
            </Field>
          </div>
          <Field label="Min ₹">
            <Input inputMode="decimal" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} />
          </Field>
          <Field label="Max ₹">
            <Input inputMode="decimal" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} />
          </Field>
          <div className="col-span-2 md:col-span-4 lg:col-span-7">
            <Input
              placeholder="Search description, reference, counterparty, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </Card>
      <TransactionTable filter={filter} />
      {adding && (
        <TransactionForm
          txn={null}
          mode={adding}
          defaultAccountId={Number(accountId) || undefined}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}

function CategoryOptions() {
  const cats = useDb(() => listCategories());
  return (
    <>
      {cats.map((c) => (
        <option key={c.CategoryId} value={c.CategoryId}>
          {c.Kind} · {c.FullName}
        </option>
      ))}
    </>
  );
}
