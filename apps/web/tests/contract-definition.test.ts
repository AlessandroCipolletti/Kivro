import { describe, expect, it } from "vitest";
import type { IOContract } from "@kivro/contracts";
import { contractDefinitionError, isVisible, prepareInput } from "../src/lib/forms";

const base: IOContract = { schemaVersion: 1, inputs: [], output: { type: "TEXT", description: "Summary", required: true } };
describe("seller contract definition feedback", () => {
  it("accepts independent Markdown output fields", () => {
    expect(contractDefinitionError({ ...base, output: { ...base.output, fields: [{ key: "summary", label: "Summary", type: "MARKDOWN", order: 0, required: true }] } })).toBeUndefined();
  });
  it("surfaces unsafe schema and incompatible defaults", () => {
    expect(contractDefinitionError({ ...base, output: { ...base.output, type: "JSON", jsonSchema: { type: "string", pattern: "(a+)+$" } } })).toContain("regular expressions");
    expect(contractDefinitionError({ ...base, inputs: [{ key: "count", label: "Count", type: "INTEGER", required: true, order: 0, default: "not-a-number" }] })).toContain("count");
  });
  it("requires a file envelope for named file outputs", () => {
    expect(contractDefinitionError({ ...base, output: { ...base.output, fields: [{ key: "report", label: "Report", type: "FILE", order: 0, required: true, constraints: { allowedMimeTypes: ["text/plain"], allowedExtensions: [".txt"], maxFileSizeBytes: 1024 } }] } })).toContain("file-capable");
  });
  it("prunes a nested field when its controller is itself hidden", () => {
    const contract: IOContract = { ...base, inputs: [
      { key: "enabled", label: "Enabled", type: "BOOLEAN", required: true, order: 0 },
      { key: "mode", label: "Mode", type: "SHORT_TEXT", required: false, order: 1, visibleWhen: { key: "enabled", equals: true } },
      { key: "detail", label: "Detail", type: "SHORT_TEXT", required: false, order: 2, visibleWhen: { key: "mode", equals: "detailed" } },
    ] };
    const values = { enabled: false, mode: "detailed", detail: "Stale hidden input" };
    expect(isVisible(contract.inputs[2], values, contract.inputs)).toBe(false);
    expect(prepareInput(contract, values)).toEqual({ enabled: false });
  });
});
