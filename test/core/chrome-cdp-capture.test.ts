import { describe, expect, test } from "vitest";

import { isInterestingAuthUrl } from "../../src/debug/chrome-cdp-capture.js";

describe("chrome-cdp-capture", () => {
  test("recognizes workspace selection endpoints as interesting", () => {
    expect(
      isInterestingAuthUrl("https://auth.openai.com/api/accounts/workspace/select"),
    ).toBe(true);
  });

  test("ignores unrelated auth endpoints", () => {
    expect(
      isInterestingAuthUrl("https://auth.openai.com/api/accounts/logout"),
    ).toBe(false);
  });
});
