import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatDate } from '@/lib/dates';
import { listAccounts, type AccountListItem } from '@/repositories/accounts';
import { getBank } from '@/repositories/banks';
import { Badge, Button, Checkbox, EmptyState, PageHeader, Tabs, cx } from '@/components/ui';
import { Money } from '@/components/inputs';
import { AccountForm } from './AccountForm';

type GroupBy = 'person' | 'bank';

function AccountCard({ a }: { a: AccountListItem }) {
  return (
    <Link
      to={`/accounts/${a.AccountId}`}
      className={cx(
        'block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-500 dark:border-slate-800 dark:bg-slate-900',
        !a.IsActive && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">{a.BankName}</p>
          <p className="truncate text-sm text-slate-500">
            {a.TypeLabel} · <span className="font-mono">··{a.AccountNumberLast4}</span>
          </p>
        </div>
        <Money paise={a.CurrentBalance} colored className="text-right font-semibold" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {a.Holders && <Badge>{a.Holders}</Badge>}
        {a.MaturityDate && <Badge tone="amber">Matures {formatDate(a.MaturityDate)}</Badge>}
        {!a.IsActive && <Badge tone="red">Closed</Badge>}
      </div>
    </Link>
  );
}

export function AccountsPage() {
  const [params, setParams] = useSearchParams();
  const bankId = Number(params.get('bank')) || undefined;
  const [groupBy, setGroupBy] = useState<GroupBy>('person');
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const accounts = useDb(
    () => listAccounts({ includeInactive: showInactive, bankId }),
    [showInactive, bankId],
  );
  const bank = useDb(() => (bankId ? getBank(bankId) : undefined), [bankId]);

  const groups = useMemo(() => {
    const m = new Map<string, AccountListItem[]>();
    for (const a of accounts) {
      const k = groupBy === 'person' ? (a.PrimaryHolder ?? 'No primary holder') : a.BankName;
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return [...m.entries()].map(([name, list]) => ({
      name,
      list,
      total: list.filter((a) => a.IsActive).reduce((s, a) => s + a.CurrentBalance, 0),
    }));
  }, [accounts, groupBy]);

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle={
          bank ? (
            <>
              Showing {bank.BankName}{' '}
              <button className="underline" onClick={() => setParams({})}>
                (show all)
              </button>
            </>
          ) : (
            'Savings, salary, PPF, SSY, FD/RD and more.'
          )
        }
        actions={
          <>
            <Checkbox
              label="Show closed"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            <Button onClick={() => setAdding(true)}>Add account</Button>
          </>
        }
      />
      <Tabs
        tabs={[
          { id: 'person', label: 'By person' },
          { id: 'bank', label: 'By bank' },
        ]}
        value={groupBy}
        onChange={setGroupBy}
      />
      {accounts.length === 0 ? (
        <EmptyState
          title="No accounts yet"
          action={<Button onClick={() => setAdding(true)}>Add account</Button>}
        >
          Add your bank accounts, PPF, Sukanya Samriddhi, FDs and RDs.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.name}>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="font-semibold">{g.name}</h2>
                <Money paise={g.total} className="text-sm text-slate-500" />
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {g.list.map((a) => (
                  <AccountCard key={a.AccountId} a={a} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {adding && (
        <AccountForm
          account={null}
          defaultBankId={bankId}
          onClose={() => setAdding(false)}
          onCreated={(id) => navigate(`/accounts/${id}`)}
        />
      )}
    </>
  );
}
