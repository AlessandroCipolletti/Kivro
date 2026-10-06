import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./support/contrast";

type Declaration = { prop: string; value: string };
type Rule = { selector: string; walkDecls: (visit: (declaration: Declaration) => void) => void };
type Stylesheet = { walkRules: (visit: (rule: Rule) => void) => void };
// Use the CSS parser already shipped with Next; do not add another build dependency.
const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("next/package.json"))("postcss") as { parse: (css: string) => Stylesheet };
const stylesheet = parse(readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8"));
const declarations = new Map<string, Record<string, string>>();
stylesheet.walkRules(rule => {
  const values = declarations.get(rule.selector) ?? {};
  rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
  declarations.set(rule.selector, values);
});
const tokens = declarations.get(":root")!;
function color(value: string): string {
  const token = /^var\((--[\w-]+)\)$/.exec(value);
  if (!token) return value;
  if (!tokens[token[1]]) throw new Error(`Missing color token: ${token[1]}`);
  return color(tokens[token[1]]);
}
function property(selector: string, name: string) {
  const value = declarations.get(selector)?.[name];
  if (!value) throw new Error(`Missing ${selector} ${name}`);
  return color(value);
}

describe("normal-text contrast in the Kivro light system", () => {
  it("uses the sRGB luminance formula and catches the previous muted/status failures", () => {
    expect(contrastRatio("#000", "rgb(255, 255, 255)")).toBe(21);
    expect(contrastRatio("#fff", "#ffffff")).toBe(1);
    expect(contrastRatio("#797e76", "#fff")).toBeLessThan(4.5);
    expect(contrastRatio("#737973", "#fff")).toBeLessThan(4.5);
    expect(() => contrastRatio("rgba(0, 0, 0, 0.5)", "#fff")).toThrow("opaque");
  });
  it("keeps text tokens above 4.5 on every supported light semantic surface", () => {
    for (const foreground of ["--ink", "--muted", "--subtle", "--accent", "--success", "--warning", "--danger"]) {
      for (const background of ["--paper", "--surface", "--accent-soft", "--success-soft", "--warning-soft", "--danger-soft"]) {
        expect(contrastRatio(color(tokens[foreground]), color(tokens[background])), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("binds normal, neutral, caption and placeholder text to readable colors", () => {
    expect(declarations.get("input::placeholder,textarea::placeholder")?.opacity).toBe("1");
    for (const selector of [".status.neutral", ".muted", ".nav-section-label", ".workspace-footer", ".results-caption>.row", ".capability-summary", ".io-line", ".capability-proof", ".capability-proof small", ".upload-area", ".upload-area>small", ".pending-result", ".wallet-balance>div>span", ".field-number", ".plan-steps>li>span:first-child", "input::placeholder,textarea::placeholder"]) {
      expect(contrastRatio(property(selector, "color"), "#f0f4eb"), selector).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("preserves distinct semantic states and readable filled actions/notices", () => {
    const statusColors = ["positive", "negative", "caution", "neutral"].map(state => property(`.status.${state}`, "color"));
    expect(new Set(statusColors).size).toBe(4);
    for (const selector of [".button.primary", ".button.primary:hover:not(:disabled)", ".button.danger", ".button.danger:hover:not(:disabled)", ".notice", ".notice.success", ".notice.warning", ".notice.danger"]) {
      const foreground = selector.includes(":hover") ? "#fff" : property(selector, "color");
      expect(contrastRatio(foreground, property(selector, "background")), selector).toBeGreaterThanOrEqual(4.5);
    }
  });
});
