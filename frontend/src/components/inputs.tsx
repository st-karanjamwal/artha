import {
  useMemo,
  useState,
  type InputHTMLAttributes,
  type Ref,
  type SelectHTMLAttributes,
} from 'react';
import { formatINR } from '@/lib/money';
import { listLookups, type LookupCategory } from '@/repositories/lookups';
import { listPersons, personName } from '@/repositories/persons';
import { listAccounts, accountLabel } from '@/repositories/accounts';
import { listCategories } from '@/repositories/categories';
import { useDb } from '@/app/session';
import { Input, Select, cx } from './ui';

/** Text input for rupee amounts; value stays a string and is parsed to paise on submit. */
export function MoneyInput({
  className,
  ref,
  ...p
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-400"
      >
        ₹
      </span>
      <Input
        ref={ref}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        {...p}
        className={cx('pl-7 text-right num', className)}
      />
    </div>
  );
}

export function Money({
  paise,
  className,
  colored,
}: {
  paise: number | null | undefined;
  className?: string;
  colored?: boolean;
}) {
  if (paise == null) return null;
  return (
    <span
      className={cx('num whitespace-nowrap', colored && paise < 0 && 'text-red-600', className)}
    >
      {formatINR(paise)}
    </span>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  ref?: Ref<HTMLSelectElement>;
  placeholder?: string;
};

export function LookupSelect({
  category,
  placeholder,
  ...p
}: SelectProps & { category: LookupCategory }) {
  const items = useDb(() => listLookups(category), [category]);
  return (
    <Select {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {items.map((l) => (
        <option key={l.Code} value={l.Code}>
          {l.Label}
        </option>
      ))}
    </Select>
  );
}

export function PersonSelect({ placeholder, ...p }: SelectProps) {
  const items = useDb(() => listPersons());
  return (
    <Select {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {items.map((x) => (
        <option key={x.PersonId} value={x.PersonId}>
          {personName(x)} ({x.Relationship})
        </option>
      ))}
    </Select>
  );
}

export function AccountSelect({ placeholder, ...p }: SelectProps) {
  const items = useDb(() => listAccounts());
  return (
    <Select {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {items.map((a) => (
        <option key={a.AccountId} value={a.AccountId}>
          {accountLabel(a)}
          {a.PrimaryHolder ? ` — ${a.PrimaryHolder}` : ''}
        </option>
      ))}
    </Select>
  );
}

export function CategorySelect({ placeholder, ...p }: SelectProps) {
  const items = useDb(() => listCategories());
  const groups = useMemo(() => {
    const g = new Map<string, typeof items>();
    for (const c of items) g.set(c.Kind, [...(g.get(c.Kind) ?? []), c]);
    return [...g.entries()];
  }, [items]);
  return (
    <Select {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {groups.map(([kind, cats]) => (
        <optgroup key={kind} label={kind}>
          {cats.map((c) => (
            <option key={c.CategoryId} value={c.CategoryId}>
              {c.FullName}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** Rough passphrase strength estimate (length + character variety). */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  const bits = p.length * Math.log2(Math.max(pool, 1));
  const score = (bits < 50 ? 0 : bits < 65 ? 1 : bits < 80 ? 2 : bits < 100 ? 3 : 4) as
    0 | 1 | 2 | 3 | 4;
  return { score, label: ['Too weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score] };
}

export function PassphraseInput({
  value,
  onChange,
  showStrength,
  autoFocus,
  autoComplete = 'new-password',
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  showStrength?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  id?: string;
}) {
  const [show, setShow] = useState(false);
  const s = passphraseStrength(value);
  return (
    <div>
      <div className="relative">
        <Input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="pr-16"
        />
        <button
          type="button"
          onClick={() => setShow((x) => !x)}
          className="absolute inset-y-0 right-2 my-auto h-7 rounded px-2 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {showStrength && value && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex flex-1 gap-1">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={cx(
                  'h-1.5 flex-1 rounded-full',
                  i < s.score
                    ? s.score >= 3
                      ? 'bg-emerald-500'
                      : 'bg-amber-500'
                    : 'bg-slate-200 dark:bg-slate-700',
                )}
              />
            ))}
          </div>
          <span className="text-xs text-slate-500">{s.label}</span>
        </div>
      )}
    </div>
  );
}
