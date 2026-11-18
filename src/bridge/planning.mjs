import { readFileSync } from "node:fs";
import { discover } from "./discover.mjs";
import { verifiedCapabilities } from "./probed.mjs";

export const budgetProfiles = Object.freeze({
  small: Object.freeze({
    max_rounds: 24,
    max_hops: 48,
    max_tokens: 600000,
    max_cost_usd: 15,
  }),
  standard: Object.freeze({
    max_rounds: 48,
    max_hops: 96,
    max_tokens: 1500000,
    max_cost_usd: 30,
  }),
  complex: Object.freeze({
    max_rounds: 96,
    max_hops: 128,
    max_tokens: 4500000,
    max_cost_usd: 65,
  }),
});
export const budgetCeiling = Object.freeze({
  max_rounds: 256,
  max_hops: 256,
  max_tokens: 12000000,
  max_cost_usd: 150,
});

export function resolveBudget(profile, patch, current) {
  if (
    profile !== undefined &&
    (typeof profile !== "string" || !Object.hasOwn(budgetProfiles, profile))
  )
    throw new Error("INVALID_BUDGET_PROFILE");
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("INVALID_BUDGET");
  const preset = profile === undefined ? {} : budgetProfiles[profile];
  const next = current ? { ...current } : { ...budgetProfiles.standard };
  for (const [key, value] of Object.entries(preset))
    next[key] = current ? Math.max(current[key], value) : value;
  for (const [key, value] of Object.entries(patch)) {
    if (
      !Object.hasOwn(budgetCeiling, key) ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > budgetCeiling[key] ||
      (key !== "max_cost_usd" && !Number.isSafeInteger(value))
    )
      throw new Error(`INVALID_BUDGET_LIMIT: ${key}`);
    if (current && value < current[key])
      throw new Error(`BUDGET_CANNOT_DECREASE: ${key}`);
    next[key] = value;
  }
  return next;
}

export const agentProfiles = Object.freeze(JSON.parse(
  readFileSync(new URL("./model-profiles.json", import.meta.url), "utf8"),
).agents);
export const workKinds = [
  "routine",
  "backend",
  "frontend",
  "exploration",
  "3d",
  "bulk_low_risk",
  "general",
];
export const complexities = ["low", "medium", "high"];

export function normalizeRouting(routing) {
  if (
    !routing ||
    typeof routing !== "object" ||
    Array.isArray(routing) ||
    Object.keys(routing).some(
      (key) => !["kind", "complexity", "acceptance"].includes(key),
    ) ||
    !workKinds.includes(routing.kind) ||
    !complexities.includes(routing.complexity) ||
    (routing.acceptance !== undefined &&
      (typeof routing.acceptance !== "string" ||
        !routing.acceptance.trim() ||
        Buffer.byteLength(routing.acceptance) > 2048))
  )
    throw new Error("INVALID_TASK_ROUTING");
  return {
    kind: routing.kind,
    complexity: routing.complexity,
    ...(routing.acceptance === undefined
      ? {}
      : { acceptance: routing.acceptance.trim() }),
  };
}

export function availableWorkers() {
  return Object.entries(discover())
    .filter(
      ([agent, spec]) =>
        spec.available && verifiedCapabilities(agent, spec),
    )
    .map(([agent]) => agent);
}

export function routeTask(routing, eligible) {
  let order = ["codex", "dsh"];
  if (routing.kind === "bulk_low_risk" && routing.complexity === "low")
    order = ["cursor", "dsh", "codex"];
  else if (routing.kind === "3d" && routing.acceptance)
    order = ["kimi", "codex"];
  else if (routing.kind === "routine" && routing.complexity !== "high")
    order = ["dsh", "codex"];
  else if (routing.kind === "3d" || routing.complexity === "high")
    order = ["codex"];
  const selected = order.find((agent) => eligible.includes(agent));
  if (!selected)
    throw new Error(
      "NO_SUITABLE_AGENT: inspect availability or explicitly select a worker",
    );
  return { ...routing, selected, preferred: order[0] };
}
