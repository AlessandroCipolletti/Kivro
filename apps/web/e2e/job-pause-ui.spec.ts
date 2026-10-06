import { test, expect } from "@playwright/test";
import { PRICE_TIERS, type JobDTO } from "@kivro/contracts";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

test("seller pause and resume disclose one cumulative purchased budget without resetting prior usage", async ({ page }, info) => {
  const user = await uiFixtureSession(page);
  const now = "2026-10-06T14:00:00Z";
  await page.clock.setFixedTime(new Date(now));
  const job: JobDTO = {
    id: crypto.randomUUID(), capabilityId: crypto.randomUUID(), capabilityVersionId: crypto.randomUUID(),
    capabilityTitle: "Cumulative pause boundary", buyerId: crypto.randomUUID(), sellerId: user.id,
    state: "ACCEPTED", paymentState: "RESERVED", priceSnapshot: PRICE_TIERS[0], input: {}, output: null,
    createdAt: now, updatedAt: now, startedAt: now, completedAt: null, scheduledAt: null, error: null,
    pauseSupport: "FULL_RESUME", maxPauseMs: 900000, pausedDurationMs: 120000, pausedAt: null, events: [],
  };
  let pauses = 0, resumes = 0, securityBlocked = false;
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: job }));
  await page.route(`**/api/jobs/${job.id}/pause`, route => {
    expect(route.request().method()).toBe("POST"); pauses++; job.state = "PAUSE_REQUESTED";
    return route.fulfill({ json: job });
  });
  await page.route(`**/api/jobs/${job.id}/resume`, route => {
    expect(route.request().method()).toBe("POST"); resumes++;
    if (securityBlocked) return route.fulfill({ status: 409, json: { error: { code: "RESUME_BLOCKED", message: "Security block. Resume is not allowed." } } });
    if (resumes === 1) {
      expect(route.request().postData()).toBeNull();
      return route.fulfill({ status: 409, json: { error: { code: "GLOBAL_PAUSE_CONFIRMATION_REQUIRED", message: "Worker paused for new jobs." } } });
    }
    expect(route.request().postDataJSON()).toEqual({ confirmGlobalPause: true });
    job.state = "RUNNING"; job.pausedDurationMs = 180000; job.pausedAt = null;
    return route.fulfill({ json: job });
  });
  expect((await page.goto(`/jobs/${job.id}`))?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Cancel job", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause job", exact: true })).toHaveCount(0);
  job.state = "RUNNING";
  await page.reload();
  const budget = page.getByLabel("Job pause budget", { exact: true });
  await expect(budget).toContainText("15 min for the entire job, shared across all pauses");
  await expect(budget).toContainText("Recorded total used: 2 min; remaining: 13 min");
  await page.getByRole("button", { name: "Pause job", exact: true }).click();
  const pause = page.getByRole("dialog", { name: "Pause this job?" });
  await expect(pause).toContainText("Resuming does not reset it");
  await expect(pause).toContainText("Recorded total used: 2 min; remaining: 13 min");
  expect(pauses).toBe(0);
  await pause.getByRole("button", { name: "Request pause", exact: true }).click();
  await expect(page.getByText("Pause requested. Waiting for the worker to confirm that execution is paused.", { exact: true })).toBeVisible();
  expect(pauses).toBe(1);
  job.state = "PAUSED"; job.pausedAt = "2026-10-06T13:59:00Z";
  await page.reload();
  await expect(budget).toContainText("Estimated total used: 3 min; estimated remaining: 12 min");
  await expect(budget).toContainText("Includes the current pause; the server clock determines enforcement");
  await page.getByRole("button", { name: "Resume job", exact: true }).click();
  const resume = page.getByRole("dialog", { name: "Resume this job?" });
  await expect(resume).toContainText("3 min; estimated remaining: 12 min");
  expect(resumes).toBe(0);
  await page.screenshot({ path: `apps/web/verification/job-pause-fixture-${info.project.name}.png` });
  await resume.getByRole("button", { name: "Resume job", exact: true }).click();
  const override = page.getByRole("dialog", { name: "Worker paused for new jobs. Resume this existing job?", exact: true });
  await expect(override).toContainText("worker remains paused for new jobs");
  await expect(override).toContainText("does not override schedule or security restrictions");
  expect(resumes).toBe(1);
  await page.screenshot({ path: `apps/web/verification/job-global-pause-fixture-${info.project.name}.png` });
  await override.getByRole("button", { name: "Resume existing job", exact: true }).click();
  await expect(budget).toContainText("Recorded total used: 3 min; remaining: 12 min");
  expect(resumes).toBe(2);
  await noOverflow(page);
  job.state = "PAUSED"; securityBlocked = true;
  await page.reload();
  await page.getByRole("button", { name: "Resume job", exact: true }).click();
  await page.getByRole("dialog", { name: "Resume this job?", exact: true }).getByRole("button", { name: "Resume job", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Security block. Resume is not allowed.");
  await expect(page.getByRole("button", { name: "Resume existing job", exact: true })).toHaveCount(0);
  expect(resumes).toBe(3);
  await page.getByRole("button", { name: "Keep as is", exact: true }).click();
  delete job.maxPauseMs; delete job.pausedDurationMs;
  await page.reload();
  await expect(budget).toContainText("limit was not supplied");
  await expect(budget).not.toContainText("15 min");
});
