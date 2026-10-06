import { describe, expect, it } from "vitest";
import type { PermissionManifest } from "@kivro/contracts";
import { dependencyConsentErrors, dependencyGraphErrors, invalidateDependencies, permissionChanges, reconcileDependencies } from "../src/lib/dependencies";
import { workerManifest } from "../src/lib/worker-manifest";

const permissions: PermissionManifest = { schemaVersion: 1, tools: ["research.fetch"], network: { mode: "RESEARCH", allowedDomains: ["example.com"] }, resources: [{ id: "reference", type: "LOCAL_FILE", access: "READ_ONLY" }], inference: { provider: "seller-provider", model: "seller-model", credentialRef: "dedicated-key" }, limits: { timeoutSeconds: 300, memoryMb: 512, cpu: 1, maxPids: 64, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 8000 } };
describe("seller permission consent", () => {
  it("generates exact-scope grants without granting consent or inventing health", () => {
    const deps = reconcileDependencies(permissions, []);
    expect(deps.every(dep => !dep.approved && !dep.healthy && !dep.supported)).toBe(true);
    expect(deps.find(dep => dep.id === "inference")?.grants).toEqual({ inferenceProviders: ["seller-provider"], credentialRefs: ["dedicated-key"] });
    expect(deps.find(dep => dep.id === "resource-reference")?.grants).toEqual({ resources: ["reference"] });
    expect(deps.find(dep => dep.id === "network-0")?.grants).toEqual({ domains: ["example.com"] });
  });
  it("retains existing evidence only for unchanged scope", () => {
    const approved = reconcileDependencies(permissions, []).map(dep => ({ ...dep, approved: true, healthy: true, supported: true }));
    expect(reconcileDependencies(permissions, approved).every(dep => dep.approved)).toBe(true);
    const changed = reconcileDependencies({ ...permissions, inference: { ...permissions.inference, model: "different-model" } }, approved);
    expect(changed.find(dep => dep.id === "inference")?.approved).toBe(false);
    expect(changed.find(dep => dep.id === "inference")?.healthy).toBe(false);
    expect(changed.find(dep => dep.id === "resource-reference")?.approved).toBe(true);
  });
  it("highlights new network, resources and tools for version review", () => {
    const previous = { ...permissions, network: { mode: "NONE" as const, allowedDomains: [] }, resources: [], tools: [] };
    expect(permissionChanges(previous, permissions)).toEqual(expect.arrayContaining(["Network access added", "Tool added: research.fetch", "Domain added: example.com", "Resource added: reference"]));
  });
  it("detects unresolved, duplicate and cyclic dependency graphs", () => {
    const node = reconcileDependencies(permissions, [])[0];
    expect(dependencyGraphErrors([node, node])).toContain("Dependency IDs must be unique.");
    expect(dependencyGraphErrors([{ ...node, dependsOn: ["missing"] }])).toContain("Missing prerequisite: missing.");
    expect(dependencyGraphErrors([{ ...node, dependsOn: [node.id] }])[0]).toContain("cycle");
  });
  it("requires consent throughout the selected prerequisite closure", () => {
    const [root, child] = reconcileDependencies(permissions, []);
    const deps = [{ ...root, approved: true, dependsOn: [child.id] }, { ...child, required: false }];
    expect(dependencyConsentErrors(deps)).toEqual([`Approval required: ${child.name}.`]);
    expect(dependencyConsentErrors(deps.map(node => ({ ...node, approved: true })))).toEqual([]);
  });
  it("invalidates dependent approvals and evidence when a prerequisite changes", () => {
    const [root, child] = reconcileDependencies(permissions, []);
    const deps = [{ ...root, dependsOn: [child.id] }, child].map(node => ({ ...node, approved: true, healthy: true, supported: true }));
    expect(invalidateDependencies(deps, [child.id]).every(node => !node.approved && !node.healthy && !node.supported)).toBe(true);
    const changed = reconcileDependencies({ ...permissions, tools: ["write"] }, deps);
    expect(changed.find(node => node.id === root.id)?.approved).toBe(false);
  });
  it("exports the exact dependency snapshot for canonical worker hashing", () => {
    const dependencies = reconcileDependencies(permissions, []);
    const ioContract = { schemaVersion: 1 as const, inputs: [], output: { type: "TEXT" as const, description: "Summary", required: true } };
    const exported = workerManifest("saved-version", { ioContract, permissions, dependencies, internalInstructions: "Process the submitted inputs." });
    expect(exported.dependencies).toBe(dependencies);
    expect(exported.capabilityVersionId).toBe("saved-version");
    expect(exported.selectedSkills).toEqual([]);
  });
});
