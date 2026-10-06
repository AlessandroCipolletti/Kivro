import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InputField } from "@kivro/contracts";
import { JobInputs } from "../src/components/job-inputs";

const fields: InputField[] = [
  { key: "count", label: "Purchased count", type: "INTEGER", required: true, order: 1, constraints: { minimum: 0, maximum: 10 } },
  { key: "consent", label: "Purchased consent", type: "BOOLEAN", required: true, order: 0 },
  { key: "choice", label: "Purchased choice", type: "SELECT", required: false, order: 2, default: "Never infer this", constraints: { allowedValues: ["Never infer this"] } },
];
describe("purchased input history", () => {
  it("uses pinned labels, order and constraints without dropping false or zero", () => {
    const html = renderToStaticMarkup(React.createElement(JobInputs, { input: { count: 0, consent: false }, contract: fields }));
    expect(html.indexOf("<h3>Purchased consent")).toBeLessThan(html.indexOf("<h3>Purchased count"));
    expect(html).toContain("<p>No</p>"); expect(html).toContain('<p class="prewrap">0</p>');
    expect(html).toContain("<dt>Minimum value</dt><dd>0</dd>"); expect(html).toContain("<dt>Maximum value</dt><dd>10</dd>");
    expect(html).toContain("Not supplied."); expect(html).not.toContain('<p class="prewrap">Never infer this</p>');
  });
  it("preserves legacy and additional values as escaped text without guessing current contracts", () => {
    const input = { extra: "<script>unsafe</script>" };
    const legacy = renderToStaticMarkup(React.createElement(JobInputs, { input }));
    expect(legacy).toContain("contract was not recorded"); expect(legacy).not.toContain("<script>");
    const named = renderToStaticMarkup(React.createElement(JobInputs, { input, contract: fields }));
    expect(named).toContain("Additional submitted values"); expect(named).toContain("&lt;script&gt;");
  });
  it("shows exact file and schema restrictions without advertising new uploads", () => {
    const contract: InputField[] = [{ key: "source", label: "Purchased source", type: "FILE", required: true, order: 0, constraints: { allowedExtensions: [".txt"], allowedMimeTypes: ["text/plain"], maxFileSizeBytes: 1024, maxTotalSizeBytes: 2048 } }, { key: "metadata", label: "Metadata", type: "JSON", required: false, order: 1, constraints: { jsonSchema: { type: "object" } }, visibleWhen: { key: "source", equals: "old-id" } }];
    const html = renderToStaticMarkup(React.createElement(JobInputs, { input: { source: "old-id" }, contract }));
    expect(html).toContain("Maximum bytes per file</dt><dd>1024"); expect(html).toContain("Allowed extensions</dt><dd>.txt");
    expect(html).toContain("JSON Schema"); expect(html).toContain("Purchased source equals old-id");
    expect(html).not.toContain('type="file"');
  });
});
