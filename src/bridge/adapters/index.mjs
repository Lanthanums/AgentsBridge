import { discover } from "../discover.mjs";
import { verifiedCapabilities } from "../probed.mjs";
import { CodexAdapter } from "./codex.mjs";
import { DshAdapter } from "./dsh.mjs";
import { KimiAdapter } from "./kimi.mjs";
import { CursorAdapter } from "./cursor.mjs";
export function createAdapter(kind, options = {}) {
  const spec = (options.specs || discover())[kind];
  if (!spec?.available) throw new Error(`CLI_NOT_INSTALLED: ${kind}`);
  const Cls = {
    codex: CodexAdapter,
    dsh: DshAdapter,
    kimi: KimiAdapter,
    cursor: CursorAdapter,
  }[kind];
  if (!Cls) throw new Error(`CLI_NOT_PROBED: ${kind}`);
  const verified = verifiedCapabilities(kind, spec);
  if (!verified && !options.probe)
    throw new Error(
      `CLI_CAPABILITIES_CHANGED: ${kind}; run npm run verify:adapters -- ${kind}`,
    );
  const adapter = new Cls(spec, options);
  if (verified || options.probe) adapter.capabilities.probed = true;
  return adapter;
}
