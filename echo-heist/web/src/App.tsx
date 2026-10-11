import { useEffect, useState, FormEvent, ReactNode } from "react";
import { useRoom, Conn } from "./useRoom";
import { isValidCode, normalizeCode, cleanName, MAX_NAME, PlayerView } from "../../shared/protocol";
import { Briefing, Countdown, Play, EndScreen } from "./Play";

const nav = (path: string) => { history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate")); };
const savedName = () => sessionStorage.getItem("eh:name") ?? localStorage.getItem("eh:lastName") ?? "";
const saveName = (n: string) => { sessionStorage.setItem("eh:name", n); localStorage.setItem("eh:lastName", n); };

export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f = () => setPath(location.pathname); window.addEventListener("popstate", f); return () => window.removeEventListener("popstate", f); }, []);
  const m = path.match(/^\/r\/([^/]+)\/?$/i);
  return (
    <div className="shell">
      <div className="grid-bg" aria-hidden />
      {m ? <RoomGate key={m[1]} raw={m[1]} /> : <Landing />}
    </div>
  );
}

/* ---------- shared bits ---------- */
function Logo({ small }: { small?: boolean }) {
  return (
    <a href="/" onClick={(e) => { e.preventDefault(); nav("/"); }} className={"logo" + (small ? " small" : "")} aria-label="Echo Heist home">
      <span className="logo-a">ECHO</span><span className="logo-b">HEIST</span>
    </a>
  );
}
function Spinner({ label }: { label: string }) {
  return <div className="center-note" role="status"><div className="spinner" aria-hidden /><p>{label}</p></div>;
}
function ErrorPanel({ title, message, children }: { title: string; message: string; children?: ReactNode }) {
  return <div className="panel error" role="alert"><h2>{title}</h2><p>{message}</p><div className="row">{children}</div></div>;
}
function ConnBadge({ conn, latency }: { conn: Conn | "idle"; latency?: number | null }) {
  const text = { idle: "Server ready", connecting: "Connecting", online: latency ? `Live · ${latency}ms` : "Live", reconnecting: "Reconnecting", failed: "Offline" }[conn];
  return <span className={"badge " + conn} role="status"><i aria-hidden />{text}</span>;
}

/* ---------- Landing ---------- */
function Landing() {
  const [name, setName] = useState(savedName());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [server, setServer] = useState<"checking" | "ok" | "down">("checking");

  useEffect(() => { fetch("/api/room/AAAAA").then((r) => setServer(r.ok ? "ok" : "down")).catch(() => setServer("down")); }, []);

  const needName = () => { const n = cleanName(name); if (!n) { setErr("Enter a name first (1–16 characters)."); return null; } saveName(n); return n; };

  const create = async () => {
    setErr(null); if (!needName()) return;
    setBusy("create");
    try {
      const r = await fetch("/api/create", { method: "POST" });
      if (!r.ok) throw new Error();
      const { code } = (await r.json()) as { code: string };
      nav(`/r/${code}`);
    } catch { setErr("Couldn't create a room. Check your connection and try again."); setBusy(null); }
  };
  const join = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!needName()) return;
    const c = normalizeCode(code);
    if (!isValidCode(c)) return setErr("Room codes are 5 characters, like K7QMX.");
    setBusy("join");
    try {
      const s = (await (await fetch(`/api/room/${c}`)).json()) as { exists: boolean; status?: string; full?: boolean };
      const mine = !!sessionStorage.getItem(`eh:token:${c}`);
      if (!s.exists) setErr("No room with that code. Check it with your partner.");
      else if (!mine && s.status !== "lobby") setErr("That game has already started.");
      else if (!mine && s.full) setErr("That room already has two players.");
      else return nav(`/r/${c}`);
    } catch { setErr("Couldn't reach the server. Try again."); }
    setBusy(null);
  };

  return (
    <main className="landing">
      <header className="top"><Logo small /><ConnBadge conn={server === "ok" ? "idle" : server === "down" ? "failed" : "connecting"} /></header>
      <section className="hero">
        <div className="vault" aria-hidden><span /><span /><span /><b /></div>
        <h1>Two brains.<br />One vault.</h1>
        <p className="lede">One of you sees the vault. The other holds the codes. Neither can escape alone, so talk fast.</p>
      </section>
      <section className="panel entry" aria-label="Start a game">
        <label className="field">Your name
          <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nova" autoComplete="nickname" enterKeyHint="go" />
        </label>
        <button className="btn primary" onClick={create} disabled={busy !== null}>{busy === "create" ? "Creating room…" : "Create room"}</button>
        <div className="or" aria-hidden><span>or join a partner</span></div>
        <form onSubmit={join} className="join">
          <label className="field">Room code
            <input className="code-input" value={code} onChange={(e) => setCode(normalizeCode(e.target.value))} placeholder="K7QMX" inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
          </label>
          <button className="btn" disabled={busy !== null || code.length < 5}>{busy === "join" ? "Checking…" : "Join room"}</button>
        </form>
        {err && <p className="inline-error" role="alert">{err}</p>}
        {server === "down" && <p className="inline-error" role="alert">The game server isn't responding right now.</p>}
      </section>
      <button className="link" onClick={() => setHelp(true)}>How to play</button>
      {help && <HowTo onClose={() => setHelp(false)} />}
    </main>
  );
}

