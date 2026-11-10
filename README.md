# Grokbot — Manef fork

A fork of [nickvasilescu/grokbot-clone](https://github.com/nickvasilescu/grokbot-clone) that runs on
**your own endpoints** instead of three fixed vendors.

Upstream assumes one provider per capability and refuses to boot without all of them. This fork boots
with an empty `.env`, tells you what is missing, and hides the features it cannot offer rather than
answering a 500 when you click them.

## What changed

| Upstream | This fork |
| --- | --- |
| `XAI_API_KEY` required at boot | `LLM_*` (BYOK, any OpenAI-compatible endpoint) |
| Orgo cloud computer required | `DESKTOP_MODE=docker`: one local container per user |
| Composio required | optional; app connections and Google sign-in turn off cleanly |
| Voice only via xAI | TTS / STT / realtime are three independent BYOK capabilities |
| Missing key → crash | missing key → `501 capability_unavailable` naming the env vars |

`XAI_*` and `ORGO_*` are still read as aliases for one release, so an existing upstream `.env` keeps
working. See [`docs/MANEF-PORT.md`](docs/MANEF-PORT.md) for the contract.

## Quick start

Needs Node 22+ and, for bot desktops, Docker.

```bash
git clone git@github.com:official-manef/grokbot-clone.git
cd grokbot-clone
npm ci
cp .env.example .env
```

Set at least the model endpoint in `.env`:

```ini
LLM_BASE_URL=https://router.antinrml.com/v1
LLM_API_KEY=...
LLM_MODEL=cx/gpt-6.1-sol
```

Everything else is optional. Build the desktop image once if you want bots to have a computer:

```bash
docker build -t grokbot-desktop:latest server/desktop
```

Run the API and the web app:

```bash
npm run dev -w server     # http://localhost:8787
npm run dev -w web        # http://localhost:5173
```

Open the app, sign in with the email form (needs `DEV_LOGIN=1` in `.env`), and send a bot a message.

## What is missing and why it is visible

`GET /api/capabilities` is the single source of truth:

```json
{
  "capabilities": { "llm": true, "image": false, "desktop": true, "realtime": false },
  "gaps": ["image", "tts", "stt", "realtime", "integrations", "signin"]
}
```

The web app reads it once and renders accordingly. A gap is never a broken button.

## Provider notes

Endpoints differ more than their docs suggest. Two things are worth knowing:

- **Hosted tools.** `web_search` and `x_search` are vendor-side tools, not OpenAI API features. Most
  gateways reject them. `LLM_HOSTED_TOOLS=0` (the default) drops them from the request entirely.
- **Realtime voice.** A gateway either implements `/realtime` or it does not. Leaving `REALTIME_*`
  blank disables calls and keeps dictation working, which is the common case.

## Bot desktops

Each user gets one container with four X displays, built from
[`server/desktop/Dockerfile`](server/desktop/Dockerfile). There are **no host mounts**: the bot's
`shell` tool runs as an unprivileged user inside a throwaway box, so a prompt injection reaches the
container and nothing else.

| Operation | Inside the box |
| --- | --- |
| screenshot | `import -display :N -window root png:-` |
| click / type / key / scroll / drag | `xdotool` |
| shell | `sh -lc` as user `bot` |
| live viewer | `x11vnc` + `websockify`, relayed by the server |

MSO can observe these containers through its own `desktop` API (see `docs/MANEF-PORT.md` §4)
without ever holding execution authority over them.

## Development

```bash
npm run typecheck     # server + web
npm run build
```

## License

MIT, as upstream. Third-party artwork and trademarks remain their owners'; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
