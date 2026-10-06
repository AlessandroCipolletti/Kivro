import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssetDTO, IOContract } from "@kivro/contracts";
import { exampleAssetUrl, exampleOutput, exampleTemplateValues, prepareExampleOutput, publicationAssets, publicationConsent } from "../src/lib/examples";
import { JobResult, SafeMarkdown } from "../src/components/job-result";

const capabilityId = crypto.randomUUID(), versionId = crypto.randomUUID(), id = crypto.randomUUID();
const asset: AssetDTO = { id, filename: "sample.txt", mimeType: "text/plain", sizeBytes: 8, sha256: "a".repeat(64) };
const limits = { allowedExtensions: [".txt"], allowedMimeTypes: ["text/plain"], maxFiles: 2, maxTotalSizeBytes: 1024 };
const contract: IOContract = { schemaVersion: 1, inputs: [{ key: "title", label: "Title", type: "SHORT_TEXT", required: true, order: 0 }, { key: "source", label: "Source", type: "FILE", required: false, order: 1, constraints: { ...limits, maxFileSizeBytes: 1024 } }], output: { type: "FILES", description: "Named delivery", required: true, files: limits, fields: [{ key: "result", label: "Result", type: "FILE", required: true, order: 0, constraints: { ...limits, maxFileSizeBytes: 1024 } }, { key: "notes", label: "Notes", type: "MARKDOWN", required: true, order: 1 }] } };

describe("version-bound examples and explicit file consent", () => {
  it("accepts only the supplied current public example URL, never a private route or inferred link", () => {
    const exampleId = "sample / result";
    const url = `/api/capabilities/${capabilityId}/examples/${encodeURIComponent(exampleId)}/assets/${id}`;
    expect(exampleAssetUrl(capabilityId, exampleId, { ...asset, downloadUrl: url })).toBe(url);
    for (const downloadUrl of [undefined, `/api/assets/${id}/download`, `https://other.test${url}`, `${url}?token=secret`, `${url}/..`]) expect(exampleAssetUrl(capabilityId, exampleId, { ...asset, downloadUrl })).toBeUndefined();
  });
  it("copies scalar templates without seller files and accepts only returned buyer-owned file metadata", () => {
    const base = { capabilityId, capabilityVersionId: versionId, input: { title: "A real template", ignored: "not a field" }, assets: [] };
    expect(exampleTemplateValues(contract, base, capabilityId, versionId)).toEqual({ values: { title: "A real template" }, assets: [] });
    expect(exampleTemplateValues(contract, { ...base, input: { title: "With file", source: id }, assets: [asset] }, capabilityId, versionId).values.source).toBe(id);
    expect(() => exampleTemplateValues(contract, { ...base, input: { source: id } }, capabilityId, versionId)).toThrow("ownership");
    expect(() => exampleTemplateValues(contract, { ...base, capabilityVersionId: crypto.randomUUID() }, capabilityId, versionId)).toThrow("version changed");
    expect(() => exampleTemplateValues(contract, { ...base, assets: [asset, asset] }, capabilityId, versionId)).toThrow("duplicate");
    expect(() => exampleTemplateValues(contract, { ...base, input: { source: [id] }, assets: [asset] }, capabilityId, versionId)).toThrow("malformed");
  });
  it("validates named Markdown/file outputs and preserves exact file metadata without example-only flags", () => {
    const output = prepareExampleOutput(contract, "", "", { result: id, notes: "**Inspected**" }, {}, [asset]);
    expect(output).toEqual({ assets: [asset], fields: { result: id, notes: "**Inspected**" } });
    const example = { id: "one", title: "Example", input: {}, output: "", outputValue: output, outputAssets: [{ ...asset, reusableTemplate: false }] };
    expect(exampleOutput(example, contract).assets).toEqual([asset]);
    expect(() => prepareExampleOutput(contract, "", "", { result: id, notes: "Valid" }, {}, [])).toThrow();
  });
  it("requires exact approval of every input and output asset plus separate reusable-input permission", () => {
    const other = { ...asset, id: crypto.randomUUID(), filename: "output.txt" };
    const output = { assets: [other], fields: { result: other.id, notes: "**Output**" } };
    const rows = publicationAssets(contract, { title: "Review", source: id }, output, [asset, other]);
    expect(rows.map(row => [row.input, row.output])).toEqual([[true, false], [false, true]]);
    expect(() => publicationConsent(rows, [id], [], true)).toThrow("every");
    expect(() => publicationConsent(rows, [id, other.id], [], false)).toThrow("confirm");
    expect(() => publicationConsent(rows, [id, other.id], [other.id], true)).toThrow("input");
    expect(() => publicationConsent(rows, [id, id], [], true)).toThrow("every");
    expect(publicationConsent(rows, [id, other.id], [id], true)).toEqual({ approvedAssetIds: [id, other.id], reusableInputAssetIds: [id], confirmPublic: true });
    expect(() => publicationAssets(contract, { title: "Missing", source: id }, output, [other])).toThrow("metadata");
  });
  it("never falls back to a job download when rendering unpublished or revoked example files", () => {
    const output = { assets: [asset], fields: { result: id, notes: `![tracking](https://tracker.test/pixel)\n[private](/api/assets/${id}/download)` } };
    const markup = renderToStaticMarkup(createElement(JobResult, { output, contract: contract.output, resolveUrl: value => exampleAssetUrl(capabilityId, "one", value) }));
    expect(markup).toContain("No current published download"); expect(markup).not.toContain("<img"); expect(markup).not.toContain('href="/api/assets/');
    const url = `/api/capabilities/${capabilityId}/examples/one/assets/${id}`, publicAsset = { ...asset, mimeType: "image/png", downloadUrl: url };
    const rendered = renderToStaticMarkup(createElement(SafeMarkdown, { children: `![Approved](${url})`, assets: [publicAsset], resolveUrl: value => exampleAssetUrl(capabilityId, "one", value) }));
    expect(rendered).toContain(`<img src="${url}"`);
  });
});
