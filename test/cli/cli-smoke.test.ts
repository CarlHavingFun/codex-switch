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
    "imports the current profile with an auto-generated name and shows the workspace title",
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
    const listed = await runCli(["list"], env);
    const status = await runCli(
      ["status", "--profile", "fixture@example.com__acct_cli"],
      env,
    );

    expect(listed.stdout).toContain("* fixture@example.com__acct_cli");
    expect(listed.stdout).toContain("Workspace Prime");
    expect(status.stdout).toContain("Logged in using ChatGPT");
    expect(status.stdout).toContain("fixture@example.com");
    expect(status.stdout).toContain("Workspace Prime");
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
      await mkdir(currentCodexHome, { recursive: true });
      await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");

      const env = {
        ...process.env,
        CODEX_SWITCH_HOME: managedHome,
        CODEX_SWITCH_CURRENT_CODEX_HOME: currentCodexHome,
        CODEX_SWITCH_CODEX_COMMAND: process.execPath,
        CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify([fakeCodexScript]),
      };

      await runCli(["login"], env);
      const listed = await runCli(["list"], env);

      expect(listed.stdout).toContain("* fixture@example.com__acct_fixture_login");
      expect(listed.stdout).toContain("Fixture Workspace");
      expect(
        JSON.parse(
          await readFile(join(managedHome, "profiles.json"), "utf8"),
        ) as { activeProfileId: string; profiles: Array<{ displayName: string }> },
      ).toMatchObject({
        activeProfileId: "fixture-example-com-acct-fixture-login",
        profiles: [{ displayName: "fixture@example.com__acct_fixture_login" }],
      });
    },
    20_000,
  );
});
