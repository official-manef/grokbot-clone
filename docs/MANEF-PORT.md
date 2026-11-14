# Manef port: BYOK providers + Docker blur

This fork replaces the three vendor dependencies of upstream Grokbot with
owner-supplied endpoints. Upstream assumes one vendor per capability and fails
at boot when a key is absent; this fork boots with whatever is configured and
reports the rest as capability gaps at the point of use.

## 1. Capability contract

Every optional integration is resolved once in `server/src/env.ts` and reported
by `GET /api/capabilities` (`server/src/lib/capabilities.ts`). A missing value is
a reported gap, never a boot failure.

| Capability | Env | Fallback when unset |
| --- | --- | --- |
| `llm` | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | boots; counts as on only for a complete base+key pair, or when a Hermes engine is configured (`HERMES_URL` or `HQ_LOCAL=1`). A model name alone is not an endpoint. `/api/health` reports `engine: "unconfigured"` and HTTP 503 in that case |
| `image` | `IMAGE_BASE_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL` | `image_generate` dropped by `availableTools()`, so it is absent from the MCP tool list; `/api/capabilities` reports `capabilities.image: false` |
| `tts` | `TTS_BASE_URL`, `TTS_API_KEY`, `TTS_MODEL` | voice preview route returns `501 capability_unavailable` |
| `stt` | `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL` | dictation route returns `501 capability_unavailable` |
| `realtime` | `REALTIME_BASE_URL`, `REALTIME_API_KEY`, `REALTIME_MODEL` | `POST /api/voice/session` returns `501 capability_unavailable`; UI marks calls unavailable |
| `desktop` | `DESKTOP_MODE` (`docker` default, `mso`, `orgo`, `disabled`); `orgo` also needs `ORGO_API_KEY` | `disabled`, or `orgo` without `ORGO_API_KEY`, reports `capabilities.desktop: false`. `disabled` also makes `availableTools()` drop the computer, browser, shell and `save_file` tools |
| `integrations` | `COMPOSIO_API_KEY` | app catalog and connections answer `501`; the bot runs without the user's Composio tools |
| `signin` | derived from `COMPOSIO_API_KEY` | without it, only the dev login (`DEV_LOGIN=1`, default `0`) gets anyone in |

`XAI_BASE_URL`, `XAI_API_KEY` and `XAI_MODEL` are still accepted in place of the
`LLM_*` names, and `LLM_*` wins when both are set. The alias resolution lives in
`env.ts`; it logs `[env] legacy names in use` for the base URL and model aliases.
`ORGO_*` is not an alias: those variables belong to `DESKTOP_MODE=orgo` only.

`SESSION_SECRET` keys the owner sign-in link and the bearer token each agent uses
on `/mcp/<bot>`. Left unset, `env.ts` generates a random per-process secret and
warns, so owner links and agent MCP tokens do not survive a restart.

## 2. Provider adapters

`server/src/providers/` holds three modules, one per family of capability:

- `llm.ts` — an OpenAI client on `LLM_BASE_URL` (`llm()`), plus helpers for
  endpoints that reject `/v1/responses`: `chatStream`, `toChatMessages`,
  `toChatTools`, `chatAsResponseEvents`, selected by
  `LLM_PROTOCOL=responses|chat`. Today `voice.ts` is its only importer (it uses
  `llm().responses.create` to summarise a call); the chat helpers and
  `stripHosted` are exported but nothing in the app calls them yet.
- `image.ts` — `POST /images/generations`, used by the `image_generate` tool.
- `speech.ts` — TTS (`/audio/speech`), STT (`/audio/transcriptions`) and the
  realtime client-secret mint (`/realtime/client_secrets` plus a websocket URL).
  Each is its own capability and its own `*Configured()` check; `voice.ts`
  answers `501 capability_unavailable` for whichever is unset. A realtime 404
  from the gateway reaches the UI as a gap, not a 500.

Realtime has no module of its own: it lives in `speech.ts`. Composio is not an
adapter under `providers/` either; it is `server/src/composio.ts`, which builds its
client lazily and throws `CapabilityError('integrations')` when
`COMPOSIO_API_KEY` is unset.

