# Gemini Instructions

Read `AGENTS.md` in this repo root; it is the single source of agent context. The
short version:

- `web/` (UI) → `server/` (Hono, store, tools) → `server/src/box/` (bot desktops).
- Verify with `npm run typecheck && npm test && npm run build`.
- Tests live in `server/test/*.test.mjs`; the web/mobile suites are separate
  (`node scripts/mobile-suites.mjs`).

<!-- mso-local-context -->
## Local Integration & Credential Context
Before running GitHub (`git`/`gh`/API) or external provider operations, check local gitignored `mso.md` (or `.mso/mso.md`) in this repository root if present. It specifies the intended MSO integration user and connection for this project. Never commit `mso.md`, `.mso/mso.md`, or raw credentials.
