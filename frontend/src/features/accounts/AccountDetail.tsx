import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from '@/app/session';
import { daysBetween, formatDate, formatDateTime, todayLocal } from '@/lib/dates';
import { parseToPaise } from '@/lib/money';
import {
  addSecurityQuestion,
  addSnapshot,
  createCredential,
  deactivateCredential,
  deleteSecurityQuestion,
  deleteSnapshot,
  getAccount,
  listAccountPersons,
  listCredentials,
  listSecurityQuestions,
  listSnapshots,
  setAccountActive,
  setAccountNotes,
  setAccountPersons,
  updateCredential,
  updateSecurityQuestion,
  type AccountListItem,
  type AccountPersonInput,
  type Credential,
  type SecurityQuestion,
} from '@/repositories/accounts';
import { getBank } from '@/repositories/banks';
import { lookupLabel } from '@/repositories/lookups';
import { listImportBatches } from '@/repositories/imports';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DefinitionList,
  EmptyState,
  Field,
  FormGrid,
  Input,
  Modal,
  PageHeader,
  Tabs,
  Textarea,
} from '@/components/ui';
import { LookupSelect, Money, MoneyInput, PassphraseInput } from '@/components/inputs';
import { SecretField } from '@/components/SecretField';
import { toast, toastError } from '@/components/toast';
import { TransactionTable, TransactionForm } from '@/features/transactions/TransactionsPage';
import { AccountForm, HoldersEditor } from './AccountForm';

type Tab = 'overview' | 'holders' | 'credentials' | 'questions' | 'transactions' | 'notes';

export function AccountDetail() {
  const id = Number(useParams().id);
  const account = useDb(() => getAccount(id), [id]);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);

  if (!account)
    return (
      <EmptyState title="Account not found" action={<Link to="/accounts">Back to accounts</Link>} />
    );

  return (
    <>
      <div className="mb-2 text-sm">
        <Link to="/accounts" className="text-slate-500 hover:underline">
          ← Accounts
        </Link>
      </div>
      <PageHeader
        title={`${account.BankName} · ${account.TypeLabel}`}
        subtitle={
          <>
            <span className="font-mono">··{account.AccountNumberLast4}</span>
            {account.PrimaryHolder && <> · {account.Holders ?? account.PrimaryHolder}</>}
            {!account.IsActive && (
              <>
                {' '}
                <Badge tone="red">Closed</Badge>
              </>
            )}
          </>
        }
        actions={
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-slate-500">Balance</p>
            <Money paise={account.CurrentBalance} colored className="text-2xl font-semibold" />
          </div>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'holders', label: 'Holders & Nominees' },
          { id: 'credentials', label: 'Credentials' },
          { id: 'questions', label: 'Security Questions' },
          { id: 'transactions', label: 'Transactions' },
          { id: 'notes', label: 'Notes' },
        ]}
      />
      {tab === 'overview' && <Overview a={account} onEdit={() => setEditing(true)} />}
      {tab === 'holders' && <Holders accountId={id} />}
      {tab === 'credentials' && <Credentials accountId={id} />}
      {tab === 'questions' && <Questions accountId={id} />}
      {tab === 'transactions' && <AccountTransactions accountId={id} />}
      {tab === 'notes' && <Notes a={account} />}
      {editing && <AccountForm account={account} onClose={() => setEditing(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ a, onEdit }: { a: AccountListItem; onEdit: () => void }) {
  const bank = useDb(() => getBank(a.BankId), [a.BankId]);
  const [closing, setClosing] = useState(false);
  const days = a.MaturityDate ? daysBetween(todayLocal(), a.MaturityDate) : null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card
        className="lg:col-span-2"
        title="Details"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={onEdit}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (a.IsActive ? setClosing(true) : setAccountActive(a.AccountId, true))}
            >
              {a.IsActive ? 'Mark closed' : 'Reopen'}
            </Button>
          </>
        }
      >
        <DefinitionList
          items={[
            ['Account number', <SecretField key="n" value={a.AccountNumber_Enc} showLast4 />],
            ['Type', a.TypeLabel],
            ['Bank', a.BankName],
            ['Branch', a.BranchName],
            ['IFSC', bank?.IFSCCode && <span className="font-mono">{bank.IFSCCode}</span>],
            ['MICR', bank?.MICRCode],
            ['Customer ID', a.CustomerId],
            ['Opened on', formatDate(a.OpenedOn)],
            [
              'Maturity',
              a.MaturityDate && (
                <>
                  {formatDate(a.MaturityDate)}{' '}
                  {days != null && (
                    <span className="text-slate-500">
                      ({days >= 0 ? `in ${days} days` : 'matured'})
                    </span>
                  )}
                </>
              ),
            ],
            ['Interest rate', a.InterestRate && `${a.InterestRate}% p.a.`],
            [
              'Opening balance',
              <span key="ob">
                <Money paise={a.OpeningBalance} />
                {a.OpeningBalanceDate && (
                  <span className="text-slate-500"> as of {formatDate(a.OpeningBalanceDate)}</span>
                )}
              </span>,
            ],
            [
              'Debit card',
              a.DebitCardLast4 && <span className="font-mono">··{a.DebitCardLast4}</span>,
            ],
          ]}
        />
      </Card>
      <Reconcile accountId={a.AccountId} />
      <ImportHistory accountId={a.AccountId} />
      <ConfirmDialog
        open={closing}
        title="Mark account closed?"
        message="It will be hidden from lists and totals. Data is kept and you can reopen it later."
        confirmLabel="Mark closed"
        onCancel={() => setClosing(false)}
        onConfirm={() => {
          setAccountActive(a.AccountId, false);
          setClosing(false);
        }}
      />
    </div>
  );
}

