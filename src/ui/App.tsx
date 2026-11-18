import React, {
  useEffect,
  useState,
  useMemo,
  useRef,
  useLayoutEffect,
} from "react";
import {
  emptyModel,
  hydrateSnapshot,
  boundedModel,
  mergeIndex,
  mergeTaskEvents,
  project,
  names,
  stateLabel,
  agentLabel,
  messageGraph,
  positions,
} from "./model.mjs";
import {
  completionStatus,
  latestArtifacts,
  taskInFlight,
} from "../bridge/completion.mjs";
import { placeMessageChips } from "./chip-layout.mjs";
import { AgentAvatar } from "./AgentAvatar";
import { ExecutionSettings } from "./ExecutionSettings";
import { avatarStateFor } from "./avatar-state.mjs";
import {
  clockLabel,
  edgeGeometry,
  elapsed,
  fileKind,
  relativeTime,
} from "./presentation";
import { motion, reducedMotion, useViewMotion } from "./motion";
declare global {
  interface Window {
    bridge: any;
  }
}
const api = window.bridge;
const isVisible = () =>
  !document.hidden &&
  !document.documentElement.hasAttribute("data-native-hidden");
const workerKinds = ["codex", "dsh", "kimi", "cursor"];
const leaf = (s = "") => s.split(/[\\/]/).pop();
function Icon({ name }: { name: string }) {
  const paths: any = {
    brand: (
      <>
        <path d="M8 8 16 16M16 8l-8 8" />
        <circle cx="7" cy="7" r="3" />
        <circle cx="17" cy="7" r="3" />
        <circle cx="7" cy="17" r="3" />
        <circle cx="17" cy="17" r="3" />
      </>
    ),
    grip: (
      <>
        <path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" />
      </>
    ),
    dock: (
      <>
        <path d="M20 4v16M4 12h11m-4-4 4 4-4 4" />
      </>
    ),
    chevron: <path d="m6 9 6 6 6-6" />,
    minimize: <path d="M5 12h14" />,
    shrink: (
      <>
        <path d="M3 3l6 6M9 4v5H4M21 21l-6-6M15 20v-5h5" />
      </>
    ),
    expand: (
      <>
        <path d="M8 3H3v5M16 21h5v-5M3 3l6 6M21 21l-6-6" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M7 17 17 7M7 7h10v10" />,
    check: <path d="m5 12 4 4L19 6" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </>
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7h.01" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </>
    ),
    folder: (
      <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3" />
        <path d="M5 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="m4 7 8 6 8-6" />
      </>
    ),
    file: <path d="M13 3H5v18h14V9zM13 3v6h6" />,
    plug: <path d="M9 3v4m6-4v4M7 7h10v3a5 5 0 0 1-10 0Zm5 8v5h4" />,
    warning: <path d="M12 3 2.8 20h18.4ZM12 9v4m0 3h.01" />,
    error: <path d="M12 6v7m0 4h.01" />,
    settings: <path d="M4 7h16M4 17h16M8 4v6m8 4v6" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill={name === "stop" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || <path d="M5 12h14" />}
    </svg>
  );
}
function BrandIcon({ icons }: any) {
  return icons.brand ? (
    <img className="brand-image" src={icons.brand} alt="AgentsBridge" />
  ) : (
    <Icon name="brand" />
  );
}
function useMessageBody(message: any, open: boolean) {
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const ref = message.full_ref;
  const needsRef = useMemo(
    () =>
      Boolean(
        ref?.path &&
        ref.bytes > new TextEncoder().encode(message.body || "").length,
      ),
    [ref?.path, ref?.bytes, message.body],
  );
  useEffect(() => {
    if (!open || fullText !== null || !needsRef) return;
    let disposed = false;
    setLoadFailed(false);
    api
      .request("readRef", { path: ref.path })
      .then((text: string) => {
        if (!disposed) setFullText(text);
      })
      .catch(() => {
        if (!disposed) setLoadFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [open, fullText, needsRef, ref?.path]);
  return {
    text: fullText ?? (message.body || "（空消息）"),
    loadFailed,
    complete: !needsRef || fullText !== null,
  };
}
function MessageChip({ message, x, y, stage, open, onToggle, onDetails }: any) {
  const { text, loadFailed } = useMessageBody(message, open);
  const result = message.type === "result";
  const label = `${names[message.from]} 到 ${names[message.to]} ${result ? "结果" : "请求"}`;
  const panelId = `message-popover-${message.seq}`;
  const panelWidth = Math.min(232, stage.width - 12);
  const above = y >= stage.height / 2;
  const panelHeight = Math.max(
    64,
    Math.min(176, (above ? y : stage.height - y) - 14),
  );
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`message-chip ${result ? "result" : ""}`}
        style={{ left: x, top: y }}
        onClick={onToggle}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="chip-symbol" aria-hidden="true">
          <Icon name={result ? "check" : "send"} />
        </span>
        <span className="chip-preview" aria-hidden="true">
          {message.body || "查看消息"}
        </span>
      </button>
      <section
        id={panelId}
        className={`message-popover ${above ? "above" : "below"}`}
        data-open={open}
        inert={!open}
        aria-label="消息正文"
        onKeyDown={(event) => {
          if (event.key === "Escape") anchor.current?.focus();
        }}
        style={{
          left: Math.max(
            6,
            Math.min(x - panelWidth / 2, stage.width - panelWidth - 6),
          ),
          [above ? "bottom" : "top"]: (above ? stage.height - y : y) + 18,
          width: panelWidth,
          maxHeight: panelHeight,
        }}
      >
        <header>
          <strong>{label}</strong>
          <button
            type="button"
            className="text-button"
            aria-label="收起消息正文"
            onClick={() => {
              onToggle();
              anchor.current?.focus();
            }}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="message-popover-body" tabIndex={0}>
          {text}
          {loadFailed && <small>完整正文暂时无法读取</small>}
        </div>
        <button
          type="button"
          className="text-button message-popover-details"
          onClick={onDetails}
        >
          查看消息详情
          <Icon name="arrow" />
        </button>
      </section>
    </>
  );
}

function Arrival() {
  const echo = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!echo.current?.parentElement || reducedMotion()) return;
    const animation = echo.current.parentElement.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.035)", offset: 0.35 },
        { transform: "scale(1)" },
      ],
      motion("base"),
    );
    return () => animation.cancel();
  }, []);
  return <span ref={echo} className="arrival-echo" aria-hidden="true" />;
}

