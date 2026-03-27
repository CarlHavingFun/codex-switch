import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  ChromeCdpCaptureSession,
  waitForChromeDebugger,
} from "../src/debug/chrome-cdp-capture.js";
import { decodeAuthErrorPayloadFromUrl } from "../src/debug/login-flow-inspection.js";

const chromePort = getRequiredChromePort();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = join(process.cwd(), "output", "chrome-cdp-attach", timestamp);
const capturePath = join(outputDir, "capture.json");

await mkdir(outputDir, { recursive: true });
const webSocketDebuggerUrl = await waitForChromeDebugger(chromePort);
const session = await ChromeCdpCaptureSession.connect(webSocketDebuggerUrl);

console.log(`Attached to Chrome debugger on port ${chromePort}.`);
console.log(`Capture output: ${capturePath}`);

let stopped = false;
const stop = async () => {
  if (stopped) {
    return;
  }
  stopped = true;
  await writeSnapshot();
  await session.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});

while (!stopped) {
  await writeSnapshot();
  await delay(2_000);
}

async function writeSnapshot(): Promise<void> {
  const snapshot = session.getSnapshot();
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
        chromePort,
        browserAuthErrors,
        browserCapture: snapshot,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function getRequiredChromePort(): number {
  const flag = process.argv.find((argument) => argument.startsWith("--chrome-port="));
  if (!flag) {
    throw new Error("Missing required --chrome-port=<port>.");
  }

  const value = Number(flag.split("=")[1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid Chrome port: ${flag}`);
  }

  return value;
}
