import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const appConfigFileName = "config.json";
const stringArraySchema = z.array(z.string());

const appConfigSchema = z.object({
  codex: z
    .object({
      command: z.string().optional(),
      commandArgs: stringArraySchema.optional(),
    })
    .optional(),
  desktop: z
    .object({
      proxyUrl: z.string().optional(),
      clientPath: z.string().optional(),
      workingDirectory: z.string().optional(),
      clientArgs: stringArraySchema.optional(),
      monitorPollIntervalMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export interface AppConfig {
  codex: {
    command: string;
    commandArgs: string[];
  };
  desktop: {
    proxyUrl: string;
    clientPath: string;
    workingDirectory: string;
    clientArgs: string[];
    monitorPollIntervalMs: number;
  };
}

export async function loadAppConfig(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  const configPath = join(rootDir, appConfigFileName);
  const fileConfig = await readAppConfigFile(configPath);
  const codexFromEnv = parseJsonStringArray(
    env.CODEX_SWITCH_CODEX_ARGS_JSON,
    "CODEX_SWITCH_CODEX_ARGS_JSON",
  );
  const desktopArgsFromEnv = parseJsonStringArray(
    env.CODEX_SWITCH_DESKTOP_ARGS_JSON,
    "CODEX_SWITCH_DESKTOP_ARGS_JSON",
  );
  const proxyFromEnv = firstNonEmpty([
    env.CODEX_PROXY,
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    env.https_proxy,
    env.http_proxy,
  ]);

  return {
    codex: {
      command:
        normalize(env.CODEX_SWITCH_CODEX_COMMAND) ??
        normalize(fileConfig.codex?.command) ??
        "codex",
      commandArgs:
        codexFromEnv ??
        fileConfig.codex?.commandArgs ??
        [],
    },
    desktop: {
      proxyUrl:
        proxyFromEnv ??
        normalize(fileConfig.desktop?.proxyUrl) ??
        "",
      clientPath:
        normalize(env.CODEX_SWITCH_DESKTOP_COMMAND) ??
        normalize(fileConfig.desktop?.clientPath) ??
        "",
      workingDirectory:
        normalize(fileConfig.desktop?.workingDirectory) ??
        "",
      clientArgs:
        desktopArgsFromEnv ??
        fileConfig.desktop?.clientArgs ??
        [],
      monitorPollIntervalMs:
        fileConfig.desktop?.monitorPollIntervalMs ??
        60_000,
    },
  };
}

async function readAppConfigFile(
  configPath: string,
): Promise<z.infer<typeof appConfigSchema>> {
  try {
    const raw = await readFile(configPath, "utf8");
    return appConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }

    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new Error(`Invalid codex-switch config at ${configPath}`);
    }

    throw error;
  }
}

function parseJsonStringArray(
  raw: string | undefined,
  envName: string,
): string[] | null {
  if (!raw?.trim()) {
    return null;
  }

  try {
    return stringArraySchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`Invalid ${envName}: expected a JSON string array.`);
  }
}

function firstNonEmpty(values: Array<string | undefined>): string | null {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalize(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
