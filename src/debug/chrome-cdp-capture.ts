import { setTimeout as delay } from "node:timers/promises";

export interface ChromeCapturedExchange {
  sessionId: string | null;
  requestId: string;
  url: string;
  method: string | null;
  resourceType: string | null;
  status: number | null;
  mimeType: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  postData: string | null;
  responseBody: string | null;
  responseBodyBase64Encoded: boolean | null;
  loadingErrorText: string | null;
}

export interface ChromeNavigationEvent {
  sessionId: string | null;
  url: string;
}

export interface ChromeCaptureSnapshot {
  exchanges: ChromeCapturedExchange[];
  navigations: ChromeNavigationEvent[];
}

interface PendingChromeExchange {
  sessionId: string | null;
  requestId: string;
  url: string;
  method: string | null;
  resourceType: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  status: number | null;
  mimeType: string | null;
  postData: string | null;
}

interface CommandResult {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
}

export function isInterestingAuthUrl(urlText: string): boolean {
  return [
    "/api/accounts/mfa/verify",
    "/api/accounts/workspace/select",
    "/sign-in-with-chatgpt/codex/consent",
    "/api/accounts/consent",
    "/api/oauth/oauth2/auth",
  ].some((segment) => urlText.includes(segment));
}

export async function waitForChromeDebugger(port: number): Promise<string> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const payload = await response.json() as {
          webSocketDebuggerUrl?: string;
        };
        if (payload.webSocketDebuggerUrl) {
          return payload.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Keep polling until Chrome exposes the endpoint.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for Chrome debugger on port ${port}.`);
}

export class ChromeCdpCaptureSession {
  private readonly socket: WebSocket;
  private nextCommandId = 1;
  private readonly pendingCommands = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly trackedRequests = new Map<string, PendingChromeExchange>();
  private readonly exchanges: ChromeCapturedExchange[] = [];
  private readonly navigations: ChromeNavigationEvent[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static async connect(webSocketDebuggerUrl: string): Promise<ChromeCdpCaptureSession> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Failed to connect to Chrome DevTools Protocol.")),
        { once: true },
      );
    });

    const session = new ChromeCdpCaptureSession(socket);
    session.bindSocket();
    await session.initialize();
    return session;
  }

  async createTarget(url: string): Promise<void> {
    await this.sendCommand("Target.createTarget", {
      url,
      newWindow: false,
    });
  }

  getSnapshot(): ChromeCaptureSnapshot {
    return {
      exchanges: [...this.exchanges],
      navigations: [...this.navigations],
    };
  }

  async close(): Promise<void> {
    this.socket.close();
    await delay(100);
  }

  private bindSocket(): void {
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        result?: unknown;
        error?: {
          message?: string;
        };
      };

      if (typeof message.id === "number") {
        const pending = this.pendingCommands.get(message.id);
        if (!pending) {
          return;
        }
        this.pendingCommands.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "CDP command failed."));
          return;
        }
        pending.resolve(message.result);
        return;
      }

      void this.handleEvent(message).catch(() => {
        // Best-effort capture only.
      });
    });
  }

  private async initialize(): Promise<void> {
    await this.sendCommand("Target.setDiscoverTargets", {
      discover: true,
    });
    await this.sendCommand("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    const result = await this.sendCommand("Target.getTargets", {}) as {
      targetInfos?: Array<{
        targetId?: string;
        type?: string;
      }>;
    };

    for (const target of result.targetInfos ?? []) {
      if (target.type !== "page" || !target.targetId) {
        continue;
      }

      const attachResult = await this.sendCommand("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      }).catch(() => {
        // A target may already be attached.
        return null;
      });

      const sessionId =
        attachResult &&
        typeof attachResult === "object" &&
        "sessionId" in attachResult &&
        typeof attachResult.sessionId === "string"
          ? attachResult.sessionId
          : null;
      if (sessionId) {
        await this.enablePageCapture(sessionId);
      }
    }
  }

  private async handleEvent(message: {
    method?: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<void> {
    const { method, params, sessionId = null } = message;
    if (!method || !params) {
      return;
    }

    if (method === "Target.attachedToTarget") {
      const targetInfo = params.targetInfo as { type?: string } | undefined;
      const attachedSessionId =
        typeof params.sessionId === "string" ? params.sessionId : null;
      if (targetInfo?.type === "page") {
        await this.enablePageCapture(attachedSessionId);
      }
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const request = params.request as {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        postData?: string;
      } | undefined;
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      const url = request?.url ?? null;
      if (!requestId || !url || !isInterestingAuthUrl(url)) {
        return;
      }

      this.trackedRequests.set(this.getTrackedRequestKey(sessionId, requestId), {
        sessionId,
        requestId,
        url,
        method: request?.method ?? null,
        resourceType: typeof params.type === "string" ? params.type : null,
        requestHeaders: normalizeHeaders(request?.headers),
        responseHeaders: {},
        status: null,
        mimeType: null,
        postData: request?.postData ?? null,
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const response = params.response as {
        url?: string;
        status?: number;
        headers?: Record<string, string>;
        mimeType?: string;
      } | undefined;
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      if (!requestId) {
        return;
      }

      const tracked = this.trackedRequests.get(this.getTrackedRequestKey(sessionId, requestId));
      if (!tracked) {
        return;
      }

      tracked.status = typeof response?.status === "number" ? response.status : null;
      tracked.responseHeaders = normalizeHeaders(response?.headers);
      tracked.mimeType = response?.mimeType ?? null;
      return;
    }

    if (method === "Network.loadingFinished") {
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      if (!requestId) {
        return;
      }

      const trackedKey = this.getTrackedRequestKey(sessionId, requestId);
      const tracked = this.trackedRequests.get(trackedKey);
      if (!tracked) {
        return;
      }

      const bodyResult = await this.sendCommand(
        "Network.getResponseBody",
        {
          requestId,
        },
        sessionId,
      ).catch(() => null) as {
        body?: string;
        base64Encoded?: boolean;
      } | null;

      this.exchanges.push({
        sessionId,
        requestId,
        url: tracked.url,
        method: tracked.method,
        resourceType: tracked.resourceType,
        status: tracked.status,
        mimeType: tracked.mimeType,
        requestHeaders: tracked.requestHeaders,
        responseHeaders: tracked.responseHeaders,
        postData: tracked.postData,
        responseBody: bodyResult?.body ?? null,
        responseBodyBase64Encoded:
          typeof bodyResult?.base64Encoded === "boolean"
            ? bodyResult.base64Encoded
            : null,
        loadingErrorText: null,
      });
      this.trackedRequests.delete(trackedKey);
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      if (!requestId) {
        return;
      }

      const trackedKey = this.getTrackedRequestKey(sessionId, requestId);
      const tracked = this.trackedRequests.get(trackedKey);
      if (!tracked) {
        return;
      }

      this.exchanges.push({
        sessionId,
        requestId,
        url: tracked.url,
        method: tracked.method,
        resourceType: tracked.resourceType,
        status: tracked.status,
        mimeType: tracked.mimeType,
        requestHeaders: tracked.requestHeaders,
        responseHeaders: tracked.responseHeaders,
        postData: tracked.postData,
        responseBody: null,
        responseBodyBase64Encoded: null,
        loadingErrorText:
          typeof params.errorText === "string" ? params.errorText : "loading_failed",
      });
      this.trackedRequests.delete(trackedKey);
      return;
    }

    if (method === "Page.frameNavigated") {
      const frame = params.frame as { parentId?: string; url?: string } | undefined;
      if (!frame?.url || frame.parentId) {
        return;
      }
      this.navigations.push({
        sessionId,
        url: frame.url,
      });
    }
  }

  private async enablePageCapture(sessionId: string | null): Promise<void> {
    await this.sendCommand("Network.enable", {}, sessionId);
    await this.sendCommand("Page.enable", {}, sessionId);
  }

  private sendCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<unknown> {
    const id = this.nextCommandId++;
    const payload = {
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    };

    this.socket.send(JSON.stringify(payload));

    return new Promise<unknown>((resolve, reject) => {
      this.pendingCommands.set(id, {
        resolve,
        reject,
      });
    });
  }

  private getTrackedRequestKey(sessionId: string | null, requestId: string): string {
    return `${sessionId ?? "browser"}:${requestId}`;
  }
}

function normalizeHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}
