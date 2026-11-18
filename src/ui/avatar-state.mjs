export const avatarAgents = ["kimi", "dsh", "codex", "cursor"];

export const avatarStates = {
  idle: { label: "空闲" },
  stopped: { label: "已停止", badge: "stop" },
  offline: { label: "离线", badge: "disconnect", muted: true },
  missing: { label: "未检测到 CLI", badge: "missing-cli", muted: true },
  quiet: { label: "起始静默", badge: "dots", loop: "quiet" },
  thinking: { label: "思考", badge: "thought", loop: "think" },
  working: { label: "工作中", badge: "work", loop: "work" },
  tool: { label: "使用工具", badge: "wrench", loop: "tool" },
  done: { label: "完成", effect: "done" },
  delivery: { label: "已交付", effect: "delivery" },
  waiting: { label: "等待对方", badge: "waiting", loop: "wait" },
  confirm: {
    label: "等待用户验收",
    badge: "notice",
    tone: "warning",
    loop: "confirm",
  },
  long: { label: "思考较久", badge: "drop", loop: "think" },
  stall: { label: "疑似无响应", badge: "question", tone: "warning" },
  error: { label: "出错", badge: "cross", tone: "danger", effect: "error" },
  paused: { label: "已暂停", badge: "pause" },
  wake: { label: "收到任务", effect: "wake" },
  cancelled: { label: "已取消", effect: "cancelled" },
  external: { label: "外部会话", badge: "plug" },
};

export const avatarEffects = {
  done: { badge: "check", tone: "success" },
  delivery: { badge: "check", tone: "success" },
  error: { badge: "cross", tone: "danger" },
  wake: { badge: "spark" },
  cancelled: { badge: "stop" },
};

const eventEffects = {
  "task.running": "wake",
  "task.completed": "done",
  "task.failed": "error",
  "task.cancelled": "cancelled",
  "artifact.delivered": "delivery",
};

// Renderer-only facts about the current CLI run and its most recent cue.
export function projectAvatarEvent(previous, event) {
  const type = eventEffects[event.type];
  const first = event.type === "metric.first_event";
  const starting =
    event.type === "task.running" || event.type === "task.retrying";
  if (!type && !first && !starting) return previous;
  if (first && previous?.run !== event.task_id) return previous;
  const next = { ...previous };
  if (starting) {
    next.run = event.task_id;
    next.awaitingFirst = true;
  } else if (first || (type !== "delivery" && next.run === event.task_id)) {
    next.awaitingFirst = false;
  }
  if (type) next.effect = { key: event.id, type };
  return next;
}

export function avatarStateFor(
  participant,
  collaboration,
  task,
  elapsedSeconds,
  longThreshold,
) {
  if (participant.external) return "external";
  if (collaboration?.state === "stopped" || participant.state === "stopped")
    return "stopped";
  if (collaboration?.state === "done") return "done";
  if (
    collaboration?.state === "awaiting_review" &&
    !task?.pending &&
    !task?.failed
  ) {
    const reviewer =
      collaboration.review?.reviewer || collaboration.reviewer || "user";
    if (reviewer === "user") return "confirm";
    if (reviewer !== participant.agent) return "waiting";
  }
  switch (participant.state) {
    case "suspected_stall":
      return "stall";
    case "thinking":
      return elapsedSeconds >= longThreshold ? "long" : "thinking";
    case "tool":
      return "tool";
    case "working":
      return collaboration?.avatarFacts?.[participant.agent]?.awaitingFirst
        ? "quiet"
        : "working";
    case "failed":
      return "error";
  }
  if (task?.failed) return "error";
  return task && !task.pending ? "done" : "idle";
}
