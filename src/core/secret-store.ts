export interface SecretStore {
  save(profileId: string, authDocument: string): Promise<void>;
  load(profileId: string): Promise<string | null>;
  remove(profileId: string): Promise<void>;
}
