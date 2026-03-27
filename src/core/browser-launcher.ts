import type { Dirent } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { CodexLoginBrowserStrategy } from "./codex-client.js";

export interface BrowserLaunchHandle {
  cleanup(): Promise<void>;
}

export interface BrowserLaunchOptions {
  strategy: CodexLoginBrowserStrategy;
  env?: NodeJS.ProcessEnv;
}

export interface BrowserInstallation {
  executablePath: string;
  userDataDir: string;
}

export interface SpawnWindowsChromiumOptions {
  userDataDir: string;
  url: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  detached?: boolean;
  shellLaunch?: boolean;
}

const excludedProfileSegments = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Safe Browsing",
]);

export async function launchLoginBrowser(
  url: string,
  options: BrowserLaunchOptions,
): Promise<BrowserLaunchHandle> {
  const env = options.env ?? process.env;

  if (options.strategy === "isolated") {
    const customHandle = await launchCustomBrowserIfConfigured(url, env);
    if (customHandle) {
      return customHandle;
    }

    if (process.platform === "win32") {
      const installation = await detectWindowsChromium(env);
      if (installation) {
        return launchIsolatedWindowsChromium(url, installation);
      }
    }
  }

  const customHandle = await launchCustomBrowserIfConfigured(url, env);
  if (customHandle) {
    return customHandle;
  }

  launchWithSystemDefault(url);
  return {
    async cleanup() {
      // No-op.
    },
  };
}

async function launchCustomBrowserIfConfigured(
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<BrowserLaunchHandle | null> {
  const command = env.CODEX_SWITCH_BROWSER_COMMAND?.trim();
  if (!command) {
    return null;
  }

  const configuredArgs = env.CODEX_SWITCH_BROWSER_ARGS_JSON
    ? JSON.parse(env.CODEX_SWITCH_BROWSER_ARGS_JSON) as string[]
    : [];
  const finalArgs = configuredArgs.some((arg) => arg.includes("{url}"))
    ? configuredArgs.map((arg) => arg.replaceAll("{url}", url))
    : [...configuredArgs, url];

  spawn(command, finalArgs, {
    env,
    detached: true,
    stdio: "ignore",
  }).unref();

  return {
    async cleanup() {
      // No-op.
    },
  };
}

async function launchIsolatedWindowsChromium(
  url: string,
  installation: BrowserInstallation,
): Promise<BrowserLaunchHandle> {
  const userDataDir = await createIsolatedWindowsChromiumUserDataDir(installation);
  const child = spawnWindowsChromium(installation, {
    userDataDir,
    url,
    detached: true,
  });
  child.unref();

  return {
    async cleanup() {
      try {
        await rm(userDataDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    },
  };
}

export async function detectWindowsChromium(
  env: NodeJS.ProcessEnv,
): Promise<BrowserInstallation | null> {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const candidates: BrowserInstallation[] = [
    {
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      userDataDir: join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      executablePath: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      userDataDir: join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      userDataDir: join(localAppData, "Microsoft", "Edge", "User Data"),
    },
    {
      executablePath: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      userDataDir: join(localAppData, "Microsoft", "Edge", "User Data"),
    },
  ];

  for (const candidate of candidates) {
    if (
      (await pathExists(candidate.executablePath)) &&
      (await pathExists(candidate.userDataDir))
    ) {
      return candidate;
    }
  }

  return null;
}

export async function createIsolatedWindowsChromiumUserDataDir(
  installation: BrowserInstallation,
): Promise<string> {
  const userDataDir = await mkdtemp(join(tmpdir(), "codex-switch-browser-"));
  const isolatedDefault = join(userDataDir, "Default");
  await mkdir(isolatedDefault, { recursive: true });

  await copyIfExists(
    join(installation.userDataDir, "Local State"),
    join(userDataDir, "Local State"),
  );
  await copyDirectoryIfExists(join(installation.userDataDir, "Default"), isolatedDefault);

  return userDataDir;
}

export function spawnWindowsChromium(
  installation: BrowserInstallation,
  options: SpawnWindowsChromiumOptions,
): ChildProcess {
  const browserArgs = [
    `--user-data-dir=${options.userDataDir}`,
    "--profile-directory=Default",
    "--new-window",
    ...(options.extraArgs ?? []),
    options.url,
  ];

  if (process.platform === "win32" && options.shellLaunch) {
    return spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath ${quoteForPowerShell(
          installation.executablePath,
        )} -ArgumentList ${browserArgs.map((part) => quoteForPowerShell(part)).join(", ")}`,
      ],
      {
        env: options.env ?? process.env,
        detached: options.detached ?? false,
        stdio: "ignore",
      },
    );
  }

  return spawn(
    installation.executablePath,
    browserArgs,
    {
      env: options.env ?? process.env,
      detached: options.detached ?? false,
      stdio: "ignore",
    },
  );
}

async function copyIfExists(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) {
    return;
  }

  await copyFile(source, target);
}

async function copyDirectoryIfExists(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) {
    return;
  }

  await copyDirectoryContents(source, target, source);
}

function shouldCopyProfilePath(root: string, currentPath: string): boolean {
  const relative = currentPath.slice(root.length).replaceAll("/", sep).replaceAll("\\", sep);
  if (!relative) {
    return true;
  }

  const segments = relative
    .split(sep)
    .filter(Boolean)
    .map((segment) => basename(segment));

  if (segments.some((segment) => segment === ".git")) {
    return false;
  }

  if (segments.some((segment) => excludedProfileSegments.has(segment))) {
    return false;
  }

  if (segments.includes("Service Worker") && segments.includes("CacheStorage")) {
    return false;
  }

  return true;
}

function launchWithSystemDefault(url: string): void {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryContents(
  source: string,
  target: string,
  filterRoot: string,
): Promise<void> {
  if (!shouldCopyProfilePath(filterRoot, source)) {
    return;
  }

  await mkdir(target, { recursive: true });

  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isIgnorableCopyError(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);

    if (!shouldCopyProfilePath(filterRoot, sourcePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath, filterRoot);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    } catch (error) {
      if (isIgnorableCopyError(error)) {
        continue;
      }
      throw error;
    }
  }
}

function isIgnorableCopyError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return false;
  }

  return new Set(["EBUSY", "EPERM", "EACCES"]).has(error.code);
}

function quoteForPowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
