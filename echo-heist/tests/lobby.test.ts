import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { startServer } from "../node-host/server";
import type { ServerMsg, Snapshot } from "../shared/protocol";

let srv: Awaited<ReturnType<typeof startServer>>;
let base: string;
const EXTERNAL = process.env.TEST_BASE; // e.g. 127.0.0.1:8788 to test the real Workers runtime
beforeAll(async () => { if (EXTERNAL) { base = EXTERNAL; return; } srv = await startServer(0); base = `127.0.0.1:${srv.port}`; });
afterAll(async () => { await srv?.close(); });

class Client {
  ws!: WebSocket; msgs: ServerMsg[] = [];
  constructor(public code: string, public token = crypto.randomUUID().replace(/-/g, "")) {}
  async open() {
    this.ws = new WebSocket(`ws://${base}/ws/${this.code}`);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString())));
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
      if (Date.now() - t0 > ms) throw new Error("timeout; got " + JSON.stringify(this.msgs));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  snap(pred: (s: Snapshot) => boolean = () => true) {
    return this.until<Snapshot>((m) => m.type === "snapshot" && pred(m as Snapshot));
  }
  err(code: string) { return this.until((m) => m.type === "error" && (m as any).code === code); }
  close() { this.ws.close(); }
}
const create = async () => ((await (await fetch(`http://${base}/api/create`, { method: "POST" })).json()) as { code: string }).code;

describe("lobby flow", () => {
  it("creates a room and reports it via the summary API", async () => {
    const code = await create();
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{5}$/);
    const s = await (await fetch(`http://${base}/api/room/${code}`)).json();
    expect(s).toMatchObject({ exists: true, status: "lobby", players: 0 });
    expect(await (await fetch(`http://${base}/api/room/ZZZZZ`)).json()).toEqual({ exists: false });
  });

  it("rejects sockets to unknown rooms", async () => {
    const c = await new Client("ZZZZZ").open();
    await c.err("ROOM_NOT_FOUND"); c.close();
  });

  it("two players join, ready up, host starts, roles differ", async () => {
    const code = await create();
    const a = await new Client(code).open(); a.join("Ada");
    const sa = await a.snap();
    expect(sa.players).toHaveLength(1); expect(sa.players[0].isHost).toBe(true);
    const b = await new Client(code).open(); b.join("Bo");
    const sb = await b.snap((s) => s.players.length === 2);
    expect(sb.players.find((p) => p.name === "Bo")!.isHost).toBe(false);
    await a.snap((s) => s.players.length === 2);

    a.send({ type: "start" }); await a.err("NOT_READY");
    b.send({ type: "start" }); await b.err("NOT_HOST");
    a.send({ type: "ready", ready: true }); b.send({ type: "ready", ready: true });
    await a.snap((s) => s.players.every((p) => p.ready));
    a.send({ type: "start" });
    const started = await b.snap((s) => s.status === "briefing");
    expect(started.players.map((p) => p.role).sort()).toEqual(["decoder", "runner"]);
    a.close(); b.close();
  });

  it("rejects a third player, taken names, bad names and late joiners", async () => {
    const code = await create();
    const a = await new Client(code).open(); a.join("Ada"); await a.snap();
    const dup = await new Client(code).open(); dup.join("ada"); await dup.err("NAME_TAKEN");
    const bad = await new Client(code).open(); bad.join("   "); await bad.err("NAME_INVALID");
    const b = await new Client(code).open(); b.join("Bo"); await b.snap();
    const c = await new Client(code).open(); c.join("Cy"); await c.err("ROOM_FULL");
    a.send({ type: "ready", ready: true }); b.send({ type: "ready", ready: true });
    await a.snap((s) => s.players.every((p) => p.ready));
    a.send({ type: "start" }); await a.snap((s) => s.status === "briefing");
    const late = await new Client(code).open(); late.join("Di"); await late.err("IN_PROGRESS");
    [a, b, dup, bad, c, late].forEach((x) => x.close());
  });

  it("unjoined sockets and malformed messages are rejected", async () => {
    const code = await create();
    const a = await new Client(code).open();
    a.send({ type: "ready", ready: true }); await a.err("NOT_JOINED");
    a.ws.send("not json"); await a.err("BAD_MESSAGE");
    a.send({ type: "join", name: "x", token: "short" }); await a.err("BAD_MESSAGE");
    a.close();
  });

  it("refresh reclaims the same seat with the same token; stale tab is replaced", async () => {
    const code = await create();
    const a = await new Client(code).open(); a.join("Ada"); await a.snap();
    const b = await new Client(code).open(); b.join("Bo"); const first = await b.snap((s) => s.players.length === 2);
    b.close();
    const seen = await a.snap((s) => s.players.some((p) => p.name === "Bo" && !p.connected));
    expect(seen.players).toHaveLength(2);
    const b2 = await new Client(code, b.token).open(); b2.join("whatever");
    const back = await b2.snap((s) => s.players.length === 2);
    expect(back.youId).toBe(first.youId);
    await a.snap((s) => s.players.every((p) => p.connected));
    // same token in a third tab kicks the second
    const b3 = await new Client(code, b.token).open(); b3.join("Bo");
    await b2.err("REPLACED");
    await b3.snap((s) => s.youId === first.youId);
    [a, b2, b3].forEach((x) => x.close());
  });

  it("a stranger cannot take a disconnected player's seat without the token", async () => {
    const code = await create();
    const a = await new Client(code).open(); a.join("Ada"); await a.snap();
    const b = await new Client(code).open(); b.join("Bo"); await b.snap(); b.close();
    await a.snap((s) => s.players.some((p) => !p.connected));
    const x = await new Client(code).open(); x.join("Mallory"); await x.err("ROOM_FULL");
    a.close(); x.close();
  });

  it("leave in lobby frees the seat and moves host; duplicate ready is idempotent", async () => {
    const code = await create();
    const a = await new Client(code).open(); a.join("Ada"); await a.snap();
    const b = await new Client(code).open(); b.join("Bo"); await b.snap();
    await a.snap((s) => s.players.length === 2);
    b.send({ type: "ready", ready: true }); b.send({ type: "ready", ready: true });
    await a.snap((s) => s.players.some((p) => p.ready));
    a.send({ type: "leave" }); await a.until((m) => m.type === "left");
    const after = await b.snap((s) => s.players.length === 1);
    expect(after.players[0]).toMatchObject({ name: "Bo", isHost: true });
    const c = await new Client(code).open(); c.join("Cy"); await c.snap((s) => s.players.length === 2);
    [a, b, c].forEach((x) => x.close());
  });

  it.skipIf(!!EXTERNAL)("lobby seats of long-disconnected players are freed by the sweep", async () => {
    let t = 1_000_000;
    const s2 = await startServer(0, { now: () => t });
    const b2 = `127.0.0.1:${s2.port}`;
    const { code } = (await (await fetch(`http://${b2}/api/create`, { method: "POST" })).json()) as { code: string };
    const mk = async (name: string) => {
      const ws = new WebSocket(`ws://${b2}/ws/${code}`); const msgs: any[] = [];
      ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ type: "join", name, token: name.repeat(20) }));
      return { ws, msgs };
    };
    const a = await mk("Ada"); await mk("Bo").then((b) => b.ws.close());
    await new Promise((r) => setTimeout(r, 100));
    t += 50_000; s2.rooms.get(code)!.core.sweep();
    await new Promise((r) => setTimeout(r, 100));
    expect(a.msgs.at(-1).players).toHaveLength(1);
    a.ws.close(); await s2.close();
  });
});
