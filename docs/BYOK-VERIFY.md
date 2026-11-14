# BYOK-only boot and capability verification

Worktree: `/home/antinrml/projects/grokbot-clone/.worktrees/feat/byok-latest`
Branch: `feat/byok-latest` @ `7312d70`
Goal: prove the app boots with owner-supplied LLM endpoint alone (no `XAI_*`,
`ORGO_*`, `COMPOSIO_*`), and that unavailable capabilities report `false`
instead of being silently faked.

## Commands + output

### 1. Install

`npm ci` succeeded (no lockfile mismatch, so `npm install` was not needed).

```
$ npm ci
npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   better-sqlite3@13.0.3 (install: node-gyp rebuild)
npm warn install-scripts   esbuild@0.23.1 (postinstall: node install.js)
npm warn install-scripts
npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.
added 168 packages, and audited 171 packages in 7s
100 packages are looking for funding
  run `npm fund` for details
To address all issues, run:
Run `npm audit` for details.
```

Install scripts were skipped by the npm policy, so native/prebuilt binaries were
checked separately:

```
$ node -e "require('better-sqlite3'); console.log('sqlite ok')"
sqlite ok
```

esbuild shipped its prebuilt linux-x64 binary via the optional dependency
(`node_modules/@esbuild/linux-x64/bin/esbuild` present), so no rebuild was needed.

### 2. `.env` (BYOK only)

Created `.env` (gitignored) with exactly the requested keys — no `XAI_*`,
`ORGO_*`, `COMPOSIO_*`. The session secret is generated, never copied: it keys
the HMACs behind owner sign-in and the agent MCP tokens, so a literal value in
this doc (or in any doc) would be a working recipe to mint an owner session for
any email on any deployment that reused it. Generate a fresh one per host:

```
$ SESSION_SECRET=$(openssl rand -hex 32)   # then put it in .env
```

```
PORT=8787
APP_URL=http://localhost:5173
SERVER_URL=http://localhost:8787
SESSION_SECRET=$(openssl rand -hex 32)
DEV_LOGIN=0
ALLOWED_EMAILS=
DESKTOP_MODE=disabled
LLM_BASE_URL=http://127.0.0.1:20128/v1
LLM_API_KEY=placeholder-local-check
LLM_MODEL=ollama-cloud-deepseek-v4.1-flash-1017
LLM_PROTOCOL=chat
```

`LLM_API_KEY` above is a placeholder string, not a real credential. `.env` was
not committed (matched by `.gitignore` line 3: `.env`).

### 3. Boot

First boot attempt failed — `npm run start -w server` runs `node --env-file=../.env dist/index.js`
and `dist/` does not exist in a fresh checkout:

```
$ nohup npm run start -w server > .../grokbot-server.log 2>&1 &
Error: Cannot find module '/home/antinrml/projects/grokbot-clone/.worktrees/feat/byok-latest/server/dist/index.js'
npm error Lifecycle script `start` failed with error:
npm error code 1
npm error path /home/antinrml/projects/grokbot-clone/.worktrees/feat/byok-latest/server
npm error workspace @grokbot/server
npm error location /home/antinrml/projects/grokbot-clone/.worktrees/feat/byok-latest/server
npm error command sh -c node --env-file=../.env dist/index.js
```

Fixed by building the workspace (build output goes to gitignored `dist/`, so this
creates no tracked changes):

```
$ npm run build -w server
> build
> tsc -p tsconfig.json
(exit 0; server/dist/index.js emitted)
```

Boot after build:

```
$ nohup npm run start -w server > /home/antinrml/.hermes/cache/scratch/nakama-wave/grokbot-server.log 2>&1 &
(port answered on /api/health after 2s)

$ cat /home/antinrml/.hermes/cache/scratch/nakama-wave/grokbot-server.log
> start
> node --env-file=../.env dist/index.js

[env] capabilities off: image, tts, stt, realtime, desktop, integrations, signin
[routines] scheduled 0
[triggers] 0 event routine(s)
[proactive] 0 user(s) with check-ins
[idle] the shared computer is never suspended
[grokbot] server on http://localhost:8787
```

### 4. Capability checks

