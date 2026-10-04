import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDb } from '@/app/session';
import { IFSC_RE, MICR_RE, SWIFT_RE, optPattern, optText } from '@/lib/validators';
import { createBank, listBanks, setBankActive, updateBank, type Bank } from '@/repositories/banks';
import {
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
  Textarea,
} from '@/components/ui';
import { toast, toastError } from '@/components/toast';

const schema = z.object({
  BankName: z.string().trim().min(1, 'Required'),
  BranchName: optText,
  BranchAddress: optText,
  IFSCCode: optPattern(IFSC_RE, 'IFSC is 11 characters, e.g. SBIN0001234'),
  MICRCode: optPattern(MICR_RE, 'MICR is 9 digits'),
  SwiftCode: optPattern(SWIFT_RE, 'SWIFT is 8 or 11 characters'),
  BranchPhone: optText,
  RelationshipManager: optText,
  RMPhone: optText,
  CustomerCareNo: optText,
  Website: optText,
  Notes: optText,
});
type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

const COMMON_BANKS = [
  'State Bank of India',
  'HDFC Bank',
  'ICICI Bank',
  'Axis Bank',
  'Kotak Mahindra Bank',
  'Punjab National Bank',
  'Bank of Baroda',
  'Canara Bank',
  'Union Bank of India',
  'IndusInd Bank',
  'IDFC FIRST Bank',
  'Yes Bank',
  'India Post Payments Bank',
  'Post Office',
];

function BankForm({ bank, onClose }: { bank: Bank | null; onClose: () => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: Object.fromEntries(
      Object.keys(schema.shape).map((k) => [k, (bank?.[k as keyof Bank] as string) ?? '']),
    ) as FormIn,
  });
  const submit = handleSubmit((v) => {
    try {
      if (bank) updateBank(bank.BankId, v);
      else createBank(v);
      toast(bank ? 'Saved' : 'Bank added');
      onClose();
    } catch (e) {
      toastError(e);
    }
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={bank ? 'Edit bank' : 'Add bank / branch'}
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
      <form onSubmit={submit} className="space-y-4">
        <FormGrid>
          <Field label="Bank name" required error={errors.BankName?.message}>
            <Input list="common-banks" autoFocus {...register('BankName')} />
            <datalist id="common-banks">
              {COMMON_BANKS.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </Field>
          <Field label="Branch name">
            <Input {...register('BranchName')} />
          </Field>
          <Field label="IFSC code" error={errors.IFSCCode?.message}>
            <Input className="uppercase" maxLength={11} {...register('IFSCCode')} />
          </Field>
          <Field label="MICR code" error={errors.MICRCode?.message}>
            <Input inputMode="numeric" maxLength={9} {...register('MICRCode')} />
          </Field>
          <Field label="SWIFT code" error={errors.SwiftCode?.message}>
            <Input className="uppercase" maxLength={11} {...register('SwiftCode')} />
          </Field>
          <Field label="Branch phone">
            <Input type="tel" {...register('BranchPhone')} />
          </Field>
          <Field label="Relationship manager">
            <Input {...register('RelationshipManager')} />
          </Field>
          <Field label="RM phone">
            <Input type="tel" {...register('RMPhone')} />
          </Field>
          <Field label="Customer care no.">
            <Input type="tel" {...register('CustomerCareNo')} />
          </Field>
          <Field label="Website">
            <Input type="url" placeholder="https://" {...register('Website')} />
          </Field>
        </FormGrid>
        <Field label="Branch address">
          <Textarea rows={2} {...register('BranchAddress')} />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} {...register('Notes')} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function BanksPage() {
  const [showInactive, setShowInactive] = useState(false);
  const banks = useDb(() => listBanks(showInactive), [showInactive]);
  const [editing, setEditing] = useState<Bank | null | 'new'>(null);

  return (
    <>
      <PageHeader
        title="Banks"
        subtitle="Banks and branches where you hold accounts."
        actions={
          <>
            <Checkbox
              label="Show inactive"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            <Button onClick={() => setEditing('new')}>Add bank</Button>
          </>
        }
      />
      {banks.length === 0 ? (
        <EmptyState
          title="No banks yet"
          action={<Button onClick={() => setEditing('new')}>Add bank</Button>}
        >
          Add each bank branch once; accounts are linked to it.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {banks.map((b) => (
            <Card key={b.BankId} className={b.IsActive ? '' : 'opacity-60'}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{b.BankName}</h3>
                  <p className="truncate text-sm text-slate-500">{b.BranchName || '—'}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>
                  Edit
                </Button>
              </div>
              <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-sm">
                {b.IFSCCode && (
                  <>
                    <dt className="text-slate-500">IFSC</dt>
                    <dd className="font-mono">{b.IFSCCode}</dd>
                  </>
                )}
                {b.MICRCode && (
                  <>
                    <dt className="text-slate-500">MICR</dt>
                    <dd className="font-mono">{b.MICRCode}</dd>
                  </>
                )}
                {b.SwiftCode && (
                  <>
                    <dt className="text-slate-500">SWIFT</dt>
                    <dd className="font-mono">{b.SwiftCode}</dd>
                  </>
                )}
                {b.BranchPhone && (
                  <>
                    <dt className="text-slate-500">Branch</dt>
                    <dd>
                      <a className="underline" href={`tel:${b.BranchPhone}`}>
                        {b.BranchPhone}
                      </a>
                    </dd>
                  </>
                )}
                {b.RelationshipManager && (
                  <>
                    <dt className="text-slate-500">RM</dt>
                    <dd>
                      {b.RelationshipManager}{' '}
                      {b.RMPhone && <span className="text-slate-500">({b.RMPhone})</span>}
                    </dd>
                  </>
                )}
                {b.CustomerCareNo && (
                  <>
                    <dt className="text-slate-500">Care</dt>
                    <dd>{b.CustomerCareNo}</dd>
                  </>
                )}
                {b.BranchAddress && (
                  <>
                    <dt className="text-slate-500">Address</dt>
                    <dd className="whitespace-pre-line">{b.BranchAddress}</dd>
                  </>
                )}
              </dl>
              <div className="mt-3 flex items-center justify-between">
                <Link
                  to={`/accounts?bank=${b.BankId}`}
                  className="text-sm text-brand-700 hover:underline dark:text-brand-500"
                >
                  {b.AccountCount} account{b.AccountCount === 1 ? '' : 's'}
                </Link>
                <div className="flex items-center gap-2">
                  {!b.IsActive && <Badge tone="red">Inactive</Badge>}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setBankActive(b.BankId, !b.IsActive)}
                  >
                    {b.IsActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <BankForm bank={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}
