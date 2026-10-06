import { SUPPORTED_EXECUTION_TOOLS, type PermissionManifest } from "@kivro/contracts";

export type PublicPermissionState = "LIMITED" | "NOT_USED" | "INCOMPLETE" | "UNSUPPORTED";
export type PublicPermission = { key: string; label: string; value: string; state: PublicPermissionState };

// Static buyer-safe wording only. Never interpolate resource IDs/types, domains,
// model names, credentials or other seller configuration into this projection.
export function publicPermissions(p: PermissionManifest): { rows: PublicPermission[]; unsupported: boolean } {
  const tools = new Set(p.tools), resources = new Set(p.resources.map(resource => resource.type));
  const declaredNetwork = p.network.mode !== "NONE";
  const networkReady = p.network.allowedDomains.length > 0;
  const research = tools.has("research.search") || tools.has("research.fetch");
  const connectors = tools.has("connector.call");
  const unsupported = p.tools.some(tool => !(SUPPORTED_EXECUTION_TOOLS as readonly string[]).includes(tool))
    || p.resources.some(resource => !["DATABASE", "LOCAL_FILE"].includes(resource.type))
    || (research && p.network.mode !== "RESEARCH") || (connectors && p.network.mode !== "CONNECTORS")
    || (declaredNetwork && !networkReady) || (!declaredNetwork && networkReady)
    || !["openai-compatible", "anthropic"].includes(p.inference.provider);
  const row = (key: string, label: string, value: string, state: PublicPermissionState): PublicPermission => ({ key, label, value, state });
  const resourceAccess = (present: boolean, enabled: boolean, activeText: string): Pick<PublicPermission, "value" | "state"> => !present
    ? { value: "Not declared", state: "NOT_USED" }
    : enabled ? { value: activeText, state: "LIMITED" } : { value: "Declared; access tool not granted", state: "INCOMPLETE" };
  const database = resources.has("POSTGRES") ? { value: "Unsupported declaration; blocked", state: "UNSUPPORTED" as const }
    : resourceAccess(resources.has("DATABASE"), tools.has("resource.query"), "Read-only queries to selected sources");
  const localFiles = resources.has("DATASET") ? { value: "Unsupported declaration; blocked", state: "UNSUPPORTED" as const }
    : resourceAccess(resources.has("LOCAL_FILE"), tools.has("resource.read") || tools.has("resource.query"), "Selected dataset only, read-only");
  const privateApi: Pick<PublicPermission, "value" | "state"> = resources.has("PRIVATE_API")
    ? { value: "Unsupported resource declaration; blocked", state: "UNSUPPORTED" }
    : p.network.mode === "CONNECTORS" && connectors && networkReady
      ? { value: "Declared read-only connectors only", state: "LIMITED" }
      : p.network.mode === "CONNECTORS" || connectors
        ? { value: "Incomplete connector grant; unavailable", state: "INCOMPLETE" }
        : { value: "Not granted", state: "NOT_USED" };
  const network: Pick<PublicPermission, "value" | "state"> = !declaredNetwork
    ? { value: "No Internet tools granted", state: "NOT_USED" }
    : p.network.mode === "RESEARCH" && research && networkReady
      ? { value: "Public web research only", state: "LIMITED" }
      : p.network.mode === "CONNECTORS" && connectors && networkReady
        ? { value: "Declared read-only APIs only", state: "LIMITED" }
        : { value: "Declared; required tool or scope missing", state: "INCOMPLETE" };
  const software = [tools.has("blender.render") ? "Blender rendering" : "", tools.has("ffmpeg.transcode") ? "FFmpeg transcoding" : ""].filter(Boolean);
  const rows = [
    row("inference", "AI inference", !["openai-compatible", "anthropic"].includes(p.inference.provider) ? "Unsupported provider; blocked" : p.inference.model ? "Seller-provided model" : "Model not configured", !["openai-compatible", "anthropic"].includes(p.inference.provider) ? "UNSUPPORTED" : p.inference.model ? "LIMITED" : "INCOMPLETE"),
    row("internet", "Public Internet", network.value, network.state),
    row("browser", "Browser", p.tools.some(tool => /^browser(?:[._]|$)/i.test(tool)) ? "Unsupported declaration; blocked" : "Not available", p.tools.some(tool => /^browser(?:[._]|$)/i.test(tool)) ? "UNSUPPORTED" : "NOT_USED"),
    row("database", "Proprietary database", database.value, database.state),
    row("private-api", "Private APIs", privateApi.value, privateApi.state),
    row("local-files", "Local files", localFiles.value, localFiles.state),
    row("local-directories", "Local directories", resources.has("LOCAL_DIRECTORY") ? "Unsupported declaration; blocked" : "Not available", resources.has("LOCAL_DIRECTORY") ? "UNSUPPORTED" : "NOT_USED"),
    row("local-software", "Local software", software.length ? `${software.join("; ")} in the job sandbox` : "No execution tools granted", software.length ? "LIMITED" : "NOT_USED"),
    row("shell", "Shell / commands", p.tools.some(tool => /^(exec|shell|terminal|process)(?:[._]|$)/i.test(tool)) ? "Unsupported declaration; blocked" : "Not available", p.tools.some(tool => /^(exec|shell|terminal|process)(?:[._]|$)/i.test(tool)) ? "UNSUPPORTED" : "NOT_USED"),
    row("external-actions", "External side effects", "Not permitted: remote writes, messages or purchases", "NOT_USED"),
    row("buyer-files", "Buyer file access", "This job's supplied inputs only", "LIMITED"),
  ];
  if (p.resources.some(resource => !["DATABASE", "LOCAL_FILE", "LOCAL_DIRECTORY", "PRIVATE_API", "POSTGRES", "DATASET"].includes(resource.type))) rows.push(row("other-resources", "Other seller resources", "Unsupported declaration; blocked", "UNSUPPORTED"));
  return { rows, unsupported };
}
