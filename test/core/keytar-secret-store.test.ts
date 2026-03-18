import { describe, expect, test, vi } from "vitest";

import { KeytarSecretStore } from "../../src/core/keytar-secret-store.js";

describe("KeytarSecretStore", () => {
  test("stores short secrets and loads them back", async () => {
    const keytarClient = {
      setPassword: vi.fn(async () => undefined),
      getPassword: vi.fn(async () => "secret-json"),
      deletePassword: vi.fn(async () => true),
    };
    const store = new KeytarSecretStore("codex-switch-test", keytarClient);

    await store.save("profile-1", "secret-json");
    await expect(store.load("profile-1")).resolves.toBe("secret-json");
    await store.remove("profile-1");

    expect(keytarClient.setPassword).toHaveBeenCalledWith(
      "codex-switch-test",
      "profile-1",
      expect.stringContaining("codex-switch:v1:inline:"),
    );
    expect(keytarClient.getPassword).toHaveBeenCalledWith(
      "codex-switch-test",
      "profile-1",
    );
    expect(keytarClient.deletePassword).toHaveBeenCalledWith(
      "codex-switch-test",
      "profile-1",
    );
  });

  test("chunks oversized secrets so windows credential limits do not break import", async () => {
    const secrets = new Map<string, string>();
    const keytarClient = {
      setPassword: vi.fn(async (_service: string, account: string, secret: string) => {
        if (secret.length > 2500) {
          throw new Error("secret too large");
        }
        secrets.set(account, secret);
      }),
      getPassword: vi.fn(async (_service: string, account: string) => secrets.get(account) ?? null),
      deletePassword: vi.fn(async (_service: string, account: string) => secrets.delete(account)),
    };
    const store = new KeytarSecretStore("codex-switch-test", keytarClient);
    const noisyToken = Array.from({ length: 1800 }, (_, index) =>
      `${index.toString(36)}_${(index * 17).toString(36)}`,
    ).join("|");
    const largeSecret = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct_large",
        access_token: noisyToken,
        refresh_token: `${noisyToken}-refresh`,
        id_token: `${noisyToken}-id-token`,
      },
    });

    await store.save("profile-oversized", largeSecret);

    await expect(store.load("profile-oversized")).resolves.toBe(largeSecret);
    const storedKeys = Array.from(secrets.keys()).filter((key) =>
      key.startsWith("profile-oversized"),
    );
    expect(storedKeys).toContain("profile-oversized");
    expect(storedKeys.length).toBeGreaterThan(2);

    await store.remove("profile-oversized");

    expect(
      Array.from(secrets.keys()).filter((key) => key.startsWith("profile-oversized")),
    ).toHaveLength(0);
  });
});
