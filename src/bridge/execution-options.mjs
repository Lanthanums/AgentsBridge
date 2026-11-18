import { discover } from "./discover.mjs";
import { Rpc, launch, killTree } from "./process.mjs";
const cache = new Map();
export class CatalogGate {
  constructor(limit = 2, queueLimit = 8, timeout = 30000) {
    Object.assign(this, { limit, queueLimit, timeout });
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.limit) this.active++;
    else {
      if (this.queue.length >= this.queueLimit)
        throw new Error("MODEL_CATALOG_BUSY");
      await new Promise((resolve, reject) => {
        const entry = { resolve, timer: null };
        entry.timer = setTimeout(() => {
          this.queue = this.queue.filter((x) => x !== entry);
          reject(new Error("MODEL_CATALOG_QUEUE_TIMEOUT"));
        }, this.timeout);
        this.queue.push(entry);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else this.active--;
    };
  }
}
const catalogGate = new CatalogGate();
async function cursorCatalog(spec, cwd) {
  let child, timer;
  try {
    return await new Promise((resolve, reject) => {
      const lines = [];
      let bytes = 0,
        diagnostic = "";
      child = launch(spec, ["--list-models"], {
        cwd,
        onLine: (line) => {
          bytes += Buffer.byteLength(line);
          if (bytes > 1048576) reject(new Error("MODEL_CATALOG_TOO_LARGE"));
          else lines.push(line);
        },
        onErrorLine: (line) => {
          diagnostic = (diagnostic + line).slice(-1000);
        },
      });
      child.on("error", reject);
      child.on("protocolError", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(lines.join("\n"))
          : reject(new Error(`MODEL_CATALOG_EXIT_${code}: ${diagnostic}`)),
      );
      timer = setTimeout(
        () => reject(new Error("MODEL_CATALOG_TIMEOUT")),
        20000,
      );
    });
  } finally {
    clearTimeout(timer);
    await killTree(child);
  }
}
export const workerKinds = ["codex", "dsh", "kimi", "cursor"];
export function normalizeExecution(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_EXECUTION_OPTIONS");
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (
      !["model", "reasoning_effort"].includes(key) ||
      typeof v !== "string" ||
      !v.trim() ||
      v.length > 512 ||
      /[\r\n\0]/.test(v)
    )
      throw new Error(`INVALID_EXECUTION_OPTION: ${key}`);
    result[key] = v;
  }
  return result;
}
export function flattenOptions(options = []) {
  return options.flatMap((o) => (o.options ? flattenOptions(o.options) : [o]));
}
export function acpOptions(configOptions = []) {
  return {
    model: configOptions.find(
      (o) => o.id === "model" || o.category === "model",
    ),
    effort: configOptions.find(
      (o) =>
        ["reasoning_effort", "thinking"].includes(o.id) ||
        o.category === "thought_level",
    ),
  };
}
export async function configureAcp(rpc, sessionId, initial, execution) {
  let configOptions = initial || [];
  for (const key of ["model", "reasoning_effort"]) {
    const value = execution[key];
    if (!value) continue;
    const option =
      acpOptions(configOptions)[key === "model" ? "model" : "effort"];
    if (
      !option ||
      !flattenOptions(option.options).some((o) => o.value === value)
    )
      throw new Error(`UNSUPPORTED_EXECUTION_OPTION: ${key}=${value}`);
    const result = await rpc.request(
      "session/set_config_option",
      { sessionId, configId: option.id, value },
      15000,
    );
    if (!Array.isArray(result.configOptions))
      throw new Error(`EXECUTION_UNCONFIRMED: ${key}`);
    configOptions = result.configOptions;
    if (
      acpOptions(configOptions)[key === "model" ? "model" : "effort"]
        ?.currentValue !== value
    )
      throw new Error(`EXECUTION_MISMATCH: ${key}`);
  }
  return configOptions;
}
export function parseCursorModels(text) {
  const models = [];
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9][\w.\-]*)\s+-\s+(.+)$/);
    if (!match) continue;
    const [, id, label] = match,
      variant = id.match(
        /-(none|minimal|low|medium|high|xhigh|extra-high|max|ultra)(-fast)?$/,
      );
    const family = variant
      ? id.slice(0, variant.index) + (variant[2] || "")
      : id;
    let model = models.find((m) => m.id === family);
    if (!model) {
      model = { id: family, label: family, variants: {}, efforts: [] };
      models.push(model);
    }
    if (variant) {
      const effort = variant[1] === "extra-high" ? "xhigh" : variant[1];
      model.variants[effort] = id;
      model.efforts.push(effort);
    } else {
      model.native_id = id;
      model.label = label;
    }
  }
  return models;
}
export async function modelOptions({
  to,
  cwd,
  model,
  refresh = false,
  specs = discover(),
} = {}) {
  if (!workerKinds.includes(to)) throw new Error("UNKNOWN_AGENT");
  const spec = specs[to];
  if (!spec?.available) throw new Error(`CLI_NOT_INSTALLED: ${to}`);
  const key = JSON.stringify([to, spec.command, spec.args, cwd, model]);
  if (!refresh && cache.get(key)?.expires > Date.now())
    return cache.get(key).value;
  const release = await catalogGate.acquire();
  let value, rpc;
  try {
    if (to === "cursor") {
      const stdout = await cursorCatalog(spec, cwd);
      value = {
        agent: to,
        models: parseCursorModels(stdout),
        source: "CLI --list-models",
      };
    } else {
      rpc = new Rpc(
        spec,
        to === "codex"
          ? ["app-server", "--stdio"]
          : to === "dsh"
            ? ["--profile", "acp"]
            : ["--auto", "acp"],
        { cwd },
      );
      await rpc.request(
        "initialize",
        to === "codex"
          ? {
              clientInfo: { name: "agentsbridge-options", version: "1.0.0" },
              capabilities: { experimentalApi: true },
            }
          : {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: "agentsbridge-options", version: "1.0.0" },
            },
        20000,
      );
      if (to === "codex") {
        await rpc.notify("initialized");
        let data = [],
          cursor;
        do {
          const page = await rpc.request("model/list", {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          });
          data.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        value = {
          agent: to,
          models: data.map((m) => ({
            id: m.model,
            label: m.displayName,
            efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
            default_effort: m.defaultReasoningEffort,
            is_default: m.isDefault,
          })),
          source: "Codex model/list",
        };
      } else {
        const session = await rpc.request(
          "session/new",
          { cwd, mcpServers: [] },
          20000,
        );
        const config = model
          ? await configureAcp(rpc, session.sessionId, session.configOptions, {
              model,
            })
          : session.configOptions;
        const options = acpOptions(config);
        value = {
          agent: to,
          models: flattenOptions(options.model?.options).map((m) => ({
            id: m.value,
            label: m.name,
          })),
          current_model: options.model?.currentValue,
          efforts: flattenOptions(options.effort?.options).map((e) => ({
            id: e.value,
            label: e.name,
          })),
          current_effort: options.effort?.currentValue,
          source: "ACP configOptions",
        };
      }
    }
    for (const [entry, item] of cache)
      if (item.expires <= Date.now()) cache.delete(entry);
    while (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + 300000 });
    return value;
  } finally {
    try {
      await rpc?.destroy();
    } finally {
      release();
    }
  }
}
export function resolveCursorExecution(models, execution) {
  const model = models.find(
    (m) =>
      m.id === execution.model ||
      m.native_id === execution.model ||
      Object.values(m.variants).includes(execution.model),
  );
  if (!model) throw new Error(`UNSUPPORTED_MODEL: ${execution.model}`);
  if (execution.reasoning_effort) {
    const id = model.variants[execution.reasoning_effort];
    if (!id)
      throw new Error(
        `UNSUPPORTED_REASONING_EFFORT: ${execution.reasoning_effort}`,
      );
    return id;
  }
  if (Object.values(model.variants).includes(execution.model))
    return execution.model;
  if (model.native_id) return model.native_id;
  throw new Error(
    "REASONING_EFFORT_REQUIRED: choose an available effort for this model",
  );
}
