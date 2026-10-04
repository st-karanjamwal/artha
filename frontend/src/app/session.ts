import type { Database } from 'sql.js';
import { useMemo } from 'react';
import { ApiError, api } from '@/lib/api';
import { createStore, useStore } from '@/lib/store';
import { openDb, exportDb } from '@/db/database';
import { LATEST_SCHEMA_VERSION, migrate } from '@/db/migrate';
import { onDbChange, setDb } from '@/db/sql';
import {
  attachSaveTarget,
  flush,
  getSaveTarget,
  isDirty,
  markDirty,
  saveNow,
  saveStatus,
  updateHeader,
} from '@/db/save';
import { setSecretsKey } from '@/crypto/secrets';
import {
  createVault as cryptoCreateVault,
  openDatabase,
  rewrapPassphrase,
  sealDatabase,
  toSessionKeys,
  unwrapDekWithPassphrase,
  unwrapDekWithRecovery,
  type SessionKeys,
} from '@/crypto/vault';
import { decodeVault, type VaultHeader } from '@/crypto/vaultFormat';

export type Phase =
  'loading' | 'server-setup' | 'login' | 'create-vault' | 'locked' | 'unlocked' | 'error';

export const appState = createStore<{ phase: Phase; error?: string }>({ phase: 'loading' });
/** Bumped on every DB change so views re-query. */
export const dbVersion = createStore(0);

let unsubscribe: (() => void) | null = null;
let currentDb: Database | null = null;

// ---------------------------------------------------------------- phase routing

export async function refreshPhase() {
  try {
    const s = await api.authStatus();
    if (!s.setup_complete) return appState.set({ phase: 'server-setup' });
    if (!s.authenticated) return appState.set({ phase: 'login' });
    if (appState.get().phase === 'unlocked') return;
    const meta = await api.vaultMeta();
    appState.set({ phase: meta.exists ? 'locked' : 'create-vault' });
  } catch (e) {
    appState.set({ phase: 'error', error: (e as Error).message });
  }
}

// ---------------------------------------------------------------- session lifecycle

function startSession(db: Database, keys: SessionKeys, header: VaultHeader, blobVersion: number) {
  currentDb = db;
  setDb(db);
  setSecretsKey(keys.secretsKey);
  attachSaveTarget({ db, keys, header, blobVersion });
  unsubscribe?.();
  unsubscribe = onDbChange(() => {
    markDirty();
    dbVersion.set((v) => v + 1);
  });
  dbVersion.set((v) => v + 1);
  appState.set({ phase: 'unlocked' });
}

function wipe() {
  unsubscribe?.();
  unsubscribe = null;
  setDb(null);
  setSecretsKey(null);
  attachSaveTarget(null);
  try {
    currentDb?.close();
  } catch {
    /* already closed */
  }
  currentDb = null;
  pendingVault = null;
  dbVersion.set((v) => v + 1);
}

async function loadSession(keys: SessionKeys, blob: Uint8Array, version: number) {
  const dbBytes = await openDatabase(keys, blob);
  const db = await openDb(dbBytes);
  dbBytes.fill(0);
  const applied = migrate(db);
  const { header } = decodeVault(blob);
  startSession(db, keys, { ...header, schema_version: LATEST_SCHEMA_VERSION }, version);
  if (applied.length) {
    markDirty();
    await saveNow();
  }
}

// ---------------------------------------------------------------- create

let pendingVault: { db: Database; keys: SessionKeys; header: VaultHeader } | null = null;

/** Step 1 of the wizard: generate keys and an empty DB in memory. Nothing is uploaded yet. */
export async function prepareNewVault(passphrase: string): Promise<string> {
  const v = await cryptoCreateVault(passphrase, LATEST_SCHEMA_VERSION);
  const db = await openDb();
  migrate(db);
  pendingVault = { db, keys: v.keys, header: v.header };
  return v.recoveryKey;
}

/** Final step: upload the first encrypted blob and open the session. */
export async function finalizeNewVault() {
  if (!pendingVault) throw new Error('Start again: no vault prepared');
  const { db, keys, header } = pendingVault;
  const { blob, header: h } = await sealDatabase(
    keys,
    { ...header, blob_version: 1 },
    exportDb(db),
  );
  const meta = await api.putVault(blob, 0);
  pendingVault = null;
  startSession(db, keys, h, meta.blob_version);
}

// ---------------------------------------------------------------- unlock

