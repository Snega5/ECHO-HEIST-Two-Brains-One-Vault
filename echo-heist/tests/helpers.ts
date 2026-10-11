import WebSocket from "ws";
import type { ServerMsg, Snapshot } from "../shared/protocol";

export class Client {
  ws!: WebSocket; msgs: ServerMsg[] = []; all: string[] = []; last: Snapshot | null = null;
  constructor(public base: string, public code: string, public token = crypto.randomUUID().replace(/-/g, "")) {}
  async open() {
    this.ws = new WebSocket(`ws://${this.base}/ws/${this.code}`);
    this.ws.on("message", (d) => { const raw = d.toString(); this.all.push(raw); const m = JSON.parse(raw) as ServerMsg; this.msgs.push(m); if (m.type === "snapshot") this.last = m; });
    await new Promise<void>((r, j) => { this.ws.on("open", () => r()); this.ws.on("error", j); });
    return this;
  }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  join(name: string) { this.send({ type: "join", name, token: this.token }); }
  async until<T extends ServerMsg = ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 1500): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const i = this.msgs.findIndex(pred);
      if (i >= 0) return this.msgs.splice(i, 1)[0] as T;
      if (Date.now() - t0 > ms) throw new Error("timeout; got " + JSON.stringify(this.msgs.slice(-3)));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  snap(pred: (s: Snapshot) => boolean = () => true) { return this.until<Snapshot>((m) => m.type === "snapshot" && pred(m as Snapshot)); }
  err(code: string) { return this.until((m) => m.type === "error" && (m as any).code === code); }
  result(actionId: string) { return this.until<Extract<ServerMsg, { type: "actionResult" }>>((m) => m.type === "actionResult" && m.actionId === actionId); }
  close() { this.ws.close(); }
}
let n = 0;
export const aid = () => `act-${Date.now()}-${n++}-xxxx`;
