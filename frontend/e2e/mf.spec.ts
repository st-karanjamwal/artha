import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setupServerAndVault } from './helpers';
import { makeTextPdf } from './pdf';

const dlg = (page: Page) => page.locator('dialog[open]');
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Navigate inside the SPA (a full page load would lock the vault). */
async function go(page: Page, sidebar: string, sub?: string) {
  await page.getByRole('link', { name: sidebar, exact: true }).first().click();
  if (sub)
    await page
      .getByRole('navigation', { name: 'Mutual funds' })
      .getByRole('link', { name: sub, exact: true })
      .click();
}

async function addPerson(page: Page, first: string, rel: string, dob?: string) {
  await go(page, 'Family');
  await page
    .getByRole('button', { name: /Add member|Add yourself first/ })
    .first()
    .click();
  await dlg(page).getByLabel('First name').fill(first);
  await dlg(page).getByLabel('Relationship').selectOption(rel);
  if (dob) await dlg(page).getByLabel('Date of birth').fill(dob);
  await dlg(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: first })).toBeVisible();
}

async function addAccount(page: Page, person: string, name: string) {
  await page.getByRole('button', { name: 'Add account' }).first().click();
  await dlg(page).getByLabel('Person').selectOption({ label: person });
  await dlg(page).getByLabel('Account name').fill(name);
  await dlg(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

test('mutual funds acceptance (spec §12)', async ({ page }) => {
  const csp: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
  });
  await setupServerAndVault(page);

  await addPerson(page, 'Karan', 'Self', '1986-03-12');
  await addPerson(page, 'Simran', 'Spouse', '1988-07-02');
  await addPerson(page, 'Aara', 'Daughter', '2018-05-01');

  // 2. Investment accounts for self, spouse and a child (guardian on the child's folio)
  await go(page, 'Mutual funds', 'Accounts & folios');
  await addAccount(page, 'Karan (Self)', 'Karan – Groww');
  await addAccount(page, 'Simran (Spouse)', 'Simran – Coin');
  await addAccount(page, 'Aara (Daughter)', 'Aara – MF Central');
  const kidCard = page.locator('section', { hasText: 'Aara – MF Central' });
  await kidCard.getByRole('button', { name: '+ Folio' }).click();
  await dlg(page).getByLabel('AMC').fill('Axis Mutual Fund');
  await dlg(page).getByLabel('Folio number').fill('K-1');
  await dlg(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('The primary holder is a minor; add a guardian')).toBeVisible();
  await dlg(page).getByRole('button', { name: '+ Add person' }).click();
  await dlg(page).getByLabel('Person', { exact: true }).nth(1).selectOption({ label: 'Karan' });
  await dlg(page).getByLabel('Role').nth(1).selectOption('GUARDIAN');
  await dlg(page).getByRole('button', { name: 'Save' }).click();
  await expect(kidCard.getByText(/Karan \(guardian\)/)).toBeVisible();

  // 1. Add 3 funds by searching the AMFI list (scheme code + ISIN auto-filled)
  await go(page, 'Mutual funds', 'Funds');
  await page.getByRole('button', { name: 'Add from AMFI' }).click();
  const search = dlg(page).getByPlaceholder(/Search by fund name/);
  for (const q of ['hdfc flexi', 'axis bluechip', 'icici equity debt']) {
    await search.fill(q);
    await dlg(page).getByRole('button', { name: 'Add', exact: true }).first().click();
  }
  await dlg(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('code 118955 · INF179K01UT0')).toBeVisible();
  await expect(page.getByText('code 120465 · INF846K01CH7')).toBeVisible();

  // 3. Three SIPs of ₹10,000 → ₹30,000/month, ₹3,60,000/year
  const now = new Date();
  const start = iso(new Date(now.getFullYear(), now.getMonth() - 2, 10));
  await go(page, 'Mutual funds', 'SIPs');
  for (const fund of [
    'HDFC Flexi Cap Fund',
    'Axis Bluechip Fund',
    'ICICI Prudential Equity & Debt Fund',
  ]) {
    await page.getByRole('button', { name: 'New SIP' }).first().click();
    await dlg(page)
      .getByLabel('Fund plan')
      .selectOption({ label: `${fund} (Direct · Growth)` });
    await dlg(page).getByLabel('Investment account').selectOption({ label: 'Karan – Groww' });
    await dlg(page).getByRole('textbox', { name: 'Amount per instalment' }).fill('10000');
    await dlg(page).getByLabel('SIP day of month').fill('10');
    await dlg(page).getByLabel('Start date').fill(start);
    await dlg(page).getByRole('button', { name: 'Save' }).click();
    await expect(dlg(page)).toHaveCount(0);
  }
  await expect(page.getByText('₹30,000.00').first()).toBeVisible();
  await expect(page.getByText('₹3,60,000.00').first()).toBeVisible();

  // 4. Confirm a pending instalment; units match a real allotment (stamp duty 0.005%, 3 dp)
  await expect(page.getByRole('heading', { name: /Pending SIP confirmations/ })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).first().click();
  await dlg(page).getByLabel('NAV').fill('125.50');
  await expect(dlg(page).getByText('Calculated 79.677')).toBeVisible();
  await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Instalment recorded')).toBeVisible();
  await go(page, 'Mutual funds', 'Transactions');
  await expect(page.getByText('+79.677').first()).toBeVisible();

  // 5. Refresh NAV
  await go(page, 'Mutual funds', 'Overview');
  await page.getByRole('button', { name: 'Refresh NAV' }).click();
  await expect(page.getByText(/NAV refreshed: 3 plans matched/)).toBeVisible();

  // 6. Import a CAS (PDF parsed in the browser) → zero unit mismatches
  const casText = readFileSync('src/features/mf/__fixtures__/cas-sample.txt', 'utf8').split('\n');
  await go(page, 'Mutual funds', 'Import');
  await page
    .getByLabel('Investment account for new folios')
    .selectOption({ label: 'Karan – Groww' });
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'cas.pdf', mimeType: 'application/pdf', buffer: makeTextPdf(casText) });
  await page.getByRole('button', { name: 'Read CAS' }).click();
  await expect(page.getByText('All 3 schemes match the CAS closing units.')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Import 6 transactions' }).click();
  await expect(page.getByText(/Imported \(batch #1\)/)).toBeVisible();
  // Re-reading the same CAS finds only duplicates.
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'cas.pdf', mimeType: 'application/pdf', buffer: makeTextPdf(casText) });
  await page.getByRole('button', { name: 'Read CAS' }).click();
  await expect(page.getByText('6 duplicates')).toBeVisible({ timeout: 30_000 });

  await go(page, 'Mutual funds', 'Portfolio');
  await expect(page.getByRole('link', { name: 'Axis Liquid Fund' }).first()).toBeVisible();
  await expect(page.getByText('XIRR').first()).toBeVisible();

  // 7. Redeem part of a fund → realised gain with ST/LT classification in the FY report
  await go(page, 'Mutual funds', 'Transactions');
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await dlg(page).getByLabel('Type').selectOption('REDEMPTION');
  await dlg(page).getByLabel('Investment account').selectOption({ label: 'Karan – Groww' });
  await dlg(page)
    .getByLabel('Fund plan')
    .selectOption({ label: 'Axis Bluechip Fund (Direct · Growth)' });
  await dlg(page).getByLabel('Folio').selectOption({ label: 'Axis Mutual Fund · 9101112131/0' });
  await dlg(page).getByLabel('NAV').fill('62.34');
  await dlg(page).getByRole('textbox', { name: 'Units', exact: true }).fill('100');
  await expect(dlg(page).getByText(/Credited to bank/)).toBeVisible();
  await dlg(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
  await go(page, 'Mutual funds', 'Capital gains');
  await expect(page.getByText('Equity ST').first()).toBeVisible();
  await expect(page.getByText('Estimated tax (fixed-rate part)').first()).toBeVisible();

  // Dashboard shows MF value; everything stays inside the encrypted vault
  await go(page, 'Dashboard');
  await expect(page.getByText('Mutual funds').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 20_000 });
  const dir = join(process.env.ARTHA_E2E_MF_DATA!, 'vault', 'versions');
  const blob = readFileSync(join(dir, readdirSync(dir).sort().pop()!));
  for (const needle of ['Axis Bluechip', '9101112131', 'INF846K01CH7', 'Karan']) {
    expect(blob.includes(Buffer.from(needle)), needle).toBe(false);
  }
  expect(csp, 'CSP violations').toEqual([]);

  // Optional visual review: SHOTS=1 npx playwright test --project=mf
  if (process.env.SHOTS) {
    const subs = [
      'Overview',
      'Portfolio',
      'SIPs',
      'Transactions',
      'Funds',
      'Accounts & folios',
      'Capital gains',
      'Import',
    ];
    for (const [w, h, tag] of [
      [1280, 900, 'desktop'],
      [390, 844, 'phone'],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const sub of subs) {
          if (tag === 'phone') {
            await page.getByRole('button', { name: 'Open menu' }).click();
            await page.getByRole('link', { name: 'Mutual funds', exact: true }).last().click();
          } else
            await page.getByRole('link', { name: 'Mutual funds', exact: true }).first().click();
          await page
            .getByRole('navigation', { name: 'Mutual funds' })
            .getByRole('link', { name: sub, exact: true })
            .click();
          await page.waitForTimeout(400);
          await page.screenshot({
            path: `.e2e-data/shots/mf-${tag}-${scheme}-${sub.replace(/\W+/g, '-').toLowerCase()}.png`,
            fullPage: true,
          });
        }
      }
    }
  }
});
