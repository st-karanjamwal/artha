import { useState } from 'react';
import { useDb } from '@/app/session';
import { listPersons, personName } from '@/repositories/persons';
import {
  FOLIO_ROLE_LABEL,
  createFolio,
  createInvestmentAccount,
  listFolioPersons,
  listFolios,
  listInvestmentAccounts,
  updateFolio,
  updateInvestmentAccount,
  type FolioItem,
  type FolioPersonInput,
  type FolioRole,
  type InvestmentAccountItem,
} from '@/repositories/mfAccounts';
import { listFunds } from '@/repositories/mfFunds';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  FormGrid,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { AccountSelect, PassphraseInput, PersonSelect } from '@/components/inputs';
import { listLookups } from '@/repositories/lookups';
import { SecretField } from '@/components/SecretField';
import { toast, toastError } from '@/components/toast';
import { MFNav } from './components';

function AccountForm({ acc, onClose }: { acc: InvestmentAccountItem | null; onClose: () => void }) {
  const platforms = useDb(() => listLookups('InvestmentPlatform'));
  const [v, setV] = useState({
    PersonId: acc?.PersonId ? String(acc.PersonId) : '',
    AccountName: acc?.AccountName ?? '',
    PlatformName: acc?.PlatformName ?? '',
    AccountNumber: acc?.AccountNumber ?? '',
    HolderName: acc?.HolderName ?? '',
    LinkedBankAccountId: acc?.LinkedBankAccountId ? String(acc.LinkedBankAccountId) : '',
    LoginId: '',
    Password: '',
    Status: acc?.Status ?? 'ACTIVE',
    Notes: acc?.Notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }));
  const save = async () => {
    if (!v.PersonId) return toastError('Choose the person who owns this account');
    setBusy(true);
    try {
      const input = {
        ...v,
        PersonId: Number(v.PersonId),
        LinkedBankAccountId: v.LinkedBankAccountId ? Number(v.LinkedBankAccountId) : null,
        Status: v.Status as 'ACTIVE' | 'CLOSED',
      };
      if (acc) await updateInvestmentAccount(acc.InvestmentAccountId, input);
      else await createInvestmentAccount(input);
      toast('Saved');
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={acc ? 'Edit investment account' : 'Add investment account'}
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
        <FormGrid>
          <Field label="Person" required>
            <PersonSelect
              placeholder="Select…"
              value={v.PersonId}
              onChange={(e) => set({ PersonId: e.target.value })}
            />
          </Field>
          <Field label="Platform">
            <Input
              list="platform-list"
              value={v.PlatformName}
              onChange={(e) => set({ PlatformName: e.target.value })}
            />
            <datalist id="platform-list">
              {platforms.map((pl) => (
                <option key={pl.Code} value={pl.Label} />
              ))}
            </datalist>
          </Field>
          <Field label="Account name" required hint='e.g. "Karan – Groww", "Kids – MF Central"'>
            <Input value={v.AccountName} onChange={(e) => set({ AccountName: e.target.value })} />
          </Field>
          <Field label="Client ID on platform">
            <Input
              value={v.AccountNumber}
              onChange={(e) => set({ AccountNumber: e.target.value })}
            />
          </Field>
          <Field label="Holder name (as on platform)">
            <Input value={v.HolderName} onChange={(e) => set({ HolderName: e.target.value })} />
          </Field>
          <Field label="Default bank for SIP debits">
            <AccountSelect
              placeholder="—"
              value={v.LinkedBankAccountId}
              onChange={(e) => set({ LinkedBankAccountId: e.target.value })}
            />
          </Field>
          <Field
            label="Login ID"
            hint={acc?.LoginId_Enc ? 'Saved. Leave blank to keep.' : 'Encrypted.'}
          >
            <Input
              autoComplete="off"
              value={v.LoginId}
              onChange={(e) => set({ LoginId: e.target.value })}
            />
          </Field>
          <Field
            label="Password"
            hint={acc?.Password_Enc ? 'Saved. Leave blank to keep.' : 'Encrypted.'}
          >
            <PassphraseInput
              value={v.Password}
              onChange={(x) => set({ Password: x })}
              autoComplete="off"
            />
          </Field>
          <Field label="Status">
            <Select
              value={v.Status}
              onChange={(e) => set({ Status: e.target.value as 'ACTIVE' | 'CLOSED' })}
            >
              <option value="ACTIVE">Active</option>
              <option value="CLOSED">Closed</option>
            </Select>
          </Field>
        </FormGrid>
        <Field label="Notes">
          <Textarea rows={2} value={v.Notes} onChange={(e) => set({ Notes: e.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}

function FolioPersonsEditor({
  value,
  onChange,
}: {
  value: FolioPersonInput[];
  onChange: (v: FolioPersonInput[]) => void;
}) {
  const people = useDb(() => listPersons());
  const set = (i: number, p: Partial<FolioPersonInput>) =>
    onChange(value.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-2">
      {value.map((h, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select
            className="min-w-40 flex-1"
            value={h.PersonId || ''}
            onChange={(e) => set(i, { PersonId: Number(e.target.value) })}
            aria-label="Person"
          >
            <option value="">Person…</option>
            {people.map((p) => (
              <option key={p.PersonId} value={p.PersonId}>
                {personName(p)}
              </option>
            ))}
          </Select>
          <Select
            className="w-40"
            value={h.Role}
            onChange={(e) => set(i, { Role: e.target.value as FolioRole })}
            aria-label="Role"
          >
            {Object.entries(FOLIO_ROLE_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
          {h.Role === 'NOMINEE' && (
            <Input
              className="w-24"
              placeholder="Share %"
              value={h.SharePercent ?? ''}
              onChange={(e) => set(i, { SharePercent: e.target.value })}
              aria-label="Share percent"
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Remove"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          onChange([...value, { PersonId: 0, Role: value.length ? 'NOMINEE' : 'PRIMARY' }])
        }
      >
        + Add person
      </Button>
    </div>
  );
}

function FolioForm({
  folio,
  accounts,
  defaultAccountId,
  onClose,
}: {
  folio: FolioItem | null;
  accounts: InvestmentAccountItem[];
  defaultAccountId?: number;
  onClose: () => void;
}) {
  const amcs = useDb(() => [...new Set(listFunds(true).map((f) => f.AMCName))]);
  const initialAccount =
    folio?.InvestmentAccountId ?? defaultAccountId ?? accounts[0]?.InvestmentAccountId ?? 0;
  const owner = accounts.find((a) => a.InvestmentAccountId === initialAccount)?.PersonId ?? 0;
  const [v, setV] = useState({
    InvestmentAccountId: String(initialAccount || ''),
    AMCName: folio?.AMCName ?? '',
    FolioNumber: folio?.FolioNumber ?? '',
    ModeOfHolding: folio?.ModeOfHolding ?? 'SINGLE',
    BankAccountId: folio?.BankAccountId ? String(folio.BankAccountId) : '',
    Status: folio?.Status ?? 'ACTIVE',
    Notes: folio?.Notes ?? '',
  });
  const [persons, setPersons] = useState<FolioPersonInput[]>(() =>
    folio
      ? listFolioPersons(folio.FolioId).map(({ PersonId, Role, SharePercent }) => ({
          PersonId,
          Role,
          SharePercent,
        }))
      : owner
        ? [{ PersonId: owner, Role: 'PRIMARY' }]
        : [],
  );
  const set = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }));
  const save = () => {
    try {
      const input = {
        ...v,
        InvestmentAccountId: Number(v.InvestmentAccountId),
        BankAccountId: v.BankAccountId ? Number(v.BankAccountId) : null,
        ModeOfHolding: v.ModeOfHolding as FolioItem['ModeOfHolding'],
        Status: v.Status as FolioItem['Status'],
      };
      const ps = persons.filter((p) => p.PersonId);
      if (folio) updateFolio(folio.FolioId, input, ps);
      else createFolio(input, ps);
      toast('Saved');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={folio ? 'Edit folio' : 'Add folio'}
      footer={<Button onClick={save}>Save</Button>}
    >
      <div className="space-y-4">
        <FormGrid>
          <Field label="Investment account" required>
            <Select
              value={v.InvestmentAccountId}
              onChange={(e) => set({ InvestmentAccountId: e.target.value })}
            >
              {accounts.map((a) => (
                <option key={a.InvestmentAccountId} value={a.InvestmentAccountId}>
                  {a.AccountName} ({a.PersonName})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="AMC" required>
            <Input
              list="amc-list"
              placeholder="HDFC Mutual Fund"
              value={v.AMCName}
              onChange={(e) => set({ AMCName: e.target.value })}
            />
            <datalist id="amc-list">
              {amcs.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </Field>
          <Field label="Folio number" required>
            <Input value={v.FolioNumber} onChange={(e) => set({ FolioNumber: e.target.value })} />
          </Field>
          <Field label="Mode of holding">
            <Select
              value={v.ModeOfHolding}
              onChange={(e) => set({ ModeOfHolding: e.target.value as FolioItem['ModeOfHolding'] })}
            >
              <option value="SINGLE">Single</option>
              <option value="JOINT">Joint</option>
              <option value="ANYONE_OR_SURVIVOR">Anyone or survivor</option>
            </Select>
          </Field>
          <Field label="Payout / redemption bank on record">
            <AccountSelect
              placeholder="—"
              value={v.BankAccountId}
              onChange={(e) => set({ BankAccountId: e.target.value })}
            />
          </Field>
          <Field label="Status">
            <Select
              value={v.Status}
              onChange={(e) => set({ Status: e.target.value as FolioItem['Status'] })}
            >
              <option value="ACTIVE">Active</option>
              <option value="CLOSED">Closed</option>
            </Select>
          </Field>
        </FormGrid>
        <div>
          <p className="mb-2 text-sm font-medium">Holders, nominees &amp; guardian</p>
          <FolioPersonsEditor value={persons} onChange={setPersons} />
          <p className="mt-2 text-xs text-slate-500">
            For a minor's folio, add the parent as Guardian.
          </p>
        </div>
        <Field label="Notes">
          <Textarea rows={2} value={v.Notes} onChange={(e) => set({ Notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function AccountsFoliosPage() {
  const [showClosed, setShowClosed] = useState(false);
  const accounts = useDb(() => listInvestmentAccounts(showClosed), [showClosed]);
  const folios = useDb(() => listFolios({ includeClosed: showClosed }), [showClosed]);
  const [editAcc, setEditAcc] = useState<InvestmentAccountItem | null | 'new'>(null);
  const [editFolio, setEditFolio] = useState<{
    folio: FolioItem | null;
    accountId?: number;
  } | null>(null);
  const activeAccounts = useDb(() => listInvestmentAccounts());

  return (
    <>
      <PageHeader
        title="Mutual funds"
        actions={
          <>
            <Checkbox
              label="Show closed"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            <Button onClick={() => setEditAcc('new')}>Add account</Button>
          </>
        }
      />
      <MFNav />
      {accounts.length === 0 ? (
        <EmptyState
          title="No investment accounts yet"
          action={<Button onClick={() => setEditAcc('new')}>Add account</Button>}
        >
          One per person per platform, e.g. "Karan – Groww", "Simran – Zerodha Coin", "Aara – MF
          Central".
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {accounts.map((a) => {
            const fs = folios.filter((f) => f.InvestmentAccountId === a.InvestmentAccountId);
            return (
              <Card
                key={a.InvestmentAccountId}
                title={
                  <span>
                    {a.AccountName}
                    <span className="block text-xs font-normal text-slate-500">
                      {a.PersonName}
                      {a.PlatformName && ` · ${a.PlatformName}`}
                      {a.AccountNumber && ` · client ${a.AccountNumber}`}
                    </span>
                  </span>
                }
                actions={
                  <>
                    {a.Status === 'CLOSED' && <Badge tone="red">closed</Badge>}
                    <Button size="sm" variant="ghost" onClick={() => setEditAcc(a)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setEditFolio({ folio: null, accountId: a.InvestmentAccountId })
                      }
                    >
                      + Folio
                    </Button>
                  </>
                }
              >
                {(a.LoginId_Enc || a.Password_Enc) && (
                  <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {a.LoginId_Enc && (
                      <span className="flex items-center gap-2">
                        <span className="text-slate-500">Login</span>
                        <SecretField value={a.LoginId_Enc} />
                      </span>
                    )}
                    {a.Password_Enc && (
                      <span className="flex items-center gap-2">
                        <span className="text-slate-500">Password</span>
                        <SecretField value={a.Password_Enc} />
                      </span>
                    )}
                  </div>
                )}
                {fs.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No folios yet. They are created automatically on your first transaction or CAS
                    import.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                    {fs.map((f) => (
                      <li
                        key={f.FolioId}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <div className="min-w-0">
                          <p className="font-medium">
                            {f.AMCName} · <span className="font-mono">{f.FolioNumber}</span>
                          </p>
                          <p className="text-xs text-slate-500">
                            {f.Holders ?? 'No holders recorded'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {f.Status === 'CLOSED' && <Badge tone="red">closed</Badge>}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditFolio({ folio: f })}
                          >
                            Edit
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {activeAccounts.length === 0 && accounts.length > 0 && (
        <Alert>All accounts are closed.</Alert>
      )}
      {editAcc && (
        <AccountForm acc={editAcc === 'new' ? null : editAcc} onClose={() => setEditAcc(null)} />
      )}
      {editFolio && (
        <FolioForm
          folio={editFolio.folio}
          accounts={activeAccounts}
          defaultAccountId={editFolio.accountId}
          onClose={() => setEditFolio(null)}
        />
      )}
    </>
  );
}
