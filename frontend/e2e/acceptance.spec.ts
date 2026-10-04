import { expect, test } from '@playwright/test';
import { PASSPHRASE, fillByLabel, setupServerAndVault } from './helpers';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('phase 0/1 acceptance: setup, create vault, add data, relock, unlock, no plaintext on server', async ({
  page,
}) => {
  const cspViolations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text());
  });
  const recoveryKey = await setupServerAndVault(page);

  // --- family
  await page.getByRole('link', { name: 'Family' }).first().click();
  await page.getByRole('button', { name: 'Add yourself first' }).click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('First name').fill('Karan');
  await dlg.getByLabel('Relationship').selectOption('Self');
  await dlg.getByLabel('PAN').fill('ABCDE1234F');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Karan' })).toBeVisible();

  // --- bank
  await page.getByRole('link', { name: 'Banks' }).first().click();
  await page.getByRole('button', { name: 'Add bank' }).first().click();
  await dlg.getByLabel('Bank name').fill('State Bank of India');
  await dlg.getByLabel('Branch name').fill('Sector 17');
  await dlg.getByLabel('IFSC code').fill('SBIN0001234');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('SBIN0001234')).toBeVisible();

  // --- account
  await page.getByRole('link', { name: 'Accounts' }).first().click();
  await page.getByRole('button', { name: 'Add account' }).first().click();
  await dlg.getByLabel('Bank / branch').selectOption({ label: 'State Bank of India – Sector 17' });
  await dlg.getByLabel('Account number').fill('987654321012');
  await dlg.getByRole('textbox', { name: 'Opening balance', exact: true }).fill('12,500.50');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /State Bank of India · Savings/ })).toBeVisible();
  await expect(page.getByText('₹12,500.50').first()).toBeVisible();

  // --- transaction
  await page.getByRole('tab', { name: 'Transactions' }).click();
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await dlg.getByLabel('Amount').fill('500');
  await dlg.getByLabel('Description').fill('Groceries at Reliance Fresh');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('₹12,000.50').first()).toBeVisible();

  // --- wait for autosave
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 20_000 });

  // --- server file has no plaintext
  const dir = join(process.env.ARTHA_E2E_DATA!, 'vault', 'versions');
  const latest = readdirSync(dir).sort().pop()!;
  const blob = readFileSync(join(dir, latest));
  expect(blob.subarray(0, 6).toString()).toBe('ARTHA1');
  for (const needle of [
    'Karan',
    'Reliance',
    'State Bank',
    'ABCDE1234F',
    '987654321012',
    'SQLite format',
  ]) {
    expect(blob.includes(Buffer.from(needle)), needle).toBe(false);
  }

  // --- lock, then a fresh page load (like another device) unlocks and sees the data
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock vault' })).toBeVisible();
  await page.goto('/');
  await page.locator('input[type=password]').fill('wrong passphrase here');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Wrong passphrase or recovery key')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[type=password]').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('₹12,000.50').first()).toBeVisible();

  // --- secret masked by default, reveal works
  await page.getByRole('link', { name: 'Family' }).first().click();
  await expect(page.getByText('••••234F')).toBeVisible();
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.getByText('ABCDE1234F')).toBeVisible();

  // --- recovery key unlock sets a new passphrase
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('button', { name: 'Forgot passphrase?' }).click();
  await fillByLabel(page, 'Recovery key', recoveryKey.toLowerCase());
  await page.locator('input[type=password]').nth(0).fill('a fresh New passphrase 99');
  await fillByLabel(page, 'Confirm new passphrase', 'a fresh New passphrase 99');
  await page.getByRole('button', { name: 'Unlock and set passphrase' }).click();
  // Returns to the page that was open before locking.
  await expect(page.getByRole('heading', { name: 'Family' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 20_000 });

  // --- Phase 1: statement import via the UI, balance matches, duplicates detected, undo
  const d = new Date();
  const dmy = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const csv = [
    'State Bank of India,,,,,',
    'Statement of account,,,,,',
    'Txn Date,Description,Ref No./Cheque No.,Debit,Credit,Balance',
    `${dmy},UPI/ZOMATO/order,UPI0001,450.00,,"11,550.50"`,
    `${dmy},NEFT SALARY ACME LTD,N0002,,"50,000.00","61,550.50"`,
    ',,,,,',
    'Closing balance,,,,,"61,550.50"',
  ].join('\n');
  const file = { name: 'sbi-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) };

  await page.getByRole('link', { name: 'Import statement' }).first().click();
  await page.getByLabel('Account').selectOption({ index: 1 });
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByText('2 new')).toBeVisible();
  await expect(page.getByText(/matching the statement/)).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 transactions' }).click();
  await expect(page.getByText('sbi-statement.csv')).toBeVisible();

  // Same file again: both rows flagged as duplicates (mapping remembered for the bank).
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByText('2 duplicates skipped')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('link', { name: 'Accounts' }).first().click();
  await expect(page.getByText('₹61,550.50').first()).toBeVisible();

  await page.getByRole('link', { name: 'Import statement' }).first().click();
  await page.getByRole('button', { name: /^Undo/ }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Undo import' }).click();
  await page.getByRole('link', { name: 'Accounts' }).first().click();
  await expect(page.getByText('₹12,000.50').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 20_000 });

  expect(cspViolations, 'CSP violations').toEqual([]);
});
