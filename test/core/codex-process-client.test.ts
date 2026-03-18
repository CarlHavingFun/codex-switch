import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import { CodexProcessClient } from "../../src/core/codex-process-client.js";

const fakeCodexScript = join(
  process.cwd(),
  "test",
  "fixtures",
  "fake-codex.mjs",
);

function createClient() {
  return new CodexProcessClient({
    command: process.execPath,
    commandArgs: [fakeCodexScript],
  });
}

describe("CodexProcessClient", () => {
  test("reads login status and doctor information from the real codex process interface", async () => {
    const client = createClient();

    await expect(client.getLoginStatus("D:/profile-home")).resolves.toBe(
      "Logged in using ChatGPT",
    );
    await expect(client.doctor()).resolves.toEqual({
      codexFound: true,
      version: "codex-cli 0.115.0",
    });
  });

  test("parses account and rate-limit data from the app-server bridge", async () => {
    const client = createClient();

    await expect(client.getAccountSnapshot("D:/profile-home")).resolves.toEqual({
      account: {
        type: "chatgpt",
        email: "fixture@example.com",
        planType: "team",
      },
      requiresOpenaiAuth: false,
    });
    await expect(client.getRateLimits("D:/profile-home")).resolves.toMatchObject({
      rateLimits: {
        limitId: "codex",
        credits: {
          balance: "42.00",
        },
      },
    });
  });

  test("runs Codex with the caller-provided environment and returns the exit code", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "codex-switch-client-"));
    const capturePath = join(captureDir, "run.json");
    const client = createClient();

    const exitCode = await client.run(["noop"], {
      env: {
        ...process.env,
        CODEX_HOME: "D:/managed-profile",
        FAKE_CODEX_CAPTURE_PATH: capturePath,
      },
    });

    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      codexHome: string;
    };

    expect(exitCode).toBe(0);
    expect(captured.args).toEqual(["noop"]);
    expect(captured.codexHome).toBe("D:/managed-profile");
  });

  test("degrades to null when the app-server bridge is unavailable", async () => {
    const client = new CodexProcessClient({
      command: process.execPath,
      commandArgs: [fakeCodexScript],
      env: {
        ...process.env,
        FAKE_CODEX_APPSERVER_FAIL: "1",
      },
    });

    await expect(client.getAccountSnapshot("D:/profile-home")).resolves.toBeNull();
    await expect(client.getRateLimits("D:/profile-home")).resolves.toBeNull();
  });
});
