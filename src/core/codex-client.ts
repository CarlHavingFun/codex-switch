export interface CodexRunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface CodexAccount {
  type: "apiKey";
}

export interface CodexChatgptAccount {
  type: "chatgpt";
  email: string;
  planType: string;
}

export type CodexAccountInfo = CodexAccount | CodexChatgptAccount;

export interface CodexAccountSnapshot {
  account: CodexAccountInfo | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitWindow {
  limit?: number | null;
  remaining?: number | null;
  resetsAt?: string | null;
}

export interface CodexRateLimitEntry {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  planType: string | null;
}

export interface CodexRateLimitSnapshot {
  rateLimits: CodexRateLimitEntry;
  rateLimitsByLimitId: Record<string, CodexRateLimitEntry> | null;
}

export interface CodexDoctorResult {
  codexFound: boolean;
  version: string | null;
}

export interface CodexClient {
  login(profileHome: string): Promise<void>;
  run(args: string[], options: CodexRunOptions): Promise<number>;
  getLoginStatus(profileHome: string): Promise<string>;
  getAccountSnapshot(profileHome: string): Promise<CodexAccountSnapshot | null>;
  getRateLimits(profileHome: string): Promise<CodexRateLimitSnapshot | null>;
  doctor(): Promise<CodexDoctorResult>;
}
