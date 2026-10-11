// Pure game rules. The server calls these; nothing here knows about sockets or timers.
import type { ActionOutcome, GameEvent, StageScore } from "./protocol";
import { MAX_INTEGRITY, REVEAL_COST_MS } from "./protocol";
import { Stage1, generateStage1, mulberry32, WRONG_BEFORE_LOCK } from "./stage1";

export const STAGE_DURATIONS_MS = [150_000];
export const STAGE_COUNT = STAGE_DURATIONS_MS.length;
export const LOCK_MS = 10_000;
export const COUNTDOWN_MS = 3_000;
export const PAUSE_GRACE_MS = 60_000;
export const INTEGRITY_BONUS = 150;

export interface ActionResult { outcome: ActionOutcome; door: number; message: string }
export interface Game {
  seed: number; stageIndex: number; integrity: number; score: number;
  deadline: number; countdownEndsAt: number;
  paused: { at: number; until: number } | null;
  stage1: Stage1;
  seen: Record<string, ActionResult>; seenOrder: string[];
  events: GameEvent[]; seq: number; stageScores: StageScore[];
  result: { outcome: "won" | "lost" | "abandoned"; cause: "timeout" | "integrity" | "abandoned" | null } | null;
  replayVotes: string[];
}

export function newGame(seed: number): Game {
  return {
    seed, stageIndex: 0, integrity: MAX_INTEGRITY, score: 0, deadline: 0, countdownEndsAt: 0, paused: null,
    stage1: generateStage1(mulberry32(seed)), seen: {}, seenOrder: [], events: [], seq: 0, stageScores: [], result: null, replayVotes: [],
  };
}

const note = (g: Game, kind: GameEvent["kind"], door: number, text: string) => {
  g.events.push({ seq: ++g.seq, kind, door, text });
  if (g.events.length > 8) g.events.shift();
};
const rejected = (door: number, message: string): ActionResult => ({ outcome: "rejected", door, message });

function loseIntegrity(g: Game, n: number) {
  g.integrity = Math.max(0, g.integrity - n);
  if (g.integrity === 0 && !g.result) g.result = { outcome: "lost", cause: "integrity" };
}

function finishStage(g: Game, now: number) {
  const remainingSec = Math.max(0, Math.floor((g.deadline - now) / 1000));
  const base = 1000, timeBonus = remainingSec * 5, flawless = g.stage1.errors === 0 ? 250 : 0;
  const total = base + timeBonus + flawless;
  g.score += total;
  g.stageScores.push({ stage: g.stageIndex, base, timeBonus, flawless, total });
  if (g.stageIndex + 1 >= STAGE_COUNT) {
    g.score += g.integrity * INTEGRITY_BONUS;
    g.result = { outcome: "won", cause: null };
  }
  // M3: advance to the next stage here (integrity +1, new puzzle, new deadline).
}

/** Remembers a result so a retried/duplicated action gets the same answer and never applies twice. */
function remember(g: Game, actionId: string, r: ActionResult): ActionResult {
  g.seen[actionId] = r; g.seenOrder.push(actionId);
  if (g.seenOrder.length > 60) delete g.seen[g.seenOrder.shift()!];
  return r;
}

export function submitCode(g: Game, now: number, actionId: string, doorId: number, digits: number[]): ActionResult {
  if (g.seen[actionId]) return g.seen[actionId];
  const door = g.stage1.doors[doorId];
  if (!door) return rejected(doorId, "No such door.");
  if (door.status === "open") return remember(g, actionId, rejected(doorId, "That door is already open."));
  if (door.lockedUntil > now) return remember(g, actionId, rejected(doorId, "That door is cooling down."));
  const ok = digits.every((d, i) => d === door.code[i]);
  const n = doorId + 1;
  if (ok) {
    door.status = "open";
    note(g, "open", doorId, `Door ${n} breached.`);
    if (g.stage1.doors.every((d) => d.status === "open")) finishStage(g, now);
    return remember(g, actionId, { outcome: "open", door: doorId, message: `Door ${n} is open.` });
  }
  g.stage1.errors++;
  door.wrong++;
  if (door.wrong >= WRONG_BEFORE_LOCK) {
    door.wrong = 0; door.lockedUntil = now + LOCK_MS;
    loseIntegrity(g, 1);
    note(g, "lockout", doorId, `Door ${n} locked for ${LOCK_MS / 1000}s. Integrity −1.`);
    return remember(g, actionId, { outcome: "lockout", door: doorId, message: `Wrong again. Door ${n} is locked for ${LOCK_MS / 1000}s and Integrity dropped by 1.` });
  }
  note(g, "wrong", doorId, `Wrong code on door ${n}.`);
  return remember(g, actionId, { outcome: "wrong", door: doorId, message: `Wrong code. One more miss locks door ${n} and costs Integrity.` });
}

export function reveal(g: Game, now: number, actionId: string, doorId: number, rand: () => number): ActionResult {
  if (g.seen[actionId]) return g.seen[actionId];
  const door = g.stage1.doors[doorId];
  if (!door) return rejected(doorId, "No such door.");
  if (door.status === "open") return remember(g, actionId, rejected(doorId, "That door is already open."));
  if (door.lockedUntil > now) return remember(g, actionId, rejected(doorId, "That door is cooling down."));
  if (door.revealsUsed >= 1) return remember(g, actionId, rejected(doorId, "You already used the reveal on this door."));
  if (g.deadline - now <= REVEAL_COST_MS) return remember(g, actionId, rejected(doorId, "Not enough time left to pay for a reveal."));
  const open = [0, 1, 2].filter((i) => door.revealed[i] === null);
  const pos = open[Math.floor(rand() * open.length)];
  door.revealed[pos] = door.code[pos];
  door.revealsUsed++;
  g.deadline -= REVEAL_COST_MS;
  note(g, "reveal", doorId, `Runner paid ${REVEAL_COST_MS / 1000}s for a brute-reveal on door ${doorId + 1}.`);
  return remember(g, actionId, { outcome: "revealed", door: doorId, message: `Digit ${pos + 1} of door ${doorId + 1} is ${door.code[pos]}. That cost ${REVEAL_COST_MS / 1000}s.` });
}

/** Applies time-based rules. Returns true if anything changed. */
export function tick(g: Game, now: number): boolean {
  if (g.result || g.paused || g.deadline === 0) return false;
  if (now >= g.deadline) { g.result = { outcome: "lost", cause: "timeout" }; return true; }
  return false;
}
