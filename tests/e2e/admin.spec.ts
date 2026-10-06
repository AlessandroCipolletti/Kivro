import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('administrator restores a reviewed synthetic account through the audited API', async ({ page }, info) => {
  const headers = { origin: new URL(info.project.use.baseURL ?? 'http://localhost:3000').origin };
  const registered = await page.request.post('/api/auth/register', { data: {
    email: `admin-browser-${randomUUID()}@example.test`, name: 'Administration browser fixture', password: `Test-only-${randomUUID()}`,
  } });
  expect(registered.status()).toBe(200);
  const { user } = await registered.json() as { user: { id: string } };
  expect((await page.request.post('/api/auth/dev-login', { headers, data: { role: 'admin' } })).status()).toBe(200);
  try {
    expect((await page.goto('/admin'))?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
    const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.getByRole('textbox', { name: 'Account ID', exact: true }).fill(user.id);
    expect(await skip.evaluate(element => getComputedStyle(element).clipPath)).toBe('inset(50%)');
    await page.getByRole('button', { name: 'Review account action', exact: true }).click();
    const suspended = page.waitForResponse(response => response.url().endsWith(`/users/${user.id}/suspend`) && response.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    expect((await suspended).status()).toBe(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Account suspended.', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('false');
    await expect(page.getByRole('button', { name: 'Review account action', exact: true })).toBeDisabled();
    const reason = 'Reviewed synthetic account after the browser suspension test.';
    await page.getByRole('textbox', { name: 'Reason for restoration', exact: true }).fill(`  ${reason}  `);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `.local/admin-restoration-${info.project.name}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Review account action', exact: true }).click();
    const receipts: { key: string; result: { auditId: string; userId: string; suspended: boolean } }[] = [];
    // Lose only the first response after the real API/DB commit; the retry reaches the same backend.
    await page.route(`**/api/admin/users/${user.id}/restore`, async route => {
      const response = await route.fetch();
      receipts.push({ key: route.request().headers()['idempotency-key'], result: await response.json() });
      if (receipts.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(() => receipts.length).toBe(1);
    await expect(page.getByRole('dialog').locator('.notice.danger')).toBeVisible();
    const restored = page.waitForResponse(response => response.url().endsWith(`/users/${user.id}/restore`) && response.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    const response = await restored;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ reason });
    expect(response.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toMatchObject({ userId: user.id, suspended: false, auditId: expect.any(String) });
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toEqual(receipts[0]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Account restored.', { exact: true })).toBeVisible();
    const review = await page.request.get(`/api/admin/users/${user.id}/billing-review`);
    expect(review.status()).toBe(200);
    expect(await review.json()).toMatchObject({ user: { id: user.id, suspendedAt: null }, refundDebtMinor: 0 });
  } finally {
    await page.request.post('/api/auth/logout', { headers });
  }
});
