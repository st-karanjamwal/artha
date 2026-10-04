import { useEffect, useRef, useState } from 'react';
import { decryptSecret } from '@/crypto/secrets';
import { getAppSettings } from '@/repositories/settings';
import { createStore, useStore } from '@/lib/store';
import { verifyPassphrase } from '@/app/session';
import { Button, Field, Input, Modal } from './ui';
import { toast, toastError } from './toast';

const REVEAL_MS = 30_000;
const CLIPBOARD_CLEAR_MS = 30_000;
const REVERIFY_MS = 2 * 60_000;

// ---------------------------------------------------------------- optional passphrase gate

const gate = createStore<{ open: boolean; resolve?: (ok: boolean) => void }>({ open: false });
let verifiedAt = 0;

async function ensureAllowed(): Promise<boolean> {
  if (!getAppSettings().revealRequiresPassphrase) return true;
  if (Date.now() - verifiedAt < REVERIFY_MS) return true;
  return new Promise((resolve) => gate.set({ open: true, resolve }));
}

export function PassphraseGate() {
  const g = useStore(gate);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const close = (ok: boolean) => {
    g.resolve?.(ok);
    gate.set({ open: false });
    setPass('');
    setErr('');
  };
  const submit = async () => {
    setBusy(true);
    const ok = await verifyPassphrase(pass);
    setBusy(false);
    if (ok) {
      verifiedAt = Date.now();
      close(true);
    } else setErr('Wrong passphrase');
  };
  return (
    <Modal
      open={g.open}
      onClose={() => close(false)}
      title="Confirm passphrase"
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button busy={busy} onClick={submit}>
            Confirm
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Vault passphrase" error={err}>
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- field

export async function copySecret(stored: string) {
  if (!(await ensureAllowed())) return;
  try {
    const plain = await decryptSecret(stored);
    await navigator.clipboard.writeText(plain);
    toast('Copied. Clipboard clears in 30 s.');
    setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {});
    }, CLIPBOARD_CLEAR_MS);
  } catch (e) {
    toastError(e);
  }
}

/**
 * Displays an encrypted value masked (••••1234 or ••••••••). "Reveal" shows the plaintext
 * for 30 seconds; "Copy" copies it and clears the clipboard after 30 seconds.
 */
export function SecretField({
  value,
  showLast4 = false,
  format,
}: {
  value: string | null | undefined;
  showLast4?: boolean;
  format?: (plain: string) => string;
}) {
  const [plain, setPlain] = useState<string | null>(null);
  const [last4, setLast4] = useState<string>('');
  const [left, setLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    setLast4('');
    if (value && showLast4) {
      decryptSecret(value)
        .then((p) => alive && setLast4(p.slice(-4)))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [value, showLast4]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  if (!value) return <span className="text-sm text-slate-400">—</span>;

  const hide = () => {
    setPlain(null);
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const reveal = async () => {
    if (plain) return hide();
    if (!(await ensureAllowed())) return;
    try {
      setPlain(await decryptSecret(value));
      const until = Date.now() + REVEAL_MS;
      setLeft(REVEAL_MS / 1000);
      timer.current = setInterval(() => {
        const s = Math.ceil((until - Date.now()) / 1000);
        if (s <= 0) hide();
        else setLeft(s);
      }, 500);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm select-all" data-secret>
        {plain ? (format ? format(plain) : plain) : `••••${showLast4 ? last4 : '••••'}`}
      </span>
      <Button size="sm" variant="ghost" onClick={reveal} aria-label={plain ? 'Hide' : 'Reveal'}>
        {plain ? `Hide (${left}s)` : 'Reveal'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => copySecret(value)}>
        Copy
      </Button>
    </span>
  );
}
