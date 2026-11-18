import React, { useEffect, useState } from "react";
import { names } from "./model.mjs";
function AgentOptions({ agent, cwd, value, onChange, inherit }: any) {
  const [catalog, setCatalog] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setError("");
      window.bridge
        .request("modelOptions", {
          to: agent,
          cwd: cwd || undefined,
          model: value.model || undefined,
        })
        .then((result: any) => {
          if (!cancelled)
            setCatalog({ ...result, selected_model: value.model || "" });
        })
        .catch((e: any) => {
          if (!cancelled) setError(e.message);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agent, cwd, value.model]);
  const model = catalog?.models?.find((m: any) => m.id === value.model);
  const efforts = (model?.efforts || catalog?.efforts || []).map((e: any) =>
    typeof e === "string" ? { id: e, label: e } : e,
  );
  return (
    <div className="execution-agent">
      <strong>{names[agent]}</strong>
      <label>
        模型
        <select
          aria-label={`${names[agent]} 模型`}
          value={value.model || ""}
          onChange={(e) =>
            onChange(e.target.value ? { model: e.target.value } : {})
          }
        >
          <option value="">{inherit ? "沿用本轮配置" : "CLI 默认"}</option>
          {catalog?.models?.map((m: any) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {value.model && !model && (
            <option value={value.model}>{value.model}</option>
          )}
        </select>
      </label>
      <label>
        思考强度
        <select
          aria-label={`${names[agent]} 思考强度`}
          value={value.reasoning_effort || ""}
          disabled={
            !catalog ||
            catalog.selected_model !== (value.model || "") ||
            (agent === "cursor" && !value.model)
          }
          required={
            agent === "cursor" && Boolean(value.model) && !model?.native_id
          }
          onChange={(e) =>
            onChange(
              Object.fromEntries(
                Object.entries({
                  ...value,
                  reasoning_effort: e.target.value,
                }).filter(([, v]) => v),
              ),
            )
          }
        >
          <option value="">
            {agent === "cursor" && value.model && !model?.native_id
              ? "选择强度"
              : inherit
                ? "沿用本轮强度"
                : "CLI 默认"}
          </option>
          {efforts.map((e: any) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <small role="status">选项读取失败：{error}。可保留 CLI 默认。</small>
      ) : !catalog ? (
        <small>正在读取 CLI 选项…</small>
      ) : null}
    </div>
  );
}
export function ExecutionSettings({
  agents,
  cwd,
  values = {},
  onChange,
  inherit = false,
}: any) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="execution-settings"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>模型与思考强度</summary>
      <p>
        {inherit
          ? "未指定时沿用本轮已选配置；新 agent 使用 CLI 默认。"
          : "由发起者为每位 agent 选择；未指定时保留 CLI 默认。"}
        不修改全局配置。
      </p>
      {open &&
        agents.map((agent: string) => (
          <AgentOptions
            key={agent}
            agent={agent}
            cwd={cwd}
            value={values[agent] || {}}
            inherit={inherit}
            onChange={(value: any) => onChange({ ...values, [agent]: value })}
          />
        ))}
    </details>
  );
}
