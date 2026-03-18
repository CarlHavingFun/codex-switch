import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import type {
  CodexAccountSnapshot,
  CodexClient,
  CodexRateLimitSnapshot,
  CodexRunOptions,
} from "../../src/core/codex-client.js";
import { ProfileManager } from "../../src/core/profile-manager.js";
import { ProfileRegistry } from "../../src/core/profile-registry.js";
import { InMemorySecretStore } from "../../src/testing/in-memory-secret-store.js";

class FakeCodexClient implements CodexClient {
  readonly loginCalls: Array<{ profileHome: string }> = [];
  readonly runCalls: Array<{ args: string[]; options: CodexRunOptions }> = [];
  loginStatusOutput = "Logged in using ChatGPT";
  accountSnapshot: CodexAccountSnapshot | null = null;
  rateLimitSnapshot: CodexRateLimitSnapshot | null = null;
  onLogin?: (profileHome: string) => Promise<void>;
  onRun?: (args: string[], options: CodexRunOptions) => Promise<number>;

  async login(profileHome: string): Promise<void> {
    this.loginCalls.push({ profileHome });
    await this.onLogin?.(profileHome);
  }

  async run(args: string[], options: CodexRunOptions): Promise<number> {
    this.runCalls.push({ args, options });
    return this.onRun ? this.onRun(args, options) : 0;
  }

  async getLoginStatus(_profileHome: string): Promise<string> {
    return this.loginStatusOutput;
  }

  async getAccountSnapshot(_profileHome: string): Promise<CodexAccountSnapshot | null> {
    return this.accountSnapshot;
  }

  async getRateLimits(_profileHome: string): Promise<CodexRateLimitSnapshot | null> {
    return this.rateLimitSnapshot;
  }

  async doctor(): Promise<{ codexFound: boolean; version: string | null }> {
    return {
      codexFound: true,
      version: "codex-cli 0.115.0",
    };
  }
}

