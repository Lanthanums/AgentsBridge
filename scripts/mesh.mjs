import { ensureBridge, call, subscribe } from "../src/bridge/client.mjs";
const [method = "snapshot", json = "{}"] = process.argv.slice(2);
await ensureBridge();
if (method === "subscribe") {
  const p = JSON.parse(json);
  await subscribe(
    p.after || 0,
    (e) => process.stdout.write(JSON.stringify(e) + "\n"),
    p,
  );
} else
  console.log(JSON.stringify(await call(method, JSON.parse(json)), null, 2));
