import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDb } from '@/app/session';
import { parseToPaise, paiseToInput } from '@/lib/money';
import { moneyField, optDate, optText, percentField } from '@/lib/validators';
import {
  createAccount,
  updateAccount,
  type AccountListItem,
  type AccountPersonInput,
  type HolderRole,
} from '@/repositories/accounts';
import { listBanks, bankLabel } from '@/repositories/banks';
import { listLookups } from '@/repositories/lookups';
import { listPersons, personName } from '@/repositories/persons';
import { Alert, Button, Field, FormGrid, Input, Modal, Select, Textarea } from '@/components/ui';
import { LookupSelect, MoneyInput } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';

const DEPOSIT_TYPES = ['PPF', 'SukanyaSamriddhi', 'FD', 'RD'];

const schema = z.object({
  BankId: z.string().min(1, 'Choose a bank'),
  AccountType: z.string().min(1, 'Required'),
  AccountNumber: z
    .string()
    .transform((v) => v.replace(/\s/g, ''))
    .refine(
      (v) => v === '' || /^[A-Za-z0-9-]{4,34}$/.test(v),
      'Letters/digits only, 4–34 characters',
    )
    .default(''),
  CustomerId: optText,
  OpenedOn: optDate,
  MaturityDate: optDate,
  InterestRate: percentField,
  OpeningBalance: moneyField({ allowNegative: true }),
  OpeningBalanceDate: optDate,
  DebitCardLast4: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{4}$/.test(v), '4 digits')
    .default(''),
  Notes: optText,
});
type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

export function HoldersEditor({
  value,
  onChange,
}: {
  value: AccountPersonInput[];
  onChange: (v: AccountPersonInput[]) => void;
}) {
  const people = useDb(() => listPersons());
  const roles = useDb(() => listLookups('AccountRole'));
  const set = (i: number, patch: Partial<AccountPersonInput>) =>
    onChange(value.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  if (!people.length) return <Alert>Add family members first (Family page).</Alert>;
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
            className="w-36"
            value={h.Role}
            onChange={(e) => set(i, { Role: e.target.value as HolderRole })}
            aria-label="Role"
          >
            {roles.map((r) => (
              <option key={r.Code} value={r.Code}>
                {r.Label}
              </option>
            ))}
          </Select>
          {h.Role === 'Nominee' && (
            <Input
              className="w-24"
              placeholder="Share %"
              inputMode="decimal"
              value={h.SharePercent ?? ''}
              onChange={(e) => set(i, { SharePercent: e.target.value })}
              aria-label="Share percent"
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label="Remove"
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          onChange([
            ...value,
            { PersonId: 0, Role: value.some((h) => h.Role === 'Primary') ? 'Joint' : 'Primary' },
          ])
        }
      >
        + Add person
      </Button>
    </div>
  );
}

export function AccountForm({
  account,
  defaultBankId,
  onClose,
  onCreated,
}: {
  account: AccountListItem | null;
  defaultBankId?: number;
  onClose: () => void;
  onCreated?: (id: number) => void;
}) {
  const banks = useDb(() => listBanks());
  const self = useDb(() => listPersons().find((p) => p.Relationship === 'Self'));
  const [holders, setHolders] = useState<AccountPersonInput[]>(
    self ? [{ PersonId: self.PersonId, Role: 'Primary' }] : [{ PersonId: 0, Role: 'Primary' }],
  );
  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: {
      BankId: String(account?.BankId ?? defaultBankId ?? ''),
      AccountType: account?.AccountType ?? 'Savings',
      AccountNumber: '',
      CustomerId: account?.CustomerId ?? '',
      OpenedOn: account?.OpenedOn ?? '',
      MaturityDate: account?.MaturityDate ?? '',
      InterestRate: account?.InterestRate ?? '',
      OpeningBalance: account ? paiseToInput(account.OpeningBalance) : '',
      OpeningBalanceDate: account?.OpeningBalanceDate ?? '',
      DebitCardLast4: account?.DebitCardLast4 ?? '',
      Notes: account?.Notes ?? '',
    },
  });
  const type = watch('AccountType');

  const submit = handleSubmit(async (v) => {
    if (!account && !v.AccountNumber) return setError('AccountNumber', { message: 'Required' });
    const input = {
      ...v,
      BankId: Number(v.BankId),
      OpeningBalance: parseToPaise(v.OpeningBalance) ?? 0,
    };
    try {
      if (account) {
        await updateAccount(account.AccountId, input);
        toast('Saved');
      } else {
        const valid = holders.filter((h) => h.PersonId);
        const id = await createAccount(input, valid);
        toast('Account added');
        onCreated?.(id);
      }
      onClose();
    } catch (e) {
      toastError(e);
    }
  });

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={account ? 'Edit account' : 'Add account'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={isSubmitting} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      {banks.length === 0 ? (
        <Alert>Add a bank first (Banks page).</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <FormGrid>
            <Field label="Bank / branch" required error={errors.BankId?.message}>
              <Select {...register('BankId')}>
                <option value="">Select…</option>
                {banks.map((b) => (
                  <option key={b.BankId} value={b.BankId}>
                    {bankLabel(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Account type" required error={errors.AccountType?.message}>
              <LookupSelect category="AccountType" {...register('AccountType')} />
            </Field>
            <Field
              label="Account number"
              required={!account}
              error={errors.AccountNumber?.message}
              hint={
                account
                  ? `Saved ··${account.AccountNumberLast4}. Leave blank to keep.`
                  : 'Stored encrypted.'
              }
            >
              <Input autoComplete="off" spellCheck={false} {...register('AccountNumber')} />
            </Field>
            <Field label="Customer ID / CIF">
              <Input autoComplete="off" {...register('CustomerId')} />
            </Field>
            <Field label="Opened on" error={errors.OpenedOn?.message}>
              <Input type="date" {...register('OpenedOn')} />
            </Field>
            {(DEPOSIT_TYPES.includes(type) || account?.MaturityDate) && (
              <Field label="Maturity date" error={errors.MaturityDate?.message}>
                <Input type="date" {...register('MaturityDate')} />
              </Field>
            )}
            <Field label="Interest rate (% p.a.)" error={errors.InterestRate?.message}>
              <Input inputMode="decimal" placeholder="7.10" {...register('InterestRate')} />
            </Field>
            <Field
              label="Opening balance"
              error={errors.OpeningBalance?.message}
              hint="Balance before the first transaction you record or import."
            >
              <MoneyInput {...register('OpeningBalance')} />
            </Field>
            <Field label="Opening balance as of" error={errors.OpeningBalanceDate?.message}>
              <Input type="date" {...register('OpeningBalanceDate')} />
            </Field>
            {!DEPOSIT_TYPES.includes(type) && (
              <Field label="Debit card last 4" error={errors.DebitCardLast4?.message}>
                <Input inputMode="numeric" maxLength={4} {...register('DebitCardLast4')} />
              </Field>
            )}
          </FormGrid>
          {!account && (
            <div>
              <p className="mb-2 text-sm font-medium">Holders &amp; nominees</p>
              <HoldersEditor value={holders} onChange={setHolders} />
            </div>
          )}
          <Field label="Notes">
            <Textarea rows={2} {...register('Notes')} />
          </Field>
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}
