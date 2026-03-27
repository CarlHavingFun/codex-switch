import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { SecretStore } from "./secret-store.js";

const authDocumentSchema = z.object({
  auth_mode: z.string().nullable().optional(),
  tokens: z
    .object({
      account_id: z.string().nullable().optional(),
      id_token: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
});

export interface AuthDocumentSummary {
  authMode: string | null;
  accountId: string | null;
  email: string | null;
  workspaceTitle: string | null;
}

export interface PersistedAuthState {
  summary: AuthDocumentSummary;
  authFingerprint: string;
}

export async function readAuthDocumentFromHome(profileHome: string): Promise<string> {
  return readFile(join(profileHome, "auth.json"), "utf8");
}

export function summarizeAuthDocument(authDocument: string): AuthDocumentSummary {
  const parsed = authDocumentSchema.parse(JSON.parse(authDocument));
  const claims = parseChatgptJwtClaims(parsed.tokens?.id_token ?? null);
  const accountId = parsed.tokens?.account_id ?? claims?.chatgptAccountId ?? null;
  return {
    authMode: parsed.auth_mode ?? null,
    accountId,
    email: claims?.email ?? null,
    workspaceTitle: inferWorkspaceTitle(accountId, claims?.organizations ?? []),
  };
}

export function fingerprintAuthDocument(authDocument: string): string {
  return createHash("sha256").update(authDocument, "utf8").digest("hex");
}

const jwtClaimsSchema = z
  .object({
    email: z.string().nullable().optional(),
    "https://api.openai.com/profile": z
      .object({
        email: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    "https://api.openai.com/auth": z
      .object({
        chatgpt_account_id: z.string().nullable().optional(),
        organizations: z
          .array(
            z
              .object({
                id: z.string(),
                title: z.string().nullable().optional(),
                is_default: z.boolean().nullable().optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

interface ParsedChatgptJwtClaims {
  email: string | null;
  chatgptAccountId: string | null;
  organizations: Array<{
    id: string;
    title: string | null;
    isDefault: boolean;
  }>;
}

function parseChatgptJwtClaims(jwt: string | null): ParsedChatgptJwtClaims | null {
  if (!jwt) {
    return null;
  }

  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    const parsed = jwtClaimsSchema.parse(payload);
    const authClaims = parsed["https://api.openai.com/auth"];
    const profileClaims = parsed["https://api.openai.com/profile"];
    return {
      email: parsed.email ?? profileClaims?.email ?? null,
      chatgptAccountId: authClaims?.chatgpt_account_id ?? null,
      organizations: (authClaims?.organizations ?? []).map((organization) => ({
        id: organization.id,
        title: organization.title ?? null,
        isDefault: organization.is_default ?? false,
      })),
    };
  } catch {
    return null;
  }
}

function inferWorkspaceTitle(
  accountId: string | null,
  organizations: ParsedChatgptJwtClaims["organizations"],
): string | null {
  const titledOrganizations = organizations.filter((organization) =>
    Boolean(organization.title?.trim()),
  );
  if (titledOrganizations.length === 0) {
    return null;
  }

  const exactMatch = accountId
    ? titledOrganizations.find((organization) => organization.id === accountId)
    : undefined;
  if (exactMatch?.title) {
    return exactMatch.title;
  }

  if (titledOrganizations.length === 1) {
    return titledOrganizations[0]?.title ?? null;
  }

  const defaultOrganizations = titledOrganizations.filter(
    (organization) => organization.isDefault,
  );
  if (defaultOrganizations.length === 1) {
    return defaultOrganizations[0]?.title ?? null;
  }

  return null;
}

export async function persistAuthFromHome(
  profileId: string,
  profileHome: string,
  secretStore: SecretStore,
): Promise<PersistedAuthState> {
  const authPath = join(profileHome, "auth.json");
  const authDocument = await readAuthDocumentFromHome(profileHome);

  await secretStore.save(profileId, authDocument);
  await rm(authPath, { force: true });

  return {
    summary: summarizeAuthDocument(authDocument),
    authFingerprint: fingerprintAuthDocument(authDocument),
  };
}

export async function hydrateAuthIntoHome(
  profileId: string,
  profileHome: string,
  secretStore: SecretStore,
): Promise<void> {
  const authDocument = await secretStore.load(profileId);
  if (!authDocument) {
    throw new Error(`No stored auth found for profile: ${profileId}`);
  }

  const authPath = join(profileHome, "auth.json");
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, authDocument, "utf8");
}
