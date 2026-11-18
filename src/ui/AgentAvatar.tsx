import React, { useRef } from "react";
import { names } from "./model.mjs";
import { avatarEffects, avatarStates } from "./avatar-state.mjs";
import { avatarArt, Wrench } from "./avatar-art";

const strokes: Record<string, string> = {
  disconnect: "M6 3v4m4-4v3M4 7h7v3m-6 0a3 3 0 0 0 3 3v3m4-8 5 5m0-5-5 5",
  plug: "M7 4v4m6-4v4M5 8h10v2a5 5 0 0 1-10 0Zm5 7v3",
  question: "M7 7a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01",
  thought: "M5 9a4 4 0 0 1 7-2 3 3 0 1 1 2 6H7a3 3 0 0 1-2-4Zm1 6h.01",
  work: "m11 4-6 7h5l-1 5 6-7h-5Z",
  waiting: "M4 10h.01m6 0h.01m6 0h.01M6 15h8",
  notice: "M10 5v6m0 4h.01",
  drop: "M10 4c-1 3-4 5-4 8a4 4 0 0 0 8 0c0-3-3-5-4-8Z",
  cross: "m6 6 8 8m0-8-8 8",
  pause: "M8 6v8m4-8v8",
  check: "m5 10 3 3 7-7",
  spark: "M10 4v12M4 10h12m-9-3 6 6m0-6-6 6",
};

function Badge({
  glyph,
  tone = "identity",
  effect = false,
}: {
  glyph: string;
  tone?: string;
  effect?: boolean;
}) {
  return (
    <span
      className={`avatar-bubble ${effect ? "avatar-pop" : ""}`}
      data-part="bubble-slot"
      data-glyph={glyph}
      data-tone={tone}
    >
      <svg
        viewBox={glyph === "missing-cli" ? "0 0 36 19" : "0 0 20 20"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {glyph === "missing-cli" ? (
          <g strokeWidth="1.3">
            <rect
              x="1"
              y="3"
              width="25"
              height="13"
              rx="4"
              fill="var(--surface-1)"
            />
            <text
              x="11.5"
              y="13"
              textAnchor="middle"
              fontFamily="var(--font-ui)"
              fontSize="10"
              fontWeight="700"
              fill="currentColor"
              stroke="none"
            >
              CLI
            </text>
            <g transform="rotate(16 28.5 9.5)">
              <circle cx="28.5" cy="9.5" r="6.5" fill="var(--surface-1)" />
              <path
                d={strokes.question}
                transform="translate(22.4 3.1) scale(.62)"
                strokeWidth="2.3"
              />
            </g>
          </g>
        ) : glyph === "dots" ? (
          [5, 10, 15].map((x, i) => (
            <circle
              key={x}
              className="avatar-dot"
              cx={x}
              cy="10"
              r="1.15"
              fill="currentColor"
              stroke="none"
              style={{ "--dot": i } as React.CSSProperties}
            />
          ))
        ) : glyph === "wrench" ? (
          <g transform="translate(4 5)" stroke="none">
            <Wrench />
          </g>
        ) : glyph === "stop" ? (
          <rect
            x="7"
            y="7"
            width="6"
            height="6"
            fill="currentColor"
            stroke="none"
          />
        ) : (
          <path d={strokes[glyph]} />
        )}
      </svg>
    </span>
  );
}

export function AgentAvatar({
  agent,
  state = "idle",
  size = "medium",
  pulse,
  phase = 0,
  icons,
  animate = true,
  frozen = false,
  facing,
}: {
  agent: string;
  state?: string;
  size?: "large" | "medium" | "micro";
  pulse?: { key: string; type: string; age?: number };
  phase?: number;
  icons?: Record<string, string>;
  animate?: boolean;
  frozen?: boolean;
  facing?: "left" | "right";
}) {
  const visual = avatarStates[state] || avatarStates.working;
  const effect = pulse && avatarEffects[pulse.type];
  const paused = frozen && Boolean(visual.loop || effect);
  const badge = paused ? avatarStates.paused : visual;
  const Art = avatarArt[agent];
  const name = names[agent] || agent;
  const offset = (agent.charCodeAt(0) * 13 + phase * 173) % 1400;
  const initialAge = useRef<{ key?: string; age: number }>({ age: 0 });
  if (initialAge.current.key !== pulse?.key)
    initialAge.current = { key: pulse?.key, age: pulse?.age || 0 };
  return (
    <span
      role="img"
      aria-label={`${name} · ${badge.label}`}
      className={`agent-icon agent-avatar agent-${agent}`}
      data-agent={agent}
      data-avatar-state={state}
      data-avatar-loop={animate ? visual.loop : undefined}
      data-avatar-effect={animate ? pulse?.type : undefined}
      data-avatar-muted={visual.muted || undefined}
      data-avatar-paused={paused || undefined}
      data-lod={size}
      data-facing={facing}
      style={
        {
          "--avatar-phase": `${-offset}ms`,
          "--avatar-age": `${-initialAge.current.age}ms`,
        } as React.CSSProperties
      }
    >
      {Art ? (
        <svg
          key={animate ? pulse?.key : undefined}
          className="avatar-art"
          viewBox="0 0 64 64"
          aria-hidden="true"
        >
          <Art state={state} />
        </svg>
      ) : icons?.[agent] ? (
        <img
          className="avatar-art"
          src={icons[agent]}
          alt=""
          draggable={false}
        />
      ) : (
        <span className="avatar-fallback" aria-hidden="true">
          {agent === "user" ? "人" : agent === "bridge" ? "桥" : name[0]}
        </span>
      )}
      <span className="avatar-badges" aria-hidden="true">
        {badge.badge && <Badge glyph={badge.badge} tone={badge.tone} />}
        {effect && animate && (
          <Badge
            key={pulse.key}
            glyph={effect.badge}
            tone={effect.tone}
            effect
          />
        )}
      </span>
    </span>
  );
}
