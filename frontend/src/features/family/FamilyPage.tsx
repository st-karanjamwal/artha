import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDb } from '@/app/session';
import { ageFrom, formatDate } from '@/lib/dates';
import { AADHAAR_RE, PAN_RE, optDate, optText } from '@/lib/validators';
import {
  createPerson,
  listPersons,
  personName,
  setPersonActive,
  updatePerson,
  type Person,
} from '@/repositories/persons';
import { lookupLabel } from '@/repositories/lookups';
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
import { LookupSelect } from '@/components/inputs';
import { SecretField } from '@/components/SecretField';
import { toast, toastError } from '@/components/toast';

const schema = z.object({
  FirstName: z.string().trim().min(1, 'Required'),
  LastName: optText,
  Relationship: z.string().min(1, 'Required'),
  DateOfBirth: optDate,
  Gender: optText,
  Email: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\S+@\S+\.\S+$/.test(v), 'Invalid email')
    .default(''),
  Phone: optText,
  Address: optText,
  Notes: optText,
  PAN: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === '' || PAN_RE.test(v), 'PAN looks like ABCDE1234F')
    .default(''),
  Aadhaar: z
    .string()
    .transform((v) => v.replace(/\s/g, ''))
    .refine((v) => v === '' || AADHAAR_RE.test(v), 'Aadhaar is 12 digits')
    .default(''),
  clearPAN: z.boolean().default(false),
  clearAadhaar: z.boolean().default(false),
});
type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

export const formatAadhaar = (v: string) => v.replace(/(\d{4})(?=\d)/g, '$1 ');

function PersonForm({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: {
      FirstName: person?.FirstName ?? '',
      LastName: person?.LastName ?? '',
      Relationship: person?.Relationship ?? '',
      DateOfBirth: person?.DateOfBirth ?? '',
      Gender: person?.Gender ?? '',
      Email: person?.Email ?? '',
      Phone: person?.Phone ?? '',
      Address: person?.Address ?? '',
      Notes: person?.Notes ?? '',
      PAN: '',
      Aadhaar: '',
      clearPAN: false,
      clearAadhaar: false,
    },
  });

  const submit = handleSubmit(async (v) => {
    try {
      if (person) await updatePerson(person.PersonId, v);
      else await createPerson(v);
      toast(person ? 'Saved' : 'Family member added');
      onClose();
    } catch (e) {
      toastError(e);
    }
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={person ? `Edit ${personName(person)}` : 'Add family member'}
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
          <Field label="First name" required error={errors.FirstName?.message}>
            <Input {...register('FirstName')} autoFocus />
          </Field>
          <Field label="Last name">
            <Input {...register('LastName')} />
          </Field>
          <Field label="Relationship" required error={errors.Relationship?.message}>
            <LookupSelect
              category="Relationship"
              placeholder="Select…"
              {...register('Relationship')}
            />
          </Field>
          <Field label="Date of birth" error={errors.DateOfBirth?.message}>
            <Input type="date" {...register('DateOfBirth')} />
          </Field>
          <Field label="Gender">
            <LookupSelect category="Gender" placeholder="—" {...register('Gender')} />
          </Field>
          <Field label="Phone">
            <Input type="tel" {...register('Phone')} />
          </Field>
          <Field label="Email" error={errors.Email?.message}>
            <Input type="email" {...register('Email')} />
          </Field>
          <Field
            label="PAN"
            error={errors.PAN?.message}
            hint={person?.PAN_Enc ? 'Leave blank to keep the saved PAN.' : 'Encrypted separately.'}
          >
            <Input className="uppercase" autoComplete="off" {...register('PAN')} />
          </Field>
          <Field
            label="Aadhaar"
            error={errors.Aadhaar?.message}
            hint={
              person?.Aadhaar_Enc
                ? 'Leave blank to keep the saved number.'
                : 'Encrypted separately.'
            }
          >
            <Input inputMode="numeric" autoComplete="off" {...register('Aadhaar')} />
          </Field>
        </FormGrid>
        {(person?.PAN_Enc || person?.Aadhaar_Enc) && (
          <div className="flex flex-wrap gap-4">
            {person?.PAN_Enc && <Checkbox label="Remove saved PAN" {...register('clearPAN')} />}
            {person?.Aadhaar_Enc && (
              <Checkbox label="Remove saved Aadhaar" {...register('clearAadhaar')} />
            )}
          </div>
        )}
        <Field label="Address">
          <Textarea rows={2} {...register('Address')} />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} {...register('Notes')} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function FamilyPage() {
  const [showInactive, setShowInactive] = useState(false);
  const people = useDb(() => listPersons(showInactive), [showInactive]);
  const [editing, setEditing] = useState<Person | null | 'new'>(null);

  return (
    <>
      <PageHeader
        title="Family"
        subtitle="Owners, joint holders and nominees across all your accounts."
        actions={
          <>
            <Checkbox
              label="Show inactive"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            <Button onClick={() => setEditing('new')}>Add member</Button>
          </>
        }
      />
      {people.length === 0 ? (
        <EmptyState
          title="No family members yet"
          action={<Button onClick={() => setEditing('new')}>Add yourself first</Button>}
        >
          Start with yourself (Self), then add your spouse and children.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {people.map((p) => {
            const age = ageFrom(p.DateOfBirth);
            return (
              <Card key={p.PersonId} className={p.IsActive ? '' : 'opacity-60'}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{personName(p)}</h3>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge tone="brand">{lookupLabel('Relationship', p.Relationship)}</Badge>
                      {age != null && <Badge>{age} yrs</Badge>}
                      {age != null && age < 18 && <Badge tone="amber">Minor</Badge>}
                      {!p.IsActive && <Badge tone="red">Inactive</Badge>}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                </div>
                <dl className="mt-3 space-y-1.5 text-sm">
                  {p.DateOfBirth && <Row k="Born">{formatDate(p.DateOfBirth)}</Row>}
                  {p.Phone && <Row k="Phone">{p.Phone}</Row>}
                  {p.Email && <Row k="Email">{p.Email}</Row>}
                  {p.PAN_Enc && (
                    <Row k="PAN">
                      <SecretField value={p.PAN_Enc} showLast4 />
                    </Row>
                  )}
                  {p.Aadhaar_Enc && (
                    <Row k="Aadhaar">
                      <SecretField value={p.Aadhaar_Enc} showLast4 format={formatAadhaar} />
                    </Row>
                  )}
                </dl>
                <div className="mt-3 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPersonActive(p.PersonId, !p.IsActive)}
                  >
                    {p.IsActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {editing && (
        <PersonForm person={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <dt className="w-16 shrink-0 text-slate-500">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
