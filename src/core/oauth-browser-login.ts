import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { CodexLoginBrowserStrategy } from "./codex-client.js";
import { launchLoginBrowser } from "./browser-launcher.js";
import { startIpv6LoopbackBridge } from "./ipv6-loopback-bridge.js";

const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const DEFAULT_ORIGINATOR = "Codex Desktop";
const DEFAULT_REDIRECT_PORT = 1455;

const tokenExchangeResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  id_token: z.string(),
});

const jwtClaimsSchema = z
  .object({
    "https://api.openai.com/auth": z
      .object({
        chatgpt_account_id: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export interface PerformOauthBrowserLoginOptions {
  profileHome: string;
  env: NodeJS.ProcessEnv;
  browserStrategy: CodexLoginBrowserStrategy;
  timeoutMs: number;
}

interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export async function performOauthBrowserLogin(
  options: PerformOauthBrowserLoginOptions,
): Promise<void> {
  const authBaseUrl = resolveAuthBaseUrl(options.env);
  const clientId = options.env.CODEX_SWITCH_AUTH_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
  const scope = options.env.CODEX_SWITCH_AUTH_SCOPE?.trim() || DEFAULT_SCOPE;
  const originator =
    options.env.CODEX_SWITCH_AUTH_ORIGINATOR?.trim() ||
    options.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE?.trim() ||
    DEFAULT_ORIGINATOR;
  const forcedWorkspaceId = await readForcedWorkspaceId(options.profileHome);
  const pkce = generatePkcePair();
  const state = toBase64Url(randomBytes(32));
  const callbackResult = createDeferred<void>();
  let browserHandle: { cleanup(): Promise<void> } | null = null;
  let loopbackBridge: { close(): Promise<void> } | null = null;

  const server = createServer(async (req, res) => {
    await handleCallbackRequest(req, res, {
      expectedState: state,
      authBaseUrl,
      clientId,
      pkceVerifier: pkce.verifier,
      redirectUri: buildRedirectUri(actualPort(server)),
      profileHome: options.profileHome,
      forcedWorkspaceId,
      timeoutMs: options.timeoutMs,
      callbackResult,
    });
  });

  try {
    const port = await listenOnLoopback(server, DEFAULT_REDIRECT_PORT);
    loopbackBridge = await startIpv6LoopbackBridge(port);
    const redirectUri = buildRedirectUri(port);
    const authUrl = buildAuthorizationUrl({
      authBaseUrl,
      clientId,
      redirectUri,
      scope,
      codeChallenge: pkce.challenge,
      state,
      originator,
      allowedWorkspaceId: forcedWorkspaceId,
    });

    browserHandle = await launchLoginBrowser(authUrl, {
      strategy: options.browserStrategy,
      env: options.env,
    });

    await awaitWithTimeout(
      callbackResult.promise,
      options.timeoutMs * 40,
      "Timed out waiting for login completion.",
    );
  } finally {
    if (loopbackBridge) {
      await loopbackBridge.close();
    }
    if (browserHandle) {
      await browserHandle.cleanup();
    }
    await closeServer(server);
  }
}

function resolveAuthBaseUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_SWITCH_AUTH_BASE_URL?.trim() || DEFAULT_AUTH_BASE_URL;
  return configured.replace(/\/+$/, "");
}

async function handleCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: {
    expectedState: string;
    authBaseUrl: string;
    clientId: string;
    pkceVerifier: string;
    redirectUri: string;
    profileHome: string;
    forcedWorkspaceId: string | null;
    timeoutMs: number;
    callbackResult: Deferred<void>;
  },
): Promise<void> {
  try {
    const requestUrl = new URL(req.url ?? "/", context.redirectUri);
    if (requestUrl.pathname !== "/auth/callback") {
      respondHtml(res, 404, "Not Found", "Unknown login callback path.");
      return;
    }

    const state = requestUrl.searchParams.get("state");
    if (!state || state !== context.expectedState) {
      const error = new Error("State mismatch during login callback.");
      respondHtml(res, 400, "Codex login", error.message);
      context.callbackResult.reject(error);
      return;
    }

    const errorCode = requestUrl.searchParams.get("error");
    if (errorCode) {
      const description =
        requestUrl.searchParams.get("error_description")?.trim() || errorCode;
      const error = new Error(`Sign-in failed: ${description}`);
      respondHtml(res, 400, "Codex login", error.message);
      context.callbackResult.reject(error);
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      const error = new Error("Missing authorization code in login callback.");
      respondHtml(res, 400, "Codex login", error.message);
      context.callbackResult.reject(error);
      return;
    }

    const tokens = await exchangeCodeForTokens({
      authBaseUrl: context.authBaseUrl,
      clientId: context.clientId,
      redirectUri: context.redirectUri,
      code,
      codeVerifier: context.pkceVerifier,
      timeoutMs: context.timeoutMs,
    });

    if (
      context.forcedWorkspaceId &&
      tokens.accountId &&
      tokens.accountId !== context.forcedWorkspaceId
    ) {
      throw new Error(
        `Login is restricted to workspace id ${context.forcedWorkspaceId}.`,
      );
    }

    await writeAuthDocument(context.profileHome, tokens);
    respondHtml(res, 200, "Codex login", "Sign-in completed. You can return to Codex.");
    context.callbackResult.resolve();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondHtml(res, 500, "Codex login", message);
    context.callbackResult.reject(error);
  }
}

async function exchangeCodeForTokens(options: {
  authBaseUrl: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  timeoutMs: number;
}): Promise<ExchangedTokens> {
  const response = await fetch(`${options.authBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: options.clientId,
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Token exchange failed with status ${response.status}: ${extractErrorMessage(responseText)}`,
    );
  }

  const parsed = tokenExchangeResponseSchema.parse(JSON.parse(responseText));
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    idToken: parsed.id_token,
    accountId: extractChatgptAccountId(parsed.id_token),
  };
}

