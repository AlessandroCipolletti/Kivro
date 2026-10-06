import { describe, expect, it } from "vitest";
import { actionToken, passwordConfirmationError } from "../src/lib/account";

describe("account action inputs", () => {
  it("accepts exactly one opaque fragment token, never query navigation or duplicates", () => {
    expect(actionToken("#token=opaque-token_123")).toBe("opaque-token_123");
    for (const fragment of ["", "?token=opaque", "#token=", "#token=a&token=b", "#token=%0Asecret", `#token=${"a".repeat(2049)}`]) expect(actionToken(fragment)).toBeUndefined();
  });
  it("requires matching passwords within the account API bounds", () => {
    expect(passwordConfirmationError("a-long-new-password", "a-long-new-password")).toBeUndefined();
    expect(passwordConfirmationError("short", "short")).toContain("12");
    expect(passwordConfirmationError("a-long-new-password", "different-password")).toContain("match");
    expect(passwordConfirmationError("a".repeat(129), "a".repeat(129))).toContain("128");
  });
});
