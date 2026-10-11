import { DurableObject } from "cloudflare:workers";
import { RoomCore, RoomState, Host } from "../shared/room";
import { ServerMsg, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, MAX_MSG_BYTES, isValidCode, normalizeCode } from "../shared/protocol";
import { sha256Hex, randomCode } from "../shared/hash";

interface Env { ROOM: DurableObjectNamespace<Room>; ASSETS: Fetcher; }
type Attach = { connId: string; playerId: string | null };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/api/create" && req.method === "POST") {
      for (let i = 0; i < 5; i++) {
        const code = randomCode(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH);
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch(`https://room/init?code=${code}`, { method: "POST" });
        if (res.ok) return json({ code });
      }
      return json({ error: "Could not allocate a room. Try again." }, 503);
    }
    if (parts[0] === "api" && parts[1] === "room" && parts[2] && req.method === "GET") {
      const code = normalizeCode(parts[2]);
      if (!isValidCode(code)) return json({ exists: false });
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(`https://room/summary?code=${code}`);
    }
    if (parts[0] === "ws" && parts[1]) {
      const code = normalizeCode(parts[1]);
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "Expected WebSocket" }, 426);
      const origin = req.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return json({ error: "Bad origin" }, 403);
      if (!isValidCode(code)) return json({ error: "Invalid room code" }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(`https://room/ws?code=${code}`, req);
    }
    if (parts[0] === "api" || parts[0] === "ws") return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(req);
  },
};

export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private socketsById = new Map<string, WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomState>("state");
      if (saved) this.core = this.makeCore(saved);
    });
  }

  private host(): Host {
    return {
      send: (id, msg: ServerMsg) => { try { this.socketsById.get(id)?.send(JSON.stringify(msg)); } catch {} },
      close: (id) => { try { this.socketsById.get(id)?.close(4001, "replaced"); } catch {} },
      persist: (s) => this.ctx.storage.put("state", s),
      now: () => Date.now(),
      random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
      hash: sha256Hex,
    };
  }

  private makeCore(state: RoomState): RoomCore {
    const core = new RoomCore(this.host(), state);
    // Rebuild live connections after hibernation / restart.
    const live = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (!a) continue;
      this.socketsById.set(a.connId, ws);
      core.restoreConnection(a.connId, a.playerId);
      if (a.playerId) live.add(a.playerId);
    }
    for (const p of state.players) p.connected = live.has(p.id);
    return core;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get("code") ?? "";
    if (url.pathname === "/init") {
      if (this.core) return json({ error: "exists" }, 409);
      this.core = this.makeCore(RoomCore.create(this.host(), code).state);
      await this.ctx.storage.put("state", this.core.state);
      await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000); // unused rooms expire
      return json({ ok: true });
    }
    if (url.pathname === "/summary") return json(this.core ? this.core.summary() : { exists: false });
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      if (!this.core) {
        server.send(JSON.stringify({ type: "error", code: "ROOM_NOT_FOUND", message: "No room with that code." }));
        server.close(4004, "not found");
        return new Response(null, { status: 101, webSocket: client });
      }
      const connId = crypto.randomUUID();
      server.serializeAttachment({ connId, playerId: null } satisfies Attach);
      this.socketsById.set(connId, server);
      this.core.addConnection(connId);
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: "Not found" }, 404);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || !this.core) return;
    if (typeof data !== "string" || data.length > MAX_MSG_BYTES) return;
    await this.core.handle(a.connId, data);
    const pid = this.playerIdFor(a.connId);
    if (pid !== a.playerId) ws.serializeAttachment({ connId: a.connId, playerId: pid } satisfies Attach);
    await this.schedule();
  }

  async webSocketClose(ws: WebSocket) { await this.dropped(ws); }
  async webSocketError(ws: WebSocket) { await this.dropped(ws); }

  private async dropped(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || !this.core) return;
    this.socketsById.delete(a.connId);
    await this.core.disconnect(a.connId);
    await this.schedule();
  }

  private playerIdFor(connId: string): string | null {
    return this.core?.playerIdOf(connId) ?? null;
  }

  private async schedule() {
    if (!this.core) return;
    const next = this.core.sweep();
    if (this.core.isExpired()) { await this.ctx.storage.deleteAll(); this.core = null; return; }
    if (next) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 20));
  }

  async alarm() { await this.schedule(); }
}