The agent loop is Hermes' (`agent/loop.ts` posts to the bot's gateway), so the
model endpoint reaches the bots through `engine.ts`, not through `providers/llm.ts`:
a managed engine's `config.yaml` gets `api_mode: chat_completions` or `responses`
from `LLM_PROTOCOL`, and the engine's own OpenAI-style (or Anthropic) credentials from
`LLM_BASE_URL`/`LLM_API_KEY`.

No vendor host is hardcoded any more. `x_search` (`agent/tools.ts`) posts to
`{LLM_BASE_URL}/responses` with `LLM_API_KEY`/`LLM_MODEL`, and
`availableTools()` lists it only when the endpoint can actually serve it:
`LLM_X_SEARCH=1`, a complete base+key pair, `LLM_MODEL`, and
`LLM_PROTOCOL=responses`. The flag is opt-in because the hosted `x_search` tool is
a feature of the vendor's Responses API, not of every OpenAI-compatible gateway;
the protocol check exists because a `chat` gateway has no `/responses` at all.
Called when it is not offered, the tool answers a capability error
(`capability_unavailable`, `configure: [...]`) instead of fetching anything.

`LLM_HOSTED_TOOLS` is read in `env.ts`. It is echoed by `/api/capabilities` and
consulted by `providers/llm.ts` (`responsesBody`), but nothing calls that function.
`web_search` is now a real local tool: `POST {SEARCH_BASE_URL}/search` with
`{ query, max_results }` and a `Bearer SEARCH_API_KEY`, returning a compact cited
list (title, url, snippet). It is listed by `availableTools()` only when
`SEARCH_BASE_URL` is set, and answers a capability error naming
`SEARCH_BASE_URL`/`SEARCH_API_KEY` when called unset. Its parser reads the shapes
real endpoints return (`results`, `organic_results`/`organic`, `items`,
`web.results`, `data`, a bare array), and refuses a response body over 2 MB
before parsing it. Both search tools are reported in `/api/capabilities` under
`tools` (`web_search`, `x_search`), beside the `capabilities` map.

## 3. Docker blur (replacement for Orgo)

`server/src/box.ts` is the one dispatch point; `DESKTOP_MODE` picks the backend.
`docker` and `mso` are the local backends; in `orgo` mode the screen, input and
shell calls go to `orgo.ts`, while `create`, `readFile` and `exportFile` are
local-only and throw `CapabilityError('desktop')`:

| `DESKTOP_MODE` | Module | Box | Isolation |
| --- | --- | --- | --- |
| `docker` (default) | `server/src/desktop.ts` | one container per user | own network, `--cap-drop ALL`, no host mounts, shell as unprivileged `bot` |
| `mso` | `server/src/mso.ts` | one directory per user, host Xvfb displays | weaker: shell runs as the service account (see the `mso` section in §7) |
| `orgo` | `server/src/orgo.ts` | the shared Orgo computer (`ORGO_COMPUTER_ID`) | bots share one machine; rollback path |
| `disabled` | none | none | computer, browser and shell tools are not offered |

`desktop.ts` implements the same interface `orgo.ts` exposed, backed
by the local Docker daemon. Per user, one container:

- base image `grokbot-desktop` (built from `server/desktop/Dockerfile`):
  Debian slim + Xvfb + xdotool + x11vnc + websockify + chromium, non-root user.
- screens = separate displays `:99`, `:1`, `:2`, `:3`, not Orgo screens.
- `bash` = `docker exec`, confined to the container.
- `screenshot` = `grokbot-shot` (`server/desktop/shot.sh`), which runs ImageMagick `import` and refuses anything that is not a bare `:NN` display.
- `click/type/key/scroll/drag` = `xdotool` inside the container display.
- viewer = `x11vnc` + `websockify` per screen, relayed by the existing
  `vnc.ts` code. The RFB handshake code is vendor-neutral already; only the
  upstream dial changes.
- lifecycle maps to container states: `create`/`start`/`stop`/`rm`.

The Docker socket is the trust boundary. `desktop.ts` never accepts a caller
path or command that escapes `docker exec` into the host. The container is
created with no host mounts, `--memory`, `--cpus`, `--pids-limit`, `--shm-size`,
`--security-opt no-new-privileges` and `--cap-drop ALL` (no `SYS_ADMIN`). Each box
gets its own bridge network created with `enable_icc=false`, so a bot cannot dial
the websockify of a neighbouring box.