function TimelineMessage({ message, icons, fresh, pulse, onDetails }: any) {
  const [expanded, setExpanded] = useState(false);
  const { text, loadFailed, complete } = useMessageBody(message, expanded);
  const result = message.type === "result";
  return (
    <details
      className={`timeline-entry ${fresh ? "timeline-new" : ""}`}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary className="timeline-row">
        <AgentAvatar
          agent={message.from}
          icons={icons}
          state={result ? "done" : "idle"}
          pulse={pulse}
          phase={message.seq}
        />
        <span className="timeline-heading">
          <b title={`${names[message.from]} → ${names[message.to]}`}>
            {names[message.from]} → {names[message.to]}
          </b>
          <span className={`message-type ${result ? "result" : ""}`}>
            {result ? "结果" : "请求"}
          </span>
          <time
            dateTime={message.time}
            title={new Date(message.time).toLocaleString("zh-CN")}
          >
            {new Date(message.time).toLocaleTimeString("zh-CN")}
          </time>
          <Icon name="chevron" />
        </span>
        <span className="timeline-excerpt" title={message.body}>
          {message.body || "（空消息）"}
        </span>
      </summary>
      <div className="timeline-content">
        <pre>{text}</pre>
        {loadFailed && <small>完整正文暂时无法读取</small>}
        <div className="timeline-actions">
          <button
            className="text-button"
            disabled={!complete}
            onClick={() =>
              api.copy(message.full_ref && complete ? text : message.body || "")
            }
          >
            <Icon name="copy" />
            复制原文
          </button>
          <button className="text-button" onClick={onDetails}>
            查看消息详情 <Icon name="arrow" />
          </button>
        </div>
      </div>
    </details>
  );
}
export default function App() {
  const [model, setModel] = useState<any>(emptyModel()),
    [meta, setMeta] = useState<any>({
      icons: {},
      connected: false,
      replay: false,
      floating: false,
    }),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null),
    [commandPage, setCommandPage] = useState<any>({}),
    [commandBefore, setCommandBefore] = useState<number | undefined>(),
    [commandStack, setCommandStack] = useState<any[]>([]),
    [openMessage, setOpenMessage] = useState<string | null>(null),
    [stopConfirm, setStopConfirm] = useState(false),
    [form, setForm] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [wallTime, setTime] = useState(Date.now()),
    [visible, setVisible] = useState(isVisible),
    [settings, setSettings] = useState(false),
    [longThreshold, setLongThreshold] = useState(() => {
      const saved = Number(localStorage.getItem("ab.avatarLongSeconds"));
      return saved >= 1 && saved <= 3600 ? saved : 60;
    }),
    [capabilities, setCapabilities] = useState<any>(null),
    [output, setOutput] = useState<any>({}),
    [graphStage, setGraphStage] = useState<HTMLDivElement | null>(null),
    [graphSize, setGraphSize] = useState({ width: 0, height: 0 });
  const dragPointer = useRef<number | null>(null);
  const received = useRef(new Map<string, number>());
  const lastDetail = useRef<any>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const current = selected || model.order.at(-1);
  const c = model.collaborations[current];
  const time = meta.replay && model.time ? Date.parse(model.time) : wallTime;
  const agents = Object.values(c?.participants || {}).filter(
    (p: any) => p.state !== "left",
  ) as any[];
  const terminal = c && ["stopped", "done"].includes(c.state);
  const completion = completionStatus(c);
  const artifacts = latestArtifacts(c?.artifacts || []);
  const completedAgents = Object.values(completion.agents).filter(
    (s) => !s.pending && !s.failed,
  ).length;
  const assignedAgents = Object.keys(completion.agents).length;
  const standbyAgents = agents.filter(
    (p) => !completion.agents[p.agent],
  ).length;
  const nodeStatus = (p: any) => {
    if (terminal && !p.external)
      return c.state === "done" ? "本轮已完成" : "本轮已停止";
    const status = completion.agents[p.agent];
    const visual = stateOf(p);
    if (visual === "quiet") return "起始静默";
    if (visual === "confirm") return "等待用户验收";
    if (visual === "waiting") return "等待验收方";
    if (visual === "error") return "任务需处理";
    if (visual === "long") return `思考较久 · ${clockLabel(elapsed(p, time))}`;
    if (p.state === "thinking")
      return `思考中 · ${clockLabel(elapsed(p, time))}`;
    if (p.state === "suspected_stall") return `无响应 · ${elapsed(p, time)} 秒`;
    if (status && !status.pending)
      return status.failed ? "任务需处理" : "本轮任务已完成";
    if (!status && !p.external && p.state === "waiting") return "待分配任务";
    return agentLabel(p, time);
  };
  const messages = useMemo(
    () => model.messages.filter((m: any) => m.collab_id === c?.id),
    [model.messages, c?.id],
  );
  const cmds = Object.values(model.commands) as any[];
  const active = agents.filter((p) =>
    ["working", "tool", "thinking", "suspected_stall"].includes(p.state),
  );
  const leader =
    active.find((p) => p.state === "tool") || active[0] || agents[0];
  const view = meta.floating ? (meta.docked ? "ball" : "floater") : "note";
  const fresh = (id: string | undefined) =>
    visible && !!id && Date.now() - (received.current.get(id) || 0) < 1600;
  const livePresentation =
    visible &&
    !meta.transitioning &&
    (view !== "ball" || meta.dockPreview || meta.dragging);
  const stateOf = (p: any) =>
    avatarStateFor(
      p,
      c,
      completion.agents[p.agent],
      elapsed(p, time),
      longThreshold,
    );
  function cue(effect?: { key: string; type: string }) {
    if (!visible || !effect) return;
    const receivedAt = received.current.get(effect.key);
    const age = receivedAt === undefined ? Infinity : Date.now() - receivedAt;
    return age < 680 ? { ...effect, age } : undefined;
  }
  function agentCue(p: any) {
    const effect = c?.avatarRoundEffect || c?.avatarFacts?.[p.agent]?.effect;
    if (p.external || (c?.state === "stopped" && effect?.type !== "cancelled"))
      return;
    return cue(effect);
  }
  const recentDelivery = fresh(c?.handoff?.event_id)
    ? c.handoff
    : c?.artifacts.at(-1);
  const pendingCount = terminal
    ? 0
    : completion.pending + completion.failed.length;
  const hasError = Boolean(
    error ||
    c?.process_error ||
    c?.handoff_error ||
    c?.notification_error ||
    (!terminal && (c?.budget_exhausted || completion.failed.length)),
  );
  const dockState = hasError
    ? "error"
    : c?.state === "active"
      ? active.length || pendingCount
        ? "running"
        : "idle"
      : c?.state || "idle";
  const showCapabilities = Boolean(
    form && !form.target && meta.connected && !meta.replay,
  );
  const missingCli = (agent: string) =>
    showCapabilities && capabilities?.[agent]?.available === false;
  const formAgents: string[] =
    form?.agents?.filter((agent: string) => !missingCli(agent)) || [];
  const canSubmit = Boolean(
    form?.goal.trim() &&
    !busy &&
    !meta.replay &&
    (form.target || (form.cwd.trim() && formAgents.length)),
  );
  const detailVisible = Boolean(detail && c);
  if (detail) lastDetail.current = { round: current, detail };
  const panel =
    detail ||
    (lastDetail.current?.round === current ? lastDetail.current?.detail : null);
  const detailRound = model.collaborations[panel?.value?.collab_id] || c;

  useViewMotion(
    view,
    meta.transitioning,
    meta.dockPreview,
    meta.presentationRevision,
  );
  useEffect(() => {
    document.body.classList.toggle(
      "window-transitioning",
      Boolean(meta.transitioning),
    );
    document.body.classList.toggle("compact-window", Boolean(meta.floating));
  }, [meta.transitioning, meta.floating]);
  useEffect(() => {
    const visibility = () => {
      const visible = isVisible();
      setVisible(visible);
      if (visible) setTime(Date.now());
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("agentsbridge-visibilitychange", visibility);
    setVisible(isVisible());
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("agentsbridge-visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!showCapabilities) return;
    let cancelled = false;
    api
      .request("capabilities")
      .then((value: any) => {
        if (!cancelled) setCapabilities(value);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showCapabilities]);
  useEffect(() => {
    const cancelDrag = () => {
      if (dragPointer.current === null) return;
      dragPointer.current = null;
      void api.dragEnd("renderer-blur");
    };
    window.addEventListener("blur", cancelDrag);
    return () => window.removeEventListener("blur", cancelDrag);
  }, []);
  useEffect(() => {
    let snapshotSeq: number | null = null;
    let loadedCollab: string | null = null,
      historyBefore: number | null = null,
      replaying = false;
    const pending: any[] = [];
    const receive = (s: any) => {
      if (s.type === "bootstrap") {
        replaying = Boolean(s.replay);
        loadedCollab = s.selected;
        historyBefore = s.history?.before || null;
        snapshotSeq = s.cursor ?? s.events.at(-1)?.seq ?? 0;
        setModel(
          s.collaborations
            ? hydrateSnapshot(s)
            : project(emptyModel(), s.events),
        );
        setMeta(s);
        if (s.selected) setSelected(s.selected);
        pending.splice(0).forEach(receive);
      } else if (snapshotSeq === null) {
        pending.push(s);
      } else if (s.type === "events") {
        if (!replaying && s.collab_id && s.collab_id !== loadedCollab) return;
        if (s.events.at(-1)?.seq <= snapshotSeq) return;
        const now = Date.now();
        for (const e of s.events) {
          if (
            e.seq > snapshotSeq &&
            [
              "message.sent",
              "artifact.delivered",
              "handoff.generated",
              "task.running",
              "task.completed",
              "task.failed",
              "task.cancelled",
              "collaboration.state",
            ].includes(e.type)
          )
            received.current.set(
              e.type === "message.sent" ? e.data?.id || e.id : e.id,
              now,
            );
        }
        while (received.current.size > 64)
          received.current.delete(received.current.keys().next().value!);
        setModel((m: any) => {
          const next = project(m, s.events);
          return replaying
            ? next
            : boundedModel(
                historyBefore
                  ? {
                      ...next,
                      messages: m.messages,
                      commands: m.commands,
                      events: m.events,
                    }
                  : next,
              );
        });
        snapshotSeq = s.events.at(-1)?.seq || snapshotSeq;
        if (s.selected) setSelected(s.selected);
      } else if (s.type === "history-index") {
        setModel((m: any) => mergeIndex(m, s.index, loadedCollab));
        setMeta((m: any) => ({
          ...m,
          collaborations: s.index,
          index_offset: s.index_offset,
        }));
      } else
        setMeta((m: any) => ({
          ...m,
          ...s,
          presentationRevision:
            (m.presentationRevision || 0) +
            Number(s.type === "transition" && s.transitioning === false),
        }));
    };
    const unsub = api.subscribe(receive);
    api
      .snapshot()
      .then(receive)
      .catch((e: any) => setError(e.message));
    return unsub;
  }, []);
  useEffect(() => {
    setCommandBefore(undefined);
    setCommandStack([]);
    setCommandPage({});
  }, [detail?.value?.task_id]);
  useEffect(() => {
    if (meta.replay || detail?.kind !== "message" || !detail.value.task_id)
      return;
    let cancelled = false;
    api
      .request("taskEvents", {
        task_id: detail.value.task_id,
        before: commandBefore,
      })
      .then((page: any) => {
        if (cancelled) return;
        setCommandPage(page);
        setModel((m: any) =>
          mergeTaskEvents(
            {
              ...m,
              commands: Object.fromEntries(
                Object.entries(m.commands).filter(
                  ([, cmd]: any) => cmd.task_id !== detail.value.task_id,
                ),
              ),
            },
            page.events,
          ),
        );
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.kind, detail?.value?.task_id, meta.replay, commandBefore]);

  useLayoutEffect(() => {
    if (!graphStage) return;
    const observer = new ResizeObserver(([{ contentRect }]) => {
      setGraphSize({ width: contentRect.width, height: contentRect.height });
    });
    observer.observe(graphStage);
    return () => observer.disconnect();
  }, [graphStage]);
  useEffect(() => {
    if (current) api.request("selected", { id: current }).catch(() => {});
    setDetail(null);
    setOpenMessage(null);
    setOutput({});
  }, [current]);
  const needsClock =
    !meta.replay && livePresentation && !terminal && active.length > 0;
  useEffect(() => {
    if (!needsClock) return;
    setTime(Date.now());
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [needsClock]);
  const compactLongAt =
    view === "ball" && !livePresentation && leader?.state === "thinking"
      ? Date.parse(leader.silent_since || leader.updated_at || "") +
        longThreshold * 1000
      : NaN;
  useEffect(() => {
    if (meta.replay || !visible || terminal || !Number.isFinite(compactLongAt))
      return;
    const timer = setTimeout(
      () => setTime(Date.now()),
      Math.max(0, compactLongAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [compactLongAt, meta.replay, visible, terminal]);
  const needsDeliveryClock =
    !meta.replay &&
    visible &&
    view === "note" &&
    Boolean(c?.handoff || artifacts.length);
  useEffect(() => {
    if (!needsDeliveryClock || needsClock) return;
    setTime(Date.now());
    const timer = setInterval(() => setTime(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [needsDeliveryClock, needsClock]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setStopConfirm(false);
        setDetail(null);
        setOpenMessage(null);
        setForm(null);
        setSettings(false);
      }
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  useEffect(() => {
    if (!openMessage) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".message-chip, .message-popover")
      )
        setOpenMessage(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [openMessage]);
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function read(ref: any, key: string) {
    if (!ref?.path) return;
    await action(async () => {
      const value = await api.request("readRef", { path: ref.path });
      setOutput((o: any) => ({ ...o, [key]: value }));
    });
  }
  const fileCard = (a: any, round = c) => (
    <FileCard
      key={a.event_id}
      a={a}
      action={action}
      accepted={Boolean(round.artifact_reviews?.[a.event_id])}
      approve={
        round.id === c.id &&
        !terminal &&
        !meta.replay &&
        !busy &&
        artifacts.some((item) => item.event_id === a.event_id)
          ? () =>
              action(() =>
                api.request("reviewArtifact", {
                  collab_id: c.id,
                  epoch: c.epoch,
                  artifact_id: a.event_id,
                }),
              )
          : undefined
      }
    />
  );
  function commandText(p: any) {
    const command = cmds
      .filter((m) => m.collab_id === c.id && m.agent === p.agent && !m.finished)
      .at(-1);
    if (!command) return p.progress || p.action || null;
    const sec = Math.max(
      0,
      Math.floor(
        (time - Date.parse(command.started_at || command.time)) / 1000,
      ),
    );
    return `${command.command} · 已运行 ${sec} 秒`;
  }
  const { nodes, pairs } = useMemo(() => {
    return messageGraph(c?.participants || {}, messages);
  }, [c?.participants, messages]);
  const firstRequest = messages.find((m: any) => m.type !== "result");
  const nodeOrder = [
    firstRequest?.from,
    firstRequest?.to,
    ...nodes.map((p: any) => p.agent),
  ];
  const order = [...new Set(nodeOrder.filter(Boolean))];
  const coords = positions(nodes.length);
  const centers = new Map<string, { x: number; y: number }>(
    nodes.map((p: any, i: number) => [
      p.agent,
      {
        x: (coords[i].x * graphSize.width) / 100,
        y: (coords[i].y * graphSize.height) / 100 - 20,
      },
    ]),
  );
  const edges =
    graphSize.width && graphSize.height
      ? [...pairs.values()].map((m: any) => {
          const a = centers.get(m.from)!;
          const b = centers.get(m.to)!;
          return {
            m,
            kind: m.type === "result" ? "receipt" : "request",
            ...edgeGeometry(a, b, pairs.has(`${m.to}:${m.from}`)),
          };
        })
      : [];
  const bubbleEdges = edges.slice(-6);
  if (openMessage && !bubbleEdges.some(({ m }) => m.id === openMessage)) {
    const message = messages.find((m: any) => m.id === openMessage);
    const related =
      message &&
      edges.find(({ m }) => m.from === message.from && m.to === message.to);
    if (related) {
      const index = bubbleEdges.indexOf(related);
      bubbleEdges.splice(index < 0 ? 0 : index, 1, { ...related, m: message });
    }
  }
  const incoming = new Map(
    (edges.length ? messages.slice(-64) : [])
      .filter((m: any) => fresh(m.id) && pairs.has(`${m.from}:${m.to}`))
      .map((m: any) => [m.to, m]),
  );
  const chips = placeMessageChips(bubbleEdges, centers.values(), graphSize);
  const rounds: any[] = [];
  if (panel?.kind === "timeline") {
    const seen = new Set<string>();
    let round = c;
    while (round && !seen.has(round.id)) {
      seen.add(round.id);
      rounds.push(round);
      round = model.collaborations[round.upstream?.collab_id];
    }
  }
  async function create() {
    if (!canSubmit) return;
    await action(async () => {
      if (form.target) {
        await api.request(form.retry_task ? "retryTask" : "send", {
          collab_id: form.target.id,
          epoch: form.target.epoch,
          to: form.to,
          body: form.goal,
          execution: form.execution?.[form.to],
          ...(form.retry_task ? { task_id: form.retry_task } : {}),
        });
        setForm(null);
        return;
      }
      const created = await api.request("create", {
        cwd: form.cwd,
        goal: form.goal,
        title: form.title || form.goal.slice(0, 40),
        participants: formAgents,
        upstream: form.upstream,
        execution: form.execution || {},
        coordinator: formAgents[0],
      });
      setSelected(created.id);
      await api.request("send", {
        collab_id: created.id,
        to: formAgents[0],
        body: `请完成本轮目标：${form.goal}。可通过 mesh_send 与 ${formAgents.slice(1).join("、") || "其他参与者"} 协作。请返回本任务结果，有文件时使用 mesh_deliver。`,
      });
      setForm(null);
    });
  }
  const openForm = (upstream?: string) =>
    setForm({
      goal: "",
      title: "",
      cwd: c?.cwd || "",
      agents: ["codex", "dsh", "kimi"],
      upstream,
    });
  const openFollowUp = () =>
    setForm({
      target: { id: c.id, epoch: c.epoch, title: c.title },
      to:
        agents.find((p) => workerKinds.includes(p.agent))?.agent ||
        workerKinds[0],
      goal: "",
      execution: c.execution || {},
    });
  const stop = async () => {
    await action(() =>
      api.request("stop", { collab_id: c.id, epoch: c.epoch }),
    );
    setStopConfirm(false);
  };
  const controls = (
    <>
      <button
        className="icon-button"
        title="最小化到任务栏"
        aria-label="最小化到任务栏"
        onClick={() => api.window("minimize")}
      >
        <Icon name="minimize" />
      </button>
      <button
        className="icon-button"
        title="收起为悬浮条"
        aria-label="收起为悬浮条"
        onClick={() => api.window("floater")}
      >
        <Icon name="shrink" />
      </button>
      <button
        className="icon-button close-window"
        aria-label="关闭便签窗口"
        title="关闭便签窗口"
        onClick={() => api.window("close")}
      >
        <Icon name="close" />
      </button>
    </>
  );
  const stopDialog = stopConfirm && (
    <div className="scrim">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="stop-title"
        className="dialog stop-dialog"
      >
        <span className="eyebrow">停止是本轮合作的终态</span>
        <h2 id="stop-title">立即停止合作？</h2>
        <p>
          阻止新消息投递，终止相关进程树。迟到回写将丢弃，不再唤醒任何 agent。
        </p>
        <p className="muted">后续工作可以从交接记录发起新一轮合作。</p>
        <div className="dialog-actions">
          <button onClick={() => setStopConfirm(false)}>返回</button>
          <button className="solid-danger" disabled={busy} onClick={stop}>
            <Icon name="stop" />
            确认停止
          </button>
        </div>
      </section>
    </div>
  );
  const cancelCapturedDrag = (reason: string) => {
    if (dragPointer.current === null) return;
    dragPointer.current = null;
    void api.dragEnd(reason);
  };
  const dragProps = (openOnClick = false) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || dragPointer.current !== null) return;
      if (
        e.currentTarget.tagName !== "BUTTON" &&
        (e.target as Element).closest("button")
      )
        return;
      dragPointer.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      void api.dragStart();
    },
    onPointerUp: async (e: React.PointerEvent<HTMLElement>) => {
      if (dragPointer.current !== e.pointerId) return;
      dragPointer.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      const result = await api.dragEnd();
      if (result.started && !result.moved && openOnClick) api.window("expand");
    },
    onPointerCancel: () => cancelCapturedDrag("pointer-cancel"),
    onLostPointerCapture: () => cancelCapturedDrag("lost-capture"),
  });
  const leadStatus = leader && !terminal ? nodeStatus(leader) : "";
  const counterpart = messages.findLast(
    (m: any) => m.from === leader?.agent || m.to === leader?.agent,
  );
  const peer =
    counterpart &&
    names[
      counterpart.from === leader?.agent ? counterpart.to : counterpart.from
    ];
  const compactSummary =
    (leader && !terminal && commandText(leader)) ||
    (leadStatus &&
      leadStatus !== stateLabel[c?.state] &&
      (leader.state === "thinking" || leader.state === "suspected_stall") &&
      leadStatus) ||
    (c?.handoff && "本轮交接已生成") ||
    (peer && !terminal && `与 ${peer} 协作`) ||
    c?.title ||
    "等待协作事件";
  const reviewNotice = [
    c?.review_error,
    c?.process_error && `进程清理未能完成：${c.process_error}`,
    c?.processes?.verified === false &&
      `进程清理尚未确认：${c.processes.failures.join("；")}`,
    c?.handoff_error && `交接文件未能写入：${c.handoff_error}`,
    c?.budget_exhausted &&
      "本轮预算已耗尽，暂停新增派工；已分配任务仍可交付和回传结果。协调模型可按需调高预算。",
    c?.notification_error &&
      `结果已记录，回投未送达（${c.notification_error}）`,
  ]
    .filter(Boolean)
    .join(" ");
  if (meta.floating && meta.docked)
    return (
      <main
        className={`dock-ball-shell ${meta.dragging ? "dragging" : ""} ${meta.dockPreview ? "preview" : ""} ${
          c && !terminal ? "active" : "idle"
        }`}
        data-motion={livePresentation ? "live" : "still"}
        data-dock-state={dockState}
        onMouseEnter={() => void api.dockPreview().catch(() => {})}
      >
        <button
          className="dock-ball"
          aria-label="打开协作便签"
          title="单击打开便签 · 拖动移动位置"
          {...dragProps(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              api.window("expand");
            }
            if (e.key === "Escape") void api.dockPreview(false);
          }}
        >
          <span
            className={`dock-app-icon agent-${leader?.agent || "bridge"}`}
            data-shared-agent={leader?.agent}
          >
            <span className="dock-ring" aria-hidden="true" />
            {fresh(recentDelivery?.event_id) && (
              <span
                key={recentDelivery.event_id}
                className="dock-delivery"
                aria-hidden="true"
              />
            )}
            {leader ? (
              <AgentAvatar
                agent={leader.agent}
                icons={meta.icons}
                size="micro"
                state={stateOf(leader)}
                pulse={agentCue(leader)}
              />
            ) : (
              <BrandIcon icons={meta.icons} />
            )}
            {pendingCount > 0 && (
              <span className="dock-count" title={`${pendingCount} 项待处理`}>
                {pendingCount > 9 ? "9+" : pendingCount}
              </span>
            )}
          </span>
          <span className="dock-summary">
            <strong>
              {meta.dragging
                ? meta.dockHint
                  ? "松手后吸附"
                  : "松手后展开"
                : c
                  ? stateLabel[c.state]
                  : "AgentsBridge"}
            </strong>
            <span title={compactSummary}>
              {c ? compactSummary : "打开协作便签"}
            </span>
          </span>
          <span className="dock-expand-icon">
            <Icon name="expand" />
          </span>
        </button>
      </main>
    );
  if (meta.floating)
    return (
      <main
        aria-label="拖动悬浮条"
        className={`floater ${meta.dockHint ? "dock-hint" : ""}`}
        data-motion={livePresentation ? "live" : "still"}
        {...dragProps()}
      >
        <div className="floater-lead">
          {leader ? (
            <span
              className={`floater-avatar agent-${leader.agent}`}
              data-agent-state={stateOf(leader)}
              data-shared-agent={leader.agent}
            >
              <AgentAvatar
                agent={leader.agent}
                icons={meta.icons}
                state={stateOf(leader)}
                pulse={agentCue(leader)}
              />
            </span>
          ) : (
            <span className="floater-brand">
              <BrandIcon icons={meta.icons} />
            </span>
          )}
          <div>
            <strong
              title={`${leader ? names[leader.agent] : "AgentsBridge"} · ${c ? stateLabel[c.state] : "协作便签"}`}
            >
              {leader ? names[leader.agent] : "AgentsBridge"} ·{" "}
              {c ? stateLabel[c.state] : "协作便签"}
            </strong>
            <p title={compactSummary}>{compactSummary}</p>
          </div>
        </div>
        <div className="mini-agents">
          {agents
            .filter((p) => p !== leader)
            .map((p, i) => (
              <span
                key={p.agent}
                className={`mini-agent agent-${p.agent}`}
                data-agent-state={stateOf(p)}
                title={`${names[p.agent]} · ${nodeStatus(p)}`}
              >
                <AgentAvatar
                  agent={p.agent}
                  icons={meta.icons}
                  size="micro"
                  state={stateOf(p)}
                  pulse={agentCue(p)}
                  phase={i + 1}
                />
              </span>
            ))}
        </div>
        <div className="window-controls">
          <button
            className="icon-button"
            title="打开协作便签"
            aria-label="回到便签视图"
            onClick={() => api.window("expand")}
          >
            <Icon name="expand" />
          </button>
          <button
            className="icon-button"
            title="收起到屏幕右侧"
            aria-label="收起为悬浮球"
            onClick={() => api.window("dock")}
          >
            <Icon name="dock" />
          </button>
        </div>
        {stopDialog}
        {error && (
          <div className="float-error" role="alert" title={error}>
            {error}
          </div>
        )}
      </main>
    );
  return (
    <main className="note" data-motion={livePresentation ? "live" : "still"}>
      <header className="titlebar">
        <div className="heading">
          <span className="brand-mark">
            <BrandIcon icons={meta.icons} />
          </span>
          <div>
            <span className="eyebrow">本地多智能体协作</span>
            <h1>AgentsBridge</h1>
          </div>
        </div>
        <span
          className={`state ${c?.state || ""}`}
          data-running={Boolean(
            !terminal &&
            c?.state === "active" &&
            (active.length || pendingCount),
          )}
        >
          <i />
          {c ? stateLabel[c.state] : "等待开始"}
          {c && agents.length > 0 && <small> · {agents.length} 位参与者</small>}
        </span>
        <div className="window-controls">{controls}</div>
      </header>
      <nav className="contextbar">
        <span
          className={`connection-status ${
            meta.replay
              ? "replay-tag"
              : meta.connected
                ? "live-tag"
                : "offline-tag"
          }`}
        >
          <i />
          {meta.replay
            ? "事件回放"
            : meta.connected
              ? "本地事件流已连接"
              : "离线 · 查看已落盘记录"}
        </span>
        {c && model.order.length === 1 && (
          <span className="collaboration-title" title={c.title}>
            {c.title}
          </span>
        )}
        {model.order.length > 1 && (
          <span className="history-picker">
            <select
              aria-label="选择合作"
              title={c ? `${c.title} · ${stateLabel[c.state]}` : "选择合作"}
              value={current || ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {model.order.map((id: string) => (
                <option key={id} value={id}>
                  {model.collaborations[id].title} ·{" "}
                  {stateLabel[model.collaborations[id].state]}
                </option>
              ))}
            </select>
            <span className="picker-arrow" aria-hidden="true">
              <Icon name="chevron" />
            </span>
          </span>
        )}
        {!meta.replay &&
          (meta.collaborations?.has_more || meta.index_offset > 0) && (
            <span className="history-index-controls">
              <button
                className="icon-button"
                aria-label="较新的合作"
                disabled={!meta.index_offset}
                onClick={() =>
                  void action(() =>
                    api.request("historyIndex", { direction: "newer" }),
                  )
                }
              >
                <Icon name="arrow" />
              </button>
              <button
                className="icon-button"
                aria-label="较早的合作"
                disabled={!meta.collaborations?.has_more}
                onClick={() =>
                  void action(() =>
                    api.request("historyIndex", { direction: "older" }),
                  )
                }
              >
                <Icon name="chevron" />
              </button>
            </span>
          )}
        <button className="new-button" onClick={() => openForm()}>
          <Icon name="plus" />
          新合作
        </button>
      </nav>
      {!c ? (
        <section className="welcome">
          <span className="welcome-mark">
            <BrandIcon icons={meta.icons} />
          </span>
          <span className="eyebrow">LOCAL AGENT WORKSPACE</span>
          <h2>每一次交接，都有迹可循。</h2>
          <p>消息、工具执行与文件交付，汇聚为一张协作便签。</p>
          <button className="primary with-icon" onClick={() => openForm()}>
            <Icon name="plus" />
            发起合作
          </button>
        </section>
      ) : (
        <>
          <div className="workspace-body">
            <section
              key={c.id}
              className={`canvas n${nodes.length}`}
              aria-label="协作关系图"
            >
              <div className="canvas-caption">
                <i />
                协作现场 · {agents.length} 位参与者
                {nodes.length > agents.length &&
                  ` · ${nodes.length - agents.length} 个外部端点`}
              </div>
              <div className="graph-viewport">
                <div className="graph-stage" ref={setGraphStage}>
                  {!nodes.length && (
                    <p className="graph-empty">等待派发第一条任务</p>
                  )}
                  <svg className="connections" aria-hidden="true">
                    <defs>
                      {["request", "receipt"].map((kind) => (
                        <marker
                          key={kind}
                          id={`arrow-${kind}`}
                          className={kind}
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="7"
                          markerHeight="7"
                          markerUnits="userSpaceOnUse"
                          orient="auto"
                        >
                          <path d="M0 0 10 5 0 10Z" />
                        </marker>
                      ))}
                    </defs>
                    {edges.map(({ m, kind, path }) => (
                      <g
                        key={m.id}
                        className={`graph-edge ${kind}`}
                        data-fresh={fresh(m.id)}
                        data-active={Boolean(
                          !terminal &&
                          c.tasks[m.task_id] &&
                          taskInFlight(c.tasks[m.task_id]),
                        )}
                      >
                        <path
                          className={kind}
                          d={path}
                          markerEnd={`url(#arrow-${kind})`}
                        />
                      </g>
                    ))}
                  </svg>
                  {chips.map(({ m, x, y }) => (
                    <MessageChip
                      key={m.id}
                      message={m}
                      x={x}
                      y={y}
                      stage={graphSize}
                      open={openMessage === m.id}
                      onToggle={() => {
                        setDetail(null);
                        setOpenMessage((id) => (id === m.id ? null : m.id));
                      }}
                      onDetails={() => {
                        setOpenMessage(null);
                        setDetail({ kind: "message", value: m });
                        setOutput({});
                      }}
                    />
                  ))}
                  {nodes.map((p: any, i: number) => {
                    const pos = coords[i],
                      actionText = commandText(p),
                      state = stateOf(p),
                      incomingMessage = incoming.get(p.agent);
                    const peerCenter =
                      state === "waiting" &&
                      centers.get(c.review?.reviewer || c.reviewer);
                    const ownCenter = centers.get(p.agent);
                    return (
                      <div
                        key={p.agent}
                        className={`agent-node ${p.agent} agent-${p.agent} ${p.external ? "external" : ""}`}
                        data-agent-state={state}
                        style={
                          {
                            left: `${pos.x}%`,
                            top: `calc(${pos.y}% - 20px)`,
                            "--entry-order": order.indexOf(p.agent),
                          } as React.CSSProperties
                        }
                      >
                        {actionText && !terminal && (
                          <div className="action-bubble">
                            <b>
                              {p.state === "tool" ? "运行工具" : "当前动作"}
                            </b>
                            <span>{actionText}</span>
                          </div>
                        )}
                        <button
                          className="node-disc"
                          aria-label={`查看 ${names[p.agent]} 动态`}
                          title={
                            actionText
                              ? `${nodeStatus(p)} · ${actionText}`
                              : nodeStatus(p)
                          }
                          data-shared-agent={
                            p.agent === leader?.agent ? p.agent : undefined
                          }
                          onClick={() => setDetail({ kind: "agent", value: p })}
                        >
                          <AgentAvatar
                            agent={p.agent}
                            icons={meta.icons}
                            size="large"
                            state={state}
                            pulse={agentCue(p)}
                            phase={i}
                            facing={
                              peerCenter && ownCenter
                                ? peerCenter.x < ownCenter.x
                                  ? "left"
                                  : "right"
                                : undefined
                            }
                          />
                          {incomingMessage && (
                            <Arrival key={incomingMessage.id} />
                          )}
                        </button>
                        <strong>{names[p.agent]}</strong>
                        <span
                          className={`agent-status ${p.state}`}
                          title={nodeStatus(p)}
                        >
                          {nodeStatus(p)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
            <section className="deliveries">
              <div className="section-title">
                <span>最近交付</span>
                <div className="delivery-actions">
                  {!terminal && !meta.replay && (
                    <button className="text-button" onClick={openFollowUp}>
                      <Icon name="plus" />
                      追加任务
                    </button>
                  )}
                  <button
                    className="text-button"
                    onClick={() => setDetail({ kind: "timeline" })}
                  >
                    <Icon name="history" />
                    消息记录
                  </button>
                </div>
              </div>
              {c.handoff ? (
                <div className="handoff">
                  <span
                    className="file-symbol"
                    data-file={fileKind(c.handoff.path)}
                  >
                    <Icon name="file" />
                  </span>
                  <div>
                    <div className="handoff-title">
                      <b>本轮交接已生成</b>
                      <time
                        dateTime={c.handoff.time}
                        title={new Date(c.handoff.time).toLocaleString("zh-CN")}
                      >
                        {relativeTime(c.handoff.time, time)}
                      </time>
                    </div>
                    <p
                      title={
                        c.handoff.summary ||
                        "目标、关键决策、未完成项与交付清单已整理。"
                      }
                    >
                      {c.handoff.summary ||
                        "目标、关键决策、未完成项与交付清单已整理。"}
                    </p>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setDetail({ kind: "handoff", value: c.handoff });
                        void read(c.handoff, "handoff");
                      }}
                    >
                      查看交接
                      <Icon name="arrow" />
                    </button>
                  </div>
                  <button
                    className="primary"
                    disabled={
                      (c.state === "stopped" && !c.processes?.verified) ||
                      c.processes?.verified === false ||
                      Boolean(c.handoff_error)
                    }
                    onClick={() => openForm(c.id)}
                  >
                    <Icon name="plus" />
                    {c.state === "stopped" && !c.processes?.verified
                      ? "正在终止相关进程…"
                      : "发起下一轮合作"}
                  </button>
                </div>
              ) : artifacts.length ? (
                <div className="artifact-list">
                  {artifacts
                    .slice(-3)
                    .reverse()
                    .map((a: any) => (
                      <button
                        key={a.event_id}
                        className="artifact-row"
                        onClick={() =>
                          setDetail({ kind: "artifact", value: a })
                        }
                      >
                        <span
                          className="file-symbol"
                          data-file={fileKind(a.path)}
                        >
                          <Icon name="file" />
                        </span>
                        <div>
                          <b title={leaf(a.path)}>{leaf(a.path)}</b>
                          <small title={a.summary}>
                            {names[a.agent]} ·{" "}
                            {c.artifact_reviews?.[a.event_id]
                              ? "已验收"
                              : a.shared
                                ? "已分享"
                                : "尚未分享"}{" "}
                            · {relativeTime(a.time, time)} · {a.summary}
                          </small>
                        </div>
                        <Icon name="arrow" />
                      </button>
                    ))}
                </div>
              ) : (
                <p className="empty">交付文件将在这里汇总</p>
              )}
              {(reviewNotice || c.state === "stopped") && (
                <div
                  className="review-note"
                  role={reviewNotice ? "alert" : undefined}
                  data-warning={Boolean(reviewNotice)}
                >
                  <Icon name={reviewNotice ? "warning" : "info"} />
                  <div>
                    {reviewNotice && <strong>{reviewNotice}</strong>}
                    {c.state === "stopped" && (
                      <p>本轮已取消；后续工作请通过交接发起新合作。</p>
                    )}
                    {(c.processes?.verified === false || c.handoff_error) && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            api.request("stop", {
                              collab_id: c.id,
                              epoch: c.epoch,
                            }),
                          )
                        }
                      >
                        重试清理与交接
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
            {!terminal &&
              completion.failed.map((t: any) => (
                <div key={t.id} className="inline-error" role="alert">
                  <span>
                    {names[t.to]} · {t.error || t.state}
                  </span>
                  {t.state === "failed" && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api.request("retryTask", {
                            collab_id: c.id,
                            task_id: t.id,
                            epoch: c.epoch,
                          }),
                        )
                      }
                    >
                      重试任务
                    </button>
                  )}
                  {t.state === "failed" && t.message_type !== "result" && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        setForm({
                          target: { id: c.id, epoch: c.epoch, title: c.title },
                          retry_task: t.id,
                          to: t.to,
                          goal: t.body,
                          execution: { [t.to]: t.execution || {} },
                        })
                      }
                    >
                      调整模型后重试
                    </button>
                  )}
                </div>
              ))}
          </div>
          {c.state !== "stopped" && (
            <div className="reviewbar">
              {c.state === "awaiting_review" && completion.ready ? (
                <>
                  <span>
                    {c.reviewer && c.reviewer !== "user"
                      ? `等待 ${names[c.reviewer]} 验收。`
                      : "所有已分配任务均已完成。"}
                  </span>
                  {(!c.reviewer || c.reviewer === "user") && (
                    <>
                      <button
                        onClick={() =>
                          void action(() =>
                            api.request("review", {
                              collab_id: c.id,
                              review_id: c.review_id,
                              epoch: c.epoch,
                              accept: false,
                              feedback: "请继续完善交付",
                            }),
                          )
                        }
                      >
                        <Icon name="edit" />
                        需改进
                      </button>
                      <button
                        className="primary"
                        onClick={() =>
                          void action(() =>
                            api.request("review", {
                              collab_id: c.id,
                              review_id: c.review_id,
                              epoch: c.epoch,
                              accept: true,
                            }),
                          )
                        }
                      >
                        <Icon name="check" />
                        整轮验收通过
                      </button>
                    </>
                  )}
                </>
              ) : !terminal && completion.ready ? (
                <>
                  <span>
                    {completedAgents}/{assignedAgents} 位已完成
                    {standbyAgents > 0 && ` · ${standbyAgents} 位未派发`}
                  </span>
                  <button
                    className="primary"
                    onClick={() =>
                      void action(() =>
                        api.request("complete", {
                          collab_id: c.id,
                          epoch: c.epoch,
                          summary: "本轮结果已返回，请检查消息与交付文件。",
                        }),
                      )
                    }
                  >
                    <Icon name="send" />
                    提交整轮验收
                  </button>
                </>
              ) : (
                <span className="muted">
                  {c.state === "done"
                    ? "交付已通过验收。"
                    : assignedAgents
                      ? `${completedAgents}/${assignedAgents} 位已完成${completion.failed.length ? ` · ${completion.failed.length} 项待处理` : ""}`
                      : "等待派发任务。"}
                </span>
              )}
              {!terminal && (
                <button
                  className="stop-action"
                  title="停止合作"
                  aria-label="停止合作"
                  onClick={() => setStopConfirm(true)}
                >
                  <Icon name="stop" />
                  <span>停止</span>
                </button>
              )}
            </div>
          )}
        </>
      )}
      <footer>
        <span>
          <Icon name="info" />
          本地运行 · 消息与交付自动留存
        </span>
        {c && (
          <span className="usage">
            {c.usage.some((u: any) => u.tokens != null)
              ? `${c.usage
                  .filter((u: any) => u.tokens != null)
                  .reduce((n: number, u: any) => n + u.tokens, 0)
                  .toLocaleString()} tokens（已报告部分）`
              : "用量等待 CLI 报告"}
          </span>
        )}
        <button
          type="button"
          className="icon-button settings-toggle"
          title="设置"
          aria-label="设置"
          aria-expanded={settings}
          aria-controls="display-settings"
          onClick={() => setSettings(!settings)}
        >
          <Icon name="settings" />
        </button>
        {settings && (
          <section
            className="display-settings"
            id="display-settings"
            aria-label="显示设置"
          >
            <label className="avatar-threshold">
              思考较久阈值（秒）
              <input
                type="number"
                min="1"
                max="3600"
                step="1"
                defaultValue={longThreshold}
                onBlur={(event) => {
                  const seconds = event.currentTarget.valueAsNumber;
                  if (
                    !Number.isInteger(seconds) ||
                    seconds < 1 ||
                    seconds > 3600
                  ) {
                    event.currentTarget.value = String(longThreshold);
                    return;
                  }
                  setLongThreshold(seconds);
                  localStorage.setItem("ab.avatarLongSeconds", String(seconds));
                }}
              />
            </label>
          </section>
        )}
      </footer>
      {panel && c && (
        <aside
          className="details"
          data-open={detailVisible}
          data-kind={panel.kind}
          inert={!detailVisible}
          aria-label="固定详情面板"
        >
          <div className="detail-head">
            <span>
              {panel.kind === "message"
                ? `${names[panel.value.from]} → ${names[panel.value.to]}`
                : panel.kind === "artifact"
                  ? "文件交付"
                  : panel.kind === "handoff"
                    ? "合作交接"
                    : panel.kind === "agent"
                      ? names[panel.value.agent]
                      : "消息与任务记录"}
            </span>
            <button
              className="icon-button"
              aria-label="关闭详情"
              onClick={() => setDetail(null)}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className={`detail-body detail-${panel.kind}`}>
            {panel.kind === "message" && (
              <>
                <span className="eyebrow">
                  {panel.value.type === "result" ? "结果" : "请求"} ·{" "}
                  {new Date(panel.value.time).toLocaleString("zh-CN")}
                </span>
                <p className="message-original">
                  {output[panel.value.id] ?? panel.value.body}
                </p>
                <button
                  className="text-button"
                  onClick={() =>
                    void action(async () => {
                      const text = panel.value.full_ref
                        ? await api.request("readRef", {
                            path: panel.value.full_ref.path,
                          })
                        : panel.value.body;
                      await api.copy(text);
                    })
                  }
                >
                  复制原文 ↗
                </button>
                {cmds
                  .filter(
                    (cmd) =>
                      cmd.collab_id === detailRound.id &&
                      cmd.task_id === panel.value.task_id,
                  )
                  .map((cmd) => (
                    <div key={cmd.id} className="command-card">
                      <code>{cmd.command}</code>
                      <small>
                        {cmd.finished
                          ? `exit ${cmd.exit_code ?? "未提供"} · ${cmd.native_status || "已结算"}`
                          : "执行中"}
                        {cmd.finished
                          ? ""
                          : ` · 已运行 ${Math.max(0, Math.floor((time - Date.parse(cmd.started_at || cmd.time)) / 1000))} 秒`}
                      </small>
                      <pre>{output[cmd.id] || cmd.summary || "暂无输出"}</pre>
                      <button
                        className="text-button"
                        onClick={() => void read(cmd.output_ref, cmd.id)}
                      >
                        展开完整输出 ↗
                      </button>
                    </div>
                  ))}
                {!meta.replay &&
                  (commandPage.has_older || commandStack.length > 0) && (
                    <div className="history-page-controls">
                      <button
                        disabled={!commandPage.has_older}
                        onClick={() => {
                          setCommandStack([...commandStack, commandBefore]);
                          setCommandBefore(commandPage.oldest);
                        }}
                      >
                        更早命令
                      </button>
                      <button
                        disabled={!commandStack.length}
                        onClick={() => {
                          setCommandBefore(commandStack.at(-1));
                          setCommandStack(commandStack.slice(0, -1));
                        }}
                      >
                        较新命令
                      </button>
                    </div>
                  )}
                {detailRound.artifacts
                  .filter((a: any) => a.task_id === panel.value.task_id)
                  .map((a: any) => fileCard(a, detailRound))}
              </>
            )}
            {panel.kind === "artifact" && fileCard(panel.value)}
            {panel.kind === "handoff" && (
              <>
                <p>{panel.value.summary || "本轮交接"}</p>
                <button
                  className="text-button handoff-copy"
                  onClick={() => api.copy(output.handoff || "")}
                >
                  <Icon name="copy" />
                  复制交接
                </button>
                <pre>{output.handoff || "读取交接记录中…"}</pre>
              </>
            )}
            {panel.kind === "agent" && (
              <>
                <p>
                  {nodeStatus(c.participants[panel.value.agent] || panel.value)}
                </p>
                {c.participants[panel.value.agent] && (
                  <>
                    <small>CLI 会话</small>
                    <code className="session-id">
                      {c.participants[panel.value.agent].session_id ||
                        "尚未唤起"}
                    </code>
                    {c.participants[panel.value.agent].execution && (
                      <p>
                        模型设置：
                        {JSON.stringify(
                          c.participants[panel.value.agent].execution.applied,
                        )}
                      </p>
                    )}
                  </>
                )}
                {messages
                  .filter(
                    (m: any) =>
                      m.from === panel.value.agent ||
                      m.to === panel.value.agent,
                  )
                  .slice(-12)
                  .reverse()
                  .map((m: any) => (
                    <button
                      className="timeline-row"
                      key={m.id}
                      onClick={() => setDetail({ kind: "message", value: m })}
                    >
                      <b>
                        {m.from} → {m.to}
                      </b>
                      <span className="timeline-excerpt" title={m.body}>
                        {m.body}
                      </span>
                    </button>
                  ))}
              </>
            )}
            {panel.kind === "timeline" &&
              rounds.map((round, index) => {
                const entries =
                  round.id === c.id
                    ? messages
                    : model.messages.filter(
                        (m: any) => m.collab_id === round.id,
                      );
                return (
                  <details
                    className="timeline-round"
                    key={round.id}
                    open={index === 0}
                  >
                    <summary>
                      <Icon name="chevron" />
                      <span title={round.title}>{round.title}</span>
                      <small>
                        {index === 0 ? "本轮" : "历史轮次"} · {entries.length}{" "}
                        条
                      </small>
                    </summary>
                    <div className="timeline-track">
                      {entries.length === 0 &&
                        (round.id === c.id ? (
                          <p className="empty">此页没有消息</p>
                        ) : (
                          <button
                            className="text-button"
                            onClick={() => {
                              setSelected(round.id);
                              setDetail(null);
                            }}
                          >
                            按页查看此轮消息
                          </button>
                        ))}
                      {entries.map((m: any) => (
                        <TimelineMessage
                          key={m.id}
                          message={m}
                          icons={meta.icons}
                          fresh={fresh(m.id)}
                          pulse={
                            m.type === "result"
                              ? cue({ key: m.id, type: "done" })
                              : undefined
                          }
                          onDetails={() => {
                            setOutput({});
                            setDetail({ kind: "message", value: m });
                            void read(m.full_ref, m.id);
                          }}
                        />
                      ))}
                    </div>
                  </details>
                );
              })}
            {panel.kind === "timeline" && !meta.replay && (
              <div className="history-page-controls">
                <button
                  disabled={busy || !meta.history?.has_older}
                  onClick={() =>
                    void action(() =>
                      api.request("historyPage", { direction: "older" }),
                    )
                  }
                >
                  更早消息
                </button>
                <button
                  disabled={busy || !meta.history?.can_newer}
                  onClick={() =>
                    void action(() =>
                      api.request("historyPage", { direction: "newer" }),
                    )
                  }
                >
                  较新消息
                </button>
                <button
                  disabled={busy || !meta.history?.before}
                  onClick={() =>
                    void action(() =>
                      api.request("historyPage", { direction: "latest" }),
                    )
                  }
                >
                  回到最新
                </button>
                <small>每页最多 100 条，翻页替换当前页。</small>
              </div>
            )}
          </div>
        </aside>
      )}
      {error && (
        <div className="toast" role="alert">
          {error}
          <button aria-label="关闭错误" onClick={() => setError("")}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {stopDialog}
      {form && (
        <div className="scrim">
          <form
            className="dialog create-dialog"
            aria-labelledby="create-title"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            onKeyDown={(e) => {
              if (
                e.ctrlKey &&
                e.key === "Enter" &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (canSubmit && submit.current)
                  e.currentTarget.requestSubmit(submit.current);
              }
            }}
          >
            <span className="eyebrow" title={form.target?.title}>
              {form.target
                ? form.target.title
                : form.upstream
                  ? "从上一轮交接继续"
                  : "开启一轮新的协作"}
            </span>
            <h2 id="create-title">
              {form.target
                ? form.retry_task
                  ? "调整模型后重试"
                  : "追加任务"
                : form.upstream
                  ? "发起下一轮合作"
                  : "发起合作"}
            </h2>
            {form.target ? (
              <label>
                接收任务的 agent
                <select
                  value={form.to}
                  disabled={Boolean(form.retry_task)}
                  onChange={(e) => setForm({ ...form, to: e.target.value })}
                >
                  {workerKinds.map((k) => (
                    <option key={k} value={k}>
                      {names[k]}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                项目目录
                <input
                  required
                  className="path-input"
                  title={form.cwd}
                  value={form.cwd}
                  onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                  placeholder="E:\项目目录"
                />
              </label>
            )}
            <label>
              {form.target ? "任务说明" : "本轮目标"}
              <textarea
                required
                readOnly={Boolean(form.retry_task)}
                autoFocus
                value={form.goal}
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                placeholder="说明目标、约束与期望交付"
              />
            </label>
            {!form.target && (
              <fieldset className="participant-field">
                <legend>
                  参与者 <small>第一位负责接收目标</small>
                </legend>
                <div className="agent-options">
                  {workerKinds.map((k) => (
                    <div
                      className={`agent-option agent-${k}`}
                      key={k}
                      data-cli-missing={missingCli(k) || undefined}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={formAgents.includes(k)}
                          disabled={missingCli(k)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              agents: e.target.checked
                                ? [...form.agents, k]
                                : form.agents.filter((a: string) => a !== k),
                            })
                          }
                        />
                        <AgentAvatar
                          agent={k}
                          icons={meta.icons}
                          state={missingCli(k) ? "missing" : "idle"}
                        />
                        <span className="option-copy">
                          <strong title={names[k]}>{names[k]}</strong>
                          {showCapabilities &&
                            typeof capabilities?.[k]?.available ===
                              "boolean" && (
                              <small
                                className="option-availability"
                                data-available={capabilities[k].available}
                              >
                                {capabilities[k].available
                                  ? "已检测到 CLI"
                                  : "未检测到 CLI"}
                              </small>
                            )}
                        </span>
                      </label>
                      {formAgents[0] === k ? (
                        <span className="first-badge">首位</span>
                      ) : (
                        formAgents.includes(k) && (
                          <button
                            type="button"
                            className="first-action"
                            title={`设为首位 · ${names[k]}`}
                            aria-label={`将 ${names[k]} 设为首位`}
                            onClick={() =>
                              setForm({
                                ...form,
                                agents: [
                                  k,
                                  ...form.agents.filter(
                                    (agent: string) => agent !== k,
                                  ),
                                ],
                              })
                            }
                          >
                            设为首位
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
            )}
            <ExecutionSettings
              inherit={Boolean(form.target)}
              agents={form.target ? [form.to] : formAgents}
              cwd={form.cwd || c?.cwd}
              values={form.execution}
              onChange={(execution: any) => setForm({ ...form, execution })}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => setForm(null)}>
                返回
              </button>
              <kbd className="submit-shortcut">Ctrl + Enter</kbd>
              <button
                className="primary"
                ref={submit}
                aria-keyshortcuts="Control+Enter"
                disabled={!canSubmit}
                type="submit"
              >
                <Icon name="send" />
                {form.retry_task
                  ? "重试此任务"
                  : form.target
                    ? "派发任务"
                    : "创建并发送目标"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
function FileCard({ a, action, accepted, approve }: any) {
  return (
    <div className="file-card">
      <span className="eyebrow">
        {a.shared ? "已分享" : "尚未分享"} · 来源任务可追溯
      </span>
      <h3>{leaf(a.path)}</h3>
      <p>{a.summary}</p>
      <code>{a.path}</code>
      <small>SHA-256 · {a.sha256}</small>
      <small>来源任务 · {a.task_id}</small>
      {accepted && <small>此版本已验收</small>}
      <div>
        <button
          className="text-button"
          onClick={() => void action(() => api.openArtifact(a.event_id, false))}
        >
          打开文件 ↗
        </button>
        <button
          className="text-button"
          onClick={() => void action(() => api.openArtifact(a.event_id, true))}
        >
          所在目录 ↗
        </button>
        {approve && !accepted && (
          <button className="text-button" onClick={() => void approve()}>
            验收此文件
          </button>
        )}
      </div>
    </div>
  );
}
