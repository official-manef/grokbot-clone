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

Four choices, because "give me an API key and a URL" is not enough — the
protocol differs:

| Choice | What it writes |
| --- | --- |
| OpenAI or any OpenAI-compatible endpoint | `LLM_PROVIDER=openai` |
| Anthropic Claude | `LLM_PROVIDER=anthropic`, so the agent gets `ANTHROPIC_*` not `OPENAI_*` |
| A gateway or router | same as OpenAI, for a URL in front of many models |
| Skip | an existing Hermes agent already has a model |

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
