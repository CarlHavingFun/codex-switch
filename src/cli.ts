#!/usr/bin/env node

import { Command } from "commander";

import { VERSION } from "./index.js";
import type { ProfileStatus } from "./core/profile-manager.js";
import { renderShellHook, type SupportedShell } from "./cli/shell-hooks.js";
import { createCliRuntime } from "./cli/runtime.js";

const runtime = createCliRuntime();
const program = new Command();

program
  .name("codex-switch")
  .description("Manage multiple isolated Codex login profiles.")
  .version(VERSION);

program
  .command("login")
  .argument("[profile]", "profile display name")
  .option("--workspace-label <label>", "best-effort workspace label to store")
  .action(async (profile: string | undefined, options: { workspaceLabel?: string }) => {
    const created = await runtime.manager.login(profile, {
      workspaceLabel: options.workspaceLabel ?? null,
    });
    console.log(
      `Logged in profile ${created.displayName} (${created.id}) and marked it active.`,
    );
  });

program
  .command("import-current")
  .argument("[profile]", "profile display name")
  .option("--workspace-label <label>", "best-effort workspace label to store")
  .action(async (profile: string | undefined, options: { workspaceLabel?: string }) => {
    const created = await runtime.manager.importCurrent(profile, {
      workspaceLabel: options.workspaceLabel ?? null,
    });
    console.log(
      `Imported current Codex home into profile ${created.displayName} (${created.id}).`,
    );
  });

program.command("list").action(async () => {
  const profiles = await runtime.manager.list();
  if (profiles.length === 0) {
    console.log("No profiles configured.");
    return;
  }

  for (const profile of profiles) {
    const marker = profile.isActive ? "*" : " ";
    const authMode = profile.authMode ?? "unknown";
    const workspace = formatWorkspaceDisplay(profile);
    console.log(`${marker} ${profile.displayName}  [${authMode}]  ${workspace}`);
  }
});

program
  .command("status")
  .option("--all", "show live status for every profile")
  .option("--profile <profile>", "show live status for one profile")
  .action(async (options: { all?: boolean; profile?: string }) => {
    if (options.all) {
      const statuses = await runtime.manager.statusAll();
      for (const status of statuses) {
        printStatus(status);
      }
      return;
    }

    const status = await runtime.manager.status({
      profileName: options.profile,
    });
    printStatus(status);
  });

program
  .command("use")
  .argument("<profile>", "profile display name")
  .action(async (profile: string) => {
    const active = await runtime.manager.use(profile);
    console.log(`Active profile set to ${active.displayName}.`);
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

program
  .command("shell")
  .command("init")
  .argument("<shell>", "shell to initialize (pwsh, bash, zsh)")
  .action((shell: SupportedShell) => {
    console.log(renderShellHook(shell));
  });

await program.parseAsync(process.argv);

function printStatus(status: ProfileStatus): void {
  console.log(`Profile: ${status.profile.displayName}`);
  console.log(`Active: ${status.profile.isActive}`);
  console.log(`Auth mode: ${status.profile.authMode ?? "unknown"}`);
  console.log(`Account id: ${status.profile.accountId ?? "unknown"}`);
  console.log(`Plan: ${status.profile.planType ?? "unknown"}`);
  console.log(`Workspace: ${formatWorkspaceDisplay(status.profile)}`);
  console.log(`Login status: ${status.loginStatus ?? "unavailable"}`);
  if (status.account?.type === "chatgpt") {
    console.log(`Email: ${status.account.email}`);
  }
  if (status.rateLimits?.rateLimits.credits?.balance) {
    console.log(`Credits balance: ${status.rateLimits.rateLimits.credits.balance}`);
  }
  console.log("");
}

function formatWorkspaceDisplay(profile: ProfileStatus["profile"]): string {
  const workspaceLabel = profile.workspaceLabel?.trim();
  const workspaceObserved = profile.workspaceObserved?.trim();

  if (workspaceLabel && workspaceObserved && workspaceLabel !== workspaceObserved) {
    return `${workspaceLabel} / ${workspaceObserved}`;
  }

  return workspaceLabel ?? workspaceObserved ?? "unlabeled";
}