Tenancy is per user: the container is named from the user id, screen leases are
looked up by `user_id` (`computer.ts`), and the bot limit (`MAX_BOTS`) counts a
user's own agents (`agentCount` in `routes.ts`).

## 4. MSO desktop API

MSO's `/api/v1/exec/run` is a host shell with the owner's full authority, so it
is not the execution surface for bots. MSO gains a read-only observer role:

- `GET /api/v1/desktop/containers` — list blur containers and their state.
- `GET /api/v1/desktop/screenshot?bot=` — current screen as PNG.
- `POST /api/v1/desktop/lifecycle` — start/stop/restart, calling only the
  allowlisted docker verbs, never a caller-supplied command string.

`mso desktop status|screenshot|start|stop` wraps those. This is the "sub agent
builds the missing MSO feature" track. It lives in the MSO repo (`app/api/v1/desktop/`, commit `836c7463` on its `main`), not in this
tree; nothing here calls it.

## 5. Error handling

One shape everywhere, so the UI never renders a 500 for an unconfigured
integration:

```json
{ "error": "capability_unavailable", "capability": "image", "message": "Image generation is not configured.", "configure": ["IMAGE_BASE_URL", "IMAGE_API_KEY", "IMAGE_MODEL"] }
```

- `server/src/lib/capability-error.ts` builds it; `lib/error-handler.ts` is the Hono
  `onError` that maps `CapabilityError` to 501 and unknown errors to 500 with a
  request id.
- The web app resolves `/api/capabilities` once (`web/src/lib/capabilities.ts`) and
  hides the affordances it cannot offer rather than failing a click.

## 6. Stages

1. env + capabilities + error shape (boots with no keys)
2. provider adapters, agent loop and memory repointed
3. image/TTS/STT/realtime adapters and their routes
4. desktop.ts + Dockerfile + vnc repoint
5. MSO desktop API (separate repo)
6. web capability gating
7. end-to-end: dev login, bot turn, computer task, library file

Each stage ends with `npm run typecheck` green and a commit on the fork.

Stage 2's "agent loop and memory repointed" describes the tree before the Hermes
engine (`011649d`): the agent loop is now Hermes', and memory is `engine-memory.ts`.
Stage 5 lives in the MSO repo.

## 7. Verification log

Run on 2026-11-10 on the development host, against commit `56fb4ff`. Not a plan — what
was actually executed. **Everything in this section is historical**: it was true at
`56fb4ff` and has not been re-run against the current tree, except where an entry says
otherwise. The agent loop is now Hermes' (`agent/loop.ts` posts to a gateway), so the
"agent loop" entries below no longer describe it. (§2 of the 2026-11-10
version listed two adapter modules beyond the three in `server/src/providers/`; they exist in no commit of this
repo.)

Re-run at HEAD on 2026-11-14: `npx tsx --test server/test/providers.test.mjs` (8/8 pass)
and `npm run typecheck` (clean). The tool-layer tests added with `x_search` and
`web_search` (`server/test/x-search.test.mjs`, `server/test/web-search.test.mjs`)
also pass; totals are in `docs/BYOK-VERIFY.md` under "Verified". Nothing else
below was repeated.

**Boot with no keys** (at `56fb4ff`). `.env` copied from `.env.example`, every value blank.
`GET /api/health` → `200 {"ok":true}` (the body now also carries `engine` and `model`), and the log names the gaps:
*Corrected by the review round: that body was a false green. `ok` is now readiness
and answers HTTP 503 while no backend is configured; `engine` names the real one
(`hermes` / `byok` / `unconfigured`), and `?probe=1` adds an opt-in reachability
check against a Hermes engine only.*

```
[env] capabilities off: llm, image, tts, stt, realtime, integrations, signin
[grokbot] server on http://localhost:8787 (model grok-4.7, desktop docker)   <- format at 56fb4ff; the current line is `[grokbot] server on http://localhost:<port>`
```

`GET /api/capabilities` → `desktop.ready: true, containers: 0`, `gaps` lists the seven.
Since then `llm` also counts as on when `HERMES_URL` or `HQ_LOCAL=1` is set, so a host with a
Hermes engine will not list it.

**Capability errors are 501, not 500** (at `56fb4ff`; the routes still exist in `voice.ts`). With `DEV_LOGIN=1` and a session cookie:

```
POST /api/voice/preview -> 501
{"error":"capability_unavailable","capability":"tts",
 "message":"Text to speech is not configured.",
 "configure":["TTS_BASE_URL","TTS_API_KEY","TTS_MODEL"]}

