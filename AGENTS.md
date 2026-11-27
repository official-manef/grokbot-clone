# Agent Instructions

<!-- mso-local-context -->
## Local Integration & Credential Context
Before running GitHub (`git`/`gh`/API) or external provider operations, check local gitignored `mso.md` (or `.mso/mso.md`) in this repository root if present. It specifies the intended MSO integration user and connection for this project. Never commit `mso.md`, `.mso/mso.md`, or raw credentials.

## What this repo is

Bot HQ (package name `grokbot`): a chat UI where each bot is a Hermes agent with its
own screen. Three layers, and they are separable on purpose:

- `web/` — the UI (Vite/React). Talks only to `server/` over HTTP + WebSocket.
- `server/` — Hono app. Owns the bot store, conversations, auth, and the tool layer.
- `server/src/box/` — the "bot desktop" boundary: `contract.ts` defines what a box is,
  `adapters/docker.ts` runs a local container, `adapters/mso.ts` drives a remote MSO
  host, `adapters/orgo.ts` an Orgo computer. `desktop.ts` is a wrapper over the chosen
  adapter; it is not a second copy of one.

Hermes owns the model conversation. The app sends ONE new message per turn and never
replays history. That is why there is no compaction module (deleted in `947c7ae`) —
do not reintroduce one unless the app starts owning history.

## Commands

| what | command |
|---|---|
| install | `npm ci` |
| dev | `npm run dev` |
| build | `npm run build` |
| typecheck | `npm run typecheck` |
| test | `npm test` |

`npm test` runs `server/test/*.test.mjs` only. The web/mobile suites are separate:
`node scripts/mobile-suites.mjs` (needs Playwright Chromium and a served build); CI
runs them as their own step.

## Guardrails

- **Tests that assert the test, not the code, have happened three times here.** Read
  the assertion back: does it run the decision, or restate it?
- A probe test spawns `node --import tsx` per case, so each child pays a compile. Keep
  `--test-concurrency` bounded; at 192 cases × one child each, defaulting to CPU count
  starves the box and every probe reports a timeout instead of a result.
- `--sandbox workspace-write` kills MCP on the Codex provider; profiles need
  `danger-full-access`. Not this repo's code, but it bites when driving it.
- Work happens ONLY in `projects/<repo>/.worktrees/<branch>/`. `projects/<repo>/`
  itself stays on `main` and clean.
- Secrets never enter the repo.

## Where the state lives

`docs/CONTINUE.md` is the handoff file: current HEAD, what is deployed, which items are
closed and why, and the first commands for a new session. Read it before re-deriving
context, and correct it when a claim in it stops being true.

## Verify a change

`npm run typecheck && npm test && npm run build`
