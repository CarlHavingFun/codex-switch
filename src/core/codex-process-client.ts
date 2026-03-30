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
import { performOauthBrowserLogin } from "./oauth-browser-login.js";

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

interface CodexProcessClientOptions {
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
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
    await performOauthBrowserLogin({
      profileHome,
      env: this.baseEnv,
      browserStrategy: "isolated",
      timeoutMs: Math.max(this.timeoutMs, 30_000),
    });

    const authPath = join(profileHome, "auth.json");
    await stat(authPath);
  }
}
