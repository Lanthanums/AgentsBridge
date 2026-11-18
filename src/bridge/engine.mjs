import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createAdapter } from "./adapters/index.mjs";
import { terminal } from "./journal.mjs";
import { normalizeExecution, workerKinds } from "./execution-options.mjs";
import {
  agentProfiles,
  availableWorkers,
  budgetCeiling,
  budgetProfiles,
  normalizeRouting,
  resolveBudget,
  routeTask,
} from "./planning.mjs";
import {
  completionStatus,
  latestArtifacts,
  taskInFlight,
} from "./completion.mjs";
const now = () => Date.now();
const stateEvents = [
  "collaboration.started",
  "collaboration.state",
  "collaboration.stopped",
  "participant.joined",
  "participant.left",
  "agent.state",
  "agent.unavailable",
  "session.bound",
  "task.queued",
  "task.running",
  "task.retrying",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "artifact.delivered",
  "artifact.reviewed",
  "agent.completion_reported",
  "usage.recorded",
  "review.requested",
  "review.dispatched",
  "review.decision_pending",
  "review.recorded",
  "review.invalidated",
  "handoff.generated",
  "handoff.failed",
  "processes.terminated",
  "decision.recorded",
  "budget.exhausted",
  "budget.updated",
  "execution.selected",
  "execution.configured",
  "collaboration.coordinator",
];
const validParticipant = (agent) =>
  /^(codex|dsh|kimi|cursor|reviewer)$/.test(agent);
const quantile = (xs, p) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[
        Math.min(xs.length - 1, Math.floor(xs.length * p))
      ]
    : null;
