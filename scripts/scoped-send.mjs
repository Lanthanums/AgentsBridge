// Minimal non-MCP fallback for every CLI. Capability remains in inherited env, never prompt/argv.
const [to, body] = process.argv.slice(2);
if (!process.env.AGENTSBRIDGE_URL || !process.env.AGENTSBRIDGE_TOKEN)
  throw new Error("Run inside a managed AgentsBridge CLI session");
const r = await fetch(process.env.AGENTSBRIDGE_URL + "/rpc", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.AGENTSBRIDGE_TOKEN}` },
  body: JSON.stringify({
    method: "send",
    params: { to, body, id: crypto.randomUUID() },
  }),
});
const result = await r.json();
if (result.error) throw new Error(result.error);
console.log(JSON.stringify(result.result));
