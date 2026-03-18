import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const EXCLUDED_TOP_LEVEL = new Set(["auth.json", "log", "tmp", ".sandbox"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git"]);

export async function createManagedProfileHome(profileHome: string): Promise<void> {
  await mkdir(profileHome, { recursive: true });
}

export async function createProfileSkeleton(
  sourceCodexHome: string,
  targetCodexHome: string,
): Promise<void> {
  await createManagedProfileHome(targetCodexHome);
  await copyDirectoryContents(sourceCodexHome, targetCodexHome, true);
}

async function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  isTopLevel: boolean,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (isTopLevel && EXCLUDED_TOP_LEVEL.has(entry.name)) {
      continue;
    }

    if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath, false);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      continue;
    }

    const details = await stat(sourcePath);
    if (details.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}
