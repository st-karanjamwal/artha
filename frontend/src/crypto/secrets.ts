import { openB64, sealB64 } from './aes';
import { fromUtf8, utf8 } from './bytes';

/**
 * Field-level encryption for sensitive values (plan §3.3), using a key derived from the DEK
 * with HKDF(info="artha-secrets"). Stored as "s1:" + base64(iv || ct).
 * Never log plaintext or ciphertext from this module.
 */
const PREFIX = 's1:';

let activeKey: CryptoKey | null = null;

export function setSecretsKey(key: CryptoKey | null) {
  activeKey = key;
}

function key(): CryptoKey {
  if (!activeKey) throw new Error('Vault is locked');
  return activeKey;
}

export async function encryptSecretWith(k: CryptoKey, plaintext: string): Promise<string> {
  return PREFIX + (await sealB64(k, utf8(plaintext)));
}

export async function decryptSecretWith(k: CryptoKey, stored: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) throw new Error('Unknown secret format');
  return fromUtf8(await openB64(k, stored.slice(PREFIX.length)));
}

export const encryptSecret = (plaintext: string) => encryptSecretWith(key(), plaintext);
export const decryptSecret = (stored: string) => decryptSecretWith(key(), stored);

/** Encrypt only when a non-empty value is given. */
export async function encryptOptional(v: string | null | undefined): Promise<string | null> {
  const t = v?.trim();
  return t ? encryptSecret(t) : null;
}
