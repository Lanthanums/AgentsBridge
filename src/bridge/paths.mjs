import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
export const dataHome =
  process.env.AGENTSBRIDGE_HOME ||
  join(process.env.LOCALAPPDATA || homedir(), "AgentsBridge/mesh-v2");
export const endpointFile = join(dataHome, "endpoint.json");
export const uiPipeFor = (home) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\agentsbridge-ui-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`
    : join(home, "ui.sock");
export const uiPipe = uiPipeFor(dataHome);
export const bridgePipe =
  process.platform === "win32"
    ? `\\\\.\\pipe\\agentsbridge-service-${createHash("sha256").update(dataHome).digest("hex").slice(0, 16)}`
    : join(dataHome, "service.sock");
