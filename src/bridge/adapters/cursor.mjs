import { JsonlAdapter } from "./base.mjs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  modelOptions,
  normalizeExecution,
  resolveCursorExecution,
} from "../execution-options.mjs";
export function bulkGrokExecution(models) {
  const families = models
    .filter((model) => /^(?:cursor-)?grok-\d+(?:\.\d+)*$/i.test(model.id))
    .sort((left, right) =>
      right.id
        .replace(/^cursor-/, "")
        .localeCompare(left.id.replace(/^cursor-/, ""), "en", {
          numeric: true,
        }),
    );
  for (const effort of ["none", "minimal", "low"]) {
    const match = families.find((model) => model.variants[effort]);
    if (match) return { model: match.id, reasoning_effort: effort };
  }
  throw new Error(
    "CURSOR_LOW_EFFORT_GROK_UNAVAILABLE: choose an explicit model or use another worker",
  );
}
export class CursorAdapter extends JsonlAdapter {
  constructor(spec, { model } = {}) {
    super("cursor", spec, {
      persistent: false,
      interrupt: "tree",
      token_delta: true,
      probed: false,
    });
    this.model = model;
  }
  async configure(execution = {}, { routing } = {}) {
    execution = normalizeExecution(execution);
    const bulkDefault =
      routing?.selected === "cursor" && !Object.keys(execution).length;
    if (!bulkDefault && !Object.keys(execution).length) {
      this.model = undefined;
      return;
    }
    if (!bulkDefault && !execution.model)
      throw new Error("MODEL_REQUIRED_FOR_CURSOR_EFFORT");
    const catalog = await modelOptions({
      to: "cursor",
      cwd: this.cwd,
      specs: { cursor: this.spec },
    });
    if (bulkDefault) execution = bulkGrokExecution(catalog.models);
    this.model = resolveCursorExecution(catalog.models, execution);
    this.emitEvent("execution", {
      requested: execution,
      applied: {
        model: this.model,
        reasoning_effort: execution.reasoning_effort,
      },
      verification: "CLI --model argument",
    });
  }
  async start(options) {
    if (options.sessionId) {
      const root = join(
        process.env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor"),
        "chats",
      );
      if (
        !existsSync(root) ||
        !readdirSync(root).some((dir) =>
          existsSync(join(root, dir, options.sessionId, "store.db")),
        )
      )
        throw new Error(`RESUME_NOT_FOUND: ${options.sessionId}`);
    }
    return super.start(options);
  }
  args(task) {
    if (!this.capabilities.probed)
      throw new Error("CURSOR_CAPABILITIES_UNVERIFIED");
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      "--trust",
      "--approve-mcps",
      "--sandbox",
      "disabled",
      ...(this.model ? ["--model", this.model] : []),
      ...(this.sessionId ? [`--resume=${this.sessionId}`] : []),
      task,
    ];
  }
  parse(e) {
    const out = [];
    if (e.type === "system" && e.session_id)
      out.push({ type: "session", data: { session_id: e.session_id } });
    if (e.type === "assistant")
      out.push({
        type: "text",
        data: {
          text:
            e.message?.content
              ?.filter?.((c) => c.type === "text")
              .map((c) => c.text)
              .join("") ||
            e.text ||
            "",
          incremental: e.timestamp_ms != null,
        },
      });
    if (e.type === "tool_call") {
      const shell = e.tool_call?.shellToolCall,
        result = shell?.result?.success || shell?.result?.error;
      out.push({
        type: "tool",
        data: {
          ...e,
          toolCallId: e.call_id || e.tool_call_id,
          status: e.subtype === "completed" ? "completed" : "in_progress",
          command: shell?.args?.command,
          exit_code: result?.exitCode ?? null,
          output: result?.interleavedOutput ?? result?.stdout ?? shell?.result,
        },
      });
    }
    if (e.type === "result") {
      if (e.is_error) throw new Error(`CURSOR_RESULT_ERROR: ${e.result}`);
      const u = e.usage || {};
      const tokens =
        u.totalTokens ??
        (u.inputTokens != null && u.outputTokens != null
          ? u.inputTokens +
            u.outputTokens +
            (u.cacheReadTokens || 0) +
            (u.cacheWriteTokens || 0)
          : null);
      out.push(
        { type: "text", data: { text: e.result || "", incremental: false } },
        {
          type: "usage",
          data: {
            ...u,
            tokens,
            tokens_basis:
              u.totalTokens != null
                ? "native total"
                : "reported input + output + cache-read + cache-write",
            cost_usd: e.total_cost_usd ?? null,
            duration_ms: e.duration_ms,
            source: "Cursor result",
          },
        },
      );
    }
    return out;
  }
}
