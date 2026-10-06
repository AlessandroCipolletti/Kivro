import { test, expect } from "@playwright/test";
import { CapabilityDTOSchema, type CapabilityDTO } from "@kivro/contracts";
import { recommendationCapability } from "../tests/support/recommendations";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

test("public permission manifest separates granted data sources and read-only connectors without exposing private configuration", async ({ page }, info) => {
  await uiFixtureSession(page);
  const cap = recommendationCapability("Permission disclosure verification", crypto.randomUUID());
  cap.permissions.inference.credentialRef = "private-credential-reference";
  cap.permissions.resources = [{ id: "private_database_reference", type: "DATABASE", access: "READ_ONLY" }, { id: "private_file_reference", type: "LOCAL_FILE", access: "READ_ONLY" }];
  cap.permissions.tools = ["resource.query", "resource.read", "connector.call", "blender.render", "write"];
  cap.permissions.network = { mode: "CONNECTORS", allowedDomains: ["private-api.example.test"] };
  await page.route(`**/api/capabilities/${cap.id}`, route => route.fulfill({ json: CapabilityDTOSchema.parse(cap) }));
  await page.route(`**/api/capabilities/${cap.id}/reviews`, route => route.fulfill({ json: [] }));
  expect((await page.goto(`/capabilities/${cap.id}`))?.status()).toBe(200);
  await page.getByRole("tab", { name: "Permissions", exact: true }).click();
  const manifest = page.getByRole("region", { name: "Permission manifest", exact: true });
  const field = (key: string) => manifest.locator(`[data-permission="${key}"]`);
  await expect(field("database")).toContainText("Read-only queries to selected sources");
  await expect(field("local-files")).toContainText("Selected dataset only, read-only");
  await expect(field("private-api")).toContainText("Declared read-only connectors only");
  await expect(field("local-software")).toContainText("Blender rendering in the job sandbox");
  await expect(field("local-software")).not.toContainText("FFmpeg");
  for (const key of ["browser", "shell", "local-directories"]) await expect(field(key)).toContainText("Not available");
  await expect(field("external-actions")).toContainText("Not permitted: remote writes, messages or purchases");
  await expect(manifest.getByText(/not proof of local approval or current readiness/)).toBeVisible();
  const markup = await manifest.innerHTML();
  for (const secret of ["private_database_reference", "private_file_reference", "private-credential-reference", "private-api.example.test"]) expect(markup).not.toContain(secret);
  expect(markup).not.toContain("approved, read-only");
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/permissions-fixture-${info.project.name}.png`, fullPage: true });
});

test("permission summary distinguishes absent, incomplete and unsupported declarations without advertising new execution powers", async ({ page }, info) => {
  await uiFixtureSession(page);
  const cap: CapabilityDTO = recommendationCapability("Unsupported permission verification", crypto.randomUUID());
  cap.permissions.resources = [{ id: "private_database_reference", type: "DATABASE", access: "READ_ONLY" }, { id: "private_file_reference", type: "LOCAL_FILE", access: "READ_ONLY" }];
  cap.permissions.tools = [];
  await page.route(`**/api/capabilities/${cap.id}`, route => route.fulfill({ json: CapabilityDTOSchema.parse(cap) }));
  await page.route(`**/api/capabilities/${cap.id}/reviews`, route => route.fulfill({ json: [] }));
  await page.goto(`/capabilities/${cap.id}`);
  await page.getByRole("tab", { name: "Permissions", exact: true }).click();
  const manifest = page.getByRole("region", { name: "Permission manifest", exact: true });
  await expect(manifest.locator('[data-permission="database"]')).toHaveAttribute("data-state", "INCOMPLETE");
  await expect(manifest.locator('[data-permission="local-files"]')).toContainText("access tool not granted");
  await expect(manifest.locator('[data-permission="private-api"]')).toContainText("Not granted");
  await expect(manifest.locator('[data-permission="internet"]')).toContainText("No Internet tools granted");
  cap.permissions.tools = ["browser", "exec"];
  cap.permissions.resources = [{ id: "private_api_reference", type: "PRIVATE_API", access: "READ_ONLY" }, { id: "private_directory_reference", type: "LOCAL_DIRECTORY", access: "READ_ONLY" }];
  cap.availability = { status: "OFFLINE", canRunNow: false, canQueue: false, reason: "Unsupported permission declarations", nextAvailableAt: null };
  await page.reload();
  await page.getByRole("tab", { name: "Permissions", exact: true }).click();
  for (const key of ["browser", "shell", "private-api", "local-directories"]) {
    await expect(manifest.locator(`[data-permission="${key}"]`)).toHaveAttribute("data-state", "UNSUPPORTED");
    await expect(manifest.locator(`[data-permission="${key}"]`)).toContainText("blocked");
  }
  await expect(manifest.getByText(/cannot establish execution readiness/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Currently unavailable", exact: true })).toBeDisabled();
  expect(await manifest.innerHTML()).not.toMatch(/private_api_reference|private_directory_reference/);
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/permissions-unsupported-fixture-${info.project.name}.png`, fullPage: true });
});
