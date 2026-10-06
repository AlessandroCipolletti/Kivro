import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { requiredOutputFiles, type AgentContractMatch, type OutputFileDraft } from "../src/lib/agent-files";
import { AgentContractPreparation, AgentFileHistory } from "../src/components/agent-files";
import { recommendationCapability } from "./support/recommendations";

const row = (extension: string, count = "1", mimeType = ""): OutputFileDraft => ({ id: "one", extension, mimeType, count });
describe("explicit agent file requirements", () => {
  it("omits absent requirements and canonicalizes selectors without widening their meaning", () => {
    expect(requiredOutputFiles([])).toBeUndefined();
    expect(requiredOutputFiles([row(" PDF ", "2", " APPLICATION/PDF "), row(".PNG", "3")])).toEqual([{ extension: ".pdf", mimeType: "application/pdf", count: 2 }, { extension: ".png", count: 3 }]);
  });
  it("rejects empty, malformed, duplicate and excessive selectors", () => {
    for (const rows of [[row("")], [row("*.pdf")], [row(".pdf", "1", "text/*")], [row(".pdf", "1.5")], [row(".pdf", "0")], [row(".pdf", "21")], [row(".pdf", "20"), row(".png")], [row("PDF"), row(".pdf")]]) expect(() => requiredOutputFiles(rows)).toThrow();
    expect(() => requiredOutputFiles(Array.from({ length: 21 }, (_, index) => row(`.${index}`)))).toThrow();
  });
  it("preserves MIME-only requests and conjunctive selectors as separate explicit groups", () => {
    expect(requiredOutputFiles([row("", "1", "image/png"), row(".png", "2", "image/png")])).toEqual([{ mimeType: "image/png", count: 1 }, { extension: ".png", mimeType: "image/png", count: 2 }]);
  });
  it("renders missing inputs, applied defaults and output uncertainty without purchase authority or markup execution", () => {
    const capability = recommendationCapability();
    capability.ioContract.inputs = [{ key: "resolution", type: "SHORT_TEXT", label: "Render resolution", required: true, order: 0 }];
    const match: AgentContractMatch = { capabilityId: capability.id, capabilityVersionId: capability.versionId, status: "NEEDS_INPUT", preparedInput: { title: "<script>alert(1)</script>" }, appliedDefaults: ["title"], assetOptions: [], issues: [{ code: "MISSING_INPUT", severity: "CLARIFICATION", inputKey: "resolution" }], output: { compatible: true, guaranteed: false, issues: [{ code: "OUTPUT_NOT_GUARANTEED", severity: "CLARIFICATION" }] } };
    const html = renderToStaticMarkup(React.createElement(AgentContractPreparation, { capability, match }));
    expect(html).toContain("Render resolution"); expect(html).toContain("More input required");
    expect(html).toContain("do not guarantee"); expect(html).toContain("No job or payment has been authorized");
    expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
    match.capabilityVersionId = crypto.randomUUID();
    const stale = renderToStaticMarkup(React.createElement(AgentContractPreparation, { capability, match }));
    expect(stale).toContain("earlier version"); expect(stale).not.toContain("Render resolution");
  });
  it("marks historical attachments as non-carried-over and escapes output selectors", () => {
    const html = renderToStaticMarkup(React.createElement(AgentFileHistory, { ids: [crypto.randomUUID()], outputs: [{ extension: ".pdf", count: 2 }] }));
    expect(html).toContain("Not attached to the next request"); expect(html).toContain("2 required output files");
  });
});
