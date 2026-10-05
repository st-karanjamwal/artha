import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { isDirty, saveNow, saveStatus } from '@/db/save';
import { getAppSettings } from '@/repositories/settings';
import { Alert, Button, Field, Input, Modal, cx } from '@/components/ui';
import { PassphraseGate } from '@/components/SecretField';
import { toastError } from '@/components/toast';
import { lock, reloadLatest, useDb } from './session';
import { useTheme, type Theme } from './theme';
import { autoResumeExpiredPauses } from '@/repositories/sips';
import { navRefreshDue, refreshNavs } from '@/features/mf/navService';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧' },
  { to: '/family', label: 'Family', icon: '☺' },
  { to: '/banks', label: 'Banks', icon: '⌂' },
  { to: '/accounts', label: 'Accounts', icon: '▤' },
  { to: '/transactions', label: 'Transactions', icon: '⇄' },
  { to: '/import', label: 'Import statement', icon: '⇪' },
  { to: '/mf', label: 'Mutual funds', icon: '◔' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

function useAutoLock() {
  const settings = useDb(getAppSettings);
  useEffect(() => {
    if (!settings) return;
    const ms = settings.autoLockMinutes * 60_000;
    let timer = setTimeout(() => void lock({ force: true }), ms);
    let last = Date.now();
    const reset = () => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      clearTimeout(timer);
      timer = setTimeout(() => void lock({ force: true }), ms);
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden' && settings.lockOnHide) void lock({ force: true });
    };
    const events = [
      'pointerdown',
      'pointermove',
      'keydown',
      'wheel',
      'touchstart',
      'scroll',
    ] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [settings]);

  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (isDirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);
}

function SaveIndicator() {
  const s = useStore(saveStatus);
  const map: Record<string, [string, string]> = {
    saved: ['Saved', 'bg-emerald-500'],
    unsaved: ['Unsaved', 'bg-amber-500'],
    saving: ['Saving…', 'bg-sky-500 animate-pulse'],
    error: ['Save failed', 'bg-red-500'],
    conflict: ['Conflict', 'bg-red-500'],
    auth: ['Not saving', 'bg-red-500'],
  };
  const [label, dot] = map[s.state];
  return (
    <button
      onClick={() => s.state !== 'conflict' && void saveNow().catch(() => {})}
      title={
        s.message ??
        (s.lastSaved ? `Last saved ${formatDateTime(s.lastSaved)}` : 'Click to save now')
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <span className={cx('size-2 rounded-full', dot)} />
      {label}
    </button>
  );
}

function ReLogin({ open, onDone }: { open: boolean; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.login(pw, code);
      setPw('');
      setCode('');
      onDone();
      await saveNow();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onDone}
      title="Sign in to keep saving"
      footer={
        <Button busy={busy} onClick={submit}>
          Sign in and save
        </Button>
      }
    >
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <p className="text-sm text-slate-500">
          Your server session expired. Your vault stays unlocked; sign in to resume saving.
        </p>
        <Field label="Login password">
          <Input
            type="password"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
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
      </form>
    </Modal>
  );
}

function SaveProblems() {
  const s = useStore(saveStatus);
  const [relogin, setRelogin] = useState(false);
  const [busy, setBusy] = useState(false);
  if (s.state === 'conflict') {
    return (
      <Modal open onClose={() => {}} title="Vault changed on another device">
        <p className="text-sm text-slate-600 dark:text-slate-300">{s.message}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Your most recent unsaved edit on this device will be discarded.
        </p>
        <div className="mt-4 flex justify-end">
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await reloadLatest();
              } catch (e) {
                toastError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Reload latest
          </Button>
        </div>
      </Modal>
    );
  }
  if (s.state === 'auth' || s.state === 'error') {
    return (
      <div className="mb-4">
        <Alert tone="red">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{s.message}</span>
            {s.state === 'auth' ? (
              <Button size="sm" onClick={() => setRelogin(true)}>
                Sign in
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void saveNow().catch(() => {})}>
                Retry
              </Button>
            )}
          </div>
        </Alert>
        <ReLogin open={relogin} onDone={() => setRelogin(false)} />
      </div>
    );
  }
  return null;
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const icon: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };
  return (
    <button
      onClick={() => setTheme(next[theme])}
      title={`Theme: ${theme}`}
      aria-label={`Theme: ${theme}`}
      className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {icon[theme]}
    </button>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
              isActive
                ? 'bg-brand-50 text-brand-800 dark:bg-brand-800/30 dark:text-brand-100'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
            )
          }
        >
          <span aria-hidden className="w-4 text-center">
            {n.icon}
          </span>
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-8 items-center justify-center rounded-lg bg-brand-700 font-bold text-white">
        ₹
      </div>
      <span className="text-lg font-semibold tracking-tight">Artha</span>
    </div>
  );
}

/** Once per unlock: resume SIPs whose pause ended, and refresh NAVs if a day has passed. */
function useUnlockTasks() {
  useEffect(() => {
    try {
      autoResumeExpiredPauses();
      if (navRefreshDue()) void refreshNavs().catch(() => {});
    } catch {
      /* non-critical */
    }
  }, []);
}

export function Layout(): ReactNode {
  useAutoLock();
  useUnlockTasks();
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);

  const doLock = async () => {
    const ok = await lock();
    if (!ok && confirm('Saving failed. Lock anyway and lose unsaved changes?'))
      await lock({ force: true });
  };

  return (
    <div className="min-h-dvh md:flex">
      <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6 px-2">
          <Brand />
        </div>
        <NavItems />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white p-4 shadow-xl dark:bg-slate-900">
            <div className="mb-6 px-2">
              <Brand />
            </div>
            <NavItems onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <header className="no-print sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <button
            className="rounded-lg p-2 text-xl leading-none md:hidden"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
          >
            ☰
          </button>
          <div className="md:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <SaveIndicator />
            <ThemeToggle />
            <Button size="sm" variant="secondary" onClick={doLock}>
              Lock
            </Button>
          </div>
        </header>
        <main className="mx-auto max-w-6xl p-4 sm:p-6">
          <SaveProblems />
          <Outlet />
        </main>
      </div>
      <PassphraseGate />
    </div>
  );
}
