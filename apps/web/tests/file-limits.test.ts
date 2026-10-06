import { describe, expect, it } from "vitest";
import { effectiveInputField } from "../src/lib/file-limits";
import type { InputField } from "../src/lib/types";

describe("effective execution file constraints", () => {
  it("lowers display limits without changing the frozen contract or raising seller limits", () => {
    const field: InputField = { key: "files", type: "FILES", label: "Files", required: true, order: 0, constraints: { maxFileSizeBytes: 100, maxTotalSizeBytes: 1000 } };
    expect(effectiveInputField(field, { singleFileBytes: 80, inputBytes: 900, outputBytes: 900 }).constraints).toMatchObject({ maxFileSizeBytes: 80, maxTotalSizeBytes: 900 });
    expect(effectiveInputField(field, { singleFileBytes: 200, inputBytes: 2000, outputBytes: 2000 }).constraints).toEqual(field.constraints);
    expect(field.constraints).toEqual({ maxFileSizeBytes: 100, maxTotalSizeBytes: 1000 });
  });
  it("bounds legacy file definitions by reviewed Worker ceilings without inventing a deployed limit", () => {
    const field: InputField = { key: "files", type: "FILES", label: "Files", required: true, order: 0 };
    expect(effectiveInputField(field).constraints).toEqual({ maxFileSizeBytes: 8 * 1024 ** 2, maxTotalSizeBytes: 16 * 1024 ** 2 });
    expect(effectiveInputField({ ...field, type: "SHORT_TEXT" })).toEqual({ ...field, type: "SHORT_TEXT" });
  });
});
