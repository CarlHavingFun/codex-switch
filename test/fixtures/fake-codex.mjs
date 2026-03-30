#!/usr/bin/env node

import { createInterface } from "node:readline";
import { join } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME ?? "";

function createChatgptJwt(params) {
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

async function main() {
  if (args[0] === "open-browser") {
    const url = args.at(-1) ?? "";
    const capturePath = process.env.FAKE_BROWSER_CAPTURE_PATH;
    const signalPath = process.env.FAKE_CODEX_ISOLATED_LOGIN_SIGNAL_PATH;

    if (capturePath) {
      await writeFile(
        capturePath,
        JSON.stringify(
          {
            args,
            url,
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    if (signalPath) {
      await writeFile(signalPath, "ready", "utf8");
    }
    return;
  }

  if (args[0] === "complete-login") {
    const url = args.at(-1) ?? "";
    const capturePath = process.env.FAKE_BROWSER_CAPTURE_PATH;
    const parsedUrl = new URL(url);
    const redirectUri = parsedUrl.searchParams.get("redirect_uri");
    const state = parsedUrl.searchParams.get("state");

    if (!redirectUri || !state) {
      throw new Error("Missing redirect_uri or state in auth URL.");
    }

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", process.env.FAKE_BROWSER_AUTH_CODE ?? "fixture-code");
    callbackUrl.searchParams.set("state", state);

    const callbackResponse = await fetch(callbackUrl, {
      redirect: "manual",
    });
    const callbackBody = await callbackResponse.text();

    if (capturePath) {
      await writeFile(
        capturePath,
        JSON.stringify(
          {
            args,
            url,
            callbackUrl: callbackUrl.toString(),
            callbackStatus: callbackResponse.status,
            callbackBody,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    return;
  }

  if (args.includes("--version")) {
    process.stdout.write("codex-cli 0.115.0\n");
    return;
  }

  if (args[0] === "login" && args[1] === "status") {
    const target = process.env.FAKE_CODEX_LOGIN_STATUS_STDERR === "1"
      ? process.stderr
      : process.stdout;
    target.write("Logged in using ChatGPT\n");
    return;
  }

  if (args[0] === "login") {
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "acct_fixture_login",
          access_token: "access",
          refresh_token: "refresh",
          id_token: createChatgptJwt({
            email: "fixture@example.com",
            accountId: "acct_fixture_login",
            organizations: [
              {
                id: "org-fixture-login",
                title: "Fixture Workspace",
                is_default: true,
                role: "owner",
              },
            ],
          }),
        },
      }),
      "utf8",
    );
    return;
  }

  if (args[0] === "app-server") {
    if (process.env.FAKE_CODEX_APPSERVER_FAIL === "1") {
      process.stderr.write("app-server unavailable");
      process.exit(3);
    }

    let initialized = process.env.FAKE_CODEX_REQUIRE_INIT_ACK !== "1";

    const rl = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        const respond = () => {
          initialized = true;
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                ok: true,
              },
            })}\n`,
          );
        };

        if (process.env.FAKE_CODEX_REQUIRE_INIT_ACK === "1") {
          setTimeout(respond, 25);
          return;
        }

        respond();
        return;
      }

      if (!initialized) {
        return;
      }

      if (message.method === "account/read") {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              account: {
                type: "chatgpt",
                email: "fixture@example.com",
                planType: "team",
              },
              requiresOpenaiAuth: false,
            },
          })}\n`,
        );
        return;
      }

      if (message.method === "account/rateLimits/read") {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              rateLimits: {
                limitId: "codex",
                limitName: "Codex",
                primary: {
                  usedPercent: 25,
                  windowDurationMins: 15,
                  resetsAt: 1730947200,
                },
                secondary: {
                  usedPercent: 5,
                  windowDurationMins: 1440,
                  resetsAt: 1731033600,
                },
                credits: {
                  hasCredits: true,
                  unlimited: false,
                  balance: "42.00",
                },
                planType: "team",
              },
              rateLimitsByLimitId: {
                codex: {
                  limitId: "codex",
                  limitName: "Codex",
                  primary: {
                    usedPercent: 25,
                    windowDurationMins: 15,
                    resetsAt: 1730947200,
                  },
                  secondary: {
                    usedPercent: 5,
                    windowDurationMins: 1440,
                    resetsAt: 1731033600,
                  },
                  credits: {
                    hasCredits: true,
                    unlimited: false,
                    balance: "42.00",
                  },
                  planType: "team",
                },
              },
            },
          })}\n`,
        );
        return;
      }

      if (message.method === "account/login/start") {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              type: "chatgpt",
              loginId: "fixture-login-id",
              authUrl:
                "https://auth.openai.com/oauth/authorize?client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid%20profile%20email&code_challenge=fixture&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=fixture-state&originator=Codex%20Desktop",
            },
          })}\n`,
        );

        const signalPath = process.env.FAKE_CODEX_ISOLATED_LOGIN_SIGNAL_PATH;
        if (signalPath) {
          void waitForSignal(signalPath).then(async () => {
            await mkdir(codexHome, { recursive: true });
            await writeFile(
              join(codexHome, "auth.json"),
              JSON.stringify({
                auth_mode: "chatgpt",
                tokens: {
                  account_id: "acct_fixture_login",
                  access_token: "access",
                  refresh_token: "refresh",
                  id_token: createChatgptJwt({
                    email: "fixture@example.com",
                    accountId: "acct_fixture_login",
                    organizations: [
                      {
                        id: "org-fixture-login",
                        title: "Fixture Workspace",
                        is_default: true,
                        role: "owner",
                      },
                    ],
                  }),
                },
              }),
              "utf8",
            );

            process.stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                method: "account/login/completed",
                params: {
                  loginId: "fixture-login-id",
                  success: true,
                  error: null,
                },
              })}\n`,
            );
            process.stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                method: "account/updated",
                params: {
                  authMode: "chatgpt",
                  planType: "team",
                },
              })}\n`,
            );
          });
        }
        return;
      }

      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Unknown method: ${message.method}`,
          },
        })}\n`,
      );
    });

    rl.on("close", () => {
      process.exit(0);
    });
    return;
  }

  const capturePath = process.env.FAKE_CODEX_CAPTURE_PATH;
  if (capturePath) {
    await writeFile(
      capturePath,
      JSON.stringify(
        {
          args,
          codexHome,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (args[0] === "fail-run") {
    process.exit(5);
  }
}

async function waitForSignal(signalPath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      await stat(signalPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for signal file: ${signalPath}`);
}

await main();
