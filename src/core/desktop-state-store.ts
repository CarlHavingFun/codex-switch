import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

export const desktopStatusSchema = z.object({
  managed: z.boolean(),
  running: z.boolean(),
  desktopPid: z.number().int().nullable(),
  monitorPid: z.number().int().nullable(),
  executablePath: z.string().nullable(),
  sessionHome: z.string().nullable(),
  launchedAt: z.string().nullable(),
  launchProfileId: z.string().nullable(),
  lastObservedAccountId: z.string().nullable(),
  lastObservedProfileId: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

export type DesktopStatusState = z.infer<typeof desktopStatusSchema>;

const EMPTY_STATUS: DesktopStatusState = {
  managed: false,
  running: false,
  desktopPid: null,
  monitorPid: null,
  executablePath: null,
  sessionHome: null,
  launchedAt: null,
  launchProfileId: null,
  lastObservedAccountId: null,
  lastObservedProfileId: null,
  lastSyncedAt: null,
  lastError: null,
};

export class DesktopStateStore {
  readonly statusFile: string;

  constructor(rootDir: string) {
    this.statusFile = join(rootDir, "desktop", "status.json");
  }

  async read(): Promise<DesktopStatusState> {
    await this.ensureInitialized();
    const raw = await readFile(this.statusFile, "utf8");
    return desktopStatusSchema.parse(JSON.parse(raw));
  }

  async write(state: DesktopStatusState): Promise<DesktopStatusState> {
    await mkdir(dirname(this.statusFile), { recursive: true });
    await writeFile(this.statusFile, JSON.stringify(state, null, 2), "utf8");
    return state;
  }

  async reset(): Promise<DesktopStatusState> {
    return this.write(EMPTY_STATUS);
  }

  private async ensureInitialized(): Promise<void> {
    await mkdir(dirname(this.statusFile), { recursive: true });
    try {
      await readFile(this.statusFile, "utf8");
    } catch {
      await this.write(EMPTY_STATUS);
    }
  }
}
