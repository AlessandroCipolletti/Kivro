import { test, expect } from "@playwright/test";
import { PRICE_TIERS, type CapabilityDTO } from "@kivro/contracts";
import type { JobReviewStatus } from "../src/lib/types";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

test("owner review creation, CAS edit conflict and refunded-job editing use owner status", async ({ page }, info) => {
  const user = await uiFixtureSession(page);
  const id = crypto.randomUUID(), capabilityId = crypto.randomUUID(), sellerId = crypto.randomUUID(), versionId = crypto.randomUUID(), now = new Date().toISOString();
  let status: JobReviewStatus = { jobId: id, capabilityId, capabilityVersionId: versionId, capabilityVersionNumber: 4, sellerId, eligible: true, canEdit: false, reason: null, review: null, policy: { editWindowDays: 30, editDeadlineAt: null } };
  let paymentState = "SETTLED", edits = 0;
  await page.route(`**/api/jobs/${id}`, route => route.fulfill({ json: { id, capabilityId, capabilityVersionId: versionId, capabilityVersionNumber: 4, capabilityTitle: "Review boundary job", buyerId: user.id, sellerId, state: "SUCCEEDED", paymentState, priceSnapshot: PRICE_TIERS[0], input: {}, output: { text: "Boundary result" }, events: [], createdAt: now, updatedAt: now, completedAt: now, scheduledAt: null, startedAt: now, error: null } }));
  await page.route(`**/api/jobs/${id}/review`, route => {
    if (route.request().method() === "GET") return route.fulfill({ json: status });
    const body = route.request().postDataJSON(); edits++;
    if (edits === 1) { expect(body.expectedReviewHash).toBe("a".repeat(64)); status = { ...status, review: { ...status.review!, comment: "Other tab's current comment", reviewHash: "b".repeat(64) } }; return route.fulfill({ status: 409, json: { error: { code: "REVIEW_CONFLICT", message: "Review changed; reload it." } } }); }
    expect(body).toMatchObject({ expectedReviewHash: "b".repeat(64), rating: 4, comment: "Updated after explicit reload." });
    status = { ...status, review: { ...status.review!, rating: body.rating, comment: body.comment, reviewHash: "c".repeat(64) } }; return route.fulfill({ json: status.review });
  });
  await page.route(`**/api/capabilities/${capabilityId}/reviews`, route => {
    expect(route.request().method()).toBe("POST"); expect(route.request().postDataJSON()).toEqual({ jobId: id, rating: 5, comment: "Initial verified feedback." });
    status = { ...status, eligible: false, canEdit: true, reason: "ALREADY_REVIEWED", policy: { editWindowDays: 30, editDeadlineAt: new Date(Date.now() + 86400000).toISOString() }, review: { id: crypto.randomUUID(), rating: 5, comment: "Initial verified feedback.", createdAt: now, reviewHash: "a".repeat(64) } };
    return route.fulfill({ json: status.review });
  });
  await page.goto(`/jobs/${id}`);
  await page.getByLabel("Comment (optional)").fill("Initial verified feedback.");
  await page.getByRole("button", { name: "Submit verified review" }).click();
  await expect(page.getByText("Your verified review has been submitted.")).toBeVisible();
  await page.getByRole("button", { name: "Edit your review" }).click();
  await page.getByLabel("Comment (optional)").fill("My stale draft must not overwrite another tab.");
  await page.getByRole("button", { name: "Save review changes" }).click();
  await expect(page.getByRole("button", { name: "Save review changes" })).toBeDisabled();
  await expect(page.getByLabel("Comment (optional)")).toHaveValue("My stale draft must not overwrite another tab.");
  await page.getByRole("button", { name: "Discard draft & reload review" }).click();
  await expect(page.getByText("Other tab's current comment", { exact: true })).toBeVisible();
  paymentState = "REFUNDED";
  await page.reload();
  await page.getByRole("button", { name: "Edit your review" }).click();
  await page.getByRole("radio", { name: "4 stars", exact: true }).check();
  await page.getByLabel("Comment (optional)").fill("Updated after explicit reload.");
  await page.getByRole("button", { name: "Save review changes" }).click();
  await expect(page.getByText("Your verified review has been updated.")).toBeVisible();
  await expect(page.getByText("Updated after explicit reload.", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/review-fixture-${info.project.name}.png`, fullPage: true });
});

test("public rating distribution preserves all five rating bins", async ({ page }) => {
  const catalog = await (await page.request.get("/api/capabilities")).json() as CapabilityDTO[];
  test.skip(!catalog.length, "A public capability is needed to inspect the review presentation.");
  const cap = catalog[0];
  await page.route(`**/api/capabilities/${cap.id}/reviews/summary`, route => route.fulfill({ json: { averageRating: 4.5, reviewCount: 2, distribution: [1,2,3,4,5].map(rating => ({ rating, count: rating >= 4 ? 1 : 0 })) } }));
  await page.goto(`/capabilities/${cap.id}`);
  await page.getByRole("tab", { name: /^Reviews/ }).click();
  await expect(page.getByRole("meter")).toHaveCount(5);
  await expect(page.getByRole("meter", { name: "1 stars: 0 reviews" })).toHaveAttribute("value", "0");
  await expect(page.getByText("4.5 / 5", { exact: true })).toBeVisible();
  await noOverflow(page);
});
