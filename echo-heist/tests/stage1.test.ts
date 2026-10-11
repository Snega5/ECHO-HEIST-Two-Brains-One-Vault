import { describe, it, expect } from "vitest";
import { generateStage1, mulberry32, solveDoor } from "../shared/stage1";
import { newGame, submitCode, reveal, tick } from "../shared/game";

describe("stage 1 generator", () => {
  it("is deterministic per seed and always produces consistent, solvable, unambiguous doors", () => {
    expect(JSON.stringify(generateStage1(mulberry32(42)))).toBe(JSON.stringify(generateStage1(mulberry32(42))));
    for (let seed = 0; seed < 500; seed++) {
      const s = generateStage1(mulberry32(seed));
      expect(new Set(s.doors.map((d) => d.type)).size).toBe(3);
      expect(new Set(s.doors.map((d) => d.sector)).size).toBe(3);
      for (const page of s.codex) {
        expect(new Set(page.pairs.map((p) => p.glyph)).size).toBe(6);
        expect(new Set(page.pairs.map((p) => p.digit)).size).toBe(6);
      }
      for (const d of s.doors) {
        expect(d.code).toHaveLength(3);
        expect(new Set(d.glyphs).size).toBe(d.glyphs.length);
        expect(d.glyphs).toHaveLength(d.type === "checksum" ? 2 : 3);
        expect(solveDoor(s.codex, d)).toEqual(d.code); // what the players can derive == server truth
        if (d.type === "mirror") expect(d.code).not.toEqual([...d.code].reverse());
        if (d.type === "checksum") expect(d.code[2]).toBe((d.code[0] + d.code[1]) % 10);
      }
    }
  });
});

describe("game rules", () => {
  const wrong = (c: number[]) => c.map((d) => (d + 1) % 10);
  it("lockout after two misses costs 1 integrity; retries during cooldown are rejected", () => {
    const g = newGame(7); g.deadline = 1_000_000;
    const c = g.stage1.doors[0].code;
    expect(submitCode(g, 0, "aaaaaaaa", 0, wrong(c)).outcome).toBe("wrong");
    expect(g.integrity).toBe(5);
    expect(submitCode(g, 0, "aaaaaaab", 0, wrong(c)).outcome).toBe("lockout");
    expect(g.integrity).toBe(4);
    expect(submitCode(g, 1000, "aaaaaaac", 0, c).outcome).toBe("rejected");
    expect(submitCode(g, 10_001, "aaaaaaad", 0, c).outcome).toBe("open");
  });
  it("duplicate action ids never apply twice", () => {
    const g = newGame(7); g.deadline = 1_000_000;
    const c = g.stage1.doors[0].code;
    const a = submitCode(g, 0, "dupdupdup", 0, wrong(c));
    const b = submitCode(g, 0, "dupdupdup", 0, wrong(c));
    expect(b).toEqual(a); expect(g.stage1.errors).toBe(1); expect(g.stage1.doors[0].wrong).toBe(1);
  });
  it("reveal costs 20s, works once per door and never at the very end", () => {
    const g = newGame(3); g.deadline = 100_000;
    const r = reveal(g, 0, "revealaaaa", 0, () => 0);
    expect(r.outcome).toBe("revealed"); expect(g.deadline).toBe(80_000);
    expect(g.stage1.doors[0].revealed.filter((x) => x !== null)).toHaveLength(1);
    expect(reveal(g, 0, "revealbbbb", 0, () => 0).outcome).toBe("rejected");
    g.deadline = 15_000;
    expect(reveal(g, 0, "revealcccc", 1, () => 0).outcome).toBe("rejected");
  });
  it("wins with the right score and loses on timeout / integrity", () => {
    const g = newGame(11); g.deadline = 150_000;
    g.stage1.doors.forEach((d, i) => submitCode(g, 50_000, "open" + i + "xxxxx", i, d.code));
    expect(g.result).toEqual({ outcome: "won", cause: null });
    expect(g.score).toBe(1000 + 100 * 5 + 250 + 5 * 150);
    const t = newGame(11); t.deadline = 1000; expect(tick(t, 1000)).toBe(true); expect(t.result?.cause).toBe("timeout");
    const l = newGame(11); l.deadline = 1e9;
    for (let i = 0; i < 5; i++) { const c = l.stage1.doors[0].code; submitCode(l, i * 20_000, `l${i}aaaaaaa`, 0, wrong(c)); submitCode(l, i * 20_000, `l${i}bbbbbbb`, 0, wrong(c)); }
    expect(l.result).toEqual({ outcome: "lost", cause: "integrity" });
  });
  it("flawless bonus disappears after any mistake", () => {
    const g = newGame(5); g.deadline = 150_000;
    submitCode(g, 0, "missaaaaaa", 0, wrong(g.stage1.doors[0].code));
    g.stage1.doors.forEach((d, i) => submitCode(g, 0, "fin" + i + "xxxxxx", i, d.code));
    expect(g.stageScores[0].flawless).toBe(0);
  });
});
