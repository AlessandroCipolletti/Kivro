import { createHash } from "node:crypto";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { PRICE_TIERS, type CapabilityDTO } from "@kivro/contracts";
import { defaultWorkerPermissions } from "../src/lib/worker-policy";
import { contrastRatio } from "../tests/support/contrast";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

// Actual rendered controls with isolated HTTP boundary responses. No account,
// asset, job, storage/CORS configuration or payment is changed on the backend.
async function capabilityFixture(page: Page, offline = false) {
  const user = await uiFixtureSession(page);
  const permissions = defaultWorkerPermissions(); permissions.inference.model = "accessibility-fixture";
  const cap: CapabilityDTO = {
    id: crypto.randomUUID(), slug: "accessibility-fixture", title: "Accessible document input",
    summary: "Synthetic interface boundary for file errors and readable text.", description: "No work is purchased or executed by this browser case.",
    category: "Documents", tags: [], seller: { id: user.id, name: "Boundary seller" }, visibility: "PUBLIC",
    version: 1, versionId: crypto.randomUUID(), priceTierId: PRICE_TIERS[0].id, permissions, dependencies: [], examples: [],
    availability: { status: offline ? "OFFLINE" : "ONLINE", canRunNow: !offline, canQueue: false, nextAvailableAt: null, reason: offline ? "The worker is offline." : "Ready for interface verification only." },
    estimatedDurationSeconds: 60, successRate: null, completedJobs: 0, rating: null, reviewCount: 0,
    ioContract: { schemaVersion: 1, inputs: [
      { key: "source", label: "Source", description: "A source text file.", type: "FILE", required: true, order: 0, constraints: { allowedExtensions: [".txt"], allowedMimeTypes: ["text/plain"], maxFileSizeBytes: 1024 } },
      { key: "references", label: "References", description: "Optional reference files.", type: "FILES", required: false, order: 1, constraints: { allowedExtensions: [".txt"], allowedMimeTypes: ["text/plain"], maxFiles: 2, maxFileSizeBytes: 1024 } },
    ], output: { type: "TEXT", description: "A concise summary.", required: true } },
  };
  await page.route(`**/api/capabilities/${cap.id}`, route => route.fulfill({ json: cap }));
  await page.route(`**/api/capabilities/${cap.id}/reviews`, route => route.fulfill({ json: [] }));
  await page.route("**/api/terms", route => route.fulfill({ json: { version: "fixture", text: "Synthetic terms fixture.", sha256: "a".repeat(64), preliminary: true } }));
  return cap;
}

async function assertVisibleContrast(locator: Locator) {
  await expect(locator).toBeVisible();
  const pair = await locator.evaluate(element => {
    const foreground = getComputedStyle(element).color;
    let current: Element | null = element;
    while (current) {
      const background = getComputedStyle(current).backgroundColor;
      if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") return { foreground, background };
      current = current.parentElement;
    }
    return { foreground, background: "rgb(255, 255, 255)" };
  });
  expect(contrastRatio(pair.foreground, pair.background), JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5);
}

