import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import {
  ProfileRegistry,
  type ManagedProfile,
} from "../../src/core/profile-registry.js";

function createProfile(overrides: Partial<ManagedProfile> = {}): ManagedProfile {
  return {
    id: "profile-1",
    displayName: "work",
    codexHome: "/profiles/work/home",
    authMode: "chatgpt",
    accountId: "acct_123",
    planType: "plus",
    workspaceLabel: "Workspace A",
    workspaceObserved: null,
    lastVerifiedAt: null,
    lastRateLimitSnapshot: null,
    isActive: false,
    ...overrides,
  };
}

describe("ProfileRegistry", () => {
  test("creates its data directory and starts empty", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-registry-"));

    const registry = new ProfileRegistry(rootDir);

    const profiles = await registry.listProfiles();
    const onDisk = JSON.parse(
      await readFile(join(rootDir, "profiles.json"), "utf8"),
    ) as { profiles: ManagedProfile[]; activeProfileId: string | null };

    expect(profiles).toEqual([]);
    expect(onDisk.activeProfileId).toBeNull();
    expect(onDisk.profiles).toEqual([]);
  });

  test("upserts profiles and marks the selected one active", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-switch-registry-"));
    const registry = new ProfileRegistry(rootDir);

    const work = createProfile();
    const personal = createProfile({
      id: "profile-2",
      displayName: "personal",
      codexHome: "/profiles/personal/home",
      workspaceLabel: "Workspace B",
    });

    await registry.saveProfile(work);
    await registry.saveProfile(personal);
    await registry.setActiveProfile("profile-2");

    await expect(registry.getActiveProfile()).resolves.toMatchObject({
      id: "profile-2",
      displayName: "personal",
      isActive: true,
    });
    await expect(registry.getProfileByName("work")).resolves.toMatchObject({
      id: "profile-1",
      isActive: false,
    });
  });
});
