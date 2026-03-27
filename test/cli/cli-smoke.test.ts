import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { startOAuthTestServer } from "../helpers/oauth-test-server.js";

const cliEntrypoint = join(process.cwd(), "src", "cli.ts");
const fakeCodexScript = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");

async function seedCurrentCodexHome(currentCodexHome: string): Promise<void> {
  await mkdir(currentCodexHome, { recursive: true });
  await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");
  await writeFile(
    join(currentCodexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct_cli",
        access_token: "access",
        refresh_token: "refresh",
        id_token: createChatgptJwt({
          email: "fixture@example.com",
          accountId: "acct_cli",
          organizations: [
            {
              id: "org-123",
              title: "Workspace Prime",
              is_default: true,
              role: "owner",
            },
          ],
        }),
      },
    }),
    "utf8",
  );
}

function createChatgptJwt(params: {
  email: string;
  accountId: string;
  organizations: Array<{
    id: string;
    title?: string;
    is_default?: boolean;
    role?: string;
  }>;
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

async function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return execa(process.execPath, ["--import", "tsx", cliEntrypoint, ...args], {
    env,
  });
}

describe("codex-switch CLI", () => {
  test(
    "emits structured JSON for import-current, list, status, use, and sync-current",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-cli-"));
      const currentCodexHome = join(rootDir, "current");
      const managedHome = join(rootDir, "managed");
      await seedCurrentCodexHome(currentCodexHome);

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
      };

      const imported = JSON.parse((await runCli(["import-current", "--json"], env)).stdout) as {
        displayName: string;
        authFingerprint: string;
      };
      const listed = JSON.parse((await runCli(["list", "--json"], env)).stdout) as Array<{
        displayName: string;
        isActive: boolean;
      }>;
      const status = JSON.parse(
        (await runCli(
          ["status", "--profile", "fixture@example.com__acct_cli", "--json"],
          env,
        )).stdout,
      ) as {
        profile: {
          displayName: string;
        };
        usageSummary: {
          usageKind: string;
          creditsBalance: string | null;
          primaryRemainingPercent: number | null;
        };
      };
      const active = JSON.parse(
        (await runCli(["use", "fixture@example.com__acct_cli", "--json"], env)).stdout,
      ) as {
        displayName: string;
        isActive: boolean;
      };
      const synced = JSON.parse((await runCli(["sync-current", "--json"], env)).stdout) as {
        action: string;
        profile: {
          displayName: string;
        };
      };

      expect(imported.displayName).toBe("fixture@example.com__acct_cli");
      expect(imported.authFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(listed).toEqual([
        expect.objectContaining({
          displayName: "fixture@example.com__acct_cli",
          isActive: true,
        }),
      ]);
      expect(status.profile.displayName).toBe("fixture@example.com__acct_cli");
      expect(status.usageSummary).toMatchObject({
        usageKind: "credits",
        creditsBalance: "42.00",
        primaryRemainingPercent: 75,
      });
      expect(active).toMatchObject({
        displayName: "fixture@example.com__acct_cli",
        isActive: true,
      });
      expect(synced).toMatchObject({
        action: "noop",
        profile: {
          displayName: "fixture@example.com__acct_cli",
        },
      });
    },
    20_000,
  );

  test(
    "imports the current profile with an auto-generated name and shows the workspace title",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-cli-"));
      const currentCodexHome = join(rootDir, "current");
      const managedHome = join(rootDir, "managed");
      const expectedProfilePath = join(
        managedHome,
        "profiles",
        "fixture-example-com-acct-cli",
        "home",
      );
      await seedCurrentCodexHome(currentCodexHome);

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
      };

      await runCli(["import-current"], env);
      const listed = await runCli(["list"], env);
      const status = await runCli(
        ["status", "--profile", "fixture@example.com__acct_cli"],
        env,
      );

      expect(listed.stdout).toContain("* fixture@example.com__acct_cli");
      expect(listed.stdout).toContain("Workspace Prime");
      expect(listed.stdout).toContain(`Path: ${expectedProfilePath}`);
      expect(status.stdout).toContain("Logged in using ChatGPT");
      expect(status.stdout).toContain("fixture@example.com");
      expect(status.stdout).toContain("Workspace Prime");
      expect(status.stdout).toContain(`Path: ${expectedProfilePath}`);
      expect(
        JSON.parse(
          await readFile(join(managedHome, "profiles.json"), "utf8"),
        ) as { activeProfileId: string; profiles: Array<{ displayName: string }> },
      ).toMatchObject({
        activeProfileId: "fixture-example-com-acct-cli",
        profiles: [{ displayName: "fixture@example.com__acct_cli" }],
      });
    },
    20_000,
  );

  test(
    "logs in without a profile name and auto-detects the account and workspace",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-cli-"));
      const currentCodexHome = join(rootDir, "current");
      const managedHome = join(rootDir, "managed");
      const browserCapturePath = join(rootDir, "browser-default.json");
      const oauthServer = await startOAuthTestServer();
      await mkdir(currentCodexHome, { recursive: true });
      await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
        CODEX_SWITCH_AUTH_BASE_URL: oauthServer.baseUrl,
        CODEX_SWITCH_BROWSER_COMMAND: process.execPath,
        CODEX_SWITCH_BROWSER_ARGS_JSON: JSON.stringify([fakeCodexScript, "complete-login", "{url}"]),
        FAKE_BROWSER_CAPTURE_PATH: browserCapturePath,
      };

      try {
        const loggedIn = JSON.parse((await runCli(["login", "--json"], env)).stdout) as {
          displayName: string;
          workspaceObserved: string | null;
          authFingerprint: string;
        };
        const listed = await runCli(["list"], env);
        const browserCapture = JSON.parse(await readFile(browserCapturePath, "utf8")) as {
          url: string;
        };

        expect(loggedIn).toMatchObject({
          displayName: "fixture@example.com__acct_fixture_login",
          workspaceObserved: "Fixture Workspace",
        });
        expect(loggedIn.authFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(listed.stdout).toContain("* fixture@example.com__acct_fixture_login");
        expect(listed.stdout).toContain("Fixture Workspace");
        expect(browserCapture.url).toContain(`${oauthServer.baseUrl}/oauth/authorize`);
        expect(
          JSON.parse(
            await readFile(join(managedHome, "profiles.json"), "utf8"),
          ) as {
            activeProfileId: string;
            profiles: Array<{ displayName: string; authFingerprint: string | null }>;
          },
        ).toMatchObject({
          activeProfileId: "fixture-example-com-acct-fixture-login",
          profiles: [
            {
              displayName: "fixture@example.com__acct_fixture_login",
              authFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          ],
        });
      } finally {
        await oauthServer.close();
      }
    },
    20_000,
  );

  test(
    "logs in with --native-browser to bypass the Windows isolated-browser default",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-cli-"));
      const currentCodexHome = join(rootDir, "current");
      const managedHome = join(rootDir, "managed");
      await mkdir(currentCodexHome, { recursive: true });
      await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
      };

      const loggedIn = JSON.parse(
        (await runCli(["login", "--native-browser", "--json"], env)).stdout,
      ) as {
        displayName: string;
        workspaceObserved: string | null;
      };

      expect(loggedIn).toMatchObject({
        displayName: "fixture@example.com__acct_fixture_login",
        workspaceObserved: "Fixture Workspace",
      });
    },
    20_000,
  );

  test(
    "logs in with --isolated-browser and routes the auth URL through the configured browser command",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-cli-"));
      const currentCodexHome = join(rootDir, "current");
      const managedHome = join(rootDir, "managed");
      const browserCapturePath = join(rootDir, "browser.json");
      const oauthServer = await startOAuthTestServer();
      await mkdir(currentCodexHome, { recursive: true });
      await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
        CODEX_SWITCH_AUTH_BASE_URL: oauthServer.baseUrl,
        CODEX_SWITCH_BROWSER_COMMAND: process.execPath,
        CODEX_SWITCH_BROWSER_ARGS_JSON: JSON.stringify([fakeCodexScript, "complete-login", "{url}"]),
        FAKE_BROWSER_CAPTURE_PATH: browserCapturePath,
      };

      try {
        const loggedIn = JSON.parse(
          (await runCli(["login", "--isolated-browser", "--json"], env)).stdout,
        ) as {
          displayName: string;
          workspaceObserved: string | null;
        };
        const browserCapture = JSON.parse(await readFile(browserCapturePath, "utf8")) as {
          url: string;
        };

        expect(loggedIn).toMatchObject({
          displayName: "fixture@example.com__acct_fixture_login",
          workspaceObserved: "Fixture Workspace",
        });
        expect(browserCapture.url).toContain(`${oauthServer.baseUrl}/oauth/authorize`);
      } finally {
        await oauthServer.close();
      }
    },
    20_000,
  );
});
