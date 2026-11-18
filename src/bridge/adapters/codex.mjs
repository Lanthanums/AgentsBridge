import { Adapter, isolatedCodexArgs } from "./base.mjs";
import { Rpc } from "../process.mjs";
import { normalizeExecution } from "../execution-options.mjs";
export class CodexAdapter extends Adapter {
  constructor(spec) {
    super("codex", spec, {
      persistent: true,
      interrupt: "protocol_and_tree",
      token_delta: true,
    });
  }
  async start({ cwd, sessionId, env = {}, mcpServers = [] }) {
    this.cwd = cwd;
    this.rpc = new Rpc(
      this.spec,
      ["app-server", "--stdio", ...isolatedCodexArgs()],
      { cwd, env },
    );
    this.emitEvent("process_started", { pid: this.rpc.child.pid });
    this.rpc.on("message", (m) => {
      const p = m.params || {};
      if (p.threadId && this.sessionId && p.threadId !== this.sessionId) return;
      this.emitEvent("native", m);
      if (m.method === "item/agentMessage/delta")
        this.emitEvent("text", { text: p.delta, incremental: true });
      if (m.method === "item/started" && p.item?.type === "commandExecution")
        this.emitEvent("tool", {
          toolCallId: p.item.id,
          title: p.item.command,
          command: p.item.command,
          status: "in_progress",
        });
      if (m.method === "item/completed" && p.item?.type === "commandExecution")
        this.emitEvent("tool", {
          toolCallId: p.item.id,
          title: p.item.command,
          command: p.item.command,
          status: "completed",
          exit_code: p.item.exitCode,
          output: p.item.aggregatedOutput,
        });
      if (m.method === "item/commandExecution/outputDelta")
        this.emitEvent("tool_output", { toolCallId: p.itemId, text: p.delta });
      if (m.method === "thread/tokenUsage/updated") {
        this.usage = p.tokenUsage?.last || p.tokenUsage;
        this.emitEvent("usage", {
          ...this.usage,
          tokens: this.usage?.totalTokens,
          cost_usd: null,
          source: "Codex tokenUsage/last",
        });
      }
      if (m.id !== undefined) {
        // Explicit never-ask policy; unexpected prompts fail closed.
        void this.rpc.write({
          jsonrpc: "2.0",
          id: m.id,
          error: {
            code: -32000,
            message: "Unattended adapter disallows interactive request",
          },
        });
      }
      if (m.method === "turn/completed" && this.turnDone) {
        this.turnDone(p.turn);
      }
    });
    this.rpc.on("dead", (error) => {
      this.failTurn?.(error);
      this.emitEvent("process_exit", { error: error.message });
    });
    await this.rpc.request(
      "initialize",
      {
        clientInfo: { name: "agentsbridge", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
      30000,
    );
    await this.rpc.notify("initialized");
    const config = Object.fromEntries(
      mcpServers.map((s) => [
        `mcp_servers.${s.name}`,
        {
          command: s.command,
          args: s.args,
          env: Object.fromEntries(s.env.map((x) => [x.name, x.value])),
          enabled: true,
        },
      ]),
    );
    const s = await this.rpc.request(
      sessionId ? "thread/resume" : "thread/start",
      {
        ...(sessionId ? { threadId: sessionId } : {}),
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config,
      },
      60000,
    );
    if (sessionId && s.thread.id !== sessionId)
      throw new Error(
        `RESUME_ID_MISMATCH expected=${sessionId} returned=${s.thread.id}`,
      );
    this.sessionId = s.thread.id;
    this.currentModel = s.model;
    this.emitEvent("session", {
      session_id: this.sessionId,
      resumed: Boolean(sessionId),
      verified: true,
    });
    return this.sessionId;
  }
  async configure(execution = {}) {
    this.execution = normalizeExecution(execution);
    if (!Object.keys(this.execution).length) return;
    if (!this.models) {
      this.models = [];
      let cursor;
      do {
        const page = await this.rpc.request("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        this.models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
    }
    const model =
      this.models.find(
        (m) => m.model === (execution.model || this.currentModel),
      ) || (!execution.model ? this.models.find((m) => m.isDefault) : null);
    if (!model) throw new Error(`UNSUPPORTED_MODEL: ${execution.model}`);
    if (
      execution.reasoning_effort &&
      !model.supportedReasoningEfforts.some(
        (e) => e.reasoningEffort === execution.reasoning_effort,
      )
    )
      throw new Error(
        `UNSUPPORTED_REASONING_EFFORT: ${execution.reasoning_effort}`,
      );
  }
  async send(task) {
    if (this.busy) throw new Error("CLI_SESSION_BUSY");
    this.busy = true;
    this.usage = null;
    let text = "";
    const listener = (e) => {
      if (e.type === "text") text += e.data.text;
    };
    this.on("event", listener);
    try {
      const done = new Promise((resolve, reject) => {
        this.turnDone = (turn) => {
          turn.status === "completed"
            ? resolve(turn)
            : reject(
                new Error(
                  `Codex ${turn.status}: ${JSON.stringify(turn.error)}`,
                ),
              );
        };
        this.failTurn = reject;
      });
      done.catch(() => {});
      const started = await this.rpc.request(
        "turn/start",
        {
          threadId: this.sessionId,
          input: [{ type: "text", text: task }],
          approvalPolicy: "never",
          ...(this.execution?.model ? { model: this.execution.model } : {}),
          ...(this.execution?.reasoning_effort
            ? { effort: this.execution.reasoning_effort }
            : {}),
        },
        60000,
      );
      this.turnId = started.turn.id;
      if (this.execution && Object.keys(this.execution).length)
        this.emitEvent("execution", {
          requested: this.execution,
          applied: this.execution,
          verification: "Codex turn/start parameters",
        });
      const turn = await done;
      text =
        turn.items
          ?.filter((i) => i.type === "agentMessage")
          .map((i) => i.text)
          .join("\n") || text;
      return {
        text,
        session_id: this.sessionId,
        usage: {
          ...this.usage,
          tokens: this.usage?.totalTokens ?? null,
          cost_usd: null,
        },
      };
    } finally {
      this.busy = false;
      this.turnDone = null;
      this.failTurn = null;
      this.off("event", listener);
    }
  }
  async interrupt() {
    if (this.turnId && !this.rpc?.dead)
      void this.rpc
        .request(
          "turn/interrupt",
          { threadId: this.sessionId, turnId: this.turnId },
          1000,
        )
        .catch(() => {});
    await this.destroy();
  }
}
