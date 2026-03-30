import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import { DesktopManager, type DesktopProcessAdapter } from "../../src/core/desktop-manager.js";
import { DesktopStateStore } from "../../src/core/desktop-state-store.js";
import { ProfileManager } from "../../src/core/profile-manager.js";
import { ProfileRegistry } from "../../src/core/profile-registry.js";
import { InMemorySecretStore } from "../../src/testing/in-memory-secret-store.js";
import type {
  CodexAccountSnapshot,
  CodexClient,
  CodexRateLimitSnapshot,
  CodexRunOptions,
} from "../../src/core/codex-client.js";

class FakeCodexClient implements CodexClient {
  readonly loginCalls: Array<{ profileHome: string }> = [];
  readonly runCalls: Array<{ args: string[]; options: CodexRunOptions }> = [];
  loginStatusOutput = "Logged in using ChatGPT";
  accountSnapshot: CodexAccountSnapshot | null = null;
  rateLimitSnapshot: CodexRateLimitSnapshot | null = null;
  onLogin?: (profileHome: string) => Promise<void>;

  async login(profileHome: string): Promise<void> {
    this.loginCalls.push({ profileHome });
    await this.onLogin?.(profileHome);
  }

  async run(args: string[], options: CodexRunOptions): Promise<number> {
    this.runCalls.push({ args, options });
    return 0;
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

class FakeDesktopProcessAdapter implements DesktopProcessAdapter {
  readonly desktopLaunches: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd?: string;
  }> = [];
  readonly monitorLaunches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  readonly terminatedPids: number[] = [];

  constructor(
    private readonly pidState: {
      desktopPid?: number | null;
      monitorPid?: number | null;
      runningPids?: number[];
    } = {},
  ) {}

  async launchDesktop(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ): Promise<number | null> {
    this.desktopLaunches.push({ command, args, env, cwd });
    return this.pidState.desktopPid ?? 101;
  }

  async launchMonitor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<number | null> {
    this.monitorLaunches.push({ command, args, env });
    return this.pidState.monitorPid ?? 202;
  }

  isProcessRunning(pid: number | null): boolean {
    if (pid === null) {
      return false;
    }

    return (this.pidState.runningPids ?? [101, 202]).includes(pid);
  }

  async terminateProcess(pid: number | null): Promise<void> {
    if (pid !== null) {
      this.terminatedPids.push(pid);
    }
  }
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

async function seedCodexHome(
  codexHome: string,
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
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.4"', "utf8");
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: accountId,
        access_token: "access",
        refresh_token: "refresh",
        id_token: createChatgptJwt({
          email: options.email ?? "fixture@example.com",
          accountId,
          organizations:
            options.organizations ?? [
              {
                id: accountId,
                title: "Workspace",
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

describe("DesktopManager", () => {
  test("launches Codex desktop with a managed session home and records running state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-desktop-"));
    const currentCodexHome = join(rootDir, "current");
    const workingDirectory = join(rootDir, "desktop-workdir");
    await mkdir(workingDirectory, { recursive: true });
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const profileManager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });
    const stateStore = new DesktopStateStore(rootDir);
    const processAdapter = new FakeDesktopProcessAdapter();
    const desktopManager = new DesktopManager({
      rootDir,
      profileManager,
      stateStore,
      processAdapter,
      desktopCommand: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
      desktopWorkingDirectory: workingDirectory,
      desktopProxyUrl: "http://proxy.example:8080",
      monitorPollIntervalMs: 60_000,
      platform: "win32",
    });

    await seedCodexHome(currentCodexHome, "acct_launch", {
      organizations: [{ id: "acct_launch", title: "Launch Workspace", is_default: true }],
    });
    const activeProfile = await profileManager.importCurrent("launch-profile", {
      workspaceLabel: "Launch Workspace",
    });

    const status = await desktopManager.launch({
      selfCommand: process.execPath,
      selfArgs: ["monitor-script.js"],
    });

    expect(processAdapter.desktopLaunches).toHaveLength(1);
    expect(processAdapter.monitorLaunches).toHaveLength(1);
    expect(processAdapter.desktopLaunches[0]?.env.CODEX_HOME).toBe(
      join(rootDir, "desktop", "session", "home"),
    );
    expect(processAdapter.desktopLaunches[0]?.env.HTTP_PROXY).toBe(
      "http://proxy.example:8080",
    );
    expect(processAdapter.desktopLaunches[0]?.env.HTTPS_PROXY).toBe(
      "http://proxy.example:8080",
    );
    expect(processAdapter.desktopLaunches[0]?.env.http_proxy).toBe(
      "http://proxy.example:8080",
    );
    expect(processAdapter.desktopLaunches[0]?.env.https_proxy).toBe(
      "http://proxy.example:8080",
    );
    expect(processAdapter.desktopLaunches[0]?.cwd).toBe(workingDirectory);
    expect(processAdapter.monitorLaunches[0]?.args).toContain("desktop");
    expect(processAdapter.monitorLaunches[0]?.args).toContain("--poll-interval-ms");
    expect(processAdapter.monitorLaunches[0]?.args).toContain("60000");
    expect(existsSync(join(rootDir, "desktop", "session", "home", "auth.json"))).toBe(true);
    expect(status.running).toBe(true);
    expect(status.desktopPid).toBe(101);
    expect(status.monitorPid).toBe(202);
    expect(status.launchProfileId).toBe(activeProfile.id);
  });

  test("syncs a managed desktop session into profiles and auto-switches the active profile", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-desktop-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const profileManager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });
    const stateStore = new DesktopStateStore(rootDir);
    const processAdapter = new FakeDesktopProcessAdapter({
      desktopPid: 333,
      monitorPid: 444,
      runningPids: [333, 444],
    });
    const desktopManager = new DesktopManager({
      rootDir,
      profileManager,
      stateStore,
      processAdapter,
      desktopCommand: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
      platform: "win32",
    });

    await seedCodexHome(currentCodexHome, "acct_old", {
      organizations: [{ id: "acct_old", title: "Old Workspace", is_default: true }],
    });
    const oldProfile = await profileManager.importCurrent("old-profile");

    const sessionHome = join(rootDir, "desktop", "session", "home");
    await seedCodexHome(sessionHome, "acct_new", {
      email: "new@example.com",
      organizations: [{ id: "acct_new", title: "New Workspace", is_default: true }],
    });
    await stateStore.write({
      managed: true,
      running: true,
      desktopPid: 333,
      monitorPid: 444,
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
      sessionHome,
      launchedAt: "2026-03-30T00:00:00.000Z",
      launchProfileId: oldProfile.id,
      lastObservedAccountId: oldProfile.accountId,
      lastObservedProfileId: oldProfile.id,
      lastSyncedAt: "2026-03-30T00:00:00.000Z",
      lastError: null,
    });

    const status = await desktopManager.syncSession();
    const profiles = await profileManager.list();
    const activeProfile = await registry.getActiveProfile();

    expect(profiles).toHaveLength(2);
    expect(activeProfile?.accountId).toBe("acct_new");
    expect(activeProfile?.displayName).toBe("new@example.com__acct_new");
    expect(status.lastObservedAccountId).toBe("acct_new");
    expect(status.lastObservedProfileId).toBe(activeProfile?.id ?? null);
    expect(status.running).toBe(true);
  });

