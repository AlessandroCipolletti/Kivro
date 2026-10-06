import { expect, type Page } from "@playwright/test";

export async function register(page: Page, suffix: string) {
  const terms = await page.request.get("/api/terms");
  expect(terms.ok()).toBe(true);
  const headers = { origin: new URL(terms.url()).origin };
  const data = { name: "Web verification", email: `web-${suffix}-${crypto.randomUUID()}@example.test`, password: `test-only-${crypto.randomUUID()}`, acceptedTermsVersion: (await terms.json()).version as string };
  let response = await page.request.post("/api/auth/register", { data, headers });
  if (response.status() === 429) {
    // The suite provisions isolated accounts without bypassing the real limiter.
    const retryAfter = response.headers()["retry-after"];
    const seconds = Number(retryAfter);
    const delay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : (seconds || 60) * 1000;
    if (Number.isFinite(delay) && delay >= 0 && delay <= 65_000) {
      await new Promise(resolve => setTimeout(resolve, delay + 1000));
      response = await page.request.post("/api/auth/register", { data, headers });
    }
  }
  expect(response.status(), await response.text()).toBe(200);
  return { ...data, headers, user: (await response.json()).user as { id: string } };
}
