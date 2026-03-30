import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { loadAppConfig } from "../core/app-config.js";
import { CodexProcessClient } from "../core/codex-process-client.js";
import { DesktopManager } from "../core/desktop-manager.js";
import { DesktopStateStore } from "../core/desktop-state-store.js";
import { KeytarSecretStore } from "../core/keytar-secret-store.js";
import { ProfileManager } from "../core/profile-manager.js";
import { ProfileRegistry } from "../core/profile-registry.js";

const argsSchema = z.array(z.string());

export interface CliRuntime {
  manager: ProfileManager;
  desktopManager: DesktopManager;
  rootDir: string;
  currentCodexHome: string;
}

export async function createCliRuntime(): Promise<CliRuntime> {
  const rootDir =
    process.env.CODEX_SWITCH_HOME ?? join(homedir(), ".codex-switch");
  const currentCodexHome =
    process.env.CODEX_SWITCH_CURRENT_CODEX_HOME ?? join(homedir(), ".codex");
  const config = await loadAppConfig(rootDir, process.env);

  const manager = new ProfileManager({
    registry: new ProfileRegistry(rootDir),
    secretStore: new KeytarSecretStore("codex-switch"),
    codexClient: new CodexProcessClient({
      command: config.codex.command,
      commandArgs: config.codex.commandArgs,
    }),
    rootDir,
    currentCodexHome,
  });
  const desktopManager = new DesktopManager({
    rootDir,
    profileManager: manager,
    stateStore: new DesktopStateStore(rootDir),
    desktopCommand: config.desktop.clientPath || undefined,
    desktopArgs: config.desktop.clientArgs,
    desktopWorkingDirectory: config.desktop.workingDirectory || undefined,
    desktopProxyUrl: config.desktop.proxyUrl || undefined,
    monitorPollIntervalMs: config.desktop.monitorPollIntervalMs,
  });

  return {
    manager,
    desktopManager,
    rootDir,
    currentCodexHome,
  };
}
