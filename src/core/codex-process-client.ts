import { stat } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";
import { z } from "zod";

import type {
  CodexAccountSnapshot,
  CodexClient,
  CodexDoctorResult,
  CodexLoginOptions,
  CodexRateLimitSnapshot,
  CodexRunOptions,
} from "./codex-client.js";
import { launchLoginBrowser } from "./browser-launcher.js";
import {
  getAuthUrlRedirectPort,
  startIpv6LoopbackBridge,
} from "./ipv6-loopback-bridge.js";

const accountSnapshotSchema = z.object({
  account: z
    .union([
      z.object({
        type: z.literal("apiKey"),
      }),
      z.object({
        type: z.literal("chatgpt"),
        email: z.string(),
        planType: z.string(),
      }),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});

const rateLimitEntrySchema = z.object({
  limitId: z.string().nullable(),
  limitName: z.string().nullable(),
  primary: z
    .object({
      usedPercent: z.number(),
      windowDurationMins: z.number().nullable(),
      resetsAt: z.number().nullable(),
    })
    .nullable(),
  secondary: z
    .object({
      usedPercent: z.number(),
      windowDurationMins: z.number().nullable(),
      resetsAt: z.number().nullable(),
    })
    .nullable(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable(),
  planType: z.string().nullable(),
});

const rateLimitSnapshotSchema = z.object({
  rateLimits: rateLimitEntrySchema,
  rateLimitsByLimitId: z.record(z.string(), rateLimitEntrySchema).nullable(),
});

const loginStartResultSchema = z.object({
  type: z.literal("chatgpt"),
  loginId: z.string(),
  authUrl: z.string(),
});

const loginCompletedParamsSchema = z.object({
  loginId: z.string().nullable().optional(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
});

interface CodexProcessClientOptions {
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface CodexAppServerProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

export class CodexProcessClient implements CodexClient {
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: CodexProcessClientOptions = {}) {
    this.command = options.command ?? "codex";
    this.commandArgs = options.commandArgs ?? [];
    this.baseEnv = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async login(profileHome: string, options: CodexLoginOptions = {}): Promise<void> {
    if (options.browserStrategy === "isolated") {
      await this.loginWithIsolatedBrowser(profileHome);
      return;
    }

    await execa(this.command, [...this.commandArgs, "login"], {
      env: {
        ...this.baseEnv,
        CODEX_HOME: profileHome,
      },
      stdio: "inherit",
    });
  }

  async run(args: string[], options: CodexRunOptions): Promise<number> {
    const result = await execa(this.command, [...this.commandArgs, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      reject: false,
    });

    return result.exitCode ?? 0;
  }

  async getLoginStatus(profileHome: string): Promise<string> {
    const result = await execa(
      this.command,
      [...this.commandArgs, "login", "status"],
      {
        env: {
          ...this.baseEnv,
          CODEX_HOME: profileHome,
        },
      },
    );

    return result.stdout.trim() || result.stderr.trim();
  }

  async getAccountSnapshot(profileHome: string): Promise<CodexAccountSnapshot | null> {
    try {
      const payload = await this.callAppServer(profileHome, "account/read", {
        refreshToken: false,
      });
      return accountSnapshotSchema.parse(payload);
    } catch {
      return null;
    }
  }

  async getRateLimits(profileHome: string): Promise<CodexRateLimitSnapshot | null> {
    try {
      const payload = await this.callAppServer(
        profileHome,
        "account/rateLimits/read",
        {},
      );
      return rateLimitSnapshotSchema.parse(payload);
    } catch {
      return null;
    }
  }

  async doctor(): Promise<CodexDoctorResult> {
    try {
      const result = await execa(this.command, [...this.commandArgs, "--version"]);
      return {
        codexFound: true,
        version: result.stdout.trim() || null,
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (code === "ENOENT") {
        return {
          codexFound: false,
          version: null,
        };
      }

      throw error;
    }
  }

  private async callAppServer(
    profileHome: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const child = execa(
        this.command,
        [...this.commandArgs, "app-server", "--listen", "stdio://"],
        {
          cleanup: false,
          env: {
            ...this.baseEnv,
            CODEX_HOME: profileHome,
          },
          reject: false,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      ) as unknown as CodexAppServerProcess;
      const responses = new Map<number, JsonRpcResponse>();
      const stderrChunks: string[] = [];
      let stdoutBuffer = "";
      let methodSent = false;
      let settled = false;

      const settle = (
        action: "resolve" | "reject",
        value: unknown,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        try {
          child.stdin.end();
        } catch {
          // Best-effort cleanup only.
        }
        child.kill();
        if (action === "resolve") {
          resolve(value);
          return;
        }
        reject(value);
      };

      const timeout = setTimeout(() => {
        settle(
          "reject",
          new Error(`Timed out waiting for ${method} app-server response`),
        );
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const response = JSON.parse(line) as JsonRpcResponse;
          if (typeof response.id === "number") {
            responses.set(response.id, response);
            if (response.id === 1 && !methodSent) {
              methodSent = true;
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method,
                  params,
                })}\n`,
              );
              child.stdin.end();
            }
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.on("error", (error) => {
        settle("reject", error);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }

        const methodResponse = responses.get(2);
        if (methodResponse?.error) {
          settle(
            "reject",
            new Error(
              `app-server ${method} failed: ${methodResponse.error.message}`,
            ),
          );
          return;
        }

        if (methodResponse?.result !== undefined) {
          settle("resolve", methodResponse.result);
          return;
        }

        settle(
          "reject",
          new Error(
            `app-server ${method} exited with code ${code ?? "unknown"}: ${stderrChunks.join("")}`,
          ),
        );
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "codex-switch",
              title: "codex-switch",
              version: "0.1.0",
            },
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: [],
            },
          },
        })}\n`,
      );
    });
  }

  private async loginWithIsolatedBrowser(profileHome: string): Promise<void> {
    const child = execa(
      this.command,
      [...this.commandArgs, "app-server", "--listen", "stdio://"],
      {
        cleanup: false,
        env: {
          ...this.baseEnv,
          CODEX_HOME: profileHome,
        },
        reject: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    ) as unknown as CodexAppServerProcess;

    const messages: JsonRpcResponse[] = [];
    const stderrChunks: string[] = [];
    let stdoutBuffer = "";
    let browserHandle: { cleanup(): Promise<void> } | null = null;
    let loopbackBridge: { close(): Promise<void> } | null = null;
    let childClosed = false;
    let closeCode: number | null = null;

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
          messages.push(JSON.parse(line) as JsonRpcResponse);
        } catch {
          stderrChunks.push(`UNPARSEABLE_STDOUT: ${line}`);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      childClosed = true;
      closeCode = code;
    });

    try {
      this.writeJsonRpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-switch",
            title: "codex-switch",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [],
          },
        },
      });

      await this.waitForMessage(
        messages,
        () => childClosed,
        () => closeCode,
        stderrChunks,
        (message) => message.id === 1 && message.error === undefined,
        "Timed out waiting for app-server initialize response",
      );

      this.writeJsonRpc(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "account/login/start",
        params: {
          type: "chatgpt",
        },
      });

      const loginStartMessage = await this.waitForMessage(
        messages,
        () => childClosed,
        () => closeCode,
        stderrChunks,
        (message) => message.id === 2 && message.result !== undefined,
        "Timed out waiting for app-server login start response",
      );
      if (loginStartMessage.error) {
        throw new Error(`app-server account/login/start failed: ${loginStartMessage.error.message}`);
      }

      const loginStart = loginStartResultSchema.parse(loginStartMessage.result);
      const callbackPort = getAuthUrlRedirectPort(loginStart.authUrl);
      if (callbackPort) {
        loopbackBridge = await startIpv6LoopbackBridge(callbackPort);
      }
      browserHandle = await launchLoginBrowser(loginStart.authUrl, {
        strategy: "isolated",
        env: this.baseEnv,
      });

      const completedMessage = await this.waitForMessage(
        messages,
        () => childClosed,
        () => closeCode,
        stderrChunks,
        (message) =>
          message.method === "account/login/completed" &&
          typeof message.params === "object" &&
          message.params !== null &&
          (message.params as { loginId?: string | null }).loginId === loginStart.loginId,
        "Timed out waiting for app-server login completion notification",
        Math.max(this.timeoutMs, 30_000) * 4,
      );
      const completed = loginCompletedParamsSchema.parse(completedMessage.params);
      if (!completed.success) {
        throw new Error(
          completed.error?.trim() || "Sign-in could not be completed.",
        );
      }

      await this.waitForAuthDocument(join(profileHome, "auth.json"));
    } finally {
      if (loopbackBridge) {
        await loopbackBridge.close();
      }
      if (browserHandle) {
        await browserHandle.cleanup();
      }
      try {
        child.stdin.end();
      } catch {
        // Best-effort cleanup only.
      }
      child.kill();
    }

    const authPath = join(profileHome, "auth.json");
    await stat(authPath);
  }

  private writeJsonRpc(
    child: CodexAppServerProcess,
    payload: Record<string, unknown>,
  ): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async waitForMessage(
    messages: JsonRpcResponse[],
    childClosed: () => boolean,
    closeCode: () => number | null,
    stderrChunks: string[],
    predicate: (message: JsonRpcResponse) => boolean,
    timeoutMessage: string,
    timeoutMs = this.timeoutMs,
  ): Promise<JsonRpcResponse> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const matched = messages.find(predicate);
      if (matched) {
        return matched;
      }

      if (childClosed()) {
        throw new Error(
          `app-server exited before completing login flow (code ${closeCode() ?? "unknown"}): ${stderrChunks.join("")}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(timeoutMessage);
  }

  private async waitForAuthDocument(authPath: string): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = Math.max(this.timeoutMs, 30_000);

    while (Date.now() - startedAt < timeoutMs) {
      try {
        await stat(authPath);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    throw new Error(`Timed out waiting for auth document at ${authPath}`);
  }
}
