import { describe, it, expect, afterEach } from "vitest";
import { startServer } from "../node-host/server";
import { Client, aid } from "./helpers";
import { solveDoor } from "../shared/stage1";
import type { Snapshot } from "../shared/protocol";

let t = 5_000_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function setup() {
  const srv = await startServer(0, { now: () => t });
  const base = `127.0.0.1:${srv.port}`;
  cleanups.push(() => srv.close());
  const { code } = (await (await fetch(`http://${base}/api/create`, { method: "POST" })).json()) as { code: string };
  const a = await new Client(base, code).open(); a.join("Ada"); await a.snap();
  const b = await new Client(base, code).open(); b.join("Bo"); await b.snap((s) => s.players.length === 2);
  cleanups.push(() => { a.close(); b.close(); });
  const core = () => srv.rooms.get(code)!.core;
  const advance = (ms: number) => { t += ms; core().sweep(); };
  const begin = async () => {
    a.send({ type: "ready", ready: true }); b.send({ type: "ready", ready: true });
    await a.snap((s) => s.players.every((p) => p.ready));
    a.send({ type: "start" });
    await a.snap((s) => s.status === "briefing"); await b.snap((s) => s.status === "briefing");
    a.send({ type: "ack_briefing" }); b.send({ type: "ack_briefing" });
    await a.snap((s) => s.status === "countdown"); await b.snap((s) => s.status === "countdown");
    advance(3000);
    const sa = await a.snap((s) => s.status === "playing"); await b.snap((s) => s.status === "playing");
    const runner = sa.players.find((p) => p.id === sa.youId)!.role === "runner" ? a : b;
    return { runner, decoder: runner === a ? b : a };
  };
  return { srv, base, code, a, b, core, advance, begin };
}
const wrongOf = (c: number[]) => c.map((d) => (d + 1) % 10);
/** Latest snapshot a client has, after letting messages flush. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("stage 1 multiplayer", () => {
  it("briefing and countdown reveal nothing private; roles get different private views", async () => {
    const { a, b, core, advance } = await setup();
    a.send({ type: "ready", ready: true }); b.send({ type: "ready", ready: true });
    await a.snap((s) => s.players.every((p) => p.ready)); a.send({ type: "start" });
    const brief = await b.snap((s) => s.status === "briefing");
    expect(JSON.stringify(brief)).not.toMatch(/codex|glyphs|notes/);
    a.send({ type: "ack_briefing" }); b.send({ type: "ack_briefing" });
    const cd = await a.snap((s) => s.status === "countdown");
    expect(cd.game!.runner ?? cd.game!.decoder).toBeUndefined(); // nothing private before play starts
    advance(3000);
    const sa = await a.snap((s) => s.status === "playing"); const sb = await b.snap((s) => s.status === "playing");
    const [runner, decoder] = sa.players.find((p) => p.id === sa.youId)!.role === "runner" ? [sa, sb] : [sb, sa];
    expect(runner.game!.runner).toBeTruthy(); expect(runner.game!.decoder).toBeUndefined();
    expect(decoder.game!.decoder).toBeTruthy(); expect(decoder.game!.runner).toBeUndefined();
    expect(core().state.game!.deadline).toBeGreaterThan(t);
  });

  it("PRIVACY: across every message received, the Runner never gets codex/rules and the Decoder never gets door glyphs, codes or reveals", async () => {
    const st = await setup(); const { runner, decoder } = await st.begin();
    const id = aid(); runner.send({ type: "act", actionId: id, stageIndex: 0, action: "reveal", door: 0 }); await runner.result(id);
    await settle();
    const parse = (c: Client) => c.all.map((x) => JSON.parse(x));
    for (const m of parse(decoder)) {
      if (m.type !== "snapshot" || !m.game) continue;
      expect(m.game.runner).toBeUndefined();
      for (const d of m.game.doors) expect(Object.keys(d).sort()).toEqual(["id", "lockedUntil", "status"]); // no glyphs/sector/type/code
    }
    for (const m of parse(runner)) {
      if (m.type !== "snapshot" || !m.game) continue;
      expect(m.game.decoder).toBeUndefined();
    }
    const rAll = runner.all.join("\n"), dAll = decoder.all.join("\n");
    expect(rAll).not.toMatch(/"codex"|"notes"|"digit"/);
    expect(dAll).not.toMatch(/"glyphs"|"revealed"|"triesLeft"|"canReveal"/);
    expect(rAll + dAll).not.toMatch(/"code":\[/); // door solutions never serialized
    expect(rAll + dAll).not.toMatch(/tokenHash/);
  });

  it("two players cooperate: Decoder solves from codex + Runner's description, Runner enters, both WIN with correct score", async () => {
    const { runner, decoder, advance, core } = await (async () => { const s = await setup(); const r = await s.begin(); return { ...r, ...s }; })();
    await settle();
    advance(10_000); // 10s of "talking"
    const rv = runner.last!.game!.runner!.doors, dv = decoder.last!.game!.decoder!;
    for (const door of rv) {
      const digits = solveDoor(dv.codex, door); // uses ONLY decoder codex + door info relayed by the runner
      const id = aid(); runner.send({ type: "act", actionId: id, stageIndex: 0, action: "door_code", door: door.id, digits });
      expect((await runner.result(id)).outcome).toBe("open");
    }
    const end = await decoder.snap((s) => s.status === "won");
    expect(end.game!.result).toEqual({ outcome: "won", cause: null });
    expect(end.game!.score).toBe(1000 + 140 * 5 + 250 + 5 * 150);
    expect(core().state.status).toBe("won");
  });

  it("wrong code -> warning, second -> lockout (-1 integrity); duplicates apply once; decoder & stale actions rejected", async () => {
    const { runner, decoder, advance, core } = await (async () => { const s = await setup(); const r = await s.begin(); return { ...r, ...s }; })();
    const secret = core().state.game!.stage1.doors[0].code;
    const id1 = aid();
    runner.send({ type: "act", actionId: id1, stageIndex: 0, action: "door_code", door: 0, digits: wrongOf(secret) });
    runner.send({ type: "act", actionId: id1, stageIndex: 0, action: "door_code", door: 0, digits: wrongOf(secret) }); // double tap
    expect((await runner.result(id1)).outcome).toBe("wrong");
    expect((await runner.result(id1)).outcome).toBe("wrong"); // replayed answer, not a second miss
    expect(core().state.game!.stage1.errors).toBe(1);
    const id2 = aid();
    runner.send({ type: "act", actionId: id2, stageIndex: 0, action: "door_code", door: 0, digits: wrongOf(secret) });
    expect((await runner.result(id2)).outcome).toBe("lockout");
    const s = await decoder.snap((x) => x.game?.integrity === 4);
    expect(s.game!.doors[0].lockedUntil).toBeGreaterThan(t);
    const id3 = aid();
    runner.send({ type: "act", actionId: id3, stageIndex: 0, action: "door_code", door: 0, digits: secret });
    expect((await runner.result(id3)).outcome).toBe("rejected"); // cooling
    advance(10_100);
    const id4 = aid();
    runner.send({ type: "act", actionId: id4, stageIndex: 0, action: "door_code", door: 0, digits: secret });
    expect((await runner.result(id4)).outcome).toBe("open");
    const id5 = aid(); decoder.send({ type: "act", actionId: id5, stageIndex: 0, action: "door_code", door: 1, digits: [0, 0, 0] });
    const r5 = await decoder.result(id5); expect(r5.outcome).toBe("rejected"); expect(r5.message).toMatch(/Only the Runner/);
    const id6 = aid(); runner.send({ type: "act", actionId: id6, stageIndex: 3, action: "door_code", door: 1, digits: [0, 0, 0] });
    expect((await runner.result(id6)).message).toMatch(/earlier stage/);
    runner.send({ type: "act", actionId: "x", stageIndex: 0, action: "door_code", door: 9, digits: [1, 2, 3] });
    await runner.err("BAD_MESSAGE");
  });

  it("brute-reveal: costs 20s, shows the digit only to the Runner, once per door", async () => {
    const { runner, decoder, core } = await (async () => { const s = await setup(); const r = await s.begin(); return { ...r, ...s }; })();
    const before = core().state.game!.deadline;
    const id = aid(); runner.send({ type: "act", actionId: id, stageIndex: 0, action: "reveal", door: 1 });
    const r = await runner.result(id); expect(r.outcome).toBe("revealed");
    expect(core().state.game!.deadline).toBe(before - 20_000);
    const rs = await runner.snap((s) => s.game?.runner?.doors[1].revealed.some((x) => x !== null) === true);
    const d = core().state.game!.stage1.doors[1];
    rs.game!.runner!.doors[1].revealed.forEach((x, i) => { if (x !== null) expect(x).toBe(d.code[i]); });
    await settle();
    expect(decoder.all.join("")).not.toContain('"revealed"');
    const id2 = aid(); runner.send({ type: "act", actionId: id2, stageIndex: 0, action: "reveal", door: 1 });
    expect((await runner.result(id2)).outcome).toBe("rejected");
  });

  it("LOSS by timeout and by integrity", async () => {
    const s1 = await setup(); await s1.begin();
    s1.advance(150_000);
    const lost = await s1.a.snap((x) => x.status === "lost");
    expect(lost.game!.result).toEqual({ outcome: "lost", cause: "timeout" });
    const s2 = await setup(); const { runner } = await s2.begin();
    const secret = s2.core().state.game!.stage1.doors[0].code;
    for (let i = 0; i < 5; i++) {
      for (let k = 0; k < 2; k++) { const id = aid(); runner.send({ type: "act", actionId: id, stageIndex: 0, action: "door_code", door: 0, digits: wrongOf(secret) }); await runner.result(id); }
      s2.advance(10_100);
    }
    const l2 = await runner.snap((x) => x.status === "lost");
    expect(l2.game!.result).toEqual({ outcome: "lost", cause: "integrity" });
    const late = aid(); runner.send({ type: "act", actionId: late, stageIndex: 0, action: "door_code", door: 1, digits: [0, 0, 0] });
    expect((await runner.result(late)).message).toMatch(/isn't running/);
  });

  it("disconnect pauses the clock; reconnect (same token) resumes with no time lost and the same private view", async () => {
    const s = await setup(); const { runner, decoder } = await s.begin();
    await settle();
    const remaining = s.core().state.game!.deadline - t;
    const viewBefore = JSON.stringify(runner.last!.game!.runner);
    runner.close();
    const paused = await decoder.snap((x) => x.game?.pausedUntil != null);
    expect(paused.game!.remainingMs).toBe(remaining);
    s.advance(40_000);
    const back = await new Client(s.base, s.code, runner.token).open(); back.join("whoever");
    cleanups.push(() => back.close());
    const resumed = await back.snap((x) => x.game?.pausedUntil === null);
    expect(resumed.game!.deadline - t).toBe(remaining);
    expect(JSON.stringify(resumed.game!.runner)).toBe(viewBefore);
    expect(resumed.status).toBe("playing");
  });

  it("an absent partner for 60s abandons the run", async () => {
    const s = await setup(); const { runner, decoder } = await s.begin();
    runner.close(); await decoder.snap((x) => x.game?.pausedUntil != null);
    s.advance(59_000); expect(s.core().state.status).toBe("playing");
    s.advance(1_500);
    const ab = await decoder.snap((x) => x.status === "abandoned");
    expect(ab.game!.result?.outcome).toBe("abandoned");
  });

  it("replay needs both votes, swaps roles and deals a fresh puzzle; leaving returns the partner to a lobby", async () => {
    const s = await setup(); const { runner, decoder } = await s.begin(); const advance = s.advance;
    advance(150_000); await runner.snap((x) => x.status === "lost");
    const oldSeed = s.core().state.game!.seed;
    runner.send({ type: "replay" });
    const one = await decoder.snap((x) => x.game?.replay.votes === 1);
    expect(one.status).toBe("lost");
    decoder.send({ type: "replay" });
    const again = await decoder.snap((x) => x.status === "briefing" && x.version > one.version);
    const rolesNow = Object.fromEntries(again.players.map((p) => [p.name, p.role]));
    const rolesThen = Object.fromEntries(one.players.map((p) => [p.name, p.role]));
    for (const n of Object.keys(rolesNow)) expect(rolesNow[n]).not.toBe(rolesThen[n]);
    expect(s.core().state.game!.seed).not.toBe(oldSeed);
    expect(again.game!.integrity).toBe(5);
    // finish this one quickly then leave
    s.a.send({ type: "ack_briefing" }); s.b.send({ type: "ack_briefing" });
    await s.a.snap((x) => x.status === "countdown"); advance(3000); await s.a.snap((x) => x.status === "playing");
    advance(150_000); await s.a.snap((x) => x.status === "lost");
    s.a.send({ type: "leave" }); await s.a.until((m) => m.type === "left");
    const lobby = await s.b.snap((x) => x.status === "lobby" && x.players.length === 1);
    expect(lobby.players).toHaveLength(1); expect(lobby.players[0].role).toBeNull(); expect(lobby.game).toBeNull();
  });
});
