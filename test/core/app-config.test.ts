import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { loadAppConfig } from "../../src/core/app-config.js";

describe("loadAppConfig", () => {
  test("returns defaults when config.json is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-config-"));

    const config = await loadAppConfig(rootDir, {});

    expect(config).toEqual({
      codex: {
        command: "codex",
        commandArgs: [],
      },
      desktop: {
        proxyUrl: "",
        clientPath: "",
        workingDirectory: "",
        clientArgs: [],
        monitorPollIntervalMs: 60_000,
      },
    });
  });

  test("loads config.json and applies environment overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-config-"));
    await writeFile(
      join(rootDir, "config.json"),
      JSON.stringify(
        {
          codex: {
            command: "codex-from-config",
            commandArgs: ["--config-arg"],
          },
          desktop: {
            proxyUrl: "http://config-proxy:8080",
            clientPath: "C:\\Config\\Codex.exe",
            workingDirectory: "D:\\ConfigWorkdir",
            clientArgs: ["--desktop-config-arg"],
            monitorPollIntervalMs: 90_000,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = await loadAppConfig(rootDir, {
      CODEX_SWITCH_CODEX_COMMAND: "codex-from-env",
      CODEX_SWITCH_CODEX_ARGS_JSON: JSON.stringify(["--env-arg"]),
      CODEX_SWITCH_DESKTOP_COMMAND: "C:\\Env\\Codex.exe",
      CODEX_SWITCH_DESKTOP_ARGS_JSON: JSON.stringify(["--desktop-env-arg"]),
      HTTPS_PROXY: "http://env-proxy:9090",
    });

    expect(config).toEqual({
      codex: {
        command: "codex-from-env",
        commandArgs: ["--env-arg"],
      },
      desktop: {
        proxyUrl: "http://env-proxy:9090",
        clientPath: "C:\\Env\\Codex.exe",
        workingDirectory: "D:\\ConfigWorkdir",
        clientArgs: ["--desktop-env-arg"],
        monitorPollIntervalMs: 90_000,
      },
    });
  });

  test("throws a clear error when config.json is invalid", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-config-"));
    await writeFile(join(rootDir, "config.json"), "{invalid json", "utf8");

    await expect(loadAppConfig(rootDir, {})).rejects.toThrow(
      `Invalid codex-switch config at ${join(rootDir, "config.json")}`,
    );
  });
});