```
$ curl -s http://127.0.0.1:8787/api/health
{"ok":true,"engine":"hermes","model":"ollama-cloud-deepseek-v4.1-flash-1017"}

$ curl -s http://127.0.0.1:8787/api/capabilities
{"ok":true,"model":"ollama-cloud-deepseek-v4.1-flash-1017","protocol":"chat","hostedTools":false,"desktop":{"mode":"disabled","ready":false},"capabilities":{"llm":true,"image":false,"tts":false,"stt":false,"realtime":false,"desktop":false,"integrations":false,"signin":false},"engine":false,"notes":[],"gaps":["image","tts","stt","realtime","desktop","integrations","signin"]}
```

Both endpoints returned HTTP 200.

**That `engine:"hermes"` was wrong and this run is superseded.** No Hermes URL was
set in §2, yet `/api/health` said `hermes` because it inferred the engine from
`capabilities.llm`. Current behaviour (`fcd3838`'s review round):

```
$ curl -s -w ' HTTP %{http_code}\n' http://127.0.0.1:8787/api/health
{"ok":true,"engine":"byok","model":"ollama-cloud-deepseek-v4.1-flash-1017","capabilities":{...}} HTTP 200
```

- `engine` is the backend that would answer a turn: `hermes` only when
  `HERMES_URL`/`HQ_LOCAL=1` is set, `byok` for a complete base+key pair,
  `unconfigured` otherwise (the same value `capabilityReport().engine` returns).
- `ok` is readiness, not liveness: it is `true` only when a bot turn could be
  answered, and the status is **503** when it could not. A monitor therefore
  pages on a deployment whose model is half-configured, instead of reading green.
- No network call is made per request. `GET /api/health?probe=1` adds one
  reachability probe, and only against a Hermes engine; a BYOK endpoint is not
  probed because that would be a billable model request.

## Findings

- **No boot failure in the final run.** The only boot failure was the missing
  `server/dist` build artifact on a fresh checkout; after `npm run build -w server`
  the server started cleanly and stayed up. This is a packaging/wiring gap, not a
  BYOK configuration problem: the `start` script assumes a prior `build`.
- **LLM reports configured.** `capabilities.llm` is `true`, and `/api/health`
  echoes `ok:true` with the owner-supplied model
  `ollama-cloud-deepseek-v4.1-flash-1017` and `engine:"hermes"`. The BYOK endpoint
  is the only LLM source configured. *(The engine name was the false green
  described in §4 and is now `byok`; `capabilities.llm` itself was right, since
  the pair is complete.)*
- **Unset capabilities report false, not faked.** `image`, `tts`, `stt`,
  `realtime`, `desktop`, `integrations` are all `false`. `signin` is also `false`,
  which is expected with `DEV_LOGIN=0` and an empty `ALLOWED_EMAILS`.
- **Desktop is explicitly disabled, not merely unconfigured.** `desktop.mode` is
  `"disabled"` and `desktop.ready` is `false`, consistent with `DESKTOP_MODE=disabled`
  and no Docker/Orgo.
- **Server self-reports the same set.** On boot the server logged
  `[env] capabilities off: image, tts, stt, realtime, desktop, integrations, signin`,
  matching the HTTP payload.
- **Gaps are surfaced, not hidden.** `/api/capabilities` returns an explicit
  `gaps` array listing every unavailable capability, which is the opposite of
  silent faking. *(Superseded: when `web_search` and `x_search` were added they
  were not in that union, so the claim was false for exactly those two. They are
  now reported in a `tools` object beside `capabilities`, and `gaps` remains the
  `Capability` union — see the Review round section.)*
- **`hostedTools` is false** — no vendor-hosted tool surface is claimed.

## Verified

Follow-up task A2 closed the three vendor gaps the earlier run left open. One
commit per gap, on `feat/byok-latest`:

| Commit | Change |
| --- | --- |
| `2e278b3` | feat(byok): route x_search through the configured endpoint |
| `2541db7` | feat(byok): add the local web_search tool |
| (this commit) | docs: make the BYOK contract match the code |

### What was executed

`npm run typecheck` (root, both workspaces) after each gap: clean, no output
beyond the `tsc -p tsconfig.json --noEmit` banners. Nothing was stashed: no
pre-existing typecheck failure appeared.

Tests were run directly with `node --import tsx --test` — the repo wires no test
script (`package.json` has `dev`/`build`/`start`/`typecheck`/`setup`/`doctor`
only; `tests/e2e.mjs` is a Playwright smoke test that needs a live server, a real
Hermes gateway and a real desktop, so it is not part of this check).

```
$ node --import tsx --test server/test/providers.test.mjs server/test/desktop.test.mjs \
    server/test/x-search.test.mjs server/test/web-search.test.mjs
ℹ tests 23   ℹ pass 23   ℹ fail 0
```

New cases:

- `server/test/x-search.test.mjs` (4/4): hidden without `LLM_X_SEARCH`, listed
  with it, the request goes to `{LLM_BASE_URL}/responses` with
  `Bearer LLM_API_KEY` and `LLM_MODEL`, and a call with the flag unset answers a
  capability error without touching the endpoint (a stub server records zero
  requests).
- `server/test/web-search.test.mjs` (5/5): hidden without `SEARCH_BASE_URL`,
  listed with it, `POST {SEARCH_BASE_URL}/search` carries `Bearer SEARCH_API_KEY`
  and returns `title / url / snippet`, no key means no `Authorization` header,
  and a 429 surfaces as an error instead of an uncaught throw.

Each case runs in its own process (`server/test/_tools-probe.mjs`), because
`env.ts` resolves once per process, exactly as at boot.

### `availableTools()` on a BYOK-only endpoint

Probed with the same BYOK-only env as §2 above plus `DESKTOP_MODE=disabled`,
`LLM_PROTOCOL=chat`, and no `LLM_X_SEARCH` / `SEARCH_BASE_URL`:

```
remember, create_routine, list_event_triggers, create_event_routine, stay_silent,
set_checkins, list_routines, update_routine, delete_routine, create_task,
update_task, send_to_bot, create_group, post_to_group, ask_user,
request_app_connection
```

No `x_search`, no `web_search`, no `image_generate`, no computer/browser/shell
tools. `x_search` appears only with `LLM_X_SEARCH=1`; `web_search` only with
`SEARCH_BASE_URL` set.

### Still not exercised

- No live `x_search` or `web_search` call against a real endpoint: there is no
  endpoint in this environment that implements either. What is proven is the URL,
  the header, the response parsing and the refusal path, all against stubs.
- `server/src/agent/prompt.ts` names `x_search` in the system prompt
  unconditionally, so a BYOK bot is told about a tool its MCP list does not
  offer. *(Fixed in the review round: the line is now filtered on
  `xSearchConfigured()`, and a `web_search` line appears only when
  `webSearchConfigured()` is true. `functionSchemas()` already rebuilt the tool
  list per turn, so nothing was cached by leaving it unconditional.)*


## Review round

An adversarial review of `0f63f4b`, `2e278b3`, `2541db7` found six defects and
three hardenings. One commit per fix, on `feat/byok-latest`. Re-run at `3792ec7`
(`npm run typecheck`: clean; both search suites green).

| Commit | Fix | Proof |
| --- | --- | --- |
| `3c85e18` | docs: stop publishing a usable session secret | §2 now shows `SESSION_SECRET=$(openssl rand -hex 32)`; the old literal appears nowhere in the working tree (searched the tree for its first 17 characters, excluding `.git` and `node_modules`: no matches), and the working `.env` was regenerated |
| `ba86c0a` | fix(byok): one definition of a configured model endpoint | `llmConfigured()` lives in `env.ts`; `providers/llm.ts` re-exports it and `agent/tools.ts` derives `xSearchConfigured`/`webSearchConfigured` from `xSearchAvailable`/`searchConfigured`. 9 cases in `server/test/llm-capability.test.mjs` |
| `67d6f02` | fix(byok): stop reporting a healthy engine that is not there | `/api/health` returns `engine` from `capabilityReport().engine` (`hermes`/`byok`/`unconfigured`) and HTTP 503 when `ok` is false; `?probe=1` is the opt-in reachability check, Hermes only. Same test file, engine-name case |
| `cf2fb78` | fix(byok): report search tools in the capability contract | `/api/capabilities` carries `tools: { web_search, x_search }`; `gaps` stays the `Capability` union. Same test file, contract case |
| `1660c62` | fix(byok): only advertise tools that exist | `agent/prompt.ts` builds the search lines from `xSearchConfigured()`/`webSearchConfigured()`. Same test file, prompt case (a bare BYOK prompt names neither; a full one names both) |
| `2dea3c9` | fix(byok): accept the result shapes real search endpoints return | `parseResults` reads `results`, `organic_results`, `organic`, `items`, `web.results`, `data` and a bare array. Two new cases in `web-search.test.mjs` with Serper-shaped and CSE-shaped bodies |
| `3792ec7` | fix(byok): harden the search tools | `webSearch` refuses bodies over 2 MB (before parsing, `content-length` and streamed bytes both checked); `xSearch` sends `allowed_x_handles` **and** `excluded_x_handles`; both throw `CapabilityError` so the model reads a gap with `configure[]`. Three new cases across the two suites |

### Totals

```
$ npm run typecheck
> tsc -p tsconfig.json --noEmit    (both workspaces, exit 0)

$ node server/test/x-search.test.mjs
ℹ tests 5    ℹ pass 5    ℹ fail 0

$ node server/test/web-search.test.mjs
ℹ tests 9    ℹ pass 9    ℹ fail 0
```

Full server suite for this round: `providers`, `desktop`, `x-search`,
`web-search`, `llm-capability` → **37 tests, 37 pass, 0 fail**.

### Honest decisions recorded here

- **Model-only is not "configured".** `LLM_MODEL` alone used to report
  `capabilities.llm: true` and then fail every turn. It is now false. An
  OAuth-style provider (model, no key, no base) is counted only through the
  Hermes branch, because that credential lives in Hermes' own auth store and this
  process cannot see it from its env.
- **`x_search` requires the `responses` protocol.** The tool is a hosted
  `/responses` feature; the verified BYOK env sets `LLM_PROTOCOL=chat`, where the
  endpoint does not exist. It also requires `LLM_MODEL`, which it posts.
- **`/api/health` makes no network call by default.** Probing a BYOK endpoint
  would be a billable model request on every uptime poll, so the default answer
  is configuration truth, and `?probe=1` (Hermes only) is the opt-in.
- **`gaps` did not grow.** Extending the `Capability` union would have dragged
  two non-UI entries into every web-client gate; a sibling `tools` object is the
  smaller honest change, and the old claim in §Findings is corrected above.
- **The prompt was not cached.** The comment in `agent/prompt.ts` warns about the
  cached part of the prompt; `functionSchemas()` already rebuilt per turn, so
  filtering the two search lines costs nothing.

### `availableTools()` after the round (BYOK-only + `SEARCH_BASE_URL`)

Probed with `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` set, `LLM_PROTOCOL=chat`, no
`LLM_X_SEARCH`, no `HERMES_URL`/`HQ_LOCAL`, `DESKTOP_MODE=disabled`, and
`SEARCH_BASE_URL` set:

```
remember, web_search, create_routine, list_event_triggers, create_event_routine,
stay_silent, set_checkins, list_routines, update_routine, delete_routine,
create_task, update_task, send_to_bot, create_group, post_to_group, ask_user,
request_app_connection
```

`web_search` is present because the endpoint is; `x_search` is absent because the
protocol is `chat`, which has no `/responses` — the two facts now come from the
same predicates in `env.ts`.

### Still not exercised

- No live call to a real Serper/CSE endpoint, or a real hosted `x_search`: both
  are proven against stubs that return those vendors' shapes.
- No live reachability probe of a Hermes engine: `?probe=1` is implemented and
  reviewed but no Hermes gateway runs in this environment.

## Blocked / not executed

- **LLM inference not exercised.** Only configuration was verified; no chat
  completion was sent because there is no server at `http://127.0.0.1:20128/v1`
  in this environment (`LLM_API_KEY` is a placeholder by design). So "LLM
  configured" is proven, "LLM reachable" is not.
- **`npm ci` install scripts skipped.** `better-sqlite3` postinstall and `esbuild`
  postinstall were not run due to the npm `allowScripts` policy. `better-sqlite3`
  loaded fine via its prebuilt binding and `esbuild` had its prebuilt binary, so
  nothing was blocked in practice, but a source build was never attempted.
- **No frontend check.** The web workspace was not built or served; only the API
  on port 8787 was verified.
- **Desktop/Orgo/Composio/X integration paths were not exercised** — intentional,
  since the brief excludes their credentials.
