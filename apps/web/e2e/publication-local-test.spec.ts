import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { PRICE_TIERS } from "@kivro/contracts";
import { SellerTestBundleSchema } from "@kivro/contracts/seller-test";
import { sellerCapabilityFixture } from "../tests/support/seller-capabilities";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

async function editorFixture(page: Page, ready = false) {
  await uiFixtureSession(page);
  const cap = sellerCapabilityFixture({ title: "Local test verification", visibility: "DRAFT", manifestHash: "a".repeat(64), internalInstructions: "Use only approved resources.", testPassedAt: ready ? "2026-10-06T10:00:00Z" : null, currentVersionId: null,
    dependencies: [{ id: "inference", name: "Approved inference", type: "INFERENCE", required: true, approved: true, supported: ready, healthy: ready, confidence: "DETECTED", certainty: "LIKELY", grants: { inferenceProviders: ["openai-compatible"] } }],
    ioContract: { schemaVersion: 1, inputs: [{ key: "source", label: "Source file", type: "FILE", required: true, order: 0, constraints: { allowedExtensions: [".txt"], allowedMimeTypes: ["text/plain"], maxFileSizeBytes: 1000 } }], output: { type: "TEXT", description: "Text result", required: true } },
    executionFileLimits: { singleFileBytes: 100, inputBytes: 1024, outputBytes: 1024 },
  });
  const state = { cap, publishes: 0, saves: 0 };
  await page.route("**/api/seller/workers", route => route.fulfill({ json: [] }));
  await page.route("**/api/seller/capabilities", route => route.fulfill({ json: [state.cap] }));
  await page.route(`**/api/seller/capabilities/${cap.id}/versions`, route => route.fulfill({ json: {
    capabilityId: cap.id, currentVersionId: null, draftVersionId: state.cap.versionId, visibility: "DRAFT", lifecycleRevision: 0, nextCursor: null,
    versions: [{ id: state.cap.versionId, version: state.cap.version, title: state.cap.title, priceTierId: state.cap.priceTierId, state: ready ? "READY_TO_PUBLISH" : "DRAFT", isActive: false, isDraft: true, createdAt: "2026-10-06T10:00:00Z", publishedAt: null, retiredAt: null, consentAt: null, testPassedAt: state.cap.testPassedAt, manifestHash: state.cap.manifestHash, readiness: { ready, reasons: ready ? [] : ["TEST_REQUIRED"] }, exampleIssues: [] }],
  } }));
  await page.route(`**/api/seller/capabilities/${cap.id}/versions/*/diff`, route => route.fulfill({ json: { lifecycleRevision: 0, fromVersionId: null, toVersionId: state.cap.versionId, diffHash: "c".repeat(64), changes: [], warnings: [], permissionExpansion: false } }));
  await page.route(`**/api/seller/capabilities/${cap.id}/publish`, route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ visibility: "PRIVATE", expectedRevision: 0, versionId: cap.versionId, reviewedDiffHash: "c".repeat(64), localExecutionAcknowledged: true });
    state.publishes++; return route.fulfill({ json: { ...state.cap, visibility: "PRIVATE" } });
  });
  await page.route(`**/api/seller/capabilities/${cap.id}`, route => {
    expect(route.request().method()).toBe("PUT"); state.saves++;
    state.cap = { ...state.cap, versionId: crypto.randomUUID(), manifestHash: "b".repeat(64), version: state.cap.version + 1, title: route.request().postDataJSON().title };
    return route.fulfill({ json: state.cap });
  });
  await page.goto(`/selling/capabilities/${cap.id}`);
  await expect(page.getByRole("heading", { name: `Edit ${cap.title}` })).toBeVisible();
  return state;
}

