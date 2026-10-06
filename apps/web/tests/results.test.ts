import { describe, expect, it } from "vitest";
import type { AssetDTO, OutputContract } from "@kivro/contracts";
import { extraResultFields, fieldAssets, namedResultFields, resultHref } from "../src/lib/results";

const assets: AssetDTO[] = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 100, sha256: "a".repeat(64) }];
describe("typed delivered results", () => {
  it("uses pinned field order and retains false, zero, optional absence and additional values", () => {
    const contract: OutputContract = { type: "TEXT", description: "Result", required: true, fields: [
      { key: "ok", label: "Approved", type: "BOOLEAN", required: true, order: 1 },
      { key: "count", label: "Count", type: "NUMBER", required: true, order: 0 },
      { key: "note", label: "Note", type: "SHORT_TEXT", required: false, order: 2 },
    ] };
    const output = { fields: { ok: false, count: 0, extra: "retained" } };
    expect(namedResultFields(output, contract).map(item => [item.field.key, item.value, item.present])).toEqual([["count", 0, true], ["ok", false, true], ["note", undefined, false]]);
    expect(extraResultFields(output, contract)).toEqual({ extra: "retained" });
    expect(namedResultFields(output)).toEqual([]);
    expect(extraResultFields(output)).toEqual(output.fields);
  });
  it("resolves only declared output assets, never model-chosen URLs or paths", () => {
    expect(fieldAssets(assets[0].id, assets, false)).toEqual({ assets, missing: false });
    expect(fieldAssets([assets[0].id, "/private/file"], assets, true)).toEqual({ assets, missing: true });
    expect(fieldAssets("https://tracker.example/file", assets, false)).toEqual({ assets: [], missing: true });
    expect(fieldAssets({ id: assets[0].id }, assets, false)).toEqual({ assets: [], missing: true });
  });
  it("rejects active, credential-bearing, relative and undeclared asset links", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "//tracker.example", "/settings", "/api/assets/other/download", "https://user:secret@example.com", "https://example.com/\npath"]) expect(resultHref(value, assets)).toBeUndefined();
    expect(resultHref("https://example.com/report")).toBe("https://example.com/report");
    expect(resultHref("#user-content-note-1")).toBe("#user-content-note-1");
    expect(resultHref(`/api/assets/${assets[0].id}/download`, assets)).toBe(`/api/assets/${assets[0].id}/download`);
  });
});
