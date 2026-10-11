# ECHO HEIST: Two Brains, One Vault

Status: **M2 done** (rooms, lobby, roles, briefing, countdown, Stage 1 GLYPH GATES, timer, Integrity, scoring, win/loss, replay, pause-on-disconnect). Stages 2-3, hints, chat and polish are M3-M6.

## Run locally
```bash
npm install
npm run build
npx wrangler dev --local        # real Workers + Durable Object runtime, http://localhost:8787
```
Open the URL in two different browser windows. Each window is its own player: the seat token lives in sessionStorage.

## Tests
```bash
npm test                                          # 24 tests: engine properties + two-client playthroughs (fake clock)
npx wrangler dev --local --port 8788              # in another terminal, then:
TEST_BASE=127.0.0.1:8788 npx vitest run tests/lobby.test.ts   # lobby suite vs the real Durable Object
```

## Deploy (free, no credit card)
1. Create a free account at https://dash.cloudflare.com/sign-up
2. `npx wrangler login`
3. `npm run deploy`
4. Wrangler prints `https://echo-heist.<your-subdomain>.workers.dev`. That is your public URL.

## Test on two real devices
1. Device A: open the URL, enter a name, tap **Create room**.
2. Tap **Copy invite link** and send it to Device B (use a different network, e.g. phone on cellular).
3. Device B: open the link, enter a name. Both tap **I'm ready**, then the host taps **Start heist**.
4. Each device shows a different role. Both tap **I'm briefed**, then a 3-2-1 countdown starts.
   There is no in-game chat yet, so talk by phone call or any chat app. That is the game.
5. Runner reads out each door (sector, door type, glyph names); Decoder looks them up in the codebook and says the code.
6. Also try: refresh Device B in the lobby, toggle airplane mode on B for 10s, open a wrong code (`/r/ZZZZZ`).

Closing a tab and opening a new one counts as a new player. Refreshing keeps your seat.

Privacy: the Runner's screen never receives the codebook or door rules; the Decoder's never receives door glyphs or sectors. A test checks every message each client receives.
