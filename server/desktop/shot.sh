#!/bin/bash
# Screenshot one display and write a PNG to stdout.
#
# ImageMagick's `import` needs a display and is the simplest reliable path. The
# display is validated by the caller (desktop.ts) before it reaches this script;
# this script also refuses anything that is not a bare :NN itself, so a mistake
# upstream cannot become an argument injection.
set -eu

D="${1:-:99}"
case "$D" in
  :[0-9]|:[0-9][0-9]|:[0-9][0-9][0-9]) ;;
  *) echo "refusing display arg: $D" >&2; exit 2 ;;
esac

# -window root = whole screen. `png:-` streams to stdout, no temp file.
exec import -display "$D" -window root png:-
