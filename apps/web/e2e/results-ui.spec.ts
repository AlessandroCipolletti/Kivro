import { test, expect } from "@playwright/test";
import { prepaidFinancialBreakdown, PRICE_TIERS } from "@kivro/contracts";
import { register } from "./auth";

// Rendering boundary only. This response is not a claim of real paid delivery.
test("pinned named results render safely without remote Markdown image requests", async ({ page }, info) => {
  const account = await register(page, "results");
  const id = crypto.randomUUID(), versionId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const fields = [
    { key: "summary", label: "Summary", type: "MARKDOWN", required: true, order: 0 },
    { key: "accepted", label: "Accepted", type: "BOOLEAN", required: true, order: 1 },
    { key: "count", label: "Count", type: "NUMBER", required: true, order: 2 },
    { key: "attachment", label: "Delivered report", type: "FILE", required: true, order: 3, constraints: { allowedMimeTypes: ["application/pdf"], allowedExtensions: [".pdf"], maxFileSizeBytes: 2048, maxFiles: 1 } },
  ];
  const now = new Date().toISOString();
  let remoteRequests = 0;
  page.on("request", request => { if (request.url().includes("tracker.invalid")) remoteRequests++; });
  await page.route(`**/api/jobs/${id}`, route => route.fulfill({ json: {
    id, capabilityId: crypto.randomUUID(), capabilityVersionId: versionId, capabilityVersionNumber: 3, capabilityTitle: "Typed result verification",
    buyerId: account.user.id, sellerId: account.user.id, state: "SUCCEEDED", paymentState: "SETTLED", input: { count: 0, consent: false }, priceSnapshot: PRICE_TIERS[0],
    inputContract: [{ key: "count", label: "Purchased count label", type: "INTEGER", required: true, order: 0, constraints: { minimum: 0, maximum: 10 } }, { key: "consent", label: "Purchased consent label", type: "BOOLEAN", required: true, order: 1 }],
    financialBreakdown: prepaidFinancialBreakdown(PRICE_TIERS[0]),
    createdAt: now, updatedAt: now, startedAt: now, completedAt: now, scheduledAt: null, error: null, events: [],
    outputContract: { type: "MIXED", description: "Frozen purchased result contract", required: true, fields, files: { allowedMimeTypes: ["application/pdf"], allowedExtensions: [".pdf"], maxFiles: 1, maxTotalSizeBytes: 2048 } },
    output: { fields: { summary: "# Delivered summary\n\n**Verified rendering**\n\n| Count | Status |\n| - | - |\n| 0 | Complete |\n\n<script>window.injected = true</script>\n\n![Remote image](https://tracker.invalid/pixel)\n\n[Unsafe](javascript:alert%281%29)", accepted: false, count: 0, attachment: assetId }, assets: [{ id: assetId, filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 1200, sha256: "a".repeat(64) }] },
  } }));
  expect((await page.goto(`/jobs/${id}`))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Typed result verification" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delivered summary" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Accepted", exact: true })).toContainText("No");
  await expect(page.getByRole("region", { name: "Count", exact: true }).locator(".tabular")).toHaveText("0");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download report.pdf" })).toHaveAttribute("href", `/api/assets/${assetId}/download`);
  await expect(page.locator('.result-content script, .result-content a[href^="javascript:"], .result-markdown img')).toHaveCount(0);
  await expect(page.getByText("Version 3", { exact: true })).toBeVisible();
  expect(remoteRequests).toBe(0);
  await page.getByText("Financial breakdown", { exact: true }).click();
  const finances = page.getByRole("region", { name: "Purchased financial snapshot" });
  await expect(finances.getByText("Tax", { exact: true }).locator("..").locator("dd")).toHaveText("Not assessed");
  await expect(finances.getByText("Payment-processing fee", { exact: true }).locator("..").locator("dd")).toHaveText("Not attributed to this job");
  await expect(finances.getByText("Total prepaid credits", { exact: true }).locator("..").locator("dd")).toHaveText("$0.99");
  await expect(finances).toContainText("not a final tax invoice or proof of settlement");
  await page.getByText("Submitted inputs", { exact: true }).click();
  const submitted = page.getByRole("region", { name: "Submitted input: Purchased count label", exact: true });
  await expect(submitted.locator(".prewrap")).toHaveText("0");
  await expect(page.getByRole("region", { name: "Submitted input: Purchased consent label", exact: true }).getByText("No", { exact: true })).toBeVisible();
  await submitted.getByText("Purchased input constraints", { exact: true }).click();
  await expect(submitted.getByText("Minimum value", { exact: true }).locator("..").locator("dd")).toHaveText("0");
  await expect(submitted.getByText("Maximum value", { exact: true }).locator("..").locator("dd")).toHaveText("10");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/results-fixture-${info.project.name}.png`, fullPage: true });
});
