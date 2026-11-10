#!/bin/bash
# Boot every display this box was asked for, then stay in the foreground.
#
# GROKBOT_SCREENS=4 means :99 plus :1 :2 :3. Each display gets its own Xvfb, its
# own window manager, and its own websockify on 6080+offset so the host can
# publish them independently.
set -u

SCREENS="${GROKBOT_SCREENS:-4}"
RESOLUTION="${GROKBOT_RESOLUTION:-1280x800x24}"

display_for() { # 0 -> :99, n -> :n
  local i="$1"
  if [ "$i" -eq 0 ]; then echo ":99"; else echo ":$i"; fi
}

vnc_port_for() { # 0 -> 6080, n -> 6080+n
  echo $((6080 + $1))
}

echo "[entrypoint] screens=$SCREENS resolution=$RESOLUTION"

# A container restart reuses /tmp, so a lock left by the previous run makes Xvfb
# refuse to start ("Server is already active for display 99"). The box then read
# that as a dead display and shut itself down on every wake. Clear the stale
# locks, which is safe because nothing else can be running this early.
rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null || true

X_PIDS=()

for i in $(seq 0 $((SCREENS - 1))); do
  d="$(display_for "$i")"
  num="${d#:}"
  Xvfb "$d" -screen 0 "$RESOLUTION" -nolisten tcp -ac >"/tmp/xvfb-$num.log" 2>&1 &
  # Only the X servers are waited on. `wait -n` over every job would return as
  # soon as a one-shot helper (xsetroot) finished, which looked like a crash.
  X_PIDS+=("$!")

  # Wait for the display before starting anything that needs it.
  for _ in $(seq 1 50); do
    xdpyinfo -display "$d" >/dev/null 2>&1 && break
    sleep 0.1
  done

  DISPLAY="$d" xfwm4 --compositor=off >"/tmp/xfwm-$num.log" 2>&1 &
  DISPLAY="$d" xsetroot -solid '#111214' 2>/dev/null || true

  # No password: the viewer is only reachable through the host's relay, which
  # authenticates the user and holds the socket. Loopback bind, never 0.0.0.0.
  x11vnc -display "$d" -rfbport $((5900 + i)) -localhost -forever -shared -nopw -quiet \
    >"/tmp/x11vnc-$num.log" 2>&1 &

  for _ in $(seq 1 50); do
    (echo >/dev/tcp/127.0.0.1/$((5900 + i))) 2>/dev/null && break
    sleep 0.1
  done

  # No --web: the app ships its own RFB client, so websockify is a pure proxy.
  websockify 0.0.0.0:"$(vnc_port_for "$i")" "127.0.0.1:$((5900 + i))" \
    >"/tmp/websockify-$num.log" 2>&1 &
done

echo "[entrypoint] displays up: 0..$((SCREENS - 1))"
# tini is PID 1; stay alive exactly as long as the X servers do. A dead display
# means the box is useless, so the container exits and the host restarts it.
wait -n "${X_PIDS[@]}"
status=$?
echo "[entrypoint] an X server exited ($status); shutting the box down"
kill 0
