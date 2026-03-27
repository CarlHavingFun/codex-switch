import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import {
  createIsolatedWindowsChromiumUserDataDir,
  detectWindowsChromium,
  spawnWindowsChromium,
} from "../src/core/browser-launcher.js";
import {
  ChromeCdpCaptureSession,
  waitForChromeDebugger,
} from "../src/debug/chrome-cdp-capture.js";
import {
  decodeAuthErrorPayloadFromUrl,
  extractClaims,
  getLoginCompletedSummary,
  protocolContainsWorkspaceTitle,
  resolveLoginInspectorClientName,
  type CapturedClaims,
  type JsonRpcMessage,
  type LoginStartResult,
} from "../src/debug/login-flow-inspection.js";
import {
  getAuthUrlRedirectPort,
  startIpv6LoopbackBridge,
} from "../src/core/ipv6-loopback-bridge.js";

const currentCodexHome =
  process.env.CODEX_SWITCH_CURRENT_CODEX_HOME ?? join(homedir(), ".codex");
const inspectorClientName = resolveLoginInspectorClientName();
const codexCommandArgs = process.env.CODEX_SWITCH_CODEX_ARGS_JSON
  ? JSON.parse(process.env.CODEX_SWITCH_CODEX_ARGS_JSON) as string[]
  : [];
const codexCommand =
  process.env.CODEX_SWITCH_CODEX_COMMAND ??
  (process.platform === "win32" ? "codex.cmd" : "codex");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = join(process.cwd(), "output", "login-inspection-cdp", timestamp);
const sandboxRoot = await mkdtemp(join(tmpdir(), "codex-switch-login-flow-cdp-"));
const sandboxHome = join(sandboxRoot, "home");
const capturePath = join(outputDir, "capture.json");
const messages: JsonRpcMessage[] = [];
const stderrLines: string[] = [];
let stdoutBuffer = "";
let loginStartResult: LoginStartResult | null = null;
let completedMessage: JsonRpcMessage | null = null;
let updatedMessage: JsonRpcMessage | null = null;
let claims: CapturedClaims | null = null;
let topLevelError: string | null = null;
let child: ChildProcessWithoutNullStreams;
let cdpCaptureSession: ChromeCdpCaptureSession | null = null;
let browserProcess: ReturnType<typeof spawnWindowsChromium> | null = null;
let browserUserDataDir: string | null = null;
let loopbackBridge: { close(): Promise<void> } | null = null;

await main();

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await mkdir(sandboxHome, { recursive: true });
  await copyIfExists(join(currentCodexHome, "config.toml"), join(sandboxHome, "config.toml"));

  child = shouldUseCmdWrapper(codexCommand)
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          buildCmdInvocation(codexCommand, [...codexCommandArgs, "app-server", "--listen", "stdio://"]),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CODEX_HOME: sandboxHome,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
    : spawn(codexCommand, [...codexCommandArgs, "app-server", "--listen", "stdio://"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_HOME: sandboxHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        stderrLines.push(`UNPARSEABLE_STDOUT: ${line}`);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrLines.push(...chunk.split(/\r?\n/).filter(Boolean));
  });

  try {
    const ready = waitForMessage((message) => message.id === 1);
    const loginStarted = waitForMessage(
      (message) => message.id === 2 && isLoginStartResult(message.result),
      30_000,
    );

    writeJsonRpc({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: inspectorClientName,
          title: "codex-switch login cdp inspector",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [],
        },
      },
    });

    await ready;

    writeJsonRpc({
      id: 2,
      method: "account/login/start",
      params: {
        type: "chatgpt",
      },
    });

    const loginStartMessage = await loginStarted;
    loginStartResult = loginStartMessage.result as LoginStartResult;
    const authUrl = loginStartResult.authUrl ?? null;

    if (!authUrl) {
      throw new Error("No authUrl found in login start response.");
    }

    await writeFile(join(outputDir, "auth-url.txt"), `${authUrl}\n`, "utf8");
    const callbackPort = getAuthUrlRedirectPort(authUrl);
    if (callbackPort) {
      loopbackBridge = await startIpv6LoopbackBridge(callbackPort);
    }
    await openChromeCapture(authUrl);

    console.log("");
    console.log("System Chrome capture is ready. Complete the ChatGPT login flow in the opened browser.");
    console.log(`Temporary CODEX_HOME: ${sandboxHome}`);
    console.log(`Capture output: ${outputDir}`);
    console.log("");

    completedMessage = await waitForMessage(
      (message) => message.method === "account/login/completed",
      10 * 60_000,
    );
    updatedMessage = await waitForMessage(
      (message) => message.method === "account/updated",
      10 * 60_000,
    ).catch(() => null);

    const completedSummary = getLoginCompletedSummary(completedMessage);
    if (completedSummary.success === false) {
      topLevelError = completedSummary.error ?? "login_failed";
      await writeCapture();
      console.error(`Login flow completed with an error: ${topLevelError}`);
      console.error(`Saved partial capture to ${capturePath}`);
      process.exitCode = 1;
      return;
    }

    await waitForAuthDocument(sandboxHome, 15_000);
    const authDocument = await readFile(join(sandboxHome, "auth.json"), "utf8");
    claims = extractClaims(authDocument);
    await writeCapture();

    console.log("Login flow capture complete.");
    console.log(`Saved capture to ${capturePath}`);
  } catch (error) {
    topLevelError = error instanceof Error ? error.message : String(error);
    await writeCapture();
    throw error;
  } finally {
    if (loopbackBridge) {
      await loopbackBridge.close();
    }
    child.stdin.end();
    child.kill();
    if (cdpCaptureSession) {
      await cdpCaptureSession.close();
    }
    if (browserProcess) {
      browserProcess.kill();
    }
    if (browserUserDataDir && !process.argv.includes("--keep-browser-profile")) {
      await rm(browserUserDataDir, { recursive: true, force: true });
    }
    if (!process.argv.includes("--keep-home")) {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  }
}

