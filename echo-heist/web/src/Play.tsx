import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMsg, GameView, PlayerView, Role, RunnerDoor, Snapshot } from "../../shared/protocol";
import { REVEAL_COST_MS } from "../../shared/protocol";
import { SECTOR_NAMES } from "../../shared/stage1";
import { Glyph } from "./Glyph";
import { ActionResultMsg, rid } from "./useRoom";

type Send = (m: ClientMsg) => void;

/** Server-corrected clock, ticking 10x/second. */
function useNow(offset: number) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => { const i = window.setInterval(() => setNow(Date.now() + offset), 100); return () => window.clearInterval(i); }, [offset]);
  return now;
}
const fmt = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/* ---------- Briefing ---------- */
const ROLE_INFO: Record<Role, { title: string; tag: string; rules: string[] }> = {
  runner: { title: "Runner", tag: "You see the vault", rules: ["You're the only one who can act inside the vault. Enter codes on the keypad.", "Describe what you see out loud: sector, door type, and glyph names. Your partner can't see it.", "Don't guess. Two misses on a door lock it and cost shared Integrity."] },
  decoder: { title: "Decoder", tag: "You hold the intel", rules: ["You see the codebook pages and door rules the Runner can't.", "Ask the Runner which sector, door type and glyphs they see, then work out the code.", "You can't act in the vault. Guide, don't guess."] },
};

