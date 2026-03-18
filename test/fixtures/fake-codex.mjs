#!/usr/bin/env node

import { createInterface } from "node:readline";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

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
  if (args.includes("--version")) {
    process.stdout.write("codex-cli 0.115.0\n");
    return;
  }

  if (args[0] === "login" && args[1] === "status") {
    process.stdout.write("Logged in using ChatGPT\n");
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

    const rl = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              ok: true,
            },
          })}\n`,
        );
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
                primary: null,
                secondary: null,
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
                  primary: null,
                  secondary: null,
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

await main();
