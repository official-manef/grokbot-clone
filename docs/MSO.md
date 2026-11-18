# MSO computer backend

`DESKTOP_MODE=mso` runs each bot's desktop on **this host** instead of in a container:
one directory per user, one Xvfb display per bot screen. It exists for hosts where a
Docker daemon is unavailable or unreachable — that is the only reason to choose it.

Read this before switching a deployment away from the default.

## What picks the backend

`server/src/box.ts` dispatches on `DESKTOP_MODE` (see `server/src/env.ts`):

| `DESKTOP_MODE` | Backend | Isolation |
| --- | --- | --- |
| `docker` (default) | `server/src/desktop.ts` → `box/adapters/docker.ts` | One container per user; unprivileged `bot` user, `cap-drop=ALL`, own network |
| `mso` | `server/src/mso.ts` | Host Xvfb displays; commands run as the service account |
| `orgo` | `server/src/orgo.ts` | A rented remote VM |
| `disabled` | none | No screen tools at all |

`HQ_LOCAL=1` with `DESKTOP_MODE` unset selects `mso`, because that combination means
"the app runs on the computer it manages".

## Isolation, stated plainly

The Docker backend is the safe one. `mso` is weaker in a way that matters: `bash()`
runs `bash -lc` as the **service account**, which is the same power the app itself has.
A bot that is talked into a destructive command can reach anything that user can read
or write.

Use `mso` when you cannot run a daemon, and treat every bot on that host as trusted.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKTOP_MODE` | `docker` | `docker`, `mso`, `orgo` or `disabled` |
| `MSO_DESKTOP_ROOT` | `~/.grokbot/desktops` | Where boxes, browser profiles and libraries live |
| `MSO_VNC_PORT_BASE` | `5900` | First VNC port. `:99` is `base+0`, `:9N` is `base+N` |
| `DESKTOP_RESOLUTION` | `1280x800x24` | Display size for both Docker and mso boxes |
| `GROKBOT_BROWSER` | discovered | Explicit browser path; otherwise Playwright, then `PATH` |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker only |
| `DESKTOP_IMAGE` | `grokbot-desktop:latest` | Docker only |
| `DESKTOP_RAM_GB` | `8` | Docker only |
| `DESKTOP_CPU` | `2` | Docker only |

The MSO CLI (`MSO_BASE_URL`, `MSO_CLI`) is **not** read by this backend. It was part of
the earlier `COMPUTER_BACKEND=mso` design; `mso.ts` now owns its displays directly.

## Screen lifecycle

- `MAX_SCREENS` (`server/src/box/contract.ts`) is 4: the primary is display `:99`, the
  rest are `:1`, `:2`, `:3`.
- A bot leases a screen through `screenFor` in `server/src/computer.ts`; with per-user
  boxes each user gets their own four.
- Capture is one `ffmpeg` x11grab JPEG frame; input is `xdotool` against that display.
- Watching dials a loopback `x11vnc` over raw RFB; the app's relay does the
  authentication, so no VNC password is stored.

## Binaries

`Xvfb`, `ffmpeg` and a Chromium build must be on the host. `xdotool`, `x11vnc` and
`fluxbox` are vendored by `server/scripts/install-desktop-deps.sh` (extracted `.deb`,
no root), because a service account usually cannot `apt install`.

## Verifying it

```bash
node bin/gb doctor     # reports which backend answered, and what is missing
```

For the Docker backend there is a real-container check that no stub can replace:

```bash
docker build -t grokbot-desktop:latest server/desktop
npx tsx server/verify-desktop.mts
```
