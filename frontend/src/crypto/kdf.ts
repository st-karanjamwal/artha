import { argon2id } from 'hash-wasm';
import { fromBase64, randomBytes, toBase64, type Bytes } from './bytes';

export interface KdfParams {
  algo: 'argon2id';
  salt: string; // base64, 16 bytes
  mem: number; // KiB
  iter: number;
  par: number;
}

/** Plan §3.1: memory ≥ 64 MB, iterations ≥ 3, parallelism 1. */
export const DEFAULT_KDF = { mem: 65536, iter: 3, par: 1 } as const;

export function newKdfParams(
  cost: { mem: number; iter: number; par: number } = DEFAULT_KDF,
): KdfParams {
  return { algo: 'argon2id', salt: toBase64(randomBytes(16)), ...cost };
}

/** Derive the Key Encryption Key from the master passphrase. */
export async function deriveKek(passphrase: string, p: KdfParams): Promise<CryptoKey> {
  if (p.algo !== 'argon2id') throw new Error('Unsupported KDF');
  const raw = (await argon2id({
    password: passphrase.normalize('NFKC'),
    salt: fromBase64(p.salt),
    parallelism: p.par,
    iterations: p.iter,
    memorySize: p.mem,
    hashLength: 32,
    outputType: 'binary',
  })) as Bytes;
  try {
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}
