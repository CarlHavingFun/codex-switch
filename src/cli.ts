#!/usr/bin/env node

import { Command } from "commander";

import { VERSION } from "./index.js";
import type { ProfileStatus } from "./core/profile-manager.js";
import { renderShellHook, type SupportedShell } from "./cli/shell-hooks.js";
import { createCliRuntime } from "./cli/runtime.js";

const runtime = await createCliRuntime();
const program = new Command();

program
  .name("codex-switch")
  .description("Manage multiple isolated Codex login profiles.")
  .version(VERSION);

program
  .command("login")
  .argument("[profile]", "profile display name")
  .option("--workspace-label <label>", "best-effort workspace label to store")
  .option("--isolated-browser", "launch login in an isolated Chromium browser profile")
  .option("--native-browser", "use the native codex login browser flow")
  .option("--json", "print structured JSON")
  .action(
    async (
      profile: string | undefined,
      options: {
        workspaceLabel?: string;
        isolatedBrowser?: boolean;
        nativeBrowser?: boolean;
        json?: boolean;
      },
    ) => {
    const browserStrategy = resolveLoginBrowserStrategy(options);
    const created = await runtime.manager.login(profile, {
      workspaceLabel: options.workspaceLabel ?? null,
    }, {
      browserStrategy,
    });
      if (options.json) {
        printJson(created);
        return;
      }
      console.log(
        `Logged in profile ${created.displayName} (${created.id}) and marked it active.`,
      );
    },
  );

program
  .command("import-current")
  .argument("[profile]", "profile display name")
  .option("--workspace-label <label>", "best-effort workspace label to store")
  .option("--json", "print structured JSON")
  .action(
    async (
      profile: string | undefined,
      options: { workspaceLabel?: string; json?: boolean },
    ) => {
    const created = await runtime.manager.importCurrent(profile, {
      workspaceLabel: options.workspaceLabel ?? null,
    });
      if (options.json) {
        printJson(created);
        return;
      }
      console.log(
        `Imported current Codex home into profile ${created.displayName} (${created.id}).`,
      );
    },
  );

program.command("list").option("--json", "print structured JSON").action(async (options: {
  json?: boolean;
}) => {
  const profiles = await runtime.manager.list();
  if (options.json) {
    printJson(profiles);
    return;
  }
  if (profiles.length === 0) {
    console.log("No profiles configured.");
    return;
  }

  for (const profile of profiles) {
    const marker = profile.isActive ? "*" : " ";
    const authMode = profile.authMode ?? "unknown";
    const workspace = formatWorkspaceDisplay(profile);
    console.log(`${marker} ${profile.displayName}  [${authMode}]  ${workspace}`);
    console.log(`  Path: ${profile.codexHome}`);
  }
});

program
  .command("status")
  .option("--all", "show live status for every profile")
  .option("--profile <profile>", "show live status for one profile")
  .option("--json", "print structured JSON")
  .action(async (options: { all?: boolean; profile?: string; json?: boolean }) => {
    if (options.all) {
      const statuses = await runtime.manager.statusAll();
      if (options.json) {
        printJson(statuses);
        return;
      }
      for (const status of statuses) {
        printStatus(status);
      }
      return;
    }

    const status = await runtime.manager.status({
      profileName: options.profile,
    });
    if (options.json) {
      printJson(status);
      return;
    }
    printStatus(status);
  });

program
  .command("use")
  .argument("<profile>", "profile display name")
  .option("--json", "print structured JSON")
  .action(async (profile: string, options: { json?: boolean }) => {
    const active = await runtime.manager.use(profile);
    if (options.json) {
      printJson(active);
      return;
    }
    console.log(`Active profile set to ${active.displayName}.`);
  });

program
  .command("sync-current")
  .option("--json", "print structured JSON")
  .action(async (options: { json?: boolean }) => {
    const result = await runtime.manager.syncCurrent();
    if (options.json) {
      printJson(result);
      return;
    }

    switch (result.action) {
      case "created":
        console.log(
          `Imported current login into profile ${result.profile?.displayName ?? "unknown"} and marked it active.`,
        );
        break;
      case "updated":
        console.log(
          `Updated active profile ${result.profile?.displayName ?? "unknown"} from the current Codex login.`,
        );
        break;
      case "switched":
        console.log(
          `Switched active profile to ${result.profile?.displayName ?? "unknown"} based on the current Codex login.`,
        );
        break;
      default:
        console.log("Current Codex login is already synchronized.");
        break;
    }
  });

