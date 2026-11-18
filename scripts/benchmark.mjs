import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapter } from "../src/bridge/adapters/index.mjs";
import { discover, projectRoot } from "../src/bridge/discover.mjs";
import { isolatedCodexArgs } from "../src/bridge/adapters/base.mjs";
import { launch } from "../src/bridge/process.mjs";
const exec = promisify(execFile),
  specs = discover();
const cwd = join(projectRoot, "private/probe-workspace");
mkdirSync(cwd, { recursive: true });
const kinds = process.argv
  .find((x) => x.startsWith("--agents="))
  ?.split("=")[1]
  .split(",") || ["dsh", "kimi", "codex"];
const roots = new Set();
const cpu = new Map();
let peak = 0,
  sampleEpoch = Date.now(),
  sampling = false,
  run = true,
  sampleCount = 0;
const sampler = (async () => {
  while (run) {
    try {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
      const all = JSON.parse(stdout);
      const byPid = new Map(all.map((p) => [p.ProcessId, p]));
      // Windows parent PIDs can outlive their parent and later be reused.
      // Only current-lifetime roots and children born after their parent count.
      const selected = new Set(
        [...roots].filter(
          (pid) => Date.parse(byPid.get(pid)?.Created) >= sampleEpoch,
        ),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of all)
          if (
            selected.has(p.ParentProcessId) &&
            !selected.has(p.ProcessId) &&
            Date.parse(p.Created) >=
              Date.parse(byPid.get(p.ParentProcessId)?.Created)
          ) {
            selected.add(p.ProcessId);
            changed = true;
          }
      }
      let rss = 0;
      for (const p of all)
        if (selected.has(p.ProcessId)) {
          rss += Number(p.WorkingSetSize);
          cpu.set(`${p.ProcessId}:${p.Created}`, {
            name: p.Name,
            seconds: Math.max(
              cpu.get(`${p.ProcessId}:${p.Created}`)?.seconds || 0,
              (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7,
            ),
          });
        }
      peak = Math.max(peak, rss);
      sampleCount++;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
})();
const report = {
  at: new Date().toISOString(),
  methodology:
    "Real API runs, two turns per agent in each mode. One-shot restarts and resumes between turns; persistent mode keeps the connection. Same reply-only prompt and configured model. CPU/working-set sampled across Job Object hosts and descendant CLIs; sampled peaks are lower bounds. Not P95 or a large-sample performance claim.",
  scenarios: [],
};
try {
  for (const n of [1, kinds.length]) {
    const agents = kinds.slice(0, n);
    for (const mode of ["one-shot", "persistent"]) {
      cpu.clear();
      sampleEpoch = Date.now();
      peak = 0;
      sampleCount = 0;
      const scenario = { mode, agents, n, latencies_ms: [] };
      const started = performance.now();
      await Promise.all(
        agents.map(async (kind) => {
          if (mode === "one-shot") {
            let sessionId;
            const times = [],
              results = [];
            for (let turn = 0; turn < 2; turn++) {
              const t = performance.now();
              const task =
                "Performance probe. Do not use tools or delegate. Reply exactly BENCH_OK.";
              const args =
                kind === "codex"
                  ? [
                      "exec",
                      ...(sessionId ? ["resume", sessionId] : []),
                      "--json",
                      "--dangerously-bypass-approvals-and-sandbox",
                      "--skip-git-repo-check",
                      ...isolatedCodexArgs(),
                      task,
                    ]
                  : kind === "dsh"
                    ? [
                        "headless",
                        "--json",
                        ...(sessionId ? ["--session-id", sessionId] : []),
                        task,
                      ]
                    : [
                        "-p",
                        task,
                        "--output-format",
                        "stream-json",
                        ...(sessionId ? ["--session", sessionId] : []),
                      ];
              let text = "";
              let observed;
              const child = launch(specs[kind], args, {
                cwd,
                onLine: (l) => {
                  text += l + "\n";
                  try {
                    const e = JSON.parse(l);
                    observed ??= e.thread_id || e.sessionId || e.session_id;
                  } catch {}
                },
              });
              roots.add(child.pid);
              child.stdin.end();
              await new Promise((res, rej) => {
                child.on("error", rej);
                child.on("close", (code) =>
                  code === 0 ? res() : rej(new Error(`${kind} exit ${code}`)),
                );
              });
              if (sessionId && observed !== sessionId)
                throw new Error("Benchmark resume id mismatch");
              sessionId = observed;
              if (!sessionId)
                throw new Error("Benchmark session id unavailable");
              times.push(Math.round(performance.now() - t));
              results.push(text.includes("BENCH_OK"));
              roots.delete(child.pid);
            }
            scenario.latencies_ms.push({
              kind,
              cold: times[0],
              warm: times[1],
              ok: results.every(Boolean),
            });
          } else {
            const a = createAdapter(kind);
            try {
              const t = performance.now();
              const p = a.start({ cwd });
              setTimeout(() => {
                if (a.rpc?.child.pid) roots.add(a.rpc.child.pid);
              }, 10);
              await p;
              const first = await a.send(
                "Performance probe. Do not use tools or delegate. Reply exactly BENCH_OK.",
              );
              const cold = Math.round(performance.now() - t);
              const w = performance.now();
              const second = await a.send("No tools. Reply exactly BENCH_OK.");
              scenario.latencies_ms.push({
                kind,
                cold,
                warm: Math.round(performance.now() - w),
                ok:
                  first.text.includes("BENCH_OK") &&
                  second.text.includes("BENCH_OK"),
              });
            } finally {
              const pid = a.rpc?.child.pid;
              await a.destroy();
              roots.delete(pid);
            }
          }
        }),
      );
      scenario.wall_ms = Math.round(performance.now() - started);
      scenario.cpu_seconds_sampled = [...cpu.values()].reduce(
        (a, b) => a + b.seconds,
        0,
      );
      scenario.cpu_processes = [...cpu].map(([identity, value]) => ({
        identity,
        ...value,
      }));
      scenario.peak_working_set_mib_sampled = +(peak / 1024 / 1024).toFixed(1);
      scenario.sample_count = sampleCount;
      report.scenarios.push(scenario);
      console.log(JSON.stringify(scenario));
    }
  }
} catch (error) {
  report.error = error.stack;
} finally {
  run = false;
  await sampler;
  mkdirSync(join(projectRoot, "outputs/benchmarks"), { recursive: true });
  writeFileSync(
    join(projectRoot, "outputs/benchmarks/latest.json"),
    JSON.stringify(report, null, 2),
  );
}