POST /api/voice/session -> 501
{"error":"capability_unavailable","capability":"realtime", ... }
```

**Agent loop against a real gateway** (at `56fb4ff`, before the Hermes engine; not repeated). `LLM_BASE_URL=https://router.antinrml.com/v1`,
`LLM_MODEL=cx/gpt-6.1-sol`, `LLM_PROTOCOL=responses`, `LLM_HOSTED_TOOLS=0`.
User turn `"Reply with exactly: PORT OK"` → assistant row `PORT OK`.

**Desktop: container lifecycle** (at `56fb4ff`; the container now also runs with `--cap-drop ALL` on its own network). Image built (1.36 GB), started with the same argv
`desktop.ts` uses. Four displays, four websockify ports:

```
[entrypoint] screens=4 resolution=1280x800x24
[entrypoint] displays up: 0..3
port 6080 OPEN   port 6081 OPEN   port 6082 OPEN   port 6083 OPEN
```

`screenshot :99` → valid PNG, `1280x800`. With a Chromium window open, the same call
returned 30,581 bytes instead of 296, so the capture has real content.

**Input and isolation, through the container boundary** (at `56fb4ff`).

| Probe | Result |
| --- | --- |
| `grokbot-shot ':99; id'` | `refusing display arg: :99; id` |
| `xdotool type -- '$(touch /tmp/PWNED)'` | `/tmp/PWNED` does not exist |
| `id -u` / `whoami` | `1000` / `bot` |
| `ls /mnt/c/...` | `No such file or directory` |
| `ls ~/.ssh`, `/var/run/docker.sock` | absent |

**End-to-end through the agent** (at `56fb4ff`). The bot was asked for a screenshot; it created its own
container (`grokbot-XXLZgARkO03T`, `Up`), called `computer_screenshot`, and answered
`The screen resolution is 1280 × 800 pixels.` Asked to run a shell command, it returned:

```
1000
bot
ls: cannot access '/mnt/c': No such file or directory
```

**Viewer** (at `56fb4ff`). A raw WebSocket to the box returns `RFB 003.008\n`, so `vnc.ts` can keep its
handshake code unchanged and only swap the upstream dial.

### DESKTOP_MODE=mso — desktops without a container runtime

