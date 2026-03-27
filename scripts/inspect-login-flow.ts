import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAuthErrorPayloadFromUrl,
  extractClaims,
  getLoginCompletedSummary,
  protocolContainsWorkspaceTitle,
  resolveLoginInspectorClientName,
  shouldAllowBrowserHistoryErrors,
  type CapturedClaims,
  type DecodedAuthErrorPayload,
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
const outputDir = join(process.cwd(), "output", "login-inspection", timestamp);
const sandboxRoot = await mkdtemp(join(tmpdir(), "codex-switch-login-flow-"));
const sandboxHome = join(sandboxRoot, "home");
const capturePath = join(outputDir, "capture.json");
const inspectionStartedAtMs = Date.now();
const messages: JsonRpcMessage[] = [];
const stderrLines: string[] = [];
let stdoutBuffer = "";
let loginStartResult: LoginStartResult | null = null;
let completedMessage: JsonRpcMessage | null = null;
let updatedMessage: JsonRpcMessage | null = null;
let claims: CapturedClaims | null = null;
let topLevelError: string | null = null;
let child: ChildProcessWithoutNullStreams;
let loopbackBridge: { close(): Promise<void> } | null = null;

interface BrowserAuthErrorObservation {
  browser: string;
  visitedAt: string | null;
  visitedAtUnixMs: number | null;
  url: string;
  title: string | null;
  decodedPayload: DecodedAuthErrorPayload | null;
}

type LoginWaitResult =
  | {
      kind: "completed";
      message: JsonRpcMessage;
    }
  | {
      kind: "browserError";
      error: BrowserAuthErrorObservation;
    };

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
          title: "codex-switch login inspector",
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
    const loginId = loginStartResult.loginId ?? null;

    if (authUrl) {
      const callbackPort = getAuthUrlRedirectPort(authUrl);
      if (callbackPort) {
        loopbackBridge = await startIpv6LoopbackBridge(callbackPort);
      }
      await writeFile(join(outputDir, "auth-url.txt"), `${authUrl}\n`, "utf8");
      console.log(`Auth URL captured and saved to ${join(outputDir, "auth-url.txt")}`);
      console.log(authUrl);
      await openUrl(authUrl);
    } else {
      console.log("No authUrl found in login start response.");
    }

    console.log("");
    console.log("Browser login is waiting. Complete the ChatGPT login flow in the opened browser.");
    console.log(`Temporary CODEX_HOME: ${sandboxHome}`);
    console.log(`Capture output: ${outputDir}`);
    console.log("");

    const loginWaitResult = await waitForLoginCompletionOrBrowserError(
      inspectionStartedAtMs,
      10 * 60_000,
    );
    if (loginWaitResult.kind === "browserError") {
      topLevelError =
        loginWaitResult.error.decodedPayload?.errorCode ?? "browser_auth_error";
      await writeCapture();
      console.error("Browser auth flow failed before localhost callback completed.");
      console.error(`browser: ${loginWaitResult.error.browser}`);
      console.error(`error url: ${loginWaitResult.error.url}`);
      if (loginWaitResult.error.decodedPayload) {
        console.error(
          `browser auth payload: ${JSON.stringify(loginWaitResult.error.decodedPayload)}`,
        );
      }
      console.error(`Saved partial capture to ${capturePath}`);
      process.exitCode = 1;
      return;
    }
    completedMessage = loginWaitResult.message;
    const accountUpdated = waitForMessage(
      (message) => message.method === "account/updated",
      10 * 60_000,
    );
    updatedMessage = await accountUpdated.catch(() => null);

    const completedSummary = getLoginCompletedSummary(completedMessage);
    if (completedSummary.success === false) {
      const capture = await writeCapture();
      console.error("Login flow completed with an error.");
      console.error(`loginId: ${completedSummary.loginId ?? loginId ?? "unknown"}`);
      console.error(`error: ${completedSummary.error ?? "unknown"}`);
      const latestBrowserAuthError = capture.browserAuthErrors[0];
      if (latestBrowserAuthError?.decodedPayload) {
        console.error(
          `browser auth payload: ${JSON.stringify(latestBrowserAuthError.decodedPayload)}`,
        );
      }
      console.error(`Saved partial capture to ${capturePath}`);
      process.exitCode = 1;
      return;
    }

    await waitForAuthDocument(sandboxHome, 15_000);

    const authDocument = await readFile(join(sandboxHome, "auth.json"), "utf8");
    claims = extractClaims(authDocument);

    await writeCapture();

    console.log("Login flow capture complete.");
    console.log(`loginId: ${loginId ?? "unknown"}`);
    console.log(`chatgpt_account_id: ${claims.chatgptAccountId ?? "unknown"}`);
    console.log(`email: ${claims.email ?? "unknown"}`);
    console.log("organizations:");
    for (const organization of claims.organizations) {
      console.log(
        `- id=${organization.id} title=${organization.title ?? "null"} default=${organization.isDefault} role=${organization.role ?? "null"}`,
      );
    }
    console.log(
      `public protocol included workspace title: ${protocolContainsWorkspaceTitle(messages)}`,
    );
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

    if (!process.argv.includes("--keep-home")) {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  }
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