export class Engine extends EventEmitter {
  constructor(
    journal,
    {
      factory = createAdapter,
      workers = availableWorkers,
      maxConcurrent = 4,
      queueLimit = 64,
      queueTimeoutMs = 120000,
      quietMs = 10000,
      hardMs = { codex: 900000, dsh: 600000, kimi: 900000, cursor: 600000 },
      ui = async () => {},
    } = {},
  ) {
    super();
    this.log = journal;
    this.factory = factory;
    Object.assign(this, {
      maxConcurrent,
      queueLimit,
      queueTimeoutMs,
      quietMs,
      hardMs,
      ui,
      workers,
    });
    this.projects = new Map();
    this.collabs = new Map();
    this.tasks = new Map();
    this.adapters = new Map();
    this.queue = [];
    this.running = 0;
    this.locks = new Map();
    this.metrics = {};
    this.closed = false;
    this.stopCleanups = new Map();
    for (const e of journal.scan({
      types: ["project.registered", "metric.samples"],
    }))
      this.reduce(e);
    for (const id of new Set([
      ...journal.index.pendingCollaborations(),
      ...journal.index.interruptedReviews(),
    ]))
      this.get(id);
    // A daemon restart cannot safely resurrect an interrupted external effect.
    for (const c of this.collabs.values())
      if (terminal(c.state)) {
        for (const task of Object.values(c.tasks).filter(taskInFlight))
          this.record(
            c,
            "task.cancelled",
            { reason: "terminal_recovery" },
            { task_id: task.id, agent: task.to },
          );
      } else {
        const pending = Object.values(c.tasks || {}).filter(taskInFlight);
        for (const task of pending)
          this.record(
            c,
            "task.failed",
            {
              error:
                "BRIDGE_RESTARTED; inspect prior tool effects before retry",
            },
            { task_id: task.id, agent: task.to },
          );
        if (c.state === "awaiting_review" && c.reviewer !== "user")
          this.invalidateReview(
            c,
            "REVIEW_INTERRUPTED_BY_RESTART",
            "needs_work",
          );
        else if (pending.length)
          this.record(c, "collaboration.state", {
            state: "needs_work",
            reason: "bridge_restart",
          });
      }
    this.timer = setInterval(() => this.monitor(), 1000);
    this.timer.unref();
  }
  reduce(e) {
    const d = e.data;
    if (e.type === "project.registered") {
      this.projects.set(e.project_id, d);
      return;
    }
    let c = this.collabs.get(e.collab_id);
    if (e.type === "collaboration.started") {
      c = {
        ...d,
        id: e.collab_id,
        project_id: e.project_id,
        epoch: e.epoch,
        state: "active",
        participants: {},
        tasks: {},
        artifacts: [],
        usage: { tokens: 0, cost_usd: 0, unknown: false },
        decisions: [],
        completed: [],
        created_at: e.time,
      };
      this.collabs.set(c.id, c);
    }
    if (!c) return;
    c.updated_at = e.time;
    if (e.type === "collaboration.state") c.state = d.state;
    if (e.type === "collaboration.coordinator") c.coordinator = d.agent;
    if (e.type === "execution.selected") (c.execution ??= {})[e.agent] = d;
    if (e.type === "execution.configured" && c.participants[e.agent])
      c.participants[e.agent].execution = d;
    if (e.type === "budget.exhausted") c.budget_exhausted = d;
    if (e.type === "budget.updated") {
      c.budget = d.budget;
      if (d.exhausted) c.budget_exhausted = d.exhausted;
      else delete c.budget_exhausted;
    }
    if (e.type === "collaboration.stopped") {
      c.state = "stopped";
      c.epoch = e.epoch;
      c.stop_reason = d.reason;
    }
    if (e.type === "participant.joined")
      c.participants[d.agent] = {
        agent: d.agent,
        state: "waiting",
        joined_at: e.time,
      };
    if (e.type === "participant.left" && c.participants[d.agent])
      c.participants[d.agent].state = "left";
    if (e.type === "agent.state" && c.participants[e.agent])
      Object.assign(c.participants[e.agent], d, { updated_at: e.time });
    if (e.type === "agent.unavailable" && c.participants[e.agent])
      c.participants[e.agent].unavailable = d.error;
    if (e.type === "task.completed" && c.participants[e.agent])
      delete c.participants[e.agent].unavailable;
    if (e.type === "session.bound" && c.participants[e.agent])
      c.participants[e.agent].session_id = d.session_id;
    if (e.type === "task.queued") {
      if (!c.coordinator && d.message_type === "request")
        c.coordinator = d.from === "user" ? d.to : d.from;
      const t = {
        ...d,
        id: e.task_id,
        epoch: e.epoch,
        state: "queued",
        created_at: e.time,
      };
      c.tasks[t.id] = t;
      this.tasks.set(t.id, t);
    }
    if (
      e.type.startsWith("task.") &&
      e.type !== "task.queued" &&
      c.tasks[e.task_id]
    )
      Object.assign(c.tasks[e.task_id], d, {
        state: e.type.slice(5),
        updated_at: e.time,
      });
    if (e.type === "artifact.delivered")
      c.artifacts.push({
        ...d,
        event_id: e.id,
        source_task: e.task_id,
        source_agent: e.agent,
        time: e.time,
      });
    if (e.type === "artifact.reviewed")
      (c.artifact_reviews ??= {})[d.artifact_id] = d;
    if (e.type === "agent.completion_reported" && c.tasks[e.task_id])
      c.tasks[e.task_id].completion_report = d;
    if (e.type === "usage.recorded") {
      if (d.tokens == null) c.usage.unknown = true;
      else c.usage.tokens += d.tokens;
      if (d.cost_usd != null) c.usage.cost_usd += d.cost_usd;
    }
    if (e.type === "review.requested") {
      c.review = d;
      c.review_id = e.id;
      c.state = "awaiting_review";
    }
    if (e.type === "review.dispatched") c.review_task_id = d.task_id;
    if (e.type === "review.decision_pending") c.pending_decision = d;
    if (["review.recorded", "review.invalidated"].includes(e.type)) {
      delete c.review_task_id;
      delete c.pending_decision;
      delete c.review_id;
      if (e.type === "review.invalidated") c.state = d.state;
    }
    if (e.type === "handoff.generated") {
      c.handoff = d;
      delete c.handoff_error;
    }
    if (e.type === "handoff.failed") c.handoff_error = d.error;
    if (e.type === "processes.terminated") c.processes = d;
    if (e.type === "decision.recorded") c.decisions.push(d.text);
    if (e.type === "metric.samples") {
      const m = (this.metrics[e.agent] ??= { first: [], gaps: [] });
      if (d.first_event_ms != null) m.first.push(d.first_event_ms);
      m.first = m.first.slice(-1000);
      m.gaps.push(...d.gaps_ms);
      m.gaps = m.gaps.slice(-10000);
    }
  }
  record(c, type, data, opts = {}) {
    const e = this.log.append(type, c, data, opts);
    this.reduce(e);
    this.emit("event", e);
    return e;
  }
  get(id) {
    if (!this.collabs.has(id))
      for (const e of this.log.scan({ collab_id: id, types: stateEvents }))
        this.reduce(e);
    const c = this.collabs.get(id);
    if (!c) throw new Error("COLLABORATION_NOT_FOUND");
    c.accessed = Date.now();
    for (const old of [...this.collabs.values()].sort(
      (a, b) => (a.accessed || 0) - (b.accessed || 0),
    )) {
      if (this.collabs.size <= 16) break;
      if (
        old.id === id ||
        Object.values(old.tasks).some(taskInFlight) ||
        [...this.adapters.entries()].some(
          ([key, s]) =>
            key.startsWith(old.id + ":") && (s.running || s.cleanup_error),
        )
      )
        continue;
      this.collabs.delete(old.id);
      for (const t of Object.values(old.tasks)) this.tasks.delete(t.id);
    }
    return c;
  }
  assertLive(c, epoch) {
    if (this.closed) throw new Error("BRIDGE_RELOADING");
    if (terminal(c.state) || c.epoch !== epoch)
      throw new Error("COLLABORATION_BARRIER");
  }
  create({
    project_id,
    cwd,
    title,
    goal,
    participants = [],
    upstream,
    budget = {},
    budget_profile,
    reviewer = "user",
    execution = {},
    coordinator,
  }) {
    if (this.closed) throw new Error("BRIDGE_RELOADING");
    if (!cwd || !isAbsolute(cwd)) throw new Error("Absolute cwd required");
    cwd = realpathSync(cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("Invalid cwd");
    if (coordinator != null && !workerKinds.includes(coordinator))
      throw new Error("INVALID_COORDINATOR");
    if (!execution || typeof execution !== "object" || Array.isArray(execution))
      throw new Error("INVALID_EXECUTION_MAP");
    execution = Object.fromEntries(
      Object.entries(execution).map(([agent, options]) => {
        if (!workerKinds.includes(agent)) throw new Error("UNKNOWN_AGENT");
        return [agent, normalizeExecution(options)];
      }),
    );
    if (!goal?.trim()) throw new Error("Self-contained goal required");
    budget = resolveBudget(budget_profile, budget);
    if (!Array.isArray(participants) || !participants.every(validParticipant))
      throw new Error("Unknown participant");
    if (!["user", "codex", "dsh", "kimi", "cursor"].includes(reviewer))
      throw new Error("Unknown reviewer");
    project_id ??= `project-${createHash("sha256")
      .update(process.platform === "win32" ? cwd.toLowerCase() : cwd)
      .digest("hex")
      .slice(0, 16)}`;
    const existing = this.projects.get(project_id);
    if (existing && existing.cwd !== cwd)
      throw new Error("PROJECT_WORKSPACE_MISMATCH");
    if (!existing) {
      const p = { id: project_id, cwd, title: cwd.split(/[\\/]/).pop() };
      const e = this.log.append(
        "project.registered",
        { project_id, id: null, epoch: 0 },
        p,
      );
      this.reduce(e);
    }
    const c = { id: randomUUID(), epoch: 1, project_id };
    let upstreamData;
    if (upstream) {
      const old = this.get(upstream);
      if (!terminal(old.state) || !old.handoff)
        throw new Error("Upstream must be terminal with handoff");
      if (
        (old.state === "stopped" && !old.processes?.verified) ||
        old.processes?.verified === false
      )
        throw new Error("STOP_CLEANUP_PENDING");
      const bytes = readFileSync(old.handoff.path);
      if (
        createHash("sha256").update(bytes).digest("hex") !== old.handoff.sha256
      )
        throw new Error("HANDOFF_HASH_MISMATCH");
      upstreamData = JSON.parse(bytes);
      upstreamData.artifacts = upstreamData.artifacts.map((a) => {
        try {
          const current = createHash("sha256")
            .update(readFileSync(a.path))
            .digest("hex");
          return {
            ...a,
            current_status: current === a.sha256 ? "unchanged" : "changed",
            current_sha256: current,
          };
        } catch {
          return { ...a, current_status: "missing" };
        }
      });
    }
    this.record(c, "collaboration.started", {
      cwd,
      title: title || goal.slice(0, 50),
      goal,
      reviewer,
      execution,
      coordinator,
      budget,
      upstream: upstreamData || null,
    });
    const current = this.get(c.id);
    for (const agent of participants) this.join(current, agent);
    this.showCollaboration(current);
    return current;
  }
  showCollaboration(c) {
    void this.ui(c).catch((error) =>
      this.record(c, "ui.launch_failed", { error: error.message }),
    );
  }
  join(c, agent) {
    if (!validParticipant(agent)) throw new Error("Unknown participant");
    if (!c.participants[agent]) this.record(c, "participant.joined", { agent });
  }
  send({
    collab_id,
    from = "user",
    to,
    body,
    id = randomUUID(),
    epoch,
    write_scope = [],
    hop = 0,
    delegate_depth = 0,
    type = "request",
    reply_to = null,
    retry_of,
    execution,
    routing,
  }) {
    const c = this.get(collab_id);
    epoch ??= c.epoch;
    this.assertLive(c, epoch);
    const automatic = to === "auto";
    if (automatic && (type !== "request" || retry_of || execution != null))
      throw new Error("AUTO_ROUTE_REQUIRES_REQUEST_WITHOUT_EXECUTION_OVERRIDE");
    if (routing !== undefined && !automatic)
      throw new Error("TASK_ROUTING_REQUIRES_AUTO");
    const requestedRouting = automatic ? normalizeRouting(routing) : null;
    const explicitExecution =
      execution == null ? null : normalizeExecution(execution);
    if (
      explicitExecution &&
      !retry_of &&
      from !== "user" &&
      c.coordinator &&
      from !== c.coordinator
    )
      throw new Error("MODEL_SELECTION_REQUIRES_COORDINATOR");
    const old = this.log.find(`message:${id}`);
    if (old) {
      if (
        old.collab_id !== c.id ||
        old.data.from !== from ||
        (old.data.routing ? !automatic : old.data.to !== to) ||
        (requestedRouting &&
          (!old.data.routing || Object.entries(requestedRouting).some(
            ([key, value]) => old.data.routing[key] !== value,
          ) || old.data.routing.acceptance !== requestedRouting.acceptance)) ||
        old.data.body !== body ||
        old.data.type !== type ||
        (explicitExecution &&
          Object.entries(explicitExecution).some(
            ([k, v]) => old.data.execution?.[k] !== v,
          )) ||
        this.check(old.task_id)?.retry_of !== retry_of
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return {
        task_id: old.task_id,
        duplicate: true,
        ...(old.data.routing ? { to: old.data.to, routing: old.data.routing } : {}),
      };
    }
    if (
      typeof body !== "string" ||
      !body.trim() ||
      Buffer.byteLength(body) > 32768
    )
      throw new Error(
        "Message must contain 1..32768 bytes; use artifact references",
      );
    if (type !== "result" && this.queue.length >= this.queueLimit)
      throw new Error("QUEUE_FULL");
    if (
      !Number.isSafeInteger(delegate_depth) ||
      delegate_depth < 0 ||
      (type === "request" && delegate_depth > 2)
    )
      throw new Error("DELEGATION_DEPTH_EXCEEDED: maximum 2");
    if (!Number.isSafeInteger(hop) || hop < 0) throw new Error("INVALID_HOP");
    if (type === "request") {
      const blocked = c.budget_exhausted || this.budgetBlock(c);
      if (blocked) {
        this.exhaustBudget(c, blocked.reason);
        throw new Error("BUDGET_EXCEEDED: admitted tasks and result notifications may continue; inspect mesh_budget");
      }
      if (hop >= c.budget.max_hops)
        throw new Error("BUDGET_EXCEEDED: request exceeds max_hops");
    }
    const route = automatic ? routeTask(
      requestedRouting,
      this.workers().filter((agent) =>
        agent !== from && !c.participants[agent]?.unavailable &&
        c.participants[agent]?.state !== "left"
      ),
    ) : null;
    if (route) to = route.selected;
    const taskRouting = route || c.tasks[retry_of]?.routing;
    const effectiveExecution = {
      ...(c.execution?.[to] || {}),
      ...(explicitExecution || {}),
    };
    const task_id = randomUUID();
    const scopes = write_scope.map((p) => {
      const canonical = realpathSync(resolve(c.cwd, p));
      const rel = relative(c.cwd, canonical);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Write scope outside workspace");
      return canonical;
    });
    this.join(c, to);
    if (type === "request" && !c.coordinator)
      this.record(c, "collaboration.coordinator", {
        agent: from === "user" ? to : from,
      });
    if (explicitExecution && !retry_of)
      this.record(c, "execution.selected", effectiveExecution, { agent: to });
    if (type !== "review") {
      this.invalidateReview(c, "new_task", "active");
      if (c.state === "needs_work")
        this.record(c, "collaboration.state", { state: "active" });
    }
    this.record(
      c,
      "message.sent",
      {
        id,
        from,
        to,
        body,
        type,
        reply_to,
        execution: effectiveExecution,
        ...(route ? { routing: route } : {}),
        internal: type === "result" || undefined,
      },
      { id: `message:${id}`, task_id },
    );
    this.record(
      c,
      "task.queued",
      {
        collab_id: c.id,
        from,
        to,
        body,
        execution: effectiveExecution,
        ...(taskRouting ? { routing: taskRouting } : {}),
        message_type: type,
        reply_to,
        retry_of,
        write_scope: scopes,
        hop,
        delegate_depth,
        enqueued_at: now(),
      },
      { task_id },
    );
    this.queue.push(task_id);
    this.showCollaboration(c);
    this.pump();
    return { task_id, collab_id: c.id, epoch: c.epoch,
      ...(route ? { to, routing: route } : {}) };
  }
  retryTask({ collab_id, task_id, epoch, execution }) {
    const c = this.get(collab_id);
    this.assertLive(c, epoch ?? c.epoch);
    const task = c.tasks[task_id];
    if (!task || task.state !== "failed" || task.message_type === "review")
      throw new Error("TASK_NOT_RETRYABLE");
    const selected =
      execution == null
        ? task.execution
        : { ...task.execution, ...normalizeExecution(execution) };
    if (execution != null)
      this.record(c, "execution.selected", selected, { agent: task.to });
    return this.send({
      collab_id,
      epoch,
      from: task.from,
      to: task.to,
      body: task.body,
      id: `retry:${task.id}`,
      write_scope: task.write_scope,
      hop: task.hop,
      delegate_depth: task.delegate_depth,
      type: task.message_type,
      reply_to: task.reply_to,
      retry_of: task.id,
      execution: selected,
    });
  }
  busyKey(c, agent) {
    return `${c.id}:${agent}`;
  }
  requestRounds(c) {
    return Object.values(c.tasks).filter((task) => task.message_type === "request").length;
  }
  budgetBlock(c, budget = c.budget, rounds = this.requestRounds(c)) {
    if (c.usage.tokens >= budget.max_tokens || c.usage.cost_usd >= budget.max_cost_usd)
      return { reason: "usage_budget" };
    if (rounds >= budget.max_rounds) return { reason: "round_or_hop_budget" };
    return null;
  }
  planBudget({ collab_id, epoch, actor = "user", profile, budget, reason }) {
    const c = this.get(collab_id);
    const rounds = this.requestRounds(c);
    if (profile !== undefined || budget !== undefined) {
      this.assertLive(c, epoch ?? c.epoch);
      if (actor !== "user" && actor !== c.coordinator)
        throw new Error("BUDGET_UPDATE_REQUIRES_COORDINATOR");
      if (typeof reason !== "string" || !reason.trim() || Buffer.byteLength(reason) > 512)
        throw new Error("BUDGET_UPDATE_REQUIRES_REASON");
      const next = resolveBudget(profile, budget === undefined ? {} : budget, c.budget);
      if (Object.keys(next).some((key) => next[key] !== c.budget[key]))
        this.record(c, "budget.updated", {
          budget: next,
          exhausted: this.budgetBlock(c, next, rounds),
          previous: c.budget,
          reason: reason.trim(),
          ...(profile === undefined ? {} : { profile }),
        }, { agent: actor });
    }
    return {
      collab_id: c.id,
      epoch: c.epoch,
      budget: c.budget,
      exhausted: c.budget_exhausted || this.budgetBlock(c, c.budget, rounds),
      request_rounds: rounds,
      usage: c.usage,
      presets: budgetProfiles,
      ceiling: budgetCeiling,
    };
  }
  exhaustBudget(c, reason) {
    if (c.budget_exhausted) return;
    this.record(c, "budget.exhausted", { reason });
    // Freeze admission, not delivery. Already admitted tasks retain their bounds.
  }
  queueBlocked(c, task) {
    return (
      this.occupiedSlots() >= this.maxConcurrent ||
      this.adapters.get(this.busyKey(c, task.to))?.cleanup_error ||
      this.adapters.get(this.busyKey(c, task.to))?.running ||
      this.hasConflict(task)
    );
  }
  occupiedSlots() {
    return (
      this.running +
      [...this.adapters.values()].filter((s) => s.cleanup_error && !s.running)
        .length
    );
  }
  notificationFailed(c, task, error) {
    this.record(
      c,
      "result.notification_failed",
      {
        error,
        to: task.to,
        reply_to: task.reply_to,
      },
      { task_id: task.id, agent: task.to },
    );
  }
  hasConflict(task) {
    return task.write_scope.some((scope) =>
      [...this.locks.entries()].some(
        ([held, owner]) =>
          owner !== task.id &&
          (relative(held, scope) === "" ||
            !relative(held, scope).startsWith("..") ||
            !relative(scope, held).startsWith("..")),
      ),
    );
  }
  pump() {
    if (this.closed) return;
    for (
      let i = 0;
      i < this.queue.length && this.occupiedSlots() < this.maxConcurrent;
    ) {
      const id = this.queue[i],
        task = this.tasks.get(id),
        c = this.get(task.collab_id);
      const key = this.busyKey(c, task.to);
      if (terminal(c.state) || c.epoch !== task.epoch) {
        this.queue.splice(i, 1);
        continue;
      }
      const unavailable = c.participants[task.to]?.unavailable;
      if (
        task.message_type === "result" &&
        !task.retry_of &&
        unavailable
      ) {
        this.queue.splice(i, 1);
        const error = unavailable;
        this.record(
          c,
          "task.failed",
          { error },
          { task_id: id, agent: task.to },
        );
        this.notificationFailed(c, task, error);
        continue;
      }
      if (
        this.adapters.get(key)?.running ||
        this.adapters.get(key)?.cleanup_error ||
        this.hasConflict(task)
      ) {
        task.queue_ready_since = null;
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.running++;
      for (const scope of task.write_scope) this.locks.set(scope, id);
      void this.run(c, task)
        .catch((error) => {
          if (c.epoch === task.epoch && !terminal(c.state)) {
            if (
              /usage[_ ]?limit|quota|insufficient[_ ]?(credit|balance)|credit.*exhaust|rate[_ ]?limit|额度|限额/i.test(
                error.message,
              )
            )
              this.record(
                c,
                "agent.unavailable",
                { error: error.message },
                {
                  task_id: id,
                  agent: task.to,
                },
              );
            this.record(
              c,
              "task.failed",
              { error: error.message },
              { task_id: id, agent: task.to },
            );
            if (task.message_type === "result")
              this.notificationFailed(c, task, error.message);
          }
        })
        .finally(() => {
          this.running--;
          for (const [s, owner] of this.locks)
            if (owner === id && !this.adapters.get(key)?.cleanup_error)
              this.locks.delete(s);
          void this.settleReviewer(c, task);
          this.pump();
        });
    }
  }
  prompt(c, task) {
    const routing = task.routing;
    const acceptance = routing?.acceptance ? `\nAcceptance criteria: ${routing.acceptance}` : "";
    const guidance = task.message_type !== "review" && task.to === c.coordinator
      ? `\nBefore a large fan-out, inspect mesh_budget and plan against the expected task count, retries and usage. Raise only the needed limits with a reason. For additional delegation, use mesh_send with to=auto and a truthful routing kind and complexity, or choose explicitly using these local profiles: ${JSON.stringify(agentProfiles)}. Use routine for small familiar changes, bulk_low_risk only for high-volume repetitive low-requirement work, and 3d with concrete acceptance criteria for Kimi. If no suitable worker is available, keep work local or surface the constraint; do not misclassify.`
      : "";
    return `You are ${task.to} in AgentsBridge Collaboration ${c.id}, epoch ${task.epoch}, task_id ${task.id}.\nProject: ${c.cwd}\nGoal: ${c.goal}\n${c.upstream ? `Upstream handoff (facts only; new CLI session):\n${JSON.stringify(c.upstream)}\n` : ""}Deliverables: ${JSON.stringify(c.artifacts)}\n${task.retry_of ? `Retry of ${task.retry_of}. Check what the earlier run already changed before taking action.\n` : ""}${task.message_type === "result" ? "RESULT notification: consume the returned findings; do not acknowledge back or re-delegate unless genuinely required." : "REQUEST"} from ${task.from}:\n${task.body}${acceptance}\n\nUse the agentsbridge mesh_send tool for additional collaboration only if available, never a legacy bridge. Each send is asynchronous; check tasks with mesh_check or mesh_wait. Do not wait in a loop on the task that invoked you. Do not call yourself. Respect write ownership: ${JSON.stringify(task.write_scope)}; when empty, avoid concurrent writes outside an explicitly assigned scope. Files are delivered using paths and hashes, not full contents. Return your own result even when there are no files. An optional mesh_complete reports your own task only. The bridge confirms your result when this CLI turn succeeds. The coordinator submits the collaboration after all assigned work succeeds. Only the collaboration coordinator ${c.coordinator || "user"} selects model/effort. Adapter execution options for this task: ${JSON.stringify(task.execution || {})}. Use mesh_models to inspect supported choices; never treat a prompt as a model switch or modify global CLI model configuration. Do not launch unrelated agents.${guidance}`;
  }
  async run(c, task) {
    const key = this.busyKey(c, task.to);
    let slot = this.adapters.get(key);
    if (!slot) {
      slot = {
        adapter: null,
        running: false,
        session_id: c.participants[task.to]?.session_id,
      };
      this.adapters.set(key, slot);
    }
    slot.running = true;
    slot.task = task;
    slot.started = now();
    slot.lastEvent = slot.started;
    slot.firstEvent = null;
    slot.gaps = [];
    slot.state = "working";
    slot.retry = 0;
    slot.hardExceeded = false;
    slot.interrupting = null;
    slot.lastUsage = null;
    slot.commands = new Map();
    this.record(
      c,
      "task.running",
      { started_at: new Date().toISOString() },
      { task_id: task.id, agent: task.to },
    );
    this.record(
      c,
      "agent.state",
      { state: "working", inferred: false },
      { task_id: task.id, agent: task.to },
    );
    const alive = () => c.epoch === task.epoch && !terminal(c.state);
    const onEvent = (e) => {
      if (!alive()) return;
      const t = now();
      if (!slot.firstEvent) {
        slot.firstEvent = t;
        this.record(
          c,
          "metric.first_event",
          { latency_ms: t - slot.started },
          { task_id: task.id, agent: task.to },
        );
      }
      slot.gaps.push(t - slot.lastEvent);
      slot.lastEvent = t;
      if (slot.state !== "working") {
        slot.state = "working";
        this.record(
          c,
          "agent.state",
          { state: "working", inferred: false },
          { agent: task.to, task_id: task.id },
        );
      }
      if (e.type === "session") {
        slot.session_id = e.data.session_id;
        this.record(c, "session.bound", e.data, {
          agent: task.to,
          task_id: task.id,
        });
      } else if (e.type === "execution") {
        this.record(c, "execution.configured", e.data, {
          agent: task.to,
          task_id: task.id,
        });
      } else if (e.type === "process_started") {
        slot.host_pid = e.data.pid;
        this.record(
          c,
          "process.started",
          { host_pid: e.data.pid },
          { agent: task.to, task_id: task.id },
        );
      } else if (e.type === "native") {
        const name = e.data.method || e.data.type;
        const update = e.data.params?.update?.sessionUpdate;
        const frequent =
          [
            "item/agentMessage/delta",
            "item/commandExecution/outputDelta",
            "item/reasoning/textDelta",
            "item/reasoning/summaryTextDelta",
            "thinking",
            "assistant",
          ].includes(name) ||
          ["agent_message_chunk", "agent_thought_chunk"].includes(update);
        if (frequent) {
          const raw = JSON.stringify(e.data);
          slot.nativeBuffer ??= [];
          slot.nativeBuffer.push(raw);
          slot.nativeBytes = (slot.nativeBytes || 0) + Buffer.byteLength(raw);
          if (slot.nativeBytes >= 65536 || slot.nativeBuffer.length >= 128)
            this.flush(c, slot);
          else if (!slot.flushTimer)
            slot.flushTimer = setTimeout(() => this.flush(c, slot), 80);
        } else {
          const ref = this.log.blob(e.data, "json");
          this.record(
            c,
            "cli.event",
            { native_type: name, ref },
            { agent: task.to, task_id: task.id },
          );
        }
      } else if (e.type === "tool") {
        slot.commands ??= new Map();
        const id = e.data.toolCallId || e.data.id;
        const previous = slot.commands.get(id);
        const data = { ...previous, ...e.data };
        if (!data.command)
          data.command = previous?.command || data.title || "CLI tool";
        slot.commands.set(id, data);
        const ref = this.log.blob(data.output || "");
        const done = ["completed", "failed"].includes(data.status);
        this.record(
          c,
          done
            ? "command.completed"
            : previous
              ? "command.updated"
              : "command.started",
          {
            id,
            command: data.command,
            exit_code: data.exit_code ?? null,
            summary: (typeof data.output === "string"
              ? data.output
              : JSON.stringify(data.output || "")
            ).slice(0, 500),
            output_ref: ref,
            started_at: done
              ? undefined
              : previous?.started_at || new Date().toISOString(),
            native_status: data.status,
          },
          { agent: task.to, task_id: task.id },
        );
        this.record(
          c,
          "agent.state",
          {
            state: done ? "working" : "tool",
            action: data.command || data.title,
            action_started_at: new Date().toISOString(),
          },
          { agent: task.to, task_id: task.id },
        );
      } else if (e.type === "text" || e.type === "tool_output") {
        slot.textBuffer = (slot.textBuffer || "") + (e.data.text || "");
        if (Buffer.byteLength(slot.textBuffer) >= 65536) this.flush(c, slot);
        else if (!slot.flushTimer)
          slot.flushTimer = setTimeout(() => this.flush(c, slot), 80);
      } else if (e.type === "usage") {
        slot.lastUsage = e.data;
      } else if (e.type === "diagnostic" || e.type === "approval")
        this.record(
          c,
          `cli.${e.type}`,
          {
            ...e.data,
            text: e.data.text?.slice(0, 1000),
            ...(e.data.text ? { full_ref: this.log.blob(e.data.text) } : {}),
          },
          { agent: task.to, task_id: task.id },
        );
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!slot.adapter || slot.adapter.rpc?.dead) {
            slot.adapter = this.factory(task.to);
            slot.adapter.on("event", onEvent);
            const sessionId = slot.session_id;
            const mcpServers = this.mcpServers?.(c, task) || [];
            const env = {
              ...Object.fromEntries(
                (mcpServers[0]?.env || []).map((e) => [e.name, e.value]),
              ),
              AGENTSBRIDGE_COLLAB_ID: c.id,
              AGENTSBRIDGE_EPOCH: String(task.epoch),
              AGENTSBRIDGE_AGENT: task.to,
              MESH_DEPTH: String(task.delegate_depth),
            };
            await slot.adapter.start({
              cwd: c.cwd,
              sessionId,
              env,
              mcpServers,
            });
          } else slot.adapter.on("event", onEvent);
          if (!alive()) {
            await slot.adapter.destroy();
            return;
          }
          if (
            Object.keys(task.execution || {}).length &&
            !slot.adapter.configure
          )
            throw new Error("CLI_EXECUTION_OPTIONS_UNSUPPORTED");
          await slot.adapter.configure?.(task.execution || {}, { routing: task.routing });
          if (!alive()) return;
          this.record(
            c,
            "message.delivered",
            {
              from: task.from,
              to: task.to,
              type: task.message_type || "request",
            },
            { task_id: task.id },
          );
          const retryNote = slot.retry
            ? "\nThis is the single automatic recovery after the hard time limit. Verify actual filesystem and recorded tool effects before continuing. Never blindly repeat file writes, commits, uploads or previously delivered messages. Resume preserves context but does not prove a prior external action failed."
            : "";
          const result = await slot.adapter.send(
            this.prompt(c, task) + retryNote,
          );
          if (!alive()) return;
          if (slot.hardExceeded) throw new Error("HARD_LIMIT_EXCEEDED");
          this.flush(c, slot);
          const ref = this.log.blob(result.text);
          const data = {
            from: task.to,
            to: task.from,
            type: "result",
            body: result.text.slice(0, 2000),
            full_ref: ref,
          };
          if (task.message_type !== "result") {
            this.record(c, "message.sent", data, {
              task_id: task.id,
              agent: task.to,
            });
            this.record(
              c,
              "message.delivered",
              { from: task.to, to: task.from, type: "result" },
              { task_id: task.id, agent: task.to },
            );
          }
          this.record(
            c,
            "task.completed",
            { result_ref: ref, summary: result.text.slice(0, 500) },
            { task_id: task.id, agent: task.to },
          );
          if (task.message_type === "result")
            this.record(
              c,
              "result.notification_delivered",
              {
                reply_to: task.reply_to,
              },
              { task_id: task.id, agent: task.to },
            );
          const usage =
            result.usage?.tokens != null
              ? result.usage
              : slot.lastUsage || result.usage || {};
          this.record(
            c,
            "usage.recorded",
            {
              ...usage,
              tokens: usage.tokens ?? null,
              cost_usd: usage.cost_usd ?? null,
              duration_ms: now() - slot.started,
            },
            { task_id: task.id, agent: task.to },
          );
          if (
            c.usage.tokens >= c.budget.max_tokens ||
            c.usage.cost_usd >= c.budget.max_cost_usd
          )
            this.exhaustBudget(c, "usage_budget");
          if (
            task.message_type === "request" &&
            c.participants[task.from]?.session_id
          ) {
            const unavailable = c.participants[task.from].unavailable;
            if (unavailable) {
              this.record(
                c,
                "result.notification_failed",
                {
                  error: unavailable,
                  to: task.from,
                  reply_to: task.id,
                },
                { task_id: task.id, agent: task.to },
              );
            } else {
              try {
                this.send({
                  collab_id: c.id,
                  from: task.to,
                  to: task.from,
                  body: `Result for task ${task.id}: ${result.text.slice(0, 1500)}\nFull output: ${ref.path} (sha256 ${ref.sha256})`,
                  id: `result:${task.id}`,
                  epoch: task.epoch,
                  hop: task.hop + 1,
                  delegate_depth: Math.max(0, task.delegate_depth - 1),
                  type: "result",
                  reply_to: task.id,
                });
              } catch (error) {
                this.record(
                  c,
                  "result.notification_failed",
                  { error: error.message },
                  { task_id: task.id, agent: task.to },
                );
              }
            }
          }
          break;
        } catch (error) {
          if (!alive()) return;
          try {
            await slot.interrupting;
            await slot.adapter?.destroy();
            slot.cleanup_error = null;
          } catch (cleanup) {
            slot.cleanup_error = cleanup.message;
            this.record(
              c,
              "process.cleanup_failed",
              { error: cleanup.message, original_error: error.message },
              { agent: task.to, task_id: task.id },
            );
            throw new Error(`${error.message}; cleanup: ${cleanup.message}`);
          }
          slot.adapter?.removeAllListeners();
          slot.adapter = null;
          if (!alive()) return;
          if (attempt === 0 && slot.hardExceeded && slot.session_id) {
            this.record(
              c,
              "task.retrying",
              {
                reason: "hard_limit",
                session_id: slot.session_id,
                retry_count: 1,
                warning:
                  "Verify effects of interrupted operations before retrying",
              },
              { task_id: task.id, agent: task.to },
            );
            slot.started = now();
            slot.lastEvent = now();
            slot.firstEvent = null;
            slot.hardExceeded = false;
            slot.retry++;
            continue;
          }
          if (slot.hardExceeded && !error.message.startsWith("HARD_LIMIT_EXCEEDED"))
            throw new Error(`HARD_LIMIT_EXCEEDED: ${error.message.trimEnd()}`, { cause: error });
          throw error;
        } finally {
          slot.adapter?.off("event", onEvent);
        }
      }
    } finally {
      await slot.interrupting;
      clearTimeout(slot.flushTimer);
      slot.flushTimer = null;
      slot.running = false;
      this.flush(c, slot);
      if (alive())
        this.record(
          c,
          "agent.state",
          { state: "waiting", inferred: false },
          { agent: task.to, task_id: task.id },
        );
      if (alive()) {
        this.record(
          c,
          "metric.samples",
          {
            first_event_ms: slot.firstEvent
              ? Math.max(0, slot.firstEvent - slot.started)
              : null,
            gaps_ms: slot.gaps.slice(-2000),
          },
          { agent: task.to, task_id: task.id },
        );
        const m = this.metrics[task.to];
        this.record(
          c,
          "metric.silence",
          {
            first_event_p95_ms: quantile(m.first, 0.95),
            silence_p95_ms: quantile(m.gaps, 0.95),
            sample_count: m.gaps.length,
          },
          { agent: task.to, task_id: task.id },
        );
      }
    }
  }
  flush(c, slot) {
    clearTimeout(slot.flushTimer);
    slot.flushTimer = null;
    const text = slot.textBuffer,
      raw = slot.nativeBuffer || [];
    slot.textBuffer = "";
    slot.nativeBuffer = [];
    slot.nativeBytes = 0;
    if (c.epoch !== slot.task.epoch || terminal(c.state)) return;
    if (raw.length) {
      const ref = this.log.blob(raw.join("\n") + "\n", "jsonl");
      this.record(
        c,
        "cli.batch",
        { count: raw.length, ref },
        { agent: slot.task.to, task_id: slot.task.id },
      );
    }
    if (text) {
      const ref = this.log.blob(text);
      this.record(
        c,
        "output.batch",
        { summary: text.slice(-300), ref },
        { agent: slot.task.to, task_id: slot.task.id },
      );
    }
  }
  monitor() {
    const t = now();
    for (const id of [...this.queue]) {
      const task = this.tasks.get(id);
      const c = this.get(task.collab_id);
      // Serialization, ownership and capacity waits are expected backpressure.
      // The timeout measures a scheduler stall only once dispatch is possible.
      if (this.queueBlocked(c, task)) {
        task.queue_ready_since = null;
        continue;
      }
      task.queue_ready_since ??= t;
      if (t - task.queue_ready_since > this.queueTimeoutMs) {
        this.queue.splice(this.queue.indexOf(id), 1);
        this.record(
          this.get(task.collab_id),
          "task.failed",
          { error: "QUEUE_TIMEOUT" },
          { task_id: id, agent: task.to },
        );
        if (task.message_type === "result")
          this.notificationFailed(c, task, "QUEUE_TIMEOUT");
        void this.settleReviewer(this.get(task.collab_id), task);
      }
    }
    for (const slot of this.adapters.values())
      if (slot.running) {
        const c = this.get(slot.task.collab_id);
        if (terminal(c.state)) continue;
        const silence = t - slot.lastEvent;
        const samples = (this.metrics[slot.task.to]?.gaps || []).filter(
          (gap) => gap >= this.quietMs,
        );
        const p95 = samples.length >= 5 ? quantile(samples, 0.95) : null;
        const state =
          silence >= this.quietMs && silence > (p95 ?? 60000)
            ? "suspected_stall"
            : silence >= this.quietMs
              ? "thinking"
              : slot.state;
        if (state !== slot.state) {
          slot.state = state;
          this.record(
            c,
            "agent.state",
            {
              state,
              inferred: true,
              silent_since: new Date(slot.lastEvent).toISOString(),
              silent_ms: silence,
              historical_p95_ms: p95,
            },
            { agent: slot.task.to, task_id: slot.task.id },
          );
        }
        const hard = this.hardMs[slot.task.to] ?? 900000;
        if (t - slot.started > hard && !slot.hardExceeded) {
          slot.hardExceeded = true;
          this.record(
            c,
            "agent.hard_limit",
            { hard_ms: hard, retry: slot.retry },
            { agent: slot.task.to, task_id: slot.task.id },
          );
          const adapter = slot.adapter,
            task = slot.task;
          slot.interrupting = Promise.resolve()
            .then(() => adapter?.interrupt())
            .catch((error) => {
              if (
                slot.task !== task ||
                slot.adapter !== adapter ||
                c.epoch !== task.epoch ||
                terminal(c.state)
              )
                return;
              slot.cleanup_error = error.message;
              this.record(
                c,
                "process.cleanup_failed",
                { error: error.message },
                { agent: slot.task.to, task_id: slot.task.id },
              );
            });
        }
      }
  }
  async stop(id, reason = "user", epoch) {
    const c = this.get(id);
    if (
      c.state === "stopped" ||
      (c.state === "done" &&
        (c.processes?.verified === false || c.handoff_error))
    ) {
      if (c.processes?.verified === false) this.cleanupCollaboration(c);
      if (c.handoff_error) this.tryHandoff(c);
      return { state: c.state, epoch: c.epoch };
    }
    if (c.state === "done") throw new Error("Already completed");
    if (epoch != null && c.epoch !== epoch) throw new Error("STALE_EPOCH");
    c.epoch++;
    let persistence_error;
    try {
      this.record(c, "collaboration.stopped", { reason }); // Durable terminal barrier precedes all process operations.
      for (const task of Object.values(c.tasks))
        if (taskInFlight(task))
          this.record(
            c,
            "task.cancelled",
            { reason },
            { task_id: task.id, agent: task.to },
          );
    } catch (error) {
      // Storage failure cannot make the control path leave external processes running.
      persistence_error = error.message;
      c.state = "stopped";
      for (const task of Object.values(c.tasks))
        if (taskInFlight(task)) {
          task.state = "cancelled";
          task.reason = reason;
        }
    }
    this.queue = this.queue.filter((t) => this.tasks.get(t).collab_id !== id);
    this.cleanupCollaboration(c);
    const handoff_error = persistence_error ? undefined : this.tryHandoff(c);
    return {
      state: "stopped",
      epoch: c.epoch,
      cleanup: "in_progress",
      ...(handoff_error ? { handoff_error } : {}),
      ...(persistence_error ? { persistence_error } : {}),
    };
  }
  tryHandoff(c) {
    try {
      this.handoff(c);
    } catch (error) {
      this.record(c, "handoff.failed", { error: error.message });
      return error.message;
    }
  }
  cleanupCollaboration(c, interrupt = true) {
    if (this.stopCleanups.has(c.id)) return this.stopCleanups.get(c.id);
    const jobs = [...this.adapters.entries()].filter(([k]) =>
      k.startsWith(c.id + ":"),
    );
    const cleanup = Promise.allSettled(
      jobs.map(async ([key, s]) => {
        clearTimeout(s.flushTimer);
        try {
          if (interrupt) await s.adapter?.interrupt();
          else await s.adapter?.destroy();
        } catch (error) {
          s.cleanup_error = error.message;
          throw error;
        }
        for (const [scope, owner] of this.locks)
          if (owner === s.task?.id) this.locks.delete(scope);
        this.adapters.delete(key);
      }),
    ).then((results) => {
      const failures = results
        .filter((x) => x.status === "rejected")
        .map((x) => x.reason.message);
      const data = {
        failures,
        verified: failures.length === 0,
      };
      try {
        this.record(c, "processes.terminated", data);
      } catch (error) {
        c.processes = { ...data, persistence_error: error.message };
      }
      this.pump();
    });
    this.cleanup ??= new Set();
    this.cleanup.add(cleanup);
    this.stopCleanups.set(c.id, cleanup);
    void cleanup
      .finally(() => {
        this.cleanup.delete(cleanup);
        this.stopCleanups.delete(c.id);
      })
      .catch(() => {});
    return cleanup;
  }
  deliver({ collab_id, task_id, path, summary = "", shared = true, epoch }) {
    const c = this.get(collab_id);
    this.assertLive(c, epoch ?? c.epoch);
    const task = c.tasks[task_id];
    if (!task) throw new Error("Unknown source task");
    const abs = realpathSync(path);
    const rel = relative(c.cwd, abs);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Artifact outside workspace");
    const bytes = readFileSync(abs);
    const a = {
      path: abs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      summary: summary.slice(0, 500),
      shared,
    };
    this.invalidateReview(c, "new_artifact", "active");
    const event = this.record(c, "artifact.delivered", a, {
      task_id,
      agent: task.to,
    });
    const manifest = join(this.log.home, "collaborations", c.id);
    mkdirSync(manifest, { recursive: true });
    this.log.writeJson(join(manifest, "manifest.json"), c.artifacts);
    return { ...a, event_id: event.id };
  }
  verifyArtifact(artifact) {
    let sha256;
    try {
      sha256 = createHash("sha256")
        .update(readFileSync(artifact.path))
        .digest("hex");
    } catch (error) {
      throw new Error(`ARTIFACT_UNAVAILABLE: ${artifact.path} (${error.code})`);
    }
    if (sha256 !== artifact.sha256)
      throw new Error(
        `ARTIFACT_CHANGED: ${artifact.path}; deliver the updated version first`,
      );
  }
  reviewArtifact({ collab_id, artifact_id, epoch }) {
    const c = this.get(collab_id);
    this.assertLive(c, epoch ?? c.epoch);
    const artifact = latestArtifacts(c.artifacts).find(
      (a) => a.event_id === artifact_id,
    );
    if (!artifact) throw new Error("ARTIFACT_VERSION_STALE");
    this.verifyArtifact(artifact);
    if (!c.artifact_reviews?.[artifact_id])
      this.record(c, "artifact.reviewed", {
        artifact_id,
        sha256: artifact.sha256,
      });
    return { artifact_id, state: c.state, accepted: true };
  }
  reportCompletion({ collab_id, task_id, summary, artifacts = [], epoch }) {
    const c = this.get(collab_id);
    this.assertLive(c, epoch ?? c.epoch);
    const task = c.tasks[task_id];
    if (!task || !taskInFlight(task) || task.message_type === "review")
      throw new Error("NO_ACTIVE_WORK_TASK");
    for (const a of artifacts)
      if (
        !c.artifacts.some(
          (x) =>
            x.source_task === task_id &&
            x.path === a.path &&
            x.sha256 === a.sha256,
        )
      )
        throw new Error("Artifact must be declared by this task first");
    this.record(
      c,
      "agent.completion_reported",
      { summary, artifacts },
      { task_id, agent: task.to },
    );
    return { state: c.state, task_id, reported: true };
  }
  invalidateReview(c, reason, state) {
    if (c.state !== "awaiting_review") return;
    const reviewTask = c.tasks[c.review_task_id];
    this.record(c, "review.invalidated", {
      reason,
      state,
      review_id: c.review_id,
    });
    if (reviewTask?.state === "queued") {
      this.queue = this.queue.filter((id) => id !== reviewTask.id);
      this.record(
        c,
        "task.cancelled",
        { reason },
        { task_id: reviewTask.id, agent: reviewTask.to },
      );
    }
  }
  complete({ collab_id, summary, artifacts = [], epoch }) {
    const c = this.get(collab_id);
    this.assertLive(c, epoch ?? c.epoch);
    const status = completionStatus(c);
    if (status.pending) throw new Error("TASKS_STILL_RUNNING");
    if (status.failed.length) throw new Error("FAILED_TASKS_NEED_RETRY");
    if (!status.ready) throw new Error("NO_COMPLETED_WORK");
    if (c.state === "awaiting_review")
      return { state: c.state, review_id: c.review_id };
    const latest = latestArtifacts(c.artifacts);
    for (const a of artifacts)
      if (!latest.some((x) => x.path === a.path && x.sha256 === a.sha256))
        throw new Error("Artifact must match the latest delivery");
    this.record(c, "review.requested", {
      summary,
      artifacts,
      reviewer: c.reviewer,
    });
    this.requestReviewer(c);
    return { state: c.state, review_id: c.review_id };
  }
  requestReviewer(c) {
    if (
      c.state !== "awaiting_review" ||
      c.reviewer === "user" ||
      c.review_task_id ||
      !completionStatus(c).ready
    )
      return;
    try {
      const result = this.send({
        collab_id: c.id,
        from: "bridge",
        to: c.reviewer,
        type: "review",
        body: `You are the designated reviewer. Verify the goal, actual task results and artifact hashes before deciding. Goal: ${c.goal}\nSubmission: ${JSON.stringify(c.review)}\nArtifacts: ${JSON.stringify(c.artifacts)}\nTask results: ${JSON.stringify(Object.values(c.tasks).map((t) => ({ id: t.id, state: t.state, summary: t.summary, result_ref: t.result_ref })))}\nCall mesh_review with accept=true only when verified, otherwise accept=false with concrete feedback. Do not delegate or call complete.`,
      });
      this.record(c, "review.dispatched", result);
    } catch (error) {
      this.invalidateReview(c, error.message, "needs_work");
    }
  }
  async settleReviewer(c, task) {
    if (task.id !== c.review_task_id || c.state !== "awaiting_review") return;
    if (task.state !== "completed" || !c.pending_decision) {
      this.invalidateReview(
        c,
        task.error || "REVIEWER_RETURNED_WITHOUT_DECISION",
        "needs_work",
      );
      return;
    }
    try {
      await this.review({ collab_id: c.id, ...c.pending_decision });
    } catch (error) {
      this.invalidateReview(c, error.message, "needs_work");
    }
  }
  async review({
    collab_id,
    accept,
    feedback = "",
    reviewer = "user",
    review_id,
    task_id,
    epoch,
  }) {
    const c = this.get(collab_id);
    this.assertLive(c, epoch ?? c.epoch);
    if (
      (review_id && review_id !== c.review_id) ||
      (task_id && task_id !== c.review_task_id)
    )
      throw new Error("STALE_REVIEW");
    if (c.state !== "awaiting_review") throw new Error("Review not pending");
    if (reviewer !== c.reviewer) throw new Error("REVIEWER_MISMATCH");
    if (typeof accept !== "boolean")
      throw new Error("REVIEW_DECISION_REQUIRED");
    if (!completionStatus(c).ready) throw new Error("WORK_NOT_COMPLETE");
    const reviewerTask = c.tasks[c.review_task_id];
    if (reviewerTask && taskInFlight(reviewerTask)) {
      this.record(c, "review.decision_pending", {
        accept,
        feedback,
        reviewer,
        review_id: c.review_id,
        task_id: reviewerTask.id,
      });
      return { state: c.state, settling: true };
    }
    const artifacts = accept ? latestArtifacts(c.artifacts) : [];
    for (const a of artifacts) this.verifyArtifact(a);
    this.record(c, "review.recorded", {
      accept,
      feedback,
      reviewer,
      review_id: c.review_id,
      artifact_ids: artifacts.map((a) => a.event_id),
    });
    this.record(c, "collaboration.state", {
      state: accept ? "done" : "needs_work",
    });
    if (accept) {
      this.tryHandoff(c);
      await this.cleanupCollaboration(c, false);
    }
    return { state: c.state };
  }
  handoff(c) {
    const h = {
      schema_version: 1,
      collab_id: c.id,
      project_id: c.project_id,
      status: c.state,
      goal: c.goal,
      completed: Object.values(c.tasks)
        .filter((t) => t.state === "completed")
        .map((t) => t.summary),
      decisions: c.decisions,
      unfinished: Object.values(c.tasks)
        .filter((t) => t.state !== "completed")
        .map((t) => ({ to: t.to, body: t.body, state: t.state })),
      artifacts: c.artifacts,
      context_suggestions: [
        "Start fresh CLI sessions. Verify artifact hashes and actual side effects before continuing.",
        ...(c.state === "stopped"
          ? ["Prior work was cancelled, not accepted as complete."]
          : []),
      ],
      generated_at: new Date().toISOString(),
    };
    const dir = join(this.log.home, "collaborations", c.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "handoff.json");
    this.log.writeJson(path, h);
    const sha256 = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
    this.record(c, "handoff.generated", {
      path,
      sha256,
      summary: h.completed.join("\n").slice(0, 500),
      status: c.state,
    });
    return h;
  }
  check(id) {
    if (!this.tasks.has(id)) {
      const collab = this.log.index.taskCollaboration(id);
      if (collab) this.get(collab);
    }
    const task = this.tasks.get(id);
    if (!task) throw new Error("TASK_NOT_FOUND");
    return task;
  }
  async wait(id, ms = 1000) {
    const task = this.check(id);
    if (!["queued", "running", "retrying"].includes(task.state)) return task;
    return await new Promise((resolve) => {
      const timer = setTimeout(finish, Math.min(Math.max(ms, 0), 10000));
      const handler = (e) => {
        if (
          e.task_id === id &&
          ["task.completed", "task.failed", "task.cancelled"].includes(e.type)
        )
          finish();
      };
      const self = this;
      function finish() {
        clearTimeout(timer);
        self.off("event", handler);
        resolve(self.check(id));
      }
      this.on("event", handler);
    });
  }
  snapshot() {
    return {
      projects: [...this.projects.values()],
      collaborations: [
        ...new Map(
          [
            ...this.log.index.collaborations({ limit: 100 }).items,
            ...this.collabs.values(),
          ].map((c) => [c.id, c]),
        ).values(),
      ],
      cursor: this.log.lastSeq,
      metrics: this.metrics,
    };
  }
  prepareShutdown(preserve = false) {
    if (
      preserve &&
      ([...this.adapters.values()].some((s) => s.cleanup_error) ||
        [...this.tasks.values()].some((t) =>
          ["queued", "running", "retrying"].includes(t.state),
        ))
    )
      throw new Error("BRIDGE_HAS_ACTIVE_TASKS");
    this.closed = true;
  }
  async destroy({ preserve = false } = {}) {
    this.prepareShutdown(preserve);
    clearInterval(this.timer);
    if (preserve) {
      await Promise.all(
        [...this.adapters.values()].map((s) => s.adapter?.destroy()),
      );
      this.adapters.clear();
    } else {
      for (const id of new Set([
        ...this.log.index.liveCollaborations(),
        ...this.collabs.keys(),
      ])) {
        const c = this.get(id);
        if (!terminal(c.state))
          await this.stop(c.id, "bridge_shutdown", c.epoch);
      }
    }
    await Promise.allSettled([...(this.cleanup || [])]);
  }
}
