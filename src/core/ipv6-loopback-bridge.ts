import { connect, createServer, type Server } from "node:net";

export interface LoopbackBridgeHandle {
  close(): Promise<void>;
}

export async function startIpv6LoopbackBridge(
  port: number,
): Promise<LoopbackBridgeHandle | null> {
  if (process.platform !== "win32") {
    return null;
  }

  const server = createServer((clientSocket) => {
    const upstreamSocket = connect({
      host: "127.0.0.1",
      port,
    });

    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });
    upstreamSocket.on("error", () => {
      clientSocket.destroy();
    });

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        {
          host: "::1",
          port,
          ipv6Only: true,
        },
        () => {
          server.off("error", reject);
          resolve();
        },
      );
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "EADDRINUSE" || code === "EADDRNOTAVAIL") {
      server.close();
      return null;
    }
    throw error;
  }

  return {
    async close(): Promise<void> {
      await closeServer(server);
    },
  };
}

export function getAuthUrlRedirectPort(authUrl: string): number | null {
  try {
    const outerUrl = new URL(authUrl);
    const redirectUri = outerUrl.searchParams.get("redirect_uri");
    if (!redirectUri) {
      return null;
    }

    const parsedRedirect = new URL(redirectUri);
    const portValue = Number(parsedRedirect.port);
    return Number.isInteger(portValue) && portValue > 0 ? portValue : null;
  } catch {
    return null;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
