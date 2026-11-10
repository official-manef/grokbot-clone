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

for i in $(seq 0 $((SCREENS - 1))); do
  d="$(display_for "$i")"
  num="${d#:}"
  Xvfb "$d" -screen 0 "$RESOLUTION" -nolisten tcp -ac >"/tmp/xvfb-$num.log" 2>&1 &

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

  websockify --web /usr/share/novnc 0.0.0.0:"$(vnc_port_for "$i")" "127.0.0.1:$((5900 + i))" \
    >"/tmp/websockify-$num.log" 2>&1 &
done

echo "[entrypoint] displays up: $(seq -s, 0 $((SCREENS - 1)) | sed 's/[0-9]\+/&/g')"
# tini is PID 1; keep the container alive as long as the X servers are.
wait -n
status=$?
echo "[entrypoint] a display process exited ($status); shutting the box down"
kill 0
