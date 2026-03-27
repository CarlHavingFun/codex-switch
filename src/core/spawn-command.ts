import { access } from "node:fs/promises";
import { extname } from "node:path";
import { constants } from "node:fs";

import { execa } from "execa";

const WINDOWS_SPAWNABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

export function selectWindowsSpawnCommand(matches: string[]): string | null {
  const normalized = matches
    .map((match) => match.trim())
    .filter((match) => match.length > 0);

  for (const extension of WINDOWS_SPAWNABLE_EXTENSIONS) {
    const candidate = normalized.find((match) =>
      match.toLowerCase().endsWith(extension),
    );
    if (candidate) {
      return candidate;
    }
  }

  return normalized.find((match) => extname(match).length > 0) ?? null;
}

export async function resolveSpawnCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): Promise<string> {
  if (platform !== "win32") {
    return command;
  }

  if (WINDOWS_SPAWNABLE_EXTENSIONS.includes(extname(command).toLowerCase())) {
    return command;
  }

  const explicitPath = await resolveExplicitPathCommand(command);
  if (explicitPath) {
    return explicitPath;
  }

  try {
    const result = await execa("where.exe", [command], {
      env,
      reject: false,
    });
    const resolved = selectWindowsSpawnCommand(result.stdout.split(/\r?\n/));
    return resolved ?? command;
  } catch {
    return command;
  }
}

async function resolveExplicitPathCommand(command: string): Promise<string | null> {
  if (!command.includes("\\") && !command.includes("/") && !command.includes(":")) {
    return null;
  }

  for (const extension of WINDOWS_SPAWNABLE_EXTENSIONS) {
    const candidate = `${command}${extension}`;
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  if (await pathExists(command)) {
    return command;
  }

  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
