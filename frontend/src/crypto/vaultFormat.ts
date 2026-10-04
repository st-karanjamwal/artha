import { concat, fromUtf8, utf8, type Bytes } from './bytes';
import { IV_LEN } from './aes';
import type { KdfParams } from './kdf';

/**
 * ARTHA1 | header JSON length (uint32 BE) | header JSON | IV (12) | AES-GCM ciphertext+tag
 * The header bytes are bound to the ciphertext as AES-GCM additional data.
 */
export const MAGIC = 'ARTHA1';
const MAGIC_BYTES = utf8(MAGIC);

export interface VaultHeader {
  version: 1;
  kdf: KdfParams;
  wrapped_dek_pass: string;
  wrapped_dek_recovery: string;
  created_on: string;
  updated_on: string;
  schema_version: number;
  blob_version: number;
}

export interface DecodedVault {
  header: VaultHeader;
  headerBytes: Bytes;
  iv: Bytes;
  ct: Bytes;
}

export function encodeHeader(h: VaultHeader): Bytes {
  return utf8(JSON.stringify(h));
}

export function encodeVault(headerBytes: Bytes, iv: Bytes, ct: Bytes): Bytes {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, headerBytes.length, false);
  return concat(MAGIC_BYTES, len, headerBytes, iv, ct);
}

export function decodeVault(blob: Uint8Array): DecodedVault {
  const b = blob as Bytes;
  if (b.length < MAGIC_BYTES.length + 4 || fromUtf8(b.subarray(0, MAGIC_BYTES.length)) !== MAGIC) {
    throw new Error('Not an Artha vault file');
  }
  let o = MAGIC_BYTES.length;
  const hlen = new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, false);
  o += 4;
  if (o + hlen + IV_LEN > b.length) throw new Error('Corrupt vault file');
  const headerBytes = b.slice(o, o + hlen);
  o += hlen;
  const header = JSON.parse(fromUtf8(headerBytes)) as VaultHeader;
  if (header.version !== 1) throw new Error(`Unsupported vault version ${header.version}`);
  const iv = b.slice(o, o + IV_LEN);
  const ct = b.slice(o + IV_LEN);
  return { header, headerBytes, iv, ct };
}
