import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import { InMemorySecretStore } from "../../src/testing/in-memory-secret-store.js";
import {
  fingerprintAuthDocument,
  hydrateAuthIntoHome,
  persistAuthFromHome,
  summarizeAuthDocument,
} from "../../src/core/managed-auth.js";

function createChatgptJwt(params: {
  email?: string;
  accountId?: string;
  organizations?: Array<{
    id: string;
    title?: string;
    is_default?: boolean;
    role?: string;
  }>;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      email: params.email ?? "user@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: params.accountId ?? "acct_123",
        organizations: params.organizations ?? [],
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("managed-auth", () => {
  test("persists auth.json into the secret store and removes it from disk", async () => {
    const profileHome = await mkdtemp(join(tmpdir(), "codex-switch-auth-"));
    const authPath = join(profileHome, "auth.json");
    const authJson = JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          account_id: "acct_123",
          access_token: "access",
          refresh_token: "refresh",
          id_token: "id",
        },
      },
      null,
      2,
    );
    const secretStore = new InMemorySecretStore();

    await writeFile(authPath, authJson, "utf8");

    const persisted = await persistAuthFromHome("profile-1", profileHome, secretStore);

    await expect(secretStore.load("profile-1")).resolves.toBe(authJson);
    await expect(readFile(authPath, "utf8")).rejects.toThrow();
    expect(persisted.authFingerprint).toBe(fingerprintAuthDocument(authJson));
    expect(persisted.summary).toEqual({
      authMode: "chatgpt",
      accountId: "acct_123",
      email: null,
      workspaceTitle: null,
    });
  });

  test("hydrates auth.json from the secret store before running Codex", async () => {
    const profileHome = await mkdtemp(join(tmpdir(), "codex-switch-auth-"));
    const authPath = join(profileHome, "auth.json");
    const secretStore = new InMemorySecretStore();

    await secretStore.save(
      "profile-1",
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "acct_456",
          access_token: "access",
          refresh_token: "refresh",
          id_token: "id",
        },
      }),
    );

    await hydrateAuthIntoHome("profile-1", profileHome, secretStore);

    await expect(readFile(authPath, "utf8")).resolves.toContain("\"acct_456\"");
  });

  test("summarizes auth mode and account id without exposing token values", () => {
    const summary = summarizeAuthDocument(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "acct_789",
          access_token: "access",
          refresh_token: "refresh",
          id_token: "id",
        },
      }),
    );

    expect(summary).toEqual({
      authMode: "chatgpt",
      accountId: "acct_789",
      email: null,
      workspaceTitle: null,
    });
  });

  test("extracts email and best-effort workspace title from chatgpt jwt claims", () => {
    const summary = summarizeAuthDocument(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "acct_workspace",
          access_token: "access",
          refresh_token: "refresh",
          id_token: createChatgptJwt({
            email: "person@example.com",
            accountId: "acct_workspace",
            organizations: [
              {
                id: "org-123",
                title: "Workspace Prime",
                is_default: true,
                role: "owner",
              },
            ],
          }),
        },
      }),
    );

    expect(summary).toEqual({
      authMode: "chatgpt",
      accountId: "acct_workspace",
      email: "person@example.com",
      workspaceTitle: "Workspace Prime",
    });
  });

  test("computes a stable auth fingerprint from the raw auth document", () => {
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct_fingerprint",
        access_token: "access",
        refresh_token: "refresh",
        id_token: "id",
      },
    });

    expect(fingerprintAuthDocument(authJson)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintAuthDocument(authJson)).toBe(fingerprintAuthDocument(authJson));
    expect(fingerprintAuthDocument(`${authJson}\n`)).not.toBe(
      fingerprintAuthDocument(authJson),
    );
  });
});
