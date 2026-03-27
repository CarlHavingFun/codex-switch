import { describe, expect, test } from "vitest";

import { getAuthUrlRedirectPort } from "../../src/core/ipv6-loopback-bridge.js";

describe("ipv6-loopback-bridge", () => {
  test("extracts the localhost callback port from a login auth URL", () => {
    expect(
      getAuthUrlRedirectPort(
        "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc",
      ),
    ).toBe(1455);
  });

  test("returns null when redirect_uri is absent", () => {
    expect(
      getAuthUrlRedirectPort(
        "https://auth.openai.com/oauth/authorize?response_type=code",
      ),
    ).toBeNull();
  });
});
