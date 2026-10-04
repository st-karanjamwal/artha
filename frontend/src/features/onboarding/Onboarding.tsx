import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import {
  finalizeNewVault,
  importVaultFile,
  logout,
  prepareNewVault,
  refreshPhase,
  unlock,
  unlockWithRecovery,
} from '@/app/session';
import { WrongKeyError } from '@/crypto/vault';
import { Alert, Button, Checkbox, Field, Input } from '@/components/ui';
import { PassphraseInput, passphraseStrength } from '@/components/inputs';

const MIN_PASS = 12;

function Shell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg bg-brand-700 text-lg font-bold text-white">
            ₹
          </div>
          <span className="text-2xl font-semibold tracking-tight">Artha</span>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-5 space-y-4">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-slate-500">{footer}</div>}
      </div>
    </div>
  );
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- server setup

export function ServerSetup() {
  const [token, setToken] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [enrol, setEnrol] = useState<{ qr_svg: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const start = async () => {
    setErr('');
    if (pw.length < MIN_PASS)
      return setErr(`Login password must be at least ${MIN_PASS} characters`);
    if (pw !== pw2) return setErr('Passwords do not match');
    setBusy(true);
    try {
      setEnrol(await api.setupStart(token.trim(), pw));
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.setupConfirm(token.trim(), code.trim());
      await refreshPhase();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  if (enrol) {
    return (
      <Shell
        title="Set up two-factor authentication"
        subtitle="Scan with Google Authenticator, Authy, 1Password or similar."
      >
        <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void confirm())}>
          <img
            src={enrol.qr_svg}
            alt="TOTP QR code"
            className="mx-auto size-48 rounded bg-white p-2"
          />
          <p className="break-all text-center font-mono text-xs text-slate-500">{enrol.secret}</p>
          <Field label="6-digit code from the app">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          {err && <Alert tone="red">{err}</Alert>}
          <Button type="submit" className="w-full" busy={busy}>
            Verify and finish
          </Button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell
      title="First-time server setup"
      subtitle="Create the login that protects access to this server. This is separate from the vault passphrase, which never leaves your browser."
    >
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void start())}>
        <Field label="Setup token" hint="The ARTHA_SETUP_TOKEN value from the server's .env file.">
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </Field>
        <Field label="Login password" hint={`At least ${MIN_PASS} characters.`}>
          <PassphraseInput value={pw} onChange={setPw} showStrength />
        </Field>
        <Field label="Confirm login password">
          <Input
            type="password"
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </Field>
        {err && <Alert tone="red">{err}</Alert>}
        <Button type="submit" className="w-full" busy={busy}>
          Continue
        </Button>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------- login

export function Login() {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.login(pw, code.trim());
      setPw('');
      await refreshPhase();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Sign in" subtitle="Server login. You will unlock the vault next.">
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Login password">
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
        <Field label="Authenticator code">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        {err && <Alert tone="red">{err}</Alert>}
        <Button type="submit" className="w-full" busy={busy}>
          Sign in
        </Button>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------- create vault

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function recoverySheet(key: string) {
  return [
    'ARTHA VAULT — RECOVERY KEY',
    '',
    key,
    '',
    `Created: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'This key can unlock your vault if you forget the passphrase.',
    'Keep it offline (printed, or in a password manager).',
    'Do NOT store it in the same Google Drive as your vault backups.',
  ].join('\n');
}

export function CreateVault() {
  const [step, setStep] = useState<'pass' | 'key' | 'confirm' | 'import'>('pass');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [checks, setChecks] = useState<number[]>([]);
  const [answers, setAnswers] = useState(['', '']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const groups = recoveryKey.split('-');

  const createKeys = async () => {
    setErr('');
    if (pass.length < MIN_PASS) return setErr(`Use at least ${MIN_PASS} characters`);
    if (passphraseStrength(pass).score < 2)
      return setErr('Choose a stronger passphrase (try 4+ random words)');
    if (pass !== pass2) return setErr('Passphrases do not match');
    setBusy(true);
    try {
      const k = await prepareNewVault(pass);
      setRecoveryKey(k);
      const a = Math.floor(Math.random() * 6);
      setChecks([a, 6 + Math.floor(Math.random() * 7)]);
      setPass('');
      setPass2('');
      setStep('key');
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setErr('');
    const ok = checks.every((g, i) => answers[i].trim().toUpperCase() === groups[g]);
    if (!ok) return setErr('Those groups do not match your recovery key');
    setBusy(true);
    try {
      await finalizeNewVault();
    } catch (e) {
      setErr(msg(e));
      setBusy(false);
    }
  };

  if (step === 'import') return <ImportVaultFile onBack={() => setStep('pass')} />;

  if (step === 'key') {
    return (
      <Shell
        title="Save your recovery key"
        subtitle="Shown once. It is the only way back in if you forget the passphrase."
      >
        <div className="rounded-lg border-2 border-dashed border-brand-600 bg-brand-50 p-4 text-center font-mono text-base leading-relaxed tracking-wider break-words text-slate-900 dark:bg-slate-950 dark:text-slate-100">
          {recoveryKey}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => downloadText('artha-recovery-key.txt', recoverySheet(recoveryKey))}
          >
            Download .txt
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => {
              const w = window.open('', '_blank', 'width=600,height=400');
              if (!w) return;
              const pre = w.document.createElement('pre');
              pre.style.cssText = 'font:16px/1.6 monospace;white-space:pre-wrap;padding:24px';
              pre.textContent = recoverySheet(recoveryKey);
              w.document.body.appendChild(pre);
              w.print();
            }}
          >
            Print
          </Button>
        </div>
        <Alert>Keep it offline, not in the same Google Drive as your backups.</Alert>
        <Checkbox
          label="I have saved the recovery key somewhere safe"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        <Button className="w-full" disabled={!saved} onClick={() => setStep('confirm')}>
          Continue
        </Button>
      </Shell>
    );
  }

  if (step === 'confirm') {
    return (
      <Shell
        title="Confirm your recovery key"
        subtitle="Type the requested groups from your saved copy."
      >
        <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void finish())}>
          {checks.map((g, i) => (
            <Field key={g} label={`Group #${g + 1}`}>
              <Input
                className="font-mono uppercase"
                maxLength={4}
                autoComplete="off"
                autoFocus={i === 0}
                value={answers[i]}
                onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
              />
            </Field>
          ))}
          {err && <Alert tone="red">{err}</Alert>}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep('key')}>
              Back
            </Button>
            <Button type="submit" className="flex-1" busy={busy}>
              Create vault
            </Button>
          </div>
        </form>
      </Shell>
    );
  }

  return (
    <Shell
      title="Create your vault"
      subtitle="Choose a master passphrase. It encrypts everything in your browser and is never sent to the server."
      footer={
        <button className="underline" onClick={() => setStep('import')}>
          Restore from a .vault backup file instead
        </button>
      }
    >
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void createKeys())}>
        <Field label="Master passphrase" hint="Tip: 4–6 random words are strong and memorable.">
          <PassphraseInput value={pass} onChange={setPass} showStrength autoFocus />
        </Field>
        <Field label="Confirm passphrase">
          <Input
            type="password"
            autoComplete="new-password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
          />
        </Field>
        {err && <Alert tone="red">{err}</Alert>}
        <Button type="submit" className="w-full" busy={busy}>
          {busy ? 'Deriving key…' : 'Continue'}
        </Button>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------- unlock

