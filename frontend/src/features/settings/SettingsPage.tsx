import { useEffect, useState } from 'react';
import { api, type BackupStatus, type VaultVersion } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { useStore } from '@/lib/store';
import { changePassphrase, exportEncrypted, restoreServerVersion, useDb } from '@/app/session';
import { getSaveTarget, saveStatus } from '@/db/save';
import { LATEST_SCHEMA_VERSION } from '@/db/migrate';
import { scalar } from '@/db/sql';
import { getAppSettings, saveAppSettings } from '@/repositories/settings';
import {
  LOOKUP_CATEGORIES,
  addLookup,
  listLookups,
  updateLookup,
  type LookupCategory,
} from '@/repositories/lookups';
import {
  CATEGORY_KINDS,
  createCategory,
  listCategories,
  updateCategory,
  type CategoryKind,
} from '@/repositories/categories';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Field,
  Input,
  PageHeader,
  Select,
  Tabs,
} from '@/components/ui';
import { PassphraseInput, passphraseStrength } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';
import { ImportVaultFile } from '@/features/onboarding/Onboarding';
import { defaultTaxRules, getTaxRules, saveTaxRules } from '@/repositories/mfPortfolio';
import { Textarea } from '@/components/ui';

type Tab = 'security' | 'backup' | 'lists';

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('security');
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'security', label: 'Security' },
          { id: 'backup', label: 'Backup & restore' },
          { id: 'lists', label: 'Lists & categories' },
        ]}
      />
      {tab === 'security' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <LockSettings />
          <ChangePassphrase />
          <ChangeLoginPassword />
          <About />
        </div>
      )}
      {tab === 'backup' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Backup />
          <ExportImport />
          <Versions />
        </div>
      )}
      {tab === 'lists' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Lookups />
          <Categories />
          <TaxRulesEditor />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- security

function LockSettings() {
  const current = useDb(getAppSettings);
  const [s, setS] = useState(current);
  useEffect(() => setS(current), [current]);
  const dirty = JSON.stringify(s) !== JSON.stringify(current);
  return (
    <Card title="Auto-lock & reveal">
      <div className="space-y-4">
        <Field label="Auto-lock after inactivity (minutes)">
          <Input
            type="number"
            min={1}
            max={120}
            value={s.autoLockMinutes}
            onChange={(e) =>
              setS({
                ...s,
                autoLockMinutes: Math.max(1, Math.min(120, Number(e.target.value) || 1)),
              })
            }
          />
        </Field>
        <Checkbox
          label="Lock when the tab is hidden or the app is backgrounded"
          checked={s.lockOnHide}
          onChange={(e) => setS({ ...s, lockOnHide: e.target.checked })}
        />
        <Checkbox
          label="Ask for the passphrase before revealing or copying secrets"
          checked={s.revealRequiresPassphrase}
          onChange={(e) => setS({ ...s, revealRequiresPassphrase: e.target.checked })}
        />
        <div className="flex justify-end">
          <Button
            disabled={!dirty}
            onClick={() => {
              saveAppSettings(s);
              toast('Settings saved');
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ChangePassphrase() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    if (next.length < 12) return setErr('Use at least 12 characters');
    if (passphraseStrength(next).score < 2) return setErr('Choose a stronger passphrase');
    if (next !== next2) return setErr('New passphrases do not match');
    setBusy(true);
    try {
      await changePassphrase(cur, next);
      setCur('');
      setNext('');
      setNext2('');
      toast('Passphrase changed. Use the new one next time you unlock.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Change vault passphrase">
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <p className="text-xs text-slate-500">
          Re-wraps the encryption key only; your recovery key keeps working.
        </p>
        <Field label="Current passphrase">
          <PassphraseInput value={cur} onChange={setCur} autoComplete="current-password" />
        </Field>
        <Field label="New passphrase">
          <PassphraseInput value={next} onChange={setNext} showStrength />
        </Field>
        <Field label="Confirm new passphrase">
          <Input
            type="password"
            autoComplete="new-password"
            value={next2}
            onChange={(e) => setNext2(e.target.value)}
          />
        </Field>
        {err && <Alert tone="red">{err}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" busy={busy}>
            Change passphrase
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ChangeLoginPassword() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    if (next.length < 12) return setErr('Use at least 12 characters');
    setBusy(true);
    try {
      await api.changeLoginPassword(cur, next, code);
      setCur('');
      setNext('');
      setCode('');
      toast('Server login password changed. Other devices are signed out.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Change server login password">
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Current login password">
          <Input
            type="password"
            autoComplete="current-password"
            value={cur}
            onChange={(e) => setCur(e.target.value)}
          />
        </Field>
        <Field label="New login password">
          <PassphraseInput value={next} onChange={setNext} showStrength />
        </Field>
        <Field label="Authenticator code">
          <Input
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        {err && <Alert tone="red">{err}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" busy={busy}>
            Change login password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function About() {
  const status = useStore(saveStatus);
  const counts = useDb(() => ({
    persons: scalar<number>('SELECT COUNT(*) FROM Persons') ?? 0,
    accounts: scalar<number>('SELECT COUNT(*) FROM Accounts') ?? 0,
    txns: scalar<number>('SELECT COUNT(*) FROM Transactions') ?? 0,
  }));
  const t = getSaveTarget();
  return (
    <Card title="About this vault">
      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-slate-500">Schema version</dt>
        <dd>{LATEST_SCHEMA_VERSION}</dd>
        <dt className="text-slate-500">Server version</dt>
        <dd>#{t?.blobVersion}</dd>
        <dt className="text-slate-500">Last saved</dt>
        <dd>{status.lastSaved ? formatDateTime(status.lastSaved) : '—'}</dd>
        <dt className="text-slate-500">Created</dt>
        <dd>{t ? formatDateTime(t.header.created_on) : '—'}</dd>
        <dt className="text-slate-500">Key derivation</dt>
        <dd>
          Argon2id · {(t?.header.kdf.mem ?? 0) / 1024} MB · {t?.header.kdf.iter} iter
        </dd>
        <dt className="text-slate-500">Records</dt>
        <dd>
          {counts.persons} people · {counts.accounts} accounts · {counts.txns} txns
        </dd>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------- backup

function Backup() {
  const [s, setS] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.backupStatus().then(setS).catch(toastError);
  useEffect(() => {
    void load();
  }, []);
  return (
    <Card title="Google Drive backup">
      {!s ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !s.configured ? (
        <Alert>
          Not configured on the server. See docs/DEPLOY.md (Google Drive backup) to set it up.
        </Alert>
      ) : (
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
            <dt className="text-slate-500">Schedule</dt>
            <dd>{s.schedule}</dd>
            <dt className="text-slate-500">Retention</dt>
            <dd>{s.retention}</dd>
            <dt className="text-slate-500">Last success</dt>
            <dd>{s.last_success ? formatDateTime(s.last_success) : 'never'}</dd>
            <dt className="text-slate-500">Last file</dt>
            <dd className="break-all font-mono text-xs">{s.last_file ?? '—'}</dd>
            <dt className="text-slate-500">Last result</dt>
            <dd>{s.last_result ?? '—'}</dd>
          </dl>
          {s.last_error && <Alert tone="red">{s.last_error}</Alert>}
          <div className="flex justify-end">
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setS(await api.backupRun());
                  toast('Backup uploaded');
                } catch (e) {
                  toastError(e);
                  void load();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Back up now
            </Button>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Only the encrypted vault file is uploaded. Keep your recovery key somewhere else.
      </p>
    </Card>
  );
}

function ExportImport() {
  const [importing, setImporting] = useState(false);
  const download = async () => {
    try {
      const blob = await exportEncrypted();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      a.href = url;
      a.download = `artha_${d.toISOString().slice(0, 10)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.vault`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Card title="Export / import vault file">
      <p className="mb-3 text-sm text-slate-500">
        The exported file is encrypted with your current passphrase and recovery key. Store it
        anywhere.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={download}>Export vault</Button>
        <Button variant="secondary" onClick={() => setImporting((x) => !x)}>
          {importing ? 'Cancel import' : 'Import vault file…'}
        </Button>
      </div>
      {importing && (
        <div className="mt-4">
          <Alert>
            Importing replaces the current vault (it becomes a new version; older versions remain
            restorable).
          </Alert>
          <div className="mt-3">
            <ImportVaultFile onDone={() => {}} />
          </div>
        </div>
      )}
    </Card>
  );
}

function Versions() {
  const [data, setData] = useState<{ current_version: number; versions: VaultVersion[] } | null>(
    null,
  );
  const [restoring, setRestoring] = useState<number | null>(null);
  useEffect(() => {
    api.versions().then(setData).catch(toastError);
  }, []);
  return (
    <Card title="Version history (server)" className="lg:col-span-2">
      <p className="mb-3 text-sm text-slate-500">
        Every save keeps a copy; the last 30 are retained. Restoring copies an old version forward
        as the newest one. An old version unlocks with the passphrase that was valid when it was
        saved.
      </p>
      {!data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {data.versions.map((v) => (
            <li
              key={v.blob_version}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span>
                #{v.blob_version} · {formatDateTime(v.saved_on)} · {(v.size / 1024).toFixed(0)} KB{' '}
                {v.blob_version === data.current_version && <Badge tone="brand">current</Badge>}
              </span>
              <span className="flex gap-2">
                <a
                  href={`/api/vault/versions/${v.blob_version}`}
                  className="text-brand-700 hover:underline dark:text-brand-500"
                >
                  Download
                </a>
                {v.blob_version !== data.current_version && (
                  <button
                    className="text-brand-700 hover:underline dark:text-brand-500"
                    onClick={() => setRestoring(v.blob_version)}
                  >
                    Restore
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={restoring != null}
        danger
        title={`Restore version #${restoring}?`}
        message="Unsaved changes on this device are discarded. The vault will lock and you unlock the restored version."
        confirmLabel="Restore"
        onCancel={() => setRestoring(null)}
        onConfirm={async () => {
          try {
            await restoreServerVersion(restoring!);
          } catch (e) {
            toastError(e);
          }
          setRestoring(null);
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- lists

const CATEGORY_TITLES: Record<LookupCategory, string> = {
  Relationship: 'Relationships',
  Gender: 'Genders',
  AccountType: 'Account types',
  AccountRole: 'Account roles',
  CredentialChannel: 'Credential channels',
  TxnMode: 'Transaction modes',
  InvestmentPlatform: 'Investment platforms',
};

function Lookups() {
  const [cat, setCat] = useState<LookupCategory>('AccountType');
  const items = useDb(() => listLookups(cat, true), [cat]);
  const [label, setLabel] = useState('');
  const fixed = cat === 'AccountRole'; // roles drive validation logic
  return (
    <Card title="Lists">
      <Select value={cat} onChange={(e) => setCat(e.target.value as LookupCategory)}>
        {LOOKUP_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_TITLES[c]}
          </option>
        ))}
      </Select>
      <ul className="mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {items.map((l) => (
          <li key={l.LookupValueId} className="flex items-center gap-2 py-1.5">
            <Input
              defaultValue={l.Label}
              className="py-1"
              disabled={fixed}
              onBlur={(e) =>
                e.target.value.trim() &&
                e.target.value !== l.Label &&
                updateLookup(l.LookupValueId, e.target.value, !!l.IsActive)
              }
            />
            {!fixed && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => updateLookup(l.LookupValueId, l.Label, !l.IsActive)}
              >
                {l.IsActive ? 'Hide' : 'Show'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!fixed && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              addLookup(cat, label);
              setLabel('');
            } catch (err) {
              toastError(err);
            }
          }}
        >
          <Input placeholder="New value" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" disabled={!label.trim()}>
            Add
          </Button>
        </form>
      )}
    </Card>
  );
}

function Categories() {
  const cats = useDb(() => listCategories(true));
  const parents = cats.filter((c) => c.ParentCategoryId == null && c.IsActive);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryKind>('Expense');
  const [parent, setParent] = useState('');
  return (
    <Card title="Transaction categories">
      <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto text-sm dark:divide-slate-800">
        {cats.map((c) => (
          <li key={c.CategoryId} className="flex items-center gap-2 py-1.5">
            <span className="w-20 shrink-0 text-xs text-slate-500">{c.Kind}</span>
            <span className={c.ParentCategoryId ? 'pl-4' : ''}>
              {c.ParentCategoryId ? '↳ ' : ''}
            </span>
            <Input
              defaultValue={c.Name}
              className="py-1"
              onBlur={(e) =>
                e.target.value.trim() &&
                e.target.value !== c.Name &&
                updateCategory(c.CategoryId, e.target.value, c.Kind, !!c.IsActive)
              }
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => updateCategory(c.CategoryId, c.Name, c.Kind, !c.IsActive)}
            >
              {c.IsActive ? 'Hide' : 'Show'}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 grid grid-cols-2 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const p = parent ? cats.find((c) => c.CategoryId === Number(parent)) : undefined;
          createCategory(name, p?.Kind ?? kind, p?.CategoryId ?? null);
          setName('');
        }}
      >
        <Input
          className="col-span-2"
          placeholder="New category name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value as CategoryKind)}
          disabled={!!parent}
        >
          {CATEGORY_KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </Select>
        <Select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Top level</option>
          {parents.map((p) => (
            <option key={p.CategoryId} value={p.CategoryId}>
              Under {p.Name}
            </option>
          ))}
        </Select>
        <Button type="submit" className="col-span-2" disabled={!name.trim()}>
          Add category
        </Button>
      </form>
    </Card>
  );
}

function TaxRulesEditor() {
  const current = useDb(() => JSON.stringify(getTaxRules(), null, 2));
  const [text, setText] = useState(current);
  const [err, setErr] = useState('');
  useEffect(() => setText(current), [current]);
  const save = (value: string) => {
    try {
      saveTaxRules(JSON.parse(value));
      setErr('');
      toast('Tax rules saved');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Card title="Mutual fund tax rules" className="lg:col-span-2">
      <p className="mb-3 text-sm text-slate-500">
        Used for short/long-term classification, exemption and estimated tax on the Capital gains
        screen. Rates are in %, amounts in paise, and each regime applies by sale date. Verify with
        your CA.
      </p>
      <Textarea
        rows={16}
        className="font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {err && <Alert tone="red">{err}</Alert>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => save(JSON.stringify(defaultTaxRules()))}>
          Reset to defaults
        </Button>
        <Button disabled={text === current} onClick={() => save(text)}>
          Save rules
        </Button>
      </div>
    </Card>
  );
}
