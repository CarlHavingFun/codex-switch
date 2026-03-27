import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface ChatgptJwtOrganization {
  id: string;
  title?: string;
  is_default?: boolean;
  role?: string;
}

export interface OAuthTestServerOptions {
  email?: string;
  accountId?: string;
  organizations?: ChatgptJwtOrganization[];
  accessToken?: string;
  refreshToken?: string;
}

export interface OAuthTestRequest {
  method: string;
  path: string;
  body: string;
}

export interface OAuthTestServerHandle {
  baseUrl: string;
  requests: OAuthTestRequest[];
  close(): Promise<void>;
}

export function createChatgptJwt(params: {
  email: string;
  accountId: string;
  organizations: ChatgptJwtOrganization[];
}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      email: params.email,
      "https://api.openai.com/auth": {
        chatgpt_account_id: params.accountId,
        organizations: params.organizations,
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

export async function startOAuthTestServer(
  options: OAuthTestServerOptions = {},
): Promise<OAuthTestServerHandle> {
  const requests: OAuthTestRequest[] = [];
  const email = options.email ?? "fixture@example.com";
  const accountId = options.accountId ?? "acct_fixture_login";
  const organizations = options.organizations ?? [
    {
      id: "org-fixture-login",
      title: "Fixture Workspace",
      is_default: true,
      role: "owner",
    },
  ];
  const accessToken = options.accessToken ?? "access";
  const refreshToken = options.refreshToken ?? "refresh";

  const server = createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body,
    });

    if (req.method === "POST" && req.url === "/oauth/token") {
      respondJson(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: createChatgptJwt({
          email,
          accountId,
          organizations,
        }),
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }

    respondJson(res, 404, {
      error: {
        code: "not_found",
        message: "unknown endpoint",
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth test server did not return a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respondJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}
