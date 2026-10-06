import { stableStringify } from "@kivro/contracts";
import type { Dependency, PermissionManifest } from "./types";

// A changed prerequisite invalidates consent and evidence for every dependent node.
export function invalidateDependencies(dependencies: Dependency[], changedIds: string[]): Dependency[] {
  const changed = new Set(changedIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of dependencies) if (!changed.has(node.id) && node.dependsOn?.some(id => changed.has(id))) {
      changed.add(node.id); grew = true;
    }
  }
  return dependencies.map(node => changed.has(node.id) ? { ...node, approved: false, healthy: false, supported: false } : node);
}

export function dependencyGraphErrors(dependencies: Dependency[]): string[] {
  const errors = new Set<string>();
  const byId = new Map(dependencies.map(node => [node.id, node]));
  if (byId.size !== dependencies.length) errors.add("Dependency IDs must be unique.");
  const active = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) { errors.add(`Dependency cycle includes ${byId.get(id)?.name || id}.`); return; }
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) { errors.add(`Missing prerequisite: ${id}.`); return; }
    active.add(id);
    for (const child of node.dependsOn || []) visit(child);
    active.delete(id); visited.add(id);
  }
  dependencies.forEach(node => visit(node.id));
  return [...errors];
}

export function dependencyConsentErrors(dependencies: Dependency[]): string[] {
  const errors = new Set(dependencyGraphErrors(dependencies));
  const byId = new Map(dependencies.map(node => [node.id, node]));
  const visited = new Set<string>();
  function visit(node: Dependency) {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (!node.approved) errors.add(`Approval required: ${node.name}.`);
    for (const id of node.dependsOn || []) { const child = byId.get(id); if (child) visit(child); }
  }
  dependencies.filter(node => node.required || node.approved).forEach(visit);
  return [...errors];
}

export function reconcileDependencies(permissions: PermissionManifest, previous: Dependency[]): Dependency[] {
  const declarations: Dependency[] = [];
  const add = (id: string, name: string, type: string, grants: NonNullable<Dependency["grants"]>, scope: string) => {
    const prior = previous.find(item => item.id === id && item.source === scope && stableStringify(item.grants) === stableStringify(grants));
    declarations.push(prior || { id, name, type, grants, source: scope, required: true, approved: false, healthy: false, supported: false, confidence: "DECLARED", dependsOn: [] });
  };
  if (permissions.inference.provider) add("inference", `${permissions.inference.provider} / ${permissions.inference.model}`, "INFERENCE", { inferenceProviders: [permissions.inference.provider], ...(permissions.inference.credentialRef ? { credentialRefs: [permissions.inference.credentialRef] } : {}) }, `inference:${permissions.inference.provider}:${permissions.inference.model}:${permissions.inference.credentialRef || ""}`);
  permissions.tools.filter(Boolean).forEach((tool, index) => add(`tool-${index}`, tool, "TOOL", { tools: [tool] }, `tool:${tool}`));
  permissions.resources.forEach(resource => add(`resource-${resource.id}`, resource.id, resource.type, { resources: [resource.id] }, `resource:${resource.type}:${resource.id}:READ_ONLY`));
  permissions.network.allowedDomains.filter(Boolean).forEach((domain, index) => add(`network-${index}`, domain, "NETWORK_DESTINATION", { domains: [domain] }, `network:${permissions.network.mode}:${domain}`));
  const managed = new Set(declarations.map(item => item.id));
  const extras = previous.filter(item => !managed.has(item.id) && !/^(inference$|tool-|resource-|network-)/.test(item.id));
  const changed = previous.filter(item => managed.has(item.id) && declarations.find(node => node.id === item.id) !== item || !managed.has(item.id) && !extras.includes(item)).map(item => item.id);
  return invalidateDependencies([...declarations, ...extras], changed);
}
export function permissionChanges(before: PermissionManifest | undefined, after: PermissionManifest) {
  if (!before) return [];
  const changes: string[] = [];
  if (before.network.mode === "NONE" && after.network.mode !== "NONE") changes.push("Network access added");
  after.tools.filter(tool => !before.tools.includes(tool)).forEach(tool => changes.push(`Tool added: ${tool}`));
  after.network.allowedDomains.filter(domain => !before.network.allowedDomains.includes(domain)).forEach(domain => changes.push(`Domain added: ${domain}`));
  after.resources.filter(resource => !before.resources.some(item => item.id === resource.id)).forEach(resource => changes.push(`Resource added: ${resource.id}`));
  if (before.inference.provider !== after.inference.provider || before.inference.model !== after.inference.model) changes.push("Inference provider or model changed");
  if (before.inference.credentialRef !== after.inference.credentialRef) changes.push("Inference credential reference changed");
  return changes;
}
