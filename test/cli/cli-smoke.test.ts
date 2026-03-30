import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

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
      const loginSignalPath = join(rootDir, "default-login-signal.txt");
      await mkdir(currentCodexHome, { recursive: true });
      await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
        CODEX_SWITCH_BROWSER_COMMAND: process.execPath,
        CODEX_SWITCH_BROWSER_ARGS_JSON: JSON.stringify([fakeCodexScript, "open-browser", "{url}"]),
        FAKE_BROWSER_CAPTURE_PATH: browserCapturePath,
        FAKE_CODEX_ISOLATED_LOGIN_SIGNAL_PATH: loginSignalPath,
      };

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
      expect(browserCapture.url).toContain("https://auth.openai.com/oauth/authorize");
      expect(browserCapture.url).toContain("state=fixture-state");
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
      const loginSignalPath = join(rootDir, "isolated-login-signal.txt");
      await mkdir(currentCodexHome, { recursive: true });
      await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
        CODEX_SWITCH_BROWSER_COMMAND: process.execPath,
        CODEX_SWITCH_BROWSER_ARGS_JSON: JSON.stringify([fakeCodexScript, "open-browser", "{url}"]),
        FAKE_BROWSER_CAPTURE_PATH: browserCapturePath,
        FAKE_CODEX_ISOLATED_LOGIN_SIGNAL_PATH: loginSignalPath,
      };

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
      expect(browserCapture.url).toContain("https://auth.openai.com/oauth/authorize");
      expect(browserCapture.url).toContain("state=fixture-state");
    },
    20_000,
  );

  test(
    "sets and clears a manual workspace name for the active profile",
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

      await runCli(["import-current"], env);
      const setNamed = await runCli(
        ["workspace", "setname", "Leah Murray's Workspace"],
        env,
      );
      const listed = await runCli(["list"], env);
      const status = await runCli(["status", "--profile", "fixture@example.com__acct_cli"], env);
      const cleared = await runCli(["workspace", "clear"], env);
      const listedAfterClear = await runCli(["list"], env);

      expect(setNamed.stdout).toContain("Leah Murray's Workspace");
      expect(listed.stdout).toContain("Leah Murray's Workspace");
      expect(listed.stdout).not.toContain("Leah Murray's Workspace / Workspace Prime");
      expect(status.stdout).toContain("Workspace: Leah Murray's Workspace");
      expect(cleared.stdout).toContain("Cleared manual workspace name");
      expect(listedAfterClear.stdout).toContain("Workspace Prime");
    },
    20_000,
  );

  test(
    "reports managed desktop sync status as structured JSON",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-cli-"));
      const currentCodexHome = join(rootDir, "current");
      const managedHome = join(rootDir, "managed");
      await seedCurrentCodexHome(currentCodexHome);
      await mkdir(join(managedHome, "desktop"), { recursive: true });
      await writeFile(
        join(managedHome, "desktop", "status.json"),
        JSON.stringify(
          {
            managed: true,
            running: true,
            desktopPid: null,
            monitorPid: null,
            executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
            sessionHome: "C:\\Users\\<user>\\.codex-switch\\desktop\\session\\home",
            launchedAt: "2026-03-30T00:00:00.000Z",
            launchProfileId: "fixture-example-com-acct-cli",
            lastObservedAccountId: "acct_cli",
            lastObservedProfileId: "fixture-example-com-acct-cli",
            lastSyncedAt: "2026-03-30T00:01:00.000Z",
            lastError: null,
          },
          null,
          2,
        ),
        "utf8",
      );

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
      };

      const status = JSON.parse(
        (await runCli(["desktop", "status", "--json"], env)).stdout,
      ) as {
        managed: boolean;
        running: boolean;
        lastObservedAccountId: string | null;
        lastObservedProfileId: string | null;
      };

      expect(status).toMatchObject({
        managed: true,
        running: false,
        lastObservedAccountId: "acct_cli",
        lastObservedProfileId: "fixture-example-com-acct-cli",
      });
    },
    20_000,
  );
});