program
  .command("run")
  .argument("[codexArgs...]", "arguments to forward to codex")
  .option("--profile <profile>", "run under a specific profile instead of the active one")
  .allowUnknownOption(true)
  .action(
    async (
      codexArgs: string[],
      options: { profile?: string },
      command: Command,
    ) => {
      const args =
        codexArgs.length > 0 ? codexArgs : command.args.filter((item) => item !== "--");
      process.exitCode = await runtime.manager.run({
        profileName: options.profile,
        args,
      });
    },
  );

program.command("doctor").action(async () => {
  const doctor = await runtime.manager.doctor();
  console.log(`Codex found: ${doctor.codex.codexFound}`);
  console.log(`Codex version: ${doctor.codex.version ?? "unknown"}`);
  console.log(`Managed root: ${doctor.rootDir}`);
  console.log(`Current Codex home: ${doctor.currentCodexHome}`);
  console.log(`Profiles: ${doctor.profileCount}`);
  console.log(
    `Active profile: ${doctor.activeProfile?.displayName ?? "none"}`,
  );
});

const desktopProgram = program
  .command("desktop")
  .description("Launch and monitor the official Codex desktop app on Windows.");

desktopProgram
  .command("launch")
  .option("--json", "print structured JSON")
  .action(async (options: { json?: boolean }) => {
    const status = await runtime.desktopManager.launch({
      selfCommand: process.execPath,
      selfArgs: [...process.execArgv, process.argv[1] ?? ""],
    });
    if (options.json) {
      printJson(status);
      return;
    }
    printDesktopStatus(status);
  });

desktopProgram
  .command("status")
  .option("--json", "print structured JSON")
  .action(async (options: { json?: boolean }) => {
    const status = await runtime.desktopManager.status();
    if (options.json) {
      printJson(status);
      return;
    }
    printDesktopStatus(status);
  });

desktopProgram
  .command("switch")
  .argument("<profile>", "profile display name")
  .option("--json", "print structured JSON")
  .action(async (profile: string, options: { json?: boolean }) => {
    const status = await runtime.desktopManager.switchProfile({
      profileName: profile,
      selfCommand: process.execPath,
      selfArgs: [...process.execArgv, process.argv[1] ?? ""],
    });
    if (options.json) {
      printJson(status);
      return;
    }
    printDesktopStatus(status);
  });

hideCommand(
  desktopProgram
  .command("monitor")
  .requiredOption("--session-home <path>", "managed desktop session home")
  .requiredOption("--desktop-pid <pid>", "desktop process id")
  .requiredOption("--desktop-executable <path>", "desktop executable path")
  .option("--launch-profile-id <id>", "profile that seeded the desktop session")
  .option("--poll-interval-ms <ms>", "poll interval in milliseconds", (value) =>
    Number.parseInt(value, 10),
  )
  .action(
    async (options: {
      sessionHome: string;
      desktopPid: number;
      desktopExecutable: string;
      launchProfileId?: string;
      pollIntervalMs?: number;
    }) => {
      await runtime.desktopManager.runMonitor({
        sessionHome: options.sessionHome,
        desktopPid:
          Number.isFinite(options.desktopPid) && options.desktopPid > 0
            ? options.desktopPid
            : null,
        executablePath: options.desktopExecutable,
        launchProfileId: options.launchProfileId ?? null,
        pollIntervalMs:
          Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : undefined,
      });
    },
  ),
);

program
  .command("shell")
  .command("init")
  .argument("<shell>", "shell to initialize (pwsh, bash, zsh)")
  .action((shell: SupportedShell) => {
    console.log(renderShellHook(shell));
  });

const workspaceProgram = program
  .command("workspace")
  .description("Manage manual workspace labels for profiles.");

workspaceProgram
  .command("setname")
  .argument("<name>", "manual workspace name to display")
  .option("--profile <profile>", "target a specific profile instead of the active one")
  .option("--json", "print structured JSON")
  .action(async (name: string, options: { profile?: string; json?: boolean }) => {
    const updated = await runtime.manager.setWorkspaceLabel(options.profile, name);
    if (options.json) {
      printJson(updated);
      return;
    }
    console.log(
      `Set manual workspace name for ${updated.displayName} to ${formatWorkspaceDisplay(updated)}.`,
    );
  });

