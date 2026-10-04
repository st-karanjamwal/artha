import { describe, expect, it } from 'vitest';
import { fromBase32, toBase32, utf8 } from './bytes';
import { decryptSecretWith, encryptSecretWith } from './secrets';
import {
  WrongKeyError,
  createVault,
  openDatabase,
  rewrapPassphrase,
  sealDatabase,
  toSessionKeys,
  unwrapDekWithPassphrase,
  unwrapDekWithRecovery,
} from './vault';
import { decodeVault } from './vaultFormat';

// Low-cost KDF for fast tests; production uses DEFAULT_KDF (64 MB, 3 iterations).
const FAST = { mem: 1024, iter: 1, par: 1 };
const PASS = 'correct horse battery staple';
const DATA = utf8('SQLite format 3\0 pretend database bytes');

async function newVault() {
  return createVault(PASS, 1, FAST);
}

describe('vault crypto', () => {
  it('round-trips with passphrase', async () => {
    const v = await newVault();
    const { blob } = await sealDatabase(v.keys, v.header, DATA);
    const { header } = decodeVault(blob);
    const keys = await toSessionKeys(await unwrapDekWithPassphrase(header, PASS));
    expect(await openDatabase(keys, blob)).toEqual(DATA);
  });

  it('round-trips with recovery key (any case / separators)', async () => {
    const v = await newVault();
    const { blob } = await sealDatabase(v.keys, v.header, DATA);
    const sloppy = v.recoveryKey.toLowerCase().replace(/-/g, ' ');
    const keys = await toSessionKeys(await unwrapDekWithRecovery(decodeVault(blob).header, sloppy));
    expect(await openDatabase(keys, blob)).toEqual(DATA);
  });

  it('rejects a wrong passphrase', async () => {
    const v = await newVault();
    await expect(unwrapDekWithPassphrase(v.header, 'wrong passphrase!!')).rejects.toBeInstanceOf(
      WrongKeyError,
    );
  });

  it('detects tampering of ciphertext and header via GCM tag', async () => {
    const v = await newVault();
    const { blob } = await sealDatabase(v.keys, v.header, DATA);

    const flipped = blob.slice();
    flipped[flipped.length - 5] ^= 1;
    await expect(openDatabase(v.keys, flipped)).rejects.toThrow(/integrity/);

    // Change one character inside the header JSON (header is AAD).
    const s = new TextDecoder().decode(blob);
    const idx = s.indexOf('"schema_version":1');
    const hdrTampered = blob.slice();
    hdrTampered[idx + '"schema_version":'.length] = '2'.charCodeAt(0);
    await expect(openDatabase(v.keys, hdrTampered)).rejects.toThrow(/integrity/);
  });

  it('change passphrase re-wraps DEK only; old passphrase stops working', async () => {
    const v = await newVault();
    const dek = await unwrapDekWithPassphrase(v.header, PASS);
    const h2 = await rewrapPassphrase(v.header, dek, 'a brand new passphrase', FAST);
    expect(h2.wrapped_dek_recovery).toBe(v.header.wrapped_dek_recovery);
    const { blob } = await sealDatabase(v.keys, h2, DATA);
    const hdr = decodeVault(blob).header;
    await expect(unwrapDekWithPassphrase(hdr, PASS)).rejects.toBeInstanceOf(WrongKeyError);
    const keys = await toSessionKeys(await unwrapDekWithPassphrase(hdr, 'a brand new passphrase'));
    expect(await openDatabase(keys, blob)).toEqual(DATA);
  });

  it('blob contains no plaintext', async () => {
    const v = await newVault();
    const { blob } = await sealDatabase(v.keys, v.header, DATA);
    expect(new TextDecoder().decode(blob)).not.toContain('SQLite format');
  });
});

describe('secrets', () => {
  it('field encryption round-trip, unique IVs', async () => {
    const v = await newVault();
    const a = await encryptSecretWith(v.keys.secretsKey, 'MPIN-1234');
    const b = await encryptSecretWith(v.keys.secretsKey, 'MPIN-1234');
    expect(a).not.toBe(b);
    expect(a.startsWith('s1:')).toBe(true);
    expect(await decryptSecretWith(v.keys.secretsKey, a)).toBe('MPIN-1234');
  });

  it('secrets key differs from data key', async () => {
    const v = await newVault();
    const s = await encryptSecretWith(v.keys.secretsKey, 'x');
    await expect(decryptSecretWith(v.keys.dataKey, s)).rejects.toThrow();
  });
});

describe('base32', () => {
  it('round-trips', () => {
    const b = crypto.getRandomValues(new Uint8Array(32));
    expect(fromBase32(toBase32(b))).toEqual(b);
  });
});
