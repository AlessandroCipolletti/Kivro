import { describe, expect, it } from "vitest";
import type { AssetDTO, IOContract } from "@kivro/contracts";
import { checkFiles, fieldErrors, initialInput, prepareInput } from "../src/lib/forms";
import { decimalToMinor } from "../src/lib/format";

const contract: IOContract = { schemaVersion: 1, inputs: [
  { key: "mode", label: "Mode", type: "SELECT", required: true, order: 0, default: "text", constraints: { allowedValues: ["text", "structured"] } },
  { key: "question", label: "Question", type: "LONG_TEXT", required: true, order: 1, constraints: { minLength: 3, maxLength: 100 } },
  { key: "options", label: "Options", type: "JSON", required: true, order: 2, visibleWhen: { key: "mode", equals: "structured" } },
  { key: "document", label: "Document", type: "FILE", required: false, order: 3, constraints: { allowedExtensions: [".pdf"], allowedMimeTypes: ["application/pdf"], maxFileSizeBytes: 1024, maxTotalSizeBytes: 1024 } }
], output: { type: "TEXT", description: "Report", required: true } };
const asset: AssetDTO = { id: "1e8b8df4-0c15-4292-a745-8d8154fd8d94", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 600, sha256: "0".repeat(64) };

describe("contract-driven buyer input", () => {
  it("prefills only scalar examples and defaults, never inherited file references", () => {
    expect(initialInput(contract, { question: "Compare companies", document: asset.id })).toEqual({ mode: "text", question: "Compare companies" });
  });
  it("removes inactive fields and validates against the shared contract", () => {
    expect(prepareInput(contract, { mode: "text", question: "Research this", options: "not JSON" }, [])).toEqual({ mode: "text", question: "Research this" });
  });
  it("parses structured input only when active", () => {
    expect(prepareInput(contract, { mode: "structured", question: "Research this", options: '{"depth":3}' }, []).options).toEqual({ depth: 3 });
  });
  it("maps JSON and contract errors to specific form fields", () => {
    try { prepareInput(contract, { mode: "structured", question: "Research this", options: "broken" }); throw new Error("expected error"); }
    catch (error) { expect(fieldErrors(error)).toEqual({ options: "Enter valid JSON." }); }
  });
  it("validates uploaded IDs against actual metadata", () => {
    expect(prepareInput(contract, { mode: "text", question: "Review document", document: asset.id }, [asset]).document).toBe(asset.id);
    expect(() => prepareInput(contract, { mode: "text", question: "Review document", document: asset.id }, [])).toThrow();
  });
  it("rejects excess cardinality, file sizes and misleading extensions before upload", () => {
    const field = contract.inputs[3];
    expect(() => checkFiles(field, [{ name: "large.pdf", size: 2048, type: "application/pdf" }])).toThrow();
    expect(() => checkFiles(field, [{ name: "report.exe", size: 100, type: "application/pdf" }])).toThrow();
    expect(() => checkFiles(field, [{ name: "another.pdf", size: 100, type: "application/pdf" }], [asset])).toThrow();
    expect(() => checkFiles(field, [{ name: "report.pdf", size: 100, type: "application/x-executable" }])).toThrow();
  });
});
describe("money input", () => {
  it("converts decimal text to exact minor units without fractional cents", () => {
    expect(decimalToMinor("0.99")).toBe(99);
    expect(decimalToMinor("99.99")).toBe(9999);
    expect(decimalToMinor("20")).toBe(2000);
    expect(decimalToMinor("2.9")).toBe(290);
    expect(decimalToMinor("0.999")).toBeNull();
    expect(decimalToMinor("1e4")).toBeNull();
    expect(decimalToMinor("-10")).toBeNull();
  });
});
