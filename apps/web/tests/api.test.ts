import { afterEach, describe, expect, it, vi } from "vitest";
import { api, clearPurchaseKey, post, purchaseKey } from "../src/lib/api";
import { recommendationCapability } from "./support/recommendations";

afterEach(() => vi.unstubAllGlobals());
describe("same-origin API boundary", () => {
  it("consumes direct DTO arrays and always includes cookie credentials", async () => {
    const capabilities = [recommendationCapability()];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(capabilities), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await api("/capabilities")).toEqual(capabilities);
    expect(fetch).toHaveBeenCalledWith("/api/capabilities", expect.objectContaining({ credentials: "include", cache: "no-store" }));
  });
  it("surfaces the structured API error instead of swallowing an unavailable action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "QUOTE_EXPIRED", message: "Refresh your quote." } }), { status: 409 })));
    await expect(post("/jobs", {})).rejects.toMatchObject({ status: 409, code: "QUOTE_EXPIRED", message: "Refresh your quote." });
  });
  it("protects same-payload retries even when session storage is disabled", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("denied"); }, removeItem: () => undefined });
    const payload = { capabilityId: "abc", input: { secret: "sensitive" } };
    const first = purchaseKey("test-job", payload);
    expect(purchaseKey("test-job", payload)).toBe(first);
    expect(purchaseKey("test-job", { ...payload, capabilityId: "different" })).not.toBe(first);
    clearPurchaseKey("test-job");
    expect(purchaseKey("test-job", payload)).not.toBe(first);
  });
  it("stores only a fingerprint and key, not confidential input text", () => {
    const setItem = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem, removeItem: () => undefined });
    purchaseKey("test-private", { input: "confidential customer material" });
    expect(setItem.mock.calls[0][1]).not.toContain("confidential");
    expect(JSON.parse(setItem.mock.calls[0][1]).fingerprint).toMatch(/^[a-f0-9]{64}$/);
    clearPurchaseKey("test-private");
  });
});
