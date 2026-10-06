import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { observedCoverage, observedTime } from "../src/lib/availability-analytics";
import { AvailabilityAnalytics } from "../src/components/availability-analytics";

describe("bounded availability observations", () => {
  it("preserves measured zero, missing samples and sub-second medians", () => {
    expect(observedTime(null)).toBe("No samples"); expect(observedTime(0)).toBe("0 sec");
    expect(observedTime(125)).toBe("0.125 sec"); expect(observedTime(120500)).toBe("2 min 0.5 sec");
    expect(observedCoverage(null)).toBe("Not measured"); expect(observedCoverage(0)).toBe("0.0% observed");
    expect(observedCoverage(0.25)).toBe("25.0% observed");
  });
  it("distinguishes an omitted API field from an empty measured catalog", () => {
    const period = { from: "2026-10-01T00:00:00Z", to: "2026-10-06T00:00:00Z" };
    expect(renderToStaticMarkup(React.createElement(AvailabilityAnalytics, { period }))).toContain("were not supplied by this API");
    const html = renderToStaticMarkup(React.createElement(AvailabilityAnalytics, { period, data: { method: "BOUNDED_PREVIOUS_OBSERVATION", maxObservationGapMs: 120000, disconnectFailureBasis: "RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS", totalCapabilities: 0, truncated: false, items: [] } }));
    expect(html).toContain("No capabilities in this reporting snapshot"); expect(html).toContain("not exact uptime or a seller ranking");
    expect(html).toContain("across larger gaps remains unknown");
  });
});