  test("switches the managed desktop to another profile by restarting the desktop session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-desktop-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const profileManager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });
    const stateStore = new DesktopStateStore(rootDir);
    const processAdapter = new FakeDesktopProcessAdapter({
      desktopPid: 333,
      monitorPid: 444,
      runningPids: [333, 444],
    });
    const desktopManager = new DesktopManager({
      rootDir,
      profileManager,
      stateStore,
      processAdapter,
      desktopCommand: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
      monitorPollIntervalMs: 60_000,
      platform: "win32",
    });

    await seedCodexHome(currentCodexHome, "acct_a", {
      email: "one@example.com",
      organizations: [{ id: "acct_a", title: "Workspace A", is_default: true }],
    });
    await profileManager.importCurrent();

    const secondHome = join(rootDir, "second");
    await seedCodexHome(secondHome, "acct_b", {
      email: "two@example.com",
      organizations: [{ id: "acct_b", title: "Workspace B", is_default: true }],
    });
    const secondProfile = await profileManager.syncHome(secondHome);

    await stateStore.write({
      managed: true,
      running: true,
      desktopPid: 333,
      monitorPid: 444,
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
      sessionHome: join(rootDir, "desktop", "session", "home"),
      launchedAt: "2026-03-30T00:00:00.000Z",
      launchProfileId: (await registry.getActiveProfile())?.id ?? null,
      lastObservedAccountId: "acct_a",
      lastObservedProfileId: (await registry.getActiveProfile())?.id ?? null,
      lastSyncedAt: "2026-03-30T00:00:00.000Z",
      lastError: null,
    });

    const status = await desktopManager.switchProfile({
      profileName: secondProfile.profile?.displayName ?? "two@example.com__acct_b",
      selfCommand: process.execPath,
      selfArgs: ["monitor-script.js"],
    });

    expect(processAdapter.terminatedPids).toEqual([444, 333]);
    expect(processAdapter.desktopLaunches).toHaveLength(1);
    expect(processAdapter.monitorLaunches).toHaveLength(1);
    expect((await registry.getActiveProfile())?.accountId).toBe("acct_b");
    expect(status.launchProfileId).toBe((await registry.getActiveProfile())?.id ?? null);
    expect(status.running).toBe(true);
  });

  test("marks the managed desktop session as signed out when auth.json disappears", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-desktop-"));
    const currentCodexHome = join(rootDir, "current");
    const registry = new ProfileRegistry(rootDir);
    const secretStore = new InMemorySecretStore();
    const profileManager = new ProfileManager({
      registry,
      secretStore,
      codexClient: new FakeCodexClient(),
      rootDir,
      currentCodexHome,
    });
    const stateStore = new DesktopStateStore(rootDir);
    const processAdapter = new FakeDesktopProcessAdapter({
      desktopPid: 333,
      monitorPid: 444,
      runningPids: [333, 444],
    });
    const desktopManager = new DesktopManager({
      rootDir,
      profileManager,
      stateStore,
      processAdapter,
      desktopCommand: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
      platform: "win32",
    });

    await seedCodexHome(currentCodexHome, "acct_old", {
      organizations: [{ id: "acct_old", title: "Old Workspace", is_default: true }],
    });
    const oldProfile = await profileManager.importCurrent("old-profile");

    const sessionHome = join(rootDir, "desktop", "session", "home");
    await seedCodexHome(sessionHome, "acct_old", {
      organizations: [{ id: "acct_old", title: "Old Workspace", is_default: true }],
    });
    await stateStore.write({
      managed: true,
      running: true,
      desktopPid: 333,
      monitorPid: 444,
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
      sessionHome,
      launchedAt: "2026-03-30T00:00:00.000Z",
      launchProfileId: oldProfile.id,
      lastObservedAccountId: oldProfile.accountId,
      lastObservedProfileId: oldProfile.id,
      lastSyncedAt: "2026-03-30T00:00:00.000Z",
      lastError: null,
    });

    await rm(join(sessionHome, "auth.json"), { force: true });

    const status = await desktopManager.syncSession();

    expect(status.lastObservedAccountId).toBeNull();
    expect(status.lastObservedProfileId).toBeNull();
    expect(status.lastError).toBe("Managed desktop session is signed out.");
  });
});
