import {
  ClientMsg, ServerMsg, Snapshot, PlayerView, Role, RoomStatus, ErrorCode, GameView, STAGE_NAMES, MAX_INTEGRITY,
  MAX_PLAYERS, cleanName, parseClientMsg,
} from "./protocol";
import { Game, newGame, submitCode, reveal, tick, STAGE_COUNT, STAGE_DURATIONS_MS, COUNTDOWN_MS, PAUSE_GRACE_MS, ActionResult } from "./game";
import { DOOR_RULES, runnerDoors } from "./stage1";

export interface PlayerState {
  id: string; tokenHash: string; name: string;
  ready: boolean; connected: boolean; lastSeen: number; role: Role | null;
}
export interface RoomState {
  code: string; status: RoomStatus; hostId: string | null;
  version: number; createdAt: number; players: PlayerState[]; game: Game | null;
}
export interface Host {
  send(connId: string, msg: ServerMsg): void;
  close(connId: string): void;
  persist(state: RoomState): void | Promise<void>;
  now(): number;
  random(): number;
  hash(token: string): Promise<string>;
}

export const LOBBY_GRACE_MS = 45_000;
export const IDLE_MS = 30 * 60_000;
const RATE_WINDOW_MS = 5_000;
const RATE_MAX = 40;
const LIVE: RoomStatus[] = ["countdown", "playing"];
const FINISHED: RoomStatus[] = ["won", "lost", "abandoned"];

