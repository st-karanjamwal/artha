import { useEffect } from 'react';
import { createStore, useStore } from '@/lib/store';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'artha.theme';

function initial(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

const themeStore = createStore<Theme>(initial());

export function applyTheme(t: Theme = themeStore.get()) {
  const dark =
    t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const t = useStore(themeStore);
  useEffect(() => {
    applyTheme(t);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => applyTheme(t);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [t]);
  return [
    t,
    (next) => {
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* ignore */
      }
      themeStore.set(next);
    },
  ];
}