export function Unlock({ error }: { error?: string }) {
  const [mode, setMode] = useState<'pass' | 'recovery'>('pass');
  const [pass, setPass] = useState('');
  const [rk, setRk] = useState('');
  const [np, setNp] = useState('');
  const [np2, setNp2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error ?? '');

  const run = async (fn: () => Promise<void>) => {
    setErr('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof WrongKeyError ? e.message : msg(e));
      setBusy(false);
    }
  };

  if (mode === 'recovery') {
    return (
      <Shell
        title="Unlock with recovery key"
        subtitle="Then choose a new passphrase."
        footer={
          <button className="underline" onClick={() => setMode('pass')}>
            Back to passphrase
          </button>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (np.length < MIN_PASS) return setErr(`Use at least ${MIN_PASS} characters`);
            if (np !== np2) return setErr('Passphrases do not match');
            void run(() => unlockWithRecovery(rk, np));
          }}
        >
          <Field label="Recovery key">
            <Input
              className="font-mono uppercase"
              autoComplete="off"
              spellCheck={false}
              value={rk}
              onChange={(e) => setRk(e.target.value)}
            />
          </Field>
          <Field label="New passphrase">
            <PassphraseInput value={np} onChange={setNp} showStrength />
          </Field>
          <Field label="Confirm new passphrase">
            <Input
              type="password"
              autoComplete="new-password"
              value={np2}
              onChange={(e) => setNp2(e.target.value)}
            />
          </Field>
          {err && <Alert tone="red">{err}</Alert>}
          <Button type="submit" className="w-full" busy={busy}>
            Unlock and set passphrase
          </Button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell
      title="Unlock vault"
      footer={
        <div className="flex justify-center gap-4">
          <button className="underline" onClick={() => setMode('recovery')}>
            Forgot passphrase?
          </button>
          <button className="underline" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => (e.preventDefault(), void run(() => unlock(pass)))}
      >
        <Field label="Master passphrase">
          <PassphraseInput
            value={pass}
            onChange={setPass}
            autoFocus
            autoComplete="current-password"
          />
        </Field>
        {err && <Alert tone="red">{err}</Alert>}
        <Button type="submit" className="w-full" busy={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------- import

export function ImportVaultFile({ onBack, onDone }: { onBack?: () => void; onDone?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!file) return setErr('Choose a .vault file');
    setErr('');
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await importVaultFile(bytes, useRecovery ? { recoveryKey: secret } : { passphrase: secret });
      onDone?.();
    } catch (e) {
      setErr(msg(e));
      setBusy(false);
    }
  };
  const body = (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <Field label="Vault file">
        <Input
          type="file"
          accept=".vault,application/octet-stream"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <Checkbox
        label="Use recovery key instead of passphrase"
        checked={useRecovery}
        onChange={(e) => setUseRecovery(e.target.checked)}
      />
      <Field label={useRecovery ? "That file's recovery key" : "That file's passphrase"}>
        <Input
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </Field>
      <Alert>
        The file is verified in your browser, then stored as the newest version on the server. You
        will unlock it next.
      </Alert>
      {err && <Alert tone="red">{err}</Alert>}
      <div className="flex gap-2">
        {onBack && (
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="submit" className="flex-1" busy={busy}>
          Verify and restore
        </Button>
      </div>
    </form>
  );
  return onDone ? body : <Shell title="Restore from backup file">{body}</Shell>;
}

export function FatalError({ error }: { error?: string }) {
  return (
    <Shell title="Something went wrong">
      <Alert tone="red">{error ?? 'Unknown error'}</Alert>
      <Button className="w-full" onClick={() => void refreshPhase()}>
        Retry
      </Button>
    </Shell>
  );
}
