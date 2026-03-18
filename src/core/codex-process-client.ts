import { spawn } from "node:child_process";

import { execa } from "execa";
import { z } from "zod";

import type {
  CodexAccountSnapshot,
  CodexClient,
  CodexDoctorResult,
  CodexRateLimitSnapshot,
  CodexRunOptions,
} from "./codex-client.js";

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
  primary: z.record(z.string(), z.unknown()).nullable(),
  secondary: z.record(z.string(), z.unknown()).nullable(),
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

  async login(profileHome: string): Promise<void> {
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

    return result.stdout.trim();
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
      const child = spawn(
        this.command,
        [...this.commandArgs, "app-server", "--listen", "stdio://"],
        {
          env: {
            ...this.baseEnv,
            CODEX_HOME: profileHome,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const responses = new Map<number, JsonRpcResponse>();
      const stderrChunks: string[] = [];
      let stdoutBuffer = "";

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out waiting for ${method} app-server response`));
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
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);

        const methodResponse = responses.get(2);
        if (methodResponse?.error) {
          reject(
            new Error(
              `app-server ${method} failed: ${methodResponse.error.message}`,
            ),
          );
          return;
        }

        if (methodResponse?.result !== undefined) {
          resolve(methodResponse.result);
          return;
        }

        reject(
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
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method,
          params,
        })}\n`,
      );
      child.stdin.end();
    });
  }
}
