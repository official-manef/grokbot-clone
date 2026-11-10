# Manef port: BYOK providers + Docker blur

This fork replaces the three vendor dependencies of upstream Grokbot with
owner-supplied endpoints. Upstream assumes one vendor per capability and fails
at boot when a key is absent; this fork boots with whatever is configured and
reports the rest as capability gaps at the point of use.

## 1. Capability contract

Every optional integration is declared in `server/src/capabilities.ts` and
reported by `GET /api/capabilities`. Nothing calls `req()` for a key that a
missing value can degrade gracefully.

| Capability | Env | Fallback when unset |
| --- | --- | --- |
| `llm` | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | boots, `/api/health` reports `degraded` |
| `image` | `IMAGE_BASE_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL` | `image_generate` tool hidden from the model and from `/api/capabilities` |
| `tts` | `TTS_BASE_URL`, `TTS_API_KEY`, `TTS_MODEL` | voice preview route returns `501 capability_unavailable` |
| `stt` | `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL` | dictation route returns `501 capability_unavailable` |
| `realtime` | `REALTIME_BASE_URL`, `REALTIME_API_KEY`, `REALTIME_MODEL` | call start returns `501 capability_unavailable`; UI marks calls unavailable |
| `desktop` | `DESKTOP_BASE_URL`, `DESKTOP_TOKEN` | computer tools return `501 capability_unavailable` |
| `integrations` | `COMPOSIO_API_KEY` | app catalog and connections disabled; bot runs without meta-tools |
| `signin` | derived from `integrations` | dev login only (`DEV_LOGIN=1`) |

`XAI_*` and `ORGO_*` remain accepted as aliases for one release so existing
`.env` files keep working; the alias resolution lives in one place and logs the
preferred name once at boot.

## 2. Provider adapters

`server/src/providers/` holds one module per capability. Each exports
`available(): boolean` and the operation the app needs. The agent loop, memory
compaction, and voice import the adapter, never a hardcoded base URL.

- `llm.ts` — OpenAI-compatible Responses API. Also exports a chat-completions
  path for endpoints that reject `/v1/responses`, selected by
  `LLM_PROTOCOL=responses|chat`.
- `image.ts` — `POST /images/generations`.
- `speech.ts` — TTS (`/audio/speech`) and STT (`/audio/transcriptions`).
- `realtime.ts` — client-secret mint plus websocket URL. When unavailable the
  call route returns a capability error instead of throwing a 500.
- `integrations.ts` — Composio wrapper with a no-op implementation.

Hardcoded vendor hosts that must go: `api.x.ai` in `agent/loop.ts`,
`agent/memory.ts`, `voice.ts` (4 sites).

Hosted tools need a decision per endpoint: `web_search` and `x_search` are
vendor-hosted and are dropped from the tool list when
`LLM_HOSTED_TOOLS=0` (default for non-vendor endpoints), replaced by a
`web_search` function tool only if `SEARCH_BASE_URL` is set. Upstream sends
both unconditionally.

## 3. Docker blur (replacement for Orgo)

`server/src/desktop.ts` implements the same interface `orgo.ts` exposed, backed
by the local Docker daemon. Per user, one container:

- base image `grokbot-desktop` (built from `server/desktop/Dockerfile`):
  Debian slim + Xvfb + xdotool + x11vnc + websockify + chromium, non-root user.
- screens = separate displays `:99`, `:100`, `:101`, `:102`, not Orgo screens.
- `bash` = `docker exec`, confined to the container.
- `screenshot` = `xwd` piped to `convert`, or ffmpeg x11grab.
- `click/type/key/scroll/drag` = `xdotool` inside the container display.
- viewer = `x11vnc` + `websockify` per screen, relayed by the existing
  `vnc.ts` code. The RFB handshake code is vendor-neutral already; only the
  upstream dial changes.
- lifecycle maps to container states: `create`/`start`/`stop`/`rm`.

The Docker socket is the trust boundary. `desktop.ts` never accepts a caller
path or command that escapes `docker exec` into the host, and the container is
created with no host mounts, `--memory`, `--cpus`, and `--pids-limit`.

## 4. MSO desktop API

MSO's `/api/v1/exec/run` is a host shell with the owner's full authority, so it
is not the execution surface for bots. MSO gains a read-only observer role:

- `GET /api/v1/desktop/containers` — list blur containers and their state.
- `GET /api/v1/desktop/screenshot?bot=` — current screen as PNG.
- `POST /api/v1/desktop/lifecycle` — start/stop/restart, calling only the
  allowlisted docker verbs, never a caller-supplied command string.

`mso desktop status|screenshot|start|stop` wraps those. This is the "sub agent
builds the missing MSO feature" track and lands in `~/mso`, separate PR.

## 5. Error handling

One shape everywhere, so the UI never renders a 500 for an unconfigured
integration:

```json
{ "error": "capability_unavailable", "capability": "image", "message": "Image generation is not configured." }
```

- `server/src/lib/capability-error.ts` builds it; a Hono `onError` maps
  `CapabilityError` to 501 and unknown errors to 500 with a request id.
- The web app resolves `/api/capabilities` once and hides the affordances it
  cannot offer rather than failing a click.

## 6. Stages

1. env + capabilities + error shape (boots with no keys)
2. provider adapters, agent loop and memory repointed
3. image/TTS/STT/realtime adapters and their routes
4. desktop.ts + Dockerfile + vnc repoint
5. MSO desktop API (separate repo)
6. web capability gating
7. end-to-end: dev login, bot turn, computer task, library file

Each stage ends with `npm run typecheck` green and a commit on the fork.