test("file controls announce their own validation and upload errors and clear successful retries", async ({ page }, info) => {
  const cap = await capabilityFixture(page);
  let puts = 0, finalizations = 0, quotes = 0;
  const contents = "Verified source text.\n", assetId = crypto.randomUUID(), uploadId = crypto.randomUUID();
  await page.route("**/api/assets/uploads", route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON().filename).toBe("source.txt");
    return route.fulfill({ json: { id: uploadId, uploadUrl: new URL("/__accessibility-storage/source", page.url()).href, method: "PUT", headers: { "content-type": "text/plain" }, expiresAt: new Date(Date.now() + 120000).toISOString(), uploadUrlExpiresAt: new Date(Date.now() + 60000).toISOString() } });
  });
  await page.route("**/__accessibility-storage/source", route => {
    expect(route.request().method()).toBe("PUT"); puts++;
    return route.fulfill({ status: 200, body: "" });
  });
  await page.route(`**/api/assets/uploads/${uploadId}/finalize`, route => {
    finalizations++;
    return finalizations === 1
      ? route.fulfill({ status: 409, json: { error: { code: "UPLOAD_PROCESSING", message: "Storage verification is still processing." } } })
      : route.fulfill({ json: { id: assetId, filename: "source.txt", mimeType: "text/plain", sizeBytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex") } });
  });
  await page.route(`**/api/capabilities/${cap.id}/quote`, route => {
    quotes++;
    return route.fulfill({ json: { id: crypto.randomUUID(), priceSnapshot: PRICE_TIERS[0], earliestStartAt: new Date().toISOString(), estimatedDeliveryAt: new Date(Date.now() + 60000).toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() } });
  });
  expect((await page.goto(`/capabilities/${cap.id}`))?.status()).toBe(200);
  const source = page.getByLabel("Source", { exact: false }).and(page.locator('input[type="file"]'));
  const references = page.getByLabel("References", { exact: false }).and(page.locator('input[type="file"]'));
  await page.getByRole("button", { name: "Review job", exact: true }).click();
  await expect(source).toHaveAttribute("aria-invalid", "true");
  await expect(source).toHaveAccessibleDescription(/A source text file\. This field is required\./);
  await expect(references).toHaveAttribute("aria-invalid", "false");
  await source.setInputFiles({ name: "source.exe", mimeType: "text/plain", buffer: Buffer.from("bad") });
  await references.setInputFiles({ name: "references.exe", mimeType: "text/plain", buffer: Buffer.from("bad") });
  await expect(source).toHaveAccessibleDescription(/source\.exe has an unsupported extension/);
  await expect(source).not.toHaveAccessibleDescription(/references\.exe/);
  await expect(references).toHaveAccessibleDescription(/references\.exe has an unsupported extension/);
  await expect(references).not.toHaveAccessibleDescription(/source\.exe/);
  const sourceId = await source.getAttribute("id"), referencesId = await references.getAttribute("id");
  expect(sourceId).not.toBe(referencesId);
  await expect(source).toHaveAttribute("aria-describedby", `${sourceId}-help ${sourceId}-upload-error`);
  await expect(references).toHaveAttribute("aria-describedby", `${referencesId}-help ${referencesId}-upload-error`);
  await assertVisibleContrast(page.locator(".file-field .notice.danger").first());
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/upload-accessibility-fixture-${info.project.name}.png`, fullPage: true });
  expect(puts).toBe(0); expect(quotes).toBe(0);

  await page.reload();
  await source.setInputFiles({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from(contents) });
  await expect(source).toHaveAccessibleDescription(/Storage verification is still processing/);
  await expect(source).toHaveAttribute("aria-invalid", "true");
  await expect(references).toHaveAttribute("aria-invalid", "false");
  await page.getByRole("button", { name: "Retry file verification" }).click();
  await expect(page.getByText("source.txt", { exact: true })).toBeVisible();
  await expect(source).toHaveAttribute("aria-invalid", "false");
  await expect(source).toHaveAccessibleDescription("A source text file.");
  await expect(source).toHaveAttribute("aria-describedby", `${await source.getAttribute("id")}-help`);
  await expect(page.locator('[id$="-upload-error"]')).toHaveCount(0);
  expect(puts).toBe(1); expect(finalizations).toBe(2);
  await page.getByRole("button", { name: "Review job", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run now for $0.99" })).toBeDisabled();
  expect(quotes).toBe(1);
});

test("rendered neutral statuses, muted text and upload hints meet normal-text contrast", async ({ page }, info) => {
  const cap = await capabilityFixture(page, true);
  expect((await page.goto(`/capabilities/${cap.id}`))?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Currently unavailable" })).toBeDisabled();
  await assertVisibleContrast(page.locator(".checkout .status.neutral"));
  await assertVisibleContrast(page.locator(".checkout > .muted"));
  await assertVisibleContrast(page.locator(".upload-area > small").first());
  await assertVisibleContrast(page.locator(".capability-heading .muted"));
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/contrast-fixture-${info.project.name}.png`, fullPage: true });
});