export async function unlock(passphrase: string) {
  const { bytes, version } = await api.getVault();
  const dek = await unwrapDekWithPassphrase(decodeVault(bytes).header, passphrase);
  await loadSession(await toSessionKeys(dek), bytes, version);
}

/** Recovery: unlock with the recovery key and immediately set a new passphrase. */
export async function unlockWithRecovery(recoveryKey: string, newPassphrase: string) {
  const { bytes, version } = await api.getVault();
  const header = decodeVault(bytes).header;
  const dek = await unwrapDekWithRecovery(header, recoveryKey);
  const dekCopy = dek.slice();
  const newHeader = await rewrapPassphrase(header, dekCopy, newPassphrase);
  await loadSession(await toSessionKeys(dek), bytes, version);
  updateHeader({ ...newHeader, schema_version: LATEST_SCHEMA_VERSION });
  markDirty();
  await saveNow();
}

export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  const t = getSaveTarget();
  if (!t) return false;
  try {
    const dek = await unwrapDekWithPassphrase(t.header, passphrase);
    dek.fill(0);
    return true;
  } catch {
    return false;
  }
}

export async function changePassphrase(current: string, next: string) {
  const t = getSaveTarget();
  if (!t) throw new Error('Vault is locked');
  const dek = await unwrapDekWithPassphrase(t.header, current);
  updateHeader(await rewrapPassphrase(t.header, dek, next));
  markDirty();
  await saveNow();
}

// ---------------------------------------------------------------- lock / reload

/**
 * Save pending changes then wipe keys and the in-memory DB.
 * With `force`, wipes even if saving fails (auto-lock). Returns false if not locked.
 */
export async function lock(opts: { force?: boolean } = {}): Promise<boolean> {
  if (appState.get().phase !== 'unlocked') return true;
  if (isDirty() && saveStatus.get().state !== 'conflict') {
    try {
      await flush();
    } catch {
      if (!opts.force) return false;
    }
  }
  wipe();
  appState.set({ phase: 'locked' });
  return true;
}

/** After a 409 conflict: discard local state and load the latest blob with the in-memory key. */
export async function reloadLatest() {
  const t = getSaveTarget();
  if (!t) return;
  const keys = t.keys;
  const { bytes, version } = await api.getVault();
  wipe();
  try {
    await loadSession(keys, bytes, version);
  } catch (e) {
    // e.g. passphrase changed elsewhere does not affect the DEK, but a restored older vault might.
    appState.set({ phase: 'locked', error: (e as Error).message });
  }
}

export async function logout() {
  await lock({ force: true });
  await api.logout().catch(() => {});
  appState.set({ phase: 'login' });
}

// ---------------------------------------------------------------- export / import

export async function exportEncrypted(): Promise<Blob> {
  const t = getSaveTarget();
  if (!t) throw new Error('Vault is locked');
  const { blob } = await sealDatabase(t.keys, t.header, exportDb(t.db));
  return new Blob([blob], { type: 'application/octet-stream' });
}

/**
 * Validate a .vault file by decrypting it, then upload it as the newest server version.
 * The app then locks so the owner unlocks with that file's passphrase.
 */
export async function importVaultFile(
  bytes: Uint8Array,
  secret: { passphrase?: string; recoveryKey?: string },
) {
  const header = decodeVault(bytes).header;
  const dek = secret.recoveryKey
    ? await unwrapDekWithRecovery(header, secret.recoveryKey)
    : await unwrapDekWithPassphrase(header, secret.passphrase ?? '');
  const keys = await toSessionKeys(dek);
  const db = await openDatabase(keys, bytes); // integrity check
  db.fill(0);
  const meta = await api.vaultMeta();
  await api.putVault(bytes, meta.blob_version);
  wipe();
  appState.set({ phase: 'locked' });
}

export async function restoreServerVersion(version: number) {
  await api.restoreVersion(version);
  wipe();
  appState.set({ phase: 'locked' });
}

// ---------------------------------------------------------------- hooks

/** Re-run a synchronous DB query whenever data changes. */
export function useDb<T>(fn: () => T, deps: unknown[] = []): T {
  const v = useStore(dbVersion);
  return useMemo(
    () => (appState.get().phase === 'unlocked' ? fn() : (undefined as T)),
    // `fn` is re-created every render; callers list its inputs in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v, ...deps],
  );
}

export function isAuthError(e: unknown) {
  return e instanceof ApiError && e.status === 401;
}
