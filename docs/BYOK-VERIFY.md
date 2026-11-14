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
`ORGO_*`, `COMPOSIO_*`:

```
PORT=8787
APP_URL=http://localhost:5173
SERVER_URL=http://localhost:8787
SESSION_SECRET=byok-verify-local-only-0123456789abcdef
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

## Findings

- **No boot failure in the final run.** The only boot failure was the missing
  `server/dist` build artifact on a fresh checkout; after `npm run build -w server`
  the server started cleanly and stayed up. This is a packaging/wiring gap, not a
  BYOK configuration problem: the `start` script assumes a prior `build`.
- **LLM reports configured.** `capabilities.llm` is `true`, and `/api/health`
  echoes `ok:true` with the owner-supplied model
  `ollama-cloud-deepseek-v4.1-flash-1017` and `engine:"hermes"`. The BYOK endpoint
  is the only LLM source configured.
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
  silent faking.
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
- `server/src/agent/prompt.ts` still names `x_search` in the system prompt
  unconditionally, so a BYOK bot is told about a tool its MCP list does not
  offer. Harmless (the tool list is authoritative and a call would answer the
  capability error) but not yet filtered by `availableTools()`; fixing it means
  touching the prompt cache, which this task did not.


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
