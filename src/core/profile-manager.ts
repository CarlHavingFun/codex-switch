import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  CodexAccountSnapshot,
  CodexClient,
  CodexRateLimitSnapshot,
} from "./codex-client.js";
import { createManagedProfileHome, createProfileSkeleton } from "./profile-home.js";
import { ProfileLock } from "./profile-lock.js";
import { ProfileRegistry, type ManagedProfile } from "./profile-registry.js";
import {
  hydrateAuthIntoHome,
  persistAuthFromHome,
  readAuthDocumentFromHome,
  summarizeAuthDocument,
  type AuthDocumentSummary,
} from "./managed-auth.js";
import type { SecretStore } from "./secret-store.js";

export interface ProfileManagerOptions {
  registry: ProfileRegistry;
  secretStore: SecretStore;
  codexClient: CodexClient;
  rootDir: string;
  currentCodexHome: string;
}

export interface ProfileMutationOptions {
  workspaceLabel?: string | null;
}

export interface RunProfileOptions {
  profileName?: string;
  args: string[];
  cwd?: string;
}

export interface ProfileStatus {
  profile: ManagedProfile;
  loginStatus: string | null;
  account: CodexAccountSnapshot["account"] | null;
  rateLimits: CodexRateLimitSnapshot | null;
  requiresOpenaiAuth: boolean | null;
}

export interface StatusOptions {
  profileName?: string;
}

export interface DoctorStatus {
  rootDir: string;
  currentCodexHome: string;
  profileCount: number;
  activeProfile: ManagedProfile | null;
  codex: {
    codexFound: boolean;
    version: string | null;
  };
}

export class ProfileManager {
  private readonly profilesRoot: string;
  private readonly locksRoot: string;
  private readonly sandboxesRoot: string;

  constructor(private readonly options: ProfileManagerOptions) {
    this.profilesRoot = join(options.rootDir, "profiles");
    this.locksRoot = join(options.rootDir, "locks");
    this.sandboxesRoot = join(options.rootDir, "tmp");
  }

  async importCurrent(
    displayName?: string,
    mutation: ProfileMutationOptions = {},
  ): Promise<ManagedProfile> {
    const authDocument = await readAuthDocumentFromHome(this.options.currentCodexHome);
    const authSummary = summarizeAuthDocument(authDocument);
    const profile = await this.ensureImportedProfile(
      displayName,
      authSummary,
      mutation.workspaceLabel,
    );
    await this.prepareSkeleton(profile.codexHome);
    await createProfileSkeleton(this.options.currentCodexHome, profile.codexHome);
    await this.options.secretStore.save(profile.id, authDocument);

    const saved = await this.options.registry.saveProfile({
      ...profile,
      authMode: authSummary.authMode,
      accountId: authSummary.accountId,
      workspaceObserved: authSummary.workspaceTitle ?? profile.workspaceObserved,
    });
    await this.options.registry.setActiveProfile(saved.id);

    return (await this.options.registry.getActiveProfile()) ?? saved;
  }

  async login(
    displayName?: string,
    mutation: ProfileMutationOptions = {},
  ): Promise<ManagedProfile> {
    const loginSandbox = await this.createLoginSandbox();
    try {
      await this.options.codexClient.login(loginSandbox.profileHome);
      const authDocument = await readAuthDocumentFromHome(loginSandbox.profileHome);
      const authSummary = summarizeAuthDocument(authDocument);
      const profile = await this.ensureImportedProfile(
        displayName,
        authSummary,
        mutation.workspaceLabel,
      );

      const lock = new ProfileLock(this.locksRoot, profile.id);
      await lock.acquire();
      try {
        await this.prepareSkeleton(profile.codexHome);
        await createProfileSkeleton(loginSandbox.profileHome, profile.codexHome);
        await this.options.secretStore.save(profile.id, authDocument);

        const saved = await this.saveProfileWithAuthSummary(profile, authSummary);
        await this.options.registry.setActiveProfile(saved.id);
        return (await this.options.registry.getActiveProfile()) ?? saved;
      } finally {
        await lock.release();
      }
    } finally {
      await loginSandbox.cleanup();
    }
  }