export function Briefing({ snap, me, send, onLeave }: { snap: Snapshot; me: PlayerView; send: Send; onLeave: () => void }) {
  const info = ROLE_INFO[me.role ?? "runner"];
  const partner = snap.players.find((p) => p.id !== me.id);
  return (
    <section className={"panel role " + me.role}>
      <p className="muted">Your role</p>
      <h1>{info.title}</h1>
      <p className="lede">{info.tag}. {partner?.name ?? "Your partner"} is the {me.role === "runner" ? "Decoder" : "Runner"}.</p>
      <ul>{info.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      <p className="inline-note">Stage 1 · GLYPH GATES. Open all three doors before the 2:30 timer or your 5 Integrity runs out. Talk by voice or any chat app; this build has no in-game chat yet.</p>
      <button className="btn primary" onClick={() => send({ type: "ack_briefing" })} disabled={me.ready}>{me.ready ? `Waiting for ${partner?.name ?? "partner"}…` : "I'm briefed, begin"}</button>
      <button className="btn ghost" onClick={onLeave}>Leave room</button>
    </section>
  );
}

export function Countdown({ g, offset }: { g: GameView; offset: number }) {
  const now = useNow(offset);
  const n = Math.max(1, Math.ceil((g.countdownEndsAt - now) / 1000));
  return (
    <div className="countdown" role="status" aria-live="assertive">
      <p className="muted">{g.pausedUntil ? "Waiting for your partner to reconnect…" : "Breach begins in"}</p>
      <div key={n} className="count-num">{n}</div>
    </div>
  );
}

/* ---------- HUD ---------- */
function Hud({ g, offset, role }: { g: GameView; offset: number; role: Role }) {
  const now = useNow(offset);
  const remaining = g.remainingMs ?? Math.max(0, g.deadline - now);
  const low = remaining < 30_000;
  return (
    <div className="hud" role="group" aria-label="Mission status">
      <div className="hud-top">
        <span className="stage">Stage {g.stageIndex + 1}/{g.stageCount} · {g.stageName}</span>
        <span className={"role-chip " + role}>{role}</span>
      </div>
      <div className="hud-row">
        <div className={"timer mono" + (low ? " low" : "")} aria-label={`Time left ${fmt(remaining)}`}>{fmt(remaining)}</div>
        <div className="integrity" aria-label={`Integrity ${g.integrity} of ${g.maxIntegrity}`}>
          {Array.from({ length: g.maxIntegrity }, (_, i) => <i key={i} className={i < g.integrity ? "pip on" : "pip"} />)}
          <small>INTEGRITY</small>
        </div>
        <div className="score mono"><small>SCORE</small>{g.score}</div>
      </div>
    </div>
  );
}

function Activity({ g }: { g: GameView }) {
  const items = g.events.slice(-4).reverse();
  if (!items.length) return null;
  return <ul className="activity" aria-label="Recent activity">{items.map((e) => <li key={e.seq} className={e.kind}>{e.text}</li>)}</ul>;
}

function DoorChips({ g, now }: { g: GameView; now: number }) {
  return (
    <div className="chips" aria-label="Door status">
      {g.doors.map((d) => {
        const cool = d.status === "locked" && d.lockedUntil > now;
        return <span key={d.id} className={"chip " + (d.status === "open" ? "open" : cool ? "cool" : "")}>Door {d.id + 1}: {d.status === "open" ? "open" : cool ? `locked ${Math.ceil((d.lockedUntil - now) / 1000)}s` : "sealed"}</span>;
      })}
    </div>
  );
}

/* ---------- Play ---------- */
export function Play({ snap, me, send, offset, result }: { snap: Snapshot; me: PlayerView; send: Send; offset: number; result: ActionResultMsg | null }) {
  const g = snap.game!;
  const partner = snap.players.find((p) => p.id !== me.id);
  const now = useNow(offset);
  return (
    <>
      <Hud g={g} offset={offset} role={me.role!} />
      {g.runner && me.role === "runner" && <RunnerView g={g} send={send} now={now} result={result} />}
      {g.decoder && me.role === "decoder" && <DecoderView g={g} now={now} />}
      <Activity g={g} />
      {g.pausedUntil && (
        <div className="overlay" role="alertdialog" aria-live="assertive">
          <div className="panel">
            <h2>Game paused</h2>
            <p>{partner?.name ?? "Your partner"} disconnected. The clock is frozen and everything resumes the moment they're back.</p>
            <p className="muted">The run is abandoned in {Math.max(0, Math.ceil((g.pausedUntil - now) / 1000))}s if they don't return.</p>
          </div>
        </div>
      )}
    </>
  );
}

function RunnerView({ g, send, now, result }: { g: GameView; send: Send; now: number; result: ActionResultMsg | null }) {
  const doors = g.runner!.doors;
  const [sel, setSel] = useState<number>(() => Math.max(0, doors.findIndex((d) => d.status === "locked")));
  const [digits, setDigits] = useState<number[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: string } | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const door = doors[sel];
  const cooling = door.status === "locked" && door.lockedUntil > now;
  const revealUsed = door.revealed.some((x) => x !== null);
  const usable = door.status === "locked" && !cooling && !g.pausedUntil;

  // Move off a door that just opened.
  useEffect(() => { if (door.status === "open") { const n = doors.findIndex((d) => d.status === "locked"); if (n >= 0) { setSel(n); setDigits([]); } } }, [door.status]); // eslint-disable-line

  // Show the server's verdict for the action we sent.
  useEffect(() => {
    if (!result || result.actionId !== pending) return;
    setPending(null); setDigits([]); setConfirmReveal(false);
    setMsg({ text: result.message, kind: result.outcome });
  }, [result]); // eslint-disable-line
  useEffect(() => { if (!pending) return; const t = window.setTimeout(() => { setPending(null); setMsg({ text: "No answer from the server. Check your connection and try again.", kind: "rejected" }); }, 6000); return () => window.clearTimeout(t); }, [pending]);

  const submit = () => {
    if (!usable || pending || digits.length !== 3) return;
    const id = rid(); setPending(id); setMsg(null);
    send({ type: "act", actionId: id, stageIndex: g.stageIndex, action: "door_code", door: door.id, digits });
  };
  const doReveal = () => {
    if (!confirmReveal) { setConfirmReveal(true); window.setTimeout(() => setConfirmReveal(false), 4000); return; }
    const id = rid(); setPending(id); setMsg(null);
    send({ type: "act", actionId: id, stageIndex: g.stageIndex, action: "reveal", door: door.id });
  };
  const press = (d: number) => setDigits((x) => (x.length < 3 ? [...x, d] : x));
  const submitRef = useRef(submit); submitRef.current = submit;
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(Number(e.key));
      else if (e.key === "Backspace") setDigits((x) => x.slice(0, -1));
      else if (e.key === "Enter") submitRef.current();
    };
    window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f);
  }, []);

  return (
    <>
      <p className="muted tip">Read each door aloud to your Decoder: sector, door type, glyph names. They'll give you the code.</p>
      <div className="doors">
        {doors.map((d) => <DoorCard key={d.id} d={d} now={now} selected={d.id === sel} onSelect={() => { setSel(d.id); setDigits([]); setMsg(null); }} />)}
      </div>
      {door.status === "locked" && (
        <section className="panel keypad" aria-label={`Keypad for door ${door.id + 1}`}>
          <h2>Door {door.id + 1} keypad</h2>
          <div className="slotsrow" aria-live="polite">
            {[0, 1, 2].map((i) => <span key={i} className={"digit mono" + (digits[i] === undefined ? " empty" : "")}>{digits[i] ?? (door.revealed[i] ?? "·")}</span>)}
          </div>
          <div className="pad">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <button key={n} className="key" onClick={() => press(n)} disabled={!usable}>{n}</button>)}
            <button className="key" onClick={() => setDigits((x) => x.slice(0, -1))} aria-label="Delete" disabled={!digits.length}>⌫</button>
            <button className="key" onClick={() => press(0)} disabled={!usable}>0</button>
            <button className="key enter" onClick={submit} disabled={!usable || digits.length !== 3 || !!pending}>{pending ? "…" : "Enter"}</button>
          </div>
          {cooling && <p className="inline-error" role="status">Door cooling down: {Math.ceil((door.lockedUntil - now) / 1000)}s</p>}
          {msg && <p className={"verdict " + msg.kind} role="status">{msg.text}</p>}
          <button className="btn ghost" onClick={doReveal} disabled={!door.canReveal || !!pending || !!g.pausedUntil}>
            {revealUsed ? "Reveal used on this door" : confirmReveal ? `Tap again: spend ${REVEAL_COST_MS / 1000}s` : `Brute-reveal one digit (−${REVEAL_COST_MS / 1000}s)`}
          </button>
        </section>
      )}
    </>
  );
}

