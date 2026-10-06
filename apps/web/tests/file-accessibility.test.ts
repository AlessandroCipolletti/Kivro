import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IOContract } from "@kivro/contracts";
import { ContractForm } from "../src/components/contract-form";

const contract: IOContract = { schemaVersion: 1, inputs: [
  { key: "source", label: "Source", description: "A source text file.", type: "FILE", required: true, order: 0 },
  { key: "references", label: "References", description: "Optional reference files.", type: "FILES", required: false, order: 1 },
], output: { type: "TEXT", description: "Summary", required: true } };
const props = { contract, values: {}, onChange: () => undefined };
const inputs = (markup: string) => [...markup.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].map(match => match[0]);
const attribute = (markup: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(markup)?.[1];

describe("contract file error associations", () => {
  it("associates only the invalid file control with its own field help and error", () => {
    const markup = renderToStaticMarkup(createElement(ContractForm, { ...props, errors: { source: "Choose a source file." } }));
    const [source, references] = inputs(markup);
    expect(attribute(source, "aria-invalid")).toBe("true");
    expect(attribute(source, "aria-required")).toBe("true");
    const help = attribute(source, "aria-describedby");
    expect(help).toBe(`${attribute(source, "id")}-help`);
    expect(markup).toContain(`<div id="${help}"><small class="field-hint">A source text file.</small><small class="field-error">Choose a source file.</small></div>`);
    expect(attribute(references, "aria-invalid")).toBe("false");
    expect(attribute(references, "aria-required")).toBe("false");
    expect(attribute(references, "aria-describedby")).not.toBe(help);
  });
  it("does not retain invalid/error-only references when no error is supplied", () => {
    const markup = renderToStaticMarkup(createElement(ContractForm, props));
    for (const input of inputs(markup)) expect(attribute(input, "aria-invalid")).toBe("false");
    expect(markup).not.toContain("-upload-error");
    expect(markup).not.toContain('class="field-error"');
  });
  it("keeps controls and description IDs unique across multiple forms", () => {
    const markup = renderToStaticMarkup(createElement(Fragment, null,
      createElement(ContractForm, { ...props, errors: { source: "First form error." } }),
      createElement(ContractForm, { ...props, errors: { references: "Second form error." } }),
    ));
    const files = inputs(markup), ids = files.map(input => attribute(input, "id"));
    expect(files).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(files.map(input => attribute(input, "aria-invalid"))).toEqual(["true", "false", "false", "true"]);
    for (const input of files) expect(attribute(input, "aria-describedby")).toBe(`${attribute(input, "id")}-help`);
  });
});