  async run(options: RunProfileOptions): Promise<number> {
    const profile = await this.resolveProfile(options.profileName);
    const lock = new ProfileLock(this.locksRoot, profile.id);

    await lock.acquire();
    try {
      await hydrateAuthIntoHome(profile.id, profile.codexHome, this.options.secretStore);
      const exitCode = await this.options.codexClient.run(options.args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          CODEX_HOME: profile.codexHome,
        },
      });
      await this.captureAuthState(profile);
      return exitCode;
    } finally {
      await lock.release();
    }
  }

  async status(options: StatusOptions = {}): Promise<ProfileStatus> {
    const initialProfile = await this.resolveProfile(options.profileName);
    const lock = new ProfileLock(this.locksRoot, initialProfile.id);
    let loginStatus: string | null = null;
    let accountSnapshot: CodexAccountSnapshot | null = null;
    let rateLimits: CodexRateLimitSnapshot | null = null;
    let profile = initialProfile;

    await lock.acquire();
    try {
      await hydrateAuthIntoHome(profile.id, profile.codexHome, this.options.secretStore);
      loginStatus = await this.options.codexClient.getLoginStatus(profile.codexHome);
      accountSnapshot = await this.options.codexClient.getAccountSnapshot(profile.codexHome);
      rateLimits = await this.options.codexClient.getRateLimits(profile.codexHome);
      profile = await this.captureAuthState(profile);
    } finally {
      await lock.release();
    }

    const nextProfile = await this.options.registry.saveProfile({
      ...profile,
      planType:
        accountSnapshot?.account?.type === "chatgpt"
          ? accountSnapshot.account.planType
          : rateLimits?.rateLimits.planType ?? profile.planType,
      lastVerifiedAt: new Date().toISOString(),
      lastRateLimitSnapshot: {
        collectedAt: new Date().toISOString(),
        authMode: profile.authMode,
        statusSummary: loginStatus,
        raw: {
          account: accountSnapshot,
          rateLimits,
        },
      },
    });

    return {
      profile: nextProfile,
      loginStatus,
      account: accountSnapshot?.account ?? null,
      rateLimits,
      requiresOpenaiAuth: accountSnapshot?.requiresOpenaiAuth ?? null,
    };
  }

  async use(displayName: string): Promise<ManagedProfile> {
    const profile = await this.resolveProfile(displayName);
    await this.options.registry.setActiveProfile(profile.id);
    return (await this.options.registry.getActiveProfile()) ?? profile;
  }

  async list(): Promise<ManagedProfile[]> {
    return this.options.registry.listProfiles();
  }

  async statusAll(): Promise<ProfileStatus[]> {
    const profiles = await this.options.registry.listProfiles();
    const statuses: ProfileStatus[] = [];

    for (const profile of profiles) {
      statuses.push(await this.status({ profileName: profile.displayName }));
    }

    return statuses;
  }

  async doctor(): Promise<DoctorStatus> {
    const [profiles, activeProfile, codex] = await Promise.all([
      this.options.registry.listProfiles(),
      this.options.registry.getActiveProfile(),
      this.options.codexClient.doctor(),
    ]);

    return {
      rootDir: this.options.rootDir,
      currentCodexHome: this.options.currentCodexHome,
      profileCount: profiles.length,
      activeProfile,
      codex,
    };
  }

  private async ensureProfile(
    displayName: string,
    workspaceLabel?: string | null,
  ): Promise<ManagedProfile> {
    const existing = await this.options.registry.getProfileByName(displayName);
    if (existing) {
      return {
        ...existing,
        workspaceLabel: workspaceLabel ?? existing.workspaceLabel,
      };
    }

    const id = createProfileId(displayName);
    return {
      id,
      displayName,
      codexHome: join(this.profilesRoot, id, "home"),
      authMode: null,
      accountId: null,
      planType: null,
      workspaceLabel: workspaceLabel ?? null,
      workspaceObserved: null,
      lastVerifiedAt: null,
      lastRateLimitSnapshot: null,
      isActive: false,
    };
  }

  private async ensureImportedProfile(
    displayName: string | undefined,
    authSummary: { accountId: string | null; email: string | null; workspaceTitle: string | null },
    workspaceLabel?: string | null,
  ): Promise<ManagedProfile> {
    if (authSummary.accountId) {
      const existingByAccount = await this.options.registry.getProfileByAccountId(
        authSummary.accountId,
      );
      if (existingByAccount) {
        return {
          ...existingByAccount,
          workspaceLabel: workspaceLabel ?? existingByAccount.workspaceLabel,
          workspaceObserved:
            authSummary.workspaceTitle ?? existingByAccount.workspaceObserved,
        };
      }
    }

    const desiredName = displayName ?? createDefaultDisplayName(authSummary);
    const availableName = await this.ensureAvailableDisplayName(
      desiredName,
      authSummary.accountId,
    );
    const created = await this.ensureProfile(availableName, workspaceLabel);
    return {
      ...created,
      workspaceObserved: authSummary.workspaceTitle ?? created.workspaceObserved,
    };
  }

  private async resolveProfile(profileName?: string): Promise<ManagedProfile> {
    if (profileName) {
      const explicit = await this.options.registry.getProfileByName(profileName);
      if (!explicit) {
        throw new Error(`Unknown profile: ${profileName}`);
      }
      return explicit;
    }

    const active = await this.options.registry.getActiveProfile();
    if (!active) {
      throw new Error("No active profile is configured.");
    }
    return active;
  }

  private async prepareSkeleton(profileHome: string): Promise<void> {
    await mkdir(this.profilesRoot, { recursive: true });
    await mkdir(this.locksRoot, { recursive: true });
    await createManagedProfileHome(profileHome);
  }

  private async captureAuthState(profile: ManagedProfile): Promise<ManagedProfile> {
    if (!(await pathExists(join(profile.codexHome, "auth.json")))) {
      await this.options.secretStore.remove(profile.id);
      return this.options.registry.saveProfile({
        ...profile,
        authMode: null,
        accountId: null,
        workspaceObserved: null,
      });
    }

    const authSummary = await persistAuthFromHome(
      profile.id,
      profile.codexHome,
      this.options.secretStore,
    );
    return this.options.registry.saveProfile({
      ...profile,
      authMode: authSummary.authMode,
      accountId: authSummary.accountId,
      workspaceObserved: authSummary.workspaceTitle ?? profile.workspaceObserved,
    });
  }

  private async ensureAvailableDisplayName(
    displayName: string,
    accountId: string | null,
  ): Promise<string> {
    const normalizedBase = displayName.trim() || `profile-${randomUUID()}`;
    let suffix = 2;
    let candidate = normalizedBase;

    while (true) {
      const existing = await this.options.registry.getProfileByName(candidate);
      if (!existing || (accountId && existing.accountId === accountId)) {
        return candidate;
      }

      candidate = `${normalizedBase}-${suffix}`;
      suffix += 1;
    }
  }

  private async createLoginSandbox(): Promise<{
    profileHome: string;
    cleanup: () => Promise<void>;
  }> {
    await mkdir(this.sandboxesRoot, { recursive: true });
    const sandboxRoot = await mkdtemp(join(this.sandboxesRoot, "login-"));
    const profileHome = join(sandboxRoot, "home");

    await createManagedProfileHome(profileHome);
    if (await pathExists(this.options.currentCodexHome)) {
      await createProfileSkeleton(this.options.currentCodexHome, profileHome);
    }

    return {
      profileHome,
      cleanup: async () => {
        await rm(sandboxRoot, { recursive: true, force: true });
      },
    };
  }

  private async saveProfileWithAuthSummary(
    profile: ManagedProfile,
    authSummary: AuthDocumentSummary,
  ): Promise<ManagedProfile> {
      const saved = await this.options.registry.saveProfile({
        ...profile,
        authMode: authSummary.authMode,
        accountId: authSummary.accountId,
        workspaceObserved: authSummary.workspaceTitle ?? profile.workspaceObserved,
      });
    return saved;
  }
}

function createProfileId(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || randomUUID();
}

function createDefaultDisplayName(summary: {
  email: string | null;
  accountId: string | null;
}): string {
  if (summary.email && summary.accountId) {
    return `${summary.email}__${summary.accountId}`;
  }

  if (summary.accountId) {
    return summary.accountId;
  }

  if (summary.email) {
    return summary.email;
  }

  return `imported-${randomUUID()}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