function DoorCard({ d, now, selected, onSelect }: { d: RunnerDoor; now: number; selected: boolean; onSelect: () => void }) {
  const cool = d.status === "locked" && d.lockedUntil > now;
  const open = d.status === "open";
  return (
    <button className={"door" + (selected ? " sel" : "") + (open ? " open" : "") + (cool ? " cool" : "")} onClick={onSelect} disabled={open} aria-pressed={selected}>
      <div className="door-head">
        <strong>Door {d.id + 1}</strong>
        <span className="sector">{SECTOR_NAMES[d.sector]}</span>
        <span className={"type " + d.type}>{d.type}</span>
      </div>
      <div className="glyph-row">
        {d.glyphs.map((gl, i) => <Glyph key={i} id={gl} size={44} label />)}
        {d.type === "checksum" && <span className="glyph sum" aria-label="checksum slot"><b>Σ</b><small>computed</small></span>}
      </div>
      <div className="door-foot">{open ? "OPEN" : cool ? `Locked ${Math.ceil((d.lockedUntil - now) / 1000)}s` : `${d.triesLeft} ${d.triesLeft === 1 ? "try" : "tries"} before lockout`}</div>
    </button>
  );
}

function DecoderView({ g, now }: { g: GameView; now: number }) {
  const dv = g.decoder!;
  return (
    <>
      <p className="muted tip">You can't see the vault. Ask your Runner for each door's sector, type and glyph names, then tell them the code.</p>
      <DoorChips g={g} now={now} />
      <section className="panel" aria-label="Codebook">
        <h2>Codebook</h2>
        <div className="codex">
          {dv.codex.map((page) => (
            <div key={page.sector} className="page">
              <h3>{SECTOR_NAMES[page.sector]}</h3>
              <div className="pairs">{page.pairs.map((p) => <div key={p.glyph} className="pair"><Glyph id={p.glyph} size={30} label /><span className="eq mono">= {p.digit}</span></div>)}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="panel" aria-label="Protocol notes">
        <h2>Door protocols</h2>
        <ul className="notes">{dv.notes.map((n) => <li key={n.type}><span className={"type " + n.type}>{n.type}</span>{n.rule.replace(/^[A-Z]+ door: /, "")}</li>)}</ul>
      </section>
    </>
  );
}

/* ---------- End screens ---------- */
const CAUSE: Record<string, string> = { timeout: "The timer hit zero.", integrity: "Integrity hit zero.", abandoned: "Your partner didn't return in time." };

export function EndScreen({ snap, me, send, onLeave }: { snap: Snapshot; me: PlayerView; send: Send; onLeave: () => void }) {
  const g = snap.game!;
  const won = g.result?.outcome === "won";
  const partner = snap.players.find((p) => p.id !== me.id);
  const rows = useMemo(() => g.stageScores, [g.stageScores]);
  const canReplay = snap.status !== "abandoned" && !!partner;
  return (
    <section className={"panel end " + (won ? "won" : "lost")} role="status">
      <p className="muted">{won ? "Mission complete" : "Mission failed"}</p>
      <h1>{won ? "VAULT CRACKED" : snap.status === "abandoned" ? "RUN ABANDONED" : "SIGNAL LOST"}</h1>
      {!won && <p className="lede">{CAUSE[g.result?.cause ?? ""] ?? ""}</p>}
      <div className="final mono">{g.score}<small>FINAL SCORE</small></div>
      {rows.length > 0 && (
        <table className="breakdown">
          <tbody>
            {rows.map((r) => (
              <tr key={r.stage}><td>Stage {r.stage + 1}</td><td className="mono">{r.base} + {r.timeBonus} time{r.flawless ? ` + ${r.flawless} flawless` : ""}</td></tr>
            ))}
            {won && <tr><td>Integrity left</td><td className="mono">{g.integrity} × 150 = {g.integrity * 150}</td></tr>}
          </tbody>
        </table>
      )}
      {won && <p className="inline-note">This build contains Stage 1 only; the next stages are still being built.</p>}
      <div className="row">
        {canReplay && (
          <button className="btn primary" onClick={() => send({ type: "replay" })} disabled={g.replay.youVoted}>
            {g.replay.youVoted ? `Waiting for ${partner!.name} (${g.replay.votes}/2)` : "Run it back (swap roles)"}
          </button>
        )}
        <button className="btn ghost" onClick={onLeave}>Leave room</button>
      </div>
    </section>
  );
}
