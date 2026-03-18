import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import {
  createManagedProfileHome,
  createProfileSkeleton,
} from "../../src/core/profile-home.js";

async function writeFixture(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("profile-home", () => {
  test("copies a sanitized Codex skeleton for a new profile", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-home-"));
    const sourceDir = join(rootDir, "source");
    const targetDir = join(rootDir, "target");

    await createManagedProfileHome(sourceDir);
    await writeFixture(join(sourceDir, "config.toml"), "model = 'gpt-5'");
    await writeFixture(join(sourceDir, "rules", "team.md"), "rule");
    await writeFixture(join(sourceDir, "skills", "demo", "SKILL.md"), "skill");
    await writeFixture(join(sourceDir, "sessions", "session-1.jsonl"), "{}");
    await writeFixture(join(sourceDir, "history.jsonl"), "{}");
    await writeFixture(join(sourceDir, "auth.json"), "{\"secret\":true}");
    await writeFixture(join(sourceDir, "log", "latest.log"), "log");
    await writeFixture(join(sourceDir, "tmp", "cache.txt"), "tmp");
    await writeFixture(join(sourceDir, ".sandbox", "sandbox.log"), "sandbox");

    await createProfileSkeleton(sourceDir, targetDir);

    await expect(readFile(join(targetDir, "config.toml"), "utf8")).resolves.toBe(
      "model = 'gpt-5'",
    );
    await expect(
      readFile(join(targetDir, "rules", "team.md"), "utf8"),
    ).resolves.toBe("rule");
    await expect(
      readFile(join(targetDir, "skills", "demo", "SKILL.md"), "utf8"),
    ).resolves.toBe("skill");
    await expect(
      readFile(join(targetDir, "sessions", "session-1.jsonl"), "utf8"),
    ).resolves.toBe("{}");
    await expect(readFile(join(targetDir, "history.jsonl"), "utf8")).resolves.toBe(
      "{}",
    );
    await expect(access(join(targetDir, "auth.json"), constants.F_OK)).rejects.toThrow();
    await expect(
      access(join(targetDir, "log", "latest.log"), constants.F_OK),
    ).rejects.toThrow();
    await expect(
      access(join(targetDir, "tmp", "cache.txt"), constants.F_OK),
    ).rejects.toThrow();
    await expect(
      access(join(targetDir, ".sandbox", "sandbox.log"), constants.F_OK),
    ).rejects.toThrow();
  });

  test("skips nested git directories while copying the skeleton", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-home-"));
    const sourceDir = join(rootDir, "source");
    const targetDir = join(rootDir, "target");

    await createManagedProfileHome(sourceDir);
    await writeFixture(join(sourceDir, "superpowers", ".git", "objects", "pack", "pack.idx"), "idx");
    await writeFixture(join(sourceDir, "superpowers", "README.md"), "superpowers");

    await createProfileSkeleton(sourceDir, targetDir);

    await expect(
      readFile(join(targetDir, "superpowers", "README.md"), "utf8"),
    ).resolves.toBe("superpowers");
    await expect(
      access(
        join(targetDir, "superpowers", ".git", "objects", "pack", "pack.idx"),
        constants.F_OK,
      ),
    ).rejects.toThrow();
  });
});
