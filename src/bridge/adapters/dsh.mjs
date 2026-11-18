import { AcpAdapter } from "./base.mjs";
export class DshAdapter extends AcpAdapter {
  constructor(spec) {
    super("dsh", spec, {
      persistent: true,
      interrupt: "protocol_and_tree",
      token_delta: false,
      usage: "context_only",
    });
  }
}