async function writeAuthDocument(
  profileHome: string,
  tokens: ExchangedTokens,
): Promise<void> {
  await mkdir(profileHome, { recursive: true });
  await writeFile(
    join(profileHome, "auth.json"),
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: tokens.idToken,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          account_id: tokens.accountId,
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function buildAuthorizationUrl(options: {
  authBaseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  state: string;
  originator: string;
  allowedWorkspaceId: string | null;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scope,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: options.state,
    originator: options.originator,
  });
  if (options.allowedWorkspaceId) {
    params.set("allowed_workspace_id", options.allowedWorkspaceId);
  }
  return `${options.authBaseUrl}/oauth/authorize?${params.toString()}`;
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(32));
  return {
    verifier,
    challenge: toBase64Url(createHash("sha256").update(verifier, "utf8").digest()),
  };
}

function toBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("base64url");
}

function extractChatgptAccountId(idToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const parsed = jwtClaimsSchema.parse(payload);
    return parsed["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
  } catch {
    return null;
  }
}

function extractErrorMessage(responseText: string): string {
  try {
    const parsed = JSON.parse(responseText) as {
      error?: string | { message?: string; error_description?: string };
      error_description?: string;
      message?: string;
    };

    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
    if (
      parsed.error &&
      typeof parsed.error === "object" &&
      typeof parsed.error.message === "string" &&
      parsed.error.message.trim()
    ) {
      return parsed.error.message;
    }
    if (
      parsed.error &&
      typeof parsed.error === "object" &&
      typeof parsed.error.error_description === "string" &&
      parsed.error.error_description.trim()
    ) {
      return parsed.error.error_description;
    }
    if (typeof parsed.error_description === "string" && parsed.error_description.trim()) {
      return parsed.error_description;
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message;
    }
  } catch {
    // Fall through to the raw body.
  }

  return responseText.trim() || "unknown error";
}

async function readForcedWorkspaceId(profileHome: string): Promise<string | null> {
  try {
    const configText = await readFile(join(profileHome, "config.toml"), "utf8");
    const match = configText.match(/^\s*forced_chatgpt_workspace_id\s*=\s*"([^"]+)"/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

async function listenOnLoopback(server: ReturnType<typeof createServer>, preferredPort: number): Promise<number> {
  try {
    return await listen(server, preferredPort);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code !== "EADDRINUSE") {
      throw error;
    }
    return listen(server, 0);
  }
}

async function listen(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return actualPort(server);
}

function actualPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine the login callback port.");
  }
  return address.port;
}

function buildRedirectUri(port: number): string {
  return `http://localhost:${port}/auth/callback`;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function respondHtml(
  res: ServerResponse,
  statusCode: number,
  title: string,
  message: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Connection", "close");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
