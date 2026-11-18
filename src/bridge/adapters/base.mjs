import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Rpc, launch, killTree } from "../process.mjs";
import {
  configureAcp,
  normalizeExecution,
  acpOptions,
} from "../execution-options.mjs";
export function isolatedCodexArgs() {
  const file = join(homedir(), ".codex/config.toml");
  const names = existsSync(file)
    ? [
        ...readFileSync(file, "utf8").matchAll(
          /^\[mcp_servers\.([^\.\]]+)\]/gm,
        ),
      ].map((m) => m[1])
    : [];
  return names.flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]);
}
export class Adapter extends EventEmitter {
  constructor(kind, spec, capabilities = {}) {
    super();
    this.kind = kind;
    this.spec = spec;
    this.capabilities = capabilities;
    this.sessionId = null;
    this.busy = false;
  }
  emitEvent(type, data = {}) {
    this.emit("event", { type, data });
  }
  async interrupt() {
    await this.destroy();
  }
  async destroy() {
    if (this.rpc) await this.rpc.destroy();
    if (this.child) await killTree(this.child);
  }
}
export class AcpAdapter extends Adapter {
  async start({ cwd, sessionId, env = {}, mcpServers = [] } = {}) {
    this.cwd = cwd;
    this.expected = sessionId;
    this.lastIdentity = null;
    this.rpc = new Rpc(
      this.spec,
      this.kind === "dsh"
        ? ["--profile", "acp"]
        : this.kind === "cursor"
          ? ["acp", "--force", "--trust"]
          : ["--auto", "acp"],
      { cwd, env },
    );
    this.emitEvent("process_started", { pid: this.rpc.child.pid });
    this.rpc.on("message", (m) => {
      if (m.method === "session/update") {
        const id = m.params.sessionId;
        this.lastIdentity = id;
        if (this.expected && id !== this.expected) {
          this.identityError = new Error(
            `RESUME_ID_MISMATCH expected=${this.expected} returned=${id}`,
          );
          void this.destroy();
          return;
        }
        this.emitEvent("native", m);
        const u = m.params.update;
        if (
          u.sessionUpdate === "config_option_update" &&
          Array.isArray(u.configOptions)
        )
          this.configOptions = u.configOptions;
        if (this.identityVerification) return;
        if (u.sessionUpdate === "agent_message_chunk")
          this.emitEvent("text", {
            text: u.content?.text || "",
            incremental: this.kind !== "dsh",
          });
        else if (u.sessionUpdate === "agent_thought_chunk")
          this.emitEvent("activity", {
            inferred: false,
            reason: "native_thought",
          });
        else if (["tool_call", "tool_call_update"].includes(u.sessionUpdate))
          this.emitEvent("tool", {
            ...u,
            command: u.rawInput?.command || u.rawInput?.cmd || u.title,
            output: u.rawOutput || u.content,
          });
        else if (u.sessionUpdate === "usage_update")
          this.emitEvent("usage", {
            context_used: u.used,
            context_size: u.size,
            tokens: null,
            cost_usd: null,
            source: "ACP context occupancy; billing unavailable",
          });
      }
      if (m.id !== undefined && m.method === "session/request_permission") {
        // Explicit unattended policy at the adapter boundary. Never wait for a terminal prompt.
        const option = this.identityVerification
          ? null
          : m.params.options?.find((o) => o.kind === "allow_once") ||
            m.params.options?.find((o) => o.kind === "allow_always");
        this.emitEvent("approval", {
          policy: "allow_once",
          tool: m.params.toolCall,
          granted: Boolean(option),
        });
        void this.rpc.reply(m.id, {
          outcome: option
            ? { outcome: "selected", optionId: option.optionId }
            : { outcome: "cancelled" },
        });
      } else if (m.id !== undefined && m.method !== "session/update")
        void this.rpc.write({
          jsonrpc: "2.0",
          id: m.id,
          error: {
            code: -32601,
            message: "Client operation unsupported; use native CLI tools",
          },
        });
    });
    this.rpc.on("dead", (error) => {
      this.emitEvent("process_exit", { error: error.message });
    });
    const init = await this.rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "agentsbridge", version: "1.0.0" },
        clientCapabilities: {},
      },
      30000,
    );
    this.nativeCapabilities = init.agentCapabilities;
    let s;
    if (sessionId) {
      if (!init.agentCapabilities?.sessionCapabilities?.resume)
        throw new Error("RESUME_NOT_PROBED");
      let cursor,
        found = false;
      do {
        const page = await this.rpc.request("session/list", {
          cwd,
          ...(cursor ? { cursor } : {}),
        });
        found = page.sessions?.some((x) => x.sessionId === sessionId);
        cursor = page.nextCursor;
        if (found) break;
      } while (cursor);
      if (!found) throw new Error(`RESUME_NOT_FOUND: ${sessionId}`);
      s = await this.rpc.request(
        "session/resume",
        { sessionId, cwd, mcpServers },
        30000,
      );
      if (s.sessionId && s.sessionId !== sessionId)
        throw new Error(`RESUME_ID_MISMATCH: ${s.sessionId}`);
      // These ACP implementations omit id in resume responses: a config round trip
      // produces a session-tagged update, without paying for a model turn.
      const option = s.configOptions?.find((o) =>
        ["reasoning_effort", "thinking", "mode"].includes(o.id),
      );
      if (option)
        await this.rpc.request(
          "session/set_config_option",
          { sessionId, configId: option.id, value: option.currentValue },
          10000,
        );
      if (this.kind === "dsh" && this.lastIdentity !== sessionId) {
        // DSH omits id and emits no config acknowledgement. Validate an actual
        // session-tagged response to a bounded, tool-free identity turn.
        this.identityVerification = true;
        try {
          await this.rpc.request(
            "session/prompt",
            {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: "Transport identity verification only. Reply exactly SESSION_ID_CHECK. Do not use tools, delegate, or perform any other work.",
                },
              ],
            },
            60000,
          );
        } finally {
          this.identityVerification = false;
        }
      }
      const until = Date.now() + 3000;
      while (this.lastIdentity !== sessionId && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      if (this.identityError) throw this.identityError;
      if (this.lastIdentity !== sessionId)
        throw new Error(
          "RESUME_ID_UNVERIFIABLE: no session-tagged acknowledgement",
        );
      this.sessionId = sessionId;
    } else {
      s = await this.rpc.request("session/new", { cwd, mcpServers }, 30000);
      this.sessionId = s.sessionId;
      this.expected = this.sessionId;
    }
    if (
      this.kind === "kimi" &&
      s.modes?.availableModes?.some((m) => m.id === "yolo")
    )
      await this.rpc.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId: "yolo",
      });
    this.emitEvent("session", {
      session_id: this.sessionId,
      resumed: Boolean(sessionId),
      verified: true,
    });
    this.configOptions = s.configOptions || [];
    return this.sessionId;
  }
  async configure(execution = {}) {
    execution = normalizeExecution(execution);
    this.configOptions = await configureAcp(
      this.rpc,
      this.sessionId,
      this.configOptions,
      execution,
    );
    this.emitEvent("execution", {
      requested: execution,
      applied: {
        model: acpOptions(this.configOptions).model?.currentValue,
        reasoning_effort: acpOptions(this.configOptions).effort?.currentValue,
      },
      verification: "ACP configOptions",
    });
  }
  async send(task) {
    if (this.busy) throw new Error("CLI_SESSION_BUSY");
    this.busy = true;
    let text = "";
    const collect = (e) => {
      if (e.type === "text") text += e.data.text;
    };
    this.on("event", collect);
    try {
      const result = await this.rpc.request(
        "session/prompt",
        { sessionId: this.sessionId, prompt: [{ type: "text", text: task }] },
        24 * 60 * 60 * 1000,
      );
      if (this.identityError) throw this.identityError;
      if (result.stopReason !== "end_turn")
        throw new Error(`CLI turn: ${result.stopReason}`);
      return {
        text,
        session_id: this.sessionId,
        usage: { tokens: null, cost_usd: null },
        native: result,
      };
    } finally {
      this.busy = false;
      this.off("event", collect);
    }
  }
  async interrupt() {
    if (!this.rpc?.dead && this.sessionId)
      await this.rpc
        .notify("session/cancel", { sessionId: this.sessionId })
        .catch(() => {});
    await this.destroy();
  }
}
export class JsonlAdapter extends Adapter {
  async start({ cwd, sessionId, env = {} }) {
    this.cwd = cwd;
    this.sessionId = sessionId || null;
    this.env = env;
    return this.sessionId;
  }
  args(task) {
    throw new Error("Adapter must declare verified flags");
  }
  parse(e) {
    return [];
  }
  async send(task) {
    if (this.busy) throw new Error("CLI_SESSION_BUSY");
    this.busy = true;
    let text = "",
      usage = {},
      identity = false,
      protocolError,
      stderr = "";
    try {
      return await new Promise((resolve, reject) => {
        const abort = (error) => {
          protocolError = error;
          void this.destroy().catch((cleanup) => {
            protocolError = new Error(
              `${error.message}; cleanup: ${cleanup.message}`,
            );
            reject(protocolError);
          });
        };
        this.child = launch(this.spec, this.args(task), {
          cwd: this.cwd,
          env: this.env,
          onLine: (l) => {
            let e;
            try {
              e = JSON.parse(l);
            } catch {
              return;
            }
            this.emitEvent("native", e);
            let parsed;
            try {
              parsed = this.parse(e);
            } catch (error) {
              abort(error);
              return;
            }
            for (const out of parsed) {
              if (out.type === "session") {
                const returned = out.data.session_id;
                const resumed = Boolean(this.sessionId);
                if (this.sessionId && returned !== this.sessionId) {
                  abort(
                    new Error(
                      `RESUME_ID_MISMATCH expected=${this.sessionId} returned=${returned}`,
                    ),
                  );
                  return;
                }
                this.sessionId = returned;
                identity = true;
                out.data = { ...out.data, resumed, verified: true };
              }
              if (out.type === "text")
                text = out.data.incremental
                  ? text + out.data.text
                  : out.data.text;
              if (out.type === "usage") usage = out.data;
              this.emitEvent(out.type, out.data);
            }
          },
          onErrorLine: (l) => {
            stderr = (stderr + "\n" + l).slice(-16000);
            this.emitEvent("diagnostic", { text: l });
          },
        });
        this.emitEvent("process_started", { pid: this.child.pid });
        this.child.stdin.on("error", (error) => {
          protocolError = error;
        });
        this.child.stdin.end();
        this.child.on("error", reject);
        this.child.on("protocolError", abort);
        this.child.on("close", (code) => {
          if (protocolError) return reject(protocolError);
          if (code !== 0)
            return reject(
              new Error(`CLI_EXIT_${code}: ${stderr.slice(-1500)}`),
            );
          if (!identity) return reject(new Error("SESSION_ID_UNVERIFIABLE"));
          resolve({ text, usage, session_id: this.sessionId });
        });
      });
    } finally {
      this.busy = false;
    }
  }
}
