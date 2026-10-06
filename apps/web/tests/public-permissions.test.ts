import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permissions } from "../src/components/permissions";
import { publicPermissions } from "../src/lib/public-permissions";
import { defaultWorkerPermissions } from "../src/lib/worker-policy";

describe("buyer-safe public permission taxonomy", () => {
  it("always distinguishes the stable categories and denies unsupported browser, shell and external actions", () => {
    const p = defaultWorkerPermissions(); p.inference.model = "fixture";
    const { rows, unsupported } = publicPermissions(p);
    expect(rows.map(row => row.key)).toEqual(["inference", "internet", "browser", "database", "private-api", "local-files", "local-directories", "local-software", "shell", "external-actions", "buyer-files"]);
    expect(unsupported).toBe(false);
    for (const key of ["browser", "shell", "external-actions"]) expect(rows.find(row => row.key === key)?.state).toBe("NOT_USED");
    expect(rows.find(row => row.key === "external-actions")?.value).toContain("remote writes, messages or purchases");
  });
  it("separates database queries and selected datasets without inventing approval from a resource entry", () => {
    const p = defaultWorkerPermissions();
    p.resources = [{ id: "private_database", type: "DATABASE", access: "READ_ONLY" }, { id: "private_dataset", type: "LOCAL_FILE", access: "READ_ONLY" }];
    expect(publicPermissions(p).rows.filter(row => ["database", "local-files"].includes(row.key)).every(row => row.state === "INCOMPLETE")).toBe(true);
    p.tools = ["resource.query"];
    expect(publicPermissions(p).rows.find(row => row.key === "database")?.value).toBe("Read-only queries to selected sources");
    expect(publicPermissions(p).rows.find(row => row.key === "local-files")?.value).toBe("Selected dataset only, read-only");
    p.tools = ["resource.read"];
    expect(publicPermissions(p).rows.find(row => row.key === "database")?.state).toBe("INCOMPLETE");
    expect(publicPermissions(p).rows.find(row => row.key === "local-files")?.state).toBe("LIMITED");
  });
  it("requires actual research or connector tools and scope instead of treating network mode as enough", () => {
    const p = defaultWorkerPermissions(); p.network = { mode: "CONNECTORS", allowedDomains: ["private.example.test"] };
    expect(publicPermissions(p).rows.find(row => row.key === "private-api")?.state).toBe("INCOMPLETE");
    p.tools = ["connector.call"];
    expect(publicPermissions(p).rows.find(row => row.key === "private-api")?.value).toBe("Declared read-only connectors only");
    p.network = { mode: "RESEARCH", allowedDomains: ["public.example.test"] }; p.tools = ["research.fetch"];
    expect(publicPermissions(p).rows.find(row => row.key === "internet")?.value).toBe("Public web research only");
    expect(publicPermissions(p).rows.find(row => row.key === "private-api")?.state).toBe("NOT_USED");
    p.network.allowedDomains = [];
    expect(publicPermissions(p).unsupported).toBe(true);
    expect(publicPermissions(p).rows.find(row => row.key === "internet")?.state).toBe("INCOMPLETE");
  });
  it("never upgrades unsupported resource aliases or browser/shell declarations into executable powers", () => {
    const p = defaultWorkerPermissions(); p.tools = ["browser", "exec", "secret-custom-tool"];
    p.resources = ["PRIVATE_API", "LOCAL_DIRECTORY", "POSTGRES", "DATASET", "unknown-private-type"].map((type, index) => ({ id: `private_${index}`, type, access: "READ_ONLY" as const }));
    const result = publicPermissions(p);
    expect(result.unsupported).toBe(true);
    for (const key of ["browser", "shell", "private-api", "local-directories", "database", "local-files", "other-resources"]) expect(result.rows.find(row => row.key === key)?.state).toBe("UNSUPPORTED");
    expect(JSON.stringify(result)).not.toMatch(/secret-custom-tool|unknown-private-type|private_0/);
  });
  it("identifies only granted sandbox software and never describes write/edit as external mutations", () => {
    const p = defaultWorkerPermissions(); p.tools = ["write", "edit", "blender.render"];
    expect(publicPermissions(p).rows.find(row => row.key === "local-software")?.value).toBe("Blender rendering in the job sandbox");
    expect(publicPermissions(p).rows.find(row => row.key === "external-actions")?.state).toBe("NOT_USED");
    p.tools = ["ffmpeg.transcode"];
    expect(publicPermissions(p).rows.find(row => row.key === "local-software")?.value).toBe("FFmpeg transcoding in the job sandbox");
  });
  it("renders semantic labeled states without resource IDs, private types, model details, domains or credentials", () => {
    const p = defaultWorkerPermissions(); p.inference = { provider: "anthropic", model: "private-model-name", credentialRef: "private-credential-name" };
    p.resources = [{ id: "secret_resource_id", type: "DATABASE", access: "READ_ONLY" }]; p.tools = ["resource.query", "connector.call"];
    p.network = { mode: "CONNECTORS", allowedDomains: ["private-api.example.test"] };
    const html = renderToStaticMarkup(React.createElement(Permissions, { permissions: p }));
    expect(html).toContain('<dt>Proprietary database</dt><dd>Read-only queries to selected sources</dd>');
    expect(html).toContain('<dt>Private APIs</dt><dd>Declared read-only connectors only</dd>');
    expect(html).toContain("not proof of local approval or current readiness");
    for (const secret of ["secret_resource_id", "private-model-name", "private-credential-name", "private-api.example.test"]) expect(html).not.toContain(secret);
    expect(html).not.toContain("approved, read-only");
  });
});
