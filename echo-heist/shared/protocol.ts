// Wire protocol shared by client, Worker and Node test host.
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const ROOM_CODE_LENGTH = 5;
export const MAX_PLAYERS = 2;
export const MAX_NAME = 16;
export const MAX_MSG_BYTES = 2048;

export type Role = "runner" | "decoder";
export type RoomStatus = "lobby" | "briefing" | "countdown" | "playing" | "won" | "lost" | "abandoned";
export type DoorType = "plain" | "mirror" | "checksum";
export const STAGE_NAMES = ["GLYPH GATES"];
export const MAX_INTEGRITY = 5;
export const REVEAL_COST_MS = 20_000;

export type ErrorCode =
  | "ROOM_NOT_FOUND" | "ROOM_FULL" | "IN_PROGRESS" | "NAME_INVALID"
  | "NAME_TAKEN" | "NOT_JOINED" | "NOT_HOST" | "NOT_READY"
  | "BAD_STATE" | "BAD_MESSAGE" | "RATE_LIMITED" | "REPLACED";

export type Act =
  | { type: "act"; actionId: string; stageIndex: number; action: "door_code"; door: number; digits: number[] }
  | { type: "act"; actionId: string; stageIndex: number; action: "reveal"; door: number };

export type ClientMsg =
  | Act
  | { type: "ack_briefing" }
  | { type: "replay" }
  | { type: "join"; name: string; token: string }
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "leave" }
  | { type: "heartbeat" };

export interface PlayerView {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  role: Role | null;
}

export interface DoorShared { id: number; status: "locked" | "open"; lockedUntil: number }
export interface RunnerDoor extends DoorShared { sector: number; type: DoorType; glyphs: number[]; triesLeft: number; revealed: (number | null)[]; canReveal: boolean }
export interface CodexPage { sector: number; pairs: { glyph: number; digit: number }[] }
export interface GameEvent { seq: number; kind: "open" | "wrong" | "lockout" | "reveal"; door: number; text: string }
export interface StageScore { stage: number; base: number; timeBonus: number; flawless: number; total: number }
export interface GameView {
  stageIndex: number; stageCount: number; stageName: string;
  integrity: number; maxIntegrity: number; score: number;
  deadline: number; countdownEndsAt: number; remainingMs: number | null; pausedUntil: number | null;
  doors: DoorShared[];
  runner?: { doors: RunnerDoor[] };
  decoder?: { codex: CodexPage[]; notes: { type: DoorType; rule: string }[] };
  events: GameEvent[]; stageScores: StageScore[];
  result: { outcome: "won" | "lost" | "abandoned"; cause: "timeout" | "integrity" | "abandoned" | null } | null;
  replay: { votes: number; youVoted: boolean };
}
export type ActionOutcome = "open" | "wrong" | "lockout" | "revealed" | "rejected";

export interface Snapshot {
  type: "snapshot";
  version: number;
  serverNow: number;
  code: string;
  status: RoomStatus;
  youId: string;
  players: PlayerView[];
  game: GameView | null;
}

export type ServerMsg =
  | Snapshot
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "actionResult"; actionId: string; outcome: ActionOutcome; door: number; message: string }
  | { type: "pong"; serverNow: number }
  | { type: "left" };

const KNOWN = new Set(["join", "ready", "start", "leave", "heartbeat", "ack_briefing", "replay", "act"]);

/** Validates untrusted JSON from a socket. Returns null when invalid. */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > MAX_MSG_BYTES) return null;
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object" || !KNOWN.has(m.type)) return null;
  switch (m.type) {
    case "join":
      if (typeof m.name !== "string" || typeof m.token !== "string") return null;
      if (m.token.length < 16 || m.token.length > 64) return null;
      return { type: "join", name: m.name, token: m.token };
    case "ready":
      if (typeof m.ready !== "boolean") return null;
      return { type: "ready", ready: m.ready };
    case "act": {
      if (typeof m.actionId !== "string" || m.actionId.length < 8 || m.actionId.length > 40) return null;
      if (!Number.isInteger(m.stageIndex) || !Number.isInteger(m.door) || m.door < 0 || m.door > 2) return null;
      const base = { type: "act" as const, actionId: m.actionId, stageIndex: m.stageIndex, door: m.door };
      if (m.action === "reveal") return { ...base, action: "reveal" };
      if (m.action === "door_code") {
        if (!Array.isArray(m.digits) || m.digits.length !== 3 || !m.digits.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 9)) return null;
        return { ...base, action: "door_code", digits: m.digits };
      }
      return null;
    }
    default:
      return { type: m.type };
  }
}

export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
}
export function isValidCode(s: string): boolean {
  return s.length === ROOM_CODE_LENGTH && [...s].every((c) => ROOM_CODE_ALPHABET.includes(c));
}
export function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}