async function seedCurrentCodexHome(
  currentCodexHome: string,
  accountId: string,
  options: {
    email?: string;
    organizations?: Array<{
      id: string;
      title?: string;
      is_default?: boolean;
      role?: string;
    }>;
  } = {},
): Promise<void> {
  await mkdir(currentCodexHome, { recursive: true });
  await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");
  await writeFile(join(currentCodexHome, "history.jsonl"), "{}", "utf8");
  await writeFile(
    join(currentCodexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: accountId,
        access_token: "access",
        refresh_token: "refresh",
        id_token: createChatgptJwt({
          email: options.email ?? "user@example.com",
          accountId,
          organizations: options.organizations ?? [],
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

describe("ProfileManager", () => {
  test("imports the current Codex home into an isolated managed profile", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });

    await seedCurrentCodexHome(currentCodexHome, "acct_import");

    const profile = await manager.importCurrent("work", {
      workspaceLabel: "Workspace A",
    });

    expect(profile.displayName).toBe("work");
    expect(profile.authMode).toBe("chatgpt");
    expect(profile.accountId).toBe("acct_import");
    expect(profile.workspaceLabel).toBe("Workspace A");
    expect(profile.isActive).toBe(true);
    expect(await secretStore.load(profile.id)).toContain("\"acct_import\"");
    await expect(readFile(join(profile.codexHome, "config.toml"), "utf8")).resolves.toContain(
      "gpt-5",
    );
    expect(existsSync(join(profile.codexHome, "auth.json"))).toBe(false);
  });

  test("auto-generates a profile name from email and chatgpt account id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });

    await seedCurrentCodexHome(currentCodexHome, "acct_auto", {
      email: "person@example.com",
      organizations: [
        {
          id: "org-123",
          title: "Workspace Prime",
          is_default: true,
          role: "owner",
        },
      ],
    });

    const profile = await manager.importCurrent(undefined, {
      workspaceLabel: "Manual Label",
    });

    expect(profile.displayName).toBe("person@example.com__acct_auto");
    expect(profile.accountId).toBe("acct_auto");
    expect(profile.workspaceLabel).toBe("Manual Label");
    expect(profile.workspaceObserved).toBe("Workspace Prime");
  });

  test("deduplicates imports by chatgpt account id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });

    await seedCurrentCodexHome(currentCodexHome, "acct_dedupe", {
      email: "person@example.com",
      organizations: [{ id: "org-1", title: "Workspace One", is_default: true }],
    });

    const first = await manager.importCurrent(undefined);

    await seedCurrentCodexHome(currentCodexHome, "acct_dedupe", {
      email: "person@example.com",
      organizations: [{ id: "org-2", title: "Workspace Two", is_default: true }],
    });

    const second = await manager.importCurrent("custom-name", {
      workspaceLabel: "Manual Label",
    });
    const profiles = await manager.list();

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe(first.displayName);
    expect(second.workspaceLabel).toBe("Manual Label");
    expect(second.workspaceObserved).toBe("Workspace Two");
    expect(profiles).toHaveLength(1);
  });

  test("runs Codex under the selected profile and re-persists auth afterwards", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const codexClient = new FakeCodexClient();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient,
      rootDir,
      currentCodexHome,
    });

    await seedCurrentCodexHome(currentCodexHome, "acct_before_run");
    const profile = await manager.importCurrent("work");

    codexClient.onRun = async (_args, options) => {
      const authOnDisk = await readFile(
        join(String(options.env.CODEX_HOME), "auth.json"),
        "utf8",
      );
      expect(authOnDisk).toContain("\"acct_before_run\"");
      await writeFile(
        join(String(options.env.CODEX_HOME), "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct_after_run",
            access_token: "access",
            refresh_token: "refresh",
            id_token: "id",
          },
        }),
        "utf8",
      );
      return 0;
    };

    const exitCode = await manager.run({
      profileName: "work",
      args: ["--version"],
    });

    expect(exitCode).toBe(0);
    expect(codexClient.runCalls[0]?.args).toEqual(["--version"]);
    expect(codexClient.runCalls[0]?.options.env.CODEX_HOME).toBe(profile.codexHome);
    await expect(secretStore.load(profile.id)).resolves.toContain("\"acct_after_run\"");
    expect(existsSync(join(profile.codexHome, "auth.json"))).toBe(false);
  });

  test("creates a fresh profile through codex login and makes it active", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const codexClient = new FakeCodexClient();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient,
      rootDir,
      currentCodexHome,
    });

    await mkdir(currentCodexHome, { recursive: true });
    await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");
    codexClient.onLogin = async (profileHome) => {
      await writeFile(
        join(profileHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct_login",
            access_token: "access",
            refresh_token: "refresh",
            id_token: "id",
          },
        }),
        "utf8",
      );
    };

    const profile = await manager.login("workspace-b");

    expect(codexClient.loginCalls).toHaveLength(1);
    expect(profile.displayName).toBe("workspace-b");
    expect(profile.accountId).toBe("acct_login");
    expect(profile.isActive).toBe(true);
    await expect(registry.getActiveProfile()).resolves.toMatchObject({
      id: profile.id,
    });
  });

  test("login auto-names from account metadata when no profile name is provided", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const codexClient = new FakeCodexClient();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient,
      rootDir,
      currentCodexHome,
    });

    await mkdir(currentCodexHome, { recursive: true });
    await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");
    codexClient.onLogin = async (profileHome) => {
      await writeFile(
        join(profileHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct_login",
            access_token: "access",
            refresh_token: "refresh",
            id_token: createChatgptJwt({
              email: "person@example.com",
              accountId: "acct_login",
              organizations: [
                {
                  id: "org-login",
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
    };

    const profile = await manager.login(undefined);

    expect(codexClient.loginCalls).toHaveLength(1);
    expect(profile.displayName).toBe("person@example.com__acct_login");
    expect(profile.accountId).toBe("acct_login");
    expect(profile.workspaceObserved).toBe("Workspace Prime");
    expect(profile.isActive).toBe(true);
    await expect(registry.getActiveProfile()).resolves.toMatchObject({
      id: profile.id,
    });
  });

  test("login reuses the stored profile for the same chatgpt account id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const codexClient = new FakeCodexClient();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient,
      rootDir,
      currentCodexHome,
    });

    await mkdir(currentCodexHome, { recursive: true });
    await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");
    codexClient.onLogin = async (profileHome) => {
      await writeFile(
        join(profileHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct_login",
            access_token: "access",
            refresh_token: "refresh",
            id_token: createChatgptJwt({
              email: "person@example.com",
              accountId: "acct_login",
              organizations: [
                {
                  id: "org-login-1",
                  title: "Workspace One",
                  is_default: true,
                  role: "owner",
                },
              ],
            }),
          },
        }),
        "utf8",
      );
    };

    const first = await manager.login(undefined);

    codexClient.onLogin = async (profileHome) => {
      await writeFile(
        join(profileHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct_login",
            access_token: "access-2",
            refresh_token: "refresh-2",
            id_token: createChatgptJwt({
              email: "person@example.com",
              accountId: "acct_login",
              organizations: [
                {
                  id: "org-login-2",
                  title: "Workspace Two",
                  is_default: true,
                  role: "owner",
                },
              ],
            }),
          },
        }),
        "utf8",
      );
    };

    const second = await manager.login("custom-name");
    const profiles = await manager.list();

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe(first.displayName);
    expect(second.accountId).toBe("acct_login");
    expect(second.workspaceObserved).toBe("Workspace Two");
    expect(profiles).toHaveLength(1);
  });

  test("login resolves the final managed profile from a temporary sandbox", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const codexClient = new FakeCodexClient();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient,
      rootDir,
      currentCodexHome,
    });

    await mkdir(currentCodexHome, { recursive: true });
    await writeFile(join(currentCodexHome, "config.toml"), 'model = "gpt-5"', "utf8");

    let sandboxHome: string | null = null;
    let profilesDuringLogin = 0;
    codexClient.onLogin = async (profileHome) => {
      sandboxHome = profileHome;
      profilesDuringLogin = (await manager.list()).length;
      expect(profileHome.startsWith(join(rootDir, "tmp"))).toBe(true);

      await writeFile(
        join(profileHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct_login_temp",
            access_token: "access",
            refresh_token: "refresh",
            id_token: createChatgptJwt({
              email: "person@example.com",
              accountId: "acct_login_temp",
              organizations: [
                {
                  id: "org-login-temp",
                  title: "Workspace Temp",
                  is_default: true,
                  role: "owner",
                },
              ],
            }),
          },
        }),
        "utf8",
      );
    };

    const profile = await manager.login(undefined);

    expect(profilesDuringLogin).toBe(0);
    expect(profile.codexHome).toBe(join(rootDir, "profiles", profile.id, "home"));
    expect(sandboxHome).not.toBeNull();
    expect(profile.codexHome).not.toBe(sandboxHome);
    expect(existsSync(String(sandboxHome))).toBe(false);
    expect(existsSync(dirname(String(sandboxHome)))).toBe(false);
  });

  test("collects status using login output and app-server metadata when available", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const codexClient = new FakeCodexClient();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient,
      rootDir,
      currentCodexHome,
    });

    await seedCurrentCodexHome(currentCodexHome, "acct_status");
    const profile = await manager.importCurrent("work");
    codexClient.accountSnapshot = {
      requiresOpenaiAuth: false,
      account: {
        type: "chatgpt",
        email: "person@example.com",
        planType: "team",
      },
    };
    codexClient.rateLimitSnapshot = {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: null,
        secondary: null,
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "12.00",
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
            balance: "12.00",
          },
          planType: "team",
        },
      },
    };

    const status = await manager.status({ profileName: "work" });

    expect(status.profile.id).toBe(profile.id);
    expect(status.loginStatus).toBe("Logged in using ChatGPT");
    expect(status.account?.email).toBe("person@example.com");
    expect(status.rateLimits?.rateLimits.credits?.balance).toBe("12.00");
    expect(status.profile.planType).toBe("team");
    expect(status.profile.lastVerifiedAt).not.toBeNull();
  });

  test("switches the active profile explicitly", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-manager-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const manager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });

    await seedCurrentCodexHome(currentCodexHome, "acct_work");
    await manager.importCurrent("work");
    await seedCurrentCodexHome(currentCodexHome, "acct_personal");
    await manager.importCurrent("personal");

    const active = await manager.use("work");

    expect(active.displayName).toBe("work");
    await expect(registry.getActiveProfile()).resolves.toMatchObject({
      displayName: "work",
      isActive: true,
    });
  });
});
