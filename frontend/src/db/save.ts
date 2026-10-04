import { ApiError, api } from '@/lib/api';
import { createStore } from '@/lib/store';
import { sealDatabase, type SessionKeys } from '@/crypto/vault';
import type { VaultHeader } from '@/crypto/vaultFormat';
import type { Database } from 'sql.js';
import { exportDb } from './database';

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict' | 'auth';

export const saveStatus = createStore<{ state: SaveState; message?: string; lastSaved?: string }>({
  state: 'saved',
});

const DEBOUNCE_MS = 3000;

interface SaveTarget {
  db: Database;
  keys: SessionKeys;
  header: VaultHeader;
  blobVersion: number;
}

let target: SaveTarget | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let dirtyGen = 0;
let savedGen = 0;

export function attachSaveTarget(t: SaveTarget | null) {
  target = t;
  if (timer) clearTimeout(timer);
  timer = null;
  dirtyGen = savedGen = 0;
  saveStatus.set({ state: 'saved' });
}

export function getSaveTarget() {
  return target;
}

export function updateHeader(h: VaultHeader) {
  if (target) target.header = h;
}

export const isDirty = () => dirtyGen !== savedGen;

/** Called on every DB change: mark unsaved and debounce an autosave. */
export function markDirty() {
  dirtyGen++;
  const s = saveStatus.get().state;
  if (s === 'conflict') return; // never overwrite after a conflict
  if (s !== 'saving') saveStatus.set((p) => ({ ...p, state: s === 'auth' ? 'auth' : 'unsaved' }));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveNow().catch(() => {}), DEBOUNCE_MS);
}

/** Encrypt the whole DB and PUT it with If-Match. */
export async function saveNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (inFlight) {
    await inFlight.catch(() => {});
    if (!isDirty()) return;
  }
  if (!target || saveStatus.get().state === 'conflict') return;
  const t = target;
  const gen = dirtyGen;
  saveStatus.set((p) => ({ ...p, state: 'saving', message: undefined }));
  inFlight = (async () => {
    try {
      const { blob, header } = await sealDatabase(
        t.keys,
        { ...t.header, blob_version: t.blobVersion + 1 },
        exportDb(t.db),
      );
      const meta = await api.putVault(blob, t.blobVersion);
      if (target !== t) return; // locked meanwhile
      t.blobVersion = meta.blob_version;
      t.header = header;
      savedGen = gen;
      saveStatus.set({
        state: isDirty() ? 'unsaved' : 'saved',
        lastSaved: new Date().toISOString(),
      });
      if (isDirty()) markDirty();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        saveStatus.set({
          state: 'conflict',
          message:
            'The vault was changed on another device. Reload the latest version and redo your last edit.',
        });
      } else if (e instanceof ApiError && e.status === 401) {
        saveStatus.set({
          state: 'auth',
          message: 'Server session expired. Log in again to keep saving.',
        });
      } else {
        saveStatus.set({ state: 'error', message: (e as Error).message });
        // Retry later on transient errors.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void saveNow().catch(() => {}), 15000);
      }
      throw e;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Save if there are pending changes; resolves when done (or throws). */
export async function flush(): Promise<void> {
  if (inFlight) await inFlight.catch(() => {});
  if (isDirty()) await saveNow();
}
