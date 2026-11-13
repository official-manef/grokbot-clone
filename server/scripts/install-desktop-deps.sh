#!/usr/bin/env bash
# Provision the desktop binaries the MSO computer backend needs.
#
# Why not `apt-get install`? This runs under the app's own user, which has no root.
# Every package below is pure userland, so downloading the .deb and extracting it into
# ./vendor is enough — no dpkg database, no system paths touched. The already-installed
# X server, ffmpeg, dbus and a Chromium build are reused as-is.
#
# Re-running is cheap: anything already extracted is left alone unless FORCE=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
CACHE="$VENDOR/.debs"
mkdir -p "$CACHE" "$VENDOR/bin" "$VENDOR/lib"

# name:arch — xdotool gives us pointer/keyboard control, x11vnc the RFB endpoint.
PACKAGES=(
  "xdotool"
  "libxdo3"
  "x11vnc"
  "libvncserver1"
  "libvncclient1"
  "fluxbox"
)

missing=0
for p in "${PACKAGES[@]}"; do
  if ! ls "$CACHE"/${p}_*.deb >/dev/null 2>&1; then
    echo "[deps] downloading $p"
    (cd "$CACHE" && apt-get download "$p" >/dev/null 2>&1) || {
      echo "[deps] could not download $p — run 'apt-get update' or place the .deb in $CACHE" >&2
      missing=1
    }
  fi
done
[ "$missing" = 0 ] || exit 1

if [ "${FORCE:-0}" = 1 ] || [ ! -x "$VENDOR/bin/xdotool" ] || [ ! -x "$VENDOR/bin/x11vnc" ]; then
  echo "[deps] extracting packages into $VENDOR"
  for f in "$CACHE"/*.deb; do
    dpkg -x "$f" "$VENDOR"
  done
fi

# dpkg -x writes into the package's own tree (usr/bin, usr/lib/...). Link the two entry
# points somewhere stable so callers never have to know that layout.
for b in xdotool x11vnc fluxbox startfluxbox; do
  if [ -e "$VENDOR/usr/bin/$b" ] && [ ! -e "$VENDOR/bin/$b" ]; then
    ln -sf "../usr/bin/$b" "$VENDOR/bin/$b"
  fi
done

LIBDIR="$(dirname "$(find "$VENDOR/usr/lib" -name 'libxdo.so.3' -print -quit 2>/dev/null || true)")"
if [ -n "$LIBDIR" ] && [ ! -e "$VENDOR/lib/x86_64-linux-gnu" ]; then
  ln -sfn "../${LIBDIR#"$VENDOR"/}" "$VENDOR/lib/x86_64-linux-gnu"
fi

if [ ! -x "$VENDOR/bin/xdotool" ]; then
  echo "[deps] xdotool missing after extraction" >&2
  exit 1
fi

# Verify with the loader path the app actually uses. Without LD_LIBRARY_PATH the
# vendored x11vnc reports "libvncserver.so.1: cannot open shared object file", and
# printing that as "ready" would hide a broken install behind a success line.
LIBPATH="$VENDOR/usr/lib/x86_64-linux-gnu"
if ! LD_LIBRARY_PATH="$LIBPATH" "$VENDOR/bin/x11vnc" -version >/dev/null 2>&1; then
  echo "[deps] x11vnc cannot load its vendored libraries from $LIBPATH" >&2
  exit 1
fi
if ! LD_LIBRARY_PATH="$LIBPATH" "$VENDOR/bin/xdotool" --version >/dev/null 2>&1; then
  echo "[deps] xdotool cannot load its vendored libraries from $LIBPATH" >&2
  exit 1
fi
echo "[deps] ready: $(LD_LIBRARY_PATH="$LIBPATH" "$VENDOR/bin/x11vnc" -version 2>&1 | head -1)"
