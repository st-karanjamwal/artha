import { createStore, useStore } from '@/lib/store';
import { cx } from './ui';

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error';
}

const toasts = createStore<Toast[]>([]);
let nextId = 1;

export function toast(message: string, tone: Toast['tone'] = 'ok') {
  const id = nextId++;
  toasts.set((t) => [...t, { id, message, tone }].slice(-3));
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3000);
}

export const toastError = (e: unknown) =>
  toast(e instanceof Error ? e.message : String(e), 'error');

export function Toaster() {
  const list = useStore(toasts);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {list.map((t) => (
        <div
          key={t.id}
          className={cx(
            'pointer-events-auto max-w-md rounded-lg px-4 py-2 text-sm text-white shadow-lg',
            t.tone === 'error' ? 'bg-red-600' : 'bg-slate-800 dark:bg-slate-700',
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