test("publication requires distinct unchecked local execution approval and a new saved version clears consent", async ({ page }, info) => {
  const state = await editorFixture(page, true);
  await page.getByRole("button", { name: "6 Review & publish", exact: true }).click();
  const ack = page.getByLabel(/I understand and approve local execution/);
  await expect(ack).not.toBeChecked();
  await expect(page.getByRole("region", { name: "Local execution approval" })).toContainText("personal workspace is not shared");
  await expect(page.getByRole("region", { name: "Local execution approval" })).toContainText("You pay remote provider usage");
  await page.getByLabel(/I have reviewed this saved version/).check();
  await page.getByLabel(/I approve this version's exact permissions/).check();
  await expect(page.getByRole("button", { name: "Publish version", exact: true })).toBeDisabled();
  expect(state.publishes).toBe(0);
  await ack.check();
  await page.getByRole("button", { name: "Publish version", exact: true }).click();
  await expect(page.getByText(/published as private/)).toBeVisible(); expect(state.publishes).toBe(1);
  await page.getByRole("button", { name: "1 Identity", exact: true }).click();
  await page.getByLabel("Capability title").fill("Changed saved local version");
  await page.getByRole("button", { name: "Save draft", exact: true }).first().click();
  await expect(page.getByText(/Version 2 saved/)).toBeVisible();
  await page.getByRole("button", { name: "6 Review & publish", exact: true }).click();
  await expect(ack).not.toBeChecked(); expect(state.saves).toBe(1); expect(state.publishes).toBe(1);
  await noOverflow(page); await page.screenshot({ path: `apps/web/verification/publication-ack-fixture-${info.project.name}.png`, fullPage: true });
});

test("local preview downloads only selected file bytes pinned to saved version without upload or purchase", async ({ page }, info) => {
  const state = await editorFixture(page);
  await page.getByRole("button", { name: "Buyer preview", exact: true }).click();
  const dialog = page.getByRole("dialog"), file = dialog.locator('input[type="file"]');
  await expect(file).toBeEnabled();
  await file.setInputFiles({ name: "too-large.txt", mimeType: "text/plain", buffer: Buffer.alloc(101, 65) });
  await expect(dialog.getByRole("alert")).toContainText("file size limit");
  const content = Buffer.from("Explicit local file bytes");
  await file.setInputFiles({ name: "discarded.txt", mimeType: "text/plain", buffer: Buffer.from("Not exported") });
  await dialog.getByRole("button", { name: "Remove discarded.txt" }).click();
  await file.setInputFiles({ name: "chosen.txt", mimeType: "text/plain", buffer: content });
  await expect(dialog.getByText("chosen.txt", { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export local test bundle" }).click();
  const download = await downloaded, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const bundle = SellerTestBundleSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
  expect(bundle.capabilityVersionId).toBe(state.cap.versionId); expect(bundle.manifestHash).toBe(state.cap.manifestHash);
  expect(bundle.assets).toHaveLength(1); expect(bundle.input.source).toBe(bundle.assets[0].id);
  expect(Buffer.from(bundle.assets[0].contentBase64, "base64")).toEqual(content);
  expect(bundle.assets[0].sha256).toBe(createHash("sha256").update(content).digest("hex"));
  expect(JSON.stringify(bundle)).not.toMatch(/discarded|credential|permission|sourcePath|downloadUrl/);
  expect(state.publishes).toBe(0); expect(state.saves).toBe(0);
  await noOverflow(page); await page.screenshot({ path: `apps/web/verification/local-test-fixture-${info.project.name}.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Buyer preview", exact: true }).click();
  await expect(dialog.getByText("chosen.txt", { exact: true })).toHaveCount(0);
});

test("inference estimates distinguish unknown, explicit zero and negative margin without changing price or publishing", async ({ page }) => {
  const state = await editorFixture(page);
  await page.getByRole("button", { name: "4 Price & schedule", exact: true }).click();
  const economics = page.getByRole("region", { name: "Prepublication economics" });
  await expect(economics).toContainText("Unknown cost does not mean zero");
  await economics.getByLabel("Your inference estimate (USD per job)").fill("0.00");
  await expect(economics).toContainText("Based on your estimate");
  await economics.getByLabel("Your inference estimate (USD per job)").fill("100.00");
  await expect(economics).toContainText("-$");
  expect(state.cap.priceTierId).toBe(PRICE_TIERS[0].id); expect(state.publishes).toBe(0); expect(state.saves).toBe(0);
});
