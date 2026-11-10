# MSO computer backend

Grokbot's original design put every user's Bots on an **Orgo** cloud VM: one VM per user,
one X display ("screen") per Bot, driven over Orgo's HTTP API, with a websockified VNC
stream for watching. This deployment replaces that with the machine the server already
runs on, driven by **MSO** (Manef Shell OS).

Nothing above the backend noticed: the agent loop, tools, approvals, idle watcher and VNC
relay all import a single `runtime` module. `COMPUTER_BACKEND` chooses the implementation.

```
agent/tools.ts ─┐
computer.ts   ─┼─► runtime.ts ─┬─► desktop.ts  (COMPUTER_BACKEND=mso, default)
vnc.ts        ─┤               └─► orgo.ts     (COMPUTER_BACKEND=orgo)
idle.ts       ─┘
```

## What changed and why

| Concern | Orgo | This host |
| --- | --- | --- |
| The "box" | one cloud VM per user | a directory per user under `MSO_DESKTOP_ROOT` |
| A "screen" | extra X display on that VM, max 4 | a local `Xvfb` display (`:99`, `:91`, …) plus its own `x11vnc` |
| Screenshot | Orgo `GET /screenshot` | `ffmpeg -f x11grab`, one JPEG frame |
| Click/type/key/scroll | Orgo JSON API | `xdotool` against that display |
| Shell | `POST /bash` inside the VM | a real `bash -lc` on this host, cwd = the box directory |
| Watch live | Orgo websockify over WSS | loopback `x11vnc`, proxied by the app's own RFB relay |
| Wake/suspend | VM state machine | start/stop the display's processes; files and profiles persist |
| Cost when idle | VM hours | nothing beyond a stopped process |

The VNC port is bound to `127.0.0.1` and is deliberately **passwordless**: the browser has
already authenticated to this server, and the relay performs the RFB handshake on its own.
No credential that grants shell access ever reaches a client — which is stricter than the
Orgo arrangement, where the VM's VNC password was root-equivalent and was passed to the
relay from the API.

## Isolation, stated plainly

Orgo gave each Bot **root inside a disposable VM**. This host gives each Bot:

* its own X display and therefore its own window input target,
* its own directory (`~/.grokbot/desktops/bots/<botId>/`) for profile, files and scratch,
* shell access **as the account running the service**.

That last line is the tradeoff. A Bot that runs a destructive shell command can damage this
host, not just itself. This matches how MSO itself works (authenticated shell execution is
full host power for that user) and is the reason `COMPUTER_BACKEND=orgo` is still
supported: if you need a real blast-radius boundary, keep using a VM backend.

Recommended host-level mitigations, in order of value:

1. Run the service as a dedicated user with no sudo rights.
2. Keep `MSO_DESKTOP_ROOT` outside that user's home if home contains anything sensitive.
3. Do not put provider keys in an environment the Bot's shell inherits. (The service reads
   `.env` for its own use; the shell it spawns inherits the service environment, so treat
   that as reachable.)
4. If you expose this to untrusted users, use `COMPUTER_BACKEND=orgo` instead.

## Binaries

`Xvfb`, `ffmpeg`, `dbus` and a Chromium build must exist. `xdotool`, `x11vnc` and
`fluxbox` are vendored so no root is needed:

```bash
./server/scripts/install-desktop-deps.sh
```

It downloads the three `.deb` files, extracts them into `server/vendor/`, and links the
entry points. `desktop.ts` puts `server/vendor/usr/lib/x86_64-linux-gnu` on `LD_LIBRARY_PATH`
for every child it launches — without that, the vendored `xdotool` fails with
`libxdo.so.3: cannot open shared object file`, which looks exactly like a broken desktop.

The browser is resolved at runtime: `GROKBOT_BROWSER`, then Playwright's downloaded
Chromium, then the usual system paths. No browser means the `open_browser` tool reports it
instead of silently doing nothing.

## Screen lifecycle

* `default` is `:99` and always exists.
* `screen-N` is `:9N` (so `screen-1` is `:91`) and is created on demand.
* Screens are leased per Bot, least-recently-used beyond four, exactly as before.
* `suspend` stops the display and VNC processes. Directories and browser profiles survive,
  so a Bot keeps its logins across a hibernation cycle.

Display startup self-heals. If a display number is held by an orphaned X server whose lock
file was removed, `reclaimDisplay()` finds it in `/proc` — matching only a process whose
command line names *that* display — and kills it before binding. Without this, one crashed
run poisons the display number until the host reboots.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPUTER_BACKEND` | `mso` | `mso` or `orgo` |
| `MSO_DESKTOP_ROOT` | `~/.grokbot/desktops` | where boxes, profiles and libraries live |
| `MSO_GEOMETRY` | `1280x800x24` | display size |
| `MSO_VNC_PORT_BASE` | `5900` | one port per display: `:99`→5909, `:91`→5901 (offset `num-90`) |
| `MSO_BASE_URL` | `http://127.0.0.1:4005` | MSO API base |
| `MSO_CLI` | (empty) | absolute path to the MSO CLI |

## Verifying it

```bash
# desktop primitives, no server needed
cd server && npx tsx --env-file=../.env -e '
import * as d from "./src/desktop.js";
const s = await d.screenshot("t", "default");
console.log(s.width, s.height);
process.exit(0);'
```

Or run the checked-in self-check, which asserts the mapping rules that are easy to get
wrong (display ↔ screen id ↔ VNC port) and, when a display is available, that a real
screenshot and click succeed:

```bash
cd server && npx tsx --env-file=../.env ./test/desktop.check.ts
```

Full-stack checks used for this deployment:

1. `POST /api/computer/ensure` → status `running`.
2. Ask a Bot to open a page and screenshot it → the transcript shows `open_browser`
   followed by an answer that matches the page.
3. Fetch `/api/bots/<id>/screenshot` and look at the image.
4. Run an RFB handshake through `/api/bots/<id>/screen` and read ServerInit.
