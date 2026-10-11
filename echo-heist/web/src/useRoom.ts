import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMsg, ErrorCode, ServerMsg, Snapshot } from "../../shared/protocol";

export type ActionResultMsg = Extract<ServerMsg, { type: "actionResult" }>;
export const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export type Conn = "connecting" | "online" | "reconnecting" | "failed";
export interface Fatal { code: ErrorCode | "UNREACHABLE"; message: string }

const FATAL: ErrorCode[] = ["ROOM_NOT_FOUND", "ROOM_FULL", "IN_PROGRESS", "NAME_INVALID", "NAME_TAKEN", "REPLACED"];

export function getToken(code: string): string {
  const k = `eh:token:${code}`;
  let t = sessionStorage.getItem(k);
  if (!t) {
    t = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem(k, t);
  }
  return t;
}

export function useRoom(code: string, name: string) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [offset, setOffset] = useState(0); // serverNow - clientNow
  const [result, setResult] = useState<ActionResultMsg | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    let attempt = 0, retry: number | undefined, hb: number | undefined, lastPong = Date.now(), pingAt = 0;

    const lost = (ws: WebSocket) => {
      // Called for close events AND for dead-connection detection (missed heartbeats / browser offline).
      if (wsRef.current !== ws) return;
      ws.onopen = ws.onmessage = ws.onclose = null;
      try { ws.close(); } catch {}
      window.clearInterval(hb);
      if (stop.current) return;
      attempt++;
      setConn("reconnecting");
      if (attempt > 12) { setFatal({ code: "UNREACHABLE", message: "Can't reach the server. Check your connection and try again." }); setConn("failed"); return; }
      retry = window.setTimeout(open, Math.min(500 * 2 ** (attempt - 1), 8000));
    };

    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0; lastPong = Date.now(); pingAt = 0;
        ws.send(JSON.stringify({ type: "join", name, token: getToken(code) } satisfies ClientMsg));
        window.clearInterval(hb);
        hb = window.setInterval(() => {
          if (Date.now() - lastPong > 25_000) { lost(ws); return; }
          pingAt = Date.now(); ws.send(JSON.stringify({ type: "heartbeat" }));
        }, 8_000);
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data) as ServerMsg;
        lastPong = Date.now();
        if (m.type === "snapshot") {
          setOffset(m.serverNow - Date.now());
          setSnap((prev) => (prev && m.version < prev.version && prev.code === m.code ? prev : m));
          setConn("online"); setFatal(null);
        } else if (m.type === "actionResult") { setResult(m);
        } else if (m.type === "pong") { if (pingAt) setLatency(Date.now() - pingAt); }
        else if (m.type === "error") {
          if (FATAL.includes(m.code)) { stop.current = true; setFatal({ code: m.code, message: m.message }); setConn("failed"); }
          else { setToast(m.message); window.setTimeout(() => setToast(null), 3500); }
        } else if (m.type === "left") { stop.current = true; }
      };
      ws.onclose = () => lost(ws);
    };
    open();
    const onOffline = () => { const ws = wsRef.current; if (ws) lost(ws); };
    const onOnline = () => { if (!stop.current && wsRef.current?.readyState !== WebSocket.OPEN) { window.clearTimeout(retry); attempt = 0; open(); } };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      stop.current = true; window.clearTimeout(retry); window.clearInterval(hb);
      window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline);
      const w = wsRef.current; if (w) { w.onclose = null; w.close(); }
    };
  }, [code, name]);

  const send = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    else { setToast("Not connected yet. Try again in a moment."); window.setTimeout(() => setToast(null), 3000); }
  }, []);

  const leave = useCallback(() => { send({ type: "leave" }); sessionStorage.removeItem(`eh:token:${code}`); }, [send, code]);
  return { snap, conn, fatal, toast, latency, send, leave, offset, result };
}
