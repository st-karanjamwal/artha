import { concat, fromBase64, randomBytes, toBase64, type Bytes } from './bytes';

export const IV_LEN = 12;

export async function aesEncrypt(key: CryptoKey, plaintext: Bytes, aad?: Bytes) {
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv },
      key,
      plaintext,
    ),
  );
  return { iv, ct };
}

/** Throws (OperationError) if the key is wrong or data/aad were tampered with. */
export async function aesDecrypt(
  key: CryptoKey,
  iv: Bytes,
  ct: Bytes,
  aad?: Bytes,
): Promise<Bytes> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv },
      key,
      ct,
    ),
  );
}

/** Encrypt and pack as base64(iv || ciphertext+tag). */
export async function sealB64(key: CryptoKey, plaintext: Bytes): Promise<string> {
  const { iv, ct } = await aesEncrypt(key, plaintext);
  return toBase64(concat(iv, ct));
}

export async function openB64(key: CryptoKey, packed: string): Promise<Bytes> {
  const b = fromBase64(packed);
  return aesDecrypt(key, b.slice(0, IV_LEN), b.slice(IV_LEN));
}
