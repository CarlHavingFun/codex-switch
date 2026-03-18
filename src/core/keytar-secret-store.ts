import keytar from "keytar";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import type { SecretStore } from "./secret-store.js";

type KeytarClient = Pick<
  typeof keytar,
  "setPassword" | "getPassword" | "deletePassword"
>;

export class KeytarSecretStore implements SecretStore {
  constructor(
    private readonly serviceName = "codex-switch",
    private readonly client: KeytarClient = keytar,
  ) {}

  async save(profileId: string, authDocument: string): Promise<void> {
    const previous = await this.client.getPassword(this.serviceName, profileId);
    const payload = encodeSecret(authDocument);
    const inlineSecret = `${INLINE_PREFIX}${payload}`;

    if (inlineSecret.length <= MAX_SECRET_LENGTH) {
      await this.client.setPassword(this.serviceName, profileId, inlineSecret);
      await cleanupChunkEntries(
        this.client,
        this.serviceName,
        profileId,
        getChunkCountFromStoredSecret(previous),
      );
      return;
    }

    const chunks = chunkString(payload, CHUNK_LENGTH);
    await this.client.setPassword(
      this.serviceName,
      profileId,
      `${CHUNKED_PREFIX}${chunks.length}`,
    );
    for (const [index, chunk] of chunks.entries()) {
      await this.client.setPassword(
        this.serviceName,
        createChunkAccountName(profileId, index),
        chunk,
      );
    }
    await cleanupChunkEntries(
      this.client,
      this.serviceName,
      profileId,
      Math.max(getChunkCountFromStoredSecret(previous), chunks.length),
      chunks.length,
    );
  }

  async load(profileId: string): Promise<string | null> {
    const stored = await this.client.getPassword(this.serviceName, profileId);
    if (!stored) {
      return null;
    }

    if (stored.startsWith(INLINE_PREFIX)) {
      return decodeSecret(stored.slice(INLINE_PREFIX.length));
    }

    if (stored.startsWith(CHUNKED_PREFIX)) {
      const chunkCount = Number.parseInt(stored.slice(CHUNKED_PREFIX.length), 10);
      if (!Number.isFinite(chunkCount) || chunkCount <= 0) {
        throw new Error(`Invalid chunked secret metadata for profile: ${profileId}`);
      }

      const chunks: string[] = [];
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = await this.client.getPassword(
          this.serviceName,
          createChunkAccountName(profileId, index),
        );
        if (chunk === null) {
          throw new Error(`Missing secret chunk ${index + 1}/${chunkCount} for profile: ${profileId}`);
        }
        chunks.push(chunk);
      }
      return decodeSecret(chunks.join(""));
    }

    return stored;
  }

  async remove(profileId: string): Promise<void> {
    const stored = await this.client.getPassword(this.serviceName, profileId);
    await cleanupChunkEntries(
      this.client,
      this.serviceName,
      profileId,
      getChunkCountFromStoredSecret(stored),
    );
    await this.client.deletePassword(this.serviceName, profileId);
  }
}

const INLINE_PREFIX = "codex-switch:v1:inline:";
const CHUNKED_PREFIX = "codex-switch:v1:chunked:";
const ENCODING_PREFIX = "br64:";
const MAX_SECRET_LENGTH = 2000;
const CHUNK_LENGTH = 1800;

function encodeSecret(secret: string): string {
  return `${ENCODING_PREFIX}${brotliCompressSync(Buffer.from(secret, "utf8")).toString("base64")}`;
}

function decodeSecret(secret: string): string {
  if (!secret.startsWith(ENCODING_PREFIX)) {
    return secret;
  }

  return brotliDecompressSync(
    Buffer.from(secret.slice(ENCODING_PREFIX.length), "base64"),
  ).toString("utf8");
}

function chunkString(value: string, chunkLength: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkLength) {
    chunks.push(value.slice(index, index + chunkLength));
  }
  return chunks;
}

function createChunkAccountName(profileId: string, index: number): string {
  return `${profileId}::chunk::${index}`;
}

function getChunkCountFromStoredSecret(secret: string | null): number {
  if (!secret?.startsWith(CHUNKED_PREFIX)) {
    return 0;
  }

  const chunkCount = Number.parseInt(secret.slice(CHUNKED_PREFIX.length), 10);
  return Number.isFinite(chunkCount) && chunkCount > 0 ? chunkCount : 0;
}

async function cleanupChunkEntries(
  client: KeytarClient,
  serviceName: string,
  profileId: string,
  existingChunkCount: number,
  keepChunkCount = 0,
): Promise<void> {
  for (let index = keepChunkCount; index < existingChunkCount; index += 1) {
    await client.deletePassword(serviceName, createChunkAccountName(profileId, index));
  }
}
