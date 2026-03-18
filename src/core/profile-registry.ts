import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

const rateLimitSnapshotSchema = z
  .object({
    collectedAt: z.string(),
    authMode: z.string().nullable(),
    statusSummary: z.string().nullable(),
    raw: z.record(z.string(), z.unknown()).nullable(),
  })
  .nullable();

export const managedProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  codexHome: z.string().min(1),
  authMode: z.string().nullable(),
  accountId: z.string().nullable(),
  planType: z.string().nullable(),
  workspaceLabel: z.string().nullable(),
  workspaceObserved: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  lastRateLimitSnapshot: rateLimitSnapshotSchema,
  isActive: z.boolean(),
});

const registrySchema = z.object({
  activeProfileId: z.string().nullable(),
  profiles: z.array(managedProfileSchema),
});

export type ManagedProfile = z.infer<typeof managedProfileSchema>;
type RegistryState = z.infer<typeof registrySchema>;

const EMPTY_REGISTRY: RegistryState = {
  activeProfileId: null,
  profiles: [],
};

export class ProfileRegistry {
  readonly registryFile: string;

  constructor(private readonly rootDir: string) {
    this.registryFile = join(rootDir, "profiles.json");
  }

  async listProfiles(): Promise<ManagedProfile[]> {
    const state = await this.readState();
    return state.profiles;
  }

  async saveProfile(profile: ManagedProfile): Promise<ManagedProfile> {
    const state = await this.readState();
    const nextProfiles = state.profiles.filter(
      (existing) => existing.id !== profile.id,
    );
    const normalized = {
      ...profile,
      isActive: state.activeProfileId === profile.id,
    };

    nextProfiles.push(normalized);
    await this.writeState({
      ...state,
      profiles: nextProfiles,
    });
    return normalized;
  }

  async getActiveProfile(): Promise<ManagedProfile | null> {
    const state = await this.readState();
    if (!state.activeProfileId) {
      return null;
    }

    return (
      state.profiles.find((profile) => profile.id === state.activeProfileId) ??
      null
    );
  }

  async getProfileByName(name: string): Promise<ManagedProfile | null> {
    const state = await this.readState();
    return (
      state.profiles.find(
        (profile) => profile.displayName.toLowerCase() === name.toLowerCase(),
      ) ?? null
    );
  }

  async getProfileByAccountId(accountId: string): Promise<ManagedProfile | null> {
    const state = await this.readState();
    return (
      state.profiles.find((profile) => profile.accountId === accountId) ?? null
    );
  }

  async setActiveProfile(profileId: string): Promise<void> {
    const state = await this.readState();
    const hasProfile = state.profiles.some((profile) => profile.id === profileId);
    if (!hasProfile) {
      throw new Error(`Unknown profile id: ${profileId}`);
    }

    await this.writeState({
      activeProfileId: profileId,
      profiles: state.profiles.map((profile) => ({
        ...profile,
        isActive: profile.id === profileId,
      })),
    });
  }

  private async readState(): Promise<RegistryState> {
    await this.ensureInitialized();

    const raw = await readFile(this.registryFile, "utf8");
    return registrySchema.parse(JSON.parse(raw));
  }

  private async ensureInitialized(): Promise<void> {
    await mkdir(dirname(this.registryFile), { recursive: true });

    try {
      await readFile(this.registryFile, "utf8");
    } catch {
      await this.writeState(EMPTY_REGISTRY);
    }
  }

  private async writeState(state: RegistryState): Promise<void> {
    await mkdir(dirname(this.registryFile), { recursive: true });
    await writeFile(this.registryFile, JSON.stringify(state, null, 2), "utf8");
  }
}
