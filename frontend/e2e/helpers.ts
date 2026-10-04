import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

export const SETUP_TOKEN = 'e2e-setup-token';
export const LOGIN_PW = 'server login password 1';
export const PASSPHRASE = 'orchid Tractor 47 lantern ripple!';

function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '')) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, stepOffset = 0): string {
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export async function fillByLabel(page: Page, label: string, value: string) {
  await page.getByLabel(label, { exact: true }).fill(value);
}

/** Completes first-run server setup and vault creation. Returns the recovery key. */
export async function setupServerAndVault(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'First-time server setup' })).toBeVisible();
  await fillByLabel(page, 'Setup token', SETUP_TOKEN);
  await page.locator('input[type=password]').nth(1).fill(LOGIN_PW);
  await fillByLabel(page, 'Confirm login password', LOGIN_PW);
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.locator('p.font-mono').textContent())!.trim();
  await fillByLabel(page, '6-digit code from the app', totp(secret));
  await page.getByRole('button', { name: 'Verify and finish' }).click();

  // --- create vault
  await expect(page.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
  await page.locator('input[type=password]').first().fill(PASSPHRASE);
  await fillByLabel(page, 'Confirm passphrase', PASSPHRASE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery key' })).toBeVisible({
    timeout: 30_000,
  });
  const recoveryKey = (await page.locator('div.font-mono').textContent())!.trim();
  expect(recoveryKey.split('-')).toHaveLength(13);
  await page.getByLabel('I have saved the recovery key somewhere safe').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const groups = recoveryKey.split('-');
  for (const label of await page.locator('label span:has-text("Group #")').allTextContents()) {
    const n = Number(label.replace(/\D/g, ''));
    await page.getByLabel(label.trim(), { exact: true }).fill(groups[n - 1]);
  }
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  return recoveryKey;
}
