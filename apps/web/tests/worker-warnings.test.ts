import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkerWarnings } from "../src/components/worker-warnings";
import { warningFixture } from "./support/worker-warnings";

it("displays each warning's severity, scope, timing, action and existing blocking gate without an unblock action", () => {
  const snapshot = warningFixture(), html = renderToStaticMarkup(React.createElement(WorkerWarnings, { snapshot }));
  expect(html).toContain("CRITICAL"); expect(html).toContain("WARNING"); expect(html).toContain("Blocking"); expect(html).toContain("Non-blocking");
  expect(html).toContain("First platform observation"); expect(html).toContain("Last observed"); expect(html).toContain("Platform state"); expect(html).toContain("not an independent cloud probe");
  for (const warning of snapshot.items) expect(html).toContain(warning.requiredAction);
  expect(html).toContain('/selling/capabilities/e0000000-0000-4000-8000-000000000002"');
  expect(html).toContain(snapshot.items[1].affectedEntity.capabilityVersionId!); expect(html).not.toContain("<button");
});
it("never equates missing or empty warnings with full device safety", () => {
  const absent = renderToStaticMarkup(React.createElement(WorkerWarnings, {})); expect(absent).toContain("Absence of a report does not establish safety");
  const snapshot = warningFixture(); snapshot.items = []; snapshot.truncated = true;
  const html = renderToStaticMarkup(React.createElement(WorkerWarnings, { snapshot }));
  for (const text of ["not a complete security assessment", "bound capability version only", "stale; current local evidence is unavailable", "revocation schedule: unavailable", "outside the accepted scope", "snapshot is truncated"]) expect(html).toContain(text);
});
