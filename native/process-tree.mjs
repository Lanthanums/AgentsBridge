import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function windowsProcessSnapshot() {
  if (process.platform !== "win32")
    throw new Error("PROCESS_BINDING_UNSUPPORTED_PLATFORM");
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CreatedUtc';Expression={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}} | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
  );
  const value = JSON.parse(stdout);
  return Array.isArray(value) ? value : [value];
}
export async function processAncestors(
  pid,
  { snapshot = windowsProcessSnapshot } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("INVALID_PARENT_PID");
  const rows = await snapshot();
  const processes = new Map(rows.map((p) => [Number(p.ProcessId), p]));
  if (!processes.has(pid)) throw new Error("MCP_PARENT_PROCESS_NOT_ALIVE");
  const chain = [],
    seen = new Set();
  let current = pid;
  for (let i = 0; current > 0 && i < 32; i++) {
    if (seen.has(current)) throw new Error("PROCESS_ANCESTRY_CYCLE");
    seen.add(current);
    chain.push(current);
    const child = processes.get(current);
    if (!child) break;
    const parentId = Number(child.ParentProcessId);
    const parent = parentId > 0 ? processes.get(parentId) : undefined;
    if (parent) {
      if (!child.CreatedUtc || !parent.CreatedUtc)
        throw new Error("PROCESS_CREATION_TIME_UNAVAILABLE");
      // Fixed-width UTC timestamps preserve WMI precision when compared as strings.
      // A newer process using this PID cannot be the original parent.
      if (parent.CreatedUtc > child.CreatedUtc)
        return { chain, reusedParent: parentId };
    }
    current = parentId;
  }
  return { chain, reusedParent: null };
}
