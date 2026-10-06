import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { JobSeller } from "../src/components/job-seller";

it("renders only the purchased seller name and stable identity as escaped text", () => {
  const sellerId = crypto.randomUUID(), sellerName = "Recorded <script>seller</script>";
  const html = renderToStaticMarkup(React.createElement(JobSeller, { job: { sellerId, sellerName } }));
  expect(html).toContain(`/sellers/${sellerId}`); expect(html).toContain("Recorded &lt;script&gt;seller&lt;/script&gt;");
  expect(html).not.toContain("<script>"); expect(html).not.toContain("not recorded");
});
it("keeps legacy missing names unknown with the full seller ID fallback", () => {
  const sellerId = crypto.randomUUID();
  for (const sellerName of [null, undefined]) {
    const html = renderToStaticMarkup(React.createElement(JobSeller, { job: { sellerId, sellerName } }));
    expect(html).toContain(`Seller ${sellerId}`); expect(html).toContain("Name at purchase not recorded");
  }
});
