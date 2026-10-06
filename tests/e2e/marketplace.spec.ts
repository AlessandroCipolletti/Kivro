import { test, expect } from '@playwright/test';

const seededCapabilities = [
  { id: '44444444-4444-4444-8444-444444444444', slug: 'document-analyzer', title: 'Document Analyzer' },
  { id: '44444444-4444-4444-8444-444444444445', slug: 'csv-insights', title: 'CSV Insights' },
  { id: '44444444-4444-4444-8444-444444444446', slug: 'technical-editor', title: 'Technical Editor' },
] as const;

test('marketplace search, offline disclosure, authenticated favorites and wallet', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const search = page.getByRole('textbox', { name: 'Search capabilities' });
  const fixtureCard = (slug: string) => page.locator('.capability-card').filter({ has: page.locator(`a.capability-title[href="/capabilities/${slug}"]`) });
  const catalogResponse = (query: string, favorites = false) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/capabilities/page' && (url.searchParams.get('q') ?? '') === query
      && (url.searchParams.get('favorites') === 'true') === favorites && response.request().method() === 'GET';
  });
  async function searchFor(query: string, favorites = false) {
    const pending = catalogResponse(query, favorites);
    await search.fill(query);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const response = await pending;
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as { items: { id: string; slug: string; title: string; isFavorite: boolean }[] };
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find the right capability.' })).toBeVisible();
  await expect(page.locator('.capability-card').first()).toBeVisible();
  await page.screenshot({ path: `.local/marketplace-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Seed identities are stable; unrelated historical capabilities may also be public.
  for (const fixture of seededCapabilities) {
    const result = await searchFor(fixture.title);
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining(fixture)]));
    await expect(fixtureCard(fixture.slug).getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
    for (const other of seededCapabilities.filter(item => item.id !== fixture.id)) await expect(fixtureCard(other.slug)).toHaveCount(0);
  }
  const missing = await searchFor(`unmatched-search-fixture-${crypto.randomUUID()}`);
  expect(missing.items).toEqual([]);
  await expect(page.getByRole('heading', { name: 'No capabilities found' })).toBeVisible();
  const cleared = catalogResponse('');
  await page.getByRole('button', { name: 'Clear search' }).click();
  expect((await cleared).status()).toBe(200);
  await expect(search).toHaveValue('');
  await expect(page.locator('.capability-card').first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Buyer login', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const documentFixture = seededCapabilities[0];
  const signedIn = await searchFor(documentFixture.title);
  const initiallySaved = signedIn.items.find(item => item.id === documentFixture.id)?.isFavorite;
  expect(typeof initiallySaved).toBe('boolean');
  const card = fixtureCard(documentFixture.slug);
  try {
    if (initiallySaved) {
      await card.getByRole('button', { name: 'Remove from favorites' }).click();
      await expect(card.getByRole('button', { name: 'Save to favorites' })).toBeVisible();
    }
    await card.getByRole('button', { name: 'Save to favorites' }).click();
    await expect(card.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
    await page.goto('/favorites');
    const favorites = await searchFor(documentFixture.title, true);
    expect(favorites.items).toEqual(expect.arrayContaining([expect.objectContaining({ ...documentFixture, isFavorite: true })]));
    await expect(card.getByRole('heading', { name: documentFixture.title, exact: true })).toBeVisible();
    const refreshed = catalogResponse(documentFixture.title, true);
    await card.getByRole('button', { name: 'Remove from favorites' }).click();
    const response = await refreshed;
    expect(response.status()).toBe(200);
    const remaining = await response.json() as { items: { id: string }[] };
    expect(remaining.items.map(item => item.id)).not.toContain(documentFixture.id);
    await expect(card).toHaveCount(0);
    if (!remaining.items.length) await expect(page.getByRole('heading', { name: 'No saved capabilities' })).toBeVisible();
  } finally {
    // Restore only this fixture's previous state; never clear other saved capabilities.
    const response = await page.request.get(`/api/capabilities/${documentFixture.id}`);
    expect(response.status()).toBe(200);
    const current = await response.json() as { isFavorite: boolean };
    if (current.isFavorite !== initiallySaved) {
      const restored = await page.request.post(`/api/capabilities/${documentFixture.id}/favorite`, { headers: { origin: new URL(page.url()).origin } });
      expect(restored.status()).toBe(200);
      expect(await restored.json()).toEqual({ isFavorite: initiallySaved });
    }
  }
  const walletResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/wallet' && response.request().method() === 'GET');
  await page.goto('/wallet');
  const wallet = await walletResponse;
  expect(wallet.status()).toBe(200);
  const { availableMinor } = await wallet.json() as { availableMinor: number };
  expect(Number.isSafeInteger(availableMinor)).toBe(true);
  await expect(page.getByRole('heading', { name: /wallet/i })).toBeVisible();
  await expect(page.locator('.wallet-balance')).toContainText('Available credits');
  await expect(page.locator('.wallet-balance strong')).toHaveText(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(availableMinor / 100));
  await expect(page.getByRole('heading', { name: 'Transactions', exact: true })).toBeVisible();
  await page.screenshot({ path: `.local/wallet-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('seller workspace and health use the seller identity', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Seller login', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const route of ['/selling', '/selling/capabilities', '/selling/workers', '/selling/earnings', '/settings', '/jobs']) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator('main')).not.toContainText('Application error');
    await expect(page.locator('main h1')).toBeVisible();
    await page.screenshot({ path: `.local/${route.replaceAll('/', '-').slice(1)}-${testInfo.project.name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('offline service details stay unpurchasable and API keys can be revoked', async ({ page }, testInfo) => {
  await page.goto('/capabilities/document-analyzer');
  await expect(page.getByRole('heading', { name: 'Document Analyzer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Currently unavailable' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Data & permissions' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/capability-detail-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Buyer login', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/settings');
  const keyName = `Browser verification ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill(keyName);
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const secretDialog = page.getByRole('dialog');
  await expect(secretDialog.locator('.secret-once')).toBeVisible();
  const secret = await secretDialog.locator('.secret-once').textContent();
  expect(secret).toBeTruthy();
  const allowed = await page.request.get('/api/jobs', { headers: { authorization: `Bearer ${secret}` } });
  expect(allowed.status()).toBe(200);
  const denied = await page.request.post('/api/jobs', { headers: { authorization: `Bearer ${secret}`, 'idempotency-key': `browser-no-create-${Date.now()}` }, data: {} });
  expect(denied.status()).toBe(403);
  await secretDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: `Revoke ${keyName}`, exact: true }).click();
  await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const revoked = await page.request.get('/api/jobs', { headers: { authorization: `Bearer ${secret}` } });
  expect(revoked.status()).toBe(401);
});

test('seller contract builder previews constrained files and blocks unvalidated publication', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Seller login', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/selling/capabilities/new');
  await expect(page.getByRole('heading', { name: 'Create a capability' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Capability title', exact: true }).fill('Browser contract verification');
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption({ index: 1 });
  await page.getByRole('textbox', { name: 'Short summary', exact: true }).fill('A private unsaved contract used by the browser verification.');
  await page.getByRole('textbox', { name: 'Private execution instructions', exact: true }).fill('Read the approved file and return a concise summary.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inputs & outputs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Source document');
  await page.getByRole('combobox', { name: 'Input type', exact: true }).selectOption('FILE');
  await page.getByRole('textbox', { name: 'Field key', exact: true }).fill('document');
  await expect(page.getByRole('textbox', { name: 'Allowed extensions (comma separated)', exact: true })).toHaveValue('.pdf, .txt, .md');
  await page.getByRole('textbox', { name: 'What will buyers receive?', exact: true }).fill('A concise summary of the source document.');
  await page.getByRole('button', { name: 'Buyer preview', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByRole('heading', { name: 'Browser contract verification' })).toBeVisible();
  await expect(preview).toContainText('Source document');
  await expect(preview.locator('input[type=file]')).toBeDisabled();
  await page.screenshot({ path: `.local/contract-preview-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await preview.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: '6 Review & publish', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish version', exact: true })).toBeDisabled();
  await expect(page.locator('main')).toContainText('Pending worker self-test');
  await page.screenshot({ path: `.local/contract-review-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