`docker` is the default and the best isolation. `mso` exists for hosts where there is no
usable Docker daemon (no socket access, no daemon, or an operator who wants the desktop on
the host's own X server). It has the same surface and the same `box.ts` dispatch, so the
tools and the viewer do not change.

| Concern | `docker` | `mso` |
| --- | --- | --- |
| box | one container per user | one directory per user |
| screen | displays `:99`, `:1`, `:2`, `:3` inside the box | host `Xvfb` on `:99`, `:91`, `:92`, `:93` |
| capture | `grokbot-shot` in the image | `ffmpeg -f x11grab` |
| input | `xdotool` in the image | vendored `xdotool` |
| shell | as `bot` inside the box | as the service account on the host |
| viewer | container websockify | loopback `x11vnc`, dialled over TCP |

**The shell row is the tradeoff.** `mso` runs bot commands as the account running this
service, which is the same power MSO itself grants and strictly more than a container's
`bot` user. Use `docker` unless you cannot.

Two details that are easy to get wrong, and are therefore asserted in
`server/scripts/check-mso.ts`:

* `screen-1` is display `:91`, not `:1`. The off-by-one opens a browser on a display that
  nothing screenshots, and the tool then reports a black screen.
* The vendored binaries need `LD_LIBRARY_PATH=server/vendor/usr/lib/x86_64-linux-gnu`.
  Without it `xdotool` exits with `libxdo.so.3: cannot open shared object file`, which looks
  like a broken desktop rather than an environment mistake.

Displays self-heal: an Xvfb whose socket was unlinked still owns its display number, so
`reclaimDisplay()` finds it in `/proc` — matching only a command line that names *that*
display — and clears the lock before binding.

Vendoring needs no root:

```bash
./server/scripts/install-desktop-deps.sh   # xdotool, x11vnc, fluxbox -> server/vendor/
```

**Known limits (as of `af7f400`, the commit that added `mso.ts`).** The MSO desktop observer API
is in a separate repo, not here, and nothing in this tree calls it. `orgo.ts` remains compiled but untested since upstream; `DESKTOP_MODE=orgo` is
for rollback only. Four containers at 8 GB each is 32 GB of RAM, so `DESKTOP_RAM_GB` is the
first thing to lower on a small host.

**Both protocols verified** (at `56fb4ff`, against the old in-process loop). That loop is gone; today `LLM_PROTOCOL` reaches the bots as the `api_mode` in a managed engine's `config.yaml` (`engine.ts`). The agent loop was protocol-agnostic; `LLM_PROTOCOL` selects the
wire format and `providers/llm.ts` translates.

| Protocol | Model | Plain turn | Tool call |
| --- | --- | --- | --- |
| `responses` | `cx/gpt-6.1-sol` | `PORT OK` | screenshot → `1280 × 800` |
| `chat` | `ag/gemini-3.8-flash-high` | `CHAT OK` | screenshot → `1280x800` |

The chat path translates stored Responses items (message / function_call /
function_call_output) into chat messages and reshapes the upstream delta stream back into
`response.output_text.delta` + `response.completed`, so `agent/loop.ts` reads one vocabulary
regardless of provider.

**Library round trip** (at `56fb4ff`). The bot was asked to save a file; it did, and the API could see and serve it:

```
GET  /api/bots/<id>/files
{"status":"ok","path":"","files":[{"name":"notes.txt","size":18,"modifiedAt":...,"isDir":false}]}

POST /api/bots/<id>/files/download {"path":"notes.txt"}
200, text/plain; charset=utf-8, Content-Length: 18
hello from the box
```

Two bugs this caught: `save_file` wrote to `/home/bot/...` while the Library read
`/root/grokbot/files`, and the Docker `exportFile` returns bytes where the Orgo one returned a
signed URL. Both are fixed by one `boxGrokbot()` constant and a route that streams bytes.

**Provider adapters** (re-run at HEAD, 2026-11-14: 8/8 pass). The gateway has no image or TTS model, so `server/test/providers.test.mjs`
runs each adapter against a local mock in its own process (env resolves once per process, as at
boot). 8/8 pass: b64_json and `data:` parsing, provider error surfacing, a TTS round trip,
multipart STT, a realtime 404 treated as a gap, and secret minting.

**image_generate, end to end** (at `56fb4ff`). With `IMAGE_BASE_URL` pointed at a mock that returns a 64×64 PNG,
the bot was asked for a blue square:

```
[mock-image] POST /images/generations prompt="A simple solid blue square, ..."

GET /api/bots/<id>/files
{"files":[{"name":"blue-square.png","size":179,...}]}

downloaded: magic ok, 64x64, 179 bytes
```

The tool was hidden until the capability existed, then it appeared and worked. No code changed
to switch it on.

**Wake after suspend** (at `2c0143f`). Found by stopping a container the way `suspend` does and asking the API
to wake it. Before the fix the API answered `status: "running"` while Docker still said `exited`,
and the wake never happened: `ensureComputer` branched on the backend's raw status word
(`suspended`/`suspending`), which Docker spells `exited`. It now branches on `mapStatus()`, the
same mapping `waitRunning` uses, so both backends go down one path. `POST /computer/ensure` also
awaits the work instead of answering with the stale row — that staleness is what made the failure
look like success.

**Restart and viewer** (at `56fb4ff`). A container restart reuses `/tmp`, so Xvfb found a stale
`/tmp/.X99-lock` from the previous run, refused to start, and `wait -n` read that as a dead
display and shut the box down — every wake. The entrypoint now clears
`/tmp/.X*-lock` and `/tmp/.X11-unix/X*` before starting displays. Stop/start/stop/start all
survive, and a screenshot still returns a valid 1280×800 PNG afterwards.

The viewer path was then driven the way the browser drives it — a WebSocket to
`/api/bots/<id>/screen` with the session cookie:

```
relay: websocket open
relay: first frame "RFB 003.008\n"
OK: RFB handshake reached the browser through the relay
```

So `vnc.ts` needed only the upstream dial swapped: its RFB handshake code is vendor-neutral.