function HowTo({ onClose }: { onClose: () => void }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f); }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="panel modal" role="dialog" aria-modal="true" aria-labelledby="ht" onClick={(e) => e.stopPropagation()}>
        <h2 id="ht">How to play</h2>
        <p>Two players join one room from separate devices. You get different, private screens.</p>
        <p><strong className="c-violet">Runner</strong> sees the vault: doors, grid, breakers, hazards, and is the only one who can act in it.</p>
        <p><strong className="c-cyan">Decoder</strong> sees the codebooks, ciphers and rules. You can't touch the vault, so you guide the Runner.</p>
        <p>Clear three security layers before the timer or your shared Integrity runs out. Mistakes cost Integrity. Talk by voice or in-game chat.</p>
        <button className="btn" onClick={onClose} autoFocus>Got it</button>
      </div>
    </div>
  );
}

/* ---------- Room gate: validates code, collects name ---------- */
function RoomGate({ raw }: { raw: string }) {
  const code = normalizeCode(raw);
  const [name, setName] = useState<string | null>(sessionStorage.getItem("eh:name"));
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [state, setState] = useState<"checking" | "ok" | "missing" | "down">("checking");

  useEffect(() => {
    if (!isValidCode(code)) { setState("missing"); return; }
    fetch(`/api/room/${code}`).then((r) => r.json() as Promise<{ exists: boolean }>).then((s) => setState(s.exists ? "ok" : "missing")).catch(() => setState("down"));
  }, [code]);

  if (state === "checking") return <main className="narrow"><Spinner label="Locating room…" /></main>;
  if (state === "missing") return <main className="narrow"><Logo small /><ErrorPanel title="Room not found" message={`There's no room "${raw.toUpperCase().slice(0, 8)}". It may have expired, or the code has a typo.`}><button className="btn primary" onClick={() => nav("/")}>Back to start</button></ErrorPanel></main>;
  if (state === "down") return <main className="narrow"><Logo small /><ErrorPanel title="Server unreachable" message="We couldn't reach the game server. Check your connection."><button className="btn primary" onClick={() => location.reload()}>Try again</button></ErrorPanel></main>;
  if (!name) return <NamePrompt code={code} error={nameErr} onSubmit={(n) => { saveName(n); setNameErr(null); setName(n); }} />;
  return <RoomView code={code} name={name} onNameProblem={(m) => { setNameErr(m); setName(null); sessionStorage.removeItem("eh:name"); }} />;
}

function NamePrompt({ code, error, onSubmit }: { code: string; error: string | null; onSubmit: (n: string) => void }) {
  const [n, setN] = useState(localStorage.getItem("eh:lastName") ?? "");
  const submit = (e: FormEvent) => { e.preventDefault(); const c = cleanName(n); if (c) onSubmit(c); };
  return (
    <main className="narrow">
      <Logo small />
      <form className="panel" onSubmit={submit}>
        <h2>Join room <span className="mono c-cyan">{code}</span></h2>
        <label className="field">Your name
          <input value={n} maxLength={MAX_NAME} onChange={(e) => setN(e.target.value)} placeholder="e.g. Cipher" autoFocus autoComplete="nickname" />
        </label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button className="btn primary" disabled={!cleanName(n)}>Enter lobby</button>
      </form>
    </main>
  );
}

