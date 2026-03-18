import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { CodexProcessClient } from "../core/codex-process-client.js";
import { KeytarSecretStore } from "../core/keytar-secret-store.js";
import { ProfileManager } from "../core/profile-manager.js";
import { ProfileRegistry } from "../core/profile-registry.js";

const argsSchema = z.array(z.string());

export interface CliRuntime {
  manager: ProfileManager;
}

export function createCliRuntime(): CliRuntime {
  const rootDir =
    process.env.CODEX_SWITCH_HOME ?? join(homedir(), ".codex-switch");
  const currentCodexHome =
    process.env.CODEX_SWITCH_CURRENT_CODEX_HOME ?? join(homedir(), ".codex");
  const command = process.env.CODEX_SWITCH_CODEX_COMMAND ?? "codex";
  const commandArgs = process.env.CODEX_SWITCH_CODEX_ARGS_JSON
    ? argsSchema.parse(JSON.parse(process.env.CODEX_SWITCH_CODEX_ARGS_JSON))
    : [];

  const manager = new ProfileManager({
    registry: new ProfileRegistry(rootDir),
    secretStore: new KeytarSecretStore("codex-switch"),
    codexClient: new CodexProcessClient({
      command,
      commandArgs,
    }),
    rootDir,
    currentCodexHome,
  });

  return { manager };
}
