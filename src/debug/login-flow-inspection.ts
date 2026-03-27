export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface LoginStartResult {
  type: string;
  loginId?: string;
  authUrl?: string;
}

export interface CapturedClaims {
  email: string | null;
  chatgptAccountId: string | null;
  organizations: Array<{
    id: string;
    title: string | null;
    isDefault: boolean;
    role: string | null;
  }>;
}

export interface LoginCompletedSummary {
  success: boolean | null;
  error: string | null;
  loginId: string | null;
}

export interface DecodedAuthErrorPayload {
  kind: string | null;
  errorCode: string | null;
  requestId: string | null;
  raw: unknown;
}

export function resolveLoginInspectorClientName(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.CODEX_SWITCH_LOGIN_INSPECTOR_CLIENT_NAME?.trim();
  return override ? override : "Codex Desktop";
}

export function decodeAuthErrorPayloadFromUrl(
  urlText: string,
): DecodedAuthErrorPayload | null {
  try {
    const url = new URL(urlText);
    const payload = url.searchParams.get("payload");
    if (!payload) {
      return null;
    }

    const decoded = JSON.parse(
      Buffer.from(decodeURIComponent(payload), "base64").toString("utf8"),
    ) as {
      kind?: unknown;
      errorCode?: unknown;
      requestId?: unknown;
    };

    return {
      kind: typeof decoded.kind === "string" ? decoded.kind : null,
      errorCode: typeof decoded.errorCode === "string" ? decoded.errorCode : null,
      requestId: typeof decoded.requestId === "string" ? decoded.requestId : null,
      raw: decoded,
    };
  } catch {
    return null;
  }
}

export function getLoginCompletedSummary(
  message: JsonRpcMessage | null | undefined,
): LoginCompletedSummary {
  if (!message || typeof message.params !== "object" || message.params === null) {
    return {
      success: null,
      error: null,
      loginId: null,
    };
  }

  const params = message.params as {
    success?: boolean;
    error?: string | null;
    loginId?: string | null;
  };

  return {
    success: typeof params.success === "boolean" ? params.success : null,
    error: typeof params.error === "string" ? params.error : null,
    loginId: typeof params.loginId === "string" ? params.loginId : null,
  };
}

export function extractClaims(authDocument: string): CapturedClaims {
  const parsed = JSON.parse(authDocument) as {
    tokens?: {
      id_token?: string;
    };
  };
  const jwt = parsed.tokens?.id_token ?? null;
  if (!jwt) {
    return {
      email: null,
      chatgptAccountId: null,
      organizations: [],
    };
  }

  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as {
      email?: string;
      "https://api.openai.com/auth"?: {
        chatgpt_account_id?: string;
        organizations?: Array<{
          id: string;
          title?: string;
          is_default?: boolean;
          role?: string;
        }>;
      };
    };

    return {
      email: payload.email ?? null,
      chatgptAccountId:
        payload["https://api.openai.com/auth"]?.chatgpt_account_id ?? null,
      organizations:
        payload["https://api.openai.com/auth"]?.organizations?.map(
          (organization) => ({
            id: organization.id,
            title: organization.title ?? null,
            isDefault: organization.is_default ?? false,
            role: organization.role ?? null,
          }),
        ) ?? [],
    };
  } catch {
    return {
      email: null,
      chatgptAccountId: null,
      organizations: [],
    };
  }
}

export function protocolContainsWorkspaceTitle(messagesToCheck: JsonRpcMessage[]): boolean {
  const relevantMethods = new Set([
    "account/login/completed",
    "account/updated",
  ]);

  return messagesToCheck.some((message) => {
    if (message.id !== 2 && !relevantMethods.has(message.method ?? "")) {
      return false;
    }

    const payload = JSON.stringify(message.result ?? message.params ?? {});
    return (
      payload.includes("\"workspaceTitle\"") ||
      payload.includes("\"organizations\"") ||
      payload.includes("\"title\"")
    );
  });
}

export function shouldAllowBrowserHistoryErrors(argv: string[]): boolean {
  return !argv.includes("--no-open");
}
