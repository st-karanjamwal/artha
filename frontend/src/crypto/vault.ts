import { aesDecrypt, aesEncrypt, openB64, sealB64 } from './aes';
import { fromBase32, randomBytes, toBase32, utf8, type Bytes } from './bytes';
import { DEFAULT_KDF, deriveKek, newKdfParams } from './kdf';
import { decodeVault, encodeHeader, encodeVault, type VaultHeader } from './vaultFormat';

/** Keys held in memory while the vault is unlocked. Both are non-extractable. */
export interface SessionKeys {
  dataKey: CryptoKey;
  secretsKey: CryptoKey;
}

export class WrongKeyError extends Error {
  constructor(msg = 'Wrong passphrase or recovery key') {
    super(msg);
    this.name = 'WrongKeyError';
  }
}

type Cost = { mem: number; iter: number; par: number };

// ---------------------------------------------------------------- recovery key

export function formatRecoveryKey(raw: Uint8Array): string {
  return (toBase32(raw).match(/.{1,4}/g) ?? []).join('-');
}

export function parseRecoveryKey(s: string): Bytes {
  const raw = fromBase32(s);
  if (raw.length !== 32) throw new WrongKeyError('Recovery key is malformed');
  return raw;
}

async function recoveryKek(recoveryKey: string): Promise<CryptoKey> {
  const raw = parseRecoveryKey(recoveryKey);
  try {
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

// ---------------------------------------------------------------- DEK handling

async function sessionKeysFromRaw(dek: Bytes): Promise<SessionKeys> {
  const dataKey = await crypto.subtle.importKey('raw', dek, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const hkdfBase = await crypto.subtle.importKey('raw', dek, 'HKDF', false, ['deriveKey']);
  const secretsKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8('artha-secrets') },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { dataKey, secretsKey };
}

async function unwrap(kek: CryptoKey, wrapped: string): Promise<Bytes> {
  try {
    return await openB64(kek, wrapped);
  } catch {
    throw new WrongKeyError();
  }
}

export async function unwrapDekWithPassphrase(h: VaultHeader, passphrase: string): Promise<Bytes> {
  return unwrap(await deriveKek(passphrase, h.kdf), h.wrapped_dek_pass);
}

export async function unwrapDekWithRecovery(h: VaultHeader, recoveryKey: string): Promise<Bytes> {
  return unwrap(await recoveryKek(recoveryKey), h.wrapped_dek_recovery);
}

/** Turn a raw DEK into session keys and wipe the raw bytes. */
export async function toSessionKeys(dek: Bytes): Promise<SessionKeys> {
  try {
    return await sessionKeysFromRaw(dek);
  } finally {
    dek.fill(0);
  }
}

// ---------------------------------------------------------------- lifecycle

export interface NewVault {
  header: VaultHeader;
  keys: SessionKeys;
  recoveryKey: string;
}

export async function createVault(
  passphrase: string,
  schemaVersion: number,
  cost: Cost = DEFAULT_KDF,
): Promise<NewVault> {
  const dek = randomBytes(32);
  const recoveryRaw = randomBytes(32);
  const recoveryKey = formatRecoveryKey(recoveryRaw);
  recoveryRaw.fill(0);
  const kdf = newKdfParams(cost);
  const now = new Date().toISOString();
  const header: VaultHeader = {
    version: 1,
    kdf,
    wrapped_dek_pass: await sealB64(await deriveKek(passphrase, kdf), dek),
    wrapped_dek_recovery: await sealB64(await recoveryKek(recoveryKey), dek),
    created_on: now,
    updated_on: now,
    schema_version: schemaVersion,
    blob_version: 0,
  };
  const keys = await toSessionKeys(dek);
  return { header, keys, recoveryKey };
}

/** Re-wrap the DEK under a new passphrase (fresh salt). Data is not re-encrypted. */
export async function rewrapPassphrase(
  h: VaultHeader,
  dek: Bytes,
  newPassphrase: string,
  cost: Cost = { mem: h.kdf.mem, iter: h.kdf.iter, par: h.kdf.par },
): Promise<VaultHeader> {
  try {
    const kdf = newKdfParams(cost);
    return {
      ...h,
      kdf,
      wrapped_dek_pass: await sealB64(await deriveKek(newPassphrase, kdf), dek),
    };
  } finally {
    dek.fill(0);
  }
}

export async function sealDatabase(
  keys: SessionKeys,
  h: VaultHeader,
  dbBytes: Uint8Array,
): Promise<{ blob: Bytes; header: VaultHeader }> {
  const header = { ...h, updated_on: new Date().toISOString() };
  const headerBytes = encodeHeader(header);
  const { iv, ct } = await aesEncrypt(keys.dataKey, dbBytes as Bytes, headerBytes);
  return { blob: encodeVault(headerBytes, iv, ct), header };
}

export async function openDatabase(keys: SessionKeys, blob: Uint8Array): Promise<Bytes> {
  const { headerBytes, iv, ct } = decodeVault(blob);
  try {
    return await aesDecrypt(keys.dataKey, iv, ct, headerBytes);
  } catch {
    throw new Error('Vault data failed integrity check (tampered or wrong key)');
  }
}
