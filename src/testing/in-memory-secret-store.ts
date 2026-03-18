import type { SecretStore } from "../core/secret-store.js";

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async save(profileId: string, authDocument: string): Promise<void> {
    this.secrets.set(profileId, authDocument);
  }

  async load(profileId: string): Promise<string | null> {
    return this.secrets.get(profileId) ?? null;
  }

  async remove(profileId: string): Promise<void> {
    this.secrets.delete(profileId);
  }
}