/* ---------- Room view ---------- */
function RoomView({ code, name, onNameProblem }: { code: string; name: string; onNameProblem: (m: string) => void }) {
  const { snap, conn, fatal, toast, latency, send, leave, offset, result } = useRoom(code, name);

  useEffect(() => { if (fatal && (fatal.code === "NAME_TAKEN" || fatal.code === "NAME_INVALID")) onNameProblem(fatal.message); }, [fatal]); // eslint-disable-line

  if (fatal && fatal.code !== "NAME_TAKEN" && fatal.code !== "NAME_INVALID") {
    const titles: Record<string, string> = { ROOM_NOT_FOUND: "Room not found", ROOM_FULL: "Room is full", IN_PROGRESS: "Game already started", REPLACED: "Opened in another tab", UNREACHABLE: "Connection lost" };
    return (
      <main className="narrow"><Logo small />
        <ErrorPanel title={titles[fatal.code] ?? "Something went wrong"} message={fatal.message}>
          {fatal.code === "REPLACED" || fatal.code === "UNREACHABLE"
            ? <button className="btn primary" onClick={() => location.reload()}>Reconnect</button> : null}
          <button className="btn" onClick={() => nav("/")}>Back to start</button>
        </ErrorPanel>
      </main>
    );
  }
  if (!snap) return <main className="narrow"><Logo small /><Spinner label={conn === "reconnecting" ? "Reconnecting to the vault…" : "Connecting to the vault…"} /></main>;

  const me = snap.players.find((p) => p.id === snap.youId)!;
  const leaveRoom = () => { leave(); nav("/"); };
  return (
    <main className="room">
      <header className="top"><Logo small /><ConnBadge conn={conn} latency={latency} /></header>
      {conn === "reconnecting" && <div className="banner" role="alert">Connection lost. Retrying automatically. Your seat is held for you.</div>}
      {snap.status === "lobby" && <Lobby snap={snap} me={me} send={send} onLeave={leaveRoom} />}
      {snap.status === "briefing" && <Briefing snap={snap} me={me} send={send} onLeave={leaveRoom} />}
      {snap.status === "countdown" && snap.game && <Countdown g={snap.game} offset={offset} />}
      {snap.status === "playing" && snap.game && <Play snap={snap} me={me} send={send} offset={offset} result={result} />}
      {(snap.status === "won" || snap.status === "lost" || snap.status === "abandoned") && snap.game && <EndScreen snap={snap} me={me} send={send} onLeave={leaveRoom} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function Lobby({ snap, me, send, onLeave }: { snap: ReturnType<typeof useRoom>["snap"] & {}; me: PlayerView; send: ReturnType<typeof useRoom>["send"]; onLeave: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const link = `${location.origin}/r/${snap.code}`;
  const full = snap.players.length === 2;
  const allReady = full && snap.players.every((p) => p.ready && p.connected);

  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
    setCopied(label); window.setTimeout(() => setCopied(null), 1800);
  };
  const share = () => navigator.share?.({ title: "Echo Heist", text: "Join my vault run:", url: link }).catch(() => {});
  const slots = [snap.players[0], snap.players[1]];

  return (
    <>
      <section className="panel invite">
        <p className="muted">Room code</p>
        <div className="code-big mono" aria-label={`Room code ${snap.code.split("").join(" ")}`}>{snap.code}</div>
        <div className="row">
          <button className="btn" onClick={() => copy(snap.code, "code")}>{copied === "code" ? "Copied" : "Copy code"}</button>
          <button className="btn" onClick={() => copy(link, "link")}>{copied === "link" ? "Link copied" : "Copy invite link"}</button>
          {"share" in navigator && <button className="btn" onClick={share}>Share</button>}
        </div>
      </section>

      <section className="slots" aria-label="Players">
        {slots.map((p, i) => p ? (
          <div key={p.id} className={"slot" + (p.ready ? " ready" : "") + (p.connected ? "" : " away")}>
            <div className="avatar" aria-hidden>{p.name.slice(0, 1).toUpperCase()}</div>
            <div className="who">
              <strong>{p.name}{p.id === me.id ? " (you)" : ""}</strong>
              <span className="muted">{p.isHost ? "Host · " : ""}{!p.connected ? "Disconnected, seat held" : p.ready ? "Ready" : "Not ready"}</span>
            </div>
            <i className={"dot " + (p.connected ? "on" : "off")} aria-hidden />
          </div>
        ) : (
          <div key={i} className="slot empty" role="status">
            <div className="avatar pulse" aria-hidden>?</div>
            <div className="who"><strong>Waiting for your partner</strong><span className="muted">Send them the code or invite link above.</span></div>
          </div>
        ))}
      </section>

      <section className="actions">
        <button className={"btn " + (me.ready ? "" : "primary")} onClick={() => send({ type: "ready", ready: !me.ready })} disabled={!full}>
          {me.ready ? "Cancel ready" : "I'm ready"}
        </button>
        {me.isHost && <button className="btn violet" onClick={() => send({ type: "start" })} disabled={!allReady}>Start heist</button>}
        <button className="btn ghost" onClick={onLeave}>Leave room</button>
        <p className="muted hint" role="status">
          {!full ? "Both players need to be in the room to ready up."
            : !allReady ? "Waiting for both players to ready up."
            : me.isHost ? "Both ready. Start when you are." : "Both ready. Waiting for the host to start."}
        </p>
      </section>
    </>
  );
}