async function openChromeCapture(authUrl: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The CDP login capture currently supports Windows only.");
  }

  const existingPort = getExistingChromePort();
  const port = existingPort ?? await allocateFreePort();
  if (!existingPort) {
    const installation = await detectWindowsChromium(process.env);
    if (!installation) {
      throw new Error("Could not find a local Chrome or Edge installation.");
    }

    browserUserDataDir = await createIsolatedWindowsChromiumUserDataDir(installation);
    browserProcess = spawnWindowsChromium(installation, {
      userDataDir: browserUserDataDir,
      url: authUrl,
      extraArgs: [
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
      ],
      shellLaunch: true,
    });
  }

  console.log(`Chrome debug port: ${port}`);
  const webSocketDebuggerUrl = await waitForChromeDebugger(port);
  cdpCaptureSession = await ChromeCdpCaptureSession.connect(webSocketDebuggerUrl);
}

async function writeCapture(): Promise<void> {
  const completedSummary = getLoginCompletedSummary(completedMessage);
  const snapshot = cdpCaptureSession?.getSnapshot() ?? {
    exchanges: [],
    navigations: [],
  };
  const browserAuthErrors = snapshot.navigations
    .filter((navigation) => navigation.url.includes("auth.openai.com/error?payload="))
    .map((navigation) => ({
      url: navigation.url,
      decodedPayload: decodeAuthErrorPayloadFromUrl(navigation.url),
    }));

  await writeFile(
    capturePath,
    JSON.stringify(
      {
        loginStartResult,
        completedSummary,
        updatedMessage,
        claims,
        topLevelError,
        publicProtocolReturnedWorkspaceTitle: protocolContainsWorkspaceTitle(messages),
        browserAuthErrors,
        browserCapture: snapshot,
        stderrLines,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeJsonRpc(payload: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}

function waitForMessage(
  predicate: (message: JsonRpcMessage) => boolean,
  timeoutMs = 15_000,
): Promise<JsonRpcMessage> {
  return new Promise<JsonRpcMessage>((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const matched = messages.find(predicate);
      if (matched) {
        clearInterval(interval);
        resolve(matched);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for JSON-RPC message after ${timeoutMs}ms.`));
      }
    }, 150);
  });
}

function isLoginStartResult(value: unknown): value is LoginStartResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof Reflect.get(value, "type") === "string"
  );
}

async function copyIfExists(source: string, target: string): Promise<void> {
  try {
    await stat(source);
    await copyFile(source, target);
  } catch {
    // Best-effort only.
  }
}

async function waitForAuthDocument(profileHome: string, timeoutMs: number): Promise<void> {
  const authPath = join(profileHome, "auth.json");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await stat(authPath);
      return;
    } catch {
      await delay(250);
    }
  }

  throw new Error(`Timed out waiting for ${authPath}.`);
}

function shouldUseCmdWrapper(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  return /\.(cmd|bat|ps1)$/i.test(command) || !/\.[a-z0-9]+$/i.test(command);
}

function buildCmdInvocation(command: string, args: string[]): string {
  return [command, ...args].map((part) => quoteForCmd(part)).join(" ");
}

function quoteForCmd(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replaceAll("\"", "\"\"")}"`;
}

async function allocateFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a local port."));
        return;
      }

      const port = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function getExistingChromePort(): number | null {
  const flag = process.argv.find((argument) => argument.startsWith("--chrome-port="));
  if (!flag) {
    return null;
  }

  const value = Number(flag.split("=")[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}
