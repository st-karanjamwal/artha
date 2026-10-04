import { expect, test, type Page } from '@playwright/test';
import { setupServerAndVault } from './helpers';

// Visual review helper: `SHOTS=1 npx playwright test e2e/screens.spec.ts`
// Writes screenshots of the main screens (desktop + phone, light + dark) to .e2e-data/shots/.
test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture screenshots');

const dlg = (page: Page) => page.locator('dialog[open]');

async function addPerson(page: Page, first: string, rel: string, dob?: string) {
  await page.goto('/family');
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

test('capture screens', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setupServerAndVault(page);
  // In-app navigation only (a full page load would lock the vault).
  const nav = async (name: string) => {
    const link = page.getByRole('link', { name, exact: true });
    if (await link.first().isVisible()) await link.first().click();
    else {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('link', { name, exact: true }).last().click();
    }
  };
  page.goto = (async (url: string) => {
    const map: Record<string, string> = {
      '/family': 'Family',
      '/banks': 'Banks',
      '/accounts': 'Accounts',
      '/': 'Dashboard',
    };
    await nav(map[url]);
    return null;
  }) as typeof page.goto;

  await addPerson(page, 'Karan', 'Self', '1986-03-12');
  await addPerson(page, 'Simran', 'Spouse', '1988-07-02');
  await addPerson(page, 'Aara', 'Daughter', '2018-05-01');

  for (const [bank, ifsc] of [
    ['State Bank of India', 'SBIN0001234'],
    ['HDFC Bank', 'HDFC0000123'],
  ]) {
    await nav('Banks');
    await page.getByRole('button', { name: 'Add bank' }).first().click();
    await dlg(page).getByLabel('Bank name').fill(bank);
    await dlg(page).getByLabel('Branch name').fill('Sector 17');
    await dlg(page).getByLabel('IFSC code').fill(ifsc);
    await dlg(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(ifsc)).toBeVisible();
  }

  const accounts: [string, string, string, string, string?][] = [
    ['State Bank of India – Sector 17', 'Savings', '30117755123', '84,250.00'],
    ['HDFC Bank – Sector 17', 'Salary', '50100012345678', '1,25,000.00'],
    ['State Bank of India – Sector 17', 'PPF', '32998877001', '6,40,000.00', '2031-04-01'],
    [
      'State Bank of India – Sector 17',
      'SukanyaSamriddhi',
      '33100022',
      '2,10,000.00',
      '2039-05-01',
    ],
  ];
  for (const [bank, type, num, bal, mat] of accounts) {
    await nav('Accounts');
    await page.getByRole('button', { name: 'Add account' }).first().click();
    await dlg(page).getByLabel('Bank / branch').selectOption({ label: bank });
    await dlg(page).getByLabel('Account type').selectOption(type);
    await dlg(page).getByLabel('Account number').fill(num);
    await dlg(page).getByRole('textbox', { name: 'Opening balance', exact: true }).fill(bal);
    if (mat) await dlg(page).getByLabel('Maturity date').fill(mat);
    await dlg(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
  }

  // A statement so the dashboard has flows.
  const d = new Date();
  const fmt = (back: number) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
  };
  const lines = ['Txn Date,Description,Ref No.,Debit,Credit,Balance'];
  const entries: [number, string, number, number][] = [
    [150, 'NEFT SALARY ACME', 0, 95000],
    [140, 'BigBasket groceries', 6200, 0],
    [120, 'NEFT SALARY ACME', 0, 95000],
    [110, 'Electricity PSPCL', 3400, 0],
    [90, 'NEFT SALARY ACME', 0, 95000],
    [80, 'School fees', 42000, 0],
    [60, 'NEFT SALARY ACME', 0, 95000],
    [50, 'Swiggy', 1850, 0],
    [30, 'NEFT SALARY ACME', 0, 95000],
    [25, 'Apollo Pharmacy', 2300, 0],
    [12, 'Petrol', 3500, 0],
    [3, 'Amazon', 5400, 0],
  ];
  entries.forEach(([back, desc, dr, cr], i) =>
    lines.push(`${fmt(back)},${desc},R${i},${dr || ''},${cr || ''},`),
  );
  await nav('Import statement');
  await page.getByLabel('Account').selectOption({ index: 2 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'hdfc.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(lines.join('\n')),
  });
  await page.getByRole('button', { name: /^Import \d+ transactions/ }).click();

  const shots: [string, () => Promise<void>][] = [
    ['dashboard', () => nav('Dashboard')],
    ['family', () => nav('Family')],
    ['accounts', () => nav('Accounts')],
    [
      'account-detail',
      async () => {
        await nav('Accounts');
        await page
          .getByRole('link', { name: /HDFC Bank/ })
          .first()
          .click();
      },
    ],
    [
      'account-transactions',
      async () => {
        await page.getByRole('tab', { name: 'Transactions' }).click();
      },
    ],
    ['transactions', () => nav('Transactions')],
    ['import', () => nav('Import statement')],
    ['settings', () => nav('Settings')],
  ];

  for (const [vw, vh, tag] of [
    [1280, 900, 'desktop'],
    [390, 844, 'phone'],
  ] as const) {
    await page.setViewportSize({ width: vw, height: vh });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [name, go] of shots) {
        await go();
        await page.waitForTimeout(400);
        await page.screenshot({
          path: `.e2e-data/shots/${tag}-${scheme}-${name}.png`,
          fullPage: true,
        });
      }
    }
  }
});
