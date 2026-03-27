import { describe, expect, test } from "vitest";

import {
  decodeAuthErrorPayloadFromUrl,
  extractClaims,
  getLoginCompletedSummary,
  protocolContainsWorkspaceTitle,
  resolveLoginInspectorClientName,
  shouldAllowBrowserHistoryErrors,
  type JsonRpcMessage,
} from "../../src/debug/login-flow-inspection.js";

function createJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("login-flow-inspection", () => {
  test("summarizes failed login completion payloads", () => {
    const summary = getLoginCompletedSummary({
      method: "account/login/completed",
      params: {
        loginId: "login-123",
        success: false,
        error: "missing_required_parameter",
      },
    });

    expect(summary).toEqual({
      success: false,
      error: "missing_required_parameter",
      loginId: "login-123",
    });
  });

  test("ignores initialize clientInfo title when checking public protocol for workspace names", () => {
    const messages: JsonRpcMessage[] = [
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            title: "codex-switch login inspector",
          },
        },
      },
      {
        id: 2,
        result: {
          type: "chatgpt",
          authUrl: "https://auth.openai.com/oauth/authorize?...",
        },
      },
    ];

    expect(protocolContainsWorkspaceTitle(messages)).toBe(false);
  });

  test("extracts organization titles from JWT claims", () => {
    const claims = extractClaims(
      JSON.stringify({
        tokens: {
          id_token: createJwt({
            email: "person@example.com",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-123",
              organizations: [
                {
                  id: "org-1",
                  title: "即将到期 及时复购",
                  is_default: true,
                  role: "owner",
                },
              ],
            },
          }),
        },
      }),
    );

    expect(claims).toEqual({
      email: "person@example.com",
      chatgptAccountId: "acct-123",
      organizations: [
        {
          id: "org-1",
          title: "即将到期 及时复购",
          isDefault: true,
          role: "owner",
        },
      ],
    });
  });

  test("defaults the login inspector client name to Codex Desktop", () => {
    expect(resolveLoginInspectorClientName({})).toBe("Codex Desktop");
  });

  test("allows overriding the login inspector client name", () => {
    expect(
      resolveLoginInspectorClientName({
        CODEX_SWITCH_LOGIN_INSPECTOR_CLIENT_NAME: "codex_chatgpt_desktop",
      }),
    ).toBe("codex_chatgpt_desktop");
  });

  test("decodes auth error payloads from browser error URLs", () => {
    const decoded = decodeAuthErrorPayloadFromUrl(
      "https://auth.openai.com/error?payload=eyJraW5kIjoiQXV0aEFwaUZhaWx1cmUiLCJlcnJvckNvZGUiOiJtaXNzaW5nX3JlcXVpcmVkX3BhcmFtZXRlciIsInJlcXVlc3RJZCI6IjEyMy00NTYifQ%3D%3D&session_id=None",
    );

    expect(decoded).toEqual({
      kind: "AuthApiFailure",
      errorCode: "missing_required_parameter",
      requestId: "123-456",
      raw: {
        kind: "AuthApiFailure",
        errorCode: "missing_required_parameter",
        requestId: "123-456",
      },
    });
  });

  test("returns null when auth error payload URL is missing the payload query", () => {
    expect(
      decodeAuthErrorPayloadFromUrl("https://auth.openai.com/error?session_id=None"),
    ).toBeNull();
  });

  test("disables browser history auth-error detection for no-open manual mode", () => {
    expect(shouldAllowBrowserHistoryErrors(["node", "script.ts", "--no-open"])).toBe(
      false,
    );
    expect(shouldAllowBrowserHistoryErrors(["node", "script.ts"])).toBe(true);
  });
});
