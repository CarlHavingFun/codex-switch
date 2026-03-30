import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import { describe, expect, test } from "vitest";

import { CodexProcessClient } from "../../src/core/codex-process-client.js";
import { selectWindowsSpawnCommand } from "../../src/core/spawn-command.js";
import { startOAuthTestServer } from "../helpers/oauth-test-server.js";

const fakeCodexScript = join(
  process.cwd(),
  "test",
  "fixtures",
  "fake-codex.mjs",
);

function createClient() {
  return new CodexProcessClient({
    command: process.execPath,
    commandArgs: [fakeCodexScript],
  });
}

async function waitForFile(targetPath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await stat(targetPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for file: ${targetPath}`);
}

describe("CodexProcessClient", () => {
  test("prefers a spawnable Windows executable over extensionless PATH matches", () => {
    expect(
      selectWindowsSpawnCommand([
        "C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd",
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe",
      ]),
    ).toBe("C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe");

    expect(
      selectWindowsSpawnCommand([
        "C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd",
      ]),
    ).toBe("C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd");
  });

  test("reads login status and doctor information from the real codex process interface", async () => {
    const client = createClient();

    await expect(client.getLoginStatus("D:/profile-home")).resolves.toBe(
      "Logged in using ChatGPT",
    );
    await expect(client.doctor()).resolves.toEqual({
      codexFound: true,
      version: "codex-cli 0.115.0",
    });
  });

  test("falls back to stderr when codex login status writes the message there", async () => {
    const client = new CodexProcessClient({
      command: process.execPath,
      commandArgs: [fakeCodexScript],
      env: {
        ...process.env,
        FAKE_CODEX_LOGIN_STATUS_STDERR: "1",
      },
    });

    await expect(client.getLoginStatus("D:/profile-home")).resolves.toBe(
      "Logged in using ChatGPT",
    );
  });

  test("parses account and rate-limit data from the app-server bridge", async () => {
    const client = createClient();

    await expect(client.getAccountSnapshot("D:/profile-home")).resolves.toEqual({
      account: {
        type: "chatgpt",
        email: "fixture@example.com",
        planType: "team",
      },
      requiresOpenaiAuth: false,
    });
    await expect(client.getRateLimits("D:/profile-home")).resolves.toMatchObject({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 25,
          windowDurationMins: 15,
          resetsAt: 1_730_947_200,
        },
        secondary: {
          usedPercent: 5,
          windowDurationMins: 1_440,
          resetsAt: 1_731_033_600,
        },
        credits: {
          balance: "42.00",
        },
      },
    });
  });

  test("waits for initialize before sending app-server RPC methods", async () => {
    const client = new CodexProcessClient({
      command: process.execPath,
      commandArgs: [fakeCodexScript],
      env: {
        ...process.env,
        FAKE_CODEX_REQUIRE_INIT_ACK: "1",
      },
    });

    await expect(client.getAccountSnapshot("D:/profile-home")).resolves.toEqual({
      account: {
        type: "chatgpt",
        email: "fixture@example.com",
        planType: "team",
      },
      requiresOpenaiAuth: false,
    });
  });

  test("runs Codex with the caller-provided environment and returns the exit code", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "codex-switch-client-"));
    const capturePath = join(captureDir, "run.json");
    const client = createClient();

    const exitCode = await client.run(["noop"], {
      env: {
        ...process.env,
        CODEX_HOME: "D:/managed-profile",
        FAKE_CODEX_CAPTURE_PATH: capturePath,
      },
    });

    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      codexHome: string;
    };

    expect(exitCode).toBe(0);
    expect(captured.args).toEqual(["noop"]);
    expect(captured.codexHome).toBe("D:/managed-profile");
  });

  test("degrades to null when the app-server bridge is unavailable", async () => {
    const client = new CodexProcessClient({
      command: process.execPath,
      commandArgs: [fakeCodexScript],
      env: {
        ...process.env,
        FAKE_CODEX_APPSERVER_FAIL: "1",
      },
    });

    await expect(client.getAccountSnapshot("D:/profile-home")).resolves.toBeNull();
    await expect(client.getRateLimits("D:/profile-home")).resolves.toBeNull();
  });

  test(
    "logs in through the isolated browser strategy using the self-managed OAuth flow",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-isolated-"));
      const profileHome = join(rootDir, "profile-home");
      const browserCapturePath = join(rootDir, "browser.json");
      const oauthServer = await startOAuthTestServer();
      const client = new CodexProcessClient({
        command: process.execPath,
        commandArgs: [fakeCodexScript],
        env: {
          ...process.env,
          CODEX_SWITCH_AUTH_BASE_URL: oauthServer.baseUrl,
          CODEX_SWITCH_BROWSER_COMMAND: process.execPath,
          CODEX_SWITCH_BROWSER_ARGS_JSON: JSON.stringify([fakeCodexScript, "complete-login", "{url}"]),
          FAKE_BROWSER_CAPTURE_PATH: browserCapturePath,
        },
      });

      try {
        await client.login(profileHome, {
          browserStrategy: "isolated",
        });

        await waitForFile(browserCapturePath, 5_000);
        const browserCapture = JSON.parse(await readFile(browserCapturePath, "utf8")) as {
          url: string;
          callbackUrl: string;
          callbackStatus: number;
        };
        const authDocument = JSON.parse(
          await readFile(join(profileHome, "auth.json"), "utf8"),
        ) as {
          auth_mode: string;
          OPENAI_API_KEY: null;
          tokens: {
            account_id: string;
          };
        };

        expect(browserCapture.url).toContain(`${oauthServer.baseUrl}/oauth/authorize`);
        expect(new URL(browserCapture.callbackUrl).pathname).toBe("/auth/callback");
        expect(browserCapture.callbackStatus).toBe(200);
        expect(authDocument.auth_mode).toBe("chatgpt");
        expect(authDocument.OPENAI_API_KEY).toBeNull();
        expect(authDocument.tokens.account_id).toBe("acct_fixture_login");
        expect(oauthServer.requests).toContainEqual(
          expect.objectContaining({
            method: "POST",
            path: "/oauth/token",
          }),
        );
        expect(oauthServer.requests[0]?.body).toContain("grant_type=authorization_code");
      } finally {
        await oauthServer.close();
      }
    },
    20_000,
  );
});
