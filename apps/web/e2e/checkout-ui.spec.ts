import { test, expect } from "@playwright/test";
import { PRICE_TIERS, type CapabilityDTO } from "@kivro/contracts";
import { register } from "./auth";

// Deterministic UI boundary test only. No job purchase is submitted and no mocked
// responses are used for the real-service screenshots in flows.spec.ts.
test("queued review obeys canQueue and requires quoted consent", async ({ page }) => {
  const catalog = await (await page.request.get("/api/capabilities")).json() as CapabilityDTO[];
  const capability = catalog.find(cap => cap.ioContract.inputs.every(field => !["FILE", "FILES"].includes(field.type)));
  test.skip(!capability, "A scalar-input public capability is needed for this boundary test.");
  const cap = capability!;
  await register(page, "checkout");
  let canQueue = true;
  let purchases = 0;
  await page.route(`**/api/capabilities/${cap.id}`, route => route.fulfill({ json: { ...cap, availability: { status: "BUSY", canRunNow: false, canQueue, nextAvailableAt: null, reason: canQueue ? "Accepting queued jobs" : "Queue full" } } }));
  await page.route(`**/api/capabilities/${cap.id}/quote`, route => {
    expect(route.request().postDataJSON()).toEqual({ executionMode: "NOW" });
    return route.fulfill({ json: { id: crypto.randomUUID(), priceSnapshot: PRICE_TIERS[0], earliestStartAt: new Date().toISOString(), estimatedDeliveryAt: new Date(Date.now() + 60000).toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() } });
  });
  page.on("request", request => { if (request.url().endsWith("/api/jobs") && request.method() === "POST") purchases++; });
  await page.goto(`/capabilities/${cap.id}`);
  await expect(page.getByRole("button", { name: "Review queued job" })).toBeEnabled();
  for (const field of cap.ioContract.inputs.filter(field => field.required && ["SHORT_TEXT", "LONG_TEXT"].includes(field.type))) await page.getByLabel(field.label).fill("This is buyer input for an isolated UI boundary test, not a real execution.");
  await page.getByRole("button", { name: "Review queued job" }).click();
  const buy = page.getByRole("button", { name: "Join queue for $0.99" });
  await expect(buy).toBeDisabled();
  await expect(page.locator(".checkout .payment-policy")).toContainText("from its marketplace share");
  await expect(page.locator(".checkout .payment-policy")).toContainText("not recorded as zero or exempt");
  await expect(page.locator(".checkout .payment-policy")).toContainText("not a final tax invoice");
  await page.getByLabel("I approve this job, its price, timing and declared permissions.").check();
  await expect(buy).toBeEnabled();
  expect(purchases).toBe(0);
  canQueue = false;
  await page.reload();
  await expect(page.getByRole("button", { name: "Currently unavailable" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review queued job" })).toHaveCount(0);
});
