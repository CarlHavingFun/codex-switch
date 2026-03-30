import { readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { execa } from "execa";

import { fingerprintAuthDocument, readAuthDocumentFromHome } from "./managed-auth.js";
import { DesktopStateStore, type DesktopStatusState } from "./desktop-state-store.js";
import type { ProfileManager } from "./profile-manager.js";

export interface DesktopProcessAdapter {
  launchDesktop(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ): Promise<number | null>;
  launchMonitor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<number | null>;
  isProcessRunning(pid: number | null): boolean;
  terminateProcess(pid: number | null): Promise<void>;
}

export interface DesktopManagerOptions {
  rootDir: string;
  profileManager: ProfileManager;
  stateStore: DesktopStateStore;
  processAdapter?: DesktopProcessAdapter;
  desktopCommand?: string;
  desktopArgs?: string[];
  desktopWorkingDirectory?: string | null;
  desktopProxyUrl?: string | null;
  monitorPollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface DesktopLaunchOptions {
  selfCommand: string;
  selfArgs: string[];
  profileName?: string;
}

export interface DesktopSwitchOptions {
  selfCommand: string;
  selfArgs: string[];
  profileName: string;
}

export interface DesktopMonitorOptions {
  sessionHome: string;
  desktopPid: number | null;
  executablePath: string;
  launchProfileId: string | null;
  pollIntervalMs?: number;
}

export class DesktopManager {
  private readonly processAdapter: DesktopProcessAdapter;
  private readonly desktopCommand: string | null;
  private readonly desktopArgs: string[];
  private readonly desktopWorkingDirectory: string | null;
  private readonly desktopProxyUrl: string | null;
  private readonly monitorPollIntervalMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly desktopRoot: string;
  private readonly sessionRoot: string;
  private readonly sessionHome: string;

  constructor(private readonly options: DesktopManagerOptions) {
    this.processAdapter = options.processAdapter ?? new NodeDesktopProcessAdapter();
    this.desktopCommand = options.desktopCommand ?? process.env.CODEX_SWITCH_DESKTOP_COMMAND ?? null;
    this.desktopArgs = options.desktopArgs ?? [];
    this.desktopWorkingDirectory = options.desktopWorkingDirectory ?? null;
    this.desktopProxyUrl = options.desktopProxyUrl ?? null;
    this.monitorPollIntervalMs = options.monitorPollIntervalMs ?? 60_000;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.desktopRoot = join(options.rootDir, "desktop");
    this.sessionRoot = join(this.desktopRoot, "session");
    this.sessionHome = join(this.sessionRoot, "home");
  }

  async launch(options: DesktopLaunchOptions): Promise<DesktopStatusState> {
    this.assertWindows();
    const current = await this.status();
    if (current.running && current.desktopPid !== null) {
      return current;
    }

    const sourceProfile = await this.options.profileManager.getActiveProfile();
    if (!sourceProfile) {
      throw new Error("No active profile is configured.");
    }

    return this.startManagedDesktop({
      selfCommand: options.selfCommand,
      selfArgs: options.selfArgs,
      profileName: options.profileName ?? sourceProfile.displayName,
    });
  }

  async switchProfile(options: DesktopSwitchOptions): Promise<DesktopStatusState> {
    this.assertWindows();
    const current = await this.status();
    if (current.running) {
      await this.terminateManagedProcesses(current);
    }

    return this.startManagedDesktop({
      selfCommand: options.selfCommand,
      selfArgs: options.selfArgs,
      profileName: options.profileName,
    });
  }

  async status(): Promise<DesktopStatusState> {
    const state = await this.options.stateStore.read();
    const running = this.processAdapter.isProcessRunning(state.desktopPid);
    if (running === state.running) {
      return state;
    }

    return this.options.stateStore.write({
      ...state,
      running,
      monitorPid: running ? state.monitorPid : null,
    });
  }

  async syncSession(): Promise<DesktopStatusState> {
    const state = await this.options.stateStore.read();
    if (!state.sessionHome) {
      throw new Error("No managed desktop session is configured.");
    }

    const syncResult = await this.options.profileManager.syncHome(state.sessionHome);
    if (syncResult.reason === "current-auth-missing") {
      return this.markSignedOut(state);
    }

    const activeProfile = await this.options.profileManager.getActiveProfile();
    const nextState = await this.options.stateStore.write({
      ...state,
      running: this.processAdapter.isProcessRunning(state.desktopPid),
      lastObservedAccountId:
        syncResult.authSummary?.accountId ?? state.lastObservedAccountId,
      lastObservedProfileId:
        syncResult.profile?.id ?? activeProfile?.id ?? state.lastObservedProfileId,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });

    return nextState;
  }

  async runMonitor(options: DesktopMonitorOptions): Promise<void> {
    this.assertWindows();
    const pollIntervalMs = options.pollIntervalMs ?? this.monitorPollIntervalMs;
    let lastFingerprint: string | null = null;
    const existingState = await this.options.stateStore.read();

    await this.options.stateStore.write({
      managed: true,
      running: this.processAdapter.isProcessRunning(options.desktopPid),
      desktopPid: options.desktopPid,
      monitorPid: process.pid,
      executablePath: options.executablePath,
      sessionHome: options.sessionHome,
      launchedAt: existingState.launchedAt ?? new Date().toISOString(),
      launchProfileId: options.launchProfileId ?? existingState.launchProfileId,
      lastObservedAccountId: existingState.lastObservedAccountId,
      lastObservedProfileId:
        existingState.lastObservedProfileId ?? options.launchProfileId,
      lastSyncedAt: existingState.lastSyncedAt,
      lastError: null,
    });

    try {
      while (true) {
        const running = this.processAdapter.isProcessRunning(options.desktopPid);
        const authFingerprint = await readFingerprint(options.sessionHome);
        if (authFingerprint && authFingerprint !== lastFingerprint) {
          lastFingerprint = authFingerprint;
          await this.syncSession();
        }
        if (!authFingerprint && lastFingerprint !== null) {
          lastFingerprint = null;
          const state = await this.options.stateStore.read();
          await this.markSignedOut(state);
        }

        if (!running) {
          const finalState = await this.options.stateStore.read();
          await this.options.stateStore.write({
            ...finalState,
            running: false,
            monitorPid: null,
            sessionHome: null,
          });
          await rm(this.sessionRoot, { recursive: true, force: true });
          return;
        }

        await delay(pollIntervalMs);
      }
    } catch (error) {
      const finalState = await this.options.stateStore.read();
      await this.options.stateStore.write({
        ...finalState,
        running: this.processAdapter.isProcessRunning(options.desktopPid),
        monitorPid: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (!this.processAdapter.isProcessRunning(options.desktopPid)) {
        const finalState = await this.options.stateStore.read();
        await this.options.stateStore.write({
          ...finalState,
          running: false,
          monitorPid: null,
          sessionHome: null,
        });
        await rm(this.sessionRoot, { recursive: true, force: true });
      }
    }
  }

  async resolveDesktopExecutable(): Promise<string> {
    if (this.desktopCommand) {
      return this.desktopCommand;
    }

    if (this.platform !== "win32") {
      throw new Error("Managed Codex desktop launch currently supports Windows only.");
    }

    const appxResolved = await this.resolveDesktopExecutableFromAppxPackage();
    if (appxResolved) {
      return appxResolved;
    }

    const localAppData = this.env.LOCALAPPDATA;
    if (localAppData) {
      for (const candidate of [
        join(localAppData, "Microsoft", "WindowsApps", "Codex.exe"),
        join(localAppData, "Microsoft", "WindowsApps", "codex.exe"),
      ]) {
        if (await pathExists(candidate)) {
          return candidate;
        }
      }
    }

    throw new Error("Could not locate the official Codex desktop executable.");
  }

  private assertWindows(): void {
    if (this.platform !== "win32") {
      throw new Error("Codex desktop sync currently supports Windows only.");
    }
  }

  private async startManagedDesktop(options: DesktopLaunchOptions): Promise<DesktopStatusState> {
    const executablePath = await this.resolveDesktopExecutable();
    const workingDirectory = await this.resolveDesktopWorkingDirectory();
    await rm(this.sessionRoot, { recursive: true, force: true });
    const sourceProfile = await this.options.profileManager.materializeProfile(
      this.sessionHome,
      options.profileName,
    );

    const launchedAt = new Date().toISOString();
    const desktopPid = await this.processAdapter.launchDesktop(
      executablePath,
      this.desktopArgs,
      this.buildDesktopEnv(this.sessionHome),
      workingDirectory,
    );
    const monitorPid = await this.processAdapter.launchMonitor(
      options.selfCommand,
      [
        ...options.selfArgs,
        "desktop",
        "monitor",
        "--session-home",
        this.sessionHome,
        "--desktop-pid",
        String(desktopPid ?? 0),
        "--desktop-executable",
        executablePath,
        "--poll-interval-ms",
        String(this.monitorPollIntervalMs),
        ...(sourceProfile.id ? ["--launch-profile-id", sourceProfile.id] : []),
      ],
      this.env,
    );

    await this.options.profileManager.use(sourceProfile.displayName);
    return this.options.stateStore.write({
      managed: true,
      running: this.processAdapter.isProcessRunning(desktopPid),
      desktopPid,
      monitorPid,
      executablePath,
      sessionHome: this.sessionHome,
      launchedAt,
      launchProfileId: sourceProfile.id,
      lastObservedAccountId: sourceProfile.accountId,
      lastObservedProfileId: sourceProfile.id,
      lastSyncedAt: launchedAt,
      lastError: null,
    });
  }

  private async terminateManagedProcesses(state: DesktopStatusState): Promise<void> {
    await this.processAdapter.terminateProcess(state.monitorPid);
    await this.processAdapter.terminateProcess(state.desktopPid);
  }

  private buildDesktopEnv(sessionHome: string): NodeJS.ProcessEnv {
    const env = {
      ...this.env,
      CODEX_HOME: sessionHome,
    };

    const proxyUrl = this.desktopProxyUrl?.trim();
    if (!proxyUrl) {
      return env;
    }

    return {
      ...env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
    };
  }

  private async resolveDesktopWorkingDirectory(): Promise<string> {
    const preferred = this.desktopWorkingDirectory?.trim();
    const candidate = preferred || process.cwd();
    if (preferred) {
      if (!(await pathExists(candidate))) {
        throw new Error(`Codex working directory was not found at: ${candidate}`);
      }

      return await realpath(candidate);
    }

    const fallback = isDriveRootPath(candidate) ? this.options.rootDir : candidate;
    if (!(await pathExists(fallback))) {
      throw new Error(`Codex working directory was not found at: ${fallback}`);
    }

    return await realpath(fallback);
  }

  private async resolveDesktopExecutableFromAppxPackage(): Promise<string | null> {
    try {
      const result = await execa(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation)",
        ],
        {
          env: this.env,
          reject: false,
        },
      );
      const installLocation = result.stdout.trim();
      if (!installLocation) {
        return null;
      }

      const candidate = join(installLocation, "app", "Codex.exe");
      return (await pathExists(candidate)) ? candidate : null;
    } catch {
      return null;
    }
  }

  private async markSignedOut(state: DesktopStatusState): Promise<DesktopStatusState> {
    return this.options.stateStore.write({
      ...state,
      running: this.processAdapter.isProcessRunning(state.desktopPid),
      lastObservedAccountId: null,
      lastObservedProfileId: null,
      lastSyncedAt: new Date().toISOString(),
      lastError: "Managed desktop session is signed out.",
    });
  }
}

class NodeDesktopProcessAdapter implements DesktopProcessAdapter {
  async launchDesktop(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ): Promise<number | null> {
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid ?? null;
  }

  async launchMonitor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<number | null> {
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid ?? null;
  }

  isProcessRunning(pid: number | null): boolean {
    if (pid === null || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async terminateProcess(pid: number | null): Promise<void> {
    if (pid === null || pid <= 0) {
      return;
    }

    try {
      process.kill(pid);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

async function readFingerprint(profileHome: string): Promise<string | null> {
  try {
    const authDocument = await readAuthDocumentFromHome(profileHome);
    return fingerprintAuthDocument(authDocument);
  } catch {
    return null;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isDriveRootPath(targetPath: string): boolean {
  if (!targetPath) {
    return false;
  }

  const resolved = resolve(targetPath);
  if (!isAbsolute(resolved)) {
    return false;
  }

  return /^[A-Za-z]:\\?$/.test(resolved);
}
