# Artha security model

Implements plan §3. This document describes what is actually built.

## Keys

| Key | What it is | Where it lives |
|---|---|---|
| **DEK** (data encryption key) | Random 256-bit AES key made at vault creation. Encrypts the SQLite file | Only in browser memory while unlocked, as a non-extractable `CryptoKey` |
| **KEK** (key encryption key) | Argon2id(passphrase, 16-byte random salt, 64 MiB, 3 iterations, parallelism 1) → 256 bits. Wraps the DEK | Derived on unlock, then discarded |
| **Recovery key** | Random 256 bits shown once as 13 groups of base32 (`ABCD-EFGH-…`). Also wraps the DEK | Owner keeps it offline |
| **Secrets key** | HKDF-SHA256(DEK, salt = 32 zero bytes, info = `"artha-secrets"`). Second layer for sensitive fields | Browser memory while unlocked |

The server stores only the vault header: KDF parameters + salt, `wrapped_dek_pass`,
`wrapped_dek_recovery`, timestamps and versions. None of these are secret. The passphrase, KEK,
DEK and recovery key are never sent or stored.

Changing the passphrase re-wraps the DEK under a new salt; data is not re-encrypted and the
recovery key keeps working. A recovery-key unlock forces you to choose a new passphrase.

## Vault file format

```
"ARTHA1" | uint32 BE header length | header JSON | IV (12 bytes) | AES-256-GCM ciphertext + 16-byte tag
```

The header JSON bytes are the AES-GCM **additional authenticated data**, so changing any header
field (for example the KDF parameters) makes decryption fail. Wrapped keys are
`base64(IV || AES-GCM(key, DEK))`. A fresh random IV is used for every save and every field.

## Field-level secrets (second layer)

These columns are additionally encrypted with the secrets key (`s1:` + base64(IV || ct)):
`Persons.PAN_Enc`, `Persons.Aadhaar_Enc`, `Accounts.AccountNumber_Enc`,
`AccountCredentials.{LoginId,Password,MPIN,TxnPassword}_Enc`, `SecurityQuestions.Answer_Enc`.

UI rules (`src/components/SecretField.tsx`):

- Masked by default (`••••1234` for identifiers, `••••••••` for passwords).
- **Reveal** shows the plaintext for 30 s. **Copy** copies it and overwrites the clipboard after 30 s.
- Optional setting: re-enter the passphrase before reveal/copy (remembered for 2 minutes).
- Edit forms never pre-fill secrets; leaving a field blank keeps the saved value.
- Secrets are never logged (`no-console` lint rule) and never placed in URLs.

## Server access

- Login = Argon2 password hash (argon2-cffi defaults) + **mandatory TOTP** (±30 s window, replay
  of a used time-step rejected). Both factors are always checked; the error does not say which failed.
- First-run setup requires `ARTHA_SETUP_TOKEN`, and setup can only complete once.
- Session: random 256-bit token, stored hashed in memory; cookie is `HttpOnly; Secure;
  SameSite=Strict; Path=/api`, 12 h lifetime. Restarting the server ends all sessions.
- CSRF: every POST/PUT must carry `X-Artha-Request: 1` (a custom header cannot be sent cross-site
  without a CORS preflight, and no CORS is enabled), on top of `SameSite=Strict`.
- Rate limiting: 5 failed attempts per IP and 20 globally per 15 minutes → `429`. Host nginx adds
  `limit_req` on `/api/auth/`.
- `PUT /api/vault` requires `If-Match: <blob_version>`; a stale version returns `409`, and the
  browser asks you to reload. It never silently overwrites.

## Browser hardening

- Auto-lock after inactivity (default 5 min, configurable) and optionally when the tab is hidden.
  Locking tries to save first, then drops the DB, the keys and the session state.
- Strict CSP (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
  frame-ancestors 'none'`…), no third-party scripts, fonts or analytics. `'wasm-unsafe-eval'`
  is needed for sql.js and Argon2 WebAssembly.
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, HSTS (host nginx).
- `localStorage` holds only the theme preference.

## Known limitations (accepted for a single-user app)

- JavaScript cannot reliably zero memory. Raw key bytes are overwritten after import, but copies
  may remain in the JS heap until garbage collection. Locking drops all references.
- Whoever controls the server could serve modified JavaScript that captures your passphrase.
  That's inherent to any web-delivered E2EE app. Mitigations: your own server, HTTPS + HSTS, and
  keeping the EC2 instance patched.
- Clipboard clearing writes an empty string after 30 s. Clipboard managers may keep history.
- Old server versions and Drive backups stay decryptable with whatever passphrase was valid when
  they were saved, and always with the recovery key. If a passphrase leaks, change it **and**
  consider the old backups exposed to that passphrase.
- In-memory rate limiting resets on restart.
