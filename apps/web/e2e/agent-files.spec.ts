import { test, expect } from "@playwright/test";
import type { AgentContractMatch } from "../src/lib/agent-files";
import { recommendationCapability } from "../tests/support/recommendations";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";
import { register } from "./auth";

test("real agent attachment uploads directly, sends only verified IDs and never silently reattaches history", async ({ page }, info) => {
  await register(page, "agent-files");
  expect((await page.goto("/agent"))?.status()).toBe(200);
  await page.getByText("Files & required deliverables (0 attached)", { exact: true }).click();
  const finalized = page.waitForResponse(response => /\/api\/assets\/uploads\/[^/]+\/finalize$/.test(response.url()) && response.request().method() === "POST");
  await page.getByLabel("Attach input files", { exact: true }).setInputFiles({ name: "agent-source.txt", mimeType: "text/plain", buffer: Buffer.from("A real user-selected source file for contract matching.\n") });
  const uploadResponse = await finalized; expect(uploadResponse.status(), await uploadResponse.text()).toBe(200);
  const asset = await uploadResponse.json();
  await expect(page.getByText("agent-source.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add output format", exact: true }).click();
  await page.getByLabel("Extension 1", { exact: true }).fill(" PDF ");
  await page.getByLabel("MIME type 1", { exact: true }).fill(" APPLICATION/PDF ");
  await page.getByLabel("Your request").fill("Summarize my attached document and return one PDF.");
  const chat = page.waitForResponse(response => response.url().endsWith("/api/agent/chat") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  const response = await chat; expect(response.status(), await response.text()).toBe(200);
  const body = response.request().postDataJSON();
  expect(body.inputAssetIds).toEqual([asset.id]); expect(body.requiredOutputFiles).toEqual([{ extension: ".pdf", mimeType: "application/pdf", count: 1 }]);
  for (const key of ["inputAssets", "filename", "sha256", "downloadUrl"]) expect(body).not.toHaveProperty(key);
  await expect(page.locator(".conversation-entry.assistant")).toBeVisible();
  await expect(page.getByText("Files & required deliverables (0 attached)", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-file-history")).toContainText("Not attached to the next request");
  await page.reload();
  await page.locator(".conversation-button").first().click();
  await expect(page.locator(".agent-file-history")).toContainText("1 input file selected");
  await expect(page.locator(".agent-file-history")).toContainText(".pdf / application/pdf");
  await page.getByLabel("Your request").fill("Now find a service without reusing that file.");
  const next = page.waitForResponse(result => result.url().endsWith("/api/agent/chat") && result.request().method() === "POST");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  const nextResponse = await next; expect(nextResponse.status(), await nextResponse.text()).toBe(200);
  expect(nextResponse.request().postDataJSON()).not.toHaveProperty("inputAssetIds");
  expect(nextResponse.request().postDataJSON()).not.toHaveProperty("requiredOutputFiles");
  await expect(page.locator(".conversation-entry.assistant")).toHaveCount(2);
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/agent-files-real-${info.project.name}.png`, fullPage: true });
});

test("agent output constraints reject duplicates, preserve errors for retry and render exact contract gaps", async ({ page }, info) => {
  await uiFixtureSession(page);
  const cap = recommendationCapability("File contract boundary"), conversationId = crypto.randomUUID();
  cap.ioContract.inputs = [{ key: "resolution", label: "Render resolution", type: "SHORT_TEXT", required: true, order: 0 }];
  const match: AgentContractMatch = { capabilityId: cap.id, capabilityVersionId: cap.versionId, status: "NEEDS_INPUT", preparedInput: { title: "<img src=x onerror=alert(1)>" }, appliedDefaults: ["title"], assetOptions: [], issues: [{ code: "MISSING_INPUT", severity: "CLARIFICATION", inputKey: "resolution" }], output: { compatible: true, guaranteed: false, issues: [{ code: "OUTPUT_NOT_GUARANTEED", severity: "CLARIFICATION", requirementIndex: 0 }] } };
  await page.route("**/api/capabilities", route => route.fulfill({ json: [cap] }));
  await page.route("**/api/agent/conversations", route => route.fulfill({ json: [] }));
  let attempts = 0;
  await page.route("**/api/agent/chat", route => {
    attempts++;
    expect(route.request().postDataJSON().requiredOutputFiles).toEqual([{ extension: ".pdf", count: 2 }]);
    return attempts === 1 ? route.fulfill({ status: 403, json: { error: { code: "AGENT_ASSET_NOT_AVAILABLE", message: "Selected assets are unavailable." } } })
      : route.fulfill({ json: { conversationId, message: "Review the required input and output limits.", recommendations: [cap], contractMatches: [match], inferenceStatus: "UNAVAILABLE" } });
  });
  expect((await page.goto("/agent"))?.status()).toBe(200);
  await page.getByText("Files & required deliverables (0 attached)", { exact: true }).click();
  await page.getByRole("button", { name: "Add output format" }).click(); await page.getByLabel("Extension 1", { exact: true }).fill("PDF");
  await page.getByRole("button", { name: "Add output format" }).click(); await page.getByLabel("Extension 2", { exact: true }).fill(".pdf");
  await page.getByLabel("Your request").fill("Prepare a document service.");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Combine duplicate output formats" })).toBeVisible(); expect(attempts).toBe(0);
  await page.getByRole("button", { name: "Remove output format 2", exact: true }).click();
  await page.getByLabel("File count 1", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Selected assets are unavailable" })).toBeVisible();
  await expect(page.getByLabel("Extension 1", { exact: true })).toHaveValue("PDF");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  const preparation = page.getByRole("region", { name: `Contract compatibility for ${cap.title}`, exact: true });
  await expect(preparation).toContainText("More input required"); await expect(preparation).toContainText("Render resolution: Provide the required input.");
  await expect(preparation).toContainText("do not guarantee the requested deliverables");
  await expect(preparation).toContainText("No job or payment has been authorized");
  await preparation.getByText("Prepared input values", { exact: true }).click();
  await expect(preparation.locator("pre")).toContainText("<img src=x onerror=alert(1)>");
  await expect(preparation.locator("img,script")).toHaveCount(0); expect(attempts).toBe(2);
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/agent-files-compatibility-fixture-${info.project.name}.png`, fullPage: true });
});

test("historical contract preparation stays pinned and does not invent labels from a newer version", async ({ page }, info) => {
  const user = await uiFixtureSession(page), cap = recommendationCapability("Versioned file service"), now = new Date().toISOString();
  cap.ioContract.inputs = [{ key: "resolution", label: "New version label", type: "SHORT_TEXT", required: true, order: 0 }];
  const match: AgentContractMatch = { capabilityId: cap.id, capabilityVersionId: crypto.randomUUID(), status: "NEEDS_INPUT", preparedInput: {}, appliedDefaults: [], assetOptions: [], issues: [{ code: "MISSING_INPUT", severity: "CLARIFICATION", inputKey: "resolution" }], output: { compatible: true, guaranteed: false, issues: [] } };
  await page.route("**/api/capabilities", route => route.fulfill({ json: [cap] }));
  await page.route("**/api/agent/conversations", route => route.fulfill({ json: [{ id: crypto.randomUUID(), userId: user.id, createdAt: now, messages: [
    { id: crypto.randomUUID(), role: "user", content: "Recorded file request", createdAt: now, inputAssetIds: [crypto.randomUUID()] },
    { id: crypto.randomUUID(), role: "assistant", content: "A saved contract comparison.", createdAt: now, capabilityIds: [cap.id], contractMatches: [match] },
  ] }] }));
  expect((await page.goto("/agent"))?.status()).toBe(200);
  await page.getByRole("button", { name: /^Recorded file request/ }).click();
  const preparation = page.getByRole("region", { name: `Contract compatibility for ${cap.title}`, exact: true });
  await expect(preparation).toContainText("earlier version"); await expect(preparation).toContainText("resolution: Provide the required input.");
  await expect(preparation).not.toContainText("New version label");
  await expect(page.getByText("Files & required deliverables (0 attached)", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/agent-files-history-fixture-${info.project.name}.png`, fullPage: true });
});
