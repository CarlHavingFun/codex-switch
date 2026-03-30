import { describe, expect, test, vi } from "vitest";

import {
  ChromeCdpCaptureSession,
  isInterestingAuthUrl,
} from "../../src/debug/chrome-cdp-capture.js";

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

  test("enables capture on the auto-attached target session", async () => {
    const session = Object.create(ChromeCdpCaptureSession.prototype) as {
      handleEvent: (message: {
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      }) => Promise<void>;
      enablePageCapture: (sessionId: string | null) => Promise<void>;
    };

    session.enablePageCapture = vi.fn().mockResolvedValue(undefined);

    await session.handleEvent({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "page-session-1",
        targetInfo: {
          type: "page",
        },
      },
    });

    expect(session.enablePageCapture).toHaveBeenCalledWith("page-session-1");
  });
});
