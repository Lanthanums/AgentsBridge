import { projectAvatarEvent } from "./avatar-state.mjs";

// Pure event projection. No adapter imports, process knowledge, or independent data source.
export function emptyModel() {
  return {
    cursor: 0,
    time: null,
    collaborations: {},
    order: [],
    messages: [],
    commands: {},
    events: {},
  };
}
export function hydrateSnapshot(snapshot) {
  const c = snapshot.collaboration;
  const m = emptyModel();
  for (const item of [...(snapshot.collaborations?.items || [])].reverse()) {
    m.order.push(item.id);
    m.collaborations[item.id] = {
      ...item,
      participants: {},
      artifacts: [],
      artifact_reviews: {},
      handoff: null,
      usage: [],
      tasks: {},
    };
  }
  if (!c) {
    m.cursor = snapshot.cursor || 0;
    return m;
  }
  const current = {
    ...c,
    artifact_reviews: c.artifact_reviews || {},
    handoff: c.handoff || null,
    participants: { ...c.participants },
    tasks: { ...c.tasks },
    artifacts: c.artifacts.map((a) => ({
      ...a,
      agent: a.source_agent,
      task_id: a.source_task,
    })),
    usage: [
      {
        ...c.usage,
        tokens: c.usage.unknown && !c.usage.tokens ? null : c.usage.tokens,
      },
    ],
  };
  if (!m.order.includes(c.id)) m.order.push(c.id);
  m.collaborations[c.id] = current;
  const loaded = project(m, snapshot.history?.events || []);
  loaded.collaborations[c.id] = { ...loaded.collaborations[c.id], ...current };
  loaded.cursor = snapshot.cursor || 0;
  return boundedModel(loaded);
}
export function boundedModel(model, limit = 256) {
  return {
    ...model,
    messages: model.messages.slice(-100),
    events: Object.fromEntries(Object.entries(model.events).slice(-limit)),
    commands: Object.fromEntries(Object.entries(model.commands).slice(-100)),
  };
}
export function mergeIndex(model, index, current) {
  const c = model.collaborations[current];
  const result = emptyModel();
  result.cursor = model.cursor;
  result.time = model.time;
  for (const item of [...index.items].reverse()) {
    result.order.push(item.id);
    result.collaborations[item.id] = {
      ...item,
      participants: {},
      artifacts: [],
      artifact_reviews: {},
      handoff: null,
      tasks: {},
      usage: [],
    };
  }
  if (c) {
    if (!result.order.includes(current)) result.order.push(current);
    result.collaborations[current] = c;
  }
  return {
    ...model,
    collaborations: result.collaborations,
    order: result.order,
  };
}
export function mergeTaskEvents(model, records) {
  const commands = { ...model.commands },
    events = { ...model.events };
  for (const e of records) {
    events[e.id] = e;
    const d = e.data,
      key = `${e.collab_id}:${e.task_id}:${d.id || "tool"}`;
    if ((commands[key]?.seq || 0) > e.seq) continue;
    commands[key] = {
      ...commands[key],
      ...e,
      ...d,
      finished: e.type === "command.completed",
    };
  }
  return boundedModel({ ...model, commands, events });
}
export function project(model, events) {
  const m = {
    ...model,
    collaborations: { ...model.collaborations },
    order: [...model.order],
    messages: [...model.messages],
    commands: { ...model.commands },
    events: { ...model.events },
  };
  for (const e of events) {
    if (e.seq <= m.cursor) continue;
    m.cursor = e.seq;
    m.time = e.time;
    m.events[e.id] = e;
    let c = m.collaborations[e.collab_id];
    const d = e.data || {};
    if (e.type === "collaboration.started") {
      c = {
        ...d,
        id: e.collab_id,
        epoch: e.epoch,
        state: "active",
        participants: {},
        artifacts: [],
        artifact_reviews: {},
        usage: [],
        tasks: {},
        handoff: null,
      };
      m.order.push(c.id);
    }
    if (!c) continue;
    c = {
      ...c,
      participants: { ...c.participants },
      artifacts: [...c.artifacts],
      usage: [...c.usage],
      tasks: { ...c.tasks },
    };
    m.collaborations[c.id] = c;
    if (e.agent) {
      const previous = c.avatarFacts?.[e.agent];
      const next = projectAvatarEvent(previous, e);
      if (next !== previous)
        c.avatarFacts = { ...c.avatarFacts, [e.agent]: next };
    }
    if (e.type === "participant.joined")
      c.participants[d.agent] = { agent: d.agent, state: "waiting" };
    if (e.type === "participant.left")
      c.participants[d.agent] = { ...c.participants[d.agent], state: "left" };
    if (e.type === "agent.state")
      c.participants[e.agent] = {
        ...c.participants[e.agent],
        ...d,
        updated_at: e.time,
      };
    if (e.type === "agent.progress")
      c.participants[e.agent] = {
        ...c.participants[e.agent],
        progress: d.text,
      };
    if (e.type === "session.bound")
      c.participants[e.agent] = {
        ...c.participants[e.agent],
        session_id: d.session_id,
      };
    if (e.type === "execution.selected")
      c.execution = { ...c.execution, [e.agent]: d };
    if (e.type === "execution.configured")
      c.participants[e.agent] = { ...c.participants[e.agent], execution: d };
    if (e.type === "collaboration.state") {
      c.state = d.state;
      if (d.state === "done") c.avatarRoundEffect = { key: e.id, type: "done" };
    }
    if (e.type === "budget.exhausted") c.budget_exhausted = d;
    if (e.type === "budget.updated") {
      c.budget = d.budget;
      c.budget_exhausted = d.exhausted;
    }
    if (e.type === "collaboration.stopped") {
      c.state = "stopped";
      c.epoch = e.epoch;
      c.reason = d.reason;
      for (const k of Object.keys(c.participants))
        c.participants[k] = { ...c.participants[k], state: "stopped" };
    }
    if (e.type === "review.requested") {
      c.state = "awaiting_review";
      c.review = d;
      c.review_id = e.id;
      c.review_error = null;
    }
    if (e.type === "review.invalidated") {
      c.state = d.state;
      c.review_id = null;
      c.review_error = d.state === "needs_work" ? d.reason : null;
    }
    if (e.type === "review.recorded") {
      c.review_id = null;
      c.review_error = d.accept ? null : d.feedback;
      c.artifact_reviews = { ...c.artifact_reviews };
      for (const id of d.artifact_ids || []) c.artifact_reviews[id] = true;
    }
    if (
      e.type === "message.sent" &&
      !d.internal &&
      !(
        d.type === "result" &&
        (d.reply_to || c.tasks[e.task_id]?.message_type === "result")
      )
    )
      m.messages.push({ ...e, ...d });
    if (
      ["command.started", "command.updated", "command.completed"].includes(
        e.type,
      )
    ) {
      const key = `${c.id}:${e.task_id}:${d.id || "tool"}`;
      m.commands[key] = {
        ...m.commands[key],
        ...e,
        ...d,
        finished: e.type === "command.completed",
      };
    }
    if (e.type === "task.queued")
      c.tasks[e.task_id] = { ...d, id: e.task_id, state: "queued" };
    if (e.type.startsWith("task.") && e.type !== "task.queued")
      c.tasks[e.task_id] = {
        ...c.tasks[e.task_id],
        ...d,
        state: e.type.slice(5),
      };
    if (e.type === "artifact.delivered")
      c.artifacts.push({
        ...d,
        event_id: e.id,
        task_id: e.task_id,
        agent: e.agent,
        time: e.time,
      });
    if (e.type === "usage.recorded") c.usage.push({ ...d, agent: e.agent });
    if (e.type === "handoff.generated") {
      c.handoff = { ...d, event_id: e.id, time: e.time };
      c.handoff_error = null;
    }
    if (e.type === "handoff.failed") c.handoff_error = d.error;
    if (e.type === "process.cleanup_failed") c.process_error = d.error;
    if (e.type === "processes.terminated") {
      c.processes = d;
      if (d.verified) c.process_error = null;
    }
    if (e.type === "artifact.reviewed")
      c.artifact_reviews = { ...c.artifact_reviews, [d.artifact_id]: true };
    if (e.type === "result.notification_failed") {
      c.notification_errors = {
        ...c.notification_errors,
        [d.reply_to || e.task_id]: d.error,
      };
      c.notification_error = d.error;
    }
    if (e.type === "result.notification_delivered") {
      c.notification_errors = { ...c.notification_errors };
      delete c.notification_errors[d.reply_to || e.task_id];
      c.notification_error =
        Object.values(c.notification_errors).at(-1) || null;
    }
  }
  return m;
}
export const names = {
  codex: "Codex",
  dsh: "DSH",
  kimi: "Kimi",
  cursor: "Cursor",
  user: "用户",
  bridge: "协作桥",
};
export function messageGraph(participants, messages) {
  const nodes = new Map(
    Object.entries(participants).filter(([, p]) => p.state !== "left"),
  );
  const pairs = new Map();
  for (const m of messages) {
    if (
      m.from === m.to ||
      ![m.from, m.to].every(
        (agent) =>
          nodes.has(agent) ||
          (!Object.hasOwn(participants, agent) && Object.hasOwn(names, agent)),
      )
    )
      continue;
    for (const agent of [m.from, m.to]) {
      if (!nodes.has(agent)) nodes.set(agent, { agent, external: true });
    }
    const key = `${m.from}:${m.to}`;
    pairs.delete(key);
    pairs.set(key, m);
  }
  return { nodes: [...nodes.values()], pairs };
}
export const stateLabel = {
  active: "进行中",
  awaiting_review: "待验收",
  done: "已完成",
  needs_work: "需改进",
  stopped: "已停止",
};
export function agentLabel(p, time = Date.now()) {
  if (p.external) {
    if (p.agent === "user" || p.agent === "bridge") return "本地入口";
    return "外部会话";
  }
  const sec = Math.max(
    0,
    Math.floor(
      (time -
        Date.parse(
          p.silent_since || p.updated_at || new Date(time).toISOString(),
        )) /
        1000,
    ),
  );
  if (p.state === "thinking") return `思考中 · 已静默 ${sec} 秒`;
  if (p.state === "suspected_stall") return `疑似卡死 · 已静默 ${sec} 秒`;
  return (
    {
      waiting: "等待",
      working: "工作中",
      tool: "运行工具",
      stopped: "已停止",
      left: "已离开",
    }[p.state] || "等待"
  );
}
export function positions(n) {
  if (n === 1) return [{ x: 50, y: 50 }];
  if (n === 2)
    return [
      { x: 27, y: 53 },
      { x: 73, y: 53 },
    ];
  if (n === 3)
    return [
      { x: 50, y: 25 },
      { x: 27, y: 72 },
      { x: 73, y: 72 },
    ];
  if (n === 4)
    return [
      { x: 28, y: 28 },
      { x: 72, y: 28 },
      { x: 28, y: 72 },
      { x: 72, y: 72 },
    ];
  if (n === 5 || n === 6)
    return [
      ...[18, 50, 82].map((x) => ({ x, y: 28 })),
      ...(n === 5 ? [28, 72] : [18, 50, 82]).map((x) => ({ x, y: 72 })),
    ];
  return Array.from({ length: n }, (_, i) => ({
    x: 50 + 30 * Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / n),
    y: 50 + 30 * Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / n),
  }));
}
