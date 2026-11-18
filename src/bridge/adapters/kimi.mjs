import { AcpAdapter } from "./base.mjs";
export class KimiAdapter extends AcpAdapter {
  constructor(spec) {
    super("kimi", spec, {
      persistent: true,
      interrupt: "protocol_and_tree",
      token_delta: true,
      usage: "context_only",
    });
  }
}
