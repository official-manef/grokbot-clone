# gb — the command line

`gb` sets up and drives this app from a shell. The wizard is the point: a fresh
clone needs five decisions, and none of them should require opening a `.env`
file.

```bash
gb init        # guided setup
gb doctor      # verify every capability
gb dev         # run it
```

Nothing prints a secret. `.env` is written `0600`, and every prompt that takes a
key hides it.

---

## Install

`gb` ships in the repo and needs no install step:

```bash
git clone git@github.com:official-manef/grokbot-clone.git
cd grokbot-clone
npm ci
node bin/gb init
```

Optional, to get `gb` on your `PATH`:

```bash
npm link          # from the repo root, links bin/gb as `gb`
# or
ln -s "$PWD/bin/gb" ~/.local/bin/gb
```

Requirements: Node 22+. Docker is needed only for `DESKTOP_MODE=docker`, and the
`hermes` CLI is needed only when bots actually run.

---

## `gb init`

Five steps. `-y` takes every default with no questions, which is what a script
or a CI job wants.

### 1. Model endpoint

Seven choices, ordered by what costs nothing. Two are genuinely free, and the
list is taken from Hermes' own provider registry (`hermes_cli/auth.py`).

| Choice | Cost | What it writes |
| --- | --- | --- |
| **OpenRouter** | **free** — ten `:free` models | `LLM_PROVIDER=openai` + `OPENROUTER_API_KEY` |
| **Nous Portal** | **free tier** via `hermes auth add nous` | `LLM_PROVIDER=nous`, `LLM_MODEL=nous/welcome`, no key |
| OpenAI API | paid | `LLM_PROVIDER=openai` + `OPENAI_API_KEY` |
| Anthropic Claude | paid | `LLM_PROVIDER=anthropic`, so the agent gets `ANTHROPIC_*` |
| A gateway or router | your key | custom base URL, `LLM_PROVIDER=openai` |
| A local model server | free | `http://127.0.0.1:1234/v1`, key usually blank |
| Skip | — | an existing Hermes agent already has a model |

The two free paths, in full:

**OpenRouter.** Get a key at `openrouter.ai/keys` (no card). The wizard then
offers the ten `:free` SKUs by number:

```
  free models on this provider:
    1. z-ai/glm-5.2:free
    2. minimax/minimax-m3:free
    3. nvidia/nemotron-3-ultra-550b-a55b:free
    …
? Pick a number, or type a model id [1]
```

**Nous Portal.** No key at all. The wizard writes `LLM_PROVIDER=nous` and
`LLM_MODEL=nous/welcome`, then tells you the one step it cannot do for you:

```
✓ model nous/welcome
One step is yours: run hermes auth add nous once.
  The free tier is pinned to nous/welcome; other models need a paid plan.
```

Hermes holds that credential, not this `.env` — which is why `gb doctor` checks
the provider name instead of looking for a key.

It asks for the base URL, then the key (hidden), then **asks the endpoint which
models it serves** and offers them. After that it sends **one real request** and
reports what came back:

```
✓ 12 models available
    · cx/gpt-6.1-sol
    · ag/gemini-3.8-flash-high
    … and 4 more
✓ the endpoint answered: OK
```

If the endpoint refuses, the reason is printed (`invalid x-api-key`, `401`, a
model name it does not know) and the value is still saved, so `gb doctor` can
re-check later instead of making you start over.

### 2. Where the bots work

| Choice | Meaning |
| --- | --- |
| Docker container per user | isolated; nothing of the host is mounted |
| A shared computer (Orgo / `HQ_LOCAL`) | one screen per bot, as bot-hq does |
| No computer | chat only, no screenshots or shell |

For Docker it checks the daemon and the image, and offers to build
`server/desktop` if the image is missing.

### 3. Sign-in

`DEV_LOGIN=1` gives a local email form for testing. Answering no asks for
`COMPOSIO_API_KEY` instead, because otherwise there is no way in.

### 4. Optional

Image generation and speech each need their own endpoint. Leaving them blank is
a supported state: the app hides the feature rather than failing a click.

### 5. Write

Writes `.env` (`0600`), generates `SESSION_SECRET` if it is missing, and prints
the next three commands.

---

## `gb doctor`

Runs the checks that actually matter, in order, and names what blocks a turn.

```
✓ node          v26.7.0 (needs >=22)
✓ dependencies  run npm ci
✓ model         cx/gpt-6.1-sol answered
✓ computer      grokbot-desktop:latest ready
✓ hermes        CLI on PATH
✓ signin        local email form enabled
✓ image         configured
– speech        hidden, no TTS_*/STT_* endpoint
– apps          hidden, no COMPOSIO_API_KEY
✓ port          8787 is free
```

Two properties worth keeping:

- **`model` sends a real completion.** `/models` answering does not mean the key
  works, so the check is one actual request with the configured model.
- **`–` is not a failure.** A capability that is switched off is a gap, not a
  broken button. Only `✗` blocks, and the exit code is non-zero only then.

`--json` gives the same information as data:

```json
{ "results": [ { "name": "model", "state": "ok", "detail": "cx/gpt-6.1-sol answered" } ] }
```

---

## Other verbs

| Command | Does |
| --- | --- |
| `gb dev [server\|web]` | start the dev server(s) |
| `gb login [email]` | sign in through the local form |
| `gb bots` | list bots and whether they are working |
| `gb capabilities` | what the running server can actually do |
| `gb logs <bot>` | tail a bot's Hermes gateway log |

`gb logs` is the first place to look when a bot does not answer: the gateway
prints its dependency install and any model error there, and the app's own log
stays quiet.

---

## Environment

| Variable | Effect |
| --- | --- |
| `NO_COLOR=1` | no ANSI codes, for logs |
| `-y`, `--yes` | every default, no prompts |

`gb` reads the same `.env` the server does, so there is one source of truth.
