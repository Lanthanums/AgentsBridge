import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentAvatar } from "./AgentAvatar";
import { avatarAgents, avatarStates } from "./avatar-state.mjs";
import { names } from "./model.mjs";
import "./tokens.css";
import "./avatar.css";
import "./avatar-preview.css";

const sizes = ["large", "medium", "micro"] as const;
const labels = ["节点 · 48 px", "头像 · 32 px", "悬浮球 · 24 px"];
const initial = new URLSearchParams(location.search);
const previewStates = Object.keys(avatarStates).filter((s) => s !== "external");
const agents = avatarAgents.filter(
  (agent) => !initial.has("agent") || initial.get("agent") === agent,
);

function Preview() {
  const requested = initial.get("state");
  const [state, setState] = useState(
    requested && previewStates.includes(requested) ? requested : "thinking",
  );
  const [speed, setSpeed] = useState(
    initial.get("speed") === "0.25" ? 0.25 : 1,
  );
  const [all, setAll] = useState(initial.has("matrix"));
  const [visible, setVisible] = useState(!document.hidden);
  const [take, setTake] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return (
    <main
      data-avatar-frozen={!visible || paused || undefined}
      style={{ "--avatar-rate": speed } as React.CSSProperties}
    >
      <header>
        <p>AGENTSBRIDGE / MOTION LAB</p>
        <h1>Agent 状态动效预览</h1>
        <div className="preview-controls">
          <label>
            状态{" "}
            <select
              aria-label="状态"
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setTake(take + 1);
              }}
            >
              {previewStates.map((key) => (
                <option key={key} value={key}>
                  {avatarStates[key].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            速度{" "}
            <select
              aria-label="速度"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              <option value={1}>1×</option>
              <option value={0.25}>0.25×</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
            />
            全状态矩阵
          </label>
          <button onClick={() => setTake(take + 1)}>重播一次性动效</button>
          <button onClick={() => setPaused(!paused)}>
            {paused ? "继续" : "定格"}
          </button>
        </div>
      </header>
      <div className="preview-matrix">
        {(all ? previewStates : [state]).map((key) => {
          const effect = avatarStates[key].effect;
          return (
            <section key={key} data-preview-state={key}>
              <h2>{avatarStates[key].label}</h2>
              <div className="preview-grid">
                <span />
                {labels.map((label) => (
                  <b key={label}>{label}</b>
                ))}
                {agents.map((agent) => (
                  <React.Fragment key={agent}>
                    <strong>{names[agent]}</strong>
                    {sizes.map((size, phase) => (
                      <div className="preview-cell" key={size}>
                        <AgentAvatar
                          agent={agent}
                          state={key}
                          size={size}
                          phase={phase}
                          animate={!all || key === state}
                          frozen={paused && (!all || key === state)}
                          pulse={
                            effect
                              ? { key: `${key}-${take}`, type: effect }
                              : undefined
                          }
                        />
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
