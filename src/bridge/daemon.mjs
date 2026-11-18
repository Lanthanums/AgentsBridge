import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { once } from "node:events";
import { dataHome, endpointFile, bridgePipe } from "./paths.mjs";
import { Journal } from "./journal.mjs";
import { Engine } from "./engine.mjs";
import { uiLauncher } from "./ui-launcher.mjs";
import { discover, projectRoot } from "./discover.mjs";
import { loadConfig } from "./config.mjs";
import { sourceVersion } from "./version.mjs";
import { modelOptions } from "./execution-options.mjs";
import { processAncestors } from "../../native/process-tree.mjs";
export async function startDaemon({
  home = dataHome,
  engineOptions = {},
  port = 0,
} = {}) {
  mkdirSync(home, { recursive: true });
  const config = loadConfig(home);
  const journal = new Journal(home);
  const ui = uiLauncher(journal);
  const engine = new Engine(journal, {
    ...config,
    ...engineOptions,
    ui: engineOptions.ui || ui,
  });
  const token = randomBytes(32).toString("hex");
  const scopes = new Map();
  const managedHosts = new Map();
  const clients = new Set();
  let closing = false;
  const buildId = sourceVersion();
  const auth = (req) => {
    const supplied = req.headers.authorization?.replace(/^Bearer /, "") || "";
    return (
      supplied.length === token.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    );
  };
  const audit = (error) =>
    appendFileSync(
      join(home, "bridge.log"),
      `${new Date().toISOString()} ${error.stack || error}\n`,
    );
  const rpc = async (method, p, scope) => {
    if (
      engine.closed &&
      [
        "create",
        "send",
        "deliver",
        "progress",
        "decision",
        "complete",
        "review",
        "reviewArtifact",
        "retryTask",
        "planBudget",
        "scopeForProcess",
      ].includes(method)
    )
      throw new Error("BRIDGE_RELOADING");
    if (scope) {
      const c = engine.get(scope.collab_id);
      if (c.epoch !== scope.epoch) throw new Error("STALE_EPOCH");
      if (
        ["send", "deliver", "progress", "decision", "complete"].includes(method)
      )
        engine.assertLive(c, scope.epoch);
      p = { ...p, collab_id: c.id, epoch: scope.epoch };
      if (method === "modelOptions") p.cwd = c.cwd;
      const slot = engine.adapters.get(`${c.id}:${scope.agent}`);
      if (
        slot?.running &&
        slot.task.message_type === "review" &&
        (["send", "deliver", "complete", "decision"].includes(method) ||
          (method === "planBudget" && (p.profile !== undefined || p.budget !== undefined)))
      )
        throw new Error("REVIEW_TASK_READ_ONLY");
      if (method === "planBudget") p.actor = scope.agent;
      if (method === "send") {
        if (p.retry_of || p.type) throw new Error("INVALID_SCOPED_REQUEST");
        p.from = scope.agent;
        p.hop =
          (engine.adapters.get(`${c.id}:${scope.agent}`)?.task?.hop ??
            scope.hop) + 1;
        p.delegate_depth =
          (engine.adapters.get(`${c.id}:${scope.agent}`)?.task
            ?.delegate_depth ?? 0) + 1;
        if (p.to === scope.agent) throw new Error("SELF_DELEGATION");
      }
      if (method === "review") {
        if (c.reviewer !== scope.agent) throw new Error("REVIEWER_MISMATCH");
        if (!slot?.running || slot.task.id !== c.review_task_id)
          throw new Error("STALE_REVIEW");
        p.reviewer = scope.agent;
        p.task_id = slot.task.id;
      }
      if (method === "deliver" && c.tasks[p.task_id]?.to !== scope.agent)
        throw new Error("TASK_SCOPE_MISMATCH");
      if (
        method === "progress" &&
        p.task_id &&
        c.tasks[p.task_id]?.to !== scope.agent
      )
        throw new Error("TASK_SCOPE_MISMATCH");
      if (method === "complete") {
        if (!slot?.running) throw new Error("NO_ACTIVE_WORK_TASK");
        return engine.reportCompletion({ ...p, task_id: slot.task.id });
      }
      if (
        [
          "stop",
          "create",
          "uiClosed",
          "shutdown",
          "scopeForProcess",
          "reviewArtifact",
          "retryTask",
        ].includes(method)
      )
        throw new Error("CONTROL_REQUIRES_USER_TOKEN");
    }
    switch (method) {
      case "ping":
        return {
          ok: true,
          version: "1.0.0",
          build_id: buildId,
          pid: process.pid,
        };
      case "capabilities":
        return discover();
      case "scopeForProcess": {
        const { chain, reusedParent } = await processAncestors(p.pid);
        for (const pid of chain) {
          const known = managedHosts.get(pid);
          if (!known) continue;
          const c = engine.get(known.collab_id);
          if (c.epoch !== known.epoch || ["stopped", "done"].includes(c.state))
            throw new Error("COLLABORATION_BARRIER");
          if (p.agent !== known.agent)
            throw new Error("MCP_PROCESS_AGENT_MISMATCH");
          const slot = engine.adapters.get(`${c.id}:${known.agent}`);
          const child = slot?.adapter?.rpc?.child || slot?.adapter?.child;
          if (
            !child ||
            child.pid !== pid ||
            child.exitCode !== null ||
            child.signalCode
          )
            throw new Error("MCP_MANAGED_PROCESS_CLOSED");
          const found = [...scopes]
            .reverse()
            .find(
              ([, s]) =>
                s.collab_id === c.id &&
                s.epoch === c.epoch &&
                s.agent === known.agent,
            );
          if (!found) throw new Error("MCP_SCOPE_REVOKED");
          return {
            url: address,
            token: found[0],
            collab_id: c.id,
            epoch: c.epoch,
            agent: known.agent,
            delegate_depth: slot.task?.delegate_depth ?? 0,
          };
        }
        if (managedHosts.has(reusedParent))
          throw new Error("MCP_MANAGED_PROCESS_CLOSED");
        return null;
      }
      case "snapshot":
        return engine.snapshot();
      case "modelOptions":
        return modelOptions({ ...p, cwd: p.cwd || projectRoot });
      case "collaborations":
        return scope
          ? { items: [engine.get(scope.collab_id)], offset: 0, has_more: false }
          : journal.index.collaborations(p);
      case "history": {
        const index = scope
          ? { items: [engine.get(scope.collab_id)], offset: 0, has_more: false }
          : journal.index.collaborations({
              offset: p.index_offset || 0,
              limit: 25,
            });
        const id = p.collab_id || index.items[0]?.id;
        const collaboration = id ? engine.get(id) : null;
        return {
          collaboration,
          collaborations: index,
          cursor: journal.lastSeq,
          history: id
            ? journal.history({ collab_id: id, before: p.before, limit: 100 })
            : { events: [], has_older: false },
        };
      }
      case "taskEvents": {
        const task = engine.check(p.task_id);
        if (scope && task.collab_id !== scope.collab_id)
          throw new Error("TASK_SCOPE_MISMATCH");
        return journal.index.commandHistory({
          task_id: p.task_id,
          before: p.before,
        });
      }
      case "artifact": {
        const e = journal.find(p.event_id);
        if (
          !e ||
          e.type !== "artifact.delivered" ||
          (p.collab_id && p.collab_id !== e.collab_id)
        )
          throw new Error("UNKNOWN_ARTIFACT");
        return e;
      }
      case "create":
        return engine.create(p);
      case "send":
        return engine.send(p);
      case "planBudget":
        return engine.planBudget(p);
      case "check": {
        const t = engine.check(p.task_id);
        if (scope && t.collab_id !== scope.collab_id)
          throw new Error("TASK_SCOPE_MISMATCH");
        return t;
      }
      case "wait": {
        const t = engine.check(p.task_id);
        if (scope && t.collab_id !== scope.collab_id)
          throw new Error("TASK_SCOPE_MISMATCH");
        return engine.wait(p.task_id, p.ms);
      }
      case "stop": {
        const result = await engine.stop(
          p.collab_id,
          p.reason || "user",
          p.epoch,
        );
        if (result.persistence_error)
          throw new Error(
            `STOP_APPLIED_BUT_NOT_PERSISTED: ${result.persistence_error}`,
          );
        return result;
      }
      case "deliver":
        return engine.deliver(p);
      case "complete":
        return engine.complete(p);
      case "review":
        return engine.review(p);
      case "reviewArtifact":
        return engine.reviewArtifact(p);
      case "retryTask":
        return engine.retryTask(p);
      case "decision": {
        const c = engine.get(p.collab_id);
        engine.assertLive(c, p.epoch ?? c.epoch);
        engine.record(c, "decision.recorded", {
          text: String(p.text).slice(0, 2000),
        });
        return { ok: true };
      }
      case "progress": {
        const c = engine.get(p.collab_id);
        engine.record(
          c,
          "agent.progress",
          { text: String(p.text).slice(0, 500), self_reported: true },
          { agent: scope?.agent || p.agent, task_id: p.task_id },
        );
        return { ok: true };
      }
      case "events":
        return journal.events(p.after || 0, p.collab_id, p.limit || 1000);
      case "readRef": {
        const path = p.path;
        const r = relative(join(home, "blobs"), path);
        const allowedHandoff = [...engine.collabs.values()].some(
          (c) =>
            c.handoff?.path === path && (!scope || scope.collab_id === c.id),
        );
        if ((r.startsWith("..") || isAbsolute(r)) && !allowedHandoff)
          throw new Error("Reference outside bridge content");
        return readFileSync(path, "utf8");
      }
      case "uiClosed": {
        const c = engine.get(p.collab_id);
        ui.closed(c.id);
        engine.record(c, "ui.closed", {});
        return { ok: true };
      }
      case "shutdown":
        // A pre-upgrade MCP process may cache the old automatic-restart client.
        // Never let its unqualified shutdown cancel a live collaboration.
        if (p.preserve !== true && p.cancel !== true)
          throw new Error(
            "SHUTDOWN_MODE_REQUIRED: preserve=true for idle reload; cancel=true for explicit shutdown",
          );
        engine.prepareShutdown(p.preserve === true);
        journal.append("bridge.reloading", null, {
          preserve: p.preserve === true,
          build_id: buildId,
        });
        setImmediate(
          () => void close({ preserve: p.preserve === true }).catch(audit),
        );
        return { ok: true };
      default:
        throw new Error(`UNKNOWN_METHOD: ${method}`);
    }
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const scopedToken = req.headers.authorization?.replace(/^Bearer /, "");
    const scope = scopes.get(scopedToken);
    const owner = auth(req);
    if ((!owner && !scope) || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "GET" && url.pathname === "/events" && owner) {
      let cursor = Number(url.searchParams.get("after") || 0);
      const collab = url.searchParams.get("collab_id");
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.flushHeaders();
      clients.add(res);
      let busy = false,
        ended = false;
      const pump = async () => {
        if (busy || ended) return;
        busy = true;
        try {
          while (!ended) {
            const page = journal.events(cursor, collab, 128);
            if (!page.length) break;
            const text = page.map((e) => JSON.stringify(e)).join("\n") + "\n";
            cursor = page.at(-1).seq;
            if (!res.write(text)) {
              await Promise.race([
                once(res, "drain"),
                new Promise((_, rej) =>
                  setTimeout(
                    () => rej(new Error("SLOW_SUBSCRIBER")),
                    5000,
                  ).unref(),
                ),
              ]);
            }
          }
        } catch {
          res.destroy();
        } finally {
          busy = false;
        }
      };
      const event = () => void pump();
      journal.on("event", event);
      const heart = setInterval(() => {
        if (!busy && !ended) res.write('{"type":"heartbeat"}\n');
      }, 15000);
      heart.unref();
      req.on("close", () => {
        ended = true;
        clearInterval(heart);
        clients.delete(res);
        journal.off("event", event);
      });
      void pump();
      return;
    }
    if (req.method === "POST" && url.pathname === "/rpc") {
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 65536)
            throw new Error("REQUEST_TOO_LARGE");
        }
        const input = JSON.parse(body);
        const result = await rpc(input.method, input.params || {}, scope);
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ result }));
      } catch (error) {
        audit(error);
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = `http://127.0.0.1:${server.address().port}`;
  const descriptor = {
    url: address,
    token,
    pid: process.pid,
    home,
    started_at: new Date().toISOString(),
  };
  journal.writeJson(join(home, "endpoint.json"), descriptor);
  try {
    chmodSync(join(home, "endpoint.json"), 0o600);
  } catch {}
  engine.mcpServers = (c, task) => {
    const capability = randomBytes(32).toString("hex");
    scopes.set(capability, {
      collab_id: c.id,
      epoch: task.epoch,
      agent: task.to,
      hop: task.hop,
    });
    return [
      {
        name: "agentsbridge",
        command: process.execPath,
        args: [join(projectRoot, "src/bridge/mcp.mjs")],
        env: [
          { name: "AGENTSBRIDGE_URL", value: address },
          { name: "AGENTSBRIDGE_TOKEN", value: capability },
          { name: "AGENTSBRIDGE_COLLAB_ID", value: c.id },
          { name: "AGENTSBRIDGE_EPOCH", value: String(task.epoch) },
          { name: "AGENTSBRIDGE_AGENT", value: task.to },
        ],
      },
    ];
  };
  // Codex config uses this exact same MCP contract, with scoped per-collaboration credentials.
  engine.on("event", (e) => {
    if (e.type === "process.started")
      managedHosts.set(e.data.host_pid, {
        collab_id: e.collab_id,
        epoch: e.epoch,
        agent: e.agent,
      });
    if (
      e.type === "collaboration.stopped" ||
      (e.type === "collaboration.state" && e.data.state === "done")
    )
      for (const [t, s] of scopes)
        if (s.collab_id === e.collab_id) scopes.delete(t);
  });
  async function close({ preserve = false } = {}) {
    if (closing) return;
    engine.prepareShutdown(preserve);
    closing = true;
    await engine.destroy({ preserve });
    for (const c of clients) c.end();
    await new Promise((r) => server.close(r));
    journal.close();
  }
  return { server, journal, engine, descriptor, close };
}
if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href
) {
  // OS-owned named pipe is the single-instance lock; stale endpoint files are harmless.
  mkdirSync(dataHome, { recursive: true });
  const lock = net.createServer((s) => s.end("agentsbridge\n"));
  lock.on("error", () => process.exit(0));
  lock.listen(bridgePipe, async () => {
    try {
      const daemon = await startDaemon();
      process.on(
        "SIGINT",
        () =>
          void daemon.close().then(() => {
            lock.close();
            process.exit(0);
          }),
      );
      process.on(
        "SIGTERM",
        () =>
          void daemon.close().then(() => {
            lock.close();
            process.exit(0);
          }),
      );
      daemon.server.on("close", () => {
        lock.close();
      });
    } catch (error) {
      appendFileSync(join(dataHome, "bridge.log"), error.stack + "\n");
      process.exit(1);
    }
  });
}