/** Room engine: all rules live here and in game.ts; hosts only provide transport, storage and timers. */
export class RoomCore {
  state: RoomState;
  private conns = new Map<string, string | null>(); // connId -> playerId
  private rate = new Map<string, number[]>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private host: Host, state: RoomState) { this.state = state; }

  static create(host: Host, code: string): RoomCore {
    return new RoomCore(host, { code, status: "lobby", hostId: null, version: 0, createdAt: host.now(), players: [], game: null });
  }

  restoreConnection(connId: string, playerId: string | null) { this.conns.set(connId, playerId); }
  addConnection(connId: string) { this.conns.set(connId, null); }
  connectionCount() { return this.conns.size; }
  playerIdOf(connId: string): string | null { return this.conns.get(connId) ?? null; }

  handle(connId: string, raw: string): Promise<void> {
    this.chain = this.chain.then(() => this.process(connId, raw)).catch((e) => console.error("handle failed", e));
    return this.chain;
  }
  disconnect(connId: string): Promise<void> {
    this.chain = this.chain.then(() => this.onDisconnect(connId)).catch((e) => console.error("disconnect failed", e));
    return this.chain;
  }

  private err(connId: string, code: ErrorCode, message: string) { this.host.send(connId, { type: "error", code, message }); }
  private playerOf(connId: string) {
    const pid = this.conns.get(connId);
    return pid ? this.state.players.find((p) => p.id === pid) ?? null : null;
  }
  private rateOk(connId: string) {
    const now = this.host.now();
    const arr = (this.rate.get(connId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    arr.push(now); this.rate.set(connId, arr);
    return arr.length <= RATE_MAX;
  }

  private async process(connId: string, raw: string) {
    if (!this.conns.has(connId)) return;
    if (!this.rateOk(connId)) return this.err(connId, "RATE_LIMITED", "Too many messages. Slow down.");
    const msg = parseClientMsg(raw);
    if (!msg) return this.err(connId, "BAD_MESSAGE", "Message not understood.");
    if (msg.type === "join") return this.onJoin(connId, msg);
    const me = this.playerOf(connId);
    if (!me) return this.err(connId, "NOT_JOINED", "Join the room first.");
    me.lastSeen = this.host.now();
    switch (msg.type) {
      case "heartbeat": return this.host.send(connId, { type: "pong", serverNow: this.host.now() });
      case "ready":
        if (this.state.status !== "lobby") return this.err(connId, "BAD_STATE", "Game already started.");
        if (me.ready === msg.ready) return;
        me.ready = msg.ready; return this.commit();
      case "start": return this.onStart(connId, me);
      case "ack_briefing": return this.onAck(connId, me);
      case "act": return this.onAct(connId, me, msg);
      case "replay": return this.onReplay(connId, me);
      case "leave": return this.onLeave(connId, me);
    }
  }

  private async onJoin(connId: string, msg: Extract<ClientMsg, { type: "join" }>) {
    if (this.playerOf(connId)) return;
    const tokenHash = await this.host.hash(msg.token);
    const existing = this.state.players.find((p) => p.tokenHash === tokenHash);
    if (existing) {
      for (const [cid, pid] of this.conns) {
        if (pid === existing.id && cid !== connId) {
          this.conns.set(cid, null);
          this.err(cid, "REPLACED", "This seat was opened in another tab.");
          this.host.close(cid);
        }
      }
      this.conns.set(connId, existing.id);
      existing.connected = true; existing.lastSeen = this.host.now();
      return this.commit();
    }
    const name = cleanName(msg.name);
    if (!name) return this.err(connId, "NAME_INVALID", "Enter a name (1–16 characters).");
    if (this.state.status !== "lobby") return this.err(connId, "IN_PROGRESS", "This game already started.");
    if (this.state.players.length >= MAX_PLAYERS) return this.err(connId, "ROOM_FULL", "This room already has two players.");
    if (this.state.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return this.err(connId, "NAME_TAKEN", "Your partner already uses that name.");
    const id = "p" + Math.floor(this.host.random() * 1e9).toString(36) + this.state.players.length;
    this.state.players.push({ id, tokenHash, name, ready: false, connected: true, lastSeen: this.host.now(), role: null });
    if (!this.state.hostId) this.state.hostId = id;
    this.conns.set(connId, id);
    this.commit();
  }

  private beginGame(swapRoles: boolean) {
    const ps = this.state.players;
    if (swapRoles) ps.forEach((p) => (p.role = p.role === "runner" ? "decoder" : "runner"));
    else { const r = this.host.random() < 0.5 ? 0 : 1; ps[r].role = "runner"; ps[1 - r].role = "decoder"; }
    ps.forEach((p) => (p.ready = false));
    this.state.game = newGame(Math.floor(this.host.random() * 2 ** 32));
    this.state.status = "briefing";
  }

  private onStart(connId: string, me: PlayerState) {
    if (this.state.status !== "lobby") return this.err(connId, "BAD_STATE", "Game already started.");
    if (me.id !== this.state.hostId) return this.err(connId, "NOT_HOST", "Only the host can start.");
    const ps = this.state.players;
    if (ps.length < MAX_PLAYERS || !ps.every((p) => p.ready && p.connected))
      return this.err(connId, "NOT_READY", "Both players must be connected and ready.");
    this.beginGame(false);
    this.commit();
  }

  private onAck(connId: string, me: PlayerState) {
    if (this.state.status !== "briefing") return this.err(connId, "BAD_STATE", "Nothing to confirm right now.");
    if (me.ready) return;
    me.ready = true;
    this.commit();
  }

  private onAct(connId: string, me: PlayerState, msg: Extract<ClientMsg, { type: "act" }>) {
    const g = this.state.game;
    const reject = (message: string, door = msg.door) => this.host.send(connId, { type: "actionResult", actionId: msg.actionId, outcome: "rejected", door, message });
    if (this.state.status !== "playing" || !g) return reject("The game isn't running.");
    if (g.paused) return reject("Game paused while your partner reconnects.");
    if (me.role !== "runner") return reject("Only the Runner can act in the vault.");
    if (msg.stageIndex !== g.stageIndex) return reject("That action belongs to an earlier stage.");
    const now = this.host.now();
    if (tick(g, now)) { this.syncStatus(); return this.commit(); }
    const dup = g.seen[msg.actionId];
    const r: ActionResult = dup ?? (msg.action === "door_code"
      ? submitCode(g, now, msg.actionId, msg.door, msg.digits)
      : reveal(g, now, msg.actionId, msg.door, () => this.host.random()));
    this.host.send(connId, { type: "actionResult", actionId: msg.actionId, ...r });
    if (dup) return; // duplicate: replay the original answer, change nothing
    this.syncStatus();
    this.commit();
  }

  private onReplay(connId: string, me: PlayerState) {
    const g = this.state.game;
    if (!g || (this.state.status !== "won" && this.state.status !== "lost"))
      return this.err(connId, "BAD_STATE", "A replay is only possible after a finished game.");
    if (!g.replayVotes.includes(me.id)) g.replayVotes.push(me.id);
    const ps = this.state.players;
    if (ps.length === MAX_PLAYERS && ps.every((p) => g.replayVotes.includes(p.id) && p.connected)) this.beginGame(true);
    this.commit();
  }

  private onLeave(connId: string, me: PlayerState) {
    this.host.send(connId, { type: "left" });
    this.conns.set(connId, null);
    const st = this.state.status;
    if (st === "lobby" || FINISHED.includes(st)) {
      this.state.players = this.state.players.filter((p) => p.id !== me.id);
      if (st !== "lobby" && this.state.players.length < MAX_PLAYERS) this.resetToLobby();
      this.reassignHost();
    } else me.connected = false; // mid-game leave behaves like a disconnect (pause + grace)
    this.commit();
  }

  private resetToLobby() {
    this.state.status = "lobby"; this.state.game = null;
    this.state.players.forEach((p) => { p.role = null; p.ready = false; });
  }

  private onDisconnect(connId: string) {
    const pid = this.conns.get(connId);
    this.conns.delete(connId); this.rate.delete(connId);
    const p = pid ? this.state.players.find((x) => x.id === pid) : null;
    if (!p) return;
    if ([...this.conns.values()].includes(p.id)) return;
    p.connected = false; p.lastSeen = this.host.now();
    this.commit();
  }

  private reassignHost() {
    const next = this.state.players.find((p) => p.connected) ?? this.state.players[0];
    this.state.hostId = next ? next.id : null;
  }

  /** Mirrors a finished game's result onto the room status. */
  private syncStatus() {
    const g = this.state.game;
    if (g?.result) this.state.status = g.result.outcome;
  }

  /** Pauses the clock when someone drops mid-game and resumes (shifting every deadline) when all are back. */
  private reconcile() {
    const g = this.state.game, now = this.host.now();
    if (!g || !LIVE.includes(this.state.status)) return;
    const anyDown = this.state.players.some((p) => !p.connected);
    if (!g.paused && anyDown) g.paused = { at: now, until: now + PAUSE_GRACE_MS };
    else if (g.paused && !anyDown) {
      const d = now - g.paused.at;
      if (g.deadline) g.deadline += d;
      if (g.countdownEndsAt) g.countdownEndsAt += d;
      g.stage1.doors.forEach((door) => { if (door.lockedUntil) door.lockedUntil += d; });
      g.paused = null;
    }
    // Briefing is confirmed by both players: start the countdown once both are connected.
  }

  private maybeStartCountdown() {
    const ps = this.state.players, g = this.state.game;
    if (this.state.status === "briefing" && g && ps.length === MAX_PLAYERS && ps.every((p) => p.ready && p.connected)) {
      this.state.status = "countdown"; g.countdownEndsAt = this.host.now() + COUNTDOWN_MS;
    }
  }

  /**
   * Applies every time-based rule. Hosts call this after each message and on every timer/alarm.
   * Returns the next time (ms epoch) the host should call it again.
   */
  sweep(): number | null {
    const now = this.host.now();
    const s = this.state, g = s.game;
    let changed = false;
    if (s.status === "lobby") {
      const before = s.players.length;
      s.players = s.players.filter((p) => p.connected || now - p.lastSeen < LOBBY_GRACE_MS);
      if (s.players.length !== before) { this.reassignHost(); changed = true; }
    }
    if (g && !g.paused) {
      if (s.status === "countdown" && now >= g.countdownEndsAt) {
        s.status = "playing"; g.deadline = now + STAGE_DURATIONS_MS[g.stageIndex]; changed = true;
      } else if (s.status === "playing" && tick(g, now)) { this.syncStatus(); changed = true; }
    }
    if (g?.paused && now >= g.paused.until && LIVE.includes(s.status)) {
      g.result = { outcome: "abandoned", cause: "abandoned" }; g.paused = null; s.status = "abandoned"; changed = true;
    }
    if (changed) this.commit();

    const waits: number[] = [];
    if (s.status === "lobby") s.players.filter((p) => !p.connected).forEach((p) => waits.push(p.lastSeen + LOBBY_GRACE_MS));
    if (g?.paused && LIVE.includes(s.status)) waits.push(g.paused.until);
    else if (g && s.status === "countdown") waits.push(g.countdownEndsAt);
    else if (g && s.status === "playing") waits.push(g.deadline);
    const idle = Math.max(s.createdAt, ...s.players.map((p) => p.lastSeen)) + IDLE_MS;
    return waits.length ? Math.min(...waits) : idle;
  }

  isExpired(): boolean {
    if (this.conns.size > 0) return false;
    const last = Math.max(this.state.createdAt, ...this.state.players.map((p) => p.lastSeen));
    return this.host.now() - last >= IDLE_MS;
  }

  private commit() {
    this.reconcile();
    this.maybeStartCountdown();
    this.state.version++;
    void this.host.persist(this.state);
    for (const [cid, pid] of this.conns) if (pid) this.host.send(cid, this.snapshotFor(pid));
  }

  snapshotFor(playerId: string): Snapshot {
    const s = this.state;
    const players: PlayerView[] = s.players.map((p) => ({
      id: p.id, name: p.name, ready: p.ready, connected: p.connected, isHost: p.id === s.hostId, role: p.role,
    }));
    return { type: "snapshot", version: s.version, serverNow: this.host.now(), code: s.code, status: s.status, youId: playerId, players, game: this.gameView(playerId) };
  }

  /** Role projection: the ONLY place private puzzle data is turned into something sendable. */
  private gameView(playerId: string): GameView | null {
    const s = this.state, g = s.game;
    if (!g || s.status === "lobby") return null;
    const me = s.players.find((p) => p.id === playerId);
    const now = this.host.now();
    const view: GameView = {
      stageIndex: g.stageIndex, stageCount: STAGE_COUNT, stageName: STAGE_NAMES[g.stageIndex] ?? "",
      integrity: g.integrity, maxIntegrity: MAX_INTEGRITY, score: g.score,
      deadline: g.deadline, countdownEndsAt: g.countdownEndsAt,
      remainingMs: g.paused && g.deadline ? Math.max(0, g.deadline - g.paused.at) : null,
      pausedUntil: g.paused ? g.paused.until : null,
      doors: g.stage1.doors.map((d) => ({ id: d.id, status: d.status, lockedUntil: d.lockedUntil })),
      events: g.events, stageScores: g.stageScores,
      result: g.result, replay: { votes: g.replayVotes.length, youVoted: g.replayVotes.includes(playerId) },
    };
    if (s.status === "playing") {
      if (me?.role === "runner") view.runner = { doors: runnerDoors(g.stage1, now) };
      else if (me?.role === "decoder") view.decoder = {
        codex: g.stage1.codex,
        notes: (["plain", "mirror", "checksum"] as const).map((type) => ({ type, rule: DOOR_RULES[type] })),
      };
    }
    return view;
  }

  summary() {
    return { exists: true, status: this.state.status, players: this.state.players.length, full: this.state.players.length >= MAX_PLAYERS };
  }
}