async function openUrl(url: string): Promise<void> {
  if (process.argv.includes("--no-open")) {
    return;
  }

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

function shouldUseCmdWrapper(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  return /\.(cmd|bat|ps1)$/i.test(command) || !/\.[a-z0-9]+$/i.test(command);
}

function buildCmdInvocation(command: string, args: string[]): string {
  const quoted = [quoteForCmd(command), ...args.map((arg) => quoteForCmd(arg))];
  return quoted.join(" ");
}

function quoteForCmd(value: string): string {
  if (!value || /\s|"/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

async function waitForAuthDocument(profileHome: string, timeoutMs: number): Promise<void> {
  const authPath = join(profileHome, "auth.json");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await stat(authPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error(`Timed out waiting for ${authPath}`);
}

async function waitForLoginCompletionOrBrowserError(
  sinceUnixMs: number,
  timeoutMs: number,
): Promise<LoginWaitResult> {
  const start = Date.now();
  const allowBrowserHistoryErrors = shouldAllowBrowserHistoryErrors(process.argv);

  while (Date.now() - start < timeoutMs) {
    const completed = messages.find(
      (message) => message.method === "account/login/completed",
    );
    if (completed) {
      return {
        kind: "completed",
        message: completed,
      };
    }

    if (allowBrowserHistoryErrors) {
      const browserAuthError = (await findRecentBrowserAuthErrors(sinceUnixMs))[0];
      if (browserAuthError?.decodedPayload) {
        return {
          kind: "browserError",
          error: browserAuthError,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for login completion after ${timeoutMs}ms.`);
}

async function writeCapture(): Promise<{
  observedAt: string;
  sandboxHome: string;
  outputDir: string;
  loginStartResult: LoginStartResult | null;
  completedMessage: JsonRpcMessage | null;
  completedSummary: ReturnType<typeof getLoginCompletedSummary>;
  updatedMessage: JsonRpcMessage | null;
  capturedClaims: CapturedClaims | null;
  messages: JsonRpcMessage[];
  stderrLines: string[];
  publicProtocolReturnedWorkspaceTitle: boolean;
  topLevelError: string | null;
  browserAuthErrors: BrowserAuthErrorObservation[];
}> {
  const browserAuthErrors = await findRecentBrowserAuthErrors(inspectionStartedAtMs);
  const capture = {
    observedAt: new Date().toISOString(),
    sandboxHome,
    outputDir,
    loginStartResult,
    completedMessage,
    completedSummary: getLoginCompletedSummary(completedMessage),
    updatedMessage,
    capturedClaims: claims,
    messages,
    stderrLines,
    publicProtocolReturnedWorkspaceTitle: protocolContainsWorkspaceTitle(messages),
    topLevelError,
    browserAuthErrors,
  };

  await writeFile(capturePath, JSON.stringify(capture, null, 2), "utf8");
  return capture;
}

async function findRecentBrowserAuthErrors(
  sinceUnixMs: number,
): Promise<BrowserAuthErrorObservation[]> {
  const rows = await queryRecentBrowserAuthErrors();
  return rows
    .filter((row) => row.visitedAtUnixMs === null || row.visitedAtUnixMs >= sinceUnixMs - 5_000)
    .map((row) => ({
      ...row,
      decodedPayload: decodeAuthErrorPayloadFromUrl(row.url),
    }))
    .sort((left, right) => (right.visitedAtUnixMs ?? 0) - (left.visitedAtUnixMs ?? 0));
}

async function queryRecentBrowserAuthErrors(): Promise<
  Array<{
    browser: string;
    visitedAt: string | null;
    visitedAtUnixMs: number | null;
    url: string;
    title: string | null;
  }>
> {
  if (process.platform !== "win32") {
    return [];
  }

  const script = String.raw`
import json, shutil, sqlite3, tempfile
from pathlib import Path

browsers = [
    ("chrome", Path.home() / r"AppData/Local/Google/Chrome/User Data/Default/History"),
    ("edge", Path.home() / r"AppData/Local/Microsoft/Edge/User Data/Default/History"),
]
rows = []
for browser, src in browsers:
    if not src.exists():
        continue
    tmp = Path(tempfile.gettempdir()) / f"codex-switch-{browser}-history.db"
    try:
        shutil.copy2(src, tmp)
    except Exception:
        continue
    try:
        conn = sqlite3.connect(tmp)
        cur = conn.cursor()
        for last_visit_time, url, title in cur.execute(
            "select last_visit_time, url, title from urls where url like 'https://auth.openai.com/error?payload=%' order by last_visit_time desc limit 10"
        ):
            visited_at_unix_ms = int(last_visit_time / 1000 - 11644473600000)
            rows.append({
                "browser": browser,
                "visitedAt": None if last_visit_time is None else visited_at_unix_ms,
                "visitedAtUnixMs": None if last_visit_time is None else visited_at_unix_ms,
                "url": url,
                "title": title,
            })
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
print(json.dumps(rows, ensure_ascii=False))
`;

  const result = await runPythonScript(script);
  if (!result) {
    return [];
  }

  try {
    const parsed = JSON.parse(result) as Array<{
      browser?: unknown;
      visitedAt?: unknown;
      visitedAtUnixMs?: unknown;
      url?: unknown;
      title?: unknown;
    }>;
    return parsed
      .filter((row) => typeof row.url === "string")
      .map((row) => ({
        browser: typeof row.browser === "string" ? row.browser : "unknown",
        visitedAt: typeof row.visitedAt === "number" ? new Date(row.visitedAt).toISOString() : null,
        visitedAtUnixMs:
          typeof row.visitedAtUnixMs === "number" ? row.visitedAtUnixMs : null,
        url: row.url as string,
        title: typeof row.title === "string" ? row.title : null,
      }));
  } catch {
    return [];
  }
}

async function runPythonScript(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    const python = spawn("python", ["-X", "utf8", "-"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    python.stdout.setEncoding("utf8");
    python.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    python.stderr.setEncoding("utf8");
    python.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    python.on("error", () => {
      resolve(null);
    });

    python.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      if (stderr.trim()) {
        stderrLines.push(`PYTHON_HISTORY_QUERY_FAILED: ${stderr.trim()}`);
      }
      resolve(null);
    });

    python.stdin.end(script);
  });
}
