import { test, expect } from "@playwright/test";
import type { CapabilityDTO } from "@kivro/contracts";
import type { SynthesisPreview } from "../src/lib/types";
import { planFixture, planStepFixture } from "../tests/support/agent-plans";
import { register } from "./auth";

// Explicit synthesis-consent UI boundary; no live inference or paid jobs.
test("synthesis shares only selected sources and stale disclosure requires fresh consent", async ({ page }, info) => {
  const { user } = await register(page, "synthesis");
  const catalog = await (await page.request.get("/api/capabilities")).json() as CapabilityDTO[];
  test.skip(!catalog.length, "Requires one public definition for the UI boundary.");
  const cap = catalog[0], now = new Date().toISOString();
  const step = () => planStepFixture(cap, { status: "COMPLETED", jobId: crypto.randomUUID() });
  const plan = planFixture(user.id, [step(), step()], { revision: 5, goal: "Compare the completed provider outputs.", status: "COMPLETED" });
  const preview: SynthesisPreview = { planId: plan.id, revision: 5, available: true, processingDestinations: [{ provider: "test-provider", model: "boundary-model" }], sources: plan.steps.map(item => ({ stepId: item.id, jobId: item.jobId!, capabilityId: item.capabilityId, capabilityVersionId: item.capabilityVersionId, outputHash: "a".repeat(64), hasText: true, hasJson: false, fieldKeys: [], assets: [] })), sourceManifestHash: "a".repeat(64), fileContentsProcessed: false, maxContentBytes: 24000 };
  let posts = 0;
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { conversationId: crypto.randomUUID(), message: "Existing completed plan.", recommendations: [], inferenceStatus: "UNAVAILABLE", plan } }));
  await page.route(`**/api/agent/plans/${plan.id}`, route => route.fulfill({ json: plan }));
  await page.route(`**/api/agent/plans/${plan.id}/synthesis-preview`, route => route.fulfill({ json: preview }));
  await page.route(`**/api/agent/plans/${plan.id}/synthesize`, async route => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({ expectedRevision: 5, sourceManifestHash: posts === 1 ? "a".repeat(64) : "b".repeat(64), sourceJobIds: [plan.steps[0].jobId], consentToProviderProcessing: true });
    if (posts === 1) { preview.sourceManifestHash = "b".repeat(64); await route.fulfill({ status: 409, json: { error: { code: "SYNTHESIS_CONSENT_STALE", message: "Sources changed." } } }); return; }
    await route.fulfill({ json: { id: crypto.randomUUID(), kind: "AGENT_SYNTHESIS", planId: plan.id, planRevision: 5, message: "<img src=x onerror=alert(1)> Plain synthesis output.", createdAt: now, provider: preview.processingDestinations[0], sources: [preview.sources[0]], fileContentsProcessed: false, consent: { acceptedAt: now, sourceManifestHash: preview.sourceManifestHash, sourceJobIds: [plan.steps[0].jobId], processingDestinations: preview.processingDestinations } } });
  });
  await page.goto("/agent");
  await page.getByLabel("Your request").fill("Review this completed plan.");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  await page.getByRole("button", { name: "Review synthesis sources" }).click();
  await expect(page.getByText("test-provider / boundary-model", { exact: true })).toBeVisible();
  const source = page.getByRole("checkbox", { name: `Job ${plan.steps[0].jobId!.slice(0,8)}`, exact: false });
  const consent = page.getByRole("checkbox", { name: /I authorize the selected results/ });
  const submit = page.getByRole("button", { name: "Create agent synthesis" });
  await expect(source).not.toBeChecked(); await expect(submit).toBeDisabled();
  await source.check(); await expect(submit).toBeDisabled(); await consent.check(); await submit.click();
  await expect(page.getByText(/sources or processing providers changed/)).toBeVisible();
  await expect(source).not.toBeChecked(); await expect(consent).not.toBeChecked(); expect(posts).toBe(1);
  await source.check(); await consent.check(); await submit.click();
  await expect(page.getByRole("heading", { name: "Marketplace agent synthesis", exact: true })).toBeVisible();
  await expect(page.locator(".synthesis-result img")).toHaveCount(0);
  await page.getByText("Sources & processing consent", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Original provider output" })).toHaveAttribute("href", `/jobs/${plan.steps[0].jobId}`);
  expect(posts).toBe(2); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `apps/web/verification/synthesis-fixture-${info.project.name}.png`, fullPage: true });
});