function Reconcile({ accountId }: { accountId: number }) {
  const snaps = useDb(() => listSnapshots(accountId), [accountId]);
  const [date, setDate] = useState(todayLocal());
  const [amt, setAmt] = useState('');
  const add = () => {
    const p = parseToPaise(amt);
    if (p == null) return toastError('Enter the balance shown by the bank');
    addSnapshot(accountId, date, p);
    setAmt('');
  };
  return (
    <Card title="Reconcile with bank">
      <p className="mb-3 text-xs text-slate-500">
        Record the balance shown by the bank to check it matches.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          type="date"
          className="w-40"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="As of date"
        />
        <div className="min-w-32 flex-1">
          <MoneyInput
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            aria-label="Bank balance"
          />
        </div>
        <Button size="sm" onClick={add}>
          Add
        </Button>
      </div>
      <ul className="mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {snaps.map((s) => {
          const diff = s.Balance - s.ComputedBalance;
          return (
            <li key={s.BalanceSnapshotId} className="flex items-center justify-between gap-2 py-2">
              <div>
                <p>{formatDate(s.AsOfDate)}</p>
                <Money paise={s.Balance} className="text-slate-500" />
              </div>
              <div className="flex items-center gap-2">
                {diff === 0 ? (
                  <Badge tone="green">Matches</Badge>
                ) : (
                  <Badge tone="red">
                    Off by <Money paise={diff} className="ml-1" />
                  </Badge>
                )}
                <button
                  className="text-slate-400 hover:text-red-600"
                  aria-label="Delete"
                  onClick={() => deleteSnapshot(s.BalanceSnapshotId)}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ImportHistory({ accountId }: { accountId: number }) {
  const batches = useDb(() => listImportBatches(accountId), [accountId]);
  if (!batches.length) return null;
  return (
    <Card title="Statement imports" className="lg:col-span-3">
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {batches.map((b) => (
          <li
            key={b.ImportBatchId}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <span className="min-w-0 truncate">{b.FileName}</span>
            <span className="text-slate-500">
              {formatDateTime(b.ImportedOn)} · {b.RowCount} rows
              {b.UndoneOn && ' · undone'}
            </span>
          </li>
        ))}
      </ul>
      <Link
        to="/import"
        className="mt-2 inline-block text-sm text-brand-700 hover:underline dark:text-brand-500"
      >
        Manage imports →
      </Link>
    </Card>
  );
}

// ---------------------------------------------------------------- holders

function Holders({ accountId }: { accountId: number }) {
  const list = useDb(() => listAccountPersons(accountId), [accountId]);
  const [editing, setEditing] = useState<AccountPersonInput[] | null>(null);
  const save = () => {
    try {
      setAccountPersons(
        accountId,
        editing!.filter((h) => h.PersonId),
      );
      setEditing(null);
      toast('Saved');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Card
      title="Holders & nominees"
      actions={
        !editing && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setEditing(
                list.map(({ PersonId, Role, SharePercent }) => ({ PersonId, Role, SharePercent })),
              )
            }
          >
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <div className="space-y-4">
          <HoldersEditor value={editing} onChange={setEditing} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-500">No holders recorded.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {list.map((h) => (
            <li key={h.AccountPersonId} className="flex items-center justify-between py-2 text-sm">
              <span>
                {h.PersonName} <span className="text-slate-500">({h.Relationship})</span>
              </span>
              <span className="flex items-center gap-2">
                {h.SharePercent && <span className="text-slate-500">{h.SharePercent}%</span>}
                <Badge tone={h.Role === 'Primary' ? 'brand' : 'slate'}>
                  {lookupLabel('AccountRole', h.Role)}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- credentials

function CredentialForm({
  accountId,
  cred,
  onClose,
}: {
  accountId: number;
  cred: Credential | null;
  onClose: () => void;
}) {
  const [v, setV] = useState({
    Channel: cred?.Channel ?? 'NetBanking',
    LoginId: '',
    Password: '',
    MPIN: '',
    TxnPassword: '',
    LastChangedOn: cred?.LastChangedOn ?? '',
    Notes: cred?.Notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (val: string) => setV((x) => ({ ...x, [k]: val }));
  const save = async () => {
    setBusy(true);
    try {
      if (cred) await updateCredential(cred.CredentialId, v);
      else await createCredential(accountId, v);
      toast('Saved');
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  const hint = (has: string | null) => (cred && has ? 'Saved. Leave blank to keep.' : undefined);
  return (
    <Modal
      open
      onClose={onClose}
      title={cred ? 'Edit credentials' : 'Add credentials'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => (e.preventDefault(), void save())}
        autoComplete="off"
      >
        <Field label="Channel">
          <LookupSelect
            category="CredentialChannel"
            value={v.Channel}
            onChange={(e) => set('Channel')(e.target.value)}
          />
        </Field>
        <FormGrid>
          <Field label="Login / user ID" hint={hint(cred?.LoginId_Enc ?? null)}>
            <Input
              autoComplete="off"
              spellCheck={false}
              value={v.LoginId}
              onChange={(e) => set('LoginId')(e.target.value)}
            />
          </Field>
          <Field label="Password" hint={hint(cred?.Password_Enc ?? null)}>
            <PassphraseInput value={v.Password} onChange={set('Password')} autoComplete="off" />
          </Field>
          <Field label="MPIN" hint={hint(cred?.MPIN_Enc ?? null)}>
            <PassphraseInput value={v.MPIN} onChange={set('MPIN')} autoComplete="off" />
          </Field>
          <Field label="Transaction password" hint={hint(cred?.TxnPassword_Enc ?? null)}>
            <PassphraseInput
              value={v.TxnPassword}
              onChange={set('TxnPassword')}
              autoComplete="off"
            />
          </Field>
          <Field label="Last changed on">
            <Input
              type="date"
              value={v.LastChangedOn}
              onChange={(e) => set('LastChangedOn')(e.target.value)}
            />
          </Field>
        </FormGrid>
        <Field label="Notes">
          <Textarea rows={2} value={v.Notes} onChange={(e) => set('Notes')(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function Credentials({ accountId }: { accountId: number }) {
  const creds = useDb(() => listCredentials(accountId), [accountId]);
  const [editing, setEditing] = useState<Credential | null | 'new'>(null);
  const [removing, setRemoving] = useState<Credential | null>(null);
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Alert tone="brand">
          Secrets are encrypted twice and masked. Revealed values hide after 30 s; copied values
          clear from the clipboard after 30 s.
        </Alert>
      </div>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>Add credentials</Button>
      </div>
      {creds.length === 0 ? (
        <EmptyState title="No credentials saved">
          Net banking, mobile app, UPI and phone banking logins.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {creds.map((c) => (
            <Card
              key={c.CredentialId}
              title={lookupLabel('CredentialChannel', c.Channel)}
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}>
                    Remove
                  </Button>
                </>
              }
            >
              <dl className="space-y-2 text-sm">
                {(
                  [
                    ['Login ID', c.LoginId_Enc],
                    ['Password', c.Password_Enc],
                    ['MPIN', c.MPIN_Enc],
                    ['Txn password', c.TxnPassword_Enc],
                  ] as const
                )
                  .filter(([, val]) => val)
                  .map(([k, val]) => (
                    <div key={k} className="flex flex-wrap items-center gap-x-3">
                      <dt className="w-28 text-slate-500">{k}</dt>
                      <dd>
                        <SecretField value={val} />
                      </dd>
                    </div>
                  ))}
                {c.LastChangedOn && (
                  <p className="pt-1 text-xs text-slate-500">
                    Last changed {formatDate(c.LastChangedOn)}
                  </p>
                )}
                {c.Notes && <p className="text-xs whitespace-pre-line text-slate-500">{c.Notes}</p>}
              </dl>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <CredentialForm
          accountId={accountId}
          cred={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        danger
        title="Remove credentials?"
        message="They will no longer be shown. The record is kept as inactive in the vault history."
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          deactivateCredential(removing!.CredentialId);
          setRemoving(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- security questions

function Questions({ accountId }: { accountId: number }) {
  const qs = useDb(() => listSecurityQuestions(accountId), [accountId]);
  const [editing, setEditing] = useState<SecurityQuestion | null | 'new'>(null);
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setQ(editing && editing !== 'new' ? editing.Question : '');
    setA('');
  }, [editing]);
  const save = async () => {
    if (!q.trim()) return toastError('Enter the question');
    if (editing === 'new' && !a) return toastError('Enter the answer');
    setBusy(true);
    try {
      if (editing === 'new') await addSecurityQuestion(accountId, q, a);
      else if (editing) await updateSecurityQuestion(editing.SecurityQuestionId, q, a || undefined);
      setEditing(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>Add question</Button>
      </div>
      {qs.length === 0 ? (
        <EmptyState title="No security questions saved" />
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {qs.map((x) => (
              <li
                key={x.SecurityQuestionId}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{x.Question}</p>
                  <SecretField value={x.Answer_Enc} />
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(x)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => deleteSecurityQuestion(x.SecurityQuestionId)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add security question' : 'Edit security question'}
        footer={
          <Button busy={busy} onClick={save}>
            Save
          </Button>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => (e.preventDefault(), void save())}
          autoComplete="off"
        >
          <Field label="Question">
            <Input value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </Field>
          <Field
            label="Answer"
            hint={editing !== 'new' ? 'Leave blank to keep the saved answer.' : undefined}
          >
            <PassphraseInput value={a} onChange={setA} autoComplete="off" />
          </Field>
        </form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- transactions & notes

function AccountTransactions({ accountId }: { accountId: number }) {
  const [adding, setAdding] = useState<'txn' | 'transfer' | null>(null);
  return (
    <>
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        <Link to={`/import?account=${accountId}`}>
          <Button variant="secondary">Import statement</Button>
        </Link>
        <Button variant="secondary" onClick={() => setAdding('transfer')}>
          Self transfer
        </Button>
        <Button onClick={() => setAdding('txn')}>Add transaction</Button>
      </div>
      <TransactionTable filter={{ accountId }} showAccount={false} />
      {adding && (
        <TransactionForm
          txn={null}
          mode={adding}
          defaultAccountId={accountId}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}

function Notes({ a }: { a: AccountListItem }) {
  const [text, setText] = useState(a.Notes ?? '');
  const dirty = text !== (a.Notes ?? '');
  return (
    <Card>
      <Textarea
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Free-form notes about this account…"
      />
      <div className="mt-3 flex justify-end">
        <Button
          disabled={!dirty}
          onClick={() => {
            setAccountNotes(a.AccountId, text);
            toast('Notes saved');
          }}
        >
          Save notes
        </Button>
      </div>
    </Card>
  );
}
