import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import { ProfileLock } from "../../src/core/profile-lock.js";

describe("ProfileLock", () => {
  test("prevents concurrent acquisition for the same profile", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-lock-"));
    const first = new ProfileLock(rootDir, "profile-1");
    const second = new ProfileLock(rootDir, "profile-1");

    await first.acquire();

    await expect(second.acquire()).rejects.toThrow(/already locked/i);

    await first.release();
  });

  test("can be reacquired after release", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-lock-"));
    const lock = new ProfileLock(rootDir, "profile-1");

    await lock.acquire();
    await lock.release();

    await expect(lock.acquire()).resolves.toBeUndefined();
    await lock.release();
  });
});
