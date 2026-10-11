// Local host running the SAME RoomCore as the Cloudflare Durable Object.
// Used for development and automated two-client tests.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { RoomCore, Host } from "../shared/room";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, MAX_MSG_BYTES, isValidCode, normalizeCode } from "../shared/protocol";
import { sha256Hex, randomCode } from "../shared/hash";

export function startServer(port = 8787, opts: { staticDir?: string; now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const rooms = new Map<string, { core: RoomCore; timer?: NodeJS.Timeout }>();
  const sockets = new Map<string, WebSocket>();

  const makeHost = (): Host => ({
    send: (id, msg) => { const s = sockets.get(id); if (s?.readyState === 1) s.send(JSON.stringify(msg)); },
    close: (id) => sockets.get(id)?.close(4001, "replaced"),
    persist: () => {},
    now,
    random: () => Math.random(),
    hash: sha256Hex,
  });

  const reschedule = (code: string) => {
    const r = rooms.get(code); if (!r) return;
    clearTimeout(r.timer);
    const next = r.core.sweep();
    if (r.core.isExpired()) { rooms.delete(code); return; }
    if (next) r.timer = setTimeout(() => reschedule(code), Math.max(next - now(), 20)).unref();
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/create" && req.method === "POST") {
      let code = "";
      do { code = randomCode(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH); } while (rooms.has(code));
      rooms.set(code, { core: RoomCore.create(makeHost(), code) });
      reschedule(code);
      return send(res, 200, { code });
    }
    if (parts[0] === "api" && parts[1] === "room" && parts[2]) {
      const code = normalizeCode(parts[2]);
      const r = isValidCode(code) ? rooms.get(code) : undefined;
      return send(res, 200, r ? r.core.summary() : { exists: false });
    }
    if (parts[0] === "api" || parts[0] === "ws") return send(res, 404, { error: "Not found" });
    if (opts.staticDir) {
      let f = path.join(opts.staticDir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(opts.staticDir, "index.html");
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" });
      return fs.createReadStream(f).pipe(res);
    }
    send(res, 404, { error: "Not found" });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const origin = req.headers.origin;
    if (parts[0] !== "ws" || !parts[1] || (origin && new URL(origin).host !== req.headers.host && !process.env.ALLOW_ANY_ORIGIN)) {
      socket.destroy(); return;
    }
    const code = normalizeCode(parts[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = isValidCode(code) ? rooms.get(code) : undefined;
      if (!room) {
        ws.send(JSON.stringify({ type: "error", code: "ROOM_NOT_FOUND", message: "No room with that code." }));
        ws.close(4004, "not found"); return;
      }
      const connId = randomUUID();
      sockets.set(connId, ws);
      room.core.addConnection(connId);
      ws.on("message", async (data) => {
        await room.core.handle(connId, data.toString());
        reschedule(code);
      });
      ws.on("close", async () => {
        sockets.delete(connId);
        await room.core.disconnect(connId);
        reschedule(code);
      });
    });
  });

  return new Promise<{ port: number; close: () => Promise<void>; rooms: typeof rooms }>((resolve) => {
    server.listen(port, () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port, rooms,
        close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1]?.endsWith("server.ts")) {
  const dist = path.resolve("dist");
  startServer(Number(process.env.PORT ?? 8787), { staticDir: fs.existsSync(dist) ? dist : undefined })
    .then((s) => console.log(`Echo Heist local host on http://localhost:${s.port}`));
}
