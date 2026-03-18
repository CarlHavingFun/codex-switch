import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

export class ProfileLock {
  private readonly lockDir: string;
  private acquired = false;

  constructor(rootDir: string, profileId: string) {
    this.lockDir = join(rootDir, `${profileId}.lock`);
  }

  async acquire(): Promise<void> {
    try {
      await mkdir(dirname(this.lockDir), { recursive: true });
      await mkdir(this.lockDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Profile is already locked: ${message}`);
    }

    await writeFile(
      join(this.lockDir, "owner.json"),
      JSON.stringify(
        {
          pid: process.pid,
          hostname: hostname(),
          acquiredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    this.acquired = true;
  }

  async release(): Promise<void> {
    if (!this.acquired) {
      return;
    }

    await rm(this.lockDir, { recursive: true, force: true });
    this.acquired = false;
  }
}
