// Stage 1: GLYPH GATES. Pure generator + role views. No transport, no clocks.
import type { CodexPage, DoorType, RunnerDoor } from "./protocol";

export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const GLYPH_COUNT = 10;
export const SECTOR_NAMES = ["ALPHA", "BETA", "GAMMA"];
export const DOOR_COUNT = 3;
export const WRONG_BEFORE_LOCK = 2;

export interface Door {
  id: number; sector: number; type: DoorType; glyphs: number[];
  code: number[];                 // SERVER SECRET: what the keypad must receive
  status: "locked" | "open"; lockedUntil: number; wrong: number;
  revealed: (number | null)[]; revealsUsed: number;
}
export interface Stage1 { codex: CodexPage[]; doors: Door[]; errors: number }

export const DOOR_RULES: Record<DoorType, string> = {
  plain: "PLAIN door: look up each glyph, then enter the digits in the order shown, left to right.",
  mirror: "MIRROR door: look up each glyph, then enter the digits right to left (reverse the order).",
  checksum: "CHECKSUM door: two glyphs give digits 1 and 2. Digit 3 is their sum, keeping only the last digit (7 + 8 = 15, so enter 5).",
};

export function generateStage1(rng: Rng): Stage1 {
  const glyphIds = Array.from({ length: GLYPH_COUNT }, (_, i) => i);
  const codex: CodexPage[] = SECTOR_NAMES.map((_, sector) => {
    const gs = shuffle(glyphIds, rng).slice(0, 6);
    const ds = shuffle(Array.from({ length: 10 }, (_, i) => i), rng).slice(0, 6);
    return { sector, pairs: gs.map((glyph, i) => ({ glyph, digit: ds[i] })) };
  });
  const types = shuffle<DoorType>(["plain", "mirror", "checksum"], rng);
  const sectors = shuffle([0, 1, 2], rng);
  const doors: Door[] = types.map((type, id) => {
    const page = codex[sectors[id]];
    const picked = shuffle(page.pairs, rng).slice(0, type === "checksum" ? 2 : 3);
    const digits = picked.map((p) => p.digit);
    const code = type === "plain" ? digits : type === "mirror" ? digits.slice().reverse() : [digits[0], digits[1], (digits[0] + digits[1]) % 10];
    return { id, sector: sectors[id], type, glyphs: picked.map((p) => p.glyph), code, status: "locked", lockedUntil: 0, wrong: 0, revealed: [null, null, null], revealsUsed: 0 };
  });
  return { codex, doors, errors: 0 };
}

/** Reference solver used by tests: derives the code from what each player legitimately sees. */
export function solveDoor(codex: CodexPage[], door: { sector: number; type: DoorType; glyphs: number[] }): number[] {
  const map = new Map(codex[door.sector].pairs.map((p) => [p.glyph, p.digit]));
  const d = door.glyphs.map((g) => map.get(g)!);
  if (door.type === "plain") return d;
  if (door.type === "mirror") return d.slice().reverse();
  return [d[0], d[1], (d[0] + d[1]) % 10];
}

export function runnerDoors(s: Stage1, now: number): RunnerDoor[] {
  return s.doors.map((d) => ({
    id: d.id, status: d.status, lockedUntil: d.lockedUntil, sector: d.sector, type: d.type, glyphs: d.glyphs,
    triesLeft: WRONG_BEFORE_LOCK - d.wrong, revealed: d.revealed,
    canReveal: d.status === "open" ? false : d.revealsUsed < 1 && d.lockedUntil <= now,
  }));
}
