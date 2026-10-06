import { test, expect } from "@playwright/test";
import { recommendationCapability, recommendationDetail } from "../tests/support/recommendations";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

test("agent request preferences remain soft ordered choices and online-only clears queue and scheduling consent", async ({ page }, info) => {
  await uiFixtureSession(page);
  const first = recommendationCapability("Document research alpha"), second = recommendationCapability("Document research beta", "b0000000-0000-4000-8000-000000000004"), third = recommendationCapability("Document research gamma", "b0000000-0000-4000-8000-000000000005");
  second.versionId = "b0000000-0000-4000-8000-000000000006";
  const detail = recommendationDetail(second);
  detail.limitations.push('<img src="https://untrusted.invalid/tracker" onerror="alert(1)">');
  await page.route("**/api/capabilities", route => route.fulfill({ json: [first, second, third] }));
  await page.route("**/api/agent/conversations", route => route.fulfill({ json: [] }));
  let firstPageFails = true;
  await page.route("**/api/capabilities/page?*", route => {
    const query = new URL(route.request().url()).searchParams;
    if (firstPageFails) { firstPageFails = false; return route.fulfill({ status: 503, json: { error: { code: "SEARCH_UNAVAILABLE", message: "Preferred search temporarily unavailable." } } }); }
    const items = query.get("q") === "unmatched" ? [] : query.has("cursor") ? [third] : [first, second];
    return route.fulfill({ json: { items, total: items.length ? 3 : 0, nextCursor: !query.get("q") && !query.has("cursor") ? "second-page" : null } });
  });
  let chats = 0;
  await page.route("**/api/agent/chat", route => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ preferredCapabilityIds: [second.id, third.id], onlineOnly: true, timingMode: "IMMEDIATE", maxQueueWaitSeconds: 0, allowScheduling: false, budgetMinor: 200, maxPerJobSpendMinor: 99, maxJobs: 2, noNetwork: true });
    expect(body).not.toHaveProperty("deadlineAt"); chats++;
    return route.fulfill({ json: { conversationId: crypto.randomUUID(), message: "Current catalog matches, with recorded constraints and facts.", recommendations: [second], recommendationDetails: [detail], inferenceStatus: "READY" } });
  });
  expect((await page.goto("/agent"))?.status()).toBe(200);
  await page.getByText("Budget, service & privacy limits", { exact: true }).click();
  await page.getByLabel("Maximum budget (USD)").fill("2.00");
  await page.getByLabel("Maximum per job (USD)").fill("0.99");
  await page.getByLabel("Maximum paid jobs").fill("2");
  await page.getByLabel("Maximum queue wait").selectOption("300");
  await page.getByLabel("Only services without network access").check();
  await page.getByLabel("Execution timing").selectOption("EARLIEST_AVAILABLE_ALLOWED");
  const scheduling = page.getByLabel(/I allow this request to include services scheduled/);
  await scheduling.check();
  await page.getByLabel("Only online services ready now").check();
  await expect(page.getByLabel("Execution timing")).toHaveValue("IMMEDIATE");
  await expect(page.getByLabel("Execution timing")).toBeDisabled();
  await expect(page.getByLabel("Maximum queue wait")).toHaveValue("0");
  await expect(page.getByLabel("Maximum queue wait")).toBeDisabled();
  await expect(scheduling).toHaveCount(0);
  await page.getByLabel("Only online services ready now").uncheck();
  await page.getByLabel("Execution timing").selectOption("EARLIEST_AVAILABLE_ALLOWED");
  await expect(scheduling).not.toBeChecked();
  await page.getByLabel("Only online services ready now").check();
  await page.getByText("Preferred capabilities (0)", { exact: true }).click();
  const picker = page.locator(".preferred-capabilities");
  await expect(picker.getByRole("alert")).toContainText("Preferred search temporarily unavailable.");
  await picker.getByRole("button", { name: "Try again", exact: true }).click();
  await picker.getByRole("checkbox", { name: new RegExp(first.title) }).check();
  await picker.getByRole("checkbox", { name: new RegExp(second.title) }).check();
  await picker.getByRole("button", { name: `Move ${second.title} up`, exact: true }).click();
  await expect(picker.locator(".preferred-selection a").first()).toHaveText(second.title);
  await picker.getByRole("button", { name: "Next", exact: true }).click();
  await picker.getByRole("checkbox", { name: new RegExp(third.title) }).check();
  await picker.getByRole("button", { name: `Remove preference ${first.title}`, exact: true }).click();
  await picker.getByLabel("Find preferred capabilities").fill("unmatched");
  await expect(picker.getByText("No matching capabilities.", { exact: true })).toBeVisible();
  await expect(picker.locator(".preferred-selection a")).toHaveText([second.title, third.title]);
  await page.getByLabel("Your request").fill("Find document research.");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  const reason = page.getByRole("region", { name: `Selection explanation for ${second.title}`, exact: true });
  await expect(reason.getByRole("heading", { name: "Why selected" })).toBeVisible();
  await expect(reason).toContainText(detail.reason);
  await expect(reason).toContainText("$0.99 USD per job");
  await expect(reason).toContainText("Not rated (0 reviews)");
  await expect(reason).toContainText("estimated runtime 60 seconds");
  await expect(reason).toContainText("PDF file output is not declared");
  await expect(reason).toContainText("Not an execution quote or reserved slot");
  await expect(reason.locator("img,script")).toHaveCount(0);
  expect(chats).toBe(1);
  await page.getByText("Budget, service & privacy limits", { exact: true }).click();
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/agent-recommendation-fixture-${info.project.name}.png`, fullPage: true });
});

test("saved recommendations distinguish current versions, unavailable listings and missing legacy explanations", async ({ page }, info) => {
  const user = await uiFixtureSession(page);
  const current = recommendationCapability("Changed document service"), legacy = recommendationCapability("Legacy recommendation", "b0000000-0000-4000-8000-000000000004"), unavailable = recommendationCapability("Archived service", "b0000000-0000-4000-8000-000000000005");
  const recorded = recommendationDetail(current), archived = recommendationDetail(unavailable);
  current.versionId = "b0000000-0000-4000-8000-000000000007"; current.version = 2;
  const message = (role: "user" | "assistant", content: string) => ({ id: crypto.randomUUID(), role, content, createdAt: recorded.generatedAt });
  const messages = [{ ...message("assistant", "Saved comparison."), capabilityIds: [current.id, unavailable.id], recommendationDetails: [recorded, archived] }];
  await page.route("**/api/capabilities", route => route.fulfill({ json: [current, legacy] }));
  await page.route("**/api/agent/conversations", route => route.fulfill({ json: [
    { id: crypto.randomUUID(), userId: user.id, createdAt: recorded.generatedAt, messages: [message("user", "Recorded comparison"), ...messages] },
    { id: crypto.randomUUID(), userId: user.id, createdAt: recorded.generatedAt, messages: [message("user", "Legacy request"), { ...message("assistant", "Legacy service match."), capabilityIds: [legacy.id] }] },
    { id: crypto.randomUUID(), userId: user.id, createdAt: recorded.generatedAt, messages: [message("user", "Latest no matches"), ...messages, { ...message("assistant", "No matches now."), capabilityIds: [], recommendationDetails: [] }] },
  ] }));
  expect((await page.goto("/agent"))?.status()).toBe(200);
  await page.getByRole("button", { name: /^Recorded comparison/ }).click();
  await expect(page.getByRole("heading", { name: "Saved recommendations" })).toBeVisible();
  const changed = page.getByRole("region", { name: `Selection explanation for ${current.title}` });
  await expect(changed).toContainText("earlier version, not the current listing");
  await expect(changed).toContainText(recorded.capabilityVersionId);
  const removed = page.getByRole("region", { name: `Selection explanation for ${unavailable.title}` });
  await expect(removed).toContainText("No current listing is loaded");
  await expect(page.getByRole("link", { name: unavailable.title, exact: true })).toHaveAttribute("href", `/capabilities/${unavailable.id}`);
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/agent-history-fixture-${info.project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: /^Legacy request/ }).click();
  await expect(page.getByText("No selection explanation was recorded for this result.", { exact: true })).toBeVisible();
  await expect(page.locator(".recommendation-rationale .notice.warning")).toHaveCount(0);
  await page.getByRole("button", { name: /^Latest no matches/ }).click();
  await expect(page.getByRole("heading", { name: "Saved recommendations" })).toHaveCount(0);
  await expect(page.locator(".agent-recommendations .capability-card")).toHaveCount(0);
});