workspaceProgram
  .command("clear")
  .option("--profile <profile>", "target a specific profile instead of the active one")
  .option("--json", "print structured JSON")
  .action(async (options: { profile?: string; json?: boolean }) => {
    const updated = await runtime.manager.clearWorkspaceLabel(options.profile);
    if (options.json) {
      printJson(updated);
      return;
    }
    console.log(`Cleared manual workspace name for ${updated.displayName}.`);
  });

await program.parseAsync(process.argv);

function printStatus(status: ProfileStatus): void {
  const loginStatus = status.loginStatus?.trim() || "unavailable";
  console.log(`Profile: ${status.profile.displayName}`);
  console.log(`Path: ${status.profile.codexHome}`);
  console.log(`Active: ${status.profile.isActive}`);
  console.log(`Auth mode: ${status.profile.authMode ?? "unknown"}`);
  console.log(`Account id: ${status.profile.accountId ?? "unknown"}`);
  console.log(`Plan: ${status.profile.planType ?? "unknown"}`);
  console.log(`Workspace: ${formatWorkspaceDisplay(status.profile)}`);
  console.log(`Login status: ${loginStatus}`);
  console.log(
    `Requires OpenAI auth: ${status.requiresOpenaiAuth === null ? "unknown" : String(status.requiresOpenaiAuth)}`,
  );
  if (status.account?.type === "chatgpt") {
    console.log(`Email: ${status.account.email}`);
  }
  if (status.usageSummary.usageKind === "credits" && status.usageSummary.creditsBalance) {
    console.log(`Credits balance: ${status.usageSummary.creditsBalance}`);
  }
  if (status.usageSummary.primaryRemainingPercent !== null) {
    console.log(`Primary remaining: ${status.usageSummary.primaryRemainingPercent}%`);
  }
  if (status.usageSummary.primaryResetsAt !== null) {
    console.log(`Primary resets at: ${status.usageSummary.primaryResetsAt}`);
  }
  if (status.requiresOpenaiAuth) {
    console.log("Usage availability: re-authenticate with OpenAI to refresh plan and quota data.");
  }
  console.log("");
}

function formatWorkspaceDisplay(profile: ProfileStatus["profile"]): string {
  const workspaceLabel = profile.workspaceLabel?.trim();
  const workspaceObserved = profile.workspaceObserved?.trim();

  if (workspaceLabel) {
    return workspaceLabel;
  }

  return workspaceObserved ?? "unlabeled";
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printDesktopStatus(status: {
  managed: boolean;
  running: boolean;
  desktopPid: number | null;
  monitorPid: number | null;
  executablePath: string | null;
  sessionHome: string | null;
  launchedAt: string | null;
  launchProfileId: string | null;
  lastObservedAccountId: string | null;
  lastObservedProfileId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}): void {
  console.log(`Managed desktop: ${status.managed}`);
  console.log(`Running: ${status.running}`);
  console.log(`Desktop pid: ${status.desktopPid ?? "unknown"}`);
  console.log(`Monitor pid: ${status.monitorPid ?? "unknown"}`);
  console.log(`Executable: ${status.executablePath ?? "unknown"}`);
  console.log(`Session home: ${status.sessionHome ?? "none"}`);
  console.log(`Launch profile id: ${status.launchProfileId ?? "unknown"}`);
  console.log(`Observed account id: ${status.lastObservedAccountId ?? "unknown"}`);
  console.log(`Observed profile id: ${status.lastObservedProfileId ?? "unknown"}`);
  console.log(`Last synced at: ${status.lastSyncedAt ?? "never"}`);
  if (status.lastError) {
    console.log(`Last error: ${status.lastError}`);
  }
}

function resolveLoginBrowserStrategy(options: {
  isolatedBrowser?: boolean;
  nativeBrowser?: boolean;
}): "native" | "isolated" {
  if (options.isolatedBrowser && options.nativeBrowser) {
    throw new Error("Choose either --isolated-browser or --native-browser, not both.");
  }

  if (options.isolatedBrowser) {
    return "isolated";
  }

  if (options.nativeBrowser) {
    return "native";
  }

  return process.platform === "win32" ? "isolated" : "native";
}

function hideCommand(command: Command): Command {
  const maybeHidden = command as Command & { hideHelp?: () => Command };
  return typeof maybeHidden.hideHelp === "function" ? maybeHidden.hideHelp() : command;
}
