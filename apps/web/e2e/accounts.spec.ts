import { test, expect, type Page } from "@playwright/test";
import { register } from "./auth";

async function mailLink(page: Page, recipient: string, path: string): Promise<string> {
  let result: string | undefined;
  await expect.poll(async () => {
    const search = await page.request.get(`http://127.0.0.1:58025/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`);
    expect(search.ok()).toBe(true);
    const messages = (await search.json()).messages as { ID: string }[];
    for (const message of messages) {
      const response = await page.request.get(`http://127.0.0.1:58025/api/v1/message/${message.ID}`);
      if (!response.ok()) continue;
      const text = (await response.json()).Text as string;
      const match = text.match(/https?:\/\/[^\s<>]+#token=[A-Za-z0-9_-]+/g)?.find(url => new URL(url).pathname === path);
      if (match) { result = match; return true; }
    }
    return false;
  }, { timeout: 45_000, message: "Only the synthetic account's message should arrive in local Mailpit" }).toBe(true);
  return result!;
}

test("real profile, email verification, SMTP password recovery and session revocation", async ({ page }, info) => {
  const account = await register(page, "recovery");
  expect((await page.goto("/settings"))?.status()).toBe(200);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Updated verification account");
  await page.getByLabel("Public seller bio").fill("Synthetic profile verified through the account API.");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
  const verificationRequested = page.waitForResponse(response => response.url().endsWith("/api/auth/email-verification/request") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send verification email" }).click();
  const verificationResponse = await verificationRequested;
  expect(verificationResponse.status(), await verificationResponse.text()).toBe(200);
  const verificationLink = await mailLink(page, account.email, "/auth/verify-email");
  let confirmations = 0;
  page.on("request", request => { if (/\/auth\/(email-verification|password-reset)\/confirm$/.test(request.url()) && request.method() === "POST") confirmations++; });
  expect((await page.goto(verificationLink))?.status()).toBe(200);
  await expect(page).toHaveURL(/\/auth\/verify-email$/);
  expect(confirmations).toBe(0);
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByText("Your email address has been verified.")).toBeVisible();
  const me = await (await page.request.get("/api/auth/me")).json();
  expect(me.user).toMatchObject({ name: "Updated verification account", bio: "Synthetic profile verified through the account API." });
  expect(me.user.emailVerifiedAt).toBeTruthy();
  await page.goto("/settings");
  await expect(page.getByText("Email verified", { exact: true })).toBeVisible();
  const keyResponse = await page.request.post("/api/api-keys", { headers: account.headers, data: { name: "Recovery revocation probe", scopes: ["jobs:read"] } });
  expect(keyResponse.ok(), await keyResponse.text()).toBe(true);
  const keyId = (await keyResponse.json()).id as string;
  const logout = await page.request.post("/api/auth/logout", { headers: account.headers });
  expect(logout.ok(), await logout.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Account email").fill(account.email);
  const resetRequested = page.waitForResponse(response => response.url().endsWith("/api/auth/password-reset/request") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send reset link" }).click();
  const resetResponse = await resetRequested;
  expect(resetResponse.status(), await resetResponse.text()).toBe(200);
  const resetLink = await mailLink(page, account.email, "/auth/reset-password");
  const before = confirmations;
  await page.goto(resetLink);
  await expect(page).toHaveURL(/\/auth\/reset-password$/);
  expect(confirmations).toBe(before);
  const password = `replacement-${crypto.randomUUID()}`;
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByText(/Your password has been reset/)).toBeVisible();
  expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
  await page.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByRole("dialog").getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const keys = await (await page.request.get("/api/api-keys")).json() as { id: string; revokedAt: string | null }[];
  expect(keys.find(key => key.id === keyId)?.revokedAt).toBeTruthy();
  const beforeReuse = confirmations;
  await page.goto(resetLink);
  await expect(page).toHaveURL(/\/auth\/reset-password$/);
  expect(confirmations).toBe(beforeReuse);
  await page.getByLabel("New password", { exact: true }).fill(`another-${crypto.randomUUID()}`);
  const samePassword = await page.getByLabel("New password", { exact: true }).inputValue();
  await page.getByLabel("Confirm new password", { exact: true }).fill(samePassword);
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.locator('[role="alert"]')).toBeVisible();
  await page.getByRole("button", { name: "Request a new link" }).click();
  await expect(page.getByLabel("Account email")).toBeVisible();
  await page.screenshot({ path: `apps/web/verification/recovery-${info.project.name}.png`, fullPage: true });
});

test("registration requires unchecked current terms and the terms route displays server text", async ({ page }, info) => {
  const terms = await (await page.request.get("/api/terms")).json();
  expect((await page.goto("/terms"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Terms", exact: true })).toBeVisible();
  await expect(page.locator(".legal-document .prose")).toHaveText(terms.text);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create account", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Terms verification");
  await dialog.getByLabel("Email", { exact: true }).fill(`terms-${crypto.randomUUID()}@example.test`);
  await dialog.getByLabel("Password", { exact: true }).fill(`test-only-${crypto.randomUUID()}`);
  const checkbox = dialog.getByRole("checkbox", { name: /I have read and accept/ });
  await expect(checkbox).not.toBeChecked();
  const submit = dialog.locator('button[type="submit"]');
  await expect(submit).toBeDisabled();
  await checkbox.check();
  const registration = page.waitForResponse(response => response.url().endsWith("/api/auth/register") && response.request().method() === "POST");
  await submit.click();
  const response = await registration; expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().acceptedTermsVersion).toBe(terms.version);
  expect((await response.json()).user.termsAcceptedVersion).toBe(terms.version);
  await expect(dialog).toHaveCount(0);
  await page.screenshot({ path: `apps/web/verification/terms-${info.project.name}.png`, fullPage: true });
});
