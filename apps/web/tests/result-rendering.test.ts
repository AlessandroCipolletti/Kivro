import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OutputContract } from "@kivro/contracts";
import { JobResult, SafeMarkdown } from "../src/components/job-result";

describe("safe typed result rendering", () => {
  it("renders common Markdown tables and headings without raw HTML, active links or remote tracking images", () => {
    const markup = renderToStaticMarkup(createElement(SafeMarkdown, { children: "# Summary\n\n**Delivered**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![tracker](https://tracker.example/pixel.png)\n\n[Source](https://example.com/report)" }));
    expect(markup).toContain("<h3>Summary</h3>"); expect(markup).toContain("<table>"); expect(markup).toContain("<strong>Delivered</strong>");
    expect(markup).not.toContain("<script"); expect(markup).not.toContain("javascript:"); expect(markup).not.toContain("<img"); expect(markup).not.toContain('href=""');
    expect(markup).toContain('rel="noopener noreferrer nofollow"');
  });
  it("renders pinned field types, zero and false without guessing Markdown in ordinary text", () => {
    const contract: OutputContract = { type: "TEXT", description: "Frozen output contract", required: true, fields: [
      { key: "summary", label: "Summary", type: "MARKDOWN", required: true, order: 0 },
      { key: "accepted", label: "Accepted", type: "BOOLEAN", required: true, order: 1 },
      { key: "count", label: "Count", type: "NUMBER", required: true, order: 2 },
      { key: "note", label: "Note", type: "LONG_TEXT", required: false, order: 3 },
    ] };
    const markup = renderToStaticMarkup(createElement(JobResult, { contract, output: { text: "**Plain legacy text**", fields: { summary: "**Named Markdown**", accepted: false, count: 0 } } }));
    expect(markup).toContain("<strong>Named Markdown</strong>"); expect(markup).toContain("**Plain legacy text**"); expect(markup).toContain("<p>No</p>"); expect(markup).toContain('class="tabular">0</p>'); expect(markup).toContain("Not supplied.");
  });
  it("keeps untyped fields escaped and never guesses executable asset URLs", () => {
    const markup = renderToStaticMarkup(createElement(JobResult, { output: { fields: { untrusted: '<img src="https://tracker.example" onerror="alert(1)">' } } }));
    expect(markup).toContain("contract unavailable"); expect(markup).not.toContain("<img"); expect(markup).toContain("&lt;img");
  });
});
